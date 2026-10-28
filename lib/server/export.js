/**
 * 导出：角色卡 / 世界书 / 预设（用户 2026-10-28 需求）。
 *
 * 设计要点（先读再改）：
 *   ① **目录由用户选**：`pickExportFolder()` 弹系统原生的「选择文件夹」对话框
 *      （Windows = PowerShell + FolderBrowserDialog，macOS = osascript，Linux = zenity）。
 *      ★ 必须是**异步** `execFile`：同步版会把 DSH 的 Node 事件循环整个卡住 ——
 *      用户在对话框里浏览文件夹的每一秒，整个应用都无响应。
 *   ② **不猜路径编码**：对话框选出的路径先由 PowerShell 以 **UTF-8 写进临时文件** 再读回。
 *      直接用 stdout 会按控制台代码页（中文 Windows 是 GBK）输出 ⇒ 中文路径变乱码。
 *   ③ **双格式落盘**：原生格式（本插件面板可直接再导入）+ ST 兼容格式（换插件/换机器/给卡站）。
 *   ④ 导出**只读**预设目录，不写、不删任何原文件；目标目录里只新建 `酒馆导出-<时间戳>/`。
 *
 * 本模块不 import `lib/index.js`（§5 分层：只允许依赖更底层模块）——
 * 预设内容由调用方读好，以 `items` 传进来；三个转换器是**纯函数**，可直接单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'

/** 文件名里不许出现的字符（Windows 全平台都按最严的来）。 */
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/** 可导出的三类内容（也是面板上的三个复选框）。 */
export const EXPORT_TARGETS = ['characters', 'worldbooks', 'preset']

/**
 * 把任意名字变成安全的文件名/目录名：去掉非法字符、折叠空白、限长；
 * 空结果回落到 fallback。**不**做拼音化（中文目录名在 Windows/macOS 上都合法）。
 * @param {string} name
 * @param {string} [fallback]
 * @param {number} [maxLen]
 * @returns {string}
 */
export function safeFileName(name, fallback = '未命名', maxLen = 60) {
  let s = String(name == null ? '' : name).replace(INVALID_NAME, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+|[.\s]+$/g, '')
  if (s.length > maxLen) s = s.slice(0, maxLen).trim()
  return s || fallback
}

/** 规整调用方传的 targets：未知项丢弃；空/全非法 ⇒ 默认三类全导。 */
export function normalizeTargets(targets) {
  const list = Array.isArray(targets) ? targets.map((t) => String(t)) : []
  const picked = EXPORT_TARGETS.filter((t) => list.includes(t))
  return picked.length ? picked : EXPORT_TARGETS.slice()
}

/**
 * 单张角色卡 → SillyTavern `chara_card_v2` 结构（ST / 卡站 / 本插件都能再导入）。
 * @param {object} card characters.json 里的一条
 * @returns {object}
 */
export function stCharacterCard(card) {
  const c = card && typeof card === 'object' ? card : {}
  const alternates = Array.isArray(c.alternates) ? c.alternates.filter((g) => typeof g === 'string' && g.trim()) : []
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: String(c.name || '未命名角色'),
      description: String(c.desc || c.description || ''),
      personality: '',
      scenario: '',
      first_mes: String(c.first || c.first_mes || ''),
      mes_example: '',
      creator_notes: '由 dsh-tavern 导出',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: alternates,
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
  }
}

/**
 * 一个世界书分组 → SillyTavern world info 结构（`entries` 为**对象**，键是下标）。
 * 本插件自己的导入器也认这个形状（`data.entries` 取 `Object.values`），所以这一份两端都能吃。
 * @param {{name?: string, entries?: object[]}} group
 * @returns {object}
 */
