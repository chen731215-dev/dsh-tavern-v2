// HTTP 路由注册（S2-C2 后半 / task-7）
//
// 这些路由原先内联在 `lib/index.js` 的 `apply(ctx)` 里（同一个 1400+ 行的数组）。
// 现在按功能块搬到这里，`apply` 只留一次 `registerRoutes(ctx, routeDeps)` 调用。
//
// ★ 依赖一律由 `deps` 显式传入，本文件**不** import lib/index.js（AGENTS §5 第 5 条：禁止循环依赖）。
// ★ 三个**访问器**依赖是必需的语义改写（不是风格选择）：`lastSessionId` / `lastCwd` 是 index.js 的
//   模块级 `let`，`active` 是 apply 作用域里的段注册句柄 —— 跨模块传"值"会分叉（它们被注入段的
//   text 回调与这里同时读写/读）。`lastSessionId` 的 memory-isolation 锚点也不许它改名或进 state.js。
// ★ 注册顺序 = 原数组顺序：index.js 先 `registerRoutes(...)`（已搬走的部分），
//   再把还没搬的条目内联注册 ⇒ 同路径同方法的路由顺序不变。
// ★ 本文件被 `tests/routes-deps-scope.test.js`（作用域完备性）盯着：任何自由标识符都必须能解析到
//   「形参 / 区内局部 / 模块级 / 真全局」—— 这是 v1 那次 `ReferenceError: json is not defined` 的产物。
//
// 真源规范见仓库根目录 AGENTS.md §5。

import fs from 'node:fs'
import path from 'node:path'

/**
 * 注册本插件全部 HTTP 路由。
 * @param {object} ctx 插件上下文（用到 ctx.webServer.register / ctx.get）
 * @param {object} deps 依赖对象（index.js 模块级函数/常量 + 跨模块可变状态访问器）
 */
export function registerRoutes(ctx, deps) {
  const routes = [
    ...routesGroup1(ctx, deps),
    ...routesGroup2(ctx, deps),
    ...routesGroup3(ctx, deps),
    ...routesGroup4(ctx, deps),
  ]
  for (const route of routes) ctx.webServer.register(route)
}

