/**
 * activePresetIdx（预设选中光标）持久化回归测试
 *
 * 背景：面板里「选中第几组预设」原来只存前端内存（state.activePresetIdx），
 *       面板重开会落回第 0 组。现在走 /api/tavern/state 的既有全局 state 机制
 *       （与 enhanceRuntime 等开关同一套 readState/writeState）持久化。
 * 铁律：只持久化「光标」，绝不触碰 presets 内容本身（那走 /api/tavern/save）；
 *       POST 只接受非负整数，非法值忽略（不得写进 state）。
 *
 * 运行：node --test tests/preset-idx.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠ Windows 上不能用 new URL(import.meta.url).pathname —— 会给出 "/C:/..."。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

// 端到端读写的 STATE_PATH 由 $DSH_HOME 决定，且 index.js 在模块加载时就绑定 ROOT，
// 必须先把 DSH_HOME 指到临时目录再 import（与 preset-enhance.test.js 同款）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preset-idx-'))
process.env.DSH_HOME = TMP_HOME

const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const { readState, writeState, normalizeActivePresetIdx } = _test

// ── 1. POST 载荷的合法化（合法值放行）────────────────────
test('[1] normalizeActivePresetIdx 放行非负整数（含数字字符串形态）', () => {
  assert.equal(normalizeActivePresetIdx(0), 0, '第 0 组是合法光标')
  assert.equal(normalizeActivePresetIdx(2), 2)
  assert.equal(normalizeActivePresetIdx('3'), 3, 'JSON 里传来字符串数字也按整数收')
})

// ── 2. POST 载荷的合法化（非法值一律忽略）────────────────
test('[2] normalizeActivePresetIdx 对非法值返回 null（调用方忽略，不得写入）', () => {
  assert.equal(normalizeActivePresetIdx(-1), null, '负数非法')
  assert.equal(normalizeActivePresetIdx(1.5), null, '小数非法')
  assert.equal(normalizeActivePresetIdx('abc'), null, '非数字字符串非法')
  assert.equal(normalizeActivePresetIdx(null), null, '显式 null 非法（Number(null) 是 0，必须挡住）')
  assert.equal(normalizeActivePresetIdx(undefined), null, '未传字段忽略')
  assert.equal(normalizeActivePresetIdx(''), null, '空串忽略')
  assert.equal(normalizeActivePresetIdx({ a: 1 }), null, '对象忽略')
})

// ── 3. GET 回读：写入什么读回什么（持久化机制本身）────────
test('[3] writeState 持久化 activePresetIdx，readState 能原样回读', () => {
  writeState({ cardEnabled: true, activePresetIdx: 7 })
  const st = readState()
  assert.equal(st.activePresetIdx, 7, 'GET 应回读 POST 过的光标（7）')
})

test('[4] 对照臂：state 里没有该字段时 GET 不臆造默认值（回读 undefined，前端自行回退 0）', () => {
  writeState({ cardEnabled: true })   // 不带 activePresetIdx
  const st = readState()
  assert.equal(st.activePresetIdx, undefined, '没有持久化过就不该有值 —— 服务端不编造')
})

// ── 5. 前端回填：清理死代码时最容易误删的就是它 ──────────────
test('[5] 面板必须保留「读 state 回填 activePresetIdx」这条链（死代码清理的误删防线）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  // ① 必须真的发这条请求（面板重开不落回第 0 组全靠它）
  assert.ok(/return fetch\('\/api\/tavern\/state'\)\.then\(function \(r\) \{ return r\.json\(\); \}\)\.then\(function \(sdata\) \{/.test(src),
    '回填链的 state 请求被删了：activePresetIdx 会失效（面板每次都落回第 0 组）')
  // ② 必须真的把值写回光标，且越界回退 0
  assert.ok(/state\.activePresetIdx = sdata\.activePresetIdx < state\.presets\.length \? sdata\.activePresetIdx : 0;/.test(src),
    '回填赋值被删了')
  // ③ 只碰光标，不碰预设内容（这条链里不许出现 saveCurrent / refreshYml 之外的写盘动作）
  const seg = src.slice(src.indexOf('return fetch(\'/api/tavern/state\')'), src.indexOf('}).catch(function () {});', src.indexOf('return fetch(\'/api/tavern/state\')')))
  assert.equal(/saveCurrent\(/.test(seg), false, '回填链里不许保存预设内容（只准动光标）')
})

test('[6] 旧版「生效范围」元素不许再被引用（界面已换 chips 版）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  for (const id of ['tavern-allow', 'tavern-ignore', 'tavern-mode-allow', 'tavern-mode-global',
                    'tavern-inject', 'tavern-inject-status', 'tavern-scope-status', 'tavern-nowcwd',
                    'tavern-wb-manager-list', 'tavern-switch-agent']) {
    assert.equal(src.includes("'" + id + "'"), false, '不该再引用旧元素：' + id)
    assert.equal(src.includes('#' + id + "'"), false, '不该再查旧元素：' + id)
  }
  assert.ok(src.includes('tavern-scope2-status'), '现行生效范围卡（chips 版）必须还在')
})
