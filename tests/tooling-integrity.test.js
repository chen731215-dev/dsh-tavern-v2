/**
 * 工具链完整性护栏（2.7.11）。
 *
 * 为什么需要它：这一批修的是「**没有自动化强制点**」本身 ——
 *   · `scripts.test` 是手抄的 `&&` 长链，漏掉 3 个测试文件（含 issue #14 的安全回归）；
 *   · `scripts.check` 是手抄的 `--check` 清单，漏掉 13 个测试文件；
 *   · 仓库里没有 CI，所有护栏只活在「人记得手动跑」的那一刻；
 *   · 规范文档里的测试数字漂成了三套口径。
 *
 * 修完之后如果没有护栏，下一次「加个测试文件顺手改一下 scripts」就会原样复发。
 * 所以这里把「清单必须来自目录」「文档禁止手抄数字」「行尾不许混合」钉死。
 *
 * 判据一律写成**纯函数**（输入文本 → 违规列表），这样可以用坏样本做反证：
 * 空跑防护要求「喂坏样本必须报错」，而不是「在本仓不报错就算过」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ════════════════════════════════════════════════════════════════
// 纯判据（可喂坏样本）
// ════════════════════════════════════════════════════════════════

/** 手抄测试清单：`node --test tests/xxx.test.js` 直接写在脚本里 */
export const TEST_HAND_LIST = /--test\s+tests\//

/** 手抄语法检查清单：`node --check lib/xxx.js` 直接写在脚本里 */
export const CHECK_HAND_LIST = /--check\s+(?:lib|tests|tools)\//

