/**
 * tray-composition —— composer-tray-protocol A1+A7（真机托盘组成，V1+V6）：
 *
 * A1（V1/GL1）：托盘纳入 placement 声明制后的托盘组成——
 *   - probe-container-plugin（声明 drawer.tab/overlay.content，无 composer.tray 声明）
 *     随 built-in 装载并向焦点会话推树后，托盘无其按钮（无四格方块兜底图标、
 *     无 probe-container-plugin.* 悬停标题）；
 *   - scheduler-manager（host.embed 声明，宿主内嵌族）托盘无按钮（host.embed 非托盘位）；
 *   - probe 声明的 drawer.tab 位照常出现在右抽屉标签条（「探针面板」，验收用途不回退）。
 *
 * A7（V6/GL4）：第三方插件按新协议声明托盘位——fixture 插件清单 contributes.views
 *   声明 { placement: 'composer.tray', title, icon } + 推树带 meta { badge, status }，
 *   托盘出现带声明 title 与 icon 的按钮（无 viewId 裸标题）、角标按 meta 渲染、
 *   status=running 呼吸点在场；面板内容为推送的树（富行字段渲染）。
 *
 * 装配（import 阶段执行，先于 instance.launch）：fixture 插件 tray-fixture-demo
 * （零 import 纯 ESM sandbox 插件，permissions.json 预批 = 审批门静默通过）写
 * <dataDir>/plugins/；激活挂 api.sessions.onDidActivateSession 向焦点会话推
 * list-tree（富行字段）+ meta。
 *
 * 运行（run.mjs 通道）：
 *   node .agents/skills/verify-taiji/scripts/run.mjs scenarios/tray-composition.mjs \
 *     --repo <worktree> --artifacts-dir <dir> --name verify-a1a7-tray-composition \
 *     --data-dir ~/.taiji-dev/verify-a1a7-tray-comp-<ts> --run-id a1a7-<ts>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import { waitPluginActive } from './lib/plugin-provider-fixture.mjs'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLUGIN_ID = 'tray-fixture-demo'
const VIEW_ID = 'tray-fixture-demo.main'
const DECLARED_TITLE = '验收托盘件'
const DECLARED_ICON = 'clock'
const ROW_LABEL = 'fixture 行主名'
const ROW_SUB_LABEL = 'fixture 副文本'

// ── 顶层预置（import 阶段，先于 instance.launch）────────────────────
const dataDir0 = resolveDataDirFromArgv()
const pluginDir = path.join(dataDir0, 'plugins', PLUGIN_ID)
fs.mkdirSync(pluginDir, { recursive: true })
fs.writeFileSync(
  path.join(pluginDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@verify/tray-fixture-demo',
      version: '0.1.0',
      private: true,
      type: 'module',
      displayName: 'TrayFixtureDemo',
      description: 'composer-tray-protocol A7 fixture: declares composer.tray and pushes rich rows with meta',
      taijiPlugin: {
        manifestVersion: 1,
        main: 'index.js',
        activationEvents: ['onStartupFinished'],
        permissions: ['plugin.views.update', 'sessions.readState'],
        contributes: {
          views: [{ id: VIEW_ID, placement: 'composer.tray', title: DECLARED_TITLE, icon: DECLARED_ICON }],
        },
      },
    },
    null,
    2,
  )}\n`,
)
fs.writeFileSync(
  path.join(pluginDir, 'index.js'),
  `// verify-taiji fixture（composer-tray-protocol A7；零 import 纯 ESM，动作全经 api RPC）
const VIEW_ID = '${VIEW_ID}'
const TREE = [
  {
    type: 'list-tree',
    props: {
      items: [
        { id: 'fixture-row-1', label: '${ROW_LABEL}', subLabel: '${ROW_SUB_LABEL}', status: 'running' },
      ],
    },
  },
]
export async function activate(ctx) {
  const api = ctx.api
  api.sessions.onDidActivateSession(async (session) => {
    try {
      await api.views.update(VIEW_ID, TREE, { sessionId: session.id, meta: { badge: '3', status: 'running' } })
    } catch (e) {
      console.warn('[tray-fixture] views.update failed:', e)
    }
  })
}
export async function deactivate() {}
`,
)
// 权限预批（审批门静默通过，等价已批准态——p1-plugin 场景同款）
fs.mkdirSync(path.join(dataDir0, 'plugins'), { recursive: true })
fs.writeFileSync(
  path.join(dataDir0, 'plugins', 'permissions.json'),
  `${JSON.stringify({ [PLUGIN_ID]: ['plugin.views.update', 'sessions.readState'] }, null, 2)}\n`,
)

export const meta = {
  id: 'tray-composition',
  priority: 'P0',
  title: 'composer-tray-protocol A1+A7（V1+V6）：托盘组成声明制——probe/scheduler-manager 零托盘按钮、fixture 插件声明 composer.tray 按声明渲染 title/icon 与 meta badge/status、probe drawer.tab 照常',
  covers: ['render.tray', 'plugin.views'],
  requires: [],
  estimateSec: 240,
  provable: [
    'A1: 托盘无 probe-container-plugin 按钮（声明制过滤——无 [data-widget-key=probe-container-plugin.tab] 按钮、全托盘 aria-label 无 probe 字样、无 LayoutGrid 兜底图标按钮）',
    'A1: 托盘无 scheduler-manager 按钮（host.embed 非托盘位；aria-label 无 scheduler-manager 字样）',
    'A1: probe 的 drawer.tab 位照常在右抽屉标签条（「探针面板」）',
    'A7: fixture 插件托盘按钮在场，title 属性/aria-label 为声明 title（非 viewId 裸标题）',
    'A7: 按钮角标 = meta.badge（3）、status=running 呼吸点在场（meta 动态信息渲染）',
    'A7: 按钮 icon 为声明 icon（clock → lucide-clock svg）',
    'A7: 点开面板 = 推送的树（富行字段渲染：主名/subLabel/状态胶囊）',
  ],
}

export async function run(ctx) {
  const { ev, protocol, log } = ctx
  const uncovered = []
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  const page = await ctx.instance.page()
  const ui = createUI({ page, evidence: ev, repo: ctx.repo })

  ev.step({
    step: 'fixture.seed',
    channel: 'C',
    exitCode: 0,
    stats: { dataDir: dataDir0, pluginId: PLUGIN_ID, viewId: VIEW_ID, declaredTitle: DECLARED_TITLE },
  })

  await waitPluginActive(protocol, PLUGIN_ID)
  ev.assert('fixture 插件激活（sandbox fork + 预批权限，status=active）', true, { channel: 'C' })

  // 建会话 → 焦点激活 → probe（drawer/overlay 两 view）与 fixture（composer.tray view）
  // 都经 onDidActivateSession 向该会话推树
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-comp-proj-'))
  await protocol.call(
    'session.create',
    { id: 'tray-comp-create', payload: { cwd: projectDir, label: 'tray-comp' } },
    { replyType: 'session.created', timeoutMs: 30_000 },
  )
  ev.step({ step: 'session.create', channel: 'C', exitCode: 0, stats: { projectDir } })

  // ── A7：fixture 声明制渲染 ──────────────────────────────────────────
  const fixtureButton = page.locator('[data-testid="tray-widget-button"][data-widget-key="' + VIEW_ID + '"]')
  await fixtureButton.waitFor({ state: 'visible', timeout: 45_000 })
  ev.assert('A7: fixture 托盘按钮在场（data-widget-key=声明 viewId）', true, { channel: 'A' })

  // 声明 title 第一档（D7 兜底链：声明 title ?? meta.title ?? viewId——badge 在场时
  // 悬停 title 为宿主模板「{title} · {badge}」，断言含声明 title 且不含 viewId 裸标题）
  const titleAttr = await fixtureButton.getAttribute('title')
  const ariaLabel = await fixtureButton.getAttribute('aria-label')
  ev.assert(
    'A7: 按钮标题走声明 title（title/aria-label 含「验收托盘件」，不含 viewId 裸标题）',
    Boolean(titleAttr && titleAttr.includes(DECLARED_TITLE) && !titleAttr.includes(VIEW_ID)) &&
      Boolean(ariaLabel && ariaLabel.includes(DECLARED_TITLE) && !ariaLabel.includes(VIEW_ID)),
    { channel: 'A', expected: `title≈「${DECLARED_TITLE} · 3」`, actual: `title=${titleAttr} aria=${ariaLabel}` },
  )

  // 声明 icon（D7：声明 lucide 名 → §6.13 白名单解析 → lucide-clock svg）
  const declaredIcon = await fixtureButton.locator('svg.lucide-clock').count()
  ev.assert('A7: 按钮 icon 为声明 icon（clock → svg.lucide-clock）', declaredIcon >= 1, {
    channel: 'A',
    expected: 'svg.lucide-clock ≥1',
    actual: String(declaredIcon),
  })

  // meta 动态信息：badge=3（meta.badge 第一档）+ status=running 呼吸点
  const badgeText = await fixtureButton.locator('[data-testid="tray-widget-badge"]').textContent()
  ev.assert('A7: 角标 = meta.badge（3）', badgeText === '3', {
    channel: 'A',
    expected: '3',
    actual: badgeText ?? '(absent)',
  })
  const pulseCount = await fixtureButton.locator('[data-testid="tray-widget-pulse"]').count()
  ev.assert('A7: status=running → 呼吸点在场（meta.status 渲染）', pulseCount >= 1, {
    channel: 'A',
    expected: 'pulse ≥1',
    actual: String(pulseCount),
  })

  // 面板内容 = 推送的树（富行字段渲染）
  await fixtureButton.click()
  const fixturePanel = page.locator('[data-testid="tray-panel"][data-panel-key="widget:' + VIEW_ID + '"]')
  await fixturePanel.waitFor({ state: 'visible', timeout: 10_000 })
  const rowLabelVisible = await fixturePanel.getByText(ROW_LABEL).first().isVisible()
  const rowSubLabel = await fixturePanel.locator('[data-testid="list-tree-sub-label"]').first().textContent()
  ev.assert(
    'A7: 面板内容为推送树且富行字段渲染（主名 + subLabel 副文本）',
    rowLabelVisible && rowSubLabel === ROW_SUB_LABEL,
    { channel: 'A', expected: ROW_SUB_LABEL, actual: rowSubLabel ?? '(absent)' },
  )
  // pin 态 fixture 面板保持打开——不遮挡托盘按钮与抽屉标签条，后续 A1 断言照常驱动

  // ── A1：声明制过滤（probe / scheduler-manager 零托盘）───────────────
  const probeButtonCount = await page
    .locator('[data-testid="tray-widget-button"][data-widget-key="probe-container-plugin.tab"]')
    .count()
  const schedulerButtonCount = await page
    .locator('[data-testid="tray-widget-button"][data-widget-key="modal-scheduler-manager-scheduler-manager.panel"]')
    .count()
  ev.assert(
    'A1: 托盘无 probe/scheduler-manager 按钮（声明制过滤——两 viewId 键均 0）',
    probeButtonCount === 0 && schedulerButtonCount === 0,
    { channel: 'A', expected: '0/0', actual: `${probeButtonCount}/${schedulerButtonCount}` },
  )

  // 负面扫描：全托盘按钮 aria-label 无 probe/scheduler-manager 字样（viewId 裸标题形态）+
  // 无 LayoutGrid 兜底图标按钮（probe 曾以四格方块冒出）
  const allButtons = page.locator('[data-testid="tray-widget-button"]')
  const allLabels = (await allButtons.all()).map((b) => b.getAttribute('aria-label'))
  const labels = (await Promise.all(allLabels)).join('\n')
  const fallbackIcons = await page
    .locator('[data-testid="tray-widget-button"] svg.lucide-layout-grid')
    .count()
  ev.assert(
    'A1: 全托盘无 viewId 裸标题（probe/scheduler-manager 字样）且无 LayoutGrid 兜底图标',
    !labels.includes('probe-container-plugin') &&
      !labels.includes('scheduler-manager') &&
      fallbackIcons === 0,
    { channel: 'A', expected: '无裸标题/无兜底图标', actual: `fallbackIcons=${fallbackIcons}` },
  )

  // probe 声明的 drawer.tab 位照常（右抽屉标签条「探针面板」，验收用途不回退）
  await page.getByTestId('drawer-toggle').click()
  const drawerArea = page.getByTestId('drawer-area')
  await drawerArea.waitFor({ state: 'visible', timeout: 10_000 })
  const probeTabVisible = await drawerArea.getByText('探针面板').first().isVisible()
  ev.assert('A1: probe 的 drawer.tab 位照常（右抽屉「探针面板」标签）', probeTabVisible, {
    channel: 'A',
    expected: 'drawer 内「探针面板」可见',
  })
  await page.keyboard.press('Escape')

  ev.step({
    step: 'tray.composition.done',
    channel: 'A',
    exitCode: 0,
    stats: { probeButtons: probeButtonCount, schedulerButtons: schedulerButtonCount, fixtureRendered: true },
  })

  if (uncovered.length > 0) log('uncovered: ' + uncovered.join('; '))
  return { uncovered }
}
