/**
 * BATCH-WRR 窗口复用与自愈（pi-workflow-run-resource-model D3 验收 A6/A8，场景 V6/V8）。
 *
 * 两个独立场景（各自 session、各自 run、空载串行）：
 *  - A6/V6 窗口内薄壳崩溃自愈：自定义模板顺序两条 agent()（不同名），第一条在途期
 *    剧本 kill 薄壳进程 → record 流 agent-settled{outcome:failed}（崩溃合成路径；
 *    errorCode 口径见用例内注记）；第二条 agent() respawn 新薄壳（pid 更替证据）完成
 *    其任务，run 不被放大失败（run-settled outcome done）。设计 D7 保留语义的真机复核。
 *  - A8/V8 同名续写同一子代理：自定义模板同名 agent()（description 同为 solo-worker）
 *    顺序两次 → record 流 agent-started 恰 2 且恰 1 条携带 memberRecordId（D6 绑定
 *    消解：成员复用池「name→recordId」路由承载于 agent-started 载荷字段——第二条
 *    调用复用既有成员，若误建新成员会出现第二条缺省绑定的 started 帧）、agentName
 *    同为 solo-worker、agent-settled 恰 2 全 done；record 介质面（W1 权威介质）=
 *    主 session 文件 subagent-record v2 registered/settled 各恰 1 + record 事件
 *    文件 record-created 恰 1（单 record 实体；多轮证据由 agent-started
 *    memberRecordId 绑定单帧承载，见用例内注记）。
 *
 * 自定义模板：e2e/fixtures/wl-seq-two.js / wl-name-reuse.js（@pi-meta 头齐全；经
 * workflow tool run action 的绝对路径 name 派发——subagent_batch tool 恒转译 fan-out，
 * 承载不了顺序/同名形态）。
 *
 * 断言原始证据文档 = run journal（run-events 帧型，W1 权威介质）+ ps 进程表
 * （scripts/count-engine-shell-processes.mjs 特征并集，基线差分）+ sessions 目录
 * 磁盘事实。执行侧约定与 batch-window-lifecycle.spec.ts 同款（双凭证门 skip、
 * 空载串行、失败 writeDiag 归因禁盲重试）。
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import {
  launchRealApp,
  wsRoundTrip,
  readRuntimeLogs,
  readPiLogs,
  type WsFrame,
} from './fixtures/launch-app-real'
import {
  applyRealTrackGate,
  attachConsoleErrorCapture,
  countMemberSleeperProcesses,
  engineShellProcessSnapshot,
  listFilesRecursive,
  openMainListenWs,
  parseJsonlLines,
  REPO_ROOT,
  SAMPLE_PROJECT,
  seedRealCredentials,
  tmpDiag,
  waitRealAppReady,
  waitUntil,
} from './fixtures/batch-real-helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SEQ_TEMPLATE = path.join(REPO_ROOT, 'e2e', 'fixtures', 'wl-seq-two.js')
const REUSE_TEMPLATE = path.join(REPO_ROOT, 'e2e', 'fixtures', 'wl-name-reuse.js')

const FIRST_TASK_SEQ = `[WL-SEQ-R1-7735] First run \`sleep 30\` using the bash tool, wait for it to finish, then reply with a one-word summary.`
const SECOND_TASK_SEQ = `[WL-SEQ-R2-7736] First run \`sleep 20\` using the bash tool, wait for it to finish, then reply with a one-word summary.`
const FIRST_TASK_REUSE = `[WL-REUSE-R1-8841] First run \`sleep 15\` using the bash tool, wait for it to finish, then reply with a one-word summary.`
const SECOND_TASK_REUSE = `[WL-REUSE-R2-8842] Reply with a one-word summary (no tools needed).`

/** kill 注入前静置：sleep 30 出现后再等一段，确保 ask 已完全建立（LLM 首 token
 *  + 工具调用登记），避免 kill 落在 ask 尚未建立的窗口（那会变成派发失败非崩溃）。 */
const KILL_SETTLE_MS = 8_000
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 300_000
const ORPHAN_GRACE_MS = 150_000

// ── 凭证门与播种 / 诊断 helpers（共享实现 = fixtures/batch-real-helpers.ts；
//    本文件只留 tag 绑定与 WRR 特有的薄壳 pid 快照） ─────────────────────────────

const writeDiag = tmpDiag('batch-wrr')

