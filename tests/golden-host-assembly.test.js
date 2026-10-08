/**
 * 宿主侧 golden：`apply(ctx)` 里的**真实组装**产物快照（S2-C2 的前置条件）。
 *
 * 为什么需要它（AGENTS §9.2 自己写的边界）：
 *   已有的 `tests/golden-prompt.test.js` 比的是 `cardTextFor()` 这一层的产物 ——
 *   而 `apply(ctx)` 内部的真实组装（`summaryText + header + text + wbText + memoryText + …`）
 *   **不在它的覆盖范围内**。把 `apply` 抽成「只做装配」正是 S2-C2 要做的事，
 *   而那一步最容易改坏的就是这段组装 —— 没有本文件，抽完之后只能靠人眼。
 *
 * 它守什么：
 *   ① 用假 ctx 真跑 `apply(ctx)`，把 `tavern:card` 段的注册**参数**钉住（name / order）；
 *   ② 调该段的 `text(context)`，把产物**逐字节**与 fixture 比；
 *   ③ `sectionSizes.card` 必须等于产物长度（体积快照的一致性是面板显示的依据）；
 *   ④ 非空跑：产物必须非空、且必须含 fixture 卡正文里的标记 —— 否则"比了个空字符串"也会绿。
 *   ⑤ **环境无关性**：产物里**不得出现任何本机绝对路径特征**（临时目录前缀 / 盘符路径 / 家目录形态）。
 *      为什么单列一条：本 fixture 冻结了 `sectionSizes`（含 `card`），而 `card` 是**产物长度** ——
 *      只要产物里嵌进一条绝对路径，它的长度就会随 `os.tmpdir()` 形态漂移（CI run #9 的真实翻车点：
 *      本机 2121 / CI 形态 2102，差值正好是两种临时目录基路径的长度差）。
 *      写注释不算判据（注释不会响铃）：将来谁给这张夹具加了"带绝对路径的段"，
 *      必须**在指得到根因的地方报红**，而不是在 CI 上以"体积快照变了"这种形式红。
 *
 * ⚠️ 边界（如实）：世界书 / 技能 / 记忆 / 关系网这些**由 fixture 目录内容驱动**的分支，
 *   本 fixture 只覆盖到"没有这些文件"的那一档。要扩覆盖面就扩 fixture 目录，
 *   不要靠改断言。全程用临时 DSH_HOME，不碰用户真实数据。
 *
 * 更新 fixture：`UPDATE_GOLDEN=1 node --test tests/golden-host-assembly.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURE = path.join(HERE, 'fixtures', 'golden-host-assembly.json')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-golden-'))
process.env.DSH_HOME = TMP_HOME
const ROOT = path.join(TMP_HOME, '.agent-presets')
const PRESET_ID = 'preset-host-golden'
/** 夹具卡正文里的标记：产物必须含它，否则说明组装没走到卡上（空跑）。 */
const CARD_MARKER = 'HOST-GOLDEN-CARD-BODY-7f3a'

// 一个「酒馆可管理」的预设目录（isTavernPresetDir 要求 preset.yml + agent.cordis.yml）
fs.mkdirSync(path.join(ROOT, PRESET_ID), { recursive: true })
fs.writeFileSync(path.join(ROOT, PRESET_ID, 'preset.yml'), 'name: 宿主 golden 夹具预设\n', 'utf8')
fs.writeFileSync(
  path.join(ROOT, PRESET_ID, 'agent.cordis.yml'),
  ['- id: persona', '  name: persona', '  config:', '    prefix: |-', '      ' + CARD_MARKER, '      第二行：用于确认多行正文原样进产物。', ''].join('\n'),
  'utf8',
)

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
const { writeState, readState, writeBindingEntry, sectionSizes } = _test

// ── 假 DSH：捕获 systemPrompt.section 的注册（含 text 函数）────────────────
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

const SID = 'session-host-golden-000000000001'
writeBindingEntry(SID, { mode: 'preset', presetId: PRESET_ID, source: 'panel' })
// 输入状态也钉住：产物依赖 state（联网/范围/玩家名…），不钉住就不是可复现的快照
const st0 = readState()
writeState(Object.assign({}, st0, {
  mode: 'global', disabledCwds: [], allowCwds: [], allowSessions: [],
  networkEnabled: false, playerName: '',
}))

