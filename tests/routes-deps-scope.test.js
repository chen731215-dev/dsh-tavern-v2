/**
 * 作用域完备性门禁：`lib/server/routes.js` 里每个 `routesGroupN` 的**自由标识符**都必须能解析到
 * 「形参 / 区内局部 / 模块级绑定 / JS 真全局」。解析不到的 ⇒ 运行时就是 `ReferenceError`。
 *
 * 为什么需要它（task-7 第一笔的真实翻车）：
 *   把 `apply` 里的路由搬进 `lib/server/routes.js` 时，依赖要靠参数传。第一版搬迁器的依赖清单是
 *   **手工誊抄**的，脚本又只用"清单里的名字"来判断"用到了什么" ⇒ 不在清单里的名字被**静默丢掉**，
 *   于是 `json`（全区域用了 105 次）从未接线，运行时 `ReferenceError: json is not defined`。
 *   ⚠️ 而那条「解构名集合 == 调用点键集合」的静态契约**对这类漏名字是恒等盲的** ——
 *   它比的是我自己枚举的两份清单，一个名字**两侧都没有**时它永远看不见。
 *   ⇒ 真正的判据必须**从函数体出发**枚举自由标识符，再逐个要求可解析。本文件就是它。
 *
 * ★ 本判据自己被打过脸（a970c00 审核）：它漏掉了**三种漏名位置**、误报过**两种作用域内绑定**。
 *   漏名的方向是危险的那一侧 —— routes.js 里已经有大量 `?` 与 `...`，而模板插值几乎必然出现在
 *   错误消息里 ⇒ 在那三种位置上漏名会被**静态放绿**，冒烟只在"那条分支恰好被固定请求走到"时才兜得住。
 *   三种**必须报红**的漏名位置（判据 ② 逐条钉住）：
 *     ① 模板插值 `` `x${漏名}y` ``（旧实现把整个模板抹掉 ⇒ 插值里的代码全消失）
 *     ② 三元真分支 `ctx ? 漏名 : json`（旧的「后面跟 `:` 就当属性键」规则误伤真分支）
 *     ③ 展开运算符 `[...漏名]`（`prev === '.'` 的跳出规则把 `...` 的第三个点当成了成员访问）
 *     ④ 无空格 `??` 右侧 `ctx??漏名`（旧的 `prev === '?'` 跳出规则；与 ③ 同族，一并钉住）
 *   两种**不许报红**的作用域内绑定：
 *     ⑤ `catch (err) { … }` 的形参 ⑥ 嵌套普通函数 `function inner(p) {…}` 的形参
 *
 * ⚠️ 已知过近似（不隐瞒）：`local` 是把「本区所有声明 / 形参 / catch 形参 / 嵌套函数形参」平铺成一个
 *   集合用的，**没有按作用域分层**。代价是：若外层用到某个名字、而某个内层函数恰好也绑定了同名
 *   形参，这个漏名会被挡住。收益是把上表 ⑤⑥ 两类假阳消掉。做成完全精确需要按作用域分层扫描
 *   （内层函数体单独作为一个 scope、外层 locals 词法可见），属后续工作 —— 本轮**没有**做。
 *
 * 判据自带两条非空跑防护 + 反证：
 *   ① 必须真的解析出**足够多的**标识符（否则等于在看空集）；
 *   ② 必须真的扫到**多个** group 函数；
 *   ③ 反证：喂一个「用了未声明的名字」的合成样本，判据必须报红（含上表四种位置逐条正反样本）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(REPO, 'lib', 'server', 'routes.js')

const KEYWORDS = new Set(('const let var function return if else for while do break continue new typeof instanceof in of try catch finally throw delete void null true false undefined this switch case default import export from as await async yield class extends super static get set arguments').split(' '))
const GLOBALS = new Set(('JSON Math Date Number String Boolean Array Object Promise Set Map WeakMap WeakSet RegExp Error TypeError RangeError SyntaxError parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent process console Buffer URL URLSearchParams TextEncoder TextDecoder globalThis Infinity NaN setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone fetch AbortController').split(' '))

/** 跳过 `src[i]` 处的字符串字面量（`'` / `"`），返回**闭引号之后**的下标；未闭合则返回末尾。 */
function skipQuoted(src, i) {
  const q = src[i]
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue }
    if (src[j] === '\n') break
    if (src[j] === q) return j + 1
    j++
  }
  return j
}

