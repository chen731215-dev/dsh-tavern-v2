#!/usr/bin/env node
/**
 * 逐个跑测试文件（`node --test <file>`），最后给一张汇总表。
 *
 * 为什么单独要这个：`npm test` 是一条 `&&` 长链，**第一个红项就把后面的全跳过**，
 * 于是"还有几个文件是红的"看不出来；而且长链里的失败信息容易淹在输出里。
 * 这里每个文件独立进程、独立判红，最后按文件给 pass/fail 与总数。
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
  const pass = Number((text.match(/^ℹ pass (\d+)$/m) || [])[1] || 0)
  const fail = Number((text.match(/^ℹ fail (\d+)$/m) || [])[1] || 0)
  totalPass += pass
  totalFail += fail
  const ok = out.status === 0 && fail === 0
  if (!ok) failures.push(f)
  console.log((ok ? '✅ ' : '❌ ') + f.padEnd(38) + 'pass=' + String(pass).padStart(4) + '  fail=' + fail)
  if (!ok) {
    // 只把失败行拉出来，避免整段输出淹没汇总
    const lines = text.split('\n').filter((l) => /✖|AssertionError|Error:/.test(l)).slice(0, 6)
    for (const l of lines) console.log('     ' + l.trim().slice(0, 160))
  }
}
console.log('\n──────────────────────────────────────────────')
console.log('合计 pass=' + totalPass + '  fail=' + totalFail + '  文件 ' + files.length + ' 个')
if (failures.length) {
  console.error('红项文件：' + failures.join(' / '))
  process.exit(1)
}
console.log('全部通过 ✅')
