/**
 * session-files.js —— 会话级附件（本次对话临时用，不进知识库向量索引）
 *
 * ===========================================================================
 * 第一阶段「能装」改造：从「纯内存」升级为「磁盘为准 + 内存做缓存」
 * ===========================================================================
 * 改造前本文件只有一个进程内 Map：用户上传 PDF → 解析文本 → 切块 → 算 512 维向量，
 * 全部结果只活在内存里，进程重启 / Railway Redeploy / 客户机房升级后全部蒸发。
 * 图片附件不受影响（image-store.js 早已落盘，靠 hydrateSessionImages 回填），
 * 缺的正是文档附件这一块，也是对外交付时最容易被客户当场发现的数据丢失。
 *
 * 现在的结构：
 *   磁盘（session-files-store.js）  = 权威数据源，SQLite 元数据 + uploads 里的 JSON
 *   内存（本文件的 sessions Map）  = 热缓存，命中就走原来的快路径
 *   getSession()                  = 唯一的入口，缓存未命中时按 sessionId 整组回填
 *
 * 因此下面所有原本写 `sessions.get(sessionId)` 的读函数都统一改成 getSession()：
 * 只要漏改一处，那一处就会在重启后返回空，形成「有的功能看得见附件、有的看不见」的怪 bug。
 *
 * ===========================================================================
 * 两个时间尺度，别混淆
 * ===========================================================================
 *   内存淘汰 SESSION_TTL（24h）：只是把不用的缓存从 RAM 里挪走，**绝不删数据**，
 *                               下次访问会从磁盘重新读回来。
 *   磁盘保留 RETENTION_DAYS（30d）：真正的数据生命周期，由 pruneOlderThan 每小时清理。
 * 改造前这两个是同一件事（淘汰即删除），这正是「刷新/重启就没了」的根因。
 */
const { getEmbedding, getEmbeddings } = require('./rag-vector')
const { splitTextIntoChunks } = require('./rag-utils')
const store = require('./session-files-store')

const SESSION_TTL = 24 * 60 * 60 * 1000 // 24 小时未访问 → 只淘汰内存缓存，磁盘数据不动
const MAX_FILES_PER_SESSION = 5         // 单个会话最多 5 个附件（跨重启累计也按这个数裁剪）
const RETENTION_DAYS = Math.max(1, Number(process.env.SESSION_FILE_RETENTION_DAYS || 30))
const sessions = new Map() // sessionId -> { files: Map<fileId, file>, updatedAt }

/** 生成附件 id：时间戳 + 随机串，全局唯一且天然按时间有序 */
function createFileId() {
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 周期性维护（每小时一次）：
 * ① 内存：淘汰 24h 未访问的缓存条目，控制 RAM；
 * ② 磁盘：删除超过保留期的附件，控制卷占用。
 * 两件事分开做是有意的——以前「清理内存」等于「删用户数据」，现在不是了。
 * unref()：定时器不拖住进程退出（否则 CLI 脚本、测试进程会挂住不结束）。
 */
function cleanupExpired() {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL) sessions.delete(sessionId)
  }
  try {
    const removed = store.pruneOlderThan(RETENTION_DAYS)
    if (removed > 0) console.log(`[session-files] 已清理超过 ${RETENTION_DAYS} 天的附件 ${removed} 个`)
  } catch (err) {
    // 清理是后台维护，失败只告警，绝不影响正在进行的对话
    console.warn('[session-files] 清理过期附件失败：', err?.message)
  }
}
setInterval(cleanupExpired, 60 * 60 * 1000).unref()

/**
 * 取会话（唯一的读写入口）。
 * 缓存未命中时从磁盘整组回填文档附件；图片仍由 hydrateSessionImages() 单独回填，
 * 因为图片的权威源是 image-store（含签名 URL 与 base64），不是本模块的 JSON。
 *
 * 为什么要惰性：客户用久了可能积累上千个会话，启动时全量加载既慢又白占内存，
 * 而真实访问模式是「打开哪个会话才用哪个」。第一次访问多一次 SQL + 读文件，之后全是内存。
 */
