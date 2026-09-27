/**
 * BATCH-ZSL zcode shared-service 生命周期（pi-workflow-run-resource-model D3 验收
 * A4/A7，场景 V4/V7）。
 *
 * 单场景两断言面（一条 run 承载）：
 *  - A4/V4 zcode 懒加载单例不变：自定义模板两条 agent()（engine:"zcode"，不同名，
 *    各跑一段 bash sleep）顺序执行——两任务在飞期的 zcode 引擎进程（wrapper 落盘
 *    `<engineDataDir>/engines/zcode/` 特征）pid 恒同（双任务同 pid + 任务间不退）。
 *    「现状行为即通过标准」：改造未动 zcode spawn 形态（shared-service 透传 registry
 *    保形），本轨 = manifest 显式声明后的路由保形回归。
 *  - A7/V7 taiji 退出杀引擎进程：app.close() 后 zcode 引擎进程随宿主退出（宽限窗内
 *    pid 消失——stdin EOF 自灭链/停机收割）。pi 薄壳的收尾回落已由
 *    batch-window-lifecycle（A1）/ batch-s4（A2）覆盖，本轨只验 zcode 面。
 *
 * 断言 ground truth = ps 进程表（/engines/zcode/ 特征，基线差分吸收环境常驻；
 * wrapper 进程 argv = node <engineDataDir>/engines/zcode/zcode-launcher.cjs，
 * 同进程 import zcode.cjs——app-server 即该 pid）。执行侧约定与
 * batch-window-lifecycle.spec.ts 同款。
 *
 * 凭据：zcode 引擎共享宿主 HOME（spawn 不覆写），本机 ~/.zcode 凭据直接可用；
 * 缺失时任务失败归 run failed，skip 门只做 config.json 存在性宽松检查。
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
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
const ZC_TEMPLATE = path.join(REPO_ROOT, 'e2e', 'fixtures', 'wl-zcode-two.js')

const FIRST_TASK = `[WL-ZC-R1-9911] First run \`sleep 15\` using the bash tool, wait for it to finish, then reply with a one-word summary.`
const SECOND_TASK = `[WL-ZC-R2-9912] First run \`sleep 25\` using the bash tool, wait for it to finish, then reply with a one-word summary.`

const MAIN_TURN_TIMEOUT_MS = 180_000
const PROC_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 300_000
/** 退出宽限：app.close() 后引擎进程（stdin EOF 自灭 / 停机收割）退出窗。 */
const EXIT_GRACE_MS = 30_000

// ── 凭证门与播种 / 诊断 helpers（batch-window-lifecycle 同款） ─────────────

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
    console.warn(`[batch-zsl] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-zsl] models.json 不可读：${src}`)
  }
  return `${src} 的 auth.json / models.json 均无非空 key（本机 provider 凭证缺失）`
}

function zcodeCredentialSkipReason(): string | null {
  const cliConfig = path.join(os.homedir(), '.zcode', 'cli', 'config.json')
  if (fs.existsSync(cliConfig)) return null
  return `${cliConfig} 不存在（本机 zcode CLI 凭据缺失，zcode 引擎任务无法执行）`
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
    console.warn(`[batch-zsl] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-zsl] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
}

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[batch-zsl] diag → /tmp/${name}`)
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

function attachConsoleCapture(page: Page): { errors: string[] } {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`[pageerror] ${String(err)}`))
  return { errors }
}

test('ZSL (batch real): zcode 双任务同 pid（V4 懒加载单例回归）+ taiji 退出引擎进程随退（V7）', async ({ }, testInfo) => {
  test.setTimeout(600_000)
  test.skip(process.env['TAIJI_PI_LIVE'] !== '1', '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行')
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')
  const zcSkip = zcodeCredentialSkipReason()
  test.skip(zcSkip !== null, zcSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-zsl-'))
  seedRealCredentials(dataDir)
  const { app, page, cleanup } = await launchRealApp({ dataDir })
  const consoleCap = attachConsoleCapture(page)
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    await waitForExtensionsReady(dataDir)
    await page.screenshot({ path: testInfo.outputPath('zsl-ready.png'), fullPage: true })

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'zsl-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-zsl-shared-lifecycle' },
    }, 'zsl-create')
    expect(createReply.type).toBe('session.created')
    const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
    if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
    const sub = await openListenWs(port, sid)
    listen = sub

    const zcBase = zcodeProcessSnapshot()

    // 派发（主 LLM 调 workflow tool run action；zcode 引擎任务经模板 agent engine 显式指定）
    const argsJson = JSON.stringify({ firstTask: FIRST_TASK, secondTask: SECOND_TASK })
    const prompt =
      `Use the \`workflow\` tool with action "run", name "${ZC_TEMPLATE}", args ${argsJson}. ` +
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

    // ── V4 断言面①：r1 在飞，zcode 引擎进程出现（懒加载——首个任务触发 spawn） ──
    const up1 = await waitUntil(() => zcodeProcessSnapshot().pids.size > zcBase.pids.size, PROC_TIMEOUT_MS)
    if (!up1) {
      writeDiag('batch-zsl-proc-not-seen.json', {
        zcBase: zcBase.lines,
        now: zcodeProcessSnapshot().lines,
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(up1, 'r1 在飞期 zcode 引擎进程应出现（懒加载单例；特征 /engines/zcode/）').toBe(true)
    const pidsR1 = [...zcodeProcessSnapshot().pids].filter((p) => !zcBase.pids.has(p))
    expect(pidsR1.length, 'r1 在飞期新增 zcode 引擎进程应恰 1 个').toBe(1)
    const zcPid = pidsR1[0]!
    await page.screenshot({ path: testInfo.outputPath('zsl-r1-inflight.png'), fullPage: true })

    // ── V4 断言面②：r2 在飞（sleep 25 出现），pid 恒同 ──
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
    expect(r2InFlight, 'r2 的 sleep 25 应出现（第二条任务在飞；diag 见 journal 帧型）').toBe(true)
    const pidsR2 = [...zcodeProcessSnapshot().pids].filter((p) => !zcBase.pids.has(p))
    expect(pidsR2.includes(zcPid), `r2 在飞期引擎进程应仍是同一 pid ${zcPid}（双任务同 pid + 任务间不退；实际 ${pidsR2.join(',')}）`).toBe(true)

    // run 收口（journal completed）
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
    expect(settled, 'run 应 completed 收口（两条 zcode 任务均成功）').toBe(true)

    // ── V7 断言面：app.close() 后 zcode 引擎进程随宿主退出 ──
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
