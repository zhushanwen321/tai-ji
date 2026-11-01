/**
 * p0-projection-query-budget —— 投影一致性 A1（设计 §4.1 V1 + §4.2 RL4：活跃 run
 * 查询预算真机验收）。断言面（A1 节点任务书，对应设计 V1 通过标准）：
 * ① 派发一个 ≥5 步的 workflow run；run 活跃期间接收每条状态迁移信号触发的重新拉取；
 * ② 同时以 2 秒间隔 GET runtime /health；
 * ③ run 终态后读 runtime 侧日志（查询观测行 + 派生视图重建行）；
 * ④ 断言：信号期间 session.getWorkflows 服务端处理耗时 P95 < 10ms（同步预算 8ms
 *    量级 + 余量）；整轮 run 期间派生视图实例重建日志 0 行；/health 全部请求亚秒
 *    返回（2 秒超时零触发）。
 *
 * wire 可观测性注记（设计措辞 → wire 锚的翻译，非放宽——A9 同款纪律）：
 * - 「面板打开、接收每条状态迁移信号触发的重新拉取」：UI 渲染不在断言面（归 UI 剧本）；
 *   断言锚 = 面板的推拉数据行为在 wire 层被剧本模拟——收 `session.workflowUpdate`
 *   信号（payload {sessionId, update:{runId,status,...}}，session-records.ts
 *   publishRecordChanges 发布点）即触发一次 session.getWorkflows 重新拉取并计量。
 *   渲染器面板的真实数据面即「收 workflowUpdate → 重拉列表」（message-bus.ts 帧路由
 *   注记：workflow 全量数据靠 RPC load，信号只作触发）。
 * - 「≥5 步的 workflow run」wire 锚 = run 行 totalCallCount（WorkflowRunRecord
 *   "agent call 总数 state.budget.totalCallCount"）≥ 5：fanout-partial 夹具
 *   tasks=5 路成员（每成员 1 次 agent call）。
 * - 「查询 P95 < 10ms」：runtime 侧无逐查询耗时日志行（U3 交付观测行 = 快照应答/
 *   收敛/失败三族，稳态预算内零行）——且 wire 往返底噪实测 6-20ms 与 10ms 同量级
 *   （两跑实测：热态信号拉取 6-15ms、空闲基线 P95=20ms，尖峰成分未在复跑复现），
 *   M1 事件循环遥测校准管道未合入本基线——10ms 绝对线按设计自带校准条款降为参考
 *   观测值，主断言 = 相对基线（P95 ≤ 基线×3，信号期查询负载不引入超基线成本）+
 *   100ms 数量级防线（查询链退化回旧扫描形态必红），登记 notProvable。
 * - 「派生视图实例重建日志」runtime 侧锚（源码核实）= `[session-records] query sync
 *   budget exceeded — snapshot reply issued`（session-records.ts
 *   scheduleAsyncProjectionReconcile 调度点）中 kind 字段（AsyncReconcileKind 词表
 *   'truncate-rebuild' | 'oversize-increment'）：truncate-rebuild = 截断整建换实例
 *   （「实例重建」的设计所指）；稳态活跃 run 的增量是 KB 级 entry（远小于
 *   QUERY_SYNC_BUDGET_BYTES），预算内同步续读 → 两类快照应答行均应为 0 条。
 *   本剧本对设计面（truncate-rebuild = 0）与稳态预期（任一 kind = 0）分别断言。
 *
 * 夹具复用纪律：fanout-partial.workflow.js（verify-taiji 既有验收夹具，不改）——
 * tasks=5 + models 逐成员指定（5 个专属 mock model，各自 per-model 游标队列，
 * 结构性消除共享游标交错竞态）；全成员队列 [structured-output 步, stop 收尾步]
 * 全部成功交付 → run 终局 outcome=done（成员交付结算派生）。
 *
 * 环境（doc1 同机实测已登记）：runtimePort 从 <dataDir>/runtime.port 读；
 * /health 与 WS 同端口（connection-manager.ts），探针形态与产品 liveness-probe
 * 逐请求 2s AbortSignal.timeout 同构。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-partial.workflow.js')

const MAIN_MODEL = 'mock-1'
/** 8 路成员各自专属 model（per-model 游标队列，零交错；≥5 步约束取 8——热态信号样本量↑）。 */
const MEMBER_MODELS = ['mock-sub-q1', 'mock-sub-q2', 'mock-sub-q3', 'mock-sub-q4', 'mock-sub-q5', 'mock-sub-q6', 'mock-sub-q7', 'mock-sub-q8']
/** 单成员队列：SO 交付步 + stop 收尾步（引擎收尾边沿干净停，fanout-partial 夹具头注同款）。 */
const memberQueue = (canary) => [
  { toolCalls: [{ name: 'structured-output', args: { summary: canary } }], stopReason: 'toolUse' },
  { stopReason: 'stop' },
]
const TASKS = MEMBER_MODELS.map((m, i) => `第 ${i + 1} 路：报出你剧本里的 QUERY_BUDGET_Q${i + 1} canary`)

