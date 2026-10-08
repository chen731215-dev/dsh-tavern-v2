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
import { test } from 'node:test'
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
    why: '需要完整 DSH ctx + 磁盘 fixture；装配体目前仍在 apply 里，等 S2-C2 把它抽成函数后再补 golden',
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
