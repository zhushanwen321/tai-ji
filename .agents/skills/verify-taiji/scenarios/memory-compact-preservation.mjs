/**
 * memory-compact-preservation —— 记忆扩展（@zhushanwen/pi-memory）压缩保全真机验收
 * （设计 memory-system §4 V3 / 验收清单 A3；U5 before_compact，设计 D5，守护 G9/RL4）。
 *
 * 场景：长会话上下文越过 pi 原生 threshold 压缩兜底线 → 下一回合请求前 pi agent-session
 * .compact() 同步执行 → emit session_before_compact → memory 处理器提炼将被丢弃消息 →
 * 压缩正常完成不被取消。
 *
 * 触发通道选型（2026-11-13 本 worktree 实测归因）：renderer 手动 /compact 走
 * session.compactBackground RPC → 系统命令 /__taiji_compact__ → smart-context 后台路径
 * （appendCompaction 直调，不经过 pi compact()）——不触发 before_compact 链。memory 保全
 * 的实际触发面 = pi 原生同步压缩路径（threshold 兜底 / overflow），即本剧本采用的
 * threshold 触发（设计 V3 场景定义「threshold 或手动 /compact」的第一种）。手动通道与
 * before_compact 保全的错位登记为 notes（产品集成疑点，非本剧本可修）。
 *
 * ── LLM 通道选型：mock-http（meta.llm），三路调用按模型分队列 ──
 *
 * 压缩链路上共存三路 LLM 调用（设计文档 §7 真机验证集行引 async-compaction 剧本头注
 * 实测结论「faux 双注册共享同一响应队列、同进程多路 LLM 调用无法按模型分队列」）：
 *   ① 主会话回合回复 → mockllm/mock-main（settings defaultModel）
 *   ② memory 压缩保全提炼（ctx.modelRegistry.complete，继承当轮会话模型——
 *      extract/runner.ts createModelRegistryCompleteCall）→ 也打 mockllm/mock-main 队列！
 *   ③ smart-context 压缩摘要（cross-model compactModel）→ mockllm/mock-compact 独立队列
 * ②与①共用 mock-main 的 per-model 单游标：靠「每步之间条件等待请求数到位」严格同步
 * （waitForMockRequest），队列步序 = 消费序，见下方队列注释。
 *
 * pi emit 链语义（node_modules pi-coding-agent runner.js emit，实码核实）：session_before_
 * compact 的全部 handler 串行 await 执行、handler 抛错被吞成 emitError、仅 cancel 短路——
 * memory handler（恒返回放行）与 smart-context handler（返回 compaction 接管）共存，
 * 两者的调用都真实发生。
 *
 * ── threshold 触发线算术（先例 async-compaction V3 段同款）──
 *
 * mock 窗口 128_000；pi 原生 threshold 兜底 = 128_000 − 16_384 = 111_616（shouldCompact
 * 严格大于）。布局：三条 48k chars（各 ≈12k tokens）+ 一条 360k chars 大消息（≈90k
 * tokens）≈ 126.1k > 111_616 → 大消息回合后的下一条消息触发同步压缩。FACT 哨兵埋在
 * 消息 A（最早，必落在被压段——findCutPoint keepRecentTokens=20_000 从尾回溯，最早的
 * A 远离切点）。
 *
 * ── 队列步序（mock-main per-model 单游标，按到达序消费）──
 * 造上下文每条消息的用户正文 ≥3 词（中文填充）→ 每回合 turn_end 提炼必入队——
 * mock-main 队列按「回合步 / 提炼步」严格交错编排，每条消息后条件等待请求数到位
 * （回合 + 提炼各一）再发下一条，消费序确定：
 *   step0/1 消息A回合+提炼（skip）/ step2/3 消息B / step4/5 消息C / step6/7 大消息D
 *   step8 第5条消息触发同步压缩：memory before_compact 提炼步（返回 add 操作集，name=
 *        compact-preserved-fact，正文含 FACT 哨兵）→ applyExtractOperations 落盘
 *   step9 第5条消息回合回复（压缩后上下文上的首轮）
 *   step10 第5条回合提炼（skip）/ 尾部 +2 备用 skip 步
 * mock-compact 队列：摘要步 ×2（split-turn 双调用余量；文本含 SUMMARY 哨兵）。
 *
 * Cleanup 由 runner 承载（SKILL.md §5）；本剧本零自持进程，fixture 全在 dataDir 内随
 * dispose 删除。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 常量（来源：extensions/universal/memory 源码 + 先例剧本）──────────────────
/** 主会话模型（回合演员 + memory 提炼调用继承的当轮会话模型）。 */
const MAIN_MODEL = 'mock-main'
/** smart-context cross-model 压缩摘要演员。 */
const COMPACT_MODEL = 'mock-compact'
const PROVIDER = 'mockllm'

