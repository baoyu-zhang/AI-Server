<template>
  <!-- 整体两栏布局：左侧知识库文档栏 + 右侧聊天区 -->
  <div class="app-shell">
    <!-- 桌面端：文档栏常驻左侧 -->
    <DocPanel v-if="!isNarrow" class="app-shell__aside" />

    <!-- 窄屏：文档栏收进左侧抽屉 -->
    <t-drawer v-else v-model:visible="docDrawerVisible" placement="left" size="280px" :header="false"
      :footer="false" class="doc-drawer">
      <DocPanel class="app-shell__drawer-panel" />
    </t-drawer>

    <!-- 整个聊天面板容器 -->
    <div class="chat-container">
      <!-- 窄屏顶部栏：打开文档抽屉 -->
      <div v-if="isNarrow" class="chat-header">
        <t-button variant="text" shape="square" title="知识库文档" @click="docDrawerVisible = true">
          <MenuIcon />
        </t-button>
        <span class="chat-header__title">知识库助手</span>
      </div>
    <!-- 消息列表容器：内部用 t-chat-message 渲染每条消息 -->
    <t-chat-list ref="chatListRef" class="chat-list" @clear="handleClear">
      <!--
        遍历 store 中的消息列表渲染每条消息：s
        - placement：用户消息靠右，AI 消息靠左
        - handle-actions：仅 AI 消息显示操作栏（复制/重试）
        - 使用 #content 插槽自定义内容：思考过程折叠面板 + markdown 回答
      -->
      <t-chat-message v-for="msg in chatStore.messageList" :key="msg.id" :role="msg.role" :status="msg.status"
        :content="msg.content" :name="msg.name" :avatar="msg.avatar" :datetime="msg.datetime"
        :placement="msg.role === 'user' ? 'right' : 'left'">
        <!-- 自定义消息内容区域 -->
        <template #content>
          <!-- 服务端提示：如上下文被裁剪，以浅色横幅展示 -->
          <div v-if="msg.role === 'assistant' && msg.notices?.length" class="msg-notices">
            <div v-for="notice in msg.notices" :key="notice" class="msg-notice">
              <InfoCircleIcon class="msg-notice__icon" />
              <span>{{ notice }}</span>
            </div>
          </div>
          <!-- 思考过程折叠面板：仅 AI 消息且存在思考内容时渲染 -->
          <div v-if="msg.role === 'assistant' && msg.reasonContent" class="reason-wrap">
            <t-chat-thinking :collapsed="msg.thinkingCollapsed ?? false" layout="block"
              :status="msg.status === 'streaming' ? 'pending' : 'complete'"
              @collapsed-change="onThinkingCollapse(msg, $event)">
              <div style="padding: 0 12px 12px;"> {{ msg.reasonContent }}</div>
            </t-chat-thinking>
          </div>
          <!-- 工具调用步骤：展示本轮 AI 调用了哪些工具、入参、结果与执行状态 -->
          <div v-if="msg.role === 'assistant' && msg.toolSteps?.length" class="tool-steps">
            <div v-for="step in msg.toolSteps" :key="step.id" class="tool-step">
              <div class="tool-step__head">
                <span class="tool-step__dot" :class="`is-${step.status}`"></span>
                <span class="tool-step__name">{{ getToolLabel(step.name) }}</span>
                <code class="tool-step__code">{{ step.name }}</code>
                <span class="tool-step__status">
                  {{ step.status === 'waiting' ? '待确认' : step.status === 'running' ? '执行中' : step.status === 'error' ? '失败' : '完成' }}
                </span>
              </div>
              <div v-if="hasToolInput(step.input)" class="tool-step__row">
                <span class="tool-step__label">入参</span>
                <code class="tool-step__value">{{ formatToolValue(step.input) }}</code>
              </div>
              <div v-if="step.status === 'waiting' && step.approval" class="tool-step__approval">
                <div class="tool-step__approval-text">{{ step.approval.message || '该操作需要你确认后才能继续' }}</div>
                <div class="tool-step__approval-actions">
                  <t-button size="small" theme="danger" :loading="chatStore.loading"
                    @click="handleInterruptDecision(step, true)">允许执行</t-button>
                  <t-button size="small" variant="outline" :disabled="chatStore.loading"
                    @click="handleInterruptDecision(step, false)">拒绝</t-button>
                </div>
              </div>
              <div v-if="step.output || step.error" class="tool-step__row">
                <span class="tool-step__label">{{ step.error ? '错误' : '结果' }}</span>
                <code class="tool-step__value" :class="{ 'is-error': step.error }">{{ getToolResultText(msg, step) }}</code>
              </div>
            </div>
          </div>
          <!-- 用户消息附带的图片：按气泡样式展示缩略图 -->
          <div v-if="msg.role === 'user' && imageFiles(msg.files).length" class="msg-images">
            <img v-for="file in imageFiles(msg.files)" :key="file.fileId" class="msg-image" :src="file.previewUrl"
              :alt="file.fileName" :title="file.fileName" />
          </div>
          <!-- 用户消息附带的文档卡片：图片已在上方展示，这里只渲染文档 -->
          <div v-if="msg.role === 'user' && docFiles(msg.files).length" class="msg-files">
            <div v-for="file in docFiles(msg.files)" :key="file.fileId" class="msg-file">
              <FileIcon class="msg-file__icon" />
              <div class="msg-file__main">
                <span class="msg-file__name" :title="file.fileName">{{ file.fileName }}</span>
                <span class="msg-file__meta">{{ formatSize(file.size) }} · 已解析 {{ file.chunkCount }} 个片段</span>
              </div>
            </div>
          </div>
          <!-- 回答正文：t-chat-content 接收单个 markdown 对象，自动渲染 markdown -->
          <t-chat-content :content="getMarkdownContent(msg)" :role="msg.role" />
          <!-- 引用来源：AI 调用知识库检索后，展示命中的文档片段，点击展开原文 -->
          <div v-if="msg.role === 'assistant' && msg.sources?.length" class="sources">
            <div class="sources__head">
              <BookmarkIcon class="sources__icon" />
              <span>引用来源</span>
              <span class="sources__count">{{ msg.sources.length }}</span>
            </div>
            <div class="sources__list">
              <div v-for="(source, index) in msg.sources" :key="`${source.fileName}-${index}`" class="source-item">
                <button type="button" class="source-item__head" @click="toggleSource(msg.id, index)">
                  <span class="source-item__index">{{ index + 1 }}</span>
                  <span class="source-item__file" :title="source.fileName">{{ source.fileName }}</span>
                  <span class="source-item__type" :class="source.sourceType === 'attachment' ? 'is-file' : 'is-kb'">
                    {{ source.sourceType === 'attachment' ? '本次附件' : '知识库' }}
                  </span>
                  <span class="source-item__score">相似度 {{ source.score.toFixed(3) }}</span>
                  <ChevronDownIcon class="source-item__arrow" :class="{ 'is-open': isSourceOpen(msg.id, index) }" />
                </button>
                <div v-if="isSourceOpen(msg.id, index)" class="source-item__body">{{ source.content }}</div>
              </div>
            </div>
          </div>
        </template>
        <!-- 操作栏：仅 AI 消息显示，重放作用于当前这条消息 -->
        <template #actionbar>
          <t-chat-action v-if="msg.role === 'assistant'" :action-bar="getMsgActions()" :content="getMsgText(msg)"
            @actions="handleMsgActionClick({ action: $event, msg })" />
        </template>
      </t-chat-message>
    </t-chat-list>

    <!-- 发送区：外层包裹层负责拖拽/粘贴上传 -->
    <div class="sender-wrap" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave"
      @drop.prevent="onDrop" @paste="onPaste">
      <!-- 输入发送组件，自带 loading 态和回车发送 -->
      <t-chat-sender v-model="inputText" :loading="chatStore.loading" @send="onSend" @stop="onStop"
        placeholder="输入消息，回车发送，Shift+Enter换行" @file-select="handleUploadFile" @file-click="handleFileClick"
        @remove="handleRemoveFile" :attachments-props="{
          items: filesList,
          overflow: 'scrollX',
        }">
        <!-- 后缀插槽：生成中显示"停止生成"按钮 -->
        <template #suffix="{ renderPresets }">
          <component :is="renderPresets([
            { name: 'uploadImage', uploadProps: { accept: '.png,.jpg,.jpeg,.webp,.gif' } },
            { name: 'uploadAttachment', uploadProps: { accept: '.md,.pdf' } },
          ])" />
        </template>
        <template #footer-prefix>
          <div class="model-select">
            <t-tooltip v-model:visible="allowToolTip" content="切换模型" trigger="hover">
              <t-select v-model="selectValue" :options="selectOptions" value-type="object"
                @focus="allowToolTip = false"></t-select>
            </t-tooltip>
            <t-button class="check-box" :class="{ 'is-active': isChecked }" variant="outline" @click="checkClick">
              <SystemSumIcon />
              <span>深度思考</span>
            </t-button>
          </div>
        </template>
      </t-chat-sender>
      <!-- 拖拽提示：拖入文件时覆盖在发送区上方 -->
      <div v-if="dragActive" class="drop-hint">松开即可上传附件（MD / PDF / 图片，单个 ≤ 10MB）</div>
      <!-- 上传规则提示：常驻一行，降低无效上传 -->
      <div class="sender-hint">支持点击、拖拽或粘贴上传 · 最多 5 个 · 单个 ≤ 10MB · 附件仅本次对话可用 · 图片可直接提问</div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 引入 Vue 响应式 API：ref 定义响应式变量，watch 监听数据变化，nextTick 等待 DOM 更新
