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

// ════════════════════════════════════════════════════════════════════
// ⑤ 「对搬迁追踪文件做源码**内容断言**」这一类（第三类锚点，整类机器门禁）
//
// 为什么单独立这一节（task-15；背景见 HANDOFF-LEAD §7.9 / §7.10）：
//   ④ 覆盖的是「按源码内容**定位一个区间**」（`indexOf` + `slice` / `extractFnSource`），
//   它按形态把「不喂切片的 indexOf」当作 `not-a-region-endpoint` **排除**掉了。
//   而测试里还有一整类**存在性 / 内容断言**：直接拿源码文本
//   `<src>.includes('…')` / `<src>.match(/…/)` / `/…/.test(<src>)` / `assert.match(<src>, /…/)`
//   断言「某个块还在 index.js 里」。第三块（`2f7d534`）搬走 `state` 路由时，红的就是这一类 ——
//   而它当时的**失效形态是「晚 + 无归属」**：断言要等全量测试才红，报错信息说的是
//   「tavern:nsfw 槽位必须存在」这种**指不到搬迁**的话，得靠人再 grep 一遍才知道"是被搬走了"。
//   本节把这一类变成常驻判据，**归属点得到最小单位**（`测试文件:行` + needle + 目标文件 + 它现在在哪儿）。
//
// 判据怎么工作（一句话）：**needle 必须在它被断言的那个文件里；查不到、但能在别的 lib 文件里查到
// ⇒ 报红**。这条只在"内容换了个文件"时报红，恰是本类要抓的失效形态；负向断言
// （断言某样东西到处都没有，例如 `nsfw-slot ⑭` 的破限词表）**结构上不会触发**（见 ⑤-5）。
//
// 去噪**按规则做，不是白名单**（逐条交叉验证见 ⑤-2）：
//   ① `needle` 不是字面量（目标串由变量拼出 / 一行里塞了多个参数）⇒ 排除，理由 `needle-not-literal`；
//   ② **负向断言**（表达式紧邻左边是 `!`，如 `assert.ok(!src.includes('…'))`、`assert.doesNotMatch`）
//      ⇒ 排除，理由 `negated-assertion`（"这东西不许出现"没有"跟到新文件"这回事）；
//   ③ 接收者回溯不到「被测试读进来的仓库文件」，或回溯到**非追踪目标** ⇒ 排除，理由 `receiver-not-tracked`；
//   ④ needle 是**裸字符类**（`/[a-z]/` 这种逐字符分类器）⇒ 排除，理由 `per-char-class`；
//   ⑤ `.test(<base>[i])` —— 接收者是**一个字符**不是源码文本 ⇒ 排除，理由 `element-access`。
// 追踪目标是一条**规则**（不是逐条白名单）：`lib/index.js` + `lib/server/*.js` ——
//   即「搬迁会动的服务端源码」（AGENTS §5 / §5.1）。`lib/client.manager.bundle.js` **不在内**：
//   它是单文件源码、**没有搬迁轴**（AGENTS §4），本类的失效形态对它不存在；它的 markup / 转义断言
//   另有 `check-client-integrity` 与 `check-innerhtml-escape` 两条常驻门禁。
// 接收者可以是**从追踪文件里切出来的一段**（`const src = INDEX_SRC.slice(a, b)` / `seg = src.slice(…)`）——
//   它上面的断言仍然是"对那个文件**内容**的断言"，所以沿一个 `slice(` 跳继续回溯（见 `resolveSourceFile`）。
//
// ★ 已知未覆盖（边界要写清，见 ⑤ 段末的"能力边界"注释）：接收者由**自定义切片助手**产出的站点
//   （例：`memory-isolation.test.js` 的 `INJECT_BLOCK = sliceBetween(…)`）不在收录内 —— 那不是
//   静态可判的 `readFileSync` / `slice` 形态；那个块的**存在性**由本文件 ② 的锚点
//   （`const targetSid = lastSessionId` 等）与 memory-isolation 自身守着。
// ════════════════════════════════════════════════════════════════════

