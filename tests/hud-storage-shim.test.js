/**
 * HUD 存储垫片的**行为**测试（issue #16）。
 *
 * `hud-sandbox.test.js` 只会静态比对源码字符串；这里把 bundle 里的垫片**真的跑起来**，
 * 验证它在沙盒语义下确实救得回卡脚本。钉四件事：
 *
 *   ① 不透明源：原生 localStorage getter 抛 SecurityError 时，
 *      `DOMContentLoaded` 回调里第一句摸 storage **不会**再打断后面语句（这就是用户报的症状根因）；
 *   ② 垫片**不覆盖**可用的原生存储（往返写读判断，不是「抛不抛」）；
 *   ③ 内存实现对齐 Storage 接口且永不抛错，L: / S: 两个库不串键；
 *   ④ 注入点真的在文档最前面（<head> 之后），且不误伤 <script> 字面量里的 "<head>"。
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

/** 取出 HUD 段的源码切片（垫片常量 + 三个辅助函数都在这里）。 */
function hudSource() {
  const a = BUNDLE.indexOf('// ── ② HUD 沙盒核心')
  const b = BUNDLE.indexOf('function decorateMessages()')
  assert.ok(a > 0 && b > a, '找不到 HUD 段（改名/搬家时这个测试要一起改）')
  return BUNDLE.slice(a, b)
}

/**
 * 取出 `var HUD_STORAGE_SHIM_JS = …` 这条**完整的声明语句**。
 *
 * 不用「找 `';` 结尾」—— 工作树是 CRLF（AGENTS.md §7.4），按 `'\;\n` 找会假失败。
 * 改用常量自己的收尾标记 `"})();';"` 定位：那是垫片 IIFE 的最后一段，唯一。
 * @returns {string} 可直接求值的声明语句
 */
function shimDecl() {
  const src = hudSource()
  const i = src.indexOf('var HUD_STORAGE_SHIM_JS = ')
  assert.ok(i >= 0, '找不到 HUD_STORAGE_SHIM_JS 定义')
  const endMark = "})();';"
  const j = src.indexOf(endMark, i)
  assert.ok(j > i, '找不到 HUD_STORAGE_SHIM_JS 的结尾标记')
  return src.slice(i, j + endMark.length)
}

/**
 * 拿到垫片的**字符串值**（它是 `var X = '…' + '…';` 这种拼接）。
 * 做法：把声明在干净沙箱里求值，直接读出真实字符串 —— 不手工剥引号。
 */
function shimJs() {
  const box = {}
  vm.createContext(box)
  vm.runInContext(shimDecl() + '\nthis.__shim = HUD_STORAGE_SHIM_JS', box)
  const js = box.__shim
  assert.equal(typeof js, 'string')
  assert.ok(js.includes('__tavernStorageShimOn'), '取到的不是垫片源码')
  return js
}

/** 造一个「不透明源」的假 window：摸 localStorage 就抛 SecurityError。 */
function opaqueWindow() {
  const win = {}
  Object.defineProperty(win, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.') }
  })
  Object.defineProperty(win, 'sessionStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.') }
  })
  return win
}

/**
 * 在给定 window 上跑垫片。
 *
 * ★ 必须补 `win.window = win` 这个自引用：垫片里写的是 `Object.defineProperty(window, …)`
 * 与 `window[name]`，用的是**裸全局 `window`**。在 vm 沙箱里 `box.window = win` 之后，
 * `window` 解析到 win，于是 `def()` 会把访问器定义在 win 上 —— 但如果 win 自己不是
 * 「类 window 对象」（没有 window 自引用），有些路径会走到 `window.localStorage = val`
 * 的分支上而静默失败。真浏览器里 `window.window === window` 恒成立，夹具要同构。
 * @param {object} win
 * @returns {object} 同一个 win
 */
function runShim(win) {
  win.window = win
  const box = { window: win }
  vm.createContext(box)
  vm.runInContext(shimJs(), box)
  return win
}

