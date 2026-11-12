/**
 * image-store.js —— 会话图片的持久化（磁盘 + SQLite 元数据）
 *
 * ===== 为什么需要它 =====
 * 图片原来只活在两处：session-files 的内存 Map（给视觉模型用）和前端 blob: URL（给气泡展示）。
 * 两处都是进程/页面级状态——刷新页面气泡就变空白，重启服务连模型都看不到图。
 * 所以图片必须落到磁盘，并给前端一个刷新后仍然有效的地址。
 *
 * ===== 为什么不用 data URL 直接塞进消息快照 =====
 * 会话快照是「每轮存一份完整历史」的（threads-store.js），一张 1MB 图 base64 后约 1.4MB，
 * 聊 10 轮就是 14MB 冗余。存文件 + 存一个短 URL，快照里只有几十字节。
 *
 * ===== 图片地址怎么鉴权 =====
 * 前端鉴权走 Authorization 头，但 <img src> 发不了自定义头，所以图片走「签名 URL」：
 *   /api/chat-images/<fileId>?sig=<HMAC(fileId)>
 * 签名用服务端保存的随机密钥（首次启动生成到 data/.image-secret），
 * 因此 fileId 猜不到 + 签名伪造不了，且重启后老图片地址依然有效。
 * 代价：URL 泄漏等于该图泄漏（无过期时间）——对会话缩略图这个级别可以接受，
 * 换来的是"刷新/换设备都能看到图"。要更严可以给 sig 带过期时间戳，但历史消息会失效。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const db = require('./db')

// 图片与签名密钥都放统一数据卷：换容器后老消息里的图片地址仍然有效。
const { PATHS } = require('./paths')
const IMAGE_DIR = PATHS.IMAGE_DIR
const SECRET_FILE = PATHS.IMAGE_SECRET

// 扩展名 ↔ MIME 双向表：上传按 MIME 定扩展名，读取按扩展名回 MIME
const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * 取签名密钥：优先环境变量，其次读磁盘，都没有就生成一份存下来。
 * 必须持久化——每次重启换密钥会让所有历史消息里的图片 403。
 */
function getSecret() {
  if (process.env.IMAGE_SIGN_SECRET) return process.env.IMAGE_SIGN_SECRET
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    const secret = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true })
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
    return secret
  }
}
const SECRET = getSecret()

/**
 * 签名 URL 的有效期（P0）。
 * 0 = 永不过期（默认，保持原有行为：历史消息里的图随时能打开）。
 * 设成 N 天后，新生成的链接会带 exp 时间戳；代价是历史消息里的图过期后会 403，
 * 所以它是一个「安全性 vs 长期可看」的取舍，公网部署再打开，本地别开。
 */
const TTL_DAYS = Math.max(0, Number(process.env.IMAGE_SIGN_TTL_DAYS || 0))

/** 给某个 fileId 算签名（截 32 位足够，URL 短一点）。带 exp 时把 exp 一起签进去，防止被篡改 */
function sign(fileId, exp) {
  const material = exp ? `${fileId}|${exp}` : String(fileId)
  return crypto.createHmac('sha256', SECRET).update(material).digest('hex').slice(0, 32)
}

/** 校验签名：用 timingSafeEqual 避免逐字节比较泄漏信息。exp 可选，没带就按「永不过期」的历史链接处理 */
function verify(fileId, sig, exp) {
  if (!fileId || typeof sig !== 'string' || sig.length !== 32) return false
  // 有 exp 就必须先过有效期，再比签名；顺序反了会给攻击者一个「用过期构造串试签名」的窗口
  if (exp !== undefined && exp !== '') {
    const ts = Number(exp)
    if (!Number.isSafeInteger(ts) || ts <= Date.now()) return false
  }
  const expected = Buffer.from(sign(fileId, exp || undefined))
  const actual = Buffer.from(sig)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/** 可放进 <img src> 的地址（相对路径：前端与 API 同源） */
function urlFor(fileId) {
  if (!TTL_DAYS) return `/api/chat-images/${fileId}?sig=${sign(fileId)}`
  const exp = Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000
  return `/api/chat-images/${fileId}?sig=${sign(fileId, exp)}&exp=${exp}`
}

/**
 * 落盘并记元数据
 * @param {{ fileId: string, userId: string, fileName: string, mime: string, buffer: Buffer }} payload
 * @returns {{ fileId: string, url: string }}
 */
function saveImage({ fileId, userId, fileName, mime, buffer }) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const ext = EXT_BY_MIME[mime] || '.png'
  const filePath = path.join(IMAGE_DIR, `${fileId}${ext}`)
  fs.writeFileSync(filePath, buffer)
  db.prepare(`
    INSERT INTO chat_images (file_id, user_id, file_name, mime, size, path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, userId, fileName, mime, buffer.length, filePath, Date.now())
  return { fileId, url: urlFor(fileId) }
}

/** 元数据（不含内容）；不存在返回 null */
function getImage(fileId) {
  return db.prepare('SELECT * FROM chat_images WHERE file_id = ?').get(fileId) || null
}

/** 读图片字节；文件被手动删掉时返回 null（元数据还在也不算致命） */
function readImage(fileId) {
  const row = getImage(fileId)
  if (!row) return null
  try {
    return { mime: row.mime, buffer: fs.readFileSync(row.path) }
  } catch {
    return null
  }
}

/** 删除图片（磁盘 + 元数据） */
function deleteImage(fileId) {
  const row = getImage(fileId)
  if (!row) return false
  try {
    fs.unlinkSync(row.path)
  } catch {
    // 文件已经不在了：元数据照删，否则会一直留下"有记录没文件"的脏数据
  }
  db.prepare('DELETE FROM chat_images WHERE file_id = ?').run(fileId)
  return true
}

/**
 * 清理过期图片，返回删除条数
 * 与会话 TTL 对齐（默认 30 天）：比会话活得久没意义，只会白占磁盘。
 */
function pruneImages(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const rows = db.prepare('SELECT file_id FROM chat_images WHERE created_at < ?').all(cutoff)
  for (const row of rows) deleteImage(row.file_id)
  return rows.length
}

module.exports = { saveImage, getImage, readImage, deleteImage, pruneImages, urlFor, verify, IMAGE_DIR }
