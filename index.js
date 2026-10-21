require('dotenv').config() // 加载 .env 中的环境变量（DEEPSEEK_API_KEY）
const express = require('express') // 引入 Express 框架
const { streamText, tool, stepCountIs, jsonSchema } = require('ai') // 引入 AI SDK：流式生成、工具定义、步数限制、JSON Schema 适配
const { createDeepSeek } = require('@ai-sdk/deepseek') // 引入 DeepSeek 模型提供方
const { z } = require('zod') // 引入 zod，用于声明工具入参结构
const { getEncoding } = require('js-tiktoken') // 引入 BPE 分词器，用于统计 token 数量（cl100k_base 编码）
const multer = require('multer')
const { randomUUID } = require('node:crypto') // 生成 AG-UI 的 threadId / runId / messageId
const { EventEncoder } = require('@ag-ui/encoder') // AG-UI 官方 SSE 事件编码器
const fs = require('fs') // 用于清理解析后的临时文件
const path = require('path') // 用于解析上传文件的后缀名
const { UPLOAD_DIR, ALLOWED_EXTS, IMAGE_EXTS, extractFileText, splitTextIntoChunks } = require('./rag-utils')
const { initVectorStore, batchInsertEmbedding, searchVector, getAllItems, getDocuments, deleteDocument, clearVectorIndex } = require('./rag-vector')
const { addSessionFile, addSessionImage, deleteSessionFile, getSessionFiles, getSessionImages, searchSessionFiles } = require('./session-files')
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

const deepseek = createDeepSeek({ // 创建 DeepSeek 客户端
  apiKey: DEEPSEEK_API_KEY // 传入 API Key 用于鉴权
})



// ===== 统计 token：DeepSeek 未提供官方 npm 分词库，这里用 cl100k_base 编码做近似统计 =====
const tokenizer = getEncoding('cl100k_base') // 初始化分词器（首次调用会加载词表，后续复用）

/**
 * 估算单段文本的 token 数量
 * @param {string} text - 输入的文本
 * @returns {number} - 计算得到的 token 数量
 */

function getTextToken(text) {
  if (!text) return 0
  return tokenizer.encode(String(text)).length
}

/**
 * 取出单条消息用于统计 token 的文本。
 * content 可能是字符串，也可能是结构化 parts（tool-call / tool-result / 图片）。
 */
function modelMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text || ''
      if (part?.type === 'tool-call') return `${part.toolName}${JSON.stringify(part.input ?? {})}`
      if (part?.type === 'tool-result') {
        const value = part.output?.value
        return typeof value === 'string' ? value : JSON.stringify(value ?? '')
      }
      return '' // 图片等非文本 part 不计入
    })
    .join('')
}

/**
 * 统计messages数组中所有文本的token数量
 * @param {Array} messages - 输入的文本
 * @returns {number} - 计算得到的token数量
 */

function countMessagesToken(messages) {
  let totalToken = 0
  for (let msg of messages) {
    const roleToken = getTextToken(msg.role)
    const contentToken = getTextToken(modelMessageText(msg))
    totalToken += roleToken + contentToken
    // 消息结构额外预留固定token开销
    totalToken += 8
  }
  return totalToken
}

/**
 * 消息token裁剪
 * @param {Array} messages - 输入的文本
 * @param {number} maxTokenLimit - 目标token数量上限
 * @returns {{trimmedMessages: Array, isTrimmed: boolean}} - 裁剪后的消息的消息数组  
 */

function trimMessages(messages, maxTokenLimit = 6000) {
  const msgList = structuredClone(messages)
  let isTrimmed = false // 是否发生过裁剪
  // 超出上限时不断移除最早的消息，直到满足上限或只剩最后 2 条
  while (countMessagesToken(msgList) > maxTokenLimit && msgList.length > 10) {
    msgList.shift()
    isTrimmed = true
    // 裁剪可能把带 tool-call 的 assistant 丢掉，只留下悬空的 tool 结果；
    // 模型接口会拒绝悬空结果，这里把开头的 tool 消息一并清掉
    while (msgList.length && msgList[0]?.role === 'tool') msgList.shift()
  }
  return {
    trimmedMessages: msgList,
    isTrimmed
  }
}


