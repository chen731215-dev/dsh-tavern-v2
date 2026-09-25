import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchWorldbookEntries, buildWorldbookText, extractCardText, contentToText } from '../lib/utils.js'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── matchWorldbookEntries ──────────────────────────────
test('matchWorldbookEntries: keyword 模式命中关键词', () => {
  const wb = {
    injectMode: 'keyword',
    entries: [
      { id: '1', name: '角色A', keywords: ['张三', 'zhangsan'], content: '张三的设定', enabled: true },
      { id: '2', name: '角色B', keywords: ['李四'], content: '李四的设定', enabled: true },
    ]
  }
  const hits = matchWorldbookEntries(wb, '今天张三去了公园')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, '1')
})

test('matchWorldbookEntries: 关键词不区分大小写', () => {
  const wb = {
    injectMode: 'keyword',
    entries: [
      { id: '1', name: '测试', keywords: ['Hello'], content: '内容', enabled: true },
    ]
  }
  const hits = matchWorldbookEntries(wb, '你好 hello world')
  assert.equal(hits.length, 1)
})

test('matchWorldbookEntries: 未命中关键词不注入', () => {
  const wb = {
    injectMode: 'keyword',
    entries: [
      { id: '1', name: '测试', keywords: ['不存在的词'], content: '内容', enabled: true },
    ]
  }
  const hits = matchWorldbookEntries(wb, '这是一段普通对话')
  assert.equal(hits.length, 0)
})

test('matchWorldbookEntries: 禁用的条目不注入', () => {
  const wb = {
    injectMode: 'keyword',
    entries: [
      { id: '1', name: '测试', keywords: ['张三'], content: '内容', enabled: false },
    ]
  }
  const hits = matchWorldbookEntries(wb, '张三来了')
  assert.equal(hits.length, 0)
})

test('matchWorldbookEntries: full 模式注入所有启用条目', () => {
  const wb = {
    injectMode: 'full',
    entries: [
      { id: '1', name: 'A', keywords: ['a'], content: 'A内容', enabled: true },
      { id: '2', name: 'B', keywords: ['b'], content: 'B内容', enabled: true },
      { id: '3', name: 'C', keywords: ['c'], content: 'C内容', enabled: false },
    ]
  }
  const hits = matchWorldbookEntries(wb, '任意文本')
  assert.equal(hits.length, 2)
})

test('matchWorldbookEntries: keyword 模式下无关键词的条目不注入', () => {
  const wb = {
    injectMode: 'keyword',
    entries: [
      { id: '1', name: '无关键词', keywords: [], content: '内容', enabled: true },
    ]
  }
  const hits = matchWorldbookEntries(wb, '任意文本')
  assert.equal(hits.length, 0)
})

test('matchWorldbookEntries: 空世界书返回空', () => {
  const wb = { injectMode: 'keyword', entries: [] }
  const hits = matchWorldbookEntries(wb, '文本')
  assert.equal(hits.length, 0)
})

// ── buildWorldbookText ─────────────────────────────────
test('buildWorldbookText: 空条目返回空字符串', () => {
  assert.equal(buildWorldbookText([]), '')
})

test('buildWorldbookText: 正确构建注入文本', () => {
  const entries = [
    { name: '角色A', keywords: ['a'], content: 'A的设定内容' },
  ]
  const text = buildWorldbookText(entries)
  assert.ok(text.includes('【世界书 — 关键词触发条目】'))
  assert.ok(text.includes('角色A'))
  assert.ok(text.includes('触发词：a'))
  assert.ok(text.includes('A的设定内容'))
})

test('buildWorldbookText: 多个条目都包含', () => {
  const entries = [
    { name: 'A', keywords: ['a'], content: 'A内容' },
    { name: 'B', keywords: ['b'], content: 'B内容' },
  ]
  const text = buildWorldbookText(entries)
  assert.ok(text.includes('A内容'))
  assert.ok(text.includes('B内容'))
})

// ── extractCardText ────────────────────────────────────
test('extractCardText: 从 yml 提取 text 字段', () => {
  const yml = `
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      这是角色卡内容
      第二行
`
  const text = extractCardText(yml)
  assert.ok(text.includes('这是角色卡内容'))
  assert.ok(text.includes('第二行'))
})

test('extractCardText: 非字符串返回空', () => {
  assert.equal(extractCardText(null), '')
  assert.equal(extractCardText(123), '')
})

// ★ 回归：块结束要按「键名缩进」判断，不能只认顶格行。
//   config: 下的 complete: / includeRuntimeContext: 与 prefix: 同级缩进但都不是第 0 列，
//   旧实现（if (/^\S/.test(line)) break）会把它们当成角色卡正文一起吞进去，
//   于是注入的卡片末尾多出「complete: false」「includeRuntimeContext: true」这种垃圾。
test('extractCardText: 同级键不会被吞进卡片', () => {
  const yml = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |-',
    '      这是角色卡内容',
    '      第二行',
    '    complete: false',
    '    includeRuntimeContext: true',
    '',
  ].join('\n')
  const text = extractCardText(yml)
  assert.ok(text.includes('这是角色卡内容'))
  assert.ok(text.includes('第二行'))
  assert.ok(!text.includes('complete:'), 'complete: 被吞进卡片了')
  assert.ok(!text.includes('includeRuntimeContext'), 'includeRuntimeContext 被吞进卡片了')
})

test('extractCardText: prefix 顶格时也能正确截断', () => {
  const yml = [
    '- id: persona',
    '  config:',
    '    prefix: |-',
    '      卡片正文',
    '  complete: false',
    '',
  ].join('\n')
  const text = extractCardText(yml)
  assert.ok(text.includes('卡片正文'))
  assert.ok(!text.includes('complete:'))
})

test('extractCardText: 无 text 字段返回空', () => {
  const yml = `- id: persona\n  name: test\n`
  assert.equal(extractCardText(yml), '')
})

test('extractCardText: 超长内容截断', () => {
  const longContent = 'a'.repeat(50000)
  const yml = `- id: persona\n  config:\n    text: |-\n      ${longContent}\n`
  const text = extractCardText(yml)
  assert.ok(text.length <= 40000 + 50) // CARD_MAX + 提示文字
  assert.ok(text.includes('已截断'))
})

// ── contentToText ──────────────────────────────────────
test('contentToText: 提取文本内容', () => {
  const content = [{ type: 'text', text: '你好世界' }]
  assert.equal(contentToText(content), '你好世界')
})

test('contentToText: 非数组返回空', () => {
  assert.equal(contentToText(null), '')
  assert.equal(contentToText('字符串'), '')
})

test('contentToText: 多段文本拼接', () => {
  const content = [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ]
  const text = contentToText(content)
  assert.ok(text.includes('第一段'))
  assert.ok(text.includes('第二段'))
})

console.log('\n✅ 所有测试通过！')

// ── 清理逻辑（兼容性测试：DSH 不支持 SillyTavern 变量系统）──
//
// ⚠ P0-5 起本文件要跑**真实装配**（白名单闸门必须端到端验），而 index.js 在模块加载
//   那一刻就按 $DSH_HOME 绑定 ROOT / tavern-state.json。若沿用静态 import，ESM 会把
//   它提升到文件顶部、赶在任何赋值之前执行 ⇒ 装配会读写**用户真实目录**。
//   所以这里改成动态 import，并先把 DSH_HOME 指到临时目录。
const CORE_TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-'))
const CORE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.DSH_HOME = CORE_TMP_HOME
const { _test, apply } = await import(pathToFileURL(path.join(CORE_REPO, 'lib', 'index.js')).href)

const { cleanSillyTavernVars, sanitizePromptText, randomPick, randomRoll, normalizeName, cleanName, estimatePromptBudget, migrateSessionStorageOutOfPresetRoot, DEFAULT_PRESET_YML, DEFAULT_PRESET_META, detectRefusal, pickAuthoritativePreset, pickAuthoritativePresetFromLog, classifySessionPresetLines, extractAgentPresetFromLine, sessionIdKeys, sessionDirMatches, decideInjectionScope, readState, writeState, writeBindingEntry } = _test

