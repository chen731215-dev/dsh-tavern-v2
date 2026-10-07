# Changelog

> 📦 **历史条目已归档**：v2.5.5 及更早（2026-08-27 ~ 2026-10-04）在
> [`docs/archive/CHANGELOG-pre-2.6.md`](./docs/archive/CHANGELOG-pre-2.6.md)。
> 根目录只保留 **v2.6.0 起的当前批次**，更早的请去上面那个文件。

## v2.7.11 (2026-10-08) — 🧷 补上唯一的自动化强制点：CI + 清单不再手抄 + 文档不再手抄数字

> 这一版修的是「**护栏本身没有护栏**」：全量测试 / 语法检查 / 样式预算 / 客户端自检 /
> innerHTML 棘轮，此前全都只在「人记得手动跑」的那一刻生效。

### 1. `npm test` 曾经漏跑 3 个测试文件 —— 其中一个是安全回归
`scripts.test` 是一条**手抄的 `&&` 长链**。实测（2026-10-08）：`tests/` 下有 25 个
`*.test.js`，而脚本只引用了 22 个，漏掉的是：

- `tests/render-escape.test.js` ← **issue #14 的安全回归测试**
- `tests/nsfw-slot.test.js`
- `tests/server-state-paths.test.js` ← 2.7.8 的路径镜像护栏

也就是说：**用最顺手的 `npm test` 会得到「全绿」，但安全不变量根本没执行。**
同一批排查还发现 `scripts.check` 只引用了 14 个文件、漏掉 13 个测试文件 —— 同一类漂移。

现在两处都改成**扫目录**，清单由文件系统决定：

| 脚本 | 之前 | 现在 |
|---|---|---|
| `npm test` | 手抄 22 条 `&&` 长链 | `node tools/run-each-test.mjs`（自动扫全部 `tests/*.test.js`） |
| `npm run check` | 手抄 14 条 `node --check` | `node --experimental-vm-modules tools/check-syntax.mjs`（扫 `lib/` `tests/` `tools/`，52 个文件） |

新增测试文件**自动**被纳入，不会再漏；`&&` 长链「第一个红项掩盖后面全部」的问题也一并消失。

### 2. 顺带修掉 runner 自己的空跑漏洞
`tools/run-each-test.mjs` 原来的判据是 `status===0 && fail===0` ——
**`pass=0 且 fail=0` 会被判成通过**，也就是「一条断言都没跑」等于绿灯。
现改为判**失败**（输出标 `❔`），并加了「合计 0 项断言 ⇒ 失败」的总量兜底。
受限环境里 spawn 失败（EBUSY）现在会明确报红，而不是伪装成通过。

### 3. 新增 CI —— 这是唯一能在服务端拦下坏提交的地方
`.github/workflows/check.yml`（`windows-latest` + Node 22，本仓是 Windows-only）：
push / PR 自动跑 `check` / `test` / `check:style` / `check:integrity` / `check:innerhtml`。
`cordis-mount.test.js` 找不到 DSH 的 `app.asar` 时会自己 skip，所以 runner 不需要装 DSH。

`tools/check-syntax.mjs` 刻意**不用 `node --check` 子进程**，而是在当前进程里用
`vm.SourceTextModule` 解析 —— 受限环境里 spawn 型工具会给出「全 0」的假结果，
而假结果长得像绿灯。

### 4. 规范文档里的数字清零
`AGENTS.md` 曾在**同一节里同时存在 22 / 23 / 25 三套口径**（`CLAUDE.md` / `.cursorrules`
还各有一份 434 项的过期拷贝）。现在：**文档里禁止再写「N 个文件 / N 项」**，
一律「以 `npm test` 的输出为准」；结构树里每条手抄行数也全部删掉
（顺带补上缺失的 `tools/check-syntax.mjs`、`.github/`，删掉重复的 `style-budget.json` 行，
修掉 §10 里被 blockquote 切断的表格与重复的 S3 行）。

### 5. 混合换行清零
`.gitignore`（我在 S1 追加时误用了 CRLF，原文件是 LF）与 `lib/utils.js`
（末尾 9 行历史遗留的裸 LF）都已统一。`lib/utils.js` 是**纯行尾修复、git diff 为零**。

