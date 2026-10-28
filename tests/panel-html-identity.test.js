/**
 * 客户端面板身份网（task-25 笔1 + **笔2 改造**）—— 把 `panelHTML` 的**真产物**钉死，
 * 挡住"把函数源码当成产物"这一类错。
 *
 * 为什么需要它（本线程已定性的根因）：
 *   早期求值壳写成 `new Function(seg + '\nreturn panelHTML;')()` **但没调用它** ⇒ 拿到的是**函数对象**，
 *   `String(fn)` 出来是**函数源码**。据此推出的"产物长度 ∈ [段chars−1%, 段chars]"之类判据**全是错的**。
 *   ⇒ 本网只认**真调用**的返回值，并把段 / 产物 / 指纹集合三者的 sha **成对带标签**冻结。
 *
 * ★★ 笔2 改造（迁移 39 行 → 开/闭对基元 `tvRowOpen` / `tvRowClose`）后，本网有**两处必须改**：
 *
 *   ① 段 sha **必然变**：笔2 改的就是段内那 39 行（迁成基元调用 + 段内新增基元表）。
 *      段内**每一个**读数都会变 ⇒ `segment` 那一组（`to` / `lines` / `chars` / `bytes` / `sha` /
 *      `shaWithTrailingNewline`）**整组重测**，旧值 `63f478e4…` 作为**历史锚点**留在 `segmentHistory` 里，
 *      并写明"为什么变（= 迁移本身）"。
 *
 *   ② 指纹来源**必须改成"从历史 blob 现算"**：笔1 的 28 条指纹取自"迁移前那一版段里的字面量"；
 *      迁移后段里**已经没有**那些字面量（它们变成了基元表里的 27 条开标签 + 调用点）⇒
 *      继续"从当前段现算"只会拿到空集，判据**塌成恒真**。
 *      ⇒ 本文件**有意读历史**：`git cat-file blob c1a664c:lib/client.manager.bundle.js`（完整克隆必需；
 *         CI 的 `actions/checkout@v4` 带 `fetch-depth: 0`，浅克隆会在这里**响亮失败**——这是有意的）。
 *      历史那一版段先被**锚定**（`segmentHistory.sha` == 笔1 冻结的 `63f478e4…`），从不锚定就去算指纹。
 *
 *   ③ 由此得到本网最强的一条断言：**历史段的产物 == 当前段的产物**（逐字节）。
 *      它就是"迁移等价"本身 —— 不是"看起来没变"，而是**同一个字符串**。
 *
 * 冻结口径（每个常数都写清"配方 + 复算命令"；复算方 ≥2）：
 *   · 段：needle = `function panelHTML(` **首次出现**的那一行起，到括号配平的收尾 `}`（**含两端**）；
 *        `lines[from-1..to-1].join('\n')`，**无尾随换行**；**原始缩进**（声明在第 4 列）。
 *        带尾随 `\n` 的变体 sha 另一个值 ⇒ 配方必须写死"无尾随换行"。
 *        ★ `from` 是**行号**（会随前面新增的 CSS 规则整体下移）：2.7.21 因 TAVERN_CSS 新增
 *          类名规则而下移 27 行，段内容与产物 sha 均未变（见 `FROZEN.segment` 的 why 注解）。
 *   · 产物：`const fn = new Function(seg + '\nreturn panelHTML;')(); const html = String(fn())` ← **必须真调用**。
 *   · 指纹：**历史段**内**含 `class="t-row"` 的候选行**（39 行，每行 1 个字面量）里那个字面量的**解码值**（按值去重）⇒ N=28。
 *   · 基元：`test ⑨` 直呼 `tvRowOpen` / `tvRowClose`（从当前段里切出来求值），
 *       判据 = 正对照（逐字字节）+ `null` 正例 + 非法 style / 非法缩进 / 表外组合**抛错**（fail-closed）
 *       + 调用点下限 + 改名反证 + **表里的 27 条开标签与历史段逐条相同**。
 *   复算命令：`node _scratch/s3b/b2/measure.mjs`（只读；打印全部读数）
 *
 * 判据自称（每条都配非空跑下限；0 命中即判败，见 ⑧）：
 *   ① 产物**不得**含 `function panelHTML(`（唯一能一键识破"源码当产物"）——**配反向夹具**（喂 `String(fn)` 必须红）
 *   ② 产物必须以 `<div id="tavern-manager">` 开头
 *   ③ 计数：`data-tv-tab=` 12 · `class="t-row"` 产物里 37（2.7.21 裁剪前 39） · **历史段**字面量 39 / 解码值去重 28（口径分开写）
 *   ④ 指纹 **28/28 逐条命中**、逐条命中次数、集合 sha（配方A）、下限先测量再写死
 *   ⑤ 真产物 sha 与段 sha **分开标签**断言；历史段 sha **单独锚定**
 *   ⑥ 闭包：段里 `panelHTML` 的自由标识符集合（用仓里 `routes-deps-scope` 那套口径，**源码切片取用**，
 *       不 import 另一个 `.test.js`）—— 实测为**空集** ⇒ 该函数**自包含**、可独立求值；并配"插一个未声明名
 *       ⇒ 必须点名"的自证（证明判据真看见了它，不是恒真）
 *
 * 本机无法验证（诚实清单）：
 *   · 没有浏览器 ⇒ **不做**"逐像素/渲染等价"的声称；本网钉的是**字符串产物**（panelHTML() 的返回值），
 *     它不需要 DOM（实测在纯 node 进程里可求值）。
 *   · CSS 生效、点击行为、页签引擎的实际渲染不在本网范围内（分别由 style-budget / panel-tabs / 客户端夹具覆盖）。
 *   · 基元判据覆盖的是"发射的字节"与"闭集拒绝"，**不**覆盖 primitive 在真浏览器里的执行时序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRowOpenTable } from '../tools/check-client-integrity.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(REPO, 'lib', 'client.manager.bundle.js')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/** 历史锚点：笔2 迁移**之前**的那一版（笔1 冻结指纹时用的就是它）。 */
export const HIST_REV = 'c1a664c'
export const HIST_PATH = 'lib/client.manager.bundle.js'

