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
 *        `lines[539..].join('\n')`，**无尾随换行**；**原始缩进**（声明在第 4 列）。
 *        带尾随 `\n` 的变体 sha 另一个值 ⇒ 配方必须写死"无尾随换行"。
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
 *   ③ 计数：`data-tv-tab=` 12 · `class="t-row"` 产物里 39 · **历史段**字面量 39 / 解码值去重 28（口径分开写）
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
    from: 540,
    to: 1077,
    lines: 538,
    chars: 42915,
    bytes: 50627,
    sha: '791f41cbb43c391a27c7c4afe94e436853418fe188ab0e1e7ca64d5daa9e7bd8',
    shaWithTrailingNewline: '2bdef72e756950b03d1fdf28e7ed4dcc20607eb0e6e1c62f017cb0e7e86ca172',
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
      + '而产物**逐字节不变**（见 product + test ⑩）——「段变了、产物没变」正是这次迁移的形态。',
    whyReadHistory: '笔1 冻结的 28 条指纹取自"迁移前那一版段"的字面量；迁移后段里已没有这些字面量，'
      + '继续从当前段现算只会得到空集（判据塌成恒真）⇒ 只能从历史 blob 现算。',
  },
  product: {
    chars: 29482,
    bytes: 32798,
    sha: 'a4190e7545ccaae8196e258ebd615c2cc9b2b9ff7aa1702781520f0557bd418f',
  },
  /** ★ 作废组：这是 `String(fn)`（函数源码串化，壳没调用）——**只作反向夹具**，任何判据都不许用它当基准。 */
  deprecatedWrongShell: {
    chars: 42911,
    bytes: 50623,
    sha: '6ed36cf9050d1e6feb8573d72c57f5a7c59bf13aa7ae406ee20243866c8e2794',
    why: '函数源码的串化（非产物）；据此得出的长度类判据一并退役',
    whyChanged: '它由**当前**函数源码算出 ⇒ 随笔2 迁移一起变大（笔1 时为 38205/45539/71f796c0…）。'
      + '它是**反向夹具**，不是产物断言 —— 只有它变、而 product 不变，正是本网要表达的事。',
  },
  counts: {
    tvTab: 12,             // 产物侧：data-tv-tab=
    productTvRow: 39,      // 产物侧：class="t-row" 出现次数
    tvRowLiteral: 39,      // ★ 历史段侧：含 class="t-row" 的候选行（字面量条数）
    tvRowDistinct: 28,     // ★ 历史段侧：解码值去重数
    segLiterals: 377,      // ★ 历史段侧：段内字面量总数
  },
  fingerprints: {
    N: 28,
    setShaJoinedLf: '40e004bc693e9645567318b1b2aa945dbee91d3eb57046f1ccef2dc33509aba2',
    setShaJson: '2a317069eff930261e019eb8f67d3382547cb6b86ffbc545444269ba2fc92327',
    hitCountsSorted: [1, 2, 1, 1, 2, 1, 1, 1, 6, 1, 1, 1, 2, 4, 1, 1, 1, 1, 1, 1, 2, 1, 1, 3, 1, 1, 1, 2],
    hitSum: 43,
    zeroHits: 0,
    /** 读数的范围（`[min, max]`）—— 只作诊断口径，逐条次数以 `hitCountsSorted` 为准。 */
    hitRange: [1, 6],
    /** 指纹的**来源**（机器可读的那一句；防后人把来源改回当前段）。 */
    source: 'history:' + HIST_REV + ':' + HIST_PATH,
  },
  closure: { shiftedSha: 'e507740fc2637731559360951d6666ef7e473df4ab04b233712a36240f8a9d7d', free: [] },
  /** 笔2 基元的形态读数（`test ⑨` 逐条断言）。 */
  primitives: {
    openCallSites: 39,     // `tvRowOpen(<数字>, …)` 调用点
    closeCallSites: 2,     // `tvRowClose()` 调用点（两个 complete-row 各 1 处）
    distinctOpenTags: 27,  // 表里能发出的开标签（= 迁移前 27 个 distinct 开标签）
    indents: [2, 4, 6, 8],
    styles: 24,            // 非 null 的 style 值
    histogramByIndent: { 2: 3, 4: 18, 6: 5, 8: 1 },
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
// 解码器：**按 `tests/slice-anchors.test.js` 原文抄入**（decodeEscapes / scanStringLiteral）
//   ★ 不 import 那个 `.test.js` —— 会把对方的 `test(...)` 注册进本进程、在 harness 路径上炸（实测过）。
// ════════════════════════════════════════════════════════════════════
export function decodeEscapes(raw) {
  const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$' }
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, g) => map[g] ?? g)
}