/** 跳过 `src[i]` 处的模板字面量（含 `${…}` 里的嵌套模板），返回闭反引号之后的下标。 */
function skipTemplate(src, i) {
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue }
    if (src[j] === '`') return j + 1
    if (src[j] === '$' && src[j + 1] === '{') {
      j += 2
      let depth = 1
      while (j < src.length && depth > 0) {
        const c = src[j]
        if (c === "'" || c === '"') { j = skipQuoted(src, j); continue }
        if (c === '`') { j = skipTemplate(src, j); continue }
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      continue
    }
    j++
  }
  return j
}

/**
 * 剥注释 / 字符串 / **正则字面量**（正则不剥会把 `/…/g` 的 flag 当成标识符 —— 实测误报过）。
 *
 * ★ 模板字面量只剥**字面文本**，`${…}` 里的代码**保留**（旧实现整个抹掉 ⇒ 插值里的漏名看不见）。
 *   例如 `` `a${expr}b` `` → `` ` expr ` ``。
 */
export function codeOnly(text) {
  const src = String(text)
  let out = ''
  let i = 0
  const n = src.length
  // 正则 vs 除法只认「上一个**发出**的非空白字符」——必须在 out 上跟踪，
  // 不能拿 src 的下标去索引 out（out 因剥注释/字符串/模板而更短，下标会错位 ⇒ 正则被当除法）。
  let lastChar = ''
  const emit = (s) => {
    out += s
    for (let q = s.length - 1; q >= 0; q--) { const ch = s[q]; if (ch === ' ' || ch === '\t') continue; lastChar = ch; break }
  }
  while (i < n) {
    const c = src[i]
    // 行注释（`https://` 里的 `//` 不算注释）
    if (c === '/' && src[i + 1] === '/' && src[i - 1] !== ':') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      // 替换成一个空格（不是"删掉"）：`a/*x*​/b` 必须仍然是**两个** token，否则会并出一个假名字
      emit(' ')
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') emit('\n'); i++ }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      emit(c + c)
      i = skipQuoted(src, i)
      continue
    }
    if (c === '`') {
      emit('`')
      i++
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '`') { emit('`'); i++; break }
        if (ch === '$' && src[i + 1] === '{') {
          const open = i + 1
          let j = open + 1
          let depth = 1
          while (j < n && depth > 0) {
            const cj = src[j]
            if (cj === "'" || cj === '"') { j = skipQuoted(src, j); continue }
            if (cj === '`') { j = skipTemplate(src, j); continue }
            if (cj === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue }
            if (cj === '/' && src[j + 1] === '*') { j += 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j += 2; continue }
            if (cj === '{') depth++
            else if (cj === '}') { depth--; if (depth === 0) break }
            j++
          }
          // ★ 插值内容当**代码**继续处理（递归），两侧补空格避免与字面文本粘连
          emit(' ' + codeOnly(src.slice(open + 1, j)) + ' ')
          i = j < n ? j + 1 : j
          continue
        }
        emit(ch === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }
    if (c === '/') {
      const prev = lastChar
      if (/[A-Za-z0-9_$)\]}]/.test(prev)) { emit(c); i++; continue }
      let inClass = false
      let k = i + 1
      for (; k < n; k++) {
        const rc = src[k]
        if (rc === '\\') { k++; continue }
        if (rc === '\n') break
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        else if (rc === '/' && !inClass) break
      }
      if (k >= n || src[k] !== '/') { emit(c); i++; continue }
      k++
      while (k < n && /[a-z]/i.test(src[k])) k++
      emit(' ')
      i = k
      continue
    }
    emit(c)
    i++
  }
  return out
}

/** 模块级绑定（顶格 function / const|let|var / import）。 */
export function moduleBindings(src) {
  const out = new Set()
  for (const m of src.matchAll(/^import\s+(?:\{([^}]*)\}|(\w+))\s+from/gm)) {
    if (m[1]) for (const n of m[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop(); if (t) out.add(t) }
    if (m[2]) out.add(m[2])
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm)) out.add(m[1])
  return out
}

