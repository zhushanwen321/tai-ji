/**
 * Workflow 任务托盘同步 E2E —— Playwright + Electron + mock 轨。
 *
 * [改写 2026-09-16] 原断言面（侧栏 Flows/Agents tab 的 workflow-card / subagent-card /
 * workflow-detail）随侧栏任务 tab 退役（设计 docs/design/composer-task-tray.md D10/D11：
 * 任务观察入口唯一化收敛到 composer 任务托盘），本 spec 改挂托盘。文件名与登记 id 保留
 * （docs/testing/e2e-map.json E2E-MOCK-01 条目），语义从「侧栏列表同步」变为「托盘同步」。
 *
 * 分层定位（设计 §4 e2e 影响面评估表 + 计划 u-e2e 验收④「单测化路径」）：
 * 行渲染细节（分桶/格式化/两段式操作/空态）已沉淀 ComposerTray / TrayNativePanel 组件测试
 * （packages/renderer/src/__tests__/panel/tray/），本 spec 只保留 e2e 层不可替代的**跨进程链路**：
 *   mock 数据源 → store 分区 → useTrayCounts 计数/行集 → 托盘 DOM，
 * 以及「点托盘行 → drawer workflow tab」的归宿不变量（原 E2 的回归守护对象）。
 *
 * 三条 case：
 * - T1：s3 存在 workflow 历史 record → 托盘出现 workflow 条目（dim 常驻）+ 点开面板后
 *       桶计数与行集来自同一份数据（跨进程链路的 DOM 终点断言）
 * - T2：切到无 workflow 数据的 session → 托盘该条目整体摘除（归零不虚亮：DOM 层不存在，
 *       而非 opacity:0 / 空壳）；切回 s3 恢复（分区读，非残留）
 * - T3：点面板 workflow 行 → drawer workflow tab 打开（归宿不回归），composer 不被 overlay
 *       遮挡（原 E2 后半段「Panel 不进 overlay」不变量）
 *
 * mock 数据事实（packages/core/src/transport/mock/workflow-data.ts，本 spec 不改数据源）：
 * - getWorkflows('s3') = 1 条 WorkflowRunRecord（runId=wf-mock-001 / scriptName=deploy-flow /
 *   slug=deploy / status='done' / 2 个 agentCalls）→ 进行中计数 0、已结束计数 1
 * - getWorkflows(非 s3) = [] → 该类无记录 → 托盘条目整体不渲染
 * [计数 > 0 分支不可达说明] 三件「亮计数 + 呼吸点」只在 running > 0 时渲染，而 mock 轨无
 * workflow/subagent 记录的生产/更新通道（fixture 恒为终态 done/idle，mock 的 run-send-stream
 * 只产 message/tool/widget 序列，无 record 广播）——「计数出现与更新」的渲染分支由托盘组件
 * 测试（__tests__/panel/tray/composer-tray.test.ts 三态用例）覆盖；本 spec 断言同一判据的
 * **否定面**（归零不虚亮 N2：running=0 → 计数/呼吸点元素不存在），二者合起来是完整的三态口径。
 *
 * 运行：npx playwright test --project=electron e2e/workflow-sidebar-sync.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/** built-in 三件条目按钮（data-kind 区分；条目存在性 = 该 session 该类 total > 0） */
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
 *
 * 不点侧栏 segmented tab：sessions 是默认 activeTab，且 icon-only 模式下 tab 的 accessible
 * name 被计数徽标文本抢占（见 v6-shell-baseline.spec.ts activateSession 注释）。
 * 托盘挂载判据 = composer 可见（`v-if="sessionId"`，landing 态隐藏）。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('composer-tray')).toBeVisible({ timeout: 10_000 })
}

test.describe('Workflow 任务托盘同步 E2E', () => {
  test('T1: s3 的 workflow 历史记录在托盘挂载 + 面板桶计数/行集同源', async ({ page }) => {
    await activateSession(page)

    // 托盘条目（built-in 三件）：mock 对 s3 返回 1 条 workflow + 1 条 subagent 记录
    // （均终态）→ 两条目 dim 常驻；bash 无后台命令记录 → 不渲染
    const workflowBtn = builtinButton(page, 'workflow')
    await expect(workflowBtn).toBeVisible({ timeout: 10_000 })
    await expect(builtinButton(page, 'subagent')).toBeVisible()
    await expect(builtinButton(page, 'bash')).toHaveCount(0)

    // 归零不虚亮（设计 §4 N2）：running=0 → 计数与呼吸点元素不渲染（不是 opacity:0）
    await expect(workflowBtn.getByTestId('tray-builtin-count')).toHaveCount(0)
    await expect(workflowBtn.getByTestId('tray-builtin-pulse')).toHaveCount(0)

    // 点开面板：桶计数与行集同源（计数 0/1 = fixture 终态记录数）
    const panel = await openTrayPanel(page, 'workflow')
    await expect(panel.getByTestId('tray-panel-tab-running')).toHaveAttribute('data-active', 'true')
    await expect(panel.getByTestId('tray-panel-tab-count-running')).toHaveText('0')
    await expect(panel.getByTestId('tray-panel-tab-count-ended')).toHaveText('1')

    // 进行中桶为空 → 可行动空态（D9：提示 + 显式切桶按钮，不自动跳）
    await expect(panel.getByTestId('tray-panel-empty-hint')).toBeVisible()
    await panel.getByTestId('tray-panel-empty-jump-ended').click()

    // 已结束桶：行集渲染 fixture 的 scriptName + slug
    const row = panel.getByTestId('tray-workflow-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('deploy-flow')
    await expect(row.getByTestId('tray-workflow-slug')).toHaveText('deploy')
  })

  test('T2: 切到无 workflow 数据的 session 后托盘条目摘除，切回恢复', async ({ page }) => {
    await activateSession(page)
    await expect(builtinButton(page, 'workflow')).toBeVisible({ timeout: 10_000 })

    // 切到 s1（mock 对非 s3 返回空列表）→ 该条目整体摘除（无历史 = 隐藏，非空壳）
    await page.getByText('重构 auth 模块').click()
    await expect(builtinButton(page, 'workflow')).toHaveCount(0, { timeout: 10_000 })

    // 切回 s3 → 恢复（读分区，非残留）
    await page.getByText('API 性能优化').click()
    await expect(builtinButton(page, 'workflow')).toBeVisible({ timeout: 10_000 })
    await expect(builtinButton(page, 'subagent')).toBeVisible()
  })

  test('T3: 点面板 workflow 行 → drawer workflow tab 打开，composer 不被 overlay 遮挡', async ({ page }) => {
    await activateSession(page)

    const panel = await openTrayPanel(page, 'workflow')
    await panel.getByTestId('tray-panel-empty-jump-ended').click()
    await panel.getByTestId('tray-workflow-row').click()

    // 归宿（原 E2 第 1 段）：drawer workflow tab 打开，内容为 fixture 的 agent call 列表
    const drawerTab = page.getByTestId('drawer-workflow-tab')
    await expect(drawerTab).toBeVisible({ timeout: 5_000 })
    await expect(drawerTab).toContainText('deploy-flow')
    await expect(drawerTab).toContainText('dev-W1')

    // 不变量（原 E2 第 2 段）：drawer 并排打开不把 Panel 推进 overlay——composer 仍可见可用
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('drawer-area')).toBeVisible()
  })
})
