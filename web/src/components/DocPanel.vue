<template>
  <!-- 左侧知识库文档栏：上传、列表、删除 -->
  <aside class="doc-panel">
    <div class="doc-panel__head">
      <div class="doc-panel__title">
        <FileIcon class="doc-panel__title-icon" />
        <span>知识库文档</span>
      </div>
      <t-button variant="text" shape="square" size="small" :loading="loading" title="刷新列表" @click="loadDocuments">
        <RefreshIcon />
      </t-button>
    </div>

    <!-- 上传区：选择文件后先解析切块，再向量化入库 -->
    <div class="doc-upload">
      <input ref="fileInputRef" type="file" accept=".md,.pdf" hidden @change="onFileChange" />
      <t-button block variant="outline" :loading="uploading" @click="fileInputRef?.click()">
        <template #icon><UploadIcon /></template>
        {{ uploading ? '正在入库…' : '上传文档' }}
      </t-button>
      <p class="doc-upload__tip">支持 .md / .pdf，单文件不超过 10MB</p>
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
            <div class="doc-item__meta">{{ doc.chunkCount }} 个片段</div>
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
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import { DeleteIcon, FileIcon, RefreshIcon, UploadIcon } from 'tdesign-icons-vue-next'

// 文档条目：后端按 fileName 聚合后的结果
interface DocItem {
  fileName: string
  chunkCount: number
  createdAt?: number
}

const documents = ref<DocItem[]>([])
const loading = ref(false)
const uploading = ref(false)
const deleting = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

const totalChunks = computed(() => documents.value.reduce((sum, doc) => sum + doc.chunkCount, 0))

// 统一请求封装：非 2xx 时抛出后端返回的错误文案
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
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

// 上传流程：服务端一次完成「解析 → 切块 → 入库」，前端只发一次请求（同名文档由后端覆盖）
async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = '' // 清空选择，允许再次上传同一个文件
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    const saved = await request<{ filename: string; chunkCount: number; msg: string }>(
      '/api/upload-doc',
      { method: 'POST', body: form }
    )
    MessagePlugin.success(`《${saved.filename}》${saved.msg || `入库成功，共 ${saved.chunkCount} 个片段`}`)
    await loadDocuments()
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    uploading.value = false
  }
}

// 删除文档：按文件名移除全部片段
async function removeDocument(doc: DocItem) {
  deleting.value = doc.fileName
  try {
    const data = await request<{ removed: number }>('/api/documents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: doc.fileName })
    })
    documents.value = documents.value.filter(item => item.fileName !== doc.fileName)
    MessagePlugin.success(`已删除《${doc.fileName}》，移除 ${data.removed} 个片段`)
  } catch (err) {
    MessagePlugin.error((err as Error).message)
  } finally {
    deleting.value = ''
  }
}

onMounted(loadDocuments)
defineExpose({ loadDocuments })
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

.doc-panel__foot {
  padding-top: var(--td-comp-paddingTB-s);
  border-top: 1px solid var(--td-component-stroke);
  font-size: var(--td-font-size-body-small);
  color: var(--td-text-color-placeholder);
  text-align: center;
}
</style>
