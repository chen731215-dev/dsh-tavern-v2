// ════════════════════════════════════════════════════════════════
// 仓库卫生闸门（tools/check-repo-hygiene.mjs）的常驻测试
//
// ⚠️ 本文件**按设计**要包含各类坏样本，所以样本一律用**片段拼接 + fromCharCode** 构造：
//   否则闸门会把测试自己当成真凭据拦下（实测踩过 private-key / session-id / _authToken 三条）。
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan, CONTENT_RULES, PATH_RULES, REPO } from '../tools/check-repo-hygiene.mjs'

const BS = String.fromCharCode(92)
const DQ = String.fromCharCode(34)
const tracked = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.split(String.fromCharCode(0)).filter(Boolean) : []
}
const probe = (src) => {
  const tmp = path.join(REPO, '.hygiene-probe.tmp')
  fs.writeFileSync(tmp, src, 'utf8')
  try { return scan(['.hygiene-probe.tmp']) } finally { fs.unlinkSync(tmp) }
}

test('① 当前已跟踪文件必须干净（无凭据 / 无会话记录 / 无真实本机路径）', () => {
  const files = tracked()
  assert.ok(files.length > 0, '拿不到文件清单 —— 判据空跑')
  const issues = scan(files)
  assert.deepEqual(issues.map((i) => i.file + ' [' + i.kind + ']'), [], '★ 仓库里有不该入库的东西')
})

test('② 反证：每条内容规则都能抓到自己的坏样本（样本片段拼接，不许永真）', () => {
  const samples = {
    'github-pat': 'const t = ' + DQ + 'ghp_' + 'A'.repeat(36) + DQ,
    'npm-token': '_auth' + 'Token=' + 'npm_' + 'b'.repeat(36),
    'openai-style-key': 'const k = ' + DQ + 'sk-' + 'c'.repeat(24) + DQ,
    'private-key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'machine-home-path': 'const p = ' + DQ + 'C:' + BS + 'Users' + BS + 'someone' + DQ,
    'session-id-ish': 'session' + 'Id: ' + '550e8400-e29b-41d4-a716-446655440000',
    'auth-assignment': 'const _auth' + 'Token = ' + DQ + 'abcdefghijklmnopqrst' + DQ,
  }
  for (const rule of CONTENT_RULES) {
    const src = samples[rule.id]
    assert.ok(src, '缺 ' + rule.id + ' 的坏样本')
    const hits = probe(src).filter((i) => i.kind === 'content/' + rule.id)
    assert.ok(hits.length >= 1, '★ 规则 ' + rule.id + ' 抓不到自己的坏样本（判据失效）')
  }
})

test('③ 反证：路径规则必须挡住会话日志 / 凭据文件 / 备份', () => {
  for (const f of ['sessions/abc/x.jsonl.zstd', '.env', '.npmrc', 'my-token.json', 'tavern-data/x', '_scratch/foo.mjs', 'lib/index.js.bak']) {
    assert.ok(scan([f]).some((i) => i.kind.startsWith('path/')), '★ 路径规则没拦住：' + f)
  }
  for (const f of ['lib/index.js', 'tests/core.test.js', 'AGENTS.md']) {
    assert.deepEqual(scan([f]).filter((i) => i.kind.startsWith('path/')), [], '正常文件不该被拦：' + f)
  }
})

test('⑦ 反证：**单字符**用户名也必须被抓（旧写法 {2,} 会让它穿闸门）', () => {
  const BS = String.fromCharCode(92)
  const bad = [
    'const p = ' + String.fromCharCode(34) + 'C:' + BS + 'Users' + BS + 'm' + BS + 'AppData' + BS + 'x' + String.fromCharCode(34),
    'const q = ' + String.fromCharCode(34) + '/Users/' + 'm' + '/x' + String.fromCharCode(34),
  ]
  for (const src of bad) {
    const tmp = path.join(REPO, '.hygiene-probe.tmp')
    fs.writeFileSync(tmp, src, 'utf8')
    try {
      const hits = scan(['.hygiene-probe.tmp']).filter((x) => x.kind === 'content/machine-home-path')
      assert.ok(hits.length >= 1, '★ 单字符用户名的本机路径穿闸门了：' + JSON.stringify(src))
    } finally { fs.unlinkSync(tmp) }
  }
})

test('④ 占位符不算（文档与提示文案里的示意写法不该误报）', () => {
  for (const s of ['<home>/.dsh', 'C:' + BS + 'Users' + BS + '...', 'C:/Users/<name>/x']) {
    assert.deepEqual(probe(s).filter((i) => i.kind === 'content/machine-home-path'), [], '占位符不该判红：' + JSON.stringify(s))
  }
})

test('⑥ 反误报：跨字符串边界的拼接不许被判成凭据（2026-10-08 移植到 muv 第一跑就撞到）', () => {
  const Q = String.fromCharCode(39)
  // 命中过的形态：`…token=' + rtProbe.hasFit + '…` —— 值跨越了一对引号，其实是拼接
  const cases = [
    'log(' + Q + ' 引导脚本含专属 token=' + Q + ' + rtProbe.hasFit + ' + Q + ' 尾' + Q + ')',
    'const apiKey = ' + Q + ' + process.env.K + ' + Q,
  ]
  for (const src of cases) {
    const tmp = path.join(REPO, '.hygiene-probe.tmp')
    fs.writeFileSync(tmp, src, 'utf8')
    try {
      const out = scan(['.hygiene-probe.tmp']).filter((x) => x.kind === 'content/auth-assignment')
      assert.deepEqual(out, [], '★ 拼接式写法被误判成凭据：' + JSON.stringify(src))
    } finally { fs.unlinkSync(tmp) }
  }

  // ★ 正向断言（审核方要求）：**收紧不许把真凭据一起漏掉**。
  //   反例来源：我第一版把值里的 `+` 一律禁掉 ⇒ base64/JWT 里含 `+` 的真凭据不再被抓。
  const mustCatch = [
    'const apiKey = ' + Q + 'AAAAB3NzaC1yc2E+AAAABBBBCCCC' + Q,        // 含 + 的 base64 式凭据
    'const password = ' + Q + 'correct horse battery staple' + Q,     // 含空格的密码短语
    'const _authToken = ' + Q + 'abcdefghijklmnopqrst' + Q,           // 纯单字面量
  ]
  for (const src of mustCatch) {
    const tmp = path.join(REPO, '.hygiene-probe.tmp')
    fs.writeFileSync(tmp, src, 'utf8')
    try {
      const hits = scan(['.hygiene-probe.tmp']).filter((x) => x.kind === 'content/auth-assignment')
      assert.ok(hits.length >= 1, '★ 真凭据被判漏（收紧过头）：' + JSON.stringify(src))
    } finally { fs.unlinkSync(tmp) }
  }
})

test('⑤ 规则表非空且每条都有 why（防悄悄加空规则）', () => {
  assert.ok(CONTENT_RULES.length >= 5 && PATH_RULES.length >= 5)
  for (const r of [...CONTENT_RULES, ...PATH_RULES]) assert.ok(r.why && r.why.length >= 2, r.id + ' 缺 why')
})
