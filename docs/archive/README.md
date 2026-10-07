# docs/archive —— 历史文档归档区

> 🗄️ 放**已经过期但还想留着查**的东西。这里的文件**不参与发布**（`package.json.files` 不含 `docs/`）。

## 归档规则

- **根目录只留「现在还要用」的文档**：README / TUTORIAL / CONTRIBUTING / CHANGELOG / AGENTS。
- 一次性报告、事故复盘、旧版本发布说明 → 移到本目录。
- **CHANGELOG.md** 超过阈值（当前约 15 KB）时，把旧批次切到 `CHANGELOG-pre-<版本>.md`，根目录只留当前批次。
- 归档时**只搬家，不改写正文**（保留换行风格与历史笔误），需要说明就在文件顶部加说明头。

## 目录里都是什么

| 文件 | 说明 |
|---|---|
| `CHANGELOG-pre-2.6.md` | v2.5.5 及更早的 CHANGELOG（1741 行）。当前批次在根目录 `CHANGELOG.md` |
| `AUDIT-功能体检.md` | 面板控件 ↔ 代码的一次性交叉体检 |
| `ROOT_CAUSE_报告.md` | 历史故障的根因复盘 |
| `HANDOFF-会话绑定修复.md` | 旧交接文档 |
| `RELEASE_NOTES_v*.md` | 各版本的发布说明（已全部归档，**不再随发布包提供**） |
| `_probes/` | 一次性探针脚本。**含本机绝对路径且用了 `require`**（违反现行规范），**不要照抄** |
| `_legacy/` | 根目录遗留的 `client.manager.bundle.js` 旧副本（78 KB）。**真源码是 `lib/` 下那份**，改这份不生效 |

> ⚠️ `_probes/` 与 `_legacy/` 只是为了防止误用才挪走的，内容均已过期，不要作为参考范本。
