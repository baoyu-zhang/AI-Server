/**
 * ops-alert.js —— 错误阈值运维告警（P1 运维闭环）
 *
 * ===== 为什么需要它 =====
 * logger.js 已经把 error 级日志一行不落地写进文件和 stdout，但「写下来」不等于
 * 「有人知道」。服务在云上跑着，短时间内连续抛错（模型密钥失效、磁盘满、依赖挂了）
 * 时，没有人会一直盯着日志。本模块把「错误密度」变成一个可告警的信号：窗口内 error
 * 攒够阈值就报一次，之后进冷却期，避免同一个故障刷屏把人淹了。
 *
 * ===== 为什么刻意不复用 webhook-store.js =====
 * 那边是「按用户投递的业务通知」：查用户注册的 url、按 EVENTS 白名单过滤、而且为了防
 * SSRF 明确拒绝 localhost/内网地址。运维告警是「服务端自己的事」：目标是运维配置的
 * 一个固定地址（常常就是内网的告警接收器）、与任何用户无关、也不该受业务事件白名单
 * 约束。硬复用既绕不开它的内网拦截，又会把「用户通知」和「系统告警」两条语义搅在一起，
 * 所以这里单独走一条极简的 POST 通道。
 *
 * ===== 三条设计取舍 =====
 * 1. 纯惰性计算：模块加载时不起任何 setInterval/setTimeout。窗口清理、冷却判断都在
 *    noteError() 被调用那一刻现算——没有定时器就不会拖住进程退出，也不用 unref 操心。
 * 2. fire-and-forget：告警 POST 绝不 await、绝不抛。网络挂了只写一条 warn，不能因为
 *    「告警发不出去」把一次正常的请求错误处理带崩。末尾必挂 .catch 兜 unhandledRejection
 *    （webhook-store.js 注释里记过这个坑：独立的 Promise 没人接，Node 会直接退出进程）。
 * 3. 二选一出口：配了 OPS_ALERT_WEBHOOK 就 POST（带 HMAC 签名）；没配就退化成
 *    log.error + 一条 ops.alert 审计，保证「至少在日志和审计里留得下」。
 *
 * ===== 接线（给主线程看） =====
 * index.js 在「所有路由之后、现有统一错误出口之前」调用 attachOpsAlert(app)。
 * 顺序很关键：现有那个错误出口会 res.json() 把响应终结掉、不再 next(err)，
 * 挂它之后错误就传不到本模块，noteError 永远收不到东西。
 */
const crypto = require('node:crypto')      // createHmac：给告警请求体算 X-Signature
const { log } = require('./logger')        // 没配 webhook 时的告警出口，以及投递失败的 warn
const { recordAudit } = require('./audit') // 没配 webhook 时落一条 ops.alert 审计（长期留存、可检索）

// ===== 可调参数：全部读环境变量，给默认值，Math.max 防手滑配成 0/负数 =====
const THRESHOLD = Math.max(1, Number(process.env.OPS_ALERT_THRESHOLD || 5))            // 窗口内攒够几条 error 触发一次
const WINDOW_MS = Math.max(1, Number(process.env.OPS_ALERT_WINDOW_MS || 5 * 60 * 1000))   // 滑动窗口长度，默认 5 分钟
const COOLDOWN_MS = Math.max(1, Number(process.env.OPS_ALERT_COOLDOWN_MS || 10 * 60 * 1000)) // 触发后的冷却，默认 10 分钟
const WEBHOOK = process.env.OPS_ALERT_WEBHOOK || ''   // 配了就 POST 到这里；没配就只 log + audit
const SECRET = process.env.OPS_ALERT_SECRET || ''     // HMAC-SHA256 密钥；配了 webhook 就该同时配它
const SUMMARY_MAX = 200                              // 单条错误摘要截断长度：别让一条超长堆栈撑爆告警体
const RECENT_MAX = 5                                 // 告警里附最近几条错误，够了，全贴上去反而看不清

// ===== 纯内存状态（进程重启即清零，符合「当前故障」的语义，不需要落库）=====
let hits = []            // 窗口内的错误事件 [{at, summary, context}]，靠惰性 filter 保持不超窗口
let lastAlertAt = 0      // 上次触发告警的毫秒时间戳；0 表示从没触发过
let totalErrors = 0      // 进程启动以来累计 error 数，只给 getErrorStats() 看趋势

/** 把任意 err 收敛成一段可打印的短文本（Error / 字符串 / 对象都接得住） */
function toMessage(err) {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

/**
 * 记一条 error 级事件，并在「窗口内达到阈值 且 不在冷却期」时触发一次告警。
 * attachOpsAlert 挂的中间件会对每个未捕获异常调它；业务代码也可以手动 noteError(err, {...})。
 * @param {any} err 错误对象 / 字符串
 * @param {object} [ctx] 上下文，如 {method, url, ip, source}，只取几个标量字段，绝不整个 req 塞进来（防循环引用）
 */
function noteError(err, ctx = {}) {
  const now = Date.now()
  const summary = toMessage(err).slice(0, SUMMARY_MAX)          // 截断：单条错误摘要不撑爆告警
  const context = {                                            // 只挑标量，方便 JSON 化进日志/告警
    method: ctx?.method || null,
    url: ctx?.url || ctx?.originalUrl || null,
    ip: ctx?.ip || null,
    source: ctx?.source || 'manual'
  }
  hits.push({ at: now, summary, context })
  totalErrors++

  // 惰性清理：只在「有事件进来」时把窗口外的旧 hit 丢掉，不需要定时器周期性扫
  hits = hits.filter(h => now - h.at < WINDOW_MS)

  // 冷却期内一律不再报：一个持续故障每 COOLDOWN_MS 最多提醒一次，避免刷屏
  if (now - lastAlertAt < COOLDOWN_MS) return
  if (hits.length < THRESHOLD) return

  lastAlertAt = now                                            // 先记时间再发，防止异步投递期间重复触发
  fireAlert(buildPayload(now))
}

/** 组装告警内容：时间 / 最近错误摘要 / 进程 uptime / 是否 Railway，webhook 与日志两条出口共用 */
function buildPayload(now) {
  return {
    event: 'ops.alert',
    time: new Date(now).toISOString(),                         // ISO 时间，给机器解析
    timeLocal: new Date(now).toLocaleString('zh-CN'),         // 本地时间，给人看
    count: hits.length,                                       // 当前窗口内的 error 数
    threshold: THRESHOLD,
    windowMs: WINDOW_MS,
    uptimeSec: Math.round(process.uptime()),                  // 进程存活秒数：区分「刚重启就炸」和「跑久了才炸」
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT),        // Railway 会注入这个变量；本地没有 → false
    recent: hits.slice(-RECENT_MAX).map(h => ({               // 最近几条错误摘要（已各自截断）
      time: new Date(h.at).toISOString(),
      summary: h.summary,
      source: h.context.source
    }))
  }
}