### 6. §6 新增三条不变量（安全纵深记账）
- **⑩ 编码只覆盖 HTML 语境**：实测 URL 语境 0 处动态 `href`/`src`、CSS 插值的动态部分
  只有「字面量三元」与数值、无 `<script>` 字面量；另外记下第四类此前未记账的语境 ——
  **`srcdoc`**（`iframe.srcdoc = sb.html`，内容来自 muv-engine）。当前缓解是
  `sandbox="allow-scripts"` 且**刻意没有** `allow-same-origin`，改它时不要顺手加。
- **⑪ 落库边界能一次覆盖两条出口**：关系网字段 → `innerHTML`（XSS 路）、
  `summary`/`memory` 文本 → 系统提示（提示词注入路），**字段不重叠但同源**。
  只加渲染端 `esc()` 永远只护得住前者。同时纠正一个容易传错的说法：
  `buildRelationsHintText()` 往提示词里注入的**只有计数**，关系字段本身不进系统提示。
- **⑫ 没有第二道墙**：主 Web UI 页面无阻断性 CSP（实测 `app.asar` 里的 CSP 命中分别属于
  媒体文件响应头 / SVG 净化 / 附属页），而注入的脚本跑在持有 DSH 本地 API 凭据的源里
  ⇒ **必须假设转义是第一道也是唯一一道防线**。

### 7. 新增 `tests/tooling-integrity.test.js`（11 项）
把上面几条钉死：`npm test` / `npm run check` 不许变回手抄清单、CI 必须存在且跑齐五条、
三份文档不许出现手抄数字、全仓文本文件不许混合换行、runner 不许丢掉空跑判据。
每条判据都写成**纯函数**并配**反证组**（喂坏样本必须报错）；已做变异验证：
把 `scripts.test` 改回手抄清单 / 移走 `.github` / 往 `AGENTS.md` 塞回「23 文件 / 454 项」/
把 `lib/utils.js` 改回混合换行 —— 四条全部被精确点名报红。

---

## v2.7.10 (2026-10-08) — 🧹 三套转义实现收敛成一套 + 基线不许"不明所以"

> 全量 **468/468 通过**（25 文件，护栏由 5 项扩到 7 项），`check:style` / `check:integrity` /
> `check:innerhtml` 均通过。

### 1. 仓库里其实有**三套**转义实现（不是两套），其中一套已经漂了
| 位置 | 实现 | 状态 |
|---|---|---|
| `esc`（L12） | `& < > " '` 五字符 | 真源 |
| `escapeHtml`（原 L6888） | 字符表式，五字符 | 与 esc 等价，但**是第二份实现** |
| `htmlEscapeStr`（原 L6098） | 链式 replace，**只吃四个字符、漏了单引号** | **已经漂了** |

`htmlEscapeStr` 的角色还不同：它被拿去在「已由 `esc` 生成」的 HTML 里做 `indexOf` 搜索键
（`plotGuideText` 那处）。漏 `'` 的后果是**正文含单引号时搜不到**，选项按钮退化成"追加到末尾"——
是行为 bug，不是安全洞。

三套全部收敛成 `return esc(s)`。这正是 `escAttr` 当年的翻车形态（第二份实现漂成空操作），
所以新增测试 ⑦：**仓库里只许有一套转义实现**（`replace(/&/g,'&amp;')` 只允许出现在 `esc` 里），
已做变异验证（加第二套 ⇒ 立刻报红）。

### 2. 基线不许变成"不明所以的白名单"
上一版留了 9 条基线。其中 4 条是**字符串**字段，光看行不知道凭什么放过 —— 半年后没人能 review。
所以做了两件事：

**a) 能彻底消掉的，就不放进基线**：`g.label` / `grp.label` 两处分组标题
（源头是硬编码字面量 `'🍺 酒馆预设'`）直接在用处加 `esc()` —— 这样即使将来来源改成数据也不会漏。
棘轮自动报「已消除 2 条」，基线 9 → 7。