/** 文档里禁止出现的「手抄测试数量」（这些数字一定会漂） */
export const DOC_COUNT_PATTERNS = [
  { re: /\d+\s*个测试文件/, why: '手抄测试文件数' },
  { re: /\d+\s*项断言/, why: '手抄断言数' },
  { re: /\d+\s*(?:个)?文件\s*[/／]\s*\d+\s*项/, why: '手抄「N 文件 / N 项」基线' },
  { re: /\.test\.js`?\s*[（，,]\s*\d+\s*项/, why: '手抄某个测试文件的项数' },
  { re: /^│.*#.*\d+\s*行/m, why: '结构树里手抄行数' },
  { re: /\d+\s*pass\b/, why: '手抄测试通过数（会随每次改动当场过期）' },
  { re: /\d+\s*fail\b/, why: '手抄测试失败数' },
  { re: /\d{3,}\s*行/, why: '手抄行数（三位以上必然是行数指标，且本身有两种口径）' },
  { re: /净减\s*\d+/, why: '手抄净减行数' },
  { re: /\d+\s*个(?:函数|模块|常量)/, why: '手抄函数/模块/常量个数' },
  { re: /\d+\s*条/, why: '手抄条数（基线/清单条数）' },
]

/** 返回文本里命中的「手抄数字」违规（空数组 = 干净） */
export function docCountOffences(text) {
  return DOC_COUNT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why)
}

/** 同一份文本里是否既含 CRLF 又含裸 LF */
export function isMixedEol(text) {
  return /\r\n/.test(text) && /(?<!\r)\n/.test(text)
}

/**
 * ★★ 形态判据的**blob 口径**（本仓既定纪律：形态判据不许只看工作树 —— 看工作树的守卫自己就变成环境依赖）。
 *
 * 为什么 ⑥ 那条工作树判据不够（两个方向都会歪）：
 *   · `core.autocrlf=true`（本仓默认）⇒ 工作树被检出成 CRLF ⇒ *工作树* 永远看不出"blob 里混了裸 LF"；
 *   · CI / 干净检出可能关掉 autocrlf（本会话实测过）⇒ 同一条判据在 CI 上看的其实是 blob 内容
 *     ⇒ **同一条断言在不同机器上断言不是同一件事**，这正是"环境依赖"的定义。
 * ⇒ 所以把**载荷判据**落到 blob 上（提交进去的那份字节），工作树那条**保留**但改名标清口径（本地检出形态）。
 *
 * 纯函数形态（喂坏样本即可反证）：`entries = [{ rel, text, binary }]`。
 * @returns {{bad: Array<string>, skipped: Array<string>, checked: number}}
 */
export function mixedEolBlobProblems(entries, { minBlobs = 50 } = {}) {
  const bad = []
  const skipped = []
  let checked = 0
  for (const e of entries) {
    if (e.binary) { skipped.push(e.rel); continue }
    checked++
    if (isMixedEol(e.text)) {
      const crlf = (e.text.match(/\r\n/g) || []).length
      const lf = (e.text.match(/(?<!\r)\n/g) || []).length
      bad.push(e.rel + '（blob：CRLF ' + crlf + ' / 裸LF ' + lf + '）')
    }
  }
  if (checked < minBlobs) {
    bad.push('(非空跑下限) 只检查了 ' + checked + ' 个 blob（要求 ≥ ' + minBlobs + '）⇒ 本轮的「没有混合换行」可能只是「没在看」')
  }
  return { bad, skipped, checked }
}

/**
 * 取全部已跟踪文件的 **blob 内容**（形态判据的实际输入）。
 * 取不到（`git ls-files -s` 失败 / bat 拿不到）⇒ 返回 null，调用方必须**出声**（不许静默降级）。
 * 二进制（前 8000 字节含 NUL）在这里就标出来，交给纯判据跳过并计数。
 */
export function trackedBlobEntries({ maxBytes = 2 * 1024 * 1024 } = {}) {
  const ls = spawnSync('git', ['ls-files', '-s', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (ls.status !== 0) return null
  const out = []
  for (const rec of ls.stdout.split('\0').filter(Boolean)) {
    const m = /^\d+ ([0-9a-f]{40}) \d+\t([\s\S]*)$/.exec(rec)
    if (!m) continue
    const rel = m[2].replace(/\\/g, '/')
    const r = spawnSync('git', ['cat-file', 'blob', m[1]], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0 || !r.stdout) continue
    const buf = r.stdout
    const binary = buf.subarray(0, 8000).includes(0) || buf.length > maxBytes
    out.push({ rel, text: binary ? '' : buf.toString('utf8'), binary })
  }
  return out
}

/** 收集仓库里的文本文件（相对路径），跳过 .git / node_modules / 临时目录 */
export function textFiles(repo = REPO) {
  const SKIP = new Set(['.git', 'node_modules', '_scratch'])
  const TEXT = /\.(?:js|mjs|cjs|json|md|yml|yaml|txt|html|css)$/
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      const isDot = e.name === '.gitignore' || e.name === '.gitattributes' || e.name === '.cursorrules' || e.name === '.editorconfig'
      if (!TEXT.test(e.name) && !isDot) continue
      out.push(path.relative(repo, abs).split(path.sep).join('/'))
    }
  }
  walk(repo)
  return out.sort()
}

/** 从 CI 工作流里抽出所有 `run:` 命令（`runs-on:` 不会被误匹配） */
export function workflowRunCommands(text) {
  return [...String(text).matchAll(/^[ \t]*run:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1].trim())
}

/** 哪些命令无法映射到 package.json 的脚本（`npm test` 是内建别名，放行） */
export function unmappedCommands(cmds, scripts) {
  return cmds.filter((c) => {
    if (c === 'npm test') return false
    const m = c.match(/^npm run ([A-Za-z0-9:_-]+)$/)
    return !(m && Object.prototype.hasOwnProperty.call(scripts, m[1]))
  })
}

/** 把 `a && b && c` 形式的脚本拆成命令数组 */
export function chainCommands(script) {
  return String(script).split('&&').map((s) => s.trim()).filter(Boolean)
}

// ════════════════════════════════════════════════════════════════
// ① 测试清单必须来自目录，不是手抄
// ════════════════════════════════════════════════════════════════

test('① npm test 必须指向 run-each-test.mjs，且不得内联测试文件清单', () => {
  const s = String(pkg.scripts.test || '')
  assert.ok(s.includes('tools/run-each-test.mjs'), 'npm test 应指向逐文件 runner，实际：' + s)
  assert.ok(!TEST_HAND_LIST.test(s), '★ scripts.test 又变回手抄清单了 —— 它一定会漏文件：' + s)
  assert.ok(s.includes('node '), 'npm test 应是一条 node 命令')
})

test('①-b 反证：手抄清单必须能被同一判据认出来', () => {
  const bad = 'node --test tests/core.test.js && node --test tests/greeting-seed.test.js'
  assert.ok(TEST_HAND_LIST.test(bad), '判据失效：旧写法都认不出来，那这条护栏是空的')
  assert.ok(!TEST_HAND_LIST.test('node tools/run-each-test.mjs'))
})

// ════════════════════════════════════════════════════════════════
// ② 语法检查同样不得手抄
// ════════════════════════════════════════════════════════════════

test('② npm run check 必须指向 check-syntax.mjs，且不得内联 --check 清单', () => {
  const s = String(pkg.scripts.check || '')
  assert.ok(s.includes('tools/check-syntax.mjs'), 'check 应指向扫目录的语法检查器，实际：' + s)
  assert.ok(!CHECK_HAND_LIST.test(s), '★ scripts.check 又变回手抄清单了：' + s)
  // 少了这个 flag，vm.SourceTextModule 不存在，工具会判失败（这是刻意的）
  assert.ok(s.includes('--experimental-vm-modules'), 'check 必须带 --experimental-vm-modules')
})

test('②-b 反证：手抄 --check 清单必须能被认出来', () => {
  assert.ok(CHECK_HAND_LIST.test('node --check lib/index.js && node --check lib/utils.js'))
  assert.ok(!CHECK_HAND_LIST.test('node --no-warnings --experimental-vm-modules tools/check-syntax.mjs'))
})

test('②-c tools/check-syntax.mjs 的扫描范围必须覆盖 lib/ tests/ tools/ 且带非空跑兜底', () => {
  const s = read('tools/check-syntax.mjs')
  for (const d of ["'lib'", "'tests'", "'tools'"]) {
    assert.ok(s.includes(d), '扫描范围缺少 ' + d)
  }
  assert.ok(s.includes('MUST_EXIST'), '缺少「必备文件必须被扫到」的非空跑兜底')
  assert.ok(s.includes('判据空跑'), '缺少「0 个文件 ⇒ 判失败」的兜底')
})

// ════════════════════════════════════════════════════════════════
// ③ runner 必须保留空跑防护
// ════════════════════════════════════════════════════════════════

test('③ run-each-test.mjs 必须把「一条断言都没跑」判为失败，且能区分合法跳过', () => {
  const s = read('tools/run-each-test.mjs')
  assert.ok(s.includes('vacuous'), '缺少 vacuous 判据 —— 空跑会被当成绿灯')
  assert.ok(/pass === 0 && fail === 0/.test(s), '空跑判据的写法变了，请确认语义还成立')
  assert.ok(/totalPass === 0/.test(s), '缺少「合计 0 项断言 ⇒ 失败」的总量兜底')
  assert.ok(/!vacuous/.test(s), 'vacuous 没有被接进 ok 判定')
  // 两种报告器都要认：node 的测试摘要格式随 reporter 变（tap `# pass N` / spec `ℹ pass N`）。
  // 只认一种会让所有文件都解析成 pass=0 —— 而「全 0」在旧判据下等于全绿，是最危险的一档。
  assert.ok(/ℹ\|#/.test(s), '判据只认一种测试报告器格式 —— 换 node 版本就会全部解析成 0')
  // skipped>0 不算空跑：cordis-mount 在没有 DSH app.asar 的环境会整批 skip，那是合法跳过
  assert.ok(/skipped === 0/.test(s), '空跑判据没有区分「合法跳过」与「什么都没跑」')
  assert.ok(/totalSkip/.test(s), '汇总里应当报出 skipped')
})

// ════════════════════════════════════════════════════════════════
// ④ CI 必须存在，且跑齐五条
// ════════════════════════════════════════════════════════════════

const WORKFLOW = '.github/workflows/check.yml'

test('④ CI 工作流必须存在且覆盖全部护栏', () => {
  assert.ok(fs.existsSync(path.join(REPO, WORKFLOW)), '★ 没有 CI —— 所有护栏又只活在「人记得跑」的那一刻')
  const s = read(WORKFLOW)
  const need = [
    ['npm test', '全量测试'],
    ['npm run check', '语法检查'],
    ['npm run check:style', '样式预算'],
    ['npm run check:integrity', '客户端自检三件套'],
    ['npm run check:innerhtml', 'innerHTML 转义棘轮'],
  ]
  const missing = need.filter(([cmd]) => !s.includes(cmd)).map(([, why]) => why)
  assert.deepEqual(missing, [], 'CI 缺这些步骤：' + missing.join(' / '))
  assert.ok(/runs-on:/.test(s), 'CI 没有 runs-on')
  assert.ok(/pull_request/.test(s), 'CI 未在 PR 上触发')
})

test('④-b CI 里每条 `run:` 都必须能映射到 package.json 的脚本（防重命名漂移）', () => {
  const cmds = workflowRunCommands(read(WORKFLOW))
  assert.ok(cmds.length >= 5, '只从工作流里解析出 ' + cmds.length + ' 条 run —— 判据空跑或格式变了')
  const bad = unmappedCommands(cmds, pkg.scripts)
  assert.deepEqual(bad, [], '★ 这些 CI 命令映射不到 package.json 脚本（改了名却没改工作流）：\n  ' + bad.join('\n  '))
})

test('④-c CI 不许被 continue-on-error 之类的手段中和', () => {
  const s = read(WORKFLOW)
  assert.ok(!/continue-on-error/.test(s), '★ 工作流里出现 continue-on-error —— 护栏会被静默中和')
  assert.ok(!/\|\|\s*true/.test(s), '★ 工作流里出现 `|| true` —— 失败会被吞掉')
})

test('④-d `npm run ci:local` 必须与 CI 跑**同一组**命令（本地镜像不许和 CI 漂）', () => {
  const local = chainCommands(pkg.scripts['ci:local'] || '')
  assert.ok(local.length >= 5, 'ci:local 不存在或步骤太少：' + JSON.stringify(pkg.scripts['ci:local']))
  const ci = workflowRunCommands(read(WORKFLOW))
  const onlyLocal = local.filter((c) => !ci.includes(c))
  const onlyCi = ci.filter((c) => !local.includes(c))
  // ★ 顺序也要一致：AGENTS §9 声称「同一组命令、同一顺序」——旧判据只比集合，属「声称强于事实」
  //   （第三轮复核把工作流整段倒序后代入旧判据仍 PASS）。
  assert.deepEqual(local, ci, '★ 本地镜像与 CI 的命令**顺序**不一致（AGENTS §9 声称同一顺序）')
  assert.deepEqual(
    { onlyLocal, onlyCi },
    { onlyLocal: [], onlyCi: [] },
    '★ 本地镜像与 CI 不一致 —— 会出现「本地绿、CI 红」：\n  只在本地跑：' + JSON.stringify(onlyLocal) +
      '\n  只在 CI 跑：' + JSON.stringify(onlyCi),
  )
})

test('④-e 反证：命令抽取与映射判据必须能报出坏样本', () => {
  const wf = [
    '      - name: ok',
    '        run: npm run check',
    '    runs-on: windows-latest',
    '      - name: bad',
    '        run: npm run check:typo',
  ].join('\n')
  const cmds = workflowRunCommands(wf)
  assert.deepEqual(cmds, ['npm run check', 'npm run check:typo'], '抽取结果不对：' + JSON.stringify(cmds))
  assert.deepEqual(unmappedCommands(cmds, { check: 'x' }), ['npm run check:typo'], '判据没抓住不存在的脚本')
  assert.deepEqual(unmappedCommands(['npm test'], {}), [], 'npm test 是内建别名，不该被判成未映射')
  assert.deepEqual(chainCommands('npm run a && npm test'), ['npm run a', 'npm test'])
})

// ════════════════════════════════════════════════════════════════
// ⑤ 文档禁止手抄测试数字
// ════════════════════════════════════════════════════════════════

test('⑤ 三份规范文档里不得出现手抄的测试数量', () => {
  const bad = []
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    if (!fs.existsSync(path.join(REPO, f))) continue
    for (const why of docCountOffences(read(f))) bad.push(f + ' → ' + why)
  }
  assert.deepEqual(bad, [], '★ 又有手抄数字了（数字一定会漂）：\n' + bad.join('\n'))
})