/** 被压段哨兵：埋在消息 A（被压段）的关键事实码——V3 断言其进 memory 提炼素材与新条目。 */
const FACT_CODE = 'FACT-CODE-8842'
/** 压缩保全落盘条目 name（mock 提炼步返回的 add 操作集指定）。 */
const PRESERVED_ENTRY = 'compact-preserved-fact'
/** smart-context 摘要哨兵（mock-compact 摘要文本必含）。 */
const SUMMARY_MARK = 'SUMMARY-KEEPS-8842'
/** memory 回合/压缩提炼 systemPrompt 首句特征（extract/prompt.ts buildExtractionPrompt）。 */
const EXTRACTOR_MARK = '你是记忆提炼器'
/** memory 扩展放弃日志标记（compact/hook.ts RL4 降级路径；正常路径不应出现）。 */
const GAVE_UP_MARK = 'compaction preservation gave up'

/** 造上下文单条消息字符量（48_000 chars ≈ 12_000 tokens；三条布局见文件头）。 */
const CONTEXT_MSG_CHARS = 48_000
/** 越线大消息字符量（360_000 chars ≈ 90_000 tokens；三条 12k + 90k ≈ 126.1k > 兜底线 111_616）。 */
const OVERSIZE_MSG_CHARS = 360_000
/** 单回合完成预算。 */
const TURN_BUDGET_MS = 60_000

// ── mock 演员 ─────────────────────────────────────────────────────────────────

/** 造上下文消息文本（哨兵埋消息 A；B/C 为切点布局材料）。 */
function contextMessage(label, withFact, chars = CONTEXT_MSG_CHARS) {
  const head = withFact
    ? `长期协作约定：所有模块日志必须携带事实码 ${FACT_CODE}（JSON 格式输出，这是用户明确的偏好决策）。`
    : `背景材料 ${label}。`
  return `${head}${'背景细节'.repeat(Math.ceil((chars - head.length) / 4))}`
}

/** skip 操作集（回合提炼步 / 队列备用步）。 */
const SKIP_STEP = { text: '{"operations":[{"op":"skip","reason":"mock 演员编排的跳过步"}]}', stopReason: 'stop' }

/** mock-main 队列（步序语义见文件头注释）。 */
const mainQueue = [
  { text: 'ack-a 已收到长期协作约定（消息 A 回合）', stopReason: 'stop' }, // step0
  SKIP_STEP, // step1 消息A回合提炼
  { text: 'ack-b 收到背景材料 B', stopReason: 'stop' }, // step2
  SKIP_STEP, // step3 消息B回合提炼
  { text: 'ack-c 收到背景材料 C', stopReason: 'stop' }, // step4
  SKIP_STEP, // step5 消息C回合提炼
  { text: 'ack-d 收到越线大材料 D', stopReason: 'stop' }, // step6
  SKIP_STEP, // step7 大消息D回合提炼
  {
    // step8 压缩保全提炼：add 操作集（type=user → user scope 落 facts/）
    text: `{"operations":[{"op":"add","name":"${PRESERVED_ENTRY}","description":"压缩保全提炼的关键事实：日志必须携带事实码","type":"user","content":"被压缩消息中的关键事实：所有模块日志必须携带事实码 ${FACT_CODE}（用户明确的偏好决策）。\\nWhy: 用户在长会话中明确要求，压缩不应丢失该约定。\\nHow to apply: 生成任何模块日志时输出 JSON 并携带事实码。"}]}`,
    stopReason: 'stop',
  },
  { text: 'ack-e 越线后首条消息回合完成（threshold 同步压缩后）', stopReason: 'stop' }, // step9
  SKIP_STEP, // step10 第5条回合提炼
  SKIP_STEP, // 备用
  SKIP_STEP, // 备用
]

/** mock-compact 摘要步（含摘要哨兵；split-turn 双调用余量 ×2）。 */
const compactQueue = [
  { text: `${SUMMARY_MARK}：本轮压缩摘要——保留了日志事实码约定与三项背景材料的要点。`, stopReason: 'stop' },
  { text: `${SUMMARY_MARK}：split-turn 第二段摘要（余量步）。`, stopReason: 'stop' },
]

