/**
 * webhook-store.js —— Webhook 事件通知
 *
 * ===== 为什么要有 Webhook =====
 * 现在所有信息都"坐在网页里等人来看"：run 结束了、审批等你确认了，不刷新页面就不知道。
 * Webhook 把方向反过来——服务端主动 POST 到用户注册的 URL，让外部系统（聊天机器人、
 * 自动化脚本、CI）第一时间拿到事件。API Key + OpenAI 端点解决"别人调我们"，
 * Webhook 解决"我们通知别人"，两条方向补齐才算完整的外部集成能力。
 *
 * ===== 安全设计 =====
 * 1. HMAC 签名头（X-Signature）：接收方用注册时拿到的 secret 对请求体做 HMAC-SHA256，
 *    比对签名头即可确认"这确实是我们发的"——裸 HTTP 谁都能伪造 POST。
 * 2. URL 限制：只允许 http/https，且拒绝 localhost / 内网地址。否则用户注册
 *    "http://localhost:3000/api/xxx" 就能让服务端打自己的内网接口（SSRF 经典套路）。
 * 3. 投递 fire-and-forget + 5 秒超时：通知是"锦上添花"，绝不能拖慢对话主流程；
 *    失败只写审计不重试（要可靠投递得上消息队列，那是另一个量级的复杂度，明确不做）。
 */
const crypto = require('node:crypto')
const db = require('./db')
const { recordAudit } = require('./audit')

/** 支持的事件类型白名单：注册时就校验，防止拼错事件名后永远收不到通知还不自知 */
const EVENTS = ['run.finished', 'approval.pending']

db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,           -- 吊销/删除用 id，不暴露 secret
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 归属用户
  url         TEXT NOT NULL,              -- 接收 POST 的地址
  events      TEXT NOT NULL,              -- 订阅的事件，JSON 数组字符串，如 ["run.finished"]
  secret      TEXT NOT NULL,              -- HMAC 签名密钥：创建时生成，注册方保存，用于校验请求真伪
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER                     -- 软禁用时间；NULL = 启用中
);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
`)

/** URL 合法性：协议必须是 http/https，主机名不能是 localhost / 内网 IP / .local 域名（防 SSRF） */
function assertSafeUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error('URL 格式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https 地址')
  }
  const host = url.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    // IPv4 内网段：10.x / 127.x / 192.168.x / 169.254.x（链路本地）/ 172.16~31.x
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    // IPv6 回环与链路本地（::1 / fe80::），URL.hostname 会带方括号，先剥掉
    host.replace(/^\[|\]$/g, '').startsWith('::1') ||
    host.replace(/^\[|\]$/g, '').startsWith('fe80:')
  // 测试后门：E2E 要在本机起接收服务验签名，生产环境绝不设置这个变量。
  // 放环境变量而不是参数：绕过点越少越好，env 是显式声明、启动时可见的
  if (blocked && process.env.WEBHOOK_ALLOW_PRIVATE !== '1') {
    throw new Error('不允许指向本机或内网地址')
  }
  return url.toString()
}

/** 注册 webhook：secret 生成一次返回，之后查不到明文也不需要——它是给接收方校验用的 */
function addWebhook(userId, url, events) {
  const safeUrl = assertSafeUrl(url)
  // events 过滤到白名单内，空数组也允许（等于订阅全部？不——空就是空，明确比隐式全订安全）
  const validEvents = (Array.isArray(events) ? events : []).filter(e => EVENTS.includes(e))
  if (!validEvents.length) throw new Error(`events 必须包含至少一个：${EVENTS.join(' / ')}`)
  const record = {
    id: crypto.randomUUID(),
    url: safeUrl,
    events: validEvents,
    secret: crypto.randomBytes(24).toString('hex'), // 192 位熵，猜测不出，专用于 HMAC
    createdAt: Date.now()
  }
  db.prepare(`
    INSERT INTO webhooks (id, user_id, url, events, secret, created_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(record.id, userId, record.url, JSON.stringify(record.events), record.secret, record.createdAt)
  // secret 只在创建响应里出现一次；丢了只能删掉重建
  return { id: record.id, url: record.url, events: record.events, secret: record.secret }
}