test('⑤-b 反证：坏样本必须被判据抓住', () => {
  const samples = [
    '- 当前基线：**23 个文件 / 454 项 / 0 失败**',
    '├── tests/  # 25 个测试文件 / 468 项断言',
    '| x | y |  ✅ 完成（`tests/client-integrity.test.js`，20 项）',
    '│   ├── bindings.js  # 绑定分类（216 行）',
    '全量测试：481 pass / 0 fail / 3 skipped',
    '跑完得到 488 pass，0 fail',
    '| **S2-A 服务端分层** | 搬「闭包干净」的 53 个函数 → `lib/server/` 10 个模块 | ✅ 完成（7175 → 6195 行，净减 980） |',
    '`lib/index.js` **5923 → 5583 行**',
    '累计自 7175 行**净减 1251 行**',
  ]
  for (const s of samples) {
    assert.ok(docCountOffences(s).length > 0, '判据漏了坏样本：' + s)
  }
  // 干净样本不许误报
  const clean = [
    '验证基线一律以 `npm test` 的**输出**为准',
    '│   ├── bindings.js              #   绑定来源分类 / 活动会话探测',
    '每个函数只做一件事，超过 50 行考虑拆',
    '### 9.2 行为等价的 golden 差分',
    '> 进度只看状态列的 ✅',
  ]
  for (const s of clean) {
    assert.deepEqual(docCountOffences(s), [], '误报（把干净文本判成手抄数字）：' + s)
  }
})

