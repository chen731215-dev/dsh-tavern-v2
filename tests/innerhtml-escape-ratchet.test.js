// ════════════════════════════════════════════════════════════════
// HTML sink 转义棘轮（issue #14 同 class 的**结构化**护栏，2.7.9 起建、2.7.13 扩）
//
// 为什么在 render-escape.test.js 之外还要这一条：
//   render-escape 的 ③ 是**按变量名写死**的模式（`+ e.source +` / `+ label +` …），
//   对"**新建一条渲染路径**"是盲的 —— 换个变量名、换个函数，同一类漏洞照样溜过去。
//   而"合并两个渲染函数""抽统一拼装 helper"恰恰最容易漏掉某一路来源
//   （PR #13 真实翻车：转义了 e.source/e.target，漏了 label）。
//
// 本护栏不看变量名，只看结构：sink 右边按**顶层 +** 分段，逐段判定。
//
// 2.7.13 的两处收紧（复核方指出的同一类病的延续）：
//   ① sink 从「只有 .innerHTML」扩成清单（innerHTML / outerHTML / srcdoc /
//      insertAdjacentHTML / document.write / createContextualFragment）——
//      原先对其余 4 种全盲（当时 0 处，但"现在没有"≠"将来不会有人加"）；
//      另加「清单外入口」护栏：谁新开了入口，直接报红。
//   ② 不再放过「单段 RHS」：旧判据 `segs.length < 2 → continue` 会把
//      `el.innerHTML = 动态值`（只有一段，恰恰最危险）整行跳过 —— 实测曾静默放过 14 行，
//      其中 2 处是真洞（presetName / bannedWords.join 进 innerHTML，v2.7.2 起就有）。
//      顺带还发现旧提取器**只看拼接的首行**，跨行拼接的续行整段漏判。
// 基线见 tools/innerhtml-baseline.json —— 只许减不许增（2.7.13 因覆盖扩大 7→23，属一次性，已在 CHANGELOG 记账）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findSuspects, scanFiles, segmentIsSafe, splitTopLevel,
  findUnlistedSinks, checkSrcdocSandbox, bodyInterpolationsUnsafe,
  SINKS, TARGETS, BASELINE_FILE,
} from '../tools/check-innerhtml-escape.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).entries || []
// ★ 键必须带 sink 与同文本序号 occ —— `box.innerHTML = h;` 在同一文件里出现两次，
//   只用行文本做键会让两条互相覆盖，棘轮就分不清「消掉一条」还是「另一条还在」。
const key = (e) => e.file + ' | ' + (e.sink || 'innerHTML') + ' | ' + (e.occ || 1) + ' | ' + e.line

test('① 现状不得超出基线（新增未转义的 sink 拼接 ⇒ 报红）', () => {
  const actual = scanFiles(TARGETS)
  const bset = new Set(baseline.map(key))
  const added = actual.filter((e) => !bset.has(key(e)))
  assert.deepEqual(
    added.map((e) => `${e.file}:${e.lineNo}[${e.sink}]  裸段=${JSON.stringify(e.parts)}`),
    [],
    '★ 出现了新的「HTML sink 裸拼」。要么加 esc()，要么在 PR 里说明为什么它安全后跑 tools/check-innerhtml-escape.mjs --update',
  )
  // 非空跑防护：扫描器必须真的扫到了东西（基线非空时现状不该为 0）
  assert.ok(baseline.length > 0, '基线为空 —— 要么真修完了（那请删掉本测试），要么扫描器空跑')
  assert.ok(actual.length > 0, '✗ 判据空跑：一条可疑行都没扫到，但基线有 ' + baseline.length + ' 条')
})

test('② 反证（PR #13 的真实形态）：一行里「转义了一个、漏了另一个」必须被抓', () => {
  const src = [
    'function r(e, label) {',
    "  tooltip.innerHTML = '<b>' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div><div>' + label + '</div>';",
    '}',
  ].join('\n')
  const hits = findSuspects(src)
  assert.equal(hits.length, 1, '对照：这种「转义了一部分」的行必须被判据抓出来')
  assert.deepEqual(hits[0].parts, ['label'], '必须精确点出漏掉的是 label')
})

