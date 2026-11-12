// 结构化日志必须第一个加载：它要接管 stdout/stderr 把输出落盘，
// 晚于 dotenv/其他模块加载的话，启动期那几行（injected env、模型加载）就漏了
const { log, httpLog } = require('./logger')
require('dotenv').config() // 加载 .env 中的环境变量（DEEPSEEK_API_KEY）
const express = require('express') // 引入 Express 框架
const { tool, jsonSchema } = require('ai') // 引入 AI SDK 的工具定义与 JSON Schema 适配（流式主链路已抽到 chat-core.js）
const { z } = require('zod') // 引入 zod，用于声明工具入参结构
const multer = require('multer')
const { randomUUID } = require('node:crypto') // 生成 AG-UI 的 threadId / runId / messageId
const { EventEncoder } = require('@ag-ui/encoder') // AG-UI 官方 SSE 事件编码器
const fs = require('fs') // 用于清理解析后的临时文件
const path = require('path') // 用于解析上传文件的后缀名
const { UPLOAD_DIR, ALLOWED_EXTS, LEGACY_EXTS, IMAGE_EXTS, extractFileText, splitTextIntoChunks } = require('./rag-utils')
const { initVectorStore, batchInsertEmbedding, searchVector, getDocuments, getCandidates, getJobs, deleteDocument } = require('./rag-vector')
const { addSessionFile, addSessionImage, deleteSessionFile, getSessionFiles, searchSessionFiles } = require('./session-files')
const { prepareChatStream, MAX_CONTEXT_TOKENS } = require('./chat-core') // 聊天主链路（裁剪/附件/选模型/streamText）
const { scoreResumeAgainstJD } = require('./score-resume') // 招聘场景的领域能力：简历 × JD 匹配度评估
const { authRouter, requireAuth } = require('./auth') // 注册/登录 + 全局鉴权闸门
const { recordAudit, listAudit } = require('./audit') // 操作审计：谁批准了什么写操作
const { startAutoBackup } = require('./backup') // SQLite 定时备份（VACUUM INTO）
const { saveRun, listThreads, getThreadMessages } = require('./threads-store') // 会话落库
const {
  CANDIDATE_STATUS, // 状态白名单，工具入参的 enum 与写库校验共用一份
  listCandidates: listCandidateRecords,
  upsertCandidate,
  updateCandidateStatus,
  recordScore
} = require('./candidates-store')
const app = express() // 创建 Express 应用实例
const PORT = process.env.PORT || 3000 // 服务端口：优先取环境变量，默认 3000
app.use(express.json()) // 注册 JSON 请求体解析中间件
app.use(httpLog) // 访问日志挂在最外层：401/403 也要留痕

// 挂载顺序是鉴权的骨架，错一行就漏一个口子：
//   ① /api/auth 必须先挂（登录接口本身不能要求已登录）；
//   ② requireAuth 紧随其后，成为其后所有端点的总闸门——
//      以后新加路由只要写在这行之后，就自动受保护，"忘了加鉴权"这类事故在结构上不可能发生。
app.use('/api/auth', authRouter)
// 健康检查必须在 requireAuth 之前：容器编排（HEALTHCHECK/探针）不带 token，
// 它只关心"进程活着没"，不关心你是谁
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) })
})
app.use(requireAuth)

// ========== 会话附件归属 ==========
// sessionId 由前端生成，属于不可信输入：不绑定归属的话，B 用户拿 A 的 sessionId
// 就能把附件传进 A 的会话、读到 A 的附件清单。claim 一次后绑定不变。
const sessionOwners = new Map() // sessionId -> userId

