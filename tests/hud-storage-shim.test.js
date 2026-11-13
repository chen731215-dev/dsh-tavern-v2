/**
 * HUD 沙盒存储垫片。
 *
 * 为什么单列一条：`sandbox="allow-scripts"` 的 iframe 是不透明源，`localStorage`
 * 的 getter 直接抛 SecurityError。而 ST 卡的习惯写法是在 `DOMContentLoaded` 回调
 * **第一行**读它 —— 一抛，同一回调里后面的 `formatMainText()` / `StoryRenderer.init()`
 * 全都不执行 ⇒ 正文空白、字段停在「加载中...」。
 *
 * 这个症状在真机上看起来像「一直在加载」，极容易被误判成「模型没出文」，
 * 所以必须有一条测试钉住它。
 *
 * 运行：node --test tests/hud-storage-shim.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
// ★ 归一化换行再切片：本仓 core.autocrlf=true ⇒ 工作树是 CRLF、blob 是 LF，
//   不归一的话同一段代码在两种检出的偏移与行尾都不同（AGENTS.md §12 的既有坑）。
const BUNDLE = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  .replace(/\r\n/g, '\n')

/** 垫片注入后留下的哨兵（用它判断「注入过没有」）。 */
const MARK = '__tavernStorageShimOn'

/**
 * 把 `var HUD_STORAGE_SHIM_JS = …;` 整条赋值取出来。
 *
 * 为什么不用大括号配平：它是一个几十行、每行都是字符串拼接的常量，拼接体内部
 * 有大量花括号（对象字面量、函数体），配平扫描必然截错。这里按「赋值末尾那一行」
 * 定位 —— 那是垫片 IIFE 的收尾，全文件唯一。
 */
function shimConstSource(src) {
  const start = src.indexOf('var HUD_STORAGE_SHIM_JS =')
  if (start < 0) throw new Error('找不到 HUD_STORAGE_SHIM_JS')
  const tail = "        + '})();';\n"
  const end = src.indexOf(tail, start)
  if (end < 0) throw new Error('找不到 HUD_STORAGE_SHIM_JS 的收尾行')
  return src.slice(start, end + tail.length)
}

/** 从 `function name(` 起到缩进 6 空格的那个收尾花括号为止。 */
function fnSource(src, name) {
  const sig = 'function ' + name + '('
  const start = src.indexOf(sig)
  if (start < 0) throw new Error('找不到函数：' + name)
  const close = '\n      }'
  const end = src.indexOf(close, start)
  if (end < 0) throw new Error('找不到函数收尾：' + name)
  return src.slice(start, end + close.length)
}

/** 把垫片相关的纯函数装进干净沙箱。 */
function loadShim() {
  const src = [
    shimConstSource(BUNDLE),
    fnSource(BUNDLE, 'hudScriptRanges'),
    fnSource(BUNDLE, 'hudInRanges'),
    fnSource(BUNDLE, 'hudFirstSafeTagEnd'),
    fnSource(BUNDLE, 'hudStorageShim'),
  ].join('\n')
  const box = {}
  vm.createContext(box)
  vm.runInContext(src + '\nthis.__api = { hudStorageShim, hudScriptRanges, HUD_STORAGE_SHIM_JS }', box)
  return box.__api
}

test('① 注入点：在 <head> 之后、且早于卡的任何脚本', () => {
  const { hudStorageShim } = loadShim()
  const page = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + '<script>var a=localStorage.getItem("k");</' + 'script>'
    + '<div id="maintext">x</div></body></html>'
  const out = hudStorageShim(page)
  const at = out.indexOf(MARK)
  assert.ok(at > 0, '垫片必须真的注入')
  assert.ok(out.indexOf('<head>') < at, '★ 垫片要落在 <head> 之后')
  assert.ok(at < out.indexOf('localStorage.getItem'), '★ 垫片必须早于卡自己的脚本')
})

test('② 幂等：二次调用不再插一份', () => {
  const { hudStorageShim } = loadShim()
  const page = '<html><head></head><body><div>x</div></body></html>'
  const once = hudStorageShim(page)
  const twice = hudStorageShim(once)
  assert.equal(twice, once, '★ 重复 bootstrap（浮窗路径会重跑）不得插入第二份')
})

