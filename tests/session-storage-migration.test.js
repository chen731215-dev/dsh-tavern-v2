/**
 * 会话存储迁移的**非破坏性**回归测试（2026-09-20）
 *
 * 原始缺陷（`lib/index.js` 的 `migrateSessionStorageOutOfPresetRoot()`）：
 *   `if (fs.existsSync(to)) { fs.rmSync(from, { recursive: true, force: true }); out.dropped++ }`
 *   目标目录**只要存在**就删源目录 —— 而 `readSessionMemory()` 当年**连读都 mkdir**，
 *   于是任何一次组装提示词都会先给每条会话造出空目录 `tavern-data/sessions/<sid>/`，
 *   下次启动迁移就把 `.agent-presets/sessions/<sid>/` 里**有内容的**记忆当空壳删掉。
 *   ⇒ 用户数据不可逆丢失（表现为「只剩预设级副本」）。
 *
 * 本文件单独存在，不动 tests/core.test.js（那边 77 条正在用）。
 * 运行：node --test tests/session-storage-migration.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const INDEX = path.join(import.meta.dirname, '..', 'lib', 'index.js')
const REPO = path.join(import.meta.dirname, '..')
const SRC = fs.readFileSync(INDEX, 'utf8')
const LINES = SRC.split(/\r?\n/)

// ── 从 lib/index.js 原样切片（不重写等价实现） ──
function sliceFn(name) {
  const start = LINES.findIndex((l) => l.startsWith('function ' + name + '('))
  assert.ok(start >= 0, '找不到函数: ' + name)
  if (LINES[start].trim().endsWith('}')) return LINES[start]
  for (let i = start + 1; i < LINES.length; i++) {
    if (LINES[i] === '}') return LINES.slice(start, i + 1).join('\n')
  }
  throw new Error('函数未闭合: ' + name)
}

const MIGRATE_SRC = sliceFn('migrateSessionStorageOutOfPresetRoot')
const READ_MEM_SRC = sliceFn('readSessionMemory')
const READ_REL_SRC = sliceFn('readSessionRelations')

// ── 源码级不变量：迁移函数里不许再对**源目录**做 rmSync（只允许 rmdir 空目录）──
test('源码护栏：migrateSessionStorageOutOfPresetRoot 里不许对源目录 rmSync', () => {
  const codeLines = MIGRATE_SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  const offenders = codeLines.filter((l) => /rmSync\s*\(\s*from\b/.test(l))
  assert.deepEqual(offenders, [], '迁移里出现了对源目录的 rmSync —— 源有内容时就是数据丢失')
  assert.ok(/rmdirSync\(from\)/.test(MIGRATE_SRC), '仍应允许清理空目录')
  assert.ok(/archive/.test(MIGRATE_SRC), '必须保留归档通道')
})

test('源码护栏：readSessionMemory / readSessionRelations 里不许有 mkdir', () => {
  assert.ok(READ_MEM_SRC.indexOf('mkdirSync') < 0, '读记忆仍然会 mkdir（这就是那个触发器）')
  assert.ok(READ_REL_SRC.indexOf('mkdirSync') < 0, '读关系网仍然会 mkdir')
})

/** 历史（修前）版本的迁移函数：优先从 git HEAD 取原文，取不到就用逐字抄录的兜底副本 */
const LEGACY_MIGRATE_FALLBACK = [
  'function migrateSessionStorageOutOfPresetRoot(oldRootArg, newRootArg) {',
  "  const oldRoot = oldRootArg || path.join(ROOT, 'sessions')",
  '  const newRoot = newRootArg || path.join(TAVERN_DATA_ROOT, "sessions")',
  '  const out = { moved: 0, dropped: 0, removed: false }',
  '  let children',
  '  try {',
  '    if (!fs.existsSync(oldRoot)) return out',
  '    children = fs.readdirSync(oldRoot, { withFileTypes: true })',
  '  } catch { return out }',
  '  for (const child of children) {',
  '    const from = path.join(oldRoot, child.name)',
  '    try {',
  '      if (!child.isDirectory()) { fs.rmSync(from, { force: true }); continue }',
  '      const files = fs.readdirSync(from)',
  '      if (files.length === 0) { fs.rmdirSync(from); out.dropped++; continue }',
  '      const to = path.join(newRoot, child.name)',
  '      if (fs.existsSync(to)) { fs.rmSync(from, { recursive: true, force: true }); out.dropped++; continue }',
  '      fs.mkdirSync(newRoot, { recursive: true })',
  '      try {',
  '        fs.renameSync(from, to)',
  '      } catch {',
  '        fs.mkdirSync(to, { recursive: true })',
  '        for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(to, f))',
  '        fs.rmSync(from, { recursive: true, force: true })',
  '      }',
  '      out.moved++',
  '    } catch {}',
  '  }',
  '  try {',
  '    if (fs.readdirSync(oldRoot).length === 0) { fs.rmdirSync(oldRoot); out.removed = true }',
  '  } catch {}',
  '  return out',
  '}',
].join('\n')

