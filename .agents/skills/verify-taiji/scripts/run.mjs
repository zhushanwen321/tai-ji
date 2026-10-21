#!/usr/bin/env node
/**
 * scenario runner（API-CONTRACT §3）。
 *
 * 职责：分配 runId/runDir/独立实例名 → launch → waitReady → doctor → 跑 run(ctx) →
 * 逐 step 落 summary.jsonl → dispose → 证据幸存核对 → report.md + verdict.json →
 * 退出码 pass=0 / degraded=0（--strict 时 2）/ fail=1。
 *
 * scenario 只写业务步骤（export const meta + export async function run(ctx)）；
 * runner 负责生命周期与取证，不定义业务断言。
 *
 * 用法：
 *   node scripts/run.mjs scenarios/p0-env-smoke.mjs [--artifacts-dir <dir>] [--json]
 *     [--keep] [--name <实例名>] [--strict] [--run-id <id>] [--timeout-ms <ms>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createInstance, resolveRepo } from './lib/instance.mjs'
import { createEvidence } from './lib/evidence.mjs'
import { createUI } from './lib/ui.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

const argv = process.argv.slice(2)

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}
const hasFlag = (name) => argv.includes(`--${name}`)

const asJson = hasFlag('json')
const keep = hasFlag('keep')
const strict = hasFlag('strict')

/** 定位 scenario（第一个非 flag 的位置参数，且不是 flag 的值）。 */
function resolveScenarioPath() {
  const valueFlags = new Set(['artifacts-dir', 'name', 'run-id', 'timeout-ms'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (valueFlags.has(a.slice(2))) i++ // 跳过 flag 值
      continue
    }
    return path.resolve(a)
  }
  return null
}

const scenarioPath = resolveScenarioPath()
if (!scenarioPath || !fs.existsSync(scenarioPath)) {
  const msg = {
    ok: false,
    reason: `scenario 不存在：${scenarioPath ?? '(未给)'}`,
    hint: 'node scripts/run.mjs <scenario.mjs> [--artifacts-dir <dir>]',
  }
  process.stdout.write(`${JSON.stringify(msg)}\n`)
  process.exit(2)
}

const repo = resolveRepo(flag('repo', process.cwd()))
const worktree = path.basename(repo)

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function logLine(line) {
  if (asJson) process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

const scenario = await import(pathToFileURL(scenarioPath).href)
const meta = scenario.meta ?? {}
const runFn = scenario.run
if (typeof runFn !== 'function') {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      reason: 'scenario 必须 export async function run(ctx)',
      evidence: { scenarioPath },
    })}\n`,
  )
  process.exit(2)
}
if (!meta.id) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: 'scenario meta.id 缺失', evidence: { scenarioPath } })}\n`)
  process.exit(2)
}

const runId = flag('run-id', stamp())
const runBase = flag('artifacts-dir')
  ? path.resolve(flag('artifacts-dir'))
  : path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', worktree)
const runDir = path.join(runBase, runId, String(meta.id))
fs.mkdirSync(runDir, { recursive: true })

