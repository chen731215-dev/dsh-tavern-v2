/**
 * HUD 自适应高度：必须是**收敛映射**。
 *
 * 为什么单列一条：`h + 8` 看起来只是「留 8px 余量」，实际把高度反馈回路
 * 变成了发散映射。整页状态栏卡普遍是「撑满视口」布局，卡上报的
 * `documentElement.scrollHeight` 会被视口顶满、恒等于当前 iframe 高度，
 * 于是每轮 +8px 无限上涨 —— 界面表现是消息下方一片不断变高的空白。
 *
 * 这条测试用**纯算术仿真**钉住映射的不动点性质，不依赖浏览器。
 *
 * 运行：node --test tests/hud-height-convergence.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const BUNDLE = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  .replace(/\r\n/g, '\n')

const HUD_MIN_H = 120
const HUD_MAX_H = 4000

/** 抠出 `if (d.op === 'height') { … }` 整块（大括号配平，跳过字符串与行注释）。 */
function extractHeightBranch(src) {
  const anchor = "if (d.op === 'height') {"
  const s0 = src.indexOf(anchor)
  if (s0 < 0) throw new Error('找不到 height 分支')
  let depth = 0
  for (let k = src.indexOf('{', s0); k < src.length; k++) {
    const c = src[k]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      k++
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++ }
      continue
    }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(s0, k + 1) }
  }
  throw new Error('height 分支大括号不配平')
}

/**
 * 把真实的分支代码装进沙箱，喂「上报高度」序列，返回每次设置后的高度。
 *
 * 假 frame 的 `style.height` 是一个带 getter 的对象：设进去就记下，
 * `getBoundingClientRect()` 也读同一个值 —— 与真实 DOM 的语义一致
 * （宿主设完高度，下一轮读到的就是这个高度）。
 *
 * @param {Array<number>} reported 每一轮卡上报的 h
 * @param {number} startH 初始高度
 * @returns {number[]} 每次处理之后的高度
 */
function runBranch(reported, startH) {
  const branch = extractHeightBranch(BUNDLE)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace("if (d.op === 'height') {", 'if (true) {')
    // 抽出的分支末尾有 `return;`（真实代码后面还有 ready/context 分支），去掉它
    .replace(/return;\s*\}\s*$/, '}')

  let cur = startH
  const heights = []
  const frame = {
    getBoundingClientRect: () => ({ height: cur }),
    style: {},
  }
  Object.defineProperty(frame.style, 'height', {
    configurable: true,
    get: () => cur + 'px',
    set: (v) => { cur = parseFloat(v) },
  })
  const rec = { shell: 'inline', steadyH: 0, frame }
  const box = { HUD_MIN_H, HUD_MAX_H, rec, d: { h: 0 }, Number, Math, cur: () => cur }
  vm.createContext(box)
  vm.runInContext(`
    this.__step = function (h) {
      d.h = h;
      ${branch}
    };
  `, box)

  for (const h of reported) {
    box.__step(h)
    heights.push(cur)
  }
  return heights
}

test('① 撑满视口型：上报值恒等于当前高度 ⇒ 必须收敛（旧实现会无限上涨）', () => {
  // 卡上报 = 当前 iframe 高度（实测形态：scrollHeight 被视口顶满）
  let height = 420
  const trace = []
  for (let i = 0; i < 40; i++) {
    const out = runBranch([height], height)
    height = out[0]
    trace.push(height)
  }
  assert.equal(trace[0], 420, '第一轮就该定在 420（ceil(420) = 420，不加伪 padding）')
  assert.equal(trace[trace.length - 1], 420, '★ 40 轮之后仍是 420 —— 不许上涨')
  const grew = trace.filter((v, i) => i > 0 && v > trace[i - 1]).length
  assert.equal(grew, 0, '★ 一次上涨都不许有（上涨 = 界面上的一片空白在长高）')
})

test('② 长状态栏：内容 2600px ⇒ 一次到位，且不许被压扁', () => {
  let height = 420
  const trace = []
  for (let i = 0; i < 20; i++) {
    const reported = Math.max(height, 2600)   // 内容比视口高时，上报值 = 内容高
    const out = runBranch([reported], height)
    height = out[0]
    trace.push(height)
  }
  assert.equal(trace[0], 2600, '第一轮就应到内容高度')
  assert.equal(trace[trace.length - 1], 2600, '★ 不许继续上涨')
})

test('③ 连续微增：内容真变长时必须跟随，不许被"锁定"卡死', () => {
  let height = 500
  const trace = []
  for (const content of [500, 500, 520, 540, 560, 560, 560]) {
    const out = runBranch([Math.max(height, content)], height)
    height = out[0]
    trace.push(height)
  }
  assert.equal(trace[trace.length - 1], 560, '★ 内容长到 560 时高度必须跟到 560')
})

test('④ 边界：h<=80 忽略；小高度抬到下限；超大夹到上限', () => {
  const ignore = runBranch([50], 420)
  assert.equal(ignore[0], 420, 'h <= 80 整条忽略，高度一动不动')

  const low = runBranch([90], 420)
  assert.equal(low[0], HUD_MIN_H, 'h=90 高于 80 门槛 ⇒ 会被夹到 HUD_MIN_H（这是既有行为，别动）')

  const huge = runBranch([99999], 420)
  assert.equal(huge[0], HUD_MAX_H, '超过上限要夹住（卡可能报 100000）')
})

test('⑤ 反证：旧公式 `h + 8` 在这套仿真下必须上涨（否则测的不是它）', () => {
  const oldNext = (h, cur) => Math.min(Math.max(h + 8, HUD_MIN_H), HUD_MAX_H)
  let height = 420
  const trace = []
  for (let i = 0; i < 40; i++) {
    height = oldNext(height, height)
    trace.push(height)
  }
  const grew = trace.filter((v, i) => i > 0 && v > trace[i - 1]).length
  assert.equal(grew, 39, '★ 旧实现必须每轮都涨 —— 这正是被修掉的那个 bug')
  assert.ok(trace[trace.length - 1] > 420, '旧实现最终高度必然高于起点')
})
