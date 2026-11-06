/**
 * agg-zero-config —— V8 零配置回归（反向）（provider-aggregation 设计 §4.1 V8，M1 交付面）。
 *
 * 判据原文（设计文档 V8 行）：「1. 确认路由配置为空（extras 文件无 routes 键或 routes 数组
 * 为空）→ 2. 检查模型选择器内容 → 3. 检查既有会话（物理模型绑定）对话、切换、默认模型行为；
 * 选择器无路由条目、无路由分组残留；既有物理模型的全部行为与升级前一致（切换、回执、错误
 * 分型零变化）；无任何配置轮询定时器与额度刷新定时器——路由是纯增量，未绑定时零行为」。
 *
 * 装配：faux 常规装配（seed-faux 预置，零 token）。faux 装配先建数据目录（seed-faux 写
 * settings.json 等），ensureInstanceDir 见目录已存在即跳过模板复制（dev-instance-lib.mjs
 * ensureInstanceDir 的 exists 短路）——实例是纯 faux 环境，extras 文件（agent/config/
 * providers.json）缺席。absent 是 V8 判据「无 routes 配置」的合法形态（设计 V8 原文
 * 「extras 文件无 routes 键或 routes 数组为空」的彻底形态；config-store.ts:40 absent
 * 是设计内合法态），剧本按三态判定（absent / 无 routes 键 / routes 空数组）。
 * 既有物理模型代理 = faux 演员模型（extension 注册的物理目录条目；模板种子真实凭据
 * 模型需真实计费，live 通道不进验收纪律，见 notProvable）。
 *
 * 路径（V8 三步 + 定时器判定）：
 *   ① C：agent/config/providers.json 三态零配置判定（absent / 无 routes 键 / routes 空）；
 *   ② B：config.getProviders 无保留 id 'aggregation'（AGGREGATION_PROVIDER_ID，
 *      packages/shared/src/aggregation.ts:22）+ model.list 无 aggregation 标记条目
 *      （ModelInfo.aggregation，packages/shared/src/provider.ts:259——选择器分组判别键）
 *      + aggregation.getRouteView cards/orphanRefs 双空（route-orchestration.ts:59：
 *      cards = routes 定义全集，零配置即空）+ A：弹层无 route-badge / 无「模型路由」组标题；
 *   ③ B+C：session.create → session.getState 权威读默认绑定 faux/faux-1（W2 通道；
 *      session.created 的 SessionSummary 契约无 modelId 字段）→ 一轮 faux 对话完成 →
 *      model.switch 到 faux-1-reasoning（回执生效值 + state 快照收敛 + JSONL model_change）→
 *      切换后一轮正常 → 不存在模型收 MODEL_NOT_FOUND（错误分型）→ 切回 faux-1；
 *   ④ C：runtime 日志 + pi 日志聚合域无周期性运行痕迹（装载枚举行除外——pi spawn 命令行的
 *      --extension builtin:provider-aggregation 枚举不是轮询痕迹）+ 源码层证据：聚合实现源码
 *      零定时器 API 实码（扩展 src/* + aggregation-quota-refresher.ts，ADR-0190 红线）+
 *      B：全程 events 无 aggregation.* 帧 + C：extras 终态与初始态同态（操作零写路由域）。
 *
 * Gotcha（model.md model.live-sync / D3 模块头注释）：provider-live-sync 是升级前既有
 * 的 2s 轮询扩展（目录热刷新），不属于 V8 判定域——定时器断言限定「本功能引入的配置
 * 轮询/额度刷新定时器」，按聚合域关键词检索，不做全进程零定时器断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const AGG_PROVIDER_ID = 'aggregation'
const AGG_GROUP_TITLE = '模型路由'

/** 聚合域日志检索关键词（大小写不敏感）：扩展 id / runtime 服务标识 / UI 组标题。 */
const AGG_LOG_KEYWORDS = ['aggregation', 'provider-aggregation', 'aggregation-quota', '模型路由']

/** 定时器痕迹检索 pattern（日志检索）：命中行逐条人工可读地 attach，断言只判聚合标识。 */
const TIMER_LOG_PATTERN = 'interval|poll|watch|timer'

/** 源码检索文件集（相对 worktree 根）：扩展 + runtime 额度刷新编排（设计 D1/D3 落点）。 */
const AGG_SOURCE_FILES = [
  'extensions/universal/provider-aggregation/src/index.ts',
  'extensions/universal/provider-aggregation/src/config-store.ts',
  'extensions/universal/provider-aggregation/src/router.ts',
  'packages/runtime/src/services/aggregation-quota-refresher.ts',
]
/** 源码检索定时器 API pattern（实码判定排除注释行）。 */
const TIMER_CODE_PATTERN = 'setInterval|setTimeout|fs\\.watch|watchFile|chokidar'