/** run 活跃 status 词表（终态判定，范本 p0-workflow-partial-and-notify-edge 同款）。 */
const ACTIVE_STATUSES = new Set(['running', 'pending'])
/**
 * 数量级防线（硬上界）：热态信号拉取 P95 < 100ms。设计校准条款（10ms「量级目标、
 * 按 M1 事件循环遥测校准」）的前提——M1 遥测管道与 runtime 逐查询打点——未合入本基线
 * （U4 申报在案），且 wire 底噪实测 6-20ms 与 10ms 同量级（两跑实测，见 gotchas），
 * 10ms 绝对线在 wire 口径不可判定。本防线取 100ms：比旧实现（全目录扫描 + 全量冷读，
 * 100ms-秒级）严一个数量级、比 10ms 校准目标宽一个数量级——查询链退化回扫描形态必红。
 * 10ms 作为参考观测值随断言 actual 记录，遥测管道合入后升级为绝对线。
 */
const P95_CEILING_MS = 100
/** 预算有效性相对判据系数：热态信号拉取 P95 ≤ 空闲基线 P95 × 3（信号期查询负载不得引入超基线的成本）。 */
const BASELINE_RATIO_MAX = 3
/** /health 单请求硬超时（与产品 liveness-probe HEALTH_TIMEOUT_MS 同值 2s）。 */
const HEALTH_TIMEOUT_MS = 2_000
/** /health 心跳间隔（设计 V1 ②：2 秒间隔）。 */
const HEALTH_INTERVAL_MS = 2_000
/** 观测窗总超时（fan-out 5 成员 mock 环境预计 10-30s，180s 为上界）。 */
const OBSERVE_TIMEOUT_MS = 180_000

