// 会话历史直读（路径依赖：SESSIONS_ROOT）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import path from 'node:path'
import { P } from './state.js'
import { contentTextOnly, findSessionLog } from './session-log.js'
import { zstdDecompressSync } from './zstd.js'

function readSessionEventsDirect(sessionId, maxEvents) {
  const events = []
  if (!sessionId) return events
  const sessionsRoot = P.SESSIONS_ROOT
  let filePath = null
  try {
    const dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      filePath = findSessionLog(path.join(sessionsRoot, d.name, 'session-' + sessionId.replace(/^session-/, '')))
      if (!filePath) filePath = findSessionLog(path.join(sessionsRoot, d.name, sessionId))
      if (filePath) break
    }
  } catch {}
  if (!filePath) return events
  try {
    const buf = fs.readFileSync(filePath)
    const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
    const frameStarts = []
    let pos = 0
    while (pos < buf.length) {
      const idx = (buf || []).indexOf(magic, pos)
      if (idx === -1) break
      frameStarts.push(idx)
      pos = idx + 4
    }
    for (let i = 0; i < frameStarts.length; i++) {
      const start = frameStarts[i]
      const end = i + 1 < frameStarts.length ? frameStarts[i + 1] : buf.length
      let decompressed
      try { decompressed = zstdDecompressSync(buf.subarray(start, end)).toString('utf8') }
      catch { continue }
      const lines = decompressed.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line)
          events.push(ev)
          if (maxEvents && maxEvents > 0 && events.length >= maxEvents) return events
        } catch {}
      }
    }
  } catch {}
  return events
}

/**
 * 取某个会话里**最后一条助手正文**。
 * 只看 text 块（contentTextOnly），所以工具调用与推理块不会混进来。
 * @param {string} sessionId 会话 id
 * @returns {string} 正文；取不到返回空串
 */
function readLastAssistantText(sessionId) {
  try {
    const events = readSessionEventsDirect(sessionId, 0)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev || ev.type !== 'assistant/message') continue
      const text = contentTextOnly(ev.data && ev.data.message && ev.data.message.content)
      if (text) return text
    }
  } catch {}
  return ''
}

export { readSessionEventsDirect, readLastAssistantText }
