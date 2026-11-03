/**
 * ST 正则脚本引擎（lib/st-regex.js）—— 卡兼容的地基。
 *
 * 用户 2026-11-04：「有很多很多角色卡，你都做做兼容吧，兼容不到位啊」。
 * 实测 9 张卡（各种体量、各种写法）**全部**
 * 把渲染层写成 `data.extensions.regex_scripts`；以前导入时整段丢掉，于是每张卡都要在
 * 插件里硬编码一份解析器。这里钉住引擎的语义，避免以后被"顺手简化"成只做字符串替换：
 *
 *   ① `findRegex` 两种写法（/pat/flags 与纯文本）都要认；
 *   ② `$1..$9` / `$&` / `{{match}}` / `{{char}}` / `{{user}}` 都要展开；
 *   ③ markdownOnly / promptOnly 的过滤规则与 ST **完全一致**（两个都 true 时两边都不跑）；
 *   ④ placement / minDepth / maxDepth / trimStrings 生效；
 *   ⑤ 写坏的一条脚本只丢自己，不影响其它脚本。
 *
 * 运行：node --test tests/st-regex.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLACEMENT,
  parseRegexLiteral,
  normalizePlacement,
  compileCardScripts,
  shouldRun,
  expandReplacement,
  applyCardScripts,
  isStatusBarScript,
} from '../lib/st-regex.js'

test('① findRegex：斜杠字面量 / 纯文本 / 缺省补 g', () => {
  assert.deepEqual(parseRegexLiteral('/<StatusPlaceHolderImpl\\/>/gi'), {
    source: '<StatusPlaceHolderImpl\\/>',
    flags: 'gi',
  }, '斜杠形态要原样取源码与 flags')

  const plain = parseRegexLiteral('<操作手册>')
  assert.equal(plain.source, '<操作手册>', '纯文本形态整串当源码（ST 就是这样）')
  assert.match(plain.flags, /g/, '★ 缺省必须补 g：一屏里同类块重复出现是常态')

  assert.deepEqual(parseRegexLiteral('/a\\/b/g'), { source: 'a\\/b', flags: 'g' }, '转义斜杠不能切错')
  assert.deepEqual(parseRegexLiteral('/[/]x/gi'), { source: '[/]x', flags: 'gi' }, '字符类里的斜杠不能切错')
  assert.deepEqual(parseRegexLiteral('/[\\s\\S]+/g'), { source: '[\\s\\S]+', flags: 'g' }, '常见字符类要能正常切')
  assert.equal(parseRegexLiteral(''), null, '空串返回 null（由调用方丢弃）')
})

test('② 编译：disabled / 坏正则只丢自己', () => {
  const list = [
    { scriptName: '好的', findRegex: '/a/g', replaceString: 'b' },
    { scriptName: '停用的', findRegex: '/x/g', replaceString: 'y', disabled: true },
    { scriptName: '坏的', findRegex: '/(/g', replaceString: 'z' },
    { scriptName: '好的二号', findRegex: 'q', replaceString: 'r' },
  ]
  const out = compileCardScripts(list)
  assert.deepEqual(out.map((s) => s.name), ['好的', '好的二号'], '停用与写坏的要被丢掉，其余照常编译')
  assert.equal(out[1].placement[0], PLACEMENT.AI_OUTPUT, '缺省 placement 是 AI 输出（2）')
})

test('③ 过滤：markdownOnly / promptOnly / placement / 深度', () => {
  const [md, pm, both, plain] = compileCardScripts([
    { findRegex: '/a/g', markdownOnly: true },
    { findRegex: '/a/g', promptOnly: true },
    { findRegex: '/a/g', markdownOnly: true, promptOnly: true },
    { findRegex: '/a/g' },
  ])
  assert.equal(shouldRun(md, { mode: 'display', placement: 2 }), true, 'markdownOnly 在显示侧要跑')
  assert.equal(shouldRun(md, { mode: 'prompt', placement: 2 }), false, 'markdownOnly 不该动提示词')
  assert.equal(shouldRun(pm, { mode: 'prompt', placement: 2 }), true, 'promptOnly 在提示词侧要跑')
  assert.equal(shouldRun(pm, { mode: 'display', placement: 2 }), false, 'promptOnly 不该动显示')
  // ★ ST 的两条 continue 叠加就是这个结果：两个都 true ⇒ 哪里都不跑。
  //   实测某张卡的 ERA 隐藏正则正是这种形态；跟 ST 一致，避免"酒馆里正常、ST 里不对"。
  assert.equal(shouldRun(both, { mode: 'display', placement: 2 }), false, '两个都 true ⇒ 显示侧不跑')
  assert.equal(shouldRun(both, { mode: 'prompt', placement: 2 }), false, '两个都 true ⇒ 提示词侧也不跑')
  assert.equal(shouldRun(plain, { mode: 'display', placement: 1 }), false, 'placement 不含 1（用户输入）就不跑')

  const deep = compileCardScripts([{ findRegex: '/a/g', minDepth: 2, maxDepth: 4 }])[0]
  assert.equal(shouldRun(deep, { mode: 'display', placement: 2, depth: 1 }), false, '浅于 minDepth 不跑')
  assert.equal(shouldRun(deep, { mode: 'display', placement: 2, depth: 3 }), true, '区间内要跑')
  assert.equal(shouldRun(deep, { mode: 'display', placement: 2, depth: 5 }), false, '深于 maxDepth 不跑')
})

test('④ 替换展开：反向引用 / 宏 / trimStrings', () => {
  const g = ['<opt>A|B</opt>', 'A', 'B']
  assert.equal(expandReplacement('$1 与 $2', g, {}), 'A 与 B')
  assert.equal(expandReplacement('$&', g, {}), '<opt>A|B</opt>', '$& 是整段匹配')
  assert.equal(expandReplacement('{{match}}', g, {}), '<opt>A|B</opt>')
  assert.equal(expandReplacement('{{char}}/{{user}}', g, { char: '角色甲', user: '玩家' }), '角色甲/玩家')
  assert.equal(expandReplacement('$$1', g, {}), '$1', '$$ 要还原成字面 $')

  const scripts = compileCardScripts([{
    findRegex: '/<(w)>([\\s\\S]*?)<\\/w>/g',
    replaceString: '[$2]',
    trimStrings: ['（删）'],
  }])
  const out = applyCardScripts('<w>甲（删）乙</w>', scripts, { mode: 'display', placement: 2 })
  assert.equal(out.text, '[甲乙]', 'trimStrings 要先从捕获组里删掉')
  assert.equal(out.replaced, 1)
})

test('⑤ 真实卡形态：状态栏占位符与变量块', () => {
  const scripts = compileCardScripts([
    // 显示侧：占位符 → 整页 HTML（多张卡都是这个写法）
    { scriptName: '状态栏美化', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<!doctype html><html><body>状态</body></html>', markdownOnly: true, placement: [2] },
    // 提示词侧：把占位符从历史里删掉（对 AI 隐藏状态栏）
    { scriptName: '对 AI 隐藏状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', promptOnly: true, placement: [2] },
    // 提示词侧：旧楼层的变量更新不要发（只保留最新一楼由深度控制）
    { scriptName: '只发送最新3楼的变量更新', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g', replaceString: '', promptOnly: true, placement: [2], minDepth: 3 },
  ])
  const text = '正文\n<StatusPlaceHolderImpl/>\n<UpdateVariable>{"hp":80}</UpdateVariable>'

  const disp = applyCardScripts(text, scripts, { mode: 'display', placement: 2, depth: 0 })
  assert.match(disp.text, /<!doctype html>/, '显示侧要把占位符换成状态栏页面')
  assert.match(disp.text, /<UpdateVariable>/, '提示词侧的脚本不许在显示侧生效（否则变量块会消失）')

  const prom = applyCardScripts(text, scripts, { mode: 'prompt', placement: 2, depth: 0 })
  assert.ok(!prom.text.includes('StatusPlaceHolderImpl'), '提示词侧要隐藏状态栏占位符')
  assert.match(prom.text, /<UpdateVariable>/, 'depth 0 在 minDepth 3 之内 ⇒ 最新一楼要保留')

  const old = applyCardScripts(text, scripts, { mode: 'prompt', placement: 2, depth: 5 })
  assert.ok(!old.text.includes('UpdateVariable'), '超过 minDepth 的旧楼层要删掉变量块，省上下文')
})

test('⑥ 状态栏脚本识别（补状态栏时用它判断卡有没有）', () => {
  const [a, b] = compileCardScripts([
    { scriptName: '状态栏美化', findRegex: 'x', replaceString: 'y' },
    { scriptName: '随便', findRegex: 'x', replaceString: 'y' },
  ])
  assert.equal(isStatusBarScript(a), true, '名字带「状态栏」就算')
  assert.equal(isStatusBarScript(b), false, '普通脚本不算')

  const c = compileCardScripts([{ scriptName: 'zzz', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<html></html>' }])[0]
  assert.equal(isStatusBarScript(c), true, '匹配占位符的脚本也算（有的卡不写 scriptName）')
})

test('⑦ placement 归一化：数字 / 数组 / 非法值', () => {
  assert.deepEqual(normalizePlacement(2), [2])
  assert.deepEqual(normalizePlacement([1, 2]), [1, 2])
  assert.deepEqual(normalizePlacement('2'), [2])
  assert.deepEqual(normalizePlacement(null), [2], '非法值落到 AI 输出，不要变成"到处都跑"')
})
