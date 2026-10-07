// 文本清洗与角色卡正文提取（无状态部分）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { CARD_MAX } from './constants.js'

function extractCardText(agentYml) {
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
    // 遇到缩进等于或小于 text: 行缩进的非空行时停止（同级或更高级别的 YAML 键）
    const indentMatch = line.match(/^(\s*)\S/)
    if (indentMatch && indentMatch[1].length <= textIndent) break
    const m = line.match(/^( {2,})/)
    out.push(m ? line.slice(m[1].length) : line)
  }
  let text = out.join('\n').trim()
  if (text.length > CARD_MAX) text = text.slice(0, CARD_MAX) + '\n\n（卡片过长，已截断至前 ' + CARD_MAX + ' 字）'
  return text
}

// 乱码清洗：移除 U+FFFD 替换符等损坏字符（保留 &，兼容含 & 的角色/预设名）
function cleanName(name) {
  if (!name) return ''
  return String(name).replace(/[\uFFFD\u0000-\u001F\u007F-\u009F]/g, '').replace(/�+/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_&\-—（）()\s]/g, '').trim()
}

export { extractCardText, cleanName }
