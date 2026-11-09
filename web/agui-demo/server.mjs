import http from 'node:http'
import { EventEncoder } from '@ag-ui/encoder'

const PORT = Number(process.env.PORT || 4311)
const encoder = new EventEncoder()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function createEmitter(res, { onAbort }) {
  let aborted = false
  const ping = setInterval(() => {
    if (!aborted) res.write(': ping\n\n')
  }, 15000)

  return {
    emit(event) {
      if (aborted) return false
      res.write(encoder.encode({ timestamp: Date.now(), ...event }))
      return true
    },
    abort() {
      if (aborted) return
      aborted = true
      clearInterval(ping)
      onAbort?.()
    },
    get aborted() {
      return aborted
    },
    dispose() {
      clearInterval(ping)
    },
  }
}

async function streamRun(res, input) {
  const threadId = input.threadId || 'thread_demo'
  const runId = input.runId || 'run_demo'

  const reasoningId = 'msg_reason_1'
  const toolAssistantId = 'msg_asst_tools_1'
  const toolCallId = 'call_search_1'
  const toolResultId = 'msg_tool_1'
  const answerId = 'msg_asst_answer_1'

  let stopped = false
  const out = createEmitter(res, {
    onAbort() {
      stopped = true
      console.log('[server] client aborted, runId=%s', runId)
    },
  })

  const step = async (ms = 90) => {
    await sleep(ms)
    return !stopped && !out.aborted
  }

  try {
    out.emit({ type: 'RUN_STARTED', threadId, runId })
    if (!(await step())) return

    // ---- 1. reasoning span (旧 THINKING_* 已废弃，验证新事件名) ----
    out.emit({ type: 'STEP_STARTED', stepName: 'thinking' })
    out.emit({ type: 'REASONING_START', messageId: reasoningId })
    out.emit({ type: 'REASONING_MESSAGE_START', messageId: reasoningId, role: 'reasoning' })
    out.emit({ type: 'REASONING_MESSAGE_CONTENT', messageId: reasoningId, delta: '用户在问 AG-UI 协议，' })
    if (!(await step(60))) return
    out.emit({ type: 'REASONING_MESSAGE_CONTENT', messageId: reasoningId, delta: '我可能需要检索文档。' })
    out.emit({ type: 'REASONING_MESSAGE_END', messageId: reasoningId })
    out.emit({ type: 'REASONING_END', messageId: reasoningId })
    out.emit({ type: 'STEP_FINISHED', stepName: 'thinking' })
    if (!(await step())) return

    // ---- 2. tool call，args 故意拆成两段验证增量解析 ----
    out.emit({ type: 'STEP_STARTED', stepName: 'tool:search_docs' })
    out.emit({
      type: 'TOOL_CALL_START',
      toolCallId,
      toolCallName: 'search_docs',
      parentMessageId: toolAssistantId,
    })
    out.emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: '{"query":"AG-UI ' })
    if (!(await step(60))) return
    out.emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: 'SSE 事件顺序","topK":2}' })
    out.emit({ type: 'TOOL_CALL_END', toolCallId })
    if (!(await step(80))) return

    out.emit({
      type: 'TOOL_CALL_RESULT',
      messageId: toolResultId,
      toolCallId,
      content: '1. AG-UI 用 SSE 传输事件流\n2. 文本用 TEXT_MESSAGE_CONTENT 增量拼接',
      role: 'tool',
    })
    out.emit({ type: 'STEP_FINISHED', stepName: 'tool:search_docs' })
    if (!(await step())) return

    // ---- 3. 共享状态：先快照，再 JSON Patch 增量 ----
    out.emit({
      type: 'STATE_SNAPSHOT',
      snapshot: {
        phase: 'retrieving',
        sources: [{ id: 'doc_1', title: 'AG-UI 概览', score: 0.91 }],
      },
    })
    if (!(await step(80))) return
    out.emit({
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/phase', value: 'answering' },
        { op: 'add', path: '/sources/-', value: { id: 'doc_2', title: 'SSE 编码规范', score: 0.87 } },
      ],
    })
    if (!(await step(80))) return

    // ---- 4. 最终文本回答，逐段增量 ----
    out.emit({ type: 'TEXT_MESSAGE_START', messageId: answerId, role: 'assistant' })
    for (const delta of ['AG-UI 是 ', 'Agent 与前端之间的 ', '事件协议，', '底层走 SSE。']) {
      out.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: answerId, delta })
      if (!(await step(70))) return
    }
    out.emit({ type: 'TEXT_MESSAGE_END', messageId: answerId })

    // ---- 5. 自定义事件：给前端传协议外信息 ----
    out.emit({ type: 'CUSTOM', name: 'trim_notice', value: { droppedMessages: 2, maxTokenLimit: 6000 } })

    out.emit({ type: 'RUN_FINISHED', threadId, runId })
  } catch (err) {
    console.error('[server] stream error', err)
    if (!out.aborted) {
      out.emit({ type: 'RUN_ERROR', message: String(err?.message || err), code: 'INTERNAL_ERROR' })
    }
  } finally {
    out.dispose()
    if (!res.writableEnded) res.end()
    console.log('[server] run closed, runId=%s aborted=%s', runId, out.aborted)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    })
    return res.end()
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, protocol: '1.0' }))
  }

  if (req.method === 'POST' && url.pathname === '/agui') {
    let input
    try {
      input = await readBody(req)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid json body' }))
    }

    console.log('[server] run input: threadId=%s runId=%s messages=%d', input.threadId, input.runId, input.messages?.length ?? 0)

    res.writeHead(200, {
      'Content-Type': encoder.getContentType(),
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })
    res.flushHeaders?.()

    req.on('close', () => {
      // HttpAgent abort 时浏览器会直接断连
      console.log('[server] request closed by client')
    })

    return streamRun(res, input)
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.on('error', (err) => {
  console.error('[server] listen error', err)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[server] agui demo listening on http://127.0.0.1:%d/agui', PORT)
})
