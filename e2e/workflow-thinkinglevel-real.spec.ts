/**
 * Workflow agent() thinkingLevel REAL E2E —— 真实 runtime + pi 子进程 + faux LLM 演员
 * （L2.5 翻轨，2026-09-15）。
 *
 * 验证目标：workflow script 里 agent({ model, thinkingLevel: "high" }) 的
 * thinkingLevel 端到端真实生效。观测表面全部是 pi 自己写的文件（零 taiji
 * 代码介入，无日志钩子）：
 *
 * - TC1: 主 session JSONL 的 workflow-record v2 条目（registered/settled 投影锚，
 *        runId 关联）+ record 事件流 agent-started 帧 input（规范化 opts 的
 *        canonical JSON 全文落账）——脚本请求值的现行持久化面（[D1] record 单源，
 *        jsonl-run-store.ts 头注；旧 v1 全量快照条目已停写）
 * - TC2: 子进程 session JSONL 的 thinking_level_change / model_change entry ——
 *        pi 收到 --model provider/id:high 后真实落盘的状态（核心，确定性）
 * - TC3: session.workflowUpdate done 信号 + 子进程 JSONL 有 assistant 消息
 *        （faux 演者跑完产出，凭证无关）
 *
 * faux 翻轨装配：主对话模型 faux/faux-1（settings 预置），faux 响应脚本用
 * model-keyed 对象形态（faux-llm-ext loadScript 的第二种形态）——主进程队列
 * [workflow toolCall → done 文本]（faux-1 槽位）、子进程队列 [PROBE-OK 文本]
 * （faux-1-reasoning 槽位，由 agent() 的 model 选择）。主/子进程共享同一
 * TAIJI_FAUX_SCRIPT（subagent 子进程经 env 透传 + --extension 镜像注入，同此前探针做法）。
 *
 * 关键认知（实证 <dataDir>/agent/subagents/<cwd 编码>/sessions/*.jsonl 第 2-3 行）：
 * pi 以 --model provider/id:high 启动子进程时，启动即写两个 entry：
 *   {"type":"model_change","provider":"...","modelId":"..."}
 *   {"type":"thinking_level_change","thinkingLevel":"high"}
 * :high 合并后缀只在 spawn args 存在（session-runner.ts:454-459），pi 解析后
 * 拆成独立字段落盘（session-manager.ts appendModelChange/appendThinkingLevelChange）
 * —— 断言必须查独立字段 thinkingLevel:"high"，禁止 grep ":high" 后缀。
 *
 * 文件定位链（[D1] record 单源后）：
 * 主 session JSONL（session.create reply 的 sessionFile）
 *   → workflow-record v2 registered 条目的 data.recordPath → record 事件流
 *     （<sessionDir>/workflow-state/<runId>.record.jsonl，jsonl-run-store.ts）
 *   → agent-settled 帧 result.sessionFile → 子进程 session 文件
 *     （缺失时全量扫描 dataDir 下 sessions/*.jsonl 按首行 session.id 匹配，
 *     session-service.ts findAgentCallFile 同策略，更健壮）
 */
import { test, expect } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
  readPiLogs,
  type FauxStep,
} from './fixtures/launch-app-real'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

/** 探针脚本名（与 fixture script 的 meta.name 一致） */
const PROBE_SCRIPT = 'thinkinglevel-probe'
/** 探针脚本请求的 model（与 fixture script 的 agent() model 一致——faux reasoning 演员，档位含 high） */
const PROBE_MODEL = 'faux/faux-1-reasoning'
/** 主对话 prompt（faux 队列步骤 1 直接 toolCall workflow，prompt 仅作 user 消息入 session） */
const PROBE_PROMPT = `请调用 workflow tool 运行 ${PROBE_SCRIPT} 脚本。`

