#!/usr/bin/env node
/**
 * 客户端「自检三件套」 —— S4① 的安全网
 *
 * 背景（接手文档 §6.3，思路来自 PR #13 @H2CO3w）：该 PR 只把方法论写在提交信息里，没提交脚本。
 * 这里补上，并且**每个检查都写成可被测试直接调用的纯函数**，这样才能配「坏样本必须报错」的非空跑对照。
 *
 *   ① 悬空 id 扫描   checkDanglingIds(src)   —— JS 里引用的 id 在 markup 里不存在
 *   ② 标签配平       checkTagBalance(src)    —— 把 markup 字面量拼起来做栈式配对
 *      ★ 数组元素也允许是 S3 面板行基元的调用（`tvRowOpen(4, '…')` / `tvRowClose()`）——
 *        按**同一份源码里的字面量表**静态还原它发射的字节；解析不出就**响亮报错**（见「② 前置」）。
 *        不这样扩，整组 markup 会从 ②③ 的覆盖里静默掉出去（实测 scanned 610→0 / total 12→0）。
 *   ③ 卡片嵌套深度   checkCardDepth(src)     —— 所有一级卡片必须**同一层**、没被容器误吞
 *      （比的是**同级一致性**，不是绝对层数：现库实测 depth=2，因为面板外层还有容器）
 *
 * 用法：
 *   node tools/check-client-integrity.mjs                 # 检查默认客户端 bundle
 *   node tools/check-client-integrity.mjs <file>          # 检查指定文件
 *   node tools/check-client-integrity.mjs --print-known   # 顺带打印已在基线里的历史悬空 id
 *
 * 退出码：0 = 无新问题；1 = 发现新问题；2 = 用法/读取错误
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
export const DEFAULT_CLIENT = path.join(REPO, 'lib', 'client.manager.bundle.js')
/** 别名：测试与文档里用这个名字指代「被检查的那份客户端源码」 */
export const CLIENT_SRC = DEFAULT_CLIENT
export const BASELINE_FILE = path.join(HERE, 'dangling-id-baseline.json')

// void 元素：不成对，栈式配对时必须跳过
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

// ─────────────────────────────────────────────────────────────
// 通用小工具
// ─────────────────────────────────────────────────────────────

/** 从 src 中按开始分隔符抓出一段到匹配结束符为止的文本（支持嵌套花括号） */
function extractBalanced(src, openStr, openChar, closeChar) {
  const start = src.indexOf(openStr)
  if (start < 0) return null
  let i = start + openStr.length
  let depth = 1
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === openChar) depth++
    else if (ch === closeChar) { depth--; if (depth === 0) break }
    i++
  }
  return { body: src.slice(start, i), end: i }
}

// ─────────────────────────────────────────────────────────────
// ① 悬空 id 扫描
// ─────────────────────────────────────────────────────────────

/**
 * 算出源码里所有注释区间（行注释 + 块注释）。
 * 客户端里有整段被注释掉的历史代码，里面的 DOM 引用不能算数。
 */
export function commentRanges(src) {
  const ranges = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      ranges.push([start, i])
      continue
    }
    if (c === '/' && d === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(i + 2, n)
      ranges.push([start, i])
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      // 跳过字符串，避免把字符串里的 // 当成注释
      const q = c
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    i++
  }
  return ranges
}

function isCommented(ranges, idx) {
  for (const [a, b] of ranges) if (idx >= a && idx < b) return true
  return false
}

/**
 * 收集 JS 里通过字面量引用的 DOM id。
 * 只收**完整的字面量**：`'#id' + x` 这种拼接写法会被排除（静态扫不出来，算进去全是误报）。
 * 注释掉的历史代码也不算。
 */
