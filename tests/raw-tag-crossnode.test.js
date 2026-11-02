/**
 * 裸标签（`<options>` / `<details>`）必须**跨文本节点**渲染。
 *
 * 真实事故（2026-11-02，用户实测）：每轮刚生成完，选项是碎的 —— 折叠块标题变成默认的
 * 「展开查看」、选项文字被截断；**切一次会话回来又对了**。
 *
 * 根因是 DSH 用 markdown 渲染消息，**每一行各自一个 `<p>`**：
 *   `<options>\n<option>…</option>\n</options>` 在 DOM 里被拆成多个文本节点，
 *   `<details>` 与它的 `<summary>` 往往也不在同一个节点里。
 *   旧实现「逐个文本节点切片」⇒ 每个节点里都只有半个标签：
 *     · `<details>` 那半截找不到 `<summary>` ⇒ 标题退化成「展开查看」；
 *     · `<option>` 那半截没有 `</option>` ⇒ 文字被截断。
 *   切会话回来时 DSH 整条重渲染，那一拍恰好落在一个节点里 ⇒ 看起来又对了。
 *
 * 修法：把整段文本**拼起来**找完整块，再按「首尾节点」就地替换（`applyRawTagBlock`）。
 *
 * 本套件钉五件事：
 *   ① 拆散成多个 `<p>` 的 `<details>` 能渲染出**正确的标题**与正文；
 *   ② 拆散的 `<options>` 能渲染出**全部**选项，文字完整、`data-opt` 正确；
 *   ③ 前缀正文与块外内容一个字符都不丢；
 *   ④ `findRawTagBlocks` 不会把被 `<options>` 包住的 `<option>` 重复算成独立块；
 *   ⑤ 反例：只按「单个文本节点」切片的旧写法在同样的 DOM 上必须**拿不到**这两块。
 *
 * 运行：node --test tests/raw-tag-crossnode.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const BUNDLE = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')

/** 抠一个函数（大括号配平，跳过字符串与行注释）。 */
function extractFn(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) throw new Error('找不到：' + sig)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      k++
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++ }
      continue
    }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error('不闭合：' + sig)
}

// ── 最小 DOM 桩（够跑这四个函数；DocumentFragment 插入语义与真实 DOM 一致）──
class TNode {
  constructor(d) { this.nodeType = 3; this.data = String(d); this.parentNode = null }
  get textContent() { return this.data }
  // ★ 真实 DOM 的 Text 节点有 parentElement；桩里漏了它，`node.parentElement.closest(…)`
  //   就会静默变成 `undefined` ⇒ 跳过 pre/code 的那一判断永远不生效（测试假绿/假红都由此而来）。
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null }
}
class ENode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = String(tag).toUpperCase()
    this.childNodes = []; this.parentNode = null; this.attrs = {}; this.className = ''; this.style = {}
  }
  insertBefore(n, ref) {
    const list = n.nodeType === 11 ? n.childNodes.slice() : [n]
    let at = ref ? this.childNodes.indexOf(ref) : -1
    if (at < 0) at = this.childNodes.length
    for (let k = 0; k < list.length; k++) {
      const c = list[k]
      c.parentNode = this
      this.childNodes.splice(at + k, 0, c)
    }
    if (n.nodeType === 11) n.childNodes.length = 0
    return n
  }
  appendChild(n) { return this.insertBefore(n, null) }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
  get nextSibling() {
    const p = this.parentNode
    if (!p) return null
    const i = p.childNodes.indexOf(this)
    return p.childNodes[i + 1] || null
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join('') }
  // ★ 必须是**真的 TNode**：早先版本推的是纯对象 `{nodeType:3,data}`，它没有 textContent，
  //   于是 getter 拼出来是 ''，测试会把「桩的缺陷」误报成「产品丢了文字」。
  set textContent(v) { this.childNodes = [new TNode(v)]; this.childNodes[0].parentNode = this }
  querySelectorAll(sel) {
    const out = []
    const cls = sel.startsWith('.') ? sel.slice(1) : null
    const mAttr = /^\[([\w-]+)="?([^"\]]*)"?\]$/.exec(sel)
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue
        if (cls && String(c.className).split(/\s+/).includes(cls)) out.push(c)
        else if (mAttr && c.getAttribute(mAttr[1]) === mAttr[2]) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  /** 只够判「祖先里有没有 pre/code」——`collectRawTextRuns` 用的就是 closest。 */
  closest(sel) {
    const want = sel.split(',').map((s) => s.trim().toUpperCase())
    let n = this
    while (n && n.nodeType === 1) {
      if (want.includes(n.tagName)) return n
      n = n.parentNode
    }
    return null
  }
  /** 极简 TreeWalker：只支持 SHOW_TEXT 的前序遍历。 */
  createTreeWalker() { return makeWalker(this) }
  get ownerDocument() { return doc }
}
/** 前序遍历取文本节点（与 DOM 的 SHOW_TEXT 顺序一致）。 */
function makeWalker(root) {
  const list = []
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) list.push(c)
      else if (c.nodeType === 1) walk(c)
    }
  }
  walk(root)
  let i = 0
  return { nextNode: () => (i < list.length ? list[i++] : null) }
}
class Frag {
  constructor() { this.nodeType = 11; this.childNodes = [] }
  appendChild(n) {
    const list = n.nodeType === 11 ? n.childNodes.slice() : [n]
    for (const c of list) this.childNodes.push(c)
    if (n.nodeType === 11) n.childNodes.length = 0
    return n
  }
}
const doc = {
  createTextNode: (d) => new TNode(d),
  createElement: (t) => new ENode(t),
  createDocumentFragment: () => new Frag(),
  // `collectRawTextRuns` 走的是 `doc.createTreeWalker(root, 4, …)`
  createTreeWalker: (root) => makeWalker(root),
}

