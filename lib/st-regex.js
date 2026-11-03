// ST 式正则脚本引擎（display / prompt 两个方向共用一份实现）
//
// 为什么需要它：市面上的角色卡（chara_card_v3）几乎都把「状态栏 / 变量更新折叠 /
// 选项卡片 / 思维链折叠」写进 `data.extensions.regex_scripts`，靠 ST 的正则引擎在
// 显示前把标签替换成 HTML。酒馆以前**只保留 name/desc/first_mes**，这些脚本在导入
// 那一刻就丢了 ⇒ 每张卡都要在本插件里硬编码一份解析器，永远追不上新卡。
//
// 本模块只做**纯函数**：解析 + 编译 + 对一段文本套用。不读盘、不碰 DOM。
//   · 服务端用它做「提示词侧」过滤（隐藏状态栏占位符 / 旧变量更新）
//   · 客户端有一份等价实现（bundle 内 `compileCardScripts`），负责「显示侧」替换
// 两份实现口径由 tests/st-regex.test.js 与 tests/card-regex-client.test.js 钉住。
//
// ⚠️ 语义以 SillyTavern 的 public/scripts/extensions/regex/engine.js 为准：
//   disabled / placement / markdownOnly / promptOnly / minDepth / maxDepth /
//   trimStrings / `$1..$9` 反向引用 / `{{match}}`。
//   唯一有意偏离：**缺省补 `g`**（ST 不补）。酒馆要把一屏里多个同类块都换掉，
//   只换第一个会留下裸标签；而这些脚本的匹配目标（占位符 / 变量块）重复出现是常态。

/** ST 的 placement 取值（脚本作用在哪一侧）。 */
const PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH: 3,
  WORLD_INFO: 5,
  REASONING: 6,
}

/** 单条脚本 replace 文本上限（一张卡塞 28KB 状态栏是常态，这里放到 64KB）。 */
const SCRIPT_TEXT_MAX = 65536

/** 一次最多编译多少条（卡里最多见过 11 条；再多就不是正常卡）。 */
const SCRIPT_MAX = 40

/** 合法正则 flags：ST 用的是 gimsuy 的子集，y/d 对一次性替换没有意义。 */
const FLAG_OK = /^[gimsuy]*$/

/**
 * 解析 ST 的 `findRegex`。
 *
 * ST 允许两种写法：
 *   `/pattern/flags`  —— 正则字面量；
 *   `纯文本`           —— **整串当正则源码**（所以 `<StatusPlaceHolderImpl/>` 也能用）。
 * 这里按「最后一个未转义、且不在 `[]` 里的 `/`」切，`[/\\]/` 这类写法不会切错。
 *
 * @param {string} raw
 * @returns {{source:string, flags:string}|null}
 */
function parseRegexLiteral(raw) {
  const s = String(raw == null ? '' : raw)
  if (!s) return null
  if (!s.startsWith('/')) {
    // 纯文本形态：整串就是源码，补 g（见文件头「有意偏离」）
    return { source: s, flags: 'g' }
  }
  let end = -1
  let inClass = false
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '[') { inClass = true; continue }
    if (c === ']') { inClass = false; continue }
    if (c === '/' && !inClass) end = i
  }
  if (end < 1) {
    // `/foo` 没有收尾斜杠：按纯文本处理，比直接丢弃更接近作者本意
    return { source: s, flags: 'g' }
  }
  const source = s.slice(1, end)
  if (!source) return null
  let flags = s.slice(end + 1)
  if (!FLAG_OK.test(flags)) flags = ''
  if (!flags.includes('g')) flags += 'g'
  return { source, flags }
}

/** placement 归一化成数字数组。 */
function normalizePlacement(v) {
  if (v == null || v === '') return [PLACEMENT.AI_OUTPUT]
  if (Array.isArray(v)) {
    const out = v
      .map((x) => (x == null || x === '' ? NaN : Number(x)))
      .filter((n) => Number.isFinite(n))
    return out.length ? out : [PLACEMENT.AI_OUTPUT]
  }
  const n = Number(v)
  return Number.isFinite(n) ? [n] : [PLACEMENT.AI_OUTPUT]
}

/**
 * 编译一张卡（或一份预设）的正则脚本。
 *
 * 非法/写坏的**逐条丢弃**：一张卡里一条正则写错，不该让整条消息渲染不出来。
 *
 * @param {Array<any>} list ST 的 regex_scripts 数组
 * @returns {Array<object>}
 */
function compileCardScripts(list) {
  const arr = Array.isArray(list) ? list : []
  const out = []
  for (const s of arr) {
    if (out.length >= SCRIPT_MAX) break
    if (!s || typeof s !== 'object') continue
    if (s.disabled === true) continue
    const parsed = parseRegexLiteral(s.findRegex != null ? s.findRegex : s.find)
    if (!parsed) continue
    const replace = String(s.replaceString != null ? s.replaceString : (s.replace != null ? s.replace : ''))
    if (replace.length > SCRIPT_TEXT_MAX) continue
    let re
    try { re = new RegExp(parsed.source, parsed.flags) } catch { continue }
    out.push({
      id: String(s.id || ('st-' + out.length)),
      name: String(s.scriptName || s.name || 'ST 脚本').slice(0, 80),
      re,
      replace,
      placement: normalizePlacement(s.placement),
      trim: Array.isArray(s.trimStrings) ? s.trimStrings.map(String).filter(Boolean).slice(0, 20) : [],
      minDepth: typeof s.minDepth === 'number' ? s.minDepth : -1,
      maxDepth: typeof s.maxDepth === 'number' ? s.maxDepth : -1,
      markdownOnly: s.markdownOnly === true,
      promptOnly: s.promptOnly === true,
    })
  }
  return out
}

