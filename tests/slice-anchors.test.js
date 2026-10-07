/**
 * 切片锚点护栏：把 AGENTS.md §5.1 那份「不许搬出 lib/index.js」的名单**变成可执行判据**。
 *
 * 为什么需要它（S2-C2 动手前专门加的）：
 *   `lib/index.js` 里有几个函数会被测试**按行切片**、拼成一个独立模块求值
 *   （`memory-isolation` / `session-storage-migration` / `greeting-seed`）。
 *   一旦有人把其中任何一个搬进 `lib/server/`，那个独立模块里就是 `ReferenceError` ——
 *   而错误信息离「你搬错了哪个函数」很远，排查成本高。
 *   另一个更隐蔽的形态：`function X(` 一旦不再**顶格**（比如被包进 namespace 对象里），
 *   `sliceFn` 就再也切不到，测试会以「找不到函数」的形式炸掉。
 *
 *   所以这里把两件事钉死：
 *     ① 所有被 `sliceFn('X')` 点名的 X，必须以**顶格** `function X(` 的形式留在 lib/index.js；
 *     ② `apply(ctx)` 里几处被**字面量子串**锚住的位置不许消失/改名。
 *
 * 判据写成纯函数，配反证组（喂坏样本必须报错）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = 'lib/index.js'

export const TEST_SOURCES = fs
  .readdirSync(path.join(REPO, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => fs.readFileSync(path.join(REPO, 'tests', f), 'utf8'))

/** 从测试源码里抽出所有 sliceFn 的目标名 */
export function sliceTargets(sources) {
  const out = new Set()
  for (const raw of sources) {
    // 先剥注释：本文件/说明性注释里会出现「sliceFn(……)」这种字样，
    // 不过滤的话会把自己注释里的示例当成真实锚点（这个坑实际踩过一次）。
    const s = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    }).join('\n')
    const re = /sliceFn\(\s*'([A-Za-z_$][\w$]*)'/g
    let m
    while ((m = re.exec(s))) out.add(m[1])
  }
  return [...out].sort()
}

/** src 里哪些目标名没有以**顶格** `function X(` 声明 */
export function missingTargets(names, src) {
  return names.filter((n) => !new RegExp('^function ' + n + '\\(', 'm').test(src))
}

/** §5.1 后三行：apply(ctx) 内部被字面量锚住的位置（删/改都会让测试红） */
export const APPLY_ANCHORS = [
  'isTavernSession(',
  'decideInjectionScope(',
  'order: -1',
  "flushPromptStats(); return ''",
  'sectionSizes.nsfw',
  'writeInjectObserveRecord',
  'const targetSid = lastSessionId',
]

/** src 里缺失的锚点子串 */
export function missingAnchors(anchors, src) {
  return anchors.filter((a) => !src.includes(a))
}

const SERVER_SRC = fs.readFileSync(path.join(REPO, SERVER), 'utf8')

// ════════════════════════════════════════════════════════════════
// ① 被切片的函数必须以顶格 function 留在 lib/index.js
// ════════════════════════════════════════════════════════════════

test('① 被 `sliceFn` 点名的函数必须顶格留在 lib/index.js', () => {
  const names = sliceTargets(TEST_SOURCES)
  // 非空跑：判据本身必须抓到东西
  assert.ok(names.length >= 8, '只找到 ' + names.length + ' 个 sliceFn 目标 —— 判据空跑或抽取方式变了')
  const missing = missingTargets(names, SERVER_SRC)
  assert.deepEqual(
    missing,
    [],
    '★ 这些函数被测试按源码切片，却不再以顶格 `function X(` 出现在 ' + SERVER + ' 里：\n  ' +
      missing.join('\n  ') +
      '\n（搬进 lib/server/ 会让切片出来的独立模块 ReferenceError；'
      + '不再顶格会让 sliceFn 直接切不到。名单见 AGENTS.md §5.1）',
  )
})

test('①-b 反证：判据必须能报出「函数被搬走 / 不再顶格」', () => {
  const good = 'function readMemory(sid) {\n  return 1\n}'
  assert.deepEqual(missingTargets(['readMemory'], good), [])
  // 搬走 ⇒ 找不到
  assert.deepEqual(missingTargets(['readMemory'], 'function other() {}'), ['readMemory'])
  // 被包进对象里 ⇒ 不再顶格
  assert.deepEqual(missingTargets(['readMemory'], 'const ns = {\n  function readMemory(sid) {}\n}'), ['readMemory'])
  // 缩进一格也算不再顶格
  assert.deepEqual(missingTargets(['readMemory'], '  function readMemory(sid) {}'), ['readMemory'])
})

// ════════════════════════════════════════════════════════════════
// ② apply(ctx) 内部被字面量锚住的位置
// ════════════════════════════════════════════════════════════════

test('② apply(ctx) 里被字面量锚住的位置不许消失', () => {
  const missing = missingAnchors(APPLY_ANCHORS, SERVER_SRC)
  assert.deepEqual(
    missing,
    [],
    '★ 这些子串被测试直接锚住，不能再出现：\n  ' + missing.join('\n  ') + '\n（见 AGENTS.md §5.1 后三行）',
  )
})

test('②-b 反证：锚点判据必须能报出缺失', () => {
  assert.deepEqual(missingAnchors(['order: -1'], 'const x = 1\norder: -1'), [])
  assert.deepEqual(missingAnchors(['order: -1'], 'const x = 1'), ['order: -1'])
})

// ════════════════════════════════════════════════════════════════
// ③ §5.1 的表格必须与判据一致（名单漂了就报）
// ════════════════════════════════════════════════════════════════

test('③ AGENTS.md §5.1 必须点名所有被切片的函数（名单不许落后于事实）', () => {
  const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8')
  const names = sliceTargets(TEST_SOURCES)
  const undocumented = names.filter((n) => !agents.includes(n))
  assert.deepEqual(
    undocumented,
    [],
    '★ 这些函数被测试切片钉住，但 AGENTS.md §5.1 没点名：\n  ' + undocumented.join('\n  '),
  )
})
