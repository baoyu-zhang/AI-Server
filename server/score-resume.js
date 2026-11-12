/**
 * score-resume.js —— 简历 × JD 匹配度评估（招聘场景的领域工具核心）
 *
 * 职责：检索两份材料 → 让模型逐项判定 → 代码加总 → 返回可解释的结构化结果。
 *
 * ===== 为什么分数必须由代码算，而不是让模型直接给 0~100 =====
 * 1. 可复现：同一份简历问两次，模型给的连续分能差 15 分；判定"0/1/2"这种离散档位方差小得多。
 * 2. 可解释：每一项的分是"权重 × 档位"，面试官问"为什么这项扣分"能答出具体维度。
 * 3. 可评测：结构化的 level 能写断言，一个数字不能。
 *
 * ===== 反幻觉的唯一机制：evidence 必须是简历原文 =====
 * 模型要给 level>0，就必须摘一句简历原文作证据。摘不出来，代码会把这一项强制降为 0
 * 并记入 missingEvidence —— 这条校验在代码里，不依赖 prompt 是否被遵守。
 *
 * 本模块不出现 express / AG-UI / SSE 任何协议代码，可以被脚本直接调用做评测。
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') }) // 单独 require 本模块（如写评测脚本）也能读到 .env
// 用 generateText + Output.object 而不是 generateObject：后者在 AI SDK 7 已标记 deprecated
// （运行时会打印 [AISDK_DEP_GENERATE_OBJECT]），前者是当前推荐的写法。
const { generateText, Output } = require('ai')
const { createDeepSeek } = require('@ai-sdk/deepseek')
const { z } = require('zod')
const { searchVector } = require('./rag-vector')

/**
 * 结构化判定用 chat 模型，不用 deepseek-reasoner。
 * 原因：generateObject 需要模型稳定返回 JSON（工具调用或 JSON mode），
 * reasoner 对这两者的支持有限，容易出现"拿不到结构、报错或返回空对象"。
 * 判定任务也不需要长链推理，chat 足够。
 */
const MODEL_JUDGE = process.env.MODEL_JUDGE || 'deepseek-chat'

// 每份材料取几条片段。4 条 × 800 字（切块大小）≈ 3200 字，两份约 5k token 输入，
// 再多就会明显拉长延迟，而对判定精度的提升很有限。
const CHUNKS_PER_SIDE = 4

/**
 * 门槛三项（学历 / 地点 / 到岗）单独再检索一路。
 *
 * 为什么不能只靠上面那一路：这三类信息在简历里的"信息密度"极低——
 * 常常就是「学历：大专」「随时到岗」「期望城市：上海」这么几个词，
 * 用"核心技能 经验年限 项目经历"去查，它们永远排不进前 4 段（前 4 段全是项目描述）。
 * 于是模型手里没有依据，却必须给 gate 一个 satisfied —— 它只能推断，而推断会出错：
 * 实测出现过"简历明写随时到岗，模型却判到岗时间不满足"，直接把 78 分砍到 59 分。
 * 这不是模型笨，是喂给它的材料里根本没有那句话。
 */
const GATE_QUERY = {
  resume: '学历 专业 到岗时间 现居城市 期望城市 求职意向',
  jd: '学历要求 工作地点 是否远程 到岗时间'
}
// 门槛只补事实，取 2 段就够；取多了会把无关项目描述重新塞回来，反而稀释信号
const GATE_CHUNKS_PER_SIDE = 2

/**
 * rubric：全模块唯一的事实来源。
 * 权重合计必须 100（满分才是 100）。硬性门槛单独走否决，不计权重 ——
 * 如果把门槛也加权，会出现"学历不符但技术很强 → 75 分建议面试"这种荒谬结论。
 */
