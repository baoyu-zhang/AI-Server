/**
 * threads-store.js —— 对话历史的服务端落库
 *
 * ===== 为什么服务端本来无状态，现在要落库 =====
 * "历史存客户端"是对话协议的运行时设计（重启不丢、水平扩展友好），这个保持不变。
 * 落库解决的是另外两件事：
 *   ① 审计与恢复：换设备/清缓存后，对话能从服务端拉回来；
 *   ② interrupt 的上下文兜底：审批 resume 依赖客户端带回完整历史，客户端丢了就断链。
 *
 * ===== 为什么存"每轮 run 的完整快照"而不是逐条 append =====
 * resume 会往 messages 里补写工具结果、重放会复用旧消息——增量存储要自己维护对账逻辑。
 * 快照天然幂等：同一 runId 重复落库直接覆盖，读历史时取该 thread 最新一轮的快照即可。
 * 代价是每轮存一份全量 JSON（单对话几十 KB），对 SQLite 无压力。
 */
const db = require('./db')

const TITLE_MAX = 30

/** 一轮 run 结束（或中断/出错）后落库。同一 runId 重复调用直接覆盖 */
function saveRun({ threadId, runId, userId, messages }) {
  if (!threadId || !runId || !userId) return
  const firstUser = (Array.isArray(messages) ? messages : []).find(m => m?.role === 'user')
  const title = (firstUser ? String(firstUser.content ?? '') : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
  const now = Date.now()
  db.prepare('INSERT INTO threads (id, user_id, title, updated_at) VALUES (?, ?, ?, ?)')
    .run(threadId, userId, title, now)
  // title 只在创建时写：后续轮次的旧消息不该改写首条消息定下的标题
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ? AND updated_at < ?')
    .run(now, threadId, now)
  db.prepare(`
    INSERT INTO thread_runs (run_id, thread_id, user_id, messages, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET messages = excluded.messages, created_at = excluded.created_at
  `).run(runId, threadId, userId, JSON.stringify(messages || []), now)
}

/** 某用户的会话列表，按最近活跃排序 */
function listThreads(userId) {
  return db.prepare(
    'SELECT id, title, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100'
  ).all(userId)
}

/** 取某个会话最新一轮的消息快照；不存在或不属于该用户返回 null */
function getThreadMessages(threadId, userId) {
  const thread = db.prepare('SELECT id FROM threads WHERE id = ? AND user_id = ?').get(threadId, userId)
  if (!thread) return null
  const run = db.prepare(
    'SELECT messages, created_at FROM thread_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(threadId)
  if (!run) return null
  try {
    return { messages: JSON.parse(run.messages), updatedAt: run.created_at }
  } catch {
    return null // 快照损坏时返回 null，让调用方按"没有历史"处理，不让接口 500
  }
}

module.exports = { saveRun, listThreads, getThreadMessages }
