/**
 * BATCH S3 部分失败 + 反向断言（E2E-BATCH-03）—— 坏 agent 路径 partial / subagent_message 域边界拒绝 / 非法成员 agent 工具入口拒绝。
 *
 * 登记：E2E-BATCH-03（docs/testing/e2e-map.json，R2 按改动范围 on-diff，serial 空载串行，
 * L3 真实 LLM）。本 spec 是 2026-09-22 丢失剧本的重建产物（W1 介质归位触发义务）
 * ——落 git 跟踪路径、不落 .tmp；e2e-map assets 产物行的回填归 U6 同 commit。
 *
 * 断言语义来源（两段叠加，以 W1 新介质为准）：
 * - 场景编排 = 原始场景 S3（e2e-map E2E-BATCH-03 note）：坏 agent 路径 partial /
 *   subagent_message 拒绝（workflow-origin 域边界拒绝 + list inspect 指引 + 恢复句
 *   "To get these results, re-dispatch via the subagent_batch tool."）/ 非法成员 agent 入口拒绝
 *   （subagent-tool-interface-refactor §4.3：S3c 随 `agents` 参数删除退役，改测成员对象
 *   非法 agent——非 `^/` 绝对路径——在 subagent_batch 工具入口被拒）。
 * - 持久介质断言 = W1 设计（w1-run-record-journal-authority，历史设计档案已随 .tmp 清理，git 可追溯）§4.2 场景 1
 *   （介质归位）+ D7 终态双维度语义：
 *   ① S3a partial：fan-out 脚本返回 status=partial（脚本层失败），run 终局由成员交付
 *      债结算集合派生——journal run-settled outcome=partially_succeeded + failedMembers
 *      （subagent-observability §3.3.8：存在失败且存在非失败成员 → 第五值，失败成员
 *      cause 点拼 "<class>.<kind>"；成员失败传导 run 终局，不折进 completed 吞失败）；
 *   ② v2 条目每实体两条（registered/settled）且 settled 数 === registered 数
 *      （每注册实体必有终态——W1 D4 恢复语义的静息面）；
 *   ③ S3c 入口拒绝：非法成员 agent 在 subagent_batch 工具入口被拒——零 run journal
 *      （拒绝先于 run 创建，早于旧 `agents` 错配的模板入口 fail-fast 层级）、零成员派发。
 *
 * 可复用登记声明：本 spec 是 E2E-BATCH-03 的可复用真机资产（后续触碰批量失败行为时
 * 直接执行本文件，不再重建一次性剧本）。
 *
 * 执行侧约定（与 E2E-BATCH-01 同族）：
 * - 触发：scope diff 命中时开发期按改动范围空载串行执行；双凭证门 = TAIJI_PI_LIVE=1 +
 *   本机 provider 凭证（缺一 skip 不 fail）；CI/PR/merge 门禁不跑。
 *   前置：real renderer bundle（VITE_E2E=true pnpm run build:e2e，不带 VITE_MOCK）。
 * - 预算：S3a 600s（真实 LLM：一好一坏双成员）/ S3b 180s（单 turn 拒绝）/ S3c 300s
 *   （工具入口拒绝快终局 + 调用证据落盘）。窗口不足属预算校准，禁止放宽断言换绿灯。
 * - 失败归因：writeDiag 落 testInfo.outputPath（batch-s3-*.json，不落 /tmp——诊断载荷
 *   可含 session entry 正文，/tmp 非其合法落盘位置，ADR-0063 I2）+ console 抓取 +
 *   全页截图 + <dataDir>/logs/。重试禁令：失败先归因，禁止不归因直接重试。
 *
 * 形态说明：三个子场景共享一个真实 app 实例与同一会话（serial describe——S3b 依赖
 * S3a 产出的 record id；任一失败后续跳过，天然依赖链）。断言原始证据文档 =
 * 主 session JSONL + journal 文件（磁盘事实）。good agent 为 spec 自建 fixture
 * （mkdtemp 内写 agent .md——只依赖成员引擎的 agent 解析，不依赖本机 agent 清单）。
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
  assertSingleRunSettled,
  attachConsoleCapture,
  extractCustomEntries,
  extractCustomMessageEntries,
  listFilesRecursive,
  openMainListenWs,
  readJournalFrames,
  realCredentialSkipReason,
  SAMPLE_PROJECT,
  seedRealCredentials,
  testInfoDiag,
  waitForRunJournal,
  waitRealAppReady,
  waitUntil,
} from './fixtures/batch-real-helpers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAIN_MARKER = 'BATCH-S3-MAIN-5310'
const BAD_AGENT_PATH = '/nonexistent/broken-agent-5313.md'
/** S3c 非法成员 agent（非 `^/` 绝对路径——相对路径在 subagent_batch 工具入口被拒，
 *  subagent-tool-interface-refactor §3.1.2 成员对象 agent pattern）。 */
