// dsh-tavern host half (v2 — multi-preset + session binding):
// - 每个预设独立保存 agent.cordis.yml / preset.yml / memory.md / relations.json
// - 每个会话可绑定不同预设，注入时按当前 sessionId 自动选择
// - 完全兼容旧版 API（旧接口操作"当前活动预设"）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { randomUUID, createHash } from 'node:crypto'
import { assembleCardBody } from './server/assemble.js'
import { registerRoutes } from './server/routes.js'
import { zstdDecompressSync, zstdCompressSync } from './server/zstd.js'
import { CARD_MAX, DEFAULT_WINDOW_TOKENS, PRESET_DECL_BEGIN, PRESET_DECL_END, USER_ALIASES } from './server/constants.js'
import { parseFlowYaml, resolveDshKey } from './server/dsh-conn.js'
import { composePresetDeclarationBlock, indentYamlBlock, mergeManagedPresetBlock, outsideManagedBlock, stripDeclarationStamp, stripManagedPresetBlock, validatePresetPatchText, yamlDoubleQuote } from './server/preset-decl.js'
import { decideInjectionScope, estimatePromptBudget } from './server/prompt.js'
import { findSessionLog, readSessionLines, sessionDirMatches, sessionIdKeys } from './server/session-log.js'
import { buildSummaryPrompt, callLLM, detectRefusal, parseSummaryOutput } from './server/summary.js'
import { cleanName, extractCardText } from './server/text.js'
import { clipText, contentToText, expandHomePrefix, genId, json, normalizeYmlForCompare, randomPick, randomRoll, readBody, slugSkillName, yamlScalar } from './server/util.js'
import { entryKeys, entrySecondaryKeys, latestAffection, legacyInjectMode, matchWorldbookEntries, normalizeWorldbookData, parseStagePlans, resolveWbIsFull, selectWorldbookEntries, worldbookToApi } from './server/worldbook.js'
import { bindingModeOf, classifyPresetBindingSource, contentHash16, findLiveAgent, getCtxService, hasTurnStarted, nativeAgentPresetOf, nativeTurnStarted, normalizeBinding, sessionIdOf, trackLiveSession } from './server/bindings.js'
import { BINDING_SOURCE_LEGACY, BINDING_SOURCE_PANEL, BINDING_SOURCE_TOP_SELECT, BLANK_PRESET_SKELETON, SKILL_NAME_RE, liveAgents } from './server/constants.js'
import { isBlankPresetComposition } from './server/presets.js'
import { contentTextOnly } from './server/session-log.js'
import { parseSkillFrontmatter, skillNameForPreset } from './server/skills.js'
import { S, syncPaths } from './server/state.js'
import { listDshConnections, readDshDefaultAgentPresetId, resolveMemApi } from './server/dsh-conn.js'
import { migratePersonaCompleteFlag, migratePersonaTextField } from './server/session-migrate.js'
import { readLastAssistantText, readSessionEventsDirect } from './server/session-read.js'
import { ensureRoot, writeState } from './server/state-io.js'
// （已删除）通用预设增强层（preset-forge）的 import：该功能已连根移除（见 lib/utils.js 尾部说明）

export const name = 'tavern'
// `sessions` 用于按 sessionId 找到活会话（手动注入开场白 POST /api/tavern/greeting/insert）。
export const inject = ['webServer', 'systemPrompt', 'sessions']

// ── DSH home 解析 ─────────────────────────────────────────
// DSH 本体用 @deepseek-ai/dsh-home-paths 的 resolveDshHome() 定位用户数据根：
//   优先级 = 显式配置 → $DSH_HOME（非空）→ ~/.dsh
// 用户预设目录 = <dshHome>/.agent-presets
//   （见 dsh-agent-presets/src/index.ts：dshHomePath(USER_PRESET_DIR)）
// 早期版本把这里写死成 ~/.dsh，一旦 DSH_HOME 指向非默认位置，
// 酒馆就会把预设写到 DSH 根本不会扫描的目录 —— 面板里配好的预设
// 在 DSH 侧不存在，预设无法生效、无法注入。
function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return path.resolve(expandHomePrefix(env.trim()))
  return path.join(os.homedir(), '.dsh')
}

// ── 路径常量（apply() 一开始会按 DSH 实际 home 重新绑定）──────
let DSH_HOME = resolveDshHome()
let ROOT = path.join(DSH_HOME, '.agent-presets')
let PRESETS_META = path.join(ROOT, 'presets.json')
let SESSION_BINDINGS = path.join(ROOT, 'session-bindings.json')
let STATE_PATH = path.join(ROOT, 'tavern-state.json')
let SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
// 插件的会话级存储（每会话独立的记忆/关系网）**必须放在预设根目录之外**。
// DSH 的 preset discovery 会把 .agent-presets 下每个「名字合法的目录」都当成一行预设，
// 缺 agent.cordis.yml 就标 broken（ui-agent-preset 的「加载失败」徽标）。
// 插件原先把 sessions/ 直接建在 ROOT 里，于是 DSH 的预设管理器永久多出一行报错的 sessions。
let TAVERN_DATA_ROOT = path.join(DSH_HOME, 'tavern-data')
let DSH_SETTINGS_FILE = path.join(DSH_HOME, 'settings.yaml')
let DSH_CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml')

const DEFAULT_PRESET_ID = 'default'
const DEFAULT_PRESET_DIR = 'tavern-lite'           // 兼容旧版目录名

// ── 路径镜像（S2-B2b）──────────────────────────────────────
// 上面这 9 个 `let` 是本仓库里路径的**唯一真源**（memory-isolation 测试按行首切片它们，
// 所以不能搬走，见 AGENTS.md §5.1）。下面把同一份值单向镜像给 lib/server/* 用。
// ★ 全仓只有两处 syncPaths() 调用：这里 + bindDshPaths() 里。
//   改这两个 `let` 的写法/写入点之前，先看 AGENTS.md §5.3 和 tests/server-state-paths.test.js。
syncPaths({ DSH_HOME, ROOT, PRESETS_META, SESSION_BINDINGS, STATE_PATH, SESSIONS_ROOT, TAVERN_DATA_ROOT, DSH_SETTINGS_FILE, DSH_CREDENTIALS_FILE })

/**
 * 默认预设（「酒馆默认」）的最小可用组合文件。
 *
 * 只 `mkdirSync` 建目录是不够的：DSH 的 preset discovery 把 .agent-presets 下每个
 * 名字合法的目录都当成一行预设，缺 `agent.cordis.yml` 就标 broken —— 预设管理器里
 * 就多一行红字「加载失败」。所以目录一建出来就必须带一份能挂载的组合。
 *
 * persona 行的正文字段必须是 `prefix:`，不是 `text:`（后者会让挂载直接失败，
 * 报 `$.prefix missing required value`，见 migratePersonaTextField）。
 */
const DEFAULT_PRESET_YML = [
  '# 酒馆管理面板生成：默认预设（空配置）',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: |-',
  '      # 写作要求',
  '      你是角色扮演助手。请严格扮演当前角色，保持人设，自然地推动剧情。',
  '      所有思考、推理、内心独白必须使用中文。',
  '    includeRuntimeContext: false',
  '',
].join('\n')

/** 默认预设的展示元数据。DSH 用同目录的 preset.yml 决定卡片上显示的名字。 */
const DEFAULT_PRESET_META = [
  'name: 酒馆默认',
  'description: 无角色卡、无世界书的空白预设。',
  '',
].join('\n')

const BUILTIN_AGENT_PRESETS = new Set(['_preset', 'anchored-standard', 'minimal-gitbash', 'minimal-win', 'router-standard', 'v4-flash-godmode-opencode-go', 'warmupbetter', 'warmupbetter-replay', 'whoami-standard', 'zero-anchored-standard'])

// ── 清理 SillyTavern 不兼容变量 ──────────────────────────
// 移除所有 {{xxx::yyy}} 格式的双冒号变量（DSH 不支持），以及其他 SillyTavern 特有变量
function cleanSillyTavernVars(text) {
  if (!text || typeof text !== 'string') return text
  // ★ 先做 ST 宏求值（setvar/getvar 装配线、random/pick/roll、char/user/trim），
  //   再走清洗兜底 —— 否则装配线会被双冒号正则整体剥空。
  //   本函数多用于保存 persona/记忆/编辑消息等无角色名上下文的场景，
  //   {{char}} 求值为中性词「角色」；user 回退保持旧语义（S.playerName 为空则空）。
  let s = expandStMacros(text, '', '')
  // 移除双冒号格式变量 {{xxx::yyy}}（求值后残留的 setvar/getvar 等）
  s = s.replace(/\{\{[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_]*\}\}/gi, '')
  // 移除已知的 SillyTavern 特有变量
  s = s.replace(/\{\{world_scenario\}\}/gi, '')
  s = s.replace(/\{\{description\}\}/gi, '')
  s = s.replace(/\{\{scenario\}\}/gi, '')
  s = s.replace(/\{\{first_mes\}\}/gi, '')
  s = s.replace(/\{\{mes_example\}\}/gi, '')
  s = s.replace(/\{\{personality\}\}/gi, '')
  // ★ 用玩家名替换 {{user}}/{{name}}；{{char}} 是角色名不是玩家名（求值器已展开，
  //   此处兜底用中性词，绝不能错换成玩家名 —— 「你是{{char}}」会变成「你是玩家名」）
  const pn = S.playerName || ''
  s = s.replace(/\{\{name\}\}/gi, pn)
  s = s.replace(/\{\{char\}\}/gi, '角色')
  s = s.replace(/\{\{user\}\}/gi, pn)
  // 移除可能的空标签 <status_current_variables></status_current_variables>
  s = s.replace(/<status_current_variables>\s*<\/status_current_variables>/gi, '')
  // ★ 通用兜底：清除剩余所有 {{...}}（双冒号/中文/点开头/多行等任何 DSH 不支持的格式），
  //   只保留 DSH 已注册的 provider/model/cwd。
  s = s.replace(/\{\{([^{}]*)\}\}/g, (all, inner) => {
    const name = String(inner).trim()
    if (name === 'provider' || name === 'model' || name === 'cwd') return all
    return ''
  })
  // ★ DSH 兼容：剥离"要求 AI 输出可见 thinking / HTML 注释"的指令
  //   （Claude 等模型有原生隐藏思考通道；deepseek 会把 <thinking>/<!-- --> 当正文输出）
  s = s.replace(/<thinking_rules>[\s\S]*?<\/thinking_rules>/g, '')
  s = s.replace(/<output_lock>[\s\S]*?<\/output_lock>/g, '')
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
  s = s.replace(/<comment>[\s\S]*?<\/comment>/g, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<\/?thinking_rules>/gi, '')
  s = s.replace(/<\/?output_lock>/gi, '')
  s = s.replace(/<\/?thinking>/gi, '')
  s = s.replace(/<\/?Think>/gi, '')
  // Prism：剥离"每段前输出 HTML 注释"指令与"总结<Prism>内要求"引用
  s = s.replace(/<Prism_tips>[\s\S]*?<\/Prism_tips>/gi, '')
  s = s.replace(/<Prism>[\s\S]*?<\/Prism>/gi, '')
  s = s.replace(/总结\s*<Prism>\s*内的所有要求[！!]?（?一个要求都不能少）?/gi, '总结所有写作要求，一个都不能少')
  s = s.replace(/明确\s*<Prism>\s*的输出格式，并在正文中体现\(如若无要求则无需在意\)/gi, '明确上述要求的输出格式，并在正文中体现')
  s = s.replace(/\$\{?总结<Prism>内的所有要求！一个要求都不能少\}?/gi, '总结所有写作要求，一个都不能少')
  s = s.replace(/<Prism>/gi, '')
  s = s.replace(/<\/Prism>/gi, '')
  s = s.replace(/Prism/gi, '写作要求')
  // ★ 剥离"要求 AI 先打草稿/输出规划再写正文"的指令（deepseek 会把草稿/思考当正文输出）
  s = s.replace(/Draft once[^.\n]{0,60}/gi, '')
  s = s.replace(/All draft work inside <content> as HTML comments\.?\s*/gi, '')
  s = s.replace(/At the START of every reply[^.\n]{0,80}/gi, '')
  s = s.replace(/打草稿[:：][^。\n]{0,60}/gi, '')
  s = s.replace(/以html注释的形式插入在输出内容中[^。\n]{0,40}/gi, '')
  s = s.replace(/先.?打草稿[^。\n]{0,40}/gi, '')
  // ★ 剥离"思考链缝合"指令（世界书/预设里要求 AI 逐步输出思考的内容：
  //   依次执行下述行动 / 禁止进行下一轮思考 / 每个步骤思考总字数 / 贝叶斯推演 / 内容输出规划）
  s = s.replace(/不要偷懒，你需要依次执行下述行动[^。\n]{0,40}/gi, '')
  s = s.replace(/【❗需要缝合进预设思维链的内容】/gi, '')
  s = s.replace(/每个步骤思考总字数小于\d+字禁止进行下一轮思考[^。\n]{0,40}/gi, '')
  s = s.replace(/禁止进行下一轮思考[^。\n]{0,30}/gi, '')
  s = s.replace(/贝叶斯推演与元素构建[^。\n]{0,40}/gi, '')
  s = s.replace(/内容输出规划[:：][^。\n]{0,40}/gi, '')
  s = s.replace(/5\. 内容输出规划[^\n]*/gi, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

// 递归清理对象中的所有字符串字段
function cleanObjectStrings(obj) {
  if (!obj) return obj
  if (typeof obj === 'string') return cleanSillyTavernVars(obj)
  if (Array.isArray(obj)) return obj.map(cleanObjectStrings)
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      obj[key] = cleanObjectStrings(obj[key])
    }
  }
  return obj
}
// ── 出厂内置清单（探测 DSH 安装目录 assets/agent-presets；找不到再回退硬编码）──
function builtinAgentPresetDirs() {
  if (S.builtinDirsCache) return S.builtinDirsCache
  const found = []
  const tried = []
  const chip = path.join('.dsh', 'profiles', 'web', 'node_modules', '@local')
  // 候选路径：模块邻近资源目录、Program Files、用户 AppData Local Programs
  const candidates = [
    path.join(process.execPath || '', '..', '..', '..', 'resources', 'app', 'assets', 'agent-presets'),
    path.join(DSH_HOME, 'profiles', 'web', 'resources', 'app', 'assets', 'agent-presets'),
    path.join('C:', 'Program Files', 'Deepseek Harness EAC', 'resources', 'app', 'assets', 'agent-presets'),
    path.join('C:', 'Program Files (x86)', 'Deepseek Harness EAC', 'resources', 'app', 'assets', 'agent-presets'),
    path.join('C:', 'Users', os.userInfo().username, 'AppData', 'Local', 'Programs', 'Deepseek Harness EAC v2.0', 'resources', 'app', 'assets', 'agent-presets'),
  ]
  for (const c of candidates) {
    if (!c || !c.startsWith(path.sep) && !/^[A-Za-z]:/.test(c)) continue
    tried.push(c)
    try {
      if (!fs.existsSync(c)) continue
      const names = fs.readdirSync(c, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(c, d.name, 'preset.yml')))
        .map(d => d.name)
      if (names.length) { found.push(...names); }
    } catch {}
  }
  // 去重；若探测到任何出厂预设目录就以探测结果为准，否则硬编码兜底
  const uniq = [...new Set(found)]
  S.builtinDirsCache = new Set(uniq.length ? uniq : BUILTIN_AGENT_PRESETS)
  if (!found.length) {
    try { console.error('[tavern] 未探测到 DSH 出厂 agent-presets 目录，使用硬编码内置清单：', tried.filter(Boolean).join(' | ')) } catch {}
  }
  return S.builtinDirsCache
}

// ── 工具函数 ──────────────────────────────────────────────

// ── 预设元数据管理 ────────────────────────────────────────
function readPresetsMeta() {
  try {
    const raw = fs.readFileSync(PRESETS_META, 'utf8')
    const data = JSON.parse(raw)
    if (!Array.isArray(data.presets)) data.presets = []
    // 兼容旧数据：补全 mode 字段
    data.presets = data.presets.map(p => ({ mode: 'roleplay', ...p }))
    return data
  } catch {
    return { presets: [] }
  }
}

function writePresetsMeta(data) {
  ensureRoot()
  fs.writeFileSync(PRESETS_META, JSON.stringify(data, null, 2), 'utf8')
}

function getPresetDir(presetId) {
  if (!presetId) return null
  const meta = readPresetsMeta()
  const p = meta.presets.find(x => x.id === presetId)
  if (p && p.dir) return path.join(ROOT, p.dir)
  // 默认预设用旧目录名
  if (presetId === DEFAULT_PRESET_ID) return path.join(ROOT, DEFAULT_PRESET_DIR)
  // ★ 支持 DSH 自带的 agent 预设：直接用预设 ID 作为目录名 ★
  const agentDir = path.join(ROOT, presetId)
  if (fs.existsSync(agentDir)) return agentDir
  return null
}

/**
 * 酒馆预设 id → **DSH 原生 agent 预设 id**（= `.agent-presets` 下的目录名）。纯函数。
 *
 * 两套 id 不是一回事，调用 `agentPresets.select()` 时必须换成 DSH 那套：
 *   · 酒馆注册表（presets.json）里的 `default` 指向目录 `tavern-lite`；
 *   · 酒馆自建预设 id 就是目录名（`preset-xxxx`），一一对应；
 *   · DSH 侧直接列出的 agent 目录（深渊区/编辑区等）id 即目录名，原样返回。
 *
 * @param {string} presetId 酒馆侧预设 id
 * @returns {string} DSH agent 预设 id（目录名）；空 id 返回空串
 */
function agentPresetIdFor(presetId) {
  const id = String(presetId || '')
  if (!id) return ''
  // 'default' 是酒馆注册表里的别名，DSH 侧的真实 id 是目录名 tavern-lite
  if (id === DEFAULT_PRESET_ID) return DEFAULT_PRESET_DIR
  try {
    const meta = readPresetsMeta()
    const p = meta.presets.find(x => x.id === id)
    if (p && p.dir) return String(p.dir)
  } catch {}
  return id
}

function ensureDefaultPreset() {
  const meta = readPresetsMeta()
  if (!meta.presets.some(p => p.id === DEFAULT_PRESET_ID)) {
    meta.presets.unshift({
      id: DEFAULT_PRESET_ID,
      name: '酒馆默认',
      dir: DEFAULT_PRESET_DIR,
      mode: 'roleplay',
      description: '酒馆默认预设（空配置）',
      createdAt: Date.now()
    })
    writePresetsMeta(meta)
  }
  // 确保默认预设目录**连同其组合文件**存在。
  // 只建空目录的话，DSH 的预设管理器会把它列成一行「加载失败」（缺 agent.cordis.yml）。
  const dir = path.join(ROOT, DEFAULT_PRESET_DIR)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const comp = path.join(dir, 'agent.cordis.yml')
    if (!fs.existsSync(comp)) fs.writeFileSync(comp, DEFAULT_PRESET_YML, 'utf8')
    const metaFile = path.join(dir, 'preset.yml')
    if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, DEFAULT_PRESET_META, 'utf8')
  } catch {}
  return meta
}

function listPresets() {
  // ★ 单一事实来源：列表前先重建描述/移除孤儿条目，选择栏永远显示磁盘真实数据
  rebuildAllPresetDescriptions()
  ensureDefaultPreset()
  const meta = readPresetsMeta()
  const registeredIds = new Set(meta.presets.map(p => p.id))
  const registeredDirs = new Set(meta.presets.map(p => p.dir).filter(Boolean))
  const out = meta.presets.map(p => {
    const dir = path.join(ROOT, p.dir || DEFAULT_PRESET_DIR)
    const ymlPath = path.join(dir, 'agent.cordis.yml')
    let cardChars = 0
    try {
      if (fs.existsSync(ymlPath)) cardChars = extractCardText(fs.readFileSync(ymlPath, 'utf8')).length
    } catch {}
    return { ...p, dir, cardChars }
  })
  // 同步合并：目录中 origin=tavern 的 agent 预设（深渊区/编辑区/酒馆角色扮演等）
  // 也出现在酒馆管理的预设列表里，与浮动面板保持一致。id 用目录名（与 session-bindings 键一致）。
  // 注册表已占用同名 id 或同 dir 的跳过（如 default 与 tavern-lite 同目录只保留注册表项）。
  try {
    const agentPresets = listAgentPresets()
    for (const ap of agentPresets) {
      if (!ap.isTavern) continue              // 只合并酒馆预设
      const id = ap.id || ap.dir
      if (registeredIds.has(id) || registeredDirs.has(ap.dir)) continue  // 注册表已有则跳过
      out.push({
        id,
        name: ap.name || id,
        dir: ap.dir || id,
        mode: 'roleplay',
        description: '酒馆预设（agent 目录）',
        createdAt: Date.now(),
        isAgent: true,
        cardChars: ap.cardChars || 0
      })
    }
  } catch {}
  return out
}

function createPreset(name, copyFromId) {
  ensureDefaultPreset()
  const meta = readPresetsMeta()
  // 自动处理重名：如果已存在同名预设，加 (1)(2) 后缀
  let finalName = name || '新预设'
  let counter = 1
  const existingNames = new Set(meta.presets.map(p => p.name))
  while (existingNames.has(finalName)) {
    finalName = (name || '新预设') + '(' + counter + ')'
    counter++
  }
  const id = genId()
  const dirName = id
  const newDir = path.join(ROOT, dirName)
  fs.mkdirSync(newDir, { recursive: true })

  // 如果指定了复制源，复制文件
  if (copyFromId) {
    const srcDir = getPresetDir(copyFromId)
    if (srcDir && fs.existsSync(srcDir)) {
      for (const f of ['agent.cordis.yml', 'preset.yml', 'memory.md', 'relations.json', 'worldbook.json', 'characters.json', 'worldbooks.json']) {
        const src = path.join(srcDir, f)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(newDir, f))
        }
      }
    }
  } else {
    // 空白预设：生成最小骨架（preset.yml + 空 agent.cordis.yml），
    // 保证预设出现在酒馆面板列表里，但角色卡/世界书/预设词条全部为空。
    // ★ 这份骨架**不会被声明成 DSH agent 预设**（见 isBlankPresetComposition）：
    //   它是「还没保存过」的标记，声明出去只会给 DSH 名册加一行空壳。
    try {
      const safeName = String(finalName || '新预设').replace(/"/g, '\\"')
      fs.writeFileSync(path.join(newDir, 'preset.yml'), 'name: "' + safeName + '"\ndescription: "酒馆空白预设（由酒馆管理面板生成）"\n', 'utf8')
      fs.writeFileSync(path.join(newDir, 'agent.cordis.yml'), BLANK_PRESET_SKELETON, 'utf8')
    } catch {}
  }

  meta.presets.push({ id, name: finalName, dir: dirName, mode: 'roleplay', description: '由酒馆管理面板生成', createdAt: Date.now() })
  writePresetsMeta(meta)
  writePresetNameFile(id, finalName)
  // 新建预设后同步声明（未启用声明时是 no-op）。
  // ★ 新预设此时仍是空骨架 ⇒ 它会被 renderPresetDeclaration 判为 not-saved-yet 跳过，
  //   名册里不会出现空壳行；等用户点「保存预设」（真的写进组合）后再同步，才会登记。
  syncDeclarationsBestEffort('create')
    return { id, name: finalName, dir: newDir }
}

