/**
 * 面板标签页布局测试（IA v3：5 页签 + markup 声明归属）。
 *
 * 布局改动的风险只有一个：**卡片被收进某个页签后"再也看不见" = 功能丢失**。
 * 所以这里不去断言"好不好看"，只钉死四件事：
 *   ① 面板里每一张卡片都**显式声明**了 data-tv-tab，且值属于已知页签；
 *   ② 每个页签都有卡片、key 唯一、且带一句说明（说明行是这版 IA 的组成部分）；
 *   ③ 底部操作区（yml 预览 / 保存预设 / 状态行）**必须留在页签之外**，任何页签下都能用；
 *   ④ 搬家逻辑真的把卡片放进了**它自己声明**的页签，且切页签会落 localStorage。
 *
 * 与旧版的差别：归属从"卡片标题前缀匹配"改为"读 markup 上的 data-tv-tab"。
 * 旧做法下改一个标题文案，卡片会静默掉出页签变成"永远可见"；现在漏声明会被 ① 直接抓住。
 *
 * ②③④ 需要一个能用的迷你 DOM（被测代码要真的 appendChild/insertBefore），见 MiniEl。
 *
 * 运行：node tests/panel-tabs.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lib', 'client.manager.bundle.js')
const text = fs.readFileSync(BUNDLE, 'utf8')

// ── 从 bundle 里取素材 ──────────────────────────────────────────
function extractFnSource(bundleText, signature) {
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

/**
 * 面板 markup 里的**顶层卡片**：标题 + 它自己声明的归属。
 * 注释掉的卡片不算（`// '  <div class="t-card">...`），所以按 <div> 深度只取深度 1 的卡片。
 *
 * ⚠️ 收编期间两类名并存：旧 `.t-card` / `.t-card-title` 与新基元 `.tv-card` / `.tv-card__title`。
 *    两者都必须被识别，否则已收编的卡片会在测试里"消失"——看着通过，其实漏了。
 */
const CARDS = (() => {
  const src = extractFnSource(text, 'function panelHTML(')
  const out = []
  let depth = 0
  let pending = null
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//')) continue
    const opens = (line.match(/<div\b/g) || []).length
    const closes = (line.match(/<\/div>/g) || []).length
    if (/<div class="(?:t|tv)-card\b/.test(line)) {
      // #tavern-manager 是唯一的深度 1；卡片自己的 div 开在这一层 ⇒ 它是顶层卡片
      if (depth === 1) {
        pending = {
          title: '',
          tab: (line.match(/data-tv-tab="([^"]+)"/) || [])[1] || '',
          cls: (line.match(/<div class="([^"]+)"/) || [])[1] || 't-card',
        }
        out.push(pending)
      } else {
        pending = null
      }
      depth += 1
    } else {
      const titleM = line.match(/<span class="(?:t|tv)-card(?:-title|__title)"[^>]*>([^<]{1,80})/)
      if (titleM && pending) pending.title = titleM[1].trim()
      depth += opens
    }
    depth -= closes
  }
  return out
})()

const CARD_TITLES = CARDS.map((c) => c.title)

/** 页签定义（TAB_DEFS）与散件规则（TAB_TAIL_RULES）——直接从源码里抠，保证测的是真规则。 */
const { TAB_DEFS, TAB_TAIL_RULES, TAB_KEYS } = (() => {
  const block = text.slice(text.indexOf('var TAB_DEFS = ['), text.indexOf('function tabKeyForCard('))
  const defs = []
  const dre = /\{ key: '([^']+)',\s*label: '([^']+)',\s*desc: '([^']*)'\s*\}/g
  let m
  while ((m = dre.exec(block))) defs.push({ key: m[1], label: m[2], desc: m[3] })
  const tails = []
  const tre = /\{ tab: '([^']+)', ids: \[([^\]]*)\]([^}]*)\}/g
  while ((m = tre.exec(block))) {
    tails.push({
      tab: m[1],
      ids: m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
      labelPrefix: (m[3].match(/labelPrefix: '([^']+)'/) || [])[1] || '',
    })
  }
  const keys = block.match(/var TAB_KEYS = TAB_DEFS\.map/)
    ? defs.map((d) => d.key)
    : defs.map((d) => d.key)
  return { TAB_DEFS: defs, TAB_TAIL_RULES: tails, TAB_KEYS: keys }
})()

