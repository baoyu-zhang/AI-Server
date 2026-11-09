/**
 * 评测语料入库脚本
 *
 * 为什么单独写脚本而不是走 HTTP 接口：
 *   /api/upload-doc + /api/embedding-add 是为"前端一次传一个文件"设计的，
 *   跑评测要批量灌 8~10 篇，走 HTTP 得手动串两次请求、还要处理 multipart 中文名。
 *   这里直接 require 同一套函数（extractFileText / splitTextIntoChunks / batchInsertEmbedding），
 *   入库结果与线上接口完全一致，只是省掉网络层。
 *
 * 用法：
 *   node eval/ingest-corpus.js          # 入库
 *   node eval/ingest-corpus.js --list   # 只列出当前库内文档，不写入
 */

const fs = require('fs')
const path = require('path')

const { extractFileText, splitTextIntoChunks } = require('../rag-utils')
const { initVectorStore, batchInsertEmbedding, deleteDocument, getDocuments } = require('../rag-vector')

// 资料包根目录（只读，不做任何修改）
const LIB = '/Users/zhangbaoyu/Desktop/大模型官方课程-视频资料/2026最新大模型全套资料（持续更新）/②、大模型入门资料'
const UPLOADS = path.join(__dirname, '..', 'uploads')

/**
 * 评测语料清单。
 *
 * 选材原则（这决定评测有没有意义）：
 *   ① 主题要"互相不容易混"——简历/发票/Docker/提示词/Agent 各属不同领域，
 *      模型检索错文档时你能一眼看出是检索问题，而不是"这几篇本来就长得像"。
 *   ② 每篇要有明确的"事实型细节"（数字、专有名词、命令名），
 *      这样才能出"精确术语"和"数字代号"两类题，去暴露纯向量检索的短板。
 *   ③ 总片段数控制在 150~250，既够区分，又不会让 embedding 跑太久。
 */
const CORPUS = [
  // ---- 本地真实业务文档 ----
  { file: path.join(UPLOADS, '1792551791516-张宝玉简历-优化版.md'), name: '张宝玉简历-优化版.md', group: '个人材料' },
  { file: path.join(UPLOADS, '1792486147254-电脑300元发票.pdf'), name: '电脑300元发票.pdf', group: '个人材料' },

  // ---- 资料包中的技术文档（主题互不重叠）----
  // 注意：`API调用大模型.pdf` 已被剔除，不进语料。
  // 原因（有实测依据，不是感觉）：它是一份 21 段的厂商 API 链接清单，句子结构高度同质、
  // 信息密度极低，在向量空间里几乎和任何技术问题都"看起来相关"。
  // 基线评测里它在 4 道错题（#3 #8 #16 #19）中霸占 top1 或 top3，属于典型的"磁铁文档"，
  // 会持续污染排名——加多少排序算法都只是在给噪声排序。详见 eval/results/baseline.json。
  { file: path.join(LIB, 'AI大模型提示词技巧.pdf'), name: 'AI大模型提示词技巧.pdf', group: '技术文档' },
  { file: path.join(LIB, '8种主流Agent框架.pdf'), name: '8种主流Agent框架.pdf', group: '技术文档' },
  { file: path.join(LIB, '大模型部署：Rerank 模型的部署及使用.pdf'), name: 'Rerank模型的部署及使用.pdf', group: '技术文档' },
  { file: path.join(LIB, 'RAG聊天机器人 VS AI Agent：哪个更高效？.pdf'), name: 'RAG聊天机器人VS AI Agent.pdf', group: '技术文档' },
  { file: path.join(LIB, 'Docker 命令汇总.pdf'), name: 'Docker命令汇总.pdf', group: '技术文档' }
]

/** 打印当前库内文档分布 */
async function listDocs() {
  await initVectorStore()
  const docs = await getDocuments()
  const total = docs.reduce((sum, d) => sum + d.chunkCount, 0)
  console.log(`\n当前向量库：${docs.length} 篇文档 / ${total} 个片段`)
  for (const d of docs) console.log(`  - ${d.fileName}  ${d.chunkCount} 段`)
}

async function main() {
  if (process.argv.includes('--list')) {
    await listDocs()
    return
  }

  await initVectorStore()

  const report = []
  for (const [i, doc] of CORPUS.entries()) {
    const tag = `[${i + 1}/${CORPUS.length}] ${doc.name}`
    if (!fs.existsSync(doc.file)) {
      console.log(`${tag}  ✗ 源文件不存在：${doc.file}`)
      report.push({ name: doc.name, ok: false, reason: '源文件不存在' })
      continue
    }

    try {
      const ext = path.extname(doc.file).toLowerCase()
      const text = await extractFileText(doc.file, ext)
      if (!text || !text.trim()) {
        throw new Error('解析结果为空（可能是扫描版 PDF）')
      }
      const chunks = splitTextIntoChunks(text, 800, 150)
      if (!chunks.length) throw new Error('切块结果为空')

      // 同名文档先删后插：重新入库不会产生重复片段
      const removed = await deleteDocument(doc.name)
      await batchInsertEmbedding(chunks, doc.name)

      console.log(`${tag}  ✓ ${text.length} 字 → ${chunks.length} 段${removed ? `（覆盖旧片段 ${removed}）` : ''}`)
      report.push({ name: doc.name, ok: true, chars: text.length, chunks: chunks.length, removed })
    } catch (err) {
      console.log(`${tag}  ✗ ${err.message}`)
      report.push({ name: doc.name, ok: false, reason: err.message })
    }
  }

  const okCount = report.filter(r => r.ok).length
  const chunkSum = report.filter(r => r.ok).reduce((s, r) => s + r.chunks, 0)
  console.log(`\n入库完成：成功 ${okCount}/${CORPUS.length} 篇，新增/覆盖 ${chunkSum} 个片段`)

  await listDocs()
}

main().catch(err => {
  console.error('入库失败：', err)
  process.exit(1)
})
