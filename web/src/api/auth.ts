/**
 * 统一的鉴权与请求封装。
 *
 * 为什么不引 axios / 不做拦截器：项目里只有 5 处 fetch，一个模块 + 手动套 header
 * 比引依赖、配拦截器轻得多。401 统一在这里翻出来，App.vue 据此弹出登录层。
 */
import { ref } from 'vue'

const TOKEN_KEY = 'auth_token'
const USER_KEY = 'auth_user'

export interface AuthUser {
  userId: string
  username: string
}

const user = ref<AuthUser | null>(JSON.parse(localStorage.getItem(USER_KEY) || 'null'))
// 初始化时 token 与 user 必须同时有效，只留 user 没 token 视为未登录
const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
if (!token.value) user.value = null

export const currentUser = user

export function isLoggedIn(): boolean {
  return Boolean(token.value && user.value)
}

function persist() {
  if (token.value) localStorage.setItem(TOKEN_KEY, token.value)
  else localStorage.removeItem(TOKEN_KEY)
  if (user.value) localStorage.setItem(USER_KEY, JSON.stringify(user.value))
  else localStorage.removeItem(USER_KEY)
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  if (!token.value) return extra
  return { Authorization: `Bearer ${token.value}`, ...extra }
}

/** 登录成功后写入本地；服务端 401 时由 clearAuth 清空 */
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `登录失败（${res.status}）`)
  token.value = body.token
  user.value = body.user
  persist()
}

export async function register(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `注册失败（${res.status}）`)
  token.value = body.token
  user.value = body.user
  persist()
}

export async function logout(): Promise<void> {
  // 就算请求失败（网络断了）也要把本地清掉，不能让用户"看起来还在登录"
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() })
  } catch {
    /* 忽略 */
  }
  clearAuth()
}

export function clearAuth(): void {
  token.value = null
  user.value = null
  persist()
}

/** 带鉴权与 401 处理的 fetch：onUnauthorized 由 App.vue 注册，用于弹出登录层 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers as Record<string, string> | undefined) } })
  if (res.status === 401) {
    clearAuth()
    onUnauthorized?.()
    throw new Error('登录已失效，请重新登录')
  }
  return res as unknown as T
}