import { ref, watch, nextTick } from 'vue'
import { useMediaQuery } from '@vueuse/core'
// 引入聊天 store（管理消息列表、loading 状态等）
import { useChatStore, USER_META, ASSISTANT_META } from './store/chat'
// AG-UI 客户端：负责把 RunAgentInput 发给 /agui，并按事件回调驱动界面
import { HttpAgent } from '@ag-ui/client'
import type { AgentSubscriber } from '@ag-ui/client'
import type { Message, Interrupt, ResumeEntry } from '@ag-ui/core'
// 左侧知识库文档面板
import DocPanel from './components/DocPanel.vue'
// 引入文件上传组件类型定义
import type { TdAttachmentItem } from '@tdesign-vue-next/chat/es/index'
import { MessagePlugin } from 'tdesign-vue-next'
import { SystemSumIcon, InfoCircleIcon, MenuIcon, BookmarkIcon, ChevronDownIcon, FileIcon } from 'tdesign-icons-vue-next';
// 引入消息类型定义
import type { ChatMessage, ChatFile, ToolStep, RagSource } from './store/chat'

// 发送区附件项：在 TDesign 附件项基础上补充后端文件 id 与原始 File（失败重试需要）
type SenderFile = TdAttachmentItem & {
  fileId?: string
  rawFile?: File
  chunkCount?: number
  kind?: 'doc' | 'image'
}

// 窄屏判定：≤900px 时文档栏改为抽屉
const isNarrow = useMediaQuery('(max-width: 900px)')
const docDrawerVisible = ref(false)

// 全局聊天仓库实例
const chatStore = useChatStore()
// 消息列表 DOM 引用，用于调用滚动到底部方法
const chatListRef = ref<{ scrollToBottom: () => void } | null>(null)
// 输入框内容（与 t-chat-sender 双向绑定）
const inputText = ref('')
const allowToolTip = ref(false)
const isChecked = ref(false)
const selectOptions = [
  {
    label: '默认模型',
    value: 'default',
  },
  {
    label: 'Deepseek',
    value: 'deepseek-r1',
  },
  {
    label: '混元',
    value: 'hunyuan',
  },
];
const selectValue = ref({
  label: '默认模型',
  value: 'default',
});
// 当前活跃的 AG-UI Agent：用于"停止生成"时中断本次 run
let activeAgent: HttpAgent | null = null
// 用户是否点了"停止生成"：浏览器中断 fetch 抛出的不是 AbortError，只能靠自己标记
let abortRequested = false
// 发送区附件列表（上传中/成功/失败三态）
const filesList = ref<SenderFile[]>([])
// 是否正在拖拽文件到发送区
const dragActive = ref(false)
// dragenter/dragleave 在子元素间移动时会连续触发，用计数器判断是否真正离开
let dragDepth = 0