test('cleanSillyTavernVars: 移除双冒号变量 {{xxx::yyy}}', () => {
  assert.equal(cleanSillyTavernVars('a{{setvar::key::value}}b'), 'ab')
  assert.equal(cleanSillyTavernVars('{{format_message_variable::stat_data}}'), '')
})

test('cleanSillyTavernVars: 移除中文名/点开头/多行变量', () => {
  assert.equal(cleanSillyTavernVars('{{涩调}}'), '')
  assert.equal(cleanSillyTavernVars('{{.side_last_dir}}'), '')
  assert.equal(cleanSillyTavernVars('{{SYSTEM_INIT::\nSEED=x\n}}'), '')
})

test('cleanSillyTavernVars: 保留 DSH 合法变量 provider/model/cwd', () => {
  assert.equal(cleanSillyTavernVars('{{provider}}/{{model}}/{{cwd}}'), '{{provider}}/{{model}}/{{cwd}}')
})

test('cleanSillyTavernVars: 友好替换常见 ST 变量', () => {
  // 2026-09-24 语义修正：{{char}} 是角色名，不再错换玩家名（旧断言=清空是 bug 行为），
  // 求值为中性词「角色」；{{user}} 保持旧语义（playerName 为空则空）
  assert.equal(cleanSillyTavernVars('{{user}}和{{char}}'), '和角色')
  assert.equal(cleanSillyTavernVars('{{name}}'), '')
})

test('sanitizePromptText: random 随机取一个值', () => {
  const out = sanitizePromptText('选一个{{random::甲,乙,丙}}')
  assert.ok(['甲', '乙', '丙'].includes(out.replace('选一个', '')))
})

test('sanitizePromptText: roll 生成随机数', () => {
  const out6 = Number(sanitizePromptText('{{roll::6}}'))
  assert.ok(out6 >= 1 && out6 <= 6)
  const out28 = Number(sanitizePromptText('{{roll::2,8}}'))
  assert.ok(out28 >= 2 && out28 <= 8)
})

test('sanitizePromptText: user/char 友好替换', () => {
  assert.equal(sanitizePromptText('{{user}}说', '角色'), '用户说')
  assert.equal(sanitizePromptText('{{char}}说', '角色'), '角色说')
})

test('sanitizePromptText: 多行 SYSTEM_INIT 变量删除', () => {
  assert.equal(sanitizePromptText('前{{SYSTEM_INIT::\nSEED=rand(1,9)\n}}后'), '前后')
})

test('sanitizePromptText: 普通文本不被破坏', () => {
  const text = '你是一个角色扮演助手，请保持剧情连贯。'
  assert.equal(sanitizePromptText(text), text)
})

test('randomPick: 空返回空串', () => {
  assert.equal(randomPick(''), '')
  assert.equal(randomPick('  ,  ,  '), '')
})

test('randomRoll: 非法输入返回空串', () => {
  assert.equal(randomRoll('abc'), '')
  assert.equal(randomRoll(''), '')
})

test('normalizeName: 用户称呼归一化为"你"', () => {
  assert.equal(normalizeName('玩家'), '你')
  assert.equal(normalizeName('主角'), '你')
  assert.equal(normalizeName('用户'), '你')
  assert.equal(normalizeName('食客'), '你')
  assert.equal(normalizeName('食客（男主角）'), '你')
  assert.equal(normalizeName('你'), '你')
})

test('normalizeName: 角色名保持不变', () => {
  assert.equal(normalizeName('花火'), '花火')
  assert.equal(normalizeName('阿格莱雅'), '阿格莱雅')
  assert.equal(normalizeName(''), '')
})

test('normalizeName: 乱码名丢弃', () => {
  assert.equal(normalizeName('���角'), '')
})

test('cleanName: 保留合法字符清除乱码', () => {
  assert.ok(!cleanName('a\uFFFDb').includes('\uFFFD'))
  assert.equal(cleanName('正常'), '正常')
})

test('sanitizePromptText: 剥离 thinking 输出指令（防止 deepseek 输出尖括号）', () => {
  const out = sanitizePromptText('前文<thinking_rules>\n全程用中文思考\n[STEP 0 — IDENTITY]\n</thinking_rules>后文')
  assert.ok(!out.includes('<thinking'))
  assert.ok(!out.includes('thinking_rules'))
  assert.ok(out.includes('前文'))
  assert.ok(out.includes('后文'))
})

test('sanitizePromptText: 剥离 output_lock 指令块', () => {
  const out = sanitizePromptText('<output_lock>\nAt the START of every reply, output this block:\n<thinking>x</thinking>\n</output_lock>正文')
  assert.ok(!out.includes('output_lock'))
  assert.ok(!out.includes('<thinking'))
  assert.ok(out.includes('正文'))
})

test('sanitizePromptText: 剥离 HTML 注释草稿指令', () => {
  const out = sanitizePromptText('正文<!-- draft 这是草稿 nerver show -->结尾')
  assert.ok(!out.includes('<!--'))
  assert.ok(out.includes('正文'))
  assert.ok(out.includes('结尾'))
})

test('sanitizePromptText: 剥离 Prism 每段注释指令和引用', () => {
  // Prism_tips 块（要求每段前输出 html 注释）
  const t1 = sanitizePromptText('<Prism_tips>\ndef: 在正文的每一段前，输出一个html注释\n</Prism_tips>正文')
  assert.ok(!t1.includes('Prism'))
  assert.ok(!t1.includes('输出一个html注释'))
  assert.ok(t1.includes('正文'))
  // "总结<Prism>内的所有要求" 引用
  const t2 = sanitizePromptText('综合调节: 总结<Prism>内的所有要求！一个要求都不能少')
  assert.ok(!t2.includes('<Prism>'))
  assert.ok(t2.includes('总结所有写作要求'))
})

test('sanitizePromptText: 剥离"先打草稿"规划输出指令', () => {
  // 英文 draft 指令
  const t1 = sanitizePromptText('[FINAL_CHECK] Draft once. Repair only hits. All draft work inside <content> as HTML comments. 正文')
  assert.ok(!/Draft once|HTML comments/.test(t1))
  assert.ok(t1.includes('正文'))
  // 中文打草稿指令
  const t2 = sanitizePromptText('打草稿: 在段落前标签内进行，以html注释的形式插入在输出内容中。正文内容')
  assert.ok(!t2.includes('打草稿'))
  assert.ok(t2.includes('正文内容'))
  // cot 标签
  const t3 = sanitizePromptText('<cot>\n思考步骤\n</cot>\n正文')
  assert.ok(!t3.includes('<cot>'))
  assert.ok(t3.includes('正文'))
})

// ── 提示词体积估算（面板「提示词体积」卡片）──
test('estimatePromptBudget: 小提示词不打告警', () => {
  const b = estimatePromptBudget(10000, 65536)
  assert.equal(b.chars, 10000)
  assert.equal(b.tokens, 3125)            // 10000 / 3.2
  assert.equal(b.level, 'ok')
})

test('estimatePromptBudget: 超过 60% 报偏大，超过 90% 报危险', () => {
  // 138408 字符 ≈ 43253 tokens，占 65536 窗口的 66%
  const warn = estimatePromptBudget(138408, 65536)
  assert.equal(warn.tokens, 43253)
  assert.equal(warn.pct, 66)              // 保留一位小数后仍是 66.0
  assert.equal(warn.level, 'warn')
  // 窗口砍到 40000 时应判危险
  assert.equal(estimatePromptBudget(138408, 40000).level, 'danger')
})