test('① 垫片救回 DOMContentLoaded：第一句摸 storage 不再打断后面语句', () => {
  const win = opaqueWindow()
  runShim(win)

  // 复现卡的标准写法：回调第一行读 storage，后面才是真正干活的函数
  const order = []
  const initThemeToggle = () => order.push('theme:' + win.localStorage.getItem('storyTheme'))
  const formatMainText = () => order.push('maintext')
  const initRenderer = () => order.push('renderer')

  const onReady = () => {
    // ★ 这一句在没有垫片时抛 SecurityError ⇒ 后面三句全丢
    initThemeToggle()
    formatMainText()
    initRenderer()
  }
  assert.doesNotThrow(onReady, '★ 装了垫片后这个回调不许再抛')
  assert.deepEqual(order, ['theme:null', 'maintext', 'renderer'], '★ 三句都要执行到')

  // 对照臂：没有垫片时，同一段回调必须抛（证明①不是空转）
  const bare = opaqueWindow()
  assert.throws(
    () => { void bare.localStorage },
    /SecurityError/,
    '对照臂：未装垫片时摸 localStorage 必须抛（否则这条测试测不到东西）'
  )
})

test('② 原生存储可用时**不覆盖**（判据是可用性，不是「getter 抛不抛」）', () => {
  const mem = {}
  const real = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v) },
    removeItem: (k) => { delete mem[k] },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k] },
    key: (i) => Object.keys(mem)[i] ?? null,
  }
  Object.defineProperty(real, 'length', { get: () => Object.keys(mem).length })

  const win = { localStorage: real, sessionStorage: real }
  runShim(win)
  assert.equal(win.localStorage, real, '★ 原生可用时必须保留原对象（不许替换）')
  assert.equal(win.sessionStorage, real, '★ sessionStorage 同理')

  // getter 不抛、但根本没有 Storage 形状（无 getItem/setItem）⇒ 必须覆盖
  const broken = {}
  const win1b = { localStorage: broken }
  runShim(win1b)
  assert.notEqual(win1b.localStorage, broken, '★ 不是 Storage 形状 ⇒ 必须装垫片')
  assert.doesNotThrow(() => win1b.localStorage.setItem('k', 'v'), '垫片永不抛错')
  assert.equal(win1b.localStorage.getItem('k'), 'v', '垫片要真的存进去')

  // ★ 配额已满：setItem 抛 QuotaExceeded，但 getItem 正常、已有真实数据。
  //   这**不是**「存储不可用」—— 读和删照常，卡已存的偏好还在里面。
  //   旧实现只看 setItem 是否成功 ⇒ 误判为不可用 ⇒ 装上内存垫片覆盖真实存储
  //   ⇒ 卡片读不到已保存的主题（数据"凭空消失"）。这里钉死不许覆盖。
  const quotaMem = { storyTheme: 'night' }
  const quotaFull = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(quotaMem, k) ? quotaMem[k] : null },
    setItem() { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e },
    removeItem(k) { delete quotaMem[k] },
  }
  const win2 = { localStorage: quotaFull }
  runShim(win2)
  assert.equal(win2.localStorage, quotaFull, '★ 配额满 ≠ 不可用，不许覆盖真实存储')
  assert.equal(win2.localStorage.getItem('storyTheme'), 'night', '★ 已有数据必须还读得到')

  // ★ 反向对照臂：getter 不抛、getItem 正常，但**写入被安全策略拒绝**
  //   （SecurityError / InvalidStateError 那一类）⇒ 这**是**不可用，必须装垫片。
  //   这条是本次修复的核心判据。没有它，把「写入抛错一律判可用」的写法
  //   （或干脆删掉这条分支）也能让全部测试变绿 —— 复核用变异验证证实过。
  const insecure = {
    getItem: () => null,
    setItem() { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e },
    removeItem() {},
  }
  const win3 = { localStorage: insecure }
  runShim(win3)
  assert.notEqual(win3.localStorage, insecure, '★ 写入被 SecurityError 拒绝 ⇒ 必须装垫片')
  assert.doesNotThrow(() => win3.localStorage.setItem('k', 'v'), '垫片永不抛错')
  assert.equal(win3.localStorage.getItem('k'), 'v', '垫片要真的能存')

  // 静默无操作（setItem 不抛但写不进去）⇒ 也必须判不可用
  const silent = {
    getItem: () => null,
    setItem: () => {},      // 什么都不做，不抛
    removeItem: () => {},
  }
  const win4 = { localStorage: silent }
  runShim(win4)
  assert.notEqual(win4.localStorage, silent, '★ 静默无操作的写入 ⇒ 判不可用并装垫片')
  assert.doesNotThrow(() => win4.localStorage.setItem('k', 'v'), '垫片永不抛错')
  assert.equal(win4.localStorage.getItem('k'), 'v', '垫片要真的能存')
})