/** 按**深度 0** 的逗号切分（形参表 / 解构模式用）。 */
export function splitTopLevel(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of String(text)) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * 把「形参表 / 解构模式」里的**绑定名**收进 set。
 * 只收绑定名：`{ a: b }` 收 `b`（`a` 是属性键）、`{ a }` 收 `a`、`[x, y]` 收 `x`/`y`、默认值右边不收。
 */
export function addBindingNames(set, text) {
  for (const part of splitTopLevel(text)) {
    const p = part.trim()
    if (!p) continue
    const head = p.split('=')[0].trim()
    if (!head) continue
    if (head[0] === '{' || head[0] === '[') {
      const close = head[0] === '{' ? '}' : ']'
      const at = head.lastIndexOf(close)
      const inner = at > 0 ? head.slice(1, at) : head.slice(1)
      for (const q of splitTopLevel(inner)) {
        const t = q.trim()
        if (!t) continue
        const colon = t.indexOf(':')
        const target = (colon >= 0 ? t.slice(colon + 1) : t).trim()
        if (!target) continue
        if (target[0] === '{' || target[0] === '[') addBindingNames(set, target)
        else { const id = target.match(/^[A-Za-z_$][\w$]*/); if (id) set.add(id[0]) }
      }
      continue
    }
    const id = head.match(/^[A-Za-z_$][\w$]*/)
    if (id) set.add(id[0])
  }
  return set
}

/** 该 token 是否处在「属性键 / 标签」位置 —— 只有这种位置的 `:` 才不是三元的分隔。 */
export function isKeyPosition(body, idx) {
  let before = ''
  for (let q = idx - 1; q >= 0; q--) { const pc = body[q]; if (/\s/.test(pc)) continue; before = pc; break }
  if (before === '{' || before === ',' || before === ';' || before === '}' || before === '') return true
  const prevWord = (body.slice(0, idx).match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1] || ''
  return prevWord === 'case' || prevWord === 'default'
}

/** 逐个函数报告「无法解析的自由标识符」。返回 [{name, free:[…]}]（空数组 = 全部可解析）。 */
export function unresolvedIdentifiers(src) {
  const mod = moduleBindings(src)
  const out = []
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^function\s+(\w+)\s*\(([^)]*)\)\s*\{/)
    if (!m) { i++; continue }
    let depth = 0
    let end = -1
    for (let k = i; k < lines.length; k++) {
      for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
      if (k > i && depth === 0) { end = k; break }
    }
    const body = codeOnly(lines.slice(i + 1, end).join('\n'))
    const local = new Set()
    addBindingNames(local, m[2])
    for (const d of body.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) local.add(d[1])
    for (const d of body.matchAll(/(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])/g)) addBindingNames(local, d[1])
    for (const d of body.matchAll(/\(([^()]*)\)\s*=>/g)) addBindingNames(local, d[1])
    for (const d of body.matchAll(/(?:^|[\s(,])([A-Za-z_$][\w$]*)\s*=>/gm)) local.add(d[1])
    // ★ 嵌套普通函数的形参（旧实现只收顶格那一个函数的形参 ⇒ 误报 inner 的 p）
    for (const d of body.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) addBindingNames(local, d[1])
    for (const d of body.matchAll(/=\s*function\s*\*?\s*[A-Za-z_$]?\s*\(([^()]*)\)/g)) addBindingNames(local, d[1])
    // ★ catch 形参（旧实现不收 ⇒ 误报 err）
    for (const d of body.matchAll(/\bcatch\s*\(([^)]*)\)/g)) addBindingNames(local, d[1])
    const free = new Set()
    for (const t of body.matchAll(/(\$?\w+)/g)) {
      const idx = t.index
      const prev = body[idx - 1] || ''
      if (prev === '.') {
        // ★ 展开运算符 `...name`：第三个点不是成员访问，name **是**真引用
        const spread = body[idx - 2] === '.' && body[idx - 3] === '.'
        if (!spread) continue
      } else if (/[\w$]/.test(prev)) {
        continue
      }
      // 注：旧实现还有一条 `prev === '?'` 的跳出规则，它会把**无空格**的 `ctx??漏名` 右侧一起吃掉，
      // 与 `...` 那类同病 —— 已删（`?.` 成员访问由 prev === '.' 覆盖）。
      if (/^\d/.test(t[0])) continue
      if (/^\s*:/.test(body.slice(idx + t[0].length).slice(0, 4)) && isKeyPosition(body, idx)) continue
      const n = t[0]
      if (local.has(n) || mod.has(n) || KEYWORDS.has(n) || GLOBALS.has(n)) continue
      free.add(n)
    }
    if (free.size) out.push({ name: m[1], free: [...free].sort() })
    i = end + 1
  }
  return out
}