test('estimatePromptBudget: 非法入参不会算出 NaN', () => {
  for (const v of [0, -1, NaN, null, undefined, 'abc']) {
    const b = estimatePromptBudget(v, 65536)
    assert.equal(b.chars, 0)
    assert.equal(b.tokens, 0)
    assert.equal(b.level, 'ok')
  }
})

test('estimatePromptBudget: 窗口非法时回落到默认 65536', () => {
  const def = estimatePromptBudget(32000, 65536)
  for (const w of [0, -5, NaN, null, 'x']) {
    assert.deepEqual(estimatePromptBudget(32000, w), def)
  }
})

// ── 会话存储迁出预设根目录 ──
// 背景：.agent-presets 下每个名字合法的目录都会被 DSH 当成一行预设，
// 缺 agent.cordis.yml 就标「加载失败」。插件的 sessions/ 曾建在这里。
function tmpRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mig-'))
  return { base, oldRoot: path.join(base, 'presets', 'sessions'), newRoot: path.join(base, 'tavern-data', 'sessions') }
}

test('migrateSessionStorage: 空壳目录被丢弃，旧目录被删除', () => {
  const { oldRoot, newRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 'session-aaa'), { recursive: true })   // 空目录
  const r = migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.dropped, 1)
  assert.equal(r.moved, 0)
  assert.equal(r.removed, true)
  assert.equal(fs.existsSync(oldRoot), false)                            // 关键：不留空目录占 id
})

test('migrateSessionStorage: 有数据的会话被搬走且内容不丢', () => {
  const { oldRoot, newRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 'session-bbb'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 'session-bbb', 'memory.md'), '记忆正文', 'utf8')
  const r = migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.moved, 1)
  assert.equal(r.removed, true)
  assert.equal(fs.readFileSync(path.join(newRoot, 'session-bbb', 'memory.md'), 'utf8'), '记忆正文')
})

test('migrateSessionStorage: 目标已存在时不覆盖，丢弃旧副本', () => {
  const { oldRoot, newRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's1'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 's1', 'relations.json'), '旧', 'utf8')
  fs.mkdirSync(path.join(newRoot, 's1'), { recursive: true })
  fs.writeFileSync(path.join(newRoot, 's1', 'relations.json'), '新', 'utf8')
  const r = migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.dropped, 1)
  assert.equal(r.moved, 0)
  assert.equal(fs.readFileSync(path.join(newRoot, 's1', 'relations.json'), 'utf8'), '新')
})

test('migrateSessionStorage: 旧目录不存在时是幂等空操作', () => {
  const { oldRoot, newRoot } = tmpRoots()
  const r = migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.deepEqual(r, { moved: 0, dropped: 0, removed: false })
  assert.equal(fs.existsSync(newRoot), false)
})

test('默认预设组合文件用 prefix 而不是 text（否则挂载直接失败）', () => {
  assert.ok(DEFAULT_PRESET_YML.includes('prefix: |-'))
  assert.ok(!DEFAULT_PRESET_YML.includes('text: |-'))
  assert.ok(DEFAULT_PRESET_YML.includes("'@deepseek-ai/dsh-persona'"))
  assert.ok(DEFAULT_PRESET_META.includes('name:'))
})

// ── 回复体检：区分「模型拒绝」和「角色在台词里拒绝」──
test('detectRefusal: 中文拒绝（作为AI + 内容政策）判为 refusal', () => {
  const d = detectRefusal('抱歉，我不能写这段内容。作为AI助手，我需要遵守内容政策。')
  assert.equal(d.verdict, 'refusal')
  assert.ok(d.hits.length >= 2)
  assert.ok(d.score >= 90)
})

test('detectRefusal: 英文拒绝判为 refusal', () => {
  const d = detectRefusal("I'm sorry, but I can't assist with that request.")
  assert.equal(d.verdict, 'refusal')
  assert.ok(d.hits.some((h) => h.includes('assist')))
})

test('detectRefusal: 长正文里角色说「我不能」不算拒绝（关键反例）', () => {
  const rp = '「我不能让你这么做。」少年把剑横在身前，挡住了去路。'.repeat(40)
  const d = detectRefusal(rp)
  assert.equal(d.verdict, 'ok')
  assert.equal(d.score, 0)
})

test('detectRefusal: 短而正常的回复不误判', () => {
  assert.equal(detectRefusal('好的，我们继续。').verdict, 'ok')
  assert.equal(detectRefusal('').verdict, 'ok')
  assert.equal(detectRefusal(null).verdict, 'ok')
})

test('detectRefusal: 长正文后面附一段拒绝 → 判为拒绝', () => {
  // 命中 强「无法提供」(45) + 中「你希望我…否定」(25) = 70，过 60 的门限
  const d = detectRefusal('这段我接着写。'.repeat(200) + '不过，如果你希望我描写更极端的暴力内容，我无法提供。')
  assert.equal(d.verdict, 'refusal')
  assert.equal(d.score, 70)
  assert.ok(d.hits.some((h) => h.includes('无法提供')))
})

test('detectRefusal: 光有「你想让我」这种句式、后面没否定 → 不报', () => {
  const d = detectRefusal('你想让我怎么做？'.repeat(100))
  assert.equal(d.verdict, 'ok')
  assert.equal(d.score, 0)
})

test('detectRefusal: 道歉开头的否定也抓得住', () => {
  const d = detectRefusal('很抱歉，这个我无法描写。')
  assert.ok(d.verdict !== 'ok')
})

test('detectRefusal: 命中时会给出可读的证据片段', () => {
  const d = detectRefusal('作为AI，我不能协助这个请求。')
  assert.ok(d.excerpt.length > 0)
  assert.ok(d.excerpt.includes('作为AI') || d.excerpt.includes('协助'))
  assert.equal(d.length, '作为AI，我不能协助这个请求。'.length)
})

// ── 预设 / 会话隔离的权威解析 ──
// 回归自真实故障：用户在顶部把会话改成「标准模式」(standard)，
// 但因为 standard 不是酒馆目录，旧实现会继续往前翻历史选择，翻到深渊并照旧注入。
const isTavern = (id) => id === 'preset-mtyx98fa-pdsrh1' || id === 'tavern-lite'

test('pickAuthoritativePreset: 最新显式选择是酒馆预设 → 用它', () => {
  assert.equal(pickAuthoritativePreset('preset-mtyx98fa-pdsrh1', isTavern, 'preset-mtyx98fa-pdsrh1'), 'preset-mtyx98fa-pdsrh1')
})

test('pickAuthoritativePreset: 最新显式选择是内置预设 → 判定不注入（关键回归）', () => {
  // 这就是隔离失效的那个洞：选了 standard，就必须返回 default，不能翻历史
  assert.equal(pickAuthoritativePreset('standard', isTavern, ''), 'default')
})

test('pickAuthoritativePreset: 显式选了内置预设时，过期的 bindings 不得翻盘（关键回归）', () => {
  // 用户选了 standard，但 bindings 里还记着深渊 —— 必须听用户的，不是听记账
  assert.equal(pickAuthoritativePreset('standard', isTavern, 'preset-mtyx98fa-pdsrh1'), 'default')
})

test('pickAuthoritativePreset: 事件流没有预设记录时，才退回 bindings', () => {
  assert.equal(pickAuthoritativePreset(null, isTavern, 'preset-mtyx98fa-pdsrh1'), 'preset-mtyx98fa-pdsrh1')
})

test('pickAuthoritativePreset: 都没有 → default', () => {
  assert.equal(pickAuthoritativePreset(null, isTavern, ''), 'default')
  assert.equal(pickAuthoritativePreset(null, isTavern, 'standard'), 'default')  // bindings 里是内置预设也当无绑定
})

