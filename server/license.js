/**
 * license.js —— 轻量许可校验（第二阶段「能签」· 商业能力最小实现）
 *
 * ===== 这个模块解决什么，不解决什么 =====
 * 解决：交付方能给客户签发一张「谁买的 / 什么版本 / 多少坐席 / 用到哪天」的许可文件，
 *       系统能识别到期与超额，登录页能显示授权状态，必要时可到期停用。
 * 不解决：在线计费、支付、按量出账、防破解 DRM、试用期自动开通。
 *
 * ===== 为什么默认「只提示、不阻断」 =====
 * 这是本阶段最重要的一个取舍。现有部署（本机 pm2、线上 Railway、正在测试的离线包）
 * 都没有 license.json。如果一上线就强制校验，等于把所有没装许可文件的环境全部锁死，
 * 一次误发版本就是全站事故。所以：
 *   - 没配许可文件 / 许可无效 → status 如实反映，但登录照常可用；
 *   - 只有显式设置 LICENSE_ENFORCE=1，才在到期/超额/无效时拒绝「新登录」；
 *   - 即便阻断，也只拦登录与注册，不主动踢掉已经登录的会话，给管理员留处理窗口。
 * 是否启用阻断属于合同口径，由交付方与客户约定后写进 deploy/.env，不写死在代码里。
 *
 * ===== 安全诚实地说明签名 =====
 * 用 HMAC-SHA256 校验许可文件未被改动，密钥 LICENSE_SIGN_SECRET 放在部署环境变量里。
 * 私有化交付下客户能拿到镜像与源码，理论上可以自己算出签名——**这不是防破解方案**，
 * 它的定位是「防止配置文件被误改、以及让交付管理有据可查」。
 * 真正的商业控制靠合同与交付关系，不靠客户端加密。别在销售材料里把它说成 DRM。
 * 没配签名密钥时不做验签，status 标为 unsigned 并给中文提示，仍然不阻断。
 *
 * ===== 文件位置 =====
 * 与品牌配置同理，放在 APP_DATA_DIR（唯一可写卷）里，升级镜像不会覆盖：
 *   LICENSE_FILE 环境变量 > APP_DATA_DIR/license.json
 * 生成工具见 scripts/gen-license.mjs，字段模板见 deploy/license.example.json。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { PATHS } = require('./paths')

/** 到期前多少天开始提示「即将到期」，让客户有续期窗口而不是当天才发现 */
const EXPIRING_DAYS = 30

/** 许可文件里允许出现的业务字段（signature 单列） */
const PAYLOAD_FIELDS = ['customer', 'edition', 'seats', 'issuedAt', 'expiresAt', 'licenseId']

/** 把 payload 规范化成稳定的字符串：排序后再序列化，签名与验签必须用同一份字节 */
function canonical(payload) {
  const obj = {}
  for (const key of PAYLOAD_FIELDS) obj[key] = payload[key] ?? ''
  return JSON.stringify(obj)
}

/** 用部署密钥对 payload 计算 HMAC-SHA256（hex）。供生成工具与服务端共用同一套规则 */
function signPayload(payload, secret) {
  return crypto.createHmac('sha256', String(secret)).update(canonical(payload)).digest('hex')
}

/** 常量时间比较，避免用 === 比较摘要时的时序侧信道（这里风险很低，但写成对的更省事） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function resolveFile() {
  if (process.env.LICENSE_FILE) {
    const p = process.env.LICENSE_FILE
    return path.isAbsolute(p) ? p : path.resolve(__dirname, p)
  }
  return path.join(PATHS.DATA_DIR, 'license.json')
}

/** 读取许可文件原始对象；不存在或读坏了返回 null，调用方决定怎么降级 */
function readLicenseFile() {
  const file = resolveFile()
  try {
    if (!fs.existsSync(file)) return null
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null
  } catch (err) {
    console.warn('[license] 许可文件读取/解析失败，按「无效许可」处理:', file, err.message)
    return { __parseError: err.message }
  }
}

/** 统计当前启用账号数。懒 require('./db')：避免模块加载顺序把数据库连接提前拉起来 */
function countActiveUsers() {
  try {
    const db = require('./db')
    const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE COALESCE(disabled, 0) = 0').get()
    return Number(row?.n || 0)
  } catch (err) {
    // 数据库暂时不可用时不要误判成「超额」，返回 null 表示「不知道」，跳过这一项检查
    console.warn('[license] 坐席数统计失败，本次跳过超额检查:', err.message)
    return null
  }
}

/**
 * 计算完整许可状态。每次调用都重新读盘 + 重新算日期：
 * 到期是按真实时间推进的，缓存成启动那一刻的快照会导致「服务跑过午夜仍认为没到期」。
 */
