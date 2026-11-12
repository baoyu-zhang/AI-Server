/**
 * runtime.js —— 请求 ID、就绪状态与优雅关闭
 *
 * ===== 三个问题一次解决 =====
 * ① 排查故障时「日志里这一行属于哪个请求」全靠时间戳猜 → 用 AsyncLocalStorage
 *    给每个请求发一个 id，日志自动带上，响应头也回给浏览器，前端报错能直接贴给后端。
 * ② pm2 restart / Railway 换版本时，正在流式回答的连接被直接掐断，
 *    甚至可能留下半截 run → 关停前先停止接新请求，等活跃响应结束再退出。
 * ③ 健康检查只会说「进程活着」，但 embedding 模型没加载完时其实还不能干活
 *    → ready 状态区分「活着」与「能接客」。
 *
 * ===== 为什么用 AsyncLocalStorage 而不是 req 上挂字段 =====
 * log.info() 是全局函数，拿不到 req。ALS 让同一条异步调用链上的所有日志
 * 自动读到当前请求 id，业务代码一行都不用改。Node 22 原生支持，零依赖。
 */
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')

const storage = new AsyncLocalStorage()
let ready = false // listen 回调里置 true，开始关停时置 false
let shuttingDown = false
let activeRequests = 0 // 活跃响应数：SSE 长连接会一直算在内，正是关停时要等的
let shutdownTimer = null

/** 取当前异步链上的请求 id；不在请求上下文里（如启动期日志）返回 undefined */
function getRequestId() {
  return storage.getStore()?.requestId
}

function isReady() { return ready && !shuttingDown }
function isShuttingDown() { return shuttingDown }
function getActiveRequests() { return activeRequests }

/**
 * 请求 ID + 活跃连接计数。必须挂在所有路由（含静态资源、健康检查）之前。
 * 复用客户端传来的 X-Request-Id 便于跨服务串联，但做格式白名单防止注入超长/换行头。
 */
function attachRequestContext(app) {
  app.use((req, res, next) => {
    const incoming = String(req.headers['x-request-id'] || '')
    const requestId = /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : randomUUID()
    res.setHeader('X-Request-Id', requestId) // 前端拿到后可在错误提示里显示，便于报障

    activeRequests++
    let counted = false
    const done = () => {
      if (counted) return
      counted = true
      activeRequests--
    }
    // finish = 正常结束；close = 客户端断开 / 被中断。两者都要减，否则关停会一直等
    res.once('finish', done)
    res.once('close', done)

    storage.run({ requestId }, next)
  })
}

function markReady() { ready = true }

/**
 * 优雅关闭： Railway / pm2 发 SIGTERM 时给一次「把活干完」的机会。
 *
 * 顺序是硬要求：
 *   1. ready=false → 健康检查开始返回 503，负载均衡/平台不再把新流量打过来；
 *   2. server.close() → 停止 accept 新连接（已建立的连接继续跑完）；
 *   3. 等活跃响应归零，最多等 SHUTDOWN_TIMEOUT_MS（默认 20 秒，SSE 一轮通常够）；
 *   4. 关数据库（WAL 正常落盘）后退出。
 * 最后挂一个绝对超时兜底：万一有连接卡死，也不能让平台等到超时强杀（强杀会丢日志）。
 */
function attachGraceful(server, { timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 20000) } = {}) {
  let closing = false
  const shutdown = signal => {
    if (closing) return // 平台可能连发两次 SIGTERM，只处理第一次
    closing = true
    shuttingDown = true
    ready = false
    const log = require('./logger').log // 延迟 require：避免与 logger 形成加载循环
    log.info('[runtime] 收到关停信号，停止接新请求', { signal, activeRequests })

    server.close(() => log.info('[runtime] 所有连接已关闭'))
    // 超过 timeout 还没关完就强制退出：宁可掐断一个卡死的流，也不能让进程变成僵尸
    shutdownTimer = setTimeout(() => {
      log.warn('[runtime] 关停超时，强制退出', { activeRequests })
      finish(1)
    }, timeoutMs)
    shutdownTimer.unref()

    // activeRequests 归零即收尾； SSE 长连接结束时 finish 事件会触发这里的检查
    const poll = setInterval(() => {
      if (activeRequests === 0) {
        clearInterval(poll)
        log.info('[runtime] 活跃响应已全部结束', { signal })
        finish(0)
      }
    }, 200)
    poll.unref()
  }

  let finished = false
  const finish = code => {
    if (finished) return
    finished = true
    if (shutdownTimer) clearTimeout(shutdownTimer)
    try {
      // db.close() 让 WAL 正常 checkpoint；失败也不能阻止退出
      require('./db').close?.()
    } catch { /* 关库失败不影响退出 */ }
    process.exit(code)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // 未捕获异常：记一条日志再退出，交给平台重启。注意不要「吞掉」异常继续跑，
  // 那会留下状态半残的进程，比重启危险得多。
  process.on('uncaughtException', err => {
    require('./logger').log.error('[runtime] 未捕获异常', { message: err.message, stack: err.stack })
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    require('./logger').log.error('[runtime] 未处理的 Promise 拒绝', { reason: String(reason) })
  })
}

module.exports = {
  getRequestId, isReady, isShuttingDown, getActiveRequests,
  attachRequestContext, attachGraceful, markReady
}
