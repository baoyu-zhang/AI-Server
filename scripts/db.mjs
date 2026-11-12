#!/usr/bin/env node
/**
 * db.mjs —— 数据库速查工具（不用记一行式 SQL 的引号转义）
 *
 *   node scripts/db.mjs users                账号列表
 *   node scripts/db.mjs threads [n]          最近 n 个会话（默认 10）
 *   node scripts/db.mjs messages <threadId>  某个会话每轮的消息角色序列
 *   node scripts/db.mjs sql "SELECT ..."     执行任意 SQL（SELECT 走表格，其他返回影响行数）
 *   node scripts/db.mjs path                 打印数据库文件路径与大小
 *   node scripts/db.mjs restore <备份文件名> [--force]  从备份恢复数据库（见 server/restore.js）
 *   node scripts/db.mjs verify-backup <备份文件名>      只读校验备份是否可恢复（恢复演练）
 *
 * 默认只读打开：防止手抖 UPDATE 掉生产数据。要写库显式加 --write。
 * restore / verify-backup 是例外：它们委托给 server/restore.js 的独立进程，不走本文件
 * 的只读连接——恢复会覆盖 app.db，和这里打开的句柄会冲突（详见下方早分支注释）。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process' // 新增：restore / verify-backup 用独立进程调用 CommonJS 的 restore.js

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'server/data/app.db')

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const args = argv.filter(a => a !== '--write')
const cmd = args[0] || 'users'

// ===== 新增子命令：restore / verify-backup，委托给 CommonJS 的 server/restore.js =====
// 为什么放在打开数据库之前、且用独立进程：
//   ① restore 会覆盖 app.db，而本文件下面会 new DatabaseSync(DB_PATH) 打开一个到 app.db
//      的句柄；两个连接并存时覆盖文件，句柄会指向旧 inode，语义混乱。独立进程彼此隔离。
//   ② verify-backup 只校验备份文件，跟 app.db 存不存在无关，不能被下面的存在性检查拦住。
//   ③ restore.js 是 CommonJS（module.exports），这里是 ESM：用 spawnSync 跑它的 CLI 最省事，
//      直接复用写好的 --restore / --verify，不必处理 CJS/ESM 互操作。
// 处理完直接退出，绝不落到下面的 switch / finally（那里会 close 一个没打开的连接）。
if (cmd === 'restore' || cmd === 'verify-backup') {
  const fileName = args[1]
  if (!fileName) {
    console.error(`用法：node scripts/db.mjs ${cmd} <备份文件名>${cmd === 'restore' ? ' [--force]' : ''}`)
    process.exit(1)
  }
  const restoreScript = path.join(ROOT, 'server', 'restore.js')
  const cli = [restoreScript, cmd === 'restore' ? '--restore' : '--verify', fileName]
  if (cmd === 'restore' && args.includes('--force')) cli.push('--force') // --force 才允许覆盖正式库
  const result = spawnSync(process.execPath, cli, { stdio: 'inherit', cwd: ROOT })
  process.exit(result.status ?? 1) // 子进程被信号杀死时 status 为 null，按失败处理
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}\n后端启动过就会有（npm start）`)
  process.exit(1)
}

const db = new DatabaseSync(DB_PATH, { readOnly: !write })
/** 统一把毫秒时间戳转成本地时间，直接看表就知道"几点发生的" */
const ts = col => `datetime(${col}/1000, 'unixepoch', 'localtime')`

function show(sql, params = []) {
  const rows = db.prepare(sql).all(...params)
  if (!rows.length) return console.log('（无数据）')
  console.table(rows)
}

