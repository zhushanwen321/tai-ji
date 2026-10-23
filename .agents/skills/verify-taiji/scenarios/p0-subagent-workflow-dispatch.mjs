/**
 * p0-subagent-workflow-dispatch —— subagent 与 workflow 的执行层派发零 token 验收
 * （覆盖矩阵补剧本优先级 #2；由 scripts/probes/mock-llm-grandchild.mjs 与
 * mock-llm-workflow.mjs 两个探针合成，两个探针的实测结论是本剧本的可行性依据）。
 *
 * 装配：mock-http（本机 mock OpenAI 服务 + models.json 自定义 provider，零 token / 零外网 /
 * 零 extension）。faux 在孙进程不可达（faux-grandchild 探针结论 verified-unreachable），
 * 孙进程经 PI_CODING_AGENT_DIR 读同一份 models.json → mock-http 是执行域唯一的零 token 通道。
 *
 * 双段设计（同一实例、同一 mock server、两个独立 session）：
 *   段 A subagent——主队 step0 派发 subagent_start(model=mockllm/mock-sub-a)、step1 收尾、
 *     step2 完成通知轮；成员队 step0 吐 canary 文本。
 *   段 B workflow——主队 step3 派发 workflow_run(fanout-canary, model 覆盖)、step4 收尾、
 *     step5+ 通知/闲置备用轮；成员队 step1-8 全部是合法终局 structured-output 调用
 *     （两成员并发共享同一 model-keyed 队列，任何交错步都必须能独立收敛，否则
 *     schema_deterministic 失败——2026-10-21 探针实测教训）。
 *   段 B 开始前条件等待主队游标 ≥3（pending() 轮询，防段 A 通知轮未消费导致段 B 主轮错步）。
 *
 * 断言通道：B（getSubagents / getWorkflows / message.complete）+ C（canary 落盘、
 * mock.requests 出现成员模型请求 = 孙进程真的打到 mock 的铁证）。
 * 本剧本刻意不碰 UI（overlay / 面板归 p0-workflow-run 等 A 通道剧本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-canary.workflow.js')

const MAIN_MODEL = 'mock-1'
const SUB_MODEL = 'mock-sub-a'
const SUB_CANARY = 'GRANDCHILD_MOCK_CANARY_9c1d'
const WF_CANARY_PREFIX = 'FANOUT_MEMBER_STEP_'

/** 成员队 step0：段 A 的 canary 文本步；step1-8：段 B 的合法终局 structured-output 步。 */
const memberQueue = [
  { text: SUB_CANARY, stopReason: 'stop' },
  ...Array.from({ length: 8 }, (_, i) => ({
    toolCalls: [{ name: 'structured-output', args: { summary: `${WF_CANARY_PREFIX}${i}_CANARY` } }],
    stopReason: 'toolUse',
  })),
]

