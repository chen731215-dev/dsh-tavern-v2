/**
 * 提示词组装的 **golden 差分**（「行为等价」的可复现证据）。
 *
 * 为什么需要它（复核意见 Q2）：
 *   「逐行对账 + 全量测试通过」都只是**必要不充分** —— 文本对得上只说明没抄错，
 *   而重排代码最容易破坏的恰恰是**没有断言的那些行为**。所以真正需要的是
 *   「同一组固定输入 ⇒ 新旧两版产出逐字节相同」的差分证据。
 *
 * 本文件的做法：
 *   `tests/fixtures/golden-prompt.json` 是**在重构前那一版（a816afd）上生成的**产物快照。
 *   这个测试在**当前版本**上重跑同一组固定 fixture，要求逐字节一致。
 *   ⇒ 任何一处组装语义被重构改坏，这里立刻报红。
 *
 * 重新生成 golden（**只在明确知道要改行为时**）：
 *   UPDATE_GOLDEN=1 node --test tests/golden-prompt.test.js
 *   在旧版上生成：
 *   git worktree add --detach ../old <旧提交> && cd ../old && cp <本文件> tests/ \
 *     && UPDATE_GOLDEN=1 node --test tests/golden-prompt.test.js
 *
 * ⚠️ 豁免清单见下方 EXEMPT —— **那是本 golden 的诚实边界**，不要把它当成"全覆盖"。
 * 全程用临时 DSH_HOME，不碰真实用户数据。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const GOLDEN = path.join(HERE, 'fixtures', 'golden-prompt.json')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-golden-'))
process.env.DSH_HOME = TMP_HOME

// ════════════════════════════════════════════════════════════════
// 固定 fixture：全部是字面量，不含时间 / 路径 / 随机
// ════════════════════════════════════════════════════════════════
const F = {
  agentYml: [
    '- id: persona',
    '  name: persona',
    '  config:',
    '    prefix: |-',
    '      你是{{char}}，正在与{{user}}对话。',
    '      保持角色语气，不要出戏。',
    '',
    '- id: world',
    '  name: world',
    '  config:',
    '    prefix: |-',
    '      世界观：架空古代。',
    '',
  ].join('\n'),

  richContent: [
    { type: 'text', text: '第一段。' },
    { type: 'text', text: '第二段。' },
  ],

  rawCard: '你好{{user}}，我是{{char}}。保留 {{未定义的宏}} 原样。',

  macroInput: '{{char}} 对 {{user}} 说：保留 {{nope}}；角色卡名是 {{charName}}。',

  wbEntries: [
    { name: '人物·甲', keys: ['甲'], content: '甲是主角，与{{user}}并肩。', enabled: true },
    { name: '地点·城', keywords: ['城'], content: '一座城。\n<div class="card">带格式</div>', enabled: true },
    { name: '禁用条目', keys: ['禁'], content: '这段不该出现。', enabled: false },
    { name: '常数条目', content: '无视关键词，永远在场。', enabled: true },
    {
      // 阶段条目：parseStagePlans 的判据是「含 `<%` 且含 getwi」，并且
      // getwi 要求两个参数（第二个是带引号的名字）；条件写成 if (var > N) 或裸 else。
      name: '阶段·甲',
      content: [
        "<% var aff = getvar('stat_data.甲.好感度[0]') %>",
        "<% if (aff > 60) { %><%- getwi(1, '甲-亲密') %><% } else { %><%- getwi(1, '甲-普通') %><% } %>",
      ].join('\n'),
      enabled: true,
    },
  ],

  recentText: '甲走进城里，说起乙。',

  state: { wbInject: 'follow', wbInjectBySession: { s1: 'full', s2: 'follow' } },

  // cardOut 的拼接顺序（拼接语义本身也是被 golden 盯住的对象）
  compose: {
    header: '【当前预设】甲卡\n',
    cardText: '你是{{char}}，与{{user}}同行。',
    memoryText: '\n\n【会话记忆】上次在城门口分开。',
    styleText: '\n\n【写作风格】短句，多动作。',
  },
}

/** 把任意返回值转成稳定的、可 JSON 化的形态 */
function stable(v) {
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [k, stable(x)])
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k])
    return out
  }
  return v
}

