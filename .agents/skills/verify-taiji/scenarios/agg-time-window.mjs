/**
 * agg-time-window —— 时间窗路由全链（provider-aggregation 设计 §4.1 V1/V2/V5/V6/V10/V11，M1 交付面）。
 *
 * 判据原文（设计文档 V 行摘录）：
 * - V1 高峰期自动切换：双端点路由（时间窗端点带高峰时段表 + 无条件端点兜底），当前时刻
 *   处于高峰（时间窗端点判窗外）→ 助手消息物理模型为兜底端点真实 id，对话正常出话。
 * - V2 非高峰期命中首选：修改时间窗使时间窗端点判窗内 → 同一会话继续发消息 → 物理模型
 *   为时间窗端点真实 id；全程无手动切换动作。
 * - V5 配置热生效：会话命中端点 A → 编辑时间窗使 A 不可用 → 保存 → 同一会话再发消息
 *   （扩展在该次 route 求值前按 mtime 检查重读——无等待窗口、无定时器，D1 修订形态）
 *   → 命中端点 B；会话绑定保持不变，无需重选模型。
 * - V6 重开会话路由 state 回放：≥2 次不同端点命中后关闭会话并重开 → 会话仍绑定模型
 *   路由；路由正常出话；历史消息中各物理模型记录保持原样。
 * - V10 simple 模式依次兜底（D12）：simple 恒命中第一个端点（不判条件）；切 advanced
 *   再切回 simple 条件数据保留；toasts 呈现模式语义（toasts 归 notProvable，A 通道）。
 * - V11 特殊日期 include 型（D13）：include 区间判窗内 → 命中该端点；include 区间外且
 *   周表该日不适用 → 按include 语义回落判定不命中。
 *
 * 装配：mock-http（createInstance llm 通道，模型 key 按端点拆演员）。路由端点 A/B 指向
 * 同一 mock server 的不同 model（ep-a/ep-b 等）——命中判据 = instance.mockLlm.requests
 * 尾部（status 200）的 model 字段（pi 发往 HTTP 的 model 是裸 id，mock-http README 坑 1）
 * + 会话 JSONL 助手消息的物理模型记录（pi AssistantMessage.model，C 通道磁盘证据）。
 * 路由写通道 = aggregation.saveRoute（runtime 唯一写点，provider-extras-store RMW 原子写
 * → mtime 变化 → 扩展求值前重读）；白名单 = config.setScopedModels（聚合复合串
 * aggregation/<routeId>）。
 *
 * 时间窗构造纪律（30 分钟格 + 跨格竞态）：blocked 形态 = 今日 current+next 两格涂 false
 * （其余 true）；available 形态 = current+next 两格 true（其余 false）——剧本全程数分钟，
 * 跨越 30 分钟格边界时两态判定不翻转。V11 双态为「include 区间含当前时刻 / 不含当前
 * 时刻且周表今日行不适用」，单墙钟热编辑构造（V11 两时刻的等待形态归 notProvable）。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'

// ── mock 演员：每端点独立 model（独立队列，游标 per-model 互不污染） ──────────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id，selectQueue 按裸段匹配；_note 被忽略',
  'mockllm/mock-1': [step('agg-tw-default-1'), step('agg-tw-default-2')],
  'mockllm/ep-a': [step('agg-tw-ep-a-1'), step('agg-tw-ep-a-2')],
  'mockllm/ep-b': [step('agg-tw-ep-b-1'), step('agg-tw-ep-b-2'), step('agg-tw-ep-b-3'), step('agg-tw-ep-b-4')],
  'mockllm/s-a': [step('agg-tw-s-a-1'), step('agg-tw-s-a-2'), step('agg-tw-s-a-3')],
  'mockllm/s-b': [step('agg-tw-s-b-1'), step('agg-tw-s-b-2')],
  'mockllm/v-a': [step('agg-tw-v-a-1'), step('agg-tw-v-a-2')],
  'mockllm/v-b': [step('agg-tw-v-b-1'), step('agg-tw-v-b-2')],
}

export const meta = {
  id: 'agg-time-window',
  priority: 'P0',
  title: '时间窗路由全链：V1 高峰兜底 + V2 非高峰首选 + V5 热生效 + V6 重开回放 + V10 simple 模式 + V11 特殊日期 include',
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
    models: ['mock-1', 'mock-sub-a', 'ep-a', 'ep-b', 's-a', 's-b', 'v-a', 'v-b'],
  },
  estimateSec: 360,
  provable: [
    '装配链 B+C：aggregation.saveRoute 落盘 providers.json routes 段（C）+ config.setScopedModels 白名单含聚合复合串（B 回执 + C 落盘）+ getRouteView 卡片 scoped=true（B）',
    'V1 B+C：advanced 路由（A=window 当前窗内不可用，B=none 兜底），绑定路由的会话首条消息命中兜底端点 ep-b——mockLlm.requests 尾部 model=ep-b（裸 id）+ 会话 JSONL 助手消息 model=ep-b',
    'V2 B+C：同一会话编辑时间窗（时间窗端点判窗内）后下一请求命中 ep-a；全程零 model.switch 调用（无手动切换，getState 绑定保持）',
    'V5 B：会话命中 ep-a 后编辑时间窗（A 不可用）→ 同一会话下一请求命中 ep-b（保存后第一请求即变化 = 无等待窗）；getState 绑定仍为聚合引用，无需重选模型',
    'V6 B+C：≥2 种端点命中后 forceQuit 杀 pi + switch 重开（runtime 日志 spawning pi 计数增加）→ getState 仍绑定路由、下一请求正常路由命中、JSONL 历史助手消息物理模型序列原样保持并追加新命中',
    'V10 B+C：simple 恒命中第一个端点 s-a（其窗表当前判窗外仍命中 = 条件不参与求值的铁证）→ 切 advanced 命中 s-b（条件生效）→ 切回 simple 命中 s-a；getRouteView 卡片窗表数据跨模式翻转保留（条件数据保留）',
    'V11 B+C：特殊日期 include 区间含当前时刻 → 命中 v-a（include 判窗内优先于周表）；编辑 include 区间不含当前时刻（周表今日行不适用）→ 命中 v-b（include 外回落周表判定）',
    'C 终态：providers.json routes 段三条路由与各阶段终态一致（R1 窗表=V5 终态、R2 mode=simple、R3 specials=窗外区间）',
  ],
  notProvable: [
    'V10 判据「toasts 呈现模式语义」：toast 是 A 通道瞬态 UI 呈现，本剧本走协议写侧（B/C）不驱动 UI——归 UI 剧本/手工验收',
    'V1 判据「选择器与回执显示聚合名不变」的选择器/回执渲染半边：本剧本以 model.list 聚合条目 + getState 虚拟引用（B）证数据面，渲染归 UI 剧本/手工验收',
    'V6 判据「关闭会话（或重启应用）」的应用重启分支：本剧本取关闭会话+重开分支（forceQuit+switch），应用级重启归实例生命周期编排（runner 管理），不在剧本内做',
    'V11 判据的两个真实墙钟时刻（节假日 21:00 与 10:00）：单次跑通墙钟只有一个时刻，双态以 include 区间含/不含当前时刻的热编辑构造（语义等价：in-window 命中 / out-of-window 回落周表）；等待真实时刻跨越不进剧本',
    'V2 判据「等待或修改时间窗」中的等待分支：采用修改时间窗（saveRoute 热编辑），不等待真实时间窗跨越',
  ],
}

// ── 时间窗表构造（30 分钟格；跨格竞态防护见文件头） ──────────────────────────────
const minutesNow = (now) => now.getHours() * 60 + now.getMinutes()
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
function localDateKey(now) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
const todayRow = (now) => (now.getDay() + 6) % 7 // ISO 行：0=周一..6=周日
const currentSlot = (now) => Math.floor(minutesNow(now) / 30)

/** blocked-now 表：全 true，仅今日 current+next 两格 false（高峰不可用窗覆盖格边界）。 */
function blockedNowTable(now) {
  const t = Array.from({ length: 7 }, () => Array(48).fill(true))
  const row = todayRow(now)
  const slot = currentSlot(now)
  t[row][slot] = false
  t[row][(slot + 1) % 48] = false
  return t
}