function getSession(sessionId) {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { files: new Map(), updatedAt: Date.now() }
    // 只回填最近 MAX_FILES_PER_SESSION 个，与上传时的裁剪规则保持一致，
    // 避免历史上累积过多的旧附件把内存撑大、也避免一上来就触发「已达上限」。
    for (const file of store.loadSessionDocs(sessionId).slice(-MAX_FILES_PER_SESSION)) {
      session.files.set(file.id, file)
    }
    sessions.set(sessionId, session)
  }
  session.updatedAt = Date.now()
  return session
}

/**
 * 解析文本并生成向量，存入会话并落盘。
 * @param {string} sessionId
 * @param {{ fileName: string, text: string, size: number }} payload
 * @param {string} [userId] 归属用户；由 /api/session-files/upload 从 req.user 传入，
 *                          不采信客户端参数。存下来是为了合规「删除用户全部数据」时能清干净。
 */
async function addSessionFile(sessionId, { fileName, text, size }, userId = '') {
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

  // 先落盘再进内存：写盘失败就让上传明确报错，不能给用户「上传成功但重启就没」的假象。
  // 卷不可写属于部署故障，早暴露比晚发现好；store 内部已处理向量序列化与原子写。
  store.saveDocFile({
    fileId: file.id,
    sessionId,
    userId,
    fileName,
    size,
    createdAt: file.createdAt,
    chunks: file.chunks
  })
  // 裁剪同会话的历史附件（跨重启累计的场景），保持「最多 5 个」的语义
  store.trimSession(sessionId, MAX_FILES_PER_SESSION)

  session.files.set(file.id, file)
  return { id: file.id, fileName, size, chunkCount: chunks.length }
}

/**
 * 存入一张图片附件：图片不做切块和向量化，原图以 base64 保留，
 * 聊天时直接作为多模态内容发给视觉模型。
 *
 * 图片本体由 image-store.js 落盘（调用方先 saveImage 再进本函数），
 * 所以这里仍然只写内存缓存；服务重启后靠 hydrateSessionImages 按 fileId 回填，
 * **不需要**写 session_files 表，否则一张图会被存两份。
 *
 * fileId 可由调用方指定：上传时先落盘到 image-store（生成 id），再回填到内存会话，
 * 两边用同一个 id，前端拿到的图片 URL 才能和会话里的图片对上。
 * @param {string} sessionId
 * @param {{ fileId?: string, fileName: string, mimeType: string, buffer: Buffer, size: number, url?: string }} payload
 */
function addSessionImage(sessionId, { fileId, fileName, mimeType, buffer, size, url }) {
  const session = getSession(sessionId)
  if (session.files.size >= MAX_FILES_PER_SESSION) {
    throw new Error(`本次会话附件已达上限（${MAX_FILES_PER_SESSION} 个）`)
  }
  const file = {
    id: fileId || createFileId(),
    fileName,
    size,
    kind: 'image',
    mimeType,
    base64: buffer.toString('base64'),
    url, // 签名地址：刷新/换设备后前端仍能展示这张图
    createdAt: Date.now()
  }
  session.files.set(file.id, file)
  return { id: file.id, fileName, size, chunkCount: 0, kind: 'image', url }
}

/**
 * 从图片仓库回填会话内存（服务重启后必备）
 *
 * 内存会话一重启就空，但对话快照里 attachment 块仍带着 fileId。
 * 用户接着追问"这张图里的表格第一行是什么"，如果没有回填，
 * 视觉模型根本收不到图——表现是模型突然"看不见"之前发的图片。
 * 只补会话里缺的，不覆盖已有内存副本（磁盘是权威源，但内存里有更省事的 base64）。
 *
 * 注意这里用 getSession：顺带把该会话的文档附件也一起惰性读回，一次调用两边齐全。
 * @param {string} sessionId
 * @param {string[]} fileIds
 * @returns {number} 实际回填数量
 */
