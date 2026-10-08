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
