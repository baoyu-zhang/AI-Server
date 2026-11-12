/**
 * chat-core.js —— 聊天主链路（/agui 的实现主体）
 *
 * 职责：把前端消息变成一次模型调用
 *   裁剪上下文 → 注入附件清单 → 挂载图片 → 选模型 → streamText(带工具、步数上限)
 * 协议（AG-UI 事件编码、SSE 帧）全部留在 index.js 的 /agui 适配层，这里不出现任何协议相关代码。
 * 这样拆的收益：以后换协议（或加第二个入口）时，这段逻辑不用动。
 *
 * ===== 模块契约（读这个文件只需要记住四条）=====
 * 1. 输入：AI SDK 格式的 messages + 可选 sessionId + 工具集合
 * 2. 输出：{ result, meta }，result 是"还没开始消费"的流式结果对象
 * 3. 不修改入参：裁剪用 structuredClone，挂图片用浅拷贝新建对象
 * 4. 不关心谁在调用：不认识 SSE、不认识 AG-UI 事件，只认识 messages
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') }) // 单独 require 本模块时（如写单测）也能读到 .env
const { streamText, stepCountIs } = require('ai') // 流式生成 + 工具步数上限
const { createDeepSeek } = require('@ai-sdk/deepseek') // DeepSeek 模型提供方
const { getEncoding } = require('js-tiktoken') // BPE 分词器，用于近似统计 token
const { getSessionFiles, getSessionImages } = require('./session-files') // 会话级临时附件
const { listMemories } = require('./memory-store') // 跨会话长期记忆（按用户维度）

// ===== 1. 可调参数：全部支持环境变量覆盖，避免硬编码 =====
// 单独抽出来的意义：改模型 / 改预算不用碰逻辑代码，出问题也能用环境变量快速回滚。
const MODEL_REASONING = process.env.MODEL_REASONING || 'deepseek-reasoner' // 纯文本默认模型
const MODEL_VISION = process.env.MODEL_VISION || 'deepseek-flash' // 带图片时切换的视觉模型
const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS) || 5 // 单轮最多连续工具调用步数
// 默认 1000 是历史遗留的保守值（≈700 个汉字，只够 2~3 轮对话）。
// 配合 trimMessages 里"至少保留 10 条"的兜底，实际效果会变成"每次请求只带最后 10 条"，
// 长对话会莫名失忆——这不是模型的问题。
// 本项目 .env 已覆盖为 6000；部署到新环境时记得同步设置，按模型上下文窗口的 30%~50% 取，通常 6000~20000。
const MAX_CONTEXT_TOKENS = Number(process.env.MAX_CONTEXT_TOKENS) || 1000 // 上下文 token 上限

// ===== 2. token 统计：DeepSeek 未提供官方 npm 分词库，这里用 cl100k_base 编码做近似统计 =====
// 放在模块顶层只执行一次：getEncoding() 要加载几 MB 词表，
// 若写在 getTextToken 内部，每次统计都会重新加载，一段 20 条消息的对话就能把 CPU 打满。
const tokenizer = getEncoding('cl100k_base')

/**
 * 估算单段文本的 token 数量
 * 注意：cl100k_base 是 GPT 的词表，不是 DeepSeek 的，中文约 1 字 ≈ 1~1.5 token。
 * 裁剪只需要"相对准"，不需要绝对准——知道自己在用近似值，比追求精确更重要。
 * @param {string} text - 输入的文本
 * @returns {number} - 计算得到的 token 数量
 */
function getTextToken(text) {
  if (!text) return 0
  return tokenizer.encode(String(text)).length
}

/**
 * 取出单条消息用于统计 token 的文本。
 *
 * 为什么必须有这个函数：AI SDK 消息的 content 可能是字符串，也可能是 parts 数组
 * （text / tool-call / tool-result / file）。如果直接 String(content)，
 * 数组会变成 "[object Object],[object Object]" —— 长度统计完全错，而且不报错，静默出错。
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
      return '' // 图片等非文本 part 不计入：图片按像素计费，是刻意留出的盲区
    })
    .join('')
}

/**
 * 统计 messages 数组中所有文本的 token 数量
 * @param {Array} messages - 消息数组
 * @returns {number} - 计算得到的 token 数量
 */
function countMessagesToken(messages) {
  let totalToken = 0
  for (const msg of messages) {
    const roleToken = getTextToken(msg.role)
    const contentToken = getTextToken(modelMessageText(msg))
    totalToken += roleToken + contentToken
    // 真实计费还包含 role、消息分隔符等结构开销，只按正文算会低估 10%~20%
    totalToken += 8
  }
  return totalToken
}

