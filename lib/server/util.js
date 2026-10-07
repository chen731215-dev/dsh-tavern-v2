// 通用小工具（纯函数，无状态、无跨模块依赖）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import os from 'node:os'
import path from 'node:path'

function expandHomePrefix(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 归一化 YAML 文本用于比较：统一换行、去掉行尾空白、去掉空行与整行注释。
 * 用于识别「骨架组合」，不用于任何写盘。
 */
function normalizeYmlForCompare(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    .join('\n')
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 50 * 1024 * 1024) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

function genId() {
  return 'preset-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// ST 兼容：{{random::a,b,c}} / {{pick::a,b,c}} → 随机取一个（去首尾空白）
function randomPick(inner) {
  const parts = String(inner || '')
    .split(/[,，]/)
    .map(p => p.trim())
    .filter(Boolean)
  if (!parts.length) return ''
  return parts[Math.floor(Math.random() * parts.length)]
}

// ST 兼容：{{roll::n}} → 1..n 随机整数；{{roll::n,m}} → n..m 随机整数
function randomRoll(inner) {
  const m = String(inner || '').match(/(\d+)(?:\s*[,，\-:]\s*(\d+))?/)
  if (!m) return ''
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (hi < 1) return ''
  if (!m[2]) { // {{roll::n}} → 1..n
    if (a < 1) return ''
    return String(1 + Math.floor(Math.random() * a))
  }
  return String(lo + Math.floor(Math.random() * (hi - lo + 1)))
}

/** 把任意字符串收敛成合法 skill 名片段：只留小写字母数字，其他压成单短横线。 */
function slugSkillName(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return out
}

/** YAML 单行标量：引号包裹 + 转义，绝不带换行（frontmatter 里换行会把 YAML 写坏）。 */
function yamlScalar(v) {
  return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim() + '"'
}

/** 截断到 n 字符（不切坏 emoji 太多也无妨，frontmatter 只是描述）。 */
function clipText(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function contentToText(content) {
  if (!content || !Array.isArray(content)) return ''
  const parts = []
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'tool-result' && b.content) walk(b.content)
      else if (b.type === 'reasoning') { /* 忽略推理 */ }
      else if (b.type === 'tool-call') { if (b.name) parts.push('[工具' + b.name + ']') }
    }
  }
  walk(content)
  return parts.map((s) => s.trim()).filter(Boolean).join('\n')
}

export { json, readBody, genId, clipText, yamlScalar, slugSkillName, randomPick, randomRoll, normalizeYmlForCompare, expandHomePrefix, contentToText }
