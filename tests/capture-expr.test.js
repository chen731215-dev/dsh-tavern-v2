// ════════════════════════════════════════════════════════════════
// sink 提取器（captureExpr / findSuspects）的行为钉死测试
//
// 为什么单独一个文件：这些形态**不会出现在当前代码库里**（实测 0 处），
// 所以棘轮永远不会因为它们报红 —— 但"现在没有" ≠ "将来不会有人写"。
// 复核方（2026-10-08）用 13 个样例证明旧提取器在四种形态上失明，
// 本文件把那 13 个样例固化成断言：给坏样本必须报红，给好样本必须不报。
//
// 四种形态与判定：
//   ① 续行用**行首**运算符（`= esc(a)` 换行 `+ raw;`）—— 旧实现只吃首行 ⇒ 真·假阴性
//   ② 行尾注释未剥离 —— 注释文本进表达式；注释以运算符结尾会**吞掉下一行**
//   ③ 正则字面量里的引号污染引号状态（`/['"]/` ⇒ 捕获把行尾 `;` 也吃进去）
//   ④ 字符串字面量里出现的 sink 文本被当成真 sink（假阳性）
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureExpr, findSuspects, scanFiles, TARGETS, BASELINE_FILE } from '../tools/check-innerhtml-escape.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sinkRe = /\.innerHTML\s*(?:=|\+=)/
/** 抽出 sink 右边被捕获的表达式（测试里要钉"抓到了什么"，不只是"报没报"）。 */
function captured(src) {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(sinkRe)
    if (m) return captureExpr(lines, i, m.index + m[0].length)
  }
  return null
}

test('① 续行用「行首运算符」必须被吃进来，且其中的裸值必须报红（旧实现的真·假阴性）', () => {
  const bad = `el.innerHTML = esc(a)\n  + rawHtml;`
  assert.equal(captured(bad), 'esc(a)\n  + rawHtml', '续行必须整段捕获，不能只吃第一行')
  assert.equal(findSuspects(bad).length, 1, '★ 裸值 rawHtml 必须被点名')

  // 反证：同样形态、但续行也转义了 ⇒ 不许报（防"判定过宽"）
  const good = `el.innerHTML = esc(a)\n  + esc(rawHtml);`
  assert.equal(captured(good), 'esc(a)\n  + esc(rawHtml)')
  assert.deepEqual(findSuspects(good), [], '两边都 esc 了不该报')
})

test('② 行尾注释不得进表达式、更不得吞掉下一行（三种形态）', () => {
  const cases = [
    `el.innerHTML = esc(a); // 提示 (见文档)`,
    `el.innerHTML = esc(a) // 提示 (见文档)\nnext();`,
    `el.innerHTML = esc(a) // 备注 +\nnext();`,
    `el.innerHTML = esc(a) // 说明：不要用 'quote'\nnext();`,
  ]
  for (const src of cases) {
    assert.equal(captured(src), 'esc(a)', '注释必须被剥掉，只留表达式：' + JSON.stringify(src))
    assert.deepEqual(findSuspects(src), [], '注释不该制造可疑行（旧实现会吞下一行 next() 并误报）：' + JSON.stringify(src))
  }
})

test('③ 正则字面量里的引号不得污染捕获（`/[\'"]/` 不该吃掉行尾 `;`）', () => {
  const src = `el.innerHTML = String(x).replace(/['"]/g, '');`
  const got = captured(src)
  assert.equal(got, `String(x).replace(/['"]/g, '')`, '捕获必须止于分号，不能把 `;` 带进来')
  // 保守判定：没走 esc 的 replace 仍应被点名（宁可多报）
  assert.equal(findSuspects(src).length, 1, '不含 esc 的拼接仍应保守地报出来')
})

test('④ 字符串字面量里的 sink 文本不是 sink（假阳性）；真 sink 仍须被抓', () => {
  const falsePositive = `const msg = "el.innerHTML = " + esc(x);`
  assert.deepEqual(findSuspects(falsePositive), [], '★ 字符串里的 sink 文本不得被当成真 sink')

  const real = `el.innerHTML = 'x' + raw;`
  assert.equal(findSuspects(real).length, 1, '真 sink + 裸值必须被抓（防"修过头"把判据修没了）')
})

test('⑤ 下一行是注释（`//` 或 JSDoc 的 `*`）时不得当成表达式续行', () => {
  // 这条是修 ① 时自查发现的自身风险：两种注释都以运算符字符开头
  for (const src of [`el.innerHTML = esc(a)\n// 说明\nnext();`, `el.innerHTML = esc(a)\n * JSDoc 续行\nnext();`]) {
    assert.equal(captured(src), 'esc(a)', '注释行不是续行：' + JSON.stringify(src))
    assert.deepEqual(findSuspects(src), [], '不该误报')
  }
})

test('⑥ 真实代码库：基线里每一条都必须**仍然被扫到**（防静默遗漏）', () => {
  // 棘轮测试① 只查「新增」，不查「消失」—— 提取器改动若把某条漏掉，那边不会报。
  // 这里把「消失」显式化：有意消除（在用处加了 esc）请跑 --update 并说明，别让它悄悄不见。
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).entries || []
  const key = (e) => e.file + ' | ' + (e.sink || 'innerHTML') + ' | ' + (e.occ || 1) + ' | ' + e.line
  const actual = new Set(scanFiles(TARGETS).map(key))
  const missing = baseline.filter((e) => !actual.has(key(e)))
  assert.deepEqual(
    missing.map((e) => `${e.file}:${e.lineNo}[${e.sink}]`),
    [],
    '★ 这些基线条目不再被扫到 —— 若是有意消除（已加 esc），跑 `node tools/check-innerhtml-escape.mjs --update` 并在提交信息里说明；若是无意，说明提取器改动漏判了',
  )
})

test('⑦ 反证组：真实漏洞形态（转义一个、漏一个）与"新建渲染路径"都必须被抓', () => {
  // PR #13 的真实翻车形态：转义了 e.source/e.target，漏了 label
  const pr13 = `tooltip.innerHTML = '<b>' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div><div>' + label + '</div>';`
  assert.equal(findSuspects(pr13).length, 1, '漏掉的 label 必须被点名')

  // 换一个全新变量名（旧「按变量名写死」的判据在这里是盲的）
  const fresh = `el.innerHTML = '<span>' + node.displayName + '</span>';`
  assert.equal(findSuspects(fresh).length, 1, '★ 新变量名 + 裸拼也必须被抓')
  assert.ok(REPO.length > 0)
})
