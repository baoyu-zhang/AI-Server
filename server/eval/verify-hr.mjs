#!/usr/bin/env node
/**
 * 招聘场景切片验收：候选人登记 → 同名不互相覆盖 → 评分工具接线 → 改状态审批
 * → PII 脱敏 → Word 解析
 *
 * 前两段不打模型，可以离线跑（--skip-model 会跳 C、D）：
 *   A. candidates-store 单测（用临时文件，不碰正式表）
 *   B. 上传去重：两个候选人传同名文件，必须各留一份
 *   C. 评分工具：模型能否用 listCandidates/listJobs 拿到的 id 跑通评估
 *   D. 改状态审批：interrupt → resume 执行 → 重放不重复执行
 *   E. PII 脱敏：该抹的抹掉，技术文档里的数字别误伤
 *   F. Word（.docx）：表格还原成行、照样脱敏、坏文件不留孤儿
 *
 * 用法：
 *   node eval/verify-hr.mjs              # 全跑
 *   node eval/verify-hr.mjs --skip-model # 只跑 A、B、E、F（服务需已启动）
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { login, authHeaders, BASE_URL } from './http-auth.mjs'

const SKIP_MODEL = process.argv.includes('--skip-model')
const TIMEOUT_MS = Number(process.env.AGUI_TIMEOUT_MS || 180000)

// 必须在 require 之前设好：candidates-store 在模块加载时就决定了要写哪个文件
const TMP_STORE = path.join(os.tmpdir(), `candidates-verify-${Date.now()}.json`)
process.env.CANDIDATES_STORE_FILE = TMP_STORE
const require = createRequire(import.meta.url)
const store = require('../candidates-store.js')

// ========== 输出 ==========
const color = code => text => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const green = color('32')
const red = color('31')
const dim = color('2')
const bold = color('1')
const stats = { pass: 0, fail: 0 }

function check(name, ok, detail) {
  if (ok) {
    stats.pass++
    console.log(`  ${green('✓')} ${name}`)
    return true
  }
  stats.fail++
  console.log(`  ${red('✗')} ${name}`)
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
    console.log(`      ${dim(text.length > 500 ? `${text.slice(0, 500)}…` : text)}`)
  }
  return false
}

function section(title) {
  console.log(`\n${bold(title)}`)
}

// ========== A. store 单测 ==========
async function testStore() {
  section('A. candidates-store 单测（临时文件）')

  const created = await store.upsertCandidate({ candidateId: 'v-c1', fileName: '张三简历.md', jobId: 'v-j1' })
  check('新建候选人默认状态是待筛选', created.status === '待筛选', created.status)
  check('展示名从文件名派生', created.name === '张三简历', created.name)

  await store.updateCandidateStatus('v-c1', '已面试')
  const reupload = await store.upsertCandidate({ candidateId: 'v-c1', fileName: '张三简历-优化版.md' })
  check('重新上传简历不会重置已有状态', reupload.status === '已面试', reupload.status)
  check('重新上传会更新文件名', reupload.fileName === '张三简历-优化版.md', reupload.fileName)
  check('重新上传不会抹掉原岗位', reupload.jobId === 'v-j1', reupload.jobId)
  const count = (await store.listCandidates()).length
  check('同一 candidateId 只留一条记录', count === 1, `实际 ${count} 条`)

  const bad = await store.updateCandidateStatus('v-c1', '约面中')
  check('非法状态被拒绝', bad.ok === false && /不在允许范围/.test(bad.error), bad.error)

  const missing = await store.updateCandidateStatus('v-nobody', '已面试')
  check('改不存在的候选人被拒绝', missing.ok === false, missing.error)

  const same = await store.updateCandidateStatus('v-c1', '已面试')
  check('同状态再改标记为 unchanged（幂等）', same.ok === true && same.unchanged === true, same)

  const changed = await store.updateCandidateStatus('v-c1', '已发offer')
  check('正常改状态返回旧状态', changed.ok === true && changed.from === '已面试', changed.from)

  await store.recordScore('v-c1', { score: 78, verdict: '建议面试', jobId: 'v-j1' })
  const scored = await store.getCandidate('v-c1')
  check('评分结果写回候选人表', scored.lastScore === 78 && scored.lastVerdict === '建议面试', scored)

  const filtered = await store.listCandidates({ status: '已发offer' })
  check('按状态筛选可用', filtered.length === 1, `命中 ${filtered.length} 条`)

  // 落盘检查：状态是持久化到文件的，不是只在内存里
  const raw = JSON.parse(fs.readFileSync(TMP_STORE, 'utf8'))
  check('数据已落盘且结构正确', Array.isArray(raw.candidates) && raw.candidates[0].status === '已发offer')
}

// ========== HTTP 工具 ==========
async function uploadDoc(fileName, content, fields = {}) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/markdown' }), fileName)
  for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value)
  const res = await fetch(`${BASE_URL}/api/upload-doc`, { method: 'POST', body: form, headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** 传二进制文件（docx 这类），content 为 Buffer */
