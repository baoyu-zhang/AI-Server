/**
 * session-files-store.js —— 会话「文档附件」的持久化仓库（第一阶段「能装」）
 *
 * ===========================================================================
 * 这个文件解决什么问题
 * ===========================================================================
 * 改造前 server/session-files.js 用一个进程内 Map 保存用户上传的 PDF / Word / TXT：
 *   sessions: Map<sessionId, { files: Map<fileId, { chunks: [{content, vector}] }> }>
 * 解析文本、切块、算 512 维向量都发生在内存里，服务一重启（Railway 每次 Redeploy、
 * 客户机房每次升级）这些代价最贵的数据就全部蒸发。表现很隐蔽：聊天记录还在
 * （threads/thread_runs 已落库）、图片也还在（image-store 已落盘），唯独追问
 * 「我刚传的简历里写了什么」时模型答不上来，用户会以为 AI 变笨了。
 *
 * 图片附件不需要本模块处理：image-store.js 早已落盘，且每次对话开始时
 * hydrateSessionImages() 会按消息快照里的 fileId 回填。这里只管文档附件。
 *
 * ===========================================================================
 * 存储设计：元数据入 SQLite，大块内容落磁盘 JSON
 * ===========================================================================
 * 一个 PDF 切块文本 + 512 维浮点向量，JSON 化后动辄几百 KB ~ 几 MB。
 * 若整份塞进 app.db 的 TEXT 列，库文件会迅速膨胀，而 backup.js 每次备份都要
 * VACUUM INTO 全库，备份耗时与体积会跟着涨。所以沿用项目里 chat_images 的既有范式：
 *
 *   session_files 表        → 只存可检索的元数据（谁、哪个会话、文件名、大小、时间）
 *   uploads/session-files/  → <file_id>.json 存切块文本与向量
 *
 * 文件名完全由 file_id 推导，因此表里不需要存绝对路径：整个数据卷搬到另一台机器、
 * APP_DATA_DIR 换了挂载点，只要目录结构还在就照样能读。
 *
 * ===========================================================================
 * 为什么是「惰性回填」而不是启动时全量加载
 * ===========================================================================
 * 客户用久了可能积累上千个会话的附件，启动时全读进内存既慢又占 RAM。
 * 实际访问模式是「打开哪个会话才用哪个」，所以由 session-files.js 的 getSession()
 * 在缓存未命中时按需 loadSessionDocs(sessionId) 整组读回，命中后照走内存，
 * 热路径的性能与改造前完全一致。
 */
const fs = require('node:fs')
const path = require('node:path')
const db = require('./db')            // 复用同一个 DatabaseSync 连接（迁移 v5 已建好表）
const { PATHS } = require('./paths')  // 所有可写目录的唯一来源，云上落在同一个 Volume 内

// 附件 JSON 的存放目录。paths.js 已经保证 UPLOAD_DIR 存在，这里再 mkdir 一次是幂等的：
// 老项目可能从来没有 uploads/session-files/ 这个子目录，不能等第一次写入时才报错。
const STORE_DIR = path.join(PATHS.UPLOAD_DIR, 'session-files')
fs.mkdirSync(STORE_DIR, { recursive: true })

/**
 * 由 fileId 推导磁盘路径。
 * fileId 由服务端生成（f-时间戳-随机串），不是用户输入；但仍做一次白名单校验，
 * 防止将来某个调用方把带 ../ 的 id 传进来造成路径穿越。
 * @param {string} fileId
 * @returns {string} 绝对路径
 */
function payloadPath(fileId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(fileId))) {
    throw new Error('非法的附件 id')
  }
  return path.join(STORE_DIR, `${fileId}.json`)
}

/**
 * 保存一个文档附件。
 *
 * 顺序刻意是「先写文件、再写库」：反过来若先写库，数据库里就会出现一条
 * 指向不存在 JSON 的孤儿记录，读回时该附件静默消失，比上传直接报错更难排查。
 * 文件写入用「临时文件 + rename」，避免进程在写一半时被打断留下截断的 JSON。
 *
 * @param {object} payload
 * @param {string} payload.fileId    附件 id
 * @param {string} payload.sessionId 所属会话
 * @param {string} payload.userId    所属用户（可为空串，见 db.js 迁移 v5 的说明）
 * @param {string} payload.fileName  原始文件名
 * @param {number} payload.size      原始文件字节数
 * @param {number} payload.createdAt 创建时间戳
 * @param {Array<{content:string, vector:Array<number>|Float32Array}>} payload.chunks 切块与向量
 */
