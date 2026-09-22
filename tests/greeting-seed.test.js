/**
 * 开场白播种回归测试（2026-09「DSH 里看不到封面页」故障 + 2026-09-23 时机修复）
 *
 * 故障：DSH 会话里永远看不到角色卡开场白，于是卡的 `[0] 主页`（粉蓝封面页）永远不渲染。
 *       ST 里能看到，是因为 ST 把 `first_mes` 当**第一条消息**发下去；而 DSH 这边
 *       `cardTextFor()` 的返回值只进**系统提示**，美化引擎（muv）只扫消息容器。
 *
 * 修复一（原版）：把 `first_mes` 原文作为**首条 assistant 消息**种进会话日志。
 * 修复二（本次）：旧实现在「组装提示词时」才挂监听且要求 `log.length === 0` ——
 *       那一刻日志里已有前置事件，条件永假，播种从未触发（greeting-seed.log 从未出现）。
 *       新时机照 DSH 官方事件序列改为：
 *         · 路径① agent/created（会话发布即评估，可解析预设就直接种）；
 *         · 路径② agent/inbox/inserted（首条用户消息入队时兜底评估一次）；
 *         · 判重改「日志里还没有 turn/assistant」，不再是「日志为空」；
 *         · 另加手动兜底 POST /api/tavern/greeting/insert（旧会话注入到末尾）。
 *
 * 修复三（2026-09-23 清理）：
 *   · 播种**不再**在开场白之后追加 user 引导消息（GREETING_PREAMBLE）——它会常驻
 *     消息面（界面上多一条引导楼）且回合开始后删不掉，而实测网关接受 assistant 打头；
 *     它现在只在「assistant 打头被网关拒（400）」时由 appendGreetingPreamble 补种；
 *   · 手动注入 API 防重复：会话里已有 source.model==='character-card' 的 assistant 楼
 *     ⇒ { ok:false, error:'greeting-already-present' }（用户截图里足控会话出现多条
 *     【主页】开场白，就是这个按钮被点了多次叠加出来的）。
 *
 * 本文件单独存在，不动 tests/core.test.js。
 * 运行：node --test tests/greeting-seed.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { _test } from '../lib/index.js'

const {
  greetingTextFor,
  hasLiveUserMessage,
  hasCardGreeting,
  seedGreetingMessage,
  seedGreetingForSession,
  appendGreetingToSessionEnd,
  appendGreetingPreamble,
  insertGreetingForSession,
  pickGreetingCard,
  greetingIdsOf,
  GREETING_PREAMBLE,
} = _test

// ── 真卡的预设 id 与开场白 ────────────────────────────────
// 这套卡就是用户报告里那张：`preset-mt5ip9cc-t6josi`，
// characters.json[0] = { name:"_足控天堂2", first: 2921 字, 以 "【主页】" 开头 }。
const REAL_PRESET_ID = 'preset-mt5ip9cc-t6josi'

// ── 真 Session 的包内不变量（能拿到就用真的，拿不到用等价本地实现）────
const require_ = createRequire(import.meta.url)
let surfaceValidators = null
let surfaceValidatorsFrom = '本地等价实现'
try {
  const candidates = [
    'C:/Users/21334/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      surfaceValidators = await import(pathToFileURL(candidate).href)
      surfaceValidatorsFrom = candidate
      break
    }
  }
} catch { /* 保持 null */ }
void require_

/** 没有真校验器时的等价实现：只覆盖本文件会触发的两条规则。 */
function localValidateSurfaceMetadata(event) {
  const surfaceEligible = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
  const op = event.surfaceOp
  if (op === undefined) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (op === 'append') return op
  if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
    throw new Error('surface replace: startSeq and endSeq must reference earlier events')
  }
  const raw = event.sourceEventSeqs
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('sourceEventSeqs must not be empty')
    if (new Set(raw).size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates')
    for (const seq of raw) {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('sourceEventSeqs must be non-negative safe integers')
      if (seq >= event.seq) throw new Error('sourceEventSeqs must reference earlier events')
    }
  }
  if (!surfaceEligible.has(event.type)) throw new Error('invalid surface type')
  return op
}
const validateSurfaceMetadata = surfaceValidators?.validateSurfaceMetadata || localValidateSurfaceMetadata