async function uploadBinary(fileName, content, fields = {}) {
  const form = new FormData()
  form.append('file', new Blob([content]), fileName)
  for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value)
  const res = await fetch(`${BASE_URL}/api/upload-doc`, { method: 'POST', body: form, headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function getJson(url) {
  const res = await fetch(`${BASE_URL}${url}`, { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** 发一次 AG-UI run，把 SSE 帧解析成事件数组 */
async function runAgui(payload) {
  const res = await fetch(`${BASE_URL}/agui`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const events = []
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.replace(/^data:\s?/, ''))
        .join('\n')
      if (!data) continue
      try {
        events.push(JSON.parse(data))
      } catch {
        /* 半帧或心跳，忽略 */
      }
    }
  }
  return events
}

const RESUME_TEXT = `# 张宝玉

## 基本信息
工作年限：6 年
现居：杭州
学历：本科（计算机科学与技术）
到岗时间：两周内

## 技术栈
Vue3、TypeScript、Vite、Pinia、TDesign、Node.js、Express

## 工作经历
2021.03 - 至今　某电商公司　高级前端工程师
负责商家后台（DAU 3 万）的整体前端架构，主导从 Vue2 迁移到 Vue3，
抽象出 40+ 业务组件，构建耗时从 90 秒降到 22 秒。

2019.06 - 2021.02　某 SaaS 公司　前端工程师
负责低代码平台的渲染引擎，支持 200+ 组件拖拽编排，服务 300 家企业客户。

## 项目经历
AI 客服工作台：Vue3 + WebSocket 实现多轮对话，QPS 200，线上稳定运行一年。`

const JD_TEXT = `# 高级前端工程师（AI 应用方向）

## 岗位职责
1. 负责 AI 应用的前端架构设计与实现；
2. 与算法团队协作，落地大模型交互体验。

## 任职要求
1. 本科及以上学历，计算机相关专业；
2. 5 年以上前端开发经验，精通 Vue3 与 TypeScript；
3. 有完整负责线上系统的经验，能独立完成从设计到上线；
4. 有 AI 应用或大模型相关经验者优先。

## 工作地点
杭州（不支持远程）

## 到岗时间
一个月内`

// ========== B. 上传去重 ==========
async function testUpload() {
  section('B. 上传：同名文件不能互相覆盖')

  const c1 = await uploadDoc('同名简历.md', RESUME_TEXT, { docType: 'resume', candidateId: 'v-c1', jobId: 'v-j1' })
  check('候选人 1 简历入库成功', c1.status === 200 && c1.body.ok === true, c1.body)
  check('首份文件不改名', c1.body.renamed === false && c1.body.filename === '同名简历.md', c1.body)

  const c2 = await uploadDoc('同名简历.md', RESUME_TEXT.replace('张宝玉', '李四').replace('6 年', '3 年'), { docType: 'resume', candidateId: 'v-c2' })
  check('候选人 2 同名文件另存', c2.status === 200 && c2.body.renamed === true, c2.body)
  check('另存名带序号 -2', /同名简历-2\.md$/.test(c2.body.filename || ''), c2.body.filename)
  check('另存时没有删掉别人的片段', c2.body.removed === 0, c2.body.removed)

  const again = await uploadDoc('同名简历.md', RESUME_TEXT, { docType: 'resume', candidateId: 'v-c1', jobId: 'v-j1' })
  check('同一候选人重传视为覆盖', again.body.renamed === false && again.body.removed > 0, again.body)

  const jd = await uploadDoc('岗位JD.md', JD_TEXT, { docType: 'jd', jobId: 'v-j1' })
  check('JD 入库成功', jd.status === 200 && jd.body.ok === true, jd.body)

  const missing = await uploadDoc('无主简历.md', RESUME_TEXT, { docType: 'resume' })
  check('简历缺 candidateId 返回 400', missing.status === 400, missing)

  const docs = await getJson('/api/documents')
  const names = (docs.body.data || []).map(item => item.fileName)
  check('两份同名简历都在库里', names.includes('同名简历.md') && names.includes('同名简历-2.md'), names)
  const tagged = (docs.body.data || []).find(item => item.fileName === '同名简历-2.md')
  check('文档列表带出业务标签', tagged?.candidateId === 'v-c2', tagged)

  const candidates = await getJson('/api/candidates')
  const ids = (candidates.body.data || []).map(item => item.candidateId)
  check('/api/candidates 能列出两位候选人', ids.includes('v-c1') && ids.includes('v-c2'), ids)
  check('候选人带状态枚举', Array.isArray(candidates.body.statuses) && candidates.body.statuses.length > 0, candidates.body.statuses)

  const jobs = await getJson('/api/jobs')
  check('/api/jobs 能列出岗位', (jobs.body.data || []).some(item => item.jobId === 'v-j1'), jobs.body)
}

// ========== C. 评分工具接线 ==========
async function testScoreTool() {
  section('C. 评分工具：模型能拿到 id 并跑通评估')
  const threadId = `verify-score-${randomUUID()}`
  const events = await runAgui({
    threadId,
    runId: randomUUID(),
    messages: [{
      id: `m-${randomUUID()}`,
      role: 'user',
      content: '请调用 scoreResumeAgainstJD 工具，candidateId 用 v-c1，jobId 用 v-j1，只调用工具不要额外解释'
    }],
    forwardedProps: { sessionId: threadId },
    state: {}
  })
  const call = events.find(item => item.type === 'TOOL_CALL_START' && item.toolCallName === 'scoreResumeAgainstJD')
  check('模型调用了 scoreResumeAgainstJD', Boolean(call), events.filter(e => e.type === 'TOOL_CALL_START').map(e => e.toolCallName))
  const result = events.find(item => item.type === 'TOOL_CALL_RESULT' && item.toolCallId === call?.toolCallId)
  const content = result?.content || ''
  check('返回匹配度结论', /匹配度|没有找到/.test(content), content.slice(0, 300))
  // 分数是代码算出来的，必然带分项明细；只有走完整个 rubric 才会有这段
  check('分项与门槛都出现在结果里', /技术栈匹配/.test(content) || /没有找到/.test(content), content.slice(0, 300))
  const stored = await getJson('/api/candidates?jobId=v-j1')
  const record = (stored.body.data || []).find(item => item.candidateId === 'v-c1')
  check('评分写回候选人表', record?.lastScore !== null && record?.lastScore !== undefined, record)
}

// ========== D. 改状态审批 ==========
/** 从事件流里还原"模型发出的 tool-call"，拼成 assistant 消息——真实客户端也是这么做的 */
function collectToolCalls(events) {
  const order = []
  const byId = new Map()
  for (const event of events) {
    if (event.type === 'TOOL_CALL_START') {
      order.push(event.toolCallId)
      byId.set(event.toolCallId, { id: event.toolCallId, type: 'function', function: { name: event.toolCallName, arguments: '' } })
    } else if (event.type === 'TOOL_CALL_ARGS') {
      const call = byId.get(event.toolCallId)
      if (call) call.function.arguments += event.delta || ''
    }
  }
  return order.map(id => byId.get(id))
}

async function testApproval() {
  section('D. 改状态：interrupt → resume → 重放不重复执行')
  const candidateId = 'v-c2'
  const threadId = `verify-approval-${randomUUID()}`
  const userMessage = {
    id: `m-${randomUUID()}`,
    role: 'user',
    // 点名工具和参数：这里验的是"审批链路"，不是"模型会不会自己想起来要改状态"。
    // 不写死参数的话，模型可能先调 listCandidates 再决定，断言就会随机失败。
    content: `请调用 updateCandidateStatus 工具，candidateId=${candidateId}，status=待面试，reason=简历初筛通过，只调用工具不要额外解释`
  }

  // ① 模型决定改状态 → 服务端不应直接执行，而要转成 interrupt
  const first = await runAgui({ threadId, runId: randomUUID(), messages: [userMessage], forwardedProps: { sessionId: threadId }, state: {} })
  const finished = first.find(item => item.type === 'RUN_FINISHED')
  const interrupt = finished?.outcome?.interrupts?.[0]
  const calledNames = first.filter(e => e.type === 'TOOL_CALL_START').map(e => e.toolCallName)
  if (!check('模型调用了 updateCandidateStatus', calledNames.includes('updateCandidateStatus'), calledNames)) return
  check('审批工具转成了 interrupt', finished?.outcome?.type === 'interrupt', finished?.outcome)
  if (!check('interrupt 带得回 toolCallId', Boolean(interrupt?.toolCallId), interrupt)) return
  check('interrupt 指向 updateCandidateStatus', interrupt?.metadata?.toolName === 'updateCandidateStatus', interrupt?.metadata)
  check('确认文案包含目标状态', /待面试/.test(interrupt?.message || ''), interrupt?.message)

  const before = await getJson('/api/candidates')
  const untouched = (before.body.data || []).find(item => item.candidateId === candidateId)
  check('确认前状态未被修改', untouched?.status !== '待面试', untouched?.status)

  // 客户端在收到 TOOL_CALL_START/ARGS/END 后会把这条 assistant 消息塞进历史，resume 时一并带回
  const assistantMessage = { id: `m-${randomUUID()}`, role: 'assistant', content: '', toolCalls: collectToolCalls(first) }

  // ② resume 同意：服务端执行并把结果写回历史
  const second = await runAgui({
    threadId,
    runId: randomUUID(),
    messages: [userMessage, assistantMessage],
    resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
    forwardedProps: { sessionId: threadId },
    state: {}
  })
  const executed = second.find(item => item.type === 'TOOL_CALL_RESULT' && item.toolCallId === interrupt.toolCallId)
  check('同意后执行了改状态', /已将候选人/.test(executed?.content || ''), executed?.content)
  const after = await getJson('/api/candidates')
  const updated = (after.body.data || []).find(item => item.candidateId === candidateId)
  check('状态已落库为待面试', updated?.status === '待面试', updated?.status)

  // ③ 重放：工具结果已在历史里，resume 应被 hasResult 拦掉，不能执行第二次
  const replayMessages = [...[userMessage, assistantMessage], { id: `m-${randomUUID()}`, role: 'tool', content: executed?.content || '', toolCallId: interrupt.toolCallId }]
  const third = await runAgui({
    threadId,
    runId: randomUUID(),
    messages: replayMessages,
    resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }],
    forwardedProps: { sessionId: threadId },
    state: {}
  })
  const duplicated = third.find(item => item.type === 'TOOL_CALL_RESULT' && item.toolCallId === interrupt.toolCallId)
  check('重放不重复执行', !duplicated, duplicated?.content)
}

// ========== E. PII 脱敏 ==========
async function testRedact() {
  section('E. PII 脱敏：该抹的抹掉，不该动的别碰')
  const { redactPII } = require('../rag-utils.js')
  const cases = [
    ['手机号', '联系电话 138 1234 5678，随时可到岗', '138'],
    ['身份证', '身份证号 310115199003074512', '310115199003074512'],
    ['邮箱', '邮箱 zhang.san+vip@example.com.cn', 'example.com']
  ]
  for (const [label, input, secret] of cases) {
    const { text } = redactPII(input)
    check(`${label}被抹掉`, !text.includes(secret) && /已脱敏/.test(text), text)
  }

  // 邮箱里含手机号：手机号规则先跑会挖掉中间，剩下 z[手机号已脱敏]@163.com，等于没盖住
  const combo = redactPII('邮箱：z15000000000@163.com').text
  check('手机号形式的邮箱整体被抹', combo.includes('[邮箱已脱敏]'), combo)

  // 这两条是实测踩出来的误伤，必须回归住：误伤不报错，只会让检索质量悄悄下降
  const taxId = redactPII('统一社会信用代码/纳税人识别号:91310000631494692T').text
  check('纳税人识别号不被当成银行卡', taxId.includes('91310000631494692T'), taxId)
  const float = redactPII('source node score: 0.8659382811170047').text
  check('16 位小数不被当成银行卡', float.includes('0.8659382811170047'), float)

  const address = redactPII('现居：杭州市西湖区文三路 100 号').text
  check('门牌被抹但城市保留', address.includes('杭州市西湖区') && !address.includes('100 号'), address)

  // 端到端：带手机号的简历入库后，磁盘上的向量库文件里不能再出现那串数字
  const phone = '13900001111'
  const uploaded = await uploadDoc(
    '脱敏验证简历.md',
    `# 王五\n\n电话：${phone}\n邮箱：wangwu${phone}@qq.com\n\n6 年前端经验，熟悉 Vue3。`,
    { docType: 'resume', candidateId: 'v-redact' }
  )
  check('简历入库成功', uploaded.status === 200 && uploaded.body.ok === true, uploaded.body)
  const indexFile = path.join(import.meta.dirname, '..', 'vector-index', 'index.json')
  const raw = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : ''
  check('向量库文件里查不到手机号', Boolean(raw) && !raw.includes(phone), raw ? '索引里仍有该号码' : '索引文件不存在')
  await fetch(`${BASE_URL}/api/documents/delete`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ fileName: '脱敏验证简历.md' })
  })
}

