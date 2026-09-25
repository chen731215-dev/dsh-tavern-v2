// dsh-tavern 纯函数工具模块（无外部依赖，可单独测试）
import os from 'node:os'
import path from 'node:path'

const CARD_MAX = 40000
// 预设数据根目录（memory.js 等拆分子模块依赖此导出）。
// 与 lib/index.js 的 bindDshPaths() 同源：$DSH_HOME（非空）→ ~/.dsh。
// 本模块是纯函数模块，拿不到 cordis 上下文，只能按环境变量解析；
// 若部署是用显式配置项而非 $DSH_HOME 指定 harness home，
// 一律以 index.js 运行时绑定的 ROOT 为准。
export const ROOT = (() => {
  const env = process.env.DSH_HOME
  const home = typeof env === 'string' && env.trim().length > 0
    ? path.resolve(env.trim())
    : path.join(os.homedir(), '.dsh')
  return path.join(home, '.agent-presets')
})()

// ── 世界书关键词匹配 ───────────────────────────────────
export function matchWorldbookEntries(worldbook, recentText) {
  const hits = []
  const haystack = String(recentText || '').toLowerCase()
  const isFull = worldbook.injectMode === 'full'
  for (const entry of worldbook.entries) {
    if (entry.enabled === false) continue
    // full 模式：所有启用条目都注入
    if (isFull) { hits.push(entry); continue }
    // keyword 模式：无关键词不注入，有关键词匹配才注入
    // ★ P2-1：ST 的 lorebook 主字段是 keys —— 与 lib/index.js 的 entryKeys 对齐，
    //   keys ∪ keywords 并集匹配（去重、大小写不敏感）
    const kwList = [
      ...(Array.isArray(entry.keys) ? entry.keys : []),
      ...(Array.isArray(entry.keywords) ? entry.keywords : []),
    ].filter(Boolean).map(String)
    if (!kwList.length) continue
    const matched = kwList.some(kw => kw && haystack.includes(kw.toLowerCase()))
    if (matched) hits.push(entry)
  }
  return hits
}

export function buildWorldbookText(entries) {
  if (!entries.length) return ''
  const parts = ['【世界书 — 关键词触发条目】']
  for (const e of entries) {
    parts.push(`\n## ${e.name || '未命名条目'}`)
    if (e.keywords && e.keywords.length) parts.push(`触发词：${e.keywords.join(', ')}`)
    parts.push(e.content || '')
  }
  return parts.join('\n')
}

// ── 角色卡文本提取 ─────────────────────────────────────
export function extractCardText(agentYml) {
  if (typeof agentYml !== 'string') return ''
  const lines = agentYml.split(/\r?\n/)
  let start = -1
  let textIndent = 0
  for (let i = 0; i < lines.length; i++) {
    // ★ 兼容两种字段名：早期生成的是 text:，DSH 现行 dsh-persona 要求 prefix:
    const m = lines[i].match(/^(\s*)(?:text|prefix):\s*\|-/)
    if (m) { start = i + 1; textIndent = m[1].length; break }
  }
  if (start < 0) return ''
  const out = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { out.push(''); continue }
    // ★ 块结束必须按「键名缩进」比较，不能只认顶格行（原先写的是 /^\S/）：
    //   config: 下面的 complete: / includeRuntimeContext: 与 prefix: 同级缩进，
    //   但都不是第 0 列，只认顶格会把它们当成角色卡正文一起吞进去，
    //   注入时就在卡片末尾多出「complete: false」这类垃圾文本。
    //   同功能的 lib/index.js 一直用的是缩进比较，这里对齐。
    const indentMatch = line.match(/^(\s*)\S/)
    if (indentMatch && indentMatch[1].length <= textIndent) break
    const m = line.match(/^( {2,})/)
    out.push(m ? line.slice(m[1].length) : line)
  }
  let text = out.join('\n').trim()
  if (text.length > CARD_MAX) text = text.slice(0, CARD_MAX) + '\n\n（卡片过长，已截断至前 ' + CARD_MAX + ' 字）'
  return text
}

