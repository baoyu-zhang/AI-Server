#!/usr/bin/env node
/**
 * MCP Client + 图片持久化 验收
 *
 * 分五段：
 *   A. MCP 客户端直连：用本地 demo server（stdio，纯离线）验证连接、工具发现、
 *      工具名加前缀、真调一次工具、审计回调、审批策略（auto/true/false/通配名单）、
 *      配置损坏时不影响主流程
 *   B. /api/mcp：登录后可查连接状态与工具清单（含 approval 标记），未登录 401
 *   C. 图片持久化：上传后拿到签名 URL，**不带 Authorization** 也能取到图片（<img src> 发不了头），
 *      篡改签名 403，元数据落库；这是"刷新后图片不见了"的回归防线
 *   D. 图片回填：历史消息里的 fileId 能让视觉模型重新拿到图（服务重启/刷新后追问场景）
 *   E. 审批链路：需审批的 MCP 工具调用触发 interrupt → 批准 → resume 真正执行 → 审计留痕
 *
 * A-D 不调模型，跑一遍十几秒；E 会真调一次模型（interrupt 由模型发出 tool-call 才产生，
 * 手工拼历史测的是假链路，因此这里必须真跑）。
 *
 * ===== 运行前提：服务必须用「验收配置」启动 =====
 * 第二阶段把交付用的 server/mcp.json 清成了空数组（客户不该看到 demo 工具）。
 * 本脚本的 A 段会自己写一份临时 MCP_CONFIG_FILE，不受影响；但 B 段查 /api/mcp、
 * E 段触发 mcp__demo__add 审批链路，都依赖【服务进程】里挂着 demo server。
 * 因此跑验收前请从 server/ 目录这样启动（相对路径靠 cwd 解析）：
 *
 *   cd server
 *   MCP_CONFIG_FILE=eval/fixtures/mcp-demo.json npm start
 *   node eval/verify-mcp.mjs
 *
 * 千万别把 demo 配置写回 mcp.json——那会让它重新混进交付镜像。
 * 服务需已启动；BASE_URL 由 http-auth.mjs 决定，默认 http://127.0.0.1:3000。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { login, authHeaders, BASE_URL } from './http-auth.mjs'

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const dim = text => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text)
const bold = text => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text)

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`, detail !== undefined ? dim(JSON.stringify(detail).slice(0, 300)) : '')
  }
}
const section = name => console.log(`\n${bold(name)}`)

// 1x1 透明 PNG：最小可用图片，验证链路不需要真图
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

// ========== A. MCP 客户端直连 ==========
async function testMcpClient() {
  section('A. MCP 客户端（进程内直连 demo server）')
  // 指向本地 demo server，避免依赖网络与外网包
  const configFile = path.join(os.tmpdir(), `mcp-verify-${process.pid}.json`)
  fs.writeFileSync(
    configFile,
    JSON.stringify([
      { name: 'demo', transport: 'stdio', command: process.execPath, args: [path.join(SERVER_DIR, 'mcp-demo-server.js')] }
    ])
  )
  process.env.MCP_CONFIG_FILE = configFile
  process.env.MCP_ENABLED = '1'

  const { initMcp, getMcpTools, listMcpServers, isMcpApprovalTool, callMcpTool } = require(path.join(SERVER_DIR, 'mcp-client.js'))
  await initMcp()
  const servers = listMcpServers()
  check('连上 1 个 MCP server', servers.length === 1, servers)
  const demo = servers[0] || {}
  check('server 名与连接状态正确', demo.name === 'demo' && demo.connected === true, demo)
  check('发现 3 个工具（echo/add/server_time）', demo.toolCount === 3, demo.tools)

  const tools = getMcpTools({})
  const names = Object.keys(tools)
  check('工具名带 mcp__<server>__ 前缀', names.includes('mcp__demo__echo') && names.includes('mcp__demo__add'), names)
  check('工具数量与发现结果一致', names.length === 3, names)

  // ===== 审批策略（默认 auto）：只读工具直接执行，其余必须人工确认 =====
  check('echo 判定为只读（免审批）', isMcpApprovalTool('mcp__demo__echo') === false, demo.tools)
  check('server_time 判定为只读（免审批）', isMcpApprovalTool('mcp__demo__server_time') === false, demo.tools)
  check('add 判定为需审批', isMcpApprovalTool('mcp__demo__add') === true, demo.tools)
  // 关键安全断言：需审批的工具必须**没有 execute**，否则模型可以绕过确认直接执行
  check('需审批工具不暴露 execute（模型无法直接执行）', typeof tools.mcp__demo__add.execute === 'undefined', Object.keys(tools.mcp__demo__add))
  check('API 状态接口回传 approval 标记', demo.tools.find(t => t.name === 'add')?.approval === true, demo.tools)

  const echoed = await tools.mcp__demo__echo.execute({ text: '你好 MCP' })
  check('echo 工具真实调用成功', /echo: 你好 MCP/.test(String(echoed)), echoed)

  // 批准后走的这条路径（index.js 的 executeApprovalTool 就是调它）
  const sum = await callMcpTool('mcp__demo__add', { a: 3, b: 4 }, {})
  check('add 经审批通道执行，结果正确', /3 \+ 4 = 7/.test(String(sum)), sum)

  // skipApproval：OpenAI 兼容端点用，需审批的工具完全不挂（那边没有 interrupt 协议）
  const compatTools = getMcpTools({ skipApproval: true })
  check('skipApproval 时不挂需审批工具', !('mcp__demo__add' in compatTools) && 'mcp__demo__echo' in compatTools, Object.keys(compatTools))

  // 审计回调：每次外部工具调用都要能留痕，出问题才查得到
  const audits = []
  const audited = getMcpTools({ recordAudit: entry => audits.push(entry) })
  await audited.mcp__demo__echo.execute({ text: 'audit' })
  check('调用写入审计（action=mcp.call）', audits.length === 1 && audits[0].action === 'mcp.call' && audits[0].detail.ok === true, audits)

  // allowTools 白名单：只放行部分工具（"这个 server 我只想让它读"）
  const limitedFile = path.join(os.tmpdir(), `mcp-verify-limited-${process.pid}.json`)
  fs.writeFileSync(
    limitedFile,
    JSON.stringify([
      {
        name: 'demo',
        command: process.execPath,
        args: [path.join(SERVER_DIR, 'mcp-demo-server.js')],
        allowTools: ['echo']
      }
    ])
  )
  // 配置在 init 时读取一次，这里用独立进程验证白名单，避免缓存干扰
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `process.env.MCP_CONFIG_FILE=${JSON.stringify(limitedFile)};` +
        `const m=require(${JSON.stringify(path.join(SERVER_DIR, 'mcp-client.js'))});` +
        `m.initMcp().then(()=>{console.log(JSON.stringify(m.listMcpServers()[0].tools.map(t=>t.name)));process.exit(0)})`
    ],
    { encoding: 'utf8', cwd: SERVER_DIR }
  )
  check('allowTools 白名单只放行指定工具', out.trim().split('\n').pop() === '["echo"]', out.trim())

  // requireApproval 的三种显式写法：全开 / 全关 / 名单（含末尾通配）
  const runWithApproval = (policy) => {
    const file = path.join(os.tmpdir(), `mcp-verify-appr-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify([{
      name: 'demo',
      command: process.execPath,
      args: [path.join(SERVER_DIR, 'mcp-demo-server.js')],
      requireApproval: policy
    }]))
    const stdout = execFileSync(
      process.execPath,
      ['-e',
        `process.env.MCP_CONFIG_FILE=${JSON.stringify(file)};` +
        `const m=require(${JSON.stringify(path.join(SERVER_DIR, 'mcp-client.js'))});` +
        `m.initMcp().then(()=>{console.log(JSON.stringify(m.listMcpServers()[0].tools.filter(t=>t.approval).map(t=>t.name)));process.exit(0)})`],
      { encoding: 'utf8', cwd: SERVER_DIR }
    )
    fs.unlinkSync(file)
    return stdout.trim().split('\n').pop()
  }
  const allGated = runWithApproval(true)
  const noneGated = runWithApproval(false)
  const wildcardGated = runWithApproval(['ec*'])
  check('requireApproval:true 时全部工具需审批', allGated === '["echo","add","server_time"]', allGated)
  check('requireApproval:false 时全部免审批', noneGated === '[]', noneGated)
  check('requireApproval 名单支持通配', wildcardGated === '["echo"]', wildcardGated)

  // 配置写坏必须静默降级：MCP 是增强项，不能因为配置错误让服务起不来
  const brokenFile = path.join(os.tmpdir(), `mcp-verify-broken-${process.pid}.json`)
  fs.writeFileSync(brokenFile, '{ this is not json')
  const brokenOut = execFileSync(
    process.execPath,
    [
      '-e',
      `process.env.MCP_CONFIG_FILE=${JSON.stringify(brokenFile)};` +
        `const m=require(${JSON.stringify(path.join(SERVER_DIR, 'mcp-client.js'))});` +
        `m.initMcp().then(()=>{console.log('servers='+m.listMcpServers().length);process.exit(0)})`
    ],
    { encoding: 'utf8', cwd: SERVER_DIR }
  )
  check('配置损坏时降级为空且不抛错', /servers=0/.test(brokenOut), brokenOut.trim())

  fs.unlinkSync(configFile)
  fs.unlinkSync(limitedFile)
  fs.unlinkSync(brokenFile)
}

// ========== B. /api/mcp 状态接口 ==========
async function testMcpEndpoint() {
  section('B. GET /api/mcp（连接状态）')
  const anon = await fetch(`${BASE_URL}/api/mcp`)
  check('未登录 401', anon.status === 401, anon.status)

  const { token } = await login()
  // 服务启动时可能因机器负载握手超时（客户端会在后台重试），这里给 20 秒窗口等它连上，
  // 避免把"启动慢"误判成"功能坏了"
  let body = {}
  let list = []
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE_URL}/api/mcp`, { headers: authHeaders() })
    body = await res.json().catch(() => ({}))
    list = body.data || []
    if (list.some(item => item.name === 'demo' && item.connected)) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  check('登录后返回 server 列表', Array.isArray(list) && list.length >= 1, list)
  const demo = list.find(item => item.name === 'demo')
  check('demo server 已连接', Boolean(demo?.connected), demo)
  check('demo 暴露 3 个工具', demo?.toolCount === 3, demo?.tools)
  check('不泄漏 command/args/headers', !('command' in (demo || {})) && !('headers' in (demo || {})), demo)
  return token
}

// ========== C. 图片持久化（签名 URL） ==========
async function testImagePersistence() {
  section('C. 聊天图片持久化（刷新不再丢图）')
  const { token } = await login()
  const sessionId = `img-verify-${Date.now()}`
  const form = new FormData()
  form.append('sessionId', sessionId)
  form.append('file', new Blob([Buffer.from(PNG_BASE64, 'base64')], { type: 'image/png' }), 'shot.png')

  const upload = await fetch(`${BASE_URL}/api/session-files/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: form
  })
  const payload = await upload.json().catch(() => ({}))
  check('上传图片成功', upload.status === 200 && payload.ok === true, payload)
  const file = payload.file || {}
  check('返回 fileId 与签名 URL', Boolean(file.id) && /^\/api\/chat-images\/.+\?sig=[0-9a-f]{32}$/.test(file.url || ''), file)

  // 关键点：<img src> 带不了 Authorization，所以这里刻意不带任何头
  const fetchImage = await fetch(`${BASE_URL}${file.url}`)
  const bytes = Buffer.from(await fetchImage.arrayBuffer())
  check('签名 URL 无鉴权头可取图（刷新后气泡能显示）', fetchImage.status === 200, fetchImage.status)
  check('Content-Type 是图片', (fetchImage.headers.get('content-type') || '').includes('image/png'), fetchImage.headers.get('content-type'))
  check('取回的字节与上传一致', bytes.length === Buffer.from(PNG_BASE64, 'base64').length, bytes.length)
  check('带缓存头（刷新不重复下载）', /max-age=\d+/.test(fetchImage.headers.get('cache-control') || ''), fetchImage.headers.get('cache-control'))

  const tampered = await fetch(`${BASE_URL}${file.url.slice(0, -32)}${'0'.repeat(32)}`)
  check('签名被篡改 → 403', tampered.status === 403, tampered.status)

  const missing = await fetch(`${BASE_URL}/api/chat-images/not-exist?sig=${'a'.repeat(32)}`)
  check('不存在的图片 → 403/404（不泄漏是否存在）', missing.status === 403 || missing.status === 404, missing.status)

  // 元数据落库：重启后 session 内存清空，但图片还在
  const DB_FILE = process.env.APP_DB_FILE || path.join(SERVER_DIR, 'data', 'app.db')
  const db = new DatabaseSync(DB_FILE, { readOnly: true })
  try {
    const row = db.prepare('SELECT * FROM chat_images WHERE file_id = ?').get(file.id)
    check('图片元数据已落库', Boolean(row) && row.mime === 'image/png', row && { mime: row.mime, size: row.size })
    check('磁盘文件存在', Boolean(row && fs.existsSync(row.path)), row?.path)
  } finally {
    db.close()
  }

  // ===== D. 回填：服务重启后，历史消息里的 fileId 能重新喂给视觉模型 =====
  section('D. 图片回填（重启/刷新后追问同一张图）')
  const { hydrateSessionImages, getSessionImages } = require(path.join(SERVER_DIR, 'session-files.js'))
  const freshSession = `img-hydrate-${Date.now()}`
  const restored = hydrateSessionImages(freshSession, [file.id])
  check('按 fileId 回填进内存会话', restored === 1, restored)
  const images = getSessionImages(freshSession)
  check('回填后视觉模型能拿到 base64', images.length === 1 && images[0].base64.length > 0, images.map(i => i.fileName))
  check('回填后地址仍是同一签名 URL', images[0]?.url === file.url, images[0]?.url)
}

// ========== E. 审批链路（需真调一次模型） ==========
// 为什么这段必须走真模型：interrupt 是"模型主动发出 tool-call 之后服务端才拦截"的，
// 没有 tool-call 就没有可测的东西。手工拼一条 assistant 消息虽然能绕过，但那样测的
// 是自己造的历史，不是真实链路。
async function postAgui(token, body) {
  const res = await fetch(`${BASE_URL}/agui`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try { events.push(JSON.parse(line.slice(5))) } catch { /* 心跳/空行忽略 */ }
  }
  return { status: res.status, events }
}

