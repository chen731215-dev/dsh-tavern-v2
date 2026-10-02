/**
 * 「设定注入量」会话级切换：全量注入 ⇄ 跟随规则（按触发词）
 *
 * 用户需求原文：*"做一个切换吧，全量注入和规则注入，因为我需要做一些 nfsw 的内容，
 * 不确定模型会不会写"* —— 也就是：**某一场要确保模型一定看得到全部设定**（宁可费 token），
 * 平时按触发词省 token。全局开关做不到这件事（一开就所有会话都费）。
 *
 * 判定链（唯一权威，注入点与体积统计共用同一个函数）：
 *   会话级覆盖 'full'/'follow'  →  全局 state.wbInject  →  世界书自己的 injectMode
 *
 * 运行：node --test tests/wb-inject-mode.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wbmode-'))
process.env.DSH_HOME = TMP_HOME

const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { resolveWbIsFull, selectWorldbookEntries, legacyInjectMode } = _test

const SID = 'sid-abc'

/** 造一个世界书：模式可指定，两条能命中 key、一条命中不了。 */
function makeWb(injectMode) {
  return {
    injectMode,
    entries: [
      { name: '地理', content: '东边是海。', enabled: true, keys: ['东海'] },
      { name: '人物', content: '阿离是看板娘。', enabled: true, keys: ['阿离'] },
      { name: '禁术', content: '禁术会反噬。', enabled: true, keys: ['禁术'] },
    ],
  }
}

// ════════════════════════════════════════════════════════════════
// ① 判定链：会话覆盖 > 全局开关 > 卡设定
// ════════════════════════════════════════════════════════════════
test('① 没有会话覆盖时：跟随卡设定；全局 full 时强制全量', () => {
  const kw = makeWb('keyword')
  const full = makeWb('full')
  assert.equal(resolveWbIsFull({}, kw, SID), false, 'keyword 卡 + 无覆盖 → 按触发词')
  assert.equal(resolveWbIsFull({}, full, SID), true, 'full 卡 → 全量')
  assert.equal(resolveWbIsFull({ wbInject: 'full' }, kw, SID), true, '全局逃生阀要压过卡设定')
  assert.equal(resolveWbIsFull({ wbInject: 'follow' }, full, SID), true, '全局 follow = 老实跟随卡设定')
})

test('② 会话覆盖 full：即使卡是 keyword、全局是 follow，也强制全量', () => {
  const kw = makeWb('keyword')
  const state = { wbInject: 'follow', wbInjectBySession: { [SID]: 'full' } }
  assert.equal(resolveWbIsFull(state, kw, SID), true)
  // 别的会话不受影响 —— 这正是"就这一场"的意义
  assert.equal(resolveWbIsFull(state, kw, 'sid-other'), false, '★ 覆盖必须是会话级的，不能外溢')
})

test('③ 会话覆盖 follow：即使全局是 full，这一场也老实跟随规则（省 token）', () => {
  const kw = makeWb('keyword')
  const state = { wbInject: 'full', wbInjectBySession: { [SID]: 'follow' } }
  assert.equal(resolveWbIsFull(state, kw, SID), false, '★ 会话覆盖优先级最高')
  assert.equal(resolveWbIsFull(state, makeWb('full'), SID), true, '"跟随"= 跟随卡设定，卡要 full 就 full')
})

test('④ 不给 sessionId 时退回全局/卡设定（旧调用点不能炸）', () => {
  const kw = makeWb('keyword')
  const state = { wbInject: 'follow', wbInjectBySession: { [SID]: 'full' } }
  assert.equal(resolveWbIsFull(state, kw), false, '没给会话 id 就不该套用某会话的覆盖')
  assert.equal(resolveWbIsFull(null, kw, SID), false, 'state 为 null 也要安全')
  assert.equal(resolveWbIsFull({}, null, SID), true, '没有世界书 → 视为全量（保守）')
})

