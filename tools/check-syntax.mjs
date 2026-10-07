#!/usr/bin/env node
/**
 * 全仓语法检查（`npm run check`）。
 *
 * 为什么要重写：原来的 `scripts.check` 是一串**手抄**的 `node --check <file> && …`。
 * 2026-10-08 实测它只引用了 14 个文件，`tests/` 下 13 个测试文件根本没被检查到 ——
 * 这跟 `scripts.test` 漏掉 3 个文件（含 `render-escape.test.js` 这个安全回归）
 * 是**同一类漂移**：手抄清单必然落后于目录。现在改成扫目录，清单由文件系统决定。
 *
 * 为什么不用 `node --check`：本仓的自动化环境里有**禁止 spawn 子进程**的情况
 * （受限沙箱下 `spawnSync` 直接 EBUSY），spawn 型工具会给出「全 0」的假结果，
 * 而假结果长得像绿灯。这里用 `vm.SourceTextModule` 在**当前进程内**解析，
 * 不 spawn，因此结论不依赖子进程能力。
 *
 * 用法：
 *   node --experimental-vm-modules tools/check-syntax.mjs          # 全量
 *   node --experimental-vm-modules tools/check-syntax.mjs --list   # 只列扫描目标
 *
 * 注意：`--experimental-vm-modules` 是必须的（已写进 `npm run check`）。
 * 少了它 `vm.SourceTextModule` 为 undefined —— 本工具会**判失败**而不是静默通过。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描范围：这些目录下的 .js / .mjs / .cjs 全部按 ESM 解析 */
export const SCAN_DIRS = ['lib', 'tests', 'tools']

/**
 * 必须被扫到（证明扫描范围没写错）。
 * 防的是「扫了个空目录 ⇒ 0 个文件 ⇒ 全绿」这种空跑。
 */
export const MUST_EXIST = ['lib/index.js', 'lib/client.manager.bundle.js']

/** 收集扫描目标（仓库相对路径，正斜杠） */
export function findTargets(repo = REPO) {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(path.relative(repo, p).split(path.sep).join('/'))
    }
  }
  for (const d of SCAN_DIRS) {
    const abs = path.join(repo, d)
    if (!fs.existsSync(abs)) throw new Error('扫描目录不存在：' + d)
    walk(abs)
  }
  return out.sort()
}

/**
 * 在当前进程内解析源码。返回 null（语法 OK）或 Error。
 * 只做**解析**，不解析 import 目标、不执行任何代码。
 */
export function syntaxErrorOfSource(src, identifier = '<anonymous>') {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('vm.SourceTextModule 不可用：请加 --experimental-vm-modules（或直接用 `npm run check`）')
  }
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(String(src), { identifier })
    return null
  } catch (e) {
    return e
  }
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsScript) {
  const onlyList = process.argv.includes('--list')

  if (typeof vm.SourceTextModule !== 'function') {
    console.error('❌ 本进程没有 vm.SourceTextModule —— 没带 --experimental-vm-modules。')
    console.error('   用 `npm run check`（脚本里已带），或手动：')
    console.error('   node --experimental-vm-modules tools/check-syntax.mjs')
    process.exit(1)
  }

  const targets = findTargets()

  if (onlyList) {
    for (const t of targets) console.log(t)
    console.log('共 ' + targets.length + ' 个')
    process.exit(0)
  }

  const missing = MUST_EXIST.filter((f) => !targets.includes(f))
  if (missing.length) {
    console.error('❌ 扫描范围没覆盖到这些必备文件，判据本身有问题：')
    for (const m of missing) console.error('     ' + m)
    process.exit(1)
  }
  if (!targets.length) {
    console.error('❌ 一个文件都没扫到 —— 判据空跑，不是通过')
    process.exit(1)
  }

  const bad = []
  for (const rel of targets) {
    const err = syntaxErrorOfSource(fs.readFileSync(path.join(REPO, rel), 'utf8'), rel)
    if (err) bad.push({ rel, err })
  }

  for (const { rel, err } of bad) {
    console.log('❌ ' + rel)
    console.log('     ' + String(err.message).split('\n')[0].slice(0, 200))
  }

  if (bad.length) {
    console.error('\n语法错误 ' + bad.length + ' / ' + targets.length + ' 个文件')
    process.exit(1)
  }
  console.log('✅ 语法全通过：' + targets.length + ' 个文件（lib/ + tests/ + tools/，按 ESM 解析）')
}
