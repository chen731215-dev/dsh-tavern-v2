# dsh-tavern 项目规范（指针文件）

> 📌 **规范只有一份真源：[AGENTS.md](./AGENTS.md)。请直接读那一份。**
>
> 这里**刻意不复制**任何规则内容。历史上这份文件曾是 AGENTS.md 的完整拷贝，
> 结果时间和多达两处漂移成了过期版本号/包名 —— 教训就是不要把规范复制成第二份。
> 需要修规矩时，请改 `AGENTS.md`。
## 改代码前的四条速查

- **跑测试**：`npm test`（= `node tools/run-each-test.mjs`，逐文件独立判红）。**基线数字以输出为准，别背**；出现 `❔` 就是该文件一条断言都没跑（空跑即失败）
- **语法检查**：`npm run check`（扫 `lib/` `tests/` `tools/`，不用手写文件清单）
- **改样式后**：`npm run check:style`（内联事件必须恒为 0，其余指标只许降不许升）
- **动客户端渲染代码后**：`npm run check:integrity` + `npm run check:innerhtml`

## 最容易被违反的红线

- 模型输出进 innerHTML 前必须 `esc()`（含单引号）—— 这是 issue #14 修过的高危漏洞
- **绝不改写 DSH 会话日志**（zstd 多帧格式，不要解析也不要写）
- 测试一律用 tmpdir，**不要碰 `~/.dsh` 下的真实用户数据**
- 仓库里不许出现本机绝对路径 / token / 会话 id

完整规则、架构地图、重构阶段地图见 [AGENTS.md](./AGENTS.md)。CI 见 `.github/workflows/check.yml`。
