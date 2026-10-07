# Changelog

## v2.7.1 (2026-10-07) — 🧹 删除「编辑 AI 回复」整条功能 + 5 处内联事件属性清零

### 1. 删除「编辑 AI 回复」（整条功能下线，含服务端事实修正段与历史改写路由）

**为什么删**：用户反馈「编辑 AI 回复后 AI 并不遵守」。它靠两件本就不可靠的事：
① 直接改写 DSH 会话日志（自己提示"保存后需重启 dsh 生效"）；② 往系统提示里塞一段
「对话历史事实修正」。两者都不是真的在改模型看到的那条历史 —— 于是**删掉**，不留半截。

- 客户端 `lib/client.manager.bundle.js`：
  - `startEdit()`（编辑层 overlay / 保存 / 取消 / 恢复原文）整块删除；
  - 消息右下角的 ✏️ 按钮与其 hover 显隐、`tavernEditIndex` / `tavernEditApplied` 标记删除；
  - 「✏️ 已修正（影响后续生成）」徽章删除；
  - `editedCache` / `loadEditions` / `saveEdition`（含 `/api/tavern/edited-messages` 与
    `/api/tavern/edit-history` 两处 fetch）及其全部调用点删除；
  - `getMessageContentEl()` 随编辑覆盖一起失去了唯一调用者，一并删除；
  - `initMessageEditor()` 更名 `initMessageBeautifier()` —— 它现在只负责美化，不再"编辑"。
- 服务端 `lib/index.js`：
  - `tavern:edits`（order=0）注入段整块删除（`【最高优先级 — 对话历史事实修正】` 构造）；
  - 路由 `/api/tavern/edited-messages`、`/api/tavern/edit-history` 删除；
  - `readEditedMessages` / `writeEditedMessages` / `editHistoryMessage`、
    `EDITED_MESSAGES_FILE`（两处赋值）删除；
  - 卡组装处的 `editsText` 及其拼接项删除（`memoryText`/`styleText`/`netText` 等相邻项未动）；
  - `sectionSizes.edits` 与 prompt-stats 输出的 `edits` 字段删除，`total` 口径同步改；
  - 服务端统计页与客户端体积面板里的「事实修正」字段删除显示。
- **注**：`~/.dsh/.agent-presets/edited-messages.json` 是**用户数据**，未触碰；代码已不再引用它。
- 体积快照落盘**没有丢**：原先由 `tavern:edits` 段负责调用的 `flushPromptStats()`，
  改由 `tavern:nsfw` 段（order 仍为 -1）在每条返回路径上调用，行为不变。

### 2. 修 `tabKeyForTail` 漏「元素自身」（真 bug）

散件规则里 `#tavern-extra` 写的是**那个 textarea 自身**，而旧实现只 `el.querySelector('#id')`
查后代 ⇒ 这个控件永远搬不进「内容」页签，被留在页签外。现在同时认「自身命中」与「后代命中」。
`tests/panel-tabs.test.js` 新增 ⑤b：真跑 `installPanelTabs`，断言 `#tavern-extra`
**必须**落进 `content` 页签、且仍留在面板根下 = 判据失败。

### 3. 页签 hover / 选中不再长得一样 + 焦点环

`.t-tab:hover` 与 `.t-tab.active` 原先同用 `--dsw-alias-bg-layer-2`，肉眼分不出"鼠标划过"和"当前页签"。
hover 改走 `--dsw-alias-interactive-bg-hover`（浅一档），active 保持 layer-2 + 边框 + 加粗；
并补 `.t-tab:focus-visible` 焦点环（`outline: 2px solid var(--dsw-alias-brand-primary)` + `outline-offset: 2px`）。

### 4. 删除坏掉的批量删除路径（死代码 + 点击必抛异常）

`#tavern-preset-batch`（常驻 `display:none`）与 `#tavern-batch-box` 面板的 markup + 处理器整块删除。
它们读的 `#tavern-batch-box` / `#tavern-batch-del` / `sessionPresetSelect.options`
早已不存在 —— 这段代码一旦被触发**必抛 TypeError**。
可用的那套（每行复选框 + `#tavern-preset-batch-del2`）**未动**。
顺带修掉同区域的连带引用：删除预设后"自动绑定到第一个预设"原先读那个已不存在的下拉框，
改用面板自己的 `state.presets` / `getActivePresetId()` 取同一个值。

### 5. 5 处内联事件属性 → 事件委托（`inlineHandlerAttr` 5 → 0）

世界书列表的删除本/删除条目/勾选框 + 关系网详情面板的两处「点击空白处关闭」，
全部改为容器上的**事件委托**（`closest('[data-wb-group-action="delete"]')` 等）。
行为等价：删除按钮的点击**不冒泡**到条目行，因此不会顺带触发展开/折叠。
`inlineHandlerAttr` 从棘轮**升级为硬规则**（恒为 0）。

### 6. 测试与 UI 文案解耦 emoji

`tests/scope-panel-ui.test.js` 原先断言 `>🌍 所有会话生效<` 这类**可见文案 + emoji**（16 处断言/测试名），
文案一改测试就红。改为断言稳定标识：给三个范围按钮加 `data-scope-mode="global|session|cwd"`、
解绑按钮加 `data-action="unbind"`，测试断言 `data-*`（**未改任何可见文案**）。

### ✅ 验证

- 全量 **433/433 通过**（22 个文件；改前 432/22，净 +1 = 新增 panel-tabs ⑤b ——
  删除的是**断言行**而非测试项，所以每个文件的项数不变）；
- `node --check` 全过（4 个 lib 文件 + 22 个 tests + 2 个 tools）；
- 样式预算通过，并**全线下调**：内联事件属性 **5 → 0**、内联样式 312→301、裸 hex 352→331、
  rgba 160→150、`cssText` 赋值 72→59、颜色字面量 58→53 种、padding 变体 46→42、z-index 11→8；
- 残留 grep（`lib/`）：`saveEdition|loadEditions|editedCache|startEdit|tavern:edits|edited-messages|edit-history` 全部 **0**
  （`tavern-preset-batch` 仅剩保留项 `#tavern-preset-batch-del2` 的 2 处命中，属正常）。

### 🔍 顺手发现（未在本版处理，已记账）

- `lib/index.js` 里服务端**自渲染的设置页**仍有 2 处内联 `onclick="saveWin()"` / `onclick="save()"`。
  它不在 `tools/assert-style-budget.mjs` 的统计范围内（该脚本只量 `lib/client.manager.bundle.js`），
  所以硬规则不会因此变红；如要彻底清零内联事件属性，需一并把这两处改成 `addEventListener`。
- `lib/index.js` 的 `writeSessionLines()` 随 `editHistoryMessage()` 一起失去了唯一调用者，
  现在是**未使用的死函数**（保留：它是"重写整份 zstd 会话"的唯一实现，
  注释里还引用它警示"不要改写会话日志"）。若确认永久不用，可另行删除。

## v2.7.0 (2026-10-07) — 🧭 声明式页签归属 + 📏 样式预算棘轮

### 1. 卡片的页签归属改为**声明式**（\data-tv-tab\）

以前面板按**卡片标题的字符串前缀**分页签（\TAB_DEFS[].titles\ + \	.indexOf(prefix) === 0\）。这个做法有个隐蔽的坏处：
**标题一改（哪怕只是加个 emoji），前缀就匹配不上，卡片会静默掉出页签体系** —— 不报错，只在用户发现"卡片不见了"时才暴露。

现在：**一级卡片自己在 markup 上声明** \data-tv-tab="<页签 key>"\，这是唯一权威来源；标题前缀只作**回退**，
并且回退失败会被**运行时自检点名**：

- 12 张一级卡片全部注入声明（映射与改造前逐张一致，行为不变、只换机制）；
- \installPanelTabs()\ 先读声明 → 声明缺失/非法才回退标题前缀 → 把没被收走的卡片写进
  \#tavern-manager[data-tab-unclaimed]\ 并在控制台 \console.warn\ 点名（**未归类 ≠ 消失**：卡片仍留在面板里可见）；
- 测试升级：\	ests/panel-tabs.test.js\ 改为解析 \data-tv-tab\，并新增两条**行为测试** ——
  ④c「声明优先于标题」（把标题改成映射不出来的，卡片仍按声明归位）、
  ④d「自检点名」（声明非法且标题认不出 ⇒ 被点名且保持可见）；
- 另加一条**一致性硬约束**：每张卡片的声明必须与标题前缀指向同一个页签（迁移期最容易被漏掉的漂移）。

### 2. 样式预算棘轮（\	ools/\）

\lib/client.manager.bundle.js\ 是**单文件直发**的界面代码（没有构建步骤，这个 bundle 就是源码）。
在这种约束下，"UI 越来越脏"没法靠一次重构解决，于是引入**可测量的棘轮**：

- \	ools/assert-style-budget.mjs\ + \	ools/style-budget.json\：把当前 12 项指标记账，**以后只许降不许升**；
  想加新颜色/新内联样式？必须在同一次提交里跑 \--update\ 并说明理由 —— 让 review 看见，而不是无声堆积。
- 硬规则：\!important\ 必须恒为 **0**（当前 0 ✅）。
- 记账：内联样式 312、裸 hex 352、rgba 160、\cssText\ 赋值 72、颜色字面量 **58 种**、padding 变体 46、
  内联事件属性 **5**（历史遗留，记为棘轮：只许降不许升）。
- \
pm run check:style\ 一条命令校验；\	ests/style-budget.test.js\（7 项）把它挂进测试套件，
  其中 ① 用合成样本证明**指标不是空跑**（数字逐个对得上）+ 注释行不会被误计。

### 3. \
pm run test:each\

逐个测试文件独立跑并给汇总表。原因：原来的 \	est\ 是一条 \&&\ 长链，**第一个红项就把后面的全跳过**，
"还有几个文件是红的"看不出来。

### ✅ 验证

- 全量 **432/432 通过**（22 个文件；新增 panel-tabs 2 项 + style-budget 7 项）；
- 语法检查全过（含两个新工具脚本）。

### 🔍 顺手发现（未在本版处理，已记账）

- markup 里仍有 **5 处内联事件属性**（世界书条目的 \stopPropagation\/勾选、关系网模态两处）。
  改写它们需要浏览器里交互验证，属于独立任务；已作为**棘轮**禁止增长。
## v2.6.1 (2026-10-07) — 🔴 渲染层 HTML 注入修复（issue #14）

**问题**：关系网渲染（小图 + 大图两个函数）把**模型输出**的数据直接拼进 `innerHTML`；
世界书条目正文直接拼进 `<textarea>`。这条链是闭合的：对话/角色卡 → 自动总结 → 落库 →
前端**自动重画**（不需要用户点任何东西）⇒ 注入的脚本在 DSH Web UI 的源里执行，
而那个页面持有 DSH API 凭据，足以**以用户身份驱动 agent**。

**修了什么**：
- `esc()` 补上单引号（原本只吃 `& < > "`）—— 属性值常以单引号包裹，只挡 `"` 等于没挡；
- `escAttr()` 原实现是**空操作**（`esc` 之后 `replace(")` 永不命中），改为复用 `esc`；
- 关系网两个渲染函数里**所有**模型字段（`e.source` / `e.target` / `n.label` / `n.id` /
  `e.label` / `other` / `truncate(ed.label…)`）一律过 `esc(...)`；
- 世界书：正文过 `esc(...)`，条目名称/关键词统一走 `escAttr(...)`。

**测试**：新增 `tests/render-escape.test.js` —— 转义函数的真假两态、5 组注入载荷、
关系网区段"零裸拼接"扫描、世界书正文断言；每条"必须转义"都配**旧实现反例**，证明判据不是永真。
# Changelog

## v2.6.0 (2026-10-04)

### ✨ 恢复「成人向提示段」：**机制**回来了，正文由你自己填

背景：v2.5.1 曾按指示把 `tavern:nsfw` 破限段连正文一起整段删除。这次恢复的是**机制与入口**，
不是那段固定文案 —— 正文改成**使用者自己填的可编辑字段**。

| 恢复了什么 | 说明 |
|---|---|
| `tavern:nsfw` 注入段 | 按会话注入；过 `isTavernSession` + `decideInjectionScope` 两道判据（不会再出现串台） |
| `state.nsfwEnabled` 开关 | 面板「🎲 玩法 → 🔞 成人向提示段」勾选，实时写入服务端 |
| **正文可编辑**（本次新增的设计） | `state.nsfwPrompt` + 面板文本框；注入的就是这段原文，插件不加工、不截断 |
| 体积统计 | 面板「📏 提示词体积」多一行"成人段"；`prompt-stats.json` 增加 `nsfw` 字段并计入 `total` |
| 顺序 | `order: -1`，排在 `tavern:edits`(order=0) 之前 —— 体积快照仍由 edits 落盘，位置没动 |

**为什么正文做成 state 字段、而不是写回代码**：

- 正文因此**不进代码、不进 npm 包**：不会随发布出门，也**不会被升级覆盖**；
- 插件本身保持"不含该段正文"—— 写什么尺度、要不要用，是使用者自己的事。

**升级影响**：**零行为变化**。默认 `nsfwEnabled: false` + 空正文 ⇒ 一个字节都不注入。
`tavern-state.json` 里若留着旧的 `nsfwEnabled: true`，只要正文为空同样不注入。

### 用法

1. 面板 → **🎲 玩法** → **🔞 成人向提示段**；
2. 把正文粘进文本框 → **💾 保存正文**（失焦也会自动保存）；
3. 勾选「启用」→ 下次组装提示词生效。

正文只存在本机 `<DSH_HOME>/.agent-presets/tavern-state.json` 的 `nsfwPrompt` 字段里。

### ✅ 验证

- 新增 `tests/nsfw-slot.test.js` **14 项**：默认零注入 / 开关与正文真假两态 / 会话隔离 /
  生效范围闸门（allowlist 双空、名单命中、global 下的 cwd 黑名单）/ state 路由往返 /
  类型与长度上限（20000 字符）/ 源码护栏（默认正文为空、槽位必须过闸门、客户端卡片与页签、随包代码不含现成文案）；
- 旧测试按新契约改写：`core.test.js` P0-5b（"段必须消失" → "槽位必须在且默认空"）、
  `panel-tabs.test.js`（卡片数 11 → 12；🔞 文案从"禁止出现"改为"必须可见且落在玩法页签"）、
  `cordis-mount.test.js`（注入段 2 → 3）；
- 全量回归 **416/416 通过**，语法检查全过。

## v2.5.5 (2026-10-04)

### 🔒 隐私：清洗仓库与发布包里的「本机标识」（无行为变更）

仓库和发布包里残留了**开发机上真实的预设目录 id、预设显示名、角色卡名** —— 它们出现在历史
故障的注释与回归夹具中。这些**不是聊天记录、也不含角色卡/世界书正文**，但属于使用者的私有标识，
不应公开。

已全部替换为虚构占位，并复查到 **0 残留**：

| 类别 | 数量 | 替换为 |
|---|---|---|
| 预设目录 id（真实 slug） | 5 个 | `preset-fixture-a1` … `preset-fixture-a5` |
| 预设显示名 | 1 个 | `示例预设` |
| 角色卡名 | 3 个 | `示例卡` / `示例卡B` / `示例角色卡` |
| 会话 id | 2 个 | `session-0000aaaa` / `session-0000bbbb` |

- 涉及 **11 个文件**：`lib/index.js`、`lib/client.manager.bundle.js`、`CHANGELOG.md` 与 8 个测试文件；
- 替换**自洽**（夹具值与其断言一起改）⇒ 语义不变，全量回归 **403/403 通过**、语法检查全过；
- 已发布旧版本（≤ 2.5.4）无法回溯修改，npm 上仍带这些字符串；**2.5.5 起干净**。

### ✅ 验证

- 全量 **403/403 通过**；
- 复查：仓库 + 已发布 tarball 里真实标识 **0 处**，且无 token、无本机绝对路径、包内不含 `tests/`。

## v2.5.4 (2026-10-04)

### 🧹 删除「自动播种开场白」整套退役机制

v2.5.3 已经把它改成 fail-closed（在新会话上必然拒绝、一个字节都不写），也就是说它
**永远不会生效了**。既然退役，就按用户要求连根删掉，不留会误导后人的死代码：

| 删除 | 它原来干什么 |
|---|---|
| `seedGreetingMessage()` | 把开场白当首条 `assistant/message` 写进会话日志（**就是把 5 个会话写坏的那段**） |
| `seedGreetingForSession()` | 上面那个的评估/安全阀层（开关、子会话、判重、回合号对账） |
| `armGreetingSeed()` | 安装 `agent/created` / `agent/inbox/inserted` / `agent/request-error` 三个监听去触发播种 |
| `appendGreetingPreamble()` + `GREETING_PREAMBLE` | 撞 400 时补种一条 user 引导（同为 surface 事件，一样会写坏日志） |
| `greetingSeeds` / `greetingWatched` / `greetingDowngraded` / `greetingIdsOf()` | 播种用的去重与记账 |
| `hasLiveUserMessage()` / `closeDanglingBracket()` | 只被上面这些调用的辅助函数 |
| `noteGreetingRejected()` | 记录"模型网关拒绝 assistant 打头"（那个前提已作废） |
| 状态位 `greetingSeedEnabled` | 开关。现在整个字段不再被读写（`tavern-state.json` 里的残留键被忽略，无需清理） |