/**
 * 消息 token 裁剪：超限时从最早的消息开始丢弃。
 *
 * 为什么从最早的删、不从中间删：对话是因果链，删中间会留下"它指的是什么"的悬空指代；
 * 删最早的损失只是"忘了开头"，链是完整的。
 *
 * @param {Array} messages - 原始消息（不会被修改）
 * @param {number} maxTokenLimit - 目标 token 上限
 * @returns {{trimmedMessages: Array, isTrimmed: boolean, droppedCount: number}}
 */
function trimMessages(messages, maxTokenLimit = MAX_CONTEXT_TOKENS) {
  // structuredClone 是"不修改入参"的承诺：/agui 里 aguiMessages 后面还要用来下发
  // MESSAGES_SNAPSHOT，被裁剪的话前端拿到的历史就是残缺的。
  const msgList = structuredClone(messages)
  let isTrimmed = false // 是否发生过裁剪
  // 两个条件缺一不可：
  //   只有 token 条件 → 最后 10 条本身超长时会一直 shift 到空数组，模型收到 messages: [] 直接 400；
  //   length > 10 是"宁可超上下文，也不能把对话删空"的兜底。
  while (countMessagesToken(msgList) > maxTokenLimit && msgList.length > 10) {
    msgList.shift()
    isTrimmed = true
    // shift 可能刚好删掉"带 tool-call 的 assistant"，只留下孤立的 tool 结果；
    // 模型接口会拒绝悬空结果（400 tool message without preceding tool_calls），
    // 所以把开头的 tool 消息一并清掉。这行是踩过坑才写得出来的。
    while (msgList.length && msgList[0]?.role === 'tool') msgList.shift()
  }
  return {
    trimmedMessages: msgList,
    isTrimmed,
    // 口径是"长度差"而不是 shift 次数：内层循环一次可能删掉多条
    droppedCount: messages.length - msgList.length
  }
}

/**
 * 生成附件清单系统提示。
 * 聊天请求里只有文本，模型本身看不到附件；把本次会话的附件清单和内容预览作为 instructions 注入，
 * 模型才知道用户上传了什么，也才会在"这是什么"这类短问题下去检索附件。
 *
 * 为什么走 instructions（system）而不是塞进 messages：
 *   ① system 优先级更高，模型更愿意遵守；
 *   ② 不污染对话历史，前端看不到这坨提示；
 *   ③ 每轮重新生成，附件增删自动同步。
 * 为什么"处理规则"也写在 system 里，而不只写在工具 description 里：
 *   工具描述只在模型考虑调工具时被重点阅读；system 是每轮常驻的约束。
 *   前者影响"怎么调"，后者影响"要不要调"。
 */
function buildAttachmentSystemPrompt(sessionId) {
  if (!sessionId) return ''
  const files = getSessionFiles(sessionId)
  // 返回 '' 而不是 null：调用处是 `instructions || undefined`，
  // 空字符串和 undefined 在 AI SDK 里不等价，空 system 消息可能被当成有效内容发出。
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

/**
 * 生成长期记忆系统提示。
 * 与附件清单同理走 instructions：不污染对话历史、每轮自动同步、优先级高。
 * 为什么注入而不是给模型一个"查询记忆"工具：
 *   记忆数量有上限（默认 50 条、每条 ≤200 字），全量注入也就几百 token，
 *   一次到位比"模型要先决定查一次再等结果"更可靠——查询式记忆容易漏查。
 *
 * ===== 记忆的新旧与冲突 =====
 * 每条记忆带"记录于日期"注入：偏好会漂移（三年前喜欢花生 → 现在喜欢坚果），
 * 没有时间的记忆列表里两条矛盾的偏好无法分谁新谁旧，模型只能瞎猜。
 * 冲突处理规则写在 system 而不是工具 description：工具描述只在模型考虑调工具时
 * 被重点阅读，"发现矛盾要更新记忆"是每轮都该生效的常驻约束。
 * @param {string} userId 用户 id；没传（老调用方）返回空串，行为与从前一致
 */
function buildMemorySystemPrompt(userId) {
  if (!userId) return ''
  const memories = listMemories(userId)
  if (!memories.length) return ''
  const list = memories
    .map((m, i) => {
      // createdAt 是毫秒时间戳，转成模型可读的日期；日期帮助模型判断哪条更新
      const date = new Date(m.createdAt).toLocaleDateString('zh-CN')
      return `${i + 1}.（记录于 ${date}）${m.content}`
    })
    .join('\n')
  return `以下是系统长期记住的、关于这位用户的稳定事实（跨会话有效，按时间从早到晚排列）：\n${list}\n\n使用规则：
1. 回答时自然运用这些事实（比如用用户的称呼），但不要生硬复述"系统记忆里写着"。
2. 这些事实与对话中的新信息冲突时，以对话中的新信息为准。
3. 如果对话中出现了与记忆矛盾的新偏好或新事实（例如记忆里"喜欢吃花生"、用户现在说"喜欢吃坚果"），必须更新记忆：先调用 forget 删除旧的那条，再调用 remember 保存新的——只 remember 不 forget 会让两条矛盾记忆长期共存。`
}

/**
 * 把文本 / 结构化 content 统一成 parts 数组。
 *
 * 存在的意义：content 有两种合法形态（字符串、parts 数组），直接 String() 会毁掉数组形态。
 * 这里只保留文本语义，原样透传已有的结构化 part，空内容一律丢掉（避免发出空 text part）。
 * @param {string|Array|undefined|null} content
 * @returns {Array} parts 数组
 */
function toContentParts(content) {
  const parts = []
  if (typeof content === 'string') {
    if (content) parts.push({ type: 'text', text: content })
    return parts
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        if (part) parts.push({ type: 'text', text: part })
      } else if (part) {
        parts.push(part) // 已经是结构化 part，原样保留
      }
    }
    return parts
  }
  // 既不是字符串也不是数组（数字等异常输入）：转成文本，保证内容不丢
  if (content != null) parts.push({ type: 'text', text: String(content) })
  return parts
}

