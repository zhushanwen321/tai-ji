/**
 * BATCH S4 中途停止（E2E-BATCH-04）—— 派发后 workflow abort → run 终态 cancelled + 通知照达 + 无孤儿（成员任务子进程 + 引擎宿主薄壳）。
 *
 * 登记：E2E-BATCH-04（docs/testing/e2e-map.json，R2 按改动范围 on-diff，serial 空载串行，
 * L3 真实 LLM）。
 *
 * 断言语义来源（两段叠加，以 W1 新介质为准）：
 * - 场景编排 = 原始场景 S4（e2e-map E2E-BATCH-04.note）：派发后 workflow abort →
 *   run 终态 aborted + 通知到达 + 无孤儿 pi 子进程（ps 核对为通过条件之一）。
 * - 持久介质断言 = W1 设计（w1-run-record-journal-authority，历史设计档案已随 .tmp 清理，git 可追溯）§4.2 场景 1
 *   （介质归位）+ D1 终态条目契约：abort 终局同样按新介质写入 journal 记录——
 *   ① journal run-settled 恰 1 帧、outcome=cancelled（abort → cancelled，run-events
 *      DoneReason→RunOutcome 单点映射；「aborted」在 W1 事件词表命名为 cancelled）；
 *   ② notifyDone 送达恰 1 条（wf-done:<runId> 幂等键——abort 终局通知链不丢）；
 *   ③ workflow-record v2 settled 条目 outcome === journal outcome（journal 唯一事实源
 *      的终态派生视图）；
 *   ④ 无孤儿：abort 收尾后成员任务保活进程（sleep）无残留（R0/C1 孤儿进程修复的
 *      端到端验收范围——abort 先杀 run 拓扑 spawned children 再收尾），且引擎宿主
 *      （pi-subagent-cli 薄壳）一并退出（pi-workflow-run-resource-model per-window
 *      形态：薄壳随派发窗口生灭，run 收尾 finalizeRun 遍历窗口实例 dispose 杀薄壳）。
 *
 * 可复用登记声明：本 spec 是 E2E-BATCH-04 的可复用真机资产（后续触碰 abort/收尾/
 * 引擎进程回收行为范围时直接执行本文件，不再重建一次性剧本）。
 *
 * 执行侧约定（与 E2E-BATCH-01 同族）：
 * - 触发：scope diff 命中时开发期按改动范围空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 +
 *   本机 provider 凭证（缺一 skip 不 fail）；CI/PR/merge 门禁不跑。
 *   前置：real renderer bundle（VITE_E2E=true pnpm run build:e2e，不带 VITE_MOCK）。
 * - 预算：test.setTimeout 420s。在途保活旋钮 = 成员任务内 bash `sleep 180`
 *  （MEMBER_SLEEP_S——派发/abort 两 turn 的真实 LLM 耗时须落在保活窗内；若 abort 时
 *   run 已自然完成（收到 outcome=completed），属保活窗口不足 → 调大 MEMBER_SLEEP_S，
 *   禁止放宽断言）。
 * - 进程核对锚（双特征集，互不重叠）：
 *   ① 成员保活 = 命令行含 "sleep ${MEMBER_SLEEP_S}"（DISPATCH_PROMPT 指定的成员
 *     保活命令——本 run 派生出的成员任务子进程的直接特征）。
 *   ② 引擎宿主薄壳 = scripts/count-engine-shell-processes.mjs（特征串权威单源：
 *     'pi-subagent-cli' / '/engines/' 并集，从 spawn 实装读取；判定用「派发前基线 →
 *     收尾后复测」差分，zcode 常驻单例与测试进程 cmdline 噪声被基线吸收——脚本头注
 *     口径）。真机首跑若特征不命中（pi bash 工具 spawn 形态变化），校准特征集而非
 *   删除断言。
 * - 失败归因：writeDiag 落 testInfo.outputPath（batch-s4-*.json，journal 帧序 + 进程
 *   快照 + 日志尾 + 会话尾；载荷可含 session entry 正文，不落 /tmp——ADR-0063 I2，
 *   s1/s3 同族同款）
 *   + console 抓取 + 全页截图 + <dataDir>/logs/。重试禁令：失败先归因。
 *
 * 形态说明：真实 Electron app 自启动（launchRealApp），WS 直连驱动两 turn
 * （派发 turn → abort turn）；断言原始证据文档 = journal 文件 + 主 session JSONL +
 * 进程表（磁盘与系统事实，不依赖 DOM）。
 */
