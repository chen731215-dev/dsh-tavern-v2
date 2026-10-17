// ── 预设兼容 + 回复完整性诊断 ────────────────────────────────
//
// 这个文件只做两件事，都是**纯函数**（不碰磁盘、不碰 ctx），便于单测：
//
//   1. compatPresetContent() —— 把「在 SillyTavern 里能跑、搬进 DSH 必然坏」的
//      指令就地改写。典型来源是 Reborn / 类脑系预设：它们的"防截断"不是靠提示词，
//      而是靠 SPreset 扩展的四条 JS 管线（ChatSquash / OutputPreprocessing /
//      ToolBindings / ForcedPostProcessing）。**文字搬得动，管线搬不动**，
//      于是那些指令在 DSH 里从"有用"变成"有害"。
//
//   2. checkSkeleton() / judgeTurn() —— 把「这一轮到底完没完」变成可判定的事实，
//      给上层的 reply-status 用。以前插件只能检测"拒答"（detectRefusal），
//      对"说到一半被掐"完全瞎着。
//
// ★ 为什么改写发生在**注入时**而不是导入时：
//   导入时改会把用户的原始文件内容也改掉，用户看不到自己导进来的到底是什么，
//   而且面板是内存状态 + autoSaveAfterChange()，任何一次改写的丢失都会被静默写回磁盘。
//   注入时改写是**单一收口**：面板里改、手改 presets.json、旧版遗留数据，
//   三条路径都经过这里，行为一定一致；磁盘上永远保留原文。

// ── 一、控制 token 清洗 ─────────────────────────────────────
//
// 模型会**模仿**特殊控制 token（尤其当提示词里让它"扮演另一个模型"时，比如
// Reborn 的「Gemini first, then SoliUmbra」）：
//     <|im_start|>gemini
//     WARNING — JAILBREAK DETECTED ...
//     <|im_end|>
// 这些 token 一旦留在上下文里会持续污染后续轮次，也会让上游把它当成真的角色边界。
// ST 侧是靠一条正则脚本（placement=[1,2]，提示词与显示都清）处理的，这里在注入出口做同一件事。
//
// 两类处理：
//   · 裸 token（没有配对）→ 一律删掉，任何情况下都不该出现在正文里
//   · 成对块 <|im_start|>role … <|im_end|> → 只有 role 属于"别的模型"白名单时才整块删，
//     且限制块长（6000 字符），防止把整篇正文误吞
const CTRL_ROLES = 'gemini|gpt|claude|assistant|system|model|safety|openai|qwen|deepseek|grok|llama'
// 成对块的判定刻意**不锚定行首**：模型模仿出来的块经常紧贴在正文后面
// （`……正文<|im_start|>gemini\nWARNING…\n<|im_end|>……`），带 (^|\n) 锚会漏掉一半。
// 两条硬约束保证不误吞：role 必须在白名单里 + 块内不超过 6000 字符。
const PAIRED_CTRL_RE = new RegExp(
  '<\\|im_start\\|>[ \\t]*(?:' + CTRL_ROLES + ')[ \\t]*\\r?\\n'
  + '([\\s\\S]{0,6000}?)\\r?\\n[ \\t]*<\\|im_end\\|>',
  'gi',
)
const BARE_CTRL_RE = new RegExp(
  '<\\|(?:'
  + 'im_start|im_end|im_sep'
  + '|pad|pad_end'
  + '|endoftext|begin_of_text|end_of_text'
  + '|eot_id|eom_id'
  + '|start_header_id|end_header_id'
  + '|channel|constrain|end|tool_call|tool_response'
  + '|reserved_special_token(?:_[0-9]{1,4})?'
  + ')\\|>',
  'g',
)

/**
 * 清掉模型模仿出来的特殊控制 token。
 * @param {string} text
 * @param {{paired?: boolean}} [opts] paired=false 时只删裸 token（提示词里偶尔有正当用例）
 * @returns {string}
 */
