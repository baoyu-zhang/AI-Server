import { defineStore, acceptHMRUpdate } from 'pinia'

// 知识库检索引用来源：回答下方【引用来源】区块使用
export interface RagSource {
  fileName: string // 来源文档名
  score: number // 融合相关度（向量 + BM25 按名次融合后归一到 0~1，不是余弦相似度）
  content: string // 检索到的原文片段
  sourceType?: 'knowledge' | 'attachment' // 来源类型：知识库 / 本次会话附件
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
  approval?: {
    interruptId: string // AG-UI interrupt id，resume 时回传
    message?: string // 服务端给出的确认提示
  }
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
