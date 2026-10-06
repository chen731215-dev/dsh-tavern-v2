/**
 * P0-3：面板解绑 UI + 预设真名 —— 客户端行为测试
 *
 * 被测对象是 client.manager.bundle.js 里 mountTavernManager() 内的两个新东西：
 *   · presetIdentityClue / presetIdentityText（P0-3b 预设真名）
 *   · (function initBindingPanel(){…})()   （P0-3a 当前会话绑定区块）
 * 客户端代码没有 DOM，沿用 tests/var-panel.test.js 的套路：vm 沙箱 + FakeEl，
 * fetch / getCurrentSessionId / esc / container 由沙箱注入。
 *
 * 判据纪律（本项目铁律）：每个用例都配一支「对照臂」—— 对被测源码做一处变异，
 * 同样的断言必须失败。对照臂红 = 判据真的在测东西。
 *
 * 三个必须分得开的 UI 概念（本套件重点守 ② 与 ③ 不许被合并）：
 *   ① 当前会话绑定（会话权威，只读展示）
 *   ② 应用到当前会话（真写 binding）
 *   ③ 换绑并仅对新会话生效（只改 UI 草稿，一个请求都不发）
 *
 * 运行：node --test tests/binding-panel-ui.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(__dirname, '..', 'lib', 'client.manager.bundle.js')

// ── 抽出被测源码段：P0-3b 真名 helper + P0-3a IIFE（锚点：起始注释 → 结束注释）──
function extractSource(bundleText) {
  const start = bundleText.indexOf('// ── P0-3b：预设真名')
  const end = bundleText.indexOf('// ── P0-3 结束 ──')
  if (start < 0 || end < 0 || end <= start) throw new Error('bundle 里找不到 P0-3 源码段')
  return bundleText.slice(start, end)
}

/**
 * 对照臂专用：对被测源码做**一处**变异。
 * ⚠ 锚点必须真的命中 —— 命中不到就抛错，避免「变异了个寂寞」导致对照臂假绿。
 */
function mutate(bundleText, from, to) {
  const src = extractSource(bundleText)
  if (src.indexOf(from) < 0) throw new Error('变异锚点未命中（判据失效，测试写错了）：' + from)
  return src.replace(from, to)
}

/**
 * 按签名从 bundle 里抠出**整段函数源码**（花括号配对；内层 `}` 不会被截断）。
 * @param {string} bundleText
 * @param {string} signature 以 `function xxx(` 开头的原文
 */
function extractFnSource(bundleText, signature) {
  const start = bundleText.indexOf(signature)
  if (start < 0) throw new Error('bundle 里找不到：' + signature)
  let depth = 0
  let seen = false
  for (let i = start; i < bundleText.length; i++) {
    const ch = bundleText[i]
    if (ch === '{') { depth++; seen = true; continue }
    if (ch === '}') { depth--; if (seen && depth === 0) return bundleText.slice(start, i + 1) }
  }
  throw new Error('花括号没配平：' + signature)
}

/** 从 bundle 里抠出顶层的 `matchPresetInList` 真实现，用于注入 VM 沙箱。 */
function loadMatchPresetFromBundle(bundleText) {
  return new Function('return (' + extractFnSource(bundleText, 'function matchPresetInList(') + ');')()
}

// ── 极简假元素 ──
class FakeEl {
  constructor(attrs = {}) {
    this.attrs = Object.assign({}, attrs)
    this.listeners = {}
    this.innerHTML = ''
    this.textContent = ''
    this.style = {}
    this.dataset = {}
    this.value = attrs.value != null ? attrs.value : ''
    this.checked = false
  }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  // 显隐/配色改走类名后，stub 必须支持 classList（与真 DOM 同形）
  get classList() {
    const self = this
    const list = () => String(self.attrs.class || '').split(/\s+/).filter(Boolean)
    const set = (arr) => { self.attrs.class = arr.join(' ') }
    return {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) set(list().concat(c)) },
      remove: (c) => set(list().filter((x) => x !== c)),
      toggle: (c, on) => {
        const has = list().includes(c)
        const want = on === undefined ? !has : !!on
        if (want && !has) set(list().concat(c))
        if (!want && has) set(list().filter((x) => x !== c))
      },
    }
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  dispatch(type, ev) { ev = ev || {}; ev.target = ev.target || this; (this.listeners[type] || []).forEach((fn) => fn(ev)) }
  appendChild() {}
  querySelector() { return null }
  querySelectorAll() { return [] }
}

