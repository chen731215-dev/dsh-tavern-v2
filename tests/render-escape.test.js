/**
 * 渲染层转义回归测试（issue #14：关系网 / 世界书渲染的 HTML 注入）。
 *
 * 背景：关系网的数据来自**模型输出**（自动总结 → 落库 → 前端自动重画），却被直接拼进
 * innerHTML；脚本执行在 DSH Web UI 的源里，而那个页面持有 DSH API 凭据 ⇒ 注入脚本能以
 * 用户身份驱动 agent。世界书条目正文同样直入 <textarea>。
 *
 * 本套件守四件事：
 *   ① `esc()` 必须吃掉 & < > " '（含单引号 —— 属性值常用单引号，只挡 " 等于没挡）；
 *   ② `escAttr()` 不能是空操作（原实现 esc 之后再 replace(") 永不命中）；
 *   ③ 两个关系网渲染函数里**零裸拼接**：模型字段一律 esc(...)；
 *   ④ 世界书正文进 textarea 必须 esc(...)（否则 </textarea> 直接破标签）。
 *
 * 反例护栏：每条"必须转义"的断言都配一个**故意用旧实现**的对照，证明这个判据不是永真。
 *
 * 运行：node --test tests/render-escape.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const BUNDLE = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')

/** 从 bundle 里抠出一个函数的完整源码（大括号配平，跳过字符串与行注释）。 */
function extractFn(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) throw new Error('找不到函数：' + sig)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      k++
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++ }
      continue
    }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error('大括号不闭合：' + sig)
}

