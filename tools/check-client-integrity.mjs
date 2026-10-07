#!/usr/bin/env node
/**
 * 客户端「自检三件套」 —— S4① 的安全网
 *
 * 背景（接手文档 §6.3，思路来自 PR #13 @H2CO3w）：该 PR 只把方法论写在提交信息里，没提交脚本。
 * 这里补上，并且**每个检查都写成可被测试直接调用的纯函数**，这样才能配「坏样本必须报错」的非空跑对照。
 *
 *   ① 悬空 id 扫描   checkDanglingIds(src)   —— JS 里引用的 id 在 markup 里不存在
 *   ② 标签配平       checkTagBalance(src)    —— 把 markup 字面量拼起来做栈式配对
 *   ③ 卡片嵌套深度   checkCardDepth(src)     —— 一级卡片必须在 depth=1，没被容器误吞
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
// ② 标签配平
// ─────────────────────────────────────────────────────────────

/**
 * 找出「由字符串片段组成的数组字面量」—— 客户端就是用这种数组拼 markup 的
 * （`panelHTML()` 里是 `return [ '<div …>', '  <h2>…</h2>', … ]` 这种形态）。
 *
 * 关键：必须**按数组分组**再拼起来配平。把整个文件的字符串一股脑拼在一起会冒出几百个
 * 假不平衡 —— 第一版就是这么报了 233 个，全是噪声。
 *
 * @returns {Array<{fragments:string[], markup:string, line:number}>}
 */
export function extractMarkupGroups(src) {
  const groups = []
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
      if (!q) break
      fragments.push(q.text)
      p = skipWs(q.end)
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
  return groups
}

/** 对源码里所有 markup 分组做配平，返回汇总 */
export function checkTagBalanceGroups(src) {
  const groups = extractMarkupGroups(src)
  const errors = []
  let scanned = 0
  for (const g of groups) {
    const r = checkTagBalance(blankTemplateExpr(g.markup))
    scanned += r.scanned
    for (const e of r.errors) errors.push({ ...e, group: g.line })
  }
  return {
    ok: errors.length === 0,
    // 源码里明明有标签/有片段数组，却一个都没扫到 ⇒ 工具已经失效，不能算通过
    vacuous: (groups.length === 0 && /<[A-Za-z][^>]*>/.test(src)) || scanned === 0,
    errors, scanned, groups: groups.length,
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
  const groups = extractMarkupGroups(src)
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
    ok: bad.length === 0,
    // 源码里明明写着 data-tv-tab，却一张卡片都没找到 ⇒ 扫描器失效
    vacuous: cards.length === 0 && /\bdata-tv-tab\s*=/.test(src),
    total: cards.length, cards, bad, groups: groups.length,
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
  if (bal.vacuous) {
    bad++
    console.log('   ❌ 判据空跑：没找到任何 markup 分组 —— 面板结构可能变了，或者提取逻辑失效了')
  } else if (bal.ok) {
    console.log('   ✅ 全部成对')
  } else {
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
  if (depth.vacuous) {
    bad++
    console.log('   ❌ 判据空跑：源码里写着 data-tv-tab，却一张卡片都没找到 —— 提取逻辑可能已经失效')
  } else if (depth.ok) {
    const levels = [...new Set(depth.cards.map((c) => 'depth=' + c.depth))].sort()
    console.log('   ✅ 每张卡片都和同级卡片同一层（' + levels.join(', ') + '），没有被容器误吞')
  } else {
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
