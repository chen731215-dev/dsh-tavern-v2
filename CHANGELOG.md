# Changelog

## v2.3.2 (2026-09-12)

### 🐛 修复
- **persona 配置键名适配（`text:` → `prefix:`）**：`@deepseek-ai/dsh-persona` 自 `0.1.3-alpha.2`（2026-09-07）起把该字段改名为 `prefix:`（并新增 `suffix`、`complete`、`includeRuntimeContext`），旧的 `text:` 被 schema 静默忽略，导致组装 agent 时 `prefix` 缺失、**预设完全无法使用**。修复范围：
  - `lib/client.manager.bundle.js` `buildAgentYml()`：保存预设时写 `prefix:`
  - `lib/index.js` `createPreset()`：新建空白预设骨架写 `prefix:`
  - `lib/index.js` / `lib/utils.js` `extractCardText()`：两种键名都接受，旧预设（`text:`）仍可读
- **成人模式 / 剧情选项此前完全不生效（根因）**：本插件生成的预设带 `complete: true`，`@deepseek-ai/dsh-system-prompt` 的 `assemble()` 会把最终 system prompt 压缩为「仅 complete 段」，因此 `tavern:nsfw` / `tavern:plotOptions` / `tavern:card` 等运行时 section **全部被丢弃**。现在成人模式与剧情选项的文案会在保存预设时写进 persona prefix，确保真正到达模型
- **`tavern:nsfw` 白名单门禁移除**：该段原先在 `mode === 'allowlist'` 时要求 sessionId/cwd 命中白名单，但维护白名单的 UI 开关早已被移除，导致成人模式**静默失效**。开关本身（`nsfwEnabled`）已足够表达用户意图
- **剧情选项渲染器**：
  - `if (false && optionList.length > 0)` 长期禁用 → 恢复启用
  - 按钮 `data-opt` 写的是**下标**（点击会发送 `"0"`/`"1"`/`"2"`）→ 改为携带选项正文
  - 收集逻辑改为**仅在出现「选项引导语」时**启用，且只取引导语之后的编号/项目符号行；不再用 `接下来` / `请选择` / `你决定` 这类会出现在正文里的宽松词截断消息
  - 补齐同行写法（`接下来你想怎么做？1. 甲 2. 乙`）、`、` 顿号编号、`- * · •` 项目符号
- **`lib/utils.js` `extractCardText()` 块结束判断**：旧实现只认顶格行（`/^\S/`），会把同缩进的 `complete:` / `includeRuntimeContext:` 当成角色卡正文吞进来；改为按「键名缩进」比较，与 `lib/index.js` 的实现一致

### ✨ 新增
- **剧情选项开关补全**：面板「高级功能 → NSFW」区新增 `#tavern-plot-options` 复选框 + 状态提示（此前客户端只有 `querySelector` 查询、从未渲染该元素，所以开关永远找不到）
- **开关状态同步**：`nsfwEnabled` / `plotOptions` 在面板加载时同步进客户端 `state`，保存预设时才会写进 persona prefix；`plotOptions` 客户端默认值与服务端 `readState()` 保持一致（默认开启）

### 🎨 变更
- 「💾 保存预设」按钮更名为「💾 保存并注入」，与 README/教程措辞一致

### 🧪 测试
- 新增 `extractCardText` 的 `prefix:` 用例（新旧键名、块边界、超长截断）

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