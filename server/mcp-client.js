/**
 * mcp-client.js —— MCP（Model Context Protocol）客户端
 *
 * ===== 这个文件解决什么问题 =====
 * 在此之前，Agent 能用的工具全是本项目自己写的（检索、记忆、审批删除…）。
 * MCP 的价值在于「工具可以来自别处」：只要对方按协议暴露 tools，我们不需要
 * 为它写一行适配代码，Agent 就多了一组能力——这就是协议的意义。
 *
 * ===== 为什么做 Client 而不是 Server =====
 * 把自己的工具包装成 MCP Server 只是换一种方式暴露自己，学不到新东西；
 * 做 Client 才能体会「工具热插拔」：改一个配置文件，Agent 的工具集就变了。
 *
 * ===== 关键设计 =====
 * ① 连接失败绝不影响主链路：MCP 是增强项，配置写错/服务没起，聊天必须照常可用；
 * ② 工具名统一加前缀 mcp__<server>__<tool>：不同 server 很容易都有 search/read，
 *    不加前缀会互相覆盖，而且排查时看不出工具是谁提供的；
 * ③ 每次调用写审计：外部工具能读文件/发请求，出问题要能查到"谁在什么时候调了什么"；
 * ④ 结果统一拍平成文本：模型的 tool-result 是文本最稳，图片/资源只留描述。
 */
const path = require('node:path')
const fs = require('node:fs')

const MAX_NAME = 64 // 工具名长度上限（多数厂商 API 的硬约束）
const CONNECT_TIMEOUT = Number(process.env.MCP_CONNECT_TIMEOUT_MS) || 15000
const CALL_TIMEOUT = Number(process.env.MCP_CALL_TIMEOUT_MS) || 30000

/** 已连接的 server：name -> { client, transport, tools, error, config } */
const servers = new Map()
/** 工具名 -> { serverName, toolName }（执行时反查，避免每次遍历） */
const toolIndex = new Map()
/** 初始化只跑一次：多个请求同时进来也只连一遍 */
let initPromise = null

/**
 * 读取配置。三种来源按优先级：
 *   1. MCP_SERVERS  环境变量（JSON 数组）—— 部署时用，不依赖文件
 *   2. MCP_CONFIG_FILE 指定的文件
 *   3. server/mcp.json —— 默认位置（不存在就当没配置）
 * 支持三种写法，都是为了"从别的工具抄来的配置能直接用"：
 *   数组 [{name,command,args}] / {servers:[...]} / {name: {...}}
 *
 * ===== 第二阶段「去 demo 痕迹」后的约定（重要）=====
 * 交付镜像里的 server/mcp.json 是空数组 []：客户开箱即用时看不到任何玩具工具，
 * 也不会有一个指向 example.com 的假地址。JSON 不允许写注释，所以说明放在这里。
 *   · 客户怎么接自己的工具　：推荐用 MCP_SERVERS 环境变量（容器 env_file 可直接注入），
 *     或把 deploy/mcp.example.json 改好、用 MCP_CONFIG_FILE 指过去；模板见 deploy/ 目录。
 *   · 本地回归怎么挂 demo　：MCP_CONFIG_FILE=eval/fixtures/mcp-demo.json，
 *     测试专用配置在 server/eval/fixtures/，该目录已被 .dockerignore 排除。
 *   · 为什么用环境变量而不是改文件：镜像层是只读的，客户在容器里改 /app/mcp.json
 *     既不持久也难审计；环境变量随 compose 的 .env 走，升级镜像不丢。
 */
function loadConfig() {
  if (process.env.MCP_ENABLED === '0') return []
  let raw = null
  if (process.env.MCP_SERVERS) {
    raw = process.env.MCP_SERVERS
  } else {
    const file = process.env.MCP_CONFIG_FILE || path.join(__dirname, 'mcp.json')
    if (!fs.existsSync(file)) return []
    raw = fs.readFileSync(file, 'utf8')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error('[mcp] 配置不是合法 JSON，已忽略：', err.message)
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.servers)
      ? parsed.servers
      : Object.entries(parsed || {}).map(([name, cfg]) => ({ name, ...cfg }))
  return list
    .filter(cfg => cfg && cfg.name)
    .filter(cfg => cfg.enabled !== false)
    .map(cfg => ({
      name: String(cfg.name),
      transport: cfg.transport || (cfg.url ? (cfg.type === 'sse' ? 'sse' : 'http') : 'stdio'),
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env || {},
      url: cfg.url,
      headers: cfg.headers || {},
      // 可选：只放行部分工具（名字用 MCP 原始名），用于"这个 server 我只想让它读、不想让它写"
      allowTools: Array.isArray(cfg.allowTools) ? cfg.allowTools : null,
      // 审批策略：auto（默认）/ true / false / 工具名数组
      //   auto —— 只读工具直接执行，其余一律要人点头（安全默认：名字看不出只读就当它有副作用）
      requireApproval: normalizeApproval(cfg.requireApproval)
    }))
}

