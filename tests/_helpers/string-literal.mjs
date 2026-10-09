/**
 * 字符串字面量解码 / 扫描 —— **两个测试文件的公共实现**（task-28）。
 *
 * 为什么要有它：
 *   `tests/slice-anchors.test.js` 与 `tests/panel-html-identity.test.js` 各自**逐字**抄了一份
 *   `decodeEscapes` / `scanStringLiteral`（笔2 时是"按原文抄入"）。两份实现**各改各的** ⇒ 一旦
 *   其中一处修 bug、另一处不动，两边对"同一个字面量"的判断就会**静默分叉**（铁律 17 同族：
 *   参数与事实必须同源）。
 *   ★ 这不只是"重复代码"的问题 —— 这两个函数是**判据的输入**：它们解错一个转义，
 *     断言读到的"期望值"就是错的，而断言**照样会绿**。
 *
 * 为什么是 `.mjs` 而不是 `.test.js`：
 *   本仓 `tools/run-each-test.mjs` 用 `fs.readdirSync(tests/).filter(f => f.endsWith('.test.js'))`
 *   **非递归**收集 ⇒ 放在 `tests/_helpers/` 且不叫 `.test.js` 就**不会**被当成测试文件跑。
 *   （这是必须的：本模块**不注册任何 `test()`**，若被收集会以"0 断言"落进异常桶。）
 *
 * 为什么不直接 `import '../slice-anchors.test.js'`：
 *   import 一个 `.test.js` 会把对方的 `test(...)` 注册进**当前进程**，在 harness 路径上直接炸
 *   （panel-html-identity.test.js 的原注释记下了这次实测）。
 *   本模块是**纯函数库**，无 `node:test` 依赖、无副作用 ⇒ 谁都可以安全 import。
 *
 * ★ 消费方（应保持"两份实现"降为"一个来源"）：
 *     · tests/slice-anchors.test.js        （原本文件的 `decodeEscapes` 非导出、`scanStringLiteral` 导出）
 *     · tests/panel-html-identity.test.js  （原本两个都导出）
 *   ⇒ 两处改为 re-export 本模块，**保留原有的导出名**（下游引用不变）。
 */

/** JS 转义字符表（`\n` `\t` … 以及 `\'` `\"` `` \` `` `\$` `\\`）。 */
const ESCAPE_MAP = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
  '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$',
}

/**
 * 解码一段**原始**字符串正文（不含首尾引号）里的 JS 转义序列。
 *
 * 支持：`\u{…}` · `\uXXXX` · `\xXX` · 单字符转义（`\n` `\t` `\'` `\"` `` \` `` `\$` `\\` …）。
 * 认不出的（如 `\q`）**原样保留**（去掉反斜杠）—— 与 JS 引擎对"非转义字符"的处理一致。
 */
export function decodeEscapes(raw) {
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (m, g) => ESCAPE_MAP[g] ?? g,
  )
}

/**
 * 扫描 `src[i]` 处的字符串字面量。
 *
 * 返回 `{ value, end }`（`value` 已解转义、`end` 是闭引号之后的下标）；
 * 以下情形一律返回 `null`（**fail-closed**，不许"猜一个"）：
 *   · `src[i]` 不是 `'` / `"` / `` ` ``；
 *   · 字面量未闭合（扫到源码末尾）；
 *   · 字符串里出现裸换行；
 *   · 模板串里出现 `${`（本模块**不解插值** —— 解不了就不假装能解）。
 *
 * @param {string} src 源码
 * @param {number} i   引号所在下标
 * @returns {{value: string, end: number} | null}
 */
export function scanStringLiteral(src, i) {
  const q = src[i]
  if (q !== "'" && q !== '"' && q !== '`') return null
  let j = i + 1
  let raw = ''
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { raw += src.slice(j, j + 2); j += 2; continue }
    if (c === q) return { value: decodeEscapes(raw), end: j + 1 }
    if (c === '\n') return null
    if (q === '`' && c === '$' && src[j + 1] === '{') return null
    raw += c
    j++
  }
  return null
}
