# dsh-tavern 项目规范（给 AI 助手看）

> 本文件是给 AI 编程助手看的**唯一规范源**。修改代码前请先读完。
>
> ⚠️ **如果你是从别处（IDE 规则、交接文档、旧记忆）得到的规矩，以本文件为准。**
> 曾经的「服务端逻辑全部集中在 `lib/index.js`，不要新建拆分子模块文件」**已于 2.7.3 作废** ——
> 见 §5「服务端分层」。那条规矩正是把 index.js 堆成巨型单文件的原因。

- **包名**：`dsh-tavern`（**不是** `@local/dsh-tavern`）
- **版本**：2.7.16
- **模块系统**：ES Modules（`import` / `export`，禁止 `require` / `module.exports`）
- **服务端入口**：`lib/index.js`（分层进度见 §1 结构图 / §5；**行数与模块数一律不写进文档**，手抄必漂）
- **客户端入口**：`lib/client.manager.bundle.js`
- **直接 Install 方式**：npm `dsh-tavern`（用户已在使用，市场有收录）

> 📌 **规范只有这一份真源。** `CLAUDE.md` 与 `.cursorrules` 现在只是指向本文件的短指针。
> 历史上三者是同一份内容的三份拷贝，结果两处漂移成了过期版本号，教训在此：**不要再把规则复制到第二个文件**。

---

## 1. 项目结构（2026-10-07 实测）

```
dsh-tavern/
├── lib/
│   ├── index.js                     # 服务端入口 ★ 仍在分层中，见 §5
│   ├── server/                      # ★ 已从 index.js 整块搬出的服务端模块（2.7.4 起）
│   │   ├── assemble.js              #   tavern:card 段正文组装（apply 只留装配 + 体积快照/观测），见 §5.1
│   │   ├── state.js                 #   ★ 可变运行时状态 S + 路径镜像 P / syncPaths()，见 §5.3
│   │   ├── constants.js             #   跨模块共享常量
│   │   ├── util.js                  #   无状态纯工具
│   │   ├── zstd.js                  #   zstd 多帧解压垫片
│   │   ├── text.js                  #   文本清洗 / 角色卡正文提取
│   │   ├── prompt.js                #   注入闸门 + 体积预算
│   │   ├── worldbook.js             #   世界书 v2 格式 + 条目选择
│   │   ├── preset-decl.js           #   预设声明块渲染与修补
│   │   ├── presets.js               #   预设组合判据（S2-C 继续扩充）
│   │   ├── bindings.js              #   绑定来源分类 / 活动会话探测
│   │   ├── skills.js                #   skill 命名与 frontmatter
│   │   ├── summary.js               #   总结生成：提示词 / LLM 调用 / 解析 / 拒答
│   │   ├── session-log.js           #   会话历史定位与 zstd 读取
│   │   ├── session-read.js          #   会话历史直读
│   │   ├── session-migrate.js       #   会话/预设一次性迁移
│   │   ├── state-io.js              #   状态写入与目录准备
│   │   └── dsh-conn.js              #   DSH settings + credentials 解析
│   ├── client.manager.bundle.js     # 客户端 ★ **单文件即源码，没有构建步骤**，直接改它
│   ├── utils.js                     # 纯函数工具
│   └── client.js                    # 客户端加载壳
├── tests/                           # 测试（`npm test` 逐文件跑；数量以输出为准，别手抄）
├── tools/
│   ├── assert-style-budget.mjs      # 样式预算棘轮（check:style）
│   ├── style-budget.json            #   样式预算基线
│   ├── check-client-integrity.mjs   # 自检三件套：悬空 id / 标签配平 / 卡片深度，见 §10
│   ├── check-innerhtml-escape.mjs   # innerHTML 转义棘轮（check:innerhtml）
│   ├── innerhtml-baseline.json      #   转义棘轮基线（只许减不许增）
│   ├── check-syntax.mjs             # 全仓语法检查（check；不 spawn 子进程）
│   └── run-each-test.mjs            # 逐文件跑测试 = `npm test`，见 §9
├── .github/workflows/check.yml      # CI：唯一的自动化强制点，见 §9
├── docs/
│   ├── issues/                      # 待决策议题留档
│   └── archive/                     # 历史文档归档区（不进发布包）
│       ├── CHANGELOG-pre-2.6.md
│       ├── AUDIT-功能体检.md / ROOT_CAUSE_报告.md / HANDOFF-会话绑定修复.md
│       ├── RELEASE_NOTES_v*.md
│       ├── _probes/                 # 一次性探针脚本（含绝对路径，勿照抄）
│       └── _legacy/                 # 根目录遗留的旧 client bundle 副本（78 KB，改了不生效）
├── CHANGELOG.md                     # 只留当前批次；更早的已归档
├── AGENTS.md                        # 本文件（唯一规范源）
├── CLAUDE.md / .cursorrules         # 指针文件
├── HANDOFF-重构交接.md              # 本次重构的工作交接（S2 起）
├── README.md / TUTORIAL.md / CONTRIBUTING.md
├── cordis.patch.yml
└── package.json
```

---

## 2. 模块依赖关系（无循环依赖）

```
钩子 + 装配        lib/index.js
                     ├── lib/server/{constants,util,zstd,text,prompt,
                     │              worldbook,preset-decl,session-log,
                     │              summary,dsh-conn}.js 等）  ← 已整块搬出（S2-A ~ S2-C1，单向依赖）
                     ├── lib/utils.js
                     └── 路由仍注册在 index.js（routes/ 尚未抽出，属 S2-C2）
HTTP API  ←────→  lib/client.manager.bundle.js（平台注入，经 ctx.webServer 与服务端通信）
tests/*.test.js ─→ lib/index.js 的 `_test` 导出 + lib/utils.js
tools/*.mjs      ─→ 只读源码做静态扫描（不 import 运行时）
```