/** 把配置里的 requireApproval 归一成 true | false | 'auto' | string[] */
function normalizeApproval(raw) {
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  if (Array.isArray(raw)) return raw.map(String)
  return 'auto' // 没配就走自动判定
}

/**
 * 名字看不出只读 → 当成有副作用。
 *
 * 为什么用"只读白名单"而不是"危险词黑名单"：
 * 黑名单永远漏（`rm_rf`、`deploy`、`send_mail` 都可能不在词表里），
 * 而漏掉一个就意味着外部工具能不问人直接删库/发邮件。
 * 白名单漏判的代价只是"多弹一次确认框"，安全得多。
 */
const READ_ONLY_PATTERN = /(^|[_\-.])(get|list|read|search|query|find|fetch|describe|inspect|status|stat|echo|time|count|exists|head|tail|view|lookup|check)([_\-.]|$)/i

/**
 * 判断某个 MCP 工具要不要人工审批。
 * @param {{ requireApproval: true|false|'auto'|string[], name: string, annotations?: object }} meta
 */
function needsApproval(meta) {
  const policy = meta.requireApproval
  if (policy === true) return true
  if (policy === false) return false
  if (Array.isArray(policy)) {
    // 名单支持末尾通配：'write_*' 能覆盖 write_file / write_many 这类同名族
    return policy.some(pattern => {
      const p = String(pattern)
      return p.endsWith('*') ? meta.name.startsWith(p.slice(0, -1)) : p === meta.name
    })
  }
  // auto：先看 server 自报的注解（MCP 规范里有 readOnlyHint / destructiveHint，比名字可靠），
  // 注解没说再退回名字判定
  const ann = meta.annotations || {}
  if (ann.destructiveHint === true) return true
  if (ann.readOnlyHint === true) return false
  return !READ_ONLY_PATTERN.test(meta.name)
}

/** 把名字压成合法工具名：只留字母数字下划线连字符，超长截断 */
function safeName(raw, max = MAX_NAME) {
  const cleaned = String(raw).replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.slice(0, max)
}

/** 为一个工具生成带前缀且不冲突的名字 */
function buildToolName(serverName, toolName) {
  const base = safeName(`mcp__${safeName(serverName, 20)}__${safeName(toolName, 32)}`)
  if (!toolIndex.has(base)) return base
  // 撞名（不同 server 的原始工具名截断后相同）时加序号，保证唯一
  let seq = 2
  while (toolIndex.has(`${base.slice(0, MAX_NAME - 3)}_${seq}`)) seq += 1
  return `${base.slice(0, MAX_NAME - 3)}_${seq}`
}

/** 建一个 client（传输层按配置选），连接失败抛错由上层兜住 */
async function createClient(cfg) {
  // 延迟 require：没配 MCP 的环境完全不会加载 SDK，启动更快也不会因为缺包崩掉
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'ai-server', version: '1.0.0' }, { capabilities: {} })

  let transport
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error('stdio 传输缺少 command')
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...process.env, ...cfg.env }, // 继承环境变量：npx/uvx 需要 PATH
      stderr: 'ignore' // 子进程 stderr 若接管道而不消费会阻塞，直接丢弃
    })
  } else if (cfg.transport === 'sse') {
    const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')
    transport = new SSEClientTransport(new URL(cfg.url), {
      requestInit: Object.keys(cfg.headers).length ? { headers: cfg.headers } : undefined
    })
  } else {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: Object.keys(cfg.headers).length ? { headers: cfg.headers } : undefined
    })
  }

  // 连接超时：远端 server 无响应时必须放弃，否则启动/首个请求会被拖死
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`连接超时（${CONNECT_TIMEOUT}ms）`)), CONNECT_TIMEOUT))
  ])
  return { client, transport }
}