// ── 测试夹具 ──
// 真实事故现场：name「示例预设」的预设，description 里写的却是 `_示例卡2`
const PRESET_FOOT = {
  id: 'preset-fixture-a3',
  name: '示例预设',
  description: '🎭 _示例卡2 | 📚 2本世界书（142条）| ⚙️ 1个预设模块 | 最后更新: 2026/9/25 08:31:53',
}
// description 是**不可信外部文本**：这里塞一段 XSS，断言它只能以文本形态出现
const XSS = '<img src=x onerror=alert(1)>'
const PRESET_XSS = { id: 'preset-xss-1', name: '恶意预设', description: '🎭 ' + XSS }
const PRESET_PLAIN = { id: 'preset-plain-1', name: '川上富江', description: '' }

const SESSION = 'session-abc123'

/**
 * 在 vm 沙箱里跑被测源码。
 * @param {object} o  { src, boundId, bindingMode, bindingSource, presets, session,
 *                      failSessions, failPresets, fetchLog }
 */
async function runPanel(o = {}) {
  const bundleText = o.bundleText || fs.readFileSync(BUNDLE, 'utf8')
  const src = o.src || extractSource(bundleText)
  const fetchLog = o.fetchLog || []
  const els = {
    '#tavern-binding-current': new FakeEl({ value: '' }),
    '#tavern-binding-source': new FakeEl(),
    '#tavern-binding-legacy': new FakeEl({ class: 'tv-alert tv-hidden' }),
    '#tavern-binding-unbind': new FakeEl(),
    '#tavern-binding-apply-current': new FakeEl(),
    '#tavern-binding-new-session': new FakeEl(),
    '#tavern-binding-next-select': new FakeEl({ value: '' }),
    '#tavern-binding-status': new FakeEl(),
    // 预设声明开关（用户自己要按的那三个按钮）：给上真元素，才能行为级地测到它们
    '#tavern-declare-status': new FakeEl(),
    '#tavern-declare-hint': new FakeEl(),
    '#tavern-declare-apply': new FakeEl(),
    '#tavern-declare-bundle': new FakeEl(),
    '#tavern-declare-off': new FakeEl(),
  }
  // （初值由 markup 的 tv-hidden 类提供，不再用 style.display）
  const container = { querySelector: (sel) => els[sel] || null }
  const presets = o.presets || [PRESET_FOOT, PRESET_XSS, PRESET_PLAIN]
  const session = o.session === undefined ? SESSION : o.session
  const sessionsPayload = {
    ok: true,
    sessions: [{ id: session || 'x', boundPreset: o.boundId || 'default', bindingMode: o.bindingMode || '', bindingSource: o.bindingSource || '' }],
  }
  const fetchImpl = async (url, opts) => {
    fetchLog.push({ url, opts })
    if (url.indexOf('/api/tavern/sessions') >= 0) {
      if (o.failSessions) throw new Error('network down')
      return { json: async () => sessionsPayload }
    }
    if (url.indexOf('/api/tavern/presets') >= 0) {
      if (o.failPresets) throw new Error('network down')
      return { json: async () => ({ ok: true, presets }) }
    }
    if (url.indexOf('/api/tavern/unbind-preset') >= 0) {
      if (o.throwUnbind) throw new Error('network down')
      return { json: async () => o.unbindResponse || { ok: true } }
    }
    if (url.indexOf('/api/tavern/bind-preset') >= 0) {
      if (o.throwBind) throw new Error('network down')
      return { json: async () => o.bindResponse || { ok: true } }
    }
    // ── 预设声明（dry-run 预览 / 写盘 / 生成 bundle）──
    if (url.indexOf('/api/tavern/preset-declarations') >= 0) {
      const isWriteReq = opts && opts.method === 'POST'
      const base = o.declareResponse || {
        ok: true, mode: 'off', target: 'C:\\fake\\profiles\\p\\cordis.patch.yml',
        bytesBefore: 100, bytesAfter: 900, okCount: 2, failed: [], replaced: false,
        roster: ['standard', 'tavern-lite'], missingFromRoster: ['tavern-lite'],
      }
      // 写盘响应另给一份：真实服务端这时候会回 wrote + backupPath
      if (isWriteReq && !o.declareResponse) {
        return { json: async () => Object.assign({}, base, { wrote: true, dryRun: false, backupPath: 'C:\\fake\\tavern-data\\backups\\cordis.patch.yml.2026.bak' }) }
      }
      return { json: async () => base }
    }
    if (url.indexOf('/api/tavern/preset-bundle') >= 0) {
      return {
        json: async () => o.bundleResponse || {
          ok: true, wrote: true, bundleDir: 'C:\\fake\\tavern-data\\preset-bundle',
          installHint: "plugin_manager { action: 'install_bundle', target: 'C:\\fake\\tavern-data\\preset-bundle' }",
        },
      }
    }
    return { json: async () => ({ ok: false, error: 'unexpected ' + url }) }
  }
  // P0-3c：会话权威缓存的写入口。真实 bundle 里它在工厂作用域（getActivePresetId 旁边），
  // 沙箱里注入一个间谍 —— 顺便断言「解绑/绑定」有没有真的刷新会话权威值。
  const boundCalls = []
  const confirmCalls = []
  const sandbox = {
    container,
    fetch: fetchImpl,
    // 声明开关会弹 window.confirm：默认「点确定」，用 o.confirm=false 模拟用户取消
    window: { confirm: (msg) => { confirmCalls.push(String(msg || '')); return o.confirm !== false } },
    getCurrentSessionId: () => session,
    // ★ matchPresetInList 声明在**面板工厂顶层**（loadSessionPresets 那一层），
    //   已不在被抽取的 P0-3 源码段里 —— 按源码段跑的沙箱必须自己补上。
    //   这里抠 bundle 里的**真实现**注入，不另写一份（避免逻辑分叉）。
    matchPresetInList: loadMatchPresetFromBundle(bundleText),
    setSessionBoundPresetId: (id) => { boundCalls.push(String(id == null ? '' : id)) },
    getSessionBoundPresetId: () => (boundCalls.length ? boundCalls[boundCalls.length - 1] : ''),
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: { addEventListener: () => {} },
    console,
    setTimeout, clearTimeout, Number, Object, String, JSON, Error, Promise, Array, RegExp,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { timeout: 5000 })
  await delay(60) // 等挂载时的 loadPresets → loadBinding 链走完
  return { els, fetchLog, sandbox, boundCalls, confirmCalls }
}