> `index.js` 的 `apply(ctx)` 在 S2 之后应当**只做装配**：
> 解析 Home → 建状态 → 注册 inject 段 → 注册路由 → 注册生命周期。具体逻辑下沉到 `lib/server/*`。

---

## 3. 架构地图（按功能块定位，**不要按行号** —— 行号会漂）

### 服务端 `lib/index.js`

| 功能 | 搜索关键字 |
|---|---|
| Home 解析 | `resolveDshHome`（优先级：显式配置 → `$DSH_HOME` → `~/.dsh`） |
| 提示词注入段 | **实际只有 2 个** `ctx.systemPrompt.section(`：`tavern:card`（`order: -999999`）与 `tavern:nsfw`（**order: -1**）。<br>§3 早先版本把 `tavern:wb` / `tavern:memory` / `tavern:relations` / `tavern:skills` 也列成独立段 —— **那是错的**（2026-10-08 实测：`grep systemPrompt.section` 只有 2 处）。<br>其余内容全部**拼进 `tavern:card` 的 `cardOut`**（组装步骤已下沉到 `lib/server/assemble.js`，见 §5.1）：<br>`sanitizePromptText(summaryText + header + text + wbText + memoryText + styleText + netText + toolsRestriction + relationsText + skillsText)`<br>⚠️ 其中 `summaryText` / `memoryText` 来自 `readSessionMemory()`，**是模型输出、且原样进系统提示**；`relationsText` 只含计数（见 `buildRelationsHintText`）。 |
| 体积快照 | `flushPromptStats()`（**必须每条返回路径都调用**）、`sectionSizes` |
| HTTP 路由 | `ctx.webServer.register(`、`/api/tavern/` |
| 预设 CRUD / 声明 | `writePresetFiles`、`agent.cordis.yml`、`prefix:`（**不是 `text:`**）、禁止 `complete: true` |
| 世界书 | 关键词触发匹配、`injectMode`（full / keyword） |
| 记忆 / 总结 | `buildSummaryPrompt`、`callLLM`、`parseSummaryOutput` |
| 关系网 | 关系数据落库 + 渲染数据来源（**来自模型输出**） |
| 技能生成 | `SKILL.md` 生成 |
| 设置页（自渲染 HTML） | 搜 `<button id=`；已全部改 `addEventListener`，**零内联事件** |
| 测试导出 | `_test` |

### 客户端 `lib/client.manager.bundle.js`

| 功能 | 搜索关键字 |
|---|---|
| 面板 markup | `function panelHTML(`（12 张一级卡片，每张有 `data-tv-tab`） |
| 页签引擎 | `installPanelTabs()`、`TAB_DEFS`、`TAB_TAIL_RULES`、`tabKeyForTitle`、`tabKeyForTail` |
| 页签自检 | `data-tab-unclaimed`（未归类卡片会被点名且保持可见） |
| 转义（**安全关键**） | `function esc(`、`function escAttr(`（`escAttr` 现在是 `esc` 的别名） |
| 关系网渲染 | `renderRelationsGraph`、`renderLargeGraph`（**两个函数都要转义**） |
| 面板各卡片 | 世界书 / 预设 / 会话绑定 / 生效范围 / 记忆 / 故事背景 / 写作辅助 / 回复体检 |
| 设置页样式 | `#tavern-manager` 作用域下的 CSS 字符串 |

---

## 4. 客户端 bundle 是源码，**没有构建步骤**

> 旧文档说「客户端是打包文件，修改源码后需要重新打包」—— **这句话是错的，已删。**
> `lib/client.manager.bundle.js` 就是发货源码，可以直接改。

- 可以直接修改它；**不要**引入构建步骤却不同步改发布流程（`package.json.files`、npm 发布、市场更新都会跟着变）。
- ⚠️ 仓库里还有一个 `docs/archive/_legacy/client.manager.bundle.js`（78 KB 旧副本），**那是遗留占位，改了不生效**。

---

## 5. 服务端分层（2.7.3 起的新规矩，取代旧的自包含条款）

**允许并且鼓励**把 `lib/index.js` 拆成 `lib/server/` 下的多个模块。拆分时的硬要求：

1. **先有安全网再动刀**：见 §10 自检三件套。这类改动会让一批「扫源码字符串」的测试大面积报红，
   没有安全网就会失去判断力。
2. **逐段搬家，不要整文件重排**：每次只搬一个功能块，搬完立即跑 §9 的全量测试。
3. **不许改用户可见行为**：灰度口径就是「测试不能改」+「`prompt-stats.json` 输出结构不变」。
4. 每个新文件都要过 `node --check`。
5. 禁止循环依赖：`lib/server/*` 只允许依赖更底层的模块（`state` / `utils`），不允许反向 import `index.js`。
   **推论**：某个常量若同时被「搬走的函数」和「留守的函数」用到，它必须先下沉到 `lib/server/constants.js`
   —— 否则搬走的那边只能反向 import `index.js`，直接违反本条。

### 5.1 有一批函数**不许搬出 `lib/index.js`**（2.7.4 实测）

几个测试会**按行切片** `lib/index.js` 的源码，把函数体拼成独立模块求值
（`memory-isolation` / `session-storage-migration` / `greeting-seed`）。被切的函数必须：

- 以 `function <名>(` 顶格声明、以顶格 `}` 收尾（`sliceFn` 就这么找的）；
- **只依赖 `fs` / `path` / 彼此** —— 一旦引用了被搬走的函数，独立模块里就是 `ReferenceError`。

当前钉住的名单（改名前先回来核对）：

> ✅ 这份名单已有**机器护栏**：`tests/slice-anchors.test.js`。它会反推所有 `sliceFn('…')` 目标，
> 一旦某个被切片的函数被搬走、改名、或不再是**顶格** `function X(`，立刻报红；
> 名单落后于事实（有函数被钉住却没在上表点名）同样报红。

