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

/** 用户截图里那条回复的形态（去掉正文细节，保留标签结构）。 */
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