test('③ 内存实现对齐 Storage 接口、永不抛错、两个库不串键', () => {
  const win = opaqueWindow()
  runShim(win)
  const L = win.localStorage
  const S = win.sessionStorage

  // 接口齐全
  for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
    assert.equal(typeof L[m], 'function', 'localStorage 缺方法：' + m)
  }
  assert.equal(typeof L.length, 'number', 'localStorage 要有 length')

  // 往返
  L.setItem('a', '1')
  assert.equal(L.getItem('a'), '1')
  L.setItem('a', '2')
  assert.equal(L.getItem('a'), '2', '重复写要覆盖')
  L.removeItem('a')
  assert.equal(L.getItem('a'), null, '删掉后读回 null（不是 undefined）')
  assert.equal(L.getItem('nope'), null, '不存在的键读回 null')

  // 命名空间分离：同一个键名在两个存储里不串
  L.setItem('storyTheme', 'night')
  S.setItem('storyTheme', 'day')
  assert.equal(L.getItem('storyTheme'), 'night', '★ L: / S: 前缀必须分命名空间')
  assert.equal(S.getItem('storyTheme'), 'day')

  // length / key / clear
  L.clear()
  assert.equal(L.length, 0, 'clear 后 length 归零')
  assert.equal(L.getItem('storyTheme'), null)
  assert.equal(S.getItem('storyTheme'), 'day', '★ 清 localStorage 不许连坐 sessionStorage')

  L.setItem('x', '1')
  L.setItem('y', '2')
  assert.equal(L.length, 2)
  assert.equal(L.key(0), 'x', 'key(0) 返回第一个键名')
  assert.equal(L.key(99), null, '越界 key 返回 null')
  assert.equal(L.key(-1), null, '负数 key 返回 null')

  // 永不抛错：非法入参
  assert.doesNotThrow(() => L.setItem(null, null), 'setItem(null,null) 不许抛')
  assert.doesNotThrow(() => L.getItem(undefined), 'getItem(undefined) 不许抛')
  assert.doesNotThrow(() => L.key(NaN), 'key(NaN) 不许抛')

  // 幂等：再跑一遍垫片不许重装（否则内存数据会被清空）
  L.setItem('keep', 'me')
  runShim(win)
  assert.equal(L.getItem('keep'), 'me', '★ 垫片幂等：重跑不许丢掉已有数据')
})

test('④ 注入点：<head> 之后、早于卡自己的脚本，且不误伤 <script> 字面量', () => {
  // 把三个辅助函数抠出来跑（它们不依赖 HUD 段里的其它状态）
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    shimDecl() + '\n' +
    extractFn(BUNDLE, 'function hudScriptRanges(') + '\n' +
    extractFn(BUNDLE, 'function hudFirstSafeTagEnd(') + '\n' +
    extractFn(BUNDLE, 'function hudStorageShim(') + '\n' +
    'this.__shim = hudStorageShim',
    box
  )
  const shim = box.__shim

  // 标准整页：垫片在 <head> 之后、卡脚本之前
  const page = '<!doctype html><html><head><title>t</title></head><body><script>var a=1</script></body></html>'
  const out = shim(page)
  const headEnd = out.indexOf('</head>')
  const shimAt = out.indexOf('__tavernStorageShimOn')
  const cardScript = out.indexOf('var a=1')
  assert.ok(shimAt > 0, '垫片要插进去')
  assert.ok(shimAt < headEnd, '★ 垫片要在 </head> 之前')
  assert.ok(shimAt < cardScript, '★ 垫片必须早于卡自己的脚本')
  assert.ok(out.includes('<!doctype html>'), '原文一个字都不许丢')

  // 幂等
  assert.equal(shim(out), out, '★ 已装过就原样返回（浮窗路径会重跑）')

  // 不误伤 <script> 字面量里的 "<head>"
  const tricky = '<!doctype html><html><body><script>var s = "<head>";</script></body></html>'
  const out2 = shim(tricky)
  assert.ok(out2.includes('var s = "<head>";'), '★ 卡脚本里的 "<head>" 字面量不许被当成注入点')
  assert.ok(out2.indexOf('__tavernStorageShimOn') < out2.indexOf('var s ='), '垫片仍要早于那段脚本')

  // 退化分支：无 head → <html> 之后
  const noHead = '<!doctype html><html><body><p>x</p></body></html>'
  const out3 = shim(noHead)
  assert.ok(out3.indexOf('<html>') < out3.indexOf('__tavernStorageShimOn'), '退化：插在 <html> 之后')
  assert.ok(out3.indexOf('__tavernStorageShimOn') < out3.indexOf('<body>'), '退化：仍在 body 之前')

  // 退化分支：完全没有外壳的裸片段 → 整段前置
  const frag = '<div class="x">hi</div>'
  const out4 = shim(frag)
  assert.ok(out4.indexOf('__tavernStorageShimOn') >= 0, '裸片段也要装垫片')
  assert.ok(out4.includes('<div class="x">hi</div>'), '★ 裸片段内容一个字都不许丢')
})