// ========== 会话标识：附件与会话绑定，清空对话时轮换 ==========
function createSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
const sessionId = ref(createSessionId())
// AG-UI 的线程标识：同一次对话复用，清空对话时轮换
function createThreadId() {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
const threadId = ref(createThreadId())
// 根据消息状态返回要显示的操作按钮数组（名称只能是 copy/good/bad/replay/share）
// - 始终显示复制、点赞、点踩、分享、重放（重放只作用于被点击的那条消息）
function getMsgActions() {
  return ['copy', 'good', 'bad', 'share', 'replay']
}

// 从消息 content 数组中提取 markdown/text 内容，返回 t-chat-content 可识别的单个对象
function getMarkdownContent(msg: ChatMessage) {
  const item = msg.content.find(c => c.type === 'markdown' || c.type === 'text')
  if (!item) return ''
  // t-chat-content 接受 string | { type, data }，这里统一返回对象形式
  return item.type === 'markdown'
    ? { type: 'markdown' as const, data: item.data }
    : { type: 'text' as const, data: item.data }
}

// 从消息 content 数组中提取纯文本字符串，用于复制和分享
function getMsgText(msg: ChatMessage): string {
  const item = msg.content.find(c => c.type === 'markdown' || c.type === 'text')
  return item ? String(item.data) : ''
}

// ========== 历史消息 -> AG-UI messages（P2） ==========
// assistant 消息携带 toolCalls，工具结果单独作为 tool 消息；
// 服务端据此还原 tool-call / tool-result，模型才能看到上一轮的工具上下文，而不是只有纯文本。
function toAguiMessages(list: ChatMessage[]): Message[] {
  const messages: Message[] = []
  for (const message of list) {
    // 失败的消息（❌ 文案）不入上下文
    if (message.error) continue
    const text = getMsgText(message)

    if (message.role === 'user') {
      if (text.trim()) messages.push({ id: String(message.id), role: 'user', content: text })
      continue
    }

    // 被用户中止的轮次要显式标注，否则模型会把放弃的问题当成"还没回答"继续补答
    const answer = message.stopped ? `${text}${text ? '\n\n' : ''}（用户已中止本轮回答）` : text
    const steps = message.toolSteps || []

    if (steps.length) {
      messages.push({
        id: String(message.id),
        role: 'assistant',
        content: answer,
        toolCalls: steps.map(step => ({
          id: step.id,
          type: 'function' as const,
          function: { name: step.name, arguments: JSON.stringify(step.input ?? {}) }
        }))
      })
      // 每个 toolCall 都必须配一条结果，悬空的调用会让下一轮请求非法；
      // 等待确认的调用说明用户已经放弃（例如直接发了新消息），按"未确认已取消"补一条结果
      for (const step of steps) {
        const cancelled = step.status === 'waiting'
        messages.push({
          id: `${message.id}-${step.id}`,
          role: 'tool',
          toolCallId: step.id,
          content: cancelled
            ? '用户未确认该操作，已取消'
            : step.error
              ? `工具执行失败：${step.error}`
              : step.output || '（该工具没有返回内容）'
        })
      }
      continue
    }

    if (answer.trim()) messages.push({ id: String(message.id), role: 'assistant', content: answer })
  }
  return messages
}

// 思考过程折叠切换：更新对应消息的折叠状态
// 注意：omi-vueify 转发 web component 事件时传入的是 CustomEvent 对象，布尔值在 .detail 中
function onThinkingCollapse(msg: ChatMessage, val: unknown) {
  const collapsed = val instanceof CustomEvent ? val.detail : val
  msg.thinkingCollapsed = Boolean(collapsed)
}

// 捕获消息操作栏的点击事件：支持重发、点赞、点踩、分享、复制
function handleMsgActionClick({ action, msg }: { action: unknown; msg: ChatMessage }) {
  switch (action) {
    case 'replay':
      onRetry(msg)
      break
    case 'good':
      console.log('点赞', msg.id)
      break
    case 'bad':
      console.log('点踩', msg.id)
      break
    case 'share':
      // 复制正文到剪贴板作为分享
      const textItem = msg.content.find(c => c.type === 'markdown' || c.type === 'text')
      const shareText = textItem ? String(textItem.data) : ''
      navigator.clipboard?.writeText(shareText).then(() => {
        console.log('分享内容已复制到剪贴板')
      })
      break
    case 'copy':
      // t-chat-action 内置会处理复制，这里留空
      break
  }
}

// 监听消息列表变化，DOM 更新后自动滚动到底部（流式输出时持续滚动）
watch(
  () => chatStore.messageList,
  async () => {
    await nextTick()
    chatListRef.value?.scrollToBottom()
  },
  { deep: true } // 深度监听，数组内部 content 变化也能触发
)

// ========== 工具步骤展示辅助 ==========
// 工具名称到中文标签的映射，未登记的工具直接显示原始名称
const TOOL_LABELS: Record<string, string> = {
  getCurrentTime: '获取当前时间',
  calculator: '数学计算',
  searchKnowledgeBase: '知识库检索',
  getSelectedText: '读取选中文本',
  getClientTime: '浏览器本地时间',
  deleteSessionFile: '删除会话附件'
}
function getToolLabel(name: string) {
  return TOOL_LABELS[name] || name
}
// 判断工具入参是否有内容，避免渲染空行
function hasToolInput(input: unknown) {
  if (input == null) return false
  if (typeof input === 'object') return Object.keys(input as object).length > 0
  return String(input).length > 0
}
// 把工具入参/结果统一转成可展示文本
function formatToolValue(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

// 工具结果展示：知识库检索不展示大段原文，只提示命中的片段数，原文放到引用来源区
function getToolResultText(msg: ChatMessage, step: ToolStep) {
  if (step.error) return step.error
  if (step.name === 'searchKnowledgeBase') {
    const count = msg.sources?.length || 0
    return count ? `检索到 ${count} 条片段，已展示在下方引用来源` : '未检索到相关内容'
  }
  return step.output || ''
}

// ========== 引用来源手风琴 ==========
// 用 `${消息id}-${序号}` 作为展开标识，保证同一时间只展开一条片段
const openSourceKey = ref('')
function toggleSource(msgId: number, index: number) {
  const key = `${msgId}-${index}`
  openSourceKey.value = openSourceKey.value === key ? '' : key
}
function isSourceOpen(msgId: number, index: number) {
  return openSourceKey.value === `${msgId}-${index}`
}

// ========== 前端工具（在浏览器侧执行） ==========
// 服务端只拿到工具定义（不含 execute），模型发出调用后本轮结束；
// 浏览器执行完再通过 tool 消息回填，并二次 run 让模型继续生成回答。
type FrontendTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (input: Record<string, unknown>) => string | Promise<string>
}

const FRONTEND_TOOLS: FrontendTool[] = [
  {
    name: 'getSelectedText',
    description: '读取用户当前在网页上选中的文本。当用户问“我选中的内容是什么”“解释一下我选中的文字”时调用',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const text = window.getSelection()?.toString().trim() || ''
      return text ? `用户当前选中的文本：\n${text}` : '用户当前没有在页面上选中任何文本'
    }
  },
  {
    name: 'getClientTime',
    description: '获取用户浏览器所在设备的本地时间与时区。当用户问“我这边现在几点”“我的电脑显示的时间”时调用',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const now = new Date()
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return `浏览器本地时间：${now.toLocaleString('zh-CN')}，时区：${timeZone}`
    }
  }
]

