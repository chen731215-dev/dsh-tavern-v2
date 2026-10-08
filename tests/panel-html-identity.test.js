/**
 * 客户端面板身份网（task-25 笔1）——把 `panelHTML` 的**真产物**钉死，挡住"把函数源码当成产物"这一类错。
 *
 * 为什么需要它（本线程已定性的根因）：
 *   早期求值壳写成 `new Function(seg + '\nreturn panelHTML;')()` **但没调用它** ⇒ 拿到的是**函数对象**，
 *   `String(fn)` 出来是**函数源码**（38205 chars / 45539 bytes / sha 71f796c0…）。据此推出的
 *   "产物长度 ∈ [段chars−1%, 段chars]" 之类判据**全是错的**（源码 38205 ≈ 段的 38209，两个错口径互相掩盖）。
 *   ⇒ 本网只认**真调用**的返回值，并把段 / 产物 / 指纹集合三者的 sha **成对带标签**冻结。
 *
 * 冻结口径（每个常数都写清"配方 + 复算命令"；复算方 ≥2）：
 *   · 段：needle = `function panelHTML(` **首次出现**的那一行起，到括号配平的收尾 `}`（**含两端**）；
 *        `lines[539..1021].join('\n')`，**无尾随换行**；**原始缩进**（声明在第 4 列）。
 *        带尾随 `\n` 的变体 sha = c4d717c1…（不同）⇒ 配方必须写死"无尾随换行"。
 *   · 产物：`const fn = new Function(seg + '\nreturn panelHTML;')(); const html = String(fn())` ← **必须真调用**。
 *   · 指纹：段内**含 `class="t-row"` 的候选行**（39 行，每行 1 个字面量）里那个字面量的**解码值**（按值去重）⇒ N=28。
 *   · 指纹集合 sha 两套配方都记（防"不能复算的常数"）：
 *       配方A（**判据用这套**）= 解码值 `sort()` 后 `join('\n')`，**无尾随换行**，utf8，sha256 ⇒ 40e004bc…
 *       配方B（dev 原值，一并登记）= 同数组 `JSON.stringify` 后 sha256 ⇒ 2a317069…
 *   复算命令：`node _scratch/s3b/_dev/probe-v2.mjs`（只读；打印全部读数与逐条命中表）
 *
 * 判据自称（每条都配非空跑下限；0 命中即判败，见 ⑦）：
 *   ① 产物**不得**含 `function panelHTML(`（唯一能一键识破"源码当产物"）——**配反向夹具**（喂 `String(fn)` 必须红）
 *   ② 产物必须以 `<div id="tavern-manager">` 开头
 *   ③ 计数：`data-tv-tab=` 12 · `class="t-row"` 字面量 39 · 解码值去重 28（**两个口径分开写**）
 *   ④ 指纹 **28/28 逐条命中**、逐条命中次数、集合 sha（配方A）、下限先测量再写死
 *   ⑤ 真产物 sha 与段 sha **分开标签**断言
 *   ⑥ 闭包：段里 `panelHTML` 的自由标识符集合（用仓里 `routes-deps-scope` 那套口径，**源码切片取用**，
 *       不 import 另一个 `.test.js`）—— 实测为**空集** ⇒ 该函数**自包含**、可独立求值；并配"插一个未声明名
 *       ⇒ 必须点名"的自证（证明判据真看见了它，不是恒真）
 *
 * 本机无法验证（诚实清单）：
 *   · 没有浏览器 ⇒ **不做**"逐像素/渲染等价"的声称；本网钉的是**字符串产物**（panelHTML() 的返回值），
 *     它不需要 DOM（实测在纯 node 进程里可求值）。
 *   · CSS 生效、点击行为、页签引擎的实际渲染不在本网范围内（分别由 style-budget / panel-tabs / 客户端夹具覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(REPO, 'lib', 'client.manager.bundle.js')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/** 冻结常数（成对带标签；**段 sha 与产物 sha 分开**）。 */
