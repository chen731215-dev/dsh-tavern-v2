window.__ModuleLoader__.load({
  id: "dsh-tavern",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    // ── 工具函数 ──────────────────────────────────────────────────────
    function esc(s) {
      // ★ 2.6.1（issue #14）：补上单引号。属性值常用单引号包裹，只挡 " 的 esc 在
      //   onclick='…' 这类位置等于没挡。这里一次吃掉五个字符，escAttr 直接复用。
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function truncate(str, max) {
      var s = String(str || '');
      return s.length > max ? s.slice(0, max) + '…' : s;
    }
    function yamlLiteral(str) {
      var clean = String(str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return '|-\n' + clean.split('\n').map(function (line) { return '      ' + line; }).join('\n');
    }
    // 与后端 sanitizePromptText / cleanSillyTavernVars 保持一致的前端文本清理：
    // - {{random::a,b,c}}/{{pick::a,b,c}} 随机取一个；{{roll::n}}/{{roll::n,m}} 随机数
    // - {{user}}/{{char}} 等常见 ST 变量友好替换
    // - 其余一切 {{...}}（setvar/getvar/SYSTEM_INIT/中文名/点开头等）剔除，
    //   只保留 DSH 合法变量 provider/model/cwd
    function sanitizeForHarness(text, charName) {
      var s = String(text || '');
      s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
      s = s.replace(/\{\{random::([^}]*)\}\}/g, function (_, inner) { return randomPick(inner); });
      s = s.replace(/\{\{pick::([^}]*)\}\}/g, function (_, inner) { return randomPick(inner); });
      s = s.replace(/\{\{roll::([^}]*)\}\}/g, function (_, inner) { return randomRoll(inner); });
      s = s.replace(/\{\{user\}\}/g, '你');
      s = s.replace(/\{\{char\}\}/g, charName || '角色');
      s = s.replace(/\{\{persona\}\}/g, '');
      s = s.replace(/\{\{system prompt\}\}/g, '');
      s = s.replace(/\{\{example_dialogue\}\}/g, '');
      s = s.replace(/\{\{world_scenario\}\}/g, '');
      s = s.replace(/\{\{name\}\}/g, '角色');
      s = s.replace(/\{\{description\}\}/g, '');
      s = s.replace(/\{\{scenario\}\}/g, '');
      s = s.replace(/\{\{first_mes\}\}/g, '');
      s = s.replace(/\{\{mes_example\}\}/g, '');
      s = s.replace(/\{\{([^{}]*)\}\}/g, function (all, inner) {
        var n = String(inner || '').trim();
        if (n === 'provider' || n === 'model' || n === 'cwd') return all;
        return '';
      });
      // ★ DSH 兼容：剥离"要求 AI 输出可见 thinking / HTML 注释"的指令
      //   （这些是给支持原生隐藏思考通道的模型设计的；deepseek 会把标签当正文输出）
      s = s.replace(/<thinking_rules>[\s\S]*?<\/thinking_rules>/g, '');
      s = s.replace(/<output_lock>[\s\S]*?<\/output_lock>/g, '');
      s = s.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
      s = s.replace(/<comment>[\s\S]*?<\/comment>/g, '');
      s = s.replace(/<!--[\s\S]*?-->/g, '');
      s = s.replace(/<\/?thinking_rules>/gi, '');
      s = s.replace(/<\/?output_lock>/gi, '');
      s = s.replace(/<\/?thinking>/gi, '');
      s = s.replace(/<\/?Think>/gi, '');
      // COT 容器标签（内容保留，标签剥离——deepseek 不会把 <cot> 当隐藏思考）
      s = s.replace(/<\/?cot>/gi, '');
      // Prism："在正文每段前输出 HTML 注释"的指令与"总结<Prism>内要求"的引用，
      //   剥离标签，引用替换为通用表述（防止 AI 找不到 Prism 而自编并输出注释）
      s = s.replace(/<Prism_tips>[\s\S]*?<\/Prism_tips>/gi, '');
      s = s.replace(/<Prism>[\s\S]*?<\/Prism>/gi, '');
      s = s.replace(/总结\s*<Prism>\s*内的所有要求[！!]?（?一个要求都不能少）?/gi, '总结所有写作要求，一个都不能少');
      s = s.replace(/明确\s*<Prism>\s*的输出格式，并在正文中体现\(如若无要求则无需在意\)/gi, '明确上述要求的输出格式，并在正文中体现');
      s = s.replace(/\$\{?总结<Prism>内的所有要求！一个要求都不能少\}?/gi, '总结所有写作要求，一个都不能少');
      s = s.replace(/<Prism>/gi, '');
      s = s.replace(/<\/Prism>/gi, '');
      s = s.replace(/Prism/gi, '写作要求');
      // ★ 剥离"要求 AI 先打草稿/输出规划再写正文"的指令（deepseek 会把草稿/思考当正文输出）
      s = s.replace(/Draft once[^.\n]{0,60}/gi, '');
      s = s.replace(/All draft work inside <content> as HTML comments\.?\s*/gi, '');
      s = s.replace(/At the START of every reply[^.\n]{0,80}/gi, '');
      s = s.replace(/打草稿[:：][^。\n]{0,60}/gi, '');
      s = s.replace(/以html注释的形式插入在输出内容中[^。\n]{0,40}/gi, '');
      s = s.replace(/先.?打草稿[^。\n]{0,40}/gi, '');
      // ★ 剥离"思考链缝合"指令（世界书/预设里要求 AI 逐步输出思考的内容）
      s = s.replace(/不要偷懒，你需要依次执行下述行动[^。\n]{0,40}/gi, '');
      s = s.replace(/【❗需要缝合进预设思维链的内容】/gi, '');
      s = s.replace(/每个步骤思考总字数小于\d+字禁止进行下一轮思考[^\n]*/gi, '');
      s = s.replace(/禁止进行下一轮思考[^。\n]{0,30}/gi, '');
      s = s.replace(/贝叶斯推演与元素构建[^。\n]{0,40}/gi, '');
      s = s.replace(/内容输出规划[:：][^。\n]{0,40}/gi, '');
      s = s.replace(/5\. 内容输出规划[^\n]*/gi, '');
      s = s.replace(/\n{3,}/g, '\n\n');
      return s;
    }
    // ST 兼容：随机取一个
    function randomPick(inner) {
      var parts = String(inner || '').split(/[,，]/).map(function (p) { return p.trim(); }).filter(Boolean);
      return parts.length ? parts[Math.floor(Math.random() * parts.length)] : '';
    }
    // ST 兼容：roll 随机数
    function randomRoll(inner) {
      var m = String(inner || '').match(/(\d+)(?:\s*[,，\-:]\s*(\d+))?/);
      if (!m) return '';
      var a = Number(m[1]);
      if (!m[2]) return a < 1 ? '' : String(1 + Math.floor(Math.random() * a));
      var b = Number(m[2]);
      var lo = Math.min(a, b), hi = Math.max(a, b);
      return hi < 1 ? '' : String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    function parseJsonText(text) { return JSON.parse(text); }
      // ★★ P0-3c：「当前预设」有两个完全不同的语义，混用就是串卡的温床 —— 必须分开。
      //
      //   A) getActivePresetId()      = **预设管理页当前编辑对象**（编辑目标）
      //      用户点选/新建/复制出来的那个预设；角色卡·世界书·预设模块「保存到哪里」由它决定。
      //
      //   B) getSessionBoundPresetId() = **当前会话绑定**（会话权威）
      //      由「当前会话绑定」区块用 GET /api/tavern/sessions 的 boundPreset 灌入，
      //      只回答「这一轮实际在注入谁的卡」，**不参与**「编辑要写到哪」。
      //
      //   旧实现把 A/B 混成一个函数，并让 localStorage 兜底：那个值会粘住上一次的旧预设，
      //   既不等于编辑目标、也不等于会话权威 —— 用户看到「示例预设」却在注入「示例卡」，
      //   「看不出来自己绑了什么」就是从这里来的。
      var SESSION_BOUND_PRESET_ID = '';
      function getSessionBoundPresetId() { return SESSION_BOUND_PRESET_ID || ''; }
      function setSessionBoundPresetId(id) {
        // 'default' 是后端 /api/tavern/sessions 对「未绑定 / legacy」的统一展平值，
        // 不是一条真实绑定 ⇒ 一律视为「未知」，绝不污染编辑目标。
        SESSION_BOUND_PRESET_ID = (id && id !== 'default') ? String(id) : '';
      }
      /**
       * 在预设列表里按**任意一种 id 空间**找预设：`id`（DSH 目录名）/ `presetId`（酒馆注册表 id）/ `dir`。
       *
       * 为什么必须三选一都认：服务端 `/api/tavern/presets` 的每一条**同时带着两套 id**
       * （`id` = 目录名，`presetId` = 注册表 id）；会话权威给的是**目录名**（如 tavern-lite），
       * 而酒馆账本/注册表用的是**酒馆 id**（如 default）。只认一种的后果分两种，都很糟：
       *   · 预设标签处（loadSessionPresets）→ 编辑目标被**静默切到别的预设**
       *     （改世界书改错卡，数据级串台）；
       *   · 绑定卡处（findPreset）→ 显示「该预设已不存在」（假告警，用户以为预设丢了）。
       *
       * ⚠️ 必须声明在**面板工厂的顶层**（和 getActivePresetId 同层）：调用点
       *   `loadSessionPresets` 就在这一层，而函数声明的提升**只在同一个函数作用域内**生效。
       *   上一版把它放进了绑定卡那个嵌套作用域（为了迁就 UI 测试按源码段抽取），
       *   结果外层调用时报 `matchPresetInList is not defined`，整张「当前 Agent 预设」卡
       *   直接变成「❌ 加载预设失败，请刷新页面」——而这个错误**只有真浏览器里才会出现**，
       *   因为按源码段跑的 UI 测试压根不会执行外层调用点。
       *
       * @param {Array} list 预设列表
       * @param {string} id 任意一种 id（目录名 / 注册表 id / dir 路径）
       * @returns {object|null}
       */
      function matchPresetInList(list, id) {
        var want = String(id || '');
        if (!want || !list || !list.length) return null;
        for (var i = 0; i < list.length; i++) { var a = list[i]; if (a && a.id === want) return a; }
        for (var j = 0; j < list.length; j++) { var b = list[j]; if (b && b.presetId && String(b.presetId) === want) return b; }
        for (var k = 0; k < list.length; k++) {
          var c = list[k];
          if (!c) continue;
          var d = String(c.dir || '');
          if (!d) continue;
          if (d === want || d.replace(/^.*[\\/]/, '') === want) return c;
        }
        return null;
      }

      function getActivePresetId() {
        try {
          var label = document.getElementById('tavern-session-preset-label');
          if (label && label.dataset && label.dataset.presetId) return label.dataset.presetId;
          var btn = document.getElementById('tavern-session-preset-btn');
          if (btn && btn.dataset && btn.dataset.presetId) return btn.dataset.presetId;
          var activeItem = document.querySelector('#tavern-session-preset-panel [data-preset-id]');
          if (activeItem && activeItem.getAttribute && activeItem.getAttribute('data-preset-id')) {
            var aid = activeItem.getAttribute('data-preset-id');
            if (aid) return aid;
          }
        } catch (e) {}
        // ★ 面板标签还没渲染（面板刚挂载/未点选）时，宁可信后端会话权威 B)，
        //   也不要落回下面那个会粘住旧值的 localStorage。
        var boundId = getSessionBoundPresetId();
        if (boundId) return boundId;
        // ★ 最后兜底：localStorage 只服务 A)「预设管理页当前编辑对象」，
        //   它**绝不**参与"当前会话绑了什么"的判断（那是 B) 的事）。
        try { return localStorage.getItem('dsh-tavern-active-preset') || ''; } catch (e) { return ''; }
      }
      function setActivePresetId(id) {
        try { localStorage.setItem('dsh-tavern-active-preset', id || ''); } catch (e) {}
        // Keep the DOM in sync. getActivePresetId() reads the label first, but
        // this setter used to write only localStorage — so right after creating
        // a preset the label still named the previous one, and every following
        // save (character card / worldbook) landed on that previous preset.
        try {
          var els = ['tavern-session-preset-label', 'tavern-session-preset-btn'];
          for (var i = 0; i < els.length; i++) {
            var el = document.getElementById(els[i]);
            if (el && el.dataset) el.dataset.presetId = id || '';
          }
        } catch (e) {}
      }
// 记忆模块使用“会话绑定”：优先用故事背景/记忆区域里选的会话，没选才回退到当前 DSH 会话
        function getSelectedSessionId() {
          try {
            var sel = document.getElementById('tavern-session-select');
            if (sel && sel.value) return sel.value;
          } catch (e) {}
          return getCurrentSessionId();
        }


    async function extractPngTextChunk(bytes, keyword) {
      if (bytes.length < 8) return null;
      var offset = 8;
      while (offset + 8 <= bytes.length) {
        var length = bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
        var type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (offset + 12 + length > bytes.length) break;
        var data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'tEXt') {
          var str = '';
          for (var i = 0; i < data.length; i++) str += String.fromCharCode(data[i]);
          var nul = (str || '').indexOf('\0');
          if (nul >= 0 && str.slice(0, nul) === keyword) return str.slice(nul + 1);
        }
        if (type === 'zTXt') {
          var zstr = '';
          for (var j = 0; j < data.length; j++) zstr += String.fromCharCode(data[j]);
          var znul = (zstr || '').indexOf('\0');
          if (znul < 0 || zstr.slice(0, znul) !== keyword) { offset += 12 + length; continue; }
          var method = data[znul + 1];
          if (method !== 0) { offset += 12 + length; continue; }
          var compressed = data.slice(znul + 2);
          if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压角色卡');
          var stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
          var buffer = await new Response(stream).arrayBuffer();
          return new TextDecoder('utf-8').decode(buffer);
        }
        offset += 12 + length;
      }
      return null;
    }
    function parseCardText(text) {
      var trimmed = String(text || '').trim();
      try { return JSON.parse(trimmed); } catch (_) {}
      var decode = function (b64) {
        var clean = b64.replace(/-/g, '+').replace(/_/g, '/');
        var bin = atob(clean);
        var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
      };
      try { return decode(trimmed); } catch (_) {}
      throw new Error('无法解析角色卡数据');
    }
    
      function findEmbeddedWorldbook(card) {
        if (!card) return null;
        var paths = [
          ['character_book'], ['characterBook'], ['world_book'], ['worldbook'], ['worldBook'],
          ['world_info'], ['worldinfo'], ['lorebook'], ['lore_book'], ['book'],
          ['extensions','character_book'], ['extensions','world_book'], ['extensions','lorebook'], ['extensions','lore_book'],
          ['data','character_book'], ['data','world_book'], ['data','lorebook'], ['data','lore_book'],
          ['data','extensions','character_book'], ['data','extensions','world_book'], ['data','extensions','lorebook']
        ];
        for (var pi = 0; pi < paths.length; pi++) {
          var obj = card;
          for (var j = 0; j < paths[pi].length; j++) {
            if (!obj) break;
            obj = obj[paths[pi][j]];
          }
          if (!obj) continue;
          if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { continue; } }
          var entries = null;
          if (Array.isArray(obj)) {
            entries = obj.filter(function (e) { return e && (e.content || e.text); });
          } else if (obj && Array.isArray(obj.entries)) {
            entries = obj.entries.filter(function (e) { return e && (e.content || e.text); });
          } else if (obj && typeof obj === 'object') {
            entries = Object.keys(obj).map(function (k) { return obj[k]; }).filter(function (e) { return e && typeof e === 'object' && (e.content || e.text); });
          }
          if (entries && entries.length) {
            entries = entries.map(function (e) {
              if (typeof e === 'string') return { content: e, text: e, enabled: true };
              e.enabled = e.enabled !== false;
              return e;
            });
            obj.entries = entries;
            if (obj.name === undefined && obj.title === undefined && card.name) obj.name = card.name + '的世界书';
            return obj;
          }
        }
        // 兜底：深度递归扫描整个卡片对象，很多第三方角色卡会把世界书藏在任意层级
        var keys = Object.keys(card || {});
        function walk(obj, depth) {
          if (!obj || typeof obj !== 'object' || depth > 5) return null;
          var arr = Array.isArray(obj) ? obj : Object.keys(obj).map(function (k) { return obj[k]; });
          for (var oi = 0; oi < arr.length; oi++) {
            var v = arr[oi];
            if (!v || typeof v !== 'object') continue;
            var entries = Array.isArray(v.entries) ? v.entries.filter(function (e) { return e && (e.content || e.text); }) : null;
            if (entries && entries.length) return v;
          }
          for (var k2 in obj) {
            var found = walk(obj[k2], depth + 1);
            if (found) return found;
          }
          return null;
        }
        var deep = walk(card, 0);
        if (deep) {
          deep.entries = (deep.entries || []).filter(function (e) { return e && (e.content || e.text); }).map(function (e) { if (typeof e === 'string') return { content: e, text: e, enabled: true }; e.enabled = e.enabled !== false; return e; });
          if (deep.name === undefined && deep.title === undefined && card.name) deep.name = card.name + '的世界书';
          return deep;
        }
        return null;
      }
function extractPngChara(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('读取 PNG 失败')); };
        reader.onload = async function () {
          try {
            var bytes = new Uint8Array(reader.result);
            var text = await extractPngTextChunk(bytes, 'chara');
            if (!text) throw new Error('PNG 中没有找到角色卡数据');
            resolve(parseCardText(text));
          } catch (e) { reject(e); }
        };
        reader.readAsArrayBuffer(file);
      });
    }

    // ── SillyTavern 宏解析 ──────────────────────────────────────────
    function resolveMacros(text) {
      if (!text) return '';
      var result = text;
      // {{// 注释 }} → 删除
      result = result.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
      // {{random::a,b,c}} → 随机选一个
      result = result.replace(/\{\{random::([^}]+)\}\}/g, function (_, opts) {
        var parts = opts.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return parts.length ? parts[Math.floor(Math.random() * parts.length)] : '';
      });
      return result;
    }

    // ── 构建 agent.cordis.yml ────────────────────────────────────────
    function buildAgentYml(state) {
      var sections = [];
      var chs = (state.characters || []).filter(function (c) { return c.enabled; });
      if (chs.length) {
        var charBlocks = chs.map(function (c) {
          var lines = [];
          if (c.name) lines.push('角色名：' + c.name);
          if (c.desc) lines.push('角色设定：\n' + truncate(sanitizeForHarness(c.desc, c.name), 2000));
          if (c.first) lines.push('首条消息：\n' + truncate(sanitizeForHarness(c.first, c.name), 800));
          return lines.join('\n\n');
        }).filter(function (b) { return b; });
        if (charBlocks.length) sections.push('# 角色卡\n' + charBlocks.join('\n\n---\n\n'));
      }
      var wbInjected = [];
      // 预设级世界书（state.worldbooks）
      (state.worldbooks || []).forEach(function (wb) {
        if (!wb.enabled) return;
        (wb.entries || []).forEach(function (e, i) {
          if (e.enabled === false) return;
          var key = '';
          if (Array.isArray(e.keys) && e.keys.length) key = e.keys.join(', ');
          else if (Array.isArray(e.keywords) && e.keywords.length) key = e.keywords.join(', ');
          else key = e.key || e.name || e.comment || ('世界书' + (i + 1));
          if (e.content || e.text) wbInjected.push('【' + key + '】\n' + truncate(sanitizeForHarness(e.content || e.text || '', ''), 800));
        });
      });
      // 会话级世界书（wbGroups/wbEntries，从 /api/tavern/worldbook 加载）
      if (typeof wbGroups !== 'undefined' && wbGroups && wbGroups.length) {
        wbGroups.forEach(function (group) {
          if (group.enabled === false) return;
          (group.entries || []).forEach(function (e, i) {
            if (e.enabled === false) return;
            var key = '';
            if (Array.isArray(e.keys) && e.keys.length) key = e.keys.join(', ');
            else if (Array.isArray(e.keywords) && e.keywords.length) key = e.keywords.join(', ');
            else key = e.key || e.name || e.comment || ('世界书' + (i + 1));
            if (e.content || e.text) wbInjected.push('【' + key + '】\n' + truncate(sanitizeForHarness(e.content || e.text || '', ''), 800));
          });
        });
      } else if (typeof wbEntries !== 'undefined' && wbEntries && wbEntries.length) {
        // 兜底：如果没有分组，直接用扁平数组
        wbEntries.forEach(function (e, i) {
          if (e.enabled === false) return;
          var key = '';
          if (Array.isArray(e.keys) && e.keys.length) key = e.keys.join(', ');
          else if (Array.isArray(e.keywords) && e.keywords.length) key = e.keywords.join(', ');
          else key = e.key || e.name || e.comment || ('世界书' + (i + 1));
          if (e.content || e.text) wbInjected.push('【' + key + '】\n' + truncate(sanitizeForHarness(e.content || e.text || '', ''), 800));
        });
      }
      if (wbInjected.length) sections.push('# 世界书\n' + wbInjected.slice(0, 50).join('\n\n'));
      if (state.storyBackground && state.storyBackground.trim()) {
        sections.push('# 故事背景\n' + truncate(sanitizeForHarness(state.storyBackground, ''), 6000));
      }
      var activeP = null;
      if (state.presets && state.presets.length) {
        var idx = state.activePresetIdx;
        // 如果没有选中任何预设，但有预设存在，自动使用第一个预设
        if (idx < 0 || idx >= state.presets.length) {
          idx = 0;
          state.activePresetIdx = 0;
        }
        activeP = state.presets[idx];
      }
      if (activeP) {
        var enabledModules = (activeP.modules || []).filter(function (p) { return p.enabled && p.content; });
        if (enabledModules.length) {
          // 注入所有启用的模块，每个模块最多 3000 字符（之前只注入8个、每个600字符，导致大部分预设内容丢失）
          var modParts = enabledModules.map(function (p) {
            var content = resolveMacros(p.content || '');
            return '【' + (p.name || '模块') + '】\n' + truncate(content, 3000);
          });
          sections.push('# 预设模块（' + activeP.name + '）\n' + modParts.join('\n\n'));
        }
      }
      if (state.extraPrompt) sections.push('# 自定义设定\n' + state.extraPrompt);
      // ★ 成人模式【不在这里写】：它是全局开关，由服务端 tavern:nsfw 段落按真实状态注入。
      //   以前这里用前端内存状态 state.nsfw 决定要不要写破限词，而那个值从未与服务端同步、
      //   默认又是 true，于是「从没开过成人模式」也会把破限文案写进 persona（issue #2），
      //   开关却显示「关闭」，用户完全察觉不到；真开启时更会与服务端段落各写一套、
      //   重复注入两份不同的破限词。这里只保留与开关无关的通用写作要求。
      sections.push('# 写作要求\n' + '你是角色扮演助手。请严格扮演当前角色，保持人设，自然地推动剧情。\n所有思考、推理、内心独白必须使用中文。\n【工具规则】角色扮演/创作中默认不使用工具，不主动搜索对话历史/记忆/文件；只有用户明确要求查文件、读硬盘或搜索时才允许使用文件工具，并且只做用户要求的那一件事。');
      // ★ 角色卡 / 世界书交给服务端按会话注入：世界书是关键词触发（省上下文），
      //   角色卡服务端会从 agent.cordis.yml 与 characters.json 读取。
      //   原先这些内容在这里被重复写进 persona，配合 complete:true 还会把
      //   服务端的「反八股 / 记忆 / 关系网 / NSFW / 工具开关」段落整段压掉。
      var forPersona = sections.filter(function (s) { return !/^# (?:角色卡|世界书)\n/.test(s); });
      var combined = sanitizeForHarness(forPersona.join('\n\n'), '');
      var agentYml = '# 酒馆管理面板生成\n- id: persona\n  name: \'@deepseek-ai/dsh-persona\'\n  config:\n    prefix: ' + yamlLiteral(combined) + '\n    includeRuntimeContext: false\n\n# 基础文件工具（仅在用户明确要求时使用，角色扮演中默认不用）\n- id: filesystem\n  name: cordis:group\n  group: true\n  isolate:\n    fs: true\n  config:\n    - id: fs-local\n      name: \'@deepseek-ai/dsh-fs-local\'\n      config:\n        cwd: !!js process.env.DSH_CWD ?? process.cwd()\n    - id: str-replace-editor\n      name: \'@deepseek-ai/dsh-tool-str-replace-editor\'\n      config:\n        maxOutputChars: 16000\n';
      var presetYml = 'name: 精简酒馆\ndescription: 由 Harness 酒馆管理面板生成。\n';
      return { agentYml: agentYml, presetYml: presetYml };
    }

    function insertIntoInput(text) {
      var input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea') || document.querySelector('[class*="composer"] textarea');
      if (!input) return false;
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = (input.value || '') + ((input.value || '') ? '\n' : '') + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = (input.textContent || '') + '\n' + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }

    // ── CSS 样式（统一类名，避免内联样式被覆盖） ─────────────────────
    var TAVERN_CSS = [
      // 字体：用 DSH 自己的字体 token，别自带字体栈 —— 自带时 Windows 上中文会落到
      // Microsoft YaHei（笔画更重、字形更黑），与设置页其余部分（PingFang/系统栈）不一致。
      '#tavern-manager{font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif);color:var(--dsw-alias-label-primary);max-width:820px;padding:4px 0}',
      // ── S3：语义颜色令牌（只加不删层）────────────────────────────
      //   值一律**逐字取自本文件已存在的字面量**，后续替换是同值替换（不动渲染结果）。
      '#tavern-manager{--tv-color-danger:#e74c3c;--tv-color-success:#27ae60;--tv-color-warn:#f39c12;--tv-color-accent:#e94560;--tv-color-on-accent:#fff}',
      // ── S3 批3：间距令牌（只加不删层）────────────────────────────
      //   值与颜色令牌同理：逐字取自本文件已存在的字面量 ⇒ 后续替换是同值替换。
      '#tavern-manager{--tv-space-xs:4px;--tv-space-sm:6px;--tv-space-md:8px;--tv-space-lg:12px}',
      '#tavern-manager *{box-sizing:border-box}',
      // 标题此前 20px/700 比 DSH 设置页自己的标题（14–16px/400–600）更粗更大，视觉上"跳出来"
      '#tavern-manager h2{font-size:16px;font-weight:600;line-height:24px;margin:0 0 12px;color:var(--dsw-alias-label-primary)}',
      '#tavern-manager .t-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:12px}',
      '#tavern-manager .t-card-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);display:block;margin-bottom:8px}',
      '#tavern-manager .t-card-desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-weight:400}',
      '#tavern-manager .t-row{display:flex;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap}',
      '#tavern-manager .t-row + .t-row{margin-top:6px}',
      '#tavern-manager label.t-check{display:inline-flex;align-items:center;gap:var(--tv-space-sm);cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary);margin:0;white-space:nowrap}',
      '#tavern-manager label.t-check input[type=checkbox],#tavern-manager label.t-check input[type=radio]{margin:0;flex:0 0 auto;width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}',
      '#tavern-manager .t-list{margin-top:6px;display:flex;flex-direction:column;gap:var(--tv-space-xs)}',
      '#tavern-manager .t-item{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '#tavern-manager .t-item-row{display:flex;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap}',
      '#tavern-manager .t-item-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#tavern-manager .t-item-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.4;word-break:break-all}',
      '#tavern-manager .t-item-children{margin-top:6px;padding-left:20px;display:block;max-height:50vh;overflow-y:scroll;border-left:2px solid var(--dsw-alias-border-l1)}',
      '#tavern-manager .t-entry{display:flex;align-items:center;gap:var(--tv-space-sm);font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}',
      '#tavern-manager .t-entry input{margin:0;flex:0 0 auto;width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}',
      '#tavern-manager .t-entry span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#tavern-manager button{cursor:pointer;border:1px solid transparent;border-radius:8px;padding:7px 14px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base,#1a1a1a);font-size:13px;font-weight:600;transition:opacity .15s;font-family:inherit}',
      '#tavern-manager button:hover{opacity:.85}',
      '#tavern-manager button.t-btn-secondary{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);font-weight:400}',
      '#tavern-manager .t-dropzone{border:2px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:20px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary);margin-top:8px;cursor:pointer;transition:all .2s;background:rgba(255,255,255,.02)}',
      '#tavern-manager .t-dropzone:hover{border-color:var(--dsw-alias-brand-primary);background:rgba(122,184,255,.05)}',
      '#tavern-manager .t-dropzone.drag-over{border-color:var(--dsw-alias-brand-primary);background:rgba(122,184,255,.1);transform:scale(1.01)}',
      '#tavern-manager .t-dropzone .dz-icon{font-size:28px;display:block;margin-bottom:6px}',
      '#tavern-manager .t-dropzone .dz-title{font-weight:600;color:var(--dsw-alias-label-secondary);font-size:14px}',
      '#tavern-manager .t-dropzone .dz-desc{font-size:11px;margin-top:4px}',
      '#tavern-manager button.t-btn-secondary:hover{background:var(--dsw-alias-bg-layer-1);opacity:1}',
      '#tavern-manager button:disabled{opacity:.5;cursor:not-allowed}',
      '#tavern-manager button.t-btn-sm{padding:5px 10px;font-size:12px}',
      '#tavern-manager button.t-btn-toggle{background:transparent;border:none;padding:0 4px;font-size:12px;color:var(--dsw-alias-label-secondary);width:20px}',
      '#tavern-manager input[type=file]{padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;flex:1;min-width:160px}',
      '#tavern-manager input[type=text],#tavern-manager input[type=number],#tavern-manager input[type=password],#tavern-manager select,#tavern-manager textarea{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%}',
      '#tavern-manager input[type=number]{width:64px;text-align:center}',
      '#tavern-manager select{flex:1;min-width:180px;padding:6px 8px}',
      '#tavern-manager textarea{resize:vertical;line-height:1.5}',
      '#tavern-manager .t-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0 3px}',
      '#tavern-manager .t-status{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '#tavern-manager .t-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '#tavern-manager .t-status-err{color:var(--dsw-alias-state-error-primary)}',
      '#tavern-manager .t-divider{height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}',
      '#tavern-manager .t-mode-group{display:flex;flex-direction:column;gap:var(--tv-space-xs);margin-top:4px}',

      // ── 标签页（把二十来张卡片收进 4 个页签）──
      '#tavern-manager .t-tabbar{display:flex;gap:var(--tv-space-xs);flex-wrap:wrap;margin:8px 0 12px;padding:4px;' +
        'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;' +
        'position:sticky;top:0;z-index:30}',
      '#tavern-manager .t-tab{flex:1 1 0;min-width:84px;text-align:center;cursor:pointer;padding:7px 8px;' +
        'border-radius:8px;font-size:13px;line-height:1.25;white-space:nowrap;' +
        'background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);' +
        'transition:background .15s,color .15s}',
      // ★ hover 与 active 必须**肉眼可分**：两者都用 --dsw-alias-bg-layer-2 时，
      //   鼠标划过和"当前页签"长得一模一样，用户分不清自己在哪一页。
      //   hover 走 interactive 令牌（比 layer-2 浅一档），active 保持 layer-2 + 边框 + 加粗。
      '#tavern-manager .t-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);opacity:1}',
      '#tavern-manager .t-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '#tavern-manager .t-tab.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);' +
        'border-color:var(--dsw-alias-border-l2);font-weight:600}',
      '#tavern-manager .t-pane{display:none}',
      '#tavern-manager .t-pane.active{display:block}',
      '#tavern-manager .t-pane > .t-card:first-child{margin-top:0}'
    ].join('');

    function ensureStyle() {
      var id = 'dsh-tavern-manager-style';
      if (document.getElementById(id)) return;
      var el = document.createElement('style');
      el.id = id;
      el.textContent = TAVERN_CSS;
      document.head.appendChild(el);
    }

    // ── 面板 HTML ────────────────────────────────────────────────────
    function panelHTML() {
      return [
        '<div id="tavern-manager">',
        '  <h2>🍺 酒馆管理（原生）</h2>',

        // 预设选择器（会话级）
        '  <div class="t-card" data-tv-tab="session" style="background:rgba(122,184,255,.08);border-color:rgba(122,184,255,.3)">',
        '    <span class="t-card-title">🎭 当前 Agent 预设 <span class="t-card-desc">生成/编辑 Agent 预设，新会话在顶部选择后直接开始聊天</span></span>',
        '    <div class="t-row" style="margin-top:8px;align-items:center">',
        '      <div id="tavern-session-preset-wrap" style="flex:1;position:relative">',
        '        <div id="tavern-session-preset-btn" style="padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:space-between">',
        '          <span id="tavern-session-preset-label" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">加载中…</span>',
        '          <span style="margin-left:8px;color:var(--dsw-alias-label-tertiary,#888)">▼</span>',
        '        </div>',
        '        <div id="tavern-session-preset-panel" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;z-index:1000;max-height:400px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.5)">',
        '        </div>',
        // ★ P0-3b：预设真名线索行。刻意**不放进** #tavern-session-preset-label ——
        //   那个 label 的 textContent 会被 saveCurrent() 当预设名写进 preset.yml（见 ~1750 行），
        //   把「⚠️ _示例卡2」之类线索混进去会把预设改成一个莫名其妙的名字。
        '        <div id="tavern-session-preset-identity" style="margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>',
        '      </div>',
        '      <button id="tavern-preset-new" type="button" class="t-btn-secondary" style="white-space:nowrap">＋ 新建</button>',
        '      <button id="tavern-preset-copy" type="button" class="t-btn-secondary" style="white-space:nowrap">⧉ 复制</button>',
        '      <button id="tavern-preset-rename" type="button" class="t-btn-secondary" style="white-space:nowrap" title="重命名当前预设">重命名</button>',
        '      <button id="tavern-preset-del" type="button" class="t-btn-secondary" style="white-space:nowrap;color:var(--tv-color-danger)">🗑️ 删除</button>',
        '    </div>',
        '    <div id="tavern-preset-status" class="t-status" style="margin-top:6px;font-size:12px;color:var(--dsw-alias-brand-primary,#7ab8ff)">正在加载当前会话预设…</div>',
        '  </div>',

        // ── P0-3a：当前会话绑定（三态）─────────────────────────────
        // 三个概念必须一眼分得开（混在一起就是本次「示例卡」事故的根源）：
        //   ① 当前会话绑定   —— 会话权威值，决定这一轮注入谁的卡；只有「解绑」「应用到当前会话」能改。
        //   ② 应用到当前会话 —— 真写 binding（POST /api/tavern/bind-preset）。
        //   ③ 换绑并仅对新会话生效 —— **只改 UI 草稿**，一个字节都不写当前会话 binding。
        '  <div class="t-card" data-tv-tab="session" style="border-color:rgba(243,156,18,.4)">',
        '    <span class="t-card-title">🔗 当前会话绑定 <span class="t-card-desc">绑定决定这一轮注入哪张角色卡/世界书；解绑后回到会话出生默认值</span></span>',
        '    <div class="t-row" style="margin-top:8px;align-items:center;flex-wrap:wrap;gap:var(--tv-space-sm)">',
        '      <span style="font-size:13px;color:var(--dsw-alias-label-secondary,#ccc)">当前会话绑定：</span>',
        '      <span id="tavern-binding-current" style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">读取中…</span>',
        '      <span id="tavern-binding-source" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999)"></span>',
        '    </div>',
        // legacy（旧版本自动写入的绑定）不生效但会误导人 —— 红条明确要求用户确认或解绑。
        '    <div id="tavern-binding-legacy" style="display:none;margin-top:6px;padding:6px 10px;border-radius:6px;background:rgba(231,76,60,.12);color:var(--tv-color-danger);font-size:12px"></div>',
        '    <div class="t-row" style="margin-top:8px;gap:var(--tv-space-sm);flex-wrap:wrap">',
        '      <button id="tavern-binding-unbind" type="button" class="t-btn-secondary" data-action="unbind" style="color:var(--tv-color-danger);white-space:nowrap">🔓 解绑本会话</button>',
        '      <button id="tavern-binding-apply-current" type="button" style="white-space:nowrap">✅ 应用到当前会话</button>',
        '      <button id="tavern-binding-new-session" type="button" class="t-btn-secondary" style="white-space:nowrap">🆕 换绑并仅对新会话生效</button>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px;align-items:center;gap:var(--tv-space-sm)">',
        '      <span style="font-size:12px;color:var(--dsw-alias-label-secondary,#ccc);white-space:nowrap">下次新会话预选：</span>',
        '      <select id="tavern-binding-next-select" style="flex:1;min-width:180px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:13px"><option value="">（不改，跟随当前绑定）</option></select>',
        '    </div>',
        '    <div id="tavern-binding-status" class="t-status" style="margin-top:6px;font-size:12px"></div>',
        // ── 设定注入量：本会话级覆盖（全局默认在「🎯 生效范围」里）─────────────
        // 用途：某一场（比如要写高强度剧情）想确保模型**一定看得到全部设定**，就切「全量」；
        //   平时切回「跟随规则」省钱（按触发词只注入命中的条目）。
        '    <div class="t-row" style="margin-top:8px;align-items:center;gap:var(--tv-space-sm);flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px">',
        '      <span style="font-size:12px;color:var(--dsw-alias-label-secondary,#ccc);white-space:nowrap">📚 本会话设定注入：</span>',
        '      <button id="tavern-wbmode-follow" type="button" class="t-btn-secondary t-btn-sm" style="white-space:nowrap">🪶 跟随规则（省 token）</button>',
        '      <button id="tavern-wbmode-full" type="button" class="t-btn-sm" style="white-space:nowrap">💯 全量注入（确保看到设定）</button>',
        '      <span id="tavern-wbmode-status" class="t-status" style="margin:0;font-size:11px"></span>',
        '    </div>',
        // ── 预设声明：让酒馆预设真的成为 DSH 原生预设 ──────────────
        // 为什么需要这一步：本版 DSH 的预设是**声明行**（@deepseek-ai/dsh-agent-preset），
        // 它**不再读** .agent-presets/ 目录 —— 不声明的话，酒馆预设根本不在聊天顶部的
        // 预设选择器里，也就谈不上「会话选择了这个酒馆预设」。开关默认 off（不碰用户配置）。
        '    <div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#444)">',
        '      <div style="font-size:12px;color:var(--dsw-alias-label-secondary,#ccc)">DSH 原生预设：<span id="tavern-declare-status">读取中…</span></div>',
        '      <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm);flex-wrap:wrap">',
        '        <button id="tavern-declare-apply" type="button" style="white-space:nowrap">📢 声明为 DSH 预设</button>',
        '        <button id="tavern-declare-bundle" type="button" class="t-btn-secondary" style="white-space:nowrap">📦 只生成 bundle</button>',
        '        <button id="tavern-declare-off" type="button" class="t-btn-secondary" style="white-space:nowrap;color:var(--tv-color-danger)">🧹 撤下声明</button>',
        '      </div>',
        '      <div id="tavern-declare-hint" style="margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)">声明会把酒馆预设写进 DSH 的预设名册（顶部选择器可见）；写入前会先给你看预览，并自动备份。</div>',
        '    </div>',
        '  </div>',

        // ── P0-6：生效范围（傻瓜式）─────────────────────────────
        // 发布版语义：注入资格由「🔗 当前会话绑定」的**显式绑定闸门**保证（自动绑定已删、
        //   creation 通道不注入）；本卡只管「生效范围」——绑了卡的会话里，哪些能真的吃到注入。
        //   · 🌍 所有会话生效 → mode=global（disabledCwds 仍可排除某些工作区）
        //   · 💬 仅当前会话   → mode=allowlist + allowSessions 追加 currentSessionId
        //   · 📁 当前工作区   → mode=allowlist + allowCwds 追加 currentCwd
        // 核心诉求：自动检测优先（currentCwd / currentSessionId 由后端 GET state 直接给），
        //   取不到才弹手输框 —— 绝不让普通用户一上来就填路径 / 改 JSON。
        '  <div class="t-card" data-tv-tab="session" style="border-color:rgba(46,204,113,.4)">',
        '    <span class="t-card-title">🎯 生效范围 <span class="t-card-desc">决定哪些会话能用到酒馆注入（注入哪张卡仍由上方「🔗 当前会话绑定」决定）</span></span>',
        '    <div id="tavern-scope2-status" class="t-status" style="margin-top:6px;font-size:12px"></div>',
        '    <div class="t-row" style="margin-top:8px;gap:var(--tv-space-sm);flex-wrap:wrap">',
        '      <button id="tavern-scope-global" type="button" data-scope-mode="global">🌍 所有会话生效</button>',
        '      <button id="tavern-scope-session" type="button" class="t-btn-secondary" data-scope-mode="session">💬 仅当前会话</button>',
        '      <button id="tavern-scope-cwd" type="button" class="t-btn-secondary" data-scope-mode="cwd">📁 当前工作区</button>',
        '    </div>',
        '    <div id="tavern-scope-allow-title" style="margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#ccc)">已放行：</div>',
        '    <div id="tavern-scope-allow-chips" style="display:flex;flex-wrap:wrap;gap:var(--tv-space-sm);margin-top:4px"></div>',
        '    <div id="tavern-scope-disable-title" style="margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#ccc)">已排除：</div>',
        '    <div id="tavern-scope-disable-chips" style="display:flex;flex-wrap:wrap;gap:var(--tv-space-sm);margin-top:4px"></div>',
        // ── P2-1：世界书注入量（傻瓜式逃生阀）─────────────────
        //   'follow'（默认）= 跟随卡里的 injectMode（触发词按需注入，省 token）；
        //   'full' = 无视卡设定强制全量（发现漏设定时的一键后悔药）。
        '    <div style="margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#ccc)">📚 世界书注入量：</div>',
        '    <div class="t-row" style="margin-top:4px;gap:var(--tv-space-sm);align-items:center">',
        '      <select id="tavern-wb-inject" style="padding:4px 8px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:12px;cursor:pointer">',
        '        <option value="follow">跟随卡设定（推荐）</option>',
        '        <option value="full">全量注入（救急）</option>',
        '      </select>',
        '      <span id="tavern-wb-inject-status" class="t-status" style="font-size:12px"></span>',
        '    </div>',
        '    <div style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px;line-height:1.6">「跟随卡设定」= 按卡里设定的触发词注入：聊天中提到相关设定才展开对应条目，省 token。「全量注入」= 每轮把所有条目全塞进去，若发现角色漏了某段设定，切过去一键救急（更费 token）。</div>',
        '  </div>',

        // 角色卡
        '  <div class="t-card" data-tv-tab="content">',
        '    <span class="t-card-title">角色卡 <span class="t-card-desc">支持 PNG / JSON，可导入多份</span></span>',
        '    <div id="tavern-char-list" class="t-list"></div>',
        '    <div id="tavern-char-drop" class="t-dropzone" data-type="char">',
        '      <span class="dz-icon">🎭</span>',
        '      <span class="dz-title">拖入角色卡文件</span>',
        '      <span class="dz-desc">支持 .png / .json 格式，或点击选择文件</span>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px">',
        '      <input type="file" id="tavern-char-file" accept=".json,.png,image/png,application/json" style="display:none">',
        '      <button id="tavern-char-choose" type="button" class="t-btn-secondary">选择文件</button>',
        '      <button id="tavern-insert-char" type="button">插入当前对话</button>',
        '    </div>',
        '  </div>',

        // 世界书
        '  <div class="t-card" data-tv-tab="content">',
        '    <span class="t-card-title">📚 世界书 <span class="t-card-desc">支持 JSON，可导入多份，关键词触发省 token</span></span>',
        '    <div class="t-row" style="margin-top:8px;align-items:center;flex-wrap:wrap;gap:var(--tv-space-md)">',
        '      <label class="t-check" style="font-size:12px">注入模式：',
        '        <select id="tavern-wb-mode" style="font-size:12px">',
        '          <option value="full">全文注入（所有启用条目）</option>',
        '          <option value="keyword">关键词触发（只注入命中条目）</option>',
        '        </select>',
        '      </label>',
        '      <button id="tavern-wb-mode-toggle" type="button" class="t-btn-secondary t-btn-sm" title="一键在「关键词触发」与「全量注入」之间切换">⇄ 切换为关键词触发</button>',
        '      <span id="tavern-wb-mode-hint" style="font-size:11px;color:var(--dsw-alias-label-secondary);flex:1 1 300px;min-width:220px;line-height:1.65"></span>',
        '      <div id="tavern-prompt-size" style="flex:1 1 100%;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-default);font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary)"></div>',
        '      <button id="tavern-wb-add" type="button" class="t-btn-secondary t-btn-sm">＋ 新增条目</button>',
        '      <span id="tavern-wb-status" style="font-size:11px;color:var(--dsw-alias-label-secondary)"></span>',
        '    </div>',
        '    <div id="tavern-wb-list" class="t-list" style="margin-top:8px"></div>',
        '    <div id="tavern-wb-drop" class="t-dropzone" data-type="wb">',
        '      <span class="dz-icon">📖</span>',
        '      <span class="dz-title">拖入世界书文件</span>',
        '      <span class="dz-desc">支持 .json 格式，或点击选择文件</span>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px">',
        '      <input type="file" id="tavern-wb-file" accept=".json,application/json" style="display:none">',
        '      <button id="tavern-wb-choose" type="button" class="t-btn-secondary">选择文件</button>',
        '      <button id="tavern-insert-wb" type="button">插入当前对话</button>',
        '    </div>',
        '  </div>',

        // ── 注入开关（常驻可见）────────────────────────────────
        // 这两个开关原先被放在「⚙️ 高级功能」卡片里，而那张卡片默认 style="display:none"，
        // 于是开关实际不存在于界面上：用户根本找不到，状态永远是默认的关闭。
        // 它们直接决定每一轮的注入内容，属于常用开关，必须放在一级可见位置。
        // ── 🔞 成人向提示段（**正文由使用者自己填**）────────────────────
        // 服务端 `tavern:nsfw` 段只负责「按会话把 state.nsfwPrompt 注入进去」，
        // 并在统一生效范围闸门（会话隔离 / cwd 名单）下工作。
        // 把正文放在 state 里（而不是写进代码）有两个直接好处：
        //   ① 正文不会随发布包出门，也不会被更新覆盖；
        //   ② 插件本身保持"不含该段正文"—— 要什么尺度由使用者自己写。
        '  <div class="t-card" data-tv-tab="play">',
        '    <span class="t-card-title">🔞 成人向提示段 <span class="t-card-desc">自己填正文；按会话注入并过统一生效范围闸门。正文只存本机配置，不进代码/发布包</span></span>',
        '    <div class="t-row" style="margin-top:8px;align-items:center;justify-content:space-between">',
        '      <label style="display:flex;align-items:center;gap:var(--tv-space-sm);cursor:pointer;font-size:13px">',
        '        <input type="checkbox" id="tavern-nsfw-enabled" style="cursor:pointer;width:16px;height:16px">',
        '        <span>启用（正文为空时不注入）</span>',
        '      </label>',
        '      <span id="tavern-nsfw-status" class="t-status" style="margin:0">读取中…</span>',
        '    </div>',
        '    <textarea id="tavern-nsfw-prompt" rows="6" style="margin-top:6px" placeholder="在这里粘贴/编写你的提示段正文：只保存在本机 tavern-state.json 的 nsfwPrompt 字段里，不会进入代码或发布包"></textarea>',
        '    <div class="t-row" style="margin-top:6px;gap:var(--tv-space-md);align-items:center">',
        '      <button id="tavern-nsfw-save" type="button" class="t-btn-sm">💾 保存正文</button>',
        '      <span class="t-status" style="margin:0;font-size:11px">正文改动写入服务端 state，下次组装提示词生效（失焦也会自动保存）</span>',
        '    </div>',
        '  </div>',

        '  <div class="t-card" data-tv-tab="play">',
        '    <span class="t-card-title">🎭 剧情选项 <span class="t-card-desc">要求模型在回复结尾给出可选行动，并渲染成可点按钮；开关即时写入服务端</span></span>',
        '    <div class="t-row" style="margin-top:8px;align-items:center;justify-content:space-between">',
        '      <label style="display:flex;align-items:center;gap:var(--tv-space-sm);cursor:pointer;font-size:13px">',
        '        <input type="checkbox" id="tavern-plot-options" style="cursor:pointer;width:16px;height:16px">',
        '        <span>启用剧情选项</span>',
        '      </label>',
        '      <span id="tavern-plot-options-status" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999)">关闭</span>',
        '    </div>',
        '  </div>',

        // ── 📌 开场白（唯一的开场白入口）────────────────────────────
        // 服务端：POST /api/tavern/greeting/insert { sessionId, presetId }
        //   → { ok, inserted, cardName, greetingLen, turn }（找不到卡/会话 → { ok:false, error }）
        // 把当前激活预设里启用中第一张卡的 first_mes 注入当前会话**末尾**。
        // ★ 2026-10-04：以前新会话有「自动播种开场白」，但它会把会话日志写坏到永久打不开
        //   （首个 surface 事件必须是 system/message，详见插件 lib/index.js 的
        //   canAppendGreetingSurface），整套机制已删除 —— **现在只有这个按钮能注入**，
        //   而且要求会话已经跑过至少一个回合（否则会被服务端明确拒绝）。
        '  <div class="t-card" data-tv-tab="content" style="border-color:rgba(231,76,60,.35)">',
        '    <span class="t-card-title">📌 开场白 <span class="t-card-desc">把当前卡的开场白注入当前会话末尾（需会话已跑过一个回合）</span></span>',
        '    <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm);align-items:center;flex-wrap:wrap">',
        '      <button id="tavern-greeting-insert" type="button" class="t-btn-secondary t-btn-sm">➕ 注入开场白到会话末尾</button>',
        '    </div>',
        '    <div id="tavern-greeting-status" class="t-status" style="margin-top:6px">未注入</div>',
        '  </div>',

        // ── 🧩 全局正则（等价 ST 的全局 Regex 扩展）──────────────────
        // 数据源是 muv-engine 的全局正则注册表（GET/POST /api/muv-engine/global-regex），
        // 本卡片只做 UI：导入（文件拖拽/粘贴）+ 清单启停/删除。
        // 接口不可用（引擎未更新/未重启）→ 整卡降级提示，不许报错崩面板。
        // dropzone 用 data-type="gregex"：通用绑定会按 #tavern-gregex-file 找到文件输入，
        // 点击/拖拽视觉态复用既有逻辑；drop 读文件由 initGlobalRegexPanel 自己处理。
        '  <div class="t-card" data-tv-tab="play" style="border-color:rgba(52,152,219,.35)">',
        '    <span class="t-card-title">🧩 全局正则 <span class="t-card-desc">导入 ST 导出的正则脚本（对所有会话生效）：导入 → 启停 → 下一轮生效</span></span>',
        '    <div id="tavern-gregex-status" class="t-status" style="margin-top:6px">正在探测全局正则接口…</div>',
        '    <div id="tavern-gregex-list" class="t-list" style="margin-top:6px;max-height:260px;overflow-y:auto"></div>',
        '    <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm);align-items:center;flex-wrap:wrap">',
        '      <button id="tavern-gregex-refresh" type="button" class="t-btn-secondary t-btn-sm" title="重新从引擎拉取清单">🔄 刷新清单</button>',
        '      <button id="tavern-gregex-import" type="button" class="t-btn-sm" title="把下方解析好的脚本导入引擎注册表">📥 导入</button>',
        '    </div>',
        '    <div id="tavern-gregex-preview" style="margin-top:6px"></div>',
        '    <textarea id="tavern-gregex-paste" rows="4" style="margin-top:6px" placeholder="粘贴 ST 导出的正则 JSON（数组 / {scripts:[…]} / {data:{extensions:{regex_scripts:[…]}}} 三种形态均可）；也可拖入 .json 文件"></textarea>',
        '    <div id="tavern-gregex-drop" class="t-dropzone" data-type="gregex">',
        '      <span class="dz-icon">🧩</span>',
        '      <span class="dz-title">拖入正则脚本 JSON</span>',
        '      <span class="dz-desc">支持 .json 格式，或点击选择文件</span>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px">',
        '      <input type="file" id="tavern-gregex-file" accept=".json,application/json" style="display:none">',
        '      <button id="tavern-gregex-choose" type="button" class="t-btn-secondary">选择文件</button>',
        '    </div>',
        '  </div>',

        // 预设
        '  <div class="t-card" data-tv-tab="content">',
        '    <span class="t-card-title">预设 <span class="t-card-desc">支持 JSON，可导入多份并切换</span></span>',
          '    <div class="t-row" style="margin-top:6px;gap:var(--tv-space-sm)">',
          '      <input id="tavern-preset-search" type="text" placeholder="🔍 搜索预设名称…" style="flex:1">',
          '      <button id="tavern-preset-batch-del2" type="button" class="t-btn-secondary t-btn-sm" style="color:var(--tv-color-danger);white-space:nowrap">🗑️ 删除选中</button>',
          '    </div>',
        '    <div id="tavern-preset-list" class="t-list"></div>',
        '    <div id="tavern-preset-drop" class="t-dropzone" data-type="preset">',
        '      <span class="dz-icon">⚙️</span>',
        '      <span class="dz-title">拖入预设文件</span>',
        '      <span class="dz-desc">支持 .json 格式，或点击选择文件</span>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px">',
        '      <input type="file" id="tavern-preset-file" accept=".json,application/json" style="display:none">',
        '      <button id="tavern-preset-choose" type="button" class="t-btn-secondary">选择文件</button>',
        '    </div>',
        // （已移除）✨ 套用通用增强模块包 与 ✨ 通用增强层·运行时注入
        //   按用户要求整层删除：文风/防抢话/防全知这类要求交给 ST 预设自己表达，
        //   插件只负责把预设原样送进提示词，不再自动追加任何"通用约束"。
        //   底层纯函数与 /api/tavern/preset/enhance 仍在（可脚本调用），但没有界面入口。
        '  </div>',

        // ── 🎓 技能（Skill）：保存预设时自动生成 + 会话级自动绑定 + 手动选择 ──
        '  <div class="t-card" data-tv-tab="content" style="border-color:rgba(155,120,255,.35)">',
        '    <span class="t-card-title">🎓 技能（Skill） <span class="t-card-desc">保存预设时自动生成一个 DSH skill；选了这个预设的会话会自动"绑定"它</span></span>',
        '    <div id="tavern-skill-status" class="t-status" style="margin-top:6px;font-size:12px">读取中…</div>',
        '    <div class="t-row" style="margin-top:8px;gap:var(--tv-space-sm);flex-wrap:wrap">',
        '      <button id="tavern-skill-generate" type="button">⚙️ 生成 / 更新技能</button>',
        '      <button id="tavern-skill-refresh" type="button" class="t-btn-secondary">🔄 刷新清单</button>',
        '      <button id="tavern-skill-delete" type="button" class="t-btn-secondary" style="color:var(--tv-color-danger)">🗑️ 删除本预设的技能</button>',
        '    </div>',
        '    <div class="t-row" style="margin-top:8px;gap:var(--tv-space-lg);flex-wrap:wrap;font-size:12px">',
        '      <label class="t-check" style="display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer"><input type="checkbox" id="tavern-skill-auto"> 保存时自动生成</label>',
        '      <label class="t-check" style="display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer"><input type="checkbox" id="tavern-skill-full"> 附录世界书全文</label>',
        '      <label class="t-check" style="display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer"><input type="checkbox" id="tavern-skill-hint"> 会话里提示模型"有此技能"</label>',
        '    </div>',
        // 技能形态：决定"生成出来的 SKILL.md 是什么东西"。
        // DSH 里 skill 正文是**指令**（form: "instructions"），且用 /技能名 触发时宿主把它注入到
        // 这一步注入列表的**末尾**（最贴近回答）—— 所以「写作指令」形态比埋在 system prompt 顶部的
        // 同一段文字更容易被模型照做。索引形态只是清单，省 token。
        '    <div class="t-row" style="margin-top:8px;align-items:center;gap:var(--tv-space-sm);flex-wrap:wrap">',
        '      <span style="font-size:12px;color:var(--dsw-alias-label-secondary,#ccc);white-space:nowrap">技能形态：</span>',
        '      <select id="tavern-skill-style" style="flex:1;min-width:200px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:12px">',
        '        <option value="instructions">📝 写作指令 —— 把预设里启用中的写作要求写进技能（推荐）</option>',
        '        <option value="index">🔍 设定索引 —— 只列角色/世界书清单，省 token</option>',
        '      </select>',
        '    </div>',
        '    <div class="t-label" style="margin-top:10px;font-size:12px;font-weight:600">手动选择要绑定到这个预设的 skill</div>',
        '    <div id="tavern-skill-list" class="t-list" style="margin-top:4px;max-height:220px;overflow-y:auto"></div>',
        '    <div class="t-row" style="margin-top:8px;gap:var(--tv-space-sm);align-items:center">',
        '      <button id="tavern-skill-save-bind" type="button" class="t-btn-sm">💾 保存手动绑定</button>',
        '      <span id="tavern-skill-bind-status" class="t-status" style="margin:0;font-size:11px"></span>',
        '    </div>',
        '  </div>',



        // ── 高级功能（默认折叠）──
        '  <div class="t-card" data-tv-tab="advanced" style="background:rgba(255,255,255,.02)">',
        '    <span class="t-card-title" id="tavern-advanced-toggle" style="cursor:pointer;user-select:none">⚙️ 高级功能 <span class="t-card-desc">记忆 / 关系网 / 故事背景 / 写作辅助 / 回复体检</span> <span style="font-size:10px;color:var(--dsw-alias-label-tertiary,#888);margin-left:8px;transition:transform .2s;display:inline-block" id="tavern-advanced-arrow">▶</span></span>',
        '    <div id="tavern-advanced-body" style="display:none;margin-top:10px">',

        // （「🎭 剧情选项」开关已移到「世界书」卡片下方的常驻可见区域 ——
        //   原先放在这个默认折叠的卡片里，等于界面上没有这个开关。
        //   原同在此处的 NSFW 开关已随破限注入段一起删除。）

        // 故事背景
        '  <div class="t-card">',
        '    <span class="t-card-title">📖 故事背景 <span class="t-card-desc">从历史对话导入，作为剧情设定注入系统提示</span></span>',
        '    <div class="t-row" style="margin-top:6px">',
        '      <select id="tavern-session-select"><option value="">加载会话列表…</option></select>',
        '      <button id="tavern-session-load" type="button" class="t-btn-secondary">读取对话</button>',
        '      <button id="tavern-session-import" type="button">导入为故事背景</button>',
        '    </div>',
        '    <div id="tavern-session-status" class="t-status"></div>',
        '    <textarea id="tavern-story-bg" rows="5" style="margin-top:6px" placeholder="故事背景内容会出现在这里，可编辑后保存…"></textarea>',
        '    <div class="t-row" style="margin-top:6px"><button id="tavern-story-clear" type="button" class="t-btn-secondary t-btn-sm">清空故事背景</button></div>',
        '  </div>',

        // 记忆模块 + 手动总结（合并到一个卡片）
        '  <div class="t-card">',
        '    <span class="t-card-title">🧠 记忆与总结</span>',
        '    <div style="border-bottom:1px solid var(--dsw-alias-border-default);padding-bottom:10px;margin-bottom:10px">',
        '      <div style="font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px">⚙️ API 设置 <span style="font-size:11px">记忆总结调用的模型接口</span></div>',
        '      <div class="t-row" style="align-items:center;flex-wrap:wrap;gap:var(--tv-space-sm);margin-bottom:8px">',
        '        <label style="display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer;font-size:13px"><input type="radio" name="tavern-api-mode" id="tavern-mode-dsh" value="dsh" style="cursor:pointer"> 🔌 使用 DSH 已保存的连接</label>',
        '        <label style="display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer;font-size:13px"><input type="radio" name="tavern-api-mode" id="tavern-mode-manual" value="manual" style="cursor:pointer"> ✏️ 手动输入</label>',
        '      </div>',
        '      <div id="tavern-dsh-box" style="display:none">',
        '        <label class="t-label">DSH 连接（来自 DSH 设置里已保存的 API/模型配置）</label>',
        '        <select id="tavern-dsh-conn" style="width:100%;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:13px"><option value="">加载中…</option></select>',
        '        <label class="t-label">模型</label>',
        '        <select id="tavern-dsh-model" style="width:100%;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:13px"><option value="">选择连接后加载模型…</option></select>',
        '        <div id="tavern-dsh-keyhint" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:4px"></div>',
        '      </div>',
        '      <div id="tavern-manual-box">',
        '        <label class="t-label">API 地址（OpenAI 兼容 /chat/completions）</label>',
        '        <input id="tavern-api-url" type="text" placeholder="https://opencode.ai/zen/go/v1/chat/completions 或 https://api.deepseek.com/chat/completions">',
        '        <label class="t-label">API 秘钥</label>',
        '        <input id="tavern-api-key" type="password" placeholder="sk-...">',
        '        <label class="t-label">模型</label>',
        '        <input id="tavern-api-model" type="text" value="deepseek-chat">',
        '      </div>',
'      <div style="border-bottom:1px solid var(--dsw-alias-border-default);padding-bottom:8px;margin-bottom:8px">',
'        <label class="t-label">🎭 玩家名（替换 {{user}} 占位符，如：栎木）</label>',
'        <input id="tavern-player-name" type="text" placeholder="栎木" style="width:100%;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#2a2a3e);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;font-size:13px">',
'      </div>',
        '      <div class="t-row" style="margin-top:10px">',
        '        <label class="t-check"><input type="checkbox" id="tavern-auto-enabled"> 自动总结</label>',
        '        <label class="t-check">每 <input id="tavern-auto-every" type="number" min="1" value="20"> 楼总结一次</label>',
        '        <button id="tavern-api-save" type="button">💾 保存设置</button>',
        '      </div>',
        '      <div id="tavern-api-status" class="t-status"></div>',
        '      <div id="tavern-auto-progress" class="t-status" style="font-size:12px;color:var(--dsw-alias-label-tertiary,#888);margin-top:4px">自动总结：读取中…</div>',

        '    </div>',
        '    <div style="margin-bottom:10px">',
        '      <div style="font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px">🚀 手动总结 <span style="font-size:11px">读取最近对话，自动写入记忆并更新关系网</span></div>',
        '      <div class="t-row" style="align-items:center;flex-wrap:wrap;gap:var(--tv-space-md)">',
        '        <label class="t-check">最近 <input id="tavern-summarize-rounds" type="number" min="1" value="20"> 楼</label>',
        '        <button id="tavern-summarize-run" type="button">📝 立即总结</button>',
        '      </div>',
        '      <div id="tavern-summary-preview" class="t-status" style="white-space:pre-wrap;margin-top:6px"></div>',
        '    </div>',
        '    <div>',
        '      <div style="font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px">📝 会话记忆 <span style="font-size:11px">每个对话独立，新对话不会继承旧记忆</span></div>',
        '      <textarea id="tavern-memory-text" rows="4" style="margin-top:6px" placeholder="当前对话的记忆内容..."></textarea>',
        '      <div class="t-row" style="margin-top:6px">',
        '        <button id="tavern-memory-save" type="button">保存记忆</button>',
        '        <button id="tavern-memory-load" type="button" class="t-btn-secondary">读取记忆</button>',
        '        <button id="tavern-memory-clear" type="button" class="t-btn-secondary" style="color:var(--tv-color-danger)">🗑️ 清除本对话记忆</button>',
        '      </div>',
        '    </div>',
        '  </div>',

        // ★ 写作辅助 + 上下文压缩（合并）
        //   注意：反八股 / 联网的开关**只在下方「系统开关」区**保留一份控件。
        //   这里原来各有一个勾选框，配「💾 保存」写入 /api/tavern/config，
        //   而下方那一份是改动即写 /api/tavern/state —— 同一个状态两套控件两套端点，
        //   且本卡片里那份只在 loadCurrent 时同步一次，于是
        //   「在下方改了反八股 → 回到这里点保存」会用过期勾选值把它覆盖回去。
        '  <div class="t-card">',
        '    <span class="t-card-title">✍️ 写作辅助</span>',
        '    <div style="border-bottom:1px solid var(--dsw-alias-border-default);padding-bottom:10px;margin-bottom:10px">',
        '      <div style="font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px">📛 违禁词列表 <span id="tavern-banned-count" style="font-size:11px"></span></div>',
        '      <div id="tavern-banned-tags" style="display:flex;flex-wrap:wrap;gap:var(--tv-space-xs);max-height:72px;overflow:hidden;margin-bottom:6px"></div>',
        '      <button id="tavern-banned-edit" type="button" class="t-btn-secondary t-btn-sm" style="font-size:11px">📝 编辑违禁词</button>',
        '    </div>',
        '    <div class="t-row"><button id="tavern-writing-save" type="button">💾 保存违禁词</button></div>',
        '    <div id="tavern-writing-status" class="t-status" style="margin-top:6px"></div>',
        '    <div style="border-top:1px solid var(--dsw-alias-border-default);margin-top:12px;padding-top:10px">',
        '      <div style="font-size:12px;font-weight:600;margin-bottom:6px">📦 上下文压缩</div>',
        '      <div style="font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:6px">⚠️ 请使用 DSH 连接做总结（记忆与总结 → 🔌 使用DSH连接），否则 Google API 可能超时</div>',
        '      <div class="t-row" style="align-items:center;flex-wrap:wrap;gap:var(--tv-space-md)">',
        '        <label class="t-check">压缩最近 <input id="tavern-compact-rounds" type="number" min="5" value="20"> 轮</label>',
        '        <button id="tavern-compact-run" type="button">🗜️ 压缩上下文</button>',
        '      </div>',
        '      <div id="tavern-compact-status" class="t-status" style="margin-top:6px"></div>',
        '    </div>',
        '  </div>',

        // 关系网
        '  <div class="t-card">',
        '    <span class="t-card-title">🔗 角色关系网</span>',
        '    <div id="tavern-relations-graph" class="t-status"></div>',
        '    <div class="t-row" style="margin-top:6px">',
        '      <button id="tavern-relations-render" type="button" class="t-btn-secondary">刷新图谱</button>',
        '      <button id="tavern-relations-expand" type="button" class="t-btn-secondary">🔍 放大查看</button>',
        '    </div>',
        '    <div style="margin-top:10px;border-top:1px solid var(--dsw-alias-border-default);padding-top:8px">',
        '      <span id="tavern-relations-json-toggle" style="cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);user-select:none">📝 手动编辑 JSON（高级）▼</span>',
        '      <div id="tavern-relations-json-body" style="display:none;margin-top:8px">',
        '        <textarea id="tavern-relations-data" rows="4" style="margin-top:6px" placeholder="{&quot;nodes&quot;:[{&quot;id&quot;:&quot;角色A&quot;,&quot;label&quot;:&quot;角色A&quot;}],&quot;edges&quot;:[{&quot;source&quot;:&quot;角色A&quot;,&quot;target&quot;:&quot;角色B&quot;,&quot;label&quot;:&quot;好友&quot;}]}"></textarea>',
        '        <div class="t-row" style="margin-top:6px">',
        '          <button id="tavern-relations-save" type="button">保存关系网</button>',
        '        </div>',
        '      </div>',
        '    </div>',
        // ★ 软注入开关：只提醒模型「本会话有关系网」，不注入内容、不影响剧情
        '    <div class="t-row" style="margin-top:10px;border-top:1px solid var(--dsw-alias-border-default);padding-top:8px;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap">',
        '      <label class="t-check" style="font-size:12px;display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer">',
        '        <input type="checkbox" id="tavern-relations-hint">',
        '        <span>软注入：只提醒模型「有关系网」，不注入内容、不影响剧情</span>',
        '      </label>',
        '      <span id="tavern-relations-hint-status" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#888)"></span>',
        '    </div>',
        '  </div>',

        // 回复体检：上一条回复到底是模型拒了，还是插件没注入
        '  <div class="t-card">',
        '    <span class="t-card-title">🩺 回复体检</span>',
        '    <div id="tavern-reply-check" class="t-status" style="line-height:1.7"></div>',
        '    <div class="t-row" style="margin-top:6px">',
        '      <button id="tavern-reply-recheck" type="button" class="t-btn-secondary t-btn-sm">🔄 重新体检</button>',
        '    </div>',
        '  </div>',

        // （世界书管理已集成到上面的世界书区域）

        '    </div>', // 关闭高级功能 body
        '  </div>', // 关闭高级功能 card


        // 额外设定
        '  <label class="t-label" style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)">额外设定 / 系统提示</label>',
        '  <textarea id="tavern-extra" rows="3" placeholder="可写额外世界观、文风、角色关系等"></textarea>',

        // AI 工具开关
        '  <div class="t-row" style="margin-top:10px;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap">',
        '    <label class="t-label" style="font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)">🔧 AI 工具</label>',
        '    <label class="t-check" style="font-size:12px;display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer">',
        '      <input id="tavern-tools-toggle" type="checkbox" checked>',
        '      <span>启用系统工具（pwsh 等）</span>',
        '    </label>',
        '    <span id="tavern-tools-status" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#888)"></span>',
        '  </div>',

        '  <div class="t-row" style="margin-top:6px;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap">',
        '    <label class="t-label" style="font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)">🌐 联网搜索</label>',
        '    <label class="t-check" style="font-size:12px;display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer">',
        '      <input id="tavern-network-toggle" type="checkbox">',
        '      <span>启用 web_search</span>',
        '    </label>',
        '    <span id="tavern-network-status" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#888)"></span>',
        '  </div>',
        '  <div class="t-row" style="margin-top:6px;align-items:center;gap:var(--tv-space-md);flex-wrap:wrap">',
        '    <label class="t-label" style="font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)">🚫 反AI八股</label>',
        '    <label class="t-check" style="font-size:12px;display:flex;align-items:center;gap:var(--tv-space-xs);cursor:pointer">',
        '      <input id="tavern-anticliche-toggle" type="checkbox" checked>',
        '      <span>禁用1302条套话</span>',
        '    </label>',
        '    <span id="tavern-anticliche-status" style="font-size:11px;color:var(--dsw-alias-label-tertiary,#888)"></span>',
        '  </div>',
        // 预览
        '  <label class="t-label" style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-top:12px">当前将保存的 agent.cordis.yml</label>',
        '  <textarea id="tavern-agent-yml" rows="10" style="font-family:monospace;font-size:12px"></textarea>',

        // 操作按钮
        '  <div class="t-row" style="margin-top:10px;align-items:center">',
        '    <button id="tavern-save" type="button" style="background:var(--tv-color-success);border-color:var(--tv-color-success);font-weight:600">💾 保存预设</button>',
        '    <button id="tavern-inject-exit" type="button" class="t-btn-secondary">✅ 保存并关闭</button>',
        '  </div>',
        '  <div id="tavern-status" class="t-status"></div>',
        '</div>'
      ].join('');
    }

    // ── 世界书重同步钩子 ─────────────────────────────────────────────
    // 面板挂载时把自己的 loadWb 注册进来，供「窗口重新获得焦点 / 标签页切回来」调用，
    // 这样在别处（独立设置页、另一个标签页、直接改文件）改过注入模式后，
    // 回到面板就能自动对齐。面板卸载后 loadWb 内部有 isConnected 守卫，不会打扰后端。
    var __tavernWbRefresh = null;
    var __tavernWbLastRefresh = 0;
    function __tavernWbFocusRefresh() {
      if (typeof __tavernWbRefresh !== 'function') return;
      if (Date.now() - __tavernWbLastRefresh < 3000) return;   // 节流：3 秒内只拉一次
      __tavernWbLastRefresh = Date.now();
      try { __tavernWbRefresh(); } catch (e) {}
    }
    function installWbFocusHook() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      if (window.__tavernWbFocusHook) return;
      window.__tavernWbFocusHook = true;
      var onWake = function () {
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        __tavernWbFocusRefresh();
      };
      try { window.addEventListener('focus', onWake); } catch (e) {}
      try { document.addEventListener('visibilitychange', onWake); } catch (e) {}
    }

    // ── 挂载酒馆管理器 ───────────────────────────────────────────────
    function mountTavernManager(root) {
      ensureStyle();
      root.innerHTML = panelHTML();
      var container = root.querySelector('#tavern-manager');
      // ★ 这里的 plotOptions 必须与服务端的默认值保持一致，
      //   并且在加载服务端状态时同步回来 —— 它以前是「只赋值给开关、从不回读」的，
      //   一旦被用在生成逻辑里就会写出与服务端实况不符的预设（issue #2 就是这样来的）。
      //   （nsfw 字段已随 NSFW 破限段一起删除，见 4171 行附近说明。）
      var state = { characters: [], worldbooks: [], presets: [], activePresetIdx: -1, extraPrompt: '', plotOptions: true, storyBackground: '' };
      var serverAgentYml = '';
        var presetSearch = '';
        var presetBatchSelected = {};

      // 自定义弹窗（Electron 禁用原生 prompt）
      function showPrompt(title, def) {
        return new Promise(function (resolve) {
          var ov = document.createElement('div');
          ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
        var box = document.createElement('div');
        box.style.cssText = 'background:var(--dsw-alias-bg-base,#1e1e2e);color:var(--dsw-alias-label-primary,#eee);border-radius:12px;padding:24px;min-width:320px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1)';
        var t = document.createElement('div');
        t.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:12px;color:var(--dsw-alias-label-primary,#fff)';
        t.textContent = title;
        box.appendChild(t);
        var input = document.createElement('input');
        input.type = 'text';
        input.value = def || '';
        input.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:var(--dsw-alias-bg-layer-2,#16162a);color:var(--dsw-alias-label-primary,#fff);font-size:14px;box-sizing:border-box;margin-bottom:16px';
          box.appendChild(input);
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
          var cancel = document.createElement('button');
          cancel.textContent = '取消';
          cancel.style.cssText = 'padding:8px 18px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:transparent;color:var(--dsw-alias-label-secondary,#ccc);font-size:13px;cursor:pointer';
          var ok = document.createElement('button');
          ok.textContent = '创建';
          ok.style.cssText = 'padding:8px 18px;border-radius:8px;border:none;background:#e94560;color:#fff;font-size:13px;cursor:pointer;font-weight:600';
          row.appendChild(cancel); row.appendChild(ok); box.appendChild(row); ov.appendChild(box);
          document.body.appendChild(ov);
          setTimeout(function () { input.focus(); }, 50);
          function done() { ov.remove(); }
          cancel.addEventListener('click', function () { done(); resolve(null); });
          ok.addEventListener('click', function () { done(); resolve(input.value); });
          input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); });
          ov.addEventListener('click', function (e) { if (e.target === ov) cancel.click(); });
        });
      }

      // 自定义确认框
      function showConfirm(message) {
        return new Promise(function (resolve) {
          var ov = document.createElement('div');
          ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
          var box = document.createElement('div');
          box.style.cssText = 'background:var(--dsw-alias-bg-base,#1e1e2e);color:var(--dsw-alias-label-primary,#eee);border-radius:12px;padding:24px;min-width:320px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1)';
          var t = document.createElement('div');
          t.style.cssText = 'font-size:15px;margin-bottom:20px;line-height:1.5;color:var(--dsw-alias-label-primary,#eee)';
          t.textContent = message;
          box.appendChild(t);
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
          var cancel = document.createElement('button');
          cancel.textContent = '取消';
          cancel.style.cssText = 'padding:8px 18px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:transparent;color:var(--dsw-alias-label-secondary,#ccc);font-size:13px;cursor:pointer';
          var ok = document.createElement('button');
          ok.textContent = '确定';
          ok.style.cssText = 'padding:8px 18px;border-radius:8px;border:none;background:#e74c3c;color:#fff;font-size:13px;cursor:pointer;font-weight:600';
          row.appendChild(cancel); row.appendChild(ok); box.appendChild(row); ov.appendChild(box);
          document.body.appendChild(ov);
          function done() { ov.remove(); }
          cancel.addEventListener('click', function () { done(); resolve(false); });
          ok.addEventListener('click', function () { done(); resolve(true); });
          ov.addEventListener('click', function (e) { if (e.target === ov) cancel.click(); });
        });
      }

      function stateHasContent() {
        return state.characters.length > 0 || state.worldbooks.length > 0 || state.presets.length > 0 || (state.storyBackground && state.storyBackground.trim()) || (state.extraPrompt && state.extraPrompt.trim());
      }

      function refreshYml() {
        var ta = container.querySelector('#tavern-agent-yml');
        if (!ta) return;
        if (stateHasContent()) {
          ta.value = buildAgentYml(state).agentYml;
        } else if (serverAgentYml) {
          ta.value = serverAgentYml;
        } else {
          ta.value = buildAgentYml(state).agentYml;
        }
      }

      function renderCharacters() {
        var el = container.querySelector('#tavern-char-list');
        if (!el) return;
        if (!state.characters.length) { el.innerHTML = '<div class="t-status">尚未导入角色卡（可导入多份）</div>'; return; }
        el.innerHTML = state.characters.map(function (c, i) {
          var checked = c.enabled !== false ? 'checked' : '';
          return '<div class="t-item">' +
            '<div class="t-item-row">' +
            '<label class="t-check"><input type="checkbox" data-char="' + i + '" ' + checked + '> <span class="t-item-name">' + esc(c.name || ('角色' + (i + 1))) + '</span></label>' +
            '<button data-char-del="' + i + '" type="button" class="t-btn-secondary t-btn-sm">删除</button>' +
            '</div>' +
            (c.desc ? '<div class="t-item-desc">' + esc(truncate(c.desc, 80)) + '</div>' : '') +
            '</div>';
        }).join('');
        el.querySelectorAll('[data-char]').forEach(function (cb) {
          cb.addEventListener('change', function () { state.characters[Number(cb.getAttribute('data-char'))].enabled = cb.checked; refreshYml(); autoSaveAfterChange(); });
        });
        el.querySelectorAll('[data-char-del]').forEach(function (btn) {
          btn.addEventListener('click', function () { state.characters.splice(Number(btn.getAttribute('data-char-del')), 1); renderCharacters(); refreshYml(); saveCurrent().catch(function () {}); });
        });
      }

      // （已清理）renderWorldbooks：它渲染的 #tavern-wb-manager-list 早已不在面板里，
      //   函数每次被调用都在第一行 return，属于纯死重。世界书卡片现在是 dropzone + 计数。

      // ★ activePresetIdx 持久化（只存「选中第几组」这个光标，不碰预设内容本身）：
      //   变化处防抖 POST 到 /api/tavern/state，服务端存进全局 state（与 NSFW 等开关同一套机制）。
      //   注意不走 saveCurrent/refreshYml 的保存路径，防止用旧值覆盖预设内容。
      var persistIdxTimer = null;
      function persistActivePresetIdx() {
        clearTimeout(persistIdxTimer);
        persistIdxTimer = setTimeout(function () {
          fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activePresetIdx: state.activePresetIdx }) }).catch(function () {});
        }, 400);
      }

      function renderPresets() {
        var el = container.querySelector('#tavern-preset-list');
        if (!el) return;
        if (!state.presets.length) { el.innerHTML = '<div class="t-status">尚未导入预设（可导入多份并切换）</div>'; return; }
        el.innerHTML = state.presets.map(function (p, i) {
          var isActive = state.activePresetIdx === i;
          var collapsed = p._collapsed !== false; // 默认折叠，除非明确设置为 false
          var mods = '';
          if ((p.modules || []).length) {
            var modCount = p.modules.length;
            mods = '<div class="t-item-children" style="' + (collapsed ? 'display:none' : '') + '">' + p.modules.map(function (m, j) {
              var mchk = m.enabled !== false ? 'checked' : '';
              return '<label class="t-entry"><input type="checkbox" data-pm="' + i + '" data-pmi="' + j + '" ' + mchk + '> <span>' + esc(m.name || ('模块' + (j + 1))) + '</span></label>';
            }).join('') + '</div>';
          }
          var toggleBtn = (p.modules || []).length ? '<button data-preset-toggle="' + i + '" type="button" class="t-btn-secondary t-btn-sm">' + (collapsed ? '▶ 展开(' + p.modules.length + ')' : '▼ 折叠(' + p.modules.length + ')') + '</button>' : '';
          return '<div class="t-item" style="' + (isActive ? 'border-color:var(--dsw-alias-brand-primary);border-width:2px' : '') + '">' +
            '<div class="t-item-row">' +
            '<label class="t-check" style="margin-right:4px"><input type="checkbox" data-preset-batch="' + i + '"></label>' +
              '<span class="t-item-name">' + esc(p.name || ('预设' + (i + 1))) + '</span>' +
            toggleBtn +
            '<button data-preset-active="' + i + '" type="button" class="t-btn-sm" style="' + (isActive ? '' : '') + '">' + (isActive ? '✓ 当前预设' : '切换到此预设') + '</button>' +
            '<button data-preset-del="' + i + '" type="button" class="t-btn-secondary t-btn-sm">删除</button>' +
            '</div>' +
            mods +
            '</div>';
        }).join('');
        el.querySelectorAll('[data-preset-active]').forEach(function (btn) {
          btn.addEventListener('click', function () { state.activePresetIdx = Number(btn.getAttribute('data-preset-active')); renderPresets(); refreshYml(); persistActivePresetIdx(); });
        });
        el.querySelectorAll('[data-pm]').forEach(function (cb) {
          cb.addEventListener('change', function () { var i = Number(cb.getAttribute('data-pm')); var j = Number(cb.getAttribute('data-pmi')); var m = state.presets[i].modules[j]; if (m) m.enabled = cb.checked; refreshYml(); autoSaveAfterChange(); });
        });
        el.querySelectorAll('[data-preset-del]').forEach(function (btn) {
          btn.addEventListener('click', function () { state.presets.splice(Number(btn.getAttribute('data-preset-del')), 1); if (state.activePresetIdx >= state.presets.length) state.activePresetIdx = state.presets.length - 1; renderPresets(); refreshYml(); saveCurrent().catch(function () {}); });
        });
        el.querySelectorAll('[data-preset-toggle]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var i = Number(btn.getAttribute('data-preset-toggle'));
            state.presets[i]._collapsed = !state.presets[i]._collapsed;
            renderPresets();
          });
        });
      }

        // 预设搜索：按名称过滤显示
        var presetSearchEl = container.querySelector('#tavern-preset-search');
        if (presetSearchEl) {
          presetSearchEl.addEventListener('input', function () {
            var kw = (this.value || '').trim().toLowerCase();
            var items = container.querySelectorAll('#tavern-preset-list .t-item');
            for (var si = 0; si < items.length; si++) {
              var nameEl = items[si].querySelector('.t-item-name');
              var txt = (nameEl ? nameEl.textContent : items[si].textContent || '').toLowerCase();
              items[si].style.display = (!kw || (txt || '').indexOf(kw) >= 0) ? '' : 'none';
            }
          });
        }

        // 预设批量删除
        var presetBatchDelBtn = container.querySelector('#tavern-preset-batch-del2');
        if (presetBatchDelBtn) {
          presetBatchDelBtn.addEventListener('click', async function () {
            var checked = Array.prototype.slice.call(container.querySelectorAll('[data-preset-batch]:checked')).map(function (cb) { return Number(cb.getAttribute('data-preset-batch')); }).sort(function (a, b) { return b - a; });
            if (!checked.length) { alert('请先勾选要删除的预设'); return; }
            if (!await showConfirm('确定删除选中的 ' + checked.length + ' 个预设？')) return;
            checked.forEach(function (idx) { state.presets.splice(idx, 1); });
            if (state.activePresetIdx >= state.presets.length) state.activePresetIdx = state.presets.length - 1;
            renderPresets();
            refreshYml();
            saveCurrent().catch(function () {});
          });
        }


      function handleCharFile(file) {
        if (!file) return Promise.resolve();
        async function addCard(json) {
          var card = json && json.data && typeof json.data === 'object' ? json.data : json;
          var name = card.name || '';
          // 自动检测同名角色卡，避免重复导入
            var dupCharIdx = state.characters.findIndex(function (c) { return c && (c.name || '').trim().toLowerCase() === name.trim().toLowerCase(); });
            if (dupCharIdx >= 0) {
              if (!await showConfirm('检测到同名角色卡「' + name + '」，是否替换为新的？')) return;
              state.characters.splice(dupCharIdx, 1);
            }
            state.characters.push({ name: name, desc: sanitizeForHarness(card.description || card.personality || card.char_persona || '', name), first: sanitizeForHarness(card.first_mes || card.first_message || card.char_greeting || '', name), enabled: true });
          // ★ 支持多种世界书字段名，兼容不同格式的角色卡 ★
                    var cb = findEmbeddedWorldbook(card);
          // 如果世界书是字符串（JSON 字符串），尝试解析
          if (cb && typeof cb === 'string') { try { cb = JSON.parse(cb); } catch (e) { cb = null; } }
          if (cb && Array.isArray(cb.entries) && cb.entries.length) {
            var wbEntriesFromCard = cb.entries.filter(function (e) { return e && (e.content || e.text); }).map(function (e) { e.enabled = e.enabled !== false; return e; });
            if (wbEntriesFromCard.length) {
              var wbName = (cb.name || cb.title || (name ? name + '的世界书' : '角色世界书'));
              var dupEmbeddedWb = state.worldbooks.find(function (w) { return w && (w.name || '').trim().toLowerCase() === wbName.trim().toLowerCase(); });
                if (dupEmbeddedWb) {
                  var seenE = {};
                  (dupEmbeddedWb.entries || []).forEach(function (e) { seenE[String(e.content || '')] = true; });
                  wbEntriesFromCard.forEach(function (e) { if (!seenE[String(e.content || '')]) { dupEmbeddedWb.entries.push(e); seenE[String(e.content || '')] = true; } });
                } else {
                  state.worldbooks.push({ name: wbName, entries: wbEntriesFromCard, enabled: true, linkedTo: name || '' });
                }
              // 同步到世界书管理区域（API）
              var pid = getActivePresetId() || '';
              // ★ 确保世界书保存到服务端，不依赖 wbEntries 是否在作用域内 ★
              // 不再限制必须有 sessionId：即使未检测到会话也要同步，防止 saveCurrent 用旧 wbGroups 覆盖掉刚导入的世界书
                // 尝试同步到世界书管理区域
                try {
                  if (typeof wbEntries !== 'undefined') {
                    wbEntriesFromCard.forEach(function (e) { wbEntries.push(e); });
                  }
                  if (typeof wbGroups !== 'undefined') {
                    var existingGroup = wbGroups.find(function (g) { return g.name === wbName; });
                    if (existingGroup) {
                      wbEntriesFromCard.forEach(function (e) {
                        if (!existingGroup.entries.some(function (x) { return String(x.content || '') === String(e.content || ''); })) {
                          existingGroup.entries.push(e);
                        }
                      });
                    } else {
                      wbGroups.push({ name: wbName, entries: wbEntriesFromCard.slice(), enabled: true });
                    }
                  }
                } catch (e) {}
                // 直接调用 API 保存世界书，确保即使 wbEntries 不在作用域内也能保存
                fetch('/api/tavern/worldbook', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ 
                    entries: (typeof wbEntries !== 'undefined') ? wbEntries : wbEntriesFromCard.slice(), 
                    groups: (typeof wbGroups !== 'undefined') ? wbGroups : [{ name: wbName, entries: wbEntriesFromCard.slice(), enabled: true }], 
                    injectMode: (typeof wbMode !== 'undefined') ? wbMode : 'full', 
                    presetId: getActivePresetId() || undefined 
                  })
                }).then(function (r) { return r.json(); }).then(function (res) {
                  if (res.ok && typeof loadWb === 'function') loadWb();
                }).catch(function () {});
            }
          }
          renderCharacters(); refreshYml();
          // 自动保存，确保 agent.cordis.yml 更新
          saveCurrent().catch(function () {});
        }
        if (file.name.toLowerCase().endsWith('.png') || file.type === 'image/png') return extractPngChara(file).then(addCard);
        // WebP/JPEG 等图片如果没有内嵌角色卡数据，不能按 JSON 解析，给出明确提示
        var isImage = /\.(webp|jpe?g|gif|bmp|avif)$/i.test(file.name || '') || /^image\//.test(file.type || '');
        if (isImage) return Promise.reject(new Error('图片里没有找到内嵌角色卡数据（chara/character_book）。请使用 SillyTavern 导出的 PNG/JSON 角色卡。'));
        return file.text().then(function (text) {
          var json = parseJsonText(text);
          // ★ 世界书文件走错门：SillyTavern 的「世界书导出」也是 .json（形如 {entries:{...}}），
          //   按角色卡导入只会塞进一张**空卡**（name/description/first_mes 全空），
          //   用户以为"卡导进去了但世界书没跟来"。这里直接改道世界书导入，并且不产生空卡。
          if (looksLikeWorldbook(json)) {
            return handleWbFile(file).then(function () {
              var st = container.querySelector('#tavern-wb-status');
              if (st) st.textContent = 'ℹ️ 这是世界书文件（不是角色卡），已按世界书导入：' + (file.name || '未命名');
            });
          }
          var card0 = json && json.data && typeof json.data === 'object' ? json.data : json;
          if (!card0 || (!card0.name && !card0.description && !card0.personality && !card0.char_persona && !card0.first_mes && !card0.first_message && !card0.char_greeting)) {
            return Promise.reject(new Error('这份 JSON 里没有角色卡字段（name / description / first_mes）。若它是世界书导出文件，请改用「世界书 → 导入」；若是角色卡，请从角色站重新导出。'));
          }
          return addCard(json);
        });
      }
      // 这本 JSON 是「世界书」而不是「角色卡」吗？
      // 判据：没有任何角色卡字段，却有世界书条目（entries / world_book / worldbook），
      // 且条目本身长得像 Lorebook 条目（content + key/keys/comment/constant/disable）。
      function looksLikeWorldbook(json) {
        if (!json || typeof json !== 'object') return false;
        var card = json.data && typeof json.data === 'object' ? json.data : json;
        if (card.name || card.description || card.personality || card.char_persona || card.first_mes || card.first_message || card.char_greeting || card.scenario || card.mes_example) return false;
        var raw = json.entries || json.world_book || json.worldbook || json.worldBook || card.entries || card.world_book || card.worldbook;
        if (!raw) return false;
        var list = Array.isArray(raw) ? raw : Object.values(raw || {});
        if (!list.length) return false;
        return list.some(function (e) {
          return e && typeof e === 'object' && (e.content || e.text) &&
            (e.key || e.keys || e.comment !== undefined || e.constant !== undefined || e.disable !== undefined);
        });
      }
      function handleWbFile(file) {
        if (!file) return Promise.resolve();
        return file.text().then(async function (text) {
          var data = parseJsonText(text);
          var list = Array.isArray(data) ? data : (data.entries || data.world_book || data.worldbook || []);
          if (!Array.isArray(list)) list = Object.values(list || {});
          // ★ DSH 兼容：世界书条目导入时立即清洗（剥 {{}}/thinking/HTML注释 等指令）
          var wbCleaned = 0;
          var entries = list.filter(function (e) { return e && (e.content || e.text); }).map(function (e) {
            var before = String(e.content || e.text || '');
            var after = sanitizeForHarness(before, '');
            if (after !== before) wbCleaned++;
            e.enabled = e.enabled !== false;
            e.content = after;
            if (typeof e.text === 'string') e.text = after;
            return e;
          });
          if (!entries.length) { alert('未找到有效的世界书条目'); return; }
          var name = (data && (data.name || data.title || data.comment)) || file.name.replace(/\.[^.]+$/, '');
          // 自动检测同名世界书，避免重复导入
            var dupWb = state.worldbooks.find(function (w) { return w && (w.name || '').trim().toLowerCase() === name.trim().toLowerCase(); });
            if (dupWb) {
              if (!await showConfirm('检测到同名世界书「' + name + '」，是否合并到已有世界书？')) return;
              var seen = {};
              (dupWb.entries || []).forEach(function (e) { seen[String(e.content || '')] = true; });
              entries.forEach(function (e) { if (!seen[String(e.content || '')]) { dupWb.entries.push(e); seen[String(e.content || '')] = true; } });
            } else {
              state.worldbooks.push({ name: name, entries: entries, enabled: true });
            }
          refreshYml();
          // 提示清理数量
          if (wbCleaned > 0) {
            var wt = container.querySelector('#tavern-wb-status');
            if (wt) wt.textContent = '✅ 已导入世界书：' + name + '（' + entries.length + ' 条，自动清理 ' + wbCleaned + ' 条不兼容内容）';
          }
          // 自动保存
          saveCurrent().catch(function () {});
          // 同步到管理区域（直接更新 wbEntries 和 wbGroups，不依赖重新加载）
          if (typeof wbEntries !== 'undefined') {
            var newEntries = entries.filter(function (e) {
                var key = String(e.content || '');
                return wbEntries.every(function (x) { return String(x.content || '') !== key; });
              });
              newEntries.forEach(function (e) { wbEntries.push(e); });
            // 添加到分组
            var existingGroup = wbGroups.find(function (g) { return g.name === name; });
            if (existingGroup) {
              newEntries.forEach(function (e) { existingGroup.entries.push(e); });
            } else {
              wbGroups.push({ name: name, entries: newEntries.slice(), enabled: true });
            }
            renderWbList();
            // 保存到 API
            var sid = getCurrentSessionId();
            if (sid) {
              fetch('/api/tavern/worldbook', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ entries: wbEntries, groups: wbGroups, injectMode: wbMode || 'full', presetId: getActivePresetId() || undefined })
              }).then(function (r) { return r.json(); }).then(function (res) {
                var statusEl = container.querySelector('#tavern-wb-status');
                if (statusEl) statusEl.textContent = res.ok ? ('✅ 已导入世界书：' + name + '（' + entries.length + ' 条）') : ('❌ 保存失败');
              }).catch(function () {});
            }
          }
        });
      }
      function handlePresetFile(file) {
        if (!file) return Promise.resolve();
        return file.text().then(async function (text) {
          var data = parseJsonText(text);
          var prompts = Array.isArray(data.prompts) ? data.prompts : (data.data && data.data.prompts) || [];
          // ★ DSH 兼容：导入时立即清洗模块内容（剥 {{}} 变量 / <thinking> / HTML注释 / Prism 等
          //   会导致 deepseek 原样输出的指令），统计清理数量并提示用户。
          var cleanedTotal = 0;
          var modules = prompts.map(function (p) {
            var before = String(p.content || '');
            var after = sanitizeForHarness(before, '');
            if (after !== before) cleanedTotal++;
            return { name: p.name || p.identifier || '', content: after, enabled: p.enabled !== false };
          });
          var pname = (data && (data.name || data.title)) || file.name.replace(/\.[^.]+$/, '');
          // 自动检测同名预设，避免重复导入
            var dupPresetIdx = state.presets.findIndex(function (p) { return p && (p.name || '').trim().toLowerCase() === pname.trim().toLowerCase(); });
            if (dupPresetIdx >= 0) {
              if (!await showConfirm('检测到同名预设「' + pname + '」，是否替换为新的？')) return;
              state.presets.splice(dupPresetIdx, 1);
            }
            state.presets.push({ name: pname, modules: modules });
          state.activePresetIdx = state.presets.length - 1;
          renderPresets(); refreshYml();
          // 提示：清理了多少模块（透明告知，让用户知道已自动适配 DSH）
          if (cleanedTotal > 0) {
            var st = container.querySelector('#tavern-status');
            if (st) st.innerHTML = '✅ 已导入预设「' + esc(pname) + '」，自动清理了 <b>' + cleanedTotal + '</b> 个不兼容 DSH 的模块内容（<thinking>/HTML注释/{{变量}}等已剥离）';
          }
          // 自动保存
          saveCurrent().catch(function () {});
        });
      }

      /**
       * DSH「主视图会话」id —— **唯一权威来源**（含刚新建、还没发消息的空白会话）。
       *
       * ★ 2026-09-27 更正（原实现读的是一个不存在的字段）：
       *   · DSH 的会话列表快照**没有 `current` 字段**（session-controller 的 list store
       *     初始化就是 {ids, byId, phase, projectionsBySession}），旧代码 `snap.current`
       *     永远 undefined ⇒「最优先」的主路径形同不存在，一路退化到 URL / 面包屑 / DOM 文本；
       *   · 而 DSH 的 UI **从不用 URL 表达会话**（ui-workspace 里没有任何 location/history
       *     用法；切换会话只改内存 + localStorage）⇒ 那三条兜底在空白新会话上全都取不到 id，
       *     面板于是提示「先发一条消息」—— 那正是「必须发一条消息才能绑定」的根因。
       *   · 真正的标记是列表行上的 `retainedBy.mainView > 0`：DSH 自己（mainSessionId()、
       *     uiSession 的 current、agent-preset 的 mainBlankSeat）用的都是它，
       *     空白新会话同样生效（create 之后立刻 retain 成主视图）。
       *   · DSH 切换会话时会 release 旧引用（clearMain → previous.release），稳态下至多一行命中。
       *
       * @param {object} [svcArg] 会话服务；不传则用挂载的 window.__DSH_TAVERN_SESSIONS__
       * @returns {string} `session-<uuid>` 形态的 id；取不到返回空串
       */
      function dshMainViewSessionId(svcArg) {
        try {
          var svc = svcArg || window.__DSH_TAVERN_SESSIONS__;
          if (!svc || !svc.list || typeof svc.list.getSnapshot !== 'function') return '';
          var snap = svc.list.getSnapshot() || {};
          var rows = snap.byId || {};
          var keys = Object.keys(rows);
          for (var i = 0; i < keys.length; i++) {
            var row = rows[keys[i]];
            if (!row) continue;
            var rb = row.retainedBy || {};
            if (!((rb.mainView || 0) > 0)) continue;
            var id = String(row.id || keys[i] || '');
            if (!id) continue;
            return /^[a-f0-9-]{20,}$/i.test(id) ? 'session-' + id.replace(/^session-/, '') : id;
          }
          // 兼容：万一将来 DSH 在快照上补了 current 字段
          var legacy = snap.current ? String(snap.current) : '';
          if (legacy && /^[a-f0-9-]{20,}$/i.test(legacy)) return 'session-' + legacy.replace(/^session-/, '');
        } catch (e) {}
        return '';
      }

      function getCurrentSessionId() {
        try {
          // ★★★ 最优先：DSH 官方会话服务（ctx.sessions，由 apply 挂载到 window.__DSH_TAVERN_SESSIONS__），
          //   按「主视图引用」（retainedBy.mainView）取当前激活会话 —— 与 URL/DOM 无关，
          //   切换会话时 DSH 立即更新，**空白新会话也有 id**。详见 dshMainViewSessionId。
          try {
            var svc = window.__DSH_TAVERN_SESSIONS__;
            // ★ 惰性重解析（串台的根因之一）：`sessions` 是**异步 provide** 的服务，apply() 跑的
            //   那一刻可能还拿不到；旧代码把那个 undefined **永久缓存**了，之后检测一路退化到
            //   URL → 面包屑 → `data-dsh-current-session` 属性 —— 而该属性在切换会话后仍是
            //   **旧值**（见下面第 1 步的注释），于是整轮都用**上一个会话的 id** 查
            //   session-bindings.json，渲染出上一张卡的界面（串台）。
            //   这里每次调用都重试一次解析，拿到就补回缓存；拿不到才继续走后面的兜底。
            if (!svc || !svc.list || typeof svc.list.getSnapshot !== 'function') {
              try {
                var _c = window.__DSH_TAVERN_CTX__;
                if (_c && typeof _c.get === 'function') {
                  var _fresh = _c.get('sessions');
                  if (_fresh) { window.__DSH_TAVERN_SESSIONS__ = _fresh; svc = _fresh; }
                }
              } catch (_e) {}
            }
            var sidSvc = dshMainViewSessionId(svc);
            if (sidSvc) {
              document.documentElement.setAttribute('data-dsh-current-session', sidSvc);
              return sidSvc;
            }
          } catch (e) {}
          // 优先级：URL（最新信号）→ DOM 当前活动会话 → 缓存属性（兜底）→ 文本兜底
          // 修复：切换会话后 data-dsh-current-session 属性是旧值，若优先读属性会一直返回旧会话，
          //       导致会话轮询 (sessionPoll) 永远检测不到切换，关系网/记忆不刷新。
          // 1. 从 URL 获取（URL 变化 = 切换会话的强信号）
          var urlMatch = location.href.match(/session[\/=:-]([a-f0-9-]{20,})/i);
          if (urlMatch && urlMatch[1]) {
            var sidUrl = 'session-' + urlMatch[1].replace(/^session-/, '');
            document.documentElement.setAttribute('data-dsh-current-session', sidUrl);
            return sidUrl;
          }

          // 2. DSH 头部/面包屑区域文本探测（兜底）。
          //    注：DSH 普通会话的面包屑显示的是会话标题而非 ID（源码 deriveAncestry 渲染
          //    displayTitle），只有 ancestry 为空时才渲染 sessionId 文本；所以这里主要靠
          //    DSH 会话服务（第 1 步）拿当前会话，此探测仅作额外兜底。
          var crumbNow = document.querySelector('[class*="crumbCurrent"], [class*="crumb-current"], [class*="crumb"][class*="current"]');
          if (crumbNow) {
            var crumbText = (crumbNow.textContent || '').trim();
            var crumbMatch = crumbText.match(/(?:session-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (crumbMatch) {
              var sidCrumb = 'session-' + crumbMatch[1].replace(/^session-/, '');
              document.documentElement.setAttribute('data-dsh-current-session', sidCrumb);
              return sidCrumb;
            }
          }
          // 2b. 面包屑区域任意 crumb 内的会话 id（ancestry>0 时当前会话显示为最后一个 crumb）
          var crumbAny = document.querySelector('[class*="crumb"]');
          if (crumbAny) {
            var crumbAnyText = (crumbAny.textContent || '').trim();
            var crumbAnyMatch = crumbAnyText.match(/(?:session-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (crumbAnyMatch) {
              var sidCrumbAny = 'session-' + crumbAnyMatch[1].replace(/^session-/, '');
              document.documentElement.setAttribute('data-dsh-current-session', sidCrumbAny);
              return sidCrumbAny;
            }
          }

          // 3. 从 DOM 元素的 data-id 获取（找当前活动的会话，切换会话后 active 类会更新）
          var els = document.querySelectorAll('[data-id]');
          var candidates = [];
          for (var k = 0; k < els.length; k++) {
            var el = els[k];
            var did = el.getAttribute('data-id') || '';
            if (/^session-[a-f0-9-]{20,}/i.test(did) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(did)) {
              // 检查是否可见且活动
              var rect = el.getBoundingClientRect();
              var isVisible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight;
              var isActive = el.classList && (el.classList.contains('active') || el.classList.contains('selected') || el.classList.contains('current'));
              candidates.push({ el: el, id: did, visible: isVisible, active: isActive });
            }
          }
          // 优先选活动的，其次选可见的
          candidates.sort(function(a, b) {
            var scoreA = (a.active ? 100 : 0) + (a.visible ? 50 : 0);
            var scoreB = (b.active ? 100 : 0) + (b.visible ? 50 : 0);
            return scoreB - scoreA;
          });
          if (candidates.length > 0) {
            var sidDom = 'session-' + candidates[0].id.replace(/^session-/, '');
            document.documentElement.setAttribute('data-dsh-current-session', sidDom);
            return sidDom;
          }

          // 4. 缓存属性兜底（仅在上面两路都取不到时使用）
          var attr = document.documentElement.getAttribute('data-dsh-current-session');
          if (attr && (/^session-[a-f0-9-]{20,}/i.test(attr) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attr))) {
            return 'session-' + attr.replace(/^session-/, '');
          }

          // 5. 从所有文本中匹配 session-id 格式（优先找最后一个 crumb/header 附近的，最后兜底任意文本）
          var bodyText = document.body ? document.body.innerText : '';
          // 5a. header/session 区域文本优先
          var headerEl = document.querySelector('header, [class*="header"], [class*="sessionHeader"], [class*="session-header"]');
          if (headerEl) {
            var headerText = headerEl.innerText || '';
            var headerMatch = headerText.match(/(?:session-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (headerMatch) {
              var sidHeader = 'session-' + headerMatch[1].replace(/^session-/, '');
              document.documentElement.setAttribute('data-dsh-current-session', sidHeader);
              return sidHeader;
            }
          }
          // 5b. 兜底：全文本匹配（优先 session- 前缀）
          var textMatch = bodyText.match(/session-[a-f0-9-]{20,}/i) || bodyText.match(/(?:^|\s)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\s|$)/i);
          if (textMatch) {
            var sidText = 'session-' + (textMatch[1] || textMatch[0]).replace(/^session-/, '');
            document.documentElement.setAttribute('data-dsh-current-session', sidText);
            return sidText;
          }
        } catch (e) {}
        return '';
      }
async function resolveCurrentSessionId() {
          // ★ 优先 DSH 官方会话服务（UI 当前激活会话，权威）
          try {
            var svc = window.__DSH_TAVERN_SESSIONS__;
            var s0 = dshMainViewSessionId(svc);
            if (s0) {
              document.documentElement.setAttribute('data-dsh-current-session', s0);
              return s0;
            }
          } catch (e) {}
          var sid = getCurrentSessionId();
          if (sid) return sid;
          // 本地 DOM 探测失败 → 从后端拿会话（仅最后兜底：后端 lastSessionId 是"最后运行 agent 的会话"）
          try {
            var r = await fetch('/api/tavern/current-session');
            var d = await r.json();
            if (d && d.ok && d.sessionId) {
              var s = 'session-' + String(d.sessionId).replace(/^session-/, '');
              document.documentElement.setAttribute('data-dsh-current-session', s);
              return s;
            }
          } catch (e) {}
          // 最后再从 DOM/活动会话项里找
          try {
            var selectors = [
              '[data-session-id]', '[data-id][class*="active"]', '[class*="session"][class*="active"]',
              '[class*="conversation"][class*="active"]', '[class*="chat"][class*="active"]',
              '[class*="item"][class*="active"][data-id]', '[class*="sidebar"] [class*="selected"]'
            ];
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el) {
                var id = el.getAttribute('data-session-id') || el.getAttribute('data-id') || el.dataset.sessionId || el.dataset.id || '';
                if (id && id.length > 10) return 'session-' + id.replace(/^session-/, '');
              }
            }
          } catch (e) {}
          return '';
        }

      function getSessionTitleFromDOM() {
        try {
          var selectors = [
            '.session-item.active [class*="title"]', '.session-item.active [class*="name"]',
            '[class*="conversation-item"][class*="active"] [class*="title"]',
            '[class*="chat-item"][class*="active"] [class*="title"]',
            '[class*="sidebar"] [class*="item"][class*="active"] [class*="title"]',
            '[class*="sidebar"] [class*="item"][class*="active"] [class*="name"]'
          ];
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim()) {
              return el.textContent.trim().slice(0, 20);
            }
          }
          var pageTitle = document.title || '';
          if (pageTitle && pageTitle !== 'DeepSeek Harness') {
            return pageTitle.slice(0, 20);
          }
        } catch {}
        return '';
      }

      /**
       * 把已保存的「自定义设定」与「故事背景」从 agent.cordis.yml 读回界面。
       *
       * 这两段正文会被 buildAgentYml 写进 persona 前缀（`# 自定义设定` / `# 故事背景`），
       * 但此前**没有任何回填路径**：面板重新挂载后内存里是空字符串、输入框也是空的，
       * 用户此时只要再点一次「保存并注入」（哪怕只是为了改别的设置），
       * 新生成的 yml 就会用空值把已存内容覆盖掉 —— 静默的数据丢失。
       * 与 issue #2 属于同一类「内存状态与服务端不一致」的 bug。
       *
       * @param {string} yml 服务端返回的 agent.cordis.yml 全文
       */
      function restorePromptSections(yml) {
        if (!yml) return;
        // 取 persona 的 prefix 块：与 lib/utils.js 的 extractCardText 同口径，按「键名缩进」判断块结束
        var lines = String(yml).split(/\r?\n/);
        var start = -1, indent = 0;
        for (var i = 0; i < lines.length; i++) {
          var m = lines[i].match(/^(\s*)(?:text|prefix):\s*\|-/);
          if (m) { start = i + 1; indent = m[1].length; break; }
        }
        if (start < 0) return;
        var out = [];
        for (var j = start; j < lines.length; j++) {
          var line = lines[j];
          if (line.trim() === '') { out.push(''); continue; }
          var im = line.match(/^(\s*)\S/);
          if (im && im[1].length <= indent) break;
          var dm = line.match(/^( {2,})/);
          out.push(dm ? line.slice(dm[1].length) : line);
        }
        var body = out.join('\n');
        // 按 "# 标题" 切段，取目标段落（直到下一个 "# " 开头的行为止）
        var section = function (title) {
          var re = new RegExp('^# ' + title + '\\s*$', 'm');
          var mm = re.exec(body);
          if (!mm) return '';
          var rest = body.slice(mm.index + mm[0].length);
          var next = rest.search(/^# /m);
          return (next >= 0 ? rest.slice(0, next) : rest).replace(/^\n+/, '').replace(/\s+$/, '');
        };
        var extra = section('自定义设定');
        var bg = section('故事背景');
        state.extraPrompt = extra;
        state.storyBackground = bg;
        var ea = container.querySelector('#tavern-extra');
        if (ea) ea.value = extra;
        var sb = container.querySelector('#tavern-story-bg');
        if (sb) sb.value = bg;
      }

      function loadCurrent() {
        var st = container.querySelector('#tavern-status');
        if (st) { st.textContent = '⏳ 正在读取当前会话预设...'; st.style.color = 'var(--tv-color-warn)'; }
        var pid = arguments[0] || getActivePresetId();
        if (!pid) {
          if (st) { st.textContent = '❌ 还没选择要编辑的 Agent 预设，请先在顶部选择一个预设'; st.style.color = 'var(--tv-color-danger)'; }
          return Promise.resolve();
        }
        return fetch('/api/tavern/read?presetId=' + encodeURIComponent(pid)).then(function (r) { return r.json(); }).then(function (data) {
          serverAgentYml = data.agentYml || '';
          // ★ 把已存的「自定义设定」「故事背景」读回内存与输入框。
          //   不做这一步，重开面板后再保存就会用空值覆盖已存内容（静默数据丢失）。
          restorePromptSections(serverAgentYml);
          // 加载角色卡和世界书元数据
          if (Array.isArray(data.characters)) {
            state.characters = data.characters;
          } else {
            state.characters = [];
          }
          if (Array.isArray(data.worldbooks)) {
            state.worldbooks = data.worldbooks;
          } else {
            state.worldbooks = [];
          }
          if (Array.isArray(data.presets)) {
            state.presets = data.presets;
          } else {
            state.presets = [];
          }
          // 预设模块默认折叠（三人逆行这种预设词条太多，展开会占满屏幕）
          // 强制折叠：不信任数据里残留的 _collapsed:false（旧版本会把前端状态存进文件）
          state.presets.forEach(function (p) {
            p._collapsed = true;
          });
          // 恢复 activePresetIdx（之前没有保存，导致每次刷新后预设不注入）
          if (typeof data.activePresetIdx === 'number') {
            state.activePresetIdx = data.activePresetIdx;
          } else {
            state.activePresetIdx = -1;
          }
          renderCharacters();
          
          renderPresets();
          refreshYml();
          // 更新预设状态，显示加载详情
          var charCount = state.characters.length;
          var wbCount = state.worldbooks.length;
          var wbEntries = state.worldbooks.reduce(function (sum, wb) { return sum + (wb.entries ? wb.entries.length : 0); }, 0);
          if (presetStatus) {
            var sidDisplay = getCurrentSessionId();
            sidDisplay = sidDisplay ? sidDisplay.slice(0, 20) + (sidDisplay.length > 20 ? '…' : '') : '未检测到';
            // 计算启用的世界书条目数量和启用的预设条目数量
            var wbEnabledEntries = state.worldbooks.reduce(function(sum, wb) { return sum + ((wb.entries || []).filter(function(e) { return e.enabled !== false; }).length); }, 0);
            var presetCount = state.presets.length;
            var presetEnabledEntries = state.presets.reduce(function(sum, p) { return sum + ((p.modules || []).filter(function(m) { return m.enabled !== false; }).length); }, 0);
            // ★ 2.7.6（issue #14 同类）：预设名由用户/服务端填写，进 innerHTML 前必须转义。
            //   顺带把「修正绿字」从「写进 innerHTML 再按字符串反查」改成「先定好文本、再写一次」——
            //   原来那招在预设名含引号时会静默失配（esc 写进去、读回来已被解码成原字符）。
            var presetLabelEl2 = document.getElementById('tavern-session-preset-label');
            var presetLabelText = String(data.presetName || '默认预设');
            if (presetLabelEl2 && presetLabelEl2.textContent) presetLabelText = presetLabelEl2.textContent;
            presetStatus.innerHTML = '✅ 当前预设：' + esc(presetLabelText) + '<br><span style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999)">🎭 角色卡：' + charCount + ' 个 | 📚 世界书：' + wbCount + ' 本（' + wbEntries + ' 条，启用 ' + wbEnabledEntries + ' 条）| ⚙️ 预设：' + presetCount + ' 个（启用 ' + presetEnabledEntries + ' 条）</span>';
            presetStatus.style.color = '#27ae60';

          }
          var st = container.querySelector('#tavern-status');
          if (st) st.textContent = '已读取当前预设：' + (data.dir || '');
          // （已清理）旧版「生效范围」回填代码：它写的 #tavern-ignore / #tavern-allow /
          //   #tavern-mode-* / #tavern-inject* / #tavern-scope-status 等元素早已不存在，
          //   现在「生效范围」是 chips 版（initScopePanel）。
          // ⚠ 下面这条 state 请求**必须保留**：它回填 activePresetIdx（面板重开不落回第 0 组）。
          return fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (sdata) {
            // ★ 回填持久化的 activePresetIdx（面板重开不再落回第 0 组）：越界回退 0
            if (sdata && sdata.ok && typeof sdata.activePresetIdx === 'number' && sdata.activePresetIdx >= 0) {
              state.activePresetIdx = sdata.activePresetIdx < state.presets.length ? sdata.activePresetIdx : 0;
              renderPresets();
              refreshYml();
            }
          }).catch(function () {});
        }).catch(function (err) {
          var st = container.querySelector('#tavern-status');
          if (st) { st.textContent = '❌ 读取失败：' + (err && err.message ? err.message : '网络错误'); st.style.color = 'var(--tv-color-danger)'; }
        });
      }

      // ★ 收集当前预设的数据（世界书统一用最新状态），供全量保存/数据保存复用
      async function collectSaveState() {
        try {
          var wbSource = state.worldbooks;
          if (typeof wbGroups !== 'undefined' && wbGroups && wbGroups.length) {
            wbSource = wbGroups;
          } else {
            try {
              var freshWb = await fetch('/api/tavern/worldbook?presetId=' + encodeURIComponent(getActivePresetId() || '')).then(function (r) { return r.json(); });
              if (freshWb.ok && Array.isArray(freshWb.groups) && freshWb.groups.length) {
                wbSource = freshWb.groups;
              }
            } catch (e2) {}
          }
          if (Array.isArray(wbSource)) {
            state.worldbooks = wbSource.map(function (g) {
              return {
                name: g.name || '世界书',
                enabled: g.enabled !== false,
                entries: (g.entries || []).map(function (e) {
                  return {
                    name: e.name || e.comment || '',
                    comment: e.comment || '',
                    keys: e.keys || e.keywords || [],
                    keywords: e.keywords || e.keys || [],
                    content: e.content || e.text || '',
                    text: e.text || e.content || '',
                    enabled: e.enabled !== false
                  };
                })
              };
            });
          }
        } catch (e) {}
        var presetLabelElForSave = document.getElementById('tavern-session-preset-label');
        var curPresetId = (presetLabelElForSave && presetLabelElForSave.dataset && presetLabelElForSave.dataset.presetId) || getActivePresetId() || '';
        return {
          presetId: curPresetId,
          characters: state.characters,
          worldbooks: state.worldbooks,
          presets: state.presets,
          activePresetIdx: state.activePresetIdx
        };
      }

      // ★ 仅保存数据（角色卡/世界书/预设开关），不重新生成 agent.cordis.yml。
      //   自动保存（开关变化）调用它：数据随时落盘，但 agent 预设的更新必须等用户手动点「保存预设」。
      async function saveDataOnly() {
        try {
          var st = container.querySelector('#tavern-status');
          var data = await collectSaveState();
          if (data.presetId === 'default') {
            if (!await showConfirm('⚠️ 你正在修改「默认预设」！\n\n所有未启用白名单的会话都会使用这个预设。\n修改会影响所有未启用的会话，确定继续吗？')) return Promise.reject(new Error('用户取消'));
          }
          return fetch('/api/tavern/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            presetId: data.presetId,
            characters: data.characters,
            worldbooks: data.worldbooks,
            presets: data.presets,
            activePresetIdx: data.activePresetIdx,
            dataOnly: true // 后端据此跳过 agent.cordis.yml 生成
          }) }).then(function (r) { return r.json(); }).then(function (d) {
            if (d.ok && st) { st.textContent = '🔄 已自动保存数据（世界书/角色卡/预设开关）——agent 预设未改动，需手动点「💾 保存预设」才生成'; }
            return d;
          });
        } catch (e) { console.error('[tavern] saveDataOnly error:', e); throw e; }
      }

      async function saveCurrent() {
        try {
        var ta = container.querySelector('#tavern-agent-yml');
        // 保证 worldbooks 用最新状态，绝不用陈旧的内存缓存覆盖磁盘：
        // 1) 优先用 wbGroups（用户在世界书 UI 上的修改）；
        // 2) 若 wbGroups 为空（未加载过世界书页签/状态被重置），实时拉取服务端当前数据，避免把用户已保存的开关覆盖回去。
        var wbSource = state.worldbooks;
        if (typeof wbGroups !== 'undefined' && wbGroups && wbGroups.length) {
          wbSource = wbGroups;
        } else {
          try {
            var freshWb = await fetch('/api/tavern/worldbook?presetId=' + encodeURIComponent(getActivePresetId() || '')).then(function (r) { return r.json(); });
            if (freshWb.ok && Array.isArray(freshWb.groups) && freshWb.groups.length) {
              wbSource = freshWb.groups;
            }
          } catch (e2) {}
        }
        if (Array.isArray(wbSource)) {
          state.worldbooks = wbSource.map(function (g) {
            return {
              name: g.name || '世界书',
              enabled: g.enabled !== false,
              entries: (g.entries || []).map(function (e) {
                return {
                  name: e.name || e.comment || '',
                  comment: e.comment || '',
                  keys: e.keys || e.keywords || [],
                  keywords: e.keywords || e.keys || [],
                  content: e.content || e.text || '',
                  text: e.text || e.content || '',
                  enabled: e.enabled !== false
                };
              })
            };
          });
        }
        // 强制用当前状态重新构建，确保角色卡/世界书/预设的修改都生效
        var built = buildAgentYml(state);
        var agentYml = built.agentYml;
        // 同步更新 textarea 显示
        if (ta) ta.value = agentYml;
        var presetYml = built.presetYml || 'name: 精简酒馆\ndescription: 由 Harness 酒馆管理面板生成。\n';
          // 用当前面板实际选中的预设名写 preset.yml，避免保存到哪个预设都被改名成“精简酒馆”
          var selectedPresetNameForSave = (document.getElementById('tavern-session-preset-label') || {}).textContent || '';
          if (selectedPresetNameForSave) {
            presetYml = 'name: ' + JSON.stringify(selectedPresetNameForSave) + '\ndescription: 由 Harness 酒馆管理面板生成。\n';
          }

        // sid 已在函数开头获取
        var presetLabelElForSave = document.getElementById('tavern-session-preset-label');
        var curPresetId = (presetLabelElForSave && presetLabelElForSave.dataset && presetLabelElForSave.dataset.presetId) || getActivePresetId() || '';
        // 如果修改的是默认预设，弹出提示（用 DOM 弹窗，避免原生 confirm 导致焦点丢失）
        if (curPresetId === 'default') {
          if (!await showConfirm('⚠️ 你正在修改「默认预设」！\n\n所有未启用白名单的会话都会使用这个预设。\n修改会影响所有未启用的会话，确定继续吗？')) {
            return Promise.reject(new Error('用户取消修改默认预设'));
          }
        }
        return fetch('/api/tavern/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentYml: agentYml, presetYml: presetYml, presetId: curPresetId, characters: state.characters, worldbooks: state.worldbooks, presets: state.presets, activePresetIdx: state.activePresetIdx }) }).then(function (r) { return r.json(); }).then(function (data) {
          var st = container.querySelector('#tavern-status');
          if (data.ok) {
            // ★ 单一事实来源：保存后立即同步权威预设 id → localStorage，并通知各处刷新
            var savedPid = data.presetId || curPresetId;
            if (savedPid) setActivePresetId(savedPid);
            try {
              var lbl = document.getElementById('tavern-session-preset-label');
              if (lbl) { lbl.dataset.presetId = savedPid || lbl.dataset.presetId || ''; }
              var b2 = document.getElementById('tavern-session-preset-btn');
              if (b2) { b2.dataset.presetId = savedPid || b2.dataset.presetId || ''; }
            } catch (e) {}
            try { document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: savedPid, presetName: agentPresetName } })); } catch (e) {}
            // 重新拉取列表，刷新浮动面板描述（服务端已从磁盘重建真实描述）
            try {
              var fs2 = document.getElementById('tavern-session-preset-panel');
              // Pass the preset we just saved: without it the refresh re-derives
              // the active preset from the session binding, which snapped the
              // panel (and every later save) back to the previously bound preset.
              if (fs2 && typeof loadSessionPresets === 'function') loadSessionPresets(savedPid);
            } catch (e) {}
            // 统计保存的内容
            var charCount = (state.characters || []).length;
            var wbCount = (state.worldbooks || []).length;
            var wbEntryCount = (state.worldbooks || []).reduce(function (sum, w) { return sum + (w.entries ? w.entries.length : 0); }, 0);
            var activeP = null;
            if (state.presets && state.presets.length) {
              var idx = state.activePresetIdx >= 0 && state.activePresetIdx < state.presets.length ? state.activePresetIdx : 0;
              activeP = state.presets[idx];
            }
            var modCount = activeP ? (activeP.modules || []).filter(function (m) { return m.enabled; }).length : 0;
            var presetName = activeP ? activeP.name : '无';
            var ymlSize = Math.round(agentYml.length / 1024);
            // 获取 Agent 预设名称（用于提示用户选择）
            var agentPresetName = '酒馆预设';
            try {
              var opt = document.getElementById('tavern-session-preset-label') || {};
              if (opt && opt.textContent) agentPresetName = opt.textContent.replace(/（当前）$/, '').trim();
            } catch (e) {}
            st.innerHTML = '✅ <b>保存成功！Agent 预设已生成</b><br>' +
              '<span style="font-size:12px;color:var(--dsw-alias-label-tertiary,#999)">' +
              '角色卡：' + charCount + ' 个 | 世界书：' + wbCount + ' 本（' + wbEntryCount + ' 条）| ' +
              '预设：' + esc(presetName) + '（' + modCount + ' 个模块）| ' +
              '配置大小：' + ymlSize + ' KB' +
              '</span><br>' +
              '<span style="font-size:11px;color:var(--dsw-alias-label-tertiary,#666)">👉 新开会话时，在顶部预设选择器选择「' + esc(agentPresetName) + '」即可开始聊天</span>';
            st.style.color = 'var(--tv-color-success)';
            st.style.fontSize = '13px';
            st.style.padding = '8px 12px';
            st.style.background = 'rgba(39,174,96,0.1)';
            st.style.borderRadius = '6px';
            st.style.marginTop = '6px';
          } else {
            st.textContent = '❌ 保存失败：' + (data.error || '未知错误');
            st.style.color = 'var(--tv-color-danger)';
            st.style.fontSize = '13px';
            st.style.padding = '8px 12px';
            st.style.background = 'rgba(231,76,60,0.1)';
            st.style.borderRadius = '6px';
            st.style.marginTop = '6px';
          }
        });
        } catch (e) {
          var st = container.querySelector('#tavern-status');
          if (st) {
            st.textContent = '❌ 保存出错：' + e.message;
            st.style.color = 'var(--tv-color-danger)';
          }
          console.error('[tavern] saveCurrent error:', e);
        }
      }

        // 自动保存：面板开关变化后防抖保存数据（世界书/角色卡/预设开关）。
        // ★ 不再自动生成/更新 agent 预设——agent 预设（agent.cordis.yml）必须手动点「保存预设」才生成。
        var autoSaveTimer = null;
        function autoSaveAfterChange() {
          if (autoSaveTimer) clearTimeout(autoSaveTimer);
          autoSaveTimer = setTimeout(function () {
            autoSaveTimer = null;
            saveDataOnly().catch(function () {});
          }, 600);
        }


      function loadSessionList() {
        var sel = container.querySelector('#tavern-session-select');
        var status = container.querySelector('#tavern-session-status');
        if (status) status.textContent = '正在加载会话列表…';
        fetch('/api/tavern/sessions').then(function (r) { return r.json(); }).then(function (data) {
          if (!data.ok || !data.sessions || !data.sessions.length) {
            sel.innerHTML = '<option value="">暂无历史会话</option>';
            if (status) status.textContent = '';
            return;
          }
          sel.innerHTML = '<option value="">选择一个历史对话…</option>' + data.sessions.map(function (s) {
            var d = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
            var label = s.title ? (s.title.length > 40 ? s.title.slice(0, 40) + '…' : s.title) : ('未命名会话 ' + s.id.slice(0, 8));
            return '<option value="' + esc(s.id) + '">' + esc(label) + '  —  ' + esc(d) + (s.origin === 'subagent' ? ' (子代理)' : '') + '</option>';
          }).join('');
          if (status) status.textContent = '已加载 ' + data.sessions.length + ' 个会话';
        }).catch(function (e) {
          sel.innerHTML = '<option value="">加载失败</option>';
          if (status) status.textContent = '加载会话列表失败：' + e.message;
        });
      }

      // ── 事件绑定 ──
      container.querySelector('#tavern-char-file').addEventListener('change', function (e) { handleCharFile(e.target.files[0]).catch(function (err) { alert('导入角色卡失败：' + err.message); }); });
      container.querySelector('#tavern-wb-file').addEventListener('change', function (e) { handleWbFile(e.target.files[0]).catch(function (err) { alert('导入世界书失败：' + err.message); }); });
      container.querySelector('#tavern-preset-file').addEventListener('change', function (e) { handlePresetFile(e.target.files[0]).catch(function (err) { alert('导入预设失败：' + err.message); }); });

      // 选择文件按钮
      container.querySelector('#tavern-char-choose').addEventListener('click', function () { container.querySelector('#tavern-char-file').click(); });
      container.querySelector('#tavern-wb-choose').addEventListener('click', function (e) { e.stopPropagation(); container.querySelector('#tavern-wb-file').click(); });
      container.querySelector('#tavern-preset-choose').addEventListener('click', function () { container.querySelector('#tavern-preset-file').click(); });

      // 拖放区域通用处理
      var dropZones = container.querySelectorAll('.t-dropzone');
      dropZones.forEach(function (dz) {
        var type = dz.getAttribute('data-type');
        var fileInput = container.querySelector('#tavern-' + type + '-file');
        // 点击拖放区域也可以选择文件
        dz.addEventListener('click', function () { if (fileInput) fileInput.click(); });
        // 拖拽进入（阻止 dsh 全局图片拖放遮罩）
        dz.addEventListener('dragenter', function (e) {
          e.preventDefault();
          e.stopPropagation();
          dz.classList.add('drag-over');
        });
        // 拖拽悬停
        dz.addEventListener('dragover', function (e) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          dz.classList.add('drag-over');
        });
        // 拖拽离开
        dz.addEventListener('dragleave', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (!dz.contains(e.relatedTarget)) {
            dz.classList.remove('drag-over');
          }
        });
        // 放下文件
        dz.addEventListener('drop', function (e) {
          e.preventDefault();
          e.stopPropagation();
          dz.classList.remove('drag-over');
          // 移除 dsh 全局图片拖放遮罩（如果存在）
          var dshOverlay = document.querySelector('[class*="drag-overlay"], [class*="drop-overlay"], [class*="upload-overlay"]');
          if (dshOverlay) dshOverlay.style.display = 'none';
          var files = e.dataTransfer.files;
          if (files && files.length > 0) {
            var file = files[0];
            if (type === 'char') {
              handleCharFile(file).catch(function (err) { alert('导入角色卡失败：' + err.message); });
            } else if (type === 'wb' || type === 'worldbook') {
              handleWbFile(file).catch(function (err) { alert('导入世界书失败：' + err.message); });
            } else if (type === 'preset') {
              handlePresetFile(file).catch(function (err) { alert('导入预设失败：' + err.message); });
            }
          }
        });
      });

      // 在 document 级别阻止 dsh 全局图片拖放遮罩（当拖拽在酒馆面板内时）
      var tavernPanel = container.closest('#tavern-manager') || container;
      ['dragenter', 'dragover', 'drop'].forEach(function (evt) {
        tavernPanel.addEventListener(evt, function (e) {
          if (e.target.closest('.t-dropzone')) return; // 拖放区域自己处理
          e.preventDefault();
          e.stopPropagation();
        }, true); // 捕获阶段，优先于 dsh 的事件处理
      });

      container.querySelector('#tavern-insert-char').addEventListener('click', function () {
        var chs = state.characters.filter(function (c) { return c.enabled; });
        if (!chs.length) { alert('请先导入并启用至少一个角色卡'); return; }
        var text = chs.map(function (c) { return (c.name ? '角色：' + c.name + '\n' : '') + (c.desc ? c.desc : '') + (c.first ? '\n首条：' + c.first : ''); }).join('\n\n---\n\n');
        insertIntoInput(text) ? (container.querySelector('#tavern-status').textContent = '✅ 角色卡已插入当前对话输入框') : alert('没找到输入框');
      });
      container.querySelector('#tavern-insert-wb').addEventListener('click', function () {
        var entries = [];
        state.worldbooks.forEach(function (wb) { if (wb.enabled) (wb.entries || []).forEach(function (e) { if (e.enabled !== false && (e.content || e.text)) entries.push((e.key || e.name || '条目') + '：' + (e.content || e.text)); }); });
        if (!entries.length) { alert('请先导入并启用世界书'); return; }
        insertIntoInput(entries.join('\n\n')) ? (container.querySelector('#tavern-status').textContent = '✅ 世界书已插入当前对话') : alert('没找到输入框');
      });

      // 故事背景
      var sessionLoading = false;
      container.querySelector('#tavern-session-load').addEventListener('click', function () {
        if (sessionLoading) return;
        var sel = container.querySelector('#tavern-session-select');
        var id = sel.value;
        var btn = container.querySelector('#tavern-session-load');
        var status = container.querySelector('#tavern-session-status');
        if (!id) { alert('请先选择一个会话'); return; }
        sessionLoading = true;
        btn.disabled = true;
        btn.textContent = '读取中…';
        status.textContent = '正在读取对话内容（最多 50 条）…';
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 20000);
        fetch('/api/tavern/session-content?id=' + encodeURIComponent(id) + '&limit=50', { signal: ctrl.signal }).then(function (r) { return r.json(); }).then(function (data) {
          clearTimeout(timer);
          if (!data.ok) { status.textContent = '❌ 读取失败：' + (data.error || '未知错误'); return; }
          container.querySelector('#tavern-story-bg').value = data.text || '';
          status.textContent = '✅ 已读取 ' + data.count + ' 条消息（可编辑后点「导入为故事背景」）';
        }).catch(function (e) {
          clearTimeout(timer);
          status.textContent = '❌ 读取失败：' + (e.name === 'AbortError' ? '超时（会话可能太大或损坏）' : e.message);
        }).finally(function () {
          sessionLoading = false;
          btn.disabled = false;
          btn.textContent = '读取对话';
        });
      });
      container.querySelector('#tavern-session-import').addEventListener('click', function () {
        var text = container.querySelector('#tavern-story-bg').value;
        if (!text.trim()) { alert('故事背景为空，请先读取或输入内容'); return; }
        state.storyBackground = text;
        refreshYml();
        container.querySelector('#tavern-session-status').textContent = '✅ 已设为故事背景（' + text.length + ' 字），保存后生效';
      });
      container.querySelector('#tavern-story-clear').addEventListener('click', function () {
        state.storyBackground = '';
        container.querySelector('#tavern-story-bg').value = '';
        refreshYml();
        container.querySelector('#tavern-session-status').textContent = '已清空故事背景';
      });
      container.querySelector('#tavern-story-bg').addEventListener('input', function (e) {
        state.storyBackground = e.target.value;
        refreshYml();
      });

      // 记忆模块
      container.querySelector('#tavern-api-save').addEventListener('click', function () {
        var modeEl = container.querySelector('input[name="tavern-api-mode"]:checked');
        var useDsh = modeEl && modeEl.value === 'dsh';
        var body = {
          apiUrl: container.querySelector('#tavern-api-url').value.trim(),
          apiKey: container.querySelector('#tavern-api-key').value.trim(),
          model: container.querySelector('#tavern-api-model').value.trim() || 'deepseek-chat',
          autoEnabled: container.querySelector('#tavern-auto-enabled').checked,
          autoEvery: Math.max(1, Math.floor(Number(container.querySelector('#tavern-auto-every').value) || 20)),
          useDsh: !!useDsh,
          dshConnection: useDsh ? (container.querySelector('#tavern-dsh-conn').value || '') : '',
          dshModel: useDsh ? (container.querySelector('#tavern-dsh-model').value || '') : '',
            playerName: (document.getElementById('tavern-player-name')?.value || '').trim()
        };
        if (useDsh && !body.dshConnection) {
          container.querySelector('#tavern-api-status').textContent = '❌ 请先选择一个 DSH 连接';
          return;
        }
        fetch('/api/tavern/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (data) {
          container.querySelector('#tavern-api-status').textContent = data.ok ? '✅ 记忆模块设置已保存' : '❌ ' + (data.error || '');
        });
      });
      // 统计并显示当前会话消息数量
//       function updateMsgCount() {
//         var countEl = container.querySelector('#tavern-msg-count');
//         if (!countEl) return;
//         try {
//           // 调用已有的 getCurrentSessionId 函数
//           var sid = getCurrentSessionId();
//           if (sid && sid.length > 5) {
//             countEl.textContent = '当前会话：' + sid.slice(0, 8) + '...（已连接）';
//           } else {
//             countEl.textContent = '当前会话：未检测到';
//           }
//         } catch (e) {
//           countEl.textContent = '当前会话：检测失败';
//         }
//       }
//       updateMsgCount();
//       setInterval(updateMsgCount, 5000);

      container.querySelector('#tavern-summarize-run').addEventListener('click', async function () {
        var rounds = Math.max(1, Math.floor(Number(container.querySelector('#tavern-summarize-rounds').value) || 20));
        // ★ 修复：优先使用会话选择器里选中的会话（用户明确意图），
        //   没选才回退到页面当前会话解析；避免总结跑错会话
        var selBox = container.querySelector('#tavern-session-select');
        var chosen = selBox && selBox.value ? selBox.value : '';
        var sid = chosen || await resolveCurrentSessionId();
        var pid = getActivePresetId() || '';
        if (!sid && pid) {
          // 用预设ID作为兜底，至少能总结和保存记忆
          sid = 'preset-' + pid;
          container.querySelector('#tavern-summary-preview').textContent = '⚠️ 未检测到会话ID，使用预设兜底：' + sid;
        }
        if (!sid) {
          container.querySelector('#tavern-summary-preview').textContent = '❌ 无法获取会话或预设ID';
          return;
        }
        container.querySelector('#tavern-summary-preview').textContent = '正在总结…（' + sid + '）';
        fetch('/api/tavern/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rounds: rounds, sessionId: sid, presetId: pid }) }).then(function (r) {
          var ct = r.headers.get('content-type') || '';
          if (!r.ok || ct.indexOf('json') === -1) {
            return r.text().then(function (txt) {
              throw new Error('HTTP ' + r.status + ' (非JSON响应: ' + ct + ')，响应前200字: ' + (txt || '').slice(0, 200));
            });
          }
          return r.json();
        }).then(function (data) {
          container.querySelector('#tavern-summary-preview').textContent = data.ok ? ('✅ 总结完成：\n' + (data.summary || '')) : ('❌ ' + (data.error || '未知错误'));
          // 总结完成后自动刷新关系网（同时尝试会话级和预设级）
          if (data.ok) {
            var relUrl = '/api/tavern/relations?sessionId=' + encodeURIComponent(sid);
            if (pid) relUrl += '&presetId=' + encodeURIComponent(pid);
            fetch(relUrl).then(function (r2) { return r2.json(); }).then(function (relData) {
              if (relData.ok && relData.relations) {
                container.querySelector('#tavern-relations-data').value = JSON.stringify(relData.relations, null, 2);
                renderRelationsGraph(relData.relations);
                console.log('[酒馆] 关系网已同步，共', Object.keys(relData.relations).length, '个角色');
              } else {
                console.log('[酒馆] 关系网同步失败:', relData);
              }
            }).catch(function (e) { console.log('[酒馆] 关系网同步错误:', e); });
            // 同时刷新记忆内容
            var memUrl = '/api/tavern/memory?sessionId=' + encodeURIComponent(sid);
            if (pid) memUrl += '&presetId=' + encodeURIComponent(pid);
            fetch(memUrl).then(function (r3) { return r3.json(); }).then(function (memData) { if (memData.ok) container.querySelector('#tavern-memory-text').value = memData.memory || ''; }).catch(function () {});
          }
        }).catch(function (e) { container.querySelector('#tavern-summary-preview').textContent = '❌ 请求失败: ' + e.message; });
      });

      // ★ 上下文压缩
      var compactBtn = container.querySelector('#tavern-compact-run');
      if (compactBtn) {
        compactBtn.addEventListener('click', async function () {
          var rounds = Math.max(5, Math.floor(Number(container.querySelector('#tavern-compact-rounds').value) || 20));
          var statusEl = container.querySelector('#tavern-compact-status');
          statusEl.textContent = '⏳ 压缩中...';
          try {
            var sid = getCurrentSessionId();
            var r = await fetch('/api/tavern/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rounds: rounds, sessionId: sid }) });
            var data = await r.json();
            if (data.ok) {
              statusEl.textContent = '✅ 压缩完成！总结已写入记忆，新对话将引用总结而非完整历史';
              var memUrl = '/api/tavern/memory?sessionId=' + encodeURIComponent(sid);
              fetch(memUrl).then(function(r3){return r3.json()}).then(function(d){if(d.ok)container.querySelector('#tavern-memory-text').value=d.memory||''}).catch(function(){});
            } else {
              statusEl.textContent = '❌ ' + (data.error || '压缩失败');
            }
          } catch (e) { statusEl.textContent = '❌ ' + e.message; }
        });
      }

      // ★ 写作辅助
      var bannedWords = [];
      var writingSaveBtn = container.querySelector('#tavern-writing-save');
      if (writingSaveBtn) {
        writingSaveBtn.addEventListener('click', function () {
          // 只提交违禁词。反八股 / 联网的开关已统一到下方开关条且**改动即写**，
          // 这里若再带上本卡片里那份勾选值，就会把别处的改动覆盖回去。
          var body = {
            bannedWords: bannedWords
          };
          fetch('/api/tavern/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (data) {
            // ★ 反馈必须写回**本卡片自己的**状态行：原先写到 #tavern-api-status，
            //   那个元素在「🧠 记忆与总结」卡片里 —— 在「增强」页签点保存，用户看不到任何反馈。
            var st = container.querySelector('#tavern-writing-status');
            if (st) {
              st.textContent = data.ok ? '✅ 违禁词已保存（下一轮生效）' : '❌ ' + (data.error || '保存失败');
              st.style.color = data.ok ? 'var(--tv-color-success)' : 'var(--tv-color-danger)';
            }
          }).catch(function (e) {
            var st2 = container.querySelector('#tavern-writing-status');
            if (st2) { st2.textContent = '❌ ' + ((e && e.message) || '保存失败'); st2.style.color = '#e74c3c'; }
          });
        });
      }
      function renderBannedTags(words) {
        bannedWords = (words || []).slice();
        var tags = document.getElementById('tavern-banned-tags');
        var count = document.getElementById('tavern-banned-count');
        if (count) count.textContent = '(' + bannedWords.length + ' 个)';
        if (!tags) return;
        tags.innerHTML = bannedWords.slice(0, 20).map(function(w) {
          return '<span style="background:rgba(233,69,96,.12);color:#e94560;padding:1px 7px;border-radius:10px;font-size:11px;white-space:nowrap">' + esc(w) + '</span>';
        }).join('') + (bannedWords.length > 20 ? '<span style="color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 4px">+' + (bannedWords.length - 20) + ' 更多</span>' : '');
      }
      var bannedEditBtn = container.querySelector('#tavern-banned-edit');
      if (bannedEditBtn) {
        bannedEditBtn.addEventListener('click', function () {
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';
          overlay.innerHTML = '<div style="background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:20px;width:min(90vw,600px);max-height:80vh;display:flex;flex-direction:column;gap:12px">' +
            '<div style="font-weight:700;font-size:15px">📛 编辑违禁词</div>' +
            '<div style="font-size:11px;color:var(--dsw-alias-label-secondary)">逗号、空格、换行分隔均可</div>' +
            '<textarea id="tavern-banned-popup" style="flex:1;min-height:250px;padding:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;line-height:1.8">' + esc(bannedWords.join(', ')) + '</textarea>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button id="tavern-banned-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;font-family:inherit">取消</button>' +
            '<button id="tavern-banned-save" style="padding:6px 14px;border-radius:6px;border:none;background:var(--dsw-alias-bg-accent);color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">💾 保存</button>' +
            '</div></div>';
          document.body.appendChild(overlay);
          overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove() });
          overlay.querySelector('#tavern-banned-cancel').addEventListener('click', function(){ overlay.remove() });
          overlay.querySelector('#tavern-banned-save').addEventListener('click', function(){
            var raw = overlay.querySelector('#tavern-banned-popup').value;
            bannedWords = raw.split(/[\n,，\s]+/).map(function(s){return s.trim()}).filter(Boolean);
            renderBannedTags(bannedWords);
            overlay.remove();
          });
        });
      }

      // 世界书管理
      var wbEntries = [];
      var wbGroups = [];
      var wbMode = 'full';
      var wbAllExpanded = false;
      var wbGroupExpanded = {};
      // 注入模式的说明文字：用当前世界书的真实条目和字符数算，不写死数字。
      // 口径刻意跟服务端 selectWorldbookEntries 对齐：
      //   · 禁用判定用 enabled / disable
      //   · 正文取 content 或 text
      //   · 含 <% 的 EJS 条目本身永不注入（它只是分阶段人设的选择器）
      //   · 分阶段人设按最低档估算（好感度从 0 起步时服务端就是这么挑的）
      function wbModeHint(mode) {
        var STAGE_RE = /_阶段0*(\d+)_/;
        function body(e) { return String(e.content || e.text || ''); }
        function labelOf(e) { return String(e.comment || e.name || ''); }
        function prefixOf(e) { return labelOf(e).split('_')[0]; }
        var consts = [], stageGroups = {}, ejsPrefix = {};
        wbEntries.forEach(function (e) {
          if (e.disable === true) return;
          var label = labelOf(e);
          if (body(e).indexOf('<%') >= 0) {
            // EJS 模板（分阶段人设的选择器）：自身一字符都不注入
            if (label.indexOf('分阶段') >= 0) ejsPrefix[prefixOf(e)] = true;
            return;
          }
          var m = STAGE_RE.exec(label);
          if (m) {
            var key = prefixOf(e);
            (stageGroups[key] || (stageGroups[key] = [])).push({ n: Number(m[1]), e: e });
            return;
          }
          var k = (e.keys && e.keys.length) ? e.keys : (e.keywords || []);
          if (e.enabled !== false && !k.length) consts.push(e);
        });
        // 被 EJS getwi() 引用的分阶段条目：按最低档估算（好感度从 0 起步时服务端就是这么挑的）
        var stagePicked = [];
        Object.keys(ejsPrefix).forEach(function (key) {
          var arr = (stageGroups[key] || []).slice().sort(function (a, b) { return a.n - b.n; });
          if (arr.length) stagePicked.push(arr[0].e);
        });
        var stageCount = Object.keys(ejsPrefix).length;
        function charsOf(list) {
          return list.reduce(function (s, e) { return s + body(e).length; }, 0);
        }
        var en = wbEntries.filter(function (e) {
          return e.enabled !== false && e.disable !== true && body(e).indexOf('<%') < 0;
        });
        var total = charsOf(en);
        var cChars = charsOf(consts), sChars = charsOf(stagePicked);
        var base = cChars + sChars;
        function fmt(n) { return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n); }
        if (mode === 'keyword') {
          var saved = total ? Math.round((1 - base / total) * 100) : 0;
          return '常驻 ' + consts.length + ' 条（约 ' + fmt(cChars) + ' 字符）'
            + (stageCount ? '＋分阶段人设 ' + stageCount + ' 组，每轮按当前好感度各带 1 档（约 ' + fmt(sChars) + ' 字符）' : '')
            + ' 每轮必带；其余 ' + (en.length - consts.length) + ' 条只在最近 4 条消息里提到关键词时才注入。'
            + '比全量省约 ' + saved + '%。';
        }
        return '所有启用条目（' + en.length + ' 条，约 ' + fmt(total) + ' 字符）每轮都写进提示词。'
          + '角色记得最牢、不会漏，代价是每轮都要带上这些上下文。';
      }
      // ── 回复体检 ──
      // 「插件没注入」和「模型拒绝了」在界面上以前长得一模一样，
      // 用户只能看到「写不出来」，于是每次都跑去查插件。这里把两件事分开说清楚。
      function refreshReplyCheck() {
        var box = container.querySelector('#tavern-reply-check');
        if (!box) return;
        box.innerHTML = '⏳ 正在看最近那条回复…';
        fetch('/api/tavern/reply-check').then(function (r) { return r.json() }).then(function (d) {
          if (!d || !d.ok) { box.innerHTML = '读取失败。'; return }
          if (!d.length) { box.innerHTML = '还没读到回复（换个会话或先聊一轮）。'; return }
          var face = { ok: '✅', suspect: '⚠️', refusal: '🚫' }[d.verdict] || '❔';
          var what = {
            ok: '看着正常，不像被拒。',
            suspect: '这条有点可疑，模型可能在打太极。',
            refusal: '这条基本可以确定是模型拒了 —— 不是插件没注入。',
          }[d.verdict] || '';
          var tip = {
            ok: '要是它突然写不动了，点下面「重新体检」再看一眼。',
            suspect: '先看命中了什么。还想试就换个说法：把你要的东西放进故事里的处境里，别像点单。',
            refusal: '换模型最直接 —— 不同模型对这类内容的容忍度差得很远，插件改不了这个。'
              + '要么就把话说成情节：谁在什么处境下受的伤、后果是什么，比直接点菜好使得多。',
          }[d.verdict] || '';
          var h = '<div style="font-weight:600">' + face + ' ' + what + '</div>';
          h += '<div style="opacity:.75;margin-top:2px">最近这条 ' + d.length + ' 字符';
          if (d.score) h += ' · 可疑分 ' + d.score;
          h += '</div>';
          if (d.hits && d.hits.length) {
            h += '<div style="margin-top:4px">命中的：' + d.hits.map(function (x) { return esc(x) }).join('、') + '</div>';
          }
          if (d.excerpt) {
            h += '<div style="margin-top:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);opacity:.9">…'
              + esc(d.excerpt) + '…</div>';
          }
          h += '<div style="margin-top:6px">' + esc(tip) + '</div>';
          box.innerHTML = h;
        }).catch(function () { box.innerHTML = '读取失败。'; });
      }
      var recheckBtn = container.querySelector('#tavern-reply-recheck');
      if (recheckBtn) recheckBtn.addEventListener('click', refreshReplyCheck);
      refreshReplyCheck();
      // ── 提示词体积 ──
      // 世界书「全量注入」能把系统提示顶到十几万字符，占掉上下文窗口的大头，
      // 尾部段落（破限块等）最先被截断。这里把服务端实测到的体积显示出来并告警。
      var promptSizeFetchedAt = 0;
      function refreshPromptSize(force) {
        var box = container.querySelector('#tavern-prompt-size');
        if (!box) return;
        var now = Date.now();
        if (force !== true && now - promptSizeFetchedAt < 5000) return;
        promptSizeFetchedAt = now;
        fetch('/api/tavern/prompt-stats').then(function (r) { return r.json() }).then(function (d) {
          if (!d || !d.ok) { box.innerHTML = '<span class="t-status">体积读取失败</span>'; return }
          var COLORS = { ok: '#5fd38d', warn: '#ffb454', danger: '#ff6b6b' };
          var WORDS = { ok: '正常', warn: '偏大', danger: '危险' };
          function fmt(n) { n = Number(n) || 0; return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n) }
          function line(label, b) {
            var c = COLORS[b.level] || COLORS.ok;
            return '<span style="color:' + c + '">●</span> ' + label + ' <b>' + fmt(b.chars) + '</b> 字符 ≈ <b>'
              + b.tokens.toLocaleString() + '</b> tokens（占窗口 ' + b.pct + '% · ' + (WORDS[b.level] || '') + '）';
          }
          var h = '<div style="font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px">📏 提示词体积</div>';
          h += '<div>' + line('本轮实测', d.now) + '</div>';
          h += '<div>' + line('全量注入', d.full) + '</div>';
          h += '<div>' + line('关键词触发', d.keyword) + '</div>';
          if (d.mode === 'full' && d.full.level !== 'ok') {
            var saved = d.full.chars ? Math.round((1 - d.keyword.chars / d.full.chars) * 100) : 0;
            h += '<div style="margin-top:6px;padding:6px 8px;border-radius:6px;border:1px solid #7a3b3b;background:#3a1f22;color:#f0c8c8">⚠️ 全量注入占窗口 '
              + d.full.pct + '%，对话历史没地方长，<b>提示词尾部（含破限块）最先被截断</b>。切「关键词触发」可降到约 '
              + fmt(d.keyword.chars) + ' 字符，省 ' + saved + '%。</div>';
          }
          if (d.last && d.last.at) {
            h += '<div style="margin-top:4px;opacity:.7">上次组装 ' + String(d.last.at).replace('T', ' ').slice(0, 19)
              + ' · 卡片 ' + d.last.card + ' / 世界书 ' + d.last.wb + ' / 成人段 ' + (d.last.nsfw || 0) + ' 字符</div>';
          }
          box.innerHTML = h;
        }).catch(function () { box.innerHTML = '<span class="t-status">体积读取失败</span>' });
      }
      function wbUpdateHint() {
        var el = container.querySelector('#tavern-wb-mode-hint');
        if (el) el.textContent = wbModeHint(wbMode);
        refreshPromptSize();
        // 切换按钮上写的是「点一下会切到哪种模式」，所以永远显示当前模式的**反面**
        var btn = container.querySelector('#tavern-wb-mode-toggle');
        if (btn) btn.textContent = wbMode === 'keyword' ? '⇄ 切换为全量注入' : '⇄ 切换为关键词触发';
      }
      function renderWbList() {
        wbUpdateHint();
        var list = container.querySelector('#tavern-wb-list');
        if (!list) return;   // 面板已卸载
        if (!wbEntries.length) { list.innerHTML = '<span class="t-status">暂无世界书条目，点「＋ 新增条目」创建，或导入 SillyTavern 世界书 JSON</span>'; return; }
        var html = '<div style="margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
        html += '<button id="tavern-wb-toggle-all" type="button" class="t-btn-secondary t-btn-sm">' + (wbAllExpanded ? '▼ 全部折叠' : '▶ 全部展开') + '</button>';
        html += '<span style="font-size:11px;color:var(--dsw-alias-label-secondary)">共 ' + wbGroups.length + ' 本世界书，' + wbEntries.length + ' 条条目，' + wbEntries.filter(function(e){return e.enabled!==false}).length + ' 条启用</span>';
        html += '</div>';
        // 按世界书分组渲染（groups 为空时不分组，直接显示所有条目）
        var renderGroups = wbGroups.length ? wbGroups : [{ name: '未分组条目', entries: wbEntries, enabled: true }];
        renderGroups.forEach(function (group, gIdx) {
          var groupExpanded = wbGroupExpanded[gIdx] === true;
          var enabledCount = group.entries.filter(function(e){return e.enabled!==false}).length;
          html += '<div style="border:1px solid var(--dsw-alias-border-default);border-radius:8px;margin-bottom:8px;background:var(--dsw-alias-bg-elevated,#1a1a2e);overflow:hidden">';
          // 世界书分组标题（可折叠）
          html += '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:var(--dsw-alias-bg-base,#16162a)" data-wb-group-toggle="' + gIdx + '">';
          html += '<span style="font-size:14px;color:var(--dsw-alias-brand-primary,#8b5cf6);width:18px;text-align:center">' + (groupExpanded ? '▼' : '▶') + '</span>';
          html += '<span style="flex:1;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)">📚 ' + esc(group.name) + '</span>';
          html += '<span style="font-size:11px;color:var(--dsw-alias-label-secondary)">' + group.entries.length + ' 条，' + enabledCount + ' 启用</span>';
          html += '<button data-wb-group-idx="' + gIdx + '" data-wb-group-action="delete" style="padding:3px 10px;border-radius:4px;border:none;background:#e74c3c;color:#fff;cursor:pointer;font-size:11px;flex-shrink:0;font-weight:500">删除本书</button>';
          html += '</div>';
          // 分组内容（展开后显示）
          if (groupExpanded) {
            html += '<div style="padding:8px 10px;border-top:1px solid var(--dsw-alias-border-default)">';
            group.entries.forEach(function (entry, eIdx) {
              // 找到条目在扁平数组里的索引（现在是同一引用，indexOf 应该能找到）
              var flatIdx = (wbEntries || []).indexOf(entry);
              if (flatIdx < 0) return;
              var expanded = entry._expanded === true;
              var entryName = entry.comment || entry.name || entry.key || '未命名条目';
              var namePreview = entryName.substring(0, 30);
              var entryKeys = entry.keys || entry.keywords || entry.secondary_keys || [];
              var kwPreview = entryKeys.slice(0, 3).join(', ') + (entryKeys.length > 3 ? '...' : '');
              var contentPreview = (entry.content || '').replace(/<[^>]+>/g, '').substring(0, 40);
              html += '<div style="border:1px solid var(--dsw-alias-border-default);border-radius:6px;margin-bottom:6px;background:var(--dsw-alias-bg-base);overflow:hidden">';
              // 条目条码
              html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer" data-wb-toggle="' + flatIdx + '">';
              html += '<span style="font-size:11px;color:var(--dsw-alias-label-secondary);width:14px;text-align:center">' + (expanded ? '▼' : '▶') + '</span>';
              html += '<input type="checkbox" data-wb-idx="' + flatIdx + '" data-wb-field="enabled" ' + (entry.enabled !== false ? 'checked' : '') + '>';
              html += '<span style="flex:1;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(namePreview) + '</span>';
              if (kwPreview) html += '<span style="font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-elevated);padding:1px 5px;border-radius:3px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(kwPreview) + '</span>';
              if (contentPreview) html += '<span style="font-size:10px;color:var(--dsw-alias-label-tertiary);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(contentPreview) + '...</span>';
              html += '<button data-wb-idx="' + flatIdx + '" data-wb-action="delete" style="padding:3px 8px;border-radius:4px;border:none;background:#e74c3c;color:#fff;cursor:pointer;font-size:11px;flex-shrink:0;font-weight:500">删除</button>';
              html += '</div>';
              // 展开内容
              if (expanded) {
                html += '<div style="padding:0 8px 8px;border-top:1px solid var(--dsw-alias-border-default)">';
                html += '<div style="margin-top:8px;margin-bottom:6px"><label style="font-size:11px;color:var(--dsw-alias-label-secondary)">条目名称：</label>';
                html += '<input type="text" data-wb-idx="' + flatIdx + '" data-wb-field="comment" value="' + escAttr(entry.comment || entry.name || '') + '" placeholder="条目名称" style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-default);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);margin-top:3px;font-size:13px"></div>';
                html += '<div style="margin-bottom:6px"><label style="font-size:11px;color:var(--dsw-alias-label-secondary)">关键词 keys（逗号分隔，关键词模式下命中时注入，当前全量注入模式下暂不生效）：</label>';
                html += '<input type="text" data-wb-idx="' + flatIdx + '" data-wb-field="keys" value="' + escAttr((entry.keys || entry.keywords || []).join(', ')) + '" style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-default);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);margin-top:3px;font-size:13px"></div>';
                html += '<label style="font-size:11px;color:var(--dsw-alias-label-secondary)">条目内容：</label>';
                html += '<textarea data-wb-idx="' + flatIdx + '" data-wb-field="content" rows="8" placeholder="条目内容（设定/剧情/人物信息等）" style="width:100%;padding:8px 10px;border-radius:4px;border:1px solid var(--dsw-alias-border-default);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);resize:vertical;margin-top:4px;font-size:13px;line-height:1.5;font-family:Consolas,Monaco,monospace">' + esc(entry.content || '') + '</textarea>';
                html += '</div>';
              }
              html += '</div>';
            });
            html += '</div>';
          }
          html += '</div>';
        });
        list.innerHTML = html;
        // ★ 展开/折叠 + 删除 统一走**事件委托**（以前是每渲染一次绑 N 个 handler，
        //   再叠加 markup 里的内联 stopPropagation 属性）。行为等价：
        //   删除按钮的点击不冒泡到条目行，因此不会顺带触发展开/折叠。
        if (!list.dataset.wbDelegated) {
          list.dataset.wbDelegated = '1';
          list.addEventListener('click', function (ev) {
            var t = ev.target;
            // ① 删除整本世界书：先拦住冒泡，绝不触发分组折叠
            var groupDel = t.closest && t.closest('[data-wb-group-action="delete"]');
            if (groupDel) {
              ev.stopPropagation();
              deleteWbGroup(parseInt(groupDel.dataset.wbGroupIdx));
              return;
            }
            // ② 删除单条条目：同上
            var del = t.closest && t.closest('[data-wb-action="delete"]');
            if (del) {
              ev.stopPropagation();
              var di = parseInt(del.dataset.wbIdx);
              wbEntries.splice(di, 1);
              renderWbList();
              saveWb();
              return;
            }
            // ③ 勾选框 / 输入框：只拦住冒泡，值由下方 data-wb-field 的 change 处理
            if (t.closest && t.closest('[data-wb-field]')) { ev.stopPropagation(); return; }
            // ④ 分组标题行 → 折叠/展开
            var groupRow = t.closest && t.closest('[data-wb-group-toggle]');
            if (groupRow) {
              var gIdx = parseInt(groupRow.dataset.wbGroupToggle);
              wbGroupExpanded[gIdx] = !(wbGroupExpanded[gIdx] === true);
              renderWbList();
              return;
            }
            // ⑤ 条目行 → 折叠/展开
            var row = t.closest && t.closest('[data-wb-toggle]');
            if (row) {
              var idx = parseInt(row.dataset.wbToggle);
              wbEntries[idx]._expanded = !(wbEntries[idx]._expanded === true);
              renderWbList();
            }
          });
        }
        // 全部展开/折叠
        var toggleAll = container.querySelector('#tavern-wb-toggle-all');
        if (toggleAll) toggleAll.addEventListener('click', function () {
          wbAllExpanded = !wbAllExpanded;
          var groups = wbGroups.length ? wbGroups : [{ name: '未分组条目', entries: wbEntries }];
          if (wbAllExpanded) {
            // 展开所有分组和条目
            for (var i = 0; i < groups.length; i++) wbGroupExpanded[i] = true;
            wbEntries.forEach(function (e) { e._expanded = true; });
          } else {
            // 折叠所有分组和条目
            wbGroupExpanded = {};
            wbEntries.forEach(function (e) { e._expanded = false; });
          }
          renderWbList();
        });
        // 绑定字段编辑
        list.querySelectorAll('[data-wb-field]').forEach(function (el) {
          el.addEventListener('change', function () {
            var idx = parseInt(el.dataset.wbIdx);
            var field = el.dataset.wbField;
            if (field === 'enabled') wbEntries[idx].enabled = el.checked;
            else if (field === 'keys' || field === 'keywords') wbEntries[idx].keys = el.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            else if (field === 'comment' || field === 'name') wbEntries[idx].comment = el.value;
            else wbEntries[idx][field] = el.value;
            saveWb();
          });
        });
      }
      // 删除整本世界书（级联删除该分组下的所有条目）—— 由 renderWbList 的委托调用
      async function deleteWbGroup(gIdx) {
        var group = wbGroups[gIdx];
        if (!group) return;
        if (!await showConfirm('确定删除世界书「' + group.name + '」及其 ' + group.entries.length + ' 条条目吗？此操作不可撤销。')) return;
        // 从扁平数组中移除该分组的所有条目
        var entriesToDelete = group.entries;
        wbEntries = wbEntries.filter(function (e) { return (entriesToDelete || []).indexOf(e) < 0; });
        // 移除分组
        wbGroups.splice(gIdx, 1);
        // 重置展开状态
        delete wbGroupExpanded[gIdx];
        renderWbList();
        saveWb();
      }
      function loadWb() {
        var pid = arguments[0] || getActivePresetId();
        // 面板已被 React 卸载（或从未真正挂上）时不再打扰后端
        if (container && container.isConnected === false) return Promise.resolve();
        return fetch('/api/tavern/worldbook?presetId=' + encodeURIComponent(pid)).then(function (r) { return r.json(); }).then(function (data) {
          if (!data || !data.ok) return;
            wbEntries = data.entries || [];
            wbGroups = data.groups || [];
            // 把分组里的条目替换成扁平数组里的对应条目（同一引用），这样 indexOf 才能找到
            wbGroups.forEach(function (group) {
              if (!group || !Array.isArray(group.entries)) return;
              group.entries = group.entries.map(function (entry) {
                var idx = wbEntries.findIndex(function (e) {
                  return e.content === entry.content && e.comment === entry.comment && (e.id === entry.id || e.id === undefined);
                });
                return idx >= 0 ? wbEntries[idx] : entry;
              });
            });
              // 同名分组只在「真的重名」时才合并。
              // 以前是无条件重建每个分组对象为 {name, enabled, entries}，
              // 会把分组上服务端认识的其它字段（如扫描深度）洗掉；现在没重名就原样保留。
              var __nameCount = {};
              wbGroups.forEach(function (g) {
                var k = String((g && g.name) || '').trim().toLowerCase();
                __nameCount[k] = (__nameCount[k] || 0) + 1;
              });
              if (Object.keys(__nameCount).some(function (k) { return __nameCount[k] > 1 })) {
                var seenGroups = {};
                var mergedGroups = [];
                wbGroups.forEach(function (g) {
                  var gkey = String((g && g.name) || '').trim().toLowerCase();
                  if (seenGroups[gkey]) {
                    var existG = seenGroups[gkey];
                    (g.entries || []).forEach(function (e) {
                      // 判重必须带注释：同内容但不同关键词/注释的是两条真条目，不能吃掉
                      if (!existG.entries.some(function (x) { return __sameEntry(x, e) })) existG.entries.push(e);
                    });
                  } else {
                    var gcopy = Object.assign({}, g);
                    gcopy.enabled = g.enabled !== false;
                    gcopy.entries = (g.entries || []).slice();
                    seenGroups[gkey] = gcopy;
                    mergedGroups.push(gcopy);
                  }
                });
                wbGroups = mergedGroups;
              }
              // wbEntries 只是分组条目的扁平视图，判重口径同上
              wbEntries = [];
              wbGroups.forEach(function (g) {
                (g.entries || []).forEach(function (e) {
                  if (!wbEntries.some(function (x) { return __sameEntry(x, e) })) wbEntries.push(e);
                });
              });
            wbMode = data.injectMode || 'full';
            var modeEl = container.querySelector('#tavern-wb-mode');
            if (modeEl) modeEl.value = wbMode;
            renderWbList();
            wbUpdateHint();
        }).catch(function () { /* 网络抖动不打扰用户：下次切换预设/回到窗口会再拉 */ });
      }
      // 条目判重口径：内容 + 注释都要一样才算同一条
      function __sameEntry(a, b) {
        return String(a.content || a.text || '') === String(b.content || b.text || '')
          && String(a.comment || '') === String(b.comment || '');
      }
      // 保存条目/分组。刻意不带 injectMode —— 模式改动单独走 /worldbook/mode 端点，
      // 否则这里会用面板里可能已过期的 wbMode 覆盖，把别处刚改好的模式悄悄改回去。
      function saveWb() {
        var pid = getActivePresetId();
        return fetch('/api/tavern/worldbook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: wbEntries, groups: wbGroups, presetId: pid || undefined }) }).then(function (r) { return r.json(); }).then(function (data) {
          var st = container.querySelector('#tavern-wb-status');
          if (st) st.textContent = data && data.ok ? '✅ 世界书已保存（' + wbGroups.length + ' 本，' + wbEntries.length + ' 条）' : '❌ ' + ((data && data.error) || '保存失败');
          // 保存后回读一次，让界面以磁盘为准（服务端会做归一化，本地视图可能与之漂移）
          if (data && data.ok) { __tavernWbLastRefresh = Date.now(); loadWb(); }
        }).catch(function () {
          var st = container.querySelector('#tavern-wb-status');
          if (st) st.textContent = '❌ 保存失败（网络错误）';
        });
      }
      // 只切换注入模式：走专用端点，条目一个字节都不动
      function saveWbMode(mode) {
        var pid = getActivePresetId();
        return fetch('/api/tavern/worldbook/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ injectMode: mode, presetId: pid || undefined }) }).then(function (r) { return r.json(); }).then(function (data) {
          var st = container.querySelector('#tavern-wb-status');
          if (st) st.textContent = data && data.ok ? '✅ 注入模式已切换为「' + (data.injectMode === 'keyword' ? '关键词触发' : '全文注入') + '」' : '❌ ' + ((data && data.error) || '切换失败');
          if (data && data.ok) __tavernWbLastRefresh = Date.now();
        }).catch(function () {
          var st = container.querySelector('#tavern-wb-status');
          if (st) st.textContent = '❌ 切换失败（网络错误）';
        });
      }
      /**
       * 把注入开关（剧情选项等）同步到服务端实况。
       *
       * 每次调用都重新查一次 DOM 并重新拉一次状态，所以它在面板刚挂载、面板已卸载、
       * 或用户在别处改过开关（另一个标签页、独立设置页、直接改 tavern-state.json）时
       * 都不会出错或显示过期值 —— 这就是「实时更新」的那一半。
       */
      function refreshToggleStates() {
        return fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) return;
          state.plotOptions = d.plotOptions !== false;
          var pt = container.querySelector('#tavern-plot-options');
          if (pt) pt.checked = state.plotOptions;
          var ps = container.querySelector('#tavern-plot-options-status');
          if (ps) {
            ps.textContent = state.plotOptions ? '✅ 已开启' : '关闭';
            ps.style.color = state.plotOptions ? '#27ae60' : '#999';
          }
          // 下方「系统开关」区的三个开关（工具 / 联网 / 反八股）也在这里统一对齐。
          // 它们是这三个状态**唯一**的控件，改动即写；原先只在挂载时同步一次，
          // 别处改过之后回到面板就会显示成过期状态。
          var toggleRows = [
            ['#tavern-tools-toggle', '#tavern-tools-status', 'toolsEnabled',
              function (v) { return v !== false ? '✅ 工具可用' : '❌ 工具已禁用' }],
            ['#tavern-network-toggle', '#tavern-network-status', 'networkEnabled',
              function (v) { return v === true ? '✅ 已启用' : '❌ 未启用' }],
            ['#tavern-anticliche-toggle', '#tavern-anticliche-status', 'antiCliche',
              function (v) { return v !== false ? '✅ 已启用' : '❌ 未启用' }],
          ];
          toggleRows.forEach(function (row) {
            var el = container.querySelector(row[0]);
            if (!el) return;
            var raw = d[row[2]];
            // 与各开关的默认值保持一致：工具/反八股默认开，联网默认关
            el.checked = row[2] === 'networkEnabled' ? raw === true : raw !== false;
            var st = container.querySelector(row[1]);
            if (st) st.textContent = row[3](raw);
          });
        }).catch(function () {});
      }
      loadWb();
      refreshToggleStates();   // 面板挂载时立刻对齐一次（开关在别处被改过也能显示正确）
      // 窗口重新获得焦点 / 标签页切回来时，世界书与两个开关一起重同步
      __tavernWbRefresh = function () { loadWb(); refreshToggleStates(); refreshReplyCheck(); };
      installWbFocusHook();
      container.querySelector('#tavern-wb-mode').addEventListener('change', function () { wbMode = this.value; wbUpdateHint(); saveWbMode(wbMode); });
      // ★ 一键切换：按下就切到「另一种」模式并立即落盘。
      //   走只改模式的端点，条目一个字节都不动；下拉框与按钮文字同步更新。
      (function () {
        var btn = container.querySelector('#tavern-wb-mode-toggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
          var next = wbMode === 'keyword' ? 'full' : 'keyword';
          wbMode = next;
          var modeEl = container.querySelector('#tavern-wb-mode');
          if (modeEl) modeEl.value = next;
          wbUpdateHint();
          saveWbMode(next);
        });
      })();
      container.querySelector('#tavern-wb-add').addEventListener('click', function () {
        wbEntries.push({ id: 'wb_' + Date.now(), name: '新条目', keywords: [], content: '', enabled: true, position: 'before_char' });
        renderWbList(); saveWb();
      });
      // （世界书导出/打开/从MD导入按钮已移除，事件绑定也移除）

      // 记忆

      container.querySelector('#tavern-memory-save').addEventListener('click', function () {
        var sid = getCurrentSessionId() || '';
        fetch('/api/tavern/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory: container.querySelector('#tavern-memory-text').value, sessionId: sid || undefined }) }).then(function (r) { return r.json(); }).then(function (data) { container.querySelector('#tavern-status').textContent = data.ok ? '✅ 记忆已保存（会话级）' : '❌ ' + data.error; });
      });
      container.querySelector('#tavern-memory-load').addEventListener('click', function () {
        var sid = getCurrentSessionId() || '';
        fetch('/api/tavern/memory?sessionId=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (data) { if (data.ok) container.querySelector('#tavern-memory-text').value = data.memory || ''; });
      });
      container.querySelector('#tavern-memory-clear').addEventListener('click', async function () {
        var confirmed = await showConfirm('确定清除当前对话的所有记忆吗？清除后无法恢复。\n（提示：会同时清空本会话的角色关系网）');
        if (!confirmed) return;
        var sid = getCurrentSessionId() || '';
        container.querySelector('#tavern-memory-text').value = '';
        fetch('/api/tavern/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory: '', sessionId: sid || undefined }) }).then(function (r) { return r.json(); }).then(function (data) {
          container.querySelector('#tavern-status').textContent = data.ok ? '✅ 已清除当前对话记忆' : '❌ ' + data.error;
        });
        // 同时清空本会话的关系网（保持"记忆+关系网"一致，避免清除记忆后关系网还残留旧数据）
        if (sid) {
          fetch('/api/tavern/relations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relations: { nodes: [], edges: [] }, sessionId: sid }) }).then(function (r2) { return r2.json(); }).then(function (d2) {
            if (d2.ok) {
              container.querySelector('#tavern-relations-data').value = '{"nodes":[],"edges":[]}';
              renderRelationsGraph({ nodes: [], edges: [] });
            }
          }).catch(function () {});
        }
      });

      // 关系网
      function renderRelationsGraph(relations) {
        var g = container.querySelector('#tavern-relations-graph');
        if (!g) return;
        g.style.position = 'relative';
        g.style.overflow = 'visible';
        var nodes = relations && relations.nodes ? relations.nodes : [];
        var edges = relations && relations.edges ? relations.edges : [];
        // 节点去重（按 id 和 label 去重，忽略大小写和空格）
        var seenIds = {};
        var uniqueNodes = [];
        nodes.forEach(function (n) {
          var id = String(n.id || '').trim().toLowerCase();
          var label = String(n.label || '').trim().toLowerCase();
          // 检查 id 或 label 是否已经存在
          if ((id && seenIds[id]) || (label && seenIds[label])) return;
          if (id) seenIds[id] = true;
          if (label) seenIds[label] = true;
          uniqueNodes.push(n);
        });
        nodes = uniqueNodes;
        if (!nodes.length && !edges.length) {
          g.innerHTML = '<span class="t-status">暂无关系节点（可在下方编辑 JSON 后保存，或用「手动总结」自动生成）</span>';
          return;
        }
        var W = 580, H = 400;
        var cx = W / 2, cy = H / 2;
        // 自定义 tooltip（悬停显示完整关系）
        var tooltip = document.createElement('div');
        tooltip.style.cssText = 'position:absolute;display:none;background:rgba(15,15,30,0.95);border:1px solid rgba(150,180,255,0.3);border-radius:8px;padding:10px 12px;font-size:12px;color:#e0e8ff;max-width:260px;z-index:9999;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.5);line-height:1.5';
        g.appendChild(tooltip);
        // 详情面板（点击显示）
        var detailPanel = document.createElement('div');
        detailPanel.style.cssText = 'position:absolute;display:none;background:rgba(15,15,30,0.98);border:1px solid rgba(255,180,100,0.4);border-radius:10px;padding:14px;font-size:12px;color:#e0e8ff;max-width:300px;z-index:9998;box-shadow:0 4px 20px rgba(0,0,0,0.6);line-height:1.6';
        g.appendChild(detailPanel);
        // 关闭详情面板
        var closeDetail = function () { detailPanel.style.display = 'none'; };
        // ★ 面板内的「点击空白处关闭」走委托，不再用内联 onclick（内联属性在
        //   严格 CSP 下会被拦，且预算棘轮要求内联事件属性为 0）。
        detailPanel.addEventListener('click', function (ev) {
          var t = ev.target;
          if (t && t.closest && t.closest('[data-detail-close]')) {
            ev.stopPropagation();
            closeDetail();
          }
        });
        // 找中心节点（"你"或第一个节点）
        var centerId = null;
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].id === '你' || nodes[i].label === '你' || nodes[i].id === '我' || nodes[i].label === '我') { centerId = nodes[i].id; break; }
        }
        if (!centerId && nodes.length) centerId = nodes[0].id;
        // 其他节点按连接数排序，连接多的放内圈
        var otherNodes = nodes.filter(function (n) { return n.id !== centerId; });
        var connCount = {};
        edges.forEach(function (e) { connCount[e.source] = (connCount[e.source] || 0) + 1; connCount[e.target] = (connCount[e.target] || 0) + 1; });
        otherNodes.sort(function (a, b) { return (connCount[b.id] || 0) - (connCount[a.id] || 0); });
        // 布局：中心节点在中间，其他分两圈
        var positions = {};
        if (centerId) positions[centerId] = { x: cx, y: cy };
        var innerCount = Math.min(6, otherNodes.length);
        var outerCount = otherNodes.length - innerCount;
        var innerR = 110, outerR = 175;
        otherNodes.forEach(function (n, idx) {
          var isInner = idx < innerCount;
          var r = isInner ? innerR : outerR;
          var groupIdx = isInner ? idx : idx - innerCount;
          var groupLen = isInner ? innerCount : outerCount;
          var angle = (groupIdx / groupLen) * Math.PI * 2 - Math.PI / 2;
          if (!isInner && groupLen > 0) angle += Math.PI / groupLen; // 外圈错开角度
          positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        });
        // SVG 坐标转换
        function svgPoint(svg, evt) {
          var pt = svg.createSVGPoint();
          pt.x = evt.clientX; pt.y = evt.clientY;
          return pt.matrixTransform(svg.getScreenCTM().inverse());
        }
        // 截断标签
        function truncate(s, len) { s = String(s || ''); return s.length > len ? s.slice(0, len) + '…' : s; }
        // 计算文本宽度（保守计算，每个字符16px，确保不溢出）
        function textWidth(s) { return String(s || '').length * 16; }
        // 构建 SVG
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        svg.style.cssText = 'background:rgba(0,0,0,0.25);border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));';
        // 点击空白处关闭详情面板
        svg.addEventListener('click', function () { closeDetail(); });
        // 定义箭头和滤镜
        var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = '<marker id="arrow2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(150,180,255,0.5)"/></marker>' +
          '<filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
        svg.appendChild(defs);
        // 连线层
        var edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(edgeLayer);
        // 标签层（在连线上方）
        var labelLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(labelLayer);
        // 节点层
        var nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(nodeLayer);
        // 存储所有元素用于悬停高亮
        var allEdges = [], allNodes = [], allLabels = [], allLabelTexts = [];
        // 绘制连线
        edges.forEach(function (e) {
          var label = e.label || e.relation || '';
          var s = positions[e.source], t = positions[e.target];
          if (!s || !t) return;
          var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', s.x); line.setAttribute('y1', s.y);
          line.setAttribute('x2', t.x); line.setAttribute('y2', t.y);
          line.setAttribute('stroke', 'rgba(150,180,255,0.25)');
          line.setAttribute('stroke-width', '1.5');
          line.setAttribute('marker-end', 'url(#arrow2)');
          line.dataset.source = e.source; line.dataset.target = e.target; line.dataset.label = label;
          // 悬停显示 tooltip + 高亮
          var showTooltip = function (ev) {
            allEdges.forEach(function (el) {
              if (el === line) {
                el.setAttribute('stroke', 'rgba(255,200,100,0.9)');
                el.setAttribute('stroke-width', '3');
                el.style.filter = 'drop-shadow(0 0 3px rgba(255,200,100,0.6))';
              } else {
                el.setAttribute('stroke', 'rgba(150,180,255,0.1)');
                el.setAttribute('stroke-width', '1');
                el.style.filter = 'none';
              }
            });
            allLabels.forEach(function (el) {
              if (el.dataset.source === e.source && el.dataset.target === e.target) {
                el.style.opacity = '1';
              } else {
                el.style.opacity = '0.3';
              }
            });
            allLabelTexts.forEach(function (el) {
              if (el.dataset.source === e.source && el.dataset.target === e.target) {
                el.setAttribute('fill', '#ffd070');
                el.setAttribute('font-size', '12');
                el.setAttribute('font-weight', '700');
              } else {
                el.setAttribute('fill', '#7080a0');
                el.setAttribute('font-size', '9');
                el.setAttribute('font-weight', '400');
              }
            });
            if (!label) return;
            tooltip.innerHTML = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;margin-bottom:4px">' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div><div>' + esc(label) + '</div>';
            tooltip.style.display = 'block';
            var rect = g.getBoundingClientRect();
            tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
            tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
          };
          var hideTooltip = function () {
            allEdges.forEach(function (el) {
              el.setAttribute('stroke', 'rgba(150,180,255,0.25)');
              el.setAttribute('stroke-width', '1.5');
              el.style.filter = 'none';
            });
            allLabels.forEach(function (el) { el.style.opacity = '1'; });
            allLabelTexts.forEach(function (el) {
              el.setAttribute('fill', '#c8dcff');
              el.setAttribute('font-size', '10');
              el.setAttribute('font-weight', '400');
            });
            tooltip.style.display = 'none';
          };
          line.addEventListener('mouseenter', showTooltip);
          line.addEventListener('mousemove', showTooltip);
          line.addEventListener('mouseleave', hideTooltip);
          // 点击显示详情面板
          line.style.cursor = 'pointer';
          line.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var relatedEdges = edges.filter(function (ed) { return (ed.source === e.source && ed.target === e.target) || (ed.source === e.target && ed.target === e.source); });
            var html = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;font-size:14px;margin-bottom:8px">🔗 ' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div>';
            relatedEdges.forEach(function (ed, idx) {
              html += '<div style="margin-bottom:6px;padding:6px 8px;background:rgba(120,160,255,0.1);border-radius:6px"><strong style="color:var(--dsw-alias-brand-primary,#78a0ff)">关系 ' + (idx + 1) + '：</strong>' + esc(ed.label || ed.relation || '无描述') + '</div>';
            });
            html += '<div style="margin-top:10px;text-align:right"><span data-detail-close="1" style="color:var(--dsw-alias-label-tertiary,#666);font-size:11px;cursor:pointer">点击空白处关闭</span></div>';
            detailPanel.innerHTML = html;
            detailPanel.style.display = 'block';
            var rect = g.getBoundingClientRect();
            detailPanel.style.left = Math.min(ev.clientX - rect.left, W - 310) + 'px';
            detailPanel.style.top = Math.min(ev.clientY - rect.top, H - 150) + 'px';
          });
          edgeLayer.appendChild(line);
          allEdges.push(line);
          // 关系标签（短标签，悬停显示完整）
          if (label) {
            var mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
            var shortLabel = truncate(label, 8);
            var tw = textWidth(shortLabel) + 20;
            var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            bg.setAttribute('x', mx - tw / 2); bg.setAttribute('y', my - 9);
            bg.setAttribute('width', tw); bg.setAttribute('height', 18);
            bg.setAttribute('rx', 9); bg.setAttribute('fill', 'rgba(30,30,55,0.92)');
            bg.setAttribute('stroke', 'rgba(150,180,255,0.45)');
            bg.dataset.source = e.source; bg.dataset.target = e.target;
            labelLayer.appendChild(bg);
            allLabels.push(bg);
            var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            txt.setAttribute('x', mx); txt.setAttribute('y', my + 3);
            txt.setAttribute('text-anchor', 'middle');
            txt.setAttribute('fill', '#c8dcff'); txt.setAttribute('font-size', '11');
            txt.textContent = shortLabel;
            txt.dataset.source = e.source; txt.dataset.target = e.target;
            // 标签也支持悬停和点击
            bg.style.cursor = 'pointer'; txt.style.cursor = 'pointer';
            bg.addEventListener('mouseenter', showTooltip);
            bg.addEventListener('mousemove', showTooltip);
            bg.addEventListener('mouseleave', hideTooltip);
            bg.addEventListener('click', function (ev) { ev.stopPropagation(); line.dispatchEvent(new MouseEvent('click', { clientX: ev.clientX, clientY: ev.clientY })); });
            txt.addEventListener('mouseenter', showTooltip);
            txt.addEventListener('mousemove', showTooltip);
            txt.addEventListener('mouseleave', hideTooltip);
            txt.addEventListener('click', function (ev) { ev.stopPropagation(); line.dispatchEvent(new MouseEvent('click', { clientX: ev.clientX, clientY: ev.clientY })); });
            labelLayer.appendChild(txt);
            allLabels.push(txt);
            allLabelTexts.push(txt);
          }
        });
        // 绘制节点
        nodes.forEach(function (n) {
          var pos = positions[n.id];
          if (!pos) return;
          var isCenter = n.id === centerId;
          var r = isCenter ? 34 : 22;
          var gnode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          gnode.style.cursor = 'pointer';
          gnode.dataset.id = n.id;
          // 光晕（中心节点）
          if (isCenter) {
            var glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            glow.setAttribute('cx', pos.x); glow.setAttribute('cy', pos.y);
            glow.setAttribute('r', r + 6);
            glow.setAttribute('fill', 'none');
            glow.setAttribute('stroke', 'rgba(255,180,100,0.3)');
            glow.setAttribute('stroke-width', '3');
            gnode.appendChild(glow);
          }
          var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
          circle.setAttribute('r', r);
          circle.setAttribute('fill', isCenter ? 'rgba(255,180,100,0.2)' : 'rgba(120,160,255,0.12)');
          circle.setAttribute('stroke', isCenter ? '#ffb464' : '#78a0ff');
          circle.setAttribute('stroke-width', isCenter ? '2.5' : '1.5');
          gnode.appendChild(circle);
          var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + 4);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('fill', '#fff'); text.setAttribute('font-size', isCenter ? '14' : '11');
          text.setAttribute('font-weight', isCenter ? '700' : '500');
          text.textContent = truncate(n.label || n.id, isCenter ? 4 : 3);
          gnode.appendChild(text);
          // 悬停高亮
          gnode.addEventListener('mouseenter', function (ev) {
            var nid = String(n.id || '').trim().toLowerCase();
            // 严格匹配：只忽略大小写和空格，不做包含匹配（避免"我"匹配到"我们"）
            var match = function (a, b) {
              return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
            };
            allEdges.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              if (related) {
                el.setAttribute('stroke', 'rgba(255,200,100,0.8)');
                el.setAttribute('stroke-width', '3');
                el.style.filter = 'drop-shadow(0 0 3px rgba(255,200,68,0.5))';
              } else {
                el.setAttribute('stroke', 'rgba(150,180,255,0.04)');
                el.setAttribute('stroke-width', '1');
                el.style.filter = 'none';
              }
            });
            allLabels.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              if (related) {
                el.style.opacity = '1';
                el.style.filter = 'drop-shadow(0 0 4px rgba(255,200,68,0.6))';
              } else {
                el.style.opacity = '0.05';
                el.style.filter = 'none';
              }
            });
            // 修改标签文字颜色
            allLabelTexts.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              if (related) {
                el.setAttribute('fill', '#ffcc44');
                el.setAttribute('font-size', '12');
                el.setAttribute('font-weight', '700');
              } else {
                el.setAttribute('fill', '#4a5a7a');
                el.setAttribute('font-size', '10');
                el.setAttribute('font-weight', '400');
              }
            });
            allNodes.forEach(function (el) {
              var related = match(el.dataset.id, nid) || edges.some(function (e) { return (match(e.source, nid) && match(e.target, el.dataset.id)) || (match(e.target, nid) && match(e.source, el.dataset.id)); });
              el.style.opacity = related ? '1' : '0.25';
            });
            // 节点 tooltip：显示该角色的所有关系
            var nodeEdges = edges.filter(function (ed) { return ed.source === nid || ed.target === nid; });
            var tooltipHtml = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;margin-bottom:6px;font-size:13px">👤 ' + esc(n.label || n.id) + '</div>';
            if (nodeEdges.length > 0) {
              tooltipHtml += '<div style="color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin-bottom:4px">共 ' + nodeEdges.length + ' 条关系：</div>';
              nodeEdges.slice(0, 5).forEach(function (ed) {
                var other = ed.source === nid ? ed.target : ed.source;
                var dir = ed.source === nid ? '→' : '←';
                tooltipHtml += '<div style="margin:2px 0"><span style="color:var(--dsw-alias-brand-primary,#78a0ff)">' + dir + ' ' + esc(other) + '</span>：' + esc(truncate(ed.label || ed.relation || '无描述', 20)) + '</div>';
              });
              if (nodeEdges.length > 5) tooltipHtml += '<div style="color:var(--dsw-alias-label-tertiary,#666);font-size:11px;margin-top:4px">...还有 ' + (nodeEdges.length - 5) + ' 条，点击查看全部</div>';
            } else {
              tooltipHtml += '<div style="color:var(--dsw-alias-label-tertiary,#666)">暂无关系</div>';
            }
            tooltipHtml += '<div style="color:var(--dsw-alias-label-tertiary,#666);font-size:10px;margin-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.1));padding-top:4px">点击查看完整关系</div>';
            tooltip.innerHTML = tooltipHtml;
            tooltip.style.display = 'block';
            var rect = g.getBoundingClientRect();
            tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
            tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
          });
          gnode.addEventListener('mousemove', function (ev) {
            if (tooltip.style.display === 'block') {
              var rect = g.getBoundingClientRect();
              tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
              tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
            }
          });
          gnode.addEventListener('mouseleave', function () {
            allEdges.forEach(function (el) { 
              el.setAttribute('stroke', 'rgba(150,180,255,0.25)'); 
              el.setAttribute('stroke-width', '1.5'); 
              el.style.filter = 'none';
            });
            allLabels.forEach(function (el) { 
              el.style.opacity = '1'; 
              el.style.filter = 'none';
            });
            allLabelTexts.forEach(function (el) {
              el.setAttribute('fill', '#c8dcff');
              el.setAttribute('font-size', '11');
              el.setAttribute('font-weight', '400');
            });
            allNodes.forEach(function (el) { el.style.opacity = '1'; });
            tooltip.style.display = 'none';
          });
          // 点击节点显示详情面板
          gnode.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var nid = n.id;
            var nodeEdges = edges.filter(function (ed) { return ed.source === nid || ed.target === nid; });
            var html = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;font-size:14px;margin-bottom:8px">👤 ' + esc(n.label || n.id) + '</div>';
            html += '<div style="color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin-bottom:8px">共 ' + nodeEdges.length + ' 条关系</div>';
            nodeEdges.forEach(function (ed, idx) {
              var other = ed.source === nid ? ed.target : ed.source;
              var direction = ed.source === nid ? '→' : '←';
              html += '<div style="margin-bottom:6px;padding:6px 8px;background:rgba(120,160,255,0.1);border-radius:6px"><strong style="color:var(--dsw-alias-brand-primary,#78a0ff)">' + direction + ' ' + esc(other) + '：</strong>' + esc(ed.label || ed.relation || '无描述') + '</div>';
            });
            if (nodeEdges.length === 0) html += '<div style="color:var(--dsw-alias-label-tertiary,#666)">暂无关系</div>';
            html += '<div style="margin-top:10px;text-align:right"><span data-detail-close="1" style="color:var(--dsw-alias-label-tertiary,#666);font-size:11px;cursor:pointer">点击空白处关闭</span></div>';
            detailPanel.innerHTML = html;
            detailPanel.style.display = 'block';
            var rect = g.getBoundingClientRect();
            detailPanel.style.left = Math.min(ev.clientX - rect.left, W - 310) + 'px';
            detailPanel.style.top = Math.min(ev.clientY - rect.top, H - 200) + 'px';
          });
          // 拖动
          var dragging = false, offset = { x: 0, y: 0 };
          gnode.addEventListener('mousedown', function (ev) {
            dragging = true; gnode.style.cursor = 'grabbing';
            var pt = svgPoint(svg, ev);
            offset.x = pt.x - pos.x; offset.y = pt.y - pos.y;
            ev.preventDefault(); ev.stopPropagation();
          });
          window.addEventListener('mousemove', function (ev) {
            if (!dragging) return;
            var pt = svgPoint(svg, ev);
            pos.x = Math.max(r, Math.min(W - r, pt.x - offset.x));
            pos.y = Math.max(r, Math.min(H - r, pt.y - offset.y));
            circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
            text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + 4);
            if (glow) { glow.setAttribute('cx', pos.x); glow.setAttribute('cy', pos.y); }
            // 更新连线和标签
            edgeLayer.innerHTML = ''; labelLayer.innerHTML = '';
            allEdges = []; allLabels = []; allLabelTexts = [];
            edges.forEach(function (e2) {
              var s2 = positions[e2.source], t2 = positions[e2.target];
              if (!s2 || !t2) return;
              var line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              line2.setAttribute('x1', s2.x); line2.setAttribute('y1', s2.y);
              line2.setAttribute('x2', t2.x); line2.setAttribute('y2', t2.y);
              line2.setAttribute('stroke', 'rgba(150,180,255,0.25)');
              line2.setAttribute('stroke-width', '1.5');
              line2.setAttribute('marker-end', 'url(#arrow2)');
              line2.dataset.source = e2.source; line2.dataset.target = e2.target;
              edgeLayer.appendChild(line2); allEdges.push(line2);
              var label2 = e2.label || e2.relation || '';
              if (label2) {
                var mx2 = (s2.x + t2.x) / 2, my2 = (s2.y + t2.y) / 2;
                var sl2 = truncate(label2, 12); var tw2 = textWidth(sl2) + 20;
                var bg2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                bg2.setAttribute('x', mx2 - tw2 / 2); bg2.setAttribute('y', my2 - 9);
                bg2.setAttribute('width', tw2); bg2.setAttribute('height', 18);
                bg2.setAttribute('rx', 9); bg2.setAttribute('fill', 'rgba(30,30,55,0.92)');
                bg2.setAttribute('stroke', 'rgba(150,180,255,0.45)');
                bg2.dataset.source = e2.source; bg2.dataset.target = e2.target;
                labelLayer.appendChild(bg2); allLabels.push(bg2);
                var txt2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                txt2.setAttribute('x', mx2); txt2.setAttribute('y', my2 + 3);
                txt2.setAttribute('text-anchor', 'middle');
                txt2.setAttribute('fill', '#c8dcff'); txt2.setAttribute('font-size', '11');
                txt2.textContent = sl2;
                txt2.dataset.source = e2.source; txt2.dataset.target = e2.target;
                labelLayer.appendChild(txt2); allLabels.push(txt2); allLabelTexts.push(txt2);
              }
            });
          });
          window.addEventListener('mouseup', function () { if (dragging) { dragging = false; gnode.style.cursor = 'pointer'; } });
          nodeLayer.appendChild(gnode);
          allNodes.push(gnode);
        });
        g.innerHTML = '';
        var info = document.createElement('div');
        info.style.cssText = 'margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;align-items:center';
        info.innerHTML = '<span><strong style="color:var(--dsw-alias-label-accent,#ffb464)">' + nodes.length + '</strong> 个角色，<strong style="color:var(--dsw-alias-brand-primary,#78a0ff)">' + edges.length + '</strong> 条关系</span><span style="font-size:11px;opacity:0.7">悬停看详情 · 点击看全部 · 拖动调整</span>';
        g.appendChild(info);
        g.appendChild(svg);
      }

      // 放大查看关系网（大窗口）
      function openRelationsModal(relations) {
        // 创建模态框背景
        var modalBg = document.createElement('div');
        modalBg.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center';
        // 创建模态框内容
        var modal = document.createElement('div');
        modal.style.cssText = 'background:var(--dsw-alias-bg-layer-1,#1a1a2e);border:1px solid rgba(150,180,255,0.3);border-radius:12px;padding:20px;width:90vw;max-width:1100px;height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.6)';
        // 标题栏
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px';
        header.innerHTML = '<span style="color:var(--dsw-alias-label-accent,#ffb464);font-size:18px;font-weight:600">🔗 角色关系网（大图）</span><button id="modal-close" style="background:rgba(255,100,100,0.2);border:1px solid rgba(255,100,100,0.4);color:#ff8888;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:13px">✕ 关闭</button>';
        modal.appendChild(header);
        // 关系网容器
        var graphContainer = document.createElement('div');
        graphContainer.style.cssText = 'flex:1;overflow:auto;position:relative';
        modal.appendChild(graphContainer);
        modalBg.appendChild(modal);
        document.body.appendChild(modalBg);
        // 关闭功能（用 mousedown 而不是 click，避免拖动节点时在背景上松开鼠标误关）
        var closeModal = function () { document.body.removeChild(modalBg); };
        modalBg.addEventListener('mousedown', function (e) { if (e.target === modalBg) closeModal(); });
        header.querySelector('#modal-close').addEventListener('click', closeModal);
        // 渲染大尺寸关系网（标签显示20个字）
        renderLargeGraph(graphContainer, relations, 20);
      }

      // 大尺寸关系网渲染（标签可自定义长度）
      function renderLargeGraph(container, relations, labelLen) { var _rawNodes = relations && relations.nodes ? relations.nodes : []; var _rawEdges = relations && relations.edges ? relations.edges : []; var _nodeById = {}; _rawNodes.forEach(function(n){ if (n && n.id) _nodeById[String(n.id).trim().toLowerCase()] = n; }); var _splitIds = {}; var _newNodes = []; _rawNodes.forEach(function(n){ if (!n) return; var _label = String(n.label || n.id || ''); var _parts = _label.split(/[、,，]/).map(function(s){ return s.trim(); }).filter(Boolean); var _allExist = _parts.length > 1 && _parts.every(function(p){ return _nodeById[String(p).trim().toLowerCase()]; }); if (_allExist) { _splitIds[String(n.id).trim().toLowerCase()] = _parts.map(function(p){ return p.trim(); }); return; } _newNodes.push(n); }); var _newEdges = []; _rawEdges.forEach(function(e){ if (!e) return; var _src = String(e.source || '').trim().toLowerCase(); var _tgt = String(e.target || '').trim().toLowerCase(); var _sp = _splitIds[_src] || [e.source]; var _tp = _splitIds[_tgt] || [e.target]; _sp.forEach(function(s){ _tp.forEach(function(t){ _newEdges.push({ source: s, target: t, label: e.label, relation: e.relation }); }); }); }); relations = { nodes: _newNodes, edges: _newEdges };
        var nodes = relations && relations.nodes ? relations.nodes : [];
        var edges = relations && relations.edges ? relations.edges : [];
        // 节点去重（按 id 和 label 去重，忽略大小写和空格）
        var seenIds = {};
        var uniqueNodes = [];
        nodes.forEach(function (n) {
          var id = String(n.id || '').trim().toLowerCase();
          var label = String(n.label || '').trim().toLowerCase();
          // 检查 id 或 label 是否已经存在
          if ((id && seenIds[id]) || (label && seenIds[label])) return;
          if (id) seenIds[id] = true;
          if (label) seenIds[label] = true;
          uniqueNodes.push(n);
        });
        nodes = uniqueNodes;
        if (!nodes.length && !edges.length) {
          container.innerHTML = '<span style="color:var(--dsw-alias-label-tertiary,#999)">暂无关系节点</span>';
          return;
        }
        var W = 1000, H = 650;
        var cx = W / 2, cy = H / 2;
        // 存储所有元素用于悬停高亮
        var allEdges = [], allLabels = [], allLabelTexts = [], allNodes = []; var _placedLabelRects = []; function _avoidLabelOverlap(mx, my, tw, th) { var x = mx - tw / 2, y = my - th / 2; var tries = 0; while (tries < 5) { var hit = false; for (var i = 0; i < _placedLabelRects.length; i++) { var r = _placedLabelRects[i]; if (x < r.x + r.w && x + tw > r.x && y < r.y + r.h && y + th > r.y) { hit = true; break; } } if (!hit) { _placedLabelRects.push({ x: x, y: y, w: tw, h: th }); return { x: mx, y: my }; } tries++; my += 14; y = my - th / 2; } _placedLabelRects.push({ x: x, y: y, w: tw, h: th }); return { x: mx, y: my }; }
        // 严格匹配函数
        var match = function (a, b) {
          return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
        };
        // 找中心节点
        var centerId = null;
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].id === '你' || nodes[i].label === '你' || nodes[i].id === '我' || nodes[i].label === '我') { centerId = nodes[i].id; break; }
        }
        if (!centerId && nodes.length) centerId = nodes[0].id;
        // 布局
        var otherNodes = nodes.filter(function (n) { return n.id !== centerId; });
        var connCount = {};
        edges.forEach(function (e) { connCount[e.source] = (connCount[e.source] || 0) + 1; connCount[e.target] = (connCount[e.target] || 0) + 1; });
        otherNodes.sort(function (a, b) { return (connCount[b.id] || 0) - (connCount[a.id] || 0); });
        var positions = {};
        if (centerId) positions[centerId] = { x: cx, y: cy };
        var innerCount = Math.min(6, otherNodes.length);
        var outerCount = otherNodes.length - innerCount;
        var innerR = 130, outerR = 210;
        otherNodes.forEach(function (n, idx) {
          var isInner = idx < innerCount;
          var r = isInner ? innerR : outerR;
          var groupIdx = isInner ? idx : idx - innerCount;
          var groupLen = isInner ? innerCount : outerCount;
          var angle = (groupIdx / groupLen) * Math.PI * 2 - Math.PI / 2;
          if (!isInner && groupLen > 0) angle += Math.PI / groupLen;
          positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        });
        // 截断函数
        var truncate = function (s, len) { s = String(s || ''); return s.length > len ? s.slice(0, len) + '…' : s; };
        var textWidth = function (s) { return String(s || '').length * 14; };
        // 创建 SVG
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        svg.style.cssText = 'background:rgba(0,0,0,0.3);border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.1))';
        var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = '<marker id="arrow3" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(150,180,255,0.6)"/></marker>';
        svg.appendChild(defs);
        var edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(edgeLayer);
        var labelLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(labelLayer);
        var nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svg.appendChild(nodeLayer);
        // tooltip
        var tooltip = document.createElement('div');
        tooltip.style.cssText = 'position:absolute;display:none;background:rgba(15,15,30,0.95);border:1px solid rgba(150,180,255,0.3);border-radius:8px;padding:10px 12px;font-size:13px;color:#e0e8ff;max-width:300px;z-index:10001;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.5);line-height:1.5';
        container.appendChild(tooltip);
        // 绘制连线
        edges.forEach(function (e) {
          var s = positions[e.source], t = positions[e.target];
          if (!s || !t) return;
          var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', s.x); line.setAttribute('y1', s.y);
          line.setAttribute('x2', t.x); line.setAttribute('y2', t.y);
          line.setAttribute('stroke', 'rgba(150,180,255,0.35)');
          line.setAttribute('stroke-width', '2');
          line.setAttribute('marker-end', 'url(#arrow3)');
          line.dataset.source = e.source; line.dataset.target = e.target;
          edgeLayer.appendChild(line);
          allEdges.push(line);
          // 连线悬停高亮 + tooltip
          line.style.cursor = 'pointer';
          line.addEventListener('mouseenter', function (ev) {
            allEdges.forEach(function (el) {
              if (el === line) {
                el.setAttribute('stroke', 'rgba(255,200,100,0.9)');
                el.setAttribute('stroke-width', '3.5');
                el.style.filter = 'drop-shadow(0 0 4px rgba(255,200,100,0.6))';
              } else {
                el.setAttribute('stroke', 'rgba(150,180,255,0.1)');
                el.setAttribute('stroke-width', '1.5');
                el.style.filter = 'none';
              }
            });
            allLabels.forEach(function (el) {
              if (el.dataset.source === e.source && el.dataset.target === e.target) {
                el.style.opacity = '1';
              } else {
                el.style.opacity = '0.3';
              }
            });
            allLabelTexts.forEach(function (el) {
              if (el.dataset.source === e.source && el.dataset.target === e.target) {
                el.setAttribute('fill', '#ffd070');
                el.setAttribute('font-size', '14');
                el.setAttribute('font-weight', '700');
              } else {
                el.setAttribute('fill', '#8090b0');
                el.setAttribute('font-size', '11');
                el.setAttribute('font-weight', '400');
              }
            });
            tooltip.innerHTML = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;margin-bottom:4px">' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div><div>' + esc(e.label || e.relation || '') + '</div>';
            tooltip.style.display = 'block';
            var rect = container.getBoundingClientRect();
            tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
            tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
          });
          line.addEventListener('mousemove', function (ev) {
            if (tooltip.style.display === 'block') {
              var rect = container.getBoundingClientRect();
              tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
              tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
            }
          });
          line.addEventListener('mouseleave', function () {
            allEdges.forEach(function (el) {
              el.setAttribute('stroke', 'rgba(150,180,255,0.35)');
              el.setAttribute('stroke-width', '2');
              el.style.filter = 'none';
            });
            allLabels.forEach(function (el) { el.style.opacity = '1'; });
            allLabelTexts.forEach(function (el) {
              el.setAttribute('fill', '#d0e0ff');
              el.setAttribute('font-size', '12');
              el.setAttribute('font-weight', '400');
            });
            tooltip.style.display = 'none';
          });
          // 标签
          var label = e.label || e.relation || '';
          if (label) {
            var mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
            var shortLabel = truncate(label, labelLen || 15);
            var tw = textWidth(shortLabel) + 24; var _lp = _avoidLabelOverlap(mx, my, tw, 22); mx = _lp.x; my = _lp.y;
            var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            bg.setAttribute('x', mx - tw / 2); bg.setAttribute('y', my - 11);
            bg.setAttribute('width', tw); bg.setAttribute('height', 22);
            bg.setAttribute('rx', 11); bg.setAttribute('fill', 'rgba(30,30,55,0.95)');
            bg.setAttribute('stroke', 'rgba(150,180,255,0.5)');
            bg.dataset.source = e.source; bg.dataset.target = e.target;
            labelLayer.appendChild(bg);
            allLabels.push(bg);
            var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            txt.setAttribute('x', mx); txt.setAttribute('y', my + 4);
            txt.setAttribute('text-anchor', 'middle');
            txt.setAttribute('fill', '#d0e0ff'); txt.setAttribute('font-size', '12');
            txt.textContent = shortLabel;
            txt.dataset.source = e.source; txt.dataset.target = e.target;
            labelLayer.appendChild(txt);
            allLabels.push(txt);
            allLabelTexts.push(txt);
            // 悬停显示完整内容
            var showTip = function (ev) {
              tooltip.innerHTML = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;margin-bottom:4px">' + esc(e.source) + ' ↔ ' + esc(e.target) + '</div><div>' + esc(label) + '</div>';
              tooltip.style.display = 'block';
              var rect = container.getBoundingClientRect();
              tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
              tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
            };
            bg.addEventListener('mouseenter', showTip);
            bg.addEventListener('mousemove', showTip);
            bg.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
            txt.addEventListener('mouseenter', showTip);
            txt.addEventListener('mousemove', showTip);
            txt.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
          }
        });
        // 绘制节点
        nodes.forEach(function (n) {
          var pos = positions[n.id];
          if (!pos) return;
          var isCenter = n.id === centerId;
          var r = isCenter ? 40 : 28;
          var gnode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          gnode.style.cursor = 'pointer';
          gnode.dataset.id = n.id;
          var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
          circle.setAttribute('r', r);
          circle.setAttribute('fill', isCenter ? 'rgba(255,180,100,0.25)' : 'rgba(120,160,255,0.15)');
          circle.setAttribute('stroke', isCenter ? '#ffb464' : '#78a0ff');
          circle.setAttribute('stroke-width', isCenter ? '3' : '2');
          gnode.appendChild(circle);
          var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + 5);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('fill', '#fff'); text.setAttribute('font-size', isCenter ? '16' : '13');
          text.setAttribute('font-weight', isCenter ? '700' : '500');
          text.textContent = truncate(n.label || n.id, isCenter ? 6 : 4);
          gnode.appendChild(text);
          // 节点悬停 tooltip + 高亮
          gnode.addEventListener('mouseenter', function (ev) {
            var nid = n.id;
            // 高亮相关连线和标签
            allEdges.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              if (related) {
                el.setAttribute('stroke', 'rgba(255,200,100,0.85)');
                el.setAttribute('stroke-width', '3.5');
                el.style.filter = 'drop-shadow(0 0 4px rgba(255,200,68,0.6))';
              } else {
                el.setAttribute('stroke', 'rgba(150,180,255,0.08)');
                el.setAttribute('stroke-width', '1');
                el.style.filter = 'none';
              }
            });
            allLabels.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              el.style.opacity = related ? '1' : '0.1';
            });
            allLabelTexts.forEach(function (el) {
              var related = match(el.dataset.source, nid) || match(el.dataset.target, nid);
              if (related) {
                el.setAttribute('fill', '#ffcc44');
                el.setAttribute('font-size', '14');
                el.setAttribute('font-weight', '700');
              } else {
                el.setAttribute('fill', '#5a6a8a');
                el.setAttribute('font-size', '12');
                el.setAttribute('font-weight', '400');
              }
            });
            allNodes.forEach(function (el) {
              var related = match(el.dataset.id, nid) || edges.some(function (e) { return (match(e.source, nid) && match(e.target, el.dataset.id)) || (match(e.target, nid) && match(e.source, el.dataset.id)); });
              el.style.opacity = related ? '1' : '0.3';
            });
            // tooltip
            var nodeEdges = edges.filter(function (ed) { return ed.source === n.id || ed.target === n.id; });
            var html = '<div style="color:var(--dsw-alias-label-accent,#ffb464);font-weight:600;margin-bottom:6px;font-size:15px">👤 ' + esc(n.label || n.id) + '</div>';
            html += '<div style="color:var(--dsw-alias-label-tertiary,#999);font-size:12px;margin-bottom:4px">共 ' + nodeEdges.length + ' 条关系：</div>';
            nodeEdges.slice(0, 8).forEach(function (ed) {
              var other = ed.source === n.id ? ed.target : ed.source;
              var dir = ed.source === n.id ? '→' : '←';
              html += '<div style="margin:3px 0"><span style="color:var(--dsw-alias-brand-primary,#78a0ff)">' + dir + ' ' + esc(other) + '</span>：' + esc(truncate(ed.label || ed.relation || '无描述', 30)) + '</div>';
            });
            if (nodeEdges.length > 8) html += '<div style="color:var(--dsw-alias-label-tertiary,#666);font-size:11px;margin-top:4px">...还有 ' + (nodeEdges.length - 8) + ' 条</div>';
            tooltip.innerHTML = html;
            tooltip.style.display = 'block';
            var rect = container.getBoundingClientRect();
            tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
            tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
          });
          gnode.addEventListener('mousemove', function (ev) {
            if (tooltip.style.display === 'block') {
              var rect = container.getBoundingClientRect();
              tooltip.style.left = (ev.clientX - rect.left + 12) + 'px';
              tooltip.style.top = (ev.clientY - rect.top + 12) + 'px';
            }
          });
          gnode.addEventListener('mouseleave', function () {
            // 恢复所有样式
            allEdges.forEach(function (el) {
              el.setAttribute('stroke', 'rgba(150,180,255,0.35)');
              el.setAttribute('stroke-width', '2');
              el.style.filter = 'none';
            });
            allLabels.forEach(function (el) { el.style.opacity = '1'; });
            allLabelTexts.forEach(function (el) {
              el.setAttribute('fill', '#d0e0ff');
              el.setAttribute('font-size', '12');
              el.setAttribute('font-weight', '400');
            });
            allNodes.forEach(function (el) { el.style.opacity = '1'; });
            tooltip.style.display = 'none';
          });
          // SVG 坐标转换
          function svgPoint(svg, evt) {
            var pt = svg.createSVGPoint();
            pt.x = evt.clientX; pt.y = evt.clientY;
            return pt.matrixTransform(svg.getScreenCTM().inverse());
          }
          // 拖动功能
          var dragging = false, offset = { x: 0, y: 0 };
          gnode.addEventListener('mousedown', function (ev) {
            dragging = true; gnode.style.cursor = 'grabbing';
            var pt = svgPoint(svg, ev);
            offset.x = pt.x - pos.x; offset.y = pt.y - pos.y;
            ev.preventDefault(); ev.stopPropagation();
          });
          window.addEventListener('mousemove', function (ev) {
            if (!dragging) return;
            var pt = svgPoint(svg, ev);
            pos.x = Math.max(r, Math.min(W - r, pt.x - offset.x));
            pos.y = Math.max(r, Math.min(H - r, pt.y - offset.y));
            circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y);
            text.setAttribute('x', pos.x); text.setAttribute('y', pos.y + 5);
            // 重新绘制连线和标签
            edgeLayer.innerHTML = ''; labelLayer.innerHTML = '';
            allEdges = []; allLabels = []; allLabelTexts = [];
            _placedLabelRects = [];
            edges.forEach(function (e2) {
              var s2 = positions[e2.source], t2 = positions[e2.target];
              if (!s2 || !t2) return;
              var line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              line2.setAttribute('x1', s2.x); line2.setAttribute('y1', s2.y);
              line2.setAttribute('x2', t2.x); line2.setAttribute('y2', t2.y);
              line2.setAttribute('stroke', 'rgba(150,180,255,0.35)');
              line2.setAttribute('stroke-width', '2');
              line2.setAttribute('marker-end', 'url(#arrow3)');
              line2.dataset.source = e2.source; line2.dataset.target = e2.target;
              edgeLayer.appendChild(line2);
              allEdges.push(line2);
              var label2 = e2.label || e2.relation || '';
              if (label2) {
                var mx2 = (s2.x + t2.x) / 2, my2 = (s2.y + t2.y) / 2;
                var sl2 = truncate(label2, labelLen || 15); var tw2 = textWidth(sl2) + 24; var _lp2 = _avoidLabelOverlap(mx2, my2, tw2, 22); mx2 = _lp2.x; my2 = _lp2.y;
                var bg2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                bg2.setAttribute('x', mx2 - tw2 / 2); bg2.setAttribute('y', my2 - 11);
                bg2.setAttribute('width', tw2); bg2.setAttribute('height', 22);
                bg2.setAttribute('rx', 11); bg2.setAttribute('fill', 'rgba(30,30,55,0.95)');
                bg2.setAttribute('stroke', 'rgba(150,180,255,0.5)');
                bg2.dataset.source = e2.source; bg2.dataset.target = e2.target;
                labelLayer.appendChild(bg2);
                allLabels.push(bg2);
                var txt2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                txt2.setAttribute('x', mx2); txt2.setAttribute('y', my2 + 4);
                txt2.setAttribute('text-anchor', 'middle');
                txt2.setAttribute('fill', '#d0e0ff'); txt2.setAttribute('font-size', '12');
                txt2.textContent = sl2;
                txt2.dataset.source = e2.source; txt2.dataset.target = e2.target;
                labelLayer.appendChild(txt2);
                allLabels.push(txt2);
                allLabelTexts.push(txt2);
              }
            });
          });
          window.addEventListener('mouseup', function () { if (dragging) { dragging = false; gnode.style.cursor = 'pointer'; } });
          allNodes.push(gnode);
          nodeLayer.appendChild(gnode);
        });
        container.innerHTML = '';
        var info = document.createElement('div');
        info.style.cssText = 'margin-bottom:10px;font-size:13px;color:var(--dsw-alias-label-tertiary,#999);display:flex;justify-content:space-between';
        info.innerHTML = '<span><strong style="color:var(--dsw-alias-label-accent,#ffb464)">' + nodes.length + '</strong> 个角色，<strong style="color:var(--dsw-alias-brand-primary,#78a0ff)">' + edges.length + '</strong> 条关系</span><span style="font-size:12px">悬停看完整关系 · 标签显示' + (labelLen || 15) + '字</span>';
        container.appendChild(info);
        container.appendChild(svg);
      }

      // 关系网 JSON 编辑折叠
      var jsonToggle = container.querySelector('#tavern-relations-json-toggle');
      var jsonBody = container.querySelector('#tavern-relations-json-body');
      if (jsonToggle && jsonBody) {
        jsonToggle.addEventListener('click', function () {
          var isOpen = jsonBody.style.display !== 'none';
          jsonBody.style.display = isOpen ? 'none' : 'block';
          jsonToggle.textContent = isOpen ? '📝 手动编辑 JSON（高级）▼' : '📝 手动编辑 JSON（高级）▲';
        });
      }

      container.querySelector('#tavern-relations-save').addEventListener('click', function () {
        try { var r = JSON.parse(container.querySelector('#tavern-relations-data').value || '{"nodes":[],"edges":[]}'); } catch (e) { alert('关系网 JSON 格式错误'); return; }
        var sid = getCurrentSessionId();
        fetch('/api/tavern/relations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relations: r, sessionId: sid }) }).then(function (r2) { return r2.json(); }).then(function (data) {
          container.querySelector('#tavern-status').textContent = data.ok ? '✅ 关系网已保存（会话级）' : '❌ ' + data.error;
          if (data.ok) renderRelationsGraph(r);
        });
      });
      container.querySelector('#tavern-relations-render').addEventListener('click', function () {
        var sid = getCurrentSessionId();
        fetch('/api/tavern/relations?sessionId=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.relations) {
            container.querySelector('#tavern-relations-data').value = JSON.stringify(data.relations, null, 2);
            renderRelationsGraph(data.relations);
          }
        });
      });

      // ── 关系网「软注入」开关 ──
      // 体检结论：关系网数据以前从不进提示词（有图谱但零影响）。现在的软注入只给**一行存在性提示**，
      // 明确要求模型别据此推进剧情 —— 开关默认开，关掉就一点都不注入。
      var relHintToggle = container.querySelector('#tavern-relations-hint');
      var relHintStatus = container.querySelector('#tavern-relations-hint-status');
      function paintRelHint(on) {
        if (!relHintToggle) return;
        relHintToggle.checked = on;
        if (relHintStatus) {
          relHintStatus.textContent = on ? '✅ 已开启（只给存在性提示）' : '关闭';
          relHintStatus.style.color = on ? '#27ae60' : '#999';
        }
      }
      if (relHintToggle) {
        fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (d) {
          paintRelHint(!d || d.relationsHint !== false);   // 后端默认 true，只有显式 false 才算关
        }).catch(function () { paintRelHint(true); });
        relHintToggle.addEventListener('change', function () {
          var on = relHintToggle.checked;
          if (relHintStatus) { relHintStatus.textContent = '⏳ 保存中…'; relHintStatus.style.color = '#f39c12'; }
          fetch('/api/tavern/state', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ relationsHint: on })
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '保存失败');
            paintRelHint(on);
          }).catch(function () {
            relHintToggle.checked = !on;
            if (relHintStatus) { relHintStatus.textContent = '❌ 保存失败'; relHintStatus.style.color = '#e74c3c'; }
          });
        });
      }

      // ── 🎓 技能（Skill）：生成 / 刷新 / 删除 / 手动绑定 ───────────────
      // 生成逻辑在服务端（保存预设时也会自动跑一次）；这里只做界面与手动选择。
      var skillState = { presetId: '', available: [], bound: [], statusBase: '', statusKind: '', toolProbe: null, toolProbeText: '' };
      // 状态行 = 基础文本 + 工具探测后缀。后缀只在本页面生命周期里探测一次（见 probeToolsOnce），
      // 之后每次刷状态都只是把它重新拼上 —— 旧写法是**每次 loadSkills() 都打一次 /tool-probe**，
      // 而 loadSkills() 正是「🎓 技能」四个按钮的收尾动作（用户实测：点完那些按钮输入框会点不动）。
      function repaintSkillStatus() {
        var el = container.querySelector('#tavern-skill-status');
        if (!el) return;
        el.textContent = (skillState.statusBase || '') + (skillState.toolProbeText || '');
        el.style.color = skillState.statusKind === 'err' ? '#e74c3c' : (skillState.statusKind === 'warn' ? '#f39c12' : '');
      }
      function skillStatus(text, kind) {
        skillState.statusBase = String(text || '');
        if (kind !== undefined) skillState.statusKind = kind;
        repaintSkillStatus();
      }
      function skillBindStatus(text, kind) {
        var el = container.querySelector('#tavern-skill-bind-status');
        if (!el) return;
        el.textContent = String(text || '');
        el.style.color = kind === 'err' ? '#e74c3c' : (kind === 'ok' ? '#27ae60' : '');
      }
      function renderSkillList() {
        var list = container.querySelector('#tavern-skill-list');
        if (!list) return;
        list.innerHTML = '';
        if (!skillState.available.length) {
          list.innerHTML = '<div class="t-status">（磁盘上还没有任何 skill；生成一个或放到 &lt;DSH_HOME&gt;/skills 下）</div>';
          return;
        }
        skillState.available.forEach(function (s) {
          var row = document.createElement('div');
          row.className = 't-item';
          var on = skillState.bound.indexOf(s.name) >= 0;
          row.innerHTML = '<label class="t-check" style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;padding:4px 0">'
            + '<input type="checkbox" data-skill="' + esc(s.name) + '"' + (on ? ' checked' : '') + '>'
            + '<span><b>' + esc(s.name) + '</b>'
            + (s.description ? '<br><span style="font-size:11px;opacity:.75">' + esc(s.description) + '</span>' : '')
            + '</span></label>';
          list.appendChild(row);
        });
      }
      // 工具注册能力探测：只读、且**每个页面生命周期只打一次**。
      //   skillState.toolProbe 三态：null = 还没问过；false = 正在问；true = 问过了（成功失败都置 true，不重试）。
      function probeToolsOnce() {
        if (skillState.toolProbe === true || skillState.toolProbe === false) return;
        skillState.toolProbe = false;
        fetch('/api/tavern/tool-probe').then(function (r) { return r.json(); }).then(function (p) {
          skillState.toolProbe = true;
          if (!p) return;
          skillState.toolProbeText = p.hasToolsService
            ? (p.canRegister
              ? '　|　工具注册：✅ 有 ctx.tools 且能 register()（探针只读，不再真注册）'
              : '　|　工具注册：⚠️ 有 ctx.tools 但没有 register()：' + esc(p.registerError || p.note || '未知'))
            : '　|　工具注册：❌ 宿主未暴露 ctx.tools（只能靠 /名称 手打或文件读取）';
          repaintSkillStatus();
        }).catch(function () { skillState.toolProbe = true; });
      }
      function loadSkills(presetId) {
        var pid = presetId || getActivePresetId() || '';
        skillState.presetId = pid;
        return fetch('/api/tavern/skills?presetId=' + encodeURIComponent(pid))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '读取失败');
            skillState.available = d.available || [];
            skillState.bound = d.bound || [];
            var auto = container.querySelector('#tavern-skill-auto');
            if (auto) auto.checked = d.autoGenerate !== false;
            var full = container.querySelector('#tavern-skill-full');
            if (full) full.checked = d.autoFull === true;
            var hint = container.querySelector('#tavern-skill-hint');
            if (hint) hint.checked = d.hint !== false;
            var styleSel = container.querySelector('#tavern-skill-style');
            if (styleSel) styleSel.value = d.style === 'index' ? 'index' : 'instructions';
            var g = d.generated || {};
            var head = '目录：' + esc(d.skillsDirOverride || d.skillsRoot || '');
            var gen = g.exists ? ('✅ 已生成 ' + esc(g.name) + '（' + g.bytes + ' 字节）') : '⚪ 本预设尚未生成技能';
            skillStatus(head + '　|　' + gen + '　|　已绑定 ' + skillState.bound.length + ' 个：' + (skillState.bound.join('、') || '（无）'));
            renderSkillList();
            // 工具注册能力探测：**每个页面生命周期只问一次**（见 probeToolsOnce）。
            //   旧写法是**每次 loadSkills() 都问一遍**，而 loadSkills() 正好是「🎓 技能」四个按钮
            //   （生成 / 刷新 / 删除 / 切形态）的收尾动作 —— 等于每点一次按钮都去碰一次宿主工具注册表。
            //   服务端那条接口现在也已是纯只读（不再真注册探针工具，见 lib/index.js 的 tool-probe）。
            probeToolsOnce();
          })
          .catch(function (e) {
            skillStatus('❌ ' + ((e && e.message) || e) + '（宿主没提供技能接口时会这样；生成功能仍可用）', 'err');
          });
      }
      (function wireSkillCard() {
        var pairs = [['#tavern-skill-auto', 'skillAutoGenerate'], ['#tavern-skill-full', 'skillAutoFull'], ['#tavern-skill-hint', 'skillHint']];
        pairs.forEach(function (p) {
          var el = container.querySelector(p[0]);
          if (!el) return;
          el.addEventListener('change', function () {
            var body = {};
            body[p[1]] = el.checked;
            fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (!d || !d.ok) throw new Error((d && d.error) || '保存失败');
                skillStatus('✅ 设置已保存', 'ok');
                return loadSkills(skillState.presetId);
              })
              .catch(function (e) { skillStatus('❌ ' + e.message, 'err'); el.checked = !el.checked; });
          });
        });
        var genBtn = container.querySelector('#tavern-skill-generate');
        if (genBtn) genBtn.addEventListener('click', function () {
          var pid = getActivePresetId();
          if (!pid) { skillStatus('❌ 还没选择预设，请先在顶部选一个', 'err'); return; }
          skillStatus('⏳ 生成中…', 'warn');
          fetch('/api/tavern/skills/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId: pid }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '生成失败');
              // unchanged = 内容与磁盘上完全一致 ⇒ 服务端**刻意没有落盘**
              //（写盘会让宿主重载技能清单，见 lib/index.js writePresetSkill 的注释）
              skillStatus(d.unchanged
                ? '✅ 技能已是最新（内容未变，未重写文件）：' + d.name + '（' + d.bytes + ' 字节）'
                : '✅ 已生成 ' + d.name + '（' + d.bytes + ' 字节）→ ' + d.file, 'ok');
              return loadSkills(pid);
            })
            .catch(function (e) { skillStatus('❌ ' + e.message, 'err'); });
        });
        var refBtn = container.querySelector('#tavern-skill-refresh');
        if (refBtn) refBtn.addEventListener('click', function () { loadSkills(getActivePresetId()); });
        // 形态改动要**重新生成** —— 否则磁盘上还是旧形态，用户会以为没生效。
        var styleSel = container.querySelector('#tavern-skill-style');
        if (styleSel) styleSel.addEventListener('change', function () {
          var pid = getActivePresetId();
          var style = styleSel.value === 'index' ? 'index' : 'instructions';
          skillStatus('⏳ 切换技能形态并重新生成…', 'warn');
          fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillStyle: style }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '保存失败');
              if (!pid) throw new Error('还没选择预设，无法立即重新生成（设置已保存）');
              return fetch('/api/tavern/skills/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId: pid, style: style }) })
                .then(function (r2) { return r2.json(); });
            })
            .then(function (g) {
              if (!g || !g.ok) throw new Error((g && g.error) || '重新生成失败');
              skillStatus('✅ 已切到' + (g.style === 'index' ? '设定索引' : '写作指令') + '形态'
                + (g.unchanged ? '（内容未变，未重写文件）' : '并重新生成') + '（' + g.bytes + ' 字节）', 'ok');
              return loadSkills(pid);
            })
            .catch(function (e) { skillStatus('❌ ' + ((e && e.message) || e), 'err'); });
        });
        var delBtn = container.querySelector('#tavern-skill-delete');
        if (delBtn) delBtn.addEventListener('click', function () {
          var pid = getActivePresetId();
          if (!pid) { skillStatus('❌ 还没选择预设', 'err'); return; }
          if (!window.confirm('删除本预设生成的 skill 目录？\n（手动绑定的其它 skill 不受影响）')) return;
          fetch('/api/tavern/skills/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId: pid }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '删除失败');
              skillStatus(d.removed ? '✅ 已删除生成的 skill' : '⚪ 本来就没有生成过', 'ok');
              return loadSkills(pid);
            })
            .catch(function (e) { skillStatus('❌ ' + e.message, 'err'); });
        });
        var saveBind = container.querySelector('#tavern-skill-save-bind');
        if (saveBind) saveBind.addEventListener('click', function () {
          var pid = getActivePresetId();
          if (!pid) { skillBindStatus('❌ 先选预设', 'err'); return; }
          var list = container.querySelector('#tavern-skill-list');
          var picked = [];
          var boxes = list ? list.querySelectorAll('input[data-skill]') : [];
          Array.prototype.forEach.call(boxes, function (cb) { if (cb.checked) picked.push(cb.getAttribute('data-skill')); });
          skillBindStatus('⏳ 保存中…', 'warn');
          fetch('/api/tavern/skills/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId: pid, skills: picked }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '保存失败');
              skillState.bound = d.bound || [];
              skillBindStatus('✅ 已绑定 ' + skillState.bound.length + ' 个', 'ok');
              return loadSkills(pid);
            })
            .catch(function (e) { skillBindStatus('❌ ' + e.message, 'err'); });
        });
        loadSkills(getActivePresetId());
      })();
      // 放大查看关系网
      container.querySelector('#tavern-relations-expand').addEventListener('click', function () {
        var sid = getCurrentSessionId();
        fetch('/api/tavern/relations?sessionId=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok && data.relations) {
            openRelationsModal(data.relations);
          }
        });
      });

      // ── 🔞 成人向提示段：开关 + 正文（正文只存服务端 state）──────────
      ;(function wireNsfwSlot() {
        var box = container.querySelector('#tavern-nsfw-enabled');
        var area = container.querySelector('#tavern-nsfw-prompt');
        var saveBtn = container.querySelector('#tavern-nsfw-save');
        var status = container.querySelector('#tavern-nsfw-status');
        if (!box || !area) return;
        var lastSaved = null;
        function setStatus(msg, color) { if (status) { status.textContent = msg; status.style.color = color || '#999' } }
        function describe(on, text) {
          var n = String(text || '').trim().length;
          if (!on) return '关闭';
          return n ? ('✅ 已开启（' + n + ' 字）') : '⚠️ 已开启但正文为空 ⇒ 不注入';
        }
        function push(body) {
          return fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json() })
            .then(function (d) { if (!d || !d.ok) throw new Error((d && d.error) || '保存失败'); return d });
        }
        fetch('/api/tavern/state').then(function (r) { return r.json() }).then(function (d) {
          if (!d || !d.ok) { setStatus('读取失败', '#e74c3c'); return }
          box.checked = d.nsfwEnabled === true;
          if (typeof d.nsfwPrompt === 'string') { area.value = d.nsfwPrompt; lastSaved = d.nsfwPrompt }
          setStatus(describe(box.checked, area.value));
        }).catch(function () { setStatus('读取失败', '#e74c3c') });
        box.addEventListener('change', function () {
          push({ nsfwEnabled: box.checked }).then(function () {
            setStatus(describe(box.checked, area.value));
          }).catch(function (e) { setStatus('❌ ' + e.message, '#e74c3c'); box.checked = !box.checked });
        });
        function saveText(silent) {
          push({ nsfwPrompt: area.value }).then(function () {
            lastSaved = area.value;
            setStatus(describe(box.checked, area.value) + (silent ? '（已自动保存）' : ''));
          }).catch(function (e) { setStatus('❌ ' + e.message, '#e74c3c') });
        }
        if (saveBtn) saveBtn.addEventListener('click', function () { saveText(false) });
        // 失焦自动保存：只在内容真的变了时写一次，避免"改了忘保存"
        area.addEventListener('blur', function () { if (lastSaved === null || area.value !== lastSaved) saveText(true) });
      })();

      // 剧情选项开关（原「NSFW 成人模式」开关已改为上面独立的"成人向提示段"卡片）
      var plotOptionsEl = container.querySelector('#tavern-plot-options');
      if (plotOptionsEl) {
        var plotStatusEl = container.querySelector('#tavern-plot-options-status');
        var syncPlotStatus = function (on) {
          if (!plotStatusEl) return;
          plotStatusEl.textContent = on ? '✅ 已开启' : '关闭';
          plotStatusEl.style.color = on ? '#27ae60' : '#999';
        };
        // 从服务端加载初始状态
        fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) {
            plotOptionsEl.checked = data.plotOptions !== false;
            state.plotOptions = plotOptionsEl.checked;   // 与服务端实况保持一致
            syncPlotStatus(plotOptionsEl.checked);
          }
        }).catch(function () {});
        plotOptionsEl.addEventListener('change', function (e) {
          state.plotOptions = e.target.checked;
          syncPlotStatus(e.target.checked);
          refreshYml();
          // 同步到服务端
          fetch('/api/tavern/state', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ plotOptions: e.target.checked })
          }).catch(function () {});
        });
      }
      container.querySelector('#tavern-extra').addEventListener('input', function (e) { state.extraPrompt = e.target.value; refreshYml(); });

      // AI 工具开关
      var toolsToggle = container.querySelector('#tavern-tools-toggle');
      var toolsStatus = container.querySelector('#tavern-tools-status');
      // 加载当前状态
      fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok && toolsToggle) {
          toolsToggle.checked = data.toolsEnabled !== false;
          if (toolsStatus) toolsStatus.textContent = data.toolsEnabled !== false ? '✅ 工具可用' : '❌ 工具已禁用';
        }
      var netToggle = container.querySelector('#tavern-network-toggle');
      var netStatus = container.querySelector('#tavern-network-status');
      fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok && netToggle) { netToggle.checked = data.networkEnabled === true; if (netStatus) netStatus.textContent = data.networkEnabled === true ? '✅ 已启用' : '❌ 未启用'; }
      }).catch(function () {});
      if (netToggle) {
        netToggle.addEventListener('change', function (e) {
          var checked = e.target.checked;
          if (netStatus) netStatus.textContent = '⏳ 切换中…';
          fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ networkEnabled: checked }) })
            .then(function (r) { return r.json(); }).then(function (d) {
              if (d.ok) { if (netStatus) netStatus.textContent = checked ? '✅ 已启用' : '❌ 未启用'; }
              else { if (netStatus) netStatus.textContent = '❌ 失败'; netToggle.checked = !checked; }
            }).catch(function () { if (netStatus) netStatus.textContent = '❌ 失败'; netToggle.checked = !checked; });
        });
      }
      var acToggle = container.querySelector('#tavern-anticliche-toggle');
      var acStatus = container.querySelector('#tavern-anticliche-status');
      fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok && acToggle) { acToggle.checked = data.antiCliche !== false; if (acStatus) acStatus.textContent = data.antiCliche !== false ? '✅ 已启用' : '❌ 未启用'; }
      }).catch(function () {});
      if (acToggle) {
        acToggle.addEventListener('change', function (e) {
          var checked = e.target.checked;
          if (acStatus) acStatus.textContent = '⏳ 切换中…';
          fetch('/api/tavern/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ antiCliche: checked }) })
            .then(function (r) { return r.json(); }).then(function (d) {
              if (d.ok) { if (acStatus) acStatus.textContent = checked ? '✅ 已启用' : '❌ 未启用'; }
              else { if (acStatus) acStatus.textContent = '❌ 失败'; acToggle.checked = !checked; }
            }).catch(function () { if (acStatus) acStatus.textContent = '❌ 失败'; acToggle.checked = !checked; });
        });
      }
      }).catch(function () {});
      if (toolsToggle) {
        toolsToggle.addEventListener('change', function (e) {
          var checked = e.target.checked;
          if (toolsStatus) toolsStatus.textContent = checked ? '⏳ 切换中…' : '⏳ 切换中…';
          fetch('/api/tavern/state', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ toolsEnabled: checked })
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (toolsStatus) toolsStatus.textContent = data.toolsEnabled ? '✅ 工具可用' : '❌ 工具已禁用';
            // （已清理）这里原先还去写 #tavern-inject-status（旧版"全局注入"指示），该元素早已不在面板里
          }).catch(function () {
            if (toolsStatus) toolsStatus.textContent = '⚠️ 切换失败';
          });
        });
      }

      // ⚠ 语义已更新（P0-6）：「白名单机制已移除」的说法不再成立 —— 现在的模型是
      //   「注入资格 = 显式绑定闸门；生效范围 = 上方「🎯 生效范围」卡（initScopePanel）」。
      //   本卡负责「绑定后哪些会话真的吃到注入」，与这里的旧草稿式白名单编辑不是一回事。
      // 以下旧代码（textarea 草稿式白名单）保留但注释：其目标元素早已删除，直接复活会报错；
      //   「一键添加当前工作区」的交互思路已由 initScopePanel 以 chips 方式重新实现。

      // ── 会话预设选择器 ──
      // （已删除）旧 `#tavern-session-preset` 下拉框的引用：markup 早已换成
      //   自定义下拉（#tavern-session-preset-btn/-label/-panel），querySelector 只会拿到 null。
      // 监听浮动面板的预设变更，保持同步
      document.addEventListener('tavern-preset-changed-from-float', function(e) {
        try {
          if (e.detail && e.detail.presetId) {
            var label = document.getElementById('tavern-session-preset-label');
            if (label) { label.textContent = e.detail.presetName || label.textContent; label.dataset.presetId = e.detail.presetId; }
            // 双向同步：浮动面板切换后，酒馆面板的预设下拉/状态也一起刷新
            loadSessionPresets();
            loadCurrent();
            loadWb();
          }
        } catch(err) {}
      });
      var presetStatus = container.querySelector('#tavern-preset-status');

      function loadSessionPresets(forcePresetId) {
        // ★ 统一：请求预设列表时带上当前会话，后端返回 DSH 权威预设
        var loadSid = (function () {
          try { return getCurrentSessionId(); } catch (e) { return ''; }
        })();
        var presetsUrl = '/api/tavern/presets' + (loadSid ? '?sessionId=' + encodeURIComponent(loadSid) : '');
        return fetch(presetsUrl).then(function (r) { return r.json(); }).then(function (data) {
          if (!data.ok) return;
          var presetBtn = document.getElementById('tavern-session-preset-btn');
          var presetLabel = document.getElementById('tavern-session-preset-label');
          var presetPanel = document.getElementById('tavern-session-preset-panel');
          if (!presetBtn || !presetLabel || !presetPanel) return;
          
          // 更新当前选中的标签（★ 优先 DSH 权威预设 data.currentPresetId，localStorage 兜底，保持一致）
          // 注意：权威值即使是 default 也要采用（default 是合法的酒馆默认预设），不能因此回退 localStorage 导致面板与顶部不一致。
          // 新建/复制预设后调用方传入 forcePresetId，强制选中新预设（避免被会话绑定的旧预设覆盖显示）。
          var activeId = forcePresetId || (data.currentPresetId && data.currentPresetId !== '' ? data.currentPresetId : getActivePresetId());
          if (!activeId) activeId = '';
          if (forcePresetId) setActivePresetId(forcePresetId);
          else if (data.currentPresetId && activeId !== data.currentPresetId) setActivePresetId(activeId);
          // ★ 两套 id 空间在这里对齐（修「静默切错编辑目标」）：
          //   服务端 currentPresetId 给的是**目录名**，而列表条目同时带 id 与 presetId。
          //   只按 id 找不到 → 旧代码会把 activeId 改写成"第一个预设" ⇒ 用户以为在编辑
          //   会话那张卡，实际保存落到了另一张卡上。现在先按三种写法匹配，命中后把 activeId
          //   统一成列表条目的 id（目录名），下游 dataset / 保存目标都认这一种。
          var matched = matchPresetInList(data.presets || [], activeId);
          if (!matched) {
            var firstTavern = (data.presets || []).find(function (p) { return p.origin === 'tavern' || p.isTavern || String(p.id).indexOf('preset-') === 0; });
            activeId = firstTavern ? firstTavern.id : ((data.presets || [])[0] && (data.presets || [])[0].id || '');
            matched = matchPresetInList(data.presets || [], activeId);
            if (activeId) setActivePresetId(activeId);
          } else if (matched.id !== activeId) {
            activeId = matched.id;
            setActivePresetId(activeId);
          }
          var currentPreset = matched;
          // ⚠ label 的 textContent 会被 saveCurrent() 当预设名写进 preset.yml，
          //   所以这里**只能**放纯 name；真名线索单独走下面那个 identity 行。
          presetLabel.textContent = currentPreset ? currentPreset.name : '请选择预设';
          presetLabel.dataset.presetId = activeId || '';
          // ★ 技能卡片跟着当前预设走（生成/绑定都是按预设的）：切预设时刷新它
          try { loadSkills(activeId); } catch (e) {}
          presetBtn.dataset.presetId = activeId || '';
          // ★ P0-3b：name 只是面板显示名，真正的内容看这行线索（textContent，不拼 HTML）
          var identityEl = document.getElementById('tavern-session-preset-identity');
          if (identityEl) identityEl.textContent = currentPreset ? presetIdentityClue(currentPreset) : '';
          
          // 渲染下拉面板
          presetPanel.innerHTML = '';
          // ★ 提示：完整 agent 角色本体需在聊天顶部选择器切换；这里切换仅让世界书/记忆/关系网跟随
          var tipBar = document.createElement('div');
          tipBar.style.cssText = 'padding:6px 10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8aaa);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));background:rgba(255,255,255,0.03);line-height:1.5';
          tipBar.textContent = 'ℹ️ 这里仅展示预设构成；切换「完整角色卡本体」请在聊天顶部预设选择器选择后新开会话。此处选择只让 世界书/记忆/关系网 跟随。';
          presetPanel.appendChild(tipBar);
          
          // 分组
          var groups = [
            { key: 'tavern', label: '🍺 酒馆预设', items: [], collapsed: false },
            { key: 'builtin', label: '🛡️ 原生内置', items: [], collapsed: false }
          ];
          
          (data.presets || []).forEach(function (p) {
            var isTavern = p.origin === 'tavern' || p.isTavern || (p.id && (p.id.indexOf('preset-') === 0 || p.id === 'default' || p.id === 'tavern' || p.id === 'tavern-lite'));
            var g = isTavern ? groups[0] : groups[1];
            g.items.push(p);
          });
          
          // 当前预设所在分组默认展开，其他分组默认折叠
          groups.forEach(function (g) {
            var hasCurrent = g.items.some(function (p) { return p.id === activeId; });
            g.collapsed = !hasCurrent;
          });
          
          // 渲染每个分组
          groups.forEach(function (g) {
            if (!g.items.length) return;
            
            // 组头
            var gHead = document.createElement('div');
            gHead.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);font-weight:600;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);user-select:none';
            gHead.innerHTML = '<span style="font-size:10px;display:inline-block;transition:transform .15s;' + (g.collapsed ? '' : 'transform:rotate(90deg);') + '">▶</span><span style="flex:1">' + esc(g.label) + '</span><span style="font-size:10px;color:var(--dsw-alias-label-tertiary,#888)">' + g.items.length + ' 个</span>';
            gHead.addEventListener('click', function (e) {
              e.stopPropagation();
              g.collapsed = !g.collapsed;
              var content = gHead.nextElementSibling;
              if (content) {
                content.style.display = g.collapsed ? 'none' : 'block';
                var arrow = gHead.querySelector('span:first-child');
                if (arrow) arrow.style.transform = g.collapsed ? '' : 'rotate(90deg)';
              }
            });
            presetPanel.appendChild(gHead);
            
            // 组内容
            var gContent = document.createElement('div');
            gContent.style.display = g.collapsed ? 'none' : 'block';
            
            g.items.forEach(function (p) {
              var isActive = p.id === activeId;
              var item = document.createElement('div');
              item.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;font-size:13px;flex-direction:column;align-items:stretch;' + (isActive ? 'background:rgba(59,127,240,0.15);color:#3b7ff0;font-weight:600;' : '');
              var pName = esc(p.name || '');
              var pMeta = '';
              if (p.displayNames && p.displayNames.length) pMeta += '🎭' + esc(p.displayNames.join('、'));
              if (typeof p.wbCount === 'number') pMeta += ' 📚' + p.wbCount + '本';
              if (typeof p.modCount === 'number') pMeta += ' ⚙️' + p.modCount + '模块';
              if (!pMeta && typeof p.cardChars === 'number') pMeta = '📄' + p.cardChars + '字';
              item.innerHTML = '<div style="display:flex;align-items:center;gap:6px"><span style="width:16px;flex:0 0 auto;text-align:center">' + (isActive ? '✓' : '') + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + pName + '</span></div>' + (pMeta ? '<div style="font-size:10px;color:var(--dsw-alias-label-tertiary,#999);padding-left:22px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + pMeta + '</div>' : '');
              item.addEventListener('click', function (e) {
                e.stopPropagation();
                // 触发切换
                presetLabel.textContent = p.name;
                presetLabel.dataset.presetId = p.id;
                presetPanel.style.display = 'none';
                // 调用原来的切换逻辑
                switchSessionPreset(p.id, p.name);
              });
              item.addEventListener('mouseenter', function () { if (!isActive) item.style.background = 'rgba(255,255,255,0.06)'; });
              item.addEventListener('mouseleave', function () { if (!isActive) item.style.background = ''; });
              gContent.appendChild(item);
            });

            presetPanel.appendChild(gContent);
          });
          
          // 如果没有预设
          if (!(data.presets || []).length) {
            var empty = document.createElement('div');
            empty.style.cssText = 'padding:14px 10px;text-align:center;color:var(--dsw-alias-label-tertiary,#666);font-size:12px';
            empty.textContent = '暂无预设';
            presetPanel.appendChild(empty);
          }
          
          var sidDisplay = ''; // 酒馆面板不再依赖会话ID
            // 计算详细信息
            var charCount2 = state.characters.length;
            var wbCount2 = state.worldbooks.length;
            var wbEntries2 = state.worldbooks.reduce(function(sum, wb) { return sum + (wb.entries ? wb.entries.length : 0); }, 0);
            var wbEnabled2 = state.worldbooks.reduce(function(sum, wb) { return sum + ((wb.entries || []).filter(function(e) { return e.enabled !== false; }).length); }, 0);
            var presetCount2 = state.presets.length;
            var presetEnabled2 = state.presets.reduce(function(sum, p) { return sum + ((p.modules || []).filter(function(m) { return m.enabled !== false; }).length); }, 0);
            presetStatus.innerHTML = '✅ 当前编辑：' + esc(currentPreset ? currentPreset.name : '默认预设') + '　|　共 ' + (data.presets || []).length + ' 个预设可选<br><span style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999)">🎭 角色卡：' + charCount2 + ' 个 | 📚 世界书：' + wbCount2 + ' 本（' + wbEntries2 + ' 条，启用 ' + wbEnabled2 + ' 条）| ⚙️ 预设：' + presetCount2 + ' 个（启用 ' + presetEnabled2 + ' 条）</span>';
          presetStatus.style.color = '#27ae60';
        }).catch(function () {
          presetStatus.textContent = '❌ 加载预设失败，请刷新页面';
          presetStatus.style.color = '#e74c3c';
        });
      }
      
      // 切换会话预设的函数
      function switchSessionPreset(presetId, presetName) {
        if (!presetId) return;
        if (presetId === 'default') {
          presetStatus.innerHTML = '⚠️ <span style="color:#f39c12">当前是「默认预设」，所有未启用白名单的会话共用此预设。修改会影响所有未启用的会话！</span>';
          presetStatus.style.color = '#f39c12';
        } else {
          presetStatus.textContent = '⏳ 切换预设中…';
          presetStatus.style.color = '#f39c12';
        }
        // ★ 统一：切换预设时同步到后端（bindings + DSH 会话事件），三处选择保持一致
        var curSid = (function () {
          try { return getCurrentSessionId(); } catch (e) { return ''; }
        })();
        if (curSid) {
          fetch('/api/tavern/bind-preset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: curSid, presetId: presetId })
          }).then(function (r) { return r.json(); }).then(function (bd) {
            if (bd.ok && presetId !== 'default') {
              if (bd.started) {
                // 会话已开始：角色卡本体被 DSH 锁定，只能切世界书/记忆/关系网（酒馆注入部分）
                presetStatus.innerHTML = '⚠️ <span style="color:#f39c12">已切换但注意：当前会话<b>已开始</b>，角色卡本体（agent 预设）已被锁定。<br>本次切换仅让<b>世界书/记忆/关系网</b>跟随「' + esc(presetName || presetId) + '」；如需完整的「' + esc(presetName || presetId) + '」角色卡，请<b>新开会话</b>并在顶部选择该预设。</span>';
                presetStatus.style.color = '#f39c12';
              } else {
                presetStatus.textContent = '✅ 已切换并绑定会话：' + (presetName || bd.presetName || presetId);
                presetStatus.style.color = '#27ae60';
              }
            }
          }).catch(function () {});
        }
        setActivePresetId(presetId);
        if (presetId !== 'default') {
          presetStatus.textContent = 'OK switched to: ' + (presetName || presetId);
          presetStatus.style.color = '#27ae60';
        }
        loadCurrent(presetId);
        loadWb(presetId);
        // notify floating panel/entry
        try { document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: presetId, presetName: presetName || presetId } })); } catch(e) {}
      }

      // 🤖 Agent 预设管理（搜索 / 批量删除 DSH 预设）整段删除：
      //   卡片 markup 早已注释掉（用户确认不需要这个功能），只剩这段不可达的代码。
      //   删除后 #tavern-agent-preset-search / -list / -batch-del 这 3 个 id 不再被引用。


        // ⚡ 一键切换到同名 Agent 预设（按钮已移除，功能已废弃）


      // 自定义下拉框展开/收起
      var presetBtn = document.getElementById('tavern-session-preset-btn');
      var presetPanel = document.getElementById('tavern-session-preset-panel');
      if (presetBtn && presetPanel) {
        presetBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          presetPanel.style.display = presetPanel.style.display === 'block' ? 'none' : 'block';
        });
        // 点击外部收起
        document.addEventListener('click', function (e) {
          if (!presetPanel.contains(e.target) && !presetBtn.contains(e.target)) {
            presetPanel.style.display = 'none';
          }
        });
      }
      
      // sessionPresetSelect.addEventListener('change' (已改用自定义下拉框), function () {
//         var sid = getCurrentSessionId();
//         var presetId = (document.getElementById('tavern-session-preset-label')?.dataset?.presetId || '');
//         if (!presetId) return;
        // 如果选择了默认预设，显示提示
//         if (presetId === 'default') {
//           presetStatus.innerHTML = '⚠️ <span style="color:#f39c12">当前是「默认预设」，所有未启用白名单的会话共用此预设。修改会影响所有未启用的会话！</span>';
//           presetStatus.style.color = '#f39c12';
//         } else {
//           presetStatus.textContent = '⏳ 切换预设中…';
//           presetStatus.style.color = '#f39c12';
//         }
//         fetch('/api/tavern/bind-preset', {
//           method: 'POST', headers: { 'content-type': 'application/json' },
//           body: JSON.stringify({ sessionId: sid, presetId: presetId })
//         }).then(function (r) { return r.json(); }).then(function (data) {
//           if (data.ok) {
//             if (presetId !== 'default') {
//               presetStatus.textContent = '✅ 已切换到：' + (data.presetName || presetId);
//               presetStatus.style.color = '#27ae60';
//             }
//             loadCurrent();
//             loadWb();
//           } else {
//             presetStatus.textContent = '❌ 切换失败：' + (data.error || '未知错误');
//             presetStatus.style.color = '#e74c3c';
//           }
//         }).catch(function () {
//           presetStatus.textContent = '❌ 切换失败，网络错误';
//           presetStatus.style.color = '#e74c3c';
//         });
//       });

      container.querySelector('#tavern-preset-new').addEventListener('click', async function () {
        // 用会话标题作为默认预设名
        var defaultName = getSessionTitleFromDOM() || '新预设';
        var name = await showPrompt('新预设名称：', defaultName);
        if (!name || !name.trim()) return;
        var sid = getCurrentSessionId();
        presetStatus.textContent = '⏳ 创建预设中…';
        presetStatus.style.color = '#f39c12';
        fetch('/api/tavern/presets', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), copyFrom: '', sessionId: sid })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) {
            presetStatus.textContent = '✅ 已创建并切换到：' + (data.preset?.name || name.trim());
            presetStatus.style.color = '#27ae60';
              // 关键：新建预设后必须把本地“当前编辑预设”切到新预设，否则刷新后又会回到旧预设
              var newPresetId = (data.preset && data.preset.id) || '';
              var newPresetName = (data.preset && data.preset.name) || name.trim();
              // Bind the session as well: refreshCurrent() prefers the session
              // binding, so setting only the local id let the next refresh drag
              // the panel (and later saves) back to the previously bound preset.
              if (newPresetId && typeof bindPreset === 'function') {
                bindPreset(newPresetId, newPresetName);
              } else {
                setActivePresetId(newPresetId);
              }
              try { document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: newPresetId, presetName: newPresetName } })); } catch(e) {}

            loadSessionPresets(newPresetId);
            loadCurrent();
            loadWb();
          } else {
            presetStatus.textContent = '❌ 创建失败：' + (data.error || '未知错误');
            presetStatus.style.color = '#e74c3c';
          }
        }).catch(function () {
          presetStatus.textContent = '❌ 创建失败，网络错误';
          presetStatus.style.color = '#e74c3c';
        });
      });

      // 复制当前预设
      container.querySelector('#tavern-preset-copy').addEventListener('click', async function () {
        var presetId = (document.getElementById('tavern-session-preset-label')?.dataset?.presetId || '');
        if (!presetId) { alert('请先选择一个预设'); return; }
        var name = await showPrompt('复制预设名称：', '新预设');
        if (!name || !name.trim()) return;
        var sid = getCurrentSessionId();
        presetStatus.textContent = '⏳ 复制预设中…';
        presetStatus.style.color = '#f39c12';
        fetch('/api/tavern/presets', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), copyFrom: presetId, sessionId: sid })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) {
            presetStatus.textContent = '✅ 已复制并切换到：' + (data.preset?.name || name.trim());
            presetStatus.style.color = '#27ae60';
            var newPresetId = (data.preset && data.preset.id) || '';
            setActivePresetId(newPresetId);
            try { document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: newPresetId, presetName: data.preset?.name || name.trim() } })); } catch(e) {}
            loadSessionPresets(newPresetId);
            loadCurrent();
            loadWb();
          } else {
            presetStatus.textContent = '❌ 复制失败：' + (data.error || '未知错误');
            presetStatus.style.color = '#e74c3c';
          }
        }).catch(function () {
          presetStatus.textContent = '❌ 复制失败，网络错误';
          presetStatus.style.color = '#e74c3c';
        });
      });

      // 重命名当前预设
      container.querySelector('#tavern-preset-rename').addEventListener('click', async function () {
        var presetId = (document.getElementById('tavern-session-preset-label')?.dataset?.presetId || '');
        if (!presetId) { alert('请先选择一个预设'); return; }
        var opt = (document.getElementById('tavern-session-preset-label') || {});
        var oldName = opt ? opt.textContent.replace(/（当前）$/, '').trim() : '';
        var newName = await showPrompt('重命名预设：', oldName);
        if (!newName || !newName.trim() || newName.trim() === oldName) return;
        presetStatus.textContent = '⏳ 重命名中…';
        presetStatus.style.color = '#f39c12';
        fetch('/api/tavern/preset/rename', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: presetId, name: newName.trim() })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) {
            presetStatus.textContent = '✅ 已重命名为：' + newName.trim();
            presetStatus.style.color = '#27ae60';
            loadSessionPresets();
          } else {
            presetStatus.textContent = '❌ 重命名失败：' + (data.error || '未知错误');
            presetStatus.style.color = '#e74c3c';
          }
        }).catch(function () {
          presetStatus.textContent = '❌ 重命名失败，网络错误';
          presetStatus.style.color = '#e74c3c';
        });
      });

      container.querySelector('#tavern-preset-del').addEventListener('click', async function () {
        var presetId = (document.getElementById('tavern-session-preset-label')?.dataset?.presetId || '');
        var presetName = (document.getElementById('tavern-session-preset-label') || {})?.textContent || presetId;
        if (!presetId) { alert('没有可删除的预设'); return; }
        if (!await showConfirm('确定删除预设「' + presetName + '」？删除后无法恢复。')) return;
        presetStatus.textContent = '⏳ 删除预设中…';
        presetStatus.style.color = '#f39c12';
        fetch('/api/tavern/preset/delete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: presetId })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) {
            presetStatus.textContent = '✅ 已删除预设，正在切换…';
            presetStatus.style.color = '#27ae60';
            // 重新加载预设列表
            loadSessionPresets().then(function () {
              // ★ 删掉的若是本会话正在用的预设，会话 binding 就会指向一个已不存在的 id
              //   （下一轮注入静默变空）。所以删完立刻绑到面板上仍存在的那个预设。
              //   旧代码读的是已删除的 `#tavern-session-preset` 下拉框（永远 null ⇒ 点击抛异常），
              //   改用面板自己的 `state.presets` / `getActivePresetId()` 取同一个值。
              var rebindId = getActivePresetId();
              var rebindName = '';
              if (state.presets && state.presets.length) {
                var idx = state.activePresetIdx >= 0 && state.activePresetIdx < state.presets.length ? state.activePresetIdx : 0;
                var p = state.presets[idx];
                if (p) { rebindId = p.id || rebindId; rebindName = p.name || ''; }
              }
              if (rebindId) {
                fetch('/api/tavern/bind-preset', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: getCurrentSessionId(), presetId: rebindId })
                }).then(function () {
                  loadCurrent();
                  loadWb();
                  presetStatus.textContent = '✅ 已删除并切换到：' + (rebindName || rebindId);
                  presetStatus.style.color = '#27ae60';
                });
              } else {
                presetStatus.textContent = '✅ 已删除预设';
                presetStatus.style.color = '#27ae60';
              }
            });
          } else {
            presetStatus.textContent = '❌ 删除失败：' + (data.error || '未知错误');
            presetStatus.style.color = '#e74c3c';
          }
        }).catch(function () {
          presetStatus.textContent = '❌ 删除失败，网络错误';
          presetStatus.style.color = '#e74c3c';
        });
      });

      // ── 白名单开关已移除（靠 Agent 预设实现注入）──

      // ── 成人模式开关 ──
      // （已删除）NSFW 开关：服务端 `tavern:nsfw` 破限段已整段移除，这里的状态查询与
      //   变更处理器一并删除（否则会留一个永远查不到元素、点了也没反应的死开关）。

      // （已移除）通用预设增强层（preset-forge）：运行时开关 + 套用模块包按钮
      //   两条界面入口都已按用户要求删除（见 panelHTML 里的说明）。

      // ── P0-3b：预设真名 ─────────────────────────────────────────
      // 问题现场：presets.json 里 `preset-fixture-a3` 的 name 是「示例预设」，
      //   真实内容却是「示例卡」（description 里写着 `_示例卡2`）。只显示 name ⇒
      //   用户**根本看不出自己绑了什么** —— 这就是本次事故「看不出来」的一半根因。
      // 规则：name 在前（它是面板/顶部选择器显示的名），后面跟真实身份线索：
      //   ① description（预设文件写的，属**不可信外部文本**：拼 HTML 前必须 esc，
      //      能走 textContent 就走 textContent）；
      //   ② description 为空时退到后端 /api/tavern/presets 已给的构成信息
      //      （角色卡真名 displayNames + 世界书本数 + 模块数）。
      function presetIdentityClue(p) {
        if (!p) return '';
        var raw = String(p.description || '').replace(/\s*[|｜]\s*最后更新[：:][^|｜]*\s*$/, '').trim();
        if (!raw) {
          var bits = [];
          if (p.displayNames && p.displayNames.length) bits.push('🎭 ' + p.displayNames.join('、'));
          if (typeof p.wbCount === 'number') bits.push('📚 ' + p.wbCount + ' 本世界书');
          if (typeof p.modCount === 'number') bits.push('⚙️ ' + p.modCount + ' 模块');
          raw = bits.join(' | ');
        }
        // 截断到合理长度：线索是给人扫一眼用的，别把整条 description 糊满面板
        return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
      }
      function presetIdentityText(p) {
        if (!p) return '';
        var name = String(p.name || p.id || '');
        var clue = presetIdentityClue(p);
        return clue ? name + '  ⚠️ ' + clue : name;
      }

      // ── P0-3a：当前会话绑定（三态）区块 ──────────────────────────────
      // 三个必须分得开的概念（混在一起就是本次事故的根源）：
      //   ① 当前会话绑定：会话权威值，来自 GET /api/tavern/sessions 的 boundPreset。
      //      决定这一轮注入谁的卡 —— 只有「解绑」「应用到当前会话」能改它。
      //   ② 应用到当前会话：真写 binding（POST /api/tavern/bind-preset {sessionId, presetId}）。
      //   ③ 换绑并仅对新会话生效：只改 UI 草稿（下次新会话预选），
      //      **绝不写当前会话 binding**，改完必须明确告诉用户「新会话才生效」。
      // ⚠ 所有请求都 catch：面板绝不白屏，失败要在 #tavern-binding-status 说人话。
      //
      // ⚠ 已知后端缺口（P0-3 报告已提出，此处只做兼容不自行补）：
      //   /api/tavern/sessions 的 boundPreset 把 legacy / none 一并展平成 'default'，
      //   且**不带** bindingMode / bindingSource ⇒ 面板无法区分「未绑定」与「绑到 default」，
      //   也无法显示「面板绑定 / 顶部选择」。代码按「字段有就渲染、没有就说明未提供」处理，
      //   后端补上 bindingMode / bindingSource 后无需再改前端。
      (function initBindingPanel() {
        var elCurrent = container.querySelector('#tavern-binding-current');
        var elSource = container.querySelector('#tavern-binding-source');
        var elLegacy = container.querySelector('#tavern-binding-legacy');
        var elUnbind = container.querySelector('#tavern-binding-unbind');
        var elApply = container.querySelector('#tavern-binding-apply-current');
        var elNext = container.querySelector('#tavern-binding-new-session');
        var elNextSel = container.querySelector('#tavern-binding-next-select');
        var elDeclareStatus = container.querySelector('#tavern-declare-status');
        var elDeclareHint = container.querySelector('#tavern-declare-hint');
        var elDeclareApply = container.querySelector('#tavern-declare-apply');
        var elDeclareBundle = container.querySelector('#tavern-declare-bundle');
        var elDeclareOff = container.querySelector('#tavern-declare-off');

        // ── 预设声明：状态读取 + 两个按钮 ──────────────────────────
        // 语义：off = 一个字节都不碰用户配置（出厂）；patch = 维护 profile 补丁层里的受管块；
        //       bundle = 生成 DSH bundle 交 plugin_manager 安装。
        // 两个按钮都**先 dry-run 再确认**：写盘前把目标文件、字节数、是否替换讲清楚。
        function declareSetHint(text) {
          if (elDeclareHint) elDeclareHint.textContent = String(text || '');
        }
        /**
         * 刷新声明状态。
         *
         * ⚠️ 只写**状态行**，绝不碰 hint 行：hint 是「刚做完一件事」的结果
         * （写入后的**备份路径**、bundle 的**安装命令**、错误原因）——
         * 之前这里顺手把"名册里还缺 X"塞进 hint，结果刚写完的成功提示（含备份路径）
         * 会被紧接着的状态刷新**覆盖掉**，用户就拿不到回滚要用的路径了。
         * 名册缺失的信息本来就写在状态行里（"缺酒馆预设 N 个"）。
         */
        async function loadDeclareStatus() {
          if (!elDeclareStatus) return;
          try {
            var r = await fetch('/api/tavern/preset-declarations');
            var d = await r.json();
            if (!d || !d.ok) throw new Error((d && d.error) || '读取失败');
            var mode = String(d.mode || 'off');
            var roster = Array.isArray(d.roster) ? d.roster : null;
            var missing = Array.isArray(d.missingFromRoster) ? d.missingFromRoster : null;
            var modeText = mode === 'patch' ? '已声明（补丁层）' : (mode === 'bundle' ? '已生成 bundle' : '未声明');
            var extra = roster
              ? '；名册 ' + roster.length + ' 个' + (missing && missing.length ? '，缺酒馆预设 ' + missing.length + ' 个（重启 DSH 后生效）' : '，酒馆预设已在名册里')
              : '；名册读不到（DSH 未提供该服务）';
            elDeclareStatus.textContent = modeText + extra;
          } catch (e) {
            if (elDeclareStatus) elDeclareStatus.textContent = '读取失败：' + ((e && e.message) || e);
          }
        }
        /** 先 dry-run 拿到预览（目标文件/字节数/是否替换/缺失项），由调用方决定要不要写。 */
        async function declarePreview() {
          var r = await fetch('/api/tavern/preset-declarations');
          var d = await r.json();
          if (!d || !d.ok) throw new Error((d && d.error) || '预览失败');
          return d;
        }
        function declareConfirmText(d, action) {
          var lines = []
          lines.push(action + '：' + String(d.target || '(未找到 profile)'))
          lines.push('声明 ' + (d.okCount || 0) + ' 个预设；文件 ' + (d.bytesBefore || 0) + ' → ' + (d.bytesAfter || 0) + ' 字符')
          lines.push(d.replaced ? '会整块替换已有受管块（块外内容不动）' : '会在文件末尾追加受管块（块外内容不动）')
          if (d.failed && d.failed.length) lines.push('⚠︎ 有 ' + d.failed.length + ' 个预设渲染失败，会被跳过')
          if (Array.isArray(d.missingFromRoster) && d.missingFromRoster.length) {
            lines.push('名册里还缺：' + d.missingFromRoster.join('、'))
          }
          lines.push('', '确认写入？（会自动备份，失败自动回滚）')
          return lines.join('\n')
        }
        if (elDeclareApply) {
          elDeclareApply.addEventListener('click', async function () {
            if (busy) return;
            busy = true;
            try {
              var pv = await declarePreview();
              if (!window.confirm(declareConfirmText(pv, '把酒馆预设声明为 DSH 原生预设'))) { declareSetHint('已取消（一个字节都没写）'); return; }
              var r = await fetch('/api/tavern/preset-declarations', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ apply: true, confirm: true }),
              });
              var d = await r.json();
              if (!d || !d.ok) throw new Error((d && d.error) || '写入失败');
              declareSetHint('✅ 已写入（' + (d.bytesAfter || 0) + ' 字符' + (d.backupPath ? '，备份：' + d.backupPath : '') + '）—— 重启 DSH 后顶部选择器里就能选到酒馆预设');
              await loadDeclareStatus();
            } catch (e) {
              declareSetHint('❌ ' + ((e && e.message) || e));
            } finally { busy = false }
          });
        }
        if (elDeclareBundle) {
          elDeclareBundle.addEventListener('click', async function () {
            if (busy) return;
            busy = true;
            try {
              var r = await fetch('/api/tavern/preset-bundle', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ apply: true, confirm: true }),
              });
              var d = await r.json();
              if (!d || !d.ok) throw new Error((d && d.error) || '生成失败');
              declareSetHint('✅ 已生成：' + d.bundleDir + ' —— 用 plugin_manager 安装：' + d.installHint);
              await loadDeclareStatus();
            } catch (e) {
              declareSetHint('❌ ' + ((e && e.message) || e));
            } finally { busy = false }
          });
        }
        if (elDeclareOff) {
          elDeclareOff.addEventListener('click', async function () {
            if (busy) return;
            if (!window.confirm('撤下声明：把 DSH 补丁层里的受管块整块摘掉（块外内容不动），并关掉自动同步。继续？')) return;
            busy = true;
            try {
              var r = await fetch('/api/tavern/preset-declarations', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ remove: true, confirm: true }),
              });
              var d = await r.json();
              if (!d || !d.ok) throw new Error((d && d.error) || '撤下失败');
              declareSetHint('已撤下（备份：' + (d.backupPath || '无') + '）。重启 DSH 后顶部选择器里不再有酒馆预设。');
              await loadDeclareStatus();
            } catch (e) {
              declareSetHint('❌ ' + ((e && e.message) || e));
            } finally { busy = false }
          });
        }
        loadDeclareStatus();
        var elStatus = container.querySelector('#tavern-binding-status');
        if (!elStatus) return;

        var bound = { sessionId: '', presetId: '', mode: '', source: '', known: false, failed: false };
        var presetList = [];
        var draftNextId = '';
        var busy = false;

        function curSid() {
          try { return (typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : '') || ''; } catch (e) { return ''; }
        }
        function setStatus(text, kind) {
          elStatus.textContent = String(text || '');
          try { elStatus.style.color = kind === 'err' ? '#e74c3c' : (kind === 'warn' ? '#f39c12' : '#27ae60'); } catch (e) {}
        }
        /**
         * 预设查找：认 id（目录名）/ presetId（酒馆注册表 id）/ dir 三种写法。
         * 实现就是顶层的 matchPresetInList（见那里的说明：为什么必须放在外层）。
         * @param {string} id
         * @returns {object|null}
         */
        function findPreset(id) {
          return matchPresetInList(presetList, id);
        }
        // 来源标签：后端没给就**不编**，如实说「未提供」（别把 legacy 说成已生效）
        function sourceLabel() {
          if (bound.mode === 'legacy' || bound.source === 'legacy') return '遗留(待确认)';
          if (bound.source === 'top-select') return '顶部选择';
          if (bound.source === 'panel') return '面板绑定';
          if (bound.mode === 'none') return '未绑定';
          return '';
        }
        /**
         * 把「会话权威」（后端现算的 authoritativePresetId/Source）折算成面板的显示三件套。
         * 为什么要它：在后端现算之前，面板只看酒馆账本 —— 用户在**聊天顶部**给会话选的卡
         * 不在账本里，于是顶部明明选了酒馆卡，面板却显示「未绑定」（编造状态）。
         * 这里的权威来源是 DSH 的原生投影/事件流，比账本更靠前。
         * @param {object} mine /api/tavern/sessions 里本会话那一行
         * @returns {{presetId:string, mode:string, source:string}|null} 折算结果；无权威则不折算
         */
        function authoritativeFields(mine) {
          var authId = String((mine && mine.authoritativePresetId) || '');
          if (!authId) return null;
          var src = String((mine && mine.authoritativeSource) || '');
          var source = (src === 'native' || src === 'explicit') ? 'top-select'
            : (src === 'binding' ? 'panel' : src);
          return {
            presetId: authId === 'default' ? '' : authId,
            mode: authId === 'default' ? 'none' : 'preset',
            source: source,
          };
        }

        function render() {
          if (elCurrent) {
            // ⚠ 读取失败时**不许**显示成「未绑定」—— 那是编造状态，比空白更危险
            if (!bound.known) elCurrent.textContent = '读取中…';
            else if (!bound.sessionId) elCurrent.textContent = '未检测到会话';
            else if (bound.failed) elCurrent.textContent = '读取失败（未知）';
            else if (!bound.presetId) elCurrent.textContent = '未绑定（跟随会话出生默认值）';
            else {
              var p = findPreset(bound.presetId);
              // ★ textContent 赋值：description 是外部文本，绝不拼 innerHTML
              elCurrent.textContent = p ? presetIdentityText(p) : (bound.presetId + '（该预设已不存在，绑定会 fail-closed）');
            }
          }
          if (elSource) {
            var lbl = sourceLabel();
            elSource.textContent = lbl ? ('来源：' + lbl) : '来源：后端未提供来源信息';
          }
          if (elLegacy) {
            if (bound.mode === 'legacy') {
              try { elLegacy.style.display = 'block'; elLegacy.style.color = '#e74c3c'; } catch (e) {}
              elLegacy.textContent = '⚠️ 遗留绑定（未生效）：这条绑定是旧版本自动写入的，当前不会注入。请确认或解绑。';
            } else {
              try { elLegacy.style.display = 'none'; } catch (e) {}
              elLegacy.textContent = '';
            }
          }
          renderWbMode();
        }

        // ── 本会话「设定注入量」：跟随规则 / 全量 ────────────────────────
        // 语义：'full' = 这一场把启用中的世界书条目**全塞进提示词**（费 token，但确保模型
        //       一定看得到设定 —— 写高强度剧情时用）；'follow' = 跟随卡设定（按触发词只注入
        //       命中的条目）；'' = 没覆盖，看全局开关 + 卡设定。
        // 为什么放会话级：全局开关一开就是**所有**会话都费 token，没有"就这一场"的粒度。
        function renderWbMode() {
          var el = container.querySelector('#tavern-wbmode-status');
          if (!el) return;
          var ov = bound.wbOverride || '';
          var eff = bound.wbEffective || '';
          var txt;
          if (eff === 'full') txt = ov === 'full' ? '当前：💯 全量（本会话指定）' : (bound.wbInjectGlobal === 'full' ? '当前：💯 全量（全局开关）' : '当前：💯 全量（跟随卡设定）');
          else if (eff === 'keyword') txt = ov === 'follow' ? '当前：🪶 跟随规则（本会话指定）' : '当前：🪶 跟随规则（按触发词注入）';
          else txt = '当前：未知（后端未提供）';
          el.textContent = txt;
          el.style.color = eff === 'full' ? '#f39c12' : '';
        }

        function setWbMode(mode) {
          var el = container.querySelector('#tavern-wbmode-status');
          if (el) { el.textContent = '⏳ 设置中…'; el.style.color = ''; }
          fetch('/api/tavern/wb-inject-session', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: bound.sessionId || '', mode: mode })
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '设置失败');
            bound.wbOverride = d.override || '';
            bound.wbEffective = d.effective || '';
            bound.wbInjectGlobal = d.globalWbInject || 'follow';
            renderWbMode();
            return loadBinding();
          }).catch(function (e) {
            if (el) { el.textContent = '❌ ' + ((e && e.message) || e); el.style.color = '#e74c3c'; }
          });
        }
        var elWbFollow = container.querySelector('#tavern-wbmode-follow');
        if (elWbFollow) elWbFollow.addEventListener('click', function () { setWbMode('follow'); });
        var elWbFull = container.querySelector('#tavern-wbmode-full');
        if (elWbFull) elWbFull.addEventListener('click', function () { setWbMode('full'); });

        function renderNextSelect() {
          if (!elNextSel) return;
          var html = '<option value="">（不改，跟随当前绑定）</option>';
          for (var i = 0; i < presetList.length; i++) {
            var p = presetList[i];
            if (!p || !p.id) continue;
            // ★ name / description 都是外部数据 → 一律 esc 后再进 HTML
            html += '<option value="' + esc(p.id) + '"' + (p.id === draftNextId ? ' selected' : '') + '>' + esc(presetIdentityText(p)) + '</option>';
          }
          elNextSel.innerHTML = html;
        }

        async function loadPresets() {
          try {
            var r = await fetch('/api/tavern/presets');
            var d = await r.json();
            if (d && d.ok) presetList = d.presets || [];
          } catch (e) {}
          renderNextSelect();
          render();
        }

        async function loadBinding() {
          var s = curSid();
          bound.sessionId = s;
          bound.failed = false;
          if (!s) {
            bound.known = true; bound.presetId = ''; bound.mode = 'none'; bound.source = '';
            render();
            setStatus('⚠️ 未检测到当前会话（请在 DSH 里打开或新建一个会话，再回到本面板）', 'warn');
            return;
          }
          try {
            var r = await fetch('/api/tavern/sessions');
            var d = await r.json();
            if (!d || !d.ok) throw new Error((d && d.error) || '读取会话列表失败');
            var list = d.sessions || [];
            var mine = null;
            for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === s) { mine = list[i]; break; } }
            if (!mine) {
              bound.known = true; bound.presetId = ''; bound.mode = 'none'; bound.source = '';
              render();
              setStatus('⚠️ 当前会话不在会话列表里（可能刚创建），请稍后刷新', 'warn');
              return;
            }
            // ★ 会话权威：boundPreset。后端把 legacy / none 都展平成 'default' ⇒ 视为未绑定。
            var bid = String(mine.boundPreset || '');
            var mode = String(mine.bindingMode || (mine.binding && mine.binding.mode) || '');
            var src = String(mine.bindingSource || (mine.binding && mine.binding.source) || '');
            bound.presetId = (bid && bid !== 'default') ? bid : '';
            bound.mode = mode || (bound.presetId ? 'preset' : 'none');
            bound.source = src;
            // ★ 原生权威优先显示：会话当下真正生效的预设（含「在聊天顶部选的」）。
            //   拿得到就用它覆盖上面那套账本字段 —— 账本只是酒馆自己的记账，会过期。
            var auth = authoritativeFields(mine);
            if (auth) {
              bound.presetId = auth.presetId;
              bound.mode = auth.mode;
              bound.source = auth.source;
            }
            bound.known = true;
            // ★ 设定注入量（会话级覆盖 + 全局 + 卡设定的最终结果）：一律用后端的判定结果，
            //   面板不自己算 —— 算错等于骗用户"设定已经全进去了"。
            bound.wbOverride = String(mine.wbOverride || '');
            bound.wbEffective = String(mine.wbEffective || '');
            bound.wbInjectGlobal = String(mine.wbInjectGlobal || 'follow');
            setSessionBoundPresetId(bound.presetId);
            render();
            setStatus('✅ 已读取当前会话绑定', 'ok');
          } catch (e) {
            // 读取失败也不能让面板白屏：把状态说清楚，其余区块照常可用
            bound.known = true;
            bound.failed = true;
            render();
            setStatus('❌ 读取绑定失败：' + ((e && e.message) || e) + '（面板其余功能不受影响，可重试）', 'err');
          }
        }

        if (elNextSel) {
          elNextSel.addEventListener('change', function () {
            draftNextId = elNextSel.value || '';
            renderNextSelect();
          });
        }

        // ① 「解绑本会话」→ 真解绑（写 {mode:'none'}），成功后必须立刻显示为未绑定
        if (elUnbind) {
          elUnbind.addEventListener('click', async function () {
            if (busy) return;
            var s = curSid();
            if (!s) { setStatus('❌ 未检测到当前会话，无法解绑', 'err'); return; }
            busy = true;
            setStatus('⏳ 解绑中…', 'warn');
            try {
              var r = await fetch('/api/tavern/unbind-preset', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: s })
              });
              var d = await r.json();
              if (!d || !d.ok) throw new Error((d && d.error) || '服务端拒绝了解绑请求');
              bound.presetId = ''; bound.mode = 'none'; bound.source = ''; bound.known = true;
              setSessionBoundPresetId('');
              render();
              setStatus('✅ 已解绑本会话：'
                + (d.nativeOk
                  ? '已把会话原生交还给 DSH 预设「' + (d.restoredTo || '默认') + '」，顶部选择器同步显示，不再注入任何酒馆角色卡/世界书'
                  : '酒馆侧已解除绑定，不再注入任何酒馆角色卡/世界书（原生交还失败：'
                    + ((d.native && d.native.reason) || 'unknown') + '，DSH 顶部或许仍显示旧预设）'), 'ok');
            } catch (e) {
              setStatus('❌ 解绑失败：' + ((e && e.message) || e) + '（可重试）', 'err');
            }
            busy = false;
          });
        }

        // ② 「应用到当前会话」→ 真写 binding（与 ③ 是两个按钮、两种行为，不许合并）
        if (elApply) {
          elApply.addEventListener('click', async function () {
            if (busy) return;
            var pid = elNextSel ? (elNextSel.value || '') : '';
            if (!pid) { setStatus('⚠️ 请先在「下次新会话预选」里挑一个预设，再点「应用到当前会话」', 'warn'); return; }
            var s = curSid();
            if (!s) { setStatus('❌ 未检测到当前会话，无法应用', 'err'); return; }
            busy = true;
            setStatus('⏳ 应用到当前会话…', 'warn');
            try {
              var r = await fetch('/api/tavern/bind-preset', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: s, presetId: pid })
              });
              var d = await r.json();
              if (!d || !d.ok) throw new Error((d && d.error) || '服务端拒绝了绑定请求');
              bound.presetId = pid; bound.mode = 'preset'; bound.source = 'panel'; bound.known = true;
              setSessionBoundPresetId(pid);
              render();
              setStatus('✅ 已应用到当前会话：' + presetIdentityText(findPreset(pid) || { id: pid })
                + (d.nativeOk
                  // 正路：DSH 原生 agentPreset 已落到本会话（空白新会话也走这条），
                  // 顶部选择器同步显示，注入决议与隔离都以它为准。
                  ? '（已用 DSH 原生方式绑定：顶部预设选择器同步显示，本会话首条消息即带上角色卡/世界书）'
                  : (d.locked
                    ? '（会话已开跑，DSH 锁定了预设本体：本次仅世界书/记忆跟随；下个新会话可在开跑前绑定）'
                    : '（原生绑定不可用：' + ((d.native && d.native.reason) || 'unknown')
                      + '；聊天顶部选择器不会变 —— 是否注入由该会话选中的 DSH 预设决定，没选中酒馆预设就不注入）')), 'ok');
            } catch (e) {
              setStatus('❌ 应用到当前会话失败：' + ((e && e.message) || e) + '（可重试）', 'err');
            }
            busy = false;
          });
        }

        // ③ 「换绑并仅对新会话生效」→ **只改 UI 草稿**：一个网络请求都不发，
        //    当前会话的 binding 一个字节都不动，改完明确告诉用户「新会话才生效」。
        if (elNext) {
          elNext.addEventListener('click', async function () {
            var pid = elNextSel ? (elNextSel.value || '') : '';
            if (!pid) { setStatus('⚠️ 请先在「下次新会话预选」里挑一个预设', 'warn'); return; }
            draftNextId = pid;
            try { localStorage.setItem('dsh-tavern-next-session-preset', pid); } catch (e) {}
            renderNextSelect();
            setStatus('🆕 已记为「下次新会话预选」：' + presetIdentityText(findPreset(pid) || { id: pid })
              + ' —— 仅对新会话生效，当前会话绑定未改动（要立刻生效请点「应用到当前会话」）', 'ok');
          });
        }

        // 浮动面板/别处改了预设 → 这里跟着刷新，避免显示与实况不一致
        try {
          if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('tavern-preset-changed-from-float', function () { loadBinding(); });
          }
        } catch (e) {}

        (async function () { await loadPresets(); await loadBinding(); })();
      })();
      // ── P0-3 结束 ──

      // ── P0-6：生效范围傻瓜式面板（scope-panel）────────────────────────
      // 语义：注入资格 = 显式绑定闸门（见 markup 注释）；本卡只管「生效范围」。
      // 交互：三个按钮一键 POST /api/tavern/state；chips 点 × 移除（POST 剩余数组）；
      //   每次写完直接用 POST 响应（字段齐全）刷新状态行 + chips，不二次 GET。
      // 安全纪律：路径 / 会话 id 是外部字符串，一律 textContent / createElement，
      //   绝不 innerHTML 拼接（与 binding 面板同一纪律）。
      ;(function initScopePanel() {
        var elStatus = container.querySelector('#tavern-scope2-status')
        var elBtnGlobal = container.querySelector('#tavern-scope-global')
        var elBtnSession = container.querySelector('#tavern-scope-session')
        var elBtnCwd = container.querySelector('#tavern-scope-cwd')
        var elAllowTitle = container.querySelector('#tavern-scope-allow-title')
        var elAllowChips = container.querySelector('#tavern-scope-allow-chips')
        var elDisableTitle = container.querySelector('#tavern-scope-disable-title')
        var elDisableChips = container.querySelector('#tavern-scope-disable-chips')
        // ★ P2-1：世界书注入量（wbInject 逃生阀）选择行
        var elWbInject = container.querySelector('#tavern-wb-inject')
        var elWbInjectStatus = container.querySelector('#tavern-wb-inject-status')
        if (!elStatus || !elBtnGlobal || !elBtnSession || !elBtnCwd) return

        // 最近一次 state 快照（GET / POST 响应都灌进来）：showPrompt 兜底路径
        // 需要拿「现有名单」做去重追加，GET 失败时用它兜底。
        var lastState = null

        // 写生效范围：POST 成功后用响应刷新（响应含 mode/allowCwds/allowSessions/disabledCwds）
        function postScope(patch) {
          return fetch('/api/tavern/state', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch)
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (data && data.ok) renderState(data)
            return data
          }).catch(function () {})
        }

        // 渲染一排 chips：items = [{ text, onRemove }]；全部 createElement/textContent
        function renderChips(box, items) {          while (box.firstChild) box.removeChild(box.firstChild)
          ;(items || []).forEach(function (it) {
            var chip = document.createElement('span')
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border-radius:12px;background:rgba(255,255,255,.08);font-size:12px;max-width:100%;box-sizing:border-box'
            var label = document.createElement('span')
            label.textContent = String(it.text) // ⚠ 外部字符串只进 textContent
            label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px'
            var x = document.createElement('button')
            x.type = 'button'
            x.textContent = '×'
            x.title = '移除'
            x.style.cssText = 'border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;font-size:14px;line-height:1;padding:0 4px'
            x.addEventListener('click', it.onRemove)
            chip.appendChild(label); chip.appendChild(x)
            box.appendChild(chip)
          })
        }

        // 状态行三形态 + chips 按模式显示
        function renderState(s) {
          if (!s || !s.ok) return
          lastState = s
          var mode = s.mode || 'global'
          var allowCwds = s.allowCwds || []
          var allowSessions = s.allowSessions || []
          var disabledCwds = s.disabledCwds || []
          var isAllowlist = mode === 'allowlist'
          if (!isAllowlist) {
            elStatus.textContent = '🌍 所有会话生效中' + (disabledCwds.length ? '（已排除 ' + disabledCwds.length + ' 个目录）' : '')
            elStatus.style.color = ''
          } else if (allowSessions.length === 0 && allowCwds.length === 0) {
            elStatus.textContent = '⚠️ 还没有任何会话能用到酒馆 —— 点上面任一按钮开启'
            elStatus.style.color = '#e74c3c'
          } else {
            elStatus.textContent = '📁 白名单模式：' + allowSessions.length + ' 个会话 / ' + allowCwds.length + ' 个工作区'
            elStatus.style.color = ''
          }
          // allowlist → 显示「已放行」两名单；global → 显示「已排除」
          elAllowTitle.style.display = isAllowlist ? '' : 'none'
          elAllowChips.style.display = isAllowlist ? '' : 'none'
          elDisableTitle.style.display = isAllowlist ? 'none' : ''
          elDisableChips.style.display = isAllowlist ? 'none' : ''
          if (isAllowlist) {
            // 工作区项与会议项合并渲染，前缀区分；× 各自 POST 剩余数组
            var items = []
            allowCwds.forEach(function (c, i) {
              items.push({
                text: '📁 ' + c,
                onRemove: function () {
                  postScope({ allowCwds: allowCwds.filter(function (_, j) { return j !== i }) })
                }
              })
            })
            allowSessions.forEach(function (sid, i) {
              items.push({
                text: '💬 ' + sid,
                onRemove: function () {
                  postScope({ allowSessions: allowSessions.filter(function (_, j) { return j !== i }) })
                }
              })
            })
            renderChips(elAllowChips, items)
            renderChips(elDisableChips, [])
          } else {
            renderChips(elAllowChips, [])
            renderChips(elDisableChips, disabledCwds.map(function (c, i) {
              return {
                text: '📁 ' + c,
                onRemove: function () {
                  postScope({ disabledCwds: disabledCwds.filter(function (_, j) { return j !== i }) })
                }
              }
            }))
          }
          // ★ P2-1：同步世界书注入量选择行（初次 GET / POST 响应都走这里刷新）
          if (elWbInject) {
            var wbv = s.wbInject === 'full' ? 'full' : 'follow'
            elWbInject.value = wbv
            if (elWbInjectStatus) {
              elWbInjectStatus.textContent = wbv === 'full'
                ? '⚠️ 全量注入中（每轮塞入全部条目，费 token）'
                : '✅ 按触发词注入，省 token'
              elWbInjectStatus.style.color = wbv === 'full' ? '#e74c3c' : ''
            }
          }
        }

        // 去重追加一个值到名单并 POST（mode=allowlist；只带目标名单字段，不覆盖另一个名单）
        function addToAllowlist(field, value) {
          var s = lastState || {}
          var list = (s[field] || []).slice()
          if (list.indexOf(value) < 0) list.push(value)
          var patch = { mode: 'allowlist' }
          patch[field] = list
          postScope(patch)
        }

        // 「💬 仅当前会话」：currentSessionId 自动检测优先，取不到才 showPrompt 手输
        elBtnSession.addEventListener('click', function () {
          var fallback = function () {
            showPrompt('未检测到当前会话，请手动输入会话 ID（或先在聊天里发一条消息再试）：', '').then(function (v) {
              v = (v || '').trim()
              if (v) addToAllowlist('allowSessions', v)
            })
          }
          fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (s) {
            if (s && s.ok && s.currentSessionId) { lastState = s; addToAllowlist('allowSessions', s.currentSessionId) }
            else fallback()
          }).catch(fallback)
        })

        // 「📁 当前工作区」：currentCwd 自动检测优先，取不到才 showPrompt 手输
        elBtnCwd.addEventListener('click', function () {
          var fallback = function () {
            showPrompt('未检测到当前工作区，请手动输入工作区路径（如 C:\\Users\\xxx\\project）：', '').then(function (v) {
              v = (v || '').trim()
              if (v) addToAllowlist('allowCwds', v)
            })
          }
          fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (s) {
            if (s && s.ok && s.currentCwd) { lastState = s; addToAllowlist('allowCwds', s.currentCwd) }
            else fallback()
          }).catch(fallback)
        })

        // 「🌍 所有会话生效」：切 global（disabledCwds 保持不动，仍生效）
        elBtnGlobal.addEventListener('click', function () {
          postScope({ mode: 'global' })
        })

        // ★ P2-1：世界书注入量切换 —— POST /api/tavern/state { wbInject }，
        //   成功后 renderState（postScope 内部）用响应刷新选择框与状态行
        if (elWbInject) {
          elWbInject.addEventListener('change', function () {
            var v = elWbInject.value === 'full' ? 'full' : 'follow'
            if (elWbInjectStatus) elWbInjectStatus.textContent = '⏳ 切换中…'
            postScope({ wbInject: v })
          })
        }

        // 初次加载：GET state 刷一次状态行
        fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (s) {
          renderState(s)
        }).catch(function () {})
      })()
      // ── P0-6 结束 ──


      // ── 📌 开场白面板（把当前卡的开场白注入会话末尾）──────────────
      // 请求服务端 POST /api/tavern/greeting/insert；presetId 用面板当前激活预设
      //（getActivePresetId()），sessionId 用 DSH 权威当前会话（getCurrentSessionId()）。
      // 失败时把服务端返回的明确原因显示在状态行（找不到卡 / 会话不活跃 / 正在生成中 /
      // ★ 会话还没跑过回合…）。
      ;(function initGreetingPanel() {
        var btn = container.querySelector('#tavern-greeting-insert');
        var status = container.querySelector('#tavern-greeting-status');
        if (!btn || !status) return;
        function setStatus(msg, color) {
        // ★ 2.7.14：改 textContent —— 入参一律是纯文本（实测 5 个调用点全是字面量或 esc(...) 拼接，无标签），
        //   所以渲染结果不变；但「把入参当 HTML 写」这一类风险**结构上**消失了（原先是 param-by-callers，
        //   只能靠调用方自觉 + 证据钉住）。另一处 statusEl（全局正则面板）刻意保留 innerHTML：
        //   它有一个调用点要渲染 <br><span> 标记，改 textContent 会把标签当文字显示。
        status.textContent = msg;
        status.style.color = color || '#999';
      }
        btn.addEventListener('click', function () {
          setStatus('⏳ 注入中…');
          var sid = ''; try { sid = getCurrentSessionId() || ''; } catch (e) {}
          var pid = ''; try { pid = getActivePresetId() || ''; } catch (e) {}
          fetch('/api/tavern/greeting/insert', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sid || undefined, presetId: pid || undefined })
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.ok) {
              setStatus('✅ 已注入「' + esc(d.cardName || '') + '」的开场白（' + (d.greetingLen || 0) + ' 字，第 ' + (d.turn || '?') + ' 回合）——回到会话刷新可见', '#27ae60');
            } else if (d && d.error === 'greeting-already-present') {
              // ★ 防重复（2026-09-23）：会话里已有 source.model==='character-card' 的
              //   开场白楼（上次手动注入的）⇒ 不再叠加第二条，这里不是报错。
              setStatus('ℹ️ 本会话已有开场白，无需重复注入', '#3498db');
            } else {
              setStatus('❌ ' + esc((d && d.error) || '注入失败'), '#e74c3c');
            }
          }).catch(function (e) { setStatus('❌ ' + esc((e && e.message) || String(e)), '#e74c3c'); });
        });
      })();

      // ── 🧩 全局正则面板（等价 ST 的全局 Regex 扩展）──────────────
      // 数据源（C:\dsh-muv-engine 提供，本仓库只做 UI，不改引擎仓库）：
      //   GET  /api/muv-engine/global-regex
      //     → { ok, scripts:[{id, scriptName, findRegex, replaceString, placement, disabled, markdownOnly, promptOnly, …}] }
      //   POST /api/muv-engine/global-regex（body = ST 导出的 JSON 原样：数组 / {scripts:[…]} / {data:{extensions:{regex_scripts:[…]}}}）
      //     → { ok, added, replaced, skipped, errors:[…] }
      //   删除：优先 DELETE（body 带 id）；405/404 回落 POST {action:'delete', id}
      //   停用：POST {action:'set-disabled', id, disabled}；引擎没实现该 action → 明确提示"删除+重导"，不静默假装成功
      // 降级铁律：接口探测失败 → 整卡显示降级提示，导入/列表全部拒绝执行，绝不报错崩面板。
      // 懒加载：清单 >50 条先渲染 50 条，点「显示更多」追加。
      (function initGlobalRegexPanel() {
        var listEl = container.querySelector('#tavern-gregex-list');
        var statusEl = container.querySelector('#tavern-gregex-status');
        var previewEl = container.querySelector('#tavern-gregex-preview');
        var pasteEl = container.querySelector('#tavern-gregex-paste');
        var dropEl = container.querySelector('#tavern-gregex-drop');
        var fileEl = container.querySelector('#tavern-gregex-file');
        if (!listEl || !statusEl) return;

        var API = '/api/muv-engine/global-regex';
        var PAGE = 50;               // 懒加载页大小
        var apiAvailable = null;     // null=未探测 / true=可用 / false=不可用（降级中）
        var scripts = [];            // 引擎当前清单（每条原样保存）
        var shownCount = PAGE;       // 当前已渲染条数
        var pendingPayload = null;   // 解析好的导入载荷（原样透传给引擎）

        function setStatus(msg, color) {
          statusEl.innerHTML = msg;
          statusEl.style.color = color || '#999';
        }
        // 属性值转义：esc 之外还要吃掉双引号（★ 函数式替换，铁律见 docs/04 A 条）
        function escAttr(s) {
          // ★ 2.6.1（issue #14）：原实现 esc(String(s)).replace(/"/g, …) 是**空操作**
          //   —— esc 已经把 " 换成 &quot; 了，那行永不命中；且照样不管单引号。
          //   esc 现在同时吃掉 " 与 '，属性位置直接复用即可。
          return esc(String(s));
        }

        // placement 简写：ST 的 placement 是数组 [0=用户输入前, 1=AI 输出后]（也有单数字形态）
        function placeShorthand(p) {
          if (Array.isArray(p)) {
            var has0 = p.indexOf(0) >= 0, has1 = p.indexOf(1) >= 0;
            if (has0 && has1) return '前后';
            if (has0) return '前';
            if (has1) return '后';
            return '?';
          }
          if (p === 0) return '前';
          if (p === 1) return '后';
          return (p === undefined || p === null || p === '') ? '?' : String(p);
        }

        function findScript(id) {
          for (var i = 0; i < scripts.length; i++) {
            if (String(scripts[i].id) === String(id)) return scripts[i];
          }
          return null;
        }

        // ── 降级：接口不可用时整卡提示，不许崩 ──
        function degrade() {
          apiAvailable = false;
          pendingPayload = null;
          setStatus('⚠️ 引擎未提供全局正则接口（需更新/重启 dsh-muv-engine）', '#e67e22');
          listEl.innerHTML = '<div style="color:#e67e22;padding:8px;font-size:12px">引擎未提供全局正则接口（需更新/重启 dsh-muv-engine）—— 导入与清单功能暂不可用</div>';
          if (previewEl) previewEl.innerHTML = '';
        }

        // ── 探测 + 拉清单（quiet=true 时不覆盖状态栏 —— 供导入/删除成功后静默刷新）──
        function probe(quiet) {
          if (!quiet) setStatus('⏳ 正在探测全局正则接口…', '#f39c12');
          fetch(API).then(function (r) {
            if (!r || r.ok === false) throw new Error('global-regex-unavailable');
            return r.json();
          }).then(function (d) {
            if (!d || !d.ok || !Array.isArray(d.scripts)) throw new Error('global-regex-unavailable');
            apiAvailable = true;
            scripts = d.scripts;
            shownCount = PAGE;
            renderList();
            if (!quiet) setStatus('✅ 已连接全局正则注册表（' + scripts.length + ' 条脚本）', '#27ae60');
          }).catch(function () { degrade(); });
        }

        // ── 导入解析：认三种形态，载荷原样保留（透传给引擎，不改形状）──
        function parseImport(text) {
          var parsed;
          try { parsed = JSON.parse(text); } catch (e) { throw new Error('不是合法 JSON：' + (e.message || String(e))); }
          var arr = null;
          if (Array.isArray(parsed)) arr = parsed;
          else if (parsed && Array.isArray(parsed.scripts)) arr = parsed.scripts;
          else if (parsed && parsed.data && parsed.data.extensions && Array.isArray(parsed.data.extensions.regex_scripts)) arr = parsed.data.extensions.regex_scripts;
          else throw new Error('认不出脚本形态（需为数组 / {scripts:[…]} / {data:{extensions:{regex_scripts:[…]}}}）');
          var names = [];
          for (var i = 0; i < arr.length && names.length < 5; i++) {
            var nm = arr[i] && (arr[i].scriptName || arr[i].name || arr[i].id);
            if (nm != null) names.push(String(nm));
          }
          return { payload: parsed, count: arr.length, names: names };
        }

        function renderPreview() {
          if (!previewEl) return;
          var text = pasteEl ? String(pasteEl.value || '').trim() : '';
          if (!text) { previewEl.innerHTML = ''; pendingPayload = null; return; }
          try {
            var p = parseImport(text);
            pendingPayload = p.payload;
            previewEl.innerHTML = '<div style="font-size:11px;color:#3498db">📄 解析预览：共 ' + p.count + ' 条脚本'
              + (p.count ? '，前 5 个：' + esc(p.names.join('、')) : '')
              + '（点「📥 导入」确认写入引擎）</div>';
          } catch (e) {
            pendingPayload = null;
            previewEl.innerHTML = '<div style="font-size:11px;color:#e74c3c">❌ ' + esc(e.message || String(e)) + '</div>';
          }
        }

        function doImport() {
          if (apiAvailable === false) { degrade(); return; }
          renderPreview();
          if (!pendingPayload) { setStatus('❌ 没有可导入的内容（先粘贴 JSON 或拖入文件）', '#e74c3c'); return; }
          setStatus('⏳ 正在导入…', '#f39c12');
          // ★ 原样透传：body 就是解析出的 JSON 本体（数组 / {scripts} / {data…} 三形态不改形状）
          fetch(API, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pendingPayload)
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '导入失败');
            var errs = Array.isArray(d.errors) ? d.errors : [];
            var html = '✅ 导入完成：新增 ' + (d.added || 0) + ' · 替换 ' + (d.replaced || 0) + ' · 跳过 ' + (d.skipped || 0);
            for (var i = 0; i < errs.length && i < 3; i++) {
              html += '<br><span style="font-size:11px;color:#e74c3c">· ' + esc(String((errs[i] && errs[i].error) || errs[i])) + '</span>';
            }
            if (errs.length > 3) html += '<br><span style="font-size:11px;color:var(--dsw-alias-label-tertiary,#999)">…共 ' + errs.length + ' 条错误</span>';
            setStatus(html, errs.length ? '#e67e22' : '#27ae60');
            pendingPayload = null;
            if (pasteEl) pasteEl.value = '';
            if (previewEl) previewEl.innerHTML = '';
            probe(true); // 以引擎实况重拉清单（静默，不覆盖导入统计）
          }).catch(function (e) {
            setStatus('❌ 导入失败：' + esc(e.message || String(e)), '#e74c3c');
          });
        }

        // ── 清单渲染（懒加载）──
        function rowHtml(s) {
          var id = String(s.id == null ? '' : s.id);
          var name = String(s.scriptName || s.name || id || '（未命名）');
          var disabled = s.disabled === true;
          return '<div class="t-item" data-gregex-row="' + escAttr(id) + '">'
            + '<div class="t-item-row">'
            + '<button type="button" class="t-btn-secondary t-btn-sm" data-gregex-toggle="' + escAttr(id) + '" title="启用/停用该脚本（下一轮生效）">' + (disabled ? '▶ 启用' : '⏸ 停用') + '</button>'
            + '<span class="t-item-name" title="' + escAttr(name) + '">' + esc(name) + '</span>'
            + '<span style="font-size:11px;color:var(--dsw-alias-label-tertiary,#888)">placement:' + esc(placeShorthand(s.placement)) + (s.promptOnly ? ' · 仅提示词' : '') + (s.markdownOnly ? ' · 仅显示' : '') + '</span>'
            + (disabled ? '<span style="font-size:10px;color:#e67e22">已停用</span>' : '<span style="font-size:10px;color:#27ae60">启用中</span>')
            + '<button type="button" class="t-btn-secondary t-btn-sm" style="color:#e74c3c" data-gregex-del="' + escAttr(id) + '" title="删除该脚本">🗑</button>'
            + '</div></div>';
        }

        function renderList() {
          if (apiAvailable === false) { degrade(); return; }
          if (!scripts.length) {
            listEl.innerHTML = '<div style="color:var(--dsw-alias-label-tertiary,#888);padding:8px;font-size:12px">（还没有全局正则脚本 —— 粘贴 ST 导出的 JSON 或拖入 .json 文件后点「📥 导入」）</div>';
            return;
          }
          var shown = scripts.slice(0, shownCount);
          var html = '';
          for (var i = 0; i < shown.length; i++) html += rowHtml(shown[i]);
          if (scripts.length > shown.length) {
            html += '<button type="button" class="t-btn-secondary t-btn-sm" data-gregex-more="1" style="margin-top:4px">显示更多（还有 ' + (scripts.length - shown.length) + ' 条）</button>';
          }
          listEl.innerHTML = html;
        }

        // 清单事件：单点委托（点击目标自带 data-* 属性，不依赖 querySelectorAll 遍历）
        listEl.addEventListener('click', function (ev) {
          var t = ev && ev.target;
          if (!t || !t.getAttribute) return;
          var delId = t.getAttribute('data-gregex-del');
          if (delId) { removeScript(delId); return; }
          var togId = t.getAttribute('data-gregex-toggle');
          if (togId) { toggleDisabled(togId); return; }
          if (t.getAttribute('data-gregex-more')) { shownCount += PAGE; renderList(); }
        });

        // ── 启用/停用：POST {action:'set-disabled', id, disabled} ──
        // 引擎没实现该 action（ok:false）→ 明确提示"删除+重导"，不静默假装成功
        function toggleDisabled(id) {
          if (apiAvailable === false) { degrade(); return; }
          var s = findScript(id);
          if (!s) return;
          var next = !(s.disabled === true);
          setStatus('⏳ 正在' + (next ? '停用' : '启用') + '…', '#f39c12');
          fetch(API, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'set-disabled', id: id, disabled: next })
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) throw new Error('engine-rejected');
            s.disabled = next;
            renderList();
            setStatus('✅ 已' + (next ? '停用' : '启用') + '「' + esc(String(s.scriptName || id)) + '」（渲染下一轮生效）', '#27ae60');
          }).catch(function () {
            setStatus('⚠️ 引擎未支持停用接口（action:set-disabled 被拒绝）—— 请删除该脚本后，在导入文件里改好 disabled 字段再重新导入', '#e67e22');
          });
        }

        // ── 删除：优先 DELETE，405/404 回落 POST {action:'delete', id} ──
        function removeScript(id) {
          if (apiAvailable === false) { degrade(); return; }
          var s = findScript(id);
          function doDelete() {
            setStatus('⏳ 正在删除…', '#f39c12');
            fetch(API, {
              method: 'DELETE', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: id })
            }).then(function (r) {
              if (r && (r.status === 405 || r.status === 404)) return { __fallback: true };
              return r.json();
            }).then(function (d) {
              if (d && d.__fallback) {
                return fetch(API, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'delete', id: id })
                }).then(function (r2) { return r2.json(); });
              }
              return d;
            }).then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '删除失败');
              setStatus('✅ 已删除' + (s && s.scriptName ? '「' + esc(String(s.scriptName)) + '」' : '') + '（渲染下一轮生效）', '#27ae60');
              probe(true);
            }).catch(function (e) {
              setStatus('❌ 删除失败：' + esc(e.message || String(e)), '#e74c3c');
            });
          }
          if (typeof showConfirm === 'function') {
            showConfirm('确定删除这条全局正则脚本？删除后可用导入恢复。').then(function (yes) { if (yes) doDelete(); });
          } else doDelete();
        }

        // ── 入口绑定 ──
        var refreshBtn = container.querySelector('#tavern-gregex-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', function () { if (apiAvailable === false) { probe(); return; } probe(); });

        var importBtn = container.querySelector('#tavern-gregex-import');
        if (importBtn) importBtn.addEventListener('click', doImport);

        if (pasteEl) pasteEl.addEventListener('input', renderPreview);

        var chooseBtn = container.querySelector('#tavern-gregex-choose');
        if (chooseBtn && fileEl) chooseBtn.addEventListener('click', function () { if (fileEl.click) fileEl.click(); });

        // 文件（选择 / 拖入）→ 读文本 → 填进粘贴框 → 自动预览
        function readFile(f) {
          if (!f) return;
          var rd = new FileReader();
          rd.onload = function () {
            if (pasteEl) pasteEl.value = String(rd.result || '');
            renderPreview();
          };
          rd.readAsText(f);
        }
        if (fileEl) fileEl.addEventListener('change', function () {
          var f = fileEl.files && fileEl.files[0];
          readFile(f);
        });
        if (dropEl) {
          dropEl.addEventListener('drop', function (ev) {
            var dt = ev && ev.dataTransfer;
            var files = dt && dt.files;
            if (files && files.length > 0) readFile(files[0]);
          });
          // 点击打开文件选择由通用 dropzone 绑定处理（#tavern-gregex-file 命名匹配），此处不重复绑
        }

        // 首次挂载自动探测一次（失败 → 降级提示，不崩）
        setTimeout(probe, 600);
      })();

      // ── 保存并关闭 ──
      container.querySelector('#tavern-inject-exit').addEventListener('click', async function () {
        var statusEl = container.querySelector('#tavern-status');
        statusEl.textContent = '⏳ 正在保存预设…';
        statusEl.style.color = '#f39c12';
        saveCurrent().then(function () {
          statusEl.textContent = '✅ 保存成功！新开会话时在顶部预设选择器选择此预设即可开始聊天。';
          statusEl.style.color = '#27ae60';
          setTimeout(function () {
            var closeBtn = document.querySelector('[class*="close"], [aria-label="关闭"], .settings-close, button[class*="close"]');
            if (closeBtn) closeBtn.click();
          }, 1000);
        }).catch(function (err) {
          statusEl.textContent = '❌ 保存失败：' + (err.message || '未知错误');
          statusEl.style.color = '#e74c3c';
        });
      });

      // 保存 / 读取
      container.querySelector('#tavern-save').addEventListener('click', saveCurrent);

      // 初始化
      renderCharacters();
      
      renderPresets();
      refreshYml();
      loadCurrent();
      loadSessionPresets();
      // refreshWhitelistStatus(); // 白名单已移除
      // refreshNsfwStatus();     // NSFW 破限段已整段移除（开关与状态查询一并删掉）
      loadSessionList();
      // 定时检测会话ID（新开会话时可能需要等一下）
      var sidCheckCount = 0;
      var sidCheckTimer = setInterval(function () {
        var sid = getCurrentSessionId();
        if (sid || sidCheckCount > 20) {
          clearInterval(sidCheckTimer);
          if (sid) {
            loadSessionPresets();
            // refreshWhitelistStatus(); // 白名单已移除
          }
        }
        sidCheckCount++;
      }, 2000);
      fetch('/api/tavern/config').then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok && data.mem) {
          var pnEl = document.getElementById('tavern-player-name'); if(pnEl) pnEl.value = data.playerName || '';
            // 反八股 / 联网的勾选框已移出本卡片（唯一控件在下方开关条，见 refreshToggleStates）
            if (typeof renderBannedTags === 'function') renderBannedTags(data.bannedWords || []);
            container.querySelector('#tavern-api-url').value = data.mem.apiUrl || '';
          container.querySelector('#tavern-api-key').value = data.mem.apiKey || '';
          container.querySelector('#tavern-api-model').value = data.mem.model || 'deepseek-chat';
          container.querySelector('#tavern-auto-enabled').checked = !!data.mem.autoEnabled;
container.querySelector('#tavern-auto-every').value = data.mem.autoEvery || 20;
var autoProg = document.getElementById('tavern-auto-progress');
if (autoProg) autoProg.textContent = '自动总结：' + (data.mem.autoEnabled ? '✅ 已开启' : '❌ 已关闭') + ' | 每 ' + (data.mem.autoEvery || 20) + ' 楼总结一次 | 已总结到第 ' + (data.mem.lastSeq || 0) + ' 楼';
          // ── DSH 连接模式 ──
          var conns = (data.dshConnections || []).filter(function (c) { return c.baseURL && c.hasKey; });
          if (!conns.length) conns = (data.dshConnections || []).filter(function (c) { return c.baseURL; });
          var connSel = container.querySelector('#tavern-dsh-conn');
          connSel.innerHTML = '';
          conns.forEach(function (c) {
            var opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name + (c.hasKey ? '（已保存密钥）' : '（未保存密钥）');
            connSel.appendChild(opt);
          });
          if (!conns.length) {
            var emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = '（未检测到 DSH 连接，请在 DSH 设置中添加）';
            connSel.appendChild(emptyOpt);
          }
          window.__TAVERN_CONNS__ = conns;
          // ── 还原模式 ──
          var useDsh = !!data.mem.useDsh;
          var dshRadio = container.querySelector('#tavern-mode-dsh');
          var manualRadio = container.querySelector('#tavern-mode-manual');
          if (useDsh) dshRadio.checked = true; else manualRadio.checked = true;
          function syncApiMode() {
            var isDsh = dshRadio.checked;
            container.querySelector('#tavern-dsh-box').style.display = isDsh ? 'block' : 'none';
            container.querySelector('#tavern-manual-box').style.display = isDsh ? 'none' : 'block';
          }
          syncApiMode();
          // ── 还原连接/模型选择 ──
          if (conns.length && data.mem.dshConnection) {
            var prevConn = data.mem.dshConnection;
            if (conns.some(function (c) { return c.id === prevConn; })) {
              connSel.value = prevConn;
            } else {
              var prevOpt = document.createElement('option');
              prevOpt.value = prevConn;
              prevOpt.textContent = prevConn + '（已在 DSH 设置中删除）';
              connSel.appendChild(prevOpt);
              connSel.value = prevConn;
            }
          }
          function fillModels() {
            var conn = conns.find(function (c) { return c.id === connSel.value; }) || conns[0];
            var modelSel = container.querySelector('#tavern-dsh-model');
            modelSel.innerHTML = '';
            var savedModel = data.mem.dshModel || '';
            var list = (conn && conn.models && conn.models.length) ? conn.models : [];
            if (!list.length) {
              var fallback = document.createElement('option');
              fallback.value = 'deepseek-chat';
              fallback.textContent = 'deepseek-chat（默认）';
              modelSel.appendChild(fallback);
              if (savedModel) { var fo = document.createElement('option'); fo.value = savedModel; fo.textContent = savedModel; modelSel.appendChild(fo); }
            } else {
              list.forEach(function (md) {
                var opt = document.createElement('option');
                opt.value = md.id;
                opt.textContent = md.name || md.id;
                modelSel.appendChild(opt);
              });
            }
            if (savedModel && list.some(function (md) { return md.id === savedModel; })) modelSel.value = savedModel;
            var kh = container.querySelector('#tavern-dsh-keyhint');
            if (kh) kh.textContent = conn ? (conn.hasKey ? '✅ 密钥已从 DSH 读取（不会显示明文）' : '⚠️ 该连接未保存 API 密钥，总结会失败') : '';
          }
          fillModels();
          connSel.addEventListener('change', fillModels);
          dshRadio.addEventListener('change', syncApiMode);
          manualRadio.addEventListener('change', syncApiMode);
        }
      }).catch(function () {});
      var initSid = getCurrentSessionId();
      // 加载记忆和关系网的函数
      function loadSessionData(sid) {
        if (!sid) return;
        fetch('/api/tavern/memory?sessionId=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (data) { if (data.ok) container.querySelector('#tavern-memory-text').value = data.memory || ''; }).catch(function () {});
        fetch('/api/tavern/relations?sessionId=' + encodeURIComponent(sid)).then(function (r) { return r.json(); }).then(function (data) { if (data.ok && data.relations) { container.querySelector('#tavern-relations-data').value = JSON.stringify(data.relations, null, 2); renderRelationsGraph(data.relations); } }).catch(function () {});
      }
      // 从后端获取会话 ID（仅作最后兜底）
      // 注意：后端 lastSessionId 是"最后运行过 agent 的会话"，不是"UI 当前激活会话"。
      // 切换会话后若新会话还没发过消息，lastSessionId 可能是旧值 → 必须先查 DSH 官方会话服务，
      // 只有 DSH 会话服务和本地探测都拿不到时才回退后端值。
      function resolveFromServer() {
        return fetch('/api/tavern/current-session').then(function (r) { return r.json(); }).then(function (data) {
          // 先查 DSH 官方会话服务（权威）
          try {
            var svc = window.__DSH_TAVERN_SESSIONS__;
            var s0 = dshMainViewSessionId(svc);
            if (s0) {
              document.documentElement.setAttribute('data-dsh-current-session', s0);
              return s0;
            }
          } catch (e) {}
          // 本地探测（crumb/data-id/属性）优先于后端
          var localNow = (function () {
            try { return getCurrentSessionId(); } catch (e) { return ''; }
          })();
          if (localNow) return 'session-' + localNow.replace(/^session-/, '');
          // 最后兜底：后端注入上下文会话
          if (data && data.ok && data.sessionId) {
            var s = 'session-' + String(data.sessionId).replace(/^session-/, '');
            document.documentElement.setAttribute('data-dsh-current-session', s);
            return s;
          }
          return '';
        }).catch(function () { return ''; });
      }
      function loadSessionDataResolved() {
        var sid = getCurrentSessionId();
        if (sid) { loadSessionData(sid); return; }
        // 本地探测不到 → 问后端拿权威会话
        resolveFromServer().then(function (serverSid) {
          if (serverSid) loadSessionData(serverSid);
          else loadSessionData(sid);
        });
      }
      if (initSid) {
        loadSessionData(initSid);
      } else {
        // 先尝试后端权威会话（解决重启后面板空白/显示为"丢失"的问题）
        setTimeout(function () { loadSessionDataResolved(); }, 300);
        // 如果获取不到 sessionId，延迟 1 秒和 3 秒后重试
        setTimeout(function () { var sid = getCurrentSessionId(); if (sid) loadSessionData(sid); }, 1000);
        setTimeout(function () { var sid = getCurrentSessionId(); if (sid) loadSessionData(sid); }, 3000);
        setTimeout(function () { var sid = getCurrentSessionId(); if (sid) loadSessionData(sid); }, 5000);
        setTimeout(function () { var sid = getCurrentSessionId(); if (sid) loadSessionData(sid); }, 10000);
        // 监听用户点击和输入，每次都尝试获取 sessionId 并加载
        var sessionDataLoaded = false;
        document.addEventListener('click', function () {
          if (sessionDataLoaded) return;
          var sid = getCurrentSessionId();
          if (sid) { sessionDataLoaded = true; loadSessionData(sid); }
          else { sessionDataLoaded = true; loadSessionDataResolved(); }
        }, true);
        document.addEventListener('input', function () {
          if (sessionDataLoaded) return;
          var sid = getCurrentSessionId();
          if (sid) { sessionDataLoaded = true; loadSessionData(sid); }
          else { sessionDataLoaded = true; loadSessionDataResolved(); }
        }, true);
      }
      var lastSid = initSid;
      var sessionPoll = setInterval(function () {
        var curSid = getCurrentSessionId();
        // 本地探测不到时，轮询后端权威会话（解决 DSH 页面无会话文本/URL 无 session 的情况）
        if (curSid) {
          if (curSid !== lastSid) {
            lastSid = curSid;
            loadCurrent();
            loadWb();
            loadSessionData(curSid);
            setTimeout(function () { 
              var sid = getCurrentSessionId(); 
              if (sid && sid === curSid) loadSessionData(sid); 
            }, 500);
            setTimeout(function () { 
              var sid = getCurrentSessionId(); 
              if (sid && sid === curSid) loadSessionData(sid); 
            }, 1500);
          }
          return;
        }
        resolveFromServer().then(function (serverSid) {
          if (!serverSid) return;
          // 只有本地探测仍然为空时才采用后端会话（避免覆盖已正确探测到的会话）
          var nowSid = getCurrentSessionId();
          var useSid = nowSid || 'session-' + serverSid.replace(/^session-/, '');
          if (useSid !== lastSid) {
            lastSid = useSid;
            loadCurrent();
            loadWb();
            loadSessionData(useSid);
          }
        }).catch(function () {});
      }, 2000);

      // ── 高级功能折叠 ──
      var advancedToggle = container.querySelector('#tavern-advanced-toggle');
      var advancedBody = container.querySelector('#tavern-advanced-body');
      var advancedArrow = container.querySelector('#tavern-advanced-arrow');
      if (advancedToggle && advancedBody) {
        advancedToggle.addEventListener('click', function () {
          var isHidden = advancedBody.style.display === 'none';
          advancedBody.style.display = isHidden ? 'block' : 'none';
          if (advancedArrow) advancedArrow.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
        });
      }

      // ── 卡片折叠功能：点击标题折叠/展开 ──
      container.querySelectorAll('.t-card').forEach(function (card) {
        var title = card.querySelector('.t-card-title');
        if (!title || title.id === 'tavern-advanced-toggle') return; // 跳过高级功能标题，它有自己的折叠逻辑
        // 添加折叠指示器
        title.style.cursor = 'pointer';
        title.style.userSelect = 'none';
        title.style.display = 'flex';
        title.style.alignItems = 'center';
        title.style.justifyContent = 'space-between';
        var indicator = document.createElement('span');
        indicator.textContent = '▼';
        indicator.style.fontSize = '10px';
        indicator.style.color = '#888';
        indicator.style.marginLeft = '8px';
        indicator.style.transition = 'transform 0.2s';
        title.appendChild(indicator);
        // 点击标题折叠/展开
        title.addEventListener('click', function (e) {
          if (e.target.closest('input, button, select, a')) return; // 点击表单元素不折叠
          var isCollapsed = card.dataset.collapsed === 'true';
          if (isCollapsed) {
            // 展开
            card.querySelectorAll(':scope > *:not(.t-card-title)').forEach(function (el) { el.style.display = ''; });
            card.dataset.collapsed = 'false';
            indicator.style.transform = 'rotate(0deg)';
          } else {
            // 折叠
            card.querySelectorAll(':scope > *:not(.t-card-title)').forEach(function (el) { el.style.display = 'none'; });
            card.dataset.collapsed = 'true';
            indicator.style.transform = 'rotate(-90deg)';
          }
        });
      });

      // ── 标签页分组：把二十来张卡片收进 4 个页签 ─────────────────────
      // 面板原来一次铺开 20+ 张卡片，重点（会话绑定 / 当前预设）会被淹掉。这里只做「搬家」：
      //   · 不改任何 markup、id 或事件绑定 —— 既有功能、既有测试锚点全都不受影响；
      //   · **认不出来的元素一律留在页签之外**，所以底部「yml 预览 / 保存预设 / 状态行」永远可见；
      //     以后新加卡片忘了登记，结果只是"没被收纳"，绝不会"消失"（宁可多显示，不可丢功能）。
      //   · 当前页签记在 localStorage，下次打开还是那一页。
      // ★ 归属以卡片自己的 `data-tv-tab` 为准（见 installPanelTabs）；下面的 titles 是
      //   **回退路径**：只有卡片漏写声明时才用标题前缀兜底，并且兜底失败会被点名自检。
      var TAB_DEFS = [
        { key: 'session', label: '🎭 会话', titles: ['🎭 当前 Agent 预设', '🔗 当前会话绑定', '🎯 生效范围'] },
        { key: 'content', label: '📚 内容', titles: ['角色卡', '📚 世界书', '📌 开场白', '预设', '🎓 技能'] },
        { key: 'play', label: '🎲 玩法', titles: ['🎭 剧情选项', '🔞 成人向提示段', '🧩 全局正则'] },
        { key: 'advanced', label: '⚙️ 增强', titles: ['⚙️ 高级功能'] }
      ];
      var TAB_STORAGE_KEY = 'tavern.panel.tab';
      // 页签外的散件（不是 .t-card）：按里面的控件 id / label 文案归组；没登记的留在页签外
      var TAB_TAIL_RULES = [
        { tab: 'content', ids: ['tavern-extra'], labelPrefix: '额外设定' },
        { tab: 'play', ids: ['tavern-tools-toggle'] },
        { tab: 'play', ids: ['tavern-network-toggle'] },
        { tab: 'play', ids: ['tavern-anticliche-toggle'] }
      ];
      function tabKeyForTitle(title) {
        var t = String(title || '').trim();
        for (var i = 0; i < TAB_DEFS.length; i++) {
          var ts = TAB_DEFS[i].titles;
          for (var j = 0; j < ts.length; j++) {
            if (t.indexOf(ts[j]) === 0) return TAB_DEFS[i].key;
          }
        }
        return '';
      }
      function tabKeyForTail(el) {
        for (var i = 0; i < TAB_TAIL_RULES.length; i++) {
          var rule = TAB_TAIL_RULES[i];
          for (var j = 0; j < rule.ids.length; j++) {
            // ★ 必须同时认「元素自身」和「后代」：
            //   规则里的 id 有的是容器（如 tavern-tools-toggle 所在行），
            //   有的就是那个控件**本身**（如 <textarea id="tavern-extra">）。
            //   只查后代时，控件自身永远匹配不上 ⇒ 它被留在页签外（本次修的 bug）。
            try {
              if (el.id === rule.ids[j]) return rule.tab;
              if (el.querySelector && el.querySelector('#' + rule.ids[j])) return rule.tab;
            } catch (e) {}
          }
          if (rule.labelPrefix && el.tagName === 'LABEL' &&
              String(el.textContent || '').trim().indexOf(rule.labelPrefix) === 0) return rule.tab;
        }
        return '';
      }
      function installPanelTabs() {
        var mgr = document.getElementById('tavern-manager');
        if (!mgr || mgr.querySelector('#tavern-tabbar')) return;   // 幂等：重挂载时重建
        var active = '';
        try { active = localStorage.getItem(TAB_STORAGE_KEY) || ''; } catch (e) {}
        if (!TAB_DEFS.some(function (d) { return d.key === active; })) active = 'session';

        var bar = document.createElement('div');
        bar.id = 'tavern-tabbar';
        bar.className = 't-tabbar';
        var panes = {};
        TAB_DEFS.forEach(function (d) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 't-tab';
          btn.setAttribute('data-tab', d.key);
          btn.textContent = d.label;
          btn.addEventListener('click', function () { activateTab(d.key, true); });
          bar.appendChild(btn);
          var pane = document.createElement('div');
          pane.className = 't-pane';
          pane.setAttribute('data-tab', d.key);
          panes[d.key] = pane;
        });
        function activateTab(key, persist) {
          TAB_DEFS.forEach(function (d) {
            panes[d.key].className = 't-pane' + (d.key === key ? ' active' : '');
          });
          for (var i = 0; i < bar.children.length; i++) {
            var b = bar.children[i];
            b.className = 't-tab' + (b.getAttribute('data-tab') === key ? ' active' : '');
          }
          if (persist) { try { localStorage.setItem(TAB_STORAGE_KEY, key); } catch (e) {} }
        }

        // 页签栏插在 <h2> 之后，4 个 pane 紧随其后
        var h2 = mgr.querySelector('h2');
        mgr.insertBefore(bar, h2 ? h2.nextSibling : mgr.firstChild);
        var anchor = bar;
        TAB_DEFS.forEach(function (d) {
          mgr.insertBefore(panes[d.key], anchor.nextSibling);
          anchor = panes[d.key];
        });

        // 搬家（先快照直接子元素：搬家会改 childNodes）
        var unclaimed = [];   // 自检用：声明缺失/非法、且标题前缀也认不出来的卡片
        var kids = [];
        for (var i = 0; i < mgr.children.length; i++) kids.push(mgr.children[i]);
        kids.forEach(function (el) {
          if (el === bar) return;
          for (var k = 0; k < TAB_DEFS.length; k++) { if (panes[TAB_DEFS[k].key] === el) return; }
          var tab = '';
          var isCard = el.tagName !== 'BUTTON' && el.className && String(el.className).indexOf('t-card') >= 0;
          if (isCard) {
            // ★ 声明式归属（2026-10-07）：卡片自己在 markup 上写 data-tv-tab="<页签 key>"。
            //   为什么不再只靠标题前缀：标题一改（哪怕只是加个 emoji），前缀就匹配不上，
            //   卡片会**静默掉出页签体系** —— 这类漂移不报错，只在用户发现"卡片不见了"时才暴露。
            //   现在以声明为准；声明缺失或非法才回退到标题前缀，并把这张卡**点名**出来。
            //   「⚙️ 高级功能」整卡搬走即可 —— 里面那 5 张子卡片不是 mgr 的直接子元素，天然跟着走。
            var declared = String(el.getAttribute('data-tv-tab') || '').trim();
            var declaredKnown = false;
            for (var dk = 0; dk < TAB_DEFS.length; dk++) { if (TAB_DEFS[dk].key === declared) { declaredKnown = true; break; } }
            var titleEl = el.querySelector('.t-card-title');
            var cardTitle = titleEl ? String(titleEl.textContent || '').trim() : '';
            if (declaredKnown) {
              tab = declared;
            } else {
              tab = tabKeyForTitle(cardTitle);
              unclaimed.push((cardTitle || '(无标题卡片)') + (declared ? '（data-tv-tab="' + declared + '" 不是已知页签）' : '（缺 data-tv-tab）'));
            }
          } else {
            tab = tabKeyForTail(el);
          }
          if (tab && panes[tab]) panes[tab].appendChild(el);
          // tab === '' ⇒ 原地不动（永远可见）：底部 yml 预览 / 保存按钮 / 状态行就走这条路
        });
        // ★ 运行时自检：有卡片没被任何页签收走时点名（写进 data 属性 + 控制台），
        //   这样"卡片悄悄消失"永远会在开发期暴露，而不是等用户来报。
        if (unclaimed.length) {
          try { mgr.setAttribute('data-tab-unclaimed', unclaimed.join(' | ')); } catch (e) {}
          try { console.warn('[酒馆] 这些卡片没有被任何页签收走（仍保持可见，请补 data-tv-tab）：' + unclaimed.join(' / ')); } catch (e) {}
        } else {
          try { mgr.removeAttribute('data-tab-unclaimed'); } catch (e) {}
        }
        activateTab(active, false);
      }
      installPanelTabs();

      return { state: state, refreshYml: refreshYml, cleanup: function () { clearInterval(sessionPoll); } };
    }

    // ── 设置页组件 ───────────────────────────────────────────────────
    function TavernSettingsSection(props) {
      var ref = react.useRef(null);
      react.useEffect(function () {
        if (ref.current) {
          mountTavernManager(ref.current);
          return function () { if (ref.current) ref.current.innerHTML = ''; };
        }
      }, []);
      return h("div", { ref: ref, style: { width: "100%" } });
    }

    // ── 插件入口 ─────────────────────────────────────────────────────
    var inject = ["slots", "locale"];
    var NS = "tavernManager";
    var zh = { nav: "🍺 酒馆管理", intro: "角色卡 / 世界书 / 预设 / 故事背景 / 记忆模块管理" };
    var en = { nav: "🍺 Tavern Manager", intro: "Character cards / world books / presets / story background / memory module" };

    // ── AI 回复美化（剧情标签 / 状态栏 / 选项渲染）────────────────────
    function initMessageBeautifier() {
      var currentSessionId = '';
      var observer = null;

      function getSessionId() {
        // 从 URL 路径提取 session ID
        var m = location.pathname.match(/session[\/=]([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        // 尝试从 hash
        var m2 = location.hash.match(/session[\/=]([a-zA-Z0-9_-]+)/);
        if (m2) return m2[1];
        return '';
      }

      // DSH 的消息容器类名是 CSS Modules 生成的哈希（历史上是 `Sxvs8a_root`，
      // 现在是 `_markdown_kcgor_5` 这种 `_名字_哈希_序号` 形态），每次 DSH 重建
      // Web 资源都会变。写死任何一个哈希，都会在某次 DSH 升级后静默失效——
      // 选择器匹配不到任何消息，整个美化链路（状态栏/世界卡/选项/content 剥离）
      // 就全部不执行，而页面上看不出任何报错。
      // 因此这里按“结构模式”匹配，不依赖具体哈希。
      var MSG_BODY_RE = /_markdown_[a-z0-9]+_\d+/i;      // 渲染后的正文容器
      var MSG_BLOCK_RE = /_[a-zA-Z]+_[a-z0-9]+_\d+/;    // 任意 CSS Modules 类名

      /**
       * 该元素是不是“承载正文”的容器。
       * 只匹配类名会误伤，因为 DSH 里 `_markdown_*` 同时用在一个文件类型图标
       * 模块上（同模块还有 code/excel/folder/…）。真正的正文容器一定包含
       * 渲染后的块级子节点，用这个来区分。
       */
      function isMessageBody(el) {
        if (!el || el.nodeType !== 1) return false;
        var cls = el.className;
        if (typeof cls !== 'string' || !cls) return false;
        if (!MSG_BODY_RE.test(cls)) return false;
        try {
          return !!el.querySelector('p, pre, ul, ol, blockquote, table, h1, h2, h3');
        } catch (e) { return false; }
      }

      /**
       * 从正文容器向上找消息根节点：需要能承载绝对定位的编辑按钮/徽标，
       * 且不能把整条会话列表当成一条消息。
       */
      function messageRootOf(bodyEl) {
        var node = bodyEl;
        for (var up = 0; up < 4 && node && node.parentElement; up++) {
          var parent = node.parentElement;
          // 兄弟节点明显多于一条消息 -> 说明 node 已经是单条消息，parent 是列表
          var siblings = parent.children ? parent.children.length : 0;
          if (siblings > 1) break;
          node = parent;
        }
        return node || bodyEl;
      }

      function findAiMessages() {
        var result = [];
        var seen = new Set();

        // 主路径：按正文容器的 CSS Modules 模式匹配（跨 DSH 构建稳定），
        // 并用块级子节点把“文件类型图标”等同名元素排除掉。
        var bodies = [];
        try {
          bodies = Array.prototype.slice.call(document.querySelectorAll('[class*="_markdown_"]')).filter(isMessageBody);
        } catch (e) { bodies = []; }
        if (!bodies.length) {
          // 退路：整页扫描带 CSS Modules 形态类名的元素，再挑出看起来是正文的
          try {
            bodies = Array.prototype.slice.call(document.querySelectorAll('[class]')).filter(function (el) {
              var cls = el.className;
              return typeof cls === 'string' && MSG_BLOCK_RE.test(cls)
                && el.querySelector && el.querySelector('p, pre, ul, ol, blockquote, table');
            });
          } catch (e) { bodies = []; }
        }

        // 显式标记（旧版 DSH / 其它外壳）
        try {
          var legacy = document.querySelectorAll('[data-role="assistant"], .assistant-message, .chat-message.assistant');
          for (var L = 0; L < legacy.length; L++) bodies.push(legacy[L]);
        } catch (e) {}

        for (var i = 0; i < bodies.length; i++) {
          var body = bodies[i];
          if (!body) continue;
          // 跳过正在流式输出的消息
          var root = isMessageBody(body) ? messageRootOf(body) : body;
          if (root.getAttribute && root.getAttribute('data-streaming') !== null) continue;
          // ★ 只美化当前可见（当前会话）的消息：其他会话在虚拟列表/隐藏容器里，
          //   若一并美化会把状态栏/世界卡渲染到错误的位置。
          if (!isVisibleInDom(root)) continue;
          if (!seen.has(root)) { seen.add(root); result.push(root); }
        }
        return result;
      }
      // 判断元素是否在当前可视会话中（排除 display:none / visibility:hidden / 隐藏容器）
      function isVisibleInDom(el) {
        try {
          if (el.closest('[style*="display: none"], [style*="display:none"], [hidden]')) return false;
          var r = el.getBoundingClientRect();
          // 有实际渲染尺寸的才算可见（虚拟列表里未渲染的会话消息通常为 0 或无布局）
          if (r.width === 0 && r.height === 0) return false;
          return true;
        } catch (e) { return true; }
      }

      // ── 剧情美化 + 交互选项 ──
      var beautifyStyleInjected = false;
      function injectBeautifyStyles() {
        if (beautifyStyleInjected) return;
        beautifyStyleInjected = true;
        var s = document.createElement('style');
        s.textContent = '.tavern-world-card{background:linear-gradient(135deg,rgba(122,184,255,.08),rgba(157,124,255,.08));border:1px solid rgba(122,184,255,.2);border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px;color:var(--dsw-alias-label-secondary,#aaa)}.tavern-world-card .tw-row{display:flex;align-items:center;gap:6px;margin:2px 0}.tavern-world-card .tw-label{color:var(--dsw-alias-brand-primary,#7ab8ff);font-weight:600;min-width:50px}.tavern-status-card{background:rgba(233,69,96,.06);border:1px solid rgba(233,69,96,.2);border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px}.tavern-status-card .ts-char{margin:6px 0;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.08)}.tavern-status-card .ts-char:last-child{border-bottom:none}.tavern-status-card .ts-name{font-weight:700;color:#e94560;font-size:14px}.tavern-status-card .ts-field{color:var(--dsw-alias-label-secondary,#bbb);margin:2px 0;padding-left:8px}.tavern-status-card .ts-field b{color:var(--dsw-alias-label-primary,#eee);font-weight:500}.tavern-options{display:flex;flex-direction:column;gap:8px;margin:12px 0}.tavern-option-btn{background:var(--dsw-alias-bg-layer-2,#2a2a3e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--dsw-alias-label-primary,#eee);cursor:pointer;text-align:left;transition:all .15s;font-family:inherit}.tavern-option-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#3a3a5e);border-color:var(--dsw-alias-brand-primary,#7ab8ff);transform:translateX(2px)}.tavern-option-btn .opt-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-brand-primary,#7ab8ff);color:#fff;font-size:11px;font-weight:700;margin-right:8px}.tavern-custom-input{display:flex;gap:8px;margin-top:8px;margin-bottom:24px;position:relative;z-index:10}.tavern-custom-input input{flex:1;background:rgba(30,30,46,.95);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;color:var(--dsw-alias-label-primary,#eee);font-size:13px;font-family:inherit;outline:none;box-shadow:0 2px 8px rgba(0,0,0,.3)}.tavern-custom-input input:focus{border-color:var(--dsw-alias-brand-primary,#7ab8ff);box-shadow:0 0 0 2px rgba(122,184,255,.2)}.tavern-custom-input button{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;box-shadow:0 2px 8px rgba(79,70,229,.3);transition:all .15s}.tavern-custom-input button:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(79,70,229,.4)}.tavern-custom-input button:active{transform:translateY(0)}.dsh-tv-option-item{cursor:pointer;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));margin:4px 0;list-style:none;transition:all .15s;font-size:13px;color:var(--dsw-alias-label-primary,#eee)}.dsh-tv-option-item:hover{background:var(--dsw-alias-bg-layer-2,#3a3a5e);border-color:var(--dsw-alias-brand-primary,#7ab8ff)}.tavern-status-trailer{margin-top:14px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(255,255,255,0.08))}.tavern-status-trailer .tavern-world-card:first-child,.tavern-status-trailer .tavern-status-card:first-child,.tavern-status-trailer .tavern-situation-card:first-child,.tavern-status-trailer .tavern-sese-card:first-child{margin-top:4px}.tavern-situation-card{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.08));border:1px solid rgba(168,85,247,.25);border-radius:12px;padding:14px 16px;margin:12px 0;font-size:13px}.tavern-situation-card .tsit-header{display:flex;flex-wrap:wrap;gap:8px 16px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px dashed rgba(255,255,255,.1)}.tavern-situation-card .tsit-field{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#bbb)}.tavern-situation-card .tsit-icon{font-size:14px}.tavern-situation-card .tsit-player{background:rgba(168,85,247,.08);border-radius:8px;padding:10px 12px;margin-bottom:10px}.tavern-situation-card .tsit-player-title{font-weight:700;color:#c084fc;font-size:14px;margin-bottom:6px}.tavern-situation-card .tsit-player-field{color:var(--dsw-alias-label-secondary,#bbb);margin:3px 0;line-height:1.5}.tavern-situation-card .tsit-player-field b{color:var(--dsw-alias-label-primary,#eee);font-weight:500}.tavern-situation-card .tsit-chars{display:flex;flex-direction:column;gap:4px}.tavern-situation-card .tsit-char{display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)}.tavern-situation-card .tsit-char:last-child{border-bottom:none}.tavern-situation-card .tsit-char-name{font-weight:600;color:#f472b6;min-width:80px;flex-shrink:0}.tavern-situation-card .tsit-char-status{color:var(--dsw-alias-label-secondary,#bbb);flex:1;line-height:1.4}.dsh-tv-card{max-width:100%;border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px;background:rgba(122,184,255,.06);border:1px solid rgba(122,184,255,.2);color:var(--dsw-alias-label-primary,#eee)}.dsh-tv-maintext{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 14px;margin:8px 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#eee)}.dsh-tv-meta-row{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 10px 0;padding:6px 8px;background:rgba(255,255,255,.04);border-radius:6px}.dsh-tv-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb)}.dsh-tv-char{margin:8px 0;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,.08)}.dsh-tv-char:last-child{border-bottom:none}.dsh-tv-char-name{font-weight:700;color:#e94560;font-size:14px;display:inline}.dsh-tv-char-state{color:var(--dsw-alias-label-secondary,#bbb);margin:2px 0 4px 0;font-size:12px;display:inline;margin-left:6px}.dsh-tv-char-thought{color:var(--dsw-alias-label-secondary,#bbb);padding-left:14px;margin:2px 0;font-size:12px;border-left:2px solid rgba(255,255,255,.06)}.dsh-tv-options{margin:10px 0 4px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)}.dsh-tv-options-title{font-weight:600;font-size:13px;color:var(--dsw-alias-brand-primary,#7ab8ff);margin-bottom:6px}.dsh-tv-options ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}.dsh-tv-option-item{background:var(--dsw-alias-bg-layer-2,#2a2a3e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-primary,#eee);cursor:pointer;transition:all .15s;font-family:inherit}.dsh-tv-option-item:hover{background:var(--dsw-alias-interactive-bg-hover,#3a3a5e);border-color:var(--dsw-alias-brand-primary,#7ab8ff);transform:translateX(2px)}.dsh-tv-dialogue{margin:8px 0;padding:8px 12px;background:rgba(255,255,255,.03);border-left:3px solid var(--dsw-alias-brand-primary,#7ab8ff);border-radius:0 6px 6px 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#eee)}.dsh-tv-dialogue-line{padding:2px 0}.tavern-muv-statusbar{margin:10px 0;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;overflow:hidden}.tavern-muv-iframe{display:block}.tavern-sese-card{background:rgba(122,184,255,.06);border:1px solid rgba(122,184,255,.2);border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px}.tavern-sese-header{display:flex;flex-wrap:wrap;gap:10px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(122,184,255,.12)}.tavern-sese-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb)}.tavern-sese-chars{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}.tavern-sese-char{background:rgba(122,184,255,.06);border-radius:8px;padding:8px 12px}.tavern-sese-char-name{font-weight:700;color:var(--dsw-alias-brand-primary,#7ab8ff);font-size:13px;margin-bottom:3px}.tavern-sese-field{color:var(--dsw-alias-label-secondary,#bbb);margin:2px 0;font-size:12px;line-height:1.5}.tavern-sese-field b{color:var(--dsw-alias-label-primary,#eee);font-weight:500}.tavern-sese-env{background:rgba(122,184,255,.03);border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px}.tavern-updatevar{background:rgba(197,160,101,.08);border:1px solid rgba(197,160,101,.25);border-radius:8px;margin:8px 0;overflow:hidden}.tavern-updatevar summary{font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;color:#c5a065;background:rgba(0,0,0,.2);user-select:none}.tavern-updatevar pre{font-size:11px;padding:8px 14px;margin:0;color:var(--dsw-alias-label-secondary,#998);white-space:pre-wrap;word-break:break-word;line-height:1.4;max-height:250px;overflow:auto}';
        document.head.appendChild(s);
      }
      function parseWorldBlock(text) {
        var m = text.match(/<(?:世界|world)>([\s\S]*?)<\/(?:世界|world)>/i);
        if (!m) return null;
        var content = m[1];
        var time = (content.match(/<(?:时间|time)>([\s\S]*?)<\/(?:时间|time)>/i) || [])[1];
        var location = (content.match(/<(?:地点|location|place)>([\s\S]*?)<\/(?:地点|location|place)>/i) || [])[1];
        var weather = (content.match(/<(?:天气|weather)>([\s\S]*?)<\/(?:天气|weather)>/i) || [])[1];
        return { time: time && time.trim(), location: location && location.trim(), weather: weather && weather.trim(), raw: m[0] };
      }
      function parseStatusBlock(text) {
        var m = text.match(/<(?:Status_block|status)>([\s\S]*?)<\/(?:Status_block|status)>/i);
        if (!m) return null;
        var content = m[1];
        var chars = [];
        var re = /名字:\s*"([^"]*)"\s*身份:\s*"([^"]*)"\s*状态:\s*"([^"]*)"\s*穿搭:\s*"([^"]*)"\s*动作:\s*"([^"]*)"/g;
        var match;
        while ((match = re.exec(content)) !== null) {
          chars.push({ name: match[1], identity: match[2], status: match[3], outfit: match[4], action: match[5] });
        }
        return { chars: chars, raw: m[0] };
      }
      function parseOptions(text) {
        var lines = text.split('\n');
        var optionLines = [];
        var inOptions = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (/接下来.*怎么|你想怎么做|你想怎么继续|选择.*选项|请选择/.test(line) && !/^\s*\d+[\.、)]/.test(line)) {
            inOptions = true;
            continue;
          }
          if (inOptions && /^\s*\d+[\.、)]\s*\S/.test(line)) {
            optionLines.push(line.trim());
          } else if (inOptions && line.trim() === '') {
            // 空行
          } else if (inOptions && optionLines.length > 0) {
            break;
          }
        }
        if (optionLines.length === 0) return null;
        return optionLines.map(function (line) {
          var m = line.match(/^\s*\d+[\.、)]\s*(.*)/);
          return m ? m[1].trim() : line;
        });
      }
      function sendTavernMessage(text) {
        console.log('[tavern-send] sending:', text);
        // 查找输入框：优先 muv-engine 已挂钩的输入框 / placeholder 匹配 / 已知 class / 可见 textarea
        var input = document.querySelector('textarea[data-muv-macro-hooked]')
          || document.querySelector('textarea[placeholder*="消息"], textarea[placeholder*="Message"], textarea[placeholder*="输入"], textarea[placeholder*="发送"]')
          || document.querySelector('textarea.uV2eYG_input')
          || document.querySelector('textarea[class*="input"]')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('[role="textbox"]');
        if (!input) {
          // 兜底：挑选可见且最高的 textarea（可能是聊天输入框）
          var alts = document.querySelectorAll('textarea');
          for (var ai = 0; ai < alts.length; ai++) {
            var ta = alts[ai];
            if (ta.offsetParent !== null && !ta.readOnly && ta.rows >= 2) { input = ta; break; }
          }
        }
        if (!input) {
          console.log('[tavern-send] input not found');
          return;
        }
        console.log('[tavern-send] found input:', input.tagName, input.className);
        
        input.focus();
        
        // React 兼容设置值
        function setReactValue(el, val) {
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            // contenteditable
            try {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, val);
            } catch (e) {
              el.textContent = val;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
          }
        }
        
        setReactValue(input, text);
        
        // 等待 React 状态更新后，只点击发送按钮（不触发 Enter，避免重复）
        setTimeout(function () {
          // 再次确认值还在（React 可能重置）
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            if (input.value !== text) setReactValue(input, text);
          }
          
          var sendBtn = document.querySelector('button[class*="send"]')
            || document.querySelector('[class*="send"] button')
            || document.querySelector('button[aria-label*="发送"]')
            || document.querySelector('button[title*="发送"]')
            || document.querySelector('[class*="composer"] button:last-child');
          if (sendBtn && sendBtn.offsetParent !== null) {
            console.log('[tavern-send] clicking send button');
            sendBtn.click();
          } else {
            // 没找到发送按钮，触发 Enter
            console.log('[tavern-send] no send button, pressing Enter');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }
        }, 150);
      }
      // ★ 2.7.10：必须与 esc **完全一致** —— 它的产出是拿去在「已由 esc 生成」的 HTML 里
      //   做 indexOf 的搜索键（见 plotGuideText 那处）。原先只吃 4 个字符、漏了单引号，
      //   于是正文含 ' 时搜不到，选项按钮会退化成「追加到末尾」。
      function htmlEscapeStr(s) {
        return esc(s);
      }
      function decodeHtml(s) {
        return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      }
      // ── 自由格式状态卡解析器（兜底：当现有刚性解析都不命中时使用） ──
      /**
       * 示例角色卡 内联格式状态块解析器。
       * 格式：
       *   状态栏: 日期和时间: "..." 地点: "..." 
       *   用户列表:
       *   - 用户: 安柏 名字: "👤 安柏" 行动: "📝 ..." 内心: "💭 ..." 衣着: ...
       *   环境: 氛围: "..." 风: "..."
       *   行动选项:
       *   - "🏆 ..."
       * @param {string} body - Status_block 内部文本
       * @returns {string|null} HTML
       */
      function parseSeseStatusBlock(body) {
        if (!body || body.indexOf('状态栏') === -1) return null
        var meta = {}, chars = [], options = [], environment = []
        var lines = body.split('\n')
        // 1) 头部元数据：状态栏: 日期和时间: "..." 地点: "..."
        var headMatch = body.match(/状态栏[:：]\s*日期和时间[:：]\s*"([^"]*)"\s*地点[:：]\s*"([^"]*)"/)
        if (headMatch) { meta.time = headMatch[1]; meta.loc = headMatch[2] }
        else {
          var tm = body.match(/日期和时间[:：]\s*"([^"]*)"/) ; if (tm) meta.time = tm[1]
          var lm = body.match(/地点[:：]\s*"([^"]*)"/) ; if (lm) meta.loc = lm[1]
        }
        // 2) 环境
        var envMatch = body.match(/环境[:：]\s*氛围[:：]\s*"([^"]*)"\s*风[:：]\s*"([^"]*)"/)
        if (envMatch) { environment.push(envMatch[1]); environment.push(envMatch[2]) }
        else if (body.match(/环境[:：]/)) {
          var envRe = /环境[:：]([\s\S]*?)(?=行动选项|$)/.exec(body)
          if (envRe) {
            var envText = envRe[1].replace(/氛围[:：]\s*"([^"]*)"/g, function (_, v) { environment.push(v); return '' })
                               .replace(/风[:：]\s*"([^"]*)"/g, function (_, v) { environment.push(v); return '' }).trim()
            if (envText) environment.push(envText)
          }
        }
        // 3) 用户列表：- 用户: 名字 行动: "..." 内心: "..." 衣着: ...
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim()
          if (/^-\s*用户[:：]/.test(line)) {
            var c = { name: '', action: '', thought: '', extra: '' }
            var nm = line.match(/名字[:：]\s*"([^"]*)"/); if (nm) c.name = nm[1]
            if (!c.name) { var um = line.match(/^-\s*用户[:：]\s*([^\s"]+)/); if (um) c.name = um[1] }
            var am = line.match(/行动[:：]\s*"([^"]*)"/); if (am) c.action = am[1]
            var thm = line.match(/内心[:：]\s*"([^"]*)"/); if (thm) c.thought = thm[1]
            var exm = line.match(/衣着[:：]\s*"([^"]*)"/); if (exm) c.extra = '👔 ' + exm[1]
            else { var ex2 = line.match(/衣着[:：]\s*([^"]+$)/); if (ex2) c.extra = '👔 ' + ex2[1].trim() }
            chars.push(c)
          }
        }
        // 4) 行动选项
        var optSection = body.match(/行动选项[:：]([\s\S]*?)$/)
        if (optSection) {
          var optRe = /[-•]\s*"([^"]*)"|[-•]\s*([^\n]+)/g
          var om
          while ((om = optRe.exec(optSection[1])) !== null) {
            var opt = (om[1] || om[2] || '').trim()
            if (opt && options.indexOf(opt) === -1) options.push(opt)
          }
        }
        // 5) 构建
        var html = '<div class="tavern-sese-card">'
        if (meta.time || meta.loc) {
          html += '<div class="tavern-sese-header">'
          if (meta.time) html += '<span class="tavern-sese-meta">⏰ ' + esc(meta.time) + '</span>'
          if (meta.loc) html += '<span class="tavern-sese-meta">📍 ' + esc(meta.loc) + '</span>'
          html += '</div>'
        }
        if (chars.length > 0) {
          html += '<div class="tavern-sese-chars">'
          for (var ci = 0; ci < chars.length; ci++) {
            var cc = chars[ci]
            html += '<div class="tavern-sese-char">'
            html += '<div class="tavern-sese-char-name">👤 ' + esc(cc.name) + '</div>'
            if (cc.action) html += '<div class="tavern-sese-field"><b>📝 行动：</b>' + esc(cc.action) + '</div>'
            if (cc.thought) html += '<div class="tavern-sese-field" style="color:var(--dsw-alias-label-secondary,#aab)"><b>💭 内心：</b>' + esc(cc.thought) + '</div>'
            if (cc.extra) html += '<div class="tavern-sese-field">' + esc(cc.extra) + '</div>'
            html += '</div>'
          }
          html += '</div>'
        }
        if (environment.length > 0) {
          html += '<div class="tavern-sese-env">'
          for (var ei = 0; ei < environment.length; ei++) html += '<div class="tavern-sese-field">' + esc(environment[ei]) + '</div>'
          html += '</div>'
        }
        if (options.length > 0) {
          html += '<div class="tavern-options"><div class="dsh-tv-options-title">行动选项</div>'
          for (var oi = 0; oi < options.length; oi++) {
            html += '<button type="button" class="tavern-option-btn">' + esc(options[oi]) + '</button>'
          }
          html += '</div>'
        }
        html += '</div>'
        return html
      }

      function parseFreeFormatBlock(plainText, rawHtml) {
        // 1. 检测是否有自由格式标记
        var hasStatusBlock = /<\s*Status_block\s*>/i.test(plainText) || /<\s*状况\s*>/i.test(plainText);
        var hasMaintext = /<\s*\/?\s*maintext\s*>/i.test(plainText);
        if (!hasStatusBlock && !hasMaintext) return null;
        
        // 2. 提取 maintext 正文（<maintext>...</maintext>）
        var maintextBody = '';
        var mtMatch = plainText.match(/<\s*maintext\s*>([\s\S]*?)<\s*\/\s*maintext\s*>/i);
        if (mtMatch) maintextBody = mtMatch[1].trim();
        
        // 3. 提取状态块正文（<Status_block>...</Status_block> 或 <状况>...</状况>，含空格变体）
        var statusBody = '';
        var sbMatch = plainText.match(/<\s*Status_block\s*>([\s\S]*?)<\s*\/\s*Status_block\s*>/i);
        if (!sbMatch) sbMatch = plainText.match(/<\s*状况\s*>([\s\S]*?)<\s*\/\s*状况\s*>/i);
        // 也尝试 HTML 转义版本
        if (!sbMatch) sbMatch = rawHtml.match(/&lt;\s*Status_block\s*&gt;([\s\S]*?)&lt;\s*\/\s*Status_block\s*&gt;/i);
        if (sbMatch) statusBody = decodeHtml(sbMatch[1]).trim();
        
        // 如果没有状态块，但只有 maintext，返回 maintext 渲染
        if (!statusBody) {
          if (maintextBody) {
            var lines = maintextBody.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
            return '<div class="dsh-tv-maintext">' + lines.join('<br>') + '</div>';
          }
          return null;
        }
        
        // 4. 逐行解析状态块内容
        var lines = statusBody.split('\n');
        var metaItems = [];        // 元数据段（⏰/📍/🌤 等）
        var charBlocks = [];       // 角色块 { name, expression, state, thoughts:[] }
        var dialogueLines = [];    // 独白/对话行（无 emoji 前导，角色块之后的普通文本）
        var options = [];          // 选项列表
        var inOptions = false;
        var currentChar = null;
        
        for (var fi = 0; fi < lines.length; fi++) {
          var line = lines[fi].trim();
          if (!line) {
            if (currentChar) { charBlocks.push(currentChar); currentChar = null; }
            continue;
          }
          
          // 元数据行：以 ⏰/📍/🌤/📅/🌡 等 emoji 开头
          if (/^[⏰📍🌤📅🌡]/u.test(line) && !currentChar) {
            metaItems.push(line);
            continue;
          }
          
          // 行动选项标题
          if (/^行动选项|^行动[:：]/.test(line)) {
            if (currentChar) { charBlocks.push(currentChar); currentChar = null; }
            inOptions = true;
            continue;
          }
          
          // 选项行（在选项区内，以 emoji 或数字或 - 开头）
          if (inOptions && (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line) || /^\d+[\.、)]/.test(line) || /^[-•]/.test(line))) {
            options.push(line);
            continue;
          }
          
          // 角色行：以 👤 开头
          if (/^👤/u.test(line)) {
            if (currentChar) charBlocks.push(currentChar);
            currentChar = { name: '', expression: '', state: '', thoughts: [] };
            var rest = line.replace(/^👤\s*/u, '').trim();
            // 尝试提取表情 emoji：名字后面紧跟的一个 emoji
            var emojiMatch = rest.match(/^(.+?)(\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])\s*(.*)$/u);
            if (emojiMatch) {
              currentChar.name = esc(emojiMatch[1].trim());
              currentChar.expression = emojiMatch[2].trim();
              currentChar.state = esc(emojiMatch[3].trim());
            } else {
              currentChar.name = esc(rest);
            }
            continue;
          }
          
          // 台词行（在当前角色下，无特殊前缀的普通文本）
          if (currentChar) {
            currentChar.thoughts.push(esc(line));
            continue;
          }
          
          // 对话/独白行（没有当前角色，不在选项区，普通文本）
          if (!inOptions) {
            dialogueLines.push(esc(line));
          }
        }
        if (currentChar) charBlocks.push(currentChar);
        
        // 5. 构建 HTML
        var parts = [];
        
        // maintext 块
        if (maintextBody) {
          var mtLines = maintextBody.split('\n').map(function(l) { return esc(l.trim()); }).filter(Boolean);
          parts.push('<div class="dsh-tv-maintext">' + mtLines.join('<br>') + '</div>');
        }
        
        // 卡片
        parts.push('<div class="dsh-tv-card">');
        
        // 元数据行
        if (metaItems.length > 0) {
          parts.push('<div class="dsh-tv-meta-row">');
          for (var mi = 0; mi < metaItems.length; mi++) {
            parts.push('<span class="dsh-tv-meta">' + esc(metaItems[mi]) + '</span>');
          }
          parts.push('</div>');
        }
        
        // 角色块
        for (var ci = 0; ci < charBlocks.length; ci++) {
          var ch = charBlocks[ci];
          parts.push('<div class="dsh-tv-char">');
          parts.push('<span class="dsh-tv-char-name">👤 ' + ch.name + '</span>');
          if (ch.expression) {
            parts.push('<span class="dsh-tv-char-state">' + ch.expression + ' ' + (ch.state || '') + '</span>');
          }
          for (var ti = 0; ti < ch.thoughts.length; ti++) {
            parts.push('<div class="dsh-tv-char-thought">💭 ' + ch.thoughts[ti] + '</div>');
          }
          parts.push('</div>');
        }
        
        // 对话/独白行
        if (dialogueLines.length > 0) {
          parts.push('<div class="dsh-tv-dialogue">');
          for (var dl = 0; dl < dialogueLines.length; dl++) {
            parts.push('<div class="dsh-tv-dialogue-line">' + dialogueLines[dl] + '</div>');
          }
          parts.push('</div>');
        }
        
        // 选项
        if (options.length > 0) {
          parts.push('<div class="dsh-tv-options"><div class="dsh-tv-options-title">行动选项</div><ul>');
          for (var oi = 0; oi < options.length; oi++) {
            parts.push('<li class="dsh-tv-option-item" data-opt="' + esc(options[oi]) + '">' + esc(options[oi]) + '</li>');
          }
          parts.push('</ul></div>');
        }
        
        parts.push('</div>');
        return parts.join('');
      }
      // ── 状态/剧情美化已移交 dsh-muv-engine ─────────────────────────
      // 历史上这块由本插件内的 beautifyContentEl() 承担，而 muv-engine 里
      // 另有一套更完整的状态栏逻辑。两套渲染器同时运行会互相覆盖：酒馆这套
      // 把 『』表头与 `- 😋 名字` 当作对话行平铺，覆盖掉 muv-engine 结构化
      // 后的卡片，用户看到的就是半成品。
      // 现在渲染归 muv-engine（它按 C→YAML→👤→自由形态 级联，且能识别更多
      // 卡片格式），本插件只负责面板与数据。
      // 保留 beautifyContentEl 定义以备回退，但不再调用它。
      function delegateBeautify(msgEl) {
        try {
          var api = window.MuvEngine;
          if (!api) return;
          if (typeof api.decorateMessage === 'function') {
            api.decorateMessage(msgEl);
          } else if (typeof api.scheduleDecorate === 'function') {
            api.scheduleDecorate();
          }
          // 没有显式钩子时无需处理：muv-engine 自己挂了 MutationObserver，
          // 消息一旦进入 DOM 它就会接手。
        } catch (e) {}
      }

      function beautifyContentEl(contentEl) {
        if (contentEl.dataset.tavernBeautified) return;
        var text = contentEl.textContent || '';
        var html = contentEl.innerHTML;
        var modified = false;
        // ★ 状态类卡片收集器：世界/状态/状况/状态栏/sese 卡渲染后不留在原位，统一移到消息底部
        var moveToBottom = [];

        // ★ 剥离 AI 输出里的 <content> 草稿容器标签（角色卡/世界书要求 AI 在 <content> 里打草稿，
        //   deepseek 常把标签本身输出到正文；成对标签剥标签留内容，裸标签直接删）
        if (text.includes('<content>') || text.includes('&lt;content&gt;') || text.includes('</content>') || text.includes('&lt;/content&gt;')) {
          var contentRe = /&lt;\/?content&gt;|<\/?content>/gi;
          var newHtml = html.replace(contentRe, '');
          if (newHtml !== html) {
            html = newHtml;
            modified = true;
          }
        }

        // 只处理真正的剧情消息（含世界书/状态/MUV 标签，raw 或 &lt;转义&gt; 两种形态都识别），跳过纯文本
        var muvTagRe = /<(?:世界|world|状况|situation|Drama|speech|action|thought|thinking|赏令|details|choices|UpdateVariable|StatusPlaceHolder|style|maintext|initvar|JSONPatch)\b[^>]*>/i;
        var muvTagRe2 = /&lt;(?:世界|world|状况|situation|Drama|speech|action|thought|thinking|赏令|details|choices|UpdateVariable|StatusPlaceHolder|style|maintext|initvar|JSONPatch)\b[^&]*&gt;/i;
        if (!text.includes('<世界>') && !text.includes('Status_block') && !text.includes('<状况>') && !text.includes('状态栏') && !text.includes('<maintext') && !text.includes('</maintext') && !muvTagRe.test(html) && !muvTagRe2.test(html) && !modified) return;

        // 世界卡：直接在 innerHTML 匹配转义后的标签
        var worldRe = /&lt;(?:世界|world)&gt;([\s\S]*?)&lt;\/(?:世界|world)&gt;/i;
        var worldMatch = html.match(worldRe);
        if (!worldMatch) worldMatch = html.match(/<(?:世界|world)>([\s\S]*?)<\/(?:世界|world)>/i);
        if (worldMatch) {
          var wContent = decodeHtml(worldMatch[1]);
          var wTime = (wContent.match(/<(?:时间|time)>([\s\S]*?)<\/(?:时间|time)>/i) || [])[1];
          var wLoc = (wContent.match(/<(?:地点|location|place)>([\s\S]*?)<\/(?:地点|location|place)>/i) || [])[1];
          var wWeather = (wContent.match(/<(?:天气|weather)>([\s\S]*?)<\/(?:天气|weather)>/i) || [])[1];
          var wh = '<div class="tavern-world-card">';
          if (wTime) wh += '<div class="tw-row"><span class="tw-label">🕐 时间</span><span>' + esc(wTime.trim()) + '</span></div>';
          if (wLoc) wh += '<div class="tw-row"><span class="tw-label">📍 地点</span><span>' + esc(wLoc.trim()) + '</span></div>';
          if (wWeather) wh += '<div class="tw-row"><span class="tw-label">🌤️ 天气</span><span>' + esc(wWeather.trim()) + '</span></div>';
          wh += '</div>';
          html = html.replace(worldMatch[0], '');
          moveToBottom.push(wh);
          modified = true;
        }

        // 状态卡：直接在 innerHTML 匹配转义后的标签
        var statusRe = /&lt;(?:Status_block|status)&gt;([\s\S]*?)&lt;\/(?:Status_block|status)&gt;/i;
        var statusMatch = html.match(statusRe);
        if (!statusMatch) statusMatch = html.match(/<(?:Status_block|status)>([\s\S]*?)<\/(?:Status_block|status)>/i);
        if (statusMatch) {
          var sContent = decodeHtml(statusMatch[1]);
          var chars = [];
          // 更宽松的正则：字段之间可以有任意空白（包括换行）
          var charRe = /名字:\s*"([\s\S]*?)"\s*身份:\s*"([\s\S]*?)"\s*状态:\s*"([\s\S]*?)"\s*穿搭:\s*"([\s\S]*?)"\s*动作:\s*"([\s\S]*?)"/g;
          var cm;
          while ((cm = charRe.exec(sContent)) !== null) {
            chars.push({ name: cm[1].trim(), identity: cm[2].trim(), status: cm[3].trim(), outfit: cm[4].trim(), action: cm[5].trim() });
          }
          if (chars.length > 0) {
            var sh = '<div class="tavern-status-card">';
            for (var ci = 0; ci < chars.length; ci++) {
              var c = chars[ci];
              sh += '<div class="ts-char"><div class="ts-name">' + esc(c.name) + '</div>';
              sh += '<div class="ts-field"><b>身份：</b>' + esc(c.identity) + '</div>';
              sh += '<div class="ts-field"><b>状态：</b>' + esc(c.status) + '</div>';
              sh += '<div class="ts-field"><b>穿搭：</b>' + esc(c.outfit) + '</div>';
              sh += '<div class="ts-field"><b>动作：</b>' + esc(c.action) + '</div></div>';
            }
            sh += '</div>';
            html = html.replace(statusMatch[0], '');
            moveToBottom.push(sh);
            modified = true;
          }
        }

        // 状况卡：<状况> 标签（另一种格式的状态块）
        // 用贪婪匹配，从 <状况> 开始到消息结束
        var situationRe = /&lt;(?:状况|situation)&gt;([\s\S]*)$/i;
        var situationMatch = html.match(situationRe);
        if (!situationMatch) situationMatch = html.match(/<(?:状况|situation)>([\s\S]*)$/i);
        if (situationMatch) {
          // 清理内容里的 HTML 标签
          var sitContent = decodeHtml(situationMatch[1]).replace(/<\/?[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
          // 解析头部信息（日期、时间、位置）
          var sitDate = (sitContent.match(/日期[：:]\s*([^|┃\n]+)/) || [])[1];
          var sitTime = (sitContent.match(/时间[：:]\s*([^|┃\n]+)/) || [])[1];
          var sitLocation = (sitContent.match(/位置[：:]\s*([^|┃\n』]+)/) || [])[1];
          // 解析"你的状态"行
          var yourAction = (sitContent.match(/当前行动[：:]\s*([^┃\n]+)/) || [])[1];
          var yourOutfit = (sitContent.match(/当前穿搭[：:]\s*([^┃\n]+)/) || [])[1];
          var yourBody = (sitContent.match(/下体状态[：:]\s*([^┃\n]+)/) || [])[1];
          var yourTodo = (sitContent.match(/待办[：:]\s*([^\n]+?)(?:\s*[•·]|$)/) || [])[1];
          // 解析角色列表（• emoji 名字（状态））
          var sitChars = [];
          var charLines = sitContent.match(/[•·]\s*[^\n]+/g);
          if (charLines) {
            for (var cli = 0; cli < charLines.length; cli++) {
              var cl = charLines[cli].replace(/^[•·]\s*/, '').trim();
              // 跳过"你的状态"行
              if (/你的状态|当前行动|当前穿搭/.test(cl)) continue;
              var cm = cl.match(/^(.+?)[（(](.+?)[）)]\s*$/);
              if (cm) {
                sitChars.push({ name: cm[1].trim(), status: cm[2].trim() });
              } else if (cl.length > 0) {
                sitChars.push({ name: cl, status: '' });
              }
            }
          }
          // 渲染状况卡
          var sitHtml = '<div class="tavern-situation-card">';
          // 头部信息
          if (sitDate || sitTime || sitLocation) {
            sitHtml += '<div class="tsit-header">';
            if (sitDate) sitHtml += '<span class="tsit-field"><span class="tsit-icon">📅</span>' + esc(sitDate.trim()) + '</span>';
            if (sitTime) sitHtml += '<span class="tsit-field"><span class="tsit-icon">⏰</span>' + esc(sitTime.trim()) + '</span>';
            if (sitLocation) sitHtml += '<span class="tsit-field"><span class="tsit-icon">📍</span>' + esc(sitLocation.trim()) + '</span>';
            sitHtml += '</div>';
          }
          // 你的状态
          if (yourAction || yourOutfit || yourBody || yourTodo) {
            sitHtml += '<div class="tsit-player">';
            sitHtml += '<div class="tsit-player-title">👤 你的状态</div>';
            if (yourAction) sitHtml += '<div class="tsit-player-field"><b>🏃 行动：</b>' + esc(yourAction.trim()) + '</div>';
            if (yourOutfit) sitHtml += '<div class="tsit-player-field"><b>👔 穿搭：</b>' + esc(yourOutfit.trim()) + '</div>';
            if (yourBody) sitHtml += '<div class="tsit-player-field"><b>🩸 状态：</b>' + esc(yourBody.trim()) + '</div>';
            if (yourTodo) sitHtml += '<div class="tsit-player-field"><b>📋 待办：</b>' + esc(yourTodo.trim()) + '</div>';
            sitHtml += '</div>';
          }
          // 角色列表
          if (sitChars.length > 0) {
            sitHtml += '<div class="tsit-chars">';
            for (var sci = 0; sci < sitChars.length; sci++) {
              var sc = sitChars[sci];
              sitHtml += '<div class="tsit-char">';
              sitHtml += '<span class="tsit-char-name">' + esc(sc.name) + '</span>';
              if (sc.status) sitHtml += '<span class="tsit-char-status">' + esc(sc.status) + '</span>';
              sitHtml += '</div>';
            }
            sitHtml += '</div>';
          }
          sitHtml += '</div>';
          html = html.replace(situationMatch[0], '');
          moveToBottom.push(sitHtml);
          modified = true;
        }

        // 状态栏：格式（「状态栏：」+ 日期和时间/地点/用户列表），常见于酒馆角色卡输出
        var sbRe = /(?:状态栏[：:])([\s\S]*?)(?=\n\s*\n|<\/p>|<\/div>|<div|$)/i;
        var sbMatch = text.match(sbRe);
        if (!sbMatch) sbMatch = decodeHtml(html).match(/(?:状态栏[：:])([\s\S]*?)(?=\n\s*\n|$)/i);
        if (sbMatch && !statusMatch && !situationMatch) {
          var sbContent = decodeHtml(sbMatch[1]).replace(/<\/?[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
          if (sbContent) {
            var sbDate = (sbContent.match(/日期[和及]?时间[：:]\s*"?([^"\n]+)"?/) || sbContent.match(/日期[：:]\s*"?([^"\n]+)"?/) || [])[1];
            var sbTime = (sbContent.match(/时间[：:]\s*"?([^"\n]+)"?/) || [])[1];
            var sbLoc = (sbContent.match(/地点[：:]\s*"?([^"\n]+)"?/) || sbContent.match(/位置[：:]\s*"?([^"\n]+)"?/) || [])[1];
            var sbWeather = (sbContent.match(/天气[：:]\s*"?([^"\n]+)"?/) || [])[1];
            // 用户列表 / 角色列表（• 名字（状态） 或 - 名字：状态 或 名字: 状态）
            var sbChars = [];
            var listSection = sbContent.match(/(?:用户列表|角色列表|在场角色)[：:]\s*([\s\S]*?)$/) || sbContent.match(/([\s\S]*?)$/);
            if (listSection) {
              var charLines = (listSection[1] || sbContent).split('\n');
              for (var sli = 0; sli < charLines.length; sli++) {
                var sl = charLines[sli].replace(/^[•·\-*]\s*/, '').trim();
                if (!sl) continue;
                // 跳过标题行本身（如"状态栏："或字段名）
                if (/^(状态栏|日期|时间|地点|位置|天气|用户列表|角色列表|在场角色)[：:]/.test(sl)) continue;
                var sm = sl.match(/^(.+?)[（(](.+?)[）)]\s*$/);
                if (sm) sbChars.push({ name: sm[1].trim(), status: sm[2].trim() });
                else {
                  var sm2 = sl.match(/^(.+?)[：:]\s*(.+)$/);
                  if (sm2) sbChars.push({ name: sm2[1].trim(), status: sm2[2].trim() });
                  else if (sl.length > 0) sbChars.push({ name: sl, status: '' });
                }
              }
            }
            if (sbDate || sbTime || sbLoc || sbWeather || sbChars.length > 0) {
              var sbHtml = '<div class="tavern-situation-card">';
              if (sbDate || sbTime || sbLoc || sbWeather) {
                sbHtml += '<div class="tsit-header">';
                if (sbDate) sbHtml += '<span class="tsit-field"><span class="tsit-icon">📅</span>' + esc(sbDate.replace(/^"|"$/g, '').trim()) + '</span>';
                if (sbTime) sbHtml += '<span class="tsit-field"><span class="tsit-icon">⏰</span>' + esc(sbTime.replace(/^"|"$/g, '').trim()) + '</span>';
                if (sbLoc) sbHtml += '<span class="tsit-field"><span class="tsit-icon">📍</span>' + esc(sbLoc.replace(/^"|"$/g, '').trim()) + '</span>';
                if (sbWeather) sbHtml += '<span class="tsit-field"><span class="tsit-icon">🌤️</span>' + esc(sbWeather.replace(/^"|"$/g, '').trim()) + '</span>';
                sbHtml += '</div>';
              }
              if (sbChars.length > 0) {
                sbHtml += '<div class="tsit-chars">';
                for (var sbi = 0; sbi < sbChars.length; sbi++) {
                  var sbC = sbChars[sbi];
                  sbHtml += '<div class="tsit-char"><span class="tsit-char-name">' + esc(sbC.name) + '</span>';
                  if (sbC.status) sbHtml += '<span class="tsit-char-status">' + esc(sbC.status) + '</span>';
                  sbHtml += '</div>';
                }
                sbHtml += '</div>';
              }
              sbHtml += '</div>';
              // 用 textContent 定位替换（HTML 里状态栏可能被 markdown 包装）
              var sbRaw = sbMatch[0];
              var sbInHtml = (html || '').indexOf(sbRaw);
              if (sbInHtml !== -1) {
                html = html.replace(sbRaw, '');
                moveToBottom.push(sbHtml);
              } else {
                // 兜底：找「状态栏」起点的原始片段
                var sbStart = (html || '').indexOf('状态栏');
                if (sbStart !== -1) {
                  var sbEnd = (html || '').indexOf('\n\n', sbStart);
                  if (sbEnd === -1) sbEnd = html.length;
                  var cut = html.slice(sbStart, sbEnd);
                  html = html.replace(cut, '');
                  moveToBottom.push(sbHtml);
                }
              }
              modified = true;
            }
          }
        }

        // 自由格式状态卡（兜底：当现有刚性解析都没实际渲染（modified 仍为 false）时使用。
        // 注意不能用 !statusMatch / !situationMatch 来判断：当文本含 <Status_block> 标签时 statusMatch 已经是 truthy，
        // 但严格解析（名字:"..." 等字段）对自由格式一无所获、chars.length===0，modified 仍为 false——
        // 此时必须继续尝试自由格式兜底，否则新格式永远无法被渲染成卡片。）
        if (!modified && (text.includes('<Status_block') || text.includes('<maintext') || text.includes('</maintext') || text.includes('<状况'))) {
          var ffHtml = parseFreeFormatBlock(text, html);
          if (ffHtml) {
            // 找到标签在 html 中的原始位置并替换
            var tagRe = /&lt;(?:\s*Status_block\s*|\s*maintext\s*|\s*状况\s*)[\s\S]*?&lt;\s*\/(?:\s*Status_block\s*|\s*maintext\s*|\s*状况\s*)\s*&gt;|<\s*Status_block\s*>[\s\S]*?<\s*\/\s*Status_block\s*>|<\s*maintext\s*>[\s\S]*?<\s*\/\s*maintext\s*>|<\s*状况\s*>[\s\S]*?<\s*\/\s*状况\s*>/gi;
            var tagMatch = html.match(tagRe);
            if (tagMatch) {
              // 原位替换：ffHtml 是正文+状态卡完整重建结构，需保留正文顺序
              var fullRaw = tagMatch.join('');
              html = html.replace(fullRaw, ffHtml);
            } else {
              // 兜底：直接替换整个 html
              html = ffHtml;
            }
            modified = true;
          }
        }

        // 选项：用多种方式收集
        var optionList = [];

        // ★ <StatusPlaceHolderImpl/> → iframe 状态栏渲染
        if (html.indexOf('StatusPlaceHolderImpl') !== -1) {
          var sphId = 'muv-sb-' + Math.random().toString(36).slice(2, 8);
          var sphHtml = '<div class="tavern-muv-statusbar"><iframe id="'+sphId+'" class="tavern-muv-iframe" sandbox="allow-scripts" style="width:100%;height:600px;border:none;border-radius:8px;background:transparent" srcdoc=""></iframe></div>';
          html = html.replace(/&lt;StatusPlaceHolderImpl\s*\/?&gt;|<StatusPlaceHolderImpl\s*\/?>/gi, sphHtml);
          modified = true;
          // 异步加载状态栏 HTML
          setTimeout(function () {
            try {
              // 这里原先用 `d.ok && d.zodSource` 当门控 —— 那是死的：
              // 服务端（muv-engine 的 regex-engine.js → extractStatusBarHtml）读的是卡的
              // `regexScripts` / `data.extensions.regex_scripts`，**从不看 zodSource**
              // （全仓库 grep 零命中）。于是明明能算出来的状态栏（实测 210219 字节）
              // 被客户端直接跳过，iframe 永远空白。
              // 另外补上定位参数：不带参数时服务端按「最近写入的会话」猜预设，多会话下会
              // 渲染成别的会话的卡。
              //
              // ★ 而且**必须只带一个、且会话 id 优先**：presetId 来自 getActivePresetId()
              //   （酒馆面板的 dataset/localStorage），**切换会话后它可能仍是上一个会话的预设**；
              //   服务端原来又是 `if (presetId) … else if (sessionId) …`，两个都带时 presetId
              //   会盖掉会话 ⇒ 用户实测在「示例角色卡」的会话里看到「示例卡」的状态栏。
              //   会话 id 随会话切换必然变，是唯一不会"粘住"的依据。
              var _sid = (typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : '') || '';
              // ★★ 「以会话声明为准」的正解：先向后端要**该会话的权威预设**。
              //
              //   `/api/tavern/current-session` 的 presetId 是后端 `resolveAuthoritativePresetId()`
              //   算出来的：读 DSH 会话日志（多帧 zstd JSONL）里**最新一条** `agentPreset`
              //   —— 也就是聊天**顶部选择器**的真实选择 —— 取不到才退回
              //   `session-bindings.json`，再退回 default。
              //
              //   为什么不能只送 sessionId（上一版的写法不够）：只有 37/119 个会话在
              //   `session-bindings.json` 里有记录。用户在**顶部选择器**换预设时，DSH 只往
              //   会话事件流里追加 `agent-preset/selected`，**根本不写 bindings** ⇒ 服务端的
              //   `presetIdForSession()` 查不到 ⇒ 那些会话会被当成"未绑定"而落到默认卡，
              //   用户观感仍然是"卡不对"。这条 fetch 拿到的才是真正的会话声明。
              //
              //   ★ 也**不能**退回送 `getActivePresetId()`：那个值来自酒馆面板的
              //   dataset/localStorage，**切换会话后仍是上一个会话的预设**，是串台源本身。
              var _askCard = function (qs) {
                return fetch('/api/muv-table/tavern-card' + qs).then(function (r) { return r.json(); });
              };
              var _cardReq;
              if (!_sid) {
                // **认不出会话**（与上面"判定为非酒馆"是两回事）：什么都不带，服务端落到稳定
                // 默认（tavern-lite）并在 presetSource 里如实标 default —— 不给用户看别人的卡。
                // 这里**不**采用严格模式（不出卡）：会话识别链有 5 级兜底，偶发失败时若直接
                // 不出卡，用户会看到状态栏莫名消失；而"没法判定"不等于"判定为非酒馆"。
                _cardReq = _askCard('');
              } else {
                _cardReq = fetch('/api/tavern/current-session?sessionId=' + encodeURIComponent(_sid))
                  .then(function (r) { return r.json(); })
                  .then(function (cs) {
                    var auth = (cs && cs.ok && cs.presetId) ? String(cs.presetId) : '';
                    // ★ 严格模式（用户 2026-09-20 拍板）：权威解析明确给出 'default'，意思是
                    //   **本会话不是酒馆会话**（用户在 DSH 顶部选了 standard / minimal 等）
                    //   ⇒ **不出卡**。这与酒馆自己的会话隔离判据一致（index.js 的
                    //   `shouldInjectForSession()`：「本会话该不该被酒馆注入」），也最贴
                    //   「在哪个会话就该看哪张卡」—— 不是酒馆会话，就没有"哪张卡"可言。
                    //
                    //   ★ 为什么**不能**退回 `sessionId` 让服务端去查 bindings：实测
                    //   `session-bindings.json` 里有 **21 条与权威声明冲突的过期绑定**，
                    //   其中好几个正是"用户已把会话切成 standard、bindings 里还留着旧酒馆
                    //   预设"⇒ 会在非酒馆会话里照样出一张过期卡 —— 正是用户报的那个观感。
                    //   （裸无参请求也同理，见下面 `!_sid` 分支的说明。）
                    //
                    //   返回 `null` 让下游 `sb` 为 null ⇒ 不渲染状态栏（下游链见 `_cardReq.then`）。
                    if (auth === 'default') {
                      return null;
                    }
                    // 拿不到权威值（端点失败/超时等**无法判定**的情形，与上面"判定为非酒馆"
                    // 是两回事）：保守起见仍按会话解析 —— 不因为一次查询失败就把卡弄没。
                    if (!auth) {
                      return _askCard('?sessionId=' + encodeURIComponent(_sid));
                    }
                    // 这里带的 presetId **就是该会话自己的声明**（不是会粘住的那个），
                    // 所以可以安全地用 preferPreset=1 表达「我就是要它，别管会话」。
                    return _askCard('?presetId=' + encodeURIComponent(auth) + '&preferPreset=1')
                      .then(function (d) {
                        if (d && d.ok && d.found !== false) return d;
                        // 兜底：万一该 presetId 在 muv-table 那边解析不到（两个插件对目录的
                        // 看法不一致、预设被改名等），退回按会话解析 —— **绝不能因此把卡弄没**。
                        return _askCard('?sessionId=' + encodeURIComponent(_sid));
                      });
                  })
                  .catch(function () { return _askCard('?sessionId=' + encodeURIComponent(_sid)); });
              }
              _cardReq.then(function (d) {
                if (d && d.ok && d.regexScripts && d.regexScripts.length) {
                  return fetch('/api/muv-engine/status-bar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) });
                }
              }).then(function (r) { return r ? r.json() : null }).then(function (sb) {
                if (sb && sb.ok && sb.html) {
                  var iframe = document.getElementById(sphId);
                  if (iframe) iframe.srcdoc = sb.html;
                }
              }).catch(function () {});
            } catch (_) {}
          }, 100);
        }

        // ★ <UpdateVariable> → 折叠面板
        var uvRe = /&lt;UpdateVariable&gt;([\s\S]*?)&lt;\/UpdateVariable&gt;|<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
        var uvMatch;
        while ((uvMatch = uvRe.exec(html)) !== null) {
          var uvContent = decodeHtml(uvMatch[1] || uvMatch[2] || '');
          var uvHtml = '<details class="tavern-updatevar"><summary>👾 变量更新</summary><pre>' + esc(uvContent) + '</pre></details>';
          html = html.replace(uvMatch[0], uvHtml);
          modified = true;
        }

        // ★ 示例角色卡 格式：<Status_block> 状态栏: 日期和时间: "..." 地点: "..." 用户列表: - 用户: 名字/行动/内心 行动选项:</Status_block>
        // （区别于严格格式：字段内联在一行，无独立"名字:" 身份:" 状态:" 穿搭:" 动作:" 行）
        var seseRe = /&lt;Status_block&gt;([\s\S]*?)&lt;\/Status_block&gt;|<Status_block>([\s\S]*?)<\/Status_block>/gi;
        var seseMatch;
        while ((seseMatch = seseRe.exec(html)) !== null) {
          var seseContent = decodeHtml(seseMatch[1] || seseMatch[2] || '');
          var seseHtml = parseSeseStatusBlock(seseContent);
          if (seseHtml) {
            html = html.replace(seseMatch[0], '');
            moveToBottom.push(seseHtml);
            modified = true;
          }
        }
        // ★ 剧情选项：只在出现「选项引导语」时启用，且只取引导语之后连续的编号行。
        //   旧实现无条件扫全文的数字列表，再用「接下来 / 请选择 / 你决定」这类
        //   正常正文里也会出现的宽松词去找截断位置 —— 结果是普通回复只要带个编号列表
        //   就被当成选项，消息尾巴还会被从宽松词处切掉、换成按钮。
        //   引导语必须独立成行、足够短、且命中具体句式，才认定后面是选项。
        function extractPlotOptions(rawText) {
          var GUIDE = /(行动选项|可选项|行动如下|选项如下|请选择|接下来(?:你|你想|你打算|要|怎么做)|你想怎么(?:做|办)|你决定|你来决定)/;
          var out = { items: [], guideText: '' };
          var lines = String(rawText || '').split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.length > 30) continue;   // 引导语必须短，才算独立的一行
            if (!GUIDE.test(line)) continue;
            var items = [];
            for (var j = i + 1; j < lines.length; j++) {
              var l = lines[j].trim();
              if (!l) continue;
              // 支持 1. / 1、/ 1) / - / * / · / • / 一、
              var m = l.match(/^(?:[\-\*•·]|\d+\s*[\.、)]|[一二三四五六七八九十]+\s*[、.)])\s*(.+)$/);
              if (!m) break;
              items.push(m[1].trim());
            }
            if (items.length >= 2) {   // 少于两条就不算选项组
              out.items = items;
              out.guideText = line;
              return out;
            }
          }
          return out;
        }
        var plotGuideText = '';
        var plotOpts = extractPlotOptions(text);
        optionList = plotOpts.items;
        plotGuideText = plotOpts.guideText;
        if (optionList.length > 0) {
          console.log('[tavern-beautify] 剧情选项 ' + optionList.length + ' 条，引导语「' + plotGuideText + '」');
        }
        console.log('[tavern-beautify] optionList length:', optionList.length, 'options:', JSON.stringify(optionList));
        console.log('[tavern-beautify] html has 接下来:', (html || '').indexOf('接下来') !== -1, 'has 接下:', (html || '').indexOf('接下') !== -1);
        if (optionList.length > 0) {
          var oh2 = '<div class="tavern-options">';
          for (var oi2 = 0; oi2 < optionList.length; oi2++) {
            // ★ 这里必须携带「选项正文」而不是下标：点击处理器把 data-opt 当作要发送的文本，
            //   原先写的是 oi2，于是点任何一项都只会发出 "0" / "1" / "2"。
            oh2 += '<button class="tavern-option-btn" data-opt="' + esc(optionList[oi2]) + '">';
            oh2 += '<span class="opt-num">' + (oi2 + 1) + '</span>';
            oh2 += esc(optionList[oi2]) + '</button>';
          }
          oh2 += '<div class="tavern-custom-input"><input type="text" placeholder="或者自己输入接下来的行动..." /><button class="tavern-send-custom">发送</button></div></div>';
          // 截断位置只认「刚识别出的那句引导语」——它足够具体，不会在正文里误命中。
          var optCutIdx = -1;
          if (plotGuideText) {
            optCutIdx = (html || '').indexOf(htmlEscapeStr(plotGuideText));
            if (optCutIdx === -1) optCutIdx = (html || '').indexOf(plotGuideText);
          }
          if (optCutIdx !== -1) {
            html = html.substring(0, optCutIdx) + oh2;
          } else {
            // 找不到引导语就不截断，只在末尾追加按钮 —— 绝不切掉正文
            html = html + oh2;
          }
          modified = true;
        }
        // ★ muv-engine 标签渲染（speech/action/thought/game cards 等）
        if (typeof window._tavernRenderTags === 'function') {
          // 先把 &lt;标签&gt; 转义形态还原为真实 <标签>（DSH 可能把 LLM 输出的 XML 标签转义成文本），
          // 然后标签渲染器才能匹配 <choices> <Drama> 等。仅还原标签形态，不破坏其他 HTML 实体。
          var tagHtml = html.replace(/&lt;(\/?)([a-zA-Z\u4e00-\u9fa5][^&>]*?)&gt;/g, '<$1$2>');
          var rendered = window._tavernRenderTags(tagHtml);
          if (rendered !== html) { html = rendered; modified = true; }
        }
        // ★ LaTeX 渲染
        if (typeof window._tavernRenderLatex === 'function') {
          var latexRendered = window._tavernRenderLatex(html);
          if (latexRendered !== html) { html = latexRendered; modified = true; }
        }
        // ★ 状态类卡片统一追加到消息底部（不再停靠在正文前面）
        if (moveToBottom.length) {
          var trailerHtml = moveToBottom.join('');
          // 分隔线 + 卡片
          html += '<div class="tavern-status-trailer">' + trailerHtml + '</div>';
          modified = true;
        }
        if (modified) {
          contentEl.innerHTML = html;
          contentEl.dataset.tavernBeautified = '1';
          // ★ 选项点击统一走 document 委托（window.__tavernOptionDelegate），
          //   不再在此处直接绑定，避免消息重渲染绑丢失导致点击无响应。
          var customInput = contentEl.querySelector('.tavern-custom-input input');
          var customBtn = contentEl.querySelector('.tavern-send-custom');
          if (customInput && customBtn) {
            customBtn.addEventListener('click', function () {
              if (customInput.value.trim()) sendTavernMessage(customInput.value.trim());
            });
            customInput.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' && customInput.value.trim()) sendTavernMessage(customInput.value.trim());
            });
          }
        }
      }

      function decorateMessages() {
        injectBeautifyStyles();
        var msgs = findAiMessages();
        for (var i = 0; i < msgs.length; i++) {
          (function (msgEl, index) {
            if (msgEl.dataset.tavernDecorated) {
              // 剧情标签美化已移交 muv-engine（见文件内 delegateBeautify 的说明）
              delegateBeautify(msgEl);
              return;
            }
            msgEl.dataset.tavernDecorated = '1';

            // 剧情标签美化已移交 muv-engine（见文件内 delegateBeautify 的说明）
            delegateBeautify(msgEl);
          })(msgs[i], i);
        }
      }

      function checkSessionChange() {
        var sid = getSessionId();
        if (sid !== currentSessionId) {
          currentSessionId = sid;
          decorateMessages();
        }
      }

      // 启动监听
      if (observer) observer.disconnect();
      observer = new MutationObserver(function () {
        checkSessionChange();
        decorateMessages();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 初始
      currentSessionId = getSessionId();
      decorateMessages();

      // 定时检查会话切换（有些 SPA 不触发 body mutation）
      setInterval(checkSessionChange, 2000);
    }

    // ── 浮动预设选择条（页面上常驻，随时切换当前会话的 Agent 预设）──
    (function () {
      var PRESET_BAR_ID = 'dsh-tavern-preset-bar';
      var PRESET_PANEL_ID = 'dsh-tavern-preset-panel';
      var currentPresetId = '';
      var currentPresetName = '';
      var presetList = [];
      var pollTimer = null;

      // ★ 2.7.10：与 esc 收敛成**一份实现**。它原先是第二套独立实现 ——
      //   这正是 escAttr 当年的翻车形态（第二套实现漂成空操作，没人发现）。
      //   要改转义规则就改 esc，别在这里复制一份。
      function escapeHtml(s) {
        return esc(s);
      }

      // 浮动面板内的临时提示浮层
      function showPresetStatusHint(msg) {
        try {
          var old = document.getElementById('dsh-tavern-float-hint');
          if (old) old.remove();
          var hint = document.createElement('div');
          hint.id = 'dsh-tavern-float-hint';
          hint.style.cssText = 'position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:2147483647;background:rgba(30,30,46,0.97);color:#f39c12;border:1px solid rgba(243,156,18,0.4);border-radius:10px;padding:12px 18px;font-size:13px;max-width:420px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,0.5);font-family:system-ui,sans-serif;';
          hint.textContent = msg;
          document.body.appendChild(hint);
          setTimeout(function () { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); }, 8000);
        } catch (e) { try { console.log('[tavern] ' + msg); } catch(e2){} }
      }

        // 宽松匹配预设 id：处理前缀不一致的问题（同时给刷新/绑定/按钮更新用，必须在 IIFE 外层作用域）
        function matchPresetId(a, b) {
          if (!a || !b) return false;
          a = String(a);
          b = String(b);
          if (a === b) return true;
          var aNorm = a.replace(/^preset-/, '');
          var bNorm = b.replace(/^preset-/, '');
          if (aNorm === bNorm) return true;
          if (a.length > 8 && b.length > 8 && (a.endsWith(bNorm) || b.endsWith(aNorm))) return true;
          return false;
        }


      function showPrompt(title, defaultValue) {
        return new Promise(function (resolve) {
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
          var box = document.createElement('div');
          box.style.cssText = 'background:var(--dsw-alias-bg-base,#1e1e2e);color:var(--dsw-alias-label-primary,#eee);border-radius:12px;padding:24px;min-width:320px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.1));';
          var t = document.createElement('div');
          t.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:12px;color:var(--dsw-alias-label-primary,#fff);';
          t.textContent = title;
          box.appendChild(t);
          var input = document.createElement('input');
          input.type = 'text';
          input.value = defaultValue || '';
          input.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));background:var(--dsw-alias-bg-layer-2,#16162a);color:var(--dsw-alias-label-primary,#fff);font-size:14px;box-sizing:border-box;margin-bottom:16px;';
          box.appendChild(input);
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
          var cancel = document.createElement('button');
          cancel.textContent = '取消';
          cancel.style.cssText = 'padding:8px 18px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));background:transparent;color:var(--dsw-alias-label-secondary,#ccc);font-size:13px;cursor:pointer;';
          var ok = document.createElement('button');
          ok.textContent = '创建';
          ok.style.cssText = 'padding:8px 18px;border-radius:8px;border:none;background:#e94560;color:#fff;font-size:13px;cursor:pointer;font-weight:600;';
          row.appendChild(cancel); row.appendChild(ok); box.appendChild(row); overlay.appendChild(box);
          document.body.appendChild(overlay);
          setTimeout(function () { input.focus(); }, 50);
          function cleanup() { overlay.remove(); }
          cancel.addEventListener('click', function () { cleanup(); resolve(null); });
          ok.addEventListener('click', function () { cleanup(); resolve(input.value); });
          input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); });
        });
      }

      async function refreshPresets() {
        try {
          // 用 agent-presets 列表：列出 DSH 全部 agent 预设（含酒馆预设、极简/标准/Router 等），id 即目录名
          var r = await fetch('/api/tavern/agent-presets');
          var data = await r.json();
          if (data.ok) {
            presetList = data.presets || [];
            // 同步当前预设名（read 返回的 presetId 是目录名）
            // 始终刷新按钮文字，确保“酒馆面板选择”能实时同步到浮动入口
            updatePresetBar();
          }
        } catch (e) {}
      }

      async function refreshCurrent() {
          try {
            // ★ 统一：优先读取后端 DSH 权威预设（当前会话的真实 agentPreset），
            //   与酒馆面板/DSH 顶部选择器一致；localStorage 仅作离线兜底。
            //   注意：权威值即使是 default 也要采用（default 是合法的酒馆默认预设），
            //   不能因此回退到 localStorage 的旧值导致面板与 DSH 顶部不一致。
            var authoritative = null;
            try {
              var curSid2 = (function () {
                try { return getCurrentSessionId(); } catch (e) { return ''; }
              })();
              var csUrl = '/api/tavern/current-session' + (curSid2 ? '?sessionId=' + encodeURIComponent(curSid2) : '');
              var csR = await fetch(csUrl);
              var csData = await csR.json();
              if (csData && csData.ok && csData.presetId) {
                authoritative = csData.presetId;
              }
            } catch (e) {}
            var pid = authoritative && authoritative !== '' ? authoritative : getActivePresetId();
            if (!pid) return;;
            var url = '/api/tavern/read?presetId=' + encodeURIComponent(pid);
            var r = await fetch(url);
            var data = await r.json();
            if (data.ok) {
              currentPresetId = data.presetId || pid;
              if (!presetList.length) await refreshPresets();
              var cur = presetList.find(function (x) { return matchPresetId(x.id, currentPresetId); });
              currentPresetName = (cur && cur.name) || data.presetName || '默认预设';
              updatePresetBar();
            }
          } catch (e) {}
        }
async function bindPreset(presetId, presetName) {
        try {
          // ★ 统一：切换时写入后端（bindings + DSH 会话事件），三处预设选择保持一致
          
          var curSid = (function () {
            try { return getCurrentSessionId(); } catch (e) { return ''; }
          })();
          if (curSid) {
            try {
              var br = await fetch('/api/tavern/bind-preset', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: curSid, presetId: presetId })
              });
              var bd = await br.json();
              if (bd && bd.ok && bd.started) {
                // 会话已开始：角色卡本体锁定，仅世界书/记忆/关系网跟随
                try { showPresetStatusHint('⚠️ 当前会话已开始，角色卡本体（agent 预设）已锁定；本次仅让世界书/记忆跟随「' + (presetName || presetId) + '」。完整角色卡需新开会话在顶部选择。'); } catch(e){}
              }
            } catch (e) {}
          }
          setActivePresetId(presetId);
          currentPresetId = presetId;
          currentPresetName = presetName || currentPresetName || '默认预设';
          // notify tavern manager panel
          try { document.dispatchEvent(new CustomEvent('tavern-preset-changed-from-float', { detail: { presetId: presetId, presetName: presetName || currentPresetName } })); } catch(e) {}
          if (!presetList.length) await refreshPresets();
          var cur = presetList.find(function (x) { return matchPresetId(x.id, currentPresetId); });
          if (cur && cur.name) currentPresetName = cur.name;
          updatePresetBar();
          document.documentElement.setAttribute('data-tavern-preset-changed', String(Date.now()));
        } catch (e) {}
      }

      async function createPreset(name, copyFrom) {
        try {
          var r = await fetch('/api/tavern/presets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, copyFrom: copyFrom })
          });
          return await r.json();
        } catch (e) { return { ok: false }; }
      }

      async function deletePreset(id) {
        try {
          var r = await fetch('/api/tavern/preset/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id })
          });
          return await r.json();
        } catch (e) { return { ok: false }; }
      }

      function updatePresetBar() {
        var bar = document.getElementById(PRESET_BAR_ID);
        if (!bar) return;
        var nameEl = bar.querySelector('.dsh-pb-name') || bar.querySelector('.pb-name');
        var iconEl = bar.querySelector('.dsh-pb-icon') || bar.querySelector('span');
        // 优先使用 currentPresetName（如果已经有值且不是默认预设），避免被 presetList 里的名称覆盖
        var displayName = currentPresetName;
        var currentPreset = presetList.find(function (x) { return matchPresetId(x.id, currentPresetId); });
        if (!displayName || displayName === '默认预设' || displayName === '预设') {
          displayName = (currentPreset && currentPreset.name) || displayName || '默认预设';
        }
        var mode = (currentPreset && currentPreset.mode) || 'roleplay';
        if (iconEl) iconEl.textContent = mode === 'creative' ? '✍️' : '🎭';
        if (nameEl) {
          nameEl.textContent = displayName;
          nameEl.style.cssText = 'font-weight:600;color:var(--dsw-alias-brand-primary,#7ab8ff);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        }
        bar.title = '当前预设：' + displayName + '（点击切换）';
      }
      // 监听酒馆面板的预设变更事件，保持同步
      document.addEventListener('tavern-preset-changed', function(e) {
        try {
          if (e.detail && e.detail.presetId) {
            currentPresetId = e.detail.presetId;
            currentPresetName = e.detail.presetName || currentPresetName;
            updatePresetBar();
          } else {
            refreshCurrent();
          }
        } catch(err) {}
      });
      
      function ensurePresetBar() {
        var bar = document.getElementById(PRESET_BAR_ID);
        if (bar && bar.isConnected) {
          // 旧版浮动按钮可能只有 .pb-name（没有新版 .dsh-pb-name），直接重建，避免按钮文字一直停在“默认预设”
          if (!bar.querySelector('.dsh-pb-name')) {
            bar.remove();
          } else {
            return bar;
          }
        }
        // 用原生 button：默认可点击；不透明实色背景（去掉半透明+blur，避免 Windows 上点击区域与视觉错位）
        bar = document.createElement('button');
        bar.id = PRESET_BAR_ID;
        bar.type = 'button';
        bar.innerHTML = '<span class="dsh-pb-icon" style="pointer-events:none;">🎭</span><span class="dsh-pb-name" style="pointer-events:none;">预设</span><span class="dsh-pb-arrow" style="pointer-events:none;">▾</span>';
        bar.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:8px 14px;font-size:13px;font-weight:600;background:var(--dsw-alias-bg-layer-1,#2a2a3e);border:2px solid var(--dsw-alias-brand-primary,rgba(233,69,96,0.6));border-radius:20px;cursor:pointer;user-select:none;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.5);line-height:1;margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';
        bar.addEventListener('mouseenter', function () { bar.style.borderColor = 'rgba(233,69,96,1)'; bar.style.background = '#3a3a55'; });
        bar.addEventListener('mouseleave', function () { bar.style.borderColor = 'var(--dsw-alias-brand-primary,rgba(233,69,96,0.6))'; bar.style.background = '#2a2a3e'; });
        // 捕获阶段监听，避免被其他元素 stopPropagation 拦截
        bar.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); togglePresetPanel(bar); }, true);
        // 挂到根元素而非 body，层级更高
        (document.documentElement || document.body).appendChild(bar);
        // 立即更新按钮显示当前预设名
        try { updatePresetBar(); } catch(e) {}
        return bar;
      }

      function togglePresetPanel(bar) {
        var panel = document.getElementById(PRESET_PANEL_ID);
        if (panel && panel.isConnected) { panel.remove(); return; }
        // 打开面板前先拉最新绑定，确保当前预设高亮准确
        refreshCurrent().then(function () {
          var p2 = document.getElementById(PRESET_PANEL_ID);
          if (p2 && p2.isConnected) return; // 已打开则不动
          if (!presetList.length) {
            refreshPresets().then(function () { showPresetPanel(bar); });
          } else {
            showPresetPanel(bar);
          }
        });
      }

      function showPresetPanel(bar) {
        var old = document.getElementById(PRESET_PANEL_ID);
        if (old) old.remove();
        var panel = document.createElement('div');
        panel.id = PRESET_PANEL_ID;
        var rect = bar.getBoundingClientRect();
        // 面板宽度固定（右缘对齐按钮右边缘向左展开）；窄版 220px
        var panelW = Math.min(220, Math.max(180, window.innerWidth - 16));
        // 按钮在右下角：面板向上展开（bottom 对齐按钮顶部），避免超出屏幕
        var maxH = Math.min(360, window.innerHeight - 16);
        var bottomGap = Math.max(8, window.innerHeight - rect.top + 8);
        panel.style.cssText = 'position:fixed;bottom:' + bottomGap + 'px;right:' + Math.max(8, (window.innerWidth - rect.right)) + 'px;width:' + panelW + 'px;max-height:' + maxH + 'px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#1e1e2e);border:1px solid var(--dsw-alias-brand-primary,rgba(233,69,96,0.3));border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);z-index:2147483647;color:var(--dsw-alias-label-primary,#eee);overflow:hidden;';
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#bbb);font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));';
        header.innerHTML = '<span>🎯 当前 Agent 预设</span><span id="tavern-pb-count" style="font-size:10px;color:#777;font-weight:400;"></span>';
        panel.appendChild(header);
        // 当前预设名（顶栏下方一行小字，一眼可见当前绑定的是什么）
        var currentRow = document.createElement('div');
        currentRow.id = 'tavern-pb-current';
        currentRow.style.cssText = 'padding:4px 10px 6px;font-size:11px;color:var(--dsw-alias-brand-primary,#7ab8ff);border-bottom:1px solid rgba(255,255,255,0.06);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        currentRow.textContent = '当前：' + ((currentPresetName && currentPresetName !== '默认预设') ? currentPresetName : '酒馆默认');
        panel.appendChild(currentRow);

        // 搜索框：预设多时快速过滤
        var search = document.createElement('input');
        search.type = 'text';
        search.placeholder = '🔍 搜索预设…';
        search.style.cssText = 'margin:8px 10px 2px;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:var(--dsw-alias-label-primary,#eee);font-size:12px;outline:none;box-sizing:border-box;width:calc(100% - 20px);';
        search.addEventListener('keydown', function (e) { e.stopPropagation(); });
        panel.appendChild(search);

        // 列表容器（可滚动，高度受限不挡界面）
        var listBox = document.createElement('div');
        listBox.style.cssText = 'flex:1;overflow-y:auto;padding:4px 6px 6px;min-height:40px;';
        panel.appendChild(listBox);

        var groups = [
          { key: 'tavern', label: '🍺 酒馆预设' },
          { key: 'builtin', label: '⚙️ 原生内置（DSH）' }
        ];

        function gKeyFor(p) {
          // 只有两个组：tavern = 酒馆预设；其余全部归「原生内置（DSH）」显示
          // —— 插件/自定义预设（如梁神模式）也并入内置组，不再单独分组
          var o = p.origin || 'other';
          if (o === 'tavern') return 'tavern';
          var id = String(p.id || '');
          if (id === 'tavern' || id === 'tavern-lite') return 'tavern';
          return 'builtin';
        }

        // 宽松匹配预设 id：处理前缀不一致的问题
        function matchPresetId(a, b) {
          if (!a || !b) return false;
          a = String(a);
          b = String(b);
          if (a === b) return true;
          // 去掉 preset- 前缀再比较
          var aNorm = a.replace(/^preset-/, '');
          var bNorm = b.replace(/^preset-/, '');
          if (aNorm === bNorm) return true;
          // 后缀匹配
          if (a.length > 8 && b.length > 8 && (a.endsWith(bNorm) || b.endsWith(aNorm))) return true;
          return false;
        }

        // 分组折叠状态（记住上次选择，localStorage 持久化；首次使用默认全折叠）
        var collapsed = { tavern: true, builtin: true };
        try {
          var savedCollapsed = localStorage.getItem('dsh-tavern-groups-collapsed');
          if (savedCollapsed) {
            var parsedCollapsed = JSON.parse(savedCollapsed);
            for (var ck in collapsed) if (typeof parsedCollapsed[ck] === 'boolean') collapsed[ck] = parsedCollapsed[ck];
          }
        } catch (e) {}

        function renderList(filter) {
          listBox.innerHTML = '';
          var shown = 0;
          var searching = filter && String(filter).trim().length > 0;
          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            var items = presetList.filter(function (p) {
              if (gKeyFor(p) !== grp.key) return false;
              if (searching && String(p.name || '').toLowerCase().indexOf(filter.toLowerCase()) < 0) return false;
              return true;
            });
            if (!items.length) continue;
            var isOpen = searching ? true : !collapsed[grp.key];
            // 组头（可点击折叠/展开）
            var gHead = document.createElement('div');
            gHead.dataset.groupKey = grp.key;
            gHead.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);font-weight:600;cursor:pointer;border-radius:5px;user-select:none;';
            gHead.innerHTML = '<span style="font-size:9px;color:var(--dsw-alias-label-tertiary,#666);display:inline-block;transition:transform .15s;' + (isOpen ? 'transform:rotate(90deg);' : '') + '">▶</span><span style="flex:1;">' + esc(grp.label) + '</span><span style="font-size:10px;color:var(--dsw-alias-label-tertiary,#666);">' + items.length + ' 个</span>';
            // 当前预设所在组加 ● 提示
            var hasActive = items.some(function (p) { return matchPresetId(p.id, currentPresetId); });
            if (hasActive && !searching) {
              var dot = document.createElement('span');
              dot.style.cssText = 'color:var(--dsw-alias-brand-primary,#7ab8ff);font-size:10px;';
              dot.textContent = '●';
              gHead.appendChild(dot);
            }
            gHead.addEventListener('mouseenter', function () { this.style.background = 'rgba(255,255,255,0.12)'; });
            gHead.addEventListener('mouseleave', function () { this.style.background = ''; });
            gHead.addEventListener('click', function (e) {
              e.stopPropagation();
              var k = this.dataset.groupKey;
              collapsed[k] = !collapsed[k];
              try { localStorage.setItem('dsh-tavern-groups-collapsed', JSON.stringify(collapsed)); } catch (err) {}
              renderList(search ? search.value : '');
            });
            listBox.appendChild(gHead);
            shown += items.length;
            // 组内容（折叠时隐藏）
            if (isOpen) {
              items.forEach(function (p) {
                var item = document.createElement('div');
                var isActive = matchPresetId(p.id, currentPresetId);
                item.dataset.presetId = p.id;
                item.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px;' + (isActive ? 'background:rgba(59,127,240,0.12);color:#3b7ff0;font-weight:600;' : '');
                var pMeta2 = '';
              if (p.displayNames && p.displayNames.length) pMeta2 += '🎭' + escapeHtml(p.displayNames.join('、'));
              if (typeof p.wbCount === 'number') pMeta2 += ' 📚' + p.wbCount + '本';
              if (typeof p.modCount === 'number') pMeta2 += ' ⚙' + p.modCount + '模块';
              if (!pMeta2) pMeta2 = '（无角色/世界书/模块）';
                item.innerHTML = '<span style="width:12px;flex:0 0 auto;text-align:center;">' + (isActive ? '✓' : '') + '</span><span style="flex:1;margin:0;display:flex;flex-direction:column;align-items:flex-start;line-height:1.3"><span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(p.name) + '</span><span style="font-size:9px;color:var(--dsw-alias-label-tertiary,#888);font-weight:400;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + pMeta2 + '</span></span><span style="font-size:10px;color:var(--dsw-alias-label-tertiary,#888);flex:0 0 auto;">' + (p.cardChars ? (p.cardChars + '字') : '') + '</span>';
                item.addEventListener('click', function (e) { e.stopPropagation(); bindPreset(p.id, p.name); panel.remove(); });
                item.addEventListener('mouseenter', function () { if (!isActive) item.style.background = 'var(--dsw-alias-border-l1,rgba(255,255,255,0.08))'; });
                item.addEventListener('mouseleave', function () { if (!isActive) item.style.background = ''; });
                listBox.appendChild(item);
              });
            }
          }
          var cnt = document.getElementById('tavern-pb-count');
          if (cnt) cnt.textContent = shown + ' 个';
          if (!shown) {
            var empty = document.createElement('div');
            empty.style.cssText = 'padding:14px 8px;text-align:center;color:var(--dsw-alias-label-tertiary,#666);font-size:12px;';
            empty.textContent = '无匹配预设';
            listBox.appendChild(empty);
          }
        }
        renderList('');
        search.addEventListener('input', function () { renderList(search.value || ''); });

        // 新建预设
        var newBtn = document.createElement('div');
        newBtn.style.cssText = 'margin-top:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.1));font-size:12px;color:var(--dsw-alias-brand-primary,#7ab8ff);cursor:pointer;border-radius:6px;';
        newBtn.textContent = '＋ 新建空白预设';
        newBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          showPrompt('新预设名称：', '新预设').then(function (name) {
            if (name && name.trim()) {
              createPreset(name.trim(), '').then(function (res) {
                panel.remove();
                // Select what we just created. Without this the panel kept the
                // session-bound preset active, so the next "add character card /
                // worldbook" saved into that older preset instead of the new one.
                var created = res && res.ok && res.preset;
                if (created && created.id) {
                  bindPreset(created.id, created.name || name.trim()).then(function () {
                    document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: created.id, presetName: created.name || name.trim() } }));
                    refreshPresets();
                  });
                } else {
                  refreshPresets();
                }
              });
            }
          });
        });
        panel.appendChild(newBtn);

        // 复制当前预设
        var copyBtn = document.createElement('div');
        copyBtn.style.cssText = 'margin-top:4px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-brand-primary,#7ab8ff);cursor:pointer;border-radius:6px;';
        copyBtn.textContent = '⧉ 复制当前预设';
        copyBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!currentPresetId) { try { alert('当前没有选中预设，无法复制'); } catch (err) {} return; }
          showPrompt('复制预设名称：', '新预设').then(function (name) {
            if (name && name.trim()) {
              createPreset(name.trim(), currentPresetId).then(function (res) {
                panel.remove();
                // Same as 新建: switch to the copy so later edits land on it.
                var created = res && res.ok && res.preset;
                if (created && created.id) {
                  bindPreset(created.id, created.name || name.trim()).then(function () {
                    document.dispatchEvent(new CustomEvent('tavern-preset-changed', { detail: { presetId: created.id, presetName: created.name || name.trim() } }));
                    refreshPresets();
                  });
                } else {
                  refreshPresets();
                }
              });
            }
          });
        });
        panel.appendChild(copyBtn);

        // 批量删除
        var batchBtn = document.createElement('div');
        batchBtn.style.cssText = 'margin-top:4px;padding:8px 10px;font-size:12px;color:#e74c3c;cursor:pointer;border-radius:6px;';
        batchBtn.textContent = '🗑️ 批量删除预设';
        batchBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (panel.querySelector('.batch-mode')) {
            panel.querySelectorAll('.batch-item').forEach(function (el) { el.remove(); });
            var ba = panel.querySelector('.batch-actions');
            if (ba) ba.remove();
            batchBtn.textContent = '🗑️ 批量删除预设';
            return;
          }
          batchBtn.textContent = '❌ 取消批量删除';
          var items = panel.querySelectorAll('[data-preset-id]');
          items.forEach(function (it) {
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'batch-check';
            cb.style.cssText = 'margin-right:4px;cursor:pointer';
            cb.dataset.presetId = it.dataset.presetId;
            it.insertBefore(cb, it.firstChild);
            it.classList.add('batch-item');
            it.onclick = function (ev) { ev.stopPropagation(); cb.checked = !cb.checked; };
          });
          var selectAllDiv = document.createElement('div');
          selectAllDiv.className = 'batch-item';
          selectAllDiv.style.cssText = 'padding:6px 10px;font-size:12px;color:var(--dsw-alias-brand-primary,#7ab8ff);cursor:pointer;border-bottom:1px solid rgba(255,255,255,.1)';
          selectAllDiv.innerHTML = '<label style="cursor:pointer"><input type="checkbox" id="batch-select-all" style="cursor:pointer;margin-right:4px"> 全选 / 取消全选</label>';
          if (items[0]) listBox.insertBefore(selectAllDiv, items[0]);
          var allCb = panel.querySelector('#batch-select-all');
          if (allCb) allCb.addEventListener('change', function (ev) {
            panel.querySelectorAll('.batch-check').forEach(function (c) { c.checked = ev.target.checked; });
          });
          var actions = document.createElement('div');
          actions.className = 'batch-actions';
          actions.style.cssText = 'display:flex;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1);';
          var delBtn = document.createElement('span');
          delBtn.style.cssText = 'flex:1;text-align:center;padding:6px;font-size:12px;background:#e74c3c;color:#fff;cursor:pointer;border-radius:4px;font-weight:600;';
          delBtn.textContent = '删除选中';
          delBtn.addEventListener('click', function () {
            var checked = panel.querySelectorAll('.batch-check:checked');
            var ids = [];
            checked.forEach(function (c) { ids.push(c.dataset.presetId); });
            if (!ids.length) return;
            Promise.all(ids.map(function (id) { return deletePreset(id); })).then(function () {
              panel.remove();
              refreshPresets();
            });
          });
          var cancelBtn = document.createElement('span');
          cancelBtn.style.cssText = 'flex:1;text-align:center;padding:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;border-radius:4px;';
          cancelBtn.textContent = '取消';
          cancelBtn.addEventListener('click', function () { panel.remove(); });
          actions.appendChild(delBtn); actions.appendChild(cancelBtn);
          listBox.appendChild(actions);
        });
        panel.appendChild(batchBtn);

        document.body.appendChild(panel);
        function closeHandler(ev) {
          if (!panel.contains(ev.target) && !bar.contains(ev.target)) panel.remove();
        }
        setTimeout(function () { document.addEventListener('click', closeHandler); }, 0);
      }

      function getSessionIdFromDOM() {
        try {
          // ★ 修复：格式校验 + 属性缓存降级。悬浮栏切换会话后属性可能是旧值，
          //   且 DOM 元素 data-id 未必是会话 ID（可能是任意 id），必须校验后才采用。
          function okSid(s) { return /^(session-)?[a-f0-9-]{20,}$/i.test(String(s || '')); }
          var selectors = [
            '[data-session-id]', '.session-item.active', '[class*="active"][data-id]',
            '[class*="conversation-item"][class*="active"]', '[class*="chat-item"][class*="active"]',
            '[data-testid*="session"][class*="active"]', '.conversation-item.selected',
            '[class*="sidebar"] [class*="item"][class*="active"]'
          ];
          // 1. 优先 URL（切换会话的强信号）
          var urlM = location.href.match(/session[\/=:-]([a-f0-9-]{20,})/i);
          if (urlM && okSid(urlM[1])) return (urlM[1] || '').toLowerCase().indexOf('session-') === 0 ? urlM[1] : 'session-' + urlM[1];
          // 2. DOM 当前活动会话（active 类更新）
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el) {
              var sid = el.getAttribute('data-session-id') || el.getAttribute('data-id') || el.id || '';
              if (okSid(sid)) return sid;
            }
          }
          // 3. 缓存属性兜底
          var fromData = document.documentElement.getAttribute('data-dsh-current-session');
          if (okSid(fromData) && fromData.length > 10) return fromData;
        } catch (e) {}
        return '';
      }

      function initPresetBar() {
        var bar = ensurePresetBar();
        // 不在此处 fetch（避免被高频调用），数据由 start()/轮询/面板打开时拉取
        return bar;
      }

      function start(ctx) {
        // 初始：创建按钮并拉一次数据
        var bar0 = initPresetBar();
        if (bar0) { refreshPresets(); refreshCurrent(); }
        var observer = new MutationObserver(function () {
          // 高频 DOM 变化（聊天渲染/打字/滚动）时只确保按钮存在，绝不做网络请求（fetch 由定时轮询负责，避免控制台刷错）
          var bar = document.getElementById(PRESET_BAR_ID);
          if (!bar || !bar.isConnected) {
            var nb = ensurePresetBar();
            if (nb) { refreshPresets(); refreshCurrent(); }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        var ensureTimer = setInterval(function () {
          var bar = document.getElementById(PRESET_BAR_ID);
          if (!bar || !bar.isConnected) {
            var nb2 = ensurePresetBar();
            if (nb2) { refreshPresets(); }
          }
        }, 3000);
        pollTimer = setInterval(function () { refreshCurrent(); }, 4000);
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              observer.disconnect();
              clearInterval(ensureTimer);
              clearInterval(pollTimer);
            };
          }, 'dsh-tavern: preset bar');
        }
      }

      window.__DSH_TAVERN_PRESET_BAR__ = null; // 浮动预设选择条：已去掉（2026-09-27 作者二次确认不要；代码保留，待底层方案取代）
    })();

    // ── 聊天输入框点击守卫（诊断 + 自愈）──────────────────────────────
    // 症状（用户实测）：点完「🎓 技能」的按钮后，页面其它部分一切正常，但聊天输入框点不动、
    // 光标不出来、打不了字，只能重启 DSH ⇒ 典型的「有个 fixed 浮层压在输入框上」。
    // 这里每 1.5 秒做一次很便宜的体检：取输入框中线上一点，问 elementFromPoint 命中的是谁。
    //   · 命中**酒馆自己的**浮层（id/class 带 tavern）⇒ 让它对点击透明（自愈），并记到面板状态行；
    //   · 命中**别人的**元素 ⇒ 只报告名字（绝不动别人的 DOM），把证据留下来以便定位。
    // 设置页正开着时直接跳过（那时输入框被页面盖住属于正常布局）。
    function findComposerEl() {
      var cands = []
      try {
        cands = Array.prototype.slice.call(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      } catch (e) { return null }
      var best = null
      for (var i = 0; i < cands.length; i++) {
        try {
          var el = cands[i]
          if (!el.isConnected) continue
          if (el.closest && el.closest('#tavern-manager')) continue   // 酒馆面板自己的输入框不算
          var r = el.getBoundingClientRect()
          if (r.width < 180 || r.height < 18) continue
          if (r.top < window.innerHeight * 0.5) continue              // 只认视口下半部（聊天输入框在那儿）
          if (r.bottom > window.innerHeight + 4) continue
          var cs = getComputedStyle(el)
          if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue
          var area = r.width * r.height
          if (!best || area > best.area) best = { el: el, rect: r, area: area }
        } catch (e2) {}
      }
      return best
    }

    function installComposerClickGuard() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      if (window.__tavernComposerGuard) return
      window.__tavernComposerGuard = true
      var last = ''
      var check = function () {
        try {
          if (document.visibilityState && document.visibilityState !== 'visible') return
          var panel = document.getElementById('tavern-manager')
          if (panel && panel.getBoundingClientRect().height > 0) { last = ''; return }
          var found = findComposerEl()
          if (!found) { last = ''; return }
          var r = found.rect
          var top = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + Math.min(12, r.height / 2))
          )
          if (!top || top === found.el || found.el.contains(top)) { last = ''; return }
          if (top === document.body || top === document.documentElement) return
          var id = String(top.id || '')
          var cls = typeof top.className === 'string' ? top.className : ''
          var desc = top.tagName.toLowerCase() + (id ? '#' + id : '') + (cls ? '.' + cls.slice(0, 60) : '')
          var ours = /tavern/i.test(id) || /tavern/i.test(cls)
          if (ours) {
            try {
              top.style.pointerEvents = 'none'
              top.setAttribute('data-tavern-guard-neutralized', '1')
            } catch (e) {}
            desc = desc + '（酒馆浮层，已自动放行点击）'
          }
          if (desc === last) return
          last = desc
          try { console.warn('[tavern] 聊天输入框被遮挡: ' + desc) } catch (e) {}
          var st = document.getElementById('tavern-skill-status')
          if (st) st.textContent = (st.textContent || '') + '　|　⚠️ 输入框曾被遮挡：' + desc
        } catch (e) {}
      }
      setTimeout(check, 900)
      setInterval(check, 1500)
    }

    function apply(ctx) {
      console.log('[dsh-tavern] settings-section plugin loaded (v2 fixed)');
      // ★ 把 ctx 本身存到 window 上：`sessions` 服务是**异步 provide** 的，apply() 跑的那一刻
      //   它可能还不存在。旧代码只把 `ctx.get('sessions')` 的**当时结果**挂到
      //   `__DSH_TAVERN_SESSIONS__`，拿到 undefined 就**永久**是 undefined，之后
      //   `getCurrentSessionId()` 一路退化到 URL → 面包屑 → `data-dsh-current-session`
      //   属性（切换会话后是**旧值**）⇒ 用上一个会话的 id 去查 session-bindings.json
      //   ⇒ 渲染出上一张卡（串台）。留下 ctx，让检测函数每次调用都能重试解析。
      try { window.__DSH_TAVERN_CTX__ = ctx; } catch (e) {}
      // ★ 挂载 DSH 会话服务：ctx.sessions 提供当前激活会话（list.getSnapshot().current），
      //   这是 DSH 官方 UI 的权威会话状态，比 URL/DOM 探测可靠得多。
      //   记忆/关系网模块通过 window.__DSH_TAVERN_SESSIONS__ 读取当前会话。
      try {
        var sessionsSvc = null;
        if (ctx && typeof ctx.get === 'function') sessionsSvc = ctx.get('sessions');
        // ★ 不能再裸读 `ctx.sessions`：Cordis 对未声明 `inject` 的服务属性**取值即抛**
        //   （实测控制台：`[dsh-tavern] sessions mount failed: Error: cannot get property
        //   "sessions" without inject`）。这里改成受保护访问，语义不变：声明了 inject 时
        //   一样能拿到；没声明时安静地走 `ctx.get('sessions')`（异步 provide 的服务本来
        //   就该走它 —— `getCurrentSessionId()` 里还有一条每次调用重试的懒解析）。
        if (!sessionsSvc && ctx) {
          try { sessionsSvc = ctx.sessions; } catch (_) { sessionsSvc = null; }
        }
        window.__DSH_TAVERN_SESSIONS__ = sessionsSvc;
        if (sessionsSvc) console.log('[dsh-tavern] sessions service mounted:', !!sessionsSvc.list);
        else console.warn('[dsh-tavern] ctx.sessions unavailable, fallback to DOM/URL detection');
      } catch (e) { console.warn('[dsh-tavern] sessions mount failed:', e); }
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-tavern: dictionaries");
      var t = ctx.locale.bind(NS);
      var slots = ctx.slots;
      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "tavern-manager",
          order: 25,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(TavernSettingsSection, props);
        });
      });
      // 浮动预设选择条：已去掉（2026-09-27 作者二次确认）。不再启动；代码保留待底层方案。
      try {
        console.log('[tavern] preset bar removed (author confirmed)');
      } catch (e) {}
      // 启动 AI 回复美化（剧情标签 / 状态栏 / 选项渲染）
      try { initMessageBeautifier(); } catch (e) { console.error('[tavern] message beautifier init failed', e); }
      // 聊天输入框点击守卫（诊断 + 自愈）：见 findComposerEl / installComposerClickGuard 的注释。
      // 用户实测「点完 🎓 技能 的按钮后输入框点不动、只能重启 DSH」——它负责下一次发生时当场点名。
      try { installComposerClickGuard(); } catch (e) { console.error('[tavern] composer guard init failed', e); }
      // （剧情选项点击交互已由 tavern-beautify 的 sendTavernMessage 处理）
      // ★ 剧情选项点击：document 级委托（一次注册永不丢失；直接绑定会因消息重渲染/流式输出而失效）
      if (!window.__tavernOptionDelegate) {
        window.__tavernOptionDelegate = true;
        document.addEventListener('click', function (e) {
          var el = e.target && e.target.closest ? e.target.closest('.tavern-option-btn, .dsh-tv-option-item') : null;
          if (!el) return;
          e.preventDefault();
          e.stopPropagation();
          var t = el.getAttribute('data-opt') || (el.textContent || '').trim().replace(/^\d+[\s、.．:：]*/, '').trim();
          if (t) sendTavernMessage(t);
        }, true);
      }
      // 隐藏 yml 板块
      try {
        var hideYml = function () {
          var ta = document.getElementById('tavern-agent-yml');
          if (ta) {
            ta.style.display = 'none';
            var lbl = ta.previousElementSibling;
            if (lbl && lbl.textContent && lbl.textContent.indexOf('agent.cordis.yml') >= 0) lbl.style.display = 'none';
          }
        };
        var ymlObs = new MutationObserver(function () { hideYml(); });
        ymlObs.observe(document.body, { childList: true, subtree: true });
        hideYml();
      } catch (e) { console.error('[tavern] hide yml failed', e); }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
