/**
 * prefetch-model.mjs —— 在「联网机器」上把 embedding 模型预下载到仓库根 model-cache/
 *
 * ===== 为什么需要这个脚本 =====
 * 私有化交付的客户现场往往是不能出网的内网：容器一启动，server/rag-vector.js 会顶层
 * require('@xenova/transformers')，首次用到知识库时 pipeline('feature-extraction', ...)
 * 要去 Hugging Face 拉几百 MB 的模型。离线环境这一步必然超时/失败，
 * 表现是「镜像能起来、知识库一用就报模型加载失败」——而且失败发生在运行期，交付现场很难排查。
 * 所以把「下载」提前到构建阶段：在有网的构建机上把模型缓存整个拉下来，
 * 随镜像一起分发（Dockerfile.offline 会 COPY model-cache/ 到 /app/model-cache/），
 * 运行时 TRANSFORMERS_CACHE 指过去，命中本地文件、完全不联网。
 *
 * ===== 为什么缓存目录必须是「仓库根/model-cache」而不是 ~/.cache =====
 * Dockerfile 的 build 上下文是仓库根，COPY 只能取上下文里的文件；
 * 而 ~/.cache 在构建机的用户目录里，根本进不了镜像。放在仓库根才能被打进镜像层。
 * 另外这个目录只放「模型缓存」这一份只读产物，不参与 git 提交（几百 MB），
 * 它由本脚本生成、由 Dockerfile.offline 消费，属于构建中间产物。
 *
 * ===== 为什么用 createRequire 而不是 import =====
 * @xenova/transformers 2.x 是 "type": "module" 的 ESM 包，但它同时被项目里大量 CJS
 * 代码 require() 使用（见 rag-vector.js），属于 CJS/ESM 混合场景。
 * 更关键的是：本脚本在仓库根 scripts/ 下，而包只装在 server/node_modules/ 里，
 * 从 scripts/ 直接 import('@xenova/transformers') 找不到包（根目录没有 node_modules）。
 * createRequire 以 server/package.json 为基准创建解析器，能稳定命中 server/node_modules，
 * 也保证和运行时用的是同一份已安装版本，避免「预下载的模型格式与运行时不兼容」。
 * （Node 22 已默认支持 require(ESM)，实测可拿到 pipeline / env 导出。）
 *
 * ===== 用哪个下载源 =====
 * 默认与 rag-vector.js 保持一致走 https://hf-mirror.com/（国内可达）；
 * 构建机在海外或该镜像不可用时，用 HF_ENDPOINT 覆盖，例如：
 *   HF_ENDPOINT=https://huggingface.co/ npm run model:prefetch
 *
 * 用法：npm run model:prefetch（或 node scripts/prefetch-model.mjs）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// 仓库根 = scripts/ 的上一级。用 URL 相对定位，无论从哪个 cwd 调用脚本都正确
const ROOT = fileURLToPath(new URL('..', import.meta.url))
// 预下载产物目录：必须与 Dockerfile.offline 里 COPY 的源目录、以及镜像内
// TRANSFORMERS_CACHE 指向的目录「内部结构」完全一致，运行时才能命中缓存。
const CACHE_DIR = path.join(ROOT, 'model-cache')
// 与 rag-vector.js 的 EMBEDDING_MODEL 默认值保持一致；若项目将来换了模型，
// 这里通过同名环境变量一起换，才不会「预下载 A 模型、运行时找 B 模型」。
const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5'
// 与 rag-vector.js 的 HF_ENDPOINT 覆盖逻辑保持一致，支持环境变量覆盖下载源。
const REMOTE_HOST = process.env.HF_ENDPOINT || 'https://hf-mirror.com/'

/** 递归统计目录总字节数与文件数，用于成功后直观确认「确实下载全了」 */
function dirStat(dir) {
  let bytes = 0
  let files = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = dirStat(full)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      bytes += fs.statSync(full).size
      files += 1
    }
  }
  return { bytes, files }
}