const isWrite = (f) => f.opts && f.opts.method === 'POST' &&
  (f.url.indexOf('/api/tavern/bind-preset') >= 0 || f.url.indexOf('/api/tavern/unbind-preset') >= 0)

// ════════════════════════════════════════════════════════════════
// ① 解绑本会话
// ════════════════════════════════════════════════════════════════
test('解绑：「解绑本会话」按钮存在且挂了 click handler，点击后发出 POST /api/tavern/unbind-preset，请求体是当前会话', async () => {
  const { els, fetchLog } = await runPanel({ boundId: PRESET_FOOT.id, bindingMode: 'preset', bindingSource: 'panel' })
  const btn = els['#tavern-binding-unbind']
  assert.equal((btn.listeners.click || []).length, 1, '解绑按钮必须且只能挂一个 click handler')
  btn.dispatch('click')
  await delay(60)
  const req = fetchLog.find((f) => f.url === '/api/tavern/unbind-preset')
  assert.ok(req, '应发出 POST /api/tavern/unbind-preset')
  assert.equal(req.opts.method, 'POST')
  assert.deepEqual(JSON.parse(req.opts.body), { sessionId: SESSION })
})
test('对照臂：把解绑请求的目标接口改掉后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "'/api/tavern/unbind-preset'", "'/api/tavern/nope'")
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src, boundId: PRESET_FOOT.id })
    els['#tavern-binding-unbind'].dispatch('click')
    await delay(60)
    assert.ok(fetchLog.find((f) => f.url === '/api/tavern/unbind-preset'), '接口被改掉后不该再有 unbind 请求')
  })
})

test('解绑：成功后立刻刷新为「未绑定」，并给出成功反馈', async () => {
  const { els, boundCalls } = await runPanel({ boundId: PRESET_FOOT.id, bindingMode: 'preset', bindingSource: 'panel' })
  assert.match(els['#tavern-binding-current'].textContent, /示例预设/, '解绑前应显示已绑定的预设真名')
  // P0-3c：挂载时应已把会话权威值灌进缓存（且不带后端展平值 default）
  assert.equal(boundCalls[boundCalls.length - 1], PRESET_FOOT.id)
  els['#tavern-binding-unbind'].dispatch('click')
  await delay(60)
  assert.match(els['#tavern-binding-current'].textContent, /未绑定/, '解绑成功后必须刷新为未绑定')
  assert.equal(/示例预设/.test(els['#tavern-binding-current'].textContent), false)
  assert.match(els['#tavern-binding-status'].textContent, /✅|已解绑/)
  assert.equal(boundCalls[boundCalls.length - 1], '', '解绑后会话权威缓存必须清空')
})
test('对照臂：删掉解绑成功后的本地刷新后，「显示未绑定」的断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), 
    "bound.presetId = ''; bound.mode = 'none'; bound.source = ''; bound.known = true;", "/* mutated */")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, boundId: PRESET_FOOT.id })
    els['#tavern-binding-unbind'].dispatch('click')
    await delay(60)
    assert.match(els['#tavern-binding-current'].textContent, /未绑定/)
  })
})

