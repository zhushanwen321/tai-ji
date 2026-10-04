/**
 * BATCH S1 批量基本链（E2E-BATCH-01）—— subagents 双任务并行 → 一条 notifyDone 收齐。
 *
 * 登记：E2E-BATCH-01（docs/testing/e2e-map.json，R2 按改动面 on-diff，serial 空载串行，
 * L3 真实 LLM）。本 spec 是 2026-09-22 丢失剧本的重建产物（W1 介质归位触发义务，
 * impl-plan「e2e 剧本重建」前置资产行）——落 git 跟踪路径、不落 .tmp（防丢失复发）；
 * e2e-map assets 产物行的回填归 U6 同 commit（本 spec 头部即回填依据）。
 *
 * 断言语义来源（两段叠加，以 W1 新介质为准）：
 * - 场景编排与通知口径 = 原始场景 S1（e2e-map E2E-BATCH-01.note 验收口径）：
 *   一条 notifyDone，status=ok 且 results.length=2、summary 计数正确、Agent Trace 2 条均 ok。
 * - 持久介质断言 = W1 设计 .tmp/tech-design/w1-run-record-journal-authority.md §4.2 场景 1
 *   （介质归位）：run/record 运行态落 journal 事件流 + 主 session 每实体两条 v2 小条目，
 *   条目不带 eventLog/displayItems 死字节——run 结束后按新介质锚定断言：
 *   ① journal `wf-<runId>.record.jsonl` 存在（首帧 run-created、恰一帧 run-settled、seq 严格递增）；
 *   ② 主 session JSONL workflow-record v2 条目 registered/settled 各恰 1，
 *     subagent-record v2 条目 registered/settled 各恰 2（两成员）；
 *   ③ v2 条目与 journal 的一致性锚（W1 D6「同实体冲突 journal 事件胜出」的终态投影面）：
 *     settled 条目 outcome === journal run-settled outcome；
 *   ④ W1 死字节断言：两族 v2 条目行不含 "eventLog" / "displayItems" 字符串。
 *
 * 可复用登记声明：本 spec 是 E2E-BATCH-01 的可复用真机资产（后续触碰批量 fan-out 行为面
 * 时直接执行本文件，不再重建一次性剧本）；场景 S2/S4/S7 家族见 BATCH-02/04/06 登记行。
 *
 * 执行侧约定（与 e2e-map note 同步维护，改其一须同 commit 改另一）：
 * - 触发：scope diff 命中（subagent-workflow shell / fan-out 模板 / core 执行链）时开发期
 *   按改动面空载串行执行；双凭证门 = env TAIJI_PI_LIVE=1 + 本机 provider 凭证（缺一 skip
 *   不 fail，防全量扫跑烧 token）；CI/PR/merge 门禁不跑本轨（AGENTS.md e2e 执行准则）。
 *   前置：real renderer bundle（VITE_E2E=true pnpm run build:e2e，不带 VITE_MOCK）。
 * - 预算：test.setTimeout 600s（真实 LLM 双成员并行 + 通知落盘）；journal/通知到达
 *   等待 300s（轮询，不固定 sleep）；窗口不足属预算校准，禁止放宽断言换绿灯。
 * - 失败归因：writeDiag 落 testInfo.outputPath（batch-s1-*.json，seen types + 日志尾 +
 *   目录清单——含 entry 正文的诊断载荷只进 Playwright 托管产物位，不落 /tmp，ADR-0063 I2）
 *   + console 抓取 + 全页截图（关键节点落 testInfo.outputPath）+ <dataDir>/logs/。
 * - 重试禁令：失败先读 diag 归因（通知缺席 → 查 journal 是否推进；LLM 未调工具 →
 *   查 prompt 遵从性），禁止不归因直接重试。
 *
 * 形态说明：真实 Electron app 自启动（launchRealApp，非连 dev 实例），WS 直连驱动
 * session.create → message.send（TEST-STRATEGY 约定：不可自动化处用 WS 触发等效业务动作）；
 * 断言 ground truth = 主 session JSONL + journal 文件（磁盘事实，不依赖 DOM）——A6/BTW-01 同款。
 * 凭证播种：拷本机真实 provider 配置进临时 dataDir（只读源目录，写面恒为临时 dataDir；
 * TAIJI_BATCH_CREDENTIAL_SOURCE 可覆盖源目录，缺省 ~/.taiji/agent）。
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
const SESSION_LABEL = 'batch-s1-basic-chain'

/** 任务哨兵（进成员 prompt；成员 summary 归 fan-out schema required 字段）。 */
const T1_TOKEN = 'BATCH-S1-T1-5301'
const T2_TOKEN = 'BATCH-S1-T2-5302'
const MAIN_MARKER = 'BATCH-S1-MAIN-5300'

