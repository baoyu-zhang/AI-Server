/**
 * backup.js —— 整卷备份（第一阶段「能装」）
 *
 * ===========================================================================
 * 为什么从「只备数据库」改成「整卷备份」
 * ===========================================================================
 * 旧版只用 VACUUM INTO 导出 app.db 单文件。但 paths.js 把可写状态分散在好几处：
 *   app.db                 用户、会话、审计、用量、附件元数据   → 旧版备到了
 *   images/                聊天图片原件                        → 旧版没备
 *   uploads/session-files/ 文档附件切块与向量 JSON             → 旧版没备
 *   vector-index/          知识库向量索引                      → 旧版没备
 * 结果是「看起来有 7 份备份，真恢复一次聊天记录还在、图片全裂、知识库全空」，
 * 这比没有备份更危险——它给了人虚假的安全感。
 *
 * 现在每次备份产出**成对的两个文件**（同一个 stem，便于配对管理）：
 *   app-YYYYMMDD-HHMMSS-<tag>.db       纯数据库快照，保留给旧的恢复流程与快速体检
 *   app-YYYYMMDD-HHMMSS-<tag>.tar.gz   整卷快照 = 上面的 db + 三个数据目录
 * 对外交付、异地备份、恢复演练**一律用 .tar.gz**；.db 只作为兼容与排错用。
 *
 * ===========================================================================
 * 为什么用系统 tar，不引第三方库
 * ===========================================================================
 * 打包是交付链路的关键步骤，能少一个依赖就少一个「客户内网装不上」的理由。
 * GNU tar 与 macOS bsdtar 都支持 -czf / 多个 -C，容器内 bookworm-slim 也自带 tar。
 * 用 execFileSync（参数数组，不拼 shell 字符串）同时避免命令注入。
 *
 * ===========================================================================
 * 什么时候跑
 * ===========================================================================
 *   启动后 1 分钟一份（避开启动时加载模型的高峰）
 *   之后每 BACKUP_INTERVAL_HOURS 小时一份（默认 24）
 *   手动：npm run backup
 * 保留 BACKUP_KEEP 组（默认 7，按 stem 分组，.db 与 .tar.gz 算同一组）。
 * 打包失败只告警、不判整次备份失败：.db 仍是有效快照，但必须让运维看见。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const db = require('./db')
const { log } = require('./logger')

// 与 db.js 必须用同一个 DB_FILE：备份是 VACUUM INTO 这个文件，指错了会备到空库。
const { PATHS } = require('./paths')
const DB_FILE = PATHS.DB_FILE
const BACKUP_DIR = PATHS.BACKUP_DIR
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 7))
const INTERVAL_HOURS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24))
const DISABLED = process.env.BACKUP_DISABLED === '1'

/**
 * 整卷快照要带上的目录（相对 APP_DATA_DIR）。
 * 刻意**不**包含：
 *   backups/           → 备份自己的输出目录，打进去会递归膨胀
 *   logs/              → 可重建，且可能含敏感信息，不应随备份到处流转
 *   transformers-cache/ → embedding 模型缓存，几百 MB，离线镜像里已自带
 * 可用 BACKUP_INCLUDE_DIRS 覆盖（逗号分隔），例如只备数据库+图片时设成 images。
 */
const INCLUDE_DIRS = (process.env.BACKUP_INCLUDE_DIRS || 'images,uploads,vector-index')
  .split(',').map(s => s.trim()).filter(Boolean)

const pad = n => String(n).padStart(2, '0')

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 备份文件名统一格式：.db 与 .tar.gz 共用同一个 stem */
const BACKUP_NAME_RE = /^app-\d{8}-\d{6}(-\w+)?(-\d+)?\.(db|tar\.gz)$/
const stemOf = name => name.replace(/\.(db|tar\.gz)$/, '')