const INVALID_MEMBER_AGENT_PATH = 'relative-agent-5316.md'
/** S3c 入口拒绝后的复核静默窗（主 turn complete 已意味着工具调用被拒且模型收到
 *  错误；小窗只防 journal 落盘与 turn 结束的残余时序差）。 */
const NO_RUN_SETTLE_MS = 3_000
/** message 域边界拒绝文案锚（subagent-actions-core.ts，U4 §1.4 D7 域边界）。 */
const REJECT_BOUNDARY_SNIPPET = 'workflow-origin record'
const REJECT_REDIPATCH_SNIPPET = 're-dispatch via the subagent_batch tool'

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

// ── 凭证门与播种 / 诊断与扫描 helpers（共享实现 = fixtures/batch-real-helpers.ts；
//    本文件只留 tag 绑定与 s3 特有的会话定位变体） ─────────────────────────────

const writeDiag = testInfoDiag('batch-s3')

/**
 * 会话文件定位：waitUntil sessions 树下出现会话 JSONL 后返回路径。
 * pi 延迟写入语义（首条 assistant 消息 flush 前文件可能不存在）决定只能在
 * 首条消息发出后调用；run journal（<runId>.record.jsonl，现行后缀——f92d931ba 起；
 * .events.jsonl 为改名前 legacy）同以 .jsonl 结尾，排除防误取。
 */
async function locateSessionFile(agentDir: string): Promise<string> {
  const isSessionFile = (f: string): boolean =>
    f.endsWith('.jsonl') && !f.endsWith('.events.jsonl') && !f.endsWith('.record.jsonl')
  const found = await waitUntil(
    () => listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').some(isSessionFile),
    JSONL_FLUSH_TIMEOUT_MS,
  )
  expect(found, `会话 JSONL 应在首条消息 flush 后落盘（${JSONL_FLUSH_TIMEOUT_MS}ms 窗口）`).toBe(true)
  return listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').find(isSessionFile)!
}

// ── serial 共享态（同 app 同会话：S3b 依赖 S3a 的 record id） ─────────────

const gateSkip = process.env['TAIJI_PI_LIVE'] !== '1' ? '真实 LLM 层门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则）' : realCredentialSkipReason('batch-s3')

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