/** 把 MCP 的 content 数组拍平成文本 */
function flattenContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      if (!item) return ''
      if (item.type === 'text') return item.text || ''
      if (item.type === 'image') return `[图片 ${item.mimeType || ''}]`.trim()
      if (item.type === 'audio') return `[音频 ${item.mimeType || ''}]`.trim()
      if (item.type === 'resource') {
        const res = item.resource || {}
        if (typeof res.text === 'string') return res.text
        return `[资源 ${res.uri || ''}]`.trim()
      }
      if (item.type === 'resource_link') return `[资源链接 ${item.uri || ''}]`.trim()
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 连接一个 server 并登记它暴露的工具 */
async function connectServer(cfg, attempt = 1) {
  const state = { config: cfg, client: null, tools: [], error: null, attempt }
  servers.set(cfg.name, state)
  try {
    const { client } = await createClient(cfg)
    state.client = client
    const listed = await client.listTools()
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    const allowed = cfg.allowTools ? new Set(cfg.allowTools) : null
    state.tools = tools.filter(tool => !allowed || allowed.has(tool.name)).map(tool => {
      const exposedName = buildToolName(cfg.name, tool.name)
      const meta = {
        exposedName,
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        // 审批标记在连接时就定下来：中途改配置要重启才生效，与"配置即事实"一致，
        // 也避免每个请求都重算一遍
        approval: needsApproval({ requireApproval: cfg.requireApproval, name: tool.name, annotations: tool.annotations })
      }
      toolIndex.set(exposedName, { serverName: cfg.name, toolName: tool.name, approval: meta.approval })
      return meta
    })
    const gated = state.tools.filter(t => t.approval).map(t => t.name)
    console.log(
      '[mcp] 已连接 %s，发现 %d 个工具：%s%s',
      cfg.name, state.tools.length, state.tools.map(t => t.name).join(', '),
      gated.length ? `（需审批：${gated.join(', ')}）` : ''
    )
  } catch (err) {
    state.error = err?.message || String(err)
    console.error('[mcp] 连接 %s 失败（第 %d 次）：%s', cfg.name, attempt, state.error)
    // 后台重试：外部 server 可能启动慢（npx 首次拉包 / 机器负载高时握手超时）。
    // 不能让一次失败就把这个 server 永久判死——后面几轮对话它应该自动"长回来"。
    // 用 unref 的定时器：进程要退出时不被这些定时器拖住。
    if (attempt < 3) {
      setTimeout(() => {
        // 期间被 closeMcp 清掉了就不再重试
        if (!servers.has(cfg.name)) return
        connectServer(cfg, attempt + 1).catch(() => {})
      }, attempt * 5000).unref?.()
    }
  }
  return state
}

/**
 * 初始化：连接所有配置的 server
 * 幂等且不抛错——调用方（启动流程、请求入口）不需要 try/catch，
 * 配置有问题最多是"没有 MCP 工具"，绝不阻断对话。
 */
function initMcp() {
  if (initPromise) return initPromise
  const configs = loadConfig()
  if (!configs.length) {
    initPromise = Promise.resolve([])
    return initPromise
  }
  initPromise = Promise.allSettled(configs.map(connectServer)).then(results => results)
  return initPromise
}

/**
 * 真正调一次外部工具（含超时、审计、错误翻译）。
 * 抽出来是因为有两条调用路径：免审批工具在 execute 里直接调，
 * 需审批的工具要等用户点头后由 callMcpTool 调——同一份逻辑不能写两遍，
 * 否则两条路径的审计/超时行为迟早走偏。
 */
async function invokeTool(state, meta, args, ctx = {}) {
  const startedAt = Date.now()
  const serverName = state.config.name
  try {
    const result = await Promise.race([
      state.client.callTool({ name: meta.name, arguments: args || {} }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`调用超时（${CALL_TIMEOUT}ms）`)), CALL_TIMEOUT))
    ])
    const text = flattenContent(result?.content)
    const failed = result?.isError === true
    ctx.recordAudit?.({
      action: 'mcp.call',
      target: `${serverName}/${meta.name}`,
      detail: { ok: !failed, ms: Date.now() - startedAt, args, approved: ctx.approved === true }
    })
    // isError 也要作为结果回给模型（它会据此换策略），而不是抛异常打断整轮
    return failed ? `工具执行返回错误：${text || '（无详细信息）'}` : text || '（工具返回空结果）'
  } catch (err) {
    ctx.recordAudit?.({
      action: 'mcp.call',
      target: `${serverName}/${meta.name}`,
      detail: { ok: false, ms: Date.now() - startedAt, args, error: err?.message }
    })
    throw err // 抛出去让 AI SDK 记录 tool-error，模型能看到失败原因
  }
}

