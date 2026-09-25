/**
 * P0-6 注入观测日志回归测试
 *
 * 背景：用户报「一个原生 `agentPreset = standard` 的会话，每轮都在注入足控天堂
 *       角色卡 + 世界书」。根因链上三处嫌疑（陈旧自动绑定盖过出生默认 / 解析出
 *       酒馆预设就自动写绑定 / allowlist 双空等价全放行）都还没有**取证手段**：
 *       旧日志只有 `sid / presetId / presetName` 三列，看不出 presetId 是从哪条
 *       路径决议出来的。
 *
 * 本棒只装仪表（**只加不改**）—— 每轮组装完成时往 inject-debug.log 追加一行 JSON：
 *   ts sid bindingMode presetId bindingSource resolvedFrom
 *   cardHash wbHash textLen allowedBy
 *
 * 本套件守四件事：
 *   1. bindingSource 四条路径（explicit / binding / creation / none）各判对一次；
 *   2. 追加的日志行是合法 JSON；
 *   3. 日志里**绝不含 prompt 正文**（喂唯一哨兵，断言搜不到）；
 *   4. 写日志失败（mock 抛异常的写入函数）时注入流程照常返回、不抛。
 *
 * ⚠️ 本套件全程用临时 DSH_HOME，不碰用户真实数据。
 *    运行：node --test tests/inject-observe.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

// ⚠ Windows 上不能用 new URL(import.meta.url).pathname —— 它会给出 "/C:/..."，
//    拼出来的路径会变成 "C:\C:\..."。必须用 fileURLToPath。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

// index.js 在模块加载时就按 $DSH_HOME 绑定 ROOT，必须先指到临时目录再 import
// （与 preset-enhance.test.js / preset-idx.test.js 同款）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inject-observe-'))
const ROOT = path.join(TMP_HOME, '.agent-presets')
const SESSIONS_ROOT = path.join(TMP_HOME, 'sessions')
process.env.DSH_HOME = TMP_HOME

const { _test, apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)

const {
  contentHash16,
  classifyPresetBindingSource,
  readPresetBindingSource,
  observeInjection,
  pickAuthoritativePresetFromLog,
} = _test

// ── 临时酒馆目录布局 ────────────────────────────────────
//  · ROOT/preset-foot/{preset.yml,agent.cordis.yml} → 一个「酒馆可管理」预设
//  · ROOT/session-bindings.json                     → 旧格式绑定记账
//  · SESSIONS_ROOT/<project>/<sid>/session.jsonl    → zstd 压缩的会话事件流
const PRESET_ID = 'preset-foot'
const CARD_SENTINEL = 'SENTINEL-CARD-7f3a9c21'
const WB_SENTINEL = 'SENTINEL-WORLDBOOK-1b8e40d5'

fs.mkdirSync(path.join(ROOT, PRESET_ID), { recursive: true })
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'preset.yml'), 'name: 观测用预设\n')
fs.writeFileSync(
  path.join(ROOT, PRESET_ID, 'agent.cordis.yml'),
  ['- id: persona', '  name: persona', '  config:', '    prefix: |-', '      ' + CARD_SENTINEL, ''].join('\n'),
)
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'characters.json'), JSON.stringify([
  { name: '观测角色', enabled: true, desc: CARD_SENTINEL + '（角色卡正文）' },
]))
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'worldbook.json'), JSON.stringify({
  version: 2,
  entries: [{ id: '1', name: '观测条目', content: WB_SENTINEL, enabled: true, disable: false }],
}))

/**
 * 写一条会话事件流（DSH 用 zstd 分帧写，这里一帧装完即可被 readSessionLines 读出）。
 * @param {string} sid 会话 id（同时作为会话目录名）
 * @param {string[]} lines 事件行（原始 JSONL 文本）
 */