/** 把 bundle 里的两个转义函数装进一个干净的 vm 沙箱，拿到可调用的实现。 */
function loadEscapers() {
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    extractFn(BUNDLE, 'function esc(') + '\n' + extractFn(BUNDLE, 'function escAttr(') +
    '\nthis.__esc = esc; this.__escAttr = escAttr;',
    box,
  )
  return { esc: box.__esc, escAttr: box.__escAttr }
}
/** 旧实现（issue #14 报的那两个）——只用来做反例对照，证明判据不是永真。 */
const OLD_ESC = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const OLD_ESC_ATTR = (s) => OLD_ESC(String(s)).replace(/"/g, () => '&quot;')

const PAYLOADS = [
  '</textarea><img src=x onerror=alert(1)>',
  '"><script>fetch("/api/agent",{method:"POST"})</script>',
  "';alert(1);//",
  'a & b < c > d "e" \'f\'',
  '</div><svg onload=alert(1)>',
]

// ════════════════════════════════════════════════════════════════
// ① esc：五个字符都要吃掉
// ════════════════════════════════════════════════════════════════
test('① esc() 必须吃掉 & < > " \'（含单引号）', () => {
  const { esc } = loadEscapers()
  for (const p of PAYLOADS) {
    const out = esc(p)
    for (const ch of ['<', '>', '"', "'"]) {
      assert.ok(!out.includes(ch), '★ esc 之后不该还有裸 ' + ch + '：' + JSON.stringify({ p, out }))
    }
    assert.ok(!/<\/?(script|img|svg|textarea)/i.test(out), '★ 不该还能拼出标签：' + out)
  }
  assert.equal(esc("it's"), 'it&#39;s', '单引号要转成 &#39;')
  assert.equal(esc(null), '', 'null 要安全')
})

test('①-b 反例：旧实现（不吃单引号）必须被这条判据抓住', () => {
  const { esc } = loadEscapers()
  const p = "';alert(1);//"
  assert.ok(!esc(p).includes("'"), '新实现过关')
  assert.ok(OLD_ESC(p).includes("'"), '★ 对照：旧实现确实漏单引号（判据有效，不是永真）')
})

// ════════════════════════════════════════════════════════════════
// ② escAttr 不能是空操作
// ════════════════════════════════════════════════════════════════
test('② escAttr() 必须真的转义（原实现是空操作）', () => {
  const { esc, escAttr } = loadEscapers()
  for (const p of PAYLOADS) {
    const out = escAttr(p)
    for (const ch of ['<', '>', '"', "'"]) assert.ok(!out.includes(ch), '★ escAttr 之后不该有裸 ' + ch + '：' + out)
    assert.equal(escAttr(p), esc(p), 'esc 已同时吃 " 与 \'，escAttr 复用即可')
  }
  // 只查代码行（注释里引用旧写法是说明，不算实现）
  const codeLines = BUNDLE.split('\n').filter((l) => !l.trim().startsWith('//'))
  assert.ok(!codeLines.some((l) => l.includes('esc(String(s)).replace')), '★ 源码里不该再有那个空操作写法')
})

test('②-b 反例：旧 escAttr 在单引号属性位置等于没挡', () => {
  const p = "x' onmouseover='alert(1)"
  const now = loadEscapers().escAttr(p)
  assert.ok(!now.includes("'"), '新实现过关：单引号被吃掉')
  assert.ok(OLD_ESC_ATTR(p).includes("'"), '★ 对照：旧实现确实漏（判据有效）')
})

// ════════════════════════════════════════════════════════════════
// ③ 关系网渲染：零裸拼接
// ════════════════════════════════════════════════════════════════
/** 关系网横跨两个函数：小图 renderRelationsGraph + 大图 renderLargeGraph。 */
function relationsRegion() {
  const s = BUNDLE.indexOf('function renderRelationsGraph(')
  const e = BUNDLE.indexOf('function paintRelHint(', s)
  assert.ok(s > 0 && e > s, '关系网区段边界必须能定位（函数改名了就要同步本测试）')
  return BUNDLE.slice(s, e)
}

test('③ 关系网两个渲染函数里，模型字段一律 esc(...)，零裸拼接', () => {
  const seg = relationsRegion()
  const RISKY = [
    [/\+\s*e\.source\s*\+/, '边来源 e.source'],
    [/\+\s*e\.target\s*\+/, '边目标 e.target'],
    [/\+\s*\(n\.label \|\| n\.id\)\s*\+/, '节点名 n.label'],
    [/\+\s*\(e\.label \|\| e\.relation/, '边描述 e.label'],
    [/\+\s*other\s*\+/, '关系网邻居名 other'],
    [/\+\s*label\s*\+/, '局部 label'],
    [/\+\s*truncate\(ed\.label/, '关系描述 truncate(ed.label…)'],
  ]
  const hits = RISKY.filter(([re]) => re.test(seg)).map(([, name]) => name)
  assert.deepEqual(hits, [], '★ 这些位置还在裸拼模型数据：' + hits.join(' / '))
  // 反证：判据能命中（拿旧写法喂进去必须被抓）
  const oldSnippet = "tooltip.innerHTML = '...>' + e.source + ' ↔ ' + e.target + '</div>';"
  assert.ok(RISKY[0][0].test(oldSnippet) || RISKY[1][0].test(oldSnippet), '对照：判据必须能命中旧写法')
  // 该区段确实在用 esc（不是把所有拼接删掉了事）
  const escCount = (seg.split('esc(').length - 1)
  assert.ok(escCount >= 10, '关系网区段里 esc( 覆盖不足：' + escCount)
})

// ════════════════════════════════════════════════════════════════
// ④ 世界书正文进 textarea 必须转义
// ════════════════════════════════════════════════════════════════
test('④ 世界书条目正文进 <textarea> 前必须 esc(...)', () => {
  assert.ok(BUNDLE.includes("' + esc(entry.content || '') + '</textarea>'"), '★ 正文必须转义')
  assert.ok(!BUNDLE.includes("' + (entry.content || '') + '</textarea>'"), '★ 不该再有裸正文')
  // 名称 / 关键词统一走 escAttr
  assert.ok(/escAttr\(entry\.comment \|\| entry\.name \|\| ''\)/.test(BUNDLE), '条目名称要走 escAttr')
  assert.ok(/escAttr\(\(entry\.keys \|\| entry\.keywords \|\| \[\]\)\.join\(', '\)\)/.test(BUNDLE), '关键词要走 escAttr')
  // 反例：判据对旧写法必须为真
  const oldLine = "html += '<textarea ...>' + (entry.content || '') + '</textarea>';"
  assert.ok(oldLine.includes("+ (entry.content || '') + '</textarea>'"), '对照：旧写法必须被判据命中')
})

test('⑤ 面板里那段「能拿到就危险」的说明不含现成注入载荷（防自投毒）', () => {
  // 面板/文档里若直接写入 onerror= 之类示例，等于把 payload 发给了所有人 —— 一律不许出现。
  const BAD = [/onerror\s*=\s*alert/i, /<script>fetch\(/i]
  for (const re of BAD) assert.ok(!re.test(BUNDLE), '★ bundle 里出现了可复制的注入载荷：' + re)
})

// ════════════════════════════════════════════════════════════════
// ⑥⑦ 2.7.6：issue #14 的同类残留 —— 预设名裸拼进 innerHTML
//    数据源是用户/服务端填的预设名（不是模型输出），严重度低于 #14，
//    但「导入预设」这条路径能由外部文件把名字带进来，所以一并堵上。
// ════════════════════════════════════════════════════════════════
test('⑥ 预设名一律 esc(...)：导入提示 / 当前预设 / 当前编辑', () => {
  const SPOTS = [
    // 只钉「导入提示」那一行：别处还有 '+ pname +'，但那是 showConfirm() 弹窗（走 textContent，不是 innerHTML）
    ["已导入预设「' + esc(pname) + '」", "已导入预设「' + pname + '」"],
    ["'✅ 当前预设：' + esc(presetLabelText) + '<br>", "'✅ 当前预设：' + (data.presetName || '默认预设') + '<br>"],
    ["'✅ 当前编辑：' + esc(currentPreset ? currentPreset.name : '默认预设')", "'✅ 当前编辑：' + (currentPreset ? currentPreset.name : '默认预设')"],
  ]
  const bad = []
  for (const [fixed, raw] of SPOTS) {
    if (!BUNDLE.includes(fixed)) bad.push('缺转义写法：' + fixed)
    if (BUNDLE.includes(raw)) bad.push('★ 仍在裸拼：' + raw)
  }
  assert.deepEqual(bad, [], bad.join(String.fromCharCode(10)))
  // 反证：判据不是永真 —— 修复前的写法必须能被同一组判据认出来
  const before = "st.innerHTML = '✅ 已导入预设「' + pname + '」，自动清理了 <b>'"
  assert.ok(before.includes("+ pname +"), '对照：旧写法必须能被判据识别（否则这条护栏是空的）')
})

test('⑦ 「修正绿字」不许再从 innerHTML 里字符串反查', () => {
  // 为什么单列一条：原代码写进去再从 innerHTML 反查替换。若只在写入端加 esc()，
  // 读回来的 & " ' 已被浏览器解码，反查串（未解码）对不上 ⇒ 名字含引号时修正静默失效。
  // 所以正确姿势是「先定好最终文本 → 转义 → 写一次」。
  assert.ok(!BUNDLE.includes("presetStatus.innerHTML.replace('当前预设：'"),
    '★ 还在用 innerHTML 反查：esc 写进去、读回来已被解码，名字含引号时替换会失配')
  assert.ok(BUNDLE.includes("var presetLabelText = String(data.presetName || '默认预设');"),
    '应当先把最终文本定好，再转义写一次')
  assert.ok(BUNDLE.includes('if (presetLabelEl2 && presetLabelEl2.textContent) presetLabelText = presetLabelEl2.textContent;'),
    '★ 「以下拉框为准」的修正行为必须保留 —— 不能因为加转义就把功能弄丢')
})
