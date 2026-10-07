#!/usr/bin/env node
/**
 * innerHTML 转义棘轮（issue #14 同 class 的**结构化**护栏）
 *
 * 为什么需要它 —— 现有 `tests/render-escape.test.js` 的 ③ 是**按变量名写死**的模式
 * （`+ e.source +` / `+ label +` …）。它对"**新建一条渲染路径**"是盲的：换个变量名、
 * 换个函数，同一类漏洞照样溜过去。而"把两个渲染函数合并成一个 helper""抽统一拼装函数"
 * 这两种重构动作恰恰最容易漏掉某一路来源 —— PR #13 就是这么翻车的
 * （它转义了 `e.source` / `e.target`，漏了 `label`）。
 *
 * 判据不看变量名，只看**结构**：
 *   把 `.innerHTML = / +=` 右边的表达式按**顶层 `+`** 切成段，逐段判定；
 *   只要有一段不是「结构上不可能带 HTML」的形态，整行记为可疑。
 *
 *   结构安全 = 字面量 / esc 函数族调用 / 含 esc 的 .map|.join 链 /
 *              `.length` `.count` 计数 / 两支都是字面量的三元
 *   （不做「整行有 esc 就放行」—— 那正是漏掉 "转义了一个、漏了另一个" 的原因）
 *
 * 棘轮：现状记进 `tools/innerhtml-baseline.json`，之后**只许减不许增**。
 *   node tools/check-innerhtml-escape.mjs            # 校验（新增可疑行 ⇒ 退出码 1）
 *   node tools/check-innerhtml-escape.mjs --update   # 用实测值更新基线（PR 里要说明理由）
 *   node tools/check-innerhtml-escape.mjs --json     # 只打印实测值
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..')
export const BASELINE_FILE = path.join(HERE, 'innerhtml-baseline.json')

export const TARGETS = ['lib/client.manager.bundle.js', 'lib/index.js']

/**
 * 基线条目的「分类 + 证据」。
 *
 * 为什么需要：基线如果只是"一串被放行的行"，半年后没人知道它们为什么被放过 ——
 * 棘轮就退化成装饰。所以每条都必须能答出两件事：**它属于哪一类**、**凭什么**。
 *
 * - `mustContain`：必须仍然存在于被扫文件里的片段 —— 这是**机器验证**的那一半
 *   （例：`pName` 那条要求 `var pName = esc(p.name || '')` 还在；
 *   一旦有人把上游的 esc 去掉，测试立刻报红，而不是等基线变成谎言）。
 * - `--update` 时按 `re` 匹配行；**匹配不到就记 `unclassified`，校验直接失败** ——
 *   逼着新条目当场给出理由，而不是悄悄加进白名单。
 */
export const EVIDENCE = [
  { re: /cleanedTotal/, kind: 'numeric', why: '预设导入的清理计数（数字）', mustContain: ['var cleanedTotal = 0'] },
  { re: /\+ charCount \+/, kind: 'numeric', why: '角色卡/世界书/预设条目计数（.length · reduce）', mustContain: ['var charCount = ', 'var presetEnabledEntries = '] },
  { re: /\+ charCount2 \+/, kind: 'numeric', why: '同上，第二个面板', mustContain: ['var charCount2 = ', 'var presetEnabled2 = '] },
  // 匹配的是**基线条目存的首行**（不是窗口里的下一行）—— 所以正则要认 `.slice(0, 20).map(`
  { re: /bannedWords\.slice\(0, 20\)\.map/, kind: 'ternary-literals', why: 'map 体已 esc(w)；尾部三元两支都是字面量 + 纯数字算术', mustContain: ["+ esc(w) + '</span>'", '(bannedWords.length - 20)'] },
  { re: /\(labelLen \|\| 15\)/, kind: 'numeric', why: 'renderLargeGraph 的 labelLen 形参（像素宽度）', mustContain: ['function renderLargeGraph(container, relations, labelLen)'] },
  { re: /\+ pName \+/, kind: 'upstream-escaped', why: 'pName 与 pMeta 都在上游转过义', mustContain: ["var pName = esc(p.name || '')", "pMeta += '🎭' + esc("] },
  { re: /\+ pMeta2 \+/, kind: 'upstream-escaped', why: 'pMeta2 由 escapeHtml（≡ esc）与数字拼成', mustContain: ["pMeta2 += '🎭' + escapeHtml(", 'p.cardChars'] },
]

/** 给一行匹配证据规则；匹配不到返回 unclassified（会被校验拦下）。 */
export function classify(line) {
  for (const e of EVIDENCE) if (e.re.test(line)) return { kind: e.kind, why: e.why, mustContain: e.mustContain }
  return { kind: 'unclassified', why: '', mustContain: [] }
}

const ESCAPE_CALL = /\b(?:esc|escAttr|escapeHtml|encodeURIComponent)\s*\(/
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

/** 按**顶层**分隔符切分（尊重引号与 ()[]{ } 深度）。 */
export function splitTopLevel(expr, delim = '+') {
  const parts = []
  let cur = ''
  let quote = ''
  let depth = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += expr[++i] || ''; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === delim && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  parts.push(cur)
  return parts
}

/** 在顶层找某个分隔符的下标（从 from 开始），找不到返回 -1 */
function findTopLevel(expr, delim, from = 0) {
  let quote = ''
  let depth = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === delim && depth === 0 && i >= from) return i
  }
  return -1
}