/**
 * 一条脚本该不该在当前上下文跑。
 *
 * 与 ST 的判定一一对应：
 *   markdownOnly ⇒ 只在显示侧；promptOnly ⇒ 只在提示词侧；两个都 true ⇒ **两边都不跑**
 *   （这不是笔误：ST 的两条 continue 叠加就是这个结果，实测某张卡的 ERA 隐藏
 *    正则正是这种形态，作者本意应该是 promptOnly，但按 ST 行为它就是失效的 ——
 *    这里跟 ST 保持一致，避免"在酒馆里显示正常、在 ST 里不对"）。
 *
 * @param {object} s 编译后的脚本
 * @param {{mode:'display'|'prompt', placement:number, depth?:number}} ctx
 */
function shouldRun(s, ctx) {
  const mode = ctx && ctx.mode === 'prompt' ? 'prompt' : 'display'
  if (s.markdownOnly && mode !== 'display') return false
  if (s.promptOnly && mode !== 'prompt') return false
  const placement = Number(ctx && ctx.placement ? ctx.placement : PLACEMENT.AI_OUTPUT)
  if (s.placement.indexOf(placement) < 0) return false
  if (typeof ctx.depth === 'number' && Number.isFinite(ctx.depth)) {
    const d = ctx.depth
    if (s.minDepth >= 0 && d < s.minDepth) return false
    if (s.maxDepth >= 0 && d > s.maxDepth) return false
  }
  return true
}

/** 从字符串里挑一个（用于 `{{random::a::b}}`）。 */
function pickRandom(items) {
  const list = items.filter((x) => String(x).length > 0)
  if (!list.length) return ''
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * 展开 replaceString 里的占位符。
 *
 * 支持：`$&`/`$0`（整段匹配）、`$1..$99`、`{{match}}`、`{{char}}`、`{{user}}`、
 * `{{random::a::b::c}}`。ST 的 `$<name>`（命名组）这里不展开 —— 现有卡里 0 处使用。
 *
 * @param {string} tpl
 * @param {string[]} groups 捕获组（[0] = 整段）
 * @param {{char?:string, user?:string}} ctx
 */
function expandReplacement(tpl, groups, ctx) {
  const g = Array.isArray(groups) ? groups : ['']
  const char = (ctx && ctx.char) || '角色'
  const user = (ctx && ctx.user) || '用户'
  let s = String(tpl == null ? '' : tpl)
  if (!s) return ''
  s = s.replace(/\{\{random::([^{}]*)\}\}/gi, (_all, inner) => pickRandom(String(inner).split('::')))
  s = s.replace(/\{\{match\}\}/gi, g[0] || '')
  s = s.replace(/\{\{char\}\}/gi, char)
  s = s.replace(/\{\{user\}\}/gi, user)
  s = s.replace(/\$(\$|&|\d{1,2})/g, (all, tok) => {
    if (tok === '$') return '$'
    if (tok === '&') return g[0] || ''
    const i = Number(tok)
    return i < g.length && g[i] != null ? g[i] : ''
  })
  return s
}

/** 把 trimStrings 从一段文本里删掉（ST 在替换前对匹配内容做这一步）。 */
function applyTrim(text, trim) {
  let s = String(text == null ? '' : text)
  for (const t of trim || []) {
    if (!t) continue
    s = s.split(t).join('')
  }
  return s
}

/**
 * 对一段文本按顺序套用脚本。纯函数 —— 不读盘、不碰 DOM，便于单测。
 *
 * @param {string} text
 * @param {Array<object>} scripts compileCardScripts 的产物
 * @param {{mode?:'display'|'prompt', placement?:number, depth?:number, char?:string, user?:string, onReplace?:Function}} ctx
 * @returns {{text:string, replaced:number}}
 */
function applyCardScripts(text, scripts, ctx) {
  let out = String(text == null ? '' : text)
  if (!out) return { text: out, replaced: 0 }
  let replaced = 0
  const list = Array.isArray(scripts) ? scripts : []
  for (const s of list) {
    if (!shouldRun(s, ctx)) continue
    try {
      out = out.replace(s.re, function () {
        const args = Array.prototype.slice.call(arguments)
        // 末尾两个是 offset / 原串（有命名组时多一个 groups 对象）
        const tail = typeof args[args.length - 1] === 'string' ? 2 : 3
        const groups = args.slice(0, args.length - tail).map((v) => (v == null ? '' : String(v)))
        if (s.trim.length) {
          for (let i = 0; i < groups.length; i++) groups[i] = applyTrim(groups[i], s.trim)
        }
        replaced++
        const rep = expandReplacement(s.replace, groups, ctx)
        if (typeof (ctx && ctx.onReplace) === 'function') {
          try { return ctx.onReplace(rep, groups, s) } catch { return rep }
        }
        return rep
      })
    } catch {
      // 单条脚本运行期抛错（极少数回溯失控）⇒ 跳过它，保留其它脚本的结果
    }
  }
  return { text: out, replaced }
}

/** 这条脚本是不是「状态栏渲染器」（客户端补状态栏时用它判断卡有没有状态栏）。 */
function isStatusBarScript(s) {
  if (!s) return false
  if (/状态|status/i.test(s.name || '')) return true
  try { return /StatusPlaceHolder/i.test(s.replace || '') || /StatusPlaceHolder/i.test(s.re.source || '') } catch { return false }
}

export {
  PLACEMENT,
  SCRIPT_MAX,
  SCRIPT_TEXT_MAX,
  parseRegexLiteral,
  normalizePlacement,
  compileCardScripts,
  shouldRun,
  expandReplacement,
  applyTrim,
  applyCardScripts,
  isStatusBarScript,
}
