/**
 * agg-neighbor-surfaces —— V13 供应商接入页与网络代理页邻居表面回归（D4 注入形态① kind
 * 排除验收）+ 隐式排除清单（重命名页/压缩页模型下拉、套餐浮层、容量环），provider-aggregation
 * 设计 §4.1（M1 交付面）。
 *
 * 判据原文（设计文档 V13 行摘录）：
 * 「1. 设置页创建并启用一条模型路由（双端点，含时间窗条件）→ 2. 保存 → 3. 打开供应商接入页
 *   检查渠道管理列表内容 → 4. 对既有渠道行依次执行凭据编辑、测试连接、启停交互 →
 *   5. 打开网络代理设置页检查服务商行内容。
 *   渠道管理列表无聚合 provider 条目、无路由分组（kind=aggregation 排除渲染，config.providers
 *   与 model.list 同源必受波及——D4 自证）；网络代理设置页服务商行无聚合条目（NetworkPage 经
 *   transport.listProviders 拉取同一份输出、逐 provider 渲染行，D4 ① 显式清单）；既有渠道行的
 *   凭据编辑、测试连接、启停交互行为正常（凭据状态、测试连接等 provider 语义不因新 kind 误触发）」。
 *
 * 装配：mock-http（createInstance llm 通道）+ A 通道 UI 驱动（run.mjs 生命周期，ctx.ui）。
 * 路由初始装配走协议写侧（aggregation.saveRoute / config.setScopedModels，agg-view-orchestration
 * 同款通道），双视角断言：
 * - 协议侧（B）：config.getProviders 聚合条目形态自证 D4 注入（id=aggregation / kind=aggregation /
 *   apiKeySet=false / status=not_configured / 无 baseUrl / 无 quota 声明）——这五项正是各排除
 *   清单消费方的过滤前提；
 * - UI 面（A）：CDP 开各设置分区断言列表内容（testid 均按源码核对）。
 *
 * 排除清单源码锚点（本剧本断言的过滤前提逐条对应）：
 * - ProviderPage.vue:481-485 channelProviders = providers.filter(kind !== 'aggregation')（渠道列表）
 * - NetworkPage.vue:97-101 listProviders 后 filter(kind !== 'aggregation')（服务商行）
 * - useAuthedModelGroups.ts:36-38 enabled===false 不列 + !apiKeySet 不列（重命名页
 *   RenameSessionPage.vue:296 / 压缩页 SmartContextCompactionPage.vue:240 共享 composable）
 * - useQuotaPlanList.ts:24-27 filter(p.quota?.enabled)（套餐浮层 PlanQuotaFloatPanel → Panel.vue:27
 *   v-if="quotaFloatVisible"，entries 空 = 浮层整卡不挂载）
 * - useQuotaDisplay matchedProviderId 按 quota enabled 匹配（容量环 ContextCapacityCard.vue:54
 *   v-if="matchedProviderId" Coding Plan 区；未命中 = 区不渲染 + footer「无 Coding Plan」
 *   packages/ui/src/locale/zh-CN/panel.ts:329）
 * 注入侧形态（provider-config-helper.ts:733-768 buildAggregationProviderInfo）：
 *   id=AGGREGATION_PROVIDER_ID('aggregation')、name='模型路由'(:667)、apiKeySet:false、
 *   status:'not_configured'、kind:'aggregation'、无 baseUrl/quota 字段。
 *
 * 测试连接（V13「provider 语义不因新 kind 误触发」的行为半边）：ModelTestButton
 * （packages/ui/src/features/settings/common/ModelTestButton.vue:20 `model-test-${modelId}`）→
 * runtime model-connection-tester POST {baseUrl}/chat/completions max_tokens:1 → 真打到本机
 * mock server。游标 per-model（fixtures/mock-http/README.md 坑 2），测试探针用独立模型 id
 * test-probe（队列 2 步），不与主队/端点演员串队。
 */
import fs from 'node:fs'
import path from 'node:path'

const PROVIDER = 'mockllm'
const MAIN = 'mock-1'
const PROBE = 'test-probe'

// V13 路由与端点 id（kebab-case，saveRoute id 规则）
const ROUTE = 'v13-neighbor'
const EP_A = 'ep-na'
const EP_B = 'ep-nb'

const AGG_PROVIDER_ID = 'aggregation'
const AGG_DISPLAY_NAME = '模型路由' // provider-config-helper.ts:667 AGGREGATION_PROVIDER_DISPLAY_NAME
const PROBE_KEY_LITERAL = 'mock-key-not-needed' // ensureLlm 写入 models.json 的字面量 apiKey

// ── mock 演员（model-keyed；V13 无对话轮，队列只为测试连接探针备步） ────────────────────
const step = (tag) => ({ text: tag, stopReason: 'stop' })
const responses = {
  _note: 'V13 零对话剧本：test-probe 是「测试连接」探针（runtime POST chat/completions 消费 1 步），mock-1 备 1 步防完成通知噪音',
  'mockllm/mock-1': [step('agg-neighbor-spare')],
  'mockllm/test-probe': [step('AGG_NB_CONN_TEST_OK_9e2c'), step('agg-neighbor-probe-spare')],
}

