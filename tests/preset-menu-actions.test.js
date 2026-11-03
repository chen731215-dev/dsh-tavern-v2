/**
 * 新会话顶部「Agent 预设」下拉的 ✎ / 🗑 注入（2.7.28）。
 *
 * 这段代码动的是**宿主渲染的 DOM**（DSH 的 AgentPresetSeat → primitives 的 Menu），
 * 没有 React 插槽可用，只能按 `[role="menuitem"]` 找条目。所以它的风险不在"好不好看"，
 * 而在下面三条 —— 一旦被改坏，用户会在**不属于酒馆的预设**上点到删除：
 *
 *   ① 只给 `isTavern` 的条目挂按钮：内置 / 第三方预设一个都不许碰；
 *   ② 点击必须**先拦下**（捕获阶段 + stopPropagation），否则会顺带把那个预设选中；
 *   ③ 改名 / 删除必须打到正确的接口（rename → `/api/tavern/preset/rename`，
 *      删除 → `/api/tavern/agent-presets`），并且改名后就地更新菜单文本。
 *
 * 这里用一套**只实现被测代码真正调用过的 API** 的迷你 DOM（不引 jsdom）：
 * createElement / appendChild / querySelector(All) / closest / set·getAttribute /
 * textContent / remove / addEventListener(capture)。选择器只支持本文件用到的三种形态，
 * 遇到别的写法会**直接抛错**（而不是静默返回空集 —— 空集会让断言变成"免费绿灯"）。
 *
 * 运行：node tests/preset-menu-actions.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lib', 'client.manager.bundle.js')
const SRC = fs.readFileSync(BUNDLE, 'utf8')

/** 从 bundle 里按花括号配平切出一个函数（含 `function` 关键字）。 */
function extractFn(bundleText, signature) {
  const start = bundleText.indexOf(signature)
  assert.ok(start >= 0, 'bundle 里找不到：' + signature)
  let depth = 0
  let seen = false
  for (let i = start; i < bundleText.length; i++) {
    const ch = bundleText[i]
    if (ch === '{') { depth++; seen = true; continue }
    if (ch === '}') { depth--; if (seen && depth === 0) return bundleText.slice(start, i + 1) }
  }
  throw new Error('花括号没配平：' + signature)
}

// ── 迷你 DOM ────────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attrs = Object.create(null)
    this.className = ''
    this.style = { cssText: '', position: '' }
    this._text = ''
    this.parentNode = null
    this.parentElement = null
    this.id = ''
  }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('')
  }
  set textContent(v) {
    this.children = []
    this._text = String(v == null ? '' : v)
  }
  appendChild(child) {
    child.parentNode = this
    child.parentElement = this
    this.children.push(child)
    return child
  }
  remove() {
    const p = this.parentNode
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parentNode = null
    this.parentElement = null
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
    if (k === 'class') this.className = String(v)
    if (k === 'id') this.id = String(v)
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null
    if (k === 'id') return this.id || null
    return k in this.attrs ? this.attrs[k] : null
  }
  _selfMatches(part) {
    let m = part.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/)
    if (m) return this.getAttribute(m[1]) === m[2]
    m = part.match(/^\.([\w-]+)$/)
    if (m) return String(this.className).split(/\s+/).includes(m[1])
    m = part.match(/^([a-zA-Z]+)$/)
    if (m) return this.tagName === m[1].toUpperCase()
    if (part === '*') return true
    throw new Error('迷你 DOM 不支持的选择器：' + part)
  }
  _matchesCompound(parts, idx, scopeRoot) {
    if (!this._selfMatches(parts[idx])) return false
    if (idx === 0) return true
    // 前缀部分必须是祖先
    let up = this.parentElement
    while (up) {
      if (up._matchesCompound(parts, idx - 1, scopeRoot)) return true
      up = up.parentElement
    }
    return false
  }
  matches(sel) {
    const parts = String(sel).trim().split(/\s+/)
    return this._matchesCompound(parts, parts.length - 1, this)
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches(sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  closest(sel) {
    let n = this
    while (n) { if (n.matches(sel)) return n; n = n.parentElement }
    return null
  }
}

function makeDocument() {
  const html = new El('html')
  const head = new El('head')
  const body = new El('body')
  html.appendChild(head)
  html.appendChild(body)
  const handlers = []
  return {
    documentElement: html,
    head,
    body,
    handlers,
    createElement: tag => new El(tag),
    getElementById(id) {
      const hit = html.querySelectorAll('[id="' + id + '"]')
      return hit[0] || null
    },
    querySelectorAll: sel => html.querySelectorAll(sel),
    querySelector: sel => html.querySelector(sel),
    addEventListener(type, fn, capture) { handlers.push({ type, fn, capture: capture === true }) },
  }
}

/** 造一个菜单项：<button role=menuitem><span><span>名称</span><span>描述</span></span></button> */
function menuItem(doc, name, desc) {
  const btn = doc.createElement('button')
  btn.setAttribute('role', 'menuitem')
  const label = doc.createElement('span')
  const n = doc.createElement('span')
  n.textContent = name
  const d = doc.createElement('span')
  d.textContent = desc || ''
  label.appendChild(n)
  label.appendChild(d)
  btn.appendChild(label)
  const wrap = doc.createElement('div')
  wrap.appendChild(btn)
  return { btn, wrap, nameEl: n }
}

/**
 * 在沙箱里跑 initAgentPresetMenuActions()。
 * `presets` 是 /api/tavern/agent-presets 的响应体。
 */
async function run({ presets, items, click }) {
  const doc = makeDocument()
  const menu = doc.createElement('div')
  menu.setAttribute('role', 'menu')
  doc.body.appendChild(menu)
  const built = items.map(it => {
    const m = menuItem(doc, it.name, it.desc)
    menu.appendChild(m.wrap)
    return m
  })

  const calls = []
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn) => { fn(); return 0 },
    document: doc,
    window: { __tavernPresetMenuHooked: false, requestAnimationFrame: (fn) => { fn(); return 0 }, confirm: () => true },
    MutationObserver: class { observe() {} },
    tavernToast: (msg) => { calls.push({ type: 'toast', msg }) },
    tavernPrompt: () => Promise.resolve('改后的名字'),
    fetch: (url, opts) => {
      calls.push({ type: 'fetch', url, opts })
      if (url === '/api/tavern/agent-presets' && (!opts || !opts.method)) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, presets }) })
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
    },
  }
  sandbox.window.document = doc
  const ctx = vm.createContext(sandbox)
  vm.runInContext(extractFn(SRC, 'function initAgentPresetMenuActions(') + '\ninitAgentPresetMenuActions();', ctx)
  // 让 loadPresets 的 Promise 链走完
  for (let i = 0; i < 8; i++) await Promise.resolve()

  if (typeof click === 'function') {
    const target = click(built)
    const ev = { target, preventDefault() {}, stopPropagation() {} }
    for (const h of doc.handlers) if (h.type === 'click' && h.capture) h.fn(ev)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return { doc, built, calls }
}

