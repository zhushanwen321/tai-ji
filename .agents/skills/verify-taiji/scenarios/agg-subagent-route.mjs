/**
 * agg-subagent-route —— 子会话路由全链（provider-aggregation 设计 §4.1 V7，GL4 验收）。
 *
 * 判据原文（设计文档 V7 行）：
 *   「主会话派发 subagent / workflow 子任务，子任务模型选模型路由」：
 *   1. 完成双端点路由配置 → 2. 在 subagent / workflow 派发表单中模型选择模型路由 →
 *   3. 触发派发并观察子会话执行 → 4. 查看子会话助手消息记录。
 *   通过标准：子会话正常出话，物理模型记录为按条件命中的端点；主会话与子会话路由行为一致。
 *
 * 装配：mock-http（createInstance llm 通道；孙进程唯一零 token 通道——faux 在孙进程
 * 不可达，探针 faux-grandchild 结论 verified-unreachable）。路由端点 A/B 指向同一 mock
 * server 的不同 model。命中判据 = instance.mockLlm.requests 的裸 id model 字段
 *（mock-http README 坑 1）+ 主/子会话 JSONL 助手消息的物理模型记录（pi AssistantMessage
 * 记录实际路由物理模型，UD8，C 通道磁盘证据）。
 *
 * 派发通道：协议形态（主会话演员 toolCall 调 subagent_start，model 参数 = 聚合复合串
 * aggregation/<routeId>）——subagent_start 的 model 是 resolveModel 三层解析的第 1 级
 * override（subagent-tool-schema.ts:53-58），链路 = registry lookup（宿主 pi 工厂期注册的
 * 虚拟模型 + virtual-only provider 合成凭据放行 auth）→ assertModelWithinScoped 白名单
 * 断言（读 providers.json scopedModels，聚合复合串在列即放行）→ 孙进程 spawn
 * --model aggregation/<routeId> → 孙进程工厂期注册先于 --model 解析（AS12）→ 虚拟模型
 * route 求值 → 物理端点。派发受理成功本身 = 白名单断言通过的证明（拒绝会抛错不静默）。
 *
 * 路由构造（「按条件命中」的证明力）：members[0] = ep-a，type=window，blocked-now 表
 *（全 true 仅今日 current+next 格 false → 剧本分钟级全程恒判窗外）→ 条件落选；
 * members[1] = ep-b，type=none 兜底 → 恒命中。全程零 ep-a 请求 = 条件求值真实发生的
 * 铁证（命中是按条件选择，不是取第一个端点）。
 *
 * 共享游标纪律（mock-http README 坑 2 的本场景变体）：主会话绑定路由后每轮（含完成
 * 通知触发的 triggerTurn）与子会话全部经路由求值命中同一物理端点 ep-b → 共享 per-model
 * 队列且并发推进。处置：派发轮收尾之后的所有 ep-b 步做成同内容 canary 文本步——任意
 * 到达序下主收尾/子 canary/通知轮每步都干净收敛（文本 stop），断言不依赖步的归属。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const ROUTE_ID = 'agg-sub-main'
const ROUTE_REF = `${AGG}/${ROUTE_ID}`
const EP_A = 'ep-a'
const EP_B = 'ep-b'
// canary 不写进 task（task 只说「回声 canary」）：子会话产物出现 = 孙进程真的产出了
// mock 回复，排除「task 文本被记录误命中」的假阳性（探针 mock-llm-grandchild 同纪律）
const CANARY = 'AGG_SUB_ROUTE_CANARY_7e3a'

// ── mock 演员（model-keyed；游标 per-model） ─────────────────────────────────────
const step = (text) => ({ text, stopReason: 'stop' })
const canaryStep = () => ({ text: CANARY, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id；_note 被忽略。ep-b 派发轮收尾起全部同内容 canary（共享游标序无关收敛，见文件头）',
  'mockllm/mock-1': [step('agg-sub-spare-default')],
  // engineDefaults.pi（ensureLlm 写的孙进程缺省）的归因证据步：出现 mock-sub-a 请求 =
  // 派发 model override 未被孙进程命中（路由解析失败落缺省），主断言红时据此归因
  'mockllm/mock-sub-a': [canaryStep(), canaryStep()],
  // 首选端点：条件恒落选，队列存在只为「被消费即红」的可观测性
  'mockllm/ep-a': [step('ep-a-should-never-hit')],
  'mockllm/ep-b': [
    step('main-baseline-ok'),                                    // 主会话基线轮（路由出话）
    {                                                            // 派发轮：协议形态派发（model=聚合复合串）
      text: '派一个子任务去核对：',
      toolCalls: [
        {
          name: 'subagent_start',
          args: {
            task: 'Echo the canary word your scripted response contains, nothing else.',
            slug: 'agg-sub-route',
            model: ROUTE_REF,
            fork: false,
          },
        },
      ],
      stopReason: 'toolUse',
    },
    canaryStep(),                                                // 派发轮收尾（与下一竞态同内容）
    canaryStep(),                                                // 子会话 canary
    canaryStep(),                                                // 子会话备用轮
    canaryStep(),                                                // 完成通知 triggerTurn
    canaryStep(),                                                // 通知备用（README 坑 3）
    canaryStep(),                                                // 余量
  ],
}

export const meta = {
  id: 'agg-subagent-route',
  priority: 'P0',
  title: 'V7 子会话路由：subagent 派发模型选模型路由，孙进程经虚拟模型按条件命中端点，主/子行为一致',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'model.list', 'model.switch',
    'subagent.dispatch', 'subagent.list', 'subagent.model',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: 'mock-1',
    subModel: 'mock-sub-a',
    models: ['mock-1', 'mock-sub-a', 'ep-a', 'ep-b'],
  },
  estimateSec: 300,
  provable: [
    '装配链 B+C：aggregation.saveRoute 落盘 routes 段（advanced 双端点：A=window blocked-now，B=none 兜底）+ config.setScopedModels 白名单含聚合复合串（B 回执 + C 落盘）+ model.list 出现聚合条目（B）',
    '主会话路由基线：session.create modelOverride=aggregation/agg-sub-main spawn 命中工厂期注册（getState 绑定条件轮询）+ 基线轮命中兜底端点 ep-b（mockLlm.requests 尾部裸 id + 主会话 JSONL 助手物理模型记录）',
    'V7 派发受理：派发轮 subagent_start(model=aggregation/agg-sub-main) 经 resolveModel 三层解析 + scopedModels 白名单断言放行（拒绝会抛错不静默）→ record 出现且终态 done/idle',
    '子会话正常出话：子会话 JSONL 助手消息存在且文本非空（canary 出现在子会话产物）',
    '子会话物理模型记录 = 按条件命中的端点 ep-b：子会话 JSONL 助手消息 model=ep-b（UD8）+ 派发后 mockLlm.requests 新增 ep-b 请求（孙进程真的打到 mock 的铁证）',
    '条件求值真实性：全程 mockLlm.requests 零 ep-a 记录（首选端点恒窗外被条件落选——命中是按条件选择，不是取第一个端点）',
    '主/子路由行为一致：同一路由配置下主会话基线命中 ep-b 与子会话命中 ep-b 一致；派发后主会话绑定保持聚合引用（不因子会话改变）',
  ],
  notProvable: [
    'V7 判据步骤 2「在 subagent / workflow 派发表单中模型选择模型路由」的表单 UI 半边：本剧本派发走协议形态（subagent_start toolCall，技术路线允许协议或 UI 二选一）；派发表单模型下拉含聚合条目的 A 通道断言归 UI 剧本/手工验收',
    '「subagent / workflow 子任务」的 workflow fan-out 分支：本剧本覆盖 subagent 形态；workflow 成员经同一孙进程 spawn 链路（探针 mock-workflow-reachable 已证 mock-http 可达）但成员 structured-output 形态不在本剧本重复',
    '选择器聚合徽标、子会话面板的模型显示等渲染面（A 通道）——本剧本以 B/C 双通道证数据面',
    '真实模型智能语义（mock 演员只会吐剧本步，模型行为质量不可断言——mock-http 通道固有边界）',
  ],
}

// ── 时间窗表构造（30 分钟格；跨格竞态防护与 agg-time-window 同款） ────────────────
const todayRow = (now) => (now.getDay() + 6) % 7 // ISO 行：0=周一..6=周日
const currentSlot = (now) => Math.floor((now.getHours() * 60 + now.getMinutes()) / 30)

/** blocked-now 表：全 true，仅今日 current+next 两格 false（分钟级全程恒判窗外）。 */
function blockedNowTable(now) {
  const t = Array.from({ length: 7 }, () => Array(48).fill(true))
  const row = todayRow(now)
  const slot = currentSlot(now)
  t[row][slot] = false
  t[row][(slot + 1) % 48] = false
  return t
}

