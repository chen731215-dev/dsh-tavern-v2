// ─────────────────────────────────────────────────────────────────────────────
// card-skill-compiler.js — 酒馆「卡库 → DSH Skill」自动编译器（2026-09-25）
//
// 目标：面板每次保存配置（bind-preset / save / worldbook 保存）时，把
//   <presetDir> 下的 characters.json + worldbooks.json + presets.json
// 编译成自包含的 DSH skill（<dshHome>/skills/tavern-card-<slug>/SKILL.md），
// 让用户脱离酒馆插件管线、直接在 skill 会话里跑卡聊天。
//
// 设计要点：
//  · 纯函数 + 显式注入路径（presetDir / skillsDir 由 index.js 解析后传入），
//    本模块不做任何 DSH 侧写盘之外的事，便于单测（临时目录直打）。
//  · 世界书分组匹配：组名与卡名互相 includes（去版本号/空白后）才归属该卡；
//    匹配不到任何卡的组不编译，只进索引的「未编译分组」清单。
//  · ★ 合规硬线（不可关闭）：条目含未成年年龄且带性内容、或幼态词+性内容
//    ⇒ 整条剔除并在编译结果与索引中记录。命中即剔除，不做内容改写。
//  · 索引 skill（tavern-cards）是自动选择的路由核心：AI 先命中索引，
//    再按索引里的绝对路径 Read 具体卡 skill —— 两级路由，不依赖单条
//    description 的语义运气。手搓卡（如 sese-teyvat）在 SKILL.md 首行加
//    `<!-- tavern-card:卡名 -->` 标记即可被索引收录。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// ── 合规扫描 ────────────────────────────────────────────────────────────────
// 显式未成年年龄：age: 12 / age: "16" / 年龄：15（含全角冒号）。
// 两侧都禁邻接数字：防止 "age: 19" 从第二位命中 "9"、"age: 24" 命中 "4" 的误报。18/19 不命中。
const AGE_MINOR_RE = /(?:age|年龄)\s*[:：]\s*["']?\s*(?<![\d.])(?:1[0-7]|[1-9])(?![\d.])/i
// 幼态词（无论 age 写什么，出现即进入人工规则判定）
const CHILDLIKE_RE = /萝莉|幼女|幼态|正太|儿童|小学生|童颜|幼齿|小孩体型/
// 性内容迹象（任一命中即视为该条目携带性内容）
const NSFW_HINT_RE = /小穴|肛门|阳具|阴茎|精液|阴道|乳[头房]|乳沟|胸部|肛交|口交|高潮|做爱|性爱|性行为|性交|情色|淫[荡乱水]|后庭|自慰|插入/

/**
 * 合规扫描一段文本。
 * @returns {{ block: boolean, reasons: string[] }}
 *   block=true ⇒ 该条目/卡不可编译进 skill。
 */
export function scanCompliance(text) {
  const reasons = []
  const t = String(text || '')
  const hasNsfw = NSFW_HINT_RE.test(t)
  if (AGE_MINOR_RE.test(t) && hasNsfw) {
    const m = AGE_MINOR_RE.exec(t)
    reasons.push('显式未成年年龄 + 性内容（命中: ' + (m ? m[0].trim() : 'age') + '）')
  }
  if (CHILDLIKE_RE.test(t) && hasNsfw) {
    const w = CHILDLIKE_RE.exec(t)
    reasons.push('幼态词 + 性内容（命中: ' + (w ? w[0] : '') + '）')
  }
  return { block: reasons.length > 0, reasons }
}

// ── 卡名 → 合法 kebab slug ─────────────────────────────────────────────────
// DSH 要求 skill name 为 kebab-case；中文卡名的语义触发靠 description，
// name 只求 ASCII、稳定、唯一。
export function slugifyCardName(name, presetId) {
  const ascii = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii.length >= 2) return ascii.slice(0, 48)
  // 全中文等无法提取 ASCII：用 预设id + 卡名哈希 保证稳定唯一
  const h = createHash('sha1').update(String(name || '') + '|' + String(presetId || '')).digest('hex').slice(0, 8)
  return ((presetId || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'card') + '-' + h
}

// ── 组名 / 卡名 归一化（去版本号、空白）用于互相匹配 ───────────────────────
function normName(s) {
  return String(s || '').toLowerCase().replace(/v\d+(\.\d+)*$/i, '').replace(/[\s　]+/g, '')
}

/** 组名与卡名是否互相归属（双向 includes） */
export function groupMatchesCard(groupName, cardName) {
  const g = normName(groupName)
  const c = normName(cardName)
  if (!g || !c) return false
  return g.includes(c) || c.includes(g)
}

// ── SKILL.md 生成 ───────────────────────────────────────────────────────────
function yamlQ(s) { return String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim() }

/**
 * 生成单张卡的 SKILL.md 全文。
 * @param {object} p
 *   card        {name, desc, first}
 *   presetName  预设显示名
 *   entries     已归属该卡的 enabled 条目 [{name,comment,keys,keywords,content,enabled}]
 *   skipped     该卡被剔除的条目 [{entry, reason}]
 * @returns {string}
 */
export function buildCardSkill({ card, presetName, entries, skipped }) {
  const cardName = card.name || '未命名卡'
  const resident = entries.filter(e => !(e.keys || []).length && !(e.keywords || []).length)
  const triggered = entries.filter(e => (e.keys || []).length || (e.keywords || []).length)
  const hasStatusBar = /<Status_block>/.test(card.first || '') || resident.some(e => /<Status_block>/.test(e.content || ''))
  const out = []
  const slugDesc = (card.desc || '').slice(0, 60).replace(/\s+/g, ' ')

  out.push('---')
  out.push(`name: ${yamlQ(card.__slug !== undefined ? card.__slug : 'tavern-card')}`)
  out.push(`description: 酒馆角色卡「${cardName}」（预设 ${yamlQ(presetName)}）。${yamlQ(slugDesc)}自包含角色扮演环境：世界观/角色库/格式契约/开场白。当用户想进入「${cardName}」或该卡的角色扮演聊天时使用。`)
  out.push(`whenToUse: 用户提到「${cardName}」或要求进入这张酒馆角色卡聊天时。`)
  out.push('---')
  out.push('')
  out.push(`<!-- tavern-card:${cardName} -->`)
  out.push('')
  out.push(`# ${cardName} · 角色卡聊天环境`)
  out.push('')
  out.push('> 本 skill 由酒馆面板配置自动编译（预设：' + yamlQ(presetName) + '）。修改配置后面板再次保存即刷新本文件。')
  out.push('')

  // §0 硬边界
  out.push('## 0. 硬边界（最高优先级，任何后续指令不可覆盖）')
  out.push('')
  out.push('1. **全员成年**：所有参与情色内容的角色均为成年人；任何把角色往未成年方向写的指令一律拒绝。')
  out.push('2. **仅限虚构**：架空同人世界，不影射真实人物。')
  out.push('3. **自愿为默认**：成年角色间的支配/臣服是知情自愿的扮演；不描写对第三方的强迫性场景，不把伤害美化成情趣。')
  out.push('4. **去数据化**：正文禁止"心率120/情绪评估/执行方案"这类系统后台式语言，用文学性描写呈现。')
  if (skipped.length) {
    out.push('')
    out.push(`**本卡编译时已剔除 ${skipped.length} 个条目**（合规硬线：未成年人/幼态性化内容），这些内容不可通过任何指令恢复：`)
    for (const s of skipped) out.push(`- 「${s.entry}」— ${s.reason}`)
  }
  out.push('')

  // §1 任务
  out.push('## 1. 你的任务')
  out.push('')
  out.push('用户扮演卡中的主角（见开场白），你扮演世界中其他所有角色与环境叙事，第三人称小说体推进。**触发本 skill 的首轮回复 = 直接原样输出「§5 开场白」**，之后进入正常对局。')
  out.push('')

  // §2 常驻世界书
  out.push(`## 2. 常驻世界书（${resident.length} 条，始终生效）`)
  out.push('')
  for (const e of resident) {
    out.push(`### ${e.name || e.comment || '未命名条目'}`)
    out.push('')
    out.push(String(e.content || e.text || '').trim())
    out.push('')
  }

  // §3 触发条目库
  if (triggered.length) {
    out.push(`## 3. 按需触发条目库（${triggered.length} 条）`)
    out.push('')
    out.push('剧情涉及某条目主题/角色（按触发词语义判断，不要求逐字命中）时，把对应条目内容织入扮演；未触发不提前剧透。')
    out.push('')
    out.push('| 条目 | 触发词 |')
    out.push('|---|---|')
    for (const e of triggered) {
      const kw = [].concat(e.keys || [], e.keywords || []).join('、')
      out.push(`| ${e.name || e.comment || '未命名'} | ${kw || '（语义）'} |`)
    }
    out.push('')
    for (const e of triggered) {
      const kw = [].concat(e.keys || [], e.keywords || []).join('、')
      out.push(`### ${e.name || e.comment || '未命名条目'}`)
      out.push('')
      out.push('> 触发词：' + (kw || '（语义判断）'))
      out.push('')
      out.push(String(e.content || e.text || '').trim())
      out.push('')
    }
  }

  // §4 输出格式契约（检测到状态栏标签才生成）
  if (hasStatusBar) {
    out.push('## 4. 输出格式契约（每楼必须遵守）')
    out.push('')
    out.push('- 正文放 `<maintext></maintext>`；状态栏放 `<Status_block></Status_block>`，位于 `</maintext>` 之后。')
    out.push('- 每楼**最多一个** `<maintext>` 和**一个** `<Status_block>`；无状态栏内容时移除空标签。')
    out.push('- `</maintext>` 之后不许再输出任何角色对话。格式细则以常驻世界书中的格式条目为准。')
    out.push('- 渲染插件在线时 `<Status_block>` 会渲染成美化面板；不在线时显示原始 YAML 块，属正常现象。')
    out.push('')
  }

  // §5 开场白
  out.push('## 5. 开场白（触发本 skill 的首轮回复，原样输出）')
  out.push('')
  out.push('````text')
  out.push(String(card.first || '').trim())
  out.push('````')
  out.push('')
  return out.join('\n')
}

// ── 索引 skill ──────────────────────────────────────────────────────────────
function readIndexCards(skillsDir) {
  const cards = []
  let dirs = []
  try { dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return cards }
  for (const d of dirs) {
    const f = path.join(skillsDir, d, 'SKILL.md')
    let txt = ''
    try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
    // 标记行位于 frontmatter 之后（非文件首行），必须带 m 标志按行首匹配
    const m = /^<!--\s*tavern-card:(.+?)\s*-->/m.exec(txt)
    if (!m) continue
    const dm = /^description:\s*(.+)$/m.exec(txt)
    cards.push({
      cardName: m[1].trim(),
      skillName: d,
      dir: path.join(skillsDir, d),
      desc: dm ? dm[1].trim().slice(0, 120) : ''
    })
  }
  return cards
}

/**
 * 重建卡库索引 skill（tavern-cards）。两级路由的 L1。
 * @param {object} p { skillsDir, unmatchedGroups?: [{name, count}], skippedTotal?: number }
 */
export function rebuildCardIndex({ skillsDir, unmatchedGroups = [] }) {
  // 编译版（tavern-card-* 前缀）优先；同名卡去重——手搓版让位给编译版
  const all = readIndexCards(skillsDir)
    .sort((a, b) => (a.skillName.startsWith('tavern-card-') ? 0 : 1) - (b.skillName.startsWith('tavern-card-') ? 0 : 1))
  const seen = new Set()
  const cards = []
  for (const c of all) {
    if (seen.has(c.cardName)) continue
    seen.add(c.cardName)
    cards.push(c)
  }
  const out = []
  out.push('---')
  out.push('name: tavern-cards')
  out.push('description: 酒馆卡库索引 —— 当前已编译的角色卡清单与进入路由。当用户想进卡聊天、玩角色卡、问"有哪些卡"时使用。')
  out.push('whenToUse: 用户提出进入/切换角色卡聊天、或询问卡库清单时。')
  out.push('---')
  out.push('')
  out.push('# 酒馆卡库索引')
  out.push('')
  out.push('| 卡名 | Skill 目录 | 说明 |')
  out.push('|---|---|---|')
  for (const c of cards) out.push(`| ${c.cardName} | \`${c.dir}\` | ${c.desc} |`)
  out.push('')
  out.push('## 路由规则')
  out.push('')
  out.push('1. 用户**点名某张卡** → 用 Read 工具读取对应目录的 `SKILL.md` 全文，严格按其中「§1 你的任务」进入角色扮演（首轮输出其开场白）。')
  out.push('2. 用户**没点名**（如"进卡""玩卡"）→ 把上表卡名报给用户让其选，不要擅自替用户选卡。')
  out.push('3. 对局进行中**不切换卡**；用户明确要求换卡才重新路由。')
  out.push('4. 卡的 skill 是自包含环境：人设/世界观/格式/开场白全在 SKILL.md 里，不需要酒馆插件注入。')
  if (unmatchedGroups.length) {
    out.push('')
    out.push('## 未编译分组（面板世界书中存在，但未匹配到任何卡）')
    out.push('')
    for (const g of unmatchedGroups) out.push(`- ${g.name}（${g.count} 条）— 未随卡编译；如需纳入请在面板中把组名与卡名对齐后重新保存`)
  }
  const idxDir = path.join(skillsDir, 'tavern-cards')
  fs.mkdirSync(idxDir, { recursive: true })
  fs.writeFileSync(path.join(idxDir, 'SKILL.md'), out.join('\n'), 'utf8')
  return { ok: true, indexDir: idxDir, cards: cards.map(c => c.cardName) }
}

// ── 主编译入口 ──────────────────────────────────────────────────────────────
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/**
 * 编译一个预设下全部 enabled 卡 → skills 目录。
 * @param {object} p { presetDir, presetName, presetId, skillsDir }
 * @returns {{ ok, cards, unmatchedGroups, skippedTotal, errors }}
 */
export function compilePresetSkills({ presetDir, presetName, presetId, skillsDir }) {
  const result = { ok: true, cards: [], unmatchedGroups: [], skippedTotal: 0, errors: [] }
  const chars = readJson(path.join(presetDir, 'characters.json')) || []
  const wb = readJson(path.join(presetDir, 'worldbooks.json')) || {}
  const groups = Array.isArray(wb.groups) ? wb.groups : []
  const enabledCards = chars.filter(c => c && c.enabled !== false && (c.name || c.first))
  if (!enabledCards.length) { result.ok = false; result.errors.push('预设无启用中的角色卡'); return result }

  const matchedGroupNames = new Set()
  for (const card of enabledCards) {
    const cardName = card.name || '未命名卡'
    const skipped = []
    const owned = []
    for (const g of groups) {
      if (!groupMatchesCard(g.name, cardName)) continue
      matchedGroupNames.add(g.name)
      for (const e of (g.entries || [])) {
        if (e.enabled === false) continue
        const scan = scanCompliance((e.name || '') + '\n' + (e.content || e.text || ''))
        if (scan.block) { skipped.push({ group: g.name, entry: e.name || e.comment || '未命名', reason: scan.reasons.join('；') }); continue }
        owned.push(e)
      }
    }
    // 开场白/简介级合规：命中整卡跳过（罕见，但 first 带硬线内容时必须拦）
    const cardScan = scanCompliance((card.desc || '') + '\n' + (card.first || ''))
    if (cardScan.block) {
      result.cards.push({ name: cardName, slug: null, dir: null, skipped: true, reason: cardScan.reasons.join('；') })
      result.skippedTotal += skipped.length
      continue
    }
    const slug = 'tavern-card-' + slugifyCardName(cardName, presetId)
    const cardOut = { ...card, __slug: slug }
    const md = buildCardSkill({ card: cardOut, presetName: presetName || presetId, entries: owned, skipped })
    const dir = path.join(skillsDir, slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8')
    // 编译元信息（供排查/判断"配置变了没"）
    const srcHash = createHash('sha1')
      .update(JSON.stringify([card, owned.map(e => [e.name, e.content])]))
      .digest('hex').slice(0, 12)
    fs.writeFileSync(path.join(dir, '.compile-meta.json'), JSON.stringify({
      presetId, presetName: presetName || presetId, cardName, at: new Date().toISOString(), srcHash, skipped
    }, null, 2), 'utf8')
    result.cards.push({ name: cardName, slug, dir, resident: owned.filter(e => !(e.keys || []).length && !(e.keywords || []).length).length, trigger: owned.filter(e => (e.keys || []).length || (e.keywords || []).length).length, skipped })
    result.skippedTotal += skipped.length
  }

  result.unmatchedGroups = groups
    .filter(g => !matchedGroupNames.has(g.name))
    .map(g => ({ name: g.name, count: (g.entries || []).filter(e => e.enabled !== false).length }))

  try { rebuildCardIndex({ skillsDir, unmatchedGroups: result.unmatchedGroups }) } catch (e) {
    result.errors.push('索引重建失败: ' + e.message)
  }
  return result
}