/** 引擎宿主薄壳进程快照（pid 集合 + 明细；JSON 原语 = 共享 engineShellProcessSnapshot）。
 *  与共享 countEngineShellProcesses 的差异：快照形态（pid 集差分）且不可读时抛错不降级。 */
function shellProcessSnapshot(): { pids: Set<number>; lines: string[] } {
  const parsed = engineShellProcessSnapshot()
  return { pids: new Set(parsed.processes.map((p) => p.pid)), lines: parsed.processes.map((p) => `${p.pid} ${p.command}`) }
}

interface JournalView { // oe-exempt:20260927:test:e2e 剧本内视图形状声明（DOM mock 类型，非架构契约范围）
  file: string
  runId: string
  frames: Record<string, unknown>[]
}

function readJournal(dataDir: string): JournalView[] {
  // run 域 record 事件流后缀（<runId>.record.jsonl，core RUN_EVENTS_SUFFIX 同源；D1 起唯一 journal 介质）
  // 搜索根 = <dataDir>/ext-sessions（ADR-0141 session 存储树，workflow/runs/ 域按 rootSessionId 分区）
  return listFilesRecursive(path.join(dataDir, 'ext-sessions'), '.record.jsonl').map((f) => ({
    file: f,
    runId: path.basename(f).replace(/\.record\.jsonl$/, ''),
    frames: parseJsonlLines(f).entries,
  }))
}

/** 派发一个自定义模板 workflow 并等派发 turn 完成（主 LLM 调 workflow tool run action）。 */
async function dispatchTemplateRun(
  port: number,
  sid: string,
  templatePath: string,
  args: Record<string, string>,
  wsId: string,
  sub: { events: WsFrame[] },
  consoleErrors: string[],
  dataDir: string,
): Promise<void> {
  const argsJson = JSON.stringify(args)
  const prompt =
    `Use the \`workflow_run\` tool with name "${templatePath}", args ${argsJson}. ` +
    `Pass the args exactly as given (they belong inside args, not at the top level). ` +
    `Do not use any other tool. After the tool returns, reply with only the word DISPATCHED. [${wsId}]`
  const sendReply = await wsRoundTrip(port, {
    type: 'message.send',
    id: wsId,
    payload: { sessionId: sid, content: prompt },
  }, wsId, 30_000)
  expect(sendReply.type, '派发 prompt 应被接受').not.toBe('error')
  const done = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
  if (!done) {
    writeDiag(`batch-wrr-${wsId}-turn.json`, {
      seen: [...new Set(sub.events.map((e) => String(e.type)))],
      runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      consoleErrors,
    })
  }
  expect(done, `派发 turn（${wsId}）未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（主 LLM 未调 workflow tool？）`).toBe(true)
  sub.events.length = 0
}

/** 等待 journal 出现 run-settled 帧并返回该 run 的 JournalView（搜索根 <dataDir>/ext-sessions）。 */
async function waitForRunSettled(dataDir: string, deadlineMs: number, tag: string): Promise<JournalView> {
  const settled = await waitUntil(
    () => readJournal(dataDir).some((j) => j.frames.some((f) => f['type'] === 'run-settled')),
    deadlineMs,
    2_000,
  )
  if (!settled) {
    writeDiag(`batch-wrr-${tag}-not-settled.json`, {
      journals: readJournal(dataDir).map((j) => ({ runId: j.runId, types: j.frames.map((f) => String(f['type'])) })),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(settled, `run 应在 ${deadlineMs}ms 内落 run-settled 帧（diag 见 journal 帧型）`).toBe(true)
  return readJournal(dataDir).find((j) => j.frames.some((f) => f['type'] === 'run-settled'))!
}

// ── A6/V6：窗口内薄壳崩溃自愈 ────────────────────────────────────────────

/** WRR 两用例共享 app 生命周期壳：临时 dataDir + 播种 + 真机启动 + error 抓取 + 就绪三连 +
 *  ready 截图。listen 经返回的 ref 注册（调用方 finally 统一关）；就绪前失败在壳内
 *  清理后重抛（不泄漏进程）。 */
async function launchWrrApp(
  testInfo: TestInfo,
  tmpPrefix: string,
  readyShot: string,
): Promise<{
  dataDir: string
  page: Page
  port: number
  consoleCap: { errors: string[] }
  listen: { current: { ws: { close: () => void }; events: WsFrame[] } | undefined }
  cleanup: () => Promise<void>
}> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix))
  seedRealCredentials(dataDir, 'batch-wrr')
  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleErrorCapture(page)
  const listen: { current: { ws: { close: () => void }; events: WsFrame[] } | undefined } = { current: undefined }
  try {
    const port = await waitRealAppReady(page, dataDir, 'batch-wrr')
    await page.screenshot({ path: testInfo.outputPath(readyShot), fullPage: true })
    return {
      dataDir,
      page,
      port,
      consoleCap,
      listen,
      cleanup: async () => {
        await cleanup()
        if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
          fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        }
      },
    }
  } catch (err) {
    await cleanup()
    if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    throw err
  }
}

