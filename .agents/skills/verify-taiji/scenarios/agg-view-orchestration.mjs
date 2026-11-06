/**
 * agg-view-orchestration —— V9 路由卡顺序 = 模型选择器顺序（D10/D11 视图编排）+ V12 截断
 * 警告与「此刻」预览（D14），provider-aggregation 设计 §4.1（M1 交付面）。
 *
 * 判据原文（设计文档 V 行摘录）：
 * - V9：「1. 模型路由页把第二张卡上移到第一位 → 2. 保存 → 3. 打开 composer 模型选择器
 *   观察候选与顺序 → 4. ctrl+p 循环模型验证顺序；选择器候选 = scopedModels 白名单集合
 *  （经路由页卡片开关编辑）、顺序与卡片顺序一致（写回 scopedModels 数组序）；循环序一致；
 *   ScopedModelSection 白名单卡不再出现（UI 退役）；subagent 派发白名单行为与升级前一致」。
 * - V12：「1. 路由端点顺序 = [无条件 A, 时间窗 B] → 2. 查看时间轴警告与 B 端点标注 →
 *   3. 查看卡头『此刻』chip → 4. 对话验证实际命中；时间轴显示『第 1 个端点是无条件端点，
 *   排在它后面的时间窗不会命中』警告；B 端点标『不会命中』；卡头『此刻』显示 A；对话实际
 *   命中 A（与预览一致）」。
 *
 * 装配：mock-http（createInstance llm 通道）+ A 通道 UI 驱动（run.mjs 生命周期，ctx.ui）。
 * 路由初始装配走协议写侧（aggregation.saveRoute / config.setScopedModels，agg-time-window
 * 同款通道）；V9 的「上移卡 + 保存 + scoped 开关编辑」与 V12 的「展开卡查看」走真实 UI
 * 路径（RouteCard.vue / ModelRoutePage.vue / RouteUnsavedBar.vue 的 testid 以源码为准）。
 * 顺序断言双视角：路由页 DOM 卡序（route-card[data-route-id] ∪ route-direct-card[data-ref]
 * 文档序）+ composer 选择器 DOM 候选序（model-picker-list 内 model-picker-item-* 文档序，
 * 序源 = settingsStore.models = model.list = aggregateModelsWithScoped scopedModels 数组序）。
 *
 * 顺序派生链（源码锚点）：buildRoutePageCards 主轴 = scopedModels 数组序（route-orchestration.ts:123
 * 「卡片顺序 = 选择器顺序（V9）」）；ctrl+p 循环序源 = enabledModels（composer-shortcut-actions.ts:55
 * 注释明文「序 = scopedModels 显示序」，forward = idx+1 回绕）。setScopedModels 有 default
 * 同步编排（model-message-handler.ts:139/:158-176 scoped[0] → defaultModel）——剧本会话一律
 * 显式 modelOverride，不依赖 default 值。
 *
 * 白名单派发行为（V9 底层零变化回归的行为半边）：subagent-core 每派发现读
 * providers.json scopedModels（execution/assembly/scoped-models.ts:31-45），显式指定模型
 * 不在白名单 → subagent_start 被 toolResult isError 拒（shared/scoped-models.ts
 * assertModelWithinScoped「outside the scoped-models allowlist」）、worker 不 spawn。
 * 正向 = 显式指定白名单内成员（ep-w）派发成功出话；负向 = 显式指定白名单外（mock-sub-a）
 * 拒绝、零孙进程请求。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const MAIN = 'mock-1'

// V9 路由与端点 id（kebab-case，saveRoute id 规则）
const R9A = 'r9-alpha'
const R9B = 'r9-beta'
const R12 = 'r12-trunc'
const EP_R9A = 'ep-r9a'
const EP_R9B = 'ep-r9b'
const EP_W = 'ep-w'
const EP_VA = 'ep-va'
const EP_VB = 'ep-vb'
const SUB_DENY = 'mock-sub-a'

// ── mock 演员（model-keyed，游标 per-model 互不污染；pi 请求体 model 是裸 id） ─────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'mock-1 主队按消费序：负向派发轮(0-1) → 正向派发轮(2-3) → 完成通知备用(4-7)',
  'mockllm/mock-1': [
    { text: 'dispatch-deny', toolCalls: [{ name: 'subagent_start', args: { task: 'deny probe', slug: 'v9-deny', model: `mockllm/${SUB_DENY}`, fork: false } }], stopReason: 'toolUse' },
    step('AGG-VO-DENY-ROUND-DONE'),
    { text: 'dispatch-allow', toolCalls: [{ name: 'subagent_start', args: { task: 'Echo the canary word your scripted response contains, nothing else.', slug: 'v9-allow', model: `mockllm/${EP_W}`, fork: false } }], stopReason: 'toolUse' },
    step('AGG-VO-ALLOW-DISPATCHED'),
    step('parent-notify-1'), step('parent-notify-2'), step('parent-notify-3'), step('parent-notify-4'),
  ],
  'mockllm/ep-w': [step('AGG_VO_WHITELIST_CANARY_7f3a')],
  'mockllm/ep-r9a': [step('agg-vo-r9a-spare')],
  'mockllm/ep-r9b': [step('agg-vo-r9b-spare')],
  'mockllm/ep-va': [step('agg-vo-v12-hit-unconditional-a'), step('agg-vo-v12-hit-unconditional-a-2')],
  'mockllm/ep-vb': [step('agg-vo-v12-spare-b')],
  // mock-sub-a 无队列：白名单应拒绝它——若白名单失效产生请求，命中 404（无 200 = 拒绝面成立）
}

/** 期望的 scopedModels 基线（V9 装配后；UI 上移保存后的目标序由它翻转前两项推导）。 */
const scopedInitial = [`aggregation/${R9A}`, `aggregation/${R9B}`, `mockllm/${MAIN}`, `mockllm/${EP_W}`]
/** V9 步骤 1（第二张卡上移到第一位）保存后的期望数组序。 */
const scopedAfterMove = [`aggregation/${R9B}`, `aggregation/${R9A}`, `mockllm/${MAIN}`, `mockllm/${EP_W}`]

