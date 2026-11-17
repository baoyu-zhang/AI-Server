<template>
  <!--
    多步骤计划面板。

    为什么单独做成组件：计划本质是"对话之外的一份共享状态"，做成独立组件后
    既能嵌在 AI 回复里（当前用法：传 plan），也能挂在侧边栏/小窗（不传 plan，
    自己从 Pinia 读 agentState.plan）——这正是 AG-UI 共享状态的设计目的。

    为什么整块 v-if 而不是内部隐藏：没有 plan 时它不该占位，
    否则每条消息里都会多出一条空白卡片。
  -->
  <div v-if="plan" class="plan-panel" :class="{ 'is-collapsed': collapsed, 'is-settled': settled }">
    <button class="plan-panel__head" type="button" @click="collapsed = !collapsed">
      <span class="plan-panel__goal">{{ plan.goal }}</span>
      <span class="plan-panel__stat">{{ doneCount }}/{{ plan.steps.length }}</span>
      <ChevronDownIcon class="plan-panel__chevron" :class="{ 'is-up': !collapsed }" />
    </button>

    <ul v-show="!collapsed" class="plan-steps">
      <li v-for="step in plan.steps" :key="step.id" class="plan-step" :class="`is-${step.status}`">
        <!-- 状态点用纯 CSS 画：不引图标库，五种状态各自一套，省得为一个小圆点加依赖 -->
        <span class="plan-step__dot" aria-hidden="true"></span>
        <span class="plan-step__title">{{ step.title }}</span>
        <code v-if="step.tool" class="plan-step__tool">{{ step.tool }}</code>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * 计划面板：只读展示一份计划，不参与任何写入。
 * 进度推进完全由服务端负责（工具执行完成 → STATE_DELTA replace /plan），
 * 前端算进度会和服务端打架，所以这里一行写状态的代码都没有。
 *
 * 两种用法：
 *   ① 传 plan（当前用法）：App.vue 把它挂在"发起 planSteps 的那条 AI 回复"内部，
 *      一份计划对应一条消息，多轮对话里各自独立、跟着消息滚；
 *   ② 不传 plan：退回读 agentState.plan（当前会话最新的那份），
 *      留给"对话之外也要看计划"的场景（侧边栏 / 独立小窗），换位置组件不用改。
 */
import { computed, ref, watch } from 'vue'
import { ChevronDownIcon } from 'tdesign-icons-vue-next'
import { useChatStore, isPlanState, type PlanState } from '../store/chat'

const props = defineProps<{
  plan?: PlanState // 不传则读 store 里当前会话的最新计划
}>()

const chatStore = useChatStore()

// agentState 是 Record<string, unknown>，不传 prop 时必须过类型守卫；
// 这里只是"没有 plan 就不占位"，判断逻辑与 App.vue 共用 store 里的同一个守卫
const plan = computed<PlanState | null>(() => {
  if (props.plan) return props.plan
  const raw = (chatStore.agentState as Record<string, unknown>).plan
  return isPlanState(raw) ? raw : null
})

const doneCount = computed(() => plan.value?.steps.filter(step => step.status === 'done').length ?? 0)

// 全部步骤都进入终态（没有 pending/running）就算"跑完了"
const settled = computed(
  () => !!plan.value && plan.value.steps.every(step => step.status !== 'pending' && step.status !== 'running')
)

const collapsed = ref(false)

// 计划一结束就自动收起：完整列表在生成过程中有用，结束后它只是在挤占阅读空间。
// 只监听"变为 true"的瞬间，用户之后手动展开不会被再次折叠。
watch(settled, value => {
  if (value) collapsed.value = true
})

// 新计划（换了目标）重新展开，否则用户会以为这一轮没有执行步骤
watch(
  () => plan.value?.goal,
  (value, old) => {
    if (value && value !== old) collapsed.value = false
  }
)
</script>

<style scoped>
.plan-panel {
  /* 位置在 AI 消息气泡内部（发起计划的那一轮），宽度跟随气泡内容区。
     间距由父级 .msg-plan 控制，这里只留底边距，避免和下面的工具步骤贴在一起。 */
  margin: 0 0 10px;
  border: 1px solid var(--td-component-border);
  border-radius: 10px;
  background: var(--td-bg-color-container);
  overflow: hidden;
}

.plan-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

.plan-panel__head:hover {
  background: var(--td-bg-color-container-hover);
}

.plan-panel__goal {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-panel__stat {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.plan-panel__chevron {
  font-size: 16px;
  color: var(--td-text-color-placeholder);
  transition: transform 0.2s ease;
}

.plan-panel__chevron.is-up {
  transform: rotate(180deg);
}

.plan-steps {
  margin: 0;
  padding: 0 12px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.plan-step__title {
  flex: 1;
  min-width: 0;
  color: var(--td-text-color-primary);
}

.plan-step__tool {
  font-family: var(--td-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--td-bg-color-container-hover);
  color: var(--td-text-color-placeholder);
}

/* 状态点：直径 10px，五种状态共用同一套定位 */
.plan-step__dot {
  position: relative;
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--td-gray-color-5);
  box-sizing: border-box;
}

.is-pending .plan-step__title {
  color: var(--td-text-color-placeholder);
}

/* 进行中：实心内点 + 呼吸动画，让"正在跑"在一屏灰字里能被一眼看到 */
.is-running .plan-step__dot {
  border-color: var(--td-brand-color);
}

.is-running .plan-step__dot::after {
  content: '';
  position: absolute;
  inset: 1.5px;
  border-radius: 50%;
  background: var(--td-brand-color);
  animation: plan-pulse 1.2s ease-in-out infinite;
}

@keyframes plan-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.6); }
}

/* 完成：实心 + 勾（用两条边框旋转 45° 画出来，比塞 SVG 省 DOM） */
.is-done .plan-step__dot {
  border-color: var(--td-success-color);
  background: var(--td-success-color);
}

.is-done .plan-step__dot::after {
  content: '';
  position: absolute;
  left: 2.5px;
  top: 0.5px;
  width: 3px;
  height: 5.5px;
  border: solid var(--td-bg-color-container);
  border-width: 0 1.2px 1.2px 0;
  transform: rotate(45deg);
}

/* 失败：红底 + 叉 */
.is-failed .plan-step__dot {
  border-color: var(--td-error-color);
  background: var(--td-error-color);
}

.is-failed .plan-step__dot::before,
.is-failed .plan-step__dot::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 3.6px;
  width: 5px;
  height: 1.2px;
  background: var(--td-bg-color-container);
}

.is-failed .plan-step__dot::before { transform: rotate(45deg); }
.is-failed .plan-step__dot::after { transform: rotate(-45deg); }

.is-failed .plan-step__title {
  color: var(--td-error-color);
}

/* 未执行：灰点 + 中间一横 + 标题删除线，明确表达"计划里有，但没做" */
.is-skipped .plan-step__dot {
  border-color: var(--td-gray-color-4);
}

.is-skipped .plan-step__dot::after {
  content: '';
  position: absolute;
  left: 1px;
  top: 3.2px;
  width: 5px;
  height: 1px;
  background: var(--td-gray-color-4);
}

.is-skipped .plan-step__title {
  color: var(--td-text-color-placeholder);
  text-decoration: line-through;
  text-decoration-color: var(--td-gray-color-4);
}

/* 收起时只留标题行，去掉内边距的视觉重量 */
.plan-panel.is-collapsed {
  opacity: 0.85;
}

@media (prefers-reduced-motion: reduce) {
  .is-running .plan-step__dot::after {
    animation: none;
  }
  .plan-panel__chevron {
    transition: none;
  }
}
</style>
