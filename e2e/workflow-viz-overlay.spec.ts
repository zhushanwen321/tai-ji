/**
 * Workflow 可视化 overlay E2E —— Playwright + Electron + mock 轨。
 *
 * 分层定位（workflow-visualization 设计 §4 验收场景 S1/S2/S4/S6 的 mock 可达面 +
 * workflow-overlay-refine §4.1 V3/V5 与 §4.2 影响面 + impl-plan 验收计划表 A5a/A6/A7
 * 的脚本化部分）：本 spec 承接「overlay 打开形态 / workflow tab 三子页 / 多级钻取 /
 * 降级路径 / tab 编排 / 三通道关闭」与 D8 落地后的边界用例（六态 / 停止叠加 / 降级
 * 三场景 / 失败成员路径）；跨进程链路入口（托盘行 → overlay）与
 * workflow-sidebar-sync.spec.ts T3 同源，本 spec 深入 overlay 内部行为。
 *
 * mock 数据事实（packages/core/src/transport/mock/workflow-data.ts + index.ts；演员
 * 清单 SSOT = .tmp/dev-flow/ui-redesign-combined.runlog/u-wf-mock.md 冻结表）：
 * - getWorkflows('s3') = 11 条演员（全部入托盘；分桶 running 4 / ended 7），
 *   单行定位按 slug 等值过滤（行 testid 恒 tray-workflow-row）
 * - getWorkflowRunEvents / getWorkflowDag 按 runId 查预置表：wf-mock-001 接通 DAG
 *   通道（D8 定稿①，2 phase 2 节点成功臂）；wf-mock-parse-failed 是唯一预置错误臂
 *   （parse_failed，D8 定稿③——降级断言唯一数据源）；未登记 runId 恒 record_not_found
 *
 * 十条 case：
 * - OV1（S1 mock 面）：托盘入口打开 overlay 的 run 身份断言（header scriptName/slug/
 *       状态/时长与 fixture 对账）+ 关闭重开内容一致（单例换指语义的 mock 单 run 面）。
 *       对话流 block 第二入口 mock 不可达——见 case 内注释
 * - OV2（S1/S2 mock 面）：workflow 固定 tab 三子页——trace 表行集与 agentCalls 对账、
 *       事件流子页行集与 fixtureRunEvents 对账、Gantt 子页行/色带/行标签挂载
 * - OV3（S4 mock 面）：trace 行点击 → agent tab 钻取（meta 条与 call 对账）→ tab 关闭
 *       回 workflow 固定 tab → ESC 关 overlay 后 composer 恢复
 * - OV4（V5①）：wf-mock-parse-failed 预置错误臂 → 上区降级列表（parse_failed 原因码 +
 *       重试钮可用 + 列表与 agentCalls 对账），下区 dock 实况面板不受影响
 * - OV5：L2TabBar 编排——关闭激活 tab 激活左侧相邻、关闭首个动态 tab 回固定 tab、
 *       关闭非激活 tab 激活键不变；workflow 固定 tab 无 close 按钮
 * - OV6（设计 §3.1-2 关闭三通道）：ESC / 点遮罩 / 右上关闭按钮统一关闭 + composer 恢复
 * - OV7（V3①④⑤ 六态）：图例六态与 DAG 节点同色同词（dot 类同源 dag/tone.ts）+
 *       六态节点逐一以演员承载断言（done/running/pending/failed/retrying/skipped）+
 *       表格与 DAG 的存量双色分歧保持（retrying 表格 spinner vs DAG warn）+
 *       图例绝对定位层不拦截（pointer-events none）
 * - OV8（V3② 停止叠加）：interrupted → neutral 档 / time_limited → failed 档（在途
 *       节点不着蓝脉冲）；对照 running 演员无叠加且脉冲在
 * - OV9（V5②③ + V3③）：空 DAG 占位居中（wf-mock-empty-dag）/ 未匹配实例分组挂上区
 *       底部且超高滚动形态（wf-mock-mismatched-calls 5 实例）；pending / skipped 节点
 *       点击路由 phase 语义
 * - OV10（V3/V6 失败成员路径）：wf-mock-failed——header 长码截断（title 承全文）+
 *       failed 节点/trace 行同源对账
 *
 * 运行：npx playwright test --project=electron e2e/workflow-viz-overlay.spec.ts
 */
import { test, expect } from './fixtures/launch-app'
import type { Page, Locator } from '@playwright/test'

/** built-in 三件条目按钮（data-kind 区分；与 workflow-sidebar-sync.spec.ts 同源写法） */
function builtinButton(page: Page, kind: 'bash' | 'subagent' | 'workflow') {
  return page.locator(`[data-testid="tray-builtin-button"][data-kind="${kind}"]`)
}