export const meta = {
  id: 'agg-view-orchestration',
  priority: 'P0',
  title: 'V9 路由卡顺序=选择器顺序（UI 上移→保存→候选序→ctrl+p 循环序→scoped 开关→白名单派发→ScopedModelSection 退役）+ V12 截断警告/不会命中/此刻 chip/对话命中',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'settings.provider', 'model.list', 'model.switch',
    'session.create', 'chat.send', 'chat.wait', 'subagent.dispatch',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: MAIN,
    subModel: SUB_DENY,
    models: [MAIN, SUB_DENY, 'mock-sub-b', EP_R9A, EP_R9B, EP_W, EP_VA, EP_VB],
  },
  estimateSec: 420,
  provable: [
    'V9 装配 B+C：saveRoute ×2 落盘 routes 段 + setScopedModels 白名单基线（C：providers.json scopedModels 精确数组）+ model.list 聚合条目在列',
    'V9 ① A：路由页 DOM 卡序 = scopedModels 序（route-card[data-route-id] ∪ route-direct-card[data-ref] 文档序：r9-alpha, r9-beta, mock-1 直连, ep-w 直连）',
    'V9 ①-② A：点第二张卡（r9-beta）route-move-up 后草稿 DOM 卡序立即翻转（route-orchestration.ts:123「卡片顺序 = 选择器顺序」的草稿半边）',
    'V9 ② C+B+A：unsaved-save 后 scopedModels 落盘 = [aggregation/r9-beta, aggregation/r9-alpha, mockllm/mock-1, mockllm/ep-w]（写回数组序）；model.list 条件轮询序跟随；路由页刷新后 DOM 卡序一致',
    'V9 ③ A：composer 模型选择器 DOM 候选序（model-picker-list 内行序）= 卡片顺序（含聚合组在前、直连条目在后）；选择器候选集合 = scopedModels 白名单集合',
    'V9 ④ A+B：ctrl+p 循环序 = scopedModels 数组序循环（从绑定 mock-1 起 forward 三步 = ep-w → r9-beta → r9-alpha；A 通道键盘驱动 + composer 触发器文本，B 通道 getState 权威读）',
    'V9 开关 A+B+C：路由页路由卡 route-scoped-toggle 关闭→保存 → scopedModels 移出该路由（C）+ model.list 不再含该条目（候选集合 = 白名单）+ 卡移 unscoped 段尾（A）；开回→保存 → 按当前卡序写回段尾 + 候选恢复；收尾上移复位恢复主链卡序',
    'V9 退役 A：供应商接入页 scoped-model-section / scoped-add-btn 零 DOM 且页面无「模型白名单」文案（ScopedModelSection UI 退役，D10）',
    'V9 白名单 B+C：显式指定白名单内成员（mockllm/ep-w）的 subagent_start 派发成功——mock.requests 出现 model=ep-w 的 200（孙进程真打 mock）+ record 终态 done/idle',
    'V9 白名单负向 B+C：显式指定白名单外模型（mockllm/mock-sub-a）被拒——零 mock-sub-a 200 请求（worker 未 spawn），主轮不炸',
    'V12 装配 B+C：saveRoute r12-trunc（advanced，members=[ep-va none, ep-vb window 今日窗]）落盘 + model.list 出现聚合条目',
    'V12 ② A：展开卡后 route-time-warning 文本 =「第 1 个端点是无条件端点，排在它后面的时间窗不会命中」+ 第二端点行 endpoint-never-hit 标「不会命中」（route-preview.ts truncationInfo/suppressedByEarlierUnconditional）',
    'V12 ③ A：卡头 route-card-now-chip 含「此刻」且显示端点 A 渠道名（evaluateRouteAt 恒命中 index 0 无条件端点）',
    'V12 ④ B+C：绑定路由会话对话实际命中 ep-va（mock.requests 尾部 + 会话 JSONL 助手消息物理模型）=「此刻」chip 预览一致',
    'C 终态：providers.json routes 段三条路由 + scopedModels 终态序与各阶段操作一致',
  ],
  notProvable: [
    '「与升级前一致」的双实例对拍：单实例（feat-provider-routing）内以行为契约本身为判据（白名单放行/拒绝两态 + 落盘字段形态），不构造 main 分支对照实例',
    '时间轴拖选涂抹交互本身（spec §7.7）：V12 判据只含警告条/B 标注/此刻 chip/命中四点，涂抹真机驱动不进本剧本（归手工验收/后续剧本）',
    'ctrl+shift+p backward 循环：V9 判据只点名 ctrl+p（forward），反向循环不验',
    'V12「对话验证实际命中」的跨时刻窗内/窗外翻转：r12-trunc 的 A 端点无条件恒命中，与墙钟无关（B 端点在 index 1 被截断）；时间窗语义翻转归 agg-time-window（V1/V2/V5）',
    'composer 触发器切换瞬间的中间态（LoaderCircle 转圈）：只断言终态文本与 getState 权威值，不断言瞬态渲染',
  ],
}

// ── 时间窗表构造（30 分钟格；V12 的 B 端点窗表，今日 current+next 两格 true） ───────────
const minutesNow = (now) => now.getHours() * 60 + now.getMinutes()
const todayRow = (now) => (now.getDay() + 6) % 7 // ISO 行：0=周一..6=周日
const currentSlot = (now) => Math.floor(minutesNow(now) / 30)
function availableNowTable(now) {
  const t = Array.from({ length: 7 }, () => Array(48).fill(false))
  const row = todayRow(now)
  const slot = currentSlot(now)
  t[row][slot] = true
  t[row][(slot + 1) % 48] = true
  return t
}

