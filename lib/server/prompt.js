// 提示词预算与注入生效范围闸门
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { CHARS_PER_TOKEN, DEFAULT_WINDOW_TOKENS } from './constants.js'

/**
 * 估算提示词体积并给出告警等级。纯函数，无副作用。
 * @param {number} chars 本轮注入的字符数
 * @param {number} windowTokens 上下文窗口（token）
 * @returns {{chars: number, tokens: number, ratio: number, pct: number, level: 'ok'|'warn'|'danger'}}
 */
function estimatePromptBudget(chars, windowTokens) {
  const n = Number.isFinite(Number(chars)) && Number(chars) > 0 ? Number(chars) : 0
  const w = Number.isFinite(Number(windowTokens)) && Number(windowTokens) > 0
    ? Number(windowTokens)
    : DEFAULT_WINDOW_TOKENS
  const tokens = Math.round(n / CHARS_PER_TOKEN)
  const ratio = tokens / w
  // 60% 起警告（对话历史没地方长了），90% 起危险（尾部随时被截断）
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'warn' : 'ok'
  return { chars: n, tokens, ratio, pct: Math.round(ratio * 1000) / 10, level }
}

/**
 * 判定本轮要不要往这条会话注入（tavern:card 段的生效范围闸门）。
 *
 * @param {object} state readState() 的结果
 * @param {string} sid 会话 id
 * @param {string} cwdKey 工作目录（已去掉末尾分隔符；取不到时为空串）
 * @returns {{allowed:boolean, allowedBySession:boolean, allowedByCwd:boolean}}
 */
function decideInjectionScope(state, sid, cwdKey) {
  const norm = (d) => String(d || '').trim().replace(/[\\/]+$/, '')
  const inCwdList = (arr) => cwdKey ? (arr || []).some(d => norm(d) === cwdKey) : false
  const inSessionList = (arr) => sid ? (arr || []).some(s => String(s) === String(sid)) : false
  const st = state || {}
  if (st.mode === 'global') {
    // 显式全放行：两个标记保持 false —— 与改动前逐字一致（观测日志照旧记 allowedBy:'none'）
    return { allowed: true, allowedBySession: false, allowedByCwd: false }
  }
  // allowlist 模式
  const sessions = Array.isArray(st.allowSessions) ? st.allowSessions : []
  const cwds = Array.isArray(st.allowCwds) ? st.allowCwds : []
  if (sessions.length === 0 && cwds.length === 0) {
    // ★ P0-5：空名单 = 谁都不放行（旧行为是「不限制」⇒ 默认状态全量注入）。
    return { allowed: false, allowedBySession: false, allowedByCwd: false }
  }
  // 部分为空时逐项判定：sessionId 或 cwd 任一命中即放行
  const allowedBySession = inSessionList(sessions)
  const allowedByCwd = inCwdList(cwds)
  return { allowed: allowedBySession || allowedByCwd, allowedBySession, allowedByCwd }
}

export { decideInjectionScope, estimatePromptBudget }
