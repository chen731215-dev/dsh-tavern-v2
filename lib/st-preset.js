/**
 * SillyTavern 预设（chat completion preset）→ 酒馆预设模块 的**通用**转换器。
 *
 * 为什么需要它：ST 的预设是「67 条 prompt + prompt_order 决定启停/顺序」的形态，
 * 而酒馆的预设是「若干 pack，每个 pack 里若干 module」的形态。直接把 `prompts`
 * 全量搬过去会出三类事故（都是实测）：
 *   1. **把禁用的条目也搬进去**：ST 的启停不在 prompt 上，在 `prompt_order.enabled`；
 *      只按 `prompts[]` 搬 ⇒ 所有"废稿/备选/关闭的 NSFW 变体"全部注入；
 *   2. **把结构占位当正文**：`World Info (before)`、`Char Description`、`Chat History`
 *      这些是 ST 的装配位（内容为空，由 ST 运行时填），搬过去就是空标签或 `{{char}}` 字面量；
 *   3. **把扩展的 JS 配置当提示词**：SPreset 系预设的 `SPresetSettings` 是 10 万字符级
 *      的 JS 配置对象，搬进上下文会直接撑爆并让模型模仿代码。
 *
 * 本模块只做**纯函数**转换（不读盘、不写盘），便于单测与复用到 CLI。
 *
 * 口径（刻意保守，宁可少搬不可乱搬）：
 *   · 以 `prompt_order` 里**条目最多**的那份为准（ST 常同时给 100000 单聊 / 100001 群聊，
 *     有的预设只有群聊那份是满的）；
 *   · 只保留 enabled 的条目为启用；未启用的**可选变体**保留为 enabled:false（面板可再开）；
 *   · 结构占位 / 空内容 / 章节分隔线 / 草稿 / JS 配置一律丢弃，并在 `warnings` 里记账；
 *   · 内容原样保留（`{{char}}`/`{{user}}` 等宏由注入出口的 cleanSillyTavernVars 处理，
 *     防截断一类 JS 管线由 compatPresetContent 在注入时改写）；
 *   · `{{// … }}` 整段注释若独占一条，按 ST 语义丢弃；夹在正文里的注释只剥注释本身。
 */

/** ST 的结构占位（由 ST 运行时填内容，不是提示词正文）。 */
const ST_STRUCTURAL_IDS = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'personaDescription',
  'scenario',
  'dialogueExamples',
  'chatHistory',
  'char',
  '/char',
  'main',
  'SPresetSettings',
  'version_info',
])

/** 名字层面的丢弃规则（各预设作者的约定，跨卡通用）。 */
const ST_DROP_NAME_RES = [
  /^----/,            // 章节分隔线（----角色控制----）
  /^char$/i,
  /^\/char$/i,
  /^世界书设定捏$/,     // 仅一个 [World Settings] 标题
  /废稿/,              // 作者留的废弃草稿
  /^SPreset/i,         // SPreset 配置块
]

const MAX_CONTENT_CHARS = 40000
const MAX_MODULES = 200

/** 是否像一份 ST chat-completion 预设。 */
export function isStPreset(json) {
  if (!json || typeof json !== 'object') return false
  if (!Array.isArray(json.prompts)) return false
  return Array.isArray(json.prompt_order) || json.prompts.some(p => p && p.identifier)
}

/** 去掉 ST 的 `{{// … }}` 注释；整条只有注释时返回空串。 */
function stripStComments(text) {
  let s = String(text == null ? '' : text)
  const whole = s.match(/^\s*\{\{\/\/\s*([\s\S]*?)\}\}\s*$/)
  if (whole) return ''
  s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
  return s
}

/** 去掉宏/注释后是否还有实际文字。 */
function hasRealText(text) {
  const s = stripStComments(text)
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .trim()
  return s.length > 0
}

/**
 * 转换一份 ST 预设。
 *
 * @param {object} json ST 预设 JSON（或含 `presets`/`data` 外壳的导出件）
 * @param {{name?:string, keepDisabled?:boolean}} [opts]
 * @returns {{ok:true, name:string, modules:Array<{name:string,content:string,enabled:boolean}>,
 *            stats:{total:number,enabled:number,chars:number,skipped:number},
 *            warnings:string[], skipped:Array<{name:string,reason:string}>}
 *          | {ok:false, error:string}}
 */
