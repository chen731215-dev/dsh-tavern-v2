/**
 * 导出（角色卡 / 世界书 / 预设）回归测试。
 *
 * 用户需求（2026-10-28）：*"再做一个导出角色卡，世界书，预设的功能，必须要有选择文件夹导出"*。
 *
 * 本文件覆盖的是 **lib/server/export.js**（纯转换器 + 落盘逻辑）：
 *   ① `safeFileName` / `normalizeTargets`：非法字符、空值、未知 target；
 *   ② 三个转换器：ST 卡 `chara_card_v2`、ST world info（`entries` 为对象）、ST 预设（只有 prompts）；
 *   ③ 端到端落盘：目录结构、文件内容、manifest、**原预设目录一个字节都没动**；
 *   ④ 错误路径：目标目录不存在必须报错（不许静默写到别处）。
 *
 * ⚠️ 不测 `pickExportFolder()`：它会真的弹系统「选择文件夹」对话框 —— 在 CI / 无人值守环境
 * 会把测试挂死。它由 route 层在 `pickFolder:true` 时才调用，routes-smoke 用「不带 parentDir
 * 也不带 pickFolder」的请求覆盖了"不弹框、直接 400"那一支。
 *
 * 运行：node tests/export-bundle.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  EXPORT_TARGETS,
  safeFileName,
  normalizeTargets,
  stCharacterCard,
  stWorldbook,
  stPromptPreset,
  stampOf,
  exportPresets,
} from '../lib/server/export.js'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// ══════════════════════════════════════════════════════════════
// ① 名字与目标
// ══════════════════════════════════════════════════════════════

test('safeFileName：去掉 Windows 非法字符，保留中文，去掉首尾点/空格', () => {
  assert.equal(safeFileName('阿离/武器:测试*?'), '阿离_武器_测试__')
  assert.equal(safeFileName('  ..角色卡..  '), '角色卡')
  assert.equal(safeFileName(''), '未命名')
  assert.equal(safeFileName(null), '未命名')
  assert.equal(safeFileName('   ', '兜底'), '兜底')
  assert.equal(safeFileName('a'.repeat(80)).length, 60, '超长要截断')
})

test('normalizeTargets：未知项丢弃；空/非法 ⇒ 三类全导', () => {
  assert.deepEqual(normalizeTargets(['characters', 'nope']), ['characters'])
  assert.deepEqual(normalizeTargets([]), EXPORT_TARGETS)
  assert.deepEqual(normalizeTargets(null), EXPORT_TARGETS)
  assert.deepEqual(normalizeTargets(['worldbooks', 'preset']), ['worldbooks', 'preset'])
})

test('stampOf：可排序且不含非法字符', () => {
  const s = stampOf(new Date(2026, 9, 28, 23, 5))
  assert.equal(s, '2026-10-28_2305')
  assert.doesNotMatch(s, /[<>:"/\\|?*]/)
})

// ══════════════════════════════════════════════════════════════
// ② 三个转换器
// ══════════════════════════════════════════════════════════════

test('stCharacterCard：desc/first/alternates 映射到 chara_card_v2', () => {
  const card = stCharacterCard({
    name: '阿离',
    desc: '看板娘。',
    first: '【第一】你好。',
    alternates: ['【备选】又见面了。'],
  })
  assert.equal(card.spec, 'chara_card_v2')
  assert.equal(card.spec_version, '2.0')
  assert.equal(card.data.name, '阿离')
  assert.equal(card.data.description, '看板娘。')
  assert.equal(card.data.first_mes, '【第一】你好。')
  assert.deepEqual(card.data.alternate_greetings, ['【备选】又见面了。'],
    '★ 备选开场白必须一起导出 —— 否则导出的卡在 ST / 再导入时又只剩第一条')
  assert.ok(!('desc' in card.data), '不该把内部字段原样塞进 ST 结构')
})

test('stCharacterCard：空名字/空备选也给出合法结构', () => {
  const card = stCharacterCard({ alternates: ['', null] })
  assert.equal(card.data.name, '未命名角色')
  assert.deepEqual(card.data.alternate_greetings, [])
})

test('stWorldbook：entries 为对象，key/comment/content/disable 对齐 ST', () => {
  const wb = stWorldbook({
    name: '世界观',
    entries: [
      { name: '地理', keywords: ['东海', '海'], content: '东边是海。', enabled: true },
      { name: '禁术', keys: ['禁术'], content: '会反噬。', enabled: false },
    ],
  })
  assert.equal(wb.name, '世界观')
  assert.deepEqual(Object.keys(wb.entries), ['0', '1'], 'ST 的口径是 entries 对象，键是下标')
  assert.deepEqual(wb.entries['0'].key, ['东海', '海'])
  assert.equal(wb.entries['0'].comment, '地理')
  assert.equal(wb.entries['0'].content, '东边是海。')
  assert.equal(wb.entries['0'].disable, false)
  assert.equal(wb.entries['1'].disable, true, 'enabled:false ⇒ disable:true')
  assert.deepEqual(wb.entries['1'].key, ['禁术'], 'keys 字段也要认')
})

test('stPromptPreset：只带 prompts（不带 prompt_order ⇒ 面板按"模块"导入而不是新建预设）', () => {
  const p = stPromptPreset('示例预设', [
    { name: '写作要求', content: '不要八股。', enabled: true },
    { name: '禁词', content: '不用"仿佛"。', enabled: false },
  ])
  assert.equal(p.name, '示例预设')
  assert.equal(p.prompts.length, 2)
  assert.equal(p.prompts[0].name, '写作要求')
  assert.equal(p.prompts[0].enabled, true)
  assert.equal(p.prompts[1].enabled, false)
  assert.equal('prompt_order' in p, false, '★ 带 prompt_order 会被面板当成 ST 预设新建一个 agent 预设')
})

// ══════════════════════════════════════════════════════════════
// ③ 端到端落盘
// ══════════════════════════════════════════════════════════════

function makePresetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-export-src-'))
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 示例预设\ndescription: 夹具\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '- id: persona\n  name: persona\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([{ name: '阿离', desc: '看板娘。', first: '你好。' }], null, 2), 'utf8')
  return dir
}

function itemOf(dir) {
  return {
    presetId: 'preset-fixture-export',
    name: '示例预设',
    dir,
    characters: JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8')),
    worldbooks: [{ name: '世界观', entries: [{ name: '地理', keywords: ['东海'], content: '东边是海。', enabled: true }] }],
    modules: [{ name: '写作要求', content: '不要八股。', enabled: true }],
  }
}

test('exportPresets：目录结构 / 文件内容 / manifest 三样都对', () => {
  const src = makePresetDir()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-export-dst-'))
  const r = exportPresets({ parentDir: outDir, items: [itemOf(src)], now: new Date(2026, 9, 28, 23, 5) })
  assert.equal(r.ok, true)
  assert.equal(path.basename(r.dir), '酒馆导出-2026-10-28_2305')
  assert.ok(fs.existsSync(path.join(r.dir, 'manifest.json')), '必须有 manifest')
  assert.ok(fs.existsSync(path.join(r.dir, '说明.txt')), '必须有说明.txt')

  const presetFolder = path.join(r.dir, '示例预设')
  for (const f of [
    '角色卡/characters.json',
    '角色卡/阿离.json',
    '世界书/worldbooks.json',
    '世界书/世界观.json',
    '世界书/世界观.st.json',
    '预设/preset.yml',
    '预设/agent.cordis.yml',
    '预设/presets.json',
    '预设/st-preset.json',
  ]) {
    assert.ok(fs.existsSync(path.join(presetFolder, f)), '缺少导出文件：' + f)
  }

  // 内容抽查
  const card = JSON.parse(fs.readFileSync(path.join(presetFolder, '角色卡/阿离.json'), 'utf8'))
  assert.equal(card.data.first_mes, '你好。')
  const st = JSON.parse(fs.readFileSync(path.join(presetFolder, '世界书/世界观.st.json'), 'utf8'))
  assert.equal(st.entries['0'].content, '东边是海。')
  const sp = JSON.parse(fs.readFileSync(path.join(presetFolder, '预设/st-preset.json'), 'utf8'))
  assert.equal(sp.prompts[0].name, '写作要求')
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.presets.length, 1)
  assert.deepEqual(manifest.targets, EXPORT_TARGETS)

  // 文件清单与实际落盘一致（不多不少）
  const onDisk = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else onDisk.push(path.relative(r.dir, p).replace(/\\/g, '/'))
    }
  }
  walk(r.dir)
  assert.deepEqual([...onDisk].sort(), [...r.files].sort(), '返回的 files 必须与磁盘一致（含 manifest 与说明）')
})

test('exportPresets：只选「预设」时，角色卡/世界书一个文件都不写', () => {
  const src = makePresetDir()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-export-dst2-'))
  const r = exportPresets({ parentDir: outDir, items: [itemOf(src)], targets: ['preset'] })
  const presetFolder = path.join(r.dir, '示例预设')
  assert.equal(fs.existsSync(path.join(presetFolder, '角色卡')), false)
  assert.equal(fs.existsSync(path.join(presetFolder, '世界书')), false)
  assert.ok(fs.existsSync(path.join(presetFolder, '预设/st-preset.json')))
})

test('exportPresets：★ 原预设目录一个字节都没被动过（导出只读）', () => {
  const src = makePresetDir()
  const before = Object.fromEntries(fs.readdirSync(src).map((f) => [f, sha(fs.readFileSync(path.join(src, f), 'utf8'))]))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-export-dst3-'))
  exportPresets({ parentDir: outDir, items: [itemOf(src)] })
  const after = Object.fromEntries(fs.readdirSync(src).map((f) => [f, sha(fs.readFileSync(path.join(src, f), 'utf8'))]))
  assert.deepEqual(after, before, '导出必须只读：原预设文件内容不得变化')
  assert.deepEqual(fs.readdirSync(src).sort(), Object.keys(before).sort(), '原目录里不得多出/少掉文件')
})

test('exportPresets：目标目录不存在 ⇒ 明确报错（不许静默写到别处）', () => {
  const outDir = path.join(os.tmpdir(), 'dsh-tavern-export-missing-' + Date.now())
  assert.throws(
    () => exportPresets({ parentDir: outDir, items: [] }),
    /目标文件夹不存在/,
  )
})

test('exportPresets：多个同名预设不会互相覆盖（目录名去重）', () => {
  const src = makePresetDir()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-export-dst4-'))
  const two = [itemOf(src), itemOf(src)]
  two[1].name = '示例预设'
  const r = exportPresets({ parentDir: outDir, items: two })
  assert.equal(r.perPreset.length, 2)
  assert.notEqual(r.perPreset[0].dir, r.perPreset[1].dir, '同名预设必须落到不同目录')
})
