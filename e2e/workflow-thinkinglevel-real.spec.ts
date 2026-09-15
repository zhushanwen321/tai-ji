/**
 * Workflow agent() thinkingLevel REAL E2E —— 真实 runtime + pi 子进程 + faux LLM 演员
 * （L2.5 翻轨，2026-09-15）。
 *
 * 验证目标：workflow script 里 agent({ model, thinkingLevel: "high" }) 的
 * thinkingLevel 端到端真实生效。观测表面全部是 pi 自己写的文件（零 taiji
 * 代码介入，无日志钩子）：
 *
 * - TC1: workflow state JSONL 的 state.calls[0].opts —— 扩展持久化的脚本请求值
 *        （jsonl-run-store.ts serializeRun 持久化完整 AgentCallOpts）
 * - TC2: 子进程 session JSONL 的 thinking_level_change / model_change entry ——
 *        pi 收到 --model provider/id:high 后真实落盘的状态（核心，确定性）
 * - TC3: session.workflowUpdate done 信号 + 子进程 JSONL 有 assistant 消息
 *        （faux 演者跑完产出，凭证无关）
 *
 * faux 翻轨装配：主对话模型 faux/faux-1（settings 预置），faux 响应脚本用
 * model-keyed 对象形态（faux-llm-ext loadScript 的第二种形态）——主进程队列
 * [workflow toolCall → done 文本]（faux-1 槽位）、子进程队列 [PROBE-OK 文本]
 * （faux-1-reasoning 槽位，由 agent() 的 model 选择）。主/子进程共享同一
 * TAIJI_FAUX_SCRIPT（subagent 子进程经 env 透传 + --extension 镜像注入，先例：
 * scripts/probes/subagent-sync-collect）。
 *
 * 关键认知（实证 <dataDir>/agent/subagents/<cwd 编码>/sessions/*.jsonl 第 2-3 行）：
 * pi 以 --model provider/id:high 启动子进程时，启动即写两个 entry：
 *   {"type":"model_change","provider":"...","modelId":"..."}
 *   {"type":"thinking_level_change","thinkingLevel":"high"}
 * :high 合并后缀只在 spawn args 存在（session-runner.ts:454-459），pi 解析后
 * 拆成独立字段落盘（session-manager.ts appendModelChange/appendThinkingLevelChange）
 * —— 断言必须查独立字段 thinkingLevel:"high"，禁止 grep ":high" 后缀。
 *
 * 文件定位链：
 * 主 session JSONL（session.create reply 的 sessionFile）
 *   → "workflow-state-link" custom entry 的 data.path → stateFile
 *     （<sessionDir>/workflow-state/<runId>.jsonl，jsonl-run-store.ts:233-253）
 *   → state.calls[0].sessionId → 全量扫描 dataDir 下 sessions/*.jsonl 按首行
 *     session.id 匹配子进程文件（session-service.ts:1178-1193 findAgentCallFile
 *     同策略，但用递归全扫替代精确编码 cwd，更健壮）
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
 * 定位子进程 session 文件。优先用 state.calls[0].sessionFile（精确绝对路径，
 * execution-record.ts serialize 持久化）；缺失时 fallback 全量扫描：排除主 session
 * 文件 + cwd 为 sample-project + mtime 最新。
 *
 * 注意：不能用 calls[0].sessionId（sa-<uuid> 是 subagent-workflow 扩展的 record id，
 * 非 pi session id——pi 的 session id 是 uuidv7，JSONL 首行 session.id），两者不同源。
 */