function deletePreset(presetId) {
  const meta = readPresetsMeta()
  const idx = meta.presets.findIndex(p => p.id === presetId)
  if (idx < 0) throw new Error('预设不存在')
  const p = meta.presets[idx]
  // 删除目录
  const dir = path.join(ROOT, p.dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  meta.presets.splice(idx, 1)
  // 如果删光了，自动重建默认预设
  if (meta.presets.length === 0) {
    ensureDefaultPreset()
    meta = readPresetsMeta()
  }
  writePresetsMeta(meta)
  // 清理会话绑定中指向该预设的条目
  // ★ P0-1：不能只是 delete —— 删掉后解析会往下退到 creation / 兜底，等于「换绑到别的卡」。
  //   显式解绑（{mode:'none'}）才是 fail closed：本会话就此不再注入。
  const bindings = readBindings()
  for (const sid of Object.keys(bindings)) {
    const b = bindings[sid]
    if (b && b.mode === 'preset' && b.presetId === presetId) bindings[sid] = { mode: 'none' }
  }
  writeBindings(bindings)
  // ★ 删除预设后**必须**同步声明：受管块是从注册表整块重渲染的，这一步会把该预设的
  //   声明行一起去掉。漏掉它，DSH 名册里就会留一张指向已删目录的坏卡。
  syncDeclarationsBestEffort('delete')
  return true
}

// ══════════════════════════════════════════════════════════════════════
// 把酒馆预设**声明**成 DSH 原生 agent 预设（纯函数：渲染 + 受管块拼接）
//
// ★ 为什么需要这一步（2026-09-27 查证，DSH 本体的说法）：
//   `@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:71`
//     「Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/`
//       holding `preset.yml` … and `agent.cordis.yml` … **Nothing reads that directory any more.**」
//   全 asar 的 @deepseek-ai 代码里 `.agent-presets` 只有这一处（文档），即本版 DSH **不再读**
//   那些目录；真正的预设是**声明行**：
//     `- insert: [{ id: 'preset-<id>', name: '@deepseek-ai/dsh-agent-preset',
//                   config: { id, name, description, order, plugins: [...] } }]`
//   （出厂四个标准预设就是 `dsh-web-app/presets/*.patch.yml` 这么写的。）
//   ⇒ 不声明，酒馆预设就**不在顶部选择器里**，也就无所谓「会话选择了这个酒馆 agent 预设」。
//
// ⚠️ 本段只做「渲染」与「受管块拼接」，**不碰任何配置文件**：写盘走显式接口（dry-run 优先），
//    目标文件是 profile 的 `cordis.patch.yml`（DSH 自己写的注释：那是「你的 patch 层」），
//    一旦写坏会导致 DSH 起不来 —— 所以必须由用户点头、且先看 dry-run。
// ══════════════════════════════════════════════════════════════════════

/**
 * 合并后超过这个体积就提示用户：声明会把每个预设的**整个组合**（含角色卡正文）
 * 内联进 DSH 配置文件，而 DSH 每次启动都要解析它。256 KB 是个保守的经验阈值
 * （出厂四个预设的 patch 加起来才几十 KB 量级）。
 */
const LARGE_PATCH_WARN_BYTES = 256 * 1024

/**
 * 渲染一个酒馆预设的 DSH 声明行。纯只读：读 `preset.yml` + `agent.cordis.yml`。
 *
 * ★ 声明的 `config.id` 用**目录名**（`agentPresetIdFor`），不用酒馆侧别名：
 *   · DSH 的预设 id 规则是「小写字母/数字/连字符」（见 editing-cordis-compositions 技能文档），
 *     而且它同时是 `agent-presets.default` 里指的那个值 —— 若把酒馆别名 `default`
 *     直接声明成 id，就和「DSH 默认预设」这个语义同名词碰撞；
 *   · 目录名是所有既有映射的落点（`agentPresetIdFor` 就是把酒馆 id 换成目录名），
 *     声明成目录名 ⇒ 顶部选择器显示的、绑定时传的、注入判据认的，全都是同一个 id。
 *
 * @param {string} presetId 酒馆预设 id
 * @param {{order?:number}} [opts] order 缺省用 100（排在出厂预设之后）
 * @returns {{ok:true, id:string, agentId:string, rowId:string, yaml:string}|{ok:false, error:string}}
 */
function renderPresetDeclaration(presetId, opts) {
  const id = String(presetId || '')
  if (!id) return { ok: false, error: 'bad-args：缺少预设 id' }
  const dir = getPresetDir(id)
  if (!dir) return { ok: false, error: 'preset-not-found：预设目录不存在（' + id + '）' }
  const agentId = agentPresetIdFor(id)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
    // DSH 对预设 id 有格式要求；不合规的 id 会让这一行激活失败（甚至起不来），
    // 所以在这里就挡住，绝不生成一行注定失败的声明。
    return { ok: false, error: 'invalid-id：预设 id 不符合 DSH 规则（只允许小写字母/数字/连字符）：' + agentId }
  }
  let agentYml = ''
  let metaYml = ''
  try { agentYml = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8') } catch {}
  try { metaYml = fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8') } catch {}
  if (!agentYml.trim()) return { ok: false, error: 'empty-composition：agent.cordis.yml 为空（' + id + '）' }
  if (isBlankPresetComposition(agentYml)) {
    // ★ 新建但**从未保存**的预设：组合文件还是 createPreset 写下的骨架。
    //   声明出去 = 给 DSH 名册加一行空壳（persona prefix 为空、没有任何工具），
    //   用户看到预设存在却不起作用，比"不出现"更误导。所以这里跳过，
    //   由失败列表如实告诉用户「先保存一次」。
    return { ok: false, error: 'not-saved-yet：预设还没保存过（组合仍是新建骨架，没有注入内容也没有工具）—— 先在面板点一次「💾 保存预设」再同步名册' }
  }
  // name / description / order 从 preset.yml 取（DSH 旧目录格式的字段名，原样沿用）
  // ★ 兜底不再用「酒馆预设 id」：preset.yml 的 name 行可能被 dataOnly 保存覆盖过
  //   （历史 bug：写成了目录名，如「tavern-lite」），注册表里的名字才是用户认得的那个。
  let name = presetDisplayNameFor(id)
  let description = ''
  let order = Number.isFinite(opts && opts.order) ? Number(opts.order) : 100
  try {
    const mName = metaYml.match(/^[ \t]*name[ \t]*:[ \t]*(.+)$/m)
    if (mName) {
      const fromYml = mName[1].trim().replace(/^["']|["']$/g, '')
      // ★ 只有当 preset.yml 里的名字**不是目录名 / 预设 id 本身**时才采信它。
      //   历史上 dataOnly 自动保存会把 name 写成目录名（「酒馆默认」被覆盖成「tavern-lite」），
      //   那种"名字"是 bug 留下的痕迹 —— 遇到它就用注册表里的真名，别把目录名当预设名展示。
      if (fromYml && fromYml !== agentId && fromYml !== id) name = fromYml
    }
    const mDesc = metaYml.match(/^[ \t]*description[ \t]*:[ \t]*(.+)$/m)
    if (mDesc) description = mDesc[1].trim().replace(/^["']|["']$/g, '')
    const mOrder = metaYml.match(/^[ \t]*order[ \t]*:[ \t]*(\d+)[ \t]*$/m)
    if (mOrder && !(opts && Number.isFinite(opts.order))) order = Number(mOrder[1])
  } catch {}
  const rowId = 'preset-' + agentId
  const lines = [
    '- insert:',
    '    - id: ' + rowId,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + agentId,
    '        name: ' + yamlDoubleQuote(name),
    ...(description ? ['        description: ' + yamlDoubleQuote(description)] : []),
    '        order: ' + String(order),
    '        plugins:',
    indentYamlBlock(agentYml, 10),
  ]
  return { ok: true, id, agentId, rowId, yaml: lines.join('\n') }
}

/**
 * 把声明块写进 profile 补丁层 —— **破坏性操作**（目标文件写坏 = DSH 起不来）。
 *
 * 三层保护：
 *   1. **默认 dry-run**：不传 `{ dryRun: false, confirm: true }` 就只算不写；
 *   2. 写前自检（`validatePresetPatchText`）+ 备份到 `<DSH_HOME>/tavern-data/backups/`；
 *   3. 原子写（临时文件 + rename）+ 回读自检 + **块外内容必须逐字节不变**，不过就自动回滚。
 *
 * @param {{dryRun?:boolean, confirm?:boolean, remove?:boolean, profileDir?:string,
 *          timestamp?:string, order?:number}} [opts]
 * @returns {object} 计划/结果（含 ok、wrote、target、bytesBefore/After、backupPath、problems）
 */
function applyPresetDeclarations(opts) {
  const o = opts || {}
  const dryRun = o.dryRun !== false                 // ★ 默认 dry-run
  const profileDir = o.profileDir || findProfileDir()
  if (!profileDir) return { ok: false, error: 'profile-not-found：没找到 profile 目录' }
  const target = path.join(profileDir, 'cordis.patch.yml')
  let existing = null
  try { existing = fs.readFileSync(target, 'utf8') } catch { existing = null }
  const original = existing == null ? '' : existing

  let plan
  if (o.remove) {
    plan = { text: stripManagedPresetBlock(original), replaced: false, okCount: 0, failed: [] }
  } else {
    const decls = renderAllPresetDeclarations(o.order === undefined ? undefined : { order: o.order })
    const block = composePresetDeclarationBlock(decls, { timestamp: o.timestamp })
    if (!block.ok) {
      // 一个都渲染不出来就别写（避免留下一个空块，把 DSH 的预设列表搞乱）
      return { ok: false, error: 'no-declarations：没有任何可声明的预设', failed: block.failed, target }
    }
    const merged = mergeManagedPresetBlock(original, block.text)
    plan = { text: merged.text, replaced: merged.replaced, okCount: block.ok, failed: block.failed }
  }

  const problems = validatePresetPatchText(plan.text, { expectBlock: !o.remove })
  // ★ 内容没变就别写：受管块里有一行「生成时间」，每次都不同 —— 拿它当内容就等于
  //   每次都判定为"变了"。保存预设几乎每次都会调本函数（还有自动保存），
  //   真按"变了"写盘，backups/ 会被刷成几百个 .bak、mtime 也一直在跳。
  const unchanged = stripDeclarationStamp(plan.text) === stripDeclarationStamp(original)
  const base = {
    ok: problems.length === 0,
    dryRun,
    wrote: false,
    unchanged,
    target,
    created: existing == null,
    profileDir,
    replaced: plan.replaced,
    okCount: plan.okCount,
    failed: plan.failed,
    bytesBefore: original.length,
    bytesAfter: plan.text.length,
    // ★ 诚实提示体积代价：声明会把每个预设的**整个组合**（含角色卡正文）内联进 DSH 配置，
    //   而 DSH 每次启动都要解析这个文件。预设很大时（比如卡正文几万字）该文件会显著变大，
    //   用户在按下写入前就该知道这件事 —— 而不是等启动了才发现配置臃肿。
    warning: plan.text.length > LARGE_PATCH_WARN_BYTES
      ? 'large-patch：合并后 ' + plan.text.length + ' 字符（超过 ' + LARGE_PATCH_WARN_BYTES + '）。'
        + '声明会把每个预设的组合内联进 DSH 配置（含角色卡正文），而 DSH 每次启动都要解析它；'
        + '预设很大时建议改用「只生成 bundle」那条路，或先精简卡正文。'
      : '',
    problems,
  }
  if (problems.length > 0) return Object.assign(base, { ok: false, error: 'validation-failed' })
  if (dryRun) return base
  if (o.confirm !== true) return Object.assign(base, { ok: false, error: 'confirm-required：写盘必须显式 confirm:true' })

  // ★ 内容没变就别写：写盘会备份 + 改 mtime，而保存预设几乎每次都调用本函数
  //   （自动保存、每次点保存）。变了才写，才不至于把 backups/ 堆成几百个 .bak。
  if (unchanged) {
    return Object.assign(base, { ok: true, wrote: false, backupPath: '' })
  }

  // ⚠️ 从这里开始真的动文件
  const dataRoot = path.join(DSH_HOME, 'tavern-data', 'backups')
  let backupPath = ''
  try {
    fs.mkdirSync(dataRoot, { recursive: true })
    if (existing != null) {
      backupPath = path.join(dataRoot, 'cordis.patch.yml.' + (o.timestamp || new Date().toISOString()).replace(/[:.]/g, '-') + '.bak')
      fs.copyFileSync(target, backupPath)
    }
  } catch (e) { return Object.assign(base, { ok: false, error: 'backup-failed：' + e.message }) }

  const tmp = target + '.tavern-tmp-' + process.pid + '-' + Date.now()
  try {
    fs.writeFileSync(tmp, plan.text, 'utf8')
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    return Object.assign(base, { ok: false, error: 'write-failed：' + e.message, backupPath })
  }

  // 回读自检：界标/结构 + **块外内容逐字节不变**（这是「没吃用户配置」的硬保证）
  let after = ''
  try { after = fs.readFileSync(target, 'utf8') } catch {}
  const afterProblems = validatePresetPatchText(after, { expectBlock: !o.remove })
  // 末尾换行不算改动（追加受管块时会补一个文件末尾换行，那是我们自己加的分隔，不是动了用户内容）
  const outsideSame = outsideManagedBlock(after).replace(/\n+$/, '') === outsideManagedBlock(original).replace(/\n+$/, '')
  if (afterProblems.length > 0 || !outsideSame) {
    let rolledBack = false
    if (backupPath) { try { fs.copyFileSync(backupPath, target); rolledBack = true } catch {} }
    else { try { fs.rmSync(target, { force: true }); rolledBack = true } catch {} }
    return Object.assign(base, {
      ok: false,
      error: afterProblems.length ? 'verify-failed' : 'outside-changed',
      problems: afterProblems.length ? afterProblems : ['outside-changed：受管块之外的文本被改动了'],
      rolledBack,
      backupPath,
    })
  }
  return Object.assign(base, { ok: true, wrote: true, backupPath, restoredTo: '' })
}

/**
 * 路线 B：生成「DSH bundle」的两份文件内容（纯函数，只生成字符串）。
 *
 * 为什么还要这条路：DSH 官方技能文档明确希望**不要手改 profile 的 `cordis.patch.yml`**，
 * 而是「写一个 workspace bundle（`package.json` + `cordis.patch.yml`），再用
 * `plugin_manager` 的 `install_bundle` 安装」——安装器自己负责 pnpm 与 bundle 选择。
 * 所以两条路都给：路线 A 直接写补丁层（快、离线），路线 B 生成 bundle 交安装器（官方）。
 *
 * 生成的文件在 `<DSH_HOME>/tavern-data/preset-bundle/`（**酒馆自己的数据目录**，
 * 不往 workspace 或 profile 里塞东西；DSH 的预设加载器也不会扫这个位置，安全）。
 *
 * @param {string[]} [ids] 要声明的预设 id；缺省取注册表全部
 * @param {{order?:number}} [opts]
 * @returns {{ok:boolean, packageJson?:string, patchYaml?:string, bundleName?:string,
 *            failed:Array<{id:string,error:string}>, error?:string}}
 */
function renderPresetBundleFiles(ids, opts) {
  const list = Array.isArray(ids) && ids.length ? ids : listTavernPresetIds()
  const decls = list.map((id) => {
    const r = renderPresetDeclaration(id, opts)
    return r.ok ? r : { ok: false, id, error: r.error }
  })
  const good = decls.filter(d => d && d.ok)
  const failed = decls.filter(d => !d || !d.ok).map(d => ({ id: (d && d.id) || '', error: (d && d.error) || 'unknown' }))
  if (!good.length) return { ok: false, error: 'no-declarations：没有任何可声明的预设', failed }
  const pkg = {
    name: '@local/dsh-tavern-presets',
    version: '1.0.0',
    private: true,
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  return {
    ok: true,
    bundleName: pkg.name,
    bundleDir: path.join(TAVERN_DATA_ROOT, 'preset-bundle'),
    packageJson: JSON.stringify(pkg, null, 2) + '\n',
    patchYaml: good.map(d => d.yaml).join('\n') + '\n',
    declaredIds: good.map(d => d.agentId),
    failed,
  }
}

/**
 * 把路线 B 的 bundle 落到磁盘（**只写酒馆自己的数据目录**）。
 * 与写盘器同款保护：默认 dry-run，必须显式 `{dryRun:false, confirm:true}`。
 *
 * @param {{dryRun?:boolean, confirm?:boolean, ids?:string[], order?:number}} [opts]
 */
function writePresetBundle(opts) {
  const o = opts || {}
  const dryRun = o.dryRun !== false
  const files = renderPresetBundleFiles(o.ids, o.order === undefined ? undefined : { order: o.order })
  if (!files.ok) return Object.assign({ dryRun, wrote: false }, files)
  const dir = files.bundleDir
  const out = {
    ok: true,
    dryRun,
    wrote: false,
    bundleDir: dir,
    bundleName: files.bundleName,
    declaredIds: files.declaredIds,
    failed: files.failed,
    files: ['package.json', 'cordis.patch.yml'],
    // 安装这一步**不由酒馆代劳**：它要跑 pnpm、会把包装进 profile，
    // 按 DSH 的规矩应当由 plugin_manager 执行（且可能需要用户批准）。
    installHint: "plugin_manager { action: 'install_bundle', target: '" + dir + "' }",
  }
  if (dryRun) return out
  if (o.confirm !== true) return Object.assign(out, { ok: false, error: 'confirm-required：写盘必须显式 confirm:true' })
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), files.packageJson, 'utf8')
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), files.patchYaml, 'utf8')
  } catch (e) {
    return Object.assign(out, { ok: false, error: 'write-failed：' + e.message })
  }
  return Object.assign(out, { wrote: true })
}

/** 读预设声明开关：'off' | 'patch' | 'bundle'（只认这三个，其余归 off）。 */
function readDeclarationMode() {
  try {
    const s = readState()
    const pd = s && s.presetDeclarations
    return pd && (pd.mode === 'patch' || pd.mode === 'bundle') ? pd.mode : 'off'
  } catch { return 'off' }
}

/** 写预设声明开关。 */
function writeDeclarationMode(mode) {
  const s = readState()
  s.presetDeclarations = {
    mode: mode === 'patch' || mode === 'bundle' ? mode : 'off',
    updatedAt: Date.now(),
  }
  writeState(s)
  return s.presetDeclarations
}

/**
 * 预设**增删改之后**按已启用的模式同步声明 —— 尽力而为，永不抛、永不影响预设操作本身。
 *
 * 为什么必须有这一步：声明是从注册表渲染出来的（受管块每次整块替换）。
 * 用户新建/改名/删除预设之后若不重新生成，DSH 名册就会是旧的 ——
 * 尤其**删除**：名册里会留一行指向已不存在的目录，顶部选择器上就是一张坏卡。
 *
 * @param {string} reason 'create' | 'rename' | 'delete' | 'save' | 'apply' | 'manual'
 * @returns {{ok:boolean, skipped?:string, mode?:string, error?:string}}
 */
function syncDeclarationsBestEffort(reason) {
  const mode = readDeclarationMode()
  if (mode === 'off') return { ok: true, skipped: 'off', mode }
  try {
    const r = mode === 'patch'
      ? applyPresetDeclarations({ dryRun: false, confirm: true })
      : writePresetBundle({ dryRun: false, confirm: true })
    if (!r.ok) {
      try { console.error('[tavern] 预设声明同步失败（' + reason + '）：', r.error || '', JSON.stringify(r.problems || r.failed || [])) } catch {}
    }
    // bundle 模式要**明说**：文件更新了，但 DSH 名册要等重新安装 bundle 才会变
    // （安装要跑 pnpm，按 DSH 的规矩交给 plugin_manager，酒馆不代劳）。
    return Object.assign({ mode }, r, mode === 'bundle' && r.wrote ? { needsInstall: true } : null)
  } catch (e) {
    try { console.error('[tavern] 预设声明同步异常（' + reason + '）：', String(e && e.message || e)) } catch {}
    return { ok: false, mode, error: String((e && e.message) || e) }
  }
}

/** 找当前 profile 目录（有 `cordis.patch.yml`、且 bundles 里列了 dsh-tavern 的那个）。 */function findProfileDir() {
  try {
    const root = path.join(DSH_HOME, 'profiles')
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    let best = ''
    let bestScore = 0
    for (const name of dirs) {
      const dir = path.join(root, name)
      let score = 0
      try { if (fs.existsSync(path.join(dir, 'cordis.patch.yml'))) score += 1 } catch {}
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
        if (Array.isArray(bundles) && bundles.includes('dsh-tavern')) score += 2
      } catch {}
      if (score > bestScore) { bestScore = score; best = dir }
    }
    return best
  } catch { return '' }
}

/** 酒馆注册表里**应当被声明**的预设 id（去重；不动磁盘）。 */
function listTavernPresetIds() {
  try {
    ensureDefaultPreset()
    const meta = readPresetsMeta()
    const ids = meta.presets.map(p => String(p.id || '')).filter(Boolean)
    if (!ids.includes(DEFAULT_PRESET_ID)) ids.unshift(DEFAULT_PRESET_ID)
    return [...new Set(ids)]
  } catch { return [] }
}

/**
 * 渲染**全部**酒馆预设的声明（个别预设目录坏了不影响其它）。
 * @param {{order?:number}} [opts]
 * @returns {Array<{ok:boolean, id:string, rowId?:string, yaml?:string, error?:string}>}
 */
function renderAllPresetDeclarations(opts) {
  return listTavernPresetIds().map((id) => {
    const r = renderPresetDeclaration(id, opts)
    return r.ok ? r : { ok: false, id, error: r.error }
  })
}

function renamePreset(presetId, name) {
  const newName = String(name || '').trim()
  const meta = readPresetsMeta()
  const p = meta.presets.find(x => x.id === presetId)
  if (p) {
    p.name = newName || p.name
    writePresetsMeta(meta)
    writePresetNameFile(presetId, p.name)
    // 改名后同步声明（未启用声明时是 no-op）：DSH 顶部选择器里的名字跟着变
    syncDeclarationsBestEffort('rename')
    return p
  }
  // 非注册表预设：agent 目录预设（深渊区/编辑区等），直接改 preset.yml 的 name
  const dir = path.join(ROOT, String(presetId || '').replace(/[^a-zA-Z0-9_\-]/g, ''))
  const presetYml = path.join(dir, 'preset.yml')
  if (!fs.existsSync(presetYml)) throw new Error('预设不存在：' + presetId)
  if (!newName) throw new Error('预设名称不能为空')
  writePresetNameFile(presetId, newName)
  return { id: presetId, name: newName }
}

// 让酒馆预设目录同时成为 DSH agent 预设：preset.yml 的 name 跟随酒馆预设名
function writePresetNameFile(presetId, name, desc) {
  const dir = getPresetDir(presetId)
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const safeName = JSON.stringify(String(name || '未命名预设').trim())
    const descText = desc || '由 Harness 酒馆管理面板生成。'

    fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${safeName}\ndescription: ${JSON.stringify(descText)}\n`, 'utf8')
  } catch {}
}

/**
 * 预设的**展示名**（注册表优先）—— 声明行、面板兜底都该用它。
 *
 * 为什么不能拿 id 当兜底：`preset.yml` 的 `name:` 行历史上被 dataOnly 保存覆盖成过目录名
 * （`tavern-lite` 取代了「酒馆默认」）。id 是内部标识（`default` / `preset-xxxx`），
 * 显示给用户的永远是注册表里那个名字。
 *
 * @param {string} presetId 酒馆预设 id 或目录名（两者都接受）
 * @returns {string} 注册表名字；找不到条目时退到传入的 id 本身
 */
function presetDisplayNameFor(presetId) {
  const id = String(presetId == null ? '' : presetId)
  if (!id) return ''
  try {
    const meta = readPresetsMeta()
    const p = meta.presets.find(x => x && (x.id === id || x.dir === id))
    if (p && typeof p.name === 'string' && p.name.trim()) return p.name.trim()
  } catch {}
  return id
}

// ── Agent 预设管理（DSH 原生 agent-presets）────────────────
function listAgentPresets() {
  const out = []
  try {
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    const meta = readPresetsMeta()
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dir = path.join(ROOT, d.name)
      const presetYml = path.join(dir, 'preset.yml')
      const agentYml = path.join(dir, 'agent.cordis.yml')
      if (!fs.existsSync(presetYml) || !fs.existsSync(agentYml)) continue
      let name = d.name
      // ★ P0-3 补完：description 是「预设真名」的唯一线索 —— presets.json 里那张卡
      //   name 叫「示例预设」、description 里却写着 `_示例卡2`，只显示 name 用户根本看不穿。
      //   优先取注册表（presets.json，权威且带构成统计）；未注册的目录退到 preset.yml。
      //   ⚠ 外部数据，原样透传：不改写、不截断（截断是前端的事），前端也只走 textContent。
      let ymlDesc = ''
      try {
        const raw = fs.readFileSync(presetYml, 'utf8')
        const m = raw.match(/^name:\s*(.+)$/m)
        if (m) name = m[1].trim().replace(/^["']|["']$/g, '')
        const dm = raw.match(/^description:\s*(.+)$/m)
        if (dm) ymlDesc = dm[1].trim().replace(/^["']|["']$/g, '')
      } catch {}
      const p = meta.presets.find(x => x.dir === d.name)
      // ★ preset.yml 里的名字等于目录名 ⇒ 那是历史 bug（dataOnly 自动保存）留下的痕迹，
      //   注册表里的名字才是用户认得的（「酒馆默认」不该显示成「tavern-lite」）。
      if (p && typeof p.name === 'string' && p.name.trim() && (!name || name === d.name)) name = p.name.trim()
      // 酒馆预设判定：meta 注册表命中，或 agent.cordis.yml 头部带酒馆生成标记
      let isTavern = !!p
      if (!isTavern) {
        try {
          const head = fs.readFileSync(agentYml, 'utf8').slice(0, 300)
          if (head.includes('酒馆管理面板生成')) isTavern = true
        } catch {}
      }
      const isBuiltin = builtinAgentPresetDirs().has(d.name) || BUILTIN_AGENT_PRESETS.has(d.name)
        out.push({
          id: d.name, name, dir: d.name, isTavern, isBuiltin,
          origin: isTavern ? 'tavern' : (isBuiltin ? 'builtin' : 'other'),
          presetId: p?.id || null,
          description: (p && typeof p.description === 'string') ? p.description : ymlDesc,
        })
    }
  } catch {}
  return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'))
}

function deleteAgentPreset(id) {
  const dir = path.join(ROOT, id)
  const presetYml = path.join(dir, 'preset.yml')
  if (!fs.existsSync(presetYml)) throw new Error('不是有效 Agent 预设：' + id)
  if (BUILTIN_AGENT_PRESETS.has(id)) throw new Error('内置 Agent 预设不可删除：' + id)
  const meta = readPresetsMeta()
  const p = meta.presets.find(x => x.dir === id)
  if (p) {
    deletePreset(p.id)
    return { id, viaTavern: true }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { id, viaTavern: false }
}

// ── 会话绑定管理 ──────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════
// P0-1 绑定升级为**显式三态判别联合**
//
// 旧格式 `{"session-xxx": "preset-abc"}` 分不清三种完全不同的事实：
//   ① 用户在面板 / 顶部选择器上**显式选了**这张卡
//   ② 用户**显式解绑**了本会话（应当硬空）
//   ③ 解析器自己顺手写下的记账 —— 本次事故那 9 条脏数据的来源
// ①③在旧格式里长得一模一样，于是③被当成①永久生效：用户从未选过的
// 「示例卡」卡被一路注入。新格式把它们彻底分开：
//
//   { mode:'preset', presetId, source:'panel'|'top-select'|'legacy', at, rev }
//   { mode:'none' }                        ← 显式解绑，硬空
//
// ⚠ 三条硬规矩：
//   · 读必须**向后兼容**：旧字符串一律读成 {mode:'preset', source:'legacy'}，
//     否则面板上所有已绑定会话会瞬间全白。
//   · 写**只写新格式**（writeBindings 统一归一化后再落盘）。
//   · `legacy` 在**解析时视为未绑定**（不注入）：它是「无法证明是用户显式绑定」
//     的数据，自动保留等于把旧卡永久固化。但**文件里的条目不动** ——
//     解析行为与文件内容解耦，清理由 purgeLegacyBindings() 显式执行。
//     字段缺失 / 格式非法同按 legacy 处理（不得当成 none，也不得触发任何 fallback）。
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// P0-3 补完：把绑定元信息暴露给面板（/api/tavern/sessions 的每条会话）
//
// 面板此前只能拿到 `boundPreset`，而后端把 legacy / none 一律展平成 'default'，
// 于是「从未绑过」「用户显式解绑」「遗留待确认」三种事实在 UI 上长得一模一样。
// 这里补两个**只看绑定记录本身**的字段（不参与解析，不改变任何既有行为）：
//
//   bindingMode   'preset' | 'none' | 'legacy' | 'absent'
//   bindingSource 'panel' | 'top-select' | 'legacy' | null
//
// ⚠ boundPreset 的取值**逐字沿用**改前那一行（既有调用方在吃它，不许动语义）；
//   本函数只是把同一段判定搬进来，好让它能被单测直接打到（HTTP 路由打不到）。
// ══════════════════════════════════════════════════════════════════════

/**
 * 面板展示用的一条会话绑定三件套。纯函数，便于单测。
 *
 * @param {any} bound 绑定条目（原始 / 归一化都吃；缺失即 undefined）
 * @returns {{boundPreset:string, bindingMode:string, bindingSource:string|null}}
 */
function sessionBindingFields(bound) {
  const b = normalizeBinding(bound)
  return {
    boundPreset: (b && b.mode === 'preset' && b.source !== BINDING_SOURCE_LEGACY && b.presetId)
      ? b.presetId : DEFAULT_PRESET_ID,
    bindingMode: bindingModeOf(bound),
    bindingSource: b && b.mode === 'preset' ? b.source : null,
  }
}

/** 读原始（未归一化）绑定表 —— 迁移 / 清空这类要接触历史脏数据的路径才用它。 */
function readBindingsRaw() {
  if (S._bindingsCache && !S._bindingsDirty) return S._bindingsCache
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_BINDINGS, 'utf8'))
    S._bindingsCache = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { S._bindingsCache = {} }
  S._bindingsDirty = false
  return S._bindingsCache
}

/** 统一读：新旧格式都吃，出来的每条都是归一化后的三态结构。 */
function readBindings() {
  const raw = readBindingsRaw()
  const out = {}
  for (const sid of Object.keys(raw)) {
    const b = normalizeBinding(raw[sid])
    if (b) out[sid] = b
  }
  return out
}

/** 统一写：只写新格式。新旧格式都能喂进来，落盘前统一归一化。 */
function writeBindings(data) {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const out = {}
  for (const sid of Object.keys(src)) {
    const b = normalizeBinding(src[sid])
    if (!b) continue
    out[sid] = b.mode === 'none'
      ? { mode: 'none' }
      : { mode: 'preset', presetId: b.presetId, source: b.source, at: b.at || Date.now(), rev: b.rev || 1 }
  }
  S._bindingsCache = out
  S._bindingsDirty = false
  try { fs.writeFileSync(SESSION_BINDINGS, JSON.stringify(out, null, 2), 'utf8') } catch {}
  return out
}

/** 让下一次 readBindings 真正回到磁盘（进程内缓存失效）。 */
function resetBindingsCache() {
  S._bindingsCache = null
  S._bindingsDirty = false
}

/**
 * 写一条绑定 / 解绑。**这是唯一允许写入绑定的入口**（P0-2）。
 *
 * @param {string} sessionId
 * @param {{mode:'none'}|{mode:'preset',presetId:string,source:string}} entry
 * @returns {object|null} 落盘的条目
 */
function writeBindingEntry(sessionId, entry) {
  if (!sessionId) return null
  try {
    const all = readBindings()
    const prev = all[sessionId]
    const next = entry && entry.mode === 'none'
      ? { mode: 'none' }
      : {
        mode: 'preset',
        presetId: String(entry && entry.presetId ? entry.presetId : ''),
        source: entry && entry.source === BINDING_SOURCE_TOP_SELECT
          ? BINDING_SOURCE_TOP_SELECT : BINDING_SOURCE_PANEL,
        at: Date.now(),
        rev: prev && Number.isFinite(prev.rev) ? prev.rev + 1 : 1,
      }
    all[sessionId] = next
    writeBindings(all)
    return next
  } catch { return null }
}

// ══════════════════════════════════════════════════════════════════════
// P0-4 存量 legacy 绑定：迁移 + 清空
//
// ⚠ 两个函数**默认都不自动执行** —— 代码里没有任何启动路径调用它们，
//   必须由对接方显式调用（见交接报告的「实际调用方法」一节）。
//
//   · migrateLegacyBindings()：把旧字符串条目转成可审计的结构化形式
//     {mode:'preset', …, source:'legacy'}。**幂等**，且解析行为不变
//     （legacy 在解析时依然视为未绑定 —— 解析行为与文件内容解耦）。
//   · purgeLegacyBindings()：真正删掉这些 legacy 条目（用户已拍板：存量清空）。
//
//   两者都必须**先备份再写回**，写失败不得把注入打挂（沿用 writeBindings 的静默策略）。
// ══════════════════════════════════════════════════════════════════════

/** 备份当前绑定文件。@param {string} [destPath] 不传则用带时间戳的默认名。 */
function backupBindingsFile(destPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = destPath || (SESSION_BINDINGS + '.bak-' + stamp)
  try { if (fs.existsSync(SESSION_BINDINGS)) fs.copyFileSync(SESSION_BINDINGS, dest) } catch {}
  return dest
}

/**
 * 幂等迁移：旧字符串 → {mode:'preset', presetId, source:'legacy', at, rev}。
 * 已迁移的条目 `at` 保持不变 ⇒ 重复执行时 migrated=0、文件内容逐字节稳定。
 *
 * @param {{backup?:boolean, backupPath?:string, at?:number}} [opts]
 * @returns {{total:number, migrated:number, backupPath:string, bindings:object}}
 */
function migrateLegacyBindings(opts) {
  const o = opts || {}
  const now = Number.isFinite(o.at) ? o.at : Date.now()
  resetBindingsCache()
  const raw = readBindingsRaw()
  const out = {}
  let migrated = 0
  for (const sid of Object.keys(raw)) {
    const v = raw[sid]
    if (typeof v === 'string' && v) {
      out[sid] = { mode: 'preset', presetId: v, source: BINDING_SOURCE_LEGACY, at: now, rev: 1 }
      migrated++
      continue
    }
    const b = normalizeBinding(v)
    if (!b) continue                       // 空值条目：没有可迁移的东西，丢弃
    if (b.mode === 'none') { out[sid] = { mode: 'none' }; continue }
    out[sid] = { mode: 'preset', presetId: b.presetId, source: b.source, at: b.at || now, rev: b.rev || 1 }
  }
  const backupPath = o.backup === false ? '' : backupBindingsFile(o.backupPath)
  writeBindings(out)
  return { total: Object.keys(out).length, migrated, backupPath, bindings: out }
}

/**
 * 清空 legacy 绑定（用户已拍板：存量 9 条全部清空）。
 *
 * **默认不执行** —— 只有显式调用才动文件；调用前先备份。
 *
 * @param {{onlyPresetId?:string, mode?:'drop'|'none', dryRun?:boolean,
 *          backup?:boolean, backupPath?:string}} [opts]
 *        onlyPresetId 只清指向该预设的条目（例如误绑定的 preset-fixture-a3）；
 *        mode='none' 留一条 {mode:'none'} 而不是删除；dryRun 只报计划不写盘。
 * @returns {{count:number, removed:Array, kept:number, backupPath:string, dryRun:boolean}}
 */
function purgeLegacyBindings(opts) {
  const o = opts || {}
  resetBindingsCache()
  const raw = readBindingsRaw()
  const out = {}
  const removed = []
  for (const sid of Object.keys(raw)) {
    const b = normalizeBinding(raw[sid])
    const isLegacy = !!b && b.source === BINDING_SOURCE_LEGACY
    const hit = isLegacy && (!o.onlyPresetId || b.presetId === o.onlyPresetId)
    if (hit) {
      removed.push({ sid, presetId: b.presetId })
      if (o.mode === 'none') out[sid] = { mode: 'none' }
      continue
    }
    out[sid] = raw[sid]
  }
  if (o.dryRun) {
    return { count: removed.length, removed, kept: Object.keys(out).length, backupPath: '', dryRun: true }
  }
  const backupPath = o.backup === false ? '' : backupBindingsFile(o.backupPath)
  writeBindings(out)
  return { count: removed.length, removed, kept: Object.keys(out).length, backupPath, dryRun: false }
}

// ★ 统一记录系统：会话预设以 DSH 原生记录为权威（用户聊天顶部选择器的真实选择），
//   session-bindings.json 降级为兼容兜底。
//   DSH 的会话 header 存创建时预设；顶部切换会往会话事件流追加 agent-preset/selected 事件；
//   这里直接读 DSH 会话文件（zstd）解析最后一条 selected 事件（无则 header，再则 bindings，最后 default）。
/**
 * 由「事件流里最新的预设选择」+「酒馆 bindings 记账」决定权威预设。纯函数，便于单测。
 *
 * 规则（按优先级）：
 *   1. 事件流里有明确的预设选择 → **只认它**。是酒馆预设就用它；是内置预设（standard 等）
 *      就判定为「本会话不注入」，返回 default。
 *      ⚠️ 必须直接返回，**不能继续往前翻历史选择**：否则用户在顶部把会话改回标准模式后，
 *      会翻到历史上那条酒馆预设，隔离永远失效（实测症状：选了 standard，世界书照样注入）。
 *   2. 事件流里完全没有预设记录 → 才退回 bindings 记账（兼容旧数据）。
 * @param {string|null} newestExplicit 事件流里最新一条 agentPreset；无则 null
 * @param {(id: string) => boolean} isTavern 判断是否为酒馆可管理预设
 * @param {string} bound bindings 里记的预设（可能过期）；无则 ''
 * @returns {string} 权威 presetId
 */
function pickAuthoritativePreset(newestExplicit, isTavern, bound) {
  if (newestExplicit) return isTavern(newestExplicit) ? newestExplicit : DEFAULT_PRESET_ID
  if (bound && isTavern(bound)) return bound
  return DEFAULT_PRESET_ID
}

/**
 * 从一行会话日志里取出预设 id。纯函数，便于单测。
 *
 * ⚠️ 这里**绝不能**再额外要求该行同时含有 `agent-preset/selected` 或 `"header"` 之类字样。
 *    DSH 把「会话当前的预设」写在**创建记录**里，形如
 *      {"type":"session", … ,"agentPreset":"standard"}
 *    这种行两个字样都不含。旧实现因此永远提取不到值，一路退回酒馆 bindings 记账 ——
 *    于是用户在顶部把会话改成「标准模式」之后，世界书照样注入（真实故障，
 *    而且查了很久：日志里唯一能提取出值的行就是第 1 行）。
 *
 * @param {string} line 会话日志的一行
 * @returns {string} 预设 id；该行没有则空串
 */
function extractAgentPresetFromLine(line) {
  if (typeof line !== 'string' || !line.includes('agentPreset')) return ''
  const m = line.match(/"agentPreset"\s*:\s*"([^"]+)"/)
  return m && m[1] ? m[1] : ''
}

/**
 * 把会话日志里的预设**按来源拆开**。纯函数，便于单测。
 *
 * 日志里出现 `agentPreset` 的行只有两种，语义完全不同：
 *
 *   1. 创建记录（`{"type":"session",…,"agentPreset":"standard"}`）—— 会话**出生时的默认预设**。
 *      DSH 浏览器的「新对话」走 `sessions.create({ workspaceId })`，**不传 agentPreset**
 *      （见 dsh-client-ui-workspace dist/client.js:55 与 dsh-api-session-controller 的
 *      sessions/manager.js:459 `create(opts)`：payload 只拼 workspaceId/cwd/sessionId）。
 *      于是每个新建会话的创建记录里写的都是**部署默认预设**（settings.yaml 的
 *      `agent-presets.default`，实测 `standard`），跟用户在酒馆面板选的那张卡毫无关系。
 *
 *   2. `agent-preset/selected` 事件 —— 会话**开始之后**用户在聊天顶部选择器显式切换的那一次。
 *      只有这种才代表「用户本人的显式选择」。
 *
 * 旧实现把两者混成一个「最新能提取到值的行」，于是创建记录里的 `standard` 被当成了
 * 用户的显式选择（见 pickAuthoritativePreset 第 1 条规则）⇒ 判定「不注入」⇒ 返回 default
 * ⇒ **酒馆面板的绑定被静默推翻**，所有会话都注入同一个 fallback 卡
 * （default → getPresetDir 映射到 tavern-lite 目录）。
 *
 * @param {string[]} lines 会话日志的原始行
 * @returns {{explicit: string|null, creation: string|null}} 显式切换 / 出生默认
 */
function classifySessionPresetLines(lines) {
  let explicit = null
  let creation = null
  if (!Array.isArray(lines)) return { explicit, creation }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (typeof line !== 'string' || !line.includes('agentPreset')) continue
    const v = extractAgentPresetFromLine(line)
    if (!v) continue
    if (explicit === null && line.includes('agent-preset/selected')) { explicit = v; continue }
    // DSH 用 JSON.stringify 写日志，实际不含空格；这里容忍空格只是防未来换序列化器。
    if (creation === null && /"type"\s*:\s*"session"/.test(line)) creation = v
  }
  return { explicit, creation }
}

/**
 * 由「显式切换」+「出生默认」+「酒馆 bindings」决定权威预设。纯函数，便于单测。
 *
 * 优先级（与旧语义逐条对齐，只把创建记录降级；P0-1 后新增 none / legacy / fail-closed）：
 *   0. **有 agent-preset/selected 事件** → 只认它，且**不往前翻**。
 *      这是会话隔离的命门：用户在顶部把会话改回内置预设后，必须立刻停止注入。
 *      ⚠️ 它排在显式解绑**之前**：顶部选择器是本会话「当下」的意愿，时间上必然晚于
 *      之前那次解绑；若让 none 压过 explicit，用户显式选回一张卡就永远选不回来了。
 *   1. 没有显式切换 → 看绑定记账：
 *      · `mode:'none'`（用户显式解绑）→ **硬空**，不看 creation、不看任何 fallback；
 *      · `mode:'preset'` 且来源是 panel / top-select → 用它；若该预设已不存在
 *        （isTavern 判否）→ **fail closed 返回 default**，绝不退到 creation 换一张卡；
 *      · `legacy`（旧字符串 / 非法条目）→ **视为未绑定**，跳过本层，不静默注入。
 *   2. 绑定不可用 → **不再看出生默认值**（P0-5）：creation 只是「会话出生时挂的是哪张卡」，
 *      不是用户的选择，与 legacy 同等对待 ⇒ 视为未绑定 ⇒ default（不注入）。
 *      ⚠ 只改这里的**返回值**：creation 的读取和 `classifyPresetBindingSource()` 的
 *      'creation' 标签都保留，排查时仍能在观测日志里看出「这次走的是 creation 路径」。
 *   3. 都没有 → default（不注入）。
 *
 * @param {string|null} explicit 最新一条 agent-preset/selected 事件的预设
 * @param {string|null} creation 创建记录里的出生默认预设
 * @param {(id: string) => boolean} isTavern 判断是否为酒馆可管理预设
 * @param {any} bound bindings 里的条目（旧字符串 / 新对象 / 无）
 * @returns {string} 权威 presetId
 */
function pickAuthoritativePresetFromLog(explicit, creation, isTavern, bound) {
  if (explicit) return isTavern(explicit) ? explicit : DEFAULT_PRESET_ID
  const b = normalizeBinding(bound)
  if (b) {
    if (b.mode === 'none') return DEFAULT_PRESET_ID
    if (b.source !== BINDING_SOURCE_LEGACY) {
      // fail closed：绑定指向的预设没了就报「不注入」，绝不能悄悄换绑到别的来源上。
      return isTavern(b.presetId) ? b.presetId : DEFAULT_PRESET_ID
    }
    // legacy：无法证明是用户显式绑定 ⇒ 视为未绑定，继续往下走
  }
  // ★ P0-5：出生默认值（creation）**不再是注入依据** —— 与 legacy 同等对待。
  //
  //   creation 是 DSH 在「新建会话」那一刻按部署默认值写下的（实测 `standard`，
  //   但部署默认值一改、或出现带 preset 的创建路径，它就会是一张真实酒馆卡）。
  //   用户从来没在这条会话里选过它，注入它就是静默注入 —— 用户原始诉求是
  //   「我根本没选预设就不该注入」。
  //
  //   ⚠ 分寸：**只改决议结果**。creation 的读取（resolveAuthoritativePreset）和
  //   'creation' 来源标签（classifyPresetBindingSource）都保留，观测日志里仍能看出
  //   「这次走的是 creation 路径」，只是决议返回 default（不注入）。
  return DEFAULT_PRESET_ID
}

/**
 * 完整决议：既给 presetId，也给「这次是从哪条路径来的」标签（P0-2 据此决定写不写绑定）。
 *
 * @param {string} sessionId
 * @returns {{presetId: string, source: string, bindingMode: string}}
 */
function resolveAuthoritativePreset(sessionId, ctxArg) {
  if (!sessionId) return { presetId: DEFAULT_PRESET_ID, source: 'none', bindingMode: 'absent' }
  let explicit = null
  let creation = null
  let logFound = false
  try {
    const file = findSessionFile(sessionId)
    if (file) {
      logFound = true
      const lines = readSessionLines(file)
      // 从末尾往前扫，分别取「最新显式切换」和「创建记录」。
      // ⚠️ 两者不可混为一谈 —— 见 classifySessionPresetLines 的说明。
      const cls = classifySessionPresetLines(lines)
      explicit = cls.explicit
      creation = cls.creation
    }
  } catch {}
  let bound = null
  try { bound = normalizeBinding(readBindings()[sessionId]) } catch {}
  // ★ 账本里那条 `default` 要当成「酒馆默认预设」而不是「没有任何预设」。
  //
  //   坑在哪：`DEFAULT_PRESET_ID`（'default'）同时身兼两职 —— 既是酒馆注册表里
  //   「酒馆默认」这个预设的 id（`default` → 目录 tavern-lite），又是本文件里
  //   「本会话不注入」的哨兵值（pickAuthoritativePresetFromLog 的返回值、isTavernSession
  //   与 tavern:card 的 `!== DEFAULT_PRESET_ID` 判断）。于是**绑了「酒馆默认」的会话
  //   会被当成"没绑"**：卡不注入、破限段/事实修正段也不注入 —— 用户明明绑了卡却什么都没有。
  //   正解是把两件事分开：账本里一律存**目录名**（DSH 侧 id），'default' 只保留哨兵含义。
  //   写入口（bind-preset / watcher）已改成存目录名；这里再兜住**存量**的 'default' 条目。
  if (bound && bound.mode === 'preset' && bound.presetId === DEFAULT_PRESET_ID) {
    bound = { ...bound, presetId: DEFAULT_PRESET_DIR }
  }
  // ★★ 决议权威的次序（2026-09-27 定稿，三个失败模式都要挡 —— 少挡一个就出一类回归）：
  //
  //   ⓐ **投影挂的是酒馆预设**、且能证明「不是出生值」（日志缺失 / 没 header / 与 header 不同）
  //      ⇒ 注入它。覆盖：空白会话用 DSH 新建页的预设条选卡、面板的原生绑定、
  //      以及部署默认就是酒馆预设的机器。
  //   ⓑ **投影挂的是非酒馆预设**、且与出生 header **不同** ⇒ 一定有人刚换过、那帧还没落盘
  //      ⇒ 不注入（这就是"刚切走、还在按旧账本注入"的串台窗口）。
  //   ⓒ 其余情况（投影 == 出生值、投影读不到、没有投影服务）⇒ 一律退回「日志 → 账本」。
  //      ★ 这条是**必须**的保守项：DSH 一旦开跑就锁死预设本体，已开跑的会话只能靠账本跟随；
  //        若在这里用投影（= 出生值 standard）去推翻账本，等于把用户正在进行的角色扮演全掐死。
  //        而「用户切回出生值」这一格由 armNativePresetWatcher 负责：DSH 一发选择事件，
  //        账本立刻被改写成 none ⇒ ⓒ 的最后结论就是不注入，窗口缩到 0。
  const nativePreset = nativeAgentPresetOf(ctxArg || S.activePluginCtx, sessionId)
  const nativeUnproven = !logFound || !creation          // 无从比较（日志/header 缺失）
  const nativeChanged = !!creation && nativePreset !== creation
  if (nativePreset && isTavernPresetDir(nativePreset) && (nativeUnproven || nativeChanged)) {
    return { presetId: nativePreset, source: 'native', bindingMode: bindingModeOf(bound) }
  }
  if (nativePreset && !isTavernPresetDir(nativePreset) && nativeChanged) {
    return { presetId: DEFAULT_PRESET_ID, source: 'native', bindingMode: bindingModeOf(bound) }
  }
  return {
    presetId: pickAuthoritativePresetFromLog(explicit, creation, isTavernPresetDir, bound),
    source: classifyPresetBindingSource(explicit, creation, isTavernPresetDir, bound),
    bindingMode: bindingModeOf(bound),
  }
}

function resolveAuthoritativePresetId(sessionId) {
  return resolveAuthoritativePreset(sessionId).presetId
}

/**
 * 监听 DSH 自己的预设选择事件，让酒馆账本**跟着会话原生预设走**。
 *
 * 为什么必须有它：账本是「会话级绑定」的兜底权威（尤其是**已开跑**的会话 ——
 * DSH 一旦开跑就锁死预设本体，账本是它们唯一能跟随的通道）。但账本会过期：
 * 用户在聊天顶部把会话切成 standard 之后，若账本还留着酒馆卡，酒馆就会照旧注入 ——
 * 那就是串台。日志要等落盘才看得见，而**这个事件是内存里立刻发的**，
 * 所以在这里同步账本，串台窗口从"一帧"缩到 0。
 *
 * 规则（与决议链语义对齐）：
 *   · 换到酒馆预设 ⇒ 记成 {mode:'preset', source:'top-select'}（用户显式选的，最高权威）；
 *   · 换成非酒馆预设 ⇒ 记成 {mode:'none'}（硬空：这个会话不再注入任何酒馆内容）。
 *
 * @param {object} ctx cordis 上下文
 * @returns {Function} 卸载函数
 */
function armNativePresetWatcher(ctx) {
  const disposes = []
  try {
    disposes.push(ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'agent-preset/selected') return
        const sid = sessionIdOf(session)
        if (!sid) return
        const picked = String((event.data && event.data.agentPreset) || '')
        // 空值不猜（DSH 的 payload 一定有值；真拿不到就不要动账本）
        if (!picked) return
        if (isTavernPresetDir(picked)) {
          writeBindingEntry(sid, { mode: 'preset', presetId: picked, source: BINDING_SOURCE_TOP_SELECT })
          return
        }
        // ★ 换成非酒馆预设：只在**账本里本来有东西**时才写 {mode:'none'}。
        //   否则每切一次无关会话（比如编码会话 standard → ptc）就往账本里塞一条空记录 ——
        //   账本会越长越脏，而它也**只该记录酒馆真正关心过的会话**。
        const prev = normalizeBinding(readBindings()[sid])
        if (prev && prev.mode !== 'none') writeBindingEntry(sid, { mode: 'none' })
      } catch {}
    }, { global: true }))
  } catch (e) {
    try { console.error('[tavern] 预设事件监听安装失败：', String(e && e.message || e)) } catch {}
  }
  return () => { for (const d of disposes) { try { d() } catch {} } }
}

// ══════════════════════════════════════════════════════════════════════
// P0-6 注入观测日志（**只加不改**的取证仪表）
//
// 用户报「原生 agentPreset = standard 的会话，每轮都在注入示例卡角色卡 + 世界书」。
// 决议链上有三处嫌疑（陈旧自动绑定盖过出生默认 / 解析出酒馆预设就自动写绑定 /
// allowlist 双空等价全放行），但现场**没有取证手段**：旧日志只有
// `sid / presetId / presetName` 三列，看不出 presetId 到底是从哪条路径决议出来的。
//
// 于是每轮组装完成时往 inject-debug.log 追加一行 JSON，把「来源」记下来，供后续
// 每一棒对账。两条硬规矩：
//
//   ⚠️ 只读不写、不参与决议 —— 注入行为与改动前逐字节一致，只是多出一行日志。
//      （修 bug 是后续棒的事，本棒一律不碰。）
//   ⚠️ 绝不记录 prompt 正文 —— 只记 id / hash / 来源 / 体积。这是用户明确要求。
//
// 日志字段：ts sid bindingMode presetId bindingSource resolvedFrom
//           cardHash wbHash textLen allowedBy
// ══════════════════════════════════════════════════════════════════════

/**
 * 读一次会话日志 + bindings，给出本轮观测要用的「绑定形态」和「来源标签」。只读。
 *
 * P0-1 起 bindingMode 输出真实三态：`preset` / `none` / `legacy` / `absent`
 * （`legacy` = 旧字符串或非法条目读上来的、未获用户确认的记账）。
 *
 * @param {string} sessionId
 * @returns {{bindingMode: 'preset'|'none'|'legacy'|'absent', bindingSource: string}}
 */
function readPresetBindingSource(sessionId) {
  const r = resolveAuthoritativePreset(sessionId)
  return { bindingMode: r.bindingMode, bindingSource: r.source }
}

/**
 * 往 inject-debug.log 追加一行观测 JSON。写失败一律静默吞掉 ——
 * 观测绝不能反过来把注入打挂（与既有自动绑定的 `catch {}` 同一风格）。
 *
 * @param {object} rec 观测记录
 * @returns {string} 实际写入的那一行（写失败也返回拼好的行，便于测试断言）
 */
function writeInjectObserveRecord(rec) {
  let line = ''
  try { line = JSON.stringify(rec) } catch { return '' }
  try { fs.writeFileSync(path.join(ROOT, 'inject-debug.log'), line + '\n', { flag: 'a' }) } catch {}
  return line
}

/**
 * 每轮组装完成时调用：把这一轮的决议来源 / 指纹 / 体积记一行。纯观测。
 *
 * @param {{sid?:string, presetId?:string, cardText?:string, wbText?:string,
 *          textLen?:number, allowedBySession?:boolean, allowedByCwd?:boolean}} opts
 * @returns {string} 写入的日志行；失败返回 ''
 */
function observeInjection(opts) {
  try {
    const o = opts || {}
    const src = readPresetBindingSource(o.sid)
    // allowedBy 对应 refresh() 里 3787-3802 那段门禁的判定结果：
    //   session / cwd 命中 → 记对应的那个；都没命中 → 'none'。
    //   （mode=global 全放行时两个标记都是 false，如实记 'none' —— 本棒只观测，不改判定。）
    const allowedBy = o.allowedBySession ? 'session' : (o.allowedByCwd ? 'cwd' : 'none')
    return writeInjectObserveRecord({
      ts: new Date().toISOString(),
      sid: o.sid || '',
      bindingMode: src.bindingMode,
      presetId: o.presetId || '',
      bindingSource: src.bindingSource,
      // 与 bindingSource 同义：代码里没有第二个「resolvedFrom」概念，
      // 就复用同一个标签，不另造一套词汇（免得两边对不上账）。
      resolvedFrom: src.bindingSource,
      cardHash: contentHash16(o.cardText),
      wbHash: contentHash16(o.wbText),
      textLen: Number.isFinite(o.textLen) ? o.textLen : 0,
      allowedBy,
    })
  } catch { return '' }
}

// 判断预设是否为酒馆可管理预设
function isTavernPresetDir(presetId) {
  if (!presetId) return false
  if (presetId === DEFAULT_PRESET_ID) return true
  try {
    if (fs.existsSync(path.join(ROOT, presetId, 'preset.yml')) && fs.existsSync(path.join(ROOT, presetId, 'agent.cordis.yml'))) return true
  } catch {}
  // ★ 2026-09-27：本版 DSH 的预设是**声明行**（`@deepseek-ai/dsh-agent-preset`），
  //   旧目录已不再被 DSH 读取；迁移成声明后旧目录会被删掉，注入判据不能因此失效。
  //   所以「酒馆注册表里有这个 id」同样算酒馆预设（内容从注册表目录读，读不到就是空注入）。
  try { return readPresetsMeta().presets.some(p => p && p.id === presetId) } catch {}
  return false
}

function getSessionPresetId(sessionId) {
  if (!sessionId) return DEFAULT_PRESET_ID
  // 以 DSH 原生预设记录为权威（与聊天顶部选择器一致）
  return resolveAuthoritativePresetId(sessionId)
}

/**
 * 本会话该不该被酒馆注入 —— **会话隔离的统一判据**。
 *
 * 规则与 `tavern:card` 完全一致：
 *   1. 以 DSH 的会话预设为权威（`getSessionPresetId`）；是酒馆预设 → 注入。
 *   2. 不是的话，再看它是不是某个酒馆会话的子 Agent → 继承父会话的判断。
 *
 * 为什么单独抽出来：`tavern:nsfw`（破限段）以前自带一套判断，只检查「sid 存不存在」，
 * 从不问这个会话挂的是不是酒馆预设。结果是：**在标准模式的编码会话里，世界书已经不注入了，
 * 破限段却照样被塞进去** —— 会话隔离只做了一半（真实故障：实测 card=0 / wb=0 但 nsfw=1819）。
 *
 * @param {string} sid 会话 id
 * @param {object} context 组装上下文（用于取 parentSession）
 * @returns {boolean} true = 本会话属于酒馆，可以注入
 */
function isTavernSession(sid, context) {
  if (!sid) return false
  try {
    const p = getSessionPresetId(sid)
    if (p && p !== DEFAULT_PRESET_ID && isTavernPresetDir(p)) return true
    // 子 Agent 继承：与 card 段同一套语义
    const parentSid = context?.agent?.session?.header?.parentSession || ''
    if (parentSid) {
      const pp = getSessionPresetId(parentSid)
      if (pp && pp !== DEFAULT_PRESET_ID && isTavernPresetDir(pp)) return true
    }
  } catch {}
  return false
}

function setSessionPreset(sessionId, presetId) {
  if (!sessionId) throw new Error('缺少会话ID，请先发一条消息')
  // 验证预设存在：酒馆 meta 注册表预设 或 DSH agent 预设目录（含 preset.yml）
  const meta = readPresetsMeta()
  const inMeta = meta.presets.some(p => p.id === presetId)
  let isAgentDir = false
  try {
    isAgentDir = presetId !== DEFAULT_PRESET_ID && fs.existsSync(path.join(ROOT, presetId, 'preset.yml')) && fs.existsSync(path.join(ROOT, presetId, 'agent.cordis.yml'))
  } catch {}
  if (!inMeta && !isAgentDir) throw new Error('预设不存在')
  // 写入酒馆 bindings（读取端以 DSH 会话事件流为权威，这里保留兼容记录；
  // 不直接改 DSH 会话文件，避免破坏 DSH 运行时的会话状态）
  // ★ P0-1：走统一写入口，写新格式，来源标 panel（这是用户显式操作）。
  // ★ 幂等地换成 **DSH 侧 id（目录名）**：账本里存 'default' 会与「不注入」哨兵撞车
  //   （见 resolveAuthoritativePreset 里的说明）。面板仍用酒馆 id 通信，只是落盘这一份统一。
  return writeBindingEntry(sessionId, { mode: 'preset', presetId: agentPresetIdFor(presetId), source: BINDING_SOURCE_PANEL })
}

// ══════════════════════════════════════════════════════════════════════
// 原生 agent 预设选择 —— 「会话绑定」的正路
//
// ★ 设计（用户拍板）：酒馆预设**就是** DSH agent 预设，一个会话挂哪张卡 = 该会话的
//   原生 agentPreset。DSH 自己就提供这条路（dsh-agent-preset-registry 的注册表服务）：
//
//     await agentPresets.select(agent, '<agent 预设 id（目录名）>')
//
//   · 只在**会话尚未开始第一回合**时允许 —— 已开始会抛 `agent-preset/locked`
//     （"This session has already started"）。这条限制是 DSH 定的，不是酒馆定的：
//     卡片本体在会话开跑后不可换，酒馆此时只能跟世界书/记忆。
//   · 成功即往**该会话自己的**事件流 append `agent-preset/selected` ⇒ 顶部选择器、
//     酒馆注入决议（pickAuthoritativePresetFromLog 的最高优先级）、会话隔离三者同源，
//     空白新会话（还没发过消息）也能选 —— 这正是「不用先发一条消息才能绑定」的关键。
//   · 酒馆自己的 session-bindings.json 从「唯一依据」降级为**兼容兜底**：
//     原生 select 成功后它只是同一事实的第二份记账；原生走不通（旧版 DSH / 会话已开跑）
//     时才靠它保住「世界书/记忆跟随」。
// ══════════════════════════════════════════════════════════════════════

/**
 * 用 DSH 原生机制给某个会话选 agent 预设（会话级绑定的正路）。
 *
 * 永不抛：一切失败都折叠成结构化结果，路由据此给面板**如实**的状态，
 * 绝不让「绑定失败」被静默吞掉（那正是老 bug 的形态）。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} sessionId 目标会话 id
 * @param {string} presetId 酒馆侧预设 id（内部换算成 DSH agent 预设 id）
 * @returns {Promise<{ok:boolean, reason?:string, presetId?:string, target?:string,
 *                    code?:string, message?:string, started?:boolean}>}
 */
async function selectNativeAgentPreset(ctx, sessionId, presetId) {
  const target = agentPresetIdFor(presetId)
  if (!sessionId || !target) return { ok: false, reason: 'bad-args' }
  const svc = getCtxService(ctx, 'agentPresets')
  if (!svc || typeof svc.select !== 'function') {
    // DSH 没提供该服务（旧版本）：调用方走 bindings 兜底，并在响应里如实说明
    return { ok: false, reason: 'agent-presets-unavailable', target }
  }
  // ★ 先对名册：本版 DSH 只认**声明行**（见 renderPresetDeclaration），旧目录预设不在名册里。
  //   名册读得到而目标不在其中 ⇒ 这会是一次注定失败的 select（agent-preset/not-found），
  //   与其让人对着 not-found 猜，不如直接说「这个预设 DSH 还没声明」并把名册带回去。
  //   名册读不到（旧版/服务缺失）就跳过这一步，绝不因为「不知道名册」而拒绝。
  const roster = await nativePresetRoster(ctx)
  if (roster.ok && !roster.ids.includes(target)) {
    return { ok: false, reason: 'not-in-roster', target, roster: roster.ids }
  }
  const agent = findLiveAgent(ctx, sessionId)
  if (!agent) return { ok: false, reason: 'no-live-agent', target }
  const started = nativeTurnStarted(ctx, agent)
  try {
    const committed = await svc.select(agent, target)
    return { ok: true, presetId: String(committed || target), target, started }
  } catch (e) {
    const code = String((e && (e.code || e.name)) || '')
    const message = String((e && e.message) || e || '')
    // DSH 侧的错误码（见 dsh-agent-preset-registry）逐条对上，面板才能说清「为什么没绑成」
    const reason = code === 'agent-preset/locked' || /already started/i.test(message) ? 'locked'
      : code === 'agent-preset/not-found' ? 'preset-not-found'
      : code === 'agent-preset/invalid' ? 'preset-invalid'
      : 'select-failed'
    return { ok: false, reason, code, message, target, started }
  }
}

/**
 * 读 DSH **原生预设名册**（`agentPresets.list()`）—— 顶部选择器里到底有哪些预设。
 *
 * 只读、永不抛。返回 `{ok, ids:[], rows:[], reason?}`：
 *   · `ok:false` 表示这个 DSH 版本没有该服务（旧版），调用方按「不知道」处理，
 *     绝不当成「名册是空的」——那会把能用的预设判成不能用。
 *   · 为什么需要它：本版 DSH 的预设是**声明行**（见 renderPresetDeclaration），
 *     酒馆的旧目录预设不在名册里。有了名册，插件才能如实告诉用户
 *     「这个预设 DSH 还没声明，所以顶部选不到、也就谈不上按会话绑定」，
 *     而不是丢一句 agent-preset/not-found 让人猜。
 *
 * @param {object} ctx cordis 上下文
 * @returns {Promise<{ok:boolean, ids:string[], rows:Array, reason?:string}>}
 */
async function nativePresetRoster(ctx) {
  try {
    const svc = getCtxService(ctx, 'agentPresets')
    if (!svc || typeof svc.list !== 'function') return { ok: false, ids: [], rows: [], reason: 'agent-presets-unavailable' }
    const raw = await svc.list()
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.presets) ? raw.presets : [])
    const ids = rows.map(r => String((r && (r.id || r.presetId)) || '')).filter(Boolean)
    return { ok: true, ids, rows }
  } catch (e) {
    return { ok: false, ids: [], rows: [], reason: 'roster-read-failed：' + String((e && e.message) || e) }
  }
}

// ── 预设内容读写 ──────────────────────────────────────────
function readPresetFiles(presetId) {
  const dir = getPresetDir(presetId)
  if (!dir) return { agentYml: '', presetYml: '', dir: '', characters: [], worldbooks: [], presets: [] }
  fs.mkdirSync(dir, { recursive: true })
  const agentYml = fs.existsSync(path.join(dir, 'agent.cordis.yml'))
    ? fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8') : ''
  const presetYml = fs.existsSync(path.join(dir, 'preset.yml'))
    ? fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8') : ''
  // 读取角色卡元数据
  let characters = []
  try {
    if (fs.existsSync(path.join(dir, 'characters.json'))) {
      characters = JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'))
    }
  } catch {}
  // 如果没有元数据，从 agentYml 中解析角色名作为后备
  if (!characters.length && agentYml) {
    try {
      const nameMatch = agentYml.match(/角色名[：:]\s*(.+)/)
      if (nameMatch) {
        characters = [{ name: nameMatch[1].trim(), desc: '', enabled: true }]
      }
    } catch {}
  }
    /* 旧版世界书数组读取（已由下方统一格式读取替代）
  // 读取世界书元数据
  let worldbooks = []
  try {
    if (fs.existsSync(path.join(dir, 'worldbooks.json'))) {
      worldbooks = JSON.parse(fs.readFileSync(path.join(dir, 'worldbooks.json'), 'utf8'))
    }
  } catch {}
  // 如果没有元数据，从 worldbook.json 中读取条目数量作为后备
  if (!worldbooks.length) {
    try {
      if (fs.existsSync(path.join(dir, 'worldbook.json'))) {
        const wb = JSON.parse(fs.readFileSync(path.join(dir, 'worldbook.json'), 'utf8'))
        if (wb.entries && wb.entries.length) {
          worldbooks = [{ name: '世界书', entries: wb.entries, enabled: true }]
        }
      }
    } catch {}
  }
    */
    // 统一格式读取：不管文件里是旧数组还是 v2 对象，都按统一结构转回上面板数组
      let worldbooks = []
    try {
      const wb = readWorldbook(presetId)
      worldbooks = (wb.groups || []).map(g => ({
        name: g.name,
        enabled: g.enabled !== false,
        entries: g.entries || []
      }))
    } catch {}

  // 读取预设（presets）元数据
  let presets = []
  try {
    if (fs.existsSync(path.join(dir, 'presets.json'))) {
      presets = JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8'))
    }
  } catch {}
  return { agentYml, presetYml, dir, characters, worldbooks, presets }
}

function writePresetFiles(presetId, agentYml, presetYml, characters, worldbooks, presets) {
  const dir = getPresetDir(presetId)
  if (!dir) throw new Error('预设不存在')
  fs.mkdirSync(dir, { recursive: true })
  if (typeof agentYml === 'string') {
    // ★ 清理 agent.cordis.yml 里的 SillyTavern 变量（DSH 会直接渲染 persona 文本，
    //   残留 {{xxx}} 会导致 malformed/unknown prompt variable 报错）
    let cleaned = cleanSillyTavernVars(agentYml)
    // ★ 基于极简模式：始终追加 pwsh、filesystem、editor 工具
    if (!cleaned.includes('dsh-tool-pwsh')) {
      cleaned += '\n- id: tool-pwsh\n  name: \'@deepseek-ai/dsh-tool-pwsh\'\n'
    }
    // ★ 联网搜索：当 networkEnabled 开启时追加 tool-web
    try {
      const netSt = readState()
      if (netSt.networkEnabled === true && !cleaned.includes('dsh-tool-web')) {
        cleaned += '\n- id: tool-web\n  name: \'@deepseek-ai/dsh-tool-web\'\n'
      }
    } catch {}
    // ★ 极简模式基础：追加 filesystem + str-replace-editor
    if (!cleaned.includes('dsh-fs-local')) {
      cleaned += '\n- id: filesystem\n  name: cordis:group\n  group: true\n  isolate:\n    fs: true\n  config:\n    - id: fs-local\n      name: \'@deepseek-ai/dsh-fs-local\'\n      config:\n        cwd: !!js process.env.DSH_CWD ?? process.cwd()\n    - id: str-replace-editor\n      name: \'@deepseek-ai/dsh-tool-str-replace-editor\'\n      config:\n        maxOutputChars: 16000\n'
    }
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), cleaned, 'utf8')
  }
  if (typeof presetYml === 'string') {
    fs.writeFileSync(path.join(dir, 'preset.yml'), presetYml, 'utf8')
  }
  // 保存角色卡元数据
  if (Array.isArray(characters)) {
    characters = cleanObjectStrings(characters)
    fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(characters, null, 2), 'utf8')
  }
    /* 旧版世界书数组写入（已由下方统一格式写入替代）
  // 保存世界书元数据
  if (Array.isArray(worldbooks)) {
    fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify(worldbooks, null, 2), 'utf8')
  }
    */
    // 统一世界书格式写入（覆盖上面的旧数组写入，只保留 v2 结构）
    if (worldbooks !== undefined && worldbooks !== null) {
      const existingMode = (() => {
        try { return readWorldbook(presetId).injectMode || 'full' } catch { return 'full' }
      })()
    if (Array.isArray(worldbooks)) worldbooks = cleanObjectStrings(worldbooks)
      const norm = normalizeWorldbookData(worldbooks)
      // 上面板保存的是数组，本身不携带注入模式，保留文件里已有的模式
      if (Array.isArray(worldbooks)) norm.injectMode = existingMode
      const unified = {
        version: 2,
        injectMode: norm.injectMode || 'full',
        groups: norm.groups || []
      }
      fs.writeFileSync(path.join(dir, 'worldbooks.json'), JSON.stringify(unified, null, 2), 'utf8')
      try { if (fs.existsSync(path.join(dir, 'worldbook.json'))) fs.unlinkSync(path.join(dir, 'worldbook.json')) } catch {}
    }

  // 保存预设（presets）元数据
  if (Array.isArray(presets)) {
    // ★ 2026-09-24：不再在保存时清洗模块内容。原 cleanObjectStrings 会把
    //   {{setvar}}/{{getvar}}/{{random}} 等 ST 宏永久剥空，等于烧掉 v10.0 系预设
    //   的变量装配线 —— 文风/反八股词条「导入后没实际生效」的根因。
    //   presets.json 只被本插件读取（cardTextFor 组装），宏在组装出口
    //   （sanitizePromptText → expandStMacros）统一求值，不会漏进 DSH。
    fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify(presets, null, 2), 'utf8')
  }
    // 确保 DSH agent 预设名 = 酒馆预设名
    try {
      const meta = readPresetsMeta()
      const p = meta.presets.find(x => x.id === presetId)
      if (p) writePresetNameFile(presetId, p.name)
    } catch {}
  return dir
}

// ── （已删除）通用预设增强层（preset-forge）─────────────────────
//
// 原在这里定义：readEnhancePack()（读内置模块包）、enhanceBackupStamp()、
// applyEnhancePack()（按 name merge 进 presets.json，写前备份）。连同 /api/tavern/preset/enhance
// 路由与 lib/preset-enhance-pack.json 一起按用户要求删除。回退见 _scratch/backup/ 快照。

// ST 宏求值器（组装时求值，不落盘烧死）────────────────────────
// ST 预设（v10.0 系）的文风/反八股词条是变量装配线：前部模块
// {{setvar::k::v}} 存指令，后部模块 {{getvar::k}} 取出注入。
// 旧实现在保存时把 setvar/getvar 整体剥空（cleanSillyTavernVars 的
// 双冒号正则），词条从未到达模型 —— 「导入后文风没实际生效」的根因。
// 现在把求值挪到组装出口：每次生成重新求值（random/roll 每轮重抽，
// 与 ST 行为一致），setvar/getvar 在单次组装内按出现顺序流式展开。
function expandStMacros(text, charName, userFallback) {
  if (!text || typeof text !== 'string' || text.indexOf('{{') === -1) return text || ''
  const vars = Object.create(null)
  const pn = S.playerName || userFallback || ''
  const cn = (charName && String(charName).trim()) || '角色'
  // 流式求值：每次替换「最内层」宏（内层不含 {{），直到不动点。
  // 非 ST 宏（DSH 的 provider/model/cwd 等）用占位保护，循环后还原，
  // 交给 sanitizePromptText 的通用兜底/DSH 本体处理。
  const RE = /\{\{([^{}]*)\}\}/
  for (let i = 0; i < 5000; i++) {
    const m = text.match(RE)
    if (!m) break
    const all = m[0]
    const inner = m[1]
    const idx = inner.indexOf('::')
    const kw = (idx === -1 ? inner : inner.slice(0, idx)).trim().toLowerCase()
    let rep = null
    if (kw === 'setvar') {
      const rest = inner.slice(idx + 2)
      const i2 = rest.indexOf('::')
      const name = (i2 === -1 ? rest : rest.slice(0, i2)).trim()
      if (name) vars[name] = i2 === -1 ? '' : rest.slice(i2 + 2)
      rep = ''
    } else if (kw === 'getvar') {
      const name = inner.slice(idx + 2).trim()
      rep = vars[name] != null ? vars[name] : ''
    } else if (kw === 'addvar' || kw === 'incvar' || kw === 'decvar') {
      // ST 变量族 —— 逐字对齐 ST 实现：
      //   {{addvar::k::v}}  = addLocalVariable(k, v)        （scripts/variables.js:136）
      //   {{incvar::k}}     = addLocalVariable(k, 1)        （scripts/variables.js:196）
      //   {{decvar::k}}     = addLocalVariable(k, -1)       （scripts/variables.js:204）
      //   ★ incvar/decvar **不是**"数值 ±1"，它们与 addvar 共用同一条实现，因此三条分支
      //     完全一致：① 现有值能 JSON.parse 成数组 ⇒ push 后存回 JSON；
      //     ② `Number(v)` 或 `Number(cur)` 任一为 NaN ⇒ 字符串拼接（`String(cur || '') + v`）；
      //     ③ 否则数值相加。缺省值 = 0，但 `0 || ''` ⇒ ''（首次 addvar 字符串无前导 0）。
      let name
      let add
      if (kw === 'addvar') {
        const rest = inner.slice(idx + 2)
        const i2 = rest.indexOf('::')
        name = (i2 === -1 ? rest : rest.slice(0, i2)).trim()
        add = i2 === -1 ? '' : rest.slice(i2 + 2)
      } else {
        name = inner.slice(idx + 2).trim()
        add = kw === 'incvar' ? 1 : -1
      }
      if (name) {
        const cur = vars[name] != null ? vars[name] : 0
        let arr = null
        try { const parsed = JSON.parse(cur); if (Array.isArray(parsed)) arr = parsed } catch (_) {}
        if (arr) {
          arr.push(add)
          vars[name] = JSON.stringify(arr)
        } else if (isNaN(Number(add)) || isNaN(Number(cur))) {
          vars[name] = String(cur || '') + add
        } else {
          vars[name] = String(Number(cur) + Number(add))
        }
      }
      // addvar 返回 ''；incvar/decvar 返回**新值**（ST handler 的 normalize(result)）
      rep = kw === 'addvar' ? '' : (name && vars[name] != null ? String(vars[name]) : '')
    } else if (kw === 'random' || kw === 'pick') {
      rep = randomPick(idx === -1 ? '' : inner.slice(idx + 2))
    } else if (kw === 'roll') {
      rep = randomRoll(idx === -1 ? '' : inner.slice(idx + 2))
    } else if (kw === 'trim' || kw === 'newline') {
      rep = kw === 'newline' ? '\n' : ''
    } else if (kw === 'char') {
      rep = cn
    } else if (kw === 'user' || kw === 'name') {
      rep = pn
    } else if (kw === 'persona' || kw === 'description' || kw === 'scenario'
      || kw === 'system prompt' || kw === 'example_dialogue' || kw === 'world_scenario'
      || kw === 'first_mes' || kw === 'mes_example') {
      rep = ''
    } else {
      // 非 ST 宏：占位保护（原样还原），避免死循环
      rep = '\u0000STM\u0000' + inner + '\u0000E\u0000'
    }
    text = text.slice(0, m.index) + rep + text.slice(m.index + all.length)
  }
  text = text.replace(/\u0000STM\u0000([\s\S]*?)\u0000E\u0000/g, '{{$1}}')
  return text
}

// 清洗注入文本里的 SillyTavern/未知模板变量，避免 DSH 报 malformed/unknown prompt variable
function sanitizePromptText(text, charName) {
  if (!text || typeof text !== 'string') return text || ''
  let s = text
  // ★ ST 宏求值必须最先跑：setvar/getvar 装配线（文风/反八股词条的载体）
  //   与 random/pick/roll、{{char}}/{{user}} 在这里变成真实文本。
  //   放在通用兜底之后的话整条装配线会被兜底剥空。
  s = expandStMacros(s, charName, '用户')
  // 兼容 ST 无状态宏：注释块删除（expandStMacros 已处理单层，这里兜底含 }} 的注释）
  // （setvar/getvar 等有状态变量已由 expandStMacros 展开，残留的由下方通用兜底统一剔除。）
  s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
  // 常见 SillyTavern 变量（expandStMacros 已展开，此处兜底幂等）
  s = s.replace(/\{\{user\}\}/gi, S.playerName || '用户')
  s = s.replace(/\{\{char\}\}/gi, (charName && String(charName).trim()) || '角色')
  s = s.replace(/\{\{persona\}\}/gi, '')
  s = s.replace(/\{\{system prompt\}\}/gi, '')
  s = s.replace(/\{\{example_dialogue\}\}/gi, '')
  s = s.replace(/\{\{world_scenario\}\}/gi, '')
  s = s.replace(/\{\{name\}\}/gi, S.playerName || '用户')
  s = s.replace(/\{\{description\}\}/gi, '')
  s = s.replace(/\{\{scenario\}\}/gi, '')
  s = s.replace(/\{\{first_mes\}\}/gi, '')
  s = s.replace(/\{\{mes_example\}\}/gi, '')
  // ★ 通用兜底：清除所有剩余 {{...}} 引用（与 DSH 的 GROUP_AT 一致的"不含内层花括号"匹配），
  //   只保留 DSH 已注册的 provider/model/cwd 三个变量，其余（含 {{xxx::yyy}} 双冒号、
  //   {{中文名}}、{{.点开头}}、多行内容等一切 DSH 不支持的格式）一律剔除，
  //   杜绝 malformed prompt variable reference / unknown prompt variable 报错。
  s = s.replace(/\{\{([^{}]*)\}\}/g, (all, inner) => {
    const name = String(inner).trim()
    if (name === 'provider' || name === 'model' || name === 'cwd') return all
    return ''
  })
  // ★ DSH 兼容：剥离"要求 AI 输出可见 thinking / HTML 注释"的指令
  //   （这些是为支持原生隐藏思考通道的模型（Claude 等）设计的；
  //   DSH 上 deepseek 系模型会把 <thinking>/<!-- --> 当正文原样输出。）
  s = s.replace(/<thinking_rules>[\s\S]*?<\/thinking_rules>/g, '')
  s = s.replace(/<output_lock>[\s\S]*?<\/output_lock>/g, '')
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
  s = s.replace(/<comment>[\s\S]*?<\/comment>/g, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<\/?thinking_rules>/gi, '')
  s = s.replace(/<\/?output_lock>/gi, '')
  s = s.replace(/<\/?thinking>/gi, '')
  s = s.replace(/<\/?Think>/gi, '')
  // COT 容器标签（内容保留，标签剥离——deepseek 不会把 <cot> 当隐藏思考）
  s = s.replace(/<\/?cot>/gi, '')
  // Prism：剥离"每段前输出 HTML 注释"指令与"总结<Prism>内要求"引用
  s = s.replace(/<Prism_tips>[\s\S]*?<\/Prism_tips>/gi, '')
  s = s.replace(/<Prism>[\s\S]*?<\/Prism>/gi, '')
  s = s.replace(/总结\s*<Prism>\s*内的所有要求[！!]?（?一个要求都不能少）?/gi, '总结所有写作要求，一个都不能少')
  s = s.replace(/明确\s*<Prism>\s*的输出格式，并在正文中体现\(如若无要求则无需在意\)/gi, '明确上述要求的输出格式，并在正文中体现')
  s = s.replace(/\$\{?总结<Prism>内的所有要求！一个要求都不能少\}?/gi, '总结所有写作要求，一个都不能少')
  s = s.replace(/<Prism>/gi, '')
  s = s.replace(/<\/Prism>/gi, '')
  s = s.replace(/Prism/gi, '写作要求')
  // ★ 剥离"要求 AI 先打草稿/输出规划再写正文"的指令（deepseek 会把草稿/思考当正文输出）
  //   常见形态：draft once / 打草稿 / 以HTML注释形式插入草稿 / At the START of every reply output this block
  s = s.replace(/Draft once[^.\n]{0,60}/gi, '')
  s = s.replace(/All draft work inside <content> as HTML comments\.?\s*/gi, '')
  s = s.replace(/At the START of every reply[^.\n]{0,80}/gi, '')
  s = s.replace(/打草稿[:：][^。\n]{0,60}/gi, '')
  s = s.replace(/以html注释的形式插入在输出内容中[^。\n]{0,40}/gi, '')
  s = s.replace(/先.?打草稿[^。\n]{0,40}/gi, '')
  // ★ 剥离"思考链缝合"指令（世界书/预设里要求 AI 逐步输出思考的内容）
  s = s.replace(/不要偷懒，你需要依次执行下述行动[^。\n]{0,40}/gi, '')
  s = s.replace(/【❗需要缝合进预设思维链的内容】/gi, '')
  s = s.replace(/每个步骤思考总字数小于\d+字禁止进行下一轮思考[^。\n]{0,40}/gi, '')
  s = s.replace(/禁止进行下一轮思考[^。\n]{0,30}/gi, '')
  s = s.replace(/贝叶斯推演与元素构建[^。\n]{0,40}/gi, '')
  s = s.replace(/内容输出规划[:：][^。\n]{0,40}/gi, '')
  s = s.replace(/5\. 内容输出规划[^\n]*/gi, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

function cardTextFor(presetId) {
  const state = readState()
  if (state.cardEnabled === false) return ''
  const dir = getPresetDir(presetId)
  if (!dir) return ''
  try {
    const parts = []
    // 角色名（ST 宏 {{char}} 的求值来源）：取第一张启用角色卡的名字
    let charName = ''
    // 1. 从 agent.cordis.yml 提取角色卡文本
    const ymlPath = path.join(dir, 'agent.cordis.yml')
    if (fs.existsSync(ymlPath)) {
      const cardText = extractCardText(fs.readFileSync(ymlPath, 'utf8'))
      if (cardText) parts.push(cardText)
    }
    // 2. 读取 characters.json（角色卡列表）
    const charsPath = path.join(dir, 'characters.json')
    if (fs.existsSync(charsPath)) {
      try {
        const chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'))
        if (Array.isArray(chars) && chars.length) {
          const charBlocks = []
          for (const c of chars) {
            if (c.enabled === false) continue
            if (!charName && c.name) charName = String(c.name).trim()
            let charText = ''
            if (c.desc) charText += c.desc + '\n'
            if (c.first) charText += c.first + '\n'
            if (c.text) charText += c.text + '\n'
            if (c.content) charText += c.content + '\n'
            if (charText.trim()) charBlocks.push('# 角色卡：' + (c.name || '未命名') + '\n' + charText.trim())
          }
          if (charBlocks.length) parts.push(charBlocks.join('\n\n---\n\n'))
        }
      } catch {}
    }
    // 3. 读取 presets.json（预设模块/词条）
    const presetsPath = path.join(dir, 'presets.json')
    if (fs.existsSync(presetsPath)) {
      try {
        const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'))
        if (Array.isArray(presets)) {
          const allMods = []
          for (const p of presets) {
            if (!p || !Array.isArray(p.modules)) continue
            for (const mod of p.modules) {
              if (!mod || mod.enabled === false) continue
              const content = String(mod.content || '').trim()
              if (content) allMods.push({ name: mod.name || '未命名', content: content })
            }
          }
          if (allMods.length) {
            // 破限关键词：把包含这些关键词的模块放在最前面
            const breakLimitKeywords = ['破限', '淫趴', 'NSFW', '成人', '无限制', '无审查', '无道德', '无伦理', '露骨', '色情', '黄文', 'R18', '禁词', '抗审查', '解除限制', '完全授权']
            const breakLimitMods = []
            const otherMods = []
            for (const mod of allMods) {
              // ★ 只按模块名判破限（旧逻辑连内容一起匹配：普通模块正文里出现
              //   「无限制」一类词就被提到最前，会打乱 setvar/getvar 的装配顺序，
              //   后置 getvar 变量在 setvar 之前求值为空）。
              const isBreakLimit = breakLimitKeywords.some(kw => mod.name.includes(kw))
              if (isBreakLimit) breakLimitMods.push(mod)
              else otherMods.push(mod)
            }
            const sortedMods = breakLimitMods.concat(otherMods)
            const modBlocks = sortedMods.map(mod => '# 预设模块：' + mod.name + '\n' + mod.content)
            parts.push('# 预设词条（破限优先）\n' + modBlocks.join('\n\n---\n\n'))
          }
        }
      } catch {}
    }
    // 4. 世界书不在此注入（由 section 里的智能注入逻辑处理，避免重复）
    // 合并所有部分
    let text = parts.join('\n\n').trim()
    if (text.length > CARD_MAX) text = text.slice(0, CARD_MAX) + '\n\n（卡片过长，已截断至前 ' + CARD_MAX + ' 字）'
    // ★ 替换 SillyTavern 变量（含 setvar/getvar 装配线展开），避免 DSH 提示变量系统报错 ★
    text = sanitizePromptText(text, charName)
    return text
  } catch (e) {
    try { fs.writeFileSync(path.join(ROOT, 'inject-error.log'), '[' + new Date().toISOString() + '] cardTextFor error: ' + e.message + '\n' + e.stack + '\n', { flag: 'a' }) } catch {}
    return ''
  }
}

// ── 角色卡开场白 ────────────────────────────────────────
//
// 为什么需要这段：
//   `cardTextFor()` 返回的整包文本**只进系统提示**（见 taps 里 tavern:card 段），
//   而美化引擎（dsh-muv-engine / dsh-muv-client）只处理**消息**：它的取样口是
//   `[class*="_markdown_"]`（正文容器），系统提示那一行是折叠的 SystemPromptRow，
//   既不匹配、默认也收起。于是卡片里那条「[0] 主页」正则（粉蓝封面页 / 进入事务所 /
//   NOW ON AIR）在 DSH 上永远命中不了 —— ST 里能看到封面页，是因为 ST 把 `first_mes`
//   当**第一条消息**发下去。
//
// ★★ 2026-10-04：**「新会话自动播种开场白」整套机制已删除（v2.5.4），不要再加回来。**
//   它会在新会话第一轮就把开场白写成 `assistant/message`，排在真正的 `system/message`
//   之前；而会话日志（v4）要求受保护 head 只能由「**还没有任何 surface 事件时出现的
//   system/message**」建立，于是该会话第一次写 system/message 就抛
//     `SessionFormatError: system/message requires a protected first surface head`
//   ⇒ **会话永久打不开**（真实事故：**5 个会话**被写坏，只能删掉日志里那条抢跑消息才救回来；
//   会话 id 属本机数据，此处不列出）。
//   旧设计里的注释"网关实测接受 assistant 打头"讲的是**模型网关**（那一层确实接受
//   deepseek-official / bailian），与会话日志层无关 —— 两层规则被混为一谈，才出的这次事故。
//   完整规则与判据见 `canAppendGreetingSurface()` 的注释。
//
//   开场白现在只有**一条合法路径**：对**已经跑过回合**（日志里已有 system/message）的会话，
//   由用户点面板「📌 开场白 → 注入开场白到会话末尾」触发
//   （POST /api/tavern/greeting/insert → appendGreetingToSessionEnd，受同一道闸门保护）。
//   新会话不再自动出现开场白，需要自己发一句话起头。

/** 预设目录下 characters.json 里，开场白字段可能出现的名字（ST 用 first_mes）。 */
const GREETING_FIELDS = ['first', 'first_mes', 'firstMessage', 'greeting']

/**
 * surface 事件类型（与 DSH 网关的 `SURFACE_TYPES` 一致）。
 * 只有这些类型参与「受保护的首个 surface head」判定；turn/step 等普通事件不参与。
 */
const GREETING_SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

/**
 * 现在还能往这个会话的日志里 append surface 事件吗？
 *
 * ★ 为什么必须有这道闸（2026-10-04 真实事故，5 个会话被写坏）：
 *   DSH 加载 v4 日志时按顺序维护两条状态 ——
 *     `hasSurface`（出现过任一 surface 事件）与 `head`（**只有**在还没有任何 surface 事件时
 *     出现的 `system/message` 才会被登记为受保护 head）。
 *   于是「先写了一条 assistant/user 消息、之后才出现 system/message」的日志会直接抛
 *     `SessionFormatError: system/message requires a protected first surface head`
 *   （实现在 DSH 的 `app.asar` 里 `restoreReleasedV3Artifact` 与 v4 relationships
 *    两处，各有一份），**该会话从此永久打不开**，只能删掉那条抢跑消息。
 *
 *   本插件过去正是这么干的：`seedGreetingMessage()` 在新会话第一轮就把角色卡开场白写成
 *   `assistant/message`，排在真正的 `system/message` 之前。旧注释里那句"网关实测接受
 *   assistant 打头"讲的是**模型网关**（那一层确实接受），而**会话日志层**从来不允许 ——
 *   两层规则被混为一谈了。已确认有 **5 个会话**因此打不开（会话 id 属本机数据，此处不列出）。
 *
 * 判据（三处写入点共用同一条）：
 *   · 日志里还没有任何 surface 事件      → false：现在写就抢在 system/message 前面 ⇒ 弄坏日志
 *   · 首个 surface 事件是 system/message → true ：head 已建立，可以安全追加
 *   · 首个 surface 事件是别的类型        → false：日志已经坏了，别再动它
 *
 * @param {object} session DSH Session
 * @returns {boolean} 是否允许追加 surface 事件
 */
function canAppendGreetingSurface(session) {
  if (!session || !Array.isArray(session.log)) return false
  for (const event of session.log) {
    if (!event || !GREETING_SURFACE_TYPES.has(event.type)) continue
    return event.type === 'system/message'
  }
  return false
}

/**
 * 读预设目录里第一张启用卡的开场白原文。
 * `first_mes` 里可能残留 ST 变量（如 `{{char}}`），但与系统提示那份**共用同一条**清洗
 * 链路（sanitizePromptText），那边已经把它们抹平了；注进消息面的必须是原文，
 * 因为卡里的「[0] 主页」正则要按原文匹配 `<VariableInsert>` 结构。
 * @param {string} presetId
 * @returns {string} 开场白原文；没有则空串
 */
function greetingTextFor(presetId) {
  try {
    const dir = getPresetDir(presetId)
    if (!dir) return ''
    const charsPath = path.join(dir, 'characters.json')
    if (!fs.existsSync(charsPath)) return ''
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'))
    if (!Array.isArray(chars)) return ''
    for (const c of chars) {
      if (!c || c.enabled === false) continue
      for (const field of GREETING_FIELDS) {
        const value = c[field]
        if (typeof value === 'string' && value.trim()) return value
      }
    }
  } catch {}
  return ''
}

/**
 * 会话日志里是否已经有「角色卡开场白」这条楼（手动注入防重复用）。
 *
 * ★ 判据是 `source.model === 'character-card'`（手动注入 appendGreetingToSessionEnd
 *   打的标记），**不比文本**：
 *   开场白原文里带 ST 占位符，卡正则会把占位符按当前变量替换掉，同一张卡不同轮、
 *   不同卡之间的落盘文本都不一样 —— 按文本比较必然漏判。用户截图里示例会话出现
 *   多条【主页】开场白，就是「没有判重 + 注入按钮被点了多次」叠加出来的。
 *
 * @param {object} session
 * @returns {boolean}
 */
function hasCardGreeting(session) {
  try {
    const log = session && session.log
    if (!Array.isArray(log)) return false
    for (const event of log) {
      if (!event || event.type !== 'assistant/message') continue
      const source = event.data && event.data.message && event.data.message.source
      if (source && source.model === 'character-card') return true
    }
  } catch {}
  return false
}

/**
 * 记录一次开场白相关操作，便于排障（不影响主流程）。
 *
 * ★ 2026-10-04：自动播种机制已删除，这个日志现在只有两处会写 ——
 *   **手动注入**（POST /api/tavern/greeting/insert）与监听装配失败。
 *   文件名沿用 `greeting-seed.log` 是为了不打断历史排查习惯（旧行还留在那儿）。
 */
function noteGreetingLog(presetId, text, ok, detail) {
  try {
    fs.writeFileSync(path.join(ROOT, 'greeting-seed.log'),
      '[' + new Date().toISOString() + '] presetId=' + presetId
      + ' len=' + (text ? text.length : 0) + ' ok=' + ok
      + (detail ? ' ' + detail : '') + '\n', { flag: 'a' })
  } catch {}
}

/**
 * 安装「活会话登记」监听（apply() 时调用一次）。
 *
 * 为什么需要它：手动注入开场白的 API（POST /api/tavern/greeting/insert）要按 sessionId 找到
 * 活着的 Agent，而 `agent/created` 是官方在「agent + live session 发布」时**同步**触发的事件
 * （早于任何用户消息，**空白新会话同样成立**）。`agent/inbox/inserted` 只是兜底：
 * 覆盖「插件加载之前就已经存在」的会话。同步监听一旦抛错会否决 agent 发布，故全程 try/catch。
 *
 * ★ 2026-10-04：这个监听**曾经**顺带做「新会话自动播种开场白」。那个功能会把会话日志写坏到
 *   永久打不开，整套播种机制已删除（见文件上方「── 角色卡开场白 ──」那段注释与
 *   `canAppendGreetingSurface()`）。现在只剩登记，开场白改由用户点面板按钮触发。
 *
 * @param {object} ctx cordis 上下文
 * @returns {Function} 卸载函数
 */
function armLiveAgents(ctx) {
  const disposes = []
  try {
    disposes.push(ctx.on('agent/created', ({ agent }) => {
      try { if (agent && agent.session) trackLiveSession(agent) } catch {}
    }, { global: true }))
  } catch (e) {
    try { noteGreetingLog('', '', false, 'arm-failed(agent/created): ' + e.message) } catch {}
  }
  try {
    disposes.push(ctx.on('agent/inbox/inserted', ({ agent }) => {
      try { if (agent && agent.session) trackLiveSession(agent) } catch {}
    }, { global: true }))
  } catch (e) {
    try { noteGreetingLog('', '', false, 'arm-failed(agent/inbox/inserted): ' + e.message) } catch {}
  }
  return () => { for (const d of disposes) { try { d() } catch {} } }
}

/**
 * 从预设目录的 characters.json 里挑一张卡的开场白（手动注入 API 用）。
 *
 * @param {string} presetId 预设 id
 * @param {string} [cardName] 指定卡名；不传 = 启用中的第一张卡
 * @returns {{ ok: true, name: string, greeting: string } | { ok: false, error: string }}
 */
function pickGreetingCard(presetId, cardName) {
  try {
    const dir = getPresetDir(presetId)
    if (!dir) return { ok: false, error: 'preset-not-found：预设目录不存在（presetId=' + presetId + '）' }
    const charsPath = path.join(dir, 'characters.json')
    if (!fs.existsSync(charsPath)) return { ok: false, error: 'no-characters：预设目录里没有 characters.json（presetId=' + presetId + '）' }
    const chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'))
    if (!Array.isArray(chars) || chars.length === 0) return { ok: false, error: 'no-characters：characters.json 为空' }
    const enabled = chars.filter(c => c && c.enabled !== false)
    if (enabled.length === 0) return { ok: false, error: 'no-enabled-card：没有启用中的角色卡' }
    const wanted = cardName ? enabled.find(c => String(c.name || '') === String(cardName)) : enabled[0]
    if (!wanted) return { ok: false, error: 'card-not-found：启用中的卡里没有 name=' + cardName }
    for (const field of GREETING_FIELDS) {
      const v = wanted[field]
      if (typeof v === 'string' && v.trim()) {
        const label = wanted.name || wanted.fileName || wanted.id || ('card#' + (chars.indexOf(wanted) + 1))
        return { ok: true, name: String(label), greeting: v }
      }
    }
    return { ok: false, error: 'no-greeting：这张卡（' + String(wanted.name || '') + '）没有任何开场白字段（' + GREETING_FIELDS.join('/') + '）' }
  } catch (e) {
    return { ok: false, error: 'read-error：' + e.message }
  }
}

/**
 * 把开场白追加到**会话末尾**（手动注入 API 用；旧会话 log 非空也能用）。
 *
 * 事件序列自己闭合成一个完整回合（turn/start → step/start → assistant/message →
 * step/end → turn/end），回合号取「日志里最大已用回合 + 1」，
 * 且不做任何「新会话」判定 —— 它本来就是给旧会话的补救入口。
 *
 * @param {object} session DSH Session
 * @param {string} text 开场白原文
 * @returns {number} 新开的回合号
 */
function appendGreetingToSessionEnd(session, text) {
  if (!session || typeof session.append !== 'function' || !text) throw new Error('session 不可用或开场白为空')
  if (!Array.isArray(session.log)) throw new Error('会话日志不可读')
  // ★ 同一条闸（2026-10-04 事故）：手动注入也会写 assistant/message。如果这个会话还没跑过任何
  //   回合，它的日志里没有 system/message，注入就会抢在它前面把日志写坏到永久打不开。
  //   这个入口本来是为"旧会话补救"设计的，正常场景下日志里一定有 system/message。
  if (!canAppendGreetingSurface(session)) {
    throw new Error('这个会话还没跑过任何回合（日志里没有 system/message）：此时注入会抢在它前面、'
      + '把会话日志写坏到永久打不开。请先发一句话起头，再注入开场白。')
  }
  let open = false
  let maxTurn = 0
  for (const event of session.log) {
    if (!event) continue
    if (event.type === 'turn/start') {
      open = true
      if (Number.isFinite(event.data && event.data.turn)) maxTurn = Math.max(maxTurn, event.data.turn)
    } else if (event.type === 'turn/end') {
      open = false
    }
  }
  if (open) throw new Error('会话正在生成中（有未闭合的回合），等本轮结束后再注入')
  const turn = maxTurn + 1
  const messageId = randomUUID()
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    // ★ settlement 字段必须给全：DSH 读会话时按 `dsh-session` 的
    //   `assertAssistantSettlementShape` 校验每条 assistant/message —— 要求 turn/step 是
    //   非负安全整数**且 data.stream 是数组**。缺 stream ⇒ 该会话整个打不开
    //   （2026-09-23 真事故：有一条会话被写坏）。usage 不是校验必需，但与真实模型楼同形。
    //   否则 DSH 读会话时报 corrupt（见该处长注释）。
    stream: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    message: {
      id: messageId,
      role: 'assistant',
      source: { kind: 'model', provider: 'tavern', model: 'character-card' },
      content: [{ type: 'text', text }],
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return turn
}

/**
 * 手动注入开场白的完整决策（`POST /api/tavern/greeting/insert` 与测试共用这一段）。
 *
 * ★ 防重复（2026-09-23）：会话 log 里只要已有一条 `source.model === 'character-card'`
 *   的 assistant 楼（自动播种种的、或上一次手动注入的，两种来源打同一个标记），
 *   就直接拒绝，返回 `error: 'greeting-already-present'`。用户截图里示例会话出现
 *   多条【主页】开场白，就是这个按钮被点了多次叠加出来的。
 *   判据按 source.model，不比文本 —— 占位符会变，比文本必然漏判（见 hasCardGreeting）。
 *
 * @param {object} session DSH Session
 * @param {string} presetId 预设 id
 * @param {string} [cardName] 指定卡名
 * @returns {{ ok: true, turn: number, cardName: string, greetingLen: number }
 *          | { ok: false, error: string }}
 */
function insertGreetingForSession(session, presetId, cardName) {
  if (!session) return { ok: false, error: 'no-session：会话对象不可用' }
  if (hasCardGreeting(session)) return { ok: false, error: 'greeting-already-present' }
  const picked = pickGreetingCard(presetId, cardName)
  if (!picked.ok) return { ok: false, error: picked.error }
  let turn
  try {
    turn = appendGreetingToSessionEnd(session, picked.greeting)
  } catch (e) {
    return { ok: false, error: 'append-failed：' + e.message }
  }
  return { ok: true, turn, cardName: picked.name, greetingLen: picked.greeting.length }
}

// ── 角色卡文本提取 ────────────────────────────────────────

// ── 世界书（结构化 + 关键词触发） ─────────────────────────
function worldbookFile(presetId) {
  const dir = getPresetDir(presetId)
  if (!dir) return null
  // 同时支持 worldbooks.json（复数，酒馆标准格式）和 worldbook.json（单数）
  const plural = path.join(dir, 'worldbooks.json')
  const singular = path.join(dir, 'worldbook.json')
  if (fs.existsSync(plural)) return plural
  return singular
}
/* 旧版世界书读写（保留仅供查看，已由下方 v2 统一实现替代）

function readWorldbookLegacy(presetId) {
  const f = worldbookFile(presetId)
  if (!f || !fs.existsSync(f)) return { entries: [], injectMode: 'full', groups: [] }
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    // 支持两种格式：{entries: [...]} 和 [{name, entries: [...]}]
    if (Array.isArray(d)) {
      // 数组格式（酒馆标准），合并所有世界书的启用条目，同时保留分组信息
      const allEntries = []
      const groups = []
      for (const wb of d) {
        if (wb && Array.isArray(wb.entries)) {
          const groupEntries = []
          for (const e of wb.entries) {
            if (e && e.enabled !== false) {
              allEntries.push(e)
              groupEntries.push(e)
            }
          }
          groups.push({ name: wb.name || '未命名世界书', entries: groupEntries, enabled: wb.enabled !== false })
        }
      }
      return { entries: allEntries, injectMode: 'full', groups: groups }
    }
    if (!d || !Array.isArray(d.entries)) return { entries: [], injectMode: 'full', groups: [] }
    // 对象格式：如果有 groups 字段就用，否则创建默认分组
    const groups = Array.isArray(d.groups) && d.groups.length
      ? d.groups
      : [{ name: '默认世界书', entries: d.entries, enabled: true }]
    return { entries: d.entries, injectMode: d.injectMode || 'full', groups: groups }
  } catch { return { entries: [], injectMode: 'full', groups: [] } }
}
function writeWorldbookLegacy(presetId, data) {
  const f = worldbookFile(presetId)
  if (!f) throw new Error('预设不存在')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
}
*/

// ── 世界书统一格式（v2）────────────────────────────────
// 唯一持久化结构：
// {
//   "version": 2,
//   "injectMode": "full" | "keyword",
//   "groups": [
//     { "name": "世界书名", "enabled": true, "entries": [ ... ] }
//   ]
// }
// readWorldbook / writeWorldbook / readPresetFiles / /api/tavern/worldbook 全部走这里。
/**
 * 旧数组格式里各本书可能自带 `injectMode`（手工编辑过、或早期版本/别的工具写的）。
 * 一律硬编码 'full' 会**悄悄丢掉用户的设置** —— 实测：手写 {"injectMode":"keyword"} 的
 * 数组文件被迁移成 v2 之后就变成全量注入了（用户会以为"按需注入坏了"）。
 * 规则：显式声明且**一致**才采用；分歧或没声明都保守用 'full'（多注入 > 漏设定）。
 */

function readWorldbook(presetId) {
  const f = worldbookFile(presetId)
  if (!f || !fs.existsSync(f)) return { entries: [], injectMode: 'full', groups: [] }
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!d || d.version !== 2) writeWorldbook(presetId, d)
      return worldbookToApi(normalizeWorldbookData(d))
  } catch {
    return { entries: [], injectMode: 'full', groups: [] }
  }
}

function writeWorldbook(presetId, data) {
  const dir = getPresetDir(presetId)
  if (!dir) throw new Error('预设不存在')
  fs.mkdirSync(dir, { recursive: true })
  const norm = normalizeWorldbookData(data)
  const unified = {
    version: 2,
    injectMode: norm.injectMode || 'full',
    groups: norm.groups || []
  }
  // 统一只写 worldbooks.json，并清理旧 worldbook.json
  const plural = path.join(dir, 'worldbooks.json')
  const singular = path.join(dir, 'worldbook.json')
  fs.writeFileSync(plural, JSON.stringify(unified, null, 2), 'utf8')
  try { if (fs.existsSync(singular)) fs.unlinkSync(singular) } catch {}
}

// ── 预设描述重建（单一事实来源：从磁盘真实文件生成，不信任请求体/localStorage） ──
function buildPresetDescriptionFromDisk(dir) {
  const chars = []
  let wbCount = 0, wbEntries = 0, modCount = 0
  try {
    const cj = path.join(dir, 'characters.json')
    if (fs.existsSync(cj)) {
      const arr = JSON.parse(fs.readFileSync(cj, 'utf8'))
      if (Array.isArray(arr)) arr.forEach(c => { if (c && c.name) chars.push(c.name) })
    }
  } catch {}
  try {
    const wj = path.join(dir, 'worldbooks.json')
    if (fs.existsSync(wj)) {
      const wb = JSON.parse(fs.readFileSync(wj, 'utf8'))
      if (Array.isArray(wb)) {
        wb.forEach(b => { wbCount++; wbEntries += ((b && b.entries) || []).length })
      } else if (wb && Array.isArray(wb.groups)) {
        wb.groups.forEach(g => { wbCount++; wbEntries += ((g && g.entries) || []).length })
      } else if (wb && Array.isArray(wb.entries)) {
        wbCount = 1; wbEntries = wb.entries.length
      }
    }
  } catch {}
  try {
    const pj = path.join(dir, 'presets.json')
    if (fs.existsSync(pj)) {
      const p = JSON.parse(fs.readFileSync(pj, 'utf8'))
      if (Array.isArray(p)) modCount = p.length
      else if (p && Array.isArray(p.presets)) modCount = p.presets.length
    }
  } catch {}
  const names = chars.length ? chars.join('、') : ''
  return `🎭 ${names || '无角色卡'} | 📚 ${wbCount}本世界书（${wbEntries}条）| ⚙️ ${modCount}个预设模块 | 最后更新: ${new Date().toLocaleString('zh-CN')}`
}

// 遍历注册表：目录丢失的条目移除；描述与磁盘不一致的条目重建
function rebuildAllPresetDescriptions() {
  try {
    const meta = readPresetsMeta()
    if (!Array.isArray(meta.presets) || !meta.presets.length) return
    let changed = false
    const kept = []
    for (const p of meta.presets) {
      const dir = path.join(ROOT, p.dir || p.id || '')
      if (!fs.existsSync(dir)) { changed = true; continue } // 目录丢失 → 从注册表移除
      if (!p.dir) { p.dir = p.id; changed = true }
      const desc = buildPresetDescriptionFromDisk(dir)
      if (p.description !== desc) { p.description = desc; changed = true }
      p.mode = p.mode || 'roleplay'
      kept.push(p)
    }
    if (kept.length !== meta.presets.length) changed = true
    meta.presets = kept
    if (changed) writePresetsMeta(meta)
  } catch {}
}

function buildWorldbookText(entries) {
  if (!entries.length) return ''
  const hasFormat = entries.some(e => e.content && /<(Drama|style|details|choices|div\s)/i.test(e.content))
  const parts = ['【酒馆世界书 — 当前预设直接注入】']
  if (hasFormat) {
    parts.push('\n⚠️ 格式说明：以下世界书条目包含 HTML 格式标签（如 <Drama> <details> <choices> <div> 等）。这些是格式模板，不是要你原样输出的内容。请按模板格式填充你的回复内容，但不要输出 <style> 标签和空的模板容器。')
  }
  for (const e of entries) {
    parts.push(`\n## ${e.name || '未命名条目'}`)
    if (e.keywords && e.keywords.length) parts.push(`触发词：${e.keywords.join(', ')}`)
    parts.push(sanitizePromptText(e.content || ''))
  }
  return parts.join('\n')
}

