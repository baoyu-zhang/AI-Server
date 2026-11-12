<!--
  KeyPanel.vue —— API Key 管理页签
  职责：签发新 Key（明文只显示一次）、列出已有 Key（脱敏）、吊销。
  设计要点：
  - 签发成功后明文只存在这一个弹层里，关掉就再也拿不到了——所以 UI 上要"防手滑"：
    复制按钮 + 关闭前二次确认。
  - 列表永远只显示 keyPrefix（前 12 位），用户能认出哪把是哪把，但泄露不了完整凭证。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

// 统一请求封装（与 DocPanel 同一套约定）：带鉴权 header；401 清登录态；非 2xx 抛后端错误文案
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options?.headers as Record<string, string> | undefined) } })
  const data = await res.json().catch(() => ({})) // 空响应体也按 {} 处理，不让 json 解析炸掉
  if (res.status === 401) {
    clearAuth()
    throw new Error('登录已失效，请刷新页面重新登录')
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`)
  return data as T
}

/** 列表行结构：与后端 GET /api/keys 返回字段一一对应 */
interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string // 前 12 位（sk- + 8 位随机），认 key 用
  createdAt: number
  lastUsedAt: number | null // null = 签发后从没用过
  revokedAt: number | null // null = 仍有效
}

const rows = ref<ApiKeyRow[]>([]) // 列表数据
const loading = ref(false) // 列表加载中

// ===== 签发表单状态 =====
const newName = ref('') // 新 key 的备注名
const creating = ref(false) // 防连点
// 签发成功的明文 key：只在这里展示一次，关弹层后置空丢弃
const freshKey = ref('')

// 时间戳 → 本地可读时间；空值显示占位符而不是 'Invalid Date'
function fmt(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

/** 拉列表。签发/吊销后都重拉一次，保证 UI 与库里一致 */
async function load() {
  loading.value = true
  try {
    const res = await request<{ data: ApiKeyRow[] }>('/api/keys', { method: 'GET' })
    rows.value = res.data ?? []
  } catch (e: any) {
    MessagePlugin.error(e?.message || '加载密钥列表失败')
  } finally {
    loading.value = false
  }
}

/** 签发：成功后弹层展示明文（唯一一次），并刷新列表 */
async function createKey() {
  if (creating.value) return
  creating.value = true
  try {
    const res = await request<{ key: string; record: ApiKeyRow }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: newName.value.trim() })
    })
    freshKey.value = res.key // 明文只此一次
    newName.value = '' // 清空输入框，防止用户以为还能再看
    MessagePlugin.success('密钥已签发，请立即保存')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '签发失败')
  } finally {
    creating.value = false
  }
}

/** 复制明文到剪贴板。navigator.clipboard 在非 https/localhost 下可能不可用，降级用 execCommand */
async function copyFreshKey() {
  try {
    await navigator.clipboard.writeText(freshKey.value)
    MessagePlugin.success('已复制')
  } catch {
    MessagePlugin.warning('复制失败，请手动选中复制')
  }
}

/** 关闭明文弹层前二次确认：明文关了就永远找不回 */
function closeFreshKey() {
  if (confirm('确认已保存好密钥？关闭后将无法再次查看明文。')) {
    freshKey.value = ''
  }
}

/** 吊销：立即生效不可恢复，浏览器 confirm 兜一道 */
async function revoke(row: ApiKeyRow) {
  if (!confirm(`确认吊销「${row.name || row.keyPrefix}」？立即生效，无法恢复。`)) return
  try {
    await request(`/api/keys/${row.id}/revoke`, { method: 'POST' })
    MessagePlugin.success('已吊销')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '吊销失败')
  }
}

onMounted(load) // 页签首次打开时拉一次

// 暴露 load 给父组件：SidePanel 切到这个页签时调一次，保证数据新鲜
defineExpose({ load })
</script>

<template>
  <div class="key-panel">
    <!-- 签发表单：一行输入 + 一个按钮，够用了 -->
    <div class="key-panel__create">
      <t-input v-model="newName" placeholder="备注名（如：curl 脚本）" clearable @enter="createKey" />
      <t-button theme="primary" :loading="creating" @click="createKey">签发新密钥</t-button>
    </div>

    <t-alert theme="info" class="key-panel__tip">
      <template #message>
        明文密钥只在签发时显示一次，请立即保存。密钥可用于 OpenAI 兼容接口（/v1/chat/completions）
        与本站全部 API，请勿写入公开仓库。
      </template>
    </t-alert>

    <!-- 列表：时间列直接格式化，状态列用标签区分有效/已吊销/未使用 -->
    <t-table :data="rows" :loading="loading" row-key="id" size="small" :bordered="false">
      <template #empty><span class="key-panel__empty">还没有密钥，先签发一把</span></template>
      <t-column col-key="name" title="备注" :width="140">
        <template #cell="{ row }">{{ row.name || '（未命名）' }}</template>
      </t-column>
      <t-column col-key="keyPrefix" title="密钥前缀" :width="150">
        <template #cell="{ row }"><code class="key-panel__prefix">{{ row.keyPrefix }}…</code></template>
      </t-column>
      <t-column col-key="createdAt" title="创建时间" :width="170">
        <template #cell="{ row }">{{ fmt(row.createdAt) }}</template>
      </t-column>
      <t-column col-key="lastUsedAt" title="最近使用" :width="170">
        <template #cell="{ row }">{{ fmt(row.lastUsedAt) }}</template>
      </t-column>
      <t-column col-key="revokedAt" title="状态" :width="100">
        <template #cell="{ row }">
          <t-tag v-if="row.revokedAt" theme="danger" variant="light">已吊销</t-tag>
          <t-tag v-else-if="!row.lastUsedAt" theme="warning" variant="light">未使用</t-tag>
          <t-tag v-else theme="success" variant="light">使用中</t-tag>
        </template>
      </t-column>
      <t-column col-key="op" title="操作" :width="90">
        <template #cell="{ row }">
          <t-popconfirm content="立即失效且无法恢复，确认吊销？" @confirm="revoke(row)">
            <t-link theme="danger" hover="color" :disabled="!!row.revokedAt">吊销</t-link>
          </t-popconfirm>
        </template>
      </t-column>
    </t-table>

    <!-- 明文展示弹层：签发成功后唯一能拿到完整 key 的地方 -->
    <t-dialog :visible="!!freshKey" header="请立即保存密钥" :footer="false" width="520px" :close-on-overlay-click="false">
      <p class="key-panel__warn">这是唯一一次展示完整密钥，关闭后无法找回。请复制保存到安全的地方。</p>
      <div class="key-panel__key">
        <code>{{ freshKey }}</code>
        <t-button size="small" variant="outline" @click="copyFreshKey">复制</t-button>
      </div>
      <t-button theme="primary" block @click="closeFreshKey">我已保存好</t-button>
    </t-dialog>
  </div>
</template>

<style scoped>
.key-panel__create {
  display: flex;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-m);
}
.key-panel__tip {
  margin-bottom: var(--td-comp-margin-m);
}
.key-panel__prefix {
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
.key-panel__empty {
  color: var(--td-text-color-placeholder);
  font-size: var(--td-font-size-body-small);
}
.key-panel__warn {
  color: var(--td-warning-color);
  font-size: var(--td-font-size-body-medium);
  margin: 0 0 var(--td-comp-margin-m);
}
.key-panel__key {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-m);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  background: var(--td-bg-color-secondarycontainer);
  border-radius: var(--td-radius-medium);
  word-break: break-all;
}
.key-panel__key code {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
}
</style>