const RUBRIC = [
  {
    key: 'stack',
    label: '技术栈匹配',
    weight: 30,
    levels: [
      'JD 要求的核心技术栈一项都没出现',
      '命中部分核心技能（不足一半，或只有技能名、没有项目佐证）',
      '核心技能全部命中，且有项目或工作经历佐证'
    ]
  },
  {
    key: 'experience',
    label: '相关经验年限',
    weight: 20,
    levels: [
      '岗位方向的经验比 JD 要求少 2 年以上，或完全没有该方向的经验',
      '岗位方向的经验比 JD 要求少 1 年以内，或年限接近但方向有偏差',
      '岗位方向的经验满足或超出 JD 要求，且经历连续可查'
    ]
  },
  {
    key: 'complexity',
    label: '项目复杂度',
    weight: 20,
    levels: [
      '没有可核查的项目经历，或项目与岗位方向无关（例如招前端时的纯后端项目）',
      '有与岗位方向相关的项目，但缺少线上运行或团队协作的描述',
      '有与岗位方向相关的线上系统完整负责经历，且有难点、规模或结果的具体描述'
    ]
  },
  {
    key: 'domain',
    label: '行业与业务经验',
    weight: 15,
    levels: [
      '完全没有相关行业或业务背景',
      '相邻行业，业务逻辑需重新学习',
      '同行业同业务，能直接上手'
    ]
  }
]

// 硬性门槛：不参与加权，任一项不满足即否决。
// ⚠️ 这里必须是"固定的三项布尔"，不能让模型自由输出 failures 字符串数组 ——
// 第一版就是自由数组，实测模型把"5 年以上经验"塞进门槛，把 75 分压成了 59 分不通过。
// 年限属于 rubric 里的扣分项，不该走否决。限制字段就堵死了这条路。
const GATE_ITEMS = [
  { key: 'education', label: '学历要求' },
  { key: 'location', label: '工作地点' },
  { key: 'availability', label: '到岗时间' }
]

/** 展示分与结论的对应关系；数值集中在一处，改口径不用翻代码 */
const VERDICT_THRESHOLD = { interview: 75, pending: 60 }
/** 门槛不通过时的展示分上限：避免出现"82 分但不通过"这种自相矛盾的界面 */
const GATE_FAIL_SCORE_CAP = 59

/**
 * generateObject 的输出结构。
 * 只让模型产出"判定 + 证据 + 理由"，不产出分数 —— 分数是下面 sumScore 算的。
 * 这里用 min/max 而不是 .length()：zod 不同小版本对 length 的支持不一致，
 * 而且 min/max 能给出更清楚的校验错误。
 */
const judgeSchema = z.object({
  dimensions: z
    .array(
      z.object({
        key: z.enum(['stack', 'experience', 'complexity', 'domain']).describe('维度标识，必须用给定的英文 key'),
        level: z.number().int().min(0).max(2).describe('档位：0 不满足 / 1 部分满足 / 2 充分满足'),
        evidence: z.string().describe('简历中的原文片段，必须逐字引用；找不到依据就留空字符串'),
        reason: z.string().describe('一句话说明为什么给这个档位')
      })
    )
    .min(4)
    .max(4)
    .describe('四个维度各一条，不要重复也不要遗漏'),
  // 门槛固定三项，每项一个布尔 + 一句依据。
  // 结构定死之后，模型无法把"经验年限"这类 rubric 维度混进来当否决条件。
  gate: z.object({
    education: z.object({
      satisfied: z.boolean().describe('简历是否满足 JD 的学历要求'),
      note: z.string().describe('判断依据，如「硕士，JD 要求本科及以上」')
    }),
    location: z.object({
      satisfied: z.boolean().describe('简历所在地/期望地是否满足 JD 工作地点'),
      note: z.string()
    }),
    availability: z.object({
      satisfied: z.boolean().describe('到岗时间是否满足 JD 要求'),
      note: z.string()
    })
  })
})

/**
 * 把 rubric 渲染成 prompt 片段。
 * 写成"档位 0/1/2 各自什么含义"，而不是只说"给 0~2 分"——
 * 不给出判据时模型会按自己的直觉分档，同一份简历两次判定能不一致。
 */
function describeRubric() {
  return RUBRIC.map(dim => {
    const levelLines = dim.levels.map((text, index) => `  ${index}：${text}`).join('\n')
    return `- ${dim.key}（${dim.label}，权重 ${dim.weight}）\n${levelLines}`
  }).join('\n')
}

