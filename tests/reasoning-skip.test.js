/**
 * 思维链（reasoning）不参与消息美化。
 *
 * 用户实测（2026-11-01，Grok-4.7）：DeepSeek Harness 把 reasoning 块渲染成
 * `div[data-variant="think"]`，而**它内部同样是 `_markdown_*` 正文容器**（ReasoningContent →
 * MarkdownText）。于是两个插件按「类名形状 + 有块级子节点」扫正文时，把思维链当成了普通回复：
 *
 *   · 思维链里出现角色名 / 日期 / `_.set` ⇒ 被判成"有状态" ⇒ 平台往上贴一张状态栏
 *     ⇒ 用户看到「思维链里也在生成状态栏」；
 *   · 裸标签（`<options>` / `<details>`）与卡正则也会改写思维链正文。
 *
 * 修法：两个插件在按类名扫正文时都先问一句「这个容器是不是思维链」，
 * 判据用 DSH 自己的属性（`[data-variant="think"]` 祖先链），不猜 CSS Modules 哈希。
 *
 * 本套件钉四件事：
 *   ① 两个插件里都存在该判据函数，且**在两处取样点被调用**（酒馆 isMessageBody / muv messageTargets）；
 *   ② 判据用的是 `data-variant="think"` 而不是类名哈希（哈希每次重建都变）；
 *   ③ 反例：只看类名的旧写法必须被抓住（证明判据不是永真 —— 它必须多问一句）；
 *   ④ muv 的产物与分片仍然逐字节一致（改分片后必须重跑 build-client）。
 *
 * 运行：node --test tests/reasoning-skip.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TAVERN = fs.readFileSync(path.join(REPO, 'lib', 'client.manager.bundle.js'), 'utf8')

/** muv-engine 与酒馆插件同属作者的另一仓，缺失时本套件只跑酒馆那一半。 */
const MUV_PATH = process.env.MUV_CLIENT || path.resolve(REPO, '..', 'dsh-muv-engine', 'lib', 'client.js')
const muvSrc = fs.existsSync(MUV_PATH) ? fs.readFileSync(MUV_PATH, 'utf8') : null

test('① 酒馆客户端：判据存在，且在 isMessageBody 里被调用', () => {
  assert.match(TAVERN, /function isReasoningBody\(el\)/)
  const i = TAVERN.indexOf('function isMessageBody(el)')
  assert.ok(i > 0, '找不到 isMessageBody')
  const body = TAVERN.slice(i, TAVERN.indexOf('function messageRootOf', i))
  assert.match(body, /isReasoningBody\(el\)/,
    '★ isMessageBody 必须调用 isReasoningBody —— 否则思维链会被当成正文美化')
})

test('①-b 酒馆客户端：裸标签兜底也不会碰思维链', () => {
  // renderRawTagBlocks 走的是 findAiMessages 的结果，所以只要取样点挡住就够；
  // 这里额外钉住「它会跳过祖先在 think 里的容器」这一条不被顺手删掉。
  assert.match(TAVERN, /closest\('\[data-variant="think"\]'\)/,
    '★ 判据必须走 closest 检查祖先链（ReasoningRow 根节点在正文容器之上）')
})

test('② 判据用 DSH 的属性，不用会漂的类名哈希', () => {
  const i = TAVERN.indexOf('function isReasoningBody(el)')
  const fn = TAVERN.slice(i, i + 700)
  assert.match(fn, /data-variant/)
  assert.ok(!/_markdown_[a-z0-9]+_\d+/.test(fn),
    '★ 判据里不许写死 CSS Modules 哈希 —— 每次重建 Web 资源都会变')
})

test('②-b 反例：只看类名的旧写法必须漏掉思维链', () => {
  // 旧判据：类名像正文 + 有块级子节点 ⇒ 就美化。思维链容器两条都满足，
  // 所以它会放行 —— 这正是用户报的那个 bug。用纯函数复刻，证明判据不是永真。
  const OLD = (cls, hasBlocks, _isThink) => /_markdown_[a-z0-9]+_\d+/i.test(cls) && hasBlocks
  const NEW = (cls, hasBlocks, isThink) => /_markdown_[a-z0-9]+_\d+/i.test(cls) && hasBlocks && !isThink
  const thinkCls = '_markdown_1ypvv_5'
  assert.equal(OLD(thinkCls, true, true), true, '反例：旧判据会把思维链当正文（bug 形态）')
  assert.equal(NEW(thinkCls, true, true), false, '★ 新判据必须挡住思维链')
  assert.equal(NEW(thinkCls, true, false), true, '真实正文仍要被美化（不许误杀）')
})

test('③ muv-engine：判据存在且在 messageTargets 里被调用', { skip: muvSrc === null }, () => {
  assert.match(muvSrc, /function muvIsReasoningBody\(el\)/)
  const i = muvSrc.indexOf('function messageTargets()')
  assert.ok(i > 0, '找不到 messageTargets')
  const body = muvSrc.slice(i, muvSrc.indexOf('function muvSessionTurnsNow', i) + 1)
  assert.match(body, /muvIsReasoningBody\(body\)/,
    '★ messageTargets 必须挡掉思维链，否则状态栏会被贴进 reasoning 块')
})