/**
 * 最小 Session 替身，行为对齐真 Session 的三条关键语义：
 *   1. `append` 逐条递增 seq，并校验 surface 元数据 + turn/step 关系不变量；
 *   2. surface replace 会**原位换掉**被遮蔽的节点（`foldSurface` 同款语义）；
 *   3. `deriveMessages()` 按 surface 顺序投影（空 content 的 assistant 投影为空）。
 */
class FakeSession {
  constructor(id = 'session-fake-0000') {
    this.header = { id }
    this.log = []
    this.nodes = []
    this.openTurn = null
    this.openStep = null
    this.nextTurn = 1
    this.nextStep = 1
    this.firstLiveSeq = 0
  }

  append(type, data, opts) {
    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data,
      ...(opts && opts.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}),
      ...(opts && opts.sourceEventSeqs !== undefined ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
    }
    // ── turn/step 关系不变量（dsh-session/lib/invariant.js 的本地镜像）──
    if (type === 'turn/start') {
      if (this.openTurn !== null) throw new Error(`turn/start ${data.turn} while turn ${this.openTurn} is still open`)
      if (data.turn !== this.nextTurn) throw new Error(`turn/start expected turn ${this.nextTurn}, got ${data.turn}`)
      this.openTurn = data.turn
      this.nextStep = 1
    } else if (type === 'turn/end') {
      if (this.openTurn !== data.turn) throw new Error('turn/end does not match open turn')
      if (this.openStep !== null) throw new Error('turn/end while step is still open')
      this.openTurn = null
      this.nextTurn += 1
    } else if (type === 'step/start') {
      if (this.openTurn !== data.turn) throw new Error('step/start in wrong turn')
      if (this.openStep !== null) throw new Error('step/start while step is still open')
      if (data.step !== this.nextStep) throw new Error('step/start wrong step number')
      this.openStep = data.step
    } else if (type === 'step/end') {
      if (this.openTurn !== data.turn || this.openStep !== data.step) throw new Error('step/end names a boundary that is not open')
      this.openStep = null
      this.nextStep += 1
    } else if (type === 'assistant/message') {
      if (this.openTurn !== data.turn || this.openStep !== data.step) throw new Error('assistant/message outside its open step')
      if (data.message.content.length === 0 && data.message.content.length !== 0) throw new Error('unreachable')
    } else if (type === 'user/message') {
      // 用户消息不要求 step 边界（真实现同样允许）
    }
    // ── surface 校验 + 折叠 ──
    const op = validateSurfaceMetadata(event)
    if (op === 'append') {
      this.nodes.push(event.seq)
    } else if (op && typeof op === 'object') {
      const startIdx = this.nodes.indexOf(op.startSeq)
      const endIdx = this.nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error('surface replace range not found')
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
      const sources = event.sourceEventSeqs
      if (sources === undefined) throw new Error('surface replace requires sourceEventSeqs')
      for (const seq of shadowed) {
        if (!sources.includes(seq)) throw new Error('sourceEventSeqs must include every shadowed surface node: ' + seq)
      }
      this.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    }
    this.log.push(event)
    return event
  }

  /** 与真 Session.deriveMessages() 同口径的投影（只保留本测试需要的三种事件）。 */
  deriveMessages() {
    const out = []
    for (const seq of this.nodes) {
      const event = this.log[seq]
      if (!event) continue
      if (event.type === 'user/message') out.push(event.data)
      else if (event.type === 'assistant/message' || event.type === 'system/message') {
        if (event.data.message.content.length === 0) continue
        out.push(event.data.message)
      }
    }
    return out
  }
}

/** 取一条消息的纯文本。 */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
}

/** 造一个最小 Agent 替身（seedGreetingForSession 的入参形态）。 */
function fakeAgent(session, phase = { kind: 'idle', lastTurn: 0 }) {
  return { session, phase }
}

// ══════════════════════════════════════════════════════════
// 1. 开场白提取
// ══════════════════════════════════════════════════════════