export function collectJsIds(src) {
  const found = []
  const ranges = commentRanges(src)
  const lineOf = (idx) => src.slice(0, idx).split('\n').length
  const push = (m, id, kind) => {
    if (isCommented(ranges, m.index)) return
    found.push({ id, kind, at: m.index, line: lineOf(m.index) })
  }
  // getElementById('x') —— 右括号紧跟字面量，排除 getElementById('#id' + x)
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m, m[1], 'getElementById')
  // querySelector('#x') / querySelectorAll('#x .y')
  //   —— 用反向引用锁住同一个引号，**整个选择器必须落在同一个字面量里**，
  //      这样 `querySelector('#tavern-' + type)` 这种拼接写法不会被算进来
  //      （第一版没锁住，硬把 '#tavern-' 当成悬空 id 报出来了）
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*(['"])(#[^'"]*)\1\s*\)/g)) {
    push(m, m[2].slice(1).split(/[\s.>:[]/)[0], 'querySelector')
  }
  return found
}

/** 收集 markup 里声明的 id（含 id="..." / id='...'；跳过 ${} 插值的） */
export function collectMarkupIds(src) {
  const ids = new Set()
  for (const m of src.matchAll(/\bid\s*=\s*(['"])([^'"]*)\1/g)) {
    const v = m[2]
    if (!v.includes('${')) ids.add(v)
  }
  // 极少量写法可能是 id=${x} 这种表达式整体，跳过
  return ids
}

/**
 * 悬空 id 检查。
 * @param src 源码文本
 * @param baseline 已知的历史悬空 id 数组（用于区分「新引入」与「既有」）
 */
export function checkDanglingIds(src, baseline = []) {
  const jsIds = collectJsIds(src)
  const markupIds = collectMarkupIds(src)
  const known = new Set(baseline)
  const missing = []
  const seen = new Set()
  for (const ref of jsIds) {
    if (markupIds.has(ref.id)) continue
    if (seen.has(ref.id)) continue
    seen.add(ref.id)
    missing.push({ ...ref, known: known.has(ref.id) })
  }
  return {
    ok: missing.every((m) => m.known),
    // 判据空跑防护：源码里明明有 getElementById / querySelector('#…')，却一个都没抓到
    // ⇒ 多半是正则失效或文件结构变了，这种"什么都没发现"绝不能当成通过
    vacuous: /getElementById\(\s*['"]|querySelector(?:All)?\(\s*['"]#/.test(src) && jsIds.length === 0,
    totalRefs: jsIds.length,
    markupIds: markupIds.size,
    missing,
    // 基线里写了、但其实已经不悬空了 → 提示清理基线
    staleBaseline: baseline.filter((id) => !missing.some((m) => m.id === id)),
  }
}

// ─────────────────────────────────────────────────────────────
// ② 前置：S3 面板行基元（`tvRowOpen` / `tvRowClose`）的**静态**解析
// ─────────────────────────────────────────────────────────────

/**
 * 为什么需要这一段（task-25 笔2 实测）：
 *
 * `panelHTML()` 里 39 个 `<div class="t-row" …>` 元素从**字符串字面量**迁成了
 * `tvRowOpen(indent, style)` / `tvRowClose()` 调用。而 `extractMarkupGroups` 只认
 * 「`[` + ≥3 个**纯字符串字面量** + `]`」—— 数组里一出现**调用**，整组 markup 就被丢弃：
 * 实测 `checkTagBalanceGroups` 的 `scanned` **610 → 0**、`checkCardDepth` 的 `total` **12 → 0**，
 * 而工具**只知道"空跑了"**，看不见"面板结构已经从覆盖里掉出去"。
 * ⇒ 扫描面必须**跟着扩**（与 `check-innerhtml-escape` 的 `TARGETS` 注释同一条教训：
 *   "扫描面若不跟着扩，棘轮会静默把这条 sink 移出覆盖"），否则等于让安全网静默变小。
 *
 * 口径（**刻意窄**，写在这里供审计）：
 *   · 只认这两个名字、两种形态：`tvRowOpen(<数字字面量>, <字符串字面量|null>)` 与 `tvRowClose()`；
 *   · 只从**同一份源码里的字面量表** `TV_ROW_OPEN` 还原它发射的字节 —— 静态解析，
 *     **不 eval、不读运行时值、不做通用表达式求值**；
 *   · 解析不出 / 表缺失 / 名字对不上 / 实参不是字面量 ⇒ 记一条 problem，调用方**响亮报错**
 *     （fail-closed）。**绝不静默丢组** —— 那正是这条扩面要挡的形态。
 */

/** 跳过空白与注释（与 `extractMarkupGroups` 里的 skipWs 同口径）。 */
function skipWsComments(src, p) {
  for (;;) {
    while (p < src.length && /\s/.test(src[p])) p++
    if (src[p] === '/' && src[p + 1] === '/') { while (p < src.length && src[p] !== '\n') p++; continue }
    if (src[p] === '/' && src[p + 1] === '*') {
      p += 2
      while (p < src.length && !(src[p] === '*' && src[p + 1] === '/')) p++
      p = Math.min(p + 2, src.length)
      continue
    }
    return p
  }
}

/** 读一个单/双引号字面量，返回**原文**（与 `readQuoted` 同口径：不解析转义，除非下面显式反转义）。 */
function readRowLiteString(src, p) {
  const q = src[p]
  if (q !== "'" && q !== '"') return null
  let j = p + 1
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue }
    if (src[j] === q) return { text: src.slice(p + 1, j), end: j + 1 }
    if (src[j] === '\n') return null      // 单/双引号不跨行
    j++
  }
  return null
}

/** 反转义基元表里唯一可能出现的两种转义（`\'` 与 `\\`）；其余原样保留。 */
const unescapeRowKey = (s) => s.replace(/\\(['\\])/g, '$1')

/**
 * 读一层「全字面量」对象：键是数字或字符串字面量，值是字符串字面量或下一层同构对象。
 * 一旦遇到任何非字面量形态 ⇒ 返回 `{table:null, why}`（fail-closed，不做求值）。
 */
function readRowLiteralTable(src, i) {
  const out = {}
  let p = skipWsComments(src, i + 1)
  for (;;) {
    if (src[p] === '}') return { table: out, end: p + 1 }
    let key = null
    const num = /^\d+(?=\s*:)/.exec(src.slice(p, p + 16))
    if (num) key = { text: num[0], end: p + num[0].length }
    else {
      const s = readRowLiteString(src, p)
      if (s) key = { text: unescapeRowKey(s.text), end: s.end }
    }
    if (!key) return { table: null, why: '表里出现非字面量的键（基元表必须全是字面量）' }
    p = skipWsComments(src, key.end)
    if (src[p] !== ':') return { table: null, why: '表的键后面不是 `:`' }
    p = skipWsComments(src, p + 1)
    if (src[p] === '{') {
      const inner = readRowLiteralTable(src, p)
      if (!inner.table) return { table: null, why: inner.why }
      out[key.text] = inner.table
      p = skipWsComments(src, inner.end)
    } else {
      const v = readRowLiteString(src, p)
      if (!v) return { table: null, why: '表里出现非字面量的值（基元表必须全是字面量）' }
      out[key.text] = unescapeRowKey(v.text)
      p = skipWsComments(src, v.end)
    }
    if (src[p] === ',') { p = skipWsComments(src, p + 1); continue }
    if (src[p] === '}') return { table: out, end: p + 1 }
    return { table: null, why: '表里出现既不是 `,` 也不是 `}` 的字符' }
  }
}

/**
 * 解析 `var TV_ROW_OPEN = { … }` —— 基元发射字节的**唯一真源**（静态解析，不求值）。
 * @returns {{table:Object|null, why:string}} `table` 为 null 时 `why` 说明病因
 */
export function readRowOpenTable(src) {
  const s = String(src)
  const at = s.indexOf('var TV_ROW_OPEN')
  if (at < 0) return { table: null, why: '找不到基元表 `TV_ROW_OPEN`（表被删/改名？）' }
  const open = s.indexOf('{', at)
  if (open < 0) return { table: null, why: '`TV_ROW_OPEN` 后面没有对象字面量' }
  const r = readRowLiteralTable(s, open)
  if (!r.table) return { table: null, why: '`TV_ROW_OPEN` 表解析失败：' + r.why }
  return { table: r.table, why: '' }
}

/**
 * 在下标 `p` 处尝试读一个基元调用，并还原它发射的字节。
 * @returns {{text:string,end:number}|{problem:string}|null} `null` = 这里不是基元调用（按旧路径处理）
 */
export function resolveRowEmitter(src, p) {
  const s = String(src)
  const rest = s.slice(p)
  const close = /^tvRowClose\s*\(\s*\)/.exec(rest)
  if (close) return { text: '</div>', end: p + close[0].length }
  const m = /^tvRowOpen\s*\(\s*(\d+)\s*,\s*('(?:[^'\\]|\\.)*'|null)\s*\)/.exec(rest)
  if (!m) {
    // ★ 名字像基元、却读不出来 ⇒ 必须响亮报错，不许静默丢组（这正是本段要挡的形态）
    if (/^tvRow(?:Open|Close)\b/.test(rest)) {
      return {
        problem: '无法静态解析的基元调用 ' + JSON.stringify(rest.slice(0, 60)) +
          '（只认 `tvRowOpen(<数字字面量>, <字符串字面量|null>)` / `tvRowClose()`）',
      }
    }
    return null
  }
  const { table, why } = readRowOpenTable(s)
  if (!table) return { problem: why }
  const indent = m[1]
  const styleKey = m[2] === 'null' ? '' : unescapeRowKey(m[2].slice(1, -1))
  const byIndent = table[indent]
  const tag = byIndent ? byIndent[styleKey] : undefined
  if (typeof tag !== 'string') {
    return { problem: '`TV_ROW_OPEN` 表里查不到 (' + indent + ', ' + m[2] + ') 这条 —— 表与调用点不一致' }
  }
  return { text: tag, end: p + m[0].length }
}

// ─────────────────────────────────────────────────────────────
// ② 标签配平
// ─────────────────────────────────────────────────────────────

/**
 * 找出「由字符串片段组成的数组字面量」—— 客户端就是用这种数组拼 markup 的
 * （`panelHTML()` 里是 `return [ '<div …>', '  <h2>…</h2>', … ]` 这种形态）。
 *
 * ★ S3 起：数组元素也可以是上面两个基元的**调用**（`tvRowOpen(4, '…')` / `tvRowClose()`），
 *   按同一份源码里的字面量表还原成它们发射的字节 —— 不这样扩，整组 markup 会从覆盖里掉出去
 *   （见上文「② 前置」的实测读数）。解析不出 ⇒ 进 `problems`，调用方必须响亮报错。
 *
 * 关键：必须**按数组分组**再拼起来配平。把整个文件的字符串一股脑拼在一起会冒出几百个
 * 假不平衡 —— 第一版就是这么报了 233 个，全是噪声。
 *
 * @returns {{groups:Array<{fragments:string[], markup:string, line:number}>, problems:Array<{line:number, why:string}>}}
 */
export function extractMarkupGroupsEx(src) {
  const groups = []
  const problems = []
  let i = 0
  const n = src.length
  const ranges = commentRanges(src)

  const skipWs = (p) => {
    for (;;) {
      while (p < n && /\s/.test(src[p])) p++
      if (src[p] === '/' && src[p + 1] === '/') { while (p < n && src[p] !== '\n') p++; continue }
      if (src[p] === '/' && src[p + 1] === '*') {
        p += 2
        while (p < n && !(src[p] === '*' && src[p + 1] === '/')) p++
        p = Math.min(p + 2, n)
        continue
      }
      return p
    }
  }
  const readQuoted = (p) => {
    const q = src[p]
    if (q !== "'" && q !== '"' && q !== '`') return null
    let j = p + 1
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === q) return { text: src.slice(p + 1, j), end: j + 1 }
      if (src[j] === '\n' && q !== '`') return null      // 单/双引号不跨行
      j++
    }
    return null
  }

  while (i < n) {
    if (src[i] !== '[' || isCommented(ranges, i)) { i++; continue }
    let p = skipWs(i + 1)
    const fragments = []
    let ok = false
    for (;;) {
      const q = readQuoted(p)
      if (q) {
        fragments.push(q.text)
        p = skipWs(q.end)
      } else {
        // ★ 数组元素也可以是基元调用（S3：`tvRowOpen(4, '…')` / `tvRowClose()`）——
        //   按同源字面量表还原它发射的字节；解析不出就记 problem（下方调用方响亮报错）。
        const em = resolveRowEmitter(src, p)
        if (em && em.problem) {
          problems.push({ line: src.slice(0, p).split('\n').length, why: em.problem })
          break
        }
        if (em && typeof em.text === 'string') {
          fragments.push(em.text)
          p = skipWs(em.end)
        } else {
          // 已经攒下了 markup 片段，却遇到读不懂的**调用** ⇒ 也报 problem。
          //   为什么：静默 `break` 会让整组 markup 从覆盖里消失（正是本次要挡的"无声缩水"）。
          const looksCall = /^[A-Za-z_$][\w$]*\s*\(/.test(src.slice(p, p + 60))
          if (looksCall && fragments.some((f) => /<[A-Za-z][^>]*>/.test(f))) {
            problems.push({
              line: src.slice(0, p).split('\n').length,
              why: 'markup 数组里出现无法静态解析的调用元素 ' + JSON.stringify(src.slice(p, p + 60)) +
                ' —— 提取器会因此丢掉整组（要加新形态，必须同笔扩这里的解析）',
            })
          }
          break
        }
      }
      if (src[p] === ',') {
        // 允许尾逗号：`[ 'a', 'b', ]` —— 必须先探一下逗号后是不是 `]`
        // （第一版没处理，导致带尾逗号的数组整段漏掉）
        const after = skipWs(p + 1)
        if (src[after] === ']') { ok = true; break }
        p = after
        continue
      }
      if (src[p] === ']') { ok = true; break }
      break
    }
    if (ok && fragments.length >= 3) {
      const joined = fragments.join('\n')
      if (/<[A-Za-z][^>]*>/.test(joined)) {
        groups.push({ fragments, markup: joined, line: src.slice(0, i).split('\n').length })
      }
      i = p + 1
      continue
    }
    i++
  }
  return { groups, problems }
}

/** 兼容旧调用点：只要分组（不含 problems）。要判 problems 请用 `extractMarkupGroupsEx`。 */
export function extractMarkupGroups(src) {
  return extractMarkupGroupsEx(src).groups
}

/** 对源码里所有 markup 分组做配平，返回汇总 */
export function checkTagBalanceGroups(src) {
  const { groups, problems } = extractMarkupGroupsEx(src)
  const errors = []
  let scanned = 0
  for (const g of groups) {
    const r = checkTagBalance(blankTemplateExpr(g.markup))
    scanned += r.scanned
    for (const e of r.errors) errors.push({ ...e, group: g.line })
  }
  return {
    // 解析不出基元 = 覆盖已经不可信 ⇒ 也算不通过（fail-closed）
    ok: errors.length === 0 && problems.length === 0,
    // 源码里明明有标签/有片段数组，却一个都没扫到 ⇒ 工具已经失效，不能算通过
    vacuous: (groups.length === 0 && /<[A-Za-z][^>]*>/.test(src)) || scanned === 0,
    errors, scanned, groups: groups.length, problems,
  }
}

/** 把模板里的 ${...} 表达式挖掉（原位填空格，保持行号），避免把 JS 内容混进 markup */
export function blankTemplateExpr(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++
        else if (s[j] === '}') depth--
        j++
      }
      out += ' '.repeat(j - i)
      i = j
      continue
    }
    out += s[i] === '\n' ? '\n' : s[i]
    i++
  }
  return out
}

/**
 * 栈式标签配对检查。
 * @param markup 已经是「纯 markup」的文本
 */
export function checkTagBalance(markup) {
  const errors = []
  let text = markup.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<!(DOCTYPE|doctype)[^>]*>/g, ' ')
  const lineOf = (idx) => markup.slice(0, idx).split('\n').length

  const stack = []
  const re = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  let scanned = 0
  while ((m = re.exec(text)) !== null) {
    scanned++
    const [full, slash, rawName, attrs, selfClose] = m
    const name = rawName.toLowerCase()
    if (VOID_TAGS.has(name)) continue
    if (selfClose === '/') continue
    if (slash === '/') {
      // 闭合标签
      if (!stack.length) {
        errors.push({ type: 'stray-close', tag: name, line: lineOf(m.index), detail: '没有对应的开标签' })
        continue
      }
      const top = stack[stack.length - 1]
      if (top.name === name) { stack.pop(); continue }
      // 找栈里是否有同名标签 —— 有则说明中间的有标签没闭合
      const idx = stack.map((s) => s.name).lastIndexOf(name)
      if (idx >= 0) {
        const unclosed = stack.slice(idx + 1).map((s) => s.name)
        errors.push({
          type: 'unclosed', tag: name, line: lineOf(m.index),
          detail: '闭合 ' + name + ' 时，栈里还有未闭合的：' + unclosed.join(' > '),
        })
        stack.length = idx
        continue
      }
      errors.push({ type: 'mismatch', tag: name, line: lineOf(m.index), detail: '期望闭合 ' + top.name })
    } else {
      stack.push({ name, line: lineOf(m.index) })
    }
  }
  for (const s of stack) {
    errors.push({ type: 'missing-close', tag: s.name, line: s.line, detail: '开标签没有被闭合' })
  }
  return { ok: errors.length === 0, errors, scanned }
}

// ─────────────────────────────────────────────────────────────
// ③ 卡片嵌套深度
// ─────────────────────────────────────────────────────────────

/**
 * 检查一级卡片（带 data-tv-tab 的元素）是否都处于 depth=1。
 * 思路：在 markup 片段内做一次轻量 DOM 深度计算 —— 以片段根为 depth=0，
 * 卡片自己应为 depth=1。若被某个容器多包一层，就会变成 2+。
 */
export function checkCardDepth(src) {
  const { groups, problems } = extractMarkupGroupsEx(src)
  const cards = []
  groups.forEach((g, gi) => {
    const text = blankTemplateExpr(g.markup)
    for (const hit of computeDepths(text)) cards.push({ ...hit, group: gi, groupLine: g.line })
  })

  // 每个分组内部做归一化：把该组里**最浅的那张卡片**当作「一级卡片」基准。
  // 为什么不能直接要求 depth=1：面板整体外面本来就包着 <div id="tavern-manager">，
  // 卡片天然是它的子元素。真正要挡的是「某一张卡片被多包了一层容器（被误吞）」，
  // 也就是同一组里出现深度不一致的卡片。
  const byGroup = new Map()
  for (const c of cards) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, [])
    byGroup.get(c.group).push(c)
  }
  for (const list of byGroup.values()) {
    const min = Math.min(...list.map((c) => c.depth))
    for (const c of list) { c.base = min; c.ok = c.depth === min }
  }

  const bad = cards.filter((c) => !c.ok)
  return {
    ok: bad.length === 0 && problems.length === 0,
    // 源码里明明写着 data-tv-tab，却一张卡片都没找到 ⇒ 扫描器失效
    vacuous: cards.length === 0 && /\bdata-tv-tab\s*=/.test(src),
    total: cards.length, cards, bad, groups: groups.length, problems,
  }
}

