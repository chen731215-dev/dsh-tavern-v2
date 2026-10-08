// ════════════════════════════════════════════════════════════════
// 形态类常驻断言（task-30 笔2）—— 把两件"一次性手工修好"的事变成**机器看着**：
//   ① `.githooks/pre-commit` 的**索引模式必须是 100755**（POSIX 只执行带可执行位的 hooks；
//      曾被 `git commit --only` 静默改回 100644 —— 见 AGENTS §11）。
//   ② `lib/client.manager.bundle.js` 的 **blob 形态 CRLF 必须为 0**（本仓约定：这个文件是 **LF**）。
//      为什么需要它：客户端身份网与 innerHTML 棘轮**都在读入后把 `\r\n` 归一成 `\n``
//      （`tests/panel-html-identity.test.js` / `tools/check-innerhtml-escape.mjs` 的读入口径），
//      而 `tooling-integrity ⑥` 只抓"**同一文件里混行**" ⇒ 若哪天这个文件的 blob **整体变成 CRLF**，
//      上述几张网**一个都不会响**。这条断言补的就是这个盲区。
//
// ★ 两条判据一律读 **index / blob**，**不读工作树** —— 形态类判据的既定口径：
//   实测（干净克隆 @e4b77d6）：`blob CRLF = 0` ｜ `工作树 CRLF = 7638`（`core.autocrlf=true` 检出时转的）
//   ⇒ 读工作树会**假红**，而且同一断言在不同机器上不是同一件事。
//
// ★ 两条**各自独立判红**（两个 `test()`）：一条失败不得牵连另一条（本笔的反证专门验证这点）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = '.githooks/pre-commit'
const BUNDLE = 'lib/client.manager.bundle.js'

/** 解析 `git ls-files -s` 的一行：`<mode> <sha> <stage>\t<path>`。纯函数，可喂坏样本。 */
export function parseIndexEntry(line) {
  const m = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(String(line).trim())
  return m ? { mode: m[1], sha: m[2], stage: Number(m[3]), path: m[4] } : null
}

/** 数 **blob 字节**里的 CRLF 个数（按字节数，不用字符串 —— 免得编码差异污染读数）。 */
export function countCrlf(buf) {
  let n = 0
  for (let i = 1; i < buf.length; i++) if (buf[i] === 0x0a && buf[i - 1] === 0x0d) n++
  return n
}

/** 取某路径的**索引条目**；取不到（不是 git 仓库 / 该路径没被跟踪）⇒ null（调用方必须出声）。 */
function indexEntry(rel) {
  const r = spawnSync('git', ['ls-files', '-s', '--', rel], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) return null
  const line = String(r.stdout || '').split('\n').find((l) => l.trim())
  return line ? parseIndexEntry(line) : null
}

/** 读 **blob** 内容（不是工作树）；取不到 ⇒ null。 */
export function blobBytes(sha, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  const r = spawnSync('git', ['cat-file', 'blob', sha], { cwd: REPO, maxBuffer })
  return r.status === 0 && r.stdout && r.stdout.length ? r.stdout : null
}

test('① `.githooks/pre-commit` 的**索引模式**必须是 100755（POSIX 只执行带可执行位的 hooks）', (t) => {
  const e = indexEntry(HOOK)
  assert.ok(e, '★ 读不到 ' + HOOK + ' 的索引条目 —— 判据空跑（它必须是**已跟踪**文件；' +
    '被 gitignore / 未 add / 不在索引里都会走到这里）')
  t.diagnostic(HOOK + ' 索引模式 = ' + e.mode + ' · blob ' + e.sha.slice(0, 12) + ' · stage ' + e.stage)
  assert.equal(e.mode, '100755',
    '★ ' + HOOK + ' 的索引模式是 ' + e.mode + '（要求 100755）—— ' +
    '在 POSIX 上 git **不会执行**没有可执行位的 hook，等于本地卫生闸门在 Linux/macOS 上形同不存在。' +
    '处置：`git update-index --chmod=+x ' + HOOK + '` 后**直接提交索引**（`git commit -F msg`，不加 `--only`），' +
    '并用 `git ls-tree HEAD ' + HOOK + '` 复验（`--only` 会静默丢模式，见 AGENTS §11）。')
})

test('② `lib/client.manager.bundle.js` 的 **blob 形态** CRLF 必须为 0（本仓约定 LF）', (t) => {
  const e = indexEntry(BUNDLE)
  assert.ok(e, '★ 读不到 ' + BUNDLE + ' 的索引条目 —— 判据空跑')
  const buf = blobBytes(e.sha)
  assert.ok(buf, '★ 拿不到 blob `' + e.sha.slice(0, 12) + '` —— 判据没在做事（不许静默降级成"没报就是干净"）')
  const crlf = countCrlf(buf)
  t.diagnostic(BUNDLE + ' blob 字节 ' + buf.length + ' · CRLF ' + crlf +
    '（**工作树读数不参与判定**：干净克隆里该文件被 autocrlf 转成 CRLF —— 实测 7638）')
  // 非空跑下限：真的读到了一个"像 bundle"的 blob
  assert.ok(buf.length > 100000, '★ blob 只有 ' + buf.length + ' 字节，小得不像 bundle —— 判据空跑（读错了对象？）')
  assert.equal(crlf, 0,
    '★ ' + BUNDLE + ' 的 **blob** 里有 ' + crlf + ' 个 CRLF（要求 0）—— ' +
    '它是本仓唯一的 LF 客户端文件；整体转成 CRLF 后，客户端身份网与 innerHTML 棘轮（都做 `\\r\\n`→`\\n` 归一）' +
    '以及 tooling-integrity ⑥（只抓混行）**都不会响**。处置：把该文件的换行统一回 LF 再提交。')
})

// ── 纯函数反证（极性覆盖；不需要克隆就能跑）──────────────────────
test('③ 反证：`parseIndexEntry` 必须认得出模式，且对垃圾行返回 null（不许乱解析）', () => {
  assert.equal(parseIndexEntry('100755 d0ee91c811a9e2c3c5349501517f821fa4205d3c 0\t.githooks/pre-commit')?.mode, '100755')
  assert.equal(parseIndexEntry('100644 d0ee91c811a9e2c3c5349501517f821fa4205d3c 0\t.githooks/pre-commit')?.mode, '100644')
  assert.equal(parseIndexEntry('100755 abc 0\tx')?.sha, undefined, '短 sha 不该被接受')
  for (const bad of ['', '100644', 'not a line', '100755 d0ee91c811a9e2c3c5349501517f821fa4205d3c 0', '  ']) {
    assert.equal(parseIndexEntry(bad), null, '垃圾行必须返回 null：' + JSON.stringify(bad))
  }
})

test('④ 反证：`countCrlf` 必须数对（纯 CRLF / 纯 LF / 混合 / 无换行），且不把裸 LF 算成 CRLF', () => {
  assert.equal(countCrlf(Buffer.from('a\nb\n')), 0, '纯 LF 必须是 0')
  assert.equal(countCrlf(Buffer.from('a\r\nb\r\n')), 2, '纯 CRLF 必须数全')
  assert.equal(countCrlf(Buffer.from('a\r\nb\nc')), 1, '混合只数 CRLF 那一个')
  assert.equal(countCrlf(Buffer.from('single')), 0, '无换行必须是 0')
  assert.equal(countCrlf(Buffer.from('\r\n')), 1, '单个 CRLF 必须是 1')
})
