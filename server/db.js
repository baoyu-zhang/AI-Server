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
 *
 * ===== 审计为什么单独一张表 =====
 * 会话快照里也能看到"批了什么"，但那是对话数据：用户看不到别人的、删线程就没了、
 * 结构化查询还得解析 JSON。审计要的是反过来——只追加、可按人/按动作/按时间检索。
 * 因此独立成表，写入点只有一处（executeApprovalTool），不改就查得到。
 *
 * 路径可用 APP_DB_FILE 覆盖：测试脚本指到 /tmp，不碰正式库。
 */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')

const DB_FILE = process.env.APP_DB_FILE || path.join(__dirname, 'data', 'app.db')
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
`)

module.exports = db
