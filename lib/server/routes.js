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
