/**
 * 侧边栏入口「酒馆」+ 独立面板 overlay（2.7.28）。
 *
 * 宿主没给「侧边栏导航项」插槽，只能像隔壁 dsh-muv-table 那样插 DOM。插 DOM 的风险很集中：
 *
 *   ① 定位口径一变（`newSession` 按钮改名 / sidebar 容器换结构）⇒ 入口**静默消失**，
 *      页面上看不出任何报错，用户以为插件坏了；
 *   ② 关闭面板时如果 unmount/销毁容器，面板里**未保存的编辑**会一起消失；
 *   ③ 图标如果走 innerHTML / DOMParser，会撞转义棘轮（这条有专门的检查工具，这里也钉一遍）。
 *
 * 这里不去模拟整个宿主 DOM（选择器太多且会随 DSH 版本变），只把**契约**钉死；
 * 真机效果由 TUTORIAL §3「管理预设」那段描述保证。
 *
 * 运行：node tests/sidebar-entry.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'client.manager.bundle.js'), 'utf8')

function fnSource(signature) {
  const start = SRC.indexOf(signature)
  assert.ok(start >= 0, 'bundle 里找不到：' + signature)
  let depth = 0
  let seen = false
  for (let i = start; i < SRC.length; i++) {
    const ch = SRC[i]
    if (ch === '{') { depth++; seen = true; continue }
    if (ch === '}') { depth--; if (seen && depth === 0) return SRC.slice(start, i + 1) }
  }
  throw new Error('花括号没配平：' + signature)
}

const ENTRY = fnSource('function initSidebarEntry(')
const VIEW = fnSource('function TavernPanelView(')

test('① 入口插在「新会话」下面，并复用宿主 nav item 的类名', () => {
  assert.match(ENTRY, /data-pane="sidebar"/, '必须按宿主的 sidebar 容器定位')
  assert.match(ENTRY, /newSession/, '必须找到「新会话」按钮作为锚点')
  assert.match(ENTRY, /data-dsh-tavern-entry/, '入口必须带自己的标记（幂等/可定位）')
  assert.match(ENTRY, /querySelector\('\[data-dsh-muv-entry\]/, '必须复用隔壁插件入口的 className（字号/配色跟随宿主）')
  assert.match(ENTRY, /insertBefore\(entry/, '必须是插进侧边栏 DOM，而不是浮在界面上')
})

test('② 面板走 createRoot 独立渲染，关闭只隐藏不销毁（未保存的编辑不能丢）', () => {
  assert.match(ENTRY, /createRoot/, '必须用 react-dom/client 独立渲染面板')
  assert.match(ENTRY, /display = 'none'/, '关闭必须是隐藏，不是销毁')
  assert.ok(!/unmount\(\)/.test(ENTRY), '不许在关闭时 unmount（会丢面板里未保存的编辑）')
  assert.match(VIEW, /Escape/, '必须有 Esc 关闭')
  assert.match(VIEW, /ensureTavernPanelMounted\(/, '面板本体必须是**共享宿主**（与设置页同一个 DOM 节点）')
})

test('②-c 先 append 再 mount：游离节点上 getElementById 全是 null ⇒ 面板画出来但点不动', () => {
  // 真机 bug（2.7.31）：宿主还没进文档就 mount，内部所有 document.getElementById 绑定静默失效，
  // 表现是「顶部预设下拉点不开」「面板里按钮全没反应」。
  const ensure = fnSource('function ensureTavernPanelMounted(')
  const iAppend = ensure.indexOf('appendChild(host)')
  const iMount = ensure.indexOf('mountTavernManager(host)')
  assert.ok(iAppend > 0, 'ensureTavernPanelMounted 必须有 appendChild')
  assert.ok(iMount > iAppend, '★ 必须先 append 再 mount（顺序反了 = 事件全丢）')

  // 浮窗的宿主 effect 不能带空依赖数组：viewRoot 复用，effect 只在首次挂载跑的话，
  // 关掉再打开就是一片空白。
  assert.match(VIEW, /ensureTavernPanelMounted\(bodyRef\.current\);\s*\n\s*\}\);/, '★ 浮窗 effect 不许写 `}, []);`')
})

test('②-b 单例宿主：设置页与浮窗不许各挂一份（否则预设栏永远「加载中…」）', () => {
  // 真机 bug：两个实例同时存在 ⇒ document.getElementById('tavern-manager') 拿到别人的节点，
  // loadSessionPresets 绑在另一个实例的 DOM 上，页面就停在「加载中…」。
  assert.match(SRC, /function tavernPanelHost\(\)/, '必须有全局唯一的宿主工厂')
  assert.match(SRC, /window\.__tavernPanelHost/, '宿主必须挂在 window 上（跨组件共享）')
  assert.match(SRC, /if \(!host\.querySelector\('#tavern-manager'\)\) mountTavernManager\(host\)/, '只 mount 一次（幂等）')
  // 设置页卸载时不许销毁宿主
  const section = fnSource('function TavernSettingsSection(')
  assert.ok(!/innerHTML\s*=\s*''/.test(section), '设置页卸载不许清空宿主（浮窗可能正用着）')
  assert.match(section, /__tavernPanelOwner/, '两个入口要有「谁在用」的仲裁，避免互相抢节点')
})

test('③ 图标不用 innerHTML / DOMParser（转义棘轮盯着这两个入口）', () => {
  assert.ok(!/innerHTML\s*=/.test(ENTRY), '入口里不许出现 innerHTML 赋值')
  assert.ok(!/new DOMParser\(/.test(ENTRY), '不许用 DOMParser 造图标（会被判为清单外注入入口）')
  assert.match(ENTRY, /createElementNS/, '图标必须用 createElementNS 逐个搭')
})

test('④ 幂等：重复 apply 不会插出第二个入口', () => {
  assert.match(ENTRY, /__tavernSidebarEntryHooked/, '必须有一次性守卫')
  assert.match(ENTRY, /document\.body\.contains\(entry\)/, '必须在入口被 React 重渲染冲掉后能补回来')
})

test('⑤ 启动点：apply 里 try/catch 调用，一个入口挂了不影响美化/菜单注入', () => {
  assert.match(SRC, /try \{ initSidebarEntry\(\); \} catch/, 'apply 里必须包 try/catch')
  assert.match(SRC, /var reactDomClient = null;\s*\n\s*try \{ reactDomClient = require\("react-dom\/client"\); \} catch/, 'react-dom 必须是可选依赖（老宿主拿不到就降级）')
})

test('⑥ 面板可拖动 / 可缩放：矩形被夹在可视区内，且位置落盘', () => {
  // 拖动与缩放共用 startGesture('move' | 'resize')，不能各写一套
  assert.match(VIEW, /startGesture\(e, 'move'\)/, '标题栏必须挂拖动')
  assert.match(VIEW, /startGesture\(e, 'resize'\)/, '右下角必须有缩放手柄')
  assert.match(SRC, /TAVERN_PANEL_RECT_KEY = 'dsh-tavern-panel-rect'/, '位置/尺寸必须有持久化 key')
  assert.match(VIEW, /localStorage\.setItem\(TAVERN_PANEL_RECT_KEY/, '落盘要写同一个 key')
  assert.match(VIEW, /onDoubleClick: toggleMax/, '双击标题栏应最大化/还原')

  // clampPanelRect 是真跑：把函数切出来在 vm 里调用
  const src = fnSource('function clampPanelRect(')
  const vm2 = vm.createContext({ PANEL_MIN_W: 560, PANEL_MIN_H: 360 })
  vm.runInContext(src + '\nthis.clamp = clampPanelRect;', vm2)
  const clamp = vm2.clamp

  // 跨 realm 的对象原型不同，deepEqual 会因此判红 ⇒ 逐字段比
  const pick = (r) => [r.x, r.y, r.w, r.h].join(',')

  assert.equal(pick(clamp({ x: 0, y: 0, w: 100, h: 100 }, 1280, 800)), '8,8,560,360', '过小要被抬到最小尺寸')
  assert.equal(pick(clamp({ x: 2000, y: 2000, w: 900, h: 600 }, 1280, 800)), '372,192,900,600', '跑出右下角要被拉回可视区')
  assert.equal(pick(clamp({ x: 100, y: 50, w: 800, h: 600 }, 1280, 800)), '100,50,800,600', '合法矩形原样返回')
  assert.equal(clamp({ x: 0, y: 0, w: 5000, h: 5000 }, 1280, 800).w, 1264, '尺寸不得超过视口（留 8px 边）')
})