/** available-now 表：全 false，仅今日 current+next 两格 true。 */
function availableNowTable(now) {
  const t = Array.from({ length: 7 }, () => Array(48).fill(false))
  const row = todayRow(now)
  const slot = currentSlot(now)
  t[row][slot] = true
  t[row][(slot + 1) % 48] = true
  return t
}

/** 工作日白天周表（周一..周五 08:00-18:00 = 格 16..35）+ 今日行全 false（周表该日不适用构造）。 */
function workdayDaytimeTableExcludingToday(now) {
  const t = Array.from({ length: 7 }, () => Array(48).fill(false))
  for (let d = 0; d < 5; d++) for (let c = 16; c < 36; c++) t[d][c] = true
  const row = todayRow(now)
  for (let c = 0; c < 48; c++) t[row][c] = false
  return t
}

/** include 区间含当前时刻（now±30min 夹取到当日 00:00-23:59；恒 from<to）。 */
function coverIncludeRange(now) {
  const m = minutesNow(now)
  return { from: fmtMin(Math.max(0, m - 30)), to: fmtMin(Math.min(23 * 60 + 59, m + 30)) }
}

/** include 区间不含当前时刻（now+60..now+120；now ≥ 22:59 时用 [00:00,00:30] 避让）。 */
function outsideIncludeRange(now) {
  const m = minutesNow(now)
  if (m + 60 >= 23 * 60 + 59) return { from: '00:00', to: '00:30' }
  return { from: fmtMin(m + 60), to: fmtMin(Math.min(23 * 60 + 59, m + 120)) }
}

