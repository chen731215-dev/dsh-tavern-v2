/**
 * P0-6：「🎯 生效范围」傻瓜式面板 —— 客户端行为测试 + 出厂默认 global 后端测试
 *
 * 被测对象是 client.manager.bundle.js 里 mountTavernManager() 内的：
 *   · (function initScopePanel(){…})()   （P0-6 生效范围卡，锚点提取）
 * 以及 lib/index.js 的 readState() 出厂默认（DSH_HOME 隔离，动态 import）。
 * 客户端代码没有 DOM，沿用 tests/binding-panel-ui.test.js 的套路：vm 沙箱 + FakeEl，
 * fetch / showPrompt / document 由沙箱注入。
 *
 * 判据纪律（本项目铁律）：关键判据都配一支「对照臂」—— 对被测源码做一处变异，
 * 同样的断言必须失败。对照臂红 = 判据真的在测东西。
 *
 * 面板语义（发布版）：
 *   · 注入资格 = 「🔗 当前会话绑定」的显式绑定闸门；本卡只管「生效范围」。
 *   · 三个按钮 = global / allowlist+allowSessions / allowlist+allowCwds。
 *   · 自动检测优先（currentCwd / currentSessionId 来自 GET state），取不到才 showPrompt。
 *
 * 运行：node --test tests/scope-panel-ui.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(__dirname, '..', 'lib', 'client.manager.bundle.js')

// ── 抽出被测源码段（锚点：起始注释 → 结束注释）──
function extractSource(bundleText) {
  const start = bundleText.indexOf('// ── P0-6：生效范围傻瓜式面板')
  const end = bundleText.indexOf('// ── P0-6 结束 ──')
  if (start < 0 || end < 0 || end <= start) throw new Error('bundle 里找不到 P0-6 源码段')
  return bundleText.slice(start, end)
}

/** 对照臂专用：对被测源码做**一处**变异。锚点必须真的命中，否则抛错。 */
function mutate(bundleText, from, to) {
  const src = extractSource(bundleText)
  if (src.indexOf(from) < 0) throw new Error('变异锚点未命中（判据失效，测试写错了）：' + from)
  return src.replace(from, to)
}

