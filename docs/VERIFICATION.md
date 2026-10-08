# 验证记录（变异验证 / 差分验证）

> 复核意见（2026-10-08）：「新增 5 个护栏的变异验证只有口述、没留痕，建议把『变异 → 报红』对照写进 docs/」。
> 本文件就是那份留痕。**每条都是实际执行过的**：改坏 → 跑判据 → 看到红 → 恢复 → 看到绿。
>
> 为什么必须留痕而不是「我说验过」：**永真判据和真判据在绿灯下长得一模一样**。
> 只有「喂坏样本必须报红」这件事被记录下来，第三方才能判断这个护栏到底有没有牙。

全部命令可用 `node --test <文件>` 单独复现；「恢复后」= 从备份还原再跑一次。

## 一、护栏的变异验证

| # | 判据（护栏） | 注入的变异 | 期望 | 实测 |
|---|---|---|---|---|
| 1 | `client-integrity` ③ 卡片层级 | 把第 5 张卡片包进 `<div class="oops-wrapper">` | 报错 | ✅ 报「8 张卡片错层 + 1 处标签未配平」，exit 1 |
| 2 | `client-integrity` 空跑防护 | 让工具找不到任何分组 | 判失败（不是通过） | ✅ 打印「✅ 三件套全通过」前的空跑分支被改成失败（修过一次真 bug：曾空跑也报通过） |
| 3 | `render-escape` ⑥ 预设名必须 esc | 撤掉 `esc(pname)` | 报红 | ✅ 报「仍在裸拼」 |
| 4 | `render-escape` ⑦ 不许从 innerHTML 反查 | 恢复旧的字符串反查写法 | 报红 | ✅ 报「还在用 innerHTML 反查」 |
| 5 | `innerhtml-escape-ratchet` ① 基线只许减 | 注入一条新渲染路径（**新变量名** `node.displayName`、漏 esc） | 报红并点名 | ✅ 点名 `node.displayName` |
| 6 | `innerhtml-escape-ratchet` ⑥ 证据复查 | 删掉 `pName` 上游的 `esc()` | 报红 | ✅ 报「证据片段不存在」 |
| 7 | `innerhtml-escape-ratchet` ⑦ 只许一套转义 | 加一个 `esc2()` 第二套实现 | 报红 | ✅ 报「出现了第二套转义实现」 |
| 8 | `server-state-paths` ② 路径唯一写入点 | 在 `bindDshPaths` 之外插 `ROOT = '/tmp/evil'` | 报红 | ✅ 点名该行 |
| 9 | `slice-anchors` ① 切片目标不许搬走 | 把 `readSessionMemory` 改名（等价于搬走） | 报红并点名 | ✅ 点名 `readSessionMemory` |
| 10 | `tooling-integrity` ① 清单不许手抄 | `scripts.test` 改回 `node --test tests/...` 长链 | 报红 | ✅ 报「又变回手抄清单」 |
| 11 | `tooling-integrity` ④-b CI 命令必须可映射 | 工作流里把 `check:style` 写成 `check:typo` | 报红 | ✅ 报「映射不到 package.json 脚本」 |
| 12 | `tooling-integrity` ④-c CI 不许被中和 | 给某个 step 加 `continue-on-error: true` | 报红 | ✅ 报「护栏会被静默中和」 |
| 13 | `tooling-integrity` ④-d 本地镜像必须同命令集 | 从 `ci:local` 里删掉 `npm test` | 报红 | ✅ 报「只在 CI 跑：npm test」 |
| 14 | `tooling-integrity` ⑤ 文档不许手抄数字 | 往 `AGENTS.md` 塞回「23 个文件 / 454 项」 | 报红 | ✅ 报「又有手抄数字了」 |
| 15 | `tooling-integrity` ⑥ 全仓不许混合换行 | 把 `lib/utils.js` 一行改成裸 LF | 报红 | ✅ 报出文件与 CRLF/裸LF 计数 |
| 16 | `check-syntax` 全仓语法 | 在 `tests/render-escape.test.js` 注入 `const broken = ;` | 报红 | ✅ 报出文件与 `Unexpected token ';'` —— 注意这个文件**旧的 `--check` 手抄清单根本没覆盖** |
| 17 | `run-each-test` 空跑判据 | 在受限沙箱里跑（子进程起不来） | 判失败而不是假绿 | ✅ 27 个文件全标 `❔`，合计 0 ⇒ exit 1（并打印子进程输出尾部） |
| 18 | `innerhtml-escape-ratchet` ⑧ 六种 sink 盲测 | 六种 sink 各塞一个未转义样本 | 全部点名且类型正确 | ✅ 6/6 |
| 19 | `innerhtml-escape-ratchet` ⑨ 清单外入口 | 7 种清单外形态（insertAdjacentElement / writeln / dangerouslySetInnerHTML / outerHTML+= / DOMParser / eval / new Function） | 全部点名 | ✅ 7/7 |
| 20 | `innerhtml-escape-ratchet` ⑩ sandbox 断言 | ① 去掉 sandbox ② 加 allow-same-origin | 都要报 | ✅ 两种都报；现库通过 |
| 21 | `innerhtml-escape-ratchet` ⑪ 静态模板结构断言 | 往 `panelHTML` 注入未转义插值（sink 那层看不见） | 报红；esc 后不误报 | ✅ 报 `untrustedUserName`；esc 版不报 |
| 22 | `innerhtml-escape-ratchet` ⑥ 证据复查（世界书列表） | 撤掉 `esc(group.name)` | 报红 | ✅ 报「证据片段已不存在」 |
| 23 | 新判据的**发现力**（不是变异，是扩覆盖的实测结果） | 扩到「跨行拼接 + 单段 RHS」后重扫 | 应发现旧判据漏掉的真洞 | ✅ **2 处既有裸拼**（`presetName` / `agentPresetName` / `bannedWords.join` 进 textarea），v2.7.2 起就存在、旧基线 0 命中 —— 已修 |
| 24 | 新判据自身的两个 bug（自纠记录） | ① 提取器把引号内容整段丢掉 ② 旧实现 `segs.length<2 → continue` | — | ✅ 都已修：前者制造了 `panelHTML` 三元误报，后者是本轮最重要的覆盖洞 |

