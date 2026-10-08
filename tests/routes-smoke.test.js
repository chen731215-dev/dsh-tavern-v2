/**
 * 全路由冒烟：把插件真的 apply() 起来，**逐条**打 36 条 HTTP 路由，断言每条都真的响应、
 * 且**没有** ReferenceError / TypeError 这类「搬出去忘了传依赖」的典型症状。
 *
 * 为什么需要它（S2-C2 后半 / task-7 的安全网）：
 *   把 `apply` 里的路由注册搬进 `lib/server/` 时，依赖要靠参数传。少传一个的后果是
 *   `X is not defined` —— 而**大多数路由自带 try/catch**，这类错误会被吞成 500 或空响应，
 *   「静态集合相等」证明不了运行时真的解析到，所以要有这条**运行时**兜底。
 *   本文件先于搬家落地（AGENTS §5.1「先有安全网再动刀」）。
 *
 * 四条自证（缺一条就会变成「给了绿灯也没看」）：
 *   ① 非空跑：必须真的打到**每一条**注册路由（断言行数 == 注册数），并按路径分组点名；
 *   ② 不碰用户数据：全程 tmpdir 的 DSH_HOME；
 *   ③ 断言口径是「**有响应**且不是依赖类错误」—— 不假装知道每条路由的业务正确性
 *      （那由各自的测试负责），但把 `ReferenceError` / `is not defined` /
 *      `is not a function` 单独判红，因为那正是漏传依赖的症状；
 *   ④ 反证见提交材料（从依赖里删掉 `readState` → 本文件必须报红）。
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

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-routes-smoke-'))
process.env.DSH_HOME = TMP_HOME
const ROOT = path.join(TMP_HOME, '.agent-presets')
const PID = 'preset-smoke'
const SID = 'sid-smoke-0001'

// ── 最小但「能用」的夹具：一份预设（卡 + 世界书 + 角色）+ 一条绑定 + 会话记忆 ──
{
  const dir = path.join(ROOT, PID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 冒烟预设\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
    '- id: persona', '  name: persona', '  config:', '    prefix: |-', '      冒烟卡正文 SMOKE-CARD-71c3', '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([{ name: '冒烟角色', desc: '冒烟角色正文', enabled: true }]), 'utf8')
  fs.writeFileSync(path.join(dir, 'worldbook.json'), JSON.stringify({
    version: 2, injectMode: 'full',
    entries: [{ id: '1', name: '冒烟条目', content: 'SMOKE-WB-8d21', enabled: true, disable: false, constant: true }],
  }), 'utf8')
  fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({
    presets: [{ id: PID, name: '冒烟预设', dir: PID, mode: 'roleplay' }],
  }, null, 2), 'utf8')
  const memDir = path.join(TMP_HOME, 'tavern-data', 'sessions', SID)
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, 'memory.md'), '# 记忆总结 [2026/10/1 10:00:00]\n冒烟记忆 SMOKE-MEM-3f9a\n', 'utf8')
}

const routes = []
const handlers = {}
const logged = []
const liveAgentsMap = new Map()
const services = {
  webServer: { register: (r) => { routes.push(r) } },
  systemPrompt: { section: () => () => {} },
  sessions: { get: (id) => (id ? { id, header: { id, cwd: TMP_HOME } } : undefined) },
  agents: { get: (id) => liveAgentsMap.get(id) },
  agentPresets: { select: async () => 'x', list: async () => [] },
  sessionProjections: { stateOf: () => undefined },
  sessionPersistence: { list: async () => [] },
  dshHomePath: () => TMP_HOME,
  tools: { register: () => () => {}, list: () => [], schemas: () => [] },
}
const ctx = Object.assign({
  get: (n) => services[n],
  on: (n, fn) => { (handlers[n] = handlers[n] || []).push(fn); return () => {} },
  effect: (fn) => fn(),
  logger: { warn: (...a) => logged.push(['warn', a.map(String).join(' ')]), info: () => {}, error: (...a) => logged.push(['error', a.map(String).join(' ')]) },
}, services)

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
_test.writeBindingEntry(SID, { mode: 'preset', presetId: PID, source: 'panel' })
const st0 = _test.readState()
_test.writeState(Object.assign({}, st0, {
  mode: 'global', disabledCwds: [], allowCwds: [], allowSessions: [],
  cardEnabled: true, networkEnabled: false, playerName: '旅行者',
}))
lib.apply(ctx)

/** 打一条路由；返回 { method, status, hasResponse, thrown }。 */
async function hit(route, method) {
  const q = method === 'GET' ? '?sessionId=' + encodeURIComponent(SID) + '&presetId=' + PID : ''
  const url = route.path + q
  const req = method === 'POST'
    ? Object.assign(Readable.from([Buffer.from(JSON.stringify({ sessionId: SID, presetId: PID, mode: 'preset', name: '冒烟', text: 'x', body: 'x' }), 'utf8')]), { method, url, headers: { 'content-type': 'application/json' } })
    : Object.assign(Readable.from([]), { method, url, headers: {} })
  let resolveEnd
  const ended = new Promise((r) => { resolveEnd = r })
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(code) { this.statusCode = code },
    setHeader(k, v) { this.headers[k] = v },
    end(payload) { resolveEnd(String(payload == null ? '' : payload)) },
  }
  let thrown = null
  try {
    const maybe = route.handler(req, res)
    if (maybe && typeof maybe.then === 'function') await maybe
  } catch (e) { thrown = e }
  const body = await Promise.race([ended, new Promise((r) => setTimeout(() => r(null), 4000))])
  return {
    method,
    status: res.statusCode,
    hasResponse: body !== null,
    body: body === null ? '' : body,
    thrown: thrown ? String((thrown && thrown.stack) || thrown) : '',
  }
}