/** 扫到的规模（供非空跑判据用）：group 数 + 这些函数体里出现过的标识符总数。 */
export function scanStats(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  let groups = 0
  let identifiers = 0
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^function\s+(routesGroup\w+)\s*\(([^)]*)\)\s*\{/)
    if (!m) { i++; continue }
    groups++
    let depth = 0
    let end = -1
    for (let k = i; k < lines.length; k++) {
      for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
      if (k > i && depth === 0) { end = k; break }
    }
    const body = codeOnly(lines.slice(i + 1, end).join('\n'))
    identifiers += [...body.matchAll(/(\$?\w+)/g)].length
    i = end + 1
  }
  return { groups, identifiers }
}

test('① routes.js 的每个 group 函数：自由标识符都必须可解析（0 未解析）', () => {
  assert.ok(fs.existsSync(TARGET), '找不到 ' + path.relative(REPO, TARGET) + ' —— 判据空跑')
  const src = fs.readFileSync(TARGET, 'utf8')
  const st = scanStats(src)
  // 非空跑：必须真的扫到 group 函数、且里面确实有成规模的标识符（否则等于在看空集）。
  // 阈值刻意取"显然低于现状、又远高于 0"的数：搬迁是分几笔做的，第一笔只有一个 group。
  assert.ok(st.groups >= 1, '一个 routesGroupN 都没扫到 —— 判据空跑（搬走了？改名了？）')
  assert.ok(st.identifiers >= 100, 'group 体内只扫到 ' + st.identifiers + ' 个标识符 —— 判据空跑或解析器坏了')
  const bad = unresolvedIdentifiers(src)
  assert.deepEqual(
    bad.map((b) => b.name + ' → ' + b.free.join(', ')),
    [],
    '★ 这些自由标识符解析不到（运行时就是 ReferenceError —— task-7 第一笔的 `json is not defined` 就是这么来的）：',
  )
})

// ════════════════════════════════════════════════════════════════════
// ② 反证：三种漏名位置（+ 同族的无空格 `??`）必须报红；
//    两种作用域内绑定（catch 形参 / 嵌套函数形参）不许报红。
//    这 6 条缺一条，判据就可能漂回"静默放绿"或"假阳噪声"。
// ════════════════════════════════════════════════════════════════════

const SHELL = (inner) => 'function routesGroupX(ctx, deps) {\n  const { json } = deps\n' + inner + '\n}'

test('② 反证：四种「漏名位置」必须全部报红（缺一种就是那一类被静默放绿）', () => {
  const cases = [
    ['①模板插值', '  const s = `x${missingTemplate}y`\n  return [json, s]', 'missingTemplate'],
    ['②三元真分支', '  return [ctx ? missingTernaryTrue : json]', 'missingTernaryTrue'],
    ['③展开运算符', '  return [...missingSpread, json]', 'missingSpread'],
    ['④无空格 ?? 右侧', '  return [ctx??missingCoalesce]', 'missingCoalesce'],
  ]
  for (const [label, inner, want] of cases) {
    const r = unresolvedIdentifiers(SHELL(inner))
    assert.deepEqual(r.flatMap((x) => x.free), [want], '★ ' + label + ' 的漏名必须被报出（否则这一类会被静态放绿）')
  }
  // 对照：普通位置本来就是好的（判据不是靠"什么都报"蒙对的）
  for (const [label, inner, want] of [
    ['对象字面量值位', '  return { a: missingObjValue }', 'missingObjValue'],
    ['函数调用实参', '  return [wrap(missingArg)]', 'wrap'],
    ['默认值右侧', '  const { a = missingDefault } = deps\n  return [a]', 'missingDefault'],
  ]) {
    const r = unresolvedIdentifiers(SHELL(inner)).flatMap((x) => x.free)
    assert.ok(r.includes(want), '★ ' + label + ' 的漏名也必须被报出，实际报出=' + JSON.stringify(r))
  }
})