/** ⑤ 追踪目标（**规则**，不是逐条白名单；见节首说明）。 */
export const TRACKED_TARGET_RE = /^lib\/(?:index\.js|server\/[a-z0-9-]+\.js)$/

/** ⑤ 的字面量下限：needle 至少这么长，短到这个级别的东西不构成"内容"（也是防 `/[a-z]/` 那一档）。 */
const NEEDLE_MIN = 5

/** 正则字面量（与 ④ 的 `RE_LITERAL` 同口径；只用于**整体**匹配一个实参表达式）。 */
const RE_LIT_SRC = /\/(?:\\.|\[(?:\\.|[^\]\n\\])*\]|[^/\n\\])+\/[gimsuy]*/.source

/**
 * ④ 的 `fileFromExpr` 在「路径变量名恰好等于某个路径段字面量」时会数出两个 `.js` 段并放弃回溯。
 * 实例（实测）：`nsfw-slot.test.js` 里有 `const lib = await import(…'lib/index.js'…)`，
 * 于是它后面所有 `const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')`
 * 都回溯成 null（段序列成了 `lib/index.js` + `lib` + `index.js`）⇒ 那一批站点会被**静默漏掉**。
 * 本节的补充解析把**重复的段去掉**再判；④ 自己的行为不动（改它会让 ④ 的收录/排除计数漂）。
 */