/** 「漏传依赖」的症状：这些模式一旦出现在抛错或响应体里，就是硬失败。 */
const DEP_BUG_RE = /is not defined|is not a function|is not a constructor|ReferenceError|Cannot read properties of undefined \(reading '[^']*'\)/

test('① 非空跑：注册到的每一条路由都必须被真的打到（并按路径点名）', () => {
  assert.ok(routes.length > 0, '★ 一条路由都没注册 —— 判据空跑')
  assert.ok(routes.length >= 30, '注册到的路由只有 ' + routes.length + ' 条 —— 与预期规模不符（难道搬家搬丢了一组？）')
  const paths = routes.map((r) => r.path)
  assert.ok(paths.every((p) => typeof p === 'string' && p.startsWith('/api/tavern/')), '★ 出现非 /api/tavern/ 的路由：' + JSON.stringify(paths.filter((p) => !String(p).startsWith('/api/tavern/'))))
  // 关键分组必须在（粗粒度分组点名，防止"整组搬丢"却仍然全绿）
  for (const frag of ['current-session', 'presets', 'preset-declarations', 'skills', 'bind-preset', 'preset/mode', 'save', 'state', 'summarize', 'worldbook', 'memory', 'sessions', 'prompt-stats', 'settings']) {
    assert.ok(paths.some((p) => p.includes(frag)), '★ 少了一整组路由：' + frag)
  }
})

test('② 逐条打：每条路由都要有响应，且不许出现「缺依赖」类错误', async () => {
  const records = []
  for (const route of routes) {
    for (const method of ['GET', 'POST']) {
      const r = await hit(route, method)
      records.push(Object.assign({ path: route.path }, r))
    }
  }
  // ① 每条路由都被打到了（每条各两次）
  const hitPaths = new Set(records.map((r) => r.path))
  assert.equal(hitPaths.size, routes.length, '★ 有路由没被打到：' + routes.map((r) => r.path).filter((p) => !hitPaths.has(p)).join(', '))

  // ③ 依赖类错误：抛出的 / 或响应体里带出来的，都要判红
  const depBugs = records.filter((r) => (r.thrown && DEP_BUG_RE.test(r.thrown)) || (r.body && DEP_BUG_RE.test(r.body)))
  assert.deepEqual(
    depBugs.map((r) => r.method + ' ' + r.path + ' → ' + (r.thrown || r.body).split('\n')[0].slice(0, 140)),
    [],
    '★ 出现「缺失依赖」类错误（ReferenceError / not a function / 读不到属性）—— 搬家时漏传了依赖',
  )
  // 同步抛错 = 路由没自己处理异常，同样判红（附原文前 160 字）
  const unhandled = records.filter((r) => r.thrown && !DEP_BUG_RE.test(r.thrown))
  assert.deepEqual(unhandled.map((r) => r.method + ' ' + r.path + ' → ' + r.thrown.split('\n')[0].slice(0, 160)), [])

  // ③ 每条都要有「真响应」：拿到响应体，状态码是合法数字
  const noResp = records.filter((r) => !r.hasResponse)
  assert.deepEqual(noResp.map((r) => r.method + ' ' + r.path), [], '★ 这些请求在 4 秒内没有任何响应（挂住/未 end）')
  const badStatus = records.filter((r) => !Number.isInteger(r.status) || r.status < 200 || r.status > 599)
  assert.deepEqual(badStatus.map((r) => r.method + ' ' + r.path + ' status=' + r.status), [], '★ 状态码不是合法 HTTP 码')
})

test('③ 清理：临时 DSH_HOME 不在用户真实目录里，且夹具没被写坏', () => {
  assert.ok(path.isAbsolute(TMP_HOME))
  assert.ok(TMP_HOME.toLowerCase().includes('dsh-routes-smoke-'), '用的是系统临时目录：' + TMP_HOME)
  assert.ok(!TMP_HOME.includes('.dsh' + path.sep + '.agent-presets'), '★ 夹具建到用户真实预设目录了')
})
