# Changelog

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
  type=agent-preset/selected   agentPreset=preset-mtyx98fa-pdsrh1 ← 用户确实在顶部选了
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