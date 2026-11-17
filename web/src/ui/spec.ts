/**
 * 生成式 UI 的「spec 校验层」——纯函数、零框架依赖。
 *
 * 职责划分（这三层不要混）：
 *   ① 模型：决定"用哪个组件、填什么数据"，产出 spec（工具参数就是一坨 JSON）；
 *   ② 本文件：判断这份 spec 能不能渲染、把脏数据洗干净（归一化），洗不干净就返回 reason；
 *   ③ 组件：只接收已校验的 props，内部不做任何防御性判断。
 *
 * 为什么单独一层，且不 import 任何 Vue 代码：
 *   1. 可以脱离浏览器单测（见同目录 spec.selftest.ts，node 直接跑）；
 *   2. 将来换 React / 小程序，这一层原样能搬走；
 *   3. 校验失败必须"可被看见"——返回 reason 而不是抛异常，否则前端只能白屏。
 *
 * 一条铁律：这里假设模型给的参数**完全不可信**。
 * 模型会给你 "1,200"、"¥3.4万"、null、字符串数字、超长标签、25 条数据……
 * 校验层的价值就是把这些东西在进入 DOM 之前收敛掉。
 */

/** 柱状图单个数据项 */
export type BarChartDatum = {
  label: string // 横轴标签，如 "1月"
  value: number // 已转成数字的数值（可能是负数）
}

/** BarChart 组件接收的 props（组件内部直接信任这个类型） */
export type BarChartProps = {
  title: string
  unit?: string // 单位，如 "万元"；没有就不传
  data: BarChartDatum[]
}

/** 校验结果：成功带归一化后的 props，失败带人话原因 */
export type SpecResult =
  | { ok: true; component: 'barChart'; props: BarChartProps; warnings: string[] }
  | { ok: false; component: 'barChart'; reason: string }

// 一次最多画多少根柱子：再多横轴标签就挤成一团，模型也常在这种量级上开始编数据
const MAX_BARS = 24
// 标签长度上限：超了不报错，直接截断——用户更需要看到图，而不是看到校验失败
const MAX_LABEL = 20
const MAX_TITLE = 30
const MAX_UNIT = 8

// 中文数量单位：模型很爱输出 "1.2万"，直接 Number() 会得到 NaN
const SCALE_UNITS: Record<string, number> = { 万: 1e4, 亿: 1e8, k: 1e3, K: 1e3, w: 1e4 }

/**
 * 把模型给的任意值转成数字。
 * 处理了这些真实出现过的脏数据：数字字符串、千分位逗号（含全角）、货币符号、百分号、万/亿 后缀、括号负数。
 * 转不出来返回 null（调用方据此丢项），绝不返回 NaN——NaN 会一路静默传到样式里变成 height: NaN%。
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null

  // 去掉千分位、货币符号、百分号、空白（含全角空格）；负号要保留
  let text = raw.trim().replace(/[,，\s\u00a0¥$￥%]/g, '')
  if (!text) return null

  // 括号负数："(120)" → "-120"，财务报表里很常见
  let negative = false
  if (/^\(.+\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }

  let scale = 1
  const last = text.slice(-1)
  if (SCALE_UNITS[last] !== undefined) {
    scale = SCALE_UNITS[last]
    text = text.slice(0, -1)
  }

  // 只允许纯数字形态，避免 Number('12abc') 这种半解析
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text) * scale
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

/** 截断字符串并按需兜底 */
function text(raw: unknown, max: number, fallback = ''): string {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * 校验并归一化柱状图 spec。
 *
 * @param args 模型给的工具参数（unknown：调用方不该假设它是任何形状）
 */
export function normalizeBarChart(args: unknown): SpecResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, component: 'barChart', reason: '图表参数不是对象' }
  }

  const raw = args as Record<string, unknown>
  const warnings: string[] = []

  // data 是唯一硬性要求：没有数据就真的没法画
  if (!Array.isArray(raw.data)) {
    return { ok: false, component: 'barChart', reason: '缺少 data 数组' }
  }

  const data: BarChartDatum[] = []
  let dropped = 0
  for (const [index, item] of raw.data.entries()) {
    if (!item || typeof item !== 'object') {
      dropped += 1
      continue
    }
    const row = item as Record<string, unknown>
    const value = toNumber(row.value)
    // 数值转不出来：丢掉这一项而不是整张图——一张少一根的图，比"图表没画出来"有用得多
    if (value === null) {
      dropped += 1
      continue
    }
    // 标签缺失用序号兜底，保证横轴不出空位
    const label = text(row.label, MAX_LABEL, `#${index + 1}`)
    data.push({ label, value })
  }

  if (!data.length) {
    return { ok: false, component: 'barChart', reason: `${raw.data.length} 项数据里没有可用数值` }
  }
  if (dropped > 0) warnings.push(`${dropped} 项数据无法转成数值，已忽略`)
  if (data.length > MAX_BARS) {
    warnings.push(`数据超过 ${MAX_BARS} 项，只展示前 ${MAX_BARS} 项`)
    data.length = MAX_BARS
  }

  const unit = text(raw.unit, MAX_UNIT)
  return {
    ok: true,
    component: 'barChart',
    props: {
      title: text(raw.title, MAX_TITLE, '数据概览'),
      // 空字符串会被当成"传了单位"，导致标题后面挂个空括号，所以这里转成 undefined
      unit: unit || undefined,
      data
    },
    warnings
  }
}