// ── 剧本 run ═════════════════════════════════════════════════════════════════════════
export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'config.setScopedModels 有 default 同步编排（model-message-handler.ts:139 scoped[0] → defaultModel）——剧本两个会话都显式 modelOverride，不依赖 default 值；default 被 V9 保存改写为聚合引用属产品正确行为（AS19 第一张卡=全局默认）',
    '路由页 unsaved-bar 是 v-show 显隐（RouteUnsavedBar.vue）——保存完成判定用「bar 不可见（offsetParent null）+ C 落盘轮询」双条件，禁 expectGone（detached 永不发生）',
    '绑定聚合条目的会话发消息会走路由命中端点、消耗端点演员队列（游标 per-model）——派发验证会话 sid9 显式绑定物理模型 mock-1，路由端点 ep-r9a/ep-r9b 与成员演员 ep-w 全部独立 id，互不串队',
    '白名单负向派发对象 mock-sub-a 无响应队列：若白名单失效产生请求将命中 404——断言「零 200 请求」在两种形态下都成立',
    '开关判据载体 = 路由卡（route-scoped-toggle）而非直连卡（route-direct-scoped-toggle）：直连卡关闭参与选择后整卡消失（buildRoutePageCards 直连卡来自 scopedModels 条目，无 routes 定义可挂），无法做「开回」操作；路由卡关闭后仍存在、移到 unscoped 段尾（route-orchestration.ts buildRoutePageCards 尾段）',
    '开关「开回」不是恢复原位：save() 的 scopedRefs 按 draft 卡片序输出（ModelRoutePage.vue save），关闭期间掉到段尾的卡开回后按当前卡序写回段尾——产品正确行为；剧本收尾用两次 route-move-up 把卡序复位后再进入选择器/循环断言，避免开关测试污染主链基线',
    'model.list 是 scopedModels 白名单过滤排序后的选择器候选（aggregateModelsWithScoped 数组序输出）——顺序断言的 B 通道真值即此',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))
  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} row=${todayRow(now0)} slot=${currentSlot(now0)}`)

  // ── 共用 helper ──────────────────────────────────────────────────────────────────
  const member = (id, modelId, type, table) => ({ id, providerId: PROVIDER, modelId, type, ...(table ? { window: table } : {}) })
  const routeOf = (id, mode, members) => ({ id, name: id, modelId: id, enabled: true, mode, members, specials: [] })

  async function saveRoute(route, label) {
    const saved = await protocol.call('aggregation.saveRoute', { route }, { replyType: 'aggregation.routeSaved', timeoutMs: 60_000 })
    ev.assert(`B: aggregation.saveRoute ${label} 回执`, saved?.route?.id === route.id, {
      channel: 'B',
      expected: `route.id=${route.id}`,
      actual: `reply.id=${saved?.route?.id} memberIssues=${(saved?.memberIssues ?? []).length}`,
    })
    return saved
  }

  async function setScoped(models, label) {
    const reply = await protocol.call('config.setScopedModels', { models }, { replyType: 'config.scopedModels', timeoutMs: 60_000 })
    ev.assert(`B: config.setScopedModels ${label} 回执`, JSON.stringify(reply?.scopedModels ?? []) === JSON.stringify(models), {
      channel: 'B',
      expected: JSON.stringify(models),
      actual: JSON.stringify(reply?.scopedModels ?? null),
    })
    return reply
  }

  /** C 落盘轮询：providers.json scopedModels 等于期望数组（路由页保存编排是异步 RPC 链）。 */
  async function pollScopedOnDisk(expected, label, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let actual = ''
    for (;;) {
      try {
        actual = JSON.stringify(extras().scopedModels ?? null)
      } catch {
        actual = '<extras 不可读>'
      }
      if (actual === JSON.stringify(expected)) return true
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 300))
    }
    ev.assert(`C: ${label}（providers.json scopedModels 落盘轮询）`, false, {
      channel: 'C',
      expected: JSON.stringify(expected),
      actual,
    })
    return false
  }

  function assertScopedOnDisk(expected, label) {
    let actual = ''
    try {
      actual = JSON.stringify(extras().scopedModels ?? null)
    } catch {
      actual = '<extras 不可读>'
    }
    const ok = actual === JSON.stringify(expected)
    ev.assert(`C: ${label}`, ok, { channel: 'C', expected: JSON.stringify(expected), actual })
    return ok
  }

  /** B 轮询：model.list 满足谓词（config.providers 广播有防抖，立即读会拿旧值）。 */
  async function pollModelList(predicate, label, { timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastDesc = ''
    for (;;) {
      const ml = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      const models = ml.models ?? []
      if (predicate(models)) return { ok: true, models }
      lastDesc = models.map((m) => `${m.providerId ?? m.provider}/${m.id}`).join(',')
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
    ev.assert(`B: ${label}`, false, { channel: 'B', expected: '条件满足', actual: `last=${lastDesc.slice(0, 400)}` })
    return { ok: false, models: [] }
  }

  /** A 通道：路由页 DOM 卡序（route-card[data-route-id] ∪ route-direct-card[data-ref] 文档序）。 */
  async function readCardOrder(page) {
    return page.$$eval('[data-testid="route-card"], [data-testid="route-direct-card"]', (nodes) =>
      nodes.map((n) => {
        const tid = n.getAttribute('data-testid')
        return tid === 'route-card' ? `route:${n.getAttribute('data-route-id')}` : `direct:${n.getAttribute('data-ref')}`
      }),
    )
  }

  /** A 通道：composer 选择器 DOM 候选序（model-picker-list 容器内行序，剥 item 前缀）。 */
  async function readPickerOrder(page) {
    return page.$$eval('[data-testid="model-picker-list"] [data-testid^="model-picker-item-"]', (nodes) =>
      nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace('model-picker-item-', '')),
    )
  }

  /** 保存编排完成双判定：unsaved-bar 不可见（v-show hidden）+ scopedModels 落盘为目标序。 */
  async function waitSaveDone(page, expectedScoped, label) {
    let barGone = false
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="route-unsaved-bar"]')
        return !el || el.offsetParent === null
      }, { timeout: 25_000 })
      barGone = true
    } catch {
      /* 超时由落盘轮询的断言承载 */
    }
    const onDisk = await pollScopedOnDisk(expectedScoped, `${label} 写回数组序`, { timeoutMs: 20_000 })
    ev.assert(`A: ${label} 未保存条已消失（dirty=false，v-show hidden）`, barGone, {
      channel: 'A',
      expected: 'route-unsaved-bar 不可见',
      actual: barGone ? '已隐藏' : '25s 仍可见（保存编排未完成或 dirty 未复位）',
    })
    return { barGone, onDisk }
  }

  /** B 轮询：session.getState 的 modelId 等于期望绑定（活会话快照 seed 竞态，条件轮询）。 */
  async function pollStateModel(sid, expectedRef, label, { timeoutMs = 20_000 } = {}) {
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
      actual: `modelId=${last?.modelId ?? '<none>'}`,
    })
    return last?.modelId === expectedRef
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

  function tailOkRequest() {
    const ok = instance.mockLlm.requests.filter((r) => r.status === 200)
    return ok[ok.length - 1] ?? null
  }

  const openRoutePage = async (ui) => {
    await ui.click('testid=sidebar-settings')
    await ui.expectVisible('testid=settings-nav-model-route', { timeoutMs: 20_000 })
    await ui.click('testid=settings-nav-model-route')
    await ui.expectVisible('testid=model-route-page', { timeoutMs: 30_000 })
  }

  // ══ 0. 前提：端点物理模型全部在 models.json（pi modelRegistry 物理段源） ═════════════
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const needEndpoints = [MAIN, SUB_DENY, EP_R9A, EP_R9B, EP_W, EP_VA, EP_VB]
  const endpointsReady = needEndpoints.every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——全部演员模型在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: needEndpoints.join(','),
    actual: `in=${endpointIds.join(',').slice(0, 200)}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady ? 0 : 1, stats: {} })

  // ══ 1. V9 装配：两条路由 + scopedModels 白名单基线（协议写侧） ══════════════════════
  await saveRoute(routeOf(R9A, 'simple', [member('m-a', EP_R9A, 'none')]), `R9A ${R9A}`)
  await saveRoute(routeOf(R9B, 'simple', [member('m-b', EP_R9B, 'none')]), `R9B ${R9B}`)
  await setScoped(scopedInitial, '白名单基线')
  assertScopedOnDisk(scopedInitial, 'V9 装配 scopedModels 落盘基线')
  const listedSetup = await pollModelList(
    (models) => models.some((m) => m.aggregation === true && m.id === R9A) && models.some((m) => m.aggregation === true && m.id === R9B),
    'model.list 聚合条目 r9-alpha/r9-beta 在列',
  )
  ev.attach('model-list-after-setup', JSON.stringify(listedSetup.models.map((m) => ({ p: m.providerId, id: m.id, agg: m.aggregation === true })), null, 2).slice(0, 6_000))
  ev.step({ step: 'v9.setup', channel: 'B', exitCode: listedSetup.ok ? 0 : 1, stats: {} })

  // ══ 2. V9 ① 打开路由页：DOM 卡序 = scopedModels 序（上移前基线） ═══════════════════
  const ui = ctx.ui
  const page = await instance.page()
  await openRoutePage(ui)
  const expectedCardOrderBefore = [`route:${R9A}`, `route:${R9B}`, `direct:mockllm/${MAIN}`, `direct:mockllm/${EP_W}`]
  let cardOrderBefore = []
  try {
    await page.waitForFunction(
      (expected) => {
        const nodes = [...document.querySelectorAll('[data-testid="route-card"], [data-testid="route-direct-card"]')]
        const cur = nodes.map((n) => {
          const tid = n.getAttribute('data-testid')
          return tid === 'route-card' ? `route:${n.getAttribute('data-route-id')}` : `direct:${n.getAttribute('data-ref')}`
        })
        return JSON.stringify(cur) === JSON.stringify(expected)
      },
      expectedCardOrderBefore,
      { timeout: 20_000 },
    )
    cardOrderBefore = await readCardOrder(page)
  } catch {
    cardOrderBefore = await readCardOrder(page)
  }
  ev.assert('A: V9 ① 路由页 DOM 卡序 = scopedModels 序（上移前：r9-alpha, r9-beta, mock-1, ep-w）', JSON.stringify(cardOrderBefore) === JSON.stringify(expectedCardOrderBefore), {
    channel: 'A',
    expected: JSON.stringify(expectedCardOrderBefore),
    actual: JSON.stringify(cardOrderBefore),
  })
  await ev.shot(page, 'v9-cards-before-move')
  ev.step({ step: 'v9.page-order-before', channel: 'A', exitCode: JSON.stringify(cardOrderBefore) === JSON.stringify(expectedCardOrderBefore) ? 0 : 1, stats: {} })

  // ══ 3. V9 ① UI 上移：点第二张卡（r9-beta）的 route-move-up → 草稿卡序立即翻转 ═════
  await ui.click(`css=[data-testid="route-card"][data-route-id="${R9B}"] [data-testid="route-move-up"]`)
  const expectedCardOrderDraft = [`route:${R9B}`, `route:${R9A}`, `direct:mockllm/${MAIN}`, `direct:mockllm/${EP_W}`]
  const cardOrderDraft = await readCardOrder(page)
  ev.assert('A: V9 ① 上移后草稿 DOM 卡序翻转（r9-beta 到第一位）', JSON.stringify(cardOrderDraft) === JSON.stringify(expectedCardOrderDraft), {
    channel: 'A',
    expected: JSON.stringify(expectedCardOrderDraft),
    actual: JSON.stringify(cardOrderDraft),
  })
  ev.step({ step: 'v9.move-up', channel: 'A', exitCode: JSON.stringify(cardOrderDraft) === JSON.stringify(expectedCardOrderDraft) ? 0 : 1, stats: {} })

  // ══ 4. V9 ② UI 保存：scopedModels 写回数组序 + model.list 跟随 + 页面刷新一致 ═════
  await ui.click('testid=unsaved-save')
  const saveDone = await waitSaveDone(page, scopedAfterMove, 'V9 ② 保存')
  const scopedAfterMoveOnDisk = assertScopedOnDisk(scopedAfterMove, 'V9 ② scopedModels 落盘 = 卡片顺序（写回数组序）')
  const listAfterMove = await pollModelList((models) => {
    const refs = models.map((m) => `${m.providerId}/${m.id}`)
    return JSON.stringify(refs) === JSON.stringify(scopedAfterMove)
  }, 'model.list 序 = 保存后白名单序')
  ev.assert('B: V9 ② model.list 条目序 = scopedModels 数组序（聚合在前、直连在后）', listAfterMove.ok, {
    channel: 'B',
    expected: JSON.stringify(scopedAfterMove),
    actual: JSON.stringify(listAfterMove.models.map((m) => `${m.providerId}/${m.id}`)),
  })
  // 保存编排成功后外层刷新视图（useRoutePageOrchestration 重新拉 getRouteView）→ 草稿重置为视图态
  let cardOrderAfter = []
  try {
    await page.waitForFunction(
      (expected) => {
        const nodes = [...document.querySelectorAll('[data-testid="route-card"], [data-testid="route-direct-card"]')]
        const cur = nodes.map((n) => {
          const tid = n.getAttribute('data-testid')
          return tid === 'route-card' ? `route:${n.getAttribute('data-route-id')}` : `direct:${n.getAttribute('data-ref')}`
        })
        return JSON.stringify(cur) === JSON.stringify(expected)
      },
      expectedCardOrderDraft,
      { timeout: 20_000 },
    )
    cardOrderAfter = await readCardOrder(page)
  } catch {
    cardOrderAfter = await readCardOrder(page)
  }
  ev.assert('A: V9 ② 保存刷新后路由页 DOM 卡序 = r9-beta, r9-alpha, mock-1, ep-w', JSON.stringify(cardOrderAfter) === JSON.stringify(expectedCardOrderDraft), {
    channel: 'A',
    expected: JSON.stringify(expectedCardOrderDraft),
    actual: JSON.stringify(cardOrderAfter),
  })
  await ev.shot(page, 'v9-cards-after-save')
  ev.step({ step: 'v9.save', channel: 'C', exitCode: saveDone.onDisk && scopedAfterMoveOnDisk && listAfterMove.ok ? 0 : 1, stats: {} })

  // ══ 5. V9 退役断言：供应商接入页 ScopedModelSection 零 DOM（D10 UI 退役） ═════════
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('css=[data-testid="settings-nav-provider"].active', { timeoutMs: 20_000 })
  let providerPageText = ''
  let retiredOk = false
  try {
    await page.waitForFunction(() => {
      const nav = document.querySelector('[data-testid="settings-nav-provider"]')
      if (!nav || !nav.classList.contains('active')) return false
      // 分区首访才挂载（SettingsModal visitedViews）：等 provider 分区进入激活视图且出现路由入口卡
      return Boolean(document.querySelector('[data-testid="route-open-providers"], [data-testid="provider-page"], [data-testid="provider-template-picker"]'))
    }, { timeout: 20_000 })
    const scopedSection = await page.$$eval('[data-testid="scoped-model-section"], [data-testid="scoped-add-btn"]', (nodes) => nodes.length)
    // 只读激活分区文本（.sec-fade.on）：设置分区是 v-show 常挂载，全局 innerText 会串入
    // 模型路由页的条件渲染文案（orphanNotice/deleteConfirm 含「模型白名单」字样，属路由页
    // 语义非供应商页白名单卡复活）
    providerPageText = await page.evaluate(() => document.querySelector('.sec-fade.on')?.innerText ?? '<激活分区未找到>')
    retiredOk = scopedSection === 0 && !providerPageText.includes('模型白名单')
    ev.assert('A: V9 供应商接入页 scoped-model-section / scoped-add-btn 零 DOM 且无「模型白名单」文案（ScopedModelSection UI 退役）', retiredOk, {
      channel: 'A',
      expected: 'scoped-model-section=0 scoped-add-btn=0 激活分区无「模型白名单」文本',
      actual: `scopedNodes=${scopedSection} textHit=${providerPageText.includes('模型白名单')}`,
    })
    await ev.shot(page, 'v9-provider-page-retired')
  } catch (e) {
    ev.assert('A: V9 供应商接入页可打开（退役断言前置）', false, {
      channel: 'A',
      expected: 'provider 分区激活并渲染',
      actual: String(e?.message ?? e).slice(0, 300),
    })
  }
  ev.step({ step: 'v9.scoped-retired', channel: 'A', exitCode: retiredOk ? 0 : 1, stats: {} })

  // 回到路由页做开关编辑（避免关闭设置页再重开）
  await ui.click('testid=settings-nav-model-route')
  await ui.expectVisible('testid=model-route-page', { timeoutMs: 30_000 })

  // ══ 6. V9 开关判据：路由页卡片开关编辑 scopedModels（候选集合 = 白名单集合） ═══════
  // 开关载体 = 路由卡 r9-alpha 的 route-scoped-toggle（路由卡关闭后仍存在——移到 unscoped
  // 段尾，buildRoutePageCards「未参与路由卡跟在 scoped 段之后」；直连卡关闭即整卡消失，
  // 不能做开回载体）。关闭 → 保存 → 白名单移出 + 候选跟随 + 卡移段尾；开回 → 保存 → 恢复。
  const r9aToggleSel = `css=[data-testid="route-card"][data-route-id="${R9A}"] [data-testid="route-scoped-toggle"]`
  await ui.click(r9aToggleSel)
  await ui.click('testid=unsaved-save')
  const scopedAfterToggleOff = [`aggregation/${R9B}`, `mockllm/${MAIN}`, `mockllm/${EP_W}`]
  const toggleOffSave = await waitSaveDone(page, scopedAfterToggleOff, 'V9 开关-关闭保存')
  assertScopedOnDisk(scopedAfterToggleOff, 'V9 开关-关闭后 scopedModels 移出 r9-alpha')
  const listAfterOff = await pollModelList(
    (models) => models.every((m) => m.id !== R9A) && models.some((m) => m.id === R9B),
    'model.list 不再含 r9-alpha（候选集合随白名单开关）',
  )
  // 关闭后的卡集合语义：r9-alpha 卡仍在（routes 定义在）但移到 unscoped 段尾
  const expectedOrderToggleOff = [`route:${R9B}`, `direct:mockllm/${MAIN}`, `direct:mockllm/${EP_W}`, `route:${R9A}`]
  let cardOrderToggleOff = []
  try {
    await page.waitForFunction(
      (expected) => {
        const nodes = [...document.querySelectorAll('[data-testid="route-card"], [data-testid="route-direct-card"]')]
        const cur = nodes.map((n) => {
          const tid = n.getAttribute('data-testid')
          return tid === 'route-card' ? `route:${n.getAttribute('data-route-id')}` : `direct:${n.getAttribute('data-ref')}`
        })
        return JSON.stringify(cur) === JSON.stringify(expected)
      },
      expectedOrderToggleOff,
      { timeout: 20_000 },
    )
    cardOrderToggleOff = await readCardOrder(page)
  } catch {
    cardOrderToggleOff = await readCardOrder(page)
  }
  ev.assert('A: V9 开关-关闭后 r9-alpha 卡移到 unscoped 段尾（D10 卡集合 = scopedModels ∪ routes）', JSON.stringify(cardOrderToggleOff) === JSON.stringify(expectedOrderToggleOff), {
    channel: 'A',
    expected: JSON.stringify(expectedOrderToggleOff),
    actual: JSON.stringify(cardOrderToggleOff),
  })
  ev.step({ step: 'v9.scoped-off', channel: 'C', exitCode: toggleOffSave.onDisk && listAfterOff.ok ? 0 : 1, stats: {} })
  // 开回：写回语义 = scoped 卡按当前卡片序（r9-alpha 关闭期间掉到段尾，开回即在段尾——
  // 产品正确行为，非「恢复原位」）。开回保存的期望序按此登记。
  const scopedAfterToggleOn = [`aggregation/${R9B}`, `mockllm/${MAIN}`, `mockllm/${EP_W}`, `aggregation/${R9A}`]
  await ui.click(r9aToggleSel)
  await ui.click('testid=unsaved-save')
  const toggleOnSave = await waitSaveDone(page, scopedAfterToggleOn, 'V9 开关-恢复保存')
  assertScopedOnDisk(scopedAfterToggleOn, 'V9 开关-开回后 scopedModels（按当前卡序落在段尾）')
  await pollModelList((models) => models.some((m) => m.id === R9A), 'model.list 恢复含 r9-alpha')
  ev.step({ step: 'v9.scoped-on', channel: 'C', exitCode: toggleOnSave.onDisk ? 0 : 1, stats: {} })
  // 开关测试收尾：把 r9-alpha 上移两次回 idx=1，恢复 V9 主链卡序（后续选择器/循环断言基线）
  await ui.click(`css=[data-testid="route-card"][data-route-id="${R9A}"] [data-testid="route-move-up"]`)
  await ui.click(`css=[data-testid="route-card"][data-route-id="${R9A}"] [data-testid="route-move-up"]`)
  await ui.click('testid=unsaved-save')
  const restoreSave = await waitSaveDone(page, scopedAfterMove, 'V9 开关收尾-上移复位保存')
  assertScopedOnDisk(scopedAfterMove, 'V9 开关收尾-卡序复原（scopedModels 回基线序）')
  let cardOrderRestore = []
  try {
    await page.waitForFunction(
      (expected) => {
        const nodes = [...document.querySelectorAll('[data-testid="route-card"], [data-testid="route-direct-card"]')]
        const cur = nodes.map((n) => {
          const tid = n.getAttribute('data-testid')
          return tid === 'route-card' ? `route:${n.getAttribute('data-route-id')}` : `direct:${n.getAttribute('data-ref')}`
        })
        return JSON.stringify(cur) === JSON.stringify(expected)
      },
      expectedCardOrderDraft,
      { timeout: 20_000 },
    )
    cardOrderRestore = await readCardOrder(page)
  } catch {
    cardOrderRestore = await readCardOrder(page)
  }
  ev.assert('A: V9 开关收尾-路由页卡序复原（r9-beta, r9-alpha, mock-1, ep-w）', JSON.stringify(cardOrderRestore) === JSON.stringify(expectedCardOrderDraft), {
    channel: 'A',
    expected: JSON.stringify(expectedCardOrderDraft),
    actual: JSON.stringify(cardOrderRestore),
  })
  ev.step({ step: 'v9.scoped-restore', channel: 'C', exitCode: restoreSave.onDisk ? 0 : 1, stats: {} })

  // 关闭设置页，进入 composer 选择器与循环验证
  await ui.click('testid=settings-close-btn')
  await ui.expectGone('testid=model-route-page', { timeoutMs: 20_000 })

  // ══ 7. V9 ③ 建会话 + composer 选择器候选序断言 ════════════════════════════════════
  const created9 = await protocol.call(
    'session.create',
    { cwd: repo, label: 'agg-view-v9', modelOverride: `mockllm/${MAIN}` },
    { timeoutMs: 120_000 },
  )
  const sid9 = created9.session?.id
  ev.assert('B: V9 会话创建（显式绑定 mock-1，规避 default 同步与路由端点串队）', Boolean(sid9), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: `sid=${sid9} model=${created9.session?.modelId ?? '<n/a>'}`,
  })
  await pollStateModel(sid9, `mockllm/${MAIN}`, 'V9 会话绑定 mock-1')
  await protocol.subscribe(sid9)

  await ui.click('css=[title="切换模型"]')
  await ui.expectVisible('testid=model-picker-list', { timeoutMs: 20_000 })
  const expectedPickerOrder = [R9B, R9A, MAIN, EP_W]
  const pickerOrder = await readPickerOrder(page)
  ev.assert('A: V9 ③ composer 选择器 DOM 候选序 = 卡片顺序（r9-beta, r9-alpha, mock-1, ep-w）', JSON.stringify(pickerOrder) === JSON.stringify(expectedPickerOrder), {
    channel: 'A',
    expected: JSON.stringify(expectedPickerOrder),
    actual: JSON.stringify(pickerOrder),
  })
  const pickerSetOk = pickerOrder.length === expectedPickerOrder.length && expectedPickerOrder.every((id) => pickerOrder.includes(id))
  ev.assert('A: V9 ③ 选择器候选集合 = scopedModels 白名单集合（4 项无缺无多余）', pickerSetOk, {
    channel: 'A',
    expected: JSON.stringify(expectedPickerOrder),
    actual: `count=${pickerOrder.length} set=${JSON.stringify(pickerOrder)}`,
  })
  await ev.shot(page, 'v9-picker-order')
  await ui.press('Escape')
  ev.step({ step: 'v9.picker-order', channel: 'A', exitCode: JSON.stringify(pickerOrder) === JSON.stringify(expectedPickerOrder) ? 0 : 1, stats: {} })

  // ══ 8. V9 ④ ctrl+p 循环序：从 mock-1（idx=2）forward 三步 = ep-w → r9-beta → r9-alpha ═
  // 循环序源 = enabledModels（composer-shortcut-actions.ts:55「序 = scopedModels 显示序」）；
  // A 通道键盘驱动（composer-box 聚焦 + Control+p），B 通道 getState 权威读生效值。
  await ui.click('testid=composer-box')
  const expectedCycle = [`mockllm/${EP_W}`, `aggregation/${R9B}`, `aggregation/${R9A}`]
  const cycleActual = []
  let cycleOk = true
  for (const expected of expectedCycle) {
    await ui.press('Control+p')
    const ok = await pollStateModel(sid9, expected, `ctrl+p forward → ${expected}`)
    cycleActual.push(ok ? expected : '<miss>')
    if (!ok) cycleOk = false
  }
  const triggerText = await ui.text('css=[title="切换模型"]')
  ev.assert('A: V9 ④ composer 触发器文本与末次循环落点一致（ep-w）', triggerText.includes(EP_W), {
    channel: 'A',
    expected: `触发器含 ${EP_W}`,
    actual: triggerText.slice(0, 120),
  })
  ev.assert('B: V9 ④ ctrl+p 循环序 = scopedModels 数组序循环（mock-1 → ep-w → r9-beta → r9-alpha）', cycleOk, {
    channel: 'B',
    expected: JSON.stringify(expectedCycle),
    actual: JSON.stringify(cycleActual),
  })
  await ev.shot(page, 'v9-cycle-end')
  ev.step({ step: 'v9.ctrlp-cycle', channel: 'A', exitCode: cycleOk ? 0 : 1, stats: { cycle: cycleActual.join('->') } })

  // ══ 9. V9 白名单行为：subagent 派发白名单（底层零变化回归的行为半边） ══════════════
  // 9a 负向：显式指定白名单外 mock-sub-a → 拒绝，零孙进程请求
  {
    const since = protocol.events.length
    await protocol.send(sid9, 'V9 白名单负向探针：显式指定白名单外模型')
    const end = await protocol.waitTurnEnd(sid9, { since, timeoutMs: 180_000 })
    ev.assert('B: V9 负向派发主轮完成（toolResult isError 不炸轮）', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })
    await new Promise((r) => setTimeout(r, 2_000)) // 拒绝路径无孙进程——短窗观察零新增请求即可
    const denyHits = instance.mockLlm.requests.filter((r) => r.model === SUB_DENY && r.status === 200)
    ev.assert('C: V9 负向——白名单外模型零孙进程请求（worker 未 spawn，白名单收紧行为在）', denyHits.length === 0, {
      channel: 'C',
      expected: 'mock-sub-a 零 200 请求',
      actual: `denyHits=${denyHits.length} allRequests=${instance.mockLlm.requests.length}`,
    })
    const hist = await protocol.history(sid9, { limitTurns: 6 })
    const histText = JSON.stringify(hist.messages ?? [])
    ev.attach('v9-deny-history-excerpt', histText.includes('scoped-models allowlist') ? 'history 含 outside the scoped-models allowlist（拒单文案）' : `history 无 allowlist 字样（截取 ${histText.length} 字节）`)
    ev.step({ step: 'v9.allowlist-deny', channel: 'C', exitCode: denyHits.length === 0 ? 0 : 1, stats: {} })
  }
  // 9b 正向：显式指定白名单内 ep-w → 放行，孙进程真打 mock + record 终态
  {
    const since = protocol.events.length
    await protocol.send(sid9, 'V9 白名单正向探针：显式指定白名单内成员')
    const end = await protocol.waitTurnEnd(sid9, { since, timeoutMs: 180_000 })
    ev.assert('B: V9 正向派发主轮完成', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })
    // 成员出话 = ep-w 队列被消费（孙进程真打 mock 的铁证，条件轮询 60s）
    const deadline = Date.now() + 60_000
    let wHit = null
    while (Date.now() < deadline) {
      wHit = instance.mockLlm.requests.find((r) => r.model === EP_W && r.status === 200) ?? null
      if (wHit) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('C: V9 正向——白名单内成员派发放行（mock.requests 出现 model=ep-w 的 200）', Boolean(wHit), {
      channel: 'C',
      expected: `model=${EP_W} status=200`,
      actual: wHit ? `hit stepIndex=${wHit.stepIndex}` : `60s 未出现；requests=${JSON.stringify(instance.mockLlm.requests.map((r) => ({ m: r.model, s: r.status }))).slice(0, 300)}`,
    })
    // record 终态（done/idle）——派发域白名单行为与升级前一致（派发链完整走通）
    const recDeadline = Date.now() + 60_000
    let record = null
    while (Date.now() < recDeadline) {
      const reply = await protocol.call('session.getSubagents', { sessionId: sid9 }, { timeoutMs: 60_000 })
      record = (reply.subagents ?? []).find((r) => r.slug === 'v9-allow') ?? null
      if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('B: V9 正向——成员 record 走到终态（done/idle）', ['done', 'idle'].includes(String(record?.status)), {
      channel: 'B',
      expected: 'status ∈ {done, idle}',
      actual: `status=${record?.status ?? '<no record>'} model=${record?.model ?? '<n/a>'}`,
    })
    ev.attach('v9-subagent-records', JSON.stringify(record ?? null, null, 2).slice(0, 8_000))
    ev.step({ step: 'v9.allowlist-allow', channel: 'C', exitCode: wHit && ['done', 'idle'].includes(String(record?.status)) ? 0 : 1, stats: {} })
  }

  // ══ 10. V12 装配：路由 r12-trunc = [无条件 ep-va, 时间窗 ep-vb]（协议写侧） ════════
  await saveRoute(routeOf(R12, 'advanced', [member('m-va', EP_VA, 'none'), member('m-vb', EP_VB, 'window', availableNowTable(new Date()))]), `R12 ${R12}`)
  const scopedWithR12 = [...scopedAfterMove, `aggregation/${R12}`]
  await setScoped(scopedWithR12, '追加 r12-trunc')
  assertScopedOnDisk(scopedWithR12, 'V12 装配 scopedModels 终态（追加尾部）')
  const r12OnDisk = (extras().routes?.routes ?? []).find((r) => r.id === R12)
  ev.assert('C: V12 路由落盘形态（members[0]=none 无条件前置 + members[1]=window 时间窗）', r12OnDisk?.members?.[0]?.type === 'none' && r12OnDisk?.members?.[1]?.type === 'window', {
    channel: 'C',
    expected: `[none, window] 端点序`,
    actual: `types=${(r12OnDisk?.members ?? []).map((m) => m.type).join(',')}`,
  })
  const listR12 = await pollModelList((models) => models.some((m) => m.aggregation === true && m.id === R12), 'model.list 出现 r12-trunc')
  ev.step({ step: 'v12.setup', channel: 'C', exitCode: r12OnDisk?.members?.[0]?.type === 'none' && listR12.ok ? 0 : 1, stats: {} })

  // V12 会话：绑定路由（pi 工厂期注册在 spawn 时点，路由已存在 → 可绑定）
  const created12 = await protocol.call(
    'session.create',
    { cwd: repo, label: 'agg-view-v12', modelOverride: `aggregation/${R12}` },
    { timeoutMs: 120_000 },
  )
  const sid12 = created12.session?.id
  await pollStateModel(sid12, `aggregation/${R12}`, 'V12 会话绑定路由 r12-trunc')
  await protocol.subscribe(sid12)
  const sessionFile12 = await sessionFileOf(sid12)

  // ══ 11. V12 ②③ UI 查看：展开卡 → 时间轴警告 + B 端点「不会命中」+ 卡头「此刻」chip ═
  await openRoutePage(ui)
  await ui.click(`css=[data-testid="route-card"][data-route-id="${R12}"] [data-testid="route-card-toggle"]`)
  const warningSel = `css=[data-testid="route-card"][data-route-id="${R12}"] [data-testid="route-time-warning"]`
  await ui.expectVisible(warningSel, { timeoutMs: 20_000 })
  const warningText = await ui.text(warningSel)
  const expectedWarning = '第 1 个端点是无条件端点，排在它后面的时间窗不会命中'
  ev.assert('A: V12 ② 时间轴截断警告文本（timelineWarning，n=1）', warningText.includes(expectedWarning), {
    channel: 'A',
    expected: expectedWarning,
    actual: warningText.slice(0, 200),
  })
  const neverHitSel = `css=[data-testid="route-card"][data-route-id="${R12}"] [data-testid="route-endpoint-row"][data-index="1"] [data-testid="endpoint-never-hit"]`
  await ui.expectVisible(neverHitSel, { timeoutMs: 20_000 })
  const neverHitText = await ui.text(neverHitSel)
  ev.assert('A: V12 ② B 端点标「不会命中」（endpoint-never-hit）', neverHitText.includes('不会命中'), {
    channel: 'A',
    expected: '不会命中',
    actual: neverHitText.slice(0, 100),
  })
  const truncSel = `css=[data-testid="route-card"][data-route-id="${R12}"] [data-testid="route-endpoint-row"][data-index="0"] [data-testid="endpoint-truncates"]`
  let truncText = ''
  try {
    truncText = await ui.text(truncSel)
  } catch {
    truncText = '<未渲染>'
  }
  ev.attach('v12-endpoint0-truncates', `端点 A 行「会截断后续端点」标记：${truncText.slice(0, 60)}`)
  const chipSel = `css=[data-testid="route-card"][data-route-id="${R12}"] [data-testid="route-card-now-chip"]`
  const chipText = await ui.text(chipSel)
  const epVaProviderName = 'Mock LLM' // ensureLlm 写 provider name = 'Mock LLM (verify-taiji local mock-http)'，hitName 取 provider.name
  const chipOk = chipText.includes('此刻') && chipText.includes(epVaProviderName)
  ev.assert('A: V12 ③ 卡头「此刻」chip 显示端点 A 渠道（evaluateRouteAt 权威预览）', chipOk, {
    channel: 'A',
    expected: `chip 含「此刻」与「${epVaProviderName}」（端点 A 渠道名）`,
    actual: chipText.slice(0, 200),
  })
  await ev.shot(page, 'v12-truncation-card')
  ev.step({ step: 'v12.ui-preview', channel: 'A', exitCode: warningText.includes(expectedWarning) && neverHitText.includes('不会命中') && chipOk ? 0 : 1, stats: {} })
  await ui.click('testid=settings-close-btn')
  await ui.expectGone('testid=model-route-page', { timeoutMs: 20_000 })

  // ══ 12. V12 ④ 对话验证实际命中 A（与「此刻」chip 预览一致） ═══════════════════════
  {
    const since = protocol.events.length
    await protocol.send(sid12, 'V12 对话验证：无条件端点前置，应命中端点 A')
    const end = await protocol.waitTurnEnd(sid12, { since, timeoutMs: 180_000 })
    ev.assert('B: V12 对话轮正常完成', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const tail = tailOkRequest()
    ev.assert('C: V12 对话实际命中端点 A = ep-va（mockLlm.requests 尾部裸 id）', tail?.model === EP_VA, {
      channel: 'C',
      expected: `model=${EP_VA}（与「此刻」chip 预览一致）`,
      actual: `tail.model=${tail?.model ?? '<none>'}`,
    })
    // C 双证：会话 JSONL 助手消息物理模型记录
    if (sessionFile12) {
      const deadline = Date.now() + 10_000
      let lastModel = null
      for (;;) {
        try {
          const raw = fs.readFileSync(sessionFile12, 'utf8')
          const entries = []
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line)
              const m = obj?.message ?? obj
              if (m?.role === 'assistant' && typeof m?.model === 'string') entries.push(m.model)
            } catch { /* 非 JSON 行跳过 */ }
          }
          if (entries.length > 0) {
            lastModel = entries[entries.length - 1]
            break
          }
        } catch { /* 文件未 flush 重试 */ }
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 300))
      }
      ev.assert('C: V12 会话 JSONL 助手消息物理模型 = ep-va（pi 原生记录）', lastModel === EP_VA, {
        channel: 'C',
        expected: EP_VA,
        actual: `last=${lastModel ?? '<none>'} file=${path.basename(sessionFile12)}`,
      })
    } else {
      ev.assert('C: V12 会话文件定位', false, { channel: 'C', expected: 'sessionFile 非空', actual: '<summary 未带 sessionFile>' })
    }
    ev.step({ step: 'v12.chat-hit', channel: 'C', exitCode: tail?.model === EP_VA ? 0 : 1, stats: { model: tail?.model } })
  }

  // ══ 13. 终态 C 核对：routes 段 + scopedModels 与各阶段操作一致 ═════════════════════
  const finalExtras = extras()
  const finalRoutes = finalExtras.routes?.routes ?? []
  const finalOk = finalRoutes.length === 3
    && finalRoutes.every((r) => [R9A, R9B, R12].includes(r.id))
    && JSON.stringify(finalExtras.scopedModels ?? []) === JSON.stringify(scopedWithR12)
  ev.assert('C: 终态 routes 三条 + scopedModels 五项序与操作链一致', finalOk, {
    channel: 'C',
    expected: `routes=[${[R9A, R9B, R12].join(',')}] scoped=${JSON.stringify(scopedWithR12)}`,
    actual: `routes=${finalRoutes.map((r) => r.id).join(',')} scoped=${JSON.stringify(finalExtras.scopedModels ?? null)}`,
  })
  ev.attach('extras-final', JSON.stringify(finalExtras, null, 2).slice(0, 12_000))
  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })), null, 2))
  ev.step({ step: 'final-state', channel: 'C', exitCode: finalOk ? 0 : 1, stats: { routes: finalRoutes.length } })

  log(`agg-view-orchestration done sid9=${sid9} sid12=${sid12}`)
  return { uncovered, gotchas }
}
