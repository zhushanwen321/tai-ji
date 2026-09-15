/**
 * Workflow 侧边栏交互同步 E2E —— Playwright + Electron + mock 轨。
 *
 * 验证 workflow 侧边栏与右侧 Panel 的交互修复（回归防护）：
 * - E1：选中 session 后切 Flows/Agents tab，列表渲染正确（workflow-card / subagent-card）
 * - E2：点 workflow 卡片 → 侧边栏进 detail 视图（workflow-detail），右侧 Panel 不进子代理
 *       overlay 态（composer-box 仍可见，subagent-back-btn 不存在）
 *
 * [R3 退役 2026-09-15] E3（workflow detail 内点 agent call → Panel 进 overlay）已删除：
 * agent call overlay 改版，subagent-back-btn testid 不存在，断言永挂。git 可追溯。
 *
 * mock 数据流（VITE_MOCK=true → renderer mock API）：
 * - getWorkflows → 1 条 WorkflowRunRecord（runId=wf-mock-001, scriptName=deploy-flow，
 *   2 个 agentCalls：sessionId=sess-agent-mock-1 / sess-agent-mock-2）
 * - getSubagents → 1 条 SubagentRecord（subagentId=sub-mock-001, agent=reviewer）
 * - getAgentCallHistory → 空数组（不 throw，agent call overlay 不报错）
 * mock 有 TIMING.ack ≈ 40ms sleep 延迟，断言用 toBeVisible({ timeout }) 等终态。
 *
 * 运行：npx playwright test e2e/workflow-sidebar-sync.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（「API 性能优化」），进入会话态后 composer 可见。
 *
 * 切 tab 用 button[title="..."] 属性选择器而非 getByRole(name=…)：SegmentedTab 是 icon-only
 * 按钮，title 持有中文 label（会话/文件/子代理/工作流）。当某 tab count>0 时按钮文本变成数字，
 * getByRole 的 accessible name 由文本（数字）决定，会盖掉 title → 正则 /子代理/ 等不稳定
 * （count 为 0 时 name=title、count>0 时 name=数字，存在时序竞态）。
 * 直接按 title 属性定位恒定唯一，避免 flakiness。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('button[title="会话"]').click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('Workflow 侧边栏交互同步 E2E', () => {
  test('E1a: s3 session 的 Flows tab 显示 workflow 列表，Agents tab 显示 subagent 列表', async ({ page }) => {
    await activateSession(page)

    // 切到工作流 tab，等待 workflow-card 渲染（mock getWorkflows 对 s3 返回非空）
    await page.locator('button[title="工作流"]').click()
    await expect(page.getByTestId('workflow-card')).toBeVisible({ timeout: 10_000 })
    // 确认 mock fixture 的 scriptName 渲染
    await expect(page.getByText('deploy-flow')).toBeVisible()

    // 切到子代理 tab，等待 subagent-card 渲染
    await page.locator('button[title="子代理"]').click()
    await expect(page.getByTestId('subagent-card')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('reviewer')).toBeVisible()
  })

  test('E1b: 切到无 workflow 的 session 后 Flows tab 显空态，切回 s3 列表恢复', async ({ page }) => {
    await activateSession(page)

    // s3 有 workflow → Flows tab 显示列表
    await page.locator('button[title="工作流"]').click()
    await expect(page.getByTestId('workflow-card')).toBeVisible({ timeout: 10_000 })

    // 切到 s1（无 workflow 数据）→ 列表应为空态
    await page.locator('button[title="会话"]').click()
    await expect(page.getByText('重构 auth 模块')).toBeVisible({ timeout: 10_000 })
    await page.getByText('重构 auth 模块').click()
    await page.locator('button[title="工作流"]').click()
    // mock 对非 s3 session 返回空 → 空态占位
    await expect(page.getByTestId('workflow-list-empty')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('workflow-card')).toHaveCount(0)

    // 切回 s3 → 列表恢复（验证不是残留）
    await page.locator('button[title="会话"]').click()
    await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
    await page.getByText('API 性能优化').click()
    await page.locator('button[title="工作流"]').click()
    await expect(page.getByTestId('workflow-card')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('deploy-flow')).toBeVisible()
  })

  test('E2: 点 workflow 卡片 → 侧边栏进 detail 视图，Panel 不进 overlay（composer 仍可见）', async ({ page }) => {
    await activateSession(page)

    // 切到工作流 tab，点 workflow 卡片
    await page.locator('button[title="工作流"]').click()
    await expect(page.getByTestId('workflow-card')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('workflow-card').click()

    // 侧边栏进 detail 视图（视图2）
    await expect(page.getByTestId('workflow-detail')).toBeVisible({ timeout: 5_000 })

    // Panel 不进 overlay：composer-box 仍可见，subagent-back-btn 不存在
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('subagent-back-btn')).toHaveCount(0)
  })
})
