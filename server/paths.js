/**
 * paths.js —— 所有"运行时会变的数据"的统一根目录
 *
 * ===== 为什么需要这个文件 =====
 * 改造前，数据散落在 5 个互不相干的地方：server/data/（SQLite、图片、密钥、候选人）、
 * server/uploads/、server/vector-index/、server/logs/、以及 embedding 模型的全局缓存目录。
 * 本机跑毫无问题，但一上 PaaS（Railway / Fly / Render）就致命：
 *   这些平台的容器文件系统是「临时的」，每次部署重建容器就全没了；
 *   能持久化的只有挂载卷（Volume），而 Railway 每个服务**只能挂一个卷**。
 * 所以必须把所有可写状态收敛到同一个根目录，部署时只挂这一个目录即可。
 *
 * ===== 本地与云上的区别 =====
 *   本机：APP_DATA_DIR 不设 → 默认 server/data/，行为和改造前一致（旧数据不会丢）。
 *   Railway：设 APP_DATA_DIR=/app/data，并把 Volume 挂到 /app/data。
 *
 * ===== 兼容旧环境变量 =====
 * APP_DB_FILE / CHAT_IMAGE_DIR / BACKUP_DIR / CANDIDATES_STORE_FILE 这些原有的覆盖项
 * 全部保留优先级，测试脚本仍可把数据指到 /tmp，不会被这个模块破坏。
 *
 * ===== 只放"状态"，不放"代码" =====
 * 前端构建产物 web/dist 属于代码，不在这个目录下——它由构建阶段生成，不进卷。
 */
const path = require('node:path')
const fs = require('node:fs')

// 根目录：环境变量给的是绝对路径（云平台都这么给），也允许给相对 server/ 的路径
const RAW_DIR = process.env.APP_DATA_DIR || path.join(__dirname, 'data')
const DATA_DIR = path.isAbsolute(RAW_DIR) ? RAW_DIR : path.resolve(__dirname, RAW_DIR)

/**
 * 兼容开关：只有显式设置了 APP_DATA_DIR（云平台）才启用「单卷目录」布局。
 *
 * 为什么不能直接把本机也改成新布局：本机 server/ 下已经积累了真实数据——
 * uploads/、vector-index/、logs/ 都在 server/ 根，模型缓存在 ~/.cache。
 * 路径一改，知识库会「看起来全没了」、上传原件读不到、模型还要重下几百 MB。
 * 这类「不是丢数据、只是换了路径」的假故障在复盘文档 3.9 里已经踩过一次。
 * 所以：本机保持旧布局零迁移，云上才收敛到一个卷。
 */
const UNIFIED = Boolean(process.env.APP_DATA_DIR)
const SUB_DIRS = {
  uploads: UNIFIED ? path.join(DATA_DIR, 'uploads') : path.join(__dirname, 'uploads'),
  vectorIndex: UNIFIED ? path.join(DATA_DIR, 'vector-index') : path.join(__dirname, 'vector-index'),
  images: path.join(DATA_DIR, 'images'), // 旧值就是 server/data/images，两种布局天然一致
  backups: path.join(DATA_DIR, 'backups'), // 旧值 = dirname(app.db)/backups，同样一致
  logs: UNIFIED ? path.join(DATA_DIR, 'logs') : path.join(__dirname, 'logs'),
  // 本机不接管模型缓存：沿用 transformers.js 默认的 ~/.cache，已下载的模型不用重下
  modelCache: UNIFIED ? path.join(DATA_DIR, 'transformers-cache') : null
}
for (const dir of Object.values(SUB_DIRS)) {
  if (dir) fs.mkdirSync(dir, { recursive: true })
}

// 各文件的最终路径：旧环境变量优先，没给就落到统一目录下
const PATHS = {
  DATA_DIR,
  DB_FILE: process.env.APP_DB_FILE || path.join(DATA_DIR, 'app.db'),
  IMAGE_DIR: process.env.CHAT_IMAGE_DIR || SUB_DIRS.images,
  IMAGE_SECRET: path.join(DATA_DIR, '.image-secret'),
  BACKUP_DIR: process.env.BACKUP_DIR || SUB_DIRS.backups,
  CANDIDATES_FILE: process.env.CANDIDATES_STORE_FILE || path.join(DATA_DIR, 'candidates.json'),
  UPLOAD_DIR: SUB_DIRS.uploads,
  VECTOR_INDEX_DIR: SUB_DIRS.vectorIndex,
  LOG_DIR: SUB_DIRS.logs,
  MODEL_CACHE_DIR: SUB_DIRS.modelCache
}

/** 是否跑在"云平台"上：Railway 会注入这个变量，本地没有 */
const IS_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID)

module.exports = { PATHS, IS_RAILWAY }
