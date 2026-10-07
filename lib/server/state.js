// 非路径的可变运行时状态（S2-B2a）
//
// 原先散落在 lib/index.js 顶层的这些 `let`，统一挂到这个对象上 ——
// 这样 lib/server/* 才能在不反向 import index.js 的前提下读到它们
// （AGENTS.md §5 第 5 条：禁止循环依赖）。
// 本文件由 S2 服务端分层整理而来，真源规范见仓库根目录 AGENTS.md §5。
//
// ★ 路径类那 8 个（DSH_HOME / ROOT / PRESETS_META / SESSION_BINDINGS / STATE_PATH /
//   SESSIONS_ROOT / TAVERN_DATA_ROOT / DSH_SETTINGS_FILE / DSH_CREDENTIALS_FILE）**不在这里**：
//   它们必须留在 index.js —— memory-isolation 测试按行首切片 `let ROOT = path.join(DSH_HOME, …)`
//   到 `const DEFAULT_PRESET_DIR` 这一整段（见 AGENTS.md §5.1）。等 S2-B2b 再用 syncPaths() 单向镜像。
//
// ★ lastSessionId 也不在这里：memory-isolation 测试断言源码里必须有字面量
//   `const targetSid = lastSessionId`（禁止在异步回调里再读全局），改名会破坏那条护栏。

export const S = {
  /** 模块级玩家名（可配置，由 state.playerName 设置，供 cleanSillyTavernVars 和 normalizeName 共享） */
  playerName: '',

  /**
   * 插件上下文（apply() 时赋值）。注入决议里要问 DSH 原生服务（会话投影）时用它 ——
   * systemPrompt 段回调只给 context，给不到 ctx。未 apply（单测）时为 null。
   */
  activePluginCtx: null,

  /** 出厂内置清单缓存（探测 DSH 安装目录 assets/agent-presets；找不到再回退硬编码） */
  builtinDirsCache: null,

  /** 会话绑定缓存（防止并发重复创建预设） */
  _bindingsCache: null,
  _bindingsDirty: false,

  promptStatsFlushedAt: 0,
}

/**
 * 路径镜像（S2-B2b）。
 *
 * ★ 真源是 lib/index.js 顶层那 9 个 `let` —— 它们必须留在 index.js（memory-isolation
 *   测试按行首切片 `let ROOT = path.join(DSH_HOME, …)` 到 `const DEFAULT_PRESET_DIR` 整段）。
 *   这里放的是**同一份值的镜像**，供 lib/server/* 读取，避免反向 import index.js。
 *
 * ★ 唯一写入点是 `syncPaths()`，全仓只有两处调用：index.js 模块初始化时 + bindDshPaths() 里。
 *   任何绕过 syncPaths 直接改 P 的代码都是 bug（有护栏测试盯着，见 tests/server-state-paths.test.js）。
 */
export const P = {
  DSH_HOME: '',
  ROOT: '',
  PRESETS_META: '',
  SESSION_BINDINGS: '',
  STATE_PATH: '',
  SESSIONS_ROOT: '',
  TAVERN_DATA_ROOT: '',
  DSH_SETTINGS_FILE: '',
  DSH_CREDENTIALS_FILE: '',
}

/** 把 index.js 的路径 let 同步进 P。**只应由 index.js 调用**（模块初始化 + bindDshPaths 各一次）。 */
export function syncPaths(v) {
  if (!v) return P
  for (const k of Object.keys(P)) if (typeof v[k] === 'string' && v[k]) P[k] = v[k]
  return P
}