/**
 * model-keyed faux 响应脚本（faux-llm-ext loadScript 对象形态）：
 * - faux/faux-1（主进程，settings default）：workflow toolCall（run <probe 绝对路径>）
 *   → toolResult 后的 done 文本
 * - faux/faux-1-reasoning（agent() 子进程，按 --model 选队）：PROBE-OK stop 文本
 *
 * run 的 name 用绝对路径（C5③ getPath 通道）：workflow script 需 @pi-meta 元数据
 * 才进 registry（本 fixture 已带），绝对路径是 not-found 自救指引的同款形态、
 * 对 dataDir 内复制位置最精确。
 */
function buildFauxScript(probePath: string): Record<string, FauxStep[]> {
  return {
    'faux/faux-1': [
      { toolCalls: [{ name: 'workflow', args: { action: 'run', name: probePath } }] },
      { text: 'workflow 已完成。' },
    ],
    'faux/faux-1-reasoning': [
      { text: 'PROBE-OK' },
    ],
  }
}

/**
 * 预置 dataDir：workflow 探针脚本复制到 user 级 <dataDir>/agent/workflows/。
 * provider/model/npm 扩展目录预置已由 launchRealApp({ faux }) 接管（L2.5 翻轨，
 * 凭证无关）；piAgentDir = <dataDir>/agent（runtime pi-paths SSOT）。
 *
 * 不能依赖 project 级 <workspaceRoot>/.pi/workflows/：sample-project 的祖先目录
 * 有 .bare（<workspace>/），findWorkspaceRoot 从 session cwd 向上跳转到
 * workspace 根，project 级扫描路径变成 <workspace>/.pi/workflows/，
 * sample-project 下的 .pi 不会被发现——user 级是唯一可靠路径。
 */
function makePresetDataDir(): { dataDir: string; probePath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-real-workflow-'))
  const probeSrc = path.join(SAMPLE_PROJECT, '.pi', 'workflows', `${PROBE_SCRIPT}.js`)
  let probePath = probeSrc
  if (fs.existsSync(probeSrc)) {
    const userWorkflowsDir = path.join(dataDir, 'agent', 'workflows')
    fs.mkdirSync(userWorkflowsDir, { recursive: true })
    probePath = path.join(userWorkflowsDir, `${PROBE_SCRIPT}.js`)
    fs.copyFileSync(probeSrc, probePath)
  }
  return { dataDir, probePath }
}

/**
 * 通过 WS 创建 session 并激活。OS 原生目录选择 dialog 不可自动化，
 * TEST-STRATEGY 约定用 WS 直连触发等效业务动作。
 *
 * @returns sessionId + sessionFile（主 session JSONL 路径，pi create 时已确定）
 */
async function createAndActivateSession(port: number): Promise<{ sessionId: string; sessionFile?: string }> {
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'wf-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: 'wf-real-sample' },
  }, 'wf-real-create')
  expect(createReply.type).toBe('session.created')
  const session = createReply.payload.session as { id: string; sessionFile?: string }
  return { sessionId: session.id, sessionFile: session.sessionFile }
}

/**
 * 递归扫描 dataDir 下所有 sessions/*.jsonl 文件（排除 .finalized 终态文件），
 * 按修改时间倒序返回。
 *
 * 子进程 session 文件布局：<dataDir>/agent/subagents/<encodedCwd>/sessions/
 * <ISO>_<sessionId>.jsonl（encodedCwd 规则见 runtime pi-paths.ts encodeCwd）。
 * 全量递归扫描比精确编码 cwd 更健壮，匹配交给调用方按首行 session.id 精确比对。
 */
function findSubagentSessionFiles(dataDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.finalized')) {
        out.push(p)
      }
    }
  }
  walk(dataDir)
  return out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 }
  })
}

/**
 * 定位子进程 session 文件。优先用 record 流 agent-settled 帧的 result.sessionFile
 * （精确绝对路径，[D1] result 全文落账承载）；缺失时 fallback 全量扫描：排除主
 * session 文件 + cwd 为 sample-project + mtime 最新。
 *
 * 注意：不能用 recordId（sa-<uuid> 是 subagent-workflow 扩展的 record id，
 * 非 pi session id——pi 的 session id 是 uuidv7，JSONL 首行 session.id），两者不同源。
 */
