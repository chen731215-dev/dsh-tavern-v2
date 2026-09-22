// 变量面板（等价小白X「变量管理」）的行为测试。
//
// 被测对象是 client.manager.bundle.js 里的 `initVarPanel` IIFE —— 客户端代码，
// 没有现成 DOM，所以用 vm 沙箱 + 极简假 DOM 托起来跑：
//   · fetch / getCurrentSessionId / esc 由沙箱注入；
//   · container.querySelector 返回注册好的假元素（含 addEventListener 捕获）。
//
// 判据纪律（本项目铁律）：测试必须**能真的变红** —— 每个用例都有一支「对照臂」：
// 对被测源码做一处变异（删掉写回的 merge:true / 删掉回显逻辑 / 删掉搜索），
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

// ── 从 bundle 里抽出 initVarPanel 的源码（锚点：IIFE 开头 → 保存并关闭注释）──
// 注意：bundle 里有两处「变量面板」字样（panelHTML 的 HTML 卡片 + IIFE 注释），
// HTML 数组片段不是合法独立语句，所以锚点必须钉在 IIFE 上。
function extractPanelSource(bundleText) {
  const start = bundleText.indexOf('(function initVarPanel()');
  const end = bundleText.indexOf('// ── 保存并关闭 ──');
  if (start < 0 || end < 0 || end <= start) throw new Error('bundle 里找不到 initVarPanel 源码段');
  return bundleText.slice(start, end);
}

// ── 极简假元素 ──
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
  appendChild(el) { if (el && el.innerHTML != null) this.innerHTML += el.innerHTML; }
  querySelectorAll() { return this._matching || []; }
  setMatching(list) { this._matching = list; }
}

// ── 在沙箱里跑被测代码，返回捕获的环境 ──
async function runPanel(panelSource, { tree, initvar, session = 'session-abc123', fetchLog = [], doc, fetchOverride } = {}) {
  const els = {
    '#tavern-var-tree': new FakeEl(),
    '#tavern-var-status': new FakeEl(),
    '#tavern-var-search': new FakeEl(),
    '#tavern-var-save': new FakeEl(),
    '#tavern-var-refresh': new FakeEl(),
    '#tavern-var-export': new FakeEl(),
    // ⏱ 按楼回看（探测式时间旅行）
    // 真实 DOM 里该行模板自带 display:none，探测成功才由 buildSnapRow 取消隐藏
    '#tavern-var-snap-row': new FakeEl(),
    '#tavern-var-snap-select': new FakeEl(),
    '#tavern-var-back-latest': new FakeEl(),
  };
  els['#tavern-var-snap-row'].style.display = 'none';
  els['#tavern-var-back-latest'].style.display = 'none';
  const container = { querySelector: (sel) => els[sel] || null };
  const fetchImpl = fetchOverride || (async (url, opts) => {
    fetchLog.push({ url, opts });
    if (url.startsWith('/api/muv-engine/state') && (!opts || opts.method !== 'POST')) {
      return { json: async () => ({ ok: true, state: { data: tree, updatedAt: 1 } }) };
    }
    if (url.startsWith('/api/muv-engine/state')) {
      return { json: async () => ({ ok: true, data: opts ? JSON.parse(opts.body).data : null }) };
    }
    if (url.startsWith('/api/muv-table/tavern-card')) {
      return { json: async () => ({ ok: true, initvarData: initvar }) };
    }
    return { json: async () => ({ ok: false, error: 'unexpected ' + url }) };
  });
  const createdEls = (doc && doc.created) || [];
  const fakeDoc = {
    createElement: () => { const el = new FakeEl(); el.select = () => {}; createdEls.push(el); return el; },
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  };
  const sandbox = {
    container,
    fetch: fetchImpl,
    getCurrentSessionId: () => session,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    navigator: {},
    document: fakeDoc,
    console,
    setTimeout, clearTimeout, Number, Object, String, JSON, Error, isNaN, Promise, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(panelSource, sandbox, { timeout: 5000 });
  await delay(60); // 首次挂载 setTimeout(…, 600)？不 —— loadState(true) 是 600ms 后跑的
  await delay(700); // 等 load 的 fetch 链走完
  return { els, fetchLog, sandbox };
}

const SAMPLE_TREE = {
  stat_data: { 好感度: 30, 状态: { 精力: 80 } },
  剧情选项: { 选项1: '去天台', 选项2: '留在教室' },
};
const SAMPLE_INITVAR = { stat_data: { 好感度: 0, 状态: { 精力: 80 } } };

// ── 用例 ──
test('变量面板：挂载后能读到会话变量树并渲染叶子', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  assert.match(els['#tavern-var-status'].innerHTML, /已读取/);
  assert.match(els['#tavern-var-tree'].innerHTML, /好感度/);
  assert.match(els['#tavern-var-tree'].innerHTML, /选项1/);
});
test('对照臂：删掉 loadState 的读取分支后，同一断言必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace("currentTree = (d.state && d.state.data) || null;", "currentTree = null;");
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { tree: SAMPLE_TREE });
    assert.match(els['#tavern-var-tree'].innerHTML, /好感度/);
  });
});