**保留**（这是现在唯一合法的开场白路径）：

- `canAppendGreetingSurface()` 闸门 —— 仍然守着**手动注入**：日志里已有 `system/message`
  才允许追加 surface 事件；
- `appendGreetingToSessionEnd()` / `insertGreetingForSession()` / `pickGreetingCard()` /
  `greetingTextFor()` / `hasCardGreeting()` —— 面板「📌 开场白 → 注入开场白到会话末尾」；
- **从 `armGreetingSeed()` 里拆出 `armLiveAgents()`** —— 只保留 `agent/created` /
  `agent/inbox/inserted` 两个监听做**活会话登记**（手动注入 API 要按 sessionId 找到 Agent）。
  拆出来是必须的：原来登记和播种是同一个监听里的两件事，直接删掉播种会把登记一起带走，
  手动注入就会报"找不到会话"。

**行为**：新会话不再有任何自动写入；开场白只能手动注入，且要求该会话已经跑过至少一个回合
（否则服务端明确拒绝并说明原因）。`noteGreetingSeed()` 更名为 `noteGreetingLog()`，
日志文件名仍是 `greeting-seed.log`（不打断历史排查习惯，旧行还留在那儿）。

### ✅ 验证

- `greeting-seed.test.js` 40 → **23 项**：删掉全部播种用例（它们测的机制已不存在），
  保留并强化闸门 / 事故现场重演 / 手动注入 / settlement / 源码护栏。
  新增护栏「**播种 API 必须整体不存在**」——9 个已删除的名字只要在**代码**里再出现就变红
  （注释里提到它们是被允许的：那是"这里曾经有什么"的说明），并带一条反例证明判据不是永真。
  另一条护栏要求 `apply()` 必须调 `armLiveAgents(ctx)`，且登记监听里**不许出现
  `session.append(`** —— 从源码层面堵死"顺手把播种加回来"。
- 全量回归 **403/403 通过**（用例总数下降是删除了失效用例，不是失败）。
- `lib/index.js` 里对 9 个已删除符号的**代码引用为 0**（仅注释保留历史说明）。

## v2.5.3 (2026-10-04)

### 🔴 严重：开场白播种会把会话日志写坏到**永久打不开**（5 个会话中招）

**症状**：打开旧会话直接报

```
历史加载失败：stored session "session-XXXX" is corrupt:
  SessionFormatError: system/message requires a protected first surface head
```

会话不是"历史丢了"，而是**日志被写成了非法顺序**，只能删掉那条抢跑消息才救得回来。

**根因**：DSH 加载 v4 日志时按顺序维护两条状态 ——
`hasSurface`（出现过任一 surface 事件）与 `head`（**只有**在还没有任何 surface 事件时出现的
`system/message` 才会被登记为受保护 head，实现在 `restoreReleasedV3Artifact` 与 v4 relationships
两处）。于是「**先写了一条 assistant 消息、之后才出现 system/message**」的日志一定抛错。

而 `seedGreetingMessage()` 正是这么干的：新会话第一轮就把角色卡开场白写成 `assistant/message`，
排在真正的 `system/message` 之前。旧注释里那句"网关实测接受 assistant 打头"说的是**模型网关**
（那一层确实接受 `deepseek-official` / `bailian`），**会话日志层从来不允许** —— 两层规则被混为一谈了。
凡是「先被种了开场白、之后再跑带系统提示的回合」的会话，第二轮写 `system/message` 时必炸。

已确认有 **5 个会话**因此打不开（会话 id 属本机数据，此处不列出）
（已用外部脚本删掉抢跑消息救回，现全部 `OK`）。

**修法（fail-closed）**：三处 surface 写入点共用一道闸门
`canAppendGreetingSurface(session)` —— **日志里已经有 `system/message` 才允许再写 surface 事件**，
判据还要确认"首个 surface 事件就是 `system/message`"（已经坏掉的日志不再去动它）：

| 写入点 | 旧行为 | 现在 |
|---|---|---|
| `seedGreetingMessage()` | 新会话第一轮写 `assistant/message` ⇒ 弄坏日志 | 没有 head 就**拒绝**，一个字节都不写 |
| `appendGreetingPreamble()` | 撞 400 时补 `user/message`（同为 surface）⇒ 同样弄坏 | 同上，没有 head 就拒绝 |
| `appendGreetingToSessionEnd()`（手动注入 API） | 对"还没跑过回合"的会话直接写 ⇒ 弄坏 | **抛明确错误**："这个会话还没跑过任何回合…请先发一句话起头" |

**行为变化（必须知道）**：新会话在跑第一个回合之前，日志里**没有** `system/message`，
所以「新会话自动开场白」在当前 DSH 版本下**不可能合法实现** —— 该功能实际上已退役
（`greetingSeedEnabled` 开关变成"写不写一行 skip 日志"的区别）。
开场白仍然可以拿回来：对**已经跑过回合**的会话用 `POST /api/tavern/greeting/insert` 手动注入。

### ✅ 验证

- `greeting-seed.test.js` 33 → **40 项**，新增：闸门真值表（5 种日志形态）、
  「新会话 ⇒ 拒绝且一个字节都不写」、手动注入抛错、`no-system-head` 原因码、
  **事故现场重演**（本地镜像 DSH 的 head 校验：旧行为必被判 corrupt，新行为通过）、
  以及两条源码护栏（三处写入点都必须过闸门，删掉即变红）。
- 全量回归 **420/420 通过**。
- 用外部脚本体检本机会话：**11 个会话全部 `OK`**，且逐个确认"首个 surface 事件都是
  `system/message`"、**不存在潜伏中（下次发消息才炸）的会话**。

## v2.5.2 (2026-10-03)

### 🐛 点「🎓 技能」的按钮后聊天输入框会点不动（用户实测）

**症状**：在酒馆面板里点 🎓 技能 的「生成 / 刷新 / 删除 / 切形态」之后，**页面其它部分一切正常，
但聊天输入框点不动、光标不出来、打不了字**，只能重启 DSH。

**根因**：那四个按钮的收尾动作都会调 `loadSkills()`，而这条链路上有**两个由点击引发的副作用**：

| # | 旧行为 | 为什么有害 | 现在 |
|---|---|---|---|
| 1 | `loadSkills()` **每次都打一次** `/api/tavern/tool-probe`，而该接口会**真的往宿主工具注册表注册一个探针工具再 dispose** | 等于每点一次技能按钮就动一次宿主状态（注册/回收都带副作用） | 接口改**纯只读**（只报 `hasToolsService` / `hasRegister` / `canRegister`，不注册任何东西）；客户端**一个页面生命周期只问一次**并缓存显示 |
| 2 | 「生成 / 切形态」**无条件重写 `SKILL.md`**（「酒馆默认」那份 ~19 万字节） | DSH 用 chokidar 监视 `<DSH_HOME>/skills` ⇒ **写一次盘 = 宿主重新加载一次技能清单** | 内容与磁盘一致时**一个字节都不写**：返回 `unchanged: true`，mtime 一动不动 ⇒ 宿主连事件都收不到 |

> 探测接口的"能力"信息一个不少（下一步做 tavern 查询工具的依据仍在），只是不再靠"真注册一次"来证明。

### 🛡️ 新增：聊天输入框遮挡守卫（诊断 + 自愈）

即使上面两处是主因，也补一层网：每 1.5 秒做一次极便宜的体检——取输入框中线上一点问
`document.elementFromPoint` 命中的是谁。

- 命中**酒馆自己的**浮层（id/class 带 `tavern`）⇒ 直接让它对点击透明（自愈），并把结果写进技能卡片状态行；
- 命中**别人的**元素 ⇒ **只报告名字，绝不动别人的 DOM**（证据留给定位）；
- 设置页正开着时跳过（那时输入框被页面盖住属于正常布局）。

下次再遇到，不用重启 DSH：状态行/控制台会直接说出是谁挡住了输入框。

### ✅ 验证

- 新增 `tests/skill-card-sideeffects.test.js`（5 项）：连问 5 次探测接口**零注册**、
  内容一致时 **mtime 一动不动**、形态真变时照样写盘、预设不存在时不许偷偷造目录。
- 全量回归 **413/413 通过**（`skill-gen.test.js` 的 ⑯ 从"探针必须注册并回收"改写为
  "探针只读、连点零副作用"，并新增 ⑯b 覆盖"宿主没有 tools 服务"）。

## v2.5.1 (2026-10-03，发布)

### 🔧 兼容性：不再被新版 DSH 判为「插件过期」自动屏蔽（#11）

**根因（这次查到了确凿位置）**：DSH 在导入插件前，会用**包自己的 `peerDependencies`** 里所有
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 声明去比对运行时版本，**全部命中才放行**
（`dsh-*` 文档原文：*"These checks use peer declarations, not `engines.dsh`"*）。
而 semver 对**预发布版本**有一条硬规则：`1.2.3-alpha` 只能被「**同 major.minor.patch 元组**且带预发布的比较器」接受。

我们此前声明 `^0.1.0-rc.6`，用 DSH 自带的 semver 实测结果：

| peer 范围 | 0.1.0-rc.6 | 0.1.5-rc.2 | 0.2.0-rc.2 | 0.2.0 |
|---|---|---|---|---|
| `^0.1.0-rc.6`（旧） | ✅ | ❌ | ❌ | ❌ |
| 本版（全元组联合） | ✅ | ✅ | ✅ | ✅ |

也就是说：**任何一个预发布运行时（0.1.5-rc.x、0.2.0-rc.2 都在内）都会把本插件判为不兼容**，
用户必须在 profile 的 `compatibility.json` 里手工加精确版本豁免才能装上——这就是「最新版 DSH
认为插件过期、自动屏蔽」的真正来源，**不是 DSH 的问题**。

**修法**：改成覆盖所有已发布运行时的联合范围（每个预发布元组各一条）：

```
"@deepseek-ai/dsh-client-runtime":
  "^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-alpha.2 || ^0.1.5-rc.1 || ^0.2.0-rc.2"
```

已验证：8 个运行时版本（0.1.0-rc.6 → 0.2.0）全部通过。**升级后不再需要手工豁免。**

### 🐛 会话串台：面板不再采信"自己写下的旧会话"（#10）

0.2.0 的 sessions 快照里**没有 `current` 字段**（`{ids, byId, phase, projectionsBySession}`），
而兜底链最后一环是插件自己上次写进 `data-dsh-current-session` 的**旧值** ⇒ 切换会话后面板、
记忆、关系网全都停在上一个会话。

- 判据换成 DSH 自己用的那个：列表行上的 `retainedBy.mainView > 0`（**空白新会话同样成立**）；
- `getCurrentSessionId` / `resolveCurrentSessionId` / `resolveFromServer` 三处一起换；
- 插件自己写下的属性**从"依据"降级为"最后兜底"**，不再优先。

### 🐛 新建预设不再往 DSH 名册塞空壳

声明行是从磁盘上的 `agent.cordis.yml` 渲染的，而「＋ 新建」那一刻磁盘上只有**空骨架**
（persona 的 prefix 为空、没有任何工具行）；旧流程紧接着就同步声明，且此后**保存预设不再重新同步**，
于是名册里永久停着一行「有名字但完全不起作用」的预设。

- 骨架组合不再声明（返回 `not-saved-yet` 并告诉用户先保存）；
- **保存预设后重新同步一次**（只在真的写了组合文件时，自动保存不算）；
- 内容没变则不写盘、不备份（此前每次保存都会在 `tavern-data/backups/` 堆一个 `.bak`）。

### 🐛 预设名被覆盖成目录名

自动保存（`dataOnly`）不带 `presetYml`，旧代码在此处用 `presetId`（= 目录名）兜底并写回 `preset.yml`，
把「酒馆默认」永久改成了 `tavern-lite`。现在名字优先级为
**本次带来的 → 磁盘已有的 → 注册表**，且当磁盘上的名字等于目录名/id（bug 痕迹）时改用注册表真名。

### 🐛 导入世界书文件不再被吞成空卡

SillyTavern 的「世界书导出」也是 `.json`（形如 `{entries:{…}}`）。此前从「角色卡」入口导入，
会静默塞进一张 name/description/first_mes 全空的卡，用户以为"卡进来了但世界书没跟来"。

- 识别为世界书格式 ⇒ **自动改道世界书导入**并在状态栏说明；
- 没有任何角色卡字段的 JSON ⇒ 明确拒绝并提示用「世界书」入口，不再产出空卡。

### ➖ 移除：成人模式注入（#2）

该开关与对应的破限注入段已整块删除。issue #2 报告的是"没开开关却被写入成人注入"，
其根因（前端内存默认值与服务端状态不同步）随功能移除一并消失——此处如实记为**移除**，不是"修好了开关"。

### ✅ 本版同时关闭的历史 issue

- **#1** 桌面版 `DSH_HOME` 重定向后预设写进 DSH 扫不到的目录 —— 2.3.5（PR #8）已修；
- **#5** persona `text:` → `prefix:` —— 2.3.5 已修（`extractCardText` 兼容两种键名）。

### 验证

- 全量单测：**407/407 通过**
- 兼容范围：用 DSH 内置 semver 逐版本比对（8 个运行时全 ✅）

---

## v2.5.1 开发期记录（2026-09-27 起，已并入上方发布条目）

> 下列内容在发版前一直挂在本地（`package.json` 的 version 当时故意保持 2.5.0，
> 避免 pnpm 去 registry 找一个还不存在的版本）。本版统一 bump 到 2.5.1 并发布。

### 🔗 会话绑定改走 DSH 原生 agentPreset：空白新会话也能绑定，注入严格按会话隔离

用户诉求：**「保存预设就是保存一个 agent 预设」「只有会话选择了这个酒馆 agent 预设才管」
「防止串会话」「不用先发一条消息才能绑定」**。本次把这四点落到 DSH 自己的机制上。

#### A. 根因：面板根本拿不到「当前会话」（尤其空白新会话）

- 客户端主路径读 `ctx.sessions.list.getSnapshot().current` —— 而 DSH 的会话列表快照里
  **没有 `current` 字段**（session-controller 的 list store 初始化就是
  `{ids, byId, phase, projectionsBySession}`），这一路永远 undefined；
- 兜底三路（URL / 面包屑 / `data-dsh-current-session` 属性）在空白新会话上同样取不到：
  **DSH 从不用 URL 表达会话**（ui-workspace 里没有任何 location/history 用法，
  切换会话只改内存 + localStorage），而那个属性是「上一个会话」的旧值。
- 结果：面板提示「先发一条消息，再回来操作绑定」，`/api/tavern/bind-preset` 也被 400 顶回
  ⇒ **新会话的首条消息裸奔**（角色扮演的第一个回合没有卡、没有世界书）。
- 修法：新增 `dshMainViewSessionId()`，判据换成 DSH 自己用的那个 ——
  列表行上的 `retainedBy.mainView > 0`（DSH 的 `mainSessionId()` / `uiSession.current` /
  agent-preset 的 `mainBlankSeat` 都是它，**空白新会话同样生效**）。
  `getCurrentSessionId` / `resolveCurrentSessionId` / `resolveFromServer` 三处一起换掉。

#### B. 绑定 = 会话的原生 agentPreset（服务端）

- `POST /api/tavern/bind-preset` 现在**先调 DSH 原生服务**
  `ctx.get('agentPresets').select(agent, '<目录名>')`：DSH 会把 `agent-preset/selected`
  追加进**该会话**的事件流 ⇒ 顶部预设选择器、酒馆注入决议、会话隔离三者同源；
  空白会话（`turnBoundary.lastTurn === 0`）正是它允许的唯一窗口。
- 酒馆自己的 `session-bindings.json` 从「唯一依据」降级为**兼容兜底**：原生成功时它只是
  同一事实的第二份记账；原生走不通（旧版 DSH / 会话已开跑）时仍保住世界书/记忆跟随。
- 别名换算：酒馆注册表的 `default` → DSH 侧的目录名 `tavern-lite`（`agentPresetIdFor`）。
  两套 id 混用会直接选错预设，已有单测钉住。
- **如实回报**：响应新增 `native` / `nativeOk` / `locked`，把
  `agent-preset/locked`（会话已开跑，DSH 锁定卡片本体）、`agent-preset/not-found`、
  `agent-preset/invalid` 分开透出；面板据此给出准确文案，不再把失败说成成功。
- `POST /api/tavern/unbind-preset` = **原生交还** DSH 部署默认预设
  （读 `settings.yaml` 的 `agent-presets.default`，实测 `standard`），而不是只写
  `{mode:'none'}` 让顶部选择器继续显示酒馆卡。
- 写绑定的入口收紧（并入装机版 2026-09-27 的手改）：漏传 `sessionId` 直接 400，
  **不再兜底 `lastSessionId`** —— 那是全进程全局量，可能指向别的会话（绑错会话 = 串台）。

#### C. 注入决议：以「会话当下的原生预设」为第一权威（同时不咬死已开跑会话）

- 新增 `nativeAgentPresetOf(ctx, sid)`：读 DSH 原生投影
  `ctx.sessionProjections.stateOf(session, 'agentPreset')`（与 DSH 的 `presetForSession` 同源），
  不依赖 zstd 日志落盘。