test('解绑：服务端返回 ok:false 时给出失败反馈，且不许把 UI 假装成已解绑', async () => {
  const { els } = await runPanel({
    boundId: PRESET_FOOT.id,
    unbindResponse: { ok: false, error: '会话不存在' },
  })
  els['#tavern-binding-unbind'].dispatch('click')
  await delay(60)
  assert.match(els['#tavern-binding-status'].textContent, /❌|失败/, '必须有可见的失败反馈')
  assert.match(els['#tavern-binding-status'].textContent, /会话不存在/, '要带出服务端给的原因')
  assert.match(els['#tavern-binding-current'].textContent, /示例预设/, '失败时不得把显示改成未绑定')
})
test('解绑：请求直接抛异常（网络断）时也要有失败反馈，不白屏', async () => {
  const { els } = await runPanel({ boundId: PRESET_FOOT.id, throwUnbind: true })
  els['#tavern-binding-unbind'].dispatch('click')
  await delay(60)
  assert.match(els['#tavern-binding-status'].textContent, /❌|失败/)
  assert.match(els['#tavern-binding-current'].textContent, /示例预设/)
})
test('对照臂：删掉解绑失败的反馈后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), 
    "setStatus('❌ 解绑失败：' + ((e && e.message) || e) + '（可重试）', 'err');", "/* mutated */")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, boundId: PRESET_FOOT.id, unbindResponse: { ok: false, error: 'x' } })
    els['#tavern-binding-unbind'].dispatch('click')
    await delay(60)
    assert.match(els['#tavern-binding-status'].textContent, /❌|失败/)
  })
})

// ════════════════════════════════════════════════════════════════
// ③ 换绑并仅对新会话生效 —— 绝不写当前会话
// ════════════════════════════════════════════════════════════════
test('仅对新会话生效：点击后不发任何写请求（bind/unbind 都不许出现），并提示新会话才生效', async () => {
  const { els, fetchLog } = await runPanel({ boundId: PRESET_FOOT.id, bindingMode: 'preset' })
  els['#tavern-binding-next-select'].value = PRESET_PLAIN.id
  els['#tavern-binding-new-session'].dispatch('click')
  await delay(60)
  const writes = fetchLog.filter(isWrite)
  assert.equal(writes.length, 0, '「仅对新会话生效」绝不写当前会话，不应发出任何 bind/unbind 请求')
  assert.match(els['#tavern-binding-status'].textContent, /新会话/, '必须明确提示「新会话才生效」')
})
test('对照臂：让「仅对新会话生效」偷偷也写 binding 后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "draftNextId = pid;", "fetch('/api/tavern/bind-preset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: curSid(), presetId: pid }) }); draftNextId = pid;")
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src, boundId: PRESET_FOOT.id })
    els['#tavern-binding-next-select'].value = PRESET_PLAIN.id
    els['#tavern-binding-new-session'].dispatch('click')
    await delay(60)
    assert.equal(fetchLog.filter(isWrite).length, 0, '偷偷写 binding 后必须被抓到')
  })
})

test('应用到当前会话：真的写 binding（POST bind-preset，带 sessionId + presetId）', async () => {
  const { els, fetchLog, boundCalls } = await runPanel({ boundId: PRESET_FOOT.id })
  els['#tavern-binding-next-select'].value = PRESET_PLAIN.id
  els['#tavern-binding-apply-current'].dispatch('click')
  await delay(60)
  const req = fetchLog.find((f) => f.url === '/api/tavern/bind-preset' && f.opts && f.opts.method === 'POST')
  assert.ok(req, '应发出 POST /api/tavern/bind-preset')
  assert.deepEqual(JSON.parse(req.opts.body), { sessionId: SESSION, presetId: PRESET_PLAIN.id })
  assert.match(els['#tavern-binding-status'].textContent, /✅|已应用/)
  assert.equal(boundCalls[boundCalls.length - 1], PRESET_PLAIN.id, '绑定后会话权威缓存要更新')
})
test('对照臂：把「应用到当前会话」的 presetId 换成写死后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "body: JSON.stringify({ sessionId: s, presetId: pid })", "body: JSON.stringify({ sessionId: s, presetId: 'none' })")
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src, boundId: PRESET_FOOT.id })
    els['#tavern-binding-next-select'].value = PRESET_PLAIN.id
    els['#tavern-binding-apply-current'].dispatch('click')
    await delay(60)
    const req = fetchLog.find((f) => f.url === '/api/tavern/bind-preset' && f.opts && f.opts.method === 'POST')
    assert.deepEqual(JSON.parse(req.opts.body), { sessionId: SESSION, presetId: PRESET_PLAIN.id })
  })
})

