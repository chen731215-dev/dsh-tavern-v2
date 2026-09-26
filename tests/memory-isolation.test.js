/**
 * 记忆注入的会话隔离回归测试（2026-09 串台故障）
 *
 * 故障：会话 A 的剧情记忆被注入到会话 B 的系统提示里，而且每开一条新对话都重注入一遍。
 * 根因：`tavern:card` 的「记忆总结注入」写成了
 *         readSessionMemory(sid) || readMemory(presetId) || ''
 *       后半截是**按预设累积的共享文件**（<presetDir>/memory.md），任何绑定同一预设的
 *       会话都会整份读进去。引入提交：581a52b（v1.8.0）。
 *
 * 本文件单独存在，不动 tests/core.test.js（那边可能有人在用）。
 * 运行：node --test tests/memory-isolation.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const INDEX = path.join(import.meta.dirname, '..', 'lib', 'index.js')
const SRC = fs.readFileSync(INDEX, 'utf8')
const LINES = SRC.split(/\r?\n/)

// ── 从 lib/index.js 原样切片，避免「测的是另一份等价实现」 ──
function sliceFn(name) {
  const start = LINES.findIndex((l) => l.startsWith('function ' + name + '('))
  assert.ok(start >= 0, '找不到函数: ' + name)
  if (LINES[start].trim().endsWith('}')) return LINES[start]
  for (let i = start + 1; i < LINES.length; i++) {
    if (LINES[i] === '}') return LINES.slice(start, i + 1).join('\n')
  }
  throw new Error('函数未闭合: ' + name)
}
function sliceBetween(markerRe, stopRe) {
  const start = LINES.findIndex((l) => markerRe.test(l))
  assert.ok(start >= 0, '找不到标记: ' + String(markerRe))
  for (let i = start; i < LINES.length; i++) {
    if (stopRe.test(LINES[i])) return LINES.slice(start, i + 1).join('\n')
  }
  throw new Error('块未闭合')
}

const INJECT_BLOCK = sliceBetween(/★ 记忆总结注入/, /^\s*\}\s*catch \{\}$/)

// ── 1. 源码级护栏：注入端不许再回退到预设记忆 ──
test('记忆注入：不许回退到 readMemory(presetId)（本次串台的根因）', () => {
  assert.ok(
    !/readSessionMemory\(sid\)\s*\|\|\s*readMemory\(/.test(INJECT_BLOCK),
    '注入块又出现了 readSessionMemory(sid) || readMemory(presetId) 形式的回退',
  )
  assert.ok(
    /readSessionMemory\(sid\)/.test(INJECT_BLOCK),
    '注入块应当读会话级记忆',
  )
})

// ── 2. 源码级护栏：写入端不许再往共享的预设文件里追加 ──
test('记忆写入：runSummary 不再 appendMemory(targetPresetId, ...)', () => {
  // 只看「真的当语句调用」的行，注释里提到这个符号不算
  assert.ok(
    !LINES.some((l) => /^\s*appendMemory\(targetPresetId/.test(l)),
    'runSummary 又把总结写进「按预设累积的共享文件」了',
  )
  assert.ok(
    /appendSessionMemory\(realSessionId/.test(SRC),
    '总结必须写进会话级记忆',
  )
})

// ── 3. 源码级护栏：自动总结不许在异步回调里读全局 lastSessionId ──
test('自动总结：目标会话 id 必须在同步段钉成常量（不能异步后再读全局 lastSessionId）', () => {
  const start = LINES.findIndex((l) => l.includes('const maybeAutoSummary'))
  assert.ok(start >= 0)
  const body = LINES.slice(start, start + 30).join('\n')
  assert.ok(/const targetSid = lastSessionId/.test(body), '自动总结应当先把 lastSessionId 钉成 targetSid')
  assert.ok(
    !/runSummary\(ctx, st2, lastSessionId,/.test(body),
    'runSummary 不能在 .then() 里再读 lastSessionId ——那次读取拿到的是别的会话',
  )
})

// ── 4. 行为级：同样的磁盘数据下，会话记忆为空 → 注入为空（哪怕预设文件堆满了别人的剧情）──
test('行为：会话没有自己的记忆时，注入为空（预设记忆不再顶上来）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mem-iso-'))
  const presetsRoot = path.join(tmp, '.agent-presets')
  const presetDir = path.join(presetsRoot, 'preset-under-test')
  fs.mkdirSync(presetDir, { recursive: true })
  fs.writeFileSync(path.join(presetsRoot, 'presets.json'), JSON.stringify({
    presets: [{ id: 'preset-under-test', name: '被试预设', dir: 'preset-under-test', mode: 'roleplay' }],
  }), 'utf8')
  // 伪装成「别的卡的剧情记忆」堆在预设共享文件里
  const FOREIGN = '# 记忆总结 [2026/8/23 16:08:15]\n别的卡的剧情：安柏、丽莎、优菈在蒲公英酒馆。\n'
  fs.writeFileSync(path.join(presetDir, 'memory.md'), FOREIGN, 'utf8')

  const mod = await loadInjector(presetsRoot, path.join(tmp, 'tavern-data'))

  assert.equal(mod.buildSummaryText('session-fresh-0000', 'preset-under-test'), '',
    '全新会话不该拿到预设共享文件里的记忆')

  // 会话有了自己的记忆 → 只注入自己的
  const own = '# 记忆总结 [2026/9/1 10:00:00]\n这条会话自己的剧情：主角在足控天堂点了一单。\n'
  fs.mkdirSync(path.join(tmp, 'tavern-data', 'sessions', 'session-fresh-0000'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'tavern-data', 'sessions', 'session-fresh-0000', 'memory.md'), own, 'utf8')

  const out = mod.buildSummaryText('session-fresh-0000', 'preset-under-test')
  assert.ok(out.includes('足控天堂点了一单'), '会话自己的记忆必须照常注入')
  assert.ok(!out.includes('安柏'), '别的卡的剧情不得出现')

  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── 5. 对照臂：修前那句兜底在同一份夹具上**确实会漏**（证明上面那条不是恒真空断言）──
//    历史原句来自 581a52b（v1.8.0）引入、并在 HEAD 里仍然存在：
//      const mem = readSessionMemory(sid) || readMemory(presetId) || ''
test('对照臂：改回旧兜底 expression 时，同一夹具会注进外来记忆（能红）', async () => {
  const LEGACY_LINE = "const mem = readSessionMemory(sid) || readMemory(presetId) || ''"
  const legacyBlock = INJECT_BLOCK.replace("const mem = readSessionMemory(sid) || ''", LEGACY_LINE)
  assert.ok(legacyBlock.includes(LEGACY_LINE), '旧表达式还原失败，对照臂失效')
  assert.notEqual(legacyBlock, INJECT_BLOCK, '对照臂必须与现行代码不同')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mem-iso-old-'))
  const presetsRoot = path.join(tmp, '.agent-presets')
  const presetDir = path.join(presetsRoot, 'preset-under-test')
  fs.mkdirSync(presetDir, { recursive: true })
  fs.writeFileSync(path.join(presetsRoot, 'presets.json'), JSON.stringify({
    presets: [{ id: 'preset-under-test', name: '被试预设', dir: 'preset-under-test', mode: 'roleplay' }],
  }), 'utf8')
  fs.writeFileSync(path.join(presetDir, 'memory.md'),
    '# 记忆总结 [2026/8/23 16:08:15]\n别的卡的剧情：安柏、丽莎、优菈在蒲公英酒馆。\n', 'utf8')

  const oldMod = await loadInjector(presetsRoot, path.join(tmp, 'tavern-data'), legacyBlock)
  const leaked = oldMod.buildSummaryText('session-fresh-0000', 'preset-under-test')

  assert.ok(leaked.length > 0, '旧代码在「会话记忆为空」时应当漏进预设记忆 —— 这条必须在旧代码下为真')
  assert.ok(leaked.includes('蒲公英酒馆'), '旧代码漏进来的正是别的卡的剧情')

  const newMod = await loadInjector(presetsRoot, path.join(tmp, 'tavern-data'))
  assert.equal(newMod.buildSummaryText('session-fresh-0000', 'preset-under-test'), '',
    '新代码在同一夹具下必须为空')

  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 用一条临时 presets.json + 临时 TAVERN_DATA_ROOT 装配真实的注入块 */
