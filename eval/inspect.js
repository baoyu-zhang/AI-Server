/**
 * 检索透视工具：看清"向量"和"BM25"各自召回了什么，以及 RRF 最后怎么排的
 *
 * 用法：
 *   node eval/inspect.js                      # 体检：倒排规模 + 分词自检 + 20 题双路参与率
 *   node eval/inspect.js "RAG 的英文全称是什么？"   # 详解单条查询的三段结果
 *   node eval/inspect.js --topk 8 "docker logs 是干什么的"
 */
const { searchWithCandidates, getBm25Stats, tokenize } = require('../rag-vector')
const dataset = require('./eval-dataset.json')

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`
}

const argv = process.argv.slice(2)
const topkFlag = argv.indexOf('--topk')
const topK = topkFlag >= 0 ? Number(argv[topkFlag + 1]) : 5
// 去掉 --topk 及其取值，剩下的拼成 query
const query = argv.filter((arg, i) => !arg.startsWith('--') && i !== topkFlag + 1).join(' ').trim()

const pad = (s, n) => String(s).padEnd(n)
const clip = (s, n) => {
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}
const fmt = n => Number(n).toFixed(4)

/** 详解单条查询 */
async function inspectQuery(q) {
  const tokens = tokenize(q)
  console.log(`\n${C.cyan('query:')} ${q}`)
  console.log(`${C.dim('分词')}(${tokens.length}): ${tokens.join(' / ') || C.red('（空）')}`)

  const { denseHits, keywordHits, fused } = await searchWithCandidates(q, topK)

  console.log(`\n${C.cyan('① 向量召回')} ${C.dim(`top${denseHits.length}`)}`)
  denseHits.forEach((h, i) => {
    console.log(`  #${pad(i + 1, 2)} ${pad(fmt(h.score), 8)} ${pad(clip(h.fileName, 26), 28)} ${C.dim(clip(h.content, 34))}`)
  })

  console.log(`\n${C.cyan('② BM25 召回')} ${C.dim(`top${keywordHits.length}`)}`)
  if (!keywordHits.length) {
    console.log(C.red('  （空）没有片段命中任何查询词——要么提问用词和原文完全不同，要么倒排没建起来'))
  }
  keywordHits.forEach((h, i) => {
    console.log(`  #${pad(i + 1, 2)} ${pad(fmt(h.score), 8)} ${pad(clip(h.fileName, 26), 28)} ${C.dim(clip(h.content, 34))}`)
  })

  console.log(`\n${C.cyan('③ RRF 融合')} ${C.dim('← 实际返回顺序')}`)
  fused.forEach((h, i) => {
    // denseRank=0 表示向量这一路压根没召回它，只能靠 BM25 进来
    const d = h.denseRank ? `dense#${h.denseRank}` : C.dim('dense—')
    const b = h.bm25Rank ? `bm25#${h.bm25Rank}` : C.dim('bm25—')
    console.log(`  #${pad(i + 1, 2)} ${pad(fmt(h.score), 8)} ${pad(d, 9)} ${pad(b, 9)} ${clip(h.fileName, 30)}`)
  })

  const top1 = fused[0]
  console.log('')
  if (!keywordHits.length) {
    console.log(C.yellow('结论：本条查询 BM25 未命中任何片段，结果完全来自向量召回。'))
  } else if (top1 && !top1.denseRank) {
    console.log(C.green(`结论：BM25 生效且起决定作用——第 1 名向量完全没召回，是 BM25 单独捞回来的。`))
  } else if (top1 && top1.bm25Rank && top1.denseRank > 1) {
    console.log(C.green(`结论：BM25 生效并改写了排序——第 1 名向量原排第 ${top1.denseRank}，靠 BM25 第 ${top1.bm25Rank} 顶上来。`))
  } else if (top1 && top1.bm25Rank === 1 && top1.denseRank === 1) {
    console.log(C.dim('结论：BM25 生效，但两路都对，第 1 名没有发生争议。'))
  } else {
    console.log(C.dim('结论：BM25 生效，但本查询里向量已经排对了，BM25 没有改变第 1 名。'))
  }
}

/** 体检：倒排规模 + 分词自检 + 评测集上的双路参与率 */
async function runCheck() {
  const stats = await getBm25Stats()
  console.log(`\n${C.cyan('BM25 索引')}  ${stats.docs} 段 / 词表 ${stats.vocab} 个 token / 平均 ${stats.avgdl} token`)

  const samples = ['RAG 的英文全称是什么？', '纳税人识别号在哪里看', 'bge-small-zh-v1.5 和 gpt-4']
  console.log(`\n${C.cyan('分词自检')}`)
  for (const s of samples) console.log(`  ${pad(clip(s, 22), 24)} -> ${tokenize(s).join(' ')}`)

  if (!stats.vocab) {
    console.log(C.red('\n词表为空：所有 content 都没切出 token，BM25 等于没接。先查 tokenize。'))
    return
  }

  console.log(`\n${C.cyan(`双路参与率`)} ${C.dim(`（${dataset.length} 题，top${topK}）`)}`)
  let denseHit = 0, bm25Hit = 0, bm25InResult = 0, bm25Rescued = 0
  for (const item of dataset) {
    const { denseHits, keywordHits, fused } = await searchWithCandidates(item.question, topK)
    if (denseHits.length) denseHit++
    if (keywordHits.length) bm25Hit++
    if (fused.some(h => h.bm25Rank > 0)) bm25InResult++
    const top1 = fused[0]
    if (top1 && top1.bm25Rank && (!top1.denseRank || top1.denseRank > 1)) bm25Rescued++
  }
  const line = (label, n, tip) =>
    console.log(`  ${pad(label, 26)} ${pad(`${n}/${dataset.length}`, 8)} ${C.dim(tip)}`)
  line('向量召回非空', denseHit, '')
  line('BM25 召回非空', bm25Hit, bm25Hit < dataset.length ? '有查询一个词都没命中' : '全部命中')
  line('结果含 BM25 片段', bm25InResult, '融合后仍保留关键词召回')
  line('top1 靠 BM25 改写', bm25Rescued, '向量没排第 1，被 BM25 顶上来')

  if (bm25Hit === 0) {
    console.log(C.red('\nBM25 一路全空：未生效。依次检查 invalidateBm25 是否漏调、content 字段是否存在。'))
  } else if (bm25Rescued === 0) {
    console.log(C.yellow('\nBM25 有召回但没改变任何 top1：可能是生效但收益小，也可能是查询普遍含原词（评测集偏向关键词）。'))
  } else {
    console.log(C.green(`\nBM25 生效：${bm25Rescued} 条问题的 top1 是靠它改写排序的。`))
  }
}

;(async () => {
  if (query) await inspectQuery(query)
  else await runCheck()
})().catch(err => {
  console.error(C.red('执行失败：' + err.message))
  process.exit(1)
})
