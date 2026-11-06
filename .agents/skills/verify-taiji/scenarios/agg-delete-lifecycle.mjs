/**
 * agg-delete-lifecycle —— 运行中新建路由可见性与可路由性 + 删除路由行为链
 * （provider-aggregation 设计 §4.1 V15/V14，两段式：先 V15 再 V14）。
 *
 * 判据原文（设计文档 V 行摘录）：
 * - V15 运行中会话新建路由（D1 ③ 边界 / D4 时序差）：会话正绑定路由 A 对话中，新建路由 B
 *   并加入 scopedModels → 同一会话选择器出现 B（runtime 注入是磁盘即时派生）→ 选中 B 被
 *   pi 以 Model not found 拒绝 set_model，runtime 按路由条目分支映射为可操作提示
 *   「该模型路由在当前会话尚不可用（pi 在会话加载时注册路由），请新建会话后使用」（不落
 *   ENGINE_MODEL_MISSING 双因文案，不出现无指引的原始错误）→ 新会话可绑定 B 并正常路由
 *   （工厂期注册生效）→ 路由 A 的会话不受影响。
 * - V14 删除路由行为链（D1 ③ / D9 删除侧定形）：会话绑定路由 A 完成至少一轮成功对话
 *   （最后应答物理模型 P）→ 删除该路由并保存（同一保存从 scopedModels 移除该路由复合串；
 *   路由为默认模型时默认同步到新第一位）→ 同一会话再发消息（扩展 route 求值前 mtime 重读
 *   发现条目消失，保持注册并令 route 显式失败）→ 结构化错误「模型路由已删除」+ 恢复指引，
 *   不出现 pi 原始 is not registered 文本 → 模型选择器不再出现该条目、路由页无幽灵卡
 *   （scopedModels 孤儿引用已清理）、默认模型不指向已删路由 → 重开会话按 resume 语义绑定
 *   最后应答的物理模型 P 并正常出话，历史消息物理模型记录不变。
 *
 * 装配：mock-http（createInstance llm 通道）。路由 A 端点 [ag-a1(window 当前判窗外),
 * ag-a2(none)] → 绑定会话命中 ag-a2；路由 B 端点 [ag-b1(window 当前判窗外), ag-b2(none)]
 * → 新会话命中 ag-b2。命中判据 = instance.mockLlm.requests 尾部（status 200）model 裸 id
 * （mock-http README 坑 1）+ 会话 JSONL 助手消息物理模型记录（C 通道磁盘证据）。
 *
 * 错误映射文案断言（D1 ③/D9 文案对照）双通道：
 * - B 协议读：model.switch 失败 error envelope 的 code = AGGREGATION_ROUTE_NOT_IN_SESSION
 *   （session-model-control.ts:182-193 路由条目分支；≠ ENGINE_MODEL_MISSING 双因码）；
 * - A UI 读：点选择器条目 → toast 文本 = locale panel.ts modelSwitch.aggregationRouteNotInSession
 *   「该模型路由在当前会话尚不可用（pi 在会话加载时注册路由），请新建会话后使用」，不含
 *   engineModelMissing 双因文案「引擎未识别该模型」。code→key 映射单点 = renderer
 *   model-switch-toast.ts CODE_TO_KEY（composer-shell.ts:615-623 UI 路径与键盘循环共用）。
 *
 * V14 route 闭包失败的呈现链（源码依据）：扩展 route throw「模型路由 "X" 已删除，请在设置页
 * 重新创建或更换模型。」（extensions/universal/provider-aggregation/src/index.ts:251-252，
 * 求值前 mtime 重读 index.ts:214-230 只处理已注册 id、条目消失标 deletedIds 保持注册）→
 * pi Failed routing leaves the virtual model on its message（virtual-models.d.ts 契约，
 * assistant 消息 stopReason='error'）→ wire message.complete stopReason='error' +
 * errorMessage（event-adapter.ts extractAgentEndFields）→ C 通道 JSONL error 记录。
 *
 * resume 回落依据：pi getBranchSelection（dist/core/virtual-models.js:24-40 亲读）——
 * 「A virtual model that is no longer registered does not hold, so the selection falls
 * back to the physical model that answered last」；重开 = 新 pi 进程（路由 A 配置已删，
 * 工厂期零注册）→ 会话绑定回落物理模型 P。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const ROUTE_A = 'agg-del-main'
const ROUTE_B = 'agg-del-new'
const REF_A = `${AGG}/${ROUTE_A}`
const REF_B = `${AGG}/${ROUTE_B}`
const EP_A_FALLBACK = 'ag-a2' // 路由 A 兜底端点（最后应答物理模型 P）
const EP_B_FALLBACK = 'ag-b2' // 路由 B 兜底端点
/** D1 ③ 映射文案（locale panel.ts:728 aggregationRouteNotInSession 原文锚段）。 */
const TOAST_NOT_IN_SESSION = '该模型路由在当前会话尚不可用'
const TOAST_NOT_IN_SESSION_GUIDE = '请新建会话后使用'
/** ENGINE_MODEL_MISSING 双因文案锚段（panel.ts engineModelMissing）——判「不落双因」。 */
const DUAL_FACTOR_ANCHOR = '引擎未识别该模型'
/** V14 删除侧结构化错误锚段（provider-aggregation index.ts:252 throw 原文）。 */
const DELETED_ANCHOR = '已删除'
const DELETED_GUIDE = '重新创建或更换模型'
const PI_RAW_NOT_REGISTERED = 'is not registered'

