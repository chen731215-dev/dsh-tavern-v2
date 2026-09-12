// dsh-tavern 纯函数工具模块（无外部依赖，可单独测试）
import os from 'node:os'
import path from 'node:path'

const CARD_MAX = 40000
// 预设数据根目录（memory.js 等拆分子模块依赖此导出）
export const ROOT = path.join(os.homedir(), '.dsh', '.agent-presets')

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
    // ★ @deepseek-ai/dsh-persona 0.1.3-alpha.2 起把 persona 文本字段由 text: 改名为 prefix:，
    //   两种键名都接受，保证旧预设（text:）与新预设（prefix:）都能提取角色卡文本。
    const m = lines[i].match(/^(\s*)(?:prefix|text):\s*\|-/)
    if (m) { start = i + 1; textIndent = m[1].length; break }
  }
  if (start < 0) return ''
  const out = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { out.push(''); continue }
    // ★ 遇到缩进小于等于「prefix:/text: 行」缩进的非空行就结束（同级或更高级别的 YAML 键）。
    //   旧实现只认顶格行（/^\S/），会把 config 下同样缩进的 complete:/includeRuntimeContext:
    //   一并吞进角色卡正文，因此这里与 lib/index.js 的 extractCardText 保持一致。
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
