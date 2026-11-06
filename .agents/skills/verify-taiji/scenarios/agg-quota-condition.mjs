/**
 * agg-quota-condition —— 额度条件路由全链（provider-aggregation 设计 §4.1 V3，M2 交付面）。
 *
 * 判据原文（设计文档 V3 行摘录 + 任务判据）：
 * - V3 额度耗尽自动切换（额度条件可控触发）：端点 A 配额度阈值（构造使 A 恒判耗尽）+
 *   端点 B 无条件 → 发消息命中 B → 阈值改回（100 → 80）→ 再发消息回到 A；两次切换零
 *   手动动作；保存变更下一请求生效（扩展在该次 route 求值前按 mtime 检查重读，无等待窗口）。
 *
 * 额度条件语义（亲读依据，求值输入反推）：
 * - isQuotaConditionSatisfied（extensions/universal/provider-aggregation/src/router.ts:156-165）：
 *   member 无 quota 声明 → 满足；快照 undefined（数据未知）→ 满足（fail-open，D5）；
 *   快照已知 → snapshot.percent >= quota.thresholdPercent 判满足。
 * - 阈值取值反推：种子 percent=90 → threshold=100 时 90 < 100 = A 恒判耗尽（落选）；
 *   threshold=80 时 90 >= 80 = 条件恢复（命中 A）。与设计 V3 原文数值（100 → 80）一致。
 * - 新鲜度窗口（packages/shared/src/aggregation.ts:466-501）：AGGREGATION_QUOTA_FRESHNESS_MS
 *   = 600_000；lastFetchAt 近种子（剧本启动时刻）判新鲜；resetSec=null 不参与跨窗判定。
 * - quota-cache.json 形态（packages/runtime/src/services/quota-cache.ts:24-31）：
 *   { providers: { <providerId>: { data: { label, wins: [{pct, resetSec} × 3] }, lastFetchAt } } }。
 *
 * ⚠️ 机制状态（2026-11-07 亲读核实，写剧本时的分支 HEAD f94a0e2cd）：
 * - pi 扩展侧额度快照注入未实装：index.ts:268-270 的 M2 接线点 quotaByProviderId 恒为
 *   undefined（注释明示「M1 恒 undefined」）；扩展进程无任何 quota-cache.json 读点
 *   （全仓 grep quotaByProviderId 仅扩展自身两文件；isAggregationQuotaDataFresh 消费方
 *   仅 runtime 的 aggregation-quota-refresher.ts 触发点③「过期才刷」过滤——runtime 侧
 *   U4 编排只负责刷新数据落缓存，不参与路由求值）。
 * - 推论：当前分支上端点 A 的额度条件恒 fail-open 满足 → V3 步骤 3「命中 B」与探针
 *   「无可用端点错误」必失败（verdict=fail，机制缺失非环境问题）。本剧本按 V3 原判据
 *   实装、不弱化断言；M2 扩展侧接线落地后无需改剧本即可转绿。
 *
 * 装配：mock-http（createInstance llm 通道，模型 key 按端点拆演员）。命中判据 =
 * instance.mockLlm.requests 尾部（status 200）的 model 字段（pi 发往 HTTP 的 model 是裸
 * id，mock-http README 坑 1）+ 会话 JSONL 助手消息的物理模型记录（pi AssistantMessage.
 * model，C 通道磁盘证据）。路由写通道 = aggregation.saveRoute（runtime 唯一写点，
 * provider-extras-store RMW 原子写 → mtime 变化 → 扩展求值前重读）；白名单 =
 * config.setScopedModels（聚合复合串 aggregation/<routeId>）。
 *
 * 附加探针（额度求值参与性强判别）：全落选形态（A=quota100 + B=quota100）下发消息，
 * M2 接线正确时应得「当前无可用端点」结构化错误且逐端点列明「额度低于阈值」（index.ts
 * buildNoCandidateError）；fail-open 形态下会正常命中 A 出话。该探针区分「额度求值根本
 * 不参与」与「参与但阈值语义/切换时机错」两种失败形态，fail 归因不靠猜。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const ROUTE_ID = 'agg-quota-main'
const EP_A = 'q-a' // 额度条件端点物理模型
const EP_B = 'q-b' // 无条件兜底端点物理模型
const SEED_PERCENT = 90

// ── mock 演员：每端点独立 model（独立队列，游标 per-model 互不污染） ──────────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id，selectQueue 按裸段匹配；_note 被忽略',
  'mockllm/mock-1': [step('agg-quota-default-1'), step('agg-quota-default-2')],
  'mockllm/q-a': [step('agg-quota-ep-a-1'), step('agg-quota-ep-a-2'), step('agg-quota-ep-a-3'), step('agg-quota-ep-a-4')],
  'mockllm/q-b': [step('agg-quota-ep-b-1'), step('agg-quota-ep-b-2'), step('agg-quota-ep-b-3'), step('agg-quota-ep-b-4')],
}

export const meta = {
  id: 'agg-quota-condition',
  priority: 'P0',
  title: '额度条件路由全链：V3 额度耗尽自动切换（阈值 100 恒耗尽→命中兜底；改回 80 条件恢复→回到首选）+ 零手动动作 + mtime 下一请求生效',
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
    models: ['mock-1', 'mock-sub-a', 'q-a', 'q-b'],
  },
  estimateSec: 300,
  provable: [
    '种子链 C+B：quota-cache.json 按 QuotaCacheEntry 形态种子（percent=90，lastFetchAt=启动时刻新鲜窗内）→ quota.getCached 协议回执含种子数据（runtime 消费链读取口径互证）',
    '装配链 B+C：aggregation.saveRoute 落盘 providers.json routes 段（A 端点 type=quota + quota.thresholdPercent=100）+ config.setScopedModels 白名单含聚合复合串（B 回执 + C 落盘）+ getRouteView 卡片 scoped=true（B）',
    'V3 步骤 3 B+C：advanced 路由（A=quota 阈值 100 恒判耗尽，B=none 兜底），绑定路由的会话发消息命中兜底端点 q-b——mockLlm.requests 尾部 model=q-b（裸 id）+ 会话 JSONL 助手消息 model=q-b',
    '零手动动作 B：两次切换全程零 model.switch——getState.modelId 保持聚合引用（绑定不重选）',
    'V3 步骤 5-6 B+C：saveRoute 阈值改回 80 后零 sleep 立即发消息，命中回到首选端点 q-a（保存后第一请求即变化 = mtime 重读无等待窗）；会话 JSONL 物理模型序列 [q-b, q-a] 与切换叙事一致',
    '探针 B：全落选形态（A=quota100 + B=quota100）发消息应得「当前无可用端点」结构化错误且逐端点列明「额度低于阈值」（buildNoCandidateError）——额度求值参与性强判别',
    'C 终态：providers.json routes 段 ROUTE_ID 的 thresholdPercent=80（V3 终态）',
  ],
  notProvable: [
    'V3 步骤 1/5 的设置页 UI 编辑半边：设置页阈值编辑入口已实装（packages/ui/src/features/settings/provider/RouteEndpointRow.vue:91-101 data-testid=endpoint-quota-threshold），本剧本走协议写侧（saveRoute = B 通道唯一写点，agg-time-window 同款纪律）——UI 表单交互归 UI 剧本/手工验收',
    '设计 V3 原文「真实 zhipu 数据百分比恒小于 100」形态：mock-http 通道无真实 zhipu 凭证，用 quota-cache.json 种子（percent=90）构造——语义等价（percent ≥ threshold 判满足，router.ts:164），阈值数值与原文一致（100 → 80）',
    '浮层「额度数据 N 分钟前」标注（M2 波次另一交付面）：A 通道 UI 呈现，不在本剧本',
  ],
}

// ── 剧本 run ════════════════════════════════════════════════════════════════════
export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    '机制状态（2026-11-07 亲读）：pi 扩展额度快照注入未实装（index.ts:268-270 M2 接线点恒 undefined，全仓无 quota-cache.json → 路由求值读链）——额度条件恒 fail-open，V3 步骤 3「命中 B」与探针「无候选错误」在当前分支必失败；剧本按原判据实装不弱化，M2 扩展侧接线落地后可直接转绿',
    'mockllm 无 quota fetcher 配置：saveRoute 触发点①（notifyRoutesChanged → fetchMany）对 mockllm 返回 not_configured 失败态——不发请求、不写缓存、不删种子（quota-cache「失败不删除旧缓存」）',
    'quota-cache 内存镜像加载时机（quota-cache.ts:68-73）：镜像未加载时才读磁盘——种子在剧本第一步（任何 quota 读取前）写入；quota.getCached 首次调用触发磁盘加载使种子可见',
    'mock-http 游标 per-model（mock server 进程持有）：q-a/q-b 独立队列，队列步数按轮次预置，互不污染',
    'pi 发往 HTTP 的 model 是裸 id（mock-http README 坑 1）——mockLlm.requests[].model 断言用裸 id',
    'pi 对不在 enabledModels 的模型引用是自动追加不是拒绝——聚合引用无需预置 enabledModels',
    'session.getState 活会话分支读 replicated states 快照，快照 seed 与 session.create 回执之间存在竞态窗口（modelId 字段缺省）——绑定断言用条件轮询',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))

  // ══ 0. 种子 quota-cache.json（percent=90，lastFetchAt=启动时刻 → 600s 新鲜窗内） ══
  const seedAt = Date.now()
  const quotaCachePath = path.join(dataDir, 'quota-cache.json')
  const seedFile = {
    providers: {
      [PROVIDER]: {
        data: {
          label: 'verify-quota-seed',
          wins: [
            { pct: SEED_PERCENT, resetSec: null },
            { pct: SEED_PERCENT, resetSec: null },
            { pct: SEED_PERCENT, resetSec: null },
          ],
        },
        lastFetchAt: seedAt,
      },
    },
  }
  fs.writeFileSync(quotaCachePath, `${JSON.stringify(seedFile, null, 2)}\n`, 'utf8')
  ev.attach('quota-cache-seed', `written=${quotaCachePath} at=${new Date(seedAt).toISOString()} percent=${SEED_PERCENT}（percent ≥ threshold 判满足语义下：threshold=100 → A 恒耗尽；threshold=80 → A 恢复）`)
  // runtime 消费链互证（B）：quota.getCached 首次调用触发磁盘镜像加载，回执应含种子条目
  const cached = await protocol.call('quota.getCached', { providerId: PROVIDER }, { replyType: 'quota.getCached:result', timeoutMs: 60_000 })
  const seedVisible = cached?.data?.wins?.[0]?.pct === SEED_PERCENT && typeof cached?.lastFetchAt === 'number'
  ev.assert('B: quota.getCached 回执含种子条目（quota-cache.json 形态正确 + runtime 消费链读取口径互证）', seedVisible, {
    channel: 'B',
    expected: `data.wins[0].pct=${SEED_PERCENT} + lastFetchAt 为数值`,
    actual: `data=${JSON.stringify(cached?.data ?? null).slice(0, 200)} lastFetchAt=${cached?.lastFetchAt ?? '<none>'} reason=${cached?.reason ?? '<none>'}`,
  })
  ev.step({ step: 'seed.quota-cache', channel: 'C', exitCode: seedVisible ? 0 : 1, stats: { percent: SEED_PERCENT, lastFetchAt: seedAt } })

  // ── 前提：端点物理模型在 models.json（pi modelRegistry 物理段源，C） ─────────────
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const endpointsReady = [EP_A, EP_B].every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——路由端点物理模型全部在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: [EP_A, EP_B].join(','),
    actual: `in=${endpointIds.join(',').slice(0, 200)}`,
  })
  let seedScoped = []
  try {
    seedScoped = extras().scopedModels ?? []
  } catch {
    /* extras 缺席（非模板种子形态）——setScopedModels 以空基线起 */
  }
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady ? 0 : 1, stats: { seedScoped: seedScoped.length } })

  // ── 共用 helper ──────────────────────────────────────────────────────────────
  const member = (id, modelId, type, quota) => ({ id, providerId: PROVIDER, modelId, type, ...(quota ? { quota } : {}) })
  const routeOf = (mode, members) => ({ id: ROUTE_ID, name: ROUTE_ID, modelId: ROUTE_ID, enabled: true, mode, members, specials: [] })

  async function saveRoute(route, label) {
    const saved = await protocol.call('aggregation.saveRoute', { route }, { replyType: 'aggregation.routeSaved', timeoutMs: 60_000 })
    ev.assert(`B: aggregation.saveRoute ${label} 回执（routeSaved）`, saved?.route?.id === ROUTE_ID, {
      channel: 'B',
      expected: `route.id=${ROUTE_ID}`,
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
   * 返回 { end, tail, hitAt }；hitAt = mock server 收到请求的时刻（mtime 无等待窗证据用）。
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
   * session.create 回执之间存在竞态窗口；按技能等待纪律条件轮询，不盲等）。
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

  // ══ 1. 装配路由（V3 步骤 1-2：A=quota 阈值 100 恒判耗尽，B=none 兜底） ══════════
  const routeV1 = routeOf('advanced', [member('ep-a', EP_A, 'quota', { thresholdPercent: 100 }), member('ep-b', EP_B, 'none')])
  await saveRoute(routeV1, 'v1（A=quota100, B=none）')
  const routesOnDisk1 = extras().routes?.routes ?? []
  const r1OnDisk = routesOnDisk1.find((r) => r.id === ROUTE_ID)
  ev.assert('C: R1 落盘 providers.json routes 段（A 端点 type=quota + thresholdPercent=100）', r1OnDisk?.members?.[0]?.type === 'quota' && r1OnDisk?.members?.[0]?.quota?.thresholdPercent === 100, {
    channel: 'C',
    expected: `routes 含 ${ROUTE_ID} 且 members[0]={type:quota, quota.thresholdPercent:100}`,
    actual: `routeIds=${routesOnDisk1.map((r) => r.id).join(',')} m0=${JSON.stringify(r1OnDisk?.members?.[0] ?? null).slice(0, 200)}`,
  })
  ev.attach('extras-after-r1-save', JSON.stringify({ routes: routesOnDisk1, scopedModels: extras().scopedModels ?? null }, null, 2).slice(0, 8_000))

  // scopedModels 白名单（读现状追加，setScopedModels 全量替换语义）
  const scoped1 = await protocol.call(
    'config.setScopedModels',
    { models: [...seedScoped, `${AGG}/${ROUTE_ID}`] },
    { replyType: 'config.scopedModels', timeoutMs: 60_000 },
  )
  ev.assert('B+C: setScopedModels 回执白名单含聚合复合串', (scoped1?.scopedModels ?? []).includes(`${AGG}/${ROUTE_ID}`), {
    channel: 'B',
    expected: `${AGG}/${ROUTE_ID} 在回执 scopedModels`,
    actual: `scoped=${JSON.stringify(scoped1?.scopedModels ?? null).slice(0, 200)}`,
  })
  const scopedOnDisk = extras().scopedModels ?? []
  ev.assert('C: scopedModels 落盘含聚合复合串', scopedOnDisk.includes(`${AGG}/${ROUTE_ID}`), {
    channel: 'C',
    expected: `${AGG}/${ROUTE_ID} 在 providers.json scopedModels`,
    actual: JSON.stringify(scopedOnDisk).slice(0, 200),
  })

  // 选择器可见性：白名单加入后 model.list 应出现聚合条目（条件轮询——D4 磁盘即时派生）
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
    expected: `model.list 含 providerId=aggregation / id=${ROUTE_ID}`,
    actual: aggListActual,
  })

  const view1 = await protocol.call('aggregation.getRouteView', {}, { replyType: 'aggregation.routeView', timeoutMs: 60_000 })
  const card1 = (view1.cards ?? []).find((c) => c.route?.id === ROUTE_ID)
  ev.assert('B: getRouteView 卡片 scoped=true（选择器可见性 join 视图）', card1?.scoped === true, {
    channel: 'B',
    expected: `${ROUTE_ID} 卡 scoped=true`,
    actual: `cards=${(view1.cards ?? []).map((c) => `${c.route?.id}:${c.scoped}`).join(',')}`,
  })
  ev.step({ step: 'setup.route', channel: 'B', exitCode: card1?.scoped === true ? 0 : 1, stats: {} })

  // ══ 2. V3 步骤 3：A 恒判耗尽（percent 90 < 阈值 100）→ 发消息命中兜底 q-b ══════
  const routeRef = `${AGG}/${ROUTE_ID}`
  const sid = await createBoundSession(routeRef, 'agg-quota-v3-session')
  const sessionFile = await sessionFileOf(sid)
  ev.assert('C: 会话文件定位（config.sessions summary.sessionFile 非空）', Boolean(sessionFile), {
    channel: 'C',
    expected: 'sessionFile 非空（首条消息 flush 前允许文件未创建）',
    actual: sessionFile || '<summary 未带 sessionFile>',
  })
  const v3a = await sendTurn(sid, 'V3 额度耗尽：端点 A 剩余额度 90 低于阈值 100，应切换到兜底端点 q-b', EP_B, 'V3 步骤 3（额度触发切换）', { sessionFile, expectAssistantCount: 1 })
  ev.step({ step: 'v3.quota-fallback', channel: 'C', exitCode: v3a.tail?.model === EP_B ? 0 : 1, stats: { model: v3a.tail?.model, expected: EP_B } })

  // ══ 3. 零手动动作：getState 绑定保持聚合引用（全程零 model.switch） ═══════════
  const stateAfterA = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
  ev.assert('B: 切换零手动动作——绑定保持聚合引用（无 model.switch、无需重选模型）', stateAfterA?.modelId === routeRef, {
    channel: 'B',
    expected: `getState.modelId=${routeRef}（物理模型切换由路由求值完成）`,
    actual: `modelId=${stateAfterA?.modelId}`,
  })

  // ══ 4. V3 步骤 5-6：阈值改回 80（90 ≥ 80 条件恢复）→ 立即发消息回到 q-a ═══════
  const tSaveV2 = Date.now()
  await saveRoute(routeOf('advanced', [member('ep-a', EP_A, 'quota', { thresholdPercent: 80 }), member('ep-b', EP_B, 'none')]), 'v2（阈值改回 80）')
  const v3b = await sendTurn(sid, 'V3 条件恢复：阈值改回 80，剩余额度 90 达标，应回到首选端点 q-a（无手动切换）', EP_A, 'V3 步骤 6（条件恢复回落）', { sessionFile, expectAssistantCount: 2 })
  const stateAfterB = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
  ev.assert('B: V3 第二次切换同样零手动动作——绑定保持聚合引用', stateAfterB?.modelId === routeRef, {
    channel: 'B',
    expected: `getState.modelId=${routeRef}`,
    actual: `modelId=${stateAfterB?.modelId}`,
  })
  ev.attach('v3.no-wait-window', `saveRoute(阈值 80) 落盘时刻≈${new Date(tSaveV2).toISOString()}；本轮 mock 请求到达时刻=${new Date(v3b.hitAt).toISOString()}；间隔=${v3b.hitAt - tSaveV2}ms——保存与发消息之间零 sleep、零定时器，命中变化发生在保存后第一请求（mtime 重读 D1 形态）`)
  const seqOk = (() => {
    try {
      const raw = fs.readFileSync(sessionFile, 'utf8')
      const entries = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          const m = obj?.message ?? obj
          if (m?.role === 'assistant' && typeof m?.model === 'string') entries.push(m.model)
        } catch { /* 非 JSON 行跳过 */ }
      }
      return entries
    } catch {
      return []
    }
  })()
  ev.assert('C: V3 切换叙事完整——JSONL 物理模型序列 = [q-b, q-a]（B 兜底 → 回到 A）', seqOk[0] === EP_B && seqOk[1] === EP_A, {
    channel: 'C',
    expected: `[${EP_B}, ${EP_A}]`,
    actual: `models=${JSON.stringify(seqOk)}`,
  })
  ev.step({ step: 'v3.recover-preferred', channel: 'C', exitCode: v3b.tail?.model === EP_A ? 0 : 1, stats: { model: v3b.tail?.model, expected: EP_A } })

  // ══ 5. C 终态核对：providers.json routes 段 thresholdPercent=80（V3 终态） ════
  const finalRoutes = extras().routes?.routes ?? []
  const fR1 = finalRoutes.find((r) => r.id === ROUTE_ID)
  const finalOk = fR1?.mode === 'advanced' && fR1?.members?.[0]?.quota?.thresholdPercent === 80 && fR1?.members?.[1]?.type === 'none'
  ev.assert('C: 终态 routes 段 thresholdPercent=80 + B=none（V3 终态）', finalOk, {
    channel: 'C',
    expected: `members[0].quota.thresholdPercent=80, members[1].type=none`,
    actual: `m0=${JSON.stringify(fR1?.members?.[0] ?? null).slice(0, 200)} m1Type=${fR1?.members?.[1]?.type}`,
  })
  ev.step({ step: 'final-state', channel: 'C', exitCode: finalOk ? 0 : 1, stats: {} })

  // ══ 6. 附加探针：全落选形态（A=quota100 + B=quota100）→ 结构化「无可用端点」错误 ══
  // 判别「额度求值根本不参与」（fail-open 命中 A 出话 → 本断言失败）与「参与但语义错」。
  await saveRoute(routeOf('advanced', [member('ep-a', EP_A, 'quota', { thresholdPercent: 100 }), member('ep-b', EP_B, 'quota', { thresholdPercent: 100 })]), '探针（A+B 均 quota100 全落选形态）')
  const sinceP = protocol.events.length
  await protocol.send(sid, 'V3 探针：两端点额度均低于阈值，应得无可用端点结构化错误')
  const endP = await protocol.waitTurnEnd(sid, { since: sinceP, timeoutMs: 180_000 })
  // 错误文案双收集面：turn 结束事件 payload + history 尾部消息文本（route throw 的
  // 呈现形态在事件与 history 两侧都可能承载，防单一收集面漏文案）
  const errText = JSON.stringify(endP.payload ?? {})
  let historyTailText = ''
  try {
    const hist = await protocol.history(sid, { limitTurns: 2 })
    historyTailText = JSON.stringify((hist?.turns ?? hist?.messages ?? hist ?? []).slice?.(-4) ?? hist ?? null)
  } catch {
    historyTailText = '<history 读取失败>'
  }
  const combinedText = `${errText}\n${historyTailText}`
  const noCandidateOk = !endP.ok && combinedText.includes('无可用端点') && combinedText.includes('额度低于阈值')
  ev.assert('B: 探针——全落选形态应得「无可用端点」结构化错误且逐端点列明「额度低于阈值」（额度求值参与性判别）', noCandidateOk, {
    channel: 'B',
    expected: 'turn 以错误结束 + 错误文案（事件 payload 或 history 尾部）含「无可用端点」与「额度低于阈值」',
    actual: `type=${endP.type} ok=${endP.ok} tailModel=${tailRequest()?.model ?? '<none>'} payload=${errText.slice(0, 300)} historyTail=${historyTailText.slice(0, 300)}`,
  })
  ev.step({ step: 'probe.no-candidate', channel: 'B', exitCode: noCandidateOk ? 0 : 1, stats: { type: endP.type, ok: endP.ok } })

  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))
  ev.attach('extras-final-probe', JSON.stringify(extras(), null, 2).slice(0, 12_000))

  log(`agg-quota-condition done sid=${sid} hits=${[v3a.tail?.model, v3b.tail?.model].join('->')} probe=${endP.type}`)
  return { uncovered, gotchas }
}
