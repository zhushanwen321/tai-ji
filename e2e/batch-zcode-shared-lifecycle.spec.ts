/**
 * BATCH-ZSL zcode shared-service 生命周期（pi-workflow-run-resource-model D3 验收
 * A4/A7，场景 V4/V7）。
 *
 * 单场景两断言范围（一条 run 承载）：
 *  - A4/V4 zcode 懒加载单例不变：自定义模板两条 agent()（engine:"zcode"，不同名，
 *    各跑一段 bash sleep）顺序执行——两任务在途期的 zcode 引擎进程（wrapper 落盘
 *    `<engineDataDir>/engines/zcode/` 特征）pid 恒同（双任务同 pid + 任务间不退）。
 *    「现状行为即通过标准」：改造未动 zcode spawn 形态（shared-service 透传 registry
 *    保形），本组 = manifest 显式声明后的路由保形回归。
 *  - A7/V7 taiji 退出杀引擎进程：app.close() 后 zcode 引擎进程随宿主退出（宽限窗内
 *    pid 消失——stdin EOF 自灭链/停机收割）。pi 薄壳的收尾回落已由
 *    batch-window-lifecycle（A1）/ batch-s4（A2）覆盖，本组只验 zcode 面。
 *
 * 断言原始证据文档 = ps 进程表（/engines/zcode/ 特征，基线差分吸收环境常驻；
 * wrapper 进程 argv = node <engineDataDir>/engines/zcode/zcode-launcher.cjs，
 * 同进程 import zcode.cjs——app-server 即该 pid）。执行侧约定与
 * batch-window-lifecycle.spec.ts 同款。
 *
 * 凭据：zcode 引擎共享宿主 HOME（spawn 不覆写），本机 ~/.zcode 凭据直接可用；
 * 缺失时任务失败归 run failed，skip 门只做 config.json 存在性宽松检查。
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
  attachConsoleErrorCapture,
  cleanupRealTrackApp,
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
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ZC_TEMPLATE = path.join(REPO_ROOT, 'e2e', 'fixtures', 'wl-zcode-two.js')

const FIRST_TASK = `[WL-ZC-R1-9911] First run \`sleep 15\` using the bash tool, wait for it to finish, then reply with a one-word summary.`
const SECOND_TASK = `[WL-ZC-R2-9912] First run \`sleep 25\` using the bash tool, wait for it to finish, then reply with a one-word summary.`

const MAIN_TURN_TIMEOUT_MS = 180_000
const PROC_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 300_000
/** 退出宽限：app.close() 后引擎进程（stdin EOF 自灭 / 停机收割）退出窗。 */
const EXIT_GRACE_MS = 30_000

// ── 凭证门与播种 / 诊断 helpers（共享实现 = fixtures/batch-real-helpers.ts；
//    本文件只留 tag 绑定与 ZSL 特有的 zcode 进程快照与凭据门） ───────────────────

const writeDiag = tmpDiag('batch-zsl')

function zcodeCredentialSkipReason(): string | null {
  const cliConfig = path.join(os.homedir(), '.zcode', 'cli', 'config.json')
  if (fs.existsSync(cliConfig)) return null
  return `${cliConfig} 不存在（本机 zcode CLI 凭据缺失，zcode 引擎任务无法执行）`
}

/** zcode 引擎进程快照（特征 = /engines/zcode/——wrapper 落盘路径；app-server 即该 pid）。 */
function zcodeProcessSnapshot(): { pids: Set<number>; lines: string[] } {
  let out = ''
  try {
    out = execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 10_000 })
  } catch (err) {
    console.warn(`[batch-zsl] ps 不可读（降级空集）：${String(err)}`)
    return { pids: new Set(), lines: [] }
  }
  const pids = new Set<number>()
  const lines: string[] = []
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes('/engines/zcode/')) continue
    const sep = trimmed.indexOf(' ')
    if (sep <= 0) continue
    const pid = Number.parseInt(trimmed.slice(0, sep), 10)
    if (!Number.isFinite(pid)) continue
    pids.add(pid)
    lines.push(trimmed)
  }
  return { pids, lines }
}

