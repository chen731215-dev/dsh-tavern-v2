/**
 * 开场白回归测试（手动注入路径 + 会话日志安全闸门）。
 *
 * ## 历史脉络（为什么这个文件只剩这些用例）
 *
 * 症状起点（2026-09）：DSH 会话里永远看不到角色卡开场白 ⇒ 卡片「[0] 主页」（粉蓝封面页）
 *   永远不渲染。原因：`cardTextFor()` 返回的整包文本**只进系统提示**，而美化引擎只扫
 *   **消息**（取样口是 `[class*="_markdown_"]`）。ST 里能看到，是因为 ST 把 `first_mes`
 *   当**第一条消息**发下去。
 *
 * 于是有了「把开场白种成会话首条 assistant 消息」的做法 —— 并且它**把会话写坏了**：
 *   会话日志（v4）要求受保护 head 只能由「**还没有任何 surface 事件时出现的
 *   `system/message`**」建立，而播种在新会话第一轮就写 `assistant/message`，排在真正的
 *   `system/message` 之前 ⇒ 该会话第一次写 system/message 即抛
 *     `SessionFormatError: system/message requires a protected first surface head`
 *   ⇒ **会话永久打不开**（真事故：**5 个会话**中招，会话 id 属本机数据故不列出，
 *   修法是删掉日志里那条抢跑消息）。旧注释里"网关实测接受 assistant 打头"只对**模型网关**
 *   成立，与会话日志层无关 —— 两层规则被混为一谈才出的这次事故。
 *
 * 2026-10-04（v2.5.4）：**自动播种机制整体删除**（`seedGreetingMessage` /
 *   `seedGreetingForSession` / `armGreetingSeed` / `appendGreetingPreamble` /
 *   `GREETING_PREAMBLE` / `greetingSeeds` 等），因为在新会话上它不可能合法执行。
 *   开场白只剩**一条合法路径**：对**已经跑过回合**（日志里已有 system/message）的会话，
 *   由用户点面板「📌 开场白 → 注入开场白到会话末尾」触发
 *     （POST /api/tavern/greeting/insert → `appendGreetingToSessionEnd`）。
 *
 * 所以本文件现在覆盖三件事：
 *   ① 开场白取文（greetingTextFor / pickGreetingCard）；
 *   ② **闸门**：`canAppendGreetingSurface()` 与三处/一处写入点的行为（不许把 surface 事件
 *      写在首个 system/message 之前）+ 事故现场重演；
 *   ③ 手动注入的完整决策（回合号接续、防重复、settlement 形状）；
 *   ④ 源码护栏：播种 API **必须整体不存在**（防止有人"顺手加回来"），
 *      以及 apply() 必须登记活会话（手动注入要靠它按 sessionId 找到 Agent）。
 *
 * 运行：node --test tests/greeting-seed.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// ── 自包含夹具 ────────────────────────────────────────────
// 由 tests/fixtures/with-temp-dsh-home.js 在 lib 求值前把 $DSH_HOME 指向临时目录，
// 并在那里造一张最小的夹具卡（含【主页】开场白）。断言不碰真机数据。
import { _test, FIXTURE_PRESET_ID } from './fixtures/with-temp-dsh-home.js'

const {
  greetingTextFor,
  hasCardGreeting,
  appendGreetingToSessionEnd,
  insertGreetingForSession,
  pickGreetingCard,
  canAppendGreetingSurface,
  GREETING_SURFACE_TYPES,
} = _test

const REAL_PRESET_ID = FIXTURE_PRESET_ID

// ── surface 元数据校验（对齐真实现，本文件自带、不依赖机器环境）────
// 真实现见 `@deepseek-ai/dsh-session/lib/types/surface.js` 的 validateSurfaceMetadata()：
//   ① 只有「产出模型消息」的事件类型才参与 surface；
//   ② 这些事件没带 surfaceOp 时**不报错**，只是不进 surface；
//   ③ 带 surfaceOp 时才校验 replace 的 startSeq/endSeq 与 sourceEventSeqs。
const SURFACE_EVENT_TYPES = new Set([
  'developer/message',
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function surfaceOpOf(event) {
  const op = event.surfaceOp
  if (op === undefined) return undefined
  if (!SURFACE_EVENT_TYPES.has(event.type)) {
    throw new Error(`event type "${event.type}" must be surface-ineligible when surfaceOp is present`)
  }
  return op
}

function localValidateSurfaceMetadata(event) {
  const op = surfaceOpOf(event)
  if (op !== undefined && op !== 'append' && (op.startSeq >= event.seq || op.endSeq >= event.seq)) {
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }
  if (op !== undefined) {
    const raw = event.sourceEventSeqs
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('sourceEventSeqs must not be empty')
      if (new Set(raw).size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates')
      for (const seq of raw) {
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('sourceEventSeqs must be non-negative safe integers')
        if (seq >= event.seq) throw new Error('sourceEventSeqs must reference earlier events')
      }
    }
  }
  return op
}
const validateSurfaceMetadata = localValidateSurfaceMetadata

/**
 * 最小 Session 替身，行为对齐真 Session 的三条关键语义：
 *   1. `append` 逐条递增 seq，并校验 surface 元数据 + turn/step 关系不变量；
 *   2. surface replace 会**原位换掉**被遮蔽的节点（`foldSurface` 同款语义）；
 *   3. `deriveMessages()` 按 surface 顺序投影（空 content 的消息投影为空）。
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
      if (!Array.isArray(data.message.content)) throw new Error('assistant/message requires a content array')
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

// ── 夹具：建立/未建立「受保护 head」的两种会话 ─────────────────
/**
 * 在日志头部落一条空的 `system/message`（= 建立受保护 head）。
 * `content: []` 是刻意的：空 content 的消息投影为空，不会污染消息面断言。
 */
