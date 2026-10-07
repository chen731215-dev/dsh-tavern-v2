# 会话绑定修复 · 交接说明（2026-09-27）

> 这份文档写给「接手的人 / 三个月后的自己」。
> 目标：**空白新会话也能绑定；注入严格以该会话选中的预设为准；不串会话；酒馆预设就是 DSH 原生预设。**
> 状态：**代码与回归测试已完成，已逐字节同步到本地装机版**；
> 还差两步只有你能做 —— **重启 DSH**、以及**在面板上按一下「声明为 DSH 预设」**（见第 5 节）。

---

## 1. 三个根因（都在这次修掉了，每条都有回归测试钉住）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| ① | **必须「先发一条消息」才能绑定** | 面板读 `ctx.sessions.list.getSnapshot().current` —— DSH 的会话列表快照**根本没有 `current` 字段**；兜底的 URL / 面包屑 / DOM 属性在空白新会话上也都取不到（DSH 从不用 URL 表达会话） | 新增 `dshMainViewSessionId()`，判据换成 DSH 自己用的 **`retainedBy.mainView > 0`**（空白新会话同样生效）；服务端把「活着的、还没落盘」的会话一并列进 `/api/tavern/sessions` |
| ② | **绑了却不出卡 / 会话说 standard 却照旧注入** | 决议链只看**落盘的 zstd 日志**：顶部刚换完预设、帧还没落盘时读到的还是旧值，于是退回酒馆账本 | 决议改写：**ⓐ** 投影挂酒馆预设且能证不是出生值 ⇒ 用它；**ⓑ** 投影挂非酒馆预设且与出生 header 不同 ⇒ 不注入；**ⓒ** 其余退回「日志 → 账本」。外加 **`armNativePresetWatcher`** 订阅 `session/event`：DSH 一发 `agent-preset/selected`，账本立刻跟着走（窗口从"一帧"缩到 0） |
| ③ | **酒馆预设根本不在 DSH 顶部选择器里** | 本版 DSH 的预设是**声明行**（`@deepseek-ai/dsh-agent-preset`），`$DSH_HOME/.agent-presets/` 旧目录**已经没人读了**（见 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:71`） | 生成声明行：路线 A 写 profile 补丁层受管块；路线 B 生成 DSH bundle。两条都默认 dry-run、要显式 confirm |

附带修掉的三处「编造状态 / 静默串台」：

- **面板显示**：只看酒馆账本 → 顶部选的卡被显示成「未绑定」。现在活会话会现算**原生权威**并优先显示。
- **两套 id 空间**：服务端每条预设同时带 `id`（DSH 目录名）与 `presetId`（酒馆注册表 id），
  只按一种匹配会让 `loadSessionPresets` **静默把编辑目标换成"第一个预设"**（改世界书改错卡！）。
  现在统一走 `matchPresetInList()`（id / presetId / dir 三选一），命中后把 id 统一成目录名。
- **`default` 双重身份**：它既是「酒馆默认」预设的别名，又是「不注入」的哨兵 ⇒ **绑了酒馆默认却被当成没绑**。
  现在写入口一律落**目录名**，`default` 只剩哨兵含义。

---

## 2. 行为对照（改动前 → 改动后）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 新建对话（未发消息）开面板 | 提示「先发一条消息」 | 读出当前会话，可直接绑定 |
| 空白会话绑定 | 400 拒绝 | 原生 `agentPresets.select` 成功（DSH 写入 `agent-preset/selected`），首条消息即带卡 |
| 顶部把会话切回 `standard` | 帧没落盘时会按旧账本注入（串） | watcher 立刻清账本 ⇒ 不注入 |
| 已开跑会话（DSH 锁死预设本体） | 靠账本跟随 | **仍然靠账本跟随**（没有被新规则咬死 —— 这是第 9 轮修的回归） |
| 绑「酒馆默认」 | 被当成"没绑"⇒ 不注入 | 落盘成目录名 ⇒ 正常注入 |
| 一次「应用到当前会话」 | 只写酒馆账本 | 先原生 select（顶部同步显示），再记账本兜底；失败原因如实回报（locked / not-in-roster / preset-invalid…） |
| 会话已开跑后再绑定 | 面板说「仅世界书/记忆跟随」 | 同上，但文案改成「是否注入由该会话选中的 DSH 预设决定」 |
| 预设增删改 | 与 DSH 名册无关 | 开启声明后**自动同步**（删预设会把它的声明行一起去掉，不留坏卡） |

---

## 3. 代码位置速查

- 会话 id 解析（客户端）：`lib/client.manager.bundle.js` → `dshMainViewSessionId()` / `getCurrentSessionId()`
- 决议链（服务端）：`lib/index.js` → `resolveAuthoritativePreset()`（三条规则 + `default` 别名兜底）
- 原生预设读取：`nativeAgentPresetOf()`（投影）、`nativePresetRoster()`（名册 = 顶部选择器里有什么）
- 原生绑定：`selectNativeAgentPreset()`（名册预检 + `turnBoundary` 判「已开跑」+ 错误码如实折叠）
- 账本同步：`armNativePresetWatcher()`（订阅 `session/event`）
- 声明行：`renderPresetDeclaration()` / `composePresetDeclarationBlock()` / `mergeManagedPresetBlock()`（含 `[]` 占位符处理）
- 写盘器：`applyPresetDeclarations()`（默认 dry-run / 备份 / 原子写 / 回读自检 / 回滚）、`writePresetBundle()`（路线 B）
- 面板开关：`client.manager.bundle.js` → `#tavern-declare-*`（先预览→confirm→才写）
- 接口：`GET/POST /api/tavern/preset-declarations`、`GET/POST /api/tavern/preset-bundle`、`POST /api/tavern/bind-preset`、`POST /api/tavern/unbind-preset`