export function fileFromExprDedup(expr, pathVars) {
  const base = String(expr).replace(/\s+/g, ' ')
  if (/\.\s*(?:indexOf|lastIndexOf|slice|split|includes|replace|startsWith|endsWith|match|test|trim)\s*\(/.test(base)) return null
  const lits = [...base.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])
  const direct = lits.filter((s) => s && !/\s/.test(s) && (/\.js$/.test(s) || ['lib', 'server', 'tests', 'tools', '.'].includes(s)))
  const named = [...base.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((n) => pathVars.has(n))
  const segs = []
  for (const s of [...named.map((n) => pathVars.get(n)), ...direct]) {
    for (const p of String(s).split('/')) if (p && p !== '.' && p !== '..') segs.push(p)
  }
  const uniq = [...new Set(segs)]
  const js = uniq.filter((s) => s.endsWith('.js'))
  if (js.length !== 1) return null
  const at = uniq.lastIndexOf(js[0])
  return uniq.slice(Math.max(0, at - 2), at + 1).join('/')
}

/**
 * 接收者 → 仓库文件。三档（口径见节首）：
 *   ① ④ 的 `resolveTarget`（直读 / 形参 / 路径变量，口径与 ④ 一致）；
 *   ② ⑤ 的补充解析 `fileFromExprDedup`（治"路径变量名与路径段同名"那一档漏读）；
 *   ③ **段派生**：`const seg = <已知源码变量>.slice(a, b)` —— `seg` 的内容是目标文件里的一段，
 *      所以它上面的 `includes(…)` / `.test(…)` 仍然是"对那个文件的**内容**断言"。
 *      ⚠️ 只跟**一个 `slice(` 跳**：`x.match(…)` / `x.replace(…)` 之类的产物**不是**源码文本
 *      （跟着它们走会把"对匹配结果的断言"误当成"对源码内容的断言"）。
 */
export function resolveSourceFile(idx, base, line) {
  let cur = base
  let at = line
  for (let hop = 0; hop < 3; hop++) {
    const direct = resolveTarget(idx, cur, at)
    if (direct) return direct
    const d = idx.decls.filter((x) => x.name === cur && x.line <= at).pop()
    if (!d) return null
    if (/readFileSync\s*\(|new URL\s*\(/.test(d.flat)) {
      const f = fileFromExprDedup(d.expr, idx.pathVars)
      if (f) return f
    }
    const seg = /^\s*([A-Za-z_$][\w$]*)\s*\.\s*slice\s*\(/.exec(d.flat)
    if (!seg || seg[1] === cur) return null
    cur = seg[1]
    at = d.line
  }
  return null
}

/**
 * 从一段文本的**开头**取 needle（纯字符串字面量 / 正则字面量），返回 `{ needle, end }`；取不到 ⇒ null。
 * ⚠️ 为什么不复用 ④ 的 `argListAt`：它不认**实参里的正则字面量** —— 正则体里的 `(` / `)` / 引号会
 * 把它的括号配平带歪（实测 `src.match(/nsfwPrompt:\s*('[^']*'|"[^"]*")/)` 会被截成
 * `/nsfwPrompt:\s*('[^']*'|"[^"]`，于是 needle 解析成 null 而**静默漏掉一条站点**）。
 * 本类要断言的就是这类正则，所以这里改用"从实参开头直接读一个字面量"的方式。
 */
export function needleAtHead(text) {
  const raw = String(text).replace(/^\s*/, '')
  const lit = scanStringLiteral(raw, 0)
  if (lit) return lit.value.length >= NEEDLE_MIN ? { needle: { kind: 'str', value: lit.value }, end: lit.end } : null
  const m = new RegExp('^' + RE_LIT_SRC).exec(raw)
  if (!m) return null
  const cut = m[0].lastIndexOf('/')
  const body = m[0].slice(1, cut)
  if (body.length < NEEDLE_MIN) return null
  return { needle: { kind: 're', re: new RegExp(body, m[0].slice(cut + 1)) }, end: m[0].length }
}

/** 一个**完整**实参表达式 → needle；表达式不是单个字面量（拼接/多参）或太短 ⇒ null。 */
export function needleOf(argText) {
  const raw = String(argText).trim()
  const head = needleAtHead(raw)
  if (!head) return null
  return head.end === raw.length ? head.needle : null
}

/** needle 在文本里的命中年数（字符串按出现次数、正则按 0/1）。 */
export function needleHitCount(needle, text) {
  if (needle == null || text == null) return 0
  return needle.kind === 'str' ? text.split(needle.value).length - 1 : (needle.re.test(text) ? 1 : 0)
}

export function describeNeedle(n) {
  return n == null ? '（无）' : (n.kind === 'str' ? JSON.stringify(n.value) : '/' + n.re.source + '/')
}

/** 一个测试文件里的全部「内容断言」候选站点（含将被排除的 —— 收录/排除由 classifyContentSites 判）。 */
export function contentAssertSites(idx) {
  const { masked } = idx
  const lineAt = (i) => offsetLine(masked, i)
  // 极性标记：站点表达式**紧邻的左边**是 `!` ⇒ 这是**负向断言**（"这东西不许出现"）。
  // 只认紧邻的 `!`（`!=` / `!==` 时紧邻的是 `=`，不会误判），不猜别的形态。
  const negAt = (i) => /!\s*$/.test(masked.slice(Math.max(0, i - 3), i))
  const raw = []
  const add = (o) => raw.push({ file: idx.name, ...o })

  // (a) `<base>.includes(<实参>)` / (b) `<base>.match(<实参>)`
  for (const form of ['includes', 'match']) {
    const CALL = new RegExp('([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*\\.\\s*' + form + '\\s*\\(', 'g')
    let m
    while ((m = CALL.exec(masked))) {
      const receiver = m[1].replace(/\s+/g, '')
      const base = receiver.split('.')[0]
      const line = lineAt(m.index)
      const open = m.index + m[0].length - 1
      const head = needleAtHead(masked.slice(open + 1))   // 只读**第一个实参**的字面量头（不靠 argListAt）
      add({
        line, form, receiver, base, needle: head ? head.needle : null,
        negated: negAt(m.index),
        file2: resolveSourceFile(idx, base, line),
        raw: masked.slice(open + 1, open + 71).split('\n')[0],
      })
    }
  }
  // (c) `/<re>/.test(<base>)` —— 接收者是**一个字符**的形态标记为 evidence，按规则排除
  const RT = new RegExp('(' + RE_LIT_SRC + ')\\s*\\.\\s*test\\s*\\(\\s*([A-Za-z_$][\\w$]*)', 'g')
  let m
  while ((m = RT.exec(masked))) {
    const line = lineAt(m.index)
    add({
      line, form: 'test', receiver: m[2], base: m[2], needle: needleOf(m[1]),
      negated: negAt(m.index),
      file2: resolveSourceFile(idx, m[2], line),
      evidence: masked[RT.lastIndex] === '[' ? 'element-access' : null,
      raw: m[1],
    })
  }
  // (d) `assert.match(<base>, <实参>)` / `assert.doesNotMatch(...)`（后者标负向）
  const AM = /(assert\.(?:doesNot)?[mM]atch)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*/g
  while ((m = AM.exec(masked))) {
    const line = lineAt(m.index)
    const tail = masked.slice(m.index + m[0].length)
    const head = needleAtHead(tail)
    add({
      line, form: 'assert.match', receiver: m[2], base: m[2],
      needle: head ? head.needle : null,
      negated: /doesNot/.test(m[1]),
      file2: resolveSourceFile(idx, m[2], line),
      raw: tail.slice(0, 70).split('\n')[0],
    })
  }
  return raw
}

/** 站点 → 收录 / 排除。**按规则排除**（规则见节首；⑤-2 逐条交叉验证）。 */
export function classifyContentSites(sites) {
  const included = []
  const excluded = []
  for (const s of sites) {
    if (s.needle == null) { excluded.push({ ...s, reason: 'needle-not-literal' }); continue }
    if (s.negated) { excluded.push({ ...s, reason: 'negated-assertion' }); continue }
    if (s.evidence === 'element-access') { excluded.push({ ...s, reason: 'element-access' }); continue }
    if (s.needle.kind === 're' && /^\[[^\]]*\]$/.test(s.needle.re.source)) { excluded.push({ ...s, reason: 'per-char-class' }); continue }
    if (s.file2 == null || !TRACKED_TARGET_RE.test(s.file2)) { excluded.push({ ...s, reason: 'receiver-not-tracked' }); continue }
    included.push({ ...s, target: s.file2 })
  }
  return { included, excluded }
}

/** 汇总：站点 / 收录 / 排除 / 各类计数（全部机械派生）。 */
export function collectContentAsserts(files) {
  const sites = []
  for (const f of files) sites.push(...contentAssertSites(fileIndex(f.name, f.text)))
  const { included, excluded } = classifyContentSites(sites)
  const byForm = {}
  for (const a of included) byForm[a.form] = (byForm[a.form] ?? 0) + 1
  const byTarget = {}
  for (const a of included) byTarget[a.target] = (byTarget[a.target] ?? 0) + 1
  const byReason = {}
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1
  const excludedTargets = {}
  for (const e of excluded) {
    if (e.reason !== 'receiver-not-tracked' || !e.file2) continue
    excludedTargets[e.file2] = (excludedTargets[e.file2] ?? 0) + 1
  }
  return {
    sites, included, excluded, byForm, byTarget, byReason, excludedTargets,
    counts: { sites: sites.length, included: included.length, excluded: excluded.length },
  }
}

/** 判据：needle 必须在**它的目标文件**里；查不到、但能在别的 lib 文件里查到 ⇒ 搬家没跟，点名到最小单位。 */
export function contentAssertFailures(sites, readTarget, listLib) {
  const cache = new Map()
  const read = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readTarget(rel))
    return cache.get(rel)
  }
  const out = []
  for (const s of sites) {
    const src = read(s.target)
    if (src == null) {
      out.push(s.file + ':' + s.line + ' 的目标文件 ' + s.target + ' 读不到 —— 这条内容断言无法复查（判据不静默放绿）')
      continue
    }
    if (needleHitCount(s.needle, src) > 0) continue
    const moved = (listLib() ?? []).filter((rel) => rel !== s.target && needleHitCount(s.needle, read(rel)) > 0)
    // 到处都没有 ⇒ 不是"搬家"，而是"这条断言本来就该红"（原测试会点名）。见 ⑤-5 的边界说明。
    if (!moved.length) continue
    out.push(
      s.file + ':' + s.line + ' 的 ' + s.form + ' 断言 ' + describeNeedle(s.needle) +
      ' 在 ' + s.target + ' 里找不到了 —— 它现在在 ' + moved.join(' / ') +
      '（把内容搬走时，这条断言必须**与搬迁同笔跟到新文件**）',
    )
  }
  return out
}

/**
 * ⑤ 的非空跑下限（低于下限 ⇒ 判据空跑即失败）。口径：**实测值 + 命令**写在 ⑤-0 的 diagnostic 里
 * （本笔实测：收录 25 处 = includes 11 / test 11 / match 1 / assert.match 2；目标分布
 *   `lib/index.js` 19 / `lib/server/routes.js` 4 / `lib/server/state.js` 2），
 * 下限取实测的 ~80%，既能挡住"整类判据失效"，又不会因为合法地少了几处站点而误红。
 */
export const CONTENT_SITE_FLOOR = 20
export const CONTENT_FORM_FLOORS = { includes: 9, match: 1, test: 8, 'assert.match': 1 }
export const CONTENT_INDEX_FLOOR = 15

export function contentFloorFailures(byForm, total, byTarget) {
  const bad = []
  if (total < CONTENT_SITE_FLOOR) bad.push('只收录 ' + total + ' 处内容断言（下限 ' + CONTENT_SITE_FLOOR + '）—— 这一类判据空跑')
  for (const form of Object.keys(CONTENT_FORM_FLOORS)) {
    const got = byForm[form] ?? 0
    if (got < CONTENT_FORM_FLOORS[form]) bad.push(form + ' 形只收录 ' + got + ' 处（下限 ' + CONTENT_FORM_FLOORS[form] + '）')
  }
  const idx = byTarget['lib/index.js'] ?? 0
  if (idx < CONTENT_INDEX_FLOOR) bad.push('落在 lib/index.js 上的站点只剩 ' + idx + ' 处（下限 ' + CONTENT_INDEX_FLOOR + '）—— 本类判据的主要失效面已失守')
  if (Object.keys(byTarget).length < 2) bad.push('收录站点只回溯到 ' + Object.keys(byTarget).length + ' 个目标文件 —— 回溯没起作用')
  return bad
}

/** ⑤-2 的交叉验证：被排除的站点**不该**落在追踪目标上（理由要站得住，不是白名单豁免）。 */
export function contentExclusionCrossCheck(collected) {
  const bad = []
  for (const e of collected.excluded) {
    const where = e.file + ':' + e.line + ' ' + describeNeedle(e.needle)
    if (e.reason === 'receiver-not-tracked') {
      if (e.file2 != null && TRACKED_TARGET_RE.test(e.file2)) bad.push(where + ' 被排除为 receiver-not-tracked，但它的目标 ' + e.file2 + ' 是追踪目标')
    } else if (e.reason === 'needle-not-literal') {
      if (e.needle != null) bad.push(where + ' 被排除为 needle-not-literal，但 needle 解析出来了')
    } else if (e.reason === 'negated-assertion') {
      if (e.negated !== true) bad.push(where + ' 被排除为 negated-assertion，但它不是负向断言')
    } else if (e.reason === 'per-char-class') {
      if (!(e.needle && e.needle.kind === 're' && /^\[[^\]]*\]$/.test(e.needle.re.source))) bad.push(where + ' 被排除为 per-char-class，但它不是裸字符类')
    } else if (e.reason === 'element-access') {
      if (e.evidence !== 'element-access') bad.push(where + ' 被排除为 element-access，但没有元素下标证据')
    } else {
      bad.push(where + ' 用了未登记的排除理由：' + e.reason)
    }
  }
  return bad
}