export const meta = {
  id: 'agg-zero-config',
  priority: 'P0',
  title: 'V8 零配置回归（反向）：无 routes 配置下选择器零路由痕迹 + 既有物理模型行为零变化 + 零轮询定时器',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'model.list', 'model.switch',
    'session.create', 'chat.send', 'chat.wait',
    'settings.provider',
  ],
  requires: ['faux'],
  estimateSec: 180,
  // 统一数组队列（非 model-keyed）：热切模型不重选队（faux-llm-ext.ts selfModelRef
  // argv 一次定型），切换前后两轮按同一队列顺序消费。
  faux: {
    responses: [
      { text: 'agg-zero-alpha-before-switch', stopReason: 'stop' },
      { text: 'agg-zero-beta-after-switch', stopReason: 'stop' },
    ],
  },
  provable: [
    'C：零配置前提成立——extras 文件三态判定（absent / 无 routes 键 / routes 空数组；faux 装配实例无模板种子，absent 是 V8 原文「无 routes 配置」的合法形态）',
    'B：config.getProviders 无保留 id "aggregation" 条目（选择器路由分组的唯一数据源缺席）',
    'B：model.list 全部条目 aggregation!==true 且 providerId!=="aggregation"，faux 物理模型目录正常在列（无路由条目）',
    'B：aggregation.getRouteView cards 与 orphanRefs 双空（路由页 join 视图零残留）',
    'A：模型弹层 model-picker-route-badge 零命中且无"模型路由"分组标题、faux 行可见（选择器 UI 无分组残留）',
    'B+C：默认模型行为——session.getState 权威读 modelId=faux/faux-1（W2 通道）；对话行为——一轮 message.complete + history 含脚本文本',
    'B+C：切换行为——model.switch 回执生效值 faux-1-reasoning + state 快照收敛 + 会话 JSONL model_change entry；切换后一轮正常完成',
    'B：错误分型零变化——不存在模型切换收 MODEL_NOT_FOUND 且会话不坏；切回 faux-1 成功（来回切换目录稳定）',
    'C：runtime 日志与 pi 日志聚合域无周期性运行痕迹（装载枚举行除外）；interval/poll/watch 命中行无聚合标识（V8 定时器判定域 = 本功能引入的配置轮询/额度刷新定时器）',
    'C（源码层）：聚合实现源码（扩展 src/* + aggregation-quota-refresher.ts）零定时器 API 实码（注释除外）',
    'B+C：全程 protocol.events 无 aggregation.* 帧；收尾时 extras 与初始态同态（absent/无 routes 不变——既有操作零写路由域）',
  ],
  notProvable: [
    '「与升级前一致」的双实例对拍：本剧本只有升级后（feat-provider-routing）单实例，零变化以行为契约本身为判据（对话完成/切换回执/默认绑定/错误分型四项），不构造 main 分支对照实例',
    '真实凭据物理模型（模板种子 zai-coding-cn / xiaomi-token-plan-cn）的真实对话冒烟：需真实计费通道（live 不进验收纪律），以 faux 物理模型为行为代理；faux 装配实例无模板种子（ensureInstanceDir exists 短路），模板种子形态的 extras（providers/scopedModels/version、无 routes）由 init-template 重建路径覆盖，不在本剧本范围',
    'route 求值路径本身：零配置下无路由条目可选、无绑定即无求值（设计 D1 ④「未绑定路由的会话不发生 route 求值」），求值行为归 V1/V5 正向剧本',
    'pi 进程内非聚合功能的定时器全量清点：V8 判定域按设计原文限定「本功能的配置轮询/额度刷新定时器」，非全进程零定时器证明',
  ],
}

/** 从 config.sessions reply 里找 session summary（含 sessionFile 路径）。 */
function findSummary(listReply, sid) {
  for (const g of listReply.groups ?? []) {
    for (const s of g.sessions ?? []) {
      if (s.id === sid) return s
    }
  }
  return null
}

/** 读文件按行检索 needle，返回命中行（截断防膨胀）。 */
function grepFileLines(text, needle, { lineCap = 400, maxLines = 40 } = {}) {
  const hits = []
  for (const line of String(text).split('\n')) {
    if (line.includes(needle)) hits.push(line.length > lineCap ? `${line.slice(0, lineCap)}…[truncated]` : line)
    if (hits.length >= maxLines) break
  }
  return hits
}