const TASKS = [
  `Count the number of TypeScript (.ts) files under the src directory of this project. ` +
    `Reply with a one-line summary that ends with the exact token ${T1_TOKEN}. Do not write any files.`,
  `Read README.md in this project and summarize it in one sentence. ` +
    `Reply with a one-line summary that ends with the exact token ${T2_TOKEN}. Do not write any files.`,
]

const MAIN_PROMPT =
  `Dispatch exactly ${TASKS.length} background subagent tasks in ONE call using the \`subagents\` tool ` +
  `(do NOT do the tasks yourself, do NOT use any other tool). ` +
  `tasks = ${JSON.stringify(TASKS)} ` +
  `After the tool call returns, reply with only the word DISPATCHED. [${MAIN_MARKER}]`

// ── 预算（执行侧约定「预算」段；校准点改数值，禁改断言） ─────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 300_000
const NOTIFY_TIMEOUT_MS = 300_000
/** ack 销账等待窗：ack 由回执扫描（agent_settled 边沿）驱动——通知唤醒 turn 结算
 *  后才落盘，送达后立即断言必为 0；窗口 = 一个真实 LLM turn（r3 实测教训）。 */
const ACK_TIMEOUT_MS = 180_000
const JSONL_FLUSH_TIMEOUT_MS = 20_000