// ── 从日志行里取会话预设（本次故障的真正要害）──
// DSH 把「会话当前的预设」写在创建记录行（type:"session"），
// 旧实现要求该行同时含 agent-preset/selected 或 "header" 才认 —— 两个都不含，于是永远取不到值。
test('extractAgentPresetFromLine: 从会话创建记录里取得到（关键回归）', () => {
  const line = '{"type":"session","id":"session-x","agentPreset":"standard","cwd":"D:/x"}'
  assert.equal(extractAgentPresetFromLine(line), 'standard')
})

test('extractAgentPresetFromLine: agent-preset/selected 事件同样取得到', () => {
  const line = '{"type":"agent-preset/selected","data":{"agentPreset":"preset-mtyx98fa-pdsrh1"}}'
  assert.equal(extractAgentPresetFromLine(line), 'preset-mtyx98fa-pdsrh1')
})

test('extractAgentPresetFromLine: 只出现词、没有键值对的行取不到（防自身输出污染）', () => {
  // 我们的诊断脚本源码里就有 "agentPreset" 这个词，会被日志原样记下
  assert.equal(extractAgentPresetFromLine('if (!ln.includes("agentPreset")) continue'), '')
  assert.equal(extractAgentPresetFromLine('l.includes("agentPreset")'), '')
})

test('extractAgentPresetFromLine: 无关行返回空串', () => {
  assert.equal(extractAgentPresetFromLine('{"type":"user/message"}'), '')
  assert.equal(extractAgentPresetFromLine(''), '')
  assert.equal(extractAgentPresetFromLine(null), '')
  assert.equal(extractAgentPresetFromLine(undefined), '')
})

// ── 会话日志目录与 id 的前缀归一化 ──────────────────────────────
//
// 线上实测的真因：`getCurrentSessionId()`（客户端）与 `session-bindings.json` 用的都是
// **`session-<uuid>`**，而 DSH 的会话日志目录**大多数是裸 `<uuid>`**
// （实测：裸 189 个 / 带前缀 71 个）。
//
// 旧实现只有 `sd.name === sessionId || sd.name.includes(sessionId)`，存在**方向性**缺陷：
// 传 `session-<uuid>`、目录名是裸 `<uuid>` 时，`===` 不中，而
// `'<uuid>'.includes('session-<uuid>')` **方向也是反的** ⇒ 两个判据都不中 ⇒ 查不到日志
// ⇒ `resolveAuthoritativePresetId()` 静默退回 bindings（多数会话没有记录）⇒ 返回 `default`。
// 后果：**73%（189/260）的会话权威预设失效**。线上对照读数：
//   ?sessionId=session-01c8609b-… → default        （错）
//   ?sessionId=01c8609b-…         → preset-mt1vwaes-ieavdv（对）
test('sessionIdKeys: 两种形式互为候选（带前缀 / 裸 uuid）', () => {
  const u = '01c8609b-f904-4fd6-aff1-2fc52af2f0fe'
  assert.deepEqual(sessionIdKeys('session-' + u), ['session-' + u, u])
  assert.deepEqual(sessionIdKeys(u), [u, 'session-' + u])
  assert.deepEqual(sessionIdKeys(''), [])
  assert.deepEqual(sessionIdKeys(null), [])
})

test('sessionDirMatches: 目录名与 id 的四种组合都匹配（关键回归）', () => {
  const u = '01c8609b-f904-4fd6-aff1-2fc52af2f0fe'
  // ★ 这一格正是线上失效的那一格：传带前缀、目录名是裸 uuid
  assert.equal(sessionDirMatches(u, 'session-' + u), true)
  assert.equal(sessionDirMatches('session-' + u, 'session-' + u), true)
  assert.equal(sessionDirMatches(u, u), true)
  assert.equal(sessionDirMatches('session-' + u, u), true)
  // 反例：不能张冠李戴、不能因为空值就匹配
  assert.equal(sessionDirMatches('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'session-' + u), false)
  assert.equal(sessionDirMatches(u, ''), false)
  assert.equal(sessionDirMatches('', u), false)
})

// ── 出生默认值 vs 显式切换：面板选卡被静默推翻的那个洞 ──
//
// 真实故障（线上实测 session-fb2f7f9f-…）：用户在酒馆面板选了「足控天堂」
// （preset-mt5ip9cc-t6josi，bindings 里有记账），新开对话后：
//   - 会话日志 1046 行，创建记录 = {"agentPreset":"standard"}，**一条 agent-preset/selected 都没有**
//   - /api/tavern/current-session 返回 default ⇒ 注入的是 tavern-lite（川上富江）那张卡
// 根因不是 bindings 写丢了，而是 `standard` 这个**出生默认值**被当成了用户的显式选择。
//
// 为什么每个新建会话的创建记录都是 `standard`：
//   dsh-client-ui-workspace dist/client.js:55  `this.sessions.create({ workspaceId })`
//   dsh-api-session-controller sessions/manager.js:459  `create(opts)` 只拼 workspaceId/cwd/sessionId
//   ⇒ 请求里根本没有 agentPreset ⇒ 宿主 composeAgent(undefined) → presets.resolve(undefined) → defaultId
//   ⇒ 创建记录写的是**部署默认预设**，与面板选的那张卡无关。
// 用户的选择只落在两处：酒馆 bindings（面板写的）与 agent-preset/selected（顶部选择器写的）。
test('classifySessionPresetLines: 创建记录与显式切换分别取出（关键回归）', () => {
  const lines = [
    '{"type":"session","id":"session-x","agentPreset":"standard","cwd":"D:/x"}',
    '{"type":"permission/preset","data":{}}',
    '{"type":"agent-preset/selected","seq":3,"data":{"agentPreset":"preset-mtyx98fa-pdsrh1"}}',
    '{"type":"user/message","data":{}}',
  ]
  assert.deepEqual(classifySessionPresetLines(lines), { explicit: 'preset-mtyx98fa-pdsrh1', creation: 'standard' })
})

test('classifySessionPresetLines: 只有创建记录时 explicit 为 null（线上 1046 行那例）', () => {
  const lines = [
    '{"type":"session","id":"session-fb2f7f9f","agentPreset":"standard","cwd":"C:/deepseek harness"}',
    '{"type":"user/message","data":{"content":[{"type":"text","text":"开始"}]}}',
  ]
  assert.deepEqual(classifySessionPresetLines(lines), { explicit: null, creation: 'standard' })
})

test('classifySessionPresetLines: 取最新一条显式切换，不受更早的切换影响', () => {
  const lines = [
    '{"type":"session","agentPreset":"standard"}',
    '{"type":"agent-preset/selected","seq":3,"data":{"agentPreset":"preset-mtyx98fa-pdsrh1"}}',
    '{"type":"agent-preset/selected","seq":9,"data":{"agentPreset":"tavern-lite"}}',
  ]
  assert.deepEqual(classifySessionPresetLines(lines), { explicit: 'tavern-lite', creation: 'standard' })
})

test('classifySessionPresetLines: 非数组 / 脏行不炸', () => {
  assert.deepEqual(classifySessionPresetLines(null), { explicit: null, creation: null })
  assert.deepEqual(classifySessionPresetLines(undefined), { explicit: null, creation: null })
  assert.deepEqual(classifySessionPresetLines([null, 1, '', 'if (!ln.includes("agentPreset")) continue']), { explicit: null, creation: null })
})

// ⚠ P0-1 起绑定升级为三态判别联合：**旧字符串 = legacy**（无法证明是用户显式绑定），
//   解析时视为未绑定、不注入；「面板绑定」必须用新格式对象表达。
//   下面两条因此改成新格式 —— 守的还是同一件事：用户显式选的卡不得被出生默认值推翻。
test('pickAuthoritativePresetFromLog: 出生默认值不得推翻面板绑定（本次修复的要害）', () => {
  // 场景 = 线上 session-fb2f7f9f…：创建记录 standard、无显式切换、面板绑了某张卡
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'standard', isTavern,
      { mode: 'preset', presetId: 'preset-mtyx98fa-pdsrh1', source: 'panel' }),
    'preset-mtyx98fa-pdsrh1'
  )
  // 对照臂（P0-4）：同一条绑定若是**旧字符串格式**（legacy），不得静默注入 ——
  // 这正是「足控天堂」被永久注入的那条路径。
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'standard', isTavern, 'preset-mtyx98fa-pdsrh1'),
    'default'
  )
})