**b) 剩下 7 条每条都要带「分类 + 理由 + 机器可验证的证据」**：
```json
{ "lineNo": 4165, "kind": "upstream-escaped", "why": "pName 与 pMeta 都在上游转过义",
  "mustContain": ["var pName = esc(p.name || '')", "pMeta += '🎭' + esc("] }
```
- 分类：`numeric`（天然安全，可永久留）/ `upstream-escaped` / `ternary-literals`
- **`mustContain` 是每次都会复查的断言**，不是写给人看的注释 —— 谁把上游的 `esc` 去掉，
  测试 ⑥ 立刻报红（已做变异验证）
- `--update` 时匹配不到分类就记 `unclassified`，**校验直接失败** —— 逼着新条目当场给理由

三层防线：`--update` 拦未分类 → 测试 ⑤ 拦缺理由 → 测试 ⑥ 拦证据失效。

---

## v2.7.9 (2026-10-08) — 🛡️ innerHTML 转义棘轮（补上"新建渲染路径"这个盲区）+ 两处同类残留

> 全量 **466/466 通过**（25 文件，新增 5 项），`check:style` / `check:integrity` / **`check:innerhtml`** 均通过。

### 起因：现有护栏对"新建渲染路径"是盲的
`tests/render-escape.test.js` 的 ③ 是**按变量名写死**的模式（`+ e.source +` / `+ label +` …）。
它能守住已知的两个渲染函数，但换个变量名、换个函数就抓不到 —— 而"把两个渲染函数合并成一个
通用 helper""抽统一 innerHTML 拼装函数"这两种重构动作，恰恰最容易漏掉某一路来源。
**PR #13 就是这么翻车的**：它转义了 `e.source` / `e.target`，漏了 `label`。

### 新增：结构化护栏（不看变量名）
`tools/check-innerhtml-escape.mjs`（`npm run check:innerhtml`）
把 `.innerHTML = / +=` 右边的表达式按**顶层 `+`** 切成段，**逐段**判定：

- 结构安全 = 字面量 / esc 函数族 / 含 esc 的 `.map|.join` 链 / `.length` `.count` 计数 / 两支都是字面量的三元
- 否则整行记为可疑 —— **不做「整行有 esc 就放行」**，那正是漏掉"转义了一个、漏了另一个"的原因
- 表达式跨行（`.map(function (s) { … }).join('')`）会自动往后补全窗口再判
- 棘轮：现状记进 `tools/innerhtml-baseline.json`（9 条，均已人工过目），**只许减不许增**
- 边界用**顶层扫描**而不是正则切三元 —— 否则 `'transform:rotate(90deg);'` 里那个 `:` 会被切错

护栏：`tests/innerhtml-escape-ratchet.test.js`（5 项，含 3 组反证：
① "转义一个漏一个"必须被抓 ② **换个变量名的新渲染路径**必须被抓 ③ 旧的写死模式在同一段上确实抓不到）。
已做变异验证：注入一条新渲染路径 ⇒ 立刻报红并点名 `node.displayName`。

### 顺带修掉两处同类残留（扫描器第一轮就抓出来了）
| 位置 | 问题 | 处理 |
|---|---|---|
| `switchSessionPreset` 的提示行 | `presetName \|\| presetId` 两次**裸拼**进 innerHTML（调用来路是 `p.id, p.name`，即用户自建预设名） | 两处加 `esc()` |
| 禁用词标签渲染 | 用的是**自己手写的一次性转义** `w.replace(/</g,'&lt;')`，而不是项目的 `esc()`（严格说不可利用 —— 实体解码出的 `<` 是文本字符，但这正是"另起一套转义"的形态） | 统一为 `esc(w)` |

### 关于防线 (d)：边界净化目前**没有**
`parseSummaryOutput` 只做 JSON 解析，`rels` 原样返回，落库前没有任何清洗。
纵深防御确实缺这一环 —— 但它是**行为变更**（会改动落库内容），需要单独决策，本轮没动。

---

## v2.7.8 (2026-10-08) — 🧱 S2-B2b + S2-C1：路径镜像落地，搬出首批路径依赖函数

> **纯结构改动，用户可见行为零变化。** 全量 **461/461 通过**（24 文件，新增护栏 5 项），
> `check:style`、`check:integrity` 均通过，CRLF 保留，累计对账**零丢失**。

