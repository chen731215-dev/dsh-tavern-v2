/**
 * 客户端「自检三件套」回归测试（对应 tools/check-client-integrity.mjs）
 *
 * 背景（接手文档 §6.3 / S4①）：S2 要把 7000 行的服务端拆层，之前必须先有安全网。
 * 这三个检查的思路来自 PR #13（@H2CO3w），但那个 PR 只把方法论写在提交信息里，没提交脚本。
 *
 * 本套件守四件事：
 *   ① 三个检查都不许空跑 —— 每条"应该报错"的判据都配**坏样本**，证明确实抓得住；
 *   ② 历史踩过的坑要钉死 —— 动态拼接 id、注释掉的代码，都不能被误报成悬空 id；
 *   ③ 当前 bundle 三件套全绿；
 *   ④ 工具不允许悄悄失效 —— 必须真的扫到分组/标签/卡片，否则算失败。
 *
 * 运行：node --test tests/client-integrity.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_SRC, checkTagBalance, checkDanglingIds, checkCardDepth,
  collectJsIds, collectMarkupIds, extractMarkupGroups, extractMarkupGroupsEx,
  checkTagBalanceGroups, blankTemplateExpr, VOID_TAGS, readRowOpenTable, resolveRowEmitter,
} from '../tools/check-client-integrity.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const REAL_CLIENT = path.join(REPO, 'lib', 'client.manager.bundle.js')

// ════════════════════════════════════════════════════════════════
// ① 标签配平：坏样本必须报错（非空跑对照）
// ════════════════════════════════════════════════════════════════
test('①-a 平衡的正常 markup 必须判绿', () => {
  const r = checkTagBalance('<div class="t-card"><span>a</span><span>b</span></div>')
  assert.equal(r.ok, true, '不该报不平衡：' + JSON.stringify(r.errors))
  assert.ok(r.scanned >= 4, '至少扫到 4 个标签，实际 ' + r.scanned)
})

test('①-b 少了闭合标签必须被抓住', () => {
  const r = checkTagBalance('<div><span>a</span>')
  assert.equal(r.ok, false)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].type, 'missing-close')
  assert.equal(r.errors[0].tag, 'div')
})

test('①-c 多出来的闭合标签必须被抓住', () => {
  const r = checkTagBalance('</div>')
  assert.equal(r.ok, false)
  assert.equal(r.errors[0].type, 'stray-close')
  assert.equal(r.errors[0].tag, 'div')
})

test('①-d 父标签被提前闭合（子标签没关）必须被点名', () => {
  // S3 做 UI 结构化时最容易出现这种错误：加卡片时把 </div> 位置放错
  const r = checkTagBalance('<div><span>a</div>')
  assert.equal(r.ok, false)
  const kinds = r.errors.map((e) => e.type)
  assert.ok(kinds.includes('unclosed'), '应当判定为「还有没闭合的」，实际 ' + JSON.stringify(kinds))
  assert.ok(r.errors[0].detail.includes('span'), '点名里要出现没闭合的 span：' + r.errors[0].detail)
})

test('①-e void 元素与自闭合不能误报', () => {
  const r = checkTagBalance('<div><br><input type="text"><img src="x"/><hr></div>')
  assert.equal(r.ok, true, 'void/自闭合不该算不平衡：' + JSON.stringify(r.errors))
  assert.ok(VOID_TAGS.has('br') && VOID_TAGS.has('input') && VOID_TAGS.has('img'))
})

test('①-f HTML 注释里的标签不能参与配对', () => {
  const r = checkTagBalance('<!-- <div> --><div>a</div>')
  assert.equal(r.ok, true, '注释里的内容不该被算进去：' + JSON.stringify(r.errors))
})

// ════════════════════════════════════════════════════════════════
// ② 悬空 id：坏样本必须报错 + 历史误报必须不再复现
// ════════════════════════════════════════════════════════════════
test('②-a 引用存在的 id 必须判绿', () => {
  const src = [
    "const html = '<div id=\"tavern-a\"></div><span id=\"tavern-b\"></span>'",
    "document.getElementById('tavern-a')",
    "root.querySelector('#tavern-b')",
  ].join('\n')
  const r = checkDanglingIds(src)
  assert.equal(r.ok, true, JSON.stringify(r.missing))
  assert.equal(r.totalRefs, 2, '应当识别到 2 处引用')
  assert.equal(r.markupIds, 2, '应当识别到 2 个声明的 id')
})

test('②-b 真悬空 id 必须被抓住', () => {
  const src = [
    "const html = '<div id=\"real\"></div>'",
    "document.getElementById('ghost')",
  ].join('\n')
  const r = checkDanglingIds(src)
  assert.equal(r.ok, false)
  assert.equal(r.missing.length, 1)
  assert.equal(r.missing[0].id, 'ghost')
  assert.equal(r.missing[0].kind, 'getElementById')
  assert.ok(r.missing[0].line > 0, '要能给出行号方便定位')
})

test('②-c querySelector 形式的悬空 id 也必须被抓住', () => {
  const r = checkDanglingIds("root.querySelector('#nope .child')")
  assert.equal(r.ok, false)
  assert.equal(r.missing[0].id, 'nope')
})

test('②-d 基线要能区分「新引入」与「既有」', () => {
  const src = [
    "const html = '<div id=\"ok\"></div>'",
    "document.getElementById('known-dangling')",
    "document.getElementById('brand-new-dangling')",
  ].join('\n')
  // 已知的那条单独出现 → 判绿（不阻塞），但要列出来
  const onlyKnown = checkDanglingIds(src.replace(/brand-new-dangling'\)/, 'ok\')'), ['known-dangling'])
  assert.equal(onlyKnown.ok, true, '只有历史欠债时不该判红')
  assert.ok(onlyKnown.missing.some((m) => m.id === 'known-dangling' && m.known), '但要点名出历史欠债')

  // 冒出新的 → 必须判红
  const withNew = checkDanglingIds(src, ['known-dangling'])
  assert.equal(withNew.ok, false, '出现新的悬空 id 必须判红')
  const fresh = withNew.missing.filter((m) => !m.known).map((m) => m.id)
  assert.deepEqual(fresh, ['brand-new-dangling'])
})

test('②-e 动态拼接的选择器不能算悬空 id（第一版误报过，钉死）', () => {
  // bundle 第 2058 行附近：container.querySelector('#tavern-' + type + '-file')
  const r = checkDanglingIds("var f = container.querySelector('#tavern-' + type + '-file')")
  assert.equal(r.ok, true, '拼接写法静态扫不出来，不该误报：' + JSON.stringify(r.missing))
  assert.deepEqual(collectJsIds("container.querySelector('#tavern-' + type + '-file')"), [])
})

test('②-f 被注释掉的历史代码不能算悬空 id（第一版误报过，钉死）', () => {
  // bundle 第 2199 行附近：整段 // 注释里的 updateMsgCount()
  const src = [
    '//       function updateMsgCount() {',
    "//         var countEl = container.querySelector('#tavern-msg-count');",
    '//       }',
  ].join('\n')
  const r = checkDanglingIds(src)
  assert.equal(r.ok, true, '注释掉的代码不该参与检查：' + JSON.stringify(r.missing))
  assert.deepEqual(collectJsIds(src), [])
  assert.equal(collectMarkupIds(src).size, 0)
})

test('②-g 块注释里的 DOM 引用同样不算', () => {
  const src = '/* getElementById(\'ghost\') */\ndocument.getElementById(\'real\')'
  const r = checkDanglingIds(src, [])
  assert.ok(!r.missing.some((m) => m.id === 'ghost'), '块注释里的引用要被忽略')
  assert.ok(r.missing.some((m) => m.id === 'real'), '注释外的真悬空仍然要报')
})

