# 重构交接文档（给接手重构的 AI 助手）

> ⚠️ **这是一份历史快照（2026-10-07 / v2.7.2），不要照着它跑基线。**  
> 下面的数字（`7174 行`、`22 个文件 / 434 项`、`134 KB`…）**都是当时的值，已经过期**。  
> · 规范与命令一律以 [`AGENTS.md`](./AGENTS.md) 为准；  
> · `npm test` **已经不是 `&&` 长链**了（现在是扫目录的 `tools/run-each-test.mjs`，见 AGENTS.md §9）；  
> · 实际走过的路与本文件的方案有出入，**重构进度以 AGENTS.md §10 为准**。  
> 最新工作交接见 [`HANDOFF-2026-10-08.md`](./HANDOFF-2026-10-08.md)。  
> 本文件保留原样，只为留下「当时是怎么判断的」这个记录。

> 写于 **2026-10-07**，对应提交 `91f4ca5`、版本 **2.7.2**。  
> 仓库：`chen731215-dev/dsh-tavern-v2`（本地检出：`restored/dsh-tavern-v2`）  
> 已发布：npm `dsh-tavern@2.7.2`（`latest`），本机 profile 亦为 2.7.2。

---

## 0. 先跑这三条，确认你接手的基线

```powershell
$node = "C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_ASAR = "D:\deepseek harnes\resources\app.asar"      # 跑测试前必须设
cd restored\dsh-tavern-v2
& $node tools\run-each-test.mjs        # 期望：合计 pass=434 fail=0，22 个文件
& $node tools\assert-style-budget.mjs  # 期望：exit 0（两项内联事件硬 0）
```

**任何一条不过，先修基线，不要开始重构。**

---

## 1. 现状与目标

| 项   | 现状                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ |
| 服务端 | `lib/index.js` **7174 行 / 385 KB**（单文件：状态、预设 CRUD、绑定、注入、路由、记忆总结、关系网、技能生成、设置页 HTML 全在里面）                      |
| 客户端 | `lib/client.manager.bundle.js` **7116 行 / 486 KB**（**没有构建步骤，这个 bundle 就是源码**）                                |
| 小工具 | `lib/utils.js` 104 行、`lib/client.js` 32 行                                                                    |
| 测试  | `tests/` **22 个文件 / 434 项**，`npm test` 是 `&&` 长链，**推荐用 `tools/run-each-test.mjs`**                           |
| 工具  | `tools/assert-style-budget.mjs`、`tools/style-budget.json`、`tools/run-each-test.mjs`                          |
| 文档  | `CHANGELOG.md` 已达 **134 KB**；`AGENTS.md` / `CLAUDE.md` **内容陈旧**（版本号还是 1.9.2 / 1.7.1、包名写 `@local/dsh-tavern`） |

**重构目标**：把两个 7000 行级单文件拆成可维护结构，**且不改变任何用户可见行为**。

---

## 2. 硬约束（违反会出事，先读完再动手）

1. **`lib/client.manager.bundle.js` 就是发货源码**，没有构建步骤。可以直接改它；**不要**引入构建步骤却不改发布流程（`package.json.files`、npm 发布、市场更新都会跟着变）。`AGENTS.md` 里"客户端是打包文件不要改"那句已过时。
2. **文件是 LF 换行**，不要转 CRLF；**不要整文件重排格式**（会淹没真实 diff）。
3. **绝不改写 DSH 会话日志**。历史上有个 `writeSessionLines()` 会重写整份 zstd 会话（属于已删除的"编辑 AI 回复"功能），已删；`lib/index.js` 里留了注释警示，**不要再引入这类写法**。
4. **不要动 `~/.dsh` 下的用户数据**：`.agent-presets/`、`tavern-state.json`、`tavern-data/` 等。测试一律用 tmpdir。仓库里也不许出现本机绝对路径、token、会话 id。
5. **`AGENTS.md` 现在写着「服务端逻辑全部集中在 `lib/index.js`，不要新建拆分子模块文件」** —— 这条**与本次重构目标直接冲突**。开工第一步就是**改掉这条**（并同步 `CLAUDE.md` 的陈旧版本号/包名），否则后来者会照旧规矩又把代码堆回去。
6. **发布包不含 `tools/` 与 `tests/`**（`package.json.files` 决定）；改 `files` 要同步改发布验证。