/** 把源码里所有含标签的字符串字面量切成片段 */
function splitMarkupChunks(src) {
  const chunks = []
  let i = 0
  const n = src.length
  while (i < n) {
    const q = src[i]
    if (q !== '`' && q !== "'" && q !== '"') { i++; continue }
    let j = i + 1
    let closed = false
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === q) { closed = true; break }
      if (src[j] === '\n' && q !== '`') break
      j++
    }
    if (!closed) { i = j + 1; continue }
    const raw = src.slice(i + 1, j)
    if (/<[A-Za-z][^>]*>/.test(raw)) chunks.push(raw)
    i = j + 1
  }
  return chunks
}

/**
 * 对一段 markup 做一遍扫描，记录每个带 data-tv-tab 的元素所处的嵌套深度。
 * 约定：片段本身当作虚拟根（depth=0），片段内顶层元素为 depth=1 ——
 * 也就是「一级卡片应该都在 depth=1」，多包一层容器就会变成 2 以上。
 */
function computeDepths(text) {
  const list = []
  const stack = []
  const re = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const [, slash, rawName, attrs, selfClose] = m
    const name = rawName.toLowerCase()
    if (VOID_TAGS.has(name) || selfClose === '/') continue
    if (slash === '/') { if (stack.length) stack.pop(); continue }
    stack.push(name)
    if (/\bdata-tv-tab\s*=/.test(attrs)) {
      list.push({ depth: stack.length, name, attrs: attrs.trim().slice(0, 90) })
    }
  }
  return list
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).knownDangling || [] }
  catch { return [] }
}