// ════════════════════════════════════════════════════════════════
// ③ 卡片嵌套深度：同级卡片不许被容器误吞
// ════════════════════════════════════════════════════════════════
test('③-a 同级卡片必须判绿', () => {
  const src = [
    'function panelHTML() {',
    '  return [',
    `    '<div id="tavern-manager">',`,
    `    '  <div class="t-card" data-tv-tab="a">A</div>',`,
    `    '  <div class="t-card" data-tv-tab="b">B</div>',`,
    `    '</div>',`,
    '  ]',
    '}',
  ].join('\n')
  const r = checkCardDepth(src)
  assert.equal(r.total, 2, '应当找到 2 张卡片')
  assert.equal(r.ok, true, '同层卡片不该判红：' + JSON.stringify(r.bad))
})

test('③-b 被容器多包一层的卡片必须被抓住（panel 常见事故）', () => {
  const src = [
    'function panelHTML() {',
    '  return [',
    `    '<div id="tavern-manager">',`,
    `    '  <div class="t-card" data-tv-tab="a">A</div>',`,
    `    '  <div class="accidentally-added-wrapper">',`,
    `    '    <div class="t-card" data-tv-tab="b">B</div>',`,
    `    '  </div>',`,
    `    '</div>',`,
    '  ]',
    '}',
  ].join('\n')
  const r = checkCardDepth(src)
  assert.equal(r.ok, false, '有一张卡片被多包了一层，必须判红')
  assert.equal(r.bad.length, 1)
  assert.equal(r.bad[0].depth, r.bad[0].base + 1, '应当正好深一层')
})