### S2-B2b：路径 `let` 的单向镜像（`P` + `syncPaths`）
路径那 9 个 `let` 因为被 memory-isolation 按行首切片，**必须留在 `index.js`**。
于是把方向定死为「**index.js 的 `let` 是唯一真源，`state.js` 的 `P` 是它的镜像**」：

- 新增 `export const P = {…}` 与 `export function syncPaths(v)`；
- 全仓**只有两处** `syncPaths()` 调用：模块初始化时 + `bindDshPaths()` 里；
- 新增 `tests/server-state-paths.test.js`（5 项）盯住这个新失效模式：
  ① 调用恰好两处 ② 9 个路径名的赋值只允许出现在 `bindDshPaths` 里
  ③ `lib/server/*` 不许直接改 `P` ④ `P` 的键与 index.js 一一对应 ⑤ 反证（判据不是空跑）
- 已做变异验证：在 `bindDshPaths` 外插一句 `ROOT = '/tmp/evil'` ⇒ ② 立刻报红。

> ⚠️ 插入点有个坑：切片范围是「`let ROOT` 行 → `const DEFAULT_PRESET_DIR` 行」**两端都含**，
> 镜像调用必须插在这**之后**，否则那段独立模块会引用到未定义的 `syncPaths`。

### S2-C1：搬出首批路径依赖函数（`lib/index.js` 5923 → 5583 行）
| 模块 | 内容 |
|---|---|
| `dsh-conn.js`（追加） | `readDshProviders` / `readDshCredentials` / `resolveMemApi` / `readDshDefaultAgentPresetId` / `listDshConnections` |
| `session-read.js`（新） | `readSessionEventsDirect` / `readLastAssistantText` |
| `session-migrate.js`（新） | `migratePersonaCompleteFlag` / `migratePersonaTextField` |
| `state-io.js`（新） | `writeState` / `ensureRoot` |

搬走时函数体里的路径名统一改写成 `P.XXX`（唯一改动，其余逐字保留）。

### 又两个「源码切片钉住」的函数（本轮实测新增）
- **`readState`**：函数体里含默认 state 字面量 `nsfwEnabled: false, nsfwPrompt: ''`，
  被 `nsfw-slot` ⑪ 与 `core` P0-6 按源码字符串钉住 —— 搬走立刻报红。
- **`armLiveAgents`**：`greeting-seed` 测试按 `function armLiveAgents(` 切片它。
两者已补进 `AGENTS.md §5.1` 的留守名单。

### 对账口径升级
路径/状态改名后，"逐行零丢失"不再能直接对——`_scratch/s2c-verify.mjs` 现在会先归一化
`P.`/`S.` 前缀，并把「被 S2-B2a 改成 state.js 属性的那 10 行声明」列白名单，
**同时要求这些白名单项在 state.js 里真的能找到对应属性**（防止用白名单掩盖真丢失）。

---

## v2.7.7 (2026-10-08) — 🧱 S2-B2a：可变运行时状态收进 `lib/server/state.js`

> **纯结构改动，用户可见行为零变化。** 全量 **456/456 通过**（23 文件），
> `check:style`、`check:integrity` 均通过，每个文件过 `node --check`，CRLF 未变。

`lib/index.js` 顶层那 6 个「非路径」可变 `let` 统一挂到 `S` 对象上，
这样 `lib/server/*` 才能在不反向 import `index.js` 的前提下读到它们（AGENTS.md §5 第 5 条）：

| 变量 | 引用改写 |
|---|---|
| `playerName` | 10 处 → `S.playerName` |
| `activePluginCtx` | 3 处 → `S.activePluginCtx` |
| `builtinDirsCache` | 5 处 → `S.builtinDirsCache` |
| `_bindingsCache` / `_bindingsDirty` | 8 / 5 处 |
| `promptStatsFlushedAt` | 2 处 |

### 两个「不能动」的例外（写进 `state.js` 头注释了）
- **路径类那 8 个 `let`**（`ROOT` / `TAVERN_DATA_ROOT` / …）必须留在 `index.js`：
  memory-isolation 测试按行首切片 `let ROOT = path.join(DSH_HOME, '.agent-presets')` 到
  `const DEFAULT_PRESET_DIR` 这一整段。留给 S2-B2b 用 `syncPaths()` 做单向镜像。
