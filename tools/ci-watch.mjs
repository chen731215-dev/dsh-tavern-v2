#!/usr/bin/env node
/**
 * 看 GitHub Actions 的结果（匿名，不需要 token —— 本仓是公开仓库）。
 *
 * 为什么要有它：CI 是「唯一的自动化强制点」，而**「以为它在跑、其实没跑」本身就是一类故障**
 * （工作流文件名错、YAML 缩进错、脚本改名、runs-on 写错……任何一种都会让它静默失效）。
 * 所以查结果这件事不该靠手敲 API —— 一条命令拿到「结论 + 每个 step 的成败」。
 *
 * 用法：
 *   node tools/ci-watch.mjs              # 盯最新一次运行
 *   node tools/ci-watch.mjs 37725561712  # 盯指定的 run id
 *
 * 退出码：0 = 已完成且 success；1 = 已完成但非 success（或查询失败）。
 * 若等满轮询次数仍未完成，退出码 0 并提示稍后再看（不算失败）。
 */
const REPO = 'chen731215-dev/dsh-tavern-v2'
const MAX_POLLS = 18
const INTERVAL_MS = 20_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-tavern-ci-watch' },
  })
  return { status: r.status, json: await r.json() }
}

const arg = process.argv[2]
let runId = arg
if (!runId) {
  const { status, json } = await api('/actions/runs?per_page=1')
  if (status !== 200) {
    console.error('查询失败：API ' + status + ' ' + (json.message || ''))
    process.exit(1)
  }
  const latest = (json.workflow_runs || [])[0]
  if (!latest) { console.error('这个仓库还没有任何运行记录 —— 工作流可能没被触发过'); process.exit(1) }
  runId = String(latest.id)
  console.log('最新运行 id = ' + runId + '（' + latest.name + ' @ ' + latest.head_branch + '）')
}

let run = null
for (let i = 0; i < MAX_POLLS; i++) {
  const { status, json } = await api('/actions/runs/' + runId)
  if (status !== 200) {
    console.error('查询失败：API ' + status + ' ' + (json.message || ''))
    process.exit(1)
  }
  run = json
  console.log('[' + String(i).padStart(2) + '] status=' + run.status + '  conclusion=' + run.conclusion)
  if (run.status === 'completed') break
  await sleep(INTERVAL_MS)
}

if (!run || run.status !== 'completed') {
  console.log('\n仍未完成，稍后再看：' + (run && run.html_url))
  process.exit(0)
}

console.log('\n══ 结论：' + run.conclusion + ' ══')
console.log('commit  = ' + String(run.head_sha).slice(0, 7) + ' | branch = ' + run.head_branch)
console.log('url     = ' + run.html_url)

const { json: jobs } = await api('/actions/runs/' + runId + '/jobs')
for (const job of jobs.jobs || []) {
  console.log('\n── job: ' + job.name + '  (' + job.conclusion + ') ──')
  for (const s of job.steps || []) {
    const mark = s.conclusion === 'success' ? '✅' : s.conclusion === 'skipped' ? '⏭' : '❌'
    console.log('   ' + mark + ' ' + s.name + '  [' + s.conclusion + ']')
  }
}

process.exit(run.conclusion === 'success' ? 0 : 1)