// ════════════════════════════════════════════════════════════════
// ⑤ 空跑防护：什么都没扫到必须判失败，不许给出免费的绿灯
// ════════════════════════════════════════════════════════════════
test('⑤-a 扫不到卡片时必须标记为判据空跑', () => {
  // 源码里明明有 data-tv-tab，但形态不是「数组拼装」，提取器抓不到 ⇒ 必须报空跑
  const src = "const html = '<div data-tv-tab=\"a\"></div>'"
  const r = checkCardDepth(src)
  assert.equal(r.total, 0, '这种写法确实抓不到卡片')
  assert.equal(r.vacuous, true, '抓不到就必须标记空跑，否则会变成假绿灯')
})

test('⑤-b 源码里有字面量 id 查询却一处都没抓到 ⇒ 必须标记为空跑', () => {
  // 唯一的那处 querySelector 被注释掉了，所以什么都没抓到。
  // 这种"看起来干净"的结果必须被判为空跑，而不是当作没有悬空 id。
  const src = "// root.querySelector('#hidden-by-comment')"
  const r = checkDanglingIds(src, [])
  assert.equal(r.totalRefs, 0, '注释掉的不该被当成真实引用')
  assert.equal(r.vacuous, true, '源码里明明写着字面量查询却没抓到 ⇒ 空跑')
})

test('⑤-b2 只有变量形态调用时不算空跑（动态 id 本就在检查范围之外）', () => {
  // 刻意不收 getElementById(id) 这类写法（静态扫不出来，收了全是误报），
  // 所以遇到这种情况应当判定为"无事可做"，而不是报警
  const src = 'const el = document.getElementById(someVar)'
  const r = checkDanglingIds(src, [])
  assert.equal(r.totalRefs, 0)
  assert.equal(r.vacuous, false, '动态 id 是我们刻意不收的，不该因此报警')
  assert.equal(r.ok, true)
})

test('⑤-c 当前 bundle 三个判据都不许是空跑', () => {
  const src = fs.readFileSync(REAL_CLIENT, 'utf8')
  assert.equal(checkDanglingIds(src, []).vacuous, false)
  assert.equal(checkCardDepth(src).vacuous, false)
  assert.equal(checkCardDepth(src).total >= 12, true)
})

// ════════════════════════════════════════════════════════════════
// ④ 真文件：全绿 + 不许悄悄失效
// ════════════════════════════════════════════════════════════════
test('④ 当前 bundle 三件套全绿，且工具真的扫到了东西', () => {
  assert.equal(CLIENT_SRC, REAL_CLIENT, '工具默认就要指 lib/client.manager.bundle.js')
  const src = fs.readFileSync(REAL_CLIENT, 'utf8')

  const groups = extractMarkupGroups(src)
  assert.ok(groups.length >= 1, '至少要识别出面板那个片段数组（否则工具已经失效）')

  const bal = checkTagBalance(blankTemplateExpr(groups[0].markup))
  assert.equal(bal.ok, true, '面板 markup 标签不成对：' + JSON.stringify(bal.errors.slice(0, 5)))
  assert.ok(bal.scanned > 300, '面板至少几百个标签，实际 ' + bal.scanned)
  assert.ok(blankTemplateExpr('<div>${a + b}</div>').includes('$') === false, '${} 要被挖掉')

  const ids = checkDanglingIds(src, [])
  assert.equal(ids.ok, true, '发现有悬空 id：' + JSON.stringify(ids.missing.slice(0, 5)))
  assert.ok(ids.totalRefs > 100, 'JS 侧引用数不该这么少：' + ids.totalRefs)
  assert.ok(ids.markupIds > 50, 'markup 侧 id 数不该这么少：' + ids.markupIds)

  const cards = checkCardDepth(src)
  assert.ok(cards.total >= 12, '面板至少 12 张一级卡片，实际 ' + cards.total)
  assert.equal(cards.ok, true, '有卡片层级不一致：' + JSON.stringify(cards.bad.slice(0, 5)))
})

