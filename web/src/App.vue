<template>
  <!-- 未登录：整屏登录门，不挂载任何业务组件（也就不会发出任何未鉴权请求） -->
  <LoginGate v-if="!authed" @authenticated="onAuthenticated" />
  <!-- 登录后：整体两栏布局：左侧知识库文档栏 + 右侧聊天区 -->
  <div v-else class="app-shell">
    <!-- 右上角账号角标：历史会话切换 + 当前用户 + 登出入口 -->
    <div class="account-badge">
      <t-select class="thread-select" :value="threadSelectValue" :options="threadOptions" :loading="threadsLoading"
        placeholder="历史会话" size="small" @visible-change="onThreadsVisible" @change="onPickThread" />
      <span class="account-badge__name">{{ currentUser?.username }}</span>
      <t-button variant="text" size="small" @click="startNewThread">新会话</t-button>
      <t-button variant="text" size="small" @click="onLogout">退出</t-button>
    </div>

    <!-- 桌面端：文档 / 候选人侧栏常驻左侧 -->
    <SidePanel v-if="!isNarrow" class="app-shell__aside" @ask="onSend" />

    <!-- 窄屏：侧栏收进左侧抽屉 -->
    <t-drawer v-else v-model:visible="docDrawerVisible" placement="left" size="280px" :header="false"
      :footer="false" class="doc-drawer">
      <SidePanel class="app-shell__drawer-panel" @ask="onSend" />
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
      <t-chat-message v-for="msg in viewMessages" :key="msg.id" :role="msg.role" :status="msg.status"
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
                  <span class="source-item__score">相关度 {{ source.score.toFixed(3) }}</span>
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
            { name: 'uploadAttachment', uploadProps: { accept: '.md,.pdf,.docx' } },
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
import { ref, computed, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useMediaQuery } from '@vueuse/core'
// 引入聊天 store（管理消息列表、loading 状态等）
import { useChatStore, USER_META, ASSISTANT_META } from './store/chat'
// AG-UI 事件里的消息 / 中断类型（真正的请求由 chatEngine 发出）
import type { Message, Interrupt, ResumeEntry } from '@ag-ui/core'
// 左侧栏（文档 / 候选人两个页签）
import SidePanel from './components/SidePanel.vue'
// 登录门：未登录时替代整个主界面
import LoginGate from './components/LoginGate.vue'
// 鉴权：token 存取、请求头、401 统一处理
import { isLoggedIn, currentUser, authHeaders, logout as apiLogout, setUnauthorizedHandler, request } from './api/auth'
// 引入文件上传组件类型定义
import type { TdAttachmentItem } from '@tdesign-vue-next/chat/es/index'
import { useChat } from '@tdesign-vue-next/chat/es/chat-engine'
import { MessagePlugin } from 'tdesign-vue-next'
import { SystemSumIcon, InfoCircleIcon, MenuIcon, BookmarkIcon, ChevronDownIcon, FileIcon } from 'tdesign-icons-vue-next';
// 引入消息类型定义
import type { ChatMessage, ChatFile, ToolStep, RagSource } from './store/chat'
// AG-UI 共享状态维护（STATE_SNAPSHOT 替换 / STATE_DELTA 增量合并）
import { applyStateDelta, applyStateSnapshot, cloneAgentState } from './agui/agentState'

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

// ========== 登录门 ==========
// authed 决定整个主界面是否挂载：登出/401 时置 false，所有业务组件随之卸载，
// 不会再有任何带旧 token 的请求发出去
const authed = ref(isLoggedIn())
setUnauthorizedHandler(() => {
  authed.value = false
  MessagePlugin.warning('登录已失效，请重新登录')
})
function onAuthenticated() {
  authed.value = true
}
async function onLogout() {
  await apiLogout()
  // 清掉本地持久化的消息与共享状态：换账号登录时不能看到上一个人的会话
  chatStore.clearMessages()
  chatStore.agentState = {}
  // 线程 id 一起作废：下一账号第一次进来自动回到新会话
  chatStore.threadId = ''
  threadsList.value = []
  authed.value = false
}

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
// 用户是否点了"停止生成"：中断在引擎里可能被包装成普通错误，用它兜底判断
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
// AG-UI 的线程标识：同一次对话复用，清空对话时轮换。
// 从持久化里恢复：刷新后必须继续写同一个线程，否则服务端落库的历史与新消息对不上
function createThreadId() {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
const threadId = ref(chatStore.threadId || createThreadId())
watch(threadId, value => {
  chatStore.threadId = value
})
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

// ========== 引擎消息模型：messages 是唯一消息真相源 ==========
// 引擎消息（useChat 的 messages）：role + content 内容块数组，由 AG-UI 事件驱动
type EngineContent = {
  type: string
  data?: any
  status?: string
  strategy?: 'merge' | 'append'
  id?: string
}
type EngineMessage = {
  id: string
  role: string
  content?: EngineContent[]
  status?: string
  datetime?: string
}

// ========== AG-UI 共享状态 ==========
// 服务端下发的 state 存在 pinia 里并持久化：STATE_SNAPSHOT 整体替换、STATE_DELTA 增量合并，
// 每次 RunAgentInput 原样回传，服务端据此恢复 sources 等跨轮信息（刷新后也能延续）

// ========== UI 附属状态（sidecar） ==========
// 只存“引擎消息里没有、但界面需要”的信息，全部按引擎消息 id / toolCallId 关联
const sourcesByMessageId = reactive(new Map<string, RagSource[]>())
const noticesByMessageId = reactive(new Map<string, string[]>())
const collapsedByMessageId = reactive(new Map<string, boolean>())
const stoppedByMessageId = reactive(new Set<string>())
const errorByMessageId = reactive(new Map<string, string>())
const toolOutputById = reactive(new Map<string, string>())
const toolErrorById = reactive(new Map<string, string>())
const approvalByToolCallId = reactive(new Map<string, { interruptId: string; message?: string }>())

// 展示用：引擎同步给 Vue 的响应式副本（滞后一个微任务，但会触发重渲染）
function engineList(): EngineMessage[] {
  return (messages.value || []) as unknown as EngineMessage[]
}

// 请求体用：直接读引擎 messageStore 的同步状态。
// messageStore 的订阅通知是 queueMicrotask，发请求时 messages 可能还没刷新，
// 直接读 store 才能保证 body.messages 一定包含刚插入的用户消息。
function requestList(): EngineMessage[] {
  const state = chatEngine.value?.messageStore?.getState(false)
  return (Array.isArray(state?.messages) ? state.messages : engineList()) as unknown as EngineMessage[]
}

// 取消息正文：按 toolcall 块切段，只取最后一段非空文本。
// 原因是模型常在调用工具前先说一遍结论、拿到结果后又重说一遍，
// 引擎会把两段都塞进同一条消息，直接拼接就会出现「10 × 89 = 890*10 × 89 = 890*」这种重复。
function textOf(message: EngineMessage): string {
  const segments: string[] = []
  let current = ''
  for (const block of message.content || []) {
    if (block.type.startsWith('toolcall')) {
      segments.push(current)
      current = ''
      continue
    }
    if (block.type === 'markdown' || block.type === 'text' || block.type === 'system-text') {
      current += typeof block.data === 'string' ? block.data : ''
    }
  }
  segments.push(current)
  // 有工具调用时优先展示工具之后的最终回答；没有后续文本则退回工具前的说明
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].trim()) return segments[i]
  }
  return ''
}