// ════════════════════════════════════════════════════════════════
// ⑥ 行尾不许混合
// ════════════════════════════════════════════════════════════════

test('⑥ 工作树形态：本地检出不得混合换行（**环境相关**；载荷判据见 ⑥-c 的 blob 口径）', () => {
  const files = textFiles()
  assert.ok(files.length > 20, '只扫到 ' + files.length + ' 个文件 —— 判据空跑')
  const bad = []
  for (const rel of files) {
    let t
    try { t = fs.readFileSync(path.join(REPO, rel), 'utf8') } catch { continue }
    if (isMixedEol(t)) {
      const crlf = (t.match(/\r\n/g) || []).length
      const lf = (t.match(/(?<!\r)\n/g) || []).length
      bad.push(rel + '（CRLF ' + crlf + ' / 裸LF ' + lf + '）')
    }
  }
  assert.deepEqual(bad, [], '★ 工作树里有混合换行（新建文件请照抄同目录邻居的换行符）：\n' + bad.join('\n'))
})

test('⑥-b 反证：混合换行判据必须能认出来，且不误报统一行尾', () => {
  assert.ok(isMixedEol('a\r\nb\nc'), '判据认不出混合')
  assert.ok(!isMixedEol('a\r\nb\r\n'), '误报：全 CRLF 被判成混合')
  assert.ok(!isMixedEol('a\nb\n'), '误报：全 LF 被判成混合')
  assert.ok(!isMixedEol('单行无换行'))
})