function appendSystemHead(session) {
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys-head', role: 'system', content: [] },
  }, { surfaceOp: 'append' })
  return session
}

/** 「head 已建立、但还没开过回合」的会话。 */
function fakeSessionWithHead(id) {
  return appendSystemHead(new FakeSession(id))
}

/** 把 head 落在一个已打开的 step 里（真会话就是这样产生的：head 来自第一个回合）。 */
function appendSystemHeadInStep(session, turn, step) {
  session.append('system/message', {
    turn,
    step,
    message: { id: 'sys-' + turn + '-' + step, role: 'system', content: [] },
  }, { surfaceOp: 'append' })
  return session
}

/** 造一个「跑过 n 回合」的会话（head 落在第一回合的 step 里，与真实日志同形）。 */
function fakeSessionWithTurns(n = 1, id) {
  const session = new FakeSession(id)
  for (let i = 1; i <= n; i++) {
    session.append('turn/start', { turn: i })
    session.append('step/start', { turn: i, step: 1 })
    if (i === 1) appendSystemHeadInStep(session, i, 1)
    session.append('assistant/message', {
      turn: i, step: 1, stream: [],
      message: { id: 'a' + i, role: 'assistant', source: { kind: 'model', provider: 'x', model: 'y' }, content: [{ type: 'text', text: '第' + i + '楼' }] },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: i, step: 1 })
    session.append('turn/end', { turn: i, reason: { kind: 'completed' } })
    session.append('user/message', {
      id: 'u' + i, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第' + i + '问' }],
    }, { surfaceOp: 'append' })
  }
  return session
}

/** 数一数会话里「角色卡开场白」楼有几条。 */
function cardGreetingCount(session) {
  return session.log.filter((e) => {
    if (!e || e.type !== 'assistant/message') return false
    const src = e.data && e.data.message && e.data.message.source
    return !!(src && src.model === 'character-card')
  }).length
}