function reasonOf(message: EngineMessage): string {
  return (message.content || [])
    .filter(block => block.type === 'thinking')
    .map(block => (typeof block.data?.text === 'string' ? block.data.text : ''))
    .join('')
}

// 用户消息的附件存进 attachment 内容块，metadata 里保留完整的 ChatFile
function attachmentsOf(message: EngineMessage): ChatFile[] {
  const block = (message.content || []).find(item => item.type === 'attachment' && Array.isArray(item.data))
  if (!block) return []
  return (block.data as Array<{ metadata?: ChatFile }>)
    .map(item => item?.metadata)
    .filter((file): file is ChatFile => Boolean(file?.fileId))
}

function chatFileToAttachment(file: ChatFile) {
  return {
    fileType: file.kind === 'image' ? ('image' as const) : ('pdf' as const),
    size: file.size,
    name: file.fileName,
    url: file.previewUrl,
    metadata: file
  }
}

function formatMessageTime(datetime?: string): string {
  if (!datetime) return ''
  if (/^\d{2}:\d{2}$/.test(datetime)) return datetime
  const numeric = Number(datetime)
  const date = new Date(Number.isFinite(numeric) && String(datetime).length >= 12 ? numeric : datetime)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 工具结果可能被引擎合并到“当前消息”或“上一轮消息”的 toolcall 块里，
// 这里对全部消息（含快照前缀）做一次统一的 id -> 工具数据索引
function collectToolData(list: EngineMessage[] = engineList()): Map<string, Record<string, any>> {
  const map = new Map<string, Record<string, any>>()
  for (const message of list) {
    if (message.role !== 'assistant') continue
    for (const block of message.content || []) {
      if (!block.type.startsWith('toolcall')) continue
      const data = block.data
      if (typeof data?.toolCallId === 'string') map.set(data.toolCallId, data)
    }
  }
  return map
}

function parseToolArgs(args?: unknown): unknown {
  if (typeof args !== 'string' || !args) return undefined
  try {
    return JSON.parse(args)
  } catch {
    return undefined
  }
}

function toolStepsOf(message: EngineMessage, toolData: Map<string, Record<string, any>>): ToolStep[] {
  const steps: ToolStep[] = []
  for (const block of message.content || []) {
    if (!block.type.startsWith('toolcall')) continue
    const id = typeof block.data?.toolCallId === 'string' ? block.data.toolCallId : ''
    if (!id || steps.some(step => step.id === id)) continue
    const data = toolData.get(id) || block.data || {}
    const approval = approvalByToolCallId.get(id)
    const error = toolErrorById.get(id)
    const engineOutput = typeof data.result === 'string' ? data.result : undefined
    const localOutput = toolOutputById.get(id)
    steps.push({
      id,
      name: (typeof data.toolCallName === 'string' && data.toolCallName) || toolCallNames.get(id) || id,
      input: parseToolArgs(data.args),
      output: engineOutput ?? localOutput,
      error,
      status: approval ? 'waiting' : error ? 'error' : engineOutput !== undefined || localOutput !== undefined ? 'done' : 'running',
      approval: approval ? { interruptId: approval.interruptId, message: approval.message } : undefined
    })
  }
  return steps
}

function hasFollowingAssistant(list: EngineMessage[], index: number): boolean {
  for (let i = index + 1; i < list.length; i += 1) {
    if (list[i].role === 'user') return false
    if (list[i].role === 'assistant') return true
  }
  return false
}

function mergeSources(base: RagSource[], extra: RagSource[]): RagSource[] {
  const result = [...base]
  for (const source of extra) {
    if (!result.some(item => item.fileName === source.fileName && item.content === source.content)) result.push(source)
  }
  return result
}

// 用户消息 -> 展示模型
function userView(message: EngineMessage, index: number): ChatMessage {
  const files = attachmentsOf(message)
  return {
    id: message.id,
    engineIndex: index,
    role: 'user',
    content: [{ type: 'text', data: textOf(message) }],
    files: files.length ? files : undefined,
    status: 'complete',
    name: USER_META.name,
    avatar: USER_META.avatar,
    datetime: formatMessageTime(message.datetime)
  }
}

// AI 消息 -> 展示模型：正文/思考过程来自引擎，来源/提示/折叠/停止/错误来自 sidecar
function assistantView(
  message: EngineMessage,
  index: number,
  steps: ToolStep[],
  sources: RagSource[],
  notices: string[]
): ChatMessage {
  const errorMsg = errorByMessageId.get(message.id)
  const streaming = message.status === 'pending' || message.status === 'streaming'
  if (errorMsg) {
    return {
      id: message.id,
      engineIndex: index,
      role: 'assistant',
      content: [{ type: 'markdown', data: `❌ ${errorMsg}` }],
      status: 'complete',
      error: true,
      errorMsg,
      name: ASSISTANT_META.name,
      avatar: ASSISTANT_META.avatar,
      datetime: formatMessageTime(message.datetime)
    }
  }
  return {
    id: message.id,
    engineIndex: index,
    role: 'assistant',
    content: [{ type: 'markdown', data: textOf(message) }],
    status: streaming ? 'streaming' : 'complete',
    reasonContent: reasonOf(message) || undefined,
    thinkingCollapsed: collapsedByMessageId.get(message.id) ?? false,
    toolSteps: steps.length ? steps : undefined,
    notices: notices.length ? notices : undefined,
    sources: sources.length ? sources : undefined,
    stopped: stoppedByMessageId.has(message.id) || undefined,
    name: ASSISTANT_META.name,
    avatar: ASSISTANT_META.avatar,
    datetime: formatMessageTime(message.datetime)
  }
}

// 展示模型：直接由引擎消息派生；只含工具调用的 AI 消息并入下一条真正有正文的回复（保持单气泡）
const viewMessages = computed<ChatMessage[]>(() => {
  const list = engineList()
  const toolData = collectToolData()
  const result: ChatMessage[] = []
  let pendingSteps: ToolStep[] = []
  let pendingSources: RagSource[] = []
  let pendingNotices: string[] = []
  const flushPending = () => {
    pendingSteps = []
    pendingSources = []
    pendingNotices = []
  }

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    if (message.role === 'user') {
      flushPending()
      result.push(userView(message, index))
      continue
    }
    if (message.role !== 'assistant') continue

    const steps = toolStepsOf(message, toolData)
    const sources = sourcesByMessageId.get(message.id) || []
    const notices = noticesByMessageId.get(message.id) || []
    const hasText = Boolean(textOf(message).trim() || reasonOf(message).trim())

    if (!hasText) {
      const mergedSteps = [...pendingSteps, ...steps]
      const mergedSources = mergeSources(pendingSources, sources)
      const mergedNotices = [...pendingNotices, ...notices]
      if (hasFollowingAssistant(list, index)) {
        pendingSteps = mergedSteps
        pendingSources = mergedSources
        pendingNotices = mergedNotices
        continue
      }
      result.push(assistantView(message, index, mergedSteps, mergedSources, mergedNotices))
      flushPending()
      continue
    }

    result.push(
      assistantView(message, index, [...pendingSteps, ...steps], mergeSources(pendingSources, sources), [...pendingNotices, ...notices])
    )
    flushPending()
  }

  return result
})