// 下发给 /agui 的定义：只有 name / description / parameters
const frontendToolDefinitions = FRONTEND_TOOLS.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters
}))
const FRONTEND_TOOL_MAP = new Map(FRONTEND_TOOLS.map(tool => [tool.name, tool]))
// 一次提问最多续跑的轮数，防止工具调用死循环
const MAX_TOOL_ROUNDS = 3

// ========== 流式请求核心函数 ==========
// 全局挂起的中断：interrupt 结束后保留 agent，用户点"允许/拒绝"时用它 resume 续跑
let pendingInterrupts: Interrupt[] = []

// 驱动一次完整 run（含前端工具续跑）。resume 只在第一轮生效。
// 流程：订阅 AG-UI 事件把推理/正文/工具/来源写进最后一条消息 → 若本轮留下前端工具调用，
// 本地执行并回填 tool 消息后再 run → 直到没有待执行工具、出现中断或达到轮数上限
async function driveAgent(agent: HttpAgent, resume?: ResumeEntry[]) {
  chatStore.loading = true
  abortRequested = false

  // 本轮 run 结束后留下的中断（服务端暂停，等待用户确认）
  const runInterrupts: Interrupt[] = []
  // 工具入参是 JSON 字符串增量，需要自己累加才能拿到完整 args
  const argBuffers = new Map<string, string>()
  // 记录本轮 run 的工具名与入参，用于匹配待执行的前端工具
  const toolCallNames = new Map<string, string>()
  const toolCallInputs = new Map<string, unknown>()
  let runFailed = false

  // 每轮 run 复用同一套订阅；pendingToolCallIds 用于收集本轮未执行的工具调用
  const createSubscriber = (pendingToolCallIds: string[]): AgentSubscriber => ({
    // 推理增量：官方 reasoningMessageBuffer 滞后一帧，这里直接用 delta 拼接
    onReasoningMessageContentEvent({ event }) {
      chatStore.appendAiReason(event.delta)
    },
    // 正文增量
    onTextMessageContentEvent({ event }) {
      chatStore.appendAiMarkdown(event.delta)
    },
    onToolCallStartEvent({ event }) {
      toolCallNames.set(event.toolCallId, event.toolCallName)
      chatStore.appendToolCall({ id: event.toolCallId, name: event.toolCallName })
    },
    onToolCallArgsEvent({ event }) {
      const buffer = (argBuffers.get(event.toolCallId) || '') + event.delta
      argBuffers.set(event.toolCallId, buffer)
      try {
        chatStore.setToolCallInput(event.toolCallId, JSON.parse(buffer))
      } catch {
        // 分片还没拼成合法 JSON，等下一片
      }
    },
    onToolCallEndEvent({ event, toolCallArgs }) {
      argBuffers.delete(event.toolCallId)
      toolCallInputs.set(event.toolCallId, toolCallArgs)
      chatStore.setToolCallInput(event.toolCallId, toolCallArgs)
    },
    onToolCallResultEvent({ event }) {
      // content 可能是纯文本或 content parts，统一拍平成文本
      const content = event.content as unknown
      const output = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => (part?.type === 'text' ? part.text || '' : '')).join('')
          : ''
      chatStore.finishToolCall({ id: event.toolCallId, output })
    },
    onStateDeltaEvent({ event }) {
      // 检索来源由服务端以 JSON Patch 的 add /sources/- 推送
      const sources = (event.delta as Array<{ op?: string; path?: string; value?: unknown }>)
        .filter(patch => patch.op === 'add' && patch.path === '/sources/-' && patch.value)
        .map(patch => patch.value as RagSource)
      if (sources.length) chatStore.appendSources(sources)
    },
    onCustomEvent({ event }) {
      const value = (event.value || {}) as { content?: string; toolCallId?: string; message?: string }
      if (event.name === 'trim_notice') {
        chatStore.appendNotice({ type: 'trim_notice', content: value.content })
      } else if (event.name === 'tool_error' && value.toolCallId) {
        // 工具执行失败：结果事件本身只有文本，靠这条自定义事件标记失败状态
        chatStore.failToolCall({ id: value.toolCallId, error: value.message })
      }
    },
    onRunErrorEvent({ event }) {
      // HttpAgent 的传输层会把 AbortError 包装成 code='abort' 的 RUN_ERROR，用户主动停止时不算失败
      if (abortRequested || event.code === 'abort') {
        chatStore.markLastAiStopped()
        return
      }
      runFailed = true
      chatStore.setLastAiError(event.message || '请求出错')
    },
    onRunFinishedEvent(params) {
      if (params.outcome === 'success') {
        // 记录本轮留给客户端执行的工具调用（按出现顺序）
        pendingToolCallIds.push(...(params.pendingToolCallIds || []))
      } else if (params.outcome === 'interrupt') {
        // 服务端主动暂停，等待用户确认后才继续
        runInterrupts.push(...(params.interrupts || []))
      }
    }
  })

  try {
    // 多轮 run：服务端工具在流内执行完；前端工具会留在 pendingToolCallIds 里，
    // 本地执行并回填 tool 消息后再 run 一次，让模型接着生成回答
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const pendingToolCallIds: string[] = []

      await agent.runAgent(
        {
          runId: crypto.randomUUID(),
          // 前端工具定义随每次 run 下发给服务端
          tools: frontendToolDefinitions,
          forwardedProps: { sessionId: sessionId.value },
          // resume 只在第一轮带：告诉服务端上次中断的处理结果
          ...(round === 0 && resume ? { resume } : {})
        },
        createSubscriber(pendingToolCallIds)
      )

      // 出错或用户停止，不再续跑
      if (runFailed || abortRequested) break
      // 服务端暂停等待用户确认，本轮不再续跑
      if (runInterrupts.length) break
      // 没有待执行工具，说明模型已经给出最终回答
      if (!pendingToolCallIds.length) break

      // 在浏览器执行工具，并把结果作为 tool 消息回填给下一轮 run
      for (const toolCallId of pendingToolCallIds) {
        const toolName = toolCallNames.get(toolCallId) || ''
        const input = (toolCallInputs.get(toolCallId) || {}) as Record<string, unknown>
        const localTool = FRONTEND_TOOL_MAP.get(toolName)
        let output: string

        if (!localTool) {
          output = `工具执行失败：前端未注册工具 ${toolName || toolCallId}`
          chatStore.failToolCall({ id: toolCallId, error: '前端未注册该工具' })
        } else {
          try {
            output = String(await localTool.execute(input))
            chatStore.finishToolCall({ id: toolCallId, output })
          } catch (err: any) {
            output = `工具执行失败：${err?.message || err}`
            chatStore.failToolCall({ id: toolCallId, error: err?.message || String(err) })
          }
        }

        agent.addMessage({
          id: `tool_${toolCallId}`,
          role: 'tool',
          toolCallId,
          content: output
        })
        toolCallNames.delete(toolCallId)
        toolCallInputs.delete(toolCallId)
      }
    }

    if (runInterrupts.length && !runFailed && !abortRequested) {
      // 把中断标到对应的工具卡片上，等用户点"允许/拒绝"
      for (const interrupt of runInterrupts) {
        if (!interrupt.toolCallId) continue
        chatStore.markToolCallWaiting({
          id: interrupt.toolCallId,
          interruptId: interrupt.id,
          message: interrupt.message
        })
      }
      pendingInterrupts = runInterrupts
      chatStore.finishLastAiMessage()
      return
    }

    if (!runFailed) chatStore.finishLastAiMessage()
  } catch (err: any) {
    // 用户主动点击"停止生成"导致的中断，不算错误
    const aborted = abortRequested || err?.name === 'AbortError' || /abort/i.test(err?.message || '')
    if (aborted) {
      chatStore.markLastAiStopped()
    } else if (!runFailed) {
      console.error('AG-UI 请求失败：', err)
      chatStore.setLastAiError(err?.message || '请求出错')
    }
  } finally {
    chatStore.loading = false
    // 有挂起中断时保留 agent，用户确认后还要用它 resume
    if (activeAgent === agent && !pendingInterrupts.length) activeAgent = null
  }
}

