#!/usr/bin/env node
/**
 * golden 的**来源**验证（多例）：证明每个 fixture 确实来自它**声明的基准**，
 * 而不是在当前版上"自己拍自己"。
 *
 * ★★ 锚点（2026-11-04 定稿）：**npm 发布物 dsh-tavern@2.7.2**，不是 git SHA。
 *   为什么：2026-11-01 为脱敏做过 filter-branch 全历史重写，原基准 a816afd / aa76a20 的
 *   提交对象在本地与远端都已不存在；git 历史随时可能再被重写，而 **npm tarball 改不了**
 *   （registry 按 integrity 寻址，下面把 2.7.2 的 SRI 钉死）。所以本脚本：
 *     1. 拉 registry metadata，校验 2.7.2 的 dist.integrity 与钉死值一致（换源/被篡改都响亮失败）；
 *     2. 下载 tarball，按 SRI 校验后解包；
 *     3. 把**当前版**的 golden 测试拷进去，UPDATE_GOLDEN=1 重新生成；
 *     4. 与仓库里的 fixture 比。
 *
 * 两个案例的口径（2026-11-04 诊断定稿；诊断结论：2.7.2 → 2.8.1 无"改坏"，差异全部是
 * 已声明的功能新增）：
 *   · `golden-prompt` → **整文件逐字节比**（只归一化 CRLF）。实测 2.7.2 重新生成的产物与
 *     仓库 fixture 完全一致 —— 纯函数层（世界书匹配 / 清洗 / 预算 / 选段）从重构前到现在
 *     语义未变，这张网直接接回重构前。
 *   · `golden-host-assembly-rich` → 2.7.2 之后**有意新增**了【设定优先级】段与一处抬头措辞，
 *     逐字节必不一致。口径是「**声明增量**」：对每条 capture，(2.7.2 产物 → 仓库 fixture) 的
 *     全部差异块必须**逐字命中**下面 DECLARED_HUNKS 里钉死的集合 —— 出现任何未声明的差异
 *     块（无论改旧段还是新段被改）都响亮失败。想新增内容 = 显式改 DECLARED_HUNKS（可审阅）。
 *
 * 用法：node tools/check-golden-origin.mjs   # exit 0 = 所有案例来源可信
 * 注意：需要网络。registry 取不到 / integrity 不符 → **响亮失败**，不做静默降级。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** ★ 钉死的锚点。换基准（改 version / integrity）= 声明"来源换了"，必须连注释一起改。 */
export const ANCHOR = {
  pkg: 'dsh-tavern',
  version: '2.7.2',
  integrity: 'sha512-ZAIhMANB4gw27YIfJdHIzVDl9BgrV66m6GU5W0Qn05mUw3cYU1hNhxCcPJsC2gvcbl7QCfvQZkfdj0rXr9puGw==',
  registry: 'https://registry.npmjs.org',
}

/**
 * rich 案例：声明过的差异块（2.7.2 产物 → 当前夹具）。按 capture 下标分组。
 * 诊断结论（2026-11-04）：全部是 2.7.3→2.7.27 的功能新增 ——
 *   ① 新增【设定优先级】段（skill 优先级功能）；② 抬头「设定来源」扩写成
 *   「角色设定与事实来源（…）」；③ 新增两条"技能指令按【设定优先级】裁决"的说明。
 * 除这些之外，逐字符一致。
 */
const DECLARED_HUNKS = [[{"from":"","to":"设定优先级 · preset（预设优先，本会话生效）】\n- 裁决顺序：角色卡 / 世界书 / 预设模块（写作要求、模块包） > skill 与工作流指令。\n- skill 只提供方法层：流程、结构、工艺、检查清单；不得替换或改写角色身份、世界观、人物关系、语气、预设写作要求与输出格式。skill 中的安全红线与合规项仍然有效。\n- skill 与本段冲突时，一律以本段（预设）为准；仍按角色正常回复，不要向用户解释本条规则。\n\n【"},{"from":"来源","to":"与事实来源（skill 的流程/文风按顶部【设定优先级】裁决）"},{"from":"","to":"技能与工作流指令不属于角色设定，按本段顶部的【设定优先级】裁决。\n"},{"from":"","to":"（本会话设定优先级：preset = 预设优先。skill 只补流程与工艺，不得覆盖角色卡/世界书/预设写作要求。）"}],[{"from":"","to":"设定优先级 · preset（预设优先，本会话生效）】\n- 裁决顺序：角色卡 / 世界书 / 预设模块（写作要求、模块包） > skill 与工作流指令。\n- skill 只提供方法层：流程、结构、工艺、检查清单；不得替换或改写角色身份、世界观、人物关系、语气、预设写作要求与输出格式。skill 中的安全红线与合规项仍然有效。\n- skill 与本段冲突时，一律以本段（预设）为准；仍按角色正常回复，不要向用户解释本条规则。\n\n【"},{"from":"设定来源","to":"角色设定与事实来源（skill 的流程/文风按顶部【设定优先级】裁决）"},{"from":"","to":"技能与工作流指令不属于角色设定，按本段顶部的【设定优先级】裁决。\n"},{"from":"","to":"（本会话设定优先级：preset = 预设优先。skill 只补流程与工艺，不得覆盖角色卡/世界书/预设写作要求。）"}]]

