/**
 * usage-store.js —— 模型用量落库
 *
 * ===== 为什么要记 =====
 * 成本不可见 = 成本不可控。每轮 run 的真实 token 用量（服务端返回值，不是客户端估算）
 * 落库后才能回答"这个账号烧了多少 token""哪种模型贵""长对话裁剪有没有省到钱"。
 *
 * ===== 为什么独立一张表而不是塞进 thread_runs =====
 * 消息快照是"对话数据"：跟着会话走、会被业务逻辑消费；用量是"运营数据"：
 * 只追加、按人/按时间聚合查询、删除会话（未来功能）也不该跟着删。混在一起两边都别扭。
 *
 * ===== 记录时机 =====
 * /agui 的 finally 里 await result.usage：正常结束、interrupt、出错、客户端断开
 * 都能拿到（中断时是部分用量，也值得记——账单不会因为客户端断开就少收）。
 * token 数来自模型服务端，和 chat-core 里 cl100k 估算值口径不同，两者不要互相比较。
 */
const db = require('./db')

/** 一轮 run 结束后记一条用量。字段缺失（如部分 provider 不报 usage）时按 0 落库 */
function saveUsage({ threadId, runId, userId, model, usage, steps }) {
  if (!threadId || !runId || !userId || !model) return
  const inputTokens = Number(usage?.inputTokens) || 0
  const outputTokens = Number(usage?.outputTokens) || 0
  db.prepare(`
    INSERT INTO model_usage (thread_id, run_id, user_id, model, input_tokens, output_tokens, total_tokens, steps, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, runId, userId, model, inputTokens, outputTokens,
    Number(usage?.totalTokens) || inputTokens + outputTokens,
    Math.max(1, Number(steps) || 1), Date.now())
}

/** 某用户的最近明细（倒序，limit 默认 50） */
function listUsage(userId, limit = 50) {
  return db.prepare(`
    SELECT thread_id AS threadId, run_id AS runId, model, input_tokens AS inputTokens,
           output_tokens AS outputTokens, total_tokens AS totalTokens, steps, created_at AS createdAt
    FROM model_usage WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, Math.min(Math.max(1, Number(limit) || 50), 200))
}

/** 某用户的汇总：总 token、总轮次、按模型拆分 */
function sumUsage(userId) {
  const byModel = db.prepare(`
    SELECT model, COUNT(*) AS runs, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
    FROM model_usage WHERE user_id = ? GROUP BY model
  `).all(userId)
  const totals = byModel.reduce(
    (acc, row) => ({
      runs: acc.runs + row.runs,
      inputTokens: acc.inputTokens + (row.inputTokens || 0),
      outputTokens: acc.outputTokens + (row.outputTokens || 0)
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0 }
  )
  return { totals, byModel }
}

module.exports = { saveUsage, listUsage, sumUsage }