export function convertStPreset(json, opts) {
  const o = opts || {}
  let data = json
  // 宽容外壳：有些导出件是 `{ data: {...} }` / `{ preset: {...} }`
  if (data && typeof data === 'object' && !Array.isArray(data.prompts)) {
    if (data.data && Array.isArray(data.data.prompts)) data = data.data
    else if (data.preset && Array.isArray(data.preset.prompts)) data = data.preset
  }
  if (!isStPreset(data)) return { ok: false, error: 'not-st-preset：没有 prompts 数组' }

  const prompts = data.prompts
  const byId = new Map()
  const byName = new Map()
  for (const p of prompts) {
    if (!p) continue
    if (p.identifier) byId.set(String(p.identifier), p)
    if (p.name) byName.set(String(p.name), p)
  }

  // 选 order：条目最多的一份
  const orders = Array.isArray(data.prompt_order) ? data.prompt_order.filter(x => x && Array.isArray(x.order)) : []
  let order = []
  for (const pack of orders) if (pack.order.length > order.length) order = pack.order
  const usedOrder = order.length > 0
  if (!usedOrder) {
    order = prompts.map(p => ({ identifier: p && p.identifier, enabled: p ? p.enabled !== false : true }))
  }

  const skip = []
  const modules = []
  const seen = new Set()
  let inChat = 0
  let chars = 0

  for (const row of order) {
    const p = byId.get(String(row.identifier || '')) || byName.get(String(row.identifier || ''))
    if (!p) { skip.push({ name: String(row.identifier || ''), reason: 'missing-prompt' }); continue }
    const ident = String(p.identifier || '')
    const name = String(p.name || ident || '').trim()
    let content = String(p.content == null ? '' : p.content)
    if (!name) { skip.push({ name: ident, reason: 'no-name' }); continue }
    if (ST_STRUCTURAL_IDS.has(ident) || ST_STRUCTURAL_IDS.has(name)) { skip.push({ name, reason: 'structural-marker' }); continue }
    if (ST_DROP_NAME_RES.some(re => re.test(name))) { skip.push({ name, reason: 'name-rule' }); continue }
    if (!hasRealText(content)) { skip.push({ name, reason: 'empty' }); continue }
    if (content.length > MAX_CONTENT_CHARS && /^\s*[[{]|function\s|=>/.test(content.slice(0, 400))) {
      skip.push({ name, reason: 'config-blob' }); continue
    }
    content = stripStComments(content).trim()
    if (!content) { skip.push({ name, reason: 'empty' }); continue }
    const enabled = row.enabled !== false
    if (!enabled && o.keepDisabled === false) { skip.push({ name, reason: 'disabled' }); continue }
    if (p.injection_position === 1 || p.injectionPosition === 1) inChat++
    const key = name + '\u0000' + content
    if (seen.has(key)) { skip.push({ name, reason: 'duplicate' }); continue }
    seen.add(key)
    modules.push({ name, content, enabled })
    chars += enabled ? content.length : 0
    if (modules.length >= MAX_MODULES) break
  }

  if (!modules.length) return { ok: false, error: 'no-usable-modules：这份预设没有可搬进 DSH 的提示词' }

  const warnings = []
  if (!usedOrder) warnings.push('没有 prompt_order：按 prompts 原顺序全量搬运（可能包含 ST 里已关闭的条目）')
  if (skip.length) warnings.push('丢弃 ' + skip.length + ' 条：' + skip.slice(0, 8).map(s => s.name + '(' + s.reason + ')').join('、') + (skip.length > 8 ? ' 等' : ''))
  if (inChat) warnings.push(inChat + ' 条原本是「对话内注入」（injection_position=1），DSH 没有这条通道，已并入系统提示')
  const name = String(o.name || data.name || data.title || (data.data && data.data.name) || 'ST 预设').trim()

  return {
    ok: true,
    name,
    modules,
    stats: { total: order.length, enabled: modules.filter(m => m.enabled).length, chars, skipped: skip.length },
    warnings,
    skipped: skip,
  }
}

export default { isStPreset, convertStPreset }
