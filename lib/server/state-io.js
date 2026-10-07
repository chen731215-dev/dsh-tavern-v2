// 全局状态的写入与目录准备（路径依赖：STATE_PATH / ROOT）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import { P } from './state.js'

function ensureRoot() {
  fs.mkdirSync(P.ROOT, { recursive: true })
}

function writeState(s) {
  ensureRoot()
  fs.writeFileSync(P.STATE_PATH, JSON.stringify(s, null, 2), 'utf8')
}

export { writeState, ensureRoot }
