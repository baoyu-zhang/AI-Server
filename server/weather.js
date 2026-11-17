/**
 * 天气查询（open-meteo）：把「城市名 → 经纬度 → 逐日预报」两次 HTTP 请求
 * 封装成一个可测试、有明确时间预算、带缓存的操作。
 *
 * 为什么要单独抽出来（而不是写在 index.js 的 tool 里）：
 *   ① 可测：旧实现直接内联 `fetch` + `AbortSignal.timeout(8000)`，失败路径只能靠真跑一次模型
 *      来撞（实测一次要等 8 秒、整轮 20 秒以上），没法快速回归；
 *   ② 可调：超时/重试/缓存这些参数集中在常量里，调优不用改业务代码；
 *   ③ 复用：以后再加「空气质量」「日出日落」这类同源接口，共用同一套超时与去重逻辑。
 *
 * 关键取舍（踩过的坑）：
 *   - **一次 8 秒超时改成两次 3.5 秒**：长跑进程里复用的连接可能已经坏了，表现为请求一直
 *     挂着直到超时（日志里 getWeather 连续两次 abort，而同一台机器新开进程直连只要 0.9 秒）。
 *     把预算切成两段，第一次超时会把坏 socket 销毁，第二次走新连接通常立刻成功——
 *     最坏情况耗时从 8 秒变成 7 秒，正常情况 1.8 秒左右不变。
 *   - **失败抛中文错误**：原来抛的是 undici 的 `The operation was aborted due to timeout`，
 *     模型看到这句会再试一次同名工具（又 8 秒）。现在错误文案明确写"不要再调用"，
 *     让模型直接给用户降级结论。
 *   - **并发去重**：模型有时一轮里发两个完全相同的 getWeather 调用（实测出现过），
 *     共享同一个 in-flight promise，只打一次外部接口，避免两份超时预算叠在一起。
 *   - **成功结果缓存 5 分钟**：同一轮/连续追问同一个城市时直接命中，不再走网络。
 *   - **禁用连接复用（治本）**：上面"坏连接挂死"的根源是 keep-alive 连接池里躺着
 *     对端已经悄悄关掉的 socket。重试只是兜底——这里直接给本模块所有请求配一个
 *     keepAliveTimeout≈0 的 undici Agent，响应一到 socket 就关闭，下一次必然新建连接。
 *     代价是每次多一次 TCP+TLS 握手（本机实测约 50~80ms，相对 3.5 秒预算可忽略），
 *     换来这类挂死从源头消失。globalThis.fetch 支持非标准 dispatcher 参数（Node ≥20），
 *     测试注入的假 fetch 会忽略它，不影响单测。
 */

// 单次尝试的总预算（地理编码 + 预报共用）：正常链路约 1.8 秒，3.5 秒足够宽容
const ATTEMPT_TIMEOUT_MS = 3500
// 尝试次数：超时/网络错误才重试；"查不到城市"属于正常分支，不重试
const ATTEMPTS = 2
// 成功结果缓存时长：天气不会在几分钟内变，重复提问没必要再打接口
const CACHE_TTL_MS = 5 * 60 * 1000

const cache = new Map() // `${city}|${days}` -> { at, text }
const inFlight = new Map() // `${city}|${days}` -> Promise<string>（并发去重）

// 本模块专用的 undici Agent：keepAliveTimeout 设成 1ms 等于"用完即关"，
// 连接池里永远不会有闲置 socket，自然也就没有"复用到坏连接"这回事。
// 只影响走本 Agent 的请求，不碰全局 dispatcher——其他模块的外部请求不受影响。
const { Agent } = require('undici')
const noKeepAlive = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 })

/**
 * 抓取 JSON：网络错误/超时统一转成可读错误，方便上层区分"该重试"还是"该放弃"。
 * 顺手记录慢请求：正常 ~0.9 秒，超过 2 秒大概率又是连接层出问题，先在日志里留证据。
 */
async function getJson(url, signal, fetchImpl) {
  const startedAt = Date.now()
  const res = await fetchImpl(url, { signal, dispatcher: noKeepAlive })
  const ms = Date.now() - startedAt
  if (ms > 2000) console.warn(`[weather] 慢请求 ${ms}ms -> ${new URL(url).host}`)
  if (!res.ok) throw new Error(`天气服务返回 ${res.status}`)
  return res.json()
}