/**
 * 把本次会话的图片附件挂到最后一条 user 消息上。
 *
 * 为什么必须挂"最后一条 user"：DeepSeek 只接受 user 消息携带图片，挂到 assistant 上会被拒。
 * 为什么是"最后一条"而不是每条：图片是本次提问的上下文，重复挂会浪费 token，
 * 还会改变历史语义（模型会以为你每轮都在问同一张图）。
 * 为什么用 type:'file' 而不是 'image'：AI SDK v7 已废弃 image part，统一用 file part 承载。
 */
function attachImagesToLastUserMessage(messages, images) {
  if (!images.length) return messages
  const list = messages.map(message => ({ ...message })) // 浅拷贝：只替换元素，不改原数组和原对象
  const lastUserIndex = list.map(message => message.role).lastIndexOf('user')
  if (lastUserIndex < 0) return list

  // ⚠️ 这里曾经是 String(content)：一旦 content 是数组，会变成 "[object Object]"，
  // 带图片时用户说的话会整段消失（且不报错）。现在统一走 toContentParts 归一化。
  const contentParts = toContentParts(list[lastUserIndex].content)
  const imageParts = images.map(image => ({
    type: 'file',
    mediaType: image.mimeType,
    data: { type: 'data', data: image.base64 } // session-files 里已把 Buffer 转成 base64
  }))

  // 保留原消息的其它字段（如 id），只替换 content，避免下游依赖 id 的地方拿不到值
  list[lastUserIndex] = {
    ...list[lastUserIndex],
    role: 'user',
    content: [...contentParts, ...imageParts]
  }
  return list
}

// ===== 3. 模型客户端：懒加载，只创建一次 =====
let deepseekClient = null

/**
 * 懒加载 DeepSeek 客户端，缺少 key 时给出明确错误而不是启动即崩。
 * 如果在模块加载时就 createDeepSeek()，.env 缺 key 会让整个服务起不来，
 * 而且报错信息毫无指向性；懒加载把错误推迟到第一次请求，并能说清缺的是什么。
 */
function getDeepSeekClient() {
  if (!deepseekClient) {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('.env 缺少 DEEPSEEK_API_KEY')
    deepseekClient = createDeepSeek({ apiKey })
  }
  return deepseekClient
}

/**
 * 默认的单步日志：打印每一步的工具调用与返回，便于观察 ReAct 循环。
 * 用闭包存住 tag，避免每个调用点重复写日志格式。
 */
function defaultStepLogger(tag) {
  return (step) => {
    console.log(`\n📌 [${tag}] ReAct 单步完成：`)
    console.log('当前步数：', step.stepNumber)
    console.log('工具调用：', step.toolCalls)
    console.log('工具返回：', step.toolResults)
  }
}

