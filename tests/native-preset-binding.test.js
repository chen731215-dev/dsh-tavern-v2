/**
 * 原生 agent 预设绑定（会话绑定的正路）回归测试
 *
 * 背景（用户诉求）：酒馆预设**就是** DSH agent 预设，「会话绑定」= 该会话的原生
 * agentPreset。老实现只往酒馆自己的 session-bindings.json 记账，且面板在**空白新会话**
 * 上取不到会话 id ⇒ 必须「先发一条消息」才能绑定，首条消息因此裸奔。
 *
 * 本文件锁住三件事：
 *   1. 酒馆预设 id → DSH agent 预设 id（目录名）的换算（default → tavern-lite 等）；
 *   2. 解绑时要交还的 DSH 部署默认预设 id（settings.yaml 的 agent-presets.default）；
 *   3. `agentPresets.select` 调用层的**如实回报**：成功 / locked（会话已开跑）/
 *      服务缺失 / 没有活 Agent / 其他失败，一律结构化返回，绝不静默吞掉。
 *
 * 运行：node --test tests/native-preset-binding.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠ Windows 上不能用 new URL(import.meta.url).pathname（会给出 "/C:/..."）。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

// ROOT / DSH_SETTINGS_FILE 在模块求值时按 $DSH_HOME 绑定，必须先指好再 import。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-binding-'))
process.env.DSH_HOME = TMP_HOME

const PRESET_ROOT = path.join(TMP_HOME, '.agent-presets')
fs.mkdirSync(PRESET_ROOT, { recursive: true })

const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const {
  agentPresetIdFor,
  readDshDefaultAgentPresetId,
  getCtxService,
  findLiveAgent,
  hasTurnStarted,
  selectNativeAgentPreset,
  nativeAgentPresetOf,
  nativePresetRoster,
  armNativePresetWatcher,
  nativeTurnStarted,
  resolveAuthoritativePreset,
  liveAgents,
} = _test

// 造一个「酒馆预设目录」（isTavernPresetDir 要求 preset.yml + agent.cordis.yml 都在）
const TAVERN_DIR = path.join(PRESET_ROOT, 'tavern-lite')
fs.mkdirSync(TAVERN_DIR, { recursive: true })
fs.writeFileSync(path.join(TAVERN_DIR, 'preset.yml'), 'name: 酒馆默认\n', 'utf8')
fs.writeFileSync(path.join(TAVERN_DIR, 'agent.cordis.yml'), '- id: persona\n', 'utf8')

// ── 1. 酒馆预设 id → DSH agent 预设 id ──────────────────────
test('[1] agentPresetIdFor：default 是酒馆别名，DSH 侧真实 id 是目录名 tavern-lite', () => {
  assert.equal(agentPresetIdFor('default'), 'tavern-lite')
})

test('[2] agentPresetIdFor：注册表里的预设按 dir 换算；未知 id 原样（DSH 目录名即 id）', () => {
  fs.writeFileSync(path.join(PRESET_ROOT, 'presets.json'), JSON.stringify({
    presets: [{ id: 'preset-abc', name: 'A', dir: 'preset-abc-dir', mode: 'roleplay' }],
  }, null, 2), 'utf8')
  assert.equal(agentPresetIdFor('preset-abc'), 'preset-abc-dir', '注册表 id → dir')
  assert.equal(agentPresetIdFor('preset-fixture-a2'), 'preset-fixture-a2', '直接是 DSH 目录名或未注册')
  assert.equal(agentPresetIdFor('standard'), 'standard', 'DSH 内置预设原样透传')
  assert.equal(agentPresetIdFor(''), '')
  assert.equal(agentPresetIdFor(null), '')
})

// ── 2. 解绑时交还的 DSH 部署默认预设 ─────────────────────────
const SETTINGS = path.join(TMP_HOME, 'settings.yaml')

test('[3] readDshDefaultAgentPresetId：settings.yaml 不存在时回退 standard（不猜、不抛）', () => {
  try { fs.rmSync(SETTINGS, { force: true }) } catch {}
  assert.equal(readDshDefaultAgentPresetId(), 'standard')
})

test('[4] readDshDefaultAgentPresetId：段式与点号式两种写法都能读', () => {
  fs.writeFileSync(SETTINGS, [
    'model: deepseek-chat',
    'agent-presets:',
    '  default: standard',
    '  something: else',
    '',
  ].join('\n'), 'utf8')
  assert.equal(readDshDefaultAgentPresetId(), 'standard', '段式')

  fs.writeFileSync(SETTINGS, 'agent-presets.default: my-preset\n', 'utf8')
  assert.equal(readDshDefaultAgentPresetId(), 'my-preset', '点号式')

  fs.writeFileSync(SETTINGS, 'model: deepseek-chat\n', 'utf8')
  assert.equal(readDshDefaultAgentPresetId(), 'standard', '没有该字段 ⇒ 回退，绝不编造')
})

// ── 3. 服务获取必须 fail closed（未声明 inject 的裸属性会抛）──
test('[5] getCtxService：ctx.get 抛错 / 服务缺失时返回 undefined，不外抛', () => {
  assert.equal(getCtxService({ get: () => { throw new Error('cannot get property without inject') } }, 'agentPresets'), undefined)
  assert.equal(getCtxService({ get: () => undefined }, 'agentPresets'), undefined)
  assert.equal(getCtxService(null, 'agentPresets'), undefined)
  const svc = { select() {} }
  assert.equal(getCtxService({ get: (n) => (n === 'agentPresets' ? svc : undefined) }, 'agentPresets'), svc)
})

// ── 4. 调用层：成功 / 各类失败一律结构化回报 ──────────────────
function ctxWith(services) {
  return { get: (name) => services[name] }
}

test('[6] selectNativeAgentPreset：参数不全直接 bad-args（不碰服务）', async () => {
  let called = 0
  const ctx = ctxWith({ agentPresets: { select: async () => { called++; return 'x' } } })
  assert.equal((await selectNativeAgentPreset(ctx, '', 'default')).reason, 'bad-args')
  assert.equal((await selectNativeAgentPreset(ctx, 'session-1', '')).reason, 'bad-args')
  assert.equal(called, 0, '参数不全时不得调用 DSH 服务')
})

test('[7] selectNativeAgentPreset：DSH 没提供 agentPresets 服务 ⇒ 如实报 unavailable（走 bindings 兜底）', async () => {
  const out = await selectNativeAgentPreset(ctxWith({}), 'session-1', 'default')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'agent-presets-unavailable')
  assert.equal(out.target, 'tavern-lite', '仍要报出换算后的目标 id，便于排查')
})

test('[8] selectNativeAgentPreset：找不到活 Agent ⇒ no-live-agent（不去猜、不糊弄）', async () => {
  const ctx = ctxWith({ agentPresets: { select: async () => 'tavern-lite' } })
  const out = await selectNativeAgentPreset(ctx, 'session-blank-1', 'default')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-live-agent')
})

test('[9] selectNativeAgentPreset：成功 ⇒ ok，且传给 DSH 的是换算后的目录名', async () => {
  const agent = { session: { log: [] } }
  const seen = []
  const ctx = ctxWith({
    agentPresets: { select: async (a, id) => { seen.push([a, id]); return id } },
    agents: { get: (id) => (id === 'session-blank-1' ? agent : undefined) },
  })
  const out = await selectNativeAgentPreset(ctx, 'session-blank-1', 'default')
  assert.equal(out.ok, true)
  assert.equal(out.presetId, 'tavern-lite')
  assert.deepEqual(seen, [[agent, 'tavern-lite']], '第一参数是 Agent 本体，第二参数是目录名')
  assert.equal(out.started, false, '空白会话：没开跑')
})

test('[10] selectNativeAgentPreset：会话已开跑 ⇒ DSH 抛 agent-preset/locked，折叠为 locked', async () => {
  const agent = { session: { log: [{ type: 'turn/start' }] } }
  const locked = Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
  const ctx = ctxWith({
    agentPresets: { select: async () => { throw locked } },
    agents: { get: () => agent },
  })
  const out = await selectNativeAgentPreset(ctx, 'session-started', 'default')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'locked')
  assert.equal(out.started, true, '如实标记会话已开跑，面板据此给准确提示')
})

test('[11] selectNativeAgentPreset：只有文案、没有 code 的 locked 也要认（不依赖单一实现细节）', async () => {
  const agent = { session: { log: [] } }
  const ctx = ctxWith({
    agentPresets: { select: async () => { throw new Error('This session has already started') } },
    agents: { get: () => agent },
  })
  const out = await selectNativeAgentPreset(ctx, 's1', 'default')
  assert.equal(out.reason, 'locked')
})

test('[12] selectNativeAgentPreset：其他异常fold成 select-failed，并带上原始 code/message', async () => {
  const agent = { session: { log: [] } }
  const boom = Object.assign(new Error('no such preset'), { code: 'agent-preset/unknown' })
  const ctx = ctxWith({
    agentPresets: { select: async () => { throw boom } },
    agents: { get: () => agent },
  })
  const out = await selectNativeAgentPreset(ctx, 's1', 'default')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'select-failed')
  assert.equal(out.code, 'agent-preset/unknown')
  assert.equal(out.message, 'no such preset')
})

// ── 5. 活会话登记表优先于 agents 服务；空白判定 ───────────────
test('[13] findLiveAgent：liveAgents 登记优先，其次问 DSH agents 服务，都没有就是 null', () => {
  const live = { session: { header: { id: 'session-live' }, log: [] } }
  const other = { session: { header: { id: 'session-other' }, log: [] } }
  liveAgents.set('session-live', live)
  try {
    const ctx = ctxWith({ agents: { get: () => other } })
    assert.equal(findLiveAgent(ctx, 'session-live'), live, '登记表优先（agent/created 就在里面，含空白新会话）')
    assert.equal(findLiveAgent(ctxWith({}), 'session-live'), live, '没有 agents 服务也能拿到')
    assert.equal(findLiveAgent(ctx, 'session-nope'), other, '登记表没有 → 退到 agents 服务')
    assert.equal(findLiveAgent(ctxWith({ agents: { get: () => undefined } }), 'session-nope'), null)
    assert.equal(findLiveAgent(ctxWith({}), ''), null)
  } finally {
    liveAgents.delete('session-live')
  }
})

test('[14] hasTurnStarted：turn/start 或 user/message 都算开跑；空日志/缺日志算空白', () => {
  assert.equal(hasTurnStarted({ session: { log: [] } }), false)
  assert.equal(hasTurnStarted({ session: {} }), false)
  assert.equal(hasTurnStarted(null), false)
  assert.equal(hasTurnStarted({ session: { log: [{ type: 'agent-preset/selected' }] } }), false, '选预设本身不算开跑')
  assert.equal(hasTurnStarted({ session: { log: [{ type: 'user/message' }] } }), true)
  assert.equal(hasTurnStarted({ session: { log: [{ type: 'turn/start' }] } }), true)
})

// ── 6. 原生投影读取（不解析 zstd 日志，与 DSH presetForSession 同源）──
/** 造一个带 sessionProjections 的 ctx：stateOf(session,'agentPreset') → value */
function ctxWithProjection(value, session) {
  const sess = session === undefined ? { header: { id: 'session-x' } } : session
  return {
    get: (name) => {
      if (name === 'sessionProjections') return { stateOf: (s, key) => (key === 'agentPreset' ? value : undefined) }
      if (name === 'sessions') return { get: () => sess }
      return undefined
    },
  }
}

