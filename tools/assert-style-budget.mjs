#!/usr/bin/env node
/**
 * 样式预算棘轮（style budget ratchet）
 *
 * 为什么需要它：`lib/client.manager.bundle.js` 是**单文件直发**的界面代码（没有构建步骤，
 * 这个 bundle 就是源码）。在这种约束下，"UI 越来越脏"没法靠重构一次解决，只能靠**可测量的棘轮**：
 * 把当前的"溃烂指标"记进 `tools/style-budget.json`，以后任何一次提交**只许降不许升**。
 * 想加新颜色/新内联样式？那就在同一个 PR 里显式上调预算 —— 让 review 看见，而不是无声堆积。
 *
 * 用法：
 *   node tools/assert-style-budget.mjs            # 校验（超出即退出码 1）
 *   node tools/assert-style-budget.mjs --update   # 用当前实测值更新预算（谨慎，应在 PR 里说明理由）
 *   node tools/assert-style-budget.mjs --json     # 只打印实测值
 *
 * 指标定义（都在**非注释行**上统计，注释里写示例不算）：
 *   inlineStyleAttr         markup 字符串里的 `style="` 内联样式数
 *   inlineHandlerAttr       markup 字符串里的 `on<event>="` 内联事件属性数（硬规则：必须为 0）
 *   inlineHandlerAttrServer **服务端** lib/index.js 自渲染 HTML 的内联事件数（硬规则：必须为 0）
 *   bareHex                 裸十六进制颜色字面量（#rgb / #rrggbb / #rrggbbaa）
 *   bareRgba                rgb()/rgba() 字面量
 *   cssTextAssign           `.cssText =` 赋值次数
 *   important               `!important` 次数（硬规则：必须为 0）
 *   distinctColorLiterals   不同颜色字面量**种类**（颜色漂移指标）
 *   distinctFontSizes       不同 `font-size` 取值种类
 *   distinctRadii           不同 `border-radius` 取值种类
 *   distinctPaddings        不同 `padding` 取值种类
 *   distinctZIndex          不同 `z-index` 取值种类
 *   styleTags               注入 `<style>` 块的地方数（全局样式泄漏面）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..')
export const CLIENT = path.join(REPO, 'lib', 'client.manager.bundle.js')
export const BUDGET_FILE = path.join(HERE, 'style-budget.json')

/** 去掉纯注释行（`//` 或块注释续行），让指标不被说明文字污染。 */
export function codeLines(src) {
  return String(src).split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
}

const uniq = (arr) => [...new Set(arr)].length
const count = (lines, re) => lines.reduce((n, l) => n + (l.match(re) || []).length, 0)

