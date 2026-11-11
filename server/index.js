require('dotenv').config() // 加载 .env 中的环境变量（DEEPSEEK_API_KEY）
const express = require('express') // 引入 Express 框架
const { tool, jsonSchema } = require('ai') // 引入 AI SDK 的工具定义与 JSON Schema 适配（流式主链路已抽到 chat-core.js）
const { z } = require('zod') // 引入 zod，用于声明工具入参结构
const multer = require('multer')
const { randomUUID } = require('node:crypto') // 生成 AG-UI 的 threadId / runId / messageId
const { EventEncoder } = require('@ag-ui/encoder') // AG-UI 官方 SSE 事件编码器
const fs = require('fs') // 用于清理解析后的临时文件
const path = require('path') // 用于解析上传文件的后缀名
const { UPLOAD_DIR, ALLOWED_EXTS, IMAGE_EXTS, extractFileText, splitTextIntoChunks } = require('./rag-utils')
const { initVectorStore, batchInsertEmbedding, searchVector, getDocuments, deleteDocument } = require('./rag-vector')
const { addSessionFile, addSessionImage, deleteSessionFile, getSessionFiles, searchSessionFiles } = require('./session-files')
const { prepareChatStream, MAX_CONTEXT_TOKENS } = require('./chat-core') // 聊天主链路（裁剪/附件/选模型/streamText）
const app = express() // 创建 Express 应用实例
const PORT = process.env.PORT || 3000 // 服务端口：优先取环境变量，默认 3000
app.use(express.json()) // 注册 JSON 请求体解析中间件
// 启动服务初始化向量库
initVectorStore().catch(err => console.error('向量库初始化失败', err))

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY // 读取 DeepSeek API Key
if (!DEEPSEEK_API_KEY) { // 校验 API Key 是否缺失
  console.error('❌ .env 缺少 DEEPSEEK_API_KEY') // 缺失时输出错误提示
  process.exit(1) // 终止进程，避免带着错误配置继续运行
}

// 模型客户端、token 统计、上下文裁剪、附件注入、streamText 调用都已移到 chat-core.js

// 判断用户问题是否在问本次附件；短问题（如“这是什么”）也按附件意图处理
function isAttachmentQuery(query, files) {
  const q = String(query || '').trim()
  if (!q) return false
  if (files.some(file => q.includes(file.fileName) || file.fileName.includes(q))) return true
  if (/附件|文件|文档|发票|这个|这份|这张|上述|它|总结|概括/.test(q)) return true
  return q.length <= 6
}

