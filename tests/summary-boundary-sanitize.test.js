// ════════════════════════════════════════════════════════════════
// 落库边界净化的对照测试（2.7.15，议题 docs/issues/2026-10-08-…-边界净化.md）
//
// 守两条：**坏样本必须被净化** + **好样本必须逐字节保留**（防"净化过猛把剧情删了"）。
// 这是纵深防御的一层，不是渲染层 esc 的替代。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeModelText, sanitizeRelations } from '../lib/server/summary.js'

test('① 坏样本必须被净化（标签 / 事件属性 / 危险协议 / 控制字符）', () => {
  const bad = [
    ['img onerror', '<img src=x onerror=alert(1)>', [/<img/, /onerror/]],
    ['script 块', '</textarea><script>alert(1)</script>', [/<\/textarea/, /<script/]],
    ['js 协议', 'javascript:alert(1)', [/javascript\s*:/]],
    ['data 协议', 'data:text/html;base64,PHNjcmlwdD4=', [/data\s*:/]],
    ['点击处理器', 'onclick=alert(1)', [/onclick/]],
    ['控制字符', '前' + String.fromCharCode(0) + '后', [/\u0000/]],
  ]
  for (const [name, src, mustGone] of bad) {
    const out = sanitizeModelText(src)
    for (const re of mustGone) assert.equal(re.test(out), false, '★ ' + name + ' 未被净化：' + JSON.stringify(out))
    assert.notEqual(out, src, '★ ' + name + ' 必须发生改变')
  }
})

test('② 好样本必须逐字节保留（防净化过猛）', () => {
  const good = [
    '她把「银月」别在腰后，低声说：别怕，我在。',
    '他数了数：3 < 5，于是决定再等一会儿。',
    '对话里出现了 a <b 这种没闭合的尖括号，不该被当标签删掉。',
    '第一行\n第二行\t带制表符',
    '她说："走吧"，然后笑了 🙂',
  ]
  for (const s of good) assert.equal(sanitizeModelText(s), s, '★ 正常文本被改动了：' + JSON.stringify(s))
})

test('③ relations 只做字符级净化，字段不许丢', () => {
  const rels = [{ source: '甲', target: '乙<img src=x onerror=alert(1)>', label: '同门' }]
  const out = sanitizeRelations(rels)
  assert.equal(out.length, 1)
  assert.equal(out[0].source, '甲')
  assert.equal(out[0].label, '同门')
  assert.equal(/onerror/.test(out[0].target), false, '★ target 里的载荷必须被削掉')
  assert.equal(out[0].target.startsWith('乙'), true, '★ 语义前缀必须保留')
  assert.deepEqual(sanitizeRelations(null), [])
})

test('④ 幂等：净化两次与一次相同（避免反复改写落库数据）', () => {
  const src = '<b>甲</b> onerror=x javascript:y'
  assert.equal(sanitizeModelText(sanitizeModelText(src)), sanitizeModelText(src))
})
