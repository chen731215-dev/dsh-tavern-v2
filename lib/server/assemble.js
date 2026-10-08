// tavern:card 段正文的拼装（S2-C2 第 1 步：先只搬「纯拼接」）
//
// 为什么先只搬这一层：`sanitizePromptText(summaryText + header + …)` 这一行是整段组装的**出口**，
// 单独挪进本模块可以得到一次「字节级等价显然成立、且完全不碰切片锚点」的搬运 —— 先用它把
// 「新模块 + golden 逐字节 + 全套绿」这条通路打通，各部件的**计算**在下一步才搬。
//
// ★ 依赖全部由参数显式传入，本文件**不** import lib/index.js —— AGENTS.md §5 第 5 条（禁止循环依赖）。
// ★ `★ 记忆总结注入` 块 / `tavern:nsfw` 注册段 / `flushPromptStats()` / `sectionSizes.nsfw`
//   一律留在 lib/index.js：它们是切片锚点（AGENTS.md §5.1）。
//
// 真源规范见仓库根目录 AGENTS.md §5。

/**
 * 把各注入段按固定顺序拼成 `tavern:card` 的正文，并做提示词净化。
 *
 * ⚠️ 顺序即产物顺序，**不要重排**：tests/golden-host-assembly.test.js 对产物逐字节比对。
 *
 * @param {object} parts 各段正文 + 净化函数（全部由 lib/index.js 算好后传入）
 * @param {string} parts.summaryText 记忆总结段（由 index.js 的锚点块算出，可为 ''）
 * @param {string} parts.header 角色卡注入抬头（creative / roleplay 两种）
 * @param {string} parts.text 角色卡正文（已过 cleanSillyTavernVars）
 * @param {string} parts.wbText 世界书段正文（可为 ''）
 * @param {string} parts.memoryText 会话记忆段
 * @param {string} parts.styleText 反 AI 八股 / 违禁词段
 * @param {string} parts.netText 联网提示段
 * @param {string} parts.toolsRestriction 工具开关段
 * @param {string} parts.relationsText 关系网「软注入」提示（只有计数）
 * @param {string} parts.skillsText 技能「绑定指针」提示
 * @param {Function} parts.sanitizePromptText 提示词净化（宏替换 / 指令剥离）
 * @returns {string} 最终正文
 */
export function assembleCardBody(parts) {
  const {
    summaryText, header, text, wbText, memoryText, styleText, netText,
    toolsRestriction, relationsText, skillsText, sanitizePromptText,
  } = parts
  return sanitizePromptText(summaryText + header + text + (wbText ? '\n\n' + wbText : '') + memoryText + styleText + netText + toolsRestriction + relationsText + skillsText)
}
