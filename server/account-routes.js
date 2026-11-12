/**
 * account-routes.js —— P2「产品化」账号自助与管理接口
 *
 * ===== 为什么单独做成一个 Router =====
 * 这六个接口都挂在全局鉴权 app.use(requireAuth) 之后，且都只以 req.user 为身份来源。
 * 打包成一个 express.Router() 后，主线程接线只需在 index.js 加两行
 * （顶部 require + 全局鉴权之后一句 app.use('/api', accountRouter)），
 * 不必把六个 app.xxx 散着插进巨型 index.js，也不必改任何一个既有路由。
 * 另一个好处：Router 是纯路由集合、不依赖 index.js 里的任何闭包变量，
 * 可以单独挂到一个最小 Express 实例上写验收测试。
 *
 * ===== 响应风格 =====
 * 与项目其它接口一致：成功 {ok:true, ...}，失败 {error:'中文'}，并配对应 HTTP 状态码。
 *
 * ===== 安全铁律（下面每个 handler 都遵守） =====
 * ① 身份只认全局鉴权注入的 req.user.userId，任何接口都不读 body / query 里的 userId，
 *    导出接口更是完全忽略外部传入的 userId——从根上掐断「导出别人数据」的越权路径；
 * ② 所有 SQL 参数化，:id / :threadId 这类不可信输入只作为占位符参数传给 prepare，
 *    绝不拼进 SQL 字符串（顺带连 SQL 注入一起挡住）；
 * ③ 管理接口的角色校验写在 Router 内部（index.js 的 requireAdmin 未导出，不能依赖它）：
 *    role === 'admin' 且 authType === 'session'，任一不满足返回 403 JSON；禁止操作自己；
 * ④ 改密码 / 停用 / 删除 / 导出这类敏感动作都写审计（recordAudit），便于事后追溯。
 *
 * ===== 关于文档接口（重要） =====
 * /api/documents 与 /api/documents/delete 仍归 index.js（主线程负责改），
 * 本文件刻意不实现，避免与 index.js 里的同名路由冲突。
 * 向量层的 fileId 能力由 rag-vector.js 提供，见《P2后端-接线说明.md》。
 */
const express = require('express')
const db = require('./db')
const { hashPassword, verifyPassword } = require('./auth') // 复用同一套 scrypt 哈希/校验，不另写一份
const { recordAudit } = require('./audit')
const { listMemories, deleteMemory } = require('./memory-store') // 记忆读写直接复用现成函数
const { deleteThread, exportUserData } = require('./threads-store') // 会话删除/数据导出收口在 store 层

const accountRouter = express.Router()