test('② 反证：两种「作用域内绑定」不许报红（假阳会把门禁变成噪声）', () => {
  for (const [label, inner] of [
    ['⑤catch 形参', '  try { return json } catch (err) { return err }'],
    ['⑥嵌套函数形参', '  function inner(p) { return p }\n  return [json, inner]'],
    ['⑥b 函数表达式形参', '  const f = function inner2(q) { return q }\n  return [json, f]'],
    ['⑤b catch 解构形参', '  try { return json } catch ({ message }) { return message }'],
    ['⑦箭头形参', '  const f = (aa, bb) => aa + bb\n  return [json, f]'],
    ['⑧解构：键不算、值才算', '  const { json: jj, S: ss } = deps\n  return [jj, ss]'],
  ]) {
    assert.deepEqual(unresolvedIdentifiers(SHELL(inner)), [], '★ ' + label + ' 是作用域内绑定，不该报红')
  }
})

test('②-c 反证：注释 / 正则 / 字符串里的词不算自由标识符', () => {
  const noisy = 'function routesGroupY(ctx) {\n  // readBody 出现在注释里\n  const re = /readBody/g\n  const s = "readBody"\n  return [re, s]\n}'
  assert.deepEqual(unresolvedIdentifiers(noisy), [], '注释/正则/字符串里的词不该被当成自由标识符')
})

test('②-d 反证：模板插值里的**合法**名字仍然解析得到（不是靠"插值一律报红"蒙的）', () => {
  const ok = 'function routesGroupZ(ctx, deps) {\n  const { json } = deps\n  const s = `a${json.b}x`\n  return [s]\n}'
  assert.deepEqual(unresolvedIdentifiers(ok), [], '插值里的合法引用不该报红')
  const nested = 'function routesGroupW(ctx, deps) {\n  const { json } = deps\n  const s = `a${`b${json.c}`}d`\n  return [s]\n}'
  assert.deepEqual(unresolvedIdentifiers(nested), [], '嵌套模板插值里的合法引用也不该报红')
})

// ════════════════════════════════════════════════════════════════════
// ⑤ `routeDeps` 袋 ↔ `const { … } = deps` 的【双向】契约
// ⑥ 组函数结构：每个 `function routesGroupN(` 必须在**花括号深度 0** 且唯一
//
// 为什么单独立这两条（task-13，第三块前置）：它们是"临时搬迁器守着的两条不变量"，而搬迁器在
// `_scratch/`（AGENTS §7.6 不入库）⇒ 第三/四块搬完就没人再守。实测（审核方删键实验 + 那次
// "三重静默"）证明这两类**没有任何静态护栏**：
//   · 删袋里的 `json`（跨组键）        → 作用域门禁【绿】、assemble 契约【绿】、**只有冒烟红**
//   · 删袋里的 `renamePreset`（组独有）→ 同上
//   · 组函数被嵌进上一组体            → 语法检查【绿】、缩进型检查【绿】、作用域门禁【绿】，只有冒烟红
// ⇒ 冒烟只在"固定请求恰好走到那条链"时有效，所以这里补**静态**判据。
// ════════════════════════════════════════════════════════════════════

const ROUTES_SRC = fs.readFileSync(TARGET, 'utf8')
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')

/** 解析 `const routeDeps = { … }` 袋体 → 键集合（一行可含多个普通键；带 `:` 的是访问器）。 */
export function parseDepsBag(src) {
  const m = String(src).match(/^[ \t]*const routeDeps = \{([\s\S]*?)^[ \t]*\}/m)
  if (!m) return null
  const keys = new Set()
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('//')) continue
    const acc = t.match(/^([A-Za-z_$][\w$]*)\s*:/)
    if (acc) { keys.add(acc[1]); continue }
    for (const tok of t.split(',')) {
      const x = tok.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(x)) keys.add(x)
    }
  }
  return keys
}

