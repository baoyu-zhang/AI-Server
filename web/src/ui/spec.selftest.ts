/**
 * spec.selftest.ts —— 校验层的自测（不需要浏览器、不需要构建）。
 *
 * 跑法：
 *   cd web && node --experimental-strip-types src/ui/spec.selftest.ts
 *
 * 为什么值得单独测这一层：
 *   模型给的数据脏得超出直觉，而这些脏数据一旦漏进组件，表现是"图表画歪了"或
 *   "height: NaN%" 这种无声的错误。校验层是纯函数，测起来最便宜、收益最高。
 */
import assert from 'node:assert/strict'
import { normalizeBarChart, toNumber } from './spec.ts'

let passed = 0
const cases: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  cases.push([name, fn])
}

// ---------- toNumber：数字清洗 ----------
test('纯数字原样返回', () => {
  assert.equal(toNumber(42), 42)
  assert.equal(toNumber(-3.5), -3.5)
})
test('数字字符串', () => {
  assert.equal(toNumber('128'), 128)
})
test('千分位（半角与全角）', () => {
  assert.equal(toNumber('1,234'), 1234)
  assert.equal(toNumber('1，234'), 1234)
})
test('货币符号与百分号被剥掉', () => {
  assert.equal(toNumber('¥1200'), 1200)
  assert.equal(toNumber('12%'), 12)
})
test('万 / 亿 后缀换算', () => {
  assert.equal(toNumber('1.2万'), 12000)
  assert.equal(toNumber('3亿'), 300000000)
  assert.equal(toNumber('2.5k'), 2500)
})
test('括号负数（财务报表写法）', () => {
  assert.equal(toNumber('(120)'), -120)
})
test('脏输入一律返回 null，不返回 NaN', () => {
  for (const bad of ['', 'abc', '12abc', null, undefined, true, {}, [], NaN, Infinity]) {
    assert.equal(toNumber(bad), null, `期望 null，实际 ${String(toNumber(bad))}（输入 ${String(bad)}）`)
  }
})

// ---------- normalizeBarChart：整张图的校验 ----------
test('正常数据被完整保留', () => {
  const r = normalizeBarChart({
    title: '近 3 个月营收',
    unit: '万元',
    data: [
      { label: '1月', value: 12 },
      { label: '2月', value: 18 },
      { label: '3月', value: 15 }
    ]
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.props.title, '近 3 个月营收')
  assert.equal(r.props.unit, '万元')
  assert.equal(r.props.data.length, 3)
  assert.deepEqual(r.props.data[0], { label: '1月', value: 12 })
})

test('标题缺失兜底成「数据概览」', () => {
  const r = normalizeBarChart({ data: [{ label: 'A', value: 1 }] })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.props.title, '数据概览')
})

test('单位为空字符串时不传（避免标题挂空括号）', () => {
  const r = normalizeBarChart({ unit: '   ', data: [{ label: 'A', value: 1 }] })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.props.unit, undefined)
})

test('个别数值转不出来：丢掉该项，其余照画', () => {
  const r = normalizeBarChart({
    data: [
      { label: 'A', value: 1 },
      { label: 'B', value: '不是数字' },
      { label: 'C', value: 3 }
    ]
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.props.data.length, 2)
  assert.equal(r.warnings.length, 1)
})

test('标签缺失用序号兜底', () => {
  const r = normalizeBarChart({ data: [{ value: 5 }] })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.props.data[0].label, '#1')
})

test('超过 24 项截断并给出 warning', () => {
  const data = Array.from({ length: 30 }, (_, i) => ({ label: `项${i}`, value: i }))
  const r = normalizeBarChart({ data })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.props.data.length, 24)
  assert.equal(r.warnings.length, 1)
})

test('超长标签被截断，不报错', () => {
  const r = normalizeBarChart({ data: [{ label: '一'.repeat(50), value: 1 }] })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.props.data[0].label.length <= 20)
})

test('负数保留（按绝对值画图，但数值本身不能改）', () => {
  const r = normalizeBarChart({ data: [{ label: 'A', value: -8 }] })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.props.data[0].value, -8)
})

// ---------- 必须失败的情况：失败要能给出人话原因 ----------
test('参数不是对象 → 失败', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = normalizeBarChart(bad)
    assert.equal(r.ok, false)
  }
})

test('缺少 data 数组 → 失败', () => {
  const r = normalizeBarChart({ title: 'x' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /data/)
})

test('data 里全是脏值 → 失败（宁可降级也不能画出空图）', () => {
  const r = normalizeBarChart({ data: [{ label: 'A', value: '?' }, { label: 'B', value: null }] })
  assert.equal(r.ok, false)
})

// ---------- 跑 ----------
for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(error as Error).message}`)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${cases.length} 通过`)