/**
 * 取所有 MCP 工具的 AI SDK 定义
 * 每次调用都返回新对象：execute 闭包里带的是本次请求的上下文（审计要 user/thread）。
 *
 * 需审批的工具**故意不给 execute**（和审批工具同一套语义）：
 * 模型发出 tool-call 后本轮就结束，服务端在收尾时识别出"这是要审批的调用"，
 * 转成一个 interrupt 返回给客户端；用户点头后，下一个 resume 请求里由
 * index.js 的 executeApprovalTool 走 callMcpTool 执行。
 *
 * @param {{ userId?: string, threadId?: string, recordAudit?: Function, skipApproval?: boolean }} ctx
 *        skipApproval=true 时完全不挂需审批的工具——OpenAI 兼容端点没有 interrupt 协议，
 *        挂上去只会让模型发出一个永远没人执行的调用，对话直接卡死。
 * @returns {Record<string, object>}
 */
function getMcpTools(ctx = {}) {
  const { tool, jsonSchema } = require('ai')
  const out = {}
  for (const [serverName, state] of servers) {
    if (!state.client || state.error) continue
    for (const meta of state.tools) {
      if (ctx.skipApproval && meta.approval) continue
      out[meta.exposedName] = tool({
        description: `[${serverName}] ${meta.description || meta.name}`.slice(0, 1024),
        // MCP 的 inputSchema 本身就是 JSON Schema，转成 AI SDK 需要的包装即可，
        // 不必（也没法）转成 zod：外部 schema 是运行时才知道的
        inputSchema: jsonSchema(meta.inputSchema?.type ? meta.inputSchema : { type: 'object', properties: {} }),
        ...(meta.approval
          ? {} // 需审批：不给 execute，见本节开头
          : { execute: args => invokeTool(state, meta, args, ctx) })
      })
    }
  }
  return out
}

/** 这个工具名是否来自 MCP 且需要审批（index.js 用它判断要不要走 interrupt） */
function isMcpApprovalTool(exposedName) {
  return toolIndex.get(exposedName)?.approval === true
}

/** 反查工具归属，审批卡片要用（展示"来自哪个 server 的哪个工具"） */
function getMcpToolInfo(exposedName) {
  const entry = toolIndex.get(exposedName)
  if (!entry) return null
  const state = servers.get(entry.serverName)
  const meta = state?.tools.find(t => t.exposedName === exposedName)
  return {
    serverName: entry.serverName,
    toolName: entry.toolName,
    description: meta?.description || '',
    approval: entry.approval === true
  }
}

/**
 * 用户批准后执行一个 MCP 工具。
 * 与免审批路径的区别只有 ctx.approved=true（审计里能区分"自动执行"和"人工批准"）。
 * 找不到工具/连接已断都要给出人话错误，而不是抛异常——这条路径在 resume 里，
 * 抛异常会把整轮对话变成 500。
 */
async function callMcpTool(exposedName, args, ctx = {}) {
  const entry = toolIndex.get(exposedName)
  if (!entry) return `执行失败：未找到 MCP 工具 ${exposedName}（可能配置已变更，请重启服务后重试）`
  const state = servers.get(entry.serverName)
  const meta = state?.tools.find(t => t.exposedName === exposedName)
  if (!state?.client || !meta) return `执行失败：MCP server「${entry.serverName}」当前未连接`
  try {
    return await invokeTool(state, meta, args, { ...ctx, approved: true })
  } catch (err) {
    return `工具执行失败：${err?.message || String(err)}`
  }
}

/** 给前端/运维看的连接状态（不含 command/args/headers，避免泄漏密钥） */
function listMcpServers() {
  return [...servers.values()].map(state => ({
    name: state.config.name,
    transport: state.config.transport,
    connected: Boolean(state.client) && !state.error,
    toolCount: state.tools.length,
    // approval 让前端/运维一眼看出哪些工具会弹确认框
    tools: state.tools.map(t => ({ name: t.name, exposedName: t.exposedName, description: t.description, approval: t.approval })),
    error: state.error
  }))
}

/** 关闭所有连接（进程退出/热重启用），失败不抛 */
async function closeMcp() {
  for (const state of servers.values()) {
    try {
      await state.client?.close()
    } catch {
      /* 关闭失败无所谓，进程都要退出了 */
    }
  }
  servers.clear()
  toolIndex.clear()
}

module.exports = {
  initMcp,
  getMcpTools,
  listMcpServers,
  closeMcp,
  loadConfig,
  // 审批相关：index.js 用它把 MCP 工具接进 interrupt/resume 链路
  isMcpApprovalTool,
  getMcpToolInfo,
  callMcpTool
}
