import assert from 'node:assert/strict'
import { HttpAgent } from '@ag-ui/client'

const URL = process.env.AGUI_URL || 'http://127.0.0.1:4311/agui'
const EXPECTED_TEXT = 'AG-UI 是 Agent 与前端之间的 事件协议，底层走 SSE。'
const EXPECTED_ARGS = { query: 'AG-UI SSE 事件顺序', topK: 2 }

const pass = []
const check = (label, fn) => {
  fn()
  pass.push(label)
  console.log('  ✓', label)
}

function assertOrder(types, expected) {
  let cursor = 0
  for (const type of types) {
    if (type === expected[cursor]) cursor++
  }
  assert.equal(cursor, expected.length, `事件顺序缺失，期望子序列: ${expected.join(' -> ')}，实际: ${types.join(', ')}`)
}

// ---------- 1. 裸 SSE：确认服务端编码符合 AG-UI 约定 ----------
console.log('\n[1] 裸 SSE 帧检查')
const rawRes = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({
    threadId: 'thread_raw',
    runId: 'run_raw',
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }),
})
const rawText = await rawRes.text()
const frames = rawText
  .split('\n\n')
  .filter((f) => f.startsWith('data:'))
  .map((f) => JSON.parse(f.replace(/^data: ?/, '')))

check('HTTP 200', () => assert.equal(rawRes.status, 200))
check('Content-Type 为 text/event-stream', () =>
  assert.match(rawRes.headers.get('content-type') || '', /text\/event-stream/),
)
check('每个 data: 帧都是合法 JSON 且带 type', () => {
  assert.ok(frames.length >= 10, `帧数过少: ${frames.length}`)
  for (const f of frames) assert.equal(typeof f.type, 'string')
})
check('首帧 RUN_STARTED / 末帧 RUN_FINISHED', () => {
  assert.equal(frames[0].type, 'RUN_STARTED')
  assert.equal(frames.at(-1).type, 'RUN_FINISHED')
})

// ---------- 2. 官方 HttpAgent：事件序列 / 增量拼接 / tool args / state ----------
console.log('\n[2] HttpAgent 端到端')
const events = []
let reasoningBuffer = ''
let reasoningFromDeltas = ''
let textBufferAtContent = ''
let textBufferAtEnd = ''
let textFromDeltas = ''
let toolStart
let toolArgs
let toolResult
const customEvents = []

const agent = new HttpAgent({ url: URL, threadId: `thread_verify_${Date.now()}` })
agent.addMessage({ id: 'user_1', role: 'user', content: 'AG-UI 是什么？' })

const { result, newMessages } = await agent.runAgent(
  {},
  {
    onEvent: ({ event }) => events.push(event.type),
    onReasoningMessageContentEvent: ({ event }) => {
      reasoningFromDeltas += event.delta
    },
    onReasoningMessageEndEvent: ({ reasoningMessageBuffer }) => {
      reasoningBuffer = reasoningMessageBuffer
    },
    onToolCallStartEvent: ({ event }) => {
      toolStart = event
    },
    onToolCallEndEvent: ({ toolCallArgs: args }) => {
      toolArgs = args
    },
    onToolCallResultEvent: ({ event }) => {
      toolResult = event
    },
    onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
      // 注意：这里的 buffer 是“应用本次 delta 之前”的内容，滞后一帧
      textBufferAtContent = textMessageBuffer
      textFromDeltas += event.delta
    },
    onTextMessageEndEvent: ({ textMessageBuffer }) => {
      textBufferAtEnd = textMessageBuffer
    },
    onCustomEvent: ({ event }) => customEvents.push(event),
  },
)