---

## 3. 架构地图（按功能块定位，**不要按行号**——行号会漂）

### 服务端 `lib/index.js`

| 功能            | 搜索关键字                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Home 解析       | `resolveDshHome`（优先级：显式配置 → `$DSH_HOME` → `~/.dsh`）                                                                                   |
| 提示词注入段        | `ctx.systemPrompt.section(`：`tavern:card`、`tavern:wb`、`tavern:nsfw`（**order: -1**）、`tavern:memory`、`tavern:relations`、`tavern:skills` |
| 体积快照          | `flushPromptStats()`（**必须每条返回路径都调用**）、`sectionSizes`                                                                                  |
| HTTP 路由       | `ctx.webServer.register(`、`/api/tavern/`                                                                                              |
| 预设 CRUD / 声明  | `writePresetFiles`、`agent.cordis.yml`、`prefix:`（**不是 `text:`**）、禁止 `complete: true`                                                   |
| 世界书           | 关键词触发匹配、`injectMode`（full / keyword）                                                                                                  |
| 记忆 / 总结       | `buildSummaryPrompt`、`callLLM`、`parseSummaryOutput`                                                                                   |
| 关系网           | 关系数据落库 + 渲染数据来源（**来自模型输出，见 §5.1**）                                                                                                    |
| 技能生成          | `SKILL.md` 生成                                                                                                                         |
| 设置页（自渲染 HTML） | 搜 `<button id=`；**已全部改 `addEventListener`，零内联事件**                                                                                     |
| 测试导出          | `_test`                                                                                                                               |

### 客户端 `lib/client.manager.bundle.js`

| 功能           | 搜索关键字                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| 面板 markup    | `function panelHTML(`（12 张一级卡片，每张有 `data-tv-tab`）                                 |
| 页签引擎         | `installPanelTabs()`、`TAB_DEFS`、`TAB_TAIL_RULES`、`tabKeyForTitle`、`tabKeyForTail` |
| 页签自检         | `data-tab-unclaimed`（未归类卡片会被点名且保持可见）                                              |
| 转义（**安全关键**） | `function esc(`、`function escAttr(`（`escAttr` 现在是 `esc` 的别名）                      |
| 关系网渲染        | `renderRelationsGraph`、`renderLargeGraph`（**两个函数都要转义**）                           |
| 面板各卡片        | 世界书 / 预设 / 会话绑定 / 生效范围 / 记忆 / 故事背景 / 写作辅助 / 回复体检                                  |
| 设置页样式        | `#tavern-manager` 作用域下的 CSS 字符串                                                   |

---

## 4. 分阶段计划与验收标准

| 阶段                  | 内容                                                                                                                                                                                                          | 验收                                                                   | 风险                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| **S1 收尾**（半天）       | ① 改掉 §2.5 那条旧规矩 + 校准 `AGENTS.md`/`CLAUDE.md` 版本与包名 ② `CHANGELOG.md` 归档（拆 `docs/archive/CHANGELOG-2025.md`）③ 历史文档归档到 `docs/archive/`（`AUDIT-功能体检.md`、`ROOT_CAUSE_报告.md`、`RELEASE_NOTES_*`、旧的 `HANDOFF-*.md`） | 434/434 全绿；仓库根只剩必须的文档；无代码改动                                          | 极低                     |
| **S2 服务端分层**（1–2 天） | `lib/index.js` → `lib/server/{state,presets,bindings,inject,routes/memory,relations,skills}.js`，`apply(ctx)` 只做装配                                                                                           | 每个文件 `node --check`；**434/434 全绿且不改任何测试**；`prompt-stats.json` 输出结构不变 | 中（提示词组装是核心链路，改动必须逐段验证） |
| **S3 前端结构化**（2–4 天） | ① 引入 §6 的令牌层与基元（**只加不删**）② 逐卡片把内联样式/裸 hex 换成令牌 ③ 前缀统一                                                                                                                                                       | `check:style` 通过**且指标显著下降**（预算可下调）；`panel-tabs` 全绿                   | 中（视觉回归只能靠人眼 + 预算数字）    |
| **S4 护栏**（与 S2 并行）  | ① 实现"自检三件套"（见 §6.3）② 把"扫源码字符串"的断言逐步换成行为/结构断言                                                                                                                                                                | 新工具自身有测试（含"用坏样本必须报错"的非空跑对照）                                          | 低                      |

