// 预设：组合文本判据（S2-C 从 apply 抽出装配逻辑后会继续扩充）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { BLANK_PRESET_SKELETON } from './constants.js'
import { normalizeYmlForCompare } from './util.js'

/**
 * 这份组合是不是「新建但还没保存」的空骨架？
 * @param {string} agentYml agent.cordis.yml 原文
 * @returns {boolean}
 */
function isBlankPresetComposition(agentYml) {
  const s = String(agentYml == null ? '' : agentYml)
  if (!s.trim()) return true
  return normalizeYmlForCompare(s) === normalizeYmlForCompare(BLANK_PRESET_SKELETON)
}

export { isBlankPresetComposition }