/**
 * 单次尝试：地理编码 + 逐日预报。
 * 返回可展示给用户的文本；查不到城市也返回文本（这是正常业务分支，不该算失败）。
 */
async function oneAttempt(city, days, fetchImpl, timeoutMs) {
  // 两次请求共用一个 signal：避免第一个慢请求把整体预算拖到双倍
  const signal = AbortSignal.timeout(timeoutMs)
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
    signal,
    fetchImpl
  )
  const place = geo?.results?.[0]
  // 查不到城市属于正常分支：返回可读文案，模型才能转告用户换个城市名
  if (!place) return `没有找到「${city}」这个城市的天气数据，请确认城市名是否正确。`

  const wx = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${days}`,
    signal,
    fetchImpl
  )
  const daily = wx?.daily
  if (!Array.isArray(daily?.time) || !daily.time.length) {
    return `天气服务暂时没有返回「${place.name}」的预报，请稍后再试。`
  }
  const lines = daily.time.map((date, i) => {
    const low = Math.round(daily.temperature_2m_min?.[i] ?? 0)
    const high = Math.round(daily.temperature_2m_max?.[i] ?? 0)
    const rain = daily.precipitation_probability_max?.[i]
    return `${date}：${low}~${high}℃${rain == null ? '' : `，降水概率 ${rain}%`}`
  })
  return `${place.name}未来 ${lines.length} 天天气：\n${lines.join('\n')}`
}

/**
 * 查询天气。成功返回可展示文本；多次尝试仍失败则抛出带操作指引的中文错误。
 *
 * @param {string} city 城市名（中文/英文皆可，靠 open-meteo 的地理编码解析）
 * @param {number} days 预报天数 1~7
 * @param {object} deps 测试注入：{ fetchImpl, timeoutMs, attempts, now, onStage }
 * @param {(text: string) => void} [deps.onStage] 阶段播报：每次尝试开始前回调一次，
 *   上层把它转成 AG-UI 自定义事件发到前端——等待期间用户能看到"在查询/在重试"，
 *   而不是盯着"执行中"的圆点猜是不是卡死了。
 */
async function weatherReport(city, days = 3, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const attempts = deps.attempts ?? ATTEMPTS
  const onStage = typeof deps.onStage === 'function' ? deps.onStage : null
  const now = deps.now ? deps.now() : Date.now()
  const key = `${city}|${days}`

  // ① 缓存命中：直接返回（过期的先删掉，避免 Map 无限增长）
  const hit = cache.get(key)
  if (hit) {
    if (now - hit.at < CACHE_TTL_MS) return hit.text
    cache.delete(key)
  }

  // ② 并发去重：同一城市同一轮里被调用多次时，只发一次真实请求
  const pending = inFlight.get(key)
  if (pending) return pending

  const task = (async () => {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // 每次尝试前播报一次阶段：第一次是正常查询，第二次说明第一次已经失败了
      onStage?.(attempt === 1 ? `正在查询「${city}」的天气…` : `上一次请求失败，正在重试…`)
      try {
        const text = await oneAttempt(city, days, fetchImpl, timeoutMs)
        // 只缓存成功结果；"查不到城市"这种也可能是用户打错字，下次要能重新查
        if (!text.startsWith('没有找到')) cache.set(key, { at: Date.now(), text })
        return text
      } catch (err) {
        lastError = err
        // 第一次失败后立刻重试：超时会销毁坏连接，第二次通常走新 socket 就好了
      }
    }
    const reason = lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError'
      ? `连续 ${attempts} 次超时（每次 ${(timeoutMs / 1000).toFixed(1)} 秒）`
      : `连续 ${attempts} 次失败（${lastError?.message || '未知错误'}）`
    // 文案里明确要求"不要再调用"：模型看到原始英文错误会自行再试一次，白白多等一轮
    throw new Error(
      `天气服务${reason}，本次查询已放弃。请不要再次调用 getWeather，` +
        `直接告诉用户天气数据暂时不可用、建议出门前自行查看预报。`
    )
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

module.exports = { weatherReport, ATTEMPT_TIMEOUT_MS, ATTEMPTS, CACHE_TTL_MS, _cache: cache, _inFlight: inFlight, _noKeepAlive: noKeepAlive }
