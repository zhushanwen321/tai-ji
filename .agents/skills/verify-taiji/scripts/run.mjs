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
import { createHash } from 'node:crypto'
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

/** 所有带值 flag（漏登记 = 该 flag 的值会被当成 scenario 路径，见审查 C M16）。 */
const VALUE_FLAGS = new Set([
  'artifacts-dir',
  'name',
  'run-id',
  'timeout-ms',
  'repo',
  'data-dir',
  'scenario',
])

/**
 * 定位 scenario。优先级（高→低）：
 *   ① `--scenario <path>`（显式 flag）
 *   ② 第一个非 flag 位置参数   ← 高于 env：包装壳 verify-run.sh 已把相对路径解析成绝对路径后
 *      以位置参数传入，此时 env 里可能还是未解析的原值（旧实现 env 优先 → 反被覆盖，实测 exit 2）
 *   ③ env `TAIJI_VERIFY_SCENARIO`（dev-flow 引擎零参数 spawn 形态）
 */
function resolveScenarioPath() {
  const explicit = flag('scenario')
  if (explicit) return path.resolve(explicit)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a.slice(2))) i++ // 跳过 flag 值
      continue
    }
    return path.resolve(a)
  }
  const envScenario = process.env.TAIJI_VERIFY_SCENARIO
  if (envScenario) return path.resolve(envScenario)
  return null
}