export const meta = {
  id: 'p0-subagent-workflow-dispatch',
  priority: 'P0',
  title: 'subagent 派发 + workflow fan-out 的执行层零 token 验收（mock-http 通道孙进程可达）',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'session.history', 'chat.send', 'chat.wait',
    'subagent.dispatch', 'subagent.list',
    'workflow.dispatch', 'workflow.runs',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 120,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: [
        {
          text: '派一个子任务去核对：',
          toolCalls: [
            {
              name: 'subagent_start',
              args: {
                task: 'Echo the canary word your scripted response contains, nothing else.',
                slug: 'mock-sub',
                model: `mockllm/${SUB_MODEL}`,
                fork: false,
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '子任务已派发，等待完成通知（SUBAGENT-DISPATCHED）。', stopReason: 'stop' },
        { text: 'parent-notified', stopReason: 'stop' },
        {
          text: '跑一个两路 fan-out 的 workflow：',
          toolCalls: [
            {
              name: 'workflow_run',
              args: {
                name: WORKFLOW_SCRIPT,
                model: `mockllm/${SUB_MODEL}`,
                args: { tasks: ['第一路：报出你剧本里的 canary', '第二路：报出你剧本里的 canary'] },
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: 'workflow 已派发，等待两路结果汇总（WORKFLOW-DISPATCHED）。', stopReason: 'stop' },
        { text: 'wf-parent-notified', stopReason: 'stop' },
        { text: 'parent-idle-1', stopReason: 'stop' },
        { text: 'parent-idle-2', stopReason: 'stop' },
      ],
      [`mockllm/${SUB_MODEL}`]: memberQueue,
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    'subagent 派发：session.getSubagents 出现 record 且走到终态（done/idle）',
    'subagent record 的模型 = 派发参数 mockllm/mock-sub-a（成员模型解析生效）',
    'canary 文本出现在 record / 子会话产物（孙进程真的产出了 mock 回复）',
    'workflow 派发：session.getWorkflows 出现 run 且 status=done',
    'run record 两成员 outcome=done 且 canary 摘要落盘',
    'mock.requests 出现 ≥3 条 model=mock-sub-a 请求（1 段 A + ≥2 段 B，孙进程打到 mock 的铁证）',
    '两段主轮都以 message.complete 收尾（主 agent 控制组吃到各自队列步）',
    '终局 run 的 subagent.setModel 被拒绝：failures 含该 runId 且 reason 含「已终局」（判终局断言执法，2026-10-23 D1-U3 直读改写后的行为锚）',
  ],
  notProvable: [
    'UI 面：workflow overlay / 托盘面板 / subagent 详情（A 通道，归后续 UI 剧本）',
    'workflow abort / reconnect（探针未覆盖，见覆盖矩阵已知空洞 #4/#9）',
    'subagent.session-observation（agent-managed session 托盘观测面，与 subagent record 是两族——本剧本只验 record 族）',
    'mock 回复无真实模型语义：编排质量、工具选择、真实耗时与 token 成本',
    'subagent.setModel 执行域热切（独立 capability，需要活 record + 网关接线）',
  ],
}

function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 递归读目录下所有文本文件（体积上限保护）。 */
function readTreeText(root, maxBytes = 4_000_000) {
  let total = 0
  const parts = []
  const walk = (dir, depth = 0) => {
    if (depth > 6 || total > maxBytes) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (total > maxBytes) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const st = fs.statSync(full, { throwIfNoEntry: false })
      if (!st || st.size > 2_000_000) continue
      const text = readTextFile(full)
      total += text.length
      parts.push(`# ${path.relative(root, full)}\n${text}`)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return parts.join('\n')
}

/** 条件轮询主队游标（pending 形态兼容 queueKey 带不带 provider 前缀两种）。 */
async function waitMainQueueConsumed(instance, minSteps, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = -1
  while (Date.now() < deadline) {
    const pending = instance.mockLlm?.pending() ?? {}
    last = Object.entries(pending)
      .filter(([k]) => k === MAIN_MODEL || k.endsWith(`/${MAIN_MODEL}`))
      .reduce((acc, [, v]) => Math.max(acc, Number(v) || 0), 0)
    if (last >= minSteps) return { ok: true, consumed: last }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, consumed: last }
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    '孙进程 faux 不可达（--no-extensions + 白名单扩展集），mock-http 是执行域唯一零 token 通道（SSOT：capabilities/env.md Gotchas + probes/faux-grandchild.mjs）',
    '成员队列每一步都必须是合法终局 structured-output 调用：两成员并发共享同一 model-keyed 队列，交错消费下「文本步」会让某成员命中 schema_deterministic 失败（探针实测教训）',
    'mock-http 游标是 per-model 单游标（mock server 进程持有，按请求到达序推进）不是 per-pi-进程：本剧本主队跨两段顺序消费、成员队跨两段共用，靠「段 B 前等主队游标 ≥3」衔接（API-CONTRACT L2）',
    '成员 outcome=done 之后的收尾轮会命中「剧本耗尽」HTTP 404（预期形态）；铁证断言只计 200，404 单列 stats',
    'models.json 的 apiKey 必须是字面量（pi 把 $VAR 当 env 模板、!cmd 当命令）',
  ]

  if (!fs.existsSync(WORKFLOW_SCRIPT)) {
    ev.assert('夹具：fanout-canary.workflow.js 在盘', false, {
      channel: 'C',
      expected: WORKFLOW_SCRIPT,
      actual: '文件不存在',
    })
    return { uncovered: ['workflow 夹具缺失，剧本中止'], gotchas }
  }

  // 装配自检：models.json 里的 mock provider 指向本机 mock 服务（否则后续不可达与通道无关）
  const topo = instance.llm
  const modelsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  const subCfg = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'subagents', 'config.json')) || '{}')
  ev.assert('装配：孙进程缺省模型 = mock-sub-a（subagents/config.json engineDefaults.pi）', String(subCfg.engineDefaults?.pi ?? '').includes(SUB_MODEL), {
    channel: 'C',
    expected: `engineDefaults.pi 含 ${SUB_MODEL}`,
    actual: subCfg.engineDefaults?.pi ?? '<缺>',
  })

  // ══ 段 A：subagent 派发 ══════════════════════════════════════
  const createdA = await protocol.call('session.create', { cwd: repo, label: 'p0-subagent' }, { timeoutMs: 120_000 })
  const sidA = createdA.session?.id
  ev.assert('A: session.create A 返回 sessionId', Boolean(sidA), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createdA.session ?? {}).slice(0, 300),
  })
  await protocol.subscribe(sidA)
  log(`段 A session=${sidA} model=${createdA.session?.modelId}`)
  ev.step({ step: 'session.create.A', channel: 'B', exitCode: 0, stats: { sessionId: sidA, modelId: createdA.session?.modelId } })

  const sinceA = protocol.events.length
  await protocol.send(sidA, 'dispatch one subagent (p0-subagent-workflow-dispatch 段 A)')
  const endA = await protocol.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
  ev.assert('A① 主轮完成（message.complete 非 error）', endA.type === 'message.complete' && endA.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endA.type} stop=${endA.payload?.stopReason ?? 'n/a'} msg=${String(endA.payload?.message ?? '').slice(0, 200)}`,
  })
  const histA = await protocol.history(sidA, { limitTurns: 10 })
  ev.assert('A 控制组：主会话文本来自主队剧本（SUBAGENT-DISPATCHED）', JSON.stringify(histA.messages ?? []).includes('SUBAGENT-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 SUBAGENT-DISPATCHED',
    actual: `messages=${(histA.messages ?? []).length}`,
  })

  // 等 record 终态（条件轮询）
  const deadlineA = Date.now() + 180_000
  let records = []
  let record = null
  while (Date.now() < deadlineA) {
    const reply = await protocol.call('session.getSubagents', { sessionId: sidA }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === 'mock-sub') ?? records[0] ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ev.step({
    step: 'subagent.observe', channel: 'B', exitCode: 0,
    stats: { count: records.length, status: record?.status, model: record?.model, stopReason: record?.stopReason },
  })
  ev.assert('A② record 走到终态（done/idle）', ['done', 'idle'].includes(String(record?.status)), {
    channel: 'B',
    expected: 'status ∈ {done, idle}',
    actual: `status=${record?.status} stopReason=${record?.stopReason} error=${String(record?.error ?? '').slice(0, 200)}`,
  })
  ev.assert('A record 模型 = 派发参数（成员模型解析生效）', String(record?.model ?? '').includes(SUB_MODEL), {
    channel: 'B',
    expected: `record.model 含 ${SUB_MODEL}`,
    actual: record?.model ?? '<缺>',
  })
  ev.attach('subagent-records', JSON.stringify(records, null, 2).slice(0, 40_000))

  // C 通道：canary 在 record / 子会话产物
  const subagentsTree = path.join(dataDir, 'ext-sessions', String(sidA), 'subagents')
  const diskText = readTreeText(subagentsTree)
  ev.assert('A③ canary 出现在子代理产物（record/子会话树）', diskText.includes(SUB_CANARY), {
    channel: 'C',
    expected: `subagents 树含 ${SUB_CANARY}`,
    actual: `bytes=${diskText.length} hit=${diskText.includes(SUB_CANARY)}`,
  })
  const stderrFiles = fs.existsSync(path.join(dataDir, 'logs'))
    ? fs.readdirSync(path.join(dataDir, 'logs')).filter((f) => f.startsWith('pi-task-stderr-'))
    : []
  ev.attach('grandchild-stderr', stderrFiles.map((f) => `# ${f}\n${readTextFile(path.join(dataDir, 'logs', f))}`).join('\n') || '(无 pi-task-stderr-*.log)')
  ev.attach('subagents-disk', diskText.slice(0, 120_000))

  // ══ 段间衔接：等段 A 的完成通知轮把主队游标推到 step3 ══════════
  // fail-fast：衔接失败继续跑段 B 会产出「B① 假 pass + 后续连环错步失败」的误导组合，
  // 归因噪音大于增量证据（契约红线 5：失败要能定位到一步），此处直接终止并固化现场。
  const queue = await waitMainQueueConsumed(instance, 3, 90_000)
  if (!queue.ok) {
    ev.attach('pending-snapshot', JSON.stringify(instance.mockLlm?.pending() ?? {}, null, 2))
    ev.attach('mock-requests', JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })), null, 2))
    ev.assert('衔接：段 A 通知轮已消费主队前 3 步（防段 B 主轮错步）', false, {
      channel: 'C',
      expected: 'mock-1 队列已消费 ≥3 步',
      actual: `consumed=${queue.consumed}（pending 与请求记录见附件；主队游标未推进 = 完成通知轮未发生或未消费）`,
    })
    return { uncovered: ['衔接失败：段 B 未执行（防错步消费的误导性失败组合）'], gotchas }
  }
  ev.assert('衔接：段 A 通知轮已消费主队前 3 步', true, {
    channel: 'C',
    expected: 'mock-1 队列已消费 ≥3 步',
    actual: `consumed=${queue.consumed}`,
  })

  // ══ 段 B：workflow fan-out 派发 ══════════════════════════════
  const createdB = await protocol.call('session.create', { cwd: repo, label: 'p0-workflow' }, { timeoutMs: 120_000 })
  const sidB = createdB.session?.id
  await protocol.subscribe(sidB)
  log(`段 B session=${sidB}`)
  ev.step({ step: 'session.create.B', channel: 'B', exitCode: 0, stats: { sessionId: sidB } })

  const sinceB = protocol.events.length
  await protocol.send(sidB, 'run the canary workflow (段 B)')
  const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
  ev.assert('B① 主轮完成（message.complete 非 error）', endB.type === 'message.complete' && endB.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endB.type} stop=${endB.payload?.stopReason ?? 'n/a'}`,
  })
  const histB = await protocol.history(sidB, { limitTurns: 10 })
  ev.assert('B 控制组：主会话文本来自主队 step4（WORKFLOW-DISPATCHED）', JSON.stringify(histB.messages ?? []).includes('WORKFLOW-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 WORKFLOW-DISPATCHED',
    actual: `messages=${(histB.messages ?? []).length}`,
  })

  // 等 run 终态（条件轮询）
  const deadlineB = Date.now() + 180_000
  let runs = []
  while (Date.now() < deadlineB) {
    const reply = await protocol.call('session.getWorkflows', { sessionId: sidB }, { timeoutMs: 60_000 })
    runs = reply.workflows ?? []
    if (runs.length > 0 && runs.every((r) => !['running', 'pending'].includes(String(r.status)))) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  const run = runs.find((r) => String(r.workflowName ?? '').includes('fanout-canary')) ?? runs[0] ?? null
  ev.step({ step: 'workflow.observe', channel: 'B', exitCode: 0, stats: { count: runs.length, status: run?.status, runId: run?.runId } })
  ev.assert('B② run status=done', run?.status === 'done', {
    channel: 'B',
    expected: 'status=done',
    actual: `status=${run?.status} runId=${run?.runId} name=${run?.workflowName}`,
  })
  ev.attach('workflow-runs', JSON.stringify(runs, null, 2).slice(0, 60_000))

  // C 通道：record 两成员 outcome=done + canary 摘要
  const recDir = path.join(dataDir, 'ext-sessions', String(sidB), 'workflow', 'runs')
  const recFiles = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.record.jsonl')) : []
  const recordText = recFiles.map((f) => `# ${f}\n${readTextFile(path.join(recDir, f))}`).join('\n')
  const memberOutcomes = recordText
    .split('\n')
    .map((l) => {
      try {
        const o = JSON.parse(l)
        return o?.type === 'agent-settled' ? { taskIndex: o.taskIndex, outcome: o.outcome } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const canaryMarkers = [...new Set([...recordText.matchAll(new RegExp(`${WF_CANARY_PREFIX}\\d+_CANARY`, 'g'))].map((m) => m[0]))]
  ev.step({
    step: 'workflow.record', channel: 'C', exitCode: 0,
    stats: { recordFiles: recFiles.length, members: JSON.stringify(memberOutcomes), canary: canaryMarkers.length },
  })
  ev.assert('B③ 两成员 outcome=done', memberOutcomes.length >= 2 && memberOutcomes.every((m) => m.outcome === 'done'), {
    channel: 'C',
    expected: '2 × agent-settled outcome=done',
    actual: JSON.stringify(memberOutcomes),
  })
  ev.assert('B③ canary 摘要落 record（≥2 个不同标记）', canaryMarkers.length >= 2, {
    channel: 'C',
    expected: '≥2 个 FANOUT_MEMBER_STEP_N_CANARY',
    actual: canaryMarkers.join(', ') || '(无)',
  })
  ev.attach('workflow-records', recordText.slice(0, 200_000))

  // ══ 铁证：mock 服务端收到的成员模型请求 ═══════════════════════
  // 只计 HTTP 200：成员 done 后的收尾轮会命中「剧本耗尽」404（预期形态），混入计数会稀释
  // 「孙进程真的跑到 LLM」的断言强度；404 单列 stats 供核对。
  const allRequests = instance.mockLlm?.requests ?? []
  const childRequests = allRequests.filter((r) => r.model === SUB_MODEL)
  const childOk = childRequests.filter((r) => r.status === 200)
  const child404 = childRequests.filter((r) => r.status !== 200)
  ev.step({
    step: 'mock.requests', channel: 'C', exitCode: 0,
    stats: {
      total: allRequests.length,
      main: allRequests.filter((r) => r.model === MAIN_MODEL).length,
      childOk: childOk.length,
      child404: child404.length,
      models: [...new Set(allRequests.map((r) => r.model))].join(','),
    },
  })
  ev.assert('铁证：mock 收到 ≥3 条成员模型的有效请求（200；段 A 1 + 段 B ≥2）', childOk.length >= 3, {
    channel: 'C',
    expected: `≥3 × model=${SUB_MODEL} status=200`,
    actual: `${childOk.length} 条 200（steps=${childOk.map((r) => r.stepIndex).join(',')}）+ ${child404.length} 条非 200（耗尽收尾轮，预期）`,
  })
  ev.attach(
    'mock-requests',
    JSON.stringify(
      allRequests.map((r) => ({ model: r.model, status: r.status, queueKey: r.queueKey, stepIndex: r.stepIndex, messageCount: r.messageCount, error: r.error })),
      null,
      2,
    ).slice(0, 120_000),
  )

  // ══ 段 C：setModel 对终局 run 拒绝 ═══════════════════════════
  // B② 已实证 run status=done（journal 存在 run-settled 帧）。此时 run 级 setModel
  // 必须被拒绝（failures 含该 runId，reason 指向「已终局…不可切换」）——终局 run 的
  // 模型覆盖改写是被判终局断言拦截的（assertRunNotTerminalForSwitch，直读 findRunSettledEvent）。
  let setReply = null
  let setErr = ''
  try {
    setReply = await protocol.call(
      'subagent.setModel',
      { runId: run.runId, provider: topo.providerId, modelId: SUB_MODEL },
      { replyType: 'subagent.modelSet', timeoutMs: 60_000 },
    )
  } catch (e) {
    setErr = String(e?.message ?? e)
  }
  const failure = (setReply?.failures ?? []).find((f) => f.runId === run.runId)
  // 拒绝到达的两种合法形态（capabilities/model.md 三形态判别 + 宿主分型码透传）：
  // ① 回执 failures 组件含已终局 reason；② RPC error（subagent_model_switch_failed 分型）message 含已终局文案
  const rejectedViaFailures = Boolean(failure) && /已终局/.test(String(failure?.reason ?? ''))
  const rejectedViaRpcError = /subagent_model_switch_failed/.test(setErr) && /已终局/.test(setErr)
  ev.assert('C① 终局 run 的 setModel 被拒绝（failures 组件或 RPC error 含已终局语义）', rejectedViaFailures || rejectedViaRpcError, {
    channel: 'B',
    expected: `failures 含 runId=${run.runId} 且 reason 含「已终局」，或 RPC error（subagent_model_switch_failed）含「已终局」文案`,
    actual: setErr
      ? `RPC error: ${setErr.slice(0, 300)}`
      : JSON.stringify({ members: setReply?.members, failures: setReply?.failures, summary: setReply?.summary }).slice(0, 400),
  })

  log(`done sidA=${sidA} sidB=${sidB} childOk=${childOk.length} child404=${child404.length}`)
  return { uncovered, gotchas }
}