- 决议权威次序（2026-09-27 定稿，**三个**失败模式都要挡 —— 少挡一个就出一类回归）：
  - **ⓐ 投影挂的是酒馆预设**，且能证明「不是出生值」（日志缺失 / 没 header / 与 header 不同）
    ⇒ 注入它。覆盖：空白会话用 DSH 新建页的预设条选卡、面板的原生绑定、
    以及「部署默认就是酒馆预设」的机器。
  - **ⓑ 投影挂的是非酒馆预设**，且与出生 header **不同** ⇒ 一定有人刚换过、那帧还没落盘
    ⇒ 不注入（这就是"刚切走、还在按旧账本注入"的串台窗口）。
  - **ⓒ 其余情况**（投影 == 出生值 / 投影读不到 / 没有该服务）⇒ 一律退回「日志 → 账本」。
    ★ 这条保守项**必须**在：DSH 一旦开跑就锁死预设本体，已开跑的会话只能靠账本跟随；
    若在这里用投影（= 出生值 standard）去推翻账本，等于把用户正在进行的角色扮演全掐死
    （这正是上一版犯的错，本版修正）。
- **新增 `armNativePresetWatcher(ctx)`**：订阅 DSH 的 `session/event`，一看到
  `agent-preset/selected` 就让账本跟着走 —— 换到酒馆预设记成 `{source:'top-select'}`；
  换走酒馆卡则记成 `{mode:'none'}`（硬空）。于是「用户切回出生值 standard」这一格
  由**事件**关闭，窗口从"一帧"缩到 0（不必等日志落盘，也不用拿投影去猜）。
  另外：与酒馆无关的会话切预设**不会**在账本里留下脏条目（只记酒馆关心过的会话）。

#### D. 会话列表把「活着但还没落盘」的空白新会话也列出来

`GET /api/tavern/sessions` 合并 `liveAgents` 登记表，标 `live/blank` 并排在**最前**
（否则 createdAt=0 会被降序挤到末尾、再被 `slice(0,20)` 切掉），
面板不再说「当前会话不在会话列表里（可能刚创建）」。

#### E. 查证：本版 DSH 的「预设」是**声明行**，旧目录不再被读取（酒馆预设目前不在顶部选择器里）

写完后顺手核了一遍 DSH 本体，发现一件比绑得更底层的事：

- `@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:71` 原文：
  「Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/`
  … **Nothing reads that directory any more.**」
  全 asar 的 `@deepseek-ai/` 代码里 `.agent-presets` **只剩这一处文档**（逐文件扫描确认）。
- 真正的预设是**声明行**：`- insert: [{ id: 'preset-<id>',
  name: '@deepseek-ai/dsh-agent-preset', config: { id, name, description, order, plugins } }]` ——
  出厂 `standard/ptc/minimal/cordis` 就是 `dsh-web-app/presets/*.patch.yml` 这么写的。
- 当前 profile（`~/.dsh/profiles/desktop`）里**没有任何 `preset-` 行**，profile 补丁层只有
  agent-default-model / ui-* / llm-pi-ai 等条目。

⇒ 结论：**酒馆现在那些 `.agent-presets/<id>/` 目录并不在 DSH 的顶部预设选择器里**，
所以「会话选择了这个酒馆 agent 预设」这件事此前根本无从发生；`agentPresets.select()` 对
`tavern-lite` 这类 id 会回 `agent-preset/not-found`（对 `standard` 这类真预设才会成功）。
这也正是「保存预设就是保存一个 agent 预设」这句话目前还不成立的原因。

为此本次**只加机制、不碰你的配置**：

- `renderPresetDeclaration()`：把酒馆预设目录渲染成 declaration row
  （`name/description/order` 取 `preset.yml`，`plugins` 取 `agent.cordis.yml` 原文）；
  **声明的 `config.id` 用目录名**（`agentPresetIdFor`），不用酒馆别名 ——
  既避开与 `agent-presets.default`（DSH 默认预设）同名词碰撞，又与「绑定时传的 id」
  「注入判据认的 id」三者统一；id 还要过 DSH 的格式校验（小写字母/数字/连字符），
  不合规直接拒绝渲染（不生成注定激活失败的行）。
- `composePresetDeclarationBlock()` / `mergeManagedPresetBlock()`：拼成带界标的**受管块**，
  有旧块整块替换、没有则追加，**块外一个字节都不动**（幂等、界标残缺时走追加不删）；
  `stripManagedPresetBlock()` 整块摘掉（回滚用）。
- `applyPresetDeclarations()`：**三层保护的写盘器** ——
  ① **默认 dry-run**（不传 `{dryRun:false, confirm:true}` 就只算不写）；
  ② 写前自检 `validatePresetPatchText()`（界标成对/无 tab/含插入条目）+ 备份到
  `<DSH_HOME>/tavern-data/backups/`；
  ③ 原子写（临时文件 + rename）+ 回读自检 + **块外内容必须不变**，不过就自动回滚。
- `GET/POST /api/tavern/preset-declarations`：GET 永远是 dry-run；POST 只有带
  `{apply:true, confirm:true}`（或 `{remove:true, confirm:true}` 摘块）才真的写。
- `mergeManagedPresetBlock()` 还处理了一个**会让人开不了机**的坑：profile 新建时
  `cordis.patch.yml` 里只有一行 `[]`，若把我们的条目**追加**在它后面，文件就成了
  「`[]` 之后再跟顶层节点」——不是顶层数组，DSH 直接拒绝启动
  （`dshmarket/src/patch.ts` 的注释里写着这个坑）。做法与它一致：把未注释的 `[]` 注释掉再追加。
- `isTavernPresetDir()` 放宽：注册表里有这个 id 也算酒馆预设（迁移到声明后旧目录会被删，
  注入判据不能因此失效）。

真实数据 dry-run 验证（只读）：`default` → 声明成 `preset-tavern-lite`；
`preset-fixture-a2` 原样；目标 `~/.dsh/profiles/desktop/cordis.patch.yml`
现有 1303 字节（含你手写的 providers/密钥）在合并后**原样保留在前**（合并后 10682 字节）。

- `nativePresetRoster()`：读 DSH **原生名册**（`agentPresets.list()`）——顶部选择器里到底有什么。
  `selectNativeAgentPreset()` 现在先对名册：目标不在名册里就直接回 `not-in-roster` 并把名册带回去
  （不再让人对着 `agent-preset/not-found` 猜）；**名册读不到时按「不知道」处理，绝不误判**。
  `GET /api/tavern/preset-declarations` 也带上 `roster` / `missingFromRoster`。
- **路线 B**（DSH 官方推荐的那条）：`renderPresetBundleFiles()` 生成 DSH bundle 的两份文件
  （`package.json` 带 `dsh.bundle.patch` + `cordis.patch.yml` 里是声明行），
  `writePresetBundle()` 落到 `<DSH_HOME>/tavern-data/preset-bundle/`（**只写酒馆自己的数据目录**），
  同样默认 dry-run、必须 confirm；`GET/POST /api/tavern/preset-bundle` 对应，
  并给出 `plugin_manager { action: 'install_bundle', target: … }` 的安装方式（安装要跑 pnpm，
  按 DSH 的规矩交给 plugin_manager，酒馆不代劳）。
- `GET /api/tavern/preset-declarations` 增加名册字段，dry-run 就能看出「哪些酒馆预设 DSH 还没声明」。

真实数据验证（只读）：两条路线都对 `default`→`preset-tavern-lite`、
`preset-fixture-a2` 渲染成功；路线 B 的 bundle 目录 `~/.dsh/tavern-data/preset-bundle/`
在 dry-run 阶段**不存在**（没写盘）；你的 profile 补丁层哈希全程未变。

⚠️ **仍未写入你的配置** —— 写盘入口已经就绪且默认 dry-run，但要不要按下这个键、
以及按哪条路（写 profile 补丁层 / 按 DSH 官方路子生成 bundle 走 `plugin_manager`），
得你说了算：目标文件写坏 = DSH 起不来，而且那里面有你的模型/provider 配置。

#### F. 声明开关与生命周期：面板上那个键由**你**按，预设增删改后名册自动跟

- 状态里新增 `presetDeclarations.mode`：`off`（**出厂**，一个字节都不碰用户配置）/
  `patch`（维护 profile 补丁层里的受管块）/ `bundle`（生成 DSH bundle 交 plugin_manager）。
  只认这三个值，非法值归 `off`。
- `syncDeclarationsBestEffort()`：`createPreset` / `renamePreset` / `deletePreset` 之后按当前模式
  尽力同步（未启用时是 no-op，失败只记日志，绝不影响预设操作本身）。
  **删除这条尤其重要**：受管块是从注册表整块重渲染的，删掉预设后那一行会跟着消失 ——
  否则 DSH 名册里会留一张指向已删目录的坏卡。
- 写入类路由会**把开关跟着结果走**：写成功 → 进入对应模式；撤下成功 → 回到 `off`。
- 面板新增一行状态 + 三个按钮（📢 声明为 DSH 预设 / 📦 只生成 bundle / 🧹 撤下声明）：
  「声明」按钮**先 dry-run 拿预览 → `window.confirm` 讲清目标文件与字节数 → 才 POST 写盘**；
  「撤下」同样要 confirm。状态行会显示「名册 N 个、还缺酒馆预设 X 个」——
  缺哪些直接列出来。（这条路你自己按，我不替你写配置。）

#### G. 面板显示「本会话生效的预设」不再只看酒馆账本

- `GET /api/tavern/sessions` 对**活会话**增算原生权威：`authoritativePresetId` /
  `authoritativeSource`（只算活的：全量 20 条都读事件流太贵；活会话通常一两个）。
- 面板 `authoritativeFields()` 用它覆盖账本字段：`native` / `explicit` 折算成「顶部选择」，
  `default` 折算成「未绑定」。**修的是编造状态**：用户在天花板顶部给会话选的卡不在酒馆账本里，
  改之前面板会显示「未绑定」，而那个会话其实正按酒馆预设注入。

#### H. 「已开跑」判定与 DSH 对齐 + bundle 同步提醒装机

- `nativeTurnStarted()`：会话是否已经开跑，**优先用 DSH 自己的判据**
  （`turnBoundary` 投影的 `openTurnStartSeq !== null || lastTurn > 0`，见 dsh-agent-loop
  的投影定义），投影读不到才退回「日志里找 turn/start、user/message」的启发式。
  为什么改：日志被裁剪、会话是 resume/import 进来的时候，日志启发式会漏判，
  面板就会把「其实已经锁死」的会话说成「可以绑定」—— 提示错了同样是编造状态。
- `syncDeclarationsBestEffort()` 在 **bundle 模式**下同步完会带回 `needsInstall: true`：
  文件更新 **≠** DSH 名册更新，还要重新 `install_bundle`。不提醒的话用户会以为名册已经变了。

#### I. 面板：两套预设 id 空间对齐（修掉「静默切错编辑目标」与「假告警」）

服务端 `/api/tavern/presets` 的每一条**同时带着两套 id**：`id` = DSH 目录名（如 `tavern-lite`）、
`presetId` = 酒馆注册表 id（如 `default`）。而会话权威给的是目录名、账本里记的可能是注册表 id。
只按一种 id 匹配就会出两类问题：

- **预设标签处（严重）**：`loadSessionPresets` 找不到就**静默把编辑目标换成"第一个预设"** ——
  用户以为在编辑会话那张卡，保存却落到另一张卡上（**数据级串台**，改世界书改错人）。
- **绑定卡处**：显示「该预设已不存在，绑定会 fail-closed」——**假告警**，预设好好的。

改法：新增 `matchPresetInList(list, id)`，按 `id` / `presetId` / `dir`（含 basename）三选一匹配；
`findPreset` 委托给它；标签处命中后把 `activeId` **统一成列表条目的 id（目录名）**，
只有真的找不到才回退第一个。

> ⚠ 这个 helper 特意放在 `// ── P0-3b` 与 `// ── P0-3 结束 ──` 之间：
> `tests/binding-panel-ui.test.js` 是**按源码段抽取**在 vm 里跑的，定义放段外，
> 测试沙箱里就没有它（函数声明提升，段外调用点照样能用）。

#### J. 拆开 `default` 的哨兵/别名双重身份（修「绑了酒馆默认却没有卡」）

`DEFAULT_PRESET_ID`（`'default'`）在本插件里**身兼两职**：既是酒馆注册表里「酒馆默认」
这个预设的 id（→ 目录 `tavern-lite`），又是「本会话不注入」的哨兵值
（`pickAuthoritativePresetFromLog` 的返回、`isTavernSession` 与 `tavern:card` 的
`!== DEFAULT_PRESET_ID` 判断、面板把 `default` 展平成"未绑定"）。

后果：**绑了「酒馆默认」的会话会被当成"没绑"** —— 角色卡不注入，破限段 / 事实修正段
也不注入，用户明明绑了卡却什么都没有。

改法（把两件事分开，别名只出现在通信层）：
- 写入口 `POST /api/tavern/bind-preset` 落盘时用 `agentPresetIdFor()` 换成**目录名**
  （`default` → `tavern-lite`），响应里的 `presetId` 仍然是酒馆 id（前端不用改）；
- `armNativePresetWatcher` 本来就记的是 DSH 原生值（目录名）✓；
- `resolveAuthoritativePreset` 再兜住**存量**的 `'default'` 绑定：按「酒馆默认预设」解析
  （映射成 `tavern-lite`），而不是当成"没有预设"。

于是 `'default'` 只剩一个含义：**没有任何酒馆预设被选中**（哨兵），语义终于单一。

#### K. 收尾两处：写入口统一 id 空间 + 声明体积的诚实提示

- `setSessionPreset()`（`POST /api/tavern/bind`，旧的绑定入口）也改用 `agentPresetIdFor()`
  落盘：账本里一律是 **DSH 侧 id（目录名）**，不再混入酒馆别名。
  （面板的绑定流量早就走 `bind-preset` 了，这条只是把「唯一写入口」的原则补齐。）
- `applyPresetDeclarations()` 新增 `warning`：合并后超过 256 KB 时明确提示
  **声明会把每个预设的整个组合（含角色卡正文）内联进 DSH 配置，而 DSH 每次启动都要解析它**，
  并建议改用「只生成 bundle」那条路。用户在按下写入**之前**就能看到代价，而不是启动后才发现。

#### L. 真 Cordis 宿主测试（第一次「跑起来」验证：挂载 + **真注入**）

新增 `tests/cordis-mount.test.js`：**从 DSH 的 `app.asar` 里就地读出真实的
`@deepseek-ai/cordis`（只读）**，在临时 `DSH_HOME` 里用假服务起一个**真 cordis 宿主**，
把插件挂上去，然后调用它注册的**真路由**与**真 system prompt 段**。它证实了三处
此前只靠源码推导的假设：

1. `inject: ['webServer','systemPrompt','sessions']` 被满足后 apply() 真的跑完
   —— 实测注册了 34 条路由 + 4 个 prompt 段（`tavern:card` / `tavern:nsfw` / `tavern:edits` / `tavern:enhance`）；
2. **插件自己的 fiber 能用 `ctx.get()` 解析出宿主服务** —— `/api/tavern/preset-declarations`
   返回 `roster: ["standard","tavern-lite"]`，说明 `agentPresets.list()` 真的被调到了；
3. **注入真的按会话走**（这是本目标的第二条，此前只有单测）：
   给两条会话分别设成酒馆预设 / `standard`，调 `tavern:card` 段 ——
   前者返回的提示词**含预设卡正文的哨兵串**，后者返回**空字符串**；
   `tavern:nsfw` 段（另一套判据 `isTavernSession`）同样如此。**会话隔离在真宿主里成立。**
4. **跨作用域的事件投递**（此前列为「未验证」的最后一条运行时假设）：
   从一个**子作用域** `emit('session/event', …)`（DSH 就是这样：会话在自己的 fiber 里
   append 后广播；`dispatch()` 按 `hook.global || filter(...)` 收集监听者），
   我们的 watcher（`{ global: true }`）**确实收到了**，并立刻把账本改成
   `{ presetId: 'tavern-lite', source: 'top-select' }` / `{ mode: 'none' }`
   ⇒ 「用户切走预设但账本还旧」的串台窗口在真宿主里关闭。

> 顺手修掉了实验脚本里的一个真 bug：**asar 数据区起点要对齐 4 字节**
> （`16 + jsonLen + padding`）。漏掉 padding 时每个文件都会多出「上一个文件的尾巴」
> 1–3 字节 —— 表现为 `package.json` 解析失败、JS 文件开头多一个 `;`、UTF-8 首字节被截断。
> 之前几轮读源码时看到的那点"开头怪字符"就是它。

环境拿不到 asar/cordis 时该文件**明确 skip**（不让它变成假红灯）；也可用
`DSH_CORDIS_DIR` / `DSH_ASAR` 指定路径。

#### M. 面板声明开关的**行为级**测试（顺带修掉一处「成功提示被覆盖」）

`tests/binding-panel-ui.test.js` 的 VM 试验台原来没给声明开关的四个元素和 `window.confirm`，
所以那几个按钮在沙箱里是"哑"的（只有静态断言）。现在补齐后，按下去会发生什么被真正钉住：

- 📢 声明：**先 GET dry-run 预览 → `window.confirm`（文案含目标文件、前后字节数、会备份）→ 才 POST
  `{apply:true, confirm:true}`**；并断言**顺序**（预览下标 < 写入下标），外加一条对照臂
  （删掉预览步骤后该顺序断言必须失败）；
- 用户在确认框里**取消** ⇒ 一个写请求都不许发（不许先写后问）；
- 🧹 撤下声明必须确认，且带 `remove+confirm`；取消同样不发请求；
- 📦 只生成 bundle 打到 `/api/tavern/preset-bundle`，并把 `install_bundle` 命令显示出来。

> ★ 写这组测试时立刻抓到一个**真 UX bug**：成功后 hint 行写下「✅ 已写入（…，备份：<路径>）」
> 紧接着被 `loadDeclareStatus()` 的状态刷新**覆盖**成「还没被 DSH 声明：…」——
> 用户就此**拿不到回滚要用的备份路径**。修法：状态刷新只写状态行（名册缺失信息本来就在那），
> **绝不碰 hint 行**（hint 只放"刚做完一件事"的结果：备份路径 / 安装命令 / 错误）。

#### N. 修复 `加载预设失败` 的真因：预设查找 helper 被放进了嵌套作用域

装机后「🎭 当前 Agent 预设」那张卡报 **`❌ 加载预设失败，请刷新页面`**，下拉框一直停在"加载中…"。
排查结论（**服务端是清白的**：`/api/tavern/presets`、`/api/tavern/agent-presets` 都返回 200、数据正常）：

- **根因**：`matchPresetInList` 被声明在**绑定卡的嵌套作用域里**（缩进 8，与 `curSid`/`setStatus` 同层），
  而调用它的 `loadSessionPresets` 在**面板工厂顶层**（缩进 6）。函数声明的提升**只在同一个函数内**生效，
  于是运行时抛 `ReferenceError: matchPresetInList is not defined`；该链末尾又有 `.catch`，
  错误被吞掉后只剩一条红字 —— 与用户看到的现象完全一致。
- 这个错误**只有真浏览器里才会出现**：UI 回归测试是按源码段（`// ── P0-3b` … `// ── P0-3 结束`）
  在 vm 里跑的，而 `loadSessionPresets` 不在那一段里 —— **外层调用点从来没被执行过**。
- **修法**：把 `matchPresetInList` 挪到面板工厂顶层（与 `getActivePresetId` 同层），`findPreset` 改为调它；
  UI 测试沙箱改为**注入从 bundle 里抠出来的真实现**（不再依赖"它恰好在切片里"）。
- **新增 3 条回归**（`tests/binding-panel-ui.test.js` 现 31 例）：
  1. **结构回归**：`matchPresetInList` 的声明缩进必须与 `loadSessionPresets` 相同（嵌套即失败）；
  2. **真执行回归**：抠出 `loadSessionPresets` 真源码、注入真 helper、喂真响应，断言状态行渲染出预设名
     且 `dataset.presetId` 命中目录名（顺带钉住"编辑目标被静默改写"那条）；
  3. **对照臂**：不注入 helper（等价于它在别的作用域）⇒ 必须复现那条 `加载预设失败` 红字。

> 教训：**"函数声明会提升，所以放哪都行"只对同一函数作用域成立。**
> 用"按源码段抽取"的测试去验证"跨段调用"是无效验证 —— 测试的范围决定了它能证明什么。

#### P. 功能体检 + 按用户要求删功能 / 清死代码（客户端 -37 KB）

用户要求"排查哪些功能有用哪些没用" → 产出 `AUDIT-功能体检.md`（三方交叉比对：面板控件 ↔
客户端引用 ↔ 服务端路由，再逐条追到"是否真的进入注入"）。**最大的发现**：「🔗 角色关系网」的
数据**从不进入提示词**（`readSessionRelations` 只在 merge 与 GET 路由里被调用，注入区一次都没出现）。

按用户指示执行：

1. **删除「✨ 通用增强层·运行时注入」整层** —— 卡片、开关处理、`state.enhanceRuntime` 写入、
   服务端 `tavern:enhance` 段、两处响应字段全清。理由：用户要用 **ST 预设**替代它
   （原话"我希望可以让 st 的预设来代替这个通用增强"）。底层 `buildEnhanceRuntimeBlock` /
   `enhanceRuntimeEnabled`（utils，有单测）与 `/api/tavern/preset/enhance`（含自动备份）**保留**，
   但不再有任何自动注入。注入段：4 → **3**（`tavern:card` / `tavern:nsfw` / `tavern:edits`）。
2. **删除「✨ 套用通用增强模块包」界面入口**（按钮 + 覆盖勾选），API 保留可脚本调用。
3. **删除「🤖 Agent 预设管理」整段死代码（114 行）** —— markup 早已注释、JS 的 4 个入口目标元素
   都不存在；删除前验证 `agentPresets` / `agentGroupCollapsed` 等在段外零引用。
4. **清掉旧版「生效范围」遗留**（块注释 84 行 + 惰性回填 59 行）、`renderWorldbooks`
   （39 行 + 4 个调用点）、旧 `tavern-inject-status` 指示等。
   **客户端 500,123 → 463,166 字节（-37 KB ≈ 370 行）**。
5. **修 ✍️ 写作辅助「保存违禁词」的反馈串卡**：原先写 `#tavern-api-status`（那元素在
   「记忆与总结」卡片里）→ 在「增强」页签点保存看不到反馈；现在写本卡片自己的
   `#tavern-writing-status`，并补失败分支。

**清理中的一次自伤（已修 + 加防）**：删旧「生效范围回填」时区间**多删了 3 行活代码** ——
那条 `return fetch('/api/tavern/state')…` 是回填 `activePresetIdx` 的（面板重开不回落到第 0 组），
恰好夹在惰性代码中间。`node --check` 报 `SyntaxError` → 定位补回，并新增
`preset-idx.test.js [5]`「回填链必须在」把这类误删钉死。

**文档更正**：`AUDIT-功能体检.md` 第一版把 `tavern-allow-add-btn` 那几处判为"无守卫、潜在
TypeError"—— 复查发现整段在 `/* */` 块注释里（扫描只跳过 `//` 行），**不存在该风险**；已更正。

