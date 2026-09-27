/**
 * BATCH-WL 窗口生命周期（pi-workflow-run-resource-model D3 验收 A1/A3，设计场景 V1/V3）。
 *
 * 场景：双 workflow 并发（long = 2 成员各 sleep 150s；short = 1 成员 sleep 20s，独立
 * session 各自派发）——
 *  - A3/V3 并发窗口隔离：short run 正常收尾（run-settled completed + finalizeRun 窗口
 *    dispose）后，long run 的成员保活进程与引擎宿主薄壳均仍存活（短收尾只 dispose 自己
 *    的窗口实例，不波及并发窗口），且 long 最终以 completed 收口（若短收尾误杀长窗口，
 *    long 成员 ask 失败 → outcome ≠ completed）。
 *  - A1/V1 正常完成后薄壳退出：long run completed 收口后，成员保活进程与引擎宿主薄壳
 *    计数均回落基线（finalizeRun 五步序列末尾窗口 dispose 生效于正常完成路径；abort
 *    路径的同型断言由 batch-s4 承载）。
 *
 * 断言 ground truth = ps 进程表（scripts/count-engine-shell-processes.mjs 特征并集，
 * 基线差分吸收环境常驻与测试进程 cmdline 噪声）+ run journal run-settled 帧
 * （batch-s4/W1 已锚定 journal 介质，本 spec 不重复 journal 结构断言）。
 *
 * 执行侧约定（与 batch-s1/s3/s4 同款）：
 * - 触发：窗口资源模型行为面（engine 窗口实例表 / finalizeRun 收尾链 / 路由）改动时
 *   开发期空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 + 本机 provider 凭证，缺一 skip
 *   不 fail；CI/PR/merge 门禁不跑本轨。
 * - 前置：VITE_E2E=true pnpm run build:e2e（real renderer bundle）。
 * - 预算：600s（长成员 150s sleep + 双派发 turn + 收尾确认）；「第一个 settled =
 *   short」判据由 sleep 硬下界保证（150s vs 20s），LLM 抖动不反转。
 * - 失败归因：writeDiag 落 /tmp/batch-wl-*.json（journal 帧型 + 进程明细 + 日志尾），
 *   禁不归因重试、禁放宽断言换绿灯。
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
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

const MEMBER_SLEEP_LONG_S = 150
const MEMBER_SLEEP_SHORT_S = 20

const taskText = (sleepS: number): string =>
  `First run \`sleep ${sleepS}\` using the bash tool, wait for it to finish, then reply with only the word MEMBER-DONE.`

const DISPATCH_PROMPT_LONG =
  `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagents\` tool ` +
  `(do NOT do the tasks yourself). Both tasks are identical long-running tasks: ` +
  `"${taskText(MEMBER_SLEEP_LONG_S)}" ` +
  `After the tool call returns, reply with only the word DISPATCHED. [BATCH-WL-LONG-7731]`

const DISPATCH_PROMPT_SHORT =
  `Dispatch exactly 1 background subagent task in ONE call using the \`subagents\` tool ` +
  `(do NOT do the task yourself). The task: "${taskText(MEMBER_SLEEP_SHORT_S)}" ` +
  `After the tool call returns, reply with only the word DISPATCHED. [BATCH-WL-SHORT-7732]`

// ── 预算 ────────────────────────────────────────────────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 300_000
const ORPHAN_GRACE_MS = 150_000
/** 短收尾 dispose 完成观察窗：run-settled 帧落 journal 与窗口 dispose 同在收尾链，
 *  留小窗让 dispose 与进程退出可见，再断言长窗口未被波及。 */
const SHORT_TEARDOWN_OBSERVE_MS = 5_000

// ── 凭证门与播种（batch-s4 同款） ────────────────────────────────────────

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
    console.warn(`[batch-wl] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-wl] models.json 不可读：${src}`)
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
    console.warn(`[batch-wl] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-wl] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
}

// ── 诊断与扫描 helpers ──────────────────────────────────────────────────

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[batch-wl] diag → /tmp/${name}`)
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