## 4. 测试与验证证据

- 全套 **17 个文件 386 例全绿**（`node --test tests/<file>` 逐个跑；本机沙箱里 `node --test` 因管道受限会用 EPERM，直接跑文件即可）。
  新增 6 个文件（另扩了 `binding-panel-ui` 的 VM 试验台）：
  - `tests/native-preset-binding.test.js`（31）：名册 / 决议权威五连 / watcher / 已开跑判定
  - `tests/native-bind-route.test.js`（11）：真 `apply()` + 真路由 + 假 DSH（空白会话绑定、locked、解绑交还默认、会话隔离、绑酒馆默认落盘成目录名）
  - `tests/client-main-view-session.test.js`（15）：对**打包产物源码**求值（空白新会话取 id、mainView 缺失不顶替、声明按钮顺序、`matchPresetInList` 三种 id）
  - `tests/preset-declaration.test.js`（30）：声明渲染 / 受管块幂等 / 占位符 / 写盘三层保护 / 生命周期 / 体积提示
  - `tests/cordis-mount.test.js`（4）：**真 Cordis 宿主** —— 从 `app.asar` 只读取 cordis，实测
    「插件 mount 成功（34 路由 + 4 prompt 段）+ 插件自己的 ctx 解析得到宿主 `agentPresets`
    + 原生绑定走通（`default` → `tavern-lite`）+ **真注入按会话走**
    （挂酒馆预设的会话提示词含卡正文哨兵，挂 `standard` 的一个字都没有，`tavern:nsfw` 段同判据）
    + **跨作用域事件投递**（子作用域发 `session/event` ⇒ watcher 立刻改写账本）」；
    拿不到 cordis 时明确 skip
  - `tests/binding-panel-ui.test.js`（31，扩了 VM 试验台）：**面板声明开关的行为级测试** ——
    点「📢 声明为 DSH 预设」必须**先 GET dry-run 预览 → 弹确认（含目标文件/前后字节数/会备份）→ 才 POST**，
    取消则一个写请求都不发；「🧹 撤下声明」要确认且带 `remove+confirm`；
    「📦 只生成 bundle」把 `install_bundle` 命令显示出来（含一条对照臂）。
    另有 3 例**作用域回归**：`matchPresetInList` 必须与 `loadSessionPresets` 同层（结构断言）、
    真跑一遍 `loadSessionPresets` 断言渲染成功（真执行）、不注入 helper 时必须复现
    「❌ 加载预设失败」（对照臂）——这一条对应 CHANGELOG 的 N 节事故
  - `tests/panel-tabs.test.js`（8）：**面板标签页布局** —— 顶层 12 张卡片全被页签规则收走、
    底部操作区（yml / 保存 / 状态）不被任何规则认领（永远可见）、用迷你 DOM 真跑安装器
    （落对页签 / footer 留在页签外 / 切页签持久化与回落 / 幂等）
