// 显示正则（ST 式 regex script）—— 规则表、校验与 ST 卡导入
//
// 为什么需要它：ST 卡/预设里大量使用「输出侧脚本」把正文改写一遍再给人看
// （最典型的是把 `\u55b5` 这类 unicode 转义还原成中文，以及各种把标签/口水词
// 修掉的「防截断」脚本）。酒馆此前**没有任何输出侧改写能力**：模型照预设要求写出
// `\uXXXX`，界面上就是一片反斜杠乱码，用户只能去改预设正文。
//
// 本模块只负责**数据**：默认规则、校验归一化、ST 卡正则脚本的格式转换。
// **不改写会话日志、不改写提示词** —— 规则只在客户端渲染消息时作用于 DOM 文本节点
// （见 lib/client.manager.bundle.js 的 compileDisplayRules / applyDisplayRulesIn）。
//
// ⚠️ 引擎只有**一份**实现，在客户端 bundle 里。本文件不实现 replace，避免两份实现漂移
//    （历史教训见 AGENTS.md §6.6：escAttr 曾漂成空操作）。服务端只做「这张表合法吗」。

/** 规则条数上限：再多就说明是从别处整包灌进来的，界面上也没法维护。 */
const DISPLAY_RULE_MAX = 40

/** 单条 find/replace 的长度上限（防止把整份预设正文塞进一条规则）。 */
const DISPLAY_RULE_TEXT_MAX = 2000

/**
 * 出厂默认规则。
 *
 * 只有一条，但它就是用户这次报的那个故障的解：预设（`防截断` 模块）要求模型把露骨内容
 * 写成 `\uXXXX`，而我们此前**从不还原**，于是每轮开头都是一片 `\u55b5\u545c…`。
 *
 * `builtinUnescape: true` 让引擎走「按码点还原」分支（普通规则的 replace 是纯字符串
 * + `$1..$9` 反向引用，表达不了「把十六进制转成字符」）。
 */
const DEFAULT_DISPLAY_RULES = [
  {
    id: 'unicode-unescape',
    name: 'unicode 反转义（\\uXXXX → 原文）',
    enabled: true,
    builtinUnescape: true,
    find: '\\\\u([0-9a-fA-F]{4})',
    flags: 'g',
    replace: '',
  },
]

/** 合法的 flags 子集：只允许 g / i / m / s / u（不允许 y、d —— 它们对一次性 replace 无意义且更易踩坑）。 */
const FLAG_OK = /^[gimsu]*$/

/**
 * 把任意历史形态的规则表归一化成 `{ enabled:boolean, rules:[…] }`。
 *
 * 纯函数、不读盘。**非法规则一律丢弃而不是抛错**：这张表是用户手填的，
 * 一条写坏的正则不该让整份面板/整段渲染挂掉。
 *
 * @param {any} raw 磁盘上的 state.displayRules，或面板 POST 上来的 body
 * @returns {{enabled:boolean, rules:Array<object>, dropped:number}}
 */
function normalizeDisplayRules(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  const enabled = src.enabled !== false
  const list = Array.isArray(src.rules) ? src.rules : (Array.isArray(raw) ? raw : [])
  const rules = []
  let dropped = 0
  for (const r of list) {
    if (rules.length >= DISPLAY_RULE_MAX) { dropped++; continue }
    const one = normalizeOneRule(r)
    if (one) rules.push(one)
    else dropped++
  }
  return { enabled, rules, dropped }
}

/**
 * 单条规则归一化。不合法返回 null（由调用方计入 dropped）。
 *
 * @param {any} r
 * @returns {object|null}
 */
function normalizeOneRule(r) {
  if (!r || typeof r !== 'object') return null
  const find = String(r.find == null ? '' : r.find)
  if (!find || find.length > DISPLAY_RULE_TEXT_MAX) return null
  const flagsRaw = String(r.flags == null ? 'g' : r.flags)
  const flags = (FLAG_OK.test(flagsRaw) ? flagsRaw : 'g')
  // 正则真能编译才算合格 —— 这一条是本模块最实在的校验
  try { new RegExp(find, flags) } catch { return null }
  const replace = String(r.replace == null ? '' : r.replace)
  if (replace.length > DISPLAY_RULE_TEXT_MAX) return null
  const builtinUnescape = r.builtinUnescape === true
  const id = String(r.id || '').trim() || ('rule-' + rulesHash(find + '|' + flags + '|' + replace))
  return {
    id,
    name: String(r.name || '').trim().slice(0, 80) || '未命名规则',
    enabled: r.enabled !== false,
    builtinUnescape,
    find,
    flags,
    replace,
  }
}