export const meta = {
  id: 'memory-compact-preservation',
  priority: 'P1',
  title: '记忆扩展压缩保全 V3：before_compact 提炼落盘 + 压缩不被取消 + 与 smart-context 共存',
  covers: [
    'session.create', 'chat.send', 'chat.wait', 'session.history',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 420,
  // TAIJI_AGENT_DEBUG=1：memory / smart-context 扩展 fileLog 落 <dataDir>/agent/logs/<name>-<date>.log
  env: { TAIJI_AGENT_DEBUG: '1' },
  llm: {
    mainModel: MAIN_MODEL,
    models: [MAIN_MODEL, COMPACT_MODEL],
    responses: {
      [`${PROVIDER}/${MAIN_MODEL}`]: mainQueue,
      [`${PROVIDER}/${COMPACT_MODEL}`]: compactQueue,
    },
  },
  provable: [
    '手动压缩正常完成：session JSONL 落 compaction entry（fromHook=true，smart-context 接管）',
    'memory 压缩保全提炼调用真实发生：mock-main 队列被消费一步、请求 system 含「你是记忆提炼器」、素材含被压段事实码',
    '新条目 origin: compaction 落盘（facts/compact-preserved-fact.md frontmatter + 正文含事实码）',
    '写入入口重建索引：user 级 MEMORY.md 出现该条目索引行',
    'smart-context 共存无冲突：cross-model 摘要请求打到 mock-compact、压缩 entry details.engine=smart-context、memory 日志无放弃标记',
    '压缩后会话仍可正常对话（压缩未被取消/未卡死——RL4 用户操作不被记忆系统阻塞）',
  ],
  notProvable: [
    '真实模型智能下的提炼质量（mock 提炼步由剧本编排返回固定操作集，非模型语义产出）',
    'split turn 批次（turnPrefixMessages）素材完整性——切点需精确落在回合中间，本装配切点由 findCutPoint 回溯决定；设计 s4 V3 步骤④的 split turn 专项用例未纳入',
    '网络超时放弃路径（RL4 降级半边）——mock 即时返回无慢网络窗口；降级日志标记（gave up）仅在异常路径出现，本剧本断言其不出现（正常路径）',
    '手动 /compact（compactBackground 后台路径）下的 memory 保全——该路径不经过 pi session_before_compact（appendCompaction 直调），memory 保全不可达；错位登记 notes',
    '注入开/关的压缩触发点基线对比（设计 V3 步骤⑤）——需双实例对照装配',
  ],
}

// ── 剧本 helper ───────────────────────────────────────────────────────────────

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 条件等待 mock server 收到指定模型的第 N 个 200 请求（禁固定 sleep）。 */
async function waitMockRequests(instance, model, count, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const hits = (instance.mockLlm?.requests ?? []).filter(
      (r) => r.status === 200 && (r.model === model || r.model?.endsWith(`/${model}`)),
    )
    if (hits.length >= count) return hits
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `等待 mock 请求超时（${label}）：model=${model} 期望 ≥${count}，实际 ${hits.length}；` +
          `全部请求=${JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })))}`,
      )
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 请求体全文（system + 各 role content 抽平；systemPrompt 经 provider 转 messages[0]）。 */
function requestFullText(request) {
  return (request?.messages ?? [])
    .map((m) => {
      if (typeof m?.content === 'string') return m.content
      if (Array.isArray(m?.content)) return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      return ''
    })
    .join('\n')
}

/** 定位 session JSONL（pi 文件名 = <ts>_<sessionId>.jsonl；按 sessionId 递归匹配）。 */
function findSessionJsonl(dataDir, sessionId) {
  const root = path.join(dataDir, 'agent', 'sessions')
  if (!fs.existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find((n) => n.endsWith('.jsonl') && n.includes(sessionId))
    if (hit) return path.join(dir, hit)
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full)
      } catch {
        /* 竞态删除跳过 */
      }
    }
  }
  return null
}