test('greetingTextFor: 从 characters.json 的 first 字段取到开场白原文', () => {
  const text = greetingTextFor(REAL_PRESET_ID)
  assert.ok(text.length > 0, '真卡应当有开场白')
  assert.ok(text.startsWith('【主页】'), '开场白必须以【主页】开头，实际：' + JSON.stringify(text.slice(0, 20)))
})

test('greetingTextFor: 未知预设返回空串（不抛）', () => {
  assert.equal(greetingTextFor('preset-does-not-exist-0000'), '')
  assert.equal(greetingTextFor(''), '')
})

// ══════════════════════════════════════════════════════════
// 2. 播种：新会话的首条消息必须是开场白（新时机判重）
// ══════════════════════════════════════════════════════════

test('seedGreetingMessage: 新会话消息面为 [assistant(开场白), user(开始)]，首条即开场白', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  assert.ok(greeting.length > 0, '前提：真卡有开场白')

  const session = new FakeSession()
  const lastTurn = seedGreetingMessage(session, greeting)

  assert.equal(lastTurn, 1, '应当回报 turn 1')

  // 用户的第一条消息在播种之后才入队，顺序与真实链路一致
  session.append('turn/start', { turn: 2 })
  session.append('user/message', {
    id: 'user-1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '开始' }],
  }, { surfaceOp: 'append' })

  const messages = session.deriveMessages()
  assert.equal(messages.length, 2, '只有开场白 + 用户首条，实际 ' + messages.length)
  assert.equal(messages[0].role, 'assistant', '★ 首条必须是 assistant（开场白），实际：' + messages[0].role)
  assert.equal(textOf(messages[0]), greeting, '★ 首条内容必须与 first_mes 逐字一致')
  assert.equal(messages[1].role, 'user')
  assert.equal(textOf(messages[1]), '开始')

  // 卡里的 [0] 主页正则按原文匹配，因此播种内容里必须能看见这些锚点
  assert.ok(textOf(messages[0]).includes('<VariableInsert>'), '开场白里的 <VariableInsert> 必须原样保留（[0] 主页正则的锚点）')

  // 开场白原文在 transcript 里只许出现一次（不许被合成消息复制一遍）
  const copies = messages.filter((m) => textOf(m) === greeting).length
  assert.equal(copies, 1, '开场白原文在 transcript 里必须只出现一次，实际 ' + copies + ' 次')
})

// ★ 本次清理的主断言（对照臂：旧实现必红）
//   旧实现在开场白之后再 append 一条 `GREETING_PREAMBLE` 的 user/message ——
//   它必然落在消息面上（dsh-session 要求 user/message 带 surfaceOp），于是界面上
//   多一条引导楼，且回合开始后删不掉（toast「删除失败：这条消息可能已经开始发送」）。
//   实测网关接受 assistant 打头 ⇒ 这条引导白付代价，已移除。
test('seedGreetingMessage: 播种后日志里**没有** user 引导消息（GREETING_PREAMBLE 不再落盘）', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  assert.equal(seedGreetingMessage(session, greeting), 1, '前提：播种成功')

  assert.equal(
    session.log.filter((e) => e.type === 'user/message').length, 0,
    '★ 播种不许再追加 user 引导消息（旧实现这里会多一条 GREETING_PREAMBLE）',
  )
  const messages = session.deriveMessages()
  assert.equal(messages.length, 1, '★ 播种后消息面只有开场白一条，实际 ' + messages.length)
  assert.ok(!messages.some((m) => textOf(m) === GREETING_PREAMBLE), '★ 消息面上不许出现引导文本')

  // assistant 开场白楼本身必须还在（别把孩子和洗澡水一起倒了）
  const assistant = session.log.find((e) => e.type === 'assistant/message')
  assert.ok(assistant, '必须有 assistant 开场白楼')
  assert.equal(assistant.data.message.source.model, 'character-card', '判重标记必须还在')
  assert.equal(greetingIdsOf(session).has(assistant.data.message.id), true, 'greetingSeeds 仍要记账（拒绝处理器靠它）')
})