import { test, expect, type TestInfo } from '@playwright/test'
import {
  launchRealApp,
  wsRoundTrip,
  readRuntimeLogs,
  readPiLogs,
  type WsFrame,
} from './fixtures/launch-app-real'
import {
  applyRealTrackGate,
  assertNotifyThreeChannels,
  cleanupRealTrackApp,
  assertSingleRunSettled,
  attachConsoleCapture,
  countEngineShellProcesses,
  countMemberSleeperProcesses,
  extractCustomEntries,
  locateMainSessionFile,
  openMainListenWs,
  readJournalFrames,
  SAMPLE_PROJECT,
  seedRealCredentials,
  testInfoDiag,
  waitForRunJournal,
  waitRealAppReady,
  waitUntil,
} from './fixtures/batch-real-helpers'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 在途保活旋钮（执行侧约定「预算」）：成员 bash sleep 秒数，abort 须落在其内。 */
const MEMBER_SLEEP_S = 180
const MAIN_MARKER = 'BATCH-S4-MAIN-5320'

const DISPATCH_PROMPT =
  `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagents\` tool ` +
  `(do NOT do the tasks yourself). Both tasks are identical long-running tasks: ` +
  `"First run \\\`sleep ${MEMBER_SLEEP_S}\\\` using the bash tool, wait for it to finish, then reply with only the word MEMBER-DONE." ` +
  `After the tool call returns, reply with only the word DISPATCHED. [${MAIN_MARKER}]`

function abortPrompt(runId: string): string {
  return (
    `Stop the workflow run with runId "${runId}" NOW. Use the \`workflow_control\` tool with ` +
    `action "abort" and runId "${runId}" (reason: "e2e s4 abort test"). ` +
    `Do not use any other tool. After the tool returns, reply with only the word ABORTED.`
  )
}

// ── 预算 ────────────────────────────────────────────────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 300_000
const ABORT_SETTLE_TIMEOUT_MS = 120_000
const NOTIFY_TIMEOUT_MS = 120_000
/** ack 关闭等待窗：ack 由回执扫描（agent_settled 边沿）驱动——通知唤醒 turn 结算
 *  后才落盘，送达后立即断言必为 0；窗口 = 一个真实 LLM turn（r3 实测教训）。 */
const ACK_TIMEOUT_MS = 180_000
const ORPHAN_GRACE_MS = 150_000
const JSONL_FLUSH_TIMEOUT_MS = 20_000

// ── 凭证门与播种 / 诊断与扫描 helpers（共享实现 = fixtures/batch-real-helpers.ts；
//    本文件只留 tag 绑定；成员保活计数固定锚 = sleep ${MEMBER_SLEEP_S}） ──────────

const writeDiag = testInfoDiag('batch-s4')

/**
 * [S4 test 拆分] 在途证据段：journal 落盘 + agent-started 帧（成员在途事实，
 * RUN_EVENT_TYPES 词表内现行等价帧）+ 成员保活进程与引擎宿主薄壳的双正面对照
 * （孤儿断言的前提是派发后确实有任务进程可回收）。失败路径 diag 与拆出前同构。
 */