export function stripControlTokens(text, opts) {
  let s = String(text || '')
  if (!s) return s
  if (!opts || opts.paired !== false) {
    // 成对块可能连续出现，跑两遍足够（正则带 g，一次 replace 已覆盖全部）
    s = s.replace(PAIRED_CTRL_RE, '')
  }
  s = s.replace(BARE_CTRL_RE, '')
  return s
}

/** 文本里是否残留控制 token（诊断用，不改文本）。 */
export function hasControlTokens(text) {
  const s = String(text || '')
  if (!s) return false
  BARE_CTRL_RE.lastIndex = 0
  return BARE_CTRL_RE.test(s)
}

// ── \uXXXX 解码 ───────────────────────────────────────────
//
// ⚠️ 客户端 `client.manager.bundle.js` 里的 `decodeEscapesIn()` 有**同一份正则**，
//    因为浏览器侧不能 import 服务端 ESM 模块。两处必须逐字一致 ——
//    `analysis/verify-compat.mjs` 会从 bundle 里把 `ESC_ESC_RE` 抠出来比对，
//    改了一边另一边没跟上会直接红。
//
// 语义：\uXXXX 与 \u{XXXXXX} 都还原成字符；代理对天然成立
// （`\uD83D\uDE00` 是两个独立转义，各自还原成半个代理项，拼起来正好是 😀）。
export const UNICODE_ESCAPE_RE = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g

/**
 * 把文本里的 \uXXXX 转义还原成字符。解码是幂等的（解完就没有 `\u` 了）。
 * @param {string} text
 * @returns {string}
 */
export function decodeUnicodeEscapes(text) {
  const s = String(text || '')
  if (s.indexOf('\\u') < 0) return s
  UNICODE_ESCAPE_RE.lastIndex = 0
  return s.replace(UNICODE_ESCAPE_RE, (all, braced, fixed) => {
    const cp = Number.parseInt(braced || fixed, 16)
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return all
    try { return String.fromCodePoint(cp) } catch { return all }
  })
}

// ── 二、预设指令兼容改写 ────────────────────────────────────

/** 行动选项：<options>/<option> → muv-engine 认识的「行动选项：」纯文本格式。 */
function rewriteOptions(c) {
  let s = String(c || '')
  // 先把"包在 <option> 标签里"这种描述性句子改成等价的中文，避免删标签后句意破碎
  s = s.replace(/每条选项\s*包裹于\s*<option>\s*标签中/g, '每条选项独立占一行')
  s = s.replace(/每条选项\s*用\s*<option>\s*>?\s*包[住裹]?/g, '每条选项独立占一行')
  // 整行只有一个标签的行直接删（典型是文件末尾那段"格式："示例骨架）
  s = s.replace(/^[ \t]*<\/?options?>[ \t]*\r?\n/gmi, '')
  // 剩余的内联标签
  s = s.replace(/<\/?options?>/gi, '')
  // 末尾常有一段"格式：" + 被删标签留下的占位行（典型就是"格式：\n选项"）。
  // 只在尾巴很短（≤20 字）时当成占位丢掉，避免误删真正的格式说明。
  const tail = s.match(/[ \t]*格式[:：][ \t]*\r?\n([\s\S]*)$/)
  if (tail && tail[1].trim().length <= 20) s = s.slice(0, tail.index)
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  // muv-engine 的正则是 /(?:行动选项|可选行动|行动选择|选项|options?|choices?)\s*[:：]\s*([\s\S]*)$/i
  // 原文通常已经写了"给出3个行动选项"，但结尾常是"格式："，所以补一行明确的引导语。
  return s
    + '\n\n格式：先单独一行写「行动选项：」，其后每行一个选项，每个选项以 emoji 开头。'
    + '不要使用任何 XML 标签。'
}

