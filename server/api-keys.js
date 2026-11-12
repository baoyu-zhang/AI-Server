/**
 * api-keys.js —— API Key 签发与校验
 *
 * ===== 为什么要有 API Key =====
 * 登录 session 是给"人 + 浏览器"用的：30 天过期、登出即失效，但脚本/第三方程序
 * 拿它当凭证很别扭（登录态和浏览器互相挤下线、过期就要重新走登录流程）。
 * API Key 是给"程序"用的长期凭证：不自动过期、可随时吊销、每次使用都更新 last_used_at，
 * 这样能看出哪些 key 还活着、哪些该清理了。
 *
 * ===== 安全设计（三件事都是刻意的） =====
 * 1. 明文只在创建响应里出现一次：库里只存 SHA256 哈希 + 前 12 位前缀。
 *    前缀用来在列表里认出"这是哪把 key"，哈希用来校验请求。库被拖走也拿不到明文。
 * 2. 哈希用 SHA256 而不是 scrypt：scrypt 慢是防"低熵密码被爆破"，而 API Key 是
 *    256 位随机数，本身就爆破不动，用慢哈希只是白烧 CPU。高熵凭证用快哈希是标准做法。
 * 3. 吊销是软删除（revoked_at 打时间戳）而不是 DELETE：留着记录才能审计
 *    "这把 key 最后一次用是什么时候、吊销前干过什么"。
 */
const crypto = require('node:crypto')
const db = require('./db')

/** 明文 key 的固定前缀：客户端一眼识别凭证类型，也让鉴权中间件能分流"session 还是 key" */
const KEY_PREFIX = 'sk-'

db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,          -- key 的唯一 id（吊销/查询用它，不用明文也不用哈希当 id）
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 归属用户：用户删号时 key 级联清掉
  name         TEXT NOT NULL DEFAULT '',  -- 用户自己起的备注名，如"curl 脚本""CI 部署"
  key_prefix   TEXT NOT NULL,             -- 明文前 12 位（sk- + 8 位随机）：列表展示用，凭这个认 key
  key_hash     TEXT NOT NULL UNIQUE,      -- 完整明文的 SHA256 hex：校验请求用，库里没有明文
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,                   -- 最后一次成功鉴权的时间；NULL = 从没用过
  revoked_at   INTEGER                    -- 吊销时间；NULL = 仍然有效
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
`)

/**
 * 签发一把新 key。
 * 返回 { key, record }：key 是完整明文，只此一次——响应结束后任何地方都查不到它了。
 */
function createApiKey(userId, name = '') {
  // 32 字节 = 256 位熵，hex 编码 64 字符。加 sk- 前缀共 67 位，肉眼可辨凭证类型
  const plain = KEY_PREFIX + crypto.randomBytes(32).toString('hex')
  const record = {
    // id 用随机 UUID：不用哈希当 id，因为哈希在请求校验时是查询条件，双重身份容易混淆
    id: crypto.randomUUID(),
    name: String(name).slice(0, 64),           // 备注名限长，防止塞超长字符串
    keyPrefix: plain.slice(0, 12),             // sk- + 8 位随机数，足够认出是哪把
    createdAt: Date.now(),
    revokedAt: null
  }
  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(record.id, userId, record.name, record.keyPrefix, sha256(plain), record.createdAt)
  return { key: plain, record }
}

/** SHA256 hex：API Key 专用哈希（高熵凭证用快哈希即可，理由见文件头注释） */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** 列出某个用户的所有 key（脱敏：只有前缀，没有哈希更没有明文） */
function listApiKeys(userId) {
  return db.prepare(`
    SELECT id, name, key_prefix AS keyPrefix, created_at AS createdAt,
           last_used_at AS lastUsedAt, revoked_at AS revokedAt
    FROM api_keys WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId)
}

/** 吊销：只允许操作自己的 key（userId 作为 WHERE 条件，别人的 id 传进来也匹配不到） */
function revokeApiKey(userId, keyId) {
  // revoked_at IS NULL：重复吊销不刷新时间，保留第一次吊销的真实时间点
  const result = db.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  ).run(Date.now(), keyId, userId)
  return result.changes > 0 // changes=0 说明 key 不存在、不是你的、或已吊销——对调用方统一按失败处理
}

/**
 * 用明文 key 换用户身份。请求侧每来一个 sk- 开头的 Bearer 都会走到这里。
 * 命中有效 key 时顺手更新 last_used_at——这是"活钥匙探测"，列表页靠它判断哪把还在用。
 * 返回 { userId } 或 null（不存在 / 已吊销 / 哈希对不上）。
 */
function authenticateApiKey(plain) {
  if (!plain || !plain.startsWith(KEY_PREFIX)) return null
  const row = db.prepare(
    'SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = ?'
  ).get(sha256(plain))
  if (!row) return null                        // 库里没这把 key
  if (row.revoked_at) return null              // 吊销过的 key 立即失效，不留缓冲期
  // last_used_at 更新失败不影响鉴权结果（计数器坏了不该把人锁在门外）
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id)
  return { userId: row.user_id }
}

module.exports = { createApiKey, listApiKeys, revokeApiKey, authenticateApiKey }
