/**
 * 原生绑定：**真路由 + 真 apply()** 的端到端回归（假 DSH 服务）
 *
 * 与 native-preset-binding.test.js 的分工：
 *   · 那个文件测纯函数与调用层（agentPresetIdFor / selectNativeAgentPreset / 决议链）；
 *   · 这个文件把 `apply(fakeCtx)` 真的跑起来，把 /api/tavern/bind-preset、
 *     /api/tavern/unbind-preset、/api/tavern/sessions 三个**真路由**接住并调用，
 *     断言面板看到的那份响应 —— 也就是「用户点一下会发生什么」。
 *
 * 钉住的用户诉求（原话）：「保存预设就是保存一个 agent 预设」「只有会话选择了这个酒馆
 * agent 预设就管」「防止串会话」「空白新会话不用先发一条消息就能绑定」。
 *
 * 运行：node --test tests/native-bind-route.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-bind-route-'))
process.env.DSH_HOME = TMP_HOME

const PRESET_ROOT = path.join(TMP_HOME, '.agent-presets')
// 两个酒馆预设（DSH 侧 id = 目录名）+ settings.yaml 的部署默认预设
for (const dir of ['tavern-lite', 'preset-role']) {
  fs.mkdirSync(path.join(PRESET_ROOT, dir), { recursive: true })
  fs.writeFileSync(path.join(PRESET_ROOT, dir, 'preset.yml'), `name: ${dir}\n`, 'utf8')
  fs.writeFileSync(path.join(PRESET_ROOT, dir, 'agent.cordis.yml'), '- id: persona\n', 'utf8')
}
fs.writeFileSync(path.join(PRESET_ROOT, 'presets.json'), JSON.stringify({
  presets: [
    { id: 'default', name: '酒馆默认', dir: 'tavern-lite', mode: 'roleplay' },
    { id: 'preset-role', name: '角色扮演', dir: 'preset-role', mode: 'roleplay' },
  ],
}, null, 2), 'utf8')
fs.writeFileSync(path.join(TMP_HOME, 'settings.yaml'), 'agent-presets:\n  default: standard\n', 'utf8')

// ── 假 DSH：把插件真正 apply() 起来 ─────────────────────────
const SID_BLANK = 'session-fixture'
const SID_OTHER = 'session-fixture'

const routes = []
const sections = {}
const handlers = {}
const selectCalls = []
const liveAgentMap = new Map()          // sessionId → agent（DSH 的 agents 服务）
const projectionOf = new Map()          // sessionId → 原生投影值（agentPreset）
let selectBehaviour = 'ok'              // 'ok' | 'locked' | 'throw'

const fakeAgent = (sid, extra) => Object.assign({ id: sid, session: { id: sid, header: { id: sid }, log: [] } }, extra || {})

const services = {
  webServer: { register: (r) => { routes.push(r) } },
  systemPrompt: { section: (o) => { sections[o.name] = o; return () => {} } },
  sessions: { get: (id) => (id ? { id } : undefined) },
  agents: { get: (id) => liveAgentMap.get(id) },
  agentPresets: {
    select: async (agent, presetId) => {
      selectCalls.push({ agent, presetId })
      if (selectBehaviour === 'locked') {
        throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
      }
      if (selectBehaviour === 'throw') {
        throw Object.assign(new Error('no such preset'), { code: 'agent-preset/not-found' })
      }
      return presetId
    },
  },
  sessionProjections: {
    stateOf: (session, key) => (key === 'agentPreset' ? projectionOf.get(session && session.id) : undefined),
  },
  sessionPersistence: { list: async () => [] },
  dshHomePath: () => TMP_HOME,
}

// 插件的真实调用形态有两套：`ctx.get(name)`（本插件新增的原生能力）与直接属性
// （refresh() 里的 ctx.systemPrompt 就是直接取 —— binding-tristate 的夹具同样如此）。
// 两套都给，才能把 apply() 真跑起来。
const ctx = Object.assign({
  get: (name) => services[name],
  on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}, services)

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
lib.apply(ctx)

// ── 假 HTTP：调用真路由，等 res.end ─────────────────────────
function callRoute(routePath, method, body) {
  const route = routes.find((r) => r.path === routePath)
  assert.ok(route, '路由必须已注册：' + routePath)
  const req = method === 'POST'
    ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body || {}), 'utf8')]), { method, url: routePath })
    : Object.assign(Readable.from([]), { method, url: routePath })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(payload) {
        try { resolve({ status: this.statusCode, body: JSON.parse(String(payload || '{}')) }) }
        catch (e) { reject(new Error('响应不是 JSON：' + String(payload))) }
      },
    }
    try { route.handler(req, res) } catch (e) { reject(e) }
  })
}

/** 造一个「活着但还没发过消息」的空白新会话（DSH 新建对话就是这个形态）。 */
function makeBlankLiveSession(sid) {
  const agent = fakeAgent(sid)
  liveAgentMap.set(sid, agent)
  for (const fn of handlers['agent/created'] || []) fn({ agent })
  return agent
}

