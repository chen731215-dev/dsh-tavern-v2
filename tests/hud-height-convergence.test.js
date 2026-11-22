/**
 * HUD 高度映射的**收敛性**仿真（issue #18）。
 *
 * 病症：整页状态栏卡的消息下方有一片空白，**每秒长约一行**，一路涨到上限。
 *
 * 根因不是卡报错了，而是宿主侧的映射没有**不动点**：
 *   `h + 8` 里那 8px 本意是「留余量避免出滚动条」，但整页卡是「内容撑满视口」布局，
 *   `documentElement.scrollHeight` 会被视口顶满 ⇒ 卡上报的 h 恒等于当前 iframe 高度
 *   ⇒ 宿主设成 h + 8 ⇒ 下一轮又报新高度 ⇒ 再 + 8 … 每轮稳定涨 8px。
 *
 * 这个文件不复现浏览器，只把**从 bundle 里逐字抽出的那段高度分支代码**跑起来，
 * 用几种「自指型」的卡模型驱动它。判据演进过三轮（每轮都实测过，别再退回前两版）：
 *   ① 只判 |want − cur| ≤ 1        ⇒ h = cur + 8（body 默认 8px 边距）仍每轮涨 8px；
 *   ② 改判「want 不再变大就锁」     ⇒ 无效，cur 在涨 want 跟着涨，永远"还在长"；
 *   ③ 定版：看**偏移量** delta = want − cur，稳定小常数 ⇒ 判自指型并锁定。
 *
 * 钉住的性质：
 *   ① 收敛：h = cur + k（k = 0/1/2/3/8）全部停住；
 *   ② 不压扁：长状态栏（2600px）一次到位；
 *   ③ 可跟随：内容真变长（每拍 +n）继续跟，不被裁死；
 *   ④ 结构性增长：锁定后 delta > 40 必须照做（那是真的插进了内容）；
 *   ⑤ 收缩：要变矮时立即采纳；
 *   ⑥ 浮窗：完全不参与；
 *   ⑦ **反例对照臂**：同一套断言对旧公式 `h + 8` 必须失败。
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

const HUD_MIN_H = Number(/var HUD_MIN_H = (\d+)/.exec(BUNDLE)?.[1])
const HUD_MAX_H = Number(/var HUD_MAX_H = (\d+)/.exec(BUNDLE)?.[1])
assert.ok(Number.isFinite(HUD_MIN_H) && Number.isFinite(HUD_MAX_H), '取不到 HUD 高度上下限')

/**
 * 把 bundle 里 `if (d.op === 'height') { … }` 那一段**逐字**抽出来，包成可调用函数。
 *
 * 为什么逐字抽而不是另写一份：另写一份只是在测"我抄得对不对"，测不到真实代码。
 * @returns {(rec:object, h:number)=>void}
 */
