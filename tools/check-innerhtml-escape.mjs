#!/usr/bin/env node
/**
 * HTML sink 转义棘轮（issue #14 同 class 的**结构化**护栏）
 *
 * 为什么需要它 —— `tests/render-escape.test.js` 的 ③ 是**按变量名写死**的模式
 * （`+ e.source +` / `+ label +` …）。它对「**新建一条渲染路径**」是盲的：换个变量名、
 * 换个函数，同一类漏洞照样溜过去。而「把两个渲染函数合并成一个 helper」「抽统一拼装函数」
 * 这两种重构动作恰恰最容易漏掉某一路来源 —— PR #13 就是这么翻车的
 * （它转义了 `e.source` / `e.target`，漏了 `label`）。
 *
 * 判据不看变量名，只看**结构**：
 *   把 sink 右边的表达式按**顶层 `+`** 切成段，逐段判定；
 *   只要有一段不是「结构上不可能带 HTML」的形态，整行记为可疑。
 *
 *   结构安全 = 字面量 / esc 函数族调用 / 含 esc 的 .map|filter|join 链 /
 *              `.length` `.count` 计数 / 两支都是字面量的三元
 *   （不做「整行有 esc 就放行」—— 那正是漏掉 "转义了一个、漏了另一个" 的原因）
 *
 * ── 2.7.13 的两处收紧（都是复核方指出的同一类病的延续）─────────────
 * ① **sink 从「只有 .innerHTML」升级为清单**：原先只认 `.innerHTML = / +=`，
 *    对 `insertAdjacentHTML` / `outerHTML` / `document.write` / `createContextualFragment` /
 *    `srcdoc` 全盲（实测后 4 种当前 0 处、srcdoc 1 处）—— 与「按变量名写死」是同一类病，只高了一层。
 *    另外新增 `UNLISTED_SINKS`：清单外一旦出现新的 HTML/代码注入入口，直接报红。
 * ② **不再放过「单段 RHS」**：原判据 `segs.length < 2 → continue` 会把
 *    `el.innerHTML = 动态值`（只有一段，恰恰是最危险的形态）整行跳过。
 *    实测这一条曾静默放过 14 行；现已在基线里逐条过目。
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
 * 受覆盖的 HTML sink 清单。**每种都走同一套结构判据** —— 不给任何一种开后门。
 * - `mode: 'assign'` —— 判 `=` / `+=` 右边的表达式
 * - `mode: 'call'`   —— 判调用参数（首个顶层逗号之后的内容一并参与判定；保守即可）
 */