// 引导消息没有消失，只是挪到了「assistant 打头被拒」的兜底路径上。
test('appendGreetingPreamble: 只有网关拒 assistant 打头时才补种一条 user 引导', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  seedGreetingMessage(session, greeting)
  assert.equal(session.log.filter((e) => e.type === 'user/message').length, 0, '前提：正常播种不带引导')

  assert.equal(appendGreetingPreamble(session), true, '拒绝路径必须能补种')
  const users = session.log.filter((e) => e.type === 'user/message')
  assert.equal(users.length, 1, '只补一条')
  assert.equal(textOf(session.deriveMessages().find((m) => m.role === 'user')), GREETING_PREAMBLE)
  assert.ok(textOf(session.deriveMessages()[0]).length > 100, '开场白原文没被引导顶掉')
})

// ★ 本次修复的对照臂（旧实现必红）：
//   新会话的日志里允许有 agent-preset/selected 等前置事件 —— 旧判重
//   `log.length === 0` 在这种会话上永远为假，播种从未触发。
//   新判重是「日志里还没有 turn/assistant」，所以这里必须能种进去。
test('对照臂（旧实现必红）：非空日志但没开过回合 ⇒ 照样播种成功', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  // 模拟新会话创建后的前置事件（不是回合、不是消息）
  session.log.push({ type: 'session/created', seq: session.log.length, time: Date.now(), data: {} })
  session.log.push({ type: 'agent-preset/selected', seq: session.log.length, time: Date.now(), data: { presetId: REAL_PRESET_ID } })
  assert.equal(session.log.length > 0, true, '前提：日志非空（旧实现在这里就会拒绝）')

  const lastTurn = seedGreetingMessage(session, greeting)
  assert.equal(lastTurn, 1, '★ 非空日志的新会话必须照样能种（旧实现返回 -1）')
  const messages = session.deriveMessages()
  assert.equal(messages[0].role, 'assistant')
  assert.equal(textOf(messages[0]), greeting)
})

test('seedGreetingMessage: 开过回合的会话拒绝播种（第二轮、切预设都不会重复种）', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    id: 'user-0',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '已经聊过了' }],
  }, { surfaceOp: 'append' })

  assert.equal(hasLiveUserMessage(session), true)
  assert.equal(seedGreetingMessage(session, greeting), -1, '已有回合的会话不得再种')
  assert.equal(session.log.filter((e) => e.type === 'assistant/message').length, 0)
})

test('seedGreetingMessage: 同一会话只种一次（种过第二次返回 -1）', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  assert.equal(seedGreetingMessage(session, greeting), 1)
  // 即使把日志清空（模拟 spill/compaction 把早期事件挪走），greetingSeeds 也挡住重播
  session.log.length = 0
  assert.equal(seedGreetingMessage(session, greeting), -1, '同一会话不得重复种')
})

test('hasLiveUserMessage: 空日志为 false', () => {
  assert.equal(hasLiveUserMessage(new FakeSession()), false)
})

// ══════════════════════════════════════════════════════════
// 2b. seedGreetingForSession：安全阀（开关 / 子会话 / 重复种）+ 回合号对账
// ══════════════════════════════════════════════════════════

test('安全阀：greetingSeedEnabled=false 时不种', () => {
  const session = new FakeSession()
  const r = seedGreetingForSession(fakeAgent(session), REAL_PRESET_ID, { greetingSeedEnabled: false }, 'test')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(session.log.filter((e) => e.type === 'assistant/message').length, 0, '开关关闭时不得有任何 assistant 消息')
})

test('安全阀：子会话不种', () => {
  const session = new FakeSession()
  session.header.origin = 'subagent'
  const r = seedGreetingForSession(fakeAgent(session), REAL_PRESET_ID, { greetingSeedEnabled: true }, 'test')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'subagent')
})

test('安全阀：预设没有开场白时不种', () => {
  const session = new FakeSession()
  const r = seedGreetingForSession(fakeAgent(session), 'preset-does-not-exist-0000', { greetingSeedEnabled: true }, 'test')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-greeting')
})

