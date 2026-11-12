<!--
  AdminPanel.vue —— 管理员页签（RBAC）
  仅当 currentUser.role === 'admin' 时由 SidePanel 渲染这个页签。
  三块内容：用户列表（含每人用量）、全局用量、全局审计。
  注意：前端隐藏只是体验优化，真正的防线在服务端 requireAdmin 中间件——
  普通用户直接 curl /api/admin/* 会得到 403，改前端代码绕不过去。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { authHeaders, clearAuth, currentUser } from '../api/auth'

// 统一请求封装（与 DocPanel/KeyPanel 同一套约定）
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options?.headers as Record<string, string> | undefined) } })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    clearAuth()
    throw new Error('登录已失效，请刷新页面重新登录')
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`)
  return data as T
}

/** 用户列表行：服务端 LEFT JOIN model_usage 聚合好的数据 */
interface AdminUserRow {
  id: string
  username: string
  role: string
  createdAt: number
  quotaDaily: number // 每日 token 配额（0 表示不限），仅展示，不改
  runs: number // 总轮次（没有用量的用户为 0，LEFT JOIN 保证不丢行）
  totalTokens: number
  disabled: boolean // 是否被停用：PATCH /status 改的就是这个字段
}

/** 全局审计行：比个人审计多 userId 字段（admin 视角要知道是谁） */
interface AdminAuditRow {
  id: number
  userId: string | null
  actor: string | null
  action: string
  target: string | null
  detail: string | null
  ip: string | null
  createdAt: number
}

const users = ref<AdminUserRow[]>([])
const usageTotals = ref<{ runs: number; inputTokens: number; outputTokens: number; totalTokens: number } | null>(null)
const usageByModel = ref<{ model: string; runs: number; inputTokens: number; outputTokens: number }[]>([])
const audits = ref<AdminAuditRow[]>([])
const loading = ref(false)