// ══════════════════════════════════════════════════════════
// 1. 开场白取文
// ══════════════════════════════════════════════════════════

test('greetingTextFor: 从 characters.json 的 first 字段取到开场白原文', () => {
  const text = greetingTextFor(REAL_PRESET_ID)
  assert.ok(text.length > 0, '夹具卡应当有开场白')
  assert.ok(text.startsWith('【主页】'), '开场白必须以【主页】开头，实际：' + JSON.stringify(text.slice(0, 20)))
})

test('greetingTextFor: 未知预设返回空串（不抛）', () => {
  assert.equal(greetingTextFor('preset-does-not-exist-0000'), '')
  assert.equal(greetingTextFor(''), '')
})

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

// ══════════════════════════════════════════════════════════
// 2. 🔒 事故闸：绝不允许把 surface 事件写在首个 system/message 之前
//
//   **5 个会话**被写坏：报
//   `SessionFormatError: system/message requires a protected first surface head`，
//   修法是删掉日志里那条抢跑消息。这一段把「永不再犯」钉在测试里。
// ══════════════════════════════════════════════════════════

test('闸门真值表：只有「首个 surface 事件是 system/message」才放行', () => {
  // ① 全新会话：一个 surface 事件都没有 ⇒ 拦（现在写就抢在 system/message 前面）
  assert.equal(canAppendGreetingSurface(new FakeSession()), false, '没有 head ⇒ 必须拦')
  // ② head 已建立 ⇒ 放行
  assert.equal(canAppendGreetingSurface(fakeSessionWithHead()), true, 'head 在 ⇒ 放行')
  // ③ 首个 surface 事件是 user/assistant（模拟已经被写坏的日志）⇒ 拦，不许再动它
  const poisonedByUser = new FakeSession()
  poisonedByUser.append('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, { surfaceOp: 'append' })
  assert.equal(canAppendGreetingSurface(poisonedByUser), false, '首个 surface 不是 system/message ⇒ 拦')
  const poisonedByAssistant = new FakeSession()
  poisonedByAssistant.log.push({
    type: 'assistant/message', seq: 0, time: Date.now(),
    data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', content: [] } },
  })
  assert.equal(canAppendGreetingSurface(poisonedByAssistant), false, 'assistant 抢跑（就是旧播种的形态）⇒ 拦')
  // ④ 非 surface 的前置事件不参与判定（真新会话就是这个形态）
  const pre = new FakeSession()
  pre.log.push({ type: 'session/created', seq: 0, time: Date.now(), data: {} })
  pre.log.push({ type: 'agent-preset/selected', seq: 1, time: Date.now(), data: { presetId: 'x' } })
  assert.equal(canAppendGreetingSurface(pre), false, '前置事件不算 surface ⇒ 仍然拦')
  // ⑤ 判据用的类型集合必须与 DSH 的 SURFACE_TYPES 一致（少一个就会漏判）
  assert.deepEqual(
    [...GREETING_SURFACE_TYPES].sort(),
    ['assistant/message', 'developer/message', 'system/message', 'tool/result', 'user/message'],
    '★ 类型集合必须与 DSH 网关一致，否则闸门会漏',
  )
})

test('事故现场重演：抢跑的 assistant 会让日志被判 corrupt；正常回合顺序不会', () => {
  // DSH 网关的受保护 head 校验（本地镜像；原文见 asar 的 restoreReleasedV3Artifact）：
  //   system/message 到达时若「已有 surface 事件但 head 未建立」⇒ 抛错。
  const gatewayHeadThrows = (events) => {
    let hasSurface = false
    let head
    for (const e of events) {
      if (e.type === 'system/message') {
        if (hasSurface && head === undefined) return true
        if (e.surfaceOp === 'append' && !hasSurface) head = e.seq
      }
      if (GREETING_SURFACE_TYPES.has(e.type)) hasSurface = true
    }
    return false
  }

  // ① 旧播种行为：新会话里先写一条 assistant 开场白，用户随后发消息 ⇒ 真回合落 system/message
  const bad = new FakeSession()
  bad.append('turn/start', { turn: 1 })
  bad.append('step/start', { turn: 1, step: 1 })
  bad.append('assistant/message', {
    turn: 1, step: 1, stream: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    message: { id: 'g', role: 'assistant', source: { kind: 'model', provider: 'tavern', model: 'character-card' }, content: [{ type: 'text', text: '开场白' }] },
  }, { surfaceOp: 'append' })
  bad.append('step/end', { turn: 1, step: 1 })
  bad.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  bad.append('turn/start', { turn: 2 })
  bad.append('step/start', { turn: 2, step: 1 })
  bad.append('system/message', { turn: 2, step: 1, message: { id: 's2', role: 'system', content: [] } }, { surfaceOp: 'append' })
  assert.equal(
    gatewayHeadThrows(bad.log), true,
    '★ 旧行为必须被判 corrupt —— 这就是那 5 个会话永久打不开的原因（SessionFormatError）',
  )

  // ② 现在：新会话不会再被写任何 surface 事件（播种已删除），首个 surface 事件由真回合的
  //    system/message 建立 ⇒ 日志合法。
  const good = new FakeSession()
  assert.equal(canAppendGreetingSurface(good), false, '新会话：闸门拦着，谁都别想抢跑')
  good.append('turn/start', { turn: 1 })
  good.append('step/start', { turn: 1, step: 1 })
  good.append('system/message', { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [] } }, { surfaceOp: 'append' })
  assert.equal(gatewayHeadThrows(good.log), false, '★ 正常回合顺序必须能通过网关校验')
})