/**
 * 显式 allowlist（**当前 0 条**）：确实不该被"跟到新文件"这条规则管的站点，逐条带理由登记。
 * 两条要求：① 每条必须有非空 `reason`；② 每条必须**仍然命中一个真实站点**（否则就是陈旧白名单 ——
 * 白名单漂了比没有白名单更危险）。反证见 ⑤-7。
 */
export const CONTENT_ALLOWLIST = []

export function allowlistProblems(list, sites) {
  const out = []
  for (const e of list) {
    if (!e.reason || !String(e.reason).trim()) out.push('allowlist 条目缺理由：' + e.file + ':' + e.line)
    if (!sites.some((s) => s.file === e.file && s.line === e.line)) out.push('allowlist 条目已对不上任何站点（陈旧）：' + e.file + ':' + e.line)
  }
  return out
}

/** 判据对象：allowlist 里的站点不参与"必须跟"的检查。 */
export function allowedSiteFilter(sites, list) {
  return sites.filter((s) => !list.some((e) => e.file === s.file && e.line === s.line))
}

const LIB_FILE_LIST = (() => {
  const out = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const p = rel + '/' + e.name
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) out.push(p)
    }
  }
  walk('lib')
  return out.sort()
})()

const CONTENT = collectContentAsserts(TEST_FILE_TEXTS)