const norm = (s) => String(s).replace(/\r\n/g, '\n')

/** 非空跑防护：投影必须真的有东西，否则"没比"也能算出相等。 */
function assertProjectionNonVacuous(name, p) {
  if (!p.captures.length) return '投影里一条 captures 都没有（判据空跑）'
  for (const c of p.captures) {
    if (typeof c.sha256 !== 'string' || c.sha256.length !== 64) return 'captures[' + c.mode + '] 的 sha256 不是 64 位十六进制'
    if (!Number.isFinite(c.bytes) || c.bytes <= 0) return 'captures[' + c.mode + '] 的 bytes 不是正数'
  }
  if (!Number.isFinite(p.sectionSizes.wb)) return 'sectionSizes.wb 缺失'
  return null
}

function fail(msg, extra = '') {
  console.error('❌ ' + msg)
  if (extra) console.error(String(extra).split('\n').slice(-12).map((l) => '   ' + l).join('\n'))
  process.exit(1)
}

// ── ① 拉锚点：metadata → integrity 校验 → 下载 tarball → SRI 校验 → 解包 ──
const fetchText = (url) => {
  const r = spawnSync('curl', ['-sS', '--max-time', '60', url], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) fail('registry 不可达（curl ' + r.status + '）：' + url, r.stderr)
  return r.stdout
}
const meta = JSON.parse(fetchText(ANCHOR.registry + '/' + ANCHOR.pkg + '/' + ANCHOR.version))
const gotIntegrity = meta.dist && meta.dist.integrity
if (gotIntegrity !== ANCHOR.integrity) {
  fail('registry 上 ' + ANCHOR.pkg + '@' + ANCHOR.version + ' 的 integrity 与钉死值不一致 —— registry 被换源/篡改，或锚点被改动。\n  registry: ' + gotIntegrity + '\n  钉死值 : ' + ANCHOR.integrity)
}
const tgzPath = path.join(os.tmpdir(), 'dsh-tavern-' + ANCHOR.version + '.tgz')
{
  const r = spawnSync('curl', ['-sS', '--max-time', '120', '-o', tgzPath, meta.dist.tarball], { encoding: 'utf8', timeout: 180000 })
  if (r.status !== 0) fail('tarball 下载失败：' + meta.dist.tarball, r.stderr)
}
{
  const digest = crypto.createHash('sha512').update(fs.readFileSync(tgzPath)).digest('base64')
  if ('sha512-' + digest !== ANCHOR.integrity) fail('tarball SRI 校验失败（下载不完整或被篡改）')
}

const baseDir = path.join(os.tmpdir(), 'golden-origin-npm-' + ANCHOR.version + '-' + Date.now())
fs.mkdirSync(baseDir, { recursive: true })
{
  // ★ Windows 的 tar 把 "C://…" 当远程主机名（冒号），必须复制进目标目录用相对路径
  const local = path.join(baseDir, 'anchor.tgz')
  fs.copyFileSync(tgzPath, local)
  const r = spawnSync('tar', ['-xzf', 'anchor.tgz', '--strip-components', '1'], { encoding: 'utf8', cwd: baseDir })
  if (r.status !== 0) fail('tarball 解包失败', r.stderr)
}
if (!fs.existsSync(path.join(baseDir, 'lib', 'index.js'))) fail('2.7.2 解包结果异常：没有 lib/index.js')

// ── ② 逐案例：当前测试 + 2.7.2 代码 → 重新生成 → 比 ──
const CASES = [
  { name: 'golden-prompt', testRel: 'tests/golden-prompt.test.js', fixtureRel: 'tests/fixtures/golden-prompt.json', mode: 'file' },
  { name: 'golden-host-assembly-rich', testRel: 'tests/golden-host-assembly-rich.test.js', fixtureRel: 'tests/fixtures/golden-host-assembly-rich.json', mode: 'rich-declared',
    // 2.7.2 还没有 lib/server/assemble.js ⇒ ③ 静态契约必然 ENOENT（预期，按声明跳过）
    skip: '静态契约' },
]

