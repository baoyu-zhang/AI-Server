<template>
  <!--
    左侧栏容器：文档 / 候选人两个页签。
    为什么合并到一个侧栏而不是加第三列：268px 里放一张四列表格必然全是省略号，
    而候选人信息量其实很小（姓名、状态、分数），按卡片排更合适，也省下横向空间给聊天区。
  -->
  <aside class="side-panel">
    <t-tabs v-model="tab" size="medium" @change="onTabChange">
      <t-tab-panel value="docs" label="文档">
        <DocPanel ref="docRef" @changed="onDocsChanged" />
      </t-tab-panel>
      <t-tab-panel value="candidates" label="候选人">
        <CandidatePanel ref="candRef" @ask="forwardAsk" />
      </t-tab-panel>
      <t-tab-panel value="usage" label="用量">
        <UsagePanel ref="usageRef" />
      </t-tab-panel>
      <t-tab-panel value="keys" label="密钥">
        <KeyPanel ref="keyRef" />
      </t-tab-panel>
      <t-tab-panel value="webhooks" label="通知">
        <WebhookPanel ref="whRef" />
      </t-tab-panel>
    </t-tabs>
  </aside>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import DocPanel from './DocPanel.vue'
import CandidatePanel from './CandidatePanel.vue'
import UsagePanel from './UsagePanel.vue'
import KeyPanel from './KeyPanel.vue'
import WebhookPanel from './WebhookPanel.vue'

// 候选人面板里的"评估 / 改状态"不自己发请求，而是让上层往对话里发一句话——
// 这样改状态仍然走 interrupt 审批，不会出现"界面上点一下就把人淘汰了"的旁路。
const emit = defineEmits<{ ask: [text: string] }>()

const tab = ref<'docs' | 'candidates' | 'usage' | 'keys' | 'webhooks'>('docs')
const docRef = ref<InstanceType<typeof DocPanel> | null>(null)
const candRef = ref<InstanceType<typeof CandidatePanel> | null>(null)
const usageRef = ref<InstanceType<typeof UsagePanel> | null>(null)
const keyRef = ref<InstanceType<typeof KeyPanel> | null>(null)
const whRef = ref<InstanceType<typeof WebhookPanel> | null>(null)

// 上传/删除文档后候选人会变（简历入库即登记），顺手刷新候选人页
function onDocsChanged() {
  void candRef.value?.load()
}

/** 把候选人面板的意图原样交给上层（上层会把它当成用户消息发出去） */
function forwardAsk(text: string) {
  emit('ask', text)
}

function onTabChange(value: string | number) {
  // 切到候选人页时重新拉一次：分数与状态是对话里改的，面板不知道自己已经过期
  if (value === 'candidates') void candRef.value?.load()
  // 用量也是对话期间持续增长的数据，切过来时刷新
  if (value === 'usage') void usageRef.value?.load()
  // 密钥列表不在对话里变动，但为了防"两处页面改了状态"，切过来也刷一次
  if (value === 'keys') void keyRef.value?.load()
  // Webhook 列表同理
  if (value === 'webhooks') void whRef.value?.load()
}

defineExpose({
  loadDocuments: () => docRef.value?.loadDocuments(),
  loadCandidates: () => candRef.value?.load()
})
</script>

<style scoped lang="scss">
.side-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--td-bg-color-container);
  box-sizing: border-box;

  /* TDesign 的 tabs 默认按内容高度排，这里要让它撑满整栏，否则文档列表没有滚动区 */
  :deep(.t-tabs) {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  :deep(.t-tabs__nav) {
    padding: 0 12px;
    flex: none;
  }

  :deep(.t-tabs__content) {
    flex: 1;
    min-height: 0;
  }

  :deep(.t-tab-panel) {
    height: 100%;
  }
}
</style>
