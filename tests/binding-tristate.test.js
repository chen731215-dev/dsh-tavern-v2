/**
 * P0-1 / P0-2 / P0-4 三态绑定回归测试
 *
 * 背景（根因链，已逐行核实，本套件只守行为、不再考古）：
 *   ① 陈旧绑定盖过出生默认；② 解析出酒馆预设就自动写绑定（9 条脏数据来源）；
 *   ③ 白名单双空等价全放行（**下一棒**，本套件不碰）。
 *
 * 本套件守的验收矩阵（交接文档 P0）：
 *   1 新建会话从不选预设 → 零注入，产物里搜不到哨兵 `_足控天堂2` / `超天酱`
 *   2 显式绑定预设 A → 注入 A
 *   3 旧会话（creation=standard + 遗留绑定）→ legacy 不静默注入
 *   4 顶部显式选回 standard → 立即停止注入，binding 不得翻盘
 *   5 解绑本会话 → 写 {mode:'none'} → 后续零注入（含重新读文件后的持久化语义）
 *   6 绑定被删除的预设 → fail closed，绝不换绑到别的卡
 *   9 两个会话并发切换 → 不串卡
 *
 * 以及三条结构要求：
 *   · 旧字符串格式向后兼容读（读成 source:'legacy'）
 *   · mode:'none' 优先于 creation / 任何 fallback
 *   · P0-2 停写：非显式来源跑完一轮后 session-bindings.json 内容不变
 *
 * ⚠ 全程用临时 DSH_HOME，不碰用户真实数据。
 *    运行：node --test tests/binding-tristate.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

// Windows 上必须用 fileURLToPath（new URL().pathname 会给出 "/C:/..." 拼出 "C:\C:\..."）。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

// index.js 在模块加载时就按 $DSH_HOME 绑定 ROOT，必须先指到临时目录再 import。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-binding-tristate-'))
const ROOT = path.join(TMP_HOME, '.agent-presets')
const SESSIONS_ROOT = path.join(TMP_HOME, 'sessions')
process.env.DSH_HOME = TMP_HOME

const { _test, apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)

const {
  BINDING_SOURCE_PANEL,
  BINDING_SOURCE_TOP_SELECT,
  BINDING_SOURCE_LEGACY,
  normalizeBinding,
  bindingModeOf,
  sessionBindingFields,
  listAgentPresets,
  readBindings,
  writeBindings,
  resetBindingsCache,
  writeBindingEntry,
  resolveAuthoritativePreset,
  pickAuthoritativePresetFromLog,
  migrateLegacyBindings,
  purgeLegacyBindings,
} = _test

// ── 临时酒馆目录布局 ────────────────────────────────────
//  · ROOT/preset-a/{preset.yml,agent.cordis.yml,characters.json,worldbook.json}
//  · ROOT/preset-b/…                      干净的第二张卡（并发/串卡用）
//  · ROOT/preset-foot/…                   「足控天堂」那张误绑定的卡，带真实哨兵
//  · ROOT/session-bindings.json           绑定记账（新旧格式混放）
//  · SESSIONS_ROOT/<proj>/<sid>/session.jsonl   zstd 压缩的会话事件流
const PRESET_A = 'preset-a'
const PRESET_B = 'preset-b'
const PRESET_FOOT = 'preset-foot'
const SENTINEL_A = 'SENTINEL-A-2c81f0'
const SENTINEL_B = 'SENTINEL-B-7d4e19'
// 用户报的那张卡里的真实字样 —— 验收要求：正常会话产物里**搜不到**它们
const FOOT_SENTINELS = ['_足控天堂2', '超天酱']

function makePreset(id, sentinel, extra) {
  const dir = path.join(ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: ' + id + '\n')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
    '- id: persona', '  name: persona', '  config:', '    prefix: |-', '      ' + sentinel, '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([
    { name: '角色' + id, enabled: true, desc: sentinel + '（角色卡正文）' + (extra || '') },
  ]))
  fs.writeFileSync(path.join(dir, 'worldbook.json'), JSON.stringify({
    version: 2,
    entries: [{ id: '1', name: '条目' + id, content: sentinel + '（世界书正文）', enabled: true, disable: false }],
  }))
}
makePreset(PRESET_A, SENTINEL_A)
makePreset(PRESET_B, SENTINEL_B)
makePreset(PRESET_FOOT, 'FOOTCARD', FOOT_SENTINELS.join(' / '))

const BINDINGS_PATH = path.join(ROOT, 'session-bindings.json')

/** 直接改写绑定文件（模拟磁盘现状），并让进程内缓存失效。 */
function setBindings(obj) {
  fs.writeFileSync(BINDINGS_PATH, JSON.stringify(obj, null, 2), 'utf8')
  resetBindingsCache()
}
function readBindingsFileRaw() {
  return fs.readFileSync(BINDINGS_PATH, 'utf8')
}
function parseBindingsFile() {
  return JSON.parse(readBindingsFileRaw())
}