function locateSubagentSessionFile(
  dataDir: string,
  call0: any,
  mainSessionFile: string | null,
): string | null {
  if (typeof call0?.sessionFile === 'string' && fs.existsSync(call0.sessionFile)) {
    return call0.sessionFile
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
 * 从主 session JSONL 提取最后一条 workflow-record entry（W17 D4 自描述通道）。
 *
 * pi 侧落盘形状 {"type":"custom","customType":"workflow-record","data":{v:1,
 * snapshot: RunSnapshot, updatedAt}}——snapshot 含完整 run（runId/state.calls/...），
 * 是 workflow 数据持久化权威（state 文件降级为性能缓存；旧 workflow-state-link
 * 指针 entry 已退役）。每次成功 flush append 一条，取最后一条（终态 flush 永不
 * 节流，done 后必有终态 entry）。
 */
function findWorkflowRecord(mainSessionFile: string): { runId: string; snapshot: any } | null {
  let lines: string[]
  try {
    lines = fs.readFileSync(mainSessionFile, 'utf-8').trim().split('\n')
  } catch {
    return null
  }
  let latest: { runId: string; snapshot: any } | null = null
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry?.customType === 'workflow-record' && entry?.data?.v === 1 && entry?.data?.snapshot) {
        latest = { runId: entry.data.snapshot.runId, snapshot: entry.data.snapshot }
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
  return latest
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
 * done 到达 = workflow 完整跑完（stateFile 已持久化最终快照）——TC1/TC2/TC3 都以
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

// ── TC1: workflow state 请求值（确定性） ───────────────────────────────

test('TC1: state.calls[0].opts.thinkingLevel === "high"（脚本请求值 → 扩展持久化）', async () => {
  test.setTimeout(150_000)
  const ctx = await runProbeWorkflow('tc1')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc1', ctx.dataDir, ctx.events)
    }
    expect(ctx.doneUpdate, 'workflow 应跑完（faux 队列预设 workflow toolCall → done）——未 done 见 /tmp/tc1-diag.json').toBeDefined()

    // 主 session JSONL：create reply 的 sessionFile。pi 延迟写入策略下文件可能
    // 稍后才落盘——workflow 已 done（主 session 有 assistant 消息 + custom entry
    // flush 过），轮询等文件出现即可。
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在（session.created reply）').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    // 定位链 1（W17）：主 session JSONL 的 workflow-record entry → snapshot
    const rec = findWorkflowRecord(mainFile!)
    if (!rec) {
      writeDiag('tc1', ctx.dataDir, ctx.events, {
        mainSessionFile: mainFile,
        mainSessionTail: fs.readFileSync(mainFile!, 'utf-8').split('\n').slice(-10),
      })
    }
    expect(rec, '主 session JSONL 应含 workflow-record entry（终态 flush 永不节流）').toBeTruthy()

    // 断言：state.calls[0].opts 是脚本请求值的完整持久化（run-snapshot codec）
    const snapshot = rec!.snapshot
    const calls = snapshot?.state?.calls
    expect(Array.isArray(calls), 'state.calls 应为数组').toBe(true)
    expect(calls.length, '至少 1 个 agent call').toBeGreaterThan(0)
    const call0 = calls[0]
    expect(call0.opts.thinkingLevel, 'calls[0].opts.thinkingLevel 应为 high（脚本请求值）').toBe('high')
    expect(call0.opts.model, 'calls[0].opts.model 应与 fixture 一致').toBe(PROBE_MODEL)
    expect(call0.sessionId, 'calls[0].sessionId 应存在（TC2 子进程文件定位依赖）').toBeTruthy()
    console.log(`[TC1] state 请求值验证通过: model=${call0.opts.model}, thinkingLevel=${call0.opts.thinkingLevel}, runId=${rec!.runId}`)
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

    // 定位链 1+2（W17）：主 session JSONL → workflow-record entry → snapshot.calls[0]
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const rec = findWorkflowRecord(mainFile!)
    expect(rec, '主 session JSONL 应含 workflow-record entry').toBeTruthy()

    const snapshot = rec!.snapshot
    const call0 = snapshot?.state?.calls?.[0]

    // 定位链 3：优先 calls[0].sessionFile（pi 子进程 session 文件绝对路径，
    // execution-record serialize 持久化）；缺失时全量扫描排除主 session 取最新
    const subFile = locateSubagentSessionFile(ctx.dataDir, call0, ctx.mainSessionFile)
    if (!subFile) {
      const candidates = findSubagentSessionFiles(ctx.dataDir)
      writeDiag('tc2', ctx.dataDir, ctx.events, {
        call0: { sessionId: call0?.sessionId, sessionFile: call0?.sessionFile },
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
function diagnoseMissingSubFileTc3(dataDir: string, events: any[], call0: any, snapshot: any): void {
  writeDiag('tc3', dataDir, events, {
    call0: { sessionId: call0?.sessionId, sessionFile: call0?.sessionFile },
    candidates: findSubagentSessionFiles(dataDir).slice(0, 10).map((f) => path.basename(f)),
    runStatus: snapshot?.state?.status,
    callStatus: call0?.status,
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
    // 定位链同 TC2：主 session JSONL → stateFile → calls[0].sessionId → 全量扫描匹配
    const mainFile = await waitForMainSessionJsonl(ctx.mainSessionFile)
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const rec = findWorkflowRecord(mainFile!)
    expect(rec, '主 session JSONL 应含 workflow-record entry').toBeTruthy()

    const { snapshot, call0 } = { snapshot: rec!.snapshot, call0: rec!.snapshot?.state?.calls?.[0] }

    // 定位链 3：同 TC2——优先 calls[0].sessionFile，fallback 全量扫描
    const subFile = locateSubagentSessionFile(ctx.dataDir, call0, ctx.mainSessionFile)
    if (!subFile) {
      diagnoseMissingSubFileTc3(ctx.dataDir, ctx.events, call0, snapshot)
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