// ── 迷你 DOM ────────────────────────────────────────────────────
class MiniEl {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this._class = ''
    this.textContent = ''
    this.listeners = {}
  }
  get className() { return this._class }
  set className(v) { this._class = String(v == null ? '' : v) }
  // 真 DOM 里 el.id = 'x' 等价于设置 id 属性；迷你 DOM 必须一样，否则 querySelector('#x') 找不到
  get id() { return this.attrs.id || '' }
  set id(v) { if (v == null || v === '') delete this.attrs.id; else this.attrs.id = String(v) }
  get classList() {
    const self = this
    const list = () => self._class.split(/\s+/).filter(Boolean)
    return {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) self._class = list().concat(c).join(' ') },
      remove: (c) => { self._class = list().filter((x) => x !== c).join(' ') },
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want && !has) self._class = list().concat(c).join(' '); if (!want && has) self._class = list().filter((x) => x !== c).join(' ') },
    }
  }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  dispatch(t) { (this.listeners[t] || []).forEach((fn) => fn({ target: this, closest: () => null })) }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(child)
    else this.children.splice(i, 0, child)
    return child
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parentNode = null
    return child
  }
  get firstChild() { return this.children[0] || null }
  get nextSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.children.indexOf(this)
    return this.parentNode.children[i + 1] || null
  }
  getText() { return (this.textContent || '') + this.children.map((c) => c.getText()).join('') }
  /** 支持逗号分隔的选择器列表（收编期间要同时匹配 .t-card 与 .tv-card） */
  matches(sel) { return String(sel).split(',').some((s) => this.matchesOne(s.trim())) }
  matchesOne(sel) {
    if (!sel) return false
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1))
    if (sel.startsWith('#')) return this.attrs.id === sel.slice(1)
    return this.tagName === sel.toUpperCase()
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  querySelectorAll(sel) {
    const out = []
    const walk = (node) => {
      for (const c of node.children) { if (c.matches(sel)) out.push(c); walk(c) }
    }
    walk(this)
    return out
  }
}

function buildPanel() {
  const mgr = new MiniEl('div')
  mgr.attrs.id = 'tavern-manager'
  mgr.appendChild(new MiniEl('h2'))
  // 真卡片：标题与归属都取自真 markup
  for (const c of CARDS) {
    const card = new MiniEl('div')
    card.className = c.cls || 't-card'
    if (c.tab) card.setAttribute('data-tv-tab', c.tab)
    const t = new MiniEl('span')
    t.className = (c.cls || '').indexOf('tv-card') === 0 ? 'tv-card__title' : 't-card-title'
    t.textContent = c.title
    card.appendChild(t)
    mgr.appendChild(card)
  }
  // 散件 + 底部操作区（按真 markup 的 id 造，保证规则能命中）
  const make = (tag, id) => { const e = new MiniEl(tag); e.attrs.id = id; return e }
  const label = new MiniEl('label'); label.className = 't-label'; label.textContent = '额外设定 / 系统提示'
  mgr.appendChild(label)
  mgr.appendChild(make('textarea', 'tavern-extra'))
  const toolsRow = new MiniEl('div'); toolsRow.className = 't-row'; toolsRow.appendChild(make('input', 'tavern-tools-toggle')); mgr.appendChild(toolsRow)
  const netRow = new MiniEl('div'); netRow.className = 't-row'; netRow.appendChild(make('input', 'tavern-network-toggle')); mgr.appendChild(netRow)
  const antiRow = new MiniEl('div'); antiRow.className = 't-row'; antiRow.appendChild(make('input', 'tavern-anticliche-toggle')); mgr.appendChild(antiRow)
  // 底部操作区：必须留在页签外
  const ymlLabel = new MiniEl('label'); ymlLabel.className = 't-label'; ymlLabel.textContent = '当前将保存的 agent.cordis.yml'
  mgr.appendChild(ymlLabel)
  mgr.appendChild(make('textarea', 'tavern-agent-yml'))
  const saveRow = new MiniEl('div'); saveRow.className = 't-row'; saveRow.appendChild(make('button', 'tavern-save')); mgr.appendChild(saveRow)
  mgr.appendChild(make('div', 'tavern-status'))
  return mgr
}

