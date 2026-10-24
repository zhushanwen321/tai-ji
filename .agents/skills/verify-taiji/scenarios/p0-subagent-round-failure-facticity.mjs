/**
 * p0-subagent-round-failure-facticity —— 软限流死因穿透（subagent-observability 设计 §4 场景 1，
 * 验收项 A1：判定 + 轮收条 + list 三处同真相 + 通知 <1s）。
 *
 * 装配：mock-http（孙进程唯一零 token 通道，与 p0-subagent-workflow-dispatch 同款装配）。
 *
 * 错误注入机制（本剧本自行裁决，登记依据）：
 *   mock server 的剧本步恒回 200 SSE（scripts/lib/mock-llm.mjs planFrames——error 步只把
 *   错误文本渲染成 content，pi 视角是正常收尾，复现不了 provider 错误路径），**没有响应级
 *   HTTP 429 注入机制**；该文件登记的唯一真实 HTTP 错误出口 = 「出队耗尽 / 未知模型 =
 *   HTTP 404 + 结构化 body（pi 侧报错可读），不伪造回复」（mock-llm.mjs 文件头职责边界行；
 *   README「踩过的坑」第 3 条登记了耗尽 404 的现象形态）。
 *   本剧本据此把**成员剧本队列置空**：成员首个请求命中「剧本已耗尽」404，errorMessage =
 *   "404: <body>" 经 pi-ai 真实 provider 错误路径（formatProviderError 的 "<status>: <body>"
 *   拼法，1.0.0 实装核实）走完「上游 retry 词表判 willRetry（不命中）→ 引擎错误停因 →
 *   收尾边沿判定事实化 → FailureCause 分类 → 轮收条 → 通知」全链——这正是设计要重演的
 *   死因穿透路径。429 → rate_limited 分支本通道不可达，登记进 meta.notProvable。
 *   与范本剧本的口径差异：范本里 404 是「剧本耗尽噪音」（铁证只计 200），本剧本 404 是
 *   **被注入的故障本身**，直接作铁证与分类输入。
 *
 * 断言通道：B（session.getSubagents record/list + 通知帧时间戳）+ C（磁盘轮收条、
 * mock.requests 成员请求）。本剧本刻意不碰 UI（失败红点 / 托盘归 A 通道 UI 剧本）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAIN_MODEL = 'mock-1'
/** 失败成员专用模型（mock-http 装配缺省注册 mock-1/mock-sub-a/mock-sub-b 三模型，取 b 免与缺省 subModel 纠缠）。 */
const SUB_MODEL = 'mock-sub-b'
const SUB_SLUG = 'mock-fail'
const DISPATCH_MARKER = 'SUBAGENT-FAIL-DISPATCHED'
const NOTIFY_MARKER = 'FAIL-NOTIFIED'
/**
 * 失败轮应答的到达标记（notifier.ts buildRoundReplyContent 分支③的文案形态：
 * `failed (<class>.<kind>)` 点拼）。record/list 的 JSON 里 failure 序列化为
 * {"class":"provider","kind":...}，不含 "failed (" 前缀——该标记唯一指向通知正文。
 */
const NOTIFY_ARRIVAL_MARKER = 'failed (provider.'
/** 恢复指引特征片段（ROUND_REPLY_RECOVERY_TAIL——失败轮恢复指引可达宿主的判据）。 */
const RECOVERY_TAIL_MARKER = 'Recovery: re-send your message'
/** 通知边沿即投预算（设计 §3.3.7③：攒批窗删除后恒 <1s；旧 60s 攒批窗形态下必然红）。 */
const NOTIFY_BUDGET_MS = 1_000
/**
 * FailureCause.kind 封闭登记词表（权威源 = packages/subagent-engine-sdk/src/protocol/
 * contract-types.ts 的 FAILURE_CAUSE_CLOSED_KINDS；engine_* 透传族不进闭合表）。
 * 剧本内静态复制作断言参照——kind 值必须落在此词表内才算「登记词表值」。
 */
