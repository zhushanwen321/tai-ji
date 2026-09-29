/**
 * BATCH S4 中途停止（E2E-BATCH-04）—— 派发后 workflow abort → run 终态 cancelled + 通知照达 + 无孤儿（成员任务子进程 + 引擎宿主薄壳）。
 *
 * 登记：E2E-BATCH-04（docs/testing/e2e-map.json，R2 按改动面 on-diff，serial 空载串行，
 * L3 真实 LLM）。
 *
 * 断言语义来源（两段叠加，以 W1 新介质为准）：
 * - 场景编排 = 原始场景 S4（e2e-map E2E-BATCH-04.note）：派发后 workflow abort →
 *   run 终态 aborted + 通知到达 + 无孤儿 pi 子进程（ps 核对为通过条件之一）。
 * - 持久介质断言 = W1 设计 .tmp/tech-design/w1-run-record-journal-authority.md §4.2 场景 1
 *   （介质归位）+ D1 终态条目契约：abort 终局同样按新介质落账——
 *   ① journal run-settled 恰 1 帧、outcome=cancelled（abort → cancelled，run-events
 *      DoneReason→RunOutcome 单点映射；「aborted」在 W1 事件词表命名为 cancelled）；
 *   ② notifyDone 送达恰 1 条（wf-done:<runId> 幂等键——abort 终局通知链不丢）；
 *   ③ workflow-record v2 settled 条目 outcome === journal outcome（journal 唯一事实源
 *      的终态投影面）；
 *   ④ 无孤儿：abort 收口后成员任务保活进程（sleep）无残留（R0/C1 孤儿进程修复的
 *      端到端验收面——abort 先杀 run 拓扑 spawned children 再收口），且引擎宿主
 *      （pi-subagent-cli 薄壳）一并退出（pi-workflow-run-resource-model per-window
 *      形态：薄壳随派发窗口生灭，run 收尾 finalizeRun 遍历窗口实例 dispose 杀薄壳）。
 *
 * 可复用登记声明：本 spec 是 E2E-BATCH-04 的可复用真机资产（后续触碰 abort/收口/
 * 引擎进程回收行为面时直接执行本文件，不再重建一次性剧本）。
 *
 * 执行侧约定（与 E2E-BATCH-01 同族）：
 * - 触发：scope diff 命中时开发期按改动面空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 +
 *   本机 provider 凭证（缺一 skip 不 fail）；CI/PR/merge 门禁不跑。
 *   前置：real renderer bundle（VITE_E2E=true pnpm run build:e2e，不带 VITE_MOCK）。
 * - 预算：test.setTimeout 420s。在飞保活旋钮 = 成员任务内 bash `sleep 180`
 *  （MEMBER_SLEEP_S——派发/abort 两 turn 的真实 LLM 耗时须落在保活窗内；若 abort 时
 *   run 已自然完成（收到 outcome=completed），属保活窗口不足 → 调大 MEMBER_SLEEP_S，
 *   禁止放宽断言）。
 * - 进程核对锚（双特征集，互不重叠）：
 *   ① 成员保活 = 命令行含 "sleep ${MEMBER_SLEEP_S}"（DISPATCH_PROMPT 指定的成员
 *     保活命令——本 run 派生出的成员任务子进程的直接特征）。
 *   ② 引擎宿主薄壳 = scripts/count-engine-shell-processes.mjs（特征串权威单源：
 *     'pi-subagent-cli' / '/engines/' 并集，从 spawn 实装读取；判定用「派发前基线 →
 *     收口后复测」差分，zcode 常驻单例与测试进程 cmdline 噪声被基线吸收——脚本头注
 *     口径）。真机首跑若特征不命中（pi bash 工具 spawn 形态变化），校准特征集而非
 *   删除断言。
 * - 失败归因：writeDiag 落 /tmp/batch-s4-*.json（journal 帧序 + 进程快照 + 日志尾）
 *   + console 抓取 + 全页截图 + <dataDir>/logs/。重试禁令：失败先归因。
 *
 * 形态说明：真实 Electron app 自启动（launchRealApp），WS 直连驱动两 turn
 * （派发 turn → abort turn）；断言 ground truth = journal 文件 + 主 session JSONL +
 * 进程表（磁盘与系统事实，不依赖 DOM）。
 */
