/**
 * 备选开场白（alternate_greetings）回归测试。
 *
 * 背景（用户反馈）：ST 卡的 `alternate_greetings` 里放的是**另一个开局**（不同时间线 /
 * 对方先开口 / 白天与深夜各一版），而旧实现导入时只留 `first`、注入时也只取第一条 ——
 * 卡里大半开场白在导入那一刻就丢了，面板上也没地方换。现在：
 *   ① 导入端把它们落盘成 `alternates`（见客户端 handleCharFile）；
 *   ② 服务端 `cardGreetings()` 把「第一 → 备选 1 → 备选 2 …」统一编号，
 *      `pickGreetingCard(presetId, cardName, greetingIndex)` 按这个 index 取文；
 *   ③ `greetingOptionsFor()` 给面板列出「有哪些卡 / 每张卡几段 / 各自开头」。
 *
 * 本文件钉住的四件事：
 *   ① 编号稳定：去重之后按下标编号，同一个 index 永远对应同一段文本；
 *   ② 两代字段都认：`alternates`（本插件新导入）与 ST 原生 `alternate_greetings`；
 *   ③ 越界兜底：面板传来的 index 与磁盘不一致时按 0/最后一段收敛，不许报错卡住用户；
 *   ④ 注入真的用选中的那一段（不是"界面能选、注的还是第一条"）。
 *
 * 运行：node tests/greeting-alternates.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 与 greeting-seed.test.js 共用同一个「临时 DSH_HOME」夹具加载器：
// 它在 lib/index.js 求值**之前**把 $DSH_HOME 指到临时目录，测试不碰真机数据。
import { _test, FIXTURE_HOME } from './fixtures/with-temp-dsh-home.js'

const {
  cardGreetings,
  greetingOptionsFor,
  pickGreetingCard,
  insertGreetingForSession,
  GREETING_ALTERNATE_FIELDS,
} = _test

const PRESET_ID = 'preset-fixture-alt-91'
const PRESET_DIR = path.join(FIXTURE_HOME, '.agent-presets', PRESET_ID)

const FIRST = '【第一】第一开场白：从这一刻开始。'
const ALT1 = '【备选一】第二个开局：换一条时间线。'
const ALT2 = '【备选二】第三个开局：这一次对方先开口。'
const LEGACY_A = '【旧字段一】只有 alternate_greetings 的卡，第一段。'
const LEGACY_B = '【旧字段二】只有 alternate_greetings 的卡，第二段。'

// ── 夹具：覆盖四种卡（只为测试构造，不含任何真实卡内容）────────────
fs.mkdirSync(PRESET_DIR, { recursive: true })
fs.writeFileSync(path.join(PRESET_DIR, 'preset.yml'), 'name: 备选开场白夹具\n', 'utf8')
fs.writeFileSync(path.join(PRESET_DIR, 'characters.json'), JSON.stringify([
  { name: '甲', enabled: true, first: FIRST, alternates: [ALT1, ALT2] },
  { name: '乙', enabled: true, alternate_greetings: [LEGACY_A, LEGACY_B] },
  { name: '丙', enabled: true, desc: '有卡但没有开场白' },
  { name: '丁', enabled: false, first: '停用的卡不该出现在清单里' },
], null, 2) + '\n', 'utf8')

/** 最小 Session 替身：只需要 `log` + `append`（闸门与回合号都从 log 里读）。 */
function makeSession() {
  const log = []
  return {
    log,
    append(type, data, opts) {
      log.push({ type, seq: log.length, data, ...(opts && opts.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}) })
    },
  }
}

/** 建立「受保护 head」——开场白闸门只认这一条（见 lib/index.js 的 canAppendGreetingSurface）。 */
function sessionWithHead() {
  const session = makeSession()
  session.append('system/message', {
    turn: 0, step: 0, message: { id: 'sys-head', role: 'system', content: [] },
  }, { surfaceOp: 'append' })
  return session
}

function injectedTexts(session) {
  return session.log
    .filter((e) => e.type === 'assistant/message')
    .map((e) => (e.data.message.content || []).map((b) => b.text || '').join(''))
}

