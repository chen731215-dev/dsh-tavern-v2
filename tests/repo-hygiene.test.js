// ════════════════════════════════════════════════════════════════
// 仓库卫生闸门（tools/check-repo-hygiene.mjs）的常驻测试
//
// ① 当前已跟踪文件干净  ② 每条内容规则都能抓自己的坏样本（防永真）
// ③ 路径规则挡住 git add -f ④ 占位符不误报 ⑤ 规则表不许空 why
// ════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan, CONTENT_RULES, PATH_RULES, REPO } from '../tools/check-repo-hygiene.mjs'

const BS = String.fromCharCode(92)
const tracked = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
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

test('② 反证：每条内容规则都必须能抓到自己的坏样本（不许永真）', () => {
  const samples = {
    'github-pat': 'const t = "ghp_' + 'A'.repeat(36) + '"',
    'npm-token': '_authToken=npm_' + 'b'.repeat(36),
    'openai-style-key': 'const k = "sk-' + 'c'.repeat(24) + '"',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----',
    'machine-home-path': 'const p = "C:' + BS + 'Users' + BS + 'someone"',
    'session-id-ish': 'sessionId: 550e8400-e29b-41d4-a716-446655440000',
    'auth-assignment': 'const _authToken = "abcdefghijklmnopqrst"',
  }
  for (const rule of CONTENT_RULES) {
    const src = samples[rule.id]
    assert.ok(src, '缺 ' + rule.id + ' 的坏样本')
    const hits = probe(src).filter((i) => i.kind === 'content/' + rule.id)
    assert.ok(hits.length >= 1, '★ 规则 ' + rule.id + ' 抓不到自己的坏样本（判据失效）')
  }
})

test('③ 反证：路径规则必须挡住会话日志 / 凭据文件 / 备份', () => {
  for (const f of ['sessions/abc/session.v4.jsonl.zstd', '.env', '.npmrc', 'my-token.json', 'tavern-data/x', '_scratch/foo.mjs', 'lib/index.js.bak']) {
    assert.ok(scan([f]).some((i) => i.kind.startsWith('path/')), '★ 路径规则没拦住：' + f)
  }
  for (const f of ['lib/index.js', 'tests/core.test.js', 'AGENTS.md']) {
    assert.deepEqual(scan([f]).filter((i) => i.kind.startsWith('path/')), [], '正常文件不该被拦：' + f)
  }
})

test('④ 占位符不算（文档里的示意写法不该误报）', () => {
  for (const s of ['<home>/.dsh', 'C:' + BS + 'Users' + BS + '...', 'C:/Users/<name>/x']) {
    assert.deepEqual(probe(s).filter((i) => i.kind === 'content/machine-home-path'), [], '占位符不该被判为本机路径：' + JSON.stringify(s))
  }
})

test('⑤ 规则表非空且每条都有 why（防悄悄加空规则）', () => {
  assert.ok(CONTENT_RULES.length >= 5 && PATH_RULES.length >= 5)
  for (const r of [...CONTENT_RULES, ...PATH_RULES]) assert.ok(r.why && r.why.length >= 2, r.id + ' 缺 why')
})