/** 对一段源码测出全部指标（导出让测试直接喂合成样本，证明判据不是空跑）。 */
export function measure(src) {
  const lines = codeLines(src)
  const hexes = lines.flatMap((l) => l.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
  const rgbas = lines.flatMap((l) => l.match(/\brgba?\(/g) || [])
  const pick = (re) => {
    const out = []
    for (const l of lines) {
      const m = l.match(re)
      if (m) out.push(m[1].trim())
    }
    return out
  }
  return {
    inlineStyleAttr: count(lines, /style="/g),
    inlineHandlerAttr: count(lines, /\son[a-z]+\s*=\s*"/g),
    bareHex: hexes.length,
    bareRgba: rgbas.length,
    cssTextAssign: count(lines, /\.cssText\s*=/g),
    important: count(lines, /!important/g),
    distinctColorLiterals: uniq([...hexes, ...rgbas]),
    distinctFontSizes: uniq(pick(/font-size:\s*([^;"']+)/)),
    distinctRadii: uniq(pick(/border-radius:\s*([^;"']+)/)),
    distinctPaddings: uniq(pick(/(?:^|[^-])padding:\s*([^;"']+)/)),
    distinctZIndex: uniq(pick(/z-index:\s*(-?\d+)/)),
    styleTags: count(lines, /<style/g),
  }
}

/**
 * 硬规则：这些指标任何情况下都不允许 > 0。
 * `inlineHandlerAttr`（markup 里的 on<event>="…"）已于 v2.7.1 清零（5 处 →
 * 统一改为容器上的事件委托），因此**升级为硬规则**：内联事件属性不许再出现，
 * 新代码要做点击行为就在容器上做委托。
 */
export const HARD_ZERO = ['important', 'inlineHandlerAttr', 'inlineHandlerAttrServer']

/**
 * 服务端自渲染页（`lib/index.js` 里的 HTML 字符串）也必须零内联事件 —— v2.7.1 前这条漏检：
 * 设置页曾有 `onclick="saveWin()"` / `onclick="save()"` / `onchange="toggle(...)"` 三处。
 *
 * ★ task-14/第四块：**扫描面必须跟着搬迁走**。设置页（自渲染 HTML）随 `/api/tavern/settings`
 *   路由搬进了 `lib/server/routes.js` ⇒ 若仍只扫 `lib/index.js`，这条**硬 0 规则**会变成**真空**：
 *   那个文件里已经没有自渲染 HTML 了，routes.js 里怎么写内联事件它都恒为 0（"收窄却全绿"）。
 *   所以扫描面 = `lib/index.js` + `lib/server/*.js`，并对文件数设下限（挡住"把面删掉"）。
 */
export const SERVER_FILE = path.join(REPO, 'lib', 'index.js')   // 单文件口径（历史调用点保留）
export const SERVER_DIR = path.join(REPO, 'lib', 'server')
export const MIN_SERVER_FILES = 10

/** 服务端源码的扫描面：`lib/index.js` + `lib/server/*.js`（排序、仓库相对）。 */
export function serverSourceFiles() {
  const out = [SERVER_FILE]
  for (const f of fs.readdirSync(SERVER_DIR).sort()) if (f.endsWith('.js')) out.push(path.join(SERVER_DIR, f))
  return out
}

export function measureServer(src) {
  return { inlineHandlerAttrServer: count(codeLines(src), /\son[a-z]+\s*=\s*"/g) }
}

/** 跨整片扫描面求和（任一文件命中即计入）。 */
export function measureServerFiles(files) {
  return { inlineHandlerAttrServer: files.reduce((n, f) => n + measureServer(fs.readFileSync(f, 'utf8')).inlineHandlerAttrServer, 0) }
}

export function readBudget() {
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
}

/**
 * 比较实测值与预算。
 * @returns {{ increased: Array, decreased: Array, hardZeroViolations: Array }}
 */
export function compare(actual, budget) {
  const increased = []
  const decreased = []
  for (const k of Object.keys(budget)) {
    if (typeof budget[k] !== 'number' || !(k in actual)) continue
    if (actual[k] > budget[k]) increased.push({ key: k, budget: budget[k], actual: actual[k] })
    else if (actual[k] < budget[k]) decreased.push({ key: k, budget: budget[k], actual: actual[k] })
  }
  const hardZeroViolations = HARD_ZERO.filter((k) => (actual[k] || 0) > 0).map((k) => ({ key: k, actual: actual[k] }))
  return { increased, decreased, hardZeroViolations }
}

// ── CLI ────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const actual = measure(src)
  const serverFiles = serverSourceFiles()
  if (process.argv.includes('--json')) {
    actual.inlineHandlerAttrServer = measureServerFiles(serverFiles).inlineHandlerAttrServer
    console.log(JSON.stringify(actual, null, 2)); process.exit(0)
  }
  if (serverFiles.length < MIN_SERVER_FILES) {
    console.error('❌ 服务端扫描面只剩 ' + serverFiles.length + ' 个文件（下限 ' + MIN_SERVER_FILES + '）—— 硬 0 规则会变成真空')
    process.exit(1)
  }
  actual.inlineHandlerAttrServer = measureServerFiles(serverFiles).inlineHandlerAttrServer
  if (process.argv.includes('--update')) {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(actual, null, 2) + '\n', 'utf8')
    console.log('已更新预算 ' + path.relative(REPO, BUDGET_FILE))
    for (const [k, v] of Object.entries(actual)) console.log('  ' + k.padEnd(22) + v)
    process.exit(0)
  }
  const budget = readBudget()
  const { increased, decreased, hardZeroViolations } = compare(actual, budget)
  console.log('样式预算校验（实测 / 预算）')
  for (const k of Object.keys(budget)) {
    if (typeof budget[k] !== 'number') continue     // 例如 `_note`：人读的说明，不参与棘轮
    const a = actual[k]
    const b = budget[k]
    const flag = a > b ? '❌ 超标' : a < b ? '↓ 可下调' : '  ok'
    console.log('  ' + k.padEnd(22) + String(a).padStart(6) + ' / ' + String(b).padStart(6) + '   ' + flag)
  }
  let fail = false
  if (hardZeroViolations.length) {
    fail = true
    for (const v of hardZeroViolations) console.error('❌ 硬规则被打破：' + v.key + ' = ' + v.actual + '（必须为 0）')
  }
  if (increased.length) {
    fail = true
    console.error('\n❌ 以下指标超出预算（要么改回，要么在同一次提交里解释理由并 --update）：')
    for (const i of increased) console.error('   ' + i.key + '：预算 ' + i.budget + ' → 实测 ' + i.actual)
  }
  if (decreased.length) {
    console.log('\n↓ 这些指标比预算更低了，可以顺手下调预算（跑 --update）：')
    for (const d of decreased) console.log('   ' + d.key + '：' + d.budget + ' → ' + d.actual)
  }
  process.exit(fail ? 1 : 0)
}