const ev = createEvidence({ runDir, feature: String(meta.id), meta: { runId, worktree, repo, scenario: path.relative(repo, scenarioPath) } })
const log = (msg) => {
  const line = `[${String(meta.id)}] ${msg}`
  logLine(line)
  try {
    fs.appendFileSync(path.join(runDir, 'run.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 日志失败不阻塞 */
  }
}

const instanceName = flag('name', `verify-${runId}`)
const dataDir = path.join(os.homedir(), '.taiji-dev', `verify-${runId}`)
const faux = meta.faux ?? scenario.faux

log(`runId=${runId} worktree=${worktree} instance=${instanceName} dataDir=${dataDir}`)
log(`runDir=${runDir}`)

// 能力清单核对（capabilities/*.md 的 `# <id> · <name>` 标题）
function documentedCapabilityIds() {
  const dir = path.join(SKILL_DIR, 'capabilities')
  const ids = new Set()
  if (!fs.existsSync(dir)) return ids
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    // H1-H3 都接受：契约 §4 骨架是 H1，但同批并行交付的域文档用 H2（`## <id> · <名>`）
    for (const m of text.matchAll(/^#{1,3}\s+([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\s+·/gm)) ids.add(m[1])
  }
  return ids
}
const documented = documentedCapabilityIds()
const missingCovers = (meta.covers ?? []).filter((id) => !documented.has(id))
if (missingCovers.length > 0) {
  // 已知文档缺口（B1+ 分批补 capability 文档）：记证据与步骤，不算断言失败也不降级
  ev.step({ step: 'covers.docgap', channel: 'C', exitCode: 0, stats: { missing: missingCovers } })
  ev.attach('covers-doc-gap', `以下 covers 暂无 capabilities/*.md 文档（B0 已知缺口）：\n${missingCovers.join('\n')}\n`)
  log(`warn: covers 缺文档 ${missingCovers.join(', ')}`)
}

const instance = createInstance({ repo, name: instanceName, dataDir, faux, background: true })
let proto = null
let ui = null
let thrown = null
let scenarioResult = {}

async function disposeInstance(reason) {
  if (keep && reason === 'run') {
    await proto?.close().catch(() => {})
    proto = null
    ev.step({ step: 'instance.keep', channel: 'C', exitCode: 0, stats: { pid: instance.pid, dataDir } })
    log(`--keep：实例保留 pid=${instance.pid} dataDir=${dataDir}（收尾请按 PID kill）`)
    return
  }
  const t0 = Date.now()
  try {
    await instance.dispose()
    ev.step({ step: 'instance.dispose', channel: 'C', exitCode: 0, stats: { elapsedMs: Date.now() - t0, dataDir } })
    ev.assert('dispose 后端口释放 + 自建数据目录已删', true, {
      channel: 'C',
      expected: '端口空闲 / dataDir 不存在',
      actual: `elapsedMs=${Date.now() - t0}`,
    })
    log(`dispose 完成（${Date.now() - t0}ms）`)
  } catch (e) {
    ev.step({
      step: 'instance.dispose',
      channel: 'C',
      exitCode: 1,
      stats: { elapsedMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) },
    })
    ev.assert('dispose 完成（进程停 + 端口释放）', false, {
      channel: 'C',
      expected: '端口空闲',
      actual: e instanceof Error ? e.message : String(e),
    })
    log(`dispose 失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

const onSignal = async (sig) => {
  log(`收到 ${sig}，清理中…`)
  await disposeInstance('signal').catch(() => {})
  process.exit(130)
}
process.once('SIGINT', () => void onSignal('SIGINT'))
process.once('SIGTERM', () => void onSignal('SIGTERM'))

try {
  // 1) launch
  let t0 = Date.now()
  const info = await instance.launch()
  ev.step({ step: 'instance.launch', channel: 'C', exitCode: 0, stats: { ...info, elapsedMs: Date.now() - t0 } })
  ev.assert('launch 返回权威端口/数据目录', Boolean(info.vitePort && info.cdpPort && info.dataDir), {
    channel: 'C',
    expected: 'vitePort/cdpPort/dataDir 均非空',
    actual: { vitePort: info.vitePort, cdpPort: info.cdpPort, dataDir: info.dataDir, instanceName: info.instanceName },
  })
  log(`launched pid=${info.pid} vite=${info.vitePort} cdp=${info.cdpPort} runtimeRange=${JSON.stringify(info.runtimePortRange)}`)

  // 2) waitReady（三条判据）
  t0 = Date.now()
  const ready = await instance.waitReady({ timeoutMs: Number(flag('timeout-ms', '180000')) })
  ev.step({ step: 'instance.waitReady', channel: 'C', exitCode: 0, stats: { elapsedMs: ready.elapsedMs, runtimePort: ready.runtimePort, extensions: ready.extensions } })
  for (const c of ready.conditions) {
    ev.assert(`ready:${c.name}`, c.ok, { channel: 'C', expected: 'ok', actual: c.detail })
  }
  log(`ready in ${ready.elapsedMs}ms（runtime=${ready.runtimePort} extensions=${ready.extensions}）`)

  // 3) doctor（五项体检）
  const doctor = await instance.doctor()
  ev.step({
    step: 'env.doctor',
    channel: 'C',
    exitCode: doctor.exitCode,
    stats: { verdict: doctor.raw?.verdict, checks: doctor.checks.map((c) => `${c.name}:${c.status}`) },
  })
  ev.assert('doctor GREEN', doctor.ok, {
    channel: 'C',
    expected: 'GREEN',
    actual: doctor.checks.map((c) => `${c.name}:${c.status}`).join(' | '),
  })
  log(`doctor ${doctor.ok ? 'GREEN' : 'RED'}`)

  // 4) 协议 + ui（按需）
  proto = await instance.protocol()
  ev.assert('protocol auth 握手成功', true, { channel: 'B', expected: 'auth.result ok', actual: `events=${proto.events.length}` })

  // ui 惰性：只有访问 ctx.ui 才连 CDP 载入 Playwright（env 类 scenario 不依赖 playwright）。
  // 关键：用 createUI({evidence}) 装配——scenario 的截图才会落 runDir，而不是仓内临时目录。
  let uiLoading = null
  const uiProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined // 避免被当成 thenable
        return async (...args) => {
          uiLoading ??= instance.page().then((page) => createUI({ page, evidence: ev, repo }))
          const real = await uiLoading
          return real[prop](...args)
        }
      },
    },
  )
  const ctx = {
    repo,
    instance,
    get protocol() {
      return proto
    },
    get ui() {
      if (!ui) ui = uiProxy
      return ui
    },
    get dataDir() {
      return dataDir
    },
    ev,
    log,
    meta,
  }

  // 5) 跑 scenario
  t0 = Date.now()
  scenarioResult = (await runFn(ctx)) ?? {}
  ev.step({ step: 'scenario.run', channel: 'B', exitCode: 0, stats: { elapsedMs: Date.now() - t0, id: meta.id } })
  log(`scenario 完成（${Date.now() - t0}ms）`)
} catch (e) {
  thrown = e
  ev.step({
    step: 'scenario.run',
    channel: 'B',
    exitCode: 1,
    stats: { error: e instanceof Error ? e.message : String(e), hint: e?.hint, evidence: e?.evidence },
  })
  ev.assert('scenario 无异常', false, {
    channel: 'B',
    expected: 'run() 正常返回',
    actual: e instanceof Error ? `${e.message}${e.hint ? `（hint: ${e.hint}）` : ''}` : String(e),
  })
  if (e?.evidence) ev.attach('error-evidence', e.evidence)
  if (e?.stack) ev.attach('error-stack', e.stack)
  log(`scenario 失败：${e instanceof Error ? e.message : String(e)}`)
}

// 6) 收尾（dispose）
await disposeInstance('run')

// 6b) runner 自建的数据目录清理：instance.dispose 只删「自己 mkdtemp 的」目录，
// run.mjs 是显式传 --data-dir 的调用方 → 由 runner 负责删（仅 verify-* 前缀，prod/dev 树其余不碰）
if (!keep) {
  const dirName = path.basename(dataDir)
  if (dirName.startsWith('verify-')) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* 删除失败由下面的断言暴露 */
    }
    const gone = !fs.existsSync(dataDir)
    ev.step({ step: 'dataDir.cleanup', channel: 'C', exitCode: gone ? 0 : 1, stats: { dataDir, gone } })
    ev.assert('C: runner 自建数据目录已删除', gone, {
      channel: 'C',
      expected: `${dataDir} 不存在`,
      actual: gone ? '已删' : '仍存在',
    })
    log(`dataDir ${gone ? '已删除' : '未删除'}: ${dataDir}`)
  }
}

// 7) 证据幸存核对（dispose 后重新 stat）
const survivors = ['summary.jsonl', 'assertions.jsonl'].filter((f) => fs.existsSync(path.join(runDir, f)))
const pngs = fs.readdirSync(runDir).filter((f) => f.endsWith('.png'))
const survivorsOk = survivors.length === 2 && fs.existsSync(runDir)
ev.assert('证据幸存（dispose 后 summary/assertions 仍在）', survivorsOk, {
  channel: 'C',
  expected: 'summary.jsonl + assertions.jsonl 存在',
  actual: `files=${fs.readdirSync(runDir).length} png=${pngs.length} missing=${['summary.jsonl', 'assertions.jsonl'].filter((f) => !survivors.includes(f)).join(',') || 'none'}`,
})

// 8) report + verdict
// uncovered = 本应覆盖但没跑成（→ degraded）；notProvable = 本剧本原理上不证明（信息项，不降级）
const uncovered = [...(scenarioResult.uncovered ?? [])]
const gotchas = [...(scenarioResult.gotchas ?? [])]
const notProvable = [...(meta.notProvable ?? []), ...(scenarioResult.notProvable ?? [])]
const blockers = []
if (thrown) blockers.push(thrown instanceof Error ? thrown.message : String(thrown))
for (const a of ev.assertions) {
  if (!a.ok) blockers.push(`断言失败: ${a.name}（期望 ${JSON.stringify(a.expected)}，实际 ${JSON.stringify(a.actual)}）`)
}

let verdict = 'pass'
if (thrown || ev.ok === false) verdict = 'fail'
else if (uncovered.length > 0) verdict = 'degraded'

ev.report({
  title: `${meta.id} · ${meta.title ?? ''}`,
  uncovered,
  gotchas,
  summary: [
    `- runId：${runId}`,
    `- 实例名：${instanceName}`,
    `- 数据目录：${dataDir}`,
    `- 优先级：${meta.priority ?? '—'} / requires：${(meta.requires ?? []).join(',') || 'none'}`,
    `- covers：${(meta.covers ?? []).join(', ') || '—'}`,
    `- provable：${(meta.provable ?? []).join(' / ') || '—'}`,
    `- notProvable：${notProvable.join(' / ') || '—'}`,
    ...(uncovered.length > 0 ? [`- 未覆盖（uncovered）：${uncovered.join(' / ')}`] : []),
    ...(gotchas.length > 0 ? [`- Gotchas：${gotchas.join(' / ')}`] : []),
  ].join('\n'),
})
const verdictFile = ev.verdict({ verdict, deviations: [], blockers, notProvable })

// 9) 最终证据核对（report/verdict 已落盘）
const finalFiles = fs.readdirSync(runDir)
const requiredFinal = ['report.md', 'verdict.json', 'summary.jsonl', 'assertions.jsonl']
const finalMissing = requiredFinal.filter((f) => !finalFiles.includes(f))
if (finalMissing.length > 0) {
  verdict = 'fail'
  blockers.push(`证据缺失: ${finalMissing.join(', ')}`)
  fs.writeFileSync(
    verdictFile,
    `${JSON.stringify({ verdict, deviations: [], blockers, notProvable, meta: { feature: meta.id, runDir } }, null, 2)}\n`,
    'utf8',
  )
}

const result = {
  ok: verdict !== 'fail',
  scenario: meta.id,
  runId,
  runDir,
  dataDir,
  instanceName,
  verdict,
  assertions: { total: ev.assertions.length, failed: ev.assertions.filter((a) => !a.ok).length },
  blockers,
  notProvable,
  evidence: { verdictFile, report: path.join(runDir, 'report.md'), summary: path.join(runDir, 'summary.jsonl') },
}
const exitCode = verdict === 'fail' ? 1 : verdict === 'degraded' && strict ? 2 : 0
// 同步写 stdout：process.exit 前用 writeSync 防管道写被截断
fs.writeSync(1, `${JSON.stringify(result)}\n`)
process.exit(exitCode)