/** 把四个函数装进干净沙箱（正则声明从源码逐字取，不在测试里抄一份）。 */
function loadRenderer() {
  const decls = ['RAW_TAG_RE', 'RAW_TAG_TEST', 'RAW_BLOCK_RE']
    .map((n) => {
      const line = BUNDLE.split('\n').find((x) => x.includes('var ' + n + ' ='))
      assert.ok(line, '★ 找不到声明 var ' + n)
      return line.trim()
    }).join('\n')
  const box = { document: doc, console }
  vm.createContext(box)
  vm.runInContext([
    decls,
    extractFn(BUNDLE, 'function splitRawTagSegments('),
    extractFn(BUNDLE, 'function buildRawTagNodes('),
    extractFn(BUNDLE, 'function findRawTagBlocks('),
    extractFn(BUNDLE, 'function applyRawTagBlock('),
    extractFn(BUNDLE, 'function collectRawTextRuns('),
    'this.__find = findRawTagBlocks; this.__apply = applyRawTagBlock; this.__runs = collectRawTextRuns;',
  ].join('\n'), box)
  return { find: box.__find, apply: box.__apply, runs: box.__runs }
}

/** 按 DSH 的形态搭一条消息：每行一个 `<p>`，标签被拆散。 */
function buildMessage(lines) {
  const root = new ENode('div')
  root.className = '_markdown_test_1'
  for (const l of lines) {
    const p = new ENode('p')
    p.appendChild(new TNode(l))
    root.appendChild(p)
  }
  return root
}

/** 收集全部文本节点 + 拼成一段（与 `renderRawTagBlocks` 同口径：节点间用 '\n'）。 */
function joinText(root) {
  const nodes = []
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) nodes.push(c)
      else if (c.nodeType === 1) walk(c)
    }
  }
  walk(root)
  let joined = ''
  const map = []
  for (let i = 0; i < nodes.length; i++) {
    const d = String(nodes[i].data)
    if (i) joined += '\n'
    map.push({ node: nodes[i], start: joined.length, end: joined.length + d.length })
    joined += d
  }
  return { joined, map }
}

