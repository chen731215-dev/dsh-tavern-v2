/**
 * 客户端「当前会话 id」解析回归测试（dshMainViewSessionId）
 *
 * 背景（用户报的故障）：面板必须「先发一条消息」才能把角色卡绑到会话。
 * 根因在客户端：旧实现读 `ctx.sessions.list.getSnapshot().current` —— 而 DSH 的
 * 会话列表快照里**根本没有 current 字段**（注入只写 {ids, byId, phase, projectionsBySession}），
 * 且 DSH 从不用 URL 表达会话（ui-workspace 无任何 location/history 用法），
 * 于是空白新会话拿不到 id ⇒ 绑定被挡。
 *
 * 真正的判据是列表行上的 `retainedBy.mainView > 0`（DSH 自己 mainSessionId()/isMain()/
 * uiSession 用的就是它，空白新会话同样生效）。
 *
 * 本测试**直接对打包产物里的函数源码求值**（不是复制一份逻辑），保证测的就是要发布的那份：
 *   1. 函数存在且不再依赖 snap.current；
 *   2. 只认 retainedBy.mainView 命中的那一行，并归一化成 `session-<uuid>`；
 *   3. 空白新会话（无消息、mainView=1）同样能取到 —— 这条就是本次修复的核心；
 *   4. 取不到时如实返回空串（绝不用"上一个会话"的缓存值顶替 ⇒ 不串台）。
 *
 * 运行：node tests/client-main-view-session.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lib', 'client.manager.bundle.js')
const SRC = fs.readFileSync(BUNDLE, 'utf8')

/** 从打包产物里抠出 dshMainViewSessionId 的源码并求值，返回可直接调用的函数。 */
function loadMainViewResolver() {
  const m = SRC.match(/function dshMainViewSessionId\(svcArg\) \{[\s\S]*?\n {6}\}/)
  assert.ok(m, '打包产物里应当有 dshMainViewSessionId（客户端没有源码仓库，改的就是这份 bundle）')
  const factory = new Function('window', m[0] + '\nreturn dshMainViewSessionId;')
  return factory({})            // 传空 window：测试里一律显式传 svc，不依赖全局
}

const dshMainViewSessionId = loadMainViewResolver()

const UUID_A = '01c8609b-1f2e-4a3b-9c4d-5e6f70819234'
const UUID_B = '25d0a28b-fdd0-4658-bc9c-e395f2ff9d53'

/** 造一个像 DSH 那样的会话服务：list.getSnapshot() → {ids, byId, phase, projectionsBySession} */
function svcOf(rows) {
  const byId = {}
  const ids = []
  for (const row of rows) { byId[row.id] = row; ids.push(row.id) }
  return { list: { getSnapshot: () => ({ ids, byId, phase: 'ready', projectionsBySession: {} }) } }
}
function row(id, retainedBy, extra) {
  return Object.assign({ id, blank: false, retainedBy: retainedBy || {} }, extra || {})
}