test('变量面板：与初始值不同的叶子标「已覆盖」', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  // 好感度 30 ≠ 初始 0 → 已覆盖；精力 80 = 初始 80 → 不标
  assert.match(els['#tavern-var-tree'].innerHTML, /已覆盖/);
});
test('对照臂：砍掉 isOverridden 的差异比较后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace('return JSON.stringify(iv) !== JSON.stringify(value);', 'return false;');
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
    assert.match(els['#tavern-var-tree'].innerHTML, /已覆盖/);
  });
});

test('变量面板：编辑叶子 →「保存修改」按 merge 写回正确的嵌套载荷', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els, fetchLog } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  const rendered = els['#tavern-var-tree'].innerHTML;
  const pkList = (rendered.match(/data-var-edit="([^"]+)"/g) || []).map((s) => s.match(/"([^"]+)"/)[1]);
  const pk = pkList.find((k) => k.split('\u0001').join('.') === 'stat_data.好感度');
  assert.ok(pk, '应能找到 stat_data.好感度 的输入框');
  const input = new FakeEl({ 'data-var-edit': pk });
  input.value = '66';
  // 绑定发生在 render() 里 —— 让 varTree.querySelectorAll 能抓到这个假输入框，
  // 再借搜索框触发一次空渲染把 change 监听挂上
  els['#tavern-var-tree'].querySelectorAll = (sel) => (sel === '[data-var-edit]' ? [input] : []);
  els['#tavern-var-search'].dispatch('input');
  await delay(400);
  input.dispatch('change');
  els['#tavern-var-save'].dispatch('click');
  await delay(60);
  const post = fetchLog.find((f) => f.url.startsWith('/api/muv-engine/state') && f.opts && f.opts.method === 'POST');
  assert.ok(post, '应发出写回 POST');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.sessionId, 'session-abc123');
  assert.equal(body.merge, true);
  assert.deepEqual(body.data, { stat_data: { 好感度: 66 } }); // 数字类型要保持
});
test('对照臂：把写回改成 merge:false（整树替换）后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8')).replace('merge: true', 'merge: false');
  await assert.rejects(async () => {
    const { els, fetchLog } = await runPanel(src, { tree: SAMPLE_TREE });
    const input = new FakeEl({ 'data-var-edit': 'stat_data\u0001好感度' });
    input.value = '66';
    els['#tavern-var-tree'].querySelectorAll = (sel) => (sel === '[data-var-edit]' ? [input] : []);
    els['#tavern-var-search'].dispatch('input');
    await delay(400);
    input.dispatch('change');
    els['#tavern-var-save'].dispatch('click');
    await delay(60);
    const post = fetchLog.find((f) => f.url.startsWith('/api/muv-engine/state') && f.opts && f.opts.method === 'POST');
    const body = JSON.parse(post.opts.body);
    assert.equal(body.merge, true);
  });
});

test('变量面板：数字输入若不是合法数字则按字符串保存（不静默造数）', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els, fetchLog } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  const input = new FakeEl({ 'data-var-edit': 'stat_data\u0001好感度' });
  input.value = 'abc';
  els['#tavern-var-tree'].querySelectorAll = (sel) => (sel === '[data-var-edit]' ? [input] : []);
  els['#tavern-var-search'].dispatch('input');
  await delay(400);
  input.dispatch('change');
  els['#tavern-var-save'].dispatch('click');
  await delay(60);
  const post = fetchLog.find((f) => f.url.startsWith('/api/muv-engine/state') && f.opts && f.opts.method === 'POST');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.data.stat_data.好感度, 'abc');
});