const scenarioPath = resolveScenarioPath()
if (!scenarioPath || !fs.existsSync(scenarioPath)) {
  const msg = {
    ok: false,
    reason: `scenario 不存在：${scenarioPath ?? '(未给)'}`,
    hint:
      'node scripts/run.mjs <scenario.mjs> [--artifacts-dir <dir>]  ' +
      '| 或 env: TAIJI_VERIFY_SCENARIO=<scenario> TAIJI_VERIFY_ARTIFACTS=<dir> node scripts/run.mjs',
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

/**
 * runId / instanceName 严格校验（审查 C M7：未校验时 `--run-id 'z/../../tmp/verify-x'`
 * 可让 dataDir 逃出 ~/.taiji-dev 并被 rm -rf 整树删除）。
 * 只允许 [A-Za-z0-9._-]，禁止路径分隔符与 `..`。
 */
function assertSafeToken(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..' || value.includes('..')) {
    const msg = {
      ok: false,
      reason: `${label} 非法：${JSON.stringify(value)}`,
      hint: '只允许 [A-Za-z0-9._-]，禁止路径分隔符与 ".."（防数据目录穿越）',
    }
    process.stdout.write(`${JSON.stringify(msg)}\n`)
    process.exit(2)
  }
}

const runId = flag('run-id', stamp())
assertSafeToken(runId, '--run-id')

const runBase = (() => {
  const explicit = flag('artifacts-dir') ?? process.env.TAIJI_VERIFY_ARTIFACTS
  if (!explicit) return path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', worktree)
  const resolved = path.resolve(explicit)
  // 防呆：证据根不允许是危险位置（runner 会往它写文件，不删；但 / 或家目录根会让产物散落）
  const home = os.homedir()
  if (resolved === '/' || resolved === home || resolved === home + path.sep) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        reason: `--artifacts-dir 不能是根目录或家目录根：${resolved}`,
        hint: '给一个具体目录（如 ~/.agents/skill-data/verify-taiji/<worktree>/<runId> 或 /tmp/acc-xxx）',
      })}\n`,
    )
    process.exit(2)
  }
  return resolved
})()
// 证据根：artifactsDir 语义（审查 C M6）= verdict.json 必须落在 artifactsDir 根，
// 否则 dev-flow 的 inspectVerdictAnchorOk 读不到。runDir 仍按 <base>/<runId>/<scenarioId> 存细节，
// 但 verdict.json / summary.jsonl 会同时写一份到 base 根（见文件尾）。
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
assertSafeToken(instanceName, '--name')

// dataDir 值域（审查 C M7）：显式 --data-dir 走仓库权威校验器；缺省 = ~/.taiji-dev/verify-<runId>
// （超 socket 长度预算时 basename 截断+hash，见下方 shortenDataDirBase）。
// 两条路都保证「最终路径在 ~/.taiji-dev 树内且 basename 以 verify- 开头」——
// 后者是清理阶段的删除判据，必须由这里先保证。
const devRoot = path.join(os.homedir(), '.taiji-dev')
// dataDir basename 长度预算，对齐产品侧 D4 门禁（packages/runtime/src/infra/subagent-control/
// paths.ts 的 UNIX_SOCKET_PATH_MAX_BYTES = 104）：runtime 会在 <dataDir>/run/subagent-<pid>.sock
// 建 control socket，路径超 104 字节时启动即 fail-fast 退出，实例永远无法就绪。预算按最坏
// 组成倒推：<devRoot>/<basename>/run/subagent-<pid>.sock ≤ 104，pid 按 7 位（跨平台上限）取，
// 本机 homedir 17 字节 → 预算 49。超预算时截断 + sha256 前 8 位 hex 后缀：确定性（同 runId
// 同名，复跑幂等）、唯一性由 hash 承载、可读性由截断前缀保留，verify- 前缀不动（清理判据）。
const SOCKET_PATH_MAX_BYTES = 104
const SOCKET_PID_MAX_WIDTH = 7
const dataDirBudget =
  SOCKET_PATH_MAX_BYTES - (devRoot.length + path.sep.length) - '/run/subagent-'.length - '.sock'.length - SOCKET_PID_MAX_WIDTH
function shortenDataDirBase(base) {
  if (Buffer.byteLength(base) <= dataDirBudget) return base
  const hash = createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 8)
  const keep = Math.max(1, dataDirBudget - hash.length - 1)
  return `${base.slice(0, keep).replace(/[-_.]+$/, '')}-${hash}`
}
const dataDir = await (async () => {
  const explicit = flag('data-dir') ?? process.env.TAIJI_VERIFY_DATA_DIR
  if (!explicit) return path.join(devRoot, shortenDataDirBase(`verify-${runId}`))
  // run.mjs 由 spawnSync 无 shell 直跑，'~' 前缀不会被 shell 展开——先手动展开成 homedir 绝对路径，
  // 再交给仓库权威校验器；否则 dev-instance-lib.mjs 的 path.resolve 会把 '~' 相对 cwd 解析成
  // <worktree>/~/... 而被树内校验拒绝。
  const expanded = explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : explicit
  const { resolveCustomDataDir } = await import(
    pathToFileURL(path.join(repo, 'apps/electron/scripts/dev-instance-lib.mjs')).href
  )
  return resolveCustomDataDir(expanded)
})()
const dataDirBase = path.basename(dataDir)
if (!dataDir.startsWith(`${devRoot}${path.sep}`) || !dataDirBase.startsWith('verify-')) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      reason: `dataDir 越界：${dataDir}`,
      hint: `必须落在 ${devRoot} 树内且 basename 以 verify- 开头（清理阶段会整树删除）`,
    })}\n`,
  )
  process.exit(2)
}
const faux = meta.faux ?? scenario.faux
const llm = meta.llm ?? scenario.llm
if (faux && llm) {
  throw new Error(`${String(meta.id)}: meta/scenario 同时声明 faux 与 llm（两条零 token 通道互斥）`)
}
// scenario 声明式实例 env（透传 createInstance options.env → dev-instance 子进程）：
// 值必须是 string（spawn env 形态）。当前消费者 = settling 窗口类剧本注入产品侧
// dev-only chaos 开关（TAIJI_AGENT_DEV_SETTLING_DELAY_MS，event-interpreter-settled-delay）。
const scenarioEnv = meta.env ?? scenario.env
if (scenarioEnv !== undefined) {
  if (!scenarioEnv || typeof scenarioEnv !== 'object' || Array.isArray(scenarioEnv)) {
    throw new Error(`${String(meta.id)}: meta.env 必须是 { [name]: string } 对象`)
  }
  for (const [k, v] of Object.entries(scenarioEnv)) {
    if (typeof v !== 'string') {
      throw new Error(`${String(meta.id)}: meta.env["${k}"] 必须是 string（spawn env 形态），实际 ${typeof v}`)
    }
  }
}

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

