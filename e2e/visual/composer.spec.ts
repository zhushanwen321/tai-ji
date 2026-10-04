/**
 * visual baseline: composer 区域 —— C层 Playwright 像素 diff（IF3）。
 *
 * 激活 session（'API 性能优化'）后 main panel 载入 chat workspace，截 composer-box。
 * baseline: e2e/visual-baselines/composer.spec/composer-default.png（git tracked，Q3/D3）。
 *
 * activateSession 复用 e2e/v6-shell-baseline.spec.ts 范式。mock 模式（VITE_MOCK=true，无 VITE_E2E）
 * session list 是 fixtureSessions（8 个：5 个演示态 + s3 的 3 个 agent 子会话 s3-c1/c2/c3，
 * 如「重构 auth 模块」/「API 性能优化」等），不依赖 e2eTestSession 注入。本 spec 的托盘 session
 * 条目断言依赖 s3 的三个子会话。
 * 运行：npx playwright test e2e/visual/composer.spec.ts --project=visual-chromium
 */
import { test, expect } from './fixtures/visual-server'
import type { Page } from '@playwright/test'

/**
 * 激活指定 label 的 session，等 composer-box 渲染（复用 v6-shell-baseline.spec.ts 范式）。
 *
 * mock 模式 sidebar.activeTab 默认 'sessions'，session list 随 AppShell 挂载渲染。
 * 先直接等目标 session 文本可见，短时未现再点「会话」tab 兜底。
 */
async function activateSession(page: Page, label: string): Promise<void> {
  const sessionItem = page.getByText(label)
  try {
    await expect(sessionItem).toBeVisible({ timeout: 6_000 })
  } catch {
    // 兜底：activeTab 被持久化为非 sessions 时，点「会话」tab 切回
    await page.getByRole('button', { name: /^会话/ }).click()
    await expect(sessionItem).toBeVisible({ timeout: 10_000 })
  }
  await sessionItem.click()
  // 激活后退出 Landing 态、main panel 载入 chat workspace → composer-box 渲染
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
}

test.describe('visual baseline: composer', () => {
  test('composer-default: 激活 session 后 composer-box 区域', async ({ page, visualBaseURL }) => {
    await page.goto(visualBaseURL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-shell', { state: 'visible', timeout: 30_000 })
    await activateSession(page, 'API 性能优化')
    // 截图主体在场断言（[2026-09-16 composer-task-tray] 托盘是本次基线变更的驱动元素）：
    // 只等 composer-box 会把「托盘未挂载」静默照成基线，视觉轨的断言对象必须显式在场。
    // s3 = 'API 性能优化'，mock 对该 session 有 workflow/subagent 历史记录 → 托盘挂 dim 条目。
    await expect(page.getByTestId('composer-tray')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="tray-builtin-button"][data-kind="workflow"]')).toBeVisible()
    // [u7a / u7 已落地：回归断言] 第 4 件 session kind：mock fixture 给 s3 挂了 3 个
    // parentAgentSessionId='s3' 的子会话 → 托盘必须渲染 session 条目（计数 ● 3）。
    // 托盘条目存在性同时是视觉基线断言对象（底栏重排 + 第 4 件是本次基线变更驱动元素）。
    await expect(page.locator('[data-testid="tray-builtin-button"][data-kind="session"]')).toBeVisible()
    // settle：等 composer 渲染 + 动画平息
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('composer-box')).toHaveScreenshot('composer-default.png', {
      // 阈值容忍微小 flaky（字体抗锯齿/caret 闪烁）；真回归远超 1% 仍触发（ERR4）
      maxDiffPixelRatio: 0.01,
      caret: 'hide',
    })
  })
})
