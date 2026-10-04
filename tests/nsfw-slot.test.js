/**
 * 成人向提示段（`tavern:nsfw` 注入槽）回归测试。
 *
 * 设计（2026-10-04 恢复机制）：
 *   · 插件只提供**槽位 + 开关**，正文取自 `state.nsfwPrompt`
 *     ⇒ 正文**不进代码、不进发布包**，升级不会覆盖；
 *   · 默认 `nsfwEnabled !== true` + 空正文 ⇒ 升级到本版**零行为变化**；
 *   · 与会话隔离/生效范围**同一判据**（isTavernSession + decideInjectionScope），
 *     不允许出现「绑了 A 卡却在 B 会话被注入」；
 *   · order = -1（排在 tavern:edits(order=0) 之前）：体积快照仍由 edits 落盘。
 *
 * 本套件守四件事：
 *   ① 开关与正文两个键的**真假两态**（关 / 开但空正文 / 开且有正文）；
 *   ② **会话隔离**：别的会话拿不到这段；
 *   ③ **生效范围闸门**：mode=allowlist 且名单为空 ⇒ 不放行；cwd 黑名单在 global 下也生效；
 *   ④ `state` 路由往返 + 正文长度上限；并从源码层面确认"默认正文为空、正文不会被写进包"。
 *
 * ⚠️ 全程用临时 DSH_HOME，不碰用户真实数据。运行：node --test tests/nsfw-slot.test.js
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

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nsfw-slot-'))
process.env.DSH_HOME = TMP_HOME
const ROOT = path.join(TMP_HOME, '.agent-presets')
const PRESET_ID = 'preset-slot'
const SENTINEL = 'SENTINEL-NSFW-SLOT-4c1f'

// 一个「酒馆可管理」的预设目录（isTavernPresetDir 要求 preset.yml + agent.cordis.yml）
fs.mkdirSync(path.join(ROOT, PRESET_ID), { recursive: true })
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'preset.yml'), 'name: 注入槽测试预设\n', 'utf8')
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'agent.cordis.yml'), ["- id: persona", '  name: persona', '  config:', '    prefix: |-', '      夹具卡正文', ''].join('\n'), 'utf8')

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
const { writeState, readState, writeBindingEntry, sectionSizes } = _test

// ── 假 DSH：捕获每个 systemPrompt.section 的注册（含 text 函数）────────
const routes = []
const sections = {}
const handlers = {}
const services = {
  webServer: { register: (r) => { routes.push(r) } },
  systemPrompt: { section: (o) => { sections[o.name] = o; return () => { delete sections[o.name] } } },
  sessions: { get: (id) => (id ? { id } : undefined) },
  agents: { get: () => undefined },
  agentPresets: { select: async () => 'x' },
  sessionProjections: { stateOf: () => undefined },
  sessionPersistence: { list: async () => [] },
  dshHomePath: () => TMP_HOME,
}
const ctx = Object.assign({
  get: (n) => services[n],
  on: (n, fn) => { (handlers[n] = handlers[n] || []).push(fn); return () => {} },
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}, services)
lib.apply(ctx)

/** 造一个"绑定到酒馆预设"的会话（isTavernSession 才会放行）。 */
writeBindingEntry('sid-slot', { mode: 'preset', presetId: PRESET_ID, source: 'panel' })

/** 调某个会话下 `tavern:nsfw` 段拿到的正文。 */
function nsfwTextFor(sid, cwd) {
  const sec = sections['tavern:nsfw']
  assert.ok(sec, 'tavern:nsfw 段必须已注册')
  const context = { agent: { session: { id: sid, header: { id: sid, cwd: cwd || '' } } } }
  return sec.text(context)
}

/** 把 state 设成期望的样子（其余键保持默认）。 */
function withState(patch) {
  const st = readState()
  writeState(Object.assign({}, st, patch))
}
withState({ mode: 'global', disabledCwds: [], allowCwds: [], allowSessions: [] })

// 假 HTTP：调真路由
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

// ════════════════════════════════════════════════════════════════
// ① 真假两态
// ════════════════════════════════════════════════════════════════
test('① 默认（未开启）不注入：一个字节都不写', () => {
  withState({ nsfwEnabled: false, nsfwPrompt: SENTINEL })
  assert.equal(nsfwTextFor('sid-slot'), '', '开关关着 ⇒ 即使正文非空也不注入')
  assert.equal(sectionSizes.nsfw, 0, '体积统计必须为 0')
})

