/**
 * weather.js 的单元测试（不联网，全部用假 fetch，跑得完就几毫秒）。
 *
 * 覆盖的是「工具调用失败会不会卡住对话」这条链路的四个关键行为：
 *   ① 正常成功只打两次外部请求（地理编码 + 预报）；
 *   ② 第一次超时能自动重试并成功（坏连接被换掉，这是修 8 秒卡顿的核心）；
 *   ③ 连续失败要尽快抛错、错误文案要告诉模型别再试；
 *   ④ 并发重复调用只打一份请求（模型一轮里发两个相同调用时不再双倍等待）。
 *   ⑤ 阶段播报 onStage：每次尝试前回调一次，供服务端转成 tool_progress 事件。
 *   ⑥ keep-alive 确实被禁用：对本地服务器连发两次请求，对照组（默认 fetch）
 *      共享一条连接，weather 的请求每次新建连接——"复用坏连接"从源头消失。
 *
 * 运行：node server/test-weather.cjs
 */
const assert = require('node:assert')
const { weatherReport, _cache, _inFlight } = require('./weather')

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

// 每次用例前清缓存/去重表，用例之间不串味
function reset() {
  _cache.clear()
  _inFlight.clear()
}

const geoBody = { results: [{ name: '杭州', latitude: 30.29, longitude: 120.16 }] }
const wxBody = {
  daily: {
    time: ['2026-11-16', '2026-11-17', '2026-11-18'],
    temperature_2m_min: [11, 9, 8],
    temperature_2m_max: [19, 17, 16],
    precipitation_probability_max: [10, 60, 5]
  }
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body }
}