| 来源测试 | 钉住的函数 / 代码块 |
|---|---|
| `memory-isolation` | `readPresetsMeta` `getPresetDir` `memoryFile` `sessionDir` `sessionMemoryFile` `readSessionMemory` `readMemory`，以及 `let ROOT = path.join(DSH_HOME, '.agent-presets')` → `const DEFAULT_PRESET_DIR` 这段常量块 |
| `session-storage-migration` | `migrateSessionStorageOutOfPresetRoot` `appendSessionMemory` `readSessionMemory` `readSessionRelations` `sessionDir` `sessionMemoryFile` `sessionRelationsFile`（另带动 `hasCardGreeting` `pickGreetingCard` 不许搬） |
| `greeting-seed` | `appendGreetingToSessionEnd` `insertGreetingForSession` `canAppendGreetingSurface` |
| `memory-isolation`（总结棒） | 源码里必须有字面量 **`const targetSid = lastSessionId`**（禁止异步回调里再读全局），且不许出现 `runSummary(ctx, st2, lastSessionId,` ⇒ `lastSessionId` **不能改名、不能收进 state.js** |
| `nsfw-slot` ⑪ / `core` P0-6 | **`readState`** —— 函数体里含默认 state 字面量 `nsfwEnabled: false, nsfwPrompt: ''`，搬走立刻报红 |
| `greeting-seed` | **`armLiveAgents`** —— 测试按 `function armLiveAgents(` 切片它 |
| `core` P0-6 / `nsfw-slot` ⑪⑫ | `apply` 内 `tavern:nsfw` 注册段（须含 `isTavernSession(` `decideInjectionScope(` `order: -1`）、`flushPromptStats(); return ''`、`sectionSizes.nsfw = body.length` |
| `inject-observe` [12] | `apply` 内 `try { observeInjection({…}) } catch {}` 与 `writeInjectObserveRecord` 的静默 try/catch |
| `memory-isolation` | `apply` 内 `★ 记忆总结注入` 块（到 `} catch {}` 为止） |

> ⚠️ **S2-C2 已搬走的那半边**：`tavern:card` 的**正文组装**现在在 `lib/server/assemble.js`
> （`assembleCardBody(deps)`，依赖全部显式传参、不反向 import `index.js`）。上表这些块**不在**
> 被搬走的范围内 —— 记忆总结块、`tavern:nsfw` 段、`observeInjection` 观测点都留在 `apply(ctx)` 里。

### 5.2 两个差点咬人的坑（搬代码块时必看）

1. **别用「第一个顶格 `}`」判断函数结尾**。源码里有缩进错的闭合括号
   （`normalizeName` 的 `for` 循环 `}` 是顶格写的），还有正则字面量里带 `\{`
   （`parseStagePlans` 的 `condRe`）—— 两种都会让朴素扫描把函数拦腰截断。
   正确做法：括号配平 + **把每个抽出的块单独 `node --check`**（截断必然报语法错）。
   可复用的边界表生成器在 `_scratch/s2-ends.mjs`，验收脚本 `_scratch/s2-verify.mjs`。
2. **搬函数时别连「分节的说明注释」一起搬**。`// ── DSH home 解析 ──` 下面那段注释同时服务于
   留下来的 `resolveDshHome`，整块吃掉会让留守函数失去说明。

### 5.3 可变状态怎么给 `lib/server/*` 用（2.7.8 定型）

`lib/server/state.js` 是唯一的收纳容器，分两块，规则不同：

| | 内容 | 规则 |
|---|---|---|
| `S` | `playerName` / `activePluginCtx` / `builtinDirsCache` / `_bindingsCache` / `_bindingsDirty` / `promptStatsFlushedAt` | 已经**完全搬进去**了 —— 全仓只认 `S.xxx`，没有第二份 |
| `P` | 9 个路径（`ROOT` / `SESSIONS_ROOT` / `STATE_PATH` …） | **镜像**。真源仍是 `index.js` 顶层那 9 个 `let`（切片锚点，搬不走） |

`P` 的三条铁律（有护栏盯着）：

1. **唯一写入点是 `syncPaths()`**，全仓只有两处调用：`index.js` 模块初始化时 + `bindDshPaths()` 里。
2. **`lib/server/*` 不许直接改 `P`**（`P.ROOT = …` 一律拒绝）—— 那会让真源与镜像脱钩。
3. **不许在 `bindDshPaths()` 之外给那 9 个 `let` 赋值**。

> ⚠️ 镜像调用**不能**插在 `let ROOT = …` 与 `const DEFAULT_PRESET_DIR` 之间：
> 那段是 memory-isolation 的切片范围（两端都含），插进去会让独立模块引用到未定义的 `syncPaths`。

护栏：`tests/server-state-paths.test.js`（含反证）。

---

## 6. 不可回归的不变量（改完必须自证）

1. **渲染转义**：`esc` 必须吃掉 `& < > " '` 五个字符；`escAttr` ≡ `esc`；关系网**所有**模型字段
   （`e.source` / `e.target` / `n.label` / `e.label` / `ed.label` / 邻居名）必须转义；世界书正文/名称/关键词必须转义。
   → `tests/render-escape.test.js`（每项都配「旧实现必须失败」的反例）
   背景：**这是真实高危漏洞的修复**（issue #14：模型输出 → innerHTML，可偷 agent 控制权），别再退回去。
2. **会话隔离**：角色卡 / 世界书 / 成人段只注入**已绑定**的会话；未绑定则不注入。
   → `native-preset-binding.test.js`、`memory-isolation.test.js`、`nsfw-slot.test.js`
