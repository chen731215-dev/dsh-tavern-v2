/**
 * 面板标签页布局测试。
 *
 * 布局改动的风险只有一个：**卡片被收进某个页签后"再也看不见" = 功能丢失**。
 * 所以这里不去断言"好不好看"，只钉死三件事：
 *   ① 面板里每一张卡片都被页签规则收走（不会留在外面孤零零/或漏掉规则）；
 *   ② 底部操作区（yml 预览 / 保存预设 / 状态行）**必须留在页签之外**，任何页签下都能用；
 *   ③ 搬家逻辑真的把卡片放进了正确的页签，且切页签会落 localStorage。
 *
 * ②③ 需要一个能用的迷你 DOM（被测代码要真的 appendChild/insertBefore），见 MiniEl。
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
 * 面板 markup 里**顶层卡片**的标题。
 * 注意两件事：
 *   · 注释掉的卡片（例如 `// '  <div class="t-card">...🤖 Agent 预设管理`）不算；
 *   · 「⚙️ 高级功能」里的 5 张子卡片是嵌套的，它们跟着整卡搬走，不需要单独的页签规则。
 * 所以这里按 <div> 深度只取深度 1 的卡片标题。
 */
const CARDS = (() => {
  const src = extractFnSource(text, 'function panelHTML(')
  const out = []
  let depth = 0
  let pending = null            // 顶层卡片开标签时记下它的 data-tv-tab
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//')) continue          // 注释掉的不算
    const opens = (line.match(/<div\b/g) || []).length
    const closes = (line.match(/<\/div>/g) || []).length
    if (/<div class="t-card\b/.test(line)) {
      // #tavern-manager 是唯一的深度 1；卡片自己的 div 开在这一层 ⇒ 它的标题才是顶层卡片标题
      const isTop = depth === 1
      const tabM = line.match(/data-tv-tab="([^"]*)"/)
      pending = isTop ? { tab: tabM ? tabM[1] : '' } : null
      depth += 1
    } else {
      const titleM = line.match(/<span class="t-card-title"[^>]*>([^<]{1,80})/)   // 允许 title 上带 id/style（高级功能那张就是）
      if (titleM && pending) { out.push({ title: titleM[1].trim(), tab: pending.tab }); pending = null }
      depth += opens
    }
    depth -= closes
  }
  return out
})()
const CARD_TITLES = CARDS.map((c) => c.title)

/** 页签定义（TAB_DEFS）与散件规则（TAB_TAIL_RULES）——直接从源码里抠，保证测的是真规则。 */
const { TAB_DEFS, TAB_TAIL_RULES } = (() => {
  const block = text.slice(text.indexOf('var TAB_DEFS = ['), text.indexOf('function installPanelTabs('))
  const defs = []
  const dre = /\{ key: '([^']+)', label: '([^']+)', titles: \[([^\]]*)\] \}/g
  let m
  while ((m = dre.exec(block))) {
    defs.push({ key: m[1], label: m[2], titles: m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) })
  }
  const tails = []
  const tre = /\{ tab: '([^']+)', ids: \[([^\]]*)\]([^}]*)\}/g
  while ((m = tre.exec(block))) {
    tails.push({
      tab: m[1],
      ids: m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
      labelPrefix: (m[3].match(/labelPrefix: '([^']+)'/) || [])[1] || '',
    })
  }
  return { TAB_DEFS: defs, TAB_TAIL_RULES: tails }
})()

