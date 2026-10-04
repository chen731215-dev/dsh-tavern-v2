# dsh-tavern v2.5.4 更新说明

> 本篇覆盖 **2.5.2 / 2.5.3 / 2.5.4** —— 上一个发布版本是 **2.5.1**。
> 其中 2.5.3 修的是**会毁数据**的严重问题（把会话写坏到永久打不开），建议尽快升级。

---

## 🔴 2.5.3 —— 会话日志被写坏到**永久打不开**（严重）

### 症状

打开旧会话，直接报：

```
历史加载失败：stored session "session-XXXX" is corrupt:
  SessionFormatError: system/message requires a protected first surface head
```

不是"历史丢了"，而是日志被写成了**非法顺序**；内容还在，但 DSH 拒绝加载。

### 根因

DSH 加载 v4 会话日志时按顺序维护两条状态：

- `hasSurface`：出现过任一 surface 事件（`system/user/developer/assistant-message/tool-result`）；
- `head`：**只有**在「**还没有任何 surface 事件时**出现的 `system/message`」才会被登记为受保护 head。

于是「**先写了一条 assistant 消息、之后才出现 `system/message`**」的日志一定会抛错。

而本插件的 `seedGreetingMessage()` 正是这么干的：新会话第一轮就把角色卡开场白写成
`assistant/message`，排在真正的 `system/message` 之前。旧注释里那句"网关实测接受 assistant 打头"
说的是**模型网关**（那一层确实接受 `deepseek-official` / `bailian`）——
**会话日志层从来不允许**，两层规则被混为一谈，才出的这次事故。

凡是「先被种了开场白、之后再跑带系统提示的回合」的会话，第二轮写 `system/message` 时必炸。

### 修法

三处会写 surface 事件的入口，共用一道闸门 `canAppendGreetingSurface(session)`：
**日志里已经有 `system/message` 才允许再写**；并且确认"首个 surface 事件就是它"，
已经被写坏的日志不再去动。

| 入口 | 旧行为 | 现在 |
|---|---|---|
| `seedGreetingMessage()` | 新会话第一轮写 `assistant/message` ⇒ 弄坏日志 | 拒绝，一个字节都不写 |
| `appendGreetingPreamble()` | 补种 `user/message`（同为 surface 事件）⇒ 同样弄坏 | 拒绝 |
| 手动注入 API | 对"还没跑过回合"的会话直接写 ⇒ 弄坏 | **抛明确错误**："这个会话还没跑过任何回合…请先发一句话起头" |

### 如果你已经中招

损坏会话**可以救回来**，做法是删掉日志里那条抢跑消息：

1. 先备份 `session.v4.jsonl.zstd`（`<DSH_HOME>/sessions/<工作区>/<session-id>/`）；
2. 用 zstd 多帧解压日志（它是若干 JSON 行）；删掉**排在首个 `system/message` 之前**的
   `assistant/message`（特征：`source.provider === 'tavern'`、`source.model === 'character-card'`、
   `stream` 为空、`usage` 全 0）；
3. 重新压缩回去并原子替换。正常消息一条都不用动。

**怎么提前发现**：日志里"抢跑的 assistant 已经写了、但还没出现过 `system/message`"的会话
**当前能打开**，只是用户下次一发消息就会被判 corrupt —— 升级到 2.5.3+ 之后这种情况不会再产生。

---

## 🐛 2.5.2 —— 点「🎓 技能」的按钮后聊天输入框点不动

### 症状

在酒馆面板点 🎓 技能的「生成 / 刷新 / 删除 / 切形态」之后：页面其它部分一切正常，
但**聊天输入框点不动、光标不出来、打不了字**，只能重启 DSH。

### 根因（两个由点击引发的副作用，都在那四个按钮的收尾链路 `loadSkills()` 上）

1. `loadSkills()` **每次都打一次** `/api/tavern/tool-probe`，而那个接口会**真的往宿主工具注册表
   注册一个探针工具、再 dispose** —— 等于每点一次按钮就动一次宿主状态；
2. 「生成 / 切形态」**无条件重写 `SKILL.md`**（「酒馆默认」那份约 19 万字节），
   而 DSH 用 chokidar 监视 `<DSH_HOME>/skills` ⇒ **写一次盘 = 宿主重新加载一次技能清单**。

### 修法

