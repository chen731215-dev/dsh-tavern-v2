// ════════════════════════════════════════════════════════════════
// 护栏：路径「真源 ↔ 镜像」不许脱钩（S2-B2b，v2.7.8）
//
// 背景：lib/index.js 顶层那 9 个路径 `let` 是**唯一真源** —— memory-isolation 测试
// 按行首切片它们拼成独立模块求值，所以搬不走。lib/server/* 要读同一份值，
// 只能靠 lib/server/state.js 的 P 做**单向镜像**，唯一写入点是 syncPaths()。
//
// 这个设计有一个新的失效模式：**有人绕过 syncPaths 直接改路径 ⇒ P 悄悄过期**。
// 用例 ①②③ 就是盯这个；④ 校验键一一对应；⑤ 是反证（判据不是空跑）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
const STATE = fs.readFileSync(path.join(REPO, 'lib', 'server', 'state.js'), 'utf8')
const LINES = INDEX.split(/\r?\n/)

const PATH_NAMES = [
  'DSH_HOME', 'ROOT', 'PRESETS_META', 'SESSION_BINDINGS', 'STATE_PATH',
  'SESSIONS_ROOT', 'TAVERN_DATA_ROOT', 'DSH_SETTINGS_FILE', 'DSH_CREDENTIALS_FILE',
]
const SYNC_CALL = 'syncPaths({ ' + PATH_NAMES.join(', ') + ' })'
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

/** 用「首个顶格 }」定位顶层函数的收尾（这些函数体没有缩进错的括号） */
function fnRange(src, name) {
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('export function ' + name + '('))
  assert.ok(start >= 0, '找不到函数 ' + name)
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === '}') return { start, end: i }
  throw new Error('函数未闭合 ' + name)
}

test('① 镜像调用恰好两处：模块初始化 + bindDshPaths', () => {
  const n = INDEX.split(SYNC_CALL).length - 1
  assert.equal(n, 2, 'syncPaths 调用数应为 2，实际 ' + n + '（多一处=有第二个写入点，镜像会脱钩）')
  const r = fnRange(INDEX, 'bindDshPaths')
  const inside = LINES.map((l, i) => (l.includes(SYNC_CALL) && i >= r.start && i <= r.end ? i + 1 : 0)).filter(Boolean)
  assert.deepEqual(inside.length, 1, 'bindDshPaths 里应有且仅有一处 syncPaths，实际在 L' + inside.join(','))
})

test('② 9 个路径名的赋值只允许出现在 bindDshPaths 里', () => {
  const r = fnRange(INDEX, 'bindDshPaths')
  const offenders = []
  let found = 0
  LINES.forEach((l, i) => {
    if (isComment(l)) return
    for (const name of PATH_NAMES) {
      if (!new RegExp('^\\s*' + name + '\\s*=[^=]').test(l)) continue
      found++
      const inBind = i >= r.start && i <= r.end
      if (!inBind) offenders.push(`L${i + 1}: ${l.trim().slice(0, 90)}`)
    }
  })
  assert.deepEqual(offenders, [], '★ 这些地方绕过 bindDshPaths 直接改路径（会让 P 镜像脱钩）：\n' + offenders.join('\n'))
  // 非空跑防护：判据必须真的扫到了东西（bindDshPaths 里有 9 条赋值）
  assert.ok(found >= 9, '判据空跑：只扫到 ' + found + ' 处赋值（应 ≥9）')
})

test('③ lib/server/* 不许直接改 P，必须走 syncPaths', () => {
  const dir = path.join(REPO, 'lib', 'server')
  const offenders = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'state.js') continue
    fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((l, i) => {
      if (isComment(l)) return
      if (/\bP\.[A-Z_]+\s*=[^=]/.test(l)) offenders.push(`${f}:${i + 1} ${l.trim().slice(0, 80)}`)
    })
  }
  assert.deepEqual(offenders, [], '★ 这些地方直接改了 P（应走 syncPaths）：\n' + offenders.join('\n'))
  // 反证：判据能命中坏样本
  const probe = "  P.ROOT = '/tmp/evil'"
  assert.ok(/\bP\.[A-Z_]+\s*=[^=]/.test(probe), '对照：坏样本必须能被该判据抓住')
})

test('④ state.js 导出的 P 的键，与 index.js 的 9 个路径名一一对应', () => {
  assert.match(STATE, /export const P = \{/, 'state.js 必须导出 P')
  assert.match(STATE, /export function syncPaths\(/, 'state.js 必须导出 syncPaths')
  const block = STATE.slice(STATE.indexOf('export const P = {'))
  const keys = [...block.slice(0, block.indexOf('}')).matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 9, 'P 里只解析出 ' + keys.length + ' 个键（判据可能空跑）')
  assert.deepEqual([...keys].sort(), [...PATH_NAMES].sort(), 'P 的键必须与 index.js 的 9 个路径名完全一致')
})

test('⑤ 反证：绕过 bindDshPaths 改路径的样本必须被判据②抓住', () => {
  const probe = ['function elsewhere() {', "  ROOT = '/tmp/evil'", '}']   // 直接当行数组用
  const r = { start: 0, end: 0 }
  const hits = probe.filter((l, i) => {
    if (isComment(l)) return false
    if (!/^\s*ROOT\s*=[^=]/.test(l)) return false
    return !(i >= r.start && i <= r.end)
  })
  assert.equal(hits.length, 1, '对照：坏样本必须被判据抓住（否则这条护栏是空的）')
})