import { test, expect, type Page } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
  readPiLogs,
  waitForExtensionsReady,
  type WsFrame,
} from './fixtures/launch-app-real'
import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

/** 在飞保活旋钮（执行侧约定「预算」）：成员 bash sleep 秒数，abort 须落在其内。 */
const MEMBER_SLEEP_S = 180
const MAIN_MARKER = 'BATCH-S4-MAIN-5320'

const DISPATCH_PROMPT =
  `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagents\` tool ` +
  `(do NOT do the tasks yourself). Both tasks are identical long-running tasks: ` +
  `"First run \\\`sleep ${MEMBER_SLEEP_S}\\\` using the bash tool, wait for it to finish, then reply with only the word MEMBER-DONE." ` +
  `After the tool call returns, reply with only the word DISPATCHED. [${MAIN_MARKER}]`

function abortPrompt(runId: string): string {
  return (
    `Stop the workflow run with runId "${runId}" NOW. Use the \`workflow\` tool with ` +
    `action "abort" and runId "${runId}" (reason: "e2e s4 abort test"). ` +
    `Do not use any other tool. After the tool returns, reply with only the word ABORTED.`
  )
}

// ── 预算 ────────────────────────────────────────────────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 300_000
const ABORT_SETTLE_TIMEOUT_MS = 120_000
const NOTIFY_TIMEOUT_MS = 120_000
/** ack 销账等待窗：ack 由回执扫描（agent_settled 边沿）驱动——通知唤醒 turn 结算
 *  后才落盘，送达后立即断言必为 0；窗口 = 一个真实 LLM turn（r3 实测教训）。 */
const ACK_TIMEOUT_MS = 180_000
const ORPHAN_GRACE_MS = 150_000
const JSONL_FLUSH_TIMEOUT_MS = 20_000

// ── 凭证门与播种（E2E-BTW-01 同款范式） ──────────────────────────────────

function sourceAgentDir(): string {
  const override = process.env['TAIJI_BATCH_CREDENTIAL_SOURCE']
  if (override && override.trim() !== '') return override
  return path.join(os.homedir(), '.taiji', 'agent')
}

function realCredentialSkipReason(): string | null {
  const src = sourceAgentDir()
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(src, 'auth.json'), 'utf8')) as Record<string, { key?: unknown }>
    if (Object.values(auth).some((c) => typeof c?.key === 'string' && c.key.trim() !== '')) return null
  } catch {
    console.warn(`[batch-s4] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-s4] models.json 不可读：${src}`)
  }
  return `${src} 的 auth.json / models.json 均无非空 key（本机 provider 凭证缺失）`
}

function seedRealCredentials(dataDir: string): void {
  const src = sourceAgentDir()
  const dst = path.join(dataDir, 'agent')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['models.json', 'auth.json']) {
    const p = path.join(src, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, f))
  }
  let source: Record<string, unknown> = {}
  try {
    source = JSON.parse(fs.readFileSync(path.join(src, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    console.warn(`[batch-s4] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-s4] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
}

// ── 诊断与扫描 helpers ──────────────────────────────────────────────────

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[batch-s4] diag → /tmp/${name}`)
}

async function waitUntil(pred: () => boolean, deadlineMs: number, intervalMs = 200): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return pred()
}

function listFilesRecursive(root: string, suffix: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 8 || !fs.existsSync(root)) return acc
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    if (fs.statSync(p).isDirectory()) listFilesRecursive(p, suffix, depth + 1, acc)
    else if (name.endsWith(suffix)) acc.push(p)
  }
  return acc
}

