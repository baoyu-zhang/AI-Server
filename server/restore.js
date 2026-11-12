/**
 * restore.js —— 数据库备份恢复（P1 运维闭环）
 *
 * ===== 为什么需要「恢复」而不只是「备份」 =====
 * backup.js 已经能定时把 WAL 模式的库导成一致的单文件快照（VACUUM INTO），但备份
 * 只有在「真能还原回去」时才有意义。此前恢复靠命令清单 §5.1 里的人工四步
 * （停服务 → cp 覆盖 → 删 -wal/-shm → 重启），全靠人记；其中「删 WAL」漏了就等于
 * 没恢复——旧 -wal 里比备份更新的事务会被 SQLite 重放进新库。本模块把这套步骤
 * 固化成一条命令，并补上两道保险：动库前先留底、动库后先验尸。
 *
 * ===== 三条安全底线 =====
 * 1. 文件名白名单：只认 backup.js 产出的 app-YYYYMMDD-HHMMSS[-tag][-序号].db。
 *    恢复接口会把文件名拼进备份目录去读文件，若放任 ../../ 之类就能读（甚至覆盖）
 *    任意文件——典型路径穿越，必须用正则 + 显式拒绝 .. / 分隔符双保险。
 * 2. 目标闸门：默认绝不覆盖正式库。想覆盖正式库必须显式 force:true；不带 force 时
 *    恢复到系统临时目录下的临时库，走完整流程做「演练」，碰都不碰正式数据。
 * 3. 先留底、后验尸、失败回滚：覆盖前用 backupNow('pre-restore') 把当前正式库另存
 *    一份；覆盖后用 node:sqlite 跑 integrity_check 并确认 users/threads 在；任一
 *    不通过就把 pre-restore 那份还原回去，绝不留一个坏库在服务里。
 *
 * ===== 一个必须知道的坑（node:sqlite）=====
 * new DatabaseSync(path) 打开不存在的文件会「顺手创建一个空库」，而空库也能让
 * integrity_check 返回 ok 且不报错——拿它当校验会把坏路径误判成有效备份。所以所有
 * 校验都先 fs.existsSync + size>0 挡一道，再用 readOnly:true 打开，绝不写目标文件。
 *
 * ===== 使用方式（CLI） =====
 *   node restore.js --list                       列出可恢复备份
 *   node restore.js --verify <file>              只读体检一个备份（恢复演练）
 *   node restore.js --restore <file>             恢复到临时库（演练，不动正式库）
 *   node restore.js --restore <file> --force     覆盖正式库（用完必须重启服务）
 * 也可经 scripts/db.mjs 的 restore / verify-backup 子命令间接调用本模块。
 *
 * ===== 运行前提（重要，给接线的人看）=====
 * 恢复正式库必须在「服务已停止」的独立进程里执行：本模块 require('./backup') 会连带
 * 通过 db.js 打开一个到正式库的连接，覆盖正式库前会把它 close 掉。若在服务进程内
 * 调用 restoreBackup，等于把服务的数据库连接关了。因此 index.js 不接本模块，只走 CLI。
 */
const fs = require('node:fs')                 // 文件存在性、大小、复制/删除/改名，全部同步做：恢复是离线运维动作，串行最清楚
const path = require('node:path')             // 拼路径 + path.resolve 比较「目标是不是正式库」
const os = require('node:os')                 // 演练用的临时库放系统临时目录，避免落到项目数据卷里
const { DatabaseSync } = require('node:sqlite') // Node 22 内置 SQLite：只读打开备份/目标做 integrity_check
const { PATHS } = require('./paths')          // 备份目录与正式库路径的唯一来源，绝不自己拼字符串
const backup = require('./backup')            // 复用 backupNow（留底）与 listBackups（列可恢复备份）
const db = require('./db')                    // 与 backup.js 共享同一个 DatabaseSync 实例；覆盖正式库前要 close 它
const { log } = require('./logger')           // 结构化日志：留底、恢复、回滚都留一行，便于事后排查

const BACKUP_DIR = PATHS.BACKUP_DIR           // 备份文件所在目录；白名单保证 fileName 永远是纯文件名，拼进去不会逃逸
const DB_FILE = PATHS.DB_FILE                 // 正式库（WAL 模式单文件），覆盖它必须 force:true
// 白名单：app-8位日期-6位时间(-字母数字下划线 tag)(-数字序号).db
// 头尾 ^$ 锚定，整体只允许字母/数字/下划线/连字符和一个 .db 后缀；
// 因此 ..、/、\、空格、绝对路径都不可能通过，天然挡住任意文件读/写。
const SAFE_NAME = /^app-\d{8}-\d{6}(-\w+)?(-\d+)?\.db$/
const KEY_TABLES = ['users', 'threads']       // 判定「这确实是我们的业务库」的最小集合：没这两张表就是拿错文件了

