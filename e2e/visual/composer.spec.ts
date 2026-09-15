/**
 * visual baseline: composer 区域 —— C层 Playwright 像素 diff（IF3）。
 *
 * 激活 session（'E2E 文件树测试'）后 main panel 载入 chat workspace，截 composer-box。
 * baseline: e2e/visual-baselines/composer/composer-default.png（git tracked，Q3/D3）。
 *
 * activateSession 复用 e2e/v6-shell-baseline.spec.ts 范式。mock 模式（VITE_MOCK=true，无 VITE_E2E）
 * session list 是 fixtureSessions（5 个：重构 auth 模块 / API 性能优化 等），不依赖 e2eTestSession 注入。
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
    // settle：等 composer 渲染 + 动画平息
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('composer-box')).toHaveScreenshot('composer-default.png', {
      // 阈值容忍微小 flaky（字体抗锯齿/caret 闪烁）；真回归远超 1% 仍触发（ERR4）
      maxDiffPixelRatio: 0.01,
      caret: 'hide',
    })
  })
})