// ── 1. 旧实现的死因必须真的被拿掉 ────────────────────────────
test('[1] 打包产物里不再把 snap.current 当权威（除兼容分支外零出现）', () => {
  // 去掉整行注释再数，免得把「解释这件事的注释」算成用法
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  const hits = CODE.match(/snap\.current/g) || []
  assert.equal(hits.length, 2, 'snap.current 只允许出现在函数内那条旧版兼容分支上（cond + 取值各一次）')
  assert.ok(/var legacy = snap\.current \? String\(snap\.current\) : ''/.test(CODE), '兼容分支的形态必须明确、可检索')
  const calls = CODE.match(/dshMainViewSessionId\(/g) || []
  assert.ok(calls.length >= 4, '函数定义 + 三处调用点（getCurrentSessionId / resolveCurrentSessionId / resolveFromServer）都要走它')
  assert.ok(/rb\.mainView/.test(CODE), '判定必须基于 retainedBy.mainView')
})

// ── 2. 主视图命中 ⇒ 归一化成 session-<uuid> ─────────────────
test('[2] retainedBy.mainView>0 的那一行就是当前会话（裸 uuid 也要补 session- 前缀）', () => {
  const svc = svcOf([
    row('session-' + UUID_A, { mainView: 1 }),
    row(UUID_B, { mainView: 0, sidebar: 1 }),
  ])
  assert.equal(dshMainViewSessionId(svc), 'session-' + UUID_A)
})

test('[3] 会话 id 是裸 uuid（DSH 目录里常见）时，返回统一带 session- 前缀', () => {
  const svc = svcOf([row(UUID_B, { mainView: 1 })])
  assert.equal(dshMainViewSessionId(svc), 'session-' + UUID_B)
})

// ── 3. 本次修复的核心：空白新会话也能取到 ────────────────────
test('[4] 空白新会话（还没发过消息、blank:true、mainView:1）必须能取到 id —— 不再要求「先发一条消息」', () => {
  const svc = svcOf([row('session-' + UUID_B, { mainView: 1 }, { blank: true })])
  assert.equal(dshMainViewSessionId(svc), 'session-' + UUID_B)
})

test('[5] 侧栏里还有别的空白行（未被主视图引用）⇒ 不会被误选（DSH 只显示当前那个空白行）', () => {
  const svc = svcOf([
    row('session-' + UUID_A, { sidebar: 1 }, { blank: true }),   // 别人的空白行
    row('session-' + UUID_B, { mainView: 1 }, { blank: true }),  // 真正在看的那条
  ])
  assert.equal(dshMainViewSessionId(svc), 'session-' + UUID_B)
})

test('[6] mainView 只有 0/缺失 ⇒ 返回空串（绝不拿缓存/上一个会话顶替，杜绝串台）', () => {
  assert.equal(dshMainViewSessionId(svcOf([row('session-' + UUID_A, { mainView: 0 })])), '')
  assert.equal(dshMainViewSessionId(svcOf([row('session-' + UUID_A, {})])), '')
  assert.equal(dshMainViewSessionId(svcOf([])), '')
})

// ── 4. 容错：服务/快照缺失或形状不对，一律空串，不抛 ──────────
test('[7] 服务缺失 / 快照畸形 ⇒ 空串，不抛（客户端必须能安全降级到后面的兜底）', () => {
  assert.equal(dshMainViewSessionId(undefined), '')
  assert.equal(dshMainViewSessionId(null), '')
  assert.equal(dshMainViewSessionId({}), '')
  assert.equal(dshMainViewSessionId({ list: {} }), '')
  assert.equal(dshMainViewSessionId({ list: { getSnapshot: () => null } }), '')
  assert.equal(dshMainViewSessionId({ list: { getSnapshot: () => ({}) } }), '')
  assert.equal(dshMainViewSessionId({ list: { getSnapshot: () => { throw new Error('boom') } } }), '')
  assert.equal(dshMainViewSessionId(svcOf([row('', { mainView: 1 })])), '')
})

// ── 5. 兼容分支：将来若 DSH 补了 current 字段，仍能认 ─────────
test('[8] 快照上真有 current 字段时（未来兼容）当作最后兜底认下来', () => {
  const svc = { list: { getSnapshot: () => ({ ids: [], byId: {}, current: UUID_A }) } }
  assert.equal(dshMainViewSessionId(svc), 'session-' + UUID_A)
  const svcBad = { list: { getSnapshot: () => ({ ids: [], byId: {}, current: 'not-an-id' }) } }
  assert.equal(dshMainViewSessionId(svcBad), '')
})

// ── 6. 面板上的「声明为 DSH 预设」开关（用户自己按的那个键）────
test('[9] 面板要有声明开关的四个元素（状态 + 三个按钮），且默认文案说清「写入前先给你看预览」', () => {
  for (const id of ['tavern-declare-status', 'tavern-declare-apply', 'tavern-declare-bundle', 'tavern-declare-off']) {
    assert.ok(SRC.includes(`id="${id}"`), '面板缺少元素：' + id)
  }
  assert.ok(/自动备份/.test(SRC), '提示里要写明会自动备份')
})

test('[10] 声明按钮必须「先 dry-run 预览 → window.confirm → 才 POST」', () => {
  const i = SRC.indexOf('elDeclareApply.addEventListener')
  assert.ok(i > 0, '找不到声明按钮的接线')
  const body = SRC.slice(i, i + 1600)
  const iPrevCall = body.indexOf('declarePreview()')
  const iConfirm = body.indexOf('window.confirm')
  const iPost = body.indexOf('apply: true, confirm: true')
  assert.ok(iPrevCall > 0 && iConfirm > 0 && iPost > 0, '预览 / 确认 / 写入三步都要在')
  assert.ok(iPrevCall < iConfirm && iConfirm < iPost, '★ 顺序必须是先预览、再确认、最后才写')
  assert.ok(!/method: 'POST'[\s\S]{0,120}window\.confirm/.test(body), '不许先写后问')

  // 预览函数本身必须是**只读 GET**：取那个 URL 时不许带 method: 'POST'
  const j = SRC.indexOf('async function declarePreview')
  assert.ok(j > 0, '找不到 declarePreview')
  const prevBody = SRC.slice(j, j + 600)
  assert.ok(prevBody.includes('/api/tavern/preset-declarations'), '预览打的是同一个接口（不带 apply 就是 dry-run）')
  assert.ok(!prevBody.includes("method: 'POST'"), '★ 预览必须是只读 GET')
})

test('[11] 撤下声明也必须有 confirm（一件会动 DSH 配置的事不许一键误触）', () => {
  const i = SRC.indexOf("elDeclareOff.addEventListener")
  assert.ok(i > 0, '找不到撤下按钮的接线')
  const body = SRC.slice(i, i + 900)
  assert.ok(body.includes('window.confirm'), '撤下前必须确认')
  assert.ok(body.includes('remove: true, confirm: true'), '撤下要显式带 remove+confirm')
  assert.ok(body.includes('块外内容不动'), '文案要说明只摘自己那一块')
})

test('[12] bundle 按钮打到 /api/tavern/preset-bundle，并把安装方式显示出来', () => {
  const i = SRC.indexOf("elDeclareBundle.addEventListener")
  assert.ok(i > 0, '找不到 bundle 按钮的接线')
  const body = SRC.slice(i, i + 900)
  assert.ok(body.includes('/api/tavern/preset-bundle'))
  assert.ok(body.includes('installHint'), '要把 plugin_manager 的安装方式告诉用户')
})

// ── 8. 预设查找：两套 id 空间（酒馆 id / DSH 目录名）都要认 ──────
/** 从打包产物里**按花括号配对**抠出一个函数源码（正则抠容易被内层 `}` 截断）。 */
function extractFunctionSource(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > 0, '打包产物里应当有 ' + name)
  let depth = 0
  let seen = false
  for (let i = start; i < SRC.length; i++) {
    const ch = SRC[i]
    if (ch === '{') { depth++; seen = true; continue }
    if (ch === '}') {
      depth--
      if (seen && depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error('花括号没配平：' + name)
}

/** 抠出 matchPresetInList 并求值（list 是参数，可直接喂）。 */
function loadMatchPreset() {
  return new Function('return (' + extractFunctionSource('matchPresetInList') + ');')()
}

test('[14] matchPresetInList：id（目录名）/ presetId（注册表 id）/ dir 三种写法都认', () => {
  const list = [
    { id: 'tavern-lite', presetId: 'default', name: '酒馆默认', dir: '<home>\\.dsh\\.agent-presets\\tavern-lite' },
    { id: 'preset-role', presetId: 'preset-role', name: '角色扮演', dir: '<home>\\.dsh\\.agent-presets\\preset-role' },
    { id: 'agent-only', presetId: null, name: '深潜区', dir: 'agent-only' },
  ]
  const match = loadMatchPreset()

  assert.equal(match(list, 'tavern-lite').name, '酒馆默认', '① 按列表 id（DSH 目录名）')
  assert.equal(match(list, 'default').name, '酒馆默认', '② ★ 按酒馆注册表 id（账本里记的就是它）')
  assert.equal(match(list, '<home>\\.dsh\\.agent-presets\\preset-role').name, '角色扮演', '③ 按 dir 绝对路径')
  assert.equal(match(list, 'preset-role').name, '角色扮演', '④ 目录名与 id 同名时同样命中')
  assert.equal(match(list, 'agent-only').name, '深潜区', '裸目录名的 agent 预设也认')
  assert.equal(match(list, 'nope'), null, '真的不存在才返回 null（不许瞎认）')
  assert.equal(match(list, ''), null)
  assert.equal(match(list, undefined), null)
  assert.equal(match([], 'anything'), null, '空列表不抛')
  assert.equal(match(null, 'x'), null, '列表缺失不抛')
})

test('[15] 两处命中路径都必须走 matchPresetInList（否则会静默切错编辑目标 / 显示假告警）', () => {
  // 绑定卡处
  const iFind = SRC.indexOf('function findPreset(id)')
  assert.ok(iFind > 0, '找不到 findPreset')
  assert.ok(SRC.slice(iFind, iFind + 260).includes('matchPresetInList(presetList, id)'), 'findPreset 必须委托给它')

  // 预设标签（编辑目标）处：命中后要把 activeId 统一成列表条目的 id，命中不了才回退第一个
  const iLabel = SRC.indexOf('var matched = matchPresetInList(data.presets || [], activeId)')
  assert.ok(iLabel > 0, '★ 标签处必须用它判断，不许再裸写 `p.id === activeId`')
  const body = SRC.slice(iLabel, iLabel + 900)
  assert.ok(body.includes('activeId = matched.id'), '命中后统一 id 空间（下游 dataset/保存目标都认它）')
  assert.ok(body.includes('if (!matched)'), '只有真的找不到才回退')
  assert.ok(!SRC.slice(iLabel - 500, iLabel).includes('find(function (p) { return p.id === activeId; })'), '旧的裸比较必须已经拿掉')
})
test('[13] 显示层不许只看酒馆账本：原生权威（顶部选择）要覆盖账本字段', () => {
  const j = SRC.indexOf('function authoritativeFields')
  assert.ok(j > 0, '缺少 authoritativeFields 折算函数')
  const fn = SRC.slice(j, j + 800)
  assert.ok(fn.includes("'top-select'"), 'native / explicit 要折算成「顶部选择」')
  assert.ok(fn.includes("authId === 'default'"), 'default ⇒ 视为未绑定（而不是显示成某张卡）')

  const i = SRC.indexOf('var auth = authoritativeFields(mine)')
  assert.ok(i > 0, 'loadBinding 里没用它')
  const before = SRC.slice(Math.max(0, i - 1200), i)
  assert.ok(before.includes('mine.boundPreset'), '先读账本字段（顺序：账本 → 原生权威覆盖）')
  assert.ok(SRC.slice(i, i + 300).includes('bound.presetId = auth.presetId'), '确实覆盖了 bound.presetId')
})