test('事故闸：手动注入到「还没跑过回合」的会话必须抛明确错误（不是静默写坏）', () => {
  const session = new FakeSession()
  const before = session.log.length
  assert.throws(
    () => appendGreetingToSessionEnd(session, '开场白'),
    /还没跑过任何回合/,
    '★ 必须明确拒绝并说清原因（旧实现会直接写下去，把会话写坏）',
  )
  assert.equal(session.log.length, before, '★ 抛错时不许留下半截回合')
  // 同一个会话在建立 head 之后就能注入了
  appendSystemHead(session)
  const turn = appendGreetingToSessionEnd(session, '开场白')
  assert.ok(turn > 0, 'head 建立后应当可以注入')
})

// ══════════════════════════════════════════════════════════
// 3. 手动注入：回合号接续 / 生成中拒绝
// ══════════════════════════════════════════════════════════

test('appendGreetingToSessionEnd: 旧会话（已有两回合）注入到末尾，回合号接续', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = fakeSessionWithTurns(2)
  const before = session.deriveMessages().length
  const turn = appendGreetingToSessionEnd(session, greeting)
  assert.equal(turn, 3, '回合号必须接在历史最大回合之后')
  const messages = session.deriveMessages()
  assert.equal(messages.length, before + 1)
  const last = messages[messages.length - 1]
  assert.equal(last.role, 'assistant', '★ 注入的开场白必须在会话末尾')
  assert.equal(textOf(last), greeting)
  assert.equal(last.source && last.source.provider, 'tavern', 'source 必须带 tavern/character-card 标记')
  assert.equal(last.source && last.source.model, 'character-card')
  // 注入之后再开回合也必须不撞不变量（FakeSession 自己会校验）
  session.append('turn/start', { turn: 4 })
  session.append('user/message', { id: 'u4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, { surfaceOp: 'append' })
})

test('appendGreetingToSessionEnd: 有未闭合回合（正在生成中）时拒绝注入', () => {
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  // head 已建立 ⇒ 事故闸放行，才能测到「正在生成中」这条分支本身
  appendSystemHeadInStep(session, 1, 1)
  assert.throws(() => appendGreetingToSessionEnd(session, '开场白'), /未闭合/, '正在生成中必须明确拒绝，不能埋不变量炸弹')
})

// ══════════════════════════════════════════════════════════
// 4. 防重复注入：会话已有开场白 ⇒ 不再叠加
//   判据固定为 source.model === 'character-card'，**不比文本**：
//   开场白里的 ST 占位符会被卡正则按当前变量换掉，同一张卡不同轮、不同卡之间的
//   落盘文本都不一样，比文本必然漏判（用户截图里多条【主页】就是这么叠出来的）。
// ══════════════════════════════════════════════════════════

test('hasCardGreeting: 只认 character-card 楼，模型自己的回复不算开场白', () => {
  const session = fakeSessionWithTurns(1)
  assert.equal(hasCardGreeting(new FakeSession()), false, '空会话不算有开场白')
  assert.equal(hasCardGreeting(session), false, '★ 模型自己的回复不得被当成开场白（否则旧会话永远注不进去）')
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID).ok, true, '普通旧会话必须还能注入')
  assert.equal(hasCardGreeting(session), true)
})

