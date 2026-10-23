/**
 * BATCH-WL 窗口生命周期（pi-workflow-run-resource-model D3 验收 A1/A3，设计场景 V1/V3）。
 *
 * 场景：双 workflow 并发（long = 2 成员各 sleep 150s；short = 1 成员 sleep 20s，独立
 * session 各自派发）——
 *  - A3/V3 并发窗口隔离：short run 正常收尾（run-settled completed + finalizeRun 窗口
 *    dispose）后，long run 的成员保活进程与引擎宿主薄壳均仍存活（短收尾只 dispose 自己
 *    的窗口实例，不波及并发窗口），且 long 最终以 completed 收尾（若短收尾误杀长窗口，
 *    long 成员 ask 失败 → outcome ≠ completed）。
 *  - A1/V1 正常完成后薄壳退出：long run completed 收尾后，成员保活进程与引擎宿主薄壳
 *    计数均回落基线（finalizeRun 五步序列末尾窗口 dispose 生效于正常完成路径；abort
 *    路径的同型断言由 batch-s4 承载）。
 *
 * 断言原始证据文档 = ps 进程表（scripts/count-engine-shell-processes.mjs 特征并集，
 * 基线差分吸收环境常驻与测试进程 cmdline 噪声）+ run journal run-settled 帧
 * （batch-s4/W1 已锚定 journal 介质，本 spec 不重复 journal 结构断言）。
 *
 * 执行侧约定（与 batch-s1/s3/s4 同款）：
 * - 触发：窗口资源模型行为范围（engine 窗口实例表 / finalizeRun 收尾链 / 路由）改动时
 *   开发期空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 + 本机 provider 凭证，缺一 skip
 *   不 fail；CI/PR/merge 门禁不跑本组。
 * - 前置：VITE_E2E=true pnpm run build:e2e（real renderer bundle）。
 * - 预算：600s（长成员 150s sleep + 双派发 turn + 收尾确认）；「第一个 settled =
 *   short」判据由 sleep 硬下界保证（150s vs 20s），LLM 抖动不反转。
 * - 失败归因：writeDiag 落 /tmp/batch-wl-*.json（journal 帧型 + 进程明细 + 日志尾），
 *   禁不归因重试、禁放宽断言换绿灯。
 */
import { test, expect } from '@playwright/test'
import {
  launchRealApp,
  wsRoundTrip,
  readRuntimeLogs,
  readPiLogs,
  type WsFrame,
} from './fixtures/launch-app-real'
import {
  applyRealTrackGate,
  attachConsoleCapture,
  awaitMainTurnComplete,
  cleanupRealTrackApp,
  countEngineShellProcesses,
  countMemberSleeperProcesses,
  listFilesRecursive,
  openMainListenWs,
  parseJsonlLines,
  SAMPLE_PROJECT,
  seedRealCredentials,
  tmpDiag,
  waitRealAppReady,
  waitUntil,
} from './fixtures/batch-real-helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MEMBER_SLEEP_LONG_S = 150
const MEMBER_SLEEP_SHORT_S = 20

const taskText = (sleepS: number): string =>
  `First run \`sleep ${sleepS}\` using the bash tool, wait for it to finish, then reply with only the word MEMBER-DONE.`

/** 成员对象形状（subagent-tool-interface-refactor §3.1.2 终态）：tasks 元素只接受
 *  {task, agent?, model?, thinkingLevel?} 对象——字符串元素已被 schema 拒绝。 */
const longTasks = [
  { task: taskText(MEMBER_SLEEP_LONG_S) },
  { task: taskText(MEMBER_SLEEP_LONG_S) },
]
const shortTasks = [{ task: taskText(MEMBER_SLEEP_SHORT_S) }]

const DISPATCH_PROMPT_LONG =
  `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagent_batch\` tool ` +
  `(do NOT do the tasks yourself). Both tasks are identical long-running tasks: ` +
  `tasks = ${JSON.stringify(longTasks)} ` +
  `After the tool call returns, reply with only the word DISPATCHED. [BATCH-WL-LONG-7731]`