export const SINKS = [
  { id: 'innerHTML', mode: 'assign', kind: 'html-assign', re: /\.innerHTML\s*(?:=|\+=)/, why: '元素内容整体替换' },
  { id: 'outerHTML', mode: 'assign', kind: 'html-assign', re: /\.outerHTML\s*=(?!=)/, why: '连自身标签一起替换' },
  { id: 'srcdoc', mode: 'assign', kind: 'sandboxed-doc', re: /\.srcdoc\s*=(?!=)/, why: '整份文档注入 iframe；唯一缓解是 sandbox 且不含 allow-same-origin' },
  { id: 'insertAdjacentHTML', mode: 'call', kind: 'html-call', re: /\.insertAdjacentHTML\s*\(/, why: '按位置插入 HTML 片段' },
  { id: 'document.write', mode: 'call', kind: 'html-call', re: /\bdocument\.write\s*\(/, why: '文档级写入（可整页重写）' },
  { id: 'createContextualFragment', mode: 'call', kind: 'html-call', re: /createContextualFragment\s*\(/, why: '把字符串解析成 DOM 片段' },
]

/**
 * **清单外**的注入入口。
 *
 * 这一条和 SINKS 是互补的：SINKS 覆盖「已知入口的内容是否转义」，
 * 这里覆盖「有没有人新开了一个入口」。新增任何一种都必须先来改这份清单
 * （同时补判据 + 补测试），而不是让它悄悄溜过去 —— 否则棘轮会「全绿但没在看」。
 *
 * 前 5 条与 SINKS 同类（HTML sink）；后 3 条是同一条「数据 → 代码」跳的另一批门口
 * （`eval` / `new Function` / `DOMParser` 都能把字符串变成可执行/可渲染的东西），
 * 一并登记，理由是：它们和 innerHTML 的差别只是「跳几次」，不是「性质不同」。
 */
export const UNLISTED_SINKS = [
  { re: /\.insertAdjacentElement\s*\(/, why: 'insertAdjacentElement（清单外：同样按位置插 HTML）' },
  { re: /\bdocument\.writeln\s*\(/, why: 'document.writeln（清单外）' },
  { re: /dangerouslySetInnerHTML/, why: 'dangerouslySetInnerHTML（清单外）' },
  { re: /\.outerHTML\s*\+=/, why: 'outerHTML 累加（清单外的形态）' },
  { re: /\bDOMParser\s*\(/, why: 'DOMParser（可产出 HTML 文档）' },
  { re: /\beval\s*\(/, why: 'eval（字符串 → 代码）' },
  { re: /new\s+Function\s*\(/, why: 'new Function（字符串 → 代码）' },
]

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
  // ── srcdoc：整份文档，转义无从下手；唯一缓解是 iframe 的 sandbox ──
  // ── 局部变量拼装型（2.7.14 结构化判据保守判红）：函数体里先算好局部变量再拼接。
  //    这类**不能**在用处补 esc（局部变量本身含刻意渲染的标记，如 '<div class="t-item-children"'），
  //    故按本仓既有做法进基线 + mustContain 证据：钉住'用户数据那几处确实 esc 了、其余是数字/下标/字面量'。 ──
  { re: /el\.innerHTML = state\.characters\.map\(function/, kind: 'param-by-callers', why: '角色卡列表：checked 为布尔字面量、下标 i 为数字、名称经 esc', mustContain: ["esc(c.name || ('角色' + (i + 1)))", "checked = c.enabled !== false ? 'checked' : ''"] },
  { re: /el\.innerHTML = state\.presets\.map\(function/, kind: 'param-by-callers', why: '预设列表：mods / toggleBtn 由 esc(m.name) 与数字下标拼成', mustContain: ["esc(m.name || ('模块' + (j + 1)))", 'data-pm="\' + i + \'"'] },
  { re: /sel\.innerHTML = '<option value="">选择一个历史对话/, kind: 'param-by-callers', why: '历史对话选择器：id/label/日期串均已 esc，origin 为枚举比较', mustContain: ['esc(s.id)', 'esc(label)', 'esc(d)'] },
  { re: /\.srcdoc\s*=(?!=)/, kind: 'sandboxed-doc', why: 'muv-engine 状态栏：服务端返回另一份完整文档；iframe 只给 allow-scripts（刻意不给 allow-same-origin）⇒ 不透明源，够不到主页面 DOM 与凭据', mustContain: ['sandbox="allow-scripts"'] },

  // ── 静态模板：panelHTML() 是 483 行纯静态骨架，体内 0 处插值 ──
  //    这条的证据不是「某个字符串还在」，而是**结构断言**：函数体内每个插值段都必须已 esc。
  //    （将来有人往模板里塞未转义的动态值，这里会报红 —— 而 sink 那一层是看不见的。）
  { re: /innerHTML = panelHTML\(\)/, kind: 'static-template', why: 'panelHTML() 是纯静态模板（体内 0 处插值）；若将来加入插值，下面的结构断言会要求它已 esc', builder: 'panelHTML' },

  // ── 纯计数 / 服务端算好的数字 ──
  { re: /cleanedTotal/, kind: 'numeric', why: '预设导入的清理计数（数字）', mustContain: ['var cleanedTotal = 0'] },
  { re: /\+ charCount \+/, kind: 'numeric', why: '角色卡/世界书/预设条目计数（.length · reduce）', mustContain: ['var charCount = ', 'var presetEnabledEntries = '] },
  { re: /\+ charCount2 \+/, kind: 'numeric', why: '同上，第二个面板', mustContain: ['var charCount2 = ', 'var presetEnabled2 = '] },
  { re: /wbEntryCount|保存成功！Agent 预设已生成/, kind: 'numeric', why: '「保存成功」提示里的各类计数与大小（预设名已 esc，见 2.7.13 修的另一处）', mustContain: ['var wbEntryCount = ', 'esc(presetName)', 'esc(agentPresetName)'] },
  { re: /\(labelLen \|\| 15\)/, kind: 'numeric', why: 'renderLargeGraph 的 labelLen 形参（像素宽度）', mustContain: ['function renderLargeGraph(container, relations, labelLen)'] },
  { re: /ps-body"\)\.innerHTML=h/, kind: 'numeric', why: '服务端自渲染页的体积面板：h 由 psLine 与 prompt-stats 的计数/大小/时间戳拼成', mustContain: ['function psLine(label,b)', 'pct: Math.round(ratio * 1000) / 10'] },
  { re: /b\.pct|d\.full\.pct/, kind: 'numeric', why: '占窗口百分比 —— 服务端 prompt.js 用 Math.round 算出来，是数字', mustContain: ['pct: Math.round(ratio * 1000) / 10'] },

  // ── 上游已转义 / 由 esc 参与拼装 ──
  // 匹配的是**基线条目存的首行**（不是窗口里的下一行）—— 所以正则要认 `.slice(0, 20).map(`
  { re: /bannedWords\.slice\(0, 20\)\.map/, kind: 'ternary-literals', why: 'map 体已 esc(w)；尾部三元两支都是字面量 + 纯数字算术', mustContain: ["+ esc(w) + '</span>'", '(bannedWords.length - 20)'] },
  { re: /\+ pName \+/, kind: 'upstream-escaped', why: 'pName 与 pMeta 都在上游转过义', mustContain: ["var pName = esc(p.name || '')", "pMeta += '🎭' + esc("] },
  { re: /\+ pMeta2 \+/, kind: 'upstream-escaped', why: 'pMeta2 由 escapeHtml（≡ esc）与数字拼成', mustContain: ["pMeta2 += '🎭' + escapeHtml(", 'p.cardChars'] },
  { re: /box\.innerHTML = h;/, kind: 'upstream-escaped', why: '两处体积/命中提示：h 的构造里逐项 esc（excerpt / hits / tip）；第二处另由 pct 数字与 line() 拼成', mustContain: ["+ esc(d.excerpt) + '…</div>'", "+ esc(tip) + '</div>'", 'pct: Math.round(ratio * 1000) / 10'] },
  { re: /list\.innerHTML = html;/, kind: 'upstream-escaped', why: '世界书列表：分组名与条目正文逐项 esc', mustContain: ["+ esc(group.name) + '</span>'"] },
  { re: /detailPanel\.innerHTML = html;/, kind: 'upstream-escaped', why: '关系网详情面板（边 / 节点两处）：源目标与名称逐项 esc', mustContain: ["🔗 ' + esc(e.source) + ' ↔ ", "👤 ' + esc(n.label || n.id)"] },
  { re: /tooltip\.innerHTML = tooltipHtml;/, kind: 'upstream-escaped', why: '关系网小图 tooltip：节点名 / 对面名 / 关系描述逐项 esc 后整体赋值', mustContain: ["13px\">👤 ' + esc(n.label || n.id)", "+ dir + ' ' + esc(other) + '</span>：' + esc(truncate"] },
  { re: /tooltip\.innerHTML = html;/, kind: 'upstream-escaped', why: '关系网大图 tooltip：同上（另一处渲染路径，字号不同）', mustContain: ["15px\">👤 ' + esc(n.label ||", "+ dir + ' ' + esc(other) + '</span>：' + esc("] },
  { re: /elNextSel\.innerHTML = html;/, kind: 'upstream-escaped', why: '「下次新会话预选」下拉：id 与显示名都经 esc', mustContain: ["html += '<option value=\"' + esc(p.id) + '\"'"] },
  { re: /listEl\.innerHTML = html;/, kind: 'upstream-escaped', why: '全局正则脚本清单：逐行由 rowHtml() 生成，rowHtml 体内 esc/escAttr', mustContain: ["+ escAttr(name) + '\">' + esc(name) + '</span>'", 'esc(placeShorthand(s.placement))'] },
  { re: /contentEl\.innerHTML = html;/, kind: 'dom-roundtrip', why: '消息美化：html 取自 contentEl.innerHTML（已被浏览器解析过的 DOM），经 Latex 渲染与状态卡片追加后写回', mustContain: ['var html = contentEl.innerHTML;'] },

  // ── 参数由调用方保证（helper 把入参当 HTML 写）──
  // 这两条是**结构脆弱**的设计（靠调用方自觉），所以证据钉在「风险数据的那几个调用点必须仍然 esc」。
  { re: /statusEl\.innerHTML = msg;/, kind: 'param-by-callers', why: '全局正则面板的状态行：调用点传的都是字面量或 esc(...)', mustContain: ['esc(String(s.scriptName || id))', 'esc(e.message || String(e))', 'esc(String((errs[i] && errs[i].error) || errs[i]))'] },
]

/** 给一行匹配证据规则；匹配不到返回 unclassified（会被校验拦下）。 */
export function classify(line, sinkId) {
  for (const e of EVIDENCE) if (e.re.test(line)) return { kind: e.kind, why: e.why, mustContain: e.mustContain, builder: e.builder, sink: sinkId }
  return { kind: 'unclassified', why: '', mustContain: [], sink: sinkId }
}

const ESCAPE_CALL = /\b(?:esc|escAttr|escapeHtml|htmlEscapeStr|encodeURIComponent)\s*\(/
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

/**
 * ★ 共享扫描原语 —— `splitTopLevel` / `findTopLevel` / `insideStringSink` / `findUnlistedSinks` **都走这一处**。
 *   ⚠️ 例外：`captureExpr` 仍自带一份引号/正则状态机（历史原因，行为正确但属重复实现）；
 *      第三轮复核指出「全工具只有这一处」这句话与事实不符，故如实标注。
 *
 * 为什么必须唯一：2026-10-08 的对抗性复核证明，captureExpr / splitTopLevel / insideStringSink
 * 三处各自数引号时，正则字面量里的引号（`/['"]/`）只会污染"没被改到的那两处"，
 * 而 splitTopLevel 一旦塌段，segmentIsSafe 就退化成「整行有 esc( 就放行」⇒ 实测 6 类真漏报。
 * 所以：引号/正则/深度感知**只实现一次**，所有扫描器都调它。
 */

/** 给定行内某个 `/` 的下标，判断它是不是**正则字面量的起点**。
 *  依据前一个非空字符：值/右括号之后是除号；否则是正则起点（与各 JS 词法器同款启发式）。 */
function isRegexStart(line, k) {
  if (line[k] !== '/') return false
  const nx = line[k + 1]
  if (nx === '/' || nx === '*') return false          // 注释不是正则
  for (let q = k - 1; q >= 0; q--) {
    const pc = line[q]
    if (pc === ' ' || pc === '\t') continue
    return !/[A-Za-z0-9_$)\]}]/.test(pc)
  }
  return true
}

/**
 * 从正则起点 `/`（含）扫到结束，返回结束下标（含 flags 的最后一个字符）。
 * ★ **不是正则时返回 -1**（而不是 k+1）—— 曾经的哨兵写成 k+1，而调用点判的是 `end > i`，
 *   那是**恒真**的，于是每个除号都被当成正则起点、该行往后的 sink 全部失明。
 *   这是第二轮独立复核抓到的回归（旧实现反而在除号上是对的）。
 */
function regexEndAt(line, k) {
  if (!isRegexStart(line, k)) return -1
  let inClass = false
  let i = k + 1
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') { i++; continue }
    if (c === '[') { inClass = true; continue }
    if (c === ']') { inClass = false; continue }
    if (c === '/' && !inClass) break
  }
  if (i >= line.length) return k + 1                        // 未闭合：保守地只跳过这个字符
  i++
  while (i < line.length && /[a-z]/i.test(line[i])) i++      // flags
  return i - 1
}

/**
 * 逐字符遍历一行代码，**引号 / 正则 / 模板 / 深度全部感知**，并逐个回调。
 * @param {(c: string, index: number, ctx: {inLiteral: boolean, depth: number}) => void} cb
 *   `inLiteral=true` 表示该字符落在字符串/正则字面量内部（含起止引号本身）。
 */
function eachCodeChar(line, cb) {
  let quote = ''   // 当前所在字面量（含正则用 '/' 标记）
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      cb(c, i, { inLiteral: true, depth })
      if (quote === '/') { if (c === '\\') { i++; continue } if (c === '/') quote = ''; continue }
      if (c === '\\') { i++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cb(c, i, { inLiteral: true, depth }); continue }
    if (c === '/') {
      const end = regexEndAt(line, i)
      if (end >= 0) {                      // 是正则字面量：整段按字面量处理
        quote = '/'
        cb(c, i, { inLiteral: true, depth })
        continue
      }
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    cb(c, i, { inLiteral: false, depth })
  }
}
/** 按**顶层**分隔符切分（尊重引号、正则与 ()[]{} 深度）。 */
export function splitTopLevel(expr, delim = '+') {
  const parts = []
  let cur = ''
  eachCodeChar(expr, (c, i, ctx) => {
    if (!ctx.inLiteral && c === delim && ctx.depth === 0 && !cur.endsWith('\\')) {
      parts.push(cur)
      cur = ''
      return
    }
    cur += c
  })
  parts.push(cur)
  return parts
}

/**
 * 在**顶层**按任意「会破坏安全性的」运算符切分：
 *   `+ - * / % && || ?? ? : ,` —— 只要这些出现在顶层，两侧就是**各自独立**的表达式，
 *   必须**每一段**都安全。
 * 为什么要它（复核报告 §2）：原先只切 `+`，于是
 *   `? esc(a) : raw`、`esc(a) && raw`、`f(esc(a), raw)`、`.map(x => esc(x.a) + x.b)`
 * 全都塌成一段，而 `segmentIsSafe` 见到段内有 `esc(` 就放行 ⇒ 真漏报。
 */
export function splitOperators(expr) {
  return splitTopLevelAny(expr, ['?', ':', ',', '&', '|', '+', '-', '*', '/', '%'])
}

function splitTopLevelAny(expr, delims) {
  const parts = []
  let cur = ''
  eachCodeChar(expr, (c, i, ctx) => {
    if (!ctx.inLiteral && ctx.depth === 0 && delims.includes(c)) { parts.push(cur); cur = ''; return }
    cur += c
  })
  parts.push(cur)
  return parts
}

/** 在顶层找某个分隔符的下标（从 from 开始），找不到返回 -1（同样走共享原语） */
function findTopLevel(expr, delim, from = 0) {
  let found = -1
  eachCodeChar(expr, (c, i, ctx) => {
    if (found < 0 && !ctx.inLiteral && ctx.depth === 0 && c === delim && i >= from) found = i
  })
  return found
}

/**
 * 「字面量」的判定。
 * ★ 模板字面量只有在**不含 ${ 插值**时才算字面量 —— `` `<div>${x}</div>` `` 是拼接的另一种写法，
 *   不是字面量。实测旧写法把这种形态判成安全（当前仓库 0 处使用，收紧零成本；这是写回执时
 *   又探测出来的一处盲区 —— 与「单段 RHS」「跨行续行」同属「判据自己的洞」）。
 */
export function isLiteral(x) {
  const s = x.trim()
  if (/^'([^'\\]|\\.)*'$/.test(s) || /^"([^"\\]|\\.)*"$/.test(s)) return true
  if (/^`[^`]*`$/.test(s)) return !s.includes('${')
  return /^-?[\d.]+$/.test(s) || /^(true|false|null|undefined)$/.test(s)
}

/**
 * 这一段是不是「结构上不可能带 HTML」？
 *
 * ★ 2.7.14 起改成**结构化递归**判定（复核报告 §2 的直接后果）：
 *   旧口径里有一条 `ESCAPE_CALL.test(s) → true`（整段里出现 `esc(` 就放行），
 *   一旦上游把表达式塌成一段，它就退化成「整行有 esc 就放行」——实测放过了这些真洞：
 *     · `<img src="${esc(u)}" onerror="${raw}">`（模板里一个转义一个裸插值）
 *     · `(raw + esc(a))` / `esc(a) && raw` / `? esc(a) : raw`
 *     · `f(esc(a), raw)`（实参里混一个裸值）
 *     · `.map(x => esc(x.a) + x.b)`（PR #13 那一类）
 *   现在的要求：**纯 esc 调用**才算安全；组 / 实参 / 三元各分支 / 模板插值 / 链内表达式
 *   一律**递归**检查，任一处不安全即整段不安全。深度上限 6，超过按不安全处理（保守）。
 */
export function segmentIsSafe(x, d = 0) {
  const s = String(x).trim()
  if (s === '') return true
  if (d > 6) return false
  if (isLiteral(s)) return true
  // 计数 / 纯数字 / `xxx || 0` 兜底
  if (/\.(length|count)$/.test(s)) return true
  if (/^-?[\d.]+$/.test(s)) return true
  // ★ 不再接受 `(x || 0)`：字符串 x 为真时原样注入（第三轮复核 N3）。
  //   计数型兜底的判定挪到「值来源」断言（ORIGINS）里，那里能看拼装上下文。
  // 具名/匿名函数表达式：形参与声明不参与拼接 ⇒ 只判**函数体**（`function (s) { return esc(s.id); }` 安全）
  const fn = s.match(/^function\b[^{]*\{([\s\S]*)\}$/)
  if (fn) return statementsSafe(fn[1], d + 1)
  // 箭头函数：形参不参与 HTML 构造 ⇒ 只判**函数体**（`x => esc(x.a)` 是安全的）
  const arrow = s.match(/^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/)
  if (arrow) {
    const body = arrow[1].trim()
    // ★ 块体箭头（`x => { return esc(x); }`）也要走语句级判定（第五轮修 M1：原先只认表达式体）
    if (body.startsWith('{') && body.endsWith('}')) return statementsSafe(body.slice(1, -1), d + 1)
    return segmentIsSafe(body, d + 1)
  }
  // 顶层三元：条件只决定"选哪支"，两支各自才可能带 HTML ⇒ 只判两支
  const q = findTopLevel(s, '?')
  if (q > 0) {
    const c = findTopLevel(s, ':', q + 1)
    if (c > q) {
      return segmentIsSafe(s.slice(q + 1, c), d + 1) && segmentIsSafe(s.slice(c + 1), d + 1)
    }
  }
  // 纯 esc 家族调用（整段就是它，且括号闭合）：安全 —— 这正是 esc 的意义
  if (/^(?:esc|escAttr|escapeHtml|htmlEscapeStr)\s*\(/.test(s) && closesAtEnd(s, s.indexOf('('))) return true
  // 模板字面量：逐个 ${…} 递归
  if (s.startsWith('`') && s.endsWith('`') && s.length > 1) {
    const interps = templateInterps(s)
    if (!interps.length) return true
    return interps.every((t) => splitOperators(t).every((p) => segmentIsSafe(p, d + 1)))
  }
  // 组：( … ) — 递归内部
  // 组：( … ) — **先递归判内部整串**（内部若还是三元/箭头，会先被上面那两条识别），
  // 再退回按运算符切分。写成"先切分"会让 `(cond ? '' : 'x')` 的 cond 被当成裸标识符：
  // 实测这正是真实代码里两条 ternary-literals 基线条目被判红的原因。
  if (s.startsWith('(') && closesAtEnd(s, 0)) {
    const inner = s.slice(1, -1)
    if (segmentIsSafe(inner, d + 1)) return true
    return splitOperators(inner).every((p) => segmentIsSafe(p, d + 1))
  }
  // 顶层运算符：两侧各自独立 ⇒ 每段都要安全（这一条覆盖 `+ && || ?? ? : ,`）
  const parts = splitOperators(s)
  if (parts.length > 1) return parts.every((p) => segmentIsSafe(p, d + 1))
  // 一元/成员取值链：把**所有成对括号**的内容当参数表递归（覆盖 f(a, raw) 与 .map(x => …) 这类）
  const groups = parenGroups(s)
  if (groups.length) {
    for (const g of groups) {
      if (!splitOperators(g).every((p) => segmentIsSafe(p, d + 1))) return false
    }
    // 括号都安全还不够：`raw.slice(0, 1)` 里的 `raw` 在括号外。
    // 但集合方法链（map/filter/forEach/reduce/join）的接收者**不是**被拼进 HTML 的数据 ——
    // 它的元素由回调处理，而回调体上面已经递归判过了 ⇒ 这类豁免；其余一律按裸标识符处理。
    const outside = stripGroups(s)
    // ★ 只有带回调的集合方法才豁免接收者（元素由回调处理、而回调体已判过）；
    //   `.join(` 单独出现不算 —— 否则 `items.join('')` 这种「接收者元素直接进 HTML」会放行（第三轮复核 N2）。
    const collectionChain = /\.(map|filter|forEach|reduce|flatMap)\s*\(/.test(s)
    const outsideNoCallee = outside.replace(/[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*(?=\()/g, '')
    if (collectionChain) {
      // 集合方法链：把「接收者+方法」整条链（到每个 ( 之前）都去掉 —— 元素已由回调处理
      const rest = outside.replace(/[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?=\()/g, '')
      return !/[A-Za-z_$]/.test(rest)
    }
    if (/[A-Za-z_$]/.test(outside)) return false
    return true
  }
  return false   // 其余（含裸标识符）一律保守判不安全
}

/** 语句块安全判定：按 `;`/换行切分，逐句去掉 `return`/`var` 等前缀后递归。 */
/**
 * 语句块安全判定：按 `;`/换行切分，逐句判定。
 *
 * ★ 第五轮修 M2（复核方给的最小反例）：
 *   ① `var h = esc(a) + 'b'` 这类**赋值**只判**右侧**（左值是名字，不是数据）；
 *   ② 本体内被赋值过的名字，在**后续**语句里视为安全（把 `h` 换成 `0` 再判）——
 *      这样「函数体里先算局部变量再拼接」不再误报，也能撤掉为它加的那几条基线。
 */
function statementsSafe(body, d) {
  const stmts = String(body).split(/;|\n/).map((x) => x.trim()).filter(Boolean)
  const locals = []
  const bad = []
  for (let i = 0; i < stmts.length; i++) {
    let t = stmts[i].replace(/^(?:return|throw|var|let|const)\s+/, '').replace(/;\s*$/, '').trim()
    const assign = t.match(/^([A-Za-z_$][\w$]*)\s*(?:=|\+=)\s*([\s\S]+)$/)
    if (assign) {
      const rhs = assign[2]
      if (!segmentIsSafe(rhs, d + 1)) bad.push(t)
      locals.push(assign[1])
      continue
    }
    // 后续语句里，已赋值的名字按数字（安全）处理；字符串里的替换无副作用
    for (const name of locals) t = t.replace(new RegExp('\\b' + name + '\\b', 'g'), '0')
    if (t !== '' && !segmentIsSafe(t, d)) bad.push(stmts[i])
  }
  return bad.length === 0
}

/** 提取模板字面量里的 `${…}` 内容（**括号配平**，容忍嵌套 `}` 与对象字面量 —— 第五轮修 M4）。 */
function templateInterps(str) {
  const out = []
  for (let i = 0; i + 1 < str.length; i++) {
    if (str[i] !== '$' || str[i + 1] !== '{') continue
    let depth = 0
    for (let k = i + 1; k < str.length; k++) {
      if (str[k] === '{') depth++
      else if (str[k] === '}') { depth--; if (depth === 0) { out.push(str.slice(i + 2, k)); i = k; break } }
    }
  }
  return out
}

/** 下标 openIdx 处的 `(` 是否正好在**串尾**闭合（用于识别"整段就是一个调用"）。 */
function closesAtEnd(s, openIdx) {
  if (openIdx < 0 || s[openIdx] !== '(') return false
  let depth = 0
  let endAt = -1
  eachCodeChar(s, (c, i, ctx) => {
    if (ctx.inLiteral) return
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0 && endAt < 0) endAt = i }
  })
  return endAt === s.length - 1
}

/** 取出串内**所有最外层成对括号**的内容（走共享原语，引号/正则安全）。 */
function parenGroups(s) {
  const out = []
  let depth = 0
  let start = -1
  eachCodeChar(s, (c, i, ctx) => {
    if (ctx.inLiteral) return
    if (c === '(') { if (depth === 0) start = i; depth++ }
    else if (c === ')') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start + 1, i)); start = -1 } }
  })
  return out
}

/**
 * 去掉成对括号**里面的内容**，但**保留括号本身** —— 用于检查括号外的裸标识符。
 * ★ 必须保留 `()`：调用方的 `IDENT.IDENT(?=\()` 是靠 lookahead 认「被调用者」的，
 *   把括号一起剥掉会让 `list.map.join` 这种链认不出来（实测：安全 map 被误报）。
 */
function stripGroups(s) {
  let out = ''
  let depth = 0
  eachCodeChar(s, (c, i, ctx) => {
    if (ctx.inLiteral) { if (depth === 0) out += c; return }
    if (c === '(') { depth++; out += c; return }
    if (c === ')') { depth--; out += c; return }
    if (depth === 0) out += c
  })
  return out
}

/**
 * 从 sink 标记之后把表达式补全。
 *
 * 三条边界（每一条都是实测踩出来的）：
 *   ① 在**第一个顶层 `;`** 截断 —— 否则 `el.innerHTML = 'x'; return; }` 的行尾代码
 *      会被吃进最后一段，制造假阳性（实测吃进来 13 行）。
 *   ② 遇到**越界的闭括号**（`epth` 已经为 0 又来 `}` / `)`）立刻收尾 ——
 *      行尾的 `});` 属于外层语句，不属于本表达式。
 *   ③ 续行判断除了「括号/引号未闭合」，还要认「行尾是顶层运算符」
 *      （`'<div>' +` ⇒ 下一行还有内容）。旧实现只认前者，会把跨行拼接的续行整段漏掉。
 */
export function captureExpr(lines, startLine, startCol) {
  const endsOpen = (t) => /[+,\-*/%&|?:]$/.test(t.trim())
  /** 下一行是不是「表达式续行」？必须排除注释行 ——
   *  JSDoc 的 `* ...` 与行注释 `// ...` 都以运算符字符开头，误判会把注释吃进表达式（假阳性）。 */
  const startsOpen = (t) => {
    const x = String(t).trim()
    if (x === '' || x.startsWith('//') || x.startsWith('/*') || x.startsWith('*')) return false
    return /^[+,\-/%&|?:]/.test(x)
  }
  /** 该位置是否落在正则字面量里（`/` 出现在"期待表达式"的位置才算正则起点）。
   *  为什么要它：`/['"]/` 里的引号会污染引号状态跟踪，导致捕获文本吃掉行尾 `;`。 */
  const regexStartsAt = (line, k) => {
    if (line[k] !== "/") return false
    for (let q = k - 1; q >= 0; q--) {
      const pc = line[q]
      if (pc === " " || pc === "\t") continue
      return !/[A-Za-z0-9_$)\]}]/.test(pc)   // 前面是值/右括号 ⇒ 这是除号；否则是正则起点
    }
    return true
  }
  let text = ''
  let depth = 0
  let quote = ''
  for (let li = startLine; li < Math.min(startLine + 40, lines.length); li++) {   // ★ 12 → 40：13 行以上的拼接曾被静默截断（第三轮复核 N6）
    const line = li === startLine ? String(lines[li]).slice(startCol) : String(lines[li])
    let cut = -1                                  // 行尾注释的起点（本轮修复 ②）
    for (let k = 0; k < line.length; k++) {
      const c = line[k]
      if (quote) {
        if (c === '\\') { const nx = line[k + 1] === undefined ? '' : line[k + 1]; k++; text += c + nx; continue }
        if (c === quote) quote = ''
        text += c
        continue
      }
      // 正则字面量：整段跳过（本轮修复 ③）
      if (c === '/' && line[k + 1] !== '/' && line[k + 1] !== '*' && regexStartsAt(line, k)) {
        text += c
        let inClass = false
        for (k++; k < line.length; k++) {
          const rc = line[k]
          text += rc
          if (rc === '\\') { if (k + 1 < line.length) { text += line[k + 1]; k++ } continue }
          if (rc === '[') inClass = true
          else if (rc === ']') inClass = false
          else if (rc === '/' && !inClass) break
        }
        continue
      }
      // 行尾注释：到行末为止都不算表达式（本轮修复 ②）
      if (c === '/' && line[k + 1] === '/') { cut = k; break }
      if (c === '"' || c === "'" || c === '`') { quote = c; text += c; continue }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return text.trim()     // ② 越界闭括号：表达式到此为止
        depth--
      } else if (c === ';' && depth === 0) {
        return text.trim()                      // ① 顶层分号：表达式到此为止
      }
      text += c
    }
    const next = lines[li + 1] === undefined ? '' : String(lines[li + 1])
    // ③ 续行判断：括号/引号未闭合、行尾是顶层运算符，或**下一行以顶层运算符开头**
    //    （最后这条是复核方 2026-10-08 的发现：旧实现只认"行尾"，`= esc(a)` 换行 `+ raw;` 会整段漏判）
    if (depth <= 0 && !quote && !endsOpen(text) && !startsOpen(next)) return text.trim()
    text += '\n'
  }
  return text.trim()
}

/**
 * 找出**不在字符串字面量里**的 sink 匹配。
 * 为什么要它：`const msg = "el.innerHTML = " + esc(x)` 里的 sink 文本只是普通字符串，
 * 旧实现会把它当成真 sink，产出垃圾段（复核方 2026-10-08 报的假阳性形态）。
 * 做法：逐字符走到匹配位置，数引号；落在字符串里就返回 null。
 * @returns {RegExpMatchArray|null}
 */
/**
 * 一行里**所有**不在字面量里的 sink 匹配（逐个返回）。
 * 为什么要它：同一行可能有第二个 sink（`el.innerHTML = esc(a); el.innerHTML += raw;`），
 *   `String.match` 只给第一个 ⇒ 后面的裸拼永远不被判（第二轮复核 N5）。
 */
function allSinkMatches(line, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out = []
  let m
  while ((m = g.exec(line))) {
    let inside = false
    eachCodeChar(line, (c, i, ctx) => { if (i === m.index) inside = ctx.inLiteral })
    if (!inside) out.push(m)
    if (m[0] === '') g.lastIndex++        // 空匹配防死循环
  }
  return out
}

function insideStringSink(line, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = g.exec(line))) {
    let inside = false
    // ★ 必须看「匹配点**是否正在**字面量里」：写成「之前有没有出现过字面量」会被前面任意一个
    //   字符串/正则带偏 ⇒ 真 sink 被整行跳过（复核报告 G3 就是这个漏报）。
    eachCodeChar(line, (c, i, ctx) => { if (i === m.index) inside = ctx.inLiteral })
    if (!inside) return m
  }
  return null
}