test.describe.serial('BATCH-S3 partial / message boundary / invalid member agent entry rejection', () => {
  test.beforeAll(async ({ }, testInfo) => {
    test.skip(gateSkip !== null, gateSkip ?? '')
    if (gateSkip !== null) return

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s3-'))
    seedRealCredentials(dataDir, 'batch-s3')
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-s3-agents-'))
    const goodAgentPath = path.join(fixtureDir, 's3-echo-agent.md')
    fs.writeFileSync(goodAgentPath, GOOD_AGENT_MD)

    const { page, cleanup } = await launchRealApp({ dataDir })
    const consoleCap = attachConsoleCapture(page)
    await page.waitForLoadState('domcontentloaded')
    await page.screenshot({ path: testInfo.outputPath('s3-app-ready.png'), fullPage: true })

    const port = await waitRealAppReady(page, dataDir, 'batch-s3')

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 's3-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-s3-partial-failfast' },
    }, 's3-create')
    const { sid, sub } = await openMainListenWs(port, createReply)

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

  /** 发 prompt → 等主 turn complete（真实 LLM 调工具后收尾）。
   *  busy-retry：上一场景的 wf-done 通知（triggerTurn）唤醒的 turn 可能仍在跑，
   *  此时 message.send 的 RPC 回执成功但 pi 层 prompt 失败被静默丢弃（runtime 日志
   *  'Agent is already processing'——r3 实测 S3b 证据，sessionTail 空白佐证）。
   *  判定窗两段式，总判定窗恒为 timeoutMs（自 send 起算，与末尾超时断言口径一致）：
   *  前 BUSY_PROBE_MS 探测窗仅用于 busy 识别——窗内 complete 即返回；窗内出现 busy
   *  拒绝 → settle 后重发；窗内无 complete 且无 busy 拒绝 = prompt 已被接受、turn
   *  健康在途（message.complete 仅在 agent_end 广播——runtime event-adapter.ts
   *  handleAgentEnd，真实 LLM 调工具的 turn 常超探测窗，r6 实测 20.1s 误判证据），
   *  继续等满总判定窗，全预算到期仍无 complete 才落 diag + 超时断言红。 */
  async function sendAndWaitTurn(testInfo: TestInfo, content: string, tag: string, timeoutMs: number): Promise<void> {
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
        writeDiag(testInfo, `batch-s3-${tag}-turn.json`, {
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

  test('S3a (batch real): 坏 agent 路径 → partial 收尾（成员失败传导 run 终局——partially_succeeded + failedMembers）', async ({ }, testInfo) => {
    test.setTimeout(600_000)
    const s = shared!
    // 成员对象形状（§3.1.2 终态）：好坏双 agent 改为各成员对象的 agent 字段
    // （旧 `agents` 逗号串参数已随成员对象 schema 退役）。
    const tasks = [
      {
        task: 'Reply with a one-line summary ending with the exact token BATCH-S3A-OK-5311. Do not write any files.',
        agent: s.goodAgentPath,
      },
      {
        task: 'Reply with a one-line summary ending with the exact token BATCH-S3A-BAD-5312. Do not write any files.',
        agent: BAD_AGENT_PATH,
      },
    ]
    const prompt =
      `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagent_batch\` tool. ` +
      `tasks = ${JSON.stringify(tasks)} ` +
      `(each member object carries its own "agent" field, in dispatch order — the second path is intentionally broken; do not fix it). ` +
      `After the tool call returns, reply with only the word DISPATCHED. [${MAIN_MARKER}]`

    await sendAndWaitTurn(testInfo, prompt, 's3a-send', MAIN_TURN_TIMEOUT_MS)

    // 会话文件定位（首条消息已发，pi flush 后文件必在——本用例起供 S3b/S3c 共用）
    s.sessionFile = await locateSessionFile(path.join(s.dataDir, 'agent'))

    // journal 出现 → runId（journal 后缀 .record.jsonl，run-vocabulary RUN_EVENTS_SUFFIX）
    const agentDir = path.join(s.dataDir, 'agent')
    const journalFile = await waitForRunJournal({
      agentDir,
      dataDir: s.dataDir,
      timeoutMs: JOURNAL_TIMEOUT_MS,
      foundMessage: 'run journal 应落盘',
      diag: (name, data) => writeDiag(testInfo, name, data),
      diagName: 'batch-s3a-journal-missing.json',
    })
    const runId = path.basename(journalFile).replace(/\.record\.jsonl$/, '')

    // notifyDone 到达（坏成员也要等全批收尾——allSettled 语义）
    const notifyId = `wf-done:${runId}`
    const notifyArrived = await waitUntil(() => fs.readFileSync(s.sessionFile, 'utf8').includes(notifyId), NOTIFY_TIMEOUT_MS)
    if (!notifyArrived) {
      writeDiag(testInfo, 'batch-s3a-notify-missing.json', {
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
      writeDiag(testInfo, 'batch-s3a-script-result-unparsable.json', { contentHead: content.slice(0, 2000) })
      throw new Error('Script Result 段应为合法 JSON')
    }
    expect(scriptResult.status, `批收尾 status 应为 partial（收到 "${String(scriptResult.status)}"）`).toBe('partial')
    const okEntries = (scriptResult.results ?? []).filter((r) => r.status === 'ok')
    const failedEntries = (scriptResult.results ?? []).filter((r) => r.status === 'failed')
    expect(okEntries.length, '应恰 1 条 ok（good agent 成员）').toBe(1)
    expect(failedEntries.length, '应恰 1 条 failed（坏 agent 路径成员）').toBe(1)
    expect(failedEntries[0]?.error, 'failed 条目应带 error 字段（失败归因）').toBeTruthy()

    // W1 介质锚：journal run-settled outcome=partially_succeeded + failedMembers 明细
    //（subagent-observability §3.3.8：run 级 outcome 从成员交付债结算集合派生——
    // 存在失败且存在非失败成员 → partially_succeeded，失败成员进 failedMembers[].cause
    // 点拼（"<class>.<kind>"），脚本层吞失败不再把 run 终局升格为 completed）
    const settledFrame = assertSingleRunSettled(
      readJournalFrames(journalFile),
      'partially_succeeded',
      'partial 收尾的 run outcome 应为 partially_succeeded（成员失败传导 run 终局——§3.3.8 聚合派生）',
    )
    const failedMembers = settledFrame['failedMembers'] as { taskIndex?: number; cause?: string }[] | undefined
    expect(Array.isArray(failedMembers), 'run-settled 帧应携带 failedMembers 数组（失败成员交付结算明细）').toBe(true)
    expect(failedMembers?.length, 'failedMembers 应恰 1 条（坏 agent 路径成员）').toBe(1)
    expect(failedMembers?.[0]?.taskIndex, '失败成员 taskIndex 应为 1（派发序第二个成员 = 坏 agent 路径）').toBe(1)
    // cause 点拼结构断言（现行实装 memberFailureCauseOf）：failure 在场 = 受控词表
    // "<class>.<kind>"；failure 缺席回落 = "engine.<error 冒号前段>"——坏 agent 路径
    // 场景成员无 FailureCause，cause 前缀恒 engine.（尾段为 error 首段文本，非受控词表）
    expect(
      typeof failedMembers?.[0]?.cause === 'string' && /^engine\..+/.test(failedMembers[0].cause),
      `失败成员 cause 应为点拼形态（"engine." 前缀 + 非空尾段；实际：${String(failedMembers?.[0]?.cause)}）`,
    ).toBe(true)

    // v2 条目：settled 数 === registered 数（每注册实体必有终态）+ record id 留给 S3b
    const saRegistered = extractCustomEntries(s.sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
    const saSettled = extractCustomEntries(s.sessionFile, 'subagent-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(saRegistered.length, 'subagent-record v2 registered 应 ≥1（good 成员注册）').toBeGreaterThanOrEqual(1)
    expect(saSettled.length, 'subagent-record v2 settled 数应 === registered 数（W1 D4：每注册实体必有终态）').toBe(saRegistered.length)
    const wfSettled = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(wfSettled.length, 'workflow-record v2 settled 应恰 1').toBe(1)
    expect(wfSettled[0]['outcome'], 'workflow-record settled 条目 outcome 应与 journal 一致（journal 唯一事实源派生视图）').toBe('partially_succeeded')
    s.s3aRecordId = typeof saRegistered[0]?.['id'] === 'string' ? saRegistered[0]['id'] as string : undefined
    console.log(`[batch-s3a] PASS：runId=${runId} partial 收尾，recordId=${s.s3aRecordId}`)
  })

  test('S3b (batch real): message 域边界拒绝——workflow-origin record 不进 message 通道', async ({ }, testInfo) => {
    test.setTimeout(180_000)
    const s = shared!
    test.skip(s.s3aRecordId === undefined, 'S3a 未产出 record id（前置失败则本用例跳过）')
    const recordId = s.s3aRecordId!

    // prompt 遵从 flake 对策（r4 绿 / r5 红 + sessionTail 空白 = LLM 未调工具直接
    // 文字回复——spec 头部「失败归因」点名的已知形态）：第一轮未命中拒绝文案时，
    // 强化指令重发一轮（归因明确后的单次重试）；仍失败落 diag 红。
    // 工具名 `subagent_message`（D3 拆分新名——旧 `message` 工具已退役）。
    const basePrompt =
      `Use the \`subagent_message\` tool to send the text "ping" to the subagent with id "${recordId}". ` +
      `Then reply with the exact tool output verbatim. Do not use any other tool.`
    const retryPrompt =
      `You did not call the \`subagent_message\` tool in your previous turn. Call it NOW with ` +
      `subagentId="${recordId}" and text="ping". This is a tool-calling test: you MUST invoke the ` +
      `\`subagent_message\` tool before replying. Do not summarize, do not simulate the result.`
    let rejectArrived = false
    for (let round = 1; round <= 2 && !rejectArrived; round += 1) {
      await sendAndWaitTurn(testInfo, round === 1 ? basePrompt : retryPrompt, `s3b-send-r${round}`, MAIN_TURN_TIMEOUT_MS)
      s.sessionFile = await locateSessionFile(path.join(s.dataDir, 'agent'))
      rejectArrived = await waitUntil(
        () => {
          // 结构锚定 = 全文件含域边界拒绝文案（拒绝 toolResult 的 isError 帧落盘）。
          // 不用「发送前 offset 增量窗口」判定：S3b 上下文逼近 compaction 阈值时
          // session 文件可能被重写轮转（size 骤减），offsetBefore 恒大于文件长度
          // → slice 后恒空、判定永假——2026-10-25 真机实测拒绝 toolResult 已在盘
          // 而判定未命中即此形态。全文件扫描无误判面：进入下一轮的前提 = 前轮
          // 未产生拒绝文案（第一轮失败形态 = LLM 未调工具，session 内无 snippet）。
          return fs.readFileSync(s.sessionFile, 'utf8').includes(REJECT_BOUNDARY_SNIPPET)
        },
        round === 1 ? JSONL_FLUSH_TIMEOUT_MS : JSONL_FLUSH_TIMEOUT_MS * 2,
      )
      if (!rejectArrived && round === 1) {
        console.warn('[batch-s3b] 第一轮未见拒绝文案（LLM 未调 subagent_message 工具的遵从 flake），强化指令重发一轮')
      }
    }
    if (!rejectArrived) {
      writeDiag(testInfo, 'batch-s3b-reject-missing.json', {
        sessionTail: fs.readFileSync(s.sessionFile, 'utf8').slice(-3000),
        runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
      })
    }
    expect(rejectArrived, `subagent_message 工具结果应含域边界拒绝文案 "${REJECT_BOUNDARY_SNIPPET}"（workflow-origin record 不进 message 通道）`).toBe(true)
    const sessionTextAll = fs.readFileSync(s.sessionFile, 'utf8')
    expect(sessionTextAll.includes(REJECT_REDIPATCH_SNIPPET), '拒绝文案应含恢复指引 "re-dispatch via the subagent_batch tool"').toBe(true)
    await s.page.screenshot({ path: testInfo.outputPath('s3b-rejected.png'), fullPage: true })
    console.log('[batch-s3b] PASS：message 域边界拒绝')
  })

  test('S3c (batch real): 非法成员 agent（非 ^/ 绝对路径）→ subagent_batch 工具入口拒绝（零 run + 零派发）', async ({ }, testInfo) => {
    test.setTimeout(300_000)
    const s = shared!
    // 成员对象形状（§3.1.2 终态）：非法 agent 走成员对象 agent 字段——相对路径
    // 不匹配 schema `^/` pattern，在 subagent_batch 工具入口被拒（旧 S3c 的 `agents`
    // 数量错配 fail-fast 随该参数退役；拒绝层级早于旧模板入口，run 不创建）。
    const tasks = [
      { task: 'Reply with a one-line summary ending with the exact token BATCH-S3C-1-5314.' },
      {
        task: 'Reply with a one-line summary ending with the exact token BATCH-S3C-2-5315.',
        agent: INVALID_MEMBER_AGENT_PATH,
      },
    ]
    const prompt =
      `Dispatch exactly 2 background subagent tasks in ONE call using the \`subagent_batch\` tool. ` +
      `tasks = ${JSON.stringify(tasks)} ` +
      `(the second member's agent path is INTENTIONALLY invalid — it is not an absolute path; ` +
      `do not fix it and do not retry with a different path — call the tool exactly as specified, once). ` +
      `After the tool call returns, reply with only the word DISPATCHED.`

    const agentDir = path.join(s.dataDir, 'agent')
    const journalsBefore = listFilesRecursive(agentDir, '.record.jsonl').length
    await sendAndWaitTurn(testInfo, prompt, 's3c-send', MAIN_TURN_TIMEOUT_MS)

    // 会话文件幂等重定位（同会话同文件）
    s.sessionFile = await locateSessionFile(agentDir)

    // 调用发起证据（prompt 遵从锚——结构不锚文案）：工具调用 args 随 assistant
    // toolUse 落 session JSONL，其中含注入的非法路径字面；缺它则「零 run」可能
    // 只是 LLM 没调工具的遵从 flake，断言无从归因。
    const callIssued = fs.readFileSync(s.sessionFile, 'utf8').includes(INVALID_MEMBER_AGENT_PATH)
    if (!callIssued) {
      writeDiag(testInfo, 'batch-s3c-call-missing.json', {
        sessionTail: fs.readFileSync(s.sessionFile, 'utf8').slice(-3000),
        runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
      })
    }
    expect(callIssued, `session JSONL 应含非法 agent 路径字面 "${INVALID_MEMBER_AGENT_PATH}"（工具调用 args 落盘——LLM 确实按 prompt 发起了带非法成员的调用）`).toBe(true)

    // 工具入口拒绝的结构证据：run journal 零新增（拒绝先于 run 创建——与旧
    // `agents` 错配 fail-fast 的「journal run-created 先落再 settled(failed)」不同层级；
    // 模型被拒后重试同批也仍零新增，断言不受影响）。主 turn complete 后补小静默窗
    // 防 journal 落盘与 turn 结束的残余时序差。
    await new Promise((resolve) => setTimeout(resolve, NO_RUN_SETTLE_MS))
    const journalsAfter = listFilesRecursive(agentDir, '.record.jsonl')
    if (journalsAfter.length !== journalsBefore) {
      writeDiag(testInfo, 'batch-s3c-run-created.json', {
        journalsBefore,
        journalsAfter: journalsAfter.map((f) => path.basename(f)),
        runtimeLogsTail: readRuntimeLogs(s.dataDir).slice(-3000),
      })
    }
    expect(journalsAfter.length, `非法成员 agent 应在工具入口被拒——run journal 应零新增（${journalsBefore} → ${journalsAfter.length}；run 创建即拒绝层级后移，见 diag）`).toBe(journalsBefore)

    // v2 条目计数不变：入口拒绝不产生第二轮 run——workflow-record v2 条目仍只有
    // S3a 一轮的 registered/settled 各 1（旧 S3c 断言「两轮批后恰 2」随退役删除）。
    const wfRegisteredAll = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'registered')
    const wfSettledAll = extractCustomEntries(s.sessionFile, 'workflow-record').filter((d) => d['v'] === 2 && d['kind'] === 'settled')
    expect(wfRegisteredAll.length, '入口拒绝不产生新 run——workflow-record v2 registered 条目应仍为 S3a 的恰 1 条').toBe(1)
    expect(wfSettledAll.length, '入口拒绝不产生新 run——workflow-record v2 settled 条目应仍为 S3a 的恰 1 条').toBe(1)

    await s.page.screenshot({ path: testInfo.outputPath('s3c-entry-rejected.png'), fullPage: true })
    console.log('[batch-s3c] PASS：非法成员 agent 工具入口拒绝——零 run journal、零成员派发')
  })
})
