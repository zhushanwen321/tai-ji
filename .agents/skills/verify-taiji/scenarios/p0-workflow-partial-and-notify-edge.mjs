/**
 * p0-workflow-partial-and-notify-edge —— run 终局吸收成员交付（partially_succeeded 第五值）
 * 与攒批窗退役后通知消费表面（即时单条 / 同组批注到达）的双段零 token 验收。
 *
 * 对应设计（subagent-observability）验收场景 2（§3.3.8）+ 场景 6（§3.3.7③ 消费表面反向），
 * 两段同实例衔接（验收计划已裁决可合并）。装配通道 = mock-http（孙进程唯一零 token 通道，
 * faux 在 `--no-extensions` 孙进程不可达——SSOT：capabilities/env.md + probes/faux-grandchild.mjs）。
 *
 * 双段设计（同一实例、同一 mock server、两个独立 session，形态同构 p0-subagent-workflow-dispatch）：
 *   段 1（A2 场景 2）——主队 step0 派发 workflow_run(fanout-partial, model 覆盖)、step1 收尾、
 *     step2 完成通知轮；成员队 step0 =「无 structured-output 调用的文本轮」（错误轮）+
 *     step1 = 合法 structured_output 终局。两成员并发共享 model-keyed 单游标，抢到文本轮的
 *     成员以 agent.no_deliverable 失败、另一成员正常交付，run 终局派生 partially_succeeded。
 *   段 2（A6 场景 6）——主队 step3 派发 subagents 双成员批量（one-shot 域）、step4 收尾、
 *     step5-7 通知触发轮/闲置备用；成员队 step2-5 全部是合法 structured_output 终局
 *     （并发交错安全——任何成员拿任何步都必须能独立收敛，2026-10-21 探针实测教训）。
 *   段 2 开始前条件等待主队游标 ≥3（waitMainQueueConsumed，fail-fast 形态同范本）。
 *
 * 断言通道：B（getWorkflows / message.customStart 通知事件）+ C（workflow runs record journal、
 * mock.requests 成员模型请求 = 孙进程真的打到 mock 的铁证）。本剧本刻意不碰 UI。
 *
 * 通知消费表面的可观测锚（源码核实）：
 *   - 通知注入 = pi custom message（customType=subagent-bg-notify）→ runtime event-adapter
 *     广播 `message.customStart`（payload 带 sessionId/customType/details）→ protocol.events
 *     带 receivedAt（剧本进程墙钟）；
 *   - 成员轮终锚 = record journal agent-settled 帧的 ts（EventEnvelope，引擎写侧 epoch ms）；
 *   - 攒批窗退役后 deliver 边沿即投：每条 deliver 同步经 pumpDirect 泵出（extensions/shared/
 *     delivery-port/src/delivery-port.ts routeAcceptedDelivery），两条独立到达的通知恒产两条
 *     单条消息；真 {batch:true} 批消息只产自保留边界路径（recover 重放 / collectRelease 直通 /
 *     compaction 唤醒 / 内核留存合并）——单实例剧本内不可确定性编排（见 meta.notProvable）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-partial.workflow.js')

const MAIN_MODEL = 'mock-1'
const SUB_MODEL = 'mock-sub-a'
/** 段 1 失败成员的错误轮标记（文本轮、无 structured-output 调用 → agent.no_deliverable）。 */
const PARTIAL_ERROR_MARKER = 'PARTIAL_MEMBER_ERROR_ROUND'
/** 段 1 成功成员的交付 canary（structured-output summary）。 */
const PARTIAL_OK_CANARY = 'PARTIAL_MEMBER_OK_CANARY'
/** 段 2 双成员的交付 canary（哪个成员拿哪步不定，断言只要求两个标记都落 record）。 */
const NOTIFY_EDGE_CANARY_A = 'NOTIFY_EDGE_MEMBER_A_CANARY'
const NOTIFY_EDGE_CANARY_B = 'NOTIFY_EDGE_MEMBER_B_CANARY'

