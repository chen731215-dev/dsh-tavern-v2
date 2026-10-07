// DSH 会话历史文件定位与 zstd 多帧读取
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import path from 'node:path'
import { SESSION_LOG_RE } from './constants.js'
import { zstdDecompressSync } from './zstd.js'

// ── 直接修改 dsh 会话历史（多帧 zstd JSONL） ──────────────
const ZSTD_MAGIC = 4247762216

function findSessionLog(dir) {
  let entries
  try { entries = fs.readdirSync(dir) } catch { return null }
  let best = null
  let bestGen = -1
  for (const name of entries) {
    const m = SESSION_LOG_RE.exec(name)
    if (!m) continue
    const gen = m[1] ? Number(m[1]) : 0
    if (gen > bestGen) { bestGen = gen; best = path.join(dir, name) }
  }
  return best
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let nextStart = -1
    for (let i = offset; i < buffer.length - 4; i++) {
      if (buffer.readUInt32LE(i) === ZSTD_MAGIC) {
        try { const desc = buffer.readUInt8(i + 4); if ((desc & 24) === 0) { nextStart = i; break } } catch (e) {}
      }
    }
    const end = nextStart > 0 ? nextStart : buffer.length
    frames.push({ start, end })
    offset = end
  }
  return frames
}

/**
 * 会话 id 的候选写法。
 *
 * `getCurrentSessionId()`（客户端）与 `session-bindings.json` 用 **`session-<uuid>`**，
 * 而 DSH 的会话日志目录**大多数是裸 `<uuid>`**（实测 189 裸 / 71 带前缀）。
 * 所以匹配时两种形式都要试 —— 这是被线上实测钉出来的 bug，不是假想。
 */
function sessionIdKeys(sessionId) {
  const sid = String(sessionId || '')
  if (!sid) return []
  const bareId = sid.replace(/^session-/, '')
  return bareId === sid ? [sid, 'session-' + bareId] : [sid, bareId]
}

/**
 * 会话日志目录名是否匹配给定会话 id。
 *
 * ⚠️ 这里修的是一个**方向性**缺陷：原来只有
 * `sd.name === sessionId || sd.name.includes(sessionId)`，于是
 * 「传 `session-<uuid>`、目录名是裸 `<uuid>`」时 `===` 不中、`includes` **方向也反**
 * ⇒ 查不到日志 ⇒ `resolveAuthoritativePresetId()` 静默退回 bindings
 * ⇒ 实测 **73%（189/260）的会话权威预设失效**，统统返回 `default`。
 */
function sessionDirMatches(dirName, sessionId) {
  if (!dirName || !sessionId) return false
  const keys = sessionIdKeys(sessionId)
  return keys.includes(dirName) || keys.some(k => k && dirName.includes(k))
}

function readSessionLines(filePath) {
  const compressed = fs.readFileSync(filePath)
  const frames = scanZstdFrames(compressed)
  let text = ''
  for (const f of frames) {
    try { text += zstdDecompressSync(compressed.subarray(f.start, f.end)).toString('utf8') } catch (e) {}
  }
  return text.split('\n').filter(l => l.trim())
}

// ★ 记忆总结只吃正文：会话日志里的 assistant/message 会带 tool-call 块
//   （实测一条长会话 261 个 tool-call / 186 条 assistant 消息），
//   contentToText 会把它们拼成「[工具subagent]」这类标记混进总结输入。
//   这里只取 text 块，丢掉工具标记与推理块，让总结看到的只有角色扮演正文。
function contentTextOnly(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.map((s) => s.trim()).filter(Boolean).join('\n')
}

export { ZSTD_MAGIC, findSessionLog, scanZstdFrames, sessionIdKeys, sessionDirMatches, readSessionLines, contentTextOnly }
