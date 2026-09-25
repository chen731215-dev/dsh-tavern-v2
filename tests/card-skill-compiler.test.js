/**
 * 卡库 Skill 编译器 —— 单元测试
 *
 * 被测：lib/card-skill-compiler.js（纯函数，路径显式注入，临时目录直打）
 *
 * 判据纪律：合规剔除断言配「数据侧对照臂」——把违规条目的年龄改成 20，
 * 同样的断言必须翻转（红），证明剔除逻辑真的在测合规而不是碰巧字符串相等。
 * 产物断言全部读盘验证（不信任返回对象）。
 *
 * 运行：node --test tests/card-skill-compiler.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compilePresetSkills, rebuildCardIndex, scanCompliance, slugifyCardName, groupMatchesCard } from '../lib/card-skill-compiler.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-skilltest-'))
}

// ── scanCompliance ──────────────────────────────────────────────────────────
test('scanCompliance: 未成年年龄+性内容 → block，成年不 block', () => {
  assert.equal(scanCompliance('age: 12\n阴道紧致').block, true)
  assert.equal(scanCompliance('age: 16\n胸部发育良好').block, true)
  assert.equal(scanCompliance('年龄：15\n精液').block, true)
  assert.equal(scanCompliance('age: 18\n做爱').block, false)   // 18 合法
  assert.equal(scanCompliance('age: 19\n做爱').block, false)   // 不得从第二位命中 9
  assert.equal(scanCompliance('age: 24\n做爱').block, false)   // 不得命中 4
  assert.equal(scanCompliance('age: 32\n做爱').block, false)
  assert.equal(scanCompliance('age: 216\n做爱').block, false)
  assert.equal(scanCompliance('age: 15\n喜欢冒险').block, false) // 纯 SFW 不 block
})

test('scanCompliance: 幼态词+性内容 → block（无需 age 行）', () => {
  assert.equal(scanCompliance('外表维持在萝莉时期\n高潮').block, true)
  assert.equal(scanCompliance('幼女体型\n插入').block, true)
  assert.equal(scanCompliance('幼女体型\n喜欢点心').block, false) // 幼态无性内容 → 保留
})

// ── slugifyCardName ─────────────────────────────────────────────────────────
test('slugifyCardName: ASCII 提取 / 全中文走稳定 hash', () => {
  assert.equal(slugifyCardName('Foo Card-2', 'tavern'), 'foo-card-2')
  const s1 = slugifyCardName('涩涩提瓦特', 'tavern')
  assert.match(s1, /^tavern-[0-9a-f]{8}$/)
  assert.equal(slugifyCardName('涩涩提瓦特', 'tavern'), s1) // 同名同 slug（稳定）
  assert.notEqual(slugifyCardName('涩涩提瓦特', 'other'), s1) // 不同预设不同 slug
})

// ── groupMatchesCard ────────────────────────────────────────────────────────
test('groupMatchesCard: 双向 includes 且忽略版本号', () => {
  assert.equal(groupMatchesCard('涩涩提瓦特v1.0', '涩涩提瓦特'), true)
  assert.equal(groupMatchesCard('群星的资料库 v3.3', '涩涩提瓦特'), false)
  assert.equal(groupMatchesCard('', '涩涩提瓦特'), false)
})

// ── compilePresetSkills（临时目录全流程）───────────────────────────────────
function writeFixture(dir, { cardBAge = 16 } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([
    { name: '测试卡A', desc: '测试用', first: '<maintext>开场</maintext><Status_block>\n状态栏:\n  名字: "👤 A"\n</Status_block>', enabled: true },
    { name: '违规卡B', desc: '', first: '人物 age: ' + cardBAge + '，胸部、精液描写……', enabled: true },
    { name: '停用卡C', desc: '', first: 'x', enabled: false },
  ]), 'utf8')
  fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify({
    version: 2, injectMode: 'full',
    groups: [
      { name: '测试卡A v1.0', entries: [
        { name: '世界观', comment: '世界观', keys: [], keywords: [], content: '大陆设定', enabled: true },
        { name: '角色甲', comment: '角色甲', keys: ['甲'], keywords: [], content: '甲的设定', enabled: true },
        { name: '违规条目', comment: '违规条目', keys: ['乙'], keywords: [], content: '人物 age: 14，小穴描写', enabled: true },
        { name: '停用条目', comment: '停用条目', keys: ['丙'], keywords: [], content: '不该出现', enabled: false },
      ] },
      { name: '无关资料库', entries: [{ name: 'e', comment: 'e', keys: [], keywords: [], content: 'x', enabled: true }] },
    ],
  }), 'utf8')
}

test('compilePresetSkills: 编译/剔除/整卡跳过/索引/未匹配组 全链路', async (t) => {
  const base = tmpDir()
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })
  const presetDir = path.join(base, 'preset')
  const skillsDir = path.join(base, 'skills')
  writeFixture(presetDir)

  const res = compilePresetSkills({ presetDir, presetName: '测试预设', presetId: 'tp', skillsDir })
  assert.equal(res.ok, true)

  // 卡 A：编译成功；违规条目被剔除且不在产物正文；停用条目不出现
  const a = res.cards.find(c => c.name === '测试卡A')
  assert.ok(a && a.slug, 'A 应有 slug')
  const aMd = fs.readFileSync(path.join(a.dir, 'SKILL.md'), 'utf8')
  assert.match(aMd, /^<!--\s*tavern-card:测试卡A\s*-->/m)
  assert.match(aMd, /name: tavern-card-/m)
  assert.ok(aMd.includes('大陆设定'), '常驻条目应内联')
  assert.ok(aMd.includes('甲的设定'), '触发条目应在库中')
  assert.ok(aMd.includes('| 角色甲 | 甲 |'), '触发索引表应存在')
  assert.ok(!aMd.includes('小穴描写'), '违规条目正文不得出现在产物')
  assert.ok(!aMd.includes('不该出现'), '停用条目不得出现')
  assert.ok(aMd.includes('已剔除 1 个条目'), '硬边界节应记录剔除清单')
  assert.ok(aMd.includes('输出格式契约'), '检测到 Status_block 应生成格式契约节')
  assert.ok(aMd.includes('<maintext>开场</maintext>'), '开场白应原样保留')

  // 数据侧对照臂：同一 fixture 把 A 组违规条目的年龄改成 20 → 剔除断言必须翻转
  const presetDir2 = path.join(base, 'preset2')
  writeFixture(presetDir2)   // B 卡保持 16 岁（违规），只有 A 组条目被改
  const wb = JSON.parse(fs.readFileSync(path.join(presetDir2, 'worldbooks.json'), 'utf8'))
  wb.groups[0].entries[2].content = '人物 age: 20，成年描写'
  fs.writeFileSync(path.join(presetDir2, 'worldbooks.json'), JSON.stringify(wb), 'utf8')
  const res2 = compilePresetSkills({ presetDir: presetDir2, presetName: '测试预设', presetId: 'tp2', skillsDir })
  const a2 = res2.cards.find(c => c.name === '测试卡A')
  assert.equal(a2.skipped.length, 0, '对照臂：年龄改 20 后不应再剔除（红绿翻转）')
  const a2Md = fs.readFileSync(path.join(a2.dir, 'SKILL.md'), 'utf8')
  assert.ok(a2Md.includes('成年描写'), '对照臂：成年内容应保留')
  assert.ok(!a2Md.includes('已剔除'), '对照臂：不应再有剔除清单')

  // 卡 B：first 带未成年+性内容 → 整卡跳过，无产物目录（断言必须在 res2 编译前：
  // 对照臂场景 B 仍为 16 岁，索引不应收录）
  const b = res.cards.find(c => c.name === '违规卡B')
  assert.ok(b && b.skipped === true, 'B 应整卡跳过')
  assert.ok(!fs.existsSync(path.join(skillsDir, 'tavern-card-' + slugifyCardName('违规卡B', 'tp'))), 'B 不得产出目录')
  const idxBefore = fs.readFileSync(path.join(skillsDir, 'tavern-cards', 'SKILL.md'), 'utf8')
  assert.ok(!idxBefore.includes('违规卡B'), '索引不得收录被跳过的 B')

  // 卡 C：停用 → 完全不出现
  assert.ok(!res.cards.find(c => c.name === '停用卡C'), '停用卡不得进结果')

  // 无关组进 unmatchedGroups
  assert.deepEqual(res.unmatchedGroups, [{ name: '无关资料库', count: 1 }])

  // 索引：含 A
  const idx = fs.readFileSync(path.join(skillsDir, 'tavern-cards', 'SKILL.md'), 'utf8')
  assert.match(idx, /name: tavern-cards/m)
  assert.ok(idx.includes('测试卡A'), '索引应收录 A')
  assert.ok(idx.includes('无关资料库'), '索引应列出未编译分组')
})

test('rebuildCardIndex: 标记扫描 + 同名卡编译版优先去重', async (t) => {
  const base = tmpDir()
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })
  const skillsDir = base
  const mk = (dir, cardName, extra) => {
    fs.mkdirSync(path.join(skillsDir, dir), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, dir, 'SKILL.md'),
      `---\nname: ${dir}\ndescription: ${dir} 的说明\n---\n\n<!-- tavern-card:${cardName} -->\n\n# ${dir}\n` + (extra || ''), 'utf8')
  }
  mk('tavern-card-zzz', '同名卡')          // 编译版（字母序靠后）
  mk('handmade-card', '同名卡')            // 手搓版（无前缀）
  mk('other-card', '别的卡')
  fs.mkdirSync(path.join(skillsDir, 'no-mark'), { recursive: true })
  fs.writeFileSync(path.join(skillsDir, 'no-mark', 'SKILL.md'), '---\nname: no-mark\n---\n\n无标记', 'utf8')

  const r = rebuildCardIndex({ skillsDir })
  const idx = fs.readFileSync(path.join(skillsDir, 'tavern-cards', 'SKILL.md'), 'utf8')
  assert.ok(r.ok)
  // 同名去重：编译版 tavern-card-zzz 胜出，handmade-card 不单列
  assert.equal((idx.match(/同名卡/g) || []).filter((_, i, arr) => true).length >= 1, true)
  const rows = idx.split('\n').filter(l => l.startsWith('| 同名卡') || l.startsWith('| 别的卡'))
  assert.equal(rows.length, 2, '同名卡只应出现一行（编译版优先）+ 别的卡一行')
  assert.match(rows.find(l => l.includes('同名卡')), /tavern-card-zzz/)
  assert.ok(!idx.includes('handmade-card'), '手搓版同名让位后不得出现路径')
  assert.ok(!idx.includes('no-mark'), '无标记 skill 不收录')
})
