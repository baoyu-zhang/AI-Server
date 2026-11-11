/**
 * RAG 检索评测脚本（只测检索层，不调生成模型）
 *
 * 为什么不连模型一起测：
 *   生成质量会掩盖检索问题——检索错了，模型照样能编出一段像样的回答。
 *   把检索单独量出来，改 BM25 / rerank / 改写时才能看出每一步到底有没有用。
 *
 * 判定口径（关键）：
 *   严格命中 = 文件名匹配 且 该片段包含 expectKeywords 里任意一个词。
 *   只看文件名是不够的：简历有 9 段，命中文件不代表命中"能回答这句提问的那一段"。
 *   所以同时记录 fileRank（文件排名）和 strictRank（严格排名），两者差距大就说明切块/排序有问题。
 *
 * 用法：
 *   node eval/run-eval.js                # 用默认 tag 跑一次
 *   node eval/run-eval.js baseline       # 结果存为 eval/results/baseline.json
 *   node eval/run-eval.js +bm25 --topk 20
 */

const fs = require('fs')
const path = require('path')

const { searchVector, getDocuments } = require('../rag-vector')
const dataset = require('./eval-dataset.json')

const RESULTS_DIR = path.join(__dirname, 'results')

/** 取命令行里的 tag（第一个不以 - 开头的参数） */
function getTag() {
  const arg = process.argv.slice(2).find(a => !a.startsWith('-'))
  return arg || 'latest'
}

/** 取 --topk 参数，默认 10 */
function getTopK() {
  const idx = process.argv.indexOf('--topk')
  const val = idx > -1 ? Number(process.argv[idx + 1]) : 10
  return Number.isFinite(val) && val > 0 ? val : 10
}

/** 片段里是否出现任一期望关键词（不区分大小写） */
function keywordHit(content, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return true
  const text = String(content || '').toLowerCase()
  return keywords.some(kw => text.includes(String(kw).toLowerCase()))
}

/** 找到第一个满足条件的排名（从 1 开始），没找到返回 0 */
function findRank(results, predicate) {
  const idx = results.findIndex(predicate)
  return idx < 0 ? 0 : idx + 1
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(0)}%` : '0%'
}

/** 按终端显示宽度补空格：中文占 2 列，否则表格会歪 */
function pad(text, width) {
  const str = String(text)
  const displayWidth = [...str].reduce((w, ch) => w + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, width - displayWidth))
}

const COLS = [6, 12, 14, 10]

async function main() {
  const tag = getTag()
  const topK = getTopK()

  const docs = await getDocuments()
  const chunkCount = docs.reduce((sum, d) => sum + d.chunkCount, 0)
  console.log(`\n评测语料：${docs.length} 篇文档 / ${chunkCount} 个片段`)
  console.log(`评测配置：${dataset.length} 条问题，topK=${topK}，tag=${tag}`)
  console.log('-'.repeat(96))
  console.log(['ID', '类型', '严格排名', '文件排名', '问题'].map((h, i) => i === 4 ? h : pad(h, COLS[i])).join(''))

  const items = []
  for (const item of dataset) {
    let results = []
    try {
      results = await searchVector(item.question, topK)
    } catch (err) {
      console.log(`${pad(item.id, COLS[0])}检索失败：${err.message}`)
      items.push({ ...item, strictRank: 0, fileRank: 0, error: err.message })
      continue
    }

    const fileRank = findRank(results, r => r.fileName === item.expectFile)
    const strictRank = findRank(results, r => r.fileName === item.expectFile && keywordHit(r.content, item.expectKeywords))

    // 控制台里把"文件对但片段不对"标出来，这是最值得看的一类失败
    const rankText = strictRank ? String(strictRank) : (fileRank ? `MISS(文件#${fileRank})` : 'MISS')

    console.log([
      pad(item.id, COLS[0]),
      pad(item.type, COLS[1]),
      pad(rankText, COLS[2]),
      pad(fileRank || '-', COLS[3]),
      item.question
    ].join(''))

    items.push({
      id: item.id,
      type: item.type,
      question: item.question,
      expectFile: item.expectFile,
      expectKeywords: item.expectKeywords,
      strictRank,
      fileRank,
      // 留一份 top3 摘要，出问题时不跑脚本也能复盘
      top3: results.slice(0, 3).map(r => ({ fileName: r.fileName, score: Number(r.score?.toFixed?.(4) ?? r.score) }))
    })
  }

  // ---------- 汇总 ----------
  const total = items.length
  const hitAt = k => items.filter(it => it.strictRank > 0 && it.strictRank <= k).length
  const mrr = items.reduce((sum, it) => sum + (it.strictRank ? 1 / it.strictRank : 0), 0) / total
  const fileHit3 = items.filter(it => it.fileRank > 0 && it.fileRank <= 3).length

  console.log('-'.repeat(96))
  console.log(`hit@1 ${hitAt(1)}/${total} (${pct(hitAt(1), total)})   ` +
    `hit@3 ${hitAt(3)}/${total} (${pct(hitAt(3), total)})   ` +
    `hit@5 ${hitAt(5)}/${total} (${pct(hitAt(5), total)})   ` +
    `MRR ${mrr.toFixed(3)}`)
  console.log(`文件级 hit@3：${fileHit3}/${total} (${pct(fileHit3, total)})  ` +
    `← 与上一行的差距就是"文件找到了但片段没对上"的问题量`)

  const types = [...new Set(items.map(it => it.type))]
  console.log('\n按类型：')
  const byType = {}
  for (const type of types) {
    const group = items.filter(it => it.type === type)
    const h3 = group.filter(it => it.strictRank > 0 && it.strictRank <= 3).length
    const groupMrr = group.reduce((s, it) => s + (it.strictRank ? 1 / it.strictRank : 0), 0) / group.length
    byType[type] = { total: group.length, hit3: h3, hitRate: Number((h3 / group.length).toFixed(3)), mrr: Number(groupMrr.toFixed(3)) }
    console.log(`  ${pad(type, 10)} hit@3 ${h3}/${group.length} (${pct(h3, group.length)})   MRR ${groupMrr.toFixed(3)}`)
  }

  const summary = {
    total,
    hit1: hitAt(1), hit3: hitAt(3), hit5: hitAt(5),
    hit3Rate: Number((hitAt(3) / total).toFixed(3)),
    fileHit3,
    mrr: Number(mrr.toFixed(3))
  }

  // ---------- 落盘，便于不同版本之间对比 ----------
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const outFile = path.join(RESULTS_DIR, `${tag}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    tag,
    timestamp: new Date().toISOString(),
    topK,
    corpus: { docs: docs.length, chunks: chunkCount },
    summary,
    byType,
    items
  }, null, 2))
  console.log(`\n结果已写入 ${path.relative(process.cwd(), outFile)}`)
}

main().catch(err => {
  console.error('评测失败：', err)
  process.exit(1)
})