function locateSubagentSessionFile(
  dataDir: string,
  settledSessionFile: string | undefined,
  mainSessionFile: string | null,
): string | null {
  if (typeof settledSessionFile === 'string' && fs.existsSync(settledSessionFile)) {
    return settledSessionFile
  }
  // fallback：非主 session 文件中 cwd 匹配 sample-project 且 mtime 最新
  const files = findSubagentSessionFiles(dataDir).filter((f) => f !== mainSessionFile)
  for (const f of files) {
    try {
      const first = JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0])
      if (first?.cwd === SAMPLE_PROJECT) return f
    } catch { /* ignore */ }
  }
  return null
}

/** 读 session 文件全部 entry（每行 JSON.parse）；不可读返回 null */
function readSessionEntries(file: string): any[] | null {
  try {
    return fs.readFileSync(file, 'utf8')
      .trim().split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return null
  }
}

/**
 * 主 session JSONL 的 workflow-record v2 条目提取（[D1] record 单源后的投影锚）。
 *
 * pi 侧落盘形状（workflow-record-entry.ts v2 schema）：主 session 每 run 两条小
 * 条目——registered（`{v:2, kind:"registered", runId, recordPath, ...}`，含 record
 * 流绝对路径锚点；ADR-0078 改名前旧键名 journalPath）与 settled（`{v:2, kind:"settled",
 * runId, status, ...}`）。唯一事实源 = recordPath 指向的 record 事件流
 * （`<sessionDir>/workflow-state/<runId>.record.jsonl`，jsonl-run-store.ts 头注），
 * 条目本身可随时从 record 重建。
 *
 * 返回 null = 主 session 文件不可读；内层字段 null = 文件可读但对应条目缺失
 * （两者区分诊断）。
 */
function findWorkflowRecordV2Entries(mainSessionFile: string): {
  registered: { runId: string; recordPath: string } | null;
  settled: { runId: string; status: string } | null;
} | null {
  let lines: string[]
  try {
    lines = fs.readFileSync(mainSessionFile, 'utf-8').trim().split('\n')
  } catch {
    return null
  }
  let registered: { runId: string; recordPath: string } | null = null
  let settled: { runId: string; status: string } | null = null
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry?.customType !== 'workflow-record' || entry?.data?.v !== 2) continue
      const data = entry.data
      if (data.kind === 'registered' && typeof data.runId === 'string' && typeof data.recordPath === 'string') {
        registered = { runId: data.runId, recordPath: data.recordPath }
      } else if (data.kind === 'settled' && typeof data.runId === 'string') {
        settled = { runId: data.runId, status: String(data.status) }
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
  return { registered, settled }
}

/**
 * record 事件流读取（recordPath 指向的 `<runId>.record.jsonl`，每行一个事件帧
 * JSON.parse）。不可读/缺失返回 null——record 流是 [D1] 后唯一事实源，缺失即
 * workflow 数据链断裂（fail，不静默）。
 */
function readRecordEvents(recordPath: string): any[] | null {
  try {
    return fs.readFileSync(recordPath, 'utf-8')
      .trim().split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return null
  }
}

/**
 * record 流 agent-started 帧的入参全文解析（`input` 字段 = resolveAgentOpts
 * 规范化后 opts 的 canonical JSON——terminal-actions dispatchAgentStarted 落账；
 * 脚本 agent() 的 model/thinkingLevel 请求值在此可观测）。无 agent-started 帧
 * 返回 null。
 */
function agentStartedInputOf(recordEvents: any[]): any | null {
  const started = recordEvents.find((e) => e.type === 'agent-started' && typeof e.input === 'string')
  if (!started) return null
  try {
    return JSON.parse(started.input)
  } catch {
    return null
  }
}

