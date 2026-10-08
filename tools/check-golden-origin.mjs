#!/usr/bin/env node
/**
 * golden 的**来源**验证（多例）：证明每个 fixture 确实是在它**声明的基准提交**上生成的，
 * 而不是在当前版上"自己拍自己"。
 *
 * 为什么必须有这一步：golden 差分是「重构没改行为」这套证据的**命门** ——
 * 如果快照其实来自当前版本，那它退化成"自己跟自己比"，再绿也不能说明任何事。
 * 而快照文件本身没有权威的来源戳记，所以"在某版上生成"此前只能靠**自述**。
 * 本脚本把它变成**机器可查**：对每个案例
 *   1. 建一个基准 sha 的干净 worktree（本机工作树是 LF、干净检出是 CRLF，两态结论可能不同）
 *   2. 把**当前版**的那份 golden 测试拷进去（同一套采集逻辑），用 `UPDATE_GOLDEN=1` 重新生成
 *   3. 与仓库里的 fixture 比 —— 不一致即退出码 1
 *
 * 两个案例的口径**故意不同**（不是偷懒，是事实要求）：
 *   · `golden-prompt`（基准 a816afd）→ **整文件逐字节比**（只归一化 CRLF）。
 *   · `golden-host-assembly-rich`（基准 aa76a20）→ **只比"环境无关投影"**：
 *     ① 基准版里**还没有** `lib/server/assemble.js`，该测试的 ③ 静态契约必然 ENOENT
 *        ⇒ 用 `--test-skip-pattern` 精确跳过它（跳过的理由写在这里，不是静默）；
 *     ② 该 fixture 的 `sectionSizes.card` / `captures[].rawLen` 是**环境相关量**
 *        （产物里嵌着技能指针段的绝对路径，长度随 `os.tmpdir()` 形态变 —— CI run #9 的真实翻车点）
 *        ⇒ 只比 `captures[].{mode,bytes,sha256}` 与 `sectionSizes.{wb,nsfw}`。
 *        `sha256` 已经钉住归一化后的正文内容，所以**证据强度不受影响**。
 *
 * 用法：node tools/check-golden-origin.mjs        # exit 0 = 所有案例来源可信
 * 注意：需要**完整历史**（CI 里 checkout 必须 fetch-depth: 0）。浅克隆会**响亮失败**，
 *       不做"取不到就跳过"—— 那正是本仓最反对的静默变绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 冻结的基准提交（第一例）。改这个值 = 声明换了基准，必须在提交信息里说明。 */
export const OLD_SHA = 'a816afd'
export const TEST_REL = 'tests/golden-prompt.test.js'
export const FIXTURE_REL = 'tests/fixtures/golden-prompt.json'

/**
 * 案例表。`mode: 'file'` = 整文件逐字节比；`mode: 'rich'` = 只比环境无关投影。
 * `skip` = 传给 `--test-skip-pattern` 的子串（基准版跑不了的那些断言）。
 */
export const CASES = [
  {
    name: 'golden-prompt',
    sha: 'a816afd',
    testRel: 'tests/golden-prompt.test.js',
    fixtureRel: 'tests/fixtures/golden-prompt.json',
    mode: 'file',
    skip: null,
  },
  {
    name: 'golden-host-assembly-rich',
    sha: 'aa76a20',
    testRel: 'tests/golden-host-assembly-rich.test.js',
    fixtureRel: 'tests/fixtures/golden-host-assembly-rich.json',
    mode: 'rich',
    // 基准版没有 lib/server/assemble.js ⇒ ③ 静态契约必然 ENOENT（预期行为，不是夹具坏了）
    skip: '静态契约',
  },
]

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, ...opts })
const norm = (s) => String(s).replace(/\r\n/g, '\n')

/** 环境无关投影：只留那些**不随临时目录路径长度变化**的字段。 */
export function envIndependentProjection(j) {
  return {
    captures: (Array.isArray(j.captures) ? j.captures : []).map((c) => ({
      mode: c.mode, bytes: c.bytes, sha256: c.sha256,
    })),
    sectionSizes: { wb: j.sectionSizes?.wb, nsfw: j.sectionSizes?.nsfw },
  }
}

