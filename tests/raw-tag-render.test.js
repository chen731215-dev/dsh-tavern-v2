/**
 * 裸标签兜底渲染：`<options>` / `<option>` / `<details>` / `<game>` 的切段解析。
 *
 * 用户 2026-11-01 反馈：模型在正常正文后面追加
 *
 *   </game> <summary>…</summary> <details><summary>折叠标题甲</summary>…</details>
 *   <options><option>😊 …</option><option>😼 …</option></options>
 *
 * 时，界面上**原样露出尖括号文本**（没有折叠块、没有选项按钮）。实测两张标签表都不认：
 *   · muv-engine 的 `_tavernRenderTags` / `MUV_TAG_RULES` 只认 `<choices>` / `<choice>`；
 *   · `<game>` 与裸 `<summary>` 两边都没有渲染器。
 * 于是本插件在 `decorateMessages()` 里补一段兜底（`renderRawTagBlocks`）。
 *
 * 这套件只测**纯函数** `splitRawTagSegments()`（不碰 DOM），钉三件事：
 *   ① 三类片段（text / fold / options）都切得出来；
 *   ② 容错：标签不配对时**只丢标签、不吞正文**（宁可少渲染，也不许吃掉正文）——
 *      这条是本轮最容易被"顺手优化"掉的：用 `[\s\S]*` 贪婪配对的实现会把 `</game>`
 *      当作 `<details>` 的开头，直接把后文全吃掉；
 *   ③ 反例：贪婪实现必须被 ② 抓住（证明判据不是永真）。
 *
 * 运行：node --test tests/raw-tag-render.test.js
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

/** 把 `splitRawTagSegments` 连同它依赖的 RAW_TAG_RE 一起装进干净沙箱。 */
function loadSplitter() {
  const reLine = BUNDLE.split('\n').find((l) => l.includes('var RAW_TAG_RE ='))
  assert.ok(reLine, '★ 找不到 RAW_TAG_RE —— 它是切段器的判据，改名/搬家时这个测试必须一起改')
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    reLine.trim() + '\n' + extractFn(BUNDLE, 'function splitRawTagSegments(') +
    '\nthis.__split = splitRawTagSegments;',
    box,
  )
  return box.__split
}

/** 模型追加那类标签时的**形态**（内容全是占位符，不取任何真实正文）。 */
const CASE_USER = [
  '「正文首行甲」',
  '',
  '</game> <summary>元摘要甲。</summary>',
  '<details><summary>折叠标题甲</summary>折叠正文甲</details>',
  '<options><option>😊 选项甲。</option>',
  '<option>😼 选项乙。</option></options>',
].join('\n')

test('① 三类片段都切得出来：正文 / 折叠块 / 选项组', () => {
  const split = loadSplitter()
  const segs = split(CASE_USER)
  const kinds = segs.map((s) => s.kind)
  assert.ok(kinds.includes('text'), '要有正文片段，kinds=' + kinds)
  assert.ok(kinds.includes('fold'), '要有折叠块片段，kinds=' + kinds)
  assert.ok(kinds.includes('options'), '要有选项组片段，kinds=' + kinds)

  const fold = segs.find((s) => s.kind === 'fold')
  assert.equal(fold.title, '折叠标题甲', '折叠块标题取自 <summary>')
  assert.match(fold.text, /折叠正文甲/, '折叠块正文要保留')

  const opts = segs.find((s) => s.kind === 'options')
  assert.equal(opts.items.length, 2, '两个 <option> ⇒ 两个选项')
  assert.match(opts.items[0], /选项甲/, '选项文本取标签内文本')
  assert.ok(!opts.items[0].includes('<'), '选项文本里不许残留尖括号')
})

test('② 裸标签只丢标签，正文一个字都不许吞', () => {
  const split = loadSplitter()
  const segs = split(CASE_USER)
  const allText = segs.map((s) => [s.text || '', s.title || '', (s.items || []).join('')].join('')).join('')
  for (const needle of ['正文首行甲', '元摘要甲', '折叠正文甲', '选项甲', '选项乙']) {
    assert.ok(allText.includes(needle), '★ 正文被吞了：' + needle + '\n产出=' + JSON.stringify(segs))
  }
  // 裸的 `</game>` / 裸 `<summary>` 不许复活成标签文本
  assert.ok(!allText.includes('</game>'), '★ </game> 应当被剥掉')
  assert.ok(!/(^|\s)<summary>/.test(allText), '★ 裸 <summary> 应当被剥掉（只剩标签内的文字）')
})

