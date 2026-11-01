/**
 * 显示正则（ST 式输出侧脚本）—— **数据层**判据 + **客户端引擎**判据。
 *
 * 背景（用户 2026-11-01 实测）：预设里的「防截断」要求模型把露骨内容写成 `\uXXXX`，
 * 酒馆此前没有任何输出侧改写能力 ⇒ 每轮开头都是一片 `\u55b5\u545c…` 反斜杠乱码
 * （解压会话日志确认：一条消息里 184 处 `\u`，「喵呜」0 处 —— 模型是**照做**的）。
 *
 * ST 的解法是「输出侧正则脚本」（`regex_scripts`）。本插件照做，但**只作用于显示**：
 *   · 服务端 `lib/server/display-rules.js` = 规则表 / 校验 / ST 卡脚本导入（纯数据）；
 *   · 客户端 `lib/client.manager.bundle.js` = 唯一的 replace 引擎。
 *
 * ★ 为什么引擎只写一份：AGENTS §6.6 的教训（`escAttr` 曾漂成空操作、`htmlEscapeStr`
 *   曾漏单引号）。两份实现必然漂移，所以服务端一行 replace 都不写。
 *
 * 本文件钉住：
 *   ① 出厂默认规则存在且能编译；归一化幂等
 *   ② 非法规则**逐条丢弃**（一条写坏不许带崩整表），且**不许**把合法规则一起丢掉
 *   ③ ST 的 `/pattern/flags` 解析（含字符类里的 `/`、非法 flags 回退 g）
 *   ④ ST 卡脚本导入：只收输出侧（`promptOnly` 跳过、`disabled` 跳过）
 *   ⑤ 客户端引擎：`\uXXXX` 真被还原；重复执行**幂等**；关开关后原样返回
 *   ⑥ 红线：状态里存的是规则表，**不是**消息正文；本模块不碰会话日志
 *
 * 运行：node --test tests/display-rules.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-display-rules-'))
process.env.DSH_HOME = TMP_HOME

const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)
const {
  DEFAULT_DISPLAY_RULES, normalizeDisplayRules, normalizeOneRule,
  extractStRegexScripts, parseSlashRegex, describeRule,
} = _test

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

/**
 * 把客户端的引擎装进干净沙箱。
 *
 * 只装**纯函数**那几段（不碰 DOM / fetch）：`compileDisplayRules` / `applyDisplayRules`
 * 依赖的 `COMPILED_RULES`、`DEFAULT_UNESCAPE_RULE` 由沙箱顶部提供。
 */
function loadEngine() {
  const box = {}
  vm.createContext(box)
  vm.runInContext(
    'var COMPILED_RULES = null;\n' +
    'var DEFAULT_UNESCAPE_RULE = ' + JSON.stringify(DEFAULT_DISPLAY_RULES[0]) + ';\n' +
    extractFn(BUNDLE, 'function unescapeUnicodeText(') + '\n' +
    extractFn(BUNDLE, 'function compileDisplayRules(') + '\n' +
    extractFn(BUNDLE, 'function activeRules(') + '\n' +
    extractFn(BUNDLE, 'function applyDisplayRules(') + '\n' +
    'this.__setRules = function (raw) { COMPILED_RULES = compileDisplayRules(raw); };\n' +
    'this.__apply = applyDisplayRules;\n' +
    'this.__unescape = unescapeUnicodeText;\n' +
    'this.__active = activeRules;\n',
    box,
  )
  return {
    setRules: box.__setRules,
    apply: box.__apply,
    unescape: box.__unescape,
    active: box.__active,
  }
}

// ════════════════════════════════════════════════════════════════
// ① 出厂默认
// ════════════════════════════════════════════════════════════════
test('① 出厂默认：有一条 unicode 反转义，且默认启用', () => {
  assert.ok(Array.isArray(DEFAULT_DISPLAY_RULES) && DEFAULT_DISPLAY_RULES.length >= 1, '出厂必须至少有一条规则')
  const un = DEFAULT_DISPLAY_RULES.find((r) => r.builtinUnescape === true)
  assert.ok(un, '★ 出厂必须含 unicode 反转义 —— 这就是用户报的那个乱码的解')
  assert.equal(un.enabled, true, '默认启用（用户不用去点开关就该看到中文）')
  assert.ok(un.find.includes('[0-9a-fA-F]{4}'), '匹配 \\uXXXX：' + un.find)
  // 真能编译
  assert.doesNotThrow(() => new RegExp(un.find, un.flags || 'g'))
})

test('①b 归一化幂等；缺字段时补出厂默认', () => {
  const a = normalizeDisplayRules(null)
  assert.equal(a.enabled, true, '缺省 = 开启')
  assert.deepEqual(a.rules, [], 'null 输入 ⇒ 空表（由 readState 负责填出厂默认，不在这里凭空造）')
  const b = normalizeDisplayRules({ enabled: true, rules: [] })
  assert.deepEqual(b, { enabled: true, rules: [], dropped: 0 })
  const c = normalizeDisplayRules({ enabled: false, rules: [] })
  assert.equal(c.enabled, false, '显式关掉要认')
  // 幂等：归一化后的结果再归一化一次，完全不变
  const once = normalizeDisplayRules({ enabled: true, rules: DEFAULT_DISPLAY_RULES })
  const twice = normalizeDisplayRules(once)
  assert.deepEqual(twice.rules, once.rules, '★ 归一化必须幂等（面板拉全表→改一条→存全表）')
  assert.equal(twice.enabled, once.enabled)
})