const tests = {
  // ① 正常链路
  async 'success: 两次请求、文本含城市与天数'() {
    reset()
    const calls = []
    const fetchImpl = async url => {
      calls.push(url)
      return okJson(url.includes(GEO_URL) ? geoBody : wxBody)
    }
    const text = await weatherReport('杭州', 3, { fetchImpl })
    assert.match(text, /杭州未来 3 天天气/)
    assert.match(text, /2026-11-16：11~19℃/)
    assert.match(text, /降水概率 60%/)
    assert.strictEqual(calls.length, 2)
  },

  // ② 第一次超时 → 自动重试成功（这是"卡一下"的修复点）
  async 'retry: 首次超时后第二次成功'() {
    reset()
    let geoCalls = 0
    const fetchImpl = async url => {
      if (url.includes(GEO_URL)) {
        geoCalls += 1
        if (geoCalls === 1) {
          const err = new Error('The operation was aborted due to timeout')
          err.name = 'TimeoutError'
          throw err
        }
        return okJson(geoBody)
      }
      return okJson(wxBody)
    }
    const text = await weatherReport('杭州', 3, { fetchImpl })
    assert.match(text, /杭州未来 3 天天气/)
    assert.strictEqual(geoCalls, 2, '第一次失败后应该重试一次')
  },

  // ③ 连续失败：快速抛错 + 文案要求模型别再试
  async 'fail: 连续两次超时，抛中文错误并要求不要重试'() {
    reset()
    const started = Date.now()
    const fetchImpl = async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
    await assert.rejects(
      () => weatherReport('杭州', 3, { fetchImpl, timeoutMs: 60, attempts: 2 }),
      err => {
        assert.match(err.message, /天气服务连续 2 次超时/)
        assert.match(err.message, /不要再次调用 getWeather/)
        return true
      }
    )
    // 两次 60ms 预算，实际应远小于把预算浪费在 8 秒上
    assert.ok(Date.now() - started < 2000, '失败路径不应有明显的额外等待')
  },

  // ④ 并发去重：模型一轮里发两个相同调用，只打一份请求
  async 'dedupe: 并发相同城市只发一次请求'() {
    reset()
    let geoCount = 0
    const fetchImpl = async url => {
      if (url.includes(GEO_URL)) {
        geoCount += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return okJson(geoBody)
      }
      return okJson(wxBody)
    }
    const [a, b] = await Promise.all([
      weatherReport('杭州', 3, { fetchImpl }),
      weatherReport('杭州', 3, { fetchImpl })
    ])
    assert.strictEqual(a, b)
    assert.strictEqual(geoCount, 1, '并发重复调用应共享一次真实请求')
  },

  // ⑤ 查不到城市：正常返回，不抛错，也不进缓存
  async 'not-found: 返回可读文案且不缓存'() {
    reset()
    const fetchImpl = async () => okJson({ results: [] })
    const text = await weatherReport('火星', 3, { fetchImpl })
    assert.match(text, /没有找到「火星」/)
    assert.strictEqual(_cache.size, 0)
  },

  // ⑥ 缓存：TTL 内第二次调用不再打接口
  async 'cache: 5 分钟内重复查询不再联网'() {
    reset()
    let calls = 0
    const fetchImpl = async url => {
      calls += 1
      return okJson(url.includes(GEO_URL) ? geoBody : wxBody)
    }
    await weatherReport('杭州', 3, { fetchImpl })
    await weatherReport('杭州', 3, { fetchImpl })
    assert.strictEqual(calls, 2, '第二次应命中缓存')
  },

  // ⑦ 阶段播报：第一次尝试播"正在查询"，重试时播"正在重试"（供前端进度行展示）
  async 'progress: onStage 随尝试次数回调'() {
    reset()
    let geoCalls = 0
    const fetchImpl = async url => {
      if (url.includes(GEO_URL)) {
        geoCalls += 1
        if (geoCalls === 1) {
          const err = new Error('The operation was aborted due to timeout')
          err.name = 'TimeoutError'
          throw err
        }
        return okJson(geoBody)
      }
      return okJson(wxBody)
    }
    const stages = []
    await weatherReport('杭州', 3, { fetchImpl, onStage: text => stages.push(text) })
    assert.deepStrictEqual(stages, ['正在查询「杭州」的天气…', '上一次请求失败，正在重试…'])
  },

  // ⑧ keep-alive 禁用验证：不用"两次请求共享一条连接"做断言——实测 undici 把 socket
  // 归还连接池有微小异步延迟，紧跟的下一次请求会来不及复用而新建，该断言天然不稳定。
  // 改测本质属性：每次请求都新建连接，且响应结束后池中**零闲置 socket**（坏连接无处可复用）。
  async 'keepalive: weather 请求用完即关，池中无闲置 socket'() {
    reset()
    const http = require('node:http')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const { _noKeepAlive } = require('./weather')
    // 两组各用独立的服务器实例：对照组停着的 socket 不能算进实验组的账
    const makeServer = () =>
      new Promise(resolve => {
        const server = http.createServer((req, res) => res.end('ok'))
        server.listen(0, '127.0.0.1', () => resolve(server))
      })
    const idleSocketsOf = server =>
      new Promise((resolve, reject) => server.getConnections((err, count) => (err ? reject(err) : resolve(count))))
    const control = await makeServer()
    const experiment = await makeServer()
    try {
      // 对照组（说明风险，不作严格断言）：默认 fetch 响应结束后会把 socket 停在池里等待复用
      await (await fetch(`http://127.0.0.1:${control.address().port}/`)).text()
      await sleep(50)
      const parkedDefault = await idleSocketsOf(control)
      assert.ok(parkedDefault >= 1, `对照组：默认 fetch 应在池中留有闲置 socket，实际 ${parkedDefault} 条`)
      // 实验组：weather.js 的 Agent 用完即关
      let connections = 0
      experiment.on('connection', () => {
        connections += 1
      })
      const url = `http://127.0.0.1:${experiment.address().port}/`
      await (await fetch(url, { dispatcher: _noKeepAlive })).text()
      await (await fetch(url, { dispatcher: _noKeepAlive })).text()
      await sleep(50)
      assert.strictEqual(connections, 2, `实验组：每次请求应新建连接，实际新建 ${connections} 条`)
      assert.strictEqual(await idleSocketsOf(experiment), 0, '实验组：响应结束后池中不应有闲置 socket')
    } finally {
      control.close()
      experiment.close()
    }
  }
}

;(async () => {
  let failed = 0
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn()
      console.log('✓', name)
    } catch (err) {
      failed += 1
      console.error('✗', name, '\n  ', err.message)
    }
  }
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} 通过`)
  process.exit(failed ? 1 : 0)
})()