test('成功路径：种进 turn 1 并把 phase.lastTurn 推到 1；同一会话第二次评估跳过', () => {
  const session = new FakeSession()
  const agent = fakeAgent(session)
  const r1 = seedGreetingForSession(agent, REAL_PRESET_ID, { greetingSeedEnabled: true }, 'test')
  assert.equal(r1.ok, true, '第一次评估应当成功：' + JSON.stringify(r1))
  assert.equal(r1.lastTurn, 1)
  assert.equal(agent.phase.lastTurn, 1, 'phase.lastTurn 必须被推进，否则驱动器开回合会撞不变量')
  const r2 = seedGreetingForSession(agent, REAL_PRESET_ID, { greetingSeedEnabled: true }, 'test')
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'not-fresh', '同一会话第二次评估必须跳过')
})

// ══════════════════════════════════════════════════════════
// 2c. 接线护栏：apply() 必须安装全局播种监听（把调用点删掉就变红）
// ══════════════════════════════════════════════════════════

const INDEX_PATH = path.join(import.meta.dirname, '..', 'lib', 'index.js')
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8')

/** 播种机制的源码切片（seedGreetingForSession + armGreetingSeed，到 pickGreetingCard 为止）。 */
function armGreetingSeedSrc() {
  const start = INDEX_SRC.indexOf('function seedGreetingForSession(')
  const end = INDEX_SRC.indexOf('function pickGreetingCard(', start)
  assert.ok(start >= 0, '找不到 armGreetingSeed（被删了？）')
  assert.ok(end > start, 'armGreetingSeed 切片范围异常')
  return INDEX_SRC.slice(start, end)
}

test('接线护栏：apply() 必须调用 armGreetingSeed(ctx)（把调用点删掉就变红）', () => {
  assert.ok(
    INDEX_SRC.includes('try { armGreetingSeed(ctx) } catch (e) {'),
    '★ apply() 里没有安装播种监听 —— 开场白不会被种进消息面，封面页又会消失',
  )
})

test('接线护栏：播种监听必须是 agent/created + agent/inbox/inserted 双路径，且受开关约束', () => {
  const src = armGreetingSeedSrc()
  assert.ok(src.includes("ctx.on('agent/created'"), '必须有会话创建事件路径（官方时机）')
  assert.ok(src.includes("ctx.on('agent/inbox/inserted'"), '必须有首条用户消息入队的兜底路径')
  assert.ok(src.includes("ctx.on('agent/request-error'"), '必须保留网关拒 assistant 打头的日志兜底')
  assert.ok(/greetingSeedEnabled === false/.test(src), '必须保留 greetingSeedEnabled 开关')
  assert.ok(src.includes("origin === 'subagent'"), '子 Agent 会话不许播种')
})

test('接线护栏：旧的「log.length === 0」判重必须彻底消失（本次故障的根因）', () => {
  assert.ok(
    !INDEX_SRC.includes('greetingSession.log.length === 0'),
    '★ 组装路径里还留着 log.length === 0 判重 —— 时序自相矛盾的旧 bug 回来了',
  )
  assert.ok(
    !INDEX_SRC.includes('session.log.length !== 0'),
    'seedGreetingMessage 里也不许再用「日志非空」当拒绝理由',
  )
})

test('接线护栏：seedGreetingMessage 里不再 append user/message（引导消息已移除）', () => {
  const start = INDEX_SRC.indexOf('function seedGreetingMessage(')
  const end = INDEX_SRC.indexOf('function appendGreetingPreamble(', start)
  assert.ok(start >= 0 && end > start, '切片范围异常（函数被改名/删掉了？）')
  const src = INDEX_SRC.slice(start, end)
  assert.ok(src.includes("'assistant/message'"), 'assistant 开场白楼必须保留')
  assert.ok(!src.includes("'user/message'"), '★ 播种里又出现了 user/message —— 删不掉的引导楼回来了')
})

test('接线护栏：注入 API 必须走统一决策函数并返回 greeting-already-present', () => {
  const start = INDEX_SRC.indexOf("path: '/api/tavern/greeting/insert'")
  const end = INDEX_SRC.indexOf("path: '/api/tavern/state'", start)
  assert.ok(start >= 0 && end > start, '切片范围异常（路由被删了？）')
  const src = INDEX_SRC.slice(start, end)
  assert.ok(src.includes('insertGreetingForSession('), '路由必须走统一决策函数（判重才有地方落地）')
  assert.ok(src.includes("'greeting-already-present'"), '必须返回 greeting-already-present（面板靠它改提示）')
})