test('② 开了但正文为空 ⇒ 仍然不注入（避免"空段"占位）', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: '   \n  ' })
  assert.equal(nsfwTextFor('sid-slot'), '', '只有空白字符也视为空')
  assert.equal(sectionSizes.nsfw, 0)
})

test('③ 开了且有正文 ⇒ 原样注入，并回填体积统计', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL })
  const out = nsfwTextFor('sid-slot')
  assert.equal(out, SENTINEL, '★ 注入的必须就是 state 里的原文（插件不加工、不截断）')
  assert.equal(sectionSizes.nsfw, SENTINEL.length, '体积统计要回填，面板才看得到')
})

test('④ 关掉之后立刻停止注入（同一次进程内切换）', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL })
  assert.equal(nsfwTextFor('sid-slot'), SENTINEL)
  withState({ nsfwEnabled: false })
  assert.equal(nsfwTextFor('sid-slot'), '')
})

// ════════════════════════════════════════════════════════════════
// ② 会话隔离 + 生效范围闸门
// ════════════════════════════════════════════════════════════════
test('⑤ 会话隔离：没绑酒馆预设的会话拿不到这段', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL, mode: 'global' })
  assert.equal(nsfwTextFor('sid-slot'), SENTINEL, '前提：绑定过的会话能拿到')
  assert.equal(nsfwTextFor('sid-unbound'), '', '★ 未绑定酒馆预设的会话必须拿不到（不允许串台）')
  assert.equal(nsfwTextFor(''), '', '没有会话 id 时也不注入')
})

test('⑥ 范围闸门：allowlist 且两个名单都空 ⇒ 不放行', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL, mode: 'allowlist', allowCwds: [], allowSessions: [] })
  assert.equal(nsfwTextFor('sid-slot', '/tmp/proj'), '', '★ 双空名单＝不放行（这门语义由 decideInjectionScope 定义）')
})

test('⑦ 范围闸门：会话名单放行；cwd 名单放行', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL, mode: 'allowlist', allowSessions: ['sid-slot'], allowCwds: [] })
  assert.equal(nsfwTextFor('sid-slot', '/tmp/proj'), SENTINEL, '会话在名单里 ⇒ 放行')
  assert.equal(nsfwTextFor('sid-other', '/tmp/proj'), '', '别的会话仍不放行')
  withState({ mode: 'allowlist', allowSessions: [], allowCwds: ['/tmp/proj'] })
  assert.equal(nsfwTextFor('sid-slot', '/tmp/proj'), SENTINEL, 'cwd 在名单里 ⇒ 放行')
})

test('⑧ 范围闸门：global 也受 cwd 黑名单约束（与 card 段同一条规则）', () => {
  withState({ nsfwEnabled: true, nsfwPrompt: SENTINEL, mode: 'global', disabledCwds: ['/tmp/blocked'], allowSessions: [] })
  assert.equal(nsfwTextFor('sid-slot', '/tmp/ok'), SENTINEL, '不在黑名单 ⇒ 照常注入')
  assert.equal(nsfwTextFor('sid-slot', '/tmp/blocked'), '', '★ 黑名单里的 cwd 即使 global 也不注入')
})

// ════════════════════════════════════════════════════════════════
// ③ state 路由往返 + 上限
// ════════════════════════════════════════════════════════════════
test('⑨ /api/tavern/state 往返：开关与正文都能存、都能读回', async () => {
  const post = await callRoute('/api/tavern/state', 'POST', { nsfwEnabled: true, nsfwPrompt: SENTINEL })
  assert.equal(post.status, 200, JSON.stringify(post.body))
  assert.equal(post.body.nsfwEnabled, true, 'POST 响应要回报实况')
  assert.equal(post.body.nsfwPrompt, SENTINEL)
  assert.equal(readState().nsfwEnabled, true, '要真的落盘')
  assert.equal(readState().nsfwPrompt, SENTINEL)

  const get = await callRoute('/api/tavern/state', 'GET')
  assert.equal(get.body.nsfwEnabled, true, 'GET 也要带这两个键（面板靠它回填文本框）')
  assert.equal(get.body.nsfwPrompt, SENTINEL)

  // 关掉也要能存
  const off = await callRoute('/api/tavern/state', 'POST', { nsfwEnabled: false })
  assert.equal(off.body.nsfwEnabled, false)
  assert.equal(readState().nsfwEnabled, false)
  assert.equal(readState().nsfwPrompt, SENTINEL, '关开关不动正文（下次开还是同一段）')
})