const isLiteral = (x) => /^('([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`|-?[\d.]+|true|false|null|undefined)$/.test(x.trim())

/** 这一段是不是「结构上不可能带 HTML」？ */
export function segmentIsSafe(seg) {
  const s = seg.trim()
  if (s === '') return true
  if (isLiteral(s)) return true
  if (ESCAPE_CALL.test(s)) return true
  // 含 esc 的 .map/.filter/.join 链（跨行时由调用方先把窗口拼好）
  if (/\.(map|filter|forEach|join|reduce)\s*\(/.test(s)) return ESCAPE_CALL.test(s)
  if (/^(String|Number|Boolean)\s*\(/.test(s)) return ESCAPE_CALL.test(s) || /^String\s*\(\s*[-'\d]/.test(s)
  // 计数：结构上就是数字
  if (/\.(length|count)$/.test(s)) return true
  // 括号包起来的三元，且**两支都是字面量**
  // 例：(g.collapsed ? '' : 'transform:rotate(90deg);')  ← 分支里含 ':'，所以必须用顶层扫描而不是正则
  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = s.slice(1, -1)
    const q = findTopLevel(inner, '?')
    if (q >= 0) {
      const colon = findTopLevel(inner, ':', q + 1)
      if (colon > q && isLiteral(inner.slice(q + 1, colon)) && isLiteral(inner.slice(colon + 1))) return true
    }
  }
  return false
}

/**
 * 扫描一段源码里的「裸拼 innerHTML」可疑行。
 * @returns {{line:string,lineNo:number,parts:string[]}[]}
 */
export function findSuspects(src) {
  const lines = String(src).split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue
    const m = lines[i].match(/\.innerHTML\s*(?:=|\+=)/)
    if (!m) continue
    // 把表达式补全：括号未闭合就往后吃到闭合（`.map(function (s) { … }).join('')` 常跨行）
    let expr = lines[i].slice(m.index + m[0].length)
    let depth = 0
    let quote = ''
    const bump = (t) => {
      for (let k = 0; k < t.length; k++) {
        const c = t[k]
        if (quote) { if (c === '\\') { k++; continue } if (c === quote) quote = ''; continue }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue }
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') depth--
      }
    }
    bump(expr)
    for (let j = i + 1; j < Math.min(i + 12, lines.length) && (depth > 0 || quote); j++) {
      expr += '\n' + lines[j]
      bump(lines[j])
    }
    expr = expr.replace(/;\s*$/, '')
    const segs = splitTopLevel(expr)
    if (segs.length < 2) continue
    const bad = segs.filter((s) => !segmentIsSafe(s))
    if (!bad.length) continue
    out.push({ line: lines[i].trim().replace(/\s+/g, ' '), lineNo: i + 1, parts: bad.map((s) => s.trim().replace(/\s+/g, ' ')) })
  }
  return out
}

export function scanFiles(files) {
  const all = []
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(REPO, f)
    if (!fs.existsSync(abs)) continue
    for (const s of findSuspects(fs.readFileSync(abs, 'utf8'))) {
      all.push({ file: path.relative(REPO, abs).replace(/\\/g, '/'), ...s })
    }
  }
  return all
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const actual = scanFiles(TARGETS)
  if (argv.includes('--json')) { console.log(JSON.stringify(actual, null, 2)); process.exit(0) }
  if (argv.includes('--update')) {
    const entries = actual.map(({ file, line, lineNo, parts }) => ({ file, line, lineNo, parts, ...classify(line) }))
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      note: 'innerHTML 裸拼基线：只许减不许增。每条都经人工过目（判据见 tools/check-innerhtml-escape.mjs 头注释）。',
      entries,
    }, null, 2) + '\n')
    console.log(`已写入基线 ${entries.length} 条 -> ${path.relative(REPO, BASELINE_FILE)}`)
    process.exit(0)
  }
  const baseline = fs.existsSync(BASELINE_FILE) ? (JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).entries || []) : []
  const unclassified = baseline.filter((e) => !e.kind || e.kind === 'unclassified')
  if (unclassified.length) {
    console.error('  ❌ 基线里有 ' + unclassified.length + ' 条没有分类/证据 —— 请给 EVIDENCE 补一条规则：')
    for (const u of unclassified) console.error('     ' + u.file + ':' + u.lineNo + '  ' + u.line.slice(0, 120))
    process.exit(1)
  }
  const key = (e) => e.file + ' | ' + e.line
  const bset = new Set(baseline.map(key))
  const aset = new Set(actual.map(key))
  const added = actual.filter((e) => !bset.has(key(e)))
  const gone = baseline.filter((e) => !aset.has(key(e)))
  for (const g of gone) console.log('  ✅ 已消除：' + g.file + ':' + g.lineNo)
  if (added.length) {
    console.error('  ❌ 新增未转义的 innerHTML 拼接 ' + added.length + ' 处：')
    for (const a of added) {
      console.error(`     ${a.file}:${a.lineNo}`)
      console.error(`        裸段：${JSON.stringify(a.parts)}`)
      console.error(`        ${a.line.slice(0, 170)}`)
    }
    console.error('\n  要么加 esc()，要么在 PR 里说明为什么它安全，然后跑 --update。')
    process.exit(1)
  }
  console.log(`✅ innerHTML 转义棘轮通过：基线 ${actual.length} 条，0 条新增${gone.length ? `，已消除 ${gone.length} 条` : ''}`)
  process.exit(0)
}
