#!/usr/bin/env node
/**
 * AG-UI 协议级测试
 *
 * 直接向 /agui 发起 run，解析 SSE 帧并断言事件序列与字段契约，不依赖前端。
 * 断言范围只包含协议结构（事件类型、顺序、字段、快照内容），不断言模型文案，
 * 避免模型随机性导致测试不稳定；审批结果等确定性文案除外。
 *
 * 用法：
 *   node test-agui-protocol.mjs                    # 跑全部用例
 *   node test-agui-protocol.mjs --case=text,rag    # 只跑指定用例
 *   node test-agui-protocol.mjs --list             # 列出用例
 *   BASE_URL=http://localhost:3000 node test-agui-protocol.mjs
 */

import 'dotenv/config' // 读 .env 的 MAX_CONTEXT_TOKENS，让“长上下文”用例的填充量跟着服务端配置走
import { randomUUID } from 'node:crypto'
import { login, authHeaders, BASE_URL } from './eval/http-auth.mjs'

// BASE_URL 来自 ./eval/http-auth.mjs（可被环境变量覆盖），这里不再重复声明
const REQUEST_TIMEOUT_MS = Number(process.env.AGUI_TIMEOUT_MS || 180000)
const UPLOAD_TIMEOUT_MS = Number(process.env.AGUI_UPLOAD_TIMEOUT_MS || 300000)

// ========== 输出 ==========
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const green = text => paint('32', text)
const red = text => paint('31', text)
const yellow = text => paint('33', text)
const dim = text => paint('2', text)
const bold = text => paint('1', text)

const stats = { pass: 0, fail: 0, skip: 0 }
const failedNames = []

function formatDetail(detail) {
  if (detail === undefined) return ''
  let text
  if (typeof detail === 'string') text = detail
  else {
    try {
      text = JSON.stringify(detail)
    } catch {
      text = String(detail)
    }
  }
  return text.length > 700 ? `${text.slice(0, 700)}…` : text
}

function check(name, condition, detail) {
  if (condition) {
    stats.pass++
    console.log(`  ${green('✓')} ${name}`)
    return true
  }
  stats.fail++
  failedNames.push(name)
  console.log(`  ${red('✗')} ${name}`)
  const text = formatDetail(detail)
  if (text) console.log(`      ${dim(text)}`)
  return false
}

function skip(name, reason) {
  stats.skip++
  console.log(`  ${yellow('○')} ${name}${reason ? dim(`（${reason}）`) : ''}`)
}

// ========== SSE 解析 ==========
/** 读取响应体，按空行切帧，取 data: 行并 JSON.parse */
async function readSSE(res, events, parseErrors) {
  const decoder = new TextDecoder()
  let buffer = ''

  const handleFrame = frame => {
    const data = frame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.replace(/^data:\s?/, ''))
      .join('\n')
    if (!data) return
    try {
      events.push(JSON.parse(data))
    } catch (err) {
      parseErrors.push({ frame: frame.slice(0, 200), error: err.message })
    }
  }

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      handleFrame(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) handleFrame(buffer)
}

/** POST /agui，收集全部事件；失败时返回 error 而不抛出 */
async function requestAgui(input, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events = []
  const parseErrors = []
  let status = 0
  let contentType = ''
  let body = ''
  let networkError = null

  try {
    const res = await fetch(`${BASE_URL}/agui`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      }),
      body: JSON.stringify(input),
      signal: controller.signal
    })
    status = res.status
    contentType = res.headers.get('content-type') || ''
    if (!res.ok) {
      body = await res.text()
      return { status, contentType, events, parseErrors, body, networkError }
    }
    await readSSE(res, events, parseErrors)
  } catch (err) {
    networkError = err?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : err?.message || String(err)
  } finally {
    clearTimeout(timer)
  }

  return { status, contentType, events, parseErrors, body, networkError }
}

// ========== 事件辅助 ==========
const typeList = events => events.map(event => event.type)

