const { getEmbedding, getEmbeddings } = require('./rag-vector')
const { splitTextIntoChunks } = require('./rag-utils')

// 会话级临时附件：只存在内存里，不写入知识库向量索引
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24 小时未访问自动回收
const MAX_FILES_PER_SESSION = 5
const sessions = new Map() // sessionId -> { files: Map<fileId, file>, updatedAt }

function createFileId() {
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 清理过期会话
function cleanupExpired() {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL) sessions.delete(sessionId)
  }
}
setInterval(cleanupExpired, 60 * 60 * 1000).unref()

// 取会话；不存在时创建
function getSession(sessionId) {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { files: new Map(), updatedAt: Date.now() }
    sessions.set(sessionId, session)
  }
  session.updatedAt = Date.now()
  return session
}

/**
 * 解析文本并生成向量，存入会话
 * @param {string} sessionId
 * @param {{ fileName: string, text: string, size: number }} payload
 */
async function addSessionFile(sessionId, { fileName, text, size }) {
  const session = getSession(sessionId)
  if (session.files.size >= MAX_FILES_PER_SESSION) {
    throw new Error(`本次会话附件已达上限（${MAX_FILES_PER_SESSION} 个）`)
  }
  const chunks = splitTextIntoChunks(text || '', 800, 150).filter(item => item.trim())
  if (!chunks.length) throw new Error('未从文件中解析到有效文本')

  const vectors = await getEmbeddings(chunks)
  const file = {
    id: createFileId(),
    fileName,
    size,
    createdAt: Date.now(),
    chunks: chunks.map((content, index) => ({ content, vector: vectors[index] }))
  }
  session.files.set(file.id, file)
  return { id: file.id, fileName, size, chunkCount: chunks.length }
}

/**
 * 存入一张图片附件：图片不做切块和向量化，原图以 base64 保留，
 * 聊天时直接作为多模态内容发给视觉模型
 * @param {string} sessionId
 * @param {{ fileName: string, mimeType: string, buffer: Buffer, size: number }} payload
 */
function addSessionImage(sessionId, { fileName, mimeType, buffer, size }) {
  const session = getSession(sessionId)
  if (session.files.size >= MAX_FILES_PER_SESSION) {
    throw new Error(`本次会话附件已达上限（${MAX_FILES_PER_SESSION} 个）`)
  }
  const file = {
    id: createFileId(),
    fileName,
    size,
    kind: 'image',
    mimeType,
    base64: buffer.toString('base64'),
    createdAt: Date.now()
  }
  session.files.set(file.id, file)
  return { id: file.id, fileName, size, chunkCount: 0, kind: 'image' }
}

/**
 * 取本次会话的附件清单，供模型了解“用户上传了什么”
 * preview 用于让模型在未检索时也能判断附件大致内容
 */
function getSessionFiles(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return []
  session.updatedAt = Date.now()
  return Array.from(session.files.values()).map(file => ({
    fileId: file.id,
    fileName: file.fileName,
    size: file.size,
    kind: file.kind || 'doc',
    chunkCount: file.chunks?.length || 0,
    preview: file.kind === 'image'
      ? '（图片，内容随消息直接提供）'
      : (file.chunks || []).map(chunk => chunk.content).join('\n').slice(0, 300)
  }))
}

/**
 * 取本次会话的图片附件，供聊天请求拼装多模态消息
 * @returns {Array<{ fileName: string, mimeType: string, base64: string }>}
 */
function getSessionImages(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return []
  session.updatedAt = Date.now()
  return Array.from(session.files.values())
    .filter(file => file.kind === 'image')
    .map(file => ({ fileName: file.fileName, mimeType: file.mimeType, base64: file.base64 }))
}

/**
 * 删除会话中的一个附件
 * @returns {boolean} 是否删除成功
 */
function deleteSessionFile(sessionId, fileId) {
  const session = sessions.get(sessionId)
  if (!session) return false
  session.updatedAt = Date.now()
  return session.files.delete(fileId)
}

/**
 * 在会话附件中做语义检索
 * 向量已做 L2 归一化，点积即余弦相似度
 */
async function searchSessionFiles(sessionId, query, topK = 3) {
  const session = sessions.get(sessionId)
  if (!session || !session.files.size) return []

  const queryVector = await getEmbedding(query)
  const results = []
  for (const file of session.files.values()) {
    for (const chunk of file.chunks || []) { // 图片附件没有 chunks，跳过即可
      let score = 0
      for (let i = 0; i < queryVector.length; i++) score += queryVector[i] * chunk.vector[i]
      results.push({
        score,
        content: chunk.content,
        fileName: file.fileName,
        fileId: file.id
      })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK)
}

module.exports = {
  addSessionFile,
  addSessionImage,
  deleteSessionFile,
  getSessionFiles,
  getSessionImages,
  searchSessionFiles
}
