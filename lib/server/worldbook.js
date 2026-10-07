// 世界书：统一格式（v2）+ 条目选择（SillyTavern 语义）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { STAGE_RE } from './constants.js'

function legacyInjectMode(list) {
  const vals = (Array.isArray(list) ? list : [])
    .map(wb => (wb && typeof wb === 'object') ? wb.injectMode : undefined)
    .filter(v => v === 'keyword' || v === 'full')
  if (!vals.length) return 'full'
  return vals.every(v => v === 'keyword') ? 'keyword' : 'full'
}

function normalizeWorldbookData(d) {
  if (Array.isArray(d)) {
    // 旧数组格式：[{ name, entries, enabled }] 或扁平条目数组
    const looksLikeWorldbooks = d.some(wb => wb && Array.isArray(wb.entries))
    if (looksLikeWorldbooks) {
      const groups = d
        .filter(wb => wb && Array.isArray(wb.entries))
        .map(wb => ({
          name: wb.name || wb.title || wb.comment || '未命名世界书',
          enabled: wb.enabled !== false,
          entries: Array.isArray(wb.entries) ? wb.entries : []
        }))
        .filter(g => g.entries.length > 0) // 过滤空分组
      return { injectMode: legacyInjectMode(d), groups }
    }
    // 扁平条目数组：[entry, entry] —— 直接作为条目返回，不创建分组
    return { injectMode: legacyInjectMode(d), groups: [{ name: '导入条目', enabled: true, entries: d }] }
  }
  if (!d || typeof d !== 'object') return { injectMode: 'full', groups: [] }
  let groups = Array.isArray(d.groups) ? d.groups : []
  if (!groups.length && Array.isArray(d.entries)) {
    groups = [{ name: '导入条目', enabled: true, entries: d.entries }]
  }
  const result = {
    injectMode: d.injectMode === 'keyword' ? 'keyword' : 'full',
    groups: groups
      .map(g => ({
        name: (g && (g.name || g.title || g.comment)) || '未命名世界书',
        enabled: !g || g.enabled !== false,
        entries: g && Array.isArray(g.entries) ? g.entries : []
      }))
      .filter(g => g.entries.length > 0) // 过滤空分组
  }
  return result
}

function worldbookToApi(norm) {
  const entries = []
  for (const g of norm.groups || []) {
    for (const e of g.entries || []) entries.push(e)
  }
  return { entries, injectMode: norm.injectMode || 'full', groups: norm.groups || [] }
}

/**
 * ★ P2-1 世界书注入「是否全量」的唯一判定（共享函数）：
 *   ① **会话级覆盖**（state.wbInjectBySession[sessionId]）优先级最高：
 *      'full' = 这一场强制全量；'follow' = 这一场忽略全局全量、老实跟随卡设定；
 *   ② state.wbInject === 'full' → 用户在面板开的全局逃生阀（对所有会话生效）；
 *   ③ 否则跟随世界书自己的 injectMode（groups 展平保留顶层模式，见 normalizeWorldbookData）。
 * 注入点（tavern:card 组装）与体积统计点（/api/tavern/prompt-stats）必须走这一个函数，
 * 保证同一轮里两处口径一致，不会一个 full 一个 select。
 *
 * @param {object} state readState()
 * @param {object} wb readWorldbook() 结果（含 injectMode）
 * @param {string} [sessionId] 会话 id；给了才看会话级覆盖
 */
function resolveWbIsFull(state, wb, sessionId) {
  const followCard = !wb || wb.injectMode !== 'keyword'
  const override = (state && sessionId && state.wbInjectBySession)
    ? state.wbInjectBySession[String(sessionId)]
    : undefined
  if (override === 'full') return true
  if (override === 'follow') return followCard
  if (state && state.wbInject === 'full') return true
  return followCard
}