/** 拼接判定 prompt。两份材料都带来源标注，便于模型区分"简历说的"和"JD 要的" */
function buildPrompt({ candidateId, jobId, resumeText, jdText }) {
  // 今天是判断"到岗时间是否满足"的唯一参照点，必须显式给模型。
  // 不给的后果是实测过的：简历写「2026 年 11 月 13 日后可到岗」，JD 要求「一个月内到岗」，
  // 差一天就该通过，模型却因为没有"现在几点"的概念判了不满足——分数被门槛从 78 砍到 59。
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `你是招聘评估助手。请根据【岗位 JD】逐项评估【候选人简历】的匹配度。
今天是 ${today}，需要比较日期时以这一天为基准。

评估维度与档位判据：
${describeRubric()}

硬性门槛（不参与打分，只判断是否满足，固定这三项）：
- education（学历）：JD 写了学历要求的，对照简历判断；JD 没写视为满足。
- location（工作地点）：JD 写了城市/远程要求的，对照简历现居地或期望地；JD 没写视为满足。
- availability（到岗时间）：JD 写了到岗时间要求的，对照简历可到岗时间与今天的关系；简历没写视为满足。
  算法：把简历里的具体日期与今天 ${today} 相减得到天数，再和 JD 的要求比较。
  例：JD 要求「一个月内到岗」，简历写「2026-11-13 后可到岗」，今天 2026-11-12 → 相差 1 天，满足。
门槛的判定原则是**宁可不误杀**：只有在简历明确写出与 JD 冲突的事实时才判 satisfied=false；
信息不足、写法含糊、日期换算不确定，一律判 true 并在 note 里说明"信息不足，按满足处理"。
注意：经验年限、技术栈、项目规模都属于评分维度，不要在门槛里判断，也不要写进 note。

【岗位 JD】（jobId=${jobId}）
${jdText}

【候选人简历】（candidateId=${candidateId}）
${resumeText}

输出要求（违反任何一条都会被程序判为无效）：
1. dimensions 恰好 4 条，key 只能用 stack / experience / complexity / domain。
2. 每个维度的 evidence 必须是上面简历原文的逐字片段，不允许改写、概括或推断。
3. 如果简历里找不到支撑该维度的内容，level 必须为 0，evidence 留空字符串。
4. 不要根据 JD 的期望去推测候选人的能力，也不要参考任何简历之外的常识。
5. reason 用一句话说明判断依据，不要复述 evidence 全文。
6. 所有维度都相对于 JD 的岗位方向判断：与岗位方向无关的经历（例如招前端时的后端经历）不能当作匹配依据。`
}

/**
 * 代码加总。模型不参与这一步。
 * @param {Array<{key:string, level:number}>} dimensions
 * @returns {number} 0~100 的加权原始分
 */
function sumScore(dimensions) {
  let total = 0
  for (const dim of RUBRIC) {
    const judged = dimensions.find(item => item.key === dim.key)
    const level = judged?.level ?? 0 // 缺项按 0 算：宁可低估，不可凭空给分
    total += (dim.weight * level) / 2 // level 2 = 满分，故除以 2
  }
  return Math.round(total)
}

/**
 * 证据核查：把标点和空白全部剥掉再比对，判断 evidence 是否真的出自简历。
 *
 * 为什么要剥标点：实测模型会把「Vue3、TypeScript、Vite」引成「Vue3、TypeScript，Vite」，
 * 只差一个逗号。不归一化就会把真实证据误判成编造，把正确的评分打掉。
 *
 * 为什么要按句子拆开逐段查：模型习惯把相隔较远的两句拼成一句引用。
 * 只要其中有一段（≥8 字）能在原文里找到，就认为它确实看过简历。
 */
function verifyEvidence(evidence, sourceText) {
  const normalize = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const target = normalize(evidence)
  if (!target) return false
  const haystack = normalize(sourceText)
  if (haystack.includes(target)) return true
  // 退一步：按长度筛出实质片段，任意一段能在原文里找到即视为通过
  return String(evidence)
    .split(/[。；;！!？?\n]/)
    .map(normalize)
    .filter(part => part.length >= 8)
    .some(part => haystack.includes(part))
}

/**
 * 校验并归一化模型输出。四件事都在这里做，且都不信任 prompt：
 *   ① 去重：同一 key 出现两次时取第一次（模型偶尔会重复输出）
 *   ② 证据缺失：level>0 但 evidence 为空 → 强制降为 0
 *   ③ 证据造假：evidence 在简历原文里找不到 → 强制降为 0（这是唯一能挡住编造的一层）
 *   ④ 补缺：某个 key 完全缺失 → 记 0 分并记入 missingEvidence
 * @param {Array} rawDimensions 模型原始输出
 * @param {string} resumeText 简历原文，用于核查证据
 * @returns {{dimensions: Array, missingEvidence: string[]}}
 */