3. **提示词组装**：`flushPromptStats()` 必须在**每条返回路径**上落盘；`tavern:nsfw` 的 `order: -1` 不要动。
4. **页签归属**：每张一级卡片必须有合法 `data-tv-tab`；声明值须与标题前缀映射一致；未归类卡片要被点名**且保持可见**。
   → `tests/panel-tabs.test.js`
5. **样式预算**：`inlineHandlerAttr`（客户端）与 `inlineHandlerAttrServer`（服务端）**恒为 0**；`important` 恒为 0；
   其余指标**只许降不许升**。→ `tests/style-budget.test.js`
   基线值**不写在这里**（写了必漂 —— 反例：本节曾手抄一组值，S3 一改样式就全过期）：
   一律查 `tools/style-budget.json`（现状）或跑 `npm run check:style -- --json`。
6. **转义只有一套实现**：所有 HTML 转义都必须走 `esc()`（客户端 `client.manager.bundle.js` L12）。
   `escapeHtml` / `htmlEscapeStr` / `escAttr` 都只允许是它的**薄封装**（`return esc(s)`）。
   **禁止**再写第二套 `replace(/&/g,'&amp;')` —— 第二份实现迟早会漂（`escAttr` 曾漂成空操作、
   `htmlEscapeStr` 曾漏掉单引号，两次都真发生过）。→ `tests/innerhtml-escape-ratchet.test.js` ⑦
7. **`innerHTML` 裸拼只许减不许增**：判据不看变量名 —— `.innerHTML` 右边按顶层 `+` 分段，
   逐段要求「字面量 / esc 函数族 / 含 esc 的 map·join 链 / `.length`·`.count` / 两支都是字面量的三元」。
   → `tools/check-innerhtml-escape.mjs`（`npm run check:innerhtml`）+ `tests/innerhtml-escape-ratchet.test.js`
   基线条数**不写在这里**（写了必漂）：跑 `npm run check:innerhtml` 看输出。
   **为什么单列一条**：`render-escape.test.js` 的 ③ 是按**变量名写死**的模式，对「新建一条渲染路径」是盲的；
   而"合并两个渲染函数""抽统一拼装 helper"恰恰最容易漏掉某一路来源（PR #13 真实翻车：转义了
   `e.source`/`e.target`，漏了 `label`）。**动渲染相关代码后必须跑这一条。**
   **基线三条铁律**：① 能彻底消掉的（在用处加 esc）不许留进基线；
   ② 每条必须带 `kind` + `why` + `mustContain` 证据，`unclassified` 直接判失败；
   ③ `mustContain` 是**每次都会复查的断言**（测试 ⑥）—— 证据失效即报红，别让它变成写给人看的注释。
8. **预设 persona**：字段名必须是 `prefix:`；**禁止** `complete: true`（会把其它系统提示段整段压掉）。
9. **`DSH_HOME`** 解析优先级：显式配置 → `$DSH_HOME` → `~/.dsh`。
10. **编码只覆盖 HTML 语境**：仓库里唯一的转义器 `esc()` 解决的是「HTML 文本 / 属性值」两个语境。
    **已知未覆盖的语境**（2026-10-08 实测当前代码；这里是**记账**，不是已发现漏洞）：
    - **URL 语境**：整份 bundle **没有**动态 `href` / `src`（实测命中 0 处）。将来若要加，
      注意 `esc()` 挡不住 `javascript:` 之类的协议走私 —— 那需要的是**协议白名单**，不是转义。
    - **CSS 语境**：`style="…"` 的动态插值**全部**是「双支都是字面量的三元」或**数值**
      （如 `bottomGap` / `panelW`），没有字符串数据进过 CSS。若将来要塞字符串，需要 CSS 转义。
    - **脚本语境**：完全没有 `<script>` 字面量。
    - **`srcdoc` 文档语境**：`iframe.srcdoc = sb.html`（muv-engine 状态栏）—— 内容来自
      `/api/muv-engine/status-bar` 返回的 HTML，那是**另一份完整文档**，`esc()` 在这里语义不同。
      当前缓解是 `sandbox="allow-scripts"`（**刻意没有** `allow-same-origin`）⇒ 不透明源，
      够不到主页面 DOM 与凭据。**改这个 iframe 时不要顺手加 `allow-same-origin`。**
    ⇒ 不要因为「过了 `esc`」就认为任意语境都安全。
11. **落库边界能一次覆盖两条出口**：`parseSummaryOutput` 的产物有**两条出口** ——
    ① 关系网字段（`nodes` / `edges` / `label` …）→ 客户端 `innerHTML`（XSS 路）；
    ② `summary` / `memory` 文本 → 系统提示段（提示词注入路）。
    两条出口**字段不重叠、但同源**（同一份模型输出 JSON），因此在落库前净化一次可同时覆盖；
    只在渲染端加 `esc()` 永远只护得住 ①。
    → 议题与最小方案：`docs/issues/2026-10-08-parseSummaryOutput-边界净化.md`
      （**已于 2.7.15 实施**：`lib/server/summary.js` 的 `sanitizeModelText` / `sanitizeRelations` 在落库前做
      字符级/标签/协议剥离；判据 `tests/summary-boundary-sanitize.test.js`。**更新前先读该议题文档**）。
    ⚠️ 别把它写成「关系网字段既进 innerHTML 也进提示词」：实测 `buildRelationsHintText()`
    往提示词里注入的**只有计数**（「本会话记录了 N 个角色 / N 条关系」），关系字段本身**不进**系统提示。
12. **没有第二道墙（既定前提）**：DSH 主 Web UI 页面**没有阻断性 CSP**。
    2026-10-08 实测：DSH `app.asar` 里的 CSP 命中逐条看过 —— 分别属于**媒体文件响应头**
    （`sandbox; default-src 'none'`）、**SVG 净化 meta**、以及**若干附属页的 meta**
    （其中一处是 `script-src 'unsafe-inline'`），**没有一条作用在主 UI 页面上**。
    而插件注入的脚本跑在**持有 DSH 本地 API 凭据**的那个源里（无凭据调 API 返回 401）。
    ⇒ **必须假设「转义是第一道、也是唯一一道防线」**，不要指望 CSP 兜底。
    这条前提一旦变化（DSH 给主 UI 加了 CSP），回来改这一条。