- **`lastSessionId`**：测试断言源码里必须有字面量 `const targetSid = lastSessionId`，改名会破坏护栏。

### 踩到的坑（值得记）
改写引用时加了 `(?<![\w$.])` 保护属性访问（`state.playerName` 不能被改），
但**漏了对象字面量的键**——默认 state 对象和 `json(...)` 响应体里都有 `playerName: …`，
一度被改成 `S.playerName: ''` 直接语法错。补上 `(?!:)` 后通过。
教训：**自检判据必须和替换判据完全一致**，否则会把「故意跳过的对象键」误报成遗漏。

---

## v2.7.6 (2026-10-08) — 🔒 堵掉 issue #14 的同类残留：预设名裸拼 innerHTML

> **安全补丁，不动界面结构。** 全量 **456/456 通过**（23 文件，新增 2 项断言），
> `check:style`、`check:integrity` 均通过，`node --check` 通过，bundle 的 LF 行尾未变。

### 背景
issue #14（关系网 HTML 注入，已在 2.6.1 修完）的报告者还提到「数不清的漏洞」。
本次把同一 class 的残留清掉了：**预设名裸拼进 innerHTML**。
数据源是用户/服务端填的预设名（不是模型输出），且「导入预设」这条路径能由外部文件带入名字，
所以一并堵上——虽然严重度低于 #14，但属于同一个错误模式。

### 改了三处
| 位置 | 内容 |
|---|---|
| 导入预设提示 | `pname` → `esc(pname)` |
| 会话面板「当前预设：」 | 见下（这处有个坑） |
| 预设面板「当前编辑：」 | `currentPreset.name` → `esc(...)` |

### 一个差点做成「假修复」的坑
「当前预设」那行原本是**先把名字写进 innerHTML，再用 `innerHTML.replace('当前预设：' + 原始名, …)` 反查替换**。
如果只在写入端加 `esc()`，读回来的 `& " '` 已被浏览器解码，反查串（未解码）对不上
⇒ **预设名里带引号时「修正绿字」会静默失效**（功能悄悄没了，测试还全绿）。
所以改成「先定好最终文本 → 转义 → 写一次」，顺带去掉这个 innerHTML 往返。

### 新增护栏（带变异验证）
`tests/render-escape.test.js` ⑥⑦ 两条：预设名三处必须 `esc(...)`；
禁止再出现 `presetStatus.innerHTML.replace('当前预设：'` 这种反查；
同时断言「以下拉框为准」的修正行为**必须保留**（不能因为加转义把功能弄丢）。
已做变异验证：把三处 `esc(` 撤掉 ⇒ ⑥ 立刻报红，恢复后 9/9。

### 顺带记一条环境事实
`lib/client.manager.bundle.js` 是 **LF**，`lib/index.js` 是 **CRLF** —— 两个文件行尾约定不同，
改哪个都要先确认（Git Bash 的 `grep -c $'\r$'` 在这上面会给假读数，用 node 数才准）。

---

## v2.7.5 (2026-10-08) — 🧱 S2-B1：建起交接文档点名的 `presets` / `bindings` / `skills`

> **纯结构改动，用户可见行为零变化。** 全量 **454/454 通过**（23 文件），`check:style`、`check:integrity` 均通过，
> 每个文件过 `node --check`，CRLF 100% 保留，逐行对账**零丢失**。

### 做了什么
在 S2-A 的基础上再搬 21 个函数/常量，`lib/index.js` **6195 → 5924 行**（累计自 7175 行**净减 1251 行**）：

| 模块 | 变化 | 内容 |
|---|---|---|
| `bindings.js` | 新增 216 行 | 绑定来源分类、活动会话探测、字段归一化 |
| `skills.js` | 新增 36 行 | skill 名合法化、frontmatter 解析 |
| `presets.js` | 新增 21 行 | 组合文本判据（S2-C 抽出装配逻辑后继续扩充） |
| `constants.js` | +24 行 | 追加 `BINDING_SOURCE_*`、`BLANK_PRESET_SKELETON`、`SKILL_NAME_RE`、`liveAgents` |
| `session-log.js` | +13 行 | 追加 `contentTextOnly` |