// ── 全局状态 ──────────────────────────────────────────────
// ★ activePresetIdx（预设选中光标）合法化：只接受非负整数；非法值返回 null（调用方忽略，不写入）。
//   它只持久化「选中了第几组」，绝不触碰 presets 内容本身（那走 /api/tavern/save 的既有路径）。
function normalizeActivePresetIdx(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (s && typeof s === 'object') {
      if (!Array.isArray(s.disabledCwds)) s.disabledCwds = []
      if (!Array.isArray(s.allowCwds)) s.allowCwds = []
      if (!Array.isArray(s.allowSessions)) s.allowSessions = []
      if (!s.cwdPresets || typeof s.cwdPresets !== 'object') s.cwdPresets = {}
      // ★ 发布版出厂默认 global：只影响「没有 state 文件 / mode 字段非法」的新用户；
      //   显式配置过 mode（如 'allowlist'）的存量用户不受影响（这里只在字段非法时兜底）。
      //   理由：注入资格由**显式绑定闸门**保证（自动绑定已删、creation 通道不注入），
      //   global 只是「绑了就生效」，不会让没绑定的会话吃到卡；allowlist 出厂只会让
      //   新用户面对「空白名单 = 什么都不生效」的懵圈状态（傻瓜式生效范围面板引导开启）。
      if (s.mode !== 'global' && s.mode !== 'allowlist') s.mode = 'global'
      if (!s.mem || typeof s.mem !== 'object') s.mem = {}
      const m = s.mem
      if (typeof m.apiUrl !== 'string') m.apiUrl = ''
      if (typeof m.apiKey !== 'string') m.apiKey = ''
      if (typeof m.model !== 'string' || !m.model) m.model = 'deepseek-chat'
      if (typeof m.autoEnabled !== 'boolean') m.autoEnabled = false
      if (typeof m.autoEvery !== 'number' || !Number.isFinite(m.autoEvery) || m.autoEvery < 1) m.autoEvery = 20
      if (typeof m.lastSeq !== 'number' || !Number.isFinite(m.lastSeq)) m.lastSeq = 0
      if (typeof m.useDsh !== 'boolean') m.useDsh = false
      if (typeof m.dshConnection !== 'string') m.dshConnection = ''
      if (typeof m.dshModel !== 'string') m.dshModel = ''
      if (typeof s.antiCliche !== 'boolean') s.antiCliche = true
      if (!Array.isArray(s.bannedWords)) s.bannedWords = []
      // ★ P2-1 世界书注入逃生阀：'follow'（默认）= 跟随卡里的 injectMode；
      //   'full' = 无视卡设定强制全量（用户发现按需注入漏了设定时的一键后悔药）。
      //   只认这两个值，其余一律归 'follow'（保守兜底）。
      if (s.wbInject !== 'full' && s.wbInject !== 'follow') s.wbInject = 'follow'
      // ★ 会话级覆盖：{ <sessionId>: 'full' | 'follow' }。用途：某一场（例如要写高强度剧情）
      //   想确保模型**一定看得到全部设定**就切 'full'；平时切回 'follow' 省 token。
      //   空值/非法值一律清掉（避免脏数据把判定带偏）。
      if (!s.wbInjectBySession || typeof s.wbInjectBySession !== 'object' || Array.isArray(s.wbInjectBySession)) {
        s.wbInjectBySession = {}
      } else {
        const clean = {}
        for (const [k, v] of Object.entries(s.wbInjectBySession)) {
          if (k && (v === 'full' || v === 'follow')) clean[k] = v
        }
        s.wbInjectBySession = clean
      }
      if (typeof s.networkEnabled !== 'boolean') s.networkEnabled = false
      // ★ 关系网「软注入」开关：默认**开**（只给一行存在性提示，不给内容）——
      //   用户要的是"提醒模型有这么个东西，但不影响剧情"。false 才完全不注入。
      if (typeof s.relationsHint !== 'boolean') s.relationsHint = true
      // ★ 技能（Skill）：保存预设时自动生成一个 DSH skill（默认开）；会话装配时给一行
      //   "可用 skill" 指针（默认开）；可选把启用中的世界书正文也写进 skill（默认关）。
      //   skillsDir 留空 = 用 <DSH_HOME>/skills（DSH 用户级 skill 根）。都是可关的。
      if (typeof s.skillAutoGenerate !== 'boolean') s.skillAutoGenerate = true
      if (typeof s.skillAutoFull !== 'boolean') s.skillAutoFull = false
      if (typeof s.skillHint !== 'boolean') s.skillHint = true
      // 技能形态：'instructions'（默认，把启用中的写作要求写成**指令**，用 /技能名 触发时
      // 宿主注入到这一步最末尾 ⇒ 最容易被照做）/ 'index'（只给设定索引，省 token）。
      if (s.skillStyle !== 'index' && s.skillStyle !== 'instructions') s.skillStyle = 'instructions'
      if (typeof s.skillsDir !== 'string') s.skillsDir = ''
      // 上下文窗口（token）：用于面板上算「本插件注入占了窗口多少」
      if (typeof s.promptWindowTokens !== 'number' || !Number.isFinite(s.promptWindowTokens) || s.promptWindowTokens < 1024) {
        s.promptWindowTokens = DEFAULT_WINDOW_TOKENS
      }
      // ★ 预设声明（把酒馆预设变成 DSH 原生 agent 预设）的开关：**默认 off**。
      //   off = 一个字节都不碰用户配置（这是出厂姿态）；patch = 维护 profile 补丁层里的受管块；
      //   bundle = 生成 DSH bundle 交 plugin_manager 安装。只认这三个值。
      if (!s.presetDeclarations || typeof s.presetDeclarations !== 'object') s.presetDeclarations = { mode: 'off' }
      if (s.presetDeclarations.mode !== 'patch' && s.presetDeclarations.mode !== 'bundle') s.presetDeclarations.mode = 'off'
      return s
    }
  } catch {}
  // ★ 发布版出厂默认 global（与上方 readState 归一化一致）：注入资格由显式绑定闸门保证，
  //   global 只是「绑了就生效」，没绑定的会话依旧不吃卡；只影响无 state 文件的新用户。
  return { cardEnabled: true, toolsEnabled: false, disabledCwds: [], allowCwds: [], allowSessions: [], cwdPresets: {}, mode: 'global', nsfwEnabled: false, nsfwPrompt: '', plotOptions: true, playerName: '', promptWindowTokens: DEFAULT_WINDOW_TOKENS, presetDeclarations: { mode: 'off' }, relationsHint: true, skillAutoGenerate: true, skillAutoFull: false, skillHint: true, skillStyle: 'instructions', skillsDir: '', mem: { apiUrl: '', apiKey: '', model: 'deepseek-chat', autoEnabled: false, autoEvery: 20, lastSeq: 0, useDsh: false, dshConnection: '', dshModel: '' } }
}