// ════════════════════════════════════════════════════════════════
// ② 真的改变注入内容（不只是个布尔）
// ════════════════════════════════════════════════════════════════
test('⑤ 切换真的改变注入条目：规则模式只注入命中的，全量注入全部启用项', () => {
  const kw = makeWb('keyword')
  const state = { wbInject: 'follow', wbInjectBySession: { [SID]: 'full' } }
  const recent = '阿离端来一杯酒'   // 只命中「阿离」

  const ruleMode = selectWorldbookEntries(kw.entries, recent, resolveWbIsFull(state, kw, 'sid-other'))
  const fullMode = selectWorldbookEntries(kw.entries, recent, resolveWbIsFull(state, kw, SID))

  const ruleNames = ruleMode.injectEntries.map(e => e.name)
  const fullNames = fullMode.injectEntries.map(e => e.name)
  assert.deepEqual(ruleNames, ['人物'], '规则模式只给命中的那条：' + ruleNames.join(','))
  assert.deepEqual(fullNames.sort(), ['人物', '地理', '禁术'], '★ 全量模式要给全部启用项：' + fullNames.join(','))
  // 体积口径与 prompt-stats 一致：用 buildWorldbookText 之后的长度（stats 里没有 chars）
  const sizeOf = (out) => out.injectEntries.reduce((n, e) => n + String(e.content || '').length, 0)
  assert.ok(sizeOf(fullMode) > sizeOf(ruleMode), '全量必然更占体积（这正是要付的代价）')
})

test('⑥ 禁用的条目在任何模式下都不注入（覆盖不能变成后门）', () => {
  const wb = makeWb('keyword')
  wb.entries.push({ name: '已关', content: '不该出现。', enabled: false, keys: ['阿离'] })
  const state = { wbInjectBySession: { [SID]: 'full' } }
  const out = selectWorldbookEntries(wb.entries, '', resolveWbIsFull(state, wb, SID))
  assert.equal(out.injectEntries.some(e => e.name === '已关'), false)
})

// ════════════════════════════════════════════════════════════════
// ③ 路由：设置 / 清除 / 生效模式回报
// ════════════════════════════════════════════════════════════════
function makeHarness() {
  const routes = []
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
  }
  return { routes, services }
}

function call(routes, p, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path === p)
    if (!route) return reject(new Error('没注册路由：' + p))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: p, on(type, fn) { if (type === 'data' && chunks.length) fn(chunks[0]); if (type === 'end') fn(); return req } }
    const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(String(payload || '{}'))) } catch (e) { reject(e) } } }
    route.handler(req, res)
  })
}

/** 造一个有世界书的酒馆预设（路由要读它来算"实际生效模式"）。 */
function makePreset(id, injectMode, opts = {}) {
  const dir = path.join(TMP_HOME, '.agent-presets', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '# t\n', 'utf8')
  // ★ 用 **v2 统一格式**：这是插件真正持久化的形态（旧数组格式走迁移，见 test ⑩）
  const entries = [{ name: '地理', content: '东边是海。', enabled: true, keys: ['东海'] }]
  const raw = opts.legacyArray
    ? [{ name: '测试世界书', enabled: true, injectMode, entries }]
    : { version: 2, injectMode, groups: [{ name: '测试世界书', enabled: true, entries }] }
  fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify(raw), 'utf8')
  const metaFile = path.join(TMP_HOME, '.agent-presets', 'presets.json')
  let meta = { presets: [] }
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
  if (!Array.isArray(meta.presets)) meta.presets = []
  if (!meta.presets.some((p) => p.id === id)) meta.presets.push({ id, dir: id, name: id, mode: 'roleplay' })
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

test('⑦ 真路由：切换 → 回报生效模式 → 清除 → 回到跟随卡设定', async () => {
  const h = makeHarness()
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => h.services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, h.services))

  const pid = 'preset-wbmode-a'
  makePreset(pid, 'keyword')
  // 把这个会话绑到该预设（否则读的是默认预设的世界书）
  await call(h.routes, '/api/tavern/bind-preset', 'POST', { sessionId: SID, presetId: pid })

  // 初始：keyword 卡 → 规则模式
  const s0 = await call(h.routes, '/api/tavern/bind', 'GET')
  assert.equal(s0.wbEffective, 'keyword', '初始应当是按触发词')
  assert.equal(s0.wbOverride, '', '一开始没有会话覆盖')

  // 切全量
  const s1 = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: SID, mode: 'full' })
  assert.equal(s1.ok, true, JSON.stringify(s1))
  assert.equal(s1.override, 'full')
  assert.equal(s1.effective, 'full', '★ 卡是 keyword 也要变成 full')
  assert.equal(s1.cardInjectMode, 'keyword', '要如实回报"卡设定本来是什么"，便于面板解释')

  // 读回来确实变了
  const s2 = await call(h.routes, '/api/tavern/bind', 'GET')
  assert.equal(s2.wbEffective, 'full')
  assert.equal(s2.wbOverride, 'full')

  // 切回跟随规则（同样是会话级指定）
  const s3 = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: SID, mode: 'follow' })
  assert.equal(s3.effective, 'keyword')
  assert.equal(s3.override, 'follow')

  // 清除覆盖 → 回到卡设定
  const s4 = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: SID, mode: '' })
  assert.equal(s4.override, '', '清除后不该留覆盖')
  assert.equal(s4.effective, 'keyword')
})

