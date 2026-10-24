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
 *   段 2（A6 场景 6）——主队 step3 在一个 assistant 步里发两条 subagent_start（background
 *     单成员，设计场景 6②「2 个近同时完成的 background 成员」原文形态）、step4 收尾、
 *     step5-7 通知触发轮/闲置备用。成员对象带成员级 model：成员 A 走 mock-sub-a、成员 B 走
 *     mock-sub-c，各 1 步文本终局 → 双成员确定性完成 → 2 条同组（subagent-bg-notify）
 *     完成通知同窗到达。
 *     **为什么不用 subagents 批量**：批量 = 内置 fan-out 模板 = workflow origin，而
 *     notify-host.toNotifyRecord 对 `record.origin === "workflow"` 一律返回 undefined
 *     （单漏斗 origin gate 全静默）——fan-out 成员轮应答放行判据缺口已登记 u4 deviations，
 *     批量成员构造性不发通知（2026-10-24 a2a6 首跑实测 0 条 + 源码核实）。
 *   段 2 开始前条件等待主队游标恰为 3（waitMainQueueConsumed，fail-fast 形态同范本）。
 *
 * 断言通道：B（getSubagents / message.customStart 通知事件）+ C（workflow runs record journal、
 * subagents records 树、mock.requests 成员模型请求 = 孙进程真的打到 mock 的铁证）。
 * 本剧本刻意不碰 UI。
 *
 * 通知消费表面的可观测锚（源码核实）：
 *   - 通知注入 = pi custom message（customType=subagent-bg-notify）→ runtime event-adapter
 *     广播 `message.customStart`（payload 带 sessionId/customType/details）→ protocol.events
 *     带 receivedAt（剧本进程墙钟）；
 *   - 轮终锚 = 通知 details.endedAt（notify-host.toNotifyRecord 在派生视图边界物化：
 *     running 载荷 `endedAt = snap.endedAt ?? Date.now()`——构造时刻 ≈ 轮终时刻；
 *     旧攒批窗会把它与投递时刻拉开 60s+，故 delta 是该机制的判据）；
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
/** 段 2 第二成员专属模型（成员级 model 覆盖 → 独立 per-model 游标，双成员零交错竞态）。 */
const SUB_MODEL_C = 'mock-sub-c'
/** 段 1 成功成员的交付 canary（structured-output summary）。 */
const PARTIAL_OK_CANARY = 'PARTIAL_MEMBER_OK_CANARY'
/** 段 2 双成员的交付 canary（各成员独立队列，两个标记都必须落 record/通知）。 */
const NOTIFY_EDGE_CANARY_A = 'NOTIFY_EDGE_MEMBER_A_CANARY'
const NOTIFY_EDGE_CANARY_B = 'NOTIFY_EDGE_MEMBER_B_CANARY'

/**
 * 段 1 成功成员队列（mock-sub-a）：SO 交付步 + stop 收尾步。
 * 成员轮成败只产自引擎收尾边沿（pi-subagent-cli output-collector.ts collectOutcome）：
 * SO 调用后引擎还会继续请求，必须有 stopReason:'stop' 步让引擎干净停
 * （engineStopReason=stop → delivered）；纯 toolUse 队列会消费到耗尽 404 → 收尾错误 → failed。
 */
const partialOkQueue = [
  { toolCalls: [{ name: 'structured-output', args: { summary: PARTIAL_OK_CANARY } }], stopReason: 'toolUse' },
  { stopReason: 'stop' },
]
/**
 * 段 2 成员队列（每成员独立 model 队列）：background 单成员是 chat 形态（无 schema），
 * 一轮文本回复即干净收尾（stopReason stop）→ 轮终 → 完成通知。
 */