function loadHeightBranch() {
  const start = BUNDLE.indexOf("if (d.op === 'height') {")
  assert.ok(start > 0, '找不到高度分支（改名/搬家时这个测试要一起改）')

  let depth = 0
  let end = -1
  for (let k = BUNDLE.indexOf('{', start); k < BUNDLE.length; k++) {
    const c = BUNDLE[k]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      k++
      while (k < BUNDLE.length && BUNDLE[k] !== q) { if (BUNDLE[k] === '\\') k++; k++ }
      continue
    }
    if (c === '/' && BUNDLE[k + 1] === '/') { while (k < BUNDLE.length && BUNDLE[k] !== '\n') k++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  assert.ok(end > start, '高度分支大括号不闭合')

  const branch = BUNDLE.slice(start, end)
  const body = branch.slice(branch.indexOf('{') + 1, branch.lastIndexOf('}'))

  // 分支里引用 HUD_MIN_H / HUD_MAX_H（闭包常量），沙箱里补上同名变量即可
  const box = { Math, Number, isFinite, HUD_MIN_H, HUD_MAX_H }
  vm.createContext(box)
  vm.runInContext('function step(rec, d){' + body + '}\nthis.__step = step', box)
  return (rec, h) => box.__step(rec, { op: 'height', h })
}

/** 旧实现的等价函数 —— 反例对照臂，证明这些断言能红。 */
function oldStep(rec, h) {
  if (rec.shell === 'float') return
  if (h > 80) rec.frame.style.height = Math.min(Math.max(h + 8, HUD_MIN_H), HUD_MAX_H) + 'px'
}

function makeRec(startH) {
  return {
    shell: 'inline',
    steadyH: 0,
    lastDelta: 0,
    frame: {
      style: { height: startH + 'px' },
      getBoundingClientRect() { return { height: parseFloat(this.style.height) } },
    },
  }
}
const H = (rec) => parseFloat(rec.frame.style.height)

/** 跑 n 轮「卡量出 h → 宿主应用」。 */
function run(step, rec, contentFn, rounds) {
  const hist = []
  for (let i = 0; i < rounds; i++) {
    step(rec, contentFn(H(rec)))
    hist.push(H(rec))
  }
  return hist
}

test('① 收敛：自指型上报（h = cur + k）全部停住', () => {
  const step = loadHeightBranch()
  // k = 0（视口类型）、1、2、3、8（body 默认 8px 边距类型）都必须收敛。
  //   ★ 只判 |want-cur| <= 1 的旧实现会让 k>=2 全部发散 —— 这正是复核抓到的漏口。
  for (const k of [0, 1, 2, 3, 8]) {
    const rec = makeRec(420)
    const hist = run(step, rec, (cur) => cur + k, 40)
    const tail = hist.slice(-10)
    assert.equal(
      new Set(tail).size, 1,
      `★ h = cur + ${k} 必须收敛（末 10 轮不再变化），实际：${tail.join(', ')}`
    )
    assert.ok(
      hist[hist.length - 1] <= 420 + Math.max(k, 1) + 40,
      `★ h = cur + ${k} 收敛后不许离起始值太远，实际 ${hist[hist.length - 1]}`
    )
  }

  // 反例对照臂：旧公式必须一路涨（否则上面的断言是空转）
  for (const k of [8]) {
    const rec = makeRec(420)
    const before = run(oldStep, rec, (cur) => cur + k, 40)
    assert.ok(
      before[before.length - 1] > before[0] + 100,
      `★ 对照臂：旧公式 h + 8 必须明显上涨，实际 ${before[0]} → ${before[before.length - 1]}`
    )
  }
})

test('② 不压扁：长状态栏（2600px）一次到位', () => {
  const step = loadHeightBranch()
  const rec = makeRec(420)
  step(rec, 2600)
  assert.equal(H(rec), 2600, '★ 内容 2600px 必须落到位（不许被"锁定"卡在 420）')
})

test('③ 可跟随：内容真变长会继续跟', () => {
  const step = loadHeightBranch()
  for (const growth of [1, 2, 3, 8]) {
    const rec = makeRec(420)
    let content = 420
    run(step, rec, () => { content += growth; return Math.max(content, H(rec)) }, 12)
    assert.ok(
      Math.abs(H(rec) - content) <= 1,
      `★ 内容每拍 +${growth} 必须跟上：content=${content} 实际 iframe=${H(rec)}`
    )
  }
})

test('④ 结构性增长：锁定后 delta > 40 必须照做', () => {
  const step = loadHeightBranch()
  const rec = makeRec(420)
  // 先进入锁定态
  run(step, rec, (cur) => cur, 6)
  const locked = H(rec)
  assert.equal(new Set(run(step, rec, (cur) => cur, 4)).size, 1, '前置：应该已锁定')

  step(rec, locked + 300)
  assert.equal(
    H(rec), locked + 300,
    '★ 锁定后突然多 300px 内容必须采纳（否则真实内容会被永久裁掉）'
  )
})

test('⑤ 收缩：变矮时立即采纳', () => {
  const step = loadHeightBranch()
  const rec = makeRec(900)
  step(rec, 300)
  assert.equal(H(rec), 300, '★ 900 → 300 的结构性收缩必须采纳（否则状态栏下方留白）')
})

test('⑥ 浮窗形态完全不参与（高度由外壳决定）', () => {
  const step = loadHeightBranch()
  const rec = makeRec(300)
  rec.shell = 'float'
  step(rec, 2000)
  assert.equal(H(rec), 300, '★ 浮窗里高度不许被卡的消息改')
})

test('⑦ 夹取：畸形高度不许撑爆页面，也不许压到下限以下', () => {
  const step = loadHeightBranch()
  const rec = makeRec(420)
  step(rec, 100000)
  assert.equal(H(rec), HUD_MAX_H, '超上限要夹到 HUD_MAX_H')

  const rec2 = makeRec(420)
  step(rec2, 85)
  assert.ok(H(rec2) >= HUD_MIN_H, '低于下限要夹到 HUD_MIN_H')
})
