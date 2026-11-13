/**
 * db.js —— 内置 SQLite 数据层（node:sqlite，Node 22+，零依赖）
 *
 * ===== 为什么选内置模块而不是 better-sqlite3 / PG =====
 * node:sqlite 随 Node 22 内置，没有原生编译问题（better-sqlite3 装错 Node 版本会直接起不来），
 * 也没有"本机要跑一个数据库服务"的运维负担。单文件、WAL 模式，M1 的用户/会话/对话落库够用。
 * 将来切 PG 时只动这一个文件——表结构是标准 SQL，上层全走 prepare().get/all/run。
 *
 * ===== 管哪些表 =====
 *   users       注册用户（scrypt 密码哈希，见 auth.js）
 *   sessions    登录会话（opaque token 存库：可撤销、无签名算法坑，30 天过期）
 *   threads     对话线程（服务端历史的第一级：列表页用）
 *   thread_runs 每轮 run 的完整消息快照（读历史时取 thread 最新一轮的快照还原整段对话）
 *   audit_log   操作审计（谁在什么时候批准了什么写操作、登录失败多少次）
 *   chat_images 聊天图片元数据（图片本体在 data/images，见 image-store.js）
 *   session_files 会话文档附件元数据（切块文本与向量在 uploads/session-files/*.json）
 *
 * ===== 审计为什么单独一张表 =====
 * 会话快照里也能看到"批了什么"，但那是对话数据：用户看不到别人的、删线程就没了、
 * 结构化查询还得解析 JSON。审计要的是反过来——只追加、可按人/按动作/按时间检索。
 * 因此独立成表，写入点只有一处（executeApprovalTool），不改就查得到。
 *
 * 路径可用 APP_DB_FILE 覆盖：测试脚本指到 /tmp，不碰正式库。
 *
 * ===== 版本化迁移（PRAGMA user_version + 有序 MIGRATIONS） =====
 * 早期是四个散落的「PRAGMA table_info 探测 → 缺列才 ALTER」块，虽然幂等，但存在两个问题：
 *   ① 看不出「当前库跑到第几版」，出事故时无法回答「这个客户是不是漏了某次迁移」；
 *   ② 以后每加一次改动就多一个平铺的块，二十个之后没人敢动。
 * 现在统一收进文件末尾的 MIGRATIONS 数组，每项带 version / name / up()，
 * 启动时读 PRAGMA user_version，只跑比当前版本新的那些，跑完把版本号写回。
 * 每个 up() 内部仍保留列探测（双保险）：老库版本是 0，会重跑 1~5 次，但探测到列已存在就跳过，
 * 所以从任何历史版本升级到 SCHEMA_VERSION 都是安全的、可重复执行的。
 *
 * 版本台账：
 *   1  thread_runs.state      —— 恢复历史会话时一并还原共享状态
 *   2  users.role             —— RBAC 管理员
 *   3  users.quota_daily      —— 用户级每日 Token 配额
 *   4  users.disabled         —— P2「产品化」账号停用开关
 *   5  session_files 表       —— 第一阶段「能装」：会话附件不再只活在内存里
 */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')

// 路径统一由 paths.js 决定：本机仍是 server/data，云上则指向挂载卷（见 paths.js 顶部说明）。
// 仍支持旧的 APP_DB_FILE 覆盖，测试脚本可以指到 /tmp 而不碰正式库。
const DB_FILE = require('./paths').PATHS.DB_FILE
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })

const db = new DatabaseSync(DB_FILE)