const FAILURE_CAUSE_CLOSED_KINDS = [
  'rate_limited',
  'protocol_unsupported',
  'turn_budget_exhausted',
  'no_deliverable',
  'cancelled',
]

export const meta = {
  id: 'p0-subagent-round-failure-facticity',
  priority: 'P0',
  title: '软限流死因穿透：失败轮判定事实化 + 轮收条 + list 三处同真相 + 通知 <1s（mock-http 错误轮注入）',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'subagent.dispatch', 'subagent.list',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 90,
  llm: {
    responses: {
      // 主队：step0 派发（toolUse）→ step1 派发收尾 → step2 失败通知轮回复 → step3 闲置备用。
      [`mockllm/${MAIN_MODEL}`]: [
        {
          text: '派一个子任务去核对：',
          toolCalls: [
            {
              name: 'subagent_start',
              args: {
                task: 'Report the first line of your scripted response, nothing else.',
                slug: SUB_SLUG,
                model: `mockllm/${SUB_MODEL}`,
                fork: false,
              },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: `子任务已派发，等待完成通知（${DISPATCH_MARKER}）。`, stopReason: 'stop' },
        { text: `已收到失败通知（${NOTIFY_MARKER}）。`, stopReason: 'stop' },
        { text: 'parent-idle-1', stopReason: 'stop' },
      ],
      // 成员队列**故意为空** = 错误轮注入：成员首个请求命中 mock「剧本已耗尽」HTTP 404
      // （机制依据见文件头注释）。游标不推进，重复请求恒 404——成员首败即轮终。
      [`mockllm/${SUB_MODEL}`]: [],
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
  },
  provable: [
    '错误轮注入：成员首请求命中 mock「剧本耗尽」HTTP 404（errorMessage="404: <body>" 经 pi-ai 真实 provider 错误路径，全链死因穿透的输入）',
    'record 层判定事实化：session.getSubagents 的 record.lastRound.failure —— class="provider"、kind="protocol_unsupported"（登记词表值）、engineStopReason="error"（引擎停因原值）、retryable=false；raw 保真注入错误原文（mock_llm_script_exhausted）',
    '负面断言：全程无 schema_deterministic 分诊残留、record.status 为两态 idle（无 completed 存储值）、通知文案无 finished a round 硬编码',
    'list 同真相：list 查询通道（session.getSubagents，capabilities/subagent.md subagent.list 协议）二次读取的 lastRound.failure 与 record 逐字段同值；C 通道磁盘轮收条含同一分类',
    '通知 <1s：轮终事实帧（session.subagents 首现 lastRound.failure）与失败轮应答到达的时差 ≤1s（攒批窗删除后的边沿即投行为锁）',
    '通知文案事实化：含失败摘要（provider.protocol_unsupported 点拼）+ 恢复指引（Recovery 尾段）',
    '铁证：mock.requests 含成员模型（mock-sub-b）请求（孙进程真的打到 mock 且吃到注入的错误轮）',
  ],
  notProvable: [
    'HTTP 429 / rate_limited / retryAfterMs 分支：mock server 无响应级状态码注入机制（剧本步恒 200 SSE，唯一真实 HTTP 错误 = 队列耗尽 404，scripts/lib/mock-llm.mjs 文件头登记）——429 分类与 Retry-After 提取的验收留给 live 通道或 mock server 扩展后的剧本',
    'UI 面：失败红点（subagent-bucket DOT_RULES 的 lastRound.failure 判据）/ 托盘 / drawer 详情（A 通道，归 UI 剧本）',
    'subagent_manage list 工具出口（agent 侧工具调用）：本剧本走 runtime RPC 查询通道（同一派生视图产出）；工具出口文案归 agent 驱动剧本',
    'mock 回复无真实模型语义：真实 provider 限流的重试行为（retry extension W6）与真实耗时/token 成本',
  ],
}

function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 递归读目录下所有文本文件（体积上限保护）——C 通道磁盘轮收条的读取面。 */
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
    '错误注入机制：成员队列置空 → 首请求命中 mock「剧本已耗尽」HTTP 404（scripts/lib/mock-llm.mjs 文件头「出队耗尽 = HTTP 404 + 结构化 body」+ fixtures/mock-http/README.md 踩坑 3）；mock 剧本步恒 200 SSE、无响应级 429 机制，故 rate_limited 分支不可达（见 notProvable）',
    '与范本 p0-subagent-workflow-dispatch 的口径差异：范本铁证只计 200（404 是耗尽噪音），本剧本 404 是被注入的故障本身——成员请求按 404 断言，不按噪音单列',
    '通知 <1s 测量口径：轮终锚 = protocol.events 里首个 session.subagents 帧（payload 含该 record 的 lastRound.failure）的 receivedAt；通知锚 = 首个载荷含「failed (provider.」标记帧的 receivedAt；两帧同一 WS 依序到达，|Δ| ≤ 1s 判边沿即投——负值 = 通知帧先于 record 广播帧，同属即投形态不判红（60s 攒批窗若未删，Δ 必然 >1s 量级，行为锁有效）',
    'mock-http 游标是 per-model 单游标（mock server 进程持有）：本剧本单 session 单成员、成员队列恒空（游标不推进），无跨段衔接问题',
    '分类断言锚：404 ∈ 非 429 4xx → classifyFailureCause 落 provider.protocol_unsupported（retryable=false，output-collector.ts 内置 HTTP 语义层 + output-collector.test.ts「404」用例）；pi-ai errorMessage = "<status>: <body>"（error-body.js formatProviderError 实装核实）',
    'record 终态判据用两态词表（running/idle，capabilities/subagent.md Gotcha 3）：失败轮终 = status idle + lastRound.failure 非空，不断 legacy completed/failed',
  ]

  // 装配自检：models.json 的 mock provider 指向本机 mock 服务 + 孙进程缺省模型指向成员模型
  const topo = instance.llm
  const modelsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  const subCfg = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'subagents', 'config.json')) || '{}')
  ev.assert('装配：孙进程缺省模型 = 成员模型（subagents/config.json engineDefaults.pi）', String(subCfg.engineDefaults?.pi ?? '').includes(SUB_MODEL), {
    channel: 'C',
    expected: `engineDefaults.pi 含 ${SUB_MODEL}`,
    actual: subCfg.engineDefaults?.pi ?? '<缺>',
  })

  // ══ 派发：subagent_start（model=成员模型），成员首轮即吃注入的错误轮 ════
  const created = await protocol.call('session.create', { cwd: repo, label: 'p0-subagent-failure' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('A0: session.create 返回 sessionId', Boolean(sid), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created.session ?? {}).slice(0, 300),
  })
  await protocol.subscribe(sid)
  log(`session=${sid} model=${created.session?.modelId}`)
  ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid, modelId: created.session?.modelId } })

  const sinceDispatch = protocol.events.length
  await protocol.send(sid, 'dispatch one subagent that will fail (p0-subagent-round-failure-facticity)')
  const end = await protocol.waitTurnEnd(sid, { since: sinceDispatch, timeoutMs: 180_000 })
  ev.assert('A1① 主轮完成（message.complete 非 error）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'} msg=${String(end.payload?.message ?? '').slice(0, 200)}`,
  })
  const hist = await protocol.history(sid, { limitTurns: 10 })
  ev.assert('控制组：主会话文本来自主队剧本（SUBAGENT-FAIL-DISPATCHED）', JSON.stringify(hist.messages ?? []).includes(DISPATCH_MARKER), {
    channel: 'B',
    expected: `history 含 ${DISPATCH_MARKER}`,
    actual: `messages=${(hist.messages ?? []).length}`,
  })

  // 条件轮询：record 走到「失败轮终」形态（idle + lastRound.failure 非空）。RPC 是真理通道（ADR-0097）。
  const deadline = Date.now() + 120_000
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === SUB_SLUG) ?? records[0] ?? null
    if (record && record.status === 'idle' && record.lastRound?.failure) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ev.step({
    step: 'subagent.observe', channel: 'B', exitCode: 0,
    stats: {
      count: records.length,
      status: record?.status,
      model: record?.model,
      engineStopReason: record?.lastRound?.engineStopReason,
      failureClass: record?.lastRound?.failure?.class,
      failureKind: record?.lastRound?.failure?.kind,
    },
  })
  if (!record || !record.lastRound?.failure) {
    // fail-fast：判定链没产出事实字段，后续②③④⑤全部失义——固化现场后终止，防连环误导性失败
    ev.attach('subagent-records', JSON.stringify(records, null, 2).slice(0, 40_000))
    ev.attach('pending-snapshot', JSON.stringify(instance.mockLlm?.pending() ?? {}, null, 2))
    ev.attach('mock-requests', JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, error: r.error })), null, 2))
    ev.assert('record 走到失败轮终（idle + lastRound.failure 非空）', false, {
      channel: 'B',
      expected: 'record.status=idle 且 record.lastRound.failure 非空（判定链产出事实字段）',
      actual: record
        ? `status=${record.status} lastRound=${JSON.stringify(record.lastRound ?? null).slice(0, 300)}（轮收条未产出 failure = 判定链未穿透，后续断言中止）`
        : `records 为空（count=${records.length}，record 未建或派发未受理）`,
    })
    return { uncovered: ['record 未产出 lastRound.failure，②③④⑤ 未执行（防误导性失败组合）'], gotchas }
  }

  // ══ 断言② record 层：lastRound 事实字段（走事实判据，不走向当映射字段判据）════
  const failure = record.lastRound.failure
  const recordJson = JSON.stringify(record)
  ev.assert('A1② failure.class = "provider"（判定链事实字段，非映射字段）', failure.class === 'provider', {
    channel: 'B',
    expected: 'lastRound.failure.class === "provider"',
    actual: `class=${failure.class} kind=${failure.kind} retryable=${String(failure.retryable)}`,
  })
  ev.assert('A1② failure.kind 是登记词表值（provider.protocol_unsupported——404 ∈ 非 429 4xx）', FAILURE_CAUSE_CLOSED_KINDS.includes(failure.kind) && failure.kind === 'protocol_unsupported', {
    channel: 'B',
    expected: `kind ∈ 登记词表 [${FAILURE_CAUSE_CLOSED_KINDS.join(', ')}] 且 404 分类落 protocol_unsupported`,
    actual: `kind=${failure.kind} raw=${String(failure.raw ?? '').slice(0, 160)}`,
  })
  ev.assert('A1② engineStopReason = "error"（引擎停因原值，非推断展示词）', record.lastRound.engineStopReason === 'error', {
    channel: 'B',
    expected: 'lastRound.engineStopReason === "error"',
    actual: `engineStopReason=${record.lastRound.engineStopReason ?? '<缺>'} status=${record.status}`,
  })
  ev.assert('A1② retryable = false（非 429 4xx：重发必然同样失败，禁止按状态码判 true）', failure.retryable === false, {
    channel: 'B',
    expected: 'failure.retryable === false',
    actual: `retryable=${String(failure.retryable)}`,
  })
  ev.assert('A1② raw 保真注入错误原文（404 前缀 + mock_llm_script_exhausted——死因穿透到注入点）', /^404: /.test(String(failure.raw ?? '')) && String(failure.raw ?? '').includes('mock_llm_script_exhausted'), {
    channel: 'B',
    expected: 'raw 以 "404: " 开头且含 mock_llm_script_exhausted（分类不丢原文）',
    actual: String(failure.raw ?? '').slice(0, 240),
  })
  ev.assert('负面：record 无 schema_deterministic 分诊残留，status 为两态 idle（无 completed 存储值）', !recordJson.includes('schema_deterministic') && record.status === 'idle', {
    channel: 'B',
    expected: 'record JSON 不含 schema_deterministic 且 status=idle（两态词表，completed 仅派生展示词）',
    actual: `status=${record.status} 含schema_deterministic=${recordJson.includes('schema_deterministic')}`,
  })
  ev.attach('subagent-records', JSON.stringify(records, null, 2).slice(0, 40_000))

  // ══ 断言③ list 同真相：list 查询通道二次读取 + C 通道磁盘轮收条 ══════════════
  const listReply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
  const listRecords = listReply.subagents ?? []
  const listRecord = listRecords.find((r) => r.slug === SUB_SLUG) ?? listRecords[0] ?? null
  const sameTruth =
    listRecord !== null &&
    JSON.stringify(listRecord.lastRound?.failure ?? null) === JSON.stringify(failure) &&
    listRecord.lastRound?.engineStopReason === record.lastRound.engineStopReason
  ev.assert('A1③ list 视图 lastRound 与 record 同值（session.getSubagents 即 list 查询通道，二次读取稳定）', listRecords.length >= 1 && sameTruth, {
    channel: 'B',
    expected: `list 条目 lastRound.failure 逐字段等于 record（${failure.class}.${failure.kind}）`,
    actual: `listCount=${listRecords.length} 同值=${sameTruth} listFailure=${JSON.stringify(listRecord?.lastRound?.failure ?? null).slice(0, 200)}`,
  })
  const diskText = readTreeText(path.join(dataDir, 'ext-sessions', String(sid), 'subagents'))
  const diskHasFailure = diskText.includes('"protocol_unsupported"') || diskText.includes('protocol_unsupported')
  ev.assert('A1③ 磁盘轮收条含同一失败分类（C 通道 record-round-idle 写盘事实）', diskHasFailure, {
    channel: 'C',
    expected: 'subagents 树内轮收条帧含 protocol_unsupported 分类',
    actual: `bytes=${diskText.length} hit=${diskHasFailure}`,
  })
  ev.attach('subagents-disk', diskText.slice(0, 120_000))

  // ══ 断言④⑤ 通知 <1s + 文案事实化 ══════════════════════════════════════════
  // 轮终锚：首个 session.subagents 帧且载荷含该 record 的 lastRound.failure（轮收条事实的
  // 查询面广播——record 折叠后的派生视图发布）。
  let roundEndEvt = null
  try {
    roundEndEvt = await protocol.waitFor(
      (e) =>
        e.type === 'session.subagents' &&
        (e.payload?.subagents ?? []).some((r) => r.slug === SUB_SLUG && r.lastRound?.failure),
      { since: sinceDispatch, timeoutMs: 60_000, sessionId: sid },
    )
  } catch {
    roundEndEvt = null
  }
  // 通知锚：首个载荷含「failed (provider.」标记的帧（失败轮应答正文，见 NOTIFY_ARRIVAL_MARKER 注释）。
  let notifyEvt = null
  try {
    notifyEvt = await protocol.waitFor(
      (e) => JSON.stringify(e.payload ?? {}).includes(NOTIFY_ARRIVAL_MARKER),
      { since: sinceDispatch, timeoutMs: 60_000, sessionId: sid },
    )
  } catch {
    notifyEvt = null
  }
  const notifyText = notifyEvt ? JSON.stringify(notifyEvt.payload) : ''
  ev.step({
    step: 'notify.timing', channel: 'B', exitCode: 0,
    stats: {
      roundEndAt: roundEndEvt?.receivedAt ?? '<缺>',
      notifyAt: notifyEvt?.receivedAt ?? '<缺>',
      deltaMs: roundEndEvt && notifyEvt ? notifyEvt.receivedAt - roundEndEvt.receivedAt : '<缺>',
    },
  })
  ev.assert('A1④ 轮终事实帧与通知到达帧均在事件流中出现（两锚齐备才可测时差）', Boolean(roundEndEvt && notifyEvt), {
    channel: 'B',
    expected: 'session.subagents 失败帧 + 通知标记帧都到达',
    actual: `roundEndFrame=${roundEndEvt ? '有' : '缺（recentFrames=' + protocol.recentTypeSummary(10) + '）'} notifyFrame=${notifyEvt ? '有' : '缺'}`,
  })
  if (roundEndEvt && notifyEvt) {
    const deltaMs = notifyEvt.receivedAt - roundEndEvt.receivedAt
    ev.assert(`A1④ 通知边沿即投：轮终 → 通知到达时差 ≤1s（实测 ${deltaMs}ms；攒批窗删除行为锁）`, Math.abs(deltaMs) <= NOTIFY_BUDGET_MS, {
      channel: 'B',
      expected: `|通知帧 receivedAt − 轮终帧 receivedAt| ≤ ${NOTIFY_BUDGET_MS}ms`,
      actual: `delta=${deltaMs}ms（负值 = 通知帧先于 record 广播帧，同属即投形态）`,
    })
  }
  ev.assert('A1⑤ 通知文案事实化：失败摘要（provider.protocol_unsupported 点拼）+ 恢复指引可达', notifyText.includes(NOTIFY_ARRIVAL_MARKER) && notifyText.includes(RECOVERY_TAIL_MARKER), {
    channel: 'B',
    expected: `通知正文含「${NOTIFY_ARRIVAL_MARKER}」与恢复指引「${RECOVERY_TAIL_MARKER}」`,
    actual: notifyEvt ? notifyText.slice(0, 400) : '通知帧未到达',
  })
  ev.assert('负面：通知文案无 finished a round 硬编码残留', Boolean(notifyEvt) && !notifyText.includes('finished a round'), {
    channel: 'B',
    expected: '轮应答正文事实化，不含 finished a round',
    actual: notifyEvt ? `含 finished a round=${notifyText.includes('finished a round')}` : '通知帧未到达',
  })
  ev.attach('notify-frame', notifyEvt ? JSON.stringify(notifyEvt.payload, null, 2).slice(0, 20_000) : '(无通知帧)')

  // 控制组：失败通知确实触发了主 agent 新一轮（主队游标消费到 step2 = 通知轮回复已发生）。
  const queue = await waitMainQueueConsumed(instance, 3, 90_000)
  ev.assert('控制组：失败通知触发主 agent 通知轮（主队游标 ≥3）', queue.ok, {
    channel: 'C',
    expected: `mock-1 队列已消费 ≥3 步（派发 + 收尾 + 通知轮）`,
    actual: `consumed=${queue.consumed}`,
  })

  // ══ 铁证：mock 服务端收到的成员模型请求（404 = 注入的错误轮本身）═════════════
  const allRequests = instance.mockLlm?.requests ?? []
  const memberRequests = allRequests.filter((r) => r.model === SUB_MODEL)
  const memberInjected = memberRequests.filter((r) => r.status === 404 && String(r.error ?? '').includes('剧本已耗尽'))
  ev.step({
    step: 'mock.requests', channel: 'C', exitCode: 0,
    stats: {
      total: allRequests.length,
      main: allRequests.filter((r) => r.model === MAIN_MODEL).length,
      member: memberRequests.length,
      memberInjected404: memberInjected.length,
      models: [...new Set(allRequests.map((r) => r.model))].join(','),
    },
  })
  ev.assert('铁证：mock 收到成员模型请求且命中注入的错误轮（404 剧本已耗尽）', memberInjected.length >= 1, {
    channel: 'C',
    expected: `≥1 × model=${SUB_MODEL} status=404 error 含「剧本已耗尽」`,
    actual: `member=${memberRequests.length} injected404=${memberInjected.length}（statuses=${memberRequests.map((r) => r.status).join(',')}）`,
  })
  ev.attach(
    'mock-requests',
    JSON.stringify(
      allRequests.map((r) => ({ model: r.model, status: r.status, queueKey: r.queueKey, stepIndex: r.stepIndex, messageCount: r.messageCount, error: r.error })),
      null,
      2,
    ).slice(0, 120_000),
  )

  log(`done sid=${sid} class=${failure.class} kind=${failure.kind} recordOk=${sameTruth}`)
  return { uncovered, gotchas }
}