#### O. 面板布局：二十来张卡片收进 4 个页签（简洁，但不许丢功能）

面板原来把 20+ 张卡片一次铺开，重点（会话绑定 / 当前预设）直接被淹掉。现在按用途分成 4 个页签：

| 页签 | 收纳的卡片 |
|---|---|
| 🎭 会话 | 当前 Agent 预设 / 当前会话绑定 / 生效范围 |
| 📚 内容 | 角色卡 / 世界书 / 开场白 / 预设 /（额外设定 输入框） |
| 🎲 玩法 | NSFW / 剧情选项 / 全局正则 / 通用增强层 / AI 工具 / 联网搜索 / 反AI八股 |
| ⚙️ 增强 | 高级功能（故事背景 / 记忆与总结 / 写作辅助 / 关系网 / 回复体检） |

**做法**：只做「搬家」，**没有改一行 markup**，所有 id、事件绑定、既有测试锚点原样不动 ——
面板渲染完之后用一个安装器把卡片按标题移进对应页签。

三条安全设计（这是"功能不会缺失"的关键）：

1. **认不出来的元素一律留在页签之外**。所以底部「当前将保存的 agent.cordis.yml / 💾 保存预设 /
   ✅ 保存并关闭 / 状态行」在任何页签下都常驻可见；以后新加卡片忘了登记，结果只是"没被收纳"，
   **绝不会"消失"**（宁可多显示，不可丢功能）。
2. **幂等**：重复挂载只会重建一套页签（`#tavern-tabbar` 已存在就直接返回）。
3. **记住上次页签**（`localStorage['tavern.panel.tab']`），非法值回落「会话」，不会白屏。

**新增测试** `tests/panel-tabs.test.js`（8 例）：前 4 例静态结构断言
（顶层 12 张卡片一张不漏都有页签规则 / 页签定义完整 / footer 文案与控件不被任何规则认领 /
散件规则指向的 id 在真 markup 里确实存在）；后 4 例带一个**迷你 DOM** 真跑安装器
（卡片全进页签且页签正确、footer 留在页签外、点按钮切换并落 localStorage、恢复上次页签、
非法值回落、幂等）。改分组只需动 bundle 里的 `TAB_DEFS` 表。

#### Q. 关系网软注入 + 通用增强与 NSFW 连根删除（按用户指示）

用户指示：*"关系网先做软注入吧，提醒模型有这个东西，但是不影响剧情，把通用的那个删掉，nfsw也删掉"*。

**① 关系网「软注入」（新增）**

- 体检结论是关系网数据**从不进提示词**（`readSessionRelations` 只被 merge 与 GET 路由调用）。
  现在新增 `buildRelationsHintText(sessionId, state)`：有数据时在 `tavern:card` 段尾追加**一行**：
  `【关系网】本会话记录了 N 个角色、M 条关系（仅作为背景资料存在，不要在正文里主动提及、
  罗列或据此改变剧情走向；用户明确问到时才可以参照）。`
- **只给存在性，不给内容**（人名、关系标签一律不进提示词）—— 这是"不影响剧情"的实现方式，
  也让 token 代价可以忽略。
- 开关：`state.relationsHint`（默认**开**）。面板「🔗 角色关系网」卡片里加了复选框
  （`#tavern-relations-hint`，改动即写 `/api/tavern/state`）；关掉则一行都不注入。
- 测试（`core.test.js` 新增 3 例）：有数据时**必须**不含人名/关系内容且要求"别主动展开"；
  无数据/开关关/无会话 id 时返回空串；**集成断言**：真的拼进 `tavern:card` 段（防止"写了函数没人调"）。

**② 「通用增强」连根删除**（上一轮只删了界面，这轮删底层）

- `lib/utils.js`：`ENHANCE_PACK_FILE` / `ENHANCE_CONTRACT_TAGS` / `isEnhanceProtectedName` /
  `normalizeEnhancePack` / `mergeEnhanceModules` / `enhanceRuntimeEnabled` /
  `buildEnhanceRuntimeBlock` **全部删除**（utils.js 239 → 105 行）。
- `lib/index.js`：utils 的 import、`readEnhancePack` / `enhanceBackupStamp` / `applyEnhancePack`、
  `/api/tavern/preset/enhance` 路由、`_test` 里的 10 个导出项，全删。
- 删除 `lib/preset-enhance-pack.json`（13 KB 模块包）与 `tests/preset-enhance.test.js`（23 例）。
- 理由：用户要用 **ST 预设**替代它 —— 预设是数据，用户写得比插件猜得准。

**③ NSFW 破限段连根删除**

- `lib/index.js`：整个 `tavern:nsfw` 段（96 行，"成人模式/内容策略暂停"那一大段）、
  `state.nsfwEnabled` 的写入与两处响应字段、`sectionSizes.nsfw`、内嵌调试页的 NSFW 开关与回读。
- `lib/client.manager.bundle.js`：🔞 NSFW 卡片、`state.nsfw`、状态同步与开关处理器、
  体积统计里的"破限"项、页签规则里的 NSFW 条目。
- **⚠ 关键搬迁**：体积快照 `flushPromptStats()` 原先由 `tavern:nsfw`（order 最大 = 最晚组装）
  负责落盘。删除后最晚组装的是 `tavern:edits`（order=0），落盘已搬过去（**4 条 return 路径全都要落盘**，
  否则面板的体积统计会停在上一轮）。这一点写了测试守着（`core.test.js`）。
- **注入段：3 → 2**（只剩 `tavern:card` / `tavern:edits`）。
- 理由同 ②：破限交给 ST 预设（用户的预设里本来就有一大套）。

#### 本轮的一次自伤（已修复，如实记录）

清理"通用增强"底层时，我先写了个按**单句锚点**定位的区间脚本；该锚点同时出现在我刚加的
"已删除"说明注释里，于是脚本**从第 14 行删到 2184 行（2171 行）**，把服务端半个文件删掉了。
`node --check` 竟然还通过（删除边界恰好落在顶层声明边界上），是我从脚本自己打印的
"行 14-2184"看出区间荒谬才发现。

**恢复方式**：装机版 `~/.dsh/profiles/desktop/node_modules/dsh-tavern/lib/index.js`
是上一轮同步留下的**完整**副本 → 覆盖回来（6655 行，关键函数逐个核对存在）。
本轮的服务端改动随后用**带断言的脚本**重做：每一步先断言"区间内必须含 X、不得含 Y、长度在范围内"，
不符就整体中止不写盘（这套断言后来真的又拦下了 3 次：`_test` 导出数是 0、响应字段数是 4 不是 3、
统计文案因 CRLF/空格匹配失败）。

**教训**：① 区间删除的锚点必须**唯一**（我用了会重复的句子）；② 中文/CRLF 文件里的正则要带 `\r?`；
③ 改完立刻用"关键函数存在性 + 全量测试"双重验证，而不是只看 `--check`。

**④ 收尾：清掉残留的可见「NSFW」字样**（用户反馈"增强里高级设置的简介还是有 nfsw 字样"）

- 「⚙️ 高级功能」卡片简介：`记忆 / 关系网 / 故事背景 / NSFW` → **`记忆 / 关系网 / 故事背景 / 写作辅助 / 回复体检`**（如实列出里面现在有的东西）。
- 内嵌调试页：卡片标题 `🔞 注入开关` → `🔧 注入开关`，删掉 HTML 注释里的 NSFW 字样，体积统计行 `· 破限 N 字符` 一并去掉。
- 客户端两处**已经说错**的注释（"NSFW 开关已移到…"）改成现状描述。
- **防回归测试**（`panel-tabs.test.js ④b`）：扫面板 markup 的**可见文案**（跳过注释），出现 `NSFW` / `nsfw` / `🔞` 即失败；并断言高级功能简介必须列出「记忆 / 关系网 / 故事背景」。
- 唯一保留的 `NSFW` 在 `breakLimitKeywords` —— 那是**功能用的关键词表**（识别"这个预设模块是破限包"以便排到前面），不是界面文案；删掉会改变排序行为。

#### R. 新功能：保存预设时自动生成 skill + 选中预设自动绑定 + 手动选择 skill

用户要求：*"导入角色卡世界书点击保存，生成 agent 预设的同时生成一个 skill；选择这个 agent 预设就自动
绑定相关的 skill；再加一个手动选择 skill 的选项"*。

**机制依据（读 DSH 源码 + 真 cordis 实测得到的硬约束）**

- skill 由 `dsh-skill` 注册表统一管理，来源是**提供方**；`dsh-skill-filesystem` 扫描这些根（rank）：
  `<项目>/.dsh/skills`(100) → `<项目>/.agents/skills`(200) → 自定义(300) → **`<DSH_HOME>/skills`(400)** →
  `<agentsHome>/skills`(500) → 随包目录(600)，并且**监视**它们（Chokidar）⇒ 新增/改名/删除**免重启**生效。
- skill 形态：`<name>/SKILL.md`（或扁平 `<name>.md`）；frontmatter **必填** `name` 与 `description`，
  可选 `whenToUse`；`name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`dsh-skill` 的 `SKILL_NAME`），
  **不合规会被整条丢弃**。

**实现（三件事分开做，互不耦合）**

1. **生成**：`buildSkillMarkdown(presetId, {includeFull})` 把预设渲染成一份**设定索引**：
   何时用它 / 角色卡清单 / 世界书与启用条目名 / 预设模块清单；`includeFull=true` 时把启用中的
   世界书条目正文附在末尾（上限 60 KB）。frontmatter 用**单行引号标量**（转义 `\` `"`、压掉换行）。
   保存路由 `/api/tavern/save` 成功后调用 `syncPresetSkillAfterSave()` —— **best-effort，失败不影响保存**。
2. **自动绑定**：`buildSkillsHintText(sessionId, presetId, state)` 在该会话装配 `tavern:card` 时追加**一行指针**：
   `【可用 skill】本会话绑定了 skill：… 。需要确认本预设的角色/世界书设定细节时，用 skill 工具加载它…`
   刻意**不把 skill 正文塞进提示词**（否则设定注入两遍：烧 token 且与卡/世界书打架）。
3. **手动选择**：面板新增「🎓 技能（Skill）」卡片（📚 内容 页签）：生成/更新、删除、刷新清单、
   磁盘上所有可用 skill 的勾选列表 + 保存绑定；三个开关（保存时自动生成 / 附录世界书全文 / 会话提示）。

**绑定关系的存法**：`presets.json` 每条预设加 `skills: ["tavern-xxx", "手选的别的skill"]`；
删预设时顺带 `deletePresetSkill()` 清掉生成的目录（否则 `~/.dsh/skills` 会堆孤儿 skill —— 而它们是
会被模型整轮看到的）。

**路由**：`GET /api/tavern/skills?presetId=…`（绑定 + 可用清单 + 真实写入目录 + 三个开关状态）、
`POST /api/tavern/skills/generate`、`POST /api/tavern/skills/bind`、`POST /api/tavern/skills/delete`。

**预览时抓到并修掉的两个真 bug**（测试夹具没覆盖，但**正好是你默认预设的形态**）：