// 把展示模型写回 pinia，仅用于刷新恢复（刷新后作为 useChat 的 defaultMessages）
function persistViewSnapshot() {
  chatStore.messageList = viewMessages.value
    .filter(msg => msg.role !== 'assistant' || getMsgText(msg).trim() || msg.toolSteps?.length || msg.error)
    .map(msg => ({
      ...msg,
      content: msg.content.map(item => ({ ...item })),
      toolSteps: msg.toolSteps?.map(step => ({ ...step, approval: step.approval ? { ...step.approval } : undefined }))
    }))
}

// 事件回调是同步执行的，引擎把新状态同步到 messages 走的是 queueMicrotask；
// 延后一拍再持久化，避免快照落后最后一帧内容
function persistViewSnapshotSoon() {
  queueMicrotask(persistViewSnapshot)
}

// 刷新恢复：持久化的展示模型 -> 引擎消息（内容块格式）
function chatMessageToEngine(msg: ChatMessage): EngineMessage {
  const text = getMsgText(msg)
  const content: EngineContent[] = []
  if (msg.role === 'user') {
    if (msg.files?.length) content.push({ type: 'attachment', data: msg.files.map(chatFileToAttachment) })
    content.push({ type: 'text', data: text })
  } else {
    if (msg.reasonContent) {
      content.push({ type: 'thinking', data: { text: msg.reasonContent, title: '思考过程' }, status: 'complete', strategy: 'append' })
    }
    for (const step of msg.toolSteps || []) {
      content.push({
        type: `toolcall-${step.name}-${step.id}`,
        data: {
          toolCallId: step.id,
          toolCallName: step.name,
          args: JSON.stringify(step.input ?? {}),
          result: step.output ?? ''
        },
        status: 'complete',
        strategy: 'append'
      })
    }
    content.push({ type: 'markdown', data: text, status: 'complete', strategy: 'append' })
  }
  return {
    id: String(msg.id),
    role: msg.role,
    content,
    status: 'complete',
    datetime: msg.datetime
  }
}