function runInstaller(mgr, stored) {
  const store = Object.assign({}, stored)
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
  }
  const document = {
    getElementById: (id) => (mgr.attrs.id === id ? mgr : mgr.querySelector('#' + id)),
    createElement: (tag) => new MiniEl(tag),
  }
  const sandbox = { document, localStorage, console, String, Object, JSON, Array, Boolean, Number }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  const head = text.slice(text.indexOf('var TAB_DEFS = ['), text.indexOf('function tabKeyForCard('))
  const body = extractFnSource(text, 'function tabKeyForCard(') + '\n' +
               extractFnSource(text, 'function tabKeyForTail(') + '\n' +
               extractFnSource(text, 'function installPanelTabs(') + '\ninstallPanelTabs();'
  vm.runInContext(head + '\n' + body, sandbox, { timeout: 5000 })
  return { mgr, store }
}

// ════════════════════════════════════════════════════════════════
// ① 静态：每张卡片都显式声明了归属，且值合法
// ════════════════════════════════════════════════════════════════
test('① 每张顶层卡片都声明了 data-tv-tab，且值属于已知页签', () => {
  assert.ok(CARD_TITLES.length >= 14, '顶层卡片数量异常（解析或布局变了）：' + CARD_TITLES.length + '：' + CARD_TITLES.join(' / '))
  const noAttr = CARDS.filter((c) => !c.tab).map((c) => c.title)
  assert.deepEqual(noAttr, [], '这些卡片没声明 data-tv-tab（会掉出所有页签）：' + noAttr.join(' / '))
  const badKey = CARDS.filter((c) => c.tab && !TAB_KEYS.includes(c.tab)).map((c) => c.title + '→' + c.tab)
  assert.deepEqual(badKey, [], '这些卡片声明了未知页签：' + badKey.join(' / '))
  // 已按用户要求删除的卡片不许复活
  assert.equal(CARD_TITLES.some((t) => t.indexOf('通用增强层') === 0), false, '通用增强层卡片必须保持删除')
  assert.equal(CARD_TITLES.some((t) => t.indexOf('NSFW') === 0), false, 'NSFW 卡片必须保持删除（破限交给 ST 预设）')
  // 已拆除的折叠容器不许复活
  assert.equal(CARD_TITLES.includes('高级功能'), false, '「高级功能」折叠容器已拆除，不该再作为卡片存在')
})

test('② 页签定义完整：5 个页签、key 唯一、每个页签都有卡片、每个都有说明', () => {
  assert.deepEqual(TAB_DEFS.map((d) => d.key), ['settings', 'behavior', 'memory', 'advanced', 'other'])
  assert.equal(new Set(TAB_DEFS.map((d) => d.key)).size, TAB_DEFS.length, 'key 不能重复')
  for (const d of TAB_DEFS) {
    assert.ok(d.label, d.key + ' 缺 label')
    assert.ok(d.desc && d.desc.length > 0, d.key + ' 缺说明（说明行是这版 IA 的组成部分）')
    const n = CARDS.filter((c) => c.tab === d.key).length
    assert.ok(n > 0, d.key + '（' + d.label + '）一个卡片都没有')
  }
})

test('③ 底部操作区不被任何页签/散件规则认领 ⇒ 永远可见（功能不缺失的关键）', () => {
  const claimedIds = TAB_TAIL_RULES.reduce((acc, r) => acc.concat(r.ids), [])
  for (const id of ['tavern-agent-yml', 'tavern-save', 'tavern-status', 'tavern-inject-exit']) {
    assert.ok(!claimedIds.includes(id), id + ' 属于底部操作区，不该被收进页签')
  }
  const tailIds = CARDS.map((c) => c.tab)
  assert.ok(tailIds.every(Boolean), '卡片归属不该有空洞')
})

test('④ 散件规则指向的控件 id 在真 markup 里确实存在（防规则写错成死规则）', () => {
  for (const r of TAB_TAIL_RULES) {
    for (const id of r.ids) {
      assert.ok(text.includes('id="' + id + '"'), '规则里的 id 在面板 markup 里不存在：' + id)
    }
  }
})

test('④b 面板**可见文案**里不许再出现 NSFW / 无意义的装饰 emoji', () => {
  const src = extractFnSource(text, 'function panelHTML(')
  const visible = src.split('\n').filter((l) => !l.trim().startsWith('//'))
  const bad = []
  for (const l of visible) {
    if (/NSFW|nsfw/.test(l)) bad.push(l.trim().slice(0, 90))
  }
  assert.deepEqual(bad, [], '这些可见文案里还留着 NSFW 字样：\n' + bad.join('\n'))
})