let passed = 0
for (const c of CASES) {
  const fixturePath = path.join(REPO, c.fixtureRel)
  if (!fs.existsSync(fixturePath)) fail('仓库里找不到 fixture：' + c.fixtureRel)
  fs.mkdirSync(path.join(baseDir, path.dirname(c.testRel)), { recursive: true })
  fs.mkdirSync(path.join(baseDir, path.dirname(c.fixtureRel)), { recursive: true })
  fs.copyFileSync(path.join(REPO, c.testRel), path.join(baseDir, c.testRel))

  const testArgs = ['--test']
  if (c.skip) testArgs.push('--test-skip-pattern=' + c.skip)
  testArgs.push(c.testRel)
  const gen = spawnSync(process.execPath, testArgs, {
    cwd: baseDir, encoding: 'utf8', timeout: 120000, env: { ...process.env, UPDATE_GOLDEN: '1' },
  })
  const out = String(gen.stdout || '') + String(gen.stderr || '')
  if (gen.status !== 0) fail('[' + c.name + '] 在 ' + ANCHOR.version + ' 上重新生成失败', out)
  const regenerated = path.join(baseDir, c.fixtureRel)
  if (!fs.existsSync(regenerated)) fail('[' + c.name + '] 基准版跑完却没有产出 fixture', out)

  if (c.mode === 'file') {
    const a = norm(fs.readFileSync(regenerated, 'utf8'))
    const b = norm(fs.readFileSync(fixturePath, 'utf8'))
    if (a !== b) {
      let detail = ''
      try {
        const ja = JSON.parse(a); const jb = JSON.parse(b)
        for (const k of [...new Set([...Object.keys(ja), ...Object.keys(jb)])]) {
          if (JSON.stringify(ja[k]) !== JSON.stringify(jb[k])) {
            detail += '   [' + k + '] 不同\n     2.7.2 生成: ' + JSON.stringify(ja[k]).slice(0, 200) + '\n     仓库里  : ' + JSON.stringify(jb[k]).slice(0, 200) + '\n'
          }
        }
      } catch (e) { detail = '（JSON 解析失败：' + e.message + '）' }
      fail('[' + c.name + '] fixture 与「在 ' + ANCHOR.version + ' 上生成的产物」**不一致** —— 来源声明不成立', detail)
    }
    console.log('✅ ' + c.name + '：在 npm ' + ANCHOR.version + ' 上重新生成，与仓库 fixture **逐字节一致**'
      + '（' + Buffer.byteLength(a) + ' 字节，' + Object.keys(JSON.parse(b)).length + ' 个采集键）')
  } else {
    // rich-declared：全部差异块必须逐字命中 DECLARED_HUNKS
    const genFix = JSON.parse(fs.readFileSync(regenerated, 'utf8'))
    const repoFix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    const nonVacuous = assertProjectionNonVacuous(c.name, repoFix)
    if (nonVacuous) fail('[' + c.name + '] ' + nonVacuous)
    if (genFix.captures.length !== repoFix.captures.length) fail('[' + c.name + '] capture 层数变了')
    if (JSON.stringify(genFix.sectionSizes) !== JSON.stringify(repoFix.sectionSizes)) {
      fail('[' + c.name + '] sectionSizes 不同（世界书/NSFW 段的冻结量变了）：\n  2.7.2: ' + JSON.stringify(genFix.sectionSizes) + '\n  仓库 : ' + JSON.stringify(repoFix.sectionSizes))
    }
    for (let i = 0; i < repoFix.captures.length; i++) {
      const from = genFix.captures[i].cardOut
      const to = repoFix.captures[i].cardOut
      if (from === to) continue
      const allowed = DECLARED_HUNKS[i] || []
      const hunks = []
      let x = from, y = to
      {
        let i2 = 0, j2 = 0
        while (i2 < x.length || j2 < y.length) {
          if (x[i2] === y[j2]) { i2++; j2++; continue }
          let best = null
          for (let d = 1; d < 800 && !best; d++) {
            for (let bi = 0; bi <= d; bi++) {
              const ni = i2 + d - bi, nj = j2 + bi
              if (x.slice(ni, ni + 30) === y.slice(nj, nj + 30)) { best = { ni, nj }; break }
            }
          }
          if (!best) { hunks.push([x.slice(i2), y.slice(j2)]); break }
          hunks.push([x.slice(i2, best.ni), y.slice(j2, best.nj)])
          i2 = best.ni; j2 = best.nj
        }
      }
      const bad = hunks.filter(([dx, dy]) => !allowed.some((h) => h.from === dx && h.to === dy))
      if (bad.length) {
        let detail = ''
        for (const [dx, dy] of bad) {
          detail += '   [-] ' + JSON.stringify(dx.slice(0, 160)) + '\n   [+] ' + JSON.stringify(dy.slice(0, 160)) + '\n'
        }
        fail('[' + c.name + '] capture[' + i + '] 出现了**未声明**的差异块 —— 要么是改坏了旧语义，要么是有意新增却忘了改 DECLARED_HUNKS', detail)
      }
      console.log('✅ ' + c.name + ' capture[' + i + ']：差异全部命中声明（' + hunks.length + ' 块 / 声明 ' + allowed.length + ' 块）')
    }
    console.log('✅ ' + c.name + '：在 npm ' + ANCHOR.version + ' 上重新生成，**声明增量归约后一致**')
  }
  passed++
}

try { fs.rmSync(baseDir, { recursive: true, force: true }); try { fs.rmSync(tgzPath, { force: true }) } catch {} } catch (e) {}
console.log('   ⇒ 「golden 源自 npm ' + ANCHOR.version + '（重构前）」不是自述，是机器结论（' + passed + ' 个案例）')
