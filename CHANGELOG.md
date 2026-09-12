# Changelog

## v2.3.6 (2026-09-13)

### 🐛 修复

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