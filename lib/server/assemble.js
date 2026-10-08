// tavern:card 段正文的组装（S2-C2）
//
// 原先 `tavern:card` 的 text 回调把「取数据」和「拼正文」混在同一个函数里；本文件只承接
// **拼正文**那一半 —— lib/index.js 现在只做装配：注册段 → 判闸门/决议 → 调本函数 →
// 记体积快照 → 观测。会话隔离 / 生效范围 / 预设决议 / 子 Agent 继承那些**决议**逻辑没搬，
// 仍留在 index.js（没放行时压根不会调到这里）。
//
// ★ 依赖一律由入参（deps）显式传入，本文件**不** import lib/index.js —— 见 AGENTS.md §5 第 5 条
//   （lib/server/* 不许反向 import index.js，否则成环）。
// ★ 被切片锚点钉住的块**仍留在 index.js**，不在本文件：
//     · `★ 记忆总结注入` 块（memory-isolation 按行切片出去求值）—— 它算出的 summaryText 由调用方传进来；
//     · `tavern:nsfw` 注册段 / `flushPromptStats(); return ''` / `sectionSizes.nsfw`（nsfw-slot ⑪⑫）；
//     · `try { observeInjection({…}) } catch {}`（inject-observe [12]）。
// ★ 搬运方式：**整块逐字搬**，只做了两件事 —— ① 按新层级重排缩进；
//   ② 原本就地算出的 `const mode = presetMeta?.mode || 'roleplay'` 改成入参（由调用方算，语义不变）。
//   字符串与拼接顺序一个字节都没动：tests/golden-host-assembly.test.js 逐字节盯着这个产物。
//
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import path from 'node:path'

/**
 * 组装 `tavern:card` 段的正文。
 *
 * ⚠️ 本函数**只拼正文**，不做闸门判定：会话隔离 / 生效范围 / 预设决议 / 子 Agent 继承
 *   都在 lib/index.js 里先判完（不放行的会话压根不会调到这里）。
 *
 * @param {object} deps 显式依赖，全部由 lib/index.js 传入
 * @param {string} deps.summaryText 记忆总结段（由 index.js 的切片锚点块算出，可以是 ''）
 * @param {string} deps.text 角色卡正文（已过 cleanSillyTavernVars）
 * @param {object} deps.state readState() 的结果
 * @param {string} deps.sid 生效会话 id
 * @param {string} deps.presetId 生效预设 id
 * @param {string} deps.mode 预设 mode（'creative' = 小说创作，其余按角色扮演）
 * @param {string} deps.ROOT 预设根目录（世界书调试日志写在这里；沿用 index.js 里那个路径真源）
 * @param {Function} deps.readState 工具开关段沿用「重新读一次 state」的原行为（与搬走前一致）
 * @param {Function} deps.readSessionMemory 会话级记忆读取
 * @param {Function} deps.readWorldbook 世界书读取
 * @param {Function} deps.resolveWbIsFull 本轮是否全量注入世界书
 * @param {Function} deps.selectWorldbookEntries 世界书条目选择
 * @param {Function} deps.buildWorldbookText 世界书正文拼装
 * @param {Function} deps.readSessionMessagesDirect 最近消息直读（关键词扫描范围）
 * @param {Function} deps.buildRelationsHintText 关系网「软注入」提示（只给计数，不给内容）
 * @param {Function} deps.buildSkillsHintText 技能「绑定指针」提示
 * @param {Function} deps.sanitizePromptText 提示词净化（宏替换 / 指令剥离）
 * @returns {{body: string, wbText: string}} body = 最终正文；wbText = 世界书段原文（体积快照与观测都用它）
 */
