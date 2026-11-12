<template>
  <!-- 模型用量面板：总览 + 最近明细。数据只读，刷新按钮手动拉取 -->
  <div class="usage-panel">
    <div class="usage-panel__head">
      <div class="usage-panel__title">
        <ChartIcon class="usage-panel__title-icon" />
        <span>模型用量</span>
      </div>
      <t-button variant="text" shape="square" size="small" :loading="loading" title="刷新用量" @click="load">
        <RefreshIcon />
      </t-button>
    </div>

    <div class="usage-summary">
      <div class="usage-summary__item">
        <div class="usage-summary__num">{{ summary.runs }}</div>
        <div class="usage-summary__label">对话轮次</div>
      </div>
      <div class="usage-summary__item">
        <div class="usage-summary__num">{{ fmt(summary.inputTokens) }}</div>
        <div class="usage-summary__label">输入 token</div>
      </div>
      <div class="usage-summary__item">
        <div class="usage-summary__num">{{ fmt(summary.outputTokens) }}</div>
        <div class="usage-summary__label">输出 token</div>
      </div>
    </div>

    <!-- 按模型拆分：不同模型单价差好几倍，混在一起看总额会误判成本结构 -->
    <div v-if="byModel.length" class="usage-models">
      <div v-for="row in byModel" :key="row.model" class="usage-model-row">
        <span class="usage-model-row__name">{{ row.model }}</span>
        <span class="usage-model-row__stat">{{ row.runs }} 轮 · {{ fmt(row.inputTokens) }} / {{ fmt(row.outputTokens) }}</span>
      </div>
    </div>

    <div class="usage-list">
      <div v-if="loading" class="usage-empty"><t-loading size="small" /></div>
      <template v-else>
        <div v-if="!detail.length" class="usage-empty">还没有用量记录，发起一轮对话后这里会出现明细</div>
        <div v-for="row in detail" :key="row.runId" class="usage-item">
          <div class="usage-item__main">
            <div class="usage-item__model">{{ row.model }} <span class="usage-item__steps">× {{ row.steps }} 步</span></div>
            <div class="usage-item__meta">{{ fmt(row.inputTokens) }} 入 · {{ fmt(row.outputTokens) }} 出 · {{ fmtTime(row.createdAt) }}</div>
          </div>
        </div>
      </template>
    </div>

    <div class="usage-panel__foot">口径：模型服务端回报的真实 token，与本地估算值不同</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { ChartIcon, RefreshIcon } from 'tdesign-icons-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

interface UsageRow {
  runId: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  steps: number
  createdAt: number
}
interface ModelRow { model: string; runs: number; inputTokens: number; outputTokens: number }

const detail = ref<UsageRow[]>([])
const summary = ref({ runs: 0, inputTokens: 0, outputTokens: 0 })
const byModel = ref<ModelRow[]>([])
const loading = ref(false)

const fmt = (n?: number) => (n || 0).toLocaleString('zh-CN')
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/usage', { headers: authHeaders() })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) {
      clearAuth()
      throw new Error('登录已失效，请刷新页面重新登录')
    }
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
    detail.value = data.detail || []
    summary.value = data.summary?.totals || { runs: 0, inputTokens: 0, outputTokens: 0 }
    byModel.value = data.summary?.byModel || []
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ load })
</script>

<style scoped lang="scss">
.usage-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
}

.usage-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--td-comp-margin-m);
}

.usage-panel__title {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  font-size: var(--td-font-size-body-medium);
  font-weight: 600;
  color: var(--td-text-color-primary);
}

.usage-panel__title-icon {
  color: var(--td-brand-color);
}

/* 三个总览数字横排：输入/输出/轮次一眼看完 */
.usage-summary {
  display: flex;
  gap: var(--td-comp-margin-xs);
  margin-bottom: var(--td-comp-margin-m);
}

.usage-summary__item {
  flex: 1;
  padding: var(--td-comp-paddingTB-s) 0;
  text-align: center;
  border-radius: var(--td-radius-medium);
  background: var(--td-bg-color-secondarycontainer);
}

.usage-summary__num {
  font-size: var(--td-font-size-title-medium);
  font-weight: 600;
  color: var(--td-text-color-primary);
}

.usage-summary__label {
  margin-top: 2px;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}

.usage-models {
  margin-bottom: var(--td-comp-margin-m);
}

.usage-model-row {
  display: flex;
  justify-content: space-between;
  padding: var(--td-comp-paddingTB-xs) var(--td-comp-paddingLR-s);
  font-size: var(--td-font-size-body-small);
}

.usage-model-row__name {
  color: var(--td-text-color-primary);
}

.usage-model-row__stat {
  color: var(--td-text-color-placeholder);
}

.usage-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.usage-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--td-comp-paddingTB-l);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
  line-height: 1.6;
}

.usage-item {
  display: flex;
  align-items: center;
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-s);
  border-radius: var(--td-radius-medium);
  transition: background-color 0.2s;

  &:hover {
    background: var(--td-bg-color-secondarycontainer);
  }
}

.usage-item__main {
  flex: 1;
  min-width: 0;
}

.usage-item__model {
  font-size: var(--td-font-size-body-medium);
  color: var(--td-text-color-primary);
}

.usage-item__steps {
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}

.usage-item__meta {
  margin-top: 2px;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}

.usage-panel__foot {
  padding-top: var(--td-comp-paddingTB-s);
  border-top: 1px solid var(--td-component-stroke);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
  line-height: 1.5;
}
</style>