// ── 假元素（支持 children 树：chips 渲染用 createElement/appendChild/removeChild）──
class FakeEl {
  constructor(tag, attrs = {}) {
    this._tag = tag || 'div'
    this.attrs = Object.assign({}, attrs)
    this.listeners = {}
    this.children = []
    this.style = {}
    this.textContent = ''
    this.value = attrs.value != null ? attrs.value : ''
    this.type = ''
    this.title = ''
    this._innerHTML = ''
    this._innerHTMLWrites = 0 // 安全判据：本面板禁止 innerHTML 拼接，任何写入都会被记下
  }
  get innerHTML() { return this._innerHTML }
  set innerHTML(v) { this._innerHTMLWrites++; this._innerHTML = String(v) }
  get firstChild() { return this.children.length ? this.children[0] : null }
  appendChild(c) { this.children.push(c); return c }
  removeChild(c) {
    const i = this.children.indexOf(c)
    if (i >= 0) this.children.splice(i, 1)
    return c
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  dispatch(type, ev) { ev = ev || {}; ev.target = ev.target || this; (this.listeners[type] || []).forEach((fn) => fn(ev)) }
}

// ── 测试夹具 ──
const WS = 'C:/deepseek harness'
const SID = 'sess-now'
const XSS = '<img src=x onerror=alert(1)>'
const DEFAULT_STATE = {
  ok: true, mode: 'global',
  allowCwds: [], allowSessions: [], disabledCwds: [],
  currentCwd: WS, currentSessionId: SID,
}

/**
 * 在 vm 沙箱里跑 P0-6 源码。
 * @param {object} o { src, state, failState, promptValue }
 *   state: GET /api/tavern/state 的响应（也是 POST 合并的底稿）
 *   failState: true → GET 抛异常（网络断）
 *   promptValue: showPrompt 的 resolve 值（默认 null = 用户取消）
 */
async function runPanel(o = {}) {
  const src = o.src || extractSource(fs.readFileSync(BUNDLE, 'utf8'))
  const fetchLog = []
  const els = {
    '#tavern-scope2-status': new FakeEl('div'),
    '#tavern-scope-global': new FakeEl('button'),
    '#tavern-scope-session': new FakeEl('button'),
    '#tavern-scope-cwd': new FakeEl('button'),
    '#tavern-scope-allow-title': new FakeEl('div'),
    '#tavern-scope-allow-chips': new FakeEl('div'),
    '#tavern-scope-disable-title': new FakeEl('div'),
    '#tavern-scope-disable-chips': new FakeEl('div'),
  }
  const created = []
  const container = { querySelector: (sel) => els[sel] || null }
  // POST 模拟后端 /api/tavern/state（index.js:4998-5022 的字段合并语义）
  let cur = Object.assign({}, DEFAULT_STATE, o.state || {})
  const fetchImpl = async (url, opts) => {
    fetchLog.push({ url, opts })
    if (url !== '/api/tavern/state') return { json: async () => ({ ok: false, error: 'unexpected ' + url }) }
    if (o.failState && (!opts || !opts.method || opts.method !== 'POST')) throw new Error('network down')
    if (opts && opts.method === 'POST') {
      const b = JSON.parse(opts.body)
      if (b.mode === 'global' || b.mode === 'allowlist') cur.mode = b.mode
      if (b.allowCwds !== undefined) cur.allowCwds = (Array.isArray(b.allowCwds) ? b.allowCwds : []).map(s => String(s).trim()).filter(Boolean)
      if (b.allowSessions !== undefined) cur.allowSessions = (Array.isArray(b.allowSessions) ? b.allowSessions : []).map(s => String(s).trim()).filter(Boolean)
      if (b.disabledCwds !== undefined) cur.disabledCwds = (Array.isArray(b.disabledCwds) ? b.disabledCwds : []).map(s => String(s).trim()).filter(Boolean)
    }
    return { json: async () => Object.assign({ ok: true }, cur) }
  }
  const promptCalls = []
  const showPrompt = (title, def) => {
    promptCalls.push({ title, def })
    return Promise.resolve(o.promptValue != null ? o.promptValue : null)
  }
  const doc = { createElement: (tag) => { const el = new FakeEl(tag); created.push(el); return el } }
  const sandbox = {
    container,
    fetch: fetchImpl,
    showPrompt,
    document: doc,
    console,
    setTimeout, clearTimeout,
    Number, Object, String, JSON, Error, Promise, Array, RegExp,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { timeout: 5000 })
  await delay(40) // 等挂载时的初次 GET state → renderState 走完
  const allEls = Object.values(els).concat(created)
  return { els, fetchLog, promptCalls, allEls }
}

const posts = (fetchLog) => fetchLog.filter((f) => f.opts && f.opts.method === 'POST' && f.url === '/api/tavern/state')
  .map((f) => JSON.parse(f.opts.body))

// ════════════════════════════════════════════════════════════════
// 面板 HTML / 挂载
// ════════════════════════════════════════════════════════════════
test('面板 HTML：生效范围卡的关键元素齐全（三按钮 + 状态行 + 两组 chips）', () => {
  const html = fs.readFileSync(BUNDLE, 'utf8')
  assert.match(html, /🎯 生效范围/)
  assert.match(html, /id="tavern-scope2-status"/)
  assert.match(html, /id="tavern-scope-global"[^>]*>🌍 所有会话生效</)
  assert.match(html, /id="tavern-scope-session"[^>]*>💬 仅当前会话</)
  assert.match(html, /id="tavern-scope-cwd"[^>]*>📁 当前工作区</)
  assert.match(html, /id="tavern-scope-allow-chips"/)
  assert.match(html, /id="tavern-scope-disable-chips"/)
})

test('挂载：三个按钮各挂且只挂一个 click handler，初次加载即渲染状态行', async () => {
  const { els, fetchLog } = await runPanel({})
  assert.equal((els['#tavern-scope-global'].listeners.click || []).length, 1)
  assert.equal((els['#tavern-scope-session'].listeners.click || []).length, 1)
  assert.equal((els['#tavern-scope-cwd'].listeners.click || []).length, 1)
  assert.ok(fetchLog.some((f) => f.url === '/api/tavern/state' && (!f.opts || !f.opts.method)), '初次加载应 GET state')
  assert.match(els['#tavern-scope2-status'].textContent, /🌍/)
})

// ════════════════════════════════════════════════════════════════
// 三个按钮 → 请求体
// ════════════════════════════════════════════════════════════════
test('「🌍 所有会话生效」：点击 → POST {mode:"global"}，不碰任何名单', async () => {
  const { els, fetchLog } = await runPanel({ state: { disabledCwds: ['C:/a'] } })
  els['#tavern-scope-global'].dispatch('click')
  await delay(40)
  const p = posts(fetchLog)
  assert.equal(p.length, 1)
  assert.deepEqual(p[0], { mode: 'global' })
})
test('对照臂：global 按钮被改成发 allowlist 后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "postScope({ mode: 'global' })", "postScope({ mode: 'allowlist' })")
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src })
    els['#tavern-scope-global'].dispatch('click')
    await delay(40)
    assert.deepEqual(posts(fetchLog), [{ mode: 'global' }])
  })
})