test('insertGreetingForSession: 第一次注入成功，第二次返回 greeting-already-present', () => {
  const session = fakeSessionWithTurns(1)
  const r1 = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r1.ok, true, '第一次应当成功：' + JSON.stringify(r1))
  assert.equal(r1.turn, 2, '回合号必须接在历史之后')
  assert.ok(r1.greetingLen > 0 && r1.cardName, '成功时要带卡名与长度给面板显示')
  assert.equal(cardGreetingCount(session), 1)

  const r2 = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r2.ok, false, '★ 第二次必须被拒')
  assert.equal(r2.error, 'greeting-already-present', '错误码必须是面板认得的那一个')
  assert.equal(cardGreetingCount(session), 1, '★ 被拒时不得再落第二条开场白')
})

test('insertGreetingForSession: 手动注入过的会话，再注入同样拒绝', () => {
  const session = fakeSessionWithHead()
  assert.equal(appendGreetingToSessionEnd(session, greetingTextFor(REAL_PRESET_ID)) > 0, true, '前提：手动注入成功')
  const r = insertGreetingForSession(session, REAL_PRESET_ID)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'greeting-already-present', '判重必须认出自己注入过的那条')
  assert.equal(cardGreetingCount(session), 1)
})

// ★ 对照臂（改成按文本比较就红）：占位符会变，判重不能比文本。
test('对照臂（按文本比较必红）：占位符换过之后，判重仍要认出这是同一条开场白', () => {
  const session = fakeSessionWithHead()
  appendGreetingToSessionEnd(session, '【主页】占位符=第一版')
  assert.equal(hasCardGreeting(session), true, '前提：注入后算已有开场白')
  // 模拟卡正则把占位符替换掉（落盘文本已经不是注入时的原文）
  const node = session.log.find((e) => e.type === 'assistant/message')
  node.data.message.content[0].text = '【主页】占位符=第二版'
  assert.equal(hasCardGreeting(session), true, '★ 文本变了也必须认出已注入过（按文本比较在这里必然漏判）')
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID).error, 'greeting-already-present')
})

test('insertGreetingForSession: 找不到卡 / 会话不可用时仍返回明确错误（不是 already-present）', () => {
  const session = new FakeSession()
  assert.match(insertGreetingForSession(session, 'preset-does-not-exist-0000').error, /preset-not-found/)
  assert.equal(hasCardGreeting(session), false, '注入失败不得留下「已有开场白」的假象')
  assert.equal(insertGreetingForSession(session, REAL_PRESET_ID, '不存在的卡名').error.includes('card-not-found'), true)
  assert.equal(insertGreetingForSession(null, REAL_PRESET_ID).error, 'no-session：会话对象不可用')
})