// ── 1. 空白新会话：不发消息就能原生绑定 ─────────────────────
test('[1] bind-preset：空白新会话（未发消息）原生绑定成功 —— 这就是「不用先发一条消息」', async () => {
  const agent = makeBlankLiveSession(SID_BLANK)
  selectCalls.length = 0
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: SID_BLANK, presetId: 'preset-role' })

  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.nativeOk, true, '必须走 DSH 原生 agentPresets.select')
  assert.equal(r.body.locked, false)
  assert.equal(selectCalls.length, 1)
  assert.equal(selectCalls[0].agent, agent, '第一参数必须是 Agent 本体（DSH 的签名要求）')
  assert.equal(selectCalls[0].presetId, 'preset-role', '第二参数必须是 DSH agent 预设 id（目录名）')
  assert.equal(r.body.presetId, 'preset-role')
})

test('[2] 酒馆别名 default ⇒ 原生侧换算成目录名 tavern-lite（两套 id 不许混用）', async () => {
  selectCalls.length = 0
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: SID_BLANK, presetId: 'default' })
  assert.equal(r.body.nativeOk, true)
  assert.equal(selectCalls[0].presetId, 'tavern-lite')
})

// ── 2. 会话已开跑：DSH 锁定 ⇒ 如实回报，且不再静默 ──────────
test('[3] bind-preset：会话已开跑（DSH 报 agent-preset/locked）⇒ locked:true，酒馆侧仍记账', async () => {
  selectBehaviour = 'locked'
  selectCalls.length = 0
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: SID_BLANK, presetId: 'preset-role' })
  selectBehaviour = 'ok'

  assert.equal(r.status, 200)
  assert.equal(r.body.nativeOk, false)
  assert.equal(r.body.locked, true, '面板要能说清「卡片本体被 DSH 锁定」')
  assert.equal(r.body.native.reason, 'locked')
  assert.equal(r.body.native.code, 'agent-preset/locked')
  const bindings = JSON.parse(fs.readFileSync(path.join(PRESET_ROOT, 'session-bindings.json'), 'utf8'))
  assert.equal(bindings[SID_BLANK].presetId, 'preset-role', '原生失败时仍保留酒馆侧账本（兼容兜底）')
})

test('[4] bind-preset：原生失败的原因逐条透出（preset-not-found 不混进泛化错误）', async () => {
  selectBehaviour = 'throw'
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: SID_BLANK, presetId: 'preset-role' })
  selectBehaviour = 'ok'
  assert.equal(r.body.nativeOk, false)
  assert.equal(r.body.native.reason, 'preset-not-found')
})

test('[5] bind-preset：漏传 sessionId 直接 400，绝不兜底 lastSessionId（防绑错会话=串台）', async () => {
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { presetId: 'preset-role' })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.match(String(r.body.error), /必传/)
})

// ── 3. 解绑 = 原生交还给 DSH 默认预设 ───────────────────────
test('[6] unbind-preset：把会话原生交还给 settings.yaml 里的部署默认预设（standard）', async () => {
  selectCalls.length = 0
  const r = await callRoute('/api/tavern/unbind-preset', 'POST', { sessionId: SID_BLANK })
  assert.equal(r.status, 200)
  assert.equal(r.body.nativeOk, true)
  assert.equal(r.body.restoredTo, 'standard', '目标必须是 DSH 认识的默认预设，而不是酒馆自己的 default')
  assert.equal(selectCalls[0].presetId, 'standard')
  // 酒馆侧同时写硬空（{mode:'none'}）：注入立刻停，且不会被后面的 fallback 换一张卡
  const bindings = JSON.parse(fs.readFileSync(path.join(PRESET_ROOT, 'session-bindings.json'), 'utf8'))
  assert.deepEqual(bindings[SID_BLANK], { mode: 'none' })
})

// ── 4. 空白会话也要出现在会话列表里（面板才找得到它）────────
test('[7] GET /api/tavern/sessions：把「活着的、还没落盘」的空白新会话一并列出（live/blank 标出来）', async () => {
  const sidNew = 'session-fixture'
  makeBlankLiveSession(sidNew)
  const r = await callRoute('/api/tavern/sessions', 'GET')
  assert.equal(r.status, 200)
  const mine = (r.body.sessions || []).find((s) => s.id === sidNew)
  assert.ok(mine, '刚创建、还没发消息的会话必须出现在列表里（否则面板会说「不在会话列表里」）')
  assert.equal(mine.live, true)
  assert.equal(mine.blank, true, 'blank 表示「还没开跑」⇒ 原生绑定此时一定成功')
  assert.equal(r.body.sessions[0].live, true, '活会话排最前（createdAt=0 会被降序挤掉、还会被 slice 切掉）')
  assert.ok(
    (r.body.sessions || []).some((s) => s.id === SID_BLANK && s.live === true),
    '此前登记的活会话也都要在列表里（面板按当前会话 id 查它自己那一条）',
  )
})

