/**
 * branding.js —— 运行时品牌配置（第二阶段「能签」· 品牌与皮肤）
 *
 * ===== 为什么是「运行时配置」而不是「构建期环境变量」 =====
 * 私有化交付的现实是：同一份 Docker 镜像要发给多家客户，每家的产品名、Logo、
 * 登录页文案、行业术语都不一样。如果把品牌写进 Vite 的构建变量，就得为每家客户
 * 重新 build 一次前端、重新打一次几百 MB 的镜像——镜像内容其实只差几个字。
 *
 * 所以这里让品牌信息来自**数据卷里的一个 JSON 文件**：
 *   - 镜像是只读的、全客户通用；branding.json 放在 APP_DATA_DIR（可写卷）里；
 *   - 换品牌 = 改卷里的文件 + 重启，不重建镜像、不动代码、SHA256SUMS 不变；
 *   - 升级镜像时卷不覆盖，客户品牌自动保留。
 *
 * ===== 为什么必须挂在鉴权闸门之前 =====
 * 登录页是用户"还没登录"时看到的第一屏，它要显示客户名与产品名。
 * 如果 /api/branding 需要 token，就变成「没登录 → 拿不到品牌 → 连登录页都不对」的
 * 鸡生蛋问题。因此 index.js 把这个路由挂在 app.use(requireAuth) 之前，
 * 与 /api/health、/api/auth、签名图片 URL 同属公开端点。
 *
 * ===== 公开端点的内容边界（重要） =====
 * 这个接口不需要登录就能读，所以它**只能返回可以印在登录页上的东西**：
 * 产品名、Logo 地址、文案、术语字典、页签开关、以及脱敏后的许可状态。
 * 绝不返回用户数据、密钥、内部路径、文件绝对路径或服务端版本细节。
 * 所有字段走白名单过滤，配置文件里多写的字段会被静默丢弃。
 *
 * ===== 配置来源优先级 =====
 *   1. BRANDING_FILE 环境变量指定的绝对路径（测试/自定义挂载用）
 *   2. APP_DATA_DIR/branding.json（生产默认，位于唯一可写卷内）
 *   3. 两者都不存在 → 用下面的 DEFAULT_BRANDING，产品仍可正常使用
 * 读文件失败（JSON 写错、权限不够）只打中文日志并回退默认值，
 * 绝不因为一个皮肤文件让整个服务起不来。
 */

const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('./paths')
const { getLicensePublic } = require('./license')

/**
 * 默认品牌：既是「没配文件时的可用产品」，也是字段结构的活文档。
 * 客户定制时只需在 branding.json 里写要覆盖的字段，其余自动继承这里的值。
 *
 * terminology 是「行业皮肤」的关键：主对话链与后端工具是行业中立的，HR 只是
 * 默认皮肤。换成企业制度检索场景时，把 candidate/resume/job 改成
 * 「项目 / 制度文档 / 适用部门」之类即可，后端枚举（resume/jd/policy）不动，
 * 因为那是数据模型，不是显示文案。
 */
const DEFAULT_BRANDING = Object.freeze({
  productName: '智能工作助手',
  shortName: '工作助手',
  companyName: '',
  tagline: '支持多轮对话、知识库检索与工具协同的 AI 工作平台',
  loginTitle: '知识库助手',
  loginSubtitle: '登录后进入你的私有知识库',
  registerSubtitle: '创建账号后即可使用',
  footer: '',
  logoUrl: '',
  faviconUrl: '',
  supportUrl: '',
  termsUrl: '',
  privacyUrl: '',
  terminology: Object.freeze({
    candidate: '候选人',
    resume: '简历',
    job: '岗位 JD',
    knowledge: '知识库文档'
  }),
  panels: Object.freeze({
    candidates: true
  })
})

// 允许出现在对外响应里的顶层字段。多写的不转发，避免把内部配置意外泄露给未登录用户。
const STRING_FIELDS = [
  'productName', 'shortName', 'companyName', 'tagline',
  'loginTitle', 'loginSubtitle', 'registerSubtitle', 'footer',
  'logoUrl', 'faviconUrl', 'supportUrl', 'termsUrl', 'privacyUrl'
]
const TERM_FIELDS = ['candidate', 'resume', 'job', 'knowledge']