/** 稳定的短 id（FNV-1a 32 位，只用来给手填规则生成 id，不做安全用途）。 */
function rulesHash(s) {
  let h = 0x811c9dc5
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h.toString(36)
}

/**
 * 从一张角色卡里抽出 ST 的 regex scripts 并转成本模块的规则形态。
 *
 * ST 的脚本长这样（`data.extensions.regex_scripts`，或卡根上的 `regexScripts`）：
 *   { scriptName, findRegex: '/\\u([0-9a-f]{4})/gi', replaceString: '…',
 *     disabled: false, markdownOnly: false, promptOnly: false, placement: [2] }
 *
 * **只收「输出侧」脚本**：`promptOnly === true` 的意思是只改提示词，那属于注入侧的事，
 * 本模块（显示层）收了会做错事，所以直接跳过。
 *
 * @param {object} card 单张角色卡
 * @returns {Array<object>} 已转换、可直接喂 normalizeOneRule 的规则
 */
function extractStRegexScripts(card) {
  if (!card || typeof card !== 'object') return []
  const pools = []
  try { if (Array.isArray(card.regexScripts)) pools.push(card.regexScripts) } catch {}
  try {
    const ext = card.data && card.data.extensions
    if (ext && Array.isArray(ext.regex_scripts)) pools.push(ext.regex_scripts)
  } catch {}
  const out = []
  for (const pool of pools) {
    for (const s of pool) {
      if (!s || typeof s !== 'object') continue
      if (s.disabled === true) continue
      if (s.promptOnly === true) continue      // 只作用于提示词的脚本，不属于显示层
      const parsed = parseSlashRegex(s.findRegex)
      if (!parsed) continue
      out.push({
        id: 'st-' + rulesHash(parsed.source + '|' + s.scriptName),
        name: String(s.scriptName || s.name || 'ST 脚本').slice(0, 80),
        enabled: true,
        find: parsed.source,
        flags: parsed.flags || 'g',
        replace: String(s.replaceString == null ? '' : s.replaceString),
      })
    }
  }
  return out
}

/**
 * 解析 ST 的 `/pattern/flags` 写法。
 *
 * ST 允许 `/` 在字符类里出现（`[/\\]/`），所以不能简单 `split('/')`；
 * 这里按「最后一个未转义、且不在 `[]` 里的 `/`」切。
 *
 * @param {string} raw
 * @returns {{source:string, flags:string}|null}
 */
function parseSlashRegex(raw) {
  const s = String(raw == null ? '' : raw)
  if (!s.startsWith('/')) return null
  let end = -1
  let inClass = false
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '[') { inClass = true; continue }
    if (c === ']') { inClass = false; continue }
    if (c === '/' && !inClass) end = i
  }
  if (end < 0) return null
  const source = s.slice(1, end)
  const flags = s.slice(end + 1)
  if (!source) return null
  if (!FLAG_OK.test(flags)) return { source, flags: 'g' }
  return { source, flags: flags || 'g' }
}

/**
 * 面板上「给用户看的一行摘要」。纯展示，不参与匹配。
 * @param {object} rule
 * @returns {string}
 */
function describeRule(rule) {
  const r = rule || {}
  return '查找 ' + String(r.find || '') + ' ／ 替换为 ' + (String(r.replace || '') || '（空）')
}

export {
  DEFAULT_DISPLAY_RULES,
  DISPLAY_RULE_MAX,
  DISPLAY_RULE_TEXT_MAX,
  normalizeDisplayRules,
  normalizeOneRule,
  extractStRegexScripts,
  parseSlashRegex,
  describeRule,
  rulesHash,
}