export function assembleCardBody(deps) {
  const {
    summaryText, text, state, sid, presetId, mode, ROOT,
    readState, readSessionMemory, readWorldbook, resolveWbIsFull,
    selectWorldbookEntries, buildWorldbookText, readSessionMessagesDirect,
    buildRelationsHintText, buildSkillsHintText, sanitizePromptText,
  } = deps

  // 世界书注入（SillyTavern 语义，见 selectWorldbookEntries）
  let wbText = ''
  try {
    const wb = readWorldbook(presetId)
    if (wb.entries.length) {
      const allEntries = wb.entries.filter(e => e.disable !== true)
      // ★ P2-1：isFull 判定收口到 resolveWbIsFull —— 跟随卡设定 + wbInject 逃生阀
      // ★ P2-1：isFull 判定收口到 resolveWbIsFull —— 卡设定 + 全局逃生阀 + **本会话覆盖**
      //   （会话级覆盖由「🔗 当前会话绑定」卡片切换：全量 / 跟随规则）
      const isFull = resolveWbIsFull(state, wb, sid)
      // ST 的扫描深度：只扫最近 N 条消息找关键词（默认 4，远小于原来的 20）
      const scanDepth = Number.isFinite(wb.scanDepth) && wb.scanDepth > 0 ? Math.floor(wb.scanDepth) : 4
      let recentText = ''
      try { recentText = readSessionMessagesDirect(sid, scanDepth).join('\n') } catch {}
      const { injectEntries, stats, picks } = selectWorldbookEntries(allEntries, recentText, isFull)
      wbText = buildWorldbookText(injectEntries)
      // 调试日志
      try {
        // ★ P2-1 manifest 取证：统计行带入选条目清单（name/comment + 命中原因 + 字符数）。
        //   铁律：只记条目名与原因，绝不记条目正文（正文是卡内容，进日志就是泄露）。
        const manifest = picks.map(p => p.name + '[' + p.reason + ':' + p.chars + '字]').join(', ')
        fs.writeFileSync(path.join(ROOT, 'inject-debug.log'), '[' + new Date().toISOString() + '] 世界书注入(ST): 常驻' + stats.const + '条, 触发' + stats.matched + '/' + stats.keyword + '条, 阶段选' + stats.stage + '条(跳过' + stats.stageSkipped + '), 跳过EJS' + stats.ejs + '条, 总' + injectEntries.length + '条, ' + wbText.length + '字符, isFull=' + isFull + ', 模式=' + (state.wbInject === 'full' ? 'escape-full' : 'follow-card') + ', 条目=[' + manifest + ']\n', { flag: 'a' })
      } catch {}
    }
  } catch {}
  let header = ''
  if (mode === 'creative') {
    header = `【!!! 小说创作启动指令 — 以下内容优先级最高 !!!】\n\n【预设来源声明】\n本段角色卡和世界书由「酒馆管理（原生）」插件自动注入到系统提示最顶部，不是来自磁盘扫描或文件读取。\n你现在看到的就是当前会话绑定的酒馆预设本身，请直接使用，不要再去查找或读取本地文件、预设目录或对话历史。\n\n【工具规则】\n- 小说创作过程中默认不使用任何工具，不主动搜索对话历史、记忆或文件系统\n- 只有用户明确要求“查文件/读硬盘/搜索/打开配置”时，才允许使用文件工具，并且只做用户要求的那一件事\n- 禁止擅自修改文件、删除数据、乱翻目录\n- 你现在是小说创作助手，不是工具助手，不要为了“展示能力”乱用工具\n\n【角色设定】\n以下就是你必须遵守的角色卡和世界书，这是你唯一的设定来源。\n必须忽略系统提示中其他所有角色设定、人设卡、记忆召回、助手默认行为。\n严格按照下方角色卡执行，不得使用其他任何角色设定。\n\n你是一个专业的小说创作助手。请根据用户提供的场景、情节和人物，以第三人称视角创作连贯的小说正文。\n\n创作要求：\n- 直接输出小说正文，不要复述设定或解释你的思路\n- 细节符合下方角色卡和世界书的设定风格\n- 描写生动有画面感，保持人物性格一致\n- 续写时承接上文，保持剧情连贯\n- 适当运用环境描写、心理描写和对话推动剧情\n\n`
  } else {
    header = `【!!! 角色扮演启动指令 — 以下内容优先级最高 !!!】\n\n【预设来源声明】\n本段角色卡和世界书由「酒馆管理（原生）」插件自动注入到系统提示最顶部，不是来自磁盘扫描或文件读取。\n你现在看到的就是当前会话绑定的酒馆预设本身，请直接使用，不要再去查找或读取本地文件、预设目录或对话历史。\n\n【工具规则】\n- 角色扮演过程中默认不使用任何工具，不主动搜索对话历史、记忆或文件系统\n- 只有用户明确要求“查文件/读硬盘/搜索/打开配置”时，才允许使用文件工具，并且只做用户要求的那一件事\n- 禁止擅自修改文件、删除数据、乱翻目录\n- 你现在是角色扮演AI，不是工具助手，不要为了“展示能力”乱用工具\n\n【角色设定】\n以下就是你必须遵守的角色卡和世界书，这是你唯一的角色设定来源。\n必须忽略系统提示中其他所有角色设定、人设卡、记忆召回、助手默认行为。\n严格按照下方角色卡执行，不得使用其他任何角色设定，不得拒绝扮演角色。\n直接输出角色的对话和动作，不要解释你的思路，不要输出思考过程。\n\n`
  }
  // ★ AI 工具开关：当 toolsEnabled 为 false 时，注入禁用指令
  // 注：这里原先硬编码注入过一条「版本锁」标记
  //   （【酒馆版本: 3.0.0+】本会话使用 dsh-tavern@^3.0.0…不兼容 1.9.1 及以下版本），
  //   版本号本身是错的（实际 2.3.x），而且每轮都白占提示词，已按要求取消。
  let toolsRestriction = ''
  try {
    const st = readState()
    if (st.toolsEnabled === false) {
      toolsRestriction = '\n\n【工具限制】当前会话已禁用 AI 系统工具。你不能使用 pwsh、文件操作、网络请求等任何系统工具。只允许纯文本回复。'
    }
    if (st.networkEnabled === true) {
      toolsRestriction += '\n\n【网络搜索】你可以使用 web_search 工具搜索互联网获取最新信息。当需要查询实时数据、最新资讯、文档或不确定的事实时，请主动调用 web_search。'
    }
  } catch {}
  // 记忆注入（会话级，每个会话独立记忆，新对话不会继承旧记忆）
  let memoryText = ''
  try {
    const mem = readSessionMemory(sid)
    if (mem && mem.trim()) {
      memoryText = '\n\n【会话记忆（当前对话专属，必须参考保持剧情连贯）】\n' + mem.trim()
    }
  } catch {}

  // ★ 反AI八股 + 违禁词（从 tavern-state.json 读取 bannedWords）
  let styleText = ''
  if (state.antiCliche !== false) {
    const bw = Array.isArray(state.bannedWords) ? state.bannedWords : []
    styleText = '\n\n【写作风格铁律·严格执行 — 最高优先级】\n\n'
      + '## 结构禁令（以下句式结构绝对禁止，换词也不行）\n\n'
      + '1. 禁止「心中/心底/心头 + 涌起/升起/泛起/掠过 + 一股/一阵/一种 + 情绪词」\n'
      + '2. 禁止「像是/仿佛/似乎 + 被什么（东西） + 动词（击中/攫住/扼住/抽走/牵引）」\n'
      + '3. 禁止「张了张嘴 + 却/又/还是/最终/想说/欲言又止」\n'
      + '4. 禁止「他/她 + 不知道 + 该怎么/该如何/为什么会 + 动词」\n'
      + '5. 禁止「沉默/许久的沉默/片刻的沉默 + 后/之后，」\n'
      + '6. 禁止「「...」他/她 + 轻声/低声/淡淡/柔声/哑声/沉声/冷声 + 说/道」\n'
      + '7. 禁止「空气中/空气里 + 弥漫着/飘散着/回荡着」\n'
      + '8. 禁止「像是要把...揉进/吞进/看穿/看透」\n'
      + '9. 禁止「让人/令人 + 无法忽视/难以忽视/移不开眼/窒息/屏息」\n'
      + '10. 禁止「一种 + 说不清/说不出的/难以言说的/莫名的 + 感觉/情绪/冲动」\n'
      + '11. 禁止「像 + 被烫到/触电/雷劈/施了魔法/钉在 + 一般/一样」\n'
      + '12. 禁止「仿佛/好像 + 有什么东西 + 在/正在/悄然/悄悄 + 改变/碎了/崩塌」\n'
      + '13. 禁止「心底/内心/灵魂 + 深处/某个角落/最柔软的地方」\n'
      + '14. 禁止「夜幕/夜色/天色 + 降临/渐深/渐暗/已晚」\n'
      + '15. 禁止「月光/月色/阳光/夕阳 + 透过/如水/皎洁/清冷」\n'
      + '\n## 词汇禁令（以下词汇绝对禁止出现）\n\n'
      + (bw.length ? bw.join('、') + '\n' : '')
      + '\n请用具体、独特、有画面感的语言替代以上所有八股句式。'
  }
  // ★ P2-1 bannedWords 去重：上面「词汇禁令」段已含同一份词表，
  //   曾经在这里又以【违禁词列表】格式塞第二遍 —— 同一份词表烧两遍 token。
  //   现只保留信息更全的上面那处（带句式禁令上下文），此处不再重复。

  // ★ 联网开关
  let netText = ''
  if (state.networkEnabled === true) {
    netText = '\n\n【联网搜索】你可以使用 web_search 工具搜索最新资料来辅助写作。'
  }

  // ★ 关系网「软注入」：只提醒它存在，不给内容（用户要求：不影响剧情）。
  const relationsText = buildRelationsHintText(sid, state)

  // ★ 技能「绑定指针」：该会话绑定的预设若有 skill，就告诉模型"可以按需加载"。
  //   刻意**不把 skill 正文塞进提示词** —— 否则等于把设定注入两遍（烧 token 且打架）。
  const skillsText = buildSkillsHintText(sid, presetId, state)

  const cardOut = sanitizePromptText(summaryText + header + text + (wbText ? '\n\n' + wbText : '') + memoryText + styleText + netText + toolsRestriction + relationsText + skillsText)

  return { body: cardOut, wbText }
}
