/**
 * security.js —— P0 生产化安全基线
 *
 * ===== 为什么单独一个文件 =====
 * 安全配置散在 index.js 各处，最容易发生的事故是「本地能跑 → 部署时忘了改某个默认值」。
 * 这个文件把三件事集中成一进一出：
 *   ① assertProductionConfig()：启动前把「不该带上线」的默认值全部挡在门外；
 *   ② attachSecurity(app)：统一挂安全响应头与 CORS 白名单；
 *   ③ 图片签名 URL 的有效期开关（IMAGE_SIGN_TTL_DAYS）。
 *
 * ===== 为什么不用 helmet =====
 * helmet 默认开启的 CSP 会拦掉 Vue 构建产物里的内联样式与部分 eval，
 * 调一堆白名单反而更容易留下口子。这里只设置对本项目真正生效、且不会破坏 SPA 的头：
 *   X-Content-Type-Options / X-Frame-Options / Referrer-Policy /
 *   X-Powered-By 关闭 / HSTS（仅 HTTPS 请求下）+ 生产模式的 Permissions-Policy。
 * 每条都在下面注明作用，将来接 helmet 时可以逐条对照迁移。
 *
 * ===== HTTPS 谁负责 =====
 * 云平台上由平台终结 TLS（Railway 自动生成 *.up.railway.app 证书），
 * 应用本身仍然只监听明文 PORT，靠 X-Forwarded-Proto 判断原始协议。
 * 所以 HSTS 只在「原始请求确实是 https」时才发，本地 http 调试不会被强制升级。
 */
const { log } = require('./logger')
const { PATHS, IS_RAILWAY } = require('./paths')

// 这些口令一律不许带进生产：改都不改就上线，等于没有登录
const WEAK_PASSWORDS = new Set([
  '123456', 'admin', 'password', 'change-me-please', 'admin123', '12345678', ''
])

/**
 * 是否按「公网生产」标准自检。
 *
 * 不能只看 NODE_ENV：本机 pm2 的 ecosystem.config.cjs 也设了 NODE_ENV=production
 * （为了模拟单端口托管形态），但本地用 123456 当管理员口令调试是合理的，
 * 拿公网标准去拦会让本机服务直接起不来。
 * 真正的判据是「有没有被平台暴露到公网」：Railway 会注入 RAILWAY_* 变量；
 * 换成别的平台时显式设 PUBLIC_DEPLOY=1 即可。
 */
function isProduction() {
  return IS_RAILWAY || process.env.PUBLIC_DEPLOY === '1'
}

/**
 * 启动前自检。发现「必然出事」的配置直接抛错让进程起不来——
 * 带着弱口令上线后再补救，成本比启动时失败高得多。
 * 只拦必然错，不拦「可能更好」的项（那些用 warn 提示）。
 */
function assertProductionConfig() {
  const production = isProduction()
  const problems = []
  const warnings = []

  // ① 模型密钥：缺了服务能起，但任何一次对话都会失败，属于最典型的「地址生成了却没用」。
  //    本地开发允许先不配（跑不涉及模型的 verify 脚本），所以只在生产模式拦。
  if (!process.env.DEEPSEEK_API_KEY || /^sk-x{6,}$/.test(process.env.DEEPSEEK_API_KEY)) {
    const msg = 'DEEPSEEK_API_KEY 未配置（仍是示例值）'
    if (production) problems.push(msg)
    else warnings.push(msg)
  }

  // ② 管理员口令：两个变量都给了才会建号，弱口令上线等于公网裸奔。
  //    本地用 123456 调试是合理的，只在生产模式拦，别把本机开发也堵死。
  if (production && process.env.ADMIN_USERNAME && WEAK_PASSWORDS.has(String(process.env.ADMIN_PASSWORD || '').trim())) {
    problems.push('ADMIN_PASSWORD 是弱口令/默认值，请改成至少 12 位的随机串')
  }

  // ③ 云平台必须挂持久化卷：没挂的话每次部署数据全丢，且启动时看不出来
  if (IS_RAILWAY && !process.env.APP_DATA_DIR) {
    warnings.push('Railway 上未设 APP_DATA_DIR —— 请设成 /app/data 并挂载 Volume，否则每次部署数据会清空')
  }

  // ④ 图片签名密钥：不设会自动生成到数据卷，本地可用；但卷一旦重建，历史图片全部 403
  if (isProduction() && !process.env.IMAGE_SIGN_SECRET && !process.env.IMAGE_SIGN_TTL_DAYS) {
    warnings.push('未显式设置 IMAGE_SIGN_SECRET，密钥由数据卷持久化；卷丢失会让历史图片链接全部失效')
  }

  // ⑤ 目录可写检查：云上卷权限不对时，等到第一次写库才报错就太晚了
  try {
    const fs = require('node:fs')
    const probe = require('node:path').join(PATHS.DATA_DIR, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch (err) {
    problems.push(`数据目录不可写：${PATHS.DATA_DIR}（${err.message}）`)
  }

  for (const w of warnings) log.warn('[security] 启动提示', { message: w })
  if (problems.length) {
    // 抛出去让 index.js 顶层崩溃退出：这比「带着问题上线」安全得多
    throw new Error(`[security] 生产配置自检未通过：\n  - ${problems.join('\n  - ')}`)
  }
  log.info('[security] 启动自检通过', { production: isProduction(), railway: IS_RAILWAY, dataDir: PATHS.DATA_DIR })
}

/**
 * 安全响应头 + CORS。必须在所有路由之前挂，才能覆盖静态资源与错误响应。
 * CORS 默认关闭：本项目前后端同源（Express 直接托管 web/dist），
 * 只有确实要把 API 开放给别的站点时才需要设 CORS_ORIGINS。
 */
function attachSecurity(app) {
  app.disable('x-powered-by') // 不告诉扫描器「我是 Express」，少一条按版本找漏洞的线索

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff') // 禁止 MIME 嗅探，防把 JSON 当脚本执行
    res.setHeader('X-Frame-Options', 'SAMEORIGIN') // 只允许自己嵌 iframe，防点击劫持
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin') // 外链不带完整 URL，防 token 泄漏到 Referer
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()') // 用不到这些能力，直接关掉
    // HSTS 只在原始请求确实是 HTTPS 时发：本地 http 调试不能被强制升级到 https
    const proto = req.headers['x-forwarded-proto'] || req.protocol
    if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    next()
  })

  // 反向代理后面才拿得到真实 IP：限流按 IP 计数、审计记录 IP 都依赖它
  if (isProduction()) app.set('trust proxy', 1)

  const origins = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (origins.length) {
    const cors = require('cors') // 项目已有依赖，不需要新增
    app.use(cors({
      origin(origin, cb) {
        // 没有 Origin 头的是同源请求 / curl / 服务端调用，放行
        if (!origin || origins.includes(origin)) return cb(null, true)
        cb(new Error('CORS：来源不在白名单内'))
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      credentials: true,
      maxAge: 600
    }))
    log.info('[security] CORS 白名单已启用', { origins })
  }
}

module.exports = { assertProductionConfig, attachSecurity, isProduction }
