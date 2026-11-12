/**
 * model-fallback.js —— 模型降级重试（P1）
 *
 * ===== 为什么用 middleware 而不是在 /agui 里 catch 重试 =====
 * /agui 的流式循环一旦开始往外发事件（RUN_STARTED、TEXT_MESSAGE_START…），
 * 中途换模型重放会产生两套重复事件，前端消息会错乱、还会重复计费。
 * AI SDK 的 LanguageModel middleware 提供的是"建流之前"的钩子：
 * doStream() 抛错 = 一个字节都还没发出去，此时换模型重开是安全的。
 * 这是唯一能"零侵入 + 语义正确"的降级点。
 *
 * ===== 只降级"重试也没用"之外的错误 =====
 * 401/403 是凭证问题：换模型照样失败，重试只是浪费时间和日志噪声。
 * 400 参数错误一般也不该重试，但有个例外——模型名不被支持（换名字就活了），
 * 所以把含 "model" 字样的 400 也算可降级。
 *
 * ===== 不会死循环 =====
 * 中间件只尝试一次备用模型，备用也失败就把**原始错误**抛出（原始错误更接近根因，
 * 拿备用模型的错误去报会把人带到错误方向）。且备用模型是固定的另一档：
 * 主用 chat（便宜）→ 备份 reasoner；主用其他 → 备份 chat（最便宜、最稳）。
 * 不会出现 reasoner 挂 → 又降 reasoner 的原地打转。
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/**
 * 判断一个错误是否值得"换个模型重试"。
 * @param {any} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  if (!err) return false
  const status = Number(err.statusCode || err.status || err.response?.status)
  if (RETRYABLE_STATUS.has(status)) return true
  if (status === 401 || status === 403) return false // 凭证问题：换模型救不了
  if (status === 400) {
    // 唯一值得重试的 400：模型名不被当前 API 支持（示例：
    // "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed xxx"）
    return /model/i.test(String(err.message || ''))
  }
  // 网络层错误（DNS/连接重置/超时）没有 status，但明显该重试
  const code = String(err.code || err.cause?.code || '')
  if (['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true
  // 兜底：有 message 且不是明确的参数错误，就试一次（降级成本远低于"整轮对话失败"）
  return Boolean(err.message) && !/invalid|validation/i.test(String(err.message))
}

/**
 * 造一个"建流失败就换模型"的 middleware。
 *
 * @param {object} params
 * @param {string} params.primaryId 主模型 id（仅用于日志）
 * @param {string} params.fallbackId 备用模型 id
 * @param {(id: string) => any} params.getModel 由调用方注入模型工厂（避免本模块依赖 provider 初始化顺序）
 * @param {(info: {from: string, to: string, error: string}) => void} [params.onFallback] 降级回调（打日志/埋点）
 * @returns {object} 可直接传给 wrapLanguageModel 的 middleware
 */
function createFallbackMiddleware({ primaryId, fallbackId, getModel, onFallback }) {
  /** 统一处理：先试主模型，失败且可重试则换备用模型 */
  const attempt = async (run) => {
    try {
      return await run()
    } catch (err) {
      if (!fallbackId || fallbackId === primaryId || !isRetryableError(err)) throw err
      onFallback?.({ from: primaryId, to: fallbackId, error: String(err?.message || err) })
      try {
        return await run(fallbackId)
      } catch (fallbackErr) {
        // 抛原始错误：它才是根因，备用模型的失败往往是连带结果
        console.error(`[model] 备用模型 ${fallbackId} 同样失败：${String(fallbackErr?.message || fallbackErr).slice(0, 200)}`)
        throw err
      }
    }
  }

  return {
    // 流式：绝大多数对话走这条。doStream 抛错时还没向客户端发任何字节，换模型是安全的
    async wrapStream({ doStream, params }) {
      return attempt(async (id) => {
        // 第一次用主模型：直接复用 SDK 给的 doStream（它已绑定好主模型）
        if (!id) return doStream()
        // 降级：手动调用备用模型的 doStream，params 是同一份请求参数
        return getModel(id).doStream(params)
      })
    },
    // 非流式（generateText）：/v1 的 stream=false 走的也是流式再拼，但保留这条以防将来用
    async wrapGenerate({ doGenerate, params }) {
      return attempt(async (id) => (id ? getModel(id).doGenerate(params) : doGenerate()))
    }
  }
}

module.exports = { createFallbackMiddleware, isRetryableError }
