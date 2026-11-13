/**
 * HUD 沙盒：内容识别管线 + 沙盒约束 + 外壳分层。
 *
 * 用户 2026-11-04 的架构要求（原话）：
 *   「放弃在宿主页面直接操作 DOM，转而采用『外壳 + 沙盒』的分层架构……
 *     给 iframe 设置 sandbox="allow-scripts"，同时不添加 allow-same-origin……
 *     用 postMessage 替代直接 DOM 操作」
 *
 * 这套件钉四件事：
 *   ① 识别管线：整页 / 裸片段 / `<details>` / 纯文字 四种方言各走各的路；
 *   ② 沙盒属性：只有 allow-scripts（+ allow-forms），**绝不** allow-same-origin；
 *   ③ 通信：高度 / 上下文 / 开浮窗 / 关闭 四条 op，且只认自己那个 iframe 的消息；
 *   ④ 外壳：内嵌外壳只加一个「浮窗」按钮，浮窗外壳自己做拖动/缩放/记忆，
 *      核心不掺和几何。
 *
 * 运行：node --test tests/hud-sandbox.test.js
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

/** 抠出函数的完整源码（大括号配平，跳过字符串与行注释）。 */
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

/** 取一行 `var X = …;` 的定义。 */
function lineOf(src, prefix) {
  const line = src.split('\n').find((l) => l.trim().startsWith(prefix))
  if (!line) throw new Error('找不到定义：' + prefix)
  return line
}

/** 把管线（纯函数）装进干净沙箱。 */
function loadPipeline() {
  const src = [
    lineOf(BUNDLE, 'var HUD_DOC_MARK'),
    lineOf(BUNDLE, 'var HUD_FRAG_START'),
    lineOf(BUNDLE, 'var HUD_STYLE_TAG'),
    extractFn(BUNDLE, 'function unfenceCardHtml('),
    extractFn(BUNDLE, 'function wrapHudFragment('),
    extractFn(BUNDLE, 'function detectHudDialect('),
    extractFn(BUNDLE, 'function hudClampRect('),
  ].join('\n')
  const box = {}
  vm.createContext(box)
  vm.runInContext(src + '\nthis.__api = { detectHudDialect, wrapHudFragment, hudClampRect, unfenceCardHtml }', box)
  return box.__api
}

/** HUD 段的源码切片：从「② HUD 沙盒核心」到「③ 外壳适配器」之后（含浮窗实现）。 */
function hudSource() {
  const a = BUNDLE.indexOf('// ── ② HUD 沙盒核心')
  const b = BUNDLE.indexOf('function decorateMessages()')
  assert.ok(a > 0 && b > a, '找不到 HUD 段（改名/搬家时这个测试要一起改）')
  return BUNDLE.slice(a, b)
}

test('① 识别管线：整页 / 片段 / 折叠 / 文字 各走各的', () => {
  const { detectHudDialect } = loadPipeline()

  const doc = detectHudDialect('```html\n<!doctype html><html><body><div>x</div></body></html>\n```')
  assert.equal(doc.kind, 'document', '带 doctype 的整页（卡里最常见）')
  assert.match(doc.html, /^<!doctype html>/i, '围栏要去掉、页面原样保留')

  const frag = detectHudDialect('<div class="statusbar"><span>HP 80</span></div>')
  assert.equal(frag.kind, 'fragment', '裸片段要认出来')
  assert.match(frag.html, /^<!doctype html>/i, '★ 片段必须补成页面，否则卡里的 body 规则没有落点')
  assert.match(frag.html, /class="statusbar"/, '片段内容一个字都不许丢')

  const styled = detectHudDialect('<style>.a{color:red}</style><p class="a">hi</p>')
  assert.equal(styled.kind, 'fragment', '只有 <style> + 片段，也算 fragment')

  const details = detectHudDialect('<details><summary>变量更新</summary>{"hp":80}</details>')
  assert.equal(details.kind, 'details', '折叠块走本页 <details>，不进 iframe（否则点不开）')

  const text = detectHudDialect('HP 80/100 · MP 30/50')
  assert.equal(text.kind, 'text', '纯文字原样当文字')
  assert.equal(detectHudDialect('').kind, 'empty')
})