// ════════════════════════════════════════════════════════════════
// ⑥ S3 基元（`tvRowOpen` / `tvRowClose`）：**要么还原、要么响亮报错**，不许静默丢组
//
// 为什么单列一节（task-25 笔2）：`panelHTML` 里 39 个 `<div class="t-row" …>` 元素从字面量
// 迁成了基元调用。而 `extractMarkupGroups` 只认「`[` + ≥3 个纯字面量 + `]`」⇒ 元素是**调用**
// 就把**整组**丢掉：② 的 `scanned` 610→0、③ 的 `total` 12→0（本仓实测；Lead 独立复现：
// **只把数组里一个元素换成调用**就足以让两条判据整体归零）。
// 工具因此新增"按同源字面量表静态还原基元"的解析 —— 本节就是它的非空跑对照：
//   ① 纯字面量数组仍按**旧路径**正确解析（正对照：没把老路拆了）
//   ② 基元调用被还原，且**与字面量写法读数完全一致**（等价性）
//   ③ 动态实参 ⇒ 响亮报错并点名行（不许"认不出就当没有"）
//   ④ 表缺失 / 名字对不上 ⇒ 同样响亮报错；`vacuous` 语义**不许**被动过
// ════════════════════════════════════════════════════════════════

/** 合成样本：**全字面量**形态的面板骨架（⑥-a 的正对照；⑥-b 的等价性对照）。 */
function literalPanelFixture() {
  return [
    'function panelHTML() {',
    '  return [',
    `    '<div id="tavern-manager">',`,
    `    '    <div class="t-row" style="margin-top:8px">',`,
    `    '      <span>hi</span>',`,
    `    '    </div>',`,
    `    '  </div>',`,
    "  ].join('');",
    '}',
  ].join('\n')
}

/** 「一个字面量元素 + 一个基元元素」的最小合成样本（其余全字面量）。 */
export function minimalEmitterFixture() {
  return [
    'function panelHTML() {',
    '  var TV_ROW_OPEN = { 4: { \'margin-top:8px\': \'    <div class="t-row" style="margin-top:8px">\' } };',
    '  return [',
    `    '<div id="tavern-manager">',`,
    `    tvRowOpen(4, 'margin-top:8px'),`,
    `    '      <span>hi</span>',`,
    `    tvRowClose(),`,
    `    '  </div>',`,
    "  ].join('');",
    '}',
  ].join('\n')
}

test('⑥-a 正对照：纯字面量数组仍按**旧路径**解析（没把老路拆了）', (t) => {
  const src = literalPanelFixture()
  const ex = extractMarkupGroupsEx(src)
  const bal = checkTagBalanceGroups(src)
  t.diagnostic('纯字面量：groups=' + ex.groups.length + ' · problems=' + ex.problems.length + ' · scanned=' + bal.scanned)
  assert.equal(ex.groups.length, 1, '纯字面量数组必须仍被认成 1 组')
  assert.deepEqual(ex.problems, [], '纯字面量不该产生任何 problem')
  assert.ok(bal.scanned >= 4, '旧路径要真的扫到标签，实际 ' + bal.scanned)
  assert.equal(bal.ok, true, '合成样本本身是配平的：' + JSON.stringify(bal.errors))
})

test('⑥-b 基元调用被还原，且与**字面量写法读数完全一致**（等价 + 只换一个元素就够）', (t) => {
  const lit = literalPanelFixture()
  const emi = [
    'function panelHTML() {',
    '  var TV_ROW_OPEN = { 4: { \'margin-top:8px\': \'    <div class="t-row" style="margin-top:8px">\' } };',
    '  return [',
    `    '<div id="tavern-manager">',`,
    `    tvRowOpen(4, 'margin-top:8px'),`,
    `    '      <span>hi</span>',`,
    `    tvRowClose(),`,
    `    '  </div>',`,
    "  ].join('');",
    '}',
  ].join('\n')
  const a = checkTagBalanceGroups(lit)
  const b = checkTagBalanceGroups(emi)
  const c = checkCardDepth(emi)
  t.diagnostic('字面量：groups=' + a.groups + ' scanned=' + a.scanned + ' ｜ 基元：groups=' + b.groups +
    ' scanned=' + b.scanned + ' problems=' + b.problems.length)
  assert.equal(b.groups, 1, '★ 基元调用必须被还原成组（0 组就是"整组丢掉"，正是要挡的形态）')
  assert.deepEqual(b.problems, [], '能解析就不该报 problem：' + JSON.stringify(b.problems))
  assert.equal(b.groups, a.groups, '基元写法的组数必须与字面量写法一致')
  assert.equal(b.scanned, a.scanned, '★ 基元写法扫到的标签数必须与字面量写法**逐数相同**')
  assert.equal(b.ok, true, '还原后的 markup 仍是配平的：' + JSON.stringify(b.errors))
  assert.equal(c.vacuous, false, '还原后 ③ 也不该空跑')
  // mutate 自证：把那个元素改回"读不懂"的形态 ⇒ 读数必须**变**（否则上面那些"相等"毫无信息量）
  const broken = emi.replace(`tvRowOpen(4, 'margin-top:8px')`, 'tvRowOpen(4, someVar)')
  assert.notEqual(broken, emi, 'mutate 必须真的发生')
  assert.notEqual(checkTagBalanceGroups(broken).problems.length, 0, '坏样本必须报 problem（对照）')
})

