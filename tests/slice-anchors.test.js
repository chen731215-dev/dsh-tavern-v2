/**
 * 切片锚点护栏：把 AGENTS.md §5.1 那份「不许搬出 lib/index.js」的名单**变成可执行判据**。
 *
 * 为什么需要它（S2-C2 动手前专门加的）：
 *   `lib/index.js` 里有几个函数会被测试**按行切片**、拼成一个独立模块求值
 *   （`memory-isolation` / `session-storage-migration` / `greeting-seed`）。
 *   一旦有人把其中任何一个搬进 `lib/server/`，那个独立模块里就是 `ReferenceError` ——
 *   而错误信息离「你搬错了哪个函数」很远，排查成本高。
 *   另一个更隐蔽的形态：`function X(` 一旦不再**顶格**（比如被包进 namespace 对象里），
 *   `sliceFn` 就再也切不到，测试会以「找不到函数」的形式炸掉。
 *
 *   所以这里把两件事钉死：
 *     ① 所有被 `sliceFn('X')` 点名的 X，必须以**顶格** `function X(` 的形式留在 lib/index.js；
 *     ② `apply(ctx)` 里几处被**字面量子串**锚住的位置不许消失/改名。
 *
 * 判据写成纯函数，配反证组（喂坏样本必须报错）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = 'lib/index.js'

export const TEST_SOURCES = fs
  .readdirSync(path.join(REPO, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => fs.readFileSync(path.join(REPO, 'tests', f), 'utf8'))

/** 从测试源码里抽出所有 sliceFn 的目标名 */
export function sliceTargets(sources) {
  const out = new Set()
  for (const raw of sources) {
    // 先剥注释：本文件/说明性注释里会出现「sliceFn(……)」这种字样，
    // 不过滤的话会把自己注释里的示例当成真实锚点（这个坑实际踩过一次）。
    const s = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    }).join('\n')
    const re = /sliceFn\(\s*'([A-Za-z_$][\w$]*)'/g
    let m
    while ((m = re.exec(s))) out.add(m[1])
  }
  return [...out].sort()
}

/** src 里哪些目标名没有以**顶格** `function X(` 声明 */
export function missingTargets(names, src) {
  return names.filter((n) => !new RegExp('^function ' + n + '\\(', 'm').test(src))
}

/** §5.1 后三行：apply(ctx) 内部被字面量锚住的位置（删/改都会让测试红） */
export const APPLY_ANCHORS = [
  'isTavernSession(',
  'decideInjectionScope(',
  'order: -1',
  "flushPromptStats(); return ''",
  'sectionSizes.nsfw',
  'writeInjectObserveRecord',
  'const targetSid = lastSessionId',
]

/** src 里缺失的锚点子串 */
export function missingAnchors(anchors, src) {
  return anchors.filter((a) => !src.includes(a))
}

const SERVER_SRC = fs.readFileSync(path.join(REPO, SERVER), 'utf8')

// ════════════════════════════════════════════════════════════════
// ① 被切片的函数必须以顶格 function 留在 lib/index.js
// ════════════════════════════════════════════════════════════════

test('① 被 `sliceFn` 点名的函数必须顶格留在 lib/index.js', () => {
  const names = sliceTargets(TEST_SOURCES)
  // 非空跑：判据本身必须抓到东西
  assert.ok(names.length >= 8, '只找到 ' + names.length + ' 个 sliceFn 目标 —— 判据空跑或抽取方式变了')
  const missing = missingTargets(names, SERVER_SRC)
  assert.deepEqual(
    missing,
    [],
    '★ 这些函数被测试按源码切片，却不再以顶格 `function X(` 出现在 ' + SERVER + ' 里：\n  ' +
      missing.join('\n  ') +
      '\n（搬进 lib/server/ 会让切片出来的独立模块 ReferenceError；'
      + '不再顶格会让 sliceFn 直接切不到。名单见 AGENTS.md §5.1）',
  )
})

test('①-b 反证：判据必须能报出「函数被搬走 / 不再顶格」', () => {
  const good = 'function readMemory(sid) {\n  return 1\n}'
  assert.deepEqual(missingTargets(['readMemory'], good), [])
  // 搬走 ⇒ 找不到
  assert.deepEqual(missingTargets(['readMemory'], 'function other() {}'), ['readMemory'])
  // 被包进对象里 ⇒ 不再顶格
  assert.deepEqual(missingTargets(['readMemory'], 'const ns = {\n  function readMemory(sid) {}\n}'), ['readMemory'])
  // 缩进一格也算不再顶格
  assert.deepEqual(missingTargets(['readMemory'], '  function readMemory(sid) {}'), ['readMemory'])
})

// ════════════════════════════════════════════════════════════════
// ② apply(ctx) 内部被字面量锚住的位置
// ════════════════════════════════════════════════════════════════

test('② apply(ctx) 里被字面量锚住的位置不许消失', () => {
  const missing = missingAnchors(APPLY_ANCHORS, SERVER_SRC)
  assert.deepEqual(
    missing,
    [],
    '★ 这些子串被测试直接锚住，不能再出现：\n  ' + missing.join('\n  ') + '\n（见 AGENTS.md §5.1 后三行）',
  )
})

