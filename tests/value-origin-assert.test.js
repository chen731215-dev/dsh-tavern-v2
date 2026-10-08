// ════════════════════════════════════════════════════════════════
// 「值来源」结构断言 + param-by-callers 两条的处置回归（2.7.14）
//
// 背景（复核方 2026-10-08 的裁定）：
//   基线里 `param-by-callers` 那两条（helper 把入参当 HTML 写）是本套护栏里**证据最弱**的一类：
//   `mustContain` 只能钉住"某些片段还在"，挡不住"往同一条拼装链里新加一个未转义片段"。
//   处置分两条路：
//     · 开场白面板那个 helper（5 个调用点全纯文本）⇒ **改代码**：`textContent`，结构上消除这一类；
//     · 全局正则面板那个（有调用点刻意渲染 `<br><span>`）⇒ **不能改**，改守「值来源」：
//       从变量声明到 sink 调用之间的每个 `+` 分段都必须安全。
//
// 本文件守四件事：
//   ① 值来源断言今天通过（真实代码库）；
//   ② **坏样本必须报红**（往链里塞裸值 / 撤掉上游 esc / 锚点消失）—— 防"永真判据"；
//   ③ 两条 helper 的最终形态被钉死（开场白=textContent，全局正则=innerHTML + 断言）；
//   ④ 基线里那条已被消除、且没顺手多消（棘轮是单调的）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORIGINS, valueOriginUnsafe, BASELINE_FILE } from '../tools/check-innerhtml-escape.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_REL = 'lib/client.manager.bundle.js'
const cli = fs.readFileSync(path.join(REPO, CLI_REL), 'utf8')
const spec = ORIGINS[0]
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).entries || []

test('① 真实代码库：值来源断言必须通过（h 由计数与 esc 拼成）', () => {
  assert.deepEqual(valueOriginUnsafe(cli, spec), [], '现有拼装链不该有未转义片段')
})

test('② 坏样本必须报红：往同一条链里**新加**一个未转义片段', () => {
  // 这正是复核方给的验收条件：「往同一条链里新加未转义片段必须报红」
  const mutated = cli.replace(
    spec.decl,
    spec.decl + "'';\n            html += '<br>' + d.note;   // ← 注入的坏样本\n            var _unused = ",
  )
  assert.notEqual(mutated, cli, '替换必须真的发生（否则下面的断言是永真）')
  const issues = valueOriginUnsafe(mutated, spec)
  assert.ok(issues.length >= 1, '★ 新加的裸片段必须被点名')
  assert.ok(issues.some((i) => i.includes('d.note')), '点名要包含违规片段本身：' + JSON.stringify(issues))
})

test('③ 坏样本必须报红：撤掉上游 esc', () => {
  const chain = "var html = '✅ 导入完成"
  const from = cli.indexOf(chain)
  assert.ok(from > 0, '找不到链的起点（下面的替换会变成空操作）')
  const to = cli.indexOf('setStatus(html', from)
  const seg = cli.slice(from, to)
  assert.ok(seg.includes('esc(String('), '链里应当有 esc(String(...)) —— 否则本测试的前提不成立')
  const mutated = cli.slice(0, from) + seg.replace('esc(String(', 'String(') + cli.slice(to)
  const issues = valueOriginUnsafe(mutated, spec)
  assert.ok(issues.length >= 1, '★ 撤掉 esc 后必须报红')
})

test('④ 锚点消失必须**响亮失败**（不许静默通过）', () => {
  const noDecl = cli.replace("var html = '✅ 导入完成", "var htmlSnapshot = '✅ 导入完成")
  const i1 = valueOriginUnsafe(noDecl, spec)
  assert.ok(i1.length === 1 && /找不到声明行/.test(i1[0]), '声明行找不到 ⇒ 必须报"证据失效"，而不是返回空数组')

  const noCall = cli.replace('setStatus(html,', 'setStatusHtml(html,')
  const i2 = valueOriginUnsafe(noCall, spec)
  assert.ok(i2.length === 1 && /找不到调用行/.test(i2[0]), '调用行找不到 ⇒ 同样必须报"证据失效"')
})

test('⑤ 两条 helper 的最终形态钉死（防回退）', () => {
  // 开场白 helper：**不许**再回到 innerHTML（回退即报红）
  assert.ok(cli.includes('status.textContent = msg;'), '开场白 helper 应当是 textContent')
  assert.equal(
    /function setStatus\(msg, color\) \{[^}]*status\.innerHTML/.test(cli),
    false,
    '★ 开场白 helper 不得回退成 innerHTML（那是 param-by-callers 类的来源）',
  )
  // 全局正则 helper：**必须**保留 innerHTML（它要渲染 <br><span> 标记），靠值来源断言守
  assert.ok(cli.includes('statusEl.innerHTML = msg;'), '全局正则 helper 应保留 innerHTML —— 改 textContent 会把标签当文字显示')
})

test('⑥ 基线：开场白那条已消除，全局正则那条仍在（棘轮单调且没顺手多消）', () => {
  const hasGreetingHelper = baseline.some((e) => /function setStatus\(msg, color\) \{ status\.innerHTML/.test(e.line))
  assert.equal(hasGreetingHelper, false, '开场白 helper 那条应当已从基线消失（改 textContent 后结构上不再适用）')
  const hasStatusEl = baseline.some((e) => /statusEl\.innerHTML = msg;/.test(e.line))
  assert.ok(hasStatusEl, '全局正则那条必须仍在基线里（它仍靠 param-by-callers 证据 + 值来源断言守）')
  assert.ok(baseline.length > 0)
})