### 一个重要发现：`lastSessionId` 在源码层面被钉死
`tests/memory-isolation.test.js` 断言源码里必须存在字面量 **`const targetSid = lastSessionId`**
（防止自动总结在异步回调里再读全局、拿错会话）。所以这个变量**不能改名、也不能收进 state.js**。
→ 已连同完整名单写进 `AGENTS.md §5.1`。

### 为什么剩下的都卡在可变状态上
用定点迭代穷举过：不先解决可变状态，可安全搬走的**只剩 148 行**。剩下的函数分别被这些东西挡住：
钉住函数（`readPresetsMeta` / `getPresetDir`）、路径 `let`（`ROOT` / `DSH_SETTINGS_FILE` …）、
切片锚点常量（`DEFAULT_PRESET_ID` / `DEFAULT_PRESET_DIR`）、以及依赖它们的 `readState` / `writeState` / `writeBindings` 等。
**下一棒是 `lib/server/state.js`（S2-B2），它是解开这些的唯一钥匙。**

---

## v2.7.4 (2026-10-07) — 🧱 S2-A 服务端分层：拆出 `lib/server/`（10 个模块 / 净减 980 行）

> **纯结构改动，用户可见行为零变化。** 全量 **454/454 通过**（23 文件 / 与基线逐项一致），
> `check:style` 通过、`check:integrity` 通过、每个新文件过 `node --check`、CRLF 100% 保留。
> 逐行对账结论：**原始 `lib/index.js` 的每一个非空行都被完整保留，零丢失、零改写**。

### 做了什么
`lib/index.js` 里「依赖闭包干净、不碰可变全局状态」的 **53 个函数 / 9 个共享常量**整块搬进新目录：

| 模块 | 行数 | 内容 |
|---|---|---|
| `worldbook.js` | 311 | 世界书 v2 统一格式 + SillyTavern 语义的条目选择 |
| `summary.js` | 168 | 总结提示词构造 / LLM 调用 / 结果解析 / 拒答识别 |
| `preset-decl.js` | 160 | 预设声明块（受管片段）渲染与修补 |
| `util.js` | 115 | 无状态纯工具（`json` `readBody` `clipText` …） |
| `session-log.js` | 100 | 会话历史定位 + zstd 多帧读取 |
| `dsh-conn.js` | 81 | DSH settings / credentials 里的 API 连接解析 |
| `constants.js` | 37 | 跨模块共享常量（两边都用到的那几个） |
| `prompt.js` | 56 | 注入生效范围闸门 + 提示词体积预算 |
| `text.js` | 41 | 文本清洗 / 角色卡正文提取 |
| `zstd.js` | 14 | zstd 垫片（Node < 22.5 降级） |

`lib/index.js`：**7175 → 6195 行**。依赖关系单向（`index.js → lib/server/*`），无循环。

### 为什么有些函数没搬
几个测试**按行切片** `lib/index.js` 源码拼成独立模块求值，被切的函数必须留守
（详见 `AGENTS.md §5.1` 的完整名单）。另外 41 个函数依赖可变全局（`ROOT` / `playerName` / 缓存），
要等 `lib/server/state.js` 落地才能搬 —— 那是 S2-B。

### 过程中修掉的两个坑
1. **不能用「第一个顶格 `}`」判函数结尾**：`normalizeName` 的 `for` 循环闭合括号缩进错了（顶格），
   `parseStagePlans` 的正则字面量里带 `\{` —— 两者都会让朴素扫描拦腰截断函数。
   改为括号配平 + **每个抽出的块单独 `node --check`**（180 个块全部独立解析通过）。
2. **分节说明注释不能跟着函数搬**：`// ── DSH home 解析 ──` 下的注释同时服务于留下来的 `resolveDshHome`。

---

## v2.7.3 (2026-10-07) — 🧹 作废老规矩 + 历史文档归档 + 🛡️ 客户端自检三件套