**顺序建议：S1 → S4①（先有安全网）→ S2 → S3。**

---

## 5. 不可回归的不变量（改完必须自证）

1. **渲染转义**：`esc` 必须吃掉 `& < > " '` 五个字符；`escAttr` ≡ `esc`；关系网**所有**模型字段（`e.source`/`e.target`/`n.label`/`e.label`/`ed.label`/邻居名）必须转义；世界书正文/名称/关键词必须转义。  
   → `tests/render-escape.test.js`（7 项，含"用旧实现必须失败"的反例）  
   背景：**这是一条真实的高危漏洞的修复**（issue #14：模型输出 → innerHTML，可偷 agent 控制权），别再退回去。
2. **会话隔离**：角色卡/世界书/成人段只注入**已绑定**的会话；未绑定则不注入。  
   → `tests/native-preset-binding.test.js`、`memory-isolation.test.js`、`nsfw-slot.test.js`
3. **提示词组装**：`flushPromptStats()` 必须在**每条返回路径**上落盘（体积快照）；`tavern:nsfw` 的 `order: -1` 不要动。
4. **页签归属**：每张一级卡片必须有合法 `data-tv-tab`；声明值必须与标题前缀映射一致；未归类卡片要被点名**且保持可见**。  
   → `tests/panel-tabs.test.js`（11 项）
5. **样式预算**：`inlineHandlerAttr`（客户端）与 `inlineHandlerAttrServer`（服务端）**必须恒为 0**；`!important` 恒为 0；其余指标**只许降不许升**。  
   → `tests/style-budget.test.js`（8 项）
6. **预设 persona**：字段名必须是 `prefix:`；**禁止** `complete: true`（会把其它系统提示段整段压掉）。
7. **`DSH_HOME`** 解析优先级：显式配置 → `$DSH_HOME` → `~/.dsh`。

---

## 6. 可以直接借用的现成设计（来自 PR #13，`H2CO3w`）

本地工作区有完整 diff：`_scratch/pr13.diff`（2923 行，**不在仓库里**，需要的话先拷进仓库再删敏感内容）。

1. **第二层语义令牌 `--tv-*`**（该 PR 里 **107 处引用**）
   - 只映射官方 `--dsw-*`，**不自己造颜色**：`--tv-surface/-2/-3`、`--tv-float`、`--tv-text/-2/-3/-dim`、`--tv-line/-2/-3`、`--tv-accent`、`--tv-hover`、`--tv-active`、`--tv-ok/warn/err/idle`
   - 自建规模阶梯：`--tv-sp-1..8` = 2/4/6/8/12/16/24/32px；层级：`--tv-z-dropdown:10 / sticky:100 / mask:1000 / modal:1010 / float:1100`
   - 作用域 `#tavern-manager`，适配明暗主题只改这一块
2. **组件基元（约 18 个）**，数值对齐官方 primitives 实测值：  
   `.tv-btn`（`--primary/--ghost/--outline/--danger/--sm`，含 `:focus-visible` 焦点环用官方 `--dsw-focus-ring-*`）、`.tv-field`（统一 input/select/textarea）、`.tv-card`（去盒子、只留顶边）、`.tv-item`、`.tv-status`（`--ok/warn/err/idle`）、`.tv-divider`、`.tv-row`、`.tv-stack`、`.tv-list`、`.tv-alert`、`.tv-subsection`、`.tv-readout`、`.tv-check`、`.tv-select`、`.tv-select-btn`、`.tv-menu`、`.tv-dropzone`、`.tv-grow`