const DISPATCH_PROMPT_SHORT =
  `Dispatch exactly 1 background subagent task in ONE call using the \`subagent_batch\` tool ` +
  `(do NOT do the task yourself). The task: tasks = ${JSON.stringify(shortTasks)} ` +
  `After the tool call returns, reply with only the word DISPATCHED. [BATCH-WL-SHORT-7732]`

// ── 预算 ────────────────────────────────────────────────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 300_000
const ORPHAN_GRACE_MS = 150_000
/** 短收尾 dispose 完成观察窗：run-settled 帧落 journal 与窗口 dispose 同在收尾链，
 *  留小窗让 dispose 与进程退出可见，再断言长窗口未被波及。 */
const SHORT_TEARDOWN_OBSERVE_MS = 5_000

// ── 凭证门与播种 / 诊断与扫描 helpers（共享实现 = fixtures/batch-real-helpers.ts；
//    本文件只留 tag 绑定与 WL 特有的 settled 视图） ─────────────────────────────

const writeDiag = tmpDiag('batch-wl')

interface RunSettledView { // oe-exempt:20260927:test:e2e 剧本内视图形状声明（DOM mock 类型，非架构契约范围）
  runId: string
  outcome: string | undefined
}

function readSettledFrames(journalFile: string): RunSettledView[] {
  return parseJsonlLines(journalFile).entries
    .filter((f) => f['type'] === 'run-settled')
    .map((f) => ({
      runId: path.basename(journalFile).replace(/\.record\.jsonl$/, ''),
      outcome: typeof f['outcome'] === 'string' ? f['outcome'] : undefined,
    }))
}

// ── 主用例 ───────────────────────────────────────────────────────────────


/**
 * [WL test 拆分] 在途证据段：双 run journal 落盘 + long 两成员 / short 一成员 /
 * 引擎宿主薄壳（每 run 一窗口）的差分计数正面对照。失败 diag 与拆出前同构。
 */
async function awaitWLInFlightEvidence(
  dataDir: string,
  baseLong: { count: number; lines: string[] },
  baseShort: { count: number; lines: string[] },
  shellBaseline: { count: number; lines: string[] },
): Promise<string[]> {
  // ── journal 恰 2 个 run（双 workflow 在途；后缀 .record.jsonl——run-vocabulary RUN_EVENTS_SUFFIX） ──
  const agentDir = path.join(dataDir, 'agent')
  const journalsFound = await waitUntil(() => listFilesRecursive(agentDir, '.record.jsonl').length >= 2, JOURNAL_TIMEOUT_MS)
  if (!journalsFound) {
    writeDiag('batch-wl-journals-missing.json', {
      runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      piLogsTail: readPiLogs(dataDir).slice(-3000),
    })
  }
  expect(journalsFound, '双 workflow run journal 应落盘').toBe(true)
  const journalFiles = listFilesRecursive(agentDir, '.record.jsonl')

  // ── 在途证据：long 两成员 + short 一成员 + 引擎宿主薄壳（每 run 一窗口） ──
  const inFlightLong = await waitUntil(
    () => countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').count - baseLong.count >= 2,
    JOURNAL_TIMEOUT_MS,
  )
  const inFlightShort = countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S, 'batch-wl').count - baseShort.count >= 1
  const shellInFlight = await waitUntil(
    () => countEngineShellProcesses('batch-wl').count > shellBaseline.count,
    JOURNAL_TIMEOUT_MS,
  )
  if (!inFlightLong || !inFlightShort || !shellInFlight) {
    writeDiag('batch-wl-inflight-missing.json', {
      baseLong: baseLong.lines,
      longNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').lines,
      baseShort: baseShort.lines,
      shortNow: countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S, 'batch-wl').lines,
      shellBaseline: shellBaseline.lines,
      shellNow: countEngineShellProcesses('batch-wl').lines,
      hint: '特征不命中——按 count-engine-shell-processes.mjs 头注校准特征集，不删在途断言',
    })
  }
  expect(inFlightLong, `派发后 long 成员保活进程应 ≥2（差分；diag 见明细）`).toBe(true)
  expect(inFlightShort, `派发后 short 成员保活进程应 ≥1（差分）`).toBe(true)
  expect(shellInFlight, `派发后引擎宿主薄壳应 > 基线（per-window 在途证据）`).toBe(true)
  return journalFiles
}

