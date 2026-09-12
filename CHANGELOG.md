# Changelog

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