test('变量面板：搜索命中叶子并拍平显示', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  const search = els['#tavern-var-search'];
  search.value = '天台';
  // 触发防抖的 input 监听
  search.dispatch('input');
  await delay(400);
  assert.match(els['#tavern-var-tree'].innerHTML, /匹配 1 条叶子/);
  assert.match(els['#tavern-var-tree'].innerHTML, /去天台/);
});
test('对照臂：砍掉搜索分支后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace("var q = (varSearch && varSearch.value || '').trim().toLowerCase();", "var q = '';")
    .replace("(varSearch && varSearch.value || '')", "''");
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { tree: SAMPLE_TREE });
    const search = els['#tavern-var-search'];
    search.value = '天台';
    search.dispatch('input');
    await delay(400);
    assert.match(els['#tavern-var-tree'].innerHTML, /匹配 1 条叶子/);
  });
});

test('变量面板：未检测到会话时给可见提示而不是静默空白', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, session: '' });
  assert.match(els['#tavern-var-status'].innerHTML, /未检测到当前会话/);
});

test('变量面板：导出按钮把变量树 JSON 复制到剪贴板', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  // 假 document 要能记录兜底复制路径创建的 textarea
  const created = [];
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR, doc: { created } });
  els['#tavern-var-export'].dispatch('click');
  await delay(30);
  assert.ok(created.length >= 1, '兜底路径应创建 textarea');
  // render() 也会 createElement（展开节点的子容器），要挑出带内容的那个 textarea
  const ta = created.find((e) => e.value && e.value.includes('好感度'));
  assert.ok(ta, '应有一个 textarea 装着变量树 JSON');
  assert.match(ta.value, /"好感度":\s*30/);
});

// ── ⏱ 按楼回看（探测式时间旅行）──────────────────────────
// 快照接口由 C:\dsh-muv-engine 提供：
//   ?snapshots=1 → { ok, snapshots:[{key, at, data|null}] }
//   ?messageKey=… → 形状与普通 GET 一致（{ ok, state:{data} }），键不存在 404
const SNAP_LIST = [
  { key: 'era_mk_1700000000000_aaaa1111', at: 1700000000000, data: { stat_data: { 好感度: 10 } } },
  { key: 'era_mk_1700000001000_bbbb2222', at: 1700000001000, data: null },
];

/** 带 snapshots / messageKey 分支的 fetch 替身 */
function snapFetch(fetchLog) {
  return async (url, opts) => {
    fetchLog.push({ url, opts });
    if (url.indexOf('snapshots=1') >= 0) {
      return { ok: true, json: async () => ({ ok: true, snapshots: SNAP_LIST }) };
    }
    if (url.indexOf('messageKey=') >= 0) {
      return { ok: true, json: async () => ({ ok: true, state: { data: { stat_data: { 好感度: 10 } }, updatedAt: 1 } }) };
    }
    if (url.startsWith('/api/muv-engine/state') && (!opts || opts.method !== 'POST')) {
      return { ok: true, json: async () => ({ ok: true, state: { data: SAMPLE_TREE, updatedAt: 1 } }) };
    }
    if (url.startsWith('/api/muv-engine/state')) {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/api/muv-table/tavern-card')) {
      return { ok: true, json: async () => ({ ok: true, initvarData: SAMPLE_INITVAR }) };
    }
    return { ok: false, json: async () => ({ ok: false, error: 'unexpected ' + url }) };
  };
}

/** 跑面板并进入指定楼层的回看模式 */
async function enterSnapMode(src, key = 'era_mk_1700000000000_aaaa1111') {
  const fetchLog = [];
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR, fetchOverride: snapFetch(fetchLog) });
  const sel = els['#tavern-var-snap-select'];
  sel.value = key;
  sel.dispatch('change');
  await delay(60);
  return { els, fetchLog };
}