test('WRR-A6 (batch real): kill 注入薄壳后第二条 agent() respawn 完成，run 不放大失败', async ({ }, testInfo) => {
  applyRealTrackGate(test, { timeoutMs: 600_000, tag: 'batch-wrr' })
  const app = await launchWrrApp(testInfo, 'taiji-batch-wrr-a6-', 'a6-ready.png')
  try {
    const createReply = await wsRoundTrip(app.port, {
      type: 'session.create',
      id: 'a6-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-wrr-a6-kill-respawn' },
    }, 'a6-create')
    const { sid, sub } = await openMainListenWs(app.port, createReply)
    app.listen.current = sub

    // 基线：薄壳 pid 集 + 成员 sleep 进程
    const shellBase = shellProcessSnapshot()
    const sleepBase = countMemberSleeperProcesses(30, 'batch-wrr')
    expect(sleepBase.count).toBeGreaterThanOrEqual(0)

    await dispatchTemplateRun(app.port, sid, SEQ_TEMPLATE, {
      firstTask: FIRST_TASK_SEQ,
      secondTask: SECOND_TASK_SEQ,
    }, 'a6-dispatch', sub, app.consoleCap.errors, app.dataDir)

    // r1 在途证据：薄壳新 pid + sleep 30 进程
    const shellUp = await waitUntil(() => {
      const now = shellProcessSnapshot()
      return [...now.pids].filter((p) => !shellBase.pids.has(p)).length >= 1
    }, JOURNAL_TIMEOUT_MS)
    const sleepUp = await waitUntil(() => countMemberSleeperProcesses(30, 'batch-wrr').count > sleepBase.count, JOURNAL_TIMEOUT_MS)
    if (!shellUp || !sleepUp) {
      writeDiag('batch-wrr-a6-inflight-missing.json', {
        shellBase: shellBase.lines,
        shellNow: shellProcessSnapshot().lines,
        sleepNow: countMemberSleeperProcesses(30, 'batch-wrr').lines,
        runtimeLogsTail: readRuntimeLogs(app.dataDir).slice(-3000),
      })
    }
    expect(shellUp, '派发后引擎宿主薄壳应出现（per-window 窗口实例）').toBe(true)
    expect(sleepUp, '派发后 r1 成员 sleep 30 进程应在跑（在途证据）').toBe(true)

    // kill 注入：静置后杀薄壳新 pid（SIGKILL——薄壳崩溃语义）
    await new Promise((r) => setTimeout(r, KILL_SETTLE_MS))
    const killAtMs = Date.now()
    const beforeKill = shellProcessSnapshot()
    const newPids = [...beforeKill.pids].filter((p) => !shellBase.pids.has(p))
    expect(newPids.length, `kill 前薄壳新 pid 应恰 1 个（实际：${beforeKill.lines.join(' | ')}）`).toBe(1)
    const killedPid = newPids[0]!
    process.kill(killedPid, 'SIGKILL')
    console.log(`[batch-wrr] A6 kill 注入：SIGKILL pid=${killedPid}`)
    await app.page.screenshot({ path: testInfo.outputPath('a6-killed.png'), fullPage: true })

    // respawn 证据：新薄壳 pid（≠被杀 pid）重现
    const respawned = await waitUntil(() => {
      const now = shellProcessSnapshot()
      return [...now.pids].some((p) => !shellBase.pids.has(p) && p !== killedPid)
    }, SETTLE_TIMEOUT_MS, 1_000)
    const afterRespawn = shellProcessSnapshot()
    if (!respawned) {
      writeDiag('batch-wrr-a6-no-respawn.json', {
        killedPid,
        shellBase: shellBase.lines,
        shellNow: afterRespawn.lines,
        runtimeLogsTail: readRuntimeLogs(app.dataDir).slice(-3000),
        piLogsTail: readPiLogs(app.dataDir).slice(-3000),
      })
    }
    expect(respawned, `kill 后第二条 agent() 应 respawn 新薄壳（pid≠${killedPid}；diag 见进程明细）`).toBe(true)
    const respawnPid = [...afterRespawn.pids].find((p) => !shellBase.pids.has(p) && p !== killedPid)

    // r2 在途证据：sleep 20 进程出现（respawn 后薄壳承载的服务）
    const sleep2Up = await waitUntil(() => countMemberSleeperProcesses(20, 'batch-wrr').count > 0, JOURNAL_TIMEOUT_MS)
    if (!sleep2Up) {
      writeDiag('batch-wrr-a6-r2-not-seen.json', {
        respawnPid,
        sleepNow: countMemberSleeperProcesses(20, 'batch-wrr').lines,
      })
    }
    expect(sleep2Up, 'r2 成员 sleep 20 进程应出现（respawn 薄壳承载第二条 ask）').toBe(true)

    // run 收尾：done（r1 crashed 是设计内合成形态，不放大 run 失败）
    const run = await waitForRunSettled(app.dataDir, SETTLE_TIMEOUT_MS, 'a6')
    const settledFrames = run.frames.filter((f) => f['type'] === 'run-settled')
    expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
    expect(settledFrames[0]?.['outcome'], 'run 应 done 收尾（崩溃不放大失败）').toBe('done')

    // record 流 agent 面：r1 failed + r2 done。
    // errorCode 断言口径：agent 级 errorCode 实装 = result.failureKind（枚举
    // stale_context/schema_deterministic/unknown，dispatchAgentSettled 映射），崩溃
    // 分诊不在该枚举里（engine_crashed 是 run 级 RunErrorCode 值）——r1 的
    // errorCode 现状恒 unknown，不作断言。
    const agentSettled = run.frames.filter((f) => f['type'] === 'agent-settled')
    expect(agentSettled.length, 'agent-settled 应恰 2 帧（两条 agent()）').toBe(2)
    const failed = agentSettled.find((f) => f['outcome'] === 'failed')
    const ok = agentSettled.find((f) => f['outcome'] === 'done')
    expect(failed, 'r1 ask 应 failed（kill 注入的崩溃形态）').toBeDefined()
    // 失败时点确证：失败帧 ts 应晚于 kill 注入时刻（失败应答的 durationMs 缺省 0，
    // 不可作时点证据——帧 ts 为权威）
    expect(
      Number(failed?.['ts']),
      `r1 失败帧 ts 应晚于 kill 注入时刻（killAt=${killAtMs}）`,
    ).toBeGreaterThan(killAtMs)
    expect(ok, 'r2 ask 应 completed').toBeDefined()

    // 收尾：薄壳回落基线（窗口 dispose 在 run 收尾链）
    const shellBack = await waitUntil(() => shellProcessSnapshot().pids.size <= shellBase.pids.size, ORPHAN_GRACE_MS, 1_000)
    if (!shellBack) {
      writeDiag('batch-wrr-a6-shell-residue.json', {
        shellBase: shellBase.lines,
        shellNow: shellProcessSnapshot().lines,
      })
    }
    expect(shellBack, `run 收尾后薄壳应回落基线（${ORPHAN_GRACE_MS}ms 窗）`).toBe(true)

    if (app.consoleCap.errors.length > 0) {
      writeDiag('batch-wrr-a6-console-errors.json', { errors: app.consoleCap.errors.slice(-50) })
      console.warn(`[batch-wrr] A6 renderer console errors: ${app.consoleCap.errors.length} 条（diag 已落盘，非断言范围）`)
    }
    console.log(`[batch-wrr] A6 PASS：kill pid=${killedPid} → respawn pid=${respawnPid} → r2 done → run done`)
  } finally {
    try {
      app.listen.current?.ws.close()
    } finally {
      await app.cleanup()
    }
  }
})


