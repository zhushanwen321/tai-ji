/**
 * BATCH S3 部分失败 + 反向断言（E2E-BATCH-03）—— 坏 agent 路径 partial / message 域边界拒绝 / agents 数量错配 fail-fast。
 *
 * 登记：E2E-BATCH-03（docs/testing/e2e-map.json，R2 按改动面 on-diff，serial 空载串行，
 * L3 真实 LLM）。本 spec 是 2026-09-22 丢失剧本的重建产物（W1 介质归位触发义务）
 * ——落 git 跟踪路径、不落 .tmp；e2e-map assets 产物行的回填归 U6 同 commit。
 *
 * 断言语义来源（两段叠加，以 W1 新介质为准）：
 * - 场景编排 = 原始场景 S3（e2e-map E2E-BATCH-03 note）：坏 agent 路径 partial /
 *   message 拒绝（workflow-origin 域边界拒绝 + list inspect 指引 + 恢复句
 *   "To get these results, re-dispatch via the subagents tool."）/ agents 数量错配 fail-fast。
 * - 持久介质断言 = W1 设计 .tmp/tech-design/w1-run-record-journal-authority.md §4.2 场景 1
 *   （介质归位）+ D7 终态双维度语义：
 *   ① S3a partial：fan-out 脚本返回 status=partial（脚本层失败），但 run 自身正常完成——
 *      journal run-settled outcome=completed（「脚本层失败 = outcome:completed + 脚本返回失败
 *      结论」与「run 自身怎么死的 = outcome:failed」在通知面可区分）；
 *   ② v2 条目每实体两条（registered/settled）且 settled 数 === registered 数
 *      （每注册实体必有终态——W1 D4 恢复语义的静息面）；
 *   ③ S3c fail-fast：journal run-created 后紧跟 run-settled(failed) 且零 ask 帧
 *      （错配在模板入口拦截，不派发任何成员）。
 *
 * 可复用登记声明：本 spec 是 E2E-BATCH-03 的可复用真机资产（后续触碰批量失败面行为时
 * 直接执行本文件，不再重建一次性剧本）。
 *
 * 执行侧约定（与 E2E-BATCH-01 同族）：
 * - 触发：scope diff 命中时开发期按改动面空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 +
 *   本机 provider 凭证（缺一 skip 不 fail）；CI/PR/merge 门禁不跑。
 *   前置：real renderer bundle（VITE_E2E=true pnpm run build:e2e，不带 VITE_MOCK）。
 * - 预算：S3a 600s（真实 LLM：一好一坏双成员）/ S3b 180s（单 turn 拒绝）/ S3c 300s
 *   （fail-fast 快速终局 + 通知落盘）。窗口不足属预算校准，禁止放宽断言换绿灯。
 * - 失败归因：writeDiag 落 /tmp/batch-s3-*.json + console 抓取 + 全页截图 +
 *   <dataDir>/logs/。重试禁令：失败先归因，禁止不归因直接重试。
 *
 * 形态说明：三个子场景共享一个真实 app 实例与同一会话（serial describe——S3b 依赖
 * S3a 产出的 record id；任一失败后续跳过，天然依赖链）。断言 ground truth =
 * 主 session JSONL + journal 文件（磁盘事实）。good agent 为 spec 自建 fixture
 * （mkdtemp 内写 agent .md——只依赖成员引擎的 agent 解析，不依赖本机 agent 清单）。
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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

const MAIN_MARKER = 'BATCH-S3-MAIN-5310'
const BAD_AGENT_PATH = '/nonexistent/broken-agent-5313.md'
/** fan-out.js 入口 fail-fast 的错配文案锚（D9 错误规格）。 */
const MISMATCH_SNIPPET = 'agents must have 1 entry or exactly tasks.length'
/** message 域边界拒绝文案锚（subagent-actions-core.ts，U4 §1.4 D7 域边界）。 */
const REJECT_BOUNDARY_SNIPPET = 'workflow-origin record'
const REJECT_REDIPATCH_SNIPPET = 're-dispatch via the subagents tool'

const GOOD_AGENT_MD = `---
name: s3-fixture-echo-agent
description: Minimal fixture agent for BATCH-S3 e2e (replies with a fixed token)
---

You are a minimal echo agent. Follow the task instruction exactly and keep the reply to one line.
`