test('②-b 反证：锚点判据必须能报出缺失', () => {
  assert.deepEqual(missingAnchors(['order: -1'], 'const x = 1\norder: -1'), [])
  assert.deepEqual(missingAnchors(['order: -1'], 'const x = 1'), ['order: -1'])
})

// ════════════════════════════════════════════════════════════════
// ③ §5.1 的表格必须与判据一致（名单漂了就报）
// ════════════════════════════════════════════════════════════════

test('③ AGENTS.md §5.1 必须点名所有被切片的函数（名单不许落后于事实）', () => {
  const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8')
  const names = sliceTargets(TEST_SOURCES)
  const undocumented = names.filter((n) => !agents.includes(n))
  assert.deepEqual(
    undocumented,
    [],
    '★ 这些函数被测试切片钉住，但 AGENTS.md §5.1 没点名：\n  ' + undocumented.join('\n  '),
  )
})

// ════════════════════════════════════════════════════════════════════
// ④ 「按源码内容定位端点」的锚点（整类机器门禁）
//
// 为什么单独立这一节（① 只看 sliceFn 的**目标名**）：
//   测试里有一整类锚点不走 `sliceFn` —— 它们直接拿 `indexOf('<端点字面量>')` 定位一个区间，
//   再 `slice(start, end)` 切下来做断言（还有 `extractFnSource(<src>, 'function X(')`）。
//   这类锚点**没有机器门禁覆盖** = 静默失明：搬迁/改名之后 `indexOf` 返回 -1，切片变成
//   空串或 `slice(-1, …)`，断言要么直接崩、要么在"空串不含某子串"上**静默放绿**。
//   而 `greeting-seed.test.js:551` 那对端点跨了第 2/第 3 块路由 —— 搬迁时它一定会动。
//
// 本节的判据**从测试源码自动派生**（不手抄清单），分三类形态：
//   (a) `pair`   成对：`const s = <src>.indexOf('<A>')` + `const e = <src>.indexOf('<B>', s)`
//                  + 体内 `<src>.slice(s, e)`（也覆盖 `s + 'x'.length` 这种偏移算术）
//   (b) `inline` 一行式：`<src>.slice(<src>.indexOf('<A>'), <src>.indexOf('<B>'))`
//   (c) `helper` 辅助式：`extractFnSource(<src>, 'function X(')`
// 每个条目都带 `{ 测试文件:行, 锚点字面量, 目标文件, 形态 }`；目标文件由 `readFileSync` /
// `new URL` 的路径参数回溯得到（`<src>` 若来自形参，则沿"实参是 readFileSync(已知变量)"再走一跳）。
//
// 去噪**按形态做，不是白名单**（规则见 `classifySites`，判据 ④-2 逐条交叉验证）：
//   ① `<src>` 回溯不到任何"被测试读进来的仓库文件" ⇒ 它不是源码文本（`f.url.indexOf('/api/…')`
//      这类路由判断、断言消息里的 `indexOf`），排除；
//   ② 结果**不喂给切片**的 `indexOf` ⇒ 它不是在定位区间（存在性/顺序断言），排除；
//   ③ `sliceFn('X')` 这一类**已被 ① 覆盖**（判据自己断言这个包含关系），排除。
// 三类各自的**非空跑下限**见 FORM_FLOORS：某一类 0 命中 ⇒ 判据空跑即失败（"扩了面但一条没看"）。
// ════════════════════════════════════════════════════════════════════

/** 粗扫探针（与 `_scratch/s2c2r/recon-anchors.mjs` 同规则）：返回 "文件:行" 集合，用于机械计数。 */
export const PROBE_TOKENS = /\b(indexOf|slice|extractFnSource|indexOfLine)\s*\(/

export function probeAnchorLines(files) {
  const lines = new Set()
  for (const { name, text } of files) {
    String(text).replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
      if (!PROBE_TOKENS.test(l)) return
      if (!/(?:'[^']{6,}'|"[^"]{6,}"|`[^`]{6,}`)/.test(l)) return
      lines.add(name + ':' + (i + 1))
    })
  }
  return lines
}

/** 注释遮罩：**长度与行号都不变**（注释内容逐字符换成空格，换行保留）。 */
export function maskComments(src) {
  const s = String(src)
  let out = ''
  let i = 0
  const n = s.length
  let quote = ''
  while (i < n) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue }
      if (c === quote) quote = ''
      out += c
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && s[i + 1] === '/' && s[i - 1] !== ':') {
      while (i < n && s[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (c === '/') {
      // 正则字面量整体跳过：否则 `/['"]/` 里的引号会被当成字符串开头，后面的注释就漏遮了。
      // 正则 vs 除法：看**上一个非空白字符**（这里的 out 与 s 等长同偏移，索引可直接用）。
      let prev = ''
      for (let q = i - 1; q >= 0; q--) { const pc = out[q]; if (pc === ' ' || pc === '\t') continue; prev = pc; break }
      if (!/[A-Za-z0-9_$)\]}]/.test(prev)) {
        let inClass = false
        let k = i + 1
        for (; k < n; k++) {
          const rc = s[k]
          if (rc === '\\') { k++; continue }
          if (rc === '\n') break
          if (rc === '[') inClass = true
          else if (rc === ']') inClass = false
          else if (rc === '/' && !inClass) break
        }
        if (k < n && s[k] === '/') { out += s.slice(i, k + 1); i = k + 1; continue }
      }
    }
    out += c
    i++
  }
  return out
}

