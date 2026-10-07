// DSH settings.yaml / credentials 里的 API 连接解析
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。


/**
 * 极简 flow 风格 YAML 解析（只处理 DSH settings.yaml providers 段用到的子集）：
 * { key: value, ... } + [ ... ] + 标量。不做完整 YAML，够用且零依赖。
 */
function parseFlowYaml(raw) {
  let i = 0
  const skipWs = () => { while (i < raw.length && /\s/.test(raw[i])) i++ }
  const parseValue = () => {
    skipWs()
    const ch = raw[i]
    if (ch === '{') return parseMap()
    if (ch === '[') return parseArray()
    return parseScalar()
  }
  const parseScalar = () => {
    skipWs()
    let out = ''
    while (i < raw.length && !/[,\]}]/.test(raw[i])) { out += raw[i]; i++ }
    out = out.trim()
    if (out === '') return undefined
    if (out === 'true') return true
    if (out === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(out)) return Number(out)
    return out.replace(/^['"]|['"]$/g, '')
  }
  const parseMap = () => {
    i++ // skip {
    const obj = {}
    skipWs()
    while (i < raw.length && raw[i] !== '}') {
      skipWs()
      let key = ''
      if (raw[i] === '"' || raw[i] === "'") {
        const q = raw[i]; i++
        while (i < raw.length && raw[i] !== q) { key += raw[i]; i++ }
        i++
      } else {
        while (i < raw.length && raw[i] !== ':' && !/[,\s]/ .test(raw[i])) { key += raw[i]; i++ }
      }
      skipWs()
      if (raw[i] === ':') { i++ } else { break }
      const val = parseValue()
      if (key && val !== undefined) obj[key.trim()] = val
      skipWs()
      if (raw[i] === ',') { i++; continue }
      if (raw[i] === '}') break
    }
    i++ // skip }
    return obj
  }
  const parseArray = () => {
    i++ // skip [
    const arr = []
    skipWs()
    while (i < raw.length && raw[i] !== ']') {
      const val = parseValue()
      if (val !== undefined) arr.push(val)
      skipWs()
      if (raw[i] === ',') { i++; continue }
      if (raw[i] === ']') break
    }
    i++ // skip ]
    return arr
  }
  try { return parseValue() } catch { return {} }
}

/** 从环境变量或 DSH credentials 文件解析某连接的真实 key（仅宿主端使用）。 */
function resolveDshKey(apiKeyEnv, creds) {
  if (!apiKeyEnv) return ''
  try { if (process.env[apiKeyEnv]) return process.env[apiKeyEnv] } catch {}
  return (creds && creds[apiKeyEnv]) || ''
}

import fs from 'node:fs'
import { P } from './state.js'

/**
 * 读 DSH 部署默认预设 id（`settings.yaml` 的 `agent-presets.default`）。纯只读，不抛。
 *
 * 用途：解绑 / 想「把会话交还给 DSH」时，原生 select 的目标必须是 DSH 自己认识的
 * 预设（实测默认 `standard`）。读不到就回退 `standard`。
 *
 * @returns {string} agent 预设 id
 */