// ── 提示词体积估算 ────────────────────────────────────────
// 背景：世界书「全量注入」会把整本条目写进系统提示，实测能到 13.8 万字符/轮，
// 占掉上下文窗口的大头，尾巴上的段落（破限块、DSH 原生段）最先被截断。
// 这里把「每轮实际注入了多少」量出来给面板看，并给出告警等级。

/** 本轮各注入段的字符数，由各段的 text() 在返回前回填 */
const sectionSizes = { card: 0, wb: 0, nsfw: 0 }

/**
 * 把本轮体积快照写到 ROOT/prompt-stats.json。
 * 节流 2 秒：同一轮可能多次组装（正文 + 子 Agent），不必反复写盘。
 */
function flushPromptStats() {
  const now = Date.now()
  if (now - S.promptStatsFlushedAt < 2000) return
  S.promptStatsFlushedAt = now
  try {
    ensureRoot()
    fs.writeFileSync(path.join(ROOT, 'prompt-stats.json'), JSON.stringify({
      at: new Date().toISOString(),
      sessionId: lastSessionId,
      card: sectionSizes.card,
      wb: sectionSizes.wb,
      nsfw: sectionSizes.nsfw,
      total: sectionSizes.card + sectionSizes.nsfw,
    }, null, 2), 'utf8')
  } catch {}
}