/**
 * 只留最近 KEEP **组**。
 * 为什么按组而不是按文件：一次备份现在产出两个文件，若按文件数清理，
 * KEEP=7 会变成「3.5 次备份」，还可能出现 .tar.gz 被删、.db 还留着的孤儿组合。
 */
function prune() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(name => BACKUP_NAME_RE.test(name))
    const stems = Array.from(new Set(files.map(stemOf))).sort().reverse()
    for (const stem of stems.slice(KEEP)) {
      for (const name of files.filter(n => stemOf(n) === stem)) {
        fs.unlinkSync(path.join(BACKUP_DIR, name))
        log.info('[backup] 清理旧备份', { file: name })
      }
    }
  } catch (err) {
    log.warn('[backup] 清理旧备份失败', { error: err?.message })
  }
}

/**
 * 把「数据库快照 + 三个数据目录」打成一个 .tar.gz。
 *
 * 归档内的结构刻意保持扁平、与 APP_DATA_DIR 下的相对路径一致：
 *   app-20261113-120000-auto.db   ← 数据库快照（文件名保留，便于人工识别时间点）
 *   images/...
 *   uploads/...
 *   vector-index/...
 * 恢复时解包到临时目录，直接按这些名字找库和拷目录，不需要额外的清单文件。
 *
 * 多个 -C 是 tar 的标准用法：每遇到一个 -C 就切换后续相对路径的基准目录。
 * @param {string} dbName 已生成的 .db 文件名（不含目录）
 * @returns {string} 归档绝对路径
 */
function packFullSnapshot(dbName) {
  const archiveFull = path.join(BACKUP_DIR, dbName.replace(/\.db$/, '.tar.gz'))
  // 第一个 -C 指向备份目录，把刚生成的 db 快照放进归档根目录
  const args = ['-czf', archiveFull, '-C', BACKUP_DIR, dbName]
  // 后续每个存在的目录再从 APP_DATA_DIR 切进去；目录不存在时跳过而不是让 tar 报错，
  // 全新部署还没上传过任何文件时 uploads/ 可能尚未创建。
  for (const dir of INCLUDE_DIRS) {
    const src = path.join(PATHS.DATA_DIR, dir)
    if (fs.existsSync(src)) args.push('-C', PATHS.DATA_DIR, dir)
  }
  execFileSync('tar', args, { stdio: 'pipe' })
  return archiveFull
}

/**
 * 立刻做一份备份。
 * @param {string} [tag] 文件名后缀，如 manual / auto / pre-migrate
 * @returns {{ok: boolean, file?: string, size?: number, archive?: string|null, archiveError?: string, error?: string}}
 *   file 始终是 .db 的绝对路径 —— restore.js 的「恢复前留底」直接拿它做回滚点，不能改语义。
 */
function backupNow(tag = 'auto') {
  if (DISABLED) return { ok: false, error: 'BACKUP_DISABLED=1，已跳过' }
  const res = vacuumInto(tag)
  if (res.ok) return res

  // ===== 自愈重试：disk I/O error 多半是 WAL 热状态 =====
  // 多个进程反复开关后 -wal/-shm 可能处于"需要 recovery"的状态，VACUUM INTO 读
  // 未合并的 WAL 页时会报 disk I/O error。先 checkpoint（把 WAL 合并回主文件）再试
  // 一次——实测能把这类失败救回来。仍失败才算真失败。
  log.warn('[backup] 首次备份失败，尝试 checkpoint 后重试', { error: res.error })
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch (err) {
    log.warn('[backup] checkpoint 失败', { error: err?.message })
  }
  return vacuumInto(tag)
}