// 按名次融合多个检索源的结果（RRF）
// 为什么不能直接按 score 排序：知识库走的是"向量 + BM25 融合分"，会话附件走的是纯 cosine，
// 两者的分数量纲不同，直接比较会让一方系统性地碾压另一方（比如附件 cosine 0.6 永远压过融合分 0.4）。
// 排名是唯一可比的信号，所以按 1/(60 + rank) 累加，与 rag-vector.js 内部的融合口径保持一致。
const MERGE_RRF_K = 60
function mergeByRank(lists, topK) {
  const merged = new Map()
  for (const list of lists) {
    list.forEach((item, index) => {
      // 同一片段在不同源里不会重名，用来源 + 文件名 + 正文前缀做 key 即可
      const key = `${item.sourceType}|${item.fileName}|${item.content.slice(0, 40)}`
      const rankScore = 1 / (MERGE_RRF_K + index + 1)
      const current = merged.get(key)
      if (current) {
        current.raw += rankScore // 两源都命中，说明更可信
      } else {
        merged.set(key, { ...item, raw: rankScore })
      }
    })
  }
  // 统一归一化到 0~1：双源都排第 1 得 1.0，单源排第 1 得 0.5
  // 必须是"先累加原始分、最后一次性归一化"；初始值归一化后再累加原始分，两种量纲会混在一起
  const maxRaw = 2 / (MERGE_RRF_K + 1)
  return [...merged.values()]
    .map(({ raw, ...item }) => ({ ...item, score: Number((raw / maxRaw).toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// ========== 工具集合：按会话构建 ==========
// 工具分三类，差别不在"功能"，而在"谁执行、什么时候执行"：
//   ① 服务端工具（本函数）：有 execute，流内立即执行，结果自动回填给模型继续生成
//   ② 前端工具（createFrontendTools）：无 execute，本轮结束，浏览器执行后下一轮 run 带回结果
//   ③ 审批工具（createApprovalTools）：无 execute，收尾转成 interrupt，用户 resume 后才执行
//
// 为什么用工厂函数而不是模块级常量对象：
// 附件检索需要 sessionId。若做成常量，这个 id 只能靠全局变量传递，
// 多请求并发时会串号（A 用户检索到 B 用户的附件）。工厂函数把状态收进闭包，天然隔离。
function createTools(sessionId) {
  return {
    // ---- ① 服务端工具：模型调完立刻拿到结果 ----
    getCurrentTime: tool({
      // description 是模型判断"要不要调用"的唯一依据，不是给人看的注释。
      // 写清"用户问现在几点、当前日期时使用"，模型才知道何时触发；
      // 只写"获取当前时间"这种同义反复，会让它在无关问题上也乱调。
      description: '获取服务器当前时间，当用户问现在几点、当前日期时使用',
      inputSchema: z.object({}), // 无参数也要显式声明空对象，等于告诉模型"不要编参数"
      // 返回值直接进模型上下文，所以返回可读文本而不是时间戳
      execute: async () => new Date().toLocaleString('zh-CN')
    }),

    calculator: tool({
      description: '数学计算器，用于计算加减乘除，用户有数学计算时调用',
      // 用 zod 声明入参：AI SDK 会转成 JSON Schema 交给模型。
      // 类型和 enum 约束在这里做，模型就不容易给出 op:'加' 这种非法入参；
      // .describe() 也会一起下发，同样是给模型看的参数说明。
      inputSchema: z.object({
        a: z.number().describe('第一个数字'),
        b: z.number().describe('第二个数字'),
        op: z.enum(['+', '-', '*', '/']).describe('运算符')
      }),
      // 注意这里"返回错误文本"而不是抛异常：
      // execute 抛错会让这一轮对话直接失败；返回错误文本，模型能读到并自己换参数重试。
      execute: async ({ a, b, op }) => {
        let res
        switch (op) {
          case '+': res = a + b; break
          case '-': res = a - b; break
          case '*': res = a * b; break
          case '/':
            if (b === 0) return '错误：除数不能为0'
            res = a / b; break
          default:
            return '错误：运算符仅支持 + - * /'
        }
        return `计算结果：${a} ${op} ${b} = ${res}`
      }
    }),

    // ---- ① 里最复杂的一个：双数据源检索 ----
    searchKnowledgeBase: tool({
      // 这段 description 是全项目对效果影响最大的文本，写法上刻意做了"双向约束"：
      //   正向：列出必须调用的场景（附件问题、简历类问题）；
      //   反向：明确"无关时不要调用"。
      // 只写正向会导致模型逢问题必检索——问"你好"也去翻知识库，既慢又容易答偏。
      description: `在知识库文档和本次会话附件中检索原文。以下情况必须调用：
            1. 用户上传了附件，并询问附件内容（如“这是什么”“总结一下”“帮我看看这份文件”“发票金额是多少”）；
            2. 用户询问和简历、个人信息、项目经历、技能、工作年限相关的问题。
            回答文档内容时不要编造信息；如果问题和文档、附件都无关，不要调用这个工具，直接回答。`,
      inputSchema: z.object({
        query: z.string().describe("用户的检索关键词/问题，用来在知识库做语义检索"),
        // 上限卡在 5 不是随手写的：topK 直接决定回填给模型的文本量，
        // 模型偶尔会贪心地要 20 条，一次就把上下文预算吃光。
        topK: z.number().int().min(1).max(5).default(3).describe("返回几条匹配片段")
      }),
      // 工具执行回调：模型调用工具时执行这里。返回值会作为 tool-result 进入下一轮上下文
      async execute({ query, topK }) {
        console.log(`🔍 Agent调用知识库检索，query：${query}`)
        // 两个数据源互相独立，必须并行：串行会让检索耗时直接翻倍（知识库是磁盘向量库，附件是内存检索）
        const [kbResult, sessionResult] = await Promise.all([
          searchVector(query, topK),
          searchSessionFiles(sessionId, query, topK)
        ])
        // 打上来源标记，前端据此把引用渲染成"本次附件 / 知识库"两种标签
        const knowledge = kbResult.map(item => ({ ...item, sourceType: 'knowledge' }))
        const attachments = sessionResult.map(item => ({ ...item, sourceType: 'attachment' }))
        let searchResult
        // 合并策略分两种，这是本工具最容易被忽略的设计：
        //   附件意图：附件优先占位，不足的再用知识库补。
        //     否则长期知识库的片段永远压过"用户刚上传的那份文件"，用户会觉得"它根本没看我的文件"。
        //   普通意图：按名次融合排序，谁更相关谁在前。
        //     这里不能直接比较两个源的 score——知识库是融合分、附件是 cosine，量纲不同。
        if (attachments.length && isAttachmentQuery(query, getSessionFiles(sessionId))) {
          searchResult = [...attachments.slice(0, topK), ...knowledge].slice(0, topK)
        } else {
          searchResult = mergeByRank([knowledge, attachments], topK)
        }
        // 空结果也必须是合法返回：让模型明确知道"查了但没有"，而不是让它自由发挥编一个答案
        if (!searchResult.length) return { text: '知识库和本次会话附件中都没有检索到相关内容', sources: [] }
        // 返回值有两个通道，别混：
        //   text   → 拼成一段话给模型读（模型看不到 sources 结构）
        //   sources → 结构化对象给前端渲染【引用来源】，走 JSON 序列化，不会被转义成字面 \n
        return {
          // ① 给模型读的文本。三个细节都是刻意的：
          //   【片段N】让模型能说"根据片段2"，人也能对上号；
          //   写出相关度，低分时模型自己会更谨慎（这是最便宜的"置信度提示"）；
          //   标出来源文件名，避免模型把附件内容说成知识库内容。
          //   score 是"融合相关度"（两路/两源都命中才接近 1），不是余弦相似度，所以不能写成"相似度"。
          text: searchResult
            .map((item, i) => `【片段${i + 1}】相关度：${item.score.toFixed(3)}\n来源：${item.fileName}${item.sourceType === 'attachment' ? '（本次会话附件）' : ''}\n${item.content}`)
            .join('\n\n'),
          // ② 给前端渲染的结构化数据。score 用 Number 包一层保持数字类型
          //   （toFixed 返回字符串，前端拿去做排序/阈值判断会变成字符串比较，'0.9' < '0.85' 这种坑）
          sources: searchResult.map(item => ({
            fileName: item.fileName,
            score: Number(item.score.toFixed(3)),
            content: item.content,
            sourceType: item.sourceType
          }))
        }
      }
    })
  }
}

// ========== 前端工具：定义由浏览器下发，执行也在浏览器 ==========
// 关键点：这里构造的 tool 一律不带 execute。
// AI SDK 的语义是——没有 execute 的工具，模型发出 tool-call 后本轮就结束，
// 把"谁来执行"交给外部；客户端执行完，再通过下一轮 run 把 tool 结果带回来继续生成。
// 这正是浏览器侧 Agent loop 的实现方式（对应前端 App.vue 的 driveAgent）。
function createFrontendTools(definitions, serverTools) {
  const tools = {}
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const name = typeof definition?.name === 'string' ? definition.name.trim() : ''
    // 同名一律以服务端工具优先，这是安全边界而不是代码风格：
    // definitions 来自请求体，属于不可信输入。若允许覆盖，
    // 前端就能下发一个同名 searchKnowledgeBase 把服务端检索能力劫持掉。
    if (!name || serverTools[name] || tools[name]) continue
    // 参数结构来自浏览器运行时，是普通 JSON 对象，没有 zod schema 可用，
    // 所以走 jsonSchema() 适配；缺失时给一个空对象结构，某些 provider 不接受 inputSchema 为空。
    const parameters = definition.parameters && typeof definition.parameters === 'object'
      ? definition.parameters
      : { type: 'object', properties: {} }
    tools[name] = tool({
      description: definition.description || name, // 没写描述就退回工具名，至少让模型有个标识
      inputSchema: jsonSchema(parameters)
      // 这里没有 execute —— 见本节开头，不是漏写
    })
  }
  return tools
}

// ========== 需要人工确认的工具（AG-UI interrupt / resume） ==========
// 同样是"故意不提供 execute"，但动机和前端工具不同：
// 前端工具是"执行方在别处"，审批工具是"执行要等一个人点头"。
//
// 为什么不在 execute 里 await 用户点击：
//   ① 会占住这条 HTTP 长连接，用户不急、去吃饭，连接就一直挂着；
//   ② 用户关页面/刷新，Promise 永远不 resolve，这次 run 变成僵尸；
//   ③ 服务端无法水平扩展（哪个实例拿着这个 Promise？）。
// interrupt/resume 把"等待"变成协议状态：本轮正常结束并返回 interrupt，
// 用户决定后用新请求 resume，服务端因此完全无状态。
const INTERRUPT_PREFIX = 'int_' // interrupt id 由服务端自己生成，用它承载 toolCallId
const APPROVAL_TOOL_NAME = 'deleteSessionFile'

function createApprovalTools() {
  return {
    [APPROVAL_TOOL_NAME]: tool({
      // 描述里"只有在用户明确要求删除附件时才调用"是第二道闸：
      // 第一道是 interrupt（执行前必暂停），这一道降低误触发概率——删除不可恢复，值得写死。
      description: '删除本次会话中已上传的某个附件。删除不可恢复，调用后会暂停并等待用户确认；只有在用户明确要求删除附件时才调用',
      inputSchema: z.object({
        // 强调"必须是清单里的完整文件名"：模型容易把文件名截断或改写成"简历.pdf"，
        // 到 resume 阶段按名字精确匹配时会找不到文件。
        fileName: z.string().describe('要删除的附件文件名，必须是附件清单里出现的完整文件名')
      })
    })
  }
}

/**
 * 在历史消息里找出某个工具调用的名称与入参，供 resume 时执行审批操作。
 *
 * 为什么需要它：resume 请求只带 interruptId，不带原始入参。
 * 服务端无状态，必须从历史消息里把"当时模型想删哪个文件"重新翻出来。
 * 只扫 assistant 消息，因为 tool-call 只会挂在 assistant 上。
 */
function findToolCall(messages, toolCallId) {
  for (const message of messages || []) {
    if (message?.role !== 'assistant') continue
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (call?.id === toolCallId) {
        return {
          name: call.function?.name,
          input: parseToolArguments(call.function?.arguments) // AG-UI 里入参是 JSON 字符串，要解析
        }
      }
    }
  }
  return null
}

/**
 * 执行用户已确认的审批工具。
 * 三道校验都不是多余的：resume 的 interruptId 来自客户端，属于不可信输入。
 */
function executeApprovalTool(toolName, input, sessionId) {
  if (toolName !== APPROVAL_TOOL_NAME) return `操作失败：未知的审批工具 ${toolName}` // 白名单：防止伪造中断去调别的工具
  const fileName = String(input?.fileName || '').trim()
  if (!fileName) return '删除失败：缺少文件名'
  // 只在本会话附件里找：防止构造一个别的会话的文件名来越权删除
  const file = getSessionFiles(sessionId).find(item => item.fileName === fileName)
  if (!file) return `删除失败：本次会话中没有名为「${fileName}」的附件`
  return deleteSessionFile(sessionId, file.fileId)
    ? `已删除附件：${fileName}`
    : `删除失败：${fileName}`
}

// ========== AG-UI 协议适配层 ==========
// 唯一的聊天入口。原 /api/chat 已删除：同时维护自研 SSE 与 AG-UI 两套协议，
// 每次改裁剪/附件逻辑都要做两遍回归，收益远小于成本。
const eventEncoder = new EventEncoder()

/** 把 AG-UI 消息内容（string 或 content parts）拍平成纯文本 */
function aguiMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        return part?.type === 'text' ? part.text || '' : ''
      })
      .join('')
  }
  return ''
}

