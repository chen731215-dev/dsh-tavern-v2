/**
 * 宿主侧 golden（**富夹具**）：S2-C2 抽装配的第二张回归网。
 *
 * 为什么需要它（第一张网自己写下的边界）：
 *   `tests/golden-host-assembly.test.js` 的夹具里**所有可选段都是空的**（实测各段长度
 *   header / text / style / tools 非空，wb / memory / net / relations / skills / summary 全为 0）
 *   ⇒ 「调换两个空段的顺序」在那张网上**不可观测**。而 S2-C2 搬走的恰恰是这些段的**计算**
 *   （世界书选择 / 会话记忆 / 联网提示 / 关系网提示 / 技能指针 + 抬头 / 风格 / 工具开关）。
 *   本文件把夹具扩成「每个可选段都非空」，并覆盖两种预设 `mode`（roleplay / creative）。
 *
 * 来源可信性（**不是自己拍自己**）：
 *   fixture 是在 **`aa76a20`（S2-C2 之前那一版）** 上生成的，随后在搬家后的版本上要求**逐字节一致**；
 *   `_generatedFrom` 记录生成时的提交。生成命令：
 *     `UPDATE_GOLDEN=1 GOLDEN_FROM=aa76a20 node --test tests/golden-host-assembly-rich.test.js`
 *
 * ⚠️ 边界（如实）：
 *   · 关键词触发命中的世界书条目**不在**覆盖内 —— 它依赖会话日志（本夹具没有会话日志 ⇒
 *     recentText 恒为 '' ⇒ 关键词条目恒不注入）。要覆盖那一档请另加夹具目录，**不要改断言**。
 *   · 逐个可选段都有「哨兵必须在产物里」的断言 ⇒ 段空掉时会报红，不会出现"比了个空字符串也绿"。
 * 全程用临时 DSH_HOME，不碰用户真实数据。
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
const FIXTURE = path.join(HERE, 'fixtures', 'golden-host-assembly-rich.json')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-golden-rich-'))
process.env.DSH_HOME = TMP_HOME
const ROOT = path.join(TMP_HOME, '.agent-presets')

/** 两份预设：一份 roleplay、一份 creative（后者走 `header` 的另一条分支）。 */
const CASES = [
  { presetId: 'preset-rich-rp', sid: 'session-rich-rp-0001', mode: 'roleplay', hasSkillTool: true },
  { presetId: 'preset-rich-cr', sid: 'session-rich-cr-0002', mode: 'creative', hasSkillTool: false },
]

/** 各段哨兵：产物里必须**逐个**找得到 ⇒ 任何一段变成空都会被这条抓住。 */
const SENTINEL = {
  card: 'RICH-CARD-4d2f',
  chars: 'RICH-CHAR-1f0a',
  wbConst: 'RICH-WB-CONST-9a17',
  summary: 'RICH-SUMMARY-73be',
  memory: 'RICH-MEMORY-c50d',
  style: '写作风格铁律',
  net: '【联网搜索】',
  tools: '【工具限制】',
  relations: '【关系网】本会话记录了 2 个角色、1 条关系',
  skills: '【可用 skill】',
}
/** 抬头两条分支各一份 */
const HEADER = { roleplay: '【!!! 角色扮演启动指令', creative: '【!!! 小说创作启动指令' }
/** 绝不能进提示词的（关系网字段只有计数进提示词 —— 顺带把这条不变量钉在这张网上） */
const MUST_NOT_LEAK = ['RICH-NODE-a71c', 'RICH-NODE-b82d', 'RICH-EDGE-c93e', 'RICH-GROUP-8c31']