test('ZSL (batch real): zcode 双任务同 pid（V4 懒加载单例回归）+ taiji 退出引擎进程随退（V7）', async ({ }, testInfo) => {
  applyRealTrackGate(test, { timeoutMs: 600_000, tag: 'batch-zsl' })
  const zcSkip = zcodeCredentialSkipReason()
  test.skip(zcSkip !== null, zcSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-zsl-'))
  seedRealCredentials(dataDir, 'batch-zsl')
  const { app, page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleErrorCapture(page)
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    const port = await waitRealAppReady(page, dataDir, 'batch-zsl')
    await page.screenshot({ path: testInfo.outputPath('zsl-ready.png'), fullPage: true })

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'zsl-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-zsl-shared-lifecycle' },
    }, 'zsl-create')
    const { sid, sub } = await openMainListenWs(port, createReply)
    listen = sub

    const zcBase = zcodeProcessSnapshot()

    // 派发（主 LLM 调 workflow_run 工具；zcode 引擎任务经模板 agent engine 显式指定）
    const argsJson = JSON.stringify({ firstTask: FIRST_TASK, secondTask: SECOND_TASK })
    const prompt =
      `Use the \`workflow_run\` tool with name "${ZC_TEMPLATE}", args ${argsJson}. ` +
      `Pass the args exactly as given (they belong inside args, not at the top level). ` +
      `Do not use any other tool. After the tool returns, reply with only the word DISPATCHED. [zsl-dispatch]`
    const sendReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 'zsl-dispatch',
      payload: { sessionId: sid, content: prompt },
    }, 'zsl-dispatch', 30_000)
    expect(sendReply.type, '派发 prompt 应被接受').not.toBe('error')
    const done = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
    if (!done) {
      writeDiag('batch-zsl-dispatch-turn.json', {
        seen: [...new Set(sub.events.map((e) => String(e.type)))],
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        consoleErrors: consoleCap.errors,
      })
    }
    expect(done, `派发 turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（主 LLM 未调 workflow tool？）`).toBe(true)
    sub.events.length = 0

    // ── V4 断言范围①：r1 在途，zcode 引擎进程出现（懒加载——首个任务触发 spawn） ──
    const up1 = await waitUntil(() => zcodeProcessSnapshot().pids.size > zcBase.pids.size, PROC_TIMEOUT_MS)
    if (!up1) {
      writeDiag('batch-zsl-proc-not-seen.json', {
        zcBase: zcBase.lines,
        now: zcodeProcessSnapshot().lines,
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(up1, 'r1 在途期 zcode 引擎进程应出现（懒加载单例；特征 /engines/zcode/）').toBe(true)
    const pidsR1 = [...zcodeProcessSnapshot().pids].filter((p) => !zcBase.pids.has(p))
    expect(pidsR1.length, 'r1 在途期新增 zcode 引擎进程应恰 1 个').toBe(1)
    const zcPid = pidsR1[0]!
    await page.screenshot({ path: testInfo.outputPath('zsl-r1-inflight.png'), fullPage: true })

    // ── V4 断言范围②：r2 在途（sleep 25 出现），pid 恒同 ──
    const r2InFlight = await waitUntil(
      () => {
        const out = execSync('ps -axo command=', { encoding: 'utf8', timeout: 10_000 })
        const hasSleep25 = out.split('\n').some((l) => l.includes('sleep 25') && !l.includes('playwright'))
        return hasSleep25
      },
      SETTLE_TIMEOUT_MS,
      1_000,
    )
    if (!r2InFlight) {
      // 归因取证：journal 帧型 + zcode 引擎进程现场 + runtime 日志尾
      const agentDir = path.join(dataDir, 'agent')
      writeDiag('batch-zsl-r2-not-seen.json', {
        zcPid,
        zcNow: zcodeProcessSnapshot().lines,
        journals: listFilesRecursive(agentDir, '.events.jsonl').map((f) => ({
          runId: path.basename(f).replace(/\.events\.jsonl$/, ''),
          types: parseJsonlLines(f).entries.map((e) => String(e['type'])),
        })),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(r2InFlight, 'r2 的 sleep 25 应出现（第二条任务在途；diag 见 journal 帧型）').toBe(true)
    const pidsR2 = [...zcodeProcessSnapshot().pids].filter((p) => !zcBase.pids.has(p))
    expect(pidsR2.includes(zcPid), `r2 在途期引擎进程应仍是同一 pid ${zcPid}（双任务同 pid + 任务间不退；实际 ${pidsR2.join(',')}）`).toBe(true)

    // run 收尾（journal completed）
    const agentDir = path.join(dataDir, 'agent')
    const settled = await waitUntil(
      () => listFilesRecursive(agentDir, '.events.jsonl').some((f) =>
        parseJsonlLines(f).entries.some((e) => e['type'] === 'run-settled' && e['outcome'] === 'completed')),
      SETTLE_TIMEOUT_MS,
      2_000,
    )
    if (!settled) {
      writeDiag('batch-zsl-not-completed.json', {
        journals: listFilesRecursive(agentDir, '.events.jsonl').map((f) => parseJsonlLines(f).entries.map((e) => String(e['type']))),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(settled, 'run 应 completed 收尾（两条 zcode 任务均成功）').toBe(true)

    // ── V7 断言范围：app.close() 后 zcode 引擎进程随宿主退出 ──
    await app.close()
    const exited = await waitUntil(() => !zcodeProcessSnapshot().pids.has(zcPid), EXIT_GRACE_MS, 1_000)
    if (!exited) {
      writeDiag('batch-zsl-exit-residue.json', {
        zcPid,
        now: zcodeProcessSnapshot().lines,
      })
    }
    expect(exited, `app 退出后 zcode 引擎进程（pid ${zcPid}）应在 ${EXIT_GRACE_MS}ms 内退出（V7 停机链回归）`).toBe(true)
    listen.ws.close()
    listen = undefined
    console.log(`[batch-zsl] PASS：zcode pid=${zcPid} 双任务恒同；app 退出后引擎进程随退`)
  } finally {
    await cleanupRealTrackApp({ closeListeners: () => listen?.ws.close(), cleanup, dataDir })
  }
})
