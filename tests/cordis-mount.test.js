/**
 * 真 Cordis 宿主挂载测试 —— 把插件挂到**真实的 `@deepseek-ai/cordis`** 里跑一遍。
 *
 * 为什么值得单开一个文件：这个插件有几处「只能靠运行时才能证实」的假设，源码推导证明不了：
 *   ① `inject: ['webServer','systemPrompt','sessions']` 被满足后，apply() 真的跑完
 *      （section / 路由真的注册上）；
 *   ② 插件**自己的 fiber** 能用 `ctx.get('agentPresets')` 解析出宿主提供的服务 ——
 *      整条「原生 preset」路线都建立在这条上面；
 *   ③ **真的注入**：会话挂酒馆预设 ⇒ 卡真的进了 system prompt；
 *      会话挂 `standard` ⇒ 一个字都不进（这就是「注入严格以该会话选中的预设为准」）。
 *
 * 做法：从 DSH 安装目录的 `app.asar` 里就地读出 cordis（**只读**），
 * 在临时 DSH_HOME 里用假服务起一个真 cordis 宿主，把插件挂上去，然后调用它注册的**真路由 / 真 section**。
 *
 * 环境：
 *   · 找不到 asar / cordis（比如非 Desktop 环境）⇒ **skip**，不让它变成假红灯；
 *   · 或者显式给 `DSH_CORDIS_DIR` 指向一个已解出的 cordis 目录（内含 package.json）。
 *
 * 运行：node tests/cordis-mount.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
// 不写死任何本机路径：优先用 DSH_ASAR，其次按标准的 LOCALAPPDATA 安装位置推导。
// 两者都拿不到时会自动跳过依赖 asar 内容的用例（而不是假装通过）。
const ASAR = process.env.DSH_ASAR || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Deepseek Harness EAC v2.0', 'resources', 'app.asar')
  : '')

/** 极简 asar 读取器：只要 header 与「按 offset 读一段字节」两件事。 */
function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jb = Buffer.alloc(jsonLen)
  fs.readSync(fd, jb, 0, jsonLen, 16)
  const header = JSON.parse(jb.toString('utf8'))
  // ★ 数据区起点要对齐 4 字节：漏掉 padding，每个文件都会多出上一个文件的尾巴
  const pad = (4 - (jsonLen % 4)) % 4
  const base = 16 + jsonLen + pad
  const entries = new Map()
  ;(function walk(node, prefix) {
    for (const [k, v] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + k : k
      if (v.files) walk(v, p)
      else entries.set(p, { offset: Number(v.offset), size: v.size })
    }
  })(header, '')
  return {
    has: (p) => entries.has(p),
    read: (p) => {
      const e = entries.get(p)
      if (!e) throw new Error('asar 里没有：' + p)
      const buf = Buffer.alloc(e.size)
      fs.readSync(fd, buf, 0, e.size, base + e.offset)
      return buf
    },
    close: () => { try { fs.closeSync(fd) } catch {} },
  }
}

/** 把 cordis 包解到临时 node_modules 布局里（read-only 从 asar 取，只写临时目录）。 */
function materializeCordis(tmpRoot) {
  const explicit = process.env.DSH_CORDIS_DIR
  if (explicit && fs.existsSync(path.join(explicit, 'package.json'))) return explicit
  if (!fs.existsSync(ASAR)) return ''
  const asar = openAsar(ASAR)
  try {
    const prefix = 'dsh/node_modules/@deepseek-ai/'
    for (const pkg of ['cordis', 'cosmokit']) {
      for (const rel of ['package.json', 'lib/index.js']) {
        const from = prefix + pkg + '/' + rel
        if (!asar.has(from)) return ''
        const dest = path.join(tmpRoot, 'node_modules', '@deepseek-ai', pkg, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, asar.read(from))
      }
    }
    return path.join(tmpRoot, 'node_modules', '@deepseek-ai', 'cordis')
  } finally { asar.close() }
}

const HARNESS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-mount-'))
const CORDIS_DIR = materializeCordis(HARNESS_ROOT)
const skip = CORDIS_DIR ? false : '找不到 DSH 的 app.asar / cordis（非 Desktop 环境？）—— 本文件跳过'

