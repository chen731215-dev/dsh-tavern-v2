#!/usr/bin/env node
/**
 * 仓库卫生闸门：**git 跟踪的**文件里不许出现凭据 / 会话记录 / 本机路径。
 *
 * 为什么要有它（而不是只靠 .gitignore）：.gitignore 只能挡"没被跟踪的文件"，
 * 挡不住 `git add -f`、挡不住"先把文件放进仓库再 gitignore"、也挡不住别人手滑把
 * 日志目录拷进来。而**公开仓库里一旦提交，凭据就永久留在历史里**（删掉也还能检索）。
 * 所以这里做成**机器检查**，并接进 pre-commit（推之前）+ CI（推之后兜底）。
 *
 * 检查两类东西：
 *   ① **内容**：token / 私钥 / 本机绝对路径 / 会话 id 形态（只扫文本，二进制跳过）
 *   ② **文件名**：会话日志、凭据文件、备份目录等**根本不该被跟踪**的路径
 *
 * 用法：
 *   node tools/check-repo-hygiene.mjs            # 扫全部已跟踪文件（CI / npm run check 用）
 *   node tools/check-repo-hygiene.mjs --staged   # 只扫暂存区（pre-commit 钩子用）
 *   node tools/check-repo-hygiene.mjs --list     # 只列规则
 *
 * ★★ 退出码（2026-10-09，task-33）：**必须区分「环境不可用」与「真有违规」**
 *   0 = 检查通过
 *   1 = **真有违规**（下面会打印违规清单）—— 这才是"仓库里有问题"
 *   2 = **环境不可用**：拿不到 git 清单（`spawnSync('git', …)` 根本没起来 / 被沙箱拦）
 *       —— 本仓口径与 `tools/check-client-integrity.mjs` 一致（它是 `2 = 用法/读取错误`）。
 *
 *   为什么必须分（实测成因，不是纸面风险）：本机宿主环境下 node 派生子进程（`spawnSync`）会被拦，
 *   于是 `stagedFiles()` 拿到 `status=null` / `error.code='EBUSY'`。旧版把这一律读成
 *   `❌ 不是 git 仓库（拿不到文件清单）` 并 `exit(1)` —— 把**环境限制**伪装成了**代码故障**：
 *   钩子只能靠 `--no-verify`（那会跳过所有钩子，更难审计）。这就是 task-33 修的缺陷本身，**不许回退**。
 *
 *   ⚠️ `EBUSY` 是**沙箱属性、不是本仓属性**（AGENTS.md §8 已立此口径）⇒ 不许把它写成"仓库不是 git 仓库"。
 *   ⚠️ 拿不到清单**绝不许**静默当成"检查通过"（SKIP ≠ pass）—— 那会免费送出一个绿灯。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 内容规则：命中即失败。每条的 why 写清"为什么这东西不能进仓库"。 */
