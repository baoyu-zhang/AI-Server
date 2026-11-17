<!--
  BarChart.vue —— 生成式 UI 的第一个「可以被模型请求的组件」。

  它跟普通业务组件的唯一区别：props 一定是 spec.ts 校验过的干净数据，
  所以内部不做任何判空/容错（校验层已经处理），只负责画。
  样式全部走 TDesign 的 CSS 变量，浅色/深色主题自动跟随，不写死颜色。

  布局要点（踩过的坑）：
  柱子的 height 用百分比，但百分比需要一个"高度确定的定位父级"才有意义。
  所以每列拆成两段：上面是绘图区（position:relative + flex:1），下面是标签区（固定 22px）。
  柱子绝对定位在绘图区底部，height:X% 才可靠；value 标签和柱子在同一个定位上下文里，
  用 bottom: X% 跟着柱顶走，就不会和柱子打架。
-->
<template>
  <div class="bar-chart">
    <div class="bar-chart__title">
      {{ title }}
      <span v-if="unit" class="bar-chart__unit">（{{ unit }}）</span>
    </div>

    <div class="bar-chart__plot">
      <!-- 背景网格：3 条横线，纯装饰，让高度差异更好读 -->
      <div class="bar-chart__grid" aria-hidden="true">
        <i v-for="n in 3" :key="n" />
      </div>

      <div class="bar-chart__bars">
        <div v-for="(item, index) in data" :key="`${item.label}-${index}`" class="bar-chart__col">
          <div class="bar-chart__area">
            <!-- 数值跟着柱顶走：柱高是相对值，不标数字容易被误读成"占比" -->
            <span class="bar-chart__value" :style="{ bottom: `calc(${heightPercent(item.value)}% + 4px)` }">
              {{ formatValue(item.value) }}
            </span>
            <div class="bar-chart__bar" :style="{ height: `${heightPercent(item.value)}%` }" />
          </div>
          <span class="bar-chart__label" :title="item.label">{{ item.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BarChartProps } from './spec'

const props = defineProps<BarChartProps>()

// 以绝对值最大的那一项为 100%：柱状图只需要比例关系，不需要真实坐标轴。
// 负数按绝对值画（简化处理）：真正的零基线要画上下两段，收益不大，先不做。
const maxAbs = computed(() => {
  let max = 0
  for (const item of props.data) max = Math.max(max, Math.abs(item.value))
  return max
})

// 最小 2%：数值为 0 时柱子会完全消失，看起来像"没画出来"，留一条细线更诚实
function heightPercent(value: number): number {
  if (maxAbs.value <= 0) return 2
  return Math.max(2, Math.round((Math.abs(value) / maxAbs.value) * 100))
}

// 大数字压缩显示，否则 1234567 会把柱子挤没
function formatValue(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
</script>

<style scoped>
.bar-chart {
  margin: 8px 0 4px;
  padding: 10px 12px 8px;
  border: 1px solid var(--td-component-stroke, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  background: var(--td-bg-color-container, transparent);
}

.bar-chart__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary, #000);
  margin-bottom: 12px;
}

.bar-chart__unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--td-text-color-placeholder, rgba(0, 0, 0, 0.4));
}

.bar-chart__plot {
  position: relative;
  height: 160px;
}

/* 网格线铺满绘图区（扣掉底部标签区），压在最底层 */
.bar-chart__grid {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.bar-chart__grid i {
  display: block;
  height: 1px;
  background: var(--td-component-stroke, rgba(0, 0, 0, 0.06));
}

.bar-chart__bars {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 10px;
  height: 100%;
}

.bar-chart__col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 绘图区：高度由 flex 撑开，是柱子的百分比定位基准 */
.bar-chart__area {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.bar-chart__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0 auto;
  width: 100%;
  max-width: 46px;
  border-radius: 4px 4px 0 0;
  background: var(--td-brand-color, #0052d9);
  transition: height 0.24s ease;
}

.bar-chart__value {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 11px;
  line-height: 1.2;
  color: var(--td-text-color-secondary, rgba(0, 0, 0, 0.6));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bar-chart__label {
  flex: 0 0 22px;
  font-size: 11px;
  line-height: 22px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--td-text-color-placeholder, rgba(0, 0, 0, 0.4));
}
</style>
