<template>
  <!-- 候选人面板：知识库里有简历的人 + 状态 + 最近评分 -->
  <div class="cand-panel">
    <div class="cand-panel__head">
      <div class="cand-panel__title">
        <UserIcon class="cand-panel__title-icon" />
        <span>候选人</span>
        <span class="cand-panel__count">{{ candidates.length }}</span>
      </div>
      <t-button variant="text" shape="square" size="small" :loading="loading" title="刷新列表" @click="load">
        <RefreshIcon />
      </t-button>
    </div>

    <!-- 按状态筛选：状态是这张表唯一值得天天用的筛选维度 -->
    <div class="cand-filter">
      <t-select v-model="statusFilter" :options="statusFilterOptions" size="small" :popup-props="{ attach: 'body' }" />
    </div>

    <div class="cand-list">
      <div v-if="loading" class="cand-empty"><t-loading size="small" /></div>
      <template v-else>
        <div v-if="!visibleCandidates.length" class="cand-empty">
          {{ candidates.length ? '该状态下没有候选人' : '还没有候选人，先在「文档」页上传简历并填写候选人标识' }}
        </div>
        <div v-for="item in visibleCandidates" :key="item.candidateId" class="cand-card">
          <!-- 第一行：姓名 + 状态。状态用颜色区分，扫一眼就知道谁卡在哪一步 -->
          <button type="button" class="cand-card__top" @click="toggle(item.candidateId)">
            <span class="cand-card__name" :title="item.name">{{ item.name }}</span>
            <t-tag size="small" variant="light" :theme="statusTheme(item.status)">{{ item.status }}</t-tag>
          </button>

          <!-- 第二行：id 与岗位。id 要露出来，因为对话里让 AI 操作时用的就是这个值 -->
          <div class="cand-card__meta">
            <code class="cand-card__id">{{ item.candidateId }}</code>
            <span v-if="item.jobId" class="cand-card__job">@{{ item.jobId }}</span>
            <span v-else class="cand-card__job is-empty">未指定岗位</span>
          </div>

          <!-- 第三行：最近一次评分。null 与 0 必须区分开，0 分是"评过了很差" -->
          <div class="cand-card__score">
            <template v-if="item.lastScore !== null && item.lastScore !== undefined">
              <span class="cand-card__num" :class="scoreClass(item.lastScore)">{{ item.lastScore }}</span>
              <span class="cand-card__verdict">{{ item.lastVerdict || '已评分' }}</span>
            </template>
            <span v-else class="cand-card__verdict is-empty">未评分</span>
          </div>

          <!-- 展开：只放排查用的信息，不再堆操作 -->
          <div v-if="expandedId === item.candidateId" class="cand-card__detail">
            <div class="cand-card__detail-row"><span>简历</span><span :title="item.fileName">{{ item.fileName || '—' }}</span></div>
            <div class="cand-card__detail-row"><span>片段</span><span>{{ item.chunkCount }} 段</span></div>
            <div class="cand-card__detail-row"><span>更新</span><span>{{ formatTime(item.updatedAt) }}</span></div>
          </div>

          <!-- 操作走对话：改状态要经过审批中断，直接在面板里改等于绕开了确认环节 -->
          <div class="cand-card__actions">
            <t-button size="small" variant="outline" :disabled="busy" @click="askScore(item)">评估匹配度</t-button>
            <t-dropdown
              :options="statusActions"
              trigger="click"
              :disabled="busy"
              @click="onStatusAction(item, $event)"
            >
              <t-button size="small" variant="outline" :disabled="busy">改状态</t-button>
            </t-dropdown>
          </div>
        </div>
      </template>
    </div>

    <div class="cand-panel__foot">共 {{ candidates.length }} 人 · 评分与状态由对话中的工具写入</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { RefreshIcon, UserIcon } from 'tdesign-icons-vue-next'

// 候选人记录：来自 GET /api/candidates（向量库"谁有简历" + JSON 表"状态与分数"合并）
interface CandidateItem {
  candidateId: string
  name: string
  jobId?: string
  status: string
  lastScore?: number | null
  lastVerdict?: string
  fileName?: string
  chunkCount?: number
  updatedAt?: number
}

interface DropdownOption {
  value: string
  content?: string
}

// 操作交给对话去执行：面板只负责"发起意图"，真正改状态要经过审批中断
const emit = defineEmits<{ ask: [text: string] }>()

const candidates = ref<CandidateItem[]>([])
const loading = ref(false)
const busy = ref(false)
const expandedId = ref('')
const statusFilter = ref('')
const statusFilterOptions = ref<{ label: string; value: string }[]>([{ label: '全部状态', value: '' }])

const STATUS_ACTIONS = ['待筛选', '初筛通过', '待面试', '已面试', '已发offer', '已淘汰']
const statusActions: DropdownOption[] = STATUS_ACTIONS.map(item => ({ value: item, content: item }))