/**
 * 条件轮询重订阅 stateSnapshot，直到 state_changed 条目满足谓词（或超时返回最后值）。
 * 不等广播帧：switch 回执后 state_changed 增量帧实测不可靠（model.md Gotcha 6），
 * 重订阅读快照是确定性收敛路径；发布链有 300ms 防抖，立即读会拿旧值。
 */
async function pollStateSnapshotEntry(protocol, sid, predicate, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let entry = null
  while (Date.now() < deadline) {
    const sub = await protocol.call('session.subscribe', { sessionId: sid }, {})
    entry = (sub.stateSnapshot ?? []).find((s) => s?.type === 'session.state_changed') ?? null
    if (entry && predicate(entry)) return entry
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return entry
}

/** 判定一行源码是否注释行（源码检索排除用）。 */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')
}

/**
 * 聚合关键词命中行分类（V8 定时器判定域修正）：
 * - 装载枚举行 = pi spawn 命令行（--extension builtin:provider-aggregation）与扩展清单
 *   日志（resolved N extensions）——一次性枚举痕迹，非轮询定时器痕迹；
 * - 运行行 = 其余命中（扩展自身日志 / refresher warn / route 求值日志等）——聚合域的
 *   运行期痕迹。轮询定时器若存在必然产生周期性运行行（2s 周期在分钟级窗口内 ≥ 数十条）。
 */
function isLoadEnumerationLine(line) {
  return line.includes('spawning pi') || line.includes('--extension') || /resolved \d+ extensions/.test(line)
}

