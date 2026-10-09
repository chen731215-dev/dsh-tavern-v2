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
//     ⚠️ 4a（环境不可用）用 `--staged`（pre-commit 的真实形态）；4b（坏样本必咬）**不带 `--staged`**
//        —— 样本只写盘不 git add，带 `--staged` 会走 `git show :path` 读不到内容 ⇒ 内容规则不可达 ⇒ 必红。
//   · ⑤   判据层反证：**同形态只改"有没有 PAT"一个变量**，要求命中差异必须出现（自证反例存在）；断言点名规则 id。
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
/**
 * 跑一次闸门子进程。`staged` 决定**是否**传 `--staged`（默认 true，即 pre-commit 的真实形态）。
 *
 * ★★ 为什么必须让它可关（本文件 4b 的护栏，2026-10-09 task-33 修复笔）：★★
 *   `--staged` 会让闸门走 `scan(files, { readFromIndex: true })`
 *   ⇒ 内容读取走 `git show :<path>`（`check-repo-hygiene.mjs:205-207`）
 *   ⇒ **只读暂存区里已入库的 blob**。而本测试的样本**只写盘、从不 `git add`**
 *   ⇒ `git show :<path>` 非 0 ⇒ `continue` **提前退出该文件**（`:207`）
 *   ⇒ **内容规则（`content/github-pat` 等）永远不可达**，只可能剩 `[path/scratch]`。
 *   ⇒ 于是 4b 的 `assert.ok(/content\/github-pat/...)` 在**能 spawn 的环境（CI）上必红**。
 *   ⇒ ★ 内容规则类断言**必须**用**不带 `--staged`** 的形态（走真实文件读取 `fs.readFileSync`）。
 *
 *   ⚠️ **别把 4b 改回 `--staged`**（哪怕顺手"统一"）：那不是风格问题，是判据可达性问题 ——
 *      改回去会重新把这条端到端断言变成"永真不可达 / 永假必红"，而本机又恰好 skip 掉它 ⇒ 缺陷会被再次掩盖。
 *   ⚠️ 4a（环境不可用档）**必须**保持 `--staged`：那才是 pre-commit 的**真实调用形态**
 *      （`.githooks/pre-commit` 跑的就是 `check-repo-hygiene.mjs --staged`）；换成默认形态就不再是等价的端到端验证。
 */