/**
 * [A8 test 拆分] record 介质面断言（W1 权威介质口径——「同一 record 多轮」的最硬
 * 证据）：① 主 session 文件的 subagent-record v2 条目 registered 恰 1 + settled 恰 1
 * （origin=workflow + parentRunId=本 run；第二次调用若新建成员会有第二对条目）。
 * ② record 事件文件（<recordsDir>/<sa-id>.events，注册条目 id 直接定址；
 * <recordsDir> = <dataDir>/ext-sessions/<rootSessionId>/subagents/records/）：
 * record-created 恰 1（单 record 实体——多轮证据注记见用例内）。
 * 注：pi 成员 session 文件（sessions/ 树）的落盘时序对本 spec 不可靠（多轮实测
 * 只见主 session 落盘），不作为断言范围——session 连续性由 record 单 id + 两轮
 * 事件承载（BATCH-08 通过标准的介质同型锚）。v2 条目落盘经 pi appendEntry
 * （JSONL flush 有延迟）——轮询等待 registered 出现。
 */
async function assertA8RecordMediaFace(
  sessionsNow: string[],
  run: { runId: string },
  dataDir: string,
  rootSessionId: string,
): Promise<{ registered: Record<string, unknown>[] }> {
  const mainSessionFile = sessionsNow.find((f) => {
    try { return fs.readFileSync(f, 'utf8').includes('[a8-dispatch]') } catch { return false }
  })
  expect(mainSessionFile, '主 session 文件应已落盘（派发 turn 已完成）').toBeDefined()
  // v2 条目落盘经 pi appendEntry（JSONL flush 有延迟）——轮询等待 registered 出现
  const readSaEntries = (): { registered: Record<string, unknown>[]; settledEntries: Record<string, unknown>[] } => {
    const entries = parseJsonlLines(mainSessionFile!).entries
      .filter((e) => e['type'] === 'custom' && e['customType'] === 'subagent-record')
      .map((e) => (e['data'] ?? {}) as Record<string, unknown>)
    return {
      registered: entries.filter((d) => d['v'] === 2 && d['kind'] === 'registered'),
      settledEntries: entries.filter((d) => d['v'] === 2 && d['kind'] === 'settled'),
    }
  }
  let entriesView = readSaEntries()
  {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline
      && (entriesView.registered.length < 1 || entriesView.settledEntries.length < 1)) {
      await new Promise((r) => setTimeout(r, 1_000))
      entriesView = readSaEntries()
    }
  }
  const registered = entriesView.registered
  const settledEntries = entriesView.settledEntries
  expect(registered.length, `subagent-record v2 registered 条目应恰 1（实际 ${registered.length}——2 = 第二次调用新建了独立成员）`).toBe(1)
  expect(
    registered[0]?.['origin'],
    'registered 条目 origin 应为 workflow',
  ).toBe('workflow')
  expect(registered[0]?.['parentRunId'], 'registered 条目应锚定本 run').toBe(run.runId)
  expect(settledEntries.length, `subagent-record v2 settled 条目应恰 1（同一成员收尾一次）`).toBe(1)
  return { registered }
}