> **本次没有改动任何运行代码（`lib/` 下一个字节都没动）。** 全量 **454/454 通过**（23 文件），`check:style` 通过。
> 包含两部分：S1 仓库收尾，以及 S4① 安全网（自检三件套）。

### 1. 作废一条挡路的老规矩（本次的重点）

- `AGENTS.md` 里那条「服务端逻辑全部集中在 `lib/index.js`，**不要新建拆分子模块文件**」—— **已删除**。
  那条正是把 index.js 堆到 7174 行的原因。改为 §5「服务端分层」，并给出拆分的硬要求
  （先有安全网再动刀、逐段搬家、不许改用户可见行为、不许反向 import index.js）。
- 顺带校准了陈旧信息：版本号 1.9.2 → 2.7.3、包名 `@local/dsh-tavern` → `dsh-tavern`、
  **`lib/client.manager.bundle.js` 就是源码、没有构建步骤**（旧文档说「要重新打包」是错的，已删）。
- **把规则的三份拷贝收敛成一份真源**：`AGENTS.md` 是唯一规范源，
  `CLAUDE.md` 与 `.cursorrules` 改为指向它的短指针。
  原因：三份内容相同，**其中两份已经漂移**成过期版本号，再抄第四份迟早还会漂。

### 2. CHANGELOG 拆分（133 KB → 14.6 KB）

- v2.5.5 及更早（1741 行）→ `docs/archive/CHANGELOG-pre-2.6.md`；根目录只留 v2.6.0 起的当前批次。
- **做了逐字符对账**：`HEAD` 版本 = 新的根 CHANGELOG + 归档正文，除本次有意的改动外完全一致，**零丢失**。
- 顺手修掉一处**游离的 H1**：`# Changelog` 曾被夹在 v2.6.1 与 v2.6.0 之间，导致文档大纲断裂。
- 归档区保留了两处**已知历史遗留**并在文件里标注，故意不改：文末的 `## v3.0.0` 空标题；
  正文中一处 `# → {"ok":true,...}` 开头的行（代码块里的 shell 注释，不是标题）。

### 3. 根目录清理

- `AUDIT-功能体检.md`、`ROOT_CAUSE_报告.md`、`HANDOFF-会话绑定修复.md`、4 个 `RELEASE_NOTES_*`
  → `docs/archive/`。
- **根目录遗留的 `client.manager.bundle.js` 旧副本（78 KB）** → `docs/archive/_legacy/`。
  它和真正的源码 `lib/client.manager.bundle.js`（486 KB）**同名**，改错地方会静默不生效——这是个容易踩的坑。
- 三个一次性探针 `find_unprotected.{js,cjs}` / `find_unprotected2.cjs` → `docs/archive/_probes/`。
  它们含本机绝对路径 `C:/dsh-tavern/lib` 且用了 `require`，违反 §7 红线与 ESM 规范，**不要照抄**。
- `.gitignore` 增加 `_scratch/`：该目录放本地临时脚本（含从会话日志提取 token 的性质），**绝不能入库**。

### 4. 对发布包的影响（属于预期内的变化）

- `RELEASE_NOTES_*.md` 已全部归档，**发布包不再包含它们**；`package.json.files` 里那条匹配不到东西的
  `RELEASE_NOTES*.md` glob 一并移除（否则留着会误导）。
- README 里指向 release notes 的链接已改到归档路径。
- `docs/` 本来就不在发布包里，归档区不会随包发布。

### 5. 🛡️ S4① 安全网：客户端自检三件套（新增 `tools/check-client-integrity.mjs`）

> 拆 7000 行的服务端之前要先有护栏。这三件事的思路来自 PR #13（@H2CO3w），
> 但那个 PR 只把方法论写在提交信息里、没提交脚本 —— 这里补实现并配了测试。
>
> 用法：`npm run check:integrity`。

1. **悬空 id 扫描**：把 JS 里 `getElementById('x')` / `querySelector('#x')` 引用的 id，
   与 markup 里声明的 id 取差集。当前实测 **243 处引用 / 164 个声明 / 0 悬空**。
   - 刻意**不收** `'#id' + x` 这类拼接写法与注释掉的历史代码 —— 这两种第一版都误报过，已钉进回归测试。