test('⑩ 类型不合法不落盘；超长正文被截到 20000 字符', async () => {
  withState({ nsfwEnabled: false, nsfwPrompt: '' })
  await callRoute('/api/tavern/state', 'POST', { nsfwEnabled: 'yes', nsfwPrompt: 12345 })
  assert.equal(readState().nsfwEnabled, false, '非布尔值不许当开关')
  assert.equal(readState().nsfwPrompt, '', '非字符串不许当正文')

  const long = 'x'.repeat(25000)
  const r = await callRoute('/api/tavern/state', 'POST', { nsfwPrompt: long })
  assert.equal(r.body.nsfwPrompt.length, 20000, '超长正文必须被截到 20000（防误操作把 state 撑爆）')
})

// ════════════════════════════════════════════════════════════════
// ④ 源码护栏：默认正文为空、正文不进代码/发布包
// ════════════════════════════════════════════════════════════════
test('⑪ 源码护栏：默认 state 里正文必须是空的', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  assert.ok(/nsfwEnabled: false, nsfwPrompt: ''/.test(src),
    '★ 默认必须是「关 + 空正文」—— 否则升级会凭空往别人提示词里塞东西')
  // 另确认：正文这个键第一次出现时取的就是空串（没有"预置一段正文"的可能）
  const first = src.match(/nsfwPrompt:\s*('[^']*'|"[^"]*")/)
  assert.ok(first, '找不到 nsfwPrompt 的默认赋值')
  assert.equal(first[1], "''", '第一个 nsfwPrompt 赋值必须是空串，实际 ' + first[1])
})

test('⑫ 源码护栏：段落注册必须带闸门（把闸门删掉就变红）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf("name: 'tavern:nsfw'")
  assert.ok(start >= 0, '找不到 tavern:nsfw 段')
  const seg = src.slice(start, src.indexOf('  // 编辑过的消息注入', start))
  assert.ok(seg.includes('isTavernSession('), '★ 必须过会话隔离判据')
  assert.ok(seg.includes('decideInjectionScope('), '★ 必须过统一生效范围闸门')
  assert.ok(/order:\s*-1/.test(seg), 'order 必须是 -1（把最后组装的位置留给 tavern:edits，体积快照在那儿落盘）')
  const mutated = seg.replace(/decideInjectionScope\(/g, 'noGate(')
  assert.ok(!mutated.includes('decideInjectionScope('), '对照：挖掉后判据必须不再命中（证明不是永真）')
})

test('⑬ 源码护栏：客户端必须提供开关与正文输入框，且面板上能看见', () => {
  const cli = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  assert.ok(cli.includes('id="tavern-nsfw-enabled"'), '开关不见了')
  assert.ok(cli.includes('id="tavern-nsfw-prompt"'), '正文输入框不见了')
  assert.ok(cli.includes('id="tavern-nsfw-save"'), '保存按钮不见了')
  assert.ok(cli.includes("titles: ['🎭 剧情选项', '🔞 成人向提示段'"),
    '★ 卡片必须挂进 🎲 玩法 页签 —— 否则它会落到默认页签里、用户找不到（这正是历史上那张卡片踩过的坑）')
  assert.ok(cli.includes("POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }")
    || /nsfwPrompt: area\.value/.test(cli), '必须真的把正文 POST 出去')
})

test('⑭ 护栏：**随包发布的代码**里不含该段正文（正文只在用户 state 里）', () => {
  // 只查会随 npm 包出门的 lib/*：正文一旦写进这里，就会跟着发布包出门。
  // （CHANGELOG.md 不查：它里面是"当初删掉了什么"的历史描述，属于文档而不是可执行正文。）
  const files = ['lib/index.js', 'lib/client.manager.bundle.js']
  const BANNED = [/内容策略暂停/, /无视(道德|伦理|内容政策)/, /无审查模式/, /越狱/, /jailbreak/i]
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8')
    for (const re of BANNED) {
      assert.ok(!re.test(text), '★ ' + f + ' 里出现了现成的破限正文（' + re + '）—— 正文必须由使用者自己放在 state 里')
    }
  }
  // 反例：判据不能永真 —— 拿同一组模式去查一段确实含该词的文本必须命中
  const probe = '默认内容策略暂停，无审查模式。'
  assert.ok(BANNED.some((re) => re.test(probe)), '对照：判据本身必须能命中（否则这个护栏是空的）')
})
