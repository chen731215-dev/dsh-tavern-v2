// ════════════════════════════════════════════════════════════════
// S3「样式令牌层」的两条常驻棘轮（task-5 硬约束 ①②）
//
// 为什么要有它（task-5 卡）：S3 要新增 `--tv-*` 语义令牌并把硬编码样式逐步换成令牌引用，
// 而这类"逐处替换"的重构有一个**本仓反复吃过的失效形态**：改着改着把既有样式弄丢/弄窄了，
// 却因为"没人在看集合"而全绿。所以这里把两件事钉成机器判据：
//
//   ① **CSS 类名只加不删**：`tools/css-token-baseline.json` 的 `classes` 必须**仍是现状的子集**；
//      真要删某个类名，必须在 `classRemovals` 里逐条登记（类名 + 理由），且登记不许陈旧。
//   ② **`--tv-*` 令牌必须限定在 `#tavern-manager` 作用域**：不许出现顶层 `:root { --tv-… }`
//      （那会把变量泄漏到面板之外，与"面板自带样式"的既有约定冲突）；引用必须有定义。
//
// 两条都带**非空跑下限**（解析不出东西 ⇒ 判空跑即失败）与**反证**（坏样本必须报红并点名）。
// ⚠️ 能力边界（如实记账）：
//   · 类名集合只统计 **`TAVERN_CSS` 载体里**的选择器类名（口径明确、可复核）；
//     markup 里 `class="…"` 用到的名字**不在**本判据内（其中大半属于 muv/状态栏等其它子系统）。
//   · 本判据判的是**源码集合**，不是"计算后的样式"：它挡不住"把某个类名的规则内容改坏"
//     （那由 `tests/panel-tabs.test.js` 的页签契约与 `check-client-integrity` 兜各自的半边）。
//   · 本机没有浏览器 ⇒ 任何"渲染等价"都只能靠**逐处等值论证**，不许声称逐像素（见 task-5 材料）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ ③ 归属判据（批3 前置；由 reviewer 建议升格）：
 *   `var(--tv-*)` 的使用点只有在**能证明落在 `#tavern-manager` 子树内**时才算合规 ——
 *   否则 `var()` 解析不到，颜色会退回继承/默认 ⇒ **真·用户可见变化**。
 *   证据形态两种：
 *     · markup：该行在 `panelHTML` 的函数体内（面板根就是 `#tavern-manager`，产物经 `root.innerHTML` 进面板）；
 *     · JS：**逐行向上**取赋值表达式，沿 `X.querySelector('#id')` **递归到锚点**，最终 id 必须出现在
 *       `panelHTML` 的 markup 里（且锚点链的容器最终指向面板）。
 *   ⚠️ 为什么必须升格成判据（而不是留在脚本里）：我批2 的材料就是用「**全局** last-write-wins 的变量→id 表」
 *      得出的，`st` 在文件后段还有别的绑定被后写覆盖 ⇒ 归属**蒙对了**才过；方法会随人漂，判据不会。
 *   ⚠️ 本文件里的括号配平用**自带的小遮罩**（只服务本判据的括号计数）—— 不引另一个 test 文件（那会把它的用例
 *      也注册进本进程）。它与 `tests/slice-anchors.test.js` 的 `maskComments` **同源**（同样的引号/注释/正则规则）：
 *      **改一处必须同步另一处**；若将来出现第三个消费者，抽到 `tests/_helpers/mask.mjs`（非 `.test.js` ⇒ 不被 runner 当测试）。
 *      ★ 它的正则跳过不是装饰：漏了它，`/['"]/` 里的引号会让字符串状态错位 ⇒ 整份文本被当成"字符串里"
 *        ⇒ `function panelHTML(` 再也找不到（判据整体失明，实测踩过）。
 */
function maskForBraces(text) {
  const s = String(text)
  let out = ''
  let i = 0
  let quote = ''
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue }
      if (c === quote) { quote = ''; out += c; i++; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++ } continue }
    if (c === '/' && s[i + 1] === '*') { out += '  '; i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++ } if (i < s.length) { out += '  '; i += 2 } continue }
    // ★ 正则字面量必须整段跳过：`/['"]/` 里的引号会让字符串状态**错位**，
    //   之后整份文本都被当成"字符串里" ⇒ `function panelHTML(` 再也找不到（实测就栽在这里）。
    //   判据：`/` 前面那个非空字符不是「值 / 右括号」⇒ 它是正则起点。
    if (c === '/') {
      let prev = ''
      for (let q = i - 1; q >= 0; q--) { const pc = out[q]; if (pc === ' ' || pc === '\t') continue; prev = pc; break }
      if (!/[A-Za-z0-9_$)\]}]/.test(prev)) {
        let inClass = false
        let k = i + 1
        for (; k < s.length; k++) {
          const rc = s[k]
          if (rc === '\\') { k++; continue }
          if (rc === '\n') break
          if (rc === '[') inClass = true
          else if (rc === ']') inClass = false
          else if (rc === '/' && !inClass) break
        }
        if (k < s.length && s[k] === '/') { for (let t = i; t <= k; t++) out += s[t] === '\n' ? '\n' : ' '; i = k + 1; continue }
      }
    }
    out += c
    i++
  }
  return out
}

