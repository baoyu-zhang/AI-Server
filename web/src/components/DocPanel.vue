<template>
  <!-- 知识库文档栏：上传、列表、删除（外层 SidePanel 提供页签与 <aside> 语义） -->
  <div class="doc-panel">
    <div class="doc-panel__head">
      <div class="doc-panel__title">
        <FileIcon class="doc-panel__title-icon" />
        <span>知识库文档</span>
      </div>
      <t-button variant="text" shape="square" size="small" :loading="loading" title="刷新列表" @click="loadDocuments">
        <RefreshIcon />
      </t-button>
    </div>

    <!-- 上传区：先选业务类型与归属对象，再选文件；服务端靠这三个字段做过滤与去重 -->
    <div class="doc-upload">
      <div class="doc-upload__fields">
        <t-select v-model="docType" :options="docTypeOptions" size="small" :popup-props="{ attach: 'body' }" />
        <!-- 简历必须落到某个候选人身上，否则入库后无法按人隔离检索，服务端会直接 400 -->
        <t-select
          v-if="docType === 'resume'"
          v-model="candidateId"
          :options="candidateOptions"
          size="small"
          filterable
          creatable
          clearable
          placeholder="候选人标识（必填，可新建）"
          :popup-props="{ attach: 'body' }"
        />
        <!-- JD 必须落到某个岗位上；简历也允许标岗位，表示"投的是这个岗" -->
        <t-select
          v-if="docType === 'jd' || docType === 'resume'"
          v-model="jobId"
          :options="jobOptions"
          size="small"
          filterable
          creatable
          clearable
          :placeholder="docType === 'jd' ? '岗位标识（必填，可新建）' : '应聘岗位（选填）'"
          :popup-props="{ attach: 'body' }"
        />
      </div>
      <input ref="fileInputRef" type="file" accept=".md,.pdf,.docx" hidden @change="onFileChange" />
      <t-button block variant="outline" :loading="uploading" @click="pickFile">
        <template #icon><UploadIcon /></template>
        {{ uploading ? '正在入库…' : '上传文档' }}
      </t-button>
      <p class="doc-upload__tip">支持 .md / .pdf / .docx（Word），单文件不超过 10MB</p>
    </div>

    <!-- 文档列表 -->
    <div class="doc-list">
      <div v-if="loading" class="doc-list__empty">
        <t-loading size="small" />
      </div>
      <template v-else>
        <div v-if="!documents.length" class="doc-list__empty">暂无文档，上传后即可检索</div>
        <div v-for="doc in documents" :key="doc.fileName" class="doc-item">
          <div class="doc-item__main">
            <div class="doc-item__name" :title="doc.fileName">{{ doc.fileName }}</div>
            <div class="doc-item__meta">
              {{ doc.chunkCount }} 个片段
              <!-- 业务标签：排查"为什么搜不到这个人"时，第一眼看的就是这里有没有 candidateId -->
              <span v-if="doc.docType" class="doc-item__tag">{{ docTypeLabel(doc.docType) }}</span>
              <span v-if="doc.candidateId" class="doc-item__tag is-biz">{{ doc.candidateId }}</span>
              <span v-if="doc.jobId" class="doc-item__tag is-biz">{{ doc.jobId }}</span>
            </div>
          </div>
          <t-popconfirm
            theme="danger"
            content="删除后该文档将无法被检索，确认删除？"
            @confirm="removeDocument(doc)"
          >
            <t-button
              variant="text"
              theme="danger"
              shape="square"
              size="small"
              :loading="deleting === doc.fileName"
              title="删除文档"
            >
              <DeleteIcon />
            </t-button>
          </t-popconfirm>
        </div>
      </template>
    </div>

    <div class="doc-panel__foot">共 {{ documents.length }} 篇 · {{ totalChunks }} 个片段</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { DeleteIcon, FileIcon, RefreshIcon, UploadIcon } from 'tdesign-icons-vue-next'
import { authHeaders, clearAuth } from '../api/auth'

// 文档条目：后端按 fileName 聚合后的结果，业务标签可能为空（历史语料没有）
interface DocItem {
  fileName: string
  fileId?: string // 新版本后端会回传文件 id；旧缓存/老语料可能没有，删文档时要能回落
  chunkCount: number
  createdAt?: number
  docType?: string
  jobId?: string
  candidateId?: string
}

// 上传后通知外层刷新候选人面板
const emit = defineEmits<{ changed: [] }>()

const documents = ref<DocItem[]>([])
const loading = ref(false)
const uploading = ref(false)
const deleting = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

// ========== 上传时的业务标签 ==========
// 为什么这三个字段放在上传前而不是上传后补：metadata 只在入库那一刻写进去，
// 补标签要删了重传。字段少、语义清楚，前置填一次成本最低。
type DocType = 'resume' | 'jd' | 'policy' | 'other'
const docType = ref<DocType>('resume')
const candidateId = ref('')
const jobId = ref('')
const candidateOptions = ref<{ label: string; value: string }[]>([])
const jobOptions = ref<{ label: string; value: string }[]>([])

const DOC_TYPE_LABELS: Record<string, string> = { resume: '简历', jd: '岗位JD', policy: '制度', other: '其他' }
const docTypeOptions = [
  { label: '简历', value: 'resume' },
  { label: '岗位 JD', value: 'jd' },
  { label: '公司制度 / 规范', value: 'policy' },
  { label: '其他文档', value: 'other' }
]
const docTypeLabel = (type?: string) => (type ? DOC_TYPE_LABELS[type] || type : '')