## 二、行为等价的差分验证（复核意见 Q2）

**做法**：`tests/fixtures/golden-prompt.json` 是在**重构前那一版**（`a816afd`）上生成的产物快照；
`tests/golden-prompt.test.js` 在当前版本上重跑同一组固定 fixture，要求**逐字节一致**。

```bash
# 在旧版上生成（一次性）
git worktree add --detach ../old a816afd
cp tests/golden-prompt.test.js ../old/tests/
cd ../old && UPDATE_GOLDEN=1 node --test tests/golden-prompt.test.js
cp tests/fixtures/golden-prompt.json ../dsh-tavern-v2/tests/fixtures/

# 在当前版本上比对（每次 npm test 都会跑）
node --test tests/golden-prompt.test.js
```

| 项 | 结果 |
|---|---|
| 采集项 | 11 项（世界书选条与渲染、卡正文提取、宏剔除、`sanitizePromptText`、预算估算、注入模式判定、阶段解析、拼接语义…） |
| 旧版 → 当前版 | ✅ **逐字节一致** |
| 变异验证 | 把 `buildWorldbookText` 的标题改掉两个字 ⇒ 立刻报红，并打印**第一处差异所在行**（golden / 现在 两行对照） |

**边界（豁免清单，写在测试文件里、且有护栏防它缩水）**：

- ❌ `apply(ctx)` 内部 `tavern:card` 的真实组装（需要完整 DSH ctx + 磁盘 fixture；装配体仍在 `apply` 里）
  —— 复核方核实：**这不是本轮等价性论证的漏洞**，因为 `apply` 本体在 `a816afd→HEAD` 只改了 5 行
  （且全部是 `S.` 前缀改写，1844 → 1843 行）；真正动过的是「顶层函数搬出去」。但要注意：
  **apply 文本没变 ≠ 行为没变**（它调用的那批函数被搬走了）⇒ 风险被精确定位到「被搬走的代码里哪几行真被改了」，
  由 §五 的对账工具（选 A）覆盖。把它抽成函数是 **S2-C2 的前置条件**，届时补这一环的 golden。
- ❌ `prompt-stats.json` 的数值（运行期产物、含时间戳）
- ❌ UI 交互与真实浏览器渲染（属 `AGENTS.md` §9.1 真机冒烟的职责）
- ❌ 时序与并发（切会话、异步总结回调落盘）
- ❌ LLM 调用与失败路径

## 三、哪些「验证」是不可复核的（如实列出）

- `_scratch/` 下的临时脚本**不入库**，第三方看不到 —— 所以「逐行对账零丢失」这条证据目前**不可复核**。
  这是复核方明确指出的问题，**尚未解决**：要么把对账脚本入库并配护栏，要么把这条证据降级为
  「过程中的辅助证据、非对外证据」（见文末「待裁定」）。对外可复核的证据 = 第二节的 golden 差分。
- **归属更正**：下面这条「函数清单核对」，以及本文档引用的 `-s ours` 决定性论证，
  **都是复核方独立做的，不是本仓作者做的** —— 上一版引用时没标出处，这里更正。
  · 函数清单核对：旧版 `lib/index.js` 有 195 个函数声明 → 新版全 `lib/**` 有 372 个，**旧有新无 = 0**，
    排除了「函数整体蒸发」这一类最严重的失败。
  · `-s ours` 论证：merge `3a24a77` 的父 = `bb3380c7`（我方）+ `f895d1d7`（远端 main）；
    远端 main 的 `^{tree}` = `85390b25` = `a816afd` 的 `^{tree}`；`is-ancestor(远端 main, HEAD) = true`；
    远端 main 从未移动 ⇒ 什么都没丢。
- 本文件记录的是**当时**的观察值。护栏后来改过判据的话，行号/措辞可能对不上 —— 以判据源码为准。

## 四、待裁定：对账脚本要不要入库

复核方的原话是「请你入库或贴出来，否则白名单这条永远不可复核」。两个选项：

- **A 入库**：把 `_scratch/s2c-verify.mjs` 提成 `tools/check-move-reconcile.mjs`，挂进 `npm run check` 并配护栏测试。
  代价：它依赖 `git show <旧 sha>:lib/index.js` 这个特定对象，且白名单是硬编码在脚本里的；
  收益：对账证据变成任何人可复跑。
- **B 降级**：明确定位为「一次性过程中的辅助证据，非对外复核证据」，对外只认 golden 差分（本仓自带、可复跑）。
  代价：丢掉「函数体逐行未被改写」这条强证据；收益：不把一个带硬编码白名单的脚本当权威工具维护。

**本仓目前的立场偏 B，但这条归复核方判** —— 若选 A，请一并说明白名单该怎么设计才不会被当成放水。
