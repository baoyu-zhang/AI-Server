const { LocalIndex } = require('vectra'); // 引入 Vectra 本地向量库
const path = require('path'); // 引入路径模块
const { pipeline, env } = require('@xenova/transformers'); // 引入 transformers.js，本地跑 embedding 模型
require('dotenv').config(); // 读取 .env，支持用 HF_ENDPOINT / EMBEDDING_MODEL 覆盖默认配置

// Hugging Face 官方域名在国内经常不可达，默认走镜像；需要时可用 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com/';

// 本地 embedding 模型：bge-small-zh-v1.5，中文检索效果好，输出 512 维向量
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';

// 向量库文件夹
const index = new LocalIndex(path.join(__dirname, 'vector-index'));

// 初始化向量库
async function initVectorStore() {
  if (!await index.isIndexCreated()) {
    await index.createIndex();
    console.log("✅ Vectra向量索引创建成功")
  } else {
    console.log("✅ Vectra向量索引已存在，直接加载")
  }
}

// 模型只加载一次，后续所有请求复用同一个实例
let extractorPromise = null;

/**
 * 获取（懒加载）文本特征提取器
 * @returns {Promise<import('@xenova/transformers').FeatureExtractionPipeline>}
 */
function getExtractor() {
  if (!extractorPromise) {
    console.log(`⏳ 正在加载本地 embedding 模型：${EMBEDDING_MODEL}（首次需下载，之后走本地缓存）`)
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL).catch(err => {
      extractorPromise = null; // 加载失败时清空，允许下次重试
      throw new Error(`本地 embedding 模型加载失败（${EMBEDDING_MODEL}）：${err.message}`)
    });
  }
  return extractorPromise;
}

/**
 * 文本生成embedding向量（本地推理，不走网络请求）
 * @param {string} text
 * @returns {Promise<number[]>} 归一化后的 512 维向量
 */
async function getEmbedding(text) {
  if (!text) throw new Error('embedding 输入文本不能为空') // 模型偶尔会不传 query，提前给出明确错误
  const extractor = await getExtractor();
  // pooling: mean 把 token 向量池化成句向量；normalize: true 做 L2 归一化，便于余弦相似度检索
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * 批量生成 embedding 向量
 * @param {string[]} texts
 * @returns {Promise<number[][]>} 每个文本对应的归一化向量
 */
async function getEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const dim = output.dims[output.dims.length - 1];
  return texts.map((_, i) => Array.from(output.data.slice(i * dim, (i + 1) * dim)));
}

/**
 * 批量将chunk数组向量化，插入向量库
 * @param {string[]} chunks 文本片段数组
 * @param {string} fileName 文档名称（元数据）
 */
async function batchInsertEmbedding(chunks, fileName) {
  const vectors = await getEmbeddings(chunks)
  for (let i = 0; i < chunks.length; i++) {
    await index.insertItem({
      vector: vectors[i],
      metadata: {
        fileName,
        content: chunks[i],
        createdAt: Date.now() // 记录入库时间，前端文档列表可按时间排序
      }
    });
  }
  invalidateBm25(); // 语料变了，倒排缓存必须失效，否则新文档检索不到
}

// ==================== BM25 关键词召回 ====================
// 为什么不用 Vectra 自带的 queryItems(..., isBm25=true)：
// 它的 BM25 分支要求 metadata 里存在 documentId / startPos / endPos 才能回读原文切出 chunkText，
// 而我们的条目只有 fileName / content / createdAt。条件不成立时它会静默跳过——不报错，直接返回空结果，
// 等于白跑一遍。它的分词器又是 wink-nlp 英文模型 + 词干还原，对中文基本切不动。所以这里自己实现。

const BM25_K1 = 1.2; // 词频饱和系数：值越大越"奖励重复出现"，1.2 是常规默认
const BM25_B = 0.75; // 文档长度归一化强度：0 完全不看长短，1 完全按长度折损
const RRF_K = 60; // RRF 平滑常数，用来压低第 1 名与第 2 名的差距，60 来自原论文

