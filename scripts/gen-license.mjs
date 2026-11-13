#!/usr/bin/env node
/**
 * gen-license.mjs —— 给交付方签发客户许可文件（第二阶段「能签」）
 *
 * ===== 为什么需要一个生成脚本 =====
 * 许可文件带 HMAC 签名，手写 JSON 一定验不过。签名用的规范化函数与服务端
 * 必须是同一份代码，否则「生成方按 A 规则算、服务端按 B 规则验」会变成
 * 一个极难排查的「明明没改过却说签名不匹配」。所以这里直接用 createRequire
 * 加载 server/license.js 导出的 signPayload / canonical，不复制实现。
 *
 * ===== 密钥怎么走 =====
 *   LICENSE_SIGN_SECRET  环境变量（推荐）或 --secret 参数
 * 生成用的密钥必须与部署侧 deploy/.env 里的 LICENSE_SIGN_SECRET **完全一致**。
 * 密钥永远不写进输出的 license.json；脚本也不会把密钥打印到终端。
 *
 * ===== 典型用法 =====
 *   export LICENSE_SIGN_SECRET='<交付方保管的随机串>'
 *   node scripts/gen-license.mjs \
 *     --customer '某某科技有限公司' --seats 30 --expires 2027-11-13 \
 *     --out output/license.json
 *   # 把 output/license.json 拷到客户服务器 /app/data/license.json，重启容器
 *
 * 不传 --expires 时默认签发一年。日期一律按 YYYY-MM-DD，服务端按北京时间
 * 当天 23:59:59 判定到期（见 license.js）。
 *
 * ===== 边界 =====
 * 本脚本只在交付方机器上运行，不进交付镜像（.dockerignore 已排除 scripts/ 之外
 * 的构建产物目录；镜像由 Dockerfile.offline 明确 COPY 的目录构成）。
 * 它不做计费、不联网、不写数据库，产出就是一个可拷走的 JSON 文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// server/ 是 CommonJS 工程，用 createRequire 以 server/package.json 为基准加载，
// 比拼相对路径的 require('./../server/license.js') 更不容易被 cwd 影响。
const requireFromServer = createRequire(path.join(ROOT, 'server', 'package.json'))
const { signPayload } = requireFromServer('./license.js')

/** 极简参数解析：只支持 --key value / --key=value 两种形式，不引第三方 CLI 依赖 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      out[arg.slice(2)] = next && !next.startsWith('--') ? next : 'true'
      if (next && !next.startsWith('--')) i++
    }
  }
  return out
}

/** 今天，本地时区的 YYYY-MM-DD */
function today() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 在给定日期上加一年，用作默认到期日 */
function plusOneYear(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+08:00`)
  d.setFullYear(d.getFullYear() + 1)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fail(message) {
  console.error(`\n❌ ${message}\n`)
  console.error('用法示例：')
  console.error("  export LICENSE_SIGN_SECRET='<随机串>'")
  console.error("  node scripts/gen-license.mjs --customer '某某公司' --seats 30 --expires 2027-11-13 --out output/license.json\n")
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

if (args.help || args.h) {
  console.log('签发客户许可文件。参数：--customer（必填）、--edition（默认 standard）、--seats（默认 30）、--expires（YYYY-MM-DD，默认一年后）、--out（默认 output/license.json）、--secret（也可用 LICENSE_SIGN_SECRET 环境变量）。')
  process.exit(0)
}

const secret = args.secret || process.env.LICENSE_SIGN_SECRET
if (!secret) fail('缺少签名密钥：请设置 LICENSE_SIGN_SECRET 环境变量，或用 --secret 传入。部署侧的 deploy/.env 必须配同一个值。')
if (secret.length < 16) fail('签名密钥太短（建议 ≥32 位随机串）：请用 openssl rand -hex 32 生成。')

const customer = String(args.customer || '').trim()
if (!customer) fail('缺少 --customer（客户名称），许可文件里必须写明被授权主体。')

const seats = Number(args.seats ?? 30)
if (!Number.isInteger(seats) || seats < 1) fail('--seats 必须是正整数。')

const issuedAt = today()
const expiresAt = args.expires ? String(args.expires).trim() : plusOneYear(issuedAt)
if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) fail('--expires 格式必须是 YYYY-MM-DD，例如 2027-11-13。')
if (expiresAt <= issuedAt) fail(`到期日 ${expiresAt} 必须晚于签发日 ${issuedAt}。`)

// payload 字段顺序无关：signPayload 内部按 PAYLOAD_FIELDS 规范化后签名，
// 服务端用同一函数验签，因此多写/少写字段都会导致签名不匹配（这正是想要的防误改效果）。
const payload = {
  licenseId: crypto.randomUUID(),
  customer,
  edition: String(args.edition || 'standard'),
  seats,
  issuedAt,
  expiresAt
}
const signature = signPayload(payload, secret)
const license = { ...payload, signature }

const outPath = path.isAbsolute(String(args.out || ''))
  ? String(args.out)
  : path.resolve(ROOT, String(args.out || 'output/license.json'))
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(license, null, 2)}\n`, 'utf8')

console.log('\n✅ 许可文件已生成\n')
console.log(`   文件      : ${outPath}`)
console.log(`   被授权方  : ${customer}`)
console.log(`   版本      : ${payload.edition}`)
console.log(`   坐席      : ${seats}`)
console.log(`   签发 / 到期: ${issuedAt} → ${expiresAt}`)
console.log(`   licenseId : ${payload.licenseId}`)
console.log('\n下一步：')
console.log('   1) 把该文件拷到客户服务器的数据卷：/app/data/license.json（或设 LICENSE_FILE 指向它）')
console.log('   2) 确认客户 deploy/.env 里的 LICENSE_SIGN_SECRET 与本次生成用的密钥完全一致')
console.log('   3) 若合同约定到期停用，再设 LICENSE_ENFORCE=1（默认只提示、不阻断）')
console.log('   4) 重启容器，打开登录页核对底部授权信息；服务端日志可用 node -e 调 evaluate() 复查')
console.log('\n⚠️  密钥与许可文件请分开保管；不要把 LICENSE_SIGN_SECRET 写进交付包或提交到 git。\n')