test('[15] nativeAgentPresetOf：从 DSH 投影读会话当前预设；服务缺失/会话不在内存/非字符串一律空串', () => {
  assert.equal(nativeAgentPresetOf(ctxWithProjection('tavern-lite'), 'session-x'), 'tavern-lite')
  assert.equal(nativeAgentPresetOf(ctxWithProjection(null), 'session-x'), '', 'header 没有预设 ⇒ null ⇒ 空串')
  assert.equal(nativeAgentPresetOf(ctxWithProjection(undefined), 'session-x'), '', '投影未注册 ⇒ 空串')
  assert.equal(nativeAgentPresetOf(ctxWithProjection('standard', null), 'session-x'), '', '会话不在内存 ⇒ 空串')
  assert.equal(nativeAgentPresetOf(ctxWith({}), 'session-x'), '', 'DSH 没提供该服务 ⇒ 空串（旧版本安全）')
  assert.equal(nativeAgentPresetOf(null, 'session-x'), '')
  assert.equal(nativeAgentPresetOf(ctxWithProjection('tavern-lite'), ''), '')
})

// ── 7. 决议链：日志读不到时，以「会话自己的原生预设」为准 ────────
test('[16] 日志还没落盘 + 会话原生挂的是酒馆预设 ⇒ 就注入它（首条消息不再裸奔）', () => {
  // 该 sessionId 在夹具 home 下没有任何会话目录 ⇒ findSessionFile 返回 null
  const r = resolveAuthoritativePreset('session-fixture', ctxWithProjection('tavern-lite'))
  assert.equal(r.presetId, 'tavern-lite')
  assert.equal(r.source, 'native')
})