function main() {
  const args = process.argv.slice(2)
  const printKnown = args.includes('--print-known')
  const fileArg = args.find((a) => !a.startsWith('--'))
  const file = fileArg ? path.resolve(fileArg) : DEFAULT_CLIENT
  if (!fs.existsSync(file)) { console.error('找不到文件：' + file); process.exit(2) }
  const src = fs.readFileSync(file, 'utf8')
  const baseline = fileArg ? [] : loadBaseline()

  console.log('客户端自检三件套 —— ' + path.relative(REPO, file))
  console.log('（说明：「没扫到东西」一律判失败。空跑出来的绿灯比红灯更危险 —— 它会让人以为护栏还在。）')
  console.log('')

  let bad = 0

  // ①
  const ids = checkDanglingIds(src, baseline)
  console.log('① 悬空 id 扫描：JS 引用 ' + ids.totalRefs + ' 处 / markup 声明 ' + ids.markupIds + ' 个 id')
  const fresh = ids.missing.filter((x) => !x.known)
  if (ids.vacuous) {
    bad++
    console.log('   ❌ 判据空跑：源码里明明有 DOM 查询，却一处都没抓到 —— 请检查这个文件还是不是预期形态')
  } else if (fresh.length) {
    bad++
    console.log('   ❌ 新出现的悬空 id ' + fresh.length + ' 个：')
    for (const x of fresh) console.log('      #' + x.id + '  ← ' + x.kind + ' @ 第 ' + x.line + ' 行')
  } else {
    console.log('   ✅ 没有新引入的悬空 id')
  }
  if (ids.missing.some((x) => x.known)) {
    console.log('   ⚠️  基线里已记录的悬空 id ' + ids.missing.filter((x) => x.known).length + ' 个' +
      (printKnown ? '：' + ids.missing.filter((x) => x.known).map((x) => '#' + x.id).join(', ') : '（加 --print-known 查看）'))
  }
  if (ids.staleBaseline.length) {
    console.log('   ⚠️  基线里已不再悬空、建议清理：' + ids.staleBaseline.map((i) => '#' + i).join(', '))
  }

  // ②
  const bal = checkTagBalanceGroups(src)
  console.log('')
  console.log('② 标签配平：' + bal.groups + ' 个 markup 数组分组，共扫描 ' + bal.scanned + ' 个标签')
  if (bal.problems.length) {
    bad++
    console.log('   ❌ 基元解析失败 ' + bal.problems.length + ' 处（fail-closed：不许"认不出就当没有"）：')
    for (const p of bal.problems.slice(0, 10)) console.log('      第 ' + p.line + ' 行  ' + p.why)
  }
  if (bal.vacuous) {
    bad++
    console.log('   ❌ 判据空跑：没找到任何 markup 分组 —— 面板结构可能变了，或者提取逻辑失效了')
  } else if (bal.ok) {
    console.log('   ✅ 全部成对')
  } else if (bal.errors.length) {
    bad++
    console.log('   ❌ ' + bal.errors.length + ' 处不平衡（只列前 10）：')
    for (const e of bal.errors.slice(0, 10)) {
      console.log('      [' + e.type + '] <' + e.tag + '> @ 第 ' + e.line + ' 行（分组起于 ' + e.group + '） —— ' + e.detail)
    }
  }

  // ③
  const depth = checkCardDepth(src)
  console.log('')
  console.log('③ 卡片嵌套深度：发现 ' + depth.total + ' 个带 data-tv-tab 的元素（' + depth.groups + ' 个分组）')
  if (depth.problems.length) {
    bad++
    console.log('   ❌ 基元解析失败 ' + depth.problems.length + ' 处（fail-closed：不许"认不出就当没有"）：')
    for (const p of depth.problems.slice(0, 10)) console.log('      第 ' + p.line + ' 行  ' + p.why)
  }
  if (depth.vacuous) {
    bad++
    console.log('   ❌ 判据空跑：源码里写着 data-tv-tab，却一张卡片都没找到 —— 提取逻辑可能已经失效')
  } else if (depth.ok) {
    const levels = [...new Set(depth.cards.map((c) => 'depth=' + c.depth))].sort()
    console.log('   ✅ 每张卡片都和同级卡片同一层（' + levels.join(', ') + '），没有被容器误吞')
  } else if (depth.bad.length) {
    bad++
    console.log('   ❌ ' + depth.bad.length + ' 张卡片的深度和同级卡片不一致（多半被多包了一层）：')
    for (const c of depth.bad.slice(0, 10)) {
      console.log('      <' + c.name + '> depth=' + c.depth + '（同级基准 ' + c.base + '，分组起于 ' + c.groupLine + '）   ' + c.attrs)
    }
  }

  console.log('')
  console.log(bad ? '❌ 有 ' + bad + ' 项自检未通过' : '✅ 三件套全通过')
  process.exit(bad ? 1 : 0)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) main()
