/**
 * visual baseline: AppShell 整页 —— C层 Playwright 像素 diff（IF3）。
 *
 * 截 mock 模式 renderer 首屏（AppShell Landing 态，无 session 激活）。
 * baseline: e2e/visual-baselines/shell/shell-default.png（git tracked，Q3/D3）。
 *
 * F1 阶段 baseline 是 v3 现状占位（v6 视觉 F4 才落地，届时 --update-snapshots 更新）。
 * 运行：npx playwright test e2e/visual/shell.spec.ts --project=visual-chromium
 */
import { test, expect } from './fixtures/visual-server'

test.describe('visual baseline: shell', () => {
  test('shell-default: AppShell Landing 态整页', async ({ page, visualBaseURL }) => {
    await page.goto(visualBaseURL, { waitUntil: 'domcontentloaded' })
    // 等 AppShell 渲染（mock connection connecting→connected ~200ms 后 App.vue 守卫放行）
    await page.waitForSelector('.app-shell', { state: 'visible', timeout: 30_000 })
    // settle：等动画/loading/字体平息，保证 baseline 跨次稳定（R1 缓解）
    await page.waitForTimeout(1500)
    await expect(page).toHaveScreenshot('shell-default.png', {
      // 阈值容忍微小 flaky（字体抗锯齿/caret 闪烁，实测 ~11px）；真回归（如 --bg 全屏改动）远超 1% 仍触发（ERR4）
      maxDiffPixelRatio: 0.01,
      caret: 'hide',
    })
  })
})