// ── 消息内容转文本 ─────────────────────────────────────
export function contentToText(content) {
  if (!content || !Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

// ── 通用预设增强层（preset-forge）────────────────────────
//
// 目标：让**任何**预设都有一个下限，而不是靠人工改某一份预设文本。
// 两条通路：
//   ① 模块包 merge 进 presets.json（面板「套用到当前预设」，写文件，持久）；
//   ② 运行时注入（面板开关，不写预设，装配 system prompt 时追加，默认关闭）。
// 两条通路都受同一组硬约束（见 ENHANCE_HARD_RULES 注释）。

/** 增强层自带的模块包（与插件同目录，随 npm 包一起分发）。 */
export const ENHANCE_PACK_FILE = 'preset-enhance-pack.json'

/**
 * 卡的输出格式契约标签。
 *
 * 这些标签是渲染器与变量管线的**输入接口**，不是装饰。增强条款里必须显式声明
 * 「不得删除 / 改名 / 嵌套这些标签，格式指令优先于文风要求」，否则一条看起来
 * 无害的文风规则（比如"结尾不要写总结"）就会把 <now_plot> 整块吃掉。
 */
export const ENHANCE_CONTRACT_TAGS = [
  'content', 'now_plot', 'Abstract', 'audio', 'img', 'video',
  'VariableThink', 'VariableEdit', 'era_data',
]

/**
 * 「不许动」的模块名判定：名字里带 变量 / Variable / era / 格式 / format 的模块
 * 属于变量组与格式管线（预设里常写作 🔒 尽可能不要动（变量组）、💯丨变量更新、
 * 🚀丨格式增强）。这类模块在 merge 时**只补不覆盖**，运行时注入也不覆盖它们。
 */
export function isEnhanceProtectedName(name) {
  const n = String(name || '')
  return /变量|Variable|era|格式|format/i.test(n)
}

/** 把任意输入规整成合法的模块数组（丢弃缺 name 或缺 content 的条目）。 */
export function normalizeEnhancePack(pack) {
  if (!Array.isArray(pack)) return []
  const out = []
  for (const m of pack) {
    if (!m || typeof m !== 'object') continue
    const name = typeof m.name === 'string' ? m.name.trim() : ''
    const content = typeof m.content === 'string' ? m.content : ''
    if (!name || !content.trim()) continue
    out.push({ name, content, enabled: m.enabled !== false })
  }
  return out
}

/**
 * 把增强模块包 merge 进一个已有的模块数组（纯函数，不改入参）。
 *
 * 同 name 判定：
 *   - 不存在      → 追加（added）
 *   - 受保护模块  → **永远**保留用户版本（protectedKept），`overwrite` 对它无效
 *   - overwrite   → 覆盖为增强版（overwritten）
 *   - 否则        → 保留用户版本（kept）
 *
 * @param {Array} existing 预设里已有的模块数组
 * @param {Array} pack     增强模块包
 * @param {{overwrite?: boolean}} opts
 * @returns {{modules: Array, added: number, overwritten: number, kept: number, protectedKept: number, skipped: number}}
 */
export function mergeEnhanceModules(existing, pack, opts) {
  const src = Array.isArray(existing) ? existing : []
  const mods = src.map(m => (m && typeof m === 'object' ? { ...m } : m))
  const items = normalizeEnhancePack(pack)
  const overwrite = !!(opts && opts.overwrite)
  const byName = new Map()
  for (let i = 0; i < mods.length; i++) {
    const nm = typeof mods[i]?.name === 'string' ? mods[i].name : ''
    // 只在第一次出现时登记：后续同名条目不登记，避免覆盖到错误的下标
    if (nm && !byName.has(nm)) byName.set(nm, i)
  }
  const stat = { added: 0, overwritten: 0, kept: 0, protectedKept: 0, skipped: 0 }
  for (const item of items) {
    const idx = byName.has(item.name) ? byName.get(item.name) : -1
    if (idx < 0) {
      byName.set(item.name, mods.length)
      mods.push({ name: item.name, content: item.content, enabled: item.enabled })
      stat.added++
      continue
    }
    const cur = mods[idx]
    if (isEnhanceProtectedName(item.name) || isEnhanceProtectedName(cur?.name)) {
      stat.protectedKept++
      continue
    }
    if (overwrite) {
      mods[idx] = { name: item.name, content: item.content, enabled: item.enabled }
      stat.overwritten++
    } else {
      stat.kept++
    }
  }
  stat.skipped = items.length - (stat.added + stat.overwritten + stat.kept + stat.protectedKept)
  return { modules: mods, ...stat }
}

/**
 * 运行时注入的开关判定。
 *
 * ★ 默认关闭：只有**显式** `true` 才注入。写成 `!state.enhanceRuntime` 之类的反向
 *   判定会让"字段不存在"等价于"开启"，用户装了插件后效果就被被动改变了 —— 那是事故。
 */
export function enhanceRuntimeEnabled(state) {
  return !!(state && state.enhanceRuntime === true)
}

/**
 * 运行时注入块（开关打开时追加到 system prompt 的最后一段）。
 *
 * 顺序有意为之：先契约、再防抢话 / 防全知（这两条优先级最高）、最后文风。
 * 放在最后一段是为了压过预设里较弱的同类规则 —— 预设是**数据**，我们不知道
 * 它写了什么，只能靠位置保证下限。
 */
export function buildEnhanceRuntimeBlock() {
  const tags = ENHANCE_CONTRACT_TAGS.map(t => `<${t}>`).join(' ')
  return [
    '【通用增强层 — 本段为最后一段，与前面任何规则冲突时以本段为准】',
    '',
    '## 0. 输出契约（最高优先级，优先于下面所有文风要求）',
    `${tags} 是渲染器与变量管线的输入接口：不得删除、改名、嵌套、拆分、改大小写；`,
    '块顺序与字段要求照卡/模板原样。为了让文风更干净而改动任何一个标签 = 不合格。',
    '',
    '## 1. 防抢话（最高优先级）',
    '- 禁止代用户角色说话、行动、做决定；禁止写用户角色的心理与感受（含"你感到…"）；',
    '  连"他沉默了""你点了点头"这类补写也不行。',
    '- 用户角色的反应只由用户写。回复必须停在用户可行动处：不要在同一轮里既有冲突又有解决。',
    '',
    '## 2. 防全知 · 有限视角（最高优先级）',
    '- 只写当前场景中主角可感知或当场推断的信息；禁止写主角看不见/听不见的场面。',
    '- 禁止直接写他人的未外显心理、计划、背景；要表现 NPC 内心时只写外显（动作、微表情、语气、停顿）供推测。',
    '- 禁止提前使用尚未获得的信息；未知就用"那个女人""他说的地方"指代。',
    '',
    '## 3. 文风',
    '- 用具体名词与感官细节代替抽象评价；禁止"很美/很压抑/气氛紧张"这类概括。',
    '- 短句长句交替，冲突优先走对白；每段只推进一件事。',
    '- 禁止总括式升华结尾（"在这一刻…""仿佛整个世界…"）与 AI 腔套话',
    '  （首先/其次/总之/不由得/某种意义上/值得一提的是）。',
    '- 禁止每轮套同一模板（环境→对白→升华）；禁止复用上一轮的比喻、句式、开头与结尾方式。',
    '',
    '## 4. 纪律',
    '以上 1~3 条都只在契约（第 0 条）允许的空间内生效；两者冲突时一律以契约为准。',
  ].join('\n')
}