test('WL (batch real): 双 workflow 并发——短收尾不杀长窗口（V3）+ 长正常完成后薄壳回落基线（V1）', async ({ }, testInfo) => {
  applyRealTrackGate(test, { timeoutMs: 600_000, tag: 'batch-wl' })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-wl-'))
  seedRealCredentials(dataDir, 'batch-wl')

  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  const listeners: { ws: { close: () => void }; events: WsFrame[] }[] = []
  try {
    const port = await waitRealAppReady(page, dataDir, 'batch-wl')
    await page.screenshot({ path: testInfo.outputPath('wl-app-ready.png'), fullPage: true })

    // ── 双 session 装配（long / short 各自独立 session 并发推进） ──
    const openSession = async (label: string, id: string): Promise<string> => {
      const createReply = await wsRoundTrip(port, {
        type: 'session.create',
        id,
        payload: { cwd: SAMPLE_PROJECT, label },
      }, id)
      const { sid, sub } = await openMainListenWs(port, createReply)
      listeners.push(sub)
      return sid
    }
    const longSid = await openSession('batch-wl-long', 'wl-create-long')
    const shortSid = await openSession('batch-wl-short', 'wl-create-short')

    // ── 基线（派发前；差分吸收环境常驻薄壳与测试进程 cmdline 噪声） ──
    const baseLong = countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl')
    const baseShort = countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S, 'batch-wl')
    const shellBaseline = countEngineShellProcesses('batch-wl')
    expect(baseLong.count, '进程基线应可读（ps 失败 = -1 哨兵，环境异常 fail-fast）').toBeGreaterThanOrEqual(0)
    expect(baseShort.count, '进程基线应可读（ps 失败 = -1 哨兵，环境异常 fail-fast）').toBeGreaterThanOrEqual(0)
    expect(shellBaseline.count, '引擎宿主薄壳基线应可读（计数脚本失败 = -1 哨兵）').toBeGreaterThanOrEqual(0)

    // ── 双派发（long 先、short 后；不同 session 并行推进） ──
    const dispatch = async (sid: string, content: string, wsId: string, sub: { events: WsFrame[] }): Promise<void> => {
      const sendReply = await wsRoundTrip(port, {
        type: 'message.send',
        id: wsId,
        payload: { sessionId: sid, content },
      }, wsId, 30_000)
      expect(sendReply.type, '派发 prompt 应被接受').not.toBe('error')
      await awaitMainTurnComplete({
        events: sub.events,
        timeoutMs: MAIN_TURN_TIMEOUT_MS,
        dataDir,
        consoleErrors: consoleCap.errors,
        diag: writeDiag,
        diagName: `batch-wl-${wsId}-turn.json`,
        foundMessage: `派发 turn（${wsId}）未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（真实 LLM 未调 subagent_batch 工具？）`,
      })
    }
    await dispatch(longSid, DISPATCH_PROMPT_LONG, 'wl-dispatch-long', listeners[0]!)
    await dispatch(shortSid, DISPATCH_PROMPT_SHORT, 'wl-dispatch-short', listeners[1]!)

    const journalFiles = await awaitWLInFlightEvidence(dataDir, baseLong, baseShort, shellBaseline)
    await page.screenshot({ path: testInfo.outputPath('wl-in-flight.png'), fullPage: true })

    // ── short 收尾（第一个 settled = short：sleep 硬下界 150s vs 20s 保证判据） ──
    const shortSettled = await waitUntil(
      () => journalFiles.map((f) => readSettledFrames(f)).some((frames) => frames.length > 0),
      SETTLE_TIMEOUT_MS,
      2_000,
    )
    if (!shortSettled) {
      writeDiag('batch-wl-short-not-settled.json', {
        journals: journalFiles.map((f) => ({ file: path.basename(f), types: parseJsonlLines(f).entries.map((e) => String(e['type'])) })),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(shortSettled, `short run 应在 ${SETTLE_TIMEOUT_MS}ms 内落 run-settled 帧`).toBe(true)
    const shortRunId = journalFiles
      .flatMap((f) => readSettledFrames(f))
      .map((v) => v.runId)[0]
    expect(shortRunId, 'short runId 应可从 journal 文件名解析').toBeTruthy()

    // ── A3/V3 断言：短收尾后长窗口不被波及 ──
    // 留观察窗让短收尾 dispose 与进程退出可见，再核对长侧存活。
    await new Promise((r) => setTimeout(r, SHORT_TEARDOWN_OBSERVE_MS))
    const longMembersAlive = countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').count - baseLong.count >= 2
    const longShellAlive = countEngineShellProcesses('batch-wl').count > shellBaseline.count
    if (!longMembersAlive || !longShellAlive) {
      writeDiag('batch-wl-long-window-hit.json', {
        shortRunId,
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').lines,
        shellNow: countEngineShellProcesses('batch-wl').lines,
        shellBaseline: shellBaseline.lines,
        journals: journalFiles.map((f) => ({ file: path.basename(f), types: parseJsonlLines(f).entries.map((e) => String(e['type'])) })),
      })
    }
    expect(longMembersAlive, 'short 收尾后 long 成员保活进程应仍 ≥2（并发窗口隔离——短收尾不杀长 run 成员）').toBe(true)
    expect(longShellAlive, 'short 收尾后 long 引擎宿主薄壳应仍 > 基线（短收尾只 dispose 自己的窗口实例）').toBe(true)

    // ── long 收尾（completed）+ A1/V1 断言：正常完成后计数回落基线 ──
    const longSettledCompleted = await waitUntil(
      () => journalFiles.flatMap((f) => readSettledFrames(f)).some((v) => v.outcome === 'completed'),
      SETTLE_TIMEOUT_MS,
      2_000,
    )
    const settledNow = journalFiles.flatMap((f) => readSettledFrames(f))
    if (!longSettledCompleted) {
      writeDiag('batch-wl-long-not-completed.json', {
        settledFrames: settledNow,
        journals: journalFiles.map((f) => ({ file: path.basename(f), types: parseJsonlLines(f).entries.map((e) => String(e['type'])) })),
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').lines,
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(longSettledCompleted, `long run 应 completed 收尾（若为 failed/partial = 短收尾波及长窗口或成员超预算，见 diag）`).toBe(true)

    const membersBack = await waitUntil(
      () => countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').count <= baseLong.count,
      ORPHAN_GRACE_MS,
      1_000,
    )
    const shellBack = await waitUntil(
      () => countEngineShellProcesses('batch-wl').count <= shellBaseline.count,
      ORPHAN_GRACE_MS,
      1_000,
    )
    if (!membersBack || !shellBack) {
      writeDiag('batch-wl-teardown-residue.json', {
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S, 'batch-wl').lines,
        shellNow: countEngineShellProcesses('batch-wl').lines,
        shellBaseline: shellBaseline.lines,
      })
    }
    expect(membersBack, `long completed 收尾后成员保活进程应回落基线（孤儿窗口 ${ORPHAN_GRACE_MS}ms）`).toBe(true)
    expect(shellBack, `long completed 收尾后引擎宿主薄壳应退出（A1/V1 正常完成路径窗口 dispose；残留见 diag）`).toBe(true)

    await page.screenshot({ path: testInfo.outputPath('wl-teardown.png'), fullPage: true })
    if (consoleCap.errors.length > 0) {
      writeDiag('batch-wl-console-errors.json', { errors: consoleCap.errors.slice(-50) })
      console.warn(`[batch-wl] renderer console errors: ${consoleCap.errors.length} 条（diag 已落盘，非断言范围）`)
    }
    console.log(`[batch-wl] PASS：shortRunId=${shortRunId} 短收尾未波及长窗口；long completed 收尾后成员与薄壳均回落基线`)
  } finally {
    await cleanupRealTrackApp({
      closeListeners: () => {
        for (const l of listeners) l.ws.close()
      },
      cleanup,
      dataDir,
    })
  }
})