// ════════════════════════════════════════════════════════════════
// P0-3b 预设真名
// ════════════════════════════════════════════════════════════════
test('真名：绑定显示同时给出面板名 name 与真实内容线索 description', async () => {
  const { els } = await runPanel({ boundId: PRESET_FOOT.id, bindingMode: 'preset', bindingSource: 'panel' })
  const txt = els['#tavern-binding-current'].textContent
  assert.match(txt, /示例预设/, 'name（面板显示名）必须出现')
  assert.match(txt, /_示例卡2/, 'description 里的真实身份线索必须出现 —— 否则用户还是看不出绑了什么')
  assert.match(txt, /142条/, 'description 的实质内容应保留')
})
test('对照臂：真名只显示 name（退化到改动前）时，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), 
    "return clue ? name + '  ⚠️ ' + clue : name;", "return name;")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, boundId: PRESET_FOOT.id })
    assert.match(els['#tavern-binding-current'].textContent, /_示例卡2/)
  })
})

test('真名：description 含 HTML 特殊字符时被转义、未产生真实元素', async () => {
  const { els } = await runPanel({ boundId: PRESET_XSS.id, bindingMode: 'preset' })
  // ① 主显示走 textContent —— DOM 只会当文本渲染，绝不产生 <img> 元素
  assert.match(els['#tavern-binding-current'].textContent, /<img src=x onerror=alert\(1\)>/, '原文作为文本出现')
  assert.equal(els['#tavern-binding-current'].innerHTML, '', '主显示不得拼 innerHTML（否则就造出真实元素了）')
  // ② 下拉走 esc() —— 断言 HTML 里是转义后的字面量，没有裸 <img
  const selHtml = els['#tavern-binding-next-select'].innerHTML
  assert.match(selHtml, /恶意预设/, 'name 应出现在下拉里')
  assert.match(selHtml, /&lt;img src=x onerror=alert\(1\)&gt;/, 'description 必须被转义')
  assert.equal(/<img/.test(selHtml), false, '转义后不得出现真实 <img 标签')
})
test('对照臂：去掉下拉的 esc() 后，转义断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "+ esc(presetIdentityText(p)) +", "+ presetIdentityText(p) +")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, boundId: PRESET_XSS.id })
    const selHtml = els['#tavern-binding-next-select'].innerHTML
    assert.equal(/<img/.test(selHtml), false, '去掉 esc 后必然拼出真实 <img 标签')
  })
})

// ════════════════════════════════════════════════════════════════
// legacy 三态
// ════════════════════════════════════════════════════════════════
test('legacy：bindingMode=legacy 时红色提示出现，要求用户确认或解绑', async () => {
  const { els } = await runPanel({ boundId: PRESET_FOOT.id, bindingMode: 'legacy', bindingSource: 'legacy' })
  const legacy = els['#tavern-binding-legacy']
  // 显隐与配色都改走类名（.tv-alert 提供红色、.tv-hidden 提供隐藏），
  // 不再内联 style.display / style.color —— 所以断言也改为查类。
  assert.equal(legacy.classList.contains('tv-hidden'), false, '遗留绑定必须显示红条')
  assert.match(legacy.textContent, /遗留绑定/, '文案要说明这是遗留绑定')
  assert.match(legacy.textContent, /确认|解绑/)
  assert.ok(legacy.classList.contains('tv-alert'), '红色警示由 .tv-alert 提供，不再内联写死 #e74c3c')
  assert.match(els['#tavern-binding-source'].textContent, /遗留\(待确认\)/)
})
test('对照臂：把 legacy 分支条件改恒假后，红条断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), "if (bound.mode === 'legacy') {", "if (false) {")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, boundId: PRESET_FOOT.id, bindingMode: 'legacy' })
    assert.equal(els['#tavern-binding-legacy'].classList.contains('tv-hidden'), false)
  })
})

test('未绑定：boundPreset=default（后端展平值）显示未绑定，不显示遗留红条', async () => {
  const { els } = await runPanel({ boundId: 'default' })
  assert.match(els['#tavern-binding-current'].textContent, /未绑定/)
  assert.equal(els['#tavern-binding-legacy'].classList.contains('tv-hidden'), true, '未绑定时不该显示遗留红条')
})