/**
 * 中文友好分词：连续汉字切 bigram，英文/数字串整体保留
 * 为什么不用单字：中文单字歧义太大（"的""是"满篇都是），会污染打分；
 * bigram 不需要词典就能覆盖"纳税人识别号"这类专有词——查询里出现任意相邻两字即可命中。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const tokens = [];
  const source = String(text || '').toLowerCase();
  // 汉字串 或 英文数字串；允许 - _ . ' 连接，便于保留 gpt-4、bge-small-zh 这类写法
  const re = /[\u4e00-\u9fa5]+|[a-z0-9]+(?:[-_.'][a-z0-9]+)*/g;
  let match;
  while ((match = re.exec(source))) {
    const seg = match[0];
    if (!/^[\u4e00-\u9fa5]/.test(seg)) {
      tokens.push(seg); // 英文/数字整体作为一个词，不切分
      continue;
    }
    if (seg.length === 1) continue; // 单个汉字信息量太低，直接丢弃
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2)); // 滑窗生成 bigram
    }
  }
  return tokens;
}

// BM25 倒排缓存：检索是高频路径，不能每次查询都 listItems() 全量读盘
let bm25Cache = null;
// 并发保护：多个请求同时进来时只允许一个在构建，其余等同一个 Promise
let bm25Pending = null;

/** 索引发生变化（新增/删除/清空）后必须调用，否则会一直拿旧语料打分 */
function invalidateBm25() {
  bm25Cache = null;
}

/**
 * 构建（或复用）BM25 倒排索引
 * 只索引 content。fileName 里也有关键信号（如"RAG聊天机器人VS AI Agent.pdf"），
 * 但把它混进正文会改变 df 统计，收益需要单独评测，暂不加入。
 * @returns {Promise<{docs: Array, df: Map<string, number>, avgdl: number}>}
 */
function getBm25Index() {
  if (bm25Cache) return Promise.resolve(bm25Cache);
  if (!bm25Pending) {
    bm25Pending = (async () => {
      const items = await index.listItems();
      const docs = [];
      const df = new Map(); // token -> 出现在多少个文档里
      let totalLen = 0;
      for (const item of items) {
        const content = item.metadata?.content;
        if (!content) continue; // 没有正文的脏数据不参与打分
        const tokens = tokenize(content);
        if (!tokens.length) continue;
        const tf = new Map(); // 预先算好词频，查询时只做加法，避免每次重新扫全文
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        docs.push({
          id: item.id,
          content,
          fileName: item.metadata?.fileName,
          tf,
          len: tokens.length
        });
        totalLen += tokens.length;
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      }
      bm25Cache = { docs, df, avgdl: docs.length ? totalLen / docs.length : 0 };
      return bm25Cache;
    })().finally(() => { bm25Pending = null; });
  }
  return bm25Pending;
}

/**
 * BM25 Okapi 打分：idf 压低高频词，tf 饱和 + 文档长度归一化，避免长片段天然占优
 * @param {{docs: Array, df: Map<string, number>, avgdl: number}} bm25Index
 * @param {string} query
 * @param {number} topK
 * @returns {Array<{id: string, score: number, content: string, fileName: string}>}
 */
function bm25Search(bm25Index, query, topK) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !bm25Index.docs.length) return [];
  const { docs, df, avgdl } = bm25Index;
  const total = docs.length;
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const token of queryTokens) {
      const tf = doc.tf.get(token);
      if (!tf) continue; // 该片段不含这个词，跳过
      const n = df.get(token) || 0;
      // +0.5 平滑，避免 n === total 时 idf 变成负数；外层 +1 保证 idf 恒正
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      // tf 饱和：同一个词出现 10 次不该比出现 2 次重要 5 倍
      const saturated = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * doc.len / (avgdl || 1)));
      score += idf * saturated;
    }
    if (score > 0) scored.push({ id: doc.id, score, content: doc.content, fileName: doc.fileName });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * 混合检索内部实现：保留两路排名明细，供调试与评测使用
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array<{id: string, score: number, content: string, fileName: string, denseRank: number, bm25Rank: number}>>}
 */
