# 酒馆面板功能体检（哪些真有用、哪些是死的）

> 方法：① 面板控件 ↔ 客户端引用 ↔ 服务端路由 **三方交叉比对**；
> ② 逐个特性追到**它有没有真的进入注入**（四个 system prompt 段：`tavern:card` / `tavern:nsfw` /
> `tavern:edits` / `tavern:enhance`，以及是否真的改变行为）；
> ③ 核对依赖的姊妹插件是否真提供那些接口。
> 结论只认**调用点**，不认卡片上的说明文字。
>
> 代码位置：仓库与装机版**逐字节一致**，下面行号两边通用。

---

## 一、真有用（数据确实进注入 / 确实改变行为）

| 功能 | 证据（行号） |
|---|---|
| 角色卡正文 | `extractCardText` → 拼进 `tavern:card`（`lib/index.js:5323`） |
| 世界书 | 按触发词或全量选择条目（`selectWorldbookEntries` 4833 / 5218-5230），文本拼进同一段（5323），体积计入 `sectionSizes.wb`（5326） |
| 记忆与总结 | 会话级记忆文本进注入（`readSessionMemory` → 5209、5282）；自动/手动总结走模型 |
| 🔞 NSFW 破限 | 独立段 `tavern:nsfw`（5365）；`nsfwEnabled !== true` 直接 `return ''`（5370 附近） |
| 🎭 剧情选项 | `plotOptions` 进注入（5417-5418） |
| ✨ 通用增强层 | 独立段 `tavern:enhance`（5515-5528），`enhanceRuntimeEnabled` 为假就整段不注入 |
| 🎯 生效范围 | `mode` / `allowCwds` / `allowSessions` / `disabledCwds` / `cwdPresets` 真参与 `decideInjectionScope`，注入区里被读（5176-5181、5385-5386） |
| 📌 开场白 | 面板按钮 → `POST /api/tavern/greeting/insert` → `appendGreetingToSessionEnd` 把 `first_mes` 注入会话**末尾**（★ 2026-10-04：新会话的「自动播种」会把会话日志写坏到永久打不开，已整体删除；现在只有手动注入，且要求会话已跑过一个回合 —— 过闸门 `canAppendGreetingSurface`） |
| 📖 故事背景 | 客户端折进预设 yml 的 `# 故事背景` 段（`client.manager.bundle.js:393-394`，截断 6000 字）→ 由 DSH 当作预设内容注入 |
| ✍️ 写作辅助 | `bannedWords` 进注入；「上下文压缩」= 带 `rounds` 的 `/api/tavern/summarize` |
| 🔧 AI 工具 / 🌐 联网 / 🚫 反八股 | `toolsEnabled`（5272）、`networkEnabled`（5275、5319，另 2053 控制 `dsh-tool-web`）、`antiCliche`（5290）都在注入区被读 |
| 🎭 当前 Agent 预设 | 原生 `agentPreset` 绑定链路（本次会话修的那套） |
| 🩺 回复体检 | `/api/tavern/reply-check`：把最近那条回复判成 ok/suspect/refusal 并给命中词 —— 用来区分「插件没注入」和「模型拒绝」，是真逻辑（客户端 2414-2452） |
| 🧩 全局正则 | 依赖 muv-engine；已装 **0.3.11**（tavern 声明 `^0.3.2`）✓ 接口 `global-regex` 存在 |
| 📢 声明为 DSH 预设 / 📦 生成 bundle / 🧹 撤下 | 真写盘：默认 dry-run、备份、原子写、回读自检、失败回滚 |
| 提示词体积 | 服务端实测 `sectionSizes` + `promptWindowTokens`，面板显示占比 |

## 二、半残：能用，但"没你想的那么有用"

| 问题 | 证据 | 后果 |
|---|---|---|
| ~~**🔗 角色关系网的数据从不注入**~~ | 原先 `readSessionRelations` 只在 `mergeSessionRelations` 与 GET 路由里被调用，**注入区一次都没出现** | ✅ **已修**：按用户要求做了**软注入** —— `buildRelationsHintText()` 在 `tavern:card` 段尾追加**一行存在性提示**（只报 N 个角色 / M 条关系 + "不要据此推进剧情"），**不含任何人名或关系内容**，所以不影响剧情、token 代价可忽略。开关 `state.relationsHint`（默认开），面板「🔗 角色关系网」卡片里有复选框 |
| ✍️ 写作辅助「保存违禁词」的反馈串到别处 | 点击后把结果写到 `#tavern-api-status`（那元素在**记忆与总结**卡片里） | ✅ **已修**：改写本卡片自己的 `#tavern-writing-status`，并补失败分支 |
| 📖 故事背景的保存依赖底部「💾 保存预设」 | 改的是 `state.storyBackground`，真正落盘要按保存 | 容易以为改完即生效（未改，属设计） |
| 🧩 全局正则 / 🎭 剧情选项的部分能力 | 走姊妹插件 `dsh-muv-engine`（0.3.11）/ `dsh-muv-table`（0.3.0） | 卸掉 muv 就降级；当前版本满足 ✓ |

> **本表之外的两处已按用户要求整层删除**（详见 CHANGELOG 的 P / Q 节）：
> 「✨ 通用增强层·运行时注入」+「✨ 套用通用增强模块包」（连 `lib/utils.js` 的纯函数、
> `lib/preset-enhance-pack.json`、`/api/tavern/preset/enhance` 路由一起删）、
> 「🔞 NSFW 成人模式」（连 `tavern:nsfw` 注入段一起删）。
> 结果：**注入段从 4 个减到 2 个**（`tavern:card` / `tavern:edits`）—— 破限与文风全部交回 ST 预设。