/** 非空跑防护：投影必须**真的有东西**，否则"没比"也能算出相等。 */
function assertProjectionNonVacuous(name, p) {
  if (!p.captures.length) return '投影里一条 captures 都没有（判据空跑）'
  for (const c of p.captures) {
    if (typeof c.sha256 !== 'string' || c.sha256.length !== 64) return 'captures[' + c.mode + '] 的 sha256 不是 64 位十六进制'
    if (!Number.isFinite(c.bytes) || c.bytes <= 0) return 'captures[' + c.mode + '] 的 bytes 不是正数'
  }
  if (!Number.isFinite(p.sectionSizes.wb)) return 'sectionSizes.wb 缺失（应当是与环境无关的冻结项）'
  return null
}

let cleanupError = null
let addedWt = null

function doCleanup() {
  if (!addedWt) return
  const { wt } = addedWt
  addedWt = null
  const rm = run('git', ['worktree', 'remove', '--force', wt])
  if (rm.status !== 0) {
    // ★ 响亮失败：以前只打 ⚠️，于是"清理失败"会静默留下残留 worktree（第二轮复核实测到过）。
    cleanupError = 'worktree remove 失败：' + String(rm.stderr || '').trim().slice(0, 300) + '\n   残留路径：' + wt
    return
  }
  const pr = run('git', ['worktree', 'prune'])
  if (pr.status !== 0) cleanupError = 'git worktree prune 失败：' + String(pr.stderr || '').trim().slice(0, 300)
}

function fail(msg, extra = '') {
  // ★ 先清理再退出：process.exit 不展开栈、会跳过 finally（第二轮复核在克隆里实测到残留 worktree）。
  try { doCleanup() } catch { /* 清理失败不掩盖原错 */ }
  console.error('❌ ' + msg)
  if (extra) console.error(String(extra).split('\n').slice(-12).map((l) => '   ' + l).join('\n'))
  if (cleanupError) console.error('❌ 另外，清理也失败了：' + cleanupError)
  process.exit(1)
}

// ① 前置：历史必须是完整的（浅克隆会让基准 sha 不存在）
const shallow = run('git', ['rev-parse', '--is-shallow-repository'])
if (shallow.status === 0 && String(shallow.stdout).trim() === 'true') {
  fail('当前是**浅克隆**（shallow），历史里没有基准提交。',
    'CI 里请给 actions/checkout 加 `with: { fetch-depth: 0 }`；本地请 `git fetch --unshallow`。')
}
for (const c of CASES) {
  const have = run('git', ['cat-file', '-e', c.sha + '^{commit}'])
  if (have.status !== 0) fail('仓库里没有案例 ' + c.name + ' 的基准提交 ' + c.sha + '（历史被截断？）')
}