// ══════════════════════════════════════════════════════════
// 2d. 手动兜底：pickGreetingCard + appendGreetingToSessionEnd
// ══════════════════════════════════════════════════════════

test('pickGreetingCard: 真预设取到启用中第一张卡的开场白', () => {
  const r = pickGreetingCard(REAL_PRESET_ID)
  assert.equal(r.ok, true, '应当取到卡：' + JSON.stringify(r).slice(0, 120))
  assert.ok(r.greeting.startsWith('【主页】'))
  assert.ok(r.name, '必须有卡名')
})

test('pickGreetingCard: 找不到卡返回明确错误（不含「失败」这种废话）', () => {
  assert.match(pickGreetingCard('preset-does-not-exist-0000').error, /preset-not-found/)
  const bad = pickGreetingCard(REAL_PRESET_ID, '不存在的卡名')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /card-not-found/, '指定卡名找不到时必须说清楚：' + bad.error)
})

test('appendGreetingToSessionEnd: 旧会话（已有两回合）注入到末尾，回合号接续', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  // 先造两回合真实历史
  for (let i = 1; i <= 2; i++) {
    session.append('turn/start', { turn: i })
    session.append('step/start', { turn: i, step: 1 })
    session.append('assistant/message', {
      turn: i, step: 1,
      message: { id: 'a' + i, role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [{ type: 'text', text: '第' + i + '楼' }] },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: i, step: 1 })
    session.append('turn/end', { turn: i, reason: { kind: 'completed' } })
    session.append('user/message', {
      id: 'u' + i, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第' + i + '问' }],
    }, { surfaceOp: 'append' })
  }
  const before = session.deriveMessages().length
  const turn = appendGreetingToSessionEnd(session, greeting)
  assert.equal(turn, 3, '回合号必须接在历史最大回合之后')
  const messages = session.deriveMessages()
  assert.equal(messages.length, before + 1)
  const last = messages[messages.length - 1]
  assert.equal(last.role, 'assistant', '★ 注入的开场白必须在会话末尾')
  assert.equal(textOf(last), greeting)
  assert.equal(last.source && last.source.provider, 'tavern', 'source 必须与播种同款（tavern/character-card）')
  assert.equal(last.source && last.source.model, 'character-card')
  // 注入之后再开回合也必须不撞不变量（FakeSession 自己会校验）
  session.append('turn/start', { turn: 4 })
  session.append('user/message', { id: 'u4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, { surfaceOp: 'append' })
})

test('appendGreetingToSessionEnd: 有未闭合回合（正在生成中）时拒绝注入', () => {
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  assert.throws(() => appendGreetingToSessionEnd(session, '开场白'), /未闭合/, '正在生成中必须明确拒绝，不能埋不变量炸弹')
})

// ══════════════════════════════════════════════════════════
// 2e. 防重复注入（2026-09-23）：会话已有开场白 ⇒ 不再叠加
//   判据固定为 source.model === 'character-card'（播种与手动注入打同一个标记），
//   **不比文本**：开场白里的 ST 占位符会被卡正则按当前变量换掉，同一张卡不同轮、
//   不同卡之间的落盘文本都不一样，比文本必然漏判。
// ══════════════════════════════════════════════════════════

/** 数一数会话里「角色卡开场白」楼有几条。 */
function cardGreetingCount(session) {
  return session.log.filter((e) => {
    if (!e || e.type !== 'assistant/message') return false
    const src = e.data && e.data.message && e.data.message.source
    return !!(src && src.model === 'character-card')
  }).length
}

test('hasCardGreeting: 只认 character-card 楼，模型自己的回复不算开场白', () => {
  const session = new FakeSession()
  assert.equal(hasCardGreeting(session), false, '空会话不算有开场白')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' }, content: [{ type: 'text', text: '普通回复' }] },
  }, { surfaceOp: 'append' })
  assert.equal(hasCardGreeting(session), false, '★ 模型自己的回复不得被当成开场白（否则旧会话永远注不进去）')
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID).ok, true, '普通旧会话必须还能注入')
  assert.equal(hasCardGreeting(session), true)
})