export function stWorldbook(group) {
  const g = group && typeof group === 'object' ? group : {}
  const list = Array.isArray(g.entries) ? g.entries : []
  const entries = {}
  list.forEach((e, i) => {
    if (!e) return
    const keys = Array.isArray(e.keywords) ? e.keywords : (Array.isArray(e.keys) ? e.keys : [])
    entries[String(i)] = {
      uid: i,
      key: keys.map((k) => String(k)),
      keysecondary: [],
      comment: String(e.name || e.comment || ('条目 ' + (i + 1))),
      content: String(e.content || e.text || ''),
      constant: e.constant === true,
      selective: true,
      order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100,
      position: Number.isFinite(Number(e.position)) ? Number(e.position) : 0,
      disable: e.enabled === false || e.disable === true,
      displayIndex: i,
    }
  })
  return { name: String(g.name || '世界书'), entries }
}

/**
 * 预设模块 → SillyTavern chat-completion 预设（只带 `prompts`，**不带** `prompt_order`）。
 *
 * 为什么刻意不带 `prompt_order`：本插件面板的「预设模块 → 导入」有两条路 ——
 * 同时有 `prompts` + `prompt_order` 会被当成 ST 预设**新建一个 agent 预设**；
 * 只有 `prompts` 则按**模块**导入到当前预设。导出想表达的是后者（可预期的备份/迁移）。
 * @param {string} name
 * @param {object[]} modules
 * @returns {object}
 */
export function stPromptPreset(name, modules) {
  const list = Array.isArray(modules) ? modules : []
  return {
    name: String(name || '酒馆预设'),
    temperature: 1,
    prompts: list.map((m, i) => ({
      identifier: 'module_' + (i + 1),
      name: String((m && (m.name || m.comment)) || ('模块 ' + (i + 1))),
      content: String((m && (m.content || m.text)) || ''),
      enabled: !(m && m.enabled === false),
      injection_position: 0,
      injection_depth: 4,
    })),
  }
}

/** 时间戳：2026-10-28_2359（排序友好、文件名安全）。 */
export function stampOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate())
    + '_' + p(date.getHours()) + p(date.getMinutes())
}

/** 默认起始目录：`<我的文档>/酒馆导出`，文档目录不存在就落到用户主目录。 */
export function defaultExportDir() {
  const home = os.homedir()
  const docs = path.join(home, 'Documents')
  const base = fs.existsSync(docs) ? docs : home
  return path.join(base, '酒馆导出')
}

/** Windows 路径 → PowerShell 单引号字面量（内部单引号翻倍）。 */
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * 弹系统「选择文件夹」对话框。**异步**，不阻塞事件循环。
 * @param {string} [startDir] 对话框的起始目录
 * @returns {Promise<{ok:true,path:string}|{ok:false,canceled?:true,error?:string}>}
 */
export function pickExportFolder(startDir = '') {
  const start = String(startDir || '').trim() || defaultExportDir()
  const outFile = path.join(os.tmpdir(), 'dsh-tavern-pick-' + process.pid + '-' + Date.now() + '.txt')
  try { fs.rmSync(outFile, { force: true }) } catch {}

  const finish = (result) => {
    try { fs.rmSync(outFile, { force: true }) } catch {}
    return result
  }
  const readOut = () => {
    try {
      const v = fs.readFileSync(outFile, 'utf8').trim()
      return v
    } catch { return '' }
  }

  return new Promise((resolve) => {
    const done = (err, stdout) => {
      const picked = readOut() || String(stdout || '').trim()
      if (err) {
        // 用户点「取消」时各平台都会以非零码退出；区别在于有没有拿到路径
        if (!picked) return resolve(finish({ ok: false, canceled: true }))
        return resolve(finish({ ok: true, path: picked }))
      }
      if (!picked) return resolve(finish({ ok: false, canceled: true }))
      resolve(finish({ ok: true, path: picked }))
    }

    const opts = { windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 }
    if (process.platform === 'win32') {
      // ★ 结果写文件（UTF-8）再读回：stdout 会按控制台代码页输出，中文路径必乱码。
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.ShowInTaskbar = $false',
        '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dlg.Description = "选择导出文件夹"',
        '$dlg.ShowNewFolderButton = $true',
        '$dlg.SelectedPath = ' + psLiteral(start),
        '$r = $dlg.ShowDialog($owner)',
        'if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [System.IO.File]::WriteAllText(' + psLiteral(outFile) + ', $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
        '}',
      ].join('\n')
      execFile('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], opts, done)
      return
    }
    if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "选择导出文件夹" default location POSIX file '
        + JSON.stringify(start) + ')'
      execFile('osascript', ['-e', script], opts, done)
      return
    }
    execFile('zenity', ['--file-selection', '--directory', '--title=选择导出文件夹', '--filename=' + start + '/'], opts, done)
  })
}