// ── 剧本 run ════════════════════════════════════════════════════════════════════
export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'mock-http 游标 per-model（mock server 进程持有）：三个路由各用独立端点模型（ep-a/ep-b、s-a/s-b、v-a/v-b），队列步数按轮次预置，互不污染',
    'pi 发往 HTTP 的 model 是裸 id（mock-http README 坑 1）——mockLlm.requests[].model 断言用裸 id',
    '时间窗 30 分钟格存在跨格竞态：blocked/available 两形态都覆盖 current+next 两格，剧本分钟级全程内两态判定不翻转',
    'pi 对不在 enabledModels 的模型引用是自动追加不是拒绝（pi agent-session.js:1934-1940）——聚合引用无需预置 enabledModels',
    'session.getState 活会话分支读 replicated states 快照（session-state-query.ts:216-224），快照 seed 与 session.create 回执之间存在竞态窗口（modelId 字段缺省）——绑定断言用条件轮询',
    'model.list 是 scopedModels 白名单过滤后的选择器候选：端点物理模型未入白名单时不在列是产品正确行为——端点存在性前提看 models.json（C），聚合条目可见性在白名单写入后断言（B）',
    'V11 单墙钟双态构造：include 含当前时刻 = 判窗内分支；include 不含当前时刻且周表今日行全 false = 「区间外且周表该日不适用」回落分支',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))

  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} today=${localDateKey(now0)} row=${todayRow(now0)} slot=${currentSlot(now0)}`)

  // ── 0. 前提：端点物理模型在 models.json（pi modelRegistry 物理段源，C）+ extras 在位 ──
  // 注意：model.list 是 scopedModels 白名单过滤后的选择器候选（aggregateModelsWithScoped），
  // 端点未入白名单时不在列是产品正确行为——端点存在性前提看 models.json，聚合条目可见性
  // 在 setScopedModels 之后单独断言。
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const needEndpoints = ['ep-a', 'ep-b', 's-a', 's-b', 'v-a', 'v-b']
  const endpointsReady = needEndpoints.every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——路由端点物理模型全部在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: needEndpoints.join(','),
    actual: `hits=${needEndpoints.filter((id) => endpointIds.includes(id)).length}/6 in=${endpointIds.join(',').slice(0, 200)}`,
  })
  let seedScoped = []
  try {
    seedScoped = extras().scopedModels ?? []
  } catch {
    /* extras 缺席（非模板种子形态）——setScopedModels 以空基线起 */
  }
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady ? 0 : 1, stats: { seedScoped: seedScoped.length } })

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

  async function readAssistantModels(sessionFile, expectAtLeast, timeoutMs = 10_000) {
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
              entries.push({ model: m.model, provider: m.provider ?? null })
            }
          } catch {
            /* 非 JSON 行跳过 */
          }
        }
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

  function tailRequest() {
    const ok = instance.mockLlm.requests.filter((r) => r.status === 200)
    return ok[ok.length - 1] ?? null
  }

  /**
   * 发一条消息并断言本轮命中 expectBareModel（mockLlm.requests 尾部 model + turn 正常完成）。
   * 返回 { end, tail, hitAt }；hitAt = mock server 收到请求的时刻（V5 无等待窗证据用）。
   */
  async function sendTurn(sid, text, expectBareModel, label, { sessionFile, expectAssistantCount } = {}) {
    const since = protocol.events.length
    const tSaveNote = Date.now()
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
      actual: `tail.model=${tail?.model ?? '<none>'} stepIndex=${tail?.stepIndex} gapAfterSaveMs=${tail?.at ? tail.at - tSaveNote : 'n/a'}`,
    })
    if (sessionFile && expectAssistantCount !== undefined) {
      const entries = await readAssistantModels(sessionFile, expectAssistantCount)
      const last = entries[entries.length - 1]
      ev.assert(`C: ${label} 助手消息物理模型记录 = ${expectBareModel}（会话 JSONL）`, last?.model === expectBareModel, {
        channel: 'C',
        expected: `第 ${expectAssistantCount} 条助手消息 model=${expectBareModel}`,
        actual: `count=${entries.length} last=${JSON.stringify(last ?? null)}`,
      })
    }
    return { end, tail, hitAt: tail?.at ?? Date.now() }
  }

  /**
   * 条件轮询 getState 直到 modelId 等于期望绑定（活会话 replicated 快照 seed 与
   * session.create 回执之间存在竞态窗口——session-state-query.ts 活分支读快照，快照
   * 未 seed 时 modelId 字段缺省；按技能等待纪律条件轮询，不盲等）。
   */
  async function pollBoundModelId(sid, expectedRef, label, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
      last = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
      if (last?.modelId === expectedRef) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert(`B: ${label} 绑定模型路由`, last?.modelId === expectedRef, {
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

  // ══ 1. 装配路由 R1（V1 配置：A=window 当前判窗外，B=none 兜底） ═══════════════
  const r1Window = blockedNowTable(now0)
  const r1v1 = routeOf('agg-tw-main', 'advanced', [member('ep-a', 'ep-a', 'window', r1Window), member('ep-b', 'ep-b', 'none')])
  const tSave0 = Date.now()
  await saveRoute(r1v1, 'R1 v1（A=blocked-now, B=none）')
  const routesOnDisk1 = extras().routes?.routes ?? []
  const r1OnDisk = routesOnDisk1.find((r) => r.id === 'agg-tw-main')
  ev.assert('C: R1 落盘 providers.json routes 段（saveRoute 唯一写点）', Boolean(r1OnDisk) && r1OnDisk.members[0].window?.[todayRow(now0)]?.[currentSlot(now0)] === false, {
    channel: 'C',
    expected: `routes 含 agg-tw-main 且 A 窗今日当前格=false（A 判窗外）`,
    actual: `routeIds=${routesOnDisk1.map((r) => r.id).join(',')} cell=${r1OnDisk?.members?.[0]?.window?.[todayRow(now0)]?.[currentSlot(now0)]}`,
  })
  ev.attach('extras-after-r1-save', JSON.stringify({ routes: routesOnDisk1, scopedModels: extras().scopedModels ?? null }, null, 2).slice(0, 8_000))

  // scopedModels 白名单（读现状追加，setScopedModels 全量替换语义）
  const scoped1 = await protocol.call(
    'config.setScopedModels',
    { models: [...seedScoped, `${AGG}/agg-tw-main`] },
    { replyType: 'config.scopedModels', timeoutMs: 60_000 },
  )
  ev.assert('B+C: setScopedModels 回执白名单含聚合复合串', (scoped1?.scopedModels ?? []).includes(`${AGG}/agg-tw-main`), {
    channel: 'B',
    expected: `${AGG}/agg-tw-main 在回执 scopedModels`,
    actual: `scoped=${JSON.stringify(scoped1?.scopedModels ?? null).slice(0, 200)}`,
  })
  const scopedOnDisk = extras().scopedModels ?? []
  ev.assert('C: scopedModels 落盘含聚合复合串', scopedOnDisk.includes(`${AGG}/agg-tw-main`), {
    channel: 'C',
    expected: `${AGG}/agg-tw-main 在 providers.json scopedModels`,
    actual: JSON.stringify(scopedOnDisk).slice(0, 200),
  })

  // 选择器可见性：白名单加入后 model.list 应出现聚合条目（runtime 注入 × scoped 过滤联动，
  // 条件轮询——D4 磁盘即时派生，正常应立即出现）
  let aggListed = false
  let aggListActual = ''
  {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const mlNow = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
      const aggEntries = (mlNow.models ?? []).filter((m) => m.aggregation === true || m.providerId === AGG)
      if (aggEntries.some((m) => m.id === 'agg-tw-main')) {
        aggListed = true
        aggListActual = `ids=${aggEntries.map((m) => m.id).join(',')}`
        break
      }
      aggListActual = `agg=${aggEntries.length} all=${(mlNow.models ?? []).map((m) => `${m.providerId ?? m.provider}/${m.id}`).join(',').slice(0, 200)}`
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: model.list 出现聚合条目 agg-tw-main（选择器候选 = 注入 × scopedModels 白名单）', aggListed, {
    channel: 'B',
    expected: 'model.list 含 providerId=aggregation / id=agg-tw-main',
    actual: aggListActual,
  })

  const view1 = await protocol.call('aggregation.getRouteView', {}, { replyType: 'aggregation.routeView', timeoutMs: 60_000 })
  const card1 = (view1.cards ?? []).find((c) => c.route?.id === 'agg-tw-main')
  ev.assert('B: getRouteView 卡片 scoped=true（选择器可见性 join 视图）', card1?.scoped === true, {
    channel: 'B',
    expected: 'agg-tw-main 卡 scoped=true',
    actual: `cards=${(view1.cards ?? []).map((c) => `${c.route?.id}:${c.scoped}`).join(',')}`,
  })
  ev.step({ step: 'setup.route-r1', channel: 'B', exitCode: card1?.scoped === true ? 0 : 1, stats: {} })

  // ══ 2. V1 高峰兜底：首条消息命中 ep-b ════════════════════════════════════════
  const sid1 = await createBoundSession(`${AGG}/agg-tw-main`, 'agg-tw-v1-session')
  const sessionFile1 = await sessionFileOf(sid1)
  // pi 延迟写入：首条消息 flush 前 JSONL 可能尚不存在——定位只断言非空，存在性由
  // readAssistantModels 的条件轮询（V1 首轮 expectAssistantCount=1）承担
  ev.assert('C: 会话文件定位（config.sessions summary.sessionFile 非空）', Boolean(sessionFile1), {
    channel: 'C',
    expected: 'sessionFile 非空（首条消息 flush 前允许文件未创建）',
    actual: sessionFile1 || '<summary 未带 sessionFile>',
  })
  const v1 = await sendTurn(sid1, 'V1 高峰时段：时间窗端点判窗外，应兜底到 ep-b', 'ep-b', 'V1 首轮', { sessionFile: sessionFile1, expectAssistantCount: 1 })
  ev.step({ step: 'v1.peak-fallback', channel: 'C', exitCode: v1.tail?.model === 'ep-b' ? 0 : 1, stats: { model: v1.tail?.model } })

  // ══ 3. V2 非高峰命中首选：编辑时间窗（A 判窗内）→ 同会话下一请求命中 ep-a ════
  const r1v2 = routeOf('agg-tw-main', 'advanced', [member('ep-a', 'ep-a', 'window', availableNowTable(new Date())), member('ep-b', 'ep-b', 'none')])
  await saveRoute(r1v2, 'R1 v2（A=available-now）')
  const v2 = await sendTurn(sid1, 'V2 非高峰：时间窗端点判窗内，应命中首选 ep-a（无手动切换）', 'ep-a', 'V2', { sessionFile: sessionFile1, expectAssistantCount: 2 })
  const stateAfterV2 = await protocol.call('session.getState', { sessionId: sid1 }, { timeoutMs: 60_000 })
  ev.assert('B: V2 全程无手动切换——绑定保持聚合引用', stateAfterV2?.modelId === `${AGG}/agg-tw-main`, {
    channel: 'B',
    expected: `getState.modelId=${AGG}/agg-tw-main（零 model.switch）`,
    actual: `modelId=${stateAfterV2?.modelId}`,
  })
  ev.step({ step: 'v2.offpeak-preferred', channel: 'C', exitCode: v2.tail?.model === 'ep-a' ? 0 : 1, stats: { model: v2.tail?.model } })

  // ══ 4. V5 配置热生效：会话刚命中 ep-a（= 判据步骤 1），编辑窗表使 A 不可用 → 同会话下一请求命中 ep-b ══
  const r1v3 = routeOf('agg-tw-main', 'advanced', [member('ep-a', 'ep-a', 'window', blockedNowTable(new Date())), member('ep-b', 'ep-b', 'none')])
  const savedV5 = await saveRoute(r1v3, 'R1 v3（A=blocked-now，V5 编辑）')
  const saveReplyAt = Date.now()
  const v5 = await sendTurn(sid1, 'V5 热生效：编辑后下一请求应命中 ep-b，绑定不重选', 'ep-b', 'V5', { sessionFile: sessionFile1, expectAssistantCount: 3 })
  const stateAfterV5 = await protocol.call('session.getState', { sessionId: sid1 }, { timeoutMs: 60_000 })
  ev.assert('B: V5 会话绑定保持不变（无需重选模型）', stateAfterV5?.modelId === `${AGG}/agg-tw-main`, {
    channel: 'B',
    expected: `getState.modelId=${AGG}/agg-tw-main`,
    actual: `modelId=${stateAfterV5?.modelId}`,
  })
  ev.attach('v5.no-wait-window', `saveRoute 回执时刻=${new Date(saveReplyAt).toISOString()}（reply.route.id=${savedV5?.route?.id}）；本轮 mock 请求到达时刻=${new Date(v5.hitAt).toISOString()}；间隔=${v5.hitAt - saveReplyAt}ms——保存与求值之间零 sleep、零定时器，命中变化发生在保存后第一请求（mtime 重读 D1 形态）`)
  ev.step({ step: 'v5.hot-effect', channel: 'C', exitCode: v5.tail?.model === 'ep-b' ? 0 : 1, stats: { model: v5.tail?.model } })

  // ══ 5. V6 重开会话路由 state 回放 ════════════════════════════════════════════
  // 前提：t1..t3 已产生 ep-b → ep-a → ep-b（≥2 种端点命中）。
  const historyBefore = await readAssistantModels(sessionFile1, 3)
  const { readRuntimeLogs } = await import('../scripts/lib/instance.mjs')
  const spawnCountBefore = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  const fq = await protocol.call('session.forceQuit', { sessionId: sid1 }, { timeoutMs: 60_000 })
  ev.assert('B: forceQuit ack（强杀 pi 进程 = 关闭会话）', fq?.status === 'force_quit', {
    channel: 'B',
    expected: "message.status status='force_quit'",
    actual: JSON.stringify(fq ?? null).slice(0, 200),
  })
  const switched = await protocol.call('session.switch', { sessionId: sid1 }, { replyType: 'session.switched', timeoutMs: 120_000 })
  ev.assert('B: 重开会话（session.switch 回执）', switched?.sessionId === sid1, {
    channel: 'B',
    expected: `session.switched sessionId=${sid1}`,
    actual: `sessionId=${switched?.sessionId}`,
  })
  await protocol.subscribe(sid1)
  await pollBoundModelId(sid1, `${AGG}/agg-tw-main`, 'V6 重开后仍绑定模型路由（路由 state 回放）')
  const v6 = await sendTurn(sid1, 'V6 重开后继续：应按当前配置（A 判窗外）命中 ep-b，路由正常出话', 'ep-b', 'V6 重开后首轮', { sessionFile: sessionFile1, expectAssistantCount: 4 })
  const spawnCountAfter = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  ev.assert('C: V6 pi 进程重开（runtime 日志 spawning pi 计数增加）', spawnCountAfter > spawnCountBefore, {
    channel: 'C',
    expected: `spawning pi 计数 > ${spawnCountBefore}`,
    actual: `after=${spawnCountAfter}`,
  })
  const historyAfter = await readAssistantModels(sessionFile1, 4)
  const preserved = historyBefore.length === 3
    && historyAfter.length >= 4
    && JSON.stringify(historyAfter.slice(0, 3)) === JSON.stringify(historyBefore)
    && historyAfter[3]?.model === 'ep-b'
  ev.assert('C: V6 历史助手消息物理模型记录保持原样（ep-b,ep-a,ep-b 前缀不变 + 重开后追加 ep-b）', preserved, {
    channel: 'C',
    expected: `[ep-b,ep-a,ep-b,...原样] + [ep-b]`,
    actual: `before=${JSON.stringify(historyBefore)} after=${JSON.stringify(historyAfter)}`,
  })
  ev.step({ step: 'v6.reopen-replay', channel: 'C', exitCode: preserved && v6.tail?.model === 'ep-b' ? 0 : 1, stats: { spawns: `${spawnCountBefore}->${spawnCountAfter}` } })

  // ══ 6. V10 simple 模式依次兜底（D12） ════════════════════════════════════════
  const sWindow = blockedNowTable(new Date())
  const r2v1 = routeOf('agg-tw-simple', 'simple', [member('s-a', 's-a', 'window', sWindow), member('s-b', 's-b', 'none')])
  await saveRoute(r2v1, 'R2 v1（simple，s-a 窗表当前判窗外）')
  await protocol.call(
    'config.setScopedModels',
    { models: [...(extras().scopedModels ?? seedScoped), `${AGG}/agg-tw-simple`] },
    { replyType: 'config.scopedModels', timeoutMs: 60_000 },
  )
  const sid2 = await createBoundSession(`${AGG}/agg-tw-simple`, 'agg-tw-v10-session')
  const sessionFile2 = await sessionFileOf(sid2)
  // simple 恒命中第一个端点（不判条件）——s-a 窗表当前判窗外仍被命中 = 条件未参与求值的铁证
  const v10a = await sendTurn(sid2, 'V10 simple：窗表判外也恒命中第一端点 s-a（不判条件）', 's-a', 'V10 simple 首轮', { sessionFile: sessionFile2, expectAssistantCount: 1 })
  // 切 advanced（仅改 mode；条件数据原样保留）→ 条件生效：s-a 判窗外 → s-b
  await saveRoute(routeOf('agg-tw-simple', 'advanced', [member('s-a', 's-a', 'window', sWindow), member('s-b', 's-b', 'none')]), 'R2 v2（advanced）')
  const v10b = await sendTurn(sid2, 'V10 advanced：条件生效，s-a 判窗外应命中 s-b', 's-b', 'V10 advanced', { sessionFile: sessionFile2, expectAssistantCount: 2 })
  // 切回 simple → 恒命中 s-a；条件数据保留由 advanced 轮已证（数据仍在并被求值）
  await saveRoute(routeOf('agg-tw-simple', 'simple', [member('s-a', 's-a', 'window', sWindow), member('s-b', 's-b', 'none')]), 'R2 v3（切回 simple）')
  const v10c = await sendTurn(sid2, 'V10 切回 simple：恢复恒命中第一端点 s-a', 's-a', 'V10 simple 复归', { sessionFile: sessionFile2, expectAssistantCount: 3 })
  const view2 = await protocol.call('aggregation.getRouteView', {}, { replyType: 'aggregation.routeView', timeoutMs: 60_000 })
  const card2 = (view2.cards ?? []).find((c) => c.route?.id === 'agg-tw-simple')
  const windowPreserved = JSON.stringify(card2?.route?.members?.[0]?.window ?? null) === JSON.stringify(sWindow)
    && card2?.route?.members?.[0]?.type === 'window'
    && card2?.route?.mode === 'simple'
  ev.assert('B: V10 切回 simple 后窗表条件数据保留（getRouteView 卡片与保存时逐格一致）', windowPreserved, {
    channel: 'B',
    expected: 'members[0].window 与保存时一致且 mode=simple（切模式不丢条件）',
    actual: `mode=${card2?.route?.mode} type=${card2?.route?.members?.[0]?.type} windowMatch=${JSON.stringify(card2?.route?.members?.[0]?.window ?? null) === JSON.stringify(sWindow)}`,
  })
  const v10ok = v10a.tail?.model === 's-a' && v10b.tail?.model === 's-b' && v10c.tail?.model === 's-a' && windowPreserved
  ev.step({ step: 'v10.simple-fallback', channel: 'C', exitCode: v10ok ? 0 : 1, stats: { hits: [v10a.tail?.model, v10b.tail?.model, v10c.tail?.model].join('->') } })

  // ══ 7. V11 特殊日期 include 型（D13） ════════════════════════════════════════
  const nowV11 = new Date()
  const weekly = workdayDaytimeTableExcludingToday(nowV11)
  const cover = coverIncludeRange(nowV11)
  const r3v1 = routeOf('agg-tw-special', 'advanced', [member('v-a', 'v-a', 'window', weekly), member('v-b', 'v-b', 'none')], [
    { id: 'sp-today', date: localDateKey(nowV11), mode: 'include', from: cover.from, to: cover.to },
  ])
  await saveRoute(r3v1, `R3 v1（include ${cover.from}-${cover.to} 含当前时刻 + 周表今日行不适用）`)
  await protocol.call(
    'config.setScopedModels',
    { models: [...(extras().scopedModels ?? seedScoped), `${AGG}/agg-tw-special`] },
    { replyType: 'config.scopedModels', timeoutMs: 60_000 },
  )
  const sid3 = await createBoundSession(`${AGG}/agg-tw-special`, 'agg-tw-v11-session')
  const sessionFile3 = await sessionFileOf(sid3)
  const v11a = await sendTurn(sid3, 'V11 include 判窗内：特殊日期优先于周表，应命中 v-a', 'v-a', 'V11 include 判窗内', { sessionFile: sessionFile3, expectAssistantCount: 1 })
  const out = outsideIncludeRange(new Date())
  await saveRoute(routeOf('agg-tw-special', 'advanced', [member('v-a', 'v-a', 'window', weekly), member('v-b', 'v-b', 'none')], [
    { id: 'sp-today', date: localDateKey(nowV11), mode: 'include', from: out.from, to: out.to },
  ]), `R3 v2（include ${out.from}-${out.to} 不含当前时刻）`)
  const v11b = await sendTurn(sid3, 'V11 include 判窗外且周表该日不适用：应落选 v-a 兜底 v-b', 'v-b', 'V11 include 判窗外', { sessionFile: sessionFile3, expectAssistantCount: 2 })
  ev.step({ step: 'v11.special-include', channel: 'C', exitCode: v11a.tail?.model === 'v-a' && v11b.tail?.model === 'v-b' ? 0 : 1, stats: { hits: [v11a.tail?.model, v11b.tail?.model].join('->'), include: `${cover.from}-${cover.to} -> ${out.from}-${out.to}` } })

  // ══ 8. 终态 C 核对：providers.json routes 段与各阶段终态一致 ════════════════
  const finalExtras = extras()
  const finalRoutes = finalExtras.routes?.routes ?? []
  const fR1 = finalRoutes.find((r) => r.id === 'agg-tw-main')
  const fR2 = finalRoutes.find((r) => r.id === 'agg-tw-simple')
  const fR3 = finalRoutes.find((r) => r.id === 'agg-tw-special')
  const blockedNowFinal = blockedNowTable(new Date())
  const finalOk = finalRoutes.length === 3
    && fR1?.mode === 'advanced'
    && JSON.stringify(fR1?.members?.[0]?.window ?? null) === JSON.stringify(blockedNowFinal)
    && fR2?.mode === 'simple'
    && fR3?.specials?.[0]?.mode === 'include'
    && fR3?.specials?.[0]?.from === out.from
    && fR3?.specials?.[0]?.to === out.to
  ev.assert('C: 终态 routes 段与各阶段终态一致（R1 窗表=V5 终态 / R2 simple / R3 specials=窗外区间）', finalOk, {
    channel: 'C',
    expected: 'routes=3；R1 advanced+A=blocked-now；R2 simple；R3 include 区间=窗外值',
    actual: `ids=${finalRoutes.map((r) => r.id).join(',')} r1Mode=${fR1?.mode} r1WindowMatch=${JSON.stringify(fR1?.members?.[0]?.window ?? null) === JSON.stringify(blockedNowFinal)} r2Mode=${fR2?.mode} r3Special=${JSON.stringify(fR3?.specials?.[0] ?? null)}`,
  })
  ev.attach('extras-final', JSON.stringify(finalExtras, null, 2).slice(0, 12_000))
  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))
  ev.step({ step: 'final-state', channel: 'C', exitCode: finalOk ? 0 : 1, stats: { routes: finalRoutes.length } })

  log(`agg-time-window done sids=${sid1},${sid2},${sid3} hits=${[v1.tail?.model, v2.tail?.model, v5.tail?.model, v6.tail?.model, v10a.tail?.model, v10b.tail?.model, v10c.tail?.model, v11a.tail?.model, v11b.tail?.model].join('->')}`)
  return { uncovered, gotchas }
}
