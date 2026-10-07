/**
 * 样式预算棘轮回归测试（对应 tools/assert-style-budget.mjs）
 *
 * 背景：`lib/client.manager.bundle.js` 是**单文件直发**的界面代码（没有构建步骤），
 * 所以"UI 越来越脏"只能靠可测量的棘轮来挡：预算记在 tools/style-budget.json，
 * 以后只许降不许升；新加颜色/内联样式必须在同一次提交里显式上调预算。
 *
 * 本套件守四件事：
 *   ① 指标函数真的在测东西（喂合成样本 → 数字必须对得上，防止判据空跑）；
 *   ② 当前 bundle 不超预算；
 *   ③ 硬规则 `!important` 必须为 0；
 *   ④ `inlineHandlerAttr` 作为棘轮不得增长（历史遗留 5 处，只能降）。
 *
 * 运行：node --test tests/style-budget.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, compare, readBudget, codeLines, CLIENT, BUDGET_FILE, HARD_ZERO } from '../tools/assert-style-budget.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

// ════════════════════════════════════════════════════════════════
// ① 指标非空跑：合成样本 → 期望数字
// ════════════════════════════════════════════════════════════════
test('① 指标测得出东西（合成样本的每个数字都对得上）', () => {
  const sample = [
    `'  <div class="t-card" style="border-color:rgba(243,156,18,.4)">',`,
    `'    <button onclick="event.stopPropagation()" style="color:#ffb464">x</button>',`,
    `'    <span onclick="alert(1)">y</span>',`,
    `'    <span style="color:#fff;font-size:11px;border-radius:4px;padding:3px 8px;z-index:99">z</span>',`,
    `el.cssText = 'color:#ffb464;font-size:11px';`,
    `el.style.color = 'red !important';`,
    `'  <style>',
    `// 注释里的 #ffffff 与 onclick="x" 都不该被算进去`,
  ].join('\n')
  const m = measure(sample)
  assert.equal(m.inlineStyleAttr, 3, 'style=" 出现 3 次（注释那行不算）')
  assert.equal(m.inlineHandlerAttr, 2, 'onclick=" 出现 2 次')
  assert.equal(m.bareHex, 3, '#ffb464 / #fff / #ffb464（注释里的不算）')
  assert.equal(m.bareRgba, 1, 'rgba( 1 次')
  assert.equal(m.cssTextAssign, 1, '.cssText = 1 次')
  assert.equal(m.important, 1, '!important 1 次')
  assert.equal(m.distinctColorLiterals, 3, '颜色字面量种类：hex 2 种（#ffb464 / #fff）+ rgba 1 种 = 3')
  assert.ok(m.distinctFontSizes >= 1, '字号变体要数得出来')
  assert.equal(m.distinctZIndex, 1, '只有 99 一个 z-index')
  assert.equal(m.styleTags, 1, '<style 1 次')
  // 注释行过滤本身也要证一下（否则上面的数字可能只是"注释被算进去了"的巧合）
  assert.equal(codeLines('// x\n  // y\nz').length, 1, '注释行必须被过滤掉')
})

test('①-b 反例：注释里的写法不算数（证明过滤有效，不是把整段都忽略）', () => {
  const onlyComment = measure(`// style="a" onclick="b" #ffffff\n`)
  assert.equal(onlyComment.inlineStyleAttr, 0, '注释里的 style=" 不该计数')
  assert.equal(onlyComment.bareHex, 0, '注释里的颜色不该计数')
  const real = measure(`'  <div style="a">',\n`)
  assert.equal(real.inlineStyleAttr, 1, '真代码里的 style=" 必须计数')
})

// ════════════════════════════════════════════════════════════════
// ② 当前 bundle 不超预算
// ════════════════════════════════════════════════════════════════
test('② 当前 bundle 不超样式预算（超标就跑 --update 并说明理由）', () => {
  const actual = measure(fs.readFileSync(CLIENT, 'utf8'))
  const budget = readBudget()
  const { increased, hardZeroViolations } = compare(actual, budget)
  const lines = increased.map((i) => i.key + '：预算 ' + i.budget + ' → 实测 ' + i.actual)
  assert.deepEqual(lines, [],
    '★ 样式指标超出预算（要么改回，要么在同一次提交里解释理由并跑 node tools/assert-style-budget.mjs --update）：\n' + lines.join('\n'))
  assert.deepEqual(hardZeroViolations, [], '★ 硬规则必须为 0：' + JSON.stringify(hardZeroViolations))
})

test('②-b 预算文件本身是完整的（每个指标都有数、且类型正确）', () => {
  const budget = readBudget()
  const actual = measure(fs.readFileSync(CLIENT, 'utf8'))
  for (const k of Object.keys(actual)) {
    assert.ok(k in budget, '预算里缺指标：' + k + '（加新指标时要一起写进 style-budget.json）')
    assert.equal(typeof budget[k], 'number', '预算值必须是数字：' + k)
  }
  assert.ok(fs.existsSync(BUDGET_FILE), '预算文件必须存在（否则棘轮是空的）')
})

// ════════════════════════════════════════════════════════════════
// ③④ 硬规则与棘轮
// ════════════════════════════════════════════════════════════════
test('③ 硬规则 `!important` 必须恒为 0', () => {
  const actual = measure(fs.readFileSync(CLIENT, 'utf8'))
  assert.equal(actual.important, 0, '★ 界面代码里不许出现 !important')
  assert.ok(HARD_ZERO.includes('important'), 'important 必须在硬规则清单里')
})

test('④ 内联事件属性是棘轮：不得增长（历史遗留 5 处，只许降）', () => {
  const actual = measure(fs.readFileSync(CLIENT, 'utf8'))
  const budget = readBudget()
  assert.ok(actual.inlineHandlerAttr <= budget.inlineHandlerAttr,
    '★ 内联事件属性不得增加：预算 ' + budget.inlineHandlerAttr + ' → 实测 ' + actual.inlineHandlerAttr)
  // 反向护栏：HARD_ZERO 里暂时不含 inlineHandlerAttr（有历史遗留），但必须记录在预算里当棘轮
  assert.equal(HARD_ZERO.includes('inlineHandlerAttr'), false, '当前有遗留，不该当硬 0 规则（改了这条要同步改脚本注释）')
  assert.ok('inlineHandlerAttr' in budget, '遗留项必须留在预算里，否则它就没被棘轮管住')
})

test('⑤ 判据非空跑：拿一份"超预算"的样本必须被判出来', () => {
  const budget = { inlineStyleAttr: 1, important: 0 }
  const bad = compare({ inlineStyleAttr: 5, important: 0 }, budget)
  assert.equal(bad.increased.length, 1, '对照：超预算必须被抓住')
  const okSample = compare({ inlineStyleAttr: 1, important: 0 }, budget)
  assert.equal(okSample.increased.length, 0, '对照：刚好等于预算不算超')
  // 相反方向不算错（棘轮只挡增长）
  assert.equal(compare({ inlineStyleAttr: 0, important: 0 }, budget).increased.length, 0, '下降不该报错')
})