/** 写一个 JSON 文件（2 空格缩进 + 末尾换行，便于 diff / 手工看）。 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 写一个文本文件。 */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, String(text == null ? '' : text), 'utf8')
}

/** 复制一个文件（存在才复制）；返回是否复制成功。 */
function copyIfExists(src, dest) {
  try {
    if (!fs.existsSync(src)) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    return true
  } catch { return false }
}

/**
 * 把若干预设导出到一个目录树。
 *
 * 目标结构（`rootName` 可覆盖，默认 `酒馆导出-<时间戳>`）：
 * ```
 * <parentDir>/酒馆导出-2026-10-28_2359/
 *   ├─ 说明.txt
 *   ├─ manifest.json
 *   └─ <预设名>/
 *        ├─ 角色卡/characters.json          ← 原生（面板导入用）
 *        ├─ 角色卡/<卡名>.json              ← ST chara_card_v2（单张）
 *        ├─ 世界书/worldbooks.json          ← 原生（面板导入用）
 *        ├─ 世界书/<世界书名>.json          ← {name, entries[]}（插件可导入）
 *        ├─ 世界书/<世界书名>.st.json       ← ST world info
 *        └─ 预设/preset.yml · agent.cordis.yml · presets.json · st-preset.json
 * ```
 * @param {{parentDir:string, items:Array<{name:string,presetId?:string,characters?:object[],
 *          worldbooks?:object[], modules?:object[], dir?:string}>, targets?:string[],
 *          rootName?:string, now?:Date}} opts
 * @returns {{ok:true, dir:string, files:string[], perPreset:Array<{name:string,dir:string,counts:object}>}}
 */
