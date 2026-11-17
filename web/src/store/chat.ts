import { defineStore, acceptHMRUpdate } from 'pinia'

// 知识库检索引用来源：回答下方【引用来源】区块使用
export interface RagSource {
  fileName: string // 来源文档名
  score: number // 融合相关度（向量 + BM25 按名次融合后归一到 0~1，不是余弦相似度）
  content: string // 检索到的原文片段
  sourceType?: 'knowledge' | 'attachment' // 来源类型：知识库 / 本次会话附件
  chunkIndex?: number // 片段在原文中的序号：点「查看原文上下文」取前后段用（旧语料可能缺失）
  fileId?: string // 附件来源才有：会话附件 id，上下文接口按它查
  suspicious?: boolean // 服务端注入扫描命中：该片段含"忽略指令/角色劫持"类表述，只是资料
  suspiciousTags?: string[] // 命中类别，如 ['忽略指令']，用于角标 tooltip
}

// 用户消息附带的文件：上传成功后记录，用于气泡内渲染文件卡片
export interface ChatFile {
  fileId: string // 后端会话附件 id，删除时使用
  fileName: string
  size: number // 字节数
  chunkCount: number // 解析出的片段数，图片为 0
  kind?: 'doc' | 'image' // 附件类型：文档 / 图片
  previewUrl?: string // 图片的本地预览地址（blob URL），仅图片有
}

// 工具调用步骤：一次工具调用从发起到结束的完整记录
export interface ToolStep {
  id: string // 工具调用 id，用于把 tool-call 和 tool-result/tool-error 配对
  name: string // 工具名称
  input?: unknown // 模型给出的入参
  output?: string // 工具执行结果（统一转成文本）
  error?: string // 工具执行错误信息
  status: 'running' | 'waiting' | 'done' | 'error' // 执行状态；waiting 表示等待用户确认
  progress?: string // 执行中的阶段播报（服务端 tool_progress 事件下发，仅 running 时展示，不持久化）
  approval?: {
    interruptId: string // AG-UI interrupt id，resume 时回传
    message?: string // 服务端给出的确认提示
  }
}

// 多步骤计划：服务端通过 STATE_DELTA 的 replace /plan 整数组下发（不做逐项 patch）。
// 与 ToolStep 的区别：ToolStep 是"某一次工具调用"的过程记录，由前端从事件里自己拼；
// PlanStep 是"模型声明的任务步骤"，进度由服务端按工具执行结果推进，前端只负责画。
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  id: string // 服务端生成，如 s1 / s2，按顺序稳定不变
  title: string // 这一步做什么
  tool?: string // 该步预期调用的工具名；空字符串表示不调工具
  status: PlanStepStatus // pending 未开始 / running 进行中 / done 完成 / failed 失败 / skipped 未执行
}

export interface PlanState {
  goal: string // 整个任务的目标，显示在面板标题
  steps: PlanStep[]
}

/**
 * 运行时类型守卫：agentState 是 Record<string, unknown>（服务端可以往里放任何东西），
 * 展示层要把它当作 PlanState 用，必须先过这一道，否则模板里全是 any。
 * 放在 store 里共享：PlanPanel 和 App.vue 的判断口径必须一致。
 */
export function isPlanState(value: unknown): value is PlanState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as PlanState
  return typeof candidate.goal === 'string' && Array.isArray(candidate.steps)
}

// 聊天消息类型（展示模型；消息真相在引擎 messages 里）
export interface ChatMessage {
  id: string | number
  // 对应引擎消息数组里的下标，用于关联只属于界面的附属状态
  engineIndex?: number
  role: 'user' | 'assistant'
  content: Array<
    | { type: 'markdown'; data: string }
    | { type: 'text'; data: string }
    | { type: 'thinking'; data: { text: string; title?: string } }
    | { type: 'image'; data: string }
  >
  status?: 'streaming' | 'complete' | 'error'
  reasonContent?: string // Agent思考过程文本
  name?: string // 发送者名称
  avatar?: string // 发送者头像 URL
  datetime?: string // 消息时间
  error?: boolean // 是否请求失败（用于显示重发按钮）
  errorMsg?: string // 错误详情
  stopped?: boolean // 是否被用户主动停止生成（下一轮上下文要显式标注，避免被当成未回答）
  thinkingCollapsed?: boolean // 思考过程折叠状态（受控模式用）
  toolSteps?: ToolStep[] // 本轮 AI 回复中的工具调用步骤
  plan?: PlanState // 本轮 AI 回复中声明的多步骤计划（挂在发起 planSteps 的那条消息上）
  notices?: string[] // 服务端提示（如上下文被裁剪）
  files?: ChatFile[] // 用户消息附带的文件列表
  sources?: RagSource[] // 知识库检索命中的引用来源
}

// 用户与 AI 的默认身份配置（头像、名称）
export const USER_META = {
  name: '我',
  avatar: 'https://tdesign.gtimg.com/site/avatar.jpg'
}
export const ASSISTANT_META = {
  name: 'AI 助手',
  avatar: 'https://tdesign.gtimg.com/site/avatar.jpg'
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    // 展示模型快照，仅用于刷新恢复（真正的消息真相在引擎 messages 里）
    messageList: [] as ChatMessage[],
    // AG-UI 共享状态（STATE_SNAPSHOT / STATE_DELTA 的结果），每轮请求回传给服务端
    agentState: {} as Record<string, unknown>,
    // 当前线程 id：必须持久化，否则刷新后前端另起新线程，
    // 服务端落库的历史和新消息会对不上号
    threadId: '',
    loading: false
  }),
  actions: {
    clearMessages() {
      this.messageList = []
    }
  },
  // 只持久化消息与共享状态：loading 等运行时状态不能落盘，否则刷新后会一直禁用发送
  persist: {
    pick: ['messageList', 'agentState', 'threadId']
  }
})

// 开发环境热更新：store 文件改动时原地更新 action
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
