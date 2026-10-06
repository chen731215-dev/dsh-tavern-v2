/**
 * 样式预算断言 —— 让设计规范"只降不升"。
 *
 * 为什么需要它：本插件曾经**已经有规范却被系统性绕过**——
 *   `.t-status-ok` / `.t-card` / `.t-btn-sm` 这些类早就写好了，
 *   但 JS 里仍然有 63 处 `style.color='#…'` 内联写死。
 *   结论：没有执行机制的规范等于没有规范。
 *
 * 用法：
 *   node tools/assert-style-budget.mjs          # 检查，超预算即失败
 *   node tools/assert-style-budget.mjs --update  # 收编完成后下调预算（只允许往下调）
 *
 * 规则：任何指标**只能降，不能升**。收编一个页签后跑 --update 把上限压下来。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lib', 'client.manager.bundle.js')
const BUDGET_FILE = path.resolve(HERE, 'style-budget.json')

/**
 * 预算项。每个都给出：怎么量、为什么在乎。
 *
 * ⚠️ 指标设计原则：**只统计裸值**。`var(--dsw-radius-md)` 是目标形态，不是违规；
 *    把它算成"一个圆角变体"会把方向搞反（初版就犯过这个错）。
 */
/**
 * 剥掉注释再统计。
 * ⚠️ 必须做这一步：本文件充斥着引用官方 CSS 的说明性注释（例如
 *    `// 官方 .field { padding:12px 0 }`），注释里的字面量不是违规代码。
 *    不剥注释会出现"越写文档越超预算"的荒唐结果（初版就踩了）。
 */
function stripComments(src) {
  const out = []
  let inBlock = false
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue }
    if (t.startsWith('//')) continue
    out.push(line.replace(/\/\/.*$/, ''))
  }
  return out.join('\n')
}

const stripVar = (t) => t.replace(/var\([^()]*(?:\([^()]*\))?[^()]*\)/g, 'VAR')   // 含一层嵌套