try {
  switch (cmd) {
    case 'users':
      show(`SELECT id, username, ${ts('created_at')} AS created FROM users ORDER BY created_at`)
      break

    case 'threads': {
      const n = Number(args[1] || 10)
      show(
        `SELECT t.id, u.username, t.title, ${ts('t.updated_at')} AS updated,
                (SELECT COUNT(*) FROM thread_runs r WHERE r.thread_id = t.id) AS runs
           FROM threads t LEFT JOIN users u ON u.id = t.user_id
          ORDER BY t.updated_at DESC LIMIT ?`,
        [n]
      )
      break
    }

    case 'messages': {
      const tid = args[1]
      if (!tid) {
        console.error('用法：node scripts/db.mjs messages <threadId>')
        process.exit(1)
      }
      const rows = db.prepare(
        `SELECT messages, ${ts('created_at')} AS at FROM thread_runs WHERE thread_id = ? ORDER BY created_at`
      ).all(tid)
      if (!rows.length) {
        console.log(`（该会话没有落库记录：${tid}）`)
        break
      }
      for (const r of rows) {
        const msgs = JSON.parse(r.messages)
        console.log(`\n── ${r.at}（${msgs.length} 条）`)
        for (const m of msgs) {
          const text = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 60)
          const extra = m.toolCalls ? ` [toolCalls: ${m.toolCalls.map(c => c.function?.name).join(',')}]` : ''
          const tcid = m.toolCallId ? ` [for ${m.toolCallId}]` : ''
          console.log(`   ${m.role.padEnd(9)} | ${text}${extra}${tcid}`)
        }
      }
      break
    }

    case 'sql': {
      const sql = args.slice(1).join(' ')
      if (!sql) {
        console.error('用法：node scripts/db.mjs sql "SELECT ..." [--write]')
        process.exit(1)
      }
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        show(sql)
      } else {
        if (!write) {
          console.error('写操作需要显式加 --write（例如：sql "DELETE ..." --write）')
          process.exit(1)
        }
        const r = db.prepare(sql).run()
        console.log(`已执行，影响 ${r.changes} 行`)
      }
      break
    }

    case 'audit': {
      const n = Number(args[1] || 30)
      show(
        `SELECT a.id, u.username, a.action, a.target,
                substr(COALESCE(a.detail, ''), 1, 60) AS detail,
                a.ip, ${ts('a.created_at')} AS at
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        [n]
      )
      break
    }

    case 'path':
      console.log(DB_PATH)
      console.log(`${(fs.statSync(DB_PATH).size / 1024).toFixed(0)} KB`)
      break

    // 验收脚本每跑一次就注册一批临时账号（auth_seed_* / auth_a / eval_*），
    // 攒多了在账号列表里很碍眼。默认只统计不删，加 --write 才真删。
    case 'clean': {
      const like = `username LIKE 'auth\\_%' ESCAPE '\\' OR username LIKE 'eval\\_%' ESCAPE '\\' OR username = 'history_probe'`
      const targets = db.prepare(`SELECT id, username FROM users WHERE ${like}`).all()
      if (!targets.length) {
        console.log('没有需要清理的测试账号')
        break
      }
      const ids = targets.map(t => t.id)
      const marks = ids.map(() => '?').join(',')
      const runs = db.prepare(`SELECT COUNT(*) n FROM thread_runs WHERE user_id IN (${marks})`).get(...ids).n
      const threads = db.prepare(`SELECT COUNT(*) n FROM threads WHERE user_id IN (${marks})`).get(...ids).n
      console.log(`测试账号 ${targets.length} 个，关联会话 ${threads} 个、快照 ${runs} 条：`)
      for (const t of targets) console.log('  -', t.username)
      if (!write) {
        console.log('\n仅统计。确认要删就加 --write（不可恢复，先备份：cp server/data/app.db /tmp/）')
        break
      }
      db.exec('BEGIN')
      try {
        db.prepare(`DELETE FROM thread_runs WHERE user_id IN (${marks})`).run(...ids)
        db.prepare(`DELETE FROM threads WHERE user_id IN (${marks})`).run(...ids)
        db.prepare(`DELETE FROM sessions WHERE user_id IN (${marks})`).run(...ids)
        db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...ids)
        db.exec('COMMIT')
        console.log('\n已清理')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      break
    }

    default:
      console.log('命令：users | threads [n] | messages <threadId> | audit [n] | sql "<SQL>" [--write] | clean [--write] | path | restore <file> [--force] | verify-backup <file>')
  }
} finally {
  db.close()
}
