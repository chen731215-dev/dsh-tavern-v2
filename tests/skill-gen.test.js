/**
 * 「保存预设 → 自动生成 skill」+「选预设 → 会话自动绑定 skill」+「手动选 skill」的回归测试。
 *
 * 为什么这么设计（读 DSH 源码得到的约束，写死在这里防以后改坏）：
 *   · skill = `<name>/SKILL.md`，frontmatter 必填 `name` 与 `description`；
 *     `name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（dsh-skill 的 SKILL_NAME），**不合规会被整条丢弃**。
 *   · 扫描根由 dsh-skill-filesystem 提供，本插件写的是**用户级根** `<DSH_HOME>/skills`（rank 400，
 *     被 chokidar 监视 ⇒ 免重启）。
 *   · 绑定关系存在 presets.json 每条的 `skills: [...]`；提示词里只放"存在性指针"，
 *     **不重复注入 skill 正文**（否则烧 token 且和卡/世界书打架）。
 *
 * 运行：node --test tests/skill-gen.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-gen-'))
process.env.DSH_HOME = TMP_HOME

const PRESET_ROOT = path.join(TMP_HOME, '.agent-presets')
const SKILLS_ROOT = path.join(TMP_HOME, 'skills')
const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const {
  slugSkillName, skillNameForPreset, buildSkillMarkdown, writePresetSkill, deletePresetSkill,
  listSkillsOnDisk, parseSkillFrontmatter, presetSkillNames, setPresetSkillNames,
  buildSkillsHintText, syncPresetSkillAfterSave, SKILL_NAME_RE,
} = _test

// ── 夹具：造一个"有卡有世界书"的酒馆预设 ────────────────────────────
const CARD_YML = [
  '# 酒馆管理面板生成',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: |-',
  '      你是「阿离」，说话简短。',
  '',
].join('\n')

function makePreset(id, opts = {}) {
  const dir = path.join(PRESET_ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), opts.yml || CARD_YML, 'utf8')
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: "' + (opts.name || id) + '"\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(opts.characters || [
    { name: '阿离', desc: '酒馆的看板娘', enabled: true },
    { name: '沈砚', enabled: true },
  ]), 'utf8')
  fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify(opts.worldbooks || [
    { name: '苍玄界', enabled: true, entries: [
      { name: '地理', content: '东边是海。', enabled: true },
      { name: '禁术', content: '禁术会反噬。', enabled: true },
      { name: '废弃条目', content: '不该出现。', enabled: false },
    ] },
  ]), 'utf8')
  // ★ 预设模块是**两层结构**（包 → 内层条目），内层才是真正的写作要求。
  //   enabled=false 的是"选一"里的落选项，指令形态必须排除（否则互相矛盾的指令会一起进 skill）。
  fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify(opts.packs || [
    { name: '-Meowssiah-1.1', modules: [
      { name: '（别关）免责声明', content: '', enabled: true },
      { name: '📏<game>标签', content: '正文要用<game></game>标签包上', enabled: true },
      { name: '❤️nsfw风格|更舒缓', content: 'nsfw剧情要温柔！要温柔！不许有任何粗暴行为。', enabled: true },
      { name: '❤️nsfw风格|正常', content: '【这条没启用，不许出现在 skill 里】粗暴一点也行', enabled: false },
      { name: '📏小总结', content: '正文结束之后写一个100字左右的总结，用<summary></summary>包住。', enabled: true },
    ] },
  ]), 'utf8')
  // 注册表里登记（面板的其它功能都读它）
  const metaFile = path.join(PRESET_ROOT, 'presets.json')
  let meta = { presets: [] }
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
  if (!Array.isArray(meta.presets)) meta.presets = []
  if (!meta.presets.some((p) => p.id === id)) meta.presets.push({ id, dir: id, name: opts.name || id, mode: 'roleplay' })
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  return dir
}

// ════════════════════════════════════════════════════════════════
// ① skill 名字：必须合规（否则 DSH 整条丢弃）
// ════════════════════════════════════════════════════════════════
test('① skill 名字一律合规（DSH 的 SKILL_NAME：小写字母数字 + 单短横线）', () => {
  const ids = ['preset-fixture-a2', 'default', 'tavern-lite', '有中文的预设', 'UPPER Case', '  spaced  ', '--x--', '']
  for (const id of ids) {
    const n = skillNameForPreset(id)
    assert.ok(SKILL_NAME_RE.test(n), `预设 ${JSON.stringify(id)} → 生成的名字 ${JSON.stringify(n)} 不合规`)
    assert.ok(n.startsWith('tavern-'), '统一前缀 tavern-，避免和其它 skill 撞名')
  }
  assert.equal(skillNameForPreset('preset-fixture-a2'), 'tavern-preset-fixture-a2')
  assert.equal(skillNameForPreset('UPPER Case'), 'tavern-upper-case')
  // ★ 目录名本身叫 tavern-xxx 时不许叠成 tavern-tavern-xxx（默认预设就是这个目录名）
  assert.equal(skillNameForPreset('tavern-lite'), 'tavern-lite')
  assert.equal(skillNameForPreset('tavern'), 'tavern-preset')
  assert.equal(slugSkillName('a  b__c'), 'a-b-c')
})

test('①b 默认预设的两套 id（id=default / dir=tavern-lite）：绑定与描述都必须认', () => {
  // 真实形态：注册表条目 id='default'，dir='tavern-lite'；而面板传的是**目录名**。
  // 只按 id 查会绑定失败、描述退化成 id —— 这条专门守它。
  const metaFile = path.join(PRESET_ROOT, 'presets.json')
  let meta = { presets: [] }
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
  if (!Array.isArray(meta.presets)) meta.presets = []
  meta.presets.push({ id: 'default', dir: 'tavern-lite', name: '酒馆默认', mode: 'roleplay' })
  fs.mkdirSync(PRESET_ROOT, { recursive: true })
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  const dir = path.join(PRESET_ROOT, 'tavern-lite')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), CARD_YML, 'utf8')
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: "酒馆默认"\n', 'utf8')

  assert.equal(skillNameForPreset('tavern-lite'), 'tavern-lite')
  const r = setPresetSkillNames('tavern-lite', ['tavern-lite'])
  assert.equal(r.ok, true, '★ 用目录名绑定默认预设必须成功（否则面板点保存会 preset-not-found）')
  assert.deepEqual(presetSkillNames('tavern-lite'), ['tavern-lite'])
  assert.deepEqual(presetSkillNames('default'), ['tavern-lite'], '别名 id 也要读到同一份绑定')

  const md = buildSkillMarkdown('tavern-lite', {})
  assert.ok(md.includes('酒馆默认'), '★ 描述/标题要用注册表里的显示名，而不是目录名')
})

// ════════════════════════════════════════════════════════════════
// ② SKILL.md：frontmatter 合法 + 正文是"索引"而不是重复注入
// ════════════════════════════════════════════════════════════════
test('② SKILL.md 的 frontmatter 合法：name 合规、description 非空、whenToUse 有', () => {
  const id = 'preset-skill-a'
  makePreset(id, { name: '测试预设甲' })
  const md = buildSkillMarkdown(id, {})
  const fm = parseSkillFrontmatter(md)
  assert.equal(fm.name, skillNameForPreset(id), 'frontmatter 的 name 必须等于目录名')
  assert.ok(SKILL_NAME_RE.test(fm.name))
  assert.ok(fm.description && fm.description.length > 0, 'description 必填且非空')
  assert.ok(fm.description.length <= 200, 'description 别太长（会被截断显示）')
  assert.ok(fm.whenToUse && fm.whenToUse.length > 0, 'whenToUse 帮模型判断何时加载')
  // 单行标量：frontmatter 里绝不能有裸换行（会把 YAML 写坏）
  const fmBlock = md.slice(md.indexOf('---'), md.indexOf('\n---', 3))
  assert.equal(/[\r\n]/.test(fmBlock.split('\n').slice(1).join('\n').match(/^description: (.*)$/m)[1]), false,
    'description 里不许有换行')
})

test('③ 索引形态：列出角色/世界书/模块，且不把设定正文整段复制进来', () => {
  const id = 'preset-skill-a'
  const md = buildSkillMarkdown(id, { style: 'index' })
  assert.ok(md.includes('阿离'), '要列出角色名')
  assert.ok(md.includes('沈砚'))
  assert.ok(md.includes('苍玄界'), '要列出世界书')
  assert.ok(md.includes('地理') && md.includes('禁术'), '要列出启用中的条目名')
  assert.equal(md.includes('废弃条目'), false, '禁用的条目不该进索引')
  assert.equal(md.includes('东边是海。'), false, '★ 索引模式下不复制条目正文（省 token / 不重复设定）')
  assert.ok(md.includes('保存预设'), '要说明它由保存预设自动生成')
})

// ════════════════════════════════════════════════════════════════
// ③b 指令形态（默认）：DSH 的 skill 正文是**指令**（form: "instructions"），
//     用 /技能名 触发时宿主把它注入到这一步注入列表的**末尾**（最贴近回答）。
//     所以默认形态应当把"启用中的写作要求"原样送上，而不是给一份清单。
// ════════════════════════════════════════════════════════════════
test('③b 指令形态（默认）：把启用中的写作要求原样写进正文，排除未启用的', () => {
  const id = 'preset-skill-a'
  const md = buildSkillMarkdown(id, {})   // 不传 style = 默认 instructions
  assert.ok(md.includes('📏<game>标签') && md.includes('正文要用<game></game>标签包上'), '要带上写作要求原文')
  assert.ok(md.includes('nsfw剧情要温柔！要温柔！不许有任何粗暴行为。'), '★ nsfw 这类要求必须原样进正文')
  assert.ok(md.includes('小总结'), '每条要求都要在')
  assert.equal(md.includes('【这条没启用，不许出现在 skill 里】'), false, '★ 未启用的"选一"条目绝不能进指令')
  assert.equal(md.includes('（别关）免责声明'), false, '0 字的纯标记模块不该进正文')
  assert.ok(md.includes('写作指令'), '标题要说清这是指令')
  assert.ok(/指令/.test(md), '要明确"这是指令，按它写"')
  // ★ 指令形态里绝不能有"以别处为准"这种自我否定的话 —— 那会让模型不去照做
  assert.equal(/以 system prompt 注入的角色卡/.test(md), false, '★ 指令形态不许写"以提示词里的卡/世界书为准"')
  assert.ok(md.includes('阿离'), '角色也要带上（照此扮演）')
})

test('③c 指令形态的 description / whenToUse 与索引形态不同（目录里一眼能分辨）', () => {
  const id = 'preset-skill-a'
  const a = parseSkillFrontmatter(buildSkillMarkdown(id, { style: 'index' }))
  const b = parseSkillFrontmatter(buildSkillMarkdown(id, {}))
  assert.ok(a.description.includes('设定索引'), '索引形态：' + a.description)
  assert.ok(b.description.includes('写作指令'), '指令形态：' + b.description)
  assert.notEqual(a.whenToUse, b.whenToUse, '两者的 whenToUse 应各自贴合用途')
  assert.ok(/写正文/.test(b.whenToUse), '指令形态要说明"要写正文时用"：' + b.whenToUse)
  for (const fm of [a, b]) {
    assert.ok(SKILL_NAME_RE.test(fm.name), '两种形态的名字都要合规')
    assert.ok(String(fm.description).trim().length > 0)
    assert.equal(/[\r\n]/.test(String(fm.description)), false, 'description 不许有裸换行')
  }
})

test('④ includeFull=true 时把启用中的条目正文附在末尾（禁用的仍然不写）', () => {
  const id = 'preset-skill-a'
  const md = buildSkillMarkdown(id, { includeFull: true })
  assert.ok(md.includes('东边是海。'), '全文模式要带上正文')
  assert.ok(md.includes('## 附录'), '要有附录标题')
  assert.equal(md.includes('不该出现。'), false, '禁用的条目任何模式都不写')
})

// ════════════════════════════════════════════════════════════════
// ⑤ 写盘：位置正确、幂等、删除干净
// ════════════════════════════════════════════════════════════════
test('⑤ 写到 <DSH_HOME>/skills/<name>/SKILL.md，重复写幂等', () => {
  const id = 'preset-skill-a'
  // 先清干净：本测试要断言"第一次真写 / 第二次不写"，不能受前面测试留下的文件影响。
  fs.rmSync(path.join(SKILLS_ROOT, skillNameForPreset(id)), { recursive: true, force: true })
  const r1 = writePresetSkill(id, {})
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(path.dirname(r1.dir), SKILLS_ROOT, '★ 必须写 DSH 用户级 skill 根（被监视 ⇒ 免重启）')
  assert.equal(r1.name, skillNameForPreset(id))
  assert.ok(fs.existsSync(r1.file))
  assert.equal(r1.unchanged, false, '第一次是真写')
  const first = fs.readFileSync(r1.file, 'utf8')
  const mtime1 = fs.statSync(r1.file).mtimeMs
  const r2 = writePresetSkill(id, {})
  assert.equal(r2.ok, true)
  assert.equal(fs.readFileSync(r2.file, 'utf8'), first, '内容由预设决定 ⇒ 重复写应完全一致')
  assert.equal(r1.bytes, r2.bytes)
  // ★ 内容一致时**必须一个字节都不写**：DSH 有 chokidar 监视 <DSH_HOME>/skills，
  //   写一次盘 = 宿主重新加载一次技能清单（用户实测：点「生成/切形态」后聊天输入框会卡住点不动）。
  assert.equal(r2.unchanged, true, '★ 内容一致 ⇒ unchanged=true')
  assert.equal(fs.statSync(r2.file).mtimeMs, mtime1, '★ 没写盘 ⇒ mtime 一动不动（宿主收不到事件）')
})

test('⑥ 删除：目录没了、再加回来也不报错（幂等）', () => {
  const id = 'preset-skill-a'
  const dir = path.join(SKILLS_ROOT, skillNameForPreset(id))
  writePresetSkill(id, {})
  assert.ok(fs.existsSync(dir))
  assert.equal(deletePresetSkill(id).removed, true)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(deletePresetSkill(id).removed, false, '删不存在的目录不算错')
  writePresetSkill(id, {})
  assert.ok(fs.existsSync(dir), '还能再生成')
})

// ════════════════════════════════════════════════════════════════
// ⑦ 磁盘清单（手动选择用的数据源）
// ════════════════════════════════════════════════════════════════
test('⑦ listSkillsOnDisk：认目录式与扁平式，读得到 description，去重', () => {
  // 手写一个目录式 + 一个扁平式，模拟用户自带的 skill
  const d = path.join(SKILLS_ROOT, 'my-hand-made')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: my-hand-made\ndescription: "手写的技能"\nwhenToUse: "测试用"\n---\n\n正文\n', 'utf8')
  fs.writeFileSync(path.join(SKILLS_ROOT, 'flat-one.md'), '---\nname: flat-one\ndescription: "扁平技能"\n---\n\n正文\n', 'utf8')
  writePresetSkill('preset-skill-a', {})
  const list = listSkillsOnDisk()
  const names = list.map((s) => s.name)
  assert.ok(names.includes('my-hand-made'), '目录式要认：' + names.join(','))
  assert.ok(names.includes('flat-one'), '扁平式要认')
  assert.ok(names.includes(skillNameForPreset('preset-skill-a')), '我们生成的也要在清单里')
  assert.equal(new Set(names).size, names.length, '不许重复')
  assert.equal(list.find((s) => s.name === 'my-hand-made').description, '手写的技能')
})

// ════════════════════════════════════════════════════════════════
// ⑧ 绑定：自动加名字、手动可增删、非法名字被挡
// ════════════════════════════════════════════════════════════════
test('⑧ 绑定读写：生成时自动登记；手动绑定可加可删；非法名字被过滤', () => {
  const id = 'preset-skill-b'
  makePreset(id, { name: '测试预设乙' })
  assert.deepEqual(presetSkillNames(id), [], '一开始没有绑定')

  const gen = syncPresetSkillAfterSave(id, { skillAutoGenerate: true })
  assert.equal(gen.ok, true)
  assert.deepEqual(presetSkillNames(id), [skillNameForPreset(id)], '保存后自动登记自己生成的那个')

  const r = setPresetSkillNames(id, [skillNameForPreset(id), 'my-hand-made', 'bad name!', ''])
  assert.deepEqual(r.skills, [skillNameForPreset(id), 'my-hand-made'], '非法/空名字要被挡掉')
  assert.deepEqual(presetSkillNames(id), r.skills, '写盘后可读回')

  setPresetSkillNames(id, ['my-hand-made'])
  assert.deepEqual(presetSkillNames(id), ['my-hand-made'], '手动可以取消自动那个（用户有最终决定权）')
})

test('⑨ skillAutoGenerate=false ⇒ 保存时不生成（开关真的有效）', () => {
  const id = 'preset-skill-off'
  makePreset(id, { name: '关掉自动的预设' })
  const r = syncPresetSkillAfterSave(id, { skillAutoGenerate: false })
  assert.equal(r.skipped, true)
  assert.equal(fs.existsSync(path.join(SKILLS_ROOT, skillNameForPreset(id))), false, '不该有文件')
  assert.deepEqual(presetSkillNames(id), [], '也不该登记')
})

// ════════════════════════════════════════════════════════════════
// ⑨ 会话级提示：只在该会话绑定了 skill 时才给一行
// ════════════════════════════════════════════════════════════════
test('⑩ 会话提示：无绑定/关开关/无会话 都返回空；有绑定就点名', () => {
  const id = 'preset-skill-b'
  const sid = 'sid-skill-1'
  setPresetSkillNames(id, [])   // 显式清空：用例之间不共享状态（上一条用例给它绑过东西）
  assert.equal(buildSkillsHintText(sid, id, {}), '', '没绑定就不注入')
  assert.equal(buildSkillsHintText('', id, {}), '', '没有会话 id 不注入')
  assert.equal(buildSkillsHintText(sid, '', {}), '', '没有预设不注入')

  setPresetSkillNames(id, [skillNameForPreset(id), 'my-hand-made'])
  const on = buildSkillsHintText(sid, id, { skillHint: true })
  assert.ok(on.includes('【可用 skill】'), '要有标记段：' + on)
  assert.ok(on.includes(skillNameForPreset(id)) && on.includes('my-hand-made'), '两个都要点名')
  assert.equal(buildSkillsHintText(sid, id, { skillHint: false }), '', '★ 关掉开关必须一点都不注入')
})

test('⑭ 提示文案跟着"该预设有没有 skill 工具"走（真 bug 回归：别给模型它没有的工具名）', () => {
  const withTool = 'preset-skill-withtool'
  const withoutTool = 'preset-skill-notool'
  makePreset(withTool, {
    name: '挂了 skill 工具的预设',
    yml: CARD_YML + '- id: tool-skill\n' + "  name: '@deepseek-ai/dsh-tool-skill'\n",
  })
  makePreset(withoutTool, { name: '没挂 skill 工具的预设（酒馆预设的真实形态）' })
  setPresetSkillNames(withTool, [skillNameForPreset(withTool)])
  setPresetSkillNames(withoutTool, [skillNameForPreset(withoutTool)])

  const a = buildSkillsHintText('sid-a', withTool, {})
  assert.ok(/用 skill 工具加载/.test(a), '有工具时应该说"用 skill 工具加载"：' + a)
  assert.equal(a.includes('未挂 skill 工具'), false)

  const b = buildSkillsHintText('sid-b', withoutTool, {})
  // ★ 真实故障（用户实测反馈）：酒馆预设组合里没有 dsh-tool-skill，模型收到"用 skill 工具加载"
  //   却根本没有那个工具，于是回答"我这边没有 skill 加载工具，它就算存在我也没法加载"。
  assert.equal(/用 skill 工具加载/.test(b), false, '★ 没工具时绝不能说"用 skill 工具加载"：' + b)
  assert.ok(/未挂 skill 工具/.test(b), '要点明"本预设未挂 skill 工具"')
  assert.ok(b.includes('/' + skillNameForPreset(withoutTool)), '要给出用户侧调用：/技能名（宿主会直接注入正文）')
  assert.ok(b.includes(path.join(SKILLS_ROOT, skillNameForPreset(withoutTool), 'SKILL.md')), '要给可直接读的文件路径')
  assert.ok(b.includes('不要凭空编造设定'), '仍要禁止编造')
})

test('⑪ 提示里不重复注入 skill 正文（只给指针，避免烧两遍 token）', () => {
  const id = 'preset-skill-b'
  setPresetSkillNames(id, [skillNameForPreset(id)])
  const hint = buildSkillsHintText('sid-skill-2', id, {})
  // 世界书条目正文、角色卡正文都不该出现在提示里
  assert.equal(hint.includes('东边是海。'), false, '不许把世界书正文塞进提示')
  assert.equal(hint.includes('你是「阿离」'), false, '不许把卡正文塞进提示')
  assert.ok(hint.length < 400, '这一行应当很短，实际 ' + hint.length + ' 字')
})

// ════════════════════════════════════════════════════════════════
// ⑩ 端到端：面板路由真的能列表/生成/绑定/删除（真 apply + 真路由捕获）
// ════════════════════════════════════════════════════════════════
test('⑫ 真路由：GET 列表 → POST 生成 → POST 绑定 → POST 删除', async () => {
  const routes = []
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
  }
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, services))

  const id = 'preset-skill-route'
  makePreset(id, { name: '路由测试预设' })
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path === p.split('?')[0])
    if (!route) return reject(new Error('没注册路由：' + p))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: p, on(type, fn) { if (type === 'data' && chunks.length) fn(chunks[0]); if (type === 'end') fn(); return req } }
    const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(String(payload || '{}'))) } catch (e) { reject(e) } } }
    route.handler(req, res)
  })

  const before = await call('/api/tavern/skills?presetId=' + encodeURIComponent(id))
  assert.equal(before.ok, true)
  assert.equal(before.skillsRoot, SKILLS_ROOT, '面板要能显示真实写入位置')
  assert.equal(before.generated.exists, false, '还没生成')
  assert.ok(Array.isArray(before.available) && before.available.length > 0, '要能列出磁盘上的 skill')

  const gen = await call('/api/tavern/skills/generate', 'POST', { presetId: id })
  assert.equal(gen.ok, true, JSON.stringify(gen))
  assert.ok(gen.bound.includes(skillNameForPreset(id)))
  assert.ok(fs.existsSync(path.join(SKILLS_ROOT, skillNameForPreset(id), 'SKILL.md')))

  const bind = await call('/api/tavern/skills/bind', 'POST', { presetId: id, skills: ['my-hand-made'] })
  assert.equal(bind.ok, true)
  assert.deepEqual(bind.bound, ['my-hand-made'])
  const bad = await call('/api/tavern/skills/bind', 'POST', { presetId: id, skills: ['Bad Name'] })
  assert.equal(bad.ok, false, '非法名字必须被拒')
  assert.ok(String(bad.error).includes('invalid-skill-name'))

  const del = await call('/api/tavern/skills/delete', 'POST', { presetId: id })
  assert.equal(del.ok, true)
  assert.equal(del.removed, true)
  assert.equal(fs.existsSync(path.join(SKILLS_ROOT, skillNameForPreset(id))), false)
  // 删除只清"我们生成的那个名字"；手动勾选的别的 skill 不该被牵连（上一步刚绑了 my-hand-made）
  assert.deepEqual(del.bound, ['my-hand-made'], '手动绑定的名字要留着')
})

test('⑮ 工具探测路由：拿不到 ctx.tools 时如实报告 false（不假装成功）', async () => {
  const routes = []
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
    // 故意不提供 tools —— 模拟"dsh-tools 不在 profile 层"
  }
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, services))
  const out = await callRoute(routes, '/api/tavern/tool-probe')
  assert.equal(out.ok, true)
  assert.equal(out.hasToolsService, false, '★ 拿不到就必须如实说 false（决定下一步走哪条路）')
  assert.equal(out.registeredProbe, false)
})

test('⑯ 工具探测路由是**只读**的：报能力、不注册（连点不产生宿主副作用）', async () => {
  const routes = []
  const registered = []
  const disposed = []
  const fakeTools = {
    register: (def) => { registered.push(def.name); return () => { disposed.push(def.name) } },
    list: () => [{ name: 'pwsh' }, { name: 'web' }],
  }
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
    tools: fakeTools,
  }
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, services))
  // 连问三次，模拟用户连点「🎓 技能」的按钮（loadSkills() 里挂着这条探测）
  const out = await callRoute(routes, '/api/tavern/tool-probe')
  await callRoute(routes, '/api/tavern/tool-probe')
  await callRoute(routes, '/api/tavern/tool-probe')

  // 该证明的"能力"一样都不少：
  assert.equal(out.hasToolsService, true, '要能发现宿主 tools 服务')
  assert.equal(out.hasRegister, true, '要能报告"具备 register() 能力"（下一步做查询工具的依据）')
  assert.equal(out.canRegister, true)
  assert.deepEqual(out.sampleTools, ['pwsh', 'web'], '要能列出已有工具名，确认这确实是工具注册表')

  // 但**绝不允许留下副作用**：旧写法会真的注册一个探针工具再 dispose，而这条接口是被
  // 「生成/刷新/删除/切形态」四个按钮按刷新频率调用的（用户实测：点完输入框会卡住点不动）。
  assert.equal(out.registerSkipped, true, '要明确声明自己跳过了注册')
  assert.equal(out.registeredProbe, false, '不能再报"已注册探针"')
  assert.deepEqual(registered, [], '★ 一次都不能注册（连问三次也一样）')
  assert.deepEqual(disposed, [], '★ 没注册就没有回收动作')
})

test('⑯b 宿主没有 tools 服务时：如实报 false，且不炸', async () => {
  const routes = []
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
  }
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, services))
  const out = await callRoute(routes, '/api/tavern/tool-probe')
  assert.equal(out.ok, true)
  assert.equal(out.hasToolsService, false)
  assert.equal(out.canRegister, false)
  assert.equal(out.registerSkipped, false, '连服务都没有，谈不上"跳过注册"')
  assert.equal(out.registeredProbe, false)
})

/** 起一个假 ctx 并调用某条路由（探测类路由共用）。 */
function callRoute(routes, path) {
  return new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path === path)
    if (!route) return reject(new Error('没注册路由：' + path))
    const req = { method: 'GET', url: path, on(type, fn) { if (type === 'end') fn(); return req } }
    const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(String(payload || '{}'))) } catch (e) { reject(e) } } }
    route.handler(req, res)
  })
}

