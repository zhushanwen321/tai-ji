/**
 * agg-extension-disabled —— 扩展禁用/启用往返（provider-aggregation 设计 §4.1 V16，D9 禁用态分型验收）。
 *
 * 判据原文（设计文档 §4.1 V16 行摘录）：
 * - 配置模型路由并设为默认模型后禁用路由扩展，验收选择器呈现、切换错误指引、默认模型行为
 *   与已绑定会话重开回落，再重新启用。
 * - 步骤：① 创建并启用一条模型路由（双端点），加入 scopedModels 并置为列表第一位（全局默认）；
 *   新建会话 S 选中该路由并发送消息完成一次应答 → ② 扩展管理中禁用路由扩展（tier=feature
 *   可禁）→ ③ 新建会话，打开模型选择器观察路由条目 → ④ 选中该路由条目切换/发消息 →
 *   ⑤ 检查默认模型行为（新会话 spawn 与初始广播）→ ⑥ 重开会话 S 并发送消息（resume 回落）→
 *   ⑦ 重新启用扩展 → ⑧ 新建会话选中该路由发消息。
 * - 通过标准：第 ③ 步选择器仍显示路由条目（注入纯磁盘派生，D4/D9 禁用态分型 ①）；第 ④ 步
 *   切换失败映射为「模型路由扩展已被禁用，请在扩展管理中启用后使用」——不出现「请新建会话」
 *   指引（新会话同样不装载扩展，该指引形成循环）；第 ⑤ 步默认模型不悬空指向路由条目
 *   （findValidDefaultModel 按扩展装载状态判不可用，auto-fix 落首个可用物理模型，D9 ③）；
 *   第 ⑥ 步会话正常出话、生效模型为最后应答的物理模型（S 已有应答，按 UD9 resume 回落），
 *   不出现 pi 原始 is not registered 文本——resume 回落是正常路径非缺陷，呈现语义 = 不提示；
 *   第 ⑦/⑧ 步启用后新会话可正常绑定路由并出话（恢复路径闭环）。
 *
 * 装配：mock-http（createInstance llm 通道）。路由 agg-ext-main 端点
 * [ag-x1(window 当前判窗外), ag-x2(none)] → 绑定会话命中兜底 ag-x2。命中判据 =
 * instance.mockLlm.requests 尾部（status 200）model 裸 id（mock-http README 坑 1）+
 * 会话 JSONL 助手消息物理模型记录（C 通道磁盘证据）。
 *
 * 禁用机制（源码亲读依据）：
 * - 禁用键形态 = `npm:@zhushanwen/pi-provider-aggregation`（extension-service.ts:235-241
 *   isRouteExtensionDisabled 同键；toggleExtension :542-560 的 disabledKey 推导——bundled
 *   扩展 source ≠ discovery，恒走 npm: 前缀）；落盘 <dataDir>/agent/disabled-packages.json
 *   （pi-extension-settings.ts:96-113，setEnabled(false) 追加 / setEnabled(true) 移除）。
 * - 协议命令 = `extension.toggle`（extension-message-handler.ts:129-141），回执类型
 *   config.extensions（ExtensionInfo.enabled = resolveExtensions loadable 判定）。
 * - 禁用只影响新 spawn 的 pi（扩展装载在 spawn 时，extension-filter loadable=false 不进
 *   --extension 清单）；已运行会话的原 pi 不受影响——resume 回落验收必须 forceQuit+switch
 *   换新进程（agg-delete-lifecycle V14 同款）。
 * - 选择器呈现：listProviders 注入路由条目纯磁盘派生（provider-config-helper.ts:545-550），
 *   不判扩展装载态 → 禁用后 model.list 仍含路由条目（V16 分型 ①）。
 * - 切换错误分型：pi set_model 对未注册模型报 Model not found → session-model-control.ts
 *   classifySetModelError（:167-206）：taiji 注册表命中（磁盘派生含该条目）+ provider=聚合
 *   + isRouteExtensionLoadable()=false → AGGREGATION_EXTENSION_DISABLED（:183-189），≠
 *   AGGREGATION_ROUTE_NOT_IN_SESSION（扩展已装载时的运行中新建窗口，V15 分支）≠
 *   ENGINE_MODEL_MISSING（双因）。UI toast 文案 = locale panel.ts:729
 *   aggregationExtensionDisabled「模型路由扩展已被禁用，请在扩展管理中启用后使用」，code→key
 *   映射单点 renderer model-switch-toast.ts CODE_TO_KEY（:27）。
 * - 默认模型裁定：findValidDefaultModel 聚合分支（pi-provider-store.ts:544-551）——
 *   aggregationRouteAvailability（组合根 index.ts:579-583 装配 = routes 在盘且 enabled 且
 *   扩展未禁用）判不可用 → fall through pickFirstModelProvider（models.json 键序首个
 *   enabled 且 models 非空的 provider 首模型，:224-240）→ getDefaultModel auto-fix 写回
 *   settings.json（:581-593）。两触发点同规则：spawn --model（rpc-client.ts:225-230
 *   resolveStartModel）与初始广播 config.defaults（message-broker.ts:395-402，新 WS 连接
 *   sendInitialState 推送）。
 * - resume 回落：restore 路径不拼 --model（rpc-client.ts:221-229 inheritSessionModel），
 *   新 pi 进程零虚拟注册 → pi getBranchSelection 虚拟模型不注册不持有，回落最后应答物理模型。
 */