test('「💬 仅当前会话」：自动检测 currentSessionId，去重追加进 allowSessions', async () => {
  const { els, fetchLog } = await runPanel({ state: { mode: 'global', allowSessions: ['s1'] } })
  els['#tavern-scope-session'].dispatch('click')
  await delay(60) // handler 内先 GET 再 POST
  const p = posts(fetchLog)
  assert.equal(p.length, 1)
  assert.deepEqual(p[0], { mode: 'allowlist', allowSessions: ['s1', SID] })
})
test('「💬 仅当前会话」：会话已在名单里时去重（不重复追加）', async () => {
  const { els, fetchLog } = await runPanel({ state: { allowSessions: ['s1', SID] } })
  els['#tavern-scope-session'].dispatch('click')
  await delay(60)
  assert.deepEqual(posts(fetchLog)[0], { mode: 'allowlist', allowSessions: ['s1', SID] })
})
test('对照臂：去重追加被改坏（直接 push 不去重）后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'),
    'if (list.indexOf(value) < 0) list.push(value)',
    'list.push(value)')
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src, state: { allowSessions: [SID] } })
    els['#tavern-scope-session'].dispatch('click')
    await delay(60)
    assert.deepEqual(posts(fetchLog)[0], { mode: 'allowlist', allowSessions: [SID] })
  })
})

test('「💬 仅当前会话」：currentSessionId 缺失 → showPrompt 手输兜底，输入后照常 POST', async () => {
  const { els, fetchLog, promptCalls } = await runPanel({
    state: { currentSessionId: '' },
    promptValue: 'manual-sid',
  })
  els['#tavern-scope-session'].dispatch('click')
  await delay(60)
  assert.equal(promptCalls.length, 1, '自动检测失败必须弹手输框')
  const p = posts(fetchLog)
  assert.equal(p.length, 1)
  assert.deepEqual(p[0], { mode: 'allowlist', allowSessions: ['manual-sid'] })
})
test('「💬 仅当前会话」：手输框被取消（null/空白）时不发任何请求', async () => {
  const { els, fetchLog, promptCalls } = await runPanel({ state: { currentSessionId: '' } })
  els['#tavern-scope-session'].dispatch('click')
  await delay(60)
  assert.equal(promptCalls.length, 1)
  assert.equal(posts(fetchLog).length, 0)
})
test('「💬 仅当前会话」：GET state 抛异常（网络断）也走 showPrompt 兜底，不白屏', async () => {
  const { els, fetchLog, promptCalls } = await runPanel({ failState: true, promptValue: 'retry-sid' })
  els['#tavern-scope-session'].dispatch('click')
  await delay(60)
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(posts(fetchLog)[0], { mode: 'allowlist', allowSessions: ['retry-sid'] })
})

test('「📁 当前工作区」：自动检测 currentCwd，去重追加进 allowCwds（绝不一上来就让人填路径）', async () => {
  const { els, fetchLog, promptCalls } = await runPanel({ state: { mode: 'global', allowCwds: ['C:/old'] } })
  els['#tavern-scope-cwd'].dispatch('click')
  await delay(60)
  assert.equal(promptCalls.length, 0, '自动检测成功时不得弹手输框')
  assert.deepEqual(posts(fetchLog)[0], { mode: 'allowlist', allowCwds: ['C:/old', WS] })
})
test('「📁 当前工作区」：currentCwd 缺失 → showPrompt 手输兜底', async () => {
  const { els, fetchLog, promptCalls } = await runPanel({ state: { currentCwd: '' }, promptValue: 'D:/manual/ws' })
  els['#tavern-scope-cwd'].dispatch('click')
  await delay(60)
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(posts(fetchLog)[0], { mode: 'allowlist', allowCwds: ['D:/manual/ws'] })
})