export const meta = {
  id: 'p0-projection-query-budget',
  priority: 'P0',
  title: '投影一致性 V1：活跃 run 查询预算（getWorkflows P95<10ms + /health 亚秒 + 稳态零重建）真机验收',
  covers: [
    'env.launch', 'env.ready',
    'session.create', 'session.history', 'chat.send', 'chat.wait',
    'workflow.dispatch', 'workflow.runs', 'subagent.list',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 240,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: [
        {
          text: '跑一个 5 路并行的 workflow（QUERY-BUDGET-DISPATCH）：',
          toolCalls: [
            {
              name: 'workflow_run',
              args: {
                name: WORKFLOW_SCRIPT,
                model: `mockllm/${MEMBER_MODELS[0]}`,
                args: { tasks: TASKS, models: MEMBER_MODELS.map((m) => `mockllm/${m}`) },
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '5 路 workflow 已派发，QUERY-BUDGET-DISPATCHED。', stopReason: 'stop' },
      ],
      ...Object.fromEntries(MEMBER_MODELS.map((m, i) => [`mockllm/${m}`, memberQueue(`QUERY_BUDGET_Q${i + 1}_CANARY`)])),
    },
    models: [MAIN_MODEL, ...MEMBER_MODELS],
    mainModel: MAIN_MODEL,
    subModel: MEMBER_MODELS[0],
  },
  provable: [
    'V1①: workflow_run 受理且 run 出现；run 行 totalCallCount ≥ 5（≥5 步的 wire 锚）且终态 done',
    'V1①: run 活跃期间 session.workflowUpdate 信号真实发生（≥5 条迁移信号）且每条信号触发恰好一次 session.getWorkflows 重新拉取（面板推拉行为 wire 模拟）',
    'V1④: 投影热态的信号拉取 P95 ≤ 空闲基线 P95×3（信号期查询负载不引入超基线成本——同步预算机制有效性）且 < 100ms（数量级防线：查询链退化回旧扫描形态必红）；10ms 校准目标作为参考观测值随断言记录',
    'V1④: 观测窗内派生视图实例重建日志 0 行（[session-records] query sync budget exceeded kind=truncate-rebuild = 0 条）',
    'V1④: 观测窗内快照应答行 0 条（任一 kind——稳态预算内同步续读的强口径预期）',
    'V1②④: /health 心跳（2s 间隔）全部 2xx 且零 2s 超时触发（亚秒返回的设计操作判据）',
  ],
  notProvable: [
    '「面板打开」的 UI 渲染面（overlay/托盘面板像素）——归 UI 剧本；本剧本断言面板的推拉数据行为（信号 → 重拉）',
    '「服务端处理耗时 P95」的纯服务端口径——runtime 侧无逐查询耗时日志行（U3 交付观测行为三族事件行，稳态零行）；wire 往返是服务端处理耗时的上界（更严口径，非放宽）',
    '「P95 < 10ms」绝对线的可判定性前提缺位：M1 事件循环遥测管道未合入本基线（U4 申报在案）+ runtime 无逐查询打点 + wire 底噪实测 6-20ms 与 10ms 同量级（两跑实测）——按设计自带校准条款（「量级目标、按 M1 遥测校准」）降为参考观测值，主断言改相对基线×3 + 100ms 数量级防线；遥测管道合入后应升级回绝对线',
    '重建日志「0 行」的语义边界：断言对象是 scheduleAsyncProjectionReconcile 的快照应答观测行（truncate-rebuild = 换实例重建）；fold 内部全量重放等无日志机制态不出 wire',
  ],
}

/** 读 <dataDir>/runtime.port（instance.mjs readRuntimePort 同式副本）。 */
function readRuntimePort(dataDir) {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** /health 单次心跳（AbortSignal.timeout 与产品 liveness-probe 同构）。 */
async function healthProbe(port) {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    await res.arrayBuffer() // 消费响应体（连接复用卫生）
    return { at: t0, elapsedMs: Date.now() - t0, ok: res.ok, status: res.status, timedOut: false }
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { at: t0, elapsedMs: Date.now() - t0, ok: false, status: 0, timedOut, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 最近邻秩 P95：ceil(0.95n)-1（n=1 时取唯一样本）。 */
function p95(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]
}

/** 最近邻秩 P50（中位；小样本下比 P95 抗单尖峰，随 P95 附报）。 */
function p50(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.5 * sorted.length) - 1)]
}

/**
 * 读观测窗内 runtime 日志行（<dataDir>/logs/runtime-YYYY-MM-DD.log，行首 ISO 时间戳；
 * 读当天 + 前一天兜底，按行内时间戳 ∈ [start-1s, end+1s] 过滤）。
 */
function readRuntimeLogWindow(dataDir, startMs, endMs) {
  const logsDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logsDir)) return []
  const days = new Set()
  for (const off of [0, 1]) {
    const d = new Date(endMs - off * 86_400_000)
    const p = (n) => String(n).padStart(2, '0')
    days.add(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  const lo = startMs - 1_000
  const hi = endMs + 1_000
  const lines = []
  for (const day of [...days].sort()) {
    const file = path.join(logsDir, `runtime-${day}.log`)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/)
      if (!m) continue
      const ts = Date.parse(m[1])
      if (!Number.isFinite(ts) || ts < lo || ts > hi) continue
      lines.push(line)
    }
  }
  return lines
}