// ════════════════════════════════════════════════════════════════
// 失败反馈 / 不白屏
// ════════════════════════════════════════════════════════════════
test('失败：读取会话列表抛异常时有失败反馈，且显示「读取失败」而不是编造成未绑定', async () => {
  const { els } = await runPanel({ failSessions: true })
  assert.match(els['#tavern-binding-status'].textContent, /❌|失败/, '必须有可见的失败反馈')
  assert.match(els['#tavern-binding-current'].textContent, /读取失败/, '不许把失败显示成「未绑定」')
  assert.notEqual(els['#tavern-binding-current'].textContent, '', '面板不得白屏')
})
test('对照臂：删掉读取失败的状态反馈后，同一断言必须失败', async () => {
  const src = mutate(fs.readFileSync(BUNDLE, 'utf8'), 
    "setStatus('❌ 读取绑定失败：' + ((e && e.message) || e) + '（面板其余功能不受影响，可重试）', 'err');", "")
  await assert.rejects(async () => {
    const { els } = await runPanel({ src, failSessions: true })
    assert.match(els['#tavern-binding-status'].textContent, /❌|失败/)
  })
})

test('应用到当前会话：服务端拒绝时有失败反馈，不静默', async () => {
  const { els } = await runPanel({ boundId: PRESET_FOOT.id, bindResponse: { ok: false, error: '预设不存在' } })
  els['#tavern-binding-next-select'].value = PRESET_PLAIN.id
  els['#tavern-binding-apply-current'].dispatch('click')
  await delay(60)
  assert.match(els['#tavern-binding-status'].textContent, /❌|失败/)
  assert.match(els['#tavern-binding-status'].textContent, /预设不存在/)
})

test('无会话：未检测到会话时提示用户先发消息，而不是静默空白', async () => {
  const { els } = await runPanel({ session: '' })
  assert.match(els['#tavern-binding-current'].textContent, /未检测到会话/)
  assert.match(els['#tavern-binding-status'].textContent, /未检测到当前会话/)
  els['#tavern-binding-unbind'].dispatch('click')
  await delay(30)
  assert.match(els['#tavern-binding-status'].textContent, /❌/, '无会话时点解绑也要有失败反馈，不能静默')
})

// ════════════════════════════════════════════════════════════════
// 预设声明开关（📢 声明为 DSH 预设 / 📦 只生成 bundle / 🧹 撤下声明）
//   这一步只有用户能按，所以按下去会发生什么，必须行为级钉住。
// ════════════════════════════════════════════════════════════════
const isDeclarePost = (f) => f.opts && f.opts.method === 'POST' && f.url.indexOf('/api/tavern/preset-declarations') >= 0

test('📢 声明为 DSH 预设：先 dry-run 预览 → 弹确认（文案含目标文件与字节数）→ 才真写', async () => {
  const { els, fetchLog, confirmCalls } = await runPanel({})
  const btn = els['#tavern-declare-apply']
  assert.equal((btn.listeners.click || []).length, 1, '声明按钮必须且只能挂一个 click handler')
  const mark = fetchLog.length            // 只看点击之后产生的请求（挂载时也会 GET 一次状态）
  btn.dispatch('click')
  await delay(80)
  const since = fetchLog.slice(mark)

  // ① 预览是 GET（dry-run），且发生在确认之后、写入之前
  const preview = since.find((f) => f.url.indexOf('/api/tavern/preset-declarations') >= 0 && !isDeclarePost(f))
  assert.ok(preview, '点下去必须先 GET 一次拿 dry-run 预览')
  assert.ok(!preview.opts || !preview.opts.method || preview.opts.method === 'GET', '预览必须是 GET')

  // ② 确认框要把代价讲清楚
  assert.equal(confirmCalls.length, 1, '必须弹一次确认')
  assert.match(confirmCalls[0], /cordis\.patch\.yml/, '确认文案要写清目标文件')
  assert.match(confirmCalls[0], /100/, '要说清写入前的字节数')
  assert.match(confirmCalls[0], /900/, '要说清写入后的字节数')
  assert.match(confirmCalls[0], /备份/, '要说明会自动备份')

  // ③ 确认之后才 POST，且带上 apply+confirm
  const post = since.find(isDeclarePost)
  assert.ok(post, '确认后应 POST /api/tavern/preset-declarations')
  assert.deepEqual(JSON.parse(post.opts.body), { apply: true, confirm: true })
  assert.ok(since.indexOf(preview) < since.indexOf(post), '顺序：预览 → 确认 → 写入')

  // ④ ★ 结果提示必须留在 hint 行（含备份路径）——不能被紧接着的状态刷新覆盖
  assert.match(els['#tavern-declare-hint'].textContent, /已写入/, '写完要给结果提示')
  assert.match(els['#tavern-declare-hint'].textContent, /备份/, '要把备份路径留在界面上（回滚要用）')
  assert.match(els['#tavern-declare-status'].textContent, /名册/, '名册信息走状态行')
})