/** 起一个真 cordis 宿主 + 挂上插件，返回观察口。 */
async function bootHost() {
  const home = fs.mkdtempSync(path.join(HARNESS_ROOT, 'home-'))
  fs.mkdirSync(path.join(home, '.agent-presets'), { recursive: true })
  process.env.DSH_HOME = home

  const cordis = await import(pathToFileURL(path.join(CORDIS_DIR, 'lib', 'index.js')).href)
  const root = new cordis.Context()

  const routes = []
  const sections = []
  const agents = new Map()
  const projections = new Map()
  const selectCalls = []

  root.provide('webServer', { register: (r) => routes.push(r) })
  root.provide('systemPrompt', { section: (o) => { sections.push(o); return () => {} } })
  root.provide('sessions', { get: (id) => (id ? { id, header: { id } } : undefined) })
  root.provide('sessionPersistence', { list: async () => [] })
  root.provide('dshHomePath', () => home)
  root.provide('agents', { get: (id) => agents.get(id) })
  root.provide('sessionProjections', {
    stateOf: (session, key) => {
      if (key === 'agentPreset') return projections.get(session && session.id)
      if (key === 'turnBoundary') return { openTurnStartSeq: null, lastTurn: 0 }
      return undefined
    },
  })
  root.provide('agentPresets', {
    list: async () => [{ id: 'standard' }, { id: 'tavern-lite' }],
    select: async (agent, id) => { selectCalls.push([agent && agent.id, id]); return id },
  })

  const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  root.plugin(lib)
  await new Promise((r) => setTimeout(r, 60))

  /** 造一个「活着的」会话（DSH 里就是 agent/created 之后的样子）。 */
  const liveSession = (sid) => {
    const agent = { id: sid, session: { id: sid, header: { id: sid, cwd: home }, log: [] } }
    agents.set(sid, agent)
    lib._test.liveAgents.set(sid, agent)
    return agent
  }
  /** 写一个酒馆预设目录；composition 里带哨兵正文，便于断言"真的注入进来了"。 */
  const tavernPreset = (dirName, sentinel) => {
    const dir = path.join(home, '.agent-presets', dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 测试预设\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
      "- id: persona",
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: |-',
      '      ' + sentinel,
      '',
    ].join('\n'), 'utf8')
    return dir
  }
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path === p)
    if (!route) return reject(new Error('没注册这个路由：' + p))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: p,
      on(type, fn) {
        if (type === 'data' && chunks.length) fn(chunks[0])
        if (type === 'end') fn()
        return req
      },
    }
    const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(String(payload || '{}'))) } catch (e) { reject(e) } } }
    route.handler(req, res)
  })
  return { root, home, routes, sections, agents, projections, selectCalls, lib, liveSession, tavernPreset, call }
}

test('[1] 真 cordis 宿主：插件能 mount，且用自己的 ctx 解析出宿主服务（原生路线的前提）', { skip }, async () => {
  const h = await bootHost()

  assert.deepEqual(h.lib.inject, ['webServer', 'systemPrompt', 'sessions'], 'inject 声明（变了就要重看本测试）')
  assert.ok(h.routes.length >= 30, '插件应当注册了自己的路由，实际 ' + h.routes.length)
  const names = h.sections.map((s) => s.name)
  for (const name of ['tavern:card', 'tavern:edits']) {
    assert.ok(names.includes(name), '缺少 system prompt 段：' + name)
  }
  // 通用增强层（tavern:enhance）与 NSFW 破限段（tavern:nsfw）都已按用户要求删除 —— 不许复活
  assert.equal(names.includes('tavern:enhance'), false, 'tavern:enhance 段必须保持删除')
  assert.equal(names.includes('tavern:nsfw'), false, 'tavern:nsfw 段必须保持删除（这类要求交给 ST 预设）')
  assert.equal(names.length, 2, '目前应当只有 2 个注入段（card / edits），实际：' + names.join(', '))

  const declState = await h.call('/api/tavern/preset-declarations')
  assert.deepEqual(declState.roster, ['standard', 'tavern-lite'],
    '★ 插件自己的 ctx 必须解析得到宿主 agentPresets（拿不到 roster 会是 null）')

  h.root.stop?.()
})