const LINES = [
  '男人在公共原木长餐桌上严格执行她的哀求。',
  '<details>',
  '<summary>折叠标题甲</summary>',
  '喵呜~ 这下场面完全铺开了喵！',
  '</details>',
  '<options>',
  '<option>选项甲：嘴里嚼着那截温热脆嫩的软骨。</option>',
  '<option>选项乙：将咬下来的断趾吐在餐盘正中央。</option>',
  '<option>选项丙：伸手按住她因剧痛而抽搐的双腿。</option>',
  '</options>',
]

test('① 拆散的 <details> 渲染出正确标题与正文（不是「展开查看」）', () => {
  const { find, apply } = loadRenderer()
  const root = buildMessage(LINES)
  const { joined, map } = joinText(root)
  const blocks = find(joined)
  assert.equal(blocks.length, 2, '应当只认出 2 个块（details + options），实际 ' + blocks.length)
  for (let i = blocks.length - 1; i >= 0; i--) apply(map, blocks[i], joined)

  const folds = root.querySelectorAll('[data-tavern-raw-block="fold"]')
  assert.equal(folds.length, 1, '应当有 1 个折叠块')
  const det = folds[0]
  const summary = det.childNodes.filter((c) => c.nodeType === 1).find((c) => c.tagName === 'SUMMARY')
  assert.ok(summary, '折叠块必须有 summary')
  assert.equal(summary.textContent, '折叠标题甲',
    '★ 标题必须取自 <summary>；退化成「展开查看」就说明标题和它不在同一个文本节点里')
  assert.match(det.textContent, /完全铺开了喵/, '折叠块正文必须保留')
})

test('② 拆散的 <options> 渲染出全部 3 个选项，文字完整、data-opt 正确', () => {
  const { find, apply } = loadRenderer()
  const root = buildMessage(LINES)
  const { joined, map } = joinText(root)
  const blocks = find(joined)
  for (let i = blocks.length - 1; i >= 0; i--) apply(map, blocks[i], joined)

  const btns = root.querySelectorAll('.tavern-option-btn')
  assert.equal(btns.length, 3, '★ 三个 <option> 必须变成三个按钮，实际 ' + btns.length)
  assert.match(btns[0].getAttribute('data-opt'), /嘴里嚼着那截温热脆嫩的软骨/,
    '★ data-opt 必须是完整选项；被截断就说明 <option> 和 </option> 不在同一个节点里')
  assert.match(btns[2].getAttribute('data-opt'), /按住她因剧痛而抽搐的双腿/)
  for (const b of btns) assert.ok(!b.getAttribute('data-opt').includes('<'), '选项文本不许残留尖括号')
})

test('③ 块外正文（前缀 + 折叠块正文）一个字符都不丢', () => {
  const { find, apply } = loadRenderer()
  const root = buildMessage(LINES)
  const { joined, map } = joinText(root)
  const blocks = find(joined)
  for (let i = blocks.length - 1; i >= 0; i--) apply(map, blocks[i], joined)
  const text = root.textContent
  assert.match(text, /男人在公共原木长餐桌上严格执行她的哀求/, '★ 前缀正文丢了')
  assert.match(text, /完全铺开了喵/, '★ 折叠块正文丢了')
  assert.ok(!/<\/?(?:options?|option|details|summary)\b/i.test(text), '不许残留裸标签')
})

test('④ 被 <options> 包住的 <option> 不算独立块', () => {
  const { find } = loadRenderer()
  const src = '<options>\n<option>甲</option>\n<option>乙</option>\n</options>'
  const blocks = find(src)
  assert.equal(blocks.length, 1, '★ 应该只有 1 个块，实际 ' + blocks.length +
    '（收尾正则写成 <\\/options?> 会让它匹配 </option>，把一个组切成多个块）')
})

