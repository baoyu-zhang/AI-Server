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
function saveRun({ threadId, runId, userId, messages, state }) {
  if (!threadId || !runId || !userId) return
  const firstUser = (Array.isArray(messages) ? messages : []).find(m => m?.role === 'user')
  const title = (firstUser ? String(firstUser.content ?? '') : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
  const now = Date.now()
  // 线程 id 由客户端生成：若已被别人占用，直接放弃本次落库。
  // 不写比"写进别人会话"安全——getThreadMessages 按归属过滤，混写会让会话主人读到他人消息
  const owner = db.prepare('SELECT user_id FROM threads WHERE id = ?').get(threadId)
  if (owner && owner.user_id !== userId) return
  // 同一线程的第二轮起必须 UPSERT：threadId 持久化后（刷新继续同一线程）这是常态，
  // 之前裸 INSERT 会撞主键、整段 saveRun 抛异常被上层 catch 吞掉——表现就是"聊了但没存"
  db.prepare(`
    INSERT INTO threads (id, user_id, title, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(threadId, userId, title, now)
  db.prepare(`
    INSERT INTO thread_runs (run_id, thread_id, user_id, messages, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      messages = excluded.messages, state = excluded.state, created_at = excluded.created_at
  `).run(runId, threadId, userId, JSON.stringify(messages || []), JSON.stringify(state || {}), now)
}

/**
 * 某用户的会话列表，按最近活跃排序
 *
 * 除标题外多返回 preview（最后一条用户消息）与 turnCount：
 * 标题在创建时就定死为首条消息，长会话聊了十几轮标题还是第一句，
 * 下拉里全是「你好」「几点」分不清谁是谁——用户在界面上会以为"最新会话没进列表"。
 */
function listThreads(userId) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.updated_at,
           (SELECT r.messages FROM thread_runs r
             WHERE r.thread_id = t.id
             ORDER BY r.created_at DESC LIMIT 1) AS snapshot
    FROM threads t
    WHERE t.user_id = ?
    ORDER BY t.updated_at DESC
    LIMIT 100
  `).all(userId)

  return rows.map(row => {
    let preview = ''
    let turnCount = 0
    try {
      const msgs = JSON.parse(row.snapshot || '[]')
      if (Array.isArray(msgs)) {
        turnCount = msgs.filter(m => m?.role === 'user').length
        const lastUser = [...msgs].reverse().find(m => m?.role === 'user')
        preview = String(lastUser?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      }
    } catch {
      // 快照损坏只影响预览，不影响列表本身
    }
    return { id: row.id, title: row.title, updated_at: row.updated_at, preview, turnCount }
  })
}

/** 取某个会话最新一轮的消息快照与共享状态；不存在或不属于该用户返回 null */
function getThreadMessages(threadId, userId) {
  const thread = db.prepare('SELECT id FROM threads WHERE id = ? AND user_id = ?').get(threadId, userId)
  if (!thread) return null
  const run = db.prepare(
    'SELECT messages, state, created_at FROM thread_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(threadId)
  if (!run) return null
  try {
    // state 与 messages 配套：恢复历史时前端用它重建共享状态，
    // 下一轮请求照常回传，引用来源等跨轮信息不会因为换设备/清缓存而丢
    return { messages: JSON.parse(run.messages), state: JSON.parse(run.state || '{}'), updatedAt: run.created_at }
  } catch {
    return null // 快照损坏时返回 null，让调用方按"没有历史"处理，不让接口 500
  }
}

// ============================================================================
// P2「产品化」新增：账号自助能力（删会话 / 导出个人数据）
//
// 为什么这两个函数放在 threads-store 而不是各自写在路由里：
//   ① 它们都要读多张以 userId 为锚点的表，跟已有 saveRun / listThreads / getThreadMessages
//      是同一类「会话落库」代码，放一起复用同一个 db 句柄与代码风格；
//   ② 路由层只负责 HTTP（取 req.user、拼响应、设下载头），SQL 全部收口在这里，
//      方便单独测，也保证「所有查询都带 userId」这条安全约束只看一个文件就能审。
//
// 安全铁律（导出接口是越权高发区，下面每一行都照此实现）：
//   - 所有 SQL 参数化，绝不把 threadId / id 拼进字符串；
//   - 所有查询都带 userId 过滤；profile 用列白名单 SELECT，物理上带不出 password_hash；
//   - audit 只取「关于自己」的记录（user_id=自己 OR actor=自己用户名），
//     与 audit.js 的 listAudit 同一口径，不把别人的审计行带出来。
// ============================================================================

/**
 * 删除某个会话（连同它下面每轮的消息快照）。
 *
 * 归属校验直接写进 DELETE 的 WHERE：id = ? AND user_id = ?，两步合一——
 * 「先 SELECT 校验再 DELETE」如果没有事务会留竞态窗口，而且多一次查询。
 * B 用户就算猜到 A 的 threadId 也匹配不到任何行 → changes=0，天然不越权。
 * thread_runs 借外键 ON DELETE CASCADE 连带清理（db.js 已开 PRAGMA foreign_keys=ON），
 * 不用手动删两遍，也不会留下孤儿快照。
 *
 * @param {string} threadId 会话 id（AG-UI 的 threadId，来自 URL，属不可信输入）
 * @param {string} userId   归属用户（来自 req.user.userId，绝不接受 body 传入）
 * @returns {number} 实际删掉的会话数；0 = 不存在或不属于该用户
 */
function deleteThread(threadId, userId) {
  // 两个参数都做空值兜底：缺一个就不执行 DELETE（SQL 里 user_id = NULL 本来就匹配不到，
  // 但提前返回语义更清楚，也避免把 undefined 传进 prepare）
  if (!threadId || !userId) return 0
  const info = db.prepare('DELETE FROM threads WHERE id = ? AND user_id = ?').run(threadId, userId)
  return info.changes
}

/**
 * 导出某用户的全部个人数据（「带走我的数据」）。
 *
 * 返回结构：
 *   {
 *     profile:  { id, username, role, createdAt } | null,
 *     threads:  [ { id, title, updatedAt, runs: [ { runId, messages, state, createdAt } ] } ],
 *     memories: [ { id, content, createdAt } ],
 *     usage:    [ { id, threadId, runId, model, inputTokens, outputTokens, totalTokens, steps, createdAt } ],
 *     audit:    [ { id, userId, actor, action, target, detail, ip, createdAt } ]
 *   }
 *
 * 刻意不导出：password_hash（列白名单挡住）、token / session / api_key
 * （这些表的哈希/明文列根本没被查，且全部按 userId 圈定）、其它用户的数据
 * （每张表都 WHERE user_id = ?，审计另加 actor 归属判断）。
 *
 * 为什么把每轮 messages 从 JSON 字符串 parse 成数组再导出：这是给人看的下载文件，
 * 解析成真正的 JSON 结构才可用；单条快照损坏时按空数组兜底，不让一条脏数据
 * 把整个导出拖成 500。
 *
 * @param {string} userId 归属用户（调用方只传 req.user.userId）
 * @returns {object} 见上
 */
function exportUserData(userId) {
  // userId 缺失时返回结构完整的空导出，避免调用方拿到 undefined 再自己兜底
  if (!userId) return { profile: null, threads: [], memories: [], usage: [], audit: [] }

  // ① profile：列白名单，只给 id / username / role / createdAt，
  //    绝不含 password_hash，也不含 disabled 等内部状态列
  const profile = db.prepare(
    'SELECT id, username, role, created_at AS createdAt FROM users WHERE id = ?'
  ).get(userId) || null

  // ② threads 列表 + 每轮 run 的 messages / state 快照
  //    一次性把该用户所有 run 取出来再按 threadId 分组，避免「每个会话查一次」的 N+1
  const threadRows = db.prepare(
    'SELECT id, title, updated_at AS updatedAt FROM threads WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(userId)
  const runs = db.prepare(
    `SELECT thread_id AS threadId, run_id AS runId, messages, state, created_at AS createdAt
       FROM thread_runs WHERE user_id = ? ORDER BY created_at ASC, run_id ASC`
  ).all(userId)
  const runsByThread = new Map()
  for (const run of runs) {
    let messages = []
    let state = {}
    try { messages = JSON.parse(run.messages || '[]') } catch { /* 损坏快照按空数组 */ }
    try { state = JSON.parse(run.state || '{}') } catch { /* 损坏状态按空对象 */ }
    const item = { runId: run.runId, messages, state, createdAt: run.createdAt }
    if (!runsByThread.has(run.threadId)) runsByThread.set(run.threadId, [])
    runsByThread.get(run.threadId).push(item)
  }
  const threads = threadRows.map(t => ({
    id: t.id,
    title: t.title,
    updatedAt: t.updatedAt,
    runs: runsByThread.get(t.id) || [] // 没有 run 的会话（异常数据）也给空数组，结构统一
  }))

  // ③ 跨会话长期记忆
  const memories = db.prepare(
    'SELECT id, content, created_at AS createdAt FROM user_memory WHERE user_id = ? ORDER BY created_at ASC, id ASC'
  ).all(userId)

  // ④ 模型用量明细（成本/账单一并带走）
  const usage = db.prepare(
    `SELECT id, thread_id AS threadId, run_id AS runId, model,
            input_tokens AS inputTokens, output_tokens AS outputTokens,
            total_tokens AS totalTokens, steps, created_at AS createdAt
       FROM model_usage WHERE user_id = ? ORDER BY created_at ASC, id ASC`
  ).all(userId)

  // ⑤ 审计：只取「关于自己」的记录（user_id=自己 OR actor=自己用户名）。
  //    与 listAudit 同口径：登录失败/锁定发生在认证前，那时 user_id 为空、只有 actor，
  //    靠 actor 匹配用户才能看到「有人在试我的密码」这类记录。用户名在库里唯一，
  //    actor 匹配不会串到别人；username 为空时用 (? IS NOT NULL AND ...) 守卫，
  //    避免 actor = NULL 退化成恒假/误匹配。
  const username = profile?.username || null
  const audit = db.prepare(
    `SELECT id, user_id AS userId, actor, action, target, detail, ip, created_at AS createdAt
       FROM audit_log
      WHERE user_id = ? OR (? IS NOT NULL AND actor = ?)
      ORDER BY created_at ASC, id ASC`
  ).all(userId, username, username)

  return { profile, threads, memories, usage, audit }
}

module.exports = { saveRun, listThreads, getThreadMessages, deleteThread, exportUserData }