function legacyMigrateSrc() {
  // HEAD 里若还留着破坏性那一行，就用真原文（最可信）
  try {
    const head = execFileSync('git', ['-C', REPO, 'show', 'HEAD:lib/index.js'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    const hl = head.split(/\r?\n/)
    const start = hl.findIndex((l) => l.startsWith('function migrateSessionStorageOutOfPresetRoot('))
    if (start >= 0) {
      for (let i = start + 1; i < hl.length; i++) {
        if (hl[i] === '}') {
          const fn = hl.slice(start, i + 1).join('\n')
          if (fn.includes('fs.rmSync(from, { recursive: true, force: true })')) return fn
          break
        }
      }
    }
  } catch {}
  return LEGACY_MIGRATE_FALLBACK
}
const LEGACY_MIGRATE = legacyMigrateSrc()

/** 历史（修前）版本的读函数 = 现在这份 + 当年那句「读也 mkdir」 */
const LEGACY_MKDIR_LINE = '    fs.mkdirSync(path.dirname(f), { recursive: true })'
function legacyReadSrc(fnSrc) {
  const anchor = '    const f = '
  const i = fnSrc.indexOf(anchor)
  assert.ok(i >= 0, '锚点失效')
  const lineEnd = fnSrc.indexOf('\n', i)
  return fnSrc.slice(0, lineEnd + 1) + LEGACY_MKDIR_LINE + '\n' + fnSrc.slice(lineEnd + 1)
}

const PATHS_SRC = [
  "  let ROOT = 'PLACEHOLDER_ROOT'",
  "  let TAVERN_DATA_ROOT = 'PLACEHOLDER_TD'",
].join('\n')

/**
 * 把真实函数拼成一个模块。opt.legacyMigrate / opt.legacyRead 用于对照臂。
 */
async function loadMod({ presetsRoot, tavernRoot, legacyMigrate = false, legacyRead = false, tag = 'new' }) {
  const code = [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    PATHS_SRC.replace('PLACEHOLDER_ROOT', presetsRoot.replace(/\\/g, '/')).replace('PLACEHOLDER_TD', tavernRoot.replace(/\\/g, '/')),
    sliceFn('sessionDir'),
    sliceFn('sessionMemoryFile'),
    sliceFn('sessionRelationsFile'),
    legacyRead ? legacyReadSrc(READ_MEM_SRC) : READ_MEM_SRC,
    sliceFn('appendSessionMemory'),
    legacyRead ? legacyReadSrc(READ_REL_SRC) : READ_REL_SRC,
    legacyMigrate ? LEGACY_MIGRATE : MIGRATE_SRC,
    'export { migrateSessionStorageOutOfPresetRoot, readSessionMemory, readSessionRelations, sessionDir, sessionMemoryFile }',
    '',
  ].join('\n')
  const p = path.join(presetsRoot, '_mod-' + tag + '.mjs')
  fs.mkdirSync(presetsRoot, { recursive: true })
  fs.writeFileSync(p, code, 'utf8')
  return import(pathToFileURL(p).href)
}

function tmpRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mig2-'))
  return {
    base,
    oldRoot: path.join(base, 'presets', 'sessions'),
    newRoot: path.join(base, 'tavern-data', 'sessions'),
    presetsRoot: path.join(base, 'presets'),
    tavernRoot: path.join(base, 'tavern-data'),
  }
}
const ARCHIVE_OF = (newRoot) => path.join(path.dirname(newRoot), '_migrated-archive')

// ══════════════════════════════════════════════════════════════════
// ★ 1. 核心回归：目标目录「已存在但为空」+ 源目录有内容 ⇒ 内容绝不能消失
//    这正是当年「读也 mkdir」造出空目标、迁移把有内容的源删掉的那条链
// ══════════════════════════════════════════════════════════════════
test('迁移：目标已存在但为空 + 源有内容 ⇒ 源内容不丢，并合并回可用位置', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's-aaa'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 's-aaa', 'memory.md'), '这是用户丢了就找不回来的记忆', 'utf8')
  // 模拟旧代码「读也 mkdir」留下的空壳目标目录
  fs.mkdirSync(path.join(newRoot, 's-aaa'), { recursive: true })

  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)

  assert.equal(
    fs.readFileSync(path.join(newRoot, 's-aaa', 'memory.md'), 'utf8'),
    '这是用户丢了就找不回来的记忆',
    '源内容必须合并进目标（否则就是不可逆丢失）',
  )
  assert.equal(r.moved, 1)
  assert.equal(r.merged, 1)
  assert.equal(r.archived || 0, 0)
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

