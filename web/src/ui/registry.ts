/**
 * registry.ts —— 生成式 UI 的「组件注册表」，整个能力的安全边界就在这个文件里。
 *
 * 一句话：模型可以"点菜"，但菜单只有这张表里有登记的菜。
 *   - 表里没登记的组件名 → 不渲染（降级成文本），不存在"模型塞一段代码被执行"的路径；
 *   - 表里的组件 → props 先过 spec.ts 的校验，组件内部不做防御。
 *
 * 为什么用"工具名 → 组件"而不是"spec.type → 组件"：
 *   模型能调的入口只有一个（工具调用），入口名就是契约。用工具名做 key，
 *   等于把"模型能请求哪些组件"和"服务端暴露哪些工具"绑死在一起——
 *   服务端没这个工具，模型压根没法请求它，双保险。
 *
 * 埋点为什么必须做：
 *   未注册组件 / 校验失败在 TDesign 的 json-render 里是 console.warn + return null，
 *   线上表现就是"那块地方空了"，不埋点你永远不知道掉了多少次、掉在哪个名字上。
 */
import type { Component } from 'vue'
import BarChart from './BarChart.vue'
import { normalizeBarChart, type SpecResult } from './spec'

/** 一条注册项：组件实现 + 该组件的 spec 校验器 */
type UiSpecEntry = {
  component: Component
  normalize: (args: unknown) => SpecResult
}

/**
 * 白名单。新增一个生成式组件 = 在这里加一行（加组件文件 + 校验函数 + 服务端工具）。
 * 注意：这里的 key 必须和 server/index.js 里 createTools() 中的工具名完全一致，
 * 大小写错了不会报错，只会"图表默默不出现"。
 */
export const UI_SPEC_TOOLS: Record<string, UiSpecEntry> = {
  renderChart: { component: BarChart, normalize: normalizeBarChart }
}

/** 这个工具名是不是"生成 UI"的工具（用来在模板里分流：画组件，还是照旧展示入参/结果） */
export function isUiSpecTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(UI_SPEC_TOOLS, name)
}

export type UiSpecView =
  | { ok: true; component: Component; props: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * 把一次工具调用解析成"可以渲染的东西"。
 *
 * @returns null = 这个工具不产生 UI（调用方按普通工具展示）
 *          { ok:true } = 可以渲染
 *          { ok:false } = 本该渲染但数据不可用，调用方必须把 error 显示出来
 */
export function resolveUiSpec(toolName: string, args: unknown): UiSpecView | null {
  const entry = UI_SPEC_TOOLS[toolName]
  if (!entry) return null

  const result = entry.normalize(args)
  if (!result.ok) {
    reportUiIssue({ kind: 'invalid_spec', tool: toolName, reason: result.reason })
    return { ok: false, error: `图表数据不可用（${result.reason}），已按文本展示` }
  }

  // 校验层给了 warnings（比如"3 项数据无法转成数值"）说明模型的数据质量有问题，
  // 这里只上报不打扰用户：图已经画出来了，多一条黄条反而干扰阅读
  if (result.warnings.length) {
    reportUiIssue({ kind: 'invalid_spec', tool: toolName, reason: result.warnings.join('；') })
  }

  return { ok: true, component: entry.component, props: result.props as Record<string, unknown> }
}

type UiIssue = {
  kind: 'unknown_component' | 'invalid_spec'
  tool: string
  reason: string
}

// 上报出口：留成可替换的注入点，避免 registry 直接依赖某个接口地址。
// 接后端时在 main.ts 里写一行：
//   setUiIssueSink(issue => navigator.sendBeacon('/api/ui-issues', JSON.stringify(issue)))
let issueSink: ((issue: UiIssue) => void) | null = null

export function setUiIssueSink(sink: (issue: UiIssue) => void) {
  issueSink = sink
}

// 同一类问题可能一次渲染触发多次（模板会重复求值），做个简单的节流，避免日志刷屏
const reported = new Set<string>()

function reportUiIssue(issue: UiIssue) {
  const key = `${issue.kind}|${issue.tool}|${issue.reason}`
  if (reported.has(key)) return
  reported.add(key)
  // 本地开发看得到，线上靠 issueSink 收
  console.warn('[gen-ui]', issue.kind, issue.tool, issue.reason)
  issueSink?.(issue)
}