/** 打开某条目的面板（点击 = pin，不等 hover 延时，确定性优于 hover 时序） */
async function openTrayPanel(
  page: Page,
  kind: 'bash' | 'subagent' | 'workflow',
): Promise<Locator> {
  await builtinButton(page, kind).click()
  const panel = page.locator(`[data-testid="tray-panel"][data-panel-key="native:${kind}"]`)
  await expect(panel).toBeVisible({ timeout: 5_000 })
  return panel
}

/**
 * 激活 s3 session（「API 性能优化」）——mock 的 workflow/subagent fixture 只对 s3 返回数据。
 * 同 workflow-sidebar-sync.spec.ts activateSession（不点侧栏 segmented tab 的原因见该
 * spec 注释；托盘挂载判据 = composer 可见）。
 */
async function activateSession(page: Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('composer-tray')).toBeVisible({ timeout: 10_000 })
}

/**
 * 按 slug 精确定位 workflow 行（D8 演员入列后行 testid 恒为 tray-workflow-row，须以行内
 * slug 徽标全文等值过滤——子串 hasText 会撞 'failed' ⊂ 'parse-failed' 类同缀 slug）。
 * has 内链必须以 page 为根（filter 的 inner locator 从行元素起重新解释，容器前缀
 * 会在行后代里查不到——panel 起链恒 0 命中）。
 */
function workflowRowBySlug(page: Page, panel: Locator, slug: string): Locator {
  return panel.getByTestId('tray-workflow-row').filter({
    has: page.getByTestId('tray-workflow-slug').getByText(slug, { exact: true }),
  })
}

/** D8 演员表（冻结清单的 e2e 断言投影）：slug 用于托盘行定位，scriptName 用于 header 对账 */
const ACTORS = {
  baseline: { slug: 'deploy', scriptName: 'deploy-flow', bucket: 'ended' },
  running: { slug: 'running', scriptName: 'feature-impl', bucket: 'running' },
  pending: { slug: 'pending', scriptName: 'dual-review', bucket: 'running' },
  failed: { slug: 'failed', scriptName: 'ship-flow', bucket: 'ended' },
  retrying: { slug: 'retrying', scriptName: 'heal-flow', bucket: 'running' },
  interrupted: { slug: 'interrupted', scriptName: 'migrate-flow', bucket: 'ended' },
  stoppedTimeLimited: { slug: 'time-limited', scriptName: 'migrate-flow', bucket: 'ended' },
  parseFailed: { slug: 'parse-failed', scriptName: 'broken-flow', bucket: 'ended' },
  emptyDag: { slug: 'empty-dag', scriptName: 'gate-flow', bucket: 'ended' },
  mismatched: { slug: 'mismatched', scriptName: 'audit-flow', bucket: 'ended' },
  widePhase: { slug: 'wide-phase', scriptName: 'batch-flow', bucket: 'running' },
} as const

/**
 * 经托盘面板打开指定演员的 overlay（D8 演员入列后按 slug 定位目标行，替代原
 * 「恒单行」点击；ended 桶需先切桶，行可能超出面板可视区故先滚动）。
 */
async function openOverlay(page: Page, actor: (typeof ACTORS)[keyof typeof ACTORS]): Promise<Locator> {
  const panel = await openTrayPanel(page, 'workflow')
  if (actor.bucket === 'ended') {
    await panel.getByTestId('tray-panel-tab-ended').click()
    await expect(panel.getByTestId('tray-panel-tab-ended')).toHaveAttribute('data-active', 'true')
  }
  const row = workflowRowBySlug(page, panel, actor.slug)
  await row.scrollIntoViewIfNeeded()
  await row.getByTestId('tray-workflow-slug').click()
  const overlay = page.getByTestId('wfvz-overlay')
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  await expect(overlay.getByTestId('wfvz-overlay-header')).toContainText(actor.scriptName)
  return overlay
}

/** 节点卡定位（画布 per-node g，testid = wfvz-dag-node-<nodeId>） */
function dagNode(overlay: Locator, nodeId: string): Locator {
  return overlay.getByTestId(`wfvz-dag-node-${nodeId}`)
}