test('对照臂（迁移）：旧代码在同一夹具下把源内容删掉 —— 这条必须能红', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's-aaa'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 's-aaa', 'memory.md'), '这是用户丢了就找不回来的记忆', 'utf8')
  fs.mkdirSync(path.join(newRoot, 's-aaa'), { recursive: true })

  assert.ok(
    LEGACY_MIGRATE.includes('fs.rmSync(from, { recursive: true, force: true })'),
    '对照臂失效：拿到的「旧代码」里没有破坏性那一行',
  )
  const mod = await loadMod({ presetsRoot, tavernRoot, legacyMigrate: true, tag: 'old' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)

  assert.equal(r.dropped, 1)
  assert.equal(fs.existsSync(path.join(oldRoot, 's-aaa')), false, '旧代码确实删掉了源目录')
  assert.equal(fs.existsSync(path.join(newRoot, 's-aaa', 'memory.md')), false, '旧代码下内容彻底消失')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════════
// ★ 2. 目标已有内容 ⇒ 目标不被覆盖，源内容**归档**保留（不是删除）
// ══════════════════════════════════════════════════════════════════
test('迁移：目标已有内容 ⇒ 源内容归档保留，目标不被覆盖', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's-bbb'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 's-bbb', 'relations.json'), '旧副本', 'utf8')
  fs.mkdirSync(path.join(newRoot, 's-bbb'), { recursive: true })
  fs.writeFileSync(path.join(newRoot, 's-bbb', 'relations.json'), '新副本', 'utf8')

  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new2' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)

  assert.equal(fs.readFileSync(path.join(newRoot, 's-bbb', 'relations.json'), 'utf8'), '新副本', '目标不许被覆盖')
  assert.equal(r.dropped, 1, '没搬进新位置（既有断言依赖这个键）')
  assert.equal(r.moved, 0)
  assert.equal(r.archived, 1, '源必须被归档，不是被删')
  assert.ok(r.lastArchive, '必须回报归档路径')
  assert.equal(fs.readFileSync(path.join(r.lastArchive, 'relations.json'), 'utf8'), '旧副本', '归档里必须是原文')
  assert.equal(fs.existsSync(path.join(oldRoot, 's-bbb')), false, '归档成功后源目录清掉')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════════
