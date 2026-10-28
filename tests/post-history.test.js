/**
 * 末尾「写作模式」注入（post-history nudge）的回归网。
 *
 * 守什么：
 *   ① 关闭时零行为变化（不加消息、不写任何东西）；
 *   ② 开启后只在**用户回合的第一步**追加一条，且落在消息列表**末尾**；
 *   ③ 追加的是中性位置提示，**不含破限正文**（故事正文不会被污染）；
 *   ④ 非酒馆会话不注入（会话隔离不破）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-post-history-'))
process.env.DSH_HOME = TMP
const ROOT = path.join(TMP, '.agent-presets')
const PRESET = 'preset-post-history'
const SID = 'session-post-history-000000000001'

fs.mkdirSync(path.join(ROOT, PRESET), { recursive: true })
fs.writeFileSync(path.join(ROOT, PRESET, 'preset.yml'), 'name: 末尾注入夹具\n', 'utf8')
fs.writeFileSync(path.join(ROOT, PRESET, 'agent.cordis.yml'), [
  '- id: persona',
  '  name: persona',
  '  config:',
  '    prefix: |-',
  '      POST-HISTORY-FIXTURE-CARD',
  '',
].join('\n'), 'utf8')

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
const { readState, writeState, writeBindingEntry, buildPostHistoryText } = _test

const handlers = {}
const services = {
  webServer: { register: () => {} },
  systemPrompt: { section: () => () => {} },
  sessions: { get: (id) => (id ? { id } : undefined) },
  agents: { get: () => undefined },
  agentPresets: { select: async () => 'x' },
  sessionProjections: {
    stateOf: (session, kind) => {
      const id = session && (session.id || (session.header && session.header.id))
      return kind === 'agentPreset' && id === SID ? PRESET : undefined
    },
  },
  sessionPersistence: { list: async () => [] },
  dshHomePath: () => TMP,
}
const ctx = Object.assign({
  get: (n) => services[n],
  on: (n, fn) => { (handlers[n] = handlers[n] || []).push(fn); return () => {} },
  effect: (fn) => { fn() },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}, services)

lib.apply(ctx)
writeBindingEntry(SID, { mode: 'preset', presetId: PRESET, source: 'panel' })

function setEnabled(v) {
  const st = readState()
  writeState(Object.assign({}, st, { postHistoryEnabled: v }))
}

function preStepHandler() {
  const list = handlers['agent/pre-step'] || []
  assert.ok(list.length >= 1, '必须注册 agent/pre-step 监听')
  return list[list.length - 1]
}

function payload(step, text) {
  return {
    agent: { session: { id: SID, header: { id: SID } } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: text || '继续写' }] }],
    step,
    signal: { aborted: false },
  }
}

test('① 关闭时：一个字节都不加', async () => {
  setEnabled(false)
  const out = await preStepHandler()(payload(1), async () => ({ kind: 'enter', messages: [] }))
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 0, '关掉开关必须零行为变化')
  assert.equal(buildPostHistoryText({ postHistoryEnabled: false }), '')
  assert.equal(buildPostHistoryText({}), '')
})

test('② 开启后：只在 step 1 追加，且落在消息列表末尾', async () => {
  setEnabled(true)
  assert.equal(readState().postHistoryEnabled, true, '夹具：state 要真的写进去')
  assert.ok(buildPostHistoryText(readState()).includes('写作模式'), '夹具：提示文本要非空')
  const first = await preStepHandler()(payload(1), async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages.length, 1, '第一回合要追加')
  assert.equal(first.messages[0].role, 'user')
  assert.equal(first.messages[0].source.kind, 'tavern-post-history', '要用专属 source 标记，便于 UI/后续过滤')
  assert.equal(first.messages[0].source.form, 'instructions', '按 instructions 形态呈现')

  const cont = await preStepHandler()(payload(2), async () => ({ kind: 'enter', messages: [] }))
  assert.equal(cont.messages.length, 0, '工具续跑的 step > 1 不许重复追加')
})

test('③ 追加的是中性位置提示，不含破限正文', async () => {
  setEnabled(true)
  const out = await preStepHandler()(payload(1), async () => ({ kind: 'enter', messages: [] }))
  const text = out.messages[0].content.map(b => b.text || '').join('\n')
  assert.ok(text.includes('写作模式'), '要能识别这是位置提示：' + text)
  assert.ok(text.includes('不要复述'), '必须禁止复述，避免元话进正文：' + text)
  for (const banned of ['破限', '色情', '无限制', '无审查', '露骨', 'R18']) {
    assert.equal(text.includes(banned), false, '提示里不许出现破限词：' + banned)
  }
  assert.ok(text.length < 200, '必须短：' + text.length + ' 字')
})

test('④ 非酒馆会话不注入（会话隔离）', async () => {
  setEnabled(true)
  const p = payload(1)
  p.agent.session.id = 'session-not-tavern-00000000002'
  p.agent.session.header.id = p.agent.session.id
  const out = await preStepHandler()(p, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(out.messages.length, 0, '没绑定酒馆预设的会话不许注入')
})

test('⑤ 出厂默认关闭', () => {
  setEnabled(false)
  const st = readState()
  assert.equal(st.postHistoryEnabled, false, '默认必须是关：新功能不许静默改变老行为')
})