/** AG-UI 的 toolCalls.function.arguments 是 JSON 字符串 */
function parseToolArguments(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * AG-UI messages -> AI SDK messages（P2）。
 * 直接消费 AG-UI 的结构化历史：assistant 的 toolCalls 还原成 tool-call part，
 * role='tool' 的结果还原成 tool-result part，模型因此能看到上一轮的工具调用与结果。
 */
function aguiToChatMessages(messages) {
  const chatMessages = []
  // toolCallId -> toolName：AG-UI 的 tool 消息只有 toolCallId，AI SDK 的结果 part 需要 toolName
  const toolNames = new Map()

  for (const message of messages || []) {
    if (!message) continue

    if (message.role === 'assistant') {
      const content = []
      const text = aguiMessageText(message)
      if (text.trim()) content.push({ type: 'text', text })
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        const name = call?.function?.name
        if (!call?.id || !name) continue
        toolNames.set(call.id, name)
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: name,
          input: parseToolArguments(call.function.arguments)
        })
      }
      if (content.length) chatMessages.push({ role: 'assistant', content })
      continue
    }

    if (message.role === 'tool') {
      const toolName = toolNames.get(message.toolCallId)
      // 找不到对应的 tool-call（如被裁剪掉）就丢弃，否则模型会收到悬空的结果
      if (!toolName) continue
      const text = aguiMessageText(message)
      chatMessages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.toolCallId,
          toolName,
          output: text.startsWith('工具执行失败：')
            ? { type: 'error-text', value: text }
            : { type: 'text', value: text }
        }]
      })
      continue
    }

    if (message.role === 'user') {
      const text = aguiMessageText(message)
      if (text.trim()) chatMessages.push({ role: 'user', content: text })
    }
  }

  return chatMessages
}