test('时间旅行：探测到快照 → 下拉整行显示，label 含时间与键尾 8 位，data:null 项标「过大未存」且禁选', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR, fetchOverride: snapFetch([]) });
  const row = els['#tavern-var-snap-row'];
  const sel = els['#tavern-var-snap-select'];
  assert.ok(row && sel, '探测成功后下拉行元素应存在');
  assert.notEqual(row.style.display, 'none', '整行应取消隐藏');
  assert.match(sel.innerHTML, /…aaaa1111/, 'label 应含键尾 8 位');
  assert.match(sel.innerHTML, /（过大未存）/, 'data:null 项应标注过大未存');
  assert.match(sel.innerHTML, /<option value="era_mk_1700000001000_bbbb2222" disabled>/, 'data:null 项应 disabled 禁选');
});
test('对照臂：砍掉「过大未存」标注与禁选逻辑后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'))
    .replace("(s.data == null ? '（过大未存）' : '')", "''")
    .replace("(s.data == null ? ' disabled' : '')", "''");
  await assert.rejects(async () => {
    const { els } = await runPanel(src, { tree: SAMPLE_TREE, fetchOverride: snapFetch([]) });
    assert.match(els['#tavern-var-snap-select'].innerHTML, /（过大未存）/);
  });
});

test('时间旅行：探测失败（接口 404 / 无 snapshots 字段）→ 整行保持隐藏，主流程不报错', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  // 默认 fetch 替身不认识 snapshots=1（等价接口不存在/404）
  const { els } = await runPanel(src, { tree: SAMPLE_TREE, initvar: SAMPLE_INITVAR });
  assert.equal(els['#tavern-var-snap-row'].style.display, 'none', '探测失败整行必须保持隐藏');
  assert.match(els['#tavern-var-status'].innerHTML, /已读取/, '主流程读取不应被探测失败影响');
});

test('时间旅行：选中楼层 → 按 messageKey 拉取 → 只读渲染（无输入框）+ 顶部回看横幅 +「回到最新」恢复', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els, fetchLog } = await enterSnapMode(src);
  const mk = fetchLog.find((f) => f.url.indexOf('messageKey=era_mk_1700000000000_aaaa1111') >= 0);
  assert.ok(mk, '应按 messageKey 拉取该楼快照');
  const treeHtml = els['#tavern-var-tree'].innerHTML;
  assert.match(treeHtml, /好感度/, '回看树应渲染出叶子');
  assert.equal(/data-var-edit/.test(treeHtml), false, '回看视图不得渲染编辑输入框');
  assert.equal(/data-var-bool/.test(treeHtml), false, '回看视图不得渲染布尔开关');
  assert.match(els['#tavern-var-status'].innerHTML, /正在回看/, '顶部应显示回看横幅');
  assert.notEqual(els['#tavern-var-back-latest'].style.display, 'none', '「回到最新」按钮应出现');
  // 点「回到最新」→ 退出回看，恢复最新树（输入框回来了）
  els['#tavern-var-back-latest'].dispatch('click');
  await delay(700);
  assert.match(els['#tavern-var-tree'].innerHTML, /data-var-edit/, '回到最新后应恢复可编辑渲染');
});
test('对照臂：砍掉回看模式的只读输入框分支后必须失败', async () => {
  // 单行 mutation：让只读分支条件恒假 —— 回看叶子落回普通输入框分支。
  // （IIFE 内第一个 `if (snapMode) {` 就是 leafInputHtml 的只读分支，替换只命中它）
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8')).replace('if (snapMode) {', 'if (false) {');
  await assert.rejects(async () => {
    const { els } = await enterSnapMode(src);
    assert.equal(/data-var-edit/.test(els['#tavern-var-tree'].innerHTML), false, '回看视图不得渲染编辑输入框');
  });
});

test('时间旅行：回看模式下「保存修改」必须拒绝写回（不发出 POST）', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8'));
  const { els, fetchLog } = await enterSnapMode(src);
  els['#tavern-var-save'].dispatch('click');
  await delay(60);
  const post = fetchLog.find((f) => f.url.startsWith('/api/muv-engine/state') && f.opts && f.opts.method === 'POST');
  assert.ok(!post, '回看模式绝不写回 —— 不应发出任何 POST');
  assert.match(els['#tavern-var-status'].innerHTML, /只读|回看/, '应提示当前处于只读回看');
});
test('对照臂：删掉回看写回守卫后必须失败', async () => {
  const src = extractPanelSource(fs.readFileSync(BUNDLE, 'utf8')).replace(
    "if (snapMode) { setStatus('⛔ 正在回看历史楼层的变量（只读）—— 点「回到最新」退出后再修改', '#e67e22'); return; }",
    '');
  await assert.rejects(async () => {
    const { els } = await enterSnapMode(src);
    els['#tavern-var-save'].dispatch('click');
    await delay(60);
    assert.match(els['#tavern-var-status'].innerHTML, /只读|回看/, '守卫被删后状态栏不再提示只读回看');
  });
});
