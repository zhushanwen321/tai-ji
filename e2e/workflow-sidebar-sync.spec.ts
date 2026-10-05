/**
 * Workflow 任务托盘同步 E2E —— Playwright + Electron + mock 轨。
 *
 * [改写 2026-09-16] 原断言面（侧栏 Flows/Agents tab 的 workflow-card / subagent-card /
 * workflow-detail）随侧栏任务 tab 退役（设计 docs/design/composer-task-tray.md——已删除，git 可追溯——D10/D11：
 * 任务观察入口唯一化收敛到 composer 任务托盘），本 spec 改挂托盘。文件名与登记 id 保留
 * （docs/testing/e2e-map.json E2E-MOCK-01 条目），语义从「侧栏列表同步」变为「托盘同步」。
 *
 * 分层定位（workflow-visualization 设计 §4 e2e 影响面评估 + 计划 u6 验收条款）：
 * 行渲染细节（分桶/格式化/两段式操作/空态）已沉淀 ComposerTray / TrayNativePanel 组件测试
 * （packages/renderer/src/__tests__/panel/tray/），本 spec 只保留 e2e 层不可替代的**跨进程链路**：
 *   mock 数据源 → store 分区 → useTrayCounts 计数/行集 → 托盘 DOM，
 * 以及「点托盘行 → workflow overlay」的归宿不变量（workflow-visualization U6/D1 入口改向
 * 后的回归守护对象；改向前归宿 = drawer workflow tab，git 可追溯）。
 *
 * 三条 case：
 * - T1：s3 存在 workflow 演员清单 → 托盘出现 workflow 条目（running>0 → 徽标 + 呼吸点）
 *       + 点开面板后桶计数与行集来自同一份数据（跨进程链路的 DOM 终点断言）
 * - T2：切到无 workflow 数据的 session → 托盘该条目整体摘除（归零不虚亮：DOM 层不存在，
 *       而非 opacity:0 / 空壳）；切回 s3 恢复（分区读，非残留）
 * - T3：点面板 workflow 行 → workflow overlay 打开（全屏临时层，D8 定稿①后 wf-mock-001
 *       DAG 通道成功 → 上区画布就绪形态 + 实况面板挂载；D1 改向后点行只开 overlay、
 *       不再开 drawer；降级形态断言载体已移 wf-mock-parse-failed 演员——overlay spec OV4）；
 *       ESC 关闭后 overlay 消失，composer 恢复可用、drawer 仍可正常打开（临时层不替换 Panel）
 *
 * mock 数据事实（packages/core/src/transport/mock/workflow-data.ts，本 spec 不改数据源；
 * 演员清单 SSOT = .tmp/dev-flow/ui-redesign-combined.runlog/u-wf-mock.md 冻结表）：
 * - getWorkflows('s3') = 11 条 WorkflowRunRecord（wf-mock-001 既有 done + D8 十演员）→
 *   进行中桶（status==='running'）4 条：wf-mock-running / wf-mock-pending / wf-mock-retrying /
 *   wf-mock-wide-phase；已结束桶（其余，含 interrupted——一次性生命周期 D-2 后 interrupted
 *   非 running 态）7 条：wf-mock-001 / wf-mock-failed / wf-mock-interrupted /
 *   wf-mock-stopped-time-limited / wf-mock-parse-failed / wf-mock-empty-dag /
 *   wf-mock-mismatched-calls
 * - getWorkflows(非 s3) = [] → 该类无记录 → 托盘条目整体不渲染
 * - 计数>0 分支（徽标 + 呼吸点）自 D8 演员入列起可达（running=4）；「归零不虚亮」的
 *   否定面断言保留在 T2（切无数据 session → 条目整体摘除）与托盘组件测试三态用例
 *
 * 运行：npx playwright test --project=electron e2e/workflow-sidebar-sync.spec.ts
 */
import { test, expect } from './fixtures/launch-app'
import type { Page, Locator } from '@playwright/test'

/** built-in 三件条目按钮（data-kind 区分；条目存在性 = 该 session 该类 total > 0） */
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
 *
 * 不点侧栏 segmented tab：sessions 是默认 activeTab，且 icon-only 模式下 tab 的 accessible
 * name 被计数徽标文本抢占（见 v6-shell-baseline.spec.ts activateSession 注释）。
 * 托盘挂载判据 = composer 可见（`v-if="sessionId"`，landing 态隐藏）。
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

