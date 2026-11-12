/**
 * candidates-store.js —— 候选人状态与最近一次评分结果的持久化
 *
 * ===== 为什么存 JSON，而不是赛回向量库 =====
 * 向量库擅长的是"这段文字和这句话有多像"，它不会做"按状态筛选""按分数排序""整体读出 20 条"。
 * 状态与分数是关系型需求，塞进 metadata 只会让每次列表都全量扫一遍向量库。
 * 这个文件就是招聘场景里最小的"数据库"：一张表，一个主键（candidateId），几条业务字段。
 *
 * ===== 并发为什么需要写串行化 =====
 * Express 是并发的：两个请求同时改状态时，如果各自"读文件 → 改内存 → 写文件"，
 * 后写的那个会把先写的覆盖掉（经典 lost update）。这里的做法是——
 * 内存只有一份（cache），写操作排队（writeChain），最后用 rename 原子替换。
 *
 * 本模块不做 HTTP、不认识 express，可被脚本直接调用（评测、批量导入都靠这一点）。
 */
const fs = require('node:fs')
const path = require('node:path')

const DATA_DIR = path.join(__dirname, 'data')
// 允许用环境变量换一份数据文件：测试脚本要跑"改状态/评分写回"这些有副作用的用例，
// 直接写正式表会把演示数据搅乱，指到临时文件上就能随便造。
const STORE_FILE = process.env.CANDIDATES_STORE_FILE || path.join(DATA_DIR, 'candidates.json')

/**
 * 状态枚举。写死成白名单有两个用处：
 *   ① 模型偶尔会自造"约面中""通过初筛"这类状态，白名单直接拦住；
 *   ② 前端标签颜色只能映射有限个值，状态自由发挥会让界面崩。
 */
const CANDIDATE_STATUS = ['待筛选', '初筛通过', '待面试', '已面试', '已发offer', '已淘汰']

/** 内存缓存：第一次读盘后常驻。null 表示还没加载过（注意不能用 [] 代替，那样区分不了"空表"和"没读过"） */
let cache = null
/** 写操作队列：所有落盘串成一条 Promise 链，天然避免并发覆盖 */
let writeChain = Promise.resolve()

/**
 * 读取全部候选人记录（带缓存）
 * @returns {Promise<Array>}
 */