/**
 * 扫描一段源码里的可疑行（**所有 sink** 走同一套判据）。
 * @returns {{line:string,lineNo:number,sink:string,parts:string[]}[]}
 */
export function findSuspects(src) {
  const lines = String(src).split(/\r?\n/)
  const out = []
  const seen = new Map()   // "sink|line" -> 已出现次数（区分同文本的重复行）
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue
    for (const sink of SINKS) {
      // ★ 逐个匹配：同一行可能有第二个 sink（`el.innerHTML = esc(a); el.innerHTML += raw;`），
      //   只取第一个会让后面的裸拼永远不被判（第二轮复核 N5）。
      for (const m of allSinkMatches(lines[i], sink.re)) {
      const expr = captureExpr(lines, i, m.index + m[0].length)
      if (!expr) continue
      const segs = splitOperators(expr)
      const bad = segs.filter((s) => !segmentIsSafe(s))
      if (!bad.length) continue
      const line = lines[i].trim().replace(/\s+/g, ' ')
      // ★ 同一份文件里可能有两行**文本完全相同**的 sink（实测：`box.innerHTML = h;` 出现两次、
      //   `detailPanel.innerHTML = html;` 出现两次）。只用行文本做键会让它们互相覆盖 ——
      //   棘轮就分不清「消掉了一条」还是「另一条还在」。所以加一个同文本内的序号。
      const k = sink.id + '|' + line
      const occ = (seen.get(k) || 0) + 1
      seen.set(k, occ)
      out.push({
        line,
        lineNo: i + 1,
        occ,
        sink: sink.id,
        kind: sink.kind,
        parts: bad.map((s) => s.trim().replace(/\s+/g, ' ')),
      })
      }   // ← 逐个匹配的循环闭合（N5）
    }
  }
  return out
}