/** 冻结常数（成对带标签；**段 sha / 历史段 sha / 产物 sha 三者分开**）。 */
export const FROZEN = {
  /** ★ 笔2 之后重测的一组：`to`/`lines`/`chars`/`bytes`/`sha`/`shaWithTrailingNewline` **都变了**（不是只改 sha）。 */
  segment: {
    // ★ 2026-10-28（2.7.21 按钮体检）：`from`/`to` 再变一次 —— 这一笔**真的改了 panelHTML**：
    //   删掉「🎯 生效范围」三个失效按钮 + 两个名单、删掉「📦 上下文压缩」块、删掉「✅ 保存并关闭」，
    //   并把仍然生效的「世界书注入量」单独成卡（原卡片改名）。段/产物 sha 全部随之变化是**预期**。
    //   与上一笔（只在 TAVERN_CSS 加类名、段内一字节未动）的区别：这次 `product` 变了。
    // ★ 同日（2.7.22 导出功能）：新增「📤 导出」卡片 ⇒ 段 +26 行、产物 +1487 字符，再次重冻。
    from: 567,
    to: 1112,
    lines: 546,
    chars: 43067,
    bytes: 51450,
    sha: 'd7c38a249b069ae8b7528735d7e64315072163a7a20ee22e571124c5fba69e69',
    shaWithTrailingNewline: '2348cacd96bb7b78f9f93a0b8e70fc469ee88fe67a2a2bac6b00c43058b44e45',
  },
  /** ★ 历史锚点（笔1 冻结的那一版段）。本判据**有意读历史**，理由见文件头 ②。 */
  segmentHistory: {
    rev: HIST_REV,
    file: HIST_PATH,
    from: 540,
    to: 1022,
    lines: 483,
    chars: 38209,
    bytes: 45543,
    sha: '63f478e455259555d9de3e7f3345afa9e640ed9a954ef6c6e064d4fa2918342f',
    shaWithTrailingNewline: 'c4d717c118aaf43135658898e55ee3465bf6044405c45c1a2fe28bbeb375f99b',
    whyChanged: '笔2 把那 39 行迁成开/闭对基元（段内新增基元表 + 调用点）⇒ 段本身的字节必然变；'
      + '当时产物**逐字节不变**（本网 test ⑩ 曾据此断言"迁移等价"）。'
      + '2.7.21 起 panelHTML 被**有意**改动（按钮体检删掉失效控件）⇒ 历史段产物与当前产物不再相等，'
      + 'test ⑩ 因此降级为「历史产物锚点」，理由见该测试正文。',
    whyReadHistory: '笔1 冻结的 28 条指纹取自"迁移前那一版段"的字面量；迁移后段里已没有这些字面量，'
      + '继续从当前段现算只会得到空集（判据塌成恒真）⇒ 只能从历史 blob 现算。',
  },
  product: {
    chars: 29035,
    bytes: 32491,
    sha: '1b678442ad33202d090404df2c691379231259ad63caea95a701c888e9f0ea8f',
  },
  /**
   * ★ 历史段产物的锚点（笔1/笔2 那一版 panelHTML 的产物）。
   * 2.7.21 之前它同时是「当前产物」（test ⑩ 断言两者逐字节相等）；
   * 按钮体检有意改了 markup 之后，它只作为**历史侧不可漂移**的锚点保留。
   */
  historicalProduct: {
    chars: 29482,
    bytes: 32798,
    sha: 'a4190e7545ccaae8196e258ebd615c2cc9b2b9ff7aa1702781520f0557bd418f',
  },
  /** ★ 作废组：这是 `String(fn)`（函数源码串化，壳没调用）——**只作反向夹具**，任何判据都不许用它当基准。 */
  deprecatedWrongShell: {
    chars: 43063,
    bytes: 51446,
    sha: 'dff44c74df532f6d8e3a58952414bf794559db967bfb91dbdfba6f123c21d49d',
    why: '函数源码的串化（非产物）；据此得出的长度类判据一并退役',
    whyChanged: '它由**当前**函数源码算出 ⇒ 段一改它就跟着变（笔1 时 38205/45539/71f796c0…、'
      + '笔2 时 42911/50623/6ed36cf9…、2.7.21 按钮体检后 41055/48844/32b6a645…、'
      + '2.7.22 加导出卡后 43063/51446/dff44c74…）。它是**反向夹具**，不是产物断言。',
  },
  counts: {
    tvTab: 13,             // 产物侧：data-tv-tab=（2.7.22 加「📤 导出」后 12→13）
    productTvRow: 39,      // 产物侧：class="t-row" 出现次数
    tvRowLiteral: 39,      // ★ 历史段侧：含 class="t-row" 的候选行（字面量条数）
    tvRowDistinct: 28,     // ★ 历史段侧：解码值去重数
    segLiterals: 377,      // ★ 历史段侧：段内字面量总数
  },
  fingerprints: {
    N: 28,
    setShaJoinedLf: '40e004bc693e9645567318b1b2aa945dbee91d3eb57046f1ccef2dc33509aba2',
    setShaJson: '2a317069eff930261e019eb8f67d3382547cb6b86ffbc545444269ba2fc92327',
    hitCountsSorted: [1, 1, 1, 1, 2, 1, 1, 0, 6, 1, 1, 1, 2, 4, 1, 1, 1, 2, 1, 1, 2, 2, 1, 2, 1, 1, 1, 2],
    hitSum: 42,
    zeroHits: 1,
    /**
     * 0 命中的指纹**必须在这里登记理由**：删掉一处 markup 就会让某条历史开标签彻底消失。
     * 未登记的 0 命中仍然判红（判据没有变成"随便 0 都行"）。
     */
    retired: [
      {
        value: '    <div class="t-row" style="margin-top:4px;gap:var(--tv-space-sm);align-items:center">',
        why: '2.7.21 删除「🎯 生效范围」卡片里的世界书注入量那一行时，这是它唯一的使用点；'
          + '同功能的控件已单独成卡（新行用了另一种 style 组合，见 primitives.addedOpenTags）。',
      },
    ],
    /** 读数的范围（`[min, max]`）—— 只作诊断口径，逐条次数以 `hitCountsSorted` 为准。 */
    hitRange: [0, 6],
    /** 指纹的**来源**（机器可读的那一句；防后人把来源改回当前段）。 */
    source: 'history:' + HIST_REV + ':' + HIST_PATH,
  },
  closure: { shiftedSha: '60b8899dcd3d7ea47fcbd29e7b7f655f5e1f588503c1d4a2d9427f344ff0734d', free: [] },
  /** 笔2 基元的形态读数（`test ⑨` 逐条断言）。 */
  primitives: {
    openCallSites: 39,     // `tvRowOpen(<数字>, …)` 调用点（2.7.22 加导出卡 +2）
    closeCallSites: 2,     // `tvRowClose()` 调用点（两个 complete-row 各 1 处）
    distinctOpenTags: 28,  // 表里能发出的开标签（= 迁移前 27 + 2.7.21 新增的 1 条）
    indents: [2, 4, 6, 8],
    styles: 25,            // 非 null 的 style 值（2.7.21：新增 1 条 `margin-top:6px;gap:…;align-items:center`）
    histogramByIndent: { 2: 3, 4: 19, 6: 5, 8: 1 },
    /** 迁移之后**新增**的开标签（必须逐条登记理由；⑨-e 会单独核这份名单）。 */
    addedOpenTags: [
      {
        value: '    <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm);align-items:center">',
        why: '2.7.21「📚 世界书注入量」独立成卡时的单控件行（原「生效范围」卡里的那一行已删除）。',
      },
    ],
  },
}

