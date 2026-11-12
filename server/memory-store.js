/**
 * memory-store.js —— 跨会话长期记忆的读写
 *
 * ===== 设计取舍 =====
 * ① 只存"一句话事实"，不存对话摘要：摘要体积大、新旧混杂，注入上下文既费 token
 *    又引入噪声；离散事实可以逐条去重、逐条淘汰。
 * ② 去重用"精确匹配"而不是相似度：同一条事实模型大概率原样复述（"用户叫小明"），
 *    精确匹配已经能挡住绝大多数重复；相似度去重要引入 embedding，复杂度不成比例。
 *    真出现措辞不同的重复条目，靠容量淘汰（最旧的先出局）兜底，不追求完美。
 * ③ 容量上限 MEMORY_CAP：记忆是"最近最重要的胜出"——超过上限删最旧的。
 *    长期记忆列表越长注入越贵，且旧记忆对当前对话的帮助递减。
 * ④ 写入走同步 SQLite：单条 INSERT 微秒级，工具 execute 里直接调不用 await。
 */
const db = require('./db')

// 记忆条数上限。50 条 × 平均 20 token ≈ 1000 token 注入开销，可控；
// 想调整走环境变量，不改代码。
const MEMORY_CAP = Number(process.env.MEMORY_CAP || 50)

/** 单条记忆注入上下文的最大长度：防止模型把一大段对话当"事实"整段塞进来 */
const MAX_CONTENT_LEN = 200

/**
 * 写入一条记忆。幂等友好：完全相同的 content 不重复插入。
 * @param {string} userId 归属用户
 * @param {string} content 一句话事实（超长会被截断，避免上下文被撑爆）
 * @returns {{saved: boolean, content: string}} saved=false 表示重复未写入
 */
function addMemory(userId, content) {
  const text = String(content || '').trim().slice(0, MAX_CONTENT_LEN)
  if (!userId || !text) return { saved: false, content: '' }
  const exists = db.prepare('SELECT id FROM user_memory WHERE user_id = ? AND content = ?').get(userId, text)
  if (exists) return { saved: false, content: text }
  db.prepare('INSERT INTO user_memory (user_id, content, created_at) VALUES (?, ?, ?)')
    .run(userId, text, Date.now())
  // 超出上限时淘汰最旧的：记忆是滑动窗口，不是无限增长的历史档案
  db.prepare(`
    DELETE FROM user_memory WHERE user_id = ? AND id NOT IN (
      SELECT id FROM user_memory WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `).run(userId, userId, MEMORY_CAP)
  return { saved: true, content: text }
}

/**
 * 取某用户的全部记忆（按时间正序：早的先说，符合"背景介绍"的阅读习惯）。
 * @param {string} userId
 * @returns {Array<{id: number, content: string, createdAt: number}>}
 */
function listMemories(userId) {
  if (!userId) return []
  return db.prepare('SELECT id, content, created_at AS createdAt FROM user_memory WHERE user_id = ? ORDER BY created_at ASC, id ASC')
    .all(userId)
}

/**
 * 删除一条记忆（前端管理界面/模型修正错误记忆时用）。
 * @param {string} userId 归属校验：只能删自己的
 * @param {number} id
 * @returns {boolean} 是否真的删了
 */
function deleteMemory(userId, id) {
  const info = db.prepare('DELETE FROM user_memory WHERE user_id = ? AND id = ?').run(userId, id)
  return info.changes > 0
}

/** 兜底工具：测试/管理用，给用户一个"忘掉某件事"的口子（按内容精确匹配） */
function forgetMemory(userId, content) {
  const text = String(content || '').trim()
  if (!text) return false
  const info = db.prepare('DELETE FROM user_memory WHERE user_id = ? AND content = ?').run(userId, text)
  return info.changes > 0
}

module.exports = { addMemory, listMemories, deleteMemory, forgetMemory, MEMORY_CAP, MAX_CONTENT_LEN }