/** 读 session JSONL 为 entry 数组（坏行跳过计数）。 */
function readEntries(file) {
  const entries = []
  let bad = 0
  for (const line of readText(file).split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  return { entries, bad }
}

/** 写 smart-context cross-model 配置（<agentDir>/config/smart-context-ext-config.json；读时刷新即时生效）。 */
function writeSmartContextConfig(dataDir) {
  const file = path.join(dataDir, 'agent', 'config', 'smart-context-ext-config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        enabled: true,
        compactModel: { type: 'ref', ref: `${PROVIDER}/${COMPACT_MODEL}` },
        reminderThresholds: [8_000, 16_000],
        excludedModels: [],
        autoCompactThresholdRatio: 0.9,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return file
}

/** 读 memory 扩展日志（<dataDir>/agent/logs/memory-*.log 全量拼接）。 */
function readMemoryLog(dataDir) {
  const dir = path.join(dataDir, 'agent', 'logs')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('memory-') && f.endsWith('.log'))
    .map((f) => readText(path.join(dir, f)))
    .join('\n')
}

// ── 剧本主体 ─────────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    '手动 /compact（session.compactBackground）走 smart-context 后台路径 appendCompaction 直调，不触发 pi session_before_compact——memory 保全的触发面只有 pi 原生同步压缩（threshold 兜底/overflow）；本 worktree 协议无同步 session.compact RPC（feat-async-compaction 时代先例剧本的该入口已演进）',
    'memory 提炼 complete 继承当轮会话模型（extract/runner.ts AS12）——与主回合共用 mock-main per-model 单游标，每步间必须条件等待请求数到位再推进（错位消费会让提炼拿到普通文本、解析重试后放弃）',
    'mock-main 队列步序 = 严格消费序：回合步与提炼步交错编排，见文件头队列注释',
    'smart-context 摘要走独立 mock-compact 队列（cross-model 装配，compactModel ≠ 当前模型）',
    'memory before_compact 提炼有 15s 网络超时（COMPACT_NETWORK_TIMEOUT_DEFAULT_MS）——mock 演员不设 tps 即时返回，规避超时误判',
  ]

  // 装配自检：mock provider 指向本机 mock 服务；smart-context cross-model 配置落盘
  const topo = instance.llm
  const modelsJson = JSON.parse(readText(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  const scCfgFile = writeSmartContextConfig(dataDir)
  const scCfg = JSON.parse(readText(scCfgFile) || '{}')
  ev.assert('装配：smart-context 配置 cross-model 压缩模型 = mock-compact', scCfg?.compactModel?.ref === `${PROVIDER}/${COMPACT_MODEL}`, {
    channel: 'C',
    expected: `compactModel.ref=${PROVIDER}/${COMPACT_MODEL}`,
    actual: scCfg?.compactModel?.ref ?? '<缺>',
  })
  ev.step({ step: 'assemble.config', channel: 'C', exitCode: 0, stats: { scCfgFile, providerId: topo.providerId } })

  // ── 建会话 + 造上下文（三条 12k tokens 消息，切点 = B-user，被压段含消息 A）──
  const created = await protocol.call('session.create', { cwd: repo, label: 'memory-compact' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('A: session.create 返回 sessionId', Boolean(sid), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(created.session ?? {}).slice(0, 200),
  })
  await protocol.subscribe(sid)
  ev.step({ step: 'session.create', channel: 'B', exitCode: 0, stats: { sessionId: sid, modelId: created.session?.modelId } })

  // 消息 A：≥3 词（中文正文）→ 回合 + turn_end 回合提炼（skip 步）
  let since = protocol.events.length
  await protocol.send(sid, contextMessage('A（含关键事实）', true))
  let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('A1: 消息 A 回合完成（message.complete 非 error）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  // 回合提炼（fire-and-forget）已到达 mock：等 mock-main 第 2 个请求（step0 回合 + step1 提炼）
  const afterA = await waitMockRequests(instance, MAIN_MODEL, 2, 30_000, '消息A回合+回合提炼')
  ev.step({
    step: 'chat.contextA', channel: 'B', exitCode: 0,
    stats: { turnOk: end.ok, mockMainRequests: afterA.length },
  })

  // 消息 B / C：正文 ≥3 词（每回合回合步+提炼步各消费一步，条件等待到位防错位）
  for (const [i, label] of ['B', 'C'].entries()) {
    const expectReqs = 4 + i * 2 // A 段 2 步 + 本条前已完成的（B:4 / C:6）
    since = protocol.events.length
    await protocol.send(sid, contextMessage(label, false))
    end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
    ev.assert(`A2: 消息 ${label} 回合完成`, end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const reqs = await waitMockRequests(instance, MAIN_MODEL, expectReqs, 30_000, `消息${label}回合+提炼`)
    ev.step({
      step: `chat.context${label}`, channel: 'B', exitCode: 0,
      stats: { mockMainRequests: reqs.length },
    })
  }

  // 大消息 D：把上下文推过原生兜底线（111_616 tokens），为第 5 条消息的同步压缩铺路
  since = protocol.events.length
  await protocol.send(sid, contextMessage('D（越线大材料）', false, OVERSIZE_MSG_CHARS))
  end = await protocol.waitTurnEnd(sid, { since, timeoutMs: TURN_BUDGET_MS })
  ev.assert('A3: 越线大消息 D 回合完成（回合不拒、不卡死）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  await waitMockRequests(instance, MAIN_MODEL, 8, 30_000, '大消息D回合+提炼')
  ev.step({ step: 'chat.contextD', channel: 'B', exitCode: 0, stats: { oversizeChars: OVERSIZE_MSG_CHARS } })

  // ── 第 5 条消息：threshold 同步压缩在回合请求前发生 ──────────────────────
  // pi agent-session.compact()：emit session_before_compact → memory 提炼（mock-main
  // step8）→ smart-context cross-model 摘要（mock-compact）→ appendCompaction → 回合请求。
  const compactT0 = Date.now()
  since = protocol.events.length
  await protocol.send(sid, '现在检查压缩后的状态，简短回复即可')
  end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  const turn5Ok = end.type === 'message.complete' && end.ok
  ev.assert('A4: 越线后首条消息回合完成（同步压缩后用户回合不被阻塞——RL4）', turn5Ok, {
    channel: 'B',
    expected: 'message.complete 非 error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({
    step: 'chat.triggerCompact', channel: 'B', exitCode: turn5Ok ? 0 : 1,
    stats: { elapsedMs: Date.now() - compactT0 },
  })

  // 断言素材：mock-main 请求中 system 含提炼器首句的 = memory 压缩保全提炼调用
  const mainReqs = (instance.mockLlm?.requests ?? []).filter(
    (r) => r.status === 200 && (r.model === MAIN_MODEL || r.model?.endsWith(`/${MAIN_MODEL}`)),
  )
  const extractReq = mainReqs.find((r) => requestFullText(r).includes(EXTRACTOR_MARK)) ?? null
  ev.assert('B1: memory 压缩保全提炼调用真实发生（请求 system 含「你是记忆提炼器」）', Boolean(extractReq), {
    channel: 'C',
    expected: `mock-main 请求含「${EXTRACTOR_MARK}」`,
    actual: `mainRequests=${mainReqs.length} steps=${mainReqs.map((r) => r.stepIndex).join(',')}`,
  })
  ev.assert('B2: 提炼素材含被压段关键事实码（messagesToSummarize 全量进提炼载荷）', extractReq ? requestFullText(extractReq).includes(FACT_CODE) : false, {
    channel: 'C',
    expected: `提炼请求含 ${FACT_CODE}`,
    actual: extractReq ? `stepIndex=${extractReq.stepIndex} messageCount=${extractReq.messageCount}` : '(提炼请求未出现)',
  })
  ev.attach('extract-request', extractReq ? JSON.stringify({ stepIndex: extractReq.stepIndex, messageCount: extractReq.messageCount, summary: extractReq.summary }, null, 2) : '(无)')

  // 断言①压缩完成：session JSONL compaction entry（fromExtension = smart-context 接管）
  const jsonl = findSessionJsonl(dataDir, sid)
  const { entries, bad } = jsonl ? readEntries(jsonl) : { entries: [], bad: 0 }
  const compactions = entries.filter((e) => e?.type === 'compaction')
  const lastCompaction = compactions[compactions.length - 1] ?? null
  ev.assert('C1: 压缩完成——session JSONL 落 compaction entry', compactions.length >= 1, {
    channel: 'C',
    expected: '≥1 条 type=compaction entry',
    actual: `compactions=${compactions.length} entries=${entries.length} badLines=${bad}`,
  })
  ev.assert('C1b: compaction entry 来自扩展接管（fromHook=true，pi appendCompaction 字段名）且摘要含哨兵', lastCompaction?.fromHook === true && String(lastCompaction?.summary ?? '').includes(SUMMARY_MARK), {
    channel: 'C',
    expected: `fromHook=true + summary 含 ${SUMMARY_MARK}`,
    actual: `fromHook=${lastCompaction?.fromHook} summary=${String(lastCompaction?.summary ?? '').slice(0, 120)}`,
  })
  ev.step({
    step: 'compact.entry', channel: 'C', exitCode: compactions.length >= 1 ? 0 : 1,
    stats: { compactions: compactions.length, fromHook: lastCompaction?.fromHook, details: lastCompaction?.details },
  })

  // 断言③smart-context 共存：cross-model 摘要请求打到 mock-compact + entry details.engine
  const compactReqs = (instance.mockLlm?.requests ?? []).filter(
    (r) => r.status === 200 && (r.model === COMPACT_MODEL || r.model?.endsWith(`/${COMPACT_MODEL}`)),
  )
  ev.assert('C2: smart-context 摘要调用真实发生（mock-compact 队列被消费，跨 handler 共存无冲突）', compactReqs.length >= 1, {
    channel: 'C',
    expected: '≥1 × mock-compact 请求',
    actual: `${compactReqs.length} 次（steps=${compactReqs.map((r) => r.stepIndex).join(',')}）`,
  })
  const engineOk = String(lastCompaction?.details?.engine ?? '') === 'smart-context'
  ev.assert('C2b: compaction entry details.engine=smart-context（memory 放行 + smart-context 接管同链共存）', engineOk, {
    channel: 'C',
    expected: 'details.engine=smart-context',
    actual: JSON.stringify(lastCompaction?.details ?? {}),
  })

  // 断言②origin: compaction 条目落盘 + 索引重建
  const memoryDir = path.join(dataDir, 'agent', 'memory')
  const preservedPath = path.join(memoryDir, 'facts', `${PRESERVED_ENTRY}.md`)
  const preserved = readText(preservedPath)
  ev.assert('D1: 新条目落盘 facts/compact-preserved-fact.md（user scope）', preserved !== '', {
    channel: 'C',
    expected: preservedPath,
    actual: preserved ? '在盘' : '不存在',
  })
  ev.assert('D2: 条目 frontmatter origin: compaction（V3 通过标准原文）', /^ {2}origin: compaction$/m.test(preserved), {
    channel: 'C',
    expected: 'metadata.origin = compaction',
    actual: preserved ? preserved.split('---')[1]?.trim().split('\n').filter((l) => l.includes('origin')).join(' | ') : '(文件缺失)',
  })
  ev.assert('D3: 条目正文含被压段关键事实码（提炼产物承载关键事实）', preserved.includes(FACT_CODE), {
    channel: 'C',
    expected: `正文含 ${FACT_CODE}`,
    actual: preserved ? `hit=${preserved.includes(FACT_CODE)}` : '(文件缺失)',
  })
  const userIndex = readText(path.join(memoryDir, 'MEMORY.md'))
  ev.assert('D4: user 级索引重建（MEMORY.md 含新条目索引行）', userIndex.includes(PRESERVED_ENTRY), {
    channel: 'C',
    expected: `MEMORY.md 含 ${PRESERVED_ENTRY}`,
    actual: userIndex ? userIndex.slice(0, 300) : '(索引缺失)',
  })
  ev.attach('preserved-entry', preserved.slice(0, 2_000))
  ev.attach('user-index', userIndex.slice(0, 2_000))
  ev.step({
    step: 'memory.entry', channel: 'C', exitCode: preserved.includes(FACT_CODE) && /^ {2}origin: compaction$/m.test(preserved) ? 0 : 1,
    stats: { path: preservedPath, indexHit: userIndex.includes(PRESERVED_ENTRY) },
  })

  // 断言：memory 日志无放弃标记（正常路径；RL4 降级路径留给 notProvable）
  const memLog = readMemoryLog(dataDir)
  ev.assert('E1: memory 日志无「gave up」放弃标记（提炼成功路径，压缩保全未走降级）', !memLog.includes(GAVE_UP_MARK), {
    channel: 'C',
    expected: `不含「${GAVE_UP_MARK}」`,
    actual: memLog.includes(GAVE_UP_MARK) ? memLog.split('\n').filter((l) => l.includes(GAVE_UP_MARK)).slice(0, 3).join(' ⏎ ') : '干净',
  })
  ev.attach('memory-log-tail', memLog.slice(-4_000))

  // 压缩后状态复核已由 A4（第 5 条回合完成）承载——同步压缩发生在回合请求前，
  // 回合正常完成即「压缩完成且未取消」的行为证明。

  uncovered.push('V3 步骤⑤注入开/关的压缩触发点基线对比（需双实例对照装配，超出单剧本装配范围）')
  uncovered.push('V3 步骤④ split turn 批次（turnPrefixMessages）素材完整性专项（切点构造依赖 token 估算精度，本装配切点落在 turn 起点）')

  log(`done sid=${sid} compactions=${compactions.length} preserved=${preserved !== ''}`)
  return { uncovered, gotchas }
}