// ── 会话事件流 ─────────────────────────────────────────
function writeSessionLog(sid, lines) {
  const dir = path.join(SESSIONS_ROOT, 'proj-tristate', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}
/** 出生默认记录：DSH 新建会话写的那一行（新建会话几乎总是部署默认 standard）。 */
const creationLine = (sid, preset) => JSON.stringify({ type: 'session', id: sid, agentPreset: preset })
/** 用户在聊天顶部显式切换预设的事件行。 */
const explicitLine = (sid, preset) => JSON.stringify({ type: 'event', name: 'agent-preset/selected', id: sid, agentPreset: preset })

// ── 真实注入管线 ───────────────────────────────────────
// ctx.effect 必须执行回调，否则 refresh(ctx) 不会被调用、section 根本不存在。
const sections = {}
apply({
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => fn(),
  systemPrompt: { section: (o) => { sections[o.name] = o; return () => {} } },
  webServer: { register: () => {} },
  sessions: {},
})
const assemble = sections['tavern:card'].text
const ctxOf = (sid) => ({ agent: { session: { id: sid, header: { id: sid } } } })

/** 断言产物里**没有**任何一张不该出现的卡（尤其足控天堂的两个哨兵）。 */
function assertNoInjection(out, why) {
  for (const s of FOOT_SENTINELS) assert.ok(!String(out).includes(s), '★ 泄漏了足控天堂哨兵 ' + s + '（' + why + '）')
}

// ══════════════════════════════════════════════════════════
// 一、归一化：旧格式向后兼容读 + 三态判别
// ══════════════════════════════════════════════════════════

test('[1] normalizeBinding：旧字符串格式向后兼容读成 legacy（面板不许白屏）', () => {
  assert.deepEqual(normalizeBinding('preset-abc'), {
    mode: 'preset', presetId: 'preset-abc', source: 'legacy', at: 0, rev: 0,
  })
  // 文件里真的有旧字符串时，统一读出来的形态
  setBindings({ 'sid-old': 'preset-abc', 'sid-new': { mode: 'preset', presetId: PRESET_A, source: 'panel', at: 1, rev: 2 } })
  const all = readBindings()
  assert.deepEqual(all['sid-old'], { mode: 'preset', presetId: 'preset-abc', source: 'legacy', at: 0, rev: 0 })
  assert.equal(all['sid-new'].presetId, PRESET_A)
  assert.equal(all['sid-new'].source, 'panel')
})

test('[2] normalizeBinding：三态各自归一 + 非法条目按 legacy（不得当成 none，也不得触发 fallback）', () => {
  assert.deepEqual(normalizeBinding({ mode: 'none' }), { mode: 'none' })
  assert.equal(normalizeBinding({ mode: 'preset', presetId: PRESET_A, source: 'top-select' }).source, 'top-select')
  // 非法 / 缺字段 → legacy，presetId 为空（解析时无从注入）
  assert.deepEqual(normalizeBinding({ mode: 'preset' }), { mode: 'preset', presetId: '', source: 'legacy', at: 0, rev: 0 })
  assert.deepEqual(normalizeBinding({ foo: 1 }), { mode: 'preset', presetId: '', source: 'legacy', at: 0, rev: 0 })
  for (const junk of [null, undefined, '', 0, [], false]) assert.equal(normalizeBinding(junk), null, '垃圾值视为 absent')
  // 未知 source 一律降级为 legacy（保守）
  assert.equal(normalizeBinding({ mode: 'preset', presetId: PRESET_A, source: 'who-knows' }).source, 'legacy')
  assert.equal(bindingModeOf('preset-abc'), 'legacy')
  assert.equal(bindingModeOf({ mode: 'none' }), 'none')
  assert.equal(bindingModeOf({ mode: 'preset', presetId: PRESET_A, source: 'panel' }), 'preset')
  assert.equal(bindingModeOf(undefined), 'absent')
})

test('[3] 只写新格式：writeBindings 吃下旧格式后落盘的每条都是对象', () => {
  writeBindings({ 'sid-x': 'preset-abc', 'sid-y': { mode: 'none' } })
  const onDisk = parseBindingsFile()
  assert.deepEqual(onDisk['sid-x'].mode, 'preset')
  assert.equal(onDisk['sid-x'].presetId, 'preset-abc')
  assert.equal(onDisk['sid-x'].source, 'legacy')
  assert.ok(Number.isFinite(onDisk['sid-x'].at) && onDisk['sid-x'].at > 0, '补写 at')
  assert.deepEqual(onDisk['sid-y'], { mode: 'none' })
  assert.ok(!Object.values(onDisk).some(v => typeof v === 'string'), '★ 落盘里不许再出现旧字符串格式')
  resetBindingsCache()
})

// ══════════════════════════════════════════════════════════
// 二、判定顺序：explicit > none > preset > creation > 兜底
// ══════════════════════════════════════════════════════════

const isTavern = (id) => id === PRESET_A || id === PRESET_B || id === PRESET_FOOT

test('[4] mode:none 是硬空：不看 creation、不看任何 fallback', () => {
  const none = { mode: 'none' }
  assert.equal(pickAuthoritativePresetFromLog(null, PRESET_A, isTavern, none), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, PRESET_FOOT, isTavern, none), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, null, isTavern, none), 'default')
  // legacy 与 none 同时存在（对象里 mode 说了算）
  assert.equal(pickAuthoritativePresetFromLog(null, PRESET_A, isTavern, { mode: 'none', presetId: PRESET_A, source: 'legacy' }), 'default')
})