export const FROZEN = {
  segment: {
    from: 540,
    to: 1022,
    lines: 483,
    chars: 38209,
    bytes: 45543,
    sha: '63f478e455259555d9de3e7f3345afa9e640ed9a954ef6c6e064d4fa2918342f',
    shaWithTrailingNewline: 'c4d717c118aaf43135658898e55ee3465bf6044405c45c1a2fe28bbeb375f99b',
  },
  product: {
    chars: 29482,
    bytes: 32798,
    sha: 'a4190e7545ccaae8196e258ebd615c2cc9b2b9ff7aa1702781520f0557bd418f',
  },
  /** ★ 作废组：这是 `String(fn)`（函数源码串化，壳没调用）——**只作反向夹具**，任何判据都不许用它当基准。 */
  deprecatedWrongShell: {
    chars: 38205,
    bytes: 45539,
    sha: '71f796c01ae92e39b14881303c7c0bad92927a4899d877014a5a7b97f0939594',
    why: '函数源码的串化（非产物）；据此得出的长度类判据一并退役',
  },
  counts: { tvTab: 12, tvRowLiteral: 39, tvRowDistinct: 28, segLiterals: 377 },
  fingerprints: {
    N: 28,
    setShaJoinedLf: '40e004bc693e9645567318b1b2aa945dbee91d3eb57046f1ccef2dc33509aba2',
    setShaJson: '2a317069eff930261e019eb8f67d3382547cb6b86ffbc545444269ba2fc92327',
    hitCountsSorted: [1, 2, 1, 1, 2, 1, 1, 1, 6, 1, 1, 1, 2, 4, 1, 1, 1, 1, 1, 1, 2, 1, 1, 3, 1, 1, 1, 2],
    hitSum: 43,
    zeroHits: 0,
  },
  closure: { shiftedSha: 'a3fa8c407348a833eee2bbba074e2f0e6f8c944cd7fab35fab9178c623fd6108', free: [] },
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
}

// ════════════════════════════════════════════════════════════════════
// 解码器：**按 `tests/slice-anchors.test.js` 原文抄入**（decodeEscapes L229-232 / scanStringLiteral L238-252）
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
 * 产物判据（① ② ③⑤ 的纯函数形态）：返回问题清单（空 = 通过）。
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
// 读数（模块加载时算一次）
//   ★ 行尾口径：读入后**把 CRLF 归一成 LF** 再算一切。
//     理由（实测，不是预防性猜测）：本仓 `core.autocrlf=true` ⇒ 同一个 blob 在**干净 clone / CI** 里
//     会检成 CRLF，而本机工作树是 LF。不归一的话，段字节数会多出"每行 1 个 CR"（实测 45543 → 46026，
//     差 +483 = 段行数），段/产物 sha 全变 ⇒ **在克隆里假红**（本笔正对照第一次跑就撞上了）。
//     bundle 在仓库里的约定行尾是 LF（AGENTS §7.4），所以归一是"回到 blob 形态"，不是掩盖差异。
// ════════════════════════════════════════════════════════════════════
const RAW = fs.readFileSync(BUNDLE, 'utf8')
const SRC = RAW.replace(/\r\n/g, '\n')
const EOL_NORMALIZED = RAW !== SRC
const SEG = extractSegment(SRC)
const { fn, product } = evaluateProduct(SEG.seg)
const FP = fingerprintSet(SEG.seg)
const HITS = hitReport(product, FP.values)

