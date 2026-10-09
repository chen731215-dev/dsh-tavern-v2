// ════════════════════════════════════════════════════════════════
// 仓库卫生闸门（tools/check-repo-hygiene.mjs）的**退出码三态**对照测试（task-33）
//
// 为什么要单独一个文件：本缺陷正是「把**环境不可用**读成了**真有违规**」——
//   旧版拿不到 git 清单时一律 `exit 1` + 打印「不是 git 仓库」（误导性文字），
//   于是 pre-commit 只能靠 --no-verify。修法把两档拆成 **1 = 违规 / 2 = 环境不可用**。
//
// ★ 自证形状（照本仓铁律「判据必须能被证明会咬」）：
//   · ①②③ 走**纯函数** `classifyGitListResult()`（**不依赖 spawn**）⇒ 在本机也真跑、真断言；
//   · ④   走**子进程** CLI（真正验证 exit=2 / exit=1 的端到端行为）。本机闸门子进程
//     **起不来**（`status=null`）⇒ 该条如实 skip，并说明「需 CI/可 spawn 环境」。
//   ⚠️ 「清单正常 ⇒ exit=0」那条在本机**天然不可达**（blob 头也走 spawn）⇒ 本文件**不**断言它。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyGitListResult } from '../tools/check-repo-hygiene.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE = path.join(REPO, 'tools', 'check-repo-hygiene.mjs')
const DQ = String.fromCharCode(34)
const FAKE_PAT = 'ghp_' + 'A'.repeat(36)          // 片段拼接：别让闸门把这行注释自己抓了

// ── 纯函数档：不靠 spawn，本机也能真跑 ──────────────────────────────
test('① 分类：`status===null`（进程被拦）⇒ 环境不可用（ok:false），**不是**"清单为空"', () => {
  // 本机实测形态：spawnSync 返回 { status:null, error:{ code:'EBUSY' } }
  const c = classifyGitListResult({ status: null, error: { code: 'EBUSY' }, stdout: '' })
  assert.equal(c.ok, false, '★ status=null 必须判为环境不可用（不能当成"空清单/通过"）')
  assert.equal(c.code, 'EBUSY', '★ 必须带出 error.code 供报因')
  assert.equal(c.status, null, '★ 必须带出 status 供报因')
})

test('② 分类：`r.error` 存在（ENOENT/EACCES…）⇒ 环境不可用', () => {
  const c = classifyGitListResult({ status: null, error: { code: 'ENOENT' } })
  assert.equal(c.ok, false, '★ spawn 层失败必须判为环境不可用')
  assert.equal(c.code, 'ENOENT')
})

test('③ 分类：非 0 退出（git 起了但报错）⇒ 环境不可用；**0 退出 ⇒ 才给出清单**', () => {
  const err = classifyGitListResult({ status: 128, error: null, stdout: '' })
  assert.equal(err.ok, false, '★ 非 0 退出不许当成通过')
  assert.equal(err.status, 128)

  const ok = classifyGitListResult({ status: 0, error: null, stdout: 'a.txt\0b/c.txt\0' })
  assert.equal(ok.ok, true, '★ 0 退出必须是清单（这才是"能检查"那条路）')
  assert.deepEqual(ok.files, ['a.txt', 'b/c.txt'], '★ 按 NUL 拆分、滤掉空项')

  const empty = classifyGitListResult({ status: 0, error: null, stdout: '' })
  assert.equal(empty.ok, true, '0 退出 + 空输出 = 合法空清单（不是环境不可用）')
  assert.deepEqual(empty.files, [])
})

// ── 子进程档：端到端验证退出码（本机闸门子进程起不来 ⇒ 如实 skip）──────
function runGate(env = {}) {
  const r = spawnSync(process.execPath, [GATE, '--staged'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env },
  })
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}
/** 本机能否 spawn 出**闸门子进程**（与闸门内部 spawn git 是两回事）。 */
function canSpawnGate() {
  const r = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })
  return r.status === 0
}

test('④ 端到端：环境不可用 ⇒ exit=2 且不含误导性的「不是 git 仓库」；坏样本 ⇒ exit=1 且点名规则', (t) => {
  if (!canSpawnGate()) {
    return t.skip('本机连 node 子进程都 spawn 不出来（受限宿主）⇒ 端到端退出码需 CI/可 spawn 环境')
  }
  // 4a. 环境不可用（只有在本机 spawn 被拦时才会走到这里；能 spawn 则闸门会正常出 0/1）
  const r = runGate()
  if (r.code === 2) {
    assert.ok(/环境不可用/.test(r.out), '★ 必须点名「环境不可用」')
    assert.ok(/EBUSY|exit=null|error\.code/.test(r.out), '★ 必须报出机械成因')
    assert.ok(!/不是 git 仓库/.test(r.out), '★ 不许再用误导性的「不是 git 仓库」')
  } else {
    // 能正常取清单 ⇒ 这条反证的前提不成立，跳过（不伪造）
    t.diagnostic('本机能取清单 ⇒ exit=' + r.code + '（环境不可用档不适用）')
  }
  // 4b. 真有违规 ⇒ exit=1（用仅测试用的清单注入缝）
  const scratch = path.join(REPO, '_scratch')
  fs.mkdirSync(scratch, { recursive: true })
  const rel = path.join('_scratch', 'task-33-exitcode-probe.txt').replace(/\\/g, '/')
  const abs = path.join(REPO, rel)
  fs.writeFileSync(abs, 'const t = ' + DQ + FAKE_PAT + DQ + '\n', 'utf8')
  try {
    const bad = runGate({ HYGIENE_STUB_LIST: rel })
    assert.equal(bad.code, 1, '★ 真有违规必须是 1，实际=' + bad.code + ' out=' + bad.out.slice(0, 200))
    assert.ok(/content\/github-pat/.test(bad.out), '★ 必须打印违规清单并点名命中规则')
    assert.ok(!/环境不可用/.test(bad.out), '★ 真有违规**不许**被说成环境不可用（两档不许混）')
  } finally { fs.unlinkSync(abs) }
})