13. **CI 绿 ≠ 真机能跑**：`cordis-mount.test.js` 是唯一真的挂载插件的测试，而在没有 DSH 的机器上
   （含 CI）它 **4 项 skip 3 项**。所以「插件还能不能在真实 DSH 里加载并工作」这件事
   **CI 覆盖不到**，发布前必须走真机冒烟 → §9.1。这是结构性盲区，别指望靠改配置补上。

---

## 7. 红线（违反会出事）

1. **绝不改写 DSH 会话日志**。历史上有个 `writeSessionLines()` 会重写整份 zstd 会话（属于已删除的
   「编辑 AI 回复」功能），**已删**，`lib/index.js` 里留了注释警示，**不要再引入这类写法**。
   会话日志是 zstd 压缩的多帧格式，**不要解析、不要改写**。
2. **不要动 `~/.dsh` 下的用户数据**：`.agent-presets/`、`tavern-state.json`、`tavern-data/` 等。
   **测试一律用 tmpdir**。
3. **仓库里不许出现**：本机绝对路径、token、会话 id、真实预设 id / 角色卡名。
   历史上清洗过一次真实用户标识（见归档 CHANGELOG 的 v2.5.5 隐私条目），别再引进来。
4. **换行符**：保留文件原有换行风格，**不要做整文件换行转换**。
   本仓库 `core.autocrlf=true` —— git 里存的是 LF，Windows 工作树检出成 CRLF，这属于正常现象。
   注意：所有按行扫描的工具/测试都**不**做 `\r` 归一，所以不要制造额外的混合换行。
   ★ **两个 lib 文件的行尾约定不一样**（2026-10-08 实测，别想当然）：
     - `lib/index.js` 和 `lib/server/*.js` → **CRLF**
     - `lib/client.manager.bundle.js` → **LF**（0 个 CRLF，全 LF）
     ★ 混合换行已有护栏：`tests/tooling-integrity.test.js` 会扫全仓文本文件，
       同一个文件里不允许既有 CRLF 又有裸 LF。新建文件时**照抄同目录邻居的换行符**。
     改哪个文件之前先确认它自己的行尾。另外 Git Bash 里 `grep -c $'\r$'` 在这上面会给出
     **假读数**（会把 LF 文件也报成全 CRLF）—— 用 node 数 `\r\n` 才准。
5. **不要整文件重排格式**（会淹没真实 diff）。改动越小越好审阅。
6. **`_scratch/` 不入库**（已写进 `.gitignore`）：里面放的是本地临时脚本，
   其中含「从会话日志提取 token」的性质，绝不能提交。用完即删。

---

## 8. 代码规范

### 8.1 命名
- 函数名：小驼峰 `camelCase`（`readPresetFiles`）
- 常量：大写下划线 `UPPER_SNAKE_CASE`（`DEFAULT_PRESET_ID`）
- 文件名：小写下划线或短横线（`preset-manager.js`）

### 8.2 函数
- 优先纯函数；有副作用的函数（写文件 / 改状态）要明确命名
- 每个函数只做一件事，超过 50 行考虑拆

### 8.3 错误处理
- 文件操作必须 `try/catch`
- Promise 必有 `.catch()`；**禁止在 Promise 回调里 `throw`**（会导致进程崩溃）
- 错误信息要带上下文

### 8.4 注释
- 复杂逻辑必须加注释；模块顶部加 JSDoc；公共导出加参数说明
- 改动 yaml 以外的文件时，注释里**不要写本机路径**

---

## 9. 测试与验证

| 用途 | 命令 |
|---|---|
| **跑全量测试** | `npm test`（= `node tools/run-each-test.mjs`，逐文件独立判红） |
| 只跑某类 | `node tools/run-each-test.mjs panel` |
| **语法检查（全仓）** | `npm run check`（= `node --experimental-vm-modules tools/check-syntax.mjs`） |
| 客户端语法 | `npm run check:client` |
| 样式预算 | `npm run check:style`（= `node tools/assert-style-budget.mjs`） |
| 客户端自检三件套 | `npm run check:integrity`（= `node tools/check-client-integrity.mjs`） |
| innerHTML 转义棘轮 | `npm run check:innerhtml`（= `node tools/check-innerhtml-escape.mjs`） |
| **CI（唯一的强制点）** | `.github/workflows/check.yml`，push / PR 自动跑上面这几条 |
| **本地复现 CI** | `npm run ci:local` —— 与工作流**同一组命令、同一顺序**（有护栏 ④-d 强制一致） |
| **行为等价（差分）** | `tests/golden-prompt.test.js` —— 与**重构前那一版**的产物逐字节比；边界（豁免清单）见 `docs/VERIFICATION.md` |

- **测试清单不手抄**：`npm test` 直接扫 `tests/*.test.js`，新增测试文件自动纳入。
  2026-10-08 实测：旧的 `scripts.test` 是一条**手抄的 `&&` 长链**，漏掉 3 个文件
  （含 `render-escape.test.js` 这个 issue #14 的安全回归）—— 也就是说「`npm test` 全绿」
  并不代表安全不变量真的跑过。同一批改动里 `scripts.check` 也只引用了少数文件，
  现已改成扫目录的 `tools/check-syntax.mjs`。
- **不要手抄数字**：本文件曾在同一节里同时存在 22 / 23 / 25 三套口径。
  验证基线一律以 `npm test` 的**输出**为准；文档里禁止再写「N 个文件 / N 项」。
