/**
 * models.js —— 可选模型注册表 + 选模型规则
 *
 * ===== 为什么单独一层，而不是在 chat-core 里 if/else =====
 * "用哪个模型"是产品策略，"怎么调模型"是技术实现。混在一起会出现这种局面：
 * 前端要显示选项、管理端要看模型名、兼容端点要透传 model —— 三处各写一份白名单，
 * 加一个模型就得改三个地方，还必然有一处忘改。这里集中成一份事实源：
 *   前端 GET /api/models 直接渲染下拉（不再硬编码选项）
 *   服务端 resolveModel 统一决定最终模型
 *   用量表 model_usage.model 记的就是这里返回的 id
 *
 * ===== 深度思考怎么实现 =====
 * DeepSeek 的"思考"是模型能力，不是请求参数（deepseek-reasoner 天生思考、
 * deepseek-chat 天生不思考）。所以"深度思考开关"在服务端被翻译成"选哪个模型"，
 * 而不是往请求里塞一个 provider 未必支持的开关字段。这样既稳，语义也清楚：
 *   开 = reasoner（先想后答，慢、贵、复杂问题更准）
 *   关 = chat（直答，快、便宜）
 * 将来若要接支持 reasoning_effort 的模型，只需在注册表里加字段，调用处不用动。
 *
 * ===== 全部 id 走环境变量 =====
 * 换供应商/换模型名不该改代码。三个环境变量各管一个"角色"，缺省值见下。
 */
const path = require('path')
// 本模块可能被 index.js、chat-core.js 或独立脚本先 require，必须自己保证 .env 已加载，
// 否则 MODEL_* 全是默认值，"改了 .env 不生效"这种问题很难排查（dotenv 重复加载是幂等的）
require('dotenv').config({ path: path.join(__dirname, '.env') })

const MODEL_REASONING = process.env.MODEL_REASONING || 'deepseek-reasoner' // 深度思考角色：先推理再回答
const MODEL_FAST = process.env.MODEL_FAST || 'deepseek-chat' // 快速角色：直接回答，不支持图片
const MODEL_VISION = process.env.MODEL_VISION || 'deepseek-flash' // 视觉角色：带图片时使用

/**
 * 模型注册表：顺序即前端下拉的显示顺序。
 * 字段含义：
 *   reasoning  是否"深度思考"模型（前端据此判断开关是否点亮）
 *   vision     是否支持图片输入
 *   description 给用户看的一句话说明（讲清"什么时候该选它"，而不是罗列参数）
 */
const REGISTRY = [
  {
    id: MODEL_REASONING,
    label: 'DeepSeek Reasoner',
    description: '深度思考：先推理再回答，复杂问题更准，速度较慢',
    reasoning: true,
    vision: false
  },
  {
    id: MODEL_FAST,
    label: 'DeepSeek Chat',
    description: '快速回答：响应快、成本低，适合日常问答',
    reasoning: false,
    vision: false
  },
  {
    id: MODEL_VISION,
    label: 'DeepSeek Flash（视觉）',
    description: '支持图片理解，同时具备深度思考能力；上传图片时自动使用',
    // 实测（2026-11）：deepseek-flash 既支持视觉也会产出 reasoning，
    // 所以这里 reasoning=true —— 让"深度思考"按钮如实点亮，而不是跟着名字猜
    reasoning: true,
    vision: true
  }
  // 环境变量把两个角色配成同一个模型时会出现重复项，下面按 id 去重
].filter((item, index, arr) => arr.findIndex(other => other.id === item.id) === index)

const BY_ID = new Map(REGISTRY.map(item => [item.id, item]))

/** 默认模型：深度思考（保持项目历史行为，老对话的手感不变） */
const DEFAULT_MODEL = MODEL_REASONING

/**
 * 给前端的选项列表（不含内部字段）。
 * 不带 isDefault 之类的元信息也可以，但前端要靠它决定"初始选中哪个"，省一次猜测。
 */
function listModels() {
  return REGISTRY.map(item => ({
    id: item.id,
    label: item.label,
    description: item.description,
    reasoning: item.reasoning,
    vision: item.vision
  }))
}

/** 判断一个 id 是否是注册过的模型（区分"用户拼错"与"没传"） */
function isKnownModel(id) {
  return typeof id === 'string' && BY_ID.has(id)
}

/**
 * 决定本轮真正使用的模型。
 *
 * @param {object} params
 * @param {string} [params.requested] 调用方显式指定的模型 id
 * @param {boolean} [params.thinking] 深度思考开关；仅在未显式指定模型时生效
 * @param {boolean} [params.hasImages] 本轮消息是否带图片
 * @returns {{modelId: string, reasoning: boolean, vision: boolean, notice?: string, error?: string}}
 *
 * 规则（顺序即优先级）：
 *   ① 有图片 → 必须视觉模型。用户显式选的模型若也支持视觉就用他的，否则自动切并给出提示。
 *      图片进来却喂给纯文本模型，模型会直接看不到图（甚至报错），这是硬约束不是偏好。
 *   ② 无图 + 显式指定 → 听用户的；此时 thinking 忽略（模型本身决定思不思考，避免两个控件打架）。
 *   ③ 无图 + 未指定 → thinking 为 false 用快速模型，其余情况用深度思考模型。
 *      注意 thinking 的默认值是 undefined，按"开"处理 —— 与改造前的默认行为一致。
 *   ④ 显式指定了不存在的模型 → 返回 error，由调用方决定报 400 还是静默回落：
 *      /agui 是自家前端，拼错就该报错；/v1 是对外兼容端点，客户端传 gpt-4 也得很能跑。
 */
function resolveModel({ requested, thinking, hasImages } = {}) {
  const wanted = isKnownModel(requested) ? BY_ID.get(requested) : null

  // ① 带图片
  if (hasImages) {
    if (wanted?.vision) return { modelId: wanted.id, reasoning: wanted.reasoning, vision: true }
    const visionModel = BY_ID.get(MODEL_VISION)
    const notice = wanted
      ? `当前模型 ${wanted.label} 不支持图片，本轮已自动切换为 ${visionModel?.label || MODEL_VISION}`
      : undefined // 没指定模型时不提示：默认走视觉模型是预期行为，说了反而像出错
    return {
      modelId: MODEL_VISION,
      reasoning: Boolean(visionModel?.reasoning),
      vision: true,
      notice
    }
  }

  // ② 显式指定（无图）
  if (requested) {
    if (!wanted) {
      return { modelId: DEFAULT_MODEL, reasoning: Boolean(BY_ID.get(DEFAULT_MODEL)?.reasoning), vision: false, error: `未知模型：${requested}` }
    }
    return { modelId: wanted.id, reasoning: wanted.reasoning, vision: wanted.vision }
  }

  // ③ 未指定：由深度思考开关决定
  const id = thinking === false ? MODEL_FAST : DEFAULT_MODEL
  const picked = BY_ID.get(id) || BY_ID.get(DEFAULT_MODEL)
  return { modelId: picked?.id || DEFAULT_MODEL, reasoning: Boolean(picked?.reasoning), vision: Boolean(picked?.vision) }
}

module.exports = {
  listModels,
  resolveModel,
  isKnownModel,
  DEFAULT_MODEL,
  MODEL_REASONING,
  MODEL_FAST,
  MODEL_VISION
}