// ── 5. 注入决议：日志未落盘时以「会话自己的原生预设」为准 ────
test('[8] 决议链走原生投影：会话原生挂酒馆预设 ⇒ 注入它；挂 standard ⇒ 不注入（无账本可依时）', () => {
  const { resolveAuthoritativePreset } = _test
  const sidFresh = 'session-fixture'

  projectionOf.set(sidFresh, 'preset-role')
  const hit = resolveAuthoritativePreset(sidFresh, ctx)
  assert.equal(hit.presetId, 'preset-role')
  assert.equal(hit.source, 'native', '投影挂酒馆预设、又没有出生 header 可证是"出生值" ⇒ 就是它')

  projectionOf.set(sidFresh, 'standard')
  const miss = resolveAuthoritativePreset(sidFresh, ctx)
  // 没有日志可证「刚换过」，所以不按投影下结论；账本里也没有它的条目 ⇒ 不注入。
  assert.equal(miss.presetId, 'default', '顶部是 standard 就不注入')
})

// ── 7. 会话列表要给「原生权威」预设（面板才不编状态）──────────
test('[10] GET /api/tavern/sessions：活会话给出原生权威预设 —— 顶部选的卡不再被显示成「未绑定」', async () => {
  const sid = 'session-fixture'
  makeBlankLiveSession(sid)

  projectionOf.set(sid, 'preset-role')
  const r1 = await callRoute('/api/tavern/sessions', 'GET')
  const mine1 = (r1.body.sessions || []).find(s => s.id === sid)
  assert.equal(mine1.authoritativePresetId, 'preset-role', '★ 会话当下生效的预设要如实给出来')
  assert.equal(mine1.authoritativeSource, 'native')
  assert.equal(mine1.live, true)

  // 切回 standard ⇒ 权威值回到 default（面板显示未绑定，且真的不会注入）
  projectionOf.set(sid, 'standard')
  const r2 = await callRoute('/api/tavern/sessions', 'GET')
  const mine2 = (r2.body.sessions || []).find(s => s.id === sid)
  assert.equal(mine2.authoritativePresetId, 'default', '会话没选中酒馆预设 ⇒ 面板必须显示未绑定')
})

// ── 9. 账本里存「DSH 目录名」，'default' 只当哨兵 ─────────────
test('[11] ★ 绑定「酒馆默认」时必须落盘成目录名 tavern-lite —— 存别名会被当成"没绑"（卡不注入）', async () => {
  const sid = 'session-fixture'
  makeBlankLiveSession(sid)
  const r = await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: sid, presetId: 'default' })
  assert.equal(r.status, 200)
  assert.equal(r.body.presetId, 'default', '响应仍用面板的酒馆 id（前端不用改）')
  assert.equal(r.body.nativeOk, true)

  const store = JSON.parse(fs.readFileSync(path.join(PRESET_ROOT, 'session-bindings.json'), 'utf8'))
  assert.equal(store[sid].presetId, 'tavern-lite', '★ 落盘的是 DSH 侧 id（目录名）')
  assert.notEqual(store[sid].presetId, 'default', "'default' 是「不注入」的哨兵，不能存进账本当预设 id")

  // 决议必须因此真的认得它（否则就是"绑了卡却没有卡"）
  // ★ 2026-10-18：2.7.19 起决议只认原生投影。真机上 DSH 在 select 后会更新投影，
  //   夹具里补上这一步（否则断言的是"账本能不能覆盖投影"，那是旧语义）。
  projectionOf.set(sid, 'tavern-lite')
  const { resolveAuthoritativePreset } = _test
  const res = resolveAuthoritativePreset(sid, ctx)
  assert.equal(res.presetId, 'tavern-lite', '★ 绑了酒馆默认 ⇒ 决议就是它，而不是"未绑定"')
  assert.notEqual(res.presetId, 'default')
})

// ── 6. 会话隔离：A 会话的绑定不落到 B 会话 ───────────────────
test('[9] 绑定只写目标会话：给 A 绑定不会动 B 的原生预设/账本（会话隔离）', async () => {
  const sidA = 'session-fixture'
  const sidB = 'session-fixture'
  makeBlankLiveSession(sidA)
  makeBlankLiveSession(sidB)
  const agentB = liveAgentMap.get(sidB)

  selectCalls.length = 0
  await callRoute('/api/tavern/bind-preset', 'POST', { sessionId: sidA, presetId: 'preset-role' })
  assert.equal(selectCalls.length, 1)
  assert.equal(selectCalls[0].agent.id, sidA, '只许动 A 的 Agent')

  const bindings = JSON.parse(fs.readFileSync(path.join(PRESET_ROOT, 'session-bindings.json'), 'utf8'))
  assert.equal(bindings[sidA].presetId, 'preset-role')
  assert.equal(bindings[sidB], undefined, 'B 会话不该被顺手写一条绑定')
  assert.equal(agentB.id, sidB)
})
