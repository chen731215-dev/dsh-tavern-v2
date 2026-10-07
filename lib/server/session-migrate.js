// 会话/预设的一次性迁移（路径依赖：ROOT）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import path from 'node:path'
import { P } from './state.js'
import { json } from './util.js'

/**
 * 修复历史预设里 legacy 的 persona 字段名。
 *
 * v2.3.6 之前，面板生成 `agent.cordis.yml` 时把 persona 正文写在 `text:` 字段，
 * 而 `@deepseek-ai/dsh-persona` 的 Config 以 `prefix` 为必填。结果是切到该预设时
 * 直接挂载失败：
 *   failed to apply loader entry persona (@deepseek-ai/dsh-persona):
 *   invalid config: - $.prefix missing required value
 * 这里把历史预设里 persona 行的 `text: |-` 就地改成 `prefix: |-`（改前留 .bak），
 * 让老预设无需重建即可使用。
 * @returns {number} 实际修复的文件数
 */
function migratePersonaTextField() {
  let dirs
  try { dirs = fs.readdirSync(P.ROOT, { withFileTypes: true }) } catch { return 0 }
  let fixed = 0
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const ymlPath = path.join(P.ROOT, d.name, 'agent.cordis.yml')
    let src
    try { src = fs.readFileSync(ymlPath, 'utf8') } catch { continue }
    const lines = src.split('\n')
    if (lines.some(l => /^\s*prefix:\s*\|/.test(l))) continue   // 已有 prefix，不动
    let inPersona = false
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*-\s*id:\s*persona\s*$/.test(lines[i])) { inPersona = true; continue }
      if (inPersona && /^\s*-\s*id:/.test(lines[i])) { inPersona = false; continue }
      if (inPersona && /^(\s*)text:\s*\|-/.test(lines[i])) {
        lines[i] = lines[i].replace(/^(\s*)text:/, '$1prefix:')
        changed = true
        break
      }
    }
    if (!changed) continue
    try {
      fs.writeFileSync(ymlPath + '.bak', src, 'utf8')
      fs.writeFileSync(ymlPath, lines.join('\n'), 'utf8')
      fixed++
    } catch {}
  }
  if (fixed > 0) console.log('[dsh-tavern] 已修复 ' + fixed + ' 个历史预设的 persona 字段（text -> prefix）')
  return fixed
}

/**
 * 优化历史预设的 persona 结构（早期面板生成物的第二个坑）。
 *
 * 早期面板生成 `agent.cordis.yml` 时，把**整个角色卡 + 全部世界书**塞进 persona 的
 * `prefix`，并设了 `complete: true`。而 `complete` 的语义是
 * 「本段恢复为**唯一**的系统提示段落」（见 dsh-system-prompt 的 assemble：
 * `sections: [completeSection]`）。于是被整段压掉的有：
 *
 *   - 酒馆自己的 `tavern:card`（反八股 / 会话记忆 / 关系网 / 世界书 / 工具开关）
 *   - 酒馆自己的 `tavern:nsfw`
 *   - DSH 原生的身份段、工具指引、运行时上下文
 *
 * 症状就是「反八股不生效」「原生工具指引消失」，同时角色卡与世界书还被重复注入两份。
 *
 * 这里把历史预设改回正确结构：
 *   1. 去掉 persona 的 `complete: true`
 *   2. 从 prefix 字面量里摘掉 `# 角色卡` / `# 世界书` 两段
 *      （服务端会按会话注入；世界书是关键词触发，省上下文）
 *
 * 安全约束：只有当预设目录里存在非空的 `characters.json` 时才摘角色卡那一段，
 * 保证卡片仍可从酒馆自己的存储读回；否则只去掉 `complete: true`，不动内容。
 * 改前一律留 `.bak`。
 * @returns {number} 实际修复的文件数
 */
function migratePersonaCompleteFlag() {
  let dirs
  try { dirs = fs.readdirSync(P.ROOT, { withFileTypes: true }) } catch { return 0 }
  let fixed = 0
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(P.ROOT, d.name)
    const ymlPath = path.join(dir, 'agent.cordis.yml')
    let src
    try { src = fs.readFileSync(ymlPath, 'utf8') } catch { continue }
    if (!src.includes('# 酒馆管理面板生成')) continue
    if (!/^\s*complete:\s*true\s*$/m.test(src)) continue

    const lines = src.split('\n')
    let pStart = -1
    let pIndent = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)prefix:\s*\|-/)
      if (m) { pStart = i; pIndent = m[1].length; break }
    }

    let out = lines
    if (pStart >= 0) {
      let pEnd = lines.length
      for (let i = pStart + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue
        if (lines[i].match(/^(\s*)/)[1].length <= pIndent) { pEnd = i; break }
      }
      // 只有 characters.json 里有卡片时才敢摘 persona 里的角色卡
      let hasChars = false
      try {
        const cj = JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'))
        hasChars = Array.isArray(cj) && cj.some(c => c && (c.name || c.first || c.desc))
      } catch {}
      const out2 = lines.slice(0, pStart + 1)
      let skipping = false
      for (let i = pStart + 1; i < pEnd; i++) {
        const h = lines[i].match(/^(\s*)#\s*(\S.*?)\s*$/)
        if (h && h[1].length === pIndent + 2) {
          const title = h[2].trim()
          skipping = title === '世界书' || (title === '角色卡' && hasChars)
        }
        if (!skipping) out2.push(lines[i])
      }
      out2.push(...lines.slice(pEnd))
      out = out2
    }

    let text = out.join('\n').replace(/^[ \t]*complete:[ \t]*true[ \t]*\r?\n/m, '')
    if (text === src) continue
    try {
      fs.writeFileSync(ymlPath + '.bak', src, 'utf8')
      fs.writeFileSync(ymlPath, text, 'utf8')
      fixed++
    } catch {}
  }
  if (fixed > 0) console.log('[dsh-tavern] 已优化 ' + fixed + ' 个历史预设（移除 complete:true，角色卡/世界书改由服务端按会话注入）')
  return fixed
}

export { migratePersonaCompleteFlag, migratePersonaTextField }