test('📢 用户在确认框里取消 ⇒ 一个字节都不写（绝不许先写后问）', async () => {
  const { els, fetchLog, confirmCalls } = await runPanel({ confirm: false })
  fetchLog.length = 0
  els['#tavern-declare-apply'].dispatch('click')
  await delay(80)
  assert.equal(confirmCalls.length, 1, '仍然要弹确认')
  assert.equal(fetchLog.filter(isDeclarePost).length, 0, '★ 取消后不许发生任何写请求')
  assert.match(els['#tavern-declare-hint'].textContent, /取消|没写/, '要如实告诉用户没写')
})

test('🧹 撤下声明：必须确认，且带 remove+confirm 才发请求', async () => {
  const { els, fetchLog, confirmCalls } = await runPanel({})
  fetchLog.length = 0
  els['#tavern-declare-off'].dispatch('click')
  await delay(80)
  assert.equal(confirmCalls.length, 1, '撤下前必须确认')
  const post = fetchLog.find(isDeclarePost)
  assert.ok(post, '确认后应 POST')
  assert.deepEqual(JSON.parse(post.opts.body), { remove: true, confirm: true })

  // 取消 ⇒ 不发
  const second = await runPanel({ confirm: false })
  second.fetchLog.length = 0
  second.els['#tavern-declare-off'].dispatch('click')
  await delay(80)
  assert.equal(second.fetchLog.filter(isDeclarePost).length, 0, '取消撤下 ⇒ 不许发请求')
})

test('📦 只生成 bundle：打到 /api/tavern/preset-bundle，并把安装命令显示出来', async () => {
  const { els, fetchLog } = await runPanel({})
  fetchLog.length = 0
  els['#tavern-declare-bundle'].dispatch('click')
  await delay(80)
  const post = fetchLog.find((f) => f.opts && f.opts.method === 'POST' && f.url.indexOf('/api/tavern/preset-bundle') >= 0)
  assert.ok(post, '应 POST /api/tavern/preset-bundle')
  assert.deepEqual(JSON.parse(post.opts.body), { apply: true, confirm: true })
  assert.match(els['#tavern-declare-hint'].textContent, /install_bundle/, '要把官方安装方式告诉用户')
})

test('对照臂：把「声明」按钮的预览步骤删掉（直接写）后，顺序断言必须失败', async () => {
  const src = mutate(
    fs.readFileSync(BUNDLE, 'utf8'),
    'var pv = await declarePreview();',
    'var pv = { target: "", bytesBefore: 0, bytesAfter: 0, okCount: 0, failed: [] };',
  )
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel({ src })
    const mark = fetchLog.length
    els['#tavern-declare-apply'].dispatch('click')
    await delay(80)
    const since = fetchLog.slice(mark)
    const postIdx = since.findIndex(isDeclarePost)
    const previewIdx = since.findIndex((f) => f.url.indexOf('/api/tavern/preset-declarations') >= 0 && !isDeclarePost(f))
    // ★ 必须是「写之前就预览过」：删掉预览步骤后，唯一那次 GET 出现在 POST 之后
    assert.ok(previewIdx >= 0 && postIdx >= 0 && previewIdx < postIdx, '写入前必须先 GET 预览')
  })
})

// ════════════════════════════════════════════════════════════════
// 结构回归：预设查找 helper 的作用域
//   事故：matchPresetInList 曾被放进绑定卡的**嵌套作用域**，而调用它的
//   loadSessionPresets 在外层 —— 函数声明只在**同一个函数内**提升，于是运行时
//   `matchPresetInList is not defined`，整张「当前 Agent 预设」卡变成
//   「❌ 加载预设失败，请刷新页面」。按源码段跑的 UI 测试抓不到（它不执行外层调用点）。
// ════════════════════════════════════════════════════════════════
test('结构回归：matchPresetInList 必须与调用它的 loadSessionPresets 同层（嵌套 = 运行时 ReferenceError）', () => {
  const text = fs.readFileSync(BUNDLE, 'utf8')
  const lineOf = (needle) => {
    const lines = text.split('\n')
    const i = lines.findIndex((l) => l.includes(needle))
    assert.ok(i >= 0, '找不到：' + needle)
    return { n: i + 1, indent: lines[i].match(/^\s*/)[0].length }
  }
  const helper = lineOf('function matchPresetInList(')
  const outer = lineOf('function loadSessionPresets(')
  assert.ok(text.includes('var matched = matchPresetInList(data.presets'),
    '调用点必须还在（否则本测试失去意义）')
  assert.equal(helper.indent, outer.indent,
    'matchPresetInList（行 ' + helper.n + '，缩进 ' + helper.indent + '）必须和 loadSessionPresets（行 ' +
    outer.n + '，缩进 ' + outer.indent + '）同层，否则外层调用会在真浏览器里抛 ReferenceError')
})