/**
 * 严格校验备份文件名，返回原文件名；不合法直接抛错（由调用方转成 {ok:false} 或 CLI 输出）。
 * 正则已经能挡住路径字符，这里再显式检查一遍：安全校验宁可重复，也不留「正则写漏」的单点。
 */
function assertSafeName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('缺少备份文件名')
  }
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || path.basename(fileName) !== fileName) {
    throw new Error('备份文件名非法：不允许 .. 或路径分隔符')
  }
  if (!SAFE_NAME.test(fileName)) {
    throw new Error('备份文件名不符合白名单 app-YYYYMMDD-HHMMSS[-tag][-n].db')
  }
  return fileName
}

/** 把白名单文件名拼成备份目录里的绝对路径；只有经过 assertSafeName 的名字才能传进来 */
function backupPath(fileName) {
  return path.join(BACKUP_DIR, fileName)
}

/**
 * 只读体检一个 .db 文件：能打开 + integrity_check=ok + 关键表齐全。
 * 被 verifyBackup（体检备份）、恢复后校验目标、回滚后校验三处复用，避免三份重复代码。
 * @param {string} fullPath 绝对路径（备份文件 / 目标库 / 回滚后的正式库）
 * @returns {{ok:boolean, integrity?:string, tables?:string[], missing?:string[], size?:number, error?:string}}
 */
function inspectDb(fullPath) {
  // 坑：DatabaseSync 打开不存在的文件会创建空库。先确认文件在、且不是 0 字节半成品，
  // 否则「空库 integrity ok」会把一次失败的恢复误判成成功。
  if (!fs.existsSync(fullPath)) return { ok: false, error: '文件不存在' }
  const size = fs.statSync(fullPath).size
  if (size <= 0) return { ok: false, error: '文件为空（size=0）' }

  let conn = null
  try {
    // readOnly:true 保证体检过程绝不改动被检查的文件（备份尤其不能被动到）
    conn = new DatabaseSync(fullPath, { readOnly: true })
    // integrity_check 返回一行，列名就是 integrity_check；兜底取第一个值兼容不同 Node 小版本
    const row = conn.prepare('PRAGMA integrity_check').get()
    const integrity = row?.integrity_check ?? Object.values(row || {})[0]
    if (integrity !== 'ok') {
      return { ok: false, integrity, error: `integrity_check 未通过：${integrity}` }
    }
    // sqlite_master 是 SQLite 的系统表，列出所有用户表；确认关键表都在才算「业务库完好」
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    const missing = KEY_TABLES.filter(t => !tables.includes(t))
    if (missing.length) {
      return { ok: false, tables, missing, error: `缺少关键表：${missing.join('、')}` }
    }
    return { ok: true, integrity, tables, size }
  } catch (err) {
    // 打不开（不是合法 SQLite 文件、权限不足……）也算校验失败，不能让异常冒出去
    return { ok: false, error: err?.message || String(err) }
  } finally {
    // 每个独立连接用完必关：不关会留着 fd，进程退不掉、文件也删不干净
    if (conn) { try { conn.close() } catch { /* 关闭失败不影响已经算出的结论 */ } }
  }
}

/**
 * 只读校验某个备份是否「可用于恢复」，不写任何文件，供恢复演练用。
 * @param {string} fileName 备份文件名（不含目录）
 * @returns {{ok:boolean, integrity?:string, tables?:string[], missing?:string[], size?:number, error?:string}}
 */
function verifyBackup(fileName) {
  let safe
  try {
    safe = assertSafeName(fileName)          // 演练同样走白名单：不能借 --verify 读任意文件
  } catch (err) {
    return { ok: false, error: err.message }
  }
  return inspectDb(backupPath(safe))         // 纯只读：打开 → integrity_check → 查表 → 关闭
}

/**
 * 列出可恢复的备份。
 * 复用 backup.listBackups()（它按文件名倒序、已过滤成备份命名），再滤掉 size<=0 的
 * 半成品：backup.js 失败时会清理半成品，但防御性过滤能挡住「手工拷了一半」的文件。
 * @returns {Array<{name:string, size:number, mtime:number}>}
 */
function listRestorable() {
  return backup.listBackups().filter(item => item.size > 0)
}