test('② 沙盒：只有 allow-scripts(+forms)，绝不 allow-same-origin', () => {
  const src = hudSource()
  assert.match(src, /setAttribute\('sandbox', 'allow-scripts allow-forms'\)/, '沙盒属性必须显式设置')
  // 只看**代码行**：注释里写着「绝不加 allow-same-origin」，那是说明不是属性
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  for (const l of codeLines) {
    assert.ok(!/allow-same-origin/.test(l), '★ 代码里绝不能出现 allow-same-origin：srcdoc 会变成同源注入点')
  }
  assert.match(src, /srcdoc = hudBootstrap\(/, '页面必须走 srcdoc 注入（不是本页 innerHTML）')
  // 核心不许用 innerHTML 拼卡内容（唯一允许的是建节点）
  assert.ok(!/\.innerHTML\s*=/.test(src), 'HUD 段不许出现 innerHTML 赋值')
})

test('③ 通信协议：四条 op，且只认自己那个 iframe', () => {
  const src = hudSource()
  for (const op of ['height', 'context', 'open-float', 'close']) {
    assert.ok(src.includes("'" + op + "'"), '缺协议 op：' + op)
  }
  assert.match(src, /rec\.frame\.contentWindow !== e\.source/, '★ 必须校验消息来源，防止同页别的 iframe 冒名')
  assert.match(src, /hudPost\(rec, 'context'/, '要能回上下文')
  assert.match(src, /Math\.min\(Math\.max\(want, HUD_MIN_H\), HUD_MAX_H\)/, '高度必须夹在上下限内（卡可能报 100000）')
  // ★ 这里曾经断言的是 `h + 8`。那 8px 把高度反馈回路变成了发散映射：
  //   整页状态栏卡普遍「撑满视口」，卡上报的 scrollHeight 恒等于当前 iframe 高度
  //   ⇒ 每轮 +8px 无限上涨（界面表现是消息下方一片不断变高的空白）。
  //   现在改为 `ceil(h)`（有不动点）+ 连续两次「上报 ≈ 现状」即锁定。
  //   收敛性本身由 tests/hud-height-convergence.test.js 用真实分支代码仿真钉住。
  assert.match(src, /var want = Math\.ceil\(h\)/, '★ 目标高度不许再加伪 padding（h+8 会让高度无限上涨）')
  assert.match(src, /rec\.steadyH >= 2/, '要有「连续两次上报≈现状就锁定」的保险')
  // 只看**代码行**：注释里会提到 `h + 8`（那是在解释为什么不能这么写）
  const codeOnly = src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')
  assert.ok(!/h \+ 8/.test(codeOnly), '★ 不许回到 h + 8：那不是余量，是棘轮')
  assert.match(src, /messageText: .*slice\(0, 20000\)/, '上下文里的消息正文必须截断')
  assert.ok(!/messages\s*:/.test(src), '不许把整段会话记录塞进沙盒')
})

test('③-b 引导脚本：只注入常量代码，不拼接卡内容', () => {
  const fn = extractFn(BUNDLE, 'function hudBootstrap(')
  assert.match(fn, /var tag = '<script>' \+ js \+ '<\\\/script>'/, '注入的只有脚本标签')
  assert.ok(!/\+\s*html\s*\+/.test(fn), '★ 引导脚本里不许拼卡内容（那会变成注入面）')
  assert.match(fn, /__tavernHud/, '要暴露一个有名字的 API 给愿意适配的卡')
  assert.match(fn, /post\("ready"\)/, 'load 之后要主动报到')
})

test('④ 外壳分层：内嵌只加浮窗按钮，浮窗自己管几何', () => {
  const inline = extractFn(BUNDLE, 'function hudShellInline(')
  assert.match(inline, /hudOpenFloat\(/, '内嵌外壳的按钮要能开浮窗')
  assert.ok(!/pointermove/.test(inline), '内嵌外壳不该自己处理拖动（那是浮窗外壳的事）')

  const open = extractFn(BUNDLE, 'function hudOpenFloat(')
  assert.match(open, /pointerdown/, '浮窗要能拖')
  assert.match(open, /nwse-resize/, '浮窗要能缩放')
  assert.match(open, /hudSaveRect\(/, '几何要记忆')
  assert.match(open, /Escape/, 'Esc 要能关')
  assert.match(open, /hudMount\(frameHtml, \{ shell: 'float'/, '浮窗复用同一个核心（不重跑卡脚本）')

  const clamp = extractFn(BUNDLE, 'function hudClampRect(')
  assert.match(clamp, /vw - w - 8/, '浮窗不许跑出视口')
})

test('⑤ 浮窗几何：夹边界是纯函数，可单测', () => {
  const { hudClampRect } = loadPipeline()
  const small = hudClampRect({ x: 0, y: 0, w: 100, h: 100 }, 1280, 800)
  assert.equal(small.w, 320, '过窄要抬到最小宽度')
  assert.equal(small.h, 220, '过矮要抬到最小高度')

  const out = hudClampRect({ x: 5000, y: 5000, w: 600, h: 400 }, 1280, 800)
  assert.equal(out.x, 1280 - 600 - 8, '跑出右下角要被拉回来')
  assert.equal(out.y, 800 - 400 - 8)

  const ok = hudClampRect({ x: 100, y: 50, w: 600, h: 400 }, 1280, 800)
  // 沙箱里造出来的对象原型与宿主不同，逐字段比（deepStrictEqual 会误判原型）
  assert.equal(ok.x, 100, '合法矩形原样返回 x')
  assert.equal(ok.y, 50, '合法矩形原样返回 y')
  assert.equal(ok.w, 600)
  assert.equal(ok.h, 400)
})