// ========== 发起一次新的 run ==========
function runAgentStream() {
  // 新提问意味着放弃上次未确认的中断
  if (pendingInterrupts.length) {
    pendingInterrupts = []
    chatStore.cancelWaitingToolCalls()
  }

  // 先插入一条空的 AI 消息占位，后续流式往这条消息里追加内容
  const aiMsg: ChatMessage = {
    id: Date.now() + 1,
    role: 'assistant',
    content: [{ type: 'markdown', data: '' }],
    status: 'streaming',
    reasonContent: '',
    thinkingCollapsed: false,
    name: ASSISTANT_META.name,
    avatar: ASSISTANT_META.avatar,
    datetime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  chatStore.addMessage(aiMsg)
//这段代码在每次发起 agent 请求前，创建 agent、传入线程 ID、设置会话状态（含 sessionId），并把除最后一条外的历史消息（含工具调用上下文）按 AG-UI 格式设置好，确保服务端能基于完整上下文继续推理。
  const agent = new HttpAgent({ url: '/agui', threadId: threadId.value })
  // sessionId 供服务端做会话附件检索；state 会被原样合并进 STATE_SNAPSHOT
  agent.setState({ sessionId: sessionId.value })
  // 历史消息必须走 setMessages：runAgent 的入参不含 messages
  // P2：assistant 带 toolCalls、工具结果作为 tool 消息，服务端直接还原模型需要的工具上下文
  agent.setMessages(toAguiMessages(chatStore.messageList.slice(0, -1)))
  activeAgent = agent

  void driveAgent(agent)
}

// ========== 处理中断：用户允许或拒绝服务端暂停的操作 ==========
async function handleInterruptDecision(step: ToolStep, approved: boolean) {
  if (chatStore.loading || !activeAgent || !step.approval) return
  const agent = activeAgent

  // 客户端要求 resume 必须覆盖全部挂起中断：本次点击的按选择处理，其余按拒绝处理
  const resume: ResumeEntry[] = pendingInterrupts.map(interrupt => {
    const isTarget = interrupt.toolCallId === step.id
    return {
      interruptId: interrupt.id,
      status: isTarget && approved ? 'resolved' : 'cancelled',
      payload: { approved: isTarget && approved }
    }
  })

  pendingInterrupts = []
  for (const item of resume) {
    const toolCallId = item.interruptId.startsWith('int_') ? item.interruptId.slice(4) : ''
    if (toolCallId) chatStore.resumeToolCall(toolCallId)
  }
  if (!approved) chatStore.failToolCall({ id: step.id, error: '用户拒绝了该操作' })

  await driveAgent(agent, resume)
}

// ========== 发送新消息 ==========
function onSend(text: string) {
  // 上传中/失败时不允许发送，避免把未就绪的附件带进检索
  if (filesList.value.some(file => file.status === 'progress')) {
    MessagePlugin.warning('附件上传中，请稍候')
    return
  }
  if (filesList.value.some(file => file.status === 'fail')) {
    MessagePlugin.warning('有附件上传失败，请点击重试或移除')
    return
  }

  // 只带上后端已返回 fileId 的附件
  const sentFiles: ChatFile[] = filesList.value
    .filter(file => file.fileId && file.status === 'success')
    .map(file => ({
      fileId: file.fileId as string,
      fileName: file.name || '未命名文件',
      size: file.size ?? 0,
      chunkCount: file.chunkCount ?? 0,
      kind: file.kind === 'image' ? 'image' : 'doc',
      previewUrl: file.kind === 'image' ? file.url : undefined // 图片保留本地预览地址，发送后继续展示
    }))

  // 构造用户消息并加入列表
  const userMsg: ChatMessage = {
    id: Date.now(),
    role: 'user',
    content: [{ type: 'text', data: text }],
    files: sentFiles.length ? sentFiles : undefined,
    status: 'complete',
    name: USER_META.name,
    avatar: USER_META.avatar,
    datetime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  chatStore.addMessage(userMsg)
  // 清空输入框内容
  inputText.value = ''
  // 图片预览地址已转存到消息里，这里不能释放
  filesList.value = []
  // 发起流式请求获取 AI 回复
  runAgentStream()
}

// ========== 清空对话：附件与会话一起作废 ==========
function handleClear() {
  // 释放发送区与历史消息里的图片预览地址
  filesList.value.forEach(revokePreviewUrl)
  chatStore.messageList.forEach(msg => msg.files?.forEach(file => {
    if (file.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
  }))
  chatStore.clearMessages()
  filesList.value = []
  // 旧对话里挂起的中断随对话一起作废
  pendingInterrupts = []
  activeAgent = null
  // 轮换会话 id 与线程 id，旧会话的临时附件不会再被检索到
  sessionId.value = createSessionId()
  threadId.value = createThreadId()
}

// ========== 重放某条 AI 回复 ==========
// 以被点击的消息为目标：丢掉这条回复以及它之后的所有消息（提问本身保留），再重新请求
async function onRetry(target?: ChatMessage) {
  // 生成中不允许重试
  if (chatStore.loading) return
  const list = chatStore.messageList
  // 未指定目标时退化为重放最后一条 AI 回复
  const index = target ? list.findIndex(item => item.id === target.id) : list.length - 1
  if (index < 0) return
  // 目标之前必须还有用户提问，否则没有可重放的上下文
  if (!list.slice(0, index).some(item => item.role === 'user')) return
  // 截断：目标消息之前的上下文原样保留
  chatStore.messageList.splice(index)
  // 重新发起请求
  runAgentStream()
}

// ========== 停止生成 ==========
function onStop() {
  // 中断当前 AG-UI run（HttpAgent 内部会 abort 对应的 fetch）
  abortRequested = true
  activeAgent?.abortRun()
}

// ========== 附件上传 ==========
const MAX_ATTACHMENTS = 5 // 单次对话最多 5 个附件
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024 // 单个附件上限 10MB
const ACCEPT_EXTS = ['.md', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'] // 与后端会话附件白名单保持一致
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] // 图片在发送区用本地预览图展示

// 组件把图片渲染成缩略图卡片，没有 url 时会一直显示 loading，所以本地先造一个预览地址
function createPreviewUrl(file: File) {
  const ext = `.${(file.name.split('.').pop() || '').toLowerCase()}`
  return IMAGE_EXTS.includes(ext) ? URL.createObjectURL(file) : undefined
}

function revokePreviewUrl(item?: SenderFile) {
  if (item?.url?.startsWith('blob:')) URL.revokeObjectURL(item.url)
}

// 字节数转可读大小
function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 已发送消息里的图片：有本地预览地址才能展示缩略图
function imageFiles(files?: ChatFile[]) {
  return (files || []).filter(file => file.kind === 'image' && file.previewUrl)
}

// 已发送消息里的文档：继续用文件卡片展示
function docFiles(files?: ChatFile[]) {
  return (files || []).filter(file => file.kind !== 'image')
}

// 按 key 局部更新某个附件，避免整体重建导致列表闪烁
function patchFile(key: string, patch: Partial<SenderFile>) {
  filesList.value = filesList.value.map(item => (item.key === key ? { ...item, ...patch } : item))
}

// 上传单个文件：用 XHR 才能拿到上传进度（fetch 不支持 upload progress）
function uploadOne(file: File) {
  const key = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  filesList.value = [
    {
      key,
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'progress',
      percent: 0,
      description: '上传中 0%',
      url: createPreviewUrl(file), // 图片卡片靠 url 显示缩略图
      rawFile: file
    },
    ...filesList.value
  ]

  const form = new FormData()
  form.append('sessionId', sessionId.value)
  form.append('file', file)

  const xhr = new XMLHttpRequest()
  xhr.open('POST', '/api/session-files/upload')
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    const percent = Math.round((event.loaded / event.total) * 100)
    patchFile(key, { percent, description: `上传中 ${percent}%` })
  }
  xhr.onload = () => {
    let payload: any = null
    try {
      payload = JSON.parse(xhr.responseText)
    } catch {
      payload = null
    }
    if (xhr.status >= 200 && xhr.status < 300 && payload?.ok) {
      const { id, chunkCount, size, kind } = payload.file
      patchFile(key, {
        status: 'success',
        percent: 100,
        fileId: id,
        chunkCount,
        kind: kind === 'image' ? 'image' : 'doc',
        description: kind === 'image'
          ? `${formatSize(size)} · 图片已就绪`
          : `${formatSize(size)} · 已解析 ${chunkCount} 个片段`
      })
    } else {
      const msg = payload?.error || `上传失败（${xhr.status}）`
      // filecard 失败态优先展示 response 字符串，这里按组件约定透传错误原因
      patchFile(key, { status: 'fail', response: msg as unknown as SenderFile['response'], description: msg })
    }
  }
  xhr.onerror = () => {
    patchFile(key, {
      status: 'fail',
      response: '网络异常，点击重试' as unknown as SenderFile['response'],
      description: '网络异常'
    })
  }
  xhr.send(form)
}

// 统一入口：类型/大小/数量校验，通过后逐个上传
function handleFiles(list: File[]) {
  if (!list.length) return
  const errors: string[] = []
  for (const file of list) {
    const ext = `.${(file.name.split('.').pop() || '').toLowerCase()}`
    if (!ACCEPT_EXTS.includes(ext)) {
      errors.push(`${file.name}：仅支持 ${ACCEPT_EXTS.join(' / ')}`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      errors.push(`${file.name}：超过 ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB`)
      continue
    }
    if (filesList.value.length >= MAX_ATTACHMENTS) {
      errors.push(`本次对话最多 ${MAX_ATTACHMENTS} 个附件`)
      break
    }
    uploadOne(file)
  }
  if (errors.length) MessagePlugin.warning(errors[0])
}

// 组件内置上传按钮的选择回调：图片与文档统一走同一条上传流程
const handleUploadFile = ({ files }: { files: File[]; name: string; e: Event }) => {
  handleFiles(files)
}

// 点击失败项重试
const handleFileClick = (e: CustomEvent<TdAttachmentItem>) => {
  const item = e.detail as SenderFile
  if (item?.status !== 'fail' || !item.rawFile) return
  filesList.value = filesList.value.filter(file => file.key !== item.key)
  uploadOne(item.rawFile)
}

// 移除附件：同步删除后端会话附件，避免继续被检索
const handleRemoveFile = (e: CustomEvent<TdAttachmentItem>) => {
  const detail = e.detail as SenderFile
  revokePreviewUrl(detail)
  filesList.value = filesList.value.filter(item => item.key !== detail.key)
  if (!detail.fileId) return
  fetch('/api/session-files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId.value, fileId: detail.fileId })
  }).catch(err => console.error('删除会话附件失败', err))
}

// ========== 拖拽 / 粘贴上传 ==========
function onDragEnter() {
  dragDepth += 1
  dragActive.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragActive.value = false
}
function onDrop(e: DragEvent) {
  dragDepth = 0
  dragActive.value = false
  handleFiles(Array.from(e.dataTransfer?.files || []))
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files || [])
  if (!files.length) return
  e.preventDefault()
  handleFiles(files)
}
const checkClick = () => {
  isChecked.value = !isChecked.value;
};
</script>

<style scoped lang="scss">
/* 两栏布局：左侧文档栏固定宽度，右侧聊天区自适应 */
.app-shell {
  display: flex;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  background: var(--td-bg-color-page);
}

.app-shell__aside {
  width: 268px;
  flex: none;
  border-right: 1px solid var(--td-component-stroke);
}

/* 抽屉里的文档面板去掉默认内边距（抽屉被 teleport 到 body，需用全局选择器） */
:global(.doc-drawer .t-drawer__body) {
  padding: 0;
}

/* 窄屏顶部栏：打开文档抽屉 */
.chat-header {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  padding-bottom: var(--td-comp-paddingTB-s);
  flex: none;
}

.chat-header__title {
  font-size: var(--td-font-size-title-small);
  font-weight: 600;
  color: var(--td-text-color-primary);
}

/* 聊天面板整体容器：在右侧区域内居中、纵向排列 */
.chat-container {
  flex: 1;
  min-width: 0;
  max-width: 900px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  box-sizing: border-box;
}

/* 顶部标题栏：左右分布（标题 + 清空按钮） */
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

/* 消息列表区域：占满剩余空间 */
.chat-list {
  flex: 1;
  margin-bottom: 16px;
}

/* 思考过程折叠区与正文之间的间距 */
.reason-wrap {
  margin-bottom: 8px;
}

/* 思考内容区加左右内边距，避免文字贴边 */
.reason-wrap ::part(t-chat__item__think__inner) {
  padding: 0 12px 12px;
}

/* ===== 服务端提示横幅 ===== */
.msg-notices {
  display: flex;
  flex-direction: column;
  gap: var(--td-comp-margin-xs);
  margin-bottom: var(--td-comp-margin-s);
}

.msg-notice {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  padding: var(--td-comp-paddingTB-xs) var(--td-comp-paddingLR-s);
  border: 1px solid var(--td-warning-color-3);
  border-radius: var(--td-radius-medium);
  background: var(--td-warning-color-1);
  color: var(--td-text-color-primary);
  font-size: var(--td-font-size-body-small);
}

.msg-notice__icon {
  flex: none;
  color: var(--td-warning-color);
}

/* ===== 用户消息内的附件卡片 ===== */
/* 用户消息里的图片：缩略图右对齐，圆角与气泡一致 */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-s);
}

