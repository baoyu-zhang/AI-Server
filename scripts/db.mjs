#!/usr/bin/env node
/**
 * db.mjs —— 数据库速查工具（不用记一行式 SQL 的引号转义）
 *
 *   node scripts/db.mjs users                账号列表
 *   node scripts/db.mjs threads [n]          最近 n 个会话（默认 10）
 *   node scripts/db.mjs messages <threadId>  某个会话每轮的消息角色序列
 *   node scripts/db.mjs sql "SELECT ..."     执行任意 SQL（SELECT 走表格，其他返回影响行数）
 *   node scripts/db.mjs path                 打印数据库文件路径与大小
 *
 * 默认只读打开：防止手抖 UPDATE 掉生产数据。要写库显式加 --write。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'server/data/app.db')

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const args = argv.filter(a => a !== '--write')
const cmd = args[0] || 'users'

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
      console.log('命令：users | threads [n] | messages <threadId> | sql "<SQL>" [--write] | clean [--write] | path')
  }
} finally {
  db.close()
}