test('pickAuthoritativePresetFromLog: 显式切回内置预设时，bindings 依旧不得翻盘（旧语义保留）', () => {
  assert.equal(
    pickAuthoritativePresetFromLog('standard', 'standard', isTavern, 'preset-mtyx98fa-pdsrh1'),
    'default'
  )
})

test('pickAuthoritativePresetFromLog: 显式切到酒馆预设 → 用它，且忽略 bindings', () => {
  assert.equal(
    pickAuthoritativePresetFromLog('tavern-lite', 'standard', isTavern, 'preset-mtyx98fa-pdsrh1'),
    'tavern-lite'
  )
})

// ⚠ P0-5 语义变更：出生默认值（creation）**不再是注入依据** —— 与 legacy 同等对待。
//   旧断言是「无显式切换、无绑定 → 退回出生默认值」，那正是「用户从没选过却被注入」的通道。
test('pickAuthoritativePresetFromLog: 无显式切换、无绑定 → 出生默认值也**不注入**（P0-5）', () => {
  assert.equal(pickAuthoritativePresetFromLog(null, 'preset-mtyx98fa-pdsrh1', isTavern, ''), 'default')
  // 反证：同一张卡走**显式选择 / 显式绑定**时照常注入（否则这条测试是空跑）
  assert.equal(pickAuthoritativePresetFromLog('preset-mtyx98fa-pdsrh1', null, isTavern, ''), 'preset-mtyx98fa-pdsrh1')
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'preset-mtyx98fa-pdsrh1', isTavern,
      { mode: 'preset', presetId: 'preset-mtyx98fa-pdsrh1', source: 'panel' }),
    'preset-mtyx98fa-pdsrh1'
  )
})

test('pickAuthoritativePresetFromLog: 无显式切换、无绑定、出生默认是内置预设 → default', () => {
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, ''), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, null, isTavern, ''), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, 'standard'), 'default')
})

test('pickAuthoritativePresetFromLog: 绑定优先于出生默认值', () => {
  // 会话出生在某张酒馆卡上，之后用户在面板改选另一张 → 听面板的
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'tavern-lite', isTavern,
      { mode: 'preset', presetId: 'preset-mtyx98fa-pdsrh1', source: 'panel' }),
    'preset-mtyx98fa-pdsrh1'
  )
  // 对照臂：顶部选择器选的（top-select）同样优先于出生默认值
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'tavern-lite', isTavern,
      { mode: 'preset', presetId: 'preset-mtyx98fa-pdsrh1', source: 'top-select' }),
    'preset-mtyx98fa-pdsrh1'
  )
})

test('pickAuthoritativePresetFromLog: mode:none（显式解绑）→ 硬空，不看出生默认值也不看兜底', () => {
  const none = { mode: 'none' }
  assert.equal(pickAuthoritativePresetFromLog(null, 'tavern-lite', isTavern, none), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, none), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, null, isTavern, none), 'default')
  // 但顶部**随后**显式选的预设要压过解绑（explicit 排第一，见函数头注释）
  assert.equal(pickAuthoritativePresetFromLog('tavern-lite', 'standard', isTavern, none), 'tavern-lite')
})

test('pickAuthoritativePresetFromLog: 绑定指向已删除的预设 → fail closed，绝不换绑到别的卡', () => {
  // creation 是另一张酒馆卡；若这里退回 creation 就等于「悄悄换了一张卡」。
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'tavern-lite', isTavern,
      { mode: 'preset', presetId: 'preset-已被删除', source: 'panel' }),
    'default'
  )
})

// ══════════════════════════════════════════════════════════
// P0-5 生效范围闸门：白名单语义改为「空 = 不放行」
//
//   旧语义：`mode:'allowlist'` + 两个名单都空 ⇒ **不限制**（全放行）。而默认状态
//   恰好就是它 ⇒ 用户「一个都没勾」却在每条会话里都吃到了角色卡 / 世界书 / 会话记忆。
//
//   下面每条都用**哨兵**断言（不只断言长度）：同一套夹具下只改 state，
//   看产物里有没有那张卡的三个哨兵（角色卡 / 世界书 / 会话记忆）。
// ══════════════════════════════════════════════════════════

const SCOPE_ROOT = path.join(CORE_TMP_HOME, '.agent-presets')
const SCOPE_PRESET = 'preset-scope'
const SCOPE_CARD = 'SENTINEL-SCOPE-CARD-5f2a91'
const SCOPE_WB = 'SENTINEL-SCOPE-WB-7c3d18'
const SCOPE_MEM = 'SENTINEL-SCOPE-MEM-9e6b40'

// 一张「酒馆可管理」的预设：preset.yml + agent.cordis.yml（角色卡正文）+ 世界书（全量注入）
;(function makeScopePreset() {
  const dir = path.join(SCOPE_ROOT, SCOPE_PRESET)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: ' + SCOPE_PRESET + '\n')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
    '- id: persona', '  name: persona', '  config:', '    prefix: |-', '      ' + SCOPE_CARD, '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([
    { name: '闸门角色', enabled: true, desc: SCOPE_CARD + '（角色卡正文）' },
  ]))
  fs.writeFileSync(path.join(dir, 'worldbook.json'), JSON.stringify({
    version: 2, injectMode: 'full',
    entries: [{ id: '1', name: '闸门条目', content: SCOPE_WB + '（世界书正文）', enabled: true, disable: false }],
  }))
})()

/** 会话级记忆（<DSH_HOME>/tavern-data/sessions/<sid>/memory.md）—— 记忆也过同一道闸门。 */
function writeScopeMemory(sid, text) {
  const f = path.join(CORE_TMP_HOME, 'tavern-data', 'sessions', sid, 'memory.md')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text, 'utf8')
}

const scopeSections = {}
apply({
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => fn(),
  systemPrompt: { section: (o) => { scopeSections[o.name] = o; return () => {} } },
  webServer: { register: () => {} },
  sessions: {},
})
const scopeAssemble = scopeSections['tavern:card'].text
const scopeAssembleNsfw = scopeSections['tavern:nsfw'] ? scopeSections['tavern:nsfw'].text : null
const scopeCtx = (sid, cwd) => ({ agent: { session: { id: sid, header: { id: sid, cwd: cwd || '' } } } })
/** 写一份 state（mode / 名单），readState() 每次组装都从盘上读，所以每条用例都要先写。 */
const setScopeState = (over) => writeState({
  cardEnabled: true, mode: 'allowlist', allowSessions: [], allowCwds: [], disabledCwds: [], ...over,
})
const SCOPE_S1 = 'sid-scope-s1'
const SCOPE_S2 = 'sid-scope-s2'
writeBindingEntry(SCOPE_S1, { mode: 'preset', presetId: SCOPE_PRESET, source: 'panel' })
writeBindingEntry(SCOPE_S2, { mode: 'preset', presetId: SCOPE_PRESET, source: 'panel' })
writeScopeMemory(SCOPE_S1, '# 记忆总结\n' + SCOPE_MEM + '（会话记忆正文）\n')
writeScopeMemory(SCOPE_S2, '# 记忆总结\n' + SCOPE_MEM + '（会话记忆正文）\n')

