/**
 * 通用预设增强层（preset-forge）回归测试
 *
 * 要解决的问题：用户自己的预设（250 条模块）文风 / 防抢话 / 防全知不如 SillyTavern。
 * 本能力不针对某一份预设做改写，而是给**任何**预设一个下限，两条通路：
 *   ① 模块包 merge 进 presets.json（面板「套用」，写文件，持久）
 *   ② 运行时注入（面板开关，**默认关闭**，装配 system prompt 时追加在最后一段）
 *
 * 硬约束（每条都要有能变红的判据，不是永真断言）：
 *   A. 输出格式契约（<content> / <now_plot> / <Abstract> / <audio> / <img> /
 *      <video> / <VariableThink> / <VariableEdit> / <era_data>）必须被显式保护，
 *      且「格式指令优先于文风要求」必须写进条款；
 *   B. 名字含 变量 / Variable / era / 格式 / format 的模块（变量组）**只补不覆盖**；
 *   C. 运行时注入**默认关闭**（字段缺失 / false / 字符串 "true" 都不得注入）。
 *
 * 运行：node --test tests/preset-enhance.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠ Windows 上不能用 new URL(import.meta.url).pathname —— 它会给出 "/C:/..."，
//    拼出来的路径会变成 "C:\C:\..."。必须用 fileURLToPath。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = path.resolve(HERE, '..')
const PACK_PATH = path.join(REPO, 'lib', 'preset-enhance-pack.json')

// 端到端的那几条要写盘，必须先把 DSH_HOME 指到临时目录，再 import index.js
// （index.js 在模块加载时就按 $DSH_HOME 绑定 ROOT，晚设来不及）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-enhance-'))
process.env.DSH_HOME = TMP_HOME

const utils = await import(pathToFileURL(path.join(REPO, 'lib', 'utils.js')).href)
const { _test } = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href)

const {
  ENHANCE_CONTRACT_TAGS, ENHANCE_PACK_FILE, isEnhanceProtectedName,
  normalizeEnhancePack, mergeEnhanceModules, buildEnhanceRuntimeBlock,
  enhanceRuntimeEnabled, readEnhancePack, applyEnhancePack,
} = _test

// ── 1. 模块包本身的结构合法性 ────────────────────────────

test('[1] 模块包是合法 JSON，且每条都是 {name, content, enabled}', () => {
  const raw = fs.readFileSync(PACK_PATH, 'utf8')
  const pack = JSON.parse(raw)          // 解析失败会直接抛，测试即红
  assert.ok(Array.isArray(pack), '模块包必须是数组')
  assert.ok(pack.length >= 5, '模块条数太少，覆盖不全：' + pack.length)
  for (const m of pack) {
    assert.equal(typeof m.name, 'string')
    assert.ok(m.name.trim().length > 0, '模块名不能为空')
    assert.equal(typeof m.content, 'string')
    assert.ok(m.content.trim().length > 50, '模块内容过短，等于空话：' + m.name)
    assert.equal(typeof m.enabled, 'boolean')
    // 只能有这三个键：多出的键（比如 _collapsed）会混进预设条目的形态里
    assert.deepEqual(Object.keys(m).sort(), ['content', 'enabled', 'name'])
  }
})

test('[2] normalizeEnhancePack 会丢弃缺 name / 缺 content 的脏条目（对照臂：不丢就会通过）', () => {
  const dirty = [
    { name: 'A', content: 'x'.repeat(60), enabled: true },
    { name: '', content: 'y'.repeat(60) },          // 无名
    { name: 'B', content: '   ' },                  // 空内容
    null,
    'not-an-object',
  ]
  const clean = normalizeEnhancePack(dirty)
  assert.equal(clean.length, 1, '脏条目必须被丢弃')
  assert.equal(clean[0].name, 'A')
  // 对照臂：如果 normalize 原样返回，长度会是 5 —— 上面那条断言就红了
  assert.equal(normalizeEnhancePack(dirty).length !== dirty.length, true)
})

test('[3] 模块包名字不与「受保护」关键字冲突（否则自己会被自己保护住）', () => {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))
  const bad = pack.filter(m => isEnhanceProtectedName(m.name))
  assert.equal(bad.length, 0, '这些模块名会命中变量组保护规则：' + bad.map(m => m.name).join('、'))
})

// ── 2. 输出格式契约（硬约束 A）────────────────────────────

test('[4] 运行时注入块逐个点名全部契约标签，并声明不得删除/改名/嵌套', () => {
  const block = buildEnhanceRuntimeBlock()
  for (const tag of ENHANCE_CONTRACT_TAGS) {
    assert.ok(block.includes(`<${tag}>`), '运行时块缺少契约标签 <' + tag + '>')
  }
  assert.ok(block.includes('不得删除'), '必须写明「不得删除」')
  assert.ok(/改名/.test(block), '必须写明「不得改名」')
  assert.ok(/嵌套/.test(block), '必须写明「不得嵌套」')
})

test('[5] 运行时块声明「格式指令优先于文风要求」（缺了这条，文风条款会吃掉输出契约）', () => {
  const block = buildEnhanceRuntimeBlock()
  // 契约一节必须带「最高优先级」且显式压过文风
  assert.ok(/输出契约/.test(block) && /最高优先级/.test(block), '缺少「输出契约=最高优先级」声明')
  assert.ok(/优先于下面所有文风要求|优先于文风|以契约为准/.test(block), '缺少「优先于文风」的显式声明')
  // 对照臂：一个只写文风、不提契约的块必须**不**满足这些判据
  const naive = '文风要求：短句长句交替，禁止套话。'
  assert.equal(/输出契约/.test(naive), false)
})

test('[6] 模块包里也有契约条款，且视角/抢话限制被限定在契约之内', () => {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))
  const contract = pack.filter(m => /契约|输出契约|纪律/.test(m.name))
  assert.ok(contract.length >= 1, '模块包缺少输出契约模块')
  const merged = contract.map(m => m.content).join('\n')
  for (const tag of ENHANCE_CONTRACT_TAGS) {
    assert.ok(merged.includes(`<${tag}>`), '契约模块未点名 <' + tag + '>')
  }
  assert.ok(/优先/.test(merged), '契约模块必须写明「契约优先于文风」')
})

// ── 3. 运行时开关默认关闭（硬约束 C）─────────────────────

test('[7] 开关默认关闭：字段缺失 / false / 字符串 "true" 都不注入', () => {
  assert.equal(enhanceRuntimeEnabled(undefined), false, 'undefined 必须视为关闭')
  assert.equal(enhanceRuntimeEnabled(null), false)
  assert.equal(enhanceRuntimeEnabled({}), false, '字段缺失必须视为关闭（默认关闭的落点）')
  assert.equal(enhanceRuntimeEnabled({ enhanceRuntime: false }), false)
  assert.equal(enhanceRuntimeEnabled({ enhanceRuntime: 'true' }), false, '字符串 "true" 不算开启')
  assert.equal(enhanceRuntimeEnabled({ enhanceRuntime: 1 }), false)
  assert.equal(enhanceRuntimeEnabled({ enhanceRuntime: true }), true, '显式 true 才开启')
})

test('[8] 源码里运行时段确实走 enhanceRuntimeEnabled 闸门（防止有人改回反向判定）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  const seg = src.slice(src.indexOf("name: 'tavern:enhance'"))
  assert.ok(seg.length > 0, '找不到 tavern:enhance 段')
  const head = seg.slice(0, 600)
  assert.ok(/enhanceRuntimeEnabled\(state\)/.test(head), 'tavern:enhance 段必须用 enhanceRuntimeEnabled 闸门')
  // 反向判定（字段缺失即开启）是事故，明确禁止
  assert.equal(/if \(state\.enhanceRuntime\) return ''/.test(head), false)
  assert.equal(/!== true/.test(head), false, '不要再手写 !== true，统一走 enhanceRuntimeEnabled')
})

test('[9] 运行时段 order 大于 nsfw 段（位置即优先级：必须排在最后）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
  const nsfw = /name: 'tavern:nsfw',\s*\n\s*order: ([\d.]+)/.exec(src)
  const enh = /name: 'tavern:enhance',\s*\n\s*order: ([\d.]+)/.exec(src)
  assert.ok(nsfw && enh, '找不到两段的 order')
  assert.ok(Number(enh[1]) > Number(nsfw[1]),
    'enhance 必须在 nsfw 之后：enhance=' + enh[1] + ' nsfw=' + nsfw[1])
})

// ── 4. merge：去重、不覆盖同名、保护变量组 ────────────────

test('[10] merge 只补缺的：同名模块默认保留用户版本', () => {
  const existing = [
    { name: '✨增强丨文风·每段一件事', content: '用户自己写的版本', enabled: true },
    { name: '用户原有模块', content: '保留', enabled: false },
  ]
  const pack = [{ name: '✨增强丨文风·每段一件事', content: '增强版', enabled: true },
                { name: '✨增强丨防抢话·不写用户角色', content: '新增', enabled: true }]
  const r = mergeEnhanceModules(existing, pack, { overwrite: false })
  assert.equal(r.added, 1, '只应新增 1 条')
  assert.equal(r.kept, 1, '同名应保留 1 条')
  assert.equal(r.overwritten, 0, '默认不覆盖')
  assert.equal(r.modules.length, 3)
  const mine = r.modules.find(m => m.name === '✨增强丨文风·每段一件事')
  assert.equal(mine.content, '用户自己写的版本', '同名必须保留用户版本')
  assert.equal(mine.enabled, true)
})

test('[11] overwrite=true 时同名才被覆盖（对照臂：与 [10] 结果必须不同）', () => {
  const existing = [{ name: '✨增强丨文风·每段一件事', content: '用户自己写的版本', enabled: true }]
  const pack = [{ name: '✨增强丨文风·每段一件事', content: '增强版', enabled: true }]
  const r = mergeEnhanceModules(existing, pack, { overwrite: true })
  assert.equal(r.overwritten, 1)
  assert.equal(r.modules[0].content, '增强版')
  // 对照臂
  const off = mergeEnhanceModules(existing, pack, { overwrite: false })
  assert.equal(off.modules[0].content, '用户自己写的版本')
})

test('[12] 变量组 / 格式类模块**只补不覆盖**，overwrite 对它无效', () => {
  const existing = [{ name: '🔒尽可能不要动（变量组）', content: '用户变量组原文', enabled: true }]
  const pack = [{ name: '🔒尽可能不要动（变量组）', content: '增强版想覆盖它', enabled: true }]
  for (const ow of [false, true]) {
    const r = mergeEnhanceModules(existing, pack, { overwrite: ow })
    assert.equal(r.protectedKept, 1, '受保护模块必须被记为保护（overwrite=' + ow + '）')
    assert.equal(r.overwritten, 0)
    assert.equal(r.modules[0].content, '用户变量组原文', '变量组内容一个字都不能动（overwrite=' + ow + '）')
  }
  // 各类保护关键字都要命中
  for (const n of ['💯丨变量更新', '🚀丨格式增强', 'ERA Variables', 'output format', 'era_data sync']) {
    assert.equal(isEnhanceProtectedName(n), true, '应被判定为受保护：' + n)
  }
  assert.equal(isEnhanceProtectedName('✨增强丨文风·每段一件事'), false, '普通模块不应被误判为受保护')
})

test('[13] merge 是纯函数：不改入参数组与入参对象', () => {
  const existing = [{ name: 'A', content: 'a', enabled: true }]
  const snapshot = JSON.stringify(existing)
  const pack = [{ name: 'A', content: '增强版', enabled: true }, { name: 'B', content: 'b', enabled: true }]
  const r = mergeEnhanceModules(existing, pack, { overwrite: true })
  assert.equal(JSON.stringify(existing), snapshot, '入参被改写了')
  assert.equal(r.modules.length, 2)
})

test('[14] 内置包 merge 进 250 条的真规模预设：条数只增，已有内容不变', () => {
  const big = []
  for (let i = 0; i < 250; i++) big.push({ name: '模块' + i, content: '内容' + i, enabled: true })
  big.push({ name: '🔒尽可能不要动（变量组）', content: '变量组原文', enabled: true })
  const before = big.map(m => m.content)
  const r = mergeEnhanceModules(big, readEnhancePack(), { overwrite: false })
  assert.equal(r.added, readEnhancePack().length, '内置包应整包新增（真预设里没有同名）')
  assert.equal(r.modules.length, 251 + readEnhancePack().length)
  for (let i = 0; i < before.length; i++) {
    assert.equal(r.modules[i].content, before[i], '第 ' + i + ' 条的内容被改动了')
  }
})

// ── 5. 端到端：套用到预设（写临时 DSH_HOME，不动用户数据）──

test('[15] applyEnhancePack：备份 + 落盘 + 幂等 + 不动变量组', () => {
  const dir = path.join(TMP_HOME, '.agent-presets', 'tavern-lite')
  fs.mkdirSync(dir, { recursive: true })
  const pj = path.join(dir, 'presets.json')
  const seed = [{
    name: '双人成行v10.0—青云上',
    _collapsed: true,
    modules: [
      { name: '🔒尽可能不要动（变量组）', content: '变量组原文', enabled: true },
      { name: '模块0', content: '原文0', enabled: true },
    ],
  }]
  fs.writeFileSync(pj, JSON.stringify(seed, null, 2), 'utf8')

  const r1 = applyEnhancePack('default', { overwrite: false, groupIndex: 0 })
  assert.ok(r1.backup && fs.existsSync(r1.backup), '必须生成备份文件：' + r1.backup)
  assert.ok(/presets\.json\.bak-\d{8}-\d{6}$/.test(r1.backup), '备份名应为 presets.json.bak-<时间戳>：' + r1.backup)
  assert.equal(fs.readFileSync(r1.backup, 'utf8'), JSON.stringify(seed, null, 2), '备份内容必须等于套用前的原文件')

  const after1 = JSON.parse(fs.readFileSync(pj, 'utf8'))
  assert.equal(after1.length, 1)
  assert.equal(after1[0].modules.length, 2 + readEnhancePack().length)
  assert.equal(after1[0].modules[0].content, '变量组原文', '变量组一个字都没动')
  assert.equal(after1[0].modules[1].content, '原文0')

  // 幂等：再套一次，条数不变（同名全保留）
  const r2 = applyEnhancePack('default', { overwrite: false, groupIndex: 0 })
  assert.equal(r2.stat.added, 0, '第二次套用不应再新增')
  assert.equal(r2.stat.kept, readEnhancePack().length)
  const after2 = JSON.parse(fs.readFileSync(pj, 'utf8'))
  assert.equal(after2[0].modules.length, after1[0].modules.length)

  // 覆盖模式：变量组仍然不动
  applyEnhancePack('default', { overwrite: true, groupIndex: 0 })
  const after3 = JSON.parse(fs.readFileSync(pj, 'utf8'))
  assert.equal(after3[0].modules[0].content, '变量组原文', '覆盖模式下变量组仍不得被改')
  assert.equal(after3[0].modules.length, after1[0].modules.length, '覆盖模式不应改变条数')
})

test('[16] applyEnhancePack：预设组下标越界回落到 0，空 presets.json 也能套', () => {
  const dir = path.join(TMP_HOME, '.agent-presets', 'tavern-lite')
  fs.writeFileSync(path.join(dir, 'presets.json'), '[]', 'utf8')
  const r = applyEnhancePack('default', { overwrite: false, groupIndex: 99 })
  assert.equal(r.groupIndex, 0, '越界必须回落')
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8'))
  assert.equal(after.length, 1)
  assert.equal(after[0].modules.length, readEnhancePack().length)
})

test('[17] 运行时块不含会打坏 DSH 模板引擎的 {{...}}（避免 unknown prompt variable）', () => {
  const block = buildEnhanceRuntimeBlock()
  assert.equal(/\{\{/.test(block), false, '运行时块里不能出现 {{')
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'))
  for (const m of pack) {
    assert.equal(/\{\{/.test(m.content), false, '模块「' + m.name + '」含 {{ 模板变量')
  }
})

test('[18] 包文件名常量与实际文件对得上（防止改名后加载不到）', () => {
  assert.equal(ENHANCE_PACK_FILE, 'preset-enhance-pack.json')
  assert.ok(fs.existsSync(path.join(REPO, 'lib', ENHANCE_PACK_FILE)))
  assert.ok(readEnhancePack().length >= 5, 'readEnhancePack 必须读到模块')
})

test('[19] 运行时块覆盖四类要求：防抢话 / 防全知 / 文风 / 抗过拟合', () => {
  const b = buildEnhanceRuntimeBlock()
  assert.ok(/防抢话/.test(b), '缺防抢话')
  assert.ok(/代用户角色说话|用户角色/.test(b), '防抢话条款不够具体')
  assert.ok(/有限视角|防全知/.test(b), '缺有限视角')
  assert.ok(/外显/.test(b), 'NPC 内心必须只允许写外显')
  assert.ok(/套话|升华/.test(b), '缺禁套话/升华结尾')
  assert.ok(/模板|复用/.test(b), '缺抗过拟合（禁模板 / 禁复用上轮比喻）')
})

test('[20] 面板侧：开关与「套用」入口都真的存在（源码级，防 UI 改没了）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')
  for (const id of ['tavern-enhance-runtime', 'tavern-enhance-runtime-status',
                    'tavern-enhance-apply', 'tavern-enhance-overwrite', 'tavern-enhance-status']) {
    assert.ok(src.includes(id), '面板缺少元素：' + id)
  }
  assert.ok(/\/api\/tavern\/preset\/enhance/.test(src), '面板未调用套用接口')
  assert.ok(/enhanceRuntime/.test(src), '面板未提交运行时开关')
  // 开关默认不勾选（HTML 里不带 checked）
  const idx = src.indexOf('id="tavern-enhance-runtime"')
  assert.ok(idx > 0)
  assert.equal(/checked/.test(src.slice(idx - 200, idx)), false, '运行时开关默认必须是未勾选')
})

test('[21] 清理：临时 DSH_HOME 不在用户真实目录里', () => {
  assert.notEqual(TMP_HOME, os.homedir())
  assert.ok(TMP_HOME.startsWith(os.tmpdir()))
})