/** 读取上一轮体积快照，失败返回 null。 */
function readPromptStats() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-stats.json'), 'utf8'))
    return s && typeof s === 'object' ? s : null
  } catch { return null }
}

// ── DSH 已保存的 API 连接（settings.yaml 的 llm-pi-ai.providers + credentials 文件） ──
// DSH_HOME / DSH_SETTINGS_FILE / DSH_CREDENTIALS_FILE 见文件顶部，
// 由 bindDshPaths() 在 apply() 时按 DSH 实际 home 绑定。

// SESSIONS_ROOT 见文件顶部，由 bindDshPaths() 在 apply() 时按 DSH 实际 home 绑定。

function findSessionFile(sessionId) {
  if (!sessionId) return null
  // ★ id 前缀归一化（2026-09 修，实测 **189/260** 个会话因此查不到权威预设）：
  //
  //   `getCurrentSessionId()`（客户端）与 `session-bindings.json` 用的都是
  //   **`session-<uuid>`**；而 DSH 的会话日志目录**大多数是裸 `<uuid>`**
  //   （实测：裸 189 个 / 带 `session-` 前缀 71 个）。
  //
  //   原来只有 `sd.name === sessionId || sd.name.includes(sessionId)`：
  //     - 传 `session-<uuid>`、目录名是裸 `<uuid>` ⇒ `===` 不中；
  //       而 `'<uuid>'.includes('session-<uuid>')` **也不中**（方向反了）⇒ 查不到。
  //     ⇒ `resolveAuthoritativePresetId()` 静默退回 bindings（大多数会话没有记录）
  //       ⇒ 返回 `default` ⇒ **权威解析对 73% 的会话事实上失效**。
  //       线上实测：`?sessionId=session-<uuid>` 返回 `default`，
  //       而 `?sessionId=<uuid>`（裸）正确返回该会话实际绑定的预设。
  //
  //   修法：候选键**同时包含两种形式**，任一命中即可（两种形式都试，不再有方向性）。
  try {
    const dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory())
    for (const dir of dirs) {
      const projectDir = path.join(SESSIONS_ROOT, dir.name)
      const sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true }).filter(d => d.isDirectory())
      for (const sd of sessionDirs) {
        if (sessionDirMatches(sd.name, sessionId)) {
          const f = findSessionLog(path.join(projectDir, sd.name))
          if (f) return f
        }
      }
    }
  } catch {}
  return null
}



// ── 记忆/关系网（基于当前预设） ───────────────────────────
function memoryFile(presetId) { return path.join(getPresetDir(presetId) || path.join(ROOT, DEFAULT_PRESET_DIR), 'memory.md') }
function relationsFile(presetId) { return path.join(getPresetDir(presetId) || path.join(ROOT, DEFAULT_PRESET_DIR), 'relations.json') }

// ── 会话级存储（每个会话独立的记忆和关系网） ──────────────
// 位置：<DSH_HOME>/tavern-data/sessions/<sessionId>/
// 绝不能放回 ROOT（= .agent-presets）——那会让 DSH 的预设管理器多出一行「加载失败」。
function sessionDir(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return path.join(TAVERN_DATA_ROOT, 'sessions', safe)
}
function sessionMemoryFile(sessionId) { return path.join(sessionDir(sessionId), 'memory.md') }
function sessionRelationsFile(sessionId) { return path.join(sessionDir(sessionId), 'relations.json') }

// ★ 读操作**不得有副作用**：这里以前还有一句 fs.mkdirSync(path.dirname(f), {recursive:true})。
//   它造成的后果不只是「留下一堆空壳目录」——那些空壳正是下面迁移函数误判「目标已存在」的触发器：
//     任一次组装提示词 → 给每条会话先造出空目录 tavern-data/sessions/<sid>/
//     → 下次启动 migrateSessionStorageOutOfPresetRoot() 看到目标「已存在」
//     → 把 .agent-presets/sessions/<sid>/ 里**有内容的**旧记忆当空壳删掉（旧代码 index.js 当年那行）。
//   只在**写入**路径 mkdir：appendSessionMemory / writeSessionRelations / API 的 POST 分支都自带。
function readSessionMemory(sessionId) {
  try {
    const f = sessionMemoryFile(sessionId)
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8') || ''
  } catch {}
  return ''
}
function appendSessionMemory(sessionId, text) {
  const prev = readSessionMemory(sessionId)
  const stamp = '> [' + new Date().toLocaleString('sv-SE') + ']'
  const combined = prev.trim() + '\n\n' + stamp + '\n' + String(text || '').trim()
  const f = sessionMemoryFile(sessionId)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, combined.trim() + '\n', 'utf8')
}
function readSessionRelations(sessionId) {
  try {
    const f = sessionRelationsFile(sessionId)
    if (fs.existsSync(f)) {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (r && Array.isArray(r.nodes)) {
        if (!Array.isArray(r.edges)) r.edges = []
        return r
      }
    }
  } catch {}
  return { nodes: [], edges: [] }
}
function writeSessionRelations(sessionId, r) {
  const f = sessionRelationsFile(sessionId)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(r || { nodes: [], edges: [] }, null, 2), 'utf8')
}

/**
 * 关系网「软注入」文本：**只提醒存在，不给内容**。
 *
 * 背景：体检发现关系网数据以前**从不进提示词**（readSessionRelations 只被 merge 与 GET 路由调用），
 * 界面上有图谱但对生成零影响。用户要求做「软注入」：让模型知道本会话在记录角色关系，
 * 但**不影响剧情**（不把具体关系塞进提示词带偏走向）。
 *
 * 所以只给一行统计 + 一句"别主动展开"的约束。开关：state.relationsHint === false 时完全不注入（默认开）。
 *
 * @param {string} sessionId
 * @param {object} state readState() 的结果
 * @returns {string} 形如 换行【关系网…】…；无数据或关闭时返回空串
 */
function buildRelationsHintText(sessionId, state) {
  if (state && state.relationsHint === false) return ''
  if (!sessionId) return ''
  let r = null
  try { r = readSessionRelations(sessionId) } catch { return '' }
  const nodes = (r && Array.isArray(r.nodes)) ? r.nodes.length : 0
  const edges = (r && Array.isArray(r.edges)) ? r.edges.length : 0
  if (!nodes && !edges) return ''
  const bits = []
  if (nodes) bits.push(nodes + ' 个角色')
  if (edges) bits.push(edges + ' 条关系')
  return '\n\n【关系网】本会话记录了 ' + bits.join('、') + '（仅作为背景资料存在，'
    + '不要在正文里主动提及、罗列或据此改变剧情走向；用户明确问到时才可以参照）。'
}

// ══════════════════════════════════════════════════════════════════════════
// 技能（Skill）：保存预设时自动生成一个 DSH skill + 会话级"绑定提示"
//
// 为什么这样做（DSH 机制的实测结论）：
//   · skill 由 `dsh-skill` 注册表统一管理，来源是**提供方**；随包提供的
//     `dsh-skill-filesystem` 会扫描这些根（按 rank）：<项目>/.dsh/skills(100) →
//     <项目>/.agents/skills(200) → 自定义(300) → **<DSH_HOME>/skills(400)** →
//     <agentsHome>/skills(500) → 随包目录(600)，并且**监视**它们 —— 新增/改名/删除
//     会进下一次目录，不用重启 DSH。
//   · skill 必须是 `<name>/SKILL.md`（或扁平 `<name>.md`），frontmatter 必填
//     `name`（正则 ^[a-z0-9]+(?:-[a-z0-9]+)*$）与 `description`；可选 `whenToUse`、
//     `disable-model-invocation`、`user-invocable`。名字不合法会被**整条丢弃**。
//   · 所以插件只做两件事：① 把预设的"设定索引"写成合法 SKILL.md；② 在**该会话**
//     的提示词里告诉模型"你有这个 skill，要查设定就加载它"。
//     正文仍以 system prompt 里的卡/世界书为准 —— skill 只是查询索引，不重复注入。
//
// 绑定关系存在 presets.json 的每条形如 `skills: ["tavern-xxx", "手选的别的skill"]`：
// 自动生成的那个 + 用户手动勾选的一起放，删预设时一并清掉。
// ══════════════════════════════════════════════════════════════════════════

/** skill 根目录：默认 <DSH_HOME>/skills（DSH 用户级根，rank 400）；可用 state.skillsDir 覆盖。 */
function skillsRoot() {
  try {
    const st = readState()
    if (st && typeof st.skillsDir === 'string' && st.skillsDir.trim()) return st.skillsDir.trim()
  } catch {}
  return path.join(DSH_HOME, 'skills')
}

/**
 * 在注册表里找预设条目。
 *
 * ⚠️ 这里必须**两套 id 空间都认**：面板给的是**目录名**（`tavern-lite`），而注册表条目的
 * id 可能是别名（`default`）。只按 id 查会：① 取不到 name/description（skill 描述变成 id）；
 * ② `setPresetSkillNames` 直接 `preset-not-found` ⇒ **绑定失败**。
 * 默认预设就是这种「id=default / dir=tavern-lite」的形态，属于必踩的坑。
 */
function findPresetMetaEntry(presetId) {
  const want = String(presetId || '').trim()
  if (!want) return null
  const meta = readPresetsMeta()
  return meta.presets.find(p => p.id === want)
    || meta.presets.find(p => p.dir === want)
    || meta.presets.find(p => p.id === DEFAULT_PRESET_ID && (want === DEFAULT_PRESET_DIR || want === DEFAULT_PRESET_ID))
    || null
}

/** 汇总一个预设的构成，供 skill 正文与描述使用。 */
function summarizePresetForSkill(presetId) {
  let files = { characters: [], worldbooks: [], presets: [], agentYml: '', presetYml: '' }
  try { files = readPresetFiles(presetId) } catch {}
  let wbGroups = []
  try { wbGroups = (readWorldbook(presetId).groups || []) } catch {}
  const chars = (files.characters || []).filter(c => c && c.enabled !== false)
  // 预设模块是**两层结构**：外面是"包"（{name, modules:[…]}），真正的写作要求在内层。
  // 内层每条 {name, content, enabled}；enabled=false 的是"选一"里的落选项（比如 nsfw 风格的其它档），
  // 必须排除 —— 否则会把互相矛盾的指令一起写进 skill。
  const packs = (files.presets || []).filter(m => m && m.enabled !== false)
  const modules = []
  const modulesFlat = []
  for (const pack of packs) {
    const packName = pack.name || '未命名模块包'
    modules.push({ name: packName, count: Array.isArray(pack.modules) ? pack.modules.length : 0 })
    for (const m of (Array.isArray(pack.modules) ? pack.modules : [])) {
      if (!m || m.enabled === false) continue
      const body = String(m.content || m.text || '').trim()
      if (!body) continue          // 纯标记模块（0 字）不进指令
      modulesFlat.push({ pack: packName, name: m.name || '未命名', content: body })
    }
  }
  const wbAll = wbGroups.length ? wbGroups : []
  const wbEntries = []
  for (const g of wbAll) for (const e of (g.entries || [])) wbEntries.push({ group: g.name || '', ...e })
  const wbEnabled = wbEntries.filter(e => e.enabled !== false)
  const meta = findPresetMetaEntry(presetId) || {}
  const cardText = (() => { try { return extractCardText(files.agentYml || '') } catch { return '' } })()
  return {
    id: presetId,
    name: meta.name || presetId,
    description: meta.description || '',
    characters: chars,
    worldbooks: wbGroups.map(g => ({ name: g.name || '未命名' })),
    wbEntries,
    wbEnabled,
    modules,
    modulesFlat,
    cardText,
  }
}

/**
 * 生成 SKILL.md 全文。
 *
 * ⚠️ 两种形态，定位完全不同（DSH 的 skill 正文是**指令**：`form: "instructions"`，
 * 目录里对模型说的是"task-specific instructions… **Follow it**"）：
 *   · style='instructions'（默认）：把预设里**启用中的写作要求**（模块内层逐条）原样写进正文，
 *     当**指令**用 —— 用户 `/技能名` 触发时，宿主把它注入到这一步注入列表的**末尾**（最贴近回答），
 *     比埋在 system prompt 顶部的同一段文字更容易被照做。
 *   · style='index'：只给"设定索引"（角色/世界书/条目名），正文**不**复制设定，
 *     适合"只想让模型知道去哪查"的省 token 用法。
 *
 * @param {string} presetId
 * @param {{includeFull?: boolean, style?: 'instructions'|'index'}} [opts]
 *   includeFull=true 时把启用中的世界书条目正文附在末尾（两种形态都支持）
 */
function buildSkillMarkdown(presetId, opts) {
  const s = summarizePresetForSkill(presetId)
  const name = skillNameForPreset(presetId)
  const style = (opts && opts.style === 'index') ? 'index' : 'instructions'
  const charNames = s.characters.map(c => c.name).filter(Boolean)
  const descBits = []
  if (charNames.length) descBits.push('角色：' + charNames.slice(0, 3).join('、'))
  descBits.push('世界书 ' + s.worldbooks.length + ' 本（' + s.wbEnabled.length + ' 条启用）')
  if (s.modulesFlat.length) descBits.push('写作要求 ' + s.modulesFlat.length + ' 条')
  const description = clipText((s.name ? '《' + s.name + '》' : '')
    + (style === 'instructions' ? '写作指令：' : '设定索引：') + descBits.join('｜'), 180)
    || ('酒馆预设 ' + presetId + (style === 'instructions' ? ' 的写作指令' : ' 的设定索引'))

  const L = []
  L.push('---')
  L.push('name: ' + name)
  L.push('description: ' + yamlScalar(description))
  L.push('whenToUse: ' + yamlScalar(style === 'instructions'
    ? '要按本预设的写作要求写正文时（文风、标签、长度、nsfw 尺度等）；用户发了 /' + name + ' 或要求"按预设写"时'
    : '需要确认本预设的角色名字/外貌/口吻/背景、世界规则、地名或专有名词时；正文写作前先加载它'))
  L.push('---')
  L.push('')

  if (style === 'instructions') {
    // ── 指令型：把启用中的写作要求原样送上 ────────────────────────────
    // 刻意**不写**"以提示词里的卡/世界书为准"那种自我否定的话 —— 这份 skill 存在的意义
    // 就是"让模型照这些要求写"，不是"让它去别处查"。
    L.push('# ' + (s.name || presetId) + '·写作指令')
    L.push('')
    L.push('> 本文件由 dsh-tavern 在**保存预设**时自动生成（手改会在下次保存时被覆盖）。')
    L.push('> 它是**指令**：接下来的回复就按下面这些要求写。它们来自这个预设里**启用中**的写作设置。')
    L.push('')
    if (s.modulesFlat.length) {
      L.push('## 必须遵守的写作要求（' + s.modulesFlat.length + ' 条）')
      L.push('')
      let lastPack = ''
      for (const m of s.modulesFlat) {
        if (m.pack !== lastPack) {
          lastPack = m.pack
          L.push('### 模块包：' + m.pack)
          L.push('')
        }
        L.push('#### ' + m.name)
        L.push('')
        L.push(m.content)
        L.push('')
      }
    } else {
      L.push('## 必须遵守的写作要求')
      L.push('')
      L.push('（本预设没有启用中的写作要求条目。）')
      L.push('')
    }
    if (s.cardText) {
      L.push('## 角色设定（照此扮演）')
      L.push('')
      L.push(s.cardText)
      L.push('')
    }
  } else {
    L.push('# ' + (s.name || presetId) + '·设定索引')
    L.push('')
    L.push('> 本文件由 dsh-tavern 在**保存预设**时自动生成。手改会在下次保存时被覆盖。')
    L.push('> 它只是**查询索引**：正文设定以 system prompt 注入的角色卡 / 世界书为准，这里不额外新增设定。')
    L.push('')
    L.push('## 何时用它')
    L.push('- 角色说了个名字，你要确认这是谁、长什么样、什么口吻')
    L.push('- 需要确认世界观规则、地名、势力、专有名词的准确写法')
    L.push('- 用户问「设定里是怎么写的」')
    L.push('')
  }

  L.push('## 这份预设包含')
  L.push('')
  L.push('### 角色卡（' + s.characters.length + '）')
  if (s.characters.length) {
    for (const c of s.characters) {
      const brief = clipText(c.desc || c.description || '', 80)
      L.push('- **' + (c.name || '未命名') + '**' + (brief ? '：' + brief : ''))
    }
  } else L.push('- （暂无角色卡）')
  L.push('')
  L.push('### 世界书（' + s.worldbooks.length + ' 本 / ' + s.wbEnabled.length + ' 条启用）')
  if (s.wbEnabled.length) {
    const byGroup = new Map()
    for (const e of s.wbEnabled) {
      const g = e.group || '未分组'
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g).push(e)
    }
    for (const [g, es] of byGroup) {
      L.push('- **' + g + '**（' + es.length + ' 条）：' + es.slice(0, 20).map(e => e.name || '未命名').join('、') + (es.length > 20 ? ' …' : ''))
    }
  } else L.push('- （暂无启用中的世界书条目）')
  if (s.characters.length === 0 && s.cardText && style === 'index') {
    L.push('')
    L.push('### 角色卡正文开头（前 200 字，供辨认）')
    L.push('')
    L.push('```')
    L.push(clipText(s.cardText, 200))
    L.push('```')
  }
  L.push('')
  L.push('### 预设模块包（' + s.modules.length + ' 个 / 启用中的写作要求 ' + s.modulesFlat.length + ' 条）')
  if (s.modules.length) for (const m of s.modules.slice(0, 30)) L.push('- ' + (m.name || '未命名') + (m.count ? '（' + m.count + ' 条）' : ''))
  else L.push('- （暂无预设模块）')
  if (opts && opts.includeFull) {
    const cap = 60000
    let used = 0
    const chunk = []
    for (const e of s.wbEnabled) {
      const body = String(e.content || '')
      if (used + body.length > cap) { chunk.push('\n（…体积上限已到，其余条目略）'); break }
      used += body.length
      chunk.push('\n### ' + (e.name || '未命名'))
      chunk.push(typeof e.content === 'string' ? e.content : '')
    }
    if (chunk.length) {
      L.push('')
      L.push('## 附录：启用中的世界书条目正文（' + used + ' 字）')
      L.push(chunk.join('\n'))
    }
  }
  L.push('')
  return L.join('\n')
}

/** 写一份预设的 skill（覆盖式，幂等）。 */
function writePresetSkill(presetId, opts) {
  const name = skillNameForPreset(presetId)
  const dir = path.join(skillsRoot(), name)
  const file = path.join(dir, 'SKILL.md')
  try {
    const md = buildSkillMarkdown(presetId, opts)
    fs.mkdirSync(dir, { recursive: true })
    // ★ 内容没变就**一个字节都不写**。
    //   为什么必须这样：SKILL.md 动辄十几万字节（「酒馆默认」那个 ~19 万），而 DSH 用 chokidar
    //   监视 `<DSH_HOME>/skills`（dsh-skill-filesystem 的用户级根，rank 400）——
    //   **写一次盘 = 宿主重新加载一次技能清单**。
    //   用户实测反馈：点「🎓 技能」的「生成 / 切形态」之后，聊天输入框会失焦、点不动（页面其它
    //   部分正常，只能重启 DSH）。而「无脑重写同一个文件」正是这条链路上由点击引发的副作用之一，
    //   所以这里取掉它：内容一致 ⇒ 不落盘（mtime 也不变 ⇒ 宿主连事件都收不到）。
    //   返回值多一个 unchanged，面板据此显示"已是最新，未重写"。
    let unchanged = false
    try { unchanged = fs.readFileSync(file, 'utf8') === md } catch { unchanged = false }
    if (!unchanged) fs.writeFileSync(file, md, 'utf8')
    return { ok: true, name, dir, file, bytes: Buffer.byteLength(md, 'utf8'), unchanged }
  } catch (e) {
    return { ok: false, name, dir, error: 'skill-write-failed: ' + ((e && e.message) || e) }
  }
}

/** 删除预设对应的 skill 目录（只删我们自己生成的那个名字）。 */
function deletePresetSkill(presetId) {
  const name = skillNameForPreset(presetId)
  const dir = path.join(skillsRoot(), name)
  try {
    if (!fs.existsSync(dir)) return { ok: true, name, removed: false }
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, name, removed: true }
  } catch (e) {
    return { ok: false, name, error: 'skill-delete-failed: ' + ((e && e.message) || e) }
  }
}

/** 扫描磁盘上所有可用 skill（DSH 用户级根 + ~/.agents/skills），供面板手动选择。 */
function listSkillsOnDisk() {
  const roots = [skillsRoot(), path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills')]
  const out = []
  const seen = new Set()
  for (const root of roots) {
    let items = []
    try { items = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      try {
        if (it.isDirectory()) {
          const f = path.join(root, it.name, 'SKILL.md')
          if (!fs.existsSync(f)) continue
          const head = fs.readFileSync(f, 'utf8').slice(0, 4000)
          const fm = parseSkillFrontmatter(head)
          const name = fm.name || it.name
          if (seen.has(name)) continue
          seen.add(name)
          out.push({ name, description: fm.description || '', whenToUse: fm.whenToUse || '', path: f, source: 'dir' })
        } else if (it.name.endsWith('.md') && it.name !== 'SKILL.md') {
          const f = path.join(root, it.name)
          const head = fs.readFileSync(f, 'utf8').slice(0, 4000)
          const fm = parseSkillFrontmatter(head)
          const name = fm.name || it.name.replace(/\.md$/, '')
          if (seen.has(name)) continue
          seen.add(name)
          out.push({ name, description: fm.description || '', whenToUse: fm.whenToUse || '', path: f, source: 'flat' })
        }
      } catch {}
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取某预设绑定（自动生成 + 手动勾选）的 skill 名列表。 */
function presetSkillNames(presetId) {
  try {
    // 用 findPresetMetaEntry：两套 id 空间（目录名 / 别名 default）都要认
    const p = findPresetMetaEntry(presetId)
    if (p && Array.isArray(p.skills)) return p.skills.map(String).filter(n => SKILL_NAME_RE.test(n))
  } catch {}
  return []
}

/** 写回某预设的 skill 绑定（保持顺序、去重、只留合法名字）。 */
function setPresetSkillNames(presetId, names) {
  const meta = readPresetsMeta()
  const target = (() => {
    const want = String(presetId || '').trim()
    return meta.presets.find(x => x.id === want)
      || meta.presets.find(x => x.dir === want)
      || meta.presets.find(x => x.id === DEFAULT_PRESET_ID && (want === DEFAULT_PRESET_DIR || want === DEFAULT_PRESET_ID))
      || null
  })()
  if (!target) return { ok: false, error: 'preset-not-found' }
  const list = []
  for (const n of (Array.isArray(names) ? names : [])) {
    const s = String(n || '').trim()
    if (SKILL_NAME_RE.test(s) && !list.includes(s)) list.push(s)
  }
  target.skills = list
  writePresetsMeta(meta)
  return { ok: true, skills: list }
}

/**
 * 会话级「可用 skill」提示。
 *
 * ⚠️ 关键：**该会话有没有 skill 工具，取决于它的 agent 预设组合**，不取决于本插件 ——
 *   实测（读 app.asar 里的预设补丁）：DSH 出厂 `standard` / `ptc` / `cordis` 预设都挂了
 *   `dsh-skill-filesystem` + `dsh-tool-skill`，而 `minimal` 和**酒馆自己的预设**
 *   （组合里只有 persona / fs-local / str-replace-editor / pwsh / web）**都没挂**。
 *   所以对酒馆预设的会话说"用 skill 工具加载"是**错指令** —— 模型根本没有那个工具，
 *   它会像实测那样回答"我这边没有 skill 加载工具"。这时给两条真能走通的路：
 *     ① 用户侧调用：用户在消息里输入 `/<name>`，宿主 pre-step 直接把 skill 正文注入
 *        （dsh-client-ui-skill README.zh.md:85：「加载是确定性的：模型无需被要求调用
 *          skill 工具就能收到完整正文」）；
 *     ② 文件侧：会话若有文件工具，直接读 SKILL.md 的绝对路径。
 *
 * 开关 state.skillHint === false 时完全不注入。
 */
function buildSkillsHintText(sessionId, presetId, state) {
  if (state && state.skillHint === false) return ''
  if (!sessionId || !presetId) return ''
  const names = presetSkillNames(presetId)
  if (!names.length) return ''
  const primary = names[0]
  const file = path.join(skillsRoot(), primary, 'SKILL.md')
  let hasSkillTool = false
  try {
    hasSkillTool = /dsh-tool-skill/.test(String(readPresetFiles(presetId).agentYml || ''))
  } catch {}
  if (hasSkillTool) {
    return '\n\n【可用 skill】本会话绑定了 skill：' + names.join('、')
      + '。需要确认本预设的角色/世界书设定细节时，用 skill 工具加载它（不要凭空编造设定）；'
      + '正文设定以本提示词里已注入的卡/世界书为准。'
  }
  // 本预设没挂 skill 工具 ⇒ 绝不能给模型一个它没有的工具名
  return '\n\n【可用 skill】本会话绑定了设定索引文件：' + names.join('、')
    + '（本预设未挂 skill 工具，你无法主动加载）。需要其中细节时：'
    + '若你有文件读取工具，直接读 ' + file + '；'
    + '否则请让用户在消息里发 /' + primary + '，宿主会把正文直接注入这一步。不要凭空编造设定。'
}

/** 保存预设后自动生成/更新 skill（best-effort：任何失败都不许影响保存本身）。 */
function syncPresetSkillAfterSave(presetId, state) {
  try {
    if (state && state.skillAutoGenerate === false) return { ok: false, skipped: true, reason: 'auto-off' }
    const r = writePresetSkill(presetId, {
      includeFull: !!(state && state.skillAutoFull === true),
      style: (state && state.skillStyle === 'index') ? 'index' : 'instructions',
    })
    if (r.ok) {
      const cur = presetSkillNames(presetId)
      if (!cur.includes(r.name)) setPresetSkillNames(presetId, cur.concat([r.name]))
    }
    return r
  } catch (e) {
    return { ok: false, error: 'skill-sync-failed: ' + ((e && e.message) || e) }
  }
}
function normalizeName(name) {
  if (!name) return ''
  const raw = String(name).trim()
  // 含 U+FFFD 替换字符 = 编码损坏的名称（如 "���角"），整个丢弃
  if (/[\uFFFD]/.test(raw)) return ''
  const s = cleanName(raw)
  if (!s) return ''
  // 别名全集直接命中
  if (USER_ALIASES.has(s)) return '你'
  // 剥离括号修饰词再判断：如 "食客（男主角）" → "食客" → "你"；"主角(男)" → "主角" → "你"
  const stripped = s.replace(/[（(].*?[)）]/g, '').trim()
  if (stripped && USER_ALIASES.has(stripped)) return '你'
  // 以别名结尾/开头（如 "男主角"、"食客男主"）近似识别为用户
  for (const alias of ['食客', '主角', '玩家', '用户', '主人']) {
    if (stripped.endsWith(alias) || stripped.startsWith(alias)) return '你'
}
    // ★ 可配置玩家名归一化：如果名称与配置的玩家名一致，也归并为「你」
    if (S.playerName && s === S.playerName) return '你'
  return s
}

function mergeSessionRelations(sessionId, rels) {
  const r = readSessionRelations(sessionId)
  // 清理已有的合体节点（包含分隔符的节点名）
  const hasSeparator = (name) => /[、，,\/\s]|和|与|及|跟/.test(name)
  r.nodes = r.nodes.filter(n => !hasSeparator(n.id))
  r.edges = r.edges.filter(e => !hasSeparator(e.source) && !hasSeparator(e.target))
  // 归一化已有节点/边（把玩家/主角/我/用户 改成你，丢弃乱码名）
  r.nodes = r.nodes.map(n => {
    const id = normalizeName(n.id)
    if (!id) return null
    return { ...n, id, label: normalizeName(n.label) || id }
  }).filter(Boolean)
  r.edges = r.edges.map(e => {
    const s = normalizeName(e.source)
    const t = normalizeName(e.target)
    if (!s || !t) return null
    return { ...e, source: s, target: t }
  }).filter(Boolean)
  // 去重节点（同 id 合并）
  const seen = {}
  r.nodes = r.nodes.filter(n => { if (seen[n.id]) return false; seen[n.id] = true; return true })
  // 拆分角色名
  const splitNames = (name) => {
    if (!name) return []
    const s = normalizeName(String(name).trim())
    if (!s) return []
    const parts = s.split(/[、，,\/\s]+|和|与|及|跟/).map(x => normalizeName(x.trim())).filter(x => x.length > 0 && x.length < 10)
    if (parts.length <= 1) return [s]
    return parts
  }
  const nodeId = (name) => String(name || '').trim()
  const addNode = (name) => {
    const id = nodeId(name)
    if (!id) return null
    if (!r.nodes.some((x) => x.id === id)) r.nodes.push({ id, label: id })
    return id
  }
  const hasEdge = (s, t) => r.edges.some((e) => e.source === s && e.target === t)
  for (const rel of rels || []) {
    const sources = splitNames(rel.source)
    const targets = splitNames(rel.target)
    const label = String(rel.label || rel.relation || '相关').replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。、！？：；""''（）\s\-—]/g, '').trim() || '相关'
    for (const sName of sources) {
      for (const tName of targets) {
        const s = addNode(sName)
        const t = addNode(tName)
        if (s && t && s !== t && !hasEdge(s, t)) {
          r.edges.push({ source: s, target: t, label: label })
        }
      }
    }
  }
  writeSessionRelations(sessionId, r)
  return r
}

function readMemory(presetId) {
  try {
    const f = memoryFile(presetId)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8') || ''
  } catch {}
  return ''
}

function readRelations(presetId) {
  try {
    const f = relationsFile(presetId)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (fs.existsSync(f)) {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (r && Array.isArray(r.nodes)) {
        if (!Array.isArray(r.edges)) r.edges = []
        return r
      }
    }
  } catch {}
  return { nodes: [], edges: [] }
}

function writeRelations(presetId, r) {
  const f = relationsFile(presetId)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(r || { nodes: [], edges: [] }, null, 2), 'utf8')
}

function appendMemory(presetId, text) {
  const prev = readMemory(presetId)
  const stamp = '> [' + new Date().toLocaleString('sv-SE') + ']'
  const combined = prev.trim() + '\n\n' + stamp + '\n' + String(text || '').trim()
  const f = memoryFile(presetId)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, combined.trim() + '\n', 'utf8')
}

