/**
 * 应用行为 Golden Set 评测脚本（纯离线：不调模型、不联网）。
 *
 * 和 run-eval.js 的分工：
 *   run-eval.js       → 测检索层（问题能不能召回到正确的文档片段），指标是 hit@K / MRR；
 *   run-behavior.js   → 测业务逻辑层（图片挂哪、计划怎么推进、工具怎么降级），指标是通过率。
 * 两份 golden set 加起来，就是面试里说的"我给 RAG 应用建了评测集"的实物证据。
 *
 * 为什么这层必须是确定性的（不调模型）：
 *   本轮踩的坑——历史图误挂、纯文本误判视觉、计划自引用、旁支工具乱推进、有正文被判 skipped——
 *   全是"输入确定、输出也应该确定"的逻辑。用模型去测它们只会引入随机性，反而测不出回归。
 *   把它们固化成毫秒级可跑的断言，改一行代码立刻知道有没有弄坏老功能。
 *
 * 用法：
 *   node eval/run-behavior.js                  # 用默认 tag=latest
 *   node eval/run-behavior.js baseline         # 存为 eval/results/behavior-baseline.json
 */

const fs = require('fs')
const path = require('path')

const golden = require('./behavior-golden.json')
const {
  countImageParts, countLastUserImages, planImageMount, attachImagesToLastUserMessage
} = require('../chat-core')
const { buildPlan, advancePlan, settlePlan } = require('../plan-core')

const RESULTS_DIR = path.join(__dirname, 'results')

// fn 名 → 真实函数。只允许白名单里的函数被调用，防止数据集里写任意表达式。
const FN_MAP = {
  countImageParts,
  countLastUserImages,
  planImageMount,
  attachImagesToLastUserMessage,
  buildPlan,
  advancePlan,
  settlePlan
}

/** 取命令行 tag（第一个不以 - 开头的参数） */
function getTag() {
  const arg = process.argv.slice(2).find(a => !a.startsWith('-'))
  return arg || 'latest'
}

/** 按点号路径从对象取值：'steps.0.status' → obj.steps[0].status；'' → 整个对象 */
function getPath(obj, pathStr) {
  if (!pathStr) return obj
  return pathStr.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj)
}

/** 中文字宽 2，终端表格对齐用 */
function pad(text, width) {
  const str = String(text)
  const w = [...str].reduce((n, ch) => n + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, width - w))
}

/**
 * 单个 expect 算子校验。返回 { ok, detail }。
 * 把每个算子的"实际值"都放进 detail，失败时能一眼看出差在哪。
 */
function applyOp(actual, op, want) {
  switch (op) {
    case 'eq': return { ok: actual === want, detail: `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(want)}` }
    case 'deepEq': {
      const ok = JSON.stringify(actual) === JSON.stringify(want)
      return { ok, detail: `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(want)}` }
    }
    case 'contains': {
      const ok = Array.isArray(actual) ? actual.includes(want) : String(actual ?? '').includes(want)
      return { ok, detail: `实际 ${JSON.stringify(actual)} 是否含 ${JSON.stringify(want)}` }
    }
    case 'match': {
      let ok = false
      try { ok = new RegExp(want).test(String(actual ?? '')) } catch { ok = false }
      return { ok, detail: `实际 ${JSON.stringify(actual)} 是否匹配 /${want}/` }
    }
    case 'type': return { ok: typeof actual === want, detail: `实际类型 ${typeof actual} / 期望 ${want}` }
    case 'gt': return { ok: typeof actual === 'number' && actual > want, detail: `实际 ${actual} > ${want}?` }
    case 'len': {
      const len = actual == null ? -1 : (typeof actual.length === 'number' ? actual.length : -1)
      return { ok: len === want, detail: `实际长度 ${len} / 期望 ${want}` }
    }
    default: return { ok: false, detail: `未知算子 ${op}` }
  }
}

/** 跑一条用例：函数不存在/抛错都算失败，但不会中断整批 */
function runCase(item) {
  const fn = FN_MAP[item.fn]
  if (typeof fn !== 'function') {
    return { ok: false, error: `未知函数 ${item.fn}`, expectResults: [] }
  }
  let actual
  try {
    actual = fn(...item.input)
  } catch (err) {
    return { ok: false, error: `函数抛错：${err.message}`, expectResults: [] }
  }
  const expectResults = []
  for (const [p, rule] of Object.entries(item.expect || {})) {
    const got = getPath(actual, p)
    // rule 形如 { eq: 0 } / { contains: 'x' }：取第一个键作为算子
    const [op] = Object.keys(rule)
    const r = applyOp(got, op, rule[op])
    r.path = p || '(返回值)'
    r.op = op
    expectResults.push(r)
  }
  const ok = expectResults.length > 0 && expectResults.every(r => r.ok)
  return { ok, actual, expectResults }
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(0)}%` : '0%'
}

function main() {
  const tag = getTag()
  const cases = golden.cases || []
  console.log(`\n应用行为 Golden Set：${golden._meta?.name || ''} v${golden._meta?.version || ''}`)
  console.log(`用例 ${cases.length} 条（纯离线，不调模型）。tag=${tag}`)
  console.log('-'.repeat(92))
  console.log(['ID', '分组', '结果', '用例名'].map((h, i) => i === 3 ? h : pad(h, [9, 14, 8][i])).join(''))

  const results = []
  for (const item of cases) {
    const r = runCase(item)
    const row = {
      id: item.id, group: item.group, name: item.name, fn: item.fn,
      ok: r.ok, error: r.error || null,
      expectResults: r.expectResults.map(x => ({ path: x.path, op: x.op, ok: x.ok, detail: x.detail }))
    }
    results.push(row)
    console.log([
      pad(item.id, 9),
      pad(item.group, 14),
      pad(r.ok ? '✓ 通过' : '✗ 失败', 8),
      item.name
    ].join(''))
    if (!r.ok) {
      if (r.error) console.log(`         ${r.error}`)
      for (const x of row.expectResults.filter(x => !x.ok)) {
        console.log(`         · ${x.path} [${x.op}] ${x.detail}`)
      }
    }
  }

  // ---------- 汇总 ----------
  const total = results.length
  const passed = results.filter(r => r.ok).length
  const groups = [...new Set(results.map(r => r.group))]
  const byGroup = {}
  console.log('-'.repeat(92))
  for (const g of groups) {
    const rows = results.filter(r => r.group === g)
    const gPass = rows.filter(r => r.ok).length
    byGroup[g] = { total: rows.length, passed: gPass }
    console.log(`  ${pad(g, 12)} ${gPass}/${rows.length} (${pct(gPass, rows.length)})`)
  }
  console.log(`\n总计：${passed}/${total} 通过 (${pct(passed, total)})`)
  if (passed < total) {
    console.log('  ⚠️  有用例失败——上面列了每条失败的路径与实际值，按图索骥修。')
  }

  // ---------- 落盘 ----------
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const outFile = path.join(RESULTS_DIR, `behavior-${tag}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    tag,
    timestamp: new Date().toISOString(),
    goldenVersion: golden._meta?.version,
    summary: { total, passed, passRate: total ? Number((passed / total).toFixed(3)) : 0 },
    byGroup,
    cases: results
  }, null, 2))
  console.log(`结果已写入 ${path.relative(process.cwd(), outFile)}`)

  process.exit(passed === total ? 0 : 1)
}

main()