import fs from 'node:fs'
import path from 'node:path'

const AGG = 'aggregation'
const PROVIDER = 'mockllm'
const ROUTE = 'agg-ext-main'
const REF = `${AGG}/${ROUTE}`
const EP_FALLBACK = 'ag-x2' // 路由兜底端点（最后应答物理模型 P）
const ROUTE_EXT = '@zhushanwen/pi-provider-aggregation'
const DISABLED_KEY = `npm:${ROUTE_EXT}`
/** D9 ② 映射文案锚段（locale panel.ts:729 aggregationExtensionDisabled 原文）。 */
const TOAST_EXT_DISABLED = '模型路由扩展已被禁用'
const TOAST_EXT_DISABLED_GUIDE = '请在扩展管理中启用后使用'
/** V15 分支指引（「请新建会话」）——禁用态不得出现该循环指引。 */
const FORBIDDEN_NEW_SESSION_GUIDE = '请新建会话'
/** V16 ⑥ 禁止出现的 pi 原始文本。 */
const PI_RAW_NOT_REGISTERED = 'is not registered'

// ── mock 演员：每端点独立 model（独立队列，游标 per-model 互不污染） ──────────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'model-keyed；pi 请求体 model 是裸 id，selectQueue 按裸段匹配；_note 被忽略',
  'mockllm/mock-1': [step('agg-exd-default-1'), step('agg-exd-default-2')],
  'mockllm/ag-x1': [step('agg-exd-x1-should-never-hit')], // blocked-now 表下不应命中；命中即时间窗竞态破绽
  'mockllm/ag-x2': [
    step('agg-exd-x2-turn1'), step('agg-exd-x2-resume'), step('agg-exd-x2-rebind'), step('agg-exd-x2-spare'),
  ],
}