// ── LLM 调用 ──────────────────────────────────────────────

// ── 会话服务获取 ──────────────────────────────────────────
function getSessionQuery(ctx) {
  try { if (ctx.get && typeof ctx.get === 'function') { const s = ctx.get('sessionQuery'); if (s) return s } } catch {}
  try { if (ctx.sessionQuery && typeof ctx.sessionQuery.load === 'function') return ctx.sessionQuery } catch {}
  return undefined
}
function getSessionPersistence(ctx) {
  try { if (ctx.get && typeof ctx.get === 'function') { const s = ctx.get('sessionPersistence'); if (s) return s } } catch {}
  try { if (ctx.sessionPersistence && typeof ctx.sessionPersistence.list === 'function') return ctx.sessionPersistence } catch {}
  return undefined
}

// ── zstd 多帧解压（会话文件） ─────────────────────────────

function readSessionMessagesDirect(sessionId, maxMsgs) {
  const list = []
  const events = readSessionEventsDirect(sessionId, 0)
  for (const ev of events) {
    let text = ''
    if (ev.type === 'user/message') text = contentTextOnly(ev.data && ev.data.content)
    else if (ev.type === 'assistant/message') text = contentTextOnly(ev.data && ev.data.message && ev.data.message.content)
    if (text) list.push((ev.type === 'user/message' ? '用户' : '助手') + '：' + text)
  }
  return maxMsgs ? list.slice(-maxMsgs) : list
}

async function readRecentMessages(ctx, sessionId, n) {
  const list = []
  const sq = getSessionQuery(ctx)
  if (sq && sessionId) {
    try {
      const snap = await sq.load(sessionId, undefined)
      const events = (snap && snap.events) || []
      for (const ev of events) {
        let text = ''
        if (ev.type === 'user/message') text = contentTextOnly(ev.data && ev.data.content)
        else if (ev.type === 'assistant/message') text = contentTextOnly(ev.data && ev.data.message && ev.data.message.content)
        if (text) list.push((ev.type === 'user/message' ? '用户' : '助手') + '：' + text)
      }
    } catch {}
  }
  if (!list.length) {
    try { return readSessionMessagesDirect(sessionId, n || 20) } catch {}
  }
  return list.slice(-(n || 20))
}

async function getSessionTitle(ctx, sessionId) {
  try {
    const events = readSessionEventsDirect(sessionId, 50)
    for (const ev of events) {
      if (ev.type === 'user/message') {
        const text = contentToText(ev.data && ev.data.content).trim()
        if (text) return text.slice(0, 60)
      }
    }
  } catch {}
  return ''
}

async function countUserMessages(ctx, sessionId) {
  // 优先用 DSH sessionQuery 统计；若服务不可用或读不到，降级为直接读会话文件计数。
  const sq = getSessionQuery(ctx)
  if (sq && sessionId) {
    try {
      const snap = await sq.load(sessionId, undefined)
      const events = (snap && snap.events) || []
      const n = events.filter((e) => e && e.type === 'user/message').length
      if (n > 0) return n
      // sq.load 成功但读到 0 条 user/message → 可能结构不同，落到文件降级
    } catch { /* 落到文件降级 */ }
  }
  // ★ 降级：直接读 DSH 会话文件统计 user 消息数（不依赖 sq，手动总结同款读取路径）
  try {
    const events = readSessionEventsDirect(sessionId || '', 0)
    return events.filter((e) => e && e.type === 'user/message').length
  } catch { return 0 }
}

// ── 总结/关系网 ───────────────────────────────────────────

function mergeRelations(presetId, rels, existing) {
  const r = existing || readRelations(presetId)
  // 称呼归一化使用模块级 normalizeName / cleanName（见文件顶部定义）
  const hasSeparator = (name) => /[、，,\/\s]|和|与|及|跟/.test(name)
  r.nodes = r.nodes.filter(n => !hasSeparator(n.id))
  r.edges = r.edges.filter(e => !hasSeparator(e.source) && !hasSeparator(e.target))
  r.nodes = r.nodes.map(n => ({ ...n, id: normalizeName(n.id), label: normalizeName(n.label) }))
  r.edges = r.edges.map(e => ({ ...e, source: normalizeName(e.source), target: normalizeName(e.target) }))
  const seen = {}
  r.nodes = r.nodes.filter(n => { if (seen[n.id]) return false; seen[n.id] = true; return true })
  const splitNames = (name) => {
    if (!name) return []
    const s = normalizeName(String(name).trim())
    if (!s) return []
    const parts = s.split(/[、，,\/\s]+|和|与|及|跟/).map(x => normalizeName(x.trim())).filter(x => x.length > 0 && x.length < 10)
    if (parts.length <= 1) return [s]
    return parts
  }
  const nodeId = (name) => String(name || '').trim()
  const addNode = (name) => {
    const id = nodeId(name)
    if (!id) return null
    if (!r.nodes.some((x) => x.id === id)) r.nodes.push({ id, label: id })
    return id
  }
  const hasEdge = (s, t) => r.edges.some((e) => e.source === s && e.target === t)
  for (const rel of rels || []) {
    const sources = splitNames(rel.source)
    const targets = splitNames(rel.target)
    const label = String(rel.label || rel.relation || '相关').replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。、！？：；""''（）\s\-—]/g, '').trim() || '相关'
    for (const sName of sources) {
      for (const tName of targets) {
        const s = addNode(sName)
        const t = addNode(tName)
        if (s && t && s !== t && !hasEdge(s, t)) {
          r.edges.push({ source: s, target: t, label: label })
        }
      }
    }
  }
  writeRelations(presetId, r)
  return r
}

let lastSessionId = ''

async function runSummary(ctx, state, sessionId, presetId, isManual) {
  const m = (state && state.mem) || {}
  const api = resolveMemApi(state)
  console.log('[酒馆总结] 开始总结, sessionId=' + sessionId + ', presetId=' + presetId + ', isManual=' + isManual + ', api来源=' + api.from)
  if (!api.apiUrl) throw new Error('未配置记忆模块 API：请在酒馆管理→记忆模块中选择「使用 DSH 连接」或填写手动 API URL')
  if (api.from !== 'manual' && !api.apiKey) throw new Error('所选 DSH 连接（' + api.from + '）未检测到已保存的 API Key，请先在 DSH 设置中配置对应密钥')
  // sessionId 可能是 preset-xxx 格式（前端兜底），这种情况下用 presetId 读取消息
  let realSessionId = sessionId
  if (sessionId && sessionId.startsWith('preset-')) {
    realSessionId = lastSessionId || ''
    console.log('[酒馆总结] sessionId 是 preset 格式，改用 lastSessionId=' + realSessionId)
  }
  if (!realSessionId) throw new Error('无法获取当前会话 ID，请先在对话中发一条消息后再总结')
  const readCount = isManual ? 200 : (m.autoEvery || 20)
  console.log('[酒馆总结] 读取最近 ' + readCount + ' 条消息, sessionId=' + realSessionId)
  let msgs = []
  try {
    msgs = await readRecentMessages(ctx, realSessionId, readCount)
  } catch (e) {
    console.log('[酒馆总结] readRecentMessages 失败:', e.message)
    throw new Error('读取会话消息失败: ' + e.message)
  }
  console.log('[酒馆总结] 读取到 ' + msgs.length + ' 条消息')
  if (!msgs.length) throw new Error('当前会话没有可总结的消息（会话ID=' + realSessionId + '），请先进行对话')
  const prompt = buildSummaryPrompt(msgs)
  console.log('[酒馆总结] 调用 LLM, model=' + api.model + ', baseURL=' + (api.apiUrl || '').replace(/\/+$/, '') + ', prompt长度=' + prompt.length)
  let out = ''
  try {
    out = await callLLM(api.apiUrl, api.apiKey, api.model, prompt, 4000)
  } catch (e) {
    console.log('[酒馆总结] callLLM 失败:', e.message)
    throw new Error('调用模型失败: ' + e.message)
  }
  console.log('[酒馆总结] LLM 返回长度=' + (out || '').length)
  const { summary, rels, source } = parseSummaryOutput(out, realSessionId)
  const targetPresetId = presetId || getSessionPresetId(realSessionId) || 'default'
  console.log('[酒馆总结] 解析结果: summary=' + (summary ? '有' : '无') + ', rels=' + (rels ? Object.keys(rels).length : 0) + '个角色')
  if (summary) {
    // ★ 只写会话级（realSessionId）。原来同时 appendMemory(targetPresetId, ...) ——
    //   那等于把这条会话的剧情写进「所有用同一预设的会话共享」的文件里。
    //   一旦 attribution 出一点偏差（presetId 来自全局 lastSessionId），
    //   污染就永久留在预设文件里，并被之后每一条会话注入。写入端不再制造这种文件。
    appendSessionMemory(realSessionId, '# 记忆总结 [' + new Date().toLocaleString('zh-CN') + ']\n' + summary + '\n')
  }
  if (rels && Object.keys(rels).length) {
    // ★ 关系网同样只写会话级。预设级 relations.json 与 memory.md 是同一类共享文件：
    //   面板取关系网时本来就带 sessionId（走 readSessionRelations），预设级那份
    //   GET 根本读不到，只会安静地累积所有人的关系边。
    //   注意：历史文件保持原样，不删不改名 —— 见报告里的迁移方案。
    mergeSessionRelations(realSessionId, rels)
  }
  return { summary, relations: rels, source, sessionId: realSessionId, presetId: targetPresetId, messageCount: msgs.length }
}

/**
 * 把路径常量绑定到 DSH 实际的 home。
 *
 * 优先取 DSH 自己提供的 `dshHomePath` 服务（与本体同源，最可靠）；
 * 拿不到时按 resolveDshHome() 的优先级自行解析（$DSH_HOME → ~/.dsh）。
 * `apply()` 最开始调用一次，之后所有 ROOT / SESSIONS_ROOT 等常量即生效。
 * @param {object} ctx - cordis 上下文
 */
function bindDshPaths(ctx) {
  let home = ''
  try {
    const fn = ctx && typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof fn === 'function') home = String(fn() || '')
  } catch {}
  if (!home) home = resolveDshHome()
  DSH_HOME = home
  ROOT = path.join(home, '.agent-presets')
  PRESETS_META = path.join(ROOT, 'presets.json')
  SESSION_BINDINGS = path.join(ROOT, 'session-bindings.json')
  STATE_PATH = path.join(ROOT, 'tavern-state.json')
  SESSIONS_ROOT = path.join(home, 'sessions')
  TAVERN_DATA_ROOT = path.join(home, 'tavern-data')
  DSH_SETTINGS_FILE = path.join(home, 'settings.yaml')
  DSH_CREDENTIALS_FILE = path.join(home, '.credentials.yaml')
  syncPaths({ DSH_HOME, ROOT, PRESETS_META, SESSION_BINDINGS, STATE_PATH, SESSIONS_ROOT, TAVERN_DATA_ROOT, DSH_SETTINGS_FILE, DSH_CREDENTIALS_FILE })
  // 与路径绑定的缓存必须失效，否则会读到切换前目录的旧数据
  S._bindingsCache = null
  S._bindingsDirty = false
  S.builtinDirsCache = null
}

/**
 * 把会话级存储从预设根目录里搬出来。
 *
 * 历史版本把每会话的记忆/关系网写在 `<DSH_HOME>/.agent-presets/sessions/<id>/`。
 * 而 DSH 的 preset discovery 会把 .agent-presets 下**每个名字合法的目录**都当成一行
 * 预设，缺 `agent.cordis.yml` 就标 broken —— 于是预设管理器里永久挂着一行红字
 * 「加载失败」的 sessions。这里把数据搬到 `<DSH_HOME>/tavern-data/sessions/`，
 * 再清掉旧目录。
 *
 * 空目录直接丢弃：`readSessionMemory()` 里连**读**都会 mkdir，历史上因此留下一堆空壳。
 *
 * 两个根都可传参，方便单测用临时目录验证。
 * @param {string} [oldRootArg] 旧位置（默认 ROOT/sessions）
 * @param {string} [newRootArg] 新位置（默认 TAVERN_DATA_ROOT/sessions）
 * @returns {{moved: number, dropped: number, removed: boolean}} 搬运/丢弃/删除计数
 */
function migrateSessionStorageOutOfPresetRoot(oldRootArg, newRootArg) {
  const oldRoot = oldRootArg || path.join(ROOT, 'sessions')
  const newRoot = newRootArg || path.join(TAVERN_DATA_ROOT, 'sessions')
  // ★ 归档区：与「会被读取的存储」分开，而且不在 .agent-presets 下（DSH 不会把它扫成预设行）。
  const archiveRoot = path.join(path.dirname(newRoot), '_migrated-archive')
  const out = { moved: 0, dropped: 0, removed: false }
  // ⚠️ 只在真的发生时补键：无操作时的返回形状必须是 {moved,dropped,removed}，
  //    既有测试对它做的是 deepEqual（412 行那一条），多一个 0 值键都会红。
  const bump = (k) => { if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = 0; out[k]++ }
  const countIn = (dir) => { try { return fs.readdirSync(dir).length } catch { return -1 } }
  // 整份挪到归档区（**不删**）。返回归档路径；失败返回 ''
  const archive = (from, name) => {
    let dest = path.join(archiveRoot, String(Date.now()) + '-' + String(name).slice(0, 40))
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      let n = 1
      while (fs.existsSync(dest) && n < 1000) { dest = dest + '-' + n; n++ }
      fs.renameSync(from, dest)
      out.lastArchive = dest
      bump('archived')
      return dest
    } catch { return '' }
  }
  let children
  try {
    if (!fs.existsSync(oldRoot)) return out
    children = fs.readdirSync(oldRoot, { withFileTypes: true })
  } catch { return out }
  for (const child of children) {
    const from = path.join(oldRoot, child.name)
    try {
      // ── 不是目录：以前直接 rmSync 删掉。现在一律归档，绝不删。──
      if (!child.isDirectory()) {
        if (archive(from, child.name)) bump('dropped')
        else bump('kept')
        continue
      }
      const files = fs.readdirSync(from)
      // ── 空壳目录：允许清掉（就是「读也 mkdir」留下的那堆）──
      if (files.length === 0) { fs.rmdirSync(from); bump('dropped'); continue }
      const to = path.join(newRoot, child.name)
      let toIsDir = false
      try { toIsDir = fs.statSync(to).isDirectory() } catch { toIsDir = false }
      if (!toIsDir) {
        fs.mkdirSync(newRoot, { recursive: true })
        try {
          fs.renameSync(from, to)
        } catch {
          // 跨卷等情况下 rename 会失败，退回逐个条目搬运
          fs.mkdirSync(to, { recursive: true })
          for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(to, f))
          // ⚠️ 这里只允许删**已经搬空**的源目录。原来用的是 rmSync(recursive, force) ——
          //    一旦上面某个 rename 抛错，它会把**还没搬走的**文件一起删掉。改为「确认为空才 rmdir」。
          try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from) } catch {}
        }
        bump('moved')
        continue
      }
      // ── 目标「已存在」：**绝不删源**。分两种，因为差别就是当初那个数据丢失 bug ──
      const destFiles = countIn(to)
      if (destFiles === 0) {
        // 目标只是个空壳（从来没人往里写过；typically 就是上面那个 mkdir 留下的）
        // ⇒ 源里的内容本来就是要给这条会话的，**合并进去**，让记忆真的回到可用状态。
        let merged = 0
        for (const f of fs.readdirSync(from)) {
          const target = path.join(to, f)
          if (fs.existsSync(target)) continue          // 防御：绝不覆盖任何已存在的文件
          fs.renameSync(path.join(from, f), target)
          merged++
        }
        try { fs.rmdirSync(from) } catch {}
        if (merged > 0) { bump('moved'); bump('merged') }
        else bump('kept')
        continue
      }
      // 目标已有内容 ⇒ 两份都可能是真数据，谁新谁旧从磁盘上无从判断 ⇒ 整份归档，等人判。
      // 只清掉已经归档完成的源目录；归档失败就原样留着。
      if (archive(from, child.name)) { bump('dropped'); try { fs.rmdirSync(from) } catch {} }
      else bump('kept')
    } catch {}
  }
  try {
    if (fs.readdirSync(oldRoot).length === 0) { fs.rmdirSync(oldRoot); out.removed = true }
  } catch {}
  return out
}

// ── 世界书条目选择（SillyTavern 语义）─────────────────────
// 与 ST 对齐的点：
//   1. 常驻 = 条目自带 constant:true，或没有关键词；其余靠关键词触发
//   2. 关键词与副关键词分开：副关键词需同时命中（AND）
//   3. 扫描深度可配（wb.scanDepth，默认 4 条最近消息）
//   4. 「分阶段人设」互斥：X_阶段NN_* 只注入当前好感度对应的那一档
//   5. EJS 模板（<% %>）不是可注入文本 —— 跳过，绝不原样灌进提示词
//   6. 支持 caseSensitive / matchWholeWords / probability / order / disable

/**
 * 启动时初始化酒馆根目录，并把实际使用的路径打出来，
 * 方便排查「DSH 没装在默认位置」这类路径问题。
 * @param {object} ctx - cordis 上下文
 */
function initDshPaths(ctx) {
  bindDshPaths(ctx)
  console.log('[dsh-tavern] DSH_HOME = ' + DSH_HOME + '（来源: ' + (process.env.DSH_HOME && process.env.DSH_HOME.trim() ? '$DSH_HOME' : '默认 ~/.dsh') + '）')
  console.log('[dsh-tavern] 预设目录 = ' + ROOT)
  console.log('[dsh-tavern] 会话目录 = ' + SESSIONS_ROOT)
  try { migratePersonaTextField() } catch (e) { console.log('[dsh-tavern] persona 字段迁移失败: ' + e.message) }
  try { migratePersonaCompleteFlag() } catch (e) { console.log('[dsh-tavern] persona 结构迁移失败: ' + e.message) }
}

// ══════════════════════════════════════════════════════════════════════
// P0-5 生效范围闸门：白名单语义改为「**空 = 不放行**」
//
//   旧语义：`mode:'allowlist'` 且 allowSessions / allowCwds **两个名单都空**时
//   落到 `!hasAllowlist` 那一支 ⇒ 一律放行。而默认状态恰好就是
//   `mode:'allowlist'` + 两个空数组（见 readState 的兜底对象），于是
//   「一个都没勾选」在用户眼里是「不注入」，实际语义却是「不限制」——
//   角色卡 / 世界书 / 会话记忆 / 反八股被静默注入到**每一条**会话。
//
//   新语义（用户已拍板）：**空 = 谁都不放行**。想让酒馆在某条会话生效，
//   必须显式往 allowSessions / allowCwds 里加条目，或把 mode 切到 'global'。
//
// ⚠ 只改「两个名单都空」这一支，其余判定原样保留，别扩大改动面：
//   · `mode:'global'` 是**用户显式的全放行**，语义完全不同，行为必须与改动前一致；
//   · 部分为空（如 allowSessions 非空、allowCwds 空）仍走逐项判定。
//
// ⚠ 纯函数：不读盘、不写盘，只按传入的 state 判定（便于单测）；
//   调用方负责按 `allowed` 决定返回空串，并自行处理 global 的 disabledCwds 黑名单。
// ══════════════════════════════════════════════════════════════════════