test('[5] 判定顺序：顶部随后显式选的预设 > 显式解绑 > 显式绑定 > 出生默认', () => {
  // ① explicit 压过 none（用户随后在顶部选了新预设，以显式选择为准）
  assert.equal(pickAuthoritativePresetFromLog(PRESET_A, 'standard', isTavern, { mode: 'none' }), PRESET_A)
  // ② explicit 是内置预设 → 也不翻盘到绑定
  assert.equal(pickAuthoritativePresetFromLog('standard', 'standard', isTavern, { mode: 'preset', presetId: PRESET_A, source: 'panel' }), 'default')
  // ③ none 压过 preset 绑定与 creation
  assert.equal(pickAuthoritativePresetFromLog(null, PRESET_B, isTavern, { mode: 'none' }), 'default')
  // ④ preset 绑定压过 creation
  assert.equal(pickAuthoritativePresetFromLog(null, PRESET_B, isTavern, { mode: 'preset', presetId: PRESET_A, source: 'panel' }), PRESET_A)
  // ⑤ legacy 不注入，让位给 creation；creation 也不是酒馆预设 → 兜底 default
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, PRESET_FOOT), 'default')
  // ⑥ 都没有 → default
  assert.equal(pickAuthoritativePresetFromLog(null, null, isTavern, null), 'default')
})

test('[6] 绑定被删除的预设 → fail closed：返回 default，**绝不换绑到别的卡**', () => {
  // creation 是另一张真实存在的酒馆卡；若退回 creation 就等于悄悄换了一张卡。
  assert.equal(
    pickAuthoritativePresetFromLog(null, PRESET_B, isTavern, { mode: 'preset', presetId: 'preset-已被删除', source: 'panel' }),
    'default',
  )
  const r = resolveAuthoritativePreset('sid-6')
  assert.equal(r.presetId, 'default')
})

// ══════════════════════════════════════════════════════════
// 三、端到端验收矩阵（真实 assemble）
// ══════════════════════════════════════════════════════════

// 场景 1：新建会话，从不选预设
writeSessionLog('sid-s1', [creationLine('sid-s1', 'standard')])
// 场景 3：旧会话 creation=standard + 遗留（旧字符串）绑定指向足控天堂
writeSessionLog('sid-s3', [creationLine('sid-s3', 'standard')])
// 场景 4：同上，但用户之后在顶部显式选回 standard
writeSessionLog('sid-s4', [creationLine('sid-s4', 'standard'), explicitLine('sid-s4', 'standard')])
// 场景 2：显式绑定 A（无 creation、无 explicit）
writeSessionLog('sid-s2', [creationLine('sid-s2', 'standard')])
// 场景 5：先绑 A，再解绑
writeSessionLog('sid-s5', [creationLine('sid-s5', 'standard')])
// 场景 6：绑定一个已删除的预设，creation 是 B
writeSessionLog('sid-s6', [creationLine('sid-s6', PRESET_B)])
// 场景 9：两个会话各自绑一张卡
writeSessionLog('sid-c1', [creationLine('sid-c1', 'standard')])
writeSessionLog('sid-c2', [creationLine('sid-c2', 'standard')])
// P0-2 停写用例：creation 就是酒馆预设（旧代码会顺手写绑定）
writeSessionLog('sid-w1', [creationLine('sid-w1', PRESET_A)])
// P0-2 仍写用例：顶部显式选了 A
writeSessionLog('sid-w2', [creationLine('sid-w2', 'standard'), explicitLine('sid-w2', PRESET_A)])

// 场景 1
test('[7] 场景1：新建会话、从不选预设 → 零注入，产物里搜不到足控天堂哨兵', () => {
  setBindings({})
  const out = assemble(ctxOf('sid-s1'))
  assert.equal(out, '', '★ 新建会话不该有任何注入')
  assertNoInjection(out, '场景1')
})

// 场景 3 + 场景 1 的加严版：带遗留绑定的旧会话
test('[8] 场景3：creation=standard + 遗留（旧字符串）绑定足控天堂 → legacy 不静默注入', () => {
  setBindings({ 'sid-s3': PRESET_FOOT })   // 旧格式，正是线上那 9 条的形态
  const out = assemble(ctxOf('sid-s3'))
  assert.equal(out, '', '★ legacy 绑定被当成用户显式绑定注入了 —— P0-4 失守')
  assertNoInjection(out, '场景3')
  // 反证：同一张卡走**显式**绑定时确实能注入（否则这条测试是空跑）
  setBindings({ 'sid-s3': { mode: 'preset', presetId: PRESET_FOOT, source: 'panel', at: Date.now(), rev: 1 } })
  const out2 = assemble(ctxOf('sid-s3'))
  assert.ok(out2.includes(FOOT_SENTINELS[0]), '反证失败：显式绑定足控天堂时本就该注入（哨兵没出现说明夹具坏了）')
})

// 场景 2
test('[9] 场景2：显式绑定预设 A → 注入 A（且只注入 A）', () => {
  setBindings({ 'sid-s2': { mode: 'preset', presetId: PRESET_A, source: 'panel', at: Date.now(), rev: 1 } })
  const out = assemble(ctxOf('sid-s2'))
  assert.ok(out.includes(SENTINEL_A), '★ 显式绑定 A 却没有注入 A')
  assert.ok(!out.includes(SENTINEL_B), '串到 B 卡了')
  assertNoInjection(out, '场景2')
})

