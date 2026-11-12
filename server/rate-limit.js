/**
 * rate-limit.js —— 通用滑动窗口限流中间件
 *
 * ===== 为什么 auth.js 里已有限流还要这个 =====
 * auth.js 的限流是"登录专用"的（按失败次数锁定，语义是防爆破）；
 * 这里要防的是另一类问题：**合法用户的高频调用**——脚本 bug 里 while(true) 打
 * /v1、爬虫批量拉接口。这类流量凭证是真的、行为是错的，只能靠频率闸门拦。
 *
 * ===== 实现：内存滑动窗口 =====
 * 每个 key 存一个时间戳数组，请求来了先清掉窗口外的旧戳再数新戳。
 * 为什么不入库不上 Redis：单机部署内存 Map 就是正确答案——微秒级、零依赖，
 * 进程重启清零对"限流"这种短期状态恰好无害（和 auth.js 的取舍一致）。
 * 多实例部署时把 Map 换成 Redis，中间件签名不变。
 *
 * ===== 为什么是滑动窗口不是固定窗口 =====
 * 固定窗口（每分钟一个桶）在边界处会放过 2 倍流量（59 秒打满 + 下一秒重新计满）；
 * 滑动窗口严格保证"任意连续 windowMs 内最多 max 次"。
 */
const { log } = require('./logger')

/**
 * 创建一个限流中间件。
 * @param {object} opts
 * @param {number} opts.windowMs 统计窗口（毫秒）
 * @param {number} opts.max 窗口内允许的最大请求数
 * @param {(req: any) => string} opts.key 从请求里取限流维度（一般用 userId 或 ip）
 * @param {string} [opts.name] 日志标识，如 'chat'
 */
function createRateLimit({ windowMs, max, key, name = 'generic' }) {
  const hits = new Map() // key -> 时间戳数组（升序）

  // 定期清理：没有请求进来的 key 不占内存（unref：不拖住进程退出）
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [k, arr] of hits) {
      while (arr.length && now - arr[0] > windowMs) arr.shift()
      if (!arr.length) hits.delete(k)
    }
  }, windowMs).unref()

  return function rateLimit(req, res, next) {
    const now = Date.now()
    const k = key(req) || 'unknown'
    const arr = hits.get(k) || []
    while (arr.length && now - arr[0] > windowMs) arr.shift()

    if (arr.length >= max) {
      // Retry-After 给到秒：标准头，OpenAI 客户端/网关都认它
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000))
      log.warn(`[ratelimit] ${name} 触发限流`, { key: k, hits: arr.length, max })
      res.setHeader('Retry-After', retryAfter)
      return res.status(429).json({
        error: `请求过于频繁，请 ${retryAfter} 秒后再试（每 ${Math.round(windowMs / 1000)} 秒上限 ${max} 次）`
      })
    }

    arr.push(now)
    hits.set(k, arr)
    next()
  }
}

module.exports = { createRateLimit }