/**
 * 结构断言：**函数体内**每个插值段都必须「结构上不可能带 HTML」。
 *
 * 用来给「sink 的右边是整块模板」这种情况提供机器可验证的证据 ——
 * 例如 `root.innerHTML = panelHTML()`：sink 那一层只看到 `panelHTML()` 一个词，
 * 真正要守的是**函数体内**不许出现未转义的插值。模板里加东西这里会报红，sink 那层看不见。
 * @returns {string[]} 违规说明
 */
export function bodyInterpolationsUnsafe(src, fnName) {
  const lines = String(src).split(/\r?\n/)
  const i = lines.findIndex((l) => new RegExp('^(?:\\s*)(?:export\\s+)?(?:async\\s+)?function\\s+' + fnName + '\\s*\\(').test(l))
  if (i < 0) return [`找不到函数 ${fnName}（builder 证据失效）`]
  let depth = 0
  let end = -1
  for (let k = i; k < lines.length; k++) {
    for (const c of lines[k]) { if (c === '{' || c === '(' || c === '[') depth++; else if (c === '}' || c === ')' || c === ']') depth-- }
    if (k > i && depth <= 0) { end = k; break }
  }
  if (end < 0) return [`函数 ${fnName} 的括号未配平（无法做结构断言）`]
  const issues = []
  for (let k = i; k <= end; k++) {
    const l = lines[k]
    if (isCommentLine(l)) continue
    if (!/['"`]\s*\+|\+\s*['"`]/.test(l)) continue          // 只看带字符串拼接的行
    // 去掉语句前缀（`return ` / `var x = ` / `x = ` / `x += `）与行尾 `;`，只判表达式部分
    const pre = l.match(/^\s*(?:return\s+|throw\s+)?(?:(?:var|let|const)\s+)?(?:[A-Za-z_$][\w$.[\]]*\s*(?:\+=|=)\s*)?/)
    const expr = l.slice(pre ? pre[0].length : 0).replace(/;\s*$/, '')
    for (const s of splitOperators(expr)) {
      const t = s.trim()
      if (t === '' || segmentIsSafe(t)) continue
      issues.push(`${fnName}:${k + 1}  未转义插值段 ${JSON.stringify(t.slice(0, 90))}`)
    }
  }
  return issues
}

/**
 * 「值来源」结构断言 —— 针对 sink 右边是**变量/参数**的情况。
 *
 * 为什么需要它：sink 那一层只看到一个词（`statusEl.innerHTML = msg` 或 `setStatus(html, …)`），
 * 真正要守的是**这个值是怎么拼出来的**。`mustContain` 只能钉住"某些片段还在"，
 * 挡不住"往同一条拼装链里新加一个未转义片段"（钉的片段都还在 ⇒ 照样全绿）。
 * 这正是复核方 2026-10-08 对 `param-by-callers` 类条目提出的要求：
 * **「往同一条链里新加一个未转义片段必须报红」**。
 *
 * 判定规则（刻意窄，且写在这里供审计）：从**声明行**到**调用行**之间，
 * 每一条对该变量的赋值/累加语句，其表达式按顶层 `+` 分段后，每段必须是：
 *   · 字面量 / esc 函数族 / 计数器（`.length` · `.count`）；或
 *   · 数字型惯用法：`xxx || 0`（计数兜底）或纯数字。
 * ⚠️ **已知窄口径**：`(d.note || 0)` 这种"标识符 + `|| 0`"会被当成数字 —— 若该位置将来真的放文本数据，
 *    要**改这条判据**，而不是放宽它。
 *
 * 证据失效（找不到声明行/调用行）⇒ 返回一条 issue（**不许静默通过**）。
 * @returns {string[]} 违规说明（空数组 = 通过）
 */
export const ORIGINS = [
  {
    file: 'lib/client.manager.bundle.js',
    name: '全局正则面板的状态行：statusEl ← html',
    varName: 'html',
    decl: 'var html = \'✅ 导入完成',
    call: 'setStatus(html',
    why: '入参 html 由「导入完成」计数与 esc(...) 拼成；改 textContent 会把 <br><span> 标记当文字显示，故保留 innerHTML + 值来源断言',
  },
]

/** 数字型惯用法（`值来源` 断言专用）：`xxx || 0` 兜底、纯数字、计数属性。
 *  ⚠️ 它**只**用于 ORIGINS 的拼装链检查（那里能看上下文）；`segmentIsSafe` 已不再接受 `|| 0`
 *     —— 那会让 `(name || 0)` 这种文本值放行（第三轮复核 N3）。 */
const numberish = (s) => /^\(?\s*[A-Za-z_$][\w$.]*\s*\|\|\s*0\s*\)?$/.test(s) || /\.(length|count)$/.test(s) || /^-?[\d.]+$/.test(s)

export function valueOriginUnsafe(src, spec) {
  const lines = String(src).split(/\r?\n/)
  const di = lines.findIndex((l) => l.includes(spec.decl))
  if (di < 0) return [spec.name + '：找不到声明行「' + spec.decl + '」—— 证据失效（函数被重构/改名？请同步 ORIGINS）']
  const ci = lines.findIndex((l, i) => i >= di && l.includes(spec.call))
  if (ci < 0) return [spec.name + '：找不到调用行「' + spec.call + '」—— 证据失效（请同步 ORIGINS）']
  const assignRe = new RegExp('\\b' + spec.varName + '\\s*(?:\\+=|=(?!=))')
  const issues = []
  for (let k = di; k <= ci; k++) {
    const l = lines[k]
    if (isCommentLine(l)) continue
    const m = l.match(assignRe)
    if (!m) continue
    const expr = l.slice(m.index + m[0].length).replace(/;\s*$/, '')
    for (const seg of splitOperators(expr)) {
      const t = seg.trim()
      if (t === '' || isLiteral(t) || segmentIsSafe(t) || numberish(t)) continue
      issues.push(spec.name + ':' + (k + 1) + '  未转义片段 ' + JSON.stringify(t.slice(0, 90)))
    }
  }
  return issues
}
/** 去掉行尾注释与字面量内容（留下代码骨架）。用于「清单外入口」判定：
 *  `const s = 'eval('` 或 `// eval(x)` 是文字而非入口 —— 否则整跑 exit 1，
 *  让人去登记一个并不存在的注入点（第二轮复核 ⑥）。 */
function stripCommentsAndLiterals(line) {
  let out = ''
  eachCodeChar(line, (c, i, ctx) => { if (!ctx.inLiteral) out += c })
  return out.split('//')[0]
}

/** 清单外的注入入口（返回到命中的行）。 */
export function findUnlistedSinks(src) {
  const lines = String(src).split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue
    const codeOnly = stripCommentsAndLiterals(lines[i])
    for (const u of UNLISTED_SINKS) {
      if (u.re.test(codeOnly)) out.push({ lineNo: i + 1, line: lines[i].trim().replace(/\s+/g, ' '), why: u.why })
    }
  }
  return out
}

/**
 * srcdoc 的 sandbox 断言（**断言，不是注释**）：
 *   · 有 srcdoc sink ⇒ 必须存在 sandbox 属性；
 *   · 该 sandbox 的取值里**不许**出现 allow-same-origin
 *     （否则 iframe 与主页面同源 ⇒ 它能碰到主页面的 DOM 与凭据，srcdoc 就真成了注入点）。
 * @returns {string[]} 违规说明（空数组 = 通过）
 */
export function checkSrcdocSandbox(src, suspects = findSuspects(src)) {
  const text = String(src)
  const srcdocSinks = suspects.filter((s) => s.sink === 'srcdoc')
  if (!srcdocSinks.length) return []
  const issues = []
  const attrs = [...text.matchAll(/sandbox\s*=\s*"([^"]*)"/g)].map((m) => m[1])
  if (!attrs.length) {
    issues.push(`有 ${srcdocSinks.length} 处 srcdoc 但全文件找不到 sandbox 属性 —— srcdoc 没有任何缓解`)
  }
  for (const v of attrs) {
    if (/(^|\s)allow-same-origin(\s|$)/.test(v)) {
      issues.push(`sandbox="${v}" 含 allow-same-origin —— srcdoc 会变成同源注入点（不许加）`)
    }
  }
  return issues
}

export function scanFiles(files) {
  const all = []
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(REPO, f)
    if (!fs.existsSync(abs)) continue
    const rel = path.relative(REPO, abs).replace(/\\/g, '/')
    for (const s of findSuspects(fs.readFileSync(abs, 'utf8'))) all.push({ file: rel, ...s })
  }
  return all
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const actual = scanFiles(TARGETS)
  if (argv.includes('--json')) { console.log(JSON.stringify(actual, null, 2)); process.exit(0) }

  // ① 清单外入口：先查这个，因为它是「棘轮没在看」的问题
  const unlisted = []
  for (const f of TARGETS) {
    const abs = path.join(REPO, f)
    if (!fs.existsSync(abs)) continue
    for (const u of findUnlistedSinks(fs.readFileSync(abs, 'utf8'))) unlisted.push({ file: f, ...u })
  }
  if (unlisted.length) {
    console.error('  ❌ 出现清单外的注入入口 ' + unlisted.length + ' 处 —— 先把它登记进 SINKS/UNLISTED_SINKS 并补判据与测试：')
    for (const u of unlisted) console.error(`     ${u.file}:${u.lineNo}  ${u.why}\n        ${u.line.slice(0, 160)}`)
    process.exit(1)
  }

  // ② srcdoc 的 sandbox 断言
  let sandboxIssues = []
  for (const f of TARGETS) {
    const abs = path.join(REPO, f)
    if (!fs.existsSync(abs)) continue
    const src = fs.readFileSync(abs, 'utf8')
    for (const i of checkSrcdocSandbox(src)) sandboxIssues.push(f + ' → ' + i)
  }
  if (sandboxIssues.length) {
    console.error('  ❌ srcdoc 的 sandbox 断言不通过：')
    for (const i of sandboxIssues) console.error('     ' + i)
    process.exit(1)
  }

  // ④ 值来源断言：sink 右边是变量时，守「它怎么拼出来的」（清单见 ORIGINS）
  const originIssues = []
  for (const spec of ORIGINS) {
    const abs = path.join(REPO, spec.file)
    if (!fs.existsSync(abs)) { originIssues.push(spec.file + ' 不存在（ORIGINS 证据失效）'); continue }
    for (const i of valueOriginUnsafe(fs.readFileSync(abs, 'utf8'), spec)) originIssues.push(spec.file + ' → ' + i)
  }
  if (originIssues.length) {
    console.error('  ❌ 值来源断言不通过（拼装链里出现未转义片段）：')
    for (const i of originIssues) console.error('     ' + i)
    process.exit(1)
  }

  // ③ 结构断言：基线条目里带 builder 的，要求**该条目所在的文件里**那个函数体内没有未转义插值
  //    （所以必须在算出 entries 之后才能跑 —— 否则会在不含该函数的文件里误报「找不到函数」）
  const builderIssues = (entries) => {
    const out = []
    const pairs = new Map()
    for (const e of entries) {
      if (!e.builder) continue
      pairs.set(e.file + '::' + e.builder, { file: e.file, fn: e.builder })
    }
    for (const { file, fn } of pairs.values()) {
      const abs = path.join(REPO, file)
      if (!fs.existsSync(abs)) continue
      for (const i of bodyInterpolationsUnsafe(fs.readFileSync(abs, 'utf8'), fn)) out.push(file + ' → ' + i)
    }
    return out
  }
  const dieOnBuilder = (entries) => {
    const iss = builderIssues(entries)
    if (iss.length) {
      console.error('  ❌ 模板结构断言不通过（函数体内出现未转义插值）：')
      for (const i of iss) console.error('     ' + i)
      process.exit(1)
    }
  }

  if (argv.includes('--update')) {
    const entries = actual.map(({ file, line, lineNo, occ, sink, kind, parts }) => {
      const c = classify(line, sink)
      // ★ 注意顺序：`c.kind` 是**证据分类**（numeric / upstream-escaped / …），
      //   `kind` 是 **sink 自身的形态**（html-assign / sandboxed-doc）。两者不同，
      //   曾经写反过 ⇒ 23 条全被标成 html-assign，分类数据整段作废。
      const e = { file, line, lineNo, occ, sink, sinkKind: kind, parts, kind: c.kind || kind, why: c.why, mustContain: c.mustContain }
      if (c.builder) e.builder = c.builder
      return e
    })
    dieOnBuilder(entries)
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      note: 'HTML sink 裸拼基线：只许减不许增。每条都经人工过目（判据见 tools/check-innerhtml-escape.mjs 头注释）。',
      sinks: SINKS.map((s) => s.id),
      entries,
    }, null, 2) + '\n')
    console.log(`已写入基线 ${entries.length} 条 -> ${path.relative(REPO, BASELINE_FILE)}`)
    const un = entries.filter((e) => e.kind === 'unclassified')
    if (un.length) {
      console.log(`  ⚠️ 其中 ${un.length} 条没有分类/证据（校验时会失败，请给 EVIDENCE 补规则）：`)
      for (const u of un) console.log('     ' + u.file + ':' + u.lineNo + '  ' + u.line.slice(0, 110))
    }
    process.exit(0)
  }

  const baseline = fs.existsSync(BASELINE_FILE) ? (JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).entries || []) : []
  dieOnBuilder(baseline)
  const unclassified = baseline.filter((e) => !e.kind || e.kind === 'unclassified')
  if (unclassified.length) {
    console.error('  ❌ 基线里有 ' + unclassified.length + ' 条没有分类/证据 —— 请给 EVIDENCE 补一条规则：')
    for (const u of unclassified) console.error('     ' + u.file + ':' + u.lineNo + '  ' + u.line.slice(0, 120))
    process.exit(1)
  }
  const key = (e) => e.file + ' | ' + (e.sink || 'innerHTML') + ' | ' + (e.occ || 1) + ' | ' + e.line
  const bset = new Set(baseline.map(key))
  const aset = new Set(actual.map(key))
  const added = actual.filter((e) => !bset.has(key(e)))
  const gone = baseline.filter((e) => !aset.has(key(e)))
  for (const g of gone) console.log('  ✅ 已消除：' + g.file + ':' + g.lineNo + '  [' + (g.sink || 'innerHTML') + ']')
  if (added.length) {
    console.error('  ❌ 新增未转义的 sink 拼接 ' + added.length + ' 处：')
    for (const a of added) {
      console.error(`     ${a.file}:${a.lineNo}  [${a.sink}]`)
      console.error(`        裸段：${JSON.stringify(a.parts)}`)
      console.error(`        ${a.line.slice(0, 170)}`)
    }
    console.error('\n  要么加 esc()，要么在 PR 里说明为什么它安全，然后跑 --update。')
    process.exit(1)
  }
  const bySink = {}
  for (const e of actual) bySink[e.sink] = (bySink[e.sink] || 0) + 1
  const dist = Object.entries(bySink).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'
  console.log(`✅ HTML sink 转义棘轮通过：基线 ${actual.length} 条，0 条新增${gone.length ? `，已消除 ${gone.length} 条` : ''}`)
  console.log(`   分布：${dist}；清单外入口 0 处；srcdoc sandbox 断言通过`)
  process.exit(0)
}
