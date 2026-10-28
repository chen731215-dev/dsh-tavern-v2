// 🚀 快速上手引导：收起之后必须还能展开
//
// 真实事故（2026-10-29，用户反馈）：引导卡的操作行（含「展开引导」按钮）被塞进了 body，
// 而收起时执行的是 body.style.display = 'none' —— 按钮和正文一起被藏掉，
// 于是引导一旦收起就再也打不开。
//
// 这里钉住两条：
//   ① 操作行挂在**卡片**上（`card.appendChild(actions)`），不在 body 里；
//   ② 反证：`body.appendChild(actions)` 必须不存在。
// 只做源码断言是够的：这两行的位置就是 bug 本身，行为层的 DOM 测试在本仓没有承载环境。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'client.manager.bundle.js'), 'utf8')

/** 取 installQuickGuide 的函数体（到下一个顶格 `}` 或缩进更浅的位置为止）。 */
function quickGuideBody(src) {
  const start = src.indexOf('function installQuickGuide(root) {')
  assert.ok(start > 0, '找不到 installQuickGuide')
  const end = src.indexOf('installQuickGuide(container);', start)
  assert.ok(end > start, '找不到 installQuickGuide 的调用点（用作结尾锚）')
  return src.slice(start, end)
}

const body = quickGuideBody(SRC)

test('引导卡的操作行挂在卡片上，不随正文一起收起', () => {
  assert.equal(body.split('card.appendChild(actions)').length - 1, 1,
    '操作行必须 card.appendChild(actions)（恰好一次）')
  assert.equal(body.split('body.appendChild(actions)').length - 1, 0,
    '反证：body.appendChild(actions) 会让「展开引导」按钮随正文一起被 display:none 藏掉')
})

test('收起只隐藏正文，状态记进 localStorage，并保留展开入口', () => {
  assert.match(body, /body\.style\.display = collapsed \? 'none' : 'block'/)
  assert.match(body, /localStorage\.setItem\(GUIDE_KEY, collapsed \? '1' : '0'\)/)
  assert.match(body, /toggle\.textContent = collapsed \? '展开引导' : '收起引导'/)
})