// ── mock 演员：每端点独立 model（独立队列，游标 per-model 互不污染） ──────────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id，selectQueue 按裸段匹配；_note 被忽略',
  'mockllm/mock-1': [step('agg-dl-default-1'), step('agg-dl-default-2'), step('agg-dl-default-3')],
  'mockllm/ag-a1': [step('agg-dl-a1-should-never-hit')], // blocked-now 表下不应命中；命中即时间窗竞态破绽
  'mockllm/ag-a2': [
    step('agg-dl-a2-turn1'), step('agg-dl-a2-turn2'), step('agg-dl-a2-turn3'),
    step('agg-dl-a2-turn4'), step('agg-dl-a2-turn5'),
  ],
  'mockllm/ag-b1': [step('agg-dl-b1-should-never-hit')],
  'mockllm/ag-b2': [step('agg-dl-b2-turn1'), step('agg-dl-b2-turn2'), step('agg-dl-b2-turn3')],
}

export const meta = {
  id: 'agg-delete-lifecycle',
  priority: 'P0',
  title: '运行中新建路由可见性与可路由性（V15）+ 删除路由行为链（V14）：映射文案 / 无幽灵卡 / 默认不悬空 / resume 回落',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'model.list', 'model.switch', 'settings.provider',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: 'mock-1',
    subModel: 'mock-sub-a',
    models: ['mock-1', 'mock-sub-a', 'ag-a1', 'ag-a2', 'ag-b1', 'ag-b2'],
  },
  estimateSec: 420,
  provable: [
    '装配链 B+C：saveRoute A + setScopedModels([聚合串, mock-1]) → routes/scopedModels 落盘 + default 同步为聚合引用（settings.json，findValidDefaultModel 聚合分支 pass-through）',
    'V15 B+C：会话绑定路由 A 首轮命中兜底端点 ag-a2（JSONL 助手消息物理模型记录 = ag-a2，锚定 P）',
    'V15 B：运行中新建路由 B 保存 + 入白名单后 model.list 即时出现 agg-del-new（runtime 注入磁盘即时派生，条件轮询）',
    'V15 A：激活会话 A 打开模型选择器出现 agg-del-new 行（model-picker-item testid）',
    'V15 A+B：选中 B 失败双通道——UI toast 文本 =「该模型路由在当前会话尚不可用…请新建会话后使用」不含双因文案；协议 model.switch error envelope code=AGGREGATION_ROUTE_NOT_IN_SESSION（≠ ENGINE_MODEL_MISSING）',
    'V15 B+C：新建会话 modelOverride=B 绑定成功（工厂期注册）+ 发消息命中 ag-b2 正常路由',
    'V15 B+C：路由 A 会话不受影响——同会话再发一轮仍命中 ag-a2 且绑定保持聚合引用',
    'V14 B：deleteRoute 回执 scopedModels 精确清理（无 aggregation/agg-del-main，其余保留）',
    'V14 C：providers.json routes 段已删 agg-del-main + scopedModels 无孤儿引用',
    'V14 B+C：默认模型不悬空——删除前 default=已删路由（观察前提），删除后 default 同步到清理后新首位 mockllm/mock-1（settings.json 落盘）',
    'V14 B：选择器候选无已删条目——model.list 不含 agg-del-main（条件轮询）且 B 条目仍 在（无塌陷）；getRouteView 无该卡 + orphanRefs 无孤儿引用（无幽灵卡）',
    'V14 A：删除后重开选择器无 model-picker-item-agg-del-main 行、agg-del-new 行仍在',
    'V14 B+C：同会话再发消息两轮均结构化失败——wire stopReason=error + errorMessage 含「已删除…重新创建或更换模型」不含 is not registered；JSONL error 记录同文本；mock 请求计数不变（route 显式失败零出站）',
    'V14 B+C：重开会话 resume 回落——forceQuit+switch 后 getState.modelId = mockllm/ag-a2（最后应答物理模型，pi getBranchSelection 虚拟模型不注册不持有）',
    'V14 B+C：重开后发消息正常出话命中 ag-a2（物理直连）+ 历史助手消息物理模型序列前缀不变（C）',
  ],
  notProvable: [
    'V15/V14 判据的 toast 布局样式与转场动画（A 通道渲染细节）：本剧本读 toast 文本内容断言文案映射，样式归 UI 手工验收',
    'V14 判据「用户可随时在选择器换其他模型恢复」的完整更换模型恢复环：本剧本以 resume 回落物理模型出话覆盖恢复路径；更换模型恢复的切换语义已由 p0-model-switch 失败信号条目（会话不破坏）覆盖',
    'V14 步骤 2「默认是否同步到新第一位」的设置页 UI 呈现面：本剧本走协议回执 + settings.json 落盘（B/C）断言编排结果',
    'landing fallback 的 UI 默认选中显示：以 default 裁定源（settings.json + findValidDefaultModel 聚合分支）协议/落盘读为准',
  ],
}

