#!/usr/bin/env node
/**
 * golden 的**来源**验证：证明 `tests/fixtures/golden-prompt.json` 确实是在
 * **重构前那一版**上生成的，而不是在新版上"自己拍自己"。
 *
 * 为什么必须有这一步：golden 差分是「重构没改行为」这套证据的**命门** ——
 * 如果快照其实来自当前版本，那它退化成"自己跟自己比"，再绿也不能说明任何事。
 * 而快照文件本身**没有来源戳记**（2026-10-08 实测：0 个元信息键），
 * 所以"在 a816afd 上生成"此前只能靠**自述**。本脚本把它变成**机器可查**：
 *
 *   1. 建一个 `OLD_SHA` 的干净 worktree（本机工作树是 LF、干净检出是 CRLF，两态结论可能不同）
 *   2. 把**当前版**的 golden 测试拷进去（同一套采集逻辑），用 `UPDATE_GOLDEN=1` 重新生成
 *   3. 与仓库里的 fixture **逐字节比**（只归一化 CRLF）—— 不一致即退出码 1
 *
 * 复核方 2026-10-08 手工跑过一次，结果**逐字节一致（3424 字节）**；本脚本把那次的结论固化。
 *
 * 用法：node tools/check-golden-origin.mjs        # exit 0 = 来源可信
 * 注意：需要**完整历史**（CI 里 checkout 必须 fetch-depth: 0）。浅克隆会**响亮失败**，
 *       不做"取不到就跳过"—— 那正是本仓最反对的静默变绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 冻结的基准提交：golden 必须自它生成。改这个值 = 声明换了基准，必须在提交信息里说明。 */
export const OLD_SHA = 'a816afd'
export const TEST_REL = 'tests/golden-prompt.test.js'
export const FIXTURE_REL = 'tests/fixtures/golden-prompt.json'

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, ...opts })
const norm = (s) => String(s).replace(/\r\n/g, '\n')

function fail(msg, extra = '') {
  // ★ 先清理再退出：process.exit 不展开栈、会跳过 finally（第二轮复核在克隆里实测到残留 worktree）。
  try { doCleanup() } catch { /* 清理失败不掩盖原错 */ }
  console.error('❌ ' + msg)
  if (extra) console.error(extra.split('\n').slice(-12).map((l) => '   ' + l).join('\n'))
  process.exit(1)
}

// ① 前置：历史必须是完整的（浅克隆会让 OLD_SHA 不存在）
const shallow = run('git', ['rev-parse', '--is-shallow-repository'])
if (shallow.status === 0 && String(shallow.stdout).trim() === 'true') {
  fail('当前是**浅克隆**（shallow），历史里没有 ' + OLD_SHA + '。',
    'CI 里请给 actions/checkout 加 `with: { fetch-depth: 0 }`；本地请 `git fetch --unshallow`。')
}
const have = run('git', ['cat-file', '-e', OLD_SHA + '^{commit}'])
if (have.status !== 0) fail('仓库里没有基准提交 ' + OLD_SHA + '（历史被截断？）')

const fixture = fs.readFileSync(path.join(REPO, FIXTURE_REL))
const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-origin-'))
fs.rmdirSync(wt)   // git worktree add 要求目标不存在
let added = false
try {
  // ② 干净 worktree
  const add = run('git', ['worktree', 'add', '--detach', wt, OLD_SHA])
  if (add.status !== 0) fail('git worktree add 失败', add.stderr)
  added = true

  fs.mkdirSync(path.join(wt, 'tests', 'fixtures'), { recursive: true })
  fs.copyFileSync(path.join(REPO, TEST_REL), path.join(wt, TEST_REL))

  // ③ 在旧版上重新生成
  const gen = spawnSync(process.execPath, ['--test', TEST_REL], {
    cwd: wt, encoding: 'utf8', env: { ...process.env, UPDATE_GOLDEN: '1' },
  })
  const out = String(gen.stdout || '') + String(gen.stderr || '')
  if (gen.status !== 0) fail('在 ' + OLD_SHA + ' 上重新生成 golden 失败', out)
  const regenerated = path.join(wt, FIXTURE_REL)
  if (!fs.existsSync(regenerated)) fail('旧版跑完却没有产出 fixture', out)

  // ④ 逐字节比（只归一化 CRLF —— 本机 LF / 干净检出 CRLF）
  const a = norm(fs.readFileSync(regenerated))
  const b = norm(fixture.toString('utf8'))
  if (a === b) {
    console.log('✅ golden 来源可信：在 ' + OLD_SHA + ' 上重新生成，与仓库里的 fixture **逐字节一致**'
      + '（' + Buffer.byteLength(a) + ' 字节，' + Object.keys(JSON.parse(b)).length + ' 个采集键）')
    console.log('   ⇒ 「golden 源自重构前那一版」不是自述，是机器结论')
  } else {
    let detail = ''
    try {
      const ja = JSON.parse(a); const jb = JSON.parse(b)
      for (const k of [...new Set([...Object.keys(ja), ...Object.keys(jb)])]) {
        if (JSON.stringify(ja[k]) !== JSON.stringify(jb[k])) {
          detail += '   [' + k + '] 不同\n     旧版生成: ' + JSON.stringify(ja[k]).slice(0, 200) + '\n     仓库里  : ' + JSON.stringify(jb[k]).slice(0, 200) + '\n'
        }
      }
    } catch (e) { detail = '（JSON 解析失败：' + e.message + '）' }
    fail('fixture 与「在 ' + OLD_SHA + ' 上生成的产物」**不一致** —— golden 的来源声明不成立', detail)
  }
} finally {
  doCleanup()
}

function doCleanup() {
  if (added) {
    const rm = run('git', ['worktree', 'remove', '--force', wt])
    if (rm.status !== 0) console.error('  ⚠️ worktree remove 失败（会残留）：' + String(rm.stderr || '').trim().slice(0, 200))
    run('git', ['worktree', 'prune'])
  } else {
    try { fs.rmSync(wt, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}
