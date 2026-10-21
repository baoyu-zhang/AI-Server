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
}

/**
 * 语义检索：输入问题，返回topK相似片段
 * @param {string} query 用户查询文本
 * @param {number} topK
 */
async function searchVector(query, topK = 3) {
  const queryVector = await getEmbedding(query);
  // Vectra 0.15 的签名是 queryItems(vector, query, topK, filter, isBm25)，第二个参数是查询文本
  const resultItems = await index.queryItems(queryVector, query, topK);
  return resultItems.map(item => ({
    score: item.score,
    content: item.item.metadata.content,
    fileName: item.item.metadata.fileName
  }))
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
  return ids.length
}

/**
 * 【可选CRUD：清空整个向量库】
 */
async function clearVectorIndex() {
  await index.deleteIndex();
  await index.createIndex();
}

module.exports = {
  initVectorStore,
  getEmbedding,
  getEmbeddings,
  batchInsertEmbedding,
  searchVector,
  getAllItems,
  getDocuments,
  deleteDocument,
  clearVectorIndex
}