/** 指定 sleep 秒数的成员保活进程计数（差分锚——特征串含秒数，长短成员互不串扰）。 */
function countMemberSleeperProcesses(sleepS: number): { count: number; lines: string[] } {
  let out = ''
  try {
    out = execSync('ps -axo command=', { encoding: 'utf8', timeout: 10_000 })
  } catch (err) {
    console.warn(`[batch-wl] ps 不可读（进程核对降级为 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
  const marker = `sleep ${sleepS}`
  const lines = out.split('\n').filter((line) =>
    line.includes(marker) && !line.includes('playwright') && !line.includes('Electron.app'),
  )
  return { count: lines.length, lines }
}

/** 引擎宿主薄壳计数（特征并集权威单源 = scripts/count-engine-shell-processes.mjs）。 */
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
    console.warn(`[batch-wl] 引擎宿主计数不可读（降级 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
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

interface RunSettledView { // oe-exempt:20260927:test:e2e 剧本内视图形状声明（DOM mock 类型，非架构契约面）
  runId: string
  outcome: string | undefined
}

function readSettledFrames(journalFile: string): RunSettledView[] {
  return parseJsonlLines(journalFile).entries
    .filter((f) => f['type'] === 'run-settled')
    .map((f) => ({
      runId: path.basename(journalFile).replace(/\.events\.jsonl$/, ''),
      outcome: typeof f['outcome'] === 'string' ? f['outcome'] : undefined,
    }))
}

// ── 主用例 ───────────────────────────────────────────────────────────────

test('WL (batch real): 双 workflow 并发——短收尾不杀长窗口（V3）+ 长正常完成后薄壳回落基线（V1）', async ({ }, testInfo) => {
  test.setTimeout(600_000)

  test.skip(
    process.env['TAIJI_PI_LIVE'] !== '1',
    '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则——开发期按改动面手动触发，CI/门禁不跑）',
  )
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-wl-'))
  seedRealCredentials(dataDir)

  const { page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  const listeners: { ws: { close: () => void }; events: WsFrame[] }[] = []
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.warn('[batch-wl] extensions not ready within timeout, continue anyway')
    await page.screenshot({ path: testInfo.outputPath('wl-app-ready.png'), fullPage: true })

    // ── 双 session 装配（long / short 各自独立 session 并发推进） ──
    const openSession = async (label: string, id: string): Promise<string> => {
      const createReply = await wsRoundTrip(port, {
        type: 'session.create',
        id,
        payload: { cwd: SAMPLE_PROJECT, label },
      }, id)
      expect(createReply.type).toBe('session.created')
      const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
      if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
      const sub = await openListenWs(port, sid)
      listeners.push(sub)
      return sid
    }
    const longSid = await openSession('batch-wl-long', 'wl-create-long')
    const shortSid = await openSession('batch-wl-short', 'wl-create-short')

    // ── 基线（派发前；差分吸收环境常驻薄壳与测试进程 cmdline 噪声） ──
    const baseLong = countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S)
    const baseShort = countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S)
    const shellBaseline = countEngineShellProcesses()
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
      const done = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
      if (!done) {
        writeDiag(`batch-wl-${wsId}-turn.json`, {
          seen: [...new Set(sub.events.map((e) => String(e.type)))],
          runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
          consoleErrors: consoleCap.errors,
        })
      }
      expect(done, `派发 turn（${wsId}）未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成（真实 LLM 未调 subagents 工具？）`).toBe(true)
      sub.events.length = 0
    }
    await dispatch(longSid, DISPATCH_PROMPT_LONG, 'wl-dispatch-long', listeners[0]!)
    await dispatch(shortSid, DISPATCH_PROMPT_SHORT, 'wl-dispatch-short', listeners[1]!)

    // ── journal 恰 2 个 run（双 workflow 在飞） ──
    const agentDir = path.join(dataDir, 'agent')
    const journalsFound = await waitUntil(() => listFilesRecursive(agentDir, '.events.jsonl').length >= 2, JOURNAL_TIMEOUT_MS)
    if (!journalsFound) {
      writeDiag('batch-wl-journals-missing.json', {
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(journalsFound, '双 workflow run journal 应落盘').toBe(true)
    const journalFiles = listFilesRecursive(agentDir, '.events.jsonl')

    // ── 在飞证据：long 两成员 + short 一成员 + 引擎宿主薄壳（每 run 一窗口） ──
    const inFlightLong = await waitUntil(
      () => countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).count - baseLong.count >= 2,
      JOURNAL_TIMEOUT_MS,
    )
    const inFlightShort = countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S).count - baseShort.count >= 1
    const shellInFlight = await waitUntil(
      () => countEngineShellProcesses().count > shellBaseline.count,
      JOURNAL_TIMEOUT_MS,
    )
    if (!inFlightLong || !inFlightShort || !shellInFlight) {
      writeDiag('batch-wl-inflight-missing.json', {
        baseLong: baseLong.lines,
        longNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).lines,
        baseShort: baseShort.lines,
        shortNow: countMemberSleeperProcesses(MEMBER_SLEEP_SHORT_S).lines,
        shellBaseline: shellBaseline.lines,
        shellNow: countEngineShellProcesses().lines,
        hint: '特征不命中——按 count-engine-shell-processes.mjs 头注校准特征集，不删在飞断言',
      })
    }
    expect(inFlightLong, `派发后 long 成员保活进程应 ≥2（差分；diag 见明细）`).toBe(true)
    expect(inFlightShort, `派发后 short 成员保活进程应 ≥1（差分）`).toBe(true)
    expect(shellInFlight, `派发后引擎宿主薄壳应 > 基线（per-window 在飞证据）`).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('wl-in-flight.png'), fullPage: true })

    // ── short 收口（第一个 settled = short：sleep 硬下界 150s vs 20s 保证判据） ──
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
    const longMembersAlive = countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).count - baseLong.count >= 2
    const longShellAlive = countEngineShellProcesses().count > shellBaseline.count
    if (!longMembersAlive || !longShellAlive) {
      writeDiag('batch-wl-long-window-hit.json', {
        shortRunId,
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).lines,
        shellNow: countEngineShellProcesses().lines,
        shellBaseline: shellBaseline.lines,
        journals: journalFiles.map((f) => ({ file: path.basename(f), types: parseJsonlLines(f).entries.map((e) => String(e['type'])) })),
      })
    }
    expect(longMembersAlive, 'short 收尾后 long 成员保活进程应仍 ≥2（并发窗口隔离——短收尾不杀长 run 成员）').toBe(true)
    expect(longShellAlive, 'short 收尾后 long 引擎宿主薄壳应仍 > 基线（短收尾只 dispose 自己的窗口实例）').toBe(true)

    // ── long 收口（completed）+ A1/V1 断言：正常完成后计数回落基线 ──
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
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).lines,
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(longSettledCompleted, `long run 应 completed 收口（若为 failed/partial = 短收尾波及长窗口或成员超预算，见 diag）`).toBe(true)

    const membersBack = await waitUntil(
      () => countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).count <= baseLong.count,
      ORPHAN_GRACE_MS,
      1_000,
    )
    const shellBack = await waitUntil(
      () => countEngineShellProcesses().count <= shellBaseline.count,
      ORPHAN_GRACE_MS,
      1_000,
    )
    if (!membersBack || !shellBack) {
      writeDiag('batch-wl-teardown-residue.json', {
        longMembersNow: countMemberSleeperProcesses(MEMBER_SLEEP_LONG_S).lines,
        shellNow: countEngineShellProcesses().lines,
        shellBaseline: shellBaseline.lines,
      })
    }
    expect(membersBack, `long completed 收口后成员保活进程应回落基线（孤儿窗口 ${ORPHAN_GRACE_MS}ms）`).toBe(true)
    expect(shellBack, `long completed 收口后引擎宿主薄壳应退出（A1/V1 正常完成路径窗口 dispose；残留见 diag）`).toBe(true)

    await page.screenshot({ path: testInfo.outputPath('wl-teardown.png'), fullPage: true })
    if (consoleCap.errors.length > 0) {
      writeDiag('batch-wl-console-errors.json', { errors: consoleCap.errors.slice(-50) })
      console.warn(`[batch-wl] renderer console errors: ${consoleCap.errors.length} 条（diag 已落盘，非断言面）`)
    }
    console.log(`[batch-wl] PASS：shortRunId=${shortRunId} 短收尾未波及长窗口；long completed 收口后成员与薄壳均回落基线`)
  } finally {
    try {
      for (const l of listeners) l.ws.close()
    } finally {
      await cleanup()
      if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }
  }
})
