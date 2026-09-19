window.__ModuleLoader__.load({
  id: "dsh-tavern",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ===== dsh-tavern 前端美化渲染器 (inlined) =====
    // 把模型输出的酒馆标签自动识别并渲染成美化卡片
    (function (root, factory) {
      const api = factory()
      // 注意：不能设置 module.exports —— 因为工厂的 module 是插件局部变量，
      // 赋值会覆盖 exports.inject / exports.apply，导致插件初始化失败。
      if (typeof window !== 'undefined') window.DshTavernRender = api
    })(typeof self !== 'undefined' ? self : this, function () {
      const TAG_ALIASES = {
        main: 'maintext', maintext: 'maintext', narrative: 'maintext', story: 'maintext',
        status: 'status', status_bar: 'status', status_block: 'status', block: 'status',
        game_status: 'status', scene: 'status',
        details: 'details', detail: 'details', diary: 'details',
        prism: 'prism', Prism: 'prism',
        updatevariable: 'updatevar', UpdateVariable: 'updatevar',
        statusplaceholder: 'statusph', StatusPlaceHolder: 'statusph'
      }
      function normTag(name) { const n = String(name || '').toLowerCase(); return TAG_ALIASES[n] || n }
      const TAG_NAME = 'main|maintext|narrative|story|status|status_bar|status_block|block|game_status|scene|details?|diary|Prism|prism|UpdateVariable|updatevariable|StatusPlaceHolder|StatusPlaceHolderImpl'
      function scanBlocks(text) {
        if (!text || text.indexOf('<') < 0) return []
        const blocks = []; const stack = []
        const re = new RegExp('<(/?)(' + TAG_NAME + ')\\b[^>]*>', 'gi'); let m
        while ((m = re.exec(text)) !== null) {
          const slash = !!m[1]; const tag = normTag(m[2]); const contentStart = m.index + m[0].length
          if (!slash) { stack.push({ tag, contentStart, rawStart: m.index }) } else {
            let idx = -1; for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].tag === tag) { idx = i; break } }
            if (idx < 0) continue
            const open = stack[idx]; const body = text.slice(open.contentStart, m.index); const raw = text.slice(open.rawStart, m.index + m[0].length)
            stack.splice(idx, stack.length - idx); blocks.push({ tag: open.tag, body, raw, start: open.rawStart, end: m.index + m[0].length })
          }
        }
        if (stack.length) { const open = stack[0]; blocks.push({ tag: open.tag, body: text.slice(open.contentStart), raw: text.slice(open.contentStart), start: open.rawStart, end: text.length }) }
        blocks.sort((a, b) => a.start - b.start); return blocks
      }
      function cleanText(s) { return String(s || '').replace(/^\s*[-*•]\s+/, '').replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1').trim() }
      function parseStatusBlock(body) {
        const lines = String(body || '').split(/\r?\n/); const meta = {}; const characters = []; const options = []; let section = null
        const cur = () => characters[characters.length - 1]
        for (const rl of lines) {
          const trimmed = rl.replace(/\r/g, '').trim()
          if (!trimmed) continue
          if (/^(状态栏|状态|角色列表|读者列表|人物列表|行动选项|行动|场景描述|时间地点)\s*[:：]?\s*$/.test(trimmed)) {
            if (/行动选项/.test(trimmed) || trimmed === '行动') section = 'options'
            else if (/[角色读者人物]/.test(trimmed)) section = 'chars'
            else section = 'meta'; continue
          }
          { const mm = /^(日期时间|时间|此刻时间|地点|位置|场景|氛围|天气|当前时间)\s*[:：]\s*(.+)$/.exec(trimmed)
            if (mm) { meta[mm[1].toLowerCase()] = cleanText(mm[2]); continue } }
          { const cs = /^-\s*(角色|读者|人物|名字)\s*[:：]\s*(.+)$/.exec(trimmed)
            if (cs) { characters.push({ name: cleanText(cs[2]) }); section = 'chars'; continue } }
          if (section === 'chars' && characters.length) {
            const sub = /^(名字|角色|读者|状态|心情|情绪|内心|想法|思考|动作|表情|动作表情)\s*[:：]\s*(.+)$/.exec(trimmed)
            if (sub) {
              const k = sub[1]; const v = cleanText(sub[2]); const c = cur()
              if (k === '名字' || k === '角色' || k === '读者') { if (v) c.name = v }
              else if (k === '状态' || k === '心情' || k === '情绪') c.state = v
              else if (k === '内心' || k === '想法' || k === '思考') c.thought = v
              else if (k === '动作' || k === '表情' || k === '动作表情') c.surround = v
              else if (v) c[k] = v
            }; continue
          }
          if (section === 'options') {
            const m2 = trimmed.match(/^(?:[-*+]\s*|\d+\s*[.）)]\s*)(.+)$/)
            options.push(m2 ? cleanText(m2[1]) : cleanText(trimmed)); continue
          }
          if (section === null) {
            const loose = /^([\u4e00-\u9fa5A-Za-z]{2,8})\s*[:：]\s*(.+)$/.exec(trimmed)
            if (loose) meta[loose[1].toLowerCase()] = cleanText(loose[2])
          }
        }
        return { meta, characters, options }
      }
      function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
      function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
      function renderMaintext(body) { return '<div class="dsh-tv-maintext">' + String(body || '').split(/\r?\n/).map(function(l){return escHtml(l)}).join('<br>') + '</div>' }
      function renderStatusCard(parsed) {
        const meta = parsed.meta || {}; const chars = parsed.characters || []; const opts = parsed.options || []; const metaHtml = []
        if (meta['时间'] || meta['日期时间']) metaHtml.push('<span class="dsh-tv-meta">⏰ ' + escHtml(meta['时间'] || meta['日期时间']) + '</span>')
        if (meta['地点']) metaHtml.push('<span class="dsh-tv-meta">📍 ' + escHtml(meta['地点']) + '</span>')
        if (meta['天气']) metaHtml.push('<span class="dsh-tv-meta">🌤 ' + escHtml(meta['天气']) + '</span>')
        if (meta['场景']) metaHtml.push('<span class="dsh-tv-meta">🌆 ' + escHtml(meta['场景']) + '</span>')
        const charHtml = chars.map(function (c, i) {
          const name = escHtml(c.name || ('角色' + (i + 1)))
          const state = c.state ? '<div class="dsh-tv-char-state">' + escHtml(c.state) + '</div>' : ''
          const thought = c.thought ? '<div class="dsh-tv-char-thought">💭 ' + escHtml(c.thought) + '</div>' : ''
          return '<div class="dsh-tv-char"><strong class="dsh-tv-char-name">' + name + '</strong>' + state + thought + '</div>'
        }).join('')
        const optHtml = opts.length ? '<ul class="dsh-tv-options">' + opts.map(function(o){return '<li>' + escHtml(o) + '</li>'}).join('') + '</ul>' : ''
        return '<div class="dsh-tv-card">' + (metaHtml.length ? '<div class="dsh-tv-meta-row">' + metaHtml.join('') + '</div>' : '') + (charHtml ? '<div class="dsh-tv-chars">' + charHtml + '</div>' : '') + (optHtml ? '<div class="dsh-tv-opt-title">行动选项</div>' + optHtml : '') + '</div>'
      }
      function renderBlock(tag, body) {
        if (tag === 'status') return renderStatusCard(parseStatusBlock(body))
        if (tag === 'details') return '<div class="dsh-tv-details">' + escHtml(body) + '</div>'
        if (tag === 'prism') return renderPrism(body)
        if (tag === 'updatevar') return renderUpdateVar(body)
        if (tag === 'statusph') return renderStatusPH(body)
        return renderMaintext(body)
      }
      function renderPrism(body) {
        return '<div class="dsh-tv-prism"><div class="dsh-tv-prism-title">📋 角色指令</div><pre>' + escHtml(body) + '</pre></div>'
      }
      function renderUpdateVar(body) {
        return '<details class="dsh-tv-updatevar"><summary>👾 变量更新</summary><pre>' + escHtml(body) + '</pre></details>'
      }
      function renderStatusPH(body) {
        // Try to extract HTML from the body (regex scripts inject HTML here)
        const html = extractHtml(body)
        if (html) {
          const id = 'dsh-tv-iframe-' + Math.random().toString(36).slice(2,8)
          return '<div class="dsh-tv-status-bar"><iframe id="'+id+'" class="dsh-tv-iframe" srcdoc="'+escAttr(html)+'" sandbox="allow-scripts" style="width:100%;height:600px;border:none;border-radius:8px;background:transparent"></iframe></div>'
        }
        return '<div class="dsh-tv-status-bar"><div class="dsh-tv-status-placeholder">📊 状态栏占位</div></div>'
      }
      function extractHtml(text) {
        // Try to find HTML content in markdown code blocks or direct HTML
        const m = text.match(/```html\s*([\s\S]*?)```/i)
        if (m) return m[1]
        if (/<html|<body|<style/i.test(text)) return text
        return null
      }
      function beautifyText(text) {
        // First handle self-closing tags
        let enhanced = text.replace(/<StatusPlaceHolderImpl\s*\/>/gi, function(match) {
          return '<StatusPlaceHolder><StatusPlaceHolderImpl/></StatusPlaceHolder>'
        })
        const blocks = scanBlocks(enhanced)
        if (!blocks.length) return { html: escHtml(enhanced), hasBlocks: false }
        const segs = []; let cursor = 0
        for (const b of blocks) {
          if (b.start > cursor) segs.push(escHtml(text.slice(cursor, b.start)))
          segs.push('<div class="dsh-tv-block" data-tv-tag="' + b.tag + '">' + renderBlock(b.tag, b.body) + '</div>')
          cursor = b.end
        }
        if (cursor < text.length) segs.push(escHtml(text.slice(cursor)))
        return { html: segs.join(''), hasBlocks: true }
      }
      function installDOM(options) {
        options = options || {}; const root = options.root || document.body; const autoRun = options.auto !== false
        let observer = null; let timeout = null; let keepAlive = true
        function processElement(el) {
          if (!el || el.getAttribute('data-tv-rendered') === '1') return false
          const text = el.textContent || ''
          if (text.indexOf('<maintext') < 0 && text.indexOf('<Status') < 0 && text.indexOf('<status') < 0 && text.indexOf('<game_status') < 0 && text.indexOf('<Prism') < 0 && text.indexOf('<UpdateVariable') < 0 && text.indexOf('<StatusPlaceHolder') < 0) return false
          const res = beautifyText(text)
          if (res.hasBlocks) { el.setAttribute('data-tv-rendered', '1'); el.innerHTML = res.html; return true }
          return false
        }
        function scan() {
          if (!keepAlive) return; const els = document.querySelectorAll('*')
          for (const el of els) { if (el && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.getAttribute && el.getAttribute('data-tv-rendered') !== '1') processElement(el) }
        }
        function schedule() { if (timeout) clearTimeout(timeout); timeout = setTimeout(function () { timeout = null; if (keepAlive) scan() }, 200) }
        observer = new MutationObserver(function () { if (autoRun && keepAlive) schedule() })
        observer.observe(root, { childList: true, subtree: true, characterData: true })
        if (autoRun) setTimeout(scan, 100)
        return { stop: function () { keepAlive = false; if (observer) { observer.disconnect(); observer = null }; if (timeout) { clearTimeout(timeout); timeout = null } }, rescan: function () { scan() } }
      }
      function injectStyle(parent) {
        var style = document.getElementById('dsh-tv-style')
        if (style) return style; style = document.createElement('style')
        style.id = 'dsh-tv-style'
        style.textContent = '.dsh-tv-block{margin:8px 0}.dsh-tv-maintext{line-height:1.7;padding:4px 0}.dsh-tv-card{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #334;border-radius:12px;padding:16px;color:#e0e0e0;font-size:14px}.dsh-tv-meta-row{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #334}.dsh-tv-meta{font-size:13px;color:#aab}.dsh-tv-chars{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}.dsh-tv-char{background:rgba(255,255,255,0.05);border-radius:8px;padding:8px 12px}.dsh-tv-char-name{color:#e8e8f0}.dsh-tv-char-state{color:#aac;font-size:13px;margin-top:2px}.dsh-tv-char-thought{color:#99b;font-size:12px;margin-top:2px}.dsh-tv-opt-title{font-size:13px;font-weight:bold;color:#ccd;margin-bottom:4px}.dsh-tv-options{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px}.dsh-tv-options li{background:rgba(255,255,255,0.08);border:1px solid #445;border-radius:6px;padding:4px 10px;font-size:13px;color:#dde;cursor:default}.dsh-tv-details{background:rgba(0,0,0,0.2);border-left:3px solid #667;padding:8px 12px;border-radius:0 8px 8px 0;font-size:13px;color:#aab}.dsh-tv-prism{background:rgba(30,40,60,0.6);border:1px solid #445;border-radius:8px;overflow:hidden;margin:8px 0}.dsh-tv-prism-title{font-size:11px;font-weight:600;padding:6px 12px;background:rgba(0,0,0,0.3);color:#8af;border-bottom:1px solid #445}.dsh-tv-prism pre{font-size:12px;padding:10px 14px;margin:0;color:#bbc;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:300px;overflow:auto}.dsh-tv-updatevar{background:rgba(40,30,20,0.5);border:1px solid #554;border-radius:8px;margin:8px 0;overflow:hidden}.dsh-tv-updatevar summary{font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;color:#ca8;background:rgba(0,0,0,0.2);user-select:none}.dsh-tv-updatevar pre{font-size:11px;padding:8px 14px;margin:0;color:#998;white-space:pre-wrap;word-break:break-word;line-height:1.4;max-height:250px;overflow:auto}.dsh-tv-status-bar{margin:8px 0;border:1px solid #334;border-radius:8px;overflow:hidden}.dsh-tv-status-placeholder{text-align:center;padding:20px;color:#667;font-size:13px}.dsh-tv-iframe{display:block}'
        ;(parent || document.head || document.body).appendChild(style); return style
      }
      function install(options) { options = options || {}; injectStyle(options.styleParent || null); return installDOM(options) }
      return { beautifyText: beautifyText, scanBlocks: scanBlocks, parseStatusBlock: parseStatusBlock, install: install }
    });
    // ===== end renderer =====

    var ENTRY_SELECTOR = '[data-dsh-tavern-manager-entry]';
    var PANEL_SELECTOR = '[data-dsh-tavern-manager-view]';
    var ACTIVE_ATTR = 'data-dsh-tavern-manager-active';

    function sidebarRoot() {
      var column = document.querySelector('[data-slot="sidebar"], [data-pane="sidebar"], [class*="sidebarCol"]');
      if (!column) return undefined;
      var logoOwner = column.querySelector('[class*="logoRow"]') ? column.querySelector('[class*="logoRow"]').parentElement : undefined;
      return logoOwner || (column.firstElementChild || undefined);
    }

    function newSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested) return nested;
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].tagName === 'BUTTON') return root.children[i];
      }
      return undefined;
    }

    function createEntry() {
      var entry = document.createElement('button');
      entry.type = 'button';
      entry.dataset.dshTavernManagerEntry = '';
      entry.textContent = '🍺 酒馆管理';
      entry.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;background:rgba(255,255,255,.06);border:none;color:#e8ecf4;cursor:pointer;font-size:13px;text-align:left;border-radius:8px;';
      return entry;
    }

    function placeEntry(root, entry) {
      var button = newSessionButton(root);
      if (!button) {
        if (entry.parentElement !== root) root.appendChild(entry);
        return true;
      }
      if (entry.parentElement !== root) {
        var row = button.closest('[class*="logoRow"]');
        var base = (row && row.parentElement === root) ? row : button;
        root.insertBefore(entry, base.nextElementSibling);
      }
      return true;
    }

    function yamlLiteral(str) {
      var clean = String(str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return '|-\n' + clean.split('\n').map(function (line) { return '      ' + line; }).join('\n');
    }

    function sanitizeForHarness(text, charName) {
      var s = String(text || '');
      s = s.replace(/\{\{random::([^}]*)\}\}/g, function (_, inner) { return String(inner || '').split(/[,，]/)[0].trim() || ''; });
      s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
      s = s.replace(/\{\{user\}\}/g, '你');
      s = s.replace(/\{\{char\}\}/g, charName || '角色');
      s = s.replace(/\{\{[^}]*\}\}/g, '');
      return s;
    }

    function truncate(str, max) {
      var s = String(str || '');
      return s.length > max ? s.slice(0, max) + '…' : s;
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function parseJsonText(text) {
      return JSON.parse(text);
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
          var nul = str.indexOf('\0');
          if (nul >= 0 && str.slice(0, nul) === keyword) return str.slice(nul + 1);
        }
        if (type === 'zTXt') {
          var zstr = '';
          for (var j = 0; j < data.length; j++) zstr += String.fromCharCode(data[j]);
          var znul = zstr.indexOf('\0');
          if (znul < 0 || zstr.slice(0, znul) !== keyword) continue;
          var method = data[znul + 1];
          if (method !== 0) continue;
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

    function buildAgentYml(state) {
      var sections = [];
      // 多个角色卡（启用中的全部合并）
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
      // 多个世界书（启用中的全部条目）
      var wbEntries = [];
      (state.worldbooks || []).forEach(function (wb) {
        if (!wb.enabled) return;
        (wb.entries || []).forEach(function (e, i) {
          if (e.enabled === false) return;
          var key = Array.isArray(e.keys) ? e.keys.join(', ') : (e.key || e.name || e.comment || ('世界书' + (i + 1)));
          if (e.content || e.text) wbEntries.push('【' + key + '】\n' + truncate(sanitizeForHarness(e.content || e.text || '', ''), 800));
        });
      });
      if (wbEntries.length) sections.push('# 世界书\n' + wbEntries.slice(0, 12).join('\n\n'));
      // 当前选中的预设 -> 启用模块 + 足部
      var activeP = (state.presets && state.presets[state.activePresetIdx]) || null;
      if (activeP) {
        var enabledModules = (activeP.modules || []).filter(function (p) { return p.enabled && p.content; });
        if (enabledModules.length) {
          var modParts = enabledModules.slice(0, 8).map(function (p) {
            return '【' + (p.name || '模块') + '】\n' + truncate(sanitizeForHarness(p.content, ''), 600);
          });
          sections.push('# 预设模块\n' + modParts.join('\n\n'));
        }
        if (activeP.footNote) sections.push('# 足部描写\n' + activeP.footNote);
      }
      if (state.extraPrompt) sections.push('# 自定义设定\n' + state.extraPrompt);
      var nsfwText = state.nsfw ? '你是成人向角色扮演/小说写作助手。允许并擅长描写成人、色情、亲密、暴力等成熟题材。内容仅限虚构，所有角色均已成年。可以详细描写足部、脚部等癖好。请根据用户需求大胆展开，不要拒绝成人内容。保持人设和文风，自然地推动剧情。' : '你是角色扮演助手。请严格扮演当前角色，保持人设，自然地推动剧情。';
        sections.push('# 写作要求\n' + nsfwText + '\n所有思考、推理、内心独白必须使用中文。');
      var combined = sanitizeForHarness(sections.join('\n\n'), '');
      var agentYml = '# 酒馆管理面板生成\n- id: persona\n  name: \'@deepseek-ai/dsh-persona\'\n  config:\n    text: ' + yamlLiteral(combined) + '\n    complete: true\n    includeRuntimeContext: false\n';
      var presetYml = 'name: 精简酒馆\ndescription: 由 Harness 酒馆管理面板生成。\n';
      return { agentYml: agentYml, presetYml: presetYml };
    }

    function insertIntoInput(text) {
      var input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea') || document.querySelector('[class*="composer"] textarea');
      if (!input) return false;
      var value = '';
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        value = input.value || '';
        input.value = value + (value ? '\n' : '') + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = (input.textContent || '') + '\n' + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }

    function createPanel() {
      var container = document.createElement('div');
      container.dataset.dshTavernManagerView = '';
      container.id = 'tavern-manager';
        container.style.cssText = 'position:absolute;inset:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);z-index:999;display:none;overflow:auto;padding:24px;box-sizing:border-box;';
      container.innerHTML = [
        '<style>#tavern-manager{font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;color:var(--dsw-alias-label-primary)}#tavern-manager h2{font-size:20px;font-weight:700;color:var(--dsw-alias-label-primary)}#tavern-manager button{cursor:pointer;border:none;border-radius:8px;padding:8px 14px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:13px;transition:filter .15s}#tavern-manager button:hover{filter:brightness(.92)}#tavern-manager input[type="file"]{padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}#tavern-manager textarea,#tavern-manager input:not([type="file"]){border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;font-size:13px;font-family:inherit;resize:vertical;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}#tavern-manager label{font-size:13px;color:var(--dsw-alias-label-secondary)}#tavern-manager .card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,.04)}#tavern-manager .card strong{font-size:14px;color:var(--dsw-alias-label-primary)}#tavern-manager .item{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:13px;color:var(--dsw-alias-label-primary)}#tavern-manager #tavern-close,#tavern-manager #tavern-refresh{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}#tavern-manager #tavern-save{background:var(--dsw-alias-brand-primary)}#tavern-manager #tavern-status{margin-top:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}</style>',
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0">🍺 酒馆管理（原生）</h2><button id="tavern-close" type="button">✕ 关闭</button></div>',
        '<div style="display:flex;flex-direction:column;gap:10px;max-width:800px">',
        '  <div class="card"><strong>角色卡</strong>（支持 PNG / JSON，可导入多份）<div id="tavern-char-list" style="margin-top:6px"></div><div style="margin-top:4px"><input type="file" id="tavern-char-file" accept=".json,.png,image/png,application/json"> <button id="tavern-insert-char" type="button">插入当前对话</button></div></div>',
        '  <div class="card"><strong>世界书</strong>（支持 JSON，可导入多份）<div id="tavern-wb-list" style="margin-top:6px"></div><div style="margin-top:4px"><input type="file" id="tavern-wb-file" accept=".json,application/json"> <button id="tavern-insert-wb" type="button">插入当前对话</button></div></div>',
        '  <div class="card"><strong>预设</strong>（支持 JSON，可导入多份并切换）<div id="tavern-preset-list" style="margin-top:6px"></div><div style="margin-top:4px"><input type="file" id="tavern-preset-file" accept=".json,application/json"> <button id="tavern-insert-foot" type="button">插入足部描写</button></div></div>',
          '  <div class="card"><strong>🧠 记忆模块 · 自选 API</strong><label style="display:block;margin:8px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)">API 地址（OpenAI 兼容 /chat/completions）</label><input id="tavern-api-url" style="width:100%;margin-top:2px" placeholder="https://opencode.ai/zen/go/v1/chat/completions 或 https://api.deepseek.com/chat/completions"><label style="display:block;margin:8px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)">API 秘钥</label><input id="tavern-api-key" type="password" style="width:100%;margin-top:2px" placeholder="sk-..."><label style="display:block;margin:8px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)">模型</label><input id="tavern-api-model" style="width:100%;margin-top:2px" value="deepseek-chat"><div style="display:flex;align-items:center;gap:8px;margin-top:10px"><label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)"><input type="checkbox" id="tavern-auto-enabled"> 自动总结</label><label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)">每 <input id="tavern-auto-every" type="number" min="1" value="20" style="width:64px;text-align:center"> 楼总结一次</label><button id="tavern-api-save" type="button">💾 保存设置</button></div><div id="tavern-api-status" style="color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px"></div></div>',
          '  <div class="card"><strong>🔗 角色关系网</strong>（可视化角色关系）<div id="tavern-relations-graph" style="margin-top:6px"></div><textarea id="tavern-relations-data" rows="6" style="width:100%;box-sizing:border-box;margin-top:6px" placeholder="{&quot;nodes&quot;:[{&quot;id&quot;:&quot;陈平安&quot;,&quot;label&quot;:&quot;陈平安&quot;}],&quot;edges&quot;:[{&quot;source&quot;:&quot;陈平安&quot;,&quot;target&quot;:&quot;阿良&quot;,&quot;label&quot;:&quot;好友&quot;}]}"></textarea><div style="margin-top:4px"><button id="tavern-relations-save" type="button">保存关系网</button> <button id="tavern-relations-render" type="button">刷新图谱</button></div></div>',
          '  <div class="card"><strong>🚀 手动总结</strong>（读取最近对话，自动写入记忆并更新关系网）<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)">最近 <input id="tavern-summarize-rounds" type="number" min="1" value="20" style="width:64px;text-align:center"> 楼</label><button id="tavern-summarize-run" type="button">📝 立即总结</button></div><div id="tavern-summary-preview" style="color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;margin-top:6px"></div></div>',
          '  <div class="card"><strong>🧠 记忆</strong>（自动写入 / 可直接编辑保存，会注入到 Harness 预设）<textarea id="tavern-memory-text" rows="6" style="width:100%;box-sizing:border-box;margin-top:6px" placeholder="当前记忆内容..."></textarea><div style="margin-top:4px"><button id="tavern-memory-save" type="button">保存记忆</button> <button id="tavern-memory-load" type="button">读取记忆</button></div></div>',
        '  <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="tavern-nsfw" checked> 🔞 NSFW 写作模式</label>',
        '  <div class="card"><strong>🔗 卡片注入</strong>（把保存的卡片直接写进全局系统提示，所有工作区每轮都能读到，不再依赖会话预设）<label style="display:flex;align-items:center;gap:6px;margin-top:4px"><input type="checkbox" id="tavern-inject"> 启用全局注入</label><div id="tavern-inject-status" style="color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px"></div></div>',
        '  <div class="card"><strong>🎯 对哪些会话生效</strong>\n<label style="display:block;margin:4px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)">生效模式（决定角色卡/世界书/预设只对谁注入）</label>\n<label style="display:flex;align-items:center;gap:6px;margin-top:2px"><input type="radio" name="tavern-mode" value="allowlist" id="tavern-mode-allow"> 白名单：只在下面列表里的会话生效（默认都不吃卡）</label>\n<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="tavern-mode" value="global" id="tavern-mode-global"> 全局：所有会话都生效（可用底部排除列表）</label>\n<div id="tavern-nowcwd" style="color:var(--dsw-alias-label-secondary);font-size:12px;margin:4px 0"></div>\n<div id="tavern-allow-box">\n  <label style="display:block;margin-bottom:2px">🎯 生效的会话（白名单，一行一个工作区目录）</label>\n  <textarea id="tavern-allow" rows="3" style="width:100%;box-sizing:border-box;font-size:12px" placeholder="只有这些工作区的会话才加载角色卡/世界书/预设，例如：C:/Users/xxx/.dsh/.agent-presets/酒馆角色扮演"></textarea>\n  <div style="display:flex;align-items:center;gap:4px;margin-top:4px"><input id="tavern-allow-add" type="text" placeholder="或粘贴一个工作区目录，回车加入白名单" style="flex:1;min-width:0;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px"> <button id="tavern-allow-add-btn" style="padding:6px 10px">加入</button></div>\n  <div style="display:flex;gap:6px;margin-top:6px"><button id="tavern-allow-now" style="padding:6px 10px">＋ 把当前工作区加进白名单</button><button id="tavern-allow-save" style="padding:6px 10px">💾 保存生效列表</button></div>\n</div>\n<div id="tavern-ignore-box" style="display:none">\n  <label style="display:block;margin-bottom:2px">🚫 排除的工作区（全局模式下不注入，一行一个目录）</label>\n  <textarea id="tavern-ignore" rows="3" style="width:100%;box-sizing:border-box;font-size:12px" placeholder="这些工作区不加载角色卡，例如：C:/Users/xxx/.dsh/.agent-presets/ui调整"></textarea>\n  <div style="display:flex;gap:6px;margin-top:6px"><button id="tavern-ignore-now" style="padding:6px 10px">＋ 把当前工作区加进排除</button><button id="tavern-ignore-save" style="padding:6px 10px">💾 保存排除列表</button></div>\n</div>\n<div id="tavern-scope-status" style="color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px"></div>\n</div>',
        '  <label>额外设定 / 系统提示</label><textarea id="tavern-extra" rows="4" style="width:100%;box-sizing:border-box" placeholder="可写额外世界观、文风、角色关系等"></textarea>',
        '  <label>当前将保存的 agent.cordis.yml</label><textarea id="tavern-agent-yml" rows="12" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px"></textarea>',
        '  <div style="display:flex;gap:8px"><button id="tavern-save" style="padding:8px 16px">💾 保存到 Harness</button><button id="tavern-refresh" style="padding:8px 16px">🔄 读取当前</button></div>',
        '  <div id="tavern-status" style="color:var(--dsw-alias-label-secondary);font-size:13px"></div>',
        '</div>'
      ].join('');
      return container;
    }

    function apply(ctx) {
      console.log('[dsh-tavern] manager plugin loaded');
      if (window.__dshTavernManagerInstance && typeof window.__dshTavernManagerInstance.dispose === 'function') {
        try { window.__dshTavernManagerInstance.dispose(); } catch (e) {}
        window.__dshTavernManagerInstance = null;
      }
      document.querySelectorAll(PANEL_SELECTOR).forEach(function (el) { el.remove(); });
      document.querySelectorAll(ENTRY_SELECTOR).forEach(function (el) { el.remove(); });
      document.documentElement.removeAttribute(ACTIVE_ATTR);

      // 启动酒馆标签美化渲染器
      try {
        if (typeof window.DshTavernRender !== 'undefined' && typeof window.DshTavernRender.install === 'function') {
          window.DshTavernRender.install();
          console.log('[dsh-tavern] renderer installed');
        }
      } catch (e) { console.warn('[dsh-tavern] renderer install failed:', e); }

      var entry, root, placed = false, container;
      var disposers = [];
      var state = { characters: [], worldbooks: [], presets: [], activePresetIdx: -1, extraPrompt: '', nsfw: true };

      function loadCurrent() {
        return fetch('/api/tavern/read').then(function (r) { return r.json(); }).then(function (data) {
          var ta = container.querySelector('#tavern-agent-yml');
          if (ta && data.agentYml) ta.value = data.agentYml;
          var st = container.querySelector('#tavern-status');
          if (st) st.textContent = '已读取当前预设：' + (data.dir || '');
          var ig = container.querySelector('#tavern-ignore');
          if (ig) ig.value = (data.disabledCwds || []).join('\n');
          var al = container.querySelector('#tavern-allow');
          if (al) al.value = (data.allowCwds || []).join('\n');
          var mode = data.mode || 'allowlist';
          var rAl = container.querySelector('#tavern-mode-allow');
          var rGl = container.querySelector('#tavern-mode-global');
          if (rAl) rAl.checked = mode === 'allowlist';
          if (rGl) rGl.checked = mode === 'global';
          var sc = container.querySelector('#tavern-scope-status');
          if (sc) sc.textContent = mode === 'allowlist'
            ? '白名单模式：默认不吃卡，只有下面列表的会话生效。'
            : '全局模式：所有会话都会加载，除下方排除列表。';
          var now = container.querySelector('#tavern-nowcwd');
          if (now) now.textContent = data.currentCwd ? ('📁 最近工作区：' + data.currentCwd) : '（尚未检测到工作区——发一条消息后读取）';
          var iNow = container.querySelector('#tavern-ignore-now');
          if (iNow) iNow.dataset.cwd = data.currentCwd || '';
          var aNow = container.querySelector('#tavern-allow-now');
          if (aNow) aNow.dataset.cwd = data.currentCwd || '';
          return fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (sdata) {
            var cb = container.querySelector('#tavern-inject');
            var ist = container.querySelector('#tavern-inject-status');
            if (cb && sdata.ok) cb.checked = !!sdata.cardEnabled;
            if (ist && sdata.ok) {
              var m = sdata.mode || 'allowlist';
              var cnt = m === 'allowlist' ? (sdata.allowCwds || []).length : (sdata.disabledCwds || []).length;
              ist.textContent = sdata.cardEnabled
                ? (m === 'allowlist'
                    ? ('✅ 注入中（白名单）：仅 ' + cnt + ' 个会话生效')
                    : ('✅ 注入中（全局）：所有会话生效' + (cnt ? '，排除 ' + cnt + ' 个工作区' : '')))
                : '❌ 未注入：卡片已关闭（可在面板里开启）';
            }
          }).catch(function () {});
        });
      }

      function saveCurrent() {
        var ta = container.querySelector('#tavern-agent-yml');
        var agentYml = ta ? ta.value : '';
        var presetYml = 'name: 精简酒馆\ndescription: 由 Harness 酒馆管理面板生成。\n';
        return fetch('/api/tavern/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentYml: agentYml, presetYml: presetYml })
        }).then(function (r) { return r.json(); }).then(function (data) {
          var st = container.querySelector('#tavern-status');
          if (st) st.textContent = data.ok ? '✅ 已保存到 ' + data.dir + '；卡片已同步到全局系统提示（若开启注入），下轮对话即生效' : '❌ ' + (data.error || '保存失败');
          return fetch('/api/tavern/state').then(function (r) { return r.json(); }).then(function (sdata) {
            var ist = container.querySelector('#tavern-inject-status');
            if (ist && sdata.ok) ist.textContent = sdata.cardEnabled
              ? '✅ 注入中：当前卡片已进入系统提示，所有工作区每轮可见'
              : '❌ 未注入：卡片只对「精简酒馆」预设的新会话生效';
          }).catch(function () {});
        });
      }

      function refreshYml() {
        var built = buildAgentYml(state);
        var ta = container.querySelector('#tavern-agent-yml');
        if (ta) ta.value = built.agentYml;
      }

        function renderCharacters() {
          var el = container.querySelector('#tavern-char-list');
          if (!el) return;
          if (!state.characters.length) {
            el.innerHTML = '<div style="color:var(--dsw-alias-label-tertiary)">尚未导入角色卡（可导入多份）</div>';
            return;
          }
          el.innerHTML = state.characters.map(function (c, i) {
            var checked = c.enabled !== false ? 'checked' : '';
            return '<div class="item" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px">' +
              '<label style="display:flex;align-items:center;gap:6px;flex:1;min-width:120px"><input type="checkbox" data-char="' + i + '" ' + checked + '> <strong>' + esc(c.name || ('角色' + (i + 1))) + '</strong></label>' +
              '<button data-char-del="' + i + '" type="button">删除</button>' +
              '<div style="width:100%;color:var(--dsw-alias-label-secondary);font-size:12px">' + esc(truncate(c.desc || '', 60)) + '</div></div>';
          }).join('');
          el.querySelectorAll('[data-char]').forEach(function (cb) {
            cb.addEventListener('change', function () {
              state.characters[Number(cb.getAttribute('data-char'))].enabled = cb.checked;
              refreshYml();
            });
          });
          el.querySelectorAll('[data-char-del]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              state.characters.splice(Number(btn.getAttribute('data-char-del')), 1);
              renderCharacters();
              refreshYml();
            });
          });
        }

        function renderWorldbooks() {
          var el = container.querySelector('#tavern-wb-list');
          if (!el) return;
          if (!state.worldbooks.length) {
            el.innerHTML = '<div style="color:var(--dsw-alias-label-tertiary)">尚未导入世界书（可导入多份）</div>';
            return;
          }
          el.innerHTML = state.worldbooks.map(function (wb, i) {
            var checked = wb.enabled !== false ? 'checked' : '';
            var open = wb.open === true;
            var entries = (wb.entries || []).map(function (e, j) {
              var key = Array.isArray(e.keys) ? e.keys.join(', ') : (e.key || e.name || e.comment || ('条目' + (j + 1)));
              var echk = e.enabled !== false ? 'checked' : '';
              return '<div style="padding-left:18px;margin-top:2px"><div style="display:flex;align-items:center;gap:5px"><input type="checkbox" data-wbe="' + i + '" data-wbi="' + j + '" ' + echk + '> <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"><strong>' + esc(key) + '</strong></span></div><div style="font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:22px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(truncate(e.content || e.text || '', 60)) + '</div></div>';
            }).join('');
            var count = (wb.entries || []).length;
            return '<div class="item" style="padding:6px 10px">' +
              '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px">' +
              '<button data-wb-toggle="' + i + '" type="button" style="background:transparent;border:none;padding:0 4px;font-size:12px;color:var(--dsw-alias-label-secondary)">' + (open ? '▾' : '▸') + '</button>' +
              '<label style="display:flex;align-items:center;gap:6px;flex:1;min-width:120px;cursor:pointer"><input type="checkbox" data-wb="' + i + '" ' + checked + '> <strong>' + esc(wb.name || ('世界书' + (i + 1))) + '</strong> <span style="color:var(--dsw-alias-label-tertiary);font-size:11px">(' + count + '条)</span>' + (wb.linkedTo ? '<span style="font-size:11px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 6px">🔗 联动自：' + esc(wb.linkedTo) + '</span>' : '') + '</label>' +
              '<button data-wb-del="' + i + '" type="button">删除</button></div>' +
              (open ? '<div style="margin-top:4px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:4px">' + entries + '</div>' : '') +
              '</div>';
          }).join('');
          el.querySelectorAll('[data-wb-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var i = Number(btn.getAttribute('data-wb-toggle'));
              state.worldbooks[i].open = !(state.worldbooks[i].open === true);
              renderWorldbooks();
            });
          });
          el.querySelectorAll('[data-wb]').forEach(function (cb) {
            cb.addEventListener('change', function () {
              var wb = state.worldbooks[Number(cb.getAttribute('data-wb'))];
              wb.enabled = cb.checked;
              (wb.entries || []).forEach(function (e) { e.enabled = cb.checked; });
              renderWorldbooks();
              refreshYml();
            });
          });
          el.querySelectorAll('[data-wbe]').forEach(function (cb) {
            cb.addEventListener('change', function () {
              var i = Number(cb.getAttribute('data-wbe')); var j = Number(cb.getAttribute('data-wbi'));
              var e = state.worldbooks[i].entries[j];
              if (e) e.enabled = cb.checked;
              refreshYml();
            });
          });
          el.querySelectorAll('[data-wb-del]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              state.worldbooks.splice(Number(btn.getAttribute('data-wb-del')), 1);
              renderWorldbooks();
              refreshYml();
            });
          });
        }

        function renderPresets() {
          var el = container.querySelector('#tavern-preset-list');
          if (!el) return;
          if (!state.presets.length) {
            el.innerHTML = '<div style="color:var(--dsw-alias-label-tertiary)">尚未导入预设（可导入多份并切换）</div>';
            return;
          }
          el.innerHTML = state.presets.map(function (p, i) {
            var isActive = state.activePresetIdx === i;
            var mods = (p.modules || []).map(function (m, j) {
              var mchk = m.enabled !== false ? 'checked' : '';
              return '<div style="padding-left:18px;display:flex;align-items:center;gap:5px;margin-top:2px"><input type="checkbox" data-pm="' + i + '" data-pmi="' + j + '" ' + mchk + '> <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(m.name || ('模块' + (j + 1))) + '</span></div>';
            }).join('');
            return '<div class="item">' +
              '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;' + (isActive ? 'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;margin:-2px;padding:2px;border-radius:6px;' : '') + '">' +
              '<strong>' + esc(p.name || ('预设' + (i + 1))) + '</strong>' +
              '<button data-preset-active="' + i + '" type="button" style="' + (isActive ? 'background:var(--dsw-alias-brand-primary);color:#fff;' : '') + '">' + (isActive ? '✓ 当前预设' : '切换到此预设') + '</button>' +
              '<button data-preset-del="' + i + '" type="button">删除</button></div>' +
              (mods ? '<div style="margin-top:4px">' + mods + '</div>' : '') + '</div>';
          }).join('');
          el.querySelectorAll('[data-preset-active]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              state.activePresetIdx = Number(btn.getAttribute('data-preset-active'));
              renderPresets();
              refreshYml();
            });
          });
          el.querySelectorAll('[data-pm]').forEach(function (cb) {
            cb.addEventListener('change', function () {
              var i = Number(cb.getAttribute('data-pm')); var j = Number(cb.getAttribute('data-pmi'));
              var m = state.presets[i].modules[j];
              if (m) m.enabled = cb.checked;
              refreshYml();
            });
          });
          el.querySelectorAll('[data-preset-del]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              state.presets.splice(Number(btn.getAttribute('data-preset-del')), 1);
              if (state.activePresetIdx >= state.presets.length) state.activePresetIdx = state.presets.length - 1;
              renderPresets();
              refreshYml();
            });
          });
        }

      function handleCharFile(file) {
        if (!file) return Promise.resolve();
        function addCard(json) {
          var card = json && json.data && typeof json.data === 'object' ? json.data : json;
          var name = card.name || '';
          state.characters.push({
            name: name,
            desc: card.description || card.personality || card.char_persona || '',
            first: card.first_mes || card.first_message || card.char_greeting || '',
            enabled: true
          });
          // 联动：角色卡内嵌的"角色世界书(character_book)"一起导入
          var cb = (card && card.character_book) || (card && card.world_book);
          if (cb && Array.isArray(cb.entries) && cb.entries.length) {
            var wbEntries = cb.entries.filter(function (e) { return e && (e.content || e.text); }).map(function (e) { e.enabled = e.enabled !== false; return e; });
            if (wbEntries.length) {
              var wbName = (cb.name || cb.title || (name ? name + '的世界书' : '角色世界书'));
              state.worldbooks.push({ name: wbName, entries: wbEntries, enabled: true, linkedTo: name || '' });
            }
          }
          renderCharacters();
          renderWorldbooks();
          refreshYml();
        }
        if (file.name.toLowerCase().endsWith('.png') || file.type === 'image/png') {
          return extractPngChara(file).then(addCard);
        }
        return file.text().then(function (text) { addCard(parseJsonText(text)); });
      }

      function handleWbFile(file) {
        if (!file) return Promise.resolve();
        return file.text().then(function (text) {
          var data = parseJsonText(text);
          var list = Array.isArray(data) ? data : (data.entries || data.world_book || data.worldbook || []);
          if (!Array.isArray(list)) list = Object.values(list || {});
          var entries = list.filter(function (e) { return e && (e.content || e.text); }).map(function (e) { e.enabled = e.enabled !== false; return e; });
          var name = (data && (data.name || data.title || data.comment)) || file.name.replace(/\.[^.]+$/, '');
          state.worldbooks.push({ name: name, entries: entries, enabled: true });
          renderWorldbooks();
          refreshYml();
        });
      }

      function handlePresetFile(file) {
        if (!file) return Promise.resolve();
        return file.text().then(function (text) {
          var data = parseJsonText(text);
          var prompts = Array.isArray(data.prompts) ? data.prompts : (data.data && data.data.prompts) || [];
          var footParts = [];
          for (var i = 0; i < prompts.length; i++) {
            var p = prompts[i];
            var name = p.name || p.identifier || '';
            var content = p.content || '';
            if (/足部|脚|foot/i.test(name) || /足部|脚|foot/i.test(content)) {
              footParts.push('【' + name + '】\n' + truncate(sanitizeForHarness(content, ''), 1200));
            }
          }
          var footNote = footParts.join('\n\n') || '【足部描写】\n请根据剧情需要自然加入足部、脚部、脚踝等细节描写。';
          var modules = prompts.map(function (p) { return { name: p.name || p.identifier || '', content: p.content || '', enabled: p.enabled !== false }; });
          var pname = (data && (data.name || data.title)) || file.name.replace(/\.[^.]+$/, '');
          state.presets.push({ name: pname, modules: modules, footNote: footNote });
          state.activePresetIdx = state.presets.length - 1;
          renderPresets();
          refreshYml();
        });
      }

      function ensurePanel() {
        var existing = document.querySelector(PANEL_SELECTOR);
        if (existing && existing.isConnected) return existing;
        var column = document.querySelector('[data-slot="conversation.view"], [data-slot="conversation"] > .wSkVaW_root, .Md3f7G_root, [data-pane="conversation"], [class*="conversationColumn"]');
        if (!column) return undefined;
        container = createPanel();
        column.style.position = column.style.position || 'relative';
        column.appendChild(container);
        renderCharacters();
        renderWorldbooks();
        renderPresets();
        container.querySelector('#tavern-char-file').addEventListener('change', function (e) {
          handleCharFile(e.target.files && e.target.files[0]).catch(function (err) {
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = '角色卡导入失败：' + err.message;
          });
        });
        container.querySelector('#tavern-wb-file').addEventListener('change', function (e) {
          handleWbFile(e.target.files && e.target.files[0]).catch(function (err) {
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = '世界书导入失败：' + err.message;
          });
        });
        container.querySelector('#tavern-preset-file').addEventListener('change', function (e) {
          handlePresetFile(e.target.files && e.target.files[0]).catch(function (err) {
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = '预设导入失败：' + err.message;
          });
        });
          container.querySelector('#tavern-insert-char').addEventListener('click', function () {
            var chs = (state.characters || []).filter(function (c) { return c.enabled; });
            var text = '# 角色卡\n' + chs.map(function (c) {
              return '角色名：' + c.name + '\n' + (c.desc || '');
            }).join('\n\n---\n\n');
            var ok = insertIntoInput(text);
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = ok ? '已插入角色卡到当前对话输入框' : '没找到当前对话输入框';
          });
          container.querySelector('#tavern-insert-wb').addEventListener('click', function () {
            var parts = [];
            (state.worldbooks || []).forEach(function (wb) {
              if (!wb.enabled) return;
              (wb.entries || []).slice(0, 6).forEach(function (e, i) {
                var key = Array.isArray(e.keys) ? e.keys.join(', ') : (e.key || e.name || e.comment || ('世界书' + (i + 1)));
                parts.push('【' + key + '】\n' + (e.content || e.text || ''));
              });
            });
            var ok = insertIntoInput('# 世界书\n' + parts.join('\n\n'));
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = ok ? '已插入世界书到当前对话输入框' : '没找到当前对话输入框';
          });
          container.querySelector('#tavern-insert-foot').addEventListener('click', function () {
            var activeP = (state.presets && state.presets[state.activePresetIdx]) || null;
            var fn = activeP ? (activeP.footNote || '') : '';
            var ok = insertIntoInput(fn || '请加入足部描写');
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = ok ? '已插入足部描写到当前对话输入框' : '没找到当前对话输入框';
          });
        container.querySelector('#tavern-nsfw').addEventListener('change', function (e) {
          state.nsfw = e.target.checked;
          refreshYml();
        });
        container.querySelector('#tavern-inject').addEventListener('change', function (e) {
          var ist = container.querySelector('#tavern-inject-status');
          if (ist) ist.textContent = '同步中…';
          fetch('/api/tavern/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cardEnabled: e.target.checked })
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (ist && data.ok) {
              var m = data.mode || 'allowlist';
              var cnt = m === 'allowlist' ? (data.allowCwds || []).length : (data.disabledCwds || []).length;
              ist.textContent = data.cardEnabled
                ? (m === 'allowlist'
                    ? ('✅ 注入中（白名单）：仅 ' + cnt + ' 个会话生效')
                    : ('✅ 注入中（全局）：所有会话生效' + (cnt ? '，排除 ' + cnt + ' 个工作区' : '')))
                : '❌ 未注入：卡片已关闭（可在面板里开启）';
            }
          }).catch(function (err) { if (ist) ist.textContent = '同步失败：' + err.message; });
        });
        var igSave = container.querySelector('#tavern-ignore-save');
        var igNow = container.querySelector('#tavern-ignore-now');
        var alSave = container.querySelector('#tavern-allow-save');
        var alNow = container.querySelector('#tavern-allow-now');
        var rAl = container.querySelector('#tavern-mode-allow');
        var rGl = container.querySelector('#tavern-mode-global');
        var allowBox = container.querySelector('#tavern-allow-box');
        var ignoreBox = container.querySelector('#tavern-ignore-box');
        var scopeStatus = container.querySelector('#tavern-scope-status');
        function currentMode() {
          if (rGl && rGl.checked) return 'global';
          return 'allowlist';
        }
        function refreshScopeUI() {
          var m = currentMode();
          if (allowBox) allowBox.style.display = m === 'allowlist' ? 'block' : 'none';
          if (ignoreBox) ignoreBox.style.display = m === 'global' ? 'block' : 'none';
          if (scopeStatus) scopeStatus.textContent = m === 'allowlist'
            ? '白名单模式：默认不吃卡，只有下面列表的会话生效。'
            : '全局模式：所有会话都会加载，除下方排除列表。';
        }
        if (rAl) rAl.addEventListener('change', function () { refreshScopeUI(); });
        if (rGl) rGl.addEventListener('change', function () { refreshScopeUI(); });
        refreshScopeUI();

        function savePost(url, payload, label) {
          var el = container.querySelector('#tavern-scope-status');
          if (el) el.textContent = '保存中…';
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (el) el.textContent = (data.ok !== false) ? ('✅ 已保存' + (label ? '：' + label : '')) : ('❌ ' + (data.error || '保存失败'));
            loadCurrent();
          }).catch(function (err) { if (el) el.textContent = '保存失败：' + err.message; });
        }
        function listValue(id) {
          var el = container.querySelector(id);
          return (el ? el.value : '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
        // 白名单保存（mode + allowCwds 一起提交）
        if (alSave) alSave.addEventListener('click', function () {
          savePost('/api/tavern/state', { mode: currentMode(), allowCwds: listValue('#tavern-allow') }, '生效会话已更新');
        });
        if (alNow) alNow.addEventListener('click', function () {
          var cwd = alNow.dataset && alNow.dataset.cwd;
          if (!cwd) {
            // 自动检测不到也没关系：把手填框里的目录当作当前工作区加入；没有则提示
            var add = container.querySelector('#tavern-allow-add');
            var manual = add && (add.value || '').trim();
            if (manual) { var lst = listValue('#tavern-allow'); if (lst.indexOf(manual) === -1) lst.push(manual); if (add) add.value=''; var el2 = container.querySelector('#tavern-allow'); if (el2) el2.value = lst.join('\n'); savePost('/api/tavern/state', { mode: 'allowlist', allowCwds: lst }, '已手动加入白名单：' + manual); return; }
            if (scopeStatus) scopeStatus.textContent = '尚未自动检测到当前工作区，请在下方粘贴目录后点「加入」';
            return;
          }
          var list = listValue('#tavern-allow');
          if (list.indexOf(cwd) === -1) list.push(cwd);
          var el = container.querySelector('#tavern-allow'); if (el) el.value = list.join('\n');
          savePost('/api/tavern/state', { mode: 'allowlist', allowCwds: list }, '已把当前工作区加入白名单');
        });
        var allowAdd = container.querySelector('#tavern-allow-add');
        var allowAddBtn = container.querySelector('#tavern-allow-add-btn');
        function addManualAllow() {
          if (!allowAdd) return;
          var v = (allowAdd.value || '').trim();
          if (!v) { if (scopeStatus) scopeStatus.textContent = '请先粘贴一个工作区目录'; return; }
          var list = listValue('#tavern-allow');
          if (list.indexOf(v) === -1) list.push(v);
          var el = container.querySelector('#tavern-allow'); if (el) el.value = list.join('\n');
          var keep = v;
          allowAdd.value = '';
          savePost('/api/tavern/state', { mode: 'allowlist', allowCwds: list }, '已加入白名单：' + keep);
        }
        if (allowAdd) allowAdd.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addManualAllow(); } });
        if (allowAddBtn) allowAddBtn.addEventListener('click', addManualAllow);
        // 全局模式下的排除（黑名单）
        if (igSave) igSave.addEventListener('click', function () {
          savePost('/api/tavern/state', { mode: 'global', disabledCwds: listValue('#tavern-ignore') }, '排除列表已更新');
        });
        if (igNow) igNow.addEventListener('click', function () {
          var cwd = igNow.dataset && igNow.dataset.cwd;
          if (!cwd) { if (scopeStatus) scopeStatus.textContent = '还没有检测到当前工作区，先发一条消息再点'; return; }
          var list = listValue('#tavern-ignore');
          if (list.indexOf(cwd) === -1) list.push(cwd);
          var el = container.querySelector('#tavern-ignore'); if (el) el.value = list.join('\n');
          savePost('/api/tavern/state', { mode: 'global', disabledCwds: list }, '已把当前工作区加入排除');
        });
        container.querySelector('#tavern-extra').addEventListener('input', function (e) {
          state.extraPrompt = e.target.value;
          refreshYml();
        });
        container.querySelector('#tavern-save').addEventListener('click', function () {
          saveCurrent().catch(function (err) {
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = '保存失败：' + err.message;
          });
        });
        container.querySelector('#tavern-refresh').addEventListener('click', function () {
          loadCurrent().catch(function (err) {
            var st = container.querySelector('#tavern-status'); if (st) st.textContent = '读取失败：' + err.message;
          });
        });
          container.querySelector('#tavern-close').addEventListener('click', function () {
            document.documentElement.removeAttribute(ACTIVE_ATTR);
            applyActive();
          });
          function loadConfig() {
            return fetch('/api/tavern/config').then(function (r) { return r.json(); }).then(function (data) {
              var m = data && data.mem ? data.mem : {};
              var setVal = function (id, v) { var el = container.querySelector(id); if (el) el.value = v == null ? '' : v; };
              setVal('#tavern-api-url', m.apiUrl || '');
              setVal('#tavern-api-key', m.apiKey || '');
              setVal('#tavern-api-model', m.model || 'deepseek-chat');
              setVal('#tavern-auto-every', m.autoEvery || 20);
              var auto = container.querySelector('#tavern-auto-enabled');
              if (auto) auto.checked = !!m.autoEnabled;
              var st = container.querySelector('#tavern-api-status');
              if (st) st.textContent = m.apiUrl ? ('已保存 API：' + m.apiUrl + (m.autoEnabled ? ' · 自动' + (m.autoEvery||20) + '楼' : ' · 自动关')) : '请填写 API 地址与秘钥后点「保存设置」';
            });
          }
          container.querySelector('#tavern-api-save').addEventListener('click', function () {
            var st = container.querySelector('#tavern-api-status');
            if (st) st.textContent = '保存中...';
            var auto = container.querySelector('#tavern-auto-enabled');
            var everyEl = container.querySelector('#tavern-auto-every');
            fetch('/api/tavern/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                apiUrl: (container.querySelector('#tavern-api-url') || {}).value || '',
                apiKey: (container.querySelector('#tavern-api-key') || {}).value || '',
                model: (container.querySelector('#tavern-api-model') || {}).value || 'deepseek-chat',
                autoEnabled: !!(auto && auto.checked),
                autoEvery: parseInt((everyEl || {}).value, 10) || 20
              })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (st) st.textContent = d.ok ? '✅ 设置已保存' : '保存失败：' + (d.error || '');
            }).catch(function (err) { if (st) st.textContent = '保存失败：' + err.message; });
          });
          container.querySelector('#tavern-summarize-run').addEventListener('click', function () {
            var preview = container.querySelector('#tavern-summary-preview');
            var roundsEl = container.querySelector('#tavern-summarize-rounds');
            var st = container.querySelector('#tavern-status');
            if (preview) preview.textContent = '正在读取对话并调用模型总结...';
            if (st) st.textContent = '总结中...';
            var rounds = parseInt((roundsEl || {}).value, 10) || 20;
            fetch('/api/tavern/summarize', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ rounds: rounds, sessionId: '' })
            }).then(function (r) { return r.json(); }).then(function (data) {
              if (!data.ok) throw new Error(data.error || '总结失败');
              if (preview) preview.textContent = '✅ 总结完成\n' + (data.summary || '');
              if (st) st.textContent = '✅ 已总结，并更新了记忆与关系网';
              // 关系网已由宿主更新，刷新图谱与记忆
              loadRelations().catch(function () {});
              loadMemory().catch(function () {});
            }).catch(function (err) {
              if (preview) preview.textContent = '❌ ' + err.message;
              if (st) st.textContent = '总结失败：' + err.message;
            });
          });
          function renderRelationsGraph(data) {
            var graph = container.querySelector('#tavern-relations-graph');
            if (!graph) return;
            var nodes = data.nodes || [];
            var edges = data.edges || [];
            if (!nodes.length) {
              graph.innerHTML = '<div style="color:var(--dsw-alias-label-secondary);font-size:13px">还没有角色关系数据</div>';
              return;
            }
            var cx = 200, cy = 150, radius = 110;
            var positions = {};
            nodes.forEach(function (n, i) {
              var angle = (Math.PI * 2 * i) / nodes.length - Math.PI / 2;
              positions[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
            });
            var svg = '<svg width="400" height="300" style="background:var(--dsw-alias-bg-layer-2);border-radius:8px;max-width:100%">';
            edges.forEach(function (e) {
              var s = positions[e.source], t = positions[e.target];
              if (!s || !t) return;
              svg += '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + t.x + '" y2="' + t.y + '" stroke="var(--dsw-alias-brand-primary)" stroke-width="2"/>';
              if (e.label) {
                svg += '<text x="' + ((s.x + t.x) / 2) + '" y="' + ((s.y + t.y) / 2 - 6) + '" fill="var(--dsw-alias-label-secondary)" font-size="10" text-anchor="middle">' + e.label + '</text>';
              }
            });
            nodes.forEach(function (n) {
              var p = positions[n.id];
              if (!p) return;
              svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="22" fill="var(--dsw-alias-bg-layer-1)" stroke="var(--dsw-alias-brand-primary)" stroke-width="2"/>';
              svg += '<text x="' + p.x + '" y="' + (p.y + 4) + '" fill="var(--dsw-alias-label-primary)" font-size="11" text-anchor="middle">' + (n.label || n.id) + '</text>';
            });
            svg += '</svg>';
            graph.innerHTML = svg;
          }

          function loadRelations() {
            return fetch('/api/tavern/relations').then(function (r) { return r.json(); }).then(function (data) {
              var ta = container.querySelector('#tavern-relations-data');
              if (ta && data.relations) ta.value = JSON.stringify(data.relations, null, 2);
              renderRelationsGraph(data.relations || { nodes: [], edges: [] });
            });
          }

          function loadMemory() {
            return fetch('/api/tavern/memory').then(function (r) { return r.json(); }).then(function (data) {
              var ta = container.querySelector('#tavern-memory-text');
              if (ta) ta.value = data.memory || '';
            });
          }

          container.querySelector('#tavern-relations-save').addEventListener('click', function () {
            var ta = container.querySelector('#tavern-relations-data');
            try {
              var data = JSON.parse(ta.value || '{"nodes":[],"edges":[]}');
              fetch('/api/tavern/relations', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ relations: data })
              }).then(function (r) { return r.json(); }).then(function (d) {
                var st = container.querySelector('#tavern-status'); if (st) st.textContent = d.ok ? '关系网已保存' : '保存失败：' + (d.error || '');
                renderRelationsGraph(data);
              });
            } catch (e) {
              var st = container.querySelector('#tavern-status'); if (st) st.textContent = '关系网 JSON 格式错误';
            }
          });

          container.querySelector('#tavern-relations-render').addEventListener('click', function () {
            var ta = container.querySelector('#tavern-relations-data');
            try {
              renderRelationsGraph(JSON.parse(ta.value || '{"nodes":[],"edges":[]}'));
            } catch (e) {
              var st = container.querySelector('#tavern-status'); if (st) st.textContent = '关系网 JSON 格式错误';
            }
          });

          container.querySelector('#tavern-memory-save').addEventListener('click', function () {
            var ta = container.querySelector('#tavern-memory-text');
            fetch('/api/tavern/memory', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ memory: ta ? ta.value : '' })
            }).then(function (r) { return r.json(); }).then(function (d) {
              var st = container.querySelector('#tavern-status'); if (st) st.textContent = d.ok ? '记忆已保存' : '保存失败：' + (d.error || '');
            });
          });

          container.querySelector('#tavern-memory-load').addEventListener('click', function () {
            loadMemory().catch(function (err) {
              var st = container.querySelector('#tavern-status'); if (st) st.textContent = '读取记忆失败：' + err.message;
            });
          });

          loadRelations().catch(function () {});
          loadMemory().catch(function () {});
          loadConfig().catch(function () {});
        loadCurrent().catch(function () {});
        return container;
      }

      function applyActive() {
        var active = document.documentElement.hasAttribute(ACTIVE_ATTR);
        if (container) container.style.display = active ? 'block' : 'none';
        if (active) {
          var style = document.getElementById('dsh-tavern-manager-style');
          if (!style) {
            var el = document.createElement('style');
            el.id = 'dsh-tavern-manager-style';
            el.textContent = '[' + ACTIVE_ATTR + '] [data-slot="conversation.view"] > :not(' + PANEL_SELECTOR + '), [' + ACTIVE_ATTR + '] [data-slot="conversation"] > .wSkVaW_root > :not(' + PANEL_SELECTOR + ') { display:none !important; }';
            document.head.appendChild(el);
          }
        } else {
          var old = document.getElementById('dsh-tavern-manager-style');
          if (old) old.remove();
        }
      }

      var tryPlace = function () {
        if (placed) { if (document.body.contains(entry)) return; placed = false; }
        if (entry.parentElement !== document.body) {
          entry.style.position = 'fixed';
          entry.style.bottom = '20px';
          entry.style.right = '20px';
          entry.style.zIndex = '99999';
          entry.style.width = 'auto';
          entry.style.borderRadius = '999px';
          entry.style.padding = '8px 16px';
          entry.style.background = '#3b7ff0';
          entry.style.color = '#ffffff';
          entry.style.fontWeight = '600';
          entry.style.boxShadow = '0 4px 16px rgba(0,0,0,.35)';
          document.body.appendChild(entry);
        }
        placed = true;
      };

      var sync = function () {
        container = ensurePanel();
        applyActive();
      };

      function toggleManager() {
        var active = document.documentElement.hasAttribute(ACTIVE_ATTR);
        if (active) document.documentElement.removeAttribute(ACTIVE_ATTR);
        else document.documentElement.setAttribute(ACTIVE_ATTR, '');
        sync();
      }

      // 原生侧边栏有一个「🍺 酒馆」按钮（DeepSeek 自带，打开独立 iframe）。
      // 我们要它打开「酒馆管理」：识别它并重定向到 toggleManager，拦截自带的 iframe 跳转。
      function isTavernEntryButton(t) {
        if (!t || !t.closest) return false;
        var el = t.closest('button, [role="button"]');
        if (!el) return false;
        if (el.hasAttribute && (el.hasAttribute('data-dsh-tavern-entry') || el.hasAttribute('data-dsh-tavern-float') || el.hasAttribute('data-dsh-tavern-manager-entry'))) return true;
        var txt = String(el.textContent || '').replace(/\s/g, '');
        var hit = txt === '酒馆' || txt === '🍺酒馆' || (txt.indexOf('酒馆') === 0 && txt.indexOf('酒馆管理') !== 0);
        if (!hit) return false;
        // 限定在侧边栏，避免误伤正文里别的按钮。
        var sidebar = document.querySelector('[data-slot="sidebar"], [data-pane="sidebar"], [class*="sidebarCol"]');
        return sidebar ? sidebar.contains(el) : true;
      }

      // 在 manager 自己注册 dismiss 之前先注册拦截（capture 同阶段按注册顺序执行）
      document.addEventListener('click', function (e) {
        if (isTavernEntryButton(e.target)) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          toggleManager();
        }
      }, true);

      entry = createEntry();
      entry.addEventListener('click', function () { toggleManager(); });

      // 点侧边栏其他工作区/导航时，自动退出酒馆管理面板
      // （🍺酒馆(dsh-tavern-entry / 原生「酒馆」按钮) 与 酒馆管理(dsh-tavern-manager-entry) 共用同一面板，点它们不自动关闭）
      document.addEventListener('click', function (e) {
        if (!document.documentElement.hasAttribute(ACTIVE_ATTR)) return;
        if (isTavernEntryButton(e.target)) return; // 点「🍺酒馆」/「🍺酒馆管理」由 toggle 自己处理，不自动关闭
        var onEntry = e.target.closest(ENTRY_SELECTOR + ', ' + PANEL_SELECTOR + ', [data-dsh-tavern-entry]');
        if (onEntry) return;
        var sidebar = document.querySelector('[data-slot="sidebar"], [data-pane="sidebar"], [class*="sidebarCol"]');
        if (sidebar && sidebar.contains(e.target)) {
          document.documentElement.removeAttribute(ACTIVE_ATTR);
          applyActive();
        }
      }, true);

      var observer = new MutationObserver(function () { tryPlace(); sync(); });
      observer.observe(document.body, { childList: true, subtree: true });

      tryPlace();
      sync();

      disposers.push(function () {
        observer.disconnect();
        if (entry) entry.remove();
        var old = document.getElementById('dsh-tavern-manager-style');
        if (old) old.remove();
        document.documentElement.removeAttribute(ACTIVE_ATTR);
        var panel = document.querySelector(PANEL_SELECTOR);
        if (panel) panel.remove();
      });

      window.__dshTavernManagerInstance = {
        toggle: toggleManager,
        dispose: function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]();
          window.__dshTavernManagerInstance = null;
        }
      };

      if (typeof ctx !== 'undefined' && ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            if (window.__dshTavernManagerInstance) window.__dshTavernManagerInstance.dispose();
          };
        }, 'dsh-tavern: manager mounts');
      }
    }

    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  }
});