// ══════════════════════════════════════════════════════════════
// 1. cardGreetings：编号 / 去重 / 两代字段
// ══════════════════════════════════════════════════════════════

test('cardGreetings：first 在前，alternates 依次接在后面，编号从 0 起', () => {
  const list = cardGreetings({ name: '甲', first: FIRST, alternates: [ALT1, ALT2] })
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((g) => g.index), [0, 1, 2])
  assert.equal(list[0].text, FIRST)
  assert.equal(list[1].text, ALT1)
  assert.equal(list[2].text, ALT2)
  assert.equal(list[0].label, '第一开场白')
  assert.equal(list[1].label, '备选 1')
  assert.equal(list[2].label, '备选 2')
})

test('cardGreetings：ST 原生 alternate_greetings 也认（旧卡不重导也能换开局）', () => {
  assert.ok(GREETING_ALTERNATE_FIELDS.includes('alternate_greetings'), 'ST 原生字段必须在白名单里')
  const list = cardGreetings({ name: '乙', alternate_greetings: [LEGACY_A, LEGACY_B] })
  assert.deepEqual(list.map((g) => g.text), [LEGACY_A, LEGACY_B], '没有 first 时备选就是第 0、1 段')
})

test('cardGreetings：按文本去重（first 与备选重复时只留一条），编号仍然稳定', () => {
  const list = cardGreetings({ first: '同一段', alternates: ['同一段', ' 另一段 ', '另一段'] })
  assert.deepEqual(list.map((g) => g.text), ['同一段', '另一段'], '重复文本只出现一次，且已 trim')
  assert.deepEqual(list.map((g) => g.index), [0, 1], '去掉重复后下标必须重排成连续值')
})

test('cardGreetings：没有任何开场白字段 ⇒ 空数组（不是 [空串]）', () => {
  assert.deepEqual(cardGreetings({ name: '丙', desc: '只有设定' }), [])
  assert.deepEqual(cardGreetings({ first: '   ', alternates: ['', null, 42] }), [])
  assert.deepEqual(cardGreetings(null), [])
})

// ══════════════════════════════════════════════════════════════
// 2. greetingOptionsFor：面板清单
// ══════════════════════════════════════════════════════════════

test('greetingOptionsFor：列出启用中的卡（停用的不出现），带每段长度与开头预览', () => {
  const r = greetingOptionsFor(PRESET_ID)
  assert.equal(r.ok, true, '夹具预设应当能读出清单：' + JSON.stringify(r).slice(0, 160))
  assert.deepEqual(r.cards.map((c) => c.name), ['甲', '乙', '丙'], '停用的「丁」不该出现')
  const a = r.cards[0]
  assert.equal(a.greetingCount, 3)
  assert.deepEqual(a.greetings.map((g) => g.index), [0, 1, 2])
  assert.equal(a.greetings[0].len, FIRST.length)
  assert.ok(a.greetings[1].preview.startsWith('【备选一】'), '预览应给开头：' + a.greetings[1].preview)
  assert.ok(!a.greetings[1].preview.includes('\n'), '预览必须压平成一行（状态栏只有一行）')
  assert.ok(a.greetings[1].preview.length <= 60, '预览长度要截断到 60 字符内')
  assert.equal(r.cards[1].greetingCount, 2, '只有 alternate_greetings 的卡也要列出两段')
  assert.equal(r.cards[2].greetingCount, 0, '没有开场白的卡仍然列出（面板要能说明原因）')
})

