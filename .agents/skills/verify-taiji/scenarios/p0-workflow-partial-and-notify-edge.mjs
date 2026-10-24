/**
 * p0-workflow-partial-and-notify-edge —— run 终局吸收成员交付（partially_succeeded 第五值）
 * 与攒批窗退役后通知消费表面（即时单条 / 同组批注到达）的双段零 token 验收。
 *
 * 对应设计（subagent-observability）验收场景 2（§3.3.8）+ 场景 6（§3.3.7③ 消费表面反向），
 * 两段同实例衔接（验收计划已裁决可合并）。装配通道 = mock-http（孙进程唯一零 token 通道，
 * faux 在 `--no-extensions` 孙进程不可达——SSOT：capabilities/env.md + probes/faux-grandchild.mjs）。
 *
 * 双段设计（同一实例、同一 mock server、两个独立 session，形态同构 p0-subagent-workflow-dispatch）：
 *   段 1（A2 场景 2）——主队 step0 派发 workflow_run(fanout-partial)、step1 收尾、step2 完成通知轮。
 *     双成员经夹具的 $ARGS.models 逐成员指定模型（per-call model → mock server per-model 游标，
 *     零交错竞态）：成功成员 mock-sub-a 队列 = [structured-output 步, stop 收尾步]（干净收尾
 *     → delivered）；失败成员 mock-sub-b 空队列 = 首请求即「剧本耗尽」404（真实 provider 错误
 *     形态 → failed，cause=provider.protocol_unsupported）。run 终局派生 partially_succeeded。
 *   段 2（A6 场景 6）——主队 step3 派发 subagents 双成员批量（one-shot 域，成员继承
 *     engineDefaults.pi = mock-sub-a 共享队列）、step4 收尾、step5-7 通知触发轮/闲置备用；
 *     成员队 = [SO_A, SO_B, stop×4]：均衡交错 → 双 delivered；spawn 斜交（一成员第二请求
 *     先于另一成员首请求）→ 后到成员 stop 收尾无 SO 交付 → agent.no_deliverable。
 *     两种形态都恒产 2 条同组完成通知（失败轮应答如实，§3.3.7①），A6 断言对两者成立。
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
const SUB_MODEL_B = 'mock-sub-b'
/** 段 1 成功成员的交付 canary（structured-output summary）。 */
const PARTIAL_OK_CANARY = 'PARTIAL_MEMBER_OK_CANARY'
/** 段 2 双成员的交付 canary（哪个成员拿哪步不定，断言只要求至少一个标记落 record）。 */
const NOTIFY_EDGE_CANARY_A = 'NOTIFY_EDGE_MEMBER_A_CANARY'
const NOTIFY_EDGE_CANARY_B = 'NOTIFY_EDGE_MEMBER_B_CANARY'

/**
 * 段 1 成功成员队列（mock-sub-a，本段独立游标）：SO 交付步 + stop 收尾步。
 * 成员轮成败只产自引擎收尾边沿（pi-subagent-cli output-collector.ts collectOutcome）：
 * SO 调用后引擎还会继续请求，必须有 stopReason:'stop' 步让引擎干净停
 * （engineStopReason=stop → delivered）；纯 toolUse 队列会消费到耗尽 404 → 收尾错误 → failed。
 */
const partialOkQueue = [
  { toolCalls: [{ name: 'structured-output', args: { summary: PARTIAL_OK_CANARY } }], stopReason: 'toolUse' },
  { stopReason: 'stop' },
]
/**
 * 段 2 成员队列（mock-sub-a，两成员共享游标）：前 2 位全 SO、后 4 位全 stop。
 * 均衡交错（A1,B1,A2,B2）→ 双成员各 [SO, stop] 双 delivered；spawn 斜交（一成员的
 * 第二请求先于另一成员首请求）→ 斜交成员连吃 2 个 SO 后 stop 收尾 delivered，后到成员
 * 首请求即 stop → 无 SO 交付 → agent.no_deliverable 失败。两种形态都恒产 2 条同组通知。
 */
