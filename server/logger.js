/**
 * logger.js —— 极简结构化日志
 *
 * ===== 为什么不装 pino =====
 * M1 要的是"一行一个 JSON、带时间戳和级别、能被日志采集器直接吃"，
 * 这 30 行就够了；pino 的价值（传输线程、子 logger、序列化性能）在并发上来之前用不上。
 * 真要换时调用面只有 log/info/warn/error 四个函数，替换成本趋近于零。
 *
 * ===== 级别开关 =====
 * LOG_LEVEL=debug 时才有 debug 行；默认 info。production 建议显式设 info 或 warn。
 * 输出只有 stdout 一路：容器化之后 stdout 就是唯一正确的日志出口，文件交给采集器管。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const current = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info

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

module.exports = { log, httpLog }
