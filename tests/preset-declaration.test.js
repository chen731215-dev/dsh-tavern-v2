/**
 * 「把酒馆预设声明成 DSH 原生 agent 预设」的渲染与受管块拼接（纯函数回归测试）
 *
 * 背景（2026-09-27 查证）：
 *   DSH 本版**不再读** `$DSH_HOME/.agent-presets/<id>/` 这种旧目录预设
 *   （`dsh-agent-preset/.../editing-cordis-compositions/SKILL.md:71` 原文：
 *    "Nothing reads that directory any more."；全 asar 的 @deepseek-ai 代码里
 *    `.agent-presets` 只剩这一处文档）。真正的预设是**声明行**，出厂四个标准预设就是
 *   `dsh-web-app/presets/*.patch.yml` 里 `- insert: [{id: preset-<id>,
 *   name: '@deepseek-ai/dsh-agent-preset', config: {id, name, order, plugins}}]` 这么写的。
 *   ⇒ 酒馆不声明，它的预设就不在顶部选择器里，也就谈不上「会话选择了这个酒馆预设」。
 *
 * 本文件只测**渲染**（不碰任何配置文件）。写盘是显式接口的事，且必须先 dry-run。
 *
 * 运行：node --test tests/preset-declaration.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preset-decl-'))
process.env.DSH_HOME = TMP_HOME

const ROOT = path.join(TMP_HOME, '.agent-presets')
const COMPOSITION = [
  '# 酒馆管理面板生成',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: |-',
  '      你是角色扮演助手。',
  '    includeRuntimeContext: false',
  '',
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  '',
].join('\n')

function writeTavernPreset(id, { name, description, order, yml = COMPOSITION } = {}) {
  const dir = path.join(ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), yml, 'utf8')
  fs.writeFileSync(path.join(dir, 'preset.yml'), [
    `name: "${name || id}"`,
    `description: "${description || ''}"`,
    ...(order === undefined ? [] : [`order: ${order}`]),
    '',
  ].join('\n'), 'utf8')
}

writeTavernPreset('tavern-lite', { name: '酒馆默认' })
writeTavernPreset('preset-role', { name: '角色扮演', description: '带世界书的卡', order: 7 })
fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({
  presets: [
    { id: 'default', name: '酒馆默认', dir: 'tavern-lite', mode: 'roleplay' },
    { id: 'preset-role', name: '角色扮演', dir: 'preset-role', mode: 'roleplay' },
    { id: 'preset-empty', name: '空预设', dir: 'preset-empty', mode: 'roleplay' },
  ],
}, null, 2), 'utf8')

const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const {
  PRESET_DECL_BEGIN,
  PRESET_DECL_END,
  yamlDoubleQuote,
  indentYamlBlock,
  BLANK_PRESET_SKELETON,
  isBlankPresetComposition,
  presetDisplayNameFor,
  renderPresetDeclaration,
  renderAllPresetDeclarations,
  composePresetDeclarationBlock,
  mergeManagedPresetBlock,
  listTavernPresetIds,
  findProfileDir,
  outsideManagedBlock,
  stripManagedPresetBlock,
  validatePresetPatchText,
  applyPresetDeclarations,
  renderPresetBundleFiles,
  writePresetBundle,
  readDeclarationMode,
  writeDeclarationMode,
  syncDeclarationsBestEffort,
} = _test

// ── 1. 标量转义与缩进（YAML 撕开 = DSH 起不来）──────────────
test('[1] yamlDoubleQuote：引号/反斜杠/换行都被安全吞掉（描述是外部文本）', () => {
  assert.equal(yamlDoubleQuote('普通文本'), '"普通文本"')
  assert.equal(yamlDoubleQuote('he said "hi"'), '"he said \\"hi\\""')
  assert.equal(yamlDoubleQuote('C:\\path'), '"C:\\\\path"')
  assert.equal(yamlDoubleQuote('a\nb'), '"a b"', '换行折成空格（YAML 标量里不许出现裸换行）')
})

test('[2] indentYamlBlock：整体缩进、空行保持空行、尾随空行丢掉', () => {
  const out = indentYamlBlock('- a\n\n- b\n\n\n', 4)
  assert.equal(out, '    - a\n\n    - b')
})

// ── 2. 声明行渲染 ──────────────────────────────────────────
test('[3] renderPresetDeclaration：渲染成 DSH 的 declaration row（含 insert / 行 id / 组合列表）', () => {
  const d = renderPresetDeclaration('preset-role')
  assert.equal(d.ok, true)
  assert.equal(d.id, 'preset-role')
  assert.equal(d.rowId, 'preset-preset-role', 'Loader 行 id 约定是 preset-<id>')
  const lines = d.yaml.split('\n')
  assert.equal(lines[0], '- insert:')
  assert.ok(lines.some(l => l === '    - id: preset-preset-role'))
  assert.ok(lines.some(l => l === "      name: '@deepseek-ai/dsh-agent-preset'"), '必须挂到 DSH 的预设插件上')
  assert.ok(lines.some(l => l === '        id: preset-role'), 'config.id 就是选中的预设 id')
  assert.ok(lines.some(l => l === '        name: "角色扮演"'))
  assert.ok(lines.some(l => l === '        description: "带世界书的卡"'))
  assert.ok(lines.some(l => l === '        order: 7'), 'preset.yml 的 order 要带上')
  assert.ok(lines.some(l => l === '        plugins:'), '组合列表必须叫 plugins')
  // agent.cordis.yml 原样成为 plugins（整体再缩进 10 空格）
  assert.ok(d.yaml.includes('\n          - id: persona'), '组合条目要缩进到 plugins 之下')
  assert.ok(d.yaml.includes("\n            name: '@deepseek-ai/dsh-persona'"))
  assert.ok(d.yaml.includes('\n          - id: tool-pwsh'), '多条目全部保留（不许只取第一条）')
})

test('[4] renderPresetDeclaration：声明的 id 用**目录名**（default → tavern-lite），避开与 DSH 默认预设同名词碰撞', () => {
  const d = renderPresetDeclaration('default')
  assert.equal(d.ok, true)
  assert.equal(d.id, 'default', '酒馆侧 id 仍是 default（面板/绑定用它）')
  assert.equal(d.agentId, 'tavern-lite', 'DSH 侧 id 是目录名（agentPresets.select 要的就是它）')
  assert.equal(d.rowId, 'preset-tavern-lite')
  assert.ok(d.yaml.includes('\n        id: tavern-lite'), 'config.id 必须是目录名')
  assert.ok(!d.yaml.includes('\n        id: default'), '绝不许声明出一个名叫 default 的预设')
  assert.ok(d.yaml.includes('\n          - id: persona'), '组合来自 tavern-lite 目录')
})

test('[5] renderPresetDeclaration：目录不存在 / 组合为空 ⇒ 明确报错，不产出半截声明', () => {
  assert.equal(renderPresetDeclaration('nope').ok, false)
  assert.match(renderPresetDeclaration('nope').error, /preset-not-found/)
  assert.equal(renderPresetDeclaration('').ok, false)
  writeTavernPreset('preset-empty', { yml: '\n\n' })
  const e = renderPresetDeclaration('preset-empty')
  assert.equal(e.ok, false)
  assert.match(e.error, /empty-composition/)
})

test('[6] renderAllPresetDeclarations：逐个渲染，坏的只影响它自己', () => {
  const all = renderAllPresetDeclarations()
  const okIds = all.filter(d => d.ok).map(d => d.id).sort()
  assert.deepEqual(okIds, ['default', 'preset-role'], '能渲染的都在（坏的不连坐）')
  const bad = all.find(d => !d.ok)
  assert.ok(bad && bad.id === 'preset-empty' && bad.error, '坏预设如实报错')
})

test('[7] listTavernPresetIds：注册表 id + 兜底的 default，去重', () => {
  assert.deepEqual(listTavernPresetIds(), ['default', 'preset-role', 'preset-empty'])
})

// ── 3. 受管块：只动自己那一块 ───────────────────────────────
test('[8] composePresetDeclarationBlock：带界标、统计成功数、坏预设记进 failed', () => {
  const decls = renderAllPresetDeclarations()
  const block = composePresetDeclarationBlock(decls, { timestamp: '2026-09-27T00:00:00.000Z' })
  assert.ok(block.text.startsWith(PRESET_DECL_BEGIN))
  assert.ok(block.text.endsWith(PRESET_DECL_END))
  assert.ok(block.text.includes('2026-09-27T00:00:00.000Z'))
  assert.equal(block.ok, 2)
  assert.equal(block.failed.length, 1)
  assert.equal(block.failed[0].id, 'preset-empty')
})

test('[9] mergeManagedPresetBlock：追加时不动既有内容（用户手写的 providers 一个字节都不许丢）', () => {
  const user = 'model: deepseek-chat\nllm-pi-ai:\n  providers:\n    gcc:\n      apiKey: sk-secret\n'
  const block = composePresetDeclarationBlock(renderAllPresetDeclarations())
  const merged = mergeManagedPresetBlock(user, block.text)
  assert.equal(merged.replaced, false)
  assert.ok(merged.text.startsWith(user), '原有内容必须原样在最前')
  assert.ok(merged.text.includes('sk-secret'), '★ 用户的密钥/配置绝不能被吃掉')
  assert.ok(merged.text.includes(PRESET_DECL_BEGIN) && merged.text.includes(PRESET_DECL_END))
})

test('[10] mergeManagedPresetBlock：已有受管块 ⇒ 整块替换且**幂等**（重复生成不堆积）', () => {
  const user = 'model: deepseek-chat\n'
  const b1 = composePresetDeclarationBlock(renderAllPresetDeclarations(), { timestamp: 't1' })
  const b2 = composePresetDeclarationBlock(renderAllPresetDeclarations(), { timestamp: 't2' })
  const once = mergeManagedPresetBlock(user, b1.text)
  const twice = mergeManagedPresetBlock(once.text, b2.text)
  assert.equal(twice.replaced, true)
  assert.equal(twice.text, mergeManagedPresetBlock(user, b2.text).text)
  assert.equal((twice.text.match(new RegExp(PRESET_DECL_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '界标只许出现一次')
  assert.ok(twice.text.startsWith(user), '块外的用户内容保持不动')
  assert.ok(!twice.text.includes('t1') && twice.text.includes('t2'), '旧块被整块换掉')
})

test('[11] mergeManagedPresetBlock：界标残缺（只有开始没有结束）⇒ 不猜、不删，走追加', () => {
  const broken = PRESET_DECL_BEGIN + '\n- 半截内容\n'
  const block = composePresetDeclarationBlock([{ ok: true, yaml: '- insert: []' }], { timestamp: 't' })
  const out = mergeManagedPresetBlock(broken, block.text)
  assert.equal(out.replaced, false, '界标不成对时绝不按块替换（怕把用户内容一起删掉）')
  assert.ok(out.text.includes('- 半截内容'), '原内容保留，交给人来判断')
})

test('[11b] mergeManagedPresetBlock：未注释的空数组占位符 `[]` 必须被注释掉（直接追加 = 不是顶层数组 = DSH 拒绝启动）', () => {
  const block = composePresetDeclarationBlock([{ ok: true, yaml: "- insert:\n    - id: x" }], { timestamp: 't' })
  const fresh = mergeManagedPresetBlock('[]\n', block.text)
  assert.equal(fresh.placeholderCommented, true)
  assert.ok(!/^[ \t]*\[[ \t]*\][ \t]*$/m.test(fresh.text), '★ 不许留一个裸的顶层 `[]`')
  assert.ok(fresh.text.includes('# []'), '按 dshmarket 同款做法注释掉')
  assert.ok(fresh.text.includes('- id: x'), '我们的声明在文件里')
  assert.equal(fresh.text.trimEnd().split('\n').pop(), PRESET_DECL_END, '我们的块收在文件末尾（顶层数组）')

  const withComments = mergeManagedPresetBlock('# my patch layer\n[]\n', block.text)
  assert.equal(withComments.placeholderCommented, true)
  assert.ok(withComments.text.startsWith('# my patch layer\n# []'), '注释保留、占位符被注释')

  // 已经有真实条目的文件：绝不改内容，只能追加
  const real = mergeManagedPresetBlock('- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n', block.text)
  assert.equal(real.placeholderCommented, undefined)
  assert.ok(real.text.startsWith('- id: llm-pi-ai'), '既有条目原样在前')
})

test('[11c] 注释掉的占位符 `# []` 不当作占位符（它本来就是注释），走正常追加', () => {
  const block = composePresetDeclarationBlock([{ ok: true, yaml: "- insert:\n    - id: x" }], { timestamp: 't' })
  const out = mergeManagedPresetBlock('# []\n- id: llm-pi-ai\n', block.text)
  assert.equal(out.placeholderReplaced, undefined)
  assert.ok(out.text.startsWith('# []\n- id: llm-pi-ai'), '原样保留')
})

// ── 4. 写盘保护（strip / validate / apply）──────────────────
test('[12] stripManagedPresetBlock：整块摘掉（含界标），块外的用户内容一字不差', () => {
  const user = 'model: deepseek-chat\nllm-pi-ai:\n  apiKey: sk-secret\n'
  const block = composePresetDeclarationBlock([{ ok: true, yaml: '- insert: []' }], { timestamp: 't' })
  const withBlock = mergeManagedPresetBlock(user, block.text).text
  const stripped = stripManagedPresetBlock(withBlock)
  assert.ok(!stripped.includes(PRESET_DECL_BEGIN) && !stripped.includes(PRESET_DECL_END), '界标也要走')
  assert.ok(stripped.includes('sk-secret'), '用户的密钥不能被顺走')
  assert.equal(stripped.trimEnd(), user.trimEnd(), '回到原样')
})

test('[13] validatePresetPatchText：缺少界标 / 制表符 / 没有插入条目 都要拦住（写坏 = DSH 起不来）', () => {
  const good = ['# user', PRESET_DECL_BEGIN, '- insert:', "    - id: x", "      name: '@deepseek-ai/dsh-agent-preset'", PRESET_DECL_END, ''].join('\n')
  assert.deepEqual(validatePresetPatchText(good), [])
  assert.ok(validatePresetPatchText('').includes('empty-file：文件为空'))
  assert.ok(validatePresetPatchText('- insert: []\n').some(p => p.startsWith('marker-begin-count')))
  assert.ok(validatePresetPatchText(good.replace('    - id: x', '\t- id: x')).some(p => p.startsWith('tab-character')), 'YAML 不许 tab 缩进')
  assert.ok(validatePresetPatchText([PRESET_DECL_BEGIN, '- something: else', PRESET_DECL_END].join('\n')).some(p => p.startsWith('block-no-insert')))
})

// 假 profile：只碰临时目录，绝不碰真机的 ~/.dsh
const PROFILE_DIR = path.join(TMP_HOME, 'profiles', 'fake')
fs.mkdirSync(PROFILE_DIR, { recursive: true })
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')
const USER_PATCH = [
  '# Your patch layer for this dsh profile',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      gcc:',
  '        apiKeyEnv: GCC_API_KEY',
  '',
].join('\n')
fs.writeFileSync(PATCH_FILE, USER_PATCH, 'utf8')

test('[14] applyPresetDeclarations：**默认 dry-run** —— 一个字节都不写，只给计划', () => {
  const r = applyPresetDeclarations({ profileDir: PROFILE_DIR, timestamp: 'dry' })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.wrote, false)
  assert.equal(r.target, PATCH_FILE)
  assert.ok(r.bytesAfter > r.bytesBefore)
  assert.equal(fs.readFileSync(PATCH_FILE, 'utf8'), USER_PATCH, '★ 文件必须原封不动')
})

test('[15] applyPresetDeclarations：dryRun:false 但没 confirm ⇒ 400 confirm-required，仍然不写', () => {
  const r = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'confirm-required：写盘必须显式 confirm:true')
  assert.equal(fs.readFileSync(PATCH_FILE, 'utf8'), USER_PATCH, '★ 拒绝时也不许写')
})

test('[16] applyPresetDeclarations：apply+confirm ⇒ 写入；备份落到 tavern-data/backups；用户内容原样保留；幂等', () => {
  const r = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false, confirm: true, timestamp: 't1' })
  assert.equal(r.ok, true)
  assert.equal(r.wrote, true)
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), '必须先备份（且不放在 profile 目录里）')
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), USER_PATCH, '备份内容 = 写入前原文')

  const after = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.ok(after.startsWith(USER_PATCH.trimEnd()), '★ 用户的 patch 层内容必须原样在前')
  assert.ok(after.includes('sk-secret') === false && after.includes('GCC_API_KEY'), '用户配置没被吃掉')
  assert.ok(after.includes(PRESET_DECL_BEGIN) && after.includes('id: tavern-lite') && after.includes('id: preset-role'))

  // 再跑一次：内容没变（只差时间戳那一行）⇒ **不写盘、不备份**，界标仍只一份。
  // 为什么这么断言：保存预设几乎每次都调用本函数，若每次都写盘，
  // backups/ 会被刷成几百个 .bak，patch 文件 mtime 一直跳还会带着 DSH 反复重载 profile。
  const backupDir = path.join(TMP_HOME, 'tavern-data', 'backups')
  const backupsBefore = fs.readdirSync(backupDir).length
  const again = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false, confirm: true, timestamp: 't2' })
  assert.equal(again.ok, true)
  assert.equal(again.unchanged, true, '只有生成时间不同 ⇒ 判定为「没变」')
  assert.equal(again.wrote, false, '没变就不写盘')
  const after2 = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.equal((after2.match(new RegExp(PRESET_DECL_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '界标只许一份')
  assert.equal(after2, after, '文件逐字节不变（连生成时间都不动）')
  assert.equal(fs.readdirSync(backupDir).length, backupsBefore, '没写盘就不该多出备份')
})

test('[17] applyPresetDeclarations：remove+confirm ⇒ 摘掉受管块、恢复原样（可回滚）', () => {
  const r = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false, confirm: true, remove: true, timestamp: 't3' })
  assert.equal(r.ok, true)
  assert.equal(r.wrote, true)
  assert.equal(fs.readFileSync(PATCH_FILE, 'utf8').trimEnd(), USER_PATCH.trimEnd(), '回到用户原文')
})

test('[18] applyPresetDeclarations：不传 profileDir ⇒ 自动定位到 DSH_HOME/profiles 之下（绝不写硬编码路径）', () => {
  const r = applyPresetDeclarations({ dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.wrote, false)
  assert.ok(
    r.target.startsWith(path.join(TMP_HOME, 'profiles') + path.sep),
    '目标必须落在 DSH_HOME/profiles 之下，实际：' + r.target,
  )
})

test('[19] findProfileDir：认 bundles 里列了 dsh-tavern 的那个 profile', () => {
  fs.mkdirSync(path.join(TMP_HOME, 'profiles', 'other'), { recursive: true })
  fs.writeFileSync(path.join(TMP_HOME, 'profiles', 'other', 'cordis.patch.yml'), '- id: x\n', 'utf8')
  fs.writeFileSync(path.join(TMP_HOME, 'profiles', 'other', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }), 'utf8')
  fs.writeFileSync(path.join(PROFILE_DIR, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-tavern'] } } }), 'utf8')
  assert.equal(findProfileDir(), PROFILE_DIR, '优先选装了 dsh-tavern 的那个')
})

test('[20] 非法 id 拒绝渲染（DSH 的预设 id 只允许小写字母/数字/连字符）', () => {
  writeTavernPreset('Bad_ID', {})
  const d = renderPresetDeclaration('Bad_ID')
  assert.equal(d.ok, false)
  assert.match(d.error, /invalid-id/)
})

// ── 5. 路线 B：生成 DSH bundle（交 plugin_manager 安装）────────
test('[21] renderPresetBundleFiles：两份文件的形状要对（package.json 指向 cordis.patch.yml，补丁里是声明行）', () => {
  const b = renderPresetBundleFiles(['default', 'preset-role'])
  assert.equal(b.ok, true)
  const pkg = JSON.parse(b.packageJson)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'DSH 靠这个字段找 bundle 的补丁')
  assert.equal(pkg.private, true)
  assert.ok(pkg.name.startsWith('@local/'), '按 DSH 技能文档的写法放 @local 下')
  assert.ok(b.patchYaml.includes('id: preset-tavern-lite'), 'default → 目录名 tavern-lite')
  assert.ok(b.patchYaml.includes('id: preset-preset-role'))
  assert.ok(b.patchYaml.includes("name: '@deepseek-ai/dsh-agent-preset'"))
  assert.deepEqual(b.declaredIds, ['tavern-lite', 'preset-role'])
  assert.equal(b.failed.length, 0)
  assert.ok(b.bundleDir.includes('tavern-data'), 'bundle 落在酒馆自己的数据目录里（不进 profile/workspace）')
})

test('[22] renderPresetBundleFiles：坏预设不连坐，全坏则明确拒绝', () => {
  const partial = renderPresetBundleFiles(['default', 'preset-empty'])
  assert.equal(partial.ok, true)
  assert.deepEqual(partial.declaredIds, ['tavern-lite'])
  assert.equal(partial.failed.length, 1)
  assert.equal(partial.failed[0].id, 'preset-empty')
  assert.equal(renderPresetBundleFiles(['preset-empty']).ok, false)
})

test('[23] writePresetBundle：默认 dry-run 不写盘；confirm 后才落两份文件，且内容与渲染一致', () => {
  const dry = writePresetBundle({})
  assert.equal(dry.dryRun, true)
  assert.equal(dry.wrote, false)
  assert.ok(!fs.existsSync(dry.bundleDir), 'dry-run 阶段目录都不该建')
  assert.ok(dry.installHint.includes('install_bundle') && dry.installHint.includes(dry.bundleDir), '给出官方安装方式')

  assert.equal(writePresetBundle({ dryRun: false }).error, 'confirm-required：写盘必须显式 confirm:true')
  assert.ok(!fs.existsSync(dry.bundleDir), '缺 confirm 也不许写')

  const real = writePresetBundle({ dryRun: false, confirm: true })
  assert.equal(real.ok, true)
  assert.equal(real.wrote, true)
  assert.ok(real.bundleDir.startsWith(path.join(TMP_HOME, 'tavern-data')), '只写 DSH_HOME/tavern-data')
  const rendered = renderPresetBundleFiles()
  assert.equal(fs.readFileSync(path.join(real.bundleDir, 'cordis.patch.yml'), 'utf8'), rendered.patchYaml)
  assert.equal(fs.readFileSync(path.join(real.bundleDir, 'package.json'), 'utf8'), rendered.packageJson)
})

// ── 6. 声明开关与生命周期（增删改之后名册不能变旧）──────────
test('[24] readDeclarationMode / writeDeclarationMode：出厂 off；只认 patch / bundle，其余归 off', () => {
  assert.equal(readDeclarationMode(), 'off', '★ 出厂姿态：一个字节都不碰用户配置')
  assert.equal(writeDeclarationMode('patch').mode, 'patch')
  assert.equal(readDeclarationMode(), 'patch')
  assert.equal(writeDeclarationMode('bundle').mode, 'bundle')
  assert.equal(readDeclarationMode(), 'bundle')
  assert.equal(writeDeclarationMode('随便什么').mode, 'off', '非法值归 off（保守）')
  assert.equal(readDeclarationMode(), 'off')
})

test('[25] syncDeclarationsBestEffort：off = 什么都不做；patch = 维护补丁层；bundle = 生成 bundle', () => {
  // 让 findProfileDir 一定选到我们的假 profile
  fs.writeFileSync(path.join(PROFILE_DIR, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-tavern'] } } }), 'utf8')
  fs.writeFileSync(PATCH_FILE, USER_PATCH, 'utf8')

  writeDeclarationMode('off')
  const before = fs.readFileSync(PATCH_FILE, 'utf8')
  const skipped = syncDeclarationsBestEffort('manual')
  assert.equal(skipped.skipped, 'off')
  assert.equal(fs.readFileSync(PATCH_FILE, 'utf8'), before, '★ off 模式下声明同步绝不写文件')

  writeDeclarationMode('patch')
  const p = syncDeclarationsBestEffort('create')
  assert.equal(p.ok, true)
  assert.equal(p.mode, 'patch')
  const after = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.ok(after.includes(PRESET_DECL_BEGIN), 'patch 模式：受管块写进去了')
  assert.ok(after.startsWith(USER_PATCH.trimEnd()), '用户内容依旧原样在前')

  writeDeclarationMode('bundle')
  const b = syncDeclarationsBestEffort('create')
  assert.equal(b.ok, true)
  assert.equal(b.mode, 'bundle')
  assert.ok(fs.existsSync(path.join(TMP_HOME, 'tavern-data', 'preset-bundle', 'cordis.patch.yml')), 'bundle 模式：生成 bundle 文件')
})

test('[26] 生命周期：删掉预设后重新同步，声明行随之消失（名册里不留指向已删目录的坏卡）', () => {
  fs.writeFileSync(PATCH_FILE, USER_PATCH, 'utf8')
  writeDeclarationMode('patch')

  // 先声明两个预设
  let r = syncDeclarationsBestEffort('create')
  assert.equal(r.ok, true)
  let text = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.ok(text.includes('id: preset-preset-role') && text.includes('id: preset-tavern-lite'))

  // 用户删掉 preset-role（模拟 deletePreset：注册表里没了它）
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets.json'), 'utf8'))
  const kept = meta.presets.filter(p => p.id !== 'preset-role')
  fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({ presets: kept }, null, 2), 'utf8')

  // 再同步：受管块整块重渲染 ⇒ 那一行必须消失
  r = syncDeclarationsBestEffort('delete')
  assert.equal(r.ok, true)
  text = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.ok(!text.includes('preset-role'), '★ 已删预设不许在名册里留一张坏卡')
  assert.ok(text.includes('id: preset-tavern-lite'), '其它预设不受影响')
  assert.equal((text.match(new RegExp(PRESET_DECL_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '界标仍只有一份')

  // 复原，别影响后面的用例
  meta.presets.push({ id: 'preset-role', name: '角色扮演', dir: 'preset-role', mode: 'roleplay' })
  fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify(meta, null, 2), 'utf8')
  writeDeclarationMode('off')
})

test('[27] syncDeclarationsBestEffort：bundle 模式写完要带回 needsInstall（否则用户以为名册已更新）', () => {
  writeDeclarationMode('bundle')
  try {
    const r = syncDeclarationsBestEffort('create')
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'bundle')
    assert.equal(r.needsInstall, true, '★ 文件更新 ≠ DSH 名册更新：还要重新 install_bundle')
  } finally { writeDeclarationMode('off') }

  writeDeclarationMode('patch')
  try {
    const p = syncDeclarationsBestEffort('create')
    assert.equal(p.mode, 'patch')
    assert.equal(p.needsInstall, undefined, 'patch 模式没有装机这一步')
  } finally { writeDeclarationMode('off') }
})

test('[28] applyPresetDeclarations：预设很大时要如实提示体积代价（声明会把卡正文内联进 DSH 配置）', () => {
  // 造一个「大卡」预设：组合里塞 300 KB 正文（真卡上限 CARD_MAX 是 12 万字符，这里放宽造）
  const big = path.join(ROOT, 'preset-big')
  fs.mkdirSync(big, { recursive: true })
  fs.writeFileSync(path.join(big, 'preset.yml'), 'name: "大卡"\n', 'utf8')
  fs.writeFileSync(
    path.join(big, 'agent.cordis.yml'),
    '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: |-\n' + '      ' + 'x'.repeat(300 * 1024) + '\n',
    'utf8',
  )
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets.json'), 'utf8'))
  meta.presets.push({ id: 'preset-big', name: '大卡', dir: 'preset-big', mode: 'roleplay' })
  fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify(meta, null, 2), 'utf8')

  try {
    const r = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: true })
    assert.ok(r.bytesAfter > 256 * 1024, '合并后确实超过阈值：' + r.bytesAfter)
    assert.match(String(r.warning), /large-patch/, '必须提示体积代价')
    assert.ok(String(r.warning).includes('每次启动'), '要说清代价在哪（DSH 每次启动都要解析）')

    // 小文件时不提示（否则每次都狼来了）
    fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({ presets: meta.presets.filter(p => p.id !== 'preset-big') }, null, 2), 'utf8')
    const small = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: true })
    assert.equal(small.warning, '', '小配置不该报警')
  } finally {
    fs.writeFileSync(path.join(ROOT, 'presets.json'), JSON.stringify({
      presets: [
        { id: 'default', name: '酒馆默认', dir: 'tavern-lite', mode: 'roleplay' },
        { id: 'preset-role', name: '角色扮演', dir: 'preset-role', mode: 'roleplay' },
        { id: 'preset-empty', name: '空预设', dir: 'preset-empty', mode: 'roleplay' },
      ],
    }, null, 2), 'utf8')
  }
})

// ── 6. 「新建但没保存」的预设不许进名册（2026-10-03 实测事故）────
// 事故：用户新建预设后，DSH 顶部选择器里那一行是**空壳** —— persona 的 prefix 长度为 0、
// 没有 fs/pwsh/web 工具行。根因：createPreset 写下骨架后立刻同步声明，
// 而声明是从磁盘读 agent.cordis.yml 渲染的；此后保存预设从不重新同步，名册永久停在骨架上。
test('[29] isBlankPresetComposition：只认「新建骨架」，真组合一律 false', () => {
  assert.equal(isBlankPresetComposition(BLANK_PRESET_SKELETON), true, '骨架 = 空白')
  assert.equal(isBlankPresetComposition(''), true, '空文件也算没内容')
  assert.equal(isBlankPresetComposition('   \n\n'), true)
  assert.equal(isBlankPresetComposition(BLANK_PRESET_SKELETON.replace(/\n/g, '\r\n')), true, 'CRLF 一样认')
  assert.equal(isBlankPresetComposition('# 注释随便加\n' + BLANK_PRESET_SKELETON + '\n# 尾巴注释\n'), true, '注释/空行不影响判据')
  assert.equal(isBlankPresetComposition(COMPOSITION), false, '有正文有工具行 = 真组合')
  assert.equal(isBlankPresetComposition('- id: persona\n  config:\n    prefix: |-\n      你是角色扮演助手。\n'), false, '有正文就不是骨架')
})

test('[30] renderPresetDeclaration：没保存过的预设不声明（not-saved-yet），名册里不留空壳', () => {
  const never = path.join(ROOT, 'preset-never-saved')
  fs.mkdirSync(never, { recursive: true })
  fs.writeFileSync(path.join(never, 'agent.cordis.yml'), BLANK_PRESET_SKELETON, 'utf8')
  fs.writeFileSync(path.join(never, 'preset.yml'), 'name: "没保存过"\n', 'utf8')
  const metaPath = path.join(ROOT, 'presets.json')
  const before = fs.readFileSync(metaPath, 'utf8')
  const meta = JSON.parse(before)
  meta.presets.push({ id: 'preset-never-saved', name: '没保存过', dir: 'preset-never-saved', mode: 'roleplay' })
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')

  try {
    const d = renderPresetDeclaration('preset-never-saved')
    assert.equal(d.ok, false, '骨架组合不许生成声明行')
    assert.match(String(d.error), /not-saved-yet/, '错误码要能区分「空壳」和「目录不见了」')
    assert.equal(d.yaml, undefined, '不许带出半截 yaml')

    // 整块拼接：好的照旧，坏的进 failed 列表（名册里没有那一行）
    const decls = renderAllPresetDeclarations()
    const block = composePresetDeclarationBlock(decls)
    assert.ok(!block.text.includes('preset-preset-never-saved'), '名册文本里不许出现空壳预设的行')
    assert.ok(block.text.includes('preset-preset-role'), '其它预设照常声明')
    const bad = block.failed.find(f => f.id === 'preset-never-saved')
    assert.ok(bad, '失败的预设要出现在 failed 里（面板据此提示用户去保存）')
    assert.match(String(bad.error), /not-saved-yet/)
  } finally {
    fs.writeFileSync(metaPath, before, 'utf8')
    fs.rmSync(never, { recursive: true, force: true })
  }
})

test('[31] 预设展示名：preset.yml 被覆盖成目录名时，用注册表真名（酒馆默认 ≠ tavern-lite）', () => {
  assert.equal(presetDisplayNameFor('default'), '酒馆默认', '注册表 id 查得到')
  assert.equal(presetDisplayNameFor('tavern-lite'), '酒馆默认', '目录名也查得到（绑定里存的就是目录名）')
  assert.equal(presetDisplayNameFor('不存在的预设'), '不存在的预设', '查不到就退回传入值，绝不返回空串')

  // preset.yml 的 name 被历史 bug 写成了目录名 → 声明行必须显示注册表真名
  const dir = path.join(ROOT, 'preset-clobbered')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), COMPOSITION, 'utf8')
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: "preset-clobbered"\ndescription: "被写坏了"\n', 'utf8')
  const metaPath = path.join(ROOT, 'presets.json')
  const before = fs.readFileSync(metaPath, 'utf8')
  const meta = JSON.parse(before)
  meta.presets.push({ id: 'preset-clobbered', name: '用户起的真名', dir: 'preset-clobbered', mode: 'roleplay' })
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')

  try {
    const d = renderPresetDeclaration('preset-clobbered')
    assert.equal(d.ok, true)
    assert.ok(d.yaml.includes('        name: "用户起的真名"'), '目录名不是预设名：' + d.yaml.split('\n').slice(0, 8).join(' / '))
    assert.ok(!d.yaml.includes('name: "preset-clobbered"'))
  } finally {
    fs.writeFileSync(metaPath, before, 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 7. 内容没变就别写盘（否则 backups/ 会被保存预设刷爆）────────
test('[32] applyPresetDeclarations：受管块内容没变 → 不写盘、不备份（unchanged）', () => {
  const target = path.join(PROFILE_DIR, 'cordis.patch.yml')
  const backupDir = path.join(TMP_HOME, 'tavern-data', 'backups')
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  const backupsBefore = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0
  try {
    // 先把文件还原成「只有用户内容、没有受管块」，保证第一次调用必然要写盘
    fs.writeFileSync(target, stripManagedPresetBlock(fs.readFileSync(target, 'utf8')), 'utf8')
    const first = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false, confirm: true, timestamp: '2026-10-03T00-00-00-000Z' })
    assert.equal(first.ok, true)
    assert.equal(first.unchanged, false, '第一次确实改了内容（没有受管块 → 需要写入）')
    assert.equal(fs.readdirSync(backupDir).length - backupsBefore, 1, '真写盘 ⇒ 恰好一个备份')
    const second = applyPresetDeclarations({ profileDir: PROFILE_DIR, dryRun: false, confirm: true, timestamp: '2026-10-03T00-00-01-000Z' })
    assert.equal(second.ok, true)
    assert.equal(second.unchanged, true, '第二次没有变化 ⇒ 报 unchanged')
    assert.equal(second.wrote, false, '不许再写一遍（也不该产生第二个 .bak）')
    const backups = fs.readdirSync(backupDir).length - backupsBefore
    assert.equal(backups, 1, '第二次不该留下新备份，实际备份数：' + backups)
  } finally {
    if (before == null) { try { fs.rmSync(target, { force: true }) } catch {} }
    else fs.writeFileSync(target, before, 'utf8')
  }
})