function readDshDefaultAgentPresetId() {
  try {
    const text = fs.readFileSync(P.DSH_SETTINGS_FILE, 'utf8')
    // 段式：  agent-presets:\n  default: standard
    const block = text.match(/^[ \t]*agent-presets[ \t]*:[ \t]*$([\s\S]*?)(?=^[^\s#]|\Z)/m)
    if (block) {
      const inner = block[1].match(/^[ \t]+default[ \t]*:[ \t]*["']?([A-Za-z0-9_.\-]+)["']?[ \t]*$/m)
      if (inner && inner[1]) return inner[1]
    }
    // 点号式：  agent-presets.default: standard
    const flat = text.match(/^[ \t]*agent-presets\.default[ \t]*:[ \t]*["']?([A-Za-z0-9_.\-]+)["']?/m)
    if (flat && flat[1]) return flat[1]
  } catch {}
  return 'standard'
}

/** 简单读取 DSH settings.yaml（flow 风格 YAML 的 providers 段），失败返回空对象。 */
function readDshProviders() {
  try {
    const text = fs.readFileSync(P.DSH_SETTINGS_FILE, 'utf8')
    const piIdx = (text || '').indexOf('llm-pi-ai:')
    if (piIdx < 0) return {}
    const section = text.slice(piIdx)
    const provIdx = (section || '').indexOf('providers:')
    if (provIdx < 0) return {}
    let block = section.slice(provIdx + 'providers:'.length)
    // 找到第一个 `{`，然后按花括号配对取完整块
    const open = (block || '').indexOf('{')
    if (open < 0) return {}
    block = block.slice(open)
    let depth = 0
    let end = -1
    for (let i = 0; i < block.length; i++) {
      const ch = block[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end <= 0) return {}
    const raw = block.slice(0, end + 1)
    return parseFlowYaml(raw)
  } catch {}
  return {}
}

/** 读取 ~/.dsh/.credentials.yaml 的 refs（DSH 保存的各 API key）。返回值：{ REF_NAME: key } */
function readDshCredentials() {
  const refs = {}
  try {
    const text = fs.readFileSync(P.DSH_CREDENTIALS_FILE, 'utf8')
    let inRefs = false
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.replace(/\r$/, '')
      const trimmed = line.trim()
      if (trimmed === 'refs:') { inRefs = true; continue }
      if (inRefs && /^[A-Za-z0-9_]+:/.test(trimmed)) {
        const idx = (trimmed || '').indexOf(':')
        const key = trimmed.slice(0, idx).trim()
        let val = trimmed.slice(idx + 1).trim()
        val = val.replace(/^['"]|['"]$/g, '')
        if (key && val) refs[key] = val
      }
    }
  } catch {}
  return refs
}

/**
 * 列出 DSH 里已保存的 API 连接（可供记忆模块直接调用）。
 * 每个连接：{ id, name, baseURL, apiKeyEnv, models: [{id,name}], hasKey }
 * 注意：绝不把真实 key 返回给前端，只给 hasKey 布尔。
 */
function listDshConnections() {
  const creds = readDshCredentials()
  const providers = readDshProviders()
  const out = []
  const seen = new Set()
  const push = (id, name, baseURL, apiKeyEnv, models, key) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({
      id,
      name: name || id,
      baseURL: baseURL || '',
      apiKeyEnv: apiKeyEnv || '',
      models: Array.isArray(models) ? models.map((md) => ({ id: md.id ?? md.model ?? md.name ?? '', name: md.name ?? md.id ?? md.model ?? '' })).filter((m) => m.id) : [],
      hasKey: !!key
    })
  }
  // 1) llm-pi-ai.providers
  // 常见内置 provider 的默认 baseURL/模型兜底（settings 里没写 baseURL 时用默认）
  const DEFAULT_BASE_URL = {
    'opencode-go': 'https://opencode.ai/zen/go/v1',
    'deepseek': 'https://api.deepseek.com',
    'gemini': 'https://gcli.ggchan.dev'
  }
  const DEFAULT_MODELS = {
    'opencode-go': [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
  }
  for (const [pid, cfg] of Object.entries(providers || {})) {
    if (!cfg || typeof cfg !== 'object') continue
    const key = resolveDshKey(cfg.apiKeyEnv, creds)
    const models = (cfg.models && cfg.models.length) ? cfg.models : (DEFAULT_MODELS[pid] || [])
    push(pid, cfg.displayName || pid, cfg.baseURL || DEFAULT_BASE_URL[pid] || '', cfg.apiKeyEnv || '', models, key)
  }
  // 2) 官方 DeepSeek（settings 的 llm-deepseek 段 / DEEPSEEK_API_KEY credential）
  const dk = resolveDshKey('DEEPSEEK_API_KEY', creds)
  push('deepseek', 'DeepSeek 官方', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY',
    [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }], dk)
  return out
}

/** 根据 mem 配置解析最终用于调用的 { apiUrl, apiKey, model }。 */
function resolveMemApi(state) {
  const m = (state && state.mem) || {}
  if (m.useDsh && m.dshConnection) {
    const conn = listDshConnections().find((c) => c.id === m.dshConnection)
    if (conn) {
      const key = resolveDshKey(conn.apiKeyEnv, readDshCredentials())
      return {
        apiUrl: conn.baseURL || '',
        apiKey: key,
        model: m.dshModel || (conn.models[0] && conn.models[0].id) || 'deepseek-chat',
        from: conn.name
      }
    }
  }
  return { apiUrl: m.apiUrl, apiKey: m.apiKey, model: m.model || 'deepseek-chat', from: 'manual' }
}

export { parseFlowYaml, resolveDshKey, readDshProviders, readDshCredentials, resolveMemApi, readDshDefaultAgentPresetId, listDshConnections }