export function exportPresets(opts) {
  const o = opts || {}
  const parentDir = String(o.parentDir || '').trim()
  if (!parentDir) throw new Error('缺少目标文件夹')
  if (!fs.existsSync(parentDir)) throw new Error('目标文件夹不存在：' + parentDir)
  const targets = normalizeTargets(o.targets)
  const stamp = stampOf(o.now || new Date())
  const root = path.join(parentDir, o.rootName ? safeFileName(o.rootName, '酒馆导出') : ('酒馆导出-' + stamp))
  fs.mkdirSync(root, { recursive: true })

  const files = []
  const perPreset = []
  const used = new Set()

  for (const item of Array.isArray(o.items) ? o.items : []) {
    if (!item) continue
    const name = String(item.name || item.presetId || '未命名预设')
    let dirName = safeFileName(name, '未命名预设')
    if (used.has(dirName.toLowerCase())) dirName = safeFileName(dirName + '-2', '未命名预设')
    used.add(dirName.toLowerCase())
    const presetDir = path.join(root, dirName)
    fs.mkdirSync(presetDir, { recursive: true })

    const counts = { characters: 0, worldbooks: 0, modules: 0, files: 0 }
    // 统一用 `/` 输出相对路径：Windows 的 path.relative 会给 `\`，API 返回值不该随平台变
    const rel = (file) => path.relative(root, file).split(path.sep).join('/')
    const push = (file) => { files.push(rel(file)); counts.files++ }

    if (targets.includes('characters')) {
      const cards = Array.isArray(item.characters) ? item.characters.filter(Boolean) : []
      if (cards.length) {
        const native = path.join(presetDir, '角色卡', 'characters.json')
        writeJson(native, cards)
        push(native)
        counts.characters = cards.length
        const seen = new Set()
        for (const card of cards) {
          let base = safeFileName(card.name, '角色卡')
          if (seen.has(base.toLowerCase())) base += '-2'
          seen.add(base.toLowerCase())
          const f = path.join(presetDir, '角色卡', base + '.json')
          writeJson(f, stCharacterCard(card))
          push(f)
        }
      }
    }

    if (targets.includes('worldbooks')) {
      const groups = Array.isArray(item.worldbooks) ? item.worldbooks.filter(Boolean) : []
      if (groups.length) {
        const native = path.join(presetDir, '世界书', 'worldbooks.json')
        writeJson(native, groups)
        push(native)
        counts.worldbooks = groups.reduce((n, g) => n + (Array.isArray(g.entries) ? g.entries.length : 0), 0)
        for (const g of groups) {
          const base = safeFileName(g.name, '世界书')
          const plain = path.join(presetDir, '世界书', base + '.json')
          writeJson(plain, { name: String(g.name || '世界书'), entries: Array.isArray(g.entries) ? g.entries : [] })
          push(plain)
          const st = path.join(presetDir, '世界书', base + '.st.json')
          writeJson(st, stWorldbook(g))
          push(st)
        }
      }
    }

    if (targets.includes('preset')) {
      const modules = Array.isArray(item.modules) ? item.modules.filter(Boolean) : []
      counts.modules = modules.length
      if (item.dir) {
        if (copyIfExists(path.join(item.dir, 'preset.yml'), path.join(presetDir, '预设', 'preset.yml'))) push(path.join(presetDir, '预设', 'preset.yml'))
        if (copyIfExists(path.join(item.dir, 'agent.cordis.yml'), path.join(presetDir, '预设', 'agent.cordis.yml'))) push(path.join(presetDir, '预设', 'agent.cordis.yml'))
      }
      if (modules.length) {
        const native = path.join(presetDir, '预设', 'presets.json')
        writeJson(native, modules)
        push(native)
        const st = path.join(presetDir, '预设', 'st-preset.json')
        writeJson(st, stPromptPreset(name, modules))
        push(st)
      }
    }

    perPreset.push({ name, dir: path.relative(root, presetDir), counts })
  }

  const manifest = {
    app: 'dsh-tavern',
    exportedAt: new Date().toISOString(),
    targets,
    presets: perPreset,
  }
  writeJson(path.join(root, 'manifest.json'), manifest)
  files.push('manifest.json')
  writeText(path.join(root, '说明.txt'), [
    '酒馆导出包（dsh-tavern）',
    '',
    '导出内容：' + targets.join(' / '),
    '导出于：' + new Date().toISOString(),
    '',
    '【怎么用】',
    '1) 换机器 / 备份：把「<预设名>/预设」里的 preset.yml、agent.cordis.yml、presets.json',
    '   复制到 <DSH_HOME>/.agent-presets/<预设目录>/ 下即可恢复预设本体。',
    '2) 在酒馆面板里重新导入：',
    '   · 角色卡 → 内容 → 角色卡 → 拖入「角色卡/<卡名>.json」（ST 卡格式，备选开场白会一起带回来）',
    '   · 世界书 → 内容 → 世界书 → 拖入「世界书/<世界书名>.json」或 .st.json（两份都能导入）',
    '   · 写作要求 → 内容 → 预设模块 → 拖入「预设/st-preset.json」',
    '3) 给 SillyTavern / 卡站用：角色卡用「角色卡/<卡名>.json」，世界书用「世界书/<世界书名>.st.json」。',
    '',
    '说明：「预设/agent.cordis.yml」是本插件注入用的完整 agent 预设，跨插件不通用。',
    '',
  ].join('\n'))
  files.push('说明.txt')

  return { ok: true, dir: root, files, perPreset }
}