// ========== 会话附件上下文 ==========
/**
 * 生成附件清单系统提示。
 * 聊天请求里只有文本，模型本身看不到附件；把本次会话的附件清单和内容预览作为 instructions 注入，
 * 模型才知道用户上传了什么，也才会在“这是什么”这类短问题下去检索附件。
 */
function buildAttachmentSystemPrompt(sessionId) {
  if (!sessionId) return ''
  const files = getSessionFiles(sessionId)
  if (!files.length) return ''
  const list = files
    .map((file, index) => {
      const size = `${(file.size / 1024).toFixed(1)} KB`
      if (file.kind === 'image') {
        return `【附件${index + 1}】${file.fileName}（${size}，图片）\n说明：图片已随消息一起提供，可直接查看图片内容回答。`
      }
      return `【附件${index + 1}】${file.fileName}（${size}，共 ${file.chunkCount} 个片段）\n内容预览：${file.preview}`
    })
    .join('\n\n')
  return `用户在本次对话中上传了以下附件（仅本次会话有效）：\n\n${list}\n\n处理规则：
1. 用户询问“这是什么”“总结一下”“帮我看看”等涉及附件的问题时，文本附件必须先调用 searchKnowledgeBase 工具检索原文，再基于检索结果回答；图片附件已随消息提供，直接查看图片回答即可。
2. 回答附件内容时以原文或图片实际内容为准，说明内容来自哪个附件，不要编造。
3. 如果文本附件解析不到有效文本（例如扫描版 PDF），如实告诉用户，并建议提供文字版。
4. 用户明确要求删除某个附件时，调用 deleteSessionFile 并在入参里传完整文件名；该工具会先暂停等待用户确认。`
}

// 判断用户问题是否在问本次附件；短问题（如“这是什么”）也按附件意图处理
function isAttachmentQuery(query, files) {
  const q = String(query || '').trim()
  if (!q) return false
  if (files.some(file => q.includes(file.fileName) || file.fileName.includes(q))) return true
  if (/附件|文件|文档|发票|这个|这份|这张|上述|它|总结|概括/.test(q)) return true
  return q.length <= 6
}

/**
 * 把本次会话的图片附件挂到最后一条 user 消息上。
 * DeepSeek 只允许 user 消息携带图片，所以图片统一跟随当前提问发送；
 * 没有图片时原样返回，纯文本文档对话不受影响。
 */
function attachImagesToLastUserMessage(messages, images) {
  if (!images.length) return messages
  const list = messages.map(message => ({ ...message }))
  const lastUserIndex = list.map(message => message.role).lastIndexOf('user')
  if (lastUserIndex < 0) return list
  const content = String(list[lastUserIndex].content || '')
  list[lastUserIndex] = {
    role: 'user',
    content: [
      { type: 'text', text: content },
      ...images.map(image => ({
        type: 'file', // v7 推荐用 file part 承载图片，image part 已标记废弃
        mediaType: image.mimeType,
        data: { type: 'data', data: image.base64 }
      }))
    ]
  }
  return list
}