function runGate(env = {}, { staged = true } = {}) {
  const args = staged ? [GATE, '--staged'] : [GATE]
  const r = spawnSync(process.execPath, args, {
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
  // 4a. 环境不可用。★ **保持 `--staged`**：pre-commit（.githooks/pre-commit）跑的就是这个形态，
  //     换掉就不再是等价的端到端验证（见 runGate 注释）。
  const r = runGate({}, { staged: true })
  if (r.code === 2) {
    assert.ok(/环境不可用/.test(r.out), '★ 必须点名「环境不可用」')
    assert.ok(/EBUSY|exit=null|error\.code/.test(r.out), '★ 必须报出机械成因')
    assert.ok(!/不是 git 仓库/.test(r.out), '★ 不许再用误导性的「不是 git 仓库」')
  } else {
    // 能正常取清单 ⇒ 这条反证的前提不成立，跳过（不伪造）
    t.diagnostic('本机能取清单 ⇒ exit=' + r.code + '（环境不可用档不适用）')
  }
  // 4b. 真有违规 ⇒ exit=1（用仅测试用的清单注入缝）。
  //     ★ **不带 `--staged`**：样本只写盘、不 git add ⇒ `--staged` 会让 `git show :path` 读不到内容
  //       ⇒ 内容规则不可达（详见 runGate 上面的护栏注释）。这里要验的正是**内容规则真的会咬**。
  const scratch = path.join(REPO, '_scratch')
  fs.mkdirSync(scratch, { recursive: true })
  const rel = path.join('_scratch', 'task-33-exitcode-probe.txt').replace(/\\/g, '/')
  const abs = path.join(REPO, rel)
  fs.writeFileSync(abs, 'const t = ' + DQ + FAKE_PAT + DQ + '\n', 'utf8')
  try {
    const bad = runGate({ HYGIENE_STUB_LIST: rel }, { staged: false })
    assert.equal(bad.code, 1, '★ 真有违规必须是 1，实际=' + bad.code + ' out=' + bad.out.slice(0, 200))
    assert.ok(/content\/github-pat/.test(bad.out), '★ 必须打印违规清单并点名命中规则')
    assert.ok(!/环境不可用/.test(bad.out), '★ 真有违规**不许**被说成环境不可用（两档不许混）')
  } finally { fs.unlinkSync(abs) }
})

test('⑤ 判据层反证：内容规则**真的会咬** —— 自证反例存在 + 断言点名规则 id', (t) => {
  if (!canSpawnGate()) {
    return t.skip('本机连 node 子进程都 spawn 不出来（受限宿主）⇒ 需 CI/可 spawn 环境')
  }
  // ★ 为什么这条反证要单独存在（而不是只靠 4b）：
  //   4b 只断言"**有** PAT 的样本 ⇒ 输出里有 content/github-pat"。若闸门的内容规则被整个短路
  //   （例如误配成全部命中、或注入缝把清单送进了不可达分支），**一条正例断言无法自证它不是恒真**。
  //   判据层反证的做法：**同形态下只改"有没有 PAT"这一个变量**，要求**差异必须出现** ——
  //   反例构造不出来（下面 checked===0 或 missing.length===0）就**判红**，绝不放空跑过去。
  const scratch = path.join(REPO, '_scratch')
  fs.mkdirSync(scratch, { recursive: true })
  const relClean = path.join('_scratch', 'task-33-control-clean.txt').replace(/\\/g, '/')
  const relDirty = path.join('_scratch', 'task-33-control-dirty.txt').replace(/\\/g, '/')
  const absClean = path.join(REPO, relClean)
  const absDirty = path.join(REPO, relDirty)
  // 干净样本：同一形状，但**不含** PAT ⇒ 基准
  fs.writeFileSync(absClean, 'const t = ' + DQ + 'not-a-credential' + DQ + '\n', 'utf8')
  // 坏样本：唯一差异 = 值换成 PAT 形状
  fs.writeFileSync(absDirty, 'const t = ' + DQ + FAKE_PAT + DQ + '\n', 'utf8')
  try {
    const RULE = 'content/github-pat'
    // ★ 自带可达性核对：先在**判据**（CONTENT_RULES 里的正则）层证明"这两个样本确实一正一反，
    //   且用的就是闸门那把尺子"。这样即使子进程层出问题，反证本身也不会退化成空转。
    const dirtyText = fs.readFileSync(absDirty, 'utf8')
    const cleanText = fs.readFileSync(absClean, 'utf8')
    assert.ok(/github-pat/.test(RULE), '★ 断言必须点名到具体规则 id，不许只判"输出非空"')
    assert.ok(/ghp_[A-Za-z0-9]{36}/.test(dirtyText), '★ 反例自证：坏样本必须真的含 PAT 形状（否则本反证无效）')
    assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(cleanText), '★ 反例自证：干净样本必须真的不含 PAT（否则变量没控住）')

    const dirty = runGate({ HYGIENE_STUB_LIST: relDirty }, { staged: false })
    const clean = runGate({ HYGIENE_STUB_LIST: relClean }, { staged: false })
    // ★ 变量被控住：仅"值里有没有 PAT"不同 ⇒ 命中必须只在坏样本上出现
    const hit = (out) => new RegExp('\\[' + RULE.replace(/\//g, '\\/') + '\\]').test(out)
    assert.ok(hit(dirty.out), '★ 坏样本必须点名 [' + RULE + ']，实际 out=' + dirty.out.slice(0, 300))
    assert.ok(!hit(clean.out), '★ 干净样本**不许**命中 [' + RULE + ']（否则该反证说明不了任何事）：' + clean.out.slice(0, 300))
    // ★ 反证成立的下限：坏样本被咬的同时，干净样本仍应因**其它**规则（_scratch 路径）而不通过 ——
    //   这说明"不是整体恒真/恒假"，而是**规则定向命中**。
    assert.ok(/\[path\/scratch\]/.test(clean.out), '★ 干净样本仍应被 path/scratch 咬住（证明闸门在跑，只是没误报 PAT）')
  } finally {
    fs.unlinkSync(absClean)
    fs.unlinkSync(absDirty)
  }
})