/** 采集：所有纯函数阶段的产出（这些正是 cardOut 的组成件） */
function capture(t) {
  const wb = { injectMode: 'keyword', entries: F.wbEntries }
  const enabledEntries = F.wbEntries.filter((e) => e.enabled !== false)
  const wbText = t.buildWorldbookText(enabledEntries)
  return {
    extractCardText: t.extractCardText(F.agentYml),
    contentToText: t.contentToText(F.richContent),
    cleanSillyTavernVars: t.cleanSillyTavernVars(F.rawCard),
    sanitizePromptText: t.sanitizePromptText(F.macroInput, '角色名'),
    estimatePromptBudget: stable(t.estimatePromptBudget(12345, 32000)),
    resolveWbIsFull: [
      stable(t.resolveWbIsFull(F.state, wb, 's1')),
      stable(t.resolveWbIsFull(F.state, wb, 's2')),
      stable(t.resolveWbIsFull(F.state, wb, 's3')),
      stable(t.resolveWbIsFull(F.state, null, 's3')),
    ],
    matchWorldbookEntries: t.matchWorldbookEntries(wb, F.recentText).map((e) => e.name),
    selectWorldbookEntries: stable(t.selectWorldbookEntries(F.wbEntries, F.recentText, false)),
    parseStagePlans: stable([...t.parseStagePlans(F.wbEntries)]),
    buildWorldbookText: wbText,
    // 拼接语义：与 cardOut 同序、同分隔（固定输入 ⇒ 固定产出）
    composed: t.sanitizePromptText(
      F.compose.header + F.compose.cardText + '\n\n' + wbText +
      F.compose.memoryText + F.compose.styleText,
    ),
  }
}

// ════════════════════════════════════════════════════════════════
// 豁免清单：本 golden **覆盖不到**的东西（诚实边界，不许悄悄删）
// ════════════════════════════════════════════════════════════════
export const EXEMPT = [
  {
    what: '`apply(ctx)` 内部 `tavern:card` 的真实组装（含各段开关判定与顺序）',
    why: '需要完整 DSH ctx + 磁盘 fixture；装配体仍在 apply 里 —— 本轮对 apply 的改动只有 5 行（全是 S. 前缀改写），把它抽成函数是 S2-C2 的前置条件，届时补 golden',
  },
  { what: '`prompt-stats.json` 的数值', why: '运行期产物，含时间戳与动态体积，不适合快照' },
  { what: 'UI 交互与真实浏览器渲染', why: '无法在 node 进程内 golden 化（属 §9.1 真机冒烟的职责）' },
  { what: '时序与并发（切会话、异步总结回调落盘）', why: '非确定性，需要专门的用例而不是快照比对' },
  { what: 'LLM 调用与失败路径（拒答、超时、zstd 帧损坏）', why: '依赖外部服务或需要注入故障，属专项测试' },
]

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const ACTUAL = stable(capture(lib._test))

if (process.env.UPDATE_GOLDEN === '1') {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
  fs.writeFileSync(GOLDEN, JSON.stringify(ACTUAL, null, 2) + '\n', 'utf8')
  console.log('已写入 golden：' + GOLDEN)
}

// ════════════════════════════════════════════════════════════════
// ① golden 存在且**非空跑**
// ════════════════════════════════════════════════════════════════
test('① golden 必须存在，且每个采集项都非空（防「快照全空 ⇒ 永真」）', () => {
  assert.ok(fs.existsSync(GOLDEN), '缺 golden：' + GOLDEN + '（用 UPDATE_GOLDEN=1 生成）')
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
  const empty = Object.entries(g)
    .filter(([, v]) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length))
    .map(([k]) => k)
  assert.deepEqual(empty, [], '★ 这些采集项是空的 —— golden 有水分（要么 fixture 没喂到，要么判据退化了）：\n  ' + empty.join('\n  '))
  assert.ok(Object.keys(g).length >= 10, '采集项太少：' + Object.keys(g).length)
})

// ════════════════════════════════════════════════════════════════
// ② 与 golden 逐字节一致（这就是「行为等价」的证据）
// ════════════════════════════════════════════════════════════════
test('② 组装各阶段产出必须与 golden（重构前那一版的产物）逐字节一致', () => {
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
  const mine = JSON.stringify(ACTUAL, null, 2)
  const gold = JSON.stringify(g, null, 2)
  if (mine !== gold) {
    // 找出第一处差异，别让人去看几百行 JSON
    const a = gold.split('\n')
    const b = mine.split('\n')
    let i = 0
    while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++
    assert.fail(
      '★ 行为与重构前不一致（第 ' + (i + 1) + ' 行起）：\n' +
      '  golden: ' + String(a[i]).trim() + '\n' +
      '  现在  : ' + String(b[i]).trim() + '\n' +
      '如果这是**有意的行为变更**，请在同一提交里说明理由并更新 golden；否则是重构改坏了语义。',
    )
  }
})