/**
 * 用 srcFull 原子替换 targetFull（覆盖目标库）。
 * ① 先删 WAL/SHM：WAL 模式的库光换主文件不够，旧 -wal 里「比备份更新」的事务会被
 *    重放进新库，恢复等于没做（命令清单 §5.1 踩过这个坑）。
 * ② 先复制到同目录临时文件再 rename：rename 是原子替换，已打开的旧 fd 仍指向旧 inode，
 *    不会出现「文件被截断写一半」的中间态被别的连接读到。
 */
function replaceWith(targetFull, srcFull) {
  fs.mkdirSync(path.dirname(targetFull), { recursive: true })  // 目标目录不存在就建（演练落在 /tmp，正式库目录 db.js 已建）
  fs.rmSync(targetFull + '-wal', { force: true })             // force:true：文件不存在也不报错
  fs.rmSync(targetFull + '-shm', { force: true })
  const tmp = `${targetFull}.restore-tmp-${process.pid}`      // 同目录临时文件，保证 rename 在同一文件系统内
  try {
    fs.copyFileSync(srcFull, tmp)                             // 先把备份完整拷成临时文件
    fs.renameSync(tmp, targetFull)                            // 再原子改名覆盖目标
  } finally {
    fs.rmSync(tmp, { force: true })                           // 无论成败都清掉临时文件，不留垃圾
  }
}

/**
 * 从备份恢复数据库。
 * @param {string} fileName 备份文件名（不含目录，必须符合白名单）
 * @param {object} [options]
 * @param {string} [options.target] 目标库路径；不给 = 正式库。给临时/测试库路径 = 恢复演练
 * @param {boolean} [options.force] 是否允许覆盖正式库（默认 false）
 * @returns {{ok:boolean, error?:string, target?:string, official?:boolean, preRestoreFile?:string, rolledBack?:boolean, rollbackOk?:boolean}}
 */
function restoreBackup(fileName, options = {}) {
  const { target, force = false } = options

  // ① 白名单：这一关过不了，后面连备份目录都不会去拼
  let safe
  try {
    safe = assertSafeName(fileName)
  } catch (err) {
    return { ok: false, error: err.message }
  }
  const backupFull = backupPath(safe)

  // ② 目标闸门：path.resolve 统一成绝对路径再比，避免 ./、软链写法绕过判断
  const resolvedTarget = path.resolve(target || DB_FILE)
  const isOfficial = resolvedTarget === path.resolve(DB_FILE)
  if (isOfficial && force !== true) {
    return { ok: false, error: '目标是正式库，必须显式传 force:true；或指定临时/测试库 target 做恢复演练' }
  }
  if (!isOfficial && !/\.db$/i.test(resolvedTarget)) {
    // 演练目标也得是个 .db 文件：防止手滑把备份内容覆盖到任意非库文件上
    return { ok: false, error: '临时/测试库 target 必须是 .db 文件路径' }
  }

  // ③ 先只读体检备份本身：坏备份绝不往任何目标上覆盖，避免「把坏库换上去再回滚」的折腾
  const pre = verifyBackup(safe)
  if (!pre.ok) return { ok: false, error: `备份不可用：${pre.error}` }

  // ④ 动库前留底：把「当前正式库」另存一份 pre-restore-时间戳。
  //    用 backupNow('pre-restore') 走的是 VACUUM INTO，拿到的是当前正式库的一致快照，
  //    这就是万一覆盖失败要还原回去的那一份。留底失败就没有回滚点，必须中止。
  const snap = backup.backupNow('pre-restore')
  if (!snap.ok) return { ok: false, error: `恢复前自动备份失败，已中止：${snap.error}` }
  const preRestoreFile = snap.file                       // backupNow 返回的是绝对路径，回滚时直接用，不再走白名单查找
  log.warn('[restore] 恢复前已留底', { file: path.basename(preRestoreFile), target: resolvedTarget })

  // ⑤ 覆盖目标库
  //    覆盖正式库前，先关掉本进程通过 db.js 打开的那个连接：它是 WAL 模式，连着的时候
  //    删 -wal / 改主文件会有竞态。本模块只在独立 CLI 进程里跑，关掉它不影响任何服务。
  if (isOfficial) {
    try { db.close() } catch (err) { log.warn('[restore] 关闭本进程数据库连接失败', { error: err?.message }) }
  }
  replaceWith(resolvedTarget, backupFull)                // 删旧 WAL/SHM + 原子替换成备份内容

  // ⑥ 覆盖后验尸：用独立只读连接确认新目标库 integrity ok 且关键表在
  const after = inspectDb(resolvedTarget)
  if (after.ok) {
    log.warn('[restore] 恢复完成并通过完整性校验', {
      file: safe, target: resolvedTarget, official: isOfficial, tables: KEY_TABLES.join('/')
    })
    return {
      ok: true,
      target: resolvedTarget,
      official: isOfficial,       // true 表示动的是正式库，调用方据此提示「请重启服务」
      preRestoreFile              // 把留底路径交出去，人工想再回滚也有据可查
    }
  }

  // ⑦ 验尸没过 → 回滚，绝不留一个坏库
  if (isOfficial) {
    // 正式库：把第 ④ 步那份 pre-restore 还原回去（同样走原子替换 + 清 WAL），再体检一次
    replaceWith(resolvedTarget, preRestoreFile)
    const rolled = inspectDb(resolvedTarget)
    log.error('[restore] 恢复后校验未通过，已回滚正式库', { file: safe, error: after.error, rollbackOk: rolled.ok })
    return {
      ok: false,
      error: `恢复后校验未通过，已回滚：${after.error}`,
      target: resolvedTarget,
      official: true,
      preRestoreFile,
      rolledBack: true,
      rollbackOk: rolled.ok     // false 表示连回滚都失败，需人工拿 preRestoreFile 处理
    }
  }
  // 演练目标是临时库：正式库从头到尾没被动过，直接删掉这个坏掉的临时文件即可
  fs.rmSync(resolvedTarget, { force: true })
  fs.rmSync(resolvedTarget + '-wal', { force: true })
  fs.rmSync(resolvedTarget + '-shm', { force: true })
  log.warn('[restore] 演练恢复后校验未通过，已清理临时库（正式库未改动）', { file: safe, error: after.error })
  return {
    ok: false,
    error: `恢复后校验未通过（演练），已清理临时库：${after.error}`,
    target: resolvedTarget,
    official: false,
    rolledBack: true
  }
}