function parseJsonlLines(file: string): { entries: Record<string, unknown>[]; badLines: number } {
  const entries: Record<string, unknown>[] = []
  let badLines = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

function extractCustomEntries(file: string, customType: string): Record<string, unknown>[] {
  return parseJsonlLines(file).entries
    .filter((e) => e['type'] === 'custom' && e['customType'] === customType)
    .map((e) => (e['data'] ?? {}) as Record<string, unknown>)
}

/** 送达标签通道：type=custom_message（pi.sendMessage 落盘形态，进 LLM 上下文——
 *  权威消费面 notify-ledger-helpers.ts collectDeliveredNotifyIds：entry.type ===
 *  'custom_message' + entry.customType + 顶层 entry.details.notifyId）。与 plain
 *  custom entry（type=custom，data 平铺——ledger/ack/record 族）是两条落盘通道。 */
function extractCustomMessageEntries(file: string, customType: string): Record<string, unknown>[] {
  return parseJsonlLines(file).entries
    .filter((e) => e['type'] === 'custom_message' && e['customType'] === customType)
}

function readJournalFrames(file: string): Record<string, unknown>[] {
  return parseJsonlLines(file).entries
}

function attachConsoleCapture(page: Page): { all: string[]; errors: string[] } {
  const all: string[] = []
  const errors: string[] = []
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`
    all.push(line)
    if (msg.type() === 'error') errors.push(line)
  })
  page.on('pageerror', (err) => {
    const line = `[pageerror] ${String(err)}`
    all.push(line)
    errors.push(line)
  })
  return { all, errors }
}

/** 成员任务保活进程计数（孤儿核对锚 ①，见头注「进程核对锚」段）。
 *  只数成员保活 sleep 进程；引擎宿主薄壳走 countEngineShellProcesses（锚 ②）。 */
function countMemberSleeperProcesses(): { count: number; lines: string[] } {
  let out = ''
  try {
    out = execSync('ps -axo command=', { encoding: 'utf8', timeout: 10_000 })
  } catch (err) {
    console.warn(`[batch-s4] ps 不可读（进程核对降级为 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
  const marker = `sleep ${MEMBER_SLEEP_S}`
  const lines = out.split('\n').filter((line) =>
    line.includes(marker) && !line.includes('playwright') && !line.includes('Electron.app'),
  )
  return { count: lines.length, lines }
}

/** 引擎宿主薄壳计数（孤儿核对锚 ②：'pi-subagent-cli' / '/engines/' 特征并集）。
 *  复用 scripts/count-engine-shell-processes.mjs（特征串权威单源——从引擎 spawn
 *  实装读取，子进程取 JSON 输出）；宿主判定用基线差分（zcode 常驻单例与测试进程
 *  cmdline 噪声被基线吸收，脚本头注口径）。 */
function countEngineShellProcesses(): { count: number; lines: string[] } {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'count-engine-shell-processes.mjs')],
      { encoding: 'utf8', timeout: 10_000 },
    )
    const parsed = JSON.parse(out) as { count: number; processes: { pid: number; command: string }[] }
    return { count: parsed.count, lines: parsed.processes.map((p) => `${p.pid} ${p.command}`) }
  } catch (err) {
    console.warn(`[batch-s4] 引擎宿主计数不可读（降级 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
}

/**
 * [S4 test 拆分] 在飞证据段：journal 落盘 + ask-dispatched 帧 + 成员保活进程与引擎
 * 宿主薄壳的双正面对照（孤儿断言的前提是派发后确实有任务进程可回收）。失败路径
 * diag 与拆出前同构。
 */
async function awaitS4InFlightEvidence(
  dataDir: string,
  baseline: { count: number; lines: string[] },
  shellBaseline: { count: number; lines: string[] },
): Promise<{ journalFile: string; runId: string }> {
  const agentDir = path.join(dataDir, 'agent')
  const journalFound = await waitUntil(() => listFilesRecursive(agentDir, '.events.jsonl').length > 0, JOURNAL_TIMEOUT_MS)
  if (!journalFound) {
    writeDiag('batch-s4-journal-missing.json', {
      runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(journalFound, 'run journal 应落盘').toBe(true)
  const journalFile = listFilesRecursive(agentDir, '.events.jsonl')[0]
  const runId = path.basename(journalFile).replace(/\.events\.jsonl$/, '')
  const dispatched = await waitUntil(
    () => readJournalFrames(journalFile).some((f) => f['type'] === 'ask-dispatched'),
    JOURNAL_TIMEOUT_MS,
  )
  if (!dispatched) {
    writeDiag('batch-s4-not-dispatched.json', {
      journalEventTypes: readJournalFrames(journalFile).map((f) => f['type']),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(dispatched, `journal 应出现 ask-dispatched 帧（成员在飞——abort 才有「中途」语义）`).toBe(true)

  // 成员保活进程在跑（正面对照：孤儿断言的前提是派发后确实有任务进程可回收）
  const inFlight = await waitUntil(() => countMemberSleeperProcesses().count > baseline.count, JOURNAL_TIMEOUT_MS)
  if (!inFlight) {
    writeDiag('batch-s4-engine-process-not-seen.json', {
      baseline: baseline.lines,
      current: countMemberSleeperProcesses().lines,
      hint: '特征集不命中——按头注「进程核对锚」校准特征集，不删孤儿断言',
    })
  }
  expect(inFlight, `派发后成员保活进程数应 > 基线（在飞证据；特征锚见 diag）`).toBe(true)

  // 引擎宿主薄壳在跑（per-window 在飞证据：窗口内薄壳存活，是收口后可回收的前提）
  const shellInFlight = await waitUntil(() => countEngineShellProcesses().count > shellBaseline.count, JOURNAL_TIMEOUT_MS)
  if (!shellInFlight) {
    writeDiag('batch-s4-engine-shell-not-seen.json', {
      shellBaseline: shellBaseline.lines,
      shellCurrent: countEngineShellProcesses().lines,
      hint: '薄壳特征不命中（pi-subagent-cli / /engines/）——按 count-engine-shell-processes.mjs 头注校准特征集，不删宿主断言',
    })
  }
  expect(shellInFlight, `派发后引擎宿主薄壳数应 > 基线（per-window 在飞证据；特征锚见 diag）`).toBe(true)
  return { journalFile, runId }
}


/**
 * [S4 test 拆分] 断言 A1+A2 基座：run-settled(cancelled) 恰 1 + 主会话 JSONL 落盘
 * + notifyDone 送达等待。返回主会话文件路径（后续三通道计数与孤儿断言消费）。
 */
async function awaitS4SettlementAndNotifyBase(
  dataDir: string,
  agentDir: string,
  journalFile: string,
  runId: string,
  consoleCap: { errors: string[] },
): Promise<string> {
  // ── 断言 A1：journal run-settled(cancelled) 恰 1 ──
  const settled = await waitUntil(
    () => readJournalFrames(journalFile).some((f) => f['type'] === 'run-settled'),
    ABORT_SETTLE_TIMEOUT_MS,
  )
  const frames = readJournalFrames(journalFile)
  if (!settled) {
    writeDiag('batch-s4-not-settled.json', {
      journalEventTypes: frames.map((f) => f['type']),
      engineProcesses: countMemberSleeperProcesses().lines,
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(settled, `abort 后 run 应在 ${ABORT_SETTLE_TIMEOUT_MS}ms 内落 run-settled 帧`).toBe(true)
  const settledFrames = frames.filter((f) => f['type'] === 'run-settled')
  expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
  expect(
    settledFrames[0]?.['outcome'],
    `abort 终局 outcome 应为 cancelled（收到 "${String(settledFrames[0]?.['outcome'])}"；若为 completed = 保活窗口不足，调大 MEMBER_SLEEP_S）`,
  ).toBe('cancelled')

  // ── 断言 A2：notifyDone 照达恰 1 ──
  const sessionFound = await waitUntil(
    () => listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').some((f) => {
      try { return fs.readFileSync(f, 'utf8').includes(MAIN_MARKER) } catch { return false }
    }),
    JSONL_FLUSH_TIMEOUT_MS,
  )
  expect(sessionFound, '主会话 JSONL 应已落盘').toBe(true)
  const sessionFile = listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl')
    .find((f) => fs.readFileSync(f, 'utf8').includes(MAIN_MARKER))!
  const notifyId = `wf-done:${runId}`
  const notifyArrived = await waitUntil(() => fs.readFileSync(sessionFile, 'utf8').includes(notifyId), NOTIFY_TIMEOUT_MS)
  if (!notifyArrived) {
    writeDiag('batch-s4-notify-missing.json', {
      journalEventTypes: frames.map((f) => f['type']),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(notifyArrived, `abort 终局通知应照达（${notifyId}）——通知链不因 abort 丢失`).toBe(true)

  // ── 三通道口径（BATCH-06）：送达恰 1 + ledger/ack 各恰 1 ──
  // 通道与 entry type 均不同（与 s1 同款口径，详见 s1 注释）：①送达 = type
  // custom_message × customType "workflow-result"（u9 外部通道设计，键在顶层
  // details.notifyId；权威消费面 collectDeliveredNotifyIds）②ledger 落账 = type
  // custom × "subagent-bg-notify-ledger" ③ack 销账 = type custom ×
  // "subagent-bg-notify-ack"。「键出现次数」结构性 = 3 ≠ 投递次数。

  return sessionFile
}


/**
 * [S4 test 拆分] 断言 A3 + A4①：v2 settled 条目 outcome 与 journal 一致
 * （journal 唯一事实源投影面）+ 成员保活 sleep 进程回落基线（abort 的 kill 分级
 * 先杀 run 拓扑再收口；diag 带 etime/ppid 供残留时定位 kill 链路——countMember
 * SleeperProcesses 的 lines 是 `ps -axo command=` 纯命令行（无 PID 列），PID 需按
 * 同特征从 `ps -axo pid,command=` 重采样（r5 实测取 command 第二段当 PID 会 ps
 * 报错使 diag 自身炸掉））。
 */
async function assertS4SettledEntryAndOrphanFree(
  sessionFile: string,
  runId: string,
  baseline: { count: number; lines: string[] },
  frames: Record<string, unknown>[],
): Promise<void> {
  // ── 断言 A3：v2 settled 条目 outcome === journal（journal 唯一事实源投影面） ──
  const wfSettled = extractCustomEntries(sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
  const thisRunSettled = wfSettled.find((d) => d['runId'] === runId)
  expect(thisRunSettled, 'workflow-record v2 settled 条目应存在（abort run 也写终态条目）').toBeDefined()
  expect(thisRunSettled?.['outcome'], 'settled 条目 outcome 应为 cancelled（与 journal run-settled 一致）').toBe('cancelled')

  // ── 断言 A4：无孤儿（正面对照 = 派发后两者均曾 > 基线） ──
  // ① 成员保活 sleep 进程（run 拓扑 spawned children）：abort 的 kill 分级先杀
  //    run 拓扑再收口，杀干净后应立即回落基线。
  // ② 引擎宿主 pi-subagent-cli 薄壳：per-window 形态下随派发窗口生灭（run 收尾
  //    finalizeRun 遍历窗口实例 dispose），收口后同样回落基线（头注断言 ④ 升级面；
  //    计数复用 count-engine-shell-processes.mjs，基线差分吸收环境噪声）。
  // diag 带 etime/ppid 供残留时定位 kill 链路。
  const orphanFree = await waitUntil(() => countMemberSleeperProcesses().count <= baseline.count, ORPHAN_GRACE_MS, 1000)
  if (!orphanFree) {
    // countMemberSleeperProcesses 的 lines 是 `ps -axo command=` 纯命令行（无 PID 列）——
    // PID 需按同特征从 `ps -axo pid,command=` 重采样（r5 实测取 command 第二段当
    // PID 会 ps 报错使 diag 自身炸掉）
    let psDetail = '(无残留 PID)'
    try {
      const sleeperMarker = `sleep ${MEMBER_SLEEP_S}`
      const pidLines = execSync('ps -axo pid,command=', { encoding: 'utf8', timeout: 10_000 })
        .split('\n')
        .filter((line) => line.includes(sleeperMarker) && !line.includes('playwright'))
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
      if (pidLines.length > 0) {
        psDetail = execSync(`ps -o pid,ppid,etime,command -p ${pidLines.join(',')}`, { encoding: 'utf8', timeout: 10_000 })
      }
    } catch (err) {
      psDetail = `(ps 采样失败：${String(err)})`
    }
    writeDiag('batch-s4-orphans.json', {
      baseline: baseline.lines,
      current: countMemberSleeperProcesses().lines,
      psDetail,
      journalEventTypes: frames.map((f) => f['type']),
    })
  }
  expect(orphanFree, `abort 收口后成员保活进程数应回落基线（孤儿窗口 ${ORPHAN_GRACE_MS}ms；残留进程见 diag）`).toBe(true)
}
// ── S4 主用例 ────────────────────────────────────────────────────────────

test('S4 (batch real): 派发后 abort → run-settled(cancelled) + 通知照达 + 无孤儿（成员任务子进程 + 引擎宿主薄壳）', async ({ }, testInfo) => {
  test.setTimeout(420_000)

  // 凭证双门（缺一 skip 不 fail——防全量扫跑烧 token）
  test.skip(
    process.env['TAIJI_PI_LIVE'] !== '1',
    '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则——开发期按改动面手动触发，CI/门禁不跑）',
  )
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s4-'))
  seedRealCredentials(dataDir)

  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.warn('[batch-s4] extensions not ready within timeout, continue anyway')
    await page.screenshot({ path: testInfo.outputPath('s4-app-ready.png'), fullPage: true })

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's4-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-s4-abort-no-orphan' },
    }, 's4-create')
    expect(createReply.type).toBe('session.created')
    const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
    if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
    const sub = await openListenWs(port, sid)
    listen = sub

    // 进程基线（成员保活进程与引擎宿主薄壳 spawn 前；正常环境两者均应为 0）
    const baseline = countMemberSleeperProcesses()
    expect(baseline.count, '进程基线应可读（ps 失败 = -1 哨兵，环境异常 fail-fast）').toBeGreaterThanOrEqual(0)
    const shellBaseline = countEngineShellProcesses()
    expect(shellBaseline.count, '引擎宿主薄壳基线应可读（计数脚本失败 = -1 哨兵，环境异常 fail-fast）').toBeGreaterThanOrEqual(0)

    // ── turn 1：派发长任务批（成员 bash sleep 保活） ──
    const sendReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 's4-dispatch',
      payload: { sessionId: sid, content: DISPATCH_PROMPT },
    }, 's4-dispatch', 30_000)
    expect(sendReply.type, '派发 prompt 应被接受').not.toBe('error')
    const dispatchDone = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
    if (!dispatchDone) {
      writeDiag('batch-s4-dispatch-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        consoleErrors: consoleCap.errors,
      })
    }
    expect(dispatchDone, `派发 turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（真实 LLM 未调 subagents 工具？）`).toBe(true)
    sub.events.length = 0

    // ── 在飞证据（journal + ask-dispatched + 双进程正面对照；拆出 awaitS4InFlightEvidence）──
    const { journalFile, runId } = await awaitS4InFlightEvidence(dataDir, baseline, shellBaseline)
    await page.screenshot({ path: testInfo.outputPath('s4-in-flight.png'), fullPage: true })

    // ── turn 2：abort ──
    const abortReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 's4-abort',
      payload: { sessionId: sid, content: abortPrompt(runId) },
    }, 's4-abort', 30_000)
    expect(abortReply.type, 'abort prompt 应被接受').not.toBe('error')
    const abortTurnDone = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
    if (!abortTurnDone) {
      writeDiag('batch-s4-abort-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(abortTurnDone, `abort turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成`).toBe(true)

    const sessionFile = await awaitS4SettlementAndNotifyBase(dataDir, agentDir, journalFile, runId, consoleCap)
    const notifyId = `wf-done:${runId}`
    const deliveredWorkflowResults = extractCustomMessageEntries(sessionFile, 'workflow-result').filter(
      (e) => ((e['details'] ?? {}) as Record<string, unknown>)['notifyId'] === notifyId,
    )
    expect(
      deliveredWorkflowResults.length,
      'notifyDone 送达通道（custom_message × workflow-result）应恰 1 条（幂等键单次投递）',
    ).toBe(1)
    const countNotifyEntries = (customType: string): number =>
      extractCustomEntries(sessionFile, customType)
        .filter((d) => JSON.stringify(d).includes(notifyId)).length
    expect(
      countNotifyEntries('subagent-bg-notify-ledger'),
      'notifyDone ledger 落账应恰 1 条（at-least-once 幂等闭环——落账/销账各恰一次，BATCH-06 口径）',
    ).toBe(1)
    // ack 销账等回执扫描的 agent_settled 边沿（通知 triggerTurn 唤醒的 turn 结算后
    // 才写）——先等待再计数（r3 实测：送达后立即断言 Received 0）
    const ackArrived = await waitUntil(
      () => countNotifyEntries('subagent-bg-notify-ack') > 0,
      ACK_TIMEOUT_MS,
    )
    if (!ackArrived) {
      writeDiag('batch-s4-ack-missing.json', {
        sessionTail: fs.readFileSync(sessionFile, 'utf8').slice(-4000),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(ackArrived, `notifyDone ack 销账应在 turn 结算后落盘（agent_settled 边沿，${ACK_TIMEOUT_MS}ms 窗）`).toBe(true)
    expect(
      countNotifyEntries('subagent-bg-notify-ack'),
      'notifyDone ack 销账应恰 1 条（at-least-once 幂等闭环——落账/销账各恰一次，BATCH-06 口径）',
    ).toBe(1)

    await assertS4SettledEntryAndOrphanFree(sessionFile, runId, baseline, readJournalFrames(journalFile))

    // 断言 A4b：引擎宿主薄壳回落基线（per-window 收尾 dispose——abort 收尾杀薄壳，
    // 头注断言 ④ 升级面；同窗等待吸收成员任务收尾与薄壳退出的时序差）
    const shellOrphanFree = await waitUntil(() => countEngineShellProcesses().count <= shellBaseline.count, ORPHAN_GRACE_MS, 1000)
    if (!shellOrphanFree) {
      writeDiag('batch-s4-engine-shell-orphans.json', {
        shellBaseline: shellBaseline.lines,
        shellCurrent: countEngineShellProcesses().lines,
        journalEventTypes: frames.map((f) => f['type']),
      })
    }
    expect(shellOrphanFree, `abort 收口后引擎宿主薄壳应退出（计数回落基线，孤儿窗口 ${ORPHAN_GRACE_MS}ms；残留见 diag）`).toBe(true)

    await page.screenshot({ path: testInfo.outputPath('s4-aborted.png'), fullPage: true })
    if (consoleCap.errors.length > 0) {
      writeDiag('batch-s4-console-errors.json', { errors: consoleCap.errors.slice(-50) })
      console.warn(`[batch-s4] renderer console errors: ${consoleCap.errors.length} 条（diag 已落盘，非断言面）`)
    }
    console.log(`[batch-s4] PASS：runId=${runId} cancelled 收口、通知照达、零成员任务残留、引擎宿主薄壳已退出`)
  } finally {
    try {
      listen?.ws.close()
    } finally {
      await cleanup()
      if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }
  }
})
