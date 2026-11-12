#!/usr/bin/env node
/**
 * P1 模型验收：模型清单 / 未知模型处理 / 深度思考映射 / 视觉自动切换
 *
 * 分三段：
 *   A. GET /api/models：未登录 401、登录后字段完整、default 在列表内
 *   B. resolveModel 纯函数：不调模型，覆盖四条规则（默认 / 关思考 / 显式指定 / 带图切换）
 *   C. 真调模型三小段：/agui 指定模型、/v1 未知模型回落、/v1 显式模型优先于 reasoning_effort
 *
 * 为什么 B 段要用纯函数验证：视觉切换、未知模型回落这些分支如果只靠 HTTP 验证，
 * 每次都要真调模型、真造图片附件，又慢又脆。规则本身是纯函数，直接断言最可靠。
 *
 * 用法：node eval/verify-models.mjs   （服务需已启动）
 */
import modelsPkg from '../models.js' // models.js 是 CommonJS，ESM 里走 default 导入
import { login, authHeaders, BASE_URL } from './http-auth.mjs'

const { resolveModel, listModels: localList } = modelsPkg
const TIMEOUT_MS = Number(process.env.AGUI_TIMEOUT_MS || 90000)
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

const json = (url, options = {}) =>
  fetch(`${BASE_URL}${url}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...options }).then(async res => ({
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    body: await res.json().catch(() => ({}))
  }))

// ========== A. 模型列表接口 ==========
async function testModelList() {
  section('A. GET /api/models')

  const anonymous = await json('/api/models')
  check('未登录访问 401', anonymous.status === 401, anonymous.body)

  const { token } = await login({ username: `p1_model_${Date.now().toString(36).slice(-6)}` })
  const authed = await json('/api/models', { headers: authHeaders() })
  check('登录后 200', authed.status === 200, authed.body)
  const list = authed.body?.data
  check('返回模型数组（≥2 个）', Array.isArray(list) && list.length >= 2, list)

  const first = list?.[0] || {}
  check('每项含 id/label/description/reasoning/vision',
    ['id', 'label', 'description', 'reasoning', 'vision'].every(key => key in first), first)
  check('默认模型在列表内', list?.some(item => item.id === authed.body?.default), { def: authed.body?.default, list })
  check('至少有一个思考模型', list?.some(item => item.reasoning === true), list)
  check('至少有一个视觉模型', list?.some(item => item.vision === true), list)

  return { token, list: list || [], defaultModel: authed.body?.default }
}

// ========== B. resolveModel 纯函数规则 ==========
function testResolveRules() {
  section('B. resolveModel 规则（纯函数，不调模型）')
  const ids = localList().map(item => item.id)
  const reasoningId = localList().find(item => item.reasoning)?.id
  const fastId = localList().find(item => !item.reasoning && !item.vision)?.id
  const visionId = localList().find(item => item.vision)?.id

  const byDefault = resolveModel({})
  check('什么都不传 → 默认深度思考', byDefault.modelId === reasoningId && byDefault.reasoning === true, byDefault)

  const noThink = resolveModel({ thinking: false })
  check('thinking=false → 快速模型且不思考', noThink.modelId === fastId && noThink.reasoning === false, noThink)

  const explicit = resolveModel({ requested: fastId, thinking: true })
  check('显式模型优先于 thinking', explicit.modelId === fastId && explicit.reasoning === false, explicit)

  const unknown = resolveModel({ requested: 'gpt-4o-mini' })
  check('未知模型返回 error 而不是静默用错', Boolean(unknown.error), unknown)

  const withImage = resolveModel({ requested: fastId, hasImages: true })
  check('带图时自动切视觉模型', withImage.modelId === visionId && withImage.vision === true, withImage)
  check('带图切换会说明原因（notice 非空）', typeof withImage.notice === 'string' && withImage.notice.length > 0, withImage.notice)

  const visionExplicit = resolveModel({ requested: visionId, hasImages: true })
  check('显式选了视觉模型时不再切换、不产生 notice', visionExplicit.modelId === visionId && !visionExplicit.notice, visionExplicit)

  check('模型 id 均非空且不重复', ids.length === new Set(ids).size && ids.every(Boolean), ids)
}

// ========== C. 真调模型 ==========
/** 读 SSE 全文，返回原始文本（事件名/内容都在里面，够断言用） */
async function postAgui(body) {
  const res = await fetch(`${BASE_URL}/agui`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: `t-${Date.now()}`, runId: `r-${Date.now()}`, tools: [], ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text().catch(() => '')
  return { status: res.status, contentType: res.headers.get('content-type') || '', text }
}

async function testRealCalls(fastId, defaultModel) {
  section('C. 真调模型（三次，均走快速模型，短 prompt）')

  // C1. /agui 指定合法模型：应正常跑完一轮
  const agui = await postAgui({
    model: fastId,
    messages: [{ id: 'm1', role: 'user', content: '只回复两个字：收到' }]
  })
  check('/agui 指定模型 → 200 且是 SSE', agui.status === 200 && /event-stream/.test(agui.contentType), {
    status: agui.status, ct: agui.contentType, head: agui.text.slice(0, 120)
  })
  check('/agui 流里有 RUN_STARTED 与 RUN_FINISHED',
    agui.text.includes('RUN_STARTED') && agui.text.includes('RUN_FINISHED'), agui.text.slice(-200))

  // C2. /agui 传未知模型：应 400 并列出可用模型（自家前端，拼错必须暴露）
  const badModel = await postAgui({
    model: 'gpt-4o-mini',
    messages: [{ id: 'm2', role: 'user', content: 'hi' }]
  })
  check('/agui 未知模型 400', badModel.status === 400 && /未知模型/.test(badModel.text), badModel.text.slice(0, 200))
  check('/agui 400 里带可用模型列表', /available/.test(badModel.text), badModel.text.slice(0, 200))

  // C3. /v1 未知模型 + x_thinking=false：静默回落默认并按开关走快速模型（兼容端点不能报错）
  const v1Unknown = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      x_thinking: false,
      messages: [{ role: 'user', content: '只回复两个字：收到' }]
    })
  })
  check('/v1 未知模型不报错（200）', v1Unknown.status === 200, { status: v1Unknown.status, body: v1Unknown.body })
  check('/v1 x_thinking=false 落到快速模型', v1Unknown.body?.model === fastId, v1Unknown.body?.model)
  check('/v1 回真实模型名而不是客户端传的假名', v1Unknown.body?.model !== 'gpt-4o-mini', v1Unknown.body?.model)

  // C4. /v1 显式模型优先：reasoning_effort=high 想开思考，但显式指了快速模型 → 听显式的
  const v1Explicit = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: fastId,
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: '只回复两个字：收到' }]
    })
  })
  check('/v1 显式模型优先于 reasoning_effort', v1Explicit.body?.model === fastId, v1Explicit.body?.model)

  // 兜底：默认模型确实在服务端注册表里（防止 .env 配了个不存在的名字还以为一切正常）
  check('默认模型可被解析', Boolean(defaultModel) && !resolveModel({ requested: defaultModel }).error, defaultModel)
}

// ========== 入口 ==========
const { list, defaultModel } = await testModelList()
testResolveRules()
const fastId = list.find(item => !item.reasoning && !item.vision)?.id || list[1]?.id
await testRealCalls(fastId, defaultModel)

console.log(`\n${bold('结果')}：通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