/** 统一中文排错：把离线交付最常见的「下载不下来」可操作排查项一次给全 */
function fail(err) {
  console.error('\n❌ embedding 模型预下载失败：' + (err?.message || String(err)))
  console.error([
    '',
    '   请按以下顺序排查（本步骤必须在能联网的构建机上执行）：',
    '   1) 网络/代理：确认能访问 ' + REMOTE_HOST + '，必要时设 HTTPS_PROXY / HTTP_PROXY。',
    '   2) 换镜像源：HF_ENDPOINT=https://huggingface.co/ npm run model:prefetch',
    '      （国内默认走 hf-mirror.com，海外机器改走官方源通常更快）。',
    '   3) 磁盘空间：bge-small-zh-v1.5 连同 onnx 权重约几百 MB，确认 model-cache/ 所在盘够用。',
    '   4) 写权限　：确认当前用户对仓库根有写权限（脚本要创建 model-cache/）。',
    '   5) 依赖完整：确认 server/node_modules/@xenova/transformers 已通过 npm --prefix server ci 装好。',
    '   6) 残留缓存：删掉 model-cache/ 后重跑，transformers.js 会按文件断点续传。',
    '',
    '   ⚠️ 未成功生成完整的 model-cache/ 之前，不要执行 Dockerfile.offline 的构建：',
    '      否则镜像里会缺模型文件，客户现场离线启动时依然会去联网下载并失败。',
    ''
  ].join('\n'))
  process.exit(1)
}

async function main() {
  // 先建目录：transformers.js 需要 cacheDir 存在，显式建好也能提前暴露权限问题
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  // 以 server/package.json 为解析基准，确保命中 server/node_modules 而不是仓库根
  const serverPkg = path.join(ROOT, 'server', 'package.json')
  if (!fs.existsSync(serverPkg)) {
    throw new Error('找不到 server/package.json，请在完整仓库里运行本脚本')
  }
  const requireFromServer = createRequire(serverPkg)

  let transformers
  try {
    transformers = requireFromServer('@xenova/transformers')
  } catch (err) {
    throw new Error('无法从 server/node_modules 加载 @xenova/transformers：' + err.message +
      '（先在仓库根执行 npm --prefix server ci 安装依赖）')
  }
  const { pipeline, env } = transformers
  if (typeof pipeline !== 'function' || !env) {
    throw new Error('@xenova/transformers 导出异常（缺 pipeline / env），请检查版本是否为 2.x')
  }

  // 关键：必须先改 env 再调用 pipeline。pipeline 内部按 env.cacheDir 找/存文件、
  // 按 env.remoteHost 拼下载 URL；设置晚于调用就会落到默认 ~/.cache + 官方源，
  // 结果就是「模型下到了进不了镜像的地方」。
  env.cacheDir = CACHE_DIR
  env.remoteHost = REMOTE_HOST
  // 明确写出两个开关是为了说明离线命中的前提：
  //   allowLocalModels=true  → 文件齐全时直接读本地缓存、不再发任何网络请求（离线镜像靠这个）
  //   allowRemoteModels=true → 本脚本负责「下载」，必须允许远程抓取
  env.allowLocalModels = true
  env.allowRemoteModels = true

  console.log('⏳ 开始预下载 embedding 模型：' + MODEL)
  console.log('   缓存目录：' + CACHE_DIR)
  console.log('   下载源　：' + REMOTE_HOST)
  console.log('   首次下载约几百 MB，耗时取决于网络，请耐心等待…\n')

  // 与 rag-vector.js 完全相同的调用方式：不传额外 options，
  // 保证预下载的量化格式（默认 q8）与运行时要加载的文件一致，避免「下了却用不上」。
  const extractor = await pipeline('feature-extraction', MODEL)

  // 跑一次真实推理：既验证模型文件完整、能被 onnxruntime 正常加载，
  // 也顺带把可能懒加载的权重文件全部落盘（有些文件只在首次推理时才读）。
  const probe = await extractor('离线交付预下载自检', { pooling: 'mean', normalize: true })
  if (!probe?.data?.length) throw new Error('模型已加载但推理无输出，缓存很可能不完整')

  const { bytes, files } = dirStat(CACHE_DIR)
  const mb = (bytes / 1024 / 1024).toFixed(1)
  // 兜底：目录过小说明只拉到了配置没拉到权重，必须判失败，否则会打出「假可用」的镜像
  if (bytes < 10 * 1024 * 1024) {
    throw new Error('缓存目录只有 ' + mb + ' MB，明显小于预期，模型权重很可能没下全')
  }

  console.log('\n✅ 模型预下载完成')
  console.log('   目录　　：' + CACHE_DIR)
  console.log('   目录大小：' + mb + ' MB（' + files + ' 个文件）')
  console.log('   向量维度：' + probe.data.length + '（bge-small-zh-v1.5 应为 512）')
  console.log('\n   下一步：docker build -f Dockerfile.offline -t ai-server-offline:latest .')
  console.log('   （Dockerfile.offline 会 COPY model-cache/ 到 /app/model-cache/，并用 TRANSFORMERS_CACHE 指过去）')
}

main().catch(fail)