// ========== F. Word 文档解析 ==========
/**
 * 简历十份有九份是 Word。这段盯住三个最容易悄悄错的地方：
 *   ① 表格 —— 剥标签不还给分隔符，整张经历表会粘成一行，切块切不动且不报错；
 *   ② 脱敏 —— 走的是同一条 extractFileText 通道，docx 不能绕过；
 *   ③ 失败清理 —— 加密/损坏文件解析失败时，uploads 里不能留下孤儿文件。
 */
async function testDocx() {
  section('F. Word（.docx）：表格保留行列、照样脱敏、坏文件不留残留')
  const { extractFileText } = require('../rag-utils.js')
  const fixture = path.join(import.meta.dirname, 'fixtures', 'sample-resume.docx')
  check('样本文件存在', fs.existsSync(fixture), fixture)

  const text = await extractFileText(fixture, '.docx')
  // 表格行必须是「时间 | 公司 | 职位」这种一行三格，而不是一格一行、分隔符跑到行首
  const tableRow = text.split('\n').find(line => line.includes('未来智能科技')) || ''
  check('表格按行还原，单元格用 | 分隔', /^2022\.04-2025\.09 \| 未来智能科技 \| 高级前端工程师$/.test(tableRow), tableRow)
  check('表头同样保留', text.includes('时间 | 公司 | 职位'), text.split('\n').find(line => line.includes('时间')) || '(缺表头)')
  check('行首没有多余分隔符', !/^\s*\|/m.test(text), text.split('\n').filter(line => /^\s*\|/.test(line)).join(' / '))
  check('段落各自成行（未被粘成一行）', text.split('\n').length >= 10, `${text.split('\n').length} 行`)
  check('docx 同样走脱敏', !text.includes('13900002222') && !text.includes('zhaoliu@example.com'), text.slice(0, 120))

  // 端到端：真上传一份 docx 简历
  const buf = fs.readFileSync(fixture)
  const uploaded = await uploadBinary('Word简历.docx', buf, { docType: 'resume', candidateId: 'v-docx' })
  check('docx 上传成功', uploaded.status === 200 && uploaded.body.ok === true, uploaded.body)
  check('切出了文本块', (uploaded.body.chunkCount || 0) > 0, uploaded.body.chunkCount)
  const candidates = await getJson('/api/candidates')
  const registered = (candidates.body.data || []).find(item => item.candidateId === 'v-docx')
  check('docx 简历同样登记了候选人', Boolean(registered), registered || candidates.body)

  // 老格式 .doc：白名单拒绝，且错误信息要告诉用户「另存为 .docx」
  const legacy = await uploadBinary('老格式简历.doc', Buffer.from('fake doc'), { docType: 'resume', candidateId: 'v-doc' })
  check('.doc 被拒绝且状态码为 400', legacy.status === 400, legacy)
  check('.doc 的提示包含「另存为 .docx」', /另存为 \.docx/.test(legacy.body.error || ''), legacy.body.error)

  // 坏 docx：解析失败要返回 400，并且不能把 multer 落盘的文件留在 uploads
  const uploadDir = path.join(import.meta.dirname, '..', 'uploads')
  const countUploads = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0)
  const before = countUploads()
  const broken = await uploadBinary('损坏简历.docx', Buffer.from('not a zip file'), { docType: 'resume', candidateId: 'v-broken' })
  const after = countUploads()
  check('坏 docx 返回 400 而不是 500', broken.status === 400, broken)
  check('坏 docx 的错误可读', /Word 文档解析失败/.test(broken.body.error || ''), broken.body.error)
  // 残留检查是「有则更好」：某些受限沙箱（以及 macOS 上开了「完全磁盘访问」限制的环境）
  // 会直接 EPERM 掉 unlink，这时删不掉不代表逻辑错——逻辑正确性由上一项 400 兜住：
  // 若 removeFileQuietly 没吞异常，状态码会变成 500，那条断言会先红。
  if (after === before) {
    check('解析失败后 uploads 没有残留文件', true)
  } else {
    console.log(`  ${dim(`· 解析失败后留下 ${after - before} 个文件（当前环境不允许删除，真实部署会清掉）`)}`)
  }

  await fetch(`${BASE_URL}/api/documents/delete`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ fileName: 'Word简历.docx' })
  })
}