// ===== 4. 主入口：把消息变成一次模型调用 =====
/**
 * 准备并启动一次模型流式生成（两个端点共用）
 *
 * 执行顺序不是随便排的：trim → instructions → images → attach → 选模型 → streamText
 *   · trim 必须在 attach 之前：裁剪会让消息整体位移、甚至删掉某条 user 消息，
 *     先挂图片后裁剪可能把"唯一带图片的那条消息"删掉，模型就看不见图了；
 *   · 选模型必须在 attach 之后：因为要依赖 images.length 判断走视觉模型还是推理模型。
 *
 * 注意：这里同步返回 result，不 await —— streamText 返回的对象是 thenable，
 * 一旦 await 就会等到"全量生成完"，流式彻底失效（表现是前端卡很久然后一次性刷出全文）。
 * 这是整个项目最容易被改坏的一行。
 *
 * @param {object} params
 * @param {Array} params.messages 已经是 AI SDK 格式的消息（不含 system 角色——AI SDK 禁止）
 * @param {string} [params.systemPrompt] 调用方自带的系统提示（如 OpenAI 兼容端点收到的 system 消息），
 *        与附件清单 instructions 拼接后走 streamText 的 instructions 选项
 * @param {string} [params.sessionId] 会话 id，用于取本次会话的附件
 * @param {string} [params.userId] 用户 id，用于注入跨会话长期记忆（OpenAI 端点与 /agui 都要传）
 * @param {object} params.tools 工具集合（含 execute）
 * @param {AbortSignal} [params.abortSignal] 客户端断开时中止模型流
 * @param {Function} [params.onFinish] 生成结束回调（协议层写自己的结束事件）
 * @param {Function} [params.onStepFinish] 覆盖默认的单步日志
 * @param {string} [params.logTag] 日志前缀，区分是哪个端点
 * @returns {{result: object, meta: {modelId: string, isTrimmed: boolean, droppedCount: number, imageCount: number, inputCount: number, tokenCount: number}}}
 */
function prepareChatStream({
  messages,
  systemPrompt,
  sessionId,
  userId,
  tools,
  abortSignal,
  onFinish,
  onStepFinish,
  logTag = 'chat'
}) {
  const { trimmedMessages, isTrimmed, droppedCount } = trimMessages(messages) // 控制上下文长度
  // 系统提示三路来源拼成一份：调用方自带（OpenAI 兼容端点转发的 system 消息）
  // + 附件清单（本次会话）+ 长期记忆（跨会话，按用户）。
  // filter(Boolean) 去掉空段再 join，避免出现连续空行；都为空时 instructions 为 ''，
  // 调用处 `|| undefined` 会把它转成不传。
  const instructions = [
    systemPrompt,
    buildMemorySystemPrompt(userId), // 记忆放附件清单前面：身份类信息比"上传了什么"更靠前
    buildAttachmentSystemPrompt(sessionId)
  ].filter(Boolean).join('\n\n')
  const images = getSessionImages(sessionId) // 图片附件（多模态）
  const modelMessages = attachImagesToLastUserMessage(trimmedMessages, images) // 图片挂到最后一条 user 消息
  const modelId = images.length ? MODEL_VISION : MODEL_REASONING // 有图走视觉模型

  const result = streamText({
    model: getDeepSeekClient()(modelId),
    instructions: instructions || undefined,
    messages: modelMessages,
    tools,
    // 这是"多步自主循环"的开关。不写它，AI SDK 默认跑一步就停：
    // 模型调完一次工具就结束，不会基于工具结果继续推理。
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    // 条件展开而不是直接传 undefined：某些 provider 把显式 undefined 当成"传了空值"而报错
    ...(abortSignal ? { abortSignal } : {}),
    onStepFinish: onStepFinish || defaultStepLogger(logTag),
    ...(onFinish ? { onFinish } : {})
  })

  return {
    result,
    // meta 让协议层能打印/下发"裁了几条、用的哪个模型、图片几张"，不用自己再算一遍。
    // 注意 tokenCount 算的是 modelMessages（已含图片 part，但图片不计 token），
    // 与裁剪时算的入参口径不完全一致，看日志时别把两个数直接对比。
    meta: {
      modelId,
      isTrimmed,
      droppedCount,
      imageCount: images.length,
      inputCount: messages.length,
      tokenCount: countMessagesToken(modelMessages)
    }
  }
}

module.exports = {
  prepareChatStream,
  trimMessages,
  countMessagesToken,
  getTextToken,
  toContentParts, // 导出供单测：数组/字符串两种形态都要覆盖
  attachImagesToLastUserMessage, // 导出供单测
  buildAttachmentSystemPrompt,
  buildMemorySystemPrompt,
  MODEL_REASONING,
  MODEL_VISION,
  MAX_AGENT_STEPS,
  MAX_CONTEXT_TOKENS
}