// ② 逐案例：干净 worktree → 用当前版测试重新生成 → 比
let passed = 0
for (const c of CASES) {
  const fixturePath = path.join(REPO, c.fixtureRel)
  if (!fs.existsSync(fixturePath)) fail('仓库里找不到 fixture：' + c.fixtureRel)
  const fixture = fs.readFileSync(fixturePath, 'utf8')

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-origin-'))
  fs.rmdirSync(wt)   // git worktree add 要求目标不存在
  const add = run('git', ['worktree', 'add', '--detach', wt, c.sha])
  if (add.status !== 0) fail('[' + c.name + '] git worktree add 失败', add.stderr)
  addedWt = { wt }

  fs.mkdirSync(path.join(wt, path.dirname(c.testRel)), { recursive: true })
  fs.mkdirSync(path.join(wt, path.dirname(c.fixtureRel)), { recursive: true })
  fs.copyFileSync(path.join(REPO, c.testRel), path.join(wt, c.testRel))

  const testArgs = ['--test']
  if (c.skip) testArgs.push('--test-skip-pattern=' + c.skip)
  testArgs.push(c.testRel)
  const gen = spawnSync(process.execPath, testArgs, {
    cwd: wt, encoding: 'utf8', env: { ...process.env, UPDATE_GOLDEN: '1' },
  })
  const out = String(gen.stdout || '') + String(gen.stderr || '')
  if (gen.status !== 0) fail('[' + c.name + '] 在 ' + c.sha + ' 上重新生成失败'
    + (c.skip ? '（已按声明跳过含「' + c.skip + '」的用例）' : ''), out)
  const regenerated = path.join(wt, c.fixtureRel)
  if (!fs.existsSync(regenerated)) fail('[' + c.name + '] 旧版跑完却没有产出 fixture', out)

  const regRaw = fs.readFileSync(regenerated, 'utf8')
  if (c.mode === 'file') {
    const a = norm(regRaw); const b = norm(fixture)
    if (a !== b) {
      let detail = ''
      try {
        const ja = JSON.parse(a); const jb = JSON.parse(b)
        for (const k of [...new Set([...Object.keys(ja), ...Object.keys(jb)])]) {
          if (JSON.stringify(ja[k]) !== JSON.stringify(jb[k])) {
            detail += '   [' + k + '] 不同\n     旧版生成: ' + JSON.stringify(ja[k]).slice(0, 200) + '\n     仓库里  : ' + JSON.stringify(jb[k]).slice(0, 200) + '\n'
          }
        }
      } catch (e) { detail = '（JSON 解析失败：' + e.message + '）' }
      fail('[' + c.name + '] fixture 与「在 ' + c.sha + ' 上生成的产物」**不一致** —— 来源声明不成立', detail)
    }
    console.log('✅ ' + c.name + '：在 ' + c.sha + ' 上重新生成，与仓库 fixture **逐字节一致**'
      + '（' + Buffer.byteLength(a) + ' 字节，' + Object.keys(JSON.parse(b)).length + ' 个采集键）')
  } else {
    let ja; let jb
    try { ja = JSON.parse(regRaw); jb = JSON.parse(fixture) } catch (e) { fail('[' + c.name + '] JSON 解析失败：' + e.message) }
    const pa = envIndependentProjection(ja); const pb = envIndependentProjection(jb)
    for (const [label, p] of [['旧版生成', pa], ['仓库里', pb]]) {
      const bad = assertProjectionNonVacuous(c.name, p)
      if (bad) fail('[' + c.name + '] ' + label + ' 的投影不可用：' + bad)
    }
    const sa = JSON.stringify(pa); const sb = JSON.stringify(pb)
    if (sa !== sb) {
      let detail = ''
      for (let i = 0; i < Math.max(pa.captures.length, pb.captures.length); i++) {
        const x = JSON.stringify(pa.captures[i]); const y = JSON.stringify(pb.captures[i])
        if (x !== y) detail += '   captures[' + i + '] 不同\n     旧版生成: ' + x + '\n     仓库里  : ' + y + '\n'
      }
      if (JSON.stringify(pa.sectionSizes) !== JSON.stringify(pb.sectionSizes)) {
        detail += '   sectionSizes 不同\n     旧版生成: ' + JSON.stringify(pa.sectionSizes) + '\n     仓库里  : ' + JSON.stringify(pb.sectionSizes) + '\n'
      }
      fail('[' + c.name + '] **环境无关投影**不一致 —— 来源声明不成立', detail)
    }
    console.log('✅ ' + c.name + '：在 ' + c.sha + ' 上重新生成，**环境无关投影**一致'
      + '（' + pa.captures.length + ' 条 captures 的 sha256/bytes + sectionSizes.wb/nsfw；'
      + '已跳过含「' + c.skip + '」的用例：那版没有 lib/server/assemble.js）')
  }
  // ★ 不要在这里预先置 addedWt = null：doCleanup() 一进来就检查它，先置空会让清理**整个不执行**（本笔实测泄漏 2×N 个 worktree）
  doCleanup()
  if (cleanupError) fail('[' + c.name + '] 校验通过，但清理失败（见下）')
  passed++
}

if (cleanupError) {
  console.error('❌ 清理失败：' + cleanupError)
  process.exit(1)
}
console.log('   ⇒ 「golden 源自它声明的那一版」不是自述，是机器结论（' + passed + ' 个案例）')