const notifyEdgeMemberQueue = [
  { toolCalls: [{ name: 'structured-output', args: { summary: NOTIFY_EDGE_CANARY_A } }], stopReason: 'toolUse' },
  { toolCalls: [{ name: 'structured-output', args: { summary: NOTIFY_EDGE_CANARY_B } }], stopReason: 'toolUse' },
  { stopReason: 'stop' },
  { stopReason: 'stop' },
  { stopReason: 'stop' },
  { stopReason: 'stop' },
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
                args: {
                  tasks: ['第一路：报出你剧本里的 canary', '第二路：报出你剧本里的 canary'],
                  models: [`mockllm/${SUB_MODEL}`, `mockllm/${SUB_MODEL_B}`],
                },
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
      // 段 1 成功成员 + 段 2 两成员共享 mock-sub-a 游标（段 2 在段 1 之后顺序消费）；
      // mock-sub-b 是段 1 失败成员的专属队列：空队列 = 首请求即 404 耗尽（失败注入点）。
      [`mockllm/${SUB_MODEL}`]: [...partialOkQueue, ...notifyEdgeMemberQueue],
      [`mockllm/${SUB_MODEL_B}`]: [],
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    'A2① fanout-partial 夹具 allSettled 吸收成员失败正常收尾：workflow_run 受理且 run 出现',
    'A2② session.getWorkflows 的 run 终局 = partially_succeeded（RunOutcome 第五值词表；outcome/reason 任一承载）',
    'A2③ record journal run-settled 帧 outcome=partially_succeeded 且 failedMembers 恰含 1 条 {taskIndex, cause}（cause 为 class.kind 点拼形态，预期 provider.protocol_unsupported）',
    'A2③ 成员结算对账：agent-settled 恰 1 × done + 1 × failed；成功成员 canary 落 record',
    'A2④ 铁证：mock 收到 ≥2 条成员模型有效请求（200）+ 恰 1 条失败成员的耗尽 404（失败注入确实命中 provider 通道）',
    'A6⑤ 即时单条：成员轮终（journal agent-settled ts）→ 完成通知事件到达（message.customStart receivedAt）时差 ≤1s',
    'A6⑥ 同组批注到达：≥2 条同组（subagent-bg-notify）通知在同一观测窗到达，每条 details 为可解析的单条形态（消费表面不因窗口删除报错）',
    '两段主轮都以 message.complete 收尾；段 2 前主队游标衔接 fail-fast（游标恰 3，越位 = 通知主体集合漂移即归因失败）',
    'A2/A6 通知主体集合（§3.3.7② 防双发）：脚本编排 run 恰 1 条 wf-done、零条成员轮应答；one-shot 批量恰 N 条成员轮应答、零条 wf-done',
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

/** 读目录下全部 *.record.jsonl 原文（证据附件用）。 */
function readRecordText(recDir) {
  if (!fs.existsSync(recDir)) return ''
  return fs
    .readdirSync(recDir)
    .filter((f) => f.endsWith('.record.jsonl'))
    .map((f) => `# ${f}\n${readTextFile(path.join(recDir, f))}`)
    .join('\n')
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
    '成员轮成败只产自引擎收尾边沿（pi-subagent-cli output-collector.ts collectOutcome，设计 §3.3.1 聚合不变量 2）：SO 调用后引擎还会继续请求，成员队列必须在 SO 步之后给 stopReason:"stop" 收尾步——纯 toolUse 队列会让成员一直消费到队列耗尽 404，收尾边沿=错误 → 成员判 failed（parsedOutput 已产出也一样，「done 吞失败」旧语义已废除）',
    '段 1 失败注入 = 失败成员专属空队列（mock-sub-b，per-call model 指定）：首请求即「剧本耗尽」404 = 真实 provider 错误形态，cause 落 provider.protocol_unsupported。共享游标下用「队列位置」注入失败有交错竞态（一成员第二请求可能先于另一成员首请求），per-model 队列结构性消除',
    '段 2 两成员共享 mock-sub-a 游标（subagents 批量无 per-task model），存在两种合法交错：均衡（A1,B1,A2,B2）→ 双 delivered；spawn 斜交（一成员第二请求先于另一成员首请求）→ 斜交成员连吃 2 个 SO 后 stop 收尾，后到成员首请求即 stop → agent.no_deliverable 失败。两种形态都恒产 2 条同组完成通知（失败轮应答如实，§3.3.7①），本剧本 A6 断言对两者都成立、不断言段 2 成员成败',
    'mock-http 的 stopReason:"error" 步不会产 provider 级错误轮：mock server 把 error 文本写成正文 + finish stop（lib/mock-llm.mjs planFrames），成员照常收尾——provider 级错误轮在本通道只能以队列耗尽 404 形态注入',
    'A6⑤ 测量口径：轮终锚 = record journal agent-settled 帧 ts（引擎写侧 epoch ms）；通知到达锚 = protocol.events 的 message.customStart receivedAt（剧本进程墙钟）。两者同机时钟直接可比，差值含 pi 注入 + runtime 广播 + WS 转发 + 剧本轮询的链路噪声（数百 ms 量级）；1s 预算的判据本质 = 不出现攒批窗退役前 60s 量级的无上界推迟',
    'A6⑥ 的「同批」断言口径：边沿即投后每条 deliver 同步经 pumpDirect 泵出，两条独立到达的通知恒产两条单条消息（delivery-port.ts routeAcceptedDelivery 源码核实）；真 {batch:true} 批消息只产自保留边界路径（recover 重放 / collectRelease 直通 / compaction 唤醒 / 内核留存合并），单实例剧本内不可确定性编排——本剧本断言「同组两条通知同窗全部到达 + 逐条单条形态可解析」，批形态兼容读的事实判据 = shared parseBgNotifyDetails 保留 {batch:true, items} 展开分支（消费存量 session 数据），由 u4 行为锁测试锁定',
    '成员 outcome 收敛之后的意外请求会命中「剧本耗尽」HTTP 404（预期形态）；铁证断言只计 200，404 单列 stats（段 1 的 1 条 404 是失败注入本体，单独断言）',
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

  // 装配自检：models.json 里的 mock provider 指向本机 mock 服务（含双成员模型）；孙进程缺省模型 = 成员演员
  const topo = instance.llm
  const modelsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  const providerModelIds = (provider?.models ?? []).map((m) => m?.id)
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.assert('装配：双成员模型都在 provider 模型清单（mock-sub-a + mock-sub-b）', providerModelIds.includes(SUB_MODEL) && providerModelIds.includes(SUB_MODEL_B), {
    channel: 'C',
    expected: `models 含 ${SUB_MODEL} 与 ${SUB_MODEL_B}`,
    actual: providerModelIds.join(', ') || '<缺>',
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
    expected: 'status=done 且 outcome/reason=partially_succeeded',
    actual: `status=${run1?.status} outcome=${String(run1?.outcome ?? '<缺>')} reason=${String(run1?.reason ?? '<缺>')} runId=${run1?.runId}`,
  })
  ev.attach('workflow-runs-partial', JSON.stringify(runs, null, 2).slice(0, 60_000))

  // A2③：record journal 对账（C 通道）。run-settled 帧的 outcome 与 failedMembers 是
  // §3.3.8 的权威落盘面；agent-settled 帧对账成员结算集合（恰 1 done + 1 failed）。
  const recDir1 = path.join(dataDir, 'ext-sessions', String(sid1), 'workflow', 'runs')
  const frames1 = await waitForRecordFrames(recDir1, (f) => f.type === 'run-settled', 1, 180_000)
  const recordText1 = readRecordText(recDir1)
  ev.step({
    step: 'workflow.record.partial', channel: 'C', exitCode: frames1 ? 0 : 1,
    stats: { frames: frames1.length, runSettled: frames1.filter((f) => f.type === 'run-settled').length, agentSettled: frames1.filter((f) => f.type === 'agent-settled').length },
  })
  const settledFrame = frames1.find((f) => f.type === 'run-settled') ?? null
  const failedMembers = Array.isArray(settledFrame?.failedMembers) ? settledFrame.failedMembers : []
  const causeShapeRe = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/
  ev.assert('A2③ run-settled 帧 outcome=partially_succeeded', settledFrame?.outcome === 'partially_succeeded', {
    channel: 'C',
    expected: 'run-settled.outcome=partially_succeeded',
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
      expected: 'failedMembers=[{taskIndex:number, cause:"<class>.<kind>"}] 恰 1 条（点拼形态；预期值 provider.protocol_unsupported——耗尽 404 的 provider 分类；cancelled 成员不进失败明细）',
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
  ev.attach('workflow-records-partial', recordText1.slice(0, 200_000))

  // A2④：铁证——mock 服务端收到的成员模型请求（段 1 末统计）。成功成员 2 条 200
  // （SO + stop 收尾）；失败成员 1 条 404（失败注入本体，命中 provider 错误通道）。
  const requests1 = instance.mockLlm?.requests ?? []
  const okA1 = requests1.filter((r) => r.model === SUB_MODEL && r.status === 200)
  const failB1 = requests1.filter((r) => r.model === SUB_MODEL_B)
  ev.step({
    step: 'mock.requests.partial', channel: 'C', exitCode: 0,
    stats: { [`${SUB_MODEL}Ok`]: okA1.length, [`${SUB_MODEL_B}Total`]: failB1.length, [`${SUB_MODEL_B}Status`]: failB1.map((r) => r.status).join(',') },
  })
  ev.assert('A2④ 铁证：mock 收到 ≥2 条成功成员有效请求（200；SO 步 + stop 收尾步）', okA1.length >= 2, {
    channel: 'C',
    expected: `≥2 × model=${SUB_MODEL} status=200`,
    actual: `${okA1.length} 条 200（steps=${okA1.map((r) => r.stepIndex).join(',')}）`,
  })
  ev.assert('A2④ 失败注入命中：失败成员的请求被 mock 以 404 拒（空队列耗尽 = provider 错误通道）', failB1.length >= 1 && failB1.every((r) => r.status !== 200), {
    channel: 'C',
    expected: `≥1 × model=${SUB_MODEL_B} status=404（剧本耗尽）`,
    actual: `${failB1.length} 条（status=${failB1.map((r) => r.status).join(',') || '<无请求>'}）`,
  })

  // ══ 段间衔接：等段 1 的完成通知轮把主队游标推到 step3（范本同款 fail-fast）═════
  // 衔接失败继续跑段 2 会产出「段 2 主轮错步 + 通知面混淆」的误导组合，直接终止并固化现场。
  // 游标判定收紧为「恰 3」：段 1 的通知主体 = 恰 1 条 wf-done（脚本编排 run，§3.3.7②）→
  // 恰多消费 1 步；游标 >3 = 段 1 出现设计外通知轮（防双发被破坏），段 2 派发步会错位，
  // 必须在此归因失败而不是让段 2 错步产出误导组合。
  const queue = await waitMainQueueConsumed(instance, 3, 90_000)
  if (!queue.ok || queue.consumed !== 3) {
    ev.attach('pending-snapshot', JSON.stringify(instance.mockLlm?.pending() ?? {}, null, 2))
    ev.attach('mock-requests', JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })), null, 2))
    ev.assert('衔接：段 1 通知轮已消费主队前 3 步（防段 2 主轮错步）', false, {
      channel: 'C',
      expected: 'mock-1 队列恰消费 3 步（派发轮 2 步 + wf-done 通知轮 1 步）',
      actual: `consumed=${queue.consumed}${queue.consumed > 3 ? '（游标越位 = 段 1 出现设计外通知轮，通知主体集合漂移）' : '（游标未推进 = 段 1 完成通知轮未发生或未消费）'}（pending 与请求记录见附件）`,
    })
    return { uncovered: ['衔接失败：段 2 未执行（防错步消费的误导性失败组合）', ...uncovered], gotchas }
  }
  ev.assert('衔接：段 1 通知轮已消费主队前 3 步（游标恰为 3）', true, {
    channel: 'C',
    expected: 'mock-1 队列恰消费 3 步',
    actual: `consumed=${queue.consumed}`,
  })
  // A2③ 补：脚本编排 run 的通知主体集合（§3.3.7②）——恰 1 条 wf-done（workflow-result），
  // 零条成员轮应答（subagent-bg-notify；one-shot 轮应答不进脚本编排 run，防双发）。
  // 游标「恰 3」已证明通知轮发生过，此处事件必在队列，无等待竞态。
  const sameSession = (sid) => (e) => e.payload?.sessionId === undefined || e.payload?.sessionId === sid
  const wfDone1 = protocol.events.slice(since1).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'workflow-result' && sameSession(sid1)(e))
  const bgNotify1 = protocol.events.slice(since1).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'subagent-bg-notify' && sameSession(sid1)(e))
  ev.assert('A2 通知主体集合：脚本编排 run 恰产 1 条 wf-done（workflow-result）', wfDone1.length === 1, {
    channel: 'B',
    expected: 'message.customStart（workflow-result）× 1',
    actual: `${wfDone1.length} 条`,
  })
  ev.assert('A2 通知主体集合：脚本编排 run 不产 one-shot 成员轮应答（subagent-bg-notify × 0，防双发）', bgNotify1.length === 0, {
    channel: 'B',
    expected: 'message.customStart（subagent-bg-notify）× 0',
    actual: `${bgNotify1.length} 条`,
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
    stats: { count: notifyShapes.length, forms: notifyShapes.map((s) => s.form).join(','), statuses: notifyShapes.map((s) => s.status ?? '-').join(',') },
  })
  ev.assert('A6⑥ 同组批注到达：≥2 条 subagent-bg-notify 通知在同一观测窗到达', Boolean(notifyEvents) && notifyShapes.length >= 2, {
    channel: 'B',
    expected: 'message.customStart（customType=subagent-bg-notify）× ≥2（成员成败两种交错形态下都恒产 2 条）',
    actual: notifyEvents ? `${notifyShapes.length} 条（forms=${notifyShapes.map((s) => s.form).join(',')}, statuses=${notifyShapes.map((s) => s.status ?? '-').join(',')})` : '观测窗内未到齐（120s）',
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

  // A6⑤：即时性测量。轮终锚 = 段 2 run record journal 的 agent-settled 帧 ts（引擎写侧，
  // 失败成员同样有 settled 帧）；通知到达锚 = customStart receivedAt（剧本进程）。
  // 逐通知取与最近轮终 ts 的差，全部 ≤1s。
  const recDir2 = path.join(dataDir, 'ext-sessions', String(sid2), 'workflow', 'runs')
  const frames2 = await waitForRecordFrames(recDir2, (f) => f.type === 'agent-settled', 2, 60_000)
  const settledTs = frames2.filter((f) => f.type === 'agent-settled' && typeof f.ts === 'number').map((f) => f.ts)
  const recordText2 = readRecordText(recDir2)
  ev.step({
    step: 'notify.timing', channel: 'C', exitCode: settledTs.length >= 2 ? 0 : 1,
    stats: { settledTs: settledTs.join(','), notifyAt: notifyShapes.map((s) => s.receivedAt).join(',') },
  })
  const deltas = []
  let maxDelta = -1
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
  // 交付面旁证：至少一个成员的 canary 落 record（均衡交错 → 两个标记都在；
  // 斜交形态 → 只有先到成员的标记在——断言取 ≥1 并集，形态差异已在 gotchas 登记）。
  const canaryHits = [NOTIFY_EDGE_CANARY_A, NOTIFY_EDGE_CANARY_B].filter((c) => recordText2.includes(c))
  ev.assert('A6⑥ 成员交付 canary 落 record（A/B 标记至少一个；均衡交错下两个都在）', canaryHits.length >= 1, {
    channel: 'C',
    expected: `record 含 ${NOTIFY_EDGE_CANARY_A} / ${NOTIFY_EDGE_CANARY_B} 至少一个（均衡交错 = 两个）`,
    actual: `hits=${canaryHits.join(',') || '<无>'}`,
  })
  ev.attach('workflow-records-notify-edge', recordText2.slice(0, 200_000))
  // A6 补：one-shot 批量（subagents 工具）的通知主体 = 各成员轮应答，不双发 wf-done
  // （§3.3.7② 走查补「防双发」）。此处已在通知观测 + journal 轮询之后数秒，run 终局
  // 通知（若实现误发）已到达，无迟到竞窗。
  const wfDone2 = protocol.events.slice(since2).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'workflow-result' && (e.payload?.sessionId === undefined || e.payload?.sessionId === sid2))
  ev.assert('A6 通知主体集合：one-shot 批量不双发 wf-done（workflow-result × 0）', wfDone2.length === 0, {
    channel: 'B',
    expected: 'message.customStart（workflow-result）× 0（成员轮应答即通知主体）',
    actual: `${wfDone2.length} 条`,
  })

  // ══ 铁证总账：全剧本成员模型有效请求（段 1 成功成员 2 + 段 2 两成员至多 4）══════
  const allRequests = instance.mockLlm?.requests ?? []
  const childOk = allRequests.filter((r) => r.model !== MAIN_MODEL && r.status === 200)
  const childFail = allRequests.filter((r) => r.model !== MAIN_MODEL && r.status !== 200)
  ev.step({
    step: 'mock.requests.total', channel: 'C', exitCode: 0,
    stats: {
      total: allRequests.length,
      main: allRequests.filter((r) => r.model === MAIN_MODEL).length,
      childOk: childOk.length,
      childFail: childFail.length,
      models: [...new Set(allRequests.map((r) => r.model))].join(','),
    },
  })
  ev.assert('铁证：mock 收到 ≥4 条成员模型有效请求（200；段 1 成功成员 2 + 段 2 ≥2）', childOk.length >= 4, {
    channel: 'C',
    expected: '≥4 × 成员模型 status=200',
    actual: `${childOk.length} 条 200（models=${[...new Set(childOk.map((r) => r.model))].join(',')}）+ ${childFail.length} 条非 200（段 1 失败注入 1 条 + 意外收尾轮）`,
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