// WAL：写不阻塞读，掉电也不容易丢半个事务。单机服务的标准配置。
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- 格式 scrypt$<saltHex>$<hashHex>
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,           -- 32 字节随机数的 hex，明文存库（库里丢库等于全丢，加密无意义）
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,           -- 即 AG-UI 的 threadId
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',   -- 取首条用户消息前 30 字，列表页展示
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, updated_at);
CREATE TABLE IF NOT EXISTS thread_runs (
  run_id     TEXT PRIMARY KEY,           -- 即 AG-UI 的 runId
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  messages   TEXT NOT NULL,              -- 本轮结束时 AG-UI messages 的完整 JSON 快照
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON thread_runs(thread_id, created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,                       -- 操作者；登录失败等场景可能是 NULL
  actor      TEXT,                       -- 冗余存用户名：用户改名/删号后审计仍可读
  action     TEXT NOT NULL,              -- 动作标识，如 tool.deleteDocument / auth.login_failed
  target     TEXT,                       -- 作用对象（文档名、候选人 id、用户名）
  detail     TEXT,                       -- 结果或参数摘要（JSON 字符串）
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
CREATE TABLE IF NOT EXISTS model_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL,           -- 即 AG-UI 的 threadId
  run_id        TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  model         TEXT NOT NULL,           -- 实际使用的模型 id（视觉/推理切换会不同）
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  steps         INTEGER NOT NULL DEFAULT 1, -- 本轮 ReAct 走了几步
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON model_usage(user_id, created_at);

-- ===== 跨会话长期记忆 =====
-- 存"关于某个用户的稳定事实"（称呼、偏好、职责等），由模型在对话中通过 remember
-- 工具主动写入，每轮对话注入 system 上下文——这样换会话/换设备模型仍然"记得"。
-- 为什么不存对话摘要：摘要体积大、噪声多，注入会挤占上下文；只存离散事实，
-- 一条一句话，几十条也才几百 token。
CREATE TABLE IF NOT EXISTS user_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 记忆归属于人，不归属于会话
  content    TEXT NOT NULL,             -- 一句话事实，如"用户叫小明，偏好简洁回答"
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON user_memory(user_id, created_at);

-- ===== 会话图片（聊天里发的图） =====
-- 图片本体放磁盘（data/images），这里只存元数据与路径：
-- ① 消息快照每轮都整份存一遍，图片塞进 JSON 会指数级放大；
-- ② 图片要能按用户归属做鉴权（签名 URL 由 image-store.js 生成）。
CREATE TABLE IF NOT EXISTS chat_images (
  file_id    TEXT PRIMARY KEY,           -- 上传时生成，同时拼进图片访问 URL
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name  TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,              -- 磁盘绝对路径
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_images_user ON chat_images(user_id, created_at);
`)

// ===========================================================================
// 版本化迁移（第一阶段「能装」补强）
// ===========================================================================
// 为什么要有 user_version：散落的幂等 ALTER 虽然不会写坏库，但运维时无法回答
//「眼前这个客户的库跑到哪一版了」。有了版本号，升级脚本、启动日志、故障复盘
// 都有唯一的事实来源；以后加迁移只要往 MIGRATIONS 追加一项并抬高 SCHEMA_VERSION。
//
// 为什么要保留 up() 内部的列探测：线上已有库是从「没有版本号」的旧代码建出来的，
// PRAGMA user_version 还是 0，启动时会把 1~5 全部重跑一遍。若 up() 直接 ALTER，
// 遇到已经存在的列就会报 duplicate column。探测一次即可兼容所有历史库，
// 这是「版本化」与「幂等」两道保险叠加，不是冗余。
// ===========================================================================
const SCHEMA_VERSION = 5

/**
 * 列不存在才执行 DDL。
 * @param {string} table 表名（只由本文件的常量传入，不接收外部输入，拼进 SQL 是安全的）
 * @param {string} column 要检查的列名
 * @param {string} ddl 缺列时执行的 ALTER TABLE 语句
 * @returns {boolean} 是否真的执行了 DDL
 */
function addColumnIfMissing(table, column, ddl) {
  // PRAGMA table_info 返回一行一列的信息，取 name 就是已有列名清单
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (cols.includes(column)) return false
  db.exec(ddl)
  return true
}

/**
 * 迁移台账：按 version 升序执行，每项只跑一次（跑完写回 user_version）。
 * 新增迁移的正确姿势：往数组末尾追加 { version: SCHEMA_VERSION + 1, ... }，
 * 同时把 SCHEMA_VERSION 加一；**不要修改已有项的 version 或删掉已有项**，
 * 否则老库会跳过本该执行的迁移。
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'thread_runs.state（历史会话还原共享状态）',
    up() {
      // state 存本轮结束时 AG-UI 共享状态的 JSON（sources/phase 等），
      // 恢复历史会话时一起还给前端，引用来源等跨轮信息不再丢。
      if (addColumnIfMissing('thread_runs', 'state', 'ALTER TABLE thread_runs ADD COLUMN state TEXT;')) {
        console.log('[db] v1 thread_runs 已新增 state 列')
      }
    }
  },
  {
    version: 2,
    name: 'users.role（RBAC 管理员）',
    up() {
      // 谁是 admin 由 ADMIN_USERNAME 环境变量在启动时引导（见 index.js），
      // 库里只存结果——环境变量丢了也不会出现「无主的管理员」。
      if (addColumnIfMissing('users', 'role', "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';")) {
        console.log('[db] v2 users 已新增 role 列')
      }
    }
  },
  {
    version: 3,
    name: 'users.quota_daily（用户级每日 Token 配额）',
    up() {
      // NULL = 跟全局默认走（见 quota.js）。一个用户最多一条配置，
      // 加列比建一张配置表少一次 JOIN，所以当初就选了加列。
      if (addColumnIfMissing('users', 'quota_daily', 'ALTER TABLE users ADD COLUMN quota_daily INTEGER;')) {
        console.log('[db] v3 users 已新增 quota_daily 列')
      }
    }
  },
  {
    version: 4,
    name: 'users.disabled（账号停用开关）',
    up() {
      // 停用状态必须持久化在用户行上：进程重启、多实例都要一致，
      // 且 requireAuth 每次查用户行时顺手就能读到，不用多一次查询。
      // DEFAULT 0 保证历史账号与旧 INSERT 代码升级后仍是「正常」，不会一升级把全库锁死。
      if (addColumnIfMissing('users', 'disabled', 'ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;')) {
        console.log('[db] v4 users 已新增 disabled 列')
      }
    }
  },
  {
    version: 5,
    name: 'session_files（会话文档附件持久化）',
    up() {
      // ===== 为什么需要这张表 =====
      // 改造前，用户上传的 PDF/Word 被解析成「文本块 + 512 维向量」后只存在
      // session-files.js 的内存 Map 里，进程一重启（Railway 每次 Redeploy 也算）
      // 就全没了：聊天记录还在，但追问「我刚传的简历里写了什么」模型答不上来。
      // 图片附件早已由 image-store.js 落盘 + hydrateSessionImages 回填，
      // 文档附件是最后一块没落地的会话数据，这张表就是补上它。
      //
      // ===== 为什么元数据入表、内容落磁盘 JSON =====
      // 一个 PDF 的切块文本 + 向量 JSON 动辄几百 KB 到几 MB，若整份塞进 app.db，
      // 库文件会迅速膨胀，拖慢每次 VACUUM INTO 备份。所以沿用 chat_images 的既有范式：
      // 表存可检索的元数据，大块内容放 uploads/session-files/<file_id>.json，
      // 文件名由 file_id 推导，不需要额外存路径列（卷整体搬家也不会失效）。
      //
      // ===== 为什么不加外键 REFERENCES users(id) =====
      // 老调用点可能传空 userId（例如内部脚本），加了外键会直接插入失败；
      // 而且本表的数据清理由 session-files-store.js 的 deleteByUser 显式负责，
      // 与「删用户」事务配合，比依赖级联更可控（也便于只清附件不清账号）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_files (
          file_id    TEXT PRIMARY KEY,                  -- 与磁盘 JSON 同名，也是前端拿到的 id
          session_id TEXT NOT NULL,                    -- 属于哪个会话；重启后按它整组回填内存
          user_id    TEXT NOT NULL DEFAULT '',         -- 归属用户，供合规删除/按人清理
          file_name  TEXT NOT NULL,
          size       INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_session_files_user ON session_files(user_id);
      `)
      console.log('[db] v5 已创建 session_files 表与索引')
    }
  }
]

{
  // PRAGMA user_version 是 SQLite 内置的用户版本号，存在数据库文件头里，随备份一起走。
  // 新库读到 0，逐个执行所有迁移；已是最新版本的库一个都不跑，启动零开销。
  const row = db.prepare('PRAGMA user_version').get()
  const current = Number(row?.user_version || 0)
  for (const migration of MIGRATIONS) {
    if (current >= migration.version) continue
    migration.up()
    // 每跑完一项就立刻写回版本：万一中途崩在第 3 项，下次启动从第 3 项续跑，
    // 不会把已成功的 1、2 再执行一遍（虽然探测能兜住，但少做无用功）。
    db.exec(`PRAGMA user_version = ${migration.version}`)
    console.log(`[db] 迁移完成 v${migration.version}：${migration.name}`)
  }
  if (current < SCHEMA_VERSION) {
    console.log(`[db] schema 版本：${current} → ${SCHEMA_VERSION}（共 ${MIGRATIONS.length} 项迁移）`)
  }
}

module.exports = db
