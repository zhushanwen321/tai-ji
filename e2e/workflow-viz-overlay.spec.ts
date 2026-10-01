/**
 * Workflow 可视化 overlay E2E —— Playwright + Electron + mock 轨。
 *
 * 分层定位（workflow-visualization 设计 §4 验收场景 S1/S2/S4/S6 的 mock 可达面 +
 * impl-plan 验收计划表 A5a/A6/A7 的脚本化部分）：本 spec 承接「overlay 打开形态 /
 * workflow tab 三子页 / 多级钻取 / 降级路径 / tab 编排 / 三通道关闭」六组 mock 可覆盖
 * 断言；跨进程链路入口（托盘行 → overlay）与 workflow-sidebar-sync.spec.ts T3 同源，
 * 本 spec 深入 overlay 内部行为（T3 只断言打开 + 降级形态挂载，不重复）。
 *
 * mock 数据事实（packages/core/src/transport/mock/workflow-data.ts + index.ts）：
 * - getWorkflows('s3') = 1 条 WorkflowRunRecord：runId=wf-mock-001 / scriptName=deploy-flow /
 *   slug=deploy / status=done / startedAt 10:00 / completedAt 10:30（elapsed=30m）/
 *   2 个 agentCalls（id 0 dev-W1 phase Dev、id 1 review-W1 phase Review，均 done）
 * - getWorkflowRunEvents(wf-mock-001) = fixtureRunEvents 成功回执（10 行骨架帧：
 *   run-created → Dev 相（#0 dev-W1）→ Review 相（#1 review-W1）→ run-settled done；
 *   taskIndex 与 agentCalls[].id 同键域，run 起止锚与 record 字段同源换算）
 * - getWorkflowDag 恒 record_not_found（mock 无 record 文件基建）→ overlay 左栏
 *   恒为降级列表形态（与 workflow-sidebar-sync T3 的断言面一致，本 spec 补齐降级
 *   列表内容对账）
 *
 * 六条 case：
 * - OV1（S1 mock 面）：托盘入口打开 overlay 的 run 身份断言（header scriptName/slug/
 *       状态/时长与 fixture 对账）+ 关闭重开内容一致（单例换指语义的 mock 单 run 面）。
 *       对话流 block 第二入口 mock 不可达——见 case 内注释
 * - OV2（S1/S2 mock 面）：workflow 固定 tab 三子页——trace 表行集与 agentCalls 对账、
 *       事件流子页行集与 fixtureRunEvents 对账、Gantt 子页行/色带/行标签挂载
 * - OV3（S4 mock 面）：trace 行点击 → agent tab 钻取（meta 条与 call 对账）→ tab 关闭
 *       回 workflow 固定 tab → ESC 关 overlay 后 composer 恢复
 * - OV4（S6 mock 面）：DAG 通道降级回执 → 左栏降级列表（原因码 + 无重试入口 + 内容
 *       与 agentCalls 逐条对账 + phase 分组标题渲染），右栏实况面板不受影响
 * - OV5：L2TabBar 编排——关闭激活 tab 激活左侧相邻、关闭首个动态 tab 回固定 tab、
 *       关闭非激活 tab 激活键不变；workflow 固定 tab 无 close 按钮
 * - OV6（设计 §3.1-2 关闭三通道）：ESC / 点遮罩 / 右上关闭按钮统一关闭 + composer 恢复
 *
 * 运行：npx playwright test --project=electron e2e/workflow-viz-overlay.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/** built-in 三件条目按钮（data-kind 区分；与 workflow-sidebar-sync.spec.ts 同源写法） */
function builtinButton(page: import('@playwright/test').Page, kind: 'bash' | 'subagent' | 'workflow') {
  return page.locator(`[data-testid="tray-builtin-button"][data-kind="${kind}"]`)
}

/** 打开某条目的面板（点击 = pin，不等 hover 延时，确定性优于 hover 时序） */
async function openTrayPanel(
  page: import('@playwright/test').Page,
  kind: 'bash' | 'subagent' | 'workflow',
): Promise<import('@playwright/test').Locator> {
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
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('composer-tray')).toBeVisible({ timeout: 10_000 })
}

/**
 * 经托盘面板打开 wf-mock-001 的 overlay（唯一 mock 可达入口）。
 * 重开场景下面板可能已停在「已结束」桶——running 空态的跳桶按钮可见才点（即时探测，
 * 非等待）。
 */