/** 第 1 块路由（逐字搬自 lib/index.js；见本文件头部说明）。 */
function routesGroup1(ctx, deps) {
  const {
    BINDING_SOURCE_PANEL,
    S,
    SKILL_NAME_RE,
    applyPresetDeclarations,
    composePresetDeclarationBlock,
    createPreset,
    deleteAgentPreset,
    deletePresetSkill,
    extractCardText,
    getCtxService,
    getLastSid,
    getPresetDir,
    getSessionPresetId,
    json,
    listAgentPresets,
    listSkillsOnDisk,
    nativePresetRoster,
    presetSkillNames,
    readBody,
    readDeclarationMode,
    readPresetFiles,
    readState,
    readWorldbook,
    refresh,
    renderAllPresetDeclarations,
    renderPresetBundleFiles,
    resolveWbIsFull,
    setLastSid,
    setPresetSkillNames,
    skillNameForPreset,
    skillsRoot,
    writeBindingEntry,
    writeDeclarationMode,
    writePresetBundle,
    writePresetSkill,
    writeState,
  } = deps
  return [
  // 获取后端当前会话ID（确保前后端一致）
  // 注意：只返回 DSH 注入上下文里的真实会话（lastSessionId）。
  // 前端通过 ctx.sessions（DSH 官方会话服务）获取"当前 UI 激活会话"并显式传入 sessionId，
  // 后端不再自行兜底猜测会话（否则切换会话后会错误返回旧会话的数据）。
  {
    kind: 'exact',
    path: '/api/tavern/current-session',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sid = url.searchParams.get('sessionId') || getLastSid() || ''
      if (sid) setLastSid(sid)
      // ★ 返回 DSH 权威预设（读取会话事件流/header → bindings → default）
      const pid = sid ? getSessionPresetId(sid) : 'default'
      json(res, 200, { ok: true, sessionId: sid, presetId: pid })
    }
  },
  // ★ 新增：预设管理 ★
  {
    kind: 'exact',
    path: '/api/tavern/presets',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET') {
        try {
          const sessionId = url.searchParams.get('sessionId') || getLastSid()
          if (sessionId) setLastSid(sessionId)
          // 使用所有 DSH 原生 agent 预设（含酒馆生成的深渊区/编辑区等）
          const presets = listAgentPresets()
          // ★ 为每个预设补充概要（角色卡/世界书/预设模块数），供面板展示每个预设的构成
          for (const p of presets) {
            try {
              const pf = readPresetFiles(p.id)
              p.cardChars = pf.agentYml ? extractCardText(pf.agentYml).length : 0
              p.charCount = (pf.characters || []).length
              const wb = readWorldbook(p.id)
              p.wbCount = (wb.groups || []).reduce((sum, g) => sum + ((g.entries || []).filter(e => e.enabled !== false).length), 0)
              const mods = (pf.presets || []).reduce((sum, pr) => sum + ((pr.modules || []).filter(m => m.enabled !== false).length), 0)
              p.modCount = mods
              p.displayNames = (pf.characters || []).filter(c => c.enabled !== false).map(c => c.name).filter(Boolean).slice(0, 3)
            } catch {}
          }
          let currentPresetId = getSessionPresetId(sessionId)
          // 兼容旧绑定：default 映射到 tavern-lite 目录
          if (currentPresetId === 'default') currentPresetId = 'tavern-lite'
          const currentPreset = presets.find(p => p.id === currentPresetId)
          json(res, 200, { ok: true, presets, currentPresetId, currentPresetName: currentPreset?.name || '默认预设', defaultPresetId: 'tavern-lite' })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const p = createPreset(body.name, body.copyFrom)
            // 如果传入了 sessionId，自动绑定到新预设（用户刚创建完预设 ⇒ 显式操作）
            if (body.sessionId) {
              writeBindingEntry(body.sessionId, { mode: 'preset', presetId: p.id, source: BINDING_SOURCE_PANEL })
            }
            json(res, 200, { ok: true, preset: p, presets: listAgentPresets() })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
    // Agent 预设列表 / 批量删除（直接管理 DSH agent 预设目录）
    {
      kind: 'exact',
      path: '/api/tavern/agent-presets',
      handler: (req, res) => {
        if (req.method === 'GET') {
          try {
            json(res, 200, { ok: true, presets: listAgentPresets() })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          return
        }
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            try {
              const ids = Array.isArray(body.ids) ? body.ids : []
              const results = []
              for (const id of ids) {
                results.push(deleteAgentPreset(String(id)))
              }
              json(res, 200, { ok: true, results, presets: listAgentPresets() })
            } catch (e) { json(res, 500, { ok: false, error: e.message }) }
          }, (e) => json(res, 400, { ok: false, error: e.message }))
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      }
    },

  // ★ 预设声明 dry-run：只**渲染**「把这些酒馆预设声明成 DSH 原生预设」的 patch 块，
  //   并告诉你目标文件是哪个、现有内容会被追加还是整块替换。**一个字节都不写**。
  //   为什么要这一步：本版 DSH 不再读 `.agent-presets/` 目录（見 renderPresetDeclaration
  //   的注释），只有声明行才进顶部选择器。真写盘是破坏性操作（写坏 = DSH 起不来），
  //   所以必须先让人看着 dry-run 点头。
  {
    kind: 'exact',
    path: '/api/tavern/preset-declarations',
    handler: (req, res) => {
      if (req.method === 'GET') {
        const decls = renderAllPresetDeclarations()
        ;(async () => {
          try {
            const r = applyPresetDeclarations({ dryRun: true })
            // ★ 名册是「DSH 顶部选择器里到底有什么」的权威答案：
            //   把「哪些酒馆预设还没被声明」直接说出来，用户才不用对着 not-found 猜。
            const roster = await nativePresetRoster(ctx)
            const declaredIds = decls.filter(d => d.ok).map(d => d.agentId)
            json(res, r.ok ? 200 : 500, {
              ...r,
              mode: readDeclarationMode(),
              declarations: decls.map(d => ({ id: d.id, agentId: d.agentId || '', ok: !!d.ok, rowId: d.rowId || '', error: d.error || '' })),
              block: composePresetDeclarationBlock(decls).text,
              roster: roster.ok ? roster.ids : null,
              rosterReason: roster.ok ? '' : roster.reason,
              missingFromRoster: roster.ok ? declaredIds.filter(id => !roster.ids.includes(id)) : null,
            })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        })()
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          // ★ 默认 dry-run：只有 { apply: true, confirm: true } 才真的写盘；
          //   { remove: true, confirm: true } 摘掉受管块（回滚）。
          const r = applyPresetDeclarations({
            dryRun: b.apply !== true,
            confirm: b.confirm === true,
            remove: b.remove === true,
          })
          // ★ 开关跟着结果走：写成功 = 进入 patch 模式（此后预设增删改会自动同步声明）；
          //   摘除成功 = 回到 off（此后一个字节都不碰用户配置）。
          let mode = readDeclarationMode()
          if (r.ok && r.wrote) mode = writeDeclarationMode(b.remove === true ? 'off' : 'patch').mode
          json(res, r.ok ? 200 : (r.wrote === false && r.error === 'confirm-required：写盘必须显式 confirm:true' ? 400 : 500), Object.assign({}, r, { mode }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // ★ 路线 B：生成 DSH bundle（`package.json` + `cordis.patch.yml`），交 plugin_manager 安装。
  //   GET = dry-run（只看会生成什么）；POST 只有 {apply:true, confirm:true} 才落到
  //   `<DSH_HOME>/tavern-data/preset-bundle/`（酒馆自己的数据目录，绝不进 profile）。
  {
    kind: 'exact',
    path: '/api/tavern/preset-bundle',
    handler: (req, res) => {
      if (req.method === 'GET') {
        try {
          const r = writePresetBundle({ dryRun: true })
          json(res, r.ok ? 200 : 500, Object.assign({}, r, { mode: readDeclarationMode(), packageJson: renderPresetBundleFiles().packageJson }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          // { off: true } = 只关开关（不动已经生成的 bundle 目录，留给人自己决定删不删）
          if (b.off === true) {
            json(res, 200, { ok: true, wrote: false, mode: writeDeclarationMode('off').mode })
            return
          }
          const r = writePresetBundle({ dryRun: b.apply !== true, confirm: b.confirm === true })
          let mode = readDeclarationMode()
          if (r.ok && r.wrote) mode = writeDeclarationMode('bundle').mode
          json(res, r.ok ? 200 : (String(r.error).startsWith('confirm-required') ? 400 : 500), Object.assign({}, r, { mode }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // ── 技能（Skill）：列表 / 生成 / 手动绑定 / 删除 ────────────────
  //   GET  /api/tavern/skills?presetId=…  → 该预设已绑定的 + 磁盘上所有可用 skill
  //   POST /api/tavern/skills/generate    { presetId, includeFull? }
  //   POST /api/tavern/skills/bind        { presetId, skills: [...] }（手动选择）
  //   POST /api/tavern/skills/delete      { presetId }
  {
    kind: 'exact',
    path: '/api/tavern/skills',
    handler: (req, res) => {
      try {
        const u = new URL(req.url, 'http://placeholder')
        const presetId = (u.searchParams.get('presetId') || '').trim()
        const name = presetId ? skillNameForPreset(presetId) : ''
        const dir = name ? path.join(skillsRoot(), name) : ''
        const file = dir ? path.join(dir, 'SKILL.md') : ''
        const exists = !!(file && fs.existsSync(file))
        const st = readState()
        json(res, 200, {
          ok: true,
          skillsRoot: skillsRoot(),
          skillsDirOverride: String(st.skillsDir || ''),
          autoGenerate: st.skillAutoGenerate !== false,
          autoFull: st.skillAutoFull === true,
          hint: st.skillHint !== false,
          style: st.skillStyle === 'index' ? 'index' : 'instructions',
          presetId,
          bound: presetId ? presetSkillNames(presetId) : [],
          generated: name ? { name, dir, file, exists, bytes: exists ? fs.statSync(file).size : 0 } : null,
          available: listSkillsOnDisk(),
        })
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },
  {
    kind: 'exact',
    path: '/api/tavern/skills/generate',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          const presetId = String(b.presetId || '').trim()
          if (!presetId) { json(res, 400, { ok: false, error: 'presetId-required' }); return }
          if (!getPresetDir(presetId)) { json(res, 404, { ok: false, error: 'preset-not-found' }); return }
          const st = readState()
          const includeFull = typeof b.includeFull === 'boolean' ? b.includeFull : (st.skillAutoFull === true)
          const style = (b.style === 'index' || b.style === 'instructions')
            ? b.style
            : (st.skillStyle === 'index' ? 'index' : 'instructions')
          const r = writePresetSkill(presetId, { includeFull, style })
          if (!r.ok) { json(res, 500, r); return }
          const cur = presetSkillNames(presetId)
          if (!cur.includes(r.name)) setPresetSkillNames(presetId, cur.concat([r.name]))
          json(res, 200, Object.assign({}, r, { skillsRoot: skillsRoot(), bound: presetSkillNames(presetId), includeFull, style }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  {
    kind: 'exact',
    path: '/api/tavern/skills/bind',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          const presetId = String(b.presetId || '').trim()
          if (!presetId) { json(res, 400, { ok: false, error: 'presetId-required' }); return }
          const wanted = Array.isArray(b.skills) ? b.skills : []
          const bad = wanted.map(String).filter(n => n && !SKILL_NAME_RE.test(String(n).trim()))
          if (bad.length) { json(res, 400, { ok: false, error: 'invalid-skill-name: ' + bad.join(',') }); return }
          const r = setPresetSkillNames(presetId, wanted)
          if (!r.ok) { json(res, 404, r); return }
          json(res, 200, { ok: true, presetId, bound: r.skills })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  {
    kind: 'exact',
    path: '/api/tavern/skills/delete',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          const presetId = String(b.presetId || '').trim()
          if (!presetId) { json(res, 400, { ok: false, error: 'presetId-required' }); return }
          const r = deletePresetSkill(presetId)
          const cur = presetSkillNames(presetId).filter(n => n !== r.name)
          setPresetSkillNames(presetId, cur)
          json(res, r.ok ? 200 : 500, Object.assign({}, r, { bound: presetSkillNames(presetId) }))
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // ── 工具注册探测（只读 + 一次可回滚的注册尝试）────────────────────
  //   GET /api/tavern/tool-probe
  //
  //   为什么需要它：skill 机制要"模型自己会加载"，就得让**模型看到 skill 工具**（或我们自己的
  //   查询工具）。而工具清单由该会话的 agent 预设组合决定 —— 实测酒馆预设的组合里没有
  //   `dsh-tool-skill`，所以那些会话根本没有 skill 工具（用户实测反馈：模型回答"我这边没有
  //   skill 加载工具"）。DSH 的工具注册表是**宿主 + 按 scope 分层**的（dsh-tools README.zh.md:81
  //   与 dsh-skill README.zh.md:84：*宿主行与 repository 插件落入全局层*，读取时合并全局层与
  //   观察 scope 的链）—— 也就是说，**酒馆这种 host/repository 插件注册的工具应当对所有会话可见**。
  //   唯一未知是：酒馆的 fiber 能不能拿到 `ctx.tools`（`dsh-tools` 是否在 profile 层也挂载）。
  //   本探测就是回答这个问题：拿到 → 下一步直接在酒馆里注册查询工具（零预设改动、零新包）；
  //   拿不到 → 说明 `dsh-tools` 只在预设层，只能改预设组合（那时也要先给用户看预览）。
  //   探测本身**不留下任何痕迹**：注册成功后立刻 dispose。
  {
    kind: 'exact',
    path: '/api/tavern/tool-probe',
    handler: (req, res) => {
      const out = {
        ok: true,
        hasToolsService: false,
        hasRegister: false,
        hasSchemas: false,
        canRegister: false,
        registerSkipped: false,
        registeredProbe: false,
        sampleTools: null,
        registerError: null,
      }
      try {
        const tools = getCtxService(S.activePluginCtx, 'tools')
        out.hasToolsService = !!tools
        if (tools) {
          out.hasRegister = typeof tools.register === 'function'
          out.hasSchemas = typeof tools.schemas === 'function'
          // 尽量列几个已有工具名，确认这确实是工具注册表（而不是别的同名服务）
          for (const fn of ['list', 'names', 'all']) {
            try {
              const v = typeof tools[fn] === 'function' ? tools[fn]() : null
              if (Array.isArray(v)) {
                out.sampleTools = v.slice(0, 12).map(t => (t && (t.name || t)) || String(t))
                break
              }
            } catch {}
          }
          // ★ 这里原本会**真的注册**一个探针工具、再立刻 dispose（注释写的"探针不留痕"）。
          //   改成**纯只读**，原因有两条：
          //     1) 这个探测早就把答案拿到了 —— ctx.tools 在不在、有没有 register()，看上面两个
          //        布尔量就够，不需要真去注册一次；
          //     2) 它已经被客户端**按刷新频率**调用：`loadSkills()` 是「🎓 技能」四个按钮
          //        （生成 / 刷新 / 删除 / 切形态）的收尾动作，也就是说每点一次按钮就往宿主工具
          //        注册表里插一个探针工具再回收一次。用户实测：点完那些按钮聊天输入框会失焦、
          //        点不动（页面其它部分正常，只能重启 DSH）。注册/回收都带副作用，让"刷技能卡片"
          //        这种只读操作去动宿主状态是不划算的，所以这里彻底改成不注册。
          out.canRegister = out.hasRegister
          out.registerSkipped = true
          out.registerError = null
        }
      } catch (e) {
        out.ok = false
        out.error = String((e && e.message) || e)
      }
      json(res, 200, out)
    }
  },
  // ── 本会话「设定注入量」覆盖：全量 / 跟随规则 ──────────────────────
  //   POST /api/tavern/wb-inject-session { sessionId, mode: 'full'|'follow'|'' }
  //     '' 或省略 mode = 清掉覆盖（回到全局 wbInject + 卡设定）
  //   为什么单独一条：用户要"这一场（比如写高强度剧情）确保模型看得到全部设定，
  //   其他场省 token"。全局开关做不了这件事 —— 它一开就所有会话都费 token。
  {
    kind: 'exact',
    path: '/api/tavern/wb-inject-session',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const b = body || {}
          const sid = String(b.sessionId || '').trim() || getLastSid() || ''
          if (!sid) { json(res, 400, { ok: false, error: 'sessionId-required' }); return }
          const mode = (b.mode === 'full' || b.mode === 'follow') ? b.mode : ''
          const state = readState()
          if (!state.wbInjectBySession || typeof state.wbInjectBySession !== 'object') state.wbInjectBySession = {}
          if (mode) state.wbInjectBySession[sid] = mode
          else delete state.wbInjectBySession[sid]
          writeState(state)
          try { refresh(ctx) } catch {}
          const wb = readWorldbook(getSessionPresetId(sid))
          json(res, 200, {
            ok: true,
            sessionId: sid,
            override: state.wbInjectBySession[sid] || '',
            effective: resolveWbIsFull(state, wb, sid) ? 'full' : 'keyword',
            globalWbInject: state.wbInject || 'follow',
            cardInjectMode: wb.injectMode === 'keyword' ? 'keyword' : 'full',
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 绑定预设到会话：POST /api/tavern/bind-preset
  ]
}
/** 第 2 块路由（逐字搬自 lib/index.js；本组 9 条：/api/tavern/bind-preset, /api/tavern/unbind-preset, /api/tavern/preset, /api/tavern/preset/delete, /api/tavern/preset/rename, /api/tavern/preset/mode, /api/tavern/bind, /api/tavern/read, /api/tavern/save；见本文件头部说明）。 */
function routesGroup2(ctx, deps) {
  const {
    BINDING_SOURCE_PANEL,
    PRESETS_META,
    agentPresetIdFor,
    cleanObjectStrings,
    deletePreset,
    deletePresetSkill,
    extractCardText,
    findSessionFile,
    getLastCwd,
    getLastSid,
    getPresetDir,
    getSessionPresetId,
    isCardInjected,
    json,
    listPresets,
    presetDisplayNameFor,
    readBody,
    readDshDefaultAgentPresetId,
    readPresetFiles,
    readPresetsMeta,
    readSessionLines,
    readState,
    readWorldbook,
    rebuildAllPresetDescriptions,
    refresh,
    renamePreset,
    resolveWbIsFull,
    selectNativeAgentPreset,
    setLastCwd,
    setLastSid,
    setSessionPreset,
    syncDeclarationsBestEffort,
    syncPresetSkillAfterSave,
    writeBindingEntry,
    writePresetFiles,
    writePresetNameFile,
  } = deps
  return [
  {
    kind: 'exact',
    path: '/api/tavern/bind-preset',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then(async (body) => {
        try {
          // ★ 收紧（2026-09-27，装机版已有，此处并入仓库）：写绑定的入口绝不猜会话 ——
          //   漏传 sessionId 直接 400，不再兜底 lastSessionId（全进程全局量，可能指向
          //   别的会话 ⇒ 绑错会话 = 串台写）。
          const sessionId = String(body.sessionId || '').trim()
          const presetId = body.presetId
          if (!sessionId || !presetId) { json(res, 400, { ok: false, error: '缺少会话ID或预设ID（sessionId/presetId 必传）' }); return }
          // ★ P0-1：presetId 传 'none' 即解绑本会话（写 {mode:'none'} 硬空），
          //   方便面板复用同一个接口；也有独立的 /api/tavern/unbind-preset。
          if (presetId === 'none') {
            json(res, 200, { ok: true, sessionId, presetId: '', unbound: true, binding: writeBindingEntry(sessionId, { mode: 'none' }) })
            return
          }
          setLastSid(sessionId)
          // ★ 检测会话是否已开始（是否有 user 消息）：已开始的会话 agent 预设本体被 DSH 锁定
          //   （agentPreset 只在空白会话可切换）。返回 locked 标记，前端据此给出明确提示。
          let started = false
          try {
            const file = findSessionFile(sessionId)
            if (file) {
              const lines = readSessionLines(file)
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const o = JSON.parse(lines[i])
                  if (o && (o.type === 'user/message' || o.type === 'user/input' || o.type === 'agent/message')) { started = true; break }
                } catch {}
              }
            }
          } catch {}
          // 说明：仍然**不**直接改写 DSH 会话日志文件（**曾**有一个 writeSessionLines() 会重写整个 zstd 会话日志，已随本功能删除；**不要**再引入这种写法
          // seq/帧处理不当会破坏 DSH 会话 ⇒ "corrupt session log"）。改走 DSH 自己的服务：
          // `agentPresets.select(agent, presetId)` 由 DSH 负责把 `agent-preset/selected`
          // 追加进**本会话**的事件流 —— 这就是「会话绑定 = 该会话的原生 agentPreset」，
          // 也是空白新会话（还没发过消息）就能绑定的原因。
          // ★ 顺序：先原生 select（正路），再写 bindings（兼容兜底：原生不可用 / 会话已开跑时,
          //   至少保住世界书与记忆的跟随）。两者都以 sessionId 为键 ⇒ 天然会话隔离。
          const native = await selectNativeAgentPreset(ctx, sessionId, presetId)
          // ★ 账本里存**DSH 侧 id（目录名）**，不存酒馆别名：'default' 在本插件里同时是
          //   「不注入」的哨兵值，存别名会让「绑了酒馆默认」被解析成「没绑」（卡不注入）。
          //   面板仍然用酒馆 id 通信（响应里 presetId 原样回），只有落盘的这份用目录名。
          writeBindingEntry(sessionId, { mode: 'preset', presetId: agentPresetIdFor(presetId), source: BINDING_SOURCE_PANEL })
          const preset = listPresets().find(p => p.id === presetId)
          json(res, 200, {
            ok: true, presetId, presetName: preset?.name || presetId, started,
            native,
            nativeOk: native.ok === true,
            // locked = 会话已开跑，DSH 拒绝换卡本体（原生闸门），面板据此给准确提示
            locked: native.reason === 'locked' || (native.started === true && native.ok !== true),
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 解绑本会话：POST /api/tavern/unbind-preset
  // ★ P0-1：写 {mode:'none'} —— 硬空，此后不看 creation、不看任何 fallback。
  {
    kind: 'exact',
    path: '/api/tavern/unbind-preset',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then(async (body) => {
        try {
          const sessionId = body.sessionId || getLastSid()
          if (!sessionId) { json(res, 400, { ok: false, error: '缺少会话ID，请先发一条消息再试' }); return }
          // ★ 解绑 = 把会话**原生**交还给 DSH 的部署默认预设（settings.yaml 的
          //   agent-presets.default，实测 standard）。只写 {mode:'none'} 的话，
          //   顶部选择器仍显示酒馆卡、DSH 侧仍挂着它 —— 那不是解绑，只是酒馆自己不再注入。
          //   会话已开跑时原生换不了（DSH 锁定）⇒ 该次失败如实回报，bindings 的硬空仍生效，
          //   于是「不再注入」这条语义在任何情况下都成立。
          const native = await selectNativeAgentPreset(ctx, sessionId, readDshDefaultAgentPresetId())
          json(res, 200, {
            ok: true, sessionId, binding: writeBindingEntry(sessionId, { mode: 'none' }),
            native, nativeOk: native.ok === true,
            restoredTo: native.ok ? native.presetId : '',
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 读取单个预设：GET /api/tavern/preset?id=xxx
  {
    kind: 'exact',
    path: '/api/tavern/preset',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET') {
        try {
          const presetId = url.searchParams.get('id') || getSessionPresetId(getLastSid())
          const files = readPresetFiles(presetId)
          const meta = readPresetsMeta().presets.find(p => p.id === presetId)
          json(res, 200, { ok: true, presetId, name: meta?.name || '', ...files, cardChars: extractCardText(files.agentYml).length })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const presetId = body.id || body.presetId || getSessionPresetId(getLastSid())
            const dir = writePresetFiles(presetId, body.agentYml, body.presetYml)
            refresh(ctx)
            json(res, 200, { ok: true, dir, presetId })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // 删除预设：POST /api/tavern/preset/delete {id}
  {
    kind: 'exact',
    path: '/api/tavern/preset/delete',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          // 删预设时顺带清掉它生成的 skill —— 否则 ~/.dsh/skills 会慢慢堆一堆孤儿 skill，
          // 而且它们还留在 skill 目录里被模型整轮看到（比"删了预设却还在"更烦人）。
          let skillCleanup = null
          try {
            const pid = String((body && body.id) || '').trim()
            if (pid) skillCleanup = deletePresetSkill(pid)
          } catch (e) { skillCleanup = { ok: false, error: String((e && e.message) || e) } }
          deletePreset(body.id)
          json(res, 200, { ok: true, presets: listPresets(), skill: skillCleanup })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 重命名预设：POST /api/tavern/preset/rename {id,name}
  {
    kind: 'exact',
    path: '/api/tavern/preset/rename',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const p = renamePreset(body.id, body.name)
          json(res, 200, { ok: true, preset: p })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 设置预设模式（roleplay/creative）
  {
    kind: 'exact',
    path: '/api/tavern/preset/mode',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const meta = readPresetsMeta()
          const p = meta.presets.find(x => x.id === body.id)
          if (!p) throw new Error('预设不存在')
          p.mode = body.mode === 'creative' ? 'creative' : 'roleplay'
          fs.writeFileSync(PRESETS_META, JSON.stringify(meta, null, 2), 'utf8')
          json(res, 200, { ok: true, preset: p })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // ★ 新增：会话绑定 ★
  {
    kind: 'exact',
    path: '/api/tavern/bind',
    handler: (req, res) => {
      if (req.method === 'GET') {
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || getLastSid() || ''
          const presetId = getSessionPresetId(sessionId)
          const presetMeta = readPresetsMeta().presets.find(p => p.id === presetId)
          // 顺带把「本会话设定注入量」一起给面板：面板要么显示"这一场是全量"，
          // 要么显示"跟随规则"——别让它自己猜（猜错了用户就以为设定没进去）。
          const st0 = readState()
          const wb0 = readWorldbook(presetId)
          const wbOverride = (st0.wbInjectBySession && sessionId) ? (st0.wbInjectBySession[sessionId] || '') : ''
          json(res, 200, {
            ok: true,
            sessionId,
            presetId,
            presetName: presetMeta?.name || '默认预设',
            wbOverride,
            wbEffective: resolveWbIsFull(st0, wb0, sessionId) ? 'full' : 'keyword',
            wbInjectGlobal: st0.wbInject || 'follow',
            wbCardInjectMode: wb0.injectMode === 'keyword' ? 'keyword' : 'full',
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || getLastSid()
            const pid = setSessionPreset(sid, body.presetId)
            refresh(ctx)
            const presetMeta = readPresetsMeta().presets.find(p => p.id === pid)
            json(res, 200, { ok: true, sessionId: sid, presetId: pid, presetName: presetMeta?.name || '默认预设' })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // ★ 兼容旧版：读取（操作当前会话绑定的预设） ★
  {
    kind: 'exact',
    path: '/api/tavern/read',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      try {
        const url = new URL(req.url, 'http://localhost')
        const sid = url.searchParams.get('sessionId') || getLastSid()
        if (sid) setLastSid(sid) // 主动更新 lastSessionId
        const presetId = url.searchParams.get('presetId') || getSessionPresetId(sid)
        const files = readPresetFiles(presetId)
        const state = readState()
        const presetMeta = readPresetsMeta().presets.find(p => p.id === presetId)
        json(res, 200, {
          ok: true,
          ...files,
          presetId,
          presetName: presetMeta?.name || '默认预设',
          cardEnabled: state.cardEnabled !== false,
          injected: isCardInjected(),
          cardChars: extractCardText(files.agentYml).length,
          disabledCwds: state.disabledCwds || [],
          allowCwds: state.allowCwds || [],
          mode: state.mode || 'global',
          currentCwd: getLastCwd(),
          currentSessionId: getLastSid() || sid,
        })
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },

  // ★ 兼容旧版：保存（操作当前会话绑定的预设，或指定 presetId） ★
  {
    kind: 'exact',
    path: '/api/tavern/save',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = body.sessionId || getLastSid()
          if (sid) setLastSid(sid)
          const presetId = body.presetId || getSessionPresetId(sid)
          // ★ dataOnly：前端自动保存数据（世界书/角色卡/预设开关）时，
          //   不重新生成 agent.cordis.yml（agent 预设只能手动「保存预设」生成）。
          if (body.dataOnly) {
            body.agentYml = undefined
            body.presetYml = undefined
          }

  if (body.characters) body.characters = cleanObjectStrings(body.characters)
  if (body.worldbooks) body.worldbooks = cleanObjectStrings(body.worldbooks)
          const dir = writePresetFiles(presetId, body.agentYml, body.presetYml, body.characters, body.worldbooks, body.presets)
          // 更新预设简介：★ 从磁盘真实文件重建（不信任 body.characters，避免保存失败/缺字段导致描述错位）
          try {
            rebuildAllPresetDescriptions()
          } catch (e) { /* 忽略简介重建错误 */ }
            // 生成预设简介：角色卡/世界书/预设模块 + 极简模式标记，并写入 preset.yml
            try {
              const charCount2 = Array.isArray(body.characters) ? body.characters.length : 0
              const wbCount2 = Array.isArray(body.worldbooks) ? body.worldbooks.length : 0
              const modCount2 = Array.isArray(body.presets) ? body.presets.length : 0
              const charNames2 = Array.isArray(body.characters) ? body.characters.map(c => c.name || '未知').join('、') : ''
              // ★ 名字来源优先级：本次保存带来的 presetYml → 磁盘上已有的 preset.yml → 注册表。
              //   **绝不**退到 presetId（那是目录名）。dataOnly 自动保存不带 presetYml，
              //   早先这里就把「酒馆默认」覆盖成了「tavern-lite」，DSH 顶部选择器跟着显示目录名。
              const pickName = (text) => {
                const m = /^[ \t]*name[ \t]*:[ \t]*(.+)$/m.exec(String(text || ''))
                return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
              }
              let nameFromDisk = ''
              let curDirName = ''
              try {
                const curDir = getPresetDir(presetId)
                if (curDir) {
                  curDirName = path.basename(curDir)
                  nameFromDisk = pickName(fs.readFileSync(path.join(curDir, 'preset.yml'), 'utf8'))
                }
              } catch (e) { /* 读不到就往下退 */ }
              // 磁盘上的名字若等于目录名/预设 id，那是历史 bug 的痕迹（不是用户起的名），
              // 丢掉它 → 落到注册表真名，让 preset.yml 在下次保存时自愈。
              if (nameFromDisk && (nameFromDisk === curDirName || nameFromDisk === presetId) && !pickName(body.presetYml)) nameFromDisk = ''
              const presetDisplayName = pickName(body.presetYml) || nameFromDisk || presetDisplayNameFor(presetId)
              const richDesc = `🎭 ${charNames2 || '无角色卡'} | 📚 ${wbCount2}本世界书 | ⚙️ ${modCount2}个预设模块 | 最后更新: ${new Date().toLocaleString('zh-CN')}`
              writePresetNameFile(presetId, presetDisplayName, richDesc)
            } catch (e) { /* 忽略简介写入错误 */ }

          refresh(ctx)
          const state = readState()
          // ★ 保存预设的同时生成/更新 skill（用户要的"点保存就生成"）。
          //   **best-effort**：写 skill 失败绝不能让"保存预设"失败 —— 只把结果如实带回给面板。
          const skill = syncPresetSkillAfterSave(presetId, state)
          // ★ 保存之后把声明同步一次 —— 只在**真的写了组合文件**时（dataOnly 自动保存不算）。
          //   为什么必须在"保存后"：声明是从 agent.cordis.yml 渲染的，而新建时的骨架没有任何
          //   内容 ⇒ 创建那一刻同步出去的那行是空壳，且此后再没人重新渲染它，
          //   DSH 名册里就永久停着那张「有名字却不起作用」的卡。
          //   syncDeclarationsBestEffort 内部：未启用声明 = no-op；内容没变 = 不写盘不备份。
          const declarations = typeof body.agentYml === 'string'
            ? syncDeclarationsBestEffort('save')
            : { ok: true, skipped: 'dataOnly' }
          json(res, 200, { ok: true, dir, presetId, cardEnabled: state.cardEnabled !== false, injected: isCardInjected(), skill, declarations })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // ★ 手动注入开场白（旧会话的补救入口；自动播种失败的退路）
  //   POST /api/tavern/greeting/insert { presetId?, cardName?, sessionId? }
  //     · sessionId 缺省用 lastSessionId（后端最近见过的当前会话）；
  //     · presetId 缺省按会话权威解析（getSessionPresetId）；
  //     · 从该 preset 的 characters.json 取启用中第一张卡（或 body.cardName）的 first，
  //       往会话**末尾** append 一条 assistant 消息（tavern/character-card）。
  //   ★ 防重复（2026-09-23）：会话里已有 source.model==='character-card' 的 assistant 楼
  //     ⇒ 直接 200 { ok:false, error:'greeting-already-present' }，不再叠加第二条开场白。
  //   返回 { ok, inserted, cardName, greetingLen, turn }；找不到卡/会话 → { ok:false, error }。
  ]
}
/** 第 3 块路由（逐字搬自 lib/index.js；本组 9 条：/api/tavern/greeting/insert, /api/tavern/state, /api/tavern/config, /api/tavern/summarize, /api/tavern/relations, /api/tavern/worldbook, /api/tavern/worldbook/export, /api/tavern/worldbook/import, /api/tavern/worldbook/open；见本文件头部说明）。 */
function routesGroup3(ctx, deps) {
  const {
    DEFAULT_PRESET_ID,
    S,
    getLastCwd,
    getLastSid,
    getPresetDir,
    getSessionPresetId,
    insertGreetingForSession,
    isCardInjected,
    isTavernPresetDir,
    json,
    listDshConnections,
    liveAgents,
    noteGreetingLog,
    readBody,
    readSessionRelations,
    readState,
    readWorldbook,
    refresh,
    runSummary,
    setLastCwd,
    setLastSid,
    writeRelations,
    writeSessionRelations,
    writeState,
    writeWorldbook,
  } = deps
  return [
  {
    kind: 'exact',
    path: '/api/tavern/greeting/insert',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = String((body && body.sessionId) || getLastSid() || '')
          if (!sid) { json(res, 400, { ok: false, error: 'no-session：请求没带 sessionId，后端也没有当前会话记录' }); return }
          const agent = liveAgents.get(sid)
          const session = agent && agent.session
          if (!session) {
            json(res, 404, { ok: false, error: 'session-not-live：会话 ' + sid.slice(0, 24) + ' 当前没有活跃的 Session 对象（先在 DSH 里打开该会话并发一条消息，再回来注入）' })
            return
          }
          const presetId = String((body && body.presetId) || getSessionPresetId(sid) || '')
          if (!presetId || presetId === DEFAULT_PRESET_ID || !isTavernPresetDir(presetId)) {
            json(res, 400, { ok: false, error: 'no-preset：会话未绑定酒馆预设（presetId=' + presetId + '）' })
            return
          }
          const r = insertGreetingForSession(session, presetId, body && body.cardName)
          if (!r.ok) {
            // 已注入过 = 请求没问题，只是无事可做 ⇒ 200 + ok:false（面板显示「本会话已有开场白」）；
            // append 失败属服务端 ⇒ 500；其余（找不到卡 / 卡没开场白）⇒ 404。
            const status = r.error === 'greeting-already-present' ? 200 : (/^append-failed/.test(r.error) ? 500 : 404)
            json(res, status, { ok: false, error: r.error })
            return
          }
          const turn = r.turn
          try {
            const phase = agent && agent.phase
            if (phase && phase.kind === 'idle' && phase.lastTurn < turn) phase.lastTurn = turn
          } catch {}
          noteGreetingLog(presetId, '', true, 'manual turn=' + turn + ' card=' + r.cardName + ' sid=' + sid.slice(0, 24))
          json(res, 200, { ok: true, inserted: true, cardName: r.cardName, greetingLen: r.greetingLen, turn })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 状态（全局，保留）
  {
    kind: 'exact',
    path: '/api/tavern/state',
    handler: (req, res) => {
      if (req.method === 'GET') {
        const state = readState()
        json(res, 200, { ok: true, cardEnabled: state.cardEnabled !== false, toolsEnabled: state.toolsEnabled !== false, injected: isCardInjected(), networkEnabled: state.networkEnabled === true, antiCliche: state.antiCliche !== false, disabledCwds: state.disabledCwds || [], allowCwds: state.allowCwds || [], allowSessions: state.allowSessions || [], mode: state.mode || 'global', plotOptions: state.plotOptions !== false, relationsHint: state.relationsHint !== false, skillAutoGenerate: state.skillAutoGenerate !== false, skillAutoFull: state.skillAutoFull === true, skillHint: state.skillHint !== false, skillsDir: state.skillsDir || '', wbInject: state.wbInject || 'follow', nsfwEnabled: state.nsfwEnabled === true, nsfwPrompt: state.nsfwPrompt || '', promptWindowTokens: state.promptWindowTokens, currentCwd: getLastCwd(), currentSessionId: getLastSid() })
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          const state = readState()
          if (typeof body.cardEnabled === 'boolean') state.cardEnabled = body.cardEnabled
          if (typeof body.toolsEnabled === 'boolean') {
            state.toolsEnabled = body.toolsEnabled
          }
          // ★ P2-1 世界书注入逃生阀：只认 'follow' / 'full' 两个值（非法值不落盘）
          if (body.wbInject === 'follow' || body.wbInject === 'full') state.wbInject = body.wbInject
          if (body.mode === 'global' || body.mode === 'allowlist') state.mode = body.mode
          if (body.disabledCwds !== undefined) state.disabledCwds = (Array.isArray(body.disabledCwds) ? body.disabledCwds : []).map(s => String(s).trim()).filter(Boolean)
          if (body.allowCwds !== undefined) state.allowCwds = (Array.isArray(body.allowCwds) ? body.allowCwds : []).map(s => String(s).trim()).filter(Boolean)
          if (body.allowSessions !== undefined) state.allowSessions = (Array.isArray(body.allowSessions) ? body.allowSessions : []).map(s => String(s).trim()).filter(Boolean)
          // 成人向提示段：只有"开关 + 正文"两个键；正文只存在本机 state 里
          if (typeof body.nsfwEnabled === 'boolean') state.nsfwEnabled = body.nsfwEnabled
          if (typeof body.nsfwPrompt === 'string') {
            // 上限 20000 字符：正常提示段几百到几千字，超长只可能是误操作
            state.nsfwPrompt = body.nsfwPrompt.slice(0, 20000)
          }
          if (typeof body.plotOptions === 'boolean') state.plotOptions = body.plotOptions
          if (typeof body.networkEnabled === 'boolean') state.networkEnabled = body.networkEnabled
          if (typeof body.antiCliche === 'boolean') state.antiCliche = body.antiCliche
          if (typeof body.relationsHint === 'boolean') state.relationsHint = body.relationsHint
          // 技能：自动生成 / 世界书全文 / 会话指针 / 自定义 skill 根
          if (typeof body.skillAutoGenerate === 'boolean') state.skillAutoGenerate = body.skillAutoGenerate
          if (typeof body.skillAutoFull === 'boolean') state.skillAutoFull = body.skillAutoFull
          if (typeof body.skillHint === 'boolean') state.skillHint = body.skillHint
          if (body.skillStyle === 'index' || body.skillStyle === 'instructions') state.skillStyle = body.skillStyle
          if (typeof body.skillsDir === 'string') state.skillsDir = body.skillsDir.trim()
          // （已移除）enhanceRuntime：通用增强层运行时段已按用户要求整层删除，不再接受该开关
          // 上下文窗口（token），用于体积占比告警
          if (body.promptWindowTokens !== undefined) {
            const w = Number(body.promptWindowTokens)
            if (Number.isFinite(w) && w >= 1024) state.promptWindowTokens = Math.round(w)
          }
          writeState(state)
          refresh(ctx)
          json(res, 200, { ok: true, cardEnabled: state.cardEnabled !== false, toolsEnabled: state.toolsEnabled !== false, injected: isCardInjected(), networkEnabled: state.networkEnabled === true, antiCliche: state.antiCliche !== false, disabledCwds: state.disabledCwds || [], allowCwds: state.allowCwds || [], allowSessions: state.allowSessions || [], mode: state.mode || 'global', plotOptions: state.plotOptions !== false, relationsHint: state.relationsHint !== false, skillAutoGenerate: state.skillAutoGenerate !== false, skillAutoFull: state.skillAutoFull === true, skillHint: state.skillHint !== false, skillsDir: state.skillsDir || '', wbInject: state.wbInject || 'follow', nsfwEnabled: state.nsfwEnabled === true, nsfwPrompt: state.nsfwPrompt || '', promptWindowTokens: state.promptWindowTokens, currentCwd: getLastCwd(), currentSessionId: getLastSid() })
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // （已删除）/api/tavern/preset/enhance：通用增强层已连根移除
  // 记忆配置（全局，保留）
  {
    kind: 'exact',
    path: '/api/tavern/config',
    handler: (req, res) => {
      if (req.method === 'GET') {
        const st = readState()
        json(res, 200, { ok: true, mem: st.mem || {}, playerName: st.playerName || '', antiCliche: st.antiCliche !== false, relationsHint: st.relationsHint !== false, bannedWords: st.bannedWords || [], networkEnabled: st.networkEnabled === true, dshConnections: listDshConnections(), currentCwd: getLastCwd(), currentSessionId: getLastSid() })
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          const st = readState()
          const m = st.mem || {}
          if (typeof body.apiUrl === 'string') m.apiUrl = body.apiUrl.trim()
          if (typeof body.apiKey === 'string') m.apiKey = body.apiKey.trim()
          if (typeof body.model === 'string') m.model = body.model.trim() || 'deepseek-chat'
          if (typeof body.autoEnabled === 'boolean') m.autoEnabled = body.autoEnabled
          if (typeof body.autoEvery === 'number' && Number.isFinite(body.autoEvery) && body.autoEvery >= 1) m.autoEvery = Math.floor(body.autoEvery)
          if (typeof body.useDsh === 'boolean') m.useDsh = body.useDsh
          if (typeof body.dshConnection === 'string') m.dshConnection = body.dshConnection.trim()
          if (typeof body.dshModel === 'string') m.dshModel = body.dshModel.trim()
          if (typeof body.playerName === 'string') { st.playerName = body.playerName.trim(); S.playerName = st.playerName }
          if (typeof body.antiCliche === 'boolean') st.antiCliche = body.antiCliche
          if (typeof body.relationsHint === 'boolean') st.relationsHint = body.relationsHint
          if (Array.isArray(body.bannedWords)) st.bannedWords = body.bannedWords.map(w => String(w).trim()).filter(Boolean)
          if (typeof body.networkEnabled === 'boolean') st.networkEnabled = body.networkEnabled
          st.mem = m
          writeState(st)
          try { refresh(ctx) } catch {}
          json(res, 200, { ok: true, mem: m, antiCliche: st.antiCliche !== false, relationsHint: st.relationsHint !== false, bannedWords: st.bannedWords || [], networkEnabled: st.networkEnabled === true })
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // 总结
  {
    kind: 'exact',
    path: '/api/tavern/summarize',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        const st = readState()
        const want = Number.isFinite(body.rounds) ? Math.max(1, Math.floor(body.rounds)) : (st.mem?.autoEvery || 20)
        const sid = String(body.sessionId || getLastSid() || '')
        const presetId = getSessionPresetId(sid)
        const before = st.mem?.lastSeq || 0
        runSummary(ctx, st, sid, presetId, true)
          .then((out) => {
            const st2 = readState()
            st2.mem = st2.mem || {}
            st2.mem.lastSeq = Math.max(before || 0, (st2.mem.lastSeq || 0))
            writeState(st2)
            // 总结完成后自动刷新系统提示，让总结内容立即注入
            try { refresh(ctx) } catch {}
            json(res, 200, { ok: true, ...out, rounds: want, sessionId: sid, presetId })
          })
          .catch((e) => json(res, 500, { ok: false, error: e.message }))
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 关系网（基于当前会话预设）
  {
    kind: 'exact',
    path: '/api/tavern/relations',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') || getLastSid() || ''
      const useSession = !!sessionId
      if (req.method === 'GET') {
        try {
          const data = useSession ? readSessionRelations(sessionId) : { nodes: [], edges: [] }
          json(res, 200, { ok: true, relations: data, sessionId: sessionId || null })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || sessionId
            if (sid) {
              writeSessionRelations(sid, body.relations || { nodes: [], edges: [] })
              json(res, 200, { ok: true, sessionId: sid })
            } else {
              const pid = body.presetId || getSessionPresetId(getLastSid())
              writeRelations(pid, body.relations || { nodes: [], edges: [] })
              json(res, 200, { ok: true, presetId: pid })
            }
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // 世界书（结构化 + 关键词触发）
  {
    kind: 'exact',
    path: '/api/tavern/worldbook',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sid = url.searchParams.get('sessionId') || getLastSid()
      if (sid) setLastSid(sid)
      const presetId = url.searchParams.get('presetId') || getSessionPresetId(sid)
      if (req.method === 'GET') {
        try {
          const data = readWorldbook(presetId)
          json(res, 200, { ok: true, ...data, presetId, sessionId: sid || null })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const pid = body.presetId || presetId
            // 未显式传 injectMode 时保留预设里已有的模式。
            // 面板保存条目/分组时不带 injectMode，若默认成 'full' 就会把
            // 别处（独立设置页、另一个标签页）刚改好的模式悄悄改回去。
            let keepMode = 'full'
            if (body.injectMode === undefined || body.injectMode === null) {
              try { keepMode = readWorldbook(pid).injectMode || 'full' } catch { keepMode = 'full' }
            }
            const data = {
              entries: Array.isArray(body.entries) ? body.entries : [],
              injectMode: (body.injectMode === undefined || body.injectMode === null)
                ? keepMode
                : (body.injectMode === 'keyword' ? 'keyword' : 'full'),
              groups: Array.isArray(body.groups) ? body.groups : []
            }
            writeWorldbook(pid, data)
            json(res, 200, { ok: true, presetId: pid, injectMode: data.injectMode })
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // 世界书导出为 Markdown
  {
    kind: 'exact',
    path: '/api/tavern/worldbook/export',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = body.sessionId || getLastSid()
          if (sid) setLastSid(sid)
          const presetId = body.presetId || getSessionPresetId(sid)
          const wb = readWorldbook(presetId)
          const dir = getPresetDir(presetId)
          if (!dir) throw new Error('预设不存在')
          const mdPath = path.join(dir, 'worldbook.md')
          const lines = ['# 世界书', '', `注入模式：${wb.injectMode === 'keyword' ? '关键词触发' : '全文注入'}`, '']
          for (const e of wb.entries) {
            lines.push(`## ${e.name || '未命名条目'}`)
            lines.push('')
            lines.push(`- **启用**：${e.enabled === false ? '否' : '是'}`)
            lines.push(`- **关键词**：${(e.keywords || []).join(', ') || '无'}`)
            lines.push(`- **位置**：${e.position || 'before_char'}`)
            lines.push('')
            lines.push('### 内容')
            lines.push('')
            lines.push(e.content || '')
            lines.push('')
            lines.push('---')
            lines.push('')
          }
          fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
          json(res, 200, { ok: true, path: mdPath, entryCount: wb.entries.length })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 世界书从 Markdown 导入
  {
    kind: 'exact',
    path: '/api/tavern/worldbook/import',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = body.sessionId || getLastSid()
          if (sid) setLastSid(sid)
          const presetId = body.presetId || getSessionPresetId(sid)
          const dir = getPresetDir(presetId)
          if (!dir) throw new Error('预设不存在')
          const mdPath = body.path || path.join(dir, 'worldbook.md')
          if (!fs.existsSync(mdPath)) throw new Error('Markdown 文件不存在: ' + mdPath)
          const md = fs.readFileSync(mdPath, 'utf8')
          // 简单解析：按 ## 分割条目
          const sections = md.split(/^## /m).slice(1)
          const entries = []
          for (const sec of sections) {
            const lines = sec.split('\n')
            const name = lines[0].trim()
            let content = ''
            let keywords = []
            let enabled = true
            let inContent = false
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i]
              if (line.startsWith('- **关键词**：')) {
                const kw = line.replace('- **关键词**：', '').trim()
                if (kw && kw !== '无') keywords = kw.split(',').map(s => s.trim()).filter(Boolean)
              } else if (line.startsWith('- **启用**：')) {
                enabled = !line.includes('否')
              } else if (line.startsWith('### 内容')) {
                inContent = true
              } else if (inContent && line !== '---') {
                content += line + '\n'
              }
            }
            entries.push({
              id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
              name, keywords, content: content.trim(), enabled, position: 'before_char'
            })
          }
          const wb = readWorldbook(presetId)
          wb.entries = entries
          writeWorldbook(presetId, wb)
          json(res, 200, { ok: true, entryCount: entries.length, presetId })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 用系统编辑器打开世界书 Markdown
  {
    kind: 'exact',
    path: '/api/tavern/worldbook/open',
    handler: async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then(async (body) => {
        try {
          const sid = body.sessionId || getLastSid()
          if (sid) setLastSid(sid)
          const presetId = body.presetId || getSessionPresetId(sid)
          const dir = getPresetDir(presetId)
          if (!dir) throw new Error('预设不存在')
          const mdPath = path.join(dir, 'worldbook.md')
          // 先导出（确保文件最新）
          const wb = readWorldbook(presetId)
          const lines = ['# 世界书', '', `注入模式：${wb.injectMode === 'keyword' ? '关键词触发' : '全文注入'}`, '']
          for (const e of wb.entries) {
            lines.push(`## ${e.name || '未命名条目'}`, '', `- **启用**：${e.enabled === false ? '否' : '是'}`, `- **关键词**：${(e.keywords || []).join(', ') || '无'}`, `- **位置**：${e.position || 'before_char'}`, '', '### 内容', '', e.content || '', '', '---', '')
          }
          fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
          // 用系统默认编辑器打开
          const { exec } = await import('node:child_process')
          const cmd = process.platform === 'win32' ? `start "" "${mdPath}"` : process.platform === 'darwin' ? `open "${mdPath}"` : `xdg-open "${mdPath}"`
          exec(cmd, (err) => {
            if (err) json(res, 500, { ok: false, error: err.message })
            else json(res, 200, { ok: true, path: mdPath })
          })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 记忆（基于当前会话预设）
  ]
}
/** 第 4 块路由（逐字搬自 lib/index.js；本组 8 条：/api/tavern/memory, /api/tavern/memory/import-legacy, /api/tavern/sessions, /api/tavern/session-content, /api/tavern/worldbook/mode, /api/tavern/prompt-stats, /api/tavern/reply-check, /api/tavern/settings；见本文件头部说明）。 */
function routesGroup4(ctx, deps) {
  const {
    buildWorldbookText,
    cleanSillyTavernVars,
    detectRefusal,
    estimatePromptBudget,
    getLastSid,
    getSessionPersistence,
    getSessionPresetId,
    getSessionTitle,
    hasTurnStarted,
    json,
    liveAgents,
    memoryFile,
    readBindings,
    readBody,
    readLastAssistantText,
    readMemory,
    readPromptStats,
    readRecentMessages,
    readSessionMemory,
    readState,
    readWorldbook,
    resolveAuthoritativePreset,
    resolveWbIsFull,
    selectWorldbookEntries,
    sessionBindingFields,
    sessionMemoryFile,
    setLastSid,
    writeState,
    writeWorldbook,
  } = deps
  return [
  {
    kind: 'exact',
    path: '/api/tavern/memory',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') || getLastSid() || ''
      const useSession = !!sessionId
      if (req.method === 'GET') {
        try {
          const text = useSession ? readSessionMemory(sessionId) : readMemory(url.searchParams.get('presetId') || getSessionPresetId(getLastSid()))
          json(res, 200, { ok: true, memory: text, sessionId: sessionId || null })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        return
      }
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          try {
            const sid = body.sessionId || sessionId
            // ★ 源头清理记忆文本里的 SillyTavern 变量（记忆会注入 tavern:card，残留 {{}} 会报错）
            const cleanMem = cleanSillyTavernVars(String(body.memory || ''))
            if (sid) {
              const f = sessionMemoryFile(sid)
              fs.mkdirSync(path.dirname(f), { recursive: true })
              fs.writeFileSync(f, cleanMem, 'utf8')
              json(res, 200, { ok: true, sessionId: sid })
            } else {
              const pid = body.presetId || getSessionPresetId(getLastSid())
              const f = memoryFile(pid)
              fs.mkdirSync(path.dirname(f), { recursive: true })
              fs.writeFileSync(f, cleanMem, 'utf8')
              json(res, 200, { ok: true, presetId: pid })
            }
          } catch (e) { json(res, 500, { ok: false, error: e.message }) }
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      json(res, 405, { ok: false, error: 'method-not-allowed' })
    }
  },
  // 历史遗留「预设级记忆」的显式搬入（迁移用；不自动执行）
  //
  // 背景：注入端曾回退到「预设目录下的 memory.md」—— 那是按预设累积的共享文件，
  //   会把别的会话、别的卡的剧情带进当前对话（已修）。历史文件**不删**、
  //   也**绝不自动分配**给任何会话（没有依据判断哪条会话才是它的主人），
  //   改由用户在某条会话里显式调用本接口搬进来。
  //
  // body: { sessionId, confirm?: true, mode?: 'append' | 'replace', presetId? }
  //   不带 confirm → 只回预览（条目数 / 字数 / 文件路径），不落盘。
  {
    kind: 'exact',
    path: '/api/tavern/memory/import-legacy',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = String(body.sessionId || getLastSid() || '')
          if (!sid) { json(res, 400, { ok: false, error: '缺少 sessionId：请在目标会话里调用本接口' }); return }
          const pid = body.presetId || getSessionPresetId(sid)
          const legacyPath = memoryFile(pid)
          const legacy = readMemory(pid)
          const entries = (legacy.match(/# 记忆总结/g) || []).length
          if (!legacy.trim()) {
            json(res, 200, { ok: true, imported: 0, entries: 0, sessionId: sid, presetId: pid, note: '该预设没有历史记忆文件，无需迁移' })
            return
          }
          if (body.confirm !== true) {
            json(res, 200, {
              ok: true, needConfirm: true, sessionId: sid, presetId: pid,
              preview: { entries: entries, chars: legacy.length, file: legacyPath },
              warn: '把它搬进「这条会话」之前请先核对预览：历史文件的归属无法自动判断，搬错会话就等于把串台重新写死一遍。确认后带 confirm:true 再调一次。',
            })
            return
          }
          const mode = body.mode === 'replace' ? 'replace' : 'append'
          const prev = mode === 'replace' ? '' : readSessionMemory(sid)
          const combined = (prev.trim() + '\n\n' + legacy.trim()).trim()
          const f = sessionMemoryFile(sid)
          fs.mkdirSync(path.dirname(f), { recursive: true })
          fs.writeFileSync(f, combined + '\n', 'utf8')
          json(res, 200, { ok: true, imported: legacy.length, entries: entries, sessionChars: combined.length, mode: mode, sessionId: sid, presetId: pid, legacyFile: legacyPath })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 会话列表
  {
    kind: 'exact',
    path: '/api/tavern/sessions',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      try {
        const persistence = getSessionPersistence(ctx)
        if (!persistence || typeof persistence.list !== 'function') {
          json(res, 200, { ok: true, sessions: [] })
          return
        }
        // 获取当前会话的工作目录（cwd），用于过滤同工作区的会话。
        // 修复：web-server 插件上下文没有注入 session/agent 服务，直接访问
        // ctx.session 会抛 cannot get property "session" without inject（500）。
        // 这里安全取值：取不到时 cwd 为空 → 按下方逻辑返回全部会话。
        let currentCwd = ''
        try {
          currentCwd = ctx.agent?.session?.header?.cwd || ''
        } catch {}
        const cwdKey = currentCwd ? String(currentCwd).replace(/[\\/]+$/, '') : ''
        persistence.list().then(async (headers) => {
          let sessions = (headers || []).map((h) => ({ id: h.id, createdAt: h.createdAt || 0, origin: h.origin || '', title: '', cwd: h.cwd || '' }))
          // ★ 合并「活着的、还没落盘」的会话。
          //   关键场景：用户刚点「新对话」，会话已被 DSH 发布（agent/created）但一条消息都还没发
          //   ⇒ `persistence.list()` 里可能根本没有它，而它恰恰是用户此刻要绑定的那一个。
          //   插件在 agent/created 就登记了 liveAgents，这里按 cwd 一并列出并标 `live/blank`，
          //   面板据此允许「未发消息就绑定」（老版本在这里说「当前会话不在会话列表里」）。
          try {
            const seen = new Set(sessions.map(s => s.id))
            for (const [sid, agent] of liveAgents) {
              if (!sid || seen.has(sid)) continue
              let cwd = ''
              try { cwd = agent?.session?.header?.cwd || '' } catch {}
              sessions.push({ id: sid, createdAt: 0, origin: 'live', title: '', cwd, live: true, blank: !hasTurnStarted(agent) })
            }
          } catch {}
          // 按当前工作区过滤：只返回相同 cwd 的会话（如果当前 cwd 为空则返回所有）
          if (cwdKey) {
            sessions = sessions.filter((s) => {
              const sCwd = s.cwd ? String(s.cwd).replace(/[\\/]+$/, '') : ''
              return !sCwd || sCwd === cwdKey
            })
          }
          // 活会话（含空白新会话）排最前：它们是用户此刻最可能要操作的对象，
          // 而且 createdAt 为 0 会被降序排序挤到末尾、再被 slice(0,20) 切掉。
          sessions.sort((a, b) => (Number(b.live === true) - Number(a.live === true))
            || (Number(b.createdAt) - Number(a.createdAt)))
          sessions = sessions.slice(0, 20)
          const bindings = readBindings()
          for (const s of sessions) {
            try {
              const title = await Promise.race([
                getSessionTitle(ctx, s.id),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
              ])
              s.title = title || ''
            } catch { s.title = '' }
            // ★ P0-1：条目已升级为对象；legacy / none 一律按「未绑定」显示默认预设。
            // ★ P0-3 补完：同一段判定之外，再给面板 bindingMode / bindingSource，
            //   让它分得开「未绑定」/「绑到 default」/「遗留待确认」。boundPreset 不动。
            const bf = sessionBindingFields(bindings[s.id])
            s.boundPreset = bf.boundPreset
            s.bindingMode = bf.bindingMode
            s.bindingSource = bf.bindingSource
            // ★ 本会话的「设定注入量」覆盖（面板要显示"这一场是全量还是跟随规则"）
            try {
              const st0 = readState()
              s.wbOverride = (st0.wbInjectBySession && st0.wbInjectBySession[s.id]) || ''
              s.wbInjectGlobal = st0.wbInject || 'follow'
              // 实际生效模式：把「会话覆盖 → 全局开关 → 卡设定」这一整条链算给面板，
              // 免得面板自己猜（猜错用户就以为设定没进去）—— 与注入口径同一个函数。
              s.wbEffective = resolveWbIsFull(st0, readWorldbook(s.boundPreset === 'default' ? '' : s.boundPreset), s.id) ? 'full' : 'keyword'
            } catch { s.wbOverride = '' }
            // ★ 原生权威（只给**活会话**现算）：面板要显示「本会话当前生效的预设」，
            //   而用户在聊天顶部选的卡**不在酒馆账本里** —— 只看账本会把
            //   「顶部选了酒馆卡」显示成「未绑定」，那是编造状态。
            //   活会话通常只有一两个，现算便宜；20 条全会话都读事件流太贵，所以只算活的。
            if (s.live) {
              try {
                const r = resolveAuthoritativePreset(s.id)
                s.authoritativePresetId = r.presetId
                s.authoritativeSource = r.source
              } catch {}
            }
          }
          json(res, 200, { ok: true, sessions })
        }).catch((e) => json(res, 500, { ok: false, error: e.message }))
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },
  // 会话内容
  {
    kind: 'exact',
    path: '/api/tavern/session-content',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      try {
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('id') || ''
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)))
        if (!id) { json(res, 400, { ok: false, error: '缺少会话ID' }); return }
        readRecentMessages(ctx, id, limit).then((messages) => {
          json(res, 200, { ok: true, id, count: messages.length, text: messages.join('\n') })
        }).catch((e) => json(res, 500, { ok: false, error: e.message }))
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },

  // 世界书注入模式（full 全量 / keyword 关键词）—— 只改 injectMode，绝不动条目
  {
    kind: 'exact',
    path: '/api/tavern/worldbook/mode',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readBody(req).then((body) => {
        try {
          const sid = body.sessionId || getLastSid()
          if (sid) setLastSid(sid)
          const presetId = body.presetId || getSessionPresetId(sid)
          const mode = body.injectMode === 'keyword' ? 'keyword' : 'full'
          const data = readWorldbook(presetId)
          if (!data.groups.length) {
            json(res, 404, { ok: false, error: '该预设还没有世界书条目，无需切换' }); return
          }
          writeWorldbook(presetId, { injectMode: mode, groups: data.groups })
          json(res, 200, { ok: true, presetId, injectMode: mode, groups: data.groups.length, entries: data.entries.length })
        } catch (e) { json(res, 500, { ok: false, error: e.message }) }
      }, (e) => json(res, 400, { ok: false, error: e.message }))
    }
  },
  // 提示词体积：上一轮实测 + 两种注入模式的对比估算
  {
    kind: 'exact',
    path: '/api/tavern/prompt-stats',
    handler: (req, res) => {
      if (req.method === 'POST') {
        readBody(req).then((body) => {
          const w = Number(body.promptWindowTokens)
          if (Number.isFinite(w) && w >= 1024) {
            const st = readState()
            st.promptWindowTokens = Math.round(w)
            writeState(st)
          }
          json(res, 200, { ok: true, promptWindowTokens: readState().promptWindowTokens })
        }, (e) => json(res, 400, { ok: false, error: e.message }))
        return
      }
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      try {
        const st = readState()
        const snap = readPromptStats()
        // 体积统计也要认**会话级覆盖**：面板问的是"当前这个会话会注入多少"，
        // 拿 lastSessionId 的口径与注入点保持一致（拿不到就退回全局/卡设定）。
        const statsSid = getLastSid() || ''
        const presetId = getSessionPresetId(statsSid)
        const wb = readWorldbook(presetId)
        // 两种模式下世界书各要多少字符 —— 复用 card 段同一套过滤/选择逻辑，保证口径一致
        // ★ P2-1：isFull 判定与注入点共用 resolveWbIsFull（会话覆盖 + 全局逃生阀 + 卡设定），
        //   同一轮不会出现注入 select / 统计 full 的口径分裂。
        const allEntries = wb.entries.filter(e => e.disable !== true)
        const sizeOf = (isFull) => {
          const { injectEntries } = selectWorldbookEntries(allEntries, '', isFull)
          return buildWorldbookText(injectEntries).length
        }
        const wbFull = allEntries.length ? sizeOf(true) : 0
        const wbKeyword = allEntries.length ? sizeOf(false) : 0
        // 除世界书以外的固定开销 = 上一轮实测总量 − 上一轮世界书
        const measuredTotal = snap ? Number(snap.total) || 0 : 0
        const measuredWb = snap ? Number(snap.wb) || 0 : 0
        const overhead = Math.max(0, measuredTotal - measuredWb)
        const win = st.promptWindowTokens
        json(res, 200, {
          ok: true,
          presetId,
          // ★ P2-1：mode 显示「实际生效模式」（会话覆盖 + wbInject 逃生阀），与注入口径一致
          mode: resolveWbIsFull(st, wb, statsSid) ? 'full' : 'keyword',
          wbInject: st.wbInject || 'follow',
          wbOverride: (st.wbInjectBySession && statsSid && st.wbInjectBySession[statsSid]) || '',
          cardInjectMode: wb.injectMode === 'keyword' ? 'keyword' : 'full',
          entries: allEntries.length,
          wbFull,
          wbKeyword,
          overhead,
          last: snap,
          now: estimatePromptBudget(measuredTotal, win),
          full: estimatePromptBudget(wbFull + overhead, win),
          keyword: estimatePromptBudget(wbKeyword + overhead, win),
          promptWindowTokens: win,
        })
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },
  // 回复体检：上一条回复是不是被模型拒了
  // 目的：把「插件没注入」和「模型拒绝了」分开 —— 这两件事在界面上以前长得一模一样。
  {
    kind: 'exact',
    path: '/api/tavern/reply-check',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      try {
        const sid = getLastSid()
        const text = sid ? readLastAssistantText(sid) : ''
        const d = detectRefusal(text)
        json(res, 200, {
          ok: true,
          sessionId: sid || null,
          verdict: d.verdict,
          score: d.score,
          hits: d.hits,
          length: d.length,
          excerpt: d.excerpt,
          at: new Date().toISOString(),
        })
      } catch (e) { json(res, 500, { ok: false, error: e.message }) }
    }
  },
  // ── 设置面板（HTML 页面，不依赖 React bundle）──
  {
  kind: 'exact',
  path: '/api/tavern/settings',
  handler: (req, res) => {
    const st = readState()
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>酒馆设置</title>
      <style>body{font-family:system-ui;max-width:500px;margin:40px auto;padding:20px;background:#1a1a2e;color:#e0e0e0}
      h2{color:#fff}.card{background:#16213e;border:1px solid #334;border-radius:10px;padding:16px;margin:12px 0}
      label{display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0}
      input[type=checkbox]{width:18px;height:18px;cursor:pointer}
      .status{font-size:12px;color:#aab;margin-left:8px}
      button{background:#3b7ff0;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;margin-top:12px}
      button:hover{filter:brightness(.9)}
      .hint{font-size:12px;line-height:1.6;color:#9aa3b8;margin:-2px 0 6px 26px}
      .hint b{color:#cfd6e6}
      .card h4{margin:14px 0 2px;font-size:13px;color:#cfd6e6}
      input[type=radio]{width:16px;height:16px;cursor:pointer}
      label.on{color:#fff}</style></head><body>
      <h2>⚙️ 酒馆设置</h2>
      <div class="card"><h3>🔧 工具</h3>
      <label><input type="checkbox" id="tools"><span>系统工具（pwsh）</span><span class="status" id="tools-status"></span></label>
      <label><input type="checkbox" id="network"><span>联网搜索（web_search）</span><span class="status" id="network-status"></span></label>
      </div>
      <div class="card"><h3>🚫 写作</h3>
      <label><input type="checkbox" id="anticliche"><span>反AI八股（1302条）</span><span class="status" id="anticliche-status"></span></label>
      </div>
      <div class="card"><h3>📚 世界书注入</h3>
      <h4>方式</h4>
      <label><input type="radio" name="wbmode" value="full"><span>全量注入</span></label>
      <div class="hint">每轮把世界书<b>所有条目</b>都写进提示词。人设记得最牢、不会漏，代价是每轮都要烧掉<b>约 11.5 万字符</b>的上下文，费的还是钱。</div>
      <label><input type="radio" name="wbmode" value="keyword"><span>关键词触发</span></label>
      <div class="hint">常驻条目（无关键词／恒定）每轮必带；其余条目只在你<b>最近 4 条消息</b>里提到对应关键词时才注入。<b>分阶段人设</b>只带当前好感度的那一档。基线约 <b>1.2 万字符</b>，省下约 90%。</div>
      <div class="status" id="wbmode-status" style="margin-left:0;margin-top:6px"></div>
      </div>
      <div class="card"><h3>📏 提示词体积</h3>
      <div id="ps-body" class="hint" style="margin-left:0">⏳ 读取中…</div>
      <h4>上下文窗口（token）</h4>
      <div class="hint" style="margin-left:0">填模型标称的上下文长度（如 65536、131072）。用来算下面那些占比。</div>
      <input type="number" id="ps-win" min="1024" step="1024" style="width:150px;padding:6px;border-radius:6px;border:1px solid #334;background:#0f1629;color:#e0e0e0">
      <button id="ps-win-save">保存</button>
      <div id="ps-msg" class="status" style="margin-left:0;margin-top:6px"></div>
      </div>
      <div class="card"><h3>🔧 注入开关</h3>
      <div class="hint">成人模式（破限注入）已移除：这类要求请写在预设里。</div>
      <label><input type="checkbox" id="plotopts"><span>剧情选项（要求模型在结尾给出可选行动）</span><span class="status" id="plotOptions-status"></span></label>
      <div class="hint">开启后模型会在回复结尾列出 3 个可点选项，由前端渲染成按钮；关闭时那一行要求整行不注入。</div>
      </div>
      <button id="btn-save-preset">💾 保存预设（写入 agent.cordis.yml）</button>
      <div id="msg" style="margin-top:10px;font-size:13px;color:#aab"></div>
      <script>
      function m(id,t){document.getElementById(id).textContent=t}
      function toggle(key,el){var v=el.checked;m(key+"-status","⏳");fetch("/api/tavern/state",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[key]:v})}).then(r=>r.json()).then(d=>{m(key+"-status",d.ok?(v?"✅":"❌"):"失败");if(d.ok&&key==="networkEnabled"&&v)save()}).catch(()=>m(key+"-status","失败"))}
      function wbName(v){return v==="full"?"全量注入":"关键词触发"}
      function setWbMode(v){m("wbmode-status","⏳ 切换中…");fetch("/api/tavern/worldbook/mode",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({injectMode:v})}).then(r=>r.json()).then(d=>{m("wbmode-status",d.ok?"✅ 已切换为「"+wbName(d.injectMode)+"」，下一轮对话生效":"❌ "+(d.error||"切换失败"))}).catch(e=>m("wbmode-status","❌ "+e.message))}
      function save(){m("msg","⏳ 读取中…");fetch("/api/tavern/read").then(r=>r.json()).then(d=>{if(!d.agentYml){m("msg","❌ 无预设数据");return}m("msg","⏳ 保存中…");fetch("/api/tavern/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentYml:d.agentYml,presetYml:d.presetYml||"name: 精简酒馆\\ndescription: 由 Harness 酒馆管理面板生成。\\n"})}).then(r=>r.json()).then(d2=>{m("msg",d2.ok?"✅ 已保存":"❌ "+(d2.error||""))}).catch(e=>m("msg","❌ "+e.message))}).catch(e=>m("msg","❌ "+e.message))}
      function psLine(label,b){var c=b.level==="danger"?"#ff6b6b":b.level==="warn"?"#ffb454":"#5fd38d";var w={ok:"正常",warn:"偏大",danger:"危险"}[b.level];return '<div style="margin:4px 0"><b>'+label+'</b> '+b.chars.toLocaleString()+' 字符 ≈ '+b.tokens.toLocaleString()+' tokens <span style="color:'+c+'">（占窗口 '+b.pct+'% · '+w+'）</span></div>'}
      function loadPs(){fetch("/api/tavern/prompt-stats").then(r=>r.json()).then(d=>{if(!d.ok){m("ps-body","❌ 读取失败");return}
      document.getElementById("ps-win").value=d.promptWindowTokens
      var h='<div>世界书条目 <b>'+d.entries+'</b> 条 · 当前模式 <b>'+(d.mode==="full"?"全量注入":"关键词触发")+'</b></div>'
      h+=psLine("本轮实测（本插件合计）",d.now)
      h+=psLine("若全量注入",d.full)
      h+=psLine("若关键词触发",d.keyword)
      if(d.mode==="full"&&d.full.level!=="ok"){h+='<div style="margin-top:6px;padding:8px;border-radius:6px;background:#3a1f22;border:1px solid #7a3b3b">⚠️ 全量注入已占窗口 <b>'+d.full.pct+'%</b>，对话历史没地方长，<b>提示词尾部（最后组装的段落）最先被截断</b>。改用上面的「关键词触发」可降到约 '+d.keyword.chars.toLocaleString()+' 字符，省 '+Math.round((1-d.keyword.chars/Math.max(1,d.full.chars))*100)+'%。</div>'}
      if(d.last){h+='<div style="margin-top:6px;opacity:.7">上次组装 '+String(d.last.at||"").replace("T"," ").slice(0,19)+' · 卡片 '+d.last.card+' / 世界书 '+d.last.wb+' 字符</div>'}
      document.getElementById("ps-body").innerHTML=h
      }).catch(()=>m("ps-body","❌ 读取失败"))}
      var _psSave=document.getElementById("ps-win-save");if(_psSave)_psSave.addEventListener("click",saveWin)
      var _presetSave=document.getElementById("btn-save-preset");if(_presetSave)_presetSave.addEventListener("click",save)
      var _plotopts=document.getElementById("plotopts");if(_plotopts)_plotopts.addEventListener("change",function(){toggle("plotOptions",this)})
      ;[["tools","toolsEnabled"],["network","networkEnabled"],["anticliche","antiCliche"]].forEach(function(p){var el=document.getElementById(p[0]);if(el)el.addEventListener("change",function(){toggle(p[1],this)})})
      Array.prototype.forEach.call(document.querySelectorAll('input[name="wbmode"]'),function(el){el.addEventListener("change",function(){if(this.checked)setWbMode(this.value)})})
      function saveWin(){var v=Number(document.getElementById("ps-win").value);fetch("/api/tavern/prompt-stats",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({promptWindowTokens:v})}).then(r=>r.json()).then(d=>{m("ps-msg",d.ok?"✅ 已保存":"❌ 保存失败");loadPs()}).catch(()=>m("ps-msg","❌ 保存失败"))}
      loadPs()
      fetch("/api/tavern/state").then(r=>r.json()).then(d=>{
      if(d.ok){document.getElementById("tools").checked=d.toolsEnabled!==false;m("tools-status",d.toolsEnabled!==false?"✅":"❌");
      document.getElementById("network").checked=d.networkEnabled===true;m("network-status",d.networkEnabled===true?"✅":"❌");
      document.getElementById("anticliche").checked=d.antiCliche!==false;m("anticliche-status",d.antiCliche!==false?"✅":"❌");
      document.getElementById("plotopts").checked=d.plotOptions!==false;m("plotOptions-status",d.plotOptions!==false?"✅ 已开启":"❌")}
      }).catch(()=>{})
      fetch("/api/tavern/worldbook").then(r=>r.json()).then(d=>{
      if(d.ok){var v=d.injectMode==="keyword"?"keyword":"full";
      var el=document.querySelector('input[name="wbmode"][value="'+v+'"]');if(el)el.checked=true;
      m("wbmode-status","当前：「"+wbName(v)+"」")}
      }).catch(()=>m("wbmode-status","⚠️ 读取世界书失败"))
      </script></body></html>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }
  },
  ]
}
