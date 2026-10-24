/**
 * p1-plugin-a17-status-report —— D3 验收场景 A17（设计 S17，核心）：
 * 状态上报与拉取补齐（plugin:event 推送 + getStatus 拉取双通道；未上报条目无标记）。
 *
 * 装配：runner 单实例（scenario 顶层 import 阶段 seed）+ 双 fixture 插件：
 *   - a17-status-wool（动态 pluginFixture）：getStatus 返回插件侧当前状态；set-status
 *     方法（plugin.invoke 入口）改状态并可选经 api.events.report 上报
 *     （channel='provider.credentialStatus'，payload 含 providerId——PluginProviderSource
 *     消费契约）；激活即 providers.write 写本命名空间 provider 条目（displayName 驱动行名）；
 *   - demo-wool（静态文件，S5 对照）：getStatus 恒 null、从不 report。
 *
 * 路径：
 *   C：models.json 落盘 status-wool-prov（providers.write 正面）→
 *   A：Provider 页双行（StatusWool / DemoWool）→
 *   ③ 未上报零标记：展开 StatusWool 行 → provider-plugin-status 零 DOM（4s 窗口）→
 *   ① 上报 → 标记出现：invoke set-status(invalid + message + report) → pollUntil
 *   provider-plugin-status 出现、文案命中、warn 配色（推送通道 plugin:event 生效）→
 *   ② 拉取补齐：收起行 → invoke set-status(valid + 新文案 + 不上报)（模拟推送丢失——
 *   renderer 内存态停留在 v1）→ 重新展开 → pollUntil 标记变为 v2 文案 + success 配色
 *   （watch expandedId → pullStatus → invoke getStatus 拉取收敛；若拉取未发生则停留在
 *   v1 判负）→ B：invoke getStatus 直读 v2（与 UI 同源第二视角）→
 *   对照：demo-wool 行展开后 provider-plugin-status 仍零 DOM（S5 语义在 A17 同页复认）。
 *
 * 锚点事实（源码已核对）：CREDENTIAL_STATUS_CHANNEL='provider.credentialStatus'
 * （PluginProviderSource.ts）；provider-plugin-status 仅在 credentialStatus 非 undefined
 * 时渲染（ProviderRowCard.vue，valid=success 配色 / invalid=warn 配色 + 状态点）；展开触发
 * pullStatus = ProviderPage.vue watch(expandedId) → invokePlugin(getStatus)；statusMap 是
 * renderer 模块级单例（页内跨展开保持，推送丢失由下次展开拉取收敛——ADR-0155 拉为主）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { pluginFixture, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import {
  seedMultiPluginFixture,
  waitPluginActive,
  seedDemoProvider,
  openProviderPage,
  providerCardSelector,
  expandProviderRow,
  pollUntil,
  DEMO_PLUGIN_ID,
  DEMO_ROW_NAME,
  DEMO_PROVIDER_ID,
  GRANTED_METHODS as DEMO_GRANTED,
} from './lib/plugin-provider-fixture.mjs'

const STATUS_PLUGIN_ID = 'a17-status-wool'
const STATUS_NS = 'status-wool'
const STATUS_PROVIDER_ID = 'status-wool-prov'
const STATUS_ROW_NAME = 'StatusWool (verify fixture)'
const STATUS_V1_MESSAGE = 'A17 登录态已过期'
const STATUS_V2_MESSAGE = 'A17 已恢复'

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugin-provider')

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
// status 插件经 set-status 方法驱动状态（plugin.invoke 入口）；report=true 时经
// api.events.report 上报（plugin:event 推送通道），false 时只改插件侧内存（模拟推送丢失
// ——此后 UI 只能靠展开时 pullStatus 拉取补齐）。
const dataDir0 = resolveDataDirFromArgv()
const seedSummary = seedMultiPluginFixture(dataDir0, {
  plugins: [
    pluginFixture({
      dirName: STATUS_PLUGIN_ID,
      pkgName: '@verify/plugin-status-wool',
      displayName: 'StatusWool',
      description: 'A17 fixture: credential status via getStatus pull + plugin:event push (set-status method)',
      namespace: STATUS_NS,
      permissions: ['plugin.views.update', 'plugin.commands.register', 'plugin.commands.invoke.result', 'plugin.event', 'providers.write'],
      activateBody: `
  const state = { status: null }
  await api.commands.register({ id: 'getStatus' }, () => state.status)
  await api.commands.register({ id: 'set-status' }, (args) => {
    state.status = { state: args.state, message: args.message }
    if (args.report) {
      return api.events.report('provider.credentialStatus', { providerId: '${STATUS_PROVIDER_ID}', state: args.state, message: args.message })
        .then(() => ({ applied: true, reported: true }))
    }
    return { applied: true, reported: false }
  })
  await api.providers.write({ providerId: '${STATUS_PROVIDER_ID}', apiKey: 'A17-STATUS-KEY', displayName: '${STATUS_ROW_NAME}', models: [{ id: 'a17-status-model' }] })
`,
    }),
    {
      dirName: DEMO_PLUGIN_ID,
      files: {
        'package.json': fs.readFileSync(path.join(FIXTURE_DIR, 'demo-wool.package.json'), 'utf8'),
        'index.js': fs.readFileSync(path.join(FIXTURE_DIR, 'demo-wool.index.js'), 'utf8'),
      },
    },
  ],
  permissionSpecs: {
    [STATUS_PLUGIN_ID]: ['plugin.views.update', 'plugin.commands.register', 'plugin.commands.invoke.result', 'plugin.event', 'providers.write'],
    [DEMO_PLUGIN_ID]: DEMO_GRANTED,
  },
  catalogPlugins: [
    {
      packageName: '@verify/plugin-status-wool',
      pluginId: STATUS_PLUGIN_ID,
      displayName: 'StatusWool',
      description: 'A17 status-report family (installed)',
      pluginVersion: '0.1.0',
      family: { id: STATUS_NS, displayName: 'StatusWool', vendor: 'verify', credentialSource: 'oauth', modelCount: 1 },
    },
    {
      packageName: 'demo-wool',
      pluginId: DEMO_PLUGIN_ID,
      displayName: 'DemoWool',
      description: 'S5 control family (never reports status)',
      pluginVersion: '0.1.0',
      family: { id: DEMO_PLUGIN_ID, displayName: 'DemoWool', vendor: '演示厂商', credentialSource: 'ide-extract', modelCount: 3 },
    },
  ],
})

export const meta = {
  id: 'p1-plugin-a17-status-report',
  priority: 'P1',
  title: 'D3/A17（设计 S17）：凭据状态推送 → 标记出现；重展开 getStatus 拉取补齐（推送丢失收敛）；未上报条目零标记',
  covers: ['settings.provider', 'plugin.list', 'plugin.invoke'],
  requires: [],
  estimateSec: 240,
  provable: [
    'C: models.json 落盘 status-wool-prov 条目（插件 providers.write 正面路径，含 apiKey）',
    'A: 未上报时展开 StatusWool 行 provider-plugin-status 零 DOM（宿主不猜测，4s 窗口）',
    'A: plugin:event 上报 invalid → provider-plugin-status 出现 + 文案命中 + warn 配色（推送通道生效）',
    'A: 上报后改状态不上报（模拟推送丢失）→ 重新展开 → 标记经 getStatus 拉取补齐为 valid 新文案 + success 配色（若拉取未发生停留在旧态判负）',
    'B: plugin.invoke getStatus 直读 = v2 状态（与 UI 补齐结果同源）',
    'A: 对照条目 demo-wool（从不 report）展开后仍零标记（S5 语义复认）',
  ],
  notProvable: [
    'plugin:event 帧级丢失注入（无脚本化丢帧通道——「推送丢失」以「改状态但不上报」等价模拟：renderer 内存态停留在旧值，展开拉取是唯一收敛通道）',
    'statusMap 跨页重载持久（模块级单例的内存语义；页面重载后靠展开拉取重建，本剧本不重载页面）',
    '羊毛真实凭据校验时序（设计 D5：getStatus 同步返回插件本地已知状态，上游校验异步上报——demo fixture 直接驱动两通道）',
  ],
}

export async function run(ctx) {
  const { ev, log, protocol, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    '状态两通道：plugin:event 推送（增量提示）与展开时 invoke getStatus 拉取（权威收敛，ADR-0155 拉为主）——推送丢失由下次展开收敛，无推送补偿机制',
    'statusMap 是 renderer 模块级单例：页内收起再展开不重置；「未上报」的判定 = getStatus 返回 null → map 删除该 key → 零 DOM',
    '标记渲染判据 = credentialStatus 非 undefined（ProviderRowCard）；配色 valid=bg-success / invalid=bg-warn，宿主不做状态推断',
    'set-status 的 report=true 走 api.events.report（plugin.event RPC → plugin:event 广播帧）；report=false 只改插件侧内存——两条通道的差分即本场景的拉取补齐判据',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  const page = await ctx.instance.page()
  const ui = createUI({ page, evidence: ev, repo })
  const proto = protocol

  ev.step({ step: 'fixture.seed', channel: 'C', exitCode: 0, stats: { dataDir, plugins: seedSummary.pluginDirs.length, statusProviderId: STATUS_PROVIDER_ID } })

  // 双插件激活（sandbox fork + 模块加载 + activate 全链）
  await waitPluginActive(proto, STATUS_PLUGIN_ID)
  await waitPluginActive(proto, DEMO_PLUGIN_ID)

  // C：providers.write 落盘（插件激活时写入）
  const written = await pollUntil(() => {
    try {
      const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
      return models.providers?.[STATUS_PROVIDER_ID]?.apiKey === 'A17-STATUS-KEY'
    } catch {
      return false
    }
  }, { timeoutMs: 20_000, label: 'models.json 落盘 status-wool-prov' })
  ev.assert('C: models.json 落盘 status-wool-prov（providers.write 正面路径）', written !== null, {
    channel: 'C',
    expected: `${STATUS_PROVIDER_ID}.apiKey=A17-STATUS-KEY`,
    actual: written !== null ? '命中' : '20s 内未落盘',
  })

  // demo-wool 条目（宿主写策略链 = 对照行的 provider 数据）
  await seedDemoProvider(proto, dataDir, ev)

  // A：Provider 页双行
  await openProviderPage(ui)
  const statusCard = providerCardSelector(STATUS_ROW_NAME)
  const demoCard = providerCardSelector(DEMO_ROW_NAME)
  await ui.expectVisible(`${statusCard} [data-testid="provider-plugin-badge"]`)
  await ui.expectVisible(`${demoCard} [data-testid="provider-plugin-badge"]`)
  ev.step({ step: 'provider-page.rows', channel: 'A', exitCode: 0, stats: { rows: [STATUS_ROW_NAME, DEMO_ROW_NAME] } })

  // ③ 未上报零标记（展开 StatusWool；插件 getStatus 初始 null）
  await expandProviderRow(ui, STATUS_ROW_NAME)
  await ui.expectVisible(`${statusCard} [data-testid="provider-detail-extra-boundary"]`, { timeoutMs: 20_000 })
  const appeared0 = await pollUntil(async () => {
    const n = await page.locator(`${statusCard} [data-testid="provider-plugin-status"]`).count()
    return n > 0
  }, { timeoutMs: 4_000 })
  ev.assert('A: 未上报时展开条目零标记（provider-plugin-status 零 DOM）', appeared0 === null, {
    channel: 'A',
    expected: '4s 窗口内保持 0（getStatus=null → 宿主不猜测）',
    actual: appeared0 === null ? '窗口内保持 0' : '出现标记行（宿主猜测了状态）',
  })

  // ① plugin:event 上报 → 标记出现（invalid + warn 配色）
  const reportReply = await proto.call('plugin.invoke', {
    pluginId: STATUS_PLUGIN_ID,
    method: 'set-status',
    params: { state: 'invalid', message: STATUS_V1_MESSAGE, report: true },
  }, { timeoutMs: 30_000 })
  ev.step({ step: 'status.report.v1', channel: 'B', exitCode: 0, stats: { reply: reportReply?.result ?? reportReply } })
  const shownV1 = await pollUntil(async () => {
    const n = await page.locator(`${statusCard} [data-testid="provider-plugin-status"]`).count()
    return n > 0
  }, { timeoutMs: 15_000 })
  ev.assert('A: plugin:event 上报后标记出现（推送通道生效）', shownV1 !== null, {
    channel: 'A',
    expected: 'provider-plugin-status 渲染',
    actual: shownV1 !== null ? '出现' : '15s 未出现（上报或广播链路断，见截图）',
  })
  await ui.screenshot('a17-status-invalid')
  const v1 = await page.evaluate((rowName) => {
    const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')].find((el) => el.textContent?.includes(rowName))
    const el = cardEl?.querySelector('[data-testid="provider-plugin-status"]')
    return { text: el?.textContent ?? '(missing)', cls: el?.getAttribute('class') ?? '' }
  }, STATUS_ROW_NAME)
  ev.assert('A: 标记文案与 warn 配色命中 v1 上报内容', v1.text.includes(STATUS_V1_MESSAGE) && v1.cls.includes('text-warn'), {
    channel: 'A',
    expected: `文案含「${STATUS_V1_MESSAGE}」+ text-warn`,
    actual: `text=${JSON.stringify(v1.text)} cls=${v1.cls}`,
  })

  // ② 拉取补齐：收起（不上报地改状态 = 模拟推送丢失）→ 重展开 → getStatus 拉取收敛
  await ui.click(`${statusCard} span[role="button"]`)
  await ui.expectGone(`${statusCard} [data-testid="provider-expand-body"]`, { timeoutMs: 10_000 })
  await proto.call('plugin.invoke', {
    pluginId: STATUS_PLUGIN_ID,
    method: 'set-status',
    params: { state: 'valid', message: STATUS_V2_MESSAGE, report: false },
  }, { timeoutMs: 30_000 })
  ev.step({ step: 'status.change.v2.silent', channel: 'B', exitCode: 0, stats: { reported: false } })

  await expandProviderRow(ui, STATUS_ROW_NAME)
  const pulledV2 = await pollUntil(async () => {
    const el = await page.evaluate((rowName) => {
      const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')].find((x) => x.textContent?.includes(rowName))
      return cardEl?.querySelector('[data-testid="provider-plugin-status"]')?.textContent ?? null
    }, STATUS_ROW_NAME)
    return el !== null && el.includes(STATUS_V2_MESSAGE)
  }, { timeoutMs: 15_000 })
  ev.assert('A: 重新展开后标记经 getStatus 拉取补齐（v2 文案出现，推送丢失被收敛）', pulledV2 !== null, {
    channel: 'A',
    expected: `标记更新为「${STATUS_V2_MESSAGE}」（拉取补齐）`,
    actual: pulledV2 !== null ? '命中' : `15s 未更新（拉取通道未生效，停留 v1「${STATUS_V1_MESSAGE}」）`,
  })
  const v2 = await page.evaluate((rowName) => {
    const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')].find((el) => el.textContent?.includes(rowName))
    const el = cardEl?.querySelector('[data-testid="provider-plugin-status"]')
    return { text: el?.textContent ?? '(missing)', cls: el?.getAttribute('class') ?? '' }
  }, STATUS_ROW_NAME)
  ev.assert('A: 补齐后标记为 success 配色（valid 态）', v2.cls.includes('text-success'), {
    channel: 'A',
    expected: 'class 含 text-success',
    actual: v2.cls,
  })
  await ui.screenshot('a17-status-valid-pulled')

  // B：getStatus 直读（与 UI 同源第二视角）
  const direct = await proto.call('plugin.invoke', {
    pluginId: STATUS_PLUGIN_ID, method: 'getStatus', params: { providerId: STATUS_PROVIDER_ID },
  }, { timeoutMs: 30_000 })
  ev.assert('B: getStatus 直读 = v2 状态（state=valid + message）', direct?.result?.state === 'valid' && direct?.result?.message === STATUS_V2_MESSAGE, {
    channel: 'B',
    expected: `{state:'valid', message:'${STATUS_V2_MESSAGE}'}`,
    actual: JSON.stringify(direct?.result ?? direct)?.slice(0, 200),
  })

  // 对照：demo-wool（从不 report、getStatus 恒 null）展开后仍零标记（S5 复认）
  await ui.click(`${statusCard} span[role="button"]`)
  await ui.expectGone(`${statusCard} [data-testid="provider-expand-body"]`, { timeoutMs: 10_000 })
  await expandProviderRow(ui, DEMO_ROW_NAME)
  await ui.expectVisible(`${demoCard} [data-testid="provider-detail-extra-boundary"]`, { timeoutMs: 20_000 })
  const demoAppeared = await pollUntil(async () => {
    const n = await page.locator(`${demoCard} [data-testid="provider-plugin-status"]`).count()
    return n > 0
  }, { timeoutMs: 4_000 })
  ev.assert('A: 对照条目 demo-wool 展开后仍零标记（statusMap 分区按 providerId 隔离，S5 复认）', demoAppeared === null, {
    channel: 'A',
    expected: '4s 窗口内保持 0（demo 插件两通道均无数据）',
    actual: demoAppeared === null ? '窗口内保持 0' : '出现标记（状态串扰到其他条目）',
  })
  ev.attach('a17-status-entries', JSON.stringify({ statusProviderId: STATUS_PROVIDER_ID, demoProviderId: DEMO_PROVIDER_ID, v1: STATUS_V1_MESSAGE, v2: STATUS_V2_MESSAGE }))

  log('a17 done')
  return { uncovered, gotchas }
}
