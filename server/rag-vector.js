const { LocalIndex } = require('vectra'); // 引入 Vectra 本地向量库
const path = require('path'); // 引入路径模块
const { pipeline, env } = require('@xenova/transformers'); // 引入 transformers.js，本地跑 embedding 模型
require('dotenv').config(); // 读取 .env，支持用 HF_ENDPOINT / EMBEDDING_MODEL 覆盖默认配置

// Hugging Face 官方域名在国内经常不可达，默认走镜像；需要时可用 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com/';

// 本地 embedding 模型：bge-small-zh-v1.5，中文检索效果好，输出 512 维向量
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';

// 向量索引与 embedding 模型缓存都放统一数据卷：
// ① 索引是运行时状态，重建容器不能丢；
// ② 模型首次要下载几百 MB，放进卷后重新部署不必重下（否则冷启动会顶爆健康检查超时）。
const { PATHS } = require('./paths');
// 本机不设 cacheDir（沿用 ~/.cache 里已下载的模型），云上才把缓存放进卷避免每次部署重下
if (process.env.TRANSFORMERS_CACHE || PATHS.MODEL_CACHE_DIR) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE || PATHS.MODEL_CACHE_DIR;
}
const index = new LocalIndex(PATHS.VECTOR_INDEX_DIR);

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
 * @param {{docType?: string, jobId?: string, candidateId?: string, userId?: string, fileId?: string}} meta 业务标签，可选
 */
