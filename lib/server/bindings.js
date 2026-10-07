// 会话绑定：来源分类、活动会话探测、字段归一化
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import { randomUUID, createHash } from 'node:crypto'
import { BINDING_SOURCE_LEGACY, BINDING_SOURCE_PANEL, BINDING_SOURCE_TOP_SELECT, liveAgents } from './constants.js'

/**
 * 把任意历史形态的绑定条目归一化成三态判别联合。纯函数，便于单测。
 *
 * @param {any} raw 旧字符串 / 新对象 / undefined / 垃圾值
 * @returns {{mode:'none'}|{mode:'preset',presetId:string,source:string,at:number,rev:number}|null}
 *          null = 该文件里没有这条会话的绑定（absent）
 */
function normalizeBinding(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.mode === 'none') return { mode: 'none' }
    if (raw.mode === 'preset' && typeof raw.presetId === 'string' && raw.presetId) {
      return {
        mode: 'preset',
        presetId: raw.presetId,
        // 只认两种显式来源；其余（含手写 / 未来新增值）一律降级为 legacy，保守处理。
        source: raw.source === BINDING_SOURCE_PANEL || raw.source === BINDING_SOURCE_TOP_SELECT
          ? raw.source : BINDING_SOURCE_LEGACY,
        at: Number.isFinite(raw.at) ? raw.at : 0,
        rev: Number.isFinite(raw.rev) ? raw.rev : 1,
      }
    }
    // 对象但字段缺失 / 非法 → 非法旧数据：按 legacy 处理（presetId 为空 ⇒ 解析时无从注入）
    return { mode: 'preset', presetId: '', source: BINDING_SOURCE_LEGACY, at: 0, rev: 0 }
  }
  if (typeof raw === 'string' && raw) {
    return { mode: 'preset', presetId: raw, source: BINDING_SOURCE_LEGACY, at: 0, rev: 0 }
  }
  return null
}

/** 观测日志用的绑定形态标签：preset / none / legacy / absent。 */
function bindingModeOf(bound) {
  const b = normalizeBinding(bound)
  if (!b) return 'absent'
  if (b.mode === 'none') return 'none'
  return b.source === BINDING_SOURCE_LEGACY ? 'legacy' : 'preset'
}

/** 内容指纹：sha256 前 16 位。只用于「内容变没变」的对账，不含正文。 */
function contentHash16(text) {
  try {
    return createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16)
  } catch { return '' }
}

/**
 * 「presetId 是从哪条路径决议出来的」—— 与 pickAuthoritativePresetFromLog 的优先级
 * 逐条对齐（explicit > binding > creation > 兜底），区别只是**不返回值、只回标签**。
 *
 * 纯函数、只读，不参与任何决议，仅供观测日志使用（也便于单测）。
 *
 * @param {string|null} explicit 最新一条 agent-preset/selected 事件里的预设
 * @param {string|null} creation 创建记录里的出生默认预设
 * @param {(id: string) => boolean} isTavern 判断是否为酒馆可管理预设
 * @param {any} bound bindings 里的条目（旧字符串 / 新对象 / 无）
 * @returns {'explicit'|'binding'|'binding-invalid'|'legacy'|'unbound'|'creation'|'none'} */
function classifyPresetBindingSource(explicit, creation, isTavern, bound) {
  if (explicit) return 'explicit'
  const b = normalizeBinding(bound)
  if (b) {
    if (b.mode === 'none') return 'unbound'
    if (b.source !== BINDING_SOURCE_LEGACY) {
      if (!isTavern(b.presetId)) return 'binding-invalid'
      return 'binding'
    }
    // legacy 视为未绑定 ⇒ 让位给出生默认；只有真的无路可走时才如实报 'legacy'
    // （否则日志会说「来源是 legacy」而决议其实是 creation，两边对不上账）。
    if (creation && isTavern(creation)) return 'creation'
    return 'legacy'
  }
  if (creation && isTavern(creation)) return 'creation'
  return 'none'
}

/**
 * 从 cordis ctx 安全取服务。
 *
 * ⚠️ 不能裸读 `ctx.agentPresets`：Cordis 对**未声明 inject** 的服务属性取值即抛。
 * 必须走 `ctx.get(name)`，拿不到就返回 undefined，由调用方 fail closed ——
 * 旧版 DSH 没有该服务时，插件不能因此挂掉。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} name 服务名
 * @returns {any|undefined}
 */
function getCtxService(ctx, name) {
  try {
    const v = ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (v) return v
  } catch {}
  try { const v = ctx ? ctx[name] : undefined; if (v) return v } catch {}
  return undefined
}

/**
 * 找会话当前活跃的 Agent。
 *
 * 优先用插件自己登记的 `liveAgents`（`agent/created` 时写入，**早于任何用户消息**，
 * 空白新会话也有），再退到 DSH 的 `agents` 服务。找不到就返回 null —— 由调用方
 * 明确报 no-live-agent，绝不去猜。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} sessionId 会话 id
 * @returns {object|null} Agent
 */