/** 运行时同款匹配（照抄 installPanelTabs 里的 tabKeyForTitle 规则） */
function tabKeyForTitle(title) {
  const t = String(title || '').trim()
  for (const d of TAB_DEFS) for (const prefix of d.titles) if (t.indexOf(prefix) === 0) return d.key
  return ''
}

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
  removeAttribute(k) { delete this.attrs[k] }
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
  matches(sel) {
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
  // 真卡片（标题取自真 markup）
  for (const c of CARDS) {
    const card = new MiniEl('div')
    card.className = 't-card'
      if (c.tab) card.setAttribute('data-tv-tab', c.tab)   // ★ 声明式归属：卡片自己说归哪个页签
    const t = new MiniEl('span')
    t.className = 't-card-title'
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
  const fns = extractFnSource(text, 'function tabKeyForTitle(') + '\n' +
              extractFnSource(text, 'function tabKeyForTail(') + '\n' +
              text.slice(text.indexOf('function installPanelTabs('), text.indexOf('function installPanelTabs(') + extractFnSource(text, 'function installPanelTabs(').length)
  // TAB_DEFS / TAB_TAIL_RULES / TAB_STORAGE_KEY 是块级变量：拼在前面
  const head = text.slice(text.indexOf('var TAB_DEFS = ['), text.indexOf('function tabKeyForTitle('))
  const install = extractFnSource(text, 'function installPanelTabs(')
  vm.runInContext(head + '\n' + fns.replace(extractFnSource(text, 'function installPanelTabs('), install) + '\ninstallPanelTabs();', sandbox, { timeout: 5000 })
  return { mgr, store }
}

// ════════════════════════════════════════════════════════════════
// ① 静态：每张卡片都被页签规则收走（= 不会有卡片被漏在页签外"消失"）
// ════════════════════════════════════════════════════════════════
test('① 面板里每张卡片都能被页签规则匹配（没有孤儿卡片）', () => {
  // 顶层卡片共 12 张（高级功能里那 5 张是嵌套的，整卡搬走）。数量对不上说明解析或布局变了，先看这里。
  assert.equal(CARD_TITLES.length, 12, '顶层卡片数量应为 12，实际 ' + CARD_TITLES.length + '：' + CARD_TITLES.join(' / '))
  for (const must of ['🎭 当前 Agent 预设', '🔗 当前会话绑定', '🎯 生效范围', '角色卡', '📚 世界书', '🔞 成人向提示段', '🎭 剧情选项', '📌 开场白', '🧩 全局正则', '预设', '🎓 技能', '⚙️ 高级功能']) {
    assert.ok(CARD_TITLES.some((t) => t.indexOf(must) === 0),
      '解析应包含这张卡片：' + must + '（实际：' + CARD_TITLES.join(' / ') + '）')
  }
  // 已按用户要求删除的卡片不许复活
  assert.equal(CARD_TITLES.some((t) => t.indexOf('✨ 通用增强层') === 0), false, '通用增强层卡片必须保持删除')
  // 成人向提示段卡片必须存在（它是"用户自填正文"的入口）
  assert.ok(CARD_TITLES.some((t) => t.indexOf('🔞 成人向提示段') === 0), '成人向提示段卡片不能丢')
  // ★ 声明式归属（2026-10-07）：每张一级卡片都必须自己声明 data-tv-tab
  const noDecl = CARDS.filter((c) => !c.tab).map((c) => c.title)
  assert.deepEqual(noDecl, [], '★ 这些卡片缺 data-tv-tab 声明（会退化成标题前缀匹配、并被自检点名）：' + noDecl.join(' / '))
  const keys = new Set(TAB_DEFS.map((d) => d.key))
  const badKeys = CARDS.filter((c) => c.tab && !keys.has(c.tab)).map((c) => c.title + '→' + c.tab)
  assert.deepEqual(badKeys, [], '★ 声明了不存在的页签 key：' + badKeys.join(' / '))
  // ★ 一致性强约束：声明必须与标题前缀映射指向**同一个页签**（迁移期最容易被漏掉的漂移）
  const mismatched = CARDS.map((c) => ({ ...c, legacy: tabKeyForTitle(c.title) }))
    .filter((c) => c.legacy && c.legacy !== c.tab)
    .map((c) => c.title + '：声明 ' + c.tab + ' ≠ 前缀 ' + c.legacy)
  assert.deepEqual(mismatched, [], '★ data-tv-tab 与标题前缀指向了不同页签：' + mismatched.join(' / '))
  const orphans = CARD_TITLES.filter((t) => !tabKeyForTitle(t))
  assert.deepEqual(orphans, [], '这些卡片没被任何页签收走（要加进 TAB_DEFS）：' + orphans.join(' / '))
})

test('② 页签定义完整：4 个页签、key 唯一、每个页签都有卡片', () => {
  assert.deepEqual(TAB_DEFS.map((d) => d.key), ['session', 'content', 'play', 'advanced'])
  assert.equal(new Set(TAB_DEFS.map((d) => d.key)).size, TAB_DEFS.length, 'key 不能重复')
  for (const d of TAB_DEFS) assert.ok(d.label && d.titles.length > 0, d.key + ' 缺标题或卡片')
})

test('③ 底部操作区不被任何页签/散件规则认领 ⇒ 永远可见（功能不缺失的关键）', () => {
  const footerTitles = ['当前将保存的 agent.cordis.yml']
  for (const t of footerTitles) assert.equal(tabKeyForTitle(t), '', 'footer 文案不该被页签收走：' + t)
  const claimedIds = TAB_TAIL_RULES.reduce((acc, r) => acc.concat(r.ids), [])
  for (const id of ['tavern-agent-yml', 'tavern-save', 'tavern-status', 'tavern-inject-exit']) {
    assert.ok(!claimedIds.includes(id), id + ' 属于底部操作区，不该被收进页签')
  }
})

test('④ 散件规则指向的控件 id 在真 markup 里确实存在（防规则写错成死规则）', () => {
  for (const r of TAB_TAIL_RULES) {
    for (const id of r.ids) {
      assert.ok(text.includes('id="' + id + '"'), '规则里的 id 在面板 markup 里不存在：' + id)
    }
  }
})

test('④b 面板文案：成人段卡片必须"可见 + 进玩法页签 + 自填正文"，且不含现成破限句', () => {
  // 只看 markup 字符串（跳过 // 注释）—— 注释里写"为什么这么设计"是有意为之，不算可见文案。
  const src = extractFnSource(text, 'function panelHTML(')
  const visible = src.split('\n').filter((l) => !l.trim().startsWith('//'))
  assert.ok(visible.some((l) => l.includes('🔞 成人向提示段')), '卡片标题应当可见')
  assert.ok(visible.some((l) => l.includes('id="tavern-nsfw-enabled"')), '开关不见了')
  assert.ok(visible.some((l) => l.includes('id="tavern-nsfw-prompt"')), '正文输入框不见了')
  assert.ok(visible.some((l) => /自填|自己填/.test(l)), '★ 卡片说明必须讲清"正文由使用者自己填"')
  assert.ok(visible.some((l) => /只存本机|不进代码|不会进入代码/.test(l)), '说明里要讲清正文只存本机、不进发布包')
  // ★ 页面文案里不许出现现成的破限句 —— 正文一律来自使用者自己的 state
  const BANNED = [/内容策略暂停/, /无视(道德|伦理|内容政策)/, /无审查模式/, /越狱/, /jailbreak/i]
  const bad = visible.filter((l) => BANNED.some((re) => re.test(l)))
  assert.deepEqual(bad, [], '可见文案里出现了现成破限句：\n' + bad.join('\n'))
  // 「⚙️ 高级功能」的简介要如实列出现在里面的东西（事故现场：简介里还写着 NSFW）
  const adv = visible.find((l) => l.includes('tavern-advanced-toggle'))
  assert.ok(adv, '找不到高级功能卡片')
  for (const kw of ['记忆', '关系网', '故事背景']) assert.ok(adv.includes(kw), '简介该包含：' + kw)
  assert.equal(adv.includes('NSFW'), false, '★ 高级功能简介里不许再写 NSFW')
})

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
  // ④c/④d 声明式归属的运行时不变量
  // ════════════════════════════════════════════════════════════════
  test('④c 声明优先于标题：标题改成映射不出来的，卡片仍按 data-tv-tab 归位', () => {
    const mgr = buildPanel()
    const card = mgr.children.find((el) => {
      const t = el.querySelector && el.querySelector('.t-card-title')
      return el.className === 't-card' && t && t.textContent === '角色卡'
    })
    assert.ok(card, '找不到「角色卡」卡片')
    card.querySelector('.t-card-title').textContent = 'ZZZ-标题全改了'
    const { mgr: after } = runInstaller(mgr)
    const content = after.querySelectorAll('.t-pane').find((p) => p.getAttribute('data-tab') === 'content')
    assert.ok(content.children.includes(card), '★ 声明还在就必须照样进「内容」——纯标题前缀机制在这种改名下会掉出去')
    assert.equal(after.getAttribute('data-tab-unclaimed'), null, '有合法声明就不该被点名')
  })

  test('④d 自检点名：声明非法且标题也认不出 ⇒ 写进 data-tab-unclaimed 且保持可见', () => {
    const mgr = buildPanel()
    const rogue = new MiniEl('div')
    rogue.className = 't-card'
    rogue.setAttribute('data-tv-tab', 'no-such-tab')
    const rt = new MiniEl('span')
    rt.className = 't-card-title'
    rt.textContent = '🆕 忘了登记的卡片'
    rogue.appendChild(rt)
    mgr.appendChild(rogue)

    const { mgr: after } = runInstaller(mgr)
    const flagged = after.getAttribute('data-tab-unclaimed')
    assert.ok(flagged && flagged.indexOf('忘了登记的卡片') >= 0, '★ 自检必须点名这张卡：' + flagged)
    assert.ok(flagged.indexOf('no-such-tab') >= 0, '点名要带上那个非法 key，方便定位')
    assert.equal(rogue.parentNode, after, '★ 未归类的卡片必须留在面板里（宁可多显示，不可丢功能）')
    const inPane = after.querySelectorAll('.t-pane').some((p) => p.children.includes(rogue))
    assert.equal(inPane, false, '未归类 ≠ 可以随便塞进某个页签')
  })

  // ════════════════════════════════════════════════════════════════
  // ⑤ 运行时（迷你 DOM）：搬家结果正确 + 切页签 + 记住上次
// ════════════════════════════════════════════════════════════════
test('⑤ 真跑 installPanelTabs：所有卡片进页签、footer 留在页签外', () => {
  const mgr = buildPanel()
  const { mgr: after } = runInstaller(mgr, {})

  const bar = after.querySelector('#tavern-tabbar')
  assert.ok(bar, '应当生成页签栏')
  assert.equal(bar.querySelectorAll('.t-tab').length, 4, '4 个页签按钮')
    // ★ 自检必须干净：所有卡片都有合法声明 ⇒ 不该留下 data-tab-unclaimed
    assert.equal(after.getAttribute('data-tab-unclaimed'), null,
      '★ 有卡片没被页签收走（自检点名）：' + after.getAttribute('data-tab-unclaimed'))

  const panes = after.querySelectorAll('.t-pane')
  assert.equal(panes.length, 4, '4 个 pane')

  // 每张卡片都必须落在某个 pane 里
  const cards = after.querySelectorAll('.t-card')
  assert.equal(cards.length, CARD_TITLES.length, '卡片数量不能变（搬家不许丢）')
  for (const card of cards) {
    const pane = card.parentNode
    assert.ok(pane && pane.classList && pane.classList.contains('t-pane'),
      '卡片没被收进页签：' + card.getText().slice(0, 20))
    const expected = tabKeyForTitle(card.querySelector('.t-card-title').textContent)
    assert.equal(pane.getAttribute('data-tab'), expected, '卡片去了错的页签')
  }

  // footer 必须留在页签之外：向上走直到 #tavern-manager，中途不许经过任何 .t-pane
  const insidePane = (el) => {
    let n = el.parentNode
    while (n) {
      if (n.attrs && n.attrs.id === 'tavern-manager') return false
      if (n.classList && n.classList.contains('t-pane')) return true
      n = n.parentNode
    }
    return false
  }
  for (const id of ['tavern-agent-yml', 'tavern-save', 'tavern-status']) {
    const el = after.querySelector('#' + id)
    assert.ok(el, 'footer 元素存在：' + id)
    assert.equal(insidePane(el), false, id + ' 必须留在页签外（常驻可见）')
  }

  // 默认页签是 session 且只有一个 active
  const activePanes = panes.filter((p) => p.classList.contains('active'))
  assert.equal(activePanes.length, 1, '同时只能有一个页签可见')
  assert.equal(activePanes[0].getAttribute('data-tab'), 'session', '默认停在「会话」')
})

test('⑥ 切页签：点按钮 → 只有该页签可见，并写入 localStorage', () => {
  const mgr = buildPanel()
  const { store } = runInstaller(mgr, {})
  const bar = mgr.querySelector('#tavern-tabbar')
  const btn = bar.querySelectorAll('.t-tab').find((b) => b.getAttribute('data-tab') === 'play')
  btn.dispatch('click')
  const active = mgr.querySelectorAll('.t-pane').filter((p) => p.classList.contains('active'))
  assert.equal(active.length, 1)
  assert.equal(active[0].getAttribute('data-tab'), 'play')
  assert.equal(store['tavern.panel.tab'], 'play', '当前页签要记住')
})

// ════════════════════════════════════════════════════════════════
// ⑤b ★ 散件规则必须认「元素自身」—— `#tavern-extra` 就是那个 textarea 本身
//    （曾经的 bug：tabKeyForTail 只 el.querySelector('#id') 查后代 ⇒ 控件自身
//      永远搬不进「内容」页签，被留在页签外。留个断言钉死它。）
// ════════════════════════════════════════════════════════════════
test('⑤b 散件规则认元素自身：#tavern-extra 这个 textarea 本身会进「内容」页签', () => {
  // 注意：tabKeyForTail 只活在 installPanelTabs 所在的 vm 沙箱里，测试里拿不到它的引用，
  //   所以这里**只做行为断言**（真跑 installPanelTabs，看那个 textarea 落到哪个 pane）。
  const mgr = buildPanel()
  const ta = mgr.querySelector('#tavern-extra')
  assert.ok(ta, '夹具里应当有 #tavern-extra')
  const { mgr: after } = runInstaller(mgr, {})
  const content = after.querySelectorAll('.t-pane').find((p) => p.getAttribute('data-tab') === 'content')
  const session = after.querySelectorAll('.t-pane').find((p) => p.getAttribute('data-tab') === 'session')
  assert.ok(content.children.includes(ta), '★ #tavern-extra 必须被搬进「内容」页签（不是留在页签外）')
  assert.equal(after.children.includes(ta), false, '★ 它不该还留在面板根下（= 没被任何页签收走）')
  assert.equal(session.children.includes(ta), false, '也不该进别的页签')
})

test('⑦ 上次停留的页签会被恢复；非法值回落 session', () => {
  const mgrA = buildPanel()
  runInstaller(mgrA, { 'tavern.panel.tab': 'advanced' })
  const activeA = mgrA.querySelectorAll('.t-pane').filter((p) => p.classList.contains('active'))
  assert.equal(activeA[0].getAttribute('data-tab'), 'advanced')

  const mgrB = buildPanel()
  runInstaller(mgrB, { 'tavern.panel.tab': '不存在的页签' })
  const activeB = mgrB.querySelectorAll('.t-pane').filter((p) => p.classList.contains('active'))
  assert.equal(activeB[0].getAttribute('data-tab'), 'session', '非法值必须回落，不能白屏')
})

test('⑧ 幂等：重复调用不会生成第二套页签', () => {
  const mgr = buildPanel()
  const { mgr: after } = runInstaller(mgr, {})
  assert.equal(after.querySelectorAll('#tavern-tabbar').length, 1)
  assert.equal(after.querySelectorAll('.t-pane').length, 4)
  assert.equal(after.querySelectorAll('.t-card').length, CARD_TITLES.length)
})
