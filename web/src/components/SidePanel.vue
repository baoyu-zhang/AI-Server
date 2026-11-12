<template>
  <!--
    左侧栏容器：文档 / 候选人 / 用量 / 密钥 / 通知 / 记忆 / 账号 / 管理 页签。
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
      <!-- 「记忆」「账号」属于个人设置，排在业务功能之后、管理员页签之前。
           两者都在对话过程中可能被别处改动（AI 自动记新事实 / 改密踢下线），
           因此和用量页一样走 onTabChange 切页刷新，value 用独一无二的字符串 -->
      <t-tab-panel value="memory" label="记忆">
        <MemoryPanel ref="memoryRef" />
      </t-tab-panel>
      <t-tab-panel value="account" label="账号">
        <!-- 退出登录要改的是整个 App 的登录态，本面板只 emit，交给上层原样转发 -->
        <AccountPanel ref="accountRef" @logout="forwardLogout" />
      </t-tab-panel>
      <!-- 管理页签只在 admin 登录时出现：前端隐藏是体验优化，
           真正防线在服务端 requireAdmin（普通用户 curl 也会 403） -->
      <t-tab-panel v-if="isAdmin" value="admin" label="管理">
        <AdminPanel ref="adminRef" />
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
import MemoryPanel from './MemoryPanel.vue'
import AccountPanel from './AccountPanel.vue'
import AdminPanel from './AdminPanel.vue'
import { computed } from 'vue'
import { currentUser } from '../api/auth'

// 候选人面板里的"评估 / 改状态"不自己发请求，而是让上层往对话里发一句话——
// 这样改状态仍然走 interrupt 审批，不会出现"界面上点一下就把人淘汰了"的旁路。
// logout 同理：账号面板不持有 App 的登录态，只把意图冒泡给 App.vue 统一处理。
const emit = defineEmits<{ ask: [text: string]; logout: [] }>()

// tab 的取值必须与上面每个 t-tab-panel 的 value 对应，且互不重复
const tab = ref<'docs' | 'candidates' | 'usage' | 'keys' | 'webhooks' | 'memory' | 'account' | 'admin'>('docs')
const docRef = ref<InstanceType<typeof DocPanel> | null>(null)
const candRef = ref<InstanceType<typeof CandidatePanel> | null>(null)
const usageRef = ref<InstanceType<typeof UsagePanel> | null>(null)
const keyRef = ref<InstanceType<typeof KeyPanel> | null>(null)
const whRef = ref<InstanceType<typeof WebhookPanel> | null>(null)
const memoryRef = ref<InstanceType<typeof MemoryPanel> | null>(null)
const accountRef = ref<InstanceType<typeof AccountPanel> | null>(null)
const adminRef = ref<InstanceType<typeof AdminPanel> | null>(null)

// 当前登录用户是否管理员：role 字段来自登录响应/旧缓存（缺省 undefined 按 non-admin）
const isAdmin = computed(() => currentUser.value?.role === 'admin')

// 上传/删除文档后候选人会变（简历入库即登记），顺手刷新候选人页
function onDocsChanged() {
  void candRef.value?.load()
}

/** 把候选人面板的意图原样交给上层（上层会把它当成用户消息发出去） */
function forwardAsk(text: string) {
  emit('ask', text)
}

/** 把账号面板的退出意图原样交给 App.vue（那里才有 authed 与引擎消息的清理逻辑） */
function forwardLogout() {
  emit('logout')
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
  // 记忆是 AI 在对话里自动追加的，切过来必须重拉，否则看不到刚被记住的事实
  if (value === 'memory') void memoryRef.value?.load()
  // 账号页没有列表数据，但保持与其它页签一致的刷新接口（load 内为空实现）
  if (value === 'account') void accountRef.value?.load()
  // 管理页：数据随时会被其他用户改变，每次切入都重新拉
  if (value === 'admin') void adminRef.value?.load()
}

// 暴露给 App.vue / 其它调用方：既有文档、候选人，也补齐新加的两个页签的刷新入口
defineExpose({
  loadDocuments: () => docRef.value?.loadDocuments(),
  loadCandidates: () => candRef.value?.load(),
  loadMemory: () => memoryRef.value?.load(),
  loadAccount: () => accountRef.value?.load()
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