function findLiveAgent(ctx, sessionId) {
  if (!sessionId) return null
  try { const a = liveAgents.get(sessionId); if (a) return a } catch {}
  try {
    const agents = getCtxService(ctx, 'agents')
    if (agents && typeof agents.get === 'function') return agents.get(sessionId) || null
  } catch {}
  return null
}

/**
 * 会话是否已经开跑（有过 turn/start 或用户消息）。纯只读，用于给出**准确**的拒绝原因。
 *
 * 只是友好提示层：真正的闸门在 DSH 的 `agentPresets.select` 里（它按 turnBoundary 判），
 * 这里绝不代替它做决定。
 *
 * @param {object|null} agent Agent
 * @returns {boolean}
 */
function hasTurnStarted(agent) {
  try {
    const log = agent && agent.session && agent.session.log
    if (!Array.isArray(log)) return false
    for (const ev of log) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'turn/start' || ev.type === 'user/message') return true
    }
  } catch {}
  return false
}

/**
 * 会话是否已经开跑 —— **优先用 DSH 自己的判据**（`turnBoundary` 投影），退回日志启发式。
 *
 * 为什么不用日志就完事：DSH 的闸门是
 *   `boundary.openTurnStartSeq !== null || boundary.lastTurn > 0`
 * （见 dsh-agent-loop 的 turnBoundary 定义）。日志启发式（找 turn/start、user/message）
 * 在日志被裁剪、会话是 resume/import 进来的时候可能看不全 —— 于是面板会把
 * 「其实已经锁死」的会话说成「可以绑定」。这只是提示层（真正的闸门在 DSH 那边），
 * 但提示错了就是编造状态，所以这里跟 DSH 对齐。
 *
 * @param {object} ctx cordis 上下文
 * @param {object|null} agent Agent
 * @returns {boolean}
 */
function nativeTurnStarted(ctx, agent) {
  try {
    const projections = getCtxService(ctx, 'sessionProjections')
    const session = agent && agent.session
    if (projections && typeof projections.stateOf === 'function' && session) {
      const b = projections.stateOf(session, 'turnBoundary')
      if (b && typeof b === 'object') {
        return b.openTurnStartSeq !== null && b.openTurnStartSeq !== undefined ? true : Number(b.lastTurn || 0) > 0
      }
    }
  } catch {}
  return hasTurnStarted(agent)   // 投影读不到（旧版 / 未注册）才退回日志启发式
}

/**
 * 直接读 DSH 的**原生投影** `agentPreset`（该会话当前选中的 agent 预设）。
 *
 * 为什么需要它：酒馆此前唯一的权威来源是解析会话 zstd 日志（findSessionFile），而
 * **尚未落盘 / 还没写过日志的会话查不到文件** ⇒ 那一路会静默退回 bindings 或 default。
 * DSH 自己（dsh-api-session-controller 的 presetForSession）用的是投影：
 *   `ctx.sessionProjections.stateOf(ctx.sessions.get(id), 'agentPreset')`
 * 它由 header 播种、被 `agent-preset/selected` 事件更新 —— 与日志同源，但**不依赖落盘**。
 *
 * 只读、永不抛：服务缺失/会话不在内存时返回空串，调用方按既有优先级继续兜底。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} sessionId 会话 id
 * @returns {string} agent 预设 id；读不到返回空串
 */
function nativeAgentPresetOf(ctx, sessionId) {
  if (!sessionId) return ''
  try {
    const projections = getCtxService(ctx, 'sessionProjections')
    const sessions = getCtxService(ctx, 'sessions')
    if (!projections || typeof projections.stateOf !== 'function') return ''
    if (!sessions || typeof sessions.get !== 'function') return ''
    const session = sessions.get(sessionId)
    if (!session) return ''
    const v = projections.stateOf(session, 'agentPreset')
    return typeof v === 'string' ? v : ''
  } catch { return '' }
}

/** 从会话对象取 id（兼容 id 直接挂根上 / 挂 header 两种形态）。 */
function sessionIdOf(session) {
  try { return String((session && (session.id || (session.header && session.header.id))) || '') } catch { return '' }
}

/** 登记 agent/session（手动注入 API 的活会话注册表，只增不改不删——进程内会话数有限）。 */
function trackLiveSession(agent) {
  try {
    const sid = sessionIdOf(agent && agent.session)
    if (sid && agent) liveAgents.set(sid, agent)
  } catch {}
}

export { classifyPresetBindingSource, findLiveAgent, getCtxService, bindingModeOf, trackLiveSession, contentHash16, nativeAgentPresetOf, nativeTurnStarted, hasTurnStarted, normalizeBinding, sessionIdOf }