- ⚠️ **空跑即失败**：`tools/run-each-test.mjs` 把「`pass=0` 且 `fail=0`」判为**失败**（标 `❔`），
  因为那说明该文件一条断言都没跑（被清空、或被注释掉、或子进程压根没起来）。
  受限环境里 spawn 失败（EBUSY）也会落到这一档 —— **看到 `❔` 说明环境有问题，不是通过**。
  免费送出来的绿灯比红灯更危险。
- **CI 环境 = 干净 checkout + 没有 DSH**。实测（2.7.12）：语法检查 54 文件通过，样式预算 / 客户端自检 /
  innerHTML 棘轮 exit 0，全量测试全绿（**数量以 `npm test` 输出为准 —— 曾在这里手抄 481，
  而那是更早一个提交上的数：同一个提交链里 tooling-integrity 从 11 项长到 15 项，数字当场过期**）。
  那 3 个 skipped 是
  `cordis-mount.test.js` 找不到 DSH 的 `app.asar` 时**自己 skip**（4 项里 skip 3 项，剩 1 项照跑）——
  合法跳过，空跑判据不会误报。
- **CI 自己也有护栏**（`tests/tooling-integrity.test.js` ④-b/④-c/④-d）：每条 `run:` 必须能映射到
  `package.json` 的脚本、不许出现 `continue-on-error` / `|| true`、`ci:local` 必须与工作流同命令集。
- ✅ **两条历史已接续**（2.7.12，merge commit `3a24a77`）：本地 `main` 与 `origin/main` 此前是
  **两条平行历史**（远端那批是当年用「API 重建 blob→tree→commit」推的 ⇒ 同内容不同 SHA），
  共同祖先只到 `2cea581`；现在用 `-s ours` 把对方接为第二父提交（**零内容变化**，
  依据是两个提交的 `^{tree}` 同为 `85390b25…`）⇒ **`git push origin main` 现在是 fast-forward**，
  不需要分支、也不需要 force。
  为什么要记这段：普通 3-way merge 在本仓会**在 7 个文件上假冲突**（同内容不同 SHA 造成的），
  手工解一遍纯属浪费时间且有出错风险。