1. 探测接口改**纯只读**（只报告 `hasToolsService` / `hasRegister` / `canRegister`，不注册任何东西）；
   客户端**一个页面生命周期只问一次**并缓存；
2. 生成技能时，内容与磁盘一致就**一个字节都不写**（返回 `unchanged: true`，mtime 一动不动
   ⇒ 宿主连事件都收不到）。

### 另加：输入框遮挡守卫（诊断 + 自愈）

每 1.5 秒用 `document.elementFromPoint` 体检一次输入框位置：

- 命中的是**酒馆自己的**浮层（id/class 带 `tavern`）⇒ 自动让它对点击透明，并把结果写进技能卡片状态行；
- 命中的是**别人的**元素 ⇒ **只报告名字，绝不动别人的 DOM**（把证据留给定位）；
- 设置页正开着时跳过（那时输入框被页面盖住属于正常布局）。

下次再遇到不必重启：状态行/控制台会直接说出是谁挡住了输入框。

---

## 🧹 2.5.4 —— 删除已退役的「自动播种开场白」

2.5.3 已经把它改成 fail-closed（在新会话上必然拒绝、一个字节都不写）—— 它永远不会生效了。
既然退役就连根删掉，不留会误导后人的死代码：

| 删除 | 原来干什么 |
|---|---|
| `seedGreetingMessage()` | 把开场白当首条 `assistant/message` 写进会话日志（**就是把会话写坏的那段**） |
| `seedGreetingForSession()` | 上面的评估层（开关 / 子会话 / 判重 / 回合号对账） |
| `armGreetingSeed()` | 安装 `agent/created`、`agent/inbox/inserted`、`agent/request-error` 三个监听去触发播种 |
| `appendGreetingPreamble()` + `GREETING_PREAMBLE` | 撞 400 时补种一条 user 引导（同为 surface 事件） |
| `greetingSeeds` / `greetingWatched` / `greetingDowngraded` / `greetingIdsOf()` | 播种用的去重与记账 |
| `hasLiveUserMessage()` / `closeDanglingBracket()` | 只被上面这些调用的辅助函数 |
| `noteGreetingRejected()` | 记录"模型网关拒绝 assistant 打头"（前提已作废） |
| 状态位 `greetingSeedEnabled` | 开关。整个字段不再被读写（配置文件里的残留键被忽略，无需清理） |

**保留**：闸门 `canAppendGreetingSurface()` + 手动注入路径；并从 `armGreetingSeed()` 里
**拆出 `armLiveAgents()`** —— 只做活会话登记（手动注入 API 要按 `sessionId` 找到 Agent）。
登记与播种原本在同一个监听里，直接删会把登记一起带走、注入按钮就会报"找不到会话"。

---

## ⚠️ 行为变化（升级前必读）

- **新会话不再自动出现角色卡开场白**（这个能力在当前 DSH 版本下不可能合法实现）。
  开场白改由面板 **「📌 开场白 → ➕ 注入开场白到会话末尾」** 注入，
  且要求该会话**已经跑过至少一个回合**（否则服务端会明确拒绝并说明原因）。
- `tavern-state.json` 里的 `greetingSeedEnabled` 不再被读取（留着无害，不用清理）。

---

## 怎么升级

1. 在 DSH 的插件/市场里把 `dsh-tavern` 升到 **2.5.4**（或 `npm i dsh-tavern@2.5.4`）；
2. **重启一次 DSH**（客户端包也更新了，光刷新页面不够保险）。

## 兼容性

`peerDependencies` 用一条覆盖所有已发布运行时的联合范围：

```
"@deepseek-ai/dsh-client-runtime":
  "^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-alpha.2 || ^0.1.5-rc.1 || ^0.2.0-rc.2"
```

`0.1.0-rc.6` → `0.2.0` 全部通过（含各预发布），**不再需要在 profile 的
`compatibility.json` 里手工加精确版本豁免**。

## 验证

- 全量回归 **403/403 通过**；`greeting-seed.test.js` 含闸门真值表、**事故现场重演**
  （本地镜像 DSH 的 head 校验：旧行为必被判 corrupt、新行为通过）、手动注入决策，
  以及两条源码护栏（"播种 API 必须整体不存在"、"写入点必须过闸门"）。
- 关键路径写入前都会校验：闸门（`canAppendGreetingSurface`）、
  `assistant/message` 的 settlement 形状（`turn`/`step` 为安全整数且 `stream` 是数组）。