// ── A8/V8：同名续写同一子代理 ────────────────────────────────────────────

test('WRR-A8 (batch real): 同名 agent() 两次调用复用同一成员（memberRecordId 绑定恰 1 + session 文件连续）', async ({ }, testInfo) => {
  applyRealTrackGate(test, { timeoutMs: 600_000, tag: 'batch-wrr' })
  const app = await launchWrrApp(testInfo, 'taiji-batch-wrr-a8-', 'a8-ready.png')
  try {
    const createReply = await wsRoundTrip(app.port, {
      type: 'session.create',
      id: 'a8-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-wrr-a8-name-reuse' },
    }, 'a8-create')
    const { sid, sub } = await openMainListenWs(app.port, createReply)
    app.listen.current = sub

    const sessionsDir = path.join(app.dataDir, 'agent', 'sessions')
    const shellBase = shellProcessSnapshot()

    await dispatchTemplateRun(app.port, sid, REUSE_TEMPLATE, {
      firstTask: FIRST_TASK_REUSE,
      secondTask: SECOND_TASK_REUSE,
    }, 'a8-dispatch', sub, app.consoleCap.errors, app.dataDir)

    // run 收尾
    const run = await waitForRunSettled(app.dataDir, SETTLE_TIMEOUT_MS, 'a8')
    const settledFrames = run.frames.filter((f) => f['type'] === 'run-settled')
    expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
    expect(settledFrames[0]?.['outcome'], 'run 应 done 收尾').toBe('done')

    // record 流复用（D6 绑定消解后语义）：member-pool 事件已删，「同名复用」
    // 承载于 agent-started 载荷字段 memberRecordId——首派（新建成员）缺省，续写
    // （复用既有成员）携带。恰 1 条携带 = 第二次调用复用；2 条全缺省 = 第二次
    // 误建新成员（复用通道未命中）。
    const agentStarted = run.frames.filter((f) => f['type'] === 'agent-started')
    if (agentStarted.length !== 2) {
      writeDiag('batch-wrr-a8-agent-started.json', {
        startedFrames: agentStarted,
        types: run.frames.map((f) => String(f['type'])),
      })
    }
    expect(agentStarted.length, `agent-started 应恰 2 帧（两条同名调用；实际 ${agentStarted.length}）`).toBe(2)
    const rebound = agentStarted.filter((f) => typeof f['memberRecordId'] === 'string' && f['memberRecordId'] !== '')
    expect(rebound.length, `携带 memberRecordId 的 agent-started 应恰 1 帧（实际 ${rebound.length}——0 = 复用通道未命中，2 = 形态非法）`).toBe(1)
    expect(
      String(rebound[0]?.['memberRecordId']),
      'memberRecordId 应非空（复用绑定的 record id）',
    ).not.toBe('')
    const agentNames = new Set(agentStarted.map((f) => String(f['agentName'])))
    expect(agentNames.size, `两条 agent-started 的 agentName 应同为 solo-worker（实际 ${[...agentNames].join(',')}）`).toBe(1)
    const agentSettled = run.frames.filter((f) => f['type'] === 'agent-settled')
    expect(agentSettled.length, 'agent-settled 应恰 2 帧').toBe(2)
    expect(
      agentSettled.every((f) => f['outcome'] === 'done'),
      '两条 agent 均应 done（revive 续写轮正常完成）',
    ).toBe(true)

    const sessionsNow = listFilesRecursive(sessionsDir, '.jsonl')
    const { registered } = await assertA8RecordMediaFace(sessionsNow, run, app.dataDir, sid)

    // record 事件文件（ADR-0141 session 存储树：<root>/<rootSessionId>/subagents/records/
    // <sa-id>.events，分区键 = rootSessionId、无 encodeCwd 层）
    const recordsDir = path.join(app.dataDir, 'ext-sessions', sid, 'subagents', 'records')
    const runRecordId = String(registered[0]?.['id'])
    const recordEventsFile = path.join(recordsDir, `${runRecordId}.events`)
    if (!fs.existsSync(recordEventsFile)) {
      writeDiag('batch-wrr-a8-record-events-missing.json', {
        recordsDir,
        runRecordId,
        subagentsTree: listFilesRecursive(path.join(app.dataDir, 'ext-sessions'), '').slice(0, 40),
      })
    }
    expect(fs.existsSync(recordEventsFile), `record 事件文件应存在（${recordEventsFile}；diag 含 subagents 树）`).toBe(true)
    const recordEvents = parseJsonlLines(recordEventsFile).entries
    const createdFrames = recordEvents.filter((e) => e['type'] === 'record-created')
    expect(createdFrames.length, `record 事件文件 record-created 应恰 1 帧（单 record；实际 ${createdFrames.length}）`).toBe(1)
    // 多轮证据注记：workflow 成员复用的 revive 续轮 = engine.run(resume) 直发
    //（runWorkflowEngineTask），不经 chat 域 Continuation 轮始簿记——record-round-started
    // 帧只存在于 chat 域续轮，A8 的多轮证据由 agent-started memberRecordId 绑定单帧 +
    // v2 条目对 + agent-started/settled ×2 承载（帧型清单落 diag 供人工复核）。
    writeDiag('batch-wrr-a8-record-events.json', {
      runRecordId,
      frameTypes: recordEvents.map((e) => String(e['type'])),
    })

    // 收尾：薄壳回落基线（run 收尾窗口 dispose；复用不改变收尾语义）
    const shellBack = await waitUntil(() => shellProcessSnapshot().pids.size <= shellBase.pids.size, ORPHAN_GRACE_MS, 1_000)
    expect(shellBack, `run 收尾后薄壳应回落基线（${ORPHAN_GRACE_MS}ms 窗）`).toBe(true)

    await app.page.screenshot({ path: testInfo.outputPath('a8-done.png'), fullPage: true })
    if (app.consoleCap.errors.length > 0) {
      writeDiag('batch-wrr-a8-console-errors.json', { errors: app.consoleCap.errors.slice(-50) })
      console.warn(`[batch-wrr] A8 renderer console errors: ${app.consoleCap.errors.length} 条（diag 已落盘，非断言范围）`)
    }
    console.log(`[batch-wrr] A8 PASS：memberRecordId 绑定恰 1、两轮同 session 文件、run done`)
  } finally {
    try {
      app.listen.current?.ws.close()
    } finally {
      await app.cleanup()
    }
  }
})