test('③ 不误伤 <script> 字面量里的 <head>', () => {
  const { hudStorageShim } = loadShim()
  const page = '<html><head></head><body>'
    + '<script>var t="<head>";</' + 'script><div>x</div></body></html>'
  const out = hudStorageShim(page)
  const at = out.indexOf(MARK)
  const sOpen = out.indexOf('<script>var t=')
  const sClose = out.indexOf('</script>', sOpen)
  assert.ok(at > 0, '垫片要注入')
  assert.ok(at < sOpen || at > sClose, '★ 垫片不许被塞进脚本字符串（那会变成一段文本，静默失效）')
})

test('④ 退化：无 head 落 <html> 后，无外壳则整段前置', () => {
  const { hudStorageShim } = loadShim()
  const noHead = '<html><body><div>hi</div></body></html>'
  const a = hudStorageShim(noHead)
  assert.ok(a.indexOf(MARK) > a.indexOf('<html>'), '无 head 时落在 <html> 之后')
  assert.ok(a.indexOf(MARK) < a.indexOf('<body>'), '且要在 <body> 之前（仍是文档最前面）')

  const bare = '<div>hi</div>'
  const b = hudStorageShim(bare)
  assert.ok(b.startsWith('<script>'), '无外壳时整段前置')
  assert.ok(b.endsWith(bare), '原内容一个字都不许丢')
})

test('⑤ 垫片本身：原生可用时不覆盖，不可用时装 shim 且读写往返', () => {
  const { HUD_STORAGE_SHIM_JS } = loadShim()

  // 臂 A：原生可用 ⇒ 一律走原生，不许顶掉真存储
  const backing = new Map()
  const nativeApi = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, String(v)) },
    removeItem: (k) => { backing.delete(k) },
  }
  const boxA = { window: {} }
  Object.defineProperty(boxA.window, 'localStorage', { configurable: true, get: () => nativeApi })
  Object.defineProperty(boxA.window, 'sessionStorage', { configurable: true, get: () => nativeApi })
  vm.createContext(boxA)
  vm.runInContext(HUD_STORAGE_SHIM_JS, boxA)
  assert.equal(boxA.window.__tavernStorage.localStorage, 'native', '原生可用时不许覆盖')
  assert.equal(boxA.window.localStorage, nativeApi, '原生对象必须是原来那个')

  // 臂 B：原生不可用（抛 SecurityError）⇒ 装 shim
  const boom = () => { throw new Error('SecurityError: sandboxed') }
  const boxB = { window: {} }
  Object.defineProperty(boxB.window, 'localStorage', { configurable: true, get: boom })
  Object.defineProperty(boxB.window, 'sessionStorage', { configurable: true, get: boom })
  vm.createContext(boxB)
  vm.runInContext(HUD_STORAGE_SHIM_JS, boxB)
  assert.equal(boxB.window.__tavernStorage.localStorage, 'shim', '不可用时必须装 shim')
  boxB.window.localStorage.setItem('k', 'v')
  assert.equal(boxB.window.localStorage.getItem('k'), 'v', '★ 读写要能往返（卡的默认值分支依赖它）')
  assert.equal(boxB.window.localStorage.getItem('missing'), null, '缺键返回 null 而不是抛错')
  boxB.window.localStorage.clear()
  assert.equal(boxB.window.localStorage.getItem('k'), null, 'clear 要清干净')
  boxB.window.localStorage.setItem('a', 1)
  boxB.window.sessionStorage.setItem('a', 2)
  assert.equal(boxB.window.localStorage.getItem('a'), '1', '★ 两个存储不许串键（L: / S: 前缀）')
  assert.equal(boxB.window.sessionStorage.getItem('a'), '2')
  assert.equal(boxB.window.localStorage.length, 1, 'length 要跟着变')
})

test('⑥ hudBootstrap 必须调用垫片（否则前面五条都是空转）', () => {
  const start = BUNDLE.indexOf('function hudBootstrap(')
  assert.ok(start > 0, '找不到 hudBootstrap')
  const head = BUNDLE.slice(start, start + 400)
  assert.match(head, /html = hudStorageShim\(html\)/, '★ hudBootstrap 第一行就要过垫片')
})