// 刷新恢复：把展示模型上的附属状态放回 sidecar
function restoreSidecars(list: ChatMessage[]) {
  for (const msg of list) {
    const id = String(msg.id)
    if (msg.sources?.length) sourcesByMessageId.set(id, msg.sources.map(item => ({ ...item })))
    if (msg.notices?.length) noticesByMessageId.set(id, [...msg.notices])
    if (msg.thinkingCollapsed !== undefined) collapsedByMessageId.set(id, Boolean(msg.thinkingCollapsed))
    if (msg.stopped) stoppedByMessageId.add(id)
    if (msg.errorMsg) errorByMessageId.set(id, msg.errorMsg)
    for (const step of msg.toolSteps || []) {
      if (step.output) toolOutputById.set(step.id, step.output)
      if (step.error) toolErrorById.set(step.id, step.error)
      // 刷新后旧 run 已结束，审批按钮不可再续跑
      if (step.approval) toolErrorById.set(step.id, '页面已刷新，该操作已失效')
    }
  }
}

function clearSidecars() {
  sourcesByMessageId.clear()
  noticesByMessageId.clear()
  collapsedByMessageId.clear()
  stoppedByMessageId.clear()
  errorByMessageId.clear()
  toolOutputById.clear()
  toolErrorById.clear()
  approvalByToolCallId.clear()
}

function pruneSidecars(keepIds: Set<string>) {
  for (const key of [...sourcesByMessageId.keys()]) if (!keepIds.has(key)) sourcesByMessageId.delete(key)
  for (const key of [...noticesByMessageId.keys()]) if (!keepIds.has(key)) noticesByMessageId.delete(key)
  for (const key of [...collapsedByMessageId.keys()]) if (!keepIds.has(key)) collapsedByMessageId.delete(key)
  for (const key of [...stoppedByMessageId]) if (!keepIds.has(key)) stoppedByMessageId.delete(key)
  for (const key of [...errorByMessageId.keys()]) if (!keepIds.has(key)) errorByMessageId.delete(key)
}

// 引擎消息 -> AG-UI 请求体：assistant 带 toolCalls，工具结果单独作为 tool 消息
function engineMessagesToAgui(suppressToolCallIds?: Set<string>): Message[] {
  const list = requestList()
  const toolData = collectToolData(list)
  const messages: Message[] = []
  for (const message of list) {
    if (message.role === 'user') {
      const text = textOf(message)
      if (text.trim()) messages.push({ id: message.id, role: 'user', content: text })
      continue
    }
    if (message.role !== 'assistant') continue
    // 失败的消息（❌ 文案）不入上下文
    if (errorByMessageId.has(message.id)) continue

    const text = textOf(message)
    const steps = toolStepsOf(message, toolData)
    if (!text.trim() && !steps.length) continue

    // 被用户中止的轮次要显式标注，否则模型会把放弃的问题当成"还没回答"继续补答
    const answer = stoppedByMessageId.has(message.id)
      ? `${text}${text ? '\n\n' : ''}（用户已中止本轮回答）`
      : text

    if (!steps.length) {
      messages.push({ id: message.id, role: 'assistant', content: answer })
      continue
    }

    messages.push({
      id: message.id,
      role: 'assistant',
      content: answer,
      toolCalls: steps.map(step => ({
        id: step.id,
        type: 'function' as const,
        function: { name: step.name, arguments: JSON.stringify(step.input ?? {}) }
      }))
    })
    // 每个 toolCall 都必须配一条结果，悬空的调用会让下一轮请求非法；
    // 等待确认的调用说明用户已经放弃，按"未确认已取消"补一条结果
    for (const step of steps) {
      // resume 时等待中的调用由服务端状态处理，这里不再补造结果消息
      if (suppressToolCallIds?.has(step.id)) continue
      messages.push({
        id: `${message.id}-${step.id}`,
        role: 'tool',
        toolCallId: step.id,
        content: step.status === 'waiting'
          ? '用户未确认该操作，已取消'
          : step.error
            ? `工具执行失败：${step.error}`
            : step.output || '（该工具没有返回内容）'
      })
    }
  }
  return messages
}