// ════════════════════════════════════════════════════════════════
// chips：× 移除 → POST 剩余数组（allowCwds / allowSessions / disabledCwds 同一套逻辑）
// ════════════════════════════════════════════════════════════════
/** 取第 idx 个 chip 的 × 按钮（chip = [label, ×]） */
function chipX(box, idx) {
  const chip = box.children[idx]
  return chip.children[chip.children.length - 1]
}

test('chips：allowlist 模式下「已放行」显示 allowCwds+allowSessions，点 × POST 剩余数组', async () => {
  const { els, fetchLog } = await runPanel({
    state: { mode: 'allowlist', allowCwds: ['C:/a', 'C:/b'], allowSessions: ['s1'] },
  })
  const box = els['#tavern-scope-allow-chips']
  assert.equal(box.children.length, 3, '2 个工作区 + 1 个会话 = 3 个 chip')
  chipX(box, 0).dispatch('click') // 移除 C:/a
  await delay(40)
  assert.deepEqual(posts(fetchLog)[0], { allowCwds: ['C:/b'] })
  assert.equal(box.children.length, 2, 'POST 响应刷新后重渲染为 2 个 chip')
  chipX(box, 1).dispatch('click') // 移除会话 s1（重渲染后 idx=1）
  await delay(40)
  assert.deepEqual(posts(fetchLog)[1], { allowSessions: [] })
})
test('chips：global 模式下「已排除」显示 disabledCwds，点 × POST 剩余数组', async () => {
  const { els, fetchLog } = await runPanel({
    state: { mode: 'global', disabledCwds: ['C:/x', 'C:/y'] },
  })
  const box = els['#tavern-scope-disable-chips']
  assert.equal(box.children.length, 2)
  chipX(box, 1).dispatch('click') // 移除 C:/y
  await delay(40)
  assert.deepEqual(posts(fetchLog)[0], { disabledCwds: ['C:/x'] })
})
test('对照臂：chips × 被改坏（把剩余数组发成空数组）后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'),
    'postScope({ allowCwds: allowCwds.filter(function (_, j) { return j !== i }) })',
    'postScope({ allowCwds: [] })')
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src, state: { mode: 'allowlist', allowCwds: ['C:/a', 'C:/b'] } })
    chipX(els['#tavern-scope-allow-chips'], 0).dispatch('click')
    await delay(40)
    assert.deepEqual(posts(fetchLog)[0], { allowCwds: ['C:/b'] })
  })
})

// ════════════════════════════════════════════════════════════════
// 状态行三形态
// ════════════════════════════════════════════════════════════════
test('状态行：global → 🌍（含排除数）；allowlist 非空 → 📁 M 个会话 / K 个工作区', async () => {
  const a = await runPanel({ state: { mode: 'global', disabledCwds: ['C:/1', 'C:/2'] } })
  assert.match(a.els['#tavern-scope2-status'].textContent, /🌍 所有会话生效中（已排除 2 个目录）/)
  const b = await runPanel({ state: { mode: 'allowlist', allowCwds: ['C:/a'], allowSessions: ['s1', 's2'] } })
  assert.match(b.els['#tavern-scope2-status'].textContent, /📁 白名单模式：2 个会话 \/ 1 个工作区/)
})
test('状态行：allowlist 两名单皆空 → 红色警示 + 一键开启指引', async () => {
  const { els } = await runPanel({ state: { mode: 'allowlist', allowCwds: [], allowSessions: [] } })
  const st = els['#tavern-scope2-status']
  assert.match(st.textContent, /⚠️ 还没有任何会话能用到酒馆/)
  assert.match(st.textContent, /点上面任一按钮开启/)
  assert.equal(st.style.color, '#e74c3c', '空白名单必须是红色警示')
})
test('对照臂：空白名单警示文案被删掉后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'),
    "'⚠️ 还没有任何会话能用到酒馆 —— 点上面任一按钮开启'", "''")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, state: { mode: 'allowlist' } })
    assert.match(els['#tavern-scope2-status'].textContent, /⚠️ 还没有任何会话能用到酒馆/)
  })
})

