/**
 * 选项按钮点击必须真的能发消息（作用域桥回归）。
 *
 * 真实事故（2026-11-01）：`<options><option>` 渲染成按钮后**点了没反应**。
 *
 * 根因是**作用域**，不是选择器也不是样式：
 *   · `sendTavernMessage()` 定义在 `initMessageBeautifier()` 内部（局部函数）；
 *   · 选项点击的 document 委托注册在 `apply()` 里 —— 那里**看不见**它；
 *   · 旧代码在委托里裸调 `sendTavernMessage(t)` ⇒ 每次点击抛 `ReferenceError`；
 *   · 而它前面的 `e.stopPropagation()` 已经把 muv-engine 后注册的委托掐掉
 *     ⇒ 两个插件都"以为自己处理了"，用户看到的就是**完全没反应**。
 *
 * 修法：`initMessageBeautifier` 里把发送函数挂到 `window.__tavernSendMessage`，
 * 委托改用这个桥；拿不到就**直接 return**（连 preventDefault 都不加），
 * 把点击原样交回 muv 的委托。
 *
 * 本套件钉四件事：
 *   ① `apply()` 段里**不许**出现裸调 `sendTavernMessage(`（这正是事故形态）；
 *   ② 桥要在 `initMessageBeautifier` 里赋值（放错地方等于没接上）；
 *   ③ 委托必须先判 `typeof send === 'function'` 再 preventDefault；
 *   ④ 反例：用旧代码片段跑同一判据必须报红（证明判据不是永真）。
 *
 * 运行：node --test tests/option-click-bridge.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')

/** `apply(ctx)` 的函数体（到 `exports.apply = apply` 为止）。 */
function applyBody(src) {
  const start = src.indexOf('    function apply(ctx) {')
  assert.ok(start > 0, '找不到 apply(ctx)')
  const end = src.indexOf('    exports.apply = apply;', start)
  assert.ok(end > start, '找不到 exports.apply')
  return src.slice(start, end)
}

/** `initMessageBeautifier()` 的函数体（到 `function apply(ctx)` 为止）。 */
function beautifierBody(src) {
  const start = src.indexOf('    function initMessageBeautifier() {')
  assert.ok(start > 0, '找不到 initMessageBeautifier')
  const end = src.indexOf('    function apply(ctx) {', start)
  return src.slice(start, end)
}

/** 判据：这段代码里有没有「裸调 sendTavernMessage(」——前面不是 `.` 或标识符字符。 */
function hasBareCall(code) {
  return /(^|[^.\w$])sendTavernMessage\s*\(/m.test(code)
}

test('① apply() 里不许裸调 sendTavernMessage（那就是本事故的形态）', () => {
  const apply = applyBody(SRC)
  assert.equal(hasBareCall(apply), false,
    '★ apply 作用域里看不见 sendTavernMessage；裸调必然 ReferenceError ⇒ 点选项没反应')
})

test('② 发送函数挂在 window 上，且赋值发生在 initMessageBeautifier 内', () => {
  assert.match(SRC, /window\.__tavernSendMessage\s*=\s*sendTavernMessage/,
    '缺少 window.__tavernSendMessage 桥')
  const beaut = beautifierBody(SRC)
  assert.match(beaut, /window\.__tavernSendMessage\s*=\s*sendTavernMessage/,
    '★ 桥必须在 initMessageBeautifier 里赋值（sendTavernMessage 只在那儿可见）')
})

test('③ 委托先取桥再判断，拿不到就放行（不吞掉点击）', () => {
  const apply = applyBody(SRC)
  assert.match(apply, /var send = window\.__tavernSendMessage/)
  assert.match(apply, /if \(typeof send !== 'function'\) return/,
    '★ 拿不到桥时必须直接 return —— 否则 preventDefault + stopPropagation 会把 muv 的委托也掐掉')
  // 顺序：先判桥 → 再 preventDefault
  const iGuard = apply.indexOf('if (typeof send !== \'function\') return')
  const iPrevent = apply.indexOf('e.preventDefault()', apply.indexOf('__tavernOptionDelegate'))
  assert.ok(iGuard > 0 && iPrevent > iGuard, '★ 必须「先判桥、后 preventDefault」')
})

test('④ 反例：旧代码（裸调）必须被这条判据抓住', () => {
  const OLD = [
    "      if (!window.__tavernOptionDelegate) {",
    "        document.addEventListener('click', function (e) {",
    "          var el = e.target.closest('.tavern-option-btn');",
    "          if (!el) return;",
    "          e.preventDefault(); e.stopPropagation();",
    "          var t = el.getAttribute('data-opt');",
    "          if (t) sendTavernMessage(t);",
    "        }, true);",
    "      }",
  ].join('\n')
  assert.equal(hasBareCall(OLD), true, '反例应当被判红 —— 否则 ① 的判据是永真的（测不出问题）')
  assert.equal(hasBareCall(applyBody(SRC)), false, '★ 真实现必须没有裸调')
})