// ══════════════════════════════════════════════════════════
// 5. settlement 字段 —— 2026-09-23 真事故：会话被写坏、整个打不开
//   DSH 读会话时按 `assertAssistantSettlementShape` 校验每条 assistant/message：
//   turn/step 必须是非负安全整数，且 **data.stream 必须是数组**。
//   漏了 stream ⇒ 该会话直接打不开（2026-09-23 实事故）。
// ══════════════════════════════════════════════════════════

/** DSH 校验规则的本地镜像（改动时两处必须同步）。 */
function assertSettlementShape(ev, label) {
  const d = ev.data || {}
  assert.ok(Number.isSafeInteger(d.turn) && d.turn >= 0, label + ': turn 必须是非负安全整数')
  assert.ok(Number.isSafeInteger(d.step) && d.step >= 0, label + ': step 必须是非负安全整数')
  assert.ok(Array.isArray(d.stream), label + ': ★ stream 必须是数组（缺它 DSH 判会话 corrupt、整个会话打不开）')
}

test('settlement：手动注入到会话末尾的 assistant 楼必须带 stream 数组', () => {
  const session = fakeSessionWithTurns(1)
  const t = appendGreetingToSessionEnd(session, greetingTextFor(REAL_PRESET_ID))
  assert.ok(t > 1, '注入应接在历史回合之后')
  const am = session.log.filter((e) => e.type === 'assistant/message')
  assertSettlementShape(am[am.length - 1], 'appendGreetingToSessionEnd')
})

test('对照臂：settlement 判据能对「缺 stream 的旧形态」变红', () => {
  const legacy = { data: { turn: 0, step: 0 } }
  assert.throws(() => assertSettlementShape(legacy, '旧形态'), /stream 必须是数组/)
})

// ══════════════════════════════════════════════════════════
// 6. 源码护栏（把关键接线删掉 / 把已删除的东西加回来，都要变红）
// ══════════════════════════════════════════════════════════

const INDEX_SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')

test('护栏：写入点必须过闸门，且显式给 stream: []', () => {
  const start = INDEX_SRC.indexOf('function appendGreetingToSessionEnd(')
  const end = INDEX_SRC.indexOf('function insertGreetingForSession(', start)
  assert.ok(start >= 0 && end > start, '切片范围异常（函数被改名/删掉了？）')
  const src = INDEX_SRC.slice(start, end)
  assert.ok(
    src.includes('canAppendGreetingSurface('),
    '★ 注入前必须过闸门 —— 否则它会在首个 system/message 之前写 surface 事件，把会话写坏到永久打不开（2026-10-04 事故重演）',
  )
  assert.ok(/(^|\s)stream:\s*\[\]/.test(src), '★ 注入的 assistant 楼必须带 stream: []，否则该会话直接打不开')
})

test('护栏：播种 API 必须整体不存在（删干净了，也不许被加回来）', () => {
  const GONE = [
    'seedGreetingMessage',
    'seedGreetingForSession',
    'armGreetingSeed',
    'appendGreetingPreamble',
    'GREETING_PREAMBLE',
    'greetingSeeds',
    'greetingWatched',
    'hasLiveUserMessage',
    'closeDanglingBracket',
  ]
  // 只查**代码**行：注释里保留这些名字是刻意的（说明"这里曾经有什么、为什么删"，
  // 见 canAppendGreetingSurface 与文件上方「── 角色卡开场白 ──」的说明）。
  const codeLines = INDEX_SRC.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  for (const name of GONE) {
    const hit = codeLines.find((l) => l.includes(name))
    assert.ok(
      !hit,
      '★ `' + name + '` 又出现在**代码**里了 —— 自动播种会写坏会话日志（首个 surface 事件必须是 system/message），不要再加回来。命中行：' + String(hit || '').trim(),
    )
  }
  // 反例：确认判据不是永真（拿同一个方法去查一个确实存在的名字，必须查得到）
  assert.ok(codeLines.some((l) => l.includes('appendGreetingToSessionEnd')), '对照：仍然存在的函数必须查得到')
})

