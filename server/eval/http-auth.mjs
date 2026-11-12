/**
 * eval/http-auth.mjs —— 测试脚本共用的登录助手
 *
 * 鉴权上线后所有业务端点都要带 Bearer token，评测脚本作为"第一个真实用户"，
 * 必须先走注册/登录拿到 token 才能继续。register 失败（409 已存在）不算错——
 * 脚本反复跑，第二次注册必然撞名，直接走登录兜底。
 */
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')

let token = null

export async function login({ username, password } = {}) {
  const user = username || `eval_${process.pid}_${Date.now().toString(36)}`
  const pass = password || 'eval-pass-123456'
  // 用户名长度上限 32，超了截断（不影响唯一性，后面还拼了 pid + 时间戳）
  const name = user.slice(0, 32)
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: pass })
  })
  if (regRes.ok) {
    token = (await regRes.json()).token
    return { token, username: name }
  }
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: pass })
  })
  if (!loginRes.ok) {
    throw new Error(`测试账号登录失败：${loginRes.status} ${await loginRes.text()}`)
  }
  token = (await loginRes.json()).token
  return { token, username: name }
}

/** 组装带鉴权的 headers，其余脚本 fetch 时统一套这一层 */
export function authHeaders(extra = {}) {
  if (!token) throw new Error('请先调用 login() 再发请求')
  return { Authorization: `Bearer ${token}`, ...extra }
}

export { BASE_URL }