async function awaitS4InFlightEvidence(
  testInfo: TestInfo,
  dataDir: string,
  baseline: { count: number; lines: string[] },
  shellBaseline: { count: number; lines: string[] },
): Promise<{ journalFile: string; runId: string }> {
  const agentDir = path.join(dataDir, 'agent')
  const journalFile = await waitForRunJournal({
    agentDir,
    dataDir,
    timeoutMs: JOURNAL_TIMEOUT_MS,
    foundMessage: 'run journal 应落盘',
    diag: (name, data) => writeDiag(testInfo, name, data),
    diagName: 'batch-s4-journal-missing.json',
  })
  const runId = path.basename(journalFile).replace(/\.record\.jsonl$/, '')
  const dispatched = await waitUntil(
    () => readJournalFrames(journalFile).some((f) => f['type'] === 'agent-started'),
    JOURNAL_TIMEOUT_MS,
  )
  if (!dispatched) {
    writeDiag(testInfo, 'batch-s4-not-dispatched.json', {
      journalEventTypes: readJournalFrames(journalFile).map((f) => f['type']),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(dispatched, `journal 应出现 agent-started 帧（成员在途——abort 才有「中途」语义）`).toBe(true)

  // 成员保活进程在跑（正面对照：孤儿断言的前提是派发后确实有任务进程可回收）
  const inFlight = await waitUntil(() => countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4').count > baseline.count, JOURNAL_TIMEOUT_MS)
  if (!inFlight) {
    writeDiag(testInfo, 'batch-s4-engine-process-not-seen.json', {
      baseline: baseline.lines,
      current: countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4').lines,
      hint: '特征集不命中——按头注「进程核对锚」校准特征集，不删孤儿断言',
    })
  }
  expect(inFlight, `派发后成员保活进程数应 > 基线（在途证据；特征锚见 diag）`).toBe(true)

  // 引擎宿主薄壳在跑（per-window 在途证据：窗口内薄壳存活，是收尾后可回收的前提）
  const shellInFlight = await waitUntil(() => countEngineShellProcesses('batch-s4').count > shellBaseline.count, JOURNAL_TIMEOUT_MS)
  if (!shellInFlight) {
    writeDiag(testInfo, 'batch-s4-engine-shell-not-seen.json', {
      shellBaseline: shellBaseline.lines,
      shellCurrent: countEngineShellProcesses('batch-s4').lines,
      hint: '薄壳特征不命中（pi-subagent-cli / /engines/）——按 count-engine-shell-processes.mjs 头注校准特征集，不删宿主断言',
    })
  }
  expect(shellInFlight, `派发后引擎宿主薄壳数应 > 基线（per-window 在途证据；特征锚见 diag）`).toBe(true)
  return { journalFile, runId }
}


/**
 * [S4 test 拆分] 断言 A1+A2 基座：run-settled(cancelled) 恰 1 + 主会话 JSONL 落盘
 * + notifyDone 送达等待。返回主会话文件路径（后续三通道计数与孤儿断言消费）。
 */
async function awaitS4SettlementAndNotifyBase(
  testInfo: TestInfo,
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
    writeDiag(testInfo, 'batch-s4-not-settled.json', {
      journalEventTypes: frames.map((f) => f['type']),
      engineProcesses: countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4').lines,
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(settled, `abort 后 run 应在 ${ABORT_SETTLE_TIMEOUT_MS}ms 内落 run-settled 帧`).toBe(true)
  assertSingleRunSettled(
    frames,
    'cancelled',
    `abort 终局 outcome 应为 cancelled（若为 completed = 保活窗口不足，调大 MEMBER_SLEEP_S）`,
  )

  // ── 断言 A2：notifyDone 照达恰 1 ──
  const sessionFile = await locateMainSessionFile(agentDir, MAIN_MARKER, JSONL_FLUSH_TIMEOUT_MS, '主会话 JSONL 应已落盘')
  const notifyId = `wf-done:${runId}`
  const notifyArrived = await waitUntil(() => fs.readFileSync(sessionFile, 'utf8').includes(notifyId), NOTIFY_TIMEOUT_MS)
  if (!notifyArrived) {
    writeDiag(testInfo, 'batch-s4-notify-missing.json', {
      journalEventTypes: frames.map((f) => f['type']),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(notifyArrived, `abort 终局通知应照达（${notifyId}）——通知链不因 abort 丢失`).toBe(true)

  // ── 三通道口径（BATCH-06）：送达恰 1 + ledger/ack 各恰 1 ──
  // 通道与 entry type 均不同（与 s1 同款口径，详见 s1 注释）：①送达 = type
  // custom_message × customType "workflow-result"（u9 外部通道设计，键在顶层
  // details.notifyId；权威消费方 collectDeliveredNotifyIds）②ledger 条目写入 = type
  // custom × "subagent-bg-notify-ledger" ③ack 关闭 = type custom ×
  // "subagent-bg-notify-ack"。「键出现次数」结构性 = 3 ≠ 投递次数。

  return sessionFile
}


/**
 * [S4 test 拆分] 断言 A3 + A4①：v2 settled 条目 outcome 与 journal 一致
 * （journal 唯一事实源派生视图）+ 成员保活 sleep 进程回落基线（abort 的 kill 分级
 * 先杀 run 拓扑再收尾；diag 带 etime/ppid 供残留时定位 kill 链路——countMember
 * SleeperProcesses 的 lines 是 `ps -axo command=` 纯命令行（无 PID 列），PID 需按
 * 同特征从 `ps -axo pid,command=` 重采样（r5 实测取 command 第二段当 PID 会 ps
 * 报错使 diag 自身炸掉））。
 */
async function assertS4SettledEntryAndOrphanFree(
  testInfo: TestInfo,
  sessionFile: string,
  runId: string,
  baseline: { count: number; lines: string[] },
  frames: Record<string, unknown>[],
): Promise<void> {
  // ── 断言 A3：v2 settled 条目 outcome === journal（journal 唯一事实源派生视图） ──
  const wfSettled = extractCustomEntries(sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
  const thisRunSettled = wfSettled.find((d) => d['runId'] === runId)
  expect(thisRunSettled, 'workflow-record v2 settled 条目应存在（abort run 也写终态条目）').toBeDefined()
  expect(thisRunSettled?.['outcome'], 'settled 条目 outcome 应为 cancelled（与 journal run-settled 一致）').toBe('cancelled')

  // ── 断言 A4：无孤儿（正面对照 = 派发后两者均曾 > 基线） ──
  // ① 成员保活 sleep 进程（run 拓扑 spawned children）：abort 的 kill 分级先杀
  //    run 拓扑再收尾，杀干净后应立即回落基线。
  // ② 引擎宿主 pi-subagent-cli 薄壳：per-window 形态下随派发窗口生灭（run 收尾
  //    finalizeRun 遍历窗口实例 dispose），收尾后同样回落基线（头注断言 ④ 的升级；
  //    计数复用 count-engine-shell-processes.mjs，基线差分吸收环境噪声）。
  // diag 带 etime/ppid 供残留时定位 kill 链路。
  const orphanFree = await waitUntil(() => countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4').count <= baseline.count, ORPHAN_GRACE_MS, 1000)
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
    writeDiag(testInfo, 'batch-s4-orphans.json', {
      baseline: baseline.lines,
      current: countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4').lines,
      psDetail,
      journalEventTypes: frames.map((f) => f['type']),
    })
  }
  expect(orphanFree, `abort 收尾后成员保活进程数应回落基线（孤儿窗口 ${ORPHAN_GRACE_MS}ms；残留进程见 diag）`).toBe(true)
}
// ── S4 主用例 ────────────────────────────────────────────────────────────

test('S4 (batch real): 派发后 abort → run-settled(cancelled) + 通知照达 + 无孤儿（成员任务子进程 + 引擎宿主薄壳）', async ({ }, testInfo) => {
  // 凭证双门（缺一 skip 不 fail——防全量扫跑烧 token）
  applyRealTrackGate(test, { timeoutMs: 420_000, tag: 'batch-s4' })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s4-'))
  seedRealCredentials(dataDir, 'batch-s4')

  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    const port = await waitRealAppReady(page, dataDir, 'batch-s4')
    await page.screenshot({ path: testInfo.outputPath('s4-app-ready.png'), fullPage: true })

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's4-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-s4-abort-no-orphan' },
    }, 's4-create')
    const { sid, sub } = await openMainListenWs(port, createReply)
    listen = sub

    // 进程基线（成员保活进程与引擎宿主薄壳 spawn 前；正常环境两者均应为 0）
    const agentDir = path.join(dataDir, 'agent')
    const baseline = countMemberSleeperProcesses(MEMBER_SLEEP_S, 'batch-s4')
    expect(baseline.count, '进程基线应可读（ps 失败 = -1 哨兵，环境异常 fail-fast）').toBeGreaterThanOrEqual(0)
    const shellBaseline = countEngineShellProcesses('batch-s4')
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
      writeDiag(testInfo, 'batch-s4-dispatch-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        consoleErrors: consoleCap.errors,
      })
    }
    expect(dispatchDone, `派发 turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（真实 LLM 未调 subagents 工具？）`).toBe(true)
    sub.events.length = 0

    // ── 在途证据（journal + agent-started + 双进程正面对照；拆出 awaitS4InFlightEvidence）──
    const { journalFile, runId } = await awaitS4InFlightEvidence(testInfo, dataDir, baseline, shellBaseline)
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
      writeDiag(testInfo, 'batch-s4-abort-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(abortTurnDone, `abort turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成`).toBe(true)

    const sessionFile = await awaitS4SettlementAndNotifyBase(testInfo, dataDir, agentDir, journalFile, runId, consoleCap)
    // ── 三通道口径（BATCH-06；与 s1 同款口径，通道注释见共享实现）──
    await assertNotifyThreeChannels({
      sessionFile,
      notifyId: `wf-done:${runId}`,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      dataDir,
      diag: (name, data) => writeDiag(testInfo, name, data),
      diagName: 'batch-s4-ack-missing.json',
    })

    const frames = readJournalFrames(journalFile)
    await assertS4SettledEntryAndOrphanFree(testInfo, sessionFile, runId, baseline, frames)

    // 断言 A4b：引擎宿主薄壳回落基线（per-window 收尾 dispose——abort 收尾杀薄壳，
    // 头注断言 ④ 的升级；同窗等待吸收成员任务收尾与薄壳退出的时序差）
    const shellOrphanFree = await waitUntil(() => countEngineShellProcesses('batch-s4').count <= shellBaseline.count, ORPHAN_GRACE_MS, 1000)
    if (!shellOrphanFree) {
      writeDiag(testInfo, 'batch-s4-engine-shell-orphans.json', {
        shellBaseline: shellBaseline.lines,
        shellCurrent: countEngineShellProcesses('batch-s4').lines,
        journalEventTypes: frames.map((f) => f['type']),
      })
    }
    expect(shellOrphanFree, `abort 收尾后引擎宿主薄壳应退出（计数回落基线，孤儿窗口 ${ORPHAN_GRACE_MS}ms；残留见 diag）`).toBe(true)

    await page.screenshot({ path: testInfo.outputPath('s4-aborted.png'), fullPage: true })
    if (consoleCap.errors.length > 0) {
      writeDiag(testInfo, 'batch-s4-console-errors.json', { errors: consoleCap.errors.slice(-50) })
      console.warn(`[batch-s4] renderer console errors: ${consoleCap.errors.length} 条（diag 已落盘，非断言范围）`)
    }
    console.log(`[batch-s4] PASS：runId=${runId} cancelled 收尾、通知照达、零成员任务残留、引擎宿主薄壳已退出`)
  } finally {
    await cleanupRealTrackApp({ closeListeners: () => listen?.ws.close(), cleanup, dataDir })
  }
})