// ── 预算 ────────────────────────────────────────────────────────────────
const MAIN_TURN_TIMEOUT_MS = 180_000
const JOURNAL_TIMEOUT_MS = 300_000
const NOTIFY_TIMEOUT_MS = 300_000
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
    console.warn(`[batch-s3] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-s3] models.json 不可读：${src}`)
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
    console.warn(`[batch-s3] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-s3] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
}

// ── 诊断与扫描 helpers ──────────────────────────────────────────────────

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[batch-s3] diag → /tmp/${name}`)
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

/**
 * 会话文件定位：waitUntil sessions 树下出现会话 JSONL 后返回路径。
 * pi 延迟写入语义（首条 assistant 消息 flush 前文件可能不存在）决定只能在
 * 首条消息发出后调用；journal 侧 *.events.jsonl 同以 .jsonl 结尾，排除防误取。
 */
async function locateSessionFile(agentDir: string): Promise<string> {
  const isSessionFile = (f: string): boolean => f.endsWith('.jsonl') && !f.endsWith('.events.jsonl')
  const found = await waitUntil(
    () => listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').some(isSessionFile),
    JSONL_FLUSH_TIMEOUT_MS,
  )
  expect(found, `会话 JSONL 应在首条消息 flush 后落盘（${JSONL_FLUSH_TIMEOUT_MS}ms 窗口）`).toBe(true)
  return listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').find(isSessionFile)!
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

/** 送达标签通道：type=custom_message（pi.sendMessage 落盘形态——权威消费面
 *  collectDeliveredNotifyIds 只认此形态）。与 plain custom entry（type=custom，
 *  data 平铺）是两条落盘通道，customType 同名不能混用 extractor。 */
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

// ── serial 共享态（同 app 同会话：S3b 依赖 S3a 的 record id） ─────────────

const gateSkip = process.env['TAIJI_PI_LIVE'] !== '1' ? '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则）' : realCredentialSkipReason()

let shared: {
  dataDir: string
  fixtureDir: string
  goodAgentPath: string
  port: number
  sid: string
  page: Page
  sessionFile: string
  sub: { ws: { close: () => void }; events: WsFrame[] }
  consoleCap: { all: string[]; errors: string[] }
  cleanup: () => Promise<void>
  /** S3a 产出的首个 record id（S3b message 域边界拒绝的靶点）。 */
  s3aRecordId: string | undefined
} | undefined

test.describe.serial('BATCH-S3 partial / message boundary / agents mismatch', () => {
  test.beforeAll(async ({ }, testInfo) => {
    test.skip(gateSkip !== null, gateSkip ?? '')
    if (gateSkip !== null) return

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s3-'))
    seedRealCredentials(dataDir)
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s3-agents-'))
    const goodAgentPath = path.join(fixtureDir, 's3-echo-agent.md')
    fs.writeFileSync(goodAgentPath, GOOD_AGENT_MD)

    const { page, cleanup } = await launchRealApp({ dataDir })
    const consoleCap = attachConsoleCapture(page)
    await page.waitForLoadState('domcontentloaded')
    await page.screenshot({ path: testInfo.outputPath('s3-app-ready.png'), fullPage: true })

    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    const resolved = await waitForExtensionsReady(dataDir)
    if (resolved === 0) console.warn('[batch-s3] extensions not ready within timeout, continue anyway')

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's3-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-s3-partial-failfast' },
    }, 's3-create')
    expect(createReply.type).toBe('session.created')
    const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
    if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
    const sub = await openListenWs(port, sid)

    // 会话文件不在此处等待：pi 延迟写入语义 = 首条 assistant 消息 flush 前文件可能
    // 不存在，session.create 后裸等必超时——sessionFile 由各用例发首条消息后
    // locateSessionFile 定位（serial 共享同会话，S3a 首次定位后 S3b/S3c 幂等重定位）
    shared = { dataDir, fixtureDir, goodAgentPath, port, sid, page, sessionFile: '', sub, consoleCap, cleanup, s3aRecordId: undefined }
  })

  test.afterAll(async () => {
    if (!shared) return
    try {
      shared.sub.ws.close()
    } finally {
      await shared.cleanup()
      if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
        fs.rmSync(shared.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        fs.rmSync(shared.fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }
  })

  /** 发 prompt → 等主 turn complete（真实 LLM 调工具后收口）。
   *  busy-retry：上一场景的 wf-done 通知（triggerTurn）唤醒的 turn 可能仍在跑，
   *  此时 message.send 的 RPC 回执成功但 pi 层 prompt 失败被静默丢弃（runtime 日志
   *  'Agent is already processing'——r3 实测 S3b 证据，sessionTail 空白佐证）。
   *  判定窗两段式，总判定窗恒为 timeoutMs（自 send 起算，与末尾超时断言口径一致）：
   *  前 BUSY_PROBE_MS 探测窗仅用于 busy 识别——窗内 complete 即返回；窗内出现 busy
   *  拒绝 → settle 后重发；窗内无 complete 且无 busy 拒绝 = prompt 已被接受、turn
   *  健康在途（message.complete 仅在 agent_end 广播——runtime event-adapter.ts
   *  handleAgentEnd，真实 LLM 调工具的 turn 常超探测窗，r6 实测 20.1s 误判证据），
   *  继续等满总判定窗，全预算到期仍无 complete 才落 diag + 超时断言红。 */
  async function sendAndWaitTurn(content: string, tag: string, timeoutMs: number): Promise<void> {
    const s = shared!
    const BUSY_PROBE_MS = 20_000
    const BUSY_SETTLE_MS = 8_000
    const MAX_ATTEMPTS = 4
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const sendId = `${tag}-${attempt}`
      const sendAt = Date.now()
      const logsBefore = readRuntimeLogs(s.dataDir).length
      const sendReply = await wsRoundTrip(s.port, {
        type: 'message.send',
        id: sendId,
        payload: { sessionId: s.sid, content },
      }, sendId, 30_000)
      expect(sendReply.type, `${tag} message.send 应被接受`).not.toBe('error')
      s.sub.events.length = 0
      // 探测窗：仅用于 busy 识别——turn 健康在途时不在此判红
      const probeDone = await waitUntil(
        () => s.sub.events.filter((e) => e.type === 'message.complete').length > 0,
        BUSY_PROBE_MS,
      )
      if (probeDone) return
      const busyRejected = readRuntimeLogs(s.dataDir).slice(logsBefore).includes('Agent is already processing')
      if (busyRejected && attempt < MAX_ATTEMPTS) {
        console.warn(`[batch-s3] ${tag} 撞 busy turn（prompt 被静默丢弃），${BUSY_SETTLE_MS}ms 后重发（${attempt}/${MAX_ATTEMPTS}）`)
        await new Promise((resolve) => setTimeout(resolve, BUSY_SETTLE_MS))
        continue
      }
      // 无 busy 拒绝（或末轮 busy 无重发名额）：prompt 已被接受/预算已尽 → 以剩余总判定窗等待
      const remainMs = Math.max(0, timeoutMs - (Date.now() - sendAt))
      const done = await waitUntil(
        () => s.sub.events.filter((e) => e.type === 'message.complete').length > 0,
        remainMs,
      )
      if (!done) {
        writeDiag(`batch-s3-${tag}-turn.json`, {
          seen: [...new Set(s.sub.events.map((e) => String(e.type)))],
          runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
          busyRejected,
          consoleErrors: s.consoleCap.errors,
        })
        expect(done, `${tag} 主 turn 未在 ${timeoutMs}ms 内 message.complete（查 diag）`).toBe(true)
      }
      return
    }
  }

  test('S3a (batch real): 坏 agent 路径 → partial 收口（脚本层失败 ≠ run 死法）', async ({ }, testInfo) => {
    test.setTimeout(600_000)
    const s = shared!
    const tasks = [
      'Reply with a one-line summary ending with the exact token BATCH-S3A-OK-5311. Do not write any files.',
      'Reply with a one-line summary ending with the exact token BATCH-S3A-BAD-5312. Do not write any files.',
    ]
    const prompt =
      `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagents\` tool. ` +
      `tasks = ${JSON.stringify(tasks)} ` +
      `agents = "${s.goodAgentPath},${BAD_AGENT_PATH}" (one agent per task, same order — the second path is intentionally broken). ` +
      `After the tool call returns, reply with only the word DISPATCHED. [${MAIN_MARKER}]`

    await sendAndWaitTurn(prompt, 's3a-send', MAIN_TURN_TIMEOUT_MS)

    // 会话文件定位（首条消息已发，pi flush 后文件必在——本用例起供 S3b/S3c 共用）
    s.sessionFile = await locateSessionFile(path.join(s.dataDir, 'agent'))

    // journal 出现 → runId
    const agentDir = path.join(s.dataDir, 'agent')
    const journalFound = await waitUntil(() => listFilesRecursive(agentDir, '.events.jsonl').length > 0, JOURNAL_TIMEOUT_MS)
    if (!journalFound) {
      writeDiag('batch-s3a-journal-missing.json', {
        runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
        piLogsTail: readPiLogs(s.dataDir).slice(-3000),
      })
    }
    expect(journalFound, 'run journal 应落盘').toBe(true)
    const journalFile = listFilesRecursive(agentDir, '.events.jsonl')[0]
    const runId = path.basename(journalFile).replace(/\.events\.jsonl$/, '')

    // notifyDone 到达（坏成员也要等全批收口——allSettled 语义）
    const notifyId = `wf-done:${runId}`
    const notifyArrived = await waitUntil(() => fs.readFileSync(s.sessionFile, 'utf8').includes(notifyId), NOTIFY_TIMEOUT_MS)
    if (!notifyArrived) {
      writeDiag('batch-s3a-notify-missing.json', {
        journalEventTypes: readJournalFrames(journalFile).map((f) => f['type']),
        piLogsTail: readPiLogs(s.dataDir).slice(-3000),
      })
    }
    expect(notifyArrived, `notifyDone（${notifyId}）应送达（部分失败也照达——设计 S3）`).toBe(true)
    await s.page.screenshot({ path: testInfo.outputPath('s3a-partial-arrived.png'), fullPage: true })

    // 通知恰 1 条 + Script Result status=partial：一 ok 一 failed（failed 带 error）
    const deliveries = extractCustomMessageEntries(s.sessionFile, 'workflow-result')
    expect(deliveries.length, 'workflow-result 送达 entry 应恰 1 条（custom_message 通道）').toBe(1)
    const content = String(deliveries[0]['content'] ?? '')
    const scriptResultMatch = content.match(/--- Script Result ---\n([\s\S]*?)(\n\n--- Agent Trace ---|$)/)
    expect(scriptResultMatch, '通知 content 应含 Script Result 段').not.toBeNull()
    let scriptResult: { status?: string; results?: { taskIndex?: number; status?: string; error?: string }[] } = {}
    try {
      scriptResult = JSON.parse((scriptResultMatch![1] || '').trim()) as typeof scriptResult
    } catch {
      writeDiag('batch-s3a-script-result-unparsable.json', { contentHead: content.slice(0, 2000) })
      throw new Error('Script Result 段应为合法 JSON')
    }
    expect(scriptResult.status, `批收口 status 应为 partial（收到 "${String(scriptResult.status)}"）`).toBe('partial')
    const okEntries = (scriptResult.results ?? []).filter((r) => r.status === 'ok')
    const failedEntries = (scriptResult.results ?? []).filter((r) => r.status === 'failed')
    expect(okEntries.length, '应恰 1 条 ok（good agent 成员）').toBe(1)
    expect(failedEntries.length, '应恰 1 条 failed（坏 agent 路径成员）').toBe(1)
    expect(failedEntries[0]?.error, 'failed 条目应带 error 字段（失败归因）').toBeTruthy()

    // W1 介质锚：journal run-settled outcome=completed（脚本层失败 ≠ run 死法——D7 终态双维度）
    const frames = readJournalFrames(journalFile)
    const settledFrames = frames.filter((f) => f['type'] === 'run-settled')
    expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
    expect(settledFrames[0]?.['outcome'], 'partial 收口的 run outcome 应为 completed（run 正常跑完，失败在脚本层结论）').toBe('completed')

    // v2 条目：settled 数 === registered 数（每注册实体必有终态）+ record id 留给 S3b
    const saRegistered = extractCustomEntries(s.sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
    const saSettled = extractCustomEntries(s.sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(saRegistered.length, 'subagent-record v2 registered 应 ≥1（good 成员注册）').toBeGreaterThanOrEqual(1)
    expect(saSettled.length, 'subagent-record v2 settled 数应 === registered 数（W1 D4：每注册实体必有终态）').toBe(saRegistered.length)
    const wfSettled = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(wfSettled.length, 'workflow-record v2 settled 应恰 1').toBe(1)
    expect(wfSettled[0]['outcome'], 'workflow-record settled 条目 outcome 应与 journal 一致（journal 唯一事实源投影面）').toBe('completed')
    s.s3aRecordId = typeof saRegistered[0]?.['id'] === 'string' ? saRegistered[0]['id'] as string : undefined
    console.log(`[batch-s3a] PASS：runId=${runId} partial 收口，recordId=${s.s3aRecordId}`)
  })

  test('S3b (batch real): message 域边界拒绝——workflow-origin record 不进 message 通道', async ({ }, testInfo) => {
    test.setTimeout(180_000)
    const s = shared!
    test.skip(s.s3aRecordId === undefined, 'S3a 未产出 record id（前置失败则本用例跳过）')
    const recordId = s.s3aRecordId!

    // prompt 遵从 flake 对策（r4 绿 / r5 红 + sessionTail 空白 = LLM 未调工具直接
    // 文字回复——spec 头部「失败归因」点名的已知形态）：第一轮未命中拒绝文案时，
    // 强化指令重发一轮（归因明确后的单次重试）；仍失败落 diag 红。
    const basePrompt =
      `Use the \`message\` tool to send the text "ping" to the subagent with id "${recordId}". ` +
      `Then reply with the exact tool output verbatim. Do not use any other tool.`
    const retryPrompt =
      `You did not call the \`message\` tool in your previous turn. Call it NOW with ` +
      `to="${recordId}" and text="ping". This is a tool-calling test: you MUST invoke the ` +
      `\`message\` tool before replying. Do not summarize, do not simulate the result.`
    let rejectArrived = false
    for (let round = 1; round <= 2 && !rejectArrived; round += 1) {
      const offsetBefore = fs.statSync(s.sessionFile).size
      await sendAndWaitTurn(round === 1 ? basePrompt : retryPrompt, `s3b-send-r${round}`, MAIN_TURN_TIMEOUT_MS)
      s.sessionFile = await locateSessionFile(path.join(s.dataDir, 'agent'))
      rejectArrived = await waitUntil(
        () => {
          const text = fs.readFileSync(s.sessionFile, 'utf8')
          return text.length > offsetBefore && text.slice(offsetBefore).includes(REJECT_BOUNDARY_SNIPPET)
        },
        round === 1 ? JSONL_FLUSH_TIMEOUT_MS : JSONL_FLUSH_TIMEOUT_MS * 2,
      )
      if (!rejectArrived && round === 1) {
        console.warn('[batch-s3b] 第一轮未见拒绝文案（LLM 未调 message 工具的遵从 flake），强化指令重发一轮')
      }
    }
    if (!rejectArrived) {
      writeDiag('batch-s3b-reject-missing.json', {
        sessionTail: fs.readFileSync(s.sessionFile, 'utf8').slice(-3000),
        runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
      })
    }
    expect(rejectArrived, `message 工具结果应含域边界拒绝文案 "${REJECT_BOUNDARY_SNIPPET}"（workflow-origin record 不进 message 通道）`).toBe(true)
    const sessionTextAll = fs.readFileSync(s.sessionFile, 'utf8')
    expect(sessionTextAll.includes(REJECT_REDIPATCH_SNIPPET), '拒绝文案应含恢复指引 "re-dispatch via the subagents tool"').toBe(true)
    await s.page.screenshot({ path: testInfo.outputPath('s3b-rejected.png'), fullPage: true })
    console.log('[batch-s3b] PASS：message 域边界拒绝')
  })

  test('S3c (batch real): agents 数量错配 → 模板入口 fail-fast（零 ask 帧 + 通知照达）', async ({ }, testInfo) => {
    test.setTimeout(300_000)
    const s = shared!
    const tasks = [
      'Reply with a one-line summary ending with the exact token BATCH-S3C-1-5314.',
      'Reply with a one-line summary ending with the exact token BATCH-S3C-2-5315.',
    ]
    const prompt =
      `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagents\` tool. ` +
      `tasks = ${JSON.stringify(tasks)} ` +
      `agents = "/nonexistent/x1.md,/nonexistent/x2.md,/nonexistent/x3.md" ` +
      `(3 agent entries for 2 tasks — this mismatch is INTENTIONAL, do not fix it). ` +
      `After the tool call returns, reply with only the word DISPATCHED.`

    const journalsBefore = listFilesRecursive(path.join(s.dataDir, 'agent'), '.events.jsonl').length
    await sendAndWaitTurn(prompt, 's3c-send', MAIN_TURN_TIMEOUT_MS)

    // 会话文件幂等重定位（同会话同文件；S3c 的 notify/v2 条目断言读它）
    s.sessionFile = await locateSessionFile(path.join(s.dataDir, 'agent'))

    const agentDir = path.join(s.dataDir, 'agent')
    const newJournalFound = await waitUntil(
      () => listFilesRecursive(agentDir, '.events.jsonl').length > journalsBefore,
      JOURNAL_TIMEOUT_MS,
    )
    if (!newJournalFound) {
      writeDiag('batch-s3c-journal-missing.json', { runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000) })
    }
    expect(newJournalFound, '错配批的 run journal 应落盘（run-created 先于模板入口校验）').toBe(true)
    const journals = listFilesRecursive(agentDir, '.events.jsonl')
    const journalFile = journals[journals.length - 1]
    const runId = path.basename(journalFile).replace(/\.events\.jsonl$/, '')

    const notifyId = `wf-done:${runId}`
    const notifyArrived = await waitUntil(() => fs.readFileSync(s.sessionFile, 'utf8').includes(notifyId), NOTIFY_TIMEOUT_MS)
    if (!notifyArrived) {
      writeDiag('batch-s3c-notify-missing.json', {
        journalEventTypes: readJournalFrames(journalFile).map((f) => f['type']),
        piLogsTail: readPiLogs(s.dataDir).slice(-3000),
      })
    }
    expect(notifyArrived, `fail-fast 终局通知也应照达（${notifyId}）——通知链不因错配丢失`).toBe(true)

    // journal：run-created + run-settled(failed)，零 ask 帧（错配在派发前拦截）
    const frames = readJournalFrames(journalFile)
    expect(frames[0]?.['type'], 'journal 首帧应为 run-created').toBe('run-created')
    const askFrames = frames.filter((f) => String(f['type']).startsWith('ask-'))
    expect(askFrames.length, '错配 fail-fast 的 journal 应零 ask 帧（不派发任何成员）').toBe(0)
    const settledFrames = frames.filter((f) => f['type'] === 'run-settled')
    expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
    expect(settledFrames[0]?.['outcome'], '数量错配的 run outcome 应为 failed（invalid_args → failed 映射）').toBe('failed')

    // 错配文案证据（fail-fast 带纠正指引）：通知 content / 主 session JSONL /
    // journal run-settled.reason 任一落点（r4 实测纠正指引全文落 journal reason，
    // 通知 content 的 Script Result 段仅含 status 摘要——三落点并查）
    const deliveries = extractCustomMessageEntries(s.sessionFile, 'workflow-result')
    const lastDelivery = deliveries[deliveries.length - 1]
    const notifyContent = String(lastDelivery?.['content'] ?? '')
    const sessionText = fs.readFileSync(s.sessionFile, 'utf8')
    const journalReason = String(settledFrames[0]?.['reason'] ?? '')
    const mismatchEvidence =
      notifyContent.includes(MISMATCH_SNIPPET) ||
      sessionText.includes(MISMATCH_SNIPPET) ||
      journalReason.includes(MISMATCH_SNIPPET)
    if (!mismatchEvidence) {
      writeDiag('batch-s3c-mismatch-snippet-missing.json', {
        notifyContentHead: notifyContent.slice(0, 2000),
        journalSettled: settledFrames[0],
      })
    }
    expect(mismatchEvidence, `fail-fast 证据应含错配文案 "${MISMATCH_SNIPPET}"（纠正指引随通知/会话/journal reason 落盘）`).toBe(true)

    // v2 条目照写（fail-fast run 也有注册 + 终态两条）
    const wfRegisteredAll = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
    const wfSettledAll = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(wfRegisteredAll.length, '两轮批后 workflow-record registered 条目应恰 2（S3a + S3c）').toBe(2)
    expect(wfSettledAll.length, '两轮批后 workflow-record settled 条目应恰 2（fail-fast 也写终态条目）').toBe(2)
    const s3cSettled = wfSettledAll.find((d) => d['runId'] === runId)
    expect(s3cSettled, 'S3c run 的 settled 条目应存在').toBeDefined()
    expect(s3cSettled?.['outcome'], 'S3c settled 条目 outcome 应为 failed（与 journal 一致）').toBe('failed')

    await s.page.screenshot({ path: testInfo.outputPath('s3c-failfast.png'), fullPage: true })
    console.log(`[batch-s3c] PASS：runId=${runId} fail-fast 零 ask 帧收口`)
  })
})
