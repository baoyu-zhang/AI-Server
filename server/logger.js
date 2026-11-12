/**
 * logger.js —— 极简结构化日志 + 文件落盘
 *
 * ===== 为什么不装 pino =====
 * M1 要的是"一行一个 JSON、带时间戳和级别、能被日志采集器直接吃"，
 * 这 30 行就够了；pino 的价值（传输线程、子 logger、序列化性能）在并发上来之前用不上。
 * 真要换时调用面只有 log/info/warn/error 四个函数，替换成本趋近于零。
 *
 * ===== 级别开关 =====
 * LOG_LEVEL=debug 时才有 debug 行；默认 info。production 建议显式设 info 或 warn。
 *
 * ===== 双写：stdout + 文件 =====
 * stdout 是容器化后唯一正确的日志出口（交给采集器），但本地开发时 stdout 只在
 * 启动它的那个终端窗口里，重启就没了——线上排查"昨天那个报错"根本翻不到。
 * 所以这里再挂一路文件：
 *   - 位置：server/logs/app-YYYY-MM-DD.log（按本地时区换日，人肉好找）
 *   - 轮转：单文件超过 LOG_MAX_BYTES（默认 10MB）自动切 app-日期.1.log、.2.log…
 *   - 保留：超过 LOG_KEEP_DAYS（默认 7 天）的旧文件在换日时清掉
 *   - 关掉：LOG_TO_FILE=0
 *
 * 关键点：不是只把 log.info() 写文件，而是接管 process.stdout/stderr 的 write。
 * 因为 index.js 里还有大量 console.log 打的 agent 轨迹（当前步数/工具调用/工具返回），
 * 以及 Node 自己的 ExperimentalWarning——只拦 logger 会漏掉这些，排查时最缺的恰好是它们。
 * 写入用 fs.writeSync：进程被 kill 时数据已经在内核缓冲区，不会像流缓冲那样丢最后几行。
 */
const fs = require('node:fs')
const path = require('node:path')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const current = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info

// ============ 文件落盘 ============
const FILE_ENABLED = process.env.LOG_TO_FILE !== '0'
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, 'logs'))
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024)
const KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS || 7)

let fd = null // 当前打开的日志文件句柄
let curDay = '' // 当前文件对应的日期戳，用来判断是否跨天
let curFile = '' // 当前文件名（basename），给健康检查/排查用
let curSize = 0 // 已写入字节数，用来判断是否该轮转
let broken = false // 文件路出错后彻底放弃（绝不能因为日志把服务弄挂）

const pad = n => String(n).padStart(2, '0')
/** 本地时区日期戳 YYYYMMDD：用本地时间而不是 UTC，凌晨看日志不会跨两个文件 */
function dayStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 打开当天第一个未写满的文件（已有同名的接着追加，重启不丢历史） */
function openForDay(day) {
  for (let idx = 0; idx < 1000; idx++) {
    const file = idx === 0 ? `app-${day}.log` : `app-${day}.${idx}.log`
    const full = path.join(LOG_DIR, file)
    let size = 0
    try {
      size = fs.statSync(full).size
    } catch {
      // 文件不存在：本次新建
    }
    if (size >= MAX_BYTES) continue // 写满了，试下一个序号
    fd = fs.openSync(full, 'a')
    curDay = day
    curFile = file
    curSize = size
    return
  }
  throw new Error('日志文件序号超过 1000，请清理 logs 目录')
}

/** 删除超过保留天数的日志（只在换日时跑一次，不做定时器） */
function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!/^app-\d{8}(\.\d+)?\.log$/.test(name)) continue
      const full = path.join(LOG_DIR, name)
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
    }
  } catch {
    // 清理失败无所谓，不能影响主流程
  }
}

function appendRaw(chunk) {
  if (!FILE_ENABLED || broken) return
  try {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    const day = dayStamp()
    if (fd === null || day !== curDay || curSize >= MAX_BYTES) {
      if (fd !== null) fs.closeSync(fd)
      fd = null
      if (day !== curDay) prune()
      openForDay(day)
    }
    fs.writeSync(fd, buf)
    curSize += buf.length
  } catch (err) {
    // 磁盘满、权限不足……日志写不进去也绝不能拖垮服务：关掉文件路，终端照常输出
    broken = true
    try {
      if (fd !== null) fs.closeSync(fd)
    } catch {}
    fd = null
    console.error(`[logger] 文件日志已停用：${err.message}`)
  }
}

/** 接管 stdout/stderr：所有输出先落盘再交给原通道，终端里照常能看见 */
function teeStdio() {
  for (const key of ['stdout', 'stderr']) {
    const stream = process[key]
    const original = stream.write.bind(stream)
    stream.write = (chunk, encoding, callback) => {
      appendRaw(chunk)
      return original(chunk, encoding, callback)
    }
  }
}

if (FILE_ENABLED) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    openForDay(dayStamp())
    prune()
    teeStdio()
    // 启动时打一行，终端和文件里都能看到"到底写哪去了"
    console.log(`[logger] 文件日志: ${logFile()}（保留 ${KEEP_DAYS} 天，单文件 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 轮转）`)
  } catch (err) {
    broken = true
    console.error(`[logger] 文件日志初始化失败，仅输出到 stdout：${err.message}`)
  }
}

/** 当前日志文件的绝对路径，null 表示文件路未启用/已停用 */
function logFile() {
  return fd === null ? null : path.resolve(LOG_DIR, curFile)
}

function emit(level, args) {
  if (LEVELS[level] < current) return
  const entry = { ts: new Date().toISOString(), level }
  // 第一个参数若是字符串当 message，其余原样并排——保持 console.log 的手感，但结构化
  if (typeof args[0] === 'string') {
    entry.msg = args[0]
    if (args.length > 1) entry.data = args.slice(1)
  } else {
    entry.data = args
  }
  const line = JSON.stringify(entry, (_, v) => (typeof v === 'bigint' ? String(v) : v))
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

const log = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args)
}

/** HTTP 访问日志：方法 / 路径 / 状态 / 耗时。放在鉴权之前挂，401 也要留痕 */
function httpLog(req, res, next) {
  const start = Date.now()
  res.on('finish', () => {
    // /agui 是 SSE 长连接，finish 触发在整轮结束，耗时即整轮耗时，正好
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
    emit(level, [`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`])
  })
  next()
}

module.exports = { log, httpLog, LOG_DIR, logFile }
