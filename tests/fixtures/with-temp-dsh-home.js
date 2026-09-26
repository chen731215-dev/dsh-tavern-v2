/**
 * 测试夹具加载器：在真正的 lib/index.js 求值**之前**把 $DSH_HOME 指到临时目录。
 *
 * 为什么需要它：`lib/index.js` 在模块顶层就把 `ROOT = join(DSH_HOME, '.agent-presets')`
 * 算好了（apply() 里的 bindDshPaths 只会在插件真正挂载时再绑一次）。测试文件里
 * 再改 `process.env.DSH_HOME` 已经太晚 —— ESM 的 import 提升会在测试体之前求值。
 *
 * 做法：把夹具目录建好，再动态 `import()` lib/index.js（带 cache-buster，避免同进程内
 * 别的测试已经加载过旧 home 的实例），然后原样转发导出。
 *
 * 夹具内容：`<tmp>/dsh-tavern-greeting-seed-fixture/.agent-presets/<presetId>/characters.json`
 * 一张最小卡（带 `first` 字段）。仅在夹具卡缺失时写入，已有则不覆盖，避免并发写坏。
 *
 * 用法（测试文件里）：
 *   import { _test } from './fixtures/with-temp-dsh-home.js'
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 greeting-seed.test.js 里断言语义保持一致：沿用原真卡的预设 id。 */
export const FIXTURE_PRESET_ID = 'preset-mt5ip9cc-t6josi'
/** 最小开场白：形状对齐真卡 first_mes —— 以【主页】开头、带 <VariableInsert> 结构
 * （卡的「[0] 主页」正则按它做锚点），且长度 > 100 字符（测试断言"原文没被引导顶掉"）。
 * 真卡那句是 2921 字，这里用循环拼出等价长度的假文本，不搬任何真实卡内容。 */
export const FIXTURE_GREETING = [
  '【主页】',
  '<VariableInsert>{"姓名":"夹具角色","好感度":0,"当前回合":1}</VariableInsert>',
  '── 角色状态 ──',
  ...Array.from({ length: 8 }, (_, i) => `第${i + 1}段：这是用于回归测试的夹具描述文本，仅占位，不含任何真实角色卡内容。`),
  '【行动选项】',
  '(A) 继续观察周围的环境',
  '(B) 主动搭话',
  '(C) 暂时按兵不动',
].join('\n')
/** 临时 DSH home；测试只读这里，不碰真机的 ~/.dsh。 */
export const FIXTURE_HOME = path.join(os.tmpdir(), 'dsh-tavern-greeting-seed-fixture')
export const FIXTURE_PRESET_DIR = path.join(FIXTURE_HOME, '.agent-presets', FIXTURE_PRESET_ID)

process.env.DSH_HOME = FIXTURE_HOME

try {
  fs.mkdirSync(path.join(FIXTURE_HOME, 'sessions'), { recursive: true })
  fs.mkdirSync(FIXTURE_PRESET_DIR, { recursive: true })
  const charsPath = path.join(FIXTURE_PRESET_DIR, 'characters.json')
  const existing = fs.existsSync(charsPath) ? fs.readFileSync(charsPath, 'utf8') : ''
  if (!existing.includes('夹具开场白')) {
    fs.writeFileSync(
      charsPath,
      JSON.stringify([{
        name: '_足控天堂2',
        enabled: true,
        first: FIXTURE_GREETING,
        desc: '夹具卡：只为回归测试提供 first 字段',
      }], null, 2) + '\n',
      'utf8',
    )
  }
} catch (error) {
  console.error('[with-temp-dsh-home] 夹具目录创建失败，测试会失败：', error && error.message)
}

const libPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'index.js')
const mod = await import(new URL(`file://${libPath.replace(/\\/g, '/')}`).href + '?fixture-home=1')

export const _test = mod._test
export default mod