// ════════════════════════════════════════════════════════════════
// ② 非法规则逐条丢弃
// ════════════════════════════════════════════════════════════════
test('② 非法规则逐条丢弃，合法的一条都不许被牵连', () => {
  const raw = {
    enabled: true,
    rules: [
      { id: 'ok', name: '合法', find: 'foo', flags: 'g', replace: 'bar' },
      null,
      'garbage',
      { id: 'bad-re', name: '坏正则', find: '([', flags: 'g', replace: '' },
      { id: 'empty', name: '空查找', find: '', replace: '' },
      { id: 'ok2', name: '也合法', find: 'baz', flags: 'gi', replace: 'qux' },
    ],
  }
  const out = normalizeDisplayRules(raw)
  assert.equal(out.rules.length, 2, '只留下两条合法的，实际 ' + JSON.stringify(out.rules.map((r) => r.id)))
  assert.deepEqual(out.rules.map((r) => r.id), ['ok', 'ok2'])
  assert.equal(out.dropped, 4, '四条非法都要被计数（不是静默吞掉）')
})

test('②b 非法 flags 回退成 g（不丢规则、不抛错）', () => {
  const one = normalizeOneRule({ find: 'x', flags: 'gxyz', replace: '' })
  assert.ok(one, '规则本身合法 ⇒ 不许因为 flags 写坏就整条丢掉')
  assert.equal(one.flags, 'g', '非法 flags 一律回退 g')
})

test('②c 超长 find / replace 被拒（防止把整份预设正文塞进一条规则）', () => {
  assert.equal(normalizeOneRule({ find: 'a'.repeat(5000), replace: '' }), null)
  assert.equal(normalizeOneRule({ find: 'a', replace: 'b'.repeat(5000) }), null)
})

// ════════════════════════════════════════════════════════════════
// ③ ST 的 /pattern/flags 解析
// ════════════════════════════════════════════════════════════════
test('③ parseSlashRegex：按「最后一个不在字符类里的 /」切，转义不算', () => {
  assert.deepEqual(parseSlashRegex('/abc/gi'), { source: 'abc', flags: 'gi' })
  // 字符类里的 / 不是分隔符（`String.raw` 让夹具与 ST 里真实的写法逐字一致）
  assert.deepEqual(parseSlashRegex(String.raw`/[/]/g`), { source: '[/]', flags: 'g' })
  // 转义的 / 不是分隔符
  assert.deepEqual(parseSlashRegex(String.raw`/a\/b/g`), { source: String.raw`a\/b`, flags: 'g' })
  // ST 里最常见的形态：反斜杠转义本身
  assert.deepEqual(parseSlashRegex(String.raw`/\\u([0-9a-f]{4})/gi`), { source: String.raw`\\u([0-9a-f]{4})`, flags: 'gi' })
  // 没有斜杠形态 ⇒ null（不是所有脚本都是斜杠写法）
  assert.equal(parseSlashRegex('abc'), null)
  assert.equal(parseSlashRegex('/unclosed'), null)
  // flags 非法 ⇒ 回退 g（保住规则）
  assert.deepEqual(parseSlashRegex('/a/zzz'), { source: 'a', flags: 'g' })
})

// ════════════════════════════════════════════════════════════════
// ④ ST 卡脚本导入
// ════════════════════════════════════════════════════════════════
test('④ ST 卡脚本导入：只收输出侧，promptOnly / disabled 一律跳过', () => {
  const card = {
    name: '示例卡',
    data: {
      extensions: {
        regex_scripts: [
          { scriptName: '输出侧', findRegex: '/\\\\u([0-9a-f]{4})/gi', replaceString: '', disabled: false },
          { scriptName: '只改提示词', findRegex: '/a/g', replaceString: 'b', promptOnly: true },
          { scriptName: '已禁用', findRegex: '/c/g', replaceString: 'd', disabled: true },
          { scriptName: '坏的', findRegex: 'no-slash-form', replaceString: 'x' },
        ],
      },
    },
  }
  const got = extractStRegexScripts(card)
  assert.equal(got.length, 1, '只该收 1 条，实际 ' + JSON.stringify(got.map((r) => r.name)))
  assert.equal(got[0].name, '输出侧')
  assert.equal(got[0].flags, 'gi')
  // 收进来的必须能过归一化（否则等于把坏数据塞进 state）
  for (const r of got) assert.ok(normalizeOneRule(r), '导入的规则必须能过归一化：' + r.name)
})

