/**
 * 卡导入保真：`regexScripts` 不能在导入/保存链路上被丢掉或被「清洗」坏。
 *
 * 这是 2.8.0 的根因修复点。旧链路：
 *   PNG → addCard() 只取 name/desc/first_mes/alternates → characters.json
 * 于是 `extensions.regex_scripts`（状态栏 / 变量折叠 / 选项卡片 / 思维链全靠它）
 * 在导入那一刻就没了，插件只能靠白名单硬编码——每来一张新卡就要加一条正则。
 *
 * 更隐蔽的一处：`cleanObjectStrings()` 会对**每个字符串**跑 `cleanSillyTavernVars`，
 * 把 `{{…}}` / `<!-- … -->` / `<thinking>…</thinking>` 删掉。正文里那是要清的 ST 宏，
 * 但在正则脚本里是**语法**（`{{random::.::..}}`、`{{char}}`），清一次卡就坏。
 *
 * 运行：node --test tests/card-import-fidelity.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const CLIENT = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
const INDEX = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
const ROUTES = fs.readFileSync(path.join(REPO, 'lib', 'server', 'routes.js'), 'utf8')

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

test('① addCard 保留 regexScripts + cardMeta（只挑需要字段）', () => {
  const body = extractFn(CLIENT, 'async function addCard(')
  assert.match(body, /card\.extensions\.regex_scripts/, '要从 extensions.regex_scripts 读（ST 的标准位置）')
  assert.match(body, /regexScripts: regexScripts/, '★ 必须写进 characters.json 的条目')
  assert.match(body, /findRegex: String\(/, 'findRegex 要原样保留')
  assert.match(body, /replaceString: String\(/, 'replaceString 要原样保留（状态栏 HTML 就在这）')
  assert.match(body, /promptOnly: s\.promptOnly === true/, 'promptOnly 标记要保留（提示词侧过滤靠它）')
  assert.match(body, /markdownOnly: s\.markdownOnly === true/, 'markdownOnly 标记要保留')
  assert.match(body, /cardMeta:/, '规格/作者等元信息保留一份，便于排错')
  // 第三方扩展整包存会把 characters.json 撑到兆级，必须只挑字段
  const codeLines = body.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  assert.ok(!codeLines.join('\n').includes('tavern_helper'), '不许把 tavern_helper 之类的第三方扩展整包存下来')
})

test('② cleanObjectStrings 跳过正则键，正文照旧清洗', () => {
  const raw = [INDEX, ROUTES].join('\n')
  const fn = extractFn(raw, 'function cleanObjectStrings(')
  const consts = raw.split('\n').filter((l) => l.trim().startsWith('const RAW_STRING_KEYS'))

  const box = {
    // 模拟真实的 cleanSillyTavernVars：删 {{…}}、删 <!-- … -->、删 <thinking>…</thinking>
    cleanSillyTavernVars: (s) => String(s)
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ''),
  }
  vm.createContext(box)
  vm.runInContext(consts.join('\n') + '\n' + fn + '\nthis.__clean = cleanObjectStrings', box)

  const card = {
    name: '示例卡',
    desc: '正文里的 {{user}} 应该被换成玩家名/清掉',
    regexScripts: [{
      scriptName: '状态栏美化',
      findRegex: '<StatusPlaceHolderImpl/>',
      replaceString: '<details><summary>变量更新{{random::.::..}}</summary><!-- 注释保留 --></details>',
    }],
    cardMeta: { spec: 'chara_card_v3' },
  }
  box.__clean(card)
  assert.equal(card.desc, '正文里的  应该被换成玩家名/清掉', '正文里的 ST 宏照旧清洗')
  assert.match(card.regexScripts[0].replaceString, /\{\{random::/, '★ 正则脚本里的 {{…}} 是语法，不许清')
  assert.match(card.regexScripts[0].replaceString, /<!-- 注释保留 -->/, '正则脚本里的 HTML 注释不许清')
  assert.equal(card.regexScripts[0].findRegex, '<StatusPlaceHolderImpl/>', 'findRegex 原样')
})

test('③ 服务端接口：只回显示侧脚本（promptOnly 在提示词侧处理）', () => {
  const i = ROUTES.indexOf("path: '/api/tavern/active-card'")
  assert.ok(i > 0, '缺 /api/tavern/active-card 路由（前端靠它拿当前会话的卡脚本）')
  const seg = ROUTES.slice(i, i + 1600)
  assert.match(seg, /s\.disabled !== true && s\.promptOnly !== true/, '只回显示侧：停用的与 promptOnly 的都剔掉')
  assert.match(seg, /activeCardOfPreset\(presetId\)/, '按会话的权威预设取卡，不能用前端缓存（会粘住旧值）')
  assert.match(seg, /regexScripts: scripts/, '字段名要与前端一致')
})

test('④ 提示词侧：pre-step 钩子按卡脚本裁剪历史', () => {
  const i = INDEX.indexOf('// ── 角色卡正则脚本的「提示词侧」')
  assert.ok(i > 0, '缺提示词侧钩子')
  const seg = INDEX.slice(i, i + 3000)
  assert.match(seg, /ctx\.on\('agent\/pre-step'/, '必须挂在 pre-step 上')
  assert.match(seg, /mode: 'prompt'/, '按 prompt 模式跑（markdownOnly 的脚本会被自动跳过）')
  assert.match(seg, /m\.role !== 'assistant'/, '只改 AI 历史，不动用户输入')
  assert.match(seg, /list\.length - 40/, '只回看最后 40 条（更早的早被窗口裁掉）')
  assert.match(seg, /st\.cardRegex === false/, '要有开关，出问题能一键关掉')
})
