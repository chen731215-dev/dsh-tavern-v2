// ════════════════════════════════════════════════════════════════
// 卫生闸门「UTF-8 BOM」判据的**非空跑对照测试**（task-19 笔1：用坏样本必须报错）
//
// 为什么单独一个文件：本仓明令「每个工具都必须自带『用坏样本必须报错』的非空跑对照测试 —— 否则等于没有护栏」。
//
// ★ 为什么必须在**临时 git 仓库**里跑、而不是直接对着本仓跑：
//   门禁的 `REPO` 由**它自身的位置**推导（`path.resolve(dirname(import.meta.url), '..')`）
//   ⇒ 要让它检查别的目录，只能把门禁**复制进那个仓库**再以**子进程**执行。
//   子进程这一点同时解决了缓存问题：门禁在同进程内缓存 blob 头（109 个文件 ≈ 1 秒），
//   而夹具每个都在**新进程**里跑 ⇒ "新增带 BOM 的已跟踪文件 ⇒ 必须报红"仍是真反证。
//
// ★ 形状照本会话已定的规矩：**反证必须自证它真的跑了**（打印/断言 mutate 命中次数 + 首 3 字节）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE_SRC = path.join(REPO, 'tools', 'check-repo-hygiene.mjs')
const BOM = [239, 187, 191]        // EF BB BF

/** 建临时夹具仓库：把门禁复制进去（连同它 import 的相对路径无关——门禁只 import node 内置），再放文件。 */
function makeFixture({ bomFile = true, extra = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-hyg-fixture-'))
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.copyFileSync(GATE_SRC, path.join(dir, 'tools', 'check-repo-hygiene.mjs'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8')
  let bomHits = 0
  if (bomFile) {
    fs.writeFileSync(path.join(dir, 'probe_with_bom.txt'), '\uFEFFhello\n', 'utf8')
    bomHits++
  }
  for (let i = 0; i < extra; i++) fs.writeFileSync(path.join(dir, 'plain' + i + '.txt'), 'plain ' + i + '\n', 'utf8')
  execFileSync('git', ['init', '--quiet', '.'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return { dir, bomHits }
}

function runGate(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'check-repo-hygiene.mjs')], {
    cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

test('① 反证：带 BOM 的**已跟踪**文件 ⇒ exit=1 且**点名该路径**（含 mutate 自证）', () => {
  const { dir, bomHits } = makeFixture()
  try {
    assert.equal(bomHits, 1, '夹具里应恰好写入 1 个带 BOM 的文件')
    const raw = fs.readFileSync(path.join(dir, 'probe_with_bom.txt'))
    assert.deepEqual([...raw.subarray(0, 3)], BOM, '★ mutate 自证：该文件首 3 字节必须是 EF BB BF（BOM 真的写进去了）')
    const ls = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
    assert.ok(ls.includes('probe_with_bom.txt'), '★ 该文件必须**已被跟踪**（在 git ls-files 里）')
    const r = runGate(dir)
    assert.equal(r.code, 1, '★ 坏样本必须报错（exit=1），实际=' + r.code + '  out=' + r.out.slice(0, 300))
    assert.ok(r.out.includes('probe_with_bom.txt'), '★ 输出必须**点名**该路径')
    assert.ok(r.out.includes('form/utf8-bom'), '★ 输出必须给出 kind = form/utf8-bom')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('② 非空跑下限：过小的仓库 ⇒ 必须因"只检查了 N 个 blob 头"报红（不许安静通过）', () => {
  const { dir } = makeFixture({ bomFile: false })     // 只有 2 个文件，远小于下限
  try {
    const r = runGate(dir)
    assert.equal(r.code, 1, '★ 下限未达 ⇒ 不许把"没报 BOM"当通过，实际=' + r.code + '  out=' + r.out.slice(0, 300))
    assert.ok(r.out.includes('(非空跑下限)') && /只检查了 \d+ 个 blob 头/.test(r.out), '★ 必须点名下限并报出实际检查数')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('③ 反向（判据没被收废）：足够多文件 + 无 BOM ⇒ exit=0，且不误报 BOM', () => {
  const { dir } = makeFixture({ bomFile: false, extra: 60 })
  try {
    const r = runGate(dir)
    assert.equal(r.code, 0, '★ 62 个文件 ≥ 下限且无 BOM ⇒ 应通过，实际=' + r.code + '  out=' + r.out.slice(0, 300))
    assert.ok(!r.out.includes('form/utf8-bom'), '★ 不许误报 BOM')
    assert.match(r.out, /检查 \d+ 个 blob 头/, '★ 成功输出里要能看见"本轮真的检查了多少个 blob 头"')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('④ 判别力：同一夹具里"加上 BOM ⇒ 红、去掉 ⇒ 绿"（证明命中是特异的，不是凡文件都报）', () => {
  const { dir } = makeFixture({ bomFile: false, extra: 60 })
  try {
    const p = path.join(dir, 'probe2.txt')
    fs.writeFileSync(p, '\uFEFFx\n', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    const before = runGate(dir)
    assert.equal(before.code, 1, '★ 加 BOM 后必须红，实际=' + before.code)
    assert.ok(before.out.includes('probe2.txt'), '★ 必须点名 probe2.txt')
    const buf = fs.readFileSync(p)
    const hits = (buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]) ? 1 : 0
    assert.equal(hits, 1, '★ mutate 自证：待去掉的 BOM 命中次数必须是 1')
    fs.writeFileSync(p, buf.subarray(3))               // 只去开头 3 字节（不经会加 BOM 的文本编码）
    execFileSync('git', ['add', '-A'], { cwd: dir })
    const after = runGate(dir)
    assert.equal(after.code, 0, '★ 去掉 BOM 后必须绿，实际=' + after.code + '  out=' + after.out.slice(0, 200))
    assert.ok(!after.out.includes('probe2.txt'), '★ 去掉 BOM 后必须**不再**点名该文件')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ 「以 blob 为准」的应有行为：去掉**工作树**的 BOM 但不动索引 ⇒ 仍然红（这不是假红）', () => {
  const { dir } = makeFixture()
  try {
    const p = path.join(dir, 'probe_with_bom.txt')
    const buf = fs.readFileSync(p)
    assert.deepEqual([...buf.subarray(0, 3)], BOM, '夹具前提：该文件确实带 BOM')
    fs.writeFileSync(p, buf.subarray(3))               // 只改工作树，**不** git add
    const r = runGate(dir)
    assert.equal(r.code, 1, '★ 索引里仍是带 BOM 的 blob ⇒ 必须继续红（判据报的是"提交进去的东西"）')
    assert.ok(r.out.includes('probe_with_bom.txt'), '★ 仍然点名该路径')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