// ════════════════════════════════════════════════════════════════
// ⑤ 运行时（迷你 DOM）：搬家结果正确 + 切页签 + 记住上次
// ════════════════════════════════════════════════════════════════
test('⑤ 真跑 installPanelTabs：所有卡片进页签、footer 留在页签外', () => {
  const mgr = buildPanel()
  const { mgr: after } = runInstaller(mgr, {})

  const bar = after.querySelector('#tavern-tabbar')
  assert.ok(bar, '应当生成页签栏')
  assert.equal(bar.querySelectorAll('.tv-tab').length, TAB_DEFS.length, TAB_DEFS.length + ' 个页签按钮')

  const panes = after.querySelectorAll('.tv-pane')
  assert.equal(panes.length, TAB_DEFS.length, TAB_DEFS.length + ' 个 pane')

  // 每张卡片都必须落在**它自己声明**的那个 pane 里
  const cards = after.querySelectorAll('.t-card, .tv-card')
  assert.equal(cards.length, CARDS.length, '卡片数量不能变（搬家不许丢）')
  for (const card of cards) {
    const pane = card.parentNode
    assert.ok(pane && pane.classList && pane.classList.contains('tv-pane'),
      '卡片没被收进页签：' + card.getText().slice(0, 20))
    assert.equal(pane.getAttribute('data-tab'), card.getAttribute('data-tv-tab'), '卡片去了错的页签')
  }

  // footer 必须留在页签之外：向上走直到 #tavern-manager，中途不许经过任何 .tv-pane
  const insidePane = (el) => {
    let n = el.parentNode
    while (n) {
      if (n.attrs && n.attrs.id === 'tavern-manager') return false
      if (n.classList && n.classList.contains('tv-pane')) return true
      n = n.parentNode
    }
    return false
  }
  for (const id of ['tavern-agent-yml', 'tavern-save', 'tavern-status']) {
    const el = after.querySelector('#' + id)
    assert.ok(el, 'footer 元素存在：' + id)
    assert.equal(insidePane(el), false, id + ' 必须留在页签外（常驻可见）')
  }

  const activePanes = panes.filter((p) => p.classList.contains('active'))
  assert.equal(activePanes.length, 1, '同时只能有一个页签可见')
  assert.equal(activePanes[0].getAttribute('data-tab'), TAB_DEFS[0].key, '默认停在第一个页签')
  // 说明行要跟着当前页签走
  const descEl = after.querySelector('#tavern-tabdesc')
  assert.ok(descEl, '应当生成页签说明行')
  assert.equal(descEl.textContent, TAB_DEFS[0].desc, '说明行应与当前页签一致')
})

test('⑥ 切页签：点按钮 → 只有该页签可见、说明行跟随、并写入 localStorage', () => {
  const mgr = buildPanel()
  const { store } = runInstaller(mgr, {})
  const bar = mgr.querySelector('#tavern-tabbar')
  const target = TAB_DEFS[2]
  const btn = bar.querySelectorAll('.tv-tab').find((b) => b.getAttribute('data-tab') === target.key)
  btn.dispatch('click')
  const active = mgr.querySelectorAll('.tv-pane').filter((p) => p.classList.contains('active'))
  assert.equal(active.length, 1)
  assert.equal(active[0].getAttribute('data-tab'), target.key)
  assert.equal(store['tavern.panel.tab'], target.key, '当前页签要记住')
  assert.equal(mgr.querySelector('#tavern-tabdesc').textContent, target.desc, '说明行要跟着切')
})

test('⑦ 上次停留的页签会被恢复；非法值回落第一个页签', () => {
  const mgrA = buildPanel()
  runInstaller(mgrA, { 'tavern.panel.tab': 'memory' })
  const activeA = mgrA.querySelectorAll('.tv-pane').filter((p) => p.classList.contains('active'))
  assert.equal(activeA[0].getAttribute('data-tab'), 'memory')

  const mgrB = buildPanel()
  runInstaller(mgrB, { 'tavern.panel.tab': '不存在的页签' })
  const activeB = mgrB.querySelectorAll('.tv-pane').filter((p) => p.classList.contains('active'))
  assert.equal(activeB[0].getAttribute('data-tab'), TAB_DEFS[0].key, '非法值必须回落，不能白屏')
})

test('⑧ 幂等：重复调用不会生成第二套页签', () => {
  const mgr = buildPanel()
  const { mgr: after } = runInstaller(mgr, {})
  assert.equal(after.querySelectorAll('#tavern-tabbar').length, 1)
  assert.equal(after.querySelectorAll('.tv-pane').length, TAB_DEFS.length)
  assert.equal(after.querySelectorAll('.t-card, .tv-card').length, CARDS.length)
})
