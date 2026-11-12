/**
 * auth.js —— 注册 / 登录 / 会话校验
 *
 * ===== 为什么是"库里的 opaque token"而不是 JWT =====
 * JWT 的唯一好处是免查库，代价是签发后无法撤销——登出、封号都拦不住已发的 token。
 * 内部工具的正确取舍是反过来的：每次请求查一次 SQLite（微秒级），换"登出立即生效"。
 * 也不用引入 jsonwebtoken 依赖，签发就是 crypto.randomBytes 一行。
 *
 * ===== 密码为什么用 scrypt =====
 * Node 内置，专为密码设计（内存难拟合，抗 GPU 暴力破解）；bcrypt/argon2 都要装原生依赖。
 * 存储格式 `scrypt$<salt>$<hash>`：将来升级参数（加大 N）时还能识别旧格式做迁移。
 * 比对必须用 timingSafeEqual——逐字节提前返回的 === 会被计时攻击逐位猜出来。
 */
const crypto = require('node:crypto')
const express = require('express')
const db = require('./db')

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000 // 30 天
const SCRYPT_KEYLEN = 64

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  // 长度不一致时 timingSafeEqual 会抛异常，先判长度再比
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

/** 创建登录会话，返回给客户端的 token */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + TOKEN_TTL_MS)
  return token
}

/** 登出：删掉会话行，token 立即失效 */
function revokeSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/**
 * 鉴权中间件：所有业务端点的闸门。
 * 挂载顺序是关键——必须放在 /api/auth 路由之后，登录接口本身不能要求已登录。
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: '未登录，请先登录' })
  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.id AS user_id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token)
  if (!row) return res.status(401).json({ error: '登录状态无效，请重新登录' })
  if (row.expires_at < Date.now()) {
    revokeSession(token) // 过期顺手清掉，不留给定时任务
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
  req.user = { userId: row.user_id, username: row.username, token }
  next()
}

const authRouter = express.Router()

// 用户名规则收紧：它将来会出现在文件归属、日志里，自由放行会塞进各种脏字符
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/

authRouter.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字、_ 或 -，长度 3~32' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' })
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) return res.status(409).json({ error: '用户名已被占用' })
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, hashPassword(password), Date.now())
  res.json({ ok: true, token: createSession(id), user: { userId: id, username } })
})

authRouter.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username)
  // 用户不存在和密码错误返回同一句话：提示"用户不存在"等于告诉攻击者哪些用户名是真实的
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  res.json({ ok: true, token: createSession(user.id), user: { userId: user.id, username: user.username } })
})

authRouter.post('/logout', (req, res) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token) revokeSession(token)
  res.json({ ok: true })
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: { userId: req.user.userId, username: req.user.username } })
})

module.exports = { authRouter, requireAuth, hashPassword, verifyPassword, createSession, revokeSession }
