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
export const RULE_FLOOR = 30           // 实测 51（时点 7117a40；加令牌规则后 +1）
export const TOKEN_FLOOR = 0           // 令牌层本卡是"从 0 开始"建 ⇒ 下限随第一批令牌落地而抬（下一笔）

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
  t.diagnostic('令牌定义 ' + DEFS.length + ' 条 · 引用 ' + REFS.size + ' 个 · 登记表 ' + BASELINE.tokens.length + ' 条（本卡从 0 开始建层）')
  assert.ok(DEFS.length >= TOKEN_FLOOR, '令牌只解析出 ' + DEFS.length + ' 条（下限 ' + TOKEN_FLOOR + '）')
  const bad = tokenProblems(DEFS, REFS, BASELINE.tokens)
  assert.deepEqual(bad, [], '★ `--tv-*` 令牌层不合规：\n  ' + bad.join('\n  '))
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