## 三、死代码 / 摸不到的功能（**已在本次清理中处理**）

> ⚠️ **本文档第一版有一处误判，此处更正**：我原先把 `tavern-allow-add-btn` 那几处
> `querySelector(...).addEventListener(...)` 判为"无守卫、潜在 TypeError"。
> 复查发现它们**整段在 `/* ... */` 块注释里**（我的扫描只跳过 `//` 行，没识别块注释）。
> 结论：**不存在潜在 TypeError** —— 那是"注释掉的死文本"，不危险、只是占地。
> 其余判断不变。

| 项 | 证据 | 处置 |
|---|---|---|
| **🤖 Agent 预设管理**（搜索 / 批量删除 DSH 预设） | markup 早被注释，JS 仍在但**目标元素不存在** → 4 个函数/入口全是惰性死代码 | ✅ **已删 114 行**；删除前已验证 `agentPresets` / `agentGroupCollapsed` 等在所有函数/变量段外**零引用** |
| 旧版「生效范围」UI（textarea 草稿式白名单） | 整段在块注释里（原 3776-3859），另有 59 行"给旧元素回填"的惰性代码 | ✅ 已删（注释块 + 惰性回填） |
| 旧 `tavern-inject-status` 指示 | `loadCurrent` 与工具开关回调各写一次，元素不存在 | ✅ 已删 |
| `renderWorldbooks` | 目标 `#tavern-wb-manager-list` 不在面板里，函数每次调用都在第一行 `return` | ✅ **已删 39 行 + 4 个调用点** |
| 旧白名单状态 / `tavern-switch-agent` / 旧 `tavern-nsfw` | 都在块注释里 | ✅ 已随块删除 |
| dropzone 的 `id`（`tavern-char-drop` 等 3 个） | 绑定走 `.t-dropzone` + `data-type` | 保留（无害，便于调试定位） |

**清理成效**：`lib/client.manager.bundle.js` **500,123 → 463,166 字节（-37 KB ≈ 370 行）**；
注入段 4 个 → **3 个**（`tavern:card` / `tavern:nsfw` / `tavern:edits`）。

### 清理过程中的一次自伤（教训）

清「旧生效范围回填」时，我的区间删除**多删了 3 行**：那条 `return fetch('/api/tavern/state')…`
是**活代码**（回填 `activePresetIdx`，面板重开不回落到第 0 组），恰好夹在被删的惰性代码中间。
`node --check` 立刻报 `SyntaxError` → 定位 → 补回，并加测试
`preset-idx.test.js [5]`「回填链必须在」把这类误删钉死。
**教训：区间删除必须检查"区间里有没有夹着活语句"，光看注释标题不够。**

## 四、已按用户要求删除的功能

| 功能 | 处理 | 底层保留 |
|---|---|---|
| **✨ 通用增强层·运行时注入**（卡片 + 开关 + `tavern:enhance` 段） | ✅ 整层删除：卡片、开关处理、状态写入、注入段、两处响应字段 | `lib/utils.js` 的 `buildEnhanceRuntimeBlock` / `enhanceRuntimeEnabled` 保留（有单测），但**不再被任何注入段调用** |
| **✨ 套用通用增强模块包**（按钮 + 覆盖勾选） | ✅ 界面入口删除 | `/api/tavern/preset/enhance` 保留（可脚本调用，自动备份 `presets.json.bak-<时间戳>`） |

理由（用户原话）：*"我希望可以让 st 的预设来代替这个通用增强"* —— 预设是数据，用户自己写得比插件猜得准；
插件只负责把预设原样送进提示词，不再自动追加任何"通用约束"。

防复活测试：`preset-enhance.test.js [8][9][20]`、`cordis-mount.test.js [1]`（段数必须 = 3）、
`panel-tabs.test.js ①`（卡片必须保持删除）。

## 五、其他已修

**✍️ 写作辅助「保存违禁词」的反馈串卡**：原先把结果写进 `#tavern-api-status`（那元素在
「🧠 记忆与总结」卡片里）→ 在「增强」页签点保存**看不到任何反馈**。现在写回本卡片自己的
`#tavern-writing-status`，并补齐失败分支。

## 六、建议的处理顺序（更新）

1. ~~清掉旧「生效范围」死代码~~ ✅ 已完成
2. ~~修写作辅助的反馈串卡~~ ✅ 已完成
3. ~~决定 Agent 预设管理~~ ✅ 已按"不需要"删除
4. **关系网二选一**（待你定，见下节）
5. 可选：加「🩺 诊断」页签，把 回复体检 / 提示词体积 / 声明状态 收一起

## 七、关系网的两个选项（供决策）

| | ① 接进注入 | ② 只标注"不参与生成" |
|---|---|---|
| 模型能否看到 | **能**，关系内容进提示词 | 不能，纯展示 |
| 代价 | 占 token；要设计"注哪些、何时注" | 零成本零风险 |
| 收益 | 模型知道"谁和谁什么关系、发生过什么"，连续性更好 | 无（但界面不再误导） |
| 风险 | 注多了挤窗口；可能与 ST 预设重复 | 无 |

**推荐**：已在用 ST 预设管设定 → 选 ②；想让关系网真的影响剧情 → 选 ①，
但建议做成**按需注入**（像世界书那样：最近对话里出现相关人物才注入那几条），不要每轮全量。

---

**体检方法备注（可复现）**：三方交叉比对脚本在 `_scratch/audit-*.mjs`
（`audit-features.mjs` 控件↔引用↔路由、`audit-missing-precise.mjs` 精确缺失 id、
`audit-usefulness.mjs` 特性→注入、`audit-final.mjs` 版本与注入段内容）。
