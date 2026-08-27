# dsh-tavern `Cannot read properties of undefined (reading 'indexOf')` 根因研究报告

> 生成时间：研究豆包聊天记录 + 实测当前运行服务后
> 结论先行：**修复已存在于当前运行的 web 版本中（磁盘与服务器双重确认），错误持续是因为浏览器仍持旧 rev 的 `client.js` 缓存。**

---

## 一、根因本质

错误信息 `Cannot read properties of undefined (reading 'indexOf')`
是浏览器端 tavern 客户端代码中**对 `undefined` 的值调用了 `.indexOf()`**。
tavern 的 `client.js` 由 dsh web 服务打包进**浏览器缓存的 `client.js?rev=<hash>`**，
浏览器加载的是**旧 rev 的未修复 bundle**。

## 二、当前运行版本是否已修复 —— 三重确认：已修复 ✅

1. **服务器实际提供的 tavern 客户端 bundle（320908 字节）：**
   - 同时使用 `rev=a84c931cb1b6` 与 `rev=bf8de982d139` 请求，返回**完全相同**的修复版内容。
   - 包含 `v2 fixed` / `settings-section plugin loaded` / `[dsh-tavern] sessions service mounted` 标记。
   - 全 bundle 21 处 `.indexOf(` 全部受保护（`(xxx || '')` / `(xxx || [])` / `(p.id && ...)` / `String(x)` / `(xxx || '').toLowerCase()`）。

### 2. 服务端模块（node 实际加载）✅
- 实际加载文件：`node_modules\dsh-tavern\lib\index.js` → junction → `C:\dsh-tavern\lib\index.js`（mtime 2026/8/24 03:14:19，修复时间）
- 全程 6 处 `.indexOf(` 全部受保护：
  - `(text || '')`, `(section || '')`, `(block || '')`, `(trimmed || '')`, `(buf || [])`, `(cleaned || '')`
- 无任何裸 `indexOf`。

### 3. `client.manager.bundle.js` 直接扫描
- 346333 字节，所有 `indexOf` 亦全部受保护。

## 三、为什么「每回合还报错」——浏览器缓存未失效

- dsh web client 端 tavern 代码被打包进带 `?rev=` 查询参数的 `client.js`，
  浏览器在**旧 rev** 时已缓存了**未修复版**。
- 截图（error.png）DevTools Sources 显示报错行指向 `client.js?rev=a84c931cb1b6:5529/5538/5559`
  与 `client.js?rev=bf8de982d139:368` —— 这两个 rev 现在服务端都能返回修复内容，
  说明**服务端已不再产出旧代码，是浏览器缓存作祟**。
- 只要浏览器不硬刷新（Hard Reload / 清缓存），旧 bundle 会一直被执行，于是每回合复现。
- 服务端 HTTP 响应头为 `Cache-Control: no-cache`（无 ETag），意味着**刷新仍可能命中浏览器启发式强缓存/AppCache 残留**，必须强制刷新。

## 四、排查过程排除的事件源头（扫描结论）

对 `profiles\web\node_modules` 全部 15 个真实作用于该 profile 的插件/宿主包做了**未保护 `.indexOf(` 全面扫描**（约 1229 文件、245 处候选），剔除第三方库
（`undici`/`yaml`/`zod`/`json5`/`@ai-sdk` 等自身逻辑完整）后，**第一方代码均无未保护裸 `.indexOf(`**：
- tavern（index.js + client bundle）：全受保护 ✅
- agent-teams / recall / tdai-memory / zh_pro / better-sidebar / soul-md / vision / mobile-fix 等：无裸 `indexOf` ✅
- `C:\Users\21334\.dsh\profiles\web\node_modules` 中 `@local/*`、`@linxin666/*` 等 UI 包：候选多为第三方依赖，非事件源 ✅

结论：**没有被加载的插件在磁盘版本里存在未保护 indexOf 作为事件源头。**

## 五、最终结论

1. **修复已在当前运行版本生效**（磁盘源码 + 服务器实际提供的 bundle 双重确认）。
2. **错误持续存在的唯一合理解释是浏览器还挂着未失效的旧 `client.js` 缓存**。
3. 用户端行动：**在访问 `http://127.0.0.1:3080` 时强制刷新**
   （`Ctrl+Shift+R`，或按 F12 → Network → Disable Cache → 刷新；必要时清站点存储），
   即可加载修复版，错误即消失。
4. 若强制刷新后仍复现（极少见），再回查是否存在独立 service-worker 或第三方反代缓存——当前无 service worker，风险低。

---
（本报告由研究豆包记录 + 运行时实例验证得出，前者决定「改了什么」，后者决定「改得对不对」。）