/** V13 装配的 scopedModels 基线（聚合条目在列——选择器可见性面归 V9，这里只作邻居表面前提）。 */
const scopedBaseline = [`aggregation/${ROUTE}`, `mockllm/${MAIN}`, `mockllm/${PROBE}`]

export const meta = {
  id: 'agg-neighbor-surfaces',
  priority: 'P0',
  title: 'V13 供应商接入页/网络代理页邻居表面回归（kind=aggregation 排除渲染 + 既有渠道行三交互正常）+ 隐式排除清单（重命名/压缩模型下拉、套餐浮层、容量环）',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'settings.provider', 'settings.network-proxy', 'model.list',
  ],
  requires: ['mock-http'],
  llm: {
    responses,
    mainModel: MAIN,
    subModel: 'mock-sub-a',
    models: [MAIN, 'mock-sub-a', 'mock-sub-b', EP_A, EP_B, PROBE],
  },
  estimateSec: 300,
  provable: [
    'V13 ①装配 B+C：saveRoute v13-neighbor（advanced 双端点，members=[none, window 今日两格]）落盘 routes 段 + setScopedModels 基线 + model.list 出现聚合条目（D4 注入自证：config.providers 与 model.list 同源）',
    'V13 协议侧 B：config.getProviders 含 kind=aggregation 条目且形态 = apiKeySet=false / status=not_configured / 无 baseUrl / 无 quota 声明（ProviderPage/NetworkPage/useAuthedModelGroups/useQuotaPlanList 四个排除清单消费方各自的过滤前提）',
    'V13 ③ A：供应商接入页渠道管理列表（provider-card 行集合）只含既有渠道行（Mock LLM），无聚合 provider 条目行、无路由分组（kind=aggregation 排除渲染，ProviderPage.vue:485）',
    'V13 ④凭据编辑 A+B：展开既有渠道行 → provider-edit-apikey 输入原值 → provider-save-bar 保存 → B 通道 getProviders 该行 apiKeySet=true 保持（凭据语义不因新 kind 误触发）',
    'V13 ④测试连接 A+C：模型行 model-test-test-probe 点击 → model-test-result-test-probe 结果条出现且 ok（连接成功）→ C：mock.requests 出现 model=test-probe 200（真实打到 mock server）',
    'V13 ④启停交互 A+B：既有渠道行启停开关关 → B：getProviders enabled=false + model.list 该 provider 模型移出 → 开 → enabled=true + model.list 恢复（启停语义不因新 kind 误触发）',
    'V13 ⑤ A：网络代理设置页服务商行（network-provider-row-*）无聚合条目（aggregation 行/主机名零 DOM，Mock LLM 行在列且 host=127.0.0.1；行集合 = 模板种子渠道 + mockllm，NetworkPage.vue:101 kind 过滤）',
    '隐式排除清单 A：重命名页模型下拉（rename-title-model）打开后选项集合含 mock-1（物理模型在列）且不含路由条目 v13-neighbor（useAuthedModelGroups apiKeySet 过滤）',
    '隐式排除清单 A：压缩页模型下拉（setting-smart-context-model）打开后选项集合同判（共享同一 composable）',
    '隐式排除清单 A+C：会话绑定聚合路由进入对话视图后 plan-quota-float 零 DOM（useQuotaPlanList quota.enabled 过滤 → entries 空 → Panel.vue v-if 不挂载）',
    '隐式排除清单 A：容量环浮层（context-usage-ring / composer-metrics-aggregate hover → ContextCapacityCard）无 Coding Plan 区、footer「无 Coding Plan」（useQuotaDisplay matchedProviderId 不命中聚合 provider）',
    'C 终态：providers.json routes 段一条路由 + scopedModels 终态序与装配一致',
  ],
  notProvable: [
    '渠道管理列表「无路由分组」的分组容器形态断言：排除生效形态 = 聚合条目整体不进列表（channelProviders 过滤在分组派生之前），不存在可独立断言的「路由分组」DOM 载体——以「行集合 = 既有渠道全集且无聚合行」承载该判据',
    'V13 步骤 1「设置页创建」的 UI 表单路径：装配走协议写侧（aggregation.saveRoute，与既有 agg-* 剧本同款通道）；路由页编辑 UI 归 agg-view-orchestration（V9/V12）',
    '测试连接的真实外部端点语义：探针目标是本机 mock server（零 token 通道约束），「真实厂商端点连通」不在此证',
    '套餐浮层有额度监控 provider 时的正排形态（mock 环境无 quota.enabled 条目，浮层整卡不挂载）：聚合条目「混入浮层」的反例形态不可构造——以协议侧 quota 字段缺失 + 浮层不挂载双证排除链',
    '容量环 expanded/composer 两形态的全覆盖：按实测窗口宽度命中其一（context-usage-ring 或 composer-metrics-aggregate hover），另一形态不重复驱动',
  ],
}