// ── 凭证门与播种（E2E-BTW-01 同款范式；只读源 = 本机真实数据目录） ─────────────

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
    console.warn(`[batch-s1] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-s1] models.json 不可读：${src}`)
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
    console.warn(`[batch-s1] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-s1] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
}

// ── 诊断与扫描 helpers（btw-turn-isolation 同款范式 + W1 介质族） ─────────────

/** 诊断落 Playwright 托管产物位（testInfo.outputPath，随 output 目录管理）——
 *  载荷可含 session entry 正文，/tmp 不是其合法落盘位置（ADR-0063 I2）。 */
function writeDiag(testInfo: TestInfo, name: string, data: Record<string, unknown>): void {
  const target = testInfo.outputPath(name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(data, null, 2))
  console.log(`[batch-s1] diag → ${target}`)
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

/** pi session JSONL 行解析（宽容：坏行跳过计数——与 W1 tail 契约的坏行语义一致）。 */
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

/** 主 session JSONL 内指定 customType 的 entry data 集（v2 条目/送达通知断言的取数面）。 */
function extractCustomEntries(file: string, customType: string): Record<string, unknown>[] {
  const { entries } = parseJsonlLines(file)
  return entries
    .filter((e) => e['type'] === 'custom' && e['customType'] === customType)
    .map((e) => (e['data'] ?? {}) as Record<string, unknown>)
}

/** 送达标签通道：type=custom_message（pi.sendMessage 落盘形态，进 LLM 上下文——
 *  notify-ledger-helpers.ts collectDeliveredNotifyIds 是该形态的权威消费面：
 *  entry.type==='custom_message' + entry.customType + 顶层 entry.details.notifyId。
 *  与 plain custom entry（type=custom，data 平铺——ledger/ack/record 族）是两条
 *  不同的落盘通道，customType 同名也不能混用 extractor。 */
function extractCustomMessageEntries(file: string, customType: string): Record<string, unknown>[] {
  const { entries } = parseJsonlLines(file)
  return entries.filter((e) => e['type'] === 'custom_message' && e['customType'] === customType)
}

/** run journal 帧解析：{ type, seq, ts, ...载荷 }。 */
function readJournalFrames(file: string): Record<string, unknown>[] {
  const { entries, badLines } = parseJsonlLines(file)
  if (badLines > 0) console.warn(`[batch-s1] journal 含 ${badLines} 坏行（宽容跳过，与 tail 契约一致）：${file}`)
  return entries
}

/** console 抓取（renderer 主窗口）：errors 单列，失败诊断必带。 */
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

/**
 * [S1 test 拆分] W1 介质锚 ①（journal 落盘）+ 主会话 JSONL 落盘 + notifyDone 送达等待。
 * 失败路径 diag 与拆出前同构（journal-missing / notify-missing 两形态）。
 */
async function settleS1Anchors(
  testInfo: TestInfo,
  dataDir: string,
  consoleCap: { errors: string[] },
): Promise<{ journalFile: string; runId: string; sessionFile: string }> {
  const agentDir = path.join(dataDir, 'agent')
  const journalFound = await waitUntil(() => listFilesRecursive(agentDir, '.record.jsonl').length > 0, JOURNAL_TIMEOUT_MS)
  if (!journalFound) {
    writeDiag(testInfo, 'batch-s1-journal-missing.json', {
      agentTree: fs.existsSync(agentDir) ? fs.readdirSync(agentDir) : [],
      runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
      consoleErrors: consoleCap.errors,
    })
  }
  expect(journalFound, `run journal (wf-*.record.jsonl) 应在 ${JOURNAL_TIMEOUT_MS}ms 内落盘于 <agentDir>/sessions/**/workflow-state/`).toBe(true)
  const journalFile = listFilesRecursive(agentDir, '.record.jsonl')[0]
  const runId = path.basename(journalFile).replace(/\.events\.jsonl$/, '')
  expect(runId.startsWith('wf-'), `journal 文件名应为 <runId>.record.jsonl 且 runId 带 wf- 前缀，收到 "${runId}"`).toBe(true)

  // ── 通知等待：notifyDone 送达 entry（customType=workflow-result，details.notifyId=wf-done:<runId>） ──
  const sessionFileFound = await waitUntil(
    () => listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').some((f) => {
      try { return fs.readFileSync(f, 'utf8').includes(MAIN_MARKER) } catch { return false }
    }),
    JSONL_FLUSH_TIMEOUT_MS,
  )
  expect(sessionFileFound, '主会话 JSONL 应已落盘（含 MAIN 哨兵）').toBe(true)
  const sessionFile = listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl')
    .find((f) => fs.readFileSync(f, 'utf8').includes(MAIN_MARKER))!

  const notifyId = `wf-done:${runId}`
  const notifyArrived = await waitUntil(
    () => fs.readFileSync(sessionFile, 'utf8').includes(notifyId),
    NOTIFY_TIMEOUT_MS,
  )
  const sessionText = fs.readFileSync(sessionFile, 'utf8')
  if (!notifyArrived) {
    const frames = readJournalFrames(journalFile).map((f) => f['type'])
    writeDiag(testInfo, 'batch-s1-notify-missing.json', {
      journalEventTypes: frames,
      sessionBytes: sessionText.length,
      runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
      consoleErrors: consoleCap.errors,
    })
  }
  expect(notifyArrived, `notifyDone（${notifyId}）应在 ${NOTIFY_TIMEOUT_MS}ms 内送达主会话 JSONL（journal 事件序见 diag）`).toBe(true)
  return { journalFile, runId, sessionFile }
}


/** [S1 test 拆分] 断言 N1（一条收齐，三通道口径）：送达恰 1 + ledger/ack 各恰 1。
 * W1 通知链在会话 JSONL 落三类含 wf-done:<runId> 的 entry，通道与 entry type 均不同：
 * ①送达 = type custom_message + customType "workflow-result"（u9 外部通道设计，
 *   workflow-notify.ts 以 deliveryCustomType=WORKFLOW_RESULT_CUSTOM_TYPE record；
 *   权威消费面 collectDeliveredNotifyIds 只认此形态，键在顶层 details.notifyId）
 * ②ledger 落账 = type custom + "subagent-bg-notify-ledger"（键在 data.notifyId）
 * ③ack 销账 = type custom + "subagent-bg-notify-ack"
 * 「notifyId 字面出现次数」结构性 = 3 ≠ 投递次数——送达恰 1（单次投递）
 * + ledger/ack 各恰 1（at-least-once 幂等闭环，BATCH-06 口径）。 */
async function assertS1NotifyChannels(
  testInfo: TestInfo,
  sessionFile: string,
  runId: string,
  journalFile: string,
  dataDir: string,
): Promise<void> {
const notifyId = `wf-done:${runId}`
// ── 断言 N1（一条收齐，三通道口径）：送达恰 1 + ledger/ack 各恰 1 ──
// W1 通知链在会话 JSONL 落三类含 wf-done:<runId> 的 entry，通道与 entry type 均不同：
// ①送达 = type custom_message + customType "workflow-result"（u9 外部通道设计，
//   workflow-notify.ts 以 deliveryCustomType=WORKFLOW_RESULT_CUSTOM_TYPE record；
//   权威消费面 collectDeliveredNotifyIds 只认此形态，键在顶层 details.notifyId）
// ②ledger 落账 = type custom + "subagent-bg-notify-ledger"（键在 data.notifyId）
// ③ack 销账 = type custom + "subagent-bg-notify-ack"
// 「notifyId 字面出现次数」结构性 = 3 ≠ 投递次数——送达恰 1（单次投递）
// + ledger/ack 各恰 1（at-least-once 幂等闭环，BATCH-06 口径）。
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
  writeDiag(testInfo, 'batch-s1-ack-missing.json', {
    sessionTail: fs.readFileSync(sessionFile, 'utf8').slice(-4000),
    runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
    journalEventTypes: readJournalFrames(journalFile).map((f) => f['type']),
  })
}
expect(ackArrived, `notifyDone ack 销账应在 turn 结算后落盘（agent_settled 边沿，${ACK_TIMEOUT_MS}ms 窗）`).toBe(true)
expect(
  countNotifyEntries('subagent-bg-notify-ack'),
  'notifyDone ack 销账应恰 1 条（at-least-once 幂等闭环——落账/销账各恰一次，BATCH-06 口径）',
).toBe(1)

}

/** [S1 test 拆分] 断言 N2（S1 原始口径）：status=ok / results=2 / taskIndex 0,1 / Agent Trace 2 条均 ok。 */
function assertS1DeliveryContent(testInfo: TestInfo, sessionFile: string): void {
// ── 断言 N2（S1 原始口径）：status=ok / results=2 / taskIndex 0,1 / Agent Trace 2 条均 ok ──
const deliveries = extractCustomMessageEntries(sessionFile, 'workflow-result')
expect(deliveries.length, 'workflow-result 送达 entry 应恰 1 条').toBe(1)
const content = String(deliveries[0]['content'] ?? '')
// Script Result 段（fan-out 返回 {status, results:[...]}）从通知 content 提取
const scriptResultMatch = content.match(/--- Script Result ---\n([\s\S]*?)(\n\n--- Agent Trace ---|$)/)
expect(scriptResultMatch, '通知 content 应含 Script Result 段（fan-out 返回值）').not.toBeNull()
let scriptResult: { status?: string; results?: { taskIndex?: number; status?: string; error?: string }[] } = {}
try {
  scriptResult = JSON.parse((scriptResultMatch![1] || '').trim()) as typeof scriptResult
} catch {
  writeDiag(testInfo, 'batch-s1-script-result-unparsable.json', { contentHead: content.slice(0, 2000) })
  throw new Error('Script Result 段应为合法 JSON（fan-out 返回 {status, results}）')
}
expect(scriptResult.status, `批收口 status 应为 ok（收到 "${String(scriptResult.status)}"）`).toBe('ok')
expect(scriptResult.results?.length, 'results 应恰 2 条（双任务并行收齐）').toBe(2)
const taskIndexes = (scriptResult.results ?? []).map((r) => r.taskIndex).sort()
expect(taskIndexes, 'results[].taskIndex 应为 [0,1]（派发序归因）').toEqual([0, 1])
for (const r of scriptResult.results ?? []) {
  expect(r.status, `成员 taskIndex=${String(r.taskIndex)} 应 ok（partial/failed 见 error 字段）`).toBe('ok')
}
// Agent Trace 段：每成员一行 `[stepIndex] agent: status`（workflow-notify.ts
// buildDoneNotifyContent，节点成功态词 = completed——r5 diag 实锤）。段提取必须
// 在 Artifacts 段前截断（`[\s\S]*$` 贪婪会把 Artifacts 3 行吞进 trace——r4/r5
// 「5 行」的真相）；原始口径「2 条均 ok」语义化 = stepIndex 0/1 各有一行成功轨迹。
const traceMatch = content.match(/--- Agent Trace ---\n([\s\S]*?)(?:\n--- Artifacts ---|$)/)
expect(traceMatch, '通知 content 应含 Agent Trace 段').not.toBeNull()
const traceLines = (traceMatch![1] || '').trim().split('\n').filter((l) => l.trim() !== '')
const okSteps = new Set(
  traceLines
    .filter((l) => /: completed$/.test(l.trim()))
    .map((l) => (l.trim().match(/^\[(\d+)\]/) ?? [])[1]),
)
if (!(okSteps.has('0') && okSteps.has('1'))) {
  writeDiag(testInfo, 'batch-s1-trace-anomaly.json', { traceLines, contentHead: content.slice(0, 3000) })
}
expect(
  okSteps.has('0') && okSteps.has('1'),
  `Agent Trace 应覆盖双成员且均 completed（trace ${traceLines.length} 行，逐行见 diag）`,
).toBe(true)

}

/** [S1 test 拆分] 断言 M1（journal 帧序）+ M2（v2 条目两条/实体）+ M4（死字节）+ record 事件文件。 */
function assertS1JournalAndEntryContract(
  sessionFile: string,
  journalFile: string,
  runId: string,
  dataDir: string,
): void {
  const agentDir = path.join(dataDir, 'agent')
// ── 断言 M1（journal）：首帧 run-created / run-settled 恰 1 且 completed / seq 严格递增 ──
const frames = readJournalFrames(journalFile)
expect(frames.length, 'journal 应至少有 run-created 与 run-settled 两帧').toBeGreaterThanOrEqual(2)
expect(frames[0]?.['type'], 'journal 首帧应为 run-created（journal 首帧行为）').toBe('run-created')
const settledFrames = frames.filter((f) => f['type'] === 'run-settled')
expect(settledFrames.length, 'run-settled 应恰 1 帧（一个 run 恰好一帧）').toBe(1)
expect(settledFrames[0]?.['outcome'], 'run-settled outcome 应为 completed').toBe('completed')
const seqs = frames.map((f) => Number(f['seq']))
const strictlyIncreasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1])
expect(strictlyIncreasing, 'journal seq 应严格递增（行级单调序号，W1 D1 信封契约）').toBe(true)

// ── 断言 M2（v2 条目两条/实体）+ M4（死字节）+ M5（journal 胜出一致性锚） ──
const wfRegistered = extractCustomEntries(sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
const wfSettled = extractCustomEntries(sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
expect(wfRegistered.length, 'workflow-record v2 registered 条目应恰 1 条（每 run 注册一条）').toBe(1)
expect(wfSettled.length, 'workflow-record v2 settled 条目应恰 1 条（每 run 终态一条）').toBe(1)
expect(wfRegistered[0]['runId'], 'registered 条目 runId 应与 journal 文件名一致').toBe(runId)
expect(wfSettled[0]['outcome'], 'settled 条目 outcome 应与 journal run-settled outcome 一致（journal 唯一事实源的终态投影面）')
  .toBe(settledFrames[0]['outcome'])

const saRegistered = extractCustomEntries(sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
const saSettled = extractCustomEntries(sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
expect(saRegistered.length, 'subagent-record v2 registered 条目应恰 2 条（每成员一条）').toBe(2)
expect(saSettled.length, 'subagent-record v2 settled 条目应恰 2 条（每成员一条）').toBe(2)

// W1 死字节（场景 1 grep 断言）：两族条目行不含 v1 时代的全量快照字段
const recordEntryLines = parseJsonlLines(sessionFile).entries
  .filter((e) => e['type'] === 'custom' && (e['customType'] === 'workflow-record' || e['customType'] === 'subagent-record'))
expect(recordEntryLines.length, '两族 record entry 总行数应为 6（run 2 + 成员 4）').toBe(6)
for (const line of recordEntryLines) {
  const serialized = JSON.stringify(line)
  expect(serialized.includes('eventLog'), 'v2 条目不应含 eventLog 死字节（W1 停写断言）').toBe(false)
  expect(serialized.includes('displayItems'), 'v2 条目不应含 displayItems 死字节（W1 停写断言）').toBe(false)
}

// record 事件文件存在性（record 侧新介质）：每成员 <sa-id>.events
const recordEvents = listFilesRecursive(path.join(agentDir, 'subagents'), '.events')
expect(recordEvents.length, 'record 事件文件族应恰 2 个（<recordsDir>/<sa-id>.events，每成员一个）').toBe(2)

}

// ── S1 主用例 ────────────────────────────────────────────────────────────

test('S1 (batch real): subagents 双任务并行 → 一条 notifyDone 收齐 + W1 新介质锚定', async ({ }, testInfo) => {
  test.setTimeout(600_000)

  // 凭证双门（缺一 skip 不 fail——防全量扫跑烧 token）
  test.skip(
    process.env['TAIJI_PI_LIVE'] !== '1',
    '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则——开发期按改动面手动触发，CI/门禁不跑）',
  )
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s1-'))
  seedRealCredentials(dataDir)

  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.warn('[batch-s1] extensions not ready within timeout, continue anyway')
    await page.screenshot({ path: testInfo.outputPath('s1-app-ready.png'), fullPage: true })

    // session 创建 + 订阅（broadcast 早于订阅丢消息的时序竞争防护，先订阅再发 prompt）
    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's1-create',
      payload: { cwd: SAMPLE_PROJECT, label: SESSION_LABEL },
    }, 's1-create')
    expect(createReply.type).toBe('session.created')
    const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
    if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
    const sub = await openListenWs(port, sid)
    listen = sub

    const sendReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 's1-main-send',
      payload: { sessionId: sid, content: MAIN_PROMPT },
    }, 's1-main-send', 30_000)
    expect(sendReply.type, '主 prompt message.send 应被接受').not.toBe('error')

    // 主 turn（LLM 调 subagents 工具后即收口——批量是后台通知型工具）
    const mainDone = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
    if (!mainDone) {
      writeDiag(testInfo, 'batch-s1-main-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        consoleErrors: consoleCap.errors,
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(mainDone, `主 turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内 message.complete（真实 LLM 未调 subagents 工具？查 diag）`).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('s1-dispatched.png'), fullPage: true })

    // ── W1 介质锚 ① + 通知等待（拆出 settleS1Anchors）──
    const { journalFile, runId, sessionFile } = await settleS1Anchors(testInfo, dataDir, consoleCap)
    await page.screenshot({ path: testInfo.outputPath('s1-notify-arrived.png'), fullPage: true })

    await assertS1NotifyChannels(testInfo, sessionFile, runId, journalFile, dataDir)
    assertS1DeliveryContent(testInfo, sessionFile)
    assertS1JournalAndEntryContract(sessionFile, journalFile, runId, dataDir)

    if (consoleCap.errors.length > 0) {
      writeDiag(testInfo, 'batch-s1-console-errors.json', { errors: consoleCap.errors.slice(-50) })
      console.warn(`[batch-s1] renderer console errors: ${consoleCap.errors.length} 条（diag 已落盘，非断言面）`)
    }
    console.log(`[batch-s1] PASS：runId=${runId}，journal=${journalFile}`)
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