async function testApprovalFlow() {
  section('E. 审批链路（interrupt → 批准 → resume 执行）')
  const { token } = await login()
  const threadId = `mcp-approval-${Date.now()}`
  const messages = [{ id: 'u1', role: 'user', content: '请调用 add 工具计算 3 加 4（参数 a=3、b=4），然后把结果告诉我' }]
  const first = await postAgui(token, { threadId, runId: `r-${Date.now()}`, messages, tools: [] })

  const finish = first.events.find(e => e.type === 'RUN_FINISHED')
  const interrupts = finish?.outcome?.interrupts || []
  check('需审批的 MCP 调用以 interrupt 结束', finish?.outcome?.type === 'interrupt' && interrupts.length === 1, finish?.outcome)
  const intr = interrupts[0] || {}
  check('interrupt 指向 mcp__demo__add', intr.metadata?.toolName === 'mcp__demo__add', intr.metadata)
  check('确认文案含"外部工具"+完整参数', /即将调用外部工具/.test(intr.message || '') && /"a":\s*3/.test(intr.message || ''), intr.message)
  // 没批准就不该有工具结果：这是"确认前绝不执行"的硬证据
  check('确认前没有任何工具结果事件', !first.events.some(e => e.type === 'TOOL_CALL_RESULT'), first.events.map(e => e.type))

  // 客户端持历史：把服务端快照取回来，再带 resume 发起新一轮（与前端 resumeRun 同构）
  const hist = await fetch(`${BASE_URL}/api/threads/${threadId}/messages`, { headers: authHeaders() }).then(r => r.json())
  const snapshot = hist.messages || []
  check('快照里含待审批的 tool-call', snapshot.some(m => (m.toolCalls || []).some(c => c.function?.name === 'mcp__demo__add')), snapshot.map(m => m.role))

  const second = await postAgui(token, {
    threadId,
    runId: `r2-${Date.now()}`,
    messages: snapshot,
    tools: [],
    resume: [{ interruptId: intr.id, status: 'resolved', payload: { approved: true } }]
  })
  const resultEvent = second.events.find(e => e.type === 'TOOL_CALL_RESULT')
  check('批准后工具被真正执行（有 tool-result）', Boolean(resultEvent), second.events.map(e => e.type))
  check('工具结果里是真实返回值 7', /3 \+ 4 = 7/.test(String(resultEvent?.content ?? resultEvent?.delta ?? '')), resultEvent)
  const secondFinish = second.events.find(e => e.type === 'RUN_FINISHED')
  check('resume 后正常结束（不再挂起）', secondFinish?.outcome?.type !== 'interrupt', secondFinish?.outcome)

  // 审计：审批执行的调用要能和自动执行的区分开（detail.approved=true）
  const DB_FILE = process.env.APP_DB_FILE || path.join(SERVER_DIR, 'data', 'app.db')
  const db = new DatabaseSync(DB_FILE, { readOnly: true })
  try {
    const row = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'tool.mcp__demo__add' ORDER BY id DESC LIMIT 1"
    ).get()
    check('审批执行写入审计 tool.mcp__demo__add', Boolean(row), row)
    const call = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'mcp.call' AND target = 'demo/add' ORDER BY id DESC LIMIT 1"
    ).get()
    check('mcp.call 审计标记 approved=true', Boolean(call) && /"approved":true/.test(call.detail || ''), call?.detail)
  } finally {
    db.close()
  }
}

// ========== 执行 ==========
console.log(bold('MCP Client + 图片持久化 验收'))
try {
  await testMcpClient()
  await testMcpEndpoint()
  await testImagePersistence()
  await testApprovalFlow()
} catch (err) {
  failed++
  console.error('\x1b[31m执行异常：\x1b[0m', err)
}
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}\n通过 ${passed} / 失败 ${failed}\x1b[0m`)
process.exit(failed ? 1 : 0)
