// 全局正则面板（等价 ST 的全局 Regex 扩展）的行为测试。
//
// 被测对象是 client.manager.bundle.js 里的 `initGlobalRegexPanel` IIFE —— 客户端代码，
// 没有现成 DOM，所以用 vm 沙箱 + 极简假 DOM 托起来跑（手法与 var-panel.test.js 一致）：
//   · fetch / esc 由沙箱注入；container.querySelector 返回注册好的假元素。
//   · 清单事件用「点击委托」实现（target 自带 data-* 属性），假元素 dispatch 即可触发。
//
// 判据纪律（本项目铁律）：测试必须**能真的变红** —— 关键用例都带「对照臂」：
// 对被测源码做一处变异（包装透传体 / 砍掉错误明细 / 删掉降级提示 / 删掉 DELETE 回落），
// 同样的断言必须失败。对照臂红 = 判据真的在测东西。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.manager.bundle.js');
const API = '/api/muv-engine/global-regex';

// ── 从 bundle 里抽出 initGlobalRegexPanel 的源码（锚点：IIFE 开头 → 保存并关闭注释）──
function extractPanelSource(bundleText) {
  const start = bundleText.indexOf('(function initGlobalRegexPanel() {');
  const end = bundleText.indexOf('// ── 保存并关闭 ──');
  if (start < 0 || end < 0 || end <= start) throw new Error('bundle 里找不到 initGlobalRegexPanel 源码段');
  return bundleText.slice(start, end);
}

// ── 极简假元素（与 var-panel.test.js 同款）──
class FakeEl {
  constructor(attrs = {}) {
    this.attrs = Object.assign({}, attrs);
    this.listeners = {};
    this.innerHTML = '';
    this.style = {};
    this.value = attrs.value != null ? attrs.value : '';
    this.checked = false;
  }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, ev) { ev = ev || {}; ev.target = ev.target || this; (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  insertAdjacentHTML(_pos, html) { this.innerHTML += html; }
  querySelectorAll() { return this._matching || []; }
  setMatching(list) { this._matching = list; }
}

// ── 在沙箱里跑被测代码 ──
async function runPanel(panelSource, { fetchOverride } = {}) {
  const els = {
    '#tavern-gregex-list': new FakeEl(),
    '#tavern-gregex-status': new FakeEl(),
    '#tavern-gregex-preview': new FakeEl(),
    '#tavern-gregex-paste': new FakeEl(),
    '#tavern-gregex-drop': new FakeEl(),
    '#tavern-gregex-file': new FakeEl(),
    '#tavern-gregex-choose': new FakeEl(),
    '#tavern-gregex-import': new FakeEl(),
    '#tavern-gregex-refresh': new FakeEl(),
  };
  const container = { querySelector: (sel) => els[sel] || null };
  const fetchImpl = fetchOverride || (async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }));
  const sandbox = {
    container,
    fetch: fetchImpl,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: { createElement: () => new FakeEl(), body: { appendChild() {}, removeChild() {} } },
    console,
    setTimeout, clearTimeout, Number, Object, String, JSON, Error, isNaN, Promise, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(panelSource, sandbox, { timeout: 5000 });
  await delay(60);
  await delay(700); // 首次探测 setTimeout(…, 600) + fetch 链
  return { els };
}

// ── 引擎替身：GET 返回清单；POST 导入返回统计；记录全部请求 ──
const SAMPLE_SCRIPTS = [
  { id: 'r1', scriptName: '去除思考块', placement: [0], disabled: false },
  { id: 'r2', scriptName: '美化输出', placement: [1], disabled: true },
  { id: 'r3', scriptName: '世界书联动', placement: [0, 1], disabled: false },
];
function engineFetch(fetchLog, { scripts = SAMPLE_SCRIPTS, importResp, toggleOk = true } = {}) {
  // ★ 深拷贝：面板成功路径会就地改 s.disabled，不能污染模块级 SAMPLE_SCRIPTS（否则跨用例状态泄漏）
  scripts = JSON.parse(JSON.stringify(scripts));
  return async (url, opts) => {
    fetchLog.push({ url, opts, method: (opts && opts.method) || 'GET' });
    if (url === API && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ ok: true, scripts }) };
    }
    if (url === API && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (body && body.action === 'set-disabled') {
        return { ok: true, json: async () => (toggleOk ? { ok: true } : { ok: false, error: 'unknown action' }) };
      }
      return { ok: true, json: async () => importResp || { ok: true, added: 1, replaced: 0, skipped: 0, errors: [] } };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unexpected ' + url }) };
  };
}