const notifyEdgeQueueA = [{ text: `${NOTIFY_EDGE_CANARY_A}`, stopReason: 'stop' }]
const notifyEdgeQueueB = [{ text: `${NOTIFY_EDGE_CANARY_B}`, stopReason: 'stop' }]

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
          text: '派两个后台成员（段 2）：',
          // 同一 assistant 步两条 subagent_start = 一次 turn 内注销 ≥2 个同组 pending 的
          // 制造面（设计场景 6②「2 个近同时完成的 background 成员」原文形态）。
          toolCalls: [
            {
              name: 'subagent_start',
              args: {
                task: '通知边沿 A 路：报出你剧本里的 canary',
                slug: 'notify-edge-a',
                model: `mockllm/${SUB_MODEL}`,
                fork: false,
              },
            },
            {
              name: 'subagent_start',
              args: {
                task: '通知边沿 B 路：报出你剧本里的 canary',
                slug: 'notify-edge-b',
                model: `mockllm/${SUB_MODEL_C}`,
                fork: false,
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '两个后台成员已派发，等待完成通知（NOTIFY-EDGE-BATCH-DISPATCHED）。', stopReason: 'stop' },
        { text: 'batch-parent-notified-1', stopReason: 'stop' },
        { text: 'batch-parent-notified-2', stopReason: 'stop' },
        { text: 'batch-parent-notified-3', stopReason: 'stop' },
        { text: 'parent-idle-final', stopReason: 'stop' },
      ],
      // 段 1 成功成员 + 段 2 成员 A 共享 mock-sub-a 游标（段 2 在段 1 之后顺序消费）；
      // mock-sub-b 是段 1 失败成员的专属队列：空队列 = 首请求即 404 耗尽（失败注入点）；
      // mock-sub-c 是段 2 成员 B 的专属队列（成员级 model 隔离，零交错竞态）。
      [`mockllm/${SUB_MODEL}`]: [...partialOkQueue, ...notifyEdgeQueueA],
      [`mockllm/${SUB_MODEL_B}`]: [],
      [`mockllm/${SUB_MODEL_C}`]: [...notifyEdgeQueueB],
    },
    // 成员模型必须全部注册进 provider 模型清单 + enabledModels（ensureLlm 按 actors 写
    // models.json；显式 model 会过 assertModelInCatalog 目录校验，缺一即工具拒单）。
    models: [MAIN_MODEL, SUB_MODEL, SUB_MODEL_B, SUB_MODEL_C],
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    'A2① fanout-partial 夹具 allSettled 吸收成员失败正常收尾：workflow_run 受理且 run 出现',
    'A2② session.getWorkflows 的 run 终局 = partially_succeeded（RunOutcome 第五值词表；outcome/reason 任一承载）',
    'A2③ record journal run-settled 帧 outcome=partially_succeeded 且 failedMembers 恰含 1 条 {taskIndex, cause}（cause 为 class.kind 点拼形态，预期 provider.protocol_unsupported）',
    'A2③ 成员结算对账：agent-settled 恰 1 × done + 1 × failed；成功成员 canary 落 record',
    'A2④ 铁证：mock 收到 ≥2 条成员模型有效请求（200）+ 恰 1 条失败成员的耗尽 404（失败注入确实命中 provider 通道）',
    'A6 派发受理：同一 assistant 步的两条 subagent_start 都被受理（getSubagents 出现 ≥2 条 record，模型 = 各自派发参数）',
    'A6⑤ 即时单条：轮终（通知 details.endedAt）→ 完成通知事件到达（message.customStart receivedAt）时差 ≤1s（2 条通知各自满足）',
    'A6⑥ 同组批注到达：≥2 条同组（subagent-bg-notify）通知在同一观测窗到达（同 turn 注销两条 pending），每条 details 为可解析的单条形态（消费表面不因窗口删除报错）',
    'A6⑥ 双成员交付 canary 都在通知 details / subagents records 树（交付面旁证）',
    '两段主轮都以 message.complete 收尾；段 2 前主队游标衔接 fail-fast（游标恰 3，越位 = 通知主体集合漂移即归因失败）',
    'A2/A6 通知主体集合（§3.3.7② 防双发）：脚本编排 run 恰 1 条 wf-done、零条成员轮应答；subagent_start 单成员恰各 1 条成员轮应答、零条 wf-done',
  ],
  notProvable: [
    'UI 面：workflow overlay / 托盘面板 / 通知气泡渲染（A 通道，归 UI 剧本）',
    'fan-out / subagents 批量成员轮应答（§3.3.7② one-shot 放行在 fan-out 域的判据缺口）：notify-host.toNotifyRecord 对 record.origin==="workflow" 一律返回 undefined（单漏斗 origin gate 全静默，u4 deviations 登记）——批量成员构造性不发轮应答，本剧本 A6 的通知面按设计场景 6② 用 background 单成员（subagent_start）制造',
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

/** 递归读目录下所有文本文件（体积上限保护；subagents records/sessions 树证据用）。 */
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
 * 返回全部解析成功的帧（供断言复用），超时返回 null——调用方必须归一为 []。
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
 * 轮终收尾 idle 的通知 status = 'running'（notify-host 载荷派生视图语义），故 status 词表
 * 按 BgNotifyRecord 全集收：done/failed/cancelled/closed/running。
 */
function parseNotifyDetailsShape(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return { form: 'unparsed' }
  if (details.batch === true && Array.isArray(details.items)) {
    return { form: 'batch', items: details.items.length }
  }
  const ok =
    typeof details.id === 'string' && details.id.length > 0 &&
    ['done', 'failed', 'cancelled', 'closed', 'running'].includes(details.status) &&
    typeof details.agent === 'string' && details.agent.length > 0 &&
    typeof details.startedAt === 'number'
  return ok
    ? {
        form: 'single',
        id: details.id,
        status: details.status,
        agent: details.agent,
        startedAt: details.startedAt,
        endedAt: typeof details.endedAt === 'number' ? details.endedAt : undefined,
      }
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
    '段 2 双成员用成员级 model 隔离队列（subagent_start 的 model 参数 → mock-sub-a / mock-sub-c 各自 per-model 游标）——双成员确定性完成，A6 可对「2 条成功轮应答」做确定性期待',
    '段 2 不用 subagents 批量：批量 = 内置 fan-out 模板 = workflow origin，notify-host.toNotifyRecord 对 record.origin==="workflow" 一律返回 undefined（单漏斗 origin gate 全静默；fan-out 成员放行判据缺口 = u4 deviations 登记）→ 批量成员构造性零通知（2026-10-24 a2a6 首跑实测：subagents tasks 传纯字符串还被 fan-out 旧格式迁移 throw 拒单，双因叠加）。设计场景 6② 的原文形态 = 2 个 background 单成员，即两条 subagent_start',
    'A6⑤ 测量口径：轮终锚 = 通知 details.endedAt（notify-host.toNotifyRecord 在派生视图边界物化：running 载荷 endedAt = snap.endedAt ?? Date.now()，构造时刻 ≈ 轮终时刻）；到达锚 = protocol.events 的 message.customStart receivedAt（剧本进程墙钟）。两者同机时钟直接可比，差值含 pi 注入 + runtime 广播 + WS 转发 + 剧本轮询的链路噪声（数百 ms 量级）；1s 预算的判据本质 = 不出现攒批窗退役前 60s 量级的无上界推迟（旧窗把构造与投递拉开）',
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

  // 装配自检：models.json 里的 mock provider 指向本机 mock 服务（含全部成员模型）；孙进程缺省模型
  const topo = instance.llm
  const modelsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  const providerModelIds = (provider?.models ?? []).map((m) => m?.id)
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.assert('装配：成员模型都在 provider 模型清单（mock-sub-a/b/c）', [SUB_MODEL, SUB_MODEL_B, SUB_MODEL_C].every((m) => providerModelIds.includes(m)), {
    channel: 'C',
    expected: `models 含 ${SUB_MODEL} / ${SUB_MODEL_B} / ${SUB_MODEL_C}`,
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
  // waitForRecordFrames 超时返回 null（不是空数组）——统一归一为 []，防后续 .filter/.find 崩溃。
  const frames1 = (await waitForRecordFrames(recDir1, (f) => f.type === 'run-settled', 1, 180_000)) ?? []
  const recordText1 = readRecordText(recDir1)
  ev.step({
    step: 'workflow.record.partial', channel: 'C', exitCode: frames1.length > 0 ? 0 : 1,
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
  // 零条成员轮应答（subagent-bg-notify；workflow origin 回注全静默，防双发）。
  // 游标「恰 3」已证明通知轮发生过，此处事件必在队列，无等待竞态。
  const sameSession = (sid) => (e) => e.payload?.sessionId === undefined || e.payload?.sessionId === sid
  const wfDone1 = protocol.events.slice(since1).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'workflow-result' && sameSession(sid1)(e))
  const bgNotify1 = protocol.events.slice(since1).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'subagent-bg-notify' && sameSession(sid1)(e))
  ev.assert('A2 通知主体集合：脚本编排 run 恰产 1 条 wf-done（workflow-result）', wfDone1.length === 1, {
    channel: 'B',
    expected: 'message.customStart（workflow-result）× 1',
    actual: `${wfDone1.length} 条`,
  })
  ev.assert('A2 通知主体集合：脚本编排 run 不产成员轮应答（subagent-bg-notify × 0，workflow origin 回注静默）', bgNotify1.length === 0, {
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
  await protocol.send(sid2, 'dispatch two background members (段 2)')
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

  // 派发受理判据（早期归因锚）：同一 assistant 步的两条 subagent_start 都必须被受理——
  // getSubagents 出现 ≥2 条 record 且模型 = 各自派发参数。工具拒单（模型不在目录 / slug 非法等）
  // 时这里立即红，不让后续「零通知」观测超时承担归因噪音。
  const deadlineSubs = Date.now() + 30_000
  let subs = []
  while (Date.now() < deadlineSubs) {
    const reply = await protocol.call('session.getSubagents', { sessionId: sid2 }, { timeoutMs: 60_000 })
    subs = reply.subagents ?? []
    if (subs.length >= 2) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const subModels = subs.map((s) => String(s.model ?? ''))
  ev.step({ step: 'subagent.observe', channel: 'B', exitCode: subs.length >= 2 ? 0 : 1, stats: { count: subs.length, models: subModels.join(','), statuses: subs.map((s) => s.status).join(',') } })
  ev.assert('A6 派发受理：两条 subagent_start 都被受理（≥2 条 record）', subs.length >= 2, {
    channel: 'B',
    expected: 'session.getSubagents ≥2 条 record（30s 内）',
    actual: `count=${subs.length}（空 = 工具拒单：检查 model 是否在目录 / slug 是否合法）`,
  })
  ev.assert('A6 成员模型 = 各自派发参数（mock-sub-a + mock-sub-c 成员级 model 隔离）', subModels.some((m) => m.includes(SUB_MODEL)) && subModels.some((m) => m.includes(SUB_MODEL_C)), {
    channel: 'B',
    expected: `record.model 含 ${SUB_MODEL} 与 ${SUB_MODEL_C}`,
    actual: subModels.join(', ') || '<缺>',
  })
  ev.attach('subagent-records', JSON.stringify(subs, null, 2).slice(0, 60_000))

  // 通知观测窗：等 ≥2 条同组（subagent-bg-notify）完成通知事件（message.customStart）。
  // 两条 subagent_start 在同一 turn 派发 = 一次 turn 内注销 ≥2 个同组 pending。
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
  ev.assert('A6⑥ 同组批注到达：≥2 条 subagent-bg-notify 通知在同一观测窗到达（同 turn 注销两条 pending）', Boolean(notifyEvents) && notifyShapes.length >= 2, {
    channel: 'B',
    expected: 'message.customStart（customType=subagent-bg-notify）× ≥2（双 background 成员确定性完成 → 2 条轮应答）',
    actual: notifyEvents ? `${notifyShapes.length} 条（forms=${notifyShapes.map((s) => s.form).join(',')}, statuses=${notifyShapes.map((s) => s.status ?? '-').join(',')}）` : '观测窗内未到齐（120s）',
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

  // A6⑤：即时性测量。轮终锚 = 通知 details.endedAt（notify-host 在派生视图边界物化，
  // running 载荷 endedAt = snap.endedAt ?? Date.now()，构造时刻 ≈ 轮终时刻）；到达锚 =
  // customStart receivedAt（剧本进程）。逐通知算 delta，全部 ≤1s（旧攒批窗会拉到 60s+）。
  const deltas = []
  let maxDelta = -1
  for (const n of notifyShapes) {
    const d = typeof n.endedAt === 'number' ? n.receivedAt - n.endedAt : NaN
    deltas.push(d)
    if (Number.isFinite(d) && d > maxDelta) maxDelta = d
  }
  ev.step({
    step: 'notify.timing', channel: 'C', exitCode: maxDelta >= 0 && maxDelta <= 1_000 ? 0 : 1,
    stats: { deltas: deltas.map((d) => (Number.isFinite(d) ? `${d}ms` : 'n/a')).join(','), notifyAt: notifyShapes.map((s) => s.receivedAt).join(',') },
  })
  ev.assert(
    'A6⑤ 即时单条：每条完成通知距轮终 ≤1s（details.endedAt → customStart receivedAt）',
    notifyShapes.length >= 2 && deltas.every((d) => Number.isFinite(d) && Math.abs(d) <= 1_000),
    {
      channel: 'C',
      expected: '每条通知 |receivedAt − details.endedAt| ≤ 1000ms',
      actual: `deltas=${deltas.map((d) => (Number.isFinite(d) ? `${d}ms` : 'n/a(endedAt 缺)')).join(',')}（轮终锚=details.endedAt，到达锚=message.customStart receivedAt，同机时钟）`,
    },
  )

  // A6⑥ 交付面旁证：两个成员 canary 都要落通知 details（轮应答正文带结果）与
  // subagents records 树（C 通道落盘）。任一缺失 = 成员派发/交付链异常。
  const notifyDetailsText = JSON.stringify((notifyEvents ?? []).map((e) => e.payload?.details ?? {}))
  const subagentsTree = readTreeText(path.join(dataDir, 'ext-sessions', String(sid2), 'subagents'))
  ev.assert('A6⑥ 双成员交付 canary 都在通知 details（A/B 两个标记）', notifyDetailsText.includes(NOTIFY_EDGE_CANARY_A) && notifyDetailsText.includes(NOTIFY_EDGE_CANARY_B), {
    channel: 'B',
    expected: `通知 details 含 ${NOTIFY_EDGE_CANARY_A} 与 ${NOTIFY_EDGE_CANARY_B}`,
    actual: `hitA=${notifyDetailsText.includes(NOTIFY_EDGE_CANARY_A)} hitB=${notifyDetailsText.includes(NOTIFY_EDGE_CANARY_B)}`,
  })
  ev.assert('A6⑥ 双成员交付 canary 落 subagents records 树（C 通道）', subagentsTree.includes(NOTIFY_EDGE_CANARY_A) && subagentsTree.includes(NOTIFY_EDGE_CANARY_B), {
    channel: 'C',
    expected: `subagents 树含 ${NOTIFY_EDGE_CANARY_A} 与 ${NOTIFY_EDGE_CANARY_B}`,
    actual: `bytes=${subagentsTree.length} hitA=${subagentsTree.includes(NOTIFY_EDGE_CANARY_A)} hitB=${subagentsTree.includes(NOTIFY_EDGE_CANARY_B)}`,
  })
  ev.attach('subagents-tree', subagentsTree.slice(0, 120_000))

  // A6 补：subagent_start 单成员派发不是 run 通道，不产 wf-done（workflow-result × 0）。
  const wfDone2 = protocol.events.slice(since2).filter((e) => e.type === 'message.customStart' && e.payload?.customType === 'workflow-result' && (e.payload?.sessionId === undefined || e.payload?.sessionId === sid2))
  ev.assert('A6 通知主体集合：subagent_start 单成员派发不产 wf-done（workflow-result × 0）', wfDone2.length === 0, {
    channel: 'B',
    expected: 'message.customStart（workflow-result）× 0（非 run 通道）',
    actual: `${wfDone2.length} 条`,
  })

  // ══ 铁证总账：全剧本成员模型有效请求（段 1 成功成员 2 + 段 2 两成员各 1）══════════
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
  ev.assert('铁证：mock 收到 ≥4 条成员模型有效请求（200；段 1 成功成员 2 + 段 2 两成员各 1）', childOk.length >= 4, {
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
