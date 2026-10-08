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
 * 六条自证（缺一条就会变成「给了绿灯也没看」）：
 *   ① 非空跑：必须真的打到**每一条**注册路由（断言行数 == 注册数），并按路径分组点名；
 *   ② 不碰用户数据：全程 tmpdir 的 DSH_HOME；
 *   ③ 断言口径是「**有响应**且不是依赖类错误」—— 不假装知道每条路由的业务正确性
 *      （那由各自的测试负责），但把 `ReferenceError` / `is not defined` /
 *      `is not a function` 单独判红，因为那正是漏传依赖的症状；
 *   ④ 反证：`classifySmoke` 的分类用**合成样本**逐桶断言（见 ④），不许"桶是空的所以全绿"；
 *   ⑤ **逃逸的拒绝必须带归因**（2026-10-08 补）：路由里"发出去就不管"的异步链
 *      （fire-and-forget）抛错时走的是 `unhandledRejection`，node:test 会把它归到**测试文件**名下
 *      —— 消息里没有"哪条路由/哪个方法"，于是"依赖类错误单独判红"这条路径根本没走到
 *      （实测：删掉一个依赖时确实红了，但看不出是谁）。⇒ 这里挂 `process.on('unhandledRejection')`
 *      记录，并把**命中上下文**（方法 + 路径）带进断言消息；每次命中后 drain 两个 setImmediate，
 *      让本轮逃逸的拒绝在上下文还在时被记下。
 *   ⑥ **"抛在响应之前"与"真挂住"分开断言**（2026-10-08 补）：旧实现把两者都塞进"4 秒无响应"
 *      那一条，而病因完全不同（前者 = 路由没处理异常；后者 = 链路挂了/没 end）。
 *      ⇒ 分类函数 `classifySmoke()` 拆成互不重叠的桶，各带自己的消息。
 *   ⑦ **harness 自己有界**（2026-10-08 补，由反证变异C 撞出来）：旧口径 `await maybe` 对 handler
 *      返回的 promise **没有任何超时界** ⇒ 一条 `() => new Promise(() => {})` 的路由会把**整个测试进程
 *      永久挂住**（不是红，是 CI 挂到超时）。现在 handler promise 与响应各有一个 4000ms 界，
 *      超时落进 `handlerHang` 桶（与"响应永不 end"的 `hung` 桶分开）。
 *      ★ 界值没有放宽：仍是同一个 4000ms（把"真挂住"变成"慢"是不允许的）。
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

// ── ⑤ 逃逸的拒绝：捕获 + 归因（上下文 = 当前命中的「方法 + 路径」）──
let currentHit = null
const unhandledRejections = []
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push({
    ctx: currentHit || '（上下文已过时：拒绝在 drain 之后才到达）',
    reason: String((reason && reason.stack) || reason),
  })
})
/** 让本轮逃逸的拒绝在上下文还在时被记下（两个 setImmediate 是实测够用的最小量） */
const drainRejections = () => new Promise((r) => setImmediate(() => setImmediate(r)))

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

/** ⑦ 两个界的值：**与旧口径同一个 4000ms**（不许把"真挂住"调成"慢"）。 */
const HANDLER_MS = 4000
const RESPONSE_MS = 4000
/** 路由级默认界（导出给测试断言"没有为快而放宽"）。 */
export const SMOKE_BOUNDS = { handlerMs: HANDLER_MS, responseMs: RESPONSE_MS }

/** 打一条路由；返回 { method, path, status, hasResponse, handlerHang, thrown, body }。
 *  `bounds` 只给**单测**注入更短的界；路由级默认仍是 SMOKE_BOUNDS（4000ms）。 */