// ── 时间窗表构造（30 分钟格；blocked 形态覆盖 current+next 两格防跨格竞态） ──────────
const todayRow = (now) => (now.getDay() + 6) % 7 // ISO 行：0=周一..6=周日
const currentSlot = (now) => Math.floor((now.getHours() * 60 + now.getMinutes()) / 30)

/** blocked-now 表：全 true，仅今日 current+next 两格 false（该端点当前判窗外）。 */
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
    'mock-http 游标 per-model（mock server 进程持有）：路由 A/B 端点各用独立模型（ag-a1/ag-a2、ag-b1/ag-b2），队列步数按轮次预置；V14 失败轮 route throw 零出站，不消耗队列步',
    'pi 发往 HTTP 的 model 是裸 id（mock-http README 坑 1）——mockLlm.requests[].model 断言用裸 id',
    '时间窗 30 分钟格跨格竞态：blocked 表覆盖今日 current+next 两格，剧本分钟级全程内判窗外不翻转；ag-a1/ag-b1 队列各留 1 步作破绽标记（命中即竞态破绽）',
    'session.getState 活会话分支读 replicated 快照（seed 竞态窗口 modelId 缺省）——绑定断言一律条件轮询（agg-time-window 同款）',
    'model.switch 失败 error envelope 经 protocol.call reject 为 ProtocolError，code 挂 e.code（lib/protocol.mjs onMessage error 分支）',
    'toast 条目 testid = toast-message-<运行时 id>，用前缀匹配取容器内首个条目文本；toast 瞬态，点击后立即 expectText（10s 窗口内轮询）',
    '删除编排会同步 default 到清理后 scopedModels 新首位（resolveDefaultSyncAfterScopedWrite）——本剧本 scoped 序刻意让清理后首位 = mockllm/mock-1（物理模型），默认不悬空断言落在物理模型上',
    'findValidDefaultModel 聚合分支（pi-provider-store.ts U3/D4 ④）经 aggregationRouteAvailability 判定路由默认可用性：路由在盘 pass-through 不改写、已删 fall-through fallback——删除后即使编排失败也会 fallback，双防线',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'))

  // ── 0. 前提：端点物理模型在 models.json（pi modelRegistry 物理段源，C） ──────────
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const needEndpoints = ['ag-a1', 'ag-a2', 'ag-b1', 'ag-b2']
  const endpointsReady = needEndpoints.every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——路由端点物理模型全部在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: needEndpoints.join(','),
    actual: `hits=${needEndpoints.filter((id) => endpointIds.includes(id)).length}/4 in=${endpointIds.join(',').slice(0, 200)}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady ? 0 : 1, stats: {} })

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

  async function setScoped(models, label) {
    const reply = await protocol.call('config.setScopedModels', { models }, { replyType: 'config.scopedModels', timeoutMs: 60_000 })
    ev.assert(`B: setScopedModels ${label} 回执`, JSON.stringify(reply?.scopedModels ?? []) === JSON.stringify(models), {
      channel: 'B',
      expected: JSON.stringify(models).slice(0, 200),
      actual: JSON.stringify(reply?.scopedModels ?? null).slice(0, 200),
    })
    return reply
  }

  async function readAssistantEntries(sessionFile, expectMinEntries, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    let entries = []
    for (;;) {
      try {
        const raw = fs.readFileSync(sessionFile, 'utf8')
        entries = []
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            const m = obj?.message ?? obj
            if (m?.role === 'assistant' && typeof m?.model === 'string') {
              entries.push({ model: m.model, provider: m.provider ?? null, stopReason: m.stopReason ?? null })
            }
          } catch {
            /* 非 JSON 行跳过 */
          }
        }
      } catch {
        /* 文件未 flush 完毕重试 */
      }
      if (entries.length >= expectMinEntries || Date.now() >= deadline) return entries
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

  function okRequests() {
    return instance.mockLlm.requests.filter((r) => r.status === 200)
  }

  /**
   * 发一条消息并断言本轮命中 expectBareModel（mockLlm.requests 尾部 model + turn 正常完成
   * + JSONL 助手消息物理模型记录）。
   */
  async function sendTurn(sid, text, expectBareModel, label, { sessionFile, expectAssistantCount } = {}) {
    const since = protocol.events.length
    await protocol.send(sid, text)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert(`B: ${label} turn 正常完成`, end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const tail = okRequests()[okRequests().length - 1] ?? null
    ev.assert(`C: ${label} 命中端点 = ${expectBareModel}（mockLlm.requests 尾部裸 id）`, tail?.model === expectBareModel, {
      channel: 'C',
      expected: `model=${expectBareModel}`,
      actual: `tail.model=${tail?.model ?? '<none>'} stepIndex=${tail?.stepIndex}`,
    })
    if (sessionFile && expectAssistantCount !== undefined) {
      const entries = await readAssistantEntries(sessionFile, expectAssistantCount)
      const okEntries = entries.filter((e) => e.stopReason !== 'error' && e.stopReason !== 'aborted')
      const last = okEntries[okEntries.length - 1]
      ev.assert(`C: ${label} 助手消息物理模型记录 = ${expectBareModel}（会话 JSONL）`, last?.model === expectBareModel, {
        channel: 'C',
        expected: `第 ${expectAssistantCount} 条成功助手消息 model=${expectBareModel}`,
        actual: `count=${entries.length} last=${JSON.stringify(last ?? null)}`,
      })
    }
    return { end, tail }
  }

  /** 期待该轮以错误终态结束并断言结构化「已删除」文案（不含 pi 原始 is not registered）。 */
  async function sendTurnExpectRouteDeleted(sid, text, label, { sessionFile } = {}) {
    const since = protocol.events.length
    const okCountBefore = okRequests().length
    await protocol.send(sid, text)
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
    const endedAsError = end.type !== 'message.complete' || end.payload?.stopReason === 'error'
    ev.assert(`B: ${label} 该轮以错误终态结束（路由已删 = route 显式失败）`, endedAsError, {
      channel: 'B',
      expected: 'message.complete stopReason=error（或 message.error / message.stream_error）',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'} ok=${end.ok}`,
    })
    const errText = String(end.payload?.errorMessage ?? end.payload?.message ?? '')
    ev.assert(`B: ${label} 结构化「模型路由已删除」+ 恢复指引`, errText.includes(DELETED_ANCHOR) && errText.includes(DELETED_GUIDE), {
      channel: 'B',
      expected: `errorMessage 含「${DELETED_ANCHOR}」与「${DELETED_GUIDE}」（D9 删除侧结构化文案）`,
      actual: `errorMessage=${errText.slice(0, 300)}`,
    })
    ev.assert(`B: ${label} 不出现 pi 原始 is not registered 文本`, !errText.includes(PI_RAW_NOT_REGISTERED), {
      channel: 'B',
      expected: `不含「${PI_RAW_NOT_REGISTERED}」（映射链吞掉 pi 原始错误）`,
      actual: `errorMessage=${errText.slice(0, 300)}`,
    })
    const okCountAfter = okRequests().length
    ev.assert(`C: ${label} route 显式失败零出站（mock 成功请求计数不变）`, okCountAfter === okCountBefore, {
      channel: 'C',
      expected: `成功请求数保持 ${okCountBefore}`,
      actual: `before=${okCountBefore} after=${okCountAfter}`,
    })
    if (sessionFile) {
      const entries = await readAssistantEntries(sessionFile, 1)
      const errEntry = [...entries].reverse().find((e) => e.stopReason === 'error')
      ev.assert(`C: ${label} JSONL error 记录（虚拟模型留在消息上 + 已删除文案）`, Boolean(errEntry) && errEntry?.provider === AGG, {
        channel: 'C',
        expected: "末条 error assistant entry provider=aggregation（Failed routing leaves the virtual model on its message）",
        actual: `entries=${entries.length} last=${JSON.stringify(entries[entries.length - 1] ?? null)}`,
      })
    }
    return { end, errText }
  }

  /** 条件轮询 getState 直到 modelId 等于期望绑定（快照 seed 竞态窗口防护）。 */
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

  async function createBoundSession(routeRef, label) {
    const created = await protocol.call(
      'session.create',
      { cwd: repo, label, modelOverride: routeRef },
      { timeoutMs: 120_000 },
    )
    const sid = created.session?.id
    await pollBoundModelId(sid, routeRef, `${label} 绑定路由（spawn --model 命中工厂期注册）`)
    await protocol.subscribe(sid)
    return sid
  }

  async function listAggIds(label) {
    const deadline = Date.now() + 15_000
    let aggIds = []
    for (;;) {
      const ml = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      aggIds = (ml.models ?? []).filter((m) => m.aggregation === true || m.providerId === AGG).map((m) => m.id)
      if (aggIds.includes(ROUTE_A) || aggIds.includes(ROUTE_B) || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
    ev.step({ step: `model.list.${label}`, channel: 'B', exitCode: 0, stats: { aggIds: aggIds.join(',') } })
    return aggIds
  }

  // ══ 1. 装配路由 A + scopedModels + default 同步 ══════════════════════════════
  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} row=${todayRow(now0)} slot=${currentSlot(now0)}`)
  const rA = routeOf(ROUTE_A, 'advanced', [member('a1', 'ag-a1', 'window', blockedNowTable(now0)), member('a2', 'ag-a2', 'none')])
  await saveRoute(rA, 'A v1（a1=blocked-now, a2=none）')
  const routesOnDisk1 = extras().routes?.routes ?? []
  ev.assert('C: 路由 A 落盘 providers.json routes 段（saveRoute 唯一写点）', routesOnDisk1.some((r) => r.id === ROUTE_A), {
    channel: 'C',
    expected: `routes 含 ${ROUTE_A}`,
    actual: `routeIds=${routesOnDisk1.map((r) => r.id).join(',')}`,
  })

  // scoped 序刻意构造：删除 A 后清理 = [mock-1, 聚合B] → default 同步到物理模型 mock-1
  await setScoped([REF_A, `${PROVIDER}/mock-1`], 'A 入白名单（首位 → default 同步为路由 A）')
  const settings1 = readSettings()
  ev.assert('C: default 同步为路由 A（settings.json；路由为默认模型的 V14 观察前提）', settings1.defaultProvider === AGG && settings1.defaultModel === ROUTE_A, {
    channel: 'C',
    expected: `defaultProvider=${AGG} defaultModel=${ROUTE_A}（syncDefaultToScopedModels 首位编排）`,
    actual: `default=${settings1.defaultProvider}/${settings1.defaultModel}`,
  })

  const aggIds1 = await listAggIds('after-route-a')
  ev.assert('B: model.list 出现聚合条目 agg-del-main（选择器候选 = 注入 × scopedModels 白名单）', aggIds1.includes(ROUTE_A), {
    channel: 'B',
    expected: `model.list 聚合条目含 ${ROUTE_A}`,
    actual: `aggIds=${aggIds1.join(',')}`,
  })

  // ══ 2. V15 步骤 1：会话绑定路由 A 并成功对话一轮（锚定 P） ════════════════════
  const S1_LABEL = 'agg-dl-v15-main'
  const sid1 = await createBoundSession(REF_A, S1_LABEL)
  const sessionFile1 = await sessionFileOf(sid1)
  ev.assert('C: 会话文件定位（config.sessions summary.sessionFile 非空）', Boolean(sessionFile1), {
    channel: 'C',
    expected: 'sessionFile 非空（首条消息 flush 前允许文件未创建）',
    actual: sessionFile1 || '<summary 未带 sessionFile>',
  })
  const v15turn1 = await sendTurn(sid1, 'V15 前置：路由 A 对话一轮，命中兜底 ag-a2', EP_A_FALLBACK, 'V15 前置轮', { sessionFile: sessionFile1, expectAssistantCount: 1 })
  ev.step({ step: 'v15.preset-turn', channel: 'C', exitCode: v15turn1.tail?.model === EP_A_FALLBACK ? 0 : 1, stats: { model: v15turn1.tail?.model } })

  // ══ 3. V15 步骤 2：运行中新建路由 B（双端点）并加入 scopedModels ══════════════
  const rB = routeOf(ROUTE_B, 'advanced', [member('b1', 'ag-b1', 'window', blockedNowTable(new Date())), member('b2', 'ag-b2', 'none')])
  await saveRoute(rB, 'B v1（b1=blocked-now, b2=none）——运行中新建')
  const routesOnDisk2 = extras().routes?.routes ?? []
  ev.assert('C: 路由 B 落盘（运行中新建路由的 routes 权威写入）', routesOnDisk2.some((r) => r.id === ROUTE_B), {
    channel: 'C',
    expected: `routes 含 ${ROUTE_B}`,
    actual: `routeIds=${routesOnDisk2.map((r) => r.id).join(',')}`,
  })
  await setScoped([REF_A, `${PROVIDER}/mock-1`, REF_B], 'B 入白名单（运行中）')

  // V15 步骤 3：同一会话选择器出现 B——B 通道（model.list 注入即时派生）
  const aggIds2 = await listAggIds('v15-new-route')
  ev.assert('B: V15 model.list 即时出现 agg-del-new（runtime 注入磁盘即时派生，条件轮询）', aggIds2.includes(ROUTE_B) && aggIds2.includes(ROUTE_A), {
    channel: 'B',
    expected: `聚合条目 = [${ROUTE_A}, ${ROUTE_B}]（新建 B 即时可见）`,
    actual: `aggIds=${aggIds2.join(',')}`,
  })

  // V15 步骤 3/4/5：A 通道——激活会话 A，打开选择器见 B，点击 B 失败出映射 toast
  // 默认项目区默认收起（useProjectGroups DEFAULT_GROUP_PERSIST.defaultZone=false，localStorage
  // 直存、新实例空集 = 全收起）：协议建会话的行在默认区里不渲染，先点默认区组头展开
  // （DefaultProjectHead 点行主体 = 父级按模式翻转开合——用户打开侧栏会话的真实路径）
  const ui = ctx.ui
  try {
    const zoneExpanded = await ui.attr('testid=default-project-anchor', 'aria-expanded')
    if (zoneExpanded !== 'true') await ui.click('testid=default-project-anchor')
    await ui.expectVisible(`css=.session-item[aria-label="${S1_LABEL}"]`, { timeoutMs: 20_000 })
    await ui.click(`css=.session-item[aria-label="${S1_LABEL}"]`)
    await ui.expectText('testid=panel-session-label', S1_LABEL, { timeoutMs: 20_000 })
    ev.assert('A: 激活路由 A 会话（panel-session-label）', true, { channel: 'A', expected: S1_LABEL, actual: S1_LABEL })

    await ui.click('css=[title="切换模型"]')
    await ui.expectVisible(`testid=model-picker-item-${ROUTE_B}`, { timeoutMs: 15_000 })
    const rowText = await ui.text(`testid=model-picker-item-${ROUTE_B}`)
    ev.assert('A: V15 同一会话选择器出现新建路由 B 行', Boolean(rowText), {
      channel: 'A',
      expected: `model-picker-item-${ROUTE_B} 可见（选择器 = model.list 候选）`,
      actual: String(rowText).slice(0, 200),
    })
    await ev.shot(await instance.page(), 'v15-picker-shows-new-route')

    await ui.click(`testid=model-picker-item-${ROUTE_B}`)
    const toastText = await ui.expectText('css=[data-testid^="toast-message-"]', TOAST_NOT_IN_SESSION, { timeoutMs: 10_000 })
    ev.assert('A: V15 选中 B 失败 toast 映射文案（D1 ③ 专用指引）', toastText.includes(TOAST_NOT_IN_SESSION) && toastText.includes(TOAST_NOT_IN_SESSION_GUIDE), {
      channel: 'A',
      expected: `toast 含「${TOAST_NOT_IN_SESSION}」+「${TOAST_NOT_IN_SESSION_GUIDE}」（panel.ts aggregationRouteNotInSession）`,
      actual: `toast=${toastText.slice(0, 300)}`,
    })
    ev.assert('A: V15 不落双因文案（engineModelMissing 锚段不存在）', !toastText.includes(DUAL_FACTOR_ANCHOR), {
      channel: 'A',
      expected: `toast 不含「${DUAL_FACTOR_ANCHOR}」（≠ ENGINE_MODEL_MISSING 双因文案）`,
      actual: `toast=${toastText.slice(0, 300)}`,
    })
    await ev.shot(await instance.page(), 'v15-switch-fail-toast')
    await ui.press('Escape')
    ev.step({ step: 'v15.ui-toast', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    ev.assert('A: V15 选择器 + toast 链（选择器出现 B / 点击失败 / 映射文案）', false, {
      channel: 'A',
      expected: '激活会话 → 选择器出现 B → 点击 → toast 映射文案',
      actual: String(e?.message ?? e).slice(0, 400),
    })
    ev.attach('v15-ui-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 20_000))
    try {
      await ev.shot(await instance.page(), 'v15-ui-fail')
    } catch {
      /* 页面不可用时放弃截图 */
    }
    ev.step({ step: 'v15.ui-toast', channel: 'A', exitCode: 1, stats: {} })
  }

  // V15 步骤 4/5：B 通道——协议 set_model 被拒，错误码 = 路由条目分支（≠ 双因码）
  let switchFailCode = ''
  let switchFailMsg = ''
  try {
    await protocol.call(
      'model.switch',
      { sessionId: sid1, provider: AGG, modelId: ROUTE_B },
      { replyType: 'model.switched', timeoutMs: 60_000 },
    )
    switchFailCode = '<未抛错：切换不应成功>'
  } catch (e) {
    switchFailCode = String(e?.code ?? '')
    switchFailMsg = String(e?.message ?? e)
  }
  ev.assert('B: V15 model.switch 失败 code=AGGREGATION_ROUTE_NOT_IN_SESSION（路由条目分支映射）', switchFailCode === 'AGGREGATION_ROUTE_NOT_IN_SESSION', {
    channel: 'B',
    expected: 'AGGREGATION_ROUTE_NOT_IN_SESSION（session-model-control.ts:182-193 路由条目分支）',
    actual: `code=${switchFailCode || '<none>'} msg=${switchFailMsg.slice(0, 200)}`,
  })
  ev.assert('B: V15 不落 ENGINE_MODEL_MISSING 双因码', switchFailCode !== 'ENGINE_MODEL_MISSING', {
    channel: 'B',
    expected: '≠ ENGINE_MODEL_MISSING（双因文案码）',
    actual: `code=${switchFailCode || '<none>'}`,
  })
  ev.step({ step: 'v15.switch-rejected', channel: 'B', exitCode: switchFailCode === 'AGGREGATION_ROUTE_NOT_IN_SESSION' ? 0 : 1, stats: { code: switchFailCode } })

  // V15 步骤 6/7：新会话绑定 B 正常路由（工厂期注册生效）
  const sid2 = await createBoundSession(REF_B, 'agg-dl-v15-new-session')
  const sessionFile2 = await sessionFileOf(sid2)
  await sendTurn(sid2, 'V15 新会话绑定路由 B：应正常路由命中兜底 ag-b2', EP_B_FALLBACK, 'V15 新会话轮', { sessionFile: sessionFile2, expectAssistantCount: 1 })

  // V15 步骤 8：路由 A 的会话不受影响
  await sendTurn(sid1, 'V15 收尾：路由 A 会话不受新建 B 影响，仍命中 ag-a2', EP_A_FALLBACK, 'V15 A 会话复验轮', { sessionFile: sessionFile1, expectAssistantCount: 2 })
  await pollBoundModelId(sid1, REF_A, 'V15 A 会话绑定保持聚合引用（不受影响）')
  ev.step({ step: 'v15.new-route-lifecycle', channel: 'B', exitCode: 0, stats: {} })

  // ══ 4. V14：删除路由 A 行为链 ════════════════════════════════════════════════
  // 步骤 1 前提：S1 已 ≥1 轮成功对话（V15 前置轮 + 复验轮 = 2 轮），P = mockllm/ag-a2
  const pEntries = await readAssistantEntries(sessionFile1, 2)
  const pOk = pEntries.filter((e) => e.stopReason !== 'error' && e.stopReason !== 'aborted')
  ev.assert('C: V14 前提——S1 成功对话 ≥1 轮，最后应答物理模型 P = ag-a2', pOk.length >= 2 && pOk[pOk.length - 1]?.model === EP_A_FALLBACK, {
    channel: 'C',
    expected: `成功助手消息 ≥2 且末条 model=${EP_A_FALLBACK}（P）`,
    actual: `entries=${JSON.stringify(pEntries).slice(0, 300)}`,
  })
  const historyBeforeDelete = pOk.map((e) => e.model)

  // 步骤 2：设置页删除该路由条目并保存（deleteRoute = routes 删除 + scopedModels 清理 + default 编排）
  const delReply = await protocol.call('aggregation.deleteRoute', { routeId: ROUTE_A }, { replyType: 'aggregation.routeDeleted', timeoutMs: 60_000 })
  const scopedAfterDel = delReply?.scopedModels ?? []
  ev.assert('B: V14 deleteRoute 回执 scopedModels 精确清理（无 A 引用，B 与 mock-1 保留）', !scopedAfterDel.includes(REF_A) && scopedAfterDel.includes(REF_B) && scopedAfterDel.includes(`${PROVIDER}/mock-1`), {
    channel: 'B',
    expected: `无 ${REF_A}；含 ${REF_B} 与 ${PROVIDER}/mock-1（按复合串精确过滤）`,
    actual: JSON.stringify(scopedAfterDel).slice(0, 200),
  })

  const extrasAfterDel = extras()
  const routesAfterDel = extrasAfterDel.routes?.routes ?? []
  ev.assert('C: V14 routes 段已删 agg-del-main（B 路由仍在）', !routesAfterDel.some((r) => r.id === ROUTE_A) && routesAfterDel.some((r) => r.id === ROUTE_B), {
    channel: 'C',
    expected: `routes 不含 ${ROUTE_A} 且含 ${ROUTE_B}`,
    actual: `routeIds=${routesAfterDel.map((r) => r.id).join(',')}`,
  })
  const scopedOnDiskAfterDel = extrasAfterDel.scopedModels ?? []
  ev.assert('C: V14 scopedModels 落盘无孤儿引用', !scopedOnDiskAfterDel.includes(REF_A), {
    channel: 'C',
    expected: `providers.json scopedModels 无 ${REF_A}`,
    actual: JSON.stringify(scopedOnDiskAfterDel).slice(0, 200),
  })

  // 步骤 4（默认模型不悬空）：删除前 default=路由 A（已断言），删除后同步到清理后新首位 mock-1
  const settingsAfterDel = readSettings()
  ev.assert('C: V14 默认模型不悬空——已从已删路由同步到清理后新首位 mockllm/mock-1', !(settingsAfterDel.defaultProvider === AGG && settingsAfterDel.defaultModel === ROUTE_A) && settingsAfterDel.defaultProvider === PROVIDER && settingsAfterDel.defaultModel === 'mock-1', {
    channel: 'C',
    expected: `default=${PROVIDER}/mock-1（resolveDefaultSyncAfterScopedWrite 新首位编排；绝不指向 ${REF_A}）`,
    actual: `default=${settingsAfterDel.defaultProvider}/${settingsAfterDel.defaultModel}`,
  })

  // 步骤 4（选择器无该条目 + 无幽灵卡）：model.list 条件轮询 + getRouteView 卡片集合
  let aggIdsAfterDel = []
  {
    const deadline = Date.now() + 15_000
    for (;;) {
      const ml = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      aggIdsAfterDel = (ml.models ?? []).filter((m) => m.aggregation === true || m.providerId === AGG).map((m) => m.id)
      if (!aggIdsAfterDel.includes(ROUTE_A) || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: V14 选择器候选无已删条目（agg-del-main 消失）且 B 路由仍在（无塌陷）', !aggIdsAfterDel.includes(ROUTE_A) && aggIdsAfterDel.includes(ROUTE_B), {
    channel: 'B',
    expected: `聚合条目 = [${ROUTE_B}]（已删 ${ROUTE_A} 消失）`,
    actual: `aggIds=${aggIdsAfterDel.join(',')}`,
  })
  const viewAfterDel = await protocol.call('aggregation.getRouteView', {}, { replyType: 'aggregation.routeView', timeoutMs: 60_000 })
  const cardIds = (viewAfterDel.cards ?? []).map((c) => c.route?.id)
  const orphanRefs = viewAfterDel.orphanRefs ?? []
  ev.assert('B: V14 路由页无幽灵卡（无 agg-del-main 卡）+ 孤儿引用已清理', !cardIds.includes(ROUTE_A) && cardIds.includes(ROUTE_B) && !orphanRefs.includes(REF_A), {
    channel: 'B',
    expected: `cards=[${ROUTE_B}] orphanRefs 无 ${REF_A}`,
    actual: `cards=${cardIds.join(',')} orphanRefs=${JSON.stringify(orphanRefs).slice(0, 200)}`,
  })

  // A 通道：删除后重开选择器无已删条目行（B 行仍在）
  try {
    await ui.click('css=[title="切换模型"]')
    await ui.expectVisible(`testid=model-picker-item-${ROUTE_B}`, { timeoutMs: 15_000 })
    await ui.expectGone(`testid=model-picker-item-${ROUTE_A}`, { timeoutMs: 3_000 })
    ev.assert('A: V14 重开选择器无已删路由行（agg-del-new 行仍在）', true, {
      channel: 'A',
      expected: `model-picker-item-${ROUTE_A} 不存在，model-picker-item-${ROUTE_B} 在列`,
      actual: '已删行不可见 + B 行可见',
    })
    await ev.shot(await instance.page(), 'v14-picker-no-deleted-route')
    await ui.press('Escape')
    ev.step({ step: 'v14.picker-gone', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    ev.assert('A: V14 重开选择器无已删路由行（agg-del-new 行仍在）', false, {
      channel: 'A',
      expected: `model-picker-item-${ROUTE_A} 不存在`,
      actual: String(e?.message ?? e).slice(0, 400),
    })
    ev.attach('v14-picker-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 20_000))
    ev.step({ step: 'v14.picker-gone', channel: 'A', exitCode: 1, stats: {} })
  }

  // 步骤 3：同一会话再发消息——结构化「已删除」错误（第 1 次）
  const fail1 = await sendTurnExpectRouteDeleted(sid1, 'V14 步骤 3：删除后再发消息，应显式失败', 'V14 失败轮 1', { sessionFile: sessionFile1 })
  ev.attach('v14-fail1-error', fail1.errText.slice(0, 500))
  ev.step({ step: 'v14.deleted-error-1', channel: 'B', exitCode: 0, stats: {} })

  // 步骤 5：再次发消息——同样失败形态（第 2 次）
  const fail2 = await sendTurnExpectRouteDeleted(sid1, 'V14 步骤 5：再次发消息，仍显式失败', 'V14 失败轮 2', { sessionFile: sessionFile1 })
  ev.attach('v14-fail2-error', fail2.errText.slice(0, 500))
  ev.step({ step: 'v14.deleted-error-2', channel: 'B', exitCode: 0, stats: {} })

  // 步骤 6：关闭并重开该会话（forceQuit 强杀 pi = 关闭会话；switch 重开 = 新 pi 进程）
  const { readRuntimeLogs } = await import('../scripts/lib/instance.mjs')
  const spawnCountBefore = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  const fq = await protocol.call('session.forceQuit', { sessionId: sid1 }, { timeoutMs: 60_000 })
  ev.assert('B: V14 forceQuit ack（关闭会话）', fq?.status === 'force_quit', {
    channel: 'B',
    expected: "message.status status='force_quit'",
    actual: JSON.stringify(fq ?? null).slice(0, 200),
  })
  const switched = await protocol.call('session.switch', { sessionId: sid1 }, { replyType: 'session.switched', timeoutMs: 120_000 })
  ev.assert('B: V14 重开会话（session.switch 回执）', switched?.sessionId === sid1, {
    channel: 'B',
    expected: `session.switched sessionId=${sid1}`,
    actual: `sessionId=${switched?.sessionId}`,
  })
  await protocol.subscribe(sid1)
  const spawnCountAfter = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  ev.assert('C: V14 pi 进程重开（runtime 日志 spawning pi 计数增加；新进程路由 A 零注册）', spawnCountAfter > spawnCountBefore, {
    channel: 'C',
    expected: `spawning pi 计数 > ${spawnCountBefore}`,
    actual: `after=${spawnCountAfter}`,
  })

  // 步骤 6/7 判据：resume 回落最后应答物理模型 P（pi getBranchSelection：虚拟模型不注册不持有）
  await pollBoundModelId(sid1, `${PROVIDER}/${EP_A_FALLBACK}`, 'V14 重开会话按 resume 语义回落物理模型 P（不再绑定路由）', { timeoutMs: 30_000 })

  // 步骤 7：重开后再发消息——物理模型直连正常出话
  const resumeTurn = await sendTurn(sid1, 'V14 重开后继续：物理模型直连应正常出话', EP_A_FALLBACK, 'V14 重开轮', { sessionFile: sessionFile1, expectAssistantCount: 5 })
  ev.assert(`B: V14 重开轮命中物理模型 P（mock 尾部 model=${EP_A_FALLBACK}）`, resumeTurn.tail?.model === EP_A_FALLBACK, {
    channel: 'B',
    expected: `model=${EP_A_FALLBACK}`,
    actual: `tail.model=${resumeTurn.tail?.model ?? '<none>'}`,
  })

  // 步骤 7 判据：历史消息物理模型记录不变（成功轮前缀 [ag-a2, ag-a2] 原样 + 新轮追加 ag-a2）
  const entriesFinal = await readAssistantEntries(sessionFile1, 5)
  const okFinal = entriesFinal.filter((e) => e.stopReason !== 'error' && e.stopReason !== 'aborted')
  const preserved = okFinal.length >= 3
    && JSON.stringify(okFinal.slice(0, historyBeforeDelete.length).map((e) => e.model)) === JSON.stringify(historyBeforeDelete)
    && okFinal[okFinal.length - 1]?.model === EP_A_FALLBACK
  ev.assert('C: V14 历史助手消息物理模型记录不变（删除前成功序列原样 + 重开轮追加物理模型）', preserved, {
    channel: 'C',
    expected: `成功序列前缀 ${JSON.stringify(historyBeforeDelete)} 原样 + 末条 ${EP_A_FALLBACK}（error 轮不入成功序列）`,
    actual: `okFinal=${JSON.stringify(okFinal.map((e) => `${e.provider}/${e.model}:${e.stopReason}`)).slice(0, 400)}`,
  })
  ev.attach('session-entries-final', JSON.stringify(entriesFinal, null, 2).slice(0, 6_000))
  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))
  ev.step({ step: 'v14.resume-fallback', channel: 'C', exitCode: preserved && resumeTurn.tail?.model === EP_A_FALLBACK ? 0 : 1, stats: { spawns: `${spawnCountBefore}->${spawnCountAfter}` } })

  log(`agg-delete-lifecycle done sid1=${sid1} sid2=${sid2} p=${PROVIDER}/${EP_A_FALLBACK} failCode=${switchFailCode}`)
  return { uncovered, gotchas }
}
