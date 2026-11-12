<!--
  WebhookPanel.vue —— Webhook 通知管理页签
  职责：注册接收地址（secret 只显示一次）、查看订阅列表、删除。
  和 KeyPanel 是同一套交互范式：敏感凭证明文只出现一次，列表只展示安全字段。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

// 统一请求封装（与 DocPanel/KeyPanel 同一套约定）：带鉴权；401 清登录态；非 2xx 抛后端文案
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

/** 列表行结构：对应 GET /api/webhooks 返回（脱敏后不含 secret） */
interface WebhookRow {
  id: string
  url: string
  events: string // 后端存的是 JSON 数组字符串，展示时再 parse
  createdAt: number
  disabledAt: number | null
}

const rows = ref<WebhookRow[]>([]) // 列表数据
const events = ref<string[]>([]) // 服务端支持的事件白名单：复选框选项由它驱动，前端不硬编码
const loading = ref(false)

// ===== 注册表单状态 =====
const newUrl = ref('') // 接收地址
const checkedEvents = ref<string[]>([]) // 勾选的订阅事件
const creating = ref(false)
// 注册成功返回的 secret：只展示一次，关弹层即丢弃
const freshSecret = ref('')
const freshWebhookUrl = ref('') // 弹层里同时回显注册的地址，方便核对

function fmt(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

/** 拉列表 + 事件白名单（一次接口两个用途，省一次请求） */
async function load() {
  loading.value = true
  try {
    const res = await request<{ data: WebhookRow[]; events: string[] }>('/api/webhooks')
    rows.value = res.data ?? []
    events.value = res.events ?? []
  } catch (e: any) {
    MessagePlugin.error(e?.message || '加载 Webhook 列表失败')
  } finally {
    loading.value = false
  }
}

/** 注册：勾选的事件列表 + URL 发给后端，secret 只在响应里出现一次 */
async function createWebhook() {
  if (creating.value) return
  if (!checkedEvents.value.length) {
    MessagePlugin.warning('至少勾选一个要订阅的事件')
    return
  }
  creating.value = true
  try {
    const res = await request<{ id: string; url: string; secret: string }>('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: newUrl.value.trim(), events: checkedEvents.value })
    })
    freshSecret.value = res.secret
    freshWebhookUrl.value = res.url
    newUrl.value = ''
    checkedEvents.value = []
    MessagePlugin.success('Webhook 已注册，请立即保存签名密钥')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '注册失败')
  } finally {
    creating.value = false
  }
}

async function remove(row: WebhookRow) {
  if (!confirm(`删除「${row.url}」？删除后该地址不再收到任何通知。`)) return
  try {
    await request(`/api/webhooks/${row.id}/delete`, { method: 'POST' })
    MessagePlugin.success('已删除')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '删除失败')
  }
}

function closeFreshSecret() {
  if (confirm('确认已保存好签名密钥？关闭后将无法再次查看。')) freshSecret.value = ''
}

/** 复制 secret 到剪贴板。模板里不能直接用 navigator（不在 Vue 模板全局白名单），包成方法 */
async function copySecret() {
  try {
    await navigator.clipboard.writeText(freshSecret.value)
    MessagePlugin.success('已复制')
  } catch {
    MessagePlugin.warning('复制失败，请手动选中复制')
  }
}

onMounted(load)

defineExpose({ load })
</script>

<template>
  <div class="wh-panel">
    <!-- 注册表单：地址 + 事件勾选。事件列表来自服务端白名单，服务端加新事件前端自动出现 -->
    <div class="wh-panel__form">
      <t-input v-model="newUrl" placeholder="接收地址 https://…" clearable @enter="createWebhook" />
      <t-checkbox-group v-model="checkedEvents" class="wh-panel__events">
        <t-checkbox v-for="ev in events" :key="ev" :value="ev" :label="ev" />
      </t-checkbox-group>
      <t-button theme="primary" :loading="creating" @click="createWebhook">注册</t-button>
    </div>

    <t-alert theme="info" class="wh-panel__tip">
      <template #message>
        事件触发时服务端会 POST JSON 到该地址，请求头 X-Signature 携带 HMAC-SHA256 签名
        （密钥 = 注册时保存的 secret），接收方据此校验请求真实性。投递失败会记入审计，不自动重试。
      </template>
    </t-alert>

    <t-table :data="rows" :loading="loading" row-key="id" size="small" :bordered="false">
      <template #empty><span class="wh-panel__empty">还没有 Webhook，注册一个接收地址</span></template>
      <t-column col-key="url" title="接收地址">
        <template #cell="{ row }"><span class="wh-panel__url" :title="row.url">{{ row.url }}</span></template>
      </t-column>
      <t-column col-key="events" title="订阅事件" :width="200">
        <template #cell="{ row }">
          <!-- 后端存 JSON 字符串，展示时解析；解析失败兜底显示原文，不让一个脏数据炸掉整页 -->
          {{ (() => { try { return (JSON.parse(row.events) as string[]).join('、') } catch { return row.events } })() }}
        </template>
      </t-column>
      <t-column col-key="createdAt" title="注册时间" :width="170">
        <template #cell="{ row }">{{ fmt(row.createdAt) }}</template>
      </t-column>
      <t-column col-key="op" title="操作" :width="70">
        <template #cell="{ row }">
          <t-popconfirm content="删除后不再收到通知，确认？" @confirm="remove(row)">
            <t-link theme="danger" hover="color">删除</t-link>
          </t-popconfirm>
        </template>
      </t-column>
    </t-table>

    <!-- secret 展示弹层：唯一一次 -->
    <t-dialog :visible="!!freshSecret" header="请立即保存签名密钥" :footer="false" width="520px" :close-on-overlay-click="false">
      <p class="wh-panel__warn">接收方用这个 secret 校验 X-Signature 头。关闭后无法找回，只能删除重建。</p>
      <div class="wh-panel__key">
        <code>{{ freshSecret }}</code>
        <t-button size="small" variant="outline" @click="copySecret">复制</t-button>
      </div>
      <p class="wh-panel__addr">接收地址：{{ freshWebhookUrl }}</p>
      <t-button theme="primary" block @click="closeFreshSecret">我已保存好</t-button>
    </t-dialog>
  </div>
</template>

<style scoped>
.wh-panel__form {
  display: flex;
  flex-direction: column;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-m);
}
.wh-panel__events {
  display: flex;
  gap: var(--td-comp-margin-l);
}
.wh-panel__tip {
  margin-bottom: var(--td-comp-margin-m);
}
.wh-panel__url {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
.wh-panel__empty {
  color: var(--td-text-color-placeholder);
  font-size: var(--td-font-size-body-small);
}
.wh-panel__warn {
  color: var(--td-warning-color);
  font-size: var(--td-font-size-body-medium);
  margin: 0 0 var(--td-comp-margin-m);
}
.wh-panel__key {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  margin-bottom: var(--td-comp-margin-m);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  background: var(--td-bg-color-secondarycontainer);
  border-radius: var(--td-radius-medium);
  word-break: break-all;
}
.wh-panel__key code {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
}
.wh-panel__addr {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin: 0 0 var(--td-comp-margin-m);
  word-break: break-all;
}
</style>
