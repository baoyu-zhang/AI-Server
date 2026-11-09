/**
 * agui-engine-test.mjs —— Headless 验证：TDesign ChatEngine(0.7.0) 直连 AI-Server /agui
 * 运行：cd web && node agui-engine-test.mjs   （需先启动 AI-Server）
 */
import ChatEngine, { ChatEngineEventType as EVT } from '@tdesign/ai-chat-engine'

const ENDPOINT = process.env.AGUI_URL || 'http://127.0.0.1:3000/agui'
const THREAD_ID = `t-engine-${Date.now()}`
let runSeq = 0
const engine = new ChatEngine()

/** 把引擎内的消息历史映射成 AG-UI messages（文本部分） */
function toAguiMessages() {
  return (engine.messages ?? [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map((m, i) => ({
      id: m.id ?? `msg_${i}`,
      role: m.role,
      content: (Array.isArray(m.content) ? m.content : [])
        .filter(c => c.type === 'markdown' || c.type === 'text')
        .map(c => (typeof c.data === 'string' ? c.data : ''))
        .join('')
    }))
    .filter(m => m.content || m.role === 'user')
}

const stats = { chunks: 0, chars: 0, types: {} }
const fmt = (v) => {
  try { return JSON.stringify(v).slice(0, 220) } catch { return String(v) }
}

// ---- 订阅引擎事件总线 ----
engine.eventBus.on(EVT.AGUI_RUN_START, (p) => console.log('[RUN_START]', fmt(p)))
engine.eventBus.on(EVT.AGUI_RUN_COMPLETE, (p) => console.log('[RUN_COMPLETE]', fmt(p)))
engine.eventBoxNullable = null
engine.eventBus.on(EVT.AGUI_RUN_ERROR, (p) => console.log('[RUN_ERROR]', fmt(p)))
engine.eventBus.on(EVT.REQUEST_START, (p) => console.log('[REQUEST_START] endpoint=', p?.params?.endpoint ?? '?'))
engine.eventBus.on(EVT.REQUEST_STREAM, (p) => {
  if (stats.chunks < 3) console.log('[REQUEST_STREAM] chunk=', fmt(p?.chunk))
})
engine.eventBus.on(EVT.AGUI_TOOLCALL, (p) => {
  const calls = Array.isArray(p?.toolcalls) ? p.toolcalls : Array.isArray(p) ? p : [p]
  for (const c of calls) {
    console.log('[TOOLCALL]', JSON.stringify({
      id: c?.id ?? c?.toolCallId, name: c?.name ?? c?.toolCallName,
      args: c?.arguments ?? c?.input, status: c?.status, result: c?.result ? String(c.result).slice(0, 80) : undefined
    }))
  }
})
engine.eventBus.on(EVT.AGUI_STATE_UPDATE, (p) => {
  const s = p?.state ?? p
  const sources = Array.isArray(s?.sources) ? s.sources : undefined
  console.log('[STATE_UPDATE]', sources ? `sources.length=${sources.length}, 第一条=${fmt(sources[0])}` : fmt(p))
})
engine.eventBus.on(EVT.CUSTOM, (p) => console.log('[CUSTOM]', fmt(p)))
engine.eventBus.on(EVT.REQUEST_ERROR, (p) => console.log('[REQUEST_ERROR]', fmt(p?.error ?? p)))
engine.eventBus.on(EVT.MESSAGE_CONTENT_APPEND, (p) => {
  stats.chunks++
  const type = p?.content?.type ?? 'unknown'
  stats.types[type] = (stats.types[type] || 0) + 1
  const text = p?.content?.data ?? p?.content?.content ?? p?.content?.text ?? ''
  stats.chars += typeof text === 'string' ? text.length : 0
})
engine.eventBus.on(EVT.REQUEST_COMPLETE, (p) => {
  const msg = p?.message
  const contents = Array.isArray(msg?.content) ? msg.content : []
  console.log('\n===== 最终消息内容块 =====')
  for (const c of contents) {
    const text = typeof c?.data === 'string' ? c.data : JSON.stringify(c?.data ?? '')
    console.log(`- type=${c?.type} 状态=${c?.status ?? '-'} 长度=${text.length} 预览=${text.slice(0, 60).replace(/\n/g, ' ')}`)
  }
})

let pendingResolve = null
engine.eventBus.on(EVT.AGUI_RUN_COMPLETE, () => { if (pendingResolve) { pendingResolve(); pendingResolve = null } })
engine.eventBus.on(EVT.AGUI_RUN_ERROR, () => { if (pendingResolve) { pendingResolve(); pendingResolve = null } })

async function runCase(title, prompt) {
  console.log(`\n########## ${title} ##########`)
  console.log(`提问：${prompt}`)
  stats.chunks = 0; stats.chars = 0; stats.types = {}
  const done = new Promise((r) => { pendingResolve = r })
  try {
    await engine.sendUserMessage({ prompt })
  } catch (err) {
    console.log('[SEND 异常]', err?.message ?? err)
  }
  const timeout = new Promise(r => setTimeout(r, 120000))
  await Promise.race([done, timeout])
  await new Promise(r => setTimeout(r, 300))
  const msgs = engine.messages ?? []
  console.log(`消息数=${msgs.length}，最后一条 role=${msgs.at(-1)?.role} 状态=${msgs.at(-1)?.status} 内容块=${Array.isArray(msgs.at(-1)?.content) ? msgs.at(-1).content.map(c => c.type).join(',') : typeof msgs.at(-1)?.content}`)
  console.log(`流式统计：内容块追加 ${stats.chunks} 次，累计 ${stats.chars} 字符，类型分布 ${fmt(stats.types)}`)
}

await engine.init({
  endpoint: ENDPOINT,
  protocol: 'agui',   // 关键：响应侧由引擎解析 AG-UI 事件
  transport: 'sse',
  // 关键：请求侧的 HTTP 构造由使用方完成（引擎不代劳）
  // params = { prompt, messageID, ...自定义字段 }，必须在这里拼出符合 /agui 约定的 body
  onRequest: (params) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: THREAD_ID,
      runId: `r-engine-${++runSeq}`,
      state: {},
      messages: toAguiMessages(),
      forwardedProps: { sessionId: 'engine-test' }
    })
  })
}, [])

console.log(`引擎已连接 ${ENDPOINT}（protocol=agui, transport=sse）`)
console.log(`[探针] initialized=${engine.initialized} streamHandler.protocol=${engine.streamHandler?.protocol} messages=${engine.messages?.length}`)

await runCase('场景1：纯对话（无工具）', '只回答两个字：收到')
await runCase('场景2：工具调用（触发知识库检索）', '张宝玉的简历里有哪些项目经历？用一句话概括')

console.log('\n验证结束')
process.exit(0)