// ── 剧本 run ════════════════════════════════════════════════════════════════════
export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    '主会话与子会话经同一路由命中同一物理端点 ep-b → 共享 per-model 队列（mock-http README 坑 2 变体）：派发轮收尾起全部步做成同内容 canary 文本步，任意到达序下收敛，断言不依赖步归属',
    'pi 发往 HTTP 的 model 是裸 id（mock-http README 坑 1）——mockLlm.requests[].model 断言用裸 id',
    '孙进程 spawn + pi 启动是秒级（record 终态轮询给 120s 预算）；派发受理立即返回（subagent_start 恒 background），主轮不等子会话',
    'session.getState 活会话分支读 replicated 快照，与 session.create 回执间有竞态窗口——绑定断言用条件轮询',
    'engineDefaults.pi=mockllm/mock-sub-a（ensureLlm 写的孙进程缺省）：本剧本派发显式 model=聚合复合串，若出现 mock-sub-a 请求 = override 未被孙进程命中（路由解析失败落缺省）的归因证据',
    'pi 对不在 enabledModels 的模型引用是自动追加不是拒绝（pi agent-session.js:1934-1940）——聚合引用无需预置 enabledModels',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))

  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} row=${todayRow(now0)} slot=${currentSlot(now0)}`)

  // ── 0. 前提：端点物理模型在 models.json（pi modelRegistry 物理段源，C） ─────────
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const endpointsReady = [EP_A, EP_B].every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——路由端点物理模型在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: `${EP_A},${EP_B} 在 mockllm.models`,
    actual: `hits=${[EP_A, EP_B].filter((id) => endpointIds.includes(id)).length}/2 in=${endpointIds.join(',').slice(0, 200)}`,
  })
  const providerWired = modelsJson.providers?.[PROVIDER]?.baseUrl === instance.llm?.baseUrl
  ev.assert('C: 前提——mock provider 指向本机 mock 服务（孙进程经 PI_CODING_AGENT_DIR 读同一份 models.json）', providerWired, {
    channel: 'C',
    expected: `baseUrl=${instance.llm?.baseUrl ?? '<llm 拓扑缺>'}`,
    actual: `baseUrl=${modelsJson.providers?.[PROVIDER]?.baseUrl ?? '<缺>'}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady && providerWired ? 0 : 1, stats: {} })

  // ── 共用 helper ──────────────────────────────────────────────────────────────
  const member = (id, modelId, type, table) => ({ id, providerId: PROVIDER, modelId, type, ...(table ? { window: table } : {}) })
  const routeOf = (id, mode, members, specials = []) => ({ id, name: id, modelId: id, enabled: true, mode, members, specials })

  async function saveRoute(route, label) {
    const saved = await protocol.call('aggregation.saveRoute', { route }, { replyType: 'aggregation.routeSaved', timeoutMs: 60_000 })
    ev.assert(`B: aggregation.saveRoute ${label} 回执（routeSaved）`, saved?.route?.id === route.id, {
      channel: 'B',
      expected: `route.id=${route.id}`,
      actual: `reply.id=${saved?.route?.id} memberIssues=${(saved?.memberIssues ?? []).length}`,
    })
    return saved
  }

  /** 提取 assistant 消息文本（content 为 string 或 [{type:'text',text}] 数组）。 */
  function textOf(content) {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.filter((c) => c?.type === 'text' && typeof c?.text === 'string').map((c) => c.text).join('')
    }
    return ''
  }

  /** 从 JSONL 行提取 assistant 物理模型记录（兼容 {message:{...}} 与行级直排两种形态）。 */
  function assistantEntriesFromJsonl(raw) {
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        const m = obj?.message ?? obj
        if (m?.role === 'assistant') {
          const model = typeof m?.model === 'string' ? m.model : (typeof m?.model?.id === 'string' ? m.model.id : null)
          out.push({ model, text: textOf(m?.content) })
        }
      } catch {
        /* 非 JSON 行跳过 */
      }
    }
    return out
  }

  async function readAssistantModels(sessionFile, expectAtLeast, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    let entries = []
    for (;;) {
      try {
        entries = assistantEntriesFromJsonl(fs.readFileSync(sessionFile, 'utf8'))
      } catch {
        /* 文件未 flush 完毕重试 */
      }
      if (entries.length >= expectAtLeast || Date.now() >= deadline) return entries
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  async function sessionFileOf(sid) {
    const list = await protocol.call('config.sessions', {}, { timeoutMs: 60_000 })
    for (const g of list.groups ?? []) {
      for (const s of g.sessions ?? []) {
        if (s.id === sid) return s.sessionFile ?? ''
      }
    }
    return ''
  }

  function requestsOf(model, status) {
    return instance.mockLlm.requests.filter((r) => r.model === model && (status === undefined || r.status === status))
  }

  function tailRequest() {
    const ok = instance.mockLlm.requests.filter((r) => r.status === 200)
    return ok[ok.length - 1] ?? null
  }

  /** 条件轮询 getState 直到 modelId 等于期望绑定（replicated 快照 seed 竞态窗口）。 */
  async function pollBoundModelId(sid, expectedRef, label, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
      last = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
      if (last?.modelId === expectedRef) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert(`B: ${label}`, last?.modelId === expectedRef, {
      channel: 'B',
      expected: `getState.modelId=${expectedRef}`,
      actual: `sid=${sid} modelId=${last?.modelId ?? '<none>'}`,
    })
    return last?.modelId === expectedRef
  }

  /** 发一条消息并断言本轮命中 expectBareModel（mock 尾部裸 id + 可选 JSONL 助手记录）。 */
  async function sendTurn(sid, text, expectBareModel, label, { sessionFile, expectAssistantCount } = {}) {
    const since = protocol.events.length
    await protocol.send(sid, text)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert(`B: ${label} turn 正常完成`, end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const tail = tailRequest()
    ev.assert(`C: ${label} 命中端点 = ${expectBareModel}（mockLlm.requests 尾部裸 id）`, tail?.model === expectBareModel, {
      channel: 'C',
      expected: `model=${expectBareModel}`,
      actual: `tail.model=${tail?.model ?? '<none>'} stepIndex=${tail?.stepIndex}`,
    })
    if (sessionFile && expectAssistantCount !== undefined) {
      const entries = await readAssistantModels(sessionFile, expectAssistantCount)
      const last = entries[entries.length - 1]
      ev.assert(`C: ${label} 助手消息物理模型记录 = ${expectBareModel}（会话 JSONL）`, last?.model === expectBareModel, {
        channel: 'C',
        expected: `第 ${expectAssistantCount} 条助手消息 model=${expectBareModel}`,
        actual: `count=${entries.length} last=${JSON.stringify(last ?? null).slice(0, 300)}`,
      })
    }
    return { end, tail }
  }

  /** 递归收集目录树内全部 .jsonl 文件（体积上限保护）。 */
  function collectJsonlFiles(root, maxFiles = 200) {
    const files = []
    const walk = (dir, depth = 0) => {
      if (depth > 6 || files.length >= maxFiles) return
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (files.length >= maxFiles) return
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.name.endsWith('.jsonl')) files.push(full)
      }
    }
    if (fs.existsSync(root)) walk(root)
    return files
  }

  // ══ 1. 装配路由（V7 配置：A=window blocked-now 条件落选，B=none 兜底） ═════════
  const rWindow = blockedNowTable(now0)
  const route = routeOf(ROUTE_ID, 'advanced', [member('m-a', EP_A, 'window', rWindow), member('m-b', EP_B, 'none')])
  await saveRoute(route, 'R（A=blocked-now, B=none）')
  const routesOnDisk = extras().routes?.routes ?? []
  const rOnDisk = routesOnDisk.find((r) => r.id === ROUTE_ID)
  ev.assert('C: R 落盘 providers.json routes 段（saveRoute 唯一写点）且 A 窗今日当前格=false（A 判窗外）', Boolean(rOnDisk) && rOnDisk.members[0].window?.[todayRow(now0)]?.[currentSlot(now0)] === false, {
    channel: 'C',
    expected: `routes 含 ${ROUTE_ID} 且 A 窗今日当前格=false`,
    actual: `routeIds=${routesOnDisk.map((r) => r.id).join(',')} cell=${rOnDisk?.members?.[0]?.window?.[todayRow(now0)]?.[currentSlot(now0)]}`,
  })

  // scopedModels 白名单（读现状追加；setScopedModels 全量替换语义）
  let seedScoped = []
  try {
    seedScoped = extras().scopedModels ?? []
  } catch {
    /* extras 缺席——setScopedModels 以空基线起 */
  }
  const scoped1 = await protocol.call(
    'config.setScopedModels',
    { models: [...seedScoped, ROUTE_REF] },
    { replyType: 'config.scopedModels', timeoutMs: 60_000 },
  )
  ev.assert('B: setScopedModels 回执白名单含聚合复合串（派发表单可选 + 派发白名单断言的数据前提）', (scoped1?.scopedModels ?? []).includes(ROUTE_REF), {
    channel: 'B',
    expected: `${ROUTE_REF} 在回执 scopedModels`,
    actual: `scoped=${JSON.stringify(scoped1?.scopedModels ?? null).slice(0, 200)}`,
  })
  const scopedOnDisk = extras().scopedModels ?? []
  ev.assert('C: scopedModels 落盘含聚合复合串', scopedOnDisk.includes(ROUTE_REF), {
    channel: 'C',
    expected: `${ROUTE_REF} 在 providers.json scopedModels`,
    actual: JSON.stringify(scopedOnDisk).slice(0, 200),
  })

  // 选择器可见性：白名单加入后 model.list 应出现聚合条目（runtime 注入 × scoped 过滤联动）
  let aggListed = false
  let aggListActual = ''
  {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const mlNow = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      const aggEntries = (mlNow.models ?? []).filter((m) => m.aggregation === true || m.providerId === AGG)
      if (aggEntries.some((m) => m.id === ROUTE_ID)) {
        aggListed = true
        aggListActual = `ids=${aggEntries.map((m) => m.id).join(',')}`
        break
      }
      aggListActual = `agg=${aggEntries.length} all=${(mlNow.models ?? []).map((m) => `${m.providerId ?? m.provider}/${m.id}`).join(',').slice(0, 200)}`
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: model.list 出现聚合条目（选择器候选 = 注入 × scopedModels 白名单）', aggListed, {
    channel: 'B',
    expected: `model.list 含 providerId=${AGG} / id=${ROUTE_ID}`,
    actual: aggListActual,
  })
  ev.step({ step: 'setup.route', channel: 'B', exitCode: aggListed ? 0 : 1, stats: {} })

  // ══ 2. 主会话路由基线（主/子一致性的主会话半边） ══════════════════════════════
  const created = await protocol.call(
    'session.create',
    { cwd: repo, label: 'agg-sub-route-parent', modelOverride: ROUTE_REF },
    { timeoutMs: 120_000 },
  )
  const sid = created.session?.id
  await pollBoundModelId(sid, ROUTE_REF, '主会话绑定模型路由（spawn --model 命中工厂期注册）')
  await protocol.subscribe(sid)
  const sessionFile = await sessionFileOf(sid)
  ev.assert('C: 主会话文件定位（config.sessions summary.sessionFile 非空）', Boolean(sessionFile), {
    channel: 'C',
    expected: 'sessionFile 非空',
    actual: sessionFile || '<summary 未带 sessionFile>',
  })
  const baseline = await sendTurn(sid, '主会话基线轮：绑定模型路由，应按条件命中兜底端点 ep-b', EP_B, '主会话基线', { sessionFile, expectAssistantCount: 1 })
  ev.step({ step: 'parent.baseline', channel: 'C', exitCode: baseline.tail?.model === EP_B ? 0 : 1, stats: { model: baseline.tail?.model } })

  // ══ 3. V7 派发：subagent_start(model=聚合复合串) ══════════════════════════════
  const epBCountBeforeDispatch = requestsOf(EP_B).length
  const dispatch = await sendTurn(sid, 'V7 派发轮：派发子任务，模型选模型路由', EP_B, 'V7 派发轮', { sessionFile, expectAssistantCount: 2 })
  ev.step({ step: 'dispatch.submit', channel: 'B', exitCode: dispatch.end.ok ? 0 : 1, stats: { model: dispatch.tail?.model } })

  // 条件轮询 subagent record 到终态（孙进程 spawn + pi 启动秒级，给足预算）
  const deadline = Date.now() + 120_000
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === 'agg-sub-route') ?? records[0] ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ev.attach('subagents', JSON.stringify(records, null, 2).slice(0, 40_000))
  ev.step({
    step: 'subagent.observe',
    channel: 'B',
    exitCode: 0,
    stats: {
      count: records.length,
      status: record?.status,
      stopReason: record?.stopReason,
      outcome: record?.outcome,
      model: record?.model,
      error: String(record?.error ?? '').slice(0, 200),
    },
  })
  ev.assert('B: V7 派发受理——record 出现且终态 done/idle（model-resolver 白名单断言通过，拒绝会抛错不静默）', ['done', 'idle'].includes(String(record?.status)), {
    channel: 'B',
    expected: 'status ∈ {done, idle}',
    actual: `status=${record?.status} stopReason=${record?.stopReason} error=${String(record?.error ?? '').slice(0, 300)} result=${String(record?.result ?? '').slice(0, 200)}`,
  })

  // ══ 4. 子会话物理模型记录 = 按条件命中的端点（判据核心，C 通道） ═══════════════
  // 孙进程自己的 pi session JSONL 在 <dataDir>/ext-sessions/<sid>/subagents/ 树内；
  // 扫全树 assistant 记录（兼容嵌套形态），同时抓 canary 文本（正常出话证据）。
  const subRoot = path.join(dataDir, 'ext-sessions', String(sid), 'subagents')
  const subJsonlFiles = collectJsonlFiles(subRoot)
  const subEntries = []
  for (const f of subJsonlFiles) {
    try {
      for (const e of assistantEntriesFromJsonl(fs.readFileSync(f, 'utf8'))) subEntries.push({ file: path.relative(dataDir, f), ...e })
    } catch {
      /* 读取竞态跳过 */
    }
  }
  ev.attach('subagent-jsonl-entries', JSON.stringify(subEntries, null, 2).slice(0, 20_000))
  ev.attach('subagent-jsonl-files', subJsonlFiles.map((f) => path.relative(dataDir, f)).join('\n') || '(subagents 树无 .jsonl)')

  const subAssistant = subEntries.filter((e) => typeof e.model === 'string' && e.model.length > 0)
  ev.assert('C: 子会话正常出话——子会话 JSONL 助手消息存在且文本非空', subAssistant.some((e) => textOf(e.text).trim().length > 0), {
    channel: 'C',
    expected: '子会话 assistant 消息带非空文本',
    actual: `entries=${subEntries.length} withModel=${subAssistant.length} texts=${subAssistant.map((e) => String(e.text).slice(0, 60)).join('|').slice(0, 200)}`,
  })
  const subHit = subAssistant.filter((e) => e.model === EP_B)
  ev.assert(`C: V7 核心——子会话助手消息物理模型记录 = ${EP_B}（按条件命中的端点，UD8）`, subHit.length > 0, {
    channel: 'C',
    expected: `子会话 assistant model=${EP_B}`,
    actual: `models=${[...new Set(subAssistant.map((e) => e.model))].join(',') || '<无 model 记录>'} entries=${JSON.stringify(subAssistant.map((e) => ({ model: e.model, text: String(e.text).slice(0, 40) }))).slice(0, 400)}`,
  })

  // 子会话产物含 canary（孙进程真的产出 mock 回复；canary 不在 task 里，排除回声假阳性）
  let subTreeText = ''
  for (const f of subJsonlFiles) {
    try {
      subTreeText += fs.readFileSync(f, 'utf8')
    } catch {
      /* 忽略 */
    }
  }
  try {
    const recordsDir = path.join(subRoot, 'records')
    if (fs.existsSync(recordsDir)) {
      for (const f of fs.readdirSync(recordsDir)) subTreeText += `\n${fs.readFileSync(path.join(recordsDir, f), 'utf8')}`
    }
  } catch {
    /* records 目录缺席可容忍 */
  }
  ev.assert(`C: 子会话产物含 canary（${CANARY}）`, subTreeText.includes(CANARY), {
    channel: 'C',
    expected: CANARY,
    actual: `subTreeBytes=${subTreeText.length} hit=${subTreeText.includes(CANARY)}`,
  })

  // 铁证面：派发后 mock server 收到 ep-b 的新请求（孙进程打到 mock）
  const epBAfter = requestsOf(EP_B)
  ev.assert(`C: 派发后 mockLlm.requests 新增 ${EP_B} 请求（孙进程真的打到 mock）`, epBAfter.length > epBCountBeforeDispatch, {
    channel: 'C',
    expected: `ep-b 请求数 > ${epBCountBeforeDispatch}`,
    actual: `after=${epBAfter.length} all=${instance.mockLlm.requests.map((r) => `${r.model}:${r.status}`).join(',').slice(0, 300)}`,
  })

  // 条件求值真实性：全程零 ep-a 记录（含非 200——发往 ep-a 的任何请求都说明条件求值失效）
  const epAHits = requestsOf(EP_A)
  ev.assert('C: 条件求值真实性——全程零 ep-a 请求（首选端点恒窗外被条件落选）', epAHits.length === 0, {
    channel: 'C',
    expected: 'requests 无 model=ep-a 记录',
    actual: `epA=${epAHits.length} models=${[...new Set(instance.mockLlm.requests.map((r) => r.model))].join(',')}`,
  })

  // engineDefaults 漏斗证据：子会话未落缺省模型 mock-sub-a（override 被孙进程命中）
  const subDefaultHits = requestsOf('mock-sub-a')
  ev.assert('C: 派发 model override 生效——孙进程未落 engineDefaults 缺省模型 mock-sub-a', subDefaultHits.length === 0, {
    channel: 'C',
    expected: 'requests 无 model=mock-sub-a 记录',
    actual: `mock-sub-a=${subDefaultHits.length}`,
  })

  // ══ 5. 主/子路由行为一致 ══════════════════════════════════════════════════════
  const stateAfter = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
  ev.assert('B: 主/子一致——派发后主会话绑定保持聚合引用（不因子会话改变）', stateAfter?.modelId === ROUTE_REF, {
    channel: 'B',
    expected: `getState.modelId=${ROUTE_REF}`,
    actual: `modelId=${stateAfter?.modelId}`,
  })
  const parentEntries = sessionFile ? await readAssistantModels(sessionFile, 2) : []
  const parentHits = parentEntries.filter((e) => e.model === EP_B)
  const consistent = parentHits.length >= 2 && subHit.length > 0
  ev.assert(`C: 主/子路由行为一致——主会话两轮与子会话物理模型记录均为 ${EP_B}（同一路由配置同一求值语义）`, consistent, {
    channel: 'C',
    expected: `主 JSONL ≥2 条 model=${EP_B} 且子 JSONL ≥1 条 model=${EP_B}`,
    actual: `parent=${JSON.stringify(parentEntries.map((e) => e.model))} sub=${JSON.stringify(subAssistant.map((e) => e.model))}`,
  })
  ev.step({ step: 'v7.consistency', channel: 'C', exitCode: consistent ? 0 : 1, stats: { parent: parentEntries.map((e) => e.model).join(','), sub: subAssistant.map((e) => e.model).join(',') } })

  // ══ 6. 终态 C 核对 ════════════════════════════════════════════════════════════
  const finalExtras = extras()
  const finalRoutes = finalExtras.routes?.routes ?? []
  const fR = finalRoutes.find((r) => r.id === ROUTE_ID)
  const finalOk = fR?.mode === 'advanced'
    && fR?.members?.[0]?.modelId === EP_A
    && fR?.members?.[1]?.modelId === EP_B
    && (finalExtras.scopedModels ?? []).includes(ROUTE_REF)
  ev.assert('C: 终态 routes 段与 scopedModels 与装配终态一致', finalOk, {
    channel: 'C',
    expected: `routes 含 ${ROUTE_ID}（advanced, ep-a+ep-b）+ scopedModels 含 ${ROUTE_REF}`,
    actual: `routes=${finalRoutes.map((r) => r.id).join(',')} mode=${fR?.mode} members=${(fR?.members ?? []).map((m) => m.modelId).join(',')} scoped=${JSON.stringify(finalExtras.scopedModels ?? null).slice(0, 200)}`,
  })
  ev.attach('extras-final', JSON.stringify(finalExtras, null, 2).slice(0, 12_000))
  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))
  ev.step({ step: 'final-state', channel: 'C', exitCode: finalOk ? 0 : 1, stats: { routes: finalRoutes.length } })

  log(`agg-subagent-route done sid=${sid} record=${record?.status} parent=${parentEntries.map((e) => e.model).join(',')} sub=${subAssistant.map((e) => e.model).join(',')}`)
  return { uncovered, gotchas }
}