test('① 段常数：行区间 / 行数 / 字节 / sha（配方写死"无尾随换行"）', (t) => {
  t.diagnostic('行尾口径：本机读到 ' + (EOL_NORMALIZED ? 'CRLF（已归一成 LF）' : 'LF（无需归一）') + ' —— 归一后所有读数与冻结值可比')
  t.diagnostic('段 L' + SEG.from + '–' + SEG.to + ' · ' + SEG.lineCount + ' 行 · ' + SEG.seg.length + ' chars · ' +
    Buffer.byteLength(SEG.seg, 'utf8') + ' 字节 · sha ' + sha256(SEG.seg))
  assert.equal(SEG.from, FROZEN.segment.from, '段起点漂了')
  assert.equal(SEG.to, FROZEN.segment.to, '段终点漂了')
  assert.equal(SEG.lineCount, FROZEN.segment.lines, '段行数漂了')
  assert.equal(Buffer.byteLength(SEG.seg, 'utf8'), FROZEN.segment.bytes, '段字节数漂了')
  assert.equal(sha256(SEG.seg), FROZEN.segment.sha, '★ 段 sha 变了（配方：lines[539..1021].join("\\n")，无尾随换行）')
  // 配方自证：带尾随换行的变体必须得到**另一个** sha（否则"无尾随换行"这条写死就没意义）
  assert.equal(sha256(SEG.seg + '\n'), FROZEN.segment.shaWithTrailingNewline, '带尾随换行的变体 sha 对不上')
  assert.notEqual(sha256(SEG.seg + '\n'), FROZEN.segment.sha, '★ 两种 join 得到同一 sha ⇒ 配方没写死')
  assert.ok(Buffer.byteLength(SEG.seg, 'utf8') >= FLOORS.segmentBytes, '段字节数低于下限 —— 判据空跑')
})

test('② 真产物：必须**真调用**（`fn()`），不是 `String(fn)`', (t) => {
  t.diagnostic('产物 ' + product.length + ' chars · ' + Buffer.byteLength(product, 'utf8') + ' bytes · sha ' + sha256(product))
  t.diagnostic('对照（作废组）String(fn) = ' + String(fn).length + ' chars · sha ' + sha256(String(fn)))
  assert.equal(product.length, FROZEN.product.chars, '产物 chars 漂了')
  assert.equal(Buffer.byteLength(product, 'utf8'), FROZEN.product.bytes, '产物 bytes 漂了')
  assert.equal(sha256(product), FROZEN.product.sha, '★ 真产物 sha 变了（= 面板 markup 变了；先确认是不是有意的）')
  assert.ok(product.length >= FLOORS.productChars, '产物长度低于下限 —— 判据空跑')
  // ★ 真产物 ≠ 作废组（两个口径必须分得开）
  assert.notEqual(sha256(product), FROZEN.deprecatedWrongShell.sha, '★ 产物 sha 等于"函数源码串化"那组 —— 求值壳退化了（没调用函数？）')
  assert.notEqual(product.length, FROZEN.deprecatedWrongShell.chars, '★ 产物长度等于作废组 —— 同上')
})