test('⑥-c ★ 反证①：动态实参（`tvRowOpen(4, someVar)`）⇒ 响亮报错并点名行', (t) => {
  const good = minimalEmitterFixture()
  const bad = good.replace(`tvRowOpen(4, 'margin-top:8px')`, 'tvRowOpen(4, someVar)')
  assert.notEqual(bad, good, 'mutate 必须真的发生')
  const g = checkTagBalanceGroups(good)
  const b = checkTagBalanceGroups(bad)
  t.diagnostic('好样本 problems=' + g.problems.length + ' ｜ 动态实参 problems=' + b.problems.length +
    (b.problems[0] ? ' · 第 ' + b.problems[0].line + ' 行：' + b.problems[0].why : ''))
  assert.deepEqual(g.problems, [], '好样本不该报')
  assert.ok(b.problems.length >= 1, '★ 动态实参必须响亮报错（不许静默丢组）')
  assert.match(b.problems[0].why, /tvRowOpen/, '报错要点名是哪个基元：' + b.problems[0].why)
  assert.ok(b.problems[0].line > 0, '要能给出行号方便定位，实际 ' + b.problems[0].line)
  assert.equal(b.ok, false, '有 problem 时 ok 必须为 false（fail-closed）')
  // 同一份源码在 ③ 上也要报（两条网共用提取器）
  assert.ok(checkCardDepth(bad).problems.length >= 1, '③ 也必须看见同一条 problem')
})

test('⑥-d ★ 反证②：表缺失 / 名字对不上 ⇒ 同样响亮报错（不许"认不出就当没有"）', (t) => {
  const noTable = minimalEmitterFixture().replace(/^.*var TV_ROW_OPEN.*\n/m, '')
  const noTableR = checkTagBalanceGroups(noTable)
  t.diagnostic('表缺失：groups=' + noTableR.groups + ' · problems=' + JSON.stringify(noTableR.problems))
  assert.ok(noTableR.problems.length >= 1, '★ 表没了必须报 problem')
  assert.match(noTableR.problems[0].why, /TV_ROW_OPEN/, '报错要点名表：' + noTableR.problems[0].why)

  // 名字对不上（第三种形态）：仍然不许静默 —— 走"markup 数组里出现读不懂的调用"那条
  const otherName = minimalEmitterFixture().replace('tvRowOpen(4,', 'tvRowCell(4,')
  const otherR = checkTagBalanceGroups(otherName)
  t.diagnostic('陌生调用名：groups=' + otherR.groups + ' · problems=' + JSON.stringify(otherR.problems))
  assert.ok(otherR.problems.length >= 1, '★ markup 数组里的陌生调用必须报 problem，绝不许静默少一组')
  assert.match(otherR.problems[0].why, /调用元素/, '报错要说清是"读不懂的调用元素"：' + otherR.problems[0].why)

  // 正对照：同一份源码未改写 ⇒ 不报
  assert.deepEqual(checkTagBalanceGroups(minimalEmitterFixture()).problems, [], '未改写的样本不该报')
})