// 状态 -> TDesign 主题色。颜色只是辅助，文案本身已经能读，别让色盲用户只能靠颜色判断
const STATUS_THEME: Record<string, 'default' | 'primary' | 'warning' | 'success' | 'danger'> = {
  待筛选: 'default',
  初筛通过: 'primary',
  待面试: 'warning',
  已面试: 'success',
  已发offer: 'success',
  已淘汰: 'danger',
  待登记: 'default'
}
const statusTheme = (status: string) => STATUS_THEME[status] || 'default'

// 分数颜色沿用项目里的中式习惯：高分"好看"用品牌绿，低分用红
const scoreClass = (score: number) => (score >= 75 ? 'is-good' : score >= 60 ? 'is-mid' : 'is-bad')

const visibleCandidates = computed(() =>
  statusFilter.value ? candidates.value.filter(item => item.status === statusFilter.value) : candidates.value
)

function toggle(candidateId: string) {
  expandedId.value = expandedId.value === candidateId ? '' : candidateId
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/candidates')
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
    candidates.value = data.data || []
    // 状态下拉的服务端权威列表也一并带回来了，前端不再写死一份
    if (Array.isArray(data.statuses) && data.statuses.length) {
      statusFilterOptions.value = [{ label: '全部状态', value: '' }, ...data.statuses.map((item: string) => ({ label: item, value: item }))]
    }
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

// 发起一轮对话让 AI 去调工具。为什么不在面板里直接 POST 改状态：
// 改状态有副作用，必须经过 interrupt 让人确认；面板里直接改等于把审批环节删掉了。
function ask(text: string) {
  busy.value = true
  emit('ask', text)
  // 请求是异步的，面板这里只做一个短暂的防连点
  setTimeout(() => { busy.value = false }, 1500)
}

function askScore(item: CandidateItem) {
  if (!item.jobId) {
    MessagePlugin.warning('这位候选人还没有关联岗位，请先上传对应岗位的 JD')
    return
  }
  ask(`请评估候选人 ${item.candidateId} 对岗位 ${item.jobId} 的匹配度`)
}

// 下拉项被点击：TDesign 的 event 类型没有导出成稳定名字，这里按结构取 value 即可
function onStatusAction(item: CandidateItem, data: unknown) {
  const status = String((data as DropdownOption)?.value || '')
  if (!status) return
  ask(`把候选人 ${item.candidateId} 的状态改成「${status}」`)
}

onMounted(load)
defineExpose({ load })
</script>

<style scoped lang="scss">
.cand-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
}

.cand-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--td-comp-margin-m);
}

.cand-panel__title {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  font-size: var(--td-font-size-body-medium);
  font-weight: 600;
  color: var(--td-text-color-primary);
}

.cand-panel__title-icon {
  color: var(--td-brand-color);
}

.cand-panel__count {
  padding: 0 6px;
  border-radius: 10px;
  background: var(--td-bg-color-secondarycontainer);
  color: var(--td-text-color-secondary);
  font-size: var(--td-font-size-body-small);
  font-weight: 400;
}

.cand-filter {
  margin-bottom: var(--td-comp-margin-s);
}

.cand-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.cand-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--td-comp-paddingTB-l);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
  line-height: 1.6;
}

/* 卡片而不是表格：280px 放不下 4 列，硬塞只会全是省略号 */
.cand-card {
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-s);
  margin-bottom: var(--td-comp-margin-xs);
  border: 1px solid var(--td-component-stroke);
  border-radius: var(--td-radius-medium);
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--td-brand-color-light);
  }
}

.cand-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--td-comp-margin-xs);
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
}

.cand-card__name {
  flex: 1;
  min-width: 0;
  font-size: var(--td-font-size-body-medium);
  color: var(--td-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cand-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}

.cand-card__id {
  font-family: var(--td-font-family-mono, monospace);
}

.cand-card__job.is-empty,
.cand-card__verdict.is-empty {
  color: var(--td-text-color-placeholder);
}

.cand-card__score {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
}

.cand-card__num {
  font-size: 18px;
  font-weight: 600;
  line-height: 1;

  &.is-good { color: var(--td-success-color); }
  &.is-mid { color: var(--td-warning-color); }
  &.is-bad { color: var(--td-error-color); }
}

.cand-card__verdict {
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-secondary);
}

.cand-card__detail {
  margin-top: var(--td-comp-margin-xs);
  padding-top: var(--td-comp-margin-xs);
  border-top: 1px dashed var(--td-component-stroke);
}

.cand-card__detail-row {
  display: flex;
  justify-content: space-between;
  gap: var(--td-comp-margin-s);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-secondary);
  line-height: 1.7;

  span:last-child {
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.cand-card__actions {
  display: flex;
  gap: var(--td-comp-margin-xs);
  margin-top: var(--td-comp-margin-s);
}

.cand-panel__foot {
  padding-top: var(--td-comp-paddingTB-s);
  border-top: 1px solid var(--td-component-stroke);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
}
</style>