test('[17] 日志读不到 + 投影是非酒馆预设 ⇒ 无从证明「有人换过」⇒ 退回账本；账本空 ⇒ 不注入', () => {
  const r = resolveAuthoritativePreset('session-fixture', ctxWithProjection('standard'))
  assert.equal(r.presetId, 'default', '宁可空着也不张冠李戴')
  assert.equal(r.source, 'none', '没有日志、没有账本 ⇒ 没有可取信的来源（不拿投影的出生值当"选择"）')
})

test('[18] 没有 ctx（单测/旧路径）⇒ 决议链与改动前逐字节一致：无日志、无绑定 ⇒ default', () => {
  const r = resolveAuthoritativePreset('session-fixture')
  assert.equal(r.presetId, 'default')
  assert.equal(r.source, 'none')
  assert.equal(r.bindingMode, 'absent')
})

// ── 8. 错误码逐条映射（面板才说得出「为什么没绑成」）────────────
test('[19] selectNativeAgentPreset：DSH 的 not-found / invalid 单独成 reason，不混进兜底', async () => {
  const agent = { session: { log: [] } }
  const mk = (code) => ctxWith({
    agentPresets: { select: async () => { throw Object.assign(new Error(code), { code }) } },
    agents: { get: () => agent },
  })
  assert.equal((await selectNativeAgentPreset(mk('agent-preset/not-found'), 's1', 'default')).reason, 'preset-not-found')
  assert.equal((await selectNativeAgentPreset(mk('agent-preset/invalid'), 's1', 'default')).reason, 'preset-invalid')
})