function fmt(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** 审计 detail 是 JSON 字符串：能解析就格式化，不能就原样显示（脏数据不炸页面） */
function detailText(raw: string | null): string {
  if (!raw) return '—'
  try {
    const obj = JSON.parse(raw)
    return Object.keys(obj).length ? JSON.stringify(obj) : '(空)'
  } catch {
    return raw
  }
}

/** 拉三块数据。一次 Promise.all 并发，任一失败整页报错（admin 页面数据小，全量重拉最简单） */
async function load() {
  loading.value = true
  try {
    const [usersRes, usageRes, auditRes] = await Promise.all([
      request<{ data: AdminUserRow[] }>('/api/admin/users'),
      request<{ totals: typeof usageTotals.value; byModel: typeof usageByModel.value }>('/api/admin/usage'),
      request<{ data: AdminAuditRow[] }>('/api/admin/audit?limit=30')
    ])
    users.value = usersRes.data ?? []
    usageTotals.value = usageRes.totals
    usageByModel.value = usageRes.byModel ?? []
    audits.value = auditRes.data ?? []
  } catch (e: any) {
    MessagePlugin.error(e?.message || '加载管理数据失败')
  } finally {
    loading.value = false
  }
}

/**
 * 是否当前登录用户本人。服务端本来就拒绝「停用自己的账号」（返回 403），
 * 前端先用 currentUser.userId 把按钮禁掉：省掉一次注定失败的请求，更避免管理员手滑把自己锁在外面。
 */
function isSelf(row: AdminUserRow): boolean {
  return Boolean(currentUser.value && currentUser.value.userId === row.id)
}

/**
 * 停用 / 启用一个用户。确认环节由模板里的 t-popconfirm 承担（状态变更影响别人能否登录，先问一句）。
 * 成功后重拉整页：列表里的 disabled 状态以服务端为准，不靠本地改一个字段假装成功。
 */
async function toggleStatus(row: AdminUserRow) {
  if (isSelf(row)) return // 双保险：即便绕过禁用态也不对自己发 PATCH
  const disabled = !row.disabled // 当前停用 → 改成启用；当前正常 → 改成停用
  try {
    await request(`/api/admin/users/${encodeURIComponent(row.id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled })
    })
    MessagePlugin.success(disabled ? '已停用该用户' : '已启用该用户')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '操作失败')
  }
}

onMounted(load)

defineExpose({ load })
</script>

<template>
  <div class="admin-panel">
    <!-- 块一：用户列表（含角色标签与用量） -->
    <h4 class="admin-panel__title">用户（{{ users.length }}）</h4>
    <t-table :data="users" :loading="loading" row-key="id" size="small" :bordered="false">
      <t-column col-key="username" title="用户名" :width="120" />
      <t-column col-key="role" title="角色" :width="80">
        <template #cell="{ row }">
          <t-tag :theme="row.role === 'admin' ? 'danger' : 'default'" variant="light">
            {{ row.role === 'admin' ? '管理员' : '用户' }}
          </t-tag>
        </template>
      </t-column>
      <t-column col-key="createdAt" title="注册时间" :width="160">
        <template #cell="{ row }">{{ fmt(row.createdAt) }}</template>
      </t-column>
      <t-column col-key="runs" title="对话轮次" :width="90" align="right" />
      <t-column col-key="totalTokens" title="累计 token" :width="110" align="right" />
      <!-- 状态列：一眼看出谁被停用了，避免只靠操作按钮的文字猜当前状态 -->
      <t-column col-key="disabled" title="状态" :width="80">
        <template #cell="{ row }">
          <t-tag :theme="row.disabled ? 'danger' : 'success'" variant="light">
            {{ row.disabled ? '已停用' : '正常' }}
          </t-tag>
        </template>
      </t-column>
      <!-- 操作列：停用/启用前二次确认；本人那行按钮禁用，且不弹确认 -->
      <t-column col-key="op" title="操作" :width="80">
        <template #cell="{ row }">
          <t-popconfirm
            :content="row.disabled ? '确认启用该用户？' : '停用后该用户将无法登录和调用接口，确认停用？'"
            theme="danger"
            @confirm="toggleStatus(row)"
          >
            <t-link
              :theme="row.disabled ? 'primary' : 'danger'"
              hover="color"
              :disabled="isSelf(row)"
            >{{ isSelf(row) ? '本人' : row.disabled ? '启用' : '停用' }}</t-link>
          </t-popconfirm>
        </template>
      </t-column>
    </t-table>

    <!-- 块二：全局用量（总账 + 按模型拆分） -->
    <h4 class="admin-panel__title">全局用量</h4>
    <div v-if="usageTotals" class="admin-panel__stats">
      <div class="admin-panel__stat"><span class="admin-panel__num">{{ usageTotals.runs }}</span>轮</div>
      <div class="admin-panel__stat"><span class="admin-panel__num">{{ usageTotals.inputTokens.toLocaleString() }}</span>输入 token</div>
      <div class="admin-panel__stat"><span class="admin-panel__num">{{ usageTotals.outputTokens.toLocaleString() }}</span>输出 token</div>
    </div>
    <t-table :data="usageByModel" row-key="model" size="small" :bordered="false">
      <t-column col-key="model" title="模型" :width="180" />
      <t-column col-key="runs" title="轮次" :width="80" align="right" />
      <t-column col-key="inputTokens" title="输入" :width="110" align="right" />
      <t-column col-key="outputTokens" title="输出" :width="110" align="right" />
    </t-table>

    <!-- 块三：全局审计（最近 30 条，含全部用户） -->
    <h4 class="admin-panel__title">全局审计（最近 {{ audits.length }} 条）</h4>
    <t-table :data="audits" :loading="loading" row-key="id" size="small" :bordered="false" max-height="260">
      <t-column col-key="createdAt" title="时间" :width="160">
        <template #cell="{ row }">{{ fmt(row.createdAt) }}</template>
      </t-column>
      <t-column col-key="actor" title="操作者" :width="100">
        <template #cell="{ row }">{{ row.actor || '（匿名）' }}</template>
      </t-column>
      <t-column col-key="action" title="动作" :width="180" />
      <t-column col-key="detail" title="详情">
        <template #cell="{ row }">
          <span class="admin-panel__detail" :title="detailText(row.detail)">{{ detailText(row.detail) }}</span>
        </template>
      </t-column>
    </t-table>
  </div>
</template>

<style scoped>
.admin-panel__title {
  margin: var(--td-comp-margin-l) 0 var(--td-comp-margin-s);
  font-size: var(--td-font-size-title-small);
  color: var(--td-text-color-primary);
}
.admin-panel__title:first-child {
  margin-top: 0;
}
.admin-panel__stats {
  display: flex;
  gap: var(--td-comp-margin-xl);
  margin-bottom: var(--td-comp-margin-s);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  background: var(--td-bg-color-secondarycontainer);
  border-radius: var(--td-radius-medium);
}
.admin-panel__num {
  font-size: var(--td-font-size-title-medium);
  font-weight: 600;
  margin-right: 4px;
  color: var(--td-brand-color);
}
.admin-panel__detail {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
</style>