// 粘贴 → 预览 → 导入 的完整操作序列
async function pasteAndImport(els, text) {
  els['#tavern-gregex-paste'].value = text;
  els['#tavern-gregex-paste'].dispatch('input');
  await delay(30);
  els['#tavern-gregex-import'].dispatch('click');
  await delay(60);
}

// ── 三种 ST 导出形态（载荷必须**原样**透传给引擎）──
const FORM_ARRAY = [{ id: 'a1', scriptName: '甲', findRegex: '/x/g', replaceString: 'y' }];
const FORM_SCRIPTS = { scripts: [{ id: 'b1', scriptName: '乙', findRegex: '/x/g', replaceString: 'y' }] };
const FORM_ST_CARD = { data: { extensions: { regex_scripts: [{ id: 'c1', scriptName: '丙', findRegex: '/x/g', replaceString: 'y' }] } } };

test('全局正则：挂载探测成功 → 列表渲染名字 / placement 简写 / 停用状态', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { fetchOverride: engineFetch([]) });
  const html = els['#tavern-gregex-list'].innerHTML;
  assert.match(html, /去除思考块/, '应渲染脚本名');
  assert.match(html, /placement:前/, 'placement [0] 应显示「前」');
  assert.match(html, /placement:后/, 'placement [1] 应显示「后」');
  assert.match(html, /placement:前后/, 'placement [0,1] 应显示「前后」');
  assert.match(html, /已停用/, 'disabled:true 的脚本应标「已停用」');
  assert.match(html, /启用中/, 'disabled:false 的脚本应标「启用中」');
  assert.match(els['#tavern-gregex-status'].innerHTML, /已连接全局正则注册表（3 条脚本）/);
});
test('对照臂：砍掉清单行渲染后，同一断言必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace('for (var i = 0; i < shown.length; i++) html += rowHtml(shown[i]);', 'for (var i = 0; i < 0; i++) html += rowHtml(shown[i]);');
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { fetchOverride: engineFetch([]) });
    assert.match(els['#tavern-gregex-list'].innerHTML, /去除思考块/);
  });
});

test('全局正则：清单 >50 条先渲染 50 条，点「显示更多」懒加载追加', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ id: 'm' + i, scriptName: '脚本' + i, placement: [0], disabled: false });
  const { els } = await runPanel(src, { fetchOverride: engineFetch([], { scripts: many }) });
  const firstHtml = els['#tavern-gregex-list'].innerHTML;
  assert.ok(!/脚本59/.test(firstHtml), '第 60 条（脚本59）不应在首批渲染里');
  assert.match(firstHtml, /显示更多（还有 10 条）/, '应出现懒加载按钮');
  const moreBtn = new FakeEl({ 'data-gregex-more': '1' });
  els['#tavern-gregex-list'].dispatch('click', { target: moreBtn });
  await delay(30);
  const fullHtml = els['#tavern-gregex-list'].innerHTML;
  assert.match(fullHtml, /脚本59/, '点「显示更多」后第 60 条应出现');
});

test('全局正则：粘贴解析预览显示条数与前 5 个脚本名', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { fetchOverride: engineFetch([]) });
  els['#tavern-gregex-paste'].value = JSON.stringify(FORM_SCRIPTS);
  els['#tavern-gregex-paste'].dispatch('input');
  await delay(30);
  assert.match(els['#tavern-gregex-preview'].innerHTML, /解析预览：共 1 条脚本/);
  assert.match(els['#tavern-gregex-preview'].innerHTML, /乙/);
});

