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
const { log } = require('./logger')
const { recordAudit } = require('./audit')

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000 // 30 天
const SCRYPT_KEYLEN = 64

// ============ 限流参数（环境变量可覆盖，测试脚本要能调小） ============
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 5) // 同 IP+用户名连续失败几次锁
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000) // 锁多久
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000) // 失败计数多久自动清零（防止偶发错密码永久累积）
const REGISTER_MAX_PER_HOUR = Number(process.env.REGISTER_MAX_PER_HOUR || 60) // 同 IP 每小时注册上限（对外部署建议调成 5~10）

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
 *
 * ===== 双凭证设计 =====
 * Authorization: Bearer 后面跟两种东西，按前缀分流：
 *   - sk-开头  → API Key（给脚本/程序用，见 api-keys.js）
 *   - 其他     → 登录 session token（给人/浏览器用）
 * 两条路最终都把身份挂到 req.user 上，下游接口不感知凭证类型差异；
 * 需要区分的场景（如 key 管理接口只许本人浏览器操作）读 req.user.authType。
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: '未登录，请先登录' })

  // ---- 分支一：API Key ----
  if (token.startsWith('sk-')) {
    const apiKeyAuth = require('./api-keys') // 函数内 require 避免 auth.js <-> api-keys.js 循环依赖
    const hit = apiKeyAuth.authenticateApiKey(token)
    if (!hit) return res.status(401).json({ error: 'API Key 无效或已吊销' })
    // key 只绑 userId，username 现查一次（审计、日志里都要写用户名）
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(hit.userId)
    if (!user) return res.status(401).json({ error: 'API Key 归属用户不存在' })
    req.user = { userId: user.id, username: user.username, token: null, authType: 'api-key' }
    return next()
  }

  // ---- 分支二：登录 session（原有逻辑不变） ----
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
  req.user = { userId: row.user_id, username: row.username, token, authType: 'session' }
  next()
}

const authRouter = express.Router()

// ============ 限流状态（内存） ============
// 为什么放内存而不是入库：这是"当前这波尝试"的短期状态，进程重启即清空恰好是我们要的
// （否则攻击者故意打满计数、等你重启后还锁着）。代价是多实例不共享——单机够用；
// 真要多实例时换成 Redis 或一张 login_attempts 表，调用点不变。
const attempts = new Map() // `${ip}|${username}` -> { fails, firstAt, lockedUntil }

/** 用户名统一小写：否则换 Baoyu / BAOYU 轮着试就能绕过计数 */
function attemptKey(req, username) {
  return `${req.ip || 'unknown'}|${String(username).toLowerCase()}`
}

/** 清理窗口外的记录，避免 Map 被大量随机用户名撑爆（每个 IP 一次尝试一条） */
function pruneAttempts() {
  const now = Date.now()
  for (const [key, rec] of attempts) {
    if ((!rec.lockedUntil || rec.lockedUntil <= now) && now - rec.firstAt > LOGIN_WINDOW_MS) attempts.delete(key)
  }
}
setInterval(pruneAttempts, 5 * 60 * 1000).unref() // unref：别让定时器拖住进程退出

function retryAfterSeconds(rec) {
  return Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 1000))
}

// 注册按 IP 小时窗口限流：验证脚本一次跑会注册好几个账号，所以上限给得比较宽松，
// 目的是挡住脚本批量刷号，不是挡住正常用户
const registerHits = new Map() // ip -> 时间戳数组
function registerAllowed(ip) {
  const now = Date.now()
  const hits = (registerHits.get(ip) || []).filter(t => now - t < 3600 * 1000)
  registerHits.set(ip, hits)
  return hits.length < REGISTER_MAX_PER_HOUR
}


// 用户名规则收紧：它将来会出现在文件归属、日志里，自由放行会塞进各种脏字符
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/

authRouter.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!registerAllowed(req.ip || 'unknown')) {
    log.warn('[auth] 注册被限流', { ip: req.ip })
    return res.status(429).json({ error: `注册过于频繁，请稍后再试（每小时上限 ${REGISTER_MAX_PER_HOUR} 个）` })
  }
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
  registerHits.get(req.ip || 'unknown')?.push(Date.now())
  recordAudit({ userId: id, actor: username, action: 'auth.register', target: username, ip: req.ip })
  res.json({ ok: true, token: createSession(id), user: { userId: id, username } })
})

authRouter.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const key = attemptKey(req, username)

  // 1) 先看是否在锁定期：锁定期间连正确密码也拒绝，
  //    否则"密码试对了就放行"等于把锁定变成密码校验器，攻击者照样能爆破
  const rec = attempts.get(key)
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    const wait = retryAfterSeconds(rec)
    log.warn('[auth] 登录被拦截（锁定中）', { ip: req.ip, username, retryAfter: wait })
    recordAudit({
      actor: username, action: 'auth.login_blocked', target: username, ip: req.ip,
      detail: { retryAfter: wait, fails: rec.fails }
    })
    res.setHeader('Retry-After', wait)
    return res.status(429).json({ error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` })
  }

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username)
  // 用户不存在和密码错误返回同一句话：提示"用户不存在"等于告诉攻击者哪些用户名是真实的
  if (!user || !verifyPassword(password, user.password_hash)) {
    const now = Date.now()
    const next = rec && now - rec.firstAt <= LOGIN_WINDOW_MS
      ? rec
      : { fails: 0, firstAt: now, lockedUntil: 0 }
    next.fails += 1
    if (next.fails >= LOGIN_MAX_FAILS) {
      next.lockedUntil = now + LOGIN_LOCK_MS
      log.warn('[auth] 登录失败次数超限，已锁定', { ip: req.ip, username, fails: next.fails, lockMs: LOGIN_LOCK_MS })
      recordAudit({
        userId: user?.id, actor: username, action: 'auth.login_locked', target: username, ip: req.ip,
        detail: { fails: next.fails, lockMinutes: Math.round(LOGIN_LOCK_MS / 60000) }
      })
    } else {
      recordAudit({
        userId: user?.id, actor: username, action: 'auth.login_failed', target: username, ip: req.ip,
        detail: { fails: next.fails, remaining: LOGIN_MAX_FAILS - next.fails }
      })
    }
    attempts.set(key, next)
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  // 2) 成功：清掉计数，记一条登录审计
  attempts.delete(key)
  recordAudit({ userId: user.id, actor: user.username, action: 'auth.login', target: user.username, ip: req.ip })
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