/** 非空跑下限（先测量再写死 ⇒ 见文件头"复算命令"）。 */
export const FLOORS = {
  segmentBytes: 40000,
  productChars: 25000,
  tvTab: 10,
  tvRowLiteral: 30,
  tvRowDistinct: 20,
  fingerprintN: 20,
  hitSum: 35,
  segLiterals: 300,
  openCallSites: 30,
  closeCallSites: 2,
  distinctOpenTags: 20,
}

// ════════════════════════════════════════════════════════════════════
// 解码器：**与 `tests/slice-anchors.test.js` 共用同一份实现**（task-28）
//   · 原先两处**逐字各抄一份** ⇒ 修一处漏一处就让两边对同一字面量**静默分叉**。
//   · 仍**不** import 那个 `.test.js` —— 会把对方的 `test(...)` 注册进本进程、在 harness 路径上炸（实测过）。
//   · 抽到 `tests/_helpers/string-literal.mjs`（纯函数，无 `node:test` 依赖）后，两边都可安全 import。
//   · 本文件仍 **re-export** 这两个名字，保持既有导出面不变。
// ★ 必须 **先 import 再 re-export**（不能只写 `export { … } from`）—— 名字不进本模块作用域，
//   本文件里对 `scanStringLiteral` 的**直接调用**会 `ReferenceError`（本笔实测踩到）。
import { decodeEscapes, scanStringLiteral } from './_helpers/string-literal.mjs'
export { decodeEscapes, scanStringLiteral }
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// 段提取 / 求值 / 判据（全部纯函数，便于反证喂坏样本）
// ════════════════════════════════════════════════════════════════════

/** 配方：needle 首次出现的那行起，到括号配平的收尾 `}`（含两端）；`join('\n')`、**无尾随换行**。 */
export function extractSegment(src) {
  const lines = String(src).split('\n')
  const from = lines.findIndex((l) => l.includes('function panelHTML('))
  if (from < 0) throw new Error('段提取失败：找不到 `function panelHTML(`')
  let to = -1
  let depth = 0
  let begun = false
  for (let i = from; i < lines.length; i++) {
    for (const c of lines[i]) {
      if (c === '{') { depth++; begun = true } else if (c === '}') depth--
    }
    if (begun && depth <= 0) { to = i; break }
  }
  if (to < 0) throw new Error('段提取失败：括号没配平')
  return { seg: lines.slice(from, to + 1).join('\n'), from: from + 1, to: to + 1, lineCount: to - from + 1 }
}

/** 求值壳（★ 必须**真调用**）：`new Function(seg + '\nreturn panelHTML;')()` 拿到函数，再 `fn()` 拿产物。 */
export function evaluateProduct(seg) {
  const fn = new Function(seg + '\nreturn panelHTML;')()
  return { fn, product: String(fn()) }
}

/** 把段按**声明自身的缩进**整体左移（闭包判据要求 `function …` 顶格；否则它一条都看不见 = 恒真）。 */
export function deindentByDecl(seg) {
  const lines = String(seg).split('\n')
  const indent = (lines[0].match(/^[ \t]*/) || [''])[0].length
  const pad = ' '.repeat(indent)
  return lines.map((l) => (l.startsWith(pad) ? l.slice(indent) : l)).join('\n')
}

/**
 * 产物判据（① ② 的纯函数形态）：返回问题清单（空 = 通过）。
 * `product` = 真调用得到的字符串；`wrongShell` 只用于反向夹具（可不传）。
 */
export function productProblems(product) {
  const p = String(product)
  const out = []
  if (p.includes('function panelHTML(')) {
    out.push('★ 产物里出现了 `function panelHTML(` —— 这几乎必然是"把**函数源码**当成产物"（求值壳没调用函数）')
  }
  if (!p.startsWith('<div id="tavern-manager">')) {
    out.push('★ 产物没有以 `<div id="tavern-manager">` 开头（实际开头：' + JSON.stringify(p.slice(0, 40)) + '）')
  }
  return out
}

/** 指纹：段内含 `class="t-row"` 的候选行里的那个字面量，取**解码值**，按值去重（默认 sort）。 */
export function fingerprintSet(seg) {
  const lines = String(seg).split('\n')
  const candidates = []
  let segLiterals = 0
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    for (let k = 0; k < t.length; k++) {
      if (t[k] !== "'" && t[k] !== '"' && t[k] !== '`') continue
      const lit = scanStringLiteral(t, k)
      if (!lit) continue
      segLiterals++
      if (lit.value.includes('class="t-row"')) candidates.push({ line: i + 1, value: lit.value })
      k = lit.end - 1
    }
  }
  const values = [...new Set(candidates.map((c) => c.value))].sort()
  return {
    candidates,
    segLiterals,
    values,
    N: values.length,
    setShaJoinedLf: sha256(values.join('\n')),
    setShaJson: sha256(JSON.stringify(values)),
  }
}

/** 逐条命中报告（**逐条**给次数，0 的也要看得见）。 */
export function hitReport(product, values) {
  return values.map((v) => ({ value: v, n: String(product).split(v).length - 1 }))
}