/**
 * 逐条检查预设模块文本，命中已知的"DSH 必然坏"模式就改写。
 *
 * 三条规则都来自 Reborn2.4 的实测：把它原样导入 dsh-tavern 后，
 * 这三条不是"效果打折"，而是**当场坏掉**：
 *   · 防截断（unicode）→ 正文变成一串 \u5c0f\u8bf4，用户根本没法读
 *   · 防截断2.0（game_content）→ 模型去调用一个不存在的工具
 *   · 行动选项（<options>）→ 与 dsh-muv-engine 的文本解析格式对不上，产出裸标签
 *
 * @param {string} name 模块名（只用于日志/说明）
 * @param {string} content
 * @returns {{content: string, fixes: Array<{id: string, note: string}>}}
 */
export function compatPresetContent(name, content) {
  const original = String(content || '')
  const fixes = []
  if (!original.trim()) return { content: original, fixes }

  let s = original

  // R1 · Unicode 转义输出要求
  // 判定：同时出现 unicode 与 (\u 或 编码/转义)。只看关键词会把"讨论编码"的条目误伤，
  // 所以要求两者同现；再把范围限制在"要求你输出"的语境里。
  const wantsEscape = /unicode/i.test(s) && (/\\u/.test(s) || /编码|转义/.test(s))
  const isInstructional = /(所有输出|全部|替换|必须|要写|输出)/.test(s)
  if (wantsEscape && isInstructional) {
    fixes.push({
      id: 'unicode-escape',
      note: '已置空：原文要求把正文写成 \\uXXXX 转义（配套 ST 的 OutputPreprocessing 前端解码器）。'
        + 'DSH 没有那条解码管线，照搬的结果是用户直接看到转义串，比截断更难读。',
    })
    return { content: '', fixes }
  }

  // R2 · 把正文塞进工具参数
  // 判定：显式点名 game_content，或"严禁直接输出 + 必须调用…工具/函数"这种句式。
  const wantsToolOutput = /\bgame_content\b/.test(s)
    || /(必须调用|严禁直接输出|全部输出)[^。\n]{0,60}(函数工具|工具函数|function|tool)/i.test(s)
  if (wantsToolOutput) {
    fixes.push({
      id: 'tool-call-output',
      note: '已改写：原文要求把正文放进 game_content 工具的参数里（该工具只存在于 SPreset 的 '
        + 'ToolBindings，DSH 并未注册，模型会去调用一个不存在的东西）。'
        + '保留它"结构化输出、可判定完整性"的意图，改用闭合标签承载。',
    })
    s = '正文用 <game> 与 </game> 包住，两个标签各占一行；正文没写完就不要强行收尾。'
  }

  // R3 · <options> 行动选项
  // 额外要求正文里出现「选项」：光有 <options> 标签不足以断定这是行动选项
  // （别的预设可能拿它当普通格式化示例），改错了比不改更糟。
  if (/<\/?options?>/i.test(s) && /选项/.test(s)) {
    fixes.push({
      id: 'options-xml',
      note: '已改写：<options>/<option> 在 DSH 侧没有渲染器，而且与 dsh-muv-engine 的'
        + '「行动选项：」文本解析格式不兼容，会同时出现两套互相打架的选项要求。',
    })
    s = rewriteOptions(s)
  }

  if (fixes.length) s = s.trim()
  return { content: s, fixes }
}

// ── 三、回复完整性诊断 ──────────────────────────────────────
//
// 截断在客户端有四种来源（搞混就会误判成"模型不听话"）：
//   A 长度上限   finish_reason = length / turn/end.reason = max-tokens
//   B 审核中断   流被上游掐断，finish_reason 常常仍是 stop，日志里看不出原因
//   C stop 序列  自己配的结束词命中
//   D 渲染层假截断  <details> 未闭合把后文吞掉、标签被拆成 <det + ails>
//
// 这里能可靠判定的是 A 和 D 的文本特征（骨架未闭合），B 需要靠 detectRefusal 的语义特征。
// 三者都记进 reply-status.json，让"这一轮为什么短"有据可查。
const SKELETON_TAGS = [
  'game', 'options', 'details', 'summary',
  'report_nya~', 'think_nya~', 'cot', 'prism',
]