// 场景 4
test('[10] 场景4：顶部显式选回 standard → 立即停止注入，binding 不得翻盘', () => {
  setBindings({ 'sid-s4': PRESET_FOOT })   // legacy 也不许翻盘
  const out = assemble(ctxOf('sid-s4'))
  assert.equal(out, '', '★ 顶部已经选回 standard，仍在注入')
  assertNoInjection(out, '场景4')
  // 绑**新格式**也一样不许翻盘
  setBindings({ 'sid-s4': { mode: 'preset', presetId: PRESET_FOOT, source: 'panel', at: Date.now(), rev: 1 } })
  assert.equal(assemble(ctxOf('sid-s4')), '', '★ 显式绑定翻了用户在顶部的选择')
})

// 场景 5
test('[11] 场景5：解绑本会话 → 写 {mode:none} → 零注入，且**重新读文件后仍是零注入**', () => {
  writeBindingEntry('sid-s5', { mode: 'preset', presetId: PRESET_A, source: 'panel' })
  assert.ok(assemble(ctxOf('sid-s5')).includes(SENTINEL_A), '解绑前应当注入 A（否则这条测试是空跑）')

  const entry = writeBindingEntry('sid-s5', { mode: 'none' })
  assert.deepEqual(entry, { mode: 'none' })
  assert.deepEqual(parseBindingsFile()['sid-s5'], { mode: 'none' }, '★ 落盘的必须是 {mode:none}')

  // ① 立刻：零注入
  assert.equal(assemble(ctxOf('sid-s5')), '', '★ 解绑后仍在注入')
  // ② 持久化语义：清掉进程内缓存、从磁盘重读，仍是零注入
  resetBindingsCache()
  assert.deepEqual(readBindings()['sid-s5'], { mode: 'none' })
  assert.equal(resolveAuthoritativePreset('sid-s5').bindingMode, 'none')
  assert.equal(resolveAuthoritativePreset('sid-s5').presetId, 'default')
  assert.equal(assemble(ctxOf('sid-s5')), '', '★ 重新读取 bindings 后翻盘了 —— 持久化语义失守')
  // ③ 即便 creation 是一张酒馆预设，none 也必须硬空
  writeSessionLog('sid-s5', [creationLine('sid-s5', PRESET_B)])
  assert.equal(assemble(ctxOf('sid-s5')), '', '★ mode:none 没有压住 creation')
  writeSessionLog('sid-s5', [creationLine('sid-s5', 'standard')])
})

// 场景 6
test('[12] 场景6：绑定被删除的预设 → fail closed，绝不换绑到别的卡', () => {
  setBindings({ 'sid-s6': { mode: 'preset', presetId: 'preset-已被删除', source: 'panel', at: Date.now(), rev: 1 } })
  const out = assemble(ctxOf('sid-s6'))
  assert.equal(out, '', '★ 绑定失效后仍注入了内容')
  assert.ok(!out.includes(SENTINEL_B), '★ 绑定失效后换绑到了 creation 指向的 B 卡')
  assertNoInjection(out, '场景6')
})

// 场景 9
test('[13] 场景9：两个会话并发切换 → 不串卡', () => {
  setBindings({
    'sid-c1': { mode: 'preset', presetId: PRESET_A, source: 'panel', at: Date.now(), rev: 1 },
    'sid-c2': { mode: 'preset', presetId: PRESET_B, source: 'panel', at: Date.now(), rev: 1 },
  })
  const o1 = assemble(ctxOf('sid-c1'))
  const o2 = assemble(ctxOf('sid-c2'))
  assert.ok(o1.includes(SENTINEL_A) && !o1.includes(SENTINEL_B), '会话1 串到了 B 卡')
  assert.ok(o2.includes(SENTINEL_B) && !o2.includes(SENTINEL_A), '会话2 串到了 A 卡')
  // 交替再来一轮（模拟并发交错的组装顺序）
  assert.ok(assemble(ctxOf('sid-c2')).includes(SENTINEL_B))
  assert.ok(assemble(ctxOf('sid-c1')).includes(SENTINEL_A))
  // 其中一个切到 B，另一个不受影响
  writeBindingEntry('sid-c2', { mode: 'preset', presetId: PRESET_A, source: 'panel' })
  assert.ok(assemble(ctxOf('sid-c1')).includes(SENTINEL_A))
  assert.ok(assemble(ctxOf('sid-c2')).includes(SENTINEL_A))
  assert.ok(!assemble(ctxOf('sid-c1')).includes(SENTINEL_B))
})

// ══════════════════════════════════════════════════════════
// 四、P0-2 停自动绑定
// ══════════════════════════════════════════════════════════

test('[14] P0-2 停写：非显式来源跑完一轮注入后 session-bindings.json 内容不变', () => {
  setBindings({ 'some-other-session': { mode: 'preset', presetId: PRESET_B, source: 'panel', at: 1, rev: 1 } })
  const before = readBindingsFileRaw()
  const out = assemble(ctxOf('sid-w1'))       // creation = PRESET_A（旧代码会顺手写一条）
  assert.ok(out.includes(SENTINEL_A), '这一轮确实注入了 A（否则这条测试是空跑）')
  assert.equal(readBindingsFileRaw(), before, '★ 非显式来源仍然写了绑定 —— 止血失败')
  // legacy 来源同样不许写
  setBindings({ 'sid-w1': PRESET_A })
  const before2 = readBindingsFileRaw()
  assemble(ctxOf('sid-w1'))
  assert.equal(readBindingsFileRaw(), before2, '★ legacy 来源触发了写入')
})