test('③ 反证：新建渲染路径（新变量名）同样必须被抓 —— 这正是旧判据的盲区', () => {
  const src = [
    'function renderNewPanel(node) {',
    "  box.innerHTML = '<div class=\"n\">' + node.displayName + '</div>';",
    '}',
  ].join('\n')
  assert.equal(findSuspects(src).length, 1, '对照：换个变量名的新渲染路径也必须被抓（旧判据做不到）')
  // 旧判据（写死 `+ label +` / `+ e.source +`）在同一段上确实抓不到 —— 证明这条测试不是重复劳动
  const OLD_PATTERNS = [/\+\s*label\s*\+/, /\+\s*\(e\.label \|\| e\.relation/]
  assert.ok(!OLD_PATTERNS.some((re) => re.test(src)), '对照：旧的写死模式对这段确实命中不了')
})

test('④ 正例：结构安全的形态必须放行（避免误报到没法用）', () => {
  const SAFE = [
    "'固定文案'",
    'esc(userText)',
    'escAttr(userText)',
    'n.length',
    'p.count',
    "(g.collapsed ? '' : 'transform:rotate(90deg);')",
    "data.sessions.map(function (s) { return esc(s.id); }).join('')",
    '`<div>纯静态模板</div>`',
    'cleanedTotal',
  ]
  // cleanedTotal 是纯标识符 ⇒ 结构上判不出，**故意**归为可疑（靠基线人工过目）
  const EXPECT_SUSPECT = new Set(['cleanedTotal'])
  for (const s of SAFE) {
    assert.equal(segmentIsSafe(s), !EXPECT_SUSPECT.has(s), `段「${s}」的判定不对`)
  }
  // 反例：带插值的模板字面量**不是**字面量 —— 它是拼接的另一种写法（2.7.13 收紧）
  const UNSAFE = ['`<div>${x}</div>`', '`<b>' + '${userText}' + '</b>`']
  for (const s of UNSAFE) {
    assert.equal(segmentIsSafe(s), false, `★ 带插值的模板字面量被当成了安全字面量：${s}`)
  }
  // 逐段切分本身也要可信
  assert.deepEqual(splitTopLevel("'a' + esc(b) + c"), ["'a' ", ' esc(b) ', ' c'])
  assert.deepEqual(splitTopLevel("(x ? 'a:b' : '')"), ["(x ? 'a:b' : '')"], '引号里的 + / : 不该被切开')
})

test('④-b 反证：模板字面量插值 sink 必须被点名（2.7.13 收紧）', () => {
  const src = 'el.innerHTML = `<div class="n">${node.displayName}</div>`;'
  const hits = findSuspects(src)
  assert.equal(hits.length, 1, '对照：模板字面量插值必须被抓 —— 这曾是判据自己的盲区')
})

test('⑤ 基线必须能被解读：每条都带 分类 + 理由 + 证据，不许有「不明所以的白名单」', () => {
  for (const e of baseline) {
    const tag = `${e.file}:${e.lineNo}[${e.sink}#${e.occ}]`
    assert.ok(e.file && typeof e.line === 'string' && e.line.length > 0, '基线条目缺 file/line')
    assert.ok(Array.isArray(e.parts) && e.parts.length > 0, tag + ' 缺「裸段」说明，无法 review')
    assert.ok(e.kind && e.kind !== 'unclassified', tag + ' 没有分类 —— 请给 tools/check-innerhtml-escape.mjs 的 EVIDENCE 补一条规则')
    assert.ok(typeof e.why === 'string' && e.why.trim(), tag + ' 没写理由')
    // 证据允许两种形态：mustContain（字面片段）或 builder（函数体结构断言）
    const hasEvidence = (e.mustContain || []).length > 0 || e.builder
    assert.ok(hasEvidence, tag + ' 没给机器可验证的证据（mustContain 或 builder）')
  }
  // 分类的分布要覆盖多种 —— 只剩一类 ⇒ 判据退化
  const kinds = new Set(baseline.map((e) => e.kind))
  assert.ok(kinds.size >= 5, '基线只剩 ' + kinds.size + ' 类，判据可能退化成了单一形态')
})

test('⑥ 基线的「证据」必须仍然成立 —— 否则基线会悄悄变成谎言', () => {
  // 这是把白名单钉在地上的那一半：证据不是写给人看的注释，而是**每次都会复查的断言**。
  // 例：pName 那条要求「var pName = esc(p.name || '')」还在；谁把上游的 esc 去掉，这里立刻红。
  // 检索范围 = 整个 lib/**（不只条目所在文件）：有些证据在别的文件里 ——
  //   例如 `pct: Math.round(...)` 这条证据在 lib/server/prompt.js，而 sink 在 bundle / index.js。
  const cache = new Map()
  const corpus = () => {
    if (cache.has('*')) return cache.get('*')
    const parts = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.js')) parts.push(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
      }
    }
    walk(path.join(REPO, 'lib'))
    const v = parts.join('\n')
    cache.set('*', v)
    return v
  }
  const broken = []
  for (const e of baseline) {
    for (const snip of e.mustContain || []) {
      if (!corpus().includes(snip)) broken.push(`${e.file}:${e.lineNo} 的证据片段已不存在 → ${JSON.stringify(snip)}`)
    }
    // builder 型证据：函数必须存在（它的"体内无未转义插值"另由 CLI 的结构断言与 ⑪ 覆盖）
    if (e.builder && !new RegExp('function\\s+' + e.builder + '\\s*\\(').test(fs.readFileSync(path.join(REPO, e.file), 'utf8'))) {
      broken.push(`${e.file}:${e.lineNo} 的 builder 已不存在 → ${e.builder}`)
    }
  }
  assert.deepEqual(broken, [], '★ 基线的证据失效了 —— 要么上游转义没了（真漏），要么片段改写了（请同步更新 EVIDENCE）：\n' + broken.join('\n'))
  // 非空跑：证据片段总数必须 > 0
  const total = baseline.reduce((n, e) => n + (e.mustContain || []).length, 0)
  assert.ok(total > 0, '判据空跑：一条证据片段都没有')
})