.msg-image {
  display: block;
  width: 240px;
  max-width: 100%;
  max-height: 240px;
  object-fit: cover;
  border-radius: var(--td-radius-large);
  border: 1px solid var(--td-component-stroke);
  background: var(--td-bg-color-container);
}

.msg-files {
  display: flex;
  flex-direction: column;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-s);
}

.msg-file {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  min-width: 220px;
  max-width: 100%;
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium);
  background: var(--td-bg-color-container);
}

.msg-file__icon {
  flex: none;
  font-size: 20px;
  color: var(--td-brand-color);
}

.msg-file__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.msg-file__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-primary);
}

.msg-file__meta {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

/* ===== 工具调用步骤卡片 ===== */
.tool-steps {
  display: flex;
  flex-direction: column;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-s);
}

.tool-step {
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium);
  background: var(--td-bg-color-secondarycontainer);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  font-size: var(--td-font-size-body-small);
}

.tool-step__head {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
}

/* 状态圆点：执行中为品牌色，完成为成功色，失败为错误色 */
.tool-step__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--td-brand-color);

  &.is-done {
    background: var(--td-success-color);
  }

  &.is-error {
    background: var(--td-error-color);
  }

  &.is-waiting {
    background: var(--td-warning-color);
  }
}

.tool-step__name {
  font-weight: 500;
  color: var(--td-text-color-primary);
}

