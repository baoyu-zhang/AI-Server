/**
 * setup.mjs —— 私有化交付「一键初始化向导」
 *
 * ===== 为什么需要向导，而不是让人手动 cp .env.example =====
 * 生产环境有三道硬门槛，手填极易踩坑：
 *   ① server/security.js 在 NODE_ENV=production 下拒绝弱口令，初始密码必须 ≥12 位随机串；
 *   ② IMAGE_SIGN_SECRET 必须是稳定随机串，否则卷重建后历史图片签名会全部 403；
 *   ③ 明文密钥绝不能进 git、也不能散落在日志里。
 * 向导把「生成强随机值 + 校验 + 写 0600 权限文件」一次做完，人只需回答几个问题。
 *
 * ===== 两种模式 =====
 *   交互（默认）：readline 逐个提问，直接回车用默认值 / 自动生成。
 *   非交互：--non-interactive，配合 --username/--password/--api-key/--data-dir 传参，
 *           适合 CI、批量交付脚本；--force 允许覆盖已有 .env。
 *
 * ===== 关于「只打印一次密码」=====
 * 管理员初始密码只在终端最后出现一次，并明确提示立即保存。
 * 脚本不写任何日志文件；生成的 deploy/.env 已被仓库 .gitignore 忽略（不会进 git），
 * 并以 0600 权限落盘。覆盖前的备份 .env.bak-<时间戳> 同样是明文，
 * 脚本会提醒用完删除、不要提交。
 *
 * ===== 一个必须如实告知的真实行为 =====
 * server/index.js 的 RBAC 引导把「env 当作唯一事实源」：容器每次启动都会把
 * ADMIN_USERNAME 对应账号的密码重置成 ADMIN_PASSWORD。所以在管理后台改完密码后，
 * 若不更新 .env 并重启，重启时又会被改回去。下方交付提示里会如实说明这一点。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEPLOY_DIR = path.join(ROOT, 'deploy')
const TEMPLATE = path.join(DEPLOY_DIR, '.env.example')
const ENV_FILE = path.join(DEPLOY_DIR, '.env')

// ---------------------------------------------------------------- 参数解析
function printHelp() {
  console.log([
    '用法：node scripts/setup.mjs [选项]',
    '',
    '  默认进入交互模式，逐项提问并生成 deploy/.env。',
    '',
    '选项：',
    '  --non-interactive          非交互模式，不与终端交互，缺失值用默认值 / 自动生成',
    '  --username <值>            管理员用户名（默认 admin）',
    '  --password <值>            管理员密码；不传则自动生成 ≥16 位强随机串',
    '  --api-key <值>             DEEPSEEK_API_KEY；不传则留空并给中文警告',
    '  --data-dir <值>            APP_DATA_DIR（默认 /app/data，需与 compose 卷挂载一致）',
    '  --force                    允许覆盖已存在的 deploy/.env（覆盖前自动备份）',
    '  -h, --help                 显示本帮助',
    '',
    '示例：',
    '  node scripts/setup.mjs --non-interactive --username admin --api-key sk-xxx --force',
    ''
  ].join('\n'))
}

function parseArgs(argv) {
  const opts = { nonInteractive: false, force: false }
  const valueFlags = new Set(['username', 'password', 'api-key', 'data-dir'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--non-interactive') { opts.nonInteractive = true; continue }
    if (arg === '--force') { opts.force = true; continue }
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }

    let key, value
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 2) {
      // 支持 --key=value 写法
      key = arg.slice(2, eq)
      value = arg.slice(eq + 1)
    } else if (arg.startsWith('--')) {
      // 支持 --key value 写法；下一个参数若还是 -- 开头说明取值漏了
      key = arg.slice(2)
      value = argv[++i]
    } else {
      console.error('❌ 无法识别的参数：' + arg + '（运行 node scripts/setup.mjs --help 查看用法）')
      process.exit(1)
    }
    if (!valueFlags.has(key)) {
      console.error('❌ 未知参数 --' + key + '（运行 node scripts/setup.mjs --help 查看用法）')
      process.exit(1)
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      console.error('❌ 参数 --' + key + ' 缺少取值')
      process.exit(1)
    }
    opts[key] = value
  }
  return opts
}

// ---------------------------------------------------------------- 随机与校验
// 用 base64url：只含 A-Z a-z 0-9 - _，不含 = / + 等字符，
// 写进 .env 单行不会被 shell 或 dotenv 误解析；24 字节 → 32 字符，远超 12 位下限。
function strongPassword() {
  return crypto.randomBytes(24).toString('base64url')
}

// 图片签名密钥固定 32 字节 → 64 位 hex，与 .env.production.example 建议的
// `openssl rand -hex 32` 完全等价；每次初始化都重新生成，绝不复用模板里的占位值。
function imageSignSecret() {
  return crypto.randomBytes(32).toString('hex')
}

// 弱口令黑名单：security.js / 常识里最常见、最容易被爆破的几个。
// 只拦「显式已知弱口令 + 明显弱模式」，不搞复杂打分，避免过度设计。
// 注意下面专门收了一批「长度已 ≥12 位」的弱口令：长度校验拦不住它们，
// 若不放进黑名单，「把 123456 拉长到 12 位」就能绕过校验，弱口令拦截会形同虚设。
const WEAK_PASSWORDS = new Set([
  '123456', '12345678', '123456789', '1234567890', 'admin123', 'admin@123',
  'admin1234', 'password', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
  '111111', '000000', 'abc123', 'letmein', 'welcome', 'root', 'toor',
  'test123', 'changeme', 'iloveyou', 'administrator',
  'admin123456', 'admin123456789', 'password1234', '123456789012',
  'qwertyuiop123', 'administrator1', 'changeme12345', 'abc123456789'
])

function validate(config) {
  // 用户名非空：index.js 只在 ADMIN_USERNAME && ADMIN_PASSWORD 同时存在时才建管理员，
  // 少了用户名等于没有管理员，管理接口会对所有人 403。
  if (!config.username || !config.username.trim()) {
    throw new Error('管理员用户名不能为空')
  }
  if (!config.password) {
    throw new Error('管理员密码不能为空')
  }
  if (config.password.length < 12) {
    throw new Error('管理员密码必须 ≥12 位（NODE_ENV=production 下 security.js 会拒绝弱口令并阻止启动），当前只有 ' + config.password.length + ' 位')
  }
  if (WEAK_PASSWORDS.has(config.password.toLowerCase())) {
    throw new Error('拒绝使用常见弱口令「' + config.password + '」，请换一个或省略 --password 让脚本自动生成')
  }
  if (/^(.)\1+$/.test(config.password)) {
    throw new Error('密码不能是同一个字符的重复')
  }
  if (/^\d+$/.test(config.password)) {
    throw new Error('密码不能是纯数字')
  }
}

// ---------------------------------------------------------------- 交互提问
async function askInteractively() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('\n=== AI-Server 私有化交付初始化向导 ===')
    console.log('（直接回车 = 使用默认值 / 自动生成）\n')
    const u = (await rl.question('管理员用户名 [admin]：')).trim()
    const username = u || 'admin'
    const p = await rl.question('管理员密码（回车 = 自动生成 ≥16 位强随机串）：')
    const password = p || strongPassword()
    const k = (await rl.question('DEEPSEEK_API_KEY（可留空，留空会给中文警告）：')).trim()
    const apiKey = k
    const d = (await rl.question('APP_DATA_DIR [/app/data]：')).trim()
    const dataDir = d || '/app/data'
    return { username, password, apiKey, dataDir }
  } finally {
    rl.close()
  }
}

/** 交互模式完全走提问；配置类参数只在非交互模式生效，避免「参数 + 提问」混用导致行为难预期。
 *  --force 不属于配置内容，两种模式下都生效（它只控制是否允许覆盖）。 */