test('④b 卡片没有 regex 脚本时返回空数组（不许抛）', () => {
  for (const card of [null, {}, { data: {} }, { regexScripts: [] }]) {
    assert.deepEqual(extractStRegexScripts(card), [])
  }
  // 卡根上的 regexScripts 也认
  const r = extractStRegexScripts({ regexScripts: [{ scriptName: 'x', findRegex: '/y/g', replaceString: 'z' }] })
  assert.equal(r.length, 1)
})

// ════════════════════════════════════════════════════════════════
// ⑤ 客户端引擎（唯一的一份 replace 实现）
// ════════════════════════════════════════════════════════════════
test('⑤ 引擎：\\uXXXX 真被还原成中文', () => {
  const eng = loadEngine()
  eng.setRules({ enabled: true, rules: DEFAULT_DISPLAY_RULES })
  // 用户日志里的真实形态：反斜杠 + u + 4 位十六进制
  assert.equal(eng.apply('\\u55b5\\u545c\\uff5e'), '喵呜～')
  // 明文不受影响
  assert.equal(eng.apply('普通正文，没有转义'), '普通正文，没有转义')
  // 大小写十六进制都认
  assert.equal(eng.apply('\\u4F60\\u597D'), '你好')
  // 不完整的转义原样留着（宁可少还原，也不许吞字符）
  assert.equal(eng.apply('\\u12'), '\\u12')
})

test('⑤b 幂等：同一段文本跑两遍结果不变（切会话/重复装饰不许改字）', () => {
  const eng = loadEngine()
  eng.setRules({ enabled: true, rules: DEFAULT_DISPLAY_RULES })
  const once = eng.apply('\\u55b5\\u545c 正文')
  const twice = eng.apply(once)
  assert.equal(twice, once, '★ 非幂等 ⇒ 每次装饰都会再改一次字')
})

test('⑤c 关开关 ⇒ 一个字符都不动', () => {
  const eng = loadEngine()
  eng.setRules({ enabled: false, rules: DEFAULT_DISPLAY_RULES })
  assert.equal(eng.apply('\\u55b5'), '\\u55b5', '关掉后必须原样返回')
})

test('⑤d 自定义规则走 replace，支持 $1 反向引用', () => {
  const eng = loadEngine()
  eng.setRules({
    enabled: true,
    rules: [{ id: 'wrap', name: '包起来', find: '喵(\\S+?)，', flags: 'g', replace: '【$1】' }],
  })
  assert.equal(eng.apply('喵呜，你好'), '【呜】你好')
})

test('⑤e 坏正则**逐条丢弃**：一条写坏不许把整条消息打空', () => {
  const eng = loadEngine()
  eng.setRules({
    enabled: true,
    rules: [
      { id: 'bad', find: '([', flags: 'g', replace: '' },
      { id: 'good', find: 'a', flags: 'g', replace: 'b' },
    ],
  })
  assert.equal(eng.active().length, 1, '只该编译出 1 条')
  assert.equal(eng.apply('aaa'), 'bbb', '好的那条照样生效')
})

test('⑤f 规则表为空且没编译过 ⇒ 退回出厂 unicode 反转义（第一拍也不能是乱码）', () => {
  const eng = loadEngine()
  // 故意不调用 setRules（模拟 state 还没拉回来的那几拍）
  assert.equal(eng.apply('\\u55b5'), '喵', '★ state 未就绪时必须用出厂默认，否则用户最先看到的就是乱码')
  assert.equal(eng.active().length, 1, '退路里必须真的有一条规则（不是空表短路返回原串）')
})

// ════════════════════════════════════════════════════════════════
// ⑥ 红线：只作用于显示
// ════════════════════════════════════════════════════════════════
test('⑥ 红线：服务端不实现 replace、不碰会话日志', () => {
  const mod = fs.readFileSync(path.join(REPO, 'lib', 'server', 'display-rules.js'), 'utf8')
  // ★ 用**计数**而不是 `/re/.test(mod)`：slice-anchors 的内容断言判据会把
  //   `assert.equal(/x/.test(文件源码), false)` 当成「正内容断言」收录，
  //   然后在文件里找不到 needle 时点名报红（它分不清这是否定式）。计数口径没有这个歧义。
  const replaceHits = mod.split('.replace(').length - 1
  assert.equal(replaceHits, 0,
    '★ 服务端 display-rules 模块里不许出现 .replace( —— 引擎只能有一份（在客户端）')
  for (const banned of ['writeFileSync', 'appendFileSync', 'session', 'zstd']) {
    const n = mod.split(banned).length - 1
    assert.equal(n, 0, '★ 数据层模块不许碰 ' + banned + '（只做规则表校验）')
  }
  // 客户端那侧必须明确写着"只改显示"
  assert.ok(BUNDLE.includes('只改显示'), '客户端注释里要写死"只改显示"这条口径')
})

test('⑥b describeRule 是纯展示，不含任何匹配逻辑', () => {
  const s = describeRule({ find: 'a+', replace: 'b' })
  assert.ok(s.includes('a+') && s.includes('b'))
  assert.equal(describeRule({}), describeRule({}), '纯函数：同样输入同样输出')
})
