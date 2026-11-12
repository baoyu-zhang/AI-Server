/**
 * quota.js —— 每用户每日 Token 配额
 *
 * ===== 为什么必须有限额 =====
 * model_usage 只"记账"不"管账"：账单可见，但一个泄漏的 sk- key 或一段失控的
 * 自动化脚本可以在一天内烧掉数百万 token。配额是唯一能把爆炸半径封顶的手段——
 * 超限直接 429，服务不受理，损失锁死在限额以内。
 *
 * ===== 限额怎么定（两层） =====
 *   1. 用户级覆盖：users.quota_daily 列（admin 通过 PATCH /api/admin/users/:id/quota 设置）
 *   2. 全局默认：env DAILY_TOKEN_LIMIT（默认 500000，设 0 = 不限制，仅供本地开发）
 * 优先级：用户列 > 全局默认。NULL 列表示"跟全局走"——新增用户零配置即受保护。
 *
 * ===== 为什么按"自然日"而不是"滚动 24 小时" =====
 * 自然日跟人的直觉一致（"今天还能用多少"），账单也是按日出的，对账方便；
 * 滚动窗口的优势是防"整点冲刺"，但对聊天场景收益不大。凌晨清零用的是本地时区。
 *
 * ===== 检查时机 =====
 * run 开始前（/agui、/v1 入口）拦截，而不是流中途掐断——半截回答比明确拒绝更糟。
 * 用量在 run 结束的 finally 里才落库，所以并发窗口内可能小幅超限（如两个请求同时
 * 通过检查再同时记满），对配额场景这是可接受的误差，不值得为此上事务锁。
 */
const db = require('./db')

/** 全局默认每日上限（token 数），0 = 不限制 */
const GLOBAL_DAILY_LIMIT = Math.max(0, Number(process.env.DAILY_TOKEN_LIMIT ?? 500000))

/** 当天零点（本地时区）的时间戳：所有"今日用量"查询都用它做下界 */
function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 某用户今日已用 token 总数（model_usage 在 run 结束时落库，见 usage-store.js） */
function getTodayUsage(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS used
    FROM model_usage WHERE user_id = ? AND created_at >= ?
  `).get(userId, startOfToday())
  return row.used
}

/**
 * 查某用户的生效限额。
 * @returns {{ limit: number, source: 'user'|'global'|'none' }}
 *   limit=0 表示不限制；source 标明限额来自用户覆盖还是全局默认（管理端展示用）
 */
function getEffectiveLimit(userId) {
  const user = db.prepare('SELECT quota_daily FROM users WHERE id = ?').get(userId)
  if (!user) return { limit: 0, source: 'none' }
  if (user.quota_daily !== null && user.quota_daily !== undefined) {
    return { limit: Math.max(0, Number(user.quota_daily)), source: 'user' }
  }
  return { limit: GLOBAL_DAILY_LIMIT, source: 'global' }
}

/**
 * 配额检查：限额 > 0 且今日已用 >= 限额时拒绝。
 * @returns {{ allowed: boolean, used: number, limit: number, remaining: number }}
 */
function checkQuota(userId) {
  const used = getTodayUsage(userId)
  const { limit } = getEffectiveLimit(userId)
  // remaining 不为负：已超限时（比如 admin 调低了限额）显示 0 而不是负数
  const remaining = limit > 0 ? Math.max(0, limit - used) : Infinity
  return { allowed: limit === 0 || used < limit, used, limit, remaining }
}

/**
 * 设置某用户的每日限额（admin 接口用）。
 * @param {string} userId
 * @param {number|null} quotaDaily 数字 = 覆盖全局；null = 恢复跟全局走
 * @returns {boolean} 用户是否存在
 */
function setUserQuota(userId, quotaDaily) {
  const value = quotaDaily === null || quotaDaily === undefined
    ? null
    : Math.max(0, Math.floor(Number(quotaDaily)))
  if (quotaDaily !== null && quotaDaily !== undefined && !Number.isFinite(Number(quotaDaily))) {
    throw new Error('quotaDaily 必须是数字或 null')
  }
  const res = db.prepare('UPDATE users SET quota_daily = ? WHERE id = ?').run(value, userId)
  return res.changes > 0
}

/** 供 /api/usage 响应拼接配额进度（前端用量页签直接渲染） */
function quotaSummary(userId) {
  const { allowed, used, limit, remaining } = checkQuota(userId)
  const { source } = getEffectiveLimit(userId)
  return {
    usedToday: used,
    dailyLimit: limit === 0 ? null : limit, // null = 不限制，前端好区分
    remaining: limit === 0 ? null : remaining,
    exceeded: !allowed,
    source
  }
}

module.exports = { checkQuota, quotaSummary, setUserQuota, getEffectiveLimit, getTodayUsage, GLOBAL_DAILY_LIMIT }
