// ════════════════════════════════════════════════════════════════
// 结构化判据的对抗样例（来自独立复核报告 2026-10-08 §2，全部可复现）
//
// 背景：复核方用 11 个样例证明 —— **只修 captureExpr 一个扫描器是不够的**：
//   `splitTopLevel` 与 `insideStringSink` 各自数引号，正则里的引号污染它们之后，
//   表达式会塌成一段，而旧的 `ESCAPE_CALL.test(段)` 就退化成「整行有 esc 就放行」。
//   实测被放行的真洞包括：模板插值混裸值、括号里混裸值、无括号三元、逻辑与、
//   调用实参、`.map` 体内混裸值（PR #13 同一类）、正则字面量导致的塌段与 sink 失配。
//
// 判据核心已收敛成**唯一一处**共享扫描原语（eachCodeChar / regexEndAt）并改为结构化递归。
// 本文件那 9 类必须报红、2 类对照组必须放行 —— **改判定逻辑时这是主要回归网**。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSuspects } from '../tools/check-innerhtml-escape.mjs'

/** 9 类真漏报：必须报红（每条都曾在旧判据下被放行） */
const MUST_FLAG = [
  ['模板插值里一个转义、一个裸插值', 'el.innerHTML = `<img src="${esc(url)}" onerror="${raw}">`;'],
  ['括号里混一个裸值（左）', 'el.innerHTML = (raw + esc(a));'],
  ['括号里混一个裸值（右）', 'el.innerHTML = (esc(a) + raw);'],
  ['无括号三元：某一支裸值', 'el.innerHTML = cond\n ? esc(a)\n : raw;'],
  ['逻辑与：右操作数裸值', 'el.innerHTML = esc(a)\n && raw;'],
  ['调用实参里混一个裸值', 'el.innerHTML = buildHtml(esc(a), raw);'],
  ['map 体内混一个裸值（PR #13 同一类）', "el.innerHTML = list.map(x => esc(x.a) + x.b).join('');"],
  ['正则字面量 + 裸值（splitTopLevel 曾塌段）', "el.innerHTML = esc(s.replace(/['\"]/g, '')) + raw;"],
  ['正则污染致真 sink 失配（insideStringSink 曾跳过整行）', "var q = s.replace(/['\"]/g,'x'); el.innerHTML = raw;"],
]

/** 对照组：必须放行（判据不许"过严"到把安全代码判红） */
const MUST_PASS = [
  ['两边都转义的模板插值', 'el.innerHTML = `<img src="${esc(url)}" alt="${esc(alt)}">`;'],
  ['map 体内两边都转义', "el.innerHTML = list.map(x => esc(x.a) + esc(x.b)).join('');"],
]

test('① 9 类真漏报必须全部报红（旧判据放行过它们）', () => {
  const missed = MUST_FLAG.filter(([, src]) => findSuspects(src).length === 0).map(([name]) => name)
  assert.deepEqual(missed, [], '★ 这些形态又被放行了（判据退化）：' + missed.join(' / '))
})

test('② 对照组必须全部放行（防判据过严）', () => {
  const over = MUST_PASS.filter(([, src]) => findSuspects(src).length > 0).map(([name]) => name)
  assert.deepEqual(over, [], '★ 这些安全形态被误判为可疑：' + over.join(' / '))
})

test('③ 非空跑对照：最朴素的两类必须仍然是"裸值报红 / 转义放行"', () => {
  assert.equal(findSuspects("el.innerHTML = 'x' + raw;").length, 1, '裸值必须报红')
  assert.equal(findSuspects("el.innerHTML = 'x' + esc(raw);").length, 0, '转义必须放行')
})