export async function hit(route, method, bounds = {}) {
  const handlerMs = bounds.handlerMs ?? HANDLER_MS
  const responseMs = bounds.responseMs ?? RESPONSE_MS
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
  let handlerHang = false
  currentHit = method + ' ' + route.path
  try {
    const maybe = route.handler(req, res)
    if (maybe && typeof maybe.then === 'function') {
      // ★ ⑦ handler 返回的 promise 也必须**有界**：旧口径直接 `await maybe`，一旦某个 handler 返回
      //   永不 settle 的 promise，**整个测试进程会永久挂住**（不是"红"，是 CI 挂到超时）。
      //   实测（本轮反证变异C）：一条 `() => new Promise(() => {})` 的探针路由就能挂死整份测试。
      let timer = null
      await Promise.race([maybe, new Promise((r) => {
        timer = setTimeout(() => { handlerHang = true; r(null) }, handlerMs)
        if (timer && timer.unref) timer.unref()
      })])
      if (timer) clearTimeout(timer)
    }
  } catch (e) { thrown = e }
  const body = await Promise.race([ended, new Promise((r) => setTimeout(() => r(null), responseMs))])
  await drainRejections()          // ★ ⑤：让本轮 fire-and-forget 的拒绝带着上下文被记下
  currentHit = null
  return {
    method,
    path: route.path,
    status: res.statusCode,
    hasResponse: body !== null,
    handlerHang,
    body: body === null ? '' : body,
    thrown: thrown ? String((thrown && thrown.stack) || thrown) : '',
  }
}

/** 「漏传依赖」的症状：这些模式一旦出现在抛错或响应体里，就是硬失败。 */
const DEP_BUG_RE = /is not defined|is not a function|is not a constructor|ReferenceError|Cannot read properties of undefined \(reading '[^']*'\)/

/**
 * 把逐条命中的记录分进**互不重叠**的失败桶（④ 用合成样本逐桶断言它的分类正确）。
 * 每个坏记录恰好落进一个桶；正常记录哪个桶都不进。
 */
export function classifySmoke(records) {
  const dep = records.filter((r) => (r.thrown && DEP_BUG_RE.test(r.thrown)) || (r.body && DEP_BUG_RE.test(r.body)))
  const rest = records.filter((r) => !dep.includes(r))
  return {
    dep,
    threwBeforeResp: rest.filter((r) => !r.hasResponse && !!r.thrown),
    // ★ ⑦ 两种"真挂住"要分开：`hung` = handler 返回了、但响应永不 end；
    //   `handlerHang` = handler 返回的 promise 自己永不 settle（旧口径会把**测试进程**挂死）
    hung: rest.filter((r) => !r.hasResponse && !r.thrown && !r.handlerHang),
    handlerHang: rest.filter((r) => r.handlerHang),
    threwAfterResp: rest.filter((r) => r.hasResponse && !!r.thrown),
    badStatus: rest.filter((r) => r.hasResponse && (!Number.isInteger(r.status) || r.status < 200 || r.status > 599)),
  }
}

const fmtThrown = (r, n) => r.method + ' ' + r.path + ' → ' + String(r.thrown || r.body).split('\n')[0].slice(0, n)
const fmtPath = (r) => r.method + ' ' + r.path

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