async function openOverlayViaTray(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const panel = await openTrayPanel(page, 'workflow')
  const jump = panel.getByTestId('tray-panel-empty-jump-ended')
  if (await jump.isVisible()) await jump.click()
  await panel.getByTestId('tray-workflow-row').click()
  const overlay = page.getByTestId('wfvz-overlay')
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  await expect(overlay.getByTestId('wfvz-overlay-header')).toContainText('deploy-flow')
  return overlay
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
    const overlay = await openOverlayViaTray(page)

    // run 身份四要素与 fixtureWorkflows[0] 对账：scriptName / slug / 终态 done /
    // 已用时长 10:00→10:30 = 30m（D9 终局锚 completedAt 停走）
    await expect(overlay.getByTestId('wfvz-overlay-slug')).toHaveText('deploy')
    await expect(overlay.getByTestId('wfvz-overlay-run-pill')).toHaveAttribute('data-status', 'done')
    await expect(overlay.getByTestId('wfvz-overlay-elapsed')).toContainText('30')
    // done 正常终局无 errorCode 摘要槽
    await expect(overlay.getByTestId('wfvz-overlay-error-code')).toHaveCount(0)

    // 单例语义（D8：全局单例，开新 run 切内容）：关闭后重开仍指向同一 run——
    // mock 单 run 下「切换内容」无第二 run 可验，断言重开身份不变
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    const reopened = await openOverlayViaTray(page)
    await expect(reopened.getByTestId('wfvz-overlay-header')).toContainText('deploy-flow')
    await expect(reopened.getByTestId('wfvz-overlay-run-pill')).toHaveAttribute('data-status', 'done')
  })

  test('OV2: workflow 固定 tab 三子页（trace 行集 / 事件流行集 / Gantt 挂载各与 mock 数据对账）', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlayViaTray(page)

    // 右栏实况面板挂载；固定 tab 标题 = scriptName 且默认激活
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
    const overlay = await openOverlayViaTray(page)

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

    // [phase tab 钻取 mock 不可达] S4 的「点 DAG phase 分区 → phase tab」依赖 DAG 成功
    // 臂，而 mock getWorkflowDag 恒降级（OV4）——phase tab 入口归 A4（L4 真机走查）；
    // phase tab 内容渲染已由组件测试覆盖（workflow-live-panel.test.ts）。

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

  test('OV4: DAG 通道降级回执 → 左栏降级列表 + 原因码，右栏实况面板不受影响', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlayViaTray(page)

    // mock getWorkflowDag 恒 record_not_found → 左栏降级形态：原因码透出 +
    // record_not_found 非可重试码（parse_failed 专属入口不渲染）
    const fallback = overlay.getByTestId('wfvz-overlay-dag-fallback')
    await expect(fallback).toBeVisible()
    await expect(overlay.getByTestId('wfvz-overlay-dag-error-code')).toHaveText('record_not_found')
    await expect(overlay.getByTestId('wfvz-overlay-dag-retry')).toHaveCount(0)

    // 降级列表内容与 fixture agentCalls 逐条对账（2 调用点）+ phase 分组标题渲染
    // （fixture 两 call 显式 phase → hasExplicitPhases → 组标题 <p> 渲染）
    await expect(fallback.locator('[data-testid="wfvz-overlay-dag-fallback-call"]')).toHaveCount(2)
    const devGroup = overlay.getByTestId('wfvz-overlay-dag-fallback-group-Dev')
    const reviewGroup = overlay.getByTestId('wfvz-overlay-dag-fallback-group-Review')
    await expect(devGroup.locator('> p')).toHaveText('Dev')
    await expect(devGroup.getByTestId('wfvz-overlay-dag-fallback-call')).toContainText('dev-W1')
    await expect(reviewGroup.locator('> p')).toHaveText('Review')
    await expect(reviewGroup.getByTestId('wfvz-overlay-dag-fallback-call')).toContainText('review-W1')

    // 右栏不受影响：实况面板挂载 + 默认 trace 子页行集完整（S6「其余子页正常」）
    await expect(overlay.getByTestId('wf-viz-live-panel')).toBeVisible()
    await expect(overlay.getByTestId('wf-viz-trace-row-0')).toBeVisible()
    await expect(overlay.getByTestId('wf-viz-trace-row-1')).toBeVisible()
  })

  test('OV5: L2TabBar 编排——关闭激活 tab 激活左侧相邻，首个动态 tab 关闭回固定 tab，固定 tab 不可关', async ({ page }) => {
    await activateSession(page)
    const overlay = await openOverlayViaTray(page)
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
    let overlay = await openOverlayViaTray(page)
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    // 通道 2：点遮罩（overlay 根容器 @click.self——点击面板外区域，position 相对
    // overlay 左上角，面板占 92% 宽高居中故 (2,2) 落在遮罩上）
    overlay = await openOverlayViaTray(page)
    await overlay.click({ position: { x: 2, y: 2 } })
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    // 通道 3：右上关闭按钮
    overlay = await openOverlayViaTray(page)
    await overlay.getByTestId('wfvz-overlay-close').click()
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  })
})