test('④-b 注入点：注释里的 "<head>" 不许骗过垫片（否则插进注释、静默失效）', () => {
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    shimDecl() + '\n' +
    extractFn(BUNDLE, 'function hudScriptRanges(') + '\n' +
    extractFn(BUNDLE, 'function hudFirstSafeTagEnd(') + '\n' +
    extractFn(BUNDLE, 'function hudStorageShim(') + '\n' +
    'this.__shim = hudStorageShim',
    box
  )
  const shim = box.__shim

  // 卡文档里写着 `<!-- <head> -->`：只排除 <script> 的实现会把垫片插进注释**内部**
  // ⇒ 垫片变成一段注释文本、静默失效，而卡照旧被 SecurityError 打断（症状完全不变、无报错）。
  const doc = '<html><!-- <head> --><head></head><body><script>var a=1</script></body></html>'
  const out = shim(doc)
  const at = out.indexOf('__tavernStorageShimOn')
  const commentEnd = out.indexOf('-->')
  const headEnd = out.indexOf('</head>')
  assert.ok(at > 0, '垫片要插进去')
  assert.ok(
    at > commentEnd,
    '★ 垫片不许落在注释内部（那样它会变成注释文本、完全失效）'
  )
  assert.ok(at < headEnd, '★ 垫片仍要在 </head> 之前')
  assert.ok(out.indexOf('var a=1') > at, '垫片仍要早于卡脚本')
})

test('④-c 注入点：不许把 <!doctype> 挤到后面（会掉进 quirks mode）', () => {
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    shimDecl() + '\n' +
    extractFn(BUNDLE, 'function hudScriptRanges(') + '\n' +
    extractFn(BUNDLE, 'function hudFirstSafeTagEnd(') + '\n' +
    extractFn(BUNDLE, 'function hudStorageShim(') + '\n' +
    'this.__shim = hudStorageShim',
    box
  )
  const shim = box.__shim

  // 只有 doctype + body 的极简整页（无 <html>/<head>）→ 走最后一条退化分支。
  // 无脑 `tag + s` 会把 doctype 推到后面 ⇒ 沙盒 iframe 进 **quirks mode**，
  // 盒模型与百分比高度全变（状态栏高度/布局问题的高发区）。
  const doc = '<!doctype html><body><div>x</div></body>'
  const out = shim(doc)
  assert.ok(
    out.trimStart().toLowerCase().startsWith('<!doctype'),
    '★ doctype 必须仍在文档最前面，实际开头：' + JSON.stringify(out.slice(0, 30))
  )
  assert.ok(out.indexOf('__tavernStorageShimOn') > 0, '垫片要插进去')
  assert.ok(out.indexOf('__tavernStorageShimOn') < out.indexOf('<body>'), '垫片要在 body 之前')
  assert.ok(out.includes('<div>x</div>'), '正文一个字都不许丢')
})

test('⑤ hudBootstrap 把垫片产物交进去（接线，不看就全是空转）', () => {
  const boot = extractFn(BUNDLE, 'function hudBootstrap(')
  assert.match(boot, /html = hudStorageShim\(html\)/, '★ 入口必须真的把 html 过一遍垫片')
  // 垫片要在拼 srcdoc 之前生效：赋值出现在 `var js =` 之前
  assert.ok(
    boot.indexOf('hudStorageShim(html)') < boot.indexOf('var js ='),
    '★ 垫片必须在组装引导脚本之前应用'
  )
})