3. **"自检三件套"方法论**（该 PR **只写在提交信息里、没提交脚本**，需自己实现）：
   - **悬空 id 扫描**：JS 里 `getElementById`/`querySelector('#…')` 引用的 id 与 markup 里的 id 取差集（并与上游对比，区分"新引入"与"既有"）
   - **标签配平**：把 markup 字面量拼起来做栈式配对（含 void 元素白名单）
   - **卡片嵌套深度**：确认所有一级卡片都在 depth=1，没有被容器误吞
4. **样式预算工具**：该 PR 的方案我们已经落地并**加强**了（多了服务端维度与两条硬 0 规则）。它的 `style-budget.json` 里每个指标带 `why:` 说明，值得学（我们目前没有）。

---

## 7. 已知陷阱（今天踩过的，别重复）

1. **绝不用 PowerShell 做含中文/emoji 的字符串手术**：传参会乱码，甚至把脚本写出语法错误（本会话踩了两次假阴性、两次脚本损坏）。**一律写 Node 脚本**（用 write 工具写文件，别用 `-e` 拼字符串）。
2. **不要按行号做锚点**：行号会漂。用**唯一子串 + 命中次数校验**（`split(a).length - 1 === 1` 才改），并让脚本在写盘前做自检。
3. **GitHub 推送**：`github.com:443` 不稳定 → 走 `api.github.com`（blob → tree → commit → PATCH ref），**每次都要比对本地 tree 与远端返回 tree**。  
   多提交一起推时，**`LOCAL_BASE` 必须选"远端已存在的那个提交"**，否则树不一致（今天因此失败过一次）。
4. **npm 发布后有 35 秒 ~ 2.5 分钟 CDN 传播期**：抓包要先验 gzip 魔数 `1f 8b` 再 `gunzip`，否则会报 `incorrect header check`。
5. **会话日志是 zstd 压缩**，不要解析、不要改写。
6. **测试的 `test` 脚本是 `&&` 长链**：第一个红项会掩盖后面的失败 → 用 `tools/run-each-test.mjs`。

---

## 8. 发布流程（照抄）

- 推送+发版脚本样例：`_scratch/ship-2.7.1-push.mjs`（改 3 个常量：`V`、`LOCAL_BASE`、`REMOTE_PARENT`）
- 凭据：从用户会话日志里提取（`_scratch/find-tokens.py` → `%TEMP%\dsh-tokens.json`）；**用完立刻删除**；绝不写入仓库或 `.git/config`
- 发布后必做的体检：文件数 / 不含 `tools/`、`tests/` / 无 token / `esc` 有单引号 / `data-tv-tab` 存在 / 内联事件为 0
- 版本号与 `CHANGELOG.md` 同步；GitHub Release body 直接取 CHANGELOG 对应段落

---

## 9. 遗留项（不阻塞重构，但要知道）

- **还有 1 处装饰 emoji**：`✏️ 手动输入` 单选标签。它有文字、emoji 只是装饰，**未清**（状态栏解析依赖的 `👤`/`⏰` 等属于预设格式契约，更不该动）。
- **`edited-messages.json`**（用户数据）已不再被任何代码引用 —— 文件保留，未删。
- 服务端设置页的 8 处内联事件已全部改为 `addEventListener`；`writeSessionLines()` 已删除，注释里留了警示。
- 历史文档散在根目录（`AUDIT-功能体检.md`、`ROOT_CAUSE_报告.md`、`HANDOFF-会话绑定修复.md`、4 个 `RELEASE_NOTES_*`），建议 S1 归档。
- `compatibility.json` 里 `dsh-tavern@2.5.0 / 2.5.2` 的豁免项在新版本上已不需要（新 peerDeps 直接含 `^0.2.0-rc.2`），可清理。

---

## 10. 开工前请先确认

1. **§2.5 的旧规矩**（"不要拆 index.js"）你已获授权修改 —— 这条必须先改，否则算违规。
2. **S2 拆分后，测试是否允许改动**：目前 434 项里有相当一部分是"扫源码"断言，拆分会让它们大面积失效。建议**先做 S4①（安全网）再拆**，否则你会在"改完一片红"里失去判断力。
3. 用户在用这个插件（npm 有下载、市场有收录），**每个阶段都必须保持可发布、可回滚**（每阶段一个版本号 + CHANGELOG）。