/** 断言产物里**没有**这张卡的任何哨兵（角色卡 / 世界书 / 会话记忆）。 */
function assertScopeNoInjection(out, why) {
  for (const s of [SCOPE_CARD, SCOPE_WB, SCOPE_MEM]) {
    assert.ok(!String(out).includes(s), '★ 泄漏了哨兵 ' + s + '（' + why + '）')
  }
}
/** 反证：同一套夹具在放行时确实能把三个哨兵都注入（否则「零注入」的断言是空跑）。 */
function assertScopeInjected(out, why) {
  for (const s of [SCOPE_CARD, SCOPE_WB, SCOPE_MEM]) {
    assert.ok(String(out).includes(s), '★ 应当注入却没注入哨兵 ' + s + '（' + why + '）—— 夹具坏了')
  }
}

test('P0-5 白名单：mode=allowlist + 两个名单皆空 → 零注入（角色卡/世界书/记忆 哨兵全无）', () => {
  setScopeState({ mode: 'allowlist', allowSessions: [], allowCwds: [] })
  const out = scopeAssemble(scopeCtx(SCOPE_S1))
  // ⚠ 先点名哨兵、再断言空串：这样「闸门被改坏」时报错会指名道姓说是哪一段泄漏了
  assertScopeNoInjection(out, 'allowlist 双空')
  assert.equal(out, '', '★ 空名单仍然注入了内容 —— 旧语义「空 = 不限制」没关掉')
  // 反证：同一会话切成 global 立刻注入（证明「零注入」不是夹具没造好）
  setScopeState({ mode: 'global' })
  assertScopeInjected(scopeAssemble(scopeCtx(SCOPE_S1)), 'global 反证')
})

test('P0-5 连带影响：空名单下世界书 / 会话记忆 / 反八股与角色卡**一并停止**（同一道闸门）', () => {
  setScopeState({ mode: 'allowlist', allowSessions: [], allowCwds: [] })
  const out = String(scopeAssemble(scopeCtx(SCOPE_S1)))
  assert.ok(!out.includes(SCOPE_CARD), '★ 角色卡在空名单下仍在注入')
  assert.ok(!out.includes(SCOPE_WB), '★ **世界书**在空名单下仍在注入')
  assert.ok(!out.includes(SCOPE_MEM), '★ **会话记忆**在空名单下仍在注入')
  assert.ok(!out.includes('写作风格铁律'), '★ 反八股在空名单下仍在注入')
  // 反证：放行时这四段**都在**（证明它们确实走这道闸门，不是本来就注入不出来）
  setScopeState({ mode: 'global' })
  const on = String(scopeAssemble(scopeCtx(SCOPE_S1)))
  for (const s of [SCOPE_CARD, SCOPE_WB, SCOPE_MEM, '写作风格铁律']) {
    assert.ok(on.includes(s), '★ 反证失败：放行时却没注入 ' + s + ' —— 夹具坏了，上面的「零注入」是空跑')
  }
})