test('[2] 真 cordis 下的**真注入**：会话挂酒馆预设 ⇒ 卡进提示词；挂 standard ⇒ 一个字都不进', { skip }, async () => {
  const SENT = 'CARD_SENTINEL_9c1f3a7b'
  const h = await bootHost()
  h.tavernPreset('tavern-lite', SENT)

  const SID_TAVERN = 'session-on-tavern-0001'
  const SID_PLAIN = 'session-on-standard-0002'
  h.liveSession(SID_TAVERN)
  h.liveSession(SID_PLAIN)
  h.projections.set(SID_TAVERN, 'tavern-lite')   // 会话当下选中的就是酒馆预设
  h.projections.set(SID_PLAIN, 'standard')       // 会话当下选中的是内置 standard

  const card = h.sections.find((s) => s.name === 'tavern:card')
  const edits = h.sections.find((s) => s.name === 'tavern:edits')
  const ctxOf = (sid) => ({ agent: { session: { id: sid, header: { id: sid, cwd: h.home } } } })

  const outTavern = String(card.text(ctxOf(SID_TAVERN)) || '')
  const outPlain = String(card.text(ctxOf(SID_PLAIN)) || '')

  assert.ok(outTavern.includes(SENT), '★ 挂了酒馆预设的会话必须真的拿到卡正文')
  assert.equal(outPlain, '', '★ 挂 standard 的会话一个字都不许注入（会话隔离）')
  assert.ok(!outPlain.includes(SENT))

  // edits 段走另一套数据（被编辑过的历史消息）也要会话隔离：这里没编辑记录 ⇒ 两路都是空
  assert.equal(String(edits.text(ctxOf(SID_TAVERN)) || ''), '', '没有编辑记录时 edits 段应为空')
  assert.equal(String(edits.text(ctxOf(SID_PLAIN)) || ''), '', 'standard 会话 edits 段也必须为空')

  h.root.stop?.()
})

test('[3] 环境判定要一致：解出 cordis 就跑真宿主，解不出就明确 skip（不许静默变假绿灯）', () => {
  assert.equal(skip === false, !!CORDIS_DIR, 'skip 与 CORDIS_DIR 必须一致')
})

test('[4] 真 cordis 事件投递：**深层作用域**发出的 session/event 能到达我们的 watcher（账本随之更新）', { skip }, async () => {
  const h = await bootHost()
  h.tavernPreset('tavern-lite', 'X')

  const { readBindings, writeBindings } = h.lib._test
  const SID_A = 'session-emit-0001'
  const SID_B = 'session-emit-0002'

  // B 先有一条酒馆账本，稍后把它切走
  const all = readBindings()
  all[SID_B] = { mode: 'preset', presetId: 'tavern-lite', source: 'panel' }
  writeBindings(all)

  // ★ 从**子作用域**发事件（DSH 就是这样：会话在自己的 fiber 里 append 后广播，
  //   由 dispatch() 按 hook.global || filter(...) 收集监听者 —— 我们的 watcher 是
  //   `ctx.on('session/event', fn, { global: true })`，所以应当被收集到）。
  let emittedFrom = ''
  h.root.plugin({
    name: 'emit-probe',
    apply(child) {
      emittedFrom = child.fiber?.name || 'child'
      child.emit('session/event', { id: SID_A }, { type: 'agent-preset/selected', data: { agentPreset: 'tavern-lite' } })
      child.emit('session/event', { id: SID_B }, { type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    },
  })
  await new Promise((r) => setTimeout(r, 50))

  const after = readBindings()
  assert.ok(emittedFrom, '探针插件应当已经挂上（说明是从子作用域发的）')
  assert.equal(after[SID_A] && after[SID_A].presetId, 'tavern-lite', '★ 子作用域的选择事件必须到达 watcher')
  assert.equal(after[SID_A].source, 'top-select', '来源如实标成顶部选择')
  assert.deepEqual(after[SID_B], { mode: 'none' }, '★ 切走酒馆卡 ⇒ 账本立刻清成硬空')

  h.root.stop?.()
})