/** 声明会话归属。返回 false 表示该会话属于别人，调用方必须拒绝请求 */
function claimSession(sessionId, userId) {
  const owner = sessionOwners.get(sessionId)
  if (owner === undefined) {
    sessionOwners.set(sessionId, userId)
    return true
  }
  return owner === userId
}
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
// userId 同理：检索、候选人清单、评分都必须圈定在"当前登录用户"的可见范围内。
function createTools(sessionId, userId) {
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
        // 第三个参数不传业务 filter（全库检索），第四个参数 userId 是数据隔离——
        // 登录用户只能看到自己的文档和鉴权前的公开旧语料
        const [kbResult, sessionResult] = await Promise.all([
          searchVector(query, topK, undefined, userId),
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
    }),

    // ---- 招聘场景①：候选人 / 岗位清单（"模型拿不到 id" 的解药）----
    // 为什么必须先有这个工具再注册评分工具：
    // 模型看不到向量库里的 metadata，它只知道用户口中的"张三"。如果没有查询入口，
    // 它只能猜一个 candidateId 去调评分——猜错了返回"材料缺失"，用户看到的就是"它不会用"。
    listCandidates: tool({
      description: `列出知识库里已经有简历的候选人，含 candidateId、应聘岗位、当前状态和最近一次评分。
            用户问"有哪些候选人""这个岗位有几个人""谁还没面试"时必须调用；
            需要给某人评分但不知道 candidateId 时，也要先调用它拿 id，不要猜。`,
      inputSchema: z.object({
        // 状态白名单来自 candidates-store，和写库校验共用一份，避免两处枚举漂移
        status: z.enum(CANDIDATE_STATUS).optional().describe('只看某个状态的候选人，不传则返回全部')
      }),
      async execute({ status }) {
        // 两路数据合并：向量库决定"谁有简历"，JSON 表决定"状态和分数"
        // 两路都按 userId 圈定：只列"自己的 + 鉴权前的无主旧数据"
        const [resumes, records] = await Promise.all([
          getCandidates(userId),
          listCandidateRecords({ userId })
        ])
        const byId = new Map(records.map(item => [item.candidateId, item]))
        let list = resumes.map(resume => {
          const record = byId.get(resume.key)
          return {
            candidateId: resume.key,
            // 展示名优先用登记名，没登记过就退回文件名（去掉后缀）
            name: record?.name || String(resume.fileName || resume.key).replace(/\.[^.]+$/, ''),
            jobId: record?.jobId || resume.jobId || '',
            // "待登记"不是合法业务状态，只是提示"这条记录还没走过上传接口"
            status: record?.status || '待登记',
            lastScore: record?.lastScore ?? null,
            lastVerdict: record?.lastVerdict || '',
            fileName: resume.fileName,
            chunkCount: resume.chunkCount
          }
        })
        if (status) list = list.filter(item => item.status === status)
        if (!list.length) {
          return { text: status ? `没有状态为「${status}」的候选人` : '知识库里还没有候选人简历，请先上传简历并标记 candidateId' }
        }
        const lines = list.map((item, i) => {
          const scorePart = item.lastScore == null ? '未评分' : `最近评分 ${item.lastScore}（${item.lastVerdict}）`
          return `${i + 1}. candidateId=${item.candidateId}｜${item.name}｜岗位=${item.jobId || '未指定'}｜状态=${item.status}｜${scorePart}｜简历：${item.fileName}（${item.chunkCount} 段）`
        })
        return { text: `候选人共 ${list.length} 人：\n${lines.join('\n')}` }
      }
    }),

    listJobs: tool({
      description: '列出知识库里的岗位 JD 及其 jobId。需要按岗位评估候选人但不知道 jobId 时先调用它',
      inputSchema: z.object({}),
      async execute() {
        const jobs = await getJobs(userId)
        if (!jobs.length) return { text: '知识库里还没有岗位 JD，请先上传 JD 并标记 jobId' }
        const lines = jobs.map((job, i) => `${i + 1}. jobId=${job.key}｜${job.fileName}（${job.chunkCount} 段）`)
        return { text: `岗位 JD 共 ${jobs.length} 个：\n${lines.join('\n')}` }
      }
    }),

    // ---- 招聘场景②：匹配度评估，本项目的业务身份所在 ----
    // 注意这里只负责"接线"：检索、判定、加总、证据核查全在 score-resume.js。
    // 拆开的好处是那个文件能脱离 HTTP 与 AG-UI 单独跑评测。
    scoreResumeAgainstJD: tool({
      description: `评估某位候选人对某个岗位的匹配度，返回四个维度的分项得分、硬性门槛结论和简历原文依据。
            用户问"某人和这个岗位匹配吗""能不能约面试""简历符合要求吗"时必须调用。
            入参必须用真实 id：不知道就先调 listCandidates 取 candidateId、listJobs 取 jobId，绝对不要编造。`,
      inputSchema: z.object({
        candidateId: z.string().describe('候选人标识，必须是 listCandidates 返回的 candidateId'),
        jobId: z.string().describe('岗位标识，必须是 listJobs 返回的 jobId')
      }),
      async execute({ candidateId, jobId }) {
        const result = await scoreResumeAgainstJD({ candidateId, jobId, userId })
        // 材料缺失是正常分支而不是异常：告诉模型缺什么，它才能引导用户补材料
        if (!result.ok) return { text: result.text, sources: [] }
        // 结论写回候选人表——刷新页面后列表里还能看到"这个人上次评了多少分"
        await recordScore(candidateId, { score: result.score, verdict: result.verdict, jobId }, userId)
        return {
          text: result.text,
          sources: result.sources,
          // 下面两个字段不进模型上下文（模型只读 text），留给前端做卡片和表格
          score: result.score,
          verdict: result.verdict
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

/**
 * 需要人工确认的工具名单。
 * 从单个字符串改成 Set，是因为审批工具从 1 个变成 2 个之后，三处判断（挂载工具、拦 tool-call、resume 白名单）
 * 都靠这个名字；继续用字符串就得写成 `a || b`，漏掉一处就变成"某个工具绕过了审批直接执行"。
 * 用 Set 之后，加新工具只需要往这里加一行。
 */
const APPROVAL_TOOL_NAMES = new Set(['deleteSessionFile', 'updateCandidateStatus'])

function createApprovalTools() {
  return {
    deleteSessionFile: tool({
      // 描述里"只有在用户明确要求删除附件时才调用"是第二道闸：
      // 第一道是 interrupt（执行前必暂停），这一道降低误触发概率——删除不可恢复，值得写死。
      description: '删除本次会话中已上传的某个附件。删除不可恢复，调用后会暂停并等待用户确认；只有在用户明确要求删除附件时才调用',
      inputSchema: z.object({
        // 强调"必须是清单里的完整文件名"：模型容易把文件名截断或改写成"简历.pdf"，
        // 到 resume 阶段按名字精确匹配时会找不到文件。
        fileName: z.string().describe('要删除的附件文件名，必须是附件清单里出现的完整文件名')
      })
    }),

    updateCandidateStatus: tool({
      // 改状态有副作用且要通知别人（约面、淘汰），所以和一键删除一样走审批。
      // 描述里写清"只在用户明确要求改状态时调用"，避免模型在评分之后自作主张把状态推成"待面试"。
      description: `修改候选人的招聘状态。可选状态：${CANDIDATE_STATUS.join(' / ')}。
            调用后会暂停并等待用户确认；只有在用户明确要求变更某人状态时才调用，评分本身不要顺手改状态。`,
      inputSchema: z.object({
        candidateId: z.string().describe('候选人标识，必须是 listCandidates 返回的 candidateId'),
        status: z.enum(CANDIDATE_STATUS).describe('目标状态，只能从给定枚举里选'),
        reason: z.string().optional().describe('变更原因，一句话说明，会展示在确认框里')
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
 * 中断时展示给用户确认的文案。
 * 按工具分支而不是统一写"是否允许执行该操作"：用户要能一眼看出自己将改变什么，
 * 否则确认框就是一个无脑点"同意"的按钮，审批也就失去了意义。
 */
function approvalMessage({ toolName, input }) {
  if (toolName === 'deleteSessionFile') {
    return `即将删除附件「${input?.fileName || ''}」，删除后不可恢复，是否允许？`
  }
  if (toolName === 'updateCandidateStatus') {
    const reason = input?.reason ? `\n原因：${input.reason}` : ''
    return `即将把候选人「${input?.candidateId || ''}」的状态改为「${input?.status || ''}」。${reason}\n是否允许？`
  }
  return `即将执行 ${toolName}，是否允许？`
}

/**
 * 执行用户已确认的审批工具。
 * 三道校验都不是多余的：resume 的 interruptId 来自客户端，属于不可信输入。
 */
async function executeApprovalTool(toolName, input, sessionId, userId, ctx = {}) {
  if (!APPROVAL_TOOL_NAMES.has(toolName)) return `操作失败：未知的审批工具 ${toolName}` // 白名单：防止伪造中断去调别的工具

  // 审计要在"执行之后"记：只有真正跑完才知道结果（成功还是"本次会话没有这个附件"）。
  // 目标对象按工具取不同字段，失败也必须留痕——失败的删除尝试同样是安全事件。
  const audit = (target, ok, output) => recordAudit({
    userId,
    ip: ctx.ip,
    action: `tool.${toolName}`,
    target,
    detail: { ok, output: String(output).slice(0, 300) }
  })

  if (toolName === 'deleteSessionFile') {
    const fileName = String(input?.fileName || '').trim()
    if (!fileName) {
      audit('', false, '缺少文件名')
      return '删除失败：缺少文件名'
    }
    // 只在本会话附件里找：防止构造一个别的会话的文件名来越权删除
    const file = getSessionFiles(sessionId).find(item => item.fileName === fileName)
    if (!file) {
      const msg = `删除失败：本次会话中没有名为「${fileName}」的附件`
      audit(fileName, false, msg)
      return msg
    }
    const ok = deleteSessionFile(sessionId, file.fileId)
    const msg = ok ? `已删除附件：${fileName}` : `删除失败：${fileName}`
    audit(fileName, ok, msg)
    return msg
  }

  // updateCandidateStatus：真正的写库动作在 candidates-store.js，这里只负责把结果翻译成一句人话
  // userId 必须透传：审批链路也不能改到别人名下的候选人
  const candidateId = String(input?.candidateId || '').trim()
  const result = await updateCandidateStatus(candidateId, input?.status, userId)
  if (!result.ok) {
    const msg = `状态修改失败：${result.error}`
    audit(candidateId, false, msg)
    return msg
  }
  if (result.unchanged) {
    const msg = `候选人「${candidateId}」的状态已经是「${result.record.status}」，未做修改`
    audit(candidateId, true, msg)
    return msg
  }
  const msg = `已将候选人「${candidateId}」的状态从「${result.from}」改为「${result.record.status}」`
  audit(candidateId, true, msg)
  return msg
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
  // requireAuth 已在中间件层保证 req.user 存在，这里非空断言是给读代码的人看的
  const userId = req.user.userId
  // 会话附件必须归属当前用户：B 用户不能借 A 的 sessionId 读 A 的附件
  if (!claimSession(sessionId, userId)) {
    return res.status(403).json({ error: '会话归属其他用户，拒绝访问' })
  }
  const priorState = input.state && typeof input.state === 'object' ? input.state : {}
  const priorSources = Array.isArray(priorState.sources) ? priorState.sources : []
  // 服务端自己跟踪共享状态的最终值：与下发出去的事件严格同步（快照替换、增量应用），
  // run 结束后随消息快照一起落库。恢复历史会话时原样还给客户端，
  // 引用来源等跨轮信息不再因为换设备/清缓存而丢（此前客户端丢了就只能从空 state 重来）
  let finalState = { ...priorState, phase: 'running', sources: [...priorSources] }
  // 应用 STATE_DELTA 用到的 JSON-Patch 子集：add /sources/-（追加来源）与 replace /<key>（改 phase）
  // 只实现本服务实际下发的两种 op，协议里其余 op 一出现就忽略——宁可少存也不存错
  const applyStateOps = (state, ops) => {
    for (const op of ops || []) {
      if (!op || typeof op.path !== 'string') continue
      if (op.op === 'add' && op.path === '/sources/-' && op.value !== undefined) {
        state.sources = [...(Array.isArray(state.sources) ? state.sources : []), op.value]
      } else if (op.op === 'replace' && op.path.startsWith('/') && op.path.length > 1) {
        state[op.path.slice(1)] = op.value
      }
    }
    return state
  }

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
  // 会话落库：正文与工具结果是服务端产出的，客户端历史里没有，必须自己收集。
  // 按"真实发生顺序"记成本轮消息数组，而不是事后再拼：
  // 一轮里可能有多段正文（工具调用前后的两段），合并成一条会出现
  // "1 + 90 = 91，1 + 90 = 91" 这种重复正文，工具结果也会跑到所有正文后面
  const runMessages = []
  let currentTextMsg = null // 正在续写的 assistant 文本消息（落库对象）

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
    // 每段正文独立成一条 assistant 消息：同一轮里工具调用前后各说一段时，
    // 合并成一条会让恢复出来的历史变成重复文本
    currentTextMsg = { id: currentAssistantId, role: 'assistant', content: '' }
    runMessages.push(currentTextMsg)
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
      // executeApprovalTool 现在是 async（改状态要写 JSON 文件），必须 await，
      // 否则下面写回历史的 content 会是一个 Promise，序列化出来是 {}
      let output
      if (approved) {
        output = await executeApprovalTool(call.name, call.input, sessionId, userId, { ip: req.ip })
      } else {
        // 拒绝也要留痕：审计要能回答"用户看过并拒绝了哪次删除"
        recordAudit({
          userId,
          ip: req.ip,
          action: `tool.${call.name}.rejected`,
          target: String(call.input?.fileName || call.input?.candidateId || ''),
          detail: { approved: false }
        })
        output = '用户拒绝了该操作，未执行'
      }
      // 结果写回历史：快照、模型上下文、前端卡片都靠这条消息对齐
      const messageId = `msg_tool_${++toolMessageSeq}`
      aguiMessages.push({ id: messageId, role: 'tool', content: output, toolCallId })
      resumeOutputs.push({ messageId, toolCallId, content: output })
      console.log('[agui] resume 处理中断 %s，approved=%s', interruptId, approved)
    }

    const serverTools = createTools(sessionId, userId)
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
    // 起跑快照：同一个对象既下发也留给 finalState，两边从第一帧起就一致
    const runningSnapshot = { ...priorState, phase: 'running', sources: [...priorSources] }
    finalState = runningSnapshot
    send({ type: 'STATE_SNAPSHOT', snapshot: runningSnapshot })
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
        if (currentTextMsg) currentTextMsg.content += part.text // 落库：追加到本段正文
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
        // 落库：toolCalls 必须挂在对应 assistant 消息上，恢复历史时前端靠它配对工具结果
        // 优先挂到刚结束的那段正文；模型直接调工具（没说话）时补一条空正文消息
        const carrier = currentTextMsg
          ?? [...runMessages].reverse().find(m => m.role === 'assistant')
        const toolCall = {
          id: part.toolCallId,
          type: 'function',
          function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) }
        }
        if (carrier) {
          ;(carrier.toolCalls ||= []).push(toolCall)
        } else {
          currentTextMsg = { id: parentMessageId, role: 'assistant', content: '', toolCalls: [toolCall] }
          runMessages.push(currentTextMsg)
        }
        // 审批类工具没有 execute，本轮不会产生 tool-result，先记下来留到收尾转成 interrupt
        // 连 toolName 一起记：收尾时既要用它生成确认文案，也要写进 metadata 供前端区分卡片类型
        if (APPROVAL_TOOL_NAMES.has(part.toolName)) {
          pendingApprovals.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
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
        const resultText = toolOutputText(part.output)
        // 落库与 SSE 事件共用同一个 messageId：恢复出来的历史和当场看到的一致
        const toolMessageId = `msg_tool_${++toolMessageSeq}`
        // 落库：工具结果按发生位置插进本轮消息流（前端恢复时按 toolCallId 配对）
        runMessages.push({
          id: toolMessageId,
          role: 'tool',
          content: resultText,
          toolCallId: part.toolCallId
        })
        send({
          type: 'TOOL_CALL_RESULT',
          messageId: toolMessageId,
          toolCallId: part.toolCallId,
          role: 'tool',
          content: resultText
        })
        // 检索工具的 sources 走共享状态，前端可直接渲染引用来源
        const sources = Array.isArray(part.output?.sources) ? part.output.sources : []
        if (sources.length) {
          const ops = sources.map(source => ({ op: 'add', path: '/sources/-', value: source }))
          applyStateOps(finalState, ops) // 与下发同步：跟踪的 state 也要长出这些来源
          send({ type: 'STATE_DELTA', delta: ops })
        }
        // 工具结果之后，模型下一段文本属于新的 assistant 消息
        currentAssistantId = null
        assistantTextStarted = false
        currentTextMsg = null // 下一段正文/下一个工具调用另起一条，别续到工具前那条上
      } else if (part.type === 'tool-error') {
        const errorMessage = part.error instanceof Error ? part.error.message : String(part.error)
        const toolMessageId = `msg_tool_${++toolMessageSeq}`
        // 失败结果同样落库：否则恢复历史后工具步骤卡片只有入参没有结果
        runMessages.push({
          id: toolMessageId,
          role: 'tool',
          content: `工具执行失败：${errorMessage}`,
          toolCallId: part.toolCallId
        })
        send({
          type: 'TOOL_CALL_RESULT',
          messageId: toolMessageId,
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
        currentTextMsg = null
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
        const interruptOps = [{ op: 'replace', path: '/phase', value: 'interrupted' }]
        applyStateOps(finalState, interruptOps)
        send({ type: 'STATE_DELTA', delta: interruptOps })
        send({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          outcome: {
            type: 'interrupt',
            interrupts: pendingApprovals.map(item => ({
              id: `${INTERRUPT_PREFIX}${item.toolCallId}`,
              reason: 'approval',
              message: approvalMessage(item),
              toolCallId: item.toolCallId,
              responseSchema: {
                type: 'object',
                properties: { approved: { type: 'boolean', description: '是否允许执行该操作' } },
                required: ['approved']
              },
              metadata: { toolName: item.toolName, input: item.input }
            }))
          }
        })
      } else {
        const doneOps = [{ op: 'replace', path: '/phase', value: 'done' }]
        applyStateOps(finalState, doneOps)
        send({ type: 'STATE_DELTA', delta: doneOps })
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
    // 会话落库放 finally：正常结束、interrupt、出错、客户端断开都要留痕——
    // 尤其审批中断时，快照里必须已经包含那条带 toolCalls 的 assistant 消息，resume 才有依据可循
    try {
      // 输入历史 + 本轮新增消息。runMessages 已按发生顺序保存了每段正文、
      // 带 toolCalls 的 assistant 和工具结果，这里只做拼接，不再二次加工
      const snapshot = [...(aguiMessages || []), ...runMessages]
      // state 一并落库：恢复会话时接口把它还给前端，跨轮信息不丢
      saveRun({ threadId, runId, userId, messages: snapshot, state: finalState })
    } catch (err) {
      log.error('[threads] 会话落库失败', { threadId, runId, err: err.message })
    }
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
      // .doc 单独提示「另存为」：用户以为「Word 不能传」，实际只是老格式不认
      const hint = LEGACY_EXTS.includes(ext) ? '；.doc 是 2003 之前的老格式，请用 Word 另存为 .docx 后重试' : ''
      return cb(new Error(`不支持的文件类型：${ext || '未知'}，仅支持 ${ALLOWED_EXTS.join(' / ')}${hint}`))
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

/**
 * 安静地删掉落盘文件。
 *
 * 两个细节都是踩出来的：
 *   ① 必须同步：异步 unlink 会把「文件还在」的窗口留给紧接着的逻辑；
 *   ② 必须吞掉异常：清理本来就是失败路径上的补偿动作，删不掉只该记日志，
 *      不能因为"删不掉"把原本准确的 400（文件格式不对）变成 500（服务端故障）。
 */
function removeFileQuietly(filePath) {
  if (!filePath) return
  try {
    fs.rmSync(filePath, { force: true })
  } catch (err) {
    console.warn(`清理上传文件失败（不影响本次响应）：${filePath}`, err.message)
  }
}

/**
 * 决定本次入库最终使用的文件名。
 * 同名文档有两种完全不同的含义，必须分开处理：
 *   ① 同一个业务对象重新上传（docType / jobId / candidateId 完全一致）→ 沿用原名，覆盖旧片段，幂等；
 *   ② 不同业务对象的同名文件（两个候选人都叫「简历.md」）→ 加序号另存。
 *      不加序号的话，后面那句 deleteDocument(fileName) 会把前一个人的简历删掉——
 *      这是"上传即覆盖"最危险的副作用，而且在单候选人测试时永远发现不了。
 * 判断依据只能是业务标签，不能靠文件名：文件名是给人看的，业务标签才是身份。
 * @param {string} fileName 原始文件名
 * @param {{docType?: string, jobId?: string, candidateId?: string}} biz
 * @returns {Promise<string>}
 */
async function resolveDocName(fileName, biz) {
  // 只在"自己可见"的文档里找同名：别的用户的同名文件对当前用户必须像不存在一样，
  // 否则 B 传「简历.md」会被 A 的同名文件顶成 -2，自己看着莫名其妙的文件名
  const docs = await getDocuments(biz.userId)
  const sameName = docs.filter(doc => doc.fileName === fileName)
  // 同一业务对象 = 业务标签 + 归属都一致；无主旧文档（userId undefined）与带主的新上传不算同主
  const sameOwner = sameName.some(doc =>
    doc.docType === biz.docType && doc.jobId === biz.jobId && doc.candidateId === biz.candidateId
      && doc.userId === biz.userId
  )
  if (!sameName.length || sameOwner) return fileName

  const ext = path.extname(fileName)
  const base = fileName.slice(0, fileName.length - ext.length)
  let seq = 2
  // 必须循环到没被占用为止：只加一次 -2 的话，第三次上传又撞上 -2，覆盖问题原样复现
  while (docs.some(doc => doc.fileName === `${base}-${seq}${ext}`)) seq++
  return `${base}-${seq}${ext}`
}

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
      removeFileQuietly(filePath) // multer 已把文件落盘，校验失败必须清掉，否则 uploads 会攒垃圾文件
      return res.status(400).json({ error: '简历必须带 candidateId（候选人标识）' })
    }
    if (docType === 'jd' && !jobId) {
      removeFileQuietly(filePath)
      return res.status(400).json({ error: '岗位 JD 必须带 jobId（岗位标识）' })
    }

    const uploadName = fixFileName(req.file.originalname)
    const ext = path.extname(uploadName).toLowerCase()
    const rawText = await extractFileText(filePath, ext)
    const chunks = splitTextIntoChunks(rawText, 800, 150)
    if (!chunks.length) {
      // 解析不出文本也算失败：multer 已经把文件落盘了，不清掉就是孤儿文件
      removeFileQuietly(filePath)
      return res.status(400).json({ error: '未能从文件中解析出文本' })
    }

    const biz = { docType, jobId, candidateId, userId: req.user.userId }
    // 同名不同候选人时改名，避免 deleteDocument 把别人的简历删掉
    const fileName = await resolveDocName(uploadName, biz)
    const renamed = fileName !== uploadName

    // 同名文档重新上传时先删掉旧片段，避免向量库里出现重复内容
    // 第二个参数圈定"只删自己可见的"：另一个用户碰巧有同名文件时，这里删不动他的
    const removed = await deleteDocument(fileName, req.user.userId)
    // 第三个参数就是业务标签 + 归属；userId 进 metadata 后检索/列表/删除都会按它过滤
    await batchInsertEmbedding(chunks, fileName, biz)

    // 简历入库即登记候选人：后面的 listCandidates / updateCandidateStatus 都以这张表为准
    if (docType === 'resume') {
      await upsertCandidate({ candidateId, fileName, jobId, userId: req.user.userId })
    }

    res.json({
      ok: true,
      filename: fileName,
      // 改名要回给前端：用户看到"我传的是 简历.md，怎么变成 简历-2.md 了"得有个解释
      renamed,
      chunkCount: chunks.length,
      removed,
      docType,
      jobId,
      candidateId,
      msg: `成功入库${chunks.length}个文本块${removed ? `，已覆盖旧片段${removed}个` : ''}${renamed ? `，同名文件已另存为「${fileName}」` : ''}`
    })
    // 入库是写操作，审计要能回答"这份简历是谁什么时候传的"（覆盖上传也算一次）
    recordAudit({
      userId: req.user.userId,
      actor: req.user.username,
      ip: req.ip,
      action: 'doc.upload',
      target: fileName,
      detail: { docType, jobId, candidateId, chunks: chunks.length, removed, renamed }
    })
  } catch (err) {
    console.error('文档上传解析失败：', err)
    // 解析阶段抛错（加密文档 / 损坏 docx / 扫描版 PDF）也要清掉已落盘的文件，
    // 否则用户每重试一次，uploads 里就多一份谁都认不出来的孤儿文件。
    removeFileQuietly(filePath)
    // 这类失败都是「文件本身不合适」，属于客户端问题：400 而不是 500
    res.status(400).json({ error: err.message })
  }
})

// 文档列表：按文件名聚合，前端左侧文档栏使用。只列当前用户可见的
app.get('/api/documents', async (req, res) => {
  try {
    const data = await getDocuments(req.user.userId)
    res.json({ ok: true, data })
  } catch (err) {
    console.error('获取文档列表失败', err)
    res.status(500).json({ error: err.message })
  }
})
// 删除文档：按文件名删掉向量库中对应的全部片段。只删得动自己可见的，
// 删到 0 说明文件不存在或不属于你——不能把"别人有这个文件"泄露成删除成功
app.post('/api/documents/delete', async (req, res) => {
  try {
    const { fileName } = req.body
    if (!fileName) return res.status(400).json({ error: '缺少fileName' })
    const removed = await deleteDocument(fileName, req.user.userId)
    // 删除失败（别人的文件 / 不存在）同样记一条：越权尝试是最该留痕的动作
    recordAudit({
      userId: req.user.userId,
      actor: req.user.username,
      ip: req.ip,
      action: 'doc.delete',
      target: String(fileName),
      detail: { ok: removed > 0, removedChunks: removed }
    })
    if (!removed) return res.status(404).json({ error: '文档不存在或无权删除' })
    res.json({ ok: true, fileName, removed })
  } catch (err) {
    console.error('删除文档失败', err)
    res.status(500).json({ error: err.message })
  }
})
// 审计查询：只返回自己的记录（管理员全局视图要等有了角色体系再做）
app.get('/api/audit', (req, res) => {
  try {
    const data = listAudit(req.user.userId, req.user.username, req.query.limit)
    res.json({ ok: true, data })
  } catch (err) {
    console.error('读取审计失败', err)
    res.status(500).json({ error: err.message })
  }
})
// 候选人列表：前端候选人表格的数据源
// 与 listCandidates 工具读的是同一份数据，但两个出口的用途不同——
//   工具 → 拼成一段文案给模型读；这里 → 结构化字段给表格渲染和筛选
app.get('/api/candidates', async (req, res) => {
  try {
    // 两路都圈定在当前用户的可见范围：自己的 + 鉴权前的无主旧数据
    const [resumes, records] = await Promise.all([
      getCandidates(req.user.userId),
      listCandidateRecords({ userId: req.user.userId })
    ])
    const byId = new Map(records.map(item => [item.candidateId, item]))
    let data = resumes.map(resume => {
      const record = byId.get(resume.key)
      return {
        candidateId: resume.key,
        name: record?.name || String(resume.fileName || resume.key).replace(/\.[^.]+$/, ''),
        jobId: record?.jobId || resume.jobId || '',
        status: record?.status || '待登记',
        lastScore: record?.lastScore ?? null,
        lastVerdict: record?.lastVerdict || '',
        fileName: resume.fileName,
        chunkCount: resume.chunkCount,
        updatedAt: record?.updatedAt || resume.createdAt
      }
    })
    // 筛选放服务端：前端拿到全量再 filter 也能做，但将来接分页时接口形状就得改
    const { jobId, status } = req.query
    if (jobId) data = data.filter(item => item.jobId === jobId)
    if (status) data = data.filter(item => item.status === status)
    res.json({ ok: true, data, statuses: CANDIDATE_STATUS })
  } catch (err) {
    console.error('获取候选人列表失败', err)
    res.status(500).json({ error: err.message })
  }
})
// 岗位列表：JD 的 jobId 只有服务端知道，前端做下拉框要它
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await getJobs(req.user.userId)
    res.json({ ok: true, data: jobs.map(job => ({ jobId: job.key, fileName: job.fileName, chunkCount: job.chunkCount })) })
  } catch (err) {
    console.error('获取岗位列表失败', err)
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
    // 会话归属绑定：第一次上传的人拥有这个会话，其他人（包括改了前端代码的）传不进去
    if (!claimSession(sessionId, req.user.userId)) {
      return res.status(403).json({ error: '会话归属其他用户，拒绝访问' })
    }

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
    if (!claimSession(sessionId, req.user.userId)) {
      return res.status(403).json({ error: '会话归属其他用户，拒绝访问' })
    }
    const removed = deleteSessionFile(sessionId, fileId)
    res.json({ ok: true, removed })
  } catch (err) {
    console.error('删除会话附件失败', err)
    res.status(500).json({ error: err.message })
  }
})

// ========== 会话历史（落库的读出口） ==========
// 写入在 /agui 的 finally 里自动完成，这两个端点只读：
//   列表 → 会话恢复页/历史侧栏；消息快照 → 选中某个会话后还原整段对话。
// 历史的运行时口径不变：对话仍以客户端带来的 messages 为准，这里只是兜底副本。
app.get('/api/threads', (req, res) => {
  res.json({ ok: true, data: listThreads(req.user.userId) })
})
app.get('/api/threads/:threadId/messages', (req, res) => {
  const result = getThreadMessages(req.params.threadId, req.user.userId)
  // 404 同时覆盖"不存在"和"存在但不属于你"：不区分才能不泄露会话 id 的存在性
  if (!result) return res.status(404).json({ error: '会话不存在或无权访问' })
  res.json({ ok: true, ...result })
})

// 清空知识库不走 HTTP：原 /api/vector-clear 没有鉴权，部署到公网后一次 POST 就能清库。
// 需要重建时用 npm run eval:ingest（会先删同名文档再入库），彻底清空直接删 vector-index/ 目录。

// 统一错误出口：multer 的 fileFilter / limits 错误是在中间件层 next(err) 抛的，
// 不经过路由里的 try/catch。没有这个中间件时，传一个 .doc 会拿到 Express 默认的
// HTML 500 页，前端只能显示「Internal Server Error」——用户根本不知道是格式问题。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err) // 流式响应已经开始，不能再改状态码
  if (err instanceof multer.MulterError) {
    // 体积超限单独给 413，前端能据此提示「压缩或拆分后再传」
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    const message = err.code === 'LIMIT_FILE_SIZE' ? `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` : err.message
    return res.status(status).json({ error: message })
  }
  // 文件类型不合法同样属于「用户的请求有问题」，返回 400 而不是 500
  const status = /不支持的文件类型/.test(err.message || '') ? 400 : 500
  if (status === 500) console.error('未捕获的服务端错误：', err)
  res.status(status).json({ error: err.message || '服务端错误' })
})

app.listen(PORT, () => { // 启动 HTTP 服务并监听端口
  log.info(`服务启动 http://localhost:${PORT}`, { port: PORT, node: process.version })
  // 备份在 listen 之后再起：先让服务能接请求，再去做可能耗时的 IO
  startAutoBackup()
})