test('③ ①的反向夹具：喂 `String(fn)`（源码串化）⇒ 判据必须红，且点名', () => {
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

test('④ ②③⑤：产物开头 / 计数（两个字面量口径分开）', (t) => {
  assert.deepEqual(productProblems(product), [], '② 产物必须以 <div id="tavern-manager"> 开头')
  const tvTab = (product.match(/data-tv-tab=/g) || []).length
  const tvRowLiteral = (product.match(/class="t-row"/g) || []).length
  t.diagnostic('计数：data-tv-tab=' + tvTab + ' · class="t-row"(产物里出现次数)=' + tvRowLiteral +
    ' · class="t-row" 字面量(段内)=' + FP.candidates.length + ' · 解码值去重=' + FP.N)
  assert.equal(tvTab, FROZEN.counts.tvTab, 'data-tv-tab 计数漂了')
  assert.equal(tvRowLiteral, FROZEN.counts.tvRowLiteral, '产物里 class="t-row" 出现次数漂了')
  // ★ 两个口径分开写：字面量条数（39）≠ 解码值去重数（28）
  assert.equal(FP.candidates.length, FROZEN.counts.tvRowLiteral, '段内 class="t-row" **字面量条数**漂了')
  assert.equal(FP.N, FROZEN.counts.tvRowDistinct, '段内 class="t-row" **解码值去重数**漂了')
  assert.equal(FP.segLiterals, FROZEN.counts.segLiterals, '段内字面量总数漂了')
  assert.ok(tvTab >= FLOORS.tvTab && tvRowLiteral >= FLOORS.tvRowLiteral && FP.N >= FLOORS.tvRowDistinct, '计数低于下限 —— 判据空跑')
})

test('⑤ ④ 指纹：28/28 逐条命中 + 逐条次数 + 集合 sha（两套配方）', (t) => {
  t.diagnostic('指纹 N=' + FP.N + ' · 配方A(join "\\n")=' + FP.setShaJoinedLf + ' · 配方B(JSON.stringify)=' + FP.setShaJson)
  assert.equal(FP.N, FROZEN.fingerprints.N, '指纹去重数 N 漂了')
  assert.equal(FP.setShaJoinedLf, FROZEN.fingerprints.setShaJoinedLf, '★ 指纹集合 sha（配方A：sort + join("\\n") + 无尾随）对不上')
  assert.equal(FP.setShaJson, FROZEN.fingerprints.setShaJson, '指纹集合 sha（配方B：JSON.stringify）对不上')
  assert.ok(FP.N >= FLOORS.fingerprintN, 'N 低于下限 —— 判据空跑')
  // 逐条命中（0 的必须看得见）
  const zero = HITS.filter((h) => h.n === 0)
  t.diagnostic('命中分布：' + JSON.stringify(HITS.map((h) => h.n)))
  assert.deepEqual(zero.map((h) => h.value.slice(0, 60)), [], '★ 有指纹在真产物里 0 命中（要么产物变了、要么指纹不是解码值）')
  assert.deepEqual(HITS.map((h) => h.n), FROZEN.fingerprints.hitCountsSorted, '逐条命中次数（按解码值 sort 序）对不上')
  assert.equal(HITS.reduce((a, h) => a + h.n, 0), FROZEN.fingerprints.hitSum, '命中总数对不上')
  assert.equal(zero.length, FROZEN.fingerprints.zeroHits, '0 命中条数对不上')
  assert.ok(HITS.reduce((a, h) => a + h.n, 0) >= FLOORS.hitSum, '命中总数低于下限')
  // 自证：把某条指纹改 1 个字符 ⇒ 必须 0 命中（证明"搜得动"，不是恒真）
  const probe = FP.values[0].replace('t-row', 't-roX')
  assert.equal(product.split(probe).length - 1, 0, '★ 改动 1 字符后仍然命中 ⇒ 搜索恒真')
})

test('⑥ 闭包：panelHTML 的自由标识符集合（左移后；实测空集 = 自包含）', (t) => {
  const shifted = deindentByDecl(SEG.seg)
  t.diagnostic('左移版 sha ' + sha256(shifted) + ' · 首行 ' + JSON.stringify(shifted.split('\n')[0]))
  assert.equal(sha256(shifted), FROZEN.closure.shiftedSha, '左移版 sha 对不上（口径：按声明自身缩进整体左移）')
  assert.match(shifted.split('\n')[0], /^function panelHTML\(/, '★ 左移后声明仍未顶格 ⇒ 闭包判据会一条都看不见（恒真）')
  const unresolved = loadClosureJudge()
  const res = unresolved(shifted)
  const free = res.flatMap((r) => r.free)
  t.diagnostic('闭包结果：' + JSON.stringify(res))
  assert.deepEqual(free, FROZEN.closure.free, '★ panelHTML 的自由标识符集合变了（新增了外层依赖？那它就不再能独立求值）')
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

test('⑦ 非空跑汇总：各桶计数（0 即判败）', (t) => {
  const buckets = {
    段行数: SEG.lineCount,
    段字节: Buffer.byteLength(SEG.seg, 'utf8'),
    产物chars: product.length,
    tvTab: (product.match(/data-tv-tab=/g) || []).length,
    tvRow字面量: FP.candidates.length,
    指纹N: FP.N,
    命中总数: HITS.reduce((a, h) => a + h.n, 0),
    段内字面量: FP.segLiterals,
  }
  t.diagnostic('各桶：' + JSON.stringify(buckets))
  for (const [k, v] of Object.entries(buckets)) assert.ok(v > 0, '★ 桶「' + k + '」为 0 —— 判据空跑')
})
