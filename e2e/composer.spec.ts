/**
 * Composer E2E —— 渲染 + 「添加内容」菜单入口（01-chat-panel-composer.md §2（Composer））。
 *
 * [R3 退役 2026-09-15] CF-2/CF-3/CF-6（# 文件候选 inline 触发/过滤/chip 插入）已删除：
 * composer 符号体系已改为 # session / $ file（ComposerInput.vue session-trigger / file-trigger），
 * 敲 #auth 触发 session 候选而非文件候选，断言永挂。git 可追溯。
 *
 * 覆盖用例：
 * - E2E-CF-1: composer 渲染（输入区可见）
 * - E2E-CF-4: + 菜单只剩「附件」「命令」（# 文件改走 inline，@ 引用废弃）
 * - E2E-CF-5: landing 态（无 session）+ 菜单也是 附件/命令 两项（守门已随 file 入口移除）
 *
 * 约束（见 00-overview.md §6）：
 * - CommandPopover portal 到 body，全局查命令 button
 * - SegmentedTab 按钮文本带计数，用正则前缀匹配
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 session（panel variant composer 出现在对话流下方）。
 * 用 s3「API 性能优化」（空消息 session，验证欢迎语）——避免 s1 的复杂流式干扰。
 * 侧栏默认 activeTab=sessions，直接等目标 session 可见后点选——不点「会话」segmented tab
 * （icon-only 模式下其 accessible name 被计数徽标文本抢占，定位时序脆弱，详见
 * v6-shell-baseline.spec.ts activateSession 注释）。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  // 等 composer 渲染（panel variant）
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('Composer 渲染与菜单入口 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/太极|TaiJi/)
  })

  test('E2E-CF-1: composer 渲染（输入区可见可聚焦）', async ({ page }) => {
    await activateSession(page)
    await page.getByRole('textbox').click()
    await expect(page.getByRole('textbox')).toBeFocused()
  })

  test('E2E-CF-4: + 菜单只剩「附件」「命令」（无文件/引用入口）', async ({ page }) => {
    await activateSession(page)
    await page.getByTitle(/添加内容/).click()
    // + 菜单 portal 到 body 渲染为 dialog。在 dialog 范围内断言，避免匹配侧边栏「文件」tab。
    // 命令项 accessible name 含 hint「/」（命令 /），用正则前缀匹配
    const menu = page.getByRole('dialog')
    await expect(menu.getByRole('button', { name: /^附件/ })).toBeVisible({ timeout: 5_000 })
    await expect(menu.getByRole('button', { name: /^命令/ })).toBeVisible()
    // 不含「文件」（改走 inline）和「引用」（@ 废弃）
    expect(await menu.getByRole('button', { name: /文件/ }).count()).toBe(0)
    expect(await menu.getByRole('button', { name: /引用/ }).count()).toBe(0)
  })

  test('E2E-CF-5: landing 态 + 菜单也是 附件/命令 两项（守门随 file 入口移除）', async ({ page }) => {
    // 不激活 session，保持 landing 态。等 landing composer 渲染
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
    await page.getByTitle(/添加内容/).click()
    // landing 与 session 态一致：附件/命令两项，无文件/引用
    const menu = page.getByRole('dialog')
    await expect(menu.getByRole('button', { name: /^附件/ })).toBeVisible({ timeout: 5_000 })
    await expect(menu.getByRole('button', { name: /^命令/ })).toBeVisible()
    expect(await menu.getByRole('button', { name: /文件/ }).count()).toBe(0)
  })
})