function decodeEscapes(raw) {
  const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$' }
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, g) => map[g] ?? g)
}

/**
 * 扫描 `src[i]` 处的字符串字面量。
 * 返回 `{ value, end }`（`value` 已解转义、`end` 是闭引号之后的下标）；含 `${}` 的模板、未闭合、非引号一律 `null`。
 */
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

/** 取 `masked[openIdx] === '('` 那个调用的顶层实参（跳过字符串/正则/括号嵌套）。 */
export function argListAt(masked, openIdx) {
  let depth = 1
  let cur = ''
  const args = []
  for (let i = openIdx + 1; i < masked.length; i++) {
    const c = masked[i]
    if (c === "'" || c === '"' || c === '`') {
      const lit = scanStringLiteral(masked, i)
      const end = lit ? lit.end : i + 1
      cur += masked.slice(i, end)
      i = end - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) { args.push(cur); return { args, end: i } }
    }
    if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue }
    cur += c
  }
  args.push(cur)
  return { args, end: masked.length }
}

/** 取 `= ` 之后的一条声明右值（括号配平、到行尾或 `;` 为止）。字符串字面量整体跳过 ——
 *  字面量里的 `(`/`)` 会让配平算错（`indexOf('function alpha(')` 就有一个不闭合的 `(`）。 */
function declExprAt(masked, from) {
  let depth = 0
  let i = from
  for (; i < masked.length; i++) {
    const c = masked[i]
    if (c === "'" || c === '"' || c === '`') {
      const lit = scanStringLiteral(masked, i)
      i = (lit ? lit.end : i + 1) - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) break }
    else if ((c === '\n' || c === ';') && depth <= 0) break
  }
  return masked.slice(from, i)
}

export function offsetLine(text, off) {
  let n = 1
  for (let i = 0; i < off && i < text.length; i++) if (text[i] === '\n') n++
  return n
}