// 思考过程折叠切换：更新对应消息的折叠状态
// 注意：omi-vueify 转发 web component 事件时传入的是 CustomEvent 对象，布尔值在 .detail 中
function onThinkingCollapse(msg: ChatMessage, val: unknown) {
  const collapsed = val instanceof CustomEvent ? val.detail : val
  collapsedByMessageId.set(String(msg.id), Boolean(collapsed))
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

// 监听展示模型变化，DOM 更新后自动滚动到底部（流式输出时持续滚动）
// 注意：必须放在 useChat 之后注册，因为 watch 会立即求值 computed（messages 尚未初始化会触发 TDZ）
function setupScrollWatcher() {
  watch(
    viewMessages,
    async () => {
      await nextTick()
      chatListRef.value?.scrollToBottom()
    },
    { deep: true } // 深度监听，消息内部 content 变化也能触发
  )
}

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
function toggleSource(msgId: string | number, index: number) {
  const key = `${msgId}-${index}`
  openSourceKey.value = openSourceKey.value === key ? '' : key
}
function isSourceOpen(msgId: string | number, index: number) {
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

// ========== 流式请求：全部交给 chatEngine ==========
// 全局挂起的中断：服务端暂停后，用户点"允许/拒绝"时带上 resume 续跑
let pendingInterrupts: Interrupt[] = []
// 当前 run 对应的 AI 消息 id（事件里拿不到 messageId 时兜底）
let activeAiId = ''
// 前端工具调用的名称：服务端只执行自己的工具，这些留给浏览器执行
const toolCallNames = new Map<string, string>()
// 一次提问已经续跑了几轮，超过上限就停下，避免工具调用死循环
let toolRounds = 0


// ===== 引擎事件接入 =====
const EVENT_STREAM = 'request:stream'
const EVENT_RUN_ERROR = 'agui:run:error'
const EVENT_REQUEST_COMPLETE = 'request:complete'
const EVENT_REQUEST_ABORT = 'request:abort'
const EVENT_REQUEST_ERROR = 'request:error'

// 有 START、还没有 RESULT 的工具（服务端不执行，留给浏览器）
const activeToolIds = new Set<string>()
// 只订阅一次：重复订阅会让每个增量被重复处理
let eventsBound = false
const unsubscribeEvents: Array<() => void> = []

// 引擎实例上的 eventBus：IChatEngine 类型里没暴露，但运行时存在
type AgentEventBus = {
  on(event: string, callback: (payload: any) => void): () => void
}

function currentAiId(messageId?: unknown): string {
  if (typeof messageId === 'string' && messageId) activeAiId = messageId
  return activeAiId
}

function lastAssistantId(): string {
  const list = engineList()
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return list[i].id
  }
  return ''
}

function setupAgentEvents() {
  const bus = (chatEngine.value as unknown as { eventBus?: AgentEventBus } | undefined)?.eventBus
  // 引擎还没就绪，或已经订阅过：直接返回，避免同一个事件被重复处理
  if (!bus || eventsBound) return
  eventsBound = true

  unsubscribeEvents.push(
    bus.on(EVENT_STREAM, ({ messageId, chunk }) => {
      currentAiId(messageId)
      // 展示层直接由引擎 messages 派生，这里只处理引擎不落库的控制信息
      const raw = chunk?.data
      if (!raw?.type) return

      if (raw.type === 'TOOL_CALL_START') {
        if (typeof raw.toolCallId === 'string') {
          activeToolIds.add(raw.toolCallId)
          if (raw.toolCallName) toolCallNames.set(raw.toolCallId, raw.toolCallName)
        }
        return
      }
      if (raw.type === 'TOOL_CALL_RESULT') {
        if (typeof raw.toolCallId === 'string') activeToolIds.delete(raw.toolCallId)
        return
      }
      if (raw.type === 'STATE_SNAPSHOT') {
        // 全量状态：整体替换客户端持有的 state
        chatStore.agentState = applyStateSnapshot(raw.snapshot)
        return
      }
      if (raw.type === 'STATE_DELTA') {
        // 增量状态：先按 JSON Patch 合并，再挑出 sources 挂到当前 AI 消息上展示
        chatStore.agentState = applyStateDelta(chatStore.agentState, raw.delta ?? [])
        const sources = (raw.delta ?? [])
          .filter((p: any) => p.op === 'add' && p.path === '/sources/-' && p.value)
          .map((p: any) => p.value as RagSource)
        const id = currentAiId(messageId)
        if (sources.length && id) {
          sourcesByMessageId.set(id, mergeSources(sourcesByMessageId.get(id) || [], sources))
        }
        return
      }
      if (raw.type === 'CUSTOM') {
        const value = raw.value ?? {}
        const id = currentAiId(messageId)
        if (raw.name === 'trim_notice' && value.content && id) {
          const list = noticesByMessageId.get(id) || []
          if (!list.includes(value.content)) noticesByMessageId.set(id, [...list, value.content])
        } else if (raw.name === 'tool_error' && value.toolCallId) {
          toolErrorById.set(value.toolCallId, value.message || '工具执行失败')
        }
        return
      }
      if (raw.type === 'RUN_FINISHED') onRunFinished(raw.outcome, messageId)
    }),
    // 流结束 / 用户停止 / 请求失败：统一收口 loading 与 sidecar
    bus.on(EVENT_REQUEST_COMPLETE, ({ messageId }) => {
      currentAiId(messageId)
      chatStore.loading = false
      persistViewSnapshotSoon()
      // 服务端在 res.end 前已完成落库，这里刷新会话列表即可看到本轮对话
      void refreshThreads()
    }),
    bus.on(EVENT_REQUEST_ABORT, ({ messageId }) => {
      const id = currentAiId(messageId)
      chatStore.loading = false
      if (id) stoppedByMessageId.add(id)
      abandonActiveTools('用户已停止生成，工具未执行')
      persistViewSnapshotSoon()
    }),
    bus.on(EVENT_REQUEST_ERROR, ({ messageId, error }) => {
      const id = currentAiId(messageId)
      chatStore.loading = false
      if (abortRequested) {
        if (id) stoppedByMessageId.add(id)
        abandonActiveTools('用户已停止生成，工具未执行')
        persistViewSnapshotSoon()
        return
      }
      if (id) errorByMessageId.set(id, (error as any)?.message || '请求出错')
      abandonActiveTools('请求出错，工具未执行')
      persistViewSnapshotSoon()
    }),
    bus.on(EVENT_RUN_ERROR, ({ error }) => {
      chatStore.loading = false
      if (abortRequested || (error as any)?.code === 'abort' || /abort/i.test((error as any)?.message ?? '')) {
        if (activeAiId) stoppedByMessageId.add(activeAiId)
        abandonActiveTools('用户已停止生成，工具未执行')
        persistViewSnapshotSoon()
        return
      }
      if (activeAiId) errorByMessageId.set(activeAiId, (error as any)?.message || '请求出错')
      abandonActiveTools('请求出错，工具未执行')
      persistViewSnapshotSoon()
    })
  )
}

// 取消订阅：组件卸载或清空会话时调用，避免监听器越积越多
function teardownAgentEvents() {
  unsubscribeEvents.splice(0).forEach(off => off())
  eventsBound = false
}

// 本轮收尾：RUN_FINISHED 里没结果的前端工具在这里本地执行并续跑
function onRunFinished(outcome?: any, messageId?: string) {
  currentAiId(messageId)
  if (outcome?.type === 'interrupt') {
    pendingInterrupts = Array.isArray(outcome.interrupts) ? outcome.interrupts : []
    for (const it of pendingInterrupts) {
      if (it.toolCallId) approvalByToolCallId.set(it.toolCallId, { interruptId: it.id, message: it.message })
    }
    persistViewSnapshotSoon()
    return
  }

  // 有 START 没 RESULT = 服务端交给浏览器执行的工具
  const pendingIds = [...activeToolIds]
  activeToolIds.clear()
  if (pendingIds.length) void runFrontendTools(pendingIds)
}

// 在浏览器执行前端工具，把结果写进 sidecar；续跑请求会从 messages 里带上 tool 结果
async function runFrontendTools(ids: string[]) {
  if (toolRounds >= MAX_TOOL_ROUNDS) {
    for (const id of ids) toolErrorById.set(id, '工具调用轮数超过上限，已停止续跑')
    persistViewSnapshotSoon()
    return
  }
  toolRounds += 1

  const toolData = collectToolData(requestList())
  for (const id of ids) {
    const data = toolData.get(id)
    const name = (typeof data?.toolCallName === 'string' && data.toolCallName) || toolCallNames.get(id) || ''
    const input = (parseToolArgs(data?.args) ?? {}) as Record<string, unknown>
    const localTool = FRONTEND_TOOL_MAP.get(name)

    if (!localTool) {
      toolErrorById.set(id, `前端未注册工具 ${name || id}`)
    } else {
      try {
        toolOutputById.set(id, String(await localTool.execute(input)))
      } catch (err: any) {
        toolErrorById.set(id, err?.message || String(err))
      }
    }

    toolCallNames.delete(id)
  }

  chatStore.loading = true
  // resumeRun 会新建一条 AI 消息并再发一次请求，body 由 onRequest 从 messages 重建（已含工具结果）
  try {
    await chatEngine.value?.resumeRun({})
  } catch (err: any) {
    chatStore.loading = false
    const id = lastAssistantId()
    if (id) errorByMessageId.set(id, err?.message || '工具续跑失败')
  }
}

// ========== 初始化引擎：messages 是唯一消息真相源 ==========
// 刷新恢复：把持久化的展示模型转成引擎消息（内容块格式），同时恢复 UI 附属状态
const restoredMessages = chatStore.messageList
restoreSidecars(restoredMessages)
const { chatEngine, messages } = useChat({
  defaultMessages: restoredMessages.map(chatMessageToEngine) as unknown as Parameters<typeof useChat>[0]['defaultMessages'],
  chatServiceConfig: {
    endpoint: '/agui',
    protocol: 'agui',      // 响应侧：引擎自动解析服务端的 AG-UI 事件
    transport: 'sse',
    // 请求侧：引擎不管 body，这里从 messages 现拼；resume 用于中断确认后的续跑
    onRequest: (params) => ({
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(buildAguiBody((params as { resume?: ResumeEntry[] } | undefined)?.resume))
    })
  }
})

// messages 已初始化，可以安全注册滚动监听
setupScrollWatcher()

function buildAguiBody(resume?: ResumeEntry[]): Record<string, unknown> {
  // resume 时，把等待中的工具从历史里"摘掉"结果消息，理由见下面陷阱 ②
  const suppress = resume ? new Set(resume.map(r => r.interruptId.replace(/^int_/, ''))) : undefined
  return {
    threadId: threadId.value,        // 服务端 input.threadId，做日志/兜底
    runId: crypto.randomUUID(),      // input.runId
    state: cloneAgentState(chatStore.agentState), // input.state，回传客户端持有的共享状态
    messages: engineMessagesToAgui(suppress),  // input.messages，**必填**，缺了直接 400
    tools: frontendToolDefinitions,  // input.tools，前端工具定义
    forwardedProps: { sessionId: sessionId.value }, // input.forwardedProps.sessionId
    ...(resume?.length ? { resume } : {})  // input.resume 在**顶层**，不是 forwardedProps
  }
}

// 新提问意味着放弃上次未确认的中断
function abandonPendingInterrupts() {
  if (!pendingInterrupts.length) return
  for (const interrupt of pendingInterrupts) {
    const toolCallId = interrupt.toolCallId
    if (!toolCallId) continue
    approvalByToolCallId.delete(toolCallId)
    toolErrorById.set(toolCallId, '用户未确认该操作，已取消')
    // 中断的调用已被放弃，不要再当成"待前端执行"的工具
    activeToolIds.delete(toolCallId)
  }
  pendingInterrupts = []
}

// 每次发起 run 前重置本轮工具状态
function resetRunState() {
  activeToolIds.clear()
  toolCallNames.clear()
  toolRounds = 0
  abortRequested = false
  chatStore.loading = true
  // 先订阅再发请求，避免首帧事件丢失；重复调用是安全的
  setupAgentEvents()
}

// 请求中止/失败时，还没拿到结果的前端工具不能一直挂在"执行中"
function abandonActiveTools(reason: string) {
  for (const id of activeToolIds) {
    if (!toolOutputById.has(id) && !toolErrorById.has(id)) toolErrorById.set(id, reason)
  }
  activeToolIds.clear()
  pendingInterrupts = []
  approvalByToolCallId.clear()
}

// ========== 发起一次新的 run ==========
// 引擎会同时插入用户消息与 AI 消息，界面直接由 messages 派生
async function startRun(prompt: string, files?: ChatFile[]) {
  const engine = chatEngine.value
  if (!engine) {
    MessagePlugin.error('聊天引擎尚未初始化，请稍后重试')
    return
  }
  abandonPendingInterrupts()
  resetRunState()
  try {
    await engine.sendUserMessage({
      prompt: prompt.trim() || '请查看我上传的附件',
      attachments: files?.length ? files.map(chatFileToAttachment) : undefined
    })
  } catch (err: any) {
    chatStore.loading = false
    const id = lastAssistantId()
    if (id) errorByMessageId.set(id, err?.message || '请求出错')
  }
}

// 重放：历史保留到最后一条用户提问，只重新生成回答（不重复插入用户消息）
async function resendRun() {
  const engine = chatEngine.value
  if (!engine) return
  resetRunState()
  try {
    await engine.sendAIMessage({ params: {}, content: [], sendRequest: true })
  } catch (err: any) {
    chatStore.loading = false
    const id = lastAssistantId()
    if (id) errorByMessageId.set(id, err?.message || '请求出错')
  }
}

// ========== 处理中断：用户允许或拒绝服务端暂停的操作 ==========
async function handleInterruptDecision(step: ToolStep, approved: boolean) {
  if (chatStore.loading || !step.approval) return
  const engine = chatEngine.value
  if (!engine) return

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
    if (!toolCallId) continue
    approvalByToolCallId.delete(toolCallId)
    // 已由服务端 resume 接管，不能再走前端工具执行分支
    activeToolIds.delete(toolCallId)
  }
  if (!approved) toolErrorById.set(step.id, '用户拒绝了该操作')

  chatStore.loading = true
  // onRequest 会把 resume 放进请求体顶层
  try {
    await engine.resumeRun({ resume } as Parameters<typeof engine.resumeRun>[0])
  } catch (err: any) {
    chatStore.loading = false
    const id = lastAssistantId()
    if (id) errorByMessageId.set(id, err?.message || '续跑失败')
  }
}