function writePreset(c) {
  const dir = path.join(ROOT, c.presetId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 富夹具 ' + c.mode + '\n', 'utf8')
  const yml = [
    '- id: persona',
    '  name: persona',
    '  config:',
    '    prefix: |-',
    '      ' + SENTINEL.card + '（角色卡正文：{{user}} 是主角，{{char}} 是本卡角色。）',
    '',
  ]
  // 技能指针段有**两条分支**（挂没挂 skill 工具）：让两份预设各走一条，
  // 这样「本预设未挂 skill 工具」那条（会带出 skillsRoot() 的绝对路径）也被覆盖到。
  if (c.hasSkillTool) yml.push('- id: dsh-tool-skill', '  name: dsh-tool-skill', '')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), yml.join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([
    { name: SENTINEL.chars, desc: SENTINEL.card + '（characters.json 正文）', enabled: true },
  ]), 'utf8')
  // 世界书：一条常驻 + 一条带关键词（injectMode=full ⇒ 本轮两条都进；关键词那条顺带证明
  // "带 keys 但不命中"的条目在 full 模式下也照样注入，与 resolveWbIsFull 的口径一致）
  fs.writeFileSync(path.join(dir, 'worldbook.json'), JSON.stringify({
    version: 2,
    injectMode: 'full',
    groups: [{
      name: 'RICH-GROUP-8c31', enabled: true,
      entries: [
        { id: '1', name: '常驻条目', content: SENTINEL.wbConst + '（常驻）', enabled: true, disable: false, constant: true },
        { id: '2', name: '关键词条目', content: 'RICH-WB-KEY-b3e0（关键词触发）', enabled: true, disable: false, keys: ['RICH-KEY-6e2b'] },
      ],
    }],
  }), 'utf8')
  const dir2 = path.join(TMP_HOME, 'tavern-data', 'sessions', c.sid)
  fs.mkdirSync(dir2, { recursive: true })
  // 同一份记忆文件同时喂两段：`# 记忆总结` 进 summaryText，整份进 memoryText
  fs.writeFileSync(path.join(dir2, 'memory.md'), [
    '# 记忆总结 [2026/10/1 10:00:00]',
    SENTINEL.summary + '（总结正文）',
    '',
    '# 会话笔记',
    SENTINEL.memory + '（记忆正文）',
    '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir2, 'relations.json'), JSON.stringify({
    nodes: [{ id: 'n1', name: 'RICH-NODE-a71c' }, { id: 'n2', name: 'RICH-NODE-b82d' }],
    edges: [{ source: 'n1', target: 'n2', label: 'RICH-EDGE-c93e' }],
  }), 'utf8')
}

for (const c of CASES) writePreset(c)
fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({
  presets: CASES.map((c, i) => ({ id: c.presetId, name: '富夹具 ' + (i + 1), dir: c.presetId, mode: c.mode })),
}, null, 2), 'utf8')

// ── 假 DSH：把插件真 apply() 起来（照 golden-host-assembly.test.js 的形态）────
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

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { _test } = lib
const { writeState, readState, writeBindingEntry, setPresetSkillNames, sectionSizes } = _test
lib.apply(ctx)

for (const c of CASES) writeBindingEntry(c.sid, { mode: 'preset', presetId: c.presetId, source: 'panel' })
// 技能指针段：给两份预设都挂一个 skill 名（不需要真建 SKILL.md —— 该段的正文是拼出来的）
for (const c of CASES) setPresetSkillNames(c.presetId, ['rich-fixture-skill'])

// 输入状态也钉住：产物依赖 state（联网 / 工具开关 / 反八股 / 玩家名 / 范围），不钉住就不可复现
const st0 = readState()
writeState(Object.assign({}, st0, {
  mode: 'global', disabledCwds: [], allowCwds: [], allowSessions: [],
  cardEnabled: true,
  networkEnabled: true,          // ⇒ netText 非空
  toolsEnabled: false,           // ⇒ toolsRestriction 非空
  antiCliche: true,              // ⇒ styleText 非空
  bannedWords: ['RICH-BAN-甲', 'RICH-BAN-乙'],
  playerName: '旅行者',
  relationsHint: true,           // ⇒ relationsText 非空（需要 relations.json）
}))

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * 把**本机临时目录**替换成占位符再入库。
 * 为什么必须做：技能指针段有一条分支会把 `skillsRoot()` 的**绝对路径**拼进提示词
 * （`<DSH_HOME>/skills/<name>/SKILL.md`），而它是本次运行的 tmpdir ⇒ 不归一化的话
 * fixture 会（a）每次跑都不一样、（b）把本机绝对路径写进仓库（卫生闸门会拦，AGENTS §7.3）。
 *
 * ⚠️ **环境相关量不许冻结**（CI run #9 的真实翻车点）：
 *   上面那条绝对路径还会让产物的**原始长度**随临时目录路径长度变化（本机 `C:\Users\…\Temp\…`
 *   与 CI 的另一种形态长度不同）⇒ fixture 只冻**归一化后**的 `sha256` / `bytes`（环境无关），
 *   而 `sectionSizes.card` / 原始长度只在**同一次运行内**比对（当场量、当场比）。
 */
const PLACEHOLDER = '<DSH_HOME>'
const normalize = (s) => String(s).split(TMP_HOME).join(PLACEHOLDER)

