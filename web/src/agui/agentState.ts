/**
 * AG-UI 共享状态（shared state）维护模块。
 *
 * 协议约定：
 * - STATE_SNAPSHOT：服务端下发全量状态，客户端整体替换；
 * - STATE_DELTA：服务端下发 JSON Patch 增量，客户端合并；
 * - 下一次 RunAgentInput 的 `state` 必须回传客户端当前持有的状态。
 */

export type AgentState = Record<string, unknown>

export type StateOp =
  | { op: 'add'; path: string; value?: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value?: unknown }
  | { op: 'move'; path: string; from: string }
  | { op: 'copy'; path: string; from: string }
  | { op: 'append'; path: string; value?: string }

type Container = Record<string, unknown> | unknown[]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深拷贝纯 JSON 数据（eventBus 载荷本身就是纯数据，不含函数/循环引用） */
export function cloneAgentState(state: AgentState): AgentState {
  return JSON.parse(JSON.stringify(state ?? {})) as AgentState
}

/** STATE_SNAPSHOT：整体替换，非对象一律当作空状态 */
export function applyStateSnapshot(snapshot: unknown): AgentState {
  return isPlainObject(snapshot) ? cloneAgentState(snapshot) : {}
}

// /a/b/c → ['a','b','c']，并按 JSON Pointer 规则还原 ~1 → / 、~0 → ~
function parsePath(path: string): string[] {
  if (!path.startsWith('/')) return []
  return path
    .slice(1)
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function readValue(root: AgentState, segments: string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isPlainObject(current)) current = current[segment]
    else return undefined
  }
  return current
}

// 定位到父容器；路径不存在时返回 undefined
function findParent(root: AgentState, segments: string[]): { parent: Container; key: string } | undefined {
  const parent = segments.length === 1 ? root : readValue(root, segments.slice(0, -1))
  if (!Array.isArray(parent) && !isPlainObject(parent)) return undefined
  return { parent, key: segments[segments.length - 1] }
}

function writeValue(container: Container, key: string, value: unknown, insert = false) {
  if (Array.isArray(container)) {
    if (key === '-') container.push(value)
    else if (insert) container.splice(Number(key), 0, value)
    else container[Number(key)] = value
    return
  }
  container[key] = value
}

function removeValue(container: Container, key: string) {
  if (Array.isArray(container)) container.splice(Number(key), 1)
  else delete container[key]
}

function applyOp(root: AgentState, op: StateOp): void {
  if (op.op === 'move' || op.op === 'copy') {
    const fromSegments = parsePath(op.from)
    const value = readValue(root, fromSegments)
    const fromParent = findParent(root, fromSegments)
    if (fromParent) removeValue(fromParent.parent, fromParent.key)
    const target = findParent(root, parsePath(op.path))
    if (target) writeValue(target.parent, target.key, value)
    return
  }

  const segments = parsePath(op.path)
  const target = findParent(root, segments)
  if (!target) return

  if (op.op === 'add') writeValue(target.parent, target.key, op.value, true)
  else if (op.op === 'replace' || op.op === 'append') {
    const current = readValue(target.parent as unknown as AgentState, [target.key])
    const next = op.op === 'append' ? `${current ?? ''}${op.value ?? ''}` : op.value
    writeValue(target.parent, target.key, next)
  } else if (op.op === 'remove') removeValue(target.parent, target.key)
}

/** STATE_DELTA：按顺序应用 JSON Patch，返回新状态（不改动传入对象） */
export function applyStateDelta(state: AgentState, ops: StateOp[]): AgentState {
  const next = cloneAgentState(state)
  for (const op of ops ?? []) {
    if (!op?.path) continue
    applyOp(next, op)
  }
  return next
}
