/**
 * 「设定优先级」声明（preset / skill）的单元测试。
 *
 * 背景：DSH 把 skill 正文作为**指令**注入到这一步消息列表的末尾，模型很容易把它当成新身份；
 * 酒馆的 tavern:card 在 system prompt 顶部，光写"我优先级最高"压不住。所以冲突必须有一个
 * 唯一、可切换的裁决口径 —— 这就是 buildSkillPriorityText() 的职责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSkillPriorityText } from '../lib/server/assemble.js'

test('缺省 / 非法值一律按「预设优先」', () => {
  for (const state of [undefined, {}, { skillPriority: 'nonsense' }, { skillPriority: 42 }]) {
    const t = buildSkillPriorityText(state)
    assert.match(t, /【设定优先级 · preset（预设优先，本会话生效）】/, '必须是 preset 声明：' + JSON.stringify(state))
    assert.match(t, /角色卡 \/ 世界书 \/ 预设模块/, '要写明裁决顺序')
    assert.match(t, /一律以本段（预设）为准/, '要写明冲突时的落点')
    assert.equal(t.includes('【设定优先级 · skill'), false, 'preset 模式不能同时出现 skill 声明')
  }
})

test('skill 优先：流程/文风让位，但角色卡/世界书仍是事实来源', () => {
  const t = buildSkillPriorityText({ skillPriority: 'skill' })
  assert.match(t, /【设定优先级 · skill（技能优先，本会话生效）】/)
  assert.match(t, /事实来源/, '必须保留「设定事实」这条底线')
  assert.match(t, /不得改写或替换/, '不得借技能优先改写世界观/人名')
  assert.equal(t.includes('一律以本段（预设）为准'), false, 'skill 模式不能残留相反的裁决')
})

test('声明以空行结尾（便于直接拼在 header 前面）', () => {
  assert.ok(buildSkillPriorityText({}).endsWith('\n\n'))
  assert.ok(buildSkillPriorityText({ skillPriority: 'skill' }).endsWith('\n\n'))
})