function writeSessionLog(sid, lines) {
  const dir = path.join(SESSIONS_ROOT, 'proj-observe', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

/** 出生默认记录：DSH 新建会话时写的那一行（实测 agentPreset 多为部署默认 standard）。 */
const creationLine = (sid, preset) => JSON.stringify({ type: 'session', id: sid, agentPreset: preset })
/** 用户在聊天顶部显式切换预设的事件行。 */
const explicitLine = (sid, preset) => JSON.stringify({ type: 'event', name: 'agent-preset/selected', id: sid, agentPreset: preset })

// 四条路径各用一条独立会话；bindings 只给 sid-binding 记账，其余留空。
writeSessionLog('sid-explicit', [creationLine('sid-explicit', 'standard'), explicitLine('sid-explicit', PRESET_ID)])
writeSessionLog('sid-binding', [JSON.stringify({ type: 'session', id: 'sid-binding' })])
writeSessionLog('sid-creation', [creationLine('sid-creation', PRESET_ID)])
// 用户报的那个场景：原生 standard 会话，没有显式切换、没有绑定、出生默认也不是酒馆预设
writeSessionLog('sid-none', [creationLine('sid-none', 'standard')])
fs.writeFileSync(path.join(ROOT, 'session-bindings.json'), JSON.stringify({
  'sid-explicit': PRESET_ID,   // 陈旧的自动绑定 —— 但 explicit 必须压过它
  'sid-binding': PRESET_ID,
}))

// ══════════════════════════════════════════════════════════
// 1. 决议来源判定：四条路径各对一次
// ══════════════════════════════════════════════════════════

/** 跑一次观测并取回刚写的那一行（把 fs.writeFileSync 换成捕获器，不落真实日志）。 */
function captureObserveLine(opts) {
  const orig = fs.writeFileSync
  const written = []
  fs.writeFileSync = (file, data) => { written.push(String(data)) }
  try {
    observeInjection(opts)
  } finally {
    fs.writeFileSync = orig
  }
  assert.equal(written.length, 1, '每轮观测应当只追加一行')
  return written[0].trim()
}

const OBSERVE_KEYS = ['ts', 'sid', 'bindingMode', 'presetId', 'bindingSource', 'resolvedFrom', 'cardHash', 'wbHash', 'textLen', 'allowedBy']

test('[1] bindingSource=explicit：顶部显式切换压过陈旧 binding 与出生默认', () => {
  const rec = JSON.parse(captureObserveLine({ sid: 'sid-explicit', presetId: PRESET_ID, cardText: 'x', wbText: '', textLen: 1 }))
  assert.equal(rec.bindingSource, 'explicit')
  assert.equal(rec.resolvedFrom, 'explicit', 'resolvedFrom 与 bindingSource 同义，不另造一套')
  assert.equal(rec.bindingMode, 'legacy', 'bindings 里是旧字符串记账（legacy），要如实记出来')
  assert.equal(rec.presetId, PRESET_ID)
})

// ⚠ P0-1 起 bindings 升级为三态：旧字符串一律读成 source:'legacy'，解析时视为未绑定。
//   下面这条断言的就是新语义 —— 「有旧记账」不再等于「用户绑过这张卡」。
test('[2] bindingSource=legacy：只有旧字符串记账 ⇒ 视为未绑定（不静默注入）', () => {
  const rec = JSON.parse(captureObserveLine({ sid: 'sid-binding', presetId: PRESET_ID, cardText: 'x', wbText: '', textLen: 1 }))
  assert.equal(rec.bindingSource, 'legacy')
  assert.equal(rec.resolvedFrom, 'legacy')
  assert.equal(rec.bindingMode, 'legacy')
})

test('[3] bindingSource=creation：出生默认就是酒馆预设，且没有绑定记账', () => {
  const rec = JSON.parse(captureObserveLine({ sid: 'sid-creation', presetId: PRESET_ID, cardText: 'x', wbText: '', textLen: 1 }))
  assert.equal(rec.bindingSource, 'creation')
  assert.equal(rec.resolvedFrom, 'creation')
  assert.equal(rec.bindingMode, 'absent', 'bindings 里没有这条记账')
})

test('[4] bindingSource=none：三者皆无（原生 standard 会话，出生默认也不是酒馆预设）', () => {
  const rec = JSON.parse(captureObserveLine({ sid: 'sid-none', presetId: 'default', cardText: '', wbText: '', textLen: 0 }))
  assert.equal(rec.bindingSource, 'none')
  assert.equal(rec.resolvedFrom, 'none')
  assert.equal(rec.bindingMode, 'absent')
})

test('[5] 观测标签与真正的决议函数 pickAuthoritativePresetFromLog 优先级一致（不许两套标准）', () => {
  const isTavern = (id) => id === PRESET_ID
  const cases = [
    { name: 'explicit 压过一切', args: [PRESET_ID, 'standard', isTavern, PRESET_ID], source: 'explicit', expect: PRESET_ID },
    { name: 'explicit 是内置预设时也不改来源', args: ['standard', PRESET_ID, isTavern, PRESET_ID], source: 'explicit', expect: 'default' },
    // P0-1：显式绑定是新格式对象（source: panel / top-select）
    { name: 'binding 命中', args: [null, 'standard', isTavern, { mode: 'preset', presetId: PRESET_ID, source: 'panel' }], source: 'binding', expect: PRESET_ID },
    { name: 'binding 失效（预设已删）→ fail closed', args: [null, 'tavern-lite', isTavern, { mode: 'preset', presetId: 'preset-gone', source: 'panel' }], source: 'binding-invalid', expect: 'default' },
    { name: '显式解绑 mode:none → 硬空', args: [null, PRESET_ID, isTavern, { mode: 'none' }], source: 'unbound', expect: 'default' },
    // P0-4：legacy 旧字符串 ⇒ 视为未绑定
    { name: 'legacy 旧字符串 → 不注入', args: [null, 'standard', isTavern, PRESET_ID], source: 'legacy', expect: 'default' },
    { name: 'binding 不是酒馆预设的 legacy → 看 creation', args: [null, PRESET_ID, isTavern, 'standard'], source: 'creation', expect: PRESET_ID },
    { name: '全都没有 → 兜底', args: [null, null, isTavern, ''], source: 'none', expect: 'default' },
  ]
  for (const c of cases) {
    assert.equal(
      classifyPresetBindingSource(...c.args), c.source,
      '来源标签与决议函数不一致（' + c.name + '）—— 日志会对不上账',
    )
    assert.equal(pickAuthoritativePresetFromLog(...c.args), c.expect, c.name)
  }
})

test('[6] readPresetBindingSource 直接读会话日志 + bindings，四种形态都对得上', () => {
  assert.deepEqual(readPresetBindingSource('sid-explicit'), { bindingMode: 'legacy', bindingSource: 'explicit' })
  assert.deepEqual(readPresetBindingSource('sid-binding'), { bindingMode: 'legacy', bindingSource: 'legacy' })
  assert.deepEqual(readPresetBindingSource('sid-creation'), { bindingMode: 'absent', bindingSource: 'creation' })
  assert.deepEqual(readPresetBindingSource('sid-none'), { bindingMode: 'absent', bindingSource: 'none' })
})

// ══════════════════════════════════════════════════════════
// 2. 日志行本身：合法 JSON + 字段齐全
// ══════════════════════════════════════════════════════════

test('[7] 日志行是合法 JSON（JSON.parse 不抛），且字段一个不少、类型正确', () => {
  const line = captureObserveLine({
    sid: 'sid-binding', presetId: PRESET_ID,
    cardText: '角色卡正文', wbText: '世界书正文', textLen: 1234,
    allowedBySession: true, allowedByCwd: false,
  })
  const rec = JSON.parse(line)          // 解析失败会直接抛，测试即红
  assert.deepEqual(Object.keys(rec), OBSERVE_KEYS, '字段集合必须固定，别的一律不记')
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts 必须是 ISO 时间戳')
  assert.equal(rec.sid, 'sid-binding')
  assert.equal(rec.presetId, PRESET_ID)
  assert.equal(rec.textLen, 1234)
  assert.equal(rec.allowedBy, 'session')
  assert.match(rec.cardHash, /^[0-9a-f]{16}$/, 'cardHash 必须是 sha256 前 16 位')
  assert.match(rec.wbHash, /^[0-9a-f]{16}$/, 'wbHash 必须是 sha256 前 16 位')
  assert.equal(rec.cardHash, contentHash16('角色卡正文'))
  assert.equal(rec.wbHash, contentHash16('世界书正文'))
  assert.notEqual(rec.cardHash, rec.wbHash)
})

test('[8] allowedBy 三态：session / cwd / none 各自记对', () => {
  const mk = (opts) => JSON.parse(captureObserveLine({ sid: 'sid-binding', presetId: PRESET_ID, cardText: 'a', wbText: 'b', textLen: 2, ...opts }))
  assert.equal(mk({ allowedBySession: true, allowedByCwd: false }).allowedBy, 'session')
  assert.equal(mk({ allowedBySession: false, allowedByCwd: true }).allowedBy, 'cwd')
  assert.equal(mk({ allowedBySession: false, allowedByCwd: false }).allowedBy, 'none')
})

// ══════════════════════════════════════════════════════════
// 3. 绝不记录 prompt 正文
// ══════════════════════════════════════════════════════════

test('[9] 日志里搜不到 prompt 正文（角色卡 / 世界书哨兵都不许出现）', () => {
  const rec = JSON.parse(captureObserveLine({
    sid: 'sid-binding', presetId: PRESET_ID,
    cardText: '这是角色卡正文，含唯一哨兵 ' + CARD_SENTINEL,
    wbText: '这是世界书正文，含唯一哨兵 ' + WB_SENTINEL,
    textLen: 999,
  }))
  const line = JSON.stringify(rec)
  assert.ok(!line.includes(CARD_SENTINEL), '★ 日志泄漏了角色卡正文 —— 用户明确禁止记正文')
  assert.ok(!line.includes(WB_SENTINEL), '★ 日志泄漏了世界书正文 —— 用户明确禁止记正文')
  assert.ok(!line.includes('这是角色卡正文'), '★ 日志泄漏了正文原文')
  // 反证：指纹确实是从这段内容算出来的（说明哨兵真的喂进去了，不是空跑）
  assert.equal(rec.cardHash, contentHash16('这是角色卡正文，含唯一哨兵 ' + CARD_SENTINEL))
  assert.equal(rec.wbHash, contentHash16('这是世界书正文，含唯一哨兵 ' + WB_SENTINEL))
})

// ══════════════════════════════════════════════════════════
// 4. 真实注入流程：写入失败不挂 + 端到端哨兵检查
// ══════════════════════════════════════════════════════════

// 真实走一遍 apply() → 拿到 tavern:card 这个 section 的组装函数。
// ctx.effect 必须执行回调，否则 refresh(ctx) 不会被调用、section 根本不存在。
const sections = {}
const fakeCtx = {
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => fn(),
  systemPrompt: { section: (o) => { sections[o.name] = o; return () => {} } },
  webServer: { register: () => {} },
  sessions: {},
}
apply(fakeCtx)
const assemble = sections['tavern:card'].text
const LIVE_SID = 'sid-live'
writeSessionLog(LIVE_SID, [creationLine(LIVE_SID, PRESET_ID)])
// 真实流程里 bindings 会被读到（apply → bindDshPaths 已让缓存失效），这里补一条记账
const bindingsPath = path.join(ROOT, 'session-bindings.json')
fs.writeFileSync(bindingsPath, JSON.stringify(JSON.parse(fs.readFileSync(bindingsPath, 'utf8')), null, 2))

const liveContext = { agent: { session: { id: LIVE_SID, header: { id: LIVE_SID } } } }
const LOG_PATH = path.join(ROOT, 'inject-debug.log')

test('[10] 端到端：真实组装会落一行观测日志，且日志里没有正文、注入结果照常带正文', () => {
  const out = assemble(liveContext)
  assert.ok(out.includes(CARD_SENTINEL), '角色卡正文应当真的被注入（否则这条观测没有意义）')
  const log = fs.readFileSync(LOG_PATH, 'utf8')
  const jsonLines = log.split('\n').filter(l => l.trim().startsWith('{'))
  assert.ok(jsonLines.length >= 1, '应当至少落一行观测 JSON')
  const rec = JSON.parse(jsonLines[jsonLines.length - 1])   // 不抛即合法
  assert.deepEqual(Object.keys(rec), OBSERVE_KEYS)
  assert.equal(rec.sid, LIVE_SID)
  assert.equal(rec.presetId, PRESET_ID)
  assert.equal(rec.textLen, out.length, 'textLen 必须是本轮注入的总字符数')
  assert.ok(!log.includes(CARD_SENTINEL), '★ 真实日志里出现了角色卡正文')
  assert.ok(!log.includes(WB_SENTINEL), '★ 真实日志里出现了世界书正文')
})

test('[11] 日志写入失败时（写入函数抛异常）注入流程仍返回正常结果、不抛', () => {
  // 先跑一遍正常轮，拿到基准输出
  const baseline = assemble(liveContext)
  assert.ok(baseline.length > 0, '基准轮必须真的注入了内容')

  // mock 一个抛异常的写入函数
  const orig = fs.writeFileSync
  let threw = false
  fs.writeFileSync = () => { threw = true; throw new Error('磁盘满了（mock）') }
  let out = null
  try {
    out = assemble(liveContext)          // 注入流程本身不许抛
  } finally {
    fs.writeFileSync = orig
  }
  assert.equal(threw, true, 'mock 的写入函数必须真的被调用到（否则这条测试是空跑）')
  assert.equal(out, baseline, '★ 写日志失败后注入结果必须与正常轮逐字节一致')
  assert.ok(out.includes(CARD_SENTINEL))
})

test('[12] 观测调用点被 try/catch 包住（把 catch 删掉就变红）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  assert.ok(
    /try \{\s*observeInjection\(\{[\s\S]*?\}\)\s*\} catch \{\}/.test(src),
    '★ 每轮组装里的 observeInjection 调用没有被 try/catch 包住 —— 写日志失败会把注入打挂',
  )
  assert.ok(
    /try \{ fs\.writeFileSync\(path\.join\(ROOT, 'inject-debug\.log'\), line \+ '\\n', \{ flag: 'a' \}\) \} catch \{\}/.test(src),
    '★ writeInjectObserveRecord 的写入没有静默吞掉异常',
  )
})

test('[13] 清理：临时 DSH_HOME 不在用户真实目录里', () => {
  assert.ok(path.isAbsolute(TMP_HOME))
  assert.ok(TMP_HOME.toLowerCase().includes('dsh-inject-observe-'), '用的是系统临时目录：' + TMP_HOME)
})