test('真跑一遍 loadSessionPresets：注入真 helper 后不抛错、状态行渲染成功（本轮事故的复现测试）', async () => {
  const text = fs.readFileSync(BUNDLE, 'utf8')
  const fnSrc = extractFnSource(text, 'function loadSessionPresets(')
  const presetStatus = new FakeEl()
  const targets = {
    'tavern-session-preset-btn': new FakeEl(),
    'tavern-session-preset-label': new FakeEl(),
    'tavern-session-preset-panel': new FakeEl(),
    'tavern-session-preset-identity': new FakeEl(),
  }
  const payload = {
    ok: true, currentPresetId: 'tavern-lite',
    presets: [
      { id: 'tavern-lite', presetId: 'default', name: '酒馆默认', origin: 'tavern', description: '📚 1 本世界书' },
      { id: 'preset-x', presetId: 'preset-x', name: '另一个', origin: 'tavern' },
    ],
  }
  const sandbox = {
    document: {
      getElementById: (id) => targets[id] || null,
      createElement: () => new FakeEl(),
    },
    fetch: async () => ({ json: async () => payload }),
    getCurrentSessionId: () => 'sid-1',
    getActivePresetId: () => '',
    setActivePresetId: () => {},
    presetStatus,
    state: { characters: [], worldbooks: [], presets: [] },
    presetIdentityClue: () => '',
    presetIdentityText: () => '',
    // 这段代码还会用到这几个同层函数（切片外）——给最小桩
    esc: (s) => String(s == null ? '' : s),
    loadCurrent: async () => {},
    loadWb: async () => {},
    saveCurrent: () => {},
    matchPresetInList: loadMatchPresetFromBundle(text),
    console,
  }
  const names = Object.keys(sandbox)
  const factory = new Function(...names, 'return ' + fnSrc)
  const loadSessionPresets = factory(...names.map((k) => sandbox[k]))
  await loadSessionPresets()   // ← 抛 ReferenceError 就是本轮那个 bug
  assert.match(presetStatus.innerHTML, /酒馆默认/, '状态行要渲染出当前预设名')
  assert.equal(targets['tavern-session-preset-label'].textContent, '酒馆默认')
  assert.equal(targets['tavern-session-preset-label'].dataset.presetId, 'tavern-lite',
    '★ currentPresetId（目录名）要匹配上列表条目，而不是被改写成第一个预设')
})

test('对照臂：不注入 helper（等价于它在别的作用域里）⇒ 状态行必须变成那条红字报错', async () => {
  const text = fs.readFileSync(BUNDLE, 'utf8')
  const fnSrc = extractFnSource(text, 'function loadSessionPresets(')
  const presetStatus = new FakeEl()
  const targets = {
    'tavern-session-preset-btn': new FakeEl(),
    'tavern-session-preset-label': new FakeEl(),
    'tavern-session-preset-panel': new FakeEl(),
  }
  const sandbox = {
    document: { getElementById: (id) => targets[id] || null, createElement: () => new FakeEl() },
    fetch: async () => ({ json: async () => ({ ok: true, currentPresetId: 'tavern-lite', presets: [{ id: 'tavern-lite', name: '酒馆默认' }] }) }),
    getCurrentSessionId: () => 'sid-1',
    getActivePresetId: () => '',
    setActivePresetId: () => {},
    presetStatus,
    state: { characters: [], worldbooks: [], presets: [] },
    presetIdentityClue: () => '',
    presetIdentityText: () => '',
    // 故意不给 matchPresetInList —— 等价于「它在别的作用域里，这里看不见」
    console,
  }
  const names = Object.keys(sandbox)
  const loadSessionPresets = new Function(...names, 'return ' + fnSrc)(...names.map((k) => sandbox[k]))
  await loadSessionPresets()
  // 函数末尾有 .catch，所以错误被吞掉、promise 依然 resolve ——
  // 用户看到的就是这条红字（正是线上事故的现象）。
  assert.match(presetStatus.textContent, /加载预设失败/,
    '看不见 helper 时必须复现「❌ 加载预设失败，请刷新页面」')
})
test('面板 HTML：三个 UI 概念的按钮文案齐全且互不相同', () => {
  const html = fs.readFileSync(BUNDLE, 'utf8')
  assert.match(html, /id="tavern-binding-unbind"[^>]*>解绑本会话</)
  assert.match(html, /id="tavern-binding-apply-current"[^>]*>✅ 应用到当前会话</)
  assert.match(html, /id="tavern-binding-new-session"[^>]*>🆕 换绑并仅对新会话生效</)
  assert.match(html, /id="tavern-binding-next-select"/)
})