/** 解析 routes.js 里**全部** `const { … } = deps` 的键并集（不许硬编码"两块" —— 还会继续加组）。 */
export function parseDestructuredDeps(src) {
  const keys = new Set()
  const blocks = []
  for (const b of String(src).matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*deps/g)) {
    const local = b[1].split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))
    blocks.push(local)
    for (const k of local) keys.add(k)
  }
  return { keys, blocks }
}

/** 双向契约：`解构了没传`（运行时 undefined）与 `传了没解构`（漂移）都要红。 */
export function depsContractProblems(bagKeys, destructuredKeys) {
  if (!bagKeys) return ['★ 找不到 index.js 里的 `const routeDeps = {` 袋 —— 判据空跑（搬家搬没了？）']
  const missingInBag = [...destructuredKeys].filter((k) => !bagKeys.has(k)).sort()
  const extraInBag = [...bagKeys].filter((k) => !destructuredKeys.has(k)).sort()
  const out = []
  if (missingInBag.length) out.push('★ routes.js 解构了、但 routeDeps 袋里**没有**（运行时是 undefined）：' + missingInBag.join(', '))
  if (extraInBag.length) out.push('★ routeDeps 袋里传了、但没有任何组解构它（漂移）：' + extraInBag.join(', '))
  return out
}

/** 结构：每个 `function routesGroupN(` 必须在花括号深度 0（不许嵌进上一组体）、且唯一、括号平衡。
 *  ★ 用**括号配平**判断，不看缩进（合法 JS 的缩进可以任意 —— 审核方专门确认过这一点）。 */
export function groupStructureProblems(src) {
  const s = String(src)
  let depth = 0
  const seen = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < s.length) { if (s[j] === '\\') { j += 2; continue } if (s[j] === c || s[j] === '\n') break; j++ }
      i = j
      continue
    }
    if (c === '/' && s[i + 1] === '/' && s[i - 1] !== ':') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
    if (s.startsWith('function routesGroup', i)) {
      const m = s.slice(i, i + 40).match(/^function (routesGroup\d+)\(/)
      if (m) seen.push({ name: m[1], depth, line: s.slice(0, i).split('\n').length })
    }
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  const out = []
  if (!seen.length) out.push('★ 一个 routesGroupN 都没扫到 —— 判据空跑')
  if (depth !== 0) out.push('★ routes.js 花括号不平衡（残余深度 ' + depth + '）—— 结构已经坏了')
  for (const g of seen) if (g.depth !== 0) out.push('★ ' + g.name + '（L' + g.line + '）在花括号深度 ' + g.depth + ' —— 它被嵌进了别的函数体（运行时 ReferenceError）')
  const names = seen.map((x) => x.name)
  const dup = [...new Set(names.filter((n, k) => names.indexOf(n) !== k))]
  if (dup.length) out.push('★ 组函数重名：' + dup.join(', '))
  return out
}

test('⑤ 袋 ↔ 解构【双向】契约：解构了没传 / 传了没解构 都要红', (t) => {
  const bag = parseDepsBag(INDEX_SRC)
  const { keys, blocks } = parseDestructuredDeps(ROUTES_SRC)
  t.diagnostic('routeDeps 袋键 ' + (bag ? bag.size : 0) + '；解构块 ' + blocks.length + ' 个、并集键 ' + keys.size)
  // 非空跑下限：两侧都必须真的解析出东西 —— "两侧都 0"会恒等绿（同类事故在 0ef48d8 抓过一次）
  assert.ok(bag && bag.size >= 40, '袋只解析出 ' + (bag ? bag.size : 0) + ' 个键 —— 判据空跑或解析器坏了')
  assert.ok(keys.size >= 40, '解构只解析出 ' + keys.size + ' 个键 —— 判据空跑或解析器坏了')
  assert.ok(blocks.length >= 1, '一个解构块都没扫到')
  const bad = depsContractProblems(bag, keys)
  assert.deepEqual(bad, [], '★ 袋与解构的契约破了（这一条静态就能看出来，不必等冒烟）：\n  ' + bad.join('\n  '))
})