/** 实际执行 VACUUM INTO + 整卷打包。备份失败只告警，绝不影响服务 */
function vacuumInto(tag) {
  let name = `app-${stamp()}-${tag}.db`
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    let full = path.join(BACKUP_DIR, name)
    let seq = 1
    // 同一秒内连做两次（手动 + 定时撞上）不能让 VACUUM INTO 报"目标已存在"
    while (fs.existsSync(full)) {
      name = `app-${stamp()}-${tag}-${seq++}.db`
      full = path.join(BACKUP_DIR, name)
    }
    // VACUUM INTO 的路径是 SQL 字符串字面量：单引号要翻倍转义
    db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`)
    const size = fs.statSync(full).size
    log.info('[backup] 已生成数据库快照', { file: name, sizeKB: Math.round(size / 1024) })

    // ===== 整卷打包（新增）=====
    // 单独 try：打包失败不能把已经成功的数据库快照判成失败，但必须留下 error 级日志，
    // 否则运维会以为「有 .tar.gz 就是好的」，直到真正恢复那天才发现只有半个卷。
    let archive = null
    let archiveError
    try {
      archive = packFullSnapshot(name)
      const archiveSize = fs.statSync(archive).size
      log.info('[backup] 已生成整卷快照', {
        file: path.basename(archive), sizeKB: Math.round(archiveSize / 1024), dirs: INCLUDE_DIRS.join('/')
      })
    } catch (err) {
      archiveError = err?.message || String(err)
      log.error('[backup] 整卷打包失败（数据库快照仍可用）', { error: archiveError })
    }

    prune()
    return { ok: true, file: full, size, archive, archiveError }
  } catch (err) {
    log.error('[backup] 备份失败', { error: err?.message })
    // 失败时清掉半成品文件：留着会误导恢复操作（恢复到一半的库比没备份更危险）
    try {
      const partial = path.join(BACKUP_DIR, name)
      if (fs.existsSync(partial)) fs.unlinkSync(partial)
      if (fs.existsSync(partial + '-journal')) fs.unlinkSync(partial + '-journal')
      const partialArchive = partial.replace(/\.db$/, '.tar.gz')
      if (fs.existsSync(partialArchive)) fs.unlinkSync(partialArchive)
    } catch { /* 清理失败不影响主流程 */ }
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * 列出已有备份（新→旧）。
 * type: 'full' = 整卷快照（推荐用于恢复）、'db' = 仅数据库快照（兼容旧流程）。
 */
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(name => BACKUP_NAME_RE.test(name))
      .sort()
      .reverse()
      .map(name => {
        const full = path.join(BACKUP_DIR, name)
        const st = fs.statSync(full)
        return {
          name,
          size: st.size,
          mtime: st.mtimeMs,
          type: name.endsWith('.tar.gz') ? 'full' : 'db'
        }
      })
  } catch {
    return []
  }
}

let timer = null
/** 启动定时备份：先等 1 分钟，之后每 INTERVAL_HOURS 小时一次 */
function startAutoBackup() {
  if (DISABLED) {
    log.warn('[backup] 自动备份已关闭（BACKUP_DISABLED=1）')
    return
  }
  const run = () => {
    backupNow('auto')
    timer = setTimeout(run, INTERVAL_HOURS * 3600 * 1000)
    timer.unref() // 别让定时器拖住进程退出
  }
  const first = setTimeout(run, 60 * 1000)
  first.unref()
  log.info('[backup] 自动备份已启用', { dir: BACKUP_DIR, keep: KEEP, intervalHours: INTERVAL_HOURS, includeDirs: INCLUDE_DIRS.join('/') })
}

// 直接 node backup.js 运行时：立刻备份一份并打印结果
if (require.main === module) {
  const res = backupNow('manual')
  if (res.ok) {
    console.log(`数据库快照：${res.file}（${(res.size / 1024).toFixed(0)} KB）`)
    if (res.archive) console.log(`整卷快照（恢复请用这个）：${res.archive}`)
    else console.error(`警告：整卷打包失败 —— ${res.archiveError}`)
  } else {
    console.log(`备份失败：${res.error}`)
  }
  process.exit(res.ok ? 0 : 1)
}

module.exports = { backupNow, listBackups, startAutoBackup, BACKUP_DIR, INCLUDE_DIRS }