// ── 10. 决议链：**原生投影优先**（会话当下说的话 > 酒馆旧账本）────
test('[25] 原生投影读得到且是酒馆预设 ⇒ 就注入它（哪怕账本里什么都没有）', () => {
  const { resolveAuthoritativePreset } = _test
  const sid = 'session-fixture'
  const r = resolveAuthoritativePreset(sid, ctxWithProjection('tavern-lite'))
  assert.equal(r.presetId, 'tavern-lite')
  assert.equal(r.source, 'native')
})

test('[26] ★ 顶部切回 standard：账本被 watcher 立刻清空 ⇒ 不注入（串台窗口由**事件**关闭，不靠猜投影）', () => {
  const { resolveAuthoritativePreset, writeBindings, readBindings, armNativePresetWatcher } = _test
  const sid = 'session-fixture'
  // 面板之前绑过这张卡
  const all = readBindings()
  all[sid] = { mode: 'preset', presetId: 'tavern-lite', source: 'panel' }
  writeBindings(all)

  // DSH 发出 agent-preset/selected = standard（内存里立刻发，不等落盘）
  const h = {}
  const dispose = armNativePresetWatcher({ on: (n, f) => { (h[n] = h[n] || []).push(f); return () => {} } })
  try {
    h['session/event'][0]({ id: sid }, { type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    assert.deepEqual(readBindings()[sid], { mode: 'none' }, 'watcher 必须把账本清成硬空')

    // 此刻即便日志还没落盘（读不到 explicit），结论也必须是不注入
    const r = resolveAuthoritativePreset(sid, ctxWithProjection('standard'))
    assert.equal(r.presetId, 'default', '★ 会话说 standard，酒馆就不许再注入酒馆卡')
    assert.equal(r.bindingMode, 'none')
  } finally {
    dispose()
    const back = readBindings()
    delete back[sid]
    writeBindings(back)
  }
})

test('[27] 原生投影读不到（旧版 DSH / 会话不在内存）⇒ 退回日志+账本，行为与改动前一致', () => {
  const { resolveAuthoritativePreset, writeBindings, readBindings } = _test
  const sid = 'session-fixture'
  const all = readBindings()
  all[sid] = { mode: 'preset', presetId: 'tavern-lite', source: 'panel' }
  writeBindings(all)
  try {
    const r = resolveAuthoritativePreset(sid, ctxWith({}))   // 没有投影服务
    assert.equal(r.presetId, 'tavern-lite', '没有投影时账本照旧生效（兼容旧版）')
    assert.equal(r.source, 'binding')
  } finally {
    const back = readBindings()
    delete back[sid]
    writeBindings(back)
  }
})

// ── 11. 已开跑会话的账本不能被「投影 == 出生值」一口咬死 ────────
/** 写一份真会话日志（zstd 帧），让 findSessionFile 找得到它。 */
function writeSessionLog(sid, lines) {
  const dir = path.join(TMP_HOME, 'sessions', 'proj-native', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

test('[28] ★ 已开跑会话（日志在、投影 == 出生值 standard、账本是酒馆卡）⇒ 账本仍然生效', () => {
  const { resolveAuthoritativePreset, writeBindings, readBindings } = _test
  const sid = 'session-fixture'
  // DSH 的出生记录：agentPreset = standard（部署默认），且**从没被换过**
  writeSessionLog(sid, [JSON.stringify({ type: 'session', id: sid, agentPreset: 'standard' })])
  const all = readBindings()
  all[sid] = { mode: 'preset', presetId: 'tavern-lite', source: 'panel' }
  writeBindings(all)
  try {
    // 投影读得到（standard），但它与出生 header 相同 ⇒ 看不出"有人换过"
    const r = resolveAuthoritativePreset(sid, ctxWithProjection('standard'))
    assert.equal(r.presetId, 'tavern-lite', '★ 这种会话只能靠账本跟随（DSH 已锁死预设本体），不能被判成不注入')
    assert.equal(r.source, 'binding')
  } finally {
    const back = readBindings()
    delete back[sid]
    writeBindings(back)
  }
})

test('[29] 日志在、但投影**与出生值不同** ⇒ 以投影为准（刚在顶部换过、帧还没落盘）', () => {
  const { resolveAuthoritativePreset } = _test
  const sid = 'session-fixture'
  writeSessionLog(sid, [JSON.stringify({ type: 'session', id: sid, agentPreset: 'standard' })])
  const r = resolveAuthoritativePreset(sid, ctxWithProjection('tavern-lite'))
  assert.equal(r.presetId, 'tavern-lite')
  assert.equal(r.source, 'native', '换过就有痕迹：投影 != header ⇒ 立刻生效，不等落盘')
})

// ── 13. 「已开跑」判定与 DSH 对齐（turnBoundary 投影优先）────
test('[31] nativeTurnStarted：优先用 DSH 的 turnBoundary 判据，投影读不到才退回日志启发式', () => {
  const { nativeTurnStarted } = _test
  const agent = { session: { log: [] } }
  const ctxWithBoundary = (boundary) => ({
    get: (n) => (n === 'sessionProjections'
      ? { stateOf: (s, key) => (key === 'turnBoundary' ? boundary : undefined) }
      : undefined),
  })

  assert.equal(nativeTurnStarted(ctxWithBoundary({ openTurnStartSeq: null, lastTurn: 0 }), agent), false, '没开过回合')
  assert.equal(nativeTurnStarted(ctxWithBoundary({ openTurnStartSeq: 3, lastTurn: 0 }), agent), true, '回合进行中')
  assert.equal(nativeTurnStarted(ctxWithBoundary({ openTurnStartSeq: null, lastTurn: 5 }), agent), true, '已经跑过 5 轮 ⇒ 永久锁定')

  // ★ 与日志启发式不一致时，以投影为准：日志里找不到痕迹、但投影说已开跑
  const startedAgent = { session: { log: [] } }
  assert.equal(nativeTurnStarted(ctxWithBoundary({ openTurnStartSeq: null, lastTurn: 1 }), startedAgent), true,
    '日志被裁剪/会话是 resume 进来的时候，日志启发式会漏判 —— 投影说了算')

  // 投影不可用（旧版 / 未注册）⇒ 退回日志启发式
  const logAgent = { session: { log: [{ type: 'turn/start' }] } }
  assert.equal(nativeTurnStarted(ctxWith({}), logAgent), true)
  assert.equal(nativeTurnStarted(ctxWith({}), agent), false)
  assert.equal(nativeTurnStarted(null, null), false, '不抛')
})

// ── 14. bundle 模式自动同步后必须提醒「要重新安装」（用例在 preset-declaration.test.js：
//        那边才有可写的假 profile）──────────────────────────
test('[30] armNativePresetWatcher：换成酒馆预设记 top-select；把酒馆卡切走则清成硬空；无关会话不留脏条目', () => {
  const { armNativePresetWatcher, readBindings, writeBindings } = _test
  const handlers = {}
  const fakeCtx = { on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} } }
  const dispose = armNativePresetWatcher(fakeCtx)
  assert.equal(typeof dispose, 'function', '要能卸载（apply 里用 ctx.effect 收口）')
  assert.ok((handlers['session/event'] || []).length === 1, '要订阅 session/event')

  const sidA = 'session-fixture'
  const sidB = 'session-fixture'
  const sidC = 'session-fixture'
  const fire = (sid, picked) => handlers['session/event'][0]({ id: sid }, { type: 'agent-preset/selected', data: { agentPreset: picked } })

  try {
    fire(sidA, 'tavern-lite')
    assert.deepEqual(readBindings()[sidA].mode, 'preset')
    assert.equal(readBindings()[sidA].presetId, 'tavern-lite')
    assert.equal(readBindings()[sidA].source, 'top-select', '顶部选择是最高权威来源')

    // 先给 B 一条酒馆绑定，再把它切走 ⇒ 必须清成硬空
    const all = readBindings()
    all[sidB] = { mode: 'preset', presetId: 'tavern-lite', source: 'panel' }
    writeBindings(all)
    fire(sidB, 'standard')
    assert.deepEqual(readBindings()[sidB], { mode: 'none' }, '★ 切成非酒馆预设 ⇒ 硬空，此后不再注入')

    // C 从来没被酒馆管过：切预设不该往账本里塞脏条目（账本只记酒馆关心过的会话）
    fire(sidC, 'ptc')
    assert.equal(readBindings()[sidC], undefined, '★ 与酒馆无关的会话不留条目')

    // 非该类型的事件 / 空值 / 无 session：一律不动账本
    const before = JSON.stringify(readBindings())
    handlers['session/event'][0]({ id: sidA }, { type: 'turn/start' })
    handlers['session/event'][0]({ id: sidA }, { type: 'agent-preset/selected', data: {} })
    handlers['session/event'][0](null, { type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    assert.equal(JSON.stringify(readBindings()), before, '无关事件不许动账本')
  } finally {
    const back = readBindings()
    delete back[sidA]
    delete back[sidB]
    delete back[sidC]
    writeBindings(back)
    dispose()
  }
})
/** 造一个带 list() 的 agentPresets 服务（名册）。 */
function ctxWithRoster(ids, opts) {
  const o = opts || {}
  const rows = ids.map(id => ({ id, isDefault: id === o.defaultId }))
  return {
    get: (name) => {
      if (name === 'agentPresets') {
        return {
          list: async () => (o.shape === 'wrapped' ? { presets: rows } : rows),
          select: async (agent, presetId) => { o.onSelect && o.onSelect(agent, presetId); return presetId },
        }
      }
      if (name === 'agents') return { get: () => ({ session: { log: [] } }) }
      return undefined
    },
  }
}

test('[20] nativePresetRoster：读名册（数组 / {presets:[…]} 两种形状都吃）', async () => {
  const a = await nativePresetRoster(ctxWithRoster(['standard', 'ptc', 'minimal', 'cordis']))
  assert.equal(a.ok, true)
  assert.deepEqual(a.ids, ['standard', 'ptc', 'minimal', 'cordis'])
  const b = await nativePresetRoster(ctxWithRoster(['standard'], { shape: 'wrapped' }))
  assert.deepEqual(b.ids, ['standard'])
})

test('[21] nativePresetRoster：服务缺失 / list 抛错 ⇒ ok:false（**绝不**当成「名册是空的」）', async () => {
  assert.equal((await nativePresetRoster(ctxWith({}))).ok, false)
  assert.equal((await nativePresetRoster(null)).ok, false)
  const boom = { get: (n) => (n === 'agentPresets' ? { list: async () => { throw new Error('rpc down') } } : undefined) }
  const r = await nativePresetRoster(boom)
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /roster-read-failed/)
})

test('[22] selectNativeAgentPreset：目标不在名册里 ⇒ 直接 not-in-roster（把名册带回去，别让人对着 not-found 猜）', async () => {
  let called = 0
  const ctx = ctxWithRoster(['standard', 'ptc'], { onSelect: () => { called++ } })
  const out = await selectNativeAgentPreset(ctx, 'session-blank', 'default')   // default → tavern-lite，不在名册
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'not-in-roster')
  assert.equal(out.target, 'tavern-lite')
  assert.deepEqual(out.roster, ['standard', 'ptc'])
  assert.equal(called, 0, '★ 不在名册里就不该去调 select（避免注定失败的调用）')
})

test('[23] selectNativeAgentPreset：目标在名册里 ⇒ 正常走到 select（名册不再拦）', async () => {
  let seen = ''
  const ctx = ctxWithRoster(['standard', 'tavern-lite'], { onSelect: (a, id) => { seen = id } })
  const out = await selectNativeAgentPreset(ctx, 'session-blank', 'default')
  assert.equal(out.ok, true)
  assert.equal(seen, 'tavern-lite')
})

test('[24] selectNativeAgentPreset：名册读不到（旧版 DSH）⇒ 绝不因为「不知道名册」而拒绝', async () => {
  let seen = ''
  const ctx = ctxWith({ agentPresets: { select: async (a, id) => { seen = id; return id } }, agents: { get: () => ({ session: { log: [] } }) } })
  const out = await selectNativeAgentPreset(ctx, 'session-blank', 'preset-role')
  assert.equal(out.ok, true, '没有 list() 时按「不知道」处理，继续往下走')
  assert.equal(seen, 'preset-role')
})