/**
 * 告警出口（按优先级二选一）：
 *   配了 OPS_ALERT_WEBHOOK → POST JSON；没配 → log.error + recordAudit。
 */
function fireAlert(payload) {
  if (WEBHOOK) {
    // fire-and-forget：不 await；末尾 .catch 必须挂，否则独立 Promise 里的异常会变成
    // unhandledRejection 直接把整个进程带崩（webhook-store.js 注释里记过这个坑）。
    void postWebhook(payload).catch(err => {
      log.warn('[ops-alert] 告警投递出现未捕获异常', { error: err?.message })
    })
    return
  }
  // 没配 webhook：把完整 payload 打进 error 日志（结构化，采集器能直接吃）
  log.error('[ops-alert] 错误达到阈值，触发告警', payload)
  // 审计 detail 会被 audit.js 截断到 500 字符，所以放精简版，保证关键字段不被截掉
  recordAudit({
    action: 'ops.alert',
    target: 'error-threshold',
    detail: {
      time: payload.time,
      count: payload.count,
      threshold: payload.threshold,
      uptimeSec: payload.uptimeSec,
      railway: payload.railway,
      recent: payload.recent.map(r => r.summary)
    }
  })
}

/**
 * 一次告警 POST：HMAC-SHA256 签名头 + 5 秒超时，失败只 warn 不抛。
 * 签名格式与 webhook-store.js 一致（sha256=<hex>），接收方拿 OPS_ALERT_SECRET 对同一份
 * body 复算即可验真；裸 HTTP 谁都能伪造 POST，签名是为了确认「确实是我们发的」。
 */
async function postWebhook(payload) {
  const body = JSON.stringify({ event: payload.event, payload, timestamp: Date.now() }) // 先定死 body 再签名，保证签名覆盖实际发送的字节
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex')
  if (!SECRET) {
    log.warn('[ops-alert] 未配置 OPS_ALERT_SECRET，签名为空密钥，请尽快补上', {})
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)  // 5 秒拿不到响应就放弃，别拖住后续
  timer.unref?.()                                          // 这个定时器也不许拖住进程退出（惰性 defense）
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event': 'ops.alert',                            // 接收方按事件名路由
        'X-Signature': `sha256=${signature}`              // HMAC 签名：接收方用 OPS_ALERT_SECRET 校验
      },
      body,
      signal: controller.signal
    })
    if (!res.ok) log.warn('[ops-alert] 告警 webhook 返回非 2xx', { status: res.status })
  } catch (err) {
    // 超时 / DNS 失败 / 连接拒绝：只 warn，绝不往外抛（告警发不出去不能影响业务）
    const reason = err?.name === 'AbortError' ? 'timeout(5s)' : (err?.message || 'network error')
    log.warn('[ops-alert] 告警 webhook 投递失败', { error: reason })
  } finally {
    clearTimeout(timer)                                   // 必清：不清会留着定时器占事件循环
  }
}

/**
 * 挂一个 Express 错误处理中间件（必须是 4 个参数，Express 才认它是错误处理层）。
 * 只做「把未捕获的 error 交给 noteError 统计/告警」，随后 next(err) 把错误交回给下一个
 * 错误处理中间件去生成响应——本模块不吞错误、不改状态码。
 * @param {import('express').Express} app
 */
function attachOpsAlert(app) {
  app.use((err, req, res, next) => {
    noteError(err, {
      method: req?.method,
      url: req?.originalUrl,
      ip: req?.ip,
      source: 'express'
    })
    next(err)
  })
}

/**
 * 返回当前告警器状态快照，供运维/健康检查查看（纯读 + 惰性清理，无副作用、无定时器）。
 */
function getErrorStats() {
  const now = Date.now()
  hits = hits.filter(h => now - h.at < WINDOW_MS)           // 顺手做一次惰性清理，保证 inWindow 是当前值
  return {
    windowMs: WINDOW_MS,
    threshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    inWindow: hits.length,                                 // 当前窗口内 error 数
    total: totalErrors,                                    // 进程累计 error 数
    lastAlertAt: lastAlertAt ? new Date(lastAlertAt).toISOString() : null,
    inCooldown: now - lastAlertAt < COOLDOWN_MS,          // 是否还在冷却期
    webhookConfigured: Boolean(WEBHOOK),                  // 方便确认「到底会不会真发出去」
    uptimeSec: Math.round(process.uptime()),
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT)
  }
}

module.exports = { noteError, attachOpsAlert, getErrorStats }