function hydrateSessionImages(sessionId, fileIds = []) {
  if (!Array.isArray(fileIds) || !fileIds.length) return 0
  const { getImage, readImage, urlFor } = require('./image-store') // 延迟 require：避免模块加载顺序互相牵制
  const session = getSession(sessionId)
  let restored = 0
  for (const fileId of fileIds) {
    if (!fileId || session.files.has(fileId)) continue
    if (!getImage(fileId)) continue // 没落过盘（旧图/已清理）就跳过
    if (session.files.size >= MAX_FILES_PER_SESSION) break
    const raw = readImage(fileId)
    if (!raw) continue
    session.files.set(fileId, {
      id: fileId,
      fileName: getImage(fileId).file_name,
      size: raw.buffer.length,
      kind: 'image',
      mimeType: raw.mime,
      base64: raw.buffer.toString('base64'),
      url: urlFor(fileId),
      createdAt: Date.now()
    })
    restored += 1
  }
  return restored
}

/**
 * 取本次会话的附件清单，供模型了解"用户上传了什么"。
 * preview 用于让模型在未检索时也能判断附件大致内容。
 */
function getSessionFiles(sessionId) {
  const session = getSession(sessionId)
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
  const session = getSession(sessionId)
  return Array.from(session.files.values())
    .filter(file => file.kind === 'image')
    .map(file => ({ fileId: file.id, fileName: file.fileName, mimeType: file.mimeType, base64: file.base64, url: file.url }))
}

/**
 * 删除会话中的一个附件（内存 + 持久化一起删）。
 * 对图片附件，store.deleteDocFile 是空操作（图片不在该表里），
 * 图片本体仍由 image-store 的 pruneImages 按自己的生命周期清理，与改造前一致。
 * @returns {boolean} 是否删除成功
 */
function deleteSessionFile(sessionId, fileId) {
  const session = getSession(sessionId)
  const removed = session.files.delete(fileId)
  if (removed) store.deleteDocFile(fileId)
  return removed
}

/**
 * 在会话附件中做语义检索。
 * 向量已做 L2 归一化，点积即余弦相似度。
 * 从磁盘回填的 chunks 里 vector 是普通数组（store 已 Array.from 过），
 * 与内存里刚算出的 Float32Array 在下面的逐元素乘法里行为一致。
 */
async function searchSessionFiles(sessionId, query, topK = 3) {
  const session = getSession(sessionId)
  if (!session.files.size) return []

  const queryVector = await getEmbedding(query)
  const results = []
  for (const file of session.files.values()) {
    for (const [index, chunk] of (file.chunks || []).entries()) { // 图片附件没有 chunks，跳过即可
      let score = 0
      for (let i = 0; i < queryVector.length; i++) score += queryVector[i] * chunk.vector[i]
      results.push({
        score,
        content: chunk.content,
        fileName: file.fileName,
        fileId: file.id,
        chunkIndex: index // 数组下标即原文顺序，引用定位取邻域时用它
      })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK)
}

/**
 * 引用定位：取附件中某片段的前后邻域（数组顺序即原文顺序）
 * @param {string} sessionId
 * @param {string} fileId
 * @param {number} chunkIndex 被引片段序号
 * @param {number} [windowSize=1] 前后各取几个片段
 * @returns {Array<{chunkIndex: number, content: string, current: boolean}>|null} 附件不存在返回 null
 */
function getSessionFileContext(sessionId, fileId, chunkIndex, windowSize = 1) {
  const session = getSession(sessionId)
  const file = session.files.get(fileId)
  if (!file || !Array.isArray(file.chunks)) return null
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= file.chunks.length) return null
  const from = Math.max(0, chunkIndex - windowSize)
  const to = Math.min(file.chunks.length - 1, chunkIndex + windowSize)
  const out = []
  for (let i = from; i <= to; i++) {
    out.push({ chunkIndex: i, content: file.chunks[i].content, current: i === chunkIndex })
  }
  return out
}

module.exports = {
  addSessionFile,
  addSessionImage,
  hydrateSessionImages,
  deleteSessionFile,
  getSessionFiles,
  getSessionImages,
  searchSessionFiles,
  getSessionFileContext
}
