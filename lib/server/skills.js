// 技能（skill）：frontmatter 解析与命名
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { SKILL_NAME_RE } from './constants.js'
import { slugSkillName } from './util.js'

/** 某个酒馆预设对应的 skill 名（确定性：同一个预设永远同一个名字）。 */
function skillNameForPreset(presetId) {
  let body = slugSkillName(presetId) || 'preset'
  // 目录名本身就叫 tavern-xxx 时不要再叠一层前缀（否则出现 tavern-tavern-lite）
  if (body === 'tavern' || body.startsWith('tavern-')) body = body.replace(/^tavern-?/, '') || 'preset'
  const name = ('tavern-' + body).slice(0, 60).replace(/-$/, '')
  return SKILL_NAME_RE.test(name) ? name : 'tavern-preset'
}

/** 极简 frontmatter 解析（只看 `key: value` 单行，够读我们自己写的和常见 ST/DSH skill）。 */
function parseSkillFrontmatter(text) {
  const out = {}
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!mm) continue
    let v = mm[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    out[mm[1]] = v
  }
  return out
}

export { parseSkillFrontmatter, skillNameForPreset }