/**
 * record 流 agent-settled 帧的子进程 session 文件路径（`result.sessionFile`——
 * [D1] result 全文落账后兼承载执行树家族链数据源，run-events.ts AgentSettledEvent
 * 注释）。旧 v1 snapshot 的 calls[0].sessionFile 通道随快照删除退役，本字段是
 * 现行唯一精确锚。无携带帧返回 undefined（fallback 全量扫描由调用方承接）。
 */
function settledSessionFileOf(recordEvents: any[]): string | undefined {
  const settledWithFile = recordEvents.find(
    (e) => e.type === 'agent-settled' && typeof e.result?.sessionFile === 'string',
  )
  return settledWithFile?.result.sessionFile as string | undefined
}

/** 失败诊断落盘（文件链断裂时写 /tmp/<tc>-diag.json） */
function writeDiag(tc: string, dataDir: string, events: any[], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(`/tmp/${tc}-diag.json`, JSON.stringify({
    eventCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    workflowUpdates: events
      .filter((e) => e.type === 'session.workflowUpdate')
      .map((e) => e.payload?.update),
    toolEvents: events
      .filter((e) => e.type?.includes('tool_call'))
      .map((e) => ({ type: e.type, toolName: e.payload?.toolName })),
    subagentFiles: findSubagentSessionFiles(dataDir).slice(0, 10).map((f) => path.basename(f)),
    runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
    piLogsTail: readPiLogs(dataDir).slice(-2000),
    ...extra,
  }, null, 2))
}

/**
 * 共用流程：launch → session.create/activate → 开第二 WS 监听 → 发 prompt →
 * 轮询 session.workflowUpdate done 信号。
 *
 * workflow run 完成时 pi-subagent-workflow 发 workflow-result customStart，
 * runtime event-interpreter handleWorkflowResult 广播 session.workflowUpdate
 * {status:'done', runId, reason}（event-interpreter.ts:514-530）。
 * done 到达 = workflow 完整跑完（v2 settled 条目与 record 终局帧已落盘）——TC1/TC2/TC3 都以
 * 它为文件读取触发点。
 *
 * @returns ctx：doneUpdate 为空 = workflow 链路断裂（fail，faux 下无 flaky 容忍）
 */
async function runProbeWorkflow(tc: string): Promise<{
  dataDir: string
  events: any[]
  doneUpdate: any
  sessionId: string
  mainSessionFile: string | null
  listenWs: import('ws').default | null
  cleanup: () => Promise<void>
}> {
  const { dataDir, probePath } = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({
    dataDir,
    faux: { responses: buildFauxScript(probePath) },
  })
  const ctx = {
    dataDir,
    events: [] as any[],
    doneUpdate: undefined as any,
    sessionId: '',
    mainSessionFile: null as string | null,
    listenWs: null as unknown as import('ws').default,
    cleanup,
  }
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    const { sessionId, sessionFile } = await createAndActivateSession(port)
    ctx.sessionId = sessionId
    ctx.mainSessionFile = sessionFile ?? null

    // 先开监听 WS 再发 prompt（避免 broadcast 时序竞争）
    const { ws: listenWs, events } = await openListenWs(port, sessionId)
    ctx.listenWs = listenWs
    ctx.events = events

    await wsRoundTrip(port, {
      type: 'message.send',
      id: `${tc}-send`,
      payload: { sessionId, content: PROBE_PROMPT },
    }, `${tc}-send`, 30_000)

    // 轮询 workflowUpdate done（faux 下整链确定性，90s 余量覆盖 Electron 启动后整链）
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const done = ctx.events.find(
        (e) => e.type === 'session.workflowUpdate' && e.payload?.update?.status === 'done',
      )
      if (done) {
        ctx.doneUpdate = done
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  } catch (err) {
    ctx.listenWs?.close()
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    throw err
  }
  return ctx
}

// ── TC1: 脚本请求值持久化（确定性） ───────────────────────────────

