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
    if (!entry.keywords || !entry.keywords.length) continue
    const matched = entry.keywords.some(kw => kw && haystack.includes(String(kw).toLowerCase()))
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