.tool-step__code {
  font-family: var(--td-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-secondary);
}

.tool-step__status {
  margin-left: auto;
  color: var(--td-text-color-placeholder);
}

/* 需要人工确认的操作 */
.tool-step__approval {
  margin-top: var(--td-comp-margin-s);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-s);
  border-radius: var(--td-radius-small);
  background: var(--td-warning-color-1, #fff1e9);
}

.tool-step__approval-text {
  color: var(--td-text-color-primary);
  margin-bottom: var(--td-comp-margin-s);
}

.tool-step__approval-actions {
  display: flex;
  gap: var(--td-comp-margin-s);
}

.tool-step__row {
  display: flex;
  align-items: flex-start;
  gap: var(--td-comp-margin-s);
  margin-top: var(--td-comp-margin-xs);
}

.tool-step__label {
  flex: none;
  color: var(--td-text-color-placeholder);
}

.tool-step__value {
  font-family: var(--td-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--td-text-color-secondary);
  white-space: pre-wrap;
  word-break: break-all;

  &.is-error {
    color: var(--td-error-color);
  }
}

/* ===== 引用来源区块 ===== */
.sources {
  margin-top: var(--td-comp-margin-m);
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium);
  background: var(--td-bg-color-container);
  overflow: hidden;
}

.sources__head {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-xs);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  border-bottom: 1px solid var(--td-component-stroke);
  font-size: var(--td-font-size-body-small);
  font-weight: 500;
  color: var(--td-text-color-secondary);
}