check('事件序列完整', () =>
  assertOrder(events, [
    'RUN_STARTED',
    'STEP_STARTED',
    'REASONING_START',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'STEP_FINISHED',
    'STEP_STARTED',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'TOOL_CALL_RESULT',
    'STEP_FINISHED',
    'STATE_SNAPSHOT',
    'STATE_DELTA',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'CUSTOM',
    'RUN_FINISHED',
  ]),
)
check('reasoning 增量拼接正确', () => assert.equal(reasoningBuffer, '用户在问 AG-UI 协议，我可能需要检索文档。'))
check('自行累加 reasoning delta 也正确', () =>
  assert.equal(reasoningFromDeltas, '用户在问 AG-UI 协议，我可能需要检索文档。'),
)
check('text 增量拼接正确', () => assert.equal(textFromDeltas, EXPECTED_TEXT))
check('TEXT_MESSAGE_END 拿到的 buffer 是全文', () => assert.equal(textBufferAtEnd, EXPECTED_TEXT))
check('content 回调的 buffer 滞后一帧（只用它会少最后一段）', () => {
  assert.equal(textBufferAtContent, 'AG-UI 是 Agent 与前端之间的 事件协议，')
  assert.notEqual(textBufferAtContent, EXPECTED_TEXT)
})
check('toolCallStart 字段正确', () => {
  assert.equal(toolStart.toolCallId, 'call_search_1')
  assert.equal(toolStart.toolCallName, 'search_docs')
})
check('tool args 两段增量被解析为对象', () => assert.deepEqual(toolArgs, EXPECTED_ARGS))
check('tool result 关联到同一个 toolCallId', () => {
  assert.equal(toolResult.toolCallId, 'call_search_1')
  assert.match(toolResult.content, /SSE/)
})
check('STATE_SNAPSHOT + STATE_DELTA 正确合并', () => {
  assert.equal(agent.state.phase, 'answering')
  assert.equal(agent.state.sources.length, 2)
  assert.deepEqual(agent.state.sources.map((s) => s.id), ['doc_1', 'doc_2'])
})
check('CUSTOM 事件可被订阅', () => {
  assert.equal(customEvents.length, 1)
  assert.equal(customEvents[0].name, 'trim_notice')
  assert.equal(customEvents[0].value.maxTokenLimit, 6000)
})
check('runAgent 返回 newMessages（result 取决于服务端是否回传）', () => {
  assert.equal(result, undefined, '本次服务端 RUN_FINISHED 未带 result')
  assert.ok(Array.isArray(newMessages) && newMessages.length > 0, 'newMessages 为空')
})

console.log('\n  agent.messages:')
for (const m of agent.messages) {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  const tools = (m.toolCalls || [])
    .map((t) => `toolCall(${t.function.name} args=${t.function.arguments})`)
    .join(', ')
  console.log(
    `   - ${m.id} [${m.role}] content=${JSON.stringify(text)}${tools ? ` ${tools}` : ''}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ''}`,
  )
}
console.log('  agent.state =', JSON.stringify(agent.state))

// ---------- 3. 中断：abortRun 能立刻停止 SSE 消费 ----------
console.log('\n[3] abortRun 中断')
const abortAgent = new HttpAgent({ url: URL, threadId: `thread_abort_${Date.now()}` })
abortAgent.addMessage({ id: 'user_2', role: 'user', content: '中断测试' })

let abortedAt = 0
let contentAfterAbort = 0
const startedAt = Date.now()
let abortError = null
try {
  await abortAgent.runAgent(
    {},
    {
      onTextMessageContentEvent: () => {
        if (abortedAt) {
          contentAfterAbort++
          return
        }
        abortedAt = Date.now()
        abortAgent.abortRun()
      },
    },
  )
} catch (err) {
  abortError = err
}

check('abortRun 在首个文本增量后被调用', () => assert.ok(abortedAt > 0))
check('中断后 runAgent 正常收敛（不挂起）', () => assert.ok(Date.now() - startedAt < 5000))
check('中断后不再收到文本增量', () => assert.equal(contentAfterAbort, 0))
check('中断未抛出异常', () => assert.equal(abortError, null))

console.log(`\n通过 ${pass.length} 项断言。总计 ${events.length} 个事件。`)