async function loadAll() {
  if (cache) return cache
  try {
    const raw = await fs.promises.readFile(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    // 文件被手工改坏时不能让整个服务起不来：解析结果不合预期就当空表
    cache = Array.isArray(parsed?.candidates) ? parsed.candidates : []
  } catch (err) {
    // 首次运行时文件不存在是正常的，不算错误
    if (err.code !== 'ENOENT') console.error('[candidates] 读取失败，按空表处理：', err.message)
    cache = []
  }
  return cache
}

/**
 * 落盘：临时文件 + rename 原子替换
 * 为什么不用 writeFile 直接覆盖：进程在写入中途退出会留下半截 JSON，
 * 下次启动整个候选人表就废了。rename 在同一分区上是原子操作，要么旧文件，要么新文件。
 */
function persist() {
  writeChain = writeChain
    .then(async () => {
      // 目录要按 STORE_FILE 反推，而不是固定用 DATA_DIR——测试时文件在 /tmp 下
      await fs.promises.mkdir(path.dirname(STORE_FILE), { recursive: true })
      const tmp = `${STORE_FILE}.tmp`
      const payload = JSON.stringify({ candidates: cache }, null, 2)
      await fs.promises.writeFile(tmp, payload, 'utf8')
      try {
        await fs.promises.rename(tmp, STORE_FILE)
      } catch (err) {
        // rename 覆盖已存在文件，在部分环境里会被拦：容器只读挂载、Windows 上文件被占用、
        // 以及某些安全软件/沙箱的删除保护（EPERM/EXDEV/EACCES）。
        // 这里必须退化成直接覆盖写：丢掉"原子替换"只影响极端掉电场景，
        // 而不退化的后果是"内存里改了、磁盘上没改"——重启后状态与分数全部消失，
        // 用户看到的现象是"改完状态刷新就没了"，且日志里只有一行 rename 失败。
        console.warn(`[candidates] rename 失败（${err.code || err.message}），改为直接覆盖写`)
        await fs.promises.writeFile(STORE_FILE, payload, 'utf8')
        await fs.promises.rm(tmp, { force: true }).catch(() => {})
      }
    })
    .catch(err => {
      // 落盘失败不能把异常抛给调用方：状态已经改在内存里了，
      // 抛出去会让用户看到"操作失败"，但实际内存已变，前后更不一致。记日志，下次写再补。
      console.error('[candidates] 写入失败：', err.message)
    })
  return writeChain
}

/**
 * 列表：按岗位 / 状态筛选，并按登录用户圈定可见范围
 * 可见性规则与向量库一致：记录带 userId 时只归本人，没带 userId 的旧记录对所有人可见。
 * userId 不传（服务端脚本、测试）时不过滤，行为与鉴权上线前完全一致。
 * 筛选放在 store 里而不是让调用方 filter，是因为后面要加排序、分页时只需改一处。
 * @param {{jobId?: string, status?: string, userId?: string}} [filter]
 * @returns {Promise<Array>}
 */
async function listCandidates(filter = {}) {
  const all = await loadAll()
  const { jobId, status, userId } = filter || {}
  return all
    .filter(item => (!userId || !item.userId || item.userId === userId))
    .filter(item => (jobId ? item.jobId === jobId : true))
    .filter(item => (status ? item.status === status : true))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/**
 * 按 candidateId 查一条（带用户可见性约束）
 * @param {string} candidateId
 * @param {string} [userId]
 * @returns {Promise<object|null>}
 */
async function getCandidate(candidateId, userId) {
  const all = await loadAll()
  return all.find(item =>
    item.candidateId === candidateId && (!userId || !item.userId || item.userId === userId)
  ) || null
}

/**
 * 新增或更新候选人（上传简历时调用）
 *
 * 为什么是 upsert 而不是 insert：同一个候选人可能先传旧版简历、再传优化版，
 * candidateId 不变就必须合并成一条，否则列表里会出现两个"张三"。
 * 语义上还顺带保证了"状态不丢"——重新上传简历不会把已有的"已面试"重置回"待筛选"。
 *
 * @param {object} params
 * @param {string} params.candidateId
 * @param {string} [params.name] 展示名，缺省用文件名去掉后缀
 * @param {string} [params.fileName] 最近一次上传的简历文件名
 * @param {string} [params.jobId] 应聘岗位
 * @param {string} [params.userId] 归属用户：candidateId 是用户自己起的，不同用户可以重名，
 *   所以记录的主键事实上是 (userId, candidateId) 二元组；不带 userId 的旧记录会被"收养"
 * @returns {Promise<object>} 合并后的记录
 */
async function upsertCandidate({ candidateId, name, fileName, jobId, userId }) {
  const id = String(candidateId || '').trim()
  if (!id) throw new Error('candidateId 不能为空')
  const all = await loadAll()
  // 只合并"自己名下的或无主的"：别人名下的同 id 记录对当前用户必须像不存在一样
  const existing = all.find(item =>
    item.candidateId === id && (!userId || !item.userId || item.userId === userId)
  )
  const now = Date.now()

  if (existing) {
    // 只更新"这次带了的字段"：没传 jobId 说明这次上传没指定岗位，不该把原来的岗位抹掉
    if (name) existing.name = name
    if (fileName) existing.fileName = fileName
    if (jobId) existing.jobId = jobId
    if (userId && !existing.userId) existing.userId = userId // 无主旧记录归当前用户收养
    existing.updatedAt = now
    await persist()
    return existing
  }

  const record = {
    candidateId: id,
    userId: userId || '',
    // 展示名退回文件名（去掉后缀），至少比裸 id 好认
    name: name || String(fileName || id).replace(/\.[^.]+$/, ''),
    fileName: fileName || '',
    jobId: jobId || '',
    status: CANDIDATE_STATUS[0], // 新入库一律"待筛选"
    lastScore: null,
    lastVerdict: '',
    createdAt: now,
    updatedAt: now
  }
  all.push(record)
  await persist()
  return record
}

/**
 * 改状态。这是审批工具 resume 后真正执行的动作。
 * @param {string} candidateId
 * @param {string} status
 * @returns {Promise<{ok: boolean, record?: object, error?: string}>}
 *   ok:false 用返回值表达而不是抛异常——审批工具的返回值会直接回填给模型，
 *   抛异常会被包成"工具执行失败"，模型看不到"为什么失败"，也就不会自我纠正。
 */
async function updateCandidateStatus(candidateId, status, userId) {
  const id = String(candidateId || '').trim()
  const next = String(status || '').trim()
  if (!id) return { ok: false, error: '缺少 candidateId' }
  if (!CANDIDATE_STATUS.includes(next)) {
    return { ok: false, error: `状态「${next}」不在允许范围内，只能是：${CANDIDATE_STATUS.join(' / ')}` }
  }
  const all = await loadAll()
  // 只能改自己名下的：模型编一个别人名下的 candidateId，这里必须像"不存在"一样拒绝
  const record = all.find(item =>
    item.candidateId === id && (!userId || !item.userId || item.userId === userId)
  )
  // 只允许改已登记的候选人：否则模型凭空编一个 id 就能往表里塞脏数据
  if (!record) return { ok: false, error: `候选人「${id}」不存在，请先上传该候选人的简历` }
  if (record.status === next) {
    // 幂等：重复 resume、或用户重复说同一句，都不该产生一次"变更"
    return { ok: true, record, unchanged: true }
  }
  const from = record.status
  record.status = next
  record.updatedAt = Date.now()
  await persist()
  return { ok: true, record, from }
}

/**
 * 记录最近一次评分结果（评分工具调用成功后写回）
 * 只存结论不存明细：明细在当轮的 tool-result 里，存下来会让 JSON 迅速膨胀，且没有查询场景。
 * @param {string} candidateId
 * @param {{score: number, verdict: string, jobId?: string}} result
 */
async function recordScore(candidateId, { score, verdict, jobId } = {}, userId) {
  const id = String(candidateId || '').trim()
  if (!id) return null
  const all = await loadAll()
  let record = all.find(item =>
    item.candidateId === id && (!userId || !item.userId || item.userId === userId)
  )
  if (!record) {
    // 没登记过也要留痕：评分能跑通说明简历确实在库里，只是可能是直接调 API 入的库
    record = {
      candidateId: id,
      userId: userId || '',
      name: id,
      fileName: '',
      jobId: jobId || '',
      status: CANDIDATE_STATUS[0],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    all.push(record)
  } else if (userId && !record.userId) {
    record.userId = userId // 无主旧记录顺带收养
  }
  if (typeof score === 'number') record.lastScore = score
  if (verdict) record.lastVerdict = verdict
  if (jobId) record.jobId = jobId
  record.scoredAt = Date.now()
  record.updatedAt = Date.now()
  await persist()
  return record
}

module.exports = {
  CANDIDATE_STATUS,
  listCandidates,
  getCandidate,
  upsertCandidate,
  updateCandidateStatus,
  recordScore
}