test('⑤-b 反证：删键必须**在静态判据上**红并点名到键（与审核方实验同形）', () => {
  const bag = parseDepsBag(INDEX_SRC)
  const { keys } = parseDestructuredDeps(ROUTES_SRC)
  const drop = (k) => { const s = new Set(bag); s.delete(k); return s }
  // 同形 ①：删 json（group1 与 group2 都用的跨组键）
  const r1 = depsContractProblems(drop('json'), keys)
  assert.equal(r1.length, 1, '删 json 必须红，实际=' + JSON.stringify(r1))
  assert.match(r1[0], /解构了、但 routeDeps 袋里\*\*没有\*\*/)
  assert.match(r1[0], /json/, '必须点名到具体键')
  // 同形 ②：删 renamePreset（group2 独有键）
  const r2 = depsContractProblems(drop('renamePreset'), keys)
  assert.equal(r2.length, 1, '删 renamePreset 必须红，实际=' + JSON.stringify(r2))
  assert.match(r2[0], /renamePreset/)
  // 反方向：袋里多一个没人解构的键
  const extra = new Set(bag)
  extra.add('zzNobodyDestructuresThis')
  const r3 = depsContractProblems(extra, keys)
  assert.equal(r3.length, 1, '传了没解构必须红，实际=' + JSON.stringify(r3))
  assert.match(r3[0], /zzNobodyDestructuresThis/)
  // 袋读不到 ⇒ 必须点名"判据空跑"（不是静默通过）
  assert.match(depsContractProblems(null, keys)[0], /判据空跑/)
  // 对照：正常袋不该红
  assert.deepEqual(depsContractProblems(bag, keys), [], '正常袋不该红')
})

test('⑥ 组函数结构：每个 routesGroupN 必须在花括号深度 0 且唯一', (t) => {
  t.diagnostic('routes.js 组函数：' + [...ROUTES_SRC.matchAll(/^function (routesGroup\d+)\(/gm)].map((m) => m[1]).join(', '))
  const bad = groupStructureProblems(ROUTES_SRC)
  assert.deepEqual(bad, [], '★ routes.js 的组函数结构坏了：\n  ' + bad.join('\n  '))
})

test('⑥-b 反证：复现"三重静默"的产物形态 ⇒ 必须红（且缩进不算数）', () => {
  const ok = ['function routesGroup1(ctx, deps) {', '  return []', '}', '', 'function routesGroup2(ctx, deps) {', '  return []', '}'].join('\n')
  assert.deepEqual(groupStructureProblems(ok), [], '正常形态不该红')
  // "三重静默"形态：把组2 嵌进组1 体里（组1 的收尾 `}` 跑到最后）—— 语法检查/缩进型检查都看不出来
  const nested = ['function routesGroup1(ctx, deps) {', '  return []', '', 'function routesGroup2(ctx, deps) {', '  return []', '}', '}'].join('\n')
  const r = groupStructureProblems(nested)
  assert.equal(r.length, 1, '"三重静默"形态必须红，实际=' + JSON.stringify(r))
  assert.match(r[0], /routesGroup2/)
  assert.match(r[0], /深度 1/)
  // 重名
  const dup = ok + '\n' + ok.split('\n').slice(0, 3).join('\n')
  assert.match(groupStructureProblems(dup).join('\n'), /重名/)
  // ★ 缩进**不算数**：正常形态整体缩进两格，既不该红、也不该被误判（判据用的是括号配平）
  const indented = ok.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')
  assert.deepEqual(groupStructureProblems(indented), [], '缩进不该影响判断（用的是括号配平，不是缩进）')
  // 花括号不平衡
  assert.match(groupStructureProblems('function routesGroup1(ctx, deps) {\n  return []\n').join('\n'), /不平衡/)
  // 一个组都没有 ⇒ 空跑即失败
  assert.match(groupStructureProblems('const x = 1\n').join('\n'), /判据空跑/)
})