test.describe('Workflow 任务托盘同步 E2E', () => {
  test('T1: s3 的 workflow 演员清单在托盘分桶挂载 + 面板桶计数/行集同源', async ({ page }) => {
    await activateSession(page)

    // 托盘条目（built-in 三件）：mock 对 s3 返回 11 条 workflow + 1 条 subagent 记录
    // （subagent 终态 idle）→ workflow 条目亮徽标（running=4）、subagent 条目 dim、
    // bash 无后台命令记录 → 不渲染
    const workflowBtn = builtinButton(page, 'workflow')
    await expect(workflowBtn).toBeVisible({ timeout: 10_000 })
    await expect(builtinButton(page, 'subagent')).toBeVisible()
    await expect(builtinButton(page, 'bash')).toHaveCount(0)

    // running=4 > 0 → 徽标 + 呼吸点亮（计数与面板桶同源：badgeCount = running 数）
    await expect(workflowBtn).toHaveAttribute('data-state', 'running')
    await expect(workflowBtn.getByTestId('tray-builtin-count')).toHaveText('4')
    await expect(workflowBtn.getByTestId('tray-builtin-pulse')).toBeVisible()

    // 点开面板：桶计数与行集同源（running 4 / ended 7 = 演员清单分桶）
    const panel = await openTrayPanel(page, 'workflow')
    await expect(panel.getByTestId('tray-panel-tab-running')).toHaveAttribute('data-active', 'true')
    await expect(panel.getByTestId('tray-panel-tab-count-running')).toHaveText('4')
    await expect(panel.getByTestId('tray-panel-tab-count-ended')).toHaveText('7')

    // 进行中桶（默认激活）：4 行，逐演员 slug 对账
    const runningRows = panel.getByTestId('tray-workflow-row')
    await expect(runningRows).toHaveCount(4)
    for (const slug of ['running', 'pending', 'retrying', 'wide-phase']) {
      await expect(workflowRowBySlug(page, panel, slug)).toHaveCount(1)
    }

    // 已结束桶：7 行（含 interrupted——非 running 态一律归已结束桶），逐演员 slug 对账
    await panel.getByTestId('tray-panel-tab-ended').click()
    await expect(panel.getByTestId('tray-panel-tab-ended')).toHaveAttribute('data-active', 'true')
    const endedRows = panel.getByTestId('tray-workflow-row')
    await expect(endedRows).toHaveCount(7)
    for (const slug of ['deploy', 'failed', 'interrupted', 'time-limited', 'parse-failed', 'empty-dag', 'mismatched']) {
      await expect(workflowRowBySlug(page, panel, slug)).toHaveCount(1)
    }
    // 既有 done 演员行身份抽查：scriptName + slug 同行（fixture 字面）
    await expect(workflowRowBySlug(page, panel, 'deploy')).toContainText('deploy-flow')
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

  test('T3: 点面板 workflow 行 → workflow overlay 打开（U6 入口改向），关闭后 composer/drawer 恢复', async ({ page }) => {
    await activateSession(page)

    // D1 改向后点 workflow 行只开 overlay、不再开 drawer（drawer WorkflowTab = 被动回落
    // 载体，设计 §3.3-D10）——「临时层不替换 Panel」不变量后置到 ESC 关闭后断言
    // （drawer 仍可正常打开）。不在点行前预开 drawer：drawer 打开压缩 composer 宽度
    // 触发密度状态机 L1（leftCluster 聚合为单图标按钮），tray-builtin-button 从 DOM
    // 摘除（ComposerTray v-if="!aggregated"），托盘面板行不可达。
    // 按演员 runId 定位目标行（D8 演员入列后单行定位改 slug 等值过滤）
    const panel = await openTrayPanel(page, 'workflow')
    await panel.getByTestId('tray-panel-tab-ended').click()
    const deployRow = workflowRowBySlug(page, panel, 'deploy')
    await deployRow.scrollIntoViewIfNeeded()
    await deployRow.click()

    // 归宿（U6/D1 入口改向后）：全屏 overlay 打开，header 显示 fixture 的 scriptName；
    // wf-mock-001 已接通 DAG 通道（D8 定稿①）→ 上区画布就绪形态（wfvz-dag-root），
    // 降级形态断言载体 = wf-mock-parse-failed 演员（workflow-viz-overlay.spec OV4）；
    // 下区实况面板挂载
    const overlay = page.getByTestId('wfvz-overlay')
    await expect(overlay).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('wfvz-overlay-header')).toContainText('deploy-flow')
    await expect(page.getByTestId('wfvz-dag-root')).toBeVisible()
    await expect(page.getByTestId('wf-viz-live-panel')).toBeVisible()

    // 临时浮层不变量：overlay 是临时层（非替换 Panel）——ESC 关闭后 overlay 消失、
    // composer 恢复可用、drawer-toggle 仍可正常打开 drawer（Panel 状态未被临时层改变）
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('drawer-toggle').click()
    await expect(page.getByTestId('drawer-area')).toBeVisible({ timeout: 5_000 })
  })
})