/** 由表达式回溯出它指向的**仓库相对路径**（只在恰好一个 `.js` 段时成立，否则 null）。 */
export function fileFromExpr(expr, pathVars) {
  // 只有"路径构造式"才算：取值表达式（`.indexOf(` / `.slice(` / `.split(` …）不是路径，
  // 否则 `const start = INDEX_SRC.indexOf('…')` 会被误判成"指向 lib/index.js 的路径变量"。
  // 注意 `path.join(` / `path.resolve(` 是合法的路径构造，不能一起排掉。
  if (/\.\s*(?:indexOf|lastIndexOf|slice|split|includes|replace|startsWith|endsWith|match|test|trim)\s*\(/.test(String(expr))) return null
  const base = String(expr).replace(/\s+/g, ' ')
  const lits = [...base.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])
  const direct = lits.filter((s) => s && !/\s/.test(s) && (/\.js$/.test(s) || ['lib', 'server', 'tests', 'tools', '.'].includes(s)))
  const named = [...base.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((n) => pathVars.has(n))
  const segs = []
  for (const s of [...named.map((n) => pathVars.get(n)), ...direct]) {
    for (const p of String(s).split('/')) if (p && p !== '.' && p !== '..') segs.push(p)
  }
  const js = segs.filter((s) => s.endsWith('.js'))
  if (js.length !== 1) return null
  const idx = segs.lastIndexOf(js[0])
  return segs.slice(Math.max(0, idx - 2), idx + 1).join('/')
}

const DECL_RE = /(?:^|[\s,;{}(])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g

/** 一个测试文件里的：声明表 / 路径变量 / 源码变量 / 形参别名。 */
export function fileIndex(name, text) {
  const masked = maskComments(text)
  const decls = []
  DECL_RE.lastIndex = 0
  let m
  while ((m = DECL_RE.exec(masked))) {
    const expr = declExprAt(masked, m.index + m[0].length)
    // 行号按**名字本身**算（`m.index` 落在分隔符上：以 `\n` 起头的匹配会少算一行）
    const nameAt = masked.indexOf(m[1], m.index)
    decls.push({ name: m[1], line: offsetLine(masked, nameAt), expr, flat: expr.replace(/\s+/g, ' ').trim() })
  }
  const pathVars = new Map()
  for (const d of decls) {
    const f = fileFromExpr(d.expr, pathVars)
    if (f) pathVars.set(d.name, f)
  }
  const srcVars = new Map()
  for (const d of decls) {
    if (!/readFileSync\s*\(|new URL\s*\(/.test(d.flat)) continue
    const f = fileFromExpr(d.expr, pathVars)
    if (f) srcVars.set(d.name, f)
  }
  return { name, text, masked, decls, pathVars, srcVars, paramVars: paramSources(masked, pathVars, srcVars) }
}

/** 形参别名：某个 helper 的形参被当源码文本用，而调用点传的是 `readFileSync(<已知变量>)`。 */
function paramSources(masked, pathVars, srcVars) {
  const out = new Map()
  const FN = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
  let m
  while ((m = FN.exec(masked))) {
    const fn = m[1]
    const params = m[2].split(',').map((p) => p.trim().split(/[=:]/)[0].trim()).filter(Boolean)
    if (!params.length) continue
    const usedAsSource = params.some((p) => new RegExp('\\b' + p + '\\s*\\.\\s*(?:slice|indexOf|lastIndexOf)\\s*\\(').test(masked))
    if (!usedAsSource) continue
    const CALL = new RegExp('\\b' + fn + '\\s*\\(', 'g')
    let c
    while ((c = CALL.exec(masked))) {
      const { args } = argListAt(masked, c.index + c[0].length - 1)
      const arg = (args[0] || '').trim()
      const readVar = arg.match(/^(?:fs\.)?readFileSync\s*\(\s*([A-Za-z_$][\w$]*)/)
      const file = readVar ? (srcVars.get(readVar[1]) ?? null) : (srcVars.get(arg) ?? null)
      if (file) for (const p of params) if (!out.has(p)) out.set(p, file)
    }
  }
  return out
}

/** `base` 这个名字在 `line` 处指向哪个仓库文件（取最近处声明；找不到 ⇒ null）。 */
export function resolveTarget(idx, base, line) {
  if (!base) return null
  let best = null
  for (const d of idx.decls) {
    if (d.name !== base) continue
    if (line != null && d.line > line) continue
    if (!best || d.line >= best.line) best = d
  }
  if (best && /readFileSync\s*\(|new URL\s*\(/.test(best.flat)) {
    const f = fileFromExpr(best.expr, idx.pathVars)
    if (f) return f
  }
  return idx.srcVars.get(base) ?? idx.paramVars.get(base) ?? null
}

const MIN_LITERAL = 5

/** 全部「字面量锚点站点」（含未收录的 —— 收录/排除由 classifySites 判）。 */
export function literalAnchorSites(idx) {
  const { masked } = idx
  const sites = []
  const IDX_CALL = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(indexOf|lastIndexOf)\s*\(/g
  let m
  while ((m = IDX_CALL.exec(masked))) {
    const receiver = m[1].replace(/\s+/g, '')
    const { args } = argListAt(masked, m.index + m[0].length - 1)
    const raw = (args[0] || '').trim()
    const lit = scanStringLiteral(raw, 0)
    if (!lit || lit.end !== raw.length || lit.value.length < MIN_LITERAL) continue
    const line = offsetLine(masked, m.index)
    const base = receiver.split('.')[0]
    sites.push({ file: idx.name, line, kind: 'indexOf', receiver, base, literal: lit.value, targetFile: resolveTarget(idx, base, line) })
  }
  const HELPER = /\b(extractFnSource|indexOfLine|sliceFn)\s*\(/g
  while ((m = HELPER.exec(masked))) {
    const callee = m[1]
    const { args } = argListAt(masked, m.index + m[0].length - 1)
    const line = offsetLine(masked, m.index)
    if (callee === 'sliceFn') {
      const raw = (args[0] || '').trim()
      const lit = scanStringLiteral(raw, 0)
      if (lit) sites.push({ file: idx.name, line, kind: 'sliceFn', receiver: null, base: null, literal: lit.value, targetFile: null })
      continue
    }
    const srcArg = (args[0] || '').trim()
    const base = /^[A-Za-z_$][\w$]*/.test(srcArg) ? srcArg.replace(/\s+/g, '').split('.')[0] : null
    let literal = null
    for (let k = args.length - 1; k >= 1; k--) {
      const raw = args[k].trim()
      const lit = scanStringLiteral(raw, 0)
      if (lit && lit.end === raw.length && lit.value.length >= MIN_LITERAL) { literal = lit.value; break }
    }
    if (!literal) continue
    sites.push({ file: idx.name, line, kind: 'helper', callee, receiver: srcArg, base, literal, targetFile: resolveTarget(idx, base, line) })
  }
  return sites
}

/** `<base>.indexOf('<字面量>'` 的第一个实参是纯字面量 ⇒ 返回 `{literal, hasStart}`（否则 null）。 */
function indexOfLiteralOn(flat, base) {
  const re = new RegExp('^' + base.replace(/\$/g, '\\$') + '\\s*\\.\\s*(?:indexOf|lastIndexOf)\\s*\\(')
  const mm = re.exec(flat)
  if (!mm) return null
  const { args } = argListAt(flat, mm[0].length - 1)
  const raw = (args[0] || '').trim()
  const lit = scanStringLiteral(raw, 0)
  if (!lit || lit.end !== raw.length) return null
  // `hasStart`：测试有没有给 `indexOf` 第二参（给了 ⇒ 它自己就保证了"B 在 A 之后"）
  return { literal: lit.value, hasStart: args.length > 1 }
}

/**
 * 切片的一个端点：内联 `indexOf('<A>')` 或经变量（`x` / `x + 5` / `x + 's'.length`）。
 * 返回 `{literal, line, form, hasStart}`；定位不到 ⇒ null。
 */
export function endpointOf(idx, base, argExpr, sliceLine) {
  const a = String(argExpr).trim()
  if (!a) return null
  const inline = new RegExp('\\b' + base + '\\s*\\.\\s*(?:indexOf|lastIndexOf)\\s*\\(').exec(a)
  if (inline) {
    const { args } = argListAt(a, inline.index + inline[0].length - 1)
    const raw = (args[0] || '').trim()
    const lit = scanStringLiteral(raw, 0)
    if (lit) return { literal: lit.value, line: sliceLine, form: 'inline', hasStart: args.length > 1 }
  }
  for (const tok of a.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const d = idx.decls.filter((x) => x.name === tok[0] && x.line <= sliceLine).pop()
    if (!d) continue
    const found = indexOfLiteralOn(d.flat, base)
    if (found) return { literal: found.literal, line: d.line, form: 'pair', hasStart: found.hasStart }
  }
  return null
}

/** 所有「接收者是仓库源码、且参数里带字面量端点」的切片。 */
export function sliceSpans(idx) {
  const { masked } = idx
  const spans = []
  const SLICE = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*slice\s*\(/g
  let m
  while ((m = SLICE.exec(masked))) {
    const base = m[1].replace(/\s+/g, '').split('.')[0]
    const line = offsetLine(masked, m.index)
    const targetFile = resolveTarget(idx, base, line)
    if (!targetFile) continue
    const { args } = argListAt(masked, m.index + m[0].length - 1)
    const ends = args.slice(0, 2).map((a) => endpointOf(idx, base, a, line))
    if (!ends.some(Boolean)) continue
    spans.push({ file: idx.name, line, base, targetFile, ends, argText: args.slice(0, 2).join(',').trim() })
  }
  return spans
}

/**
 * 站点 → 收录 / 排除。**按形态排除**（规则写在这里，④-2 逐条交叉验证）：
 *   sliceFn 形       → 已被判据 ① 覆盖（① 断言它必须是顶格 `function X(`）
 *   收不到目标文件   → 它锚的不是"被测试读进来的仓库文件"，是运行期字符串
 *   indexOf 不喂切片 → 它不是在定位区间（存在性 / 顺序断言）
 *   helper 形        → 收录（它返回的就是一个区间）
 */
export function classifySites(sites, spans) {
  const included = []
  const excluded = []
  const inSliceArgs = new Set()
  for (const s of spans) {
    for (const e of s.ends) if (e) inSliceArgs.add(s.file + ':' + s.line + '|' + e.literal)
  }
  for (const site of sites) {
    if (site.kind === 'sliceFn') { excluded.push({ ...site, reason: 'covered-by-①:sliceFn' }); continue }
    if (!site.targetFile) { excluded.push({ ...site, reason: 'receiver-not-source' }); continue }
    if (site.kind === 'helper') { included.push({ ...site, form: 'helper' }); continue }
    const inline = spans.some((s) => s.file === site.file && s.line === site.line && s.ends.some((e) => e && e.literal === site.literal))
    const viaVar = spans.some((s) => s.targetFile === site.targetFile && s.ends.some((e) => e && e.form === 'pair' && e.literal === site.literal))
    if (inline) included.push({ ...site, form: 'inline' })
    else if (viaVar) included.push({ ...site, form: 'pair' })
    else excluded.push({ ...site, reason: 'not-a-region-endpoint' })
  }
  // 同一处锚点会被左右两个端点各收一次 ⇒ 去重（file+line+literal+form）
  const seen = new Set()
  const dedup = included.filter((a) => {
    const k = a.file + ':' + a.line + '|' + a.literal + '|' + a.form
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { included: dedup, excluded, inSliceArgs, merged: included.length - dedup.length }
}

/**
 * 三类各自的非空跑下限（某类低于下限 ⇒ 判据空跑即失败 —— "扩了面但一条没看"必须报红）。
 * 下限推导（值 + 口径）：实测 pair=20 / inline=9 / helper=10
 *   （口径：37 个 `tests/*.test.js` + 本笔；命令 `node --test tests/slice-anchors.test.js` 的 ④-0 diagnostic）
 *   ⇒ 下限取实测的 ~80%（16 / 7 / 8），既能挡住"整类判据失效"，又不会因为"合法地少了几处锚点"误红。
 * 探针下限同理：实测 120 行（同口径），下限取 80。
 */
export const FORM_FLOORS = { pair: 16, inline: 7, helper: 8 }
export const PROBE_FLOOR = 80

export function formFloorFailures(byForm, probeCount) {
  const bad = []
  for (const form of Object.keys(FORM_FLOORS)) {
    const got = byForm[form] ?? 0
    if (got < FORM_FLOORS[form]) bad.push(form + ' 只收录 ' + got + ' 处（下限 ' + FORM_FLOORS[form] + '）—— 这一类判据空跑')
  }
  if (probeCount < PROBE_FLOOR) bad.push('粗扫探针只命中 ' + probeCount + ' 行（下限 ' + PROBE_FLOOR + '）—— 抽取方式变了或文件没读到')
  return bad
}

/** 汇总：站点 / 收录 / 排除 / 切片 / 计数（全部机械派生）。 */
export function collectLiteralAnchors(files) {
  const indexes = files.map((f) => fileIndex(f.name, f.text))
  const sites = []
  const spans = []
  for (const idx of indexes) {
    sites.push(...literalAnchorSites(idx))
    spans.push(...sliceSpans(idx))
  }
  const { included, excluded, inSliceArgs, merged } = classifySites(sites, spans)
  const byForm = {}
  for (const a of included) byForm[a.form] = (byForm[a.form] ?? 0) + 1
  const byReason = {}
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1
  const probe = probeAnchorLines(files)
  const siteLines = new Set(sites.map((s) => s.file + ':' + s.line))
  const probeWithSite = [...probe].filter((k) => siteLines.has(k)).length
  return {
    included, excluded, spans, byForm, byReason, inSliceArgs,
    counts: {
      probe: probe.size,
      probeWithSite,
      probeWithoutSite: probe.size - probeWithSite,
      sites: sites.length,
      merged,
      included: included.length,
      excluded: excluded.length,
    },
  }
}

/**
 * 判据：每个收录锚点的字面量必须**仍在它的目标文件里**；
 * 报红点名到最小单位（测试文件:行 / 字面量 / 目标文件），并带上"切片另一端"便于定位。
 */
export function anchorFailures(included, spans, readTarget) {
  const cache = new Map()
  const read = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readTarget(rel))
    return cache.get(rel)
  }
  const out = []
  // 找它所属的切片：优先"某个端点就是这处锚点"（`pair` 形态的锚点在声明行、切片在别处），
  // 退化为"同一行的切片"（`inline` 形态）。
  const spanOf = (a) =>
    spans.find((s) => s.ends.some((e) => e && e.literal === a.literal && e.line === a.line)) ??
    spans.find((s) => s.file === a.file && s.line === a.line)
  for (const a of included) {
    if (a.targetFile == null) { out.push(a.file + ':' + a.line + ' 的锚点 ' + JSON.stringify(a.literal) + ' 回溯不到目标文件（形态 ' + a.form + '）'); continue }
    const src = read(a.targetFile)
    if (src == null) { out.push(a.file + ':' + a.line + ' 的锚点 ' + JSON.stringify(a.literal) + ' 的目标文件 ' + a.targetFile + ' 读不到'); continue }
    if (!src.includes(a.literal)) {
      const s = spanOf(a)
      const other = s ? s.ends.filter((e) => e && e.literal !== a.literal).map((e) => JSON.stringify(e.literal)).join(' / ') : ''
      out.push(a.file + ':' + a.line + ' 的锚点 ' + JSON.stringify(a.literal) + ' 在 ' + a.targetFile + ' 里找不到了' +
        (s ? '（该切片在第 ' + s.line + ' 行取 ' + JSON.stringify(s.argText) + '，另一端 ' + (other || '（无）') + '）' : ''))
    }
  }
  return out
}

/** 判据：双端点的切片必须**顺序正确**且**切下来的片段非空**。 */
export function sliceSpanFailures(spans, readTarget) {
  const cache = new Map()
  const read = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readTarget(rel))
    return cache.get(rel)
  }
  const out = []
  for (const s of spans) {
    const [a, b] = s.ends
    if (!a || !b) continue
    // 同一处锚点当两端用（`SRC.slice(i, i + 260)`）—— 那是"单端点 + 固定宽度"，不是双端点区间，
    // 顺序/内容两条对它没有意义（它的字面量存不存在由 anchorFailures 管）。
    if (a.literal === b.literal && a.line === b.line) continue
    const src = read(s.targetFile)
    if (src == null) continue
    const ia = src.indexOf(a.literal)
    // B 侧：测试给了 `indexOf` 第二参 ⇒ 它自己就保证了 B 在 A 之后，按同样口径搜；
    // 没给 ⇒ 从 0 搜，**顺序与"中间有没有内容"这两条才有意义**（否则它们恒真 = 恒真判据）。
    const ib = b.hasStart ? src.indexOf(b.literal, ia + a.literal.length) : src.indexOf(b.literal)
    if (ia < 0 || ib < 0) continue   // 缺失已由 anchorFailures 点名
    if (ib <= ia) {
      out.push(s.file + ':' + s.line + ' 的切片端点顺序反了：' + JSON.stringify(a.literal) + ' 在 ' + JSON.stringify(b.literal) + ' 之后（' + s.targetFile + '）')
      continue
    }
    // 「切出来的片段非空」的可执行版本：只断言 `slice` 非空是恒真的（切片天然含第一个端点自身），
    // 真正会翻车的形态是两端点落在同一处 ⇒ 切出来只剩端点、后面什么都没有。
    const width = ib - ia
    if (width <= a.literal.length) {
      out.push(s.file + ':' + s.line + ' 的切片只剩端点本身：' + JSON.stringify(a.literal) + ' → ' + JSON.stringify(b.literal) + ' 之间没有内容（' + s.targetFile + '，跨度 ' + width + ' 字符）')
    }
  }
  return out
}

/** ④-2 的交叉验证：被排除的站点**不该**出现在任何切片参数里；`sliceFn` 类必须已被 ① 覆盖。 */
export function exclusionCrossCheck(collected, sliceFnNames) {
  const bad = []
  for (const e of collected.excluded) {
    if (e.reason === 'covered-by-①:sliceFn') {
      if (!sliceFnNames.includes(e.literal)) bad.push(e.file + ':' + e.line + ' 的 sliceFn 锚点 ' + JSON.stringify(e.literal) + ' 不在判据 ① 的目标名单里 —— 它不是"已被覆盖"')
      continue
    }
    if (e.reason === 'receiver-not-source' || e.reason === 'not-a-region-endpoint') {
      if (collected.inSliceArgs.has(e.file + ':' + e.line + '|' + e.literal)) {
        bad.push(e.file + ':' + e.line + ' 的 ' + JSON.stringify(e.literal) + ' 被排除了，却出现在切片参数里（理由 ' + e.reason + ' 站不住）')
      }
    }
  }
  return bad
}

const TEST_FILE_TEXTS = fs
  .readdirSync(path.join(REPO, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(REPO, 'tests', f), 'utf8') }))

const READ_TARGET = (rel) => {
  const p = path.join(REPO, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}

const COLLECTED = collectLiteralAnchors(TEST_FILE_TEXTS)

test('④-0 计数与三类下限：候选 → 收录 → 排除 必须是机械恒等式', (t) => {
  const c = COLLECTED.counts
  t.diagnostic('粗扫候选行 = ' + c.probe + '；其中含字面量站点 ' + c.probeWithSite + ' 行 / 无站点 ' + c.probeWithoutSite + ' 行')
  t.diagnostic('字面量站点 = ' + c.sites + ' → 收录 ' + c.included + ' / 排除 ' + c.excluded + ' / 同行同字面量合并 ' + c.merged)
  t.diagnostic('按形态 = ' + JSON.stringify(COLLECTED.byForm) + '；按排除理由 = ' + JSON.stringify(COLLECTED.byReason))
  assert.equal(c.probeWithSite + c.probeWithoutSite, c.probe, '★ 粗扫候选行的分区不闭合（有行被静默丢掉）')
  assert.equal(c.included + c.excluded + c.merged, c.sites, '★ 站点没有全部归类（收录 + 排除 + 合并 ≠ 站点总数）')
  const floors = formFloorFailures(COLLECTED.byForm, c.probe)
  assert.deepEqual(floors, [], '★ 判据空跑：\n  ' + floors.join('\n  '))
  // 目标文件必须真的多样（否则"回溯到哪个文件"这件事等于没验）
  const targets = new Set(COLLECTED.included.map((a) => a.targetFile))
  assert.ok(targets.size >= 2, '收录锚点只回溯到 ' + targets.size + ' 个目标文件 —— 回溯没起作用')
})

test('④-1 收录的锚点必须仍然在它的目标文件里（点名到最小单位）', () => {
  const bad = anchorFailures(COLLECTED.included, COLLECTED.spans, READ_TARGET)
  assert.deepEqual(bad, [], '★ 这些「按源码内容定位端点」的锚点失效了（切片会变成空串或负索引，断言会静默放绿）：\n  ' + bad.join('\n  '))
})

test('④-1b 双端点的切片：顺序正确、切下来的片段非空', () => {
  const bad = sliceSpanFailures(COLLECTED.spans, READ_TARGET)
  assert.deepEqual(bad, [], '★ 这些切片的端点顺序/内容不对：\n  ' + bad.join('\n  '))
  assert.ok(COLLECTED.spans.length >= 10, '只扫到 ' + COLLECTED.spans.length + ' 处切片 —— 判据空跑')
})

test('④-2 排除项必须站得住（按形态排除，不是白名单）', () => {
  const bad = exclusionCrossCheck(COLLECTED, sliceTargets(TEST_SOURCES))
  assert.deepEqual(bad, [], '★ 排除理由站不住的条目：\n  ' + bad.join('\n  '))
  const c = COLLECTED.counts
  assert.ok(c.excluded > 0, '一条都没排除 —— 去噪规则没生效（或它把所有东西都放进来了）')
  assert.ok(c.included > 0, '一条都没收录 —— 判据空跑')
})

test('④-3 反证：锚点消失 / 顺序反了 / 切片只剩端点，都必须被点名', () => {
  // 正常样本：两端点都在、顺序正确、中间有内容
  const good = [
    "const SRC = fs.readFileSync('lib/index.js', 'utf8')",
    "const a = SRC.indexOf('function alpha(')",
    "const b = SRC.indexOf('function beta(', a)",
    'const seg = SRC.slice(a, b)',
  ].join('\n')
  const gIdx = fileIndex('t.test.js', good)
  const gSpans = sliceSpans(gIdx)
  const gInc = classifySites(literalAnchorSites(gIdx), gSpans).included
  const OK_TARGET = 'function alpha( ……中间有内容…… function beta('
  assert.deepEqual(anchorFailures(gInc, gSpans, () => OK_TARGET), [], '正常样本不该报红')
  assert.deepEqual(sliceSpanFailures(gSpans, () => OK_TARGET), [], '正常样本的切片不该报红')

  // ① 端点被改名/挪走 ⇒ 必须点名到最小单位，且带上该切片的另一端
  const gone = anchorFailures(gInc, gSpans, () => 'function beta( 只剩它了')
  assert.equal(gone.length, 1, '端点消失必须报红，实际=' + JSON.stringify(gone))
  assert.match(gone[0], /^t\.test\.js:2 的锚点 "function alpha\(" 在 lib\/index\.js 里找不到了/, '报红必须点名到最小单位（测试文件:行 + 字面量 + 目标文件）')
  assert.match(gone[0], /另一端 "function beta\(/, '报红必须带上该切片的另一端，便于定位')

  // ② 端点顺序反了（一行式、且第二个 `indexOf` 没有 start 参数 ⇒ 真的会切出反向区间）
  const rev = [
    "const SRC = fs.readFileSync('lib/index.js', 'utf8')",
    "const seg = SRC.slice(SRC.indexOf('BBBBB'), SRC.indexOf('AAAAA'))",
  ].join('\n')
  const rIdx = fileIndex('r.test.js', rev)
  const rSpans = sliceSpans(rIdx)
  const rOne = sliceSpanFailures(rSpans, () => 'AAAAA ……中间有内容…… BBBBB')
  assert.equal(rOne.length, 1, '端点顺序反了必须报红，实际=' + JSON.stringify(rOne))
  assert.match(rOne[0], /^r\.test\.js:2 的切片端点顺序反了/)

  // ③ 两端点落在同一处（中间什么都没有）⇒ 切出来只剩端点
  const deg = [
    "const SRC = fs.readFileSync('lib/index.js', 'utf8')",
    "const seg = SRC.slice(SRC.indexOf('AAAAA'), SRC.indexOf('BBBBB'))",
  ].join('\n')
  const dIdx = fileIndex('d.test.js', deg)
  const dSpans = sliceSpans(dIdx)
  const dOne = sliceSpanFailures(dSpans, () => 'AAAAABBBBB')
  assert.equal(dOne.length, 1, '中间没有内容必须报红，实际=' + JSON.stringify(dOne))
  assert.match(dOne[0], /^d\.test\.js:2 的切片只剩端点本身/)

  // ④ 目标文件读不到 ⇒ 也必须点名（不是静默跳过）
  const unreadable = anchorFailures(gInc, gSpans, () => null)
  assert.equal(unreadable.length, 2, '目标文件读不到时两个锚点都要点名，实际=' + JSON.stringify(unreadable))
  assert.match(unreadable[0], /读不到/)
})

test('④-4 反证：新加一处形态相同的锚点必须被**自动纳入**（不然就是手抄清单）', () => {
  const files = [
    { name: 't.test.js', text: "const SRC = fs.readFileSync('lib/index.js', 'utf8')\n" },
    { name: 'u.test.js', text: [
      "import fs from 'node:fs'",
      "const SRC = fs.readFileSync('lib/index.js', 'utf8')",
      "test('x', () => {",
      "  const a = SRC.indexOf('AAAAA')",
      "  const b = SRC.indexOf('BBBBB', a)",
      '  SRC.slice(a, b)',
      '})',
    ].join('\n') },
  ]
  const before = collectLiteralAnchors(files)
  assert.deepEqual(before.included.map((x) => x.literal).sort(), ['AAAAA', 'BBBBB'], '新加的成对锚点必须被自动纳入')
  assert.ok(before.included.every((x) => x.form === 'pair' && x.targetFile === 'lib/index.js'), '形态/目标文件必须自动判定对')
  // 再加一处一行式 ⇒ 也必须被自动纳入（不需要改判据）
  const files2 = [...files, { name: 'v.test.js', text: "const SRC = fs.readFileSync('lib/index.js', 'utf8')\nconst seg = SRC.slice(SRC.indexOf('CCCCC'), SRC.indexOf('DDDDD'))\n" }]
  const after = collectLiteralAnchors(files2)
  assert.deepEqual(after.byForm, { pair: 2, inline: 2 }, '新增的一行式锚点必须自动归类为 inline，实际=' + JSON.stringify(after.byForm))
})

test('④-5 反证：某一类 0 命中必须报红（"扩了面但一条没看"）', () => {
  assert.deepEqual(formFloorFailures({ pair: 20, inline: 10, helper: 10 }, 96), [], '达标时不该报红')
  const bad = formFloorFailures({ pair: 20, inline: 10, helper: 0 }, 96)
  assert.equal(bad.length, 1, 'helper 类 0 命中必须报红，实际=' + JSON.stringify(bad))
  assert.match(bad[0], /^helper 只收录 0 处/)
  const bad2 = formFloorFailures({ pair: 0, inline: 0, helper: 0 }, 0)
  assert.equal(bad2.length, 4, '三类 + 探针全空必须各报一条，实际=' + JSON.stringify(bad2))
})
