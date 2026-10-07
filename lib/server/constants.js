// 跨模块共享的常量（index.js 与 lib/server/* 都用到的那几个）
//
// 本文件由 S2 服务端分层从 lib/index.js 整块搬来，内容逐字未改。
// 真源规范见仓库根目录 AGENTS.md §5。


const CARD_MAX = 120000

/** 受管块的界标：只替换自己这两行之间的内容，绝不动用户手写的 providers 等条目。 */
const PRESET_DECL_BEGIN = '# >>> dsh-tavern agent-preset declarations (managed; do not edit) >>>'

const PRESET_DECL_END = '# <<< dsh-tavern agent-preset declarations (managed) <<<'

/** 以中文为主时每 token 约合 3.2 字符（保守估计，宁可高估字符占比） */
const CHARS_PER_TOKEN = 3.2

/** 未配置时的默认上下文窗口（token） */
const DEFAULT_WINDOW_TOKENS = 65536

// DSH 会话日志文件名随物理格式代次变化（见 dsh-session-format/src/filename.ts）：
//   generation 0 -> session.jsonl / session.jsonl.zstd
//   generation N -> session.vN.jsonl / session.vN.jsonl.zstd
// 0.1.5-rc.1 当前写的是 session.v3.jsonl.zstd。
// 只认死 'session.jsonl.zstd' 会让所有现行会话都找不到，进而：
//   - resolveAuthoritativePresetId 读不到 agent-preset/selected → 退回 bindings/默认预设
//   - 会话内容预览、标题、编辑历史全部失效
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

// 合并关系网到会话级存储
// ── 称呼归一化（模块级，供 mergeSessionRelations / mergeRelations 复用并导出测试）──
// LLM 可能用 你/玩家/主角/我/用户/食客/主人 等称呼用户，统一为"你"（避免重复节点）
const USER_ALIASES = new Set(['玩家', '主角', '用户', '我', '你', '食客', '食客（男主角）', '食客(男主角)', '男主角', 'player', 'Player', 'me', 'Me', '旅行者', '开拓者', '主人', '主人翁', 'pc', 'PC', 'user', 'User'])

const STAGE_RE = /^(.*?)_阶段0*(\d+)_/

/**
 * 「新建空白预设」写下的**骨架**组合（createPreset 用，且仅此一处使用）。
 *
 * 为什么需要这个常量：预设声明（`renderPresetDeclaration`）是**从磁盘读组合文件**渲染的。
 * 新建预设的瞬间磁盘上只有这份骨架 —— 它没有任何注入内容、也没有工具行。
 * 早先的流程在 createPreset 里紧接着就同步声明，于是名册里多出一行「空壳预设」：
 * persona 的 prefix 长度为 0、没有 fs/pwsh/web 工具，用户看到预设存在却完全不起作用。
 * 现在这行骨架 = 「此预设尚未保存」的判据：不声明、并且提示用户先保存。
 */
const BLANK_PRESET_SKELETON = "# 酒馆管理面板生成\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: |-\n      \n"

/** 绑定来源白名单：只有这三种写入端能产生绑定。 */
const BINDING_SOURCE_PANEL = 'panel'

const BINDING_SOURCE_TOP_SELECT = 'top-select'

const BINDING_SOURCE_LEGACY = 'legacy'

/** 会话 id → 当前活跃 Agent（agent/created 时登记，手动注入 API 按它找活会话）。 */
const liveAgents = new Map()

/** skill 名字规则（与 dsh-skill 的 SKILL_NAME 完全一致，不合规会被 DSH 整条丢弃）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export { CARD_MAX, PRESET_DECL_BEGIN, PRESET_DECL_END, CHARS_PER_TOKEN, DEFAULT_WINDOW_TOKENS, SESSION_LOG_RE, USER_ALIASES, STAGE_RE, BINDING_SOURCE_LEGACY, BINDING_SOURCE_PANEL, BINDING_SOURCE_TOP_SELECT, BLANK_PRESET_SKELETON, SKILL_NAME_RE, liveAgents }