/** `panelHTML` 的函数体行范围（0-based，含首尾）；找不到 ⇒ null。 */
export function panelHtmlRange(bundleText) {
  const lines = String(bundleText).split(/\r?\n/)
  const masked = maskForBraces(bundleText).split(/\r?\n/)
  const start = masked.findIndex((l) => /(?:^|\s)function\s+panelHTML\s*\(/.test(l))
  if (start < 0) return null
  let depth = 0
  let started = false
  for (let k = start; k < masked.length; k++) {
    for (const c of masked[k]) {
      if (c === '{') { depth++; started = true } else if (c === '}') { depth--; if (started && depth === 0) return { from: start, to: k } }
    }
  }
  return null
}

/** 从 `lineIdx` **向上**找 `name` 的最近绑定；返回 `{ line, expr }`（1-based 行号）或 null。 */
export function nearestBinding(lines, name, lineIdx) {
  const re = new RegExp('(?:var\\s+|let\\s+|const\\s+)?' + name + '\\s*=\\s*([^;\\n]+)')
  for (let i = Math.min(lineIdx, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(re)
    if (m) return { line: i + 1, expr: m[1].trim() }
  }
  return null
}

/** 解析绑定表达式 → `{ selector, via, anchorSelector }`（沿 `X.querySelector` 递归，最多 4 跳）。 */
export function resolveBindingChain(lines, expr, lineIdx, depth = 0) {
  if (depth > 4) return { selector: null, via: null, anchorSelector: null, why: '递归过深' }
  const doc = String(expr).match(/^\s*(?:document\.)?(?:getElementById\(\s*'([^']+)'\s*\)|querySelector\(\s*'#([^']+)'\s*\))/)
  if (doc) return { selector: '#' + (doc[1] || doc[2]), via: 'document', anchorSelector: 'document' }
  const rel = String(expr).match(/^\s*([A-Za-z_$][\w$]*)\s*\.\s*querySelector\(\s*'#([^']+)'\s*\)/)
  if (rel) {
    const base = nearestBinding(lines, rel[1], lineIdx - 1)
    if (!base) return { selector: '#' + rel[2], via: rel[1], anchorSelector: null, why: '找不到容器变量 ' + rel[1] }
    const up = resolveBindingChain(lines, base.expr, base.line - 1, depth + 1)
    return { selector: '#' + rel[2], via: rel[1] + '@L' + base.line, anchorSelector: up.anchorSelector ?? up.selector }
  }
  return { selector: null, via: null, anchorSelector: null, why: '非选择器表达式：' + String(expr).slice(0, 60) }
}

/**
 * CSS 载体的**行范围**（0-based，含首尾；只取数组内容行）。边界不唯一 ⇒ null（fail-closed）。
 * 与判据 ② 判"定义作用域"用的是同一套边界（`carrierCandidates`）—— 两处口径必须一致。
 */
export function cssCarrierRange(bundleText) {
  const { start, sameIndent } = carrierCandidates(bundleText)
  if (start < 0 || sameIndent.length !== 1) return null
  return { from: start + 1, to: sameIndent[0] - 1 }
}

/**
 * 载体里第 `i` 行**所在规则**的选择器：向上找最近的含 `{` 的行，取 `{` 之前的文本。
 * 找不到 ⇒ null（fail-closed —— 定位不到就不许当成"在作用域内"）。
 */
export function enclosingCarrierSelector(lines, i, range) {
  for (let k = i; k >= range.from; k--) {
    const at = lines[k].indexOf('{')
    if (at < 0) continue
    return lines[k].slice(0, at).replace(/^[\s',]+/, '').trim()
  }
  return null
}

/**
 * 全仓 `var(--tv-*)` 使用点的归属判定。**三种可证明的证据形态**（缺一即红）：
 *   ① `markup` ：该行在 `panelHTML` 函数体内（面板根即 `#tavern-manager`）；
 *   ② `js`     ：该行的 `.style.` 目标，绑定链**逐行向上**解析后落回面板内元素 id；
 *   ③ `carrier`：该行在 **CSS 载体**内，且**所在规则的选择器含 `#tavern-manager`**
 *                （= 判据 ② 判"定义作用域"用的同一条规则）。
 * ★ 形态③ 是**增补**（批3c 落地，与首批真实载体点同笔）：在此之前，载体里的使用点没有绑定链，
 *   会被误判成 `js` 形态并报红 —— 而它的归属其实可证明（**选择器自己写着作用域**）。
 *   既有两种形态**原样保留**（不是替换、更不是放宽）；负反证见 ③-c。
 */
export function tvUsageSites(bundleText) {
  const lines = String(bundleText).split(/\r?\n/)
  const range = panelHtmlRange(bundleText)
  const carrier = cssCarrierRange(bundleText)
  const panelIds = new Set(
    range ? lines.slice(range.from, range.to + 1).join('\n').match(/id="([^"]+)"/g)?.map((m) => m.slice(4, -1)) ?? [] : [],
  )
  const sites = []
  const problems = []
  lines.forEach((l, i) => {
    const names = [...l.matchAll(/var\(\s*(--tv-[\w-]*)/g)].map((m) => m[1])
    if (!names.length) return
    // 令牌**定义行**不算使用点（`--tv-x:#hex` 是定义，不是引用）
    const defineOnly = /--tv-[\w-]+\s*:/.test(l) && !/var\(/.test(l)
    if (defineOnly) return
    const inMarkup = !!(range && i >= range.from && i <= range.to)
    if (inMarkup) {
      for (const name of names) sites.push({ line: i + 1, name, kind: 'markup', id: (l.match(/id="([^"]+)"/) || [])[1] || null, anchor: 'panelHTML', ok: true, why: '在 panelHTML 体内' })
      return
    }
    // ③ 载体内的使用点：靠**所在规则的选择器**证明作用域（不等同于"在 panelHTML 里"）
    if (carrier && i >= carrier.from && i <= carrier.to) {
      const sel = enclosingCarrierSelector(lines, i, carrier)
      const ok = !!(sel && sel.includes('#tavern-manager'))
      for (const name of names) {
        sites.push({
          line: i + 1, name, kind: 'carrier', id: null, anchor: sel, ok,
          why: ok ? '所在规则选择器含 #tavern-manager（' + sel + '）' : '所在规则选择器**不含** #tavern-manager（' + (sel || '定位不到选择器') + '）',
        })
      }
      return
    }
    const m = l.match(/([A-Za-z_$][\w$]*)\.style\./)
    const chain = m ? (() => {
      // ★ 从**本行**开始向上找绑定（含本行）：`var x = document.getElementById('y'); x.style.color = …` 是常见写法，
      //   从 i-1 起找会把这种"同一行先绑定后使用"判成"无绑定" ⇒ 假红（实测：我自己的正对照夹具就这么红的）。
      const b = nearestBinding(lines, m[1], i)
      return b ? resolveBindingChain(lines, b.expr, b.line - 1) : null
    })() : null
    const id = chain && chain.selector ? chain.selector.slice(1) : null
    const ok = !!(id && panelIds.has(id))
    for (const name of names) {
      sites.push({ line: i + 1, name, kind: 'js', id, anchor: chain ? chain.anchorSelector : null, ok, why: ok ? '绑定链回到面板内元素' : '无法证明在面板子树内' + (chain && chain.why ? '（' + chain.why + '）' : '') })
    }
  })
  if (!range) problems.push('找不到 panelHTML 的函数体 —— 判据空跑（面板 markup 边界没了）')
  if (!panelIds.size) problems.push('panelHTML 里一个 id 都没解析到 —— 判据空跑')
  if (!carrier) problems.push('取不到 CSS 载体的行范围 —— 形态③ 无法判定（fail-closed）')
  for (const s of sites) if (!s.ok) problems.push('L' + s.line + ' 的 ' + s.name + '（' + s.kind + '）' + s.why)
  return { sites, panelRange: range, panelIds, carrierRange: carrier, problems }
}

/** ③ 的非空跑下限（**随批次抬**；契约是"下限"本身，数字只是时点快照）。
 *  17（时点 be756f7：只有颜色令牌引用）→ 54（批3b：+37 处 gap 引用）→ **61**（批3c：+7 处载体内 gap 引用）。 */
export const USAGE_FLOOR = 61

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_FILE = path.join(REPO, 'lib', 'client.manager.bundle.js')
// ⚠️ 文件名刻意**不含** `token` 字样：本仓 `.gitignore` 有一条凭据守卫 `*token*`（2.7.14 加的），
//    任何路径里带 token 的文件都会被挡在库外 —— 实测这一笔最初就叫 `css-token-ratchet.test.js`，
//    `git add` 当场被拒。**不要**用 `git add -f` 绕过（那等于把凭据守卫踩过去）；改名字才是正解。
const BASELINE_FILE = path.join(REPO, 'tools', 'css-var-baseline.json')

/**
 * 载体的结束标记：`].join('');` 单行（数组里含 `]`（如 `input[type=checkbox]`）⇒ 不能数方括号）。
 * ★★ 这个标记在仓库里**不是唯一的**（实测：另有面板 markup 那个数组也以 `].join('');` 收尾，
 *    只是缩进不同）⇒ 边界必须用「**与起始行同缩进**」来消歧，并且**要求恰好一条** ——
 *    否则"把真结束标记改一个字符"（例如 `].join("")`）会让判据**静默绑到后面那个数组**，
 *    于是一边看着大 6 倍、语义完全不同的文本，一边全绿（这是 reviewer 在 `7117a40` 上抓到的最小复现）。
 */
const CARRIER_END = "].join('');"

/** 载体起始行之后的**全部**结束标记候选（按缩进分组），供"边界必须唯一"的判据点名。 */
export function carrierCandidates(bundleText) {
  const lines = String(bundleText).split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*var\s+TAVERN_CSS\s*=\s*\[\s*$/.test(l))
  if (start < 0) return { start: -1, indent: null, ends: [], sameIndent: [] }
  const indent = (lines[start].match(/^\s*/) || [''])[0]
  const ends = []
  for (let i = start + 1; i < lines.length; i++) if (lines[i].trim() === CARRIER_END) ends.push(i)
  const sameIndent = ends.filter((i) => (lines[i].match(/^\s*/) || [''])[0] === indent)
  return { start, indent, ends, sameIndent }
}

/**
 * 取出 `var TAVERN_CSS = [ … ].join('')` 的**数组内容**（不含标记本身）。
 * **fail-closed**：起点找不到 / 同缩进候选不是**恰好 1 条** ⇒ 返回 null（调用方据此报红，绝不静默换面）。
 */
export function extractCssCarrier(bundleText) {
  const { start, sameIndent } = carrierCandidates(bundleText)
  if (start < 0 || sameIndent.length !== 1) return null
  return String(bundleText).split(/\r?\n/).slice(start + 1, sameIndent[0]).join('\n')
}

/** 按 `}` 切 CSS 规则 → `[{ selector, body, index }]`（`selector` 已 trim）。
 *  ★ 判据会对规则条数设下限 —— 解析失败不许静默变成"空面全绿"。 */
export function parseCssRules(cssText) {
  const out = []
  const text = String(cssText)
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '}') continue
    const chunk = text.slice(from, i)
    const at = chunk.indexOf('{')
    if (at >= 0) out.push({ selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1), index: from + at })
    from = i + 1
  }
  return out
}

/** CSS 文本里的选择器类名（`.name`）集合。 */
export function extractCssClassNames(cssText) {
  const out = new Set()
  for (const m of String(cssText).matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(m[1])
  return out
}

/** `--tv-*` 的定义：返回 `[{ name, selector, topLevel }]`；`topLevel` = 所在规则的选择器里**没有** `#tavern-manager`。 */
export function extractTokenDefs(cssText) {
  const rules = parseCssRules(cssText)
  const out = []
  for (const r of rules) {
    for (const m of r.body.matchAll(/(--tv-[\w-]*)\s*:/g)) {
      out.push({ name: m[1], selector: r.selector, topLevel: !r.selector.includes('#tavern-manager') })
    }
  }
  return out
}

/** `var(--tv-*)` 的引用名集合（含 `var(--tv-x, …)`）。 */
export function extractTokenRefs(cssText) {
  const out = new Set()
  for (const m of String(cssText).matchAll(/var\(\s*(--tv-[\w-]*)/g)) out.add(m[1])
  return out
}

/**
 * ★ 批2 起新增的**引用面**：`var(--tv-*)` 的引用不只出现在 CSS 载体里 ——
 * 逐处替换之后，它们大量出现在 **panelHTML 的 markup**（`style="color:var(--tv-color-danger)"`）
 * 与 **JS 赋值**（`st.style.color = 'var(--tv-color-warn)'`）里。
 * 只扫载体的话，这些引用**完全不在判据视野内**：一个拼错的令牌名（`--tv-color-dangerr`）
 * 会让 `var()` 解析失败 ⇒ 颜色退回继承/默认 ⇒ 真·用户可见变化，而判据全绿。
 * 所以引用的"必须有定义"这一条，扫描面 = **整个 bundle**（定义面仍限 `TAVERN_CSS` 载体）。
 */
export function extractTokenRefsAnywhere(bundleText) {
  const out = new Map()                       // name → 出现次数
  for (const m of String(bundleText).matchAll(/var\(\s*(--tv-[\w-]*)/g)) out.set(m[1], (out.get(m[1]) || 0) + 1)
  return out
}

/** ① 的子集判据：`baseline.classes` 里哪些**没在**现状里（= 被删的，且没登记删除声明）。 */
export function missingClassNames(baseline, current, removals = []) {
  const declared = new Set(removals.map((r) => r && r.name))
  return baseline.filter((n) => !current.has(n) && !declared.has(n))
}

/** ① 的删除声明自查：每条要有非空理由、且不许陈旧（该类名仍存在 = 声明已过期）。 */
export function removalProblems(removals, current) {
  const out = []
  for (const r of removals || []) {
    const tag = r && r.name ? r.name : JSON.stringify(r)
    if (!r || !r.name) { out.push('删除声明缺 name：' + JSON.stringify(r)); continue }
    if (!r.why || !String(r.why).trim()) out.push('删除声明缺理由：' + tag)
    if (current.has(r.name)) out.push('删除声明已陈旧（该类名仍在 CSS 里）：' + tag)
  }
  return out
}

/** ② 的判据：令牌定义的越界项 / 无定义的引用 / 登记表不一致。 */
export function tokenProblems(defs, refs, registry = []) {
  const out = []
  for (const d of defs) {
    if (d.topLevel) out.push('★ `' + d.name + '` 定义在**非 `#tavern-manager` 作用域**里（选择器：' + (d.selector || '（空）') + '）—— 令牌必须限定在面板内')
  }
  const defined = new Set(defs.map((d) => d.name))
  for (const r of refs) if (!defined.has(r)) out.push('★ `' + r + '` 被 `var(...)` 引用，却没有任何定义')
  for (const d of defs) if (!registry.includes(d.name)) out.push('★ `' + d.name + '` 定义了但没登记进基线 `tokens`（新令牌必须登记，否则判据漂移）')
  for (const n of registry) if (!defined.has(n)) out.push('★ 基线 `tokens` 里登记了 `' + n + '`，但 CSS 里找不到定义')
  return out
}

/** 非空跑下限（口径：实测值见 `_scratch/s3/measure-s3b.mjs`；下限取实测的 ~80%）。
 *  ⚠️ 注释里的实测值是**时点快照**（会随批次变），别把它当契约；契约是"下限"本身。 */
export const CLASS_FLOOR = 24          // 实测 30（时点 7117a40）
export const RULE_FLOOR = 30           // 实测 52（时点：本批加入令牌规则之后）
export const TOKEN_FLOOR = 7           // 实测 9（批3c；reviewer 建议按"~80%"惯例从 4 抬到 7）——下限只增

const BUNDLE = fs.readFileSync(BUNDLE_FILE, 'utf8')
const CAND = carrierCandidates(BUNDLE)
const CARRIER = extractCssCarrier(BUNDLE)
// ★ 基线**允许不存在**（首次生成基线时要用本文件的纯函数；缺基线会由 ① 的下限断言报红 —— 不许静默空跑）。
const BASELINE = fs.existsSync(BASELINE_FILE)
  ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  : { note: '（缺基线）', classes: [], classRemovals: [], tokens: [] }
const RULES = CARRIER ? parseCssRules(CARRIER) : []
const CLASSES = CARRIER ? extractCssClassNames(CARRIER) : new Set()
const DEFS = CARRIER ? extractTokenDefs(CARRIER) : []
const REFS = CARRIER ? extractTokenRefs(CARRIER) : new Set()
/** 全仓引用面（批2 起：引用大量落在 markup / JS 里，只扫载体等于看不见它们） */
const REFS_ALL = extractTokenRefsAnywhere(BUNDLE)
export const REF_FLOOR = 61                // 实测 61（批3c；从 17 抬上来 —— reviewer 指出"逐批只增"该体现在这里）

test('①-0 载体边界必须**唯一**（fail-closed：不许静默绑到后面那个结束标记上）', (t) => {
  t.diagnostic('起始行 L' + (CAND.start + 1) + '（缩进 ' + JSON.stringify(CAND.indent) + '）· 结束标记候选 ' +
    JSON.stringify(CAND.ends.map((i) => i + 1)) + ' · 其中同缩进 ' + JSON.stringify(CAND.sameIndent.map((i) => i + 1)))
  assert.ok(CAND.start >= 0, '找不到 `var TAVERN_CSS = [ … ]` 起始行 —— 判据空跑（载体改名了？）')
  assert.equal(
    CAND.sameIndent.length, 1,
    '★ 结束标记 ' + JSON.stringify(CARRIER_END) + ' 在起始行之后有 ' + CAND.sameIndent.length + ' 处与起始行同缩进（L' +
    CAND.sameIndent.map((i) => i + 1).join(', L') + '）—— 边界不可靠（fail-closed，不许静默换面）',
  )
  assert.ok(CARRIER, '载体取不出来 —— 判据空跑')
})

test('① CSS 类名只加不删：基线集合必须仍是现状的子集（点名到类名）', (t) => {
  assert.ok(CARRIER, '找不到 `var TAVERN_CSS = [ … ].join(\'\')` 载体 —— 判据空跑（载体改名了？）')
  t.diagnostic('载体 ' + CARRIER.length + ' 字符 · CSS 规则 ' + RULES.length + ' 条 · 类名 ' + CLASSES.size + ' 个 · 基线 ' + BASELINE.classes.length + ' 个')
  // 载体必须真的是"面板样式"（不是别的数组）：结构性 sanity（防"绑错面还全绿"）
  assert.ok(CARRIER.includes('#tavern-manager'), '★ 载体里没有 `#tavern-manager` —— 取到的不是面板样式（绑错面了）')
  // 非空跑：解析面必须真的非空（否则"子集"会恒真）
  assert.ok(RULES.length >= RULE_FLOOR, '只解析出 ' + RULES.length + ' 条 CSS 规则（下限 ' + RULE_FLOOR + '）—— 判据空跑')
  assert.ok(CLASSES.size >= CLASS_FLOOR, '只解析出 ' + CLASSES.size + ' 个类名（下限 ' + CLASS_FLOOR + '）—— 判据空跑')
  assert.ok(BASELINE.classes.length >= CLASS_FLOOR, '基线只登记了 ' + BASELINE.classes.length + ' 个类名（下限 ' + CLASS_FLOOR + '）')
  const missing = missingClassNames(BASELINE.classes, CLASSES, BASELINE.classRemovals)
  assert.deepEqual(missing, [], '★ 这些 CSS 类名被删掉了（"只加不删"是 S3 的硬约束）：\n  ' + missing.join('\n  ') +
    '\n（确有必要删的，请在 tools/css-var-baseline.json 的 classRemovals 里登记【类名 + 理由】）')
  assert.deepEqual(removalProblems(BASELINE.classRemovals, CLASSES), [], '★ 删除声明自身有问题（缺理由 / 已陈旧）')
})

test('①-c 反证（reviewer 的最小复现）：真结束标记改一个字符 ⇒ **必须红**，不许绑到后面那个数组', () => {
  // 复现：把 TAVERN_CSS 自己的 `].join('');` 改成 `].join("");`（很常见的引号/格式化改动）——**只在内存里改**
  const mutated = BUNDLE.replace('    ' + CARRIER_END, '    ].join("");')
  assert.notEqual(mutated, BUNDLE, '替换必须真的发生（否则这条反证是空跑）')
  const c = carrierCandidates(mutated)
  assert.equal(c.sameIndent.length, 0, '改掉真边界后，同缩进候选应为 0，实际=' + JSON.stringify(c.sameIndent))
  assert.equal(extractCssCarrier(mutated), null, '★ 边界不可靠时必须**取不出载体**（调用方据此报红）；' +
    '若这里返回了文本，就是"静默绑到下一个 `].join(\'\')`"那个洞')
  // 对照（旧口径的洞）：旧谓词是 `trim().startsWith("].join('')")`（**连引号一起**）——
  // 真边界被改成 `].join("")` 之后它就落空，于是一路绑到**后面那个数组**的结束标记上（语义完全不同的一段）。
  const lines = mutated.split(/\r?\n/)
  const OLD_PREDICATE = (l) => l.trim().startsWith(CARRIER_END)     // = 7117a40 的实现
  const oldStyleEnd = lines.findIndex((l, i) => i > c.start && OLD_PREDICATE(l))
  assert.equal(oldStyleEnd, CAND.ends[1],
    '旧口径落空后会绑到"后面那个数组"（实测 L' + (CAND.ends[1] + 1) + '）——说明这条反证不是重复劳动')
  assert.ok(!CARRIER.includes('tavern-save'), '对照：错误那段里含面板 markup（真载体里没有）')
})

test('①-d 正对照 / 唯一性反证：别处有第二处标记但**缩进不同** ⇒ 照常绿；同缩进多一处 ⇒ 必须红', () => {
  // 正对照：真实文件里就存在第二处 `].join('');`（面板 markup 那个数组，缩进不同）—— 现状必须取到正确载体
  assert.ok(CAND.ends.length >= 2, '期望真实文件里存在第二处标记（否则这条对照是空的），实际=' + JSON.stringify(CAND.ends))
  assert.ok(CARRIER.includes("'#tavern-manager .t-card{"), '对照：取到的必须是真 CSS 载体')
  assert.ok(!CARRIER.includes('tavern-save'), '对照：载体里不该含面板 markup（那是另一个数组）')
  // 唯一性反证：再插一条**同缩进**的标记 ⇒ 必须判为"边界不可靠"
  const extra = BUNDLE.replace('    ' + CARRIER_END, '    ' + CARRIER_END + '\n    ].join(\'\');')
  assert.equal(carrierCandidates(extra).sameIndent.length, 2, '同缩进多一处 ⇒ 候选应为 2')
  assert.equal(extractCssCarrier(extra), null, '★ 同缩进候选不唯一 ⇒ 必须取不出载体（fail-closed）')
})

test('①-b 反证：删一个既有类名必须报红并点名；**新增**类名不许报红（这才是"只加不删"的语义）', () => {
  const cur = new Set(['t-card', 't-row'])
  const base = ['t-card', 't-row', 't-item']
  assert.deepEqual(missingClassNames(base, cur, []), ['t-item'], '对照：删掉的类名必须被点名')
  assert.deepEqual(missingClassNames(base, new Set([...cur, 't-brand-new']), []), ['t-item'], '对照：新增类名不改变"缺哪些"')
  assert.deepEqual(missingClassNames(base, new Set(['t-card', 't-row', 't-item', 't-brand-new']), []), [], '对照：只加不删 ⇒ 不报红')
  // 声明过就放行，且声明要带理由
  assert.deepEqual(missingClassNames(base, cur, [{ name: 't-item', why: '合并进 t-item-row 了' }]), [], '登记过的删除应放行')
  assert.equal(removalProblems([{ name: 't-item' }], cur).length, 1, '缺理由必须报')
  assert.equal(removalProblems([{ name: 't-card', why: 'x' }], cur).length, 1, '声明陈旧（类名还在）必须报')
})

test('② `--tv-*` 令牌必须限定在 `#tavern-manager` 作用域内（含 `:root` 反例）', (t) => {
  assert.ok(CARRIER, '找不到 CSS 载体 —— 判据空跑')
  t.diagnostic('令牌定义 ' + DEFS.length + ' 条 · 载体内的引用 ' + REFS.size + ' 个 · **全仓引用** ' +
    [...REFS_ALL.values()].reduce((a, b) => a + b, 0) + ' 处 / ' + REFS_ALL.size + ' 个名字 · 登记表 ' + BASELINE.tokens.length + ' 条')
  assert.ok(DEFS.length >= TOKEN_FLOOR, '令牌只解析出 ' + DEFS.length + ' 条（下限 ' + TOKEN_FLOOR + '）')
  // ★ 引用面 = **整个 bundle**（批2 起引用落在 markup / JS 里；只扫载体等于看不见它们 —— 见 extractTokenRefsAnywhere 注释）
  const bad = tokenProblems(DEFS, new Set(REFS_ALL.keys()), BASELINE.tokens)
  assert.deepEqual(bad, [], '★ `--tv-*` 令牌层不合规：\n  ' + bad.join('\n  '))
})

test('②-c 反证（批2 新增能力）：**markup / JS 里**的未定义引用必须报红（只扫载体时是瞎的）', () => {
  const refs = extractTokenRefsAnywhere("var a = 'style=\"color:var(--tv-color-danger)\"'\nst.style.color = 'var(--tv-color-dangerr)'")
  assert.deepEqual([...refs.keys()].sort(), ['--tv-color-danger', '--tv-color-dangerr'], '全仓引用必须两个都取到（含 markup 里那个）')
  const bad = tokenProblems([{ name: '--tv-color-danger', selector: '#tavern-manager', topLevel: false }], new Set(refs.keys()), ['--tv-color-danger'])
  assert.equal(bad.length, 1, '拼错的引用必须报一条，实际=' + JSON.stringify(bad))
  assert.match(bad[0], /--tv-color-dangerr/)
  // 对照：**载体内的**扫描面看不见 markup 里那处（这正是"扫描面必须扩"的理由）
  const carrierOnly = extractTokenRefs("'#tavern-manager{--tv-color-danger:#e74c3c}'")
  assert.deepEqual([...carrierOnly], [], '对照：载体里没有引用 ⇒ 载体口径下引用数为 0（看不见 markup）')
  // 引用下限（非空跑）：真实 bundle 的全仓引用数必须 ≥ 下限
  const total = [...REFS_ALL.values()].reduce((a, b) => a + b, 0)
  assert.ok(total >= REF_FLOOR, '全仓引用只数到 ' + total + ' 处（下限 ' + REF_FLOOR + '）—— 判据空跑或替换被回退')
})

// ════════════════════════════════════════════════════════════════
// ③ 归属判据：每个 `var(--tv-*)` 使用点都必须**能证明**在 `#tavern-manager` 子树内
//   （reviewer 建议把批2 脚本里的方法升格成常驻判据 —— 方法会随人漂，判据不会）
// ════════════════════════════════════════════════════════════════
const USAGE = tvUsageSites(BUNDLE)

test('③ 每个 `var(--tv-*)` 使用点都必须能证明在 `#tavern-manager` 子树内（点名到行）', (t) => {
  const byKind = {}
  for (const s of USAGE.sites) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1
  t.diagnostic('使用点 ' + USAGE.sites.length + ' 处 ' + JSON.stringify(byKind) + ' · panelHTML L' +
    (USAGE.panelRange ? (USAGE.panelRange.from + 1) + '–' + (USAGE.panelRange.to + 1) : '（找不到）') +
    ' · 其中的 markup id ' + USAGE.panelIds.size + ' 个')
  assert.deepEqual(USAGE.problems, [], '★ 这些 `var(--tv-*)` 使用点无法证明落在面板子树内（var() 解析不到 ⇒ 颜色会退回继承/默认）：\n  ' + USAGE.problems.join('\n  '))
  assert.ok(USAGE.sites.length >= USAGE_FLOOR, '使用点只数到 ' + USAGE.sites.length + ' 处（下限 ' + USAGE_FLOOR + '）—— 判据空跑或替换被回退')
  assert.ok((byKind.js ?? 0) >= 1 && (byKind.markup ?? 0) >= 1, '两类证据形态都必须非空（否则判据只覆盖了一半）：' + JSON.stringify(byKind))
})

test('③-b 反证：把一处 JS 绑定改到**面板外**的元素 ⇒ 必须红；原样 ⇒ 绿（正对照）', () => {
  // 正对照：现仓库必须通过
  assert.deepEqual(tvUsageSites(BUNDLE).problems, [], '现状不该报红')
  // 反证：把 `st = container.querySelector('#tavern-status')` 改绑到一个**确实不在面板里**的 id
  //        （`#dsh-tavern-float-hint` 是本仓真实存在的面板外元素，见 L6911 那一族）
  //  ⚠️ 必须替换**全部**出现（首次 `String.replace` 只换第一处 ⇒ 被替换的可能不是被判据解析的那几处绑定，
  //     于是反证变成空跑 —— 实测踩过；注入口必须与判据的解析口径对齐）
  const FROM = "container.querySelector('#tavern-status')"
  const n = BUNDLE.split(FROM).length - 1
  assert.ok(n >= 1, '夹具前提：bundle 里应存在该绑定，实际 ' + n + ' 处')
  const mutated = BUNDLE.split(FROM).join("document.querySelector('#dsh-tavern-float-hint')")
  assert.notEqual(mutated, BUNDLE, '替换必须真的发生（否则这条反证是空跑）')
  const bad = tvUsageSites(mutated)
  assert.ok(bad.problems.length >= 1, '绑到面板外必须报红，实际=' + JSON.stringify(bad.problems))
  assert.match(bad.problems.join('\n'), /无法证明在面板子树内/, '报红必须点名原因')
  // 反证②：把 markup 里的使用点搬到 panelHTML **之外**（合成小样本）⇒ 同样必须红
  const synthetic = [
    'function panelHTML() {',
    '  return \'<div id="t-x" style="color:var(--tv-color-danger)"></div>\'',
    '}',
    'var outside = \'<div style="color:var(--tv-color-danger)"></div>\'',   // 面板外
  ].join('\n')
  const s3 = tvUsageSites(synthetic)
  // ⚠️ 合成样本里没有 CSS 载体 ⇒ 会**另有一条**"取不到载体"的问题（fail-closed 的正当行为）；
  //    所以这里断言"含 L4 的归属问题"，而不是"恰好一条"（把 fail-closed 的额外红当成噪声会写歪判据）。
  assert.ok(s3.problems.some((p) => /L4/.test(p) && /无法证明在面板子树内/.test(p)),
    '面板外的使用点必须点名到 L4 且给出归属原因，实际=' + JSON.stringify(s3.problems))
  // ★ 反证③（reviewer 的 I2 形态，最容易被下限蒙过去的一种）：**新增**一个"面板外的 JS 使用点"，
  //   且总数仍然 ≥ 下限 ⇒ 必须红，而且红的原因**不能**是下限 ⇒ 证明是**逐点判定**在起作用。
  const added = BUNDLE + "\nvar probeOut = document.getElementById('dsh-tavern-float-hint'); probeOut.style.color = 'var(--tv-color-danger)';\n"
  const s4 = tvUsageSites(added)
  assert.ok(s4.sites.length > USAGE_FLOOR, '夹具前提：新增后使用点数（' + s4.sites.length + '）必须仍 ≥ 下限（' + USAGE_FLOOR + '），否则这条反证会被下限接住')
  assert.equal(s4.problems.length, 1, '面板外的新增使用点必须报一条，实际=' + JSON.stringify(s4.problems))
  assert.match(s4.problems[0], /无法证明在面板子树内/, '红必须来自逐点归属判定（不是下限）')
  assert.match(s4.problems[0], /--tv-color-danger/, '必须点名令牌')
  // 对照：**同样的新增行**若绑到面板**内**的元素 ⇒ 不该红（证明上一条不是"见到新增就红"）
  const addedIn = BUNDLE + "\nvar probeIn = document.getElementById('tavern-status'); probeIn.style.color = 'var(--tv-color-danger)';\n"
  assert.deepEqual(tvUsageSites(addedIn).problems, [], '绑到面板内元素的新增点不该红')
})

test('③-c 反证（形态③ 载体+作用域）：scoped 载体点 ⇒ 绿；选择器改成裸 `.t-card` ⇒ 必须红；定位不到选择器 ⇒ 必须红', (t) => {
  const real = USAGE.sites.filter((s) => s.kind === 'carrier').length
  t.diagnostic('形态③（载体内使用点）**真实流量**：' + real + ' 处（本笔 ≠ 0 —— 判据与首批真实点同笔落地）')
  const END = "].join('');"
  const FIX = (sel) => [
    '    var TAVERN_CSS = [',
    "      '" + sel + " .t-card{padding:var(--tv-space-2);border-radius:var(--tv-radius-md)}',",
    '    ' + END,
    'function panelHTML() {',
    '  return \'<div id="t-x"></div>\'',
    '}',
  ].join('\n')
  const okFix = tvUsageSites(FIX('#tavern-manager'))
  assert.deepEqual(okFix.problems, [], 'scoped 载体点不该红，实际=' + JSON.stringify(okFix.problems))
  assert.equal(okFix.sites.filter((s) => s.kind === 'carrier').length, 2, '两个令牌都该被算成 carrier 形态，实际=' + JSON.stringify(okFix.sites))
  assert.equal(okFix.sites[0].anchor, '#tavern-manager .t-card', '必须把所在规则的选择器解析出来（供材料逐点对照）')
  // 负反证①：同一条规则去掉作用域 ⇒ 必须红（这正是形态③ 要挡的：样式会泄漏到面板外）
  const bareFix = tvUsageSites(FIX(''))
  assert.equal(bareFix.problems.length, 2, '裸选择器下的两个载体点都该报，实际=' + JSON.stringify(bareFix.problems))
  assert.match(bareFix.problems[0], /所在规则选择器\*\*不含\*\* #tavern-manager/)
  // 负反证②：载体里**定位不到**选择器（少了 `{`）⇒ 同样必须红（fail-closed，不许默认放行）
  const noSel = tvUsageSites([
    '    var TAVERN_CSS = [',
    "      'padding:var(--tv-space-2)',",
    '    ' + END,
    'function panelHTML() {',
    '  return \'<div id="t-x"></div>\'',
    '}',
  ].join('\n'))
  assert.equal(noSel.problems.length, 1, '定位不到选择器必须报一条，实际=' + JSON.stringify(noSel.problems))
  assert.match(noSel.problems[0], /定位不到选择器/)
})

test('②-b 反证：把定义挪到 `:root` ⇒ 报红；作用域内 ⇒ 放行；引用未定义 ⇒ 报红；登记表漂移 ⇒ 报红', () => {
  const scoped = extractTokenDefs('#tavern-manager{--tv-danger:#e74c3c}')
  assert.deepEqual(tokenProblems(scoped, new Set(), ['--tv-danger']), [], '作用域内 + 已登记 ⇒ 不该报红')
  const root = extractTokenDefs(':root{--tv-danger:#e74c3c}')
  const r1 = tokenProblems(root, new Set(), ['--tv-danger'])
  assert.equal(r1.length, 1, '挪到 :root 必须报一条，实际=' + JSON.stringify(r1))
  assert.match(r1[0], /--tv-danger/)
  assert.match(r1[0], /非 `#tavern-manager` 作用域/)
  // 引用未定义
  const r2 = tokenProblems([], new Set(['--tv-ghost']), [])
  assert.equal(r2.length, 1, '引用未定义必须报，实际=' + JSON.stringify(r2))
  assert.match(r2[0], /--tv-ghost/)
  // 登记表漂移（两个方向）
  assert.match(tokenProblems(scoped, new Set(), [])[0] || '', /没登记进基线/)
  assert.match(tokenProblems([], new Set(), ['--tv-gone'])[0] || '', /找不到定义/)
  // 解析真的取到了选择器（不是靠"没有规则"蒙的）
  assert.equal(scoped[0].selector, '#tavern-manager', '对照：选择器必须解析出来')
  assert.equal(scoped[0].topLevel, false)
  assert.equal(root[0].topLevel, true)
})