const METRICS = [
  {
    key: 'bareHexDirect',
    why: '直接写死的 hex 颜色（不在 var() 回退里）：这些必须换成 --tv-* / --dsw-* 令牌',
    measure: (t) => (stripVar(t).match(/#[0-9a-fA-F]{3,8}\b/g) || []).length,
  },
  {
    key: 'bareHexFallback',
    why: 'var(--token, #hex) 里的回退值：令牌存在时永不生效，属可接受的过渡形态，但只应减少',
    measure: (t) => (t.match(/var\([^()]*,/g) || []).length,
  },
  {
    key: 'bareRgbaDirect',
    why: '直接写死的 rgba：尤以 rgba(255,255,255,*) / rgba(0,0,0,*) 为甚——手工模拟"浮起/下沉"，等于假设深色底',
    measure: (t) => (stripVar(t).match(/rgba?\([^)]*\)/g) || []).length,
  },
  {
    key: 'darkAssumption',
    why: 'rgba(255,255,255,x) / rgba(0,0,0,x)：浅色主题下必然失效（拖拽区、分隔线、卡片填充会直接消失）',
    measure: (t) => (t.match(/rgba\((?:255,\s*255,\s*255|0,\s*0,\s*0)\s*,/g) || []).length,
  },
  {
    key: 'inlineStyleAttr',
    why: '内联 style="…"：绕过类名体系的主要途径，也是"同类控件各写一套"的根源',
    measure: (t) => (t.match(/style="/g) || []).length,
  },
  {
    key: 'cssTextAssign',
    why: 'style.cssText=：同上，仅允许动态定位/尺寸',
    measure: (t) => (t.match(/cssText\s*=/g) || []).length,
  },
  {
    key: 'paddingVariants',
    why: 'padding 的**裸值**种数：无设计标尺的症状（曾达 52 种）。目标是用 --tv-sp-* 阶梯',
    measure: (t) => new Set([...stripVar(t).matchAll(/padding:\s*([^;"}\n]+)/g)].map((m) => m[1].trim())).size,
  },
  {
    key: 'fontSizeVariants',
    why: 'font-size 的裸值种数：应来自官方字号阶梯（11/12/13/14/16/18/20/24）',
    measure: (t) => new Set([...stripVar(t).matchAll(/font-size:\s*([^;"}\n]+)/g)].map((m) => m[1].trim())).size,
  },
  {
    key: 'radiusVariants',
    why: 'border-radius 的裸值种数：应走 --dsw-radius-{xs,sm,md,lg,xl,panel}',
    measure: (t) => new Set([...stripVar(t).matchAll(/border-radius:\s*([^;"}\n]+)/g)].map((m) => m[1].trim())).size,
  },
  {
    key: 'zIndexValues',
    why: 'z-index 取值清单：应是命名阶梯，禁止 int32 上限（2147483647）',
    measure: (t) => new Set([...t.matchAll(/z-index:\s*([0-9]+)/g)].map((m) => m[1])).size,
  },
  {
    key: 'zIndexInt32Max',
    why: 'z-index:2147483647 出现次数：层级体系崩溃的标志',
    measure: (t) => (t.match(/z-index:\s*2147483647/g) || []).length,
  },
  {
    key: 'important',
    why: '!important：一旦开始用就说明特异性已经失控',
    measure: (t) => (t.match(/!important/g) || []).length,
  },
  {
    key: 'globalSelectors',
    why: '无 #tavern-manager 前缀的选择器：会把样式泄漏到宿主页面',
    measure: (t) => (t.match(/'(\.tavern-[a-z-]+|\.dsh-tv-[a-z-]+)/g) || []).length,
  },
  {
    key: 'focusVisible',
    why: ':focus-visible 规则数（**越多越好**，这是唯一一条"上升才算改善"的指标）',
    measure: (t) => (t.match(/:focus-visible/g) || []).length,
    higherIsBetter: true,
  },
]

const text = stripComments(readFileSync(BUNDLE, 'utf8'))
const update = process.argv.includes('--update')
const current = {}
for (const m of METRICS) current[m.key] = m.measure(text)

if (update) {
  const prev = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
  const next = { ...prev }
  const worse = []
  const allowRise = process.argv.includes('--allow-rise')
  for (const m of METRICS) {
    const k = m.key
    if (prev[k] === undefined) { next[k] = current[k]; continue }
    if (m.higherIsBetter) {
      if (current[k] < prev[k]) worse.push(`${k}: ${prev[k]} → ${current[k]}（这是"越高越好"的指标，不许降）`)
      next[k] = Math.max(prev[k], current[k])
    } else {
      if (current[k] > prev[k]) worse.push(`${k}: ${prev[k]} → ${current[k]}`)
      next[k] = allowRise ? current[k] : Math.min(prev[k], current[k])
    }
  }
  if (worse.length && !allowRise) {
    console.error('❌ 预算方向错误。以下指标退步了：')
    worse.forEach((r) => console.error('   ' + r))
    console.error('\n如果这是**新增组件基元**（而非收编既有代码）造成的合理上升，')
    console.error('用 `--update --allow-rise` 显式接受；接受时请复核并记录。')
    process.exit(1)
  }
  if (worse.length && allowRise) {
    console.warn('⚠️ 已接受以下上调（请复核是否确属新增组件所需）：')
    worse.forEach((r) => console.warn('   ' + r))
  }
  writeFileSync(BUDGET_FILE, JSON.stringify(next, null, 2) + '\n')
  console.log('✅ 预算已更新（上限只降、下限只升' + (allowRise && worse.length ? '；含已接受的上调' : '') + '）')
  process.exit(0)
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
const over = []
for (const m of METRICS) {
  const cap = budget[m.key]
  if (cap === undefined) continue
  const bad = m.higherIsBetter ? current[m.key] < cap : current[m.key] > cap
  if (bad) over.push({ ...m, cur: current[m.key], cap })
}

console.log('样式预算检查')
console.log('  指标                        当前 /  预算   方向')
for (const m of METRICS) {
  const cap = budget[m.key]
  if (cap === undefined) { console.log(`  ⚪ ${m.key.padEnd(22)} ${String(current[m.key]).padStart(5)} /   —   未设`); continue }
  const bad = m.higherIsBetter ? current[m.key] < cap : current[m.key] > cap
  console.log(`  ${bad ? '❌' : '✅'} ${m.key.padEnd(22)} ${String(current[m.key]).padStart(5)} / ${String(cap).padStart(5)}   ${m.higherIsBetter ? '越高越好' : '只降不升'}`)
}

if (over.length) {
  console.error('\n❌ 样式预算未达标：')
  for (const o of over) {
    const delta = o.higherIsBetter ? `${o.cur} < ${o.cap}（差 ${o.cap - o.cur}）` : `${o.cur} > ${o.cap}（超 ${o.cur - o.cap}）`
    console.error(`\n  ${o.key}: ${delta}`)
    console.error(`     为什么在乎：${o.why}`)
  }
  console.error('\n收编完成后可用 `--update` 下调上限；但**不允许上调**。')
  process.exit(1)
}
console.log('\n✅ 全部在预算内')
