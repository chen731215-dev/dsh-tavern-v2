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

const { cleanSillyTavernVars, sanitizePromptText, randomPick, randomRoll, normalizeName, cleanName, estimatePromptBudget, migrateSessionStorageOutOfPresetRoot, DEFAULT_PRESET_YML, DEFAULT_PRESET_META, detectRefusal } = _test

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