- `lib/index.js`、`lib/client.manager.bundle.js` 语法检查通过；仓库与装机版（`~/.dsh/profiles/desktop/node_modules/dsh-tavern`）**逐字节一致**。
- **你的配置零改动**：`~/.dsh/profiles/desktop/cordis.patch.yml` 哈希全程未变（`79CBA559…`）；`~/.dsh/tavern-data/preset-bundle/` 未创建。

## 5. 你要做的两件事

**5.1 重启 DSH**（加载新代码）。之后按这三步验：新建对话 → **不发消息**直接开面板 → 绑定 → 发第一条消息，应带卡与世界书。

**5.2 让酒馆预设进顶部选择器**（可选，但这是「预设=agent 预设」的最后一步）：
开面板 → 「🔗 当前会话绑定」卡片里 → **📢 声明为 DSH 预设** → 看预览 → 确认 → **再重启一次**。
- 撤销：同一处的 **🧹 撤下声明**（整块摘掉受管块，块外内容不动）；备份在 `~/.dsh/tavern-data/backups/`。
- 走官方路子：**📦 只生成 bundle** → 用 `plugin_manager { action: 'install_bundle', target: '<显示的目录>' }` 安装。

## 6. 已知边界与**未验证**项（诚实清单）

1. **没有整机验证过**。以上是源码级推导 + 370 例自动化回归 + 对真实预设数据的只读 dry-run +
   **真 Cordis 宿主挂载、真注入、真事件投递**（见第 4 节最后一条）。
   **「打开面板 → 点绑定 → 看到卡」这条人机链路**仍未被观察过一次
   （重启会掐断当时的会话，所以没做）。
2. **路线 A 的体积代价**：声明会把每个预设的**整个组合（含卡正文）内联**进 `cordis.patch.yml`，
   DSH 每次启动都要解析它。超过 256 KB 会在 dry-run 里给出 `large-patch` 提示（建议改走 bundle）。
3. ~~服务可见性未验证~~ **已验证**：`tests/cordis-mount.test.js` 在真 `@deepseek-ai/cordis` 宿主里
   把插件挂起来，实测 apply() 跑完（34 条路由 + 4 个 prompt 段），且插件**自己的 fiber**
   解析得到宿主 `agentPresets`（`roster` 非空）。拿不到服务时的 fail-closed 分支仍有单测覆盖。
4. ~~`session/event` 是否送达本插件未验证~~ **已验证**：在真 cordis 里从**子作用域**
   `emit('session/event', …)`（DSH 的实际形态），我们的 watcher 收到了并立刻改写了账本
   （`tavern-lite` → `source: 'top-select'`；切成 `standard` → `{ mode: 'none' }`）。
   真机上仍建议顺手看一眼：在顶部把会话切成 `standard` 后，
   `session-bindings.json` 里该会话应当**立刻**变成 `{ "mode": "none" }`。
5. **部署默认预设若本身就是酒馆预设**：新会话出生即带该预设 ⇒ ⓐ 规则会注入它（符合「选了就管」的模型，
   但与旧的 P0-5「出生默认不注入」相反）。当前部署默认是 `standard`，因此实际不触发。
6. 仓库 `.git` 对象库是坏的（`bad object HEAD`），**本次改动没有提交**：
   联网后先 `git fetch origin && git reset --hard origin/main` 修复，再提交（commit message 建议：
   `fix(binding): 会话绑定改走 DSH 原生 agentPreset（空白会话可绑 + 严格会话隔离）`）。
