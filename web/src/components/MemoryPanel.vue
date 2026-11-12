<!--
  MemoryPanel.vue —— 「记忆」页签
  为什么需要这个页面：AI 会在对话里主动记住关于用户的事实（偏好、身份、约定），
  这些记忆会悄悄影响之后的回答。用户必须能看见「模型眼里的自己」并能随时删掉，
  否则既无法纠正记错的内容，也谈不上对个人数据的控制权（个保法要求可查可删）。
  记忆存在服务端 memory 表，和聊天记录是两套数据，所以单独开一个页签而不是塞进会话列表。

  实现口径与 DocPanel/KeyPanel 完全一致：只用 authHeaders() + 原生 fetch，
  不引入 axios 等新依赖；每个面板各自持有一份极薄的 request 封装，401 清登录态、非 2xx 抛后端文案。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { DeleteIcon, RefreshIcon } from 'tdesign-icons-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

// 统一请求封装：手写 fetch 套鉴权 header；401 时清掉本地登录态；
// 非 2xx 优先抛后端返回的 error 文案（例如「记忆不存在」），否则用状态码兜底
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers as Record<string, string> | undefined) }
  })
  // 404 等错误响应体可能不是 JSON，解析失败按空对象处理，不让 json() 抛错盖掉真正的状态判断
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    clearAuth()
    throw new Error('登录已失效，请刷新页面重新登录')
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`)
  return data as T
}

/** 记忆条目：与后端 GET /api/memory 返回的 data[] 字段一一对应 */
interface MemoryItem {
  id: string // 删除时拼进 URL 的主键
  content: string // AI 记下的事实原文
  createdAt: number // 记录时间（毫秒时间戳）
}

const items = ref<MemoryItem[]>([]) // 记忆列表
const loading = ref(false) // 列表加载中（首次进入 / 删除后刷新）
const deletingId = ref('') // 正在删除的条目 id：给按钮转圈，并防止连点发出多份 DELETE

/** 时间戳 → 本地可读时间；后端偶尔给 0/空值时显示占位符而不是 Invalid Date */
function fmt(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

/**
 * 拉取记忆列表。
 * 暴露给 SidePanel：每次切到「记忆」页签都会调一次，保证别处新增/删除后数据是最新的
 */
async function load() {
  loading.value = true
  try {
    const res = await request<{ ok: boolean; data: MemoryItem[] }>('/api/memory')
    items.value = res.data ?? []
  } catch (e: any) {
    MessagePlugin.error(e?.message || '加载记忆失败')
  } finally {
    loading.value = false
  }
}

/**
 * 删除单条记忆：确认环节放在模板的 t-popconfirm 里（删除不可恢复，先问一句）。
 * 成功后重新 load() 而不是本地过滤——以服务端结果为准，避免「界面删了库里还在」的错觉。
 */
async function remove(item: MemoryItem) {
  if (deletingId.value) return
  deletingId.value = item.id
  try {
    // 主键可能含特殊字符，encodeURIComponent 后再拼路径，避免把 id 当成路径分隔符
    await request(`/api/memory/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    MessagePlugin.success('已删除该条记忆')
    await load()
  } catch (e: any) {
    MessagePlugin.error(e?.message || '删除记忆失败')
  } finally {
    deletingId.value = ''
  }
}

onMounted(load) // 页签首次渲染时拉一次
defineExpose({ load }) // 供 SidePanel.onTabChange 切页刷新
</script>

<template>
  <div class="memory-panel">
    <!-- 说明卡：讲清「这些数据从哪来」，让用户明白不是自己填的、也不是聊天记录，
         同时告知删除的后果（立即不再影响后续对话），避免对着一堆凭空出现的句子发懵 -->
    <t-alert theme="info" class="memory-panel__tip">
      <template #message>
        这是 AI 在对话中记住的关于你的事实（偏好、身份、约定等），用于让后续回答更贴合你。
        记忆由 AI 自动记录，可随时删除；删除后立即生效，不会再影响之后的对话。
      </template>
    </t-alert>

    <div class="memory-panel__head">
      <span class="memory-panel__title">我的记忆（{{ items.length }}）</span>
      <t-button variant="text" shape="square" size="small" :loading="loading" title="刷新列表" @click="load">
        <RefreshIcon />
      </t-button>
    </div>

    <!-- 三态：加载中 / 空 / 列表。空态文案按产品要求固定为「还没有记住任何信息」 -->
    <div v-if="loading" class="memory-panel__empty"><t-loading size="small" /></div>
    <div v-else-if="!items.length" class="memory-panel__empty">还没有记住任何信息</div>
    <div v-else class="memory-panel__list">
      <div v-for="item in items" :key="item.id" class="memory-item">
        <!-- 正文用 pre-wrap 保留换行：AI 记下的可能是一小段话而不是一句 -->
        <div class="memory-item__content">{{ item.content }}</div>
        <div class="memory-item__foot">
          <span class="memory-item__time">{{ fmt(item.createdAt) }}</span>
          <t-popconfirm content="删除后这条记忆不会再影响之后的对话，确认删除？" theme="danger" @confirm="remove(item)">
            <t-button variant="text" theme="danger" size="small" :loading="deletingId === item.id" :disabled="!!deletingId">
              <DeleteIcon /><span class="memory-item__del-text">删除</span>
            </t-button>
          </t-popconfirm>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
}
.memory-panel__tip {
  margin-bottom: var(--td-comp-margin-m);
}
.memory-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--td-comp-margin-s);
}
.memory-panel__title {
  font-size: var(--td-font-size-body-medium);
  font-weight: 600;
  color: var(--td-text-color-primary);
}
.memory-panel__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--td-comp-paddingTB-l);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
}
.memory-panel__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.memory-item {
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-m);
  margin-bottom: var(--td-comp-margin-s);
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium);
}
.memory-item__content {
  font-size: var(--td-font-size-body-medium);
  color: var(--td-text-color-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--td-comp-margin-xs);
}
.memory-item__time {
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}
.memory-item__del-text {
  margin-left: 2px;
}
</style>