// ========== 发送新消息 ==========
function onSend(text: string) {
  // 生成中不允许再次发送，否则两个 run 会往同一条 AI 消息里写
  if (chatStore.loading) {
    MessagePlugin.warning('当前回复生成中，请稍候')
    return
  }
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

  // 用户消息由引擎插入（含附件内容块），界面从 messages 派生
  inputText.value = ''
  // 图片预览地址已转存到消息里，这里不能释放
  filesList.value = []
  // 发起流式请求获取 AI 回复
  void startRun(text, sentFiles.length ? sentFiles : undefined)
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
  // 解绑事件、清空引擎侧消息与本轮工具状态
  teardownAgentEvents()
  chatEngine.value?.clearMessages()
  // 新对话没有服务端共享状态，下一轮从空 state 开始
  chatStore.agentState = {}
  activeToolIds.clear()
  toolCallNames.clear()
  toolRounds = 0
  abortRequested = false
  activeAiId = ''
  clearSidecars()
  // 轮换会话 id 与线程 id，旧会话的临时附件不会再被检索到
  sessionId.value = createSessionId()
  threadId.value = createThreadId()
}

// ========== 重放某条 AI 回复 ==========
// 以被点击的消息为目标：丢掉这条回复以及它之后的所有消息（提问本身保留），再重新请求
function onRetry(target?: ChatMessage) {
  // 生成中不允许重试
  if (chatStore.loading) return
  const engine = chatEngine.value
  if (!engine) return
  const list = requestList()
  // 未指定目标时退化为重放最后一条 AI 回复
  const targetIndex = target?.engineIndex ?? list.length - 1
  // 往前找最后一条用户提问，截断到它为止
  let userIndex = -1
  for (let i = Math.min(targetIndex, list.length - 1); i >= 0; i -= 1) {
    if (list[i].role === 'user') {
      userIndex = i
      break
    }
  }
  // 目标之前必须还有用户提问，否则没有可重放的上下文
  if (userIndex < 0) return
  const keep = list.slice(0, userIndex + 1)
  ;(engine as unknown as { setMessages: (items: unknown[], mode?: string) => void }).setMessages(keep, 'replace')
  pruneSidecars(new Set(keep.map(item => item.id)))
  abandonPendingInterrupts()
  // 只重新生成回答，不重复插入用户消息
  void resendRun()
}