/** 工具返回值转成 TOOL_CALL_RESULT 需要的字符串 */
function toolOutputText(output) {
  if (typeof output === 'string') return output
  if (output && typeof output.text === 'string') return output.text
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

app.post('/agui', async (req, res) => {
  const input = req.body || {}
  const aguiMessages = Array.isArray(input.messages) ? input.messages : null
  if (!aguiMessages || !aguiMessages.length) {
    return res.status(400).json({ error: '缺少 messages' })
  }

  const threadId = input.threadId || randomUUID()
  const runId = input.runId || randomUUID()
  // 前端可以把 sessionId 放在 forwardedProps 里，用于会话附件检索
  const sessionId = input.forwardedProps?.sessionId || input.state?.sessionId || threadId
  const priorState = input.state && typeof input.state === 'object' ? input.state : {}
  const priorSources = Array.isArray(priorState.sources) ? priorState.sources : []

  res.setHeader('Content-Type', eventEncoder.getContentType())
  res.setHeader('Cache-Control', 'no-cache, no-transform') // 禁止压缩/缓冲，保证逐帧下发
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 关掉 Nginx 缓冲
  res.flushHeaders?.()

  let finished = false
  let closed = false
  let textOpen = false
  let reasoningOpen = false
  let assistantTextStarted = false
  let currentAssistantId = null
  let currentReasoningId = null
  let activeStep = null
  let stepIndex = 0
  let toolMessageSeq = 0
  let hasError = false
  // 本轮出现的审批类工具调用：不在流内执行，收尾时转成 interrupt
  const pendingApprovals = []

  const abortController = new AbortController()
  const send = (event) => {
    if (closed || res.writableEnded) return
    res.write(eventEncoder.encode({ timestamp: Date.now(), ...event }))
  }

  // res 的 close 在正常结束和客户端断开时都会触发，用 finished 区分
  res.on('close', () => {
    if (finished) return
    closed = true
    abortController.abort()
    console.log('[agui] 客户端断开，runId=%s', runId)
  })

  const ensureAssistant = () => {
    if (!currentAssistantId) currentAssistantId = `msg_asst_${randomUUID()}`
    return currentAssistantId
  }

  const closeReasoning = () => {
    if (!reasoningOpen) return
    send({ type: 'REASONING_MESSAGE_END', messageId: currentReasoningId })
    send({ type: 'REASONING_END', messageId: currentReasoningId })
    reasoningOpen = false
  }

  const openReasoning = () => {
    if (reasoningOpen) return
    closeText()
    currentReasoningId = `msg_reason_${randomUUID()}`
    send({ type: 'REASONING_START', messageId: currentReasoningId })
    send({ type: 'REASONING_MESSAGE_START', messageId: currentReasoningId, role: 'reasoning' })
    reasoningOpen = true
  }

  // 正文改用 TEXT_MESSAGE_CHUNK：客户端会自动合成 START / CONTENT，
  // 结束统一由 closeText 显式发 TEXT_MESSAGE_END，避免依赖客户端自行推断
  const closeText = () => {
    if (!textOpen) return
    if (currentAssistantId) send({ type: 'TEXT_MESSAGE_END', messageId: currentAssistantId })
    textOpen = false
  }

  // 返回 true 表示新开了一段文本流（chunk 需要带 role）
  const openText = () => {
    closeReasoning()
    if (textOpen) return false
    // 同一条 assistant 消息已经结束过，就新开一条，避免重复 TEXT_MESSAGE_START
    if (assistantTextStarted) {
      currentAssistantId = null
      assistantTextStarted = false
    }
    ensureAssistant()
    textOpen = true
    assistantTextStarted = true
    return true
  }

  try {
    // ===== resume：把用户对 interrupt 的决定写回历史，模型才能接着生成 =====
    const resumeEntries = Array.isArray(input.resume) ? input.resume : []
    const resumeOutputs = []
    for (const entry of resumeEntries) {
      const interruptId = typeof entry?.interruptId === 'string' ? entry.interruptId : ''
      if (!interruptId.startsWith(INTERRUPT_PREFIX)) continue
      const toolCallId = interruptId.slice(INTERRUPT_PREFIX.length)
      if (!toolCallId) continue
      // 客户端可能重放请求，已有结果的调用不重复执行
      const hasResult = aguiMessages.some(message => message?.role === 'tool' && message.toolCallId === toolCallId)
      if (hasResult) continue
      const call = findToolCall(aguiMessages, toolCallId)
      if (!call) continue
      const approved = entry.status === 'resolved' && entry.payload?.approved !== false
      const output = approved
        ? executeApprovalTool(call.name, call.input, sessionId)
        : '用户拒绝了该操作，未执行'
      // 结果写回历史：快照、模型上下文、前端卡片都靠这条消息对齐
      const messageId = `msg_tool_${++toolMessageSeq}`
      aguiMessages.push({ id: messageId, role: 'tool', content: output, toolCallId })
      resumeOutputs.push({ messageId, toolCallId, content: output })
      console.log('[agui] resume 处理中断 %s，approved=%s', interruptId, approved)
    }

    const serverTools = createTools(sessionId)
    const approvalTools = createApprovalTools()
    const frontendTools = createFrontendTools(input.tools, { ...serverTools, ...approvalTools })
    const tools = { ...serverTools, ...approvalTools, ...frontendTools }
    const frontendToolNames = Object.keys(frontendTools)
    if (frontendToolNames.length) console.log('[agui] 前端工具：%s', frontendToolNames.join(', '))
    // AG-UI 结构化历史还原成 AI SDK 消息，再交给 chat-core 统一处理
    const chatMessages = aguiToChatMessages(aguiMessages)
    // 裁剪上下文 + 注入附件清单 + 挂载图片 + 选模型
    const { result, meta } = prepareChatStream({
      messages: chatMessages,
      sessionId,
      tools,
      abortSignal: abortController.signal, // 客户端断开时中止模型流
      logTag: 'agui'
    })
    const { isTrimmed, droppedCount } = meta
    console.log('[agui] threadId=%s runId=%s 消息=%d 裁剪后=%d 图片=%d 模型=%s', threadId, runId, meta.inputCount, meta.inputCount - droppedCount, meta.imageCount, meta.modelId)

    send({ type: 'RUN_STARTED', threadId, runId })
    // 不再下发 MESSAGES_SNAPSHOT：服务端无状态，历史以客户端 RunAgentInput.messages 为准。
    // 该事件语义是“整段消息列表替换”，只在服务端真的改写历史（如会话存储/压缩）时才发。
    send({ type: 'STATE_SNAPSHOT', snapshot: { ...priorState, phase: 'running', sources: priorSources } })
    // 续跑开始：先把用户确认后的工具结果回传，前端据此把待确认卡片标记为完成
    for (const item of resumeOutputs) {
      send({
        type: 'TOOL_CALL_RESULT',
        messageId: item.messageId,
        toolCallId: item.toolCallId,
        role: 'tool',
        content: item.content
      })
    }
    if (isTrimmed) {
      send({
        type: 'CUSTOM',
        name: 'trim_notice',
        value: { content: '对话过长，已精简早期上下文', droppedMessages: droppedCount, maxTokenLimit: MAX_CONTEXT_TOKENS }
      })
    }

    for await (const part of result.fullStream) {
      if (closed) break

      if (part.type === 'start-step') {
        stepIndex++
        activeStep = `step-${stepIndex}`
        send({ type: 'STEP_STARTED', stepName: activeStep })
      } else if (part.type === 'finish-step') {
        // STEP_FINISHED 是非 chunk 事件，客户端会自动给文本流补 TEXT_MESSAGE_END
        closeText()
        if (activeStep) {
          send({ type: 'STEP_FINISHED', stepName: activeStep })
          activeStep = null
        }
      } else if (part.type === 'reasoning-delta') {
        if (!part.text) continue
        openReasoning()
        send({ type: 'REASONING_MESSAGE_CONTENT', messageId: currentReasoningId, delta: part.text })
      } else if (part.type === 'text-delta') {
        if (!part.text) continue
        const opened = openText()
        send({
          type: 'TEXT_MESSAGE_CHUNK',
          // 开头的分片带 messageId + role，续写分片省略（省略表示延续当前消息）
          ...(opened ? { messageId: currentAssistantId, role: 'assistant' } : {}),
          delta: part.text
        })
      } else if (part.type === 'tool-call') {
        // 工具调用挂到当前 assistant 消息上，先结束文本流
        const parentMessageId = ensureAssistant()
        closeText()
        closeReasoning()
        // 审批类工具没有 execute，本轮不会产生 tool-result，先记下来留到收尾转成 interrupt
        if (part.toolName === APPROVAL_TOOL_NAME) {
          pendingApprovals.push({ toolCallId: part.toolCallId, input: part.input })
        }
        send({
          type: 'TOOL_CALL_START',
          toolCallId: part.toolCallId,
          toolCallName: part.toolName,
          parentMessageId
        })
        // AG-UI 的 args 是 JSON 字符串增量；这里一次性给出完整入参
        send({ type: 'TOOL_CALL_ARGS', toolCallId: part.toolCallId, delta: JSON.stringify(part.input ?? {}) })
        send({ type: 'TOOL_CALL_END', toolCallId: part.toolCallId })
      } else if (part.type === 'tool-result') {
        send({
          type: 'TOOL_CALL_RESULT',
          messageId: `msg_tool_${++toolMessageSeq}`,
          toolCallId: part.toolCallId,
          role: 'tool',
          content: toolOutputText(part.output)
        })
        // 检索工具的 sources 走共享状态，前端可直接渲染引用来源
        const sources = Array.isArray(part.output?.sources) ? part.output.sources : []
        if (sources.length) {
          send({
            type: 'STATE_DELTA',
            delta: sources.map(source => ({ op: 'add', path: '/sources/-', value: source }))
          })
        }
        // 工具结果之后，模型下一段文本属于新的 assistant 消息
        currentAssistantId = null
        assistantTextStarted = false
      } else if (part.type === 'tool-error') {
        const errorMessage = part.error instanceof Error ? part.error.message : String(part.error)
        send({
          type: 'TOOL_CALL_RESULT',
          messageId: `msg_tool_${++toolMessageSeq}`,
          toolCallId: part.toolCallId,
          role: 'tool',
          content: `工具执行失败：${errorMessage}`
        })
        // 结果事件无法区分成功/失败，额外发一条自定义事件让前端把步骤标记为失败
        send({
          type: 'CUSTOM',
          name: 'tool_error',
          value: { toolCallId: part.toolCallId, message: errorMessage }
        })
        currentAssistantId = null
        assistantTextStarted = false
      } else if (part.type === 'error') {
        console.error('[agui] 流式错误', part.error)
        hasError = true
        // 出错前先把还开着的文本/思考流收口，客户端才不会留下"永远生成中"的气泡
        closeText()
        closeReasoning()
        send({
          type: 'RUN_ERROR',
          message: part.error instanceof Error ? part.error.message : String(part.error),
          code: 'STREAM_ERROR'
        })
        abortController.abort()
        break
      } else if (part.type === 'abort') {
        console.log('[agui] 模型流已中止：', part.reason)
        closeText()
        closeReasoning()
      }
    }

    if (!closed && !hasError) {
      closeText()
      closeReasoning()
      if (activeStep) {
        send({ type: 'STEP_FINISHED', stepName: activeStep })
        activeStep = null
      }
      if (pendingApprovals.length) {
        // 有工具调用等用户确认：以 interrupt 结束本次 run，客户端 resume 时再继续
        send({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/phase', value: 'interrupted' }] })
        send({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          outcome: {
            type: 'interrupt',
            interrupts: pendingApprovals.map(item => ({
              id: `${INTERRUPT_PREFIX}${item.toolCallId}`,
              reason: 'approval',
              message: `即将删除附件「${item.input?.fileName || ''}」，删除后不可恢复，是否允许？`,
              toolCallId: item.toolCallId,
              responseSchema: {
                type: 'object',
                properties: { approved: { type: 'boolean', description: '是否允许执行该操作' } },
                required: ['approved']
              },
              metadata: { toolName: APPROVAL_TOOL_NAME, input: item.input }
            }))
          }
        })
      } else {
        send({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/phase', value: 'done' }] })
        send({ type: 'RUN_FINISHED', threadId, runId })
      }
    }
  } catch (err) {
    if (closed || err?.name === 'AbortError') {
      console.log('[agui] 请求已中断，runId=%s', runId)
    } else {
      console.error('[agui] 处理失败', err)
      send({ type: 'RUN_ERROR', message: err?.message || '服务异常', code: 'INTERNAL_ERROR' })
    }
  } finally {
    finished = true
    if (!res.writableEnded) res.end()
  }
})


// ========== 文件上传配置 ==========
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 单文件大小上限 10MB

// multer 以 latin1 解析文件名，中文会乱码，这里转回 utf8
function fixFileName(name = '') {
  if (!/[\u0080-\u00ff]/.test(name)) return name
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? name : decoded
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  // 保留原始文件名，但去掉可能携带的路径分隔符
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + fixFileName(file.originalname).replace(/[\\/]/g, '_'))
})

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }, // 超过上限时 multer 中止写入并抛 LIMIT_FILE_SIZE
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_EXTS.includes(ext)) {
      return cb(new Error(`不支持的文件类型：${ext || '未知'}，仅支持 ${ALLOWED_EXTS.join(' / ')}`))
    }
    cb(null, true)
  }
})