function brief(events) {
  const out = []
  for (const event of events) {
    const type = event.type
    if (out[out.length - 1] === type) continue
    out.push(type)
  }
  return out.join(' → ') || '(无事件)'
}

function findEvent(events, type) {
  return events.find(event => event.type === type)
}

function lastEventOfType(events, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i]
  }
  return undefined
}

function indexOf(events, predicate) {
  return events.findIndex(predicate)
}

/** 取出所有 /phase 的 STATE_DELTA 变更，按出现顺序 */
function phaseUpdates(events) {
  const updates = []
  events.forEach((event, index) => {
    if (event.type !== 'STATE_DELTA' || !Array.isArray(event.delta)) return
    for (const op of event.delta) {
      if (op?.path === '/phase') updates.push({ op: op.op, value: op.value, index })
    }
  })
  return updates
}

/** 收集本次 run 中出现的工具调用（按 START 去重） */
function toolCalls(events) {
  const calls = new Map()
  events.forEach((event, index) => {
    if (event.type !== 'TOOL_CALL_START') return
    if (!calls.has(event.toolCallId)) {
      calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolCallName, startIndex: index })
    }
  })
  return [...calls.values()]
}

const resultsOf = (events, toolCallId) =>
  events.filter(event => event.type === 'TOOL_CALL_RESULT' && event.toolCallId === toolCallId)

const argsOf = (events, toolCallId) =>
  events.filter(event => event.type === 'TOOL_CALL_ARGS' && event.toolCallId === toolCallId)

// ========== HTTP 辅助 ==========
async function requestJSON(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON 响应保留原文，交给断言输出
  }
  return { status: res.status, json, text }
}

/** 上传会话附件（multipart：sessionId + file） */
async function uploadSessionFile(sessionId, fileName, content) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('sessionId', sessionId)
    form.append('file', new Blob([content], { type: 'text/markdown' }), fileName)
    const res = await fetch(`${BASE_URL}/api/session-files/upload`, {
      method: 'POST',
      body: form,
      headers: authHeaders(),
      signal: controller.signal
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // 保留原文
    }
    return { status: res.status, json, text }
  } catch (err) {
    return {
      status: 0,
      json: null,
      text: err?.name === 'AbortError' ? `上传超时（${UPLOAD_TIMEOUT_MS}ms）` : err?.message || String(err)
    }
  } finally {
    clearTimeout(timer)
  }
}

const newSessionId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

/** 构造一条只含工具调用的 assistant 历史，用于无状态 resume */
function approvalHistory(toolCallId, fileName) {
  return [
    { id: `u_${toolCallId}`, role: 'user', content: `删除附件「${fileName}」` },
    {
      id: `a_${toolCallId}`,
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: 'deleteSessionFile',
            arguments: JSON.stringify({ fileName })
          }
        }
      ]
    }
  ]
}

/** 通用的 /agui 基础断言：HTTP、帧解析、首末事件 */
function assertRunBasics(res, { threadId, runId } = {}) {
  if (!check('HTTP 200', res.status === 200, `status=${res.status} ${res.body}`)) return false
  if (!check('Content-Type 为 text/event-stream', /text\/event-stream/.test(res.contentType), res.contentType)) {
    return false
  }
  if (!check('SSE 帧全部可解析', res.parseErrors.length === 0, res.parseErrors)) return false
  if (!check('事件流非空', res.events.length > 0, brief(res.events))) return false
  check('首个事件是 RUN_STARTED', res.events[0]?.type === 'RUN_STARTED', brief(res.events))
  if (threadId) {
    check(
      'RUN_STARTED 回显 threadId / runId',
      res.events[0]?.threadId === threadId && res.events[0]?.runId === runId,
      res.events[0]
    )
  }
  check('末事件是 RUN_FINISHED', res.events.at(-1)?.type === 'RUN_FINISHED', res.events.at(-1) || brief(res.events))
  check('没有 RUN_ERROR', !res.events.some(event => event.type === 'RUN_ERROR'), findEvent(res.events, 'RUN_ERROR'))
  return true
}