// ========== 停止生成 ==========
function onStop() {
  abortRequested = true
  chatStore.loading = false
  // 中断当前 run 的 SSE 连接；stopped 标记在 request:abort 事件里写入
  void chatEngine.value?.abortChat().catch(() => {})
}

// ========== 会话历史：从服务端落库恢复 ==========
// 后端每轮 run 在 /agui 的 finally 里把完整消息快照写进 SQLite（threads / thread_runs），
// 这里负责把快照还原回引擎消息——重登/换设备/清缓存后界面不再空白。
// 注意运行时口径不变：对话仍以客户端 messages 为准，落库只是恢复用的兜底副本。

// 统一请求：auth.request 已带鉴权与 401 翻登录层，这里只补 JSON 解析与非 2xx 抛错
async function fetchJson<T = Record<string, any>>(url: string): Promise<T> {
  const res = (await request(url)) as unknown as Response
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `请求失败（${res.status}）`)
  return body as T
}

type ThreadItem = { id: string; title: string; updated_at: number }

const threadsList = ref<ThreadItem[]>([])
const threadsLoading = ref(false)

// 拉取当前账号的会话列表（服务端已按最近活跃排序，且只返回本人会话）
async function refreshThreads() {
  threadsLoading.value = true
  try {
    const body = await fetchJson<{ data: ThreadItem[] }>('/api/threads')
    threadsList.value = Array.isArray(body?.data) ? body.data : []
  } catch {
    /* 历史拉不到不阻塞聊天，静默即可 */
  } finally {
    threadsLoading.value = false
  }
}