export const CONTENT_RULES = [
  { id: 'github-pat', re: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|gh[osu]_[A-Za-z0-9]{36})\b/, why: 'GitHub 令牌（凭据泄露）' },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/, why: 'npm 令牌（凭据泄露）' },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}\b/, why: '形似 API key 的长串（凭据泄露）' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥文件（凭据泄露，必须吊销/轮换）' },
  // ⚠️ 占位符不算：`xxx` / `...` / `user` / `<name>` 是文档与提示文案里的示意写法
  //   （实测本仓客户端里就有 `/Users/xxx/.dsh`，RELEASE_NOTES 里有 `C:\Users\...`）。
  //   同时吃两种写法：源码里的 `C:\\Users\\`（转义后双反斜杠）与真实路径 `C:\Users\`，以及 POSIX 的 `/Users/<name>/`。
  // ★ 用户名段必须是 {1,}（不是 {2,}）：本机用户名就是**单字符**（`C:\\Users\\<单字符>\\…`），
  //   旧的 {2,} 会让它**直接穿过闸门**（2026-10-08 tavern-dev 的最小复现）。
  { id: 'machine-home-path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}(?!xxx|\.\.\.|user\b|username\b|<)[A-Za-z0-9_.-]{1,}|\/Users\/(?!xxx|\.\.\.|user\b|username\b|<)[A-Za-z0-9_.-]{1,}/, why: '本机绝对路径（含真实用户名）' },
  { id: 'session-id-ish', re: /\bsession[._-]?(?:id)?["'\s:=]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, why: '真实会话 id' },
  // ⚠️ 判据口径（2026-10-08，经 tavern-reviewer 复核修正）：
  //   · 值里**允许 `+`** —— base64 / JWT 字母表就含 `+`，禁掉它会漏掉真凭据（我第一版就是这么错的）；
  //   · 只否决**「空白 + 加号」这个拼接签名**（`token=' + x + '`），它才是误报的成因；
  //   · 残留边界（如实）：真值里恰好出现「空格+`+`」的会漏判；无空白的拼接（`token='+x+'`）仍可能误报。
  { id: 'auth-assignment', re: /["']?(?:token|_authToken|password|passwd|api[_-]?key)["']?\s*[:=]\s*["'](?![^"'\r\n]*[ \t]\+)[^"'\r\n]{16,}["']/i, why: '疑似把凭据写进配置/代码' },
]

/** 文件名规则：这些路径**不该被跟踪**（与 .gitignore 互补，且能挡住 `git add -f`）。 */
export const PATH_RULES = [
  { id: 'sessions-dir', re: /(?:^|\/)sessions?\//i, why: '会话记录目录（含私人对话、可能含凭据）' },
  { id: 'session-log', re: /\.(?:jsonl|zstd|jsonl\.zstd)$/i, why: '会话日志/压缩日志' },
  { id: 'dotenv', re: /(?:^|\/)\.env(?:\..*)?$/, why: '环境变量文件（常放凭据）' },
  { id: 'npmrc', re: /(?:^|\/)\.npmrc$/, why: 'npm 配置（可能含 _authToken）' },
  { id: 'token-file', re: /(?:^|\/)[^/]*(?:token|secret|credential|apikey|api-key)[^/]*$/i, why: '文件名里带 token/secret/credential' },
  { id: 'tavern-data', re: /(?:^|\/)tavern-data\//i, why: '用户数据目录' },
  { id: 'scratch', re: /(?:^|\/)_scratch\//, why: '_scratch 里含"从会话日志提取 token"类脚本，绝不入库' },
  { id: 'backup', re: /(?:^|\/)[^/]*\.(?:bak|backup|old|orig)(?:[./]|$)/i, why: '备份文件' },
]

/** 只扫文本；超过这个大小或含 NUL 的跳过（不猜二进制）。 */
const MAX_SCAN = 2 * 1024 * 1024
const looksBinary = (buf) => buf.includes(0)

/**
 * ★ UTF-8 BOM（EF BB BF）：**形态维度**的违规，不是"文本扫不了"。
 *   判定它的**真实理由**（照 muv 侧 §44.11 的裁决，两条都不是"传说"）：
 *     ① 主因 = 「**预先批准逐字内容**」的形态保证会被破坏 —— 本会话真的发生过一次：
 *        用带 BOM 的写文件方式改配置 ⇒ 首行被前置 3 个字节 ⇒ 落地形态 ≠ 被批准的"只改一行"形态；
 *     ② 次因 = BOM 是**尚未纳入任何判据的形态维度**：本仓有多个按源码文本做判据的消费者
 *        （切片锚点、内容断言、逐字切片……），行首/逐字匹配在第 1 行会有**不可见偏差**。
 *        今天无实际影响（`check-syntax` 走 Node 解析，Node 会剥 BOM）——但那是"恰好"，不是判据。
 *   ⚠️ 一条**已撤回**的旧论证：曾写"BOM 贴着 .gitignore 第一条模式 ⇒ 第 1 行规则静默失效"。
 *      实测**未复现**（git 2.55：带与不带 BOM 的 .gitignore 命中结果一致）⇒ 不要再引用它设计判据。
 *   ⚠️ 也**不要**宣称"BOM 会让 git 忽略首行配置"之类的机制解释 —— 本仓规矩：任何机制解释上材料前先做一次
 *      能证伪它的实验（这一条就是被实测否证的实例）。
 */
export const hasUtf8Bom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf

/** ★ BOM 判据的**非空跑下限**：本轮必须真的在这么多 blob 头上工作过（见 scan 末尾的报红）。
 *  tavern 实测已跟踪 109 个 ⇒ 取 50 既挡住"过小夹具/空跑"，又不会因合法地少文件而误红。 */
export const MIN_BLOB_HEADS = 50

/**
 * ★ **形态判据必须以 blob 为准**（与已立的 EOL 纪律一致：形态判据不许只看工作树）。
 *   工作树会被 `core.autocrlf` / `.gitattributes` / `working-tree-encoding` 改写，而 **blob 才是"真正提交进去的东西"**。
 *   实现：`git ls-files -s` 一次拿全部 blob sha（不逐文件求 sha），再逐个取 blob 的前 3 字节。
 *   ⚠️ 同进程内**缓存**：每次调用要对每个文件 spawn 一次 `git cat-file`（109 个 ≈ 1 秒），
 *      而测试会多次调用 `scan()` ⇒ 不缓存会让套件平白慢几十秒。
 *      反证夹具**不走这条路**：它在临时仓库里以**子进程**运行门禁 ⇒ 每个夹具都是新进程、不受缓存影响
 *      （所以"新增带 BOM 的已跟踪文件 ⇒ 必须报红"这条仍是真反证）。
 * @returns {Map<string, Buffer>|null} 仓库相对路径 → 该文件 blob 的前 3 字节；拿不到 ⇒ null（调用方必须出声）
 */
let blobHeadsCache = null
export function blobHeads() {
  if (blobHeadsCache) return blobHeadsCache
  const r = spawnSync('git', ['ls-files', '-s', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  const out = new Map()
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const m = /^\d+ ([0-9a-f]{40}) \d+\t([\s\S]*)$/.exec(rec)
    if (!m) continue
    const rel = m[2].replace(/\\/g, '/')
    const b = spawnSync('git', ['cat-file', 'blob', m[1]], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    if (b.status === 0 && b.stdout) out.set(rel, b.stdout.subarray(0, 3))
  }
  blobHeadsCache = out
  return out
}

/**
 * ★ **纯函数**：把 `spawnSync` 的结果分类成「清单」或「环境不可用」（task-33）。
 *   抽出来是为了**不依赖 spawn** 就能被测到（本机 spawn 恒失败 ⇒ 用子进程测不了这条）。
 *   ⚠️ 这是产线判据本身，不是测试替身：`gitListFiles()` 直接调用它。
 * @param {{status:number|null, error?:{code?:string}|null, stdout?:string}} r
 * @returns {{ok:true, files:string[]} | {ok:false, status:number|null, code:string|null}}
 */
export function classifyGitListResult(r) {
  if (r.error || r.status === null) {
    return { ok: false, status: r.status ?? null, code: r.error && r.error.code ? String(r.error.code) : null }
  }
  if (r.status !== 0) return { ok: false, status: r.status, code: null }
  return { ok: true, files: String(r.stdout || '').split('\0').filter(Boolean) }
}

/**
 * 跑一条 git 取清单的命令，**区分两档失败**（task-33 的修法核心）。
 *
 *   · `status === null` ⇒ 进程**根本没起来/被拦**（本机实测 `error.code='EBUSY'`）⇒ **环境不可用**；
 *   · `r.error` 存在       ⇒ spawn 层就失败了（ENOENT / EACCES …）⇒ 同样是**环境不可用**；
 *   · `status !== 0`       ⇒ git 起来了但**报错**（如确实不在仓库里）⇒ 也归**环境不可用**。
 *     ★ 为什么把"非 0 退出"也归到环境档：本工具**只**在 git 仓库里跑（pre-commit / CI / check:hygiene），
 *       拿不到清单这件事**几乎永远不是**"仓库有违规"——它是"这道闸门本轮没在做事"。
 *       真有违规走的是**另一条路**：清单拿得到、`scan()` 扫出 issue（见下方 CLI 的 exit(1)）。
 *
 * @returns {{ok:true, files:string[]} | {ok:false, status:number|null, code:string|null}}
 */
function gitListFiles(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return classifyGitListResult({ status: r.status, error: r.error, stdout: r.stdout })
}

function trackedFiles() {
  return gitListFiles(['ls-files', '-z'])
}
function stagedFiles() {
  return gitListFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
}

/**
 * ★ **仅测试用**的清单注入缝（task-33）。设了 `HYGIENE_STUB_LIST` 就返回它拆出来的清单，
 *   于是"清单正常"那条分支可以在**本机 spawn 恒失败**的情况下被验证到。
 *   ⚠️ 这道缝**只**绕过"取清单"这一步；后面的 `scan()`（含 blob 头、非空跑下限、违规判据）**照常跑**，
 *      产线行为一点没削弱 —— 在真仓库里设了它，照样会把违规文件报出来。
 *   ⚠️ 与 `--list` 无关（那走不到这里）。
 */
function stubList() {
  const s = process.env.HYGIENE_STUB_LIST
  if (typeof s !== 'string' || s === '') return null
  return s.split('\n').map((x) => x.trim()).filter(Boolean)
}

/**
 * 打印"环境不可用"的**响亮、可行动**报告（stderr）。绝不用"不是 git 仓库"这种误导性文字。
 * @param {{status:number|null, code:string|null}|null} detail
 */
export function reportEnvUnavailable(which, detail) {
  const code = detail && detail.code ? detail.code : '(无 error.code)'
  const status = detail ? String(detail.status) : '(未知)'
  console.error('❌ 环境不可用：拿不到 git 文件清单 —— 这是**环境限制，不是仓库违规**。')
  console.error('   git ' + which + ' 的派生进程没能跑起来：exit=' + status + '，error.code=' + code + '。')
  console.error('   本仓口径：这条属**沙箱属性、不是本仓属性**（AGENTS.md §8）—— 在受限宿主里')
  console.error('   node 派生子进程（spawnSync）会被拦（实测 EBUSY）；git 本身没问题，是这个进程起不来。')
  console.error('   因此本轮**没有**检查任何文件（拿不到清单 ≠ 检查通过）。')
  console.error('   ⇒ 退出码 2 = 环境不可用（0 = 通过，1 = 真有违规）。')
  console.error('   处置（至少选一条）：')
  console.error('     ① 换一个能 spawn 子进程的环境跑（CI / 干净 checkout 上 `npm run check:hygiene` 是权威口径）。')
  console.error('     ② 本地确需提交：pre-commit 钩子下用 `SKIP_HYGIENE=1 git commit …` **显式**跳过（会被打印出来）。')
  console.error('     ③ 排查拦 spawn 的宿主/沙箱设置（例如允许子进程派生）后重跑。')
  console.error('   ⚠️ 别用 `--no-verify`：那会连**所有**钩子一起跳过，且不留痕。')
}

/** 扫一批文件（路径为仓库相对路径）。@returns 违规列表 */
export function scan(files, { readFromIndex = false } = {}) {
  const issues = []
  // ★ 形态判据走 blob（见 blobHeads 注释）；取不到就**出声**（不许静默把"没看"当成"看了没问题"）
  const heads = blobHeads()
  if (!heads) console.error('⚠️ 拿不到 blob 头（git ls-files -s 失败）⇒ 本轮 BOM 判据**没在做事**')
  for (const rel of files) {
    const norm = rel.replace(/\\/g, '/')
    for (const p of PATH_RULES) if (p.re.test(norm)) issues.push({ file: norm, kind: 'path/' + p.id, why: p.why })
    let buf
    try {
      if (readFromIndex) {
        const r = spawnSync('git', ['show', ':' + norm], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
        if (r.status !== 0) continue
        buf = r.stdout
      } else {
        buf = fs.readFileSync(path.join(REPO, norm))
      }
    } catch { continue }
    if (heads && heads.has(norm) && hasUtf8Bom(heads.get(norm))) {
      issues.push({
        file: norm,
        kind: 'form/utf8-bom',
        why: 'UTF-8 BOM（EF BB BF）——形态维度：会破坏「逐字批准」的形态核对，也让按源码文本做的判据在第 1 行有不可见偏差',
      })
    }
    if (buf.length > MAX_SCAN || looksBinary(buf)) continue
    const text = buf.toString('utf8')
    for (const c of CONTENT_RULES) {
      const m = text.match(c.re)
      if (m) issues.push({ file: norm, kind: 'content/' + c.id, why: c.why, hit: String(m[0]).slice(0, 12) + '…' })
    }
  }
  // ★★ **非空跑下限**：BOM 判据必须证明"它真的在若干个 blob 头上工作过"。
  //   否则一句「没报 BOM」可能只是「根本没在看」——本仓把这类叫"空跑恒真"，与"免费绿灯"同族。
  //   放在 `scan()` 里（而不是 CLI 的成功分支）⇒ **任何**调用路径上都生效；小夹具上会**响亮报红**。
  const checked = heads ? heads.size : 0
  if (checked < MIN_BLOB_HEADS) {
    issues.push({
      file: '(非空跑下限)',
      kind: 'form/bom-coverage',
      why: 'BOM 判据只检查了 ' + checked + ' 个 blob 头（要求 ≥ ' + MIN_BLOB_HEADS + '）⇒ 本轮的「没报 BOM」可能只是「没在看」'
        + '（过小的仓库/夹具？）',
    })
  }
  return issues
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    for (const r of CONTENT_RULES) console.log('内容 ' + r.id + '：' + r.why)
    for (const r of PATH_RULES) console.log('路径 ' + r.id + '：' + r.why)
    process.exit(0)
  }
  const staged = argv.includes('--staged')
  const stubbed = stubList()
  let files = stubbed
  let which = ''
  if (stubbed === null) {
    const got = staged ? stagedFiles() : trackedFiles()
    which = staged ? 'diff --cached' : 'ls-files'
    if (!got.ok) {
      // ★ 环境不可用 ⇒ 专用退出码 2 + 响亮报因（**绝不**打印"不是 git 仓库"，绝不静默当成通过）
      reportEnvUnavailable(which, got)
      process.exit(2)
    }
    files = got.files
  } else {
    console.error('⚠️ HYGIENE_STUB_LIST 已设置 ⇒ 本轮清单由环境变量注入（仅测试用，绕过 git 取清单）。')
  }
  if (!files.length) { console.log('（' + (staged ? '暂存区' : '已跟踪文件') + '为空，跳过）'); process.exit(0) }
  const issues = scan(files, { readFromIndex: staged })
  if (issues.length) {
    console.error('❌ 仓库卫生检查不通过（' + issues.length + ' 处）—— ' + (staged ? '这次提交被拦下了' : '仓库里不该有这些东西') + '：')
    for (const i of issues) console.error('   ' + i.file + '  [' + i.kind + '] ' + i.why + (i.hit ? '  ' + i.hit : ''))
    // 按**命中类别**给对应的处置建议（早期版本一律印"凭据请吊销"，对 BOM 这类形态违规是误导）
    const kinds = new Set(issues.map((i) => String(i.kind).split('/')[0]))
    if (kinds.has('content')) console.error('\n   凭据请立刻吊销/轮换（GitHub PAT、npm token 等）。')
    if (kinds.has('path')) console.error('\n   会话记录/用户数据请移出仓库并 gitignore。')
    if (kinds.has('form')) console.error('\n   形态类（BOM 等）：核对"落地形态 = 被批准的形态"；'
      + '去掉开头 3 字节后**必须 git add** 才生效（判据以 blob 为准，报的是"提交进去的东西"）。')
    process.exit(1)
  }
  console.log('✅ 仓库卫生检查通过：' + files.length + ' 个' + (staged ? '暂存' : '已跟踪') + '文件，无凭据/会话记录/本机路径/BOM'
    + '（BOM 判据以 blob 为准，本轮检查 ' + (blobHeads() ? blobHeads().size : 0) + ' 个 blob 头）')
}

void REPO