function normalizeJudgements(rawDimensions, resumeText) {
  const seen = new Set()
  const dimensions = []
  const missingEvidence = []

  for (const item of rawDimensions) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    const dim = RUBRIC.find(d => d.key === item.key)
    if (!dim) continue // enum 已经拦住非法 key，这行是防御
    const evidence = String(item.evidence || '').trim()
    let level = item.level
    let reason = item.reason
    // 核心校验：没有原文证据就不许给正分
    if (level > 0 && !evidence) {
      level = 0
      missingEvidence.push(dim.label)
    } else if (level > 0 && !verifyEvidence(evidence, resumeText)) {
      // 给了证据但原文里查不到 —— 属于编造，直接按 0 处理并把原因写回去，
      // 让日志里能看出"这次模型编了证据"，而不是只看到一个莫名其妙的 0 分。
      level = 0
      reason = `证据未能在简历原文中找到，已按 0 分处理（原判定 level ${item.level}）`
      missingEvidence.push(dim.label)
    } else if (level === 0 && !evidence) {
      // 只有"真的没写"才算缺依据。有原文却判 0 分，是"不匹配"而不是"缺信息"，
      // 两者混在一起会让报告自相矛盾（明明引了「6 年经验」，又说该维度缺依据）。
      missingEvidence.push(dim.label)
    }
    dimensions.push({ key: item.key, label: dim.label, weight: dim.weight, level, evidence, reason })
  }

  for (const dim of RUBRIC) {
    if (seen.has(dim.key)) continue
    dimensions.push({ key: dim.key, label: dim.label, weight: dim.weight, level: 0, evidence: '', reason: '模型未给出该维度判定' })
    missingEvidence.push(dim.label)
  }

  // 去重：同一维度可能既"无证据"又"缺项"被记两次
  return { dimensions, missingEvidence: [...new Set(missingEvidence)] }
}

/**
 * 把三项门槛的布尔判定收敛成 passed + failures。
 * 由代码汇总而不是让模型直接给 passed：模型可能在某一项 false 时仍写 passed=true，
 * 汇总逻辑放在代码里就不可能出错。
 */
function normalizeGate(rawGate) {
  const failures = []
  for (const item of GATE_ITEMS) {
    const entry = rawGate?.[item.key]
    // 模型漏项时按"满足"处理：门槛是否决条件，没有明确证据不该误杀
    if (entry && entry.satisfied === false) {
      // 去掉 note 结尾的句号：后面用「；」拼接，不去会拼出「。；」这种双标点
      const note = String(entry.note || '').trim().replace(/[。.；;，,]$/, '')
      failures.push(`${item.label}：${note || '不满足'}`)
    }
  }
  return { passed: failures.length === 0, failures }
}

/** 结论判定：门槛优先，其次看分数区间 */
function decideVerdict(rawScore, gate) {
  if (!gate.passed) return '不通过'
  if (rawScore >= VERDICT_THRESHOLD.interview) return '建议面试'
  if (rawScore >= VERDICT_THRESHOLD.pending) return '待定'
  return '不通过'
}

/** 把结果渲染成给模型读的文本。刻意写成短句 + 分项，模型容易转述，人也能直接核对 */
function renderText(result) {
  const { candidateId, jobId, score, verdict, rawScore, dimensions, gate, missingEvidence } = result
  const head = `匹配度 ${score} 分（${verdict}）｜候选人 ${candidateId} × 岗位 ${jobId}`
  const detail = dimensions.map(d => `${d.label} ${(d.weight * d.level) / 2}/${d.weight}（level ${d.level}）`).join(' · ')
  const evidence = dimensions
    .filter(d => d.evidence)
    .map(d => `【${d.label}】原文："${d.evidence}"`)
    .join('\n')
  const gateLine = gate.passed ? '硬性门槛：全部满足' : `硬性门槛未通过：${gate.failures.join('；')}`
  const missingLine = missingEvidence.length ? `简历中缺少依据的维度：${missingEvidence.join('、')}` : ''
  const capNote = gate.passed ? '' : `（加权原始分 ${rawScore}，因门槛不通过按下限展示）`

  return [head, detail, gateLine + capNote, evidence, missingLine].filter(Boolean).join('\n')
}

/**
 * 合并两路检索结果：按正文去重，主路在前。
 * 为什么是"主路在前"而不是按分数重排：主路是按维度相关性查出来的，
 * 门槛路只是补事实（学历/地点/到岗那几行），把它插到前面反而会让模型先读琐碎信息。
 * @param {Array<{content: string}>} primary
 * @param {Array<{content: string}>} extra
 */
