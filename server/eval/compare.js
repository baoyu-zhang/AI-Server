/**
 * 两次评测结果的对比工具
 *
 * 为什么需要它：改检索策略时最容易犯的错是"只看总分"。
 * 80% → 95% 可能是救回 4 条，也可能是救回 8 条又弄坏 4 条（总分一样）。
 * 这个脚本把每条题的名次变化单独列出来，改坏了哪几条一眼能看到。
 *
 * 用法：
 *   node eval/compare.js baseline cleaned
 */

const fs = require('fs')
const path = require('path')

const RESULTS_DIR = path.join(__dirname, 'results')

function load(tag) {
  const file = path.join(RESULTS_DIR, `${tag}.json`)
  if (!fs.existsSync(file)) {
    console.error(`找不到结果文件：${path.relative(process.cwd(), file)}`)
    console.error('先跑 node eval/run-eval.js ' + tag)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const [tagA, tagB] = process.argv.slice(2)
if (!tagA || !tagB) {
  console.error('用法：node eval/compare.js <旧tag> <新tag>')
  process.exit(1)
}

const a = load(tagA)
const b = load(tagB)

/** 名次格式：0 显示为 MISS */
function rankText(rank) {
  return rank ? String(rank) : 'MISS'
}

function delta(before, after) {
  if (before === after) return ''
  // 名次变小是进步；MISS(0) 变有名次也是进步
  if (!before && after) return `↑ 新增命中`
  if (before && !after) return `↓ 变成未命中`
  return after < before ? `↑${before - after}` : `↓${after - before}`
}

function line(label, before, after, suffix = '') {
  const d = after - before
  const sign = d > 0 ? `+${d}` : d < 0 ? String(d) : '0'
  console.log(`  ${label.padEnd(10)} ${String(before).padEnd(10)} ${String(after).padEnd(10)} ${sign}${suffix}`)
}

console.log(`\n对比：${tagA} → ${tagB}`)
console.log(`  语料：${a.corpus.docs} 篇/${a.corpus.chunks} 片段  →  ${b.corpus.docs} 篇/${b.corpus.chunks} 片段`)
console.log('\n指标：')
console.log(`  ${'指标'.padEnd(9)} ${tagA.padEnd(10)} ${tagB.padEnd(10)} 变化`)
line('hit@1', a.summary.hit1, b.summary.hit1)
line('hit@3', a.summary.hit3, b.summary.hit3)
line('hit@5', a.summary.hit5, b.summary.hit5)
line('文件hit@3', a.summary.fileHit3, b.summary.fileHit3)
line('MRR×1000', Math.round(a.summary.mrr * 1000), Math.round(b.summary.mrr * 1000))

const mapB = new Map(b.items.map(it => [it.id, it]))
const changed = a.items
  .map(it => ({ before: it, after: mapB.get(it.id) }))
  .filter(x => x.after && x.before.strictRank !== x.after.strictRank)

if (changed.length) {
  console.log('\n名次发生变化的题目：')
  for (const { before, after } of changed) {
    console.log(`  #${String(before.id).padEnd(3)} ${rankText(before.strictRank).padEnd(6)} → ${rankText(after.strictRank).padEnd(6)} ${delta(before.strictRank, after.strictRank).padEnd(12)} ${before.type}  ${before.question}`)
  }
} else {
  console.log('\n名次没有任何变化。')
}

const regressions = changed.filter(x => {
  const bRank = x.before.strictRank || 99
  const aRank = x.after.strictRank || 99
  return aRank > bRank
})
console.log(`\n合计：改善 ${changed.length - regressions.length} 条，退化 ${regressions.length} 条`)
