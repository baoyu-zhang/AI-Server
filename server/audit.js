/**
 * audit.js —— 操作审计（只追加，可按人/动作/时间查）
 *
 * ===== 为什么不用 logger 代替 =====
 * 日志是给"现在排查"用的：按天轮转、7 天就清、没有索引、混杂着健康检查。
 * 审计是给"事后追责"用的：要长期留存、要能按用户和动作检索、要能回答
 * "谁在什么时候把这份简历的状态改成了录用"。两者生命周期和查询方式都不同，
 * 所以落库而不是落文件。
 *
 * ===== 写不进去怎么办 =====
 * 审计失败绝不能挡住业务动作本身（用户已经点了"同意"，不能因为日志表锁住就失败），
 * 但也不能静默——降级为一条 error 日志，人工可查。这是有意的取舍：
 * 本次审计可以丢，但服务不能挂。
 */
const db = require('./db')
const { log } = require('./logger')

const insert = () => db.prepare(
  'INSERT INTO audit_log (user_id, actor, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
)

let stmt = null

/**
 * 记一条审计。
 * @param {object} entry
 * @param {string} [entry.userId] 操作者 id
 * @param {string} [entry.actor]  操作者用户名（冗余，便于删号后仍可读）
 * @param {string} entry.action   动作标识，约定 <域>.<动作>，如 tool.deleteDocument
 * @param {string} [entry.target] 作用对象
 * @param {any}    [entry.detail] 结果/参数摘要，对象会被 JSON 化并截断
 * @param {string} [entry.ip]
 */
function recordAudit(entry) {
  try {
    if (!stmt) stmt = insert()
    const detail = entry.detail === undefined || entry.detail === null
      ? null
      : typeof entry.detail === 'string'
        ? entry.detail.slice(0, 500)
        : JSON.stringify(entry.detail).slice(0, 500) // 截断：宁可不全，也不能让一条超大入参把表撑爆
    stmt.run(
      entry.userId || null,
      entry.actor || null,
      String(entry.action || 'unknown').slice(0, 100),
      entry.target ? String(entry.target).slice(0, 200) : null,
      detail,
      entry.ip || null,
      Date.now()
    )
  } catch (err) {
    // 降级：审计丢了要留痕，但不能让业务动作失败
    log.error('[audit] 写入失败', { action: entry?.action, error: err?.message })
  }
}

/**
 * 查某个人的审计记录（按时间倒序），limit 上限 200 防止一次拉爆。
 *
 * 为什么还要匹配 actor：登录失败的记录发生在认证之前，那时还不知道 userId
 * （甚至用户名可能根本不存在），只有 actor 这一个线索。只按 user_id 过滤的话，
 * 用户永远看不到"有人在试我的密码"，而这恰恰是他最该看到的一类记录。
 * 用户名在库里唯一，所以 actor 匹配不会串到别人身上。
 */
function listAudit(userId, username, limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
  return db.prepare(
    `SELECT id, action, target, detail, ip, created_at
       FROM audit_log
      WHERE user_id = ? OR (? IS NOT NULL AND actor = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(userId, username || null, username || null, n)
}

module.exports = { recordAudit, listAudit }