function mergeChunks(primary, extra) {
  const seen = new Set(primary.map(item => item.content))
  const merged = [...primary]
  for (const item of extra) {
    if (seen.has(item.content)) continue // 两路撞上同一段是常态，不能重复喂给模型
    seen.add(item.content)
    merged.push(item)
  }
  return merged
}

/**
 * 评估一位候选人对某个岗位的匹配度
 * @param {object} params
 * @param {string} params.candidateId 候选人标识（简历 metadata 里的 candidateId）
 * @param {string} params.jobId 岗位标识（JD metadata 里的 jobId）
 * @param {string} [params.query] 检索用查询词，默认用"岗位要求 技能 经验"
 * @returns {Promise<object>} 结构化的评估结果；材料缺失时返回 { ok:false, text } 而不是抛异常
 */
async function scoreResumeAgainstJD({ candidateId, jobId, query = '岗位要求 核心技能 经验年限 项目经历', userId }) {
  // 两路检索必须带 filter：不带的话会召回别的候选人简历，评分对象就错了
  // 第四个参数 userId 是数据隔离：登录用户的评分只能看到"自己的 + 公开旧语料"，
  // 不传（服务端脚本、评测）时不过滤，行为与鉴权上线前一致
  // 每边查两次（维度相关 + 门槛事实），四个请求并发发出去，延迟由最慢的一个决定
  const [resumeChunks, jdChunks, gateResumeChunks, gateJdChunks] = await Promise.all([
    searchVector(query, CHUNKS_PER_SIDE, { candidateId }, userId),
    searchVector(query, CHUNKS_PER_SIDE, { jobId }, userId),
    searchVector(GATE_QUERY.resume, GATE_CHUNKS_PER_SIDE, { candidateId }, userId),
    searchVector(GATE_QUERY.jd, GATE_CHUNKS_PER_SIDE, { jobId }, userId)
  ])

  // 材料缺失是"有效信息"而不是异常：让调用方（模型）如实告诉用户缺什么，
  // 而不是抛错让整轮对话失败，也不是硬着头皮拿空文本去评一个 0 分。
  if (!resumeChunks.length) {
    return { ok: false, text: `知识库中没有找到候选人「${candidateId}」的简历，请先上传简历并标记 candidateId=${candidateId}` }
  }
  if (!jdChunks.length) {
    return { ok: false, text: `知识库中没有找到岗位「${jobId}」的 JD，请先上传 JD 并标记 jobId=${jobId}` }
  }

  // 门槛路可能查到主路没有的片段（例如「到岗时间：随时到岗」单独一段），合并后一起喂给模型
  const resumeAll = mergeChunks(resumeChunks, gateResumeChunks)
  const jdAll = mergeChunks(jdChunks, gateJdChunks)

  const resumeText = resumeAll.map((item, i) => `[简历片段${i + 1}] ${item.content}`).join('\n\n')
  const jdText = jdAll.map((item, i) => `[JD片段${i + 1}] ${item.content}`).join('\n\n')

  const { output } = await generateText({
    model: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(MODEL_JUDGE),
    output: Output.object({ schema: judgeSchema }), // 结构化输出，模型返回的一定是符合 schema 的对象
    prompt: buildPrompt({ candidateId, jobId, resumeText, jdText }),
    // 温度 0：评测的是"同一份材料是否稳定给出同一结论"，不允许随机性
    temperature: 0
  })

  const { dimensions, missingEvidence } = normalizeJudgements(output.dimensions, resumeText)
  const rawScore = sumScore(dimensions)
  const gate = normalizeGate(output.gate)
  const verdict = decideVerdict(rawScore, gate)
  const score = gate.passed ? rawScore : Math.min(rawScore, GATE_FAIL_SCORE_CAP)

  const result = { ok: true, candidateId, jobId, score, rawScore, verdict, gate, dimensions, missingEvidence }
  result.text = renderText(result)
  // 引用来源：前端复用现有的 sources 渲染，能点开看到评分依据出自哪几段原文
  result.sources = [...resumeAll, ...jdAll].map(item => ({
    fileName: item.fileName,
    score: item.score,
    content: item.content,
    sourceType: 'knowledge'
  }))
  return result
}

module.exports = {
  scoreResumeAgainstJD,
  RUBRIC, // 导出给评测脚本：断言时要用同一套维度和权重
  modelId: MODEL_JUDGE
}
