/**
 * 作用域完备性门禁：`lib/server/routes.js` 里每个 `routesGroupN` 的**自由标识符**都必须能解析到
 * 「形参 / 区内局部 / 模块级绑定 / JS 真全局」。解析不到的 ⇒ 运行时就是 `ReferenceError`。
 *
 * 为什么需要它（task-7 第一笔的真实翻车）：
 *   把 `apply` 里的路由搬进 `lib/server/routes.js` 时，依赖要靠参数传。第一版搬迁器的依赖清单是
 *   **手工誊抄**的，脚本又只用"清单里的名字"来判断"用到了什么" ⇒ 不在清单里的名字被**静默丢掉**，
 *   于是 `json`（全区域用了 105 次）从未接线，运行时 `ReferenceError: json is not defined`。
 *   ⚠️ 而那条「解构名集合 == 调用点键集合」的静态契约**对这类漏名字是恒等盲的** ——
 *   它比的是我自己枚举的两份清单，一个名字**两侧都没有**时它永远看不见。
 *   ⇒ 真正的判据必须**从函数体出发**枚举自由标识符，再逐个要求可解析。本文件就是它。
 *
 * 判据自带两条非空跑防护 + 一条反证：
 *   ① 必须真的解析出**足够多的**标识符（否则等于在看空集）；
 *   ② 必须真的扫到**多个** group 函数；
 *   ③ 反证：喂一个「用了未声明的名字」的合成样本，判据必须报红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(REPO, 'lib', 'server', 'routes.js')

const KEYWORDS = new Set(('const let var function return if else for while do break continue new typeof instanceof in of try catch finally throw delete void null true false undefined this switch case default import export from as await async yield class extends super static get set arguments').split(' '))
const GLOBALS = new Set(('JSON Math Date Number String Boolean Array Object Promise Set Map WeakMap WeakSet RegExp Error TypeError RangeError SyntaxError parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent process console Buffer URL URLSearchParams TextEncoder TextDecoder globalThis Infinity NaN setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone fetch AbortController').split(' '))

/** 剥注释 / 字符串 / 模板 / **正则字面量**（正则不剥会把 `/…/g` 的 flag 当成标识符 —— 实测误报过）。 */
export function codeOnly(text) {
  const noBlock = String(text).replace(/\/\*[\s\S]*?\*\//g, ' ')
  const noLine = noBlock.split('\n').map((l) => {
    let cut = -1
    for (let k = 0; k + 1 < l.length; k++) if (l[k] === '/' && l[k + 1] === '/' && l[k - 1] !== ':') { cut = k; break }
    return cut >= 0 ? l.slice(0, cut) : l
  }).join('\n')
  const noStr = noLine.replace(/`(?:\\.|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""')
  let out = ''
  for (let i = 0; i < noStr.length; i++) {
    const c = noStr[i]
    if (c !== '/') { out += c; continue }
    let prev = ''
    for (let q = i - 1; q >= 0; q--) { const pc = noStr[q]; if (pc === ' ' || pc === '\t') continue; prev = pc; break }
    if (/[A-Za-z0-9_$)\]}]/.test(prev)) { out += c; continue }
    let inClass = false
    let k = i + 1
    for (; k < noStr.length; k++) {
      const rc = noStr[k]
      if (rc === '\\') { k++; continue }
      if (rc === '\n') break
      if (rc === '[') inClass = true
      else if (rc === ']') inClass = false
      else if (rc === '/' && !inClass) break
    }
    if (k >= noStr.length || noStr[k] !== '/') { out += c; continue }
    k++
    while (k < noStr.length && /[a-z]/i.test(noStr[k])) k++
    out += ' '
    i = k - 1
  }
  return out
}

/** 模块级绑定（顶格 function / const|let|var / import）。 */
export function moduleBindings(src) {
  const out = new Set()
  for (const m of src.matchAll(/^import\s+(?:\{([^}]*)\}|(\w+))\s+from/gm)) {
    if (m[1]) for (const n of m[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop(); if (t) out.add(t) }
    if (m[2]) out.add(m[2])
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm)) out.add(m[1])
  return out
}

/** 逐个函数报告「无法解析的自由标识符」。返回 [{name, free:[…]}]（空数组 = 全部可解析）。 */
export function unresolvedIdentifiers(src) {
  const mod = moduleBindings(src)
  const out = []
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^function\s+(\w+)\s*\(([^)]*)\)\s*\{/)
    if (!m) { i++; continue }
    let depth = 0
    let end = -1
    for (let k = i; k < lines.length; k++) {
      for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
      if (k > i && depth === 0) { end = k; break }
    }
    const body = codeOnly(lines.slice(i + 1, end).join('\n'))
    const local = new Set()
    for (const p of m[2].split(',')) { const t = p.trim().split(/[=:]/)[0].trim(); if (t) local.add(t) }
    for (const d of body.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) local.add(d[1])
    for (const d of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of d[1].split(',')) { const t = n.trim().split(/[=:]/).pop().trim(); if (/^\w+$/.test(t)) local.add(t) }
    for (const d of body.matchAll(/\(([^()]*)\)\s*=>/g)) for (const p of d[1].split(',')) { const t = p.trim().split(/[=:]/)[0].trim(); if (/^\w+$/.test(t)) local.add(t) }
    for (const d of body.matchAll(/(?:^|[\s(,])(\w+)\s*=>/gm)) local.add(d[1])
    const free = new Set()
    for (const t of body.matchAll(/(\$?\w+)/g)) {
      const idx = t.index
      const prev = body[idx - 1] || ''
      if (prev === '.' || /[\w$]/.test(prev) || prev === '?') continue
      if (/^\d/.test(t[0])) continue
      if (/^\s*:/.test(body.slice(idx + t[0].length).slice(0, 4))) continue
      const n = t[0]
      if (local.has(n) || mod.has(n) || KEYWORDS.has(n) || GLOBALS.has(n)) continue
      free.add(n)
    }
    if (free.size) out.push({ name: m[1], free: [...free].sort() })
    i = end + 1
  }
  return out
}

/** 扫到的规模（供非空跑判据用）：group 数 + 这些函数体里出现过的标识符总数。 */
export function scanStats(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  let groups = 0
  let identifiers = 0
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^function\s+(routesGroup\w+)\s*\(([^)]*)\)\s*\{/)
    if (!m) { i++; continue }
    groups++
    let depth = 0
    let end = -1
    for (let k = i; k < lines.length; k++) {
      for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
      if (k > i && depth === 0) { end = k; break }
    }
    const body = codeOnly(lines.slice(i + 1, end).join('\n'))
    identifiers += [...body.matchAll(/(\$?\w+)/g)].length
    i = end + 1
  }
  return { groups, identifiers }
}

test('① routes.js 的每个 group 函数：自由标识符都必须可解析（0 未解析）', () => {
  assert.ok(fs.existsSync(TARGET), '找不到 ' + path.relative(REPO, TARGET) + ' —— 判据空跑')
  const src = fs.readFileSync(TARGET, 'utf8')
  const st = scanStats(src)
  // 非空跑：必须真的扫到 group 函数、且里面确实有成规模的标识符（否则等于在看空集）。
  // 阈值刻意取"显然低于现状、又远高于 0"的数：搬迁是分几笔做的，第一笔只有一个 group。
  assert.ok(st.groups >= 1, '一个 routesGroupN 都没扫到 —— 判据空跑（搬走了？改名了？）')
  assert.ok(st.identifiers >= 100, 'group 体内只扫到 ' + st.identifiers + ' 个标识符 —— 判据空跑或解析器坏了')
  const bad = unresolvedIdentifiers(src)
  assert.deepEqual(
    bad.map((b) => b.name + ' → ' + b.free.join(', ')),
    [],
    '★ 这些自由标识符解析不到（运行时就是 ReferenceError —— task-7 第一笔的 `json is not defined` 就是这么来的）：',
  )
})

test('② 反证：喂一个「用了未声明名字」的样本，判据必须报红', () => {
  const good = 'function routesGroupX(ctx, deps) {\n  const { json } = deps\n  return [json]\n}'
  assert.deepEqual(unresolvedIdentifiers(good), [], '正常样本不该报红')
  const bad = 'function routesGroupX(ctx, deps) {\n  const { json } = deps\n  return [json, readBody]\n}'
  const r = unresolvedIdentifiers(bad)
  assert.equal(r.length, 1, '坏样本必须报红')
  assert.deepEqual(r[0].free, ['readBody'], '必须点名漏掉的那个名字')
  // 正则 / 字符串 / 注释里的词不算（否则会误报，把门禁变成噪声）
  const noisy = 'function routesGroupY(ctx) {\n  // readBody 出现在注释里\n  const re = /readBody/g\n  const s = "readBody"\n  return [re, s]\n}'
  assert.deepEqual(unresolvedIdentifiers(noisy), [], '注释/正则/字符串里的词不该被当成自由标识符')
})