// ========== 工具集合：按会话构建 ==========
// 会话级临时附件需要 sessionId 才能检索，所以这里用工厂函数，每个请求生成一份工具
function createTools(sessionId) {
  return {
    getCurrentTime: tool({ // 工具1：获取服务器当前时间
      description: '获取服务器当前时间，当用户问现在几点、当前日期时使用', // 工具说明，帮助模型判断调用时机
      inputSchema: z.object({}), // 入参结构：该工具无需参数
      execute: async () => { // 工具的实际执行逻辑
        const now = new Date() // 获取当前时间对象
        return now.toLocaleString('zh-CN') // 转成中文格式字符串并返回给模型
      }
    }),

    calculator: tool({ // 工具2：四则运算计算器
      description: '数学计算器，用于计算加减乘除，用户有数学计算时调用', // 工具说明，帮助模型判断调用时机
      inputSchema: z.object({ // 声明工具入参结构
        a: z.number().describe('第一个数字'), // 参数 a：数字类型
        b: z.number().describe('第二个数字'), // 参数 b：数字类型
        op: z.enum(['+', '-', '*', '/']).describe('运算符') // 参数 op：仅允许四种运算符
      }),
      execute: async ({ a, b, op }) => { // 接收模型给出的结构化参数
        let res // 存放计算结果
        switch (op) { // 根据运算符走不同分支
          case '+': res = a + b; break // 加法
          case '-': res = a - b; break // 减法
          case '*': res = a * b; break // 乘法
          case '/': // 除法分支
            if (b === 0) return '错误：除数不能为0' // 除数为 0 时返回错误信息
            res = a / b; break // 正常除法
          default: // 兜底分支
            return '错误：运算符仅支持 + - * /' // 非法运算符时返回错误信息
        }
        return `计算结果：${a} ${op} ${b} = ${res}` // 把结果拼成可读文本返回
      }
    }),
    searchKnowledgeBase: tool({ // 工具3：知识库 + 本次会话附件检索
      description: `在知识库文档和本次会话附件中检索原文。以下情况必须调用：
            1. 用户上传了附件，并询问附件内容（如“这是什么”“总结一下”“帮我看看这份文件”“发票金额是多少”）；
            2. 用户询问和简历、个人信息、项目经历、技能、工作年限相关的问题。
            回答文档内容时不要编造信息；如果问题和文档、附件都无关，不要调用这个工具，直接回答。`,
      inputSchema: z.object({
        query: z.string().describe("用户的检索关键词/问题，用来在知识库做语义检索"),
        topK: z.number().int().min(1).max(5).default(3).describe("返回几条匹配片段")
      }),
      // 工具执行回调：模型调用工具时，执行这里
      async execute({ query, topK }) {
        console.log(`🔍 Agent调用知识库检索，query：${query}`)
        // 并行检索：知识库（长期） + 本次会话附件（临时），合并后按相似度排序
        const [kbResult, sessionResult] = await Promise.all([
          searchVector(query, topK),
          searchSessionFiles(sessionId, query, topK)
        ])
        const knowledge = kbResult.map(item => ({ ...item, sourceType: 'knowledge' }))
        const attachments = sessionResult.map(item => ({ ...item, sourceType: 'attachment' }))
        let searchResult
        if (attachments.length && isAttachmentQuery(query, getSessionFiles(sessionId))) {
          // 附件意图：先给附件片段（已按相似度降序），不足 topK 再用知识库补足，避免被知识库挤占
          searchResult = [...attachments.slice(0, topK), ...knowledge].slice(0, topK)
        } else {
          searchResult = [...knowledge, ...attachments].sort((a, b) => b.score - a.score).slice(0, topK)
        }
        if (!searchResult.length) return { text: '知识库和本次会话附件中都没有检索到相关内容', sources: [] }
        // text 给模型阅读；sources 给前端渲染【引用来源】。对象由 SSE 以 JSON 传输，不会被转义成字面 \n
        return {
          text: searchResult
            .map((item, i) => `【片段${i + 1}】相似度：${item.score.toFixed(3)}\n来源：${item.fileName}${item.sourceType === 'attachment' ? '（本次会话附件）' : ''}\n${item.content}`)
            .join('\n\n'),
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
// 这里只转换定义、不提供 execute：模型发出 tool-call 后本轮即结束，
// 由客户端本地执行，再通过下一轮 run 把 tool 结果带回来继续生成
function createFrontendTools(definitions, serverTools) {
  const tools = {}
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const name = typeof definition?.name === 'string' ? definition.name.trim() : ''
    // 同名以服务端工具优先，避免前端覆盖服务端能力
    if (!name || serverTools[name] || tools[name]) continue
    const parameters = definition.parameters && typeof definition.parameters === 'object'
      ? definition.parameters
      : { type: 'object', properties: {} }
    tools[name] = tool({
      description: definition.description || name,
      inputSchema: jsonSchema(parameters)
    })
  }
  return tools
}

// ========== 需要人工确认的工具（AG-UI interrupt / resume） ==========
// 故意不提供 execute：模型发出调用后本轮结束，服务端以 RUN_FINISHED 的 interrupt 结果暂停，
// 等客户端用 resume 回传用户决定后，下一轮 run 再真正执行并继续生成
const INTERRUPT_PREFIX = 'int_'
const APPROVAL_TOOL_NAME = 'deleteSessionFile'

function createApprovalTools() {
  return {
    [APPROVAL_TOOL_NAME]: tool({
      description: '删除本次会话中已上传的某个附件。删除不可恢复，调用后会暂停并等待用户确认；只有在用户明确要求删除附件时才调用',
      inputSchema: z.object({
        fileName: z.string().describe('要删除的附件文件名，必须是附件清单里出现的完整文件名')
      })
    })
  }
}

/** 在历史消息里找出某个工具调用的名称与入参，供 resume 时执行审批操作 */
function findToolCall(messages, toolCallId) {
  for (const message of messages || []) {
    if (message?.role !== 'assistant') continue
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (call?.id === toolCallId) {
        return {
          name: call.function?.name,
          input: parseToolArguments(call.function?.arguments)
        }
      }
    }
  }
  return null
}

/** 执行用户已确认的审批工具 */
function executeApprovalTool(toolName, input, sessionId) {
  if (toolName !== APPROVAL_TOOL_NAME) return `操作失败：未知的审批工具 ${toolName}`
  const fileName = String(input?.fileName || '').trim()
  if (!fileName) return '删除失败：缺少文件名'
  const file = getSessionFiles(sessionId).find(item => item.fileName === fileName)
  if (!file) return `删除失败：本次会话中没有名为「${fileName}」的附件`
  return deleteSessionFile(sessionId, file.fileId)
    ? `已删除附件：${fileName}`
    : `删除失败：${fileName}`
}

const encodeLine = (text) => String(text).replace(/\r\n|\r|\n/g, '\\n') // 把真实换行转成字面量 \n，保证每条消息只占一行

// 流式聊天接口，开启工具调用
app.post('/api/chat', async (req, res) => { // 定义 POST /api/chat 路由
  try { // 统一捕获异常，避免服务崩溃
    const { messages, sessionId } = req.body // 取出前端传来的历史消息列表与会话标识
    console.log('sessionId', sessionId)
    if (!messages) return res.status(400).send('缺少messages') // 参数校验：缺少消息时返回 400
    const tools = createTools(sessionId) // 按会话构建工具，检索时带上本次会话的临时附件
    const { trimmedMessages, isTrimmed } = trimMessages(messages, 1000) // 裁剪消息，目标 token 上限 6000
    // 把本次会话附件清单注入上下文，否则模型不知道用户上传了什么
    const attachmentPrompt = buildAttachmentSystemPrompt(sessionId)
    // 图片附件作为多模态内容附在最后一条用户消息上，并切换到支持视觉的模型
    const images = getSessionImages(sessionId)
    const modelMessages = attachImagesToLastUserMessage(trimmedMessages, images)
    console.log('原始消息数量：', messages.length)
    console.log('裁剪后消息数量：', trimmedMessages.length, '是否裁剪：', isTrimmed, '图片数量：', images.length)
    const result = await streamText({ // 调用模型，拿到流式结果对象
      model: deepseek(images.length ? 'deepseek-flash' : 'deepseek-reasoner'), // 有图片时用视觉模型，否则保持推理模型
      instructions: attachmentPrompt || undefined, // 附件清单作为系统指令注入
      messages: modelMessages, // ✅ 传给模型的是裁剪后的消息（含图片）
      tools, // 注入上面定义的工具列表
      stopWhen: stepCountIs(5), // 最多连续执行 5 步工具调用，防止死循环
      // 监听每一步ReAct事件，打印日志（关键！看Agent循环）
      onStepFinish: (step) => {
        console.log('\n📌 ReAct 单步完成：')
        console.log('当前步数：', step.stepNumber)
        console.log('工具调用：', step.toolCalls)
        console.log('工具返回：', step.toolResults)
      },
      onFinish() {
        res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`)
      }
    })

    res.setHeader('Content-Type', 'text/plain; charset=utf-8') // 声明响应为 UTF-8 纯文本流
    res.setHeader('Cache-Control', 'no-cache') // 禁止缓存，保证实时性
    res.setHeader('Connection', 'keep-alive') // 保持长连接，便于持续推送
    res.flushHeaders?.() // 立即发送响应头，让浏览器尽早进入流式接收
    // 如果裁剪了消息，向前端推送自定义事件，前端展示提示
    if (isTrimmed) {
      res.write(`data: ${JSON.stringify({ type: 'trim_notice', content: '对话过长，已精简早期上下文' })}\n\n`)
    }
    // 前端约定：think:思考过程，answer:正式回答，tool-call/tool-result/tool-error:工具事件（每行一个 JSON）
    for await (const part of result.fullStream) { // 逐块消费模型输出的完整事件流
      if (part.type === 'reasoning-delta') { // 命中推理过程增量
        res.write(`think:${encodeLine(part.text)}\n`) // 以 think: 前缀输出思考内容
      } else if (part.type === 'text-delta') { // 命中正式回答增量
        res.write(`answer:${encodeLine(part.text)}\n`) // 以 answer: 前缀输出回答内容
      } else if (part.type === 'tool-call') { // 模型决定调用工具
        res.write(`tool-call:${JSON.stringify({ // JSON.stringify 会转义换行，保证一行一条消息
          id: part.toolCallId, // 工具调用 id，用于和结果配对
          name: part.toolName, // 工具名称
          input: part.input // 模型给出的入参
        })}\n`)
      } else if (part.type === 'tool-result') { // 工具执行完成
        res.write(`tool-result:${JSON.stringify({
          id: part.toolCallId, // 对应 tool-call 的 id
          name: part.toolName, // 工具名称
          output: part.output // 工具返回值
        })}\n`)
      } else if (part.type === 'tool-error') { // 工具执行抛出异常
        res.write(`tool-error:${JSON.stringify({
          id: part.toolCallId, // 对应 tool-call 的 id
          name: part.toolName, // 工具名称
          error: part.error instanceof Error ? part.error.message : String(part.error) // 统一成可读文本
        })}\n`)
      } else if (part.type === 'error') { // 命中流式错误事件
        console.error('流式错误', part.error) // 打印错误，便于排查
      }
    }

    res.end() // 正常结束响应流
  } catch (err) { // 捕获请求处理过程中的异常
    console.error(err) // 打印错误堆栈
    if (!res.headersSent) { // 响应头尚未发送时
      res.status(500).json({ error: '服务异常' }) // 返回标准 500 错误
    } else { // 已经进入流式响应时
      res.end() // 只能直接结束流，避免挂起
    }
  }
})


// ========== AG-UI 协议适配层（P0） ==========
// 保留 /api/chat 不动，新增 /agui；两者共用同一套模型、工具、附件与裁剪逻辑。
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

/**
 * 历史消息规范化为 MESSAGES_SNAPSHOT 消息：
 * 去掉空内容，assistant 保留 toolCalls，保证快照能直接回放成对话。
 */
function toSnapshotMessages(messages) {
  const snapshot = []

  for (const message of messages || []) {
    if (!message || !message.role) continue
    const id = message.id || `msg_snap_${snapshot.length}`
    const text = aguiMessageText(message)

    if (message.role === 'assistant') {
      const toolCalls = (Array.isArray(message.toolCalls) ? message.toolCalls : [])
        .filter(call => call?.id && call?.function?.name)
        .map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments:
              typeof call.function.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function.arguments ?? {})
          }
        }))
      // 只有工具调用的 assistant 消息没有正文，但必须保留，否则工具结果会悬空
      if (!text.trim() && !toolCalls.length) continue
      snapshot.push({ id, role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) })
      continue
    }

    if (message.role === 'tool') {
      if (!message.toolCallId) continue
      snapshot.push({ id, role: 'tool', content: text, toolCallId: message.toolCallId })
      continue
    }

    if (message.role === 'user' && text.trim()) {
      snapshot.push({ id, role: 'user', content: text })
    }
  }

  return snapshot
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

  // 正文改用 TEXT_MESSAGE_CHUNK：客户端会自动合成 START / CONTENT / END，
  // 服务端只需维护本地状态，收尾由后续非 chunk 事件（STEP_FINISHED / RUN_FINISHED）触发
  const closeText = () => {
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
    const chatMessages = aguiToChatMessages(aguiMessages)
    const { trimmedMessages, isTrimmed } = trimMessages(chatMessages, 1000)
    const droppedMessages = chatMessages.length - trimmedMessages.length
    // 附件清单注入 + 图片挂到最后一条 user 消息，与 /api/chat 保持一致
    const attachmentPrompt = buildAttachmentSystemPrompt(sessionId)
    const images = getSessionImages(sessionId)
    const modelMessages = attachImagesToLastUserMessage(trimmedMessages, images)
    console.log('[agui] threadId=%s runId=%s 消息=%d 裁剪后=%d 图片=%d', threadId, runId, chatMessages.length, trimmedMessages.length, images.length)

    send({ type: 'RUN_STARTED', threadId, runId })
    // 线程消息快照：把服务端确认的完整历史下发给客户端，
    // AG-UI 客户端据此校准线程消息；本地已有历史时各端自行决定是否采用
    send({ type: 'MESSAGES_SNAPSHOT', messages: toSnapshotMessages(aguiMessages) })
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
        value: { content: '对话过长，已精简早期上下文', droppedMessages, maxTokenLimit: 1000 }
      })
    }

    const result = streamText({
      model: deepseek(images.length ? 'deepseek-flash' : 'deepseek-reasoner'),
      instructions: attachmentPrompt || undefined,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: abortController.signal,
      onStepFinish: (step) => {
        console.log('\n📌 ReAct 单步完成：')
        console.log('当前步数：', step.stepNumber)
        console.log('工具调用：', step.toolCalls)
        console.log('工具返回：', step.toolResults)
      }
    })

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
        send({
          type: 'RUN_ERROR',
          message: part.error instanceof Error ? part.error.message : String(part.error),
          code: 'STREAM_ERROR'
        })
        abortController.abort()
        break
      } else if (part.type === 'abort') {
        console.log('[agui] 模型流已中止：', part.reason)
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
app.post('/api/upload-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' })
    const filePath = req.file.path
    const fileName = fixFileName(req.file.originalname)
    const ext = path.extname(fileName).toLowerCase()
    const rawText = await extractFileText(filePath, ext)
    const chunks = splitTextIntoChunks(rawText, 800, 150)

    // 只返回分块，不入库，入库交给 /api/embedding-add
    res.json({
      ok: true,
      filename: fileName,
      chunkCount: chunks.length,
      chunks
    })
  } catch (err) {
    console.error('文档上传解析失败：', err)
    res.status(500).json({ error: err.message })
  }
})
//接收前端传过来的 `chunks` 和 `filename`，批量生成向量存入 Vectra 向量数据库
app.post('/api/embedding-add', async (req, res) => {
  try {
    const { chunks, filename } = req.body
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'chunks不能为空数组' })
    }
    if (!filename) {
      return res.status(400).json({ error: '缺少filename文档名' })
    }
    // 同名文档重新上传时先删掉旧片段，避免向量库里出现重复内容
    const removed = await deleteDocument(filename)
    await batchInsertEmbedding(chunks, filename)
    res.json({
      ok: true,
      msg: `成功入库${chunks.length}个文本块${removed ? `，已覆盖旧片段${removed}个` : ''}`,
      filename,
      chunkCount: chunks.length
    })
  } catch (err) {
    console.error('Embedding入库失败：', err)
    res.status(500).json({ error: err.message })
  }
})
// 接收前端传过来的 `query`，返回搜索结果
app.post('/api/search-knowledge', async (req, res) => {
  try {
    const { query, topK = 3 } = req.body
    if (!query) return res.status(400).json({ error: '缺少query查询文本' })
    const result = await searchVector(query, topK)
    res.json({ ok: true, data: result })
  } catch (err) {
    console.error('知识库检索异常', err)
    res.status(500).json({ error: err.message })
  }
})
// 获取全部向量条目
app.get('/api/vector-list', async (req, res) => {
  const list = await getAllItems()
  res.json({ ok: true, data: list })
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

// 清空向量库
app.post('/api/vector-clear', async (req, res) => {
  await clearVectorIndex()
  res.json({ ok: true, msg: "向量库已清空" })
})


app.listen(PORT, () => { // 启动 HTTP 服务并监听端口
  console.log(`✅ 服务启动 http://localhost:${PORT}`) // 启动成功后打印访问地址
})