.sources__icon {
  color: var(--td-brand-color);
}

.sources__count {
  margin-left: auto;
  padding: 0 8px;
  border-radius: 10px;
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: 12px;
}

.source-item + .source-item {
  border-top: 1px solid var(--td-component-stroke);
}

.source-item__head {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  width: 100%;
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color 0.2s;

  &:hover {
    background: var(--td-bg-color-secondarycontainer);
  }
}

.source-item__index {
  flex: none;
  width: 18px;
  height: 18px;
  line-height: 18px;
  border-radius: 4px;
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: 12px;
  text-align: center;
}

.source-item__file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-primary);
}

.source-item__score {
  flex: none;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

/* 来源类型标签：区分知识库与本次会话附件 */
.source-item__type {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 18px;

  &.is-kb {
    background: var(--td-brand-color-light);
    color: var(--td-brand-color);
  }

  &.is-file {
    background: var(--td-warning-color-1);
    color: var(--td-warning-color);
  }
}

.source-item__arrow {
  flex: none;
  color: var(--td-text-color-placeholder);
  transition: transform 0.2s;

  &.is-open {
    transform: rotate(180deg);
  }
}

.source-item__body {
  margin-left: var(--td-comp-margin-m);
  padding: 0 var(--td-comp-paddingLR-m) var(--td-comp-paddingTB-m);
  border-left: 2px solid var(--td-brand-color-light);
  font-size: var(--td-font-size-body-small);
  line-height: 1.7;
  color: var(--td-text-color-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== 发送区包裹层：承载拖拽/粘贴与规则提示 ===== */
.sender-wrap {
  position: relative;
  flex: none;
}

/* 拖拽悬停提示：覆盖整个发送区 */
.drop-hint {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--td-brand-color);
  border-radius: var(--td-radius-large);
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: var(--td-font-size-body-small);
  pointer-events: none;
}

/* 上传规则提示：常驻发送区下方 */
.sender-hint {
  margin-top: var(--td-comp-margin-xs);
  font-size: 12px;
  line-height: 18px;
  color: var(--td-text-color-placeholder);
  text-align: center;
}

/* ===== 发送按钮：强制正圆形，覆盖 TDesign Button 默认 min-width/padding ===== */
:deep(.t-chat-sender__button .t-chat-sender__button__default) {
  padding: 0 !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
  aspect-ratio: 1 / 1 !important;
  width: 32px !important;
  height: 32px !important;
  border-radius: 50% !important;
}

/* ===== 操作栏按钮：垂直居中对齐 ===== */
:deep(.t-chat__actions) {
  align-items: center;
}

:deep(.t-chat__actions .t-space) {
  display: flex;
  align-items: center;
}

:deep(.t-chat__actions .t-button) {
  min-width: 0;
  box-sizing: border-box;
}

.btn {
  color: var(--td-text-color-disabled);
  border: none;

  &:hover {
    color: var(--td-brand-color-hover);
    border: none;
    background: none;
  }
}

.btn.t-button {
  height: var(--td-comp-size-m);
  padding: 0;
}

.model-select {
  display: flex;
  align-items: center;
  .t-select__wrap{
    margin-right: var(--td-comp-margin-s);

  }
  .t-select {
    width: 112px;
    height: var(--td-comp-size-m);

    :deep(.t-input) {
      border-radius: var(--td-radius-round);
      padding: 0 15px;
    }

    :deep(.t-input.t-is-focused) {
      box-shadow: none;
    }
  }

  .check-box.t-button {
    border-radius: var(--td-radius-round);
    padding: 0 20px;
    box-sizing: border-box;
  }
}

:deep(.t-button__text) {
  display: flex;
  align-items: center;
  justify-content: center;

  span {
    margin-left: var(--td-comp-margin-s);
  }
}
</style>