1. **两套 id 空间**：面板传的是**目录名**（`tavern-lite`），而注册表条目的 id 是别名（`default`）。
   原先只按 `id` 查 ⇒ ① skill 描述退化成 id（`《tavern-lite》`）；② `setPresetSkillNames` 直接
   `preset-not-found`，**手动绑定在默认预设上会失败**。修法：新增 `findPresetMetaEntry()`，
   id / dir / `default`↔`tavern-lite` 三种都认（读写两侧都用它）。
2. **名字前缀重复**：`tavern-lite` → `tavern-tavern-lite`。修法：目录名本身以 `tavern-` 开头时不再叠前缀。

**验证**：`tests/skill-gen.test.js`（14 例）覆盖名字合规、frontmatter 合法、索引 vs 全文、
写盘位置与幂等、删除幂等、磁盘清单（目录式/扁平式/去重）、绑定读写与非法名过滤、开关生效、
会话提示只给指针不给正文、以及**真 apply + 真路由**的端到端（列表→生成→绑定→删除）。
另外用**从 `app.asar` 整包解出的 DSH 自带 `yaml` 解析器**校验了生成的 SKILL.md：
三份真实预设（`tavern-lite` / `preset-fixture-a2` / `preset-fixture-a4`）的 frontmatter
都能被正确读出，`name` 全部合规、`description` 非空且无裸换行。

> 未做（留作后续）：用 `ctx.skills.register(...)` 在**会话作用域**注册 runtime skill
> （那才是"只有这个会话看得见"的强隔离）；当前方案是"全局文件 + 会话级指针"，物理隔离在提示词层。

#### S. 新功能：设定注入量「会话级」切换（全量注入 ⇄ 跟随规则）

用户要求原文：*"做一个切换吧，全量注入和规则注入，因为我需要做一些 nfsw 的内容，不确定模型会不会写"*。

**现状澄清**：这个开关**早就有了**，但是在「🎯 生效范围」里的**全局** `<select>`（`跟随卡设定 / 全量注入`），
`state.wbInject === 'full'` 的实现是"**所有会话**都强制全量"。**缺的是"就这一场"的粒度** ——
用户要的正是"这一段剧情确保设定全进去，别的时候省 token"。

**判定链（唯一权威，注入点与体积统计共用同一函数）**

```
会话级覆盖 state.wbInjectBySession[sessionId]   ← 新增，优先级最高
   'full'   → 强制全量（哪怕卡是 keyword、全局是 follow）
   'follow' → 老实跟随卡设定（哪怕全局开了 full —— 省 token 的后悔药）
   （无）    ↓
全局 state.wbInject === 'full' → 全量
   ↓
世界书自己的 injectMode（groups 展平保留顶层模式）
```

`resolveWbIsFull(state, wb, sessionId)` 加了**可选**第三参：老调用点不传就退回原行为（兼容不破坏）。

**接口与界面**

- `POST /api/tavern/wb-inject-session { sessionId, mode: 'full'|'follow'|'' }`（`''` = 清除覆盖）；
  响应回报 `override` / `effective` / `globalWbInject` / `cardInjectMode`（如实说明"卡设定本来是什么"）。
- `/api/tavern/bind`（GET）与 `/api/tavern/sessions` 现在都带 `wbOverride` / `wbEffective` / `wbInjectGlobal`
  —— **面板一律用后端的判定结果，不自己算**（算错等于骗用户"设定已经全进去了"）。
- 面板「🔗 当前会话绑定」卡片新增一行：`🪶 跟随规则（省 token）` / `💯 全量注入（确保看到设定）`
  + 状态行说明"当前是哪种、为什么"（本会话指定 / 全局开关 / 跟随卡设定）。

**顺带修掉一个真问题**：旧**数组格式**的世界书文件里显式写的 `injectMode` 会被迁移**丢掉**，
静默变成全量注入（手工编辑过、或早期版本写的文件会中招）。新增 `legacyInjectMode()`：
各本书**显式且一致**才采用，分歧或没声明都保守用 `full`（多注入 > 漏设定；ST 导入的书没有这个字段，
行为完全不变）。

**测试**：新增 `tests/wb-inject-mode.test.js`（11 例）：判定链 6 种组合（含"覆盖不外溢到别的会话"、
"不给 sessionId 不炸"）、切换**真的改变注入条目**（规则模式只给命中的，全量给全部启用项，
禁用项在任何模式下都不进）、真路由端到端（切换 → 回报 → 清除）、全局 full 被会话 follow 压过、
缺 sessionId 不乱写、以及 legacy 迁移保留 keyword 的回归。

#### 事故记录（第二次同类）

用 PowerShell `Get-Content -Raw | Set-Content -Encoding utf8` 想批量替换 `loadBound`→`loadBinding` 时，
**PowerShell 按 GBK 读取再以 UTF-8 写回**，把整个客户端文件的中文写成 `鈥?` 乱码（`--check` 立刻报错）。
处理：**用完好的装机版覆盖回滚**，然后**只用 edit 工具**重新应用四处改动 + 逐一 `--check` + 全量测试。
教训重申：**永远不要用 shell 文本命令改这些源码**（第一章 Q 节已记过一次，这次是复发）。

#### T. 修正 skill 的定位：正文是**指令**，不是"设定索引"（新增「写作指令」形态，默认）

用户纠正：*"不是提示词，是 skill，skill 会让模型输出"* —— **用户是对的，我上一版定位错了**。

**机制依据（DSH 源码原文）**

- `dsh-tool-skill/lib/index.js:187`：注入的 skill 内容 `form: "instructions"`；
- `:192`：`/技能名` 走的 pre-step 注入用的是同一个 `renderSkillContent`；
- `:244/251`：目录里对模型说的是 *"A skill is a reusable set of **task-specific instructions**…
  A user may also invoke a skill directly; its `<skill_content>` block then appears in this conversation.
  **Follow it**"*；
- `dsh-client-ui-skill/README.zh.md:85`：`/名称` 触发时，宿主把 `<skill_content>` 作为
  **指令上下文追加在该步骤各项注入的末尾**（最贴近模型的回答），且"加载是确定性的：模型无需被要求
  调用 skill 工具就能收到完整正文"。

⇒ 所以 **skill ≠ 背景设定**：它是**要照做的指令**，而且落在**离回答最近的位置**。同一段文字埋在
system prompt 顶部、和作为 skill 注入到末尾，模型照做的概率差别很大 —— 这才是用户要的东西。

**改法**

1. **新增形态**：`buildSkillMarkdown(presetId, { style })`，默认 `'instructions'`：
   - 正文 = **预设里启用中的写作要求**（模块**内层**逐条原文，按包分组）+ 卡正文（"照此扮演"）；
   - 刻意**不写**"以 system prompt 的卡/世界书为准"这类自我否定的话 —— 那会让模型不去照做；
   - `description` / `whenToUse` 也跟着变成"写作指令 / 要按本预设写正文时"。
   - `'index'` 形态保留（只列角色/世界书清单，省 token），两种形态都支持 `includeFull`（附世界书全文）。
2. **模块是两层结构**：`presets.json` = `[{name, modules:[{name, content, enabled}]}]`。
   之前只取了外层包名 ⇒ skill 里**一条写作要求都没有**。现在按内层扁平化，并且
   **排除 `enabled:false`**（那是"选一"里的落选项，比如 nsfw 风格的其它档 —— 一起写进去会让指令互相矛盾）。
3. **状态/接口/界面**：`state.skillStyle`（默认 instructions）；`/api/tavern/skills` 回报 `style`；
   `/api/tavern/skills/generate` 接受 `style`（非法值回落默认）；面板卡片新增「技能形态」下拉，
   **切换后立刻重新生成**（否则磁盘上还是旧形态，用户会以为没生效）。

**实例（用户真实预设 `tavern-lite`）**：63 条内层里启用 28 条 → 指令形态 23,491 字节
（含 `❤️nsfw风格|更舒缓` 157 字、`❤️ASMR对话` 116 字、`📏字数要求`、`📝文风（选一）丨s喵特调一` 1401 字…），
索引形态 1,901 字节。未启用的（`❤️nsfw风格|正常`、`⚙️我不是主角` 等）一条都没进去。

**测试**：`skill-gen.test.js` 增至 20 例，新增：指令形态含启用条目原文 / 排除未启用 / 排除 0 字标记模块 /
不许出现自我否定句、两种形态的 frontmatter 各自贴合、真路由切换形态后文件形状跟着变、非法形态回落。
**另**：给面板加那行下拉时我多写了一个 `</div>`，`panel-tabs` 测试立刻抓到
「⚙️ 高级功能」卡片被算成"嵌套卡片"而消失（顶层卡片数 11→10）—— 又一次证明这套界面结构测试有用。

#### 测试

18 个文件、403 例全绿（新增 wb-inject-mode 11 例、skill-gen 20 例；删掉 preset-enhance 的 23 例）：
- `tests/native-preset-binding.test.js`（19）：id 换算、部署默认预设读取、服务缺失/locked/
  not-found/invalid/无活 Agent 的如实折叠、原生投影读取、决议链的原生回退、空白判定；
- `tests/client-main-view-session.test.js`（8）：**对打包产物里的函数源码求值**，
  钉住「空白新会话能取到 id」「mainView 缺失返回空串（不拿上一个会话顶替）」等；
- `tests/native-bind-route.test.js`（9）：真 `apply()` + 真路由 + 假 DSH 服务，
  端到端跑「空白会话绑定成功 / 已开跑 locked / 解绑交还默认 / 会话隔离 / 活会话入列表」；
- `tests/preset-declaration.test.js`（25）：声明行渲染（转义、缩进、多条目、**目录名 id**、
  非法 id 拒绝、坏预设不连坐）、受管块拼接（追加不动用户内容、整块替换且幂等、界标残缺不猜、
  **空数组占位符 `[]` 被注释而非追加**）、写盘三层保护（默认 dry-run 不写 / 缺 confirm 拒绝 /
  apply 成功且备份 + 幂等 / remove 回滚 / 自检拦住缺界标与 tab）、以及路线 B 的 bundle
  （package.json 指向 cordis.patch.yml、坏预设不连坐、dry-run 不建目录、confirm 后内容与渲染一致）。
- `tests/native-preset-binding.test.js`（30）：名册读取（两种形状/服务缺失/抛错）、
  名册预检（`not-in-roster` 且不去调注定失败的 select）、名册读不到时不误判，
  **决议权威五连**：投影是酒馆预设 ⇒ 注入它；投影是 standard 且账本有酒馆绑定
  ⇒ 退回账本（旧版兼容）；**已开跑会话（投影 == 出生值）⇒ 账本仍生效**；
  投影 ≠ 出生值 ⇒ 立刻以投影为准；以及 **watcher 三连**：换成酒馆预设记 top-select、
  把酒馆卡切走清成硬空（随后决议立刻变成不注入）、与酒馆无关的会话不留脏条目。
- `tests/native-preset-binding.test.js`（31）：另有 **「已开跑」判定与 DSH 对齐** ——
  投影说已开跑就以投影为准（日志裁剪/resume 进来也不漏判），投影不可用才退回日志启发式。
- `tests/client-main-view-session.test.js`（15）：除会话 id 解析外，还钉住面板声明开关 ——
  四个元素齐全、声明按钮**先预览再确认后写**（顺序断言）、撤下必须 confirm、
  bundle 按钮给出 `install_hint`、**显示层优先用原生权威**，以及
  **`matchPresetInList` 三种 id 写法都命中**（含「标签处必须用它 + 命中后统一 id 空间」的顺序断言）。
- `tests/preset-declaration.test.js`（30）：另含 **bundle 模式同步带回 `needsInstall`**
  （patch 模式没有这一步）与 **大配置的体积提示**（超阈值才提示，小配置不许"狼来了"）。

- `tests/native-bind-route.test.js`（11）：另有 **「绑酒馆默认 ⇒ 落盘成目录名 tavern-lite」**
  ——存别名会被当成"没绑"（卡不注入），所以这条同时断言「响应仍用酒馆 id」与
  「决议认得出它」。
- `tests/cordis-mount.test.js`（4）：**真 cordis 宿主** —— 插件 mount 成功、自己的 ctx
  解析得到宿主服务、原生绑定在真宿主里走通（`default` → `tavern-lite`）、**真注入**
  （酒馆会话的提示词含卡正文哨兵、`standard` 会话一个字都不含；`tavern:nsfw` 段同判据）、
  以及**跨作用域事件投递**（子作用域发 `session/event` ⇒ 账本随之更新）；
  拿不到 cordis 时明确 skip。

  - `tests/binding-panel-ui.test.js`（31）：原有 23 例（真名/XSS/解绑/仅对新会话生效…）之外，
    新增 5 例**声明开关的行为级**测试（预览→确认→写入的顺序、取消不写、撤下要确认、
    bundle 显示安装命令、对照臂），以及 3 例**作用域回归**（见 N 节：结构 + 真执行 + 对照臂）
    ——顺带修掉「成功提示被状态刷新覆盖」那处 UX bug。

  - `tests/panel-tabs.test.js`（8）：**面板标签页布局** —— 顶层 12 张卡片全都被页签规则收走、
    页签定义完整、**底部操作区（yml/保存/状态）不被任何规则认领 ⇒ 永远可见**、
    散件规则的 id 真存在；以及用迷你 DOM **真跑安装器**（卡片落对页签、footer 留在页签外、
    切页签 + localStorage 持久化与回落、幂等）。

全套 17 个文件 **386 例全绿**；`lib/index.js`、`lib/client.manager.bundle.js` 语法检查通过。

## v2.4.3 (2026-09-23)

### 🧹 清理：播种不再追加 user 引导消息 + 手动注入防重复

- **A. 播种只留下 assistant 开场白楼**：`seedGreetingMessage` 不再在开场白之后
  append 一条 `GREETING_PREAMBLE` 的 user/message —— 它必然落在消息面上（dsh-session
  要求 user/message 带 surfaceOp），界面上多一条引导楼且回合开始后删不掉
  （toast「删除失败：这条消息可能已经开始发送」）；实测网关接受 assistant 打头，
  这条引导是白付的代价。
- **网关拒 assistant 打头的退路保留**：`agent/request-error` 撞 400 时先自动补种
  一条 user 引导（`appendGreetingPreamble`）再试，并把补种结果写进
  `greeting-seed.log`；仍不通则日志给出退路
  `POST /api/tavern/state {"greetingSeedEnabled":false}` 关掉播种。
- **B. 手动注入防重复**：`POST /api/tavern/greeting/insert` 若会话 log 里已有
  `source.model === 'character-card'` 的 assistant 楼（播种与手动注入打同一个标记），
  返回 `200 { ok:false, error:'greeting-already-present' }`，不再叠加第二条开场白
  （用户截图里示例会话出现多条【主页】开场白就是这么来的）。
  ★ 判据按 `source.model`，**不比文本** —— 占位符会被卡正则换掉，比文本必然漏判。
- **C. 面板提示**：「📌 开场白」卡收到 `greeting-already-present` 时显示
  「ℹ️ 本会话已有开场白，无需重复注入」（蓝色提示，不是报错）。

测试：`tests/greeting-seed.test.js` 22 → 30 例；新增「播种后没有 user 引导」
「两次注入第二次失败」「占位符变了仍认得出已注入」三组断言，均已验证对照臂能真红
（把旧行为放回去 ⇒ 7 例变红）。全套 8 文件 181 例全绿。

## v2.4.2 (2026-09-23)

### 🐛 修复：开场白播种从未触发（时序自相矛盾）

旧实现在**组装提示词时**才挂 `agent/inbox/inserted` 监听，且要求
`session.log.length === 0` —— 但那一刻日志里已有前置事件（预设选择等），
条件永假 ⇒ `greeting-seed.log` 从未出现、播种从未触发、首楼永远没有开场白。

修法（照 DSH 官方事件序列重写时机）：
- **路径① `agent/created`**：会话发布即评估（早于任何用户消息），能解析出权威预设
  就直接把 `first_mes` 种成 turn 1；解析不出则留给路径②。
- **路径② `agent/inbox/inserted`**：首条用户消息入队、驱动器开回合之前兜底评估一次。
- 判重改为「日志里还没有 turn/assistant」（不再要求日志为空）；安全阀全保留：
  `greetingSeedEnabled` 开关、子会话不种、同一会话只种一次。
- **日志不再静默**：每个评估分叉都写 `greeting-seed.log`（带 via 与原因），
  另保留网关拒 assistant 打头的 400 记录。
- **手动兜底**：新增 `POST /api/tavern/greeting/insert`（sessionId/presetId/cardName），
  把启用中第一张卡（或指定卡）的 first 注入当前会话**末尾**——旧会话也能用；
  面板「🔢 变量面板」旁新增「📌 开场白」卡，一键注入并显示结果/原因。

测试：`tests/greeting-seed.test.js` 重写至 22 例（含对旧实现必红的对照臂：
非空日志但没开过回合 ⇒ 必须能播种）。

## v2.4.1 (2026-09-20)

### 🐛 修复：状态栏被一个死的门控掐死

