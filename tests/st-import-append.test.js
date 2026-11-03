/**
 * ST 预设导入**必须落到当前预设的写作模块**（2.7.28 修的 bug）。
 *
 * 用户现场：在「内容 → 📝 写作模块」里点导入，选了 Kemini Aether-fr-3.72.json，
 * 界面上什么都没有 —— 因为旧实现不带 presetId，服务端 `createPreset(conv.name)`
 * **新建了一个 Agent 预设**，模块落在新目录里，当前预设的写作模块当然是空的。
 *
 * 这里钉三件事：
 *   ① 前端传 presetId；没有当前预设时**明确报错**，不许偷偷建新预设；
 *   ② 服务端带 presetId 时往该目录的 presets.json **追加一个包**（不建目录、不动 agent.cordis.yml）；
 *   ③ 同名包不覆盖（加 (2)），否则第二次导入会静默吃掉第一份。
 *
 * 运行：node tests/st-import-append.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertStPreset, isStPreset } from '../lib/st-preset.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ROUTES = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'routes.js'), 'utf8')
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib', 'client.manager.bundle.js'), 'utf8')

/** 一份最小但形态真实的 ST chat-completion 预设（含 prompt_order 与一条禁用项）。 */
const SAMPLE = {
  prompts: [
    { identifier: 'core-main', name: 'Main Prompt', content: '你是互动式小说生成器。' },
    { identifier: 'sys', name: '系统设定', content: '按<core_features>接续剧情。' },
    { identifier: 'alt', name: '备选主提示', content: '另一种写法。' },
    { identifier: 'chatHistory', name: 'Chat History', content: '' },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: 'core-main', enabled: true },
        { identifier: 'sys', enabled: true },
        { identifier: 'alt', enabled: false },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
  ],
}

test('① 转换层：这段 ST 预设能出模块（结构占位被丢、禁用项保留但不启用）', () => {
  assert.equal(isStPreset(SAMPLE), true)
  const r = convertStPreset(SAMPLE, { name: '示例预设' })
  assert.equal(r.ok, true)
  assert.equal(r.name, '示例预设')
  const names = r.modules.map(m => m.name)
  assert.ok(names.includes('Main Prompt'), '启用的主提示必须在')
  assert.ok(!names.includes('Chat History'), '结构占位（Chat History）必须被丢掉')
  const alt = r.modules.find(m => m.name === '备选主提示')
  assert.equal(alt && alt.enabled, false, '禁用项保留为 enabled:false，面板可再开')
})

test('② 前端：导入必须带 presetId；没有当前预设就明确拒绝，不许偷偷建预设', () => {
  const i = CLIENT.indexOf("fetch('/api/tavern/preset/import-st'")
  assert.ok(i > 0, '找不到 import-st 调用')
  const body = CLIENT.slice(i, i + 700)
  assert.match(body, /presetId: targetPid/, '请求体必须带 presetId')
  assert.match(CLIENT, /请先在上方「🎭 当前 Agent 预设」里选一个预设/, '没有预设时必须给出人话提示')
  assert.match(CLIENT, /loadCurrent\(targetPid\)/, '导入成功后必须重读当前预设（否则列表不刷新）')
})

test('③ 服务端：带 presetId 时追加包，不新建目录、不动 agent.cordis.yml', () => {
  const i = ROUTES.indexOf("path: '/api/tavern/preset/import-st'")
  assert.ok(i > 0)
  const handler = ROUTES.slice(i, i + 4200)
  assert.match(handler, /const targetId = String\(\(body && body\.presetId\) \|\| ''\)\.trim\(\)/, '必须读 body.presetId')
  assert.match(handler, /packs\.push\(\{ name: packName, modules: conv\.modules, enabled: true \}\)/, '必须向 presets.json 追加一个包')
  assert.match(handler, /for \(let i = 2; taken\.has\(packName\)/, '同名包必须加序号而不是覆盖')
  assert.match(handler, /mode: 'append'/, '返回值要标明是追加，前端据此回显')
  // 追加分支里不许再写 agent.cordis.yml / 建目录
  const appendPart = handler.slice(0, handler.indexOf('const created = createPreset'))
  assert.ok(appendPart.length > 200, '追加分支必须存在且在建新预设之前')
  assert.ok(!/writeFileSync\([^)]*agent\.cordis\.yml/.test(appendPart), '追加分支不许写 agent.cordis.yml')
  assert.ok(!/const created = createPreset\(/.test(appendPart), '追加分支不许 createPreset')
})

test('④ 兜底：不带 presetId 时仍保留旧行为（新建 Agent 预设），但描述用新术语', () => {
  const i = ROUTES.indexOf("path: '/api/tavern/preset/import-st'")
  const handler = ROUTES.slice(i, i + 4200)
  assert.match(handler, /const created = createPreset\(conv\.name\)/, '无 presetId 时的旧路径要保留（脚本/CLI 仍在用）')
  assert.match(handler, /个写作模块/, 'preset.yml 的描述必须用「写作模块」')
  assert.ok(!/个预设模块/.test(handler), '描述里不许再出现旧称')
})