test('② 逐条打：每条路由都要有响应，且不许出现「缺依赖」类错误', (t) => {
  const records = []
  return (async () => {
    for (const route of routes) {
      for (const method of ['GET', 'POST']) records.push(await hit(route, method))
    }
    // ① 每条路由都被打到了（每条各两次）
    const hitPaths = new Set(records.map((r) => r.path))
    assert.equal(hitPaths.size, routes.length, '★ 有路由没被打到：' + routes.map((r) => r.path).filter((p) => !hitPaths.has(p)).join(', '))

    // ★ 可见性（⑤ 的验收要件）：node:test **自己也在监听** `unhandledRejection`，它会先把逃逸的拒绝
    //   记成这条测试的失败，而**那条消息里没有归因**（"红了但看不出是谁"）。所以这里把归因打成
    //   diagnostic —— diagnostic 在测试失败时照样会打印出来。
    for (const u of unhandledRejections) {
      t.diagnostic('逃逸拒绝归因：' + u.ctx + ' → ' + u.reason.split('\n')[0].slice(0, 200))
    }
    const c = classifySmoke(records)
    const busy = Object.keys(c).filter((k) => c[k].length > 0)
    if (busy.length === 0) t.diagnostic('逐条命中 ' + records.length + ' 次；六个失败桶全为空')
    for (const k of busy) {
      t.diagnostic('失败桶 ' + k + '（' + c[k].length + ' 条）：' + c[k].slice(0, 6).map((r) => fmtPath(r) + (r.thrown ? ' → ' + String(r.thrown).split('\n')[0].slice(0, 120) : '')).join(' ｜ '))
    }
    assert.deepEqual(
      c.dep.map((r) => fmtThrown(r, 140)),
      [],
      '★ 出现「缺失依赖」类错误（ReferenceError / not a function / 读不到属性）—— 搬家时漏传了依赖',
    )
    // ★ ⑥ 两条分开：抛在响应之前 ≠ 真挂住（病因不同，消息也不同）
    assert.deepEqual(
      c.threwBeforeResp.map((r) => fmtThrown(r, 160)),
      [],
      '★ 这些请求「抛在响应之前」：路由没处理异常就抛出，客户端拿不到任何响应',
    )
    assert.deepEqual(
      c.hung.map(fmtPath),
      [],
      '★ 这些请求「真挂住（响应永不 end）」：4 秒内既没有响应、也没有抛错',
    )
    assert.deepEqual(
      c.handlerHang.map(fmtPath),
      [],
      '★ 这些路由的 handler 返回的 promise 4 秒内没有 settle —— 旧口径在这里会挂死整个测试进程（不是红，是挂）',
    )
    assert.deepEqual(
      c.threwAfterResp.map((r) => fmtThrown(r, 160)),
      [],
      '★ 这些路由已给出响应、但随后又抛出未处理异常',
    )
    assert.deepEqual(
      c.badStatus.map((r) => fmtPath(r) + ' status=' + r.status),
      [],
      '★ 状态码不是合法 HTTP 码',
    )
    // ★ ⑤ 逃逸的拒绝：必须带「哪条路由 / 哪个方法」——否则 node:test 只会把它记在测试文件名下
    assert.deepEqual(
      unhandledRejections.map((u) => u.ctx + ' → ' + u.reason.split('\n')[0].slice(0, 160)),
      [],
      '★ 出现逃逸的未处理拒绝（fire-and-forget 链抛错）—— 上列每条都带命中归因',
    )
  })()
})

test('④ 反证：classifySmoke 必须把四类失败分对桶（不许"桶是空的所以全绿"）', () => {
  const rec = (o) => Object.assign({ method: 'GET', path: '/api/tavern/x', status: 200, hasResponse: true, handlerHang: false, body: '', thrown: '' }, o)
  const cases = [
    ['缺依赖（抛出）', rec({ hasResponse: false, thrown: 'ReferenceError: json is not defined\n  at ...' }), 'dep'],
    ['缺依赖（响应体里）', rec({ body: '{"error":"readState is not a function"}' }), 'dep'],
    ['抛在响应之前', rec({ hasResponse: false, thrown: 'Error: boom\n  at ...' }), 'threwBeforeResp'],
    ['真挂住（响应永不 end）', rec({ hasResponse: false, thrown: '' }), 'hung'],
    ['handler 永不 settle', rec({ hasResponse: false, handlerHang: true }), 'handlerHang'],
    ['响应后又抛', rec({ hasResponse: true, thrown: 'Error: late\n  at ...' }), 'threwAfterResp'],
    ['非法状态码', rec({ hasResponse: true, status: 0 }), 'badStatus'],
  ]
  for (const [label, r, want] of cases) {
    const c = classifySmoke([r])
    const buckets = Object.keys(c).filter((k) => c[k].length > 0)
    assert.deepEqual(buckets, [want], '★ 「' + label + '」应当**只**落进 ' + want + ' 桶，实际 ' + JSON.stringify(buckets))
  }
  // 分区性：正常记录哪个桶都不进；坏记录恰好一个桶
  const good = rec({})
  assert.deepEqual(Object.keys(classifySmoke([good])).filter((k) => classifySmoke([good])[k].length > 0), [], '正常记录不该进任何失败桶')
  // 对照：真的缺依赖时，这条分类确实会红（而不是恒真）
  const all = [rec({ hasResponse: false, thrown: 'TypeError: x is not a function' })]
  assert.equal(classifySmoke(all).dep.length, 1, '对照：缺依赖必须被认出来')
})