加载 `<StatusPlaceHolderImpl/>` 的 HTML 时，客户端用 `if (d.ok && d.zodSource)`
当门控 —— 而**服务端从不看 `zodSource`**（全仓库 grep 零命中；muv-engine 的
`extractStatusBarHtml` 读的是 `regexScripts` / `data.extensions.regex_scripts`）。

后果：明明能算出来的状态栏被客户端直接跳过，iframe 永远空白。实测同一张卡
（示例卡2）服务端返回 **210219 字节** 的状态栏 HTML，客户端 SKIPPED。
由于真机上极少有卡把 Zod 脚本命名为 `zod`，`zodSource` 基本恒为空 ——
**等于所有预设都渲染不出状态栏**。

修法：门控改为 `d.regexScripts && d.regexScripts.length`（这正是服务端真正需要的）。
顺带补上 `presetId`——原先这次请求不带任何参数，服务端按「最近写入的会话」猜预设，
多会话下会渲染成**别的会话的卡**。

## v2.4.0 (2026-09-20)

### ♻️ 渲染职责交割给 dsh-muv-engine

- 剧情/状态美化不再由本插件执行：原先 `beautifyContentEl` 与 muv-engine 的
  状态栏级联同时运行、互相覆盖，用户看到的是半成品（『』表头被当对话平铺）。
  现在三处调用点统一走 `delegateBeautify(msgEl)` → `window.MuvEngine`，
  muv-engine 未安装时静默跳过（本插件仍可单独使用）。
- `beautifyContentEl` 定义保留作为回退，但不再被调用。
- 消息定位改为按结构匹配（`_markdown_*` 形状 + 块级子节点过滤），不再依赖
  CSS Modules 哈希，DSH 重新构建后不会失配。
- 新建/复制预设后同步刷新预设绑定与 DOM 标签，修复「新建预设后添加角色卡/
  世界书写进了另一个预设」。

## v2.3.9 (2026-09-14)

### 🐛 会话隔离补完：破限段 / 事实修正段也必须过闸门

v2.3.8 修好了「世界书和角色卡不再漏进非酒馆会话」，但**只修了一半**。实测数字露了馅：

```
presetId = default
card=0   wb=0   edits=0   nsfw=1819   total=1819
```

世界书已经不注入了，**破限段却还在**——因为 `tavern:nsfw` 和 `tavern:edits` 这两段
各有一套自己的判断，**只检查「sid 存不存在」，从不问这个会话挂的是不是酒馆预设**：

```js
if (state.nsfwEnabled !== true) { … return '' }   // 就这一道闸，与会话无关
```

于是只要全局开关开着，**每一个会话**（包括标准模式的编码会话）都会被塞进这 1,819 字符。

修法：把「本会话该不该被注入」抽成统一判据 `isTavernSession(sid, context)`，
与 `tavern:card` 完全同一套规则（DSH 会话预设为权威；子 Agent 继承父会话），
三段共用。修好后本会话四项全归零：

```
card=0  wb=0  edits=0  nsfw=0  total=0
本会话系统提示  42,599 字符 ≈ 13,312 tokens  →  12,159 字符 ≈ 3,800 tokens   （降 71.5%）
```

### 🗑 取消「版本锁」注入

系统提示里原先硬编码注入过一条版本标记：

```
【酒馆版本: 3.0.0+】本会话使用 dsh-tavern@^3.0.0（PolyForm-Noncommercial-Copyleft-1.0.0），
不兼容 1.9.1 及以下版本。
```

两个问题：**版本号是错的**（实际 2.3.x，从来不是 3.0.0），而且它每轮都白占提示词、
却没有任何程序在读它。已按要求整条取消。

### 📝 诊断工具的两个自身缺陷（一并修掉，避免再得出错误结论）

这一轮排查中，最大的干扰不是插件，而是**我自己的诊断脚本**：

1. 「破限段」的标记字符串写成了 `'Adult mode / 成人模式 — 已启用'` ——
   多出一个前缀，**永远匹配不上**，于是持续报「无」。这是个**假阴性**，
   直接导致上一轮误判「破限段也没了」。
2. 结论行**只检查世界书标记、没算破限段**，出现「表里报有 / 结论说没有」的自相矛盾。

现在结论**直接由标记表推出**，不再手写第二个判断条件。另记一条经验：
`prompt-stats` 说 `nsfw=1819` 而诊断说「无」时，**两边数据打架要先怀疑测量本身** ——
这次就是靠这个矛盾发现脚本有 bug 的。

> 还有一个环境陷阱值得记下来：本机计划任务的电源策略默认是
> `<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>`，
> 重启脚本在 60 秒等待期间一旦遇到电源事件就会被 Windows 停掉，
> 表现为「重启没执行、日志却停在启动那一行」。

## v2.3.8 (2026-09-14)

### 🐛 修复「预设 / 会话隔离」失效：选了标准模式，世界书照样注入

用户报告：某个会话在顶部选的是**标准模式**（`standard`），但酒馆的世界书、角色卡、预设模块
照样被注入 —— 会话隔离形同虚设。查下来是**三个缺陷叠在一起**，最后一个才是要害。

**① 从日志行取会话预设时，多加了一个行内字样条件。**

DSH 把「会话当前的预设」写在**创建记录**那一行：

```json
{"type":"session","id":"session-…","agentPreset":"standard","cwd":"…"}
```

旧实现却要求该行**同时**含有 `agent-preset/selected` 或 `"header"` 字样才认，
而创建记录这两个字样**一个都不含** → 永远提取不到值。
（实测：整个会话日志里，正则真能提取出值的行**只有第 1 行**。）
现在**只看正则、不看行内其他字样**，并抽成纯函数 `extractAgentPresetFromLine()` 便于单测。

**② 最新显式选择不是酒馆预设时，旧实现会继续往前翻历史选择。**

`standard` 不是酒馆目录，于是循环不返回、继续往前翻，翻到历史上那条酒馆预设就返回。
新规则：**事件流里有显式选择就只认它** —— 是酒馆预设就用；是内置预设就判定「本会话不注入」，
**直接返回**，不再翻历史。抽成纯函数 `pickAuthoritativePreset()`。

**③ 注入闸门拿过期的 `session-bindings.json` 记账当通行证。**

```js
if (!sid || (!bindings[sid] && !resolvedOnDsh)) { … }   // 旧
if (!sid || !resolvedOnDsh) { … }                       // 新
```

`presetId` 已按「显式选择 > bindings > default」合过了，再拿 bindings 当通行证，
等于让一条过期记账推翻用户在顶部的选择 —— 这正是隔离失效的直接表现。

修好后的行为：**在哪个会话选什么预设，就只影响那个会话。**
想让某个会话完全不要酒馆注入，把它的预设设成任意非酒馆预设（如 `standard`）即可。

> 诊断过程本身也踩了坑，记一笔：用 `grep agentPreset` 过滤会话日志时，命中的"最后几条"
> 全是我们自己诊断脚本的源码（源码里当然含这个词），于是得出完全错误的结论。
> 改成**只统计正则真能提取出值的行**才看清真相 —— 「读日志辅助判断」时必须排除自身输出污染。

## v2.3.7 (2026-09-13)

### ✨ 回复体检：把「插件没注入」和「模型拒绝了」分开

一个被反复误判的问题：写不出来的时候，界面**没有任何地方**告诉你为什么。
于是「换新对话看不到角色卡」「NSFW 不生效」「血腥内容写不了」全都被当成插件 bug 去查，
而其中有些根本不是插件的问题 —— 是模型自己拒绝了，插件只是没能把这件事说出来。

新增 `🩺 回复体检` 卡片 + `GET /api/tavern/reply-check`：

- 服务端取**最后一条助手正文**（`readLastAssistantText`，只取 text 块，工具调用与
  推理块不混进来），交给纯函数 `detectRefusal()` 判定。
- **判定的难点是别误报**：角色扮演正文里出现「我不能」是完全正常的 —— 角色在台词里
  拒绝某件事。所以不做裸子串匹配，而是抓**元语言**（提到 AI 身份 / 内容政策 /
  无法协助）与**篇幅特征**（拒绝通常很短），加权打分：
  强证据 45 分、中等证据 25 分、短回复（< 500 字符）出现任何证据 +15，
  **≥ 60 判拒绝、≥ 30 判可疑**。
- 命中会**摊开给你看**（命中了哪些词 + 引用片段 + 可疑分），而不是只丢一个徽标 ——
  让人自己判断，比替人下结论可靠。
- 三种结论给三套口语化建议。判为拒绝时直说：**换模型最直接**，因为不同模型对这类
  内容的容忍度差得很远，插件改不了这个；要么就把话说成情节（谁在什么处境下受的伤、
  后果是什么），比直接点菜好使。
- 卡片挂在面板里，随焦点重同步一起刷新，另有「🔄 重新体检」按钮。

设计取舍：**不做内容层面的规避**。插件能做的只有把文字放进提示词、以及把结果说清楚；
让模型写下它拒绝写的内容，不是改一个提示词文件能做到的事，也不该由插件去尝试。

### 🐛 「反八股」和「联网搜索」各有两个控件，去重并修掉互相覆盖

面板里有**两套控件管同一个状态**，而且走的是**两个不同端点**：

| 状态 | 控件 A（✍️ 写作辅助卡片） | 控件 B（下方「系统开关」条） |
|---|---|---|
| `antiCliche` | `#tavern-anti-cliche` 勾选 + 💾 保存 | `#tavern-anticliche-toggle` 改动即写 |
| `networkEnabled` | `#tavern-network-enabled` 勾选 + 💾 保存 | `#tavern-network-toggle` 改动即写 |
| 写入端点 | `POST /api/tavern/config` | `POST /api/tavern/state` |

这不只是看起来重复，它会**丢改动**：控件 A 的勾选值只在 `loadCurrent()` 时同步一次，
而 A 的保存处理器写的是

```js
antiCliche: document.getElementById('tavern-anti-cliche')?.checked !== false
```

于是「在下方开关条改了反八股 → 回到写作辅助卡片点保存」会用 A 里那份**过期的勾选值**
把改动覆盖回去。顺带一提，这行还有个更阴的写法：元素一旦不存在，
`undefined !== false` 会算成 `true`，即**静默把反八股强行打开**。

修法：

- **每个状态只留一个控件**，统一到下方「系统开关」条（改动即写 + 带实时状态，
  与同区的 NSFW / 剧情选项开关行为一致）。写作辅助卡片里那两个重复勾选框删除。
- 写作辅助卡片的保存按钮改为只提交 `bannedWords`（改名「💾 保存违禁词」）。
  `/api/tavern/config` 是**局部更新**（只在 `typeof body.X === 'boolean'` 时写），
  所以只发一个字段不会误伤另外两个。
- 三个开关（工具 / 联网 / 反八股）的状态对齐并入 `refreshToggleStates()` ——
  原先它们只在面板挂载时同步一次，别处改过之后回到面板就会显示成过期状态；
  现在窗口重新获得焦点 / 切回标签页时也会一起拉回正确值。

### 🐛 修掉 DSH 预设管理器里那两行「加载失败」

**DSH 自带的预设管理器**（`packages/client/ui-agent-preset`，红字徽标 `brokenBadge`）
会把 `<DSH_HOME>/.agent-presets/` 下**每个「名字是合法预设 id」的目录**都当成一行预设；
缺 `agent.cordis.yml` 就标 broken，提示语是：

> `the composition file agent.cordis.yml is missing — the directory still occupies the id; delete it or restore the file`

只有名字不合法的目录（`.DS_Store` 那种）才会被跳过 —— 这条规则写在
`packages/preset/agent-presets/src/discovery.ts` 的文档注释里，明确说了「把垃圾当预设
报错会教用户无视这个标记」。而插件往这个根目录里塞了两个**不是预设**的目录：

| 目录 | 真实身份 | 出问题的原因 |
|---|---|---|
| `sessions/` | 插件的**会话级存储**（每会话独立的记忆/关系网） | `sessionDir()` 把它建在 `ROOT` 里，名字合法又没有组合文件 |
| `tavern-lite/` | 插件的**旧版默认预设目录名**（注册为 `default` /「酒馆默认」） | `ensureDefaultPreset()` 只 `mkdirSync` 建空目录，**从不写** `agent.cordis.yml` |

修法：

- **会话存储搬出预设根目录**：新位置 `<DSH_HOME>/tavern-data/sessions/`。新增
  `migrateSessionStorageOutOfPresetRoot()` 在启动时把老数据搬走并删掉旧目录 ——
  空壳直接丢弃（`readSessionMemory()` 里连**读**都会 mkdir，历史上因此留下一堆空目录），
  非空目录搬运失败时回退成逐条 rename；目标已存在则不覆盖。
- **默认预设目录必须带组合文件**：`ensureDefaultPreset()` 现在会写入一份最小可用的
  `agent.cordis.yml`（persona 行，正文字段是 `prefix:` 而不是 `text:` —— 后者会让挂载
  直接失败，见 `migratePersonaTextField`）和一份 `preset.yml`（`name: 酒馆默认`，
  DSH 用同目录的 `preset.yml` 决定卡片上显示的名字）。

诊断过程中确认了一个有用的因果：插件**每轮组装提示词**都会调用 `readSessionMemory()`，
而它开头就 `fs.mkdirSync(...)`，所以只要会话在跑，被删掉的 `sessions/<id>/` 立刻会被
旧代码重新造出来 —— 想验证修复是否生效，必须在**重启加载新代码之后**再看。

### ✨ 提示词体积指示器 + 全量注入超限告警

**这一版加的是「看得见」。** 世界书「全量注入」的代价此前完全不可见，
实测一本 154 条的预设能把系统提示顶到 **138,408 字符 ≈ 43,253 tokens**，
其中世界书一条就吃掉约 **12 万字符（87%）**：

```
系统提示 138,408 字符
├─ 世界书全量注入   ~120,000  87%
├─ 角色卡 / 固定段    ~18,000  13%
└─ 破限块位置        128,696  ← 距末尾仅 9,712 字符（深度 93%）
```

位置比总量更要命：提示词**尾部**（破限块、DSH 原生身份段）是上下文超限时
**最先被截断**的部分。这解释了一个此前查不出的现象 —— 同一个开关有时有效、
有时没效，且对话越长越容易失效。

改动分四处：

- **服务端量体积**：三个注入段（`tavern:card` order -999999、`tavern:edits` 0、
  `tavern:nsfw` 1.5）在返回前回填各自字符数；`tavern:nsfw` 是最后被组装的段，
  由它统一把快照落盘到 `prompt-stats.json`（2 秒节流，避免同轮多次组装反复写盘）。
  破限关闭、白名单外两种提前返回路径**也会落盘**，否则关掉开关就看不到数据。
- **新路由 `GET/POST /api/tavern/prompt-stats`**：返回上一轮实测体积、
  全量/关键词两种模式的**实算**对比（复用 card 段同一套条目过滤与选择逻辑，
  保证口径一致）、以及除世界书外的固定开销。纯函数 `estimatePromptBudget()`
  按 **3.2 字符/token** 估算占窗口比例，**60% 报偏大、90% 报危险**。
- **设置页新增「📏 提示词体积」卡片**：三档体积 + 颜色告警 + 上下文窗口输入框
  （默认 65536，可改成模型实际标称值）。处于全量模式且已超限时，直接给出
  「切关键词触发可降到约 N 字符、省 M%」的提示。
- **客户端面板同步**：世界书工具栏内新增体积条（5 秒节流），显示本轮实测 /
  全量 / 关键词三档与上次组装明细（卡片 / 世界书 / 事实修正 / 破限各多少字符）。

测得的效果对照：**全量注入 138k 字符（占 64k 窗口 66%） → 关键词触发约 2.8 万字符（13%）**。

> 说明：本仓库没有独立的客户端源码目录，`lib/client.manager.bundle.js` 即唯一入口，
> 因此该文件按既有流程直接修改并逐项校验（`_verify-prompt-size.mjs`，62 项）。

### ✨ NSFW / 剧情选项做成显式入口，并实时同步

**这两个开关原先根本不在界面上。** 它们被放在「⚙️ 高级功能」卡片里，
而那张卡片是 `style="display:none"` 默认折叠的：

```js
'  <div class="t-card" ...>',
'    <span class="t-card-title" id="tavern-advanced-toggle" ...>⚙️ 高级功能 ...</span>',
'    <div id="tavern-advanced-body" style="display:none;margin-top:10px">',   // ← 默认隐藏
'      ... <input type="checkbox" id="tavern-nsfw-enabled" ...>',             // ← 就藏在这里
```

后果很具体：面板里有绑定、有事件、有状态提示，**但用户看不到那个复选框**，
于是 `nsfwEnabled` 永远是默认的 `false`，成人模式看起来「怎么都不生效」。
（顺带说明：这也正是 `tavern:nsfw` 段落被判定为「注入失败」的真实原因 ——
不是键名、不是白名单，而是开关压根没能被打开。）

现在把两个开关移到 **「📚 世界书」卡片下方的常驻可见区域**，与注入模式开关放在一起：

- 🔞 **NSFW 成人模式**：开启后每轮强注入破限词
- 🎭 **剧情选项**：要求模型在回复结尾给出可点行动

「实时更新」体现在三处：