const PRESETS = [
  { id: 'preset-a', presetId: 'preset-a', name: '示例预设', isTavern: true, origin: 'tavern', description: '酒馆预设' },
  { id: 'standard', name: '标准模式', isTavern: false, isBuiltin: true, origin: 'builtin' },
]

test('① 只给酒馆预设挂 ✎/🗑，内置预设一个都不碰', async () => {
  const { built } = await run({
    presets: PRESETS,
    items: [{ name: '示例预设', desc: '🎭 示例预设' }, { name: '标准模式', desc: '内置' }],
  })
  const tavernActs = built[0].btn.querySelectorAll('.tv-preset-acts')
  const builtinActs = built[1].btn.querySelectorAll('.tv-preset-acts')
  assert.equal(tavernActs.length, 1, '酒馆预设那一行必须有操作条')
  assert.equal(builtinActs.length, 0, '内置预设那一行绝不许出现操作条')
  assert.equal(tavernActs[0].querySelectorAll('button').length, 2, '必须正好两个按钮：改名 + 删除')
})

test('② 点名地址：改名打 /preset/rename、删除打 /agent-presets', async () => {
  const { built, calls } = await run({
    presets: PRESETS,
    items: [{ name: '示例预设' }],
    click: (items) => items[0].btn.querySelectorAll('button').find(b => b.getAttribute('data-act') === 'rename'),
  })
  const rename = calls.find(c => c.type === 'fetch' && c.url === '/api/tavern/preset/rename')
  assert.ok(rename, '改名必须走 /api/tavern/preset/rename')
  assert.deepEqual(JSON.parse(rename.opts.body), { id: 'preset-a', name: '改后的名字' })
  assert.equal(built[0].nameEl.textContent, '改后的名字', '改名后菜单文本必须就地更新')
})

test('③ 删除：确认后打 /api/tavern/agent-presets，并把那一行从菜单里摘掉', async () => {
  const { built, calls, doc } = await run({
    presets: PRESETS,
    items: [{ name: '示例预设' }],
    click: (items) => items[0].btn.querySelectorAll('button').find(b => b.getAttribute('data-act') === 'delete'),
  })
  const del = calls.find(c => c.type === 'fetch' && c.url === '/api/tavern/agent-presets' && c.opts && c.opts.method === 'POST')
  assert.ok(del, '删除必须走 POST /api/tavern/agent-presets')
  assert.deepEqual(JSON.parse(del.opts.body), { ids: ['preset-a'] })
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 0, '删除成功后那一行必须消失')
})

test('④ 反例（防止有人把过滤条件删掉）：内置预设没有任何操作按钮', async () => {
  const { built } = await run({
    presets: PRESETS,
    items: [{ name: '标准模式', desc: '内置' }, { name: '标准模式', desc: '内置' }],
  })
  assert.equal(built[0].btn.querySelectorAll('.tv-preset-acts').length, 0, '同名的内置项也不许被挂上')
  assert.equal(built[1].btn.querySelectorAll('.tv-preset-acts').length, 0, '第二行同样')
})

test('⑤ 源码契约：捕获阶段拦截 + 阻止冒泡（否则会顺带选中那个预设）', () => {
  const fn = extractFn(SRC, 'function initAgentPresetMenuActions(')
  assert.match(fn, /addEventListener\('click'[\s\S]*?\}, true\)/, 'click 委托必须注册在捕获阶段')
  assert.match(fn, /e\.stopPropagation\(\)/, '必须阻止冒泡到 React 根')
  assert.match(fn, /if \(p\.isTavern !== true && p\.origin !== 'tavern'\) continue/, '必须按 isTavern/origin 过滤')
})