test('⑥-e ★ 反证③：`vacuous` 的语义**不许被动过**（空跑仍判失败）', () => {
  // 形态不是"数组拼装"⇒ 提取器抓不到 ⇒ 与迁移前完全一样地标记空跑
  const notAnArray = "const html = '<div data-tv-tab=\"a\"></div>'"
  assert.equal(checkCardDepth(notAnArray).vacuous, true, '抓不到卡片必须仍是空跑（语义不许动）')
  assert.equal(checkTagBalanceGroups(notAnArray).vacuous, true, '抓不到分组必须仍是空跑')
  // 基元坏样本：组被丢掉 ⇒ vacuous 仍然照旧为真（**不因为新增了 problems 就改口径**）
  const bad = minimalEmitterFixture().replace(`tvRowOpen(4, 'margin-top:8px')`, 'tvRowOpen(4, someVar)')
  const r = checkTagBalanceGroups(bad)
  assert.equal(r.groups, 0, '坏样本确实丢组')
  assert.equal(r.vacuous, true, '★ 丢组 ⇒ vacuous 仍必须为真（旧语义）；新增的 problems 是**额外**的一道，不是替换')
})

// ════════════════════════════════════════════════════════════════
// ⑦ ★ 覆盖下限（常驻棘轮）：把"网静默变小"变成机器看得见的红灯
//
// 为什么需要（审核方 2026-10 指出的形状）：`vacuous` 只兜**极端**（0 组 / 0 标签）⇒
// **中间缩水是静默的**：`scanned 610 → 300`、`total 12 → 3` 时 `vacuous` 仍是 `false`
// ⇒ 红灯不亮、网却小了一半。扩网只补**这一次**；下次有人再往数组里塞调用仍会重演。
// ⇒ 对**工具自身的覆盖指标**设**下限**（先测量再写死；合法扩面时**同笔抬下限**，口径"逐批只增"）。
//   先例：USAGE_FLOOR / TOKEN_FLOOR / REF_FLOOR / MIN_BLOB_HEADS。
//
// 下限来源（**迁移前**实测，时点 = task-25 笔2 落笔前，tip `da2eabc`）：
//   `scanned 610 / groups 1 · total 12 / groups 1`（另有第三方独立复现：Lead 在干净 worktree @da2eabc 复算一致）
// 复算命令：`node tools/check-client-integrity.mjs`（打印"② … 共扫描 N 个标签 / ③ 发现 M 个带 data-tv-tab 的元素"）
// ════════════════════════════════════════════════════════════════
export const COVERAGE_FLOORS = {
  scanned: 610,   // ② 标签配平：扫到的标签数下限（迁移前实测 610）
  groups: 1,      // ② 认出的 markup 数组分组数下限
  cards: 12,      // ③ 卡片深度：带 data-tv-tab 的元素数下限（迁移前实测 12）
}

test('⑦ 覆盖下限：②③ 的覆盖数不得低于迁移前实测值（含 diagnostics 四个数）', (t) => {
  const src = fs.readFileSync(REAL_CLIENT, 'utf8')
  const bal = checkTagBalanceGroups(src)
  const depth = checkCardDepth(src)
  t.diagnostic('覆盖读数：scanned=' + bal.scanned + ' / groups=' + bal.groups + ' / vacuous=' + bal.vacuous +
    ' ｜ total=' + depth.total + ' / groups=' + depth.groups + ' / vacuous=' + depth.vacuous +
    ' ｜ problems=' + bal.problems.length + '/' + depth.problems.length)
  t.diagnostic('下限来源（迁移前实测）：scanned>=' + COVERAGE_FLOORS.scanned + ' · groups>=' + COVERAGE_FLOORS.groups +
    ' · cards>=' + COVERAGE_FLOORS.cards + '（复算：node tools/check-client-integrity.mjs）')
  assert.deepEqual(bal.problems, [], '★ 基元解析失败 ⇒ ② 的覆盖已不可信：' + JSON.stringify(bal.problems))
  assert.deepEqual(depth.problems, [], '★ 基元解析失败 ⇒ ③ 的覆盖已不可信：' + JSON.stringify(depth.problems))
  assert.ok(bal.scanned >= COVERAGE_FLOORS.scanned,
    '★ ② 覆盖缩水：scanned ' + bal.scanned + ' < 下限 ' + COVERAGE_FLOORS.scanned +
    '（迁移前实测值）—— 有元素从覆盖里掉出去了（静默缩水不会有其它红灯）')
  assert.ok(bal.groups >= COVERAGE_FLOORS.groups, '★ ② 分组数低于下限：' + bal.groups)
  assert.ok(depth.total >= COVERAGE_FLOORS.cards,
    '★ ③ 覆盖缩水：total ' + depth.total + ' < 下限 ' + COVERAGE_FLOORS.cards +
    '（迁移前实测值）—— 卡片从覆盖里掉出去了')
  assert.equal(bal.vacuous, false, '② 不许空跑')
  assert.equal(depth.vacuous, false, '③ 不许空跑')
})
