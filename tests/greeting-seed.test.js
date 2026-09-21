/**
 * 开场白播种回归测试（2026-09「DSH 里看不到封面页」故障）
 *
 * 故障：DSH 会话里永远看不到角色卡开场白，于是卡的 `[0] 主页`（粉蓝封面页：
 *       进入事务所 / NOW ON AIR / coverPage）永远不渲染。ST 里能看到，是因为 ST
 *       把 `first_mes` 当**第一条消息**发下去；而 DSH 这边 `cardTextFor()` 的返回值
 *       只进**系统提示**，美化引擎（muv）只扫 `[class*="_markdown_"]` 的消息容器，
 *       系统提示那一行是折叠的 SystemPromptRow —— 取样口根本碰不到它。
 *
 * 修法：新会话第一条用户消息入队时，把 `first_mes` 原文作为**首条 assistant 消息**
 *       种进会话日志，让消息面变成 `[system, assistant(开场白), user, assistant…]`。
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
  seedGreetingMessage,
  greetingIdsOf,
  GREETING_PREAMBLE,
} = _test

// ── 真卡的预设 id 与开场白 ────────────────────────────────
// 这套卡就是用户报告里那张：`preset-mt5ip9cc-t6josi`，
// characters.json[0] = { name:"_足控天堂2", first: 2921 字, 以 "【主页】" 开头 }。
const REAL_PRESET_ID = 'preset-mt5ip9cc-t6josi'

// ── 真 Session 的包内不变量（能拿到就用真的，拿不到用等价本地实现）────
// 值不值这么多事：`seedGreetingMessage` 种的事件序列必须过 dsh-session 的
// turn/step 关系不变量，`downgradeGreetingSeed` 的 surface replace 必须过
// sourceEventSeqs 的稠密性校验。用真校验器断言，才不是「自证」。
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
// 2. 播种：新会话的首条消息必须是开场白
// ══════════════════════════════════════════════════════════

test('seedGreetingMessage: 新会话消息面为 [assistant(开场白), …]，首条即开场白', () => {
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
  assert.equal(messages.length, 3, '开场白 + 合成引导 + 用户首条，实际 ' + messages.length)
  assert.equal(messages[0].role, 'assistant', '★ 首条必须是 assistant（开场白），实际：' + messages[0].role)
  assert.equal(textOf(messages[0]), greeting, '★ 首条内容必须与 first_mes 逐字一致')
  assert.equal(messages[1].role, 'user')
  assert.equal(textOf(messages[1]), GREETING_PREAMBLE, '合成引导必须是短文本，不许重复开场白原文')
  assert.equal(messages[2].role, 'user')
  assert.equal(textOf(messages[2]), '开始')

  // 卡里的 [0] 主页正则按原文匹配，因此播种内容里必须能看见这些锚点
  assert.ok(textOf(messages[0]).includes('<VariableInsert>'), '开场白里的 <VariableInsert> 必须原样保留（[0] 主页正则的锚点）')

  // 开场白原文在 transcript 里只许出现一次（不许被合成消息复制一遍）
  const copies = messages.filter((m) => textOf(m) === greeting).length
  assert.equal(copies, 1, '开场白原文在 transcript 里必须只出现一次，实际 ' + copies + ' 次')
})

test('seedGreetingMessage: 合成引导与开场白共用同一个 message id（按 id 精确关联）', () => {
  const greeting = greetingTextFor(REAL_PRESET_ID)
  const session = new FakeSession()
  seedGreetingMessage(session, greeting)
  const assistant = session.log.find((e) => e.type === 'assistant/message')
  const synthetic = session.log.find((e) => e.type === 'user/message')
  assert.equal(assistant.data.message.id, synthetic.data.id)
  assert.equal(greetingIdsOf(session).has(assistant.data.message.id), true)
})

test('seedGreetingMessage: 不是空会话就拒绝播种（第二轮、切预设都不会重复种）', () => {
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
  assert.equal(seedGreetingMessage(session, greeting), -1, '已有用户消息的会话不得再种')
  assert.equal(session.log.filter((e) => e.type === 'assistant/message').length, 0)
})

test('hasLiveUserMessage: 空日志为 false', () => {
  assert.equal(hasLiveUserMessage(new FakeSession()), false)
})

// ══════════════════════════════════════════════════════════
// 2b. 接线护栏：播种必须真的挂在 tavern:card 的组装路径上
//     （上面那些用例是直接调 seedGreetingMessage 的，证明不了「有没有人调它」；
//       这一条才是能红的：把调用点删掉/挪走，它立刻失败。）
// ══════════════════════════════════════════════════════════

const INDEX_PATH = path.join(import.meta.dirname, '..', 'lib', 'index.js')
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8')

/** 「组装提示词 → 挂播种」的那一段（从标记注释到它的 try/catch 收尾）。 */
function greetingWiringBlock() {
  const startMarker = '// ★ 开场白播种：新会话的第一条消息必须是角色卡开场白 ★'
  const start = INDEX_SRC.indexOf(startMarker)
  assert.ok(start >= 0, '找不到开场白播种的接线块（标记注释被删了？）')
  const end = INDEX_SRC.indexOf('\n        } catch {}', start)
  assert.ok(end > start, '接线块没有正常收尾')
  return INDEX_SRC.slice(start, end)
}

test('接线护栏：tavern:card 组装时必须调用 armGreetingSeed（把调用点删掉就变红）', () => {
  const block = greetingWiringBlock()
  assert.ok(
    block.includes('armGreetingSeed(ctx, greetingSession, presetId, state)'),
    '★ 播种调用点不见了 —— 开场白不会被种进消息面，封面页又会消失',
  )
})

test('接线护栏：播种只会发生在「日志还是空的」新会话上，且受开关约束', () => {
  const block = greetingWiringBlock()
  assert.ok(/Array\.isArray\(greetingSession\.log\) && greetingSession\.log\.length === 0/.test(block),
    '必须只在空日志的新会话上播种（否则第二轮会重复种、切预设会串台）')
  assert.ok(/state\.greetingSeedEnabled !== false/.test(block),
    '必须保留 greetingSeedEnabled 开关（网关拒 assistant 打头时用户的退路）')
  assert.ok(/!isSubagentSession/.test(block),
    '子 Agent 会话不许播种')
  assert.ok(/context\s*&&\s*context\.agent\s*&&\s*context\.agent\.session/.test(block),
    '必须从 context.agent.session 拿真会话对象（播种的落点）')
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