// ════════════════════════════════════════════════════════════════
// 安全纪律：外部字符串（路径/会话 id）只进 textContent，绝不 innerHTML 拼接
// ════════════════════════════════════════════════════════════════
test('XSS：工作区路径含 <img onerror> 时只进 textContent，全程零 innerHTML 写入', async () => {
  const { els, allEls } = await runPanel({
    state: { mode: 'allowlist', allowCwds: [XSS], allowSessions: [XSS] },
  })
  const box = els['#tavern-scope-allow-chips']
  const labels = box.children.map((c) => c.children[0].textContent)
  assert.ok(labels.some((t) => t.indexOf(XSS) >= 0), '原文必须以纯文本形态出现（textContent）')
  const writes = allEls.reduce((n, e) => n + (e._innerHTMLWrites || 0), 0)
  assert.equal(writes, 0, '生效范围面板任何元素都不得写 innerHTML（否则就造出真实元素了）')
})
test('对照臂：chips 改用 innerHTML 拼接后，零写入断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'),
    'label.textContent = String(it.text)', 'chip.innerHTML = String(it.text)')
  await assert.rejects(async () => {
    const { allEls } = await runPanel({ src, state: { mode: 'allowlist', allowCwds: [XSS] } })
    const writes = allEls.reduce((n, e) => n + (e._innerHTMLWrites || 0), 0)
    assert.equal(writes, 0, 'innerHTML 拼接必须被抓到')
  })
})

// ════════════════════════════════════════════════════════════════
// 后端：readState 出厂默认 global（DSH_HOME 隔离，动态 import）
// ════════════════════════════════════════════════════════════════
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-'))
process.env.DSH_HOME = TMP_HOME
const REPO = path.resolve(__dirname, '..')
const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { readState, writeState } = _test

test('后端：无 state 文件（新用户）时 readState().mode === "global"（出厂默认）', () => {
  assert.equal(fs.existsSync(path.join(TMP_HOME, '.agent-presets', 'tavern-state.json')), false, '前置：确实没有 state 文件')
  assert.equal(readState().mode, 'global')
})
test('后端：显式写入 mode:"allowlist" 的存量用户不受出厂默认影响', () => {
  writeState({ mode: 'allowlist', allowCwds: ['C:/kept'], allowSessions: [] })
  const s = readState()
  assert.equal(s.mode, 'allowlist', '显式配置必须原样保留')
  assert.deepEqual(s.allowCwds, ['C:/kept'])
  // 非法值回落到新出厂默认 global
  writeState({ mode: 'bogus' })
  assert.equal(readState().mode, 'global')
})

// ── ASI 雷区守卫 ─────────────────────────────────────────────
// 事故（2026-09-25）：initScopePanel 的 IIFE 以 `})()` 结尾，中间只隔注释就是
// `(function initVarPanel(){` —— 无分号时 ASI 把两者拼成「调用上一表达式返回值」，
// 整个 bundle 求值即炸，酒馆管理面板整页白屏（node --check 抓不到，因为语法合法）。
test('ASI 守卫：bundle 内所有行首 IIFE 的上一条语句不得以无分号的 })() 结尾', () => {
  const src = fs.readFileSync(new URL('../lib/client.manager.bundle.js', import.meta.url), 'utf8')
  const lines = src.split(/\r?\n/)
  const hazards = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\(function\b/.test(lines[i])) continue
    let j = i - 1
    while (j >= 0) {
      const t = lines[j].trim()
      if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { j--; continue }
      break
    }
    if (j < 0) continue
    const prev = lines[j].trim()
    if (/\}\)\(\)\s*$/.test(prev) && !/;\s*$/.test(prev)) {
      hazards.push('行' + (i + 1) + ' ← 上一语句(行' + (j + 1) + ')以 })() 结尾且无分号')
    }
  }
  assert.deepEqual(hazards, [], '★ 发现 ASI 雷区（会白屏）：\n' + hazards.join('\n'))
})