async function batchInsertEmbedding(chunks, fileName, meta = {}) {
  const vectors = await getEmbeddings(chunks)
  // 白名单：只接收业务字段，防止调用方传 content 把正文覆盖掉
  // userId 是数据隔离的锚点：写入后，检索/列表/删除都按它圈定可见范围
  const biz = {
    docType: meta.docType,
    jobId: meta.jobId,
    candidateId: meta.candidateId,
    userId: meta.userId
  }
  // fileId：P2「产品化」新增的文档唯一标识，由调用方（上传接口）生成并原样回给前端，
  // 之后前端按它删除，不再靠 fileName——两个用户传同名文件时也不会互相误删。
  // 没传就回落到 fileName，保证旧调用方与历史数据（本来就没有 fileId）行为不变。
  const fileId = meta.fileId || fileName
  for (let i = 0; i < chunks.length; i++) {
    await index.insertItem({
      vector: vectors[i],
      metadata: {
        fileName,
        fileId, // 文档级唯一标识；老数据没有该字段，列表/删除侧都用 fileName 兜底
        content: chunks[i],
        // 片段在原文中的序号：引用定位（点击引用看前后段）全靠它排序取邻域。
        // 旧语料没有这个字段，定位接口要按缺失兜底
        chunkIndex: i,
        createdAt: Date.now(), // 记录入库时间，前端文档列表可按时间排序
        ...biz // 展开在后：业务字段追加进 metadata
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
          chunkIndex: item.metadata?.chunkIndex, // 引用定位用：排序取邻域
          tf,
          len: tokens.length,
          meta: item.metadata || {}, // 过滤要在 BM25 侧也能用，所以整份 metadata 都留下

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
 * 复刻 Vectra 的过滤语义（对象精确匹配 + $and/$or）
 * 为什么必须自己写一份：向量那路把 filter 交给 Vectra 了，BM25 这路得手写；
 * 两边语义不一致时，融合会把"本该过滤掉的片段"又带回来，而且不报错。
 * @param {object} meta 片段 metadata
 * @param {object} filter 形如 { candidateId: 'c1' } 或 { $or: [{docType:'jd'},{docType:'resume'}] }
 * @returns {boolean}
 */
function matchesFilter(meta, filter) {
  if (!filter) return true;
  const m = meta || {};
  for (const [key, expect] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(expect) || !expect.every(f => matchesFilter(m, f))) return false;
    } else if (key === '$or') {
      if (!Array.isArray(expect) || !expect.some(f => matchesFilter(m, f))) return false;
    } else if (expect === null) {
      // null 的专门语义："这个字段不存在"。用户的可见性过滤靠它：
      // 旧语料（评测语料、鉴权上线前的数据）没有 userId 字段，要让它对所有人可见，
      // 表达成 { userId: null }；写 undefined 的话 JSON 序列化会直接丢键。
      if (m[key] !== undefined) return false;
    } else if (m[key] !== expect) {
      return false;
    }
  }
  return true;
}

/**
 * 可见性过滤：有主的片段只归本人，无主片段（旧语料）对所有人可见。
 * userId 为空（服务端脚本、评测）时返回 null = 不过滤，行为与鉴权上线前完全一致。
 * 返回值要么直接当 filter 用，要么和业务 filter 一起交给 matchesFilter。
 */
function visibilityFilter(userId) {
  if (!userId) return null;
  return { $or: [{ userId }, { userId: null }] };
}

/**
 * BM25 Okapi 打分：idf 压低高频词，tf 饱和 + 文档长度归一化，避免长片段天然占优
 * @param {{docs: Array, df: Map<string, number>, avgdl: number}} bm25Index
 * @param {string} query
 * @param {number} topK
 * @returns {Array<{id: string, score: number, content: string, fileName: string}>}
 */
function bm25Search(bm25Index, query, topK, filter, userId) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !bm25Index.docs.length) return [];
  const { docs, df, avgdl } = bm25Index;
  const vis = visibilityFilter(userId);
  const total = docs.length;
  const scored = [];
  for (const doc of docs) {
    if (!matchesFilter(doc.meta, filter)) continue; // 必须在打分前过滤，不能取完 topK 再筛
    if (vis && !matchesFilter(doc.meta, vis)) continue; // 可见性同样在打分前，否则别人的片段会占掉 topK 名额

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
    if (score > 0) scored.push({ id: doc.id, score, content: doc.content, fileName: doc.fileName, chunkIndex: doc.chunkIndex });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * 双路召回原始候选：向量 + BM25，不做融合
 * 单独拆出来是因为 rerank 需要的正是"未融合的候选集"——融合只是候选的下游消费者之一。
 * 将来接 rerank 时，从 denseHits + keywordHits 取并集送去重排即可，不必再动检索层。
 * @param {string} query
 * @param {number} pool 每路各召回多少条
 * @returns {Promise<{denseHits: Array, keywordHits: Array}>}
 */
async function retrieveCandidates(query, pool, filter, userId) {
  // embedding 推理与倒排索引构建互不依赖，必须并行；串行会让两段耗时直接相加
  const [queryVector, bm25Index] = await Promise.all([getEmbedding(query), getBm25Index()]);
  // Vectra 0.15 的签名是 queryItems(vector, query, topK, filter, isBm25)，这里只用语义那一路
  const denseItems = await index.queryItems(queryVector, query, pool, filter);
  // 可见性不交给 Vectra：它的 filter 只认"值精确相等"，表达不了"userId 等于某人或不存在"。
  // 所以召回时只带业务 filter（扩大召回池），可见性在下面用自己的 matchesFilter 统一收口——
  // 这样 BM25 路与向量路的"谁能看见"必然是同一套语义，不会出现一边漏一边严。
  const vis = visibilityFilter(userId);
  let denseHits = denseItems.map(item => ({
    id: item.item.id,
    score: item.score,
    content: item.item.metadata.content,
    fileName: item.item.metadata.fileName,
    chunkIndex: item.item.metadata.chunkIndex, // 引用定位用
    meta: item.item.metadata || {} // 带上 metadata 才能做可见性后过滤
  }));
  if (vis) denseHits = denseHits.filter(hit => matchesFilter(hit.meta, vis));
  return {
    denseHits,
    keywordHits: bm25Search(bm25Index, query, pool, filter, userId)
  };
}

/**
 * RRF 融合：用片段 id 聚合同一片段在两路的排名，累加 score = Σ 1/(60 + rank)
 * 保留 denseRank / bm25Rank 两个字段：排查"这条是被哪一路救回来的"全靠它。
 * @param {Array} denseHits 向量候选（需带 id/score/content/fileName）
 * @param {Array} keywordHits BM25 候选（结构同上）
 * @param {number} topK
 * @returns {Array<{id: string, score: number, content: string, fileName: string, denseRank: number, bm25Rank: number}>}
 */
function fuseRRF(denseHits, keywordHits, topK) {
  const fused = new Map();
  const merge = (hits, field) => {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const current = fused.get(hit.id) || {
        id: hit.id,
        content: hit.content,
        fileName: hit.fileName,
        chunkIndex: hit.chunkIndex,
        score: 0,
        denseRank: 0,
        bm25Rank: 0
      };
      current.score += 1 / (RRF_K + rank);
      current[field] = rank; // 记下单路名次，0 表示这一路没召回它
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
 * 混合检索主链路：双路召回 → RRF 融合
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array>} 融合后的 topK，含排名明细
 */
async function hybridSearch(query, topK = 3, filter, userId) {
  const pool = Math.max(topK * 4, 20); // 召回池要放大，否则没东西可融
  const { denseHits, keywordHits } = await retrieveCandidates(query, pool, filter, userId);
  return fuseRRF(denseHits, keywordHits, topK);
}

/**
 * 混合检索对外接口：输入问题返回 topK 片段
 * 返回结构必须保持 { score, content, fileName } 三字段：
 * index.js 的 searchKnowledgeBase 会把结果拼给模型，多带 id / 排名明细只是平白消耗上下文。
 * @param {string} query 用户查询文本
 * @param {number} topK
 * @returns {Promise<Array<{score: number, content: string, fileName: string}>>}
 */
async function searchVector(query, topK = 3, filter, userId) {
  const results = await hybridSearch(query, topK, filter, userId);
  return results.map(item => ({
    score: item.score,
    content: item.content,
    fileName: item.fileName,
    chunkIndex: item.chunkIndex // 旧语料为 undefined，前端按缺失兜底（只看片段本身）
  }));
}

/**
 * 调试版检索：额外返回 denseRank / bm25Rank
 * 只在本地排查和评测脚本里用，不接入线上链路
 */
async function searchVectorDebug(query, topK = 3, filter, userId) {
  return await hybridSearch(query, topK, filter, userId);
}

/**
 * 带候选集的检索：同时返回两路原始候选和融合结果
 * 判断"BM25 到底有没有起作用"就看这里——keywordHits 为空说明倒排没命中任何片段，
 * fused 里某条的 bm25Rank 为 0 说明它是纯向量召回的。
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<{denseHits: Array, keywordHits: Array, fused: Array}>}
 */
async function searchWithCandidates(query, topK = 3, filter, userId) {
  const pool = Math.max(topK * 4, 20);
  const candidates = await retrieveCandidates(query, pool, filter, userId);
  return {
    ...candidates,
    fused: fuseRRF(candidates.denseHits, candidates.keywordHits, topK)
  };
}

/**
 * BM25 索引体检：文档数、词表大小、平均长度
 * 词表为 0 说明所有 content 都没通过分词（例如全是标点），此时 BM25 静默失效
 * @returns {Promise<{docs: number, vocab: number, avgdl: number}>}
 */
async function getBm25Stats() {
  const bm25Index = await getBm25Index();
  return {
    docs: bm25Index.docs.length,
    vocab: bm25Index.df.size,
    avgdl: Math.round(bm25Index.avgdl)
  };
}


/**
 * 【可选CRUD：查询全部向量】
 */
async function getAllItems() {
  return await index.listItems() // Vectra 0.15 只有 listItems()，没有 getItems()
}

/**
 * 获取文档列表：按 fileName 聚合向量片段
 * 只返回文件名、片段数、入库时间与业务标签，不把向量本体传给前端
 *
 * 业务标签（docType / jobId / candidateId）之所以要带出来：`/api/upload-doc` 判断
 * "这次上传是不是同一份业务对象"全靠它。没有它，两个候选人都传「简历.md」时，
 * 后传的那份会把前一个人的片段删掉——覆盖变成互相覆盖。
 * @returns {Promise<Array<{fileName: string, fileId: string, chunkCount: number, createdAt: number, docType?: string, jobId?: string, candidateId?: string}>>}
 */
async function getDocuments(userId) {
  const items = await index.listItems()
  const vis = visibilityFilter(userId);
  const map = new Map()
  for (const item of items) {
    const meta = item.metadata || {}
    if (vis && !matchesFilter(meta, vis)) continue; // 别人的文档连聚合都不进，chunkCount 也不泄露
    const fileName = meta.fileName
    if (!fileName) continue // 没有文件名的历史数据不纳入文档列表
    if (!map.has(fileName)) {
      map.set(fileName, {
        fileName,
        // P2：回传 fileId 给前端，删除接口据此精确删自己那一份。
        // 老条目入库时还没有 fileId，回落成 fileName，前端按旧契约传 fileName 也删得动
        fileId: meta.fileId || fileName,
        chunkCount: 0,
        createdAt: meta.createdAt || 0,
        // 同一文件的所有片段共享同一组标签，取第一条即可（旧语料没有这些字段，值为 undefined）
        docType: meta.docType,
        jobId: meta.jobId,
        candidateId: meta.candidateId,
        userId: meta.userId // 传给 resolveDocName 判断"同名是不是同一个对象"
      })
    }
    const doc = map.get(fileName)
    doc.chunkCount += 1
    // 取最新一次入库时间，便于同名文档重新上传后排序
    doc.createdAt = Math.max(doc.createdAt, meta.createdAt || 0)
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 按业务字段聚合成清单（候选人 / 岗位）
 * 抽成一个函数是因为两者逻辑完全一样，只是聚合键不同；复制两遍将来改字段要改两处。
 * @param {'candidateId'|'jobId'} field 聚合键
 * @param {(meta: object) => boolean} [predicate] 额外筛选，用于"统计岗位时排除简历片段"
 * @returns {Promise<Array<{key: string, fileName: string, chunkCount: number, createdAt: number, jobId?: string, candidateId?: string}>>}
 */
async function groupByBizField(field, predicate, userId) {
  const items = await index.listItems()
  const vis = visibilityFilter(userId);
  const map = new Map()
  for (const item of items) {
    const meta = item.metadata || {}
    if (vis && !matchesFilter(meta, vis)) continue;
    const key = meta[field]
    // 没有该字段的片段不参与聚合：旧语料没有 candidateId，不能让它变成一条"空候选人"
    if (!key) continue
    if (predicate && !predicate(meta)) continue
    if (!map.has(key)) {
      map.set(key, { key, fileName: meta.fileName, chunkCount: 0, createdAt: 0, jobId: meta.jobId, candidateId: meta.candidateId })
    }
    const entry = map.get(key)
    entry.chunkCount += 1
    entry.createdAt = Math.max(entry.createdAt, meta.createdAt || 0)
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt)
}

/** 候选人清单：只统计带 candidateId 的片段（简历入库强制带 candidateId，所以这里天然只有简历） */
async function getCandidates(userId) {
  return await groupByBizField('candidateId', undefined, userId)
}

/**
 * 岗位清单：按 jobId 聚合，排除简历类片段
 * 为什么要排除：简历也可以标 jobId（表示"投的是这个岗"），如果一并计入，
 * 一个岗位的"片段数"里会混进几十段简历正文，看的人会误以为 JD 很长。
 */
async function getJobs(userId) {
  return await groupByBizField('jobId', meta => meta.docType !== 'resume', userId)
}

/**
 * 按文件名删除文档：删除该文件对应的全部向量片段
 * @param {string} fileName
 * @param {string} [userId] 传入时只删可见范围内的片段——按文件名删是危险操作，
 *   不能因为另一个用户碰巧传了同名文件就删掉他的。返回 0 意味着"你没有这个文件"。
 * @returns {Promise<number>} 删除的片段数
 */
async function deleteDocument(fileName, userId) {
  const items = await index.listItems()
  const vis = visibilityFilter(userId);
  const ids = items
    .filter(item => item.metadata?.fileName === fileName)
    .filter(item => !vis || matchesFilter(item.metadata, vis))
    .map(item => item.id)
  if (ids.length) await index.deleteItems(ids)
  invalidateBm25() // 删完必须重建倒排，否则被删的片段还能被关键词召回
  return ids.length
}

/**
 * 按 fileId 删除文档：删除该文件对应的全部向量片段（P2「产品化」新增）。
 *
 * 与 deleteDocument(fileName) 的区别：过滤键换成 metadata.fileId 而不是 fileName。
 * fileName 是给人看的、会重复（两个候选人都叫「简历.md」）；fileId 是文档级唯一标识，
 * 前端从 /api/documents 拿到后原样传回，删除就能精确到「自己那一份」，不误伤同名文档。
 *
 * 兼容旧数据：老条目入库时还没有 fileId 字段，此时回落到 fileName 匹配——
 * 调用方按旧契约把 fileName 当作 fileId 传进来（getDocuments 对老条目也返回 fileName）
 * 一样删得动，不会出现「升级后老文档删不掉」。
 *
 * 可见性过滤完全照抄 deleteDocument：传入 userId 时只删该用户可见范围内的片段，
 * 别人的文档连命中都不算；返回 0 表示「你没有这个文件」。
 *
 * @param {string} fileId 文档唯一标识（老数据场景可直接传 fileName）
 * @param {string} [userId] 传入时只删可见范围内的片段，防越权
 * @returns {Promise<number>} 删除的片段数（0 = 不存在或无权删除）
 */
async function deleteDocumentByFileId(fileId, userId) {
  const items = await index.listItems()
  const vis = visibilityFilter(userId);
  const ids = items
    .filter(item => {
      const meta = item.metadata || {}
      // 有 fileId 的新条目按 fileId 精确匹配；没有 fileId 的老条目回落到 fileName 匹配
      if (meta.fileId !== undefined && meta.fileId !== null) return meta.fileId === fileId
      return meta.fileName === fileId
    })
    .filter(item => !vis || matchesFilter(item.metadata, vis))
    .map(item => item.id)
  if (ids.length) await index.deleteItems(ids)
  invalidateBm25() // 删完必须重建倒排，否则被删的片段还能被关键词召回
  return ids.length
}

/**
 * 引用定位：取某片段在原文中的前后邻域
 *
 * 点击【引用来源】时前端调它，把被引片段前后的段落一起展示出来——
 * 只看片段本身（切完块只剩一小段）常常读不通，人需要上下文才能核实"AI 是不是断章取义"。
 *
 * 兜底语义：被引片段没有 chunkIndex（旧语料入库时还没这个字段）时只返回片段本身，
 * 不猜顺序——按插入顺序当作阅读顺序是错的，Vectra 的 listItems 并不保证这个。
 *
 * @param {string} fileName 文档名（可见性按 userId 过滤）
 * @param {number} chunkIndex 被引片段序号
 * @param {number} [windowSize=1] 前后各取几个片段
 * @returns {Promise<Array<{chunkIndex: number, content: string, current: boolean}>>}
 */
async function getDocumentContext(fileName, chunkIndex, windowSize = 1, userId) {
  const items = await index.listItems()
  const vis = visibilityFilter(userId);
  // 同名文件可能有多个片段；先圈定可见范围内的同名条目再排序
  const chunks = items
    .filter(item => item.metadata?.fileName === fileName && Number.isInteger(item.metadata?.chunkIndex))
    .filter(item => !vis || matchesFilter(item.metadata, vis))
    .map(item => ({ chunkIndex: item.metadata.chunkIndex, content: item.metadata.content || '' }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
  // 被引序号在库里不存在（文档重传后片段数变了）：退化成只返回邻域里最近的片段也说不清，
  // 干脆返回空数组，前端按"原文已更新，无法定位"提示
  const hit = chunks.find(item => item.chunkIndex === chunkIndex)
  if (!hit) return []
  const from = Math.max(0, chunkIndex - windowSize)
  const to = chunkIndex + windowSize
  return chunks
    .filter(item => item.chunkIndex >= from && item.chunkIndex <= to)
    .map(item => ({ ...item, current: item.chunkIndex === chunkIndex }))
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
  searchWithCandidates, // 连两路原始候选一起返回，用于验证 BM25 是否生效、以及后续接 rerank
  getBm25Stats, // 倒排体检：文档数 / 词表大小 / 平均长度
  tokenize, // 导出给单元测试验证分词行为
  getAllItems,
  getDocuments,
  getDocumentContext, // 引用定位：取片段前后邻域
  getCandidates, // 候选人清单：按 metadata.candidateId 聚合
  getJobs, // 岗位清单：按 metadata.jobId 聚合
  deleteDocument,
  deleteDocumentByFileId, // P2：按 metadata.fileId 精确删除（老条目回落 fileName 匹配）
  clearVectorIndex
}