test('全局正则：三种导入形态发给引擎的请求体不变（原样透传）', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const cases = [
    ['数组', JSON.stringify(FORM_ARRAY), FORM_ARRAY],
    ['{scripts}', JSON.stringify(FORM_SCRIPTS), FORM_SCRIPTS],
    ['{data.extensions.regex_scripts}', JSON.stringify(FORM_ST_CARD), FORM_ST_CARD],
  ];
  for (const [label, text, expectBody] of cases) {
    const fetchLog = [];
    const { els } = await runPanel(src, { fetchOverride: engineFetch(fetchLog) });
    await pasteAndImport(els, text);
    const post = fetchLog.find((f) => f.url === API && f.method === 'POST' && !(JSON.parse(f.opts.body || '{}').action));
    assert.ok(post, label + '：应发出导入 POST');
    assert.deepEqual(JSON.parse(post.opts.body), expectBody, label + '：请求体必须与解析前的 JSON 本体逐字一致');
  }
});
test('对照臂：把透传体包一层 {wrapped:…} 后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace('body: JSON.stringify(pendingPayload)', 'body: JSON.stringify({ wrapped: pendingPayload })');
  await assert.rejects(async () => {
    const fetchLog = [];
    const { els } = await runPanel(src, { fetchOverride: engineFetch(fetchLog) });
    await pasteAndImport(els, JSON.stringify(FORM_ARRAY));
    const post = fetchLog.find((f) => f.url === API && f.method === 'POST');
    assert.deepEqual(JSON.parse(post.opts.body), FORM_ARRAY);
  });
});

test('全局正则：导入后渲染 {added,replaced,skipped} 统计，错误明细最多列 3 条', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const fetchLog = [];
  const importResp = {
    ok: true, added: 2, replaced: 1, skipped: 1,
    errors: [{ error: 'e1 缺 id' }, { error: 'e2 缺 findRegex' }, { error: 'e3 正则编译失败' }, { error: 'e4 重复且未开覆盖' }],
  };
  const { els } = await runPanel(src, { fetchOverride: engineFetch(fetchLog, { importResp }) });
  await pasteAndImport(els, JSON.stringify(FORM_ARRAY));
  const status = els['#tavern-gregex-status'].innerHTML;
  assert.match(status, /新增 2 · 替换 1 · 跳过 1/);
  assert.match(status, /e1 缺 id/);
  assert.match(status, /e2 缺 findRegex/);
  assert.match(status, /e3 正则编译失败/);
  assert.ok(!/e4 重复且未开覆盖/.test(status), '第 4 条错误不应列出（只提示总数）');
  assert.match(status, /共 4 条错误/);
});
test('对照臂：砍掉错误明细循环后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace('for (var i = 0; i < errs.length && i < 3; i++) {', 'for (var i = 0; i < 0; i++) {');
  await assert.rejects(async () => {
    const fetchLog = [];
    const importResp = { ok: true, added: 1, replaced: 0, skipped: 0, errors: [{ error: 'e1 缺 id' }] };
    const { els } = await runPanel(src, { fetchOverride: engineFetch(fetchLog, { importResp }) });
    await pasteAndImport(els, JSON.stringify(FORM_ARRAY));
    assert.match(els['#tavern-gregex-status'].innerHTML, /e1 缺 id/);
  });
});

test('全局正则：接口 404 → 整卡降级提示可见，导入被拒不崩', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src); // 默认替身 = 404
  assert.match(els['#tavern-gregex-status'].innerHTML, /引擎未提供全局正则接口（需更新\/重启 dsh-muv-engine）/, '状态栏应显示降级提示');
  assert.match(els['#tavern-gregex-list'].innerHTML, /引擎未提供全局正则接口/, '清单区也应显示降级提示');
  // 降级状态下导入必须拒绝执行（不发出 POST）
  const fetchLog = [];
  const src2 = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const els2 = await (async () => {
    const r = await runPanel(src2, { fetchOverride: async (url, opts) => {
      fetchLog.push({ url, opts, method: (opts && opts.method) || 'GET' });
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
    } });
    return r.els;
  })();
  await pasteAndImport(els2, JSON.stringify(FORM_ARRAY));
  assert.ok(!fetchLog.some((f) => f.method === 'POST'), '降级状态下不得发出导入 POST');
});
test('对照臂：删掉降级提示文案后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace("'⚠️ 引擎未提供全局正则接口（需更新/重启 dsh-muv-engine）'", "''");
  await assert.rejects(async () => {
    const { els } = await runPanel(src);
    assert.match(els['#tavern-gregex-status'].innerHTML, /引擎未提供全局正则接口/);
  });
});