function saveDocFile({ fileId, sessionId, userId = '', fileName, size = 0, createdAt = Date.now(), chunks = [] }) {
  // ===== 为什么要 Array.from(vector) =====
  // getEmbeddings() 返回的可能是 Float32Array。JSON.stringify(Float32Array) 不会得到数组，
  // 而是 {"0":0.12,"1":-0.03,...} 这样的对象；读回来再和查询向量做点积时会得到 NaN，
  // 表现是「附件检索永远返回乱序/空结果」，极难定位。统一转成普通数组一劳永逸。
  const normalized = chunks.map(chunk => ({
    content: chunk.content,
    vector: Array.from(chunk.vector)
  }))

  const target = payloadPath(fileId)
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, fileId, chunks: normalized }), 'utf8')
    fs.renameSync(tmp, target) // 同一文件系统内 rename 是原子的：读者只会看到完整旧文件或完整新文件
  } finally {
    // 无论成功失败都别留下 .tmp 垃圾（rename 成功后 tmp 已不存在，force:true 不会报错）
    fs.rmSync(tmp, { force: true })
  }

  // INSERT OR REPLACE：同一个 fileId 重复保存（例如上传重试）以最后一次为准，不报主键冲突
  db.prepare(`
    INSERT OR REPLACE INTO session_files (file_id, session_id, user_id, file_name, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(fileId, sessionId, userId, fileName, size, createdAt)
}

/**
 * 按会话读回全部文档附件，供内存缓存未命中时回填。
 * 单个文件损坏（磁盘位翻转、人工误删、旧版本格式不兼容）只跳过这一个，
 * 不能让一次 JSON.parse 异常把整个会话的其它附件全部拖垮。
 * @param {string} sessionId
 * @returns {Array<{id:string,fileName:string,size:number,createdAt:number,chunks:Array}>}
 */
function loadSessionDocs(sessionId) {
  const rows = db.prepare(`
    SELECT file_id, file_name, size, created_at
      FROM session_files WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId)

  const out = []
  for (const row of rows) {
    try {
      const payload = JSON.parse(fs.readFileSync(payloadPath(row.file_id), 'utf8'))
      if (!Array.isArray(payload.chunks)) continue
      out.push({
        id: row.file_id,
        fileName: row.file_name,
        size: row.size,
        createdAt: row.created_at,
        chunks: payload.chunks
      })
    } catch {
      // 读不到就跳过；下一次定时清理会把这条元数据一起删掉（见 pruneOlderThan）
      console.warn(`[session-files-store] 附件内容缺失或已损坏，已跳过：${row.file_id}`)
    }
  }
  return out
}

/**
 * 删除一个附件的元数据与磁盘内容。
 * 对「图片附件」调用是无害的空操作：图片不写 session_files 表、也没有对应 JSON，
 * delete 影响 0 行、rmSync(force:true) 不报错，因此调用方不需要先判断 kind。
 * @param {string} fileId
 */
function deleteDocFile(fileId) {
  db.prepare('DELETE FROM session_files WHERE file_id = ?').run(fileId)
  fs.rmSync(payloadPath(fileId), { force: true })
}

/**
 * 删除某用户的全部文档附件（合规「删除用户数据」用）。
 * 先查后删是为了能准确删掉磁盘文件；只 DELETE 表行会留下一堆永远没人读的 JSON。
 * @param {string} userId
 * @returns {number} 删除条数
 */
function deleteByUser(userId) {
  const rows = db.prepare('SELECT file_id FROM session_files WHERE user_id = ?').all(userId)
  for (const row of rows) fs.rmSync(payloadPath(row.file_id), { force: true })
  const res = db.prepare('DELETE FROM session_files WHERE user_id = ?').run(userId)
  return res.changes
}

/**
 * 清理超过 N 天的附件（默认保留 30 天）。
 * 会话附件是「临时」语义：不进知识库、不长期归档，但「临时」不能再等于
 * 「进程一退出就没」——由明确的保留期来定义，运维可通过环境变量调整。
 * 由 session-files.js 的每小时定时任务调用，低频、失败不影响业务。
 * @param {number} [days]
 * @returns {number} 删除条数
 */
function pruneOlderThan(days = 30) {
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000
  const rows = db.prepare('SELECT file_id FROM session_files WHERE created_at < ?').all(cutoff)
  for (const row of rows) fs.rmSync(payloadPath(row.file_id), { force: true })
  const res = db.prepare('DELETE FROM session_files WHERE created_at < ?').run(cutoff)
  return res.changes
}

/**
 * 保证单个会话的持久化附件不超过 keep 个，超出的删最旧的。
 *
 * 为什么需要：改造前内存 Map 重启即清空，「最多 5 个」的限制自然按进程生命周期重置；
 * 落盘之后同一个 sessionId 跨重启会一直累积，若不裁剪，用户用同一个会话聊一个月
 * 就会在第 6 次上传时被永久拒绝。语义要保持「本次会话最多 5 个附件」，
 * 所以每次新增后按时间倒序保留最新 keep 个，其余连同磁盘 JSON 一起删掉。
 * @param {string} sessionId
 * @param {number} [keep]
 * @returns {number} 被裁掉的条数
 */
function trimSession(sessionId, keep = 5) {
  const rows = db.prepare(`
    SELECT file_id FROM session_files WHERE session_id = ? ORDER BY created_at DESC
  `).all(sessionId)
  let removed = 0
  for (const row of rows.slice(keep)) {
    db.prepare('DELETE FROM session_files WHERE file_id = ?').run(row.file_id)
    fs.rmSync(payloadPath(row.file_id), { force: true })
    removed += 1
  }
  return removed
}

module.exports = {
  STORE_DIR,
  saveDocFile,
  loadSessionDocs,
  deleteDocFile,
  deleteByUser,
  pruneOlderThan,
  trimSession
}