function evaluate() {
  const enforce = process.env.LICENSE_ENFORCE === '1'
  const raw = readLicenseFile()

  // 没有任何许可文件：试用/未授权模式。默认放行，状态如实暴露给登录页。
  if (!raw || raw.__parseError) {
    return {
      installed: false,
      status: raw?.__parseError ? 'invalid' : 'none',
      enforce,
      customer: '',
      edition: '',
      seats: 0,
      usedSeats: 0,
      expiresAt: '',
      daysLeft: null,
      message: raw?.__parseError
        ? '许可文件无法解析，请检查 JSON 格式'
        : '未安装许可文件（试用 / 未授权模式）',
      blocked: false
    }
  }

  const secret = process.env.LICENSE_SIGN_SECRET
  const signature = String(raw.signature || '')
  const payload = {}
  for (const key of PAYLOAD_FIELDS) payload[key] = raw[key]

  let signatureOk = true
  if (!secret) {
    // 没配密钥就不验签：状态标 unsigned，明确提示「签名未启用」，不假装已校验
    signatureOk = false
  } else if (!signature || !safeEqual(signPayload(payload, secret), signature)) {
    signatureOk = false
  }

  const seats = Math.max(0, Number(payload.seats) || 0)
  const usedSeats = countActiveUsers()
  const overSeats = seats > 0 && usedSeats !== null && usedSeats > seats

  // expiresAt 只接受 YYYY-MM-DD；写错格式视为无效而不是「永不过期」，避免配置手误变成永久授权
  const exp = String(payload.expiresAt || '')
  const validFormat = /^\d{4}-\d{2}-\d{2}$/.test(exp)
  const endOfDay = validFormat ? new Date(`${exp}T23:59:59+08:00`) : null
  const expired = Boolean(endOfDay && !Number.isNaN(endOfDay.getTime()) && Date.now() > endOfDay.getTime())
  const daysLeft = endOfDay && !Number.isNaN(endOfDay.getTime())
    ? Math.ceil((endOfDay.getTime() - Date.now()) / 86400000)
    : null

  let status = 'valid'
  let message = '许可有效'
  if (!secret) {
    status = 'unsigned'
    message = '未配置 LICENSE_SIGN_SECRET，签名校验未启用'
  } else if (!signatureOk) {
    status = 'invalid'
    message = '许可签名不匹配，请核对许可文件与部署密钥'
  } else if (!validFormat) {
    status = 'invalid'
    message = '许可到期日格式应为 YYYY-MM-DD'
  } else if (expired) {
    status = 'expired'
    message = '许可已到期，请联系供应商续期'
  } else if (overSeats) {
    status = 'over_seats'
    message = `启用账号数 ${usedSeats} 已超过许可坐席 ${seats}`
  } else if (daysLeft !== null && daysLeft <= EXPIRING_DAYS) {
    status = 'expiring'
    message = `许可将在 ${daysLeft} 天后到期，请及时续期`
  }

  // 只有「强制模式 + 明确不可用」才阻断。unsigned（没配密钥）不阻断：
  // 那是交付方自己的配置疏漏，不该让客户的员工登不进来。
  const hardStatuses = ['expired', 'invalid', 'over_seats']
  const blocked = enforce && hardStatuses.includes(status)

  return {
    installed: true,
    status,
    enforce,
    customer: String(payload.customer || '').slice(0, 100),
    edition: String(payload.edition || '').slice(0, 40),
    seats,
    usedSeats: usedSeats ?? 0,
    expiresAt: exp,
    daysLeft,
    message,
    blocked
  }
}

/**
 * 给 /api/branding 用的脱敏视图。
 * 故意不返回 signature、licenseId、签名密钥状态细节：登录页只需要「授权给谁、到哪天、
 * 什么状态」。也不要把整个 evaluate() 结果直接丢出去，省得以后加了内部字段被顺手泄露。
 */
function getLicensePublic() {
  const s = evaluate()
  return {
    installed: s.installed,
    status: s.status,
    enforce: s.enforce,
    customer: s.customer,
    edition: s.edition,
    expiresAt: s.expiresAt,
    seats: s.seats,
    usedSeats: s.usedSeats,
    daysLeft: s.daysLeft,
    message: s.message,
    blocked: s.blocked
  }
}

/**
 * 登录闸门中间件。只挂在 /api/auth 上，且只在强制模式下才真正拦请求。
 * 为什么拦在路由之前而不是改 auth.js：登录逻辑本身不该掺进商业条款判断，
 * 将来换掉许可实现时，动这一个中间件即可。
 */
function licenseGate(req, res, next) {
  const state = evaluate()
  if (!state.blocked) return next()
  // 只拦「新登录 / 新注册」。已有 session 的请求不经过这里，不会被踢下线，
  // 管理员仍有机会进去导出数据、处理续期。
  if (req.method === 'POST' && (req.path === '/login' || req.path === '/register')) {
    return res.status(403).json({
      error: `服务许可不可用：${state.message}`,
      licenseStatus: state.status
    })
  }
  next()
}

module.exports = {
  evaluate,
  getLicensePublic,
  licenseGate,
  signPayload,
  canonical,
  resolveFile,
  PAYLOAD_FIELDS
}
