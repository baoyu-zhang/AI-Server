#!/usr/bin/env node
/**
 * 一键跑全部离线评测层（不调模型、不联网、不需要服务启动）。
 *
 * 为什么要一个统一入口：评测拆成四层是为了每层用最合适的工具，但"分散"本身会让人漏跑。
 * 改完代码跑一条命令就知道全貌，才是评测体系真正能落地的原因。
 *
 * 四层：
 *   ① 应用行为 Golden Set —— 图片挂载 + 计划状态机（run-behavior.js，19 条）
 *   ② 天气工具降级         —— 超时重试/去重/缓存/进度/keep-alive（test-weather.cjs，8 条）
 *   ③ RAG 检索 Golden Set  —— 20 条问题 × hit@K/MRR（run-eval.js）
 *   ④ 生成式 UI spec 校验  —— normalizeBarChart 脏数据鲁棒性（spec.selftest.ts，18 条）
 *
 * 用法：
 *   node eval/eval-all.js          # 全部跑；任一层失败则整体退出码 1
 *   node eval/eval-all.js --quick  # 只跑①②（业务逻辑层，秒级，改代码后最快反馈）
 *   npm run eval:all               # 等价于第一条（在 server/ 目录下）
 *   npm run eval:quick             # 等价于第二条
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const SERVER_DIR = path.join(__dirname, '..')
const WEB_DIR = path.join(SERVER_DIR, '..', 'web')
const quick = process.argv.includes('--quick')
const tagArg = process.argv.slice(2).find(a => !a.startsWith('-')) || 'latest'

/** 跑一个子进程，实时透传输出，返回是否成功 */
function run(label, cmd, args, cwd) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`▶ ${label}`)
  console.log('='.repeat(72))
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
  if (r.error) {
    console.error(`  ✗ ${label} 启动失败：${r.error.message}`)
    return false
  }
  const ok = r.status === 0
  console.log(`  ${ok ? '✓' : '✗'} ${label} ${ok ? '通过' : `失败（exit ${r.status}）`}`)
  return ok
}

const layers = [
  {
    label: '① 应用行为 Golden Set（图片挂载 + 计划状态机）',
    fn: () => run('行为 Golden Set', process.execPath, ['eval/run-behavior.js', `all-${tagArg}`], SERVER_DIR)
  },
  {
    label: '② 天气工具降级（重试/去重/缓存/进度/keep-alive）',
    fn: () => run('天气降级', process.execPath, ['test-weather.cjs'], SERVER_DIR)
  }
]
if (!quick) {
  layers.push(
    {
      label: '③ RAG 检索 Golden Set（hit@K / MRR）',
      // 检索评测不需要 tag 参数冲突：它接受一个位置参数作为结果 tag
      fn: () => run('检索 Golden Set', process.execPath, ['eval/run-eval.js', `all-${tagArg}`], SERVER_DIR)
    },
    {
      label: '④ 生成式 UI spec 校验（脏数据鲁棒性）',
      // TS 文件用 node 的类型剥离直接跑（Node ≥22），不引入 ts-node 依赖
      fn: () => {
        const selftest = path.join(WEB_DIR, 'src', 'ui', 'spec.selftest.ts')
        if (!fs.existsSync(selftest)) {
          console.log('  – 跳过：web/src/ui/spec.selftest.ts 不存在')
          return true
        }
        return run('UI spec 自测', process.execPath, ['--experimental-strip-types', selftest], WEB_DIR)
      }
    }
  )
}

console.log(`\n离线评测：共 ${layers.length} 层${quick ? '（quick 模式：仅业务逻辑层）' : ''}`)
const results = layers.map(layer => ({ label: layer.label, ok: layer.fn() }))

console.log(`\n${'='.repeat(72)}`)
console.log('汇总：')
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`)
}
const allOk = results.every(r => r.ok)
console.log(`\n${allOk ? '全部通过' : '存在失败层'}：${results.filter(r => r.ok).length}/${results.length}`)
process.exit(allOk ? 0 : 1)