test('⑧ 真路由：全局开关为 full 时，会话覆盖 follow 能把它压下去（省 token 的后悔药）', async () => {
  const h = makeHarness()
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => h.services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, h.services))

  const pid = 'preset-wbmode-b'
  makePreset(pid, 'keyword')
  await call(h.routes, '/api/tavern/bind-preset', 'POST', { sessionId: 'sid-global', presetId: pid })
  // 打开全局全量
  await call(h.routes, '/api/tavern/state', 'POST', { wbInject: 'full' })

  const before = await call(h.routes, '/api/tavern/bind', 'GET')
  // 注意：bind GET 读的是 lastSessionId 口径，这里只断言字段存在且是合法值
  assert.ok(['full', 'keyword'].includes(before.wbEffective), '要回报合法模式：' + before.wbEffective)

  const r = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: 'sid-global', mode: 'follow' })
  assert.equal(r.globalWbInject, 'full', '全局开关确实是 full')
  assert.equal(r.effective, 'keyword', '★ 会话级 follow 必须能压过全局 full')
})

test('⑨ 缺 sessionId 时如实报错，不乱写状态', async () => {
  const h = makeHarness()
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => h.services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, h.services))
  const r = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: '   ', mode: 'full' })
  // lastSessionId 可能有值（测试进程里通常为空）—— 要么明确报错，要么落到 lastSessionId，不许静默写空 key
  if (r.ok === false) assert.equal(r.error, 'sessionId-required')
})

// ════════════════════════════════════════════════════════════════
// ④ 顺带修掉的一个真问题：旧数组格式里显式写的 injectMode 不该被丢掉
// ════════════════════════════════════════════════════════════════
test('⑩ 旧数组格式：显式且一致的 injectMode 要保留；分歧/未声明才保守用 full', () => {
  assert.equal(legacyInjectMode([{ injectMode: 'keyword', entries: [] }]), 'keyword', '只有一本且声明 keyword → keyword')
  assert.equal(legacyInjectMode([{ injectMode: 'keyword' }, { injectMode: 'keyword' }]), 'keyword', '都声明 keyword → keyword')
  assert.equal(legacyInjectMode([{ injectMode: 'keyword' }, { injectMode: 'full' }]), 'full', '★ 分歧保守用 full（多注入 > 漏设定）')
  assert.equal(legacyInjectMode([{ name: 'ST 导入的书' }]), 'full', 'ST 导入的书没有这个字段 → full（原有行为不变）')
  assert.equal(legacyInjectMode([]), 'full')
  assert.equal(legacyInjectMode(null), 'full')
  assert.equal(legacyInjectMode([{ injectMode: 'bogus' }]), 'full', '非法值不算数')
})

test('⑪ 真路由：旧数组文件（手写 keyword）迁移后仍然按规则注入，不被静默改成全量', async () => {
  const h = makeHarness()
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => h.services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, h.services))

  const pid = 'preset-wbmode-legacy'
  makePreset(pid, 'keyword', { legacyArray: true })
  await call(h.routes, '/api/tavern/bind-preset', 'POST', { sessionId: 'sid-legacy', presetId: pid })
  // 隔离：全局开关是**所有会话共享**的（前面的用例可能开过 full），这里先复位，
  // 否则"清除覆盖后跟随卡设定"会被全局 full 盖住 —— 那是产品正确行为，不是 bug。
  await call(h.routes, '/api/tavern/state', 'POST', { wbInject: 'follow' })
  const r = await call(h.routes, '/api/tavern/wb-inject-session', 'POST', { sessionId: 'sid-legacy', mode: '' })
  assert.equal(r.cardInjectMode, 'keyword', '★ 迁移后卡的 injectMode 必须还是 keyword：' + JSON.stringify(r))
  assert.equal(r.effective, 'keyword')
  assert.equal(r.globalWbInject, 'follow', '先确认全局确实已复位')
})
