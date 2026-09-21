import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchWorldbookEntries, buildWorldbookText, extractCardText, contentToText } from '../lib/utils.js'

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
import { _test } from '../lib/index.js'

const { cleanSillyTavernVars, sanitizePromptText, randomPick, randomRoll, normalizeName, cleanName, estimatePromptBudget, migrateSessionStorageOutOfPresetRoot, DEFAULT_PRESET_YML, DEFAULT_PRESET_META, detectRefusal, pickAuthoritativePreset, pickAuthoritativePresetFromLog, classifySessionPresetLines, extractAgentPresetFromLine, sessionIdKeys, sessionDirMatches } = _test

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
  assert.equal(cleanSillyTavernVars('{{user}}和{{char}}'), '和')
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

test('pickAuthoritativePresetFromLog: 出生默认值不得推翻面板绑定（本次修复的要害）', () => {
  // 场景 = 线上 session-fb2f7f9f…：创建记录 standard、无显式切换、面板绑了足控天堂
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'standard', isTavern, 'preset-mtyx98fa-pdsrh1'),
    'preset-mtyx98fa-pdsrh1'
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

test('pickAuthoritativePresetFromLog: 无显式切换、无绑定 → 退回出生默认值', () => {
  assert.equal(pickAuthoritativePresetFromLog(null, 'preset-mtyx98fa-pdsrh1', isTavern, ''), 'preset-mtyx98fa-pdsrh1')
})

test('pickAuthoritativePresetFromLog: 无显式切换、无绑定、出生默认是内置预设 → default', () => {
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, ''), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, null, isTavern, ''), 'default')
  assert.equal(pickAuthoritativePresetFromLog(null, 'standard', isTavern, 'standard'), 'default')
})

test('pickAuthoritativePresetFromLog: 绑定优先于出生默认值', () => {
  // 会话出生在某张酒馆卡上，之后用户在面板改选另一张 → 听面板的
  assert.equal(
    pickAuthoritativePresetFromLog(null, 'tavern-lite', isTavern, 'preset-mtyx98fa-pdsrh1'),
    'preset-mtyx98fa-pdsrh1'
  )
})
