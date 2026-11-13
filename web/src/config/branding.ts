/**
 * branding.ts —— 前端品牌配置的单一来源（第二阶段「能签」· 品牌与皮肤）
 *
 * ===== 设计要点 =====
 * 1) 一份镜像发多家客户：品牌不写死在组件里，也不做构建期变量，而是启动时
 *    从后端公开接口 GET /api/branding 拉取。后端读的是数据卷里的 branding.json，
 *    换客户只需改卷里的文件 + 重启，前端产物一行不用动。
 * 2) 响应式单例：用 Vue reactive 包一个对象，组件里直接 `branding.productName`，
 *    配置晚到或运维重新加载时界面会跟着变，不用在每个组件里写 props / provide。
 * 3) 失败必须降级：品牌接口挂了、超时、返回怪东西，都只影响「显示叫什么」，
 *    绝不能让聊天界面白屏。所以内置一份完整默认值，加载失败静默沿用。
 * 4) 公开接口不可信到什么程度：它是未登录可读的，虽然服务端已做字段白名单与
 *    URL 协议过滤，前端仍只按白名单取字段，不把整个响应 Object.assign 进单例，
 *    避免以后服务端多返回一个字段就把奇怪的行为带进 UI。
 *
 * ===== 怎么用 =====
 *   import { branding, term } from '../config/branding'
 *   <h1>{{ branding.productName }}</h1>
 *   <t-tab-panel :label="term('candidate')">
 * 术语字典 term() 只改「界面显示文字」；后端枚举（resume / jd / policy）、工具名、
 * 数据库字段一律不动——那是数据模型，改了会真出 bug。换行业时改字典即可。
 */

import { reactive } from 'vue'

/** 行业术语字典。HR 是默认皮肤，不是硬编码在系统里的业务前提 */
export interface Terminology {
  candidate: string
  resume: string
  job: string
  knowledge: string
}

/** 登录页可见的脱敏许可状态。刻意不含 signature / licenseId / 签名密钥信息 */
export interface LicensePublic {
  installed: boolean
  status: string
  enforce: boolean
  customer: string
  edition: string
  seats: number
  usedSeats: number
  expiresAt: string
  daysLeft: number | null
  message: string
  blocked: boolean
}

export interface Branding {
  productName: string
  shortName: string
  companyName: string
  tagline: string
  loginTitle: string
  loginSubtitle: string
  registerSubtitle: string
  footer: string
  logoUrl: string
  faviconUrl: string
  supportUrl: string
  termsUrl: string
  privacyUrl: string
  terminology: Terminology
  panels: { candidates: boolean }
  license: LicensePublic
}

/** 与 server/branding.js 的 DEFAULT_BRANDING 保持一致：后端没响应时用这份 */
export const DEFAULT_BRANDING: Branding = {
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
  terminology: { candidate: '候选人', resume: '简历', job: '岗位 JD', knowledge: '知识库文档' },
  panels: { candidates: true },
  license: {
    installed: false,
    status: 'none',
    enforce: false,
    customer: '',
    edition: '',
    seats: 0,
    usedSeats: 0,
    expiresAt: '',
    daysLeft: null,
    message: '',
    blocked: false
  }
}

// 浅拷贝每一层，防止默认值对象被响应式代理改写后污染常量本身
export const branding = reactive<Branding>({
  ...DEFAULT_BRANDING,
  terminology: { ...DEFAULT_BRANDING.terminology },
  panels: { ...DEFAULT_BRANDING.panels },
  license: { ...DEFAULT_BRANDING.license }
})

// 与后端同样的白名单。顺序无关，只是明确「除了这些字段一律不接收」。
const TEXT_FIELDS: (keyof Omit<Branding, 'terminology' | 'panels' | 'license'>)[] = [
  'productName', 'shortName', 'companyName', 'tagline',
  'loginTitle', 'loginSubtitle', 'registerSubtitle', 'footer',
  'logoUrl', 'faviconUrl', 'supportUrl', 'termsUrl', 'privacyUrl'
]
const TERM_KEYS: (keyof Terminology)[] = ['candidate', 'resume', 'job', 'knowledge']
const LICENSE_FIELDS: (keyof LicensePublic)[] = [
  'installed', 'status', 'enforce', 'customer', 'edition',
  'seats', 'usedSeats', 'expiresAt', 'daysLeft', 'message', 'blocked'
]

/** 读取一个术语；字典缺项时回退默认值，界面不会出现 undefined */
export function term(key: keyof Terminology): string {
  return branding.terminology[key] || DEFAULT_BRANDING.terminology[key]
}

/** 把品牌写进文档头：标签页标题、description、favicon。留空时保持 index.html 的默认值 */
function applyDocumentMeta(): void {
  if (branding.productName) document.title = branding.productName
  if (branding.tagline) {
    const meta = document.querySelector('meta[name="description"]')
    if (meta) meta.setAttribute('content', branding.tagline)
  }
  if (branding.faviconUrl) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = branding.faviconUrl
  }
}

/**
 * 启动时拉一次品牌配置。
 * 用 AbortController 给 2 秒上限：品牌接口在鉴权之前、逻辑极轻，正常是毫秒级；
 * 万一后端卡住，也不能让登录页一直空白地等它。
 * 这个函数**永不抛错**：所有异常都降级为默认品牌，由调用方 .finally() 里正常 mount。
 */
export async function loadBranding(): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch('/api/branding', { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return
    const src = data as Record<string, unknown>

    // 先攒进普通对象再 Object.assign：直接写 `(branding[key] as string) = v`
    // 在 TS 里不是合法的赋值目标（断言表达式不能放等号左边），也会绕过白名单意图。
    const picked: Record<string, unknown> = {}
    for (const key of TEXT_FIELDS) {
      const value = src[key]
      if (typeof value === 'string') picked[key] = value
    }
    Object.assign(branding, picked)

    const terminology = src.terminology
    if (terminology && typeof terminology === 'object') {
      for (const key of TERM_KEYS) {
        const value = (terminology as Record<string, unknown>)[key]
        if (typeof value === 'string' && value) branding.terminology[key] = value
      }
    }
    const panels = src.panels
    if (panels && typeof panels === 'object') {
      branding.panels.candidates = (panels as Record<string, unknown>).candidates !== false
    }
    const license = src.license
    if (license && typeof license === 'object') {
      const l = license as Record<string, unknown>
      const pickedLicense: Record<string, unknown> = {}
      for (const key of LICENSE_FIELDS) {
        const value = l[key]
        if (value !== undefined && value !== null) pickedLicense[key] = value
      }
      // 服务端已按字段白名单输出，这里再挡一道：以后加内部字段也不会渗进 UI 状态
      Object.assign(branding.license, pickedLicense)
    }
    applyDocumentMeta()
  } catch (err) {
    // 品牌接口不可达时保持默认，登录与聊天完全可用；只在控制台留一行中文提示
    console.warn('[branding] 品牌配置加载失败，已使用内置默认值：', err)
  } finally {
    clearTimeout(timer)
  }
}