// ★ 3. 空壳源目录 ⇒ 允许清理，且不报错；无操作时返回形状不变
// ══════════════════════════════════════════════════════════════════
test('迁移：空壳源目录允许清理，且旧根目录被删掉（不留空目录占预设 id）', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's-empty'), { recursive: true })
  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new3' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.dropped, 1)
  assert.equal(r.moved, 0)
  assert.equal(r.removed, true)
  assert.equal(fs.existsSync(oldRoot), false)
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

test('迁移：无操作时返回形状严格是 {moved,dropped,removed}', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new4' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.deepEqual(r, { moved: 0, dropped: 0, removed: false })
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

test('迁移：源根下的散落文件改为归档，不再直接 rmSync', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(oldRoot, { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 'stray.txt'), '不该被静默删掉', 'utf8')
  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new5' })
  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.archived, 1)
  assert.ok(r.lastArchive, '必须回报归档路径')
  // 散落文件是被「改名进归档区」，所以 lastArchive 指向文件本身
  assert.equal(fs.readFileSync(r.lastArchive, 'utf8'), '不该被静默删掉')
  assert.equal(fs.existsSync(path.join(oldRoot, 'stray.txt')), false, '源位置已腾空（内容是搬走不是删掉）')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════════
// ★ 4. 「读」不得有副作用：读一次会话记忆/关系网 ⇒ 不产生任何新目录
// ══════════════════════════════════════════════════════════════════
test('纯读：readSessionMemory / readSessionRelations 不产生任何新目录', async () => {
  const { newRoot, presetsRoot, tavernRoot } = tmpRoots()
  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new6' })
  assert.equal(fs.existsSync(tavernRoot), false, '前置：临时 tavern-data 还不存在')

  assert.equal(mod.readSessionMemory('session-never-written'), '')
  assert.deepEqual(mod.readSessionRelations('session-never-written'), { nodes: [], edges: [] })

  assert.equal(fs.existsSync(path.join(newRoot, 'session-never-written')), false, '读操作不许造出会话目录')
  assert.equal(fs.existsSync(tavernRoot), false, '读操作不许造出 tavern-data 根')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

test('对照臂（读）：旧实现「读也 mkdir」，同一调用会造出空目录 —— 这条必须能红', async () => {
  const { newRoot, presetsRoot, tavernRoot } = tmpRoots()
  assert.ok(READ_MEM_SRC.indexOf('mkdirSync') < 0, '现行 readSessionMemory 里不该还有 mkdir')
  const legacy = legacyReadSrc(READ_MEM_SRC)
  assert.ok(legacy.includes(LEGACY_MKDIR_LINE), '对照臂失效：还原出的旧读函数里没有那句 mkdir')

  const mod = await loadMod({ presetsRoot, tavernRoot, legacyRead: true, tag: 'oldread' })
  assert.equal(mod.readSessionMemory('session-never-written'), '')
  assert.equal(fs.existsSync(path.join(newRoot, 'session-never-written')), true, '旧实现确实留下了空壳目录')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════════
// ★ 5. 两条链的联合回归：旧「读 mkdir」造空壳 → 迁移删源
//     新实现下：读不造空壳；即便空壳已在，迁移也不删源
// ══════════════════════════════════════════════════════════════════
test('联合回归：先读（造不出空壳）→ 再迁移 ⇒ 源内容依然完好', async () => {
  const { oldRoot, newRoot, presetsRoot, tavernRoot } = tmpRoots()
  fs.mkdirSync(path.join(oldRoot, 's-ccc'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 's-ccc', 'memory.md'), '联合回归用记忆', 'utf8')

  const mod = await loadMod({ presetsRoot, tavernRoot, tag: 'new7' })
  mod.readSessionMemory('s-ccc')                       // 旧实现会在这里造出空目标目录
  assert.equal(fs.existsSync(path.join(newRoot, 's-ccc')), false, '读没有造空壳')

  const r = mod.migrateSessionStorageOutOfPresetRoot(oldRoot, newRoot)
  assert.equal(r.moved, 1)
  assert.equal(fs.readFileSync(path.join(newRoot, 's-ccc', 'memory.md'), 'utf8'), '联合回归用记忆')
  fs.rmSync(path.dirname(presetsRoot), { recursive: true, force: true })
})
