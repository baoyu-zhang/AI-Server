/**
 * backup.js —— SQLite 自动备份
 *
 * ===== 为什么不用 cp 复制 app.db =====
 * 库开的是 WAL 模式：数据分散在 app.db 和 app.db-wal 两个文件里，直接 cp 主文件
 * 会拿到"写了一半"的状态（WAL 里那些已提交的事务全丢）。SQLite 的 VACUUM INTO
 * 会在一个读事务里导出一份完整、一致的单文件快照，这才是"可以拿去恢复"的备份。
 *
 * ===== 什么时候跑 =====
 *   启动后 1 分钟一份（避开启动时加载模型的高峰）
 *   之后每 BACKUP_INTERVAL_HOURS 小时一份（默认 24）
 *   也可以手动：npm run backup
 *
 * 保留 BACKUP_KEEP 份（默认 7），按文件名里的时间排序删最旧的——不按 mtime，
 * 因为拷贝、恢复会把 mtime 改掉，文件名才是真相。
 *
 * 备份失败只告警，绝不影响服务：这是运维兜底，不是业务前置条件。
 */
const fs = require('node:fs')
const path = require('node:path')
const db = require('./db')
const { log } = require('./logger')

const DB_FILE = process.env.APP_DB_FILE || path.join(__dirname, 'data', 'app.db')
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups')
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 7))
const INTERVAL_HOURS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24))
const DISABLED = process.env.BACKUP_DISABLED === '1'

const pad = n => String(n).padStart(2, '0')

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 只留最近 KEEP 份；文件名前缀带日期，按名字倒序即时间倒序 */
function prune() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(name => /^app-\d{8}-\d{6}(-\w+)?\.db$/.test(name))
      .sort()
      .reverse()
    for (const name of files.slice(KEEP)) {
      fs.unlinkSync(path.join(BACKUP_DIR, name))
      log.info('[backup] 清理旧备份', { file: name })
    }
  } catch (err) {
    log.warn('[backup] 清理旧备份失败', { error: err?.message })
  }
}

/**
 * 立刻做一份备份。
 * @param {string} [tag] 文件名后缀，如 manual / auto / pre-migrate
 * @returns {{ok: boolean, file?: string, size?: number, error?: string}}
 */
function backupNow(tag = 'auto') {
  if (DISABLED) return { ok: false, error: 'BACKUP_DISABLED=1，已跳过' }
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    let name = `app-${stamp()}-${tag}.db`
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
    log.info('[backup] 已生成备份', { file: name, sizeKB: Math.round(size / 1024) })
    prune()
    return { ok: true, file: full, size }
  } catch (err) {
    log.error('[backup] 备份失败', { error: err?.message })
    return { ok: false, error: err?.message || String(err) }
  }
}

/** 列出已有备份（新→旧） */
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(name => /^app-\d{8}-\d{6}(-\w+)?\.db$/.test(name))
      .sort()
      .reverse()
      .map(name => {
        const full = path.join(BACKUP_DIR, name)
        const st = fs.statSync(full)
        return { name, size: st.size, mtime: st.mtimeMs }
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
  log.info('[backup] 自动备份已启用', { dir: BACKUP_DIR, keep: KEEP, intervalHours: INTERVAL_HOURS })
}

// 直接 node backup.js 运行时：立刻备份一份并打印结果
if (require.main === module) {
  const res = backupNow('manual')
  if (res.ok) console.log(`备份完成：${res.file}（${(res.size / 1024).toFixed(0)} KB）`)
  else console.log(`备份失败：${res.error}`)
  process.exit(res.ok ? 0 : 1)
}

module.exports = { backupNow, listBackups, startAutoBackup, BACKUP_DIR }
