#!/usr/bin/env node
/**
 * 逐个跑测试文件（`node --test <file>`），最后给一张汇总表。
 * **这就是 `npm test`**（2.7.11 起）。
 *
 * 为什么用它当 `npm test`：
 *   1. 原来 `npm test` 是一条**手抄的 `&&` 长链**，2026-10-08 实测漏掉 3 个文件
 *      （`render-escape.test.js` 安全回归 / `nsfw-slot` / `server-state-paths`），
 *      于是「npm test 全绿」并不代表安全不变量真的跑了。这里改成扫目录，
 *      清单由文件系统决定，新增测试文件自动被纳入。
 *   2. 长链**第一个红项就把后面全跳过**，「还有几个文件是红的」看不出来；
 *      而且失败信息容易淹在输出里。这里每个文件独立进程、独立判红。
 *
 * 用法：node tools/run-each-test.mjs            # 全部
 *       node tools/run-each-test.mjs panel      # 只跑文件名含 panel 的
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TEST_DIR = path.join(REPO, 'tests')
const filter = process.argv[2] || ''

const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).filter((f) => f.includes(filter)).sort()
if (!files.length) { console.error('没找到测试文件（filter=' + JSON.stringify(filter) + '）'); process.exit(1) }

let totalPass = 0
let totalFail = 0
let totalSkip = 0
const failures = []
console.log('逐个跑 ' + files.length + ' 个测试文件…\n')
for (const f of files) {
  const out = spawnSync(process.execPath, ['--test', path.join(TEST_DIR, f)], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env },   // 保留 DSH_ASAR 等（cordis-mount 需要）
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = String(out.stdout || '') + String(out.stderr || '')
  // ★ 两种报告器都要认：node 的测试摘要格式随版本/reporter 变
  //   （tap `# pass N` / spec `ℹ pass N`）。只认一种会得到「全部 0」的假读数 ——
  //   而「全部 0」在旧判据下等于**全绿**，这才是最危险的一档。
  const num = (k) => Number((text.match(new RegExp('^(?:ℹ|#) ' + k + ' (\\d+)$', 'm')) || [])[1] || 0)
  const pass = num('pass')
  const fail = num('fail')
  const skipped = num('skipped')
  totalPass += pass
  totalFail += fail
  totalSkip += skipped
  // ★ 空跑防护：pass=0 且 fail=0 且 skipped=0 ⇒ 这个文件**一条断言都没跑**
  //   （文件被清空 / 断言被注释掉 / 子进程压根没起来）。
  //   注意 skipped>0 **不算**空跑 —— 例如 cordis-mount 在没有 DSH app.asar 的环境
  //   会整批 skip，那是合法跳过，不该判红。
  const vacuous = pass === 0 && fail === 0 && skipped === 0
  const ok = out.status === 0 && fail === 0 && !vacuous
  if (!ok) failures.push(f)
  console.log((ok ? '✅ ' : vacuous ? '❔ ' : '❌ ') + f.padEnd(38) + 'pass=' + String(pass).padStart(4) + '  fail=' + fail +
    (skipped ? '  skip=' + skipped : '') + (vacuous ? '   ← 0 项断言（空跑，判失败）' : ''))
  if (!ok) {
    if (vacuous) {
      // ★ 空跑时「最后几行」才是诊断信息：崩溃/子进程没起来时，错误在结尾而不在 ✖ 行里。
      //   （复核意见：只打 ✖|AssertionError|Error: 会让「崩溃」和「真空跑」分不开。）
      console.log('     ↓ 子进程输出末尾（判断是崩溃还是真的没跑）:')
      for (const l of text.split('\n').slice(-5)) console.log('       ' + l.trim().slice(0, 160))
    } else {
      // 只把失败行拉出来，避免整段输出淹没汇总
      const lines = text.split('\n').filter((l) => /✖|AssertionError|Error:/.test(l)).slice(0, 6)
      for (const l of lines) console.log('     ' + l.trim().slice(0, 160))
    }
  }
}
console.log('\n──────────────────────────────────────────────')
console.log('合计 pass=' + totalPass + '  fail=' + totalFail + '  skipped=' + totalSkip + '  文件 ' + files.length + ' 个')
if (totalPass === 0) {
  console.error('❌ 合计 0 项断言 —— 判据空跑，不是通过')
  process.exit(1)
}
if (failures.length) {
  console.error('红项文件：' + failures.join(' / '))
  process.exit(1)
}
console.log('全部通过 ✅')
