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

- ❌ `apply(ctx)` 内部 `tavern:card` 的真实组装（需要完整 DSH ctx + 磁盘 fixture；装配体仍在 `apply` 里，
  等 S2-C2 抽成函数后补）
- ❌ `prompt-stats.json` 的数值（运行期产物、含时间戳）
- ❌ UI 交互与真实浏览器渲染（属 `AGENTS.md` §9.1 真机冒烟的职责）
- ❌ 时序与并发（切会话、异步总结回调落盘）
- ❌ LLM 调用与失败路径

## 三、哪些「验证」是不可复核的（如实列出）

- `_scratch/` 下的临时脚本**不入库**，第三方看不到 —— 所以「逐行对账零丢失」这条证据目前**不可复核**。
  这是复核方明确指出的问题；替代证据是本节第二部分（golden 差分）+ `slice-anchors` 的函数清单核对
  （旧版 195 个函数声明 → 新版全 `lib/**` 372 个，**旧有新无 = 0**，排除「函数整体蒸发」）。
- 本文件记录的是**当时**的观察值。护栏后来改过判据的话，行号/措辞可能对不上 —— 以判据源码为准。
