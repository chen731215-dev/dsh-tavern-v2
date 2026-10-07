# dsh-tavern v1.9.2 更新说明

> **发布**: 2026-08-23 · GitHub + npm + DSH 插件市场
> **安装**: `dsh plugin add dsh-tavern`（将自动拉取 latest @1.9.2）

---

## ✨ 新增功能

### 🎭 可配置玩家名（本轮核心）
酒馆设置 → **记忆与总结**面板新增「**玩家名**」输入框。

| 作用 | 说明 |
|------|------|
| 替换 `{{user}}` 占位符 | 角色卡/世界书里的 `{{user}}` 自动替换为您填的名字（如：栎木） |
| 统一关系网节点 | 玩家名被正确归并为「你」节点，不再出现「你」和「栎木」两个实体 |
| 全局生效 | 配置存于 `tavern-state.json`，所有绑定酒馆预设的会话一致生效 |
| 完全兼容 | 不填时退回原「用户」默认行为，不影响未使用 `{{user}}` 的角色卡 |

**使用方法**：
1. 打开 DSH 设置 → 酒馆管理
2. 在「🎭 玩家名」输入框填入您的主角名（例如 `栎木`）
3. 点击「💾 保存设置」
4. 开始聊天——所有 `{{user}}` 自动变成您填的名字

---

## 🐛 修复内容

| 问题 | 修复 |
|------|------|
| 🔴 **用户安装即崩溃** | cordis.patch.yml / client.manager.bundle.js 硬编码 `@local/dsh-tavern` 本地别名，别人安装后 `Cannot find package` 启动崩溃——已统一为正规包名 `dsh-tavern` |
| 🔴 **`{{user}}` 被清空** | 插件把 `{{user}}`/`{{name}}`/`{{char}}` 替换为空字符串，玩家身份字段蒸发——改为替换为配置的玩家名 |
| 🟠 **关系网身份分裂** | 「你」与玩家名被识别为两个独立节点——玩家名正确归并为「你」节点 |
| 🟠 **deployment:persona 报错** | 世界书残留 `{{user}}` 导致 `unknown prompt variable` 报错——已全面清理 |
| 🟡 **玩家名保存不持久** | config API 未处理 playerName 读写——已补全 POST/GET，保存后真正持久化 |

---

## 🛡️ 隐私与安全

- 发布包 **8 个文件逐文件扫描无任何真实凭据**（无 npm/ghp/sk- token、无 apiKey 硬编码）
- 含真实 apiKey 的 `tavern-state.json` **在仓库外**（`~/.dsh/.agent-presets/`），不进 git、不进发布包
- 打包残留文件已清理（测试脚本、`.bak` 备份不再混入 tarball）

---

## 📦 发布包详情

- **npm**: `dsh-tavern@1.9.2`（tag: latest）
- **GitHub**: `chen731215-dev/dsh-tavern` (main)
- **文件数**: 11 · **大小**: 135KB
- **License**: CC-BY-NC-SA 4.0

---

*更新说明生成于 2026-08-23，由 dsh-tavern 发布流程产出。*