// ════════════════════════════════════════════════════════════════
// ⑥-c blob 口径：**提交进去的那份字节**不许混合换行（载荷判据；与 BOM 判据同款纪律）
//   为什么单列：⑥ 读的是工作树 —— `core.autocrlf=true` 时工作树是 CRLF ⇒ 永远看不出 blob 里混了裸 LF；
//   而 CI/干净检出可能关掉 autocrlf ⇒ 同一条断言在不同机器上不是同一件事（环境依赖）。
// ════════════════════════════════════════════════════════════════
test('⑥-c 全仓 blob 不得混合换行（以 blob 为准 + 非空跑下限）', (t) => {
  const entries = trackedBlobEntries()
  assert.ok(entries, '取不到 blob（git ls-files -s / cat-file 失败）⇒ 判据没在做事（不许静默降级）')
  const { bad, skipped, checked } = mixedEolBlobProblems(entries)
  t.diagnostic('blob 口径：扫描 ' + entries.length + ' 个已跟踪文件 · 判定 ' + checked + ' 个文本 · 跳过 ' + skipped.length + ' 个二进制/超大')
  assert.deepEqual(bad, [], '★ 这些文件的 **blob** 里混合了换行（提交进去的形态就是坏的）：\n' + bad.join('\n'))
  assert.ok(checked >= 50, '只判定到 ' + checked + ' 个 blob —— 判据空跑（下限 50）')
})

test('⑥-d 反证：blob 口径判据喂坏样本必须报红（混合 ⇒ 点名；统一行尾/单行 ⇒ 不误报；二进制 ⇒ 跳过并计数；过少 ⇒ 下限红）', () => {
  const e = (rel, text) => ({ rel, text, binary: false })
  const mixed = mixedEolBlobProblems([e('a.js', 'x\r\ny\nz'), ...Array.from({ length: 60 }, (_, i) => e('p' + i + '.js', 'ok\n'))])
  assert.equal(mixed.bad.length, 1, '混合 blob 必须报一条，实际=' + JSON.stringify(mixed.bad))
  assert.match(mixed.bad[0], /^a\.js（blob：CRLF 1 \/ 裸LF 1）/, '必须点名到文件 + 两种计数')
  // 统一行尾 / 单行 ⇒ 不误报
  const clean = mixedEolBlobProblems([
    e('lf.js', 'a\nb\n'), e('crlf.js', 'a\r\nb\r\n'), e('one.js', 'single'),
    ...Array.from({ length: 60 }, (_, i) => e('q' + i + '.js', 'ok\n')),
  ])
  assert.deepEqual(clean.bad, [], '统一行尾不许误报，实际=' + JSON.stringify(clean.bad))
  // 二进制 ⇒ 跳过并**计数**（不许静默把它当"看过且干净"）
  const bin = mixedEolBlobProblems([{ rel: 'x.bin', text: '', binary: true }, ...Array.from({ length: 60 }, (_, i) => e('r' + i + '.js', 'ok\n'))])
  assert.deepEqual(bin.bad, [], '二进制不该判红')
  assert.equal(bin.skipped.length, 1, '跳过的必须被记下')
  // 非空跑下限：检查数不足 ⇒ 必须红（否则"没报混合"可能只是"没在看"）
  const few = mixedEolBlobProblems([e('only.js', 'ok\n')])
  assert.equal(few.bad.length, 1, '过少必须报下限，实际=' + JSON.stringify(few.bad))
  assert.match(few.bad[0], /^\(非空跑下限\)/)
})