- ✅ **CI 已实跑绿**（2026-10-08）：分支 `ci/tooling-security-refactor` @ `87f5b6e`，
  [run 37725561712](https://github.com/chen731215-dev/dsh-tavern-v2/actions/runs/37725561712) —— **5 个实质步骤全过**（GitHub 记为 11 步，含 Set up job / Complete job 等收尾步），约 70 秒。
  也就是说「重构等价」不再只有本机证据。
- **看 CI 结果**：`node tools/ci-watch.mjs`（盯最新一次）或 `node tools/ci-watch.mjs <run-id>` ——
  匿名读 API，不需要 token；退出码 0 = success。红了会逐 step 列出结论，便于定位。
- 跑测试前有时需要 `DSH_ASAR`（指向 DSH 的 `app.asar`），`cordis-mount.test.js` 依赖它；
  找不到时那个文件会**自己 skip**（不当红灯），所以 CI 不需要装 DSH。

### 9.1 发布前真机冒烟（**CI 覆盖不到的那一环**）

`cordis-mount.test.js` 是**唯一真的把插件挂进 DSH** 的测试。CI（以及任何没有 DSH 的机器）上它
是 **4 项 skip 3 项**（那 3 项就是「真挂载」那部分），所以：

> **CI 绿 ≠ 插件能在真 DSH 里加载并工作。** 这是结构性盲区，不是配置问题 ——
> 让 CI 装上 DSH 不现实，所以这一环**只能由真机确认**。

发布前按顺序做两步：

1. **半自动的那步**（有 DSH 的机器上）——确认「能挂载」：
   ```
   node --test tests/cordis-mount.test.js      # 期望 4 项全过；若摘要里出现 skipped 3 ⇒ 这台机器没 DSH
   ```
   有 DSH 时应是 `pass 4 / skipped 0`；若仍是 `skipped 3`，先设 `DSH_ASAR` 指向 DSH 的 `app.asar`。
2. **手动那步**（真机 UI 冒烟，四条）：
   - [ ] 面板能打开（设置页里酒馆面板正常渲染，无空白/报错）
   - [ ] 预设列表正常（列出、切换、名称显示正确）
   - [ ] 切预设**不串台**（切完新会话/当前会话绑定的是刚选的那个预设，不是上一个）
   - [ ] 记忆与关系网**正常注入**（总结/记忆段落进提示词，关系网按既有行为渲染）

**证据要留痕**：在做发布的那次 CHANGELOG 条目里写一行「真机冒烟：通过（版本 / 日期）」——
否则半年后没人知道到底跑没跑过，跟 CI 的「静默不跑」是同一类问题。

### 9.2 行为等价的 golden 差分（`tests/golden-prompt.test.js`）

「逐行对账 + 全量测试通过」**只是必要不充分**：文本对得上只说明没抄错，而重排代码最容易破坏的
恰恰是**没有断言的那些行为**。所以另有一层证据：

- `tests/fixtures/golden-prompt.json` 是**在重构前那一版（`a816afd`）上生成的**产物快照；
- 测试在当前版本上重跑同一组固定 fixture，要求**逐字节一致** ⇒ 任何一处组装语义被改坏，立刻报红。

⚠️ **它有明确的边界**：`apply(ctx)` 内部的真实组装**另有一张网**（`tests/golden-host-assembly.test.js`，
S2-C2 抽装配前补上；随后那段组装被抽进 `lib/server/assemble.js`，要求产物逐字节不变）、
`prompt-stats` 的数值、UI 交互、时序并发、LLM 失败路径 —— 后四项不在覆盖范围内，
豁免清单写在测试文件的 `EXEMPT` 常量里并有护栏防它缩水。**不要把它当成「全覆盖」。**

真机那一环仍见 §9.1；历次「变异 → 报红」的对照记录见 `docs/VERIFICATION.md`。

---

## 10. 重构阶段地图（含当前进度）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **S1 收尾** | 改旧规矩 / 校准文档 / 历史文档归档 / CHANGELOG 拆分 | ✅ **2.7.3 完成** |
| **S4① 安全网** | 自检三件套：① 悬空 id 扫描 ② 标签配平 ③ 卡片嵌套深度 | ✅ **2.7.3 完成**（`tools/check-client-integrity.mjs` + `tests/client-integrity.test.js`） |
| **S2-A 服务端分层** | 搬「闭包干净、无可变状态」的函数 → 建起 `lib/server/` 骨架 | ✅ **2.7.4 完成** |
| **S2-B1** | 再搬一批函数/常量，建起 `bindings` / `skills` / `presets` | ✅ **2.7.5 完成** |
| **S2-B2a** | 非路径可变状态收进 `lib/server/state.js` 的 `S` | ✅ **2.7.7 完成** |
| **S2-B2b** | 路径 `let` 的单向镜像 `P` + `syncPaths()`，含路径镜像护栏 | ✅ **2.7.8 完成** |
| **S2-C1** | 搬出首批路径依赖函数（dsh-conn / session-read / session-migrate / state-io） | ✅ **2.7.8 完成** |
| **S2-C2** | 从 `apply(ctx)` 里抽出装配步骤，让它只做装配 | 🟡 **部分完成**：`tavern:card` 的正文组装已抽进 `lib/server/assemble.js`；**路由**注册仍未抽出（后半段另立） |
| **S3 前端结构化** | `--tv-*` 语义令牌层 + 组件基元，**只加不删** | ⬜ 待做 |

> 进度只看状态列的 ✅。**行数与个数一律不写进文档**（复核方 2026-10-08 的要求）：
> ① 它会漂 —— 同一提交链里 `tooling-integrity` 从 11 项长到 15 项，写在文档里的数字当场过期；
> ② 连「到底几行」本身都有两种口径 —— `wc -l`（数换行符）与 `split(/\r?\n/).length`（多算一个尾部空元素）差 1，
> 写进文档只会引来 ±1 的争论，而它不携带任何信息（要查就现跑 `wc -l`）。
> 护栏已覆盖这三类数字（`tests/tooling-integrity.test.js` ⑤）。`lib/server/` 的模块清单见 §1 结构图。
> 剩下的大头：`apply(ctx)` 里还压着**路由注册**（见 §2 依赖图末行），属 S2-C2 后半段。

**顺序建议：S1 → S4①（先有安全网）→ S2 → S3。**

> 📌 **接手的人从这里开始**：最新工作交接见 [HANDOFF-2026-10-08.md](./HANDOFF-2026-10-08.md)（现状快照 / 待办顺序 / 验证方法；规范本体仍以本文件为准）。

### 自检三件套（`tools/check-client-integrity.mjs`，已实现）

用法：`npm run check:integrity`。改完客户端 UI 后建议顺手跑一次。
1. **悬空 id 扫描**：把 JS 里 `getElementById` / `querySelector('#…')` 引用的 id，与 markup 里实际存在的 id
   取差集；并与上游对比，**区分「新引入」与「既有」**。
2. **标签配平**：把 markup 字面量拼起来做栈式配对（含 void 元素白名单）。
3. **卡片嵌套深度**：确认每张 `data-tv-tab` 卡片的层级与同级卡片一致，没有被容器误吞。
   （面板外面本来就包着 `#tavern-manager`，所以卡片天然是 depth=2；这里比的是**同级一致性**，而不是绝对层数。）

> 三个检查都带**空跑防护**：源码里明明有 `data-tv-tab` / 字面量 id 查询，却一个都没抓到时，
> 工具会判**失败**并提示「判据空跑」—— 免费送出来的绿灯比红灯更危险。

> 每个工具都必须自带「**用坏样本必须报错**」的非空跑对照测试 —— 否则等于没有护栏。

---

## 11. 提交规范

```
<type>: <简短描述>

<详细描述（可选）>
```

`type`：`feat` / `fix` / `refactor` / `docs` / `style` / `perf` / `chore`

**提交前清单**
- [ ] `npm run check` 通过（全仓语法，扫目录，不是只检查改的那个）
- [ ] `npm test` 全绿（逐文件独立判红；有红项会列出文件名）
- [ ] 改过客户端 UI 的话顺手 `npm run check:integrity`
- [ ] `npm run check:style` 通过，且预算指标**没有上涨**
- [ ] 没有引入循环依赖
- [ ] 没有把绝对路径 / token / 会话 id 写进仓库
- [ ] CHANGELOG.md 同步（用户可见改动）+ 版本号同步

**发布前清单**（不是每次提交，是每次发 npm / 合主线）
- [ ] §9.1 的真机冒烟：`cordis-mount` 在本机 `pass 4 / skipped 0`，且四条 UI 冒烟通过
- [ ] 冒烟结论写进该版本的 CHANGELOG 条目（版本 / 日期 / 结论）
- [ ] 发布后 35 秒 ~ 2.5 分钟是 CDN 传播期：抓包先验 gzip 魔数 `1f 8b` 再解压
- [ ] GitHub Release body 直接取 CHANGELOG 对应段落；发布包不含 `tools/`、`tests/`

---

## 12. 常见坑

- **Promise 中 throw 会导致进程崩溃**：用 `.catch()` 或返回错误响应。
- **`exports` 字段用字符串会报 "Cannot find package"**：必须是对象形式。
- **角色卡含 `{{user}}` 会报 "unknown prompt variable"**：需转义为 `\{\{user\}\}`。
- **删除预设后要清理会话绑定**：否则指向不存在的预设。
- **绝不用 PowerShell 对含中文/emoji 的字符串做手术**：传参会乱码，甚至写出语法错误的脚本
  （历史踩过两次假阴性、两次脚本损坏）。**一律写 Node 脚本**执行。
- **不要按行号做锚点**：行号会漂。用**唯一子串 + 命中次数校验**（`split(a).length - 1 === 1` 才改），
  并让脚本在写盘前后做自检。
- **不同 node 的测试摘要格式不一样**：较新的输出 `# pass N`，spec 报告器是 `ℹ pass N`。
  只解析一种的脚本会把**所有**文件读成 `pass=0` —— 而「全 0」在「只看 `fail===0`」的判据下等于**全绿**。
  两种都要认（`tools/run-each-test.mjs` 已如此），并且 `skipped>0` 不算空跑。
- **别用「字符窗口」定位代码**（`{0,220}` 这类）：窗口会被 `\r` 撑破 —— 本机工作树是 LF 时不报，
  干净 clone / CI（`core.autocrlf=true` ⇒ CRLF）上就假红。匹配前先 `.replace(/\r\n/g, '\n')`。
  ⇒ 同理：**验证要在「干净 checkout」里做**（`git worktree add --detach`），别只信本机工作树。
- **别用「自写壳」替代现成的 runner**：本仓曾出现一个自写的 bash 壳去替代 `tools/run-each-test.mjs`，
  结果**两次给出假数据**：① 壳里硬编码了主仓库路径 ⇒ 跑的是另一个目录；② `sed` 反向引用写成 `\3`
  而只有 2 个捕获组 ⇒ 全部解析成 0（假「空跑」）。**结论对不代表方法对**：现成 runner 已经处理了
  两种报告器格式（`# pass` / `ℹ pass`）与空跑判据，自己重写一遍只增加出错面。
- **`git merge -s ours` 使用规则**：它**无条件丢弃对方整棵树**，对「对方有没有新提交」是盲的。
  只允许用在「**tree 已证明相等**」的平行历史接续上，且用之前必须：`git fetch` 并验证
  `git merge-base --is-ancestor <远端 tip> HEAD` 为真。**默认用普通 merge**（代价是解假冲突，
  收益是不会静默丢东西）。
- **「npm 能 spawn、node 自己的 child_process 不能」是某些受限沙箱的属性，不是本仓/平台的属性**：
  在那种环境里 `spawnSync` 直接 EBUSY ⇒ runner 会把每个文件判成 `❔`（空跑）—— **看到满屏 ❔ 是环境问题**，
  不是「测试全绿」。`npm` 作为父进程时子进程正常，所以 `npm run check` / `npm run ci:local` 能跑通，
  `npm test` 不行。别把这条环境属性当成仓库属性写进任何结论。
- **行数/个数类护栏只管「现值型文档」**（AGENTS.md / CLAUDE.md / .cursorrules）：
  CHANGELOG 里的行数记的是**各次发布的当时状态** —— 条目一旦写下即冻结，不会漂，
  属历史记录，**不该被清掉**。两类要区分（复核方 2026-10-08 裁定）。
  反例：若对方在 GitHub 网页上直接改过文件（会产生树不同的提交），「tree 相等」的前提就不成立。
- **补丁脚本插入多行文本时，必须用目标文件自己的 EOL**：往 CRLF 文件里用 `\n` 插行会制造混合换行，
  护栏 ⑥（tooling-integrity）会当场报红。**这个坑本仓已踩两次**，两次都是"手写补丁脚本"造成的；
  写脚本时先探测：`const EOL = s.includes('\r\n') ? '\r\n' : '\n'`。
- **GitHub 推送**：`github.com:443` 不稳定时走 `api.github.com`（blob → tree → commit → PATCH ref），
  **每次都要比对本地 tree 与远端返回 tree**；多提交一起推时 `LOCAL_BASE` 必须是远端已存在的那个提交。
- **npm 发布后有 CDN 传播期**（约 35 秒 ~ 2.5 分钟）：抓包先验证 gzip 魔数 `1f 8b` 再 `gunzip`，
  否则会误报 `incorrect header check`。
- **发布包不含 `tools/` 与 `tests/`**（由 `package.json.files` 决定）；改 `files` 要同步改发布验证。

---

## 13. 遗留项（不阻塞，但要知道）

- 还有 1 处装饰 emoji：`✏️ 手动输入` 单选标签（有文字，emoji 只是装饰）。
  状态栏解析依赖的 `👤` / `⏰` 等属于预设格式契约，**不要动**。
- `edited-messages.json`（用户数据）已不再被任何代码引用，文件保留未删。
- `compatibility.json` 里 `dsh-tavern@2.5.0 / 2.5.2` 的豁免项在新版本上已不需要（新 peerDeps 直接含 `^0.2.0-rc.2`），可清理。
- 归档 CHANGELOG 末尾有一条 `## v3.0.0` 空标题（历史遗留，无正文），已在归档文件里标注，不动它。
- **`parseSummaryOutput` 落库边界净化**（安全·设计，**已于 2.7.15 实施**）：
  模型输出落库后被两条路消费 —— DOM（`relations[]` → innerHTML）与提示词
  （`summary` 正文 + 记忆正文 → `summaryText` / `memoryText` → 系统提示）。
  渲染层已防（2.6.1 + 2.7.9 棘轮），但**数据本身从没净化过**。
  ⚠️ 注意：关系网字段**没有**进提示词（`buildRelationsHintText` 只给计数），别搞错暴露面。
  详情见 [`docs/issues/2026-10-08-parseSummaryOutput-边界净化.md`](./docs/issues/2026-10-08-parseSummaryOutput-边界净化.md)
  —— 它是**行为变更**（会改动落库内容）；口径已定并落地（字符级/标签/协议剥离；只在写入时净化；不删语义字段）。

---

**最后更新**：2026-10-08（2.7.16）
**维护者**：chen731215-dev