test('[15] P0-2 仍写：顶部显式选的预设会记账（新格式 source=top-select）', () => {
  setBindings({})
  const out = assemble(ctxOf('sid-w2'))       // explicit = PRESET_A
  assert.ok(out.includes(SENTINEL_A), '显式来源必须照常注入')
  const rec = parseBindingsFile()['sid-w2']
  assert.ok(rec, '★ 显式来源没有记账 —— 面板会白屏')
  assert.equal(rec.mode, 'preset')
  assert.equal(rec.presetId, PRESET_A)
  assert.equal(rec.source, 'top-select')
  assert.equal(rec.rev, 1)
  // 再跑一轮：rev 递增，不重复造条目
  assemble(ctxOf('sid-w2'))
  assert.equal(Object.keys(parseBindingsFile()).length, 1)
  assert.equal(parseBindingsFile()['sid-w2'].rev, 2)
})

test('[16] 面板写入路径 writeBindingEntry：source=panel 落新格式，rev 单调递增', () => {
  setBindings({})
  const e1 = writeBindingEntry('sid-panel', { mode: 'preset', presetId: PRESET_B, source: 'panel' })
  assert.equal(e1.source, 'panel')
  assert.equal(e1.rev, 1)
  const e2 = writeBindingEntry('sid-panel', { mode: 'preset', presetId: PRESET_A, source: 'panel' })
  assert.equal(e2.rev, 2)
  assert.equal(e2.presetId, PRESET_A)
  assert.ok(Number.isFinite(e2.at) && e2.at > 0)
})

// ══════════════════════════════════════════════════════════
// 五、P0-4 存量 legacy 迁移 / 清空
// ══════════════════════════════════════════════════════════

test('[17] migrateLegacyBindings：旧字符串 → 结构化 legacy，且**幂等**', () => {
  setBindings({
    'sid-m1': PRESET_FOOT,
    'sid-m2': PRESET_A,
    'sid-m3': { mode: 'preset', presetId: PRESET_B, source: 'panel', at: 111, rev: 4 },
  })
  const r1 = migrateLegacyBindings()
  assert.equal(r1.migrated, 2, '两条旧字符串应当被迁移')
  assert.ok(fs.existsSync(r1.backupPath), '★ 迁移前没有备份')
  const d1 = parseBindingsFile()
  assert.deepEqual(d1['sid-m1'], { mode: 'preset', presetId: PRESET_FOOT, source: 'legacy', at: d1['sid-m1'].at, rev: 1 })
  assert.equal(d1['sid-m3'].at, 111, '已迁移条目的 at 不得被改写（否则不幂等）')
  const snap = readBindingsFileRaw()

  const r2 = migrateLegacyBindings()
  assert.equal(r2.migrated, 0, '★ 第二次跑不应再有迁移 —— 不幂等')
  assert.equal(readBindingsFileRaw(), snap, '★ 幂等迁移却改了文件内容')
})

test('[18] 迁移后 legacy 条目依然**不注入**（解析行为与文件内容解耦）', () => {
  setBindings({ 'sid-s3': PRESET_FOOT })
  migrateLegacyBindings()
  resetBindingsCache()
  assert.equal(readBindings()['sid-s3'].source, 'legacy')
  assert.equal(resolveAuthoritativePreset('sid-s3').presetId, 'default')
  const out = assemble(ctxOf('sid-s3'))
  assert.equal(out, '', '★ 迁移把 legacy 变成了生效绑定')
  assertNoInjection(out, 'P0-4 迁移后')
})

test('[19] purgeLegacyBindings：dryRun 只报计划、不动文件；真跑先备份再清空', () => {
  setBindings({
    'sid-p1': { mode: 'preset', presetId: PRESET_FOOT, source: 'legacy', at: 1, rev: 1 },
    'sid-p2': { mode: 'preset', presetId: PRESET_A, source: 'legacy', at: 2, rev: 1 },
    'sid-p3': { mode: 'preset', presetId: PRESET_B, source: 'panel', at: 3, rev: 1 },
    'sid-p4': { mode: 'none' },
  })
  const before = readBindingsFileRaw()
  const dry = purgeLegacyBindings({ dryRun: true })
  assert.equal(dry.count, 2, '只该盯上两条 legacy')
  assert.deepEqual(dry.removed.map(r => r.sid).sort(), ['sid-p1', 'sid-p2'])
  assert.equal(readBindingsFileRaw(), before, '★ dryRun 竟然写了文件')

  const real = purgeLegacyBindings()
  assert.equal(real.count, 2)
  assert.ok(fs.existsSync(real.backupPath), '★ 清空前没有备份')
  assert.equal(fs.readFileSync(real.backupPath, 'utf8'), before, '★ 备份内容不是清空前的原文件')
  const after = parseBindingsFile()
  assert.equal(after['sid-p1'], undefined, '★ legacy 条目没有被清空')
  assert.equal(after['sid-p2'], undefined)
  assert.equal(after['sid-p3'].presetId, PRESET_B, '★ 显式绑定被误删')
  assert.deepEqual(after['sid-p4'], { mode: 'none' }, '★ 显式解绑被误删')
})