/** 闭包判据：**按源码切片**取 `tests/routes-deps-scope.test.js` 的实现（不 import 那个 .test.js）。 */
export function loadClosureJudge() {
  const file = path.join(REPO, 'tests', 'routes-deps-scope.test.js')
  const src = fs.readFileSync(file, 'utf8')
  const from = src.indexOf('const KEYWORDS = new Set(')
  const at = src.indexOf('export function unresolvedIdentifiers(src) {')
  if (from < 0 || at < 0) {
    throw new Error('闭包判据取用失败：`tests/routes-deps-scope.test.js` 里找不到 KEYWORDS / unresolvedIdentifiers（改名了？）')
  }
  let end = -1
  let depth = 0
  let begun = false
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { depth++; begun = true } else if (c === '}') { depth--; if (begun && depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error('闭包判据取用失败：unresolvedIdentifiers 括号没配平')
  const impl = src.slice(from, end + 1).replace(/^export /gm, '')
  try {
    return new Function(impl + '\nreturn unresolvedIdentifiers;')()
  } catch (e) {
    throw new Error('闭包判据取用失败（切出来的实现不能求值）：' + String(e && e.message))
  }
}

// ════════════════════════════════════════════════════════════════════
// 基元切片（`test ⑨` 用）：把 `TV_ROW_OPEN` 表 + 两个基元从段里切出来直接求值。
//   为什么切片而不是 import：它们**声明在 panelHTML 体内**（这是刻意的 —— 段必须自包含，
//   见 test ⑦ 的闭包判据），外层拿不到，只能按源码切。
// ════════════════════════════════════════════════════════════════════
export function extractPrimitiveBlock(seg) {
  const lines = String(seg).split('\n')
  const from = lines.findIndex((l) => l.includes('var TV_ROW_OPEN'))
  if (from < 0) throw new Error('找不到基元表 `TV_ROW_OPEN`（被删/改名？基元判据会因此失效）')
  let to = -1
  for (let i = from; i < lines.length; i++) {
    if (lines[i].includes('function tvRowClose(')) { to = i; break }
  }
  if (to < 0) throw new Error('找不到 `function tvRowClose(`（被删/改名？）')
  return lines.slice(from, to + 1).join('\n')
}

/** 求值切出来的基元块 ⇒ `{tvRowOpen, tvRowClose}`。 */
export function evalPrimitiveBlock(block) {
  return new Function(block + '\nreturn { tvRowOpen: tvRowOpen, tvRowClose: tvRowClose };')()
}

/** 调用点计数（**减去声明处那一次函数名**）：只认调用形态，声明行不算。 */
export function countOpenCallSites(src) {
  const s = String(src)
  return (s.match(/tvRowOpen\(/g) || []).length - (s.match(/function tvRowOpen\(/g) || []).length
}
export function countCloseCallSites(src) {
  const s = String(src)
  return (s.match(/tvRowClose\(\s*\)/g) || []).length - (s.match(/function tvRowClose\(\s*\)/g) || []).length
}

// ════════════════════════════════════════════════════════════════════
// 读数（模块加载时算一次）
//   ★ 行尾口径：读入后**把 CRLF 归一成 LF** 再算一切。
//     理由（实测，不是预防性猜测）：本仓 `core.autocrlf=true` ⇒ 同一个 blob 在**干净 clone / CI** 里
//     会检成 CRLF，而本机工作树是 LF。不归一的话，段字节数会多出"每行 1 个 CR" ⇒ 段/产物 sha 全变
//     ⇒ **在克隆里假红**。bundle 在仓库里的约定行尾是 LF（AGENTS §7.4），所以归一是"回到 blob 形态"。
//   ★ 历史 blob 同理归一；它**先被锚定**（test ②），所以"归一化写错了"不会静默 —— 锚定会当场红。
// ════════════════════════════════════════════════════════════════════
const RAW = fs.readFileSync(BUNDLE, 'utf8')
const SRC = RAW.replace(/\r\n/g, '\n')
const EOL_NORMALIZED = RAW !== SRC
const SEG = extractSegment(SRC)
const { fn, product } = evaluateProduct(SEG.seg)

/** ★ 有意读历史（见文件头 ②）：读不到就**响亮失败**，绝不 skip、绝不回退成"从当前段现算"。 */
export function readHistoryBundle() {
  // ★ 2026-10-22：历史重写后 c1a664c 在新克隆里不存在。历史那一版 bundle 以夹具文件
  //   提交在 tests/fixtures/panel-html-bundle.c1a664c.js（与旧 blob 逐字节相同，
  //   git hash-object = f057d4b1…）。夹具存在就读夹具；不存在才回退 git；
  //   两者都没有仍然响亮失败（绝不 skip）。
  const fixture = path.join(REPO, 'tests', 'fixtures', 'panel-html-bundle.c1a664c.js')
  try {
    if (fs.existsSync(fixture)) return fs.readFileSync(fixture, 'utf8').replace(/\r\n/g, '\n')
  } catch (_) {}
  const spec = FROZEN.segmentHistory.rev + ':' + FROZEN.segmentHistory.file
  const r = spawnSync('git', ['cat-file', 'blob', spec], { cwd: REPO, maxBuffer: 1 << 28 })
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    throw new Error(
      '★ 历史 blob 读不到：`git cat-file blob ' + spec + '` 退出码 ' + r.status +
      (r.stderr ? ' / stderr: ' + String(r.stderr).trim().slice(0, 300) : '') + '\n' +
      '  本判据**有意读历史**：笔1 冻结的 28 条指纹取自考据「迁移前那一版段」的字面量；\n' +
      '  迁移后当前段里已经没有这些字面量 ⇒ 回退成"从当前段现算"会拿到空集、判据塌成恒真。\n' +
      '  处置：用**完整克隆**（CI 的 actions/checkout@v4 带 fetch-depth: 0；浅克隆会在这一行响亮失败，这是有意的）。')
  }
  return r.stdout.toString('utf8').replace(/\r\n/g, '\n')
}
/**
 * ★ 历史段夹具（2026-10-22 起的主路径）：只提交 panelHTML 那一段 + 元数据
 *   （`tests/fixtures/panel-html-segment.c1a664c.json`，约 47 KB），
 *   不再提交整份 488 KB 的历史 bundle。段文本与旧 blob 里逐字节相同，
 *   `sha` 仍等于笔1 冻结的 `63f478e4…`。
 */
export function readHistorySegment() {
  const fixture = path.join(REPO, 'tests', 'fixtures', 'panel-html-segment.c1a664c.json')
  try {
    if (fs.existsSync(fixture)) {
      const j = JSON.parse(fs.readFileSync(fixture, 'utf8'))
      return { seg: String(j.segment).replace(/\r\n/g, '\n'), from: j.from, to: j.to, lineCount: j.lines }
    }
  } catch (_) {}
  return extractSegment(readHistoryBundle())
}
const HIST_SEG = readHistorySegment()
const FP_HIST = fingerprintSet(HIST_SEG.seg)
const HITS = hitReport(product, FP_HIST.values)
const { product: HIST_PRODUCT } = evaluateProduct(HIST_SEG.seg)
const PRIM = evalPrimitiveBlock(extractPrimitiveBlock(SEG.seg))

test('① 段常数：行区间 / 行数 / 字节 / sha（配方写死"无尾随换行"）', (t) => {
  t.diagnostic('行尾口径：本机读到 ' + (EOL_NORMALIZED ? 'CRLF（已归一成 LF）' : 'LF（无需归一）') + ' —— 归一后所有读数与冻结值可比')
  t.diagnostic('段 L' + SEG.from + '–' + SEG.to + ' · ' + SEG.lineCount + ' 行 · ' + SEG.seg.length + ' chars · ' +
    Buffer.byteLength(SEG.seg, 'utf8') + ' 字节 · sha ' + sha256(SEG.seg))
  assert.equal(SEG.from, FROZEN.segment.from, '段起点漂了')
  assert.equal(SEG.to, FROZEN.segment.to, '段终点漂了')
  assert.equal(SEG.lineCount, FROZEN.segment.lines, '段行数漂了')
  assert.equal(Buffer.byteLength(SEG.seg, 'utf8'), FROZEN.segment.bytes, '段字节数漂了')
  assert.equal(sha256(SEG.seg), FROZEN.segment.sha, '★ 段 sha 变了（配方：lines[539..].join("\\n")，无尾随换行）')
  // 配方自证：带尾随换行的变体必须得到**另一个** sha（否则"无尾随换行"这条写死就没意义）
  assert.equal(sha256(SEG.seg + '\n'), FROZEN.segment.shaWithTrailingNewline, '带尾随换行的变体 sha 对不上')
  assert.notEqual(sha256(SEG.seg + '\n'), FROZEN.segment.sha, '★ 两种 join 得到同一 sha ⇒ 配方没写死')
  assert.ok(Buffer.byteLength(SEG.seg, 'utf8') >= FLOORS.segmentBytes, '段字节数低于下限 —— 判据空跑')
})

test('② ★ 历史段锚点：**有意读历史**，且读到的必须是笔1 冻结的那一版（只认 sha）', (t) => {
  t.diagnostic('历史源：git cat-file blob ' + FROZEN.segmentHistory.rev + ':' + FROZEN.segmentHistory.file +
    ' → L' + HIST_SEG.from + '–' + HIST_SEG.to + ' · ' + HIST_SEG.lineCount + ' 行 · ' + HIST_SEG.seg.length + ' chars · sha ' + sha256(HIST_SEG.seg))
  t.diagnostic('为什么要读历史：' + FROZEN.segmentHistory.whyReadHistory)
  t.diagnostic('段为什么变：' + FROZEN.segmentHistory.whyChanged)
  assert.equal(HIST_SEG.from, FROZEN.segmentHistory.from, '历史段起点对不上 —— 读到的是别的一版？')
  assert.equal(HIST_SEG.to, FROZEN.segmentHistory.to, '历史段终点对不上 —— 读到的是别的一版？')
  assert.equal(HIST_SEG.lineCount, FROZEN.segmentHistory.lines, '历史段行数对不上')
  assert.equal(Buffer.byteLength(HIST_SEG.seg, 'utf8'), FROZEN.segmentHistory.bytes, '历史段字节数对不上')
  // ★ 这一条是"能不能信任历史读数"的锚：历史段 sha 必须等于笔1 冻结值（= 迁移前那一版）
  assert.equal(sha256(HIST_SEG.seg), FROZEN.segmentHistory.sha,
    '★ 历史段 sha 与笔1 冻结值不符 —— 要么锚点被改（c1a664c 不该动），要么归一化/提取配方被改。' +
    '历史读数不可信时，后面 28/28 的命中判据全部作废。')
  assert.equal(sha256(HIST_SEG.seg + '\n'), FROZEN.segmentHistory.shaWithTrailingNewline, '历史段"带尾随换行"变体 sha 对不上')
  assert.notEqual(sha256(HIST_SEG.seg), FROZEN.segment.sha, '★ 历史段 sha 与当前段 sha 相同 ⇒ 迁移其实没生效（判据在自欺）')
})

test('③ 真产物：必须**真调用**（`fn()`），不是 `String(fn)`', (t) => {
  t.diagnostic('产物 ' + product.length + ' chars · ' + Buffer.byteLength(product, 'utf8') + ' bytes · sha ' + sha256(product))
  t.diagnostic('对照（作废组）String(fn) = ' + String(fn).length + ' chars · sha ' + sha256(String(fn)))
  t.diagnostic('作废组为什么变：' + FROZEN.deprecatedWrongShell.whyChanged)
  assert.equal(product.length, FROZEN.product.chars, '产物 chars 漂了')
  assert.equal(Buffer.byteLength(product, 'utf8'), FROZEN.product.bytes, '产物 bytes 漂了')
  assert.equal(sha256(product), FROZEN.product.sha, '★ 真产物 sha 变了（= 面板 markup 变了；先确认是不是有意的）')
  assert.ok(product.length >= FLOORS.productChars, '产物长度低于下限 —— 判据空跑')
  // ★ 真产物 ≠ 作废组（两个口径必须分得开）
  assert.notEqual(sha256(product), FROZEN.deprecatedWrongShell.sha, '★ 产物 sha 等于"函数源码串化"那组 —— 求值壳退化了（没调用函数？）')
  assert.notEqual(product.length, FROZEN.deprecatedWrongShell.chars, '★ 产物长度等于作废组 —— 同上')
})

test('④ ③的反向夹具：喂 `String(fn)`（源码串化）⇒ 判据必须红，且点名', () => {
  const wrongShell = String(fn)
  // 正样本（真产物）必须通过
  assert.deepEqual(productProblems(product), [], '真产物不该被 ① 拦下')
  // 反向夹具：作废组的产物必须被拦下并点名
  const bad = productProblems(wrongShell)
  assert.equal(bad.length, 2, '反向夹具必须报 2 条（含函数源码 + 开头不对），实际 ' + JSON.stringify(bad))
  assert.match(bad[0], /function panelHTML\(/, '① 必须点名"产物里出现了函数源码"')
  assert.match(bad[0], /求值壳没调用函数/, '① 的报错要说清病因')
  // 反向夹具的读数也要对得上作废组（证明喂进去的确实是那一类）
  assert.equal(wrongShell.length, FROZEN.deprecatedWrongShell.chars, '反向夹具长度与作废组不符')
  assert.equal(sha256(wrongShell), FROZEN.deprecatedWrongShell.sha, '反向夹具 sha 与作废组不符')
  assert.ok(wrongShell.includes('function panelHTML('), '反向夹具必须真的含函数源码')
})

test('⑤ 产物开头 / 计数（产物侧与历史段侧**两个口径分开写**）', (t) => {
  assert.deepEqual(productProblems(product), [], '产物必须以 <div id="tavern-manager"> 开头')
  const tvTab = (product.match(/data-tv-tab=/g) || []).length
  const tvRowLiteral = (product.match(/class="t-row"/g) || []).length
  t.diagnostic('产物侧：data-tv-tab=' + tvTab + ' · class="t-row"=' + tvRowLiteral)
  t.diagnostic('历史段侧（' + FROZEN.fingerprints.source + '）：class="t-row" 字面量=' + FP_HIST.candidates.length +
    ' · 解码值去重=' + FP_HIST.N + ' · 段内字面量总数=' + FP_HIST.segLiterals)
  assert.equal(tvTab, FROZEN.counts.tvTab, 'data-tv-tab 计数漂了')
  assert.equal(tvRowLiteral, FROZEN.counts.productTvRow, '产物里 class="t-row" 出现次数漂了')
  // ★ 两个口径分开写：产物出现次数（39）≠ 字面量条数 ≠ 解码值去重数（28）
  assert.equal(FP_HIST.candidates.length, FROZEN.counts.tvRowLiteral, '历史段内 class="t-row" **字面量条数**漂了')
  assert.equal(FP_HIST.N, FROZEN.counts.tvRowDistinct, '历史段内 class="t-row" **解码值去重数**漂了')
  assert.equal(FP_HIST.segLiterals, FROZEN.counts.segLiterals, '历史段内字面量总数漂了')
  assert.ok(tvTab >= FLOORS.tvTab && tvRowLiteral >= FLOORS.tvRowLiteral && FP_HIST.N >= FLOORS.tvRowDistinct, '计数低于下限 —— 判据空跑')
})

test('⑥ 指纹：**从历史段现算** 28/28 逐条命中 + 逐条次数 + 集合 sha（两套配方）', (t) => {
  t.diagnostic('指纹来源：' + FROZEN.fingerprints.source + '（有意读历史，见 test ②）')
  t.diagnostic('指纹 N=' + FP_HIST.N + ' · 配方A(join "\\n")=' + FP_HIST.setShaJoinedLf + ' · 配方B(JSON.stringify)=' + FP_HIST.setShaJson)
  assert.equal(FP_HIST.N, FROZEN.fingerprints.N, '指纹去重数 N 漂了')
  assert.equal(FP_HIST.setShaJoinedLf, FROZEN.fingerprints.setShaJoinedLf, '★ 指纹集合 sha（配方A：sort + join("\\n") + 无尾随）对不上')
  assert.equal(FP_HIST.setShaJson, FROZEN.fingerprints.setShaJson, '★ 指纹集合 sha（配方B：JSON.stringify）对不上')
  assert.ok(FP_HIST.N >= FLOORS.fingerprintN, 'N 低于下限 —— 判据空跑')
  // 逐条命中（0 的必须看得见）
  const zero = HITS.filter((h) => h.n === 0)
  t.diagnostic('命中分布：' + JSON.stringify(HITS.map((h) => h.n)))
  t.diagnostic('命中范围 [min, max] = [' + Math.min(...HITS.map((h) => h.n)) + ', ' + Math.max(...HITS.map((h) => h.n)) + ']')
  // ★ 2.7.21：panelHTML 被**有意**改动（按钮体检删掉失效控件）⇒ 允许个别历史开标签 0 命中，
  //   但**必须逐条登记在 `fingerprints.retired` 里并写明理由**；未登记的 0 命中照样判红。
  const retired = (FROZEN.fingerprints.retired || []).map((r) => r.value.slice(0, 60)).sort()
  assert.deepEqual(zero.map((h) => h.value.slice(0, 60)).sort(), retired,
    '★ 0 命中的指纹与 `fingerprints.retired` 登记表不一致（新增的 0 命中要在登记表里写明理由）')
  for (const r of FROZEN.fingerprints.retired || []) {
    assert.ok(r.why && r.why.trim(), '退场指纹缺理由：' + r.value.slice(0, 60))
  }
  assert.deepEqual(HITS.map((h) => h.n), FROZEN.fingerprints.hitCountsSorted, '逐条命中次数（按解码值 sort 序）对不上')
  assert.equal(HITS.reduce((a, h) => a + h.n, 0), FROZEN.fingerprints.hitSum, '命中总数对不上')
  assert.equal(zero.length, FROZEN.fingerprints.zeroHits, '0 命中条数对不上')
  assert.deepEqual([Math.min(...HITS.map((h) => h.n)), Math.max(...HITS.map((h) => h.n))], FROZEN.fingerprints.hitRange, '命中范围对不上')
  assert.ok(HITS.reduce((a, h) => a + h.n, 0) >= FLOORS.hitSum, '命中总数低于下限')
  // 自证：把某条指纹改 1 个字符 ⇒ 必须 0 命中（证明"搜得动"，不是恒真）
  const probe = FP_HIST.values[0].replace('t-row', 't-roX')
  assert.equal(product.split(probe).length - 1, 0, '★ 改动 1 字符后仍然命中 ⇒ 搜索恒真')
})

test('⑦ 闭包：panelHTML 的自由标识符集合（左移后；实测空集 = 自包含）', (t) => {
  const shifted = deindentByDecl(SEG.seg)
  t.diagnostic('左移版 sha ' + sha256(shifted) + ' · 首行 ' + JSON.stringify(shifted.split('\n')[0]))
  assert.equal(sha256(shifted), FROZEN.closure.shiftedSha, '左移版 sha 对不上（口径：按声明自身缩进整体左移）')
  assert.match(shifted.split('\n')[0], /^function panelHTML\(/, '★ 左移后声明仍未顶格 ⇒ 闭包判据会一条都看不见（恒真）')
  const unresolved = loadClosureJudge()
  const res = unresolved(shifted)
  const free = res.flatMap((r) => r.free)
  t.diagnostic('闭包结果：' + JSON.stringify(res))
  assert.deepEqual(free, FROZEN.closure.free,
    '★ panelHTML 的自由标识符集合变了（新增了外层依赖？那它就不再能独立求值 —— ' +
    '笔2 的基元**必须声明在函数体内**、且实现不许引入 `Array`/`String`/`Object` 这类自由名）')
  // 自证：插一个未声明名 ⇒ 判据必须点名（证明它真看见了函数本体）
  const spliced = (() => {
    const ls = shifted.split('\n')
    ls.splice(1, 0, '  var zzProbeOuter = zzNotDefinedAnywhere;')
    return ls.join('\n')
  })()
  const sp = unresolved(spliced).flatMap((r) => r.free)
  assert.deepEqual(sp, ['zzNotDefinedAnywhere'], '★ 插入未声明名后判据没点名 ⇒ 闭包判据没真看见函数（恒真）')
  // 对照：原始段（未左移）⇒ 判据看不见（这正是必须左移的原因，写下来免得后人"简化"掉）
  assert.deepEqual(unresolved(SEG.seg), [], '对照组：原始段因缩进而看不见（判据的空集不代表"检查过"）')
})

test('⑧ 非空跑汇总：各桶计数（0 即判败）', (t) => {
  const buckets = {
    段行数: SEG.lineCount,
    段字节: Buffer.byteLength(SEG.seg, 'utf8'),
    历史段字节: Buffer.byteLength(HIST_SEG.seg, 'utf8'),
    产物chars: product.length,
    tvTab: (product.match(/data-tv-tab=/g) || []).length,
    tvRow字面量: FP_HIST.candidates.length,
    指纹N: FP_HIST.N,
    命中总数: HITS.reduce((a, h) => a + h.n, 0),
    段内字面量: FP_HIST.segLiterals,
    tvRowOpen调用点: countOpenCallSites(SEG.seg),
    tvRowClose调用点: countCloseCallSites(SEG.seg),
    基元开标签: Object.keys(PRIM_OPEN_TABLE()).flatMap((k) => Object.keys(PRIM_OPEN_TABLE()[k])).length,
  }
  t.diagnostic('各桶：' + JSON.stringify(buckets))
  for (const [k, v] of Object.entries(buckets)) assert.ok(v > 0, '★ 桶「' + k + '」为 0 —— 判据空跑')
})

/** 表还没被 test ⑨ 读坏时的那一份（读表用工具的同源解析，保证"工具怎么看"与"测试怎么看"一致）。 */
function PRIM_OPEN_TABLE() {
  const r = readRowOpenTable(SEG.seg)
  if (!r.table) throw new Error('基元表解析失败：' + r.why)
  return r.table
}

// ════════════════════════════════════════════════════════════════════
// ⑨ 基元判据（笔2）：无死代码 + 逐字字节 + fail-closed + 改名反证
// ════════════════════════════════════════════════════════════════════
test('⑨-a 调用点：下限先测量再写死（0 即判败），且"改名反证"必须让计数归零', (t) => {
  const open = countOpenCallSites(SEG.seg)
  const close = countCloseCallSites(SEG.seg)
  t.diagnostic('调用点：tvRowOpen=' + open + ' · tvRowClose=' + close + '（下限 ' + FLOORS.openCallSites + ' / ' + FLOORS.closeCallSites + '）')
  assert.equal(open, FROZEN.primitives.openCallSites, 'tvRowOpen 调用点数漂了')
  assert.equal(close, FROZEN.primitives.closeCallSites, 'tvRowClose 调用点数漂了')
  assert.ok(open >= FLOORS.openCallSites, '★ tvRowOpen 调用点低于下限 —— 基元成了死代码（判据空跑）')
  assert.ok(close >= FLOORS.closeCallSites, '★ tvRowClose 调用点低于下限 —— 基元成了死代码')
  // ★ 改名反证：名字改了 ⇒ 计数必须归零（证明计数读的是**真名字**，不是恒真的搜不到）
  const renamed = SEG.seg.replace(/tvRowOpen\(/g, 'tvRowOpenX(')
  assert.equal(countOpenCallSites(renamed), 0, '★ 改名后计数仍非 0 ⇒ 计数判据恒真（它没在读那个名字）')
  assert.equal(countCloseCallSites(SEG.seg.replace(/tvRowClose\(/g, 'tvRowCloseX(')), 0, '★ tvRowClose 改名后计数未归零 ⇒ 同上')
})

test('⑨-b 正对照：发射的字节与迁移前字面量**逐字相同**（含前导缩进），null 走"无 style 属性"', () => {
  // 四个缩进各取一条**真实用过**的组合（闭集是"实际用过的 27 个 (缩进,style) 对"，不是 4×N 的笛卡尔积）
  assert.equal(PRIM.tvRowOpen(2, 'margin-top:10px;align-items:center'), '  <div class="t-row" style="margin-top:10px;align-items:center">')
  assert.equal(PRIM.tvRowOpen(4, 'margin-top:8px'), '    <div class="t-row" style="margin-top:8px">')
  assert.equal(PRIM.tvRowOpen(6, 'margin-top:6px;gap:var(--tv-space-sm);flex-wrap:wrap'), '      <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm);flex-wrap:wrap">')
  assert.equal(PRIM.tvRowOpen(8, 'margin-top:6px'), '        <div class="t-row" style="margin-top:6px">')
  // 迁移前唯一没有 style 属性的那一行（L925）——它同时也是"闭集不是笛卡尔积"的证据：只有 (4, null) 合法
  assert.equal(PRIM.tvRowOpen(4, null), '    <div class="t-row">')
  assert.equal(PRIM.tvRowClose(), '</div>')
  assert.throws(() => PRIM.tvRowOpen(2, null), /tvRowOpen/, '★ (2, null) 迁移前没用过 ⇒ 表外组合必须抛错')
})

test('⑨-c fail-closed：非法 style / 原型链成员 / 非法缩进 / 表外组合**当场抛错**', () => {
  for (const bad of ['x")><script>alert(1)</script>', 'toString', 'constructor', '__proto__', '', 'margin-top:8px ']) {
    assert.throws(() => PRIM.tvRowOpen(4, bad), /tvRowOpen/, '★ 非法 style ' + JSON.stringify(bad) + ' 必须抛错（fail-closed）')
  }
  for (const badIndent of [0, 1, 3, 5, 7, 9, -4, 4.5, '4']) {
    assert.throws(() => PRIM.tvRowOpen(badIndent, 'margin-top:6px'), /tvRowOpen/, '★ 非法缩进 ' + JSON.stringify(badIndent) + ' 必须抛错')
  }
  // 合法值但**表外组合**（迁移前没这么用过）同样拒绝 —— 闭集口径是"实际用过的 27 个组合"
  assert.throws(() => PRIM.tvRowOpen(2, 'margin-top:8px'), /tvRowOpen/, '★ 表外组合必须抛错')
  // 正对照：表内组合不抛
  assert.doesNotThrow(() => PRIM.tvRowOpen(4, 'margin-top:6px'))
})

test('⑨-d 回调点是真的：把基元声明改名 ⇒ `panelHTML()` 立刻 ReferenceError', () => {
  const bad = SEG.seg.replace('function tvRowOpen(', 'function tvRowOpenDisplaced(')
  assert.notEqual(bad, SEG.seg, '替换必须真的发生（否则这条反证是假的）')
  assert.throws(() => evaluateProduct(bad), /tvRowOpen/, '★ 声明改名后仍能求值 ⇒ 调用点根本没走这个名字（死代码/复制粘贴）')
  const bad2 = SEG.seg.replace('function tvRowClose(', 'function tvRowCloseDisplaced(')
  assert.notEqual(bad2, SEG.seg, '替换必须真的发生')
  assert.throws(() => evaluateProduct(bad2), /tvRowClose/, '★ tvRowClose 声明改名后仍能求值 ⇒ 同上')
})

test('⑨-e 表 ⊇ 历史段：迁移前的 27 条开标签必须逐条仍在，新增的必须登记', (t) => {
  const table = PRIM_OPEN_TABLE()
  const tableTags = Object.keys(table).flatMap((k) => Object.keys(table[k]).map((s) => table[k][s])).sort()
  const histTags = [...new Set(FP_HIST.values.map((v) => v.slice(0, v.indexOf('>') + 1)))].sort()
  const byIndent = {}
  for (const tag of tableTags) { const p = (tag.match(/^ */) || [''])[0].length; byIndent[p] = (byIndent[p] || 0) + 1 }
  t.diagnostic('表：' + tableTags.length + ' 条开标签 · 按缩进 ' + JSON.stringify(byIndent) +
    ' · distinct style ' + Object.keys(table).flatMap((k) => Object.keys(table[k]).filter((s) => s !== '')).length + '（按缩进展开后）')
  assert.equal(tableTags.length, FROZEN.primitives.distinctOpenTags, '表里的开标签条数漂了')
  assert.ok(tableTags.length >= FLOORS.distinctOpenTags, '开标签条数低于下限 —— 判据空跑')
  // ★ 2.7.21 起口径从「逐条相同」改为「历史 27 条必须全在」+「新增的逐条登记」：
  //   panelHTML 被有意改动后，要求与迁移前完全一致等于禁止一切 UI 变更。
  //   仍然防住的事：**没人可以把历史开标签悄悄改掉/删掉**（差集必须为空）。
  const missing = histTags.filter((tag) => !tableTags.includes(tag))
  assert.deepEqual(missing, [], '★ 迁移前的开标签从表里消失了（产物不再兼容旧字节）：\n' + missing.join('\n'))
  const added = tableTags.filter((tag) => !histTags.includes(tag))
  const declared = (FROZEN.primitives.addedOpenTags || []).map((x) => x.value).sort()
  assert.deepEqual(added.sort(), declared, '新增的开标签必须逐条登记在 `primitives.addedOpenTags` 并写明理由')
  for (const x of FROZEN.primitives.addedOpenTags || []) assert.ok(x.why && x.why.trim(), '新增开标签缺理由：' + x.value.slice(0, 50))
  assert.deepEqual(Object.keys(table).map(Number).sort((a, b) => a - b), FROZEN.primitives.indents, '缩进闭集漂了')
  const styles = new Set(Object.keys(table).flatMap((k) => Object.keys(table[k])).filter((s) => s !== ''))
  assert.equal(styles.size, FROZEN.primitives.styles, '非 null style 种类漂了')
  assert.deepEqual(byIndent, FROZEN.primitives.histogramByIndent, '开标签的缩进直方图漂了')
})

test('⑩ 历史段产物锚点（迁移等价性已于 2.7.21 降级为历史记录）', (t) => {
  t.diagnostic('历史段产物 ' + HIST_PRODUCT.length + ' chars / sha ' + sha256(HIST_PRODUCT))
  t.diagnostic('当前段产物 ' + product.length + ' chars / sha ' + sha256(product))
  // ★ 笔2 时这条断言是「历史产物 == 当前产物（逐字节）」，用来证明"把 39 行迁成基元"零行为变化。
  //   2.7.21 的按钮体检**有意**改了 panelHTML（删掉失效控件）⇒ 两者不可能再相等。
  //   降级后的口径（仍然可验证、且不会自我欺骗）：
  //     · 历史段产物**必须仍是当年那一份**（sha 锚死，历史侧任何漂移都会红）；
  //     · 当前产物由 test ③ 的 sha 锚死（那是现在的口径）；
  //     · 这里只断言"两者确实不同"——若哪天又相等，说明有人把这次裁剪回滚了，需要人来确认。
  assert.equal(sha256(HIST_PRODUCT), FROZEN.historicalProduct.sha, '历史段产物 sha 与冻结值不符（历史侧不可信了）')
  assert.equal(HIST_PRODUCT.length, FROZEN.historicalProduct.chars, '历史段产物 chars 对不上')
  assert.notEqual(HIST_PRODUCT, product,
    '★ 历史产物与当前产物又相等了 —— 若是回滚了 2.7.21 的按钮裁剪，请同步更新两边冻结值并写明理由')
})
