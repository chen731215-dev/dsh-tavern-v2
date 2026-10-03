/**
 * 「🎓 技能」卡片的副作用回归。
 *
 * 起因（用户实测原文）：*"在酒馆面板里点 🎓 技能 的按钮（生成/刷新/删除/切形态）…会莫名出现不能打字
 * 的情况，就是光标都没了，点击对话框什么都没有也不能打字"* —— 页面其它部分正常，只能重启 DSH。
 *
 * 那句话把这四个按钮的收尾链路上的**两个副作用**暴露了出来（本文件就是钉住它们）：
 *
 *   ① `loadSkills()` 是四个按钮的收尾动作，而它旧写法**每次都打一次 `/api/tavern/tool-probe`**；
 *      那个接口旧写法会**真的往宿主工具注册表里注册一个探针工具再 dispose**
 *      ⇒ 每点一次技能按钮都动一次宿主状态。现在：接口改纯只读，客户端一个页面生命周期只问一次。
 *      本文件用假 `tools` 服务记录 register 调用，证明"问多少次都不注册"。
 *
 *   ② 「生成 / 切形态」旧写法**无条件重写 SKILL.md**（酒馆默认那份 ~19 万字节）；
 *      而 DSH 用 chokidar 监视 `<DSH_HOME>/skills` ⇒ 写一次盘 = 宿主重载一次技能清单。
 *      现在：内容一致就一个字节都不写（`unchanged: true`，mtime 一动不动 ⇒ 宿主连事件都收不到）。
 *      本文件靠 mtime 来证明"真的没写"。
 *
 * 运行：node --test tests/skill-card-sideeffects.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-sfx-'))
process.env.DSH_HOME = TMP_HOME

const PRESET_ROOT = path.join(TMP_HOME, '.agent-presets')
const SKILLS_ROOT = path.join(TMP_HOME, 'skills')

// ── 夹具：一个有卡有世界书的酒馆预设（生成 skill 的输入）────────────
const PID = 'preset-sfx-a'
{
  const dir = path.join(PRESET_ROOT, PID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: "副作用测试"\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), [
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |-',
    '      你是阿离，说话简短。',
    '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([
    { name: '阿离', desc: '酒馆的看板娘', enabled: true },
  ]), 'utf8')
  fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify([
    { name: '苍玄界', enabled: true, entries: [
      { name: '地理', content: '东边是海。', enabled: true },
    ] },
  ]), 'utf8')
}

// ── 假 DSH：把插件真 apply() 起来（照 native-bind-route.test.js 的形态）──
//   ★ 关键：这里的 tools.register 会把调用记下来 —— 只要插件还敢注册，测试就会红。
const routes = []
const sections = {}
const handlers = {}
const registerCalls = []

const services = {
  webServer: { register: (r) => { routes.push(r) } },
  systemPrompt: { section: (o) => { sections[o.name] = o; return () => {} } },
  sessions: { get: (id) => (id ? { id } : undefined) },
  agents: { get: () => undefined },
  agentPresets: { select: async () => 'x' },
  sessionProjections: { stateOf: () => undefined },
  sessionPersistence: { list: async () => [] },
  dshHomePath: () => TMP_HOME,
  tools: {
    register(t) { registerCalls.push((t && t.name) || '<anonymous>'); return () => {} },
    list() { return [{ name: 'some_existing_tool' }] },
    schemas() { return [] },
  },
}

const ctx = Object.assign({
  get: (name) => services[name],
  on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}, services)

const lib = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
lib.apply(ctx)

// ── 假 HTTP：调用真路由，等 res.end ─────────────────────────────
function callRoute(routePath, method, body) {
  const route = routes.find((r) => r.path === routePath)
  assert.ok(route, '路由必须已注册：' + routePath)
  const req = method === 'POST'
    ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body || {}), 'utf8')]), { method, url: routePath })
    : Object.assign(Readable.from([]), { method, url: routePath })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(payload) {
        try { resolve({ status: this.statusCode, body: JSON.parse(String(payload || '{}')) }) }
        catch (e) { reject(new Error('响应不是 JSON：' + String(payload))) }
      },
    }
    try { route.handler(req, res) } catch (e) { reject(e) }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ════════════════════════════════════════════════════════════════
// ① 探测接口必须是只读的：只报告能力，绝不注册
// ════════════════════════════════════════════════════════════════
test('① /api/tavern/tool-probe 只读：报告能力但不注册任何工具', async () => {
  registerCalls.length = 0
  const r = await callRoute('/api/tavern/tool-probe', 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hasToolsService, true, '要能发现宿主的 tools 服务')
  assert.equal(r.body.hasRegister, true)
  assert.equal(r.body.canRegister, true, '要报告"具备注册能力"这件事')
  assert.equal(r.body.registerSkipped, true, '要明确说自己跳过了注册')
  assert.equal(r.body.registeredProbe, false, '不能再出现"已注册探针"')
  assert.deepEqual(registerCalls, [], '★ 不允许真注册探针工具')
  assert.ok(
    Array.isArray(r.body.sampleTools) && r.body.sampleTools.includes('some_existing_tool'),
    '顺带列出已有工具名，用来证明这确实是注册表：' + JSON.stringify(r.body.sampleTools)
  )
})

test('② 连问 5 次（= 连点 5 次技能按钮）依旧零注册', async () => {
  registerCalls.length = 0
  for (let i = 0; i < 5; i++) await callRoute('/api/tavern/tool-probe', 'GET')
  assert.deepEqual(registerCalls, [], '★ 刷新技能卡片不能有任何宿主侧副作用')
})

// ════════════════════════════════════════════════════════════════
// ② 生成：内容一致就不许写盘（写盘 = chokidar 报 change = 宿主重载技能清单）
// ════════════════════════════════════════════════════════════════
test('③ 内容一致时 /skills/generate 不写盘：unchanged=true 且 mtime 一动不动', async () => {
  const r1 = await callRoute('/api/tavern/skills/generate', 'POST', { presetId: PID })
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r1.body.ok, true, JSON.stringify(r1.body))
  assert.equal(r1.body.unchanged, false, '第一次是真写')
  assert.equal(path.dirname(r1.body.dir), SKILLS_ROOT, '★ 必须写 DSH 用户级 skill 根（被监视）')
  assert.ok(fs.existsSync(r1.body.file), '文件要真的存在')
  const st1 = fs.statSync(r1.body.file)
  const body1 = fs.readFileSync(r1.body.file, 'utf8')

  await sleep(30)   // 让 mtime 有分辨空间：真写了就一定会变

  const r2 = await callRoute('/api/tavern/skills/generate', 'POST', { presetId: PID })
  assert.equal(r2.body.ok, true)
  assert.equal(r2.body.unchanged, true, '★ 内容一致 ⇒ 必须报 unchanged')
  const st2 = fs.statSync(r2.body.file)
  assert.equal(st2.mtimeMs, st1.mtimeMs, '★ 不能重写：mtime 必须一模一样（否则宿主会收到 change 事件）')
  assert.equal(st2.size, st1.size)
  assert.equal(fs.readFileSync(r2.body.file, 'utf8'), body1, '内容当然也不能变')
  assert.ok(r2.body.bytes > 0, '字节数还是要如实回报')
})

test('④ 形态真的不同时照样写盘（切形态不能只报 unchanged）', async () => {
  const a = await callRoute('/api/tavern/skills/generate', 'POST', { presetId: PID, style: 'index' })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.body.style, 'index')
  const afterA = fs.readFileSync(a.body.file, 'utf8')
  const stA = fs.statSync(a.body.file)

  await sleep(30)
  const b = await callRoute('/api/tavern/skills/generate', 'POST', { presetId: PID, style: 'instructions' })
  assert.equal(b.body.style, 'instructions')
  const afterB = fs.readFileSync(b.body.file, 'utf8')

  assert.notEqual(afterA, afterB, '★ 两种形态的正文必须不一样，否则「切形态」是假的')
  assert.equal(b.body.unchanged, false, '内容不同 ⇒ 必须真写')
  assert.notEqual(fs.statSync(b.body.file).mtimeMs, stA.mtimeMs, '真写了 mtime 就该变')
})

test('⑤ 预设不存在时生成要报错、不许偷偷造目录', async () => {
  const r = await callRoute('/api/tavern/skills/generate', 'POST', { presetId: 'preset-does-not-exist' })
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
  assert.equal(fs.existsSync(path.join(SKILLS_ROOT, 'tavern-preset-does-not-exist')), false)
})