export const meta = {
  id: 'agg-extension-disabled',
  priority: 'P0',
  title: '扩展禁用/启用往返（V16 / D9 禁用态分型）：选择器仍显示 / 禁用专用指引 / 默认不悬空 / resume 回落 / 恢复闭环',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'model.list', 'model.switch', 'settings.provider', 'extension.load',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: 'mock-1',
    subModel: 'mock-sub-a',
    models: ['mock-1', 'mock-sub-a', 'ag-x1', 'ag-x2'],
  },
  estimateSec: 360,
  provable: [
    '装配链 B+C：saveRoute（双端点）+ setScoped([路由引用首位, mock-1]) → routes 落盘 + default 同步为路由引用（settings.json，V16 观察前提）',
    '前置：会话 S 绑定路由（spawn --model 命中工厂期注册）并成功应答一轮，命中兜底端点 ag-x2（mockLlm 尾部裸 id + JSONL 物理模型记录锚定 P）',
    'V16② 禁用链 B+C：extension.toggle(false) 回执该扩展 enabled=false + disabled-packages.json 落 npm:@zhushanwen/pi-provider-aggregation（isRouteExtensionDisabled 同键形态）',
    'V16③ B：禁用后 model.list 仍含路由条目 agg-ext-main（注入纯磁盘派生，条件轮询）',
    'V16③ A：新建会话打开模型选择器，路由行 model-picker-item-agg-ext-main 仍显示',
    'V16④ A：选中路由条目失败 toast =「模型路由扩展已被禁用，请在扩展管理中启用后使用」，不含「请新建会话」循环指引',
    'V16④ B：协议 model.switch 失败 code=AGGREGATION_EXTENSION_DISABLED（≠ AGGREGATION_ROUTE_NOT_IN_SESSION，≠ ENGINE_MODEL_MISSING 双因）',
    'V16⑤ 默认不悬空：禁用后新建会话（无 override）spawn 落首个可用物理模型（盘上按 models.json 键序 × enabledModels 推导期望）+ 第二 WS 连接初始广播 config.defaults 同值 + settings.json auto-fix 落盘 + runtime 日志 fallback warn',
    'V16⑥ resume 回落：forceQuit+switch 重开会话 S（新 pi 进程零虚拟注册）绑定回落最后应答物理模型 P=mockllm/ag-x2，再发消息正常出话（无 is not registered 原始文本）',
    'V16⑦ 启用链 B+C：extension.toggle(true) 回执 enabled=true + disabled-packages.json 键移除',
    'V16⑧ 恢复闭环：新建会话 modelOverride=路由引用 绑定成功（工厂期注册恢复）+ 发消息命中兜底端点正常出话',
  ],
  notProvable: [
    '扩展管理页 UI 的禁用开关交互本身（A 通道页面导航）：本剧本走协议 extension.toggle 写侧 + disabled-packages.json 落盘断言；开关 UI 面归手工验收',
    'V16⑥「呈现语义 = 不提示，选择器直接显示当前物理模型」的 composer 工具条渲染细节：以 getState.modelId 协议读为生效模型锚；显示面归手工验收',
    'V16⑤ landing fallback 的 UI 默认选中显示：以 config.defaults 初始广播 + settings.json 落盘为准',
    'pi 侧 getBranchSelection 的内部回落逻辑（dist/core/virtual-models.js）：黑盒驱动，pi 内部选择由其单测承载；本剧本验 taiji 侧可观察终态（绑定与出话）',
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

/**
 * 从盘上推导 findValidDefaultModel fall-through 的期望目标（pi-provider-store.ts:224-240
 * pickFirstModelProvider 同款语义：models.json 键序 × deriveEnabled（enabledModels 白名单，
 * provider-catalog.ts:50-53）× models 非空 → 首个 provider 的首模型）。不硬编码 mockllm/mock-1：
 * 模板种子的其他 provider 若排在键序前面会被选中。
 */
function expectedFallbackRef(settings, modelsJson) {
  const enabledModels = Array.isArray(settings.enabledModels) ? settings.enabledModels : null
  const deriveEnabled = (pid) => {
    if (!enabledModels || enabledModels.length === 0) return true
    return enabledModels.some((p) => p === `${pid}/*` || String(p).startsWith(`${pid}/`))
  }
  for (const [pid, pcfg] of Object.entries(modelsJson.providers ?? {})) {
    if (!deriveEnabled(pid)) continue
    if (Array.isArray(pcfg?.models) && pcfg.models.length > 0) return `${pid}/${pcfg.models[0].id}`
  }
  return ''
}

// ── 剧本 run ════════════════════════════════════════════════════════════════════
export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'extension.toggle 的回执类型是 config.extensions（REPLY_TYPES 未登记该命令，protocol.call 必须显式传 replyType）',
    '禁用键形态 = npm:@zhushanwen/pi-provider-aggregation（bundled 扩展 source ≠ discovery 恒走 npm: 前缀；与 isRouteExtensionDisabled 判据同键）',
    '禁用只影响新 spawn 的 pi（扩展装载在 spawn 时）；已运行会话的原 pi 不受影响——resume 回落验收必须 forceQuit+switch 换新进程',
    'auto-fix 期望回落目标从盘上推导（models.json 键序 × enabledModels × models 非空），不硬编码 mockllm/mock-1——模板种子 provider 排前会被选中',
    'mock-http 游标 per-model（mock server 进程持有）：ag-x2 单队列按时间顺序消费（S 前置轮 → S 重开轮 → N4 轮），队列留 1 步余量',
    '初始广播 config.defaults 在新 WS 连接 auth 后即推（sendInitialState）；剧本开第二连接直读 runtime.port 捕获',
    'pi 发往 HTTP 的 model 是裸 id（mock-http README 坑 1）——mockLlm.requests[].model 断言用裸 id',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const disabledPath = path.join(dataDir, 'agent', 'disabled-packages.json')
  const readDisabled = () => {
    try {
      return JSON.parse(fs.readFileSync(disabledPath, 'utf8')).disabled ?? []
    } catch {
      return [] // ENOENT / 空窗：语义 = 无禁用记录
    }
  }

  // ── 0. 前提：端点物理模型在 models.json（pi modelRegistry 物理段源，C）+ 扩展基线 ──
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const needEndpoints = ['ag-x1', 'ag-x2']
  const endpointsReady = needEndpoints.every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——路由端点物理模型全部在 agent/models.json（pi modelRegistry 物理段源）', endpointsReady, {
    channel: 'C',
    expected: needEndpoints.join(','),
    actual: `hits=${needEndpoints.filter((id) => endpointIds.includes(id)).length}/2 in=${endpointIds.join(',').slice(0, 200)}`,
  })
  const disabledBaseline = readDisabled()
  ev.assert('C: 前提——disabled-packages.json 基线无路由扩展禁用键', !disabledBaseline.includes(DISABLED_KEY), {
    channel: 'C',
    expected: `无 ${DISABLED_KEY}`,
    actual: JSON.stringify(disabledBaseline).slice(0, 200),
  })
  const extList0 = await protocol.call('extension.list', {}, { replyType: 'config.extensions', timeoutMs: 60_000 })
  const routeExt0 = (extList0.extensions ?? []).find((e) => e.name === ROUTE_EXT)
  ev.assert('B: 前提——extension.list 含路由扩展且 enabled=true（tier=feature bundled）', Boolean(routeExt0) && routeExt0?.enabled === true, {
    channel: 'B',
    expected: `${ROUTE_EXT} enabled=true`,
    actual: `found=${Boolean(routeExt0)} enabled=${routeExt0?.enabled} tier=${routeExt0?.tier ?? '<none>'}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady && !disabledBaseline.includes(DISABLED_KEY) && routeExt0?.enabled ? 0 : 1, stats: {} })

  // ── 共用 helper ──────────────────────────────────────────────────────────────
  const member = (id, modelId, type, table) => ({ id, providerId: PROVIDER, modelId, type, ...(table ? { window: table } : {}) })
  const routeOf = (id, mode, members) => ({ id, name: id, modelId: id, enabled: true, mode, members, specials: [] })

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
      expected: 'message.complete 非 error（无 is not registered 等原始错误）',
      actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'}`,
    })
    const errText = String(end.payload?.errorMessage ?? end.payload?.message ?? '')
    ev.assert(`B: ${label} 无 pi 原始 is not registered 文本`, !errText.includes(PI_RAW_NOT_REGISTERED), {
      channel: 'B',
      expected: `不含「${PI_RAW_NOT_REGISTERED}」`,
      actual: `errorMessage=${errText.slice(0, 200) || '<空>'}`,
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
      if (aggIds.includes(ROUTE) || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
    ev.step({ step: `model.list.${label}`, channel: 'B', exitCode: 0, stats: { aggIds: aggIds.join(',') } })
    return aggIds
  }

  /** 开第二 WS 连接捕获 config.defaults 初始广播（sendInitialState 新连接推送）。 */
  async function captureInitialBroadcast(label, timeoutMs = 10_000) {
    const { createProtocol } = await import('../scripts/lib/protocol.mjs')
    const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
    const proto2 = await createProtocol({ dataDir, runtimePort })
    let payload = null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const evt = proto2.events.find((e) => e.type === 'config.defaults')
      if (evt) {
        payload = evt.payload
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    await proto2.close()
    ev.step({ step: `config.defaults.${label}`, channel: 'B', exitCode: payload ? 0 : 1, stats: { defaultModel: payload?.defaultModel ?? '<none>' } })
    return payload
  }

  // ══ 1. 装配路由（双端点）+ scopedModels 首位（全局默认） ═══════════════════════
  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} row=${todayRow(now0)} slot=${currentSlot(now0)}`)
  const route = routeOf(ROUTE, 'advanced', [member('x1', 'ag-x1', 'window', blockedNowTable(now0)), member('x2', 'ag-x2', 'none')])
  await saveRoute(route, 'v1（x1=blocked-now, x2=none）')
  const routesOnDisk = extras().routes?.routes ?? []
  ev.assert('C: 路由落盘 providers.json routes 段（saveRoute 唯一写点）', routesOnDisk.some((r) => r.id === ROUTE), {
    channel: 'C',
    expected: `routes 含 ${ROUTE}`,
    actual: `routeIds=${routesOnDisk.map((r) => r.id).join(',')}`,
  })

  await setScoped([REF, `${PROVIDER}/mock-1`], '路由引用置首位（全局默认）')
  const settings1 = readSettings()
  ev.assert('C: default 同步为路由引用（settings.json；V16 观察前提）', settings1.defaultProvider === AGG && settings1.defaultModel === ROUTE, {
    channel: 'C',
    expected: `defaultProvider=${AGG} defaultModel=${ROUTE}（syncDefaultToScopedModels 首位编排）`,
    actual: `default=${settings1.defaultProvider}/${settings1.defaultModel}`,
  })

  const aggIds1 = await listAggIds('enabled-baseline')
  ev.assert('B: model.list 出现聚合条目 agg-ext-main（扩展启用态基线）', aggIds1.includes(ROUTE), {
    channel: 'B',
    expected: `model.list 聚合条目含 ${ROUTE}`,
    actual: `aggIds=${aggIds1.join(',')}`,
  })

  // ══ 2. V16 步骤 ①：会话 S 绑定路由并完成一次应答（锚定 P = mockllm/ag-x2） ════
  const S_LABEL = 'agg-exd-session-s'
  const sidS = await createBoundSession(REF, S_LABEL)
  const sessionFileS = await sessionFileOf(sidS)
  ev.assert('C: 会话文件定位（config.sessions summary.sessionFile 非空）', Boolean(sessionFileS), {
    channel: 'C',
    expected: 'sessionFile 非空（首条消息 flush 前允许文件未创建）',
    actual: sessionFileS || '<summary 未带 sessionFile>',
  })
  const presetTurn = await sendTurn(sidS, 'V16 前置：路由对话一轮，命中兜底 ag-x2', EP_FALLBACK, 'V16 前置轮', { sessionFile: sessionFileS, expectAssistantCount: 1 })
  ev.step({ step: 'v16.preset-turn', channel: 'C', exitCode: presetTurn.tail?.model === EP_FALLBACK ? 0 : 1, stats: { model: presetTurn.tail?.model } })

  // ══ 3. V16 步骤 ②：禁用路由扩展（协议写侧 + 落盘双通道） ══════════════════════
  const toggleOff = await protocol.call(
    'extension.toggle',
    { name: ROUTE_EXT, enabled: false },
    { replyType: 'config.extensions', timeoutMs: 60_000 },
  )
  const routeExtOff = (toggleOff.extensions ?? []).find((e) => e.name === ROUTE_EXT)
  ev.assert('B: V16② toggle(false) 回执路由扩展 enabled=false', routeExtOff?.enabled === false, {
    channel: 'B',
    expected: 'enabled=false（resolveExtensions loadable 判定）',
    actual: `enabled=${routeExtOff?.enabled ?? '<ext 不在列表>'}`,
  })
  const disabledOnDisk = readDisabled()
  ev.assert('C: V16② disabled-packages.json 落禁用键（isRouteExtensionDisabled 同键形态）', disabledOnDisk.includes(DISABLED_KEY), {
    channel: 'C',
    expected: `含 ${DISABLED_KEY}`,
    actual: JSON.stringify(disabledOnDisk).slice(0, 200),
  })
  ev.step({ step: 'v16.extension-disabled', channel: 'C', exitCode: routeExtOff?.enabled === false && disabledOnDisk.includes(DISABLED_KEY) ? 0 : 1, stats: {} })

  // ══ 4. V16 步骤 ③（B 半边）：禁用后 model.list 仍含路由条目 ═══════════════════
  const aggIdsOff = await listAggIds('disabled-still-visible')
  ev.assert('B: V16③ 禁用后 model.list 仍含路由条目（注入纯磁盘派生，不判扩展装载态）', aggIdsOff.includes(ROUTE), {
    channel: 'B',
    expected: `聚合条目仍含 ${ROUTE}`,
    actual: `aggIds=${aggIdsOff.join(',')}`,
  })

  // ══ 5. V16 步骤 ⑤：默认模型不悬空（spawn auto-fix + 初始广播 + 落盘 + 日志四证据） ══
  const expectedRef = expectedFallbackRef(readSettings(), JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8')))
  ev.assert('C: 期望回落目标可从盘上推导（models.json 键序 × enabledModels）', Boolean(expectedRef) && !expectedRef.startsWith(`${AGG}/`), {
    channel: 'C',
    expected: '非空且非聚合引用',
    actual: `expected=${expectedRef || '<无法推导：models.json 无可用 provider>'}`,
  })
  const createdN3 = await protocol.call('session.create', { cwd: repo, label: 'agg-exd-new-n3' }, { timeoutMs: 120_000 })
  const sidN3 = createdN3.session?.id
  await pollBoundModelId(sidN3, expectedRef, 'V16⑤ 新会话（无 override）spawn 落首个可用物理模型（不悬空指向路由条目）', { timeoutMs: 30_000 })
  await protocol.subscribe(sidN3)

  const settingsAfterSpawn = readSettings()
  ev.assert(`C: V16⑤ settings.json default 已 auto-fix 落 ${expectedRef}（不再指向路由条目）`, settingsAfterSpawn.defaultProvider === expectedRef.split('/')[0] && settingsAfterSpawn.defaultModel === expectedRef.split('/')[1], {
    channel: 'C',
    expected: `default=${expectedRef}（getDefaultModel wasFixed 写回）`,
    actual: `default=${settingsAfterSpawn.defaultProvider}/${settingsAfterSpawn.defaultModel}`,
  })
  const { readRuntimeLogs } = await import('../scripts/lib/instance.mjs')
  const runtimeLogs = readRuntimeLogs(dataDir)
  const hasFallbackWarn = runtimeLogs.includes('falling back to first available physical model') || runtimeLogs.includes('auto-fixed defaultModel')
  ev.assert('C: V16⑤ runtime 日志含聚合默认不可用 fallback / auto-fix warn', hasFallbackWarn, {
    channel: 'C',
    expected: '「aggregation default route ... falling back to first available physical model」或「auto-fixed defaultModel」（pi-provider-store.ts:551/:590）',
    actual: hasFallbackWarn ? '命中' : '未命中（日志见 artifacts）',
  })
  if (!hasFallbackWarn) ev.attach('runtime-log-tail-at-default-check', runtimeLogs.split('\n').slice(-80).join('\n').slice(0, 12_000))

  const defaultsPayload = await captureInitialBroadcast('after-disable')
  ev.assert(`B: V16⑤ 初始广播 config.defaults 不悬空 = ${expectedRef}`, defaultsPayload?.defaultModel === expectedRef, {
    channel: 'B',
    expected: `defaultModel=${expectedRef}（≠ ${REF}）`,
    actual: `payload=${JSON.stringify(defaultsPayload ?? null).slice(0, 200)}`,
  })
  ev.step({ step: 'v16.default-not-dangling', channel: 'B', exitCode: defaultsPayload?.defaultModel === expectedRef ? 0 : 1, stats: { expected: expectedRef } })

  // ══ 6. V16 步骤 ③（A 半边）+ ④：新会话选择器仍显示路由条目；选中失败映射专用指引 ══
  // 默认项目区默认收起（agg-delete-lifecycle 同款）：先点默认区组头展开，再点会话行
  const ui = ctx.ui
  try {
    const zoneExpanded = await ui.attr('testid=default-project-anchor', 'aria-expanded')
    if (zoneExpanded !== 'true') await ui.click('testid=default-project-anchor')
    await ui.expectVisible(`css=.session-item[aria-label="${S_LABEL}"]`, { timeoutMs: 20_000 })
    await ui.click(`css=.session-item[aria-label="agg-exd-new-n3"]`)
    await ui.expectText('testid=panel-session-label', 'agg-exd-new-n3', { timeoutMs: 20_000 })
    ev.assert('A: 激活禁用后新建的会话 N3（panel-session-label）', true, { channel: 'A', expected: 'agg-exd-new-n3', actual: 'agg-exd-new-n3' })

    await ui.click('css=[title="切换模型"]')
    await ui.expectVisible(`testid=model-picker-item-${ROUTE}`, { timeoutMs: 15_000 })
    const rowText = await ui.text(`testid=model-picker-item-${ROUTE}`)
    ev.assert('A: V16③ 禁用后新会话选择器仍显示路由条目行', Boolean(rowText), {
      channel: 'A',
      expected: `model-picker-item-${ROUTE} 可见（选择器 = model.list 候选，磁盘派生）`,
      actual: String(rowText).slice(0, 200),
    })
    await ev.shot(await instance.page(), 'v16-disabled-picker-shows-route')

    await ui.click(`testid=model-picker-item-${ROUTE}`)
    const toastText = await ui.expectText('css=[data-testid^="toast-message-"]', TOAST_EXT_DISABLED, { timeoutMs: 10_000 })
    ev.assert('A: V16④ 选中路由失败 toast = 扩展禁用专用映射文案', toastText.includes(TOAST_EXT_DISABLED) && toastText.includes(TOAST_EXT_DISABLED_GUIDE), {
      channel: 'A',
      expected: `toast 含「${TOAST_EXT_DISABLED}」+「${TOAST_EXT_DISABLED_GUIDE}」（panel.ts aggregationExtensionDisabled）`,
      actual: `toast=${toastText.slice(0, 300)}`,
    })
    ev.assert('A: V16④ 不出现「请新建会话」循环指引', !toastText.includes(FORBIDDEN_NEW_SESSION_GUIDE), {
      channel: 'A',
      expected: `toast 不含「${FORBIDDEN_NEW_SESSION_GUIDE}」（新会话同样不装载扩展，该指引形成循环）`,
      actual: `toast=${toastText.slice(0, 300)}`,
    })
    await ev.shot(await instance.page(), 'v16-disabled-switch-fail-toast')
    await ui.press('Escape')
    ev.step({ step: 'v16.ui-toast', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    ev.assert('A: V16③/④ 选择器 + toast 链（路由行仍显示 / 点击失败 / 禁用专用文案）', false, {
      channel: 'A',
      expected: '激活 N3 → 选择器见路由行 → 点击 → toast 禁用专用文案',
      actual: String(e?.message ?? e).slice(0, 400),
    })
    ev.attach('v16-ui-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 20_000))
    try {
      await ev.shot(await instance.page(), 'v16-ui-fail')
    } catch {
      /* 页面不可用时放弃截图 */
    }
    ev.step({ step: 'v16.ui-toast', channel: 'A', exitCode: 1, stats: {} })
  }

  // V16 步骤 ④（B 半边）：协议 set_model 被拒，错误码 = 扩展禁用分支（≠ 运行中新建 / 双因）
  let switchFailCode = ''
  let switchFailMsg = ''
  try {
    await protocol.call(
      'model.switch',
      { sessionId: sidN3, provider: AGG, modelId: ROUTE },
      { replyType: 'model.switched', timeoutMs: 60_000 },
    )
    switchFailCode = '<未抛错：切换不应成功>'
  } catch (e) {
    switchFailCode = String(e?.code ?? '')
    switchFailMsg = String(e?.message ?? e)
  }
  ev.assert('B: V16④ model.switch 失败 code=AGGREGATION_EXTENSION_DISABLED（禁用态分支映射）', switchFailCode === 'AGGREGATION_EXTENSION_DISABLED', {
    channel: 'B',
    expected: 'AGGREGATION_EXTENSION_DISABLED（session-model-control.ts:183-189，isRouteExtensionLoadable=false 分支）',
    actual: `code=${switchFailCode || '<none>'} msg=${switchFailMsg.slice(0, 200)}`,
  })
  ev.assert('B: V16④ 不落 AGGREGATION_ROUTE_NOT_IN_SESSION（扩展已装载才走该分支）', switchFailCode !== 'AGGREGATION_ROUTE_NOT_IN_SESSION', {
    channel: 'B',
    expected: '≠ AGGREGATION_ROUTE_NOT_IN_SESSION（V15 运行中新建窗口分支）',
    actual: `code=${switchFailCode || '<none>'}`,
  })
  ev.assert('B: V16④ 不落 ENGINE_MODEL_MISSING 双因码', switchFailCode !== 'ENGINE_MODEL_MISSING', {
    channel: 'B',
    expected: '≠ ENGINE_MODEL_MISSING（双因文案码）',
    actual: `code=${switchFailCode || '<none>'}`,
  })
  ev.step({ step: 'v16.switch-rejected', channel: 'B', exitCode: switchFailCode === 'AGGREGATION_EXTENSION_DISABLED' ? 0 : 1, stats: { code: switchFailCode } })

  // ══ 7. V16 步骤 ⑥：重开会话 S——resume 回落最后应答物理模型 P ════════════════
  const spawnCountBefore = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  const fq = await protocol.call('session.forceQuit', { sessionId: sidS }, { timeoutMs: 60_000 })
  ev.assert('B: V16⑥ forceQuit ack（关闭会话）', fq?.status === 'force_quit', {
    channel: 'B',
    expected: "message.status status='force_quit'",
    actual: JSON.stringify(fq ?? null).slice(0, 200),
  })
  const switched = await protocol.call('session.switch', { sessionId: sidS }, { replyType: 'session.switched', timeoutMs: 120_000 })
  ev.assert('B: V16⑥ 重开会话（session.switch 回执）', switched?.sessionId === sidS, {
    channel: 'B',
    expected: `session.switched sessionId=${sidS}`,
    actual: `sessionId=${switched?.sessionId}`,
  })
  await protocol.subscribe(sidS)
  const spawnCountAfter = readRuntimeLogs(dataDir).split('\n').filter((l) => l.includes('spawning pi')).length
  ev.assert('C: V16⑥ pi 进程重开（runtime 日志 spawning pi 计数增加；新进程扩展禁用零虚拟注册）', spawnCountAfter > spawnCountBefore, {
    channel: 'C',
    expected: `spawning pi 计数 > ${spawnCountBefore}`,
    actual: `after=${spawnCountAfter}`,
  })

  // resume 回落判据：绑定 = 最后应答物理模型 P（pi getBranchSelection 虚拟模型不注册不持有）
  await pollBoundModelId(sidS, `${PROVIDER}/${EP_FALLBACK}`, 'V16⑥ 重开会话按 resume 语义回落物理模型 P（不悬空指向路由）', { timeoutMs: 30_000 })
  // 重开后再发消息——物理模型直连正常出话
  const resumeTurn = await sendTurn(sidS, 'V16⑥ 重开后继续：物理模型直连应正常出话', EP_FALLBACK, 'V16 重开轮', { sessionFile: sessionFileS, expectAssistantCount: 2 })
  ev.assert(`B: V16⑥ 重开轮命中物理模型 P（mock 尾部 model=${EP_FALLBACK}）`, resumeTurn.tail?.model === EP_FALLBACK, {
    channel: 'B',
    expected: `model=${EP_FALLBACK}`,
    actual: `tail.model=${resumeTurn.tail?.model ?? '<none>'}`,
  })
  const entriesAfterResume = await readAssistantEntries(sessionFileS, 2)
  ev.assert('C: V16⑥ 历史成功序列保持（前置轮 + 重开轮均 ag-x2，无 error 轮）', entriesAfterResume.filter((e) => e.stopReason !== 'error' && e.stopReason !== 'aborted').map((e) => e.model).join(',') === `${EP_FALLBACK},${EP_FALLBACK}`, {
    channel: 'C',
    expected: `成功序列=[${EP_FALLBACK},${EP_FALLBACK}]`,
    actual: JSON.stringify(entriesAfterResume).slice(0, 300),
  })
  ev.step({ step: 'v16.resume-fallback', channel: 'C', exitCode: resumeTurn.tail?.model === EP_FALLBACK ? 0 : 1, stats: { spawns: `${spawnCountBefore}->${spawnCountAfter}` } })

  // ══ 8. V16 步骤 ⑦：重新启用扩展 ════════════════════════════════════════════
  const toggleOn = await protocol.call(
    'extension.toggle',
    { name: ROUTE_EXT, enabled: true },
    { replyType: 'config.extensions', timeoutMs: 60_000 },
  )
  const routeExtOn = (toggleOn.extensions ?? []).find((e) => e.name === ROUTE_EXT)
  ev.assert('B: V16⑦ toggle(true) 回执路由扩展 enabled=true', routeExtOn?.enabled === true, {
    channel: 'B',
    expected: 'enabled=true',
    actual: `enabled=${routeExtOn?.enabled ?? '<ext 不在列表>'}`,
  })
  const disabledAfterOn = readDisabled()
  ev.assert('C: V16⑦ disabled-packages.json 禁用键已移除', !disabledAfterOn.includes(DISABLED_KEY), {
    channel: 'C',
    expected: `无 ${DISABLED_KEY}`,
    actual: JSON.stringify(disabledAfterOn).slice(0, 200),
  })
  ev.step({ step: 'v16.extension-reenabled', channel: 'C', exitCode: routeExtOn?.enabled === true && !disabledAfterOn.includes(DISABLED_KEY) ? 0 : 1, stats: {} })

  // ══ 9. V16 步骤 ⑧：恢复闭环——新会话绑定路由并出话 ═══════════════════════════
  const sidN4 = await createBoundSession(REF, 'agg-exd-new-n4')
  const sessionFileN4 = await sessionFileOf(sidN4)
  const rebindTurn = await sendTurn(sidN4, 'V16⑧ 重新启用后绑定路由：应正常路由命中兜底 ag-x2', EP_FALLBACK, 'V16 恢复轮', { sessionFile: sessionFileN4, expectAssistantCount: 1 })
  ev.assert(`B: V16⑧ 恢复轮命中兜底端点（mock 尾部 model=${EP_FALLBACK}）`, rebindTurn.tail?.model === EP_FALLBACK, {
    channel: 'B',
    expected: `model=${EP_FALLBACK}`,
    actual: `tail.model=${rebindTurn.tail?.model ?? '<none>'}`,
  })
  ev.step({ step: 'v16.recovery-loop', channel: 'B', exitCode: rebindTurn.tail?.model === EP_FALLBACK ? 0 : 1, stats: {} })

  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, at: new Date(r.at).toISOString() })), null, 2))

  log(`agg-extension-disabled done sidS=${sidS} sidN3=${sidN3} sidN4=${sidN4} p=${PROVIDER}/${EP_FALLBACK} failCode=${switchFailCode}`)
  return { uncovered, gotchas }
}