test('③ 清理：临时 DSH_HOME 不在用户真实目录里，且夹具没被写坏', () => {
  assert.ok(path.isAbsolute(TMP_HOME))
  assert.ok(TMP_HOME.toLowerCase().includes('dsh-routes-smoke-'), '用的是系统临时目录：' + TMP_HOME)
  assert.ok(!TMP_HOME.includes('.dsh' + path.sep + '.agent-presets'), '★ 夹具建到用户真实预设目录了')
})

test('⑤⑥⑦ 分支真跑：handler 返回 thenable 的两种情形 + ⑥ 的两个桶（走真 hit()，不是合成记录）', async (t) => {
  // ★ 这条是审核方点名的"判据自己没被执行过"的补课：④ 只把**合成记录**喂给 classifySmoke()，
  //   而仓库里没有任何测试真的走进 `hit()` 里那条"handler 返回 thenable"的分支
  //   ⇒ 少写一个 const 也没人发现（`b2be34b` 就是这么挂的：`HANDLER_MS` 未声明、⑦ 变成死代码、
  //   而且在"handler 正常完成"的情形下**完全隐形** —— race 会落在先 settle 的那个输入上、拒绝被丢弃）。
  //   这里用**探针路由 + 导出后的 hit()** 真跑它。
  //   ★ 界值：只在本测试注入 40ms；**路由级默认仍必须是 4000ms**（下面两条断言钉住，不许为快而放宽）。
  assert.equal(SMOKE_BOUNDS.handlerMs, 4000, '路由级默认的 handler 界不许放宽')
  assert.equal(SMOKE_BOUNDS.responseMs, 4000, '路由级默认的响应界不许放宽')
  const FAST = { handlerMs: 40, responseMs: 40 }
  const bucketsOf = (r) => Object.keys(classifySmoke([r])).filter((k) => classifySmoke([r])[k].length > 0)

  const settled = await hit({ path: '/api/tavern/zz-unit-settled', handler: async (req, res) => { res.writeHead(200); res.end('{}') } }, 'GET', FAST)
  assert.equal(settled.handlerHang, false, '已 settle 的 thenable 不该进 handlerHang')
  assert.equal(settled.hasResponse, true, '已 settle 的 thenable 应当给出响应')
  assert.deepEqual(bucketsOf(settled), [], '已 settle 的情形不该进任何失败桶')

  const pending = await hit({ path: '/api/tavern/zz-unit-pending', handler: () => new Promise(() => {}) }, 'GET', FAST)
  assert.equal(pending.handlerHang, true, '★ 永不 settle 必须落 handlerHang —— 这条断言同时证明⑦那条分支真的被执行到了')
  assert.deepEqual(bucketsOf(pending), ['handlerHang'], '且只落 handlerHang（不许冒充 hung）')

  const noEnd = await hit({ path: '/api/tavern/zz-unit-noend', handler: () => {} }, 'GET', FAST)
  assert.deepEqual(bucketsOf(noEnd), ['hung'], '响应永不 end ⇒ hung（与 handlerHang 分开）')

  const threw = await hit({ path: '/api/tavern/zz-unit-throw', handler: () => { throw new Error('unit-throw') } }, 'GET', FAST)
  assert.deepEqual(bucketsOf(threw), ['threwBeforeResp'], '抛在响应之前 ⇒ threwBeforeResp')

  t.diagnostic('分支真跑（界值 40ms，仅本测试）：settled→无桶 · pending→handlerHang · noend→hung · throw→threwBeforeResp')
})
