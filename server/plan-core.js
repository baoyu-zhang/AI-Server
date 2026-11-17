/**
 * 多步骤计划（plan）的状态机：纯函数，无副作用、不依赖服务。
 *
 * 为什么单独成模块（而不是留在 index.js）：
 *   plan 是本轮踩坑最集中的一块——自引用 planSteps、旁支工具误推进、无工具正文被误判 skipped。
 *   这三个 bug 都是"看代码觉得对、跑起来才发现错"的类型，必须能被离线 golden set 反复回归。
 *   留在 index.js 里没法独立 require（一 require 就会启动服务），所以抽成单一事实源：
 *   index.js 从这里引入，评测脚本也从这里引入，保证"跑的代码"和"测的代码"是同一份。
 *
 * 协议背景：STEP_STARTED / STEP_FINISHED 的语义是"第 N 轮 LLM 调用开始/结束"，
 * 不是"第 2 步查天气完成"。用户想看到的是后者，所以在共享 state 里维护这份 plan，
 * 由工具执行事件驱动推进。下发时用整数组 replace /plan（理由见 index.js 对应注释）。
 */

/**
 * 把模型声明的步骤转成可下发的计划对象。
 * 第 1 步直接置 running：模型声明完计划就要开始执行，前端不该看到一个全灰的列表。
 */
function buildPlan(goal, steps) {
  return {
    goal,
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`,
      title: step.title,
      // 空字符串而不是 undefined：JSON 里字段缺失会让前端判断变啰嗦。
      // 顺手挡掉一种真实出现过的幻觉：模型把"排布行程"这一步的 tool 填成 planSteps 自己。
      // 不挡的话，这一步永远等不到匹配的工具执行，最后会被判成 skipped。
      tool: step.tool && step.tool !== 'planSteps' ? step.tool : '',
      status: index === 0 ? 'running' : 'pending'
    }))
  }
}

/**
 * 一次工具执行结束后推进计划。
 *
 * 规则（刻意做窄，避免"计划自己乱跳"）：
 *   - 只推进当前处于 running 的那一步；
 *   - 该步声明了 tool 时，只有同名工具执行完才推进——否则 renderChart 这类旁支工具
 *     也会把流程往前顶一格；
 *   - 该步没声明 tool 时（纯思考/纯整理步骤），任何工具执行完都推进，作为兜底。
 *
 * @returns 新计划；不需要推进时返回 null（调用方据此决定是否下发 STATE_DELTA）
 */
function advancePlan(plan, toolName, failed = false) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null
  const index = plan.steps.findIndex(step => step.status === 'running')
  if (index < 0) return null
  const current = plan.steps[index]
  if (current.tool && current.tool !== toolName) return null

  const steps = plan.steps.map((step, i) =>
    i === index ? { ...step, status: failed ? 'failed' : 'done' } : step
  )
  // 失败时不再启动下一步：流程停在这里，让用户看到"卡在哪一步"，而不是假装继续
  if (!failed) {
    const nextIndex = steps.findIndex(step => step.status === 'pending')
    if (nextIndex >= 0) steps[nextIndex] = { ...steps[nextIndex], status: 'running' }
  }
  return { ...plan, steps }
}

/**
 * run 正常结束时的收尾：给还没进入终态的步骤下一个结论。
 *
 * 这里最容易搞错的是"没调工具"不等于"没做"。实测跑「杭州三日游」时，
 * 模型最后两步（排布行程、输出行程表）本来就不调任何工具，而是在正文里直接写，
 * 当时一律标 skipped，结果界面上显示"计划了 4 步，实际只做了 2 步"——
 * 但正文里明明有完整的 Day 1~3 行程。误判比不做更糟，用户会以为功能坏了。
 *
 * 所以按步骤性质分开判：
 *   - 声明了 tool（该调工具却没调）→ skipped，这是真的没执行；
 *   - 没声明 tool（纯写作/整理步骤）→ 模型产出了正文就算 done，否则 skipped。
 *
 * @param hasText 本轮是否产出过非空正文（由调用方从 runMessages 判断）
 */
function settlePlan(plan, hasText) {
  if (!plan || !Array.isArray(plan.steps)) return null
  let changed = false
  const steps = plan.steps.map(step => {
    if (step.status !== 'pending' && step.status !== 'running') return step
    changed = true
    const finished = !step.tool && hasText
    return { ...step, status: finished ? 'done' : 'skipped' }
  })
  return changed ? { ...plan, steps } : null
}

module.exports = { buildPlan, advancePlan, settlePlan }