async function loadInjector(presetsRoot, tavernDataRoot, injectBlock) {
  const block = injectBlock || INJECT_BLOCK
  const consts = sliceBetween(/^let ROOT = path\.join\(DSH_HOME, '\.agent-presets'\)/, /^const DEFAULT_PRESET_DIR/)
    .replace(/path\.join\(DSH_HOME, /g, "path.join('" + presetsRoot.replace(/\\/g, '/') + "', ")
    .replace(/let ROOT = path\.join\('([^']+)', '\.agent-presets'\)/, "let ROOT = '$1'")
    .replace(/let TAVERN_DATA_ROOT = path\.join\('([^']+)', 'tavern-data'\)/, "let TAVERN_DATA_ROOT = '" + tavernDataRoot.replace(/\\/g, '/') + "'")
  const code = [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    consts,
    sliceFn('readPresetsMeta'),
    sliceFn('getPresetDir'),
    sliceFn('memoryFile'),
    sliceFn('sessionDir'),
    sliceFn('sessionMemoryFile'),
    sliceFn('readSessionMemory'),
    sliceFn('readMemory'),
    'export function buildSummaryText(sid, presetId) {',
    block,
    '  return summaryText',
    '}',
    '',
  ].join('\n')
  const modPath = path.join(presetsRoot, '_injector-under-test-' + (injectBlock ? 'old' : 'new') + '.mjs')
  fs.writeFileSync(modPath, code, 'utf8')
  return import(pathToFileURL(modPath).href)
}