/** turn/end.reason.kind 里出现这些词，基本就是被长度掐了。 */
const TRUNCATED_REASON_RE = /(length|max[_\- ]?token|token[_\- ]?limit|truncat|incomplete|overflow)/i

/**
 * 检查回复文本里的骨架标签是否闭合。
 *
 * 只看"有开无闭"：有闭无开通常是模型在正文里引用标签，不算截断证据。
 * 一个标签都没有时返回 ok=true（这个预设没用骨架，不能据此判截断）。
 *
 * @param {string} text
 * @returns {{ok: boolean, missing: string[], opens: number, closes: number}}
 */
export function checkSkeleton(text) {
  const s = String(text || '')
  const missing = []
  let opens = 0
  let closes = 0
  for (const tag of SKELETON_TAGS) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\~]/g, '\\$&')
    const o = (s.match(new RegExp('<' + esc + '>', 'gi')) || []).length
    const c = (s.match(new RegExp('</' + esc + '>', 'gi')) || []).length
    opens += o
    closes += c
    if (o > c) missing.push(tag)
  }
  return { ok: missing.length === 0, missing, opens, closes }
}

/**
 * 给一轮回复下结论。优先级：空 → 拒答 → 截断 → 可疑 → 正常。
 *
 * 拒答优先于截断：Reborn 类预设被接管时常常吐一段很短的安全声明就停，
 * 这时候骨架当然"没闭合"，但根因是拒答不是长度，报错报错方向会带偏排查。
 *
 * @param {{text: string, reasonKind?: string, refusal?: {verdict: string, score: number, hits: string[]}}} args
 * @returns {{decision: string, truncated: boolean, skeleton: object, refusal: object|null, reasonKind: string}}
 */
export function judgeTurn(args) {
  const a = args || {}
  const text = String(a.text || '')
  const reasonKind = String(a.reasonKind || '')
  const skeleton = checkSkeleton(text)
  const refusal = a.refusal || null

  let decision = 'ok'
  if (!text.trim()) decision = 'empty'
  else if (refusal && refusal.verdict === 'refusal') decision = 'refusal'
  else if (TRUNCATED_REASON_RE.test(reasonKind)) decision = 'truncated'
  else if (!skeleton.ok) decision = 'truncated'
  else if (refusal && refusal.verdict === 'suspect') decision = 'suspect'

  const truncated = decision === 'truncated'
  return { decision, truncated, skeleton, refusal, reasonKind }
}

/**
 * 给"未闭合"这件事生成一句人话，面板/日志直接用。
 * @param {ReturnType<typeof judgeTurn>} v
 */
export function describeTurn(v) {
  if (!v) return ''
  if (v.decision === 'empty') return '这一轮没有任何正文输出'
  if (v.decision === 'refusal') {
    return '疑似被安全层接管（' + ((v.refusal && v.refusal.hits || []).slice(0, 3).join('、') || '命中拒答话术') + '）'
  }
  if (v.decision === 'truncated') {
    const bySkeleton = v.skeleton && !v.skeleton.ok
      ? '骨架未闭合：' + v.skeleton.missing.map((t) => '<' + t + '>').join(' ')
      : ''
    // 只在 reason 真的指向"长度/中断"时才写出来；completed 是正常结束，写上去只会干扰排查
    const byReason = TRUNCATED_REASON_RE.test(String(v.reasonKind || '')) ? '结束原因 ' + v.reasonKind : ''
    return '疑似截断（' + [byReason, bySkeleton].filter(Boolean).join('；') + '）'
  }
  if (v.decision === 'suspect') return '有拒答特征但证据不足，留意一下'
  return ''
}