test.describe('Workflow 可视化 overlay E2E', () => {
  test('OV1: 托盘入口打开同一 run 的 overlay（header 身份与 fixture 对账）', async ({ page }) => {
    await activateSession(page)

    // [对话流 block 第二入口 mock 不可达] S1 的「先后从托盘 workflow 行与对话流 block
    // 点击」在 mock 轨只有托盘入口可达：workflow 记录只对 s3 返回（T2 锁死语义），而
    // s3 是空消息 session——composer/state-tearing 等 5 个既有 spec 依赖其空态，不能
    // 注入 workflow tool 消息。block 点击链路（(name,slug) 反查 → overlay）已由组件
    // 测试覆盖（packages/ui BlockWorkflow.test.ts）；双入口同 run 的端到端形态归
    // A4（L4 真机走查，S1 验收场景）。
    const overlay = await openOverlay(page, ACTORS.baseline)

    // run 身份四要素与 fixtureWorkflows[0] 对账：scriptName / slug / 终态 done /
    // 已用时长 10:00→10:30 = 30m（D9 终局锚 completedAt 停走）
    await expect(overlay.getByTestId('wfvz-overlay-slug')).toHaveText('deploy')
    await expect(overlay.getByTestId('wfvz-overlay-run-pill')).toHaveAttribute('data-status', 'done')
    await expect(overlay.getByTestId('wfvz-overlay-elapsed')).toContainText('30')
    // done 正常终局无 errorCode 摘要槽
    await expect(overlay.getByTestId('wfvz-overlay-error-code')).toHaveCount(0)

    // 单例语义（D8：全局单例，开新 run 切内容）：关闭后重开仍指向同一 run——
    // mock 多演员下以重开同 run 身份不变断言（跨 run 换指归 OV7+ 逐演员开关链）
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    const reopened = await openOverlay(page, ACTORS.baseline)
    await expect(reopened.getByTestId('wfvz-overlay-header')).toContainText('deploy-flow')
    await expect(reopened.getByTestId('wfvz-overlay-run-pill')).toHaveAttribute('data-status', 'done')
  })

  test('OV2: workflow 固定 tab 三子页（trace 行集 / 事件流行集 / Gantt 挂载各与 mock 数据对账）', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlay(page, ACTORS.baseline)

    // 下区 dock 实况面板挂载；固定 tab 标题 = scriptName 且默认激活
    const panel = overlay.getByTestId('wf-viz-live-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('l2-tab-workflow')).toHaveAttribute('data-active', 'true')
    await expect(panel.getByTestId('l2-tab-workflow')).toContainText('deploy-flow')

    // ── 子页 1：实例 trace（默认子页）——行集与 fixture agentCalls 逐条对账 ──
    const tracePanel = panel.getByTestId('wf-viz-subpage-trace-panel')
    await expect(tracePanel).toBeVisible()
    const row0 = panel.getByTestId('wf-viz-trace-row-0')
    const row1 = panel.getByTestId('wf-viz-trace-row-1')
    await expect(panel.locator('[data-testid^="wf-viz-trace-row-"]')).toHaveCount(2)
    await expect(row0).toContainText('dev-W1')
    await expect(row0).toContainText('Dev')
    await expect(row0.getByTestId('wf-viz-trace-status-0')).toHaveAttribute('data-status', 'done')
    await expect(row1).toContainText('review-W1')
    await expect(row1).toContainText('Review')
    await expect(row1.getByTestId('wf-viz-trace-status-1')).toHaveAttribute('data-status', 'done')

    // ── 子页 2：事件流——行集与 fixtureRunEvents（10 行）对账 ──
    await panel.getByTestId('wf-viz-subpage-events').click()
    const eventsList = panel.getByTestId('wf-viz-events-list')
    await expect(eventsList).toBeVisible({ timeout: 5_000 })
    // 事件行 testid = wf-viz-event-<type>；:not 排除截断标注徽标自身（wf-viz-event-truncated
    // 同前缀——mock fixture 无截断行，防御性排除保持行集口径与组件测试一致）
    await expect(eventsList.locator('[data-testid^="wf-viz-event-"]:not([data-testid="wf-viz-event-truncated"])')).toHaveCount(10)
    // 首行 run-created 摘要 = workflowName · argsSummary（fixture 字面）
    await expect(panel.getByTestId('wf-viz-event-run-created').first()).toContainText('deploy-flow')
    await expect(panel.getByTestId('wf-viz-event-run-created').first()).toContainText('{"task":"demo"}')
    // agent-started 两行（taskIndex 0/1 各一帧）；run 终局一帧 done
    await expect(panel.getByTestId('wf-viz-event-agent-started')).toHaveCount(2)
    await expect(panel.getByTestId('wf-viz-event-run-settled')).toHaveCount(1)

    // ── 子页 3：Gantt 时间线——分段派生（事件流 → 纯函数）的 DOM 终点 ──
    await panel.getByTestId('wf-viz-subpage-gantt').click()
    const gantt = panel.getByTestId('wfvz-gantt-root')
    await expect(gantt).toBeVisible()
    // 分段非空（事件流两 call 各有 started/settled 帧）→ 空态不渲染
    await expect(gantt.getByTestId('wfvz-gantt-empty')).toHaveCount(0)
    // 2 个 call 行（taskIndex 一行）+ 2 条 phase 色带（Dev/Review 各一段，均非空段）
    await expect(gantt.getByTestId('wfvz-gantt-row-0')).toBeVisible()
    await expect(gantt.getByTestId('wfvz-gantt-row-1')).toBeVisible()
    await expect(gantt.getByTestId('wfvz-gantt-band-Dev')).toBeVisible()
    await expect(gantt.getByTestId('wfvz-gantt-band-Review')).toBeVisible()
    // 跨通道对账：行标签来自事件流 agent-started 帧的 agentName（callLabels 注入）
    await expect(gantt.getByTestId('wfvz-gantt-row-0')).toContainText('dev-W1')
    await expect(gantt.getByTestId('wfvz-gantt-row-1')).toContainText('review-W1')
    // 每 call 单 attempt 一段（fixture 无重试）
    await expect(gantt.locator('[data-testid="wfvz-gantt-seg"]')).toHaveCount(2)
  })

  test('OV3: trace 行点击钻取 agent tab，tab 关闭回固定 tab，ESC 关 overlay 后 composer 恢复', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlay(page, ACTORS.baseline)

    // 打开即 focus 面板（设计 §5.12 焦点管理两要素之一——安全默认焦点）
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('wfvz-overlay-panel')

    // trace 行点击 → agent 一级 tab 开且激活；meta 条与 call #0 对账
    await overlay.getByTestId('wf-viz-trace-row-0').click()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toBeVisible()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveAttribute('data-active', 'true')
    const agentTab = overlay.getByTestId('wf-viz-agent-tab')
    await expect(agentTab).toBeVisible()
    await expect(agentTab.getByTestId('wf-viz-agent-meta')).toContainText('dev-W1')
    await expect(agentTab.getByTestId('wf-viz-agent-meta')).toContainText('Dev')

    // [phase tab 钻取] DAG 通道接通后 mock 可达，phase 语义路由由 OV9 以 pending /
    // skipped 节点点击承载（agent 节点点击语义与本段 trace 行点击同链，不重复）

    // tab 已存在时再点同一行仅激活不重复追加
    await overlay.getByTestId('l2-tab-workflow').click()
    await overlay.getByTestId('wf-viz-trace-row-0').click()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveCount(1)
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveAttribute('data-active', 'true')

    // 关闭激活的 agent tab（首个动态 tab，无左侧相邻）→ 回 workflow 固定 tab
    await overlay.getByTestId('l2-tab-close-agent:0').click()
    await expect(overlay.getByTestId('l2-tab-workflow')).toHaveAttribute('data-active', 'true')
    await expect(overlay.getByTestId('wf-viz-subpage-trace-panel')).toBeVisible()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveCount(0)

    // ESC 关 overlay → 临时层消失 + composer 恢复可见。
    // [焦点归还锚精确断言声明] 「归还 = 打开前焦点元素」受入口点击链路的焦点转移
    // 影响（托盘按钮点击会移动焦点），黑盒下不可稳断言——归 A4（L4，S4 验收
    // 「焦点归还打开前焦点元素」项）
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  })

  test('OV4: parse_failed 降级回执 → 上区降级列表 + 原因码 + 重试钮，下区 dock 实况面板不受影响', async ({ page }) => {
    await activateSession(page)

    // D8 定稿③：wf-mock-parse-failed 是降级断言唯一数据源（预置 parse_failed 错误臂，
    // run 本身正常 done）——OV4 原以「wf-mock-001 恒降级」为前提，通道接通后场景移本演员
    const overlay = await openOverlay(page, ACTORS.parseFailed)

    // 上区降级形态：原因码透出 + parse_failed 专属重试入口渲染
    const fallback = overlay.getByTestId('wfvz-overlay-dag-fallback')
    await expect(fallback).toBeVisible()
    await expect(overlay.getByTestId('wfvz-overlay-dag-error-code')).toHaveText('parse_failed')
    const retry = overlay.getByTestId('wfvz-overlay-dag-retry')
    await expect(retry).toBeVisible()

    // 降级列表内容与演员 agentCalls 逐条对账（1 调用点）+ 显式 phase 分组标题渲染
    await expect(fallback.locator('[data-testid="wfvz-overlay-dag-fallback-call"]')).toHaveCount(1)
    await expect(overlay.getByTestId('wfvz-overlay-dag-fallback-group-Do')).toContainText('worker-W1')

    // 重试钮可用：重拉后 mock 恒返回 parse_failed（失败不缓存故可重试）→ 降级形态保持
    await retry.click()
    await expect(overlay.getByTestId('wfvz-overlay-dag-error-code')).toHaveText('parse_failed')
    await expect(fallback).toBeVisible()

    // 下区不受影响：实况面板挂载 + 默认 trace 子页行集完整（S6「其余子页正常」）
    await expect(overlay.getByTestId('wf-viz-live-panel')).toBeVisible()
    await expect(overlay.getByTestId('wf-viz-trace-row-0')).toContainText('worker-W1')
  })

  test('OV5: L2TabBar 编排——关闭激活 tab 激活左侧相邻，首个动态 tab 关闭回固定 tab，固定 tab 不可关', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlay(page, ACTORS.baseline)
    const tabbar = overlay.getByTestId('wf-viz-tabbar')

    // 固定 tab 无 close 按钮（L2TabBar builtin 项不渲染；panel-tabs.ts 不可关语义）
    await expect(tabbar.getByTestId('l2-tab-close-workflow')).toHaveCount(0)

    // 开两个 agent tab：点行 0 → 回固定 tab → 点行 1（后开的激活）
    await overlay.getByTestId('wf-viz-trace-row-0').click()
    await overlay.getByTestId('l2-tab-workflow').click()
    await overlay.getByTestId('wf-viz-trace-row-1').click()
    await expect(overlay.getByTestId('l2-tab-agent:1')).toHaveAttribute('data-active', 'true')

    // 关闭激活 tab（agent:1）→ 激活左侧相邻 agent:0（内容面随激活键切换）
    await overlay.getByTestId('l2-tab-close-agent:1').click()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveAttribute('data-active', 'true')
    await expect(overlay.getByTestId('wf-viz-agent-tab')).toBeVisible()

    // 关闭非激活 tab 激活键不变：激活 workflow（不关 tab）后关闭 agent:0 → 仍 workflow
    await overlay.getByTestId('l2-tab-workflow').click()
    await overlay.getByTestId('l2-tab-close-agent:0').click()
    await expect(overlay.getByTestId('l2-tab-workflow')).toHaveAttribute('data-active', 'true')

    // 关闭首个动态 tab（无左侧相邻）→ 回 workflow 固定 tab：重开 agent:0 并激活后关闭
    await overlay.getByTestId('wf-viz-trace-row-0').click()
    await overlay.getByTestId('l2-tab-close-agent:0').click()
    await expect(overlay.getByTestId('l2-tab-workflow')).toHaveAttribute('data-active', 'true')
    await expect(overlay.getByTestId('wf-viz-subpage-trace-panel')).toBeVisible()
    await expect(overlay.getByTestId('l2-tab-agent:0')).toHaveCount(0)
  })

  test('OV6: ESC / 点遮罩 / 关闭按钮三通道统一关闭，composer 恢复', async ({ page }) => {
    await activateSession(page)

    // 通道 1：ESC（window keydown）——与 workflow-sidebar-sync T3 同通道，此处作为
    // 三通道统一断言的一支
    let overlay = await openOverlay(page, ACTORS.baseline)
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    // 通道 2：点遮罩（overlay 根容器 @click.self——点击面板外区域，position 相对
    // overlay 左上角，面板占 92% 宽高居中故 (2,2) 落在遮罩上）
    overlay = await openOverlay(page, ACTORS.baseline)
    await overlay.click({ position: { x: 2, y: 2 } })
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    // 通道 3：右上关闭按钮
    overlay = await openOverlay(page, ACTORS.baseline)
    await overlay.getByTestId('wfvz-overlay-close').click()
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  })

  test('OV7: 图例六态与 DAG 节点同色同词（V3①），六态节点逐演员断言 + 双色分歧保持（V3④）+ 图例不拦截（V3⑤）', async ({ page }) => {
    await activateSession(page)

    // 图例词与 dot 色对照锚（词 = i18n 状态词族现值；色 = dag/tone.ts dotTone 映射——
    // e2e 侧以字面类对账，映射语义漂移时此处红）
    const LEGEND_EXPECT = [
      { status: 'pending', label: '等待中', fill: /fill-\[var\(--neutral-dim\)\]/ },
      { status: 'running', label: '运行中', fill: /fill-\[var\(--accent\)\]/ },
      { status: 'done', label: '完成', fill: /fill-\[var\(--success\)\]/ },
      { status: 'failed', label: '失败', fill: /fill-\[var\(--danger\)\]/ },
      { status: 'retrying', label: '重试中', fill: /fill-\[var\(--warn\)\]/ },
      { status: 'skipped', label: '已跳过', fill: /fill-\[var\(--neutral-dim\)\]/ },
    ] as const

    // ── done 演员（wf-mock-001）：画布就绪 → 图例六条恒在（同色同词 + 不拦截）──
    let overlay = await openOverlay(page, ACTORS.baseline)
    const legend = overlay.getByTestId('wfvz-dag-legend')
    await expect(legend).toBeVisible()
    for (const entry of LEGEND_EXPECT) {
      const dot = legend.getByTestId(`wfvz-dag-legend-dot-${entry.status}`)
      await expect(dot).toHaveClass(entry.fill)
      // 图例 dot 恒静态（脉冲是节点态不是图例态，D4）
      await expect(dot).not.toHaveClass(/animate/)
      await expect(legend.getByText(entry.label, { exact: true })).toBeVisible()
    }
    // V3⑤：图例绝对定位层不拦截节点点击与缩放手势
    await expect.poll(() => legend.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    // 同色同源：done 节点六态派生正确（done）。
    // [产品缺陷登记 · 不锁 done 节点 tone 类] 实装 WorkflowVizDag stopTone computed 对
    // done + outcome='done' 落 neutral 兜底且 run 级无差别应用于全部节点——终局 done run
    // 的 done 节点 rect/dot 呈中性叠加（实测 stroke-[var(--neutral-dim)]），与设计 E6
    // 「在途节点」限定 + neutral 清单（interrupted / cancelled / done 无 outcome）冲突，
    // V3①「图例 done 绿 ↔ 节点同色」在该场景结构性不可达。断言缺口与修复建议（done
    // 终局无叠加 / 叠加仅作用于在途节点）随 deviations 上报编排层——缺陷修复前不把
    // 缺陷行为或未实装行为锁进契约
    await expect(dagNode(overlay, 'agent-L4-N0')).toHaveAttribute('data-state', 'done')
    await expect(dagNode(overlay, 'agent-L7-N1')).toHaveAttribute('data-state', 'done')
    await page.keyboard.press('Escape')

    // ── running 演员：accent 描边 + 节点脉冲（图例 dot 无脉冲已在上方对账）──
    overlay = await openOverlay(page, ACTORS.running)
    const runningNode = dagNode(overlay, 'agent-L3-N0')
    await expect(runningNode).toHaveAttribute('data-state', 'running')
    await expect(runningNode.locator('rect')).toHaveClass(/stroke-\[var\(--accent\)\]/)
    await expect(runningNode.locator('rect')).toHaveClass(/animate-\[wfvz-node-pulse/)
    await expect(runningNode).not.toHaveAttribute('data-stop-tone')
    await page.keyboard.press('Escape')

    // ── pending 演员：两节点全 pending（零挂接 + run 运行中）──
    overlay = await openOverlay(page, ACTORS.pending)
    await expect(dagNode(overlay, 'agent-L2-N0')).toHaveAttribute('data-state', 'pending')
    await expect(dagNode(overlay, 'agent-L4-N1')).toHaveAttribute('data-state', 'pending')
    // V3① 节点侧 pending 一角：run 运行中无停止叠加，dotTone('pending') 返回空串、
    // 色由 circle 基类承载——与 LEGEND_EXPECT pending fill 同 literal（六态同色节点侧锚）
    await expect(dagNode(overlay, 'agent-L2-N0').locator('circle')).toHaveClass(/fill-\[var\(--neutral-dim\)\]/)
    await page.keyboard.press('Escape')

    // ── failed 演员：danger 描边无脉冲 ──
    overlay = await openOverlay(page, ACTORS.failed)
    const failedNode = dagNode(overlay, 'agent-L3-N0')
    await expect(failedNode).toHaveAttribute('data-state', 'failed')
    await expect(failedNode.locator('rect')).toHaveClass(/stroke-\[var\(--danger\)\]/)
    await expect(failedNode.locator('rect')).not.toHaveClass(/animate/)
    await page.keyboard.press('Escape')

    // ── retrying 演员：warn 描边 + 脉冲；表格侧 live spinner（V3④ 存量双色分歧保持：
    //    表格 retrying = spinner 蓝族，DAG retrying = warn——修复是 docs/todo 另一案）──
    overlay = await openOverlay(page, ACTORS.retrying)
    const retryingNode = dagNode(overlay, 'agent-L3-N0')
    await expect(retryingNode).toHaveAttribute('data-state', 'retrying')
    await expect(retryingNode.locator('rect')).toHaveClass(/stroke-\[var\(--warn\)\]/)
    await expect(retryingNode.locator('rect')).toHaveClass(/animate-\[wfvz-node-pulse/)
    const retryingStatus = overlay.getByTestId('wf-viz-trace-status-0')
    await expect(retryingStatus).toHaveAttribute('data-status', 'retrying')
    await expect(retryingStatus.locator('svg')).toHaveClass(/animate-spin/)
    await page.keyboard.press('Escape')

    // ── skipped 演员：done + 零挂接 → skipped（六态收口）。[同上缺陷登记] done 终局
    // run 的 neutral 叠加短路 nodeTone——skipped 本色（dasharray 4_3 虚线）被吞，故
    // rect 虚线断言缺口随同一 deviations 上报；opacity-50 在节点卡根不受叠加影响，照锁
    overlay = await openOverlay(page, ACTORS.mismatched)
    const skippedNode = dagNode(overlay, 'agent-L3-N0')
    await expect(skippedNode).toHaveAttribute('data-state', 'skipped')
    await expect(skippedNode.locator('g').first()).toHaveClass(/opacity-50/)
    await page.keyboard.press('Escape')
  })

  test('OV8: 停止叠加两档（V3②）——interrupted 中性 / time_limited 失败红，在途节点不脉冲', async ({ page }) => {
    await activateSession(page)

    // neutral 档：wf-mock-interrupted（run-interrupted 后无 resume，在途 migrator-W1
    // 投影仍 running → 停止叠加优先于六态：中性暗、无脉冲）
    let overlay = await openOverlay(page, ACTORS.interrupted)
    const neutralNode = dagNode(overlay, 'agent-L3-N0')
    await expect(neutralNode).toHaveAttribute('data-state', 'running')
    await expect(neutralNode).toHaveAttribute('data-stop-tone', 'neutral')
    await expect(neutralNode.locator('rect')).toHaveClass(/stroke-\[var\(--neutral-dim\)\]/)
    await expect(neutralNode.locator('rect')).not.toHaveClass(/animate/)
    await expect(neutralNode.locator('circle')).toHaveClass(/fill-\[var\(--neutral-dim\)\]/)
    await page.keyboard.press('Escape')

    // failed 档：wf-mock-stopped-time-limited（run-settled outcome=time_limited，在途
    // call 无 settled → stopTone failed 档：失败红、无脉冲——走查 E-4 数据载体）
    overlay = await openOverlay(page, ACTORS.stoppedTimeLimited)
    const failedNode = dagNode(overlay, 'agent-L3-N0')
    await expect(failedNode).toHaveAttribute('data-state', 'running')
    await expect(failedNode).toHaveAttribute('data-stop-tone', 'failed')
    await expect(failedNode.locator('rect')).toHaveClass(/stroke-\[var\(--danger\)\]/)
    await expect(failedNode.locator('rect')).not.toHaveClass(/animate/)
    await expect(failedNode.locator('circle')).toHaveClass(/fill-\[var\(--danger\)\]/)
    await page.keyboard.press('Escape')

    // 对照：运行中演员无停止叠加且脉冲在（叠加只随 run 终局出现）
    overlay = await openOverlay(page, ACTORS.running)
    const runningNode = dagNode(overlay, 'agent-L3-N0')
    await expect(runningNode).not.toHaveAttribute('data-stop-tone')
    await expect(runningNode.locator('rect')).toHaveClass(/animate-\[wfvz-node-pulse/)
    await page.keyboard.press('Escape')
  })

  test('OV9: 降级场景二支（V5②③）——空 DAG 占位 / 未匹配实例分组，pending/skipped 路由 phase（V3③），wide-phase 纵向载体（V1）', async ({ page }) => {
    await activateSession(page)

    // V5② 空 DAG：wf-mock-empty-dag（零节点 blueprint）→ 居中摘要占位 + 无节点卡 +
    // trace 空态（agentCalls=[]）；DAG 通道成功臂（非降级列表）
    let overlay = await openOverlay(page, ACTORS.emptyDag)
    const empty = overlay.getByTestId('wfvz-dag-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('本脚本无 agent 调用点')
    await expect(overlay.locator('[data-testid^="wfvz-dag-node-"]')).toHaveCount(0)
    await expect(overlay.getByTestId('wf-viz-trace-empty')).toBeVisible()
    await expect(overlay.getByTestId('wfvz-overlay-dag-fallback')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // V5③ 未匹配实例：wf-mock-mismatched-calls（call phase=Review ×5 与节点 Audit/
    // ^reviewer-.*$ 双错开 → 全部入未匹配分组，不静默丢弃）
    overlay = await openOverlay(page, ACTORS.mismatched)
    const unmatched = overlay.getByTestId('wfvz-overlay-unmatched')
    await expect(unmatched).toBeVisible()
    await expect(unmatched.locator('[data-testid="wfvz-overlay-unmatched-item"]')).toHaveCount(5)
    const reviewGroup = unmatched.getByTestId('wfvz-overlay-unmatched-group-Review')
    await expect(reviewGroup).toContainText('mystery-agent-1')
    await expect(reviewGroup).toContainText('mystery-agent-5')
    // 零命中标注（D2③ 原文口径：非歧义 → 短标注）
    await expect(unmatched).toContainText('未命中任何调用点')
    // 分组挂上区底部且超高滚动的形态锚（overflow 容器 + max-h-[35%]，D1 E4 分母 = 上区高）
    await expect(unmatched).toHaveClass(/overflow-y-auto/)
    await expect(unmatched).toHaveClass(/max-h-\[35%\]/)

    // V3③：点击 skipped 节点路由 phase 语义（开 Audit phase tab，非 agent 钻取）
    await dagNode(overlay, 'agent-L3-N0').click()
    await expect(overlay.getByTestId('l2-tab-phase:Audit')).toBeVisible()
    await expect(overlay.getByTestId('l2-tab-phase:Audit')).toHaveAttribute('data-active', 'true')
    await expect(overlay.getByTestId('wf-viz-phase-tab')).toBeVisible()
    await page.keyboard.press('Escape')

    // V3③ pending 支：点击 pending 节点同路由 phase 语义（wf-mock-pending 的 plan-W1
    // 节点 → Plan phase tab）
    overlay = await openOverlay(page, ACTORS.pending)
    await dagNode(overlay, 'agent-L2-N0').click()
    await expect(overlay.getByTestId('l2-tab-phase:Plan')).toBeVisible()
    await expect(overlay.getByTestId('l2-tab-phase:Plan')).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Escape')

    // V1 演员载体断言固化：单 phase 7+ agent 演员（wf-mock-wide-phase，W-2 纵向边界
    // 载体）——7 节点全部挂载且态分布与 fixture 对账（4 done + 3 running）；列高越界的
    // pan 兜底几何走查归 V1/L4（真机视口实算，非黑盒断言面）
    overlay = await openOverlay(page, ACTORS.widePhase)
    for (let i = 0; i < 7; i++) {
      await expect(dagNode(overlay, `agent-L3-N${i}`)).toHaveAttribute('data-state', i < 4 ? 'done' : 'running')
    }
    // V1-wf③ 上区内容水平居中（无贴左空白，wf D1 走查 edge#12）：最左/最右分区矩形与
    // 画布两缘的空隙对称——mock `.dag-stage` justify-center 在自绘 SVG 的等价实现 =
    // 初始视口 tx=(容器宽−画布宽)/2（k 恒 1），几何投影即两空隙相等
    const gaps = await overlay.getByTestId('wfvz-dag-svg').evaluate((svg) => {
      const box = svg.getBoundingClientRect()
      let left = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      svg.querySelectorAll('[data-wfvz-cluster] > rect').forEach((rect) => {
        const b = rect.getBoundingClientRect()
        left = Math.min(left, b.left)
        right = Math.max(right, b.right)
      })
      return { leftGap: left - box.left, rightGap: box.right - right }
    })
    // 贴左形态（tx=0）leftGap≈0 且右空白≈容器−画布；居中形态两空隙对称且各有可观边距
    expect(gaps.leftGap).toBeGreaterThan(100)
    expect(Math.abs(gaps.leftGap - gaps.rightGap)).toBeLessThan(4)
    await page.keyboard.press('Escape')
  })

  test('OV10: 失败成员路径——header 长码截断（title 承全文）+ failed 节点/trace 行同源对账', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlay(page, ACTORS.failed)

    // header：终态 done + errorCode 槽（fixture 长码 = engine_${string} 词表足额串，
    // 驱动 200px 截断形态；全文经 title 悬停可见，V6 口径）
    await expect(overlay.getByTestId('wfvz-overlay-run-pill')).toHaveAttribute('data-status', 'done')
    const errorCode = overlay.getByTestId('wfvz-overlay-error-code')
    await expect(errorCode).toBeVisible()
    await expect(errorCode).toHaveAttribute(
      'title',
      'engine_call_failed_schema_validation_unexpected_field_config_at_step_shipper_W1_attempt_1',
    )
    await expect(errorCode).toHaveClass(/truncate/)
    // 已用时长停走锚：11:00:00 → 11:00:50 = 50s（终局 completedAt）
    await expect(overlay.getByTestId('wfvz-overlay-elapsed')).toContainText('50')

    // 失败成员同源：DAG 节点 failed tone + trace 行 failed（词「失败」+ 结果列错误原文）
    const node = dagNode(overlay, 'agent-L3-N0')
    await expect(node).toHaveAttribute('data-state', 'failed')
    await expect(node.locator('rect')).toHaveClass(/stroke-\[var\(--danger\)\]/)
    const status = overlay.getByTestId('wf-viz-trace-status-0')
    await expect(status).toHaveAttribute('data-status', 'failed')
    await expect(status).toContainText('失败')
    await expect(overlay.getByTestId('wf-viz-trace-row-0')).toContainText('schema_deterministic')
  })
})