test('②-b 反例：贪婪配对实现必须被 ② 抓住', () => {
  const split = loadSplitter()
  // 复刻一个「<details>[\s\S]*?</details> 乱配对」的实现：把 </game> 之后全吞进折叠块
  const greedy = (text) => {
    const m = /<details\b[^>]*>([\s\S]*?)<\/details>/i.exec(text)
    return m ? [{ kind: 'fold', title: '', text: m[1] }] : [{ kind: 'text', text }]
  }
  const greedyOut = greedy(CASE_USER)
  const greedyText = greedyOut.map((s) => [s.text || '', s.title || ''].join('')).join('')
  assert.ok(!greedyText.includes('正文首行甲'),
    '反例应当丢掉前置正文 —— 否则这条判据是永真的（说明 ② 测不出问题）')
  const good = split(CASE_USER)
  assert.ok(good.map((s) => s.text || '').join('').includes('正文首行甲'),
    '★ 真实现必须保住前置正文')
})

test('③ 幂等判据存在：指纹比较是「切会话不重复渲染」的机制', () => {
  // 机制而不是时序：整条消息算一次 FNV-1a 指纹，渲染完写回 data-tavern-raw-sig，
  // 下一轮读到同一个值直接返回。这里只钉「两半都在」，避免有人把它换成时间窗口。
  assert.match(BUNDLE, /function rawSigOf\(str\)/)
  assert.match(BUNDLE, /RAW_DONE_ATTR = 'data-tavern-raw-sig'/)
  assert.match(BUNDLE, /root\.getAttribute\(RAW_DONE_ATTR\) === sig\) return/)
  assert.match(BUNDLE, /root\.setAttribute\(RAW_DONE_ATTR, String\(rawSigOf\(root\.textContent/)
})

/**
 * ④ 孤儿包裹标签（2.7.31 真机截图）：`<theater>` / `<recap>` / 裸 `<summary>`。
 *
 * 这些标签**没有任何渲染器**（muv 只认 choices；本插件的 findRawTagBlocks 只收
 * 完整的 details/options），模型拿它们当外壳时，界面上就会原样露出尖括号：
 *
 *   <theater>
 *   ▸ 小剧场（折叠块）
 *   </theater><recap>
 *   ▸ 小结（折叠块）
 *   </recap>
 *
 * 处理原则仍然是「只丢标签、正文一个字符都不动」，而且要跳过 pre/code ——
 * 回答里贴的代码示例就是字面量，不许被清洗。
 */
test('④ 孤儿包裹标签只丢标签：theater / recap / 裸 summary', () => {
  const line = BUNDLE.split('\n').find((l) => l.includes('var ORPHAN_TAG_RE ='))
  assert.ok(line, '★ 找不到 ORPHAN_TAG_RE —— 改名/搬家时这个测试必须一起改')
  const box = {}
  vm.createContext(box)
  vm.runInContext(line.trim() + '\nthis.__re = ORPHAN_TAG_RE;', box)
  const strip = (s) => s.replace(new RegExp(box.__re.source, 'gi'), '')

  const input = '<theater>\n【小剧场】甲\n</theater><recap>\n【小结】乙\n</recap>'
  const out = strip(input)
  assert.ok(!/<\/?theater\b/i.test(out), '★ <theater> 必须被剥掉（真机截图里它就露在外面）')
  assert.ok(!/<\/?recap\b/i.test(out), '★ <recap> 必须被剥掉')
  assert.match(out, /【小剧场】甲/, '正文一个字都不许吞')
  assert.match(out, /【小结】乙/, '正文一个字都不许吞')

  // 截图 3 那种裸 summary（没有 details 包着）
  assert.equal(strip('<summary>2025年6月1日 14:20，甲。</summary>'), '2025年6月1日 14:20，甲。')
})

test('④-b 调用时机：必须在块渲染**之后**，且跳过代码块', () => {
  const body = extractFn(BUNDLE, 'function renderRawTagBlocks(')
  const iApply = body.indexOf('applyRawTagBlock(')
  const iStrip = body.lastIndexOf('stripOrphanTags(root)')
  assert.ok(iApply > 0, '块渲染调用不见了')
  assert.ok(iStrip > 0, '★ 孤儿标签清洗没接进 renderRawTagBlocks')
  assert.ok(iStrip > iApply, '★ 必须先渲染块再清洗：先清洗会把 details 里的 <summary> 一起删掉')

  const stripFn = extractFn(BUNDLE, 'function stripOrphanTags(')
  assert.match(stripFn, /pre, code/, '★ 必须跳过 pre/code（代码示例里的字面量不许动）')
  assert.match(stripFn, /data-tavern-raw-block/, '已经渲染出来的块不许再进去改')
})

/**
 * ⑤ 引导句 + 有序列表 → 选项按钮（2.7.32）。
 *
 * 真机现场：模型这一轮没按 `<option>` 写，而是「接下来你想怎么做？」+ Markdown 有序列表。
 * 上一轮同位置是可点卡片，这一轮变成三段死文字 —— 用户看到的就是"选项错位"。
 * 判据必须保守：正文里的步骤列表（"第一…第二…"）绝不能被做成按钮。
 */
test('⑤ 引导句判据：认得出问句，不误伤正文段落', () => {
  const fn = extractFn(BUNDLE, 'function looksLikeOptionPrompt(')
  const box = {}
  vm.createContext(box)
  vm.runInContext(fn + '\nthis.__looks = looksLikeOptionPrompt;', box)
  const looks = box.__looks

  assert.equal(looks('接下来你想怎么做？'), true, '真机截图 2 就是这句')
  assert.equal(looks('请选择：'), true, '冒号收尾也算')
  assert.equal(looks('你打算如何行动?'), true, '半角问号也要认')
  assert.equal(looks('接下来你想怎么做'), false, '没有问号/冒号 ⇒ 不当引导句（防误伤正文）')
  assert.equal(looks('第三章我们去了码头。'), false, '陈述句不是引导句')
  assert.equal(looks('一'.repeat(80) + '怎么做？'), false, '过长段落不当引导句')
})

test('⑤-b 转换条件：只动末尾那个列表，且复用既有按钮样式', () => {
  const body = extractFn(BUNDLE, 'function renderListOptions(')
  assert.match(body, /ols\[ols\.length - 1\]/, '只处理最后一个 ol（选项永远在回答末尾）')
  assert.match(body, /isIgnorableTailNode/, '后面还有正文就不许换')
  assert.match(body, /items\.length < 2 \|\| items\.length > LIST_OPT_MAX/, '项数限制 2–6')
  assert.match(body, /LIST_OPT_TEXT_MAX/, '单项长度要有上限')
  assert.match(body, /li\.querySelector\('a, img, code, pre, ul, ol'\)/, '富文本/嵌套列表一律不换')
  assert.match(body, /pre, code/, '跳过代码块')
  assert.match(body, /tavern-option-btn/, '必须复用既有按钮样式（文档级点击委托只认它）')
  assert.match(body, /data-opt/, '必须带 data-opt —— 点击委托靠它取选项文本')
  assert.match(body, /replaceChild\(box, ol\)/, '要替换而不是叠加')

  const deco = extractFn(BUNDLE, 'function decorateMessages(')
  assert.ok(deco.indexOf('renderListOptions(') > deco.indexOf('renderRawTagBlocks('), '必须在标签兜底之后跑')
})

/**
 * ⑥ 孤儿标签的**通用兜底** + 状态栏置底（2.7.35 真机）。
 *
 * 现场：一条消息里同时冒出 <draft_notes> / <bginfor> / <catsay> / <CEstuff> /
 * <VariableCheck> —— 名字是穷举不完的（模型每次都能造新的），所以除了白名单，
 * 还要一条"整行只有标签就整行清掉"的通用规则。
 */
test('⑥ 整行标签通用清理：未知标签名也吃得住，正文不受影响', () => {
  const line = BUNDLE.split('\n').find((l) => l.includes('var ORPHAN_LINE_RE ='))
  assert.ok(line, '★ 找不到 ORPHAN_LINE_RE')
  const box = {}
  vm.createContext(box)
  vm.runInContext(line.trim() + '\nthis.__re = ORPHAN_LINE_RE;', box)
  const isTagLine = (s2) => box.__re.test(s2.trim())

  assert.equal(isTagLine('<bginfor>'), true, '独占一行的标签')
  assert.equal(isTagLine('</catsay> <CEstuff>'), true, '一行多个标签也要认')
  assert.equal(isTagLine('<some_future_tag attr="1">'), true, '★ 未知标签名必须兜得住')
  assert.equal(isTagLine('正文在 <b> 这里'), false, '夹在正文里的标签不算整行')
  assert.equal(isTagLine('<details><summary>标题</summary></details>'), false, '含正文的块不是"整行标签"')
  assert.equal(isTagLine('   '), false, '空白行不处理')

  // 白名单也要覆盖这轮真机见到的名字（用正则行为测，别测字符串 —— `draft_?notes` 这种写法
  // 在源码里是转义过的，字符串包含断言会误判）
  const tagLine = BUNDLE.split('\n').find((l) => l.includes('var ORPHAN_TAG_RE ='))
  const tagBox = {}
  vm.createContext(tagBox)
  vm.runInContext(tagLine.trim() + '\nthis.__tag = ORPHAN_TAG_RE;', tagBox)
  for (const name of ['draft_notes', 'bginfor', 'catsay', 'CEstuff', 'VariableCheck']) {
    assert.ok(new RegExp(tagBox.__tag.source, 'i').test('<' + name + '>'), '白名单缺 ' + name)
  }
})

test('⑥-b 状态栏置底：只搬 .muv-statusbar-wrap，幂等且最多 3 次（防与 muv 打架）', () => {
  const body = extractFn(BUNDLE, 'function moveMuvStatusToBottom(')
  assert.match(body, /'\.muv-statusbar-wrap'/, '只搬 muv 的状态栏，别碰别的卡')
  assert.match(body, /data-tavern-sb-moves/, '必须有搬运次数记录')
  assert.match(body, /moves >= 3/, '★ 必须封顶：muv 的 observer 可能把卡片放回去，来回搬会死循环')
  assert.match(body, /el\.parentElement === trailer\) continue/, '已经在末尾就不动（幂等）')
  assert.match(body, /tavern-status-trailer/, '落到统一的 trailer 容器里')

  const deco = extractFn(BUNDLE, 'function decorateMessages(')
  assert.ok(deco.indexOf('moveMuvStatusToBottom(') > 0, '必须接进每轮装饰流程')
})

/**
 * ⑦ 过程块折叠 + 状态栏自动补齐（2.7.36，读样本卡后的结论）。
 *
 * 卡里只定义了 `<StatusPlaceHolderImpl/>`（regex_scripts 的「状态栏美化」负责渲染），
 * 而 `<draft_notes>` / `<VariableCheck>` 是**模型自己造的**：内容有用（剧情设计、
 * 状态实体核对），但不该摊在正文里。以前被当孤儿标签剥掉 ⇒ 一大段裸文本。
 */
test('⑦ draft_notes / VariableCheck 折成折叠块，内容不丢', () => {
  const split = loadSplitter()
  const a = split('<draft_notes>剧情设计：先让角色甲搬箱子。</draft_notes>')
  const fa = a.find((x) => x.kind === 'fold')
  assert.ok(fa, 'draft_notes 必须是 fold 片段，实际=' + JSON.stringify(a))
  assert.equal(fa.title, '📝 剧情设计')
  assert.match(fa.text, /先让角色甲搬箱子/, '内容一个字都不许丢')

  const b = split('<VariableCheck>【基础/状态核对】时间 14:00 -> 14:25</VariableCheck>')
  const fb = b.find((x) => x.kind === 'fold')
  assert.ok(fb, 'VariableCheck 必须是 fold 片段')
  assert.equal(fb.title, '🧾 状态核对')
  assert.match(fb.text, /14:25/)

  // 正文里只是提到这些词、没有成对标签时不受影响
  const c = split('普通正文，没写 draft_notes 标签。')
  assert.equal(c.filter((x) => x.kind === 'fold').length, 0)
})

test('⑦-b 状态栏自动补齐：只在缺占位符时补、只补最后一条、iframe 必须 sandbox', () => {
  const body = extractFn(BUNDLE, 'function ensureStatusBar(')
  assert.match(body, /StatusPlaceHolderImpl/, '已经带占位符的消息不许再补')
  assert.match(body, /muv-statusbar-wrap/, '已有 muv 状态栏就不补')
  assert.match(body, /auth === 'default'/, '非酒馆会话不许出状态栏')
  assert.match(body, /regexScripts/, '卡没有状态栏脚本时不许硬塞空框')
  assert.match(BUNDLE, /AUTOSB_ATTR = 'data-tavern-autosb'/, '必须有幂等标记常量')
  assert.match(body, /getAttribute\(AUTOSB_ATTR\)/, '必须幂等（每条消息只试一次）')

  const ins = extractFn(BUNDLE, 'function insertAutoStatusBar(')
  assert.match(ins, /setAttribute\('sandbox', 'allow-scripts'\)/, 'iframe 必须 sandbox=allow-scripts')
  assert.ok(!/allow-same-origin/.test(ins), '★ 绝不给 allow-same-origin（会把 srcdoc 变成同源注入点）')

  const deco = extractFn(BUNDLE, 'function decorateMessages(')
  assert.match(deco, /i === msgs\.length - 1/, '只给最后一条消息补（历史消息补了没人看）')
})

test('⑦-c 空列表项清理：只删"真空"的 li，含图/按钮的不动', () => {
  const body = extractFn(BUNDLE, 'function removeEmptyListItems(')
  assert.match(body, /textContent \|\| ''\)\.trim\(\)\) continue/, '有文字的一律保留')
  assert.match(body, /img, svg, iframe, button, video, audio/, '含图片/按钮的"看起来空"节点不许删')
  assert.match(body, /querySelectorAll\('ul, ol'\)/, '空列表本身也要收走')
})
