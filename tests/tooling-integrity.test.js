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
]

/** 返回文本里命中的「手抄数字」违规（空数组 = 干净） */
export function docCountOffences(text) {
  return DOC_COUNT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why)
}

/** 同一份文本里是否既含 CRLF 又含裸 LF */
export function isMixedEol(text) {
  return /\r\n/.test(text) && /(?<!\r)\n/.test(text)
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
  ]
  for (const s of samples) {
    assert.ok(docCountOffences(s).length > 0, '判据漏了坏样本：' + s)
  }
  // 干净样本不许误报
  const clean = [
    '验证基线一律以 `npm test` 的**输出**为准',
    '│   ├── bindings.js              #   绑定来源分类 / 活动会话探测',
    '> 进度：各阶段的行数净减见上表',
  ]
  for (const s of clean) {
    assert.deepEqual(docCountOffences(s), [], '误报（把干净文本判成手抄数字）：' + s)
  }
})

// ════════════════════════════════════════════════════════════════
// ⑥ 行尾不许混合
// ════════════════════════════════════════════════════════════════

test('⑥ 全仓文本文件不得混合换行（同一文件既有 CRLF 又有裸 LF）', () => {
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
  assert.deepEqual(bad, [], '★ 混合换行（新建文件请照抄同目录邻居的换行符）：\n' + bad.join('\n'))
})

test('⑥-b 反证：混合换行判据必须能认出来，且不误报统一行尾', () => {
  assert.ok(isMixedEol('a\r\nb\nc'), '判据认不出混合')
  assert.ok(!isMixedEol('a\r\nb\r\n'), '误报：全 CRLF 被判成混合')
  assert.ok(!isMixedEol('a\nb\n'), '误报：全 LF 被判成混合')
  assert.ok(!isMixedEol('单行无换行'))
})