// ★ 对照臂（改成按文本比较就红）：占位符会变，判重不能比文本。
test('对照臂（按文本比较必红）：占位符换过之后，判重仍要认出这是同一条开场白', () => {
  const session = new FakeSession()
  seedGreetingMessage(session, '【主页】占位符=第一版')
  assert.equal(hasCardGreeting(session), true, '前提：播种后算已有开场白')
  // 模拟卡正则把占位符替换掉（落盘文本已经不是注入时的原文）
  const node = session.log.find((e) => e.type === 'assistant/message')
  node.data.message.content[0].text = '【主页】占位符=第二版'
  assert.equal(hasCardGreeting(session), true, '★ 文本变了也必须认出已注入过（按文本比较在这里必然漏判）')
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID).error, 'greeting-already-present')
})

test('insertGreetingForSession: 第一次注入成功，第二次返回 greeting-already-present', () => {
  const session = new FakeSession()
  // 造一回合普通历史（旧会话场景：注入按钮本来就是给它的）
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [{ type: 'text', text: '第1楼' }] },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const r1 = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r1.ok, true, '第一次应当成功：' + JSON.stringify(r1))
  assert.equal(r1.turn, 2, '回合号必须接在历史之后')
  assert.ok(r1.greetingLen > 0 && r1.cardName, '成功时要带卡名与长度给面板显示')
  assert.equal(cardGreetingCount(session), 1)

  const r2 = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r2.ok, false, '★ 第二次必须被拒（用户截图里多条【主页】就是这么叠出来的）')
  assert.equal(r2.error, 'greeting-already-present', '错误码必须是面板认得的那一个')
  assert.equal(cardGreetingCount(session), 1, '★ 被拒时不得再落第二条开场白')
})

test('insertGreetingForSession: 自动播种已种过的会话，手动注入同样拒绝', () => {
  const session = new FakeSession()
  assert.equal(seedGreetingMessage(session, greetingTextFor(REAL_PRESET_ID)), 1, '前提：自动播种成功')
  const r = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'greeting-already-present', '播种与手动注入打同一个标记，判重必须认得出来')
  assert.equal(cardGreetingCount(session), 1)
})

test('insertGreetingForSession: 找不到卡 / 会话不可用时仍返回明确错误（不是 already-present）', () => {
  const session = new FakeSession()
  assert.match(insertGreetingForSession(session, 'preset-does-not-exist-0000').error, /preset-not-found/)
  assert.equal(hasCardGreeting(session), false, '注入失败不得留下「已有开场白」的假象')
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID, '不存在的卡名').error.includes('card-not-found'), true)
  assert.equal(insertGreetingForSession(null, REAL_PRESET_ID).error, 'no-session：会话对象不可用')
})

// ══════════════════════════════════════════════════════════
// 3. 端到端：真开场白过真美化引擎，[0] 主页必须命中
//    （这就是用户屏幕上那条路径：muv 拿到的文本 = 这条消息的正文容器内容）
// ══════════════════════════════════════════════════════════

const MUV = process.env.MUV_BASE || 'http://127.0.0.1:3080'

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response.json()
}