/** 某用户的 webhook 列表（脱敏：不含 secret——签名校验只需要接收方持有 secret） */
function listWebhooks(userId) {
  return db.prepare(`
    SELECT id, url, events, created_at AS createdAt, disabled_at AS disabledAt
    FROM webhooks WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId)
}

/** 删除（硬删：webhook 不像 key 那样需要审计"最后一次使用"，删了就删了） */
function deleteWebhook(userId, webhookId) {
  const result = db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(webhookId, userId)
  return result.changes > 0
}

/**
 * 向某用户的 webhook 投递事件。
 * fire-and-forget：调用方不 await（用 .catch 兜住），通知挂了不影响主流程。
 * @param {string} userId 只投给这个用户注册的 webhook
 * @param {string} event 事件名（如 run.finished）
 * @param {object} payload 事件数据，JSON 序列化后既做请求体也做签名输入
 */
function dispatchWebhook(userId, event, payload) {
  // 查出该用户订阅了这个事件且未禁用的所有 webhook
  const rows = db.prepare('SELECT id, url, secret, events FROM webhooks WHERE user_id = ? AND disabled_at IS NULL').all(userId)
    .filter(row => { try { return JSON.parse(row.events).includes(event) } catch { return false } })
  for (const row of rows) {
    // 投递本身异步执行：不等结果，失败只落审计。
    // 末尾 .catch 必须挂：这是 void 触发的独立 Promise，里面任何异常（包括程序 bug 抛的
    // ReferenceError）都不会有人接——Node 默认会因 unhandledRejection 直接退出整个进程。
    // 这里实际踩过：deliver 里引用了没传进来的变量，通知一触发服务就整体崩溃。
    void deliver(row.id, row.url, row.secret, event, payload, userId).catch(err => {
      console.error('[webhook] 投递异常', { webhookId: row.id, err: err?.message })
    })
  }
}

/**
 * 单次投递：5 秒超时，HMAC 签名头 + 事件名头，结果写审计（成功失败都留痕）。
 * @param {string} webhookId webhook 的 id（进 X-Delivery-Id 头，接收方可定位是哪条）
 * @param {string} url 接收地址
 * @param {string} secret HMAC 签名密钥
 * @param {string} event 事件名
 * @param {object} payload 事件数据
 * @param {string} userId 归属用户（审计记录用）
 */
async function deliver(webhookId, url, secret, event, payload, userId) {
  // body 先定死再签名：签名必须覆盖"实际发送的字节"，先发后签会出现体和签名不一致
  const body = JSON.stringify({ event, payload, timestamp: Date.now() })
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000) // 5 秒拿不到响应就放弃
  const startedAt = Date.now()
  let ok = false
  let detail = ''
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event': event,                          // 接收方路由事件用
        'X-Signature': `sha256=${signature}`,      // GitHub webhook 同款格式，接收方按此校验
        'X-Delivery-Id': webhookId                 // 接收方排查"是哪条 webhook 发的"
      },
      body,
      signal: controller.signal
    })
    ok = res.ok
    detail = `HTTP ${res.status}`
  } catch (err) {
    detail = err?.name === 'AbortError' ? 'timeout(5s)' : (err?.message || 'network error')
  } finally {
    clearTimeout(timer) // 定时器必须清：不清会拖着事件循环不放，进程退不掉
  }
  recordAudit({
    userId,
    action: 'webhook.deliver',
    target: url.slice(0, 120), // URL 截断：审计字段别被超长 URL 撑爆
    detail: { event, ok, detail, ms: Date.now() - startedAt }
  })
}

module.exports = { EVENTS, addWebhook, listWebhooks, deleteWebhook, dispatchWebhook }