test('P0-5 连带影响取证：关系网**不参与提示词注入**（空名单对它既不停也不漏）', () => {
  // 关系网只有 /api/tavern/relations 这一条出口（供面板读），从来不进系统提示。
  // 所以「空名单 → 关系网一并停止」这句话不成立 —— 这里把它钉死，免得对接方误以为
  // 关系网也被这道闸门关掉了。做法：落一份带哨兵的 relations.json，
  // 断言**放行时**提示词里也搜不到它。
  const f = path.join(CORE_TMP_HOME, 'tavern-data', 'sessions', SCOPE_S1, 'relations.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ nodes: [{ id: 'n1', name: 'SENTINEL-SCOPE-REL-2b8c77' }], edges: [] }), 'utf8')
  setScopeState({ mode: 'global' })
  const on = String(scopeAssemble(scopeCtx(SCOPE_S1)))
  assert.ok(on.includes(SCOPE_CARD), '反证失败：这一轮本就该注入角色卡')
  assert.ok(!on.includes('SENTINEL-SCOPE-REL-2b8c77'), '★ 关系网竟然进了提示词 —— 说明它另有注入路径，上述结论要改')
})

test('P0-5 白名单：allowSessions=[s1] → s1 注入、s2 零注入（逐项判定没被误伤）', () => {
  setScopeState({ mode: 'allowlist', allowSessions: [SCOPE_S1], allowCwds: [] })
  assertScopeInjected(scopeAssemble(scopeCtx(SCOPE_S1)), '白名单内的会话')
  const out2 = scopeAssemble(scopeCtx(SCOPE_S2))
  assert.equal(out2, '', '★ 不在白名单里的会话仍然被注入')
  assertScopeNoInjection(out2, '白名单外的会话')
})

test('P0-5 白名单：allowCwds 命中工作目录 → 放行；不命中 → 零注入', () => {
  setScopeState({ mode: 'allowlist', allowSessions: [], allowCwds: ['C:\\work\\proj'] })
  assertScopeInjected(scopeAssemble(scopeCtx(SCOPE_S1, 'C:\\work\\proj\\')), 'allowCwds 命中')
  const out = scopeAssemble(scopeCtx(SCOPE_S1, 'D:\\other'))
  assert.equal(out, '', '★ 工作目录不在 allowCwds 里却放行')
  assertScopeNoInjection(out, 'allowCwds 未命中')
})

test('P0-5 mode=global：行为与改动前一致（全放行；disabledCwds 黑名单依旧生效）', () => {
  // ① 改动前 global 分支只做一件事：命中 disabledCwds 就返回空；否则放行。
  //    两个 allowedBy 标记在改动前后**都是 false**（观测日志照旧记 allowedBy:'none'）。
  assert.deepEqual(decideInjectionScope({ mode: 'global', allowSessions: [], allowCwds: [] }, SCOPE_S1, 'C:\\work'),
    { allowed: true, allowedBySession: false, allowedByCwd: false })
  assert.deepEqual(decideInjectionScope({ mode: 'global', allowSessions: ['x'], allowCwds: ['y'] }, SCOPE_S1, 'C:\\work'),
    { allowed: true, allowedBySession: false, allowedByCwd: false }, '★ global 不该去看白名单')

  // ② 端到端：global 且名单为空 → 照旧注入（**空名单的新语义只约束 allowlist 模式**）
  setScopeState({ mode: 'global', allowSessions: [], allowCwds: [] })
  assertScopeInjected(scopeAssemble(scopeCtx(SCOPE_S1)), 'global + 空名单')

  // ③ global 的 disabledCwds 黑名单：命中就停（改动前就有，不许被顺手改掉）
  setScopeState({ mode: 'global', disabledCwds: ['C:\\blocked\\proj'] })
  const out = scopeAssemble(scopeCtx(SCOPE_S1, 'C:\\blocked\\proj'))
  assert.equal(out, '', '★ global 模式下 disabledCwds 黑名单失效了')
  assertScopeNoInjection(out, 'global + disabledCwds 命中')
  // 黑名单之外照旧注入
  assertScopeInjected(scopeAssemble(scopeCtx(SCOPE_S1, 'C:\\elsewhere')), 'global + 黑名单之外')
})

test('P0-5b nsfw 一致性：tavern:nsfw 与主闸门共用 decideInjectionScope（空名单下破限段也停）', () => {
  // 旧写法是 `if (hasAllowlist) {…检查…}` —— 空名单时**整段跳过检查** = 放行。
  // 后果：主闸门把角色卡/世界书/记忆全关了，破限段却还在 —— 语义劈叉。本用例钉死它。
  assert.ok(typeof scopeAssembleNsfw === 'function', '★ tavern:nsfw 段没注册 —— 夹具坏了，本用例是空跑')
  setScopeState({ mode: 'allowlist', allowSessions: [], allowCwds: [], nsfwEnabled: true })
  const out = String(scopeAssembleNsfw(scopeCtx(SCOPE_S1)))
  assert.ok(!out.includes('成人模式'), '★ 空名单下破限段（tavern:nsfw）仍在注入 —— nsfw 段没接统一闸门')
  // 反证：显式加白后破限段恢复（证明「不注入」不是 nsfwEnabled 没生效之类的夹具问题）
  setScopeState({ mode: 'allowlist', allowSessions: [SCOPE_S1], allowCwds: [], nsfwEnabled: true })
  const on = String(scopeAssembleNsfw(scopeCtx(SCOPE_S1)))
  assert.ok(on.includes('成人模式'), '反证失败：加白后破限段没注入 —— 夹具坏了，上面的断言是空跑')
})

test('P0-5b nsfw：nsfwEnabled 关闭时照旧整段不注入（既有行为护栏，不许被顺带改掉）', () => {
  setScopeState({ mode: 'global', nsfwEnabled: false })
  const out = String(scopeAssembleNsfw(scopeCtx(SCOPE_S1)))
  assert.ok(!out.includes('成人模式'), '★ nsfwEnabled=false 却注入了破限段')
  // 且不受白名单影响：global + nsfwEnabled=true 才注入（上一条用例已反证过，这里只守关闭态）
})

test('P0-5 闸门纯函数：四种名单组合的判定表（空 / 会话命中 / 目录命中 / 都不命中）', () => {
  const st = (allowSessions, allowCwds, mode) => ({ mode: mode || 'allowlist', allowSessions, allowCwds, disabledCwds: [] })
  // ① 两个名单都空 → 谁都不放行（本次改的那一支）
  assert.equal(decideInjectionScope(st([], []), SCOPE_S1, 'C:\\work').allowed, false)
  assert.equal(decideInjectionScope(st([], []), '', '').allowed, false, '连 sid / cwd 都取不到时也不放行')
  assert.equal(decideInjectionScope(undefined, SCOPE_S1, 'C:\\work').allowed, false, 'state 缺失时保守不放行')
  // ② allowSessions 非空、allowCwds 空 → 只按会话逐项判定
  const r = decideInjectionScope(st([SCOPE_S1], []), SCOPE_S1, 'C:\\work')
  assert.deepEqual(r, { allowed: true, allowedBySession: true, allowedByCwd: false })
  assert.equal(decideInjectionScope(st([SCOPE_S1], []), SCOPE_S2, 'C:\\work').allowed, false)
  // ③ allowSessions 空、allowCwds 非空 → 只按目录逐项判定
  const r2 = decideInjectionScope(st([], ['C:\\work']), SCOPE_S2, 'C:\\work')
  assert.deepEqual(r2, { allowed: true, allowedBySession: false, allowedByCwd: true })
  assert.equal(decideInjectionScope(st([], ['C:\\work']), SCOPE_S2, 'D:\\x').allowed, false)
  // ④ 两个名单都非空 → 任一命中即放行
  const r3 = decideInjectionScope(st([SCOPE_S1], ['C:\\work']), SCOPE_S2, 'C:\\work')
  assert.deepEqual(r3, { allowed: true, allowedBySession: false, allowedByCwd: true })
})

// ══════════════════════════════════════════════════════════
// P2-1 提示词编译优化：bannedWords 双注入去重 + 世界书按需注入
//
//   · bannedWords 曾经塞两遍（词汇禁令 + 违禁词列表），哨兵词必须恰好出现一次；
//   · groups 世界书的 injectMode 必须跟随卡设定（keyword → 按需注入）；
//   · keys / keywords 并集匹配（ST 的 lorebook 主字段是 keys）；
//   · wbInject 逃生阀：'full' = 无视卡设定强制全量（用户的后悔药）；
//   · manifest 取证：入选条目清单（名 + 原因 + 字符数），绝不记正文。
// ══════════════════════════════════════════════════════════

const { entryKeys, selectWorldbookEntries, resolveWbIsFull } = _test

const WB21_CONST = 'SENTINEL-WB21-CONST-3a1f'        // 无关键词（现语义视为常驻）
const WB21_CONSTANT = 'SENTINEL-WB21-CONSTANT-4b2e'  // constant:true 显式常驻
const WB21_KEYS = 'SENTINEL-WB21-KEYS-5c3d'          // 只写 keys
const WB21_KW = 'SENTINEL-WB21-KW-6d4e'              // 只写 keywords
const WB21_BOTH = 'SENTINEL-WB21-BOTH-7e5f'          // keys ∪ keywords
const WB21_UNRELATED = 'SENTINEL-WB21-UNRELATED-8f6a-'.repeat(6) // 无关大条目

// groups 结构（worldbooks.json，v2，顶层 injectMode=keyword）—— 与用户真实卡同形
;(function makeWb21Preset() {
  const dir = path.join(SCOPE_ROOT, 'preset-wb21')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: preset-wb21\n')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
    '- id: persona', '  name: persona', '  config:', '    prefix: |-', '      SENTINEL-WB21-CARD-9a7b', '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify({
    version: 2, injectMode: 'keyword',
    groups: [
      { name: '组一', enabled: true, entries: [
        { name: '常驻条目', content: WB21_CONST, enabled: true },
        { name: '恒定条目', constant: true, keys: ['恒定触发词'], content: WB21_CONSTANT, enabled: true },
        { name: 'keys条目', keys: ['触发词甲'], content: WB21_KEYS, enabled: true },
        { name: 'kw条目', keywords: ['触发词乙'], content: WB21_KW, enabled: true },
        { name: '并集条目', keys: ['触发词丙'], keywords: ['触发词丙二'], content: WB21_BOTH, enabled: true },
      ] },
      { name: '组二', enabled: true, entries: [
        { name: '无关大条目', keys: ['无关词西'], content: WB21_UNRELATED, enabled: true },
      ] },
    ],
  }))
})()

const WB21_SID = 'sid-wb21'
writeBindingEntry(WB21_SID, { mode: 'preset', presetId: 'preset-wb21', source: 'panel' })
/** WB21 组装：写好 state（默认 global）再组装该卡。 */
const wb21Assemble = (stateOver) => {
  setScopeState({ mode: 'global', allowSessions: [], allowCwds: [], disabledCwds: [], ...stateOver })
  return String(scopeAssemble(scopeCtx(WB21_SID)))
}

// ── A. bannedWords 去重 ────────────────────────────────────
test('P2-1 bannedWords 去重：哨兵词在 assemble 产物中恰好出现一次（原来两遍）', () => {
  const BW = 'SENTINEL-BW21-WORD-1a2b'
  const out = wb21Assemble({ bannedWords: [BW] })
  assert.ok(out.includes('词汇禁令'), '词汇禁令段应该在（保留信息更全的那处）')
  assert.ok(!out.includes('违禁词列表'), '重复的第二段（违禁词列表）应该已删除')
  const n = out.split(BW).length - 1
  assert.equal(n, 1, '★ bannedWords 哨兵出现了 ' + n + ' 次（应恰好 1 次）')
})

// ── B1. groups 世界书保留 injectMode ───────────────────────
test('P2-1 groups 世界书：readWorldbook 保留顶层 injectMode=keyword（卡作者意图不被强制 full）', () => {
  const out = wb21Assemble({}) // wbInject 默认 follow → 跟随卡的 keyword 模式
  assert.ok(out.includes('SENTINEL-WB21-CARD-9a7b'), '角色卡应注入（夹具自检）')
  assert.ok(out.includes(WB21_CONST), '无关键词条目（常驻语义）必须注入')
  assert.ok(!out.includes(WB21_KEYS), '★ keyword 模式下未触发的 keys 条目不得注入（说明 injectMode 被强制成了 full）')
  assert.ok(!out.includes(WB21_UNRELATED), '★ keyword 模式下无关条目不得注入')
})

test('P2-1 非 groups 世界书行为不变：顶层 full（worldbook.json 扁平结构）仍全量注入（回归）', () => {
  // SCOPE 夹具是单数 worldbook.json + 顶层 full —— 行为必须与改动前一致
  setScopeState({ mode: 'global' })
  const out = String(scopeAssemble(scopeCtx(SCOPE_S1)))
  assert.ok(out.includes(SCOPE_WB), '★ full 世界书哨兵没注入 —— 非 groups 路径被改坏了')
})