test('⑫b 真路由：形态可切（instructions 默认 / index 可选），生成的文件形状跟着变', async () => {
  const routes = []
  const services = {
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: () => () => {} },
    sessions: { get: () => undefined },
  }
  const { apply } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
  apply(Object.assign({
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }, services))
  const id = 'preset-skill-style'
  makePreset(id, { name: '形态测试预设' })
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path === p.split('?')[0])
    if (!route) return reject(new Error('没注册路由：' + p))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: p, on(type, fn) { if (type === 'data' && chunks.length) fn(chunks[0]); if (type === 'end') fn(); return req } }
    const res = { writeHead() {}, end(payload) { try { resolve(JSON.parse(String(payload || '{}'))) } catch (e) { reject(e) } } }
    route.handler(req, res)
  })
  const file = path.join(SKILLS_ROOT, skillNameForPreset(id), 'SKILL.md')

  // 默认（未指定）应当是指令形态
  const g1 = await call('/api/tavern/skills/generate', 'POST', { presetId: id })
  assert.equal(g1.style, 'instructions', '不指定形态时应当是指令形态')
  let body = fs.readFileSync(file, 'utf8')
  assert.ok(body.includes('正文要用<game></game>标签包上'), '★ 指令形态要带写作要求原文')

  const s1 = await call('/api/tavern/skills?presetId=' + encodeURIComponent(id))
  assert.equal(s1.style, 'instructions', 'GET 要回报当前形态，供面板显示')

  // 切成索引形态
  const g2 = await call('/api/tavern/skills/generate', 'POST', { presetId: id, style: 'index' })
  assert.equal(g2.style, 'index')
  body = fs.readFileSync(file, 'utf8')
  assert.ok(body.includes('设定索引'), '索引形态标题要对')
  assert.equal(body.includes('正文要用<game></game>标签包上'), false, '★ 索引形态不该把写作要求正文抄进去')

  // 非法形态一律回落到默认（指令），不许写坏文件
  const g3 = await call('/api/tavern/skills/generate', 'POST', { presetId: id, style: 'bogus' })
  assert.equal(g3.style, 'instructions', '非法值要回落到默认形态')
})

test('⑬ 环境清理：临时 DSH_HOME 不在真实目录里', () => {
  assert.notEqual(TMP_HOME, os.homedir())
  assert.ok(TMP_HOME.startsWith(os.tmpdir()))
})