// ── 主应用 ────────────────────────────────────────────────
export function apply(ctx) {
  initDshPaths(ctx)
  // ★ 记下插件上下文：注入决议（resolveAuthoritativePreset）在 systemPrompt 段回调里跑，
  //   那条路径只拿得到 context（agent/session），拿不到 ctx；需要一个模块级引用去问
  //   DSH 的原生服务（sessionProjections / sessions）。测试里不 apply ⇒ 保持 null ⇒
  //   决议链与既有语义逐字节一致（不引入任何测试外的隐式行为）。
  S.activePluginCtx = ctx
  let active = null
  let lastCwd = ''
  let autoBusy = false

  ensureDefaultPreset()

  // ★ 活会话登记：一次性安装全局监听（agent/created + agent/inbox/inserted）。
  //   ★ 2026-10-04：这里以前是「开场白播种」的安装点。播种已整体删除（它会把会话日志
  //     写坏到永久打不开，见文件上方「── 角色卡开场白 ──」注释），现在只剩登记。
  try { armLiveAgents(ctx) } catch (e) {
    try { noteGreetingLog('', '', false, 'apply arm-failed: ' + e.message) } catch {}
  }

  // ★ 会话原生预设监听：DSH 一换预设，酒馆账本立刻跟着走（否则账本会过期 ⇒ 串台）。
  try {
    const disposeWatcher = armNativePresetWatcher(ctx)
    ctx.effect(() => disposeWatcher, 'tavern.native-preset-watcher()')
  } catch (e) {
    try { console.error('[tavern] armNativePresetWatcher 安装失败：', String(e && e.message || e)) } catch {}
  }

  // 自动总结
  const maybeAutoSummary = () => {
    const state = readState()
    const m = state.mem || {}
    if (!m.autoEnabled || autoBusy || !lastSessionId) return
    // ★ 先把「这一轮要总结的会话」钉成本地常量。
    //
    //   lastSessionId 是**全进程唯一的全局量**：任何一条别的会话组装提示词、
    //   或者面板随便轮询一个带 sessionId 的接口，都会把它改写掉。
    //   原来 presetId 在同步段取（对的），而 runSummary(…, lastSessionId, …) 写在
    //   .then() 回调里 —— 那是异步之后才取的值，于是很容易出现
    //   「presetId 来自会话 A + 消息来自会话 B」，总结就被记到了别的会话头上。
    //   钉成常量后，presetId 与消息来自同一条会话，写进 session 记忆也一定对得上。
    const targetSid = lastSessionId
    const presetId = getSessionPresetId(targetSid)
    countUserMessages(ctx, targetSid)
      .then(function (seq) {
        if (!seq) return
        const st2 = readState()
        const m2 = st2.mem || {}
        if (m2.lastSeq && seq >= m2.lastSeq && seq - m2.lastSeq >= (m2.autoEvery || 20)) {
          autoBusy = true
          m2.lastSeq = seq
          writeState(st2)
          runSummary(ctx, st2, targetSid, presetId)
            .then(() => { try { refresh(ctx) } catch {} })
            .catch((e) => { try { fs.writeFileSync(path.join(ROOT, 'memory.log'), '[' + new Date().toISOString() + '] 自动总结失败：' + e.message + '\n', { flag: 'a' }) } catch {} })
            .finally(() => { autoBusy = false })
        } else if (!m2.lastSeq || seq < m2.lastSeq) {
          m2.lastSeq = seq
          writeState(st2)
        }
      })
      .catch(() => {})
  }

  // ★ 核心：按会话绑定的预设注入角色卡 ★
  const refresh = (ctx) => {
    if (active) { active(); active = null }
    active = ctx.systemPrompt.section({
      name: 'tavern:card',
      order: -999999,
      text: (context) => {
        const state = readState()
// ★ 可配置玩家名：每次注入时从 state 同步到模块级 S.playerName
          if (typeof state.playerName === 'string') S.playerName = state.playerName.trim() || ''
        // 获取当前会话 ID
        // ⚠️ 必须是 let：下面的子 Agent 继承分支会把它改写成父会话 id。
        //    原先声明为 const，导致继承分支一执行就抛
        //    "TypeError: Assignment to constant variable"（子 Agent 组装提示词直接失败）。
        let sid = context?.agent?.session?.id || context?.agent?.session?.header?.id
        // ★ 子 Agent / 队友 agent 的会话不参与「当前会话」记录：
        //   否则每次派子任务都会把 lastSessionId 覆写成子会话，
        //   自动总结就会去总结 agent 之间的会话，而不是正文。
        //   判别用 origin === 'subagent'（只由 subagent 子会话设置，
        //   见 packages/subagent/subagent/src/child-agent.ts），
        //   而不是 parentSession —— 用户自己 fork 出的会话同样带 parentSession，不该被排除。
        let sessionHeader = null
        try { sessionHeader = context?.agent?.session?.header || null } catch {}
        const isSubagentSession = !!sessionHeader && (sessionHeader.origin === 'subagent'
          || (typeof sessionHeader.delegationDepth === 'number' && sessionHeader.delegationDepth > 0))
        if (sid && !isSubagentSession) {
          lastSessionId = sid
          maybeAutoSummary()
        }
        if (state.cardEnabled === false) return ''

        // ★ 根据会话 ID 查找绑定的预设 ★
        //   权威来源是 DSH 自己的记录：用户在聊天顶部预设选择器里选了什么，会往会话事件流
        //   追加 agent-preset/selected（见 resolveAuthoritativePresetId）。
        //   session-bindings.json 只是酒馆自己的记账 —— 新会话里当然还没有条目，所以它
        //   不能当「要不要注入」的闸门：否则「新建对话 → 在顶部选预设」这条正常路径永远
        //   走不到注入，用户看到的现象就是「新对话里看不到我的角色卡」。
        // ★ P0-1：拿完整决议（id + 来源），来源决定 P0-2 写不写绑定。
        let resolution = resolveAuthoritativePreset(sid)
        let presetId = resolution.presetId
        const bindings = readBindings()
        // DSH 侧确实挂着一个酒馆可管理的预设（排除内置 standard 与空预设 default）
        const resolvedOnDsh = !!(sid && presetId && presetId !== DEFAULT_PRESET_ID && isTavernPresetDir(presetId))
        // ⚠️ 闸门只看权威解析结果，**不看 bindings 记账**：
        //    presetId 已经按「显式选择 > bindings > default」合过了，再拿 bindings 当通行证，
        //    等于让一条过期的记账推翻用户在顶部的选择 —— 会话/预设隔离就是这么失效的。
        if (!sid || !resolvedOnDsh) {
          // ★ 子 Agent 继承（与 agent-teams 等多 Agent 插件联动）：
          //   当前 agent 的会话未绑定预设，但若它是某个 tavern 会话的子 Agent
          //   （session.header.parentSession 指向父会话），则继承父会话绑定的预设，
          //   让子 Agent 也能拿到主会话的世界观/角色卡/世界书。
          //   不依赖任何第三方插件存在：没有子 Agent 时本分支不触发，行为不变。
          let parentSid = ''
          try {
            parentSid = context?.agent?.session?.header?.parentSession || ''
          } catch {}
          if (parentSid && bindings[parentSid]) {
            sid = parentSid
            resolution = resolveAuthoritativePreset(sid)
            presetId = resolution.presetId
            // 注意：这里不写 lastSessionId —— 子 Agent（含孙 Agent，其 parentSid 本身仍是子会话）
            // 都不应成为「当前会话」；自动总结只在父会话自己的回合触发。
          } else {
            return ''
          }
        }
        // ★★ P0-2 停自动绑定（止血关键）★★
        //
        //   旧代码：只要解析出一个酒馆预设且 bindings 里没条目，就顺手写一条记账。
        //   于是「creation 里带着某个酒馆预设」或「父会话继承」这类**非用户操作**的来源
        //   也会被写成绑定 —— 用户从没选过的卡被固化进 bindings，之后再怎么在顶部
        //   切回 standard，都有一条「看起来像用户绑定」的记账躺在那里（9 条脏数据的来源）。
        //
        //   新规则：**只有决议来源是用户显式操作才写**：
        //     · source === 'explicit' —— 用户在聊天顶部选择器选的（agent-preset/selected）；
        //     · 面板 /api/tavern/bind-preset —— 另一条独立写入路径，见其 handler（本段不碰它）。
        //   其余（creation / legacy / 继承 / 兜底）一律不写，一个字都不动 bindings。
        if (sid && presetId && presetId !== DEFAULT_PRESET_ID && resolution.source === 'explicit') {
          try {
            writeBindingEntry(sid, { mode: 'preset', presetId, source: BINDING_SOURCE_TOP_SELECT })
          } catch {}
        }
        const presetMeta = readPresetsMeta().presets.find(p => p.id === presetId)
        const presetName = presetMeta?.name || '默认预设'
        // 调试日志
        try {
          fs.writeFileSync(path.join(ROOT, 'inject-debug.log'), '[' + new Date().toISOString() + '] sid=' + sid + ' presetId=' + presetId + ' presetName=' + presetName + '\n', { flag: 'a' })
        } catch {}

        // cwd 范围控制（保留兼容）+ sessionId 白名单
        const cwd = context?.agent?.session?.header?.cwd
        const cwdKey = (str => str ? String(str).replace(/[\\/]+$/, '') : '')(cwd)
        if (cwdKey) lastCwd = cwdKey
        const norm = (d) => String(d || '').trim().replace(/[\\/]+$/, '')
        const inCwdList = (arr) => cwdKey ? (arr || []).some(d => norm(d) === cwdKey) : false
        // ★ P0-5：生效范围判定收在纯函数 decideInjectionScope 里（语义见其注释）。
        //   默认状态（mode:'allowlist' + 两个名单都空）现在是**不放行**。
        const scope = decideInjectionScope(state, sid, cwdKey)
        let allowedBySession = scope.allowedBySession
        let allowedByCwd = scope.allowedByCwd
        // global 是显式全放行，但仍要看 disabledCwds 黑名单（与改动前一致）
        if (state.mode === 'global' && inCwdList(state.disabledCwds)) return ''
        if (!scope.allowed) return ''

        const text = cleanSillyTavernVars(cardTextFor(presetId))
        // ★ 开场白播种（2026-09-23 起）不再在这里挂监听。
        //
        //   旧做法：组装提示词时若 `session.log.length === 0` 就挂
        //   agent/inbox/inserted 监听 —— 但此刻日志里已有前置事件，条件永假，
        //   播种从未触发（greeting-seed.log 从未出现的根因）。
        //   新做法：开场白改由用户点面板「📌 开场白 → 注入开场白到会话末尾」触发
        //   （POST /api/tavern/greeting/insert）；本组装路径与自动播种都不再碰消息面
        //   —— 自动播种已因写坏会话日志而整体删除，见文件上方「── 角色卡开场白 ──」。
        try {
          fs.writeFileSync(path.join(ROOT, 'inject-debug.log'), '[' + new Date().toISOString() + '] sid=' + sid + ' presetId=' + presetId + ' allowedBySession=' + allowedBySession + ' allowedByCwd=' + allowedByCwd + ' textLen=' + (text ? text.length : 0) + '\n', { flag: 'a' })
        } catch {}
        if (!text) return ''
        // ★ 记忆总结注入（放在最前面，告诉 AI 只看总结）★
        //
        // ⚠️ 只吃**会话级**记忆。绝对不能回退到 readMemory(presetId)。
        //
        //   预设目录下的 memory.md 是「按预设累积」的历史文件：它不属于任何一条会话，
        //   任何绑定同一预设的会话（新建对话、子 Agent、甚至完全无关的另一段扮演）
        //   都会把整份读进自己的系统提示。于是「A 卡的剧情记忆被注入 B 卡」，
        //   而且**每开一条新对话都会重新注入一遍** —— 这就是本次故障的根因。
        //
        //   会话级记忆才是唯一正确的键：写的时候按 realSessionId 写，读的时候按 sid 读。
        //   历史遗留的预设记忆不会被删（留在磁盘上），需要时用
        //   POST api/tavern/memory/import-legacy 显式搬进某条会话，绝不自动分配。
        let summaryText = ''
        try {
          const mem = readSessionMemory(sid) || ''
          // 提取所有 # 记忆总结 部分
          const summaryMatches = mem.match(/# 记忆总结[\s\S]*?(?=\n# |\n> \[|$)/g)
          if (summaryMatches && summaryMatches.length > 0) {
            const summaries = summaryMatches.map(s => s.trim()).join('\n\n')
            summaryText = '【📝 对话历史总结（AI 请优先参考此总结，忽略之前的完整对话历史）】\n' + summaries + '\n\n'
          }
        } catch {}
        // ★ 正文组装整块下沉到 lib/server/assemble.js（S2-C2）：本文件只留装配 + 体积快照 + 观测。
        //   依赖显式传入 —— 本文件里那些函数多数被切片锚点钉住（搬不走），也不许被反向 import。
        const { body: cardOut, wbText } = assembleCardBody({
          summaryText, text, state, sid, presetId, ROOT,
          mode: presetMeta?.mode || 'roleplay',
          readState, readSessionMemory, readWorldbook, resolveWbIsFull,
          selectWorldbookEntries, buildWorldbookText, readSessionMessagesDirect,
          buildRelationsHintText, buildSkillsHintText, sanitizePromptText,
        })
        // 记录本轮体积：世界书单独记一笔，方便在面板里看出它占了多少
        sectionSizes.card = cardOut.length
        sectionSizes.wb = wbText ? wbText.length : 0
        // ★ P0-6 观测：本轮决议来源 + 内容指纹 + 体积（只记元数据，绝不记正文）
        try {
          observeInjection({
            sid, presetId, cardText: text, wbText,
            textLen: cardOut.length, allowedBySession, allowedByCwd,
          })
        } catch {}
        return cardOut
      }
    })
  }

  ctx.effect(() => {
    // 会话存储一度建在预设根目录里，会让 DSH 的预设管理器多出一行「加载失败」，先搬走。
    // ⚠️ 该迁移**非破坏性**：源目录有内容时绝不删（目标只是空壳则合并进去，目标已有内容则整份归档）。
    try {
      const m = migrateSessionStorageOutOfPresetRoot()
      if (m.moved || m.dropped || m.removed || m.archived || m.kept) {
        console.log('[dsh-tavern] 会话存储迁移：搬走 ' + m.moved
          + (m.merged ? '（其中 ' + m.merged + ' 条合并进已存在的空目录）' : '')
          + '，归档 ' + (m.archived || 0)
          + '，原样保留 ' + (m.kept || 0)
          + '，未搬进新位置（含空壳清理）' + m.dropped
          + (m.removed ? '，旧 sessions 目录已删除' : ''))
        if (m.lastArchive) console.log('[dsh-tavern] 归档位置：' + m.lastArchive)
      }
    } catch {}
    // 默认预设必须**带组合文件**落地，否则 DSH 的预设管理器会把它列成「加载失败」
    try { ensureDefaultPreset() } catch {}
    // ★ 启动时重建预设描述，移除目录丢失的孤儿条目，保证选择栏/编辑器/MUV 一致
    try { rebuildAllPresetDescriptions() } catch {}
    refresh(ctx)
    return () => { if (active) { active(); active = null } }
  }, 'tavern.card.section()')

  // ── 成人向提示段 `tavern:nsfw`（**用户自填正文的注入槽**）──────────────
  //
  // 设计要点（2026-10-04 恢复机制，正文改由使用者自己填）：
  //   · 插件只提供**槽位 + 开关**，正文取自 `state.nsfwPrompt` ——
  //     正文因此**不进代码、不进发布包**：不会随 npm 发布出门，也不会被升级覆盖；
  //   · 默认 `nsfwEnabled !== true` 且正文为空 ⇒ 升级到本版**零行为变化**（一个字节都不注入）；
  //   · 与会话隔离/生效范围**同一判据**（`isTavernSession` + `decideInjectionScope`），
  //     不会出现「绑了 A 卡却在 B 会话被注入」那类串台；
  //   · `order: -1`：本段先于 `tavern:card` 组装；体积快照 `flushPromptStats()`
  //     原先由已删除的「历史事实修正」注入段负责落盘，现在改由本段（nsfw）在每次
  //     text() 返回前调用一次 —— 落盘逻辑本身不变，**勿动**。
  //
  // 正文写什么、要不要用，是使用者自己的事；插件的职责到此为止。
  let activeNsfw = null
  activeNsfw = ctx.systemPrompt.section({
    name: 'tavern:nsfw',
    order: -1,
    text: (context) => {
      sectionSizes.nsfw = 0
      try {
        const state = readState()
        if (state.nsfwEnabled !== true) { flushPromptStats(); return '' }
        const body = typeof state.nsfwPrompt === 'string' ? state.nsfwPrompt.trim() : ''
        if (!body) { flushPromptStats(); return '' }
        const sid = context?.agent?.session?.id || context?.agent?.session?.header?.id
        if (!sid) { flushPromptStats(); return '' }
        if (!isTavernSession(sid, context)) { flushPromptStats(); return '' }
        const cwd = context?.agent?.session?.header?.cwd
        const cwdKey = (str => str ? String(str).replace(/[\\/]+$/, '') : '')(cwd)
        const norm = (d) => String(d || '').trim().replace(/[\\/]+$/, '')
        // 与 tavern:card 同一套范围判定：先统一闸门，再看 cwd 黑名单（global 也受它约束）
        if (state.mode === 'global' && cwdKey && (state.disabledCwds || []).some(d => norm(d) === cwdKey)) { flushPromptStats(); return '' }
        const scope = decideInjectionScope(state, sid, cwdKey)
        if (!scope.allowed) { flushPromptStats(); return '' }
        sectionSizes.nsfw = body.length
        flushPromptStats()
        return body
      } catch { flushPromptStats(); return '' }
    },
  })

  ctx.effect(() => {
    return () => { if (activeNsfw) { activeNsfw(); activeNsfw = null } }
  }, 'tavern.nsfw.section()')

  // ── （已删除）通用增强层：运行时注入 ─────────────────────────
  //
  // 这里原先注册 `tavern:enhance` 段：在 system prompt 最后追加「文风 / 防抢话 / 防全知 /
  // 抗过拟合」的通用约束。**按用户要求整层删除** —— 这类要求交给 SillyTavern 预设去表达
  // （预设是数据，用户自己写得比插件猜得准），插件只负责把预设原样送进提示词。
  //
  // 连同底层一起删：lib/utils.js 的 ENHANCE_* 纯函数、lib/preset-enhance-pack.json 模块包、
  // `/api/tavern/preset/enhance` 路由、以及 tests/preset-enhance.test.js。
  // 现在插件里**没有任何**"通用约束"的自动注入路径。

  // ── API 路由 ────────────────────────────────────────────
  // ★ 路由依赖（S2-C2 后半 / task-7）：由搬迁器从**函数体**反推（不是手抄清单）。
  //   `lastSessionId` / `lastCwd` / `active` 必须是**访问器**而不是值 —— 它们会被注入段的 text 回调同时读写。
  const routeDeps = {
    BINDING_SOURCE_PANEL, S, SKILL_NAME_RE, applyPresetDeclarations,
    composePresetDeclarationBlock, createPreset, deleteAgentPreset, deletePresetSkill,
    extractCardText, getCtxService, getPresetDir, getSessionPresetId,
    json, listAgentPresets, listSkillsOnDisk, nativePresetRoster,
    presetSkillNames, readBody, readDeclarationMode, readPresetFiles,
    readState, readWorldbook, refresh, renderAllPresetDeclarations,
    renderPresetBundleFiles, resolveWbIsFull, setPresetSkillNames, skillNameForPreset,
    skillsRoot, writeBindingEntry, writeDeclarationMode, writePresetBundle,
    writePresetSkill, writeState, 
    getLastSid: () => lastSessionId,
    setLastSid: (v) => { lastSessionId = v },
  }
  registerRoutes(ctx, routeDeps)
  const routes = [
    // 获取后端当前会话ID（确保前后端一致）
    // 注意：只返回 DSH 注入上下文里的真实会话（lastSessionId）。
    // 前端通过 ctx.sessions（DSH 官方会话服务）获取"当前 UI 激活会话"并显式传入 sessionId，
    // 后端不再自行兜底猜测会话（否则切换会话后会错误返回旧会话的数据）。
    {
      kind: 'exact',
      path: '/api/tavern/bind-preset',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then(async (body) => {
          try {
            // ★ 收紧（2026-09-27，装机版已有，此处并入仓库）：写绑定的入口绝不猜会话 ——
            //   漏传 sessionId 直接 400，不再兜底 lastSessionId（全进程全局量，可能指向
            //   别的会话 ⇒ 绑错会话 = 串台写）。
            const sessionId = String(body.sessionId || '').trim()
            const presetId = body.presetId
            if (!sessionId || !presetId) { json(res, 400, { ok: false, error: '缺少会话ID或预设ID（sessionId/presetId 必传）' }); return }
            // ★ P0-1：presetId 传 'none' 即解绑本会话（写 {mode:'none'} 硬空），
            //   方便面板复用同一个接口；也有独立的 /api/tavern/unbind-preset。
            if (presetId === 'none') {
              json(res, 200, { ok: true, sessionId, presetId: '', unbound: true, binding: writeBindingEntry(sessionId, { mode: 'none' }) })
              return
            }
            lastSessionId = sessionId
            // ★ 检测会话是否已开始（是否有 user 消息）：已开始的会话 agent 预设本体被 DSH 锁定
            //   （agentPreset 只在空白会话可切换）。返回 locked 标记，前端据此给出明确提示。
            let started = false
            try {
              const file = findSessionFile(sessionId)
              if (file) {
                const lines = readSessionLines(file)
                for (let i = lines.length - 1; i >= 0; i--) {
                  try {
                    const o = JSON.parse(lines[i])
                    if (o && (o.type === 'user/message' || o.type === 'user/input' || o.type === 'agent/message')) { started = true; break }
                  } catch {}
                }
              }
            } catch {}
            // 说明：仍然**不**直接改写 DSH 会话日志文件（**曾**有一个 writeSessionLines() 会重写整个 zstd 会话日志，已随本功能删除；**不要**再引入这种写法
            // seq/帧处理不当会破坏 DSH 会话 ⇒ "corrupt session log"）。改走 DSH 自己的服务：
            // `agentPresets.select(agent, presetId)` 由 DSH 负责把 `agent-preset/selected`
            // 追加进**本会话**的事件流 —— 这就是「会话绑定 = 该会话的原生 agentPreset」，
            // 也是空白新会话（还没发过消息）就能绑定的原因。
            // ★ 顺序：先原生 select（正路），再写 bindings（兼容兜底：原生不可用 / 会话已开跑时,
            //   至少保住世界书与记忆的跟随）。两者都以 sessionId 为键 ⇒ 天然会话隔离。
            const native = await selectNativeAgentPreset(ctx, sessionId, presetId)
            // ★ 账本里存**DSH 侧 id（目录名）**，不存酒馆别名：'default' 在本插件里同时是
            //   「不注入」的哨兵值，存别名会让「绑了酒馆默认」被解析成「没绑」（卡不注入）。
            //   面板仍然用酒馆 id 通信（响应里 presetId 原样回），只有落盘的这份用目录名。
            writeBindingEntry(sessionId, { mode: 'preset', presetId: agentPresetIdFor(presetId), source: BINDING_SOURCE_PANEL })
            const preset = listPresets().find(p => p.id === presetId)
            json(res, 200, {
              ok: true, presetId, presetName: preset?.name || presetId, started,
              native,
              nativeOk: native.ok === true,
              // locked = 会话已开跑，DSH 拒绝换卡本体（原生闸门），面板据此给准确提示
              locked: native.reason === 'locked' || (native.started === true && native.ok !== true),
            })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 解绑本会话：POST /api/tavern/unbind-preset
    // ★ P0-1：写 {mode:'none'} —— 硬空，此后不看 creation、不看任何 fallback。
    {
      kind: 'exact',
      path: '/api/tavern/unbind-preset',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then(async (body) => {
          try {
            const sessionId = body.sessionId || lastSessionId
            if (!sessionId) { json(res, 400, { ok: false, error: '缺少会话ID，请先发一条消息再试' }); return }
            // ★ 解绑 = 把会话**原生**交还给 DSH 的部署默认预设（settings.yaml 的
            //   agent-presets.default，实测 standard）。只写 {mode:'none'} 的话，
            //   顶部选择器仍显示酒馆卡、DSH 侧仍挂着它 —— 那不是解绑，只是酒馆自己不再注入。
            //   会话已开跑时原生换不了（DSH 锁定）⇒ 该次失败如实回报，bindings 的硬空仍生效，
            //   于是「不再注入」这条语义在任何情况下都成立。
            const native = await selectNativeAgentPreset(ctx, sessionId, readDshDefaultAgentPresetId())
            json(res, 200, {
              ok: true, sessionId, binding: writeBindingEntry(sessionId, { mode: 'none' }),
              native, nativeOk: native.ok === true,
              restoredTo: native.ok ? native.presetId : '',
            })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 读取单个预设：GET /api/tavern/preset?id=xxx
    {
      kind: 'exact',
      path: '/api/tavern/preset',
      handler: (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (req.method === 'GET') {
          try {
            const presetId = url.searchParams.get('id') || getSessionPresetId(lastSessionId)
            const files = readPresetFiles(presetId)
            const meta = readPresetsMeta().presets.find(p => p.id === presetId)
            json(res, 200, { ok: true, presetId, name: meta?.name || '', ...files, cardChars: extractCardText(files.agentYml).length })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const presetId = body.id || body.presetId || getSessionPresetId(lastSessionId)
              const dir = writePresetFiles(presetId, body.agentYml, body.presetYml)
              refresh(ctx)
              json(res, 200, { ok: true, dir, presetId })
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // 删除预设：POST /api/tavern/preset/delete {id}
    {
      kind: 'exact',
      path: '/api/tavern/preset/delete',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            // 删预设时顺带清掉它生成的 skill —— 否则 ~/.dsh/skills 会慢慢堆一堆孤儿 skill，
            // 而且它们还留在 skill 目录里被模型整轮看到（比"删了预设却还在"更烦人）。
            let skillCleanup = null
            try {
              const pid = String((body && body.id) || '').trim()
              if (pid) skillCleanup = deletePresetSkill(pid)
            } catch (e) { skillCleanup = { ok: false, error: String((e && e.message) || e) } }
            deletePreset(body.id)
            json(res, 200, { ok: true, presets: listPresets(), skill: skillCleanup })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 重命名预设：POST /api/tavern/preset/rename {id,name}
    {
      kind: 'exact',
      path: '/api/tavern/preset/rename',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const p = renamePreset(body.id, body.name)
            json(res, 200, { ok: true, preset: p })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 设置预设模式（roleplay/creative）
    {
      kind: 'exact',
      path: '/api/tavern/preset/mode',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const meta = readPresetsMeta()
            const p = meta.presets.find(x => x.id === body.id)
            if (!p) throw new Error('预设不存在')
            p.mode = body.mode === 'creative' ? 'creative' : 'roleplay'
            fs.writeFileSync(PRESETS_META, JSON.stringify(meta, null, 2), 'utf8')
            json(res, 200, { ok: true, preset: p })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // ★ 新增：会话绑定 ★
    {
      kind: 'exact',
      path: '/api/tavern/bind',
      handler: (req, res) => {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, 'http://localhost')
            const sessionId = url.searchParams.get('sessionId') || lastSessionId || ''
            const presetId = getSessionPresetId(sessionId)
            const presetMeta = readPresetsMeta().presets.find(p => p.id === presetId)
            // 顺带把「本会话设定注入量」一起给面板：面板要么显示"这一场是全量"，
            // 要么显示"跟随规则"——别让它自己猜（猜错了用户就以为设定没进去）。
            const st0 = readState()
            const wb0 = readWorldbook(presetId)
            const wbOverride = (st0.wbInjectBySession && sessionId) ? (st0.wbInjectBySession[sessionId] || '') : ''
            json(res, 200, {
              ok: true,
              sessionId,
              presetId,
              presetName: presetMeta?.name || '默认预设',
              wbOverride,
              wbEffective: resolveWbIsFull(st0, wb0, sessionId) ? 'full' : 'keyword',
              wbInjectGlobal: st0.wbInject || 'follow',
              wbCardInjectMode: wb0.injectMode === 'keyword' ? 'keyword' : 'full',
            })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const sid = body.sessionId || lastSessionId
              const pid = setSessionPreset(sid, body.presetId)
              refresh(ctx)
              const presetMeta = readPresetsMeta().presets.find(p => p.id === pid)
              json(res, 200, { ok: true, sessionId: sid, presetId: pid, presetName: presetMeta?.name || '默认预设' })
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // ★ 兼容旧版：读取（操作当前会话绑定的预设） ★
    {
      kind: 'exact',
      path: '/api/tavern/read',
      handler: (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const url = new URL(req.url, 'http://localhost')
          const sid = url.searchParams.get('sessionId') || lastSessionId
          if (sid) lastSessionId = sid // 主动更新 lastSessionId
          const presetId = url.searchParams.get('presetId') || getSessionPresetId(sid)
          const files = readPresetFiles(presetId)
          const state = readState()
          const presetMeta = readPresetsMeta().presets.find(p => p.id === presetId)
          json(res, 200, {
            ok: true,
            ...files,
            presetId,
            presetName: presetMeta?.name || '默认预设',
            cardEnabled: state.cardEnabled !== false,
            injected: active !== null,
            cardChars: extractCardText(files.agentYml).length,
            disabledCwds: state.disabledCwds || [],
            allowCwds: state.allowCwds || [],
            mode: state.mode || 'global',
            currentCwd: lastCwd,
            currentSessionId: lastSessionId || sid,
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }
    },

    // ★ 兼容旧版：保存（操作当前会话绑定的预设，或指定 presetId） ★
    {
      kind: 'exact',
      path: '/api/tavern/save',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || lastSessionId
            if (sid) lastSessionId = sid
            const presetId = body.presetId || getSessionPresetId(sid)
            // ★ dataOnly：前端自动保存数据（世界书/角色卡/预设开关）时，
            //   不重新生成 agent.cordis.yml（agent 预设只能手动「保存预设」生成）。
            if (body.dataOnly) {
              body.agentYml = undefined
              body.presetYml = undefined
            }

    if (body.characters) body.characters = cleanObjectStrings(body.characters)
    if (body.worldbooks) body.worldbooks = cleanObjectStrings(body.worldbooks)
            const dir = writePresetFiles(presetId, body.agentYml, body.presetYml, body.characters, body.worldbooks, body.presets)
            // 更新预设简介：★ 从磁盘真实文件重建（不信任 body.characters，避免保存失败/缺字段导致描述错位）
            try {
              rebuildAllPresetDescriptions()
            } catch (e) { /* 忽略简介重建错误 */ }
              // 生成预设简介：角色卡/世界书/预设模块 + 极简模式标记，并写入 preset.yml
              try {
                const charCount2 = Array.isArray(body.characters) ? body.characters.length : 0
                const wbCount2 = Array.isArray(body.worldbooks) ? body.worldbooks.length : 0
                const modCount2 = Array.isArray(body.presets) ? body.presets.length : 0
                const charNames2 = Array.isArray(body.characters) ? body.characters.map(c => c.name || '未知').join('、') : ''
                // ★ 名字来源优先级：本次保存带来的 presetYml → 磁盘上已有的 preset.yml → 注册表。
                //   **绝不**退到 presetId（那是目录名）。dataOnly 自动保存不带 presetYml，
                //   早先这里就把「酒馆默认」覆盖成了「tavern-lite」，DSH 顶部选择器跟着显示目录名。
                const pickName = (text) => {
                  const m = /^[ \t]*name[ \t]*:[ \t]*(.+)$/m.exec(String(text || ''))
                  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
                }
                let nameFromDisk = ''
                let curDirName = ''
                try {
                  const curDir = getPresetDir(presetId)
                  if (curDir) {
                    curDirName = path.basename(curDir)
                    nameFromDisk = pickName(fs.readFileSync(path.join(curDir, 'preset.yml'), 'utf8'))
                  }
                } catch (e) { /* 读不到就往下退 */ }
                // 磁盘上的名字若等于目录名/预设 id，那是历史 bug 的痕迹（不是用户起的名），
                // 丢掉它 → 落到注册表真名，让 preset.yml 在下次保存时自愈。
                if (nameFromDisk && (nameFromDisk === curDirName || nameFromDisk === presetId) && !pickName(body.presetYml)) nameFromDisk = ''
                const presetDisplayName = pickName(body.presetYml) || nameFromDisk || presetDisplayNameFor(presetId)
                const richDesc = `🎭 ${charNames2 || '无角色卡'} | 📚 ${wbCount2}本世界书 | ⚙️ ${modCount2}个预设模块 | 最后更新: ${new Date().toLocaleString('zh-CN')}`
                writePresetNameFile(presetId, presetDisplayName, richDesc)
              } catch (e) { /* 忽略简介写入错误 */ }

            refresh(ctx)
            const state = readState()
            // ★ 保存预设的同时生成/更新 skill（用户要的"点保存就生成"）。
            //   **best-effort**：写 skill 失败绝不能让"保存预设"失败 —— 只把结果如实带回给面板。
            const skill = syncPresetSkillAfterSave(presetId, state)
            // ★ 保存之后把声明同步一次 —— 只在**真的写了组合文件**时（dataOnly 自动保存不算）。
            //   为什么必须在"保存后"：声明是从 agent.cordis.yml 渲染的，而新建时的骨架没有任何
            //   内容 ⇒ 创建那一刻同步出去的那行是空壳，且此后再没人重新渲染它，
            //   DSH 名册里就永久停着那张「有名字却不起作用」的卡。
            //   syncDeclarationsBestEffort 内部：未启用声明 = no-op；内容没变 = 不写盘不备份。
            const declarations = typeof body.agentYml === 'string'
              ? syncDeclarationsBestEffort('save')
              : { ok: true, skipped: 'dataOnly' }
            json(res, 200, { ok: true, dir, presetId, cardEnabled: state.cardEnabled !== false, injected: active !== null, skill, declarations })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // ★ 手动注入开场白（旧会话的补救入口；自动播种失败的退路）
    //   POST /api/tavern/greeting/insert { presetId?, cardName?, sessionId? }
    //     · sessionId 缺省用 lastSessionId（后端最近见过的当前会话）；
    //     · presetId 缺省按会话权威解析（getSessionPresetId）；
    //     · 从该 preset 的 characters.json 取启用中第一张卡（或 body.cardName）的 first，
    //       往会话**末尾** append 一条 assistant 消息（tavern/character-card）。
    //   ★ 防重复（2026-09-23）：会话里已有 source.model==='character-card' 的 assistant 楼
    //     ⇒ 直接 200 { ok:false, error:'greeting-already-present' }，不再叠加第二条开场白。
    //   返回 { ok, inserted, cardName, greetingLen, turn }；找不到卡/会话 → { ok:false, error }。
    {
      kind: 'exact',
      path: '/api/tavern/greeting/insert',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = String((body && body.sessionId) || lastSessionId || '')
            if (!sid) { json(res, 400, { ok: false, error: 'no-session：请求没带 sessionId，后端也没有当前会话记录' }); return }
            const agent = liveAgents.get(sid)
            const session = agent && agent.session
            if (!session) {
              json(res, 404, { ok: false, error: 'session-not-live：会话 ' + sid.slice(0, 24) + ' 当前没有活跃的 Session 对象（先在 DSH 里打开该会话并发一条消息，再回来注入）' })
              return
            }
            const presetId = String((body && body.presetId) || getSessionPresetId(sid) || '')
            if (!presetId || presetId === DEFAULT_PRESET_ID || !isTavernPresetDir(presetId)) {
              json(res, 400, { ok: false, error: 'no-preset：会话未绑定酒馆预设（presetId=' + presetId + '）' })
              return
            }
            const r = insertGreetingForSession(session, presetId, body && body.cardName)
            if (!r.ok) {
              // 已注入过 = 请求没问题，只是无事可做 ⇒ 200 + ok:false（面板显示「本会话已有开场白」）；
              // append 失败属服务端 ⇒ 500；其余（找不到卡 / 卡没开场白）⇒ 404。
              const status = r.error === 'greeting-already-present' ? 200 : (/^append-failed/.test(r.error) ? 500 : 404)
              json(res, status, { ok: false, error: r.error })
              return
            }
            const turn = r.turn
            try {
              const phase = agent && agent.phase
              if (phase && phase.kind === 'idle' && phase.lastTurn < turn) phase.lastTurn = turn
            } catch {}
            noteGreetingLog(presetId, '', true, 'manual turn=' + turn + ' card=' + r.cardName + ' sid=' + sid.slice(0, 24))
            json(res, 200, { ok: true, inserted: true, cardName: r.cardName, greetingLen: r.greetingLen, turn })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 状态（全局，保留）
    {
      kind: 'exact',
      path: '/api/tavern/state',
      handler: (req, res) => {
        if (req.method === 'GET') {
          const state = readState()
          json(res, 200, { ok: true, cardEnabled: state.cardEnabled !== false, toolsEnabled: state.toolsEnabled !== false, injected: active !== null, networkEnabled: state.networkEnabled === true, antiCliche: state.antiCliche !== false, disabledCwds: state.disabledCwds || [], allowCwds: state.allowCwds || [], allowSessions: state.allowSessions || [], mode: state.mode || 'global', plotOptions: state.plotOptions !== false, relationsHint: state.relationsHint !== false, skillAutoGenerate: state.skillAutoGenerate !== false, skillAutoFull: state.skillAutoFull === true, skillHint: state.skillHint !== false, skillsDir: state.skillsDir || '', wbInject: state.wbInject || 'follow', nsfwEnabled: state.nsfwEnabled === true, nsfwPrompt: state.nsfwPrompt || '', promptWindowTokens: state.promptWindowTokens, currentCwd: lastCwd, currentSessionId: lastSessionId })
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            const state = readState()
            if (typeof body.cardEnabled === 'boolean') state.cardEnabled = body.cardEnabled
            if (typeof body.toolsEnabled === 'boolean') {
              state.toolsEnabled = body.toolsEnabled
            }
            // ★ P2-1 世界书注入逃生阀：只认 'follow' / 'full' 两个值（非法值不落盘）
            if (body.wbInject === 'follow' || body.wbInject === 'full') state.wbInject = body.wbInject
            if (body.mode === 'global' || body.mode === 'allowlist') state.mode = body.mode
            if (body.disabledCwds !== undefined) state.disabledCwds = (Array.isArray(body.disabledCwds) ? body.disabledCwds : []).map(s => String(s).trim()).filter(Boolean)
            if (body.allowCwds !== undefined) state.allowCwds = (Array.isArray(body.allowCwds) ? body.allowCwds : []).map(s => String(s).trim()).filter(Boolean)
            if (body.allowSessions !== undefined) state.allowSessions = (Array.isArray(body.allowSessions) ? body.allowSessions : []).map(s => String(s).trim()).filter(Boolean)
            // 成人向提示段：只有"开关 + 正文"两个键；正文只存在本机 state 里
            if (typeof body.nsfwEnabled === 'boolean') state.nsfwEnabled = body.nsfwEnabled
            if (typeof body.nsfwPrompt === 'string') {
              // 上限 20000 字符：正常提示段几百到几千字，超长只可能是误操作
              state.nsfwPrompt = body.nsfwPrompt.slice(0, 20000)
            }
            if (typeof body.plotOptions === 'boolean') state.plotOptions = body.plotOptions
            if (typeof body.networkEnabled === 'boolean') state.networkEnabled = body.networkEnabled
            if (typeof body.antiCliche === 'boolean') state.antiCliche = body.antiCliche
            if (typeof body.relationsHint === 'boolean') state.relationsHint = body.relationsHint
            // 技能：自动生成 / 世界书全文 / 会话指针 / 自定义 skill 根
            if (typeof body.skillAutoGenerate === 'boolean') state.skillAutoGenerate = body.skillAutoGenerate
            if (typeof body.skillAutoFull === 'boolean') state.skillAutoFull = body.skillAutoFull
            if (typeof body.skillHint === 'boolean') state.skillHint = body.skillHint
            if (body.skillStyle === 'index' || body.skillStyle === 'instructions') state.skillStyle = body.skillStyle
            if (typeof body.skillsDir === 'string') state.skillsDir = body.skillsDir.trim()
            // （已移除）enhanceRuntime：通用增强层运行时段已按用户要求整层删除，不再接受该开关
            // 上下文窗口（token），用于体积占比告警
            if (body.promptWindowTokens !== undefined) {
              const w = Number(body.promptWindowTokens)
              if (Number.isFinite(w) && w >= 1024) state.promptWindowTokens = Math.round(w)
            }
            writeState(state)
            refresh(ctx)
            json(res, 200, { ok: true, cardEnabled: state.cardEnabled !== false, toolsEnabled: state.toolsEnabled !== false, injected: active !== null, networkEnabled: state.networkEnabled === true, antiCliche: state.antiCliche !== false, disabledCwds: state.disabledCwds || [], allowCwds: state.allowCwds || [], allowSessions: state.allowSessions || [], mode: state.mode || 'global', plotOptions: state.plotOptions !== false, relationsHint: state.relationsHint !== false, skillAutoGenerate: state.skillAutoGenerate !== false, skillAutoFull: state.skillAutoFull === true, skillHint: state.skillHint !== false, skillsDir: state.skillsDir || '', wbInject: state.wbInject || 'follow', nsfwEnabled: state.nsfwEnabled === true, nsfwPrompt: state.nsfwPrompt || '', promptWindowTokens: state.promptWindowTokens, currentCwd: lastCwd, currentSessionId: lastSessionId })
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // （已删除）/api/tavern/preset/enhance：通用增强层已连根移除
    // 记忆配置（全局，保留）
    {
      kind: 'exact',
      path: '/api/tavern/config',
      handler: (req, res) => {
        if (req.method === 'GET') {
          const st = readState()
          json(res, 200, { ok: true, mem: st.mem || {}, playerName: st.playerName || '', antiCliche: st.antiCliche !== false, relationsHint: st.relationsHint !== false, bannedWords: st.bannedWords || [], networkEnabled: st.networkEnabled === true, dshConnections: listDshConnections(), currentCwd: lastCwd, currentSessionId: lastSessionId })
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            const st = readState()
            const m = st.mem || {}
            if (typeof body.apiUrl === 'string') m.apiUrl = body.apiUrl.trim()
            if (typeof body.apiKey === 'string') m.apiKey = body.apiKey.trim()
            if (typeof body.model === 'string') m.model = body.model.trim() || 'deepseek-chat'
            if (typeof body.autoEnabled === 'boolean') m.autoEnabled = body.autoEnabled
            if (typeof body.autoEvery === 'number' && Number.isFinite(body.autoEvery) && body.autoEvery >= 1) m.autoEvery = Math.floor(body.autoEvery)
            if (typeof body.useDsh === 'boolean') m.useDsh = body.useDsh
            if (typeof body.dshConnection === 'string') m.dshConnection = body.dshConnection.trim()
            if (typeof body.dshModel === 'string') m.dshModel = body.dshModel.trim()
            if (typeof body.playerName === 'string') { st.playerName = body.playerName.trim(); S.playerName = st.playerName }
            if (typeof body.antiCliche === 'boolean') st.antiCliche = body.antiCliche
            if (typeof body.relationsHint === 'boolean') st.relationsHint = body.relationsHint
            if (Array.isArray(body.bannedWords)) st.bannedWords = body.bannedWords.map(w => String(w).trim()).filter(Boolean)
            if (typeof body.networkEnabled === 'boolean') st.networkEnabled = body.networkEnabled
            st.mem = m
            writeState(st)
            try { refresh(ctx) } catch {}
            json(res, 200, { ok: true, mem: m, antiCliche: st.antiCliche !== false, relationsHint: st.relationsHint !== false, bannedWords: st.bannedWords || [], networkEnabled: st.networkEnabled === true })
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // 总结
    {
      kind: 'exact',
      path: '/api/tavern/summarize',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          const st = readState()
          const want = Number.isFinite(body.rounds) ? Math.max(1, Math.floor(body.rounds)) : (st.mem?.autoEvery || 20)
          const sid = String(body.sessionId || lastSessionId || '')
          const presetId = getSessionPresetId(sid)
          const before = st.mem?.lastSeq || 0
          runSummary(ctx, st, sid, presetId, true)
            .then((out) => {
              const st2 = readState()
              st2.mem = st2.mem || {}
              st2.mem.lastSeq = Math.max(before || 0, (st2.mem.lastSeq || 0))
              writeState(st2)
              // 总结完成后自动刷新系统提示，让总结内容立即注入
              try { refresh(ctx) } catch {}
              json(res, 200, { ok: true, ...out, rounds: want, sessionId: sid, presetId })
            })
            .catch((e) => json(res, 500, { ok: false, error: e.message }))
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 关系网（基于当前会话预设）
    {
      kind: 'exact',
      path: '/api/tavern/relations',
      handler: (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') || lastSessionId || ''
        const useSession = !!sessionId
        if (req.method === 'GET') {
          try {
            const data = useSession ? readSessionRelations(sessionId) : { nodes: [], edges: [] }
            json(res, 200, { ok: true, relations: data, sessionId: sessionId || null })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const sid = body.sessionId || sessionId
              if (sid) {
                writeSessionRelations(sid, body.relations || { nodes: [], edges: [] })
                json(res, 200, { ok: true, sessionId: sid })
              } else {
                const pid = body.presetId || getSessionPresetId(lastSessionId)
                writeRelations(pid, body.relations || { nodes: [], edges: [] })
                json(res, 200, { ok: true, presetId: pid })
              }
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // 世界书（结构化 + 关键词触发）
    {
      kind: 'exact',
      path: '/api/tavern/worldbook',
      handler: (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const sid = url.searchParams.get('sessionId') || lastSessionId
        if (sid) lastSessionId = sid
        const presetId = url.searchParams.get('presetId') || getSessionPresetId(sid)
        if (req.method === 'GET') {
          try {
            const data = readWorldbook(presetId)
            json(res, 200, { ok: true, ...data, presetId, sessionId: sid || null })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const pid = body.presetId || presetId
              // 未显式传 injectMode 时保留预设里已有的模式。
              // 面板保存条目/分组时不带 injectMode，若默认成 'full' 就会把
              // 别处（独立设置页、另一个标签页）刚改好的模式悄悄改回去。
              let keepMode = 'full'
              if (body.injectMode === undefined || body.injectMode === null) {
                try { keepMode = readWorldbook(pid).injectMode || 'full' } catch { keepMode = 'full' }
              }
              const data = {
                entries: Array.isArray(body.entries) ? body.entries : [],
                injectMode: (body.injectMode === undefined || body.injectMode === null)
                  ? keepMode
                  : (body.injectMode === 'keyword' ? 'keyword' : 'full'),
                groups: Array.isArray(body.groups) ? body.groups : []
              }
              writeWorldbook(pid, data)
              json(res, 200, { ok: true, presetId: pid, injectMode: data.injectMode })
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // 世界书导出为 Markdown
    {
      kind: 'exact',
      path: '/api/tavern/worldbook/export',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || lastSessionId
            if (sid) lastSessionId = sid
            const presetId = body.presetId || getSessionPresetId(sid)
            const wb = readWorldbook(presetId)
            const dir = getPresetDir(presetId)
            if (!dir) throw new Error('预设不存在')
            const mdPath = path.join(dir, 'worldbook.md')
            const lines = ['# 世界书', '', `注入模式：${wb.injectMode === 'keyword' ? '关键词触发' : '全文注入'}`, '']
            for (const e of wb.entries) {
              lines.push(`## ${e.name || '未命名条目'}`)
              lines.push('')
              lines.push(`- **启用**：${e.enabled === false ? '否' : '是'}`)
              lines.push(`- **关键词**：${(e.keywords || []).join(', ') || '无'}`)
              lines.push(`- **位置**：${e.position || 'before_char'}`)
              lines.push('')
              lines.push('### 内容')
              lines.push('')
              lines.push(e.content || '')
              lines.push('')
              lines.push('---')
              lines.push('')
            }
            fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
            json(res, 200, { ok: true, path: mdPath, entryCount: wb.entries.length })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 世界书从 Markdown 导入
    {
      kind: 'exact',
      path: '/api/tavern/worldbook/import',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || lastSessionId
            if (sid) lastSessionId = sid
            const presetId = body.presetId || getSessionPresetId(sid)
            const dir = getPresetDir(presetId)
            if (!dir) throw new Error('预设不存在')
            const mdPath = body.path || path.join(dir, 'worldbook.md')
            if (!fs.existsSync(mdPath)) throw new Error('Markdown 文件不存在: ' + mdPath)
            const md = fs.readFileSync(mdPath, 'utf8')
            // 简单解析：按 ## 分割条目
            const sections = md.split(/^## /m).slice(1)
            const entries = []
            for (const sec of sections) {
              const lines = sec.split('\n')
              const name = lines[0].trim()
              let content = ''
              let keywords = []
              let enabled = true
              let inContent = false
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i]
                if (line.startsWith('- **关键词**：')) {
                  const kw = line.replace('- **关键词**：', '').trim()
                  if (kw && kw !== '无') keywords = kw.split(',').map(s => s.trim()).filter(Boolean)
                } else if (line.startsWith('- **启用**：')) {
                  enabled = !line.includes('否')
                } else if (line.startsWith('### 内容')) {
                  inContent = true
                } else if (inContent && line !== '---') {
                  content += line + '\n'
                }
              }
              entries.push({
                id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                name, keywords, content: content.trim(), enabled, position: 'before_char'
              })
            }
            const wb = readWorldbook(presetId)
            wb.entries = entries
            writeWorldbook(presetId, wb)
            json(res, 200, { ok: true, entryCount: entries.length, presetId })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 用系统编辑器打开世界书 Markdown
    {
      kind: 'exact',
      path: '/api/tavern/worldbook/open',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then(async (body) => {
          try {
            const sid = body.sessionId || lastSessionId
            if (sid) lastSessionId = sid
            const presetId = body.presetId || getSessionPresetId(sid)
            const dir = getPresetDir(presetId)
            if (!dir) throw new Error('预设不存在')
            const mdPath = path.join(dir, 'worldbook.md')
            // 先导出（确保文件最新）
            const wb = readWorldbook(presetId)
            const lines = ['# 世界书', '', `注入模式：${wb.injectMode === 'keyword' ? '关键词触发' : '全文注入'}`, '']
            for (const e of wb.entries) {
              lines.push(`## ${e.name || '未命名条目'}`, '', `- **启用**：${e.enabled === false ? '否' : '是'}`, `- **关键词**：${(e.keywords || []).join(', ') || '无'}`, `- **位置**：${e.position || 'before_char'}`, '', '### 内容', '', e.content || '', '', '---', '')
            }
            fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
            // 用系统默认编辑器打开
            const { exec } = await import('node:child_process')
            const cmd = process.platform === 'win32' ? `start "" "${mdPath}"` : process.platform === 'darwin' ? `open "${mdPath}"` : `xdg-open "${mdPath}"`
            exec(cmd, (err) => {
              if (err) json(res, 500, { ok: false, error: err.message })
              else json(res, 200, { ok: true, path: mdPath })
            })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 记忆（基于当前会话预设）
    {
      kind: 'exact',
      path: '/api/tavern/memory',
      handler: (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') || lastSessionId || ''
        const useSession = !!sessionId
        if (req.method === 'GET') {
          try {
            const text = useSession ? readSessionMemory(sessionId) : readMemory(url.searchParams.get('presetId') || getSessionPresetId(lastSessionId))
            json(res, 200, { ok: true, memory: text, sessionId: sessionId || null })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const sid = body.sessionId || sessionId
              // ★ 源头清理记忆文本里的 SillyTavern 变量（记忆会注入 tavern:card，残留 {{}} 会报错）
              const cleanMem = cleanSillyTavernVars(String(body.memory || ''))
              if (sid) {
                const f = sessionMemoryFile(sid)
                fs.mkdirSync(path.dirname(f), { recursive: true })
                fs.writeFileSync(f, cleanMem, 'utf8')
                json(res, 200, { ok: true, sessionId: sid })
              } else {
                const pid = body.presetId || getSessionPresetId(lastSessionId)
                const f = memoryFile(pid)
                fs.mkdirSync(path.dirname(f), { recursive: true })
                fs.writeFileSync(f, cleanMem, 'utf8')
                json(res, 200, { ok: true, presetId: pid })
              }
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },
    // 历史遗留「预设级记忆」的显式搬入（迁移用；不自动执行）
    //
    // 背景：注入端曾回退到「预设目录下的 memory.md」—— 那是按预设累积的共享文件，
    //   会把别的会话、别的卡的剧情带进当前对话（已修）。历史文件**不删**、
    //   也**绝不自动分配**给任何会话（没有依据判断哪条会话才是它的主人），
    //   改由用户在某条会话里显式调用本接口搬进来。
    //
    // body: { sessionId, confirm?: true, mode?: 'append' | 'replace', presetId? }
    //   不带 confirm → 只回预览（条目数 / 字数 / 文件路径），不落盘。
    {
      kind: 'exact',
      path: '/api/tavern/memory/import-legacy',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = String(body.sessionId || lastSessionId || '')
            if (!sid) { json(res, 400, { ok: false, error: '缺少 sessionId：请在目标会话里调用本接口' }); return }
            const pid = body.presetId || getSessionPresetId(sid)
            const legacyPath = memoryFile(pid)
            const legacy = readMemory(pid)
            const entries = (legacy.match(/# 记忆总结/g) || []).length
            if (!legacy.trim()) {
              json(res, 200, { ok: true, imported: 0, entries: 0, sessionId: sid, presetId: pid, note: '该预设没有历史记忆文件，无需迁移' })
              return
            }
            if (body.confirm !== true) {
              json(res, 200, {
                ok: true, needConfirm: true, sessionId: sid, presetId: pid,
                preview: { entries: entries, chars: legacy.length, file: legacyPath },
                warn: '把它搬进「这条会话」之前请先核对预览：历史文件的归属无法自动判断，搬错会话就等于把串台重新写死一遍。确认后带 confirm:true 再调一次。',
              })
              return
            }
            const mode = body.mode === 'replace' ? 'replace' : 'append'
            const prev = mode === 'replace' ? '' : readSessionMemory(sid)
            const combined = (prev.trim() + '\n\n' + legacy.trim()).trim()
            const f = sessionMemoryFile(sid)
            fs.mkdirSync(path.dirname(f), { recursive: true })
            fs.writeFileSync(f, combined + '\n', 'utf8')
            json(res, 200, { ok: true, imported: legacy.length, entries: entries, sessionChars: combined.length, mode: mode, sessionId: sid, presetId: pid, legacyFile: legacyPath })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 会话列表
    {
      kind: 'exact',
      path: '/api/tavern/sessions',
      handler: (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const persistence = getSessionPersistence(ctx)
          if (!persistence || typeof persistence.list !== 'function') {
            json(res, 200, { ok: true, sessions: [] })
            return
          }
          // 获取当前会话的工作目录（cwd），用于过滤同工作区的会话。
          // 修复：web-server 插件上下文没有注入 session/agent 服务，直接访问
          // ctx.session 会抛 cannot get property "session" without inject（500）。
          // 这里安全取值：取不到时 cwd 为空 → 按下方逻辑返回全部会话。
          let currentCwd = ''
          try {
            currentCwd = ctx.agent?.session?.header?.cwd || ''
          } catch {}
          const cwdKey = currentCwd ? String(currentCwd).replace(/[\\/]+$/, '') : ''
          persistence.list().then(async (headers) => {
            let sessions = (headers || []).map((h) => ({ id: h.id, createdAt: h.createdAt || 0, origin: h.origin || '', title: '', cwd: h.cwd || '' }))
            // ★ 合并「活着的、还没落盘」的会话。
            //   关键场景：用户刚点「新对话」，会话已被 DSH 发布（agent/created）但一条消息都还没发
            //   ⇒ `persistence.list()` 里可能根本没有它，而它恰恰是用户此刻要绑定的那一个。
            //   插件在 agent/created 就登记了 liveAgents，这里按 cwd 一并列出并标 `live/blank`，
            //   面板据此允许「未发消息就绑定」（老版本在这里说「当前会话不在会话列表里」）。
            try {
              const seen = new Set(sessions.map(s => s.id))
              for (const [sid, agent] of liveAgents) {
                if (!sid || seen.has(sid)) continue
                let cwd = ''
                try { cwd = agent?.session?.header?.cwd || '' } catch {}
                sessions.push({ id: sid, createdAt: 0, origin: 'live', title: '', cwd, live: true, blank: !hasTurnStarted(agent) })
              }
            } catch {}
            // 按当前工作区过滤：只返回相同 cwd 的会话（如果当前 cwd 为空则返回所有）
            if (cwdKey) {
              sessions = sessions.filter((s) => {
                const sCwd = s.cwd ? String(s.cwd).replace(/[\\/]+$/, '') : ''
                return !sCwd || sCwd === cwdKey
              })
            }
            // 活会话（含空白新会话）排最前：它们是用户此刻最可能要操作的对象，
            // 而且 createdAt 为 0 会被降序排序挤到末尾、再被 slice(0,20) 切掉。
            sessions.sort((a, b) => (Number(b.live === true) - Number(a.live === true))
              || (Number(b.createdAt) - Number(a.createdAt)))
            sessions = sessions.slice(0, 20)
            const bindings = readBindings()
            for (const s of sessions) {
              try {
                const title = await Promise.race([
                  getSessionTitle(ctx, s.id),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
                ])
                s.title = title || ''
              } catch { s.title = '' }
              // ★ P0-1：条目已升级为对象；legacy / none 一律按「未绑定」显示默认预设。
              // ★ P0-3 补完：同一段判定之外，再给面板 bindingMode / bindingSource，
              //   让它分得开「未绑定」/「绑到 default」/「遗留待确认」。boundPreset 不动。
              const bf = sessionBindingFields(bindings[s.id])
              s.boundPreset = bf.boundPreset
              s.bindingMode = bf.bindingMode
              s.bindingSource = bf.bindingSource
              // ★ 本会话的「设定注入量」覆盖（面板要显示"这一场是全量还是跟随规则"）
              try {
                const st0 = readState()
                s.wbOverride = (st0.wbInjectBySession && st0.wbInjectBySession[s.id]) || ''
                s.wbInjectGlobal = st0.wbInject || 'follow'
                // 实际生效模式：把「会话覆盖 → 全局开关 → 卡设定」这一整条链算给面板，
                // 免得面板自己猜（猜错用户就以为设定没进去）—— 与注入口径同一个函数。
                s.wbEffective = resolveWbIsFull(st0, readWorldbook(s.boundPreset === 'default' ? '' : s.boundPreset), s.id) ? 'full' : 'keyword'
              } catch { s.wbOverride = '' }
              // ★ 原生权威（只给**活会话**现算）：面板要显示「本会话当前生效的预设」，
              //   而用户在聊天顶部选的卡**不在酒馆账本里** —— 只看账本会把
              //   「顶部选了酒馆卡」显示成「未绑定」，那是编造状态。
              //   活会话通常只有一两个，现算便宜；20 条全会话都读事件流太贵，所以只算活的。
              if (s.live) {
                try {
                  const r = resolveAuthoritativePreset(s.id)
                  s.authoritativePresetId = r.presetId
                  s.authoritativeSource = r.source
                } catch {}
              }
            }
            json(res, 200, { ok: true, sessions })
          }).catch((e) => json(res, 500, { ok: false, error: e.message }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }
    },
    // 会话内容
    {
      kind: 'exact',
      path: '/api/tavern/session-content',
      handler: (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const url = new URL(req.url, 'http://localhost')
          const id = url.searchParams.get('id') || ''
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)))
          if (!id) { json(res, 400, { ok: false, error: '缺少会话ID' }); return }
          readRecentMessages(ctx, id, limit).then((messages) => {
            json(res, 200, { ok: true, id, count: messages.length, text: messages.join('\n') })
          }).catch((e) => json(res, 500, { ok: false, error: e.message }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }
    },
    
    // 世界书注入模式（full 全量 / keyword 关键词）—— 只改 injectMode，绝不动条目
    {
      kind: 'exact',
      path: '/api/tavern/worldbook/mode',
      handler: (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || lastSessionId
            if (sid) lastSessionId = sid
            const presetId = body.presetId || getSessionPresetId(sid)
            const mode = body.injectMode === 'keyword' ? 'keyword' : 'full'
            const data = readWorldbook(presetId)
            if (!data.groups.length) {
              json(res, 404, { ok: false, error: '该预设还没有世界书条目，无需切换' }); return
            }
            writeWorldbook(presetId, { injectMode: mode, groups: data.groups })
            json(res, 200, { ok: true, presetId, injectMode: mode, groups: data.groups.length, entries: data.entries.length })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
      }
    },
    // 提示词体积：上一轮实测 + 两种注入模式的对比估算
    {
      kind: 'exact',
      path: '/api/tavern/prompt-stats',
      handler: (req, res) => {
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            const w = Number(body.promptWindowTokens)
            if (Number.isFinite(w) && w >= 1024) {
              const st = readState()
              st.promptWindowTokens = Math.round(w)
              writeState(st)
            }
            json(res, 200, { ok: true, promptWindowTokens: readState().promptWindowTokens })
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const st = readState()
          const snap = readPromptStats()
          // 体积统计也要认**会话级覆盖**：面板问的是"当前这个会话会注入多少"，
          // 拿 lastSessionId 的口径与注入点保持一致（拿不到就退回全局/卡设定）。
          const statsSid = lastSessionId || ''
          const presetId = getSessionPresetId(statsSid)
          const wb = readWorldbook(presetId)
          // 两种模式下世界书各要多少字符 —— 复用 card 段同一套过滤/选择逻辑，保证口径一致
          // ★ P2-1：isFull 判定与注入点共用 resolveWbIsFull（会话覆盖 + 全局逃生阀 + 卡设定），
          //   同一轮不会出现注入 select / 统计 full 的口径分裂。
          const allEntries = wb.entries.filter(e => e.disable !== true)
          const sizeOf = (isFull) => {
            const { injectEntries } = selectWorldbookEntries(allEntries, '', isFull)
            return buildWorldbookText(injectEntries).length
          }
          const wbFull = allEntries.length ? sizeOf(true) : 0
          const wbKeyword = allEntries.length ? sizeOf(false) : 0
          // 除世界书以外的固定开销 = 上一轮实测总量 − 上一轮世界书
          const measuredTotal = snap ? Number(snap.total) || 0 : 0
          const measuredWb = snap ? Number(snap.wb) || 0 : 0
          const overhead = Math.max(0, measuredTotal - measuredWb)
          const win = st.promptWindowTokens
          json(res, 200, {
            ok: true,
            presetId,
            // ★ P2-1：mode 显示「实际生效模式」（会话覆盖 + wbInject 逃生阀），与注入口径一致
            mode: resolveWbIsFull(st, wb, statsSid) ? 'full' : 'keyword',
            wbInject: st.wbInject || 'follow',
            wbOverride: (st.wbInjectBySession && statsSid && st.wbInjectBySession[statsSid]) || '',
            cardInjectMode: wb.injectMode === 'keyword' ? 'keyword' : 'full',
            entries: allEntries.length,
            wbFull,
            wbKeyword,
            overhead,
            last: snap,
            now: estimatePromptBudget(measuredTotal, win),
            full: estimatePromptBudget(wbFull + overhead, win),
            keyword: estimatePromptBudget(wbKeyword + overhead, win),
            promptWindowTokens: win,
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }
    },
    // 回复体检：上一条回复是不是被模型拒了
    // 目的：把「插件没注入」和「模型拒绝了」分开 —— 这两件事在界面上以前长得一模一样。
    {
      kind: 'exact',
      path: '/api/tavern/reply-check',
      handler: (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const sid = lastSessionId
          const text = sid ? readLastAssistantText(sid) : ''
          const d = detectRefusal(text)
          json(res, 200, {
            ok: true,
            sessionId: sid || null,
            verdict: d.verdict,
            score: d.score,
            hits: d.hits,
            length: d.length,
            excerpt: d.excerpt,
            at: new Date().toISOString(),
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }
    },
    // ── 设置面板（HTML 页面，不依赖 React bundle）──
    {
    kind: 'exact',
    path: '/api/tavern/settings',
    handler: (req, res) => {
      const st = readState()
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>酒馆设置</title>
        <style>body{font-family:system-ui;max-width:500px;margin:40px auto;padding:20px;background:#1a1a2e;color:#e0e0e0}
        h2{color:#fff}.card{background:#16213e;border:1px solid #334;border-radius:10px;padding:16px;margin:12px 0}
        label{display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0}
        input[type=checkbox]{width:18px;height:18px;cursor:pointer}
        .status{font-size:12px;color:#aab;margin-left:8px}
        button{background:#3b7ff0;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;margin-top:12px}
        button:hover{filter:brightness(.9)}
        .hint{font-size:12px;line-height:1.6;color:#9aa3b8;margin:-2px 0 6px 26px}
        .hint b{color:#cfd6e6}
        .card h4{margin:14px 0 2px;font-size:13px;color:#cfd6e6}
        input[type=radio]{width:16px;height:16px;cursor:pointer}
        label.on{color:#fff}</style></head><body>
        <h2>⚙️ 酒馆设置</h2>
        <div class="card"><h3>🔧 工具</h3>
        <label><input type="checkbox" id="tools"><span>系统工具（pwsh）</span><span class="status" id="tools-status"></span></label>
        <label><input type="checkbox" id="network"><span>联网搜索（web_search）</span><span class="status" id="network-status"></span></label>
        </div>
        <div class="card"><h3>🚫 写作</h3>
        <label><input type="checkbox" id="anticliche"><span>反AI八股（1302条）</span><span class="status" id="anticliche-status"></span></label>
        </div>
        <div class="card"><h3>📚 世界书注入</h3>
        <h4>方式</h4>
        <label><input type="radio" name="wbmode" value="full"><span>全量注入</span></label>
        <div class="hint">每轮把世界书<b>所有条目</b>都写进提示词。人设记得最牢、不会漏，代价是每轮都要烧掉<b>约 11.5 万字符</b>的上下文，费的还是钱。</div>
        <label><input type="radio" name="wbmode" value="keyword"><span>关键词触发</span></label>
        <div class="hint">常驻条目（无关键词／恒定）每轮必带；其余条目只在你<b>最近 4 条消息</b>里提到对应关键词时才注入。<b>分阶段人设</b>只带当前好感度的那一档。基线约 <b>1.2 万字符</b>，省下约 90%。</div>
        <div class="status" id="wbmode-status" style="margin-left:0;margin-top:6px"></div>
        </div>
        <div class="card"><h3>📏 提示词体积</h3>
        <div id="ps-body" class="hint" style="margin-left:0">⏳ 读取中…</div>
        <h4>上下文窗口（token）</h4>
        <div class="hint" style="margin-left:0">填模型标称的上下文长度（如 65536、131072）。用来算下面那些占比。</div>
        <input type="number" id="ps-win" min="1024" step="1024" style="width:150px;padding:6px;border-radius:6px;border:1px solid #334;background:#0f1629;color:#e0e0e0">
        <button id="ps-win-save">保存</button>
        <div id="ps-msg" class="status" style="margin-left:0;margin-top:6px"></div>
        </div>
        <div class="card"><h3>🔧 注入开关</h3>
        <div class="hint">成人模式（破限注入）已移除：这类要求请写在预设里。</div>
        <label><input type="checkbox" id="plotopts"><span>剧情选项（要求模型在结尾给出可选行动）</span><span class="status" id="plotOptions-status"></span></label>
        <div class="hint">开启后模型会在回复结尾列出 3 个可点选项，由前端渲染成按钮；关闭时那一行要求整行不注入。</div>
        </div>
        <button id="btn-save-preset">💾 保存预设（写入 agent.cordis.yml）</button>
        <div id="msg" style="margin-top:10px;font-size:13px;color:#aab"></div>
        <script>
        function m(id,t){document.getElementById(id).textContent=t}
        function toggle(key,el){var v=el.checked;m(key+"-status","⏳");fetch("/api/tavern/state",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[key]:v})}).then(r=>r.json()).then(d=>{m(key+"-status",d.ok?(v?"✅":"❌"):"失败");if(d.ok&&key==="networkEnabled"&&v)save()}).catch(()=>m(key+"-status","失败"))}
        function wbName(v){return v==="full"?"全量注入":"关键词触发"}
        function setWbMode(v){m("wbmode-status","⏳ 切换中…");fetch("/api/tavern/worldbook/mode",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({injectMode:v})}).then(r=>r.json()).then(d=>{m("wbmode-status",d.ok?"✅ 已切换为「"+wbName(d.injectMode)+"」，下一轮对话生效":"❌ "+(d.error||"切换失败"))}).catch(e=>m("wbmode-status","❌ "+e.message))}
        function save(){m("msg","⏳ 读取中…");fetch("/api/tavern/read").then(r=>r.json()).then(d=>{if(!d.agentYml){m("msg","❌ 无预设数据");return}m("msg","⏳ 保存中…");fetch("/api/tavern/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentYml:d.agentYml,presetYml:d.presetYml||"name: 精简酒馆\\ndescription: 由 Harness 酒馆管理面板生成。\\n"})}).then(r=>r.json()).then(d2=>{m("msg",d2.ok?"✅ 已保存":"❌ "+(d2.error||""))}).catch(e=>m("msg","❌ "+e.message))}).catch(e=>m("msg","❌ "+e.message))}
        function psLine(label,b){var c=b.level==="danger"?"#ff6b6b":b.level==="warn"?"#ffb454":"#5fd38d";var w={ok:"正常",warn:"偏大",danger:"危险"}[b.level];return '<div style="margin:4px 0"><b>'+label+'</b> '+b.chars.toLocaleString()+' 字符 ≈ '+b.tokens.toLocaleString()+' tokens <span style="color:'+c+'">（占窗口 '+b.pct+'% · '+w+'）</span></div>'}
        function loadPs(){fetch("/api/tavern/prompt-stats").then(r=>r.json()).then(d=>{if(!d.ok){m("ps-body","❌ 读取失败");return}
        document.getElementById("ps-win").value=d.promptWindowTokens
        var h='<div>世界书条目 <b>'+d.entries+'</b> 条 · 当前模式 <b>'+(d.mode==="full"?"全量注入":"关键词触发")+'</b></div>'
        h+=psLine("本轮实测（本插件合计）",d.now)
        h+=psLine("若全量注入",d.full)
        h+=psLine("若关键词触发",d.keyword)
        if(d.mode==="full"&&d.full.level!=="ok"){h+='<div style="margin-top:6px;padding:8px;border-radius:6px;background:#3a1f22;border:1px solid #7a3b3b">⚠️ 全量注入已占窗口 <b>'+d.full.pct+'%</b>，对话历史没地方长，<b>提示词尾部（最后组装的段落）最先被截断</b>。改用上面的「关键词触发」可降到约 '+d.keyword.chars.toLocaleString()+' 字符，省 '+Math.round((1-d.keyword.chars/Math.max(1,d.full.chars))*100)+'%。</div>'}
        if(d.last){h+='<div style="margin-top:6px;opacity:.7">上次组装 '+String(d.last.at||"").replace("T"," ").slice(0,19)+' · 卡片 '+d.last.card+' / 世界书 '+d.last.wb+' 字符</div>'}
        document.getElementById("ps-body").innerHTML=h
        }).catch(()=>m("ps-body","❌ 读取失败"))}
        var _psSave=document.getElementById("ps-win-save");if(_psSave)_psSave.addEventListener("click",saveWin)
        var _presetSave=document.getElementById("btn-save-preset");if(_presetSave)_presetSave.addEventListener("click",save)
        var _plotopts=document.getElementById("plotopts");if(_plotopts)_plotopts.addEventListener("change",function(){toggle("plotOptions",this)})
        ;[["tools","toolsEnabled"],["network","networkEnabled"],["anticliche","antiCliche"]].forEach(function(p){var el=document.getElementById(p[0]);if(el)el.addEventListener("change",function(){toggle(p[1],this)})})
        Array.prototype.forEach.call(document.querySelectorAll('input[name="wbmode"]'),function(el){el.addEventListener("change",function(){if(this.checked)setWbMode(this.value)})})
        function saveWin(){var v=Number(document.getElementById("ps-win").value);fetch("/api/tavern/prompt-stats",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({promptWindowTokens:v})}).then(r=>r.json()).then(d=>{m("ps-msg",d.ok?"✅ 已保存":"❌ 保存失败");loadPs()}).catch(()=>m("ps-msg","❌ 保存失败"))}
        loadPs()
        fetch("/api/tavern/state").then(r=>r.json()).then(d=>{
        if(d.ok){document.getElementById("tools").checked=d.toolsEnabled!==false;m("tools-status",d.toolsEnabled!==false?"✅":"❌");
        document.getElementById("network").checked=d.networkEnabled===true;m("network-status",d.networkEnabled===true?"✅":"❌");
        document.getElementById("anticliche").checked=d.antiCliche!==false;m("anticliche-status",d.antiCliche!==false?"✅":"❌");
        document.getElementById("plotopts").checked=d.plotOptions!==false;m("plotOptions-status",d.plotOptions!==false?"✅ 已开启":"❌")}
        }).catch(()=>{})
        fetch("/api/tavern/worldbook").then(r=>r.json()).then(d=>{
        if(d.ok){var v=d.injectMode==="keyword"?"keyword":"full";
        var el=document.querySelector('input[name="wbmode"][value="'+v+'"]');if(el)el.checked=true;
        m("wbmode-status","当前：「"+wbName(v)+"」")}
        }).catch(()=>m("wbmode-status","⚠️ 读取世界书失败"))
        </script></body></html>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    }
    },
  ]
  for (const route of routes) {
    ctx.webServer.register(route)
  }
}

// ── 导出纯函数供单元测试 ────────────────────────────────
export const _test = {
  matchWorldbookEntries,
  buildWorldbookText,
  extractCardText,
  buildRelationsHintText,
  // 技能（Skill）
  slugSkillName,
  skillNameForPreset,
  buildSkillMarkdown,
  writePresetSkill,
  deletePresetSkill,
  listSkillsOnDisk,
  parseSkillFrontmatter,
  presetSkillNames,
  setPresetSkillNames,
  buildSkillsHintText,
  syncPresetSkillAfterSave,
  summarizePresetForSkill,
  skillsRoot,
  SKILL_NAME_RE,
  legacyInjectMode,
  contentToText,
  cleanSillyTavernVars,
  sanitizePromptText,
  randomPick,
  randomRoll,
  normalizeName,
  cleanName,
  migratePersonaTextField,
  migratePersonaCompleteFlag,
  entryKeys,
  entrySecondaryKeys,
  parseStagePlans,
  latestAffection,
  selectWorldbookEntries,
  resolveWbIsFull,
  legacyInjectMode,
  estimatePromptBudget,
  detectRefusal,
  pickAuthoritativePreset,
  pickAuthoritativePresetFromLog,
  classifySessionPresetLines,
  extractAgentPresetFromLine,
  sessionIdKeys,
  sessionDirMatches,
  migrateSessionStorageOutOfPresetRoot,
  GREETING_FIELDS,
  GREETING_SURFACE_TYPES,
  canAppendGreetingSurface,
  greetingTextFor,
  hasCardGreeting,
  appendGreetingToSessionEnd,
  insertGreetingForSession,
  pickGreetingCard,
  armLiveAgents,
  DEFAULT_PRESET_YML,
  DEFAULT_PRESET_META,
  // 全局状态 / 预设选中光标（activePresetIdx 持久化）
  readState,
  writeState,
  normalizeActivePresetIdx,
  // 通用增强层（preset-forge）
  // P0-6 注入观测（只加不改的取证仪表）
  contentHash16,
  classifyPresetBindingSource,
  readPresetBindingSource,
  writeInjectObserveRecord,
  observeInjection,
  // P0-5 生效范围闸门（白名单语义：空 = 不放行）
  decideInjectionScope,
  // 本轮各注入段的字符数（活对象：各段的 text() 会回填，测试直接读它）
  sectionSizes,
  // P0-1 三态绑定 / P0-2 停自动绑定 / P0-4 legacy 迁移
  BINDING_SOURCE_PANEL,
  BINDING_SOURCE_TOP_SELECT,
  BINDING_SOURCE_LEGACY,
  normalizeBinding,
  bindingModeOf,
  sessionBindingFields,
  listAgentPresets,
  readBindings,
  writeBindings,
  readBindingsRaw,
  resetBindingsCache,
  writeBindingEntry,
  resolveAuthoritativePreset,
  migrateLegacyBindings,
  purgeLegacyBindings,
  backupBindingsFile,
  // 原生 agent 预设选择（会话绑定的正路：预设 = DSH agent 预设，绑定 = 会话的 agentPreset）
  agentPresetIdFor,
  readDshDefaultAgentPresetId,
  getCtxService,
  findLiveAgent,
  hasTurnStarted,
  nativeTurnStarted,
  selectNativeAgentPreset,
  nativeAgentPresetOf,
  nativePresetRoster,
  armNativePresetWatcher,
  liveAgents,
  // DSH 声明行（让酒馆预设真的出现在顶部选择器里）—— 纯渲染/拼接，不写盘
  PRESET_DECL_BEGIN,
  PRESET_DECL_END,
  yamlDoubleQuote,
  indentYamlBlock,
  BLANK_PRESET_SKELETON,
  normalizeYmlForCompare,
  isBlankPresetComposition,
  presetDisplayNameFor,
  renderPresetDeclaration,
  renderAllPresetDeclarations,
  composePresetDeclarationBlock,
  mergeManagedPresetBlock,
  listTavernPresetIds,
  findProfileDir,
  outsideManagedBlock,
  stripManagedPresetBlock,
  validatePresetPatchText,
  applyPresetDeclarations,
  renderPresetBundleFiles,
  writePresetBundle,
  readDeclarationMode,
  writeDeclarationMode,
  syncDeclarationsBestEffort,
  setSessionPreset,
  getSessionPresetId,
  isTavernPresetDir,
}