test('[20] purgeLegacyBindings 支持 onlyPresetId 与 mode=none 两种口径', () => {
  setBindings({
    'sid-q1': { mode: 'preset', presetId: PRESET_FOOT, source: 'legacy', at: 1, rev: 1 },
    'sid-q2': { mode: 'preset', presetId: PRESET_A, source: 'legacy', at: 2, rev: 1 },
  })
  const r = purgeLegacyBindings({ onlyPresetId: PRESET_FOOT, mode: 'none' })
  assert.equal(r.count, 1, '只清指向误绑定卡的那条')
  const after = parseBindingsFile()
  assert.deepEqual(after['sid-q1'], { mode: 'none' })
  assert.equal(after['sid-q2'].presetId, PRESET_A)
})

test('[21] 清理：临时 DSH_HOME 不在用户真实目录里', () => {
  assert.ok(path.isAbsolute(TMP_HOME))
  assert.ok(TMP_HOME.toLowerCase().includes('dsh-binding-tristate-'), '用的是系统临时目录：' + TMP_HOME)
})

// ══════════════════════════════════════════════════════════
// 六、P0-3 补完：后端把绑定元信息暴露给面板
//
//   ① bindingMode 四态：absent / none / legacy / preset
//   ② bindingSource：none|absent → null，legacy → 'legacy'，显式 → 'panel'|'top-select'
//   ③ boundPreset **行为不变**（回归护栏，本棒不许顺手改它）
//   ④ listAgentPresets() 返回 description（既有字段一个不许少）
//
//   ⚠ /api/tavern/sessions 是个 HTTP 路由，单测打不到（要真 persistence 服务）。
//     所以判定逻辑收在纯函数 sessionBindingFields() 里：这里测它，
//     再用一条源码断言守住「路由真的把这三个字段挂上去了」。
// ══════════════════════════════════════════════════════════

// ── 夹具：四条覆盖四态的会话（bindings 文件 + 会话文件都真实落盘）──
const SID_ABSENT = 'sid-bm-absent'   // 绑定文件里**根本没有**这个 key
const SID_NONE = 'sid-bm-none'
const SID_LEGACY = 'sid-bm-legacy'
const SID_LEGACY_OBJ = 'sid-bm-legacy-obj'  // mode:'preset' 但 source:'legacy'
const SID_PANEL = 'sid-bm-panel'
const SID_TOP = 'sid-bm-top'
for (const sid of [SID_ABSENT, SID_NONE, SID_LEGACY, SID_LEGACY_OBJ, SID_PANEL, SID_TOP]) {
  writeSessionLog(sid, [creationLine(sid, 'standard')])
}

test('[22] bindingMode 四态：absent / none / legacy / preset 各一次（走真实 bindings 文件）', () => {
  setBindings({
    [SID_NONE]: { mode: 'none' },
    [SID_LEGACY]: PRESET_FOOT,                                        // 旧字符串格式
    [SID_LEGACY_OBJ]: { mode: 'preset', presetId: PRESET_A, source: 'legacy', at: 1, rev: 1 },
    [SID_PANEL]: { mode: 'preset', presetId: PRESET_A, source: 'panel', at: 1, rev: 1 },
    [SID_TOP]: { mode: 'preset', presetId: PRESET_B, source: 'top-select', at: 1, rev: 1 },
  })
  const all = readBindings()

  // ① absent：文件里没有这条会话的绑定条目
  assert.equal(all[SID_ABSENT], undefined, '夹具错了：absent 用例不该有条目')
  assert.equal(sessionBindingFields(all[SID_ABSENT]).bindingMode, 'absent')
  // ② none：用户显式解绑
  assert.equal(sessionBindingFields(all[SID_NONE]).bindingMode, 'none')
  // ③ legacy：旧字符串格式
  assert.equal(sessionBindingFields(all[SID_LEGACY]).bindingMode, 'legacy')
  // ③ legacy：mode:'preset' 但 source:'legacy'（无法证明是用户显式绑定）
  assert.equal(sessionBindingFields(all[SID_LEGACY_OBJ]).bindingMode, 'legacy')
  // ④ preset：panel / top-select 两种显式来源
  assert.equal(sessionBindingFields(all[SID_PANEL]).bindingMode, 'preset')
  assert.equal(sessionBindingFields(all[SID_TOP]).bindingMode, 'preset')

  // 四态必须**两两可分**：legacy 不许再被展平成 none 或 preset
  const modes = [SID_ABSENT, SID_NONE, SID_LEGACY, SID_PANEL]
    .map(sid => sessionBindingFields(all[sid]).bindingMode)
  assert.deepEqual(modes, ['absent', 'none', 'legacy', 'preset'], '★ 四态被合并了：' + modes.join('/'))
  // 未归一化（原始字符串）直接喂进来也是同一个答案
  assert.equal(sessionBindingFields(PRESET_FOOT).bindingMode, 'legacy')
})