// ════════════════════════════════════════════════════════════════
// ③ 豁免清单必须显式且不许悄悄缩水
// ════════════════════════════════════════════════════════════════
test('③ 豁免清单必须显式列出「本 golden 覆盖不到」的东西', () => {
  assert.ok(EXEMPT.length >= 5, '豁免条目变少了（' + EXEMPT.length + '）—— 别把覆盖缺口悄悄删掉')
  for (const e of EXEMPT) {
    assert.ok(e.what && e.why, '豁免条目必须写清 what + why：' + JSON.stringify(e))
  }
  // 反证：判据本身要能认出缺字段的坏样本
  const bad = [{ what: 'x' }]
  const ok = bad.every((e) => e.what && e.why)
  assert.equal(ok, false, '对照：缺 why 的条目必须被判不合格')
})

// ════════════════════════════════════════════════════════════════
// ④ 收尾：删掉**本文件自己建的**临时 DSH_HOME（task-17 / 铁律 21）
//
//   背景：本文件与 `golden-host-assembly-rich.test.js` 各用 `fs.mkdtempSync(os.tmpdir(), 'dsh-golden-*')`
//   建一个临时 DSH_HOME，但**从来不删** ⇒ 每跑一次留一个目录，本机实测已积到 340 个（约 13 MB）。
//
//   ★ 硬约束（照 task-17 的三条来）：
//     ① **不许前缀盲扫**：只删 `TMP_HOME` 这个**变量指向的具体路径**，不按 `dsh-golden-*` glob 扫。
//        （盲扫会连"别人的残留 / 正在被另一个进程使用的目录"一起删 —— 本仓有过删到别人残留的教训。）
//     ② **只删自建**：`TMP_HOME` 必须是本进程 `mkdtempSync` 出来的（`fs.realpathSync` 二次确认
//        它确在 `os.tmpdir()` 之下、且名字带本文件的唯一前缀）。
//     ③ **响亮失败**：删不掉就**打印原因**（不静默吞）—— 但**不让测试因此判红**
//        （清理失败是**环境**问题，不是被测行为错；与"缺样本不许 SKIP+exit 0"不冲突，
//         因为被测断言已经跑完并已判决，这里只是收尾）。
// ════════════════════════════════════════════════════════════════
after(() => {
  // ★ 整段都包在 try 里 —— 不许让「收尾」把测试判决翻红（铁律 19：环境故障≠代码故障）
  //   曾经的写法把 `fs.realpathSync(TMP_HOME)` 放在 try **之外** ⇒ 目录一旦不存在
  //   （杀软 / OS 清理器 / 并发进程把它弄没，**恰恰是这条守卫该生效的场景**）就抛 ENOENT，
  //   把整条测试判成 fail —— 与「清理失败不改判决」自相矛盾。已由反证脚本实测复现。
  let real = null
  try {
    const tmpRoot = fs.realpathSync(os.tmpdir())
    // TMP_HOME 不存在 ⇒ 无需清理，优雅退出（不是错误）
    if (!fs.existsSync(TMP_HOME)) {
      console.log('  [golden-prompt] 临时 DSH_HOME 已不存在，无需清理')
      return
    }
    real = fs.realpathSync(TMP_HOME)
    const base = path.basename(real)
    // ②的守卫：三重确认后才删
    if (!real.startsWith(tmpRoot + path.sep)) {
      console.error('⚠️ [golden-prompt] 收尾跳过：TMP_HOME 不在系统临时目录之下 ⇒ ' + real)
      return
    }
    if (!base.startsWith('dsh-golden-')) {
      console.error('⚠️ [golden-prompt] 收尾跳过：目录名不像本测试建的 ⇒ ' + base)
      return
    }
    fs.rmSync(real, { recursive: true, force: true })
    console.log('  [golden-prompt] 已清理临时 DSH_HOME：' + base)
  } catch (e) {
    // ③：响亮报因，但不改判决
    console.error('⚠️ [golden-prompt] 临时目录清理失败（不影响测试判决）：' + (real || TMP_HOME) + ' —— ' + e.message)
  }
})