// ===== CLI：只有「直接 node restore.js」时才执行，被 require 时保持安静 =====
if (require.main === module) {
  const argv = process.argv.slice(2)
  const sub = argv[0]                  // 子命令：--list / --verify / --restore
  const file = argv[1]                 // 备份文件名（--verify / --restore 需要）
  const force = argv.includes('--force') // 是否允许覆盖正式库
  let code = 0                         // 退出码：0 成功 / 1 失败，供脚本判断

  if (sub === '--list') {
    const list = listRestorable()
    if (!list.length) {
      console.log('（没有可恢复的备份）')
    } else {
      for (const item of list) {
        const time = new Date(item.mtime).toLocaleString('zh-CN')      // 毫秒时间戳转本地可读时间
        console.log(`${item.name}\t${(item.size / 1024).toFixed(0)} KB\t${time}`)
      }
    }
  } else if (sub === '--verify') {
    if (!file) {
      console.error('用法：node restore.js --verify <备份文件名>')
      code = 1
    } else {
      const res = verifyBackup(file)
      if (res.ok) {
        console.log(`校验通过：${file}（integrity_check=${res.integrity}，关键表 ${KEY_TABLES.join('/')} 齐全，${(res.size / 1024).toFixed(0)} KB）`)
      } else {
        console.error(`校验失败：${file} —— ${res.error}`)
        code = 1
      }
    }
  } else if (sub === '--restore') {
    if (!file) {
      console.error('用法：node restore.js --restore <备份文件名> [--force]')
      code = 1
    } else {
      // 不带 --force：目标给系统临时目录下的临时库，完整走一遍流程做演练，正式库分毫不动；
      // 带 --force：目标就是正式库，覆盖成功后必须重启服务（旧连接已被本进程关闭）。
      const target = force ? DB_FILE : path.join(os.tmpdir(), `restore-drill-${Date.now()}.db`)
      const res = restoreBackup(file, { target, force })
      if (res.ok) {
        console.log(`恢复成功：${file} → ${res.target}${res.official ? '（正式库，请重启服务）' : '（临时库演练，正式库未改动）'}`)
        console.log(`恢复前留底：${path.basename(res.preRestoreFile)}`)
        if (!res.official) console.log(`演练临时库保留在：${res.target}（可手动删除）`)
      } else {
        console.error(`恢复失败：${res.error}`)
        code = 1
      }
    }
  } else {
    console.log('用法：node restore.js --list | --verify <file> | --restore <file> [--force]')
    code = 1
  }

  process.exit(code)                 // 显式退出：把 0/1 交给上层脚本（verify-all.sh / db.mjs）
}

module.exports = { listRestorable, restoreBackup, verifyBackup }