test('[23] bindingSource 跟随：none/absent→null，legacy→"legacy"，显式→"panel"/"top-select"', () => {
  const all = readBindings()
  assert.equal(sessionBindingFields(all[SID_ABSENT]).bindingSource, null, 'absent 时必须是 null')
  assert.equal(sessionBindingFields(all[SID_NONE]).bindingSource, null, 'none 时必须是 null')
  assert.equal(sessionBindingFields(all[SID_LEGACY]).bindingSource, 'legacy')
  assert.equal(sessionBindingFields(all[SID_LEGACY_OBJ]).bindingSource, 'legacy')
  assert.equal(sessionBindingFields(all[SID_PANEL]).bindingSource, 'panel')
  assert.equal(sessionBindingFields(all[SID_TOP]).bindingSource, 'top-select')
  // 常量复用：不许另造一套字符串
  assert.equal(sessionBindingFields(all[SID_PANEL]).bindingSource, BINDING_SOURCE_PANEL)
  assert.equal(sessionBindingFields(all[SID_TOP]).bindingSource, BINDING_SOURCE_TOP_SELECT)
  assert.equal(sessionBindingFields(all[SID_LEGACY]).bindingSource, BINDING_SOURCE_LEGACY)
})

test('[24] 回归护栏：boundPreset 取值与本棒改动前**逐条一致**（只许新增字段，不许改它）', () => {
  // 期望值是照改前那一行手算出来的（不是照新代码反推的）：
  //   (b && b.mode==='preset' && b.source !== 'legacy' && b.presetId) ? b.presetId : 'default'
  const all = readBindings()
  assert.equal(sessionBindingFields(all[SID_ABSENT]).boundPreset, 'default')
  assert.equal(sessionBindingFields(all[SID_NONE]).boundPreset, 'default')
  assert.equal(sessionBindingFields(all[SID_LEGACY]).boundPreset, 'default', '★ legacy 展平成 default 的行为被改了')
  assert.equal(sessionBindingFields(all[SID_LEGACY_OBJ]).boundPreset, 'default')
  assert.equal(sessionBindingFields(all[SID_PANEL]).boundPreset, PRESET_A)
  assert.equal(sessionBindingFields(all[SID_TOP]).boundPreset, PRESET_B)
  // 显式绑定但 presetId 为空（非法条目）：改前也是 default
  assert.equal(sessionBindingFields({ mode: 'preset', presetId: '', source: 'panel' }).boundPreset, 'default')
  // 返回值**只多不少**：boundPreset 仍在，且不许冒出别的新字段
  assert.deepEqual(Object.keys(sessionBindingFields(all[SID_PANEL])).sort(), ['bindingMode', 'bindingSource', 'boundPreset'])
})

test('[25] 路由接线：/api/tavern/sessions 真的把这三个字段挂到每条会话上', () => {
  const src = readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  const at = src.indexOf("path: '/api/tavern/sessions'")
  assert.ok(at > 0, '源码里找不到 /api/tavern/sessions 路由')
  const seg = src.slice(at, at + 4000)
  assert.ok(/s\.boundPreset\s*=\s*bf\.boundPreset/.test(seg), '★ boundPreset 没有挂上去')
  assert.ok(/s\.bindingMode\s*=\s*bf\.bindingMode/.test(seg), '★ bindingMode 没有挂上去（面板拿不到就永远降级）')
  assert.ok(/s\.bindingSource\s*=\s*bf\.bindingSource/.test(seg), '★ bindingSource 没有挂上去')
})

// ── 夹具：三条用来验 description 的预设 ────────────────────
const PRESET_DESC = 'preset-desc'   // 没进注册表 → description 走 preset.yml
const PRESET_META = 'preset-meta'   // 进了 presets.json → description 走注册表（权威）
const PRESET_NODESC = 'preset-nodesc' // 两处都没有 description → ''
const META_DESC = '🎭 _足控天堂2 | 📚 2本世界书（142条）| 最后更新: 2026/9/25'
for (const id of [PRESET_DESC, PRESET_META, PRESET_NODESC]) makePreset(id, 'X-' + id)
fs.writeFileSync(path.join(ROOT, PRESET_DESC, 'preset.yml'), 'name: 面板显示名\ndescription: 🎭 真名线索-来自yml\n', 'utf8')
// 注册表里的 description 才是权威 —— 正是「团队测试」看不穿「足控天堂」的那条
fs.writeFileSync(path.join(ROOT, PRESET_META, 'preset.yml'), 'name: 团队测试\ndescription: 这个是yml兜底不该被用上\n', 'utf8')
fs.writeFileSync(path.join(ROOT, PRESET_NODESC, 'preset.yml'), 'name: 无描述预设\n', 'utf8')

const META_PATH = path.join(ROOT, 'presets.json')
function withMetaPresets(extra, fn) {
  const had = fs.existsSync(META_PATH)
  const before = had ? fs.readFileSync(META_PATH, 'utf8') : ''
  try {
    const data = had ? JSON.parse(before) : { presets: [] }
    if (!Array.isArray(data.presets)) data.presets = []
    data.presets = data.presets.filter(p => p && p.dir !== PRESET_META).concat(extra)
    fs.writeFileSync(META_PATH, JSON.stringify(data, null, 2), 'utf8')
    return fn()
  } finally {
    if (had) fs.writeFileSync(META_PATH, before, 'utf8'); else try { fs.unlinkSync(META_PATH) } catch {}
  }
}