2. **标签配平**：先把 `panelHTML()` 那种「字符串片段数组」按组拼回去，再做栈式配对。
   当前 **610 个标签全部成对**。
   - 早期版本把全文字符串一股脑拼在一起，报了 **233 个假不平衡** —— 改成按片段数组分组后归零。
3. **卡片嵌套深度**：确认每张 `data-tv-tab` 卡片与同级卡片同层（当前 12 张都在 depth=2），
   没有被容器误吞。

三个判据都带**空跑防护**：源码里明明有 `data-tv-tab` / 字面量 id 查询，却一个都没抓到时，
工具判**失败**并提示「判据空跑」。理由是空跑出来的绿灯比红灯更危险 —— 它会让人以为护栏还在。
（这一点是拿突变样本验证出来的：故意把一张卡片多包一层，工具立刻报 8 张卡片层级不一致 + 1 处标签不平衡。）

配套测试 `tests/client-integrity.test.js` **20 项**，每条「应当报错」的判据都配坏样本对照。

### 6. 验证

- `node tools/run-each-test.mjs` → **23 文件 / 454 项 / 0 失败**（原有 434 项全保留，新增 20 项）。
- `node tools/assert-style-budget.mjs` → 退出码 0，两项内联事件硬 0 保持。
- CHANGELOG 拆分做了 `HEAD` 版与新文件的逐字符对账。

---
## v2.7.2 (2026-10-07) — ✏️ 最后一颗纯图标铅笔改成文字

- 「重命名当前预设」按钮此前**内容只有一个 `✏️`**，全靠 `title` 属性兜底 —— 辨认成本高，
  也是 PR #13 指出的"emoji 当控件唯一标识"的最后一例。现改为文字 **「重命名」**（保留 `title`）。
- 说明：仍有 1 处 emoji（「✏️ 手动输入」单选标签），那是**带文字的装饰图标**，
  不影响识别，且状态栏解析依赖的 emoji（`👤` / `⏰` 等）属于预设格式契约，不在清理范围。
- 验证：全量 **434/434**；`check:style` 通过（客户端/服务端内联事件均 0）。


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

- 全量 **434/434 通过**（22 个文件；434/434，净 +1 = 新增 panel-tabs ⑤b ——
  删除的是**断言行**而非测试项，所以每个文件的项数不变）；
- `node --check` 全过（4 个 lib 文件 + 22 个 tests + 2 个 tools）；
- 样式预算通过，并**全线下调**：内联事件属性 **5 → 0**、内联样式 312→301、裸 hex 352→331、
  rgba 160→150、`cssText` 赋值 72→59、颜色字面量 58→53 种、padding 变体 46→42、z-index 11→8；
- 残留 grep（`lib/`）：`saveEdition|loadEditions|editedCache|startEdit|tavern:edits|edited-messages|edit-history` 全部 **0**
  （`tavern-preset-batch` 仅剩保留项 `#tavern-preset-batch-del2` 的 2 处命中，属正常）。

### 🔍 顺手发现 → 本版已一并处理

- **服务端自渲染设置页的内联事件全部清零**：设置页原有 8 处 `on<event>="…"`
  （`saveWin()` / `save()` / `plotOptions` 等 3 个开关 / 2 个世界书模式单选），
  全部改为 `addEventListener` 绑定；`writeSessionLines()`（改写整份 zstd 会话日志的死函数）
  已删除，只在注释里留下"**不要再引入这种写法**"的警示。
- **样式预算新增两项硬 0 规则**：`inlineHandlerAttr`（客户端，5→0）与
  `inlineHandlerAttrServer`（服务端 `lib/index.js` 自渲染 HTML，8→0）——
  后者是 v2.7.1 前**完全漏检**的一类（预算脚本只量客户端 bundle）。
  新增 `tests/style-budget.test.js` 的 ③-b 断言把这条钉死，并配"合成样本必须命中"的非空跑对照。

### ✅ 本版验证（2.7.1）

- 全量 **434/434 通过**（22 个文件）；
- `npm run check:style`：`inlineHandlerAttr = 0`、`inlineHandlerAttrServer = 0`、`!important = 0`，exit 0。


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