/** 取当前捕获到的组装产物 + 相关可观测量。 */
function capture() {
  const sec = sections['tavern:card']
  assert.ok(sec, 'tavern:card 段必须已注册')
  const context = { agent: { session: { id: SID, header: { id: SID, cwd: '' } } } }
  const cardOut = sec.text(context)
  return {
    section: { name: sec.name, order: sec.order },
    cardOut: String(cardOut == null ? '' : cardOut),
    sectionSizes: {
      card: sectionSizes.card,
      wb: sectionSizes.wb,
      nsfw: sectionSizes.nsfw,
    },
    inputState: {
      mode: 'global', networkEnabled: false, playerName: '',
    },
  }
}

test('① 非空跑：产物必须非空、且必须含夹具卡正文标记', () => {
  const got = capture()
  assert.ok(got.cardOut.length > 0, '★ 产物为空 —— 组装没跑起来，后面的比对毫无意义')
  assert.ok(got.cardOut.includes(CARD_MARKER), '★ 产物里没有夹具卡正文标记 ⇒ 卡没被注入')
  assert.equal(got.sectionSizes.card, got.cardOut.length, 'sectionSizes.card 必须等于产物长度')
})

test('② 逐字节比对：组装产物与 fixture 完全一致（S2-C2 抽装配的回归网）', () => {
  const got = capture()
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
    const doc = {
      _note: '宿主侧 golden：apply(ctx) 里 tavern:card 段的真实组装产物。更新方式：UPDATE_GOLDEN=1。',
      _generatedFrom: process.env.GOLDEN_FROM || '（未标注提交）',
      sha256: crypto.createHash('sha256').update(got.cardOut, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(got.cardOut, 'utf8'),
      ...got,
    }
    fs.writeFileSync(FIXTURE, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    console.log('  [golden] 已写入 ' + path.relative(REPO, FIXTURE) + '（' + doc.bytes + ' 字节）')
    return
  }
  assert.ok(fs.existsSync(FIXTURE), '★ 缺 fixture：先跑 UPDATE_GOLDEN=1 生成（' + path.relative(REPO, FIXTURE) + '）')
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  assert.equal(got.section.order, want.section.order, 'tavern:card 的 order 变了（别的段会跟着换序）')
  assert.equal(got.section.name, want.section.name, 'tavern:card 的名字变了')
  assert.equal(
    crypto.createHash('sha256').update(got.cardOut, 'utf8').digest('hex'),
    want.sha256,
    '★ 组装产物变了（这是 S2-C2 的回归网）：期望 ' + want.bytes + ' 字节 / 实际 ' + Buffer.byteLength(got.cardOut, 'utf8') + ' 字节',
  )
  assert.deepEqual(got.sectionSizes, want.sectionSizes, '体积快照变了（面板显示与预算判据都依赖它）')
})

test('③ 环境无关性：产物不得含本机绝对路径特征（否则冻结的 sectionSizes.card 会随环境漂移）', () => {
  const got = capture()
  // ★ 非空跑：空产物（或缺卡标记）会让"不含路径"恒等成立 —— 那正是本仓最反对的"免费绿灯"
  assert.ok(got.cardOut.length > 0, '★ 产物为空 ⇒ 这条判据会空转通过，先修组装')
  assert.ok(got.cardOut.includes(CARD_MARKER), '★ 产物里没有夹具卡正文标记 ⇒ 这条判据会空转通过')

  // 特征表：每一条都独立可读，命中哪条就报哪条（便于归因到"路径特征"，而不是兜底的"体积变了"）
  const FEATURES = [
    ['本机临时目录前缀', TMP_HOME],
    ['盘符绝对路径（如 C:\\ 或 D:/）', /(?<![A-Za-z])[A-Za-z]:[\\/]/],
    ['家目录形态 /Users/ 或 \\Users\\', /[\\/]Users[\\/]/i],
    ['AppData', /AppData/i],
    ['本仓/本机路径片段 .agent-presets 与 skills 的绝对形态', /[A-Za-z]:[\\/][^\n]{0,40}(\\.agent-presets|\\skills\\[^\n]*SKILL\.md)/],
  ]
  const hits = []
  for (const [label, f] of FEATURES) {
    const hit = f instanceof RegExp ? f.test(got.cardOut) : got.cardOut.includes(f)
    if (hit) hits.push(label)
  }
  assert.deepEqual(hits, [], '★ 产物里出现了本机绝对路径特征 ⇒ 冻结的 sectionSizes.card 会随环境漂移（CI run #9 的翻车点）。命中：' + hits.join('、'))
})
