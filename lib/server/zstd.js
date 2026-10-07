// zstd 多帧解压垫片（Node < 22.5 降级，避免 import 崩掉整个插件）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。


// zstd zlib API 自 Node 22.5 起提供；低版本 Node 上提供降级实现，
// 避免 import 崩掉整个插件（会话历史读写功能降级，不影响角色扮演主流程）
import { zstdDecompressSync as _zstdDecompress, zstdCompressSync as _zstdCompress } from 'node:zlib'

const zstdDecompressSync = typeof _zstdDecompress === 'function' ? _zstdDecompress : (buf) => { throw new Error('zstd 需要 Node >= 22.5') }
const zstdCompressSync = typeof _zstdCompress === 'function' ? _zstdCompress : () => { throw new Error('zstd 需要 Node >= 22.5') }

export { zstdDecompressSync, zstdCompressSync }