async function collectConfig(opts) {
  if (opts.nonInteractive) {
    return {
      username: opts.username || 'admin',
      password: opts.password || strongPassword(),
      apiKey: opts['api-key'] || '',
      dataDir: opts['data-dir'] || '/app/data'
    }
  }
  return askInteractively()
}

// ---------------------------------------------------------------- 模板渲染
/**
 * 以 .env.example 为模板逐行替换，而不是从零拼字符串：
 * 这样每一行中文说明都原样保留，将来往模板里加变量也不会被脚本弄丢，
 * 且生成的 .env 与模板结构一一对应，人工核对最省力。
 * 只匹配行首的 KEY=...，被 # 注释掉的可选变量不会被误改。
 */
function render(templateText, values) {
  return templateText.split(/\r?\n/).map(line => {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m && Object.prototype.hasOwnProperty.call(values, m[1])) {
      return m[1] + '=' + values[m[1]]
    }
    return line
  }).join('\n')
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(TEMPLATE)) {
    console.error('❌ 找不到模板 deploy/.env.example，请在完整仓库里运行本脚本')
    process.exit(1)
  }

  // 覆盖保护放在最前面：还没提问、还没生成随机值就先判断，
  // 避免用户白填一轮问题才发现「原来不允许覆盖」。
  const exists = fs.existsSync(ENV_FILE)
  if (exists && !opts.force) {
    console.error('❌ deploy/.env 已存在，默认拒绝覆盖，以免把正在使用的密钥冲掉。')
    console.error('   确认要重新生成请加 --force（会先把旧文件备份成 .env.bak-<时间戳>）。')
    console.error('   如果只是想查看或修改现有配置，直接编辑 deploy/.env 即可。')
    process.exit(1)
  }

  const config = await collectConfig(opts)
  // 校验必须先于备份与写文件：失败时不留下任何半成品（包括备份）。
  validate(config)

  // 留空 DEEPSEEK_API_KEY 是允许的（例如先把服务跑起来验证页面），但必须明确警告：
  // 缺了它 AI 聊天功能不可用，index.js 启动期也有显式校验。
  if (!config.apiKey) {
    console.warn('\n⚠️ 警告：DEEPSEEK_API_KEY 为空。服务可启动但 AI 聊天功能不可用；')
    console.warn('   正式部署前请编辑 deploy/.env 填入真实 Key，再 docker compose up -d --build。\n')
  }

  // 覆盖前备份：旧 .env 可能正被线上容器使用，直接覆盖会丢密钥且无法回滚。
  // 备份同样含明文密码，权限收紧到 0600，并明确提醒不要提交、用完删除。
  if (exists && opts.force) {
    // 精确到毫秒（YYYYMMDDHHmmssSSS）：只到秒的话，同一秒内连续两次 --force
    // 会生成同名备份、把上一份直接覆盖掉，反而失去「可回滚」的意义。
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '')
    const bak = path.join(DEPLOY_DIR, '.env.bak-' + stamp)
    fs.copyFileSync(ENV_FILE, bak)
    fs.chmodSync(bak, 0o600)
    console.log('📦 已备份旧配置到：' + path.relative(ROOT, bak))
    console.log('   ⚠️ 该备份含明文密码，请勿提交 git，确认新配置可用后请删除。')
  }

  // IMAGE_SIGN_SECRET 总是自动生成，不询问、不复用模板占位值。
  // NODE_ENV / LOG_TO_FILE 不传 → render 保留模板里的固定值，模板仍是唯一事实源。
  const values = {
    DEEPSEEK_API_KEY: config.apiKey,
    ADMIN_USERNAME: config.username,
    ADMIN_PASSWORD: config.password,
    APP_DATA_DIR: config.dataDir,
    IMAGE_SIGN_SECRET: imageSignSecret()
  }
  const content = render(fs.readFileSync(TEMPLATE, 'utf8'), values)
  // 0600：只有文件所有者可读写，防止同机其他用户读到明文密钥。
  // writeFileSync 对已存在文件不会改 mode，所以写完再显式 chmod 一次。
  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 })
  fs.chmodSync(ENV_FILE, 0o600)

  // ===== 密码只在这一处打印一次 =====
  console.log('\n' + '='.repeat(64))
  console.log('✅ deploy/.env 已生成（权限 0600，且已被 .gitignore 忽略）')
  console.log('')
  console.log('   初始管理员账号：' + config.username)
  console.log('   初始管理员密码：' + config.password)
  console.log('')
  console.log('   ⚠️ 请立即保存，之后可在管理后台改密码。')
  console.log('      注意：server/index.js 把 .env 当作唯一事实源，容器每次启动都会把')
  console.log('      该账号密码重置成 ADMIN_PASSWORD。后台改密后请同步更新 .env 里的')
  console.log('      ADMIN_PASSWORD 并重启，否则重启时新密码会被覆盖回去。')
  console.log('      密码不会写入任何日志文件，本终端之外请自行妥善保管。')
  console.log('='.repeat(64))

  // ===== 下一步命令：路径按「在仓库根执行」写对 =====
  console.log('\n下一步（在仓库根执行）：')
  console.log('  1) 确认已在联网机器执行过 npm run model:prefetch（离线镜像需要 model-cache/）')
  console.log('  2) 构建并启动：')
  console.log('     docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build')
  console.log('  3) 查看状态：docker compose -f deploy/docker-compose.yml ps')
  console.log('  4) 查看日志：docker compose -f deploy/docker-compose.yml logs -f app')
  console.log('  5) 浏览器打开 http://<服务器IP>:3000 ，用上面的账号登录')
  console.log('\n  提示：本机若未安装 docker，需换到装有 docker 且 daemon 已启动的机器执行上述命令。\n')
}

main().catch(err => {
  console.error('\n❌ 初始化失败：' + err.message)
  process.exit(1)
})