/** 段 1 成员队：step0 错误轮（无 SO 调用）+ step1 合法 SO 终局。两成员并发抢队，恰 1 败 1 成。 */
const partialMemberQueue = [
  { text: `${PARTIAL_ERROR_MARKER}: mock provider failure text; structured output intentionally not called.`, stopReason: 'stop' },
  { toolCalls: [{ name: 'structured-output', args: { summary: PARTIAL_OK_CANARY } }], stopReason: 'toolUse' },
]
/** 段 2 成员队：全部是合法终局 structured-output 步（并发交错安全）+ 2 步 slack。 */
const notifyEdgeMemberQueue = [
  { toolCalls: [{ name: 'structured-output', args: { summary: NOTIFY_EDGE_CANARY_A } }], stopReason: 'toolUse' },
  { toolCalls: [{ name: 'structured-output', args: { summary: NOTIFY_EDGE_CANARY_B } }], stopReason: 'toolUse' },
  { toolCalls: [{ name: 'structured-output', args: { summary: 'NOTIFY_EDGE_MEMBER_SLACK_1' } }], stopReason: 'toolUse' },
  { toolCalls: [{ name: 'structured-output', args: { summary: 'NOTIFY_EDGE_MEMBER_SLACK_2' } }], stopReason: 'toolUse' },
]