/**
 * URL 白名单：logoUrl / faviconUrl / 三个协议链接会被前端直接放进 href 或 src。
 * 只允许 http(s)、站内绝对路径与相对路径，挡掉 javascript: / data: 这类
 * 能变成 XSS 的伪协议。品牌文件由客户管理员编辑，但「配置文件被塞恶意字符串」
 * 依然是要防的输入，不能假设它一定可信。
 */
function safeUrl(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (/^(https?:\/\/|\/|\.\/|#)/i.test(s)) return s.slice(0, 500)
  console.warn('[branding] 已忽略不安全的 URL 字段（仅允许 http(s) 或站内路径）:', s.slice(0, 80))
  return ''
}

/** 普通文本字段：截断长度，防止一份超长配置把登录页撑爆或让响应体异常巨大 */
function safeText(value, max = 200) {
  return String(value ?? '').slice(0, max)
}

/**
 * 把用户配置合并进默认配置。
 * 用「显式逐字段取值」而不是 Object.assign，是为了保证返回结构永远固定：
 * 前端可以放心写 branding.terminology.candidate，不用担心某个字段是 undefined。
 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const terminology = src.terminology && typeof src.terminology === 'object' ? src.terminology : {}
  const panels = src.panels && typeof src.panels === 'object' ? src.panels : {}

  const result = {}
  for (const key of STRING_FIELDS) {
    // 有显式覆盖才用覆盖值；没写就继承默认值（空字符串也算显式覆盖，用于隐藏某段文案）
    const value = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : DEFAULT_BRANDING[key]
    result[key] = (key.endsWith('Url') || key === 'logoUrl' || key === 'faviconUrl') && key !== 'companyName'
      ? safeUrl(value)
      : safeText(value)
  }
  result.terminology = {}
  for (const key of TERM_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(terminology, key)
      ? terminology[key]
      : DEFAULT_BRANDING.terminology[key]
    result.terminology[key] = safeText(value, 40) || DEFAULT_BRANDING.terminology[key]
  }
  // panels 用 === false 判断：只有客户明确写 false 才隐藏，写错类型时保持显示，
  // 避免一个手误让功能页签凭空消失、被当成 bug 报上来。
  result.panels = { candidates: panels.candidates !== false }
  return result
}

/** 按优先级找配置文件，返回绝对路径或 null */
function resolveFile() {
  if (process.env.BRANDING_FILE) {
    const p = process.env.BRANDING_FILE
    return path.isAbsolute(p) ? p : path.resolve(__dirname, p)
  }
  return path.join(PATHS.DATA_DIR, 'branding.json')
}

// 进程内缓存：品牌文件在启动后不会频繁变，没必要每个请求都读一次磁盘。
// 提供 reloadBranding() 给运维/测试用；改完文件调它或重启容器即可生效。
let cache = null

function loadBranding() {
  const file = resolveFile()
  let raw = null
  try {
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      console.log('[branding] 已加载品牌配置:', file)
    } else {
      console.log('[branding] 未找到品牌配置，使用内置默认值:', file)
    }
  } catch (err) {
    // 配置写错不该拖垮服务：中文提示 + 回退默认值，前端依然能正常渲染
    console.warn('[branding] 品牌配置读取失败，已回退默认值:', file, err.message)
    raw = null
  }
  cache = normalize(raw)
  return cache
}

/** 返回公开的品牌信息（含脱敏后的许可状态）。首次调用时懒加载。 */
function getBranding() {
  const base = cache || loadBranding()
  // 每次响应都重新取许可状态：到期是按时间推进的，不能缓存成启动那一刻的快照。
  return { ...base, license: getLicensePublic() }
}

/** 重新读取磁盘上的配置文件；返回最新的公开品牌信息 */
function reloadBranding() {
  cache = loadBranding()
  return getBranding()
}

module.exports = { DEFAULT_BRANDING, getBranding, reloadBranding, normalize, resolveFile }