test('greetingOptionsFor：未知预设 / 没有 characters.json 都返回明确错误码', () => {
  assert.match(greetingOptionsFor('preset-does-not-exist-0000').error, /preset-not-found/)
  const bareId = 'preset-fixture-bare-42'
  const dir = path.join(FIXTURE_HOME, '.agent-presets', bareId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 没有角色卡的预设\n', 'utf8')
  assert.match(greetingOptionsFor(bareId).error, /no-characters/)
})

// ══════════════════════════════════════════════════════════════
// 3. pickGreetingCard：按 index 取文 + 越界兜底
// ══════════════════════════════════════════════════════════════

test('pickGreetingCard：index 1 / 2 取到对应备选，并回报总数给面板', () => {
  const r1 = pickGreetingCard(PRESET_ID, '甲', 1)
  assert.equal(r1.ok, true)
  assert.equal(r1.greeting, ALT1)
  assert.equal(r1.greetingIndex, 1)
  assert.equal(r1.greetingCount, 3)
  const r2 = pickGreetingCard(PRESET_ID, '甲', 2)
  assert.equal(r2.greeting, ALT2)
})

test('pickGreetingCard：不传 index = 第一段（旧调用点行为不变）', () => {
  const r = pickGreetingCard(PRESET_ID, '甲')
  assert.equal(r.greeting, FIRST)
  assert.equal(r.greetingIndex, 0)
})

test('pickGreetingCard：越界 / 负数 / 非数字一律收敛，不抛错（列表与磁盘不一致时的兜底）', () => {
  assert.equal(pickGreetingCard(PRESET_ID, '甲', 99).greeting, ALT2, '越界 ⇒ 取最后一段')
  assert.equal(pickGreetingCard(PRESET_ID, '甲', -3).greeting, FIRST, '负数 ⇒ 取第一段')
  assert.equal(pickGreetingCard(PRESET_ID, '甲', 1.7).greeting, ALT1, '小数 ⇒ 向下取整')
  assert.equal(pickGreetingCard(PRESET_ID, '甲', 'x').greeting, FIRST, '非数字 ⇒ 第一段')
  assert.equal(pickGreetingCard(PRESET_ID, '甲', NaN).greeting, FIRST, 'NaN ⇒ 第一段')
})

test('pickGreetingCard：没有开场白的卡返回 no-greeting（错误里点名两代字段）', () => {
  const r = pickGreetingCard(PRESET_ID, '丙')
  assert.equal(r.ok, false)
  assert.match(r.error, /no-greeting/)
  assert.match(r.error, /alternate_greetings/, '错误提示要把备选字段名说出来，用户才知道该补什么')
})

// ══════════════════════════════════════════════════════════════
// 4. 端到端：注入的确实是选中的那一段
// ══════════════════════════════════════════════════════════════

test('insertGreetingForSession：greetingIndex=2 ⇒ 会话末尾落的是第三段，不是第一条', () => {
  const session = sessionWithHead()
  const r = insertGreetingForSession(session, PRESET_ID, '甲', 2)
  assert.equal(r.ok, true, '注入应当成功：' + JSON.stringify(r))
  assert.equal(r.greetingIndex, 2)
  assert.equal(r.greetingCount, 3)
  const texts = injectedTexts(session)
  assert.deepEqual(texts, [ALT2], '★ 注入的正文必须是被选中的那一段（界面能选、注入却发第一条 = 本 bug 的形态）')
  // 同一会话第二次仍然被防重复闸门挡住（换版本也不行 —— 一条会话只允许一条开场白楼）
  const again = insertGreetingForSession(session, PRESET_ID, '甲', 0)
  assert.equal(again.error, 'greeting-already-present')
  assert.deepEqual(injectedTexts(session), [ALT2], '被拒时不得再落第二条')
})

test('insertGreetingForSession：旧字段卡也能按 index 注入', () => {
  const session = sessionWithHead()
  const r = insertGreetingForSession(session, PRESET_ID, '乙', 1)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(injectedTexts(session), [LEGACY_B])
})

test('对照臂（能红）：index 0 与 index 2 落盘文本不同 ⇒ 上一条断言不是恒真', () => {
  const s0 = sessionWithHead()
  insertGreetingForSession(s0, PRESET_ID, '甲', 0)
  const s2 = sessionWithHead()
  insertGreetingForSession(s2, PRESET_ID, '甲', 2)
  assert.notDeepEqual(injectedTexts(s0), injectedTexts(s2), '两段开场白一样的话，index 判据就是恒真的')
})