// ── 静态契约用的解析器：把两侧的「键名集合」抽出来比（不跑运行时）──
// 为什么这条断言住在这个文件里：它守的是**同一道边界**（S2-C2 抽装配的入参契约），
// 而"依赖忘传"这类错误在运行时会被 assemble.js 自己的 try/catch **吞掉**
// （实测：删掉 readSessionMemory / readWorldbook 时，可选段全空的那张夹具照样 pass —— 静默少一段），
// 所以这条契约必须**静态**地钉住，不能指望产物比对。
/** 从 assemble.js 里取 `const { … } = deps` 的键名集合。 */
function parseDestructuredDeps(src) {
  const s = src.indexOf('const {')
  const e = src.indexOf('} = deps', s)
  assert.ok(s >= 0 && e > s, 'assemble.js 里找不到 `} = deps` 解构块')
  return src.slice(s + 'const {'.length, e)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split(':')[0].trim())      // `a: b` 重命名时，键名是 a
}
/** 从 index.js 里取 `assembleCardBody({ … })` 传入的键名集合（按顶层逗号切，剥掉行尾注释）。 */
function parseCallKeys(src) {
  const i = src.indexOf('assembleCardBody({')
  assert.ok(i >= 0, 'index.js 里找不到 assembleCardBody({…}) 调用点')
  let depth = 0
  let body = ''
  for (let k = i + 'assembleCardBody('.length; k < src.length; k++) {
    const c = src[k]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) break }
    body += c
  }
  return body.split('\n').map((l) => l.split('//')[0]).join('\n')
    .replace(/^\s*\{/, '').replace(/\}\s*$/, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split(':')[0].trim())      // `mode: …` 的键名是 mode
}

/** 取当前捕获到的组装产物 + 相关可观测量（两份预设各一条）。 */
function capture() {
  const sec = sections['tavern:card']
  assert.ok(sec, 'tavern:card 段必须已注册')
  const captures = CASES.map((c) => {
    const context = { agent: { session: { id: c.sid, header: { id: c.sid, cwd: '' } } } }
    const v = sec.text(context)
    const raw = String(v == null ? '' : v)
    const s = normalize(raw)
    return {
      mode: c.mode, sid: c.sid, presetId: c.presetId,
      // ↓ 这两项是**环境无关**的（归一化后）→ 冻结进 fixture
      bytes: Buffer.byteLength(s, 'utf8'),
      sha256: sha(s),
      cardOut: s,
      // ↓ 这两项**只在本进程内比对**，不进 fixture（随临时目录路径长度变化）
      rawLen: raw.length,
      normLen: s.length,
      tmpOcc: raw.split(TMP_HOME).length - 1,
    }
  })
  // sectionSizes 是"最近一轮"的快照（各段的 text() 回填）—— 这里正好是最后一条的
  return { captures, sectionSizes: { card: sectionSizes.card, wb: sectionSizes.wb, nsfw: sectionSizes.nsfw } }
}

test('① 覆盖：每个可选段都非空（哨兵逐个可见）', () => {
  const got = capture()
  for (const cap of got.captures) {
    assert.ok(cap.cardOut.length > 0, '★ ' + cap.mode + ' 产物为空 —— 组装没跑起来')
    for (const [seg, mark] of Object.entries(SENTINEL)) {
      assert.ok(cap.cardOut.includes(mark), '★ ' + cap.mode + ' 缺少「' + seg + '」段的哨兵 ' + JSON.stringify(mark))
    }
    assert.ok(cap.cardOut.includes(HEADER[cap.mode]), '★ ' + cap.mode + ' 缺少对应抬头分支')
    for (const leak of MUST_NOT_LEAK) {
      assert.ok(!cap.cardOut.includes(leak), '★ 关系网字段 ' + leak + ' 泄漏进提示词了（该段只应给计数）')
    }
    assert.ok(!cap.cardOut.includes(TMP_HOME), '★ 归一化漏了：产物里还有本机临时目录')
  }
  // 非空跑：技能指针段的两条分支必须各出现一次（否则"覆盖"是假的）
  const rp = got.captures.find((c) => c.mode === 'roleplay')
  const cr = got.captures.find((c) => c.mode === 'creative')
  assert.ok(rp.cardOut.includes('本会话绑定了 skill：'), '★ 「挂了 skill 工具」那条分支没被覆盖')
  assert.ok(cr.cardOut.includes('本会话绑定了设定索引文件：'), '★ 「未挂 skill 工具」那条分支没被覆盖')
  // 非空跑：归一化必须真的动过东西（否则 normalize 是空操作，将来 tmp 路径会悄悄进 fixture）
  assert.ok(got.captures.some((c) => c.tmpOcc >= 1), '★ 没有任何一条产物含本机临时目录 —— 归一化判据空跑，请检查夹具')
  // ★ 环境无关的两条（CI run #9 的翻车点：以前冻的是这两项原始长度）：
  //   ① `sectionSizes.card` 量的是**归一化之前**的产物 ⇒ 与"当场量到的原始长度"比，不冻数值；
  const last = got.captures[got.captures.length - 1]
  assert.equal(got.sectionSizes.card, last.rawLen, 'sectionSizes.card 必须等于**当场量到**的原始产物长度（同一次运行内比对）')
  //   ② 原始 / 归一化的**字符**差必须正好等于「被替换的路径出现次数 × 长度差」——把归一化走了几次也钉住。
  for (const cap of got.captures) {
    assert.equal(
      cap.rawLen - cap.normLen, cap.tmpOcc * (TMP_HOME.length - PLACEHOLDER.length),
      '★ ' + cap.mode + ' 的「原始长度 − 归一化长度」与路径替换代数对不上（tmpOcc=' + cap.tmpOcc + '）',
    )
    assert.ok(cap.rawLen >= cap.normLen, '原始长度不可能小于归一化长度')
  }
  assert.ok(got.sectionSizes.wb > 0, '★ sectionSizes.wb 为 0 ⇒ 世界书段在本轮是空的，这张网没覆盖到它')
  // 诊断行（进材料用）：CI 与本机的临时目录形态不同时，这一行能一眼看出差在哪
  console.log('  [golden-rich] tmpdir=' + os.tmpdir() + '（基路径 len=' + TMP_HOME.length + '）'
    + ' | 最后一条产物：原始长度=' + last.rawLen + ' 归一化后=' + last.normLen + ' 差值=' + (last.rawLen - last.normLen)
    + ' | tmp 路径出现 ' + last.tmpOcc + ' 次 | sectionSizes.wb=' + got.sectionSizes.wb)
})