// ── B2. keys ∪ keywords 并集 ──────────────────────────────
test('P2-1 entryKeys：keys ∪ keywords 并集，大小写不敏感去重', () => {
  assert.deepEqual(entryKeys({ keys: ['Aa'], keywords: ['aa', 'Bb'] }), ['Aa', 'Bb'])
  assert.deepEqual(entryKeys({ keys: ['只keys'] }), ['只keys'])
  assert.deepEqual(entryKeys({ keywords: ['只kw'] }), ['只kw'])
  assert.deepEqual(entryKeys({ keys: [], keywords: [] }), [])
  assert.deepEqual(entryKeys({}), [])
  assert.deepEqual(entryKeys({ key: '单字符串' }), ['单字符串'])
})

test('P2-1 selectWorldbookEntries：只写 keys / 只写 keywords 都能命中，同一条目不重复注入', () => {
  const entries = [
    { name: 'k', keys: ['触发词甲'], content: 'C1', enabled: true },
    { name: 'w', keywords: ['触发词乙'], content: 'C2', enabled: true },
    { name: 'b', keys: ['触发词丙'], keywords: ['别的词'], content: 'C3', enabled: true },
  ]
  const r = selectWorldbookEntries(entries, '聊到触发词甲、触发词乙和触发词丙', false)
  const names = r.injectEntries.map(e => e.name)
  assert.ok(names.includes('k'), '只写 keys 的条目没被命中')
  assert.ok(names.includes('w'), '只写 keywords 的条目没被命中')
  assert.ok(names.includes('b'), '并集条目没被命中')
  assert.equal(names.length, new Set(names).size, '★ 同一条目被重复注入了')
})

test('P2-1 matchWorldbookEntries：keys 主字段支持（utils 与 index 两份实现对齐）', () => {
  const wb = { injectMode: 'keyword', entries: [
    { id: '1', keys: ['触发词甲'], content: 'X', enabled: true },
    { id: '2', keywords: ['触发词乙'], content: 'Y', enabled: true },
  ] }
  for (const fn of [matchWorldbookEntries, _test.matchWorldbookEntries]) {
    const hits = fn(wb, '提到触发词甲和触发词乙')
    assert.equal(hits.length, 2, fn === matchWorldbookEntries ? 'utils 版命中数不对' : 'index 版命中数不对')
    const wb2 = { injectMode: 'keyword', entries: [{ id: '1', keys: ['Hello'], content: 'X', enabled: true }] }
    assert.equal(fn(wb2, 'say hello now').length, 1, 'keys 大小写不敏感匹配失效')
    assert.equal(fn(wb2, '普通对话').length, 0, 'keys 未命中不应注入')
  }
})

// ── C. 质量护栏 ───────────────────────────────────────────
test('P2-1 护栏：常驻条目（constant:true / 无关键词）select 模式必注入；无关条目不注入', () => {
  const entries = [
    { name: 'const1', constant: true, keys: ['永不出现的触发词'], content: 'K1', enabled: true },
    { name: 'nokey', content: 'K2', enabled: true },
    { name: 'far', keys: ['绝对无关词'], content: 'K3', enabled: true },
  ]
  const r = selectWorldbookEntries(entries, '一段普通聊天内容', false)
  const names = r.injectEntries.map(e => e.name)
  assert.ok(names.includes('const1'), '★ constant:true 条目在 select 模式下丢了')
  assert.ok(names.includes('nokey'), '★ 无关键词条目（常驻语义）在 select 模式下丢了')
  assert.ok(!names.includes('far'), '★ 无关条目被注入了')
})

// ── B3. wbInject 逃生阀 ───────────────────────────────────
test('P2-1 wbInject：resolveWbIsFull 判定表（逃生阀 > 卡设定）', () => {
  const kw = { injectMode: 'keyword' }
  const fu = { injectMode: 'full' }
  assert.equal(resolveWbIsFull({ wbInject: 'follow' }, kw), false, 'follow + keyword 卡 → 按需')
  assert.equal(resolveWbIsFull({ wbInject: 'follow' }, fu), true, 'follow + full 卡 → 全量（卡自己的设定）')
  assert.equal(resolveWbIsFull({ wbInject: 'full' }, kw), true, '★ 逃生阀 full 必须压过卡的 keyword')
  assert.equal(resolveWbIsFull(undefined, kw), false, 'state 缺失 → 跟随卡')
  assert.equal(resolveWbIsFull({}, kw), false, 'wbInject 缺失 → 跟随卡')
})

test('P2-1 wbInject 默认 follow（readState 归一化：缺失/非法值一律回 follow，不臆造 full）', () => {
  setScopeState({})
  assert.equal(readState().wbInject, 'follow')
  const out = wb21Assemble({})
  assert.ok(!out.includes(WB21_UNRELATED), '默认 follow 下 keyword 卡的无关条目不得注入')
})

test('P2-1 wbInject=full 逃生阀端到端：keyword 卡恢复全量（后悔药必须真的能救）', () => {
  const out = wb21Assemble({ wbInject: 'full' })
  assert.ok(out.includes(WB21_CONST), '逃生阀下常驻条目照旧注入')
  assert.ok(out.includes(WB21_KEYS), '★ 逃生阀下未触发的条目也必须注入（这才叫全量）')
  assert.ok(out.includes(WB21_UNRELATED), '★ 逃生阀下无关条目也必须注入')
})

// ── B5. manifest 取证 ─────────────────────────────────────
test('P2-1 manifest 取证：inject-debug.log 世界书行含入选清单（名+原因+字符数），绝不含条目正文', () => {
  const logPath = path.join(SCOPE_ROOT, 'inject-debug.log')
  const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').length : 0
  wb21Assemble({ wbInject: 'follow' })
  const added = fs.readFileSync(logPath, 'utf8').slice(before)
  const line = added.split('\n').find(l => l.includes('世界书注入(ST)'))
  assert.ok(line, '本轮没有世界书日志行 —— 夹具坏了')
  assert.ok(line.includes('条目=['), '统计行缺入选清单')
  assert.ok(line.includes('常驻条目[const:'), '清单缺常驻条目（名+原因+字符数）')
  assert.ok(line.includes('恒定条目[const:'), '清单缺 constant:true 条目')
  assert.ok(!line.includes('无关大条目'), '未入选条目不应出现在清单里')
  // 铁律：绝不记条目正文 —— 所有正文哨兵都不得出现在日志行里
  for (const s of [WB21_CONST, WB21_CONSTANT, WB21_KEYS, WB21_KW, WB21_BOTH, WB21_UNRELATED]) {
    assert.ok(!line.includes(s), '★ 日志行泄漏了条目正文哨兵 ' + s)
  }
})

// ── picks 数据形状（manifest 的数据源）─────────────────────
test('P2-1 selectWorldbookEntries 返回 picks：与注入顺序一致，只含名/原因/字符数', () => {
  const entries = [
    { name: '常驻甲', content: 'A'.repeat(10), enabled: true },
    { name: '命中乙', keys: ['触发词丁'], content: 'B'.repeat(20), enabled: true },
  ]
  const r = selectWorldbookEntries(entries, '提到触发词丁', false)
  assert.ok(Array.isArray(r.picks), '缺 picks')
  assert.equal(r.picks.length, r.injectEntries.length, 'picks 与注入条目数不一致')
  assert.deepEqual(r.picks.map(p => p.name), r.injectEntries.map(e => e.comment || e.name))
  for (const p of r.picks) {
    assert.ok(['const', 'matched', 'stage', 'full'].includes(p.reason), '未知原因 ' + p.reason)
    assert.equal(typeof p.chars, 'number', 'chars 应为数字')
    assert.ok(!String(p).includes('AAAA') && p.chars <= 20, '★ picks 不得携带正文')
  }
})