test('⑦ 仓库里只许有**一套**转义实现 —— 第二套会漂（escAttr 就是这么翻车的）', () => {
  // ★ 行尾先归一化再匹配：下面按**字符窗口** 定位函数体，而本仓在 Windows 检出
  //   （core.autocrlf=true）下这个文件是 CRLF —— CRLF 会把窗口撑破，
  //   于是「干净 clone / CI 上假红，本机却绿」。这个坑真实发生过。
  const BUNDLE = fs.readFileSync(path.join(REPO, 'lib/client.manager.bundle.js'), 'utf8').replace(/\r\n/g, '\n')
  // 「把 & 映射成 &amp;」的转义写法只允许出现在 esc 里
  const ampMap = BUNDLE.split("replace(/&/g, '&amp;')").length - 1
  assert.equal(ampMap, 1, '★ 出现了第二套转义实现（replace(/&/g, \'&amp;\') 有 ' + ampMap + ' 处）。' +
    '请让它指回 esc —— 独立实现的第二份迟早会漂成不完整/空操作。')
  assert.equal(BUNDLE.split("'&': '&amp;'").length - 1, 0, '★ 又出现了字符表式转义，请收敛到 esc')
  // escapeHtml / htmlEscapeStr 都必须是 esc 的薄封装
  for (const fn of ['escapeHtml', 'htmlEscapeStr', 'escAttr']) {
    const m = BUNDLE.match(new RegExp('function ' + fn + '\\(s\\) \\{[\\s\\S]{0,220}?\\}'))
    assert.ok(m, `找不到 ${fn}`)
    assert.match(m[0], /return\s+(esc\(|String\(s\);|esc\b)/, `${fn} 的实体没有指向 esc：${m[0].slice(0, 120)}`)
  }
  // 反证：判据能吃住"第二套实现"的坏样本
  const probe = "function esc2(s) { return String(s).replace(/&/g, '&amp;'); }"
  assert.equal(probe.split("replace(/&/g, '&amp;')").length - 1, 1, '对照：坏样本必须能被该判据抓住')
})

// ════════════════════════════════════════════════════════════════
// ⑧~⑪ 2.7.13：sink 清单化之后的新护栏
// ════════════════════════════════════════════════════════════════

test('⑧ 清单里的每种 sink 各塞一个未转义样本，必须全部被点名（不许有「盲 sink」）', () => {
  const SAMPLES = [
    ["el.innerHTML = '<b>' + userData + '</b>';", 'innerHTML'],
    ["el.outerHTML = '<b>' + userData + '</b>';", 'outerHTML'],
    ["el.insertAdjacentHTML('beforeend', userData);", 'insertAdjacentHTML'],
    ["document.write('<b>' + userData + '</b>');", 'document.write'],
    ["var frag = range.createContextualFragment('<b>' + userData + '</b>');", 'createContextualFragment'],
    ['iframe.srcdoc = serverHtml;', 'srcdoc'],
  ]
  for (const [src, id] of SAMPLES) {
    const hits = findSuspects(src)
    assert.equal(hits.length, 1, `sink「${id}」的样本没被点名：${JSON.stringify(hits)}`)
    assert.equal(hits[0].sink, id, `sink「${id}」被认成了别的类型：${hits[0].sink}`)
  }
  // 非空跑：样本必须覆盖清单里的每一种 sink
  assert.equal(SAMPLES.length, SINKS.length, '样本数与 sink 清单不一致 —— 加了新 sink 就要补样本')
})

test('⑨ 清单外的注入入口必须报红（否则棘轮会「全绿但没在看」）', () => {
  const UNLISTED = [
    ["el.insertAdjacentElement('beforeend', node);", 'insertAdjacentElement'],
    ["document.writeln('<b>x</b>');", 'document.writeln'],
    ["Comp dangerouslySetInnerHTML={{ __html: raw }};", 'dangerouslySetInnerHTML'],
    ["el.outerHTML += tail;", 'outerHTML 累加'],
    ["var doc = new DOMParser().parseFromString(raw, 'text/html');", 'DOMParser'],
    ['eval(untrusted);', 'eval'],
    ['var f = new Function(untrusted); f();', 'new Function'],
  ]
  for (const [src, why] of UNLISTED) {
    const hits = findUnlistedSinks(src)
    assert.equal(hits.length, 1, `清单外入口「${why}」没被点名：${JSON.stringify(hits)}`)
  }
})

test('⑩ srcdoc 的缓解必须是**断言**：有 srcdoc ⇒ 必须有 sandbox，且不许 allow-same-origin', () => {
  const sink = 'document.getElementById("i").srcdoc = serverHtml;'
  // 没有 sandbox ⇒ 必须报
  assert.ok(checkSrcdocSandbox(sink).some((s) => /找不到 sandbox/.test(s)), '对照：有 srcdoc 却没有 sandbox 必须报')
  // 正常（allow-scripts，无 allow-same-origin）⇒ 不报
  const ok = sink + '\nvar x = \'<iframe sandbox="allow-scripts"></iframe>\';'
  assert.deepEqual(checkSrcdocSandbox(ok), [])
  // ★ 有人"顺手"加了 allow-same-origin ⇒ 必须报（这正是 AGENTS.md §6 ⑩ 里写死不许做的事）
  const bad = sink + '\nvar x = \'<iframe sandbox="allow-scripts allow-same-origin"></iframe>\';'
  assert.ok(checkSrcdocSandbox(bad).some((s) => /allow-same-origin/.test(s)), '对照：allow-same-origin 必须报')
  // 当前真实仓库必须通过
  const bundle = fs.readFileSync(path.join(REPO, 'lib/client.manager.bundle.js'), 'utf8').replace(/\r\n/g, '\n')
  assert.deepEqual(checkSrcdocSandbox(bundle), [], '★ bundle 里 srcdoc 的 sandbox 断言失败了')
})

test('⑪ 静态模板的结构断言：往 panelHTML 里塞未转义插值必须报红（sink 那层看不见它）', () => {
  const bundle = fs.readFileSync(path.join(REPO, 'lib/client.manager.bundle.js'), 'utf8').replace(/\r\n/g, '\n')
  // 现状：panelHTML 是纯静态模板（体内 0 处插值）⇒ 断言必须通过
  assert.deepEqual(bodyInterpolationsUnsafe(bundle, 'panelHTML'), [])
  // 注入一个未转义插值 ⇒ 必须报红（sink 那层只看到 panelHTML() 一个词，根本发现不了）
  const mutated = bundle.replace('function panelHTML() {', "function panelHTML() {\n      var probe = '<div>' + untrustedUserName + '</div>';")
  const issues = bodyInterpolationsUnsafe(mutated, 'panelHTML')
  assert.ok(issues.length >= 1, '对照：未转义插值必须被结构断言抓住 —— 否则 sink 清单对「往模板里加东西」是盲的')
  // 反证：esc 过的插值不许误报
  const okMutated = bundle.replace('function panelHTML() {', "function panelHTML() {\n      var probe = '<div>' + esc(untrustedUserName) + '</div>';")
  assert.deepEqual(bodyInterpolationsUnsafe(okMutated, 'panelHTML'), [], 'esc 过的插值不许误报')
})