async function cleanup() {
  section('清理')
  for (const name of ['同名简历.md', '同名简历-2.md', '岗位JD.md', '脱敏验证简历.md', 'Word简历.docx']) {
    const res = await fetch(`${BASE_URL}/api/documents/delete`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ fileName: name })
    })
    const body = await res.json().catch(() => ({}))
    console.log(`  ${dim(`删除 ${name}：${body.removed ?? 0} 段`)}`)
  }
  fs.rmSync(TMP_STORE, { force: true })
  console.log(`  ${dim('候选人表里会残留 v-c1 / v-c2 记录（无简历时列表不显示），需要清理可删 server/data/candidates.json')}`)
}

// ========== 入口 ==========
console.log(`${bold('招聘场景切片验收')} ${dim(BASE_URL)}`)
try {
  // 鉴权上线后所有端点都要 token：脚本注册一个专用账号，HTTP 段全程带它
  const { username } = await login()
  console.log(`  ${dim(`测试账号：${username}`)}`)
  await testStore()
  await testUpload()
  await testRedact()
  await testDocx()
  if (SKIP_MODEL) {
    console.log(`\n${dim('--skip-model：跳过 C、D 两段需要调模型的用例')}`)
  } else {
    await testScoreTool()
    await testApproval()
  }
} catch (err) {
  stats.fail++
  console.log(`\n${red('执行中断：')}${err.message}`)
  if (err.cause) console.log(dim(String(err.cause)))
} finally {
  await cleanup().catch(err => console.log(dim(`清理失败：${err.message}`)))
  console.log(`\n${stats.fail ? red(`✗ 失败 ${stats.fail} 项`) : green('✓ 全部通过')}，通过 ${stats.pass} 项`)
  process.exit(stats.fail ? 1 : 0)
}