// 会话附件额外允许图片：图片不解析文本，直接交给视觉模型
const SESSION_ALLOWED_EXTS = [...ALLOWED_EXTS, ...IMAGE_EXTS]
const sessionUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixFileName(file.originalname)).toLowerCase()
    if (!SESSION_ALLOWED_EXTS.includes(ext)) {
      return cb(new Error(`不支持的文件类型：${ext || '未知'}，仅支持 ${SESSION_ALLOWED_EXTS.join(' / ')}`))
    }
    cb(null, true)
  }
})

// 图片后缀 -> MIME，供视觉模型识别
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

// multer 的错误不会进入路由的 try/catch，这里统一转成 JSON 响应
const uploadSessionFile = (req, res, next) => {
  sessionUpload.single('file')(req, res, (err) => {
    if (!err) return next()
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` })
    }
    return res.status(400).json({ error: err.message })
  })
}

// ========== 上传接口 ==========
// 解析 → 切块 → 覆盖同名旧片段 → 入库，全部在服务端一次完成。
// 为什么不再有 /api/embedding-add：那个端点接收前端传来的 chunks 直接入库，等于绕过了文件解析，
// 任何人都能往知识库写任意文本（语料投毒，且能覆盖同名文档）；切块结果还要在网络上白跑两趟。
// 业务标签白名单：只认这几类，前端传别的值一律丢弃，避免脏值进 metadata 后过滤失效
const DOC_TYPES = ['resume', 'jd', 'policy', 'other']

app.post('/api/upload-doc', upload.single('file'), async (req, res) => {
  // 提到 try 外面：校验失败时也要能拿到路径去删文件
  const filePath = req.file?.path
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' })

    // multer 会把 FormData 里除文件外的普通字段放进 req.body
    const docType = DOC_TYPES.includes(req.body?.docType) ? req.body.docType : undefined
    const jobId = String(req.body?.jobId || '').trim() || undefined
    const candidateId = String(req.body?.candidateId || '').trim() || undefined

    // 业务约束：简历必须能对应到某个候选人，否则入库后无法按候选人隔离检索
    if (docType === 'resume' && !candidateId) {
      fs.unlink(filePath, () => {}) // multer 已把文件落盘，校验失败必须清掉，否则 uploads 会攒垃圾文件
      return res.status(400).json({ error: '简历必须带 candidateId（候选人标识）' })
    }
    if (docType === 'jd' && !jobId) {
      fs.unlink(filePath, () => {})
      return res.status(400).json({ error: '岗位 JD 必须带 jobId（岗位标识）' })
    }

    const fileName = fixFileName(req.file.originalname)
    const ext = path.extname(fileName).toLowerCase()
    const rawText = await extractFileText(filePath, ext)
    const chunks = splitTextIntoChunks(rawText, 800, 150)
    if (!chunks.length) return res.status(400).json({ error: '未能从文件中解析出文本' })

    // 同名文档重新上传时先删掉旧片段，避免向量库里出现重复内容
    const removed = await deleteDocument(fileName)
    // 第三个参数就是刚加的业务标签；不传时行为与之前完全一致
    await batchInsertEmbedding(chunks, fileName, { docType, jobId, candidateId })

    res.json({
      ok: true,
      filename: fileName,
      chunkCount: chunks.length,
      removed,
      docType,
      jobId,
      candidateId,
      msg: `成功入库${chunks.length}个文本块${removed ? `，已覆盖旧片段${removed}个` : ''}`
    })
  } catch (err) {
    console.error('文档上传解析失败：', err)
    res.status(500).json({ error: err.message })
  }
})

// 文档列表：按文件名聚合，前端左侧文档栏使用
app.get('/api/documents', async (req, res) => {
  try {
    const data = await getDocuments()
    res.json({ ok: true, data })
  } catch (err) {
    console.error('获取文档列表失败', err)
    res.status(500).json({ error: err.message })
  }
})
// 删除文档：按文件名删掉向量库中对应的全部片段
app.post('/api/documents/delete', async (req, res) => {
  try {
    const { fileName } = req.body
    if (!fileName) return res.status(400).json({ error: '缺少fileName' })
    const removed = await deleteDocument(fileName)
    res.json({ ok: true, fileName, removed })
  } catch (err) {
    console.error('删除文档失败', err)
    res.status(500).json({ error: err.message })
  }
})
// ========== 会话级临时附件：只服务本次对话，不写入知识库 ==========
// 文档：解析文本并生成向量；图片：保存 base64，随消息交给视觉模型
app.post('/api/session-files/upload', uploadSessionFile, async (req, res) => {
  try {
    const { sessionId } = req.body
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' })
    if (!req.file) return res.status(400).json({ error: '请上传文件' })

    const fileName = fixFileName(req.file.originalname)
    const ext = path.extname(fileName).toLowerCase()

    // 图片不解析文本、不向量化：读成 base64 存入会话，聊天时拼到 user 消息里
    if (IMAGE_EXTS.includes(ext)) {
      const file = addSessionImage(sessionId, {
        fileName,
        mimeType: IMAGE_MIME[ext] || 'image/png',
        buffer: await fs.promises.readFile(req.file.path),
        size: req.file.size
      })
      return res.json({ ok: true, file: { ...file, kind: 'image' } })
    }

    const rawText = await extractFileText(req.file.path, ext)
    const file = await addSessionFile(sessionId, {
      fileName,
      text: rawText,
      size: req.file.size
    })
    res.json({ ok: true, file: { ...file, kind: 'doc' } })
  } catch (err) {
    console.error('会话附件处理失败：', err)
    res.status(500).json({ error: err.message })
  } finally {
    // 处理完成后删除落盘文件，内容已转成内存向量或 base64
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {})
  }
})
// 删除会话中的一个附件
app.post('/api/session-files/delete', (req, res) => {
  try {
    const { sessionId, fileId } = req.body || {}
    if (!sessionId || !fileId) return res.status(400).json({ error: '缺少 sessionId 或 fileId' })
    const removed = deleteSessionFile(sessionId, fileId)
    res.json({ ok: true, removed })
  } catch (err) {
    console.error('删除会话附件失败', err)
    res.status(500).json({ error: err.message })
  }
})

// 清空知识库不走 HTTP：原 /api/vector-clear 没有鉴权，部署到公网后一次 POST 就能清库。
// 需要重建时用 npm run eval:ingest（会先删同名文档再入库），彻底清空直接删 vector-index/ 目录。

app.listen(PORT, () => { // 启动 HTTP 服务并监听端口
  console.log(`✅ 服务启动 http://localhost:${PORT}`) // 启动成功后打印访问地址
})