// ---------------------------------------------------------------------------
// 1) 修改密码：校验旧密码 → 校验新密码长度 → 写新哈希 → 撤销其它 session
// ---------------------------------------------------------------------------
accountRouter.post('/account/password', (req, res) => {
  try {
    // 身份只认 req.user，绝不采信 body 里可能伪造的 userId
    const userId = req.user.userId
    const oldPassword = String(req.body?.oldPassword ?? '')
    const newPassword = String(req.body?.newPassword ?? '')

    // 新密码长度先判：纯内存校验、不查库，放最前面最省；至少 8 位是产品化后的下限
    if (newPassword.length < 8) {
      return res.status(400).json({ error: '新密码至少 8 位' })
    }

    // 取当前哈希校验旧密码。verifyPassword / hashPassword 复用 auth.js：
    // scrypt 参数与存储格式都只有一处定义，避免两处实现漂移导致「改完登不进去」
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)
    if (!row) return res.status(404).json({ error: '用户不存在' })
    if (!verifyPassword(oldPassword, row.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' })
    }

    // 覆盖写新哈希：只动 password_hash 一列，用户名 / 角色 / 停用状态都不碰
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(newPassword), userId)

    // 撤销该用户「其它」session，保留本次请求用的 token：
    // 其它设备/标签页立即被挤下线要重新登录，而当前页面不掉线——这正是改密码的预期行为。
    // 两条 SQL 都参数化；token 取自服务端注入的 req.user.token，不是用户输入。
    const currentToken = req.user.token
    if (currentToken) {
      // session 登录：按 user_id 删，用 token <> ? 排除当前这一个
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, currentToken)
    } else {
      // API Key 登录没有可保留的 session token（req.user.token 为 null）：
      // 若直接套上面那条，SQLite 里 token <> NULL 恒不为真、一条都删不掉，
      // 会留下「用 key 改了密码、旧浏览器登录态还活着」的半吊子状态，所以这里撤全部 session
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    }

    recordAudit({
      userId, actor: req.user.username, action: 'account.password_change',
      target: req.user.username, detail: { otherSessionsRevoked: true }, ip: req.ip
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('修改密码失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// 2) 导出个人数据：JSON 文件下载（Content-Disposition: attachment）
// ---------------------------------------------------------------------------
accountRouter.get('/account/export', (req, res) => {
  try {
    // 只用 req.user.userId：body / query 里的 userId 一概不读，
    // 前端就算伪造 {userId:'别人的id'} 也只会导出自己的数据
    const data = exportUserData(req.user.userId)
    // 数据已在内存里成型，此时再写审计不会污染本次导出内容（快照已取完）
    recordAudit({
      userId: req.user.userId, actor: req.user.username, action: 'account.export',
      target: req.user.username, ip: req.ip
    })

    // 文件名只用纯 ASCII 时间戳：不把 username 拼进响应头，防特殊字符造成头注入
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    // attachment 让浏览器当作文件下载，而不是在标签页里直接渲染一大坨 JSON
    res.setHeader('Content-Disposition', `attachment; filename="account-export-${stamp}.json"`)
    // 手写 stringify 并带缩进：下载下来就是可读的格式化 JSON，人能直接打开核对
    res.send(JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('导出账号数据失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// 3) 长期记忆：列表
// ---------------------------------------------------------------------------
accountRouter.get('/memory', (req, res) => {
  try {
    // 直接复用 memory-store 现成的 listMemories(userId)：它已按 user_id 过滤、
    // 按时间正序返回 [{id, content, createdAt}]，正好是契约要的结构，不重写查询
    const data = listMemories(req.user.userId)
    res.json({ ok: true, data })
  } catch (err) {
    console.error('读取记忆失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// 4) 长期记忆：删除单条
// ---------------------------------------------------------------------------
accountRouter.delete('/memory/:id', (req, res) => {
  try {
    // deleteMemory(userId, id) 内部把 user_id 一起写进 WHERE，别人的 id 传进来也删不动。
    // :id 来自 URL（不可信），作为参数传给参数化 SQL，绝不拼字符串。
    const ok = deleteMemory(req.user.userId, req.params.id)
    // 404 同时覆盖「不存在」与「不属于你」：不区分，避免泄露记忆 id 的存在性
    if (!ok) return res.status(404).json({ error: '记忆不存在或无权删除' })
    recordAudit({
      userId: req.user.userId, actor: req.user.username, action: 'account.memory_delete',
      target: req.params.id, ip: req.ip
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('删除记忆失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// 5) 会话：删除（按 userId 校验归属）
// ---------------------------------------------------------------------------
accountRouter.delete('/threads/:threadId', (req, res) => {
  try {
    // deleteThread 把归属校验写进 DELETE 的 WHERE（id = ? AND user_id = ?）并返回删除条数，
    // thread_runs 借外键 ON DELETE CASCADE 连带清理，不会留孤儿快照
    const removed = deleteThread(req.params.threadId, req.user.userId)
    // 0 条 = 不存在或不属于该用户，统一给 404，不泄露会话是否存在
    if (!removed) return res.status(404).json({ error: '会话不存在或无权删除' })
    recordAudit({
      userId: req.user.userId, actor: req.user.username, action: 'account.thread_delete',
      target: req.params.threadId, ip: req.ip
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('删除会话失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// 6) 管理员：停用 / 启用某个账号
// ---------------------------------------------------------------------------
accountRouter.patch('/admin/users/:id/status', (req, res) => {
  // admin 校验写在 Router 内部（index.js 的 requireAdmin 未导出，不能依赖它）。
  //   ① role === 'admin'；② authType === 'session' —— 管理动作必须可追溯到
  //      「浏览器里那个人」，与 index.js 现有 /api/admin/* 接口完全同一口径，
  //      API Key 即使是 admin 签发的也不给管理权限（封住 key 泄露的爆炸半径）。
  // 用可选链兜底：万一漏挂全局鉴权，也会因 role 不是 admin 落到 403，不会放行。
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' })
  if (req.user?.authType !== 'session') return res.status(403).json({ error: '管理操作请用网页登录后进行' })

  try {
    const { disabled } = req.body || {}
    if (typeof disabled !== 'boolean') {
      return res.status(400).json({ error: 'disabled 必须是布尔值' })
    }
    const targetId = req.params.id
    // 禁止操作自己：把自己停用会立刻把自己锁在系统外（后续连解封都得换号），
    // 这类「自锁」没有正当场景，直接挡掉；启用自己也一并禁止，语义更干净
    if (targetId === req.user.userId) {
      return res.status(400).json({ error: '不能停用或启用自己' })
    }
    // 只更新 disabled 一列，参数化；:id 不拼进 SQL。列是 INTEGER，布尔落成 1 / 0
    const info = db.prepare('UPDATE users SET disabled = ? WHERE id = ?')
      .run(disabled ? 1 : 0, targetId)
    if (!info.changes) return res.status(404).json({ error: '用户不存在' })

    recordAudit({
      userId: req.user.userId, actor: req.user.username,
      action: disabled ? 'admin.user_disable' : 'admin.user_enable',
      target: targetId, detail: { disabled }, ip: req.ip
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('设置用户停用状态失败', err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = { accountRouter }