async function hybridSearch(query, topK = 3) {
  const pool = Math.max(topK * 4, 20); // 召回池要放大，否则没东西可融
  // embedding 推理与倒排索引构建互不依赖，必须并行；串行会让两段耗时直接相加
  const [queryVector, bm25Index] = await Promise.all([getEmbedding(query), getBm25Index()]);
  // Vectra 0.15 的签名是 queryItems(vector, query, topK, filter, isBm25)，这里只用语义那一路
  const denseItems = await index.queryItems(queryVector, query, pool);
  const denseHits = denseItems.map(item => ({
    id: item.item.id,
    score: item.score,
    content: item.item.metadata.content,
    fileName: item.item.metadata.fileName
  }));
  const keywordHits = bm25Search(bm25Index, query, pool);

  // 用片段 id 聚合同一片段在两路的排名，累加 RRF 分：score = Σ 1/(60 + rank)
  const fused = new Map();
  const merge = (hits, field) => {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const current = fused.get(hit.id) || {
        id: hit.id,
        content: hit.content,
        fileName: hit.fileName,
        score: 0,
        denseRank: 0,
        bm25Rank: 0
      };
      current.score += 1 / (RRF_K + rank);
      current[field] = rank; // 保留单路排名，便于排查"这条是被哪一路救回来的"
      fused.set(hit.id, current);
    });
  };
  merge(denseHits, 'denseRank');
  merge(keywordHits, 'bm25Rank');

  // RRF 原始分只有 0~1/61 量级，直接抛给模型会像"相关度极低"，反而让它不敢用这段材料。
  // 用理论满分归一化：两路都排第 1 = 2/(RRF_K+1)，此时得 1.0；只有一路命中则最高 0.5。
  // 这样 score 仍是 0~1 的可读区间，同时保留"双路都命中 > 单路命中"的信息。
  const maxRrf = 2 / (RRF_K + 1);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(item => ({ ...item, score: Number((item.score / maxRrf).toFixed(4)) }));
}

/**
 * 混合检索对外接口：输入问题返回 topK 片段
 * 返回结构必须保持 { score, content, fileName } 三字段：
 * index.js 的 searchKnowledgeBase 会把结果拼给模型，多带 id / 排名明细只是平白消耗上下文。
 * @param {string} query 用户查询文本
 * @param {number} topK
 * @returns {Promise<Array<{score: number, content: string, fileName: string}>>}
 */
async function searchVector(query, topK = 3) {
  const results = await hybridSearch(query, topK);
  return results.map(item => ({
    score: item.score,
    content: item.content,
    fileName: item.fileName
  }));
}

/**
 * 调试版检索：额外返回 denseRank / bm25Rank
 * 只在本地排查和评测脚本里用，不接入线上链路
 */
async function searchVectorDebug(query, topK = 3) {
  return await hybridSearch(query, topK);
}


/**
 * 【可选CRUD：查询全部向量】
 */
async function getAllItems() {
  return await index.listItems() // Vectra 0.15 只有 listItems()，没有 getItems()
}

/**
 * 获取文档列表：按 fileName 聚合向量片段
 * 只返回文件名、片段数、入库时间，不把向量本体传给前端
 * @returns {Promise<Array<{fileName: string, chunkCount: number, createdAt: number}>>}
 */
async function getDocuments() {
  const items = await index.listItems()
  const map = new Map()
  for (const item of items) {
    const fileName = item.metadata?.fileName
    if (!fileName) continue // 没有文件名的历史数据不纳入文档列表
    if (!map.has(fileName)) {
      map.set(fileName, { fileName, chunkCount: 0, createdAt: item.metadata.createdAt || 0 })
    }
    const doc = map.get(fileName)
    doc.chunkCount += 1
    // 取最新一次入库时间，便于同名文档重新上传后排序
    doc.createdAt = Math.max(doc.createdAt, item.metadata.createdAt || 0)
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 按文件名删除文档：删除该文件对应的全部向量片段
 * @param {string} fileName
 * @returns {Promise<number>} 删除的片段数
 */
async function deleteDocument(fileName) {
  const items = await index.listItems()
  const ids = items
    .filter(item => item.metadata?.fileName === fileName)
    .map(item => item.id)
  if (ids.length) await index.deleteItems(ids)
  invalidateBm25() // 删完必须重建倒排，否则被删的片段还能被关键词召回
  return ids.length
}

/**
 * 【可选CRUD：清空整个向量库】
 */
async function clearVectorIndex() {
  await index.deleteIndex();
  await index.createIndex();
  invalidateBm25(); // 库已清空，缓存里的旧语料必须一起丢掉
}

module.exports = {
  initVectorStore,
  getEmbedding,
  getEmbeddings,
  batchInsertEmbedding,
  searchVector,
  searchVectorDebug, // 带两路排名明细，供本地调试与评测
  tokenize, // 导出给单元测试验证分词行为
  getAllItems,
  getDocuments,
  deleteDocument,
  clearVectorIndex
}
