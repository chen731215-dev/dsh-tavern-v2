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
  collectJsIds, collectMarkupIds, extractMarkupGroups, blankTemplateExpr, VOID_TAGS,
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
