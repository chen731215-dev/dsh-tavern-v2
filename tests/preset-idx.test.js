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