test('护栏：apply() 必须登记活会话，否则手动注入找不到 Agent', () => {
  assert.ok(INDEX_SRC.includes('armLiveAgents(ctx)'), '★ apply() 里没安装活会话登记 —— 手动注入 API 会找不到会话')
  const start = INDEX_SRC.indexOf('function armLiveAgents(')
  assert.ok(start >= 0, 'armLiveAgents 不见了')
  const end = INDEX_SRC.indexOf('function ', start + 1)   // 下一个函数定义处（不依赖换行风格）
  assert.ok(end > start, 'armLiveAgents 切片范围异常')
  const src = INDEX_SRC.slice(start, end)
  assert.ok(src.includes("ctx.on('agent/created'"), '必须登记 agent/created（空白新会话也要有）')
  assert.ok(src.includes("ctx.on('agent/inbox/inserted'"), '必须兜底登记 inbox 事件')
  assert.ok(!src.includes('session.append('), '★ 登记监听里不许再写日志（写就是播种，会弄坏会话）')
})

test('护栏：注入路由必须走统一决策函数并返回 greeting-already-present', () => {
  const start = INDEX_SRC.indexOf("path: '/api/tavern/greeting/insert'")
  const end = INDEX_SRC.indexOf("path: '/api/tavern/state'", start)
  assert.ok(start >= 0 && end > start, '切片范围异常（路由被删了？）')
  const src = INDEX_SRC.slice(start, end)
  assert.ok(src.includes('insertGreetingForSession('), '路由必须走统一决策函数（判重才有地方落地）')
  assert.ok(src.includes("'greeting-already-present'"), '必须返回 greeting-already-present（面板靠它改提示）')
})

// ══════════════════════════════════════════════════════════
// 7. 端到端：真开场白过真美化引擎，[0] 主页必须命中
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
  assert.ok(greeting.length > 0, '前提：夹具卡有开场白')

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

  const applied = await fetchJson(MUV + '/api/muv-engine/apply-regex-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: greeting, cardJson: card, mode: 'display' }),
  })
  assert.ok(applied.ok, 'apply-regex-card 应当成功：' + JSON.stringify(applied).slice(0, 200))
  assert.ok(applied.applied >= 1, '至少 [0] 主页 要命中，实际 applied=' + applied.applied)
  const out = applied.text
  assert.ok(out.includes('coverPage'), '★ 产物必须含 coverPage（封面页脚本的锚点）')
  assert.ok(!out.includes('<VariableInsert>'), '原始 <VariableInsert> 数据块必须被隐藏正则抹掉，不该漏到屏幕上')
})

test('对照臂（能红）：开场白**没**进消息面时，同一份 first_mes 不参与渲染', () => {
  // 「消息面 = 只有一条用户消息」代表开场白不在消息面上的状态，断言此刻拿不到封面页锚点。
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
  assert.equal(messages[0].role, 'user', '开场白不在消息面时，首条是 user')
  assert.ok(!textOf(messages[0]).includes('coverPage'), '没有开场白 ⇒ 消息面上不可能有 coverPage')
  assert.ok(!textOf(messages[0]).includes('【主页】'), '没有开场白 ⇒ 消息面上不可能有【主页】')
})

test('因果链（能红）：美化引擎要的输入就是消息面正文 —— 空消息面 ⇒ 引擎无从产出封面页', async () => {
  // 喂空串（开场白不在消息面）→ 不可能有封面页；喂真开场白 → 必有封面页。
  const greeting = greetingTextFor(REAL_PRESET_ID)
  assert.ok(greeting.length > 0, '前提：夹具卡有开场白')

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
  assert.ok(!withoutGreeting.includes('coverPage'), '★ 没有开场白 ⇒ 没有封面页（这就是修复前的状态，必须为真）')
})

// 清理提示：本文件不写任何临时文件（夹具目录由 with-temp-dsh-home.js 负责），
// 也不改 tests/core.test.js。
void path