test('② 逐字节比对：两层夹具（roleplay / creative）都与 fixture 完全一致', () => {
  const got = capture()
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
    fs.writeFileSync(FIXTURE, JSON.stringify({
      _note: '宿主侧 golden（富夹具）：tavern:card 在「所有可选段都非空」下的组装产物（已归一化）。更新方式：UPDATE_GOLDEN=1。⚠️ 只冻环境无关量：原始长度（sectionSizes.card / rawLen）随临时目录路径长度变化，不冻结，改由测试内的一致性断言覆盖。',
      _generatedFrom: process.env.GOLDEN_FROM || '（未标注提交）',
      captures: got.captures.map(({ mode, sid, presetId, bytes, sha256, cardOut }) => ({ mode, sid, presetId, bytes, sha256, cardOut })),
      sectionSizes: { wb: got.sectionSizes.wb, nsfw: got.sectionSizes.nsfw },
    }, null, 2) + '\n', 'utf8')
    console.log('  [golden-rich] 已写入 ' + path.relative(REPO, FIXTURE))
    return
  }
  assert.ok(fs.existsSync(FIXTURE), '★ 缺 fixture：先跑 UPDATE_GOLDEN=1 生成（' + path.relative(REPO, FIXTURE) + '）')
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  assert.equal(want.captures.length, got.captures.length, '夹具层数变了')
  for (let i = 0; i < want.captures.length; i++) {
    const w = want.captures[i]
    const g = got.captures[i]
    assert.equal(g.mode, w.mode, '第 ' + (i + 1) + ' 层的预设 mode 变了')
    assert.equal(
      g.sha256, w.sha256,
      '★ 「' + w.mode + '」产物变了（S2-C2 抽装配的富夹具回归网）：期望 ' + w.bytes + ' 字节 / 实际 ' + g.bytes + ' 字节',
    )
  }
  assert.deepEqual(
    { wb: got.sectionSizes.wb, nsfw: got.sectionSizes.nsfw }, want.sectionSizes,
    '与环境无关的体积快照变了（sectionSizes.card 属环境相关量，已在测试①里当场比对，不冻结）',
  )
})

test('③ 静态契约：assemble.js 解构出的依赖名集合 == index.js 调用点传入的键集合', () => {
  const asm = fs.readFileSync(path.join(REPO, 'lib', 'server', 'assemble.js'), 'utf8')
  const idxSrc = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  const deps = parseDestructuredDeps(asm)
  const passed = parseCallKeys(idxSrc)
  // 非空跑：两侧都必须真解析出东西（阈值取一个显然低于现状、但远高于 1 的数）
  assert.ok(deps.length >= 10, '解构出的依赖名只有 ' + deps.length + ' 个 —— 判据空跑或解析器坏了')
  assert.ok(passed.length >= 10, '调用点传入的键只有 ' + passed.length + ' 个 —— 判据空跑或解析器坏了')
  assert.deepEqual(
    deps.filter((n) => !passed.includes(n)), [],
    '★ 这些依赖「解构了但调用点没传」—— 运行时会被 assemble.js 自己的 try/catch 吞掉，表现为「静默少一段」',
  )
  assert.deepEqual(
    passed.filter((n) => !deps.includes(n)), [],
    '★ 这些键「传了但没解构」—— 死参数（多传了，没人用）',
  )
  // 反向约束：模块里**不许**出现 import lib/index.js（AGENTS §5 第 5 条）
  assert.ok(!/from\s+['"][^'"]*index\.js/.test(asm), '★ assemble.js 反向 import 了 index.js')
})