// 服务端快照（AG-UI Message[]）-> 引擎消息（内容块格式）。
// 快照里工具结果是独立的 role:'tool' 消息，这里按 toolCallId 配对塞回 toolcall 块：
// 展示层（toolStepsOf）与下一轮请求（collectToolData 读 block.data.result）都从这里取
function aguiToEngineMessages(list: Array<Record<string, any>>): EngineMessage[] {
  const toolResults = new Map<string, string>()
  for (const item of list) {
    if (item.role === 'tool' && typeof item.toolCallId === 'string') {
      toolResults.set(item.toolCallId, String(item.content ?? ''))
    }
  }
  const out: EngineMessage[] = []
  for (const item of list) {
    if (item.role === 'user') {
      out.push({
        id: String(item.id),
        role: 'user',
        content: [{ type: 'text', data: String(item.content ?? '') }],
        status: 'complete'
      })
      continue
    }
    if (item.role !== 'assistant') continue
    const content: EngineContent[] = []
    for (const call of item.toolCalls || []) {
      const id = String(call?.id || '')
      const args = call?.function?.arguments
      content.push({
        type: `toolcall-${call?.function?.name || id}-${id}`,
        data: {
          toolCallId: id,
          toolCallName: String(call?.function?.name || ''),
          args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          result: toolResults.get(id) || ''
        },
        status: 'complete',
        strategy: 'append'
      })
    }
    const text = String(item.content ?? '')
    // 有正文补 markdown 块；纯工具调用消息没有正文，靠后续消息合并展示
    if (text.trim() || !content.length) {
      content.push({ type: 'markdown', data: text, status: 'complete', strategy: 'append' })
    }
    out.push({ id: String(item.id), role: 'assistant', content, status: 'complete' })
  }
  return out
}

// 加载某个历史会话：拉快照 -> 还原引擎消息 -> 接管 threadId
async function loadThread(id: string) {
  if (chatStore.loading) {
    MessagePlugin.warning('回复生成中，请稍后再切换会话')
    return
  }
  try {
    const body = await fetchJson<{ messages: Array<Record<string, any>> }>(
      `/api/threads/${encodeURIComponent(id)}/messages`
    )
    const snapshot: Array<Record<string, any>> = Array.isArray(body?.messages) ? body.messages : []
    if (!snapshot.length) {
      MessagePlugin.warning('该会话暂无可恢复的消息')
      return
    }
    // 旧线程的挂起中断与运行时工具状态全部作废
    pendingInterrupts = []
    activeToolIds.clear()
    toolCallNames.clear()
    toolRounds = 0
    abortRequested = false
    activeAiId = ''
    clearSidecars()
    // setMessages 不在引擎公开类型里，与 onRetry 处一致地按运行时能力调用
    ;(chatEngine.value as unknown as { setMessages: (items: unknown[], mode?: string) => void } | undefined)
      ?.setMessages(aguiToEngineMessages(snapshot), 'replace')
    // 服务端快照不含共享 state，下一轮从空 state 开始（引用来源等跨轮信息会丢，可接受）
    chatStore.agentState = {}
    threadId.value = id
    // 附件按 sessionId 绑定，恢复会话不恢复附件，换新 id 避免旧附件被静默检索
    sessionId.value = createSessionId()
    persistViewSnapshot()
    MessagePlugin.success('已恢复该会话')
  } catch (err: any) {
    MessagePlugin.error(err?.message || '恢复会话失败')
  }
}

// 登录/刷新后本地为空时，自动恢复最近一个会话；本地有消息则不动
async function initHistory() {
  await refreshThreads()
  const latest = threadsList.value[0]
  if (latest && !engineList().length && latest.id !== threadId.value) {
    await loadThread(latest.id)
  }
}

watch(authed, value => {
  // immediate 覆盖"带 token 直接刷新页面"的情况：此时 authed 初始就是 true，不会触发变更
  if (value) void initHistory()
}, { immediate: true })

const threadOptions = computed(() =>
  threadsList.value.map(item => ({ label: item.title || '未命名会话', value: item.id }))
)
// 当前线程还没落库（新会话没发过消息）时下拉里没有对应项，置空让组件显示 placeholder
const threadSelectValue = computed(() =>
  threadOptions.value.some(option => option.value === threadId.value) ? threadId.value : undefined
)
function onThreadsVisible(visible: boolean) {
  // 打开下拉时拉一次最新列表：本轮对话刚结束的快照这时才进列表
  if (visible) void refreshThreads()
}
function onPickThread(value: unknown) {
  const id = typeof value === 'string' ? value : ''
  if (id && id !== threadId.value) void loadThread(id)
}
// 主动开新会话：与清空按钮同一套逻辑（附件/中断/线程 id 全部轮换）
function startNewThread() {
  handleClear()
  MessagePlugin.success('已开启新会话')
}

// ========== 附件上传 ==========
const MAX_ATTACHMENTS = 5 // 单次对话最多 5 个附件
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024 // 单个附件上限 10MB
const ACCEPT_EXTS = ['.md', '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.gif'] // 与后端会话附件白名单保持一致
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
  const auth = authHeaders()
  if (auth.Authorization) xhr.setRequestHeader('Authorization', auth.Authorization)
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
    headers: authHeaders({ 'Content-Type': 'application/json' }),
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
// 挂载后订阅一次；发送前也会再调一次（幂等），卸载时解绑
onMounted(() => setupAgentEvents())
onUnmounted(() => teardownAgentEvents())

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

/* 右上角账号角标：登录用户的唯一可见标识与登出入口 */
.account-badge {
  position: fixed;
  top: 10px;
  right: 16px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium, 6px);
  font-size: var(--td-font-size-body-small, 12px);
  color: var(--td-text-color-secondary);
}

/* 历史会话下拉：窄宽度，标题截断展示 */
.thread-select {
  width: 168px;

  :deep(.t-input) {
    font-size: var(--td-font-size-body-small, 12px);
  }
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