// ── 时间窗表构造（30 分钟格；V13 步骤 1「含时间窗条件」——B 端点今日 current+next 两格 true） ──
const todayRow = (now) => (now.getDay() + 6) % 7 // ISO 行：0=周一..6=周日
const currentSlot = (now) => Math.floor((now.getHours() * 60 + now.getMinutes()) / 30)
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
    '设置分区是 visitedViews 首访挂载 + v-show 常驻：列表断言必须限定激活分区（.sec-fade.on）或等分区内容元素出现（agg-view-orchestration 同款坑）',
    '实例数据目录从 ~/.taiji-dev.template 种子复制（含 Xiaomi Token Plan CN / Z.AI Coding CN 真实条目）：渠道列表是多行，展开/凭据编辑定位必须 :has-text("Mock LLM") 文本锚定（2026-11-07 第 1 轮实测：裸 span[role=button] first() 命中种子行，凭据编辑假绿、测试连接按钮找不到）',
    '「测试连接」会真实 POST {baseUrl}/chat/completions 消耗 mock server 对应模型队列一步（游标 per-model）——探针用独立模型 test-probe，与主队/端点演员互不串队',
    '重命名/压缩页模型下拉的触发器有 enabled 前提（rename-enabled-switch / setting-smart-context-switch 关闭时 disabled）——剧本运行时判态、关则先开（ensureSelectEnabled）',
    'reka-ui Select 浮层经 portal 挂 body：选项集合全局查询 [role="listbox"] [role="option"]，断言后 Escape 关闭再导航下一分区',
    '凭据编辑保存走完整 setProvider 链：apiKey 输入原字面量（ensureLlm 恒写 mock-key-not-needed）等值覆盖零语义漂移；模型清单由 buildModelsPayload 从 localModels 构造不丢失',
    '容量环触发器形态随 composer 宽度自适应（composer-density.ts:196 metrics = aggregated|expanded）——hover 双候选（composer-metrics-aggregate 优先、context-usage-ring 兜底）',
    '设置导航「供应商」徽标计数读 providers 全集（含聚合条目 +1，实测徽标 4 = 3 渠道 + 1 聚合）：nav 计数不在 V13 判据清单（渠道管理列表/网络服务商行）内，未作断言——若后续把 nav 计数纳入排除清单消费方需另行裁决',
  ]
  const extrasPath = path.join(dataDir, 'agent', 'config', 'providers.json')
  const extras = () => JSON.parse(fs.readFileSync(extrasPath, 'utf8'))
  const page = await instance.page()
  const now0 = new Date()
  ev.attach('wall-clock-at-start', `${now0.toISOString()} local=${now0.toString()} row=${todayRow(now0)} slot=${currentSlot(now0)}`)

  // ── 共用 helper ──────────────────────────────────────────────────────────────────
  const member = (id, modelId, type, table) => ({ id, providerId: PROVIDER, modelId, type, ...(table ? { window: table } : {}) })

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

  /** 等设置分区激活且其内容元素出现（visitedViews 首访挂载 + v-show 常驻）。
   *  设置 modal 已开时不得再点 sidebar-settings：modal 全屏 dialog 拦截指针
   *  （2026-11-07 第 2 轮实测：第二分区导航点侧栏按钮 15s 拦截超时）。 */
  async function openSettingsSection(ui, navKey, contentSel, label) {
    const modalOpen = await page.$('css=[role="dialog"][aria-label="设置"]')
    if (!modalOpen) {
      await ui.click('testid=sidebar-settings')
    }
    const navSel = `testid=settings-nav-${navKey}`
    await ui.expectVisible(navSel, { timeoutMs: 20_000 })
    await ui.click(navSel)
    let ok = false
    try {
      await page.waitForFunction(
        ({ nav, content }) => {
          const n = document.querySelector(`[data-testid="${nav}"]`)
          if (!n || !n.classList.contains('active')) return false
          return Boolean(document.querySelector(content))
        },
        { nav: `settings-nav-${navKey}`, content: contentSel.replace(/^css=/, '') },
        { timeout: 20_000 },
      )
      ok = true
    } catch {
      ok = false
    }
    ev.assert(`A: ${label} 分区激活并渲染`, ok, {
      channel: 'A',
      expected: `settings-nav-${navKey}.active + ${contentSel}`,
      actual: ok ? '已激活' : '20s 未激活（分区未挂载或内容元素缺失）',
    })
    return ok
  }

  /** reka Select：触发器 enabled 前提判态（关则先开对应开关），打开后读全局 option 文本集合。 */
  async function openSelectOptions(ui, triggerSel, enableSwitchSel) {
    const sel = triggerSel.startsWith('testid=')
      ? `[data-testid="${triggerSel.slice('testid='.length)}"]`
      : triggerSel.replace(/^css=/, '')
    const isDisabled = await page.$eval(sel, (el) => el.disabled === true || el.hasAttribute('data-disabled')).catch(() => false)
    if (isDisabled && enableSwitchSel) {
      await ui.click(enableSwitchSel)
      await page.waitForFunction(
        (s) => {
          const el = document.querySelector(s)
          return el && el.disabled !== true && !el.hasAttribute('data-disabled')
        },
        sel,
        { timeout: 10_000 },
      ).catch(() => { /* 超时由后续点击失败暴露 */ })
    }
    await ui.click(triggerSel)
    await ui.expectVisible('css=[role="listbox"]', { timeoutMs: 15_000 })
    const options = await page.$$eval('[role="listbox"] [role="option"]', (nodes) =>
      nodes.map((n) => (n.textContent ?? '').trim()),
    )
    return options
  }

  /** 容量浮层 hover（双形态候选）：优先独立容量环，兜底聚合按钮；以 body 文本出现为打开判据。 */
  async function hoverCapacityCard(ui) {
    for (const sel of ['testid=context-usage-ring', 'testid=composer-metrics-aggregate']) {
      try {
        await ui.expectVisible(sel, { timeoutMs: 3_000 })
        await ui.hover(sel)
        await page.waitForFunction(() => document.body.innerText.includes('无 Coding Plan'), { timeout: 10_000 })
        // HoverCardContent 挂 body portal：取 body 内含容量卡特征的浮层文本
        const text = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('[data-state="open"]')]
          const hit = nodes.find((n) => (n.innerText ?? '').includes('无 Coding Plan')) ?? nodes[0]
          return (hit?.innerText ?? document.body.innerText).slice(0, 2_000)
        })
        return { via: sel, text }
      } catch {
        /* 换下一形态候选 */
      }
    }
    return { via: '<none>', text: '' }
  }

  // ══ 0. 前提：全部演员模型在 models.json（pi modelRegistry 物理段源） ══════════════════
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')
  const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
  const endpointIds = (modelsJson.providers?.[PROVIDER]?.models ?? []).map((m) => m.id)
  const needEndpoints = [MAIN, EP_A, EP_B, PROBE]
  const endpointsReady = needEndpoints.every((id) => endpointIds.includes(id))
  ev.assert('C: 前提——全部演员模型在 agent/models.json', endpointsReady, {
    channel: 'C',
    expected: needEndpoints.join(','),
    actual: `in=${endpointIds.join(',').slice(0, 200)}`,
  })
  ev.step({ step: 'premise', channel: 'C', exitCode: endpointsReady ? 0 : 1, stats: {} })

  // ══ 1. V13 ①② 装配：一条启用中路由（双端点，含时间窗条件）（协议写侧） ═══════════════
  const route = {
    id: ROUTE,
    name: ROUTE,
    modelId: ROUTE,
    enabled: true,
    mode: 'advanced',
    members: [member('m-na', EP_A, 'none'), member('m-nb', EP_B, 'window', availableNowTable(new Date()))],
    specials: [],
  }
  const saved = await protocol.call('aggregation.saveRoute', { route }, { replyType: 'aggregation.routeSaved', timeoutMs: 60_000 })
  ev.assert(`B: aggregation.saveRoute ${ROUTE} 回执（双端点启用中）`, saved?.route?.id === ROUTE && saved?.route?.enabled === true, {
    channel: 'B',
    expected: `route.id=${ROUTE} enabled=true`,
    actual: `reply.id=${saved?.route?.id} enabled=${saved?.route?.enabled} memberIssues=${(saved?.memberIssues ?? []).length}`,
  })
  const scopedReply = await protocol.call('config.setScopedModels', { models: scopedBaseline }, { replyType: 'config.scopedModels', timeoutMs: 60_000 })
  ev.assert('B: config.setScopedModels 白名单基线回执', JSON.stringify(scopedReply?.scopedModels ?? []) === JSON.stringify(scopedBaseline), {
    channel: 'B',
    expected: JSON.stringify(scopedBaseline),
    actual: JSON.stringify(scopedReply?.scopedModels ?? null),
  })
  const routeOnDisk = (extras().routes?.routes ?? []).find((r) => r.id === ROUTE)
  ev.assert('C: V13 ② 路由落盘（enabled=true 双端点 [none, window]）', routeOnDisk?.enabled === true && routeOnDisk?.members?.[0]?.type === 'none' && routeOnDisk?.members?.[1]?.type === 'window', {
    channel: 'C',
    expected: 'enabled=true members=[none, window]',
    actual: `enabled=${routeOnDisk?.enabled} types=${(routeOnDisk?.members ?? []).map((m) => m.type).join(',')}`,
  })
  const listedSetup = await pollModelList(
    (models) => models.some((m) => m.aggregation === true && m.id === ROUTE),
    'model.list 聚合条目 v13-neighbor 在列（D4 注入自证）',
  )
  ev.step({ step: 'v13.setup', channel: 'C', exitCode: routeOnDisk?.enabled === true && listedSetup.ok ? 0 : 1, stats: {} })

  // ══ 2. 协议侧：config.getProviders 聚合条目形态（D4 注入① + 排除清单消费方过滤前提） ══
  const gp = await protocol.call('config.getProviders', {}, { timeoutMs: 60_000 })
  const aggEntry = (gp.providers ?? []).find((p) => p.id === AGG_PROVIDER_ID)
  const aggOk = Boolean(aggEntry)
    && aggEntry.kind === 'aggregation'
    && aggEntry.apiKeySet === false
    && aggEntry.status === 'not_configured'
    && !('baseUrl' in aggEntry)
    && !('quota' in aggEntry)
    && (aggEntry.models ?? []).some((m) => m.id === ROUTE)
  ev.assert('B: getProviders 聚合条目形态 = kind/aggregation + apiKeySet=false + not_configured + 无 baseUrl + 无 quota 声明', aggOk, {
    channel: 'B',
    expected: `id=${AGG_PROVIDER_ID} kind=aggregation apiKeySet=false status=not_configured 无 baseUrl 无 quota models 含 ${ROUTE}`,
    actual: JSON.stringify(aggEntry ?? null).slice(0, 500),
  })
  ev.attach('getproviders-agg-entry', JSON.stringify(aggEntry ?? null, null, 2).slice(0, 4_000))
  const nonAggIds = (gp.providers ?? []).filter((p) => p.kind !== 'aggregation').map((p) => p.id)
  ev.assert('B: 排除清单消费方的渲染输入 = 非聚合条目集合（mockllm 在列）', nonAggIds.includes(PROVIDER), {
    channel: 'B',
    expected: `kind≠aggregation 集合含 ${PROVIDER}`,
    actual: nonAggIds.join(',').slice(0, 200),
  })
  ev.step({ step: 'v13.protocol-shape', channel: 'B', exitCode: aggOk ? 0 : 1, stats: {} })

  // ══ 3. V13 ③ 供应商接入页：渠道管理列表无聚合条目、无路由分组 ═══════════════════════
  const ui = ctx.ui
  const providerSectionReady = await openSettingsSection(ui, 'provider', '[data-testid="provider-list-header"]', 'V13 ③ 供应商接入页')
  let providerRows = []
  let aggRowTextHits = 0
  if (providerSectionReady) {
    // 行集合文本（provider-card 无 per-id 属性，以行文本判行归属；激活分区限定防串页）
    providerRows = await page.$$eval('[data-testid="provider-card"]', (nodes) =>
      nodes.map((n) => (n.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)),
    )
    aggRowTextHits = providerRows.filter((t) => t.includes(AGG_DISPLAY_NAME) || t.includes(AGG_PROVIDER_ID)).length
    const noAggRow = providerRows.length >= 1 && aggRowTextHits === 0 && providerRows.some((t) => t.includes('Mock LLM'))
    ev.assert('A: V13 ③ 渠道管理列表无聚合条目行、无路由分组（既有渠道行含 Mock LLM 在列）', noAggRow, {
      channel: 'A',
      expected: `provider-card 行集合含 Mock LLM（模板种子渠道随在）且零「${AGG_DISPLAY_NAME}/${AGG_PROVIDER_ID}」行`,
      actual: `rows=${JSON.stringify(providerRows)} aggHits=${aggRowTextHits}`,
    })
    await ev.shot(page, 'v13-provider-page')
  }
  ev.step({ step: 'v13.provider-page', channel: 'A', exitCode: providerSectionReady && aggRowTextHits === 0 && providerRows.length >= 1 ? 0 : 1, stats: { rows: providerRows.length } })

  // ══ 4. V13 ④ 凭据编辑：展开既有渠道行 → 输入原值 → 保存 → apiKeySet 保持 ═══════════
  // 行定位必须文本锚定 Mock LLM 行：实例数据目录从 ~/.taiji-dev.template 种子复制（含
  // Xiaomi Token Plan CN / Z.AI Coding CN 真实条目），provider-card 多行，裸 span[role=button]
  // 会 first() 命中种子行（2026-11-07 第 1 轮实测：凭据编辑假绿、测试连接按钮找不到）。
  const mockRowExpandSel = 'css=[data-testid="provider-card"]:has-text("Mock LLM") span[role="button"]'
  {
    await ui.click(mockRowExpandSel)
    await ui.expectVisible('testid=provider-expand-body', { timeoutMs: 20_000 })
    await ui.expectVisible('testid=provider-edit-apikey', { timeoutMs: 20_000 })
    await ui.fill('testid=provider-edit-apikey', PROBE_KEY_LITERAL)
    await ui.expectVisible('testid=provider-save-bar', { timeoutMs: 10_000 })
    await ui.click('testid=provider-save-btn')
    // 保存完成：save-bar 消失（dirty 复位）+ 成功 toast
    let saveOk = false
    try {
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-testid="provider-save-bar"]')
        return !bar || bar.offsetParent === null
      }, { timeout: 25_000 })
      saveOk = true
    } catch { /* 超时由 B 通道断言承载 */ }
    const gpAfterCred = await protocol.call('config.getProviders', {}, { timeoutMs: 60_000 })
    const mockAfter = (gpAfterCred.providers ?? []).find((p) => p.id === PROVIDER)
    const credOk = mockAfter?.apiKeySet === true && (mockAfter?.models ?? []).some((m) => m.id === PROBE)
    ev.assert('B: V13 ④ 凭据编辑保存后 apiKeySet=true 保持 + 模型清单完整（凭据语义正常）', credOk, {
      channel: 'B',
      expected: `mockllm apiKeySet=true models 含 ${PROBE}`,
      actual: `apiKeySet=${mockAfter?.apiKeySet} models=${(mockAfter?.models ?? []).map((m) => m.id).join(',').slice(0, 160)}`,
    })
    ev.assert('A: V13 ④ 凭据编辑保存完成（save-bar 复位）', saveOk, {
      channel: 'A',
      expected: 'provider-save-bar 不可见（dirty 复位）',
      actual: saveOk ? '已复位' : '25s 未复位（保存编排未完成）',
    })
    ev.step({ step: 'v13.credential-edit', channel: 'A', exitCode: saveOk && credOk ? 0 : 1, stats: {} })
  }

  // ══ 5. V13 ④ 测试连接：模型行内探针测试（真打到 mock server） ══════════════════════
  {
    // 凭据保存成功后手风琴收起（useAccordionGuard.ts:84-87 onBodySaved → expandedId=null）——
    // 模型行随展开体卸载，测试连接前重新展开既有渠道行（文本锚定 Mock LLM 行，见步骤 4 注）
    await ui.click(mockRowExpandSel)
    await ui.expectVisible('testid=provider-expand-body', { timeoutMs: 20_000 })
    const testBtnSel = `css=[data-testid="model-test-${PROBE}"]`
    await ui.click(testBtnSel)
    const resultSel = `css=[data-testid="model-test-result-${PROBE}"]`
    let resultText = ''
    let resultOk = false
    try {
      await ui.expectVisible(resultSel, { timeoutMs: 60_000 })
      resultText = await ui.text(resultSel)
      resultOk = resultText.includes('连接成功')
    } catch {
      resultText = '<60s 未出结果条>'
    }
    ev.assert('A: V13 ④ 测试连接结果条 ok（连接成功）', resultOk, {
      channel: 'A',
      expected: '连接成功 · Ns',
      actual: resultText.slice(0, 120),
    })
    // C 双证：mock server 请求记录出现 test-probe 的 200
    const deadline = Date.now() + 15_000
    let probeHit = null
    while (Date.now() < deadline) {
      probeHit = instance.mockLlm.requests.find((r) => r.model === PROBE && r.status === 200) ?? null
      if (probeHit) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('C: V13 ④ 测试请求真打到 mock server（model=test-probe 200）', Boolean(probeHit), {
      channel: 'C',
      expected: `model=${PROBE} status=200`,
      actual: probeHit ? `hit stepIndex=${probeHit.stepIndex}` : `15s 未出现；requests=${JSON.stringify(instance.mockLlm.requests.map((r) => ({ m: r.model, s: r.status }))).slice(0, 200)}`,
    })
    ev.step({ step: 'v13.connection-test', channel: 'A', exitCode: resultOk && Boolean(probeHit) ? 0 : 1, stats: {} })
  }

  // ══ 6. V13 ④ 启停交互：关 → enabled=false + model.list 移出 → 开 → 恢复 ════════════
  {
    const switchSel = `css=button[role="switch"][aria-label*="Mock LLM"]`
    await ui.click(switchSel)
    let offOk = false
    {
      const deadline = Date.now() + 15_000
      for (;;) {
        const gpNow = await protocol.call('config.getProviders', {}, { timeoutMs: 60_000 })
        const mockNow = (gpNow.providers ?? []).find((p) => p.id === PROVIDER)
        if (mockNow?.enabled === false) { offOk = true; break }
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 1_000))
      }
    }
    const listGone = await pollModelList((models) => !models.some((m) => (m.providerId ?? m.provider) === PROVIDER), '启停关：model.list 移出 mockllm 全部模型', { timeoutMs: 15_000 })
    ev.assert('B: V13 ④ 启停关后 getProviders enabled=false', offOk, {
      channel: 'B',
      expected: 'mockllm enabled=false',
      actual: offOk ? '已翻转' : '15s 未翻转',
    })
    ev.step({ step: 'v13.toggle-off', channel: 'B', exitCode: offOk && listGone.ok ? 0 : 1, stats: {} })
    await ui.click(switchSel)
    let onOk = false
    {
      const deadline = Date.now() + 15_000
      for (;;) {
        const gpNow = await protocol.call('config.getProviders', {}, { timeoutMs: 60_000 })
        const mockNow = (gpNow.providers ?? []).find((p) => p.id === PROVIDER)
        if (mockNow?.enabled === true) { onOk = true; break }
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 1_000))
      }
    }
    await pollModelList((models) => models.some((m) => m.id === MAIN), '启停开：model.list 恢复 mock-1', { timeoutMs: 15_000 })
    ev.assert('B: V13 ④ 启停开后 getProviders enabled=true（启停语义恢复正常）', onOk, {
      channel: 'B',
      expected: 'mockllm enabled=true',
      actual: onOk ? '已恢复' : '15s 未恢复',
    })
    ev.step({ step: 'v13.toggle-on', channel: 'B', exitCode: onOk ? 0 : 1, stats: {} })
  }

  // ══ 7. V13 ⑤ 网络代理设置页：服务商行无聚合条目 ═════════════════════════════════════
  const networkReady = await openSettingsSection(ui, 'network-proxy', '[data-testid="network-provider-card"]', 'V13 ⑤ 网络代理页')
  if (networkReady) {
    const hostText = await page.$eval('[data-testid="network-provider-host-mockllm"]', (n) => (n.textContent ?? '').trim()).catch(() => '<行不存在>')
    const aggRow = await page.$$eval('[data-testid="network-provider-row-aggregation"], [data-testid="network-provider-host-aggregation"]', (nodes) => nodes.length).catch(() => -1)
    const rowsAll = await page.$$eval('[data-testid^="network-provider-row-"]', (nodes) => nodes.map((n) => n.getAttribute('data-testid'))).catch(() => [])
    // 行集合 = 模板种子渠道 + mockllm（第 1 轮实测 3 行）；判据核 = 零 aggregation 行 + Mock LLM 行在列
    const netOk = hostText.includes('127.0.0.1') && aggRow === 0 && rowsAll.length >= 1 && rowsAll.every((id) => !String(id).includes('aggregation')) && rowsAll.includes('network-provider-row-mockllm')
    ev.assert('A: V13 ⑤ 服务商行无聚合条目（Mock LLM 行在列、host=127.0.0.1、aggregation 行数=0）', netOk, {
      channel: 'A',
      expected: 'rows 含 network-provider-row-mockllm 且无 aggregation 行，host 含 127.0.0.1，aggregation 节点数=0',
      actual: `rows=${JSON.stringify(rowsAll)} host=${hostText} aggNodes=${aggRow}`,
    })
    await ev.shot(page, 'v13-network-page')
    ev.step({ step: 'v13.network-page', channel: 'A', exitCode: netOk ? 0 : 1, stats: { rows: rowsAll.length } })
  }

  // ══ 8. 隐式排除清单：重命名页模型下拉无路由条目 ═══════════════════════════════════════
  const renameReady = await openSettingsSection(ui, 'rename-session', '[data-testid="rename-session-page"]', '隐式排除清单·重命名页')
  if (renameReady) {
    const options = await openSelectOptions(ui, 'testid=rename-title-model', 'testid=rename-enabled-switch')
    const renameOk = options.some((t) => t.includes(MAIN)) && !options.some((t) => t.includes(ROUTE))
    ev.assert('A: 隐式排除清单·重命名页模型下拉含 mock-1 且无路由条目 v13-neighbor', renameOk, {
      channel: 'A',
      expected: `options 含 ${MAIN} 且不含 ${ROUTE}`,
      actual: `options=${JSON.stringify(options).slice(0, 300)}`,
    })
    await ui.press('Escape')
    ev.step({ step: 'v13.rename-picker', channel: 'A', exitCode: renameOk ? 0 : 1, stats: { count: options.length } })
  }

  // ══ 9. 隐式排除清单：压缩页模型下拉无路由条目（共享 useAuthedModelGroups） ════════════
  const compactReady = await openSettingsSection(ui, 'smart-context-compaction', '[data-testid="smart-context-compaction-page"]', '隐式排除清单·压缩页')
  if (compactReady) {
    const options = await openSelectOptions(ui, 'testid=setting-smart-context-model', 'testid=setting-smart-context-switch')
    const compactOk = options.some((t) => t.includes(MAIN)) && !options.some((t) => t.includes(ROUTE))
    ev.assert('A: 隐式排除清单·压缩页模型下拉含 mock-1 且无路由条目 v13-neighbor', compactOk, {
      channel: 'A',
      expected: `options 含 ${MAIN} 且不含 ${ROUTE}`,
      actual: `options=${JSON.stringify(options).slice(0, 300)}`,
    })
    await ui.press('Escape')
    ev.step({ step: 'v13.compact-picker', channel: 'A', exitCode: compactOk ? 0 : 1, stats: { count: options.length } })
  }

  // ══ 10. 隐式排除清单：套餐浮层不挂载 + 容量环无 Coding Plan 区（会话绑定聚合路由） ════
  {
    // 关闭设置页，建会话绑定聚合路由（pi 工厂期注册在 spawn 时点，路由已存在 → 可绑定）
    await ui.click('testid=settings-close-btn')
    await ui.expectGone('testid=rename-session-page', { timeoutMs: 20_000 })
    const created = await protocol.call(
      'session.create',
      { cwd: repo, label: 'agg-neighbor-v13', modelOverride: `aggregation/${ROUTE}` },
      { timeoutMs: 120_000 },
    )
    const sid = created.session?.id
    ev.assert('B: 会话创建（modelOverride=聚合路由）', Boolean(sid), {
      channel: 'B',
      expected: 'session.id 非空',
      actual: `sid=${sid}`,
    })
    // 绑定权威读：session.create 回执不带 modelId 字段（第 3 轮实测 model=<n/a>）——
    // 按 agg-view-orchestration 同款 getState 条件轮询验证绑定
    let stateModel = null
    {
      const deadline = Date.now() + 20_000
      for (;;) {
        stateModel = (await protocol.call('session.getState', { sessionId: sid }, { timeoutMs: 60_000 }))?.modelId ?? null
        if (stateModel === `aggregation/${ROUTE}`) break
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    ev.assert('B: 会话绑定聚合路由（getState 权威读）', stateModel === `aggregation/${ROUTE}`, {
      channel: 'B',
      expected: `getState.modelId=aggregation/${ROUTE}`,
      actual: `modelId=${stateModel ?? '<none>'}`,
    })
    // 侧栏点击进入会话（协议创建不切 UI 激活会话，agg-view-orchestration 同款坑）
    const rowSel = 'text=agg-neighbor-v13'
    try {
      await ui.expectVisible(rowSel, { timeoutMs: 3_000 })
    } catch {
      await ui.click('text=默认项目') // 分组折叠时先展开
      await ui.expectVisible(rowSel, { timeoutMs: 5_000 })
    }
    await ui.click(rowSel)
    await ui.expectVisible('testid=composer-box', { timeoutMs: 20_000 })
    // 套餐浮层：entries 空（零 quota.enabled 条目）→ Panel.vue v-if 不挂载
    const floatCount = await page.$$eval('[data-testid="plan-quota-float"], [data-testid="plan-quota-rail"]', (nodes) => nodes.length).catch(() => -1)
    ev.assert('A: 隐式排除清单·套餐浮层零 DOM（quota.enabled 过滤 → entries 空不挂载）', floatCount === 0, {
      channel: 'A',
      expected: 'plan-quota-float / plan-quota-rail 节点数=0',
      actual: `count=${floatCount}`,
    })
    // 容量环：hover 触发容量浮层 → footer「无 Coding Plan」（ContextCapacityCard.vue:112-118
    // footer 三分支互斥：「无 Coding Plan」仅在 matchedProviderId falsy 分支渲染，此时
    // Coding Plan 区（v-if="matchedProviderId" :54）整体不渲染——单一条件即完整判据；
    // 不可加 !includes('Coding Plan') 反断言（「无 Coding Plan」文案自身含该子串，第 3 轮实测误杀）
    const cap = await hoverCapacityCard(ui)
    const capOk = cap.text.includes('无 Coding Plan')
    ev.assert('A: 隐式排除清单·容量环浮层无 Coding Plan 区（matchedProviderId 不命中聚合 provider）', capOk, {
      channel: 'A',
      expected: '浮层含「无 Coding Plan」（互斥 footer 分支 = Coding Plan 区未渲染）',
      actual: `via=${cap.via} text=${cap.text.replace(/\n/g, ' | ').slice(0, 200)}`,
    })
    await ev.shot(page, 'v13-capacity-float')
    ev.step({ step: 'v13.quota-surfaces', channel: 'A', exitCode: floatCount === 0 && capOk ? 0 : 1, stats: {} })
  }

  // ══ 11. 终态 C 核对 ═══════════════════════════════════════════════════════════════
  const finalExtras = extras()
  const finalRoutes = finalExtras.routes?.routes ?? []
  const finalOk = finalRoutes.length === 1 && finalRoutes[0]?.id === ROUTE
    && JSON.stringify(finalExtras.scopedModels ?? []) === JSON.stringify(scopedBaseline)
  ev.assert('C: 终态 routes 一条 + scopedModels 与装配一致', finalOk, {
    channel: 'C',
    expected: `routes=[${ROUTE}] scoped=${JSON.stringify(scopedBaseline)}`,
    actual: `routes=${finalRoutes.map((r) => r.id).join(',')} scoped=${JSON.stringify(finalExtras.scopedModels ?? null)}`,
  })
  ev.attach('extras-final', JSON.stringify(finalExtras, null, 2).slice(0, 8_000))
  ev.attach('mock-requests-summary', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status })), null, 2))
  ev.step({ step: 'final-state', channel: 'C', exitCode: finalOk ? 0 : 1, stats: { routes: finalRoutes.length } })

  log(`agg-neighbor-surfaces done`)
  return { uncovered, gotchas }
}