function matchWorldbookEntries(worldbook, recentText) {
  const hits = []
  const haystack = String(recentText || '').toLowerCase()
  const isFull = worldbook.injectMode === 'full'
  for (const entry of worldbook.entries) {
    if (entry.enabled === false) continue
    if (isFull) { hits.push(entry); continue }
    // ★ P2-1：keys ∪ keywords 并集匹配（与 entryKeys / utils.js 对齐）
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

/** 取关键词字段的并集（P2-1）：ST 的 lorebook 主字段是 keys，但很多卡同时写 keys 和
 *  keywords（两边各写一半的情况真实存在），旧实现「取第一个非空字段」会漏掉另一半。
 *  并集去重按大小写不敏感比较（与匹配语义一致）；`[]` 是 truthy，不能用 `a || b`。 */
function entryKeys(e) {
  const out = []
  const seen = new Set()
  for (const f of ['keys', 'keywords', 'key']) {
    const v = e && e[f]
    const arr = Array.isArray(v) ? v.filter(Boolean).map(String)
      : (typeof v === 'string' && v.trim() ? [v.trim()] : [])
    for (const k of arr) {
      const lk = k.toLowerCase()
      if (seen.has(lk)) continue
      seen.add(lk)
      out.push(k)
    }
  }
  return out
}

/** 副关键词：全部命中才算匹配（ST 的 keysecondary + selective AND 语义）。 */
function entrySecondaryKeys(e) {
  const out = []
  for (const f of ['secondary_keys', 'keysecondary']) {
    const v = e && e[f]
    if (Array.isArray(v)) out.push(...v.filter(Boolean).map(String))
    else if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

/**
 * 解析 ST 世界书里「分阶段人设」条目的 EJS 阈值。
 * 形如：
 *   var xilianAffection = getvar('stat_data.昔涟.好感度[0]') || 0;
 *   if (xilianAffection > 90) { ... getwi(null, '昔涟_阶段04_唯一的专属者') }
 *   } else if (xilianAffection > 60) { ... getwi(null, '昔涟_阶段03_情感的流露者') }
 *   } else { ... getwi(null, '昔涟_阶段01_玩乐的掌控者') }
 * @returns {Map<string, {min:number, charName:string}>} 条目名 -> 生效阈值与该条目所属角色
 */
function parseStagePlans(entries) {
  const plans = new Map()
  for (const e of entries) {
    const c = String(e.content || e.text || '')
    if (!c.includes('<%') || !c.includes('getwi')) continue
    // 变量名 -> 角色名（取好感度用）
    const varToChar = new Map()
    const varRe = /var\s+([A-Za-z_$][\w$]*)\s*=\s*getvar\(\s*['"]stat_data\.([^.'"]+)\.好感度\[0\]['"]/g
    let vm
    while ((vm = varRe.exec(c)) !== null) varToChar.set(vm[1], vm[2])
    const fallbackChar = [...varToChar.values()][0] || ''
    // 逐条 getwi 语句往前找最近的 if/else if 条件
    const gwRe = /getwi\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g
    let gm
    while ((gm = gwRe.exec(c)) !== null) {
      const name = gm[1]
      const head = c.slice(0, gm.index)
      let min = 0
      let charName = fallbackChar
      // 从后往前找最近的 if (var > N) 或裸 else —— 裸 else 代表兜底档（阈值为 0）
      const condRe = /(?:else\s+)?if\s*\(\s*([A-Za-z_$][\w$]*)\s*>\s*(\d+)\s*\)|else\s*\{/g
      let cm
      let best = null
      while ((cm = condRe.exec(head)) !== null) best = cm
      if (best && best[1] !== undefined) { min = Number(best[2]); charName = varToChar.get(best[1]) || charName }
      else { min = 0 }
      plans.set(name, { min, charName })
    }
  }
  return plans
}

/** 从最近消息里读某个角色的最新好感度；找不到返回 null。 */
function latestAffection(recentText, charName) {
  if (!recentText || !charName) return null
  const esc = String(charName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + '\\.好感度\\[0\\]\\D{0,16}?(-?\\d+)', 'g')
  let m
  let last = null
  while ((m = re.exec(recentText)) !== null) last = Number(m[1])
  return last === null ? null : last
}

/**
 * 按 ST 语义挑出本轮要注入的世界书条目。
 * @param {Array} allEntries 已按 enabled/disable 过滤的条目
 * @param {string} recentText 最近消息拼成的文本（关键词扫描范围）
 * @param {boolean} isFull 分组 injectMode=full 时全部注入
 * @returns {{injectEntries: Array, stats: object}}
 */
function selectWorldbookEntries(allEntries, recentText, isFull) {
  const stats = { const: 0, matched: 0, keyword: 0, stage: 0, stageSkipped: 0, ejs: 0, disabled: 0 }
  const plans = parseStagePlans(allEntries)
  const stageGroups = new Map()   // 角色/前缀 -> 候选阶段条目
  const pool = []                 // 常规条目

  for (const e of allEntries) {
    const c = String(e.content || e.text || '')
    const label = String(e.comment || e.name || '')
    const stage = STAGE_RE.exec(label)
    const inPlan = plans.has(label)
    const on = e.enabled !== false
    if (c.includes('<%')) {
      // EJS 模板：只用来提供阈值，本身绝不注入
      stats.ejs++
      if (stage) {
        const key = stage[1]
        if (!stageGroups.has(key)) stageGroups.set(key, [])
        stageGroups.get(key).push(e)
      }
      continue
    }
    // 被 EJS getwi() 引用的条目 —— ST 里 getwi 可以把「禁用」条目拉进来，
    // 分阶段人设正是这么用的（阶段条目通常 enabled:false，由 EJS 按好感度选择）。
    // 这里等价处理：进入候选组，等下面按好感度挑一条。
    if (inPlan) {
      const key = stage ? stage[1] : label
      if (!stageGroups.has(key)) stageGroups.set(key, [])
      stageGroups.get(key).push(e)
      continue
    }
    if (!on) { stats.disabled++; continue }
    pool.push(e)
  }

  // 阶段互斥：每组只留阈值最高且已达成的那一条
  const stagePicked = []
  for (const [key, list] of stageGroups) {
    const plan = plans.get(String(list[0] && (list[0].comment || list[0].name) || '')) || null
    const charName = plan?.charName || ''
    const aff = latestAffection(recentText, charName)
    let picked = null
    let pickedMin = -1
    for (const e of list) {
      const p = plans.get(String(e.comment || e.name || ''))
      const min = p ? p.min : 0
      if (aff === null) { if (min === 0 && picked === null) picked = e; continue }
      if (aff >= min && min > pickedMin) { picked = e; pickedMin = min }
    }
    if (!picked) {
      const byName = list.slice().sort((a, b) => STAGE_RE.exec(a.comment || a.name)[2] - STAGE_RE.exec(b.comment || b.name)[2])
      picked = byName[0]
    }
    if (picked) { stagePicked.push(picked); stats.stage++ }
    stats.stageSkipped += list.length - 1
    void key
  }

  const consts = []
  const kws = []
  for (const e of pool) {
    const keys = entryKeys(e)
    if (e.constant === true || keys.length === 0) consts.push(e)
    else kws.push(e)
  }
  stats.const = consts.length
  stats.keyword = kws.length

  // ★ P2-1 manifest 取证：每个入选条目记 { name, reason, chars }。
  //   铁律：只记条目名 / 命中原因 / 字符数，**绝不记条目正文**（正文进日志就是泄露）。
  const reasonOf = new Map()
  for (const e of consts) reasonOf.set(e, 'const')

  // full 模式＝全部条目都注入，但阶段条目仍保持互斥（每角色只出当前档那一条）
  let hits = isFull ? [...consts, ...kws, ...stagePicked] : [...consts, ...stagePicked]
  if (isFull) {
    for (const e of kws) reasonOf.set(e, 'full')
  } else {
    const hay = String(recentText || '')
    const hayLower = hay.toLowerCase()
    for (const e of kws) {
      const keys = entryKeys(e)
      const sec = entrySecondaryKeys(e)
      const caseSensitive = e.caseSensitive === true
      const whole = e.matchWholeWords === true
      const test = (k) => {
        const needle = caseSensitive ? String(k) : String(k).toLowerCase()
        const haystack = caseSensitive ? hay : hayLower
        if (!needle) return false
        if (!whole) return haystack.includes(needle)
        return new RegExp('(^|\\W)' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\W|$)').test(haystack)
      }
      if (!keys.some(test)) continue
      if (sec.length && !sec.every(test)) continue          // 副关键词 AND
      if (typeof e.probability === 'number' && e.probability < 100) {
        if (Math.random() * 100 >= Math.max(0, e.probability)) continue
      }
      hits.push(e)
      reasonOf.set(e, 'matched')
      stats.matched++
    }
  }
  for (const e of stagePicked) reasonOf.set(e, 'stage')
  // ST 的 order：升序注入；未声明的保持原顺序
  hits = hits.map((e, i) => [e, i]).sort((a, b) => {
    const oa = typeof a[0].order === 'number' ? a[0].order : 100
    const ob = typeof b[0].order === 'number' ? b[0].order : 100
    return oa - ob || a[1] - b[1]
  }).map(p => p[0])
  // ★ P2-1：按最终注入顺序生成入选清单（名字 / 命中原因 / 字符数 —— 不含正文）
  const picks = hits.map((e) => ({
    name: String(e.comment || e.name || '未命名条目'),
    reason: reasonOf.get(e) || 'full',
    chars: String(e.content || e.text || '').length,
  }))
  return { injectEntries: hits, stats, picks }
}

export { entryKeys, entrySecondaryKeys, parseStagePlans, latestAffection, selectWorldbookEntries, legacyInjectMode, normalizeWorldbookData, worldbookToApi, resolveWbIsFull, matchWorldbookEntries }