// ========== 用例 ==========
const cases = [
  {
    name: 'text',
    title: '基础文本流：RUN_STARTED / STATE_SNAPSHOT / TEXT_MESSAGE_CHUNK / RUN_FINISHED',
    async run() {
      const threadId = newSessionId('t_text')
      const runId = `r_${randomUUID()}`
      const res = await requestAgui({
        threadId,
        runId,
        state: { customFlag: 'keep-me', sources: [] },
        messages: [{ id: 'm1', role: 'user', content: '只回复两个字：收到' }]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res, { threadId, runId })) return

      // 服务端无状态：历史以客户端 RunAgentInput.messages 为准，
      // 所以不应下发 MESSAGES_SNAPSHOT —— 它的语义是"整段替换消息列表"，
      // 只在服务端真的改写历史（会话存储 / 上下文压缩）时才该发。
      check('不下发 MESSAGES_SNAPSHOT', !findEvent(res.events, 'MESSAGES_SNAPSHOT'), brief(res.events))

      const stateSnapshot = findEvent(res.events, 'STATE_SNAPSHOT')
      check('STATE_SNAPSHOT.phase = running', stateSnapshot?.snapshot?.phase === 'running', stateSnapshot?.snapshot)
      check(
        'STATE_SNAPSHOT 合并调用方 state',
        stateSnapshot?.snapshot?.customFlag === 'keep-me',
        stateSnapshot?.snapshot
      )

      const chunks = res.events.filter(event => event.type === 'TEXT_MESSAGE_CHUNK')
      check('存在 TEXT_MESSAGE_CHUNK 正文分片', chunks.length > 0, brief(res.events))
      if (!chunks.length) return
      check(
        '首个正文分片带 messageId',
        typeof chunks[0].messageId === 'string' && chunks[0].messageId.length > 0,
        chunks[0]
      )
      check('首个正文分片 role = assistant', chunks[0].role === 'assistant', chunks[0])
      const text = chunks.map(chunk => chunk.delta || '').join('')
      check('正文增量拼接后非空', text.trim().length > 0, text)

      const phases = phaseUpdates(res.events)
      check('结束前 phase 变为 done', phases.at(-1)?.value === 'done', phases)
      const finished = lastEventOfType(res.events, 'RUN_FINISHED')
      check('正常结束不携带 interrupt outcome', finished?.outcome?.type !== 'interrupt', finished?.outcome)
    }
  },

  {
    name: 'server_tool',
    title: '服务端工具：START → ARGS → END → RESULT 闭环',
    async run() {
      const res = await requestAgui({
        threadId: newSessionId('t_tool'),
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '请调用 getCurrentTime 工具获取服务器当前时间，再告诉我现在几点。必须调用工具。'
          }
        ]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      const calls = toolCalls(res.events).filter(call => call.name === 'getCurrentTime')
      if (!check('模型调用了 getCurrentTime', calls.length > 0, `${brief(res.events)}`)) return
      const callId = calls[0].id

      check('同一次调用只发一个 TOOL_CALL_START', calls.length === 1, calls)
      const start = res.events[calls[0].startIndex]
      check(
        'TOOL_CALL_START 携带 parentMessageId',
        typeof start?.parentMessageId === 'string' && start.parentMessageId.length > 0,
        start
      )

      const argsEvents = argsOf(res.events, callId)
      check('TOOL_CALL_ARGS 存在且只有一个', argsEvents.length === 1, argsEvents)
      if (argsEvents.length) {
        try {
          const parsed = JSON.parse(argsEvents[0].delta || '{}')
          check('TOOL_CALL_ARGS.delta 是合法 JSON', parsed !== null && typeof parsed === 'object', argsEvents[0].delta)
        } catch (err) {
          check('TOOL_CALL_ARGS.delta 是合法 JSON', false, `${argsEvents[0].delta}（${err.message}）`)
        }
      }

      const argsIndex = indexOf(res.events, event => event.type === 'TOOL_CALL_ARGS' && event.toolCallId === callId)
      const endIndex = indexOf(res.events, event => event.type === 'TOOL_CALL_END' && event.toolCallId === callId)
      const resultIndex = indexOf(
        res.events,
        event => event.type === 'TOOL_CALL_RESULT' && event.toolCallId === callId
      )
      check('存在 TOOL_CALL_END', endIndex >= 0, brief(res.events))
      check('存在对应的 TOOL_CALL_RESULT', resultIndex >= 0, brief(res.events))
      check(
        '工具事件顺序为 START < ARGS < END < RESULT',
        calls[0].startIndex < argsIndex && argsIndex < endIndex && endIndex < resultIndex,
        { start: calls[0].startIndex, args: argsIndex, end: endIndex, result: resultIndex }
      )

      const finishedIndex = indexOf(res.events, event => event.type === 'RUN_FINISHED')
      check('RESULT 在 RUN_FINISHED 之前', resultIndex >= 0 && resultIndex < finishedIndex, {
        resultIndex,
        finishedIndex
      })

      const result = resultsOf(res.events, callId)[0]
      check('TOOL_CALL_RESULT.content 非空', Boolean(result?.content && result.content.length), result)
      check('TOOL_CALL_RESULT.role = tool', result?.role === 'tool', result)
    }
  },

  {
    name: 'frontend_tool',
    title: '前端工具：只下发调用不给结果（挂起语义）',
    async run() {
      const res = await requestAgui({
        threadId: newSessionId('t_front'),
        tools: [
          {
            name: 'getClientTime',
            description: '获取用户浏览器的本地时间。用户询问本地时间、客户端时间时必须调用',
            parameters: { type: 'object', properties: {}, additionalProperties: false }
          }
        ],
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '请调用 getClientTime 工具获取我的本地时间，必须调用工具，不要用其它工具。'
          }
        ]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      const calls = toolCalls(res.events).filter(call => call.name === 'getClientTime')
      if (!calls.length) {
        skip('前端工具挂起语义', `模型本轮未调用 getClientTime：${brief(res.events)}`)
        return
      }
      const callId = calls[0].id
      check('前端工具发出 TOOL_CALL_START', calls.length > 0, calls)
      check('前端工具发出 TOOL_CALL_END', indexOf(res.events, event => event.type === 'TOOL_CALL_END' && event.toolCallId === callId) >= 0)
      check('前端工具不产生 TOOL_CALL_RESULT（交由客户端执行）', resultsOf(res.events, callId).length === 0, resultsOf(res.events, callId))

      const finished = lastEventOfType(res.events, 'RUN_FINISHED')
      check('run 正常结束而非 interrupt', finished?.outcome?.type !== 'interrupt', finished?.outcome)
    }
  },

  {
    name: 'interrupt',
    title: '审批中断：outcome=interrupt 与字段契约',
    async run() {
      const sessionId = newSessionId('s_int')
      const fileName = `agui-interrupt-${Date.now()}.md`
      const uploaded = await uploadSessionFile(
        sessionId,
        fileName,
        '# AG-UI 测试附件\n\n这是用于验证 interrupt / resume 的临时附件，内容不重要。\n'
      )
      if (
        !check(
          '会话附件上传成功',
          uploaded.status === 200 && uploaded.json?.ok === true,
          `status=${uploaded.status} ${uploaded.text}`
        )
      ) {
        return
      }
      const fileId = uploaded.json?.file?.id

      const res = await requestAgui({
        threadId: newSessionId('t_int'),
        forwardedProps: { sessionId },
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: `请直接调用 deleteSessionFile 工具删除附件「${fileName}」，fileName 参数必须是完整文件名。不要向我确认，直接调用工具。`
          }
        ]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      const calls = toolCalls(res.events).filter(call => call.name === 'deleteSessionFile')
      if (!calls.length) {
        skip('interrupt 字段契约', `模型本轮未调用 deleteSessionFile：${brief(res.events)}`)
        check('附件仍存在（未误删）', (await requestJSON('/api/session-files/delete', { sessionId, fileId })).json?.removed === true)
        return
      }
      const callId = calls[0].id

      check('审批工具没有 TOOL_CALL_RESULT', resultsOf(res.events, callId).length === 0, resultsOf(res.events, callId))

      const finished = lastEventOfType(res.events, 'RUN_FINISHED')
      check('RUN_FINISHED.outcome.type = interrupt', finished?.outcome?.type === 'interrupt', finished?.outcome)
      const interrupts = Array.isArray(finished?.outcome?.interrupts) ? finished.outcome.interrupts : []
      const interrupt = interrupts.find(item => item.toolCallId === callId)
      if (!check('interrupts 中包含本次工具调用', Boolean(interrupt), interrupts)) return

      check('interrupt.id = int_<toolCallId>', interrupt.id === `int_${callId}`, interrupt.id)
      check('interrupt.reason = approval', interrupt.reason === 'approval', interrupt.reason)
      check('interrupt.message 含文件名', String(interrupt.message || '').includes(fileName), interrupt.message)
      check(
        'responseSchema 要求 approved: boolean',
        interrupt.responseSchema?.properties?.approved?.type === 'boolean' &&
          Array.isArray(interrupt.responseSchema?.required) &&
          interrupt.responseSchema.required.includes('approved'),
        interrupt.responseSchema
      )
      check('metadata.toolName = deleteSessionFile', interrupt.metadata?.toolName === 'deleteSessionFile', interrupt.metadata)
      check('metadata.input.fileName 与入参一致', interrupt.metadata?.input?.fileName === fileName, interrupt.metadata?.input)

      const phases = phaseUpdates(res.events)
      const interrupted = phases.find(item => item.value === 'interrupted')
      const finishedIndex = indexOf(res.events, event => event.type === 'RUN_FINISHED')
      check('存在 phase = interrupted 的 STATE_DELTA', Boolean(interrupted), phases)
      check('phase 变更发生在 RUN_FINISHED 之前', Boolean(interrupted) && interrupted.index < finishedIndex, {
        interrupted,
        finishedIndex
      })

      // 清理：删除测试附件
      const cleanup = await requestJSON('/api/session-files/delete', { sessionId, fileId })
      check('清理测试附件', cleanup.json?.removed === true, cleanup)
    }
  },

  {
    name: 'resume_allow',
    title: 'resume 允许：执行审批工具、回传结果、重复 resume 幂等',
    async run() {
      const sessionId = newSessionId('s_allow')
      const fileName = `agui-allow-${Date.now()}.md`
      const uploaded = await uploadSessionFile(sessionId, fileName, '# 允许删除\n\n用于验证 resume 允许分支。\n')
      if (
        !check(
          '会话附件上传成功',
          uploaded.status === 200 && uploaded.json?.ok === true,
          `status=${uploaded.status} ${uploaded.text}`
        )
      ) {
        return
      }
      const fileId = uploaded.json?.file?.id
      const toolCallId = `call_allow_${Date.now()}`
      const messages = approvalHistory(toolCallId, fileName)

      const res = await requestAgui({
        threadId: newSessionId('t_allow'),
        forwardedProps: { sessionId },
        messages,
        resume: [{ interruptId: `int_${toolCallId}`, status: 'resolved', payload: { approved: true } }]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      // 服务端无状态，不下发 MESSAGES_SNAPSHOT；resume 的结果通过 TOOL_CALL_RESULT 回传，
      // 直接断言该事件即可（比读快照更贴近协议语义）。

      const results = resultsOf(res.events, toolCallId)
      if (!check('回传 TOOL_CALL_RESULT', results.length === 1, results)) return
      const result = results[0]
      check('结果内容为“已删除附件：<文件名>”', result.content === `已删除附件：${fileName}`, result.content)

      const resultIndex = indexOf(res.events, event => event === result)
      const finishedIndex = indexOf(res.events, event => event.type === 'RUN_FINISHED')
      check('TOOL_CALL_RESULT 在 RUN_FINISHED 之前', resultIndex < finishedIndex, { resultIndex, finishedIndex })
      check(
        'resume 后不再产生 interrupt',
        lastEventOfType(res.events, 'RUN_FINISHED')?.outcome?.type !== 'interrupt',
        lastEventOfType(res.events, 'RUN_FINISHED')?.outcome
      )

      const after = await requestJSON('/api/session-files/delete', { sessionId, fileId })
      check('附件已被真实删除（删除接口返回 removed=false）', after.json?.removed === false, after)

      // 幂等：客户端带着已有 tool 结果重放同一个 resume，服务端不应重复执行
      const replay = await requestAgui({
        threadId: newSessionId('t_allow_replay'),
        forwardedProps: { sessionId },
        messages: [...messages, { id: 't1', role: 'tool', content: result.content, toolCallId }],
        resume: [{ interruptId: `int_${toolCallId}`, status: 'resolved', payload: { approved: true } }]
      })
      if (replay.networkError) {
        check('重复 resume 请求成功', false, replay.networkError)
        return
      }
      if (!assertRunBasics(replay)) return
      check('重复 resume 不重复回传 TOOL_CALL_RESULT', resultsOf(replay.events, toolCallId).length === 0, replay.events.filter(e => e.type === 'TOOL_CALL_RESULT'))
    }
  },

  {
    name: 'resume_reject',
    title: 'resume 拒绝：不执行副作用',
    async run() {
      const sessionId = newSessionId('s_reject')
      const fileName = `agui-reject-${Date.now()}.md`
      const uploaded = await uploadSessionFile(sessionId, fileName, '# 拒绝删除\n\n用于验证 resume 拒绝分支。\n')
      if (
        !check(
          '会话附件上传成功',
          uploaded.status === 200 && uploaded.json?.ok === true,
          `status=${uploaded.status} ${uploaded.text}`
        )
      ) {
        return
      }
      const fileId = uploaded.json?.file?.id
      const toolCallId = `call_reject_${Date.now()}`

      const res = await requestAgui({
        threadId: newSessionId('t_reject'),
        forwardedProps: { sessionId },
        messages: approvalHistory(toolCallId, fileName),
        resume: [{ interruptId: `int_${toolCallId}`, status: 'cancelled', payload: { approved: false } }]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      const results = resultsOf(res.events, toolCallId)
      if (!check('回传 TOOL_CALL_RESULT', results.length === 1, results)) return
      check('拒绝时结果固定为“用户拒绝了该操作，未执行”', results[0].content === '用户拒绝了该操作，未执行', results[0])
      check(
        'resume 后不再产生 interrupt',
        lastEventOfType(res.events, 'RUN_FINISHED')?.outcome?.type !== 'interrupt',
        lastEventOfType(res.events, 'RUN_FINISHED')?.outcome
      )

      // 副作用校验：附件仍在，删除接口返回 removed=true 同时完成清理
      const after = await requestJSON('/api/session-files/delete', { sessionId, fileId })
      check('附件未被删除（删除接口返回 removed=true）', after.json?.removed === true, after)
    }
  },

  {
    name: 'rag',
    title: '检索工具：TOOL_CALL_RESULT 与 /sources 状态增量',
    async run() {
      const res = await requestAgui({
        threadId: newSessionId('t_rag'),
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '请调用 searchKnowledgeBase 工具检索「AG-UI 协议」，query 使用“AG-UI 协议”。必须调用工具。'
          }
        ]
      })

      if (res.networkError) {
        check('请求 /agui 成功', false, res.networkError)
        return
      }
      if (!assertRunBasics(res)) return

      const calls = toolCalls(res.events).filter(call => call.name === 'searchKnowledgeBase')
      if (!calls.length) {
        skip('检索工具闭环', `模型本轮未调用 searchKnowledgeBase：${brief(res.events)}`)
        return
      }
      const callId = calls[0].id
      check('模型调用了 searchKnowledgeBase', true)

      const results = resultsOf(res.events, callId)
      check('检索工具返回 TOOL_CALL_RESULT', results.length === 1, results)
      if (results.length) {
        check('检索结果非空', Boolean(results[0].content && results[0].content.length), results[0])
      }
      const resultIndex = indexOf(res.events, event => event === results[0])
      const finishedIndex = indexOf(res.events, event => event.type === 'RUN_FINISHED')
      check('检索结果在 RUN_FINISHED 之前', resultIndex >= 0 && resultIndex < finishedIndex, {
        resultIndex,
        finishedIndex
      })

      const sourceOps = res.events
        .filter(event => event.type === 'STATE_DELTA' && Array.isArray(event.delta))
        .flatMap(event => event.delta)
        .filter(op => op?.path === '/sources/-')
      if (!sourceOps.length) {
        skip('STATE_DELTA 下发检索来源', '知识库无命中，服务端未下发 sources')
      } else {
        check('sources 通过 add 操作追加', sourceOps.every(op => op.op === 'add'), sourceOps)
        check(
          'source 结构包含 fileName / score / content',
          sourceOps.every(
            op =>
              typeof op.value?.fileName === 'string' &&
              typeof op.value?.score === 'number' &&
              typeof op.value?.content === 'string'
          ),
          sourceOps[0]
        )
      }
    }
  },

  {
    name: 'long_context',
    title: '长上下文：历史超过 token 上限，裁剪后仍正常完成（替代原 test-long-chat.js）',
    async run() {
      const threadId = newSessionId('t_long')
      const runId = `r_${randomUUID()}`
      // 每轮填充约 1150 字（中文约 1 字 ≈ 1 token），按上限的 1.6 倍构造轮数，确保一定越过阈值。
      // 为什么要读 .env：如果 MAX_CONTEXT_TOKENS 被调大，写死的 8 轮就不触发裁剪，用例会假绿。
      const contextLimit = Number(process.env.MAX_CONTEXT_TOKENS || 6000)
      const filler =
        '人工智能智能体开发，Vue3 前端，TDesign 聊天组件，Function Calling，ReAct 循环，RAG 知识库，向量检索，文档分块，Embedding，流式输出，思考过程折叠面板，工具调用可视化，token 裁剪，上下文管理。'
      const rounds = Math.max(6, Math.ceil((contextLimit * 1.6) / 1150))

      const messages = []
      for (let i = 1; i <= rounds; i++) {
        messages.push({ id: `u${i}`, role: 'user', content: `【第${i}轮】请简单回答。${filler.repeat(8)}` })
        messages.push({
          id: `a${i}`,
          role: 'assistant',
          content: `收到，第${i}轮回复：智能体开发核心就是 ReAct 循环，大模型思考、调用工具、拿到结果再继续回答。${filler.repeat(3)}`
        })
      }
      messages.push({ id: 'mLast', role: 'user', content: '用一句话说明我们刚才聊的是什么主题' })

      const res = await requestAgui({ threadId, runId, messages, state: { sources: [] } })
      if (res.networkError) {
        check('长历史请求完成', false, res.networkError)
        return
      }
      if (!assertRunBasics(res, { threadId, runId })) return

      // trim_notice 是“裁剪真的发生了”唯一的外部证据：服务端只在 isTrimmed 时发这个 CUSTOM 事件
      const trimNotice = res.events.find(event => event.type === 'CUSTOM' && event.name === 'trim_notice')
      check(`${rounds} 轮历史触发上下文裁剪`, Boolean(trimNotice), brief(res.events))
      check(
        'trim_notice 报告了被丢弃的消息条数',
        Number(trimNotice?.value?.droppedMessages) > 0,
        trimNotice?.value
      )

      const chunks = res.events.filter(event => event.type === 'TEXT_MESSAGE_CHUNK')
      const text = chunks.map(chunk => chunk.delta || '').join('')
      check('裁剪后仍有正文输出', text.trim().length > 0, text.slice(0, 80))

      const phases = phaseUpdates(res.events)
      check('结束前 phase 变为 done', phases.at(-1)?.value === 'done', phases)
    }
  },

  {
    name: 'bad_request',
    title: '非法请求：缺少 messages 返回 400',
    async run() {
      const empty = await requestJSON('/agui', {})
      check('空 body 返回 400', empty.status === 400, `status=${empty.status} ${empty.text}`)
      check('响应体包含 error 字段', typeof empty.json?.error === 'string', empty.json)

      const emptyList = await requestJSON('/agui', { messages: [] })
      check('messages 为空数组返回 400', emptyList.status === 400, `status=${emptyList.status} ${emptyList.text}`)
    }
  }
]

// ========== 运行 ==========
function printHelp() {
  console.log(`
AG-UI 协议级测试

  node test-agui-protocol.mjs                运行全部用例
  node test-agui-protocol.mjs --list         列出用例
  node test-agui-protocol.mjs --case=a,b     只运行指定用例

环境变量：
  BASE_URL               服务地址，默认 http://localhost:3000
  AGUI_TIMEOUT_MS        单次 run 超时，默认 180000
  AGUI_UPLOAD_TIMEOUT_MS 附件上传超时，默认 300000
`)
}

async function ensureServer() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${BASE_URL}/api/documents`, { headers: authHeaders(), signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.error(red(`无法连接 ${BASE_URL}：${err?.message || err}`))
    console.error(dim('请在 server 目录执行 npm start，或用 BASE_URL 指定服务地址'))
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  if (args.includes('--list')) {
    for (const item of cases) console.log(`  ${item.name.padEnd(16)} ${item.title}`)
    return
  }

  const caseArg = args.find(arg => arg.startsWith('--case='))
  const selected = caseArg
    ? caseArg
        .slice('--case='.length)
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
    : null
  if (selected) {
    const unknown = selected.filter(name => !cases.some(item => item.name === name))
    if (unknown.length) {
      console.error(red(`未知用例：${unknown.join(', ')}`))
      console.error(dim(`可用用例：${cases.map(item => item.name).join(', ')}`))
      process.exit(2)
    }
  }

  // 鉴权上线后所有端点都要 token，测试先注册专用账号（ensureServer 的探活也要带它）
  const { username } = await login()
  await ensureServer()
  console.log(`${bold('AG-UI 协议级测试')} ${dim(`→ ${BASE_URL}（账号 ${username}）`)}`)

  const startedAt = Date.now()
  for (const item of cases) {
    if (selected && !selected.includes(item.name)) continue
    console.log(`\n${bold(`▶ ${item.name}`)} ${dim(item.title)}`)
    try {
      await item.run()
    } catch (err) {
      check(`${item.name} 执行异常`, false, err?.stack || String(err))
    }
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n${'─'.repeat(56)}`)
  console.log(
    `通过 ${green(stats.pass)}  失败 ${stats.fail ? red(stats.fail) : stats.fail}  跳过 ${yellow(stats.skip)}  耗时 ${duration}s`
  )
  if (stats.fail) {
    console.log(`${red('未通过的断言：')}`)
    for (const name of failedNames) console.log(`  - ${name}`)
  }
  process.exit(stats.fail ? 1 : 0)
}

main().catch(err => {
  console.error(red('测试脚本异常终止'))
  console.error(err)
  process.exit(1)
})