test('[26] listAgentPresets() 返回 description：注册表优先，且既有字段一个不少', () => {
  withMetaPresets([{ id: 'preset-meta-id', dir: PRESET_META, name: '团队测试', description: META_DESC, mode: 'roleplay' }], () => {
    const all = listAgentPresets()
    const meta = all.find(p => p.id === PRESET_META)
    const yml = all.find(p => p.id === PRESET_DESC)

    // ① 注册表的 description（真名线索）真的出来了 —— 面板靠它看穿「团队测试」
    assert.ok(meta, '夹具错了：注册表里的预设没被列出来')
    assert.equal(meta.description, META_DESC, '★ description 没透传出去')
    assert.ok(meta.description.includes('_足控天堂2'), '★ 真名线索丢了 —— 用户还是看不穿这张卡')
    assert.equal(meta.description.includes('yml兜底'), false, '★ 注册表优先失效，退到了 yml')
    // ② 未进注册表的目录退到 preset.yml（不许是 undefined）
    assert.ok(yml, '夹具错了：未注册预设没被列出来')
    assert.equal(yml.description, '🎭 真名线索-来自yml')

    // ③ 逐字段断言：既有 7 个字段语义不变，只多出 description 一个
    assert.deepEqual(Object.keys(meta).sort(), ['description', 'dir', 'id', 'isBuiltin', 'isTavern', 'name', 'origin', 'presetId'])
    assert.equal(meta.id, PRESET_META)
    assert.equal(meta.dir, PRESET_META)
    assert.equal(meta.name, '团队测试', '★ name 语义被改了')
    assert.equal(meta.isTavern, true, '★ isTavern 语义被改了（注册表命中即酒馆预设）')
    assert.equal(meta.isBuiltin, false)
    assert.equal(meta.origin, 'tavern', '★ origin 语义被改了')
    assert.equal(meta.presetId, 'preset-meta-id', '★ presetId 语义被改了')
    assert.equal(yml.isTavern, false, '未注册目录不该被算成酒馆预设')
    assert.equal(yml.origin, 'other', '★ origin 语义被改了')
    assert.equal(yml.presetId, null, '★ 未注册目录的 presetId 应当是 null')
    // ④ 排序规则照旧（按 name 中文排序）
    const names = all.map(p => p.name)
    assert.deepEqual(names, names.slice().sort((a, b) => String(a || '').localeCompare(String(b || ''), 'zh')))
  })
})

test('[27] description 为空 / 缺失 / 类型异常 → 返回空串，绝不抛异常', () => {
  const all = listAgentPresets()
  const none = all.find(p => p.id === PRESET_NODESC)
  assert.ok(none, '夹具错了：无描述预设没被列出来')
  assert.equal(none.description, '', '★ 缺失 description 时应当是空串，不是 undefined')
  // 本套件原有的三个夹具 preset.yml 里也没有 description 字段
  for (const id of [PRESET_A, PRESET_B, PRESET_FOOT]) {
    const p = all.find(x => x.id === id)
    assert.ok(p, '夹具错了：' + id + ' 没被列出来')
    assert.equal(typeof p.description, 'string', '★ description 必须是字符串（前端要 .replace）')
  }

  // 注册表里 description 为空串 / 缺失 / 非字符串 → 一律不炸，且不把脏值放出去
  withMetaPresets([{ id: 'preset-meta-empty', dir: PRESET_META, name: '团队测试', description: '', mode: 'roleplay' }], () => {
    const p = listAgentPresets().find(x => x.id === PRESET_META)
    assert.equal(typeof p.description, 'string')
    assert.ok(!p.description.includes('_足控天堂2'), '这次注册表里就没有真名线索')
  })
  withMetaPresets([{ id: 'preset-meta-bad', dir: PRESET_META, name: '团队测试', description: 42, mode: 'roleplay' }], () => {
    const p = listAgentPresets().find(x => x.id === PRESET_META)
    assert.equal(p.description, '这个是yml兜底不该被用上', '★ 非字符串 description 应当退化到 yml，而不是把 42 放出去')
  })
  withMetaPresets([{ id: 'preset-meta-node', dir: PRESET_META, name: '团队测试', mode: 'roleplay' }], () => {
    const p = listAgentPresets().find(x => x.id === PRESET_META)
    assert.equal(p.description, '这个是yml兜底不该被用上', '★ 注册表缺 description 时应当退化到 yml')
  })
})

test('[28] 回归护栏：加 description 之后，既有字段在**全部**预设上仍然齐整', () => {
  const all = listAgentPresets()
  assert.ok(all.length >= 6, '预设数量不对：' + all.length)
  for (const p of all) {
    for (const k of ['id', 'name', 'dir', 'isTavern', 'isBuiltin', 'origin', 'presetId', 'description']) {
      assert.ok(Object.prototype.hasOwnProperty.call(p, k), '★ 预设 ' + p.id + ' 少了字段 ' + k)
    }
    assert.equal(typeof p.isTavern, 'boolean')
    assert.equal(typeof p.isBuiltin, 'boolean')
    assert.ok(['tavern', 'builtin', 'other'].includes(p.origin), '★ origin 取值集合变了：' + p.origin)
    assert.equal(typeof p.description, 'string')
  }
})