test('全局正则：停用开关发出 {action:set-disabled,id,disabled}，成功后状态更新', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const fetchLog = [];
  const { els } = await runPanel(src, { fetchOverride: engineFetch(fetchLog) });
  const btn = new FakeEl({ 'data-gregex-toggle': 'r1' });
  els['#tavern-gregex-list'].dispatch('click', { target: btn });
  await delay(60);
  const post = fetchLog.find((f) => f.url === API && f.method === 'POST' && JSON.parse(f.opts.body).action === 'set-disabled');
  assert.ok(post, '应发出 set-disabled POST');
  assert.deepEqual(JSON.parse(post.opts.body), { action: 'set-disabled', id: 'r1', disabled: true });
  assert.match(els['#tavern-gregex-status'].innerHTML, /已停用「去除思考块」/);
  assert.match(els['#tavern-gregex-list'].innerHTML, /已停用/, '重渲染后 r1 应标已停用');
});
test('全局正则：引擎拒绝 set-disabled → 明确提示「删除+重导」，不静默假装成功', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { fetchOverride: engineFetch([], { toggleOk: false }) });
  const btn = new FakeEl({ 'data-gregex-toggle': 'r2' });
  els['#tavern-gregex-list'].dispatch('click', { target: btn });
  await delay(60);
  const status = els['#tavern-gregex-status'].innerHTML;
  assert.match(status, /引擎未支持停用接口/, '应给出探测回落的明确提示');
  assert.match(status, /删除该脚本后/, '应提示删除+重导路径');
  assert.ok(!/已启用「/.test(status) && !/已停用「/.test(status), '绝不能显示成功文案');
});
test('对照臂：把引擎拒绝分支改成走成功路径后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace("if (!d || !d.ok) throw new Error('engine-rejected');", 'if (false) throw new Error("engine-rejected");');
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { fetchOverride: engineFetch([], { toggleOk: false }) });
    const btn = new FakeEl({ 'data-gregex-toggle': 'r1' });
    els['#tavern-gregex-list'].dispatch('click', { target: btn });
    await delay(60);
    assert.ok(!/已停用「/.test(els['#tavern-gregex-status'].innerHTML), '引擎拒绝时不得出现成功文案');
  });
});

test('全局正则：删除优先 DELETE，405 回落 POST {action:delete,id}', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const fetchLog = [];
  const override = async (url, opts) => {
    fetchLog.push({ url, opts, method: (opts && opts.method) || 'GET' });
    if (url === API && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => ({ ok: true, scripts: SAMPLE_SCRIPTS }) };
    }
    if (url === API && opts.method === 'DELETE') {
      return { status: 405, ok: false, json: async () => ({ ok: false, error: 'method not allowed' }) };
    }
    if (url === API && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (body && body.action === 'delete') return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unexpected' }) };
  };
  const { els } = await runPanel(src, { fetchOverride: override });
  const delBtn = new FakeEl({ 'data-gregex-del': 'r3' });
  els['#tavern-gregex-list'].dispatch('click', { target: delBtn });
  await delay(120);
  assert.ok(fetchLog.some((f) => f.method === 'DELETE' && f.url === API), '应先尝试 DELETE');
  const fb = fetchLog.find((f) => f.method === 'POST' && f.url === API && JSON.parse(f.opts.body || '{}').action === 'delete');
  assert.ok(fb, 'DELETE 405 后应回落 POST action:delete');
  assert.deepEqual(JSON.parse(fb.opts.body), { action: 'delete', id: 'r3' });
  assert.match(els['#tavern-gregex-status'].innerHTML, /已删除/, '回落成功后应提示已删除');
});
test('对照臂：砍掉 DELETE→POST 回落后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace('if (r && (r.status === 405 || r.status === 404)) return { __fallback: true };', 'if (false) return { __fallback: true };');
  await assert.rejects(async () => {
    const fetchLog = [];
    const override = async (url, opts) => {
      fetchLog.push({ url, opts, method: (opts && opts.method) || 'GET' });
      if (url === API && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => ({ ok: true, scripts: SAMPLE_SCRIPTS }) };
      }
      if (url === API && opts.method === 'DELETE') {
        return { status: 405, ok: false, json: async () => ({ ok: false, error: 'method not allowed' }) };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unexpected' }) };
    };
    const { els } = await runPanel(src, { fetchOverride: override });
    const delBtn = new FakeEl({ 'data-gregex-del': 'r3' });
    els['#tavern-gregex-list'].dispatch('click', { target: delBtn });
    await delay(120);
    assert.ok(fetchLog.some((f) => f.method === 'POST' && JSON.parse(f.opts.body || '{}').action === 'delete'), '应存在 POST 回落');
    assert.match(els['#tavern-gregex-status'].innerHTML, /已删除/);
  });
});