/** 同一规范化消息的出现次数（周期性检测：≥3 次同文重复 = 周期痕迹嫌疑）。 */
function periodicLineSuspects(lines, threshold = 3) {
  const counts = new Map()
  for (const line of lines) {
    // 规范化：剥时间戳前缀，保留消息主体
    const norm = line.replace(/^\[[^\]]*\]\s*/, '').trim()
    counts.set(norm, (counts.get(norm) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n >= threshold).map(([msg, n]) => `${n}x ${msg.slice(0, 200)}`)
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'faux 装配实例无模板种子：ensureFaux 先建数据目录，ensureInstanceDir（dev-instance-lib.mjs）见目录已存在即跳过模板复制——extras 文件（agent/config/providers.json）缺席，absent 是 V8「无 routes 配置」的合法形态（config-store.ts:40 设计内合法态）；模板种子形态（providers/scopedModels/version、无 routes 键）不在此环境覆盖',
    '选择器分组判别键 = ModelInfo.aggregation 标记字段（provider.ts:259），「无分组残留」的目录真值 = getProviders 无 aggregation 条目 + model.list 无 aggregation 标记条目',
    'session.created 的 SessionSummary 契约无 modelId 字段——默认/切换生效值的权威读取通道 = session.getState（W2，活会话读实例快照）',
    'runtime 日志的聚合关键词命中行多为 pi spawn 命令行的 --extension builtin:provider-aggregation 装载枚举——定时器判定按「周期性运行行」分类，不做关键词字面零命中断言',
    'provider-live-sync 的 2s 轮询是升级前既有机制（目录热刷新），不在 V8 定时器判定域；判定按聚合域关键词检索，不做全进程零定时器断言',
    'faux 统一数组队列：热切模型不重选队（argv 一次定型），切换前后两轮按同队顺序消费',
  ]
  const { readRuntimeLogs, readPiLogs } = await import('../scripts/lib/instance.mjs')

  // ══ V8 步骤 1：确认路由配置为空（C 通道前提） ══════════════════════
  // 三态零配置判定：absent（faux 装配实例无模板种子）/ 无 routes 键 / routes 空数组。
  // absent 是设计内合法态（config-store.ts:40：「absent 是合法态（无 routes 域的既有
  // 环境/原生 pi 用户），不是失败」）。
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  let extrasRaw = ''
  let extrasJson = null
  let extrasExists = false
  try {
    extrasRaw = fs.readFileSync(extrasPath, 'utf8')
    extrasJson = JSON.parse(extrasRaw)
    extrasExists = true
  } catch (e) {
    extrasExists = fs.existsSync(extrasPath)
    /* 不可读（坏 JSON）与不存在（absent）在下方断言分述 */
    if (extrasExists) ev.attach('extras-read-error', String(e?.message ?? e).slice(0, 300))
  }
  const routesSectionEmpty = extrasJson !== null
    && (extrasJson.routes === undefined
      || (Array.isArray(extrasJson.routes?.routes) && extrasJson.routes.routes.length === 0))
  const zeroConfig = !extrasExists || routesSectionEmpty
  ev.assert('C: 零配置前提——extras 文件 absent 或无 routes 键（或 routes 空数组）', zeroConfig, {
    channel: 'C',
    expected: `${extrasPath} 三态之一：absent / 顶层无 routes 键 / routes 空数组`,
    actual: !extrasExists
      ? 'absent（faux 装配实例无模板种子——ensureFaux 先建目录，ensureInstanceDir exists 短路跳过模板复制）'
      : extrasJson === null
        ? `文件存在但不可解析: ${extrasRaw.slice(0, 120) || '(empty)'}`
        : `topKeys=${Object.keys(extrasJson).join(',')} routesSectionEmpty=${routesSectionEmpty}`,
  })
  if (extrasExists) ev.attach('extras-providers-json', extrasRaw.slice(0, 8_000))
  else ev.attach('extras-providers-json', `(absent) ${extrasPath} 不存在——faux 装配纯环境，模板种子未复制`)
  ev.step({ step: 'v8.premise.routes-absent', channel: 'C', exitCode: zeroConfig ? 0 : 1, stats: { extrasPath, absent: !extrasExists } })

  // ══ V8 步骤 2：模型选择器无路由条目、无分组残留 ═══════════════════
  // B① provider 目录：保留 id 零条目（provider-config-helper.ts:545-548 零配置跳过注入）
  const provs = await protocol.call('config.getProviders', {}, { timeoutMs: 60_000 })
  const provList = provs.providers ?? []
  const provIds = provList.map((p) => p.id ?? p.providerId)
  const aggProviderHit = provList.filter((p) => (p.id ?? p.providerId) === AGG_PROVIDER_ID || p.name === AGG_GROUP_TITLE)
  ev.assert(`B: config.getProviders 无保留 id "${AGG_PROVIDER_ID}"（无路由分组源）`, aggProviderHit.length === 0, {
    channel: 'B',
    expected: `providers 无 id=${AGG_PROVIDER_ID} 且无 name=${AGG_GROUP_TITLE} 的条目`,
    actual: `ids=${provIds.join(',').slice(0, 300)} hits=${aggProviderHit.length}`,
  })
  ev.step({ step: 'v8.providers.no-agg', channel: 'B', exitCode: aggProviderHit.length === 0 ? 0 : 1, stats: { count: provList.length } })

  // B② model.list：无 aggregation 标记条目 + 既有 faux 目录正常
  const listReply = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
  const models = listReply.models ?? []
  const aggModels = models.filter((m) => m.aggregation === true || m.providerId === AGG_PROVIDER_ID)
  const fauxIds = models.filter((m) => m.providerId === 'faux').map((m) => m.id)
  ev.assert('B: model.list 无路由条目（aggregation 标记与聚合 providerId 双零）', aggModels.length === 0, {
    channel: 'B',
    expected: '全部条目 aggregation!==true 且 providerId!=="aggregation"',
    actual: `count=${models.length} aggHits=${aggModels.length} ids=${models.map((m) => m.id).join(',').slice(0, 300)}`,
  })
  ev.assert('B: 既有 faux 物理模型目录正常（4 演员在列）', fauxIds.includes('faux-1') && fauxIds.includes('faux-1-reasoning'), {
    channel: 'B',
    expected: 'faux-1 与 faux-1-reasoning 在列（既有目录未受影响）',
    actual: `fauxIds=${fauxIds.join(',')}`,
  })
  ev.attach('model-list', JSON.stringify(models, null, 2).slice(0, 16_000))
  ev.step({ step: 'v8.model-list.no-agg', channel: 'B', exitCode: aggModels.length === 0 ? 0 : 1, stats: { count: models.length } })

  // B③ 路由页 join 视图：cards/orphanRefs 双空（route-orchestration.ts cards = routes 全集）
  let view = null
  try {
    view = await protocol.call('aggregation.getRouteView', {}, { replyType: 'aggregation.routeView', timeoutMs: 60_000 })
  } catch (e) {
    ev.assert('B: aggregation.getRouteView 可达（reply=aggregation.routeView）', false, {
      channel: 'B',
      expected: 'aggregation.routeView 载荷',
      actual: String(e?.message ?? e).slice(0, 300),
    })
  }
  if (view) {
    const viewClean = Array.isArray(view.cards) && view.cards.length === 0
      && Array.isArray(view.orphanRefs) && view.orphanRefs.length === 0
    ev.assert('B: 路由页 join 视图零残留（cards 与 orphanRefs 双空）', viewClean, {
      channel: 'B',
      expected: 'cards=[] orphanRefs=[]（零配置：无路由卡、无失效聚合引用）',
      actual: `cards=${(view.cards ?? []).length} orphanRefs=${JSON.stringify(view.orphanRefs ?? null).slice(0, 200)} corrupted=${String(view.corrupted ?? false)}`,
    })
    ev.attach('route-view', JSON.stringify(view, null, 2).slice(0, 8_000))
    ev.step({ step: 'v8.route-view.empty', channel: 'B', exitCode: viewClean ? 0 : 1, stats: {} })
  }

  // 初始窗口 events：无 aggregation.* 帧
  const aggFrameTypes = () => [...new Set(protocol.events.map((e) => e.type))].filter((t) => t.startsWith('aggregation.'))
  ev.assert('B: 初始窗口 events 无 aggregation.* 帧', aggFrameTypes().length === 0, {
    channel: 'B',
    expected: '无 aggregation.* 广播/推送帧',
    actual: `frames=${aggFrameTypes().join(',') || 'none'} total=${protocol.events.length}`,
  })

  // A：模型弹层——route-badge 零命中 + 无「模型路由」组标题 + faux 行可见（弹层工作正常对照）
  try {
    const ui = ctx.ui
    await ui.click('css=[title="切换模型"]')
    await ui.expectVisible('testid=model-picker-item-faux-1')
    await ui.expectCount('testid=model-picker-route-badge', 0)
    const listHtml = await ui.html('testid=model-picker-list')
    const groupHit = listHtml.includes(AGG_GROUP_TITLE)
    ev.assert(`A: 模型弹层无路由徽标且无"${AGG_GROUP_TITLE}"分组标题`, !groupHit, {
      channel: 'A',
      expected: `model-picker-route-badge count=0 且列表无"${AGG_GROUP_TITLE}"文本`,
      actual: `badge=0 groupTitleHit=${groupHit}`,
    })
    await ev.shot(await instance.page(), 'model-picker-zero-config')
    await ui.press('Escape')
    ev.step({ step: 'v8.picker.A', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    ev.assert('A: 模型弹层零配置断言', false, {
      channel: 'A',
      expected: '弹层打开、faux 行可见、route-badge 零命中、无路由组标题',
      actual: String(e?.message ?? e).slice(0, 400),
    })
    ev.attach('model-picker-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 16_000))
    try {
      await ev.shot(await instance.page(), 'model-picker-fail')
    } catch {
      /* 页面不可用时放弃截图 */
    }
    ev.step({ step: 'v8.picker.A', channel: 'A', exitCode: 1, stats: {} })
  }

  // ══ V8 步骤 3：既有物理模型行为零变化（faux 物理模型代理） ════════
  // ③-1 默认模型行为：session.create（无 override）→ session.getState 权威读绑定模型
  // （W2 通道；session.created 的 SessionSummary 契约无 modelId 字段——session/shared
  // session.ts:41 起，权威读取走 session.getState { sessionId } → { modelId?, thinkingLevel? }）。
  const created = await protocol.call('session.create', { cwd: repo, label: 'agg-zero-config' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  const state0 = sid ? await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 }) : null
  ev.assert('B: 默认模型行为——session.getState 权威读默认绑定 faux/faux-1', state0?.modelId === 'faux/faux-1', {
    channel: 'B',
    expected: 'modelId=faux/faux-1（无 override 默认绑定，零变化）',
    actual: `sid=${sid} state=${JSON.stringify({ modelId: state0?.modelId ?? null, thinkingLevel: state0?.thinkingLevel ?? null })}`,
  })
  await protocol.subscribe(sid)

  // ③-2 对话行为：一轮 faux 对话正常完成
  const since1 = protocol.events.length
  await protocol.send(sid, 'V8 零配置回归：切换前基线消息')
  const end1 = await protocol.waitTurnEnd(sid, { since: since1, timeoutMs: 180_000 })
  ev.assert('B: 对话行为——切换前轮 message.complete 正常完成', end1.type === 'message.complete' && end1.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${end1.type} stopReason=${end1.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'v8.chat.before-switch', channel: 'B', exitCode: end1.ok ? 0 : 1, stats: {} })
  const hist1 = await protocol.history(sid, { limitTurns: 10 })
  const texts1 = (hist1.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.content).join(' | ')
  ev.assert('B: history 含 faux 演员脚本文本（对话链路完整）', texts1.includes('agg-zero-alpha-before-switch'), {
    channel: 'B',
    expected: '含 agg-zero-alpha-before-switch',
    actual: texts1.slice(0, 300),
  })

  // ③-3 切换行为：model.switch → 回执生效值 + state 快照收敛 + C：JSONL model_change
  const switched = await protocol.call(
    'model.switch',
    { sessionId: sid, provider: 'faux', modelId: 'faux-1-reasoning' },
    { replyType: 'model.switched', timeoutMs: 120_000 },
  )
  ev.assert('B: 切换行为——model.switched 回执生效值 = faux-1-reasoning', switched.provider === 'faux' && switched.modelId === 'faux-1-reasoning', {
    channel: 'B',
    expected: '{provider:"faux", modelId:"faux-1-reasoning"}（值 = pi 实际生效模型）',
    actual: JSON.stringify({ provider: switched.provider, modelId: switched.modelId }),
  })
  const stateEntry = await pollStateSnapshotEntry(protocol, sid, (e) => e.payload?.modelId === 'faux/faux-1-reasoning')
  ev.assert('B: state 快照收敛为 faux/faux-1-reasoning（生效值二次核验）', stateEntry?.payload?.modelId === 'faux/faux-1-reasoning', {
    channel: 'B',
    expected: 'state_changed.payload.modelId = faux/faux-1-reasoning（重订阅读快照，防抖后收敛）',
    actual: JSON.stringify(stateEntry?.payload ?? null).slice(0, 300),
  })
  // 权威读复核（W2 同一入口）：活会话实例快照的 modelId 与回执一致
  const state1 = await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 })
  ev.assert('B: session.getState 权威读复核切换生效值', state1?.modelId === 'faux/faux-1-reasoning', {
    channel: 'B',
    expected: 'getState.modelId = faux/faux-1-reasoning（活会话实例快照）',
    actual: JSON.stringify({ modelId: state1?.modelId ?? null, thinkingLevel: state1?.thinkingLevel ?? null }),
  })
  ev.step({ step: 'v8.model-switch', channel: 'B', exitCode: 0, stats: { modelId: switched.modelId } })

  const listNow = await protocol.call('config.sessions', {})
  const summary = findSummary(listNow, sid)
  const sessionFile = summary?.sessionFile ?? ''
  if (sessionFile && fs.existsSync(sessionFile)) {
    const raw = fs.readFileSync(sessionFile, 'utf8')
    const changeHits = grepFileLines(raw, '"type":"model_change"')
    ev.assert('C: 会话 JSONL 追加 model_change 且含 faux-1-reasoning（持久层零变化）', changeHits.some((h) => h.includes('faux-1-reasoning')), {
      channel: 'C',
      expected: `model_change entry 含 faux-1-reasoning（${path.basename(sessionFile)}）`,
      actual: `hits=${changeHits.length}`,
    })
    ev.attach('model-change-lines', changeHits.join('\n') || '(无命中)')
  } else {
    ev.assert('C: 会话 JSONL 可得（config.sessions summary.sessionFile）', false, {
      channel: 'C',
      expected: 'sessionFile 在盘',
      actual: `sessionFile=${sessionFile || '<summary 未带>'}`,
    })
  }

  // ③-4 切换后一轮：热切不破坏对话
  const since2 = protocol.events.length
  await protocol.send(sid, 'V8 零配置回归：切换后验证消息')
  const end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 180_000 })
  ev.assert('B: 切换后轮正常完成（热切不破坏对话）', end2.type === 'message.complete' && end2.ok, {
    channel: 'B',
    expected: 'message.complete 非 error',
    actual: `${end2.type} stopReason=${end2.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'v8.chat.after-switch', channel: 'B', exitCode: end2.ok ? 0 : 1, stats: {} })

  // ③-5 错误分型零变化：不存在模型 → MODEL_NOT_FOUND，会话不坏
  let failMsg = ''
  try {
    await protocol.call(
      'model.switch',
      { sessionId: sid, provider: 'faux', modelId: 'faux-nope' },
      { replyType: 'model.switched', timeoutMs: 60_000 },
    )
    failMsg = '<未抛错：error envelope 缺失>'
  } catch (e) {
    failMsg = String(e?.message ?? e)
  }
  ev.assert('B: 错误分型零变化——不存在模型收 MODEL_NOT_FOUND', /MODEL_NOT_FOUND/.test(failMsg), {
    channel: 'B',
    expected: 'error envelope code=MODEL_NOT_FOUND（三分型注册表判定源 = listProviders，零配置不变）',
    actual: failMsg.slice(0, 300),
  })
  ev.step({ step: 'v8.model-switch.invalid', channel: 'B', exitCode: /MODEL_NOT_FOUND/.test(failMsg) ? 0 : 1, stats: {} })

  // ③-6 切回默认：来回切换目录稳定
  const back = await protocol.call(
    'model.switch',
    { sessionId: sid, provider: 'faux', modelId: 'faux-1' },
    { replyType: 'model.switched', timeoutMs: 120_000 },
  )
  ev.assert('B: 切回 faux-1 成功（来回切换目录稳定）', back.provider === 'faux' && back.modelId === 'faux-1', {
    channel: 'B',
    expected: '{provider:"faux", modelId:"faux-1"}',
    actual: JSON.stringify({ provider: back.provider, modelId: back.modelId }),
  })

  // ══ V8 判据 4：无轮询定时器形态（对话/切换完成后的全程窗口判定） ══
  // C① runtime 日志：聚合域运行痕迹分类判定——装载枚举行不算，运行行周期性 ≥3 次判 fail，
  // 全部命中行 attach 供人工复核。
  const runtimeLogText = readRuntimeLogs(dataDir)
  ev.assert('C: runtime 日志可读（观测通路在）', runtimeLogText.length > 0, {
    channel: 'C',
    expected: '<dataDir>/logs/runtime-*.log 非空',
    actual: `bytes=${runtimeLogText.length}`,
  })
  const allRtAggLines = AGG_LOG_KEYWORDS.flatMap((kw) => grepFileLines(runtimeLogText, kw))
  const enumLines = allRtAggLines.filter(isLoadEnumerationLine)
  const runLines = allRtAggLines.filter((l) => !isLoadEnumerationLine(l))
  const periodic = periodicLineSuspects(runLines)
  const rtClean = periodic.length === 0
  ev.assert('C: runtime 日志聚合域无周期性运行痕迹（装载枚举行除外）', rtClean, {
    channel: 'C',
    expected: `聚合关键词命中行 = 装载枚举（spawn 命令行/扩展清单）或非周期运行行（<3 次同文重复）`,
    actual: `aggHitLines=${allRtAggLines.length}（枚举=${enumLines.length} 运行=${runLines.length}）periodic=${periodic.length === 0 ? 'none' : periodic.join(' | ').slice(0, 200)}`,
  })
  ev.attach('runtime-agg-lines', `全部命中行（${allRtAggLines.length}）：\n${allRtAggLines.join('\n').slice(0, 12_000) || '(零命中)'}`)
  ev.step({ step: 'v8.timer.runtime-log', channel: 'C', exitCode: rtClean ? 0 : 1, stats: { aggLines: allRtAggLines.length, runLines: runLines.length, bytes: runtimeLogText.length } })

  // C② runtime 日志 interval/poll/watch 命中行清单：断言无聚合标识（判定域内零定时器痕迹），
  // 全部命中行 attach 供人工复核（既有非聚合功能的痕迹不属 V8 判定域，如实呈报不下判）。
  const rtTimerLines = []
  for (const line of runtimeLogText.split('\n')) {
    if (new RegExp(TIMER_LOG_PATTERN, 'i').test(line)) {
      rtTimerLines.push(line.length > 300 ? `${line.slice(0, 300)}…[truncated]` : line)
      if (rtTimerLines.length >= 60) break
    }
  }
  const rtTimerAggHit = rtTimerLines.filter((l) => AGG_LOG_KEYWORDS.some((kw) => l.toLowerCase().includes(kw.toLowerCase())))
  ev.assert('C: runtime 日志 interval/poll 痕迹无聚合标识', rtTimerAggHit.length === 0, {
    channel: 'C',
    expected: `命中 ${TIMER_LOG_PATTERN} 的日志行不含聚合域标识`,
    actual: `timerLines=${rtTimerLines.length} aggHits=${rtTimerAggHit.length}`,
  })
  ev.attach('runtime-timer-lines', rtTimerLines.join('\n') || '(零命中)')

  // C③ pi 日志：聚合域运行痕迹同款分类判定
  const piLogText = readPiLogs(dataDir)
  const piAggLines = piLogText.length > 0 ? AGG_LOG_KEYWORDS.flatMap((kw) => grepFileLines(piLogText, kw)) : []
  const piRunLines = piAggLines.filter((l) => !isLoadEnumerationLine(l))
  const piPeriodic = periodicLineSuspects(piRunLines)
  ev.assert('C: pi 日志非空且聚合域无周期性运行痕迹', piLogText.length > 0 && piPeriodic.length === 0, {
    channel: 'C',
    expected: 'pi-*.jsonl 非空且聚合域运行行无周期性重复（<3 次同文）',
    actual: `bytes=${piLogText.length} aggHitLines=${piAggLines.length} runLines=${piRunLines.length} periodic=${piPeriodic.length === 0 ? 'none' : piPeriodic.join(' | ').slice(0, 200)}`,
  })
  if (piAggLines.length > 0) ev.attach('pi-agg-lines', piAggLines.join('\n').slice(0, 12_000))

  // C④ 源码层：聚合实现源码零定时器 API 实码（注释行除外）
  const timerCodeHits = []
  for (const rel of AGG_SOURCE_FILES) {
    const abs = path.join(repo, rel)
    if (!fs.existsSync(abs)) {
      timerCodeHits.push(`${rel}: <文件缺失>`)
      continue
    }
    const r = spawnSync('grep', ['-nE', TIMER_CODE_PATTERN, abs], { encoding: 'utf8' })
    for (const line of (r.stdout ?? '').split('\n').filter(Boolean)) {
      const codePart = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line
      if (!isCommentLine(codePart)) timerCodeHits.push(`${rel} → ${line.slice(0, 300)}`)
    }
  }
  ev.assert('C（源码层）: 聚合实现源码零定时器 API 实码（setInterval/setTimeout/fs.watch/watchFile）', timerCodeHits.length === 0, {
    channel: 'C',
    expected: `${AGG_SOURCE_FILES.length} 个实现文件非注释行零命中`,
    actual: timerCodeHits.length === 0 ? `${AGG_SOURCE_FILES.length} 文件全查零实码命中` : timerCodeHits.join(' | ').slice(0, 400),
  })
  ev.attach('timer-code-hits', timerCodeHits.join('\n') || '(零命中)')
  ev.step({ step: 'v8.timer.source-scan', channel: 'C', exitCode: timerCodeHits.length === 0 ? 0 : 1, stats: { files: AGG_SOURCE_FILES.length } })

  // B⑤+C⑥ 终态：全程 events 无 aggregation.* 帧；extras 终态与初始态同态（既有操作零写路由域）
  ev.assert('B: 全程 events 无 aggregation.* 帧（收尾终态）', aggFrameTypes().length === 0, {
    channel: 'B',
    expected: '全程无 aggregation.* 帧',
    actual: `frames=${aggFrameTypes().join(',') || 'none'} total=${protocol.events.length}`,
  })
  let finalRaw = ''
  let finalJson = null
  let finalExists = false
  try {
    finalRaw = fs.readFileSync(extrasPath, 'utf8')
    finalJson = JSON.parse(finalRaw)
    finalExists = true
  } catch {
    finalExists = fs.existsSync(extrasPath)
  }
  const finalRoutesEmpty = finalJson !== null
    && (finalJson.routes === undefined
      || (Array.isArray(finalJson.routes?.routes) && finalJson.routes.routes.length === 0))
  const finalZeroConfig = !finalExists || finalRoutesEmpty
  // 同态判定：终态零配置成立且形态未从 absent 翻转为「有文件」（有文件即有人写过 extras）
  const sameShape = (!extrasExists && !finalExists) || (extrasExists && finalExists)
  ev.assert('C: 收尾时 extras 与初始态同态且仍零配置（对话/切换操作零写路由域）', finalZeroConfig && sameShape, {
    channel: 'C',
    expected: `终态与初始态同态（初始=${extrasExists ? '文件在' : 'absent'}）且 routes 持续缺席（写侧单点 = aggregation.saveRoute，零配置无人调用）`,
    actual: `initialExists=${extrasExists} finalExists=${finalExists} finalState=${finalJson ? `topKeys=${Object.keys(finalJson).join(',')}` : finalExists ? '<文件在但不可解析>' : '(absent)'} routesSectionEmpty=${finalRoutesEmpty} finalZeroConfig=${finalZeroConfig}`,
  })
  if (finalExists) ev.attach('extras-final', finalRaw.slice(0, 8_000))
  ev.step({ step: 'v8.final-state', channel: 'B', exitCode: finalZeroConfig && sameShape ? 0 : 1, stats: {} })

  log(`agg-zero-config done sid=${sid}`)
  return { uncovered, gotchas }
}