export const meta = {
  id: 'p0-workflow-partial-and-notify-edge',
  priority: 'P0',
  title: 'fan-out 半数失败 → partially_succeeded（场景 2）+ 攒批窗退役后通知消费表面（场景 6）双段验收',
  covers: [
    'env.launch', 'env.ready',
    'session.create', 'session.history', 'chat.send', 'chat.wait',
    'subagent.dispatch', 'subagent.list',
    'workflow.dispatch', 'workflow.runs',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 180,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: [
        {
          text: '跑一个会部分失败的 fan-out workflow（段 1）：',
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
        { text: 'partial workflow 已派发，等待收尾通知（PARTIAL-WF-DISPATCHED）。', stopReason: 'stop' },
        { text: 'partial-parent-notified', stopReason: 'stop' },
        {
          text: '批量派两个一次性后台成员（段 2）：',
          toolCalls: [
            {
              name: 'subagents',
              args: {
                tasks: ['通知边沿 A 路：报出你剧本里的 canary', '通知边沿 B 路：报出你剧本里的 canary'],
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '批量已派发，等待成员完成通知（NOTIFY-EDGE-BATCH-DISPATCHED）。', stopReason: 'stop' },
        { text: 'batch-parent-notified-1', stopReason: 'stop' },
        { text: 'batch-parent-notified-2', stopReason: 'stop' },
        { text: 'parent-idle-final', stopReason: 'stop' },
      ],
      [`mockllm/${SUB_MODEL}`]: [...partialMemberQueue, ...notifyEdgeMemberQueue],
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    'A2① fanout-partial 夹具 allSettled 吸收成员失败正常收尾：workflow_run 受理且 run 出现',
    'A2② session.getWorkflows 的 run 终局 = partially_succeeded（RunOutcome 第五值词表；outcome/reason 任一承载）',
    'A2③ record journal run-settled 帧 outcome=partially_succeeded 且 failedMembers 恰含 1 条 {taskIndex, cause}（cause 为 class.kind 点拼形态）',
    'A2③ 成员结算对账：agent-settled 恰 1 × done + 1 × failed；成功成员 canary 与失败成员错误轮文本都落 record',
    'A2④ 铁证：mock 收到 ≥2 条成员模型有效请求（200，孙进程打到 mock）',
    'A6⑤ 即时单条：成员轮终（journal agent-settled ts）→ 完成通知事件到达（message.customStart receivedAt）时差 ≤1s',
    'A6⑥ 同组批注到达：≥2 条同组（subagent-bg-notify）通知在同一观测窗到达，每条 details 为可解析的单条形态（消费表面不因窗口删除报错）',
    '两段主轮都以 message.complete 收尾；段 2 前主队游标衔接 fail-fast',
  ],
  notProvable: [
    'UI 面：workflow overlay / 托盘面板 / 通知气泡渲染（A 通道，归 UI 剧本）',
    '真 {batch:true} 批消息形态（buildBatchPayload 产物）：边沿即投后 pumpDirect 逐条泵出（每条 deliver 同步泵），单实例剧本内不可确定性生产；批形态保留边界（recover 重放 / collectRelease 直通 / compaction 唤醒 / 内核留存合并）由 u4 行为锁测试与下一条的 recover 支承载',
    'recover 重放支（kill/重启后 journal 差集重放产批形态）由 u4 行为锁测试承载（delivery-port.test.ts recover 重放断言），本剧本不覆盖',
    'mock 回复无真实模型语义：编排质量、真实耗时与 token 成本',
    'A6⑤ 的 1s 预算是「无 60s 量级攒批延迟」的判据，不是通知链路延迟的精确基线（含 WS 转发与剧本轮询噪声）',
  ],
}

function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 条件轮询主队游标（pending 形态兼容 queueKey 带不带 provider 前缀两种；范本同款）。
 * 段 2 派发前要求主队已消费 ≥minSteps 步，防段 1 通知轮未消费导致段 2 主轮错步。
 */
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

/**
 * 条件轮询事件队列：等谓词命中数 ≥minCount（事件队列只追加，since 之前的不计）。
 * 返回命中事件切片（含 receivedAt），超时返回 null。
 */
async function waitForEventCount(protocol, predicate, minCount, since, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hits = protocol.events.slice(since).filter(predicate)
    if (hits.length >= minCount) return hits
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * 条件轮询 record journal：等目录下 record.jsonl 里谓词命中的帧数 ≥minCount。
 * 返回全部解析成功的帧（供断言复用），超时返回 null。
 */
async function waitForRecordFrames(recDir, predicate, minCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frames = readRecordFrames(recDir)
    const hits = frames.filter(predicate)
    if (hits.length >= minCount) return frames
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 读目录下全部 *.record.jsonl 并逐行解析（坏行跳过；行形态 = {type, ts, seq, ...}）。 */
function readRecordFrames(recDir) {
  const files = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.record.jsonl')) : []
  const frames = []
  for (const f of files) {
    const text = readTextFile(path.join(recDir, f))
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o && typeof o === 'object' && typeof o.type === 'string') frames.push(o)
      } catch {
        /* 坏行跳过（与 tail 契约一致，宽容不炸） */
      }
    }
  }
  return frames
}

/**
 * 通知 details 的单条形态防御解析（判据对齐 shared parseBgNotifyDetails 的
 * BgNotifyRecord 必需字段，剧本内手工实现不 import TS）：id/status/agent/startedAt
 * 齐全 = 单条形态；batch=true + items 数组 = 批形态（本剧本预期不出现，出现则如实报告）。
 */
function parseNotifyDetailsShape(details) {
  if (!details || typeof details !== 'object') return { form: 'unparsed' }
  if (details.batch === true && Array.isArray(details.items)) {
    return { form: 'batch', items: details.items.length }
  }
  const ok =
    typeof details.id === 'string' && details.id.length > 0 &&
    ['done', 'failed', 'cancelled', 'closed', 'running'].includes(details.status) &&
    typeof details.agent === 'string' && details.agent.length > 0 &&
    typeof details.startedAt === 'number'
  return ok
    ? { form: 'single', id: details.id, status: details.status, agent: details.agent }
    : { form: 'unparsed' }
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  // ⑦ recover 重放支：单实例剧本不可 kill/restart 实例，禁止硬凑（任务书明示落 uncovered 登记）。
  uncovered.push(
    'recover 重放支（kill/重启后 journal 差集重放产批形态）未编排——单实例剧本内不可 kill/restart 实例；由 u4 行为锁测试承载（delivery-port.test.ts recover 重放断言），本剧本不覆盖',
  )
  const gotchas = [
    '孙进程 faux 不可达（--no-extensions + 白名单扩展集），mock-http 是执行域唯一零 token 通道（SSOT：capabilities/env.md Gotchas + probes/faux-grandchild.mjs）',
    '成员队列每一步都必须能独立收敛（合法终局 structured-output 或明确的错误轮）：两成员并发共享同一 model-keyed 单游标，交错消费下「半合法队列」会让失败计数随机（探针实测教训）；本剧本段 1 恰用这一点做确定性失败注入——队列首步 = 无 SO 调用的文本轮，抢到的成员以 agent.no_deliverable 失败',
    'mock-http 的 stopReason:"error" 步不会产 provider 级错误轮：mock server 把 error 文本写成正文 + finish stop（lib/mock-llm.mjs planFrames），成员照常收尾——「错误轮」在本通道只能以「终局未调 structured-output」形态注入',
    'A6⑤ 测量口径：轮终锚 = record journal agent-settled 帧 ts（引擎写侧 epoch ms）；通知到达锚 = protocol.events 的 message.customStart receivedAt（剧本进程墙钟）。两者同机时钟直接可比，差值含 pi 注入 + runtime 广播 + WS 转发 + 剧本轮询的链路噪声（数百 ms 量级）；1s 预算的判据本质 = 不出现攒批窗退役前 60s 量级的无上界推迟',
    'A6⑥ 的「同批」断言口径：边沿即投后每条 deliver 同步经 pumpDirect 泵出，两条独立到达的通知恒产两条单条消息（delivery-port.ts routeAcceptedDelivery 源码核实）；真 {batch:true} 批消息只产自保留边界路径（recover 重放 / collectRelease 直通 / compaction 唤醒 / 内核留存合并），单实例剧本内不可确定性编排——本剧本断言「同组两条通知同窗全部到达 + 逐条单条形态可解析」，批形态兼容读的事实判据 = shared parseBgNotifyDetails 保留 {batch:true, items} 展开分支（消费存量 session 数据），由 u4 行为锁测试锁定',
    '成员 outcome=done 之后的收尾轮会命中「剧本耗尽」HTTP 404（预期形态）；铁证断言只计 200，404 单列 stats',
    'models.json 的 apiKey 必须是字面量（pi 把 $VAR 当 env 模板、!cmd 当命令）',
  ]

  if (!fs.existsSync(WORKFLOW_SCRIPT)) {
    ev.assert('夹具：fanout-partial.workflow.js 在盘', false, {
      channel: 'C',
      expected: WORKFLOW_SCRIPT,
      actual: '文件不存在',
    })
    return { uncovered: ['workflow 夹具缺失，剧本中止', ...uncovered], gotchas }
  }

  // 装配自检：models.json 里的 mock provider 指向本机 mock 服务；孙进程缺省模型 = 成员演员
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

  // ══ 段 1：A2 —— fan-out 半数失败 → partially_succeeded ══════════
  const created1 = await protocol.call('session.create', { cwd: repo, label: 'p0-workflow-partial' }, { timeoutMs: 120_000 })
  const sid1 = created1.session?.id
  ev.assert('A2: session.create 段 1 返回 sessionId', Boolean(sid1), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created1.session ?? {}).slice(0, 300),
  })
  await protocol.subscribe(sid1)
  log(`段 1 session=${sid1} model=${created1.session?.modelId}`)
  ev.step({ step: 'session.create.partial', channel: 'B', exitCode: 0, stats: { sessionId: sid1, modelId: created1.session?.modelId } })

  const since1 = protocol.events.length
  await protocol.send(sid1, 'run the partial-failure workflow (段 1)')
  const end1 = await protocol.waitTurnEnd(sid1, { since: since1, timeoutMs: 180_000 })
  ev.assert('A2① 主轮完成（message.complete 非 error）', end1.type === 'message.complete' && end1.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'} msg=${String(end1.payload?.message ?? '').slice(0, 200)}`,
  })
  const hist1 = await protocol.history(sid1, { limitTurns: 10 })
  ev.assert('A2 控制组：主会话文本来自主队 step1（PARTIAL-WF-DISPATCHED）', JSON.stringify(hist1.messages ?? []).includes('PARTIAL-WF-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 PARTIAL-WF-DISPATCHED',
    actual: `messages=${(hist1.messages ?? []).length}`,
  })

  // 等 run 终态（条件轮询；同范本形态）
  const deadlineRun = Date.now() + 180_000
  let runs = []
  while (Date.now() < deadlineRun) {
    const reply = await protocol.call('session.getWorkflows', { sessionId: sid1 }, { timeoutMs: 60_000 })
    runs = reply.workflows ?? []
    if (runs.length > 0 && runs.every((r) => !['running', 'pending'].includes(String(r.status)))) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  const run1 = runs.find((r) => String(r.workflowName ?? r.scriptName ?? '').includes('fanout-partial')) ?? runs[0] ?? null
  ev.step({
    step: 'workflow.observe.partial', channel: 'B', exitCode: 0,
    stats: { count: runs.length, status: run1?.status, outcome: run1?.outcome, reason: run1?.reason, runId: run1?.runId },
  })
  ev.assert('A2① workflow_run 受理：fanout-partial run 出现', Boolean(run1), {
    channel: 'B',
    expected: 'getWorkflows 含 fanout-partial run',
    actual: `runs=${runs.length} names=${runs.map((r) => r.workflowName ?? r.scriptName ?? '?').join(',')}`,
  })
  // A2②：run 终局 = partially_succeeded（第五值词表）。outcome（WorkflowRunOutcome）与
  // reason（WorkflowDoneReason）是两个镜像承载位，任一命中即第五值已传导到派生视图。
  const terminalVocab = run1?.outcome ?? run1?.reason
  ev.assert('A2② run 终局 = partially_succeeded（第五值词表）', run1?.status === 'done' && terminalVocab === 'partially_succeeded', {
    channel: 'B',
    expected: "status=done 且 outcome/reason=partially_succeeded",
    actual: `status=${run1?.status} outcome=${String(run1?.outcome ?? '<缺>')} reason=${String(run1?.reason ?? '<缺>')} runId=${run1?.runId}`,
  })
  ev.attach('workflow-runs-partial', JSON.stringify(runs, null, 2).slice(0, 60_000))

  // A2③：record journal 对账（C 通道）。run-settled 帧的 outcome 与 failedMembers 是
  // §3.3.8 的权威落盘面；agent-settled 帧对账成员结算集合（恰 1 done + 1 failed）。
  const recDir1 = path.join(dataDir, 'ext-sessions', String(sid1), 'workflow', 'runs')
  const frames1 = await waitForRecordFrames(recDir1, (f) => f.type === 'run-settled', 1, 180_000)
  const recordText1 = frames1.length > 0
    ? fs.existsSync(recDir1)
      ? fs.readdirSync(recDir1).filter((f) => f.endsWith('.record.jsonl')).map((f) => `# ${f}\n${readTextFile(path.join(recDir1, f))}`).join('\n')
      : ''
    : ''
  ev.step({
    step: 'workflow.record.partial', channel: 'C', exitCode: frames1 ? 0 : 1,
    stats: { frames: frames1.length, runSettled: frames1.filter((f) => f.type === 'run-settled').length, agentSettled: frames1.filter((f) => f.type === 'agent-settled').length },
  })
  const settledFrame = frames1.find((f) => f.type === 'run-settled') ?? null
  const failedMembers = Array.isArray(settledFrame?.failedMembers) ? settledFrame.failedMembers : []
  const causeShapeRe = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/
  ev.assert('A2③ run-settled 帧 outcome=partially_succeeded', settledFrame?.outcome === 'partially_succeeded', {
    channel: 'C',
    expected: "run-settled.outcome=partially_succeeded",
    actual: `outcome=${String(settledFrame?.outcome ?? '<缺帧>')} errorCode=${String(settledFrame?.errorCode ?? '<缺>')}`,
  })
  ev.assert(
    'A2③ failedMembers 恰含 1 条 {taskIndex, cause}（cause 为 class.kind 点拼形态）',
    failedMembers.length === 1 &&
      typeof failedMembers[0]?.taskIndex === 'number' &&
      typeof failedMembers[0]?.cause === 'string' &&
      causeShapeRe.test(failedMembers[0].cause),
    {
      channel: 'C',
      expected: 'failedMembers=[{taskIndex:number, cause:"<class>.<kind>"}]（恰 1 条；cancelled 成员不进失败明细）',
      actual: JSON.stringify(failedMembers),
    },
  )
  const memberSettles = frames1
    .filter((f) => f.type === 'agent-settled')
    .map((f) => ({ taskIndex: f.taskIndex, outcome: f.outcome }))
  ev.assert('A2③ 成员结算对账：恰 1 × done + 1 × failed', memberSettles.length === 2 && memberSettles.filter((m) => m.outcome === 'done').length === 1 && memberSettles.filter((m) => m.outcome === 'failed').length === 1, {
    channel: 'C',
    expected: 'agent-settled × 2（done=1, failed=1）',
    actual: JSON.stringify(memberSettles),
  })
  ev.assert('A2③ 成功成员 canary 落 record（PARTIAL_MEMBER_OK_CANARY）', recordText1.includes(PARTIAL_OK_CANARY), {
    channel: 'C',
    expected: `record 含 ${PARTIAL_OK_CANARY}`,
    actual: `bytes=${recordText1.length} hit=${recordText1.includes(PARTIAL_OK_CANARY)}`,
  })
  ev.assert('A2③ 失败成员错误轮文本落 record（失败不是静默的）', recordText1.includes(PARTIAL_ERROR_MARKER), {
    channel: 'C',
    expected: `record 含 ${PARTIAL_ERROR_MARKER}（错误轮正文进成员 record）`,
    actual: `hit=${recordText1.includes(PARTIAL_ERROR_MARKER)}`,
  })
  ev.attach('workflow-records-partial', recordText1.slice(0, 200_000))

  // A2④：铁证——mock 服务端收到的成员模型有效请求（段 1 末统计，只计 200）。
  const childRequests1 = (instance.mockLlm?.requests ?? []).filter((r) => r.model === SUB_MODEL)
  const childOk1 = childRequests1.filter((r) => r.status === 200)
  ev.step({
    step: 'mock.requests.partial', channel: 'C', exitCode: 0,
    stats: { childOk: childOk1.length, child404: childRequests1.length - childOk1.length },
  })
  ev.assert('A2④ 铁证：mock 收到 ≥2 条成员模型有效请求（200；1 错误轮 + 1 SO 终局）', childOk1.length >= 2, {
    channel: 'C',
    expected: `≥2 × model=${SUB_MODEL} status=200`,
    actual: `${childOk1.length} 条 200（steps=${childOk1.map((r) => r.stepIndex).join(',')}）+ ${childRequests1.length - childOk1.length} 条非 200`,
  })

  // ══ 段间衔接：等段 1 的完成通知轮把主队游标推到 step3（范本同款 fail-fast）═════
  // 衔接失败继续跑段 2 会产出「段 2 主轮错步 + 通知面混淆」的误导组合，直接终止并固化现场。
  const queue = await waitMainQueueConsumed(instance, 3, 90_000)
  if (!queue.ok) {
    ev.attach('pending-snapshot', JSON.stringify(instance.mockLlm?.pending() ?? {}, null, 2))
    ev.attach('mock-requests', JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })), null, 2))
    ev.assert('衔接：段 1 通知轮已消费主队前 3 步（防段 2 主轮错步）', false, {
      channel: 'C',
      expected: 'mock-1 队列已消费 ≥3 步',
      actual: `consumed=${queue.consumed}（pending 与请求记录见附件；主队游标未推进 = 段 1 完成通知轮未发生或未消费）`,
    })
    return { uncovered: ['衔接失败：段 2 未执行（防错步消费的误导性失败组合）', ...uncovered], gotchas }
  }
  ev.assert('衔接：段 1 通知轮已消费主队前 3 步', true, {
    channel: 'C',
    expected: 'mock-1 队列已消费 ≥3 步',
    actual: `consumed=${queue.consumed}`,
  })

  // ══ 段 2：A6 —— 攒批窗退役后通知消费表面（即时单条 + 同组批注到达）══════════
  const created2 = await protocol.call('session.create', { cwd: repo, label: 'p0-notify-edge' }, { timeoutMs: 120_000 })
  const sid2 = created2.session?.id
  ev.assert('A6: session.create 段 2 返回 sessionId', Boolean(sid2), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created2.session ?? {}).slice(0, 300),
  })
  await protocol.subscribe(sid2)
  log(`段 2 session=${sid2}`)
  ev.step({ step: 'session.create.notify-edge', channel: 'B', exitCode: 0, stats: { sessionId: sid2 } })

  // 派发前取事件游标：通知只可能在派发后到达，游标前的帧不混入观测窗。
  const since2 = protocol.events.length
  await protocol.send(sid2, 'dispatch a two-member background batch (段 2)')
  const end2 = await protocol.waitTurnEnd(sid2, { since: since2, timeoutMs: 180_000 })
  ev.assert('A6 派发主轮完成（message.complete 非 error）', end2.type === 'message.complete' && end2.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end2.type} stop=${end2.payload?.stopReason ?? 'n/a'}`,
  })
  const hist2 = await protocol.history(sid2, { limitTurns: 10 })
  ev.assert('A6 控制组：主会话文本来自主队 step4（NOTIFY-EDGE-BATCH-DISPATCHED）', JSON.stringify(hist2.messages ?? []).includes('NOTIFY-EDGE-BATCH-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 NOTIFY-EDGE-BATCH-DISPATCHED',
    actual: `messages=${(hist2.messages ?? []).length}`,
  })

  // 通知观测窗：等 ≥2 条同组（subagent-bg-notify）完成通知事件（message.customStart）。
  // 批量派发的完成通知走默认通道组（subagent-bg-notify），与 wf-done（workflow-result）分通道。
  const isGroupNotify = (e) =>
    e.type === 'message.customStart' &&
    e.payload?.customType === 'subagent-bg-notify' &&
    (e.payload?.sessionId === undefined || e.payload?.sessionId === sid2)
  const notifyEvents = await waitForEventCount(protocol, isGroupNotify, 2, since2, 120_000)
  const notifyShapes = (notifyEvents ?? []).map((e) => ({ receivedAt: e.receivedAt, ...parseNotifyDetailsShape(e.payload?.details) }))
  ev.step({
    step: 'notify.observe', channel: 'B', exitCode: notifyEvents ? 0 : 1,
    stats: { count: notifyShapes.length, forms: notifyShapes.map((s) => s.form).join(',') },
  })
  ev.assert('A6⑥ 同组批注到达：≥2 条 subagent-bg-notify 通知在同一观测窗到达', Boolean(notifyEvents) && notifyShapes.length >= 2, {
    channel: 'B',
    expected: 'message.customStart（customType=subagent-bg-notify）× ≥2',
    actual: notifyEvents ? `${notifyShapes.length} 条（forms=${notifyShapes.map((s) => s.form).join(',')}）` : '观测窗内未到齐（120s）',
  })
  // 消费表面不变的形态级判据：每条通知 details 可按单条形态解析（parseBgNotifyDetails 的
  // 必需字段判据）——批兼容读分支（{batch:true, items}）是存量数据兼容面，本剧本通道下
  // 攒批窗退役后恒产单条形态（保留边界路径才产批，见 notProvable）。
  ev.assert('A6⑥ 通知 details 全部为可解析的单条形态（消费表面不因窗口删除报错）', notifyShapes.length >= 2 && notifyShapes.every((s) => s.form === 'single'), {
    channel: 'B',
    expected: '每条 details = BgNotifyRecord 单条形态（id/status/agent/startedAt 齐全，batch 键缺席）',
    actual: JSON.stringify(notifyShapes).slice(0, 600),
  })
  ev.attach(
    'notify-events',
    JSON.stringify(
      (notifyEvents ?? []).map((e) => ({ receivedAt: e.receivedAt, customType: e.payload?.customType, details: e.payload?.details })),
      null,
      2,
    ).slice(0, 120_000),
  )

  // A6⑤：即时性测量。轮终锚 = 段 2 run record journal 的 agent-settled 帧 ts（引擎写侧）；
  // 通知到达锚 = customStart receivedAt（剧本进程）。逐通知取与最近轮终 ts 的差，全部 ≤1s。
  const recDir2 = path.join(dataDir, 'ext-sessions', String(sid2), 'workflow', 'runs')
  const frames2 = await waitForRecordFrames(recDir2, (f) => f.type === 'agent-settled', 2, 60_000)
  const settledTs = frames2.filter((f) => f.type === 'agent-settled' && typeof f.ts === 'number').map((f) => f.ts)
  const recordText2 = fs.existsSync(recDir2)
    ? fs.readdirSync(recDir2).filter((f) => f.endsWith('.record.jsonl')).map((f) => `# ${f}\n${readTextFile(path.join(recDir2, f))}`).join('\n')
    : ''
  ev.step({
    step: 'notify.timing', channel: 'C', exitCode: settledTs.length >= 2 ? 0 : 1,
    stats: { settledTs: settledTs.join(','), notifyAt: notifyShapes.map((s) => s.receivedAt).join(',') },
  })
  let maxDelta = -1
  const deltas = []
  for (const n of (notifyEvents ?? [])) {
    let min = Infinity
    for (const t of settledTs) min = Math.min(min, Math.abs(n.receivedAt - t))
    deltas.push(min)
    if (min > maxDelta) maxDelta = min
  }
  ev.assert(
    'A6⑤ 即时单条：每条完成通知距成员轮终 ≤1s（journal ts → customStart receivedAt）',
    settledTs.length >= 2 && deltas.length >= 2 && maxDelta >= 0 && maxDelta <= 1_000,
    {
      channel: 'C',
      expected: 'max(每条通知 receivedAt 与最近 agent-settled ts 的差) ≤ 1000ms',
      actual: `settledTs=${settledTs.length} 帧, deltas=${deltas.map((d) => (Number.isFinite(d) ? `${d}ms` : 'n/a')).join(',')}（轮终锚=record journal agent-settled.ts，到达锚=message.customStart receivedAt，同机时钟）`,
    },
  )
  ev.assert('A6⑥ 成员 canary 落 record（NOTIFY_EDGE_MEMBER_A/B_CANARY 两个标记都在）', recordText2.includes(NOTIFY_EDGE_CANARY_A) && recordText2.includes(NOTIFY_EDGE_CANARY_B), {
    channel: 'C',
    expected: `record 含 ${NOTIFY_EDGE_CANARY_A} 与 ${NOTIFY_EDGE_CANARY_B}`,
    actual: `hitA=${recordText2.includes(NOTIFY_EDGE_CANARY_A)} hitB=${recordText2.includes(NOTIFY_EDGE_CANARY_B)} bytes=${recordText2.length}`,
  })
  ev.attach('workflow-records-notify-edge', recordText2.slice(0, 200_000))

  // ══ 铁证总账：全剧本成员模型有效请求（段 1 ≥2 + 段 2 ≥2）══════════════
  const allRequests = instance.mockLlm?.requests ?? []
  const childRequests = allRequests.filter((r) => r.model === SUB_MODEL)
  const childOk = childRequests.filter((r) => r.status === 200)
  ev.step({
    step: 'mock.requests.total', channel: 'C', exitCode: 0,
    stats: {
      total: allRequests.length,
      main: allRequests.filter((r) => r.model === MAIN_MODEL).length,
      childOk: childOk.length,
      child404: childRequests.length - childOk.length,
      models: [...new Set(allRequests.map((r) => r.model))].join(','),
    },
  })
  ev.assert('铁证：mock 收到 ≥4 条成员模型的有效请求（200；段 1 ≥2 + 段 2 ≥2）', childOk.length >= 4, {
    channel: 'C',
    expected: `≥4 × model=${SUB_MODEL} status=200`,
    actual: `${childOk.length} 条 200（steps=${childOk.map((r) => r.stepIndex).join(',')}）+ ${childRequests.length - childOk.length} 条非 200（耗尽收尾轮，预期）`,
  })
  ev.attach(
    'mock-requests',
    JSON.stringify(
      allRequests.map((r) => ({ model: r.model, status: r.status, queueKey: r.queueKey, stepIndex: r.stepIndex, messageCount: r.messageCount, error: r.error })),
      null,
      2,
    ).slice(0, 120_000),
  )

  log(`done sid1=${sid1} sid2=${sid2} childOk=${childOk.length} notifyCount=${notifyShapes.length} maxDelta=${maxDelta}ms`)
  return { uncovered, gotchas }
}