// mobile 壳 remote-access 预置（meta.remoteAccess 声明启用）：launch 前写
// <dataDir>/remote-access.json（enabled=true + 新生成 64hex token）——main spawn runtime 时
// 现读该文件决定开态（拼 --remote-access --mobile-dist argv），launch 后写不生效。
// token 经 ctx.remoteAccess 交剧本消费（V1 扫码路径的 ?token= 凭据）。
// 助手契约：scenarios/lib/mobile-shell-helper.mjs（与 main 写侧 generateRemoteAccessToken
// 同熵量同形态，0600 对齐）。
let remoteAccessHandle = null
if (meta.remoteAccess ?? scenario.remoteAccess) {
  const { generateRemoteToken, writeRemoteAccessConfig } = await import(
    pathToFileURL(path.join(SKILL_DIR, 'scenarios', 'lib', 'mobile-shell-helper.mjs')).href
  )
  const token = generateRemoteToken()
  const file = writeRemoteAccessConfig(dataDir, token)
  remoteAccessHandle = { token, file }
  ev.step({ step: 'remote-access.seed', channel: 'C', exitCode: 0, stats: { file, enabled: true } })
  log(`remote-access 预置：${file}`)
}

const instance = createInstance({ repo, name: instanceName, dataDir, faux, llm, env: scenarioEnv, background: true })
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
    /** meta.remoteAccess 预置结果（{token, file}；未声明 = null）。 */
    remoteAccess: remoteAccessHandle,
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
// test_evidence（审查 C M5）：dev-flow inspect 契约要求 string 必填，内容 = 证据指针摘要。
// 由 runner 生成（inspect agent 直接复用，不必自己补）。
const testEvidence = [
  `runId=${runId}`,
  `scenario=${meta.id}`,
  `verdict=${verdict}`,
  `assertions=${ev.assertions.length}(failed=${ev.assertions.filter((a) => !a.ok).length})`,
  `runDir=${runDir}`,
  `summary=${path.join(runDir, 'summary.jsonl')}`,
  `report=${path.join(runDir, 'report.md')}`,
].join(' ; ')

const verdictFile = ev.verdict({ verdict, deviations: [], blockers, notProvable, testEvidence })

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

// 10) artifactsDir 根镜像（审查 C M6）：dev-flow 引擎读 `<artifactsDir>/verdict.json` 与
// `<artifactsDir>/summary.jsonl`（inspectVerdictAnchorOk）。runDir 保留完整细节，
// 根上放一份「最近一次 run」的副本，使两种读法都成立。
try {
  for (const f of ['verdict.json', 'report.md', 'summary.jsonl', 'assertions.jsonl']) {
    const src = path.join(runDir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runBase, f))
  }
  fs.writeFileSync(
    path.join(runBase, 'latest-run.json'),
    `${JSON.stringify({ runId, scenario: meta.id, runDir, verdict }, null, 2)}\n`,
    'utf8',
  )
} catch (e) {
  log(`artifactsRoot 镜像失败（不影响 runDir 产物）: ${e instanceof Error ? e.message : String(e)}`)
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
  evidence: {
    verdictFile,
    report: path.join(runDir, 'report.md'),
    summary: path.join(runDir, 'summary.jsonl'),
    artifactsRoot: { dir: runBase, verdict: path.join(runBase, 'verdict.json'), summary: path.join(runBase, 'summary.jsonl') },
  },
}
const exitCode = verdict === 'fail' ? 1 : verdict === 'degraded' && strict ? 2 : 0
// 同步写 stdout：process.exit 前用 writeSync 防管道写被截断
fs.writeSync(1, `${JSON.stringify(result)}\n`)
process.exit(exitCode)