1. **切换即写入服务端**（`POST /api/tavern/state`），**下一轮对话生效**，界面文案直接写明生效时机；
2. **显式校验服务端返回**：旧实现只判断「请求没抛错」，服务端返回 `ok:false` 时
   界面照样显示「已开启」，与实际注入状态不符；现在 `ok:false` 会报错并回滚勾选框；
3. **新增 `refreshToggleStates()`**，并在**面板挂载时**与**窗口重新获得焦点 / 标签页切回来时**
   各对齐一次 —— 在别处（另一个标签页、独立设置页、直接改 `tavern-state.json`）
   改过开关，回到面板也会显示最新状态。它每次重新查 DOM，所以面板已卸载时调用也不会出错。

另外在**独立设置页 `/api/tavern/settings`** 里也加了一张「🔞 注入开关」卡片，
同样的两个开关、同一个端点 —— 面板不好找时还有第二个入口。

> 回归测试专门覆盖了「开关必须在折叠容器之外」「复选框标记不能重复」等结构性断言
> （重复 id 会让 `querySelector` 命中隐藏的那个），共 30 项。

### 📝 issue #1 复核：桌面版 DSH_HOME 重定向的路径问题已修（v2.3.5）

社区报告（`@jianaihongmutou-alt`）列的 4 处写死路径（`lib/index.js` 第 20 / 1056 / 1268 / 1666 行
的 `path.join(os.homedir(), '.dsh', ...)`）**在 v2.3.5 已全部改为从 DSH_HOME 派生**，
即报告里建议的「方案 A」，并且额外优先取 DSH 本体提供的 `dshHomePath` 服务（更贴近「方案 B」）：

```js
function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return path.resolve(expandHomePrefix(env.trim()))
  return path.join(os.homedir(), '.dsh')       // ← 仅作兜底，不再是写死值
}
```

现在 `DSH_HOME / ROOT / SESSIONS_ROOT / DSH_SETTINGS_FILE / DSH_CREDENTIALS_FILE`
全部由它派生，`apply()` 开始时还会用 `bindDshPaths()` 按 DSH 实际 home 重新绑定一次
（并让相关缓存失效）。`lib/utils.js` 与 `dsh-muv-table` 里的同类写法一并改掉。

> 复核方式：扫描三个包的源码，确认除「`~` 展开」与上述兜底分支外，
> 不存在任何写死的 `~/.dsh` 预设/会话路径。

### ✨ 新功能：一键切换注入模式

面板「📚 世界书」卡里，注入模式下拉框旁边多了一个按钮：

```
注入模式：[全文注入（所有启用条目）▾]  [⇄ 切换为关键词触发]
```

点一下就在两种模式之间来回切，**按钮上写的是「点下去会切到哪种」**，所以它永远
显示当前模式的反面。切换走的是只改模式的 `POST /api/tavern/worldbook/mode`，
**条目一个字节都不动**；下拉框与旁边的代价说明同步刷新。

### 🐛 修复：剧情选项（开关根本不存在 + 渲染器被禁 + 点击发下标）

这一条是`@0x18d` 在 PR #6 里指出的，经核对确实存在，但**根本原因比报告里描述的多一层**：

1. **复选框从未被渲染**：客户端有 `container.querySelector('#tavern-plot-options')`
   和完整的绑定逻辑，但面板 HTML 里**从来没有过这个元素** ——
   `plotOptionsEl` 恒为 null，整段绑定静默跳过，开关在界面上根本不存在。
   现已补上「🎭 剧情选项」卡片与复选框，并让状态文案跟着勾选同步。
2. **渲染器被硬关掉**：`if (false && optionList.length > 0)` —— 条件被写死为 false，
   就算收集到选项也不会渲染出按钮。已恢复。
3. **点击发出去的是下标**：按钮写的是 `data-opt="' + oi2 + '"`（`0` / `1` / `2`），
   而点击处理器把 `data-opt` 当作**要发送的文本**，于是点任何一项都只会发出一个数字。
   现改为携带选项正文。

**但只修这三处会引入更严重的问题，所以必须连收集逻辑一起改。** 原来的收集是
无条件扫全文的数字列表（`<li>` 标签 / 不带行首限制 / 带行首限制 三种方式），
再用 `['接下来', '接下', '请选择', '你决定', '你想怎么']` 这类**正常正文里也会出现**
的宽松词去 html 里找截断位置。渲染器一旦恢复，普通回复只要带个编号列表就会被当成
选项，而且消息尾巴会被从宽松词处**切掉**、替换成按钮 —— 也就是正文被吃掉。

所以新增了 `extractPlotOptions()`，口径收紧为：

- **只在出现「选项引导语」时才启用**：引导语必须独立成行、长度 ≤ 30 字符、
  且命中具体句式（行动选项 / 可选项 / 行动如下 / 选项如下 / 请选择 /
  接下来你想·你打算·要·怎么做 / 你想怎么做 / 你决定 / 你来决定）；
- **只取引导语之后连续的编号行**，支持 `1.` `1、` `1)` `-` `*` `·` `•` `一、`；
- **少于两条不算选项组**；
- **截断位置只认刚识别出的那一句引导语**（足够具体，不会误命中）；
  找不到就**不截断**，只在末尾追加按钮，绝不切掉正文。

回归测试专门覆盖了「不能误报」：正文里的编号列表、出现「接下来」但后面不是编号行、
「你决定」出现在长句里、只有一条编号、引导语后是普通段落、编号在引导语之前 ——
全部不得识别为选项。共 16 项断言。

### 🐛 修复：`lib/utils.js` 的块结束判断会把同级键吞进角色卡

`@0x18d` 报告的这一处在 **`lib/utils.js`** 里（不在 `lib/index.js`，
两个文件各有一份 `extractCardText`，实现分叉了）：

```js
if (/^\S/.test(line)) break      // 只认第 0 列的顶格行
```

`config:` 下面的 `complete:` / `includeRuntimeContext:` 与 `prefix:` **同级缩进**，
但都不在第 0 列，于是不会被判为块结束，**被当成角色卡正文一起吞进去** ——
注入的卡片末尾就多出「`complete: false`」「`includeRuntimeContext: true`」这种垃圾文本。

`lib/index.js` 那份一直用的是**缩进比较**（`indentMatch[1].length <= textIndent`），
是正确的。现把 `utils.js` 对齐到同一套判断。

新增 2 个回归用例，并**实测确认它们真的能抓到旧 bug**：把判断改回 `/^\S/`
后这两个用例立刻失败。

### 🐛 修复：成人模式编号断层

成人模式列表在 `plotOptions` 关闭时会缺号：编号 11 的那一整行（剧情选项要求）
被条件丢掉，列表就从 `10.` 跳到 `12.`。**成因不是编号写错，而是条件行本身造成的缺号**，
所以修法是让可选行**之后**的那一项编号跟着走：

```js
10. 每次回复至少包含3段以上的详细描写…
${state.plotOptions !== false ? '11. 每次回复的结尾必须提供3个剧情选项…' : ''}
${state.plotOptions !== false ? '12.' : '11.'} 严格遵守角色卡定义的输出格式…
```

开启时 `10, 11, 12`，关闭时 `10, 11`，两种状态都连续。
端到端验证直接调用服务端的 `tavern:nsfw` 段落取真实产出（12 项断言）。

> 更正：本版本开发过程中我曾把这段编号整体 +1（10→11、11→12、12→13），
> 那会**在开启时也永远缺 10**，比原 bug 更糟。是端到端测试把它抓出来的，
> 现已改回上面的正确形式。

### 🐛 修复（issue #2）：从没开过成人模式，persona 里却写了破限词

社区报告（`@dleaf6211-hash`）属实，而且比报告里描述的还多一层问题：

1. **前端内存默认值 `nsfw: true`，且从不与服务端同步** ——
   `refreshYml()` 只看这个内存值决定要不要把破限文案写进 persona，
   于是「全新安装、从没碰过开关」也会写进去。
   勾选框的显示来自服务端（正确显示「关闭」），与实际生成的内容**不一致**，
   用户完全察觉不到。
2. **真开启时会重复注入两套破限词**：persona 里一份（`【成人模式已启用】…`），
   服务端 `tavern:nsfw` 段落里还有另一份（`【成人模式 — 已启用，必须严格遵守】…`），
   两套文案不同、内容重叠。

修法是**从生成器里彻底移除**这段文案，而不是去补同步：

- 成人模式是全局开关，服务端 `tavern:nsfw` 段落本来就按真实状态注入，
  生成器再写一份只会重复。`# 写作要求` 现在只保留与开关无关的通用要求。
- 前端状态默认值改为 `nsfw: false`（与服务端一致），
  并在加载服务端状态时把 `nsfwEnabled` / `plotOptions` 同步回 `state`，
  避免内存值与实况漂移（这类漂移正是本 issue 的成因，同一类问题还有 `plotOptions`）。

### 🐛 修复：重开面板后再保存，「自定义设定」和「故事背景」会被清空

与 issue #2 是同一类问题（内存状态与服务端不一致），但后果更严重 —— **静默数据丢失**。

`buildAgentYml()` 会把 `state.extraPrompt` 写进 persona 的 `# 自定义设定`、
把 `state.storyBackground` 写进 `# 故事背景`，但这两个字段**只有「从输入框赋值」这一条路径，
没有任何回填**（服务端也只是原样存 yml，不会把它们解析回来）：

```
state.extraPrompt      = e.target.value     ← 仅此一处
state.storyBackground  = text / e.target.value / ''
```

于是这个流程会吃掉用户的内容：

1. 在「自定义设定」里写一段文风要求（或导入一段故事背景），点「💾 保存并注入」→ 写入 yml、服务端已存
2. 刷新页面 / 重开面板 → 内存里是空字符串，两个输入框也是空的
3. 此时只要再点一次「保存并注入」（哪怕只是想改别的设置）→ 新生成的 yml 里这两段是空的
   → **已存内容被覆盖，且没有任何提示**

修法是补上回填：`loadCurrent()` 本来就拿到了 `agentYml`，新增 `restorePromptSections()`
按 `# 标题` 把 `# 自定义设定` 与 `# 故事背景` 两段读回 `state` 与对应输入框。
取 persona 前缀时的块结束判断与 `lib/utils.js` 的 `extractCardText` 同口径（按键名缩进比较），
所以 `config:` 下的 `complete:` / `includeRuntimeContext:` 不会被吞进段落正文。

验证 15 项，覆盖：两段回填、不混入同级 YAML 键、不把下一段吞进来、
缺段与空值、**往返幂等**（读回→生成→再读回内容不变）、无 persona 段时不抛错。

### 📝 关于 PR #6（`@0x18d`）

同时给出评审结论，避免重复劳动：

- **问题 1（persona `text:` → `prefix:`）已完成** —— 见 v2.3.5，
  且比 PR #6 更彻底：服务端、客户端生成器、启动期迁移三处齐备
  （`migratePersonaTextField()`，改前留 `.bak`），存量坏预设自动修复，
  不需要用户重建。
- **问题 2（`complete: true` 吞段落）已完成，但方案不同且互斥** ——
  本插件的做法是**不再生成 `complete: true`**，把角色卡/世界书交给服务端按会话注入，
  并加启动期迁移清理历史预设。而 PR #6 选择**保留 `complete: true`**，
  转而把开关文案写进 persona 前缀。两条路只能选一条：合并 PR #6 会把
  `complete: true` 带回来，退回「每个预设都要重新保存一次才生效」的状态。
  白名单那道闸门两边都修了（空名单＝不限制）。
- PR #6 当前 **`mergeable_state: dirty`**（与 main 冲突，无法直接合并）。
- 问题 3 与附带 bug 已在本版本中独立修好，口径比 PR #6 更保守（见上）。

## v2.3.6 (2026-09-13)

### 🐛 修复

- **新建对话里看不到自己的角色卡**（在顶部预设选择器里选了也没用）：

  这是**两道闸门里第二道写错了**造成的。会话预设的解析本身没问题 ——
  `resolveAuthoritativePresetId()` 会去读 DSH 的会话事件流，把用户在聊天顶部
  选中的预设解析出来。问题在紧跟着的判断：

  ```js
  let presetId = getSessionPresetId(sid)          // 这里已经正确解析出「深渊」
  const bindings = readBindings()
  if (!sid || !bindings[sid]) { … return '' }     // ← 却拿酒馆自己的记账当闸门
  ```

  `session-bindings.json` 只是**酒馆自己的记账**，新建的会话里当然还没有条目。
  于是「新建对话 → 在顶部选预设」这条正常路径永远走不到注入：预设明明解析出来了，
  还是被 `return ''` 拦掉，一个字都不注入。

  实测证据（把 `session.v3.jsonl.zstd` 的多帧 zstd 正确解开后读事件流）：

  ```
  type=session                 agentPreset=standard               ← DSH 建会话时的内置预设
  type=agent-preset/selected   agentPreset=preset-fixture-a1 ← 用户确实在顶部选了
  ```

  > 附带说明：DSH 的会话文件是**追加写的多帧 zstd**，
  > `zlib.zstdDecompressSync()` 只解第一帧（4MB 的文件只会解出 200 字符的 header 行）。
  > 排查会话问题必须按帧头扫描后逐帧解压，否则会得出「会话里没有任何预设记录」这种错误结论。

  现在闸门改成「**是否解析出了酒馆预设**」：

  - `bindings[sid]` 有记录 → 用它（老会话路径不变）
  - 否则看 DSH 侧是否确实挂着酒馆可管理的预设（排除内置 `standard` 与空预设 `default`）
  - 命中就注入，并顺手补一条绑定，让面板显示与按会话隔离的数据都对得上
  - 两者都没有 → 仍然不注入（官方标准模式等未绑定会话行为不变）
  - 之后在顶部换成别的预设，权威解析读到的是更靠后的 `selected` 事件，优先于绑定

  也就是说：**每个新对话各选各的预设、会话之间聊天隔离**这个用法现在是对的，
  不需要给新会话套任何全局默认预设。`tavern:nsfw` 段落没有这道闸门（只查白名单），无需改动。

- **反八股 / 世界书 / 记忆 / 关系网全都不生效**：`tavern:card` 段落里的白名单闸门是
  「名单为空 → 谁都不放行」，而默认状态恰好是 `mode: allowlist` 且 `allowSessions`
  与 `allowCwds` 都是空数组 —— 于是该段落**恒返回空字符串**，
  上面这些内容一个都进不了提示词。日志里连 `textLen` 那行都不会出现
  （`allowedBySession` / `allowedByCwd` 统计恒为 0），很容易误判成「功能没做」。

  现改为 **白名单为空 = 不限制**：空名单时放行，一旦填了条目就按名单生效。
  `tavern:nsfw` 段落里的同类闸门一并修正。

- **`complete: true` 把其他所有段落整段压掉**：
  面板生成的 `agent.cordis.yml` 给 persona 设了 `complete: true`，而 `complete` 的语义是
  「本段恢复为**唯一**的系统提示段落」（`dsh-system-prompt` 的 assemble：
  `sections: [completeSection]`）。被压掉的包括：

  - 酒馆自己的 `tavern:card`（反八股 / 世界书 / 记忆 / 关系网 / 工具开关）
  - 酒馆自己的 `tavern:nsfw`、`tavern:edits`
  - DSH 原生的身份段、工具指引、运行时上下文

  症状就是「反八股不生效」「原生工具指引消失」。同时 persona 里塞的
  角色卡 + 全部世界书还与运行时段落重复注入两份。

  修复：
  1. 生成器不再写 `complete: true`
  2. persona 不再包含 `# 角色卡` / `# 世界书`（交给服务端按会话注入；
     世界书是关键词触发，省上下文；角色卡服务端会从 `characters.json` 读回）
  3. 新增启动期迁移 `migratePersonaCompleteFlag()`：自动把历史预设改成同样的结构
     （改前留 `.bak`；仅当预设目录里有非空 `characters.json` 时才摘角色卡那段）

### 🐛 修复：面板保存会顶掉别处改的注入模式

这一条是新功能上线后紧接着发现的连带 bug，属于「你的修改会被悄悄改回去」那一类：

`saveWb()` 每次保存条目/分组时都会带上 `injectMode: wbMode`，而 `wbMode` 只在
`loadWb()` 时刷新。于是**只要在别处改过模式**（独立设置页、另一个标签页、
直接改 `worldbooks.json`），再回到面板点一下「＋ 新增条目」或删一条条目，
那个陈旧的 `wbMode` 就把刚改好的模式**覆盖回旧值**，且没有任何提示。

修复分两处，缺一不可：

1. **服务端**：`POST /api/tavern/worldbook` 在请求体**不含** `injectMode` 时，
   保留该预设磁盘上已有的模式，不再默认成 `full`；显式传入时照旧生效，
   非法值仍回落 `full`。响应体回显最终模式，便于前端确认。
2. **面板**：`saveWb()` 不再发送 `injectMode`（现在整个函数体内不出现这个词）；
   模式改动单独走只动模式的 `POST /api/tavern/worldbook/mode`。

顺带修掉同一片区域的另外几处：

- **`loadWb()` 的同名组合并会洗掉字段**：以前**无条件**把每个分组重建成
  `{name, enabled, entries}`，分组上其它字段（如扫描深度）会被静默丢弃；
  现在只有**真的出现同名分组**时才重建，且用 `Object.assign` 保留原字段。