test('TC1: record 流 agent-started 帧 input 含 thinkingLevel/model（脚本请求值 → record 单源落账）', async () => {
  test.setTimeout(150_000)
  const ctx = await runProbeWorkflow('tc1')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc1', ctx.dataDir, ctx.events)
    }
    expect(ctx.doneUpdate, 'workflow 应跑完（faux 队列预设 workflow toolCall → done）——未 done 见 /tmp/tc1-diag.json').toBeDefined()

    // 主 session JSONL：create reply 的 sessionFile。pi 延迟写入策略下文件可能
    // 稍后才落盘——workflow 已 done（主 session 有 assistant 消息 + v2 条目
    // flush 过），轮询等文件出现即可。
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在（session.created reply）').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    // 断言 ①：主 session JSONL 含 workflow-record v2 两条小条目（[D1] 投影锚）
    const rec = findWorkflowRecordV2Entries(mainFile!)
    if (!rec || !rec.registered || !rec.settled) {
      writeDiag('tc1', ctx.dataDir, ctx.events, {
        mainSessionFile: mainFile,
        mainSessionTail: fs.readFileSync(mainFile!, 'utf-8').split('\n').slice(-10),
      })
    }
    expect(rec, '主 session JSONL 应可读').toBeTruthy()
    expect(rec!.registered, '主 session JSONL 应含 v2 registered 条目（runId + recordPath 锚点）').toBeTruthy()
    expect(rec!.registered!.runId, 'registered.runId 应非空').toBeTruthy()
    expect(rec!.settled, '主 session JSONL 应含 v2 settled 条目（终态 coda 写入）').toBeTruthy()
    expect(rec!.settled!.runId, 'settled.runId 应与 registered 同 run（runId 关联）').toBe(rec!.registered!.runId)
    expect(rec!.settled!.status, 'settled.status 应为 done（终局收敛词）').toBe('done')

    // 断言 ②：record 事件流（唯一事实源）的 agent-started 帧 input 含脚本请求值。
    // input = resolveAgentOpts 规范化后 opts 的 canonical JSON（dispatchAgentStarted
    // 全文落账）——脚本 agent({model, thinkingLevel}) 的请求值在此可观测。
    const recordEvents = readRecordEvents(rec!.registered!.recordPath)
    if (!recordEvents) {
      writeDiag('tc1', ctx.dataDir, ctx.events, { journalPath: rec!.registered!.recordPath })
    }
    expect(recordEvents, `record 事件流应可读（${rec!.registered!.recordPath}）——[D1] 后唯一事实源`).toBeTruthy()
    expect(recordEvents!.some((e) => e.type === 'run-created'), 'record 流应含 run-created 首帧').toBe(true)

    const startedInput = agentStartedInputOf(recordEvents!)
    if (!startedInput) {
      writeDiag('tc1', ctx.dataDir, ctx.events, {
        journalPath: rec!.registered!.recordPath,
        recordEventTypes: recordEvents!.map((e) => e.type),
      })
    }
    expect(startedInput, 'record 流应含 agent-started 帧且 input 可解析').toBeTruthy()
    expect(startedInput.thinkingLevel, 'agent-started input.thinkingLevel 应为 high（脚本请求值）').toBe('high')
    expect(startedInput.model, 'agent-started input.model 应与 fixture 一致').toBe(PROBE_MODEL)
    console.log(`[TC1] 请求值验证通过: model=${startedInput.model}, thinkingLevel=${startedInput.thinkingLevel}, runId=${rec!.registered!.runId}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

// ── TC2: pi 真实生效值（核心，确定性） ─────────────────────────────────

test('TC2: 子进程 JSONL 含 thinking_level_change high + model_change（pi 真实生效）', async () => {
  test.setTimeout(150_000)
  const ctx = await runProbeWorkflow('tc2')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc2', ctx.dataDir, ctx.events)
    }
    expect(ctx.doneUpdate, 'workflow 应跑完（faux 队列预设）——未 done 见 /tmp/tc2-diag.json').toBeDefined()

    // 定位链 1+2（[D1]）：主 session JSONL → v2 registered 条目 → recordPath
    // → record 流 → agent-settled 帧 result.sessionFile
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const rec = findWorkflowRecordV2Entries(mainFile!)
    expect(rec?.registered, '主 session JSONL 应含 workflow-record v2 registered 条目（recordPath 锚点）').toBeTruthy()
    const recordEvents = readRecordEvents(rec!.registered!.recordPath)
    expect(recordEvents, `record 事件流应可读（${rec!.registered!.recordPath}）`).toBeTruthy()
    const settledSessionFile = settledSessionFileOf(recordEvents!)

    // 定位链 3：优先 agent-settled 帧 result.sessionFile（pi 子进程 session 文件
    // 绝对路径，[D1] result 全文落账承载）；缺失时全量扫描排除主 session 取最新
    const subFile = locateSubagentSessionFile(ctx.dataDir, settledSessionFile, ctx.mainSessionFile)
    if (!subFile) {
      const candidates = findSubagentSessionFiles(ctx.dataDir)
      writeDiag('tc2', ctx.dataDir, ctx.events, {
        settledSessionFile,
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 10).map((f) => path.basename(f)),
      })
      console.log(`[TC2] 未找到子进程 session 文件（候选 ${candidates.length} 个），diag → /tmp/tc2-diag.json`)
    }
    expect(subFile, '应能找到子进程 session 文件（calls[0].sessionFile 或扫描 fallback）').toBeTruthy()

    // 核心断言：pi 收到 --model faux/faux-1-reasoning:high 后拆成独立字段落盘。
    // 禁止 grep ":high" 后缀——spawn args 才带后缀，JSONL entry 是独立字段。
    const entries = readSessionEntries(subFile!)
    expect(entries, '子进程 session 文件应可解析').toBeTruthy()
    const tlEntries = entries!.filter((e) => e.type === 'thinking_level_change')
    const mcEntries = entries!.filter((e) => e.type === 'model_change')
    expect(tlEntries.length, '子进程 JSONL 应含 thinking_level_change entry（启动即写）').toBeGreaterThan(0)
    expect(tlEntries[0].thinkingLevel, 'thinking_level_change.thinkingLevel 应为 high（独立字段）').toBe('high')
    expect(mcEntries.length, '子进程 JSONL 应含 model_change entry').toBeGreaterThan(0)
    expect(mcEntries[0].provider, 'model_change.provider 应与 fixture model 的 provider 一致').toBe(PROBE_MODEL.split('/')[0])
    expect(mcEntries[0].modelId, 'model_change.modelId 应与 fixture model 的 id 一致').toBe(PROBE_MODEL.split('/')[1])
    // 顺序契约（实证第 2-3 行）：model_change 先、thinking_level_change 后
    const mcIdx = entries!.findIndex((e) => e.type === 'model_change')
    const tlIdx = entries!.findIndex((e) => e.type === 'thinking_level_change')
    expect(mcIdx, 'model_change 应先于 thinking_level_change 落盘').toBeLessThan(tlIdx)
    console.log(`[TC2] pi 真实生效值验证通过: ${path.basename(subFile!)}`)
    console.log(`[TC2]   model_change: ${mcEntries[0].provider}/${mcEntries[0].modelId}`)
    console.log(`[TC2]   thinking_level_change: ${tlEntries[0].thinkingLevel}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/**
 * 轮询主 session JSONL 落盘（pi 延迟写入策略：create reply 已给路径但文件稍后才写）。
 * 15s deadline 内每秒查存在性，超时返回最新已知值（存在性断言由调用方继续）。
 */
async function waitForMainSessionJsonl(mainSessionFile: string | null): Promise<string | null> {
  let mainFile = mainSessionFile
  const fileDeadline = Date.now() + 15_000
  while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
    await new Promise((r) => setTimeout(r, 1000))
  }
  return mainFile
}

/** TC3 子进程 session 文件未命中时的诊断（diag 落盘 + 日志；断言由调用方继续）。 */
function diagnoseMissingSubFileTc3(
  dataDir: string,
  events: any[],
  settledSessionFile: string | undefined,
  runId: string,
): void {
  writeDiag('tc3', dataDir, events, {
    settledSessionFile,
    runId,
    candidates: findSubagentSessionFiles(dataDir).slice(0, 10).map((f) => path.basename(f)),
  })
  console.log(`[TC3] 未找到子进程 session 文件，diag → /tmp/tc3-diag.json`)
}

/** TC3 核心断言 2：子进程 JSONL 有 assistant 消息（faux 演员跑完产出）。 */
function assertAssistantMessagesTc3(entries: any[]): any[] {
  const assistantMsgs = entries.filter(
    (e) => e.type === 'message' && e.message?.role === 'assistant',
  )
  expect(assistantMsgs.length, '子进程 JSONL 应有 assistant 消息（faux 演员跑完产出）').toBeGreaterThan(0)
  return assistantMsgs
}

// ── TC3: 完整跑通（done 信号 + faux 演员产出） ────────────────────

test('TC3: workflowUpdate done + 子进程 JSONL 有 assistant 消息（完整跑通）', async () => {
  test.setTimeout(150_000)
  const ctx = await runProbeWorkflow('tc3')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc3', ctx.dataDir, ctx.events)
    }
    expect(ctx.doneUpdate, 'workflow 应跑完（faux 队列预设）——未 done 见 /tmp/tc3-diag.json').toBeDefined()

    // 核心断言 1：session.workflowUpdate done 信号（workflow run 完成广播）
    const update = ctx.doneUpdate!.payload.update
    expect(update.runId, 'done 信号应带 runId').toBeTruthy()
    expect(update.status).toBe('done')
    console.log(`[TC3] workflowUpdate done 信号到达: runId=${update.runId}, reason=${update.reason ?? '(无)'}`)

    // 核心断言 2：子进程 JSONL 有 assistant 消息（faux 演员跑完产出）
    // 定位链同 TC2：主 session JSONL → v2 registered 条目 → recordPath → record 流
    // → agent-settled 帧 result.sessionFile → 全量扫描 fallback
    const mainFile = await waitForMainSessionJsonl(ctx.mainSessionFile)
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const rec = findWorkflowRecordV2Entries(mainFile!)
    expect(rec?.registered, '主 session JSONL 应含 workflow-record v2 registered 条目').toBeTruthy()
    const runId = rec!.registered!.runId
    const recordEvents = readRecordEvents(rec!.registered!.recordPath)
    expect(recordEvents, `record 事件流应可读（${rec!.registered!.recordPath}）`).toBeTruthy()
    const settledSessionFile = settledSessionFileOf(recordEvents!)

    // 定位链 3：同 TC2——优先 agent-settled 帧 result.sessionFile，fallback 全量扫描
    const subFile = locateSubagentSessionFile(ctx.dataDir, settledSessionFile, ctx.mainSessionFile)
    if (!subFile) {
      diagnoseMissingSubFileTc3(ctx.dataDir, ctx.events, settledSessionFile, runId)
    }
    expect(subFile, '应能找到子进程 session 文件').toBeTruthy()

    const entries = readSessionEntries(subFile!)
    expect(entries, '子进程 session 文件应可解析').toBeTruthy()
    const assistantMsgs = assertAssistantMessagesTc3(entries!)

    // 增强断言（不强制）：PROBE-OK 回复出现
    const allText = assistantMsgs.map((e) => JSON.stringify(e.message?.content ?? '')).join(' ')
    console.log(`[TC3] workflow 完整跑通: runId=${update.runId}, assistant 消息=${assistantMsgs.length} 条, PROBE-OK 出现=${allText.includes('PROBE-OK')}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