const totalChunks = computed(() => documents.value.reduce((sum, doc) => sum + doc.chunkCount, 0))

// 统一请求封装：带鉴权 header；非 2xx 时抛出后端返回的错误文案
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

// 拉取文档列表
async function loadDocuments() {
  loading.value = true
  try {
    const data = await request<{ data: DocItem[] }>('/api/documents')
    documents.value = data.data || []
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

// 拉取候选人 / 岗位候选：让"给谁传简历"选得出来，而不是逼用户背 id
async function loadOptions() {
  try {
    const [candidateRes, jobRes] = await Promise.all([
      request<{ data: { candidateId: string; name: string }[] }>('/api/candidates'),
      request<{ data: { jobId: string }[] }>('/api/jobs')
    ])
    candidateOptions.value = (candidateRes.data || []).map(item => ({
      label: `${item.name}（${item.candidateId}）`,
      value: item.candidateId
    }))
    jobOptions.value = (jobRes.data || []).map(item => ({
      label: item.jobId,
      value: item.jobId
    }))
  } catch (err) {
    // 选项拉不到不阻塞上传：仍然可以手输 id
    console.warn('加载候选人 / 岗位选项失败', err)
  }
}

// 点上传前先校验必填项：省掉一次"传完才 400"的往返，也避免 uploads 目录留下临时文件
function pickFile() {
  if (docType.value === 'resume' && !candidateId.value.trim()) {
    MessagePlugin.warning('简历必须指定候选人标识')
    return
  }
  if (docType.value === 'jd' && !jobId.value.trim()) {
    MessagePlugin.warning('岗位 JD 必须指定岗位标识')
    return
  }
  fileInputRef.value?.click()
}

// 上传流程：服务端一次完成「解析 → 切块 → 入库」，前端只发一次请求
// 同名文件的处理交给服务端：同一候选人重传=覆盖，不同候选人=自动另存 -2
async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = '' // 清空选择，允许再次上传同一个文件
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    form.append('docType', docType.value)
    if (candidateId.value.trim()) form.append('candidateId', candidateId.value.trim())
    if (jobId.value.trim()) form.append('jobId', jobId.value.trim())
    const saved = await request<{ filename: string; chunkCount: number; msg: string; renamed?: boolean }>(
      '/api/upload-doc',
      { method: 'POST', body: form }
    )
    const tip = `《${saved.filename}》${saved.msg || `入库成功，共 ${saved.chunkCount} 个片段`}`
    // 改名说明库里已有别的候选人的同名文件，得让人知道，否则会以为覆盖了旧文件
    if (saved.renamed) MessagePlugin.warning(`${tip}（同名文件属于其他对象，已另存）`)
    else MessagePlugin.success(tip)
    await Promise.all([loadDocuments(), loadOptions()])
    emit('changed')
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    uploading.value = false
  }
}

// 删除文档：优先用 fileId 精确定位（同名文件归不同候选人时不会误删），
// 老数据没有 fileId 时回落到 fileName，保证只认文件名的旧后端也照常工作
async function removeDocument(doc: DocItem) {
  deleting.value = doc.fileName
  try {
    const payload = doc.fileId ? { fileId: doc.fileId } : { fileName: doc.fileName }
    const data = await request<{ removed: number }>('/api/documents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    documents.value = documents.value.filter(item => item.fileName !== doc.fileName)
    MessagePlugin.success(`已删除《${doc.fileName}》，移除 ${data.removed} 个片段`)
    // 删掉的可能是候选人唯一的简历，选项要跟着变
    void loadOptions()
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    deleting.value = ''
  }
}

onMounted(() => {
  void loadDocuments()
  void loadOptions()
})
defineExpose({ loadDocuments, loadOptions })
</script>

<style scoped lang="scss">
.doc-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
}

.doc-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--td-comp-margin-m);
}

.doc-panel__title {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s);
  font-size: var(--td-font-size-body-medium);
  font-weight: 600;
  color: var(--td-text-color-primary);
}

.doc-panel__title-icon {
  color: var(--td-brand-color);
}

.doc-upload {
  margin-bottom: var(--td-comp-margin-l);
}

/* 三个选择器竖排：左侧栏只有 280px，横排会把占位文案挤成省略号 */
.doc-upload__fields {
  display: flex;
  flex-direction: column;
  gap: var(--td-comp-margin-xs);
  margin-bottom: var(--td-comp-margin-s);
}

.doc-upload__tip {
  margin-top: var(--td-comp-margin-xs);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  line-height: 1.5;
}

.doc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.doc-list__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--td-comp-paddingTB-l);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
  line-height: 1.6;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-xs);
  padding: var(--td-comp-paddingTB-s) var(--td-comp-paddingLR-s);
  border-radius: var(--td-radius-medium);
  transition: background-color 0.2s;

  &:hover {
    background: var(--td-bg-color-secondarycontainer);
  }
}

.doc-item__main {
  flex: 1;
  min-width: 0;
}

.doc-item__name {
  font-size: var(--td-font-size-body-medium);
  color: var(--td-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-item__meta {
  margin-top: 2px;
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
}

/* 业务标签用极小的胶囊，和"几个片段"同一行，不额外占高度 */
.doc-item__tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: var(--td-radius-small);
  background: var(--td-bg-color-secondarycontainer);
  color: var(--td-text-color-secondary);
  line-height: 16px;
}

.doc-item__tag.is-biz {
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
}

.doc-panel__foot {
  padding-top: var(--td-comp-paddingTB-s);
  border-top: 1px solid var(--td-component-stroke);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
}
</style>