test('⑤ 反例：只按单个文本节点切片，同样的 DOM 上块会被切碎', () => {  // 复刻旧实现的判据：每个节点各自 findRawTagBlocks，然后把结果拼接
  const { find } = loadRenderer()
  const root = buildMessage(LINES)
  const { map, joined } = joinText(root)
  const perNode = []
  for (const m of map) {
    const nodeText = String(m.node.data)
    // 注意偏移是**相对这个节点自己的字符串**，不是相对 joined
    for (const b of find(nodeText)) perNode.push({ text: nodeText.slice(b.start, b.end) })
  }

  // 旧写法**不是一块都找不到** —— 每个 `<option>…</option>` 恰好完整落在自己那个 `<p>` 里。
  // 但它切出来的形态是碎的：3 个「各含 1 项的选项组」，`<details>` 则完全认不出。
  const groupSizes = perNode.map((b) => {
    if (/^<details/i.test(b.text)) return 'fold'
    return (b.text.match(/<option\b/gi) || []).length
  })
  assert.ok(!groupSizes.includes('fold'),
    '旧写法认不出 <details>（标题与正文不在同一节点）—— 这正是「标题退化成展开查看」的来源')
  assert.ok(groupSizes.every((g) => g === 1),
    '旧写法把选项切成「每项一组」：' + JSON.stringify(groupSizes))

  // 真实现（拼起来找）：2 块 —— 1 个折叠 + 1 个含 3 项的选项组
  const whole = find(joined)
  assert.equal(whole.length, 2, '★ 真实现必须拿到 2 块')
  const optBlock = whole.map((b) => joined.slice(b.start, b.end)).find((s) => /^<options/i.test(s))
  assert.equal((optBlock.match(/<option\b/gi) || []).length, 3,
    '★ 真实现必须把 3 个 <option> 认成**同一个**组')
})

// ════════════════════════════════════════════════════════════════════════
// ⑥ 代码块里的示例字面量**一个字符都不能动**（2026-11-03 实测事故）
//
// 事故：我在回答里贴了一段讲这个功能的 `js` 代码，代码里写着
//   // 找：<details>…</details> / <options>…</options>
// 旧版收集文本节点时只跳过了 select / textarea，**没跳过 pre / code**
// ⇒ 代码块中间"莫名变成展开查看并且可以交互"，代码本身被吃掉。
// 代码块是给人看的字面量，不是模型输出给渲染器的标签。
// ════════════════════════════════════════════════════════════════════════

test('⑥ 代码块里的 <details>/<options> 字面量不会被渲染', () => {
  const { runs } = loadRenderer()
  const root = buildMessage([
    '前面是正文。',
    '<options>',
    '<option>真选项甲</option>',
    '</options>',
  ])
  // 在块**中间**插一段 <pre>，模拟「正文里夹了代码块」
  const pre = new ENode('pre')
  const code = new ENode('code')
  code.appendChild(new TNode('<details><summary>示例</summary>正文</details>'))
  pre.appendChild(code)
  root.childNodes[1].appendChild(pre)   // 塞进第 2 个 <p>

  const segs = runs(root)
  assert.equal(segs.length, 2, '★ 代码块必须把文本切成两段（不许跨段拼）')
  for (const seg of segs) {
    for (const n of seg) {
      assert.ok(!String(n.data).includes('<details>'),
        '★ 代码块里的 <details> 不许进入可渲染片段')
    }
  }
})

test('⑥-b 代码块两侧的文字不许被拼成一个假块（否则会连代码一起摘掉）', () => {
  const { runs, find } = loadRenderer()
  // `<details>` 在代码块前、`</details>` 在代码块后 —— 拼起来就是"一个完整块"
  const root = buildMessage(['<details>', '<summary>标题</summary>'])
  const pre = new ENode('pre')
  pre.appendChild(new TNode('console.log(1)'))
  root.appendChild(pre)
  const tail = new ENode('p')
  tail.appendChild(new TNode('正文</details>'))
  root.appendChild(tail)

  const segs = runs(root)
  assert.equal(segs.length, 2, '★ 必须切成两段')
  for (const seg of segs) {
    let joined = ''
    const map = []
    for (let i = 0; i < seg.length; i++) {
      const d = String(seg[i].data)
      if (i) joined += '\n'
      map.push({ node: seg[i], start: joined.length, end: joined.length + d.length })
      joined += d
    }
    assert.equal(find(joined).length, 0,
      '★ 单段内不许凑出完整块（凑出来就会把中间的代码块整段摘掉）')
  }
})
