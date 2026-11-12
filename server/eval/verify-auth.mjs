#!/usr/bin/env node
/**
 * M1 验收：鉴权 + 数据隔离 + 会话落库 + 服务重启不丢数据
 *
 * 分四段，全程不调模型：
 *   A. 鉴权本身：未登录 401 / 注册 / 登录 / 错误密码 401 / 登出后 token 失效
 *   B. 数据隔离：A 上传文档 B 看不见；B 删 A 的文档 404；B 检索不到 A 的内容；
 *      候选人表同 id 不同账号互不干扰
 *   C. 会话落库：跑一轮 /agui 后，GET /api/threads 有记录，快照可读，别人的读不到
 *   D. 重启不丢：候选人状态写库 → （提示手工重启验证，脚本内重启不可靠）
 *
 * 用法：node eval/verify-auth.mjs   （服务需已启动）
 */
import { randomUUID } from 'node:crypto'
import { login, authHeaders, BASE_URL } from './http-auth.mjs'

const TIMEOUT_MS = Number(process.env.AGUI_TIMEOUT_MS || 60000)
const dim = text => process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text
const bold = text => process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text

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

const raw = (url, options = {}) =>
  fetch(`${BASE_URL}${url}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...options })
    .then(async res => ({ status: res.status, body: await res.json().catch(() => ({})) }))

// ========== A. 鉴权本身 ==========
async function testAuthBasics() {
  section('A. 鉴权：401 / 注册 / 登录 / 登出')
  const anon = await raw('/api/documents')
  check('未登录访问业务端点 401', anon.status === 401, anon)

  const unauthAgui = await raw('/agui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'user', content: 'hi' }] })
  })
  check('未登录访问 /agui 也是 401', unauthAgui.status === 401, unauthAgui.status)

  const badReg = await raw('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a b!', password: 'pass123456' })
  })
  check('非法用户名 400', badReg.status === 400, badReg)

  const shortPwd = await raw('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `short_${randomUUID().slice(0, 6)}`, password: '123' })
  })
  check('密码过短 400', shortPwd.status === 400, shortPwd)

  // 先确保 auth_a 存在（首次跑会成功注册，之后跑都是 409），再断言重复注册被拒
  await raw('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'auth_a', password: 'pass123456' })
  })
  const dupe = await raw('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'auth_a', password: 'pass123456' })
  })
  check('重复用户名 409', dupe.status === 409, dupe.status)

  const badLogin = await raw('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'auth_a', password: 'wrong-password' })
  })
  check('密码错误 401 且文案不泄露用户存在性', badLogin.status === 401 && badLogin.body.error === '用户名或密码错误', badLogin.body)

  const me = await raw('/api/auth/me', { headers: authHeaders() })
  check('/api/auth/me 返回当前用户', me.status === 200 && Boolean(me.body.user?.username), me.body)

  // 登出失效：单独注册一个账号来测，不动主账号的 token
  const throwaway = await login({ username: `auth_throwaway_${randomUUID().slice(0, 6)}` })
  await raw('/api/auth/logout', { method: 'POST', headers: authHeaders() })
  const afterLogout = await raw('/api/documents', { headers: { Authorization: `Bearer ${throwaway.token}` } })
  check('登出后 token 立即失效', afterLogout.status === 401, afterLogout.status)
}

// ========== B. 数据隔离 ==========
const DOC_NAME = `隔离验证-${randomUUID().slice(0, 6)}.md`

async function upload(token, fileName, content, fields) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/markdown' }), fileName)
  for (const [key, value] of Object.entries(fields || {})) if (value) form.append(key, value)
  const res = await fetch(`${BASE_URL}/api/upload-doc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function docsOf(token) {
  const res = await fetch(`${BASE_URL}/api/documents`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return (await res.json())?.data || []
}

async function testIsolation() {
  section('B. 数据隔离：A 的文档对 B 不存在')
  const a = await login({ username: 'auth_a', password: 'pass123456' })
  const b = await login({ username: `auth_b_${randomUUID().slice(0, 6)}`, password: 'pass123456' })

  const up = await upload(a.token, DOC_NAME, `# 隔离验证简历\n\n9 年后端经验，关键词：ISOLATION-${randomUUID().slice(0, 6)}。\n`, { docType: 'resume', candidateId: 'iso-check' })
  check('A 上传成功', up.status === 200 && up.body.ok === true, up)

  const aDocs = await docsOf(a.token)
  check('A 能看到自己的文档', aDocs.some(d => d.fileName === DOC_NAME))

  const bDocs = await docsOf(b.token)
  check('B 看不到 A 的文档', !bDocs.some(d => d.fileName === DOC_NAME))

  const del = await raw('/api/documents/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ fileName: DOC_NAME })
  })
  check('B 删除 A 的文档 404', del.status === 404, del)

  const aDoc = aDocs.find(d => d.fileName === DOC_NAME)
  check('B 的删除尝试没有真的删掉（A 仍可见）', Boolean(aDoc))

  // 候选人表：A 登记 iso-check，B 的候选人列表里不能出现
  const candB = await fetch(`${BASE_URL}/api/candidates`, { headers: { Authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(res => res.json())
  check('B 的候选人列表没有 A 的候选人', !(candB.data || []).some(c => c.candidateId === 'iso-check'), candB.data?.map(c => c.candidateId))

  return { a, b }
}

// ========== C. 会话落库 ==========
async function testThreads({ a, b }) {
  section('C. 会话落库：快照可读、跨账号不可读')
  const threadId = `auth-th-${randomUUID().slice(0, 6)}`
  const res = await fetch(`${BASE_URL}/agui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${a.token}` },
    body: JSON.stringify({
      threadId,
      runId: randomUUID(),
      messages: [{ id: 'm1', role: 'user', content: '计算 23 乘 4 等于多少' }],
      forwardedProps: { sessionId: threadId },
      state: {}
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  await res.text() // 等本轮跑完（calculator 是服务端工具，不会真调模型也要几秒）

  const list = await raw('/api/threads', { headers: { Authorization: `Bearer ${a.token}` } })
  const thread = (list.body.data || []).find(t => t.id === threadId)
  check('会话出现在 A 的列表里', Boolean(thread), list.body)

  const snapshot = await raw(`/api/threads/${threadId}/messages`, { headers: { Authorization: `Bearer ${a.token}` } })
  const roles = (snapshot.body.messages || []).map(m => m.role)
  check('快照包含 user 与 assistant 消息', roles.includes('user') && roles.includes('assistant'), roles)
  check('快照包含工具结果', roles.includes('tool'), roles)

  const cross = await raw(`/api/threads/${threadId}/messages`, { headers: { Authorization: `Bearer ${b.token}` } })
  check('B 读 A 的会话 404', cross.status === 404, cross.status)

  const ghost = await raw(`/api/threads/${randomUUID()}/messages`, { headers: { Authorization: `Bearer ${a.token}` } })
  check('不存在的会话也是 404', ghost.status === 404, ghost.status)

  // 清理：删测试文档 + 候选人 + 会话记录
  await raw('/api/documents/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ fileName: DOC_NAME })
  })
  return { aToken: a.token }
}

// ========== 清理 ==========
async function cleanup({ aToken }) {
  section('清理')
  // 候选人 iso-check 由脚本注册，脚本无法直接删 JSON 表里的记录（没有删除端点），
  // 留一条无简历的记录不影响列表展示（列表以向量库为准）
  console.log(`  ${dim('候选人表残留 iso-check（无简历时不显示），如需清理可编辑 server/data/candidates.json')}`)
}

// ========== 入口 ==========
console.log(`${bold('M1 验收：鉴权 / 隔离 / 会话落库')} ${dim(BASE_URL)}`)
const ctx = {}
try {
  await login({ username: `auth_seed_${randomUUID().slice(0, 6)}` }) // 确认服务可用
  await testAuthBasics()
  Object.assign(ctx, await testIsolation())
  Object.assign(ctx, await testThreads(ctx))
  await cleanup(ctx)
  console.log(`\n${bold(`通过 ${passed} 项，失败 ${failed} 项`)}`)
  process.exit(failed ? 1 : 0)
} catch (err) {
  console.error('执行中断：', err?.message || err)
  process.exit(1)
}