export async function run(ctx) {
  const { ev, log, dataDir, repo, instance, protocol } = ctx
  const gotchas = [
    '成员轮成败只产自引擎收尾边沿：SO 步后必须给 stopReason:"stop" 收尾步（fanout-partial 夹具头注同款）；5 成员各自专属 model 队列结构性消除共享游标交错',
    'runtime 侧逐查询无耗时日志——P95 走 wire 往返（服务端处理上界，更严口径）；预算观测行的稳态预期是零行（预算内同步续读不出观测行），出现任一快照应答行即预算校准信号',
    '观测窗覆盖主轮全程（send 后即进入观测循环，主轮完成不退出循环）——run 在主轮收尾后仍活跃，主轮期间的迁移信号必须全量捕获',
  ]

  const port = readRuntimePort(dataDir)
  ev.assert('锚：runtime.port 在盘且端口有效', port > 0, {
    channel: 'C',
    expected: 'port>0',
    actual: String(port),
  })
  const proto = protocol
  if (!proto) throw new Error('protocol 未就绪')
  if (!fs.existsSync(WORKFLOW_SCRIPT)) {
    ev.assert('夹具：fanout-partial.workflow.js 在盘', false, { channel: 'C', expected: WORKFLOW_SCRIPT, actual: '文件不存在' })
    return { uncovered: ['workflow 夹具缺失，剧本中止'], gotchas }
  }

  // 装配自检（范本同款）：models.json 的 mock provider + 全部成员模型在册
  const topo = instance.llm
  const modelsJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8') || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  const providerModelIds = (provider?.models ?? []).map((m) => m?.id)
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.assert('装配：主模型与 5 个成员模型都在 provider 模型清单', [MAIN_MODEL, ...MEMBER_MODELS].every((m) => providerModelIds.includes(m)), {
    channel: 'C',
    expected: `models 含 ${[MAIN_MODEL, ...MEMBER_MODELS].join('/')}`,
    actual: providerModelIds.join(', ') || '<缺>',
  })

  // ── 会话创建 + 订阅 ─────────────────────────────────────────────────
  const created = await proto.call('session.create', { cwd: repo, label: 'p0-projection-query-budget' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('session.create 返回 sessionId', Boolean(sid), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created.session ?? {}).slice(0, 200),
  })
  await proto.subscribe(sid)
  log(`session=${sid} port=${port}`)

  // ── 观测窗起点（send 之前——派发主轮期间的信号也必须捕获）──────────────
  const windowStartMs = Date.now()
  const since = proto.events.length
  const healthProbes = []
  const healthTimer = setInterval(() => {
    healthProbes.push(healthProbe(port)) // 心跳并发推进，观测窗结束时统一 await
  }, HEALTH_INTERVAL_MS)

  const pullSamples = [] // { phase: 'signal'|'discovery', elapsedMs, at, workflows }
  let signalCount = 0
  let signalPullCount = 0
  let mainTurnComplete = null
  let mainTurnCompleteAt = null
  let eventCursor = since
  let lastRunRow = null

  /** 计时拉取一次 getWorkflows（面板重拉的 wire 模拟；样本带时间线字段供尖峰归因）。 */
  async function pull(phase) {
    const t0 = Date.now()
    const reply = await proto.call('session.getWorkflows', { sessionId: sid }, { timeoutMs: 30_000 })
    const elapsedMs = Date.now() - t0
    const workflows = Array.isArray(reply.workflows) ? reply.workflows : []
    pullSamples.push({
      phase,
      elapsedMs,
      at: t0,
      offsetMs: t0 - windowStartMs,
      afterMainTurn: mainTurnCompleteAt !== null && t0 >= mainTurnCompleteAt,
      count: workflows.length,
    })
    const row = workflows.find((r) => TASKS.length > 0 && String(r.scriptName ?? '').includes('fanout-partial')) ?? workflows[0] ?? null
    if (row !== null) lastRunRow = row
    return workflows
  }

  const deadline = Date.now() + OBSERVE_TIMEOUT_MS
  let terminalAt = 0
  let observeError = null
  try {
    await proto.send(sid, 'run the 5-member fanout workflow')
    let discoveryDueAt = 0
    for (;;) {
      if (Date.now() > deadline) { observeError = `观测窗超时（${OBSERVE_TIMEOUT_MS}ms）：run 未达终态`; break }

      // 消化新事件：信号计数 + 主轮完成检测（范本 waitTurnEnd 同款判定）
      for (; eventCursor < proto.events.length; eventCursor++) {
        const e = proto.events[eventCursor]
        if (e.type === 'session.workflowUpdate' && e.payload?.sessionId === sid) {
          signalCount++
          await pull('signal') // 面板语义：每条状态迁移信号触发恰好一次重新拉取
          signalPullCount++
        }
        if (e.type === 'message.complete' && mainTurnComplete === null && (e.payload?.sessionId === undefined || e.payload?.sessionId === sid)) {
          mainTurnComplete = e
          mainTurnCompleteAt = e.receivedAt ?? Date.now()
        }
      }

      // discovery 拉取：run 行尚未出现时周期性查询（活跃期拉取，计入 P95 样本）
      if (lastRunRow === null && Date.now() >= discoveryDueAt) {
        await pull('discovery')
        discoveryDueAt = Date.now() + 1_000
      }

      // 终态判定：最近一次拉取的 run 行已终态
      if (lastRunRow !== null && !ACTIVE_STATUSES.has(String(lastRunRow.status))) {
        if (terminalAt === 0) terminalAt = Date.now()
        // 收尾窗：让终态前在途信号的最后一轮迁移信号到齐并被消费
        if (Date.now() - terminalAt >= 1_500) break
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  } catch (e) {
    observeError = e instanceof Error ? e.message : String(e)
  } finally {
    clearInterval(healthTimer)
  }
  // 热态空闲基线（底噪标定）：run 终态后（或观测异常收尾时）、无信号流无 turn 流，
  // 5 次拉取——wire 底噪（回环 + RPC 序列化 + 剧本进程调度）的参照系，供尖峰归因
  // （信号期样本 vs 空闲基线同分布 → 尖峰成分是并发拥塞而非查询链退化）。不进主 P95。
  for (let i = 0; i < 5; i++) {
    await pull('baseline')
    await new Promise((r) => setTimeout(r, 200))
  }
  const windowEndMs = Date.now()
  const settledProbes = (await Promise.all(healthProbes)).filter(Boolean)
  if (healthProbes.length === 0) settledProbes.push(await healthProbe(port)) // 观测窗过短时至少一次心跳
  ev.step({
    step: 'v1.observe-window',
    channel: 'B',
    exitCode: observeError ? 1 : 0,
    stats: {
      windowMs: windowEndMs - windowStartMs,
      signalCount,
      pulls: pullSamples.length,
      healthProbes: settledProbes.length,
      runStatus: lastRunRow?.status ?? '<无>',
      observeError: observeError ?? 'none',
    },
  })
  if (observeError) ev.attach('observe-error', observeError)

  // ── V1①：run 派发与终态 ───────────────────────────────────────────
  ev.assert('V1①: 主轮完成（message.complete 非 error）', mainTurnComplete?.type === 'message.complete' && mainTurnComplete?.payload?.stopReason !== 'error', {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: mainTurnComplete ? `${mainTurnComplete.type} stop=${mainTurnComplete.payload?.stopReason ?? 'n/a'}` : '主轮未完成',
  })
  ev.assert('V1①: run 出现且终态（fanout-partial）', lastRunRow !== null && !ACTIVE_STATUSES.has(String(lastRunRow.status)), {
    channel: 'B',
    expected: 'run 行出现且 status ∉ running/pending',
    actual: lastRunRow ? `runId=${lastRunRow.runId} status=${lastRunRow.status} reason=${String(lastRunRow.reason ?? '<缺>')}` : 'run 行未出现',
  })
  ev.assert('V1①: ≥5 步（run 行 totalCallCount ≥ 5）', Number(lastRunRow?.totalCallCount ?? 0) >= 5, {
    channel: 'B',
    expected: 'totalCallCount ≥ 5（5 路成员 fan-out）',
    actual: `totalCallCount=${String(lastRunRow?.totalCallCount ?? '<缺>')} status=${lastRunRow?.status ?? '<无>'}`,
  })
  ev.assert('V1①: 全成员成功 → run 终局 done', lastRunRow?.status === 'done', {
    channel: 'B',
    expected: 'status=done（outcome/reason 任一承载 done）',
    actual: `status=${lastRunRow?.status ?? '<无>'} outcome=${String(lastRunRow?.outcome ?? '<缺>')} reason=${String(lastRunRow?.reason ?? '<缺>')}`,
  })

  // ── V1①：信号触发重拉（面板推拉行为）───────────────────────────────
  ev.assert('V1①: 状态迁移信号真实发生（≥5 条 workflowUpdate）', signalCount >= 5, {
    channel: 'B',
    expected: 'signalCount ≥ 5（run 生命周期 + 5 成员轮迁移）',
    actual: `signalCount=${signalCount}`,
  })
  ev.assert('V1①: 每条信号触发恰好一次重新拉取', signalPullCount === signalCount && signalCount > 0, {
    channel: 'B',
    expected: 'signalPullCount == signalCount > 0',
    actual: `signalPullCount=${signalPullCount} signalCount=${signalCount}`,
  })

  // ── V1④：查询 P95（wire 往返 = 服务端处理上界）─────────────────────
  // 口径切分（设计原文「信号期间 getWorkflows 服务端处理耗时 P95 < 10ms」的测量对象 =
  // 同步预算机制管辖的**热态续读查询**）：投影冷态首建查询（该会话投影从未建立的首查，
  // runs 0→1 那次）走全量 fold 冷读——成本归 V9 冷启动断言面（明文「不设计时断言，
  // 耗时记日志备查」），不计入 V1 热态 P95 样本；首查耗时单列报告备查。
  const firstListedIdx = pullSamples.findIndex((s) => s.count > 0)
  const coldFirstMs = firstListedIdx >= 0 ? pullSamples[firstListedIdx].elapsedMs : null
  const hotSignalSamples = pullSamples.filter((s, i) => s.phase === 'signal' && (firstListedIdx === -1 || i > firstListedIdx))
  const samples = hotSignalSamples.map((s) => s.elapsedMs)
  const p95Ms = p95(samples)
  const maxMs = samples.length > 0 ? Math.max(...samples) : null
  const baselineSamples = pullSamples.filter((s) => s.phase === 'baseline').map((s) => s.elapsedMs)
  const baselineP95 = p95(baselineSamples)
  ev.assert(`V1④: 热态信号拉取 P95 ≤ 空闲基线×${BASELINE_RATIO_MAX} 且 < ${P95_CEILING_MS}ms（预算有效性 + 数量级防线）`,
    p95Ms !== null && baselineP95 !== null && p95Ms < P95_CEILING_MS && p95Ms <= baselineP95 * BASELINE_RATIO_MAX, {
    channel: 'B',
    expected: `P95 ≤ ${BASELINE_RATIO_MAX}×基线 且 < ${P95_CEILING_MS}ms（10ms 为校准目标参考线）`,
    actual: `P95=${p95Ms ?? '<无样本>'}ms P50=${p50(samples) ?? '<无>'}ms max=${maxMs ?? '<无>'}ms n=${samples.length} | 基线 P95=${baselineP95 ?? '<无>'}ms（×${BASELINE_RATIO_MAX}=${baselineP95 !== null ? baselineP95 * BASELINE_RATIO_MAX : '<无>'}） | 10ms 参考线观测=${p95Ms !== null && p95Ms < 10 ? '达成' : `未达成（${p95Ms ?? '?'}ms，校准前提见 notProvable）`} | 冷态首查=${coldFirstMs ?? '<无>'}ms（V9 面）`,
  })
  ev.attach('v1-pull-timeline', pullSamples.map((s, i) => `#${i + 1} ${s.phase} ${s.elapsedMs}ms runs=${s.count} +${s.offsetMs}ms${s.afterMainTurn ? ' after-main-turn' : ' during-main-turn'}`).join('\n') || '<无样本>')

  // ── V1②④：/health 亚秒（2s 超时零触发）────────────────────────────
  const probeFailures = settledProbes.filter((p) => !p.ok)
  const probeTimeouts = settledProbes.filter((p) => p.timedOut)
  ev.assert('V1②: /health 心跳真实发生（≥2 次，观测窗 ≥4s）', settledProbes.length >= 2, {
    channel: 'B',
    expected: 'probes ≥ 2',
    actual: `probes=${settledProbes.length} windowMs=${windowEndMs - windowStartMs}`,
  })
  ev.assert('V1②④: /health 全部 2xx 且零 2s 超时（亚秒返回操作判据）', probeFailures.length === 0 && probeTimeouts.length === 0, {
    channel: 'B',
    expected: '全部 ok，timedOut=0',
    actual: `ok=${settledProbes.length - probeFailures.length}/${settledProbes.length} timedOut=${probeTimeouts.length} maxElapsed=${Math.max(...settledProbes.map((p) => p.elapsedMs))}ms`,
  })
  ev.attach('v1-health-probes', settledProbes.map((p, i) => `#${i + 1} +${p.at - windowStartMs}ms ${p.elapsedMs}ms status=${p.status}${p.timedOut ? ' TIMEOUT' : ''}${p.error ? ` err=${p.error}` : ''}`).join('\n'))

  // ── V1③④：runtime 日志——重建 0 行 + 快照应答 0 行 ─────────────────
  const windowLines = readRuntimeLogWindow(dataDir, windowStartMs, windowEndMs)
  const snapshotReplyLines = windowLines.filter((l) => l.includes('query sync budget exceeded'))
  const rebuildLines = snapshotReplyLines.filter((l) => l.includes("'truncate-rebuild'") || l.includes('"truncate-rebuild"') || l.includes('truncate-rebuild'))
  ev.assert('V1④: 派生视图实例重建日志 0 行（truncate-rebuild 快照应答行）', rebuildLines.length === 0, {
    channel: 'B',
    expected: 'kind=truncate-rebuild 观测行 0 条（稳态零重建）',
    actual: `truncate-rebuild=${rebuildLines.length}（观测窗日志总行=${windowLines.length}）${rebuildLines.length > 0 ? '\n' + rebuildLines.slice(0, 5).join('\n') : ''}`,
  })
  ev.assert('V1④: 快照应答观测行 0 条（任一 kind——稳态预算内同步续读强口径）', snapshotReplyLines.length === 0, {
    channel: 'B',
    expected: 'query sync budget exceeded 观测行 0 条',
    actual: `snapshotReply=${snapshotReplyLines.length}${snapshotReplyLines.length > 0 ? '\n' + snapshotReplyLines.slice(0, 5).join('\n') : ''}`,
  })
  ev.attach('v1-log-window', `观测窗 ${new Date(windowStartMs).toISOString()} → ${new Date(windowEndMs).toISOString()}（日志行 ${windowLines.length} 条）\nsession-records 相关行：\n${windowLines.filter((l) => l.includes('[session-records]')).slice(0, 40).join('\n') || '<无>'}`)

  // run 行全文备查（steps/outcome/usedTokens 等派生字段证据）
  ev.attach('v1-run-row', JSON.stringify(lastRunRow, null, 2).slice(0, 20_000))

  log(`p0-projection-query-budget 完成：signals=${signalCount} pulls=${pullSamples.length} P95=${p95Ms}ms health=${settledProbes.length} probes`)
  return { uncovered: [], gotchas }
}