export function scanStringLiteral(src, i) {
  const q = src[i]
  if (q !== "'" && q !== '"' && q !== '`') return null
  let j = i + 1
  let raw = ''
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { raw += src.slice(j, j + 2); j += 2; continue }
    if (c === q) return { value: decodeEscapes(raw), end: j + 1 }
    if (c === '\n') return null
    if (q === '`' && c === '$' && src[j + 1] === '{') return null
    raw += c
    j++
  }
  return null
}

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
const HIST = readHistoryBundle()
const HIST_SEG = extractSegment(HIST)
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
  assert.deepEqual(zero.map((h) => h.value.slice(0, 60)), [], '★ 有指纹在真产物里 0 命中（要么产物变了、要么指纹不是解码值）')
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

test('⑨-e 表 == 历史段：27 条开标签与迁移前的 distinct 开标签**逐条相同**', (t) => {
  const table = PRIM_OPEN_TABLE()
  const tableTags = Object.keys(table).flatMap((k) => Object.keys(table[k]).map((s) => table[k][s])).sort()
  const histTags = [...new Set(FP_HIST.values.map((v) => v.slice(0, v.indexOf('>') + 1)))].sort()
  const byIndent = {}
  for (const tag of tableTags) { const p = (tag.match(/^ */) || [''])[0].length; byIndent[p] = (byIndent[p] || 0) + 1 }
  t.diagnostic('表：' + tableTags.length + ' 条开标签 · 按缩进 ' + JSON.stringify(byIndent) +
    ' · distinct style ' + Object.keys(table).flatMap((k) => Object.keys(table[k]).filter((s) => s !== '')).length + '（按缩进展开后）')
  assert.equal(tableTags.length, FROZEN.primitives.distinctOpenTags, '表里的开标签条数漂了')
  assert.ok(tableTags.length >= FLOORS.distinctOpenTags, '开标签条数低于下限 —— 判据空跑')
  assert.deepEqual(tableTags, histTags, '★ 表里的开标签必须与迁移前的 distinct 开标签逐条相同（否则产物不可能逐字节不变）')
  assert.deepEqual(Object.keys(table).map(Number).sort((a, b) => a - b), FROZEN.primitives.indents, '缩进闭集漂了')
  const styles = new Set(Object.keys(table).flatMap((k) => Object.keys(table[k])).filter((s) => s !== ''))
  assert.equal(styles.size, FROZEN.primitives.styles, '非 null style 种类漂了')
  assert.deepEqual(byIndent, FROZEN.primitives.histogramByIndent, '开标签的缩进直方图漂了')
})

test('⑩ ★ 迁移等价性：历史段的产物 == 当前段的产物（**逐字节**）', (t) => {
  t.diagnostic('历史段产物 ' + HIST_PRODUCT.length + ' chars / sha ' + sha256(HIST_PRODUCT))
  t.diagnostic('当前段产物 ' + product.length + ' chars / sha ' + sha256(product))
  assert.equal(HIST_PRODUCT, product,
    '★ "把 39 行迁成基元"没有保持产物逐字节不变 —— 这正是本笔的等价性口径（不是"看起来没变"，是同一个字符串）')
  assert.equal(sha256(HIST_PRODUCT), FROZEN.product.sha, '历史段产物 sha 与冻结值不符')
})