- **按内容去重会吃掉真条目**：原来判重只看 `content`，两条内容相同但
  关键词/注释不同的条目会被当成同一条，**下一次保存就从磁盘上永久消失**。
  改为 `content || text` 加 `comment` 一起比（`__sameEntry`）。
- **`renderWbList()`/`loadWb()`/`saveWb()` 缺守卫**：面板卸载后
  `querySelector` 返回 null 会抛错；现在 `renderWbList` 对空列表直接返回，
  `loadWb` 用 `container.isConnected === false` 跳过，并按项目规范补上 `.catch()`。

### ✨ 面板与外部修改的实时同步

- **保存后回读磁盘**：`saveWb()` 成功后调用 `loadWb()`，界面以磁盘为准，
  消除「本地视图与服务端归一化结果漂移 → 下一次保存把漂移写回磁盘」的隐患。
- **回到窗口自动对齐**：新增模块级重同步钩子（`__tavernWbRefresh` +
  `installWbFocusHook`），监听 `window.focus` 与 `visibilitychange`；
  从独立设置页或别的标签页切回来时自动重拉，**3 秒节流**避免反复请求，
  面板已卸载时因 `isConnected` 守卫而完全不打扰后端。
- 预设新建 / 复制 / 删除、会话切换等既有刷新路径保持不变
  （经解析器核对，这些 `loadWb()` 调用点都在作用域内，并非缺陷）。

### ✨ 新功能：设置面板里的「世界书注入」开关

不用再手改 `worldbooks.json`。打开 `/api/tavern/settings`，多了一张
「📚 世界书注入」卡片，两个单选按钮，旁边直接写着代价：

| 选项 | 每轮带入 | 说明 |
| --- | --- | --- |
| **全量注入** | 约 11.5 万字符 | 世界书所有条目都写进提示词。人设记得最牢、不会漏，就是费钱。 |
| **关键词触发** | 约 1.2 万字符 | 常驻条目每轮必带；其余条目只在最近 4 条消息里提到关键词时才注入；分阶段人设只带当前好感度那一档。省约 90%。 |

配套新增端点 `POST /api/tavern/worldbook/mode`，**只改 `injectMode`，一个字都不动条目**：

```bash
curl -X POST http://127.0.0.1:3080/api/tavern/worldbook/mode \
  -H 'content-type: application/json' \
  -d '{"injectMode":"keyword"}'
# → {"ok":true,"presetId":"…","injectMode":"keyword","groups":1,"entries":154}
```

> 为什么不复用 `POST /api/tavern/worldbook`？那个端点要求请求体带齐
> `entries` / `groups`，只发一个 `injectMode` 会把整个世界书**清空**。
> 所以这里另开一个只改模式的端点，非法值一律回落 `full`。

### ✨ 面板里的注入模式，旁边直接写出代价

酒馆面板「📚 世界书」那张卡早就有一个注入模式下拉框，但只写了
「全文注入（所有启用条目）」这种一句话，看不出到底差多少钱。
现在下拉框右边多了一行说明，**按你当前世界书的真实条目算**，不是写死的数字：

```
全文注入  →  所有启用条目（108 条，约 10.3 万 字符）每轮都写进提示词。
             角色记得最牢、不会漏，代价是每轮都要带上这些上下文。

关键词触发 →  常驻 3 条（约 5960 字符）＋分阶段人设 9 组，
             每轮按当前好感度各带 1 档（约 6216 字符）每轮必带；
             其余 105 条只在最近 4 条消息里提到关键词时才注入。比全量省约 88%。
```

口径刻意与服务端 `selectWorldbookEntries` 对齐，三处容易被算漏的地方都处理了：

1. 正文取 `content || text`，不是只读 `content`；
2. 含 `<%` 的 **EJS 条目自身一字符都不注入**（它只是分阶段人设的选择器），
   不再被误当成「常驻必带」；
3. 分阶段人设按**最低档**估算 —— 好感度从 0 起步时服务端就是这么挑的。

对账结果：面板报 5960 + 6216 = 12176 字符，服务端实际注入也是 12176 字符，
**逐字符一致**（`_verify-wb-hint.mjs` 10/10）。切换下拉框或增删条目后，
说明文字会立刻重算。

### 🌍 世界书（对齐 SillyTavern 语义）

原实现有几个与 ST 不一致的地方，直接导致「该触发的没触发 / 不该注入的全量注入」：

- **EJS 模板被当正文注入**：ST 的 `分阶段人设` 条目是 `<%_ if (好感度>90) { _%> … getwi(...) %>`
  EJS 脚本，酒馆不执行 EJS，却把这些脚本**原样拼进提示词**（9 条 4.7k 字符纯垃圾）。
- **`getwi()` 引用的条目被当成「未启用」丢掉**：分阶段人设的 36 条阶段条目都是
  `enabled:false`，由 EJS 按好感度挑选。酒馆按 `enabled` 过滤后一条都拿不到 ——
  结果是「EJS 垃圾进了、真正的阶段人设一条没进」。
- **`keys || keywords` 的兜底是错的**：`[]` 在 JS 里是 truthy，
  `keys` 为空数组时永远拿不到 `keywords`。
- 关键词扫描深度写死 20 条，不看分组/条目配置。

现已按 ST 语义重写（`selectWorldbookEntries`）：

1. **常驻**：`constant:true` 或没有关键词；其余按关键词触发
2. **副关键词**：`secondary_keys` / `keysecondary` 需同时命中（AND）
3. **扫描深度**：`wb.scanDepth` 可配，默认 **4**（原为 20）
4. **分阶段人设互斥**：解析 EJS 里的 `if (好感度 > N) { getwi(...) }` 阈值与
   `getvar('stat_data.<角色>.好感度[0]')`，从近期消息取最新好感度，
   每个角色**只注入当前档位那一条**（实测 0/45/75/95 → 阶段01/02/03/04）
5. **EJS 模板不再注入**，只用来提供阈值
6. 新增支持 `caseSensitive` / `matchWholeWords` / `probability` / `order` / `disable`

> 体积实测（同一份世界书）：常驻 + 当前阶段 = 每轮约 1.2 万字符的基线；
> 关键词条目按命中追加。原先的最坏情况（近期消息提到多个角色名）会一次灌入
> 14.5 万字符。

### 🔧 改进

- 迁移函数加入 `_test` 导出，便于单测与离线修复。
- 世界书选择器（`selectWorldbookEntries` / `parseStagePlans` / `latestAffection`）
  一并加入 `_test` 导出。

> 未改动任何许可证内容。

---

## v2.3.5 (2026-09-13)

### 🐛 修复

- **DSH 装到非默认位置时预设无法生效 / 无法注入**：路径此前写死为 `~/.dsh`。
  而 DSH 本体是用 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 定位用户数据根的：

  ```
  优先级 = 显式配置 → $DSH_HOME（非空）→ ~/.dsh
  用户预设目录 = <dshHome>/.agent-presets
  ```

  一旦 `DSH_HOME` 指向非默认位置，酒馆就会把预设写到 DSH **根本不会扫描**的
  `~/.dsh/.agent-presets`：面板里配好的预设在 DSH 侧不存在，无法在聊天顶部
  预设选择器里选中，也就无法注入。

  现在 `apply()` 开始时优先取 DSH 提供的 `dshHomePath` 服务（与本体同源），
  拿不到再按 `$DSH_HOME` → `~/.dsh` 自行解析，并同步绑定预设目录、会话目录、
  `settings.yaml` / `.credentials.yaml`。相关缓存同时失效。

- **会话日志永远找不到**：`findSessionFile()` 只认 `session.jsonl.zstd`，
  而 DSH 的会话日志文件名带物理格式代次（见 `dsh-session-format/src/filename.ts`）：

  ```
  generation 0 -> session.jsonl / session.jsonl.zstd
  generation N -> session.vN.jsonl / session.vN.jsonl.zstd
  ```

  0.1.5-rc.1 当前写的是 **`session.v3.jsonl.zstd`**，所以现行会话一个都匹配不到。
  连带失效的有：

  - `resolveAuthoritativePresetId()` 读不到会话事件流里的 `agent-preset/selected`，
    无法采用「聊天顶部预设选择器」这个权威来源，只能退回旧的 `session-bindings`
    兼容数据，最后落在默认预设
  - 会话内容预览、会话标题、编辑过的消息历史

  现在按正则匹配该目录下代次最高的 `session[.vN].jsonl[.zstd]`。

- **切换预设时报 `$.prefix missing required value`，预设无法挂载**：
  面板生成 `agent.cordis.yml` 时把 persona 正文写在 `text:` 字段，而
  `@deepseek-ai/dsh-persona` 的 Config 以 `prefix` 为必填。v2.3.2 只修了服务端
  「空白预设骨架」那条路径，**漏了客户端里带实际内容的那条生成路径**
  （角色卡 + 世界书全量写进 persona），所以带内容的预设依然挂载失败：

  ```
  无法切换到「深渊」：failed to apply loader entry persona (@deepseek-ai/dsh-persona):
  invalid config: - $.prefix missing required value
  (…\.agent-presets\preset-xxxx\agent.cordis.yml)
  ```

  三处一起修：

  1. `lib/client.manager.bundle.js` 生成器：`config.text:` → `config.prefix:`
  2. 服务端 `extractCardText()`（`lib/index.js` 与 `lib/utils.js`）同时接受
     `text:` 与 `prefix:` —— 否则改完之后读不回角色卡，注入内容会变空
  3. 新增启动期迁移 `migratePersonaTextField()`：扫描预设目录，把 persona 行里
     legacy 的 `text: |-` 就地改成 `prefix: |-`（改前留 `.bak`），
     已经坏掉的老预设无需重建即可恢复

### 🔧 改进

- 启动时打印 `DSH_HOME`、预设目录、会话目录，路径类问题可一眼看出。

> 未改动任何许可证内容。

---

## v2.3.4 (2026-09-13)

### 📝 文档

- **统一许可协议表述**：README 底部的「📄 许可协议」段落此前写的是 **CC BY-NC-SA 4.0**，
  与 `LICENSE` / `LICENSE.md` / `package.json` 的 `license` 字段
  （PolyForm-Noncommercial-Copyleft-1.0.0）不一致。现统一为
  **PolyForm-Noncommercial-Copyleft-1.0.0**，并按其实际条款重写要点
  （非商业用途、Copyleft 开源、商业需单独授权、须随附协议全文）。
- README 中所有协议名称统一为 `PolyForm-Noncommercial-Copyleft-1.0.0` 这一种写法。

> 仅改动 README 的文字表述。`LICENSE` / `LICENSE.md` 正文与 `package.json` 的
> `license` 字段均未改动。
> `RELEASE_NOTES_v1.9.2.md` 中标注的 `CC-BY-NC-SA 4.0` 是 v1.9.2 当时的历史事实，
> 属于版本发布记录，按原样保留。

---

## v2.3.3 (2026-09-13)

### 📝 文档

- **修正指向已归档仓库的链接**：`README.md` 页脚的「仓库」链接与 `CONTRIBUTING.md` 的 4 处
  贡献入口（Issues / Bug 模板 / 功能需求模板 / Discussions）此前都指向旧仓库
  `chen731215-dev/dsh-tavern`。该仓库已归档，**归档仓库无法新建 issue**，
  等于贡献入口全部失效。现已全部改为 `dsh-tavern-v2`。
- `README.md` 顶部「旧仓库已归档」的说明链接按原样保留（它就是用来标注归档的）。

> 未改动任何许可证内容。

---

## v2.3.2 (2026-09-13)

> 适配 DSH 0.1.5-rc.1。服务端与客户端的对接面已逐项核对：`ctx.systemPrompt.section`、
> `ctx.webServer.register({kind,path,handler})`、`context.agent.session.header.*`、
> `~/.dsh/.agent-presets` + `agent.cordis.yml`/`preset.yml` 约定、客户端
> `slots.inject('settings.section', () => slots.register({...}))` 写法均与当前版本一致。

### 🐛 修复

- **子 Agent 组装提示词直接崩溃**：`tavern:card` 的 `sid` 声明为 `const`，但下方的「子 Agent 继承」分支会执行 `sid = parentSid`，导致该分支一触发就抛
  `TypeError: Assignment to constant variable`。
  **主会话一旦绑定酒馆预设，任何 subagent 组装提示词都会失败** —— 也就是说这段为多 Agent 场景写的继承逻辑此前从未生效过。声明改为 `let`。

- **自动总结会去总结 agent 之间的会话**：`lastSessionId` 原先由「任意 agent 组装提示词」覆写，
  子 Agent / 队友 Agent 会把当前会话改成自己的子会话，自动总结于是读错会话、`mem.lastSeq` 也被子会话的条数冲掉，导致「每 N 条总结一次」的节奏紊乱。
  现在只有**会话本人**才更新 `lastSessionId` 并触发自动总结，子 Agent 继承分支不再写 `lastSessionId`
  （孙 Agent 的 `parentSid` 本身仍是子会话，同样不能写）。
  判别使用 `header.origin === 'subagent'` / `delegationDepth > 0`，**而不是 `parentSession`** ——
  用户自己 fork 出来的会话同样带 `parentSession`，不该被排除。

- **摘要输入混入工具标记**：会话日志里 `assistant/message` 会携带 `tool-call` 内容块，
  `contentToText` 把它们拼成 `[工具subagent]` 这类标记混进总结输入。
  新增 `contentTextOnly`，记忆总结与会话内容预览只取 `text` 块，丢掉工具标记与推理块。
  实测同一条真实会话：工具标记 **287 → 2**，字符 47047 → 44455。

- **「＋ 新建」空白预设无法挂载**：生成的骨架把 persona 配置写成 `config: text:`，
  而 `@deepseek-ai/dsh-persona` 以 `prefix` 为必填字段，schema 校验报
  `$.prefix missing required value`。而一行配置校验失败会**拒绝整个 preset 挂载**
  （`agent-preset/invalid: preset "x" failed to mount`），导致新建的预选选中后 Agent 起不来。
  改为 `prefix:`。

### 📦 依赖

- muv-table: `^0.2.1` → `^0.2.2`（exports 修复）
- muv-engine: `^0.3.1` → `^0.3.2`（导入路径修复）

> v2.3.1 发布期间这两个依赖曾因上游包存在缺陷而暂时移除；上游修复并发布后已恢复声明，
> 安装本包即会一并带上 MUV 伴生插件。

---

## v2.3.0 (2026-08-31)

### ✨ 新功能
- **状态栏移到消息底部**：世界卡/状态卡/状况卡/「状态栏：」/sese 状态块渲染后统一追加到消息末尾（虚线分隔 `.tavern-status-trailer`），剧情正文在前
- **选项交互修复**：剧情选项点击改为 document 级事件委托（一次注册永不失效），`sendTavernMessage` 输入框查找增强（placeholder 匹配 + 可见 textarea 兜底），选项 `<li>` 增加可点样式
- **世界书 HTML 模板说明**：`buildWorldbookText` 检测到 `<Drama>` `<style>` `<choices>` 等标签时自动注入「格式说明」，告诉 AI 按模板填内容、不要原样输出标签

### 🐛 修复
- **转义标签还原**：DSH 会把 LLM 输出的 XML 标签转义成 `&lt;标签&gt;` 文本，导致 `_tavernRenderTags` 匹配不到 → 现在调用前先还原为真实标签（`<choices>` `<Drama>` `<style>` 等都能渲染/剥离）
- **守卫条件**：同时识别 raw 和转义两种标签形态，MUV 标签消息不再被跳过
- **预设单一事实来源**：
  - `getActivePresetId()` 优先读浮动面板实时 DOM（`dataset.presetId`），localStorage 仅兜底 —— 编辑器永远加载当前选中预设
  - 保存成功后同步 localStorage + 触发 `tavern-preset-changed` 事件
  - 服务端新增 `rebuildAllPresetDescriptions()`：从磁盘重建真实描述、移除目录丢失的孤儿预设条目（启动/列表/保存时调用）
- **CSS 统一 DSH 变量**：背景/边框/文本/品牌色全部替换为 `var(--dsw-alias-*)`，跟随主题

### 📦 依赖
- muv-engine: `^0.2.1` → `^0.3.0`（融合 dsh-visual-render）

---

## v2.2.0 (2026-08-27)

### ✨ 新功能
- **MUV 标签渲染钩子**：`beautifyContentEl` 自动调用 `_tavernRenderTags` 和 `_tavernRenderLatex`，<speech>/<action>/<thought>/<char>/<pose>/<location>/游戏卡片等 XML 标签实时转换为带 CSS 样式的 HTML
- **宏展开支持**：输入框拦截器自动展开 `{[random::]}` `{[pick::]}` `{[roll::]}` 宏后再发送给 AI

### 🎨 美化
- 游戏卡片独立配色：赏令金色、盲盒紫色、拍卖青色、道友蓝色、飞剑青绿、自由橙色
- speech/action/thought/char/pose/feeling 等表演标签独立颜色
- dialogue 蓝色左边框、location 深紫背景卡片

### 📦 依赖
- muv-engine: `^0.1.0` → `^0.2.0`
- muv-table: `^0.1.0` → `^0.2.0`

---

## v3.0.0 (2026-08-27) — ⚠️ 不兼容 1.9.1