test('⑤-0 计数与下限：站点 → 收录 → 排除 必须是机械恒等式', (t) => {
  const c = CONTENT.counts
  t.diagnostic('内容断言候选站点 = ' + c.sites + ' → 收录 ' + c.included + ' / 排除 ' + c.excluded)
  t.diagnostic('按形态 = ' + JSON.stringify(CONTENT.byForm) + '；按目标文件 = ' + JSON.stringify(CONTENT.byTarget))
  t.diagnostic('按排除理由 = ' + JSON.stringify(CONTENT.byReason) + '；其中 receiver-not-tracked 的目标分布 = ' + JSON.stringify(CONTENT.excludedTargets))
  assert.equal(c.included + c.excluded, c.sites, '★ 站点没有全部归类（收录 + 排除 ≠ 站点总数）')
  const floors = contentFloorFailures(CONTENT.byForm, c.included, CONTENT.byTarget)
  assert.deepEqual(floors, [], '★ 判据空跑：\n  ' + floors.join('\n  '))
  assert.ok(LIB_FILE_LIST.length >= 10, 'lib/ 下只列出 ' + LIB_FILE_LIST.length + ' 个 .js —— "现在在哪儿"的回溯面读不到')
})

test('⑤-1 收录的内容断言：needle 必须仍在它被断言的那个文件里（点名到最小单位）', () => {
  const bad = contentAssertFailures(allowedSiteFilter(CONTENT.included, CONTENT_ALLOWLIST), READ_TARGET, () => LIB_FILE_LIST)
  assert.deepEqual(
    bad,
    [],
    '★ 这些「对搬迁追踪文件做源码内容断言」的站点失效了（内容换了文件，断言留在原处 —— 报错信息指不到搬迁）：\n  ' + bad.join('\n  '),
  )
})

test('⑤-2 排除项必须站得住（按规则排除，不是白名单）', () => {
  const bad = contentExclusionCrossCheck(CONTENT)
  assert.deepEqual(bad, [], '★ 排除理由站不住的条目：\n  ' + bad.join('\n  '))
  assert.ok(CONTENT.counts.excluded > 0, '一条都没排除 —— 去噪规则没生效')
  assert.ok(CONTENT.counts.included > 0, '一条都没收录 —— 判据空跑')
})

test('⑤-3 allowlist 自身必须是干净的（当前 ' + CONTENT_ALLOWLIST.length + ' 条）', () => {
  assert.deepEqual(allowlistProblems(CONTENT_ALLOWLIST, CONTENT.sites), [], '★ allowlist 有问题（缺理由 / 已陈旧）')
})

test('⑤-4 反证：needle 被搬到**别的文件** ⇒ 必须点名 [测试文件:行] 并指出它现在在哪儿', () => {
  const src = [
    "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')",
    "test('x', () => { assert.ok(SRC.includes('SENTINEL-KEEP-ME')) })",
  ].join('\n')
  const idx = fileIndex('t.test.js', src)
  const { included } = classifyContentSites(contentAssertSites(idx))
  assert.equal(included.length, 1, '站点必须被自动收录，实际=' + JSON.stringify(included.map((s) => s.file + ':' + s.line)))
  assert.equal(included[0].target, 'lib/index.js', '目标文件必须自动判定对')
  const TREE = { 'lib/index.js': '别的都还在\n', 'lib/server/routes.js': "SENTINEL-KEEP-ME\n" }
  const list = () => Object.keys(TREE)
  const read = (rel) => TREE[rel] ?? null
  // ① 内容还在目标文件里 ⇒ 绿
  assert.deepEqual(contentAssertFailures(included, () => 'SENTINEL-KEEP-ME\n', list), [], '内容没动时不该报红')
  // ② 内容被搬到 routes.js ⇒ 必须点名 file:line + needle + 目标文件 + 新位置
  const bad = contentAssertFailures(included, read, list)
  assert.equal(bad.length, 1, '搬家未跟必须报红，实际=' + JSON.stringify(bad))
  assert.match(bad[0], /^t\.test\.js:2 的 includes 断言 "SENTINEL-KEEP-ME" 在 lib\/index\.js 里找不到了/, '报红必须点名到最小单位（测试文件:行 + 形态 + needle + 目标文件）')
  assert.match(bad[0], /它现在在 lib\/server\/routes\.js/, '报红必须指出内容现在在哪个文件')
})

test('⑤-5 边界：负向断言按规则排除；needle 到处都没有时**不报红**（判据不恒真）', () => {
  // (a) `assert.ok(!SRC.includes('X'))` ⇒ 带 `!` 极性 ⇒ 按规则排除（负向断言不需要"跟到新文件"）
  const neg = fileIndex('n.test.js', "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')\nassert.ok(!SRC.includes('SENTINEL-BANNED'))\n")
  const negSites = contentAssertSites(neg)
  const negOut = classifyContentSites(negSites).excluded.filter((s) => s.line === 2)
  assert.equal(negOut.length, 1, '负向断言必须被识别为站点再按规则排除，实际=' + JSON.stringify(classifyContentSites(negSites).included.map((s) => s.line)))
  assert.equal(negOut[0].reason, 'negated-assertion', '排除理由必须是 negated-assertion')
  // 对照：同一行去掉 `!` ⇒ 必须被**收录**（否则上面那条"排除"是恒真）
  const pos = fileIndex('p.test.js', "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')\nassert.ok(SRC.includes('SENTINEL-KEEP'))\n")
  assert.equal(classifyContentSites(contentAssertSites(pos)).included.length, 1, '对照：正向断言必须被收录')
  // 对照：`!=` 不该被当成负向断言
  const neq = fileIndex('q.test.js', "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')\nconst hit = SRC !== null\n")
  assert.equal(contentAssertSites(neq).length, 0, '`!==` 不该被误当成负向断言站点（本行根本没有内容断言）')

  // (b) 判据本身：needle 到处都没有时**不报红**（这是"内容换了文件"与"内容本来就该没有"的划界）
  const st = { file: 'n.test.js', line: 2, form: 'includes', target: 'lib/index.js', needle: { kind: 'str', value: 'SENTINEL-BANNED' } }
  const lib = () => ['lib/index.js', 'lib/server/routes.js']
  assert.deepEqual(contentAssertFailures([st], () => '什么都没写\n', lib), [], '★ 到处都查不到 ⇒ 这不是"搬家"，本判据不许报红')
  const moved = contentAssertFailures([st], (rel) => (rel === 'lib/server/routes.js' ? 'SENTINEL-BANNED\n' : 'x\n'), lib)
  assert.equal(moved.length, 1, '对照：同一站点一旦被搬到别处就必须红（否则上面那个"绿"是恒真）')
})

test('⑤-6 反证：新加一处同形态站点必须被**自动纳入**（不然就是手抄清单）', () => {
  const before = collectContentAsserts(TEST_FILE_TEXTS.filter((f) => f.name === 'server-state-paths.test.js'))
  const extra = { name: 'zz.test.js', text: "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'server', 'routes.js'), 'utf8')\nconst x = /SENTINEL-NEW-ANCHOR/.test(SRC)\n" }
  const after = collectContentAsserts([...TEST_FILE_TEXTS, extra])
  const hit = after.included.filter((s) => s.file === 'zz.test.js')
  assert.equal(hit.length, 1, '新加的站点必须被自动纳入，实际=' + JSON.stringify(hit.map((s) => s.file + ':' + s.line)))
  assert.equal(hit[0].target, 'lib/server/routes.js', '目标文件必须自动判定对')
  assert.equal(hit[0].form, 'test', '形态必须自动判定对')
  assert.ok(before.included.length > 0, '对照：原文件本来就该有站点（否则这条反证的"自动纳入"没有参照）')
})

test('⑤-7 反证：形态 / 总数 / 目标文件的下限各报一条；陈旧或没理由的 allowlist 必须报红', () => {
  const OK = { includes: 11, match: 1, test: 11, 'assert.match': 2 }          // 实测 25
  const TWO = { 'lib/index.js': 19, 'lib/server/routes.js': 4, 'lib/server/state.js': 2 }
  assert.deepEqual(contentFloorFailures(OK, 25, TWO), [], '达标时不该报红')
  const empty = contentFloorFailures({}, 0, {})
  assert.ok(empty.length >= 5, '全空必须逐条报（总数 / 四个形态 / index.js / 目标多样性），实际=' + JSON.stringify(empty))
  assert.match(empty[0], /只收录 0 处内容断言/)
  const oneForm = contentFloorFailures({ includes: 11, match: 1, 'assert.match': 2 }, 25, TWO)
  assert.equal(oneForm.length, 1, 'test 形 0 命中必须单独报一条，实际=' + JSON.stringify(oneForm))
  assert.match(oneForm[0], /^test 形只收录 0 处/)
  // 目标里没有 index.js（但仍有两个不同目标 ⇒ 多样性那条不响）⇒ 恰好一条
  const noIdx = contentFloorFailures(OK, 25, { 'lib/server/routes.js': 20, 'lib/server/state.js': 5 })
  assert.equal(noIdx.length, 1, '落在 index.js 上的站点为 0 必须报一条，实际=' + JSON.stringify(noIdx))
  assert.match(noIdx[0], /落在 lib\/index\.js 上的站点只剩 0 处/)
  // 目标只剩一个文件 ⇒ 多样性那条单独响
  const oneTarget = contentFloorFailures(OK, 25, { 'lib/index.js': 25 })
  assert.equal(oneTarget.length, 1, '目标只回溯到 1 个文件必须报一条，实际=' + JSON.stringify(oneTarget))
  assert.match(oneTarget[0], /回溯没起作用/)
  // allowlist：缺理由 / 陈旧 两条都要点名
  const sites = [{ file: 'a.test.js', line: 3 }]
  assert.deepEqual(allowlistProblems([{ file: 'a.test.js', line: 3, reason: '这条断言的是"内容仍在 lib 任意文件里"，与具体文件无关' }], sites), [])
  const badAl = allowlistProblems([{ file: 'a.test.js', line: 3 }, { file: 'b.test.js', line: 9, reason: 'x' }], sites)
  assert.equal(badAl.length, 2, '缺理由 + 陈旧各报一条，实际=' + JSON.stringify(badAl))
  assert.match(badAl[0], /allowlist 条目缺理由/)
  assert.match(badAl[1], /已对不上任何站点/)
  // allowlist 生效路径：被登记的站点不参与"必须跟"的检查（否则列表只是摆设）
  const st = { file: 'a.test.js', line: 3, target: 'lib/index.js', needle: { kind: 'str', value: 'SENTINEL-MOVED' } }
  const read = (rel) => (rel === 'lib/server/routes.js' ? 'SENTINEL-MOVED\n' : 'x\n')
  const lib = () => ['lib/index.js', 'lib/server/routes.js']
  assert.equal(contentAssertFailures([st], read, lib).length, 1, '对照：没登记时该红')
  assert.equal(contentAssertFailures(allowedSiteFilter([st], [{ file: 'a.test.js', line: 3, reason: 'r' }]), read, lib).length, 0, '登记后不再参与检查')
})

test('⑤-8 反证：目标文件读不到必须点名（不许静默跳过）', () => {
  const src = "const SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')\nassert.ok(SRC.includes('SENTINEL-X'))\n"
  const { included } = classifyContentSites(contentAssertSites(fileIndex('u.test.js', src)))
  const bad = contentAssertFailures(included, () => null, () => [])
  assert.equal(bad.length, 1, '目标文件读不到时必须点名，实际=' + JSON.stringify(bad))
  assert.match(bad[0], /目标文件 lib\/index\.js 读不到/)
})