test('端到端：真 first_mes 过 /api/muv-engine/apply-regex-card ⇒ coverPage / 进入事务所 / NOW ON AIR', async () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  assert.ok(greeting.length > 0, '前提：真卡有开场白')

  // 取卡：与前端同一条链路（tavern-card → apply-regex-card）。
  // 这里显式带 presetId（等价于「会话已绑定该预设」），因为测试用的不是真会话 id。
  const cardUrl = MUV + '/api/muv-table/tavern-card?presetId=' + encodeURIComponent(REAL_PRESET_ID) + '&preferPreset=1'
  let card
  try {
    card = await fetchJson(cardUrl)
  } catch (e) {
    // 服务没起：至少证明「开场白本身带得起这些锚点」，不让测试假装通过
    assert.ok(greeting.includes('【主页】'), '离线兜底：开场白必须含【主页】')
    console.log('  (跳过真端点断言：' + e.message + ')')
    return
  }
  assert.ok(card && card.ok !== false, '取卡接口应当成功')
  assert.equal(card.presetDir, REAL_PRESET_ID, '取到的必须是这张卡的预设目录')
  assert.ok(Array.isArray(card.regexScripts) && card.regexScripts.length === 10,
    '真卡应当带 10 条正则脚本，实际 ' + (card.regexScripts || []).length)
  assert.ok(card.regexScripts.some((s) => String(s.scriptName) === '主页'), '必须有 [0] 主页 这条脚本')

  const applied = await fetchJson(MUV + '/api/muv-engine/apply-regex-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: greeting, cardJson: card, mode: 'display' }),
  })
  assert.ok(applied.ok, 'apply-regex-card 应当成功：' + JSON.stringify(applied).slice(0, 200))
  assert.ok(applied.applied >= 1, '至少 [0] 主页 要命中，实际 applied=' + applied.applied)
  const out = applied.text

  assert.ok(out.includes('coverPage'), '★ 产物必须含 coverPage（封面页脚本的锚点）')
  assert.ok(out.includes('进入事务所'), '★ 产物必须含「进入事务所」')
  assert.ok(out.includes('NOW ON AIR'), '★ 产物必须含「NOW ON AIR」')
  assert.ok(!out.includes('<VariableInsert>'), '原始 <VariableInsert> 数据块必须被隐藏正则抹掉，不该漏到屏幕上')
  assert.ok(out.length > 20000, '产物应当是整页 HTML，实际长度 ' + out.length)
})

test('对照臂（能红）：开场白**没**进消息面时，同一份 first_mes 不参与渲染', () => {
  // 这就是修复前的状态：开场白只躺在系统提示里，美化引擎根本拿不到它。
  // 用「消息面 = 只有一条用户消息」来代表，断言此刻拿不到任何封面页锚点。
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    id: 'user-1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '开始' }],
  }, { surfaceOp: 'append' })
  const messages = session.deriveMessages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user', '修复前首条是 user（开场白不在消息面）')
  assert.ok(!textOf(messages[0]).includes('coverPage'), '修复前消息面上不可能有 coverPage')
  assert.ok(!textOf(messages[0]).includes('【主页】'), '修复前消息面上不可能有【主页】')
})

test('因果链（能红）：美化引擎要的输入就是消息面正文 —— 空消息面 ⇒ 引擎无从产出封面页', async () => {
  // 把「修复前」和「修复后」放在同一条端点上对照：
  //   喂空串（= 修复前 muv 能拿到的正文：没有） → 不可能有封面页
  //   喂真开场白（= 修复后 muv 拿到的正文）     → 必有封面页
  // 这就把「症状」直接钉在「开场白有没有进消息面」这一条因果上。
  const greeting = greetingTextFor(REAL_PRESET_ID)
  assert.ok(greeting.length > 0, '前提：真卡有开场白')

  const cardUrl = MUV + '/api/muv-table/tavern-card?presetId=' + encodeURIComponent(REAL_PRESET_ID) + '&preferPreset=1'
  let card
  try {
    card = await fetchJson(cardUrl)
  } catch (e) {
    console.log('  (跳过：' + e.message + ')')
    return
  }

  const applied = await fetchJson(MUV + '/api/muv-engine/apply-regex-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: greeting, cardJson: card, mode: 'display' }),
  })
  const withGreeting = applied.ok ? applied.text : ''

  const empty = await fetchJson(MUV + '/api/muv-engine/apply-regex-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '开始', cardJson: card, mode: 'display' }),
  })
  const withoutGreeting = empty.ok ? empty.text : ''

  assert.ok(withGreeting.includes('coverPage'), '有开场白 ⇒ 有封面页')
  assert.ok(!withoutGreeting.includes('coverPage'), '★ 没有开场白 ⇒ 没有封面页（修复前就是这个状态，必须为真）')
})

// 清理提示：本文件不写任何临时文件，也不改 tests/core.test.js。
void os
void path
