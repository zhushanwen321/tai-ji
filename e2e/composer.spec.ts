/**
 * Composer E2E —— `#` 文件候选 inline 触发 + 过滤 + chip 插入（01-chat-panel-composer.md §2（Composer）§8/§9）。
 *
 * 数据流（MOCK 轨）：VITE_MOCK=true → composer domain 走 mockApi.composer，
 * getFileCandidates 返回 FILE_CANDIDATES 映射的 FileNode[]（src/auth/、AuthService.ts、token.ts）。
 * real file.search 的数据正确性由 runtime 单测（file-service.test.ts U1-U12）覆盖，
 * 本 E2E 验证 UI 流程（inline 触发 / query 过滤 / 选中插 chip / 入口移除）。
 *
 * 覆盖用例：
 * - E2E-CF-1: composer 渲染（输入区可见）
 * - E2E-CF-2: 敲 #auth → # 浮层弹出 + 候选可见（inline 触发）
 * - E2E-CF-3: 选中文件 → 插入 # chip + #query 文本被清理
 * - E2E-CF-4: + 菜单只剩「附件」「命令」（# 文件改走 inline，@ 引用废弃）
 * - E2E-CF-5: landing 态（无 session）+ 菜单也是 附件/命令 两项（守门已随 file 入口移除）
 * - E2E-CF-6: 敲 #token → query 过滤到仅 token.ts（验证 name+path 过滤）
 *
 * 约束（见 00-overview.md §6）：
 * - contenteditable 用 pressSequentially（fill 可能不触发 input / 光标定位）
 * - CommandPopover portal 到 body，全局查命令 button
 * - SegmentedTab 按钮文本带计数，用正则前缀匹配
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 session（panel variant composer 出现在对话流下方）。
 * 用 s3「API 性能优化」（空消息 session，验证欢迎语）——避免 s1 的复杂流式干扰。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  // 等 composer 渲染（panel variant）
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('Composer # 文件候选 inline 触发 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('E2E-CF-1: composer 渲染（输入区可见可聚焦）', async ({ page }) => {
    await activateSession(page)
    await page.getByRole('textbox').click()
    await expect(page.getByRole('textbox')).toBeFocused()
  })

  test('E2E-CF-2: 敲 #auth → # 浮层弹出 + 候选可见（inline 触发）', async ({ page }) => {
    await activateSession(page)
    // contenteditable：用 pressSequentially 逐字触发 input + 光标定位（detectHashTrigger 依赖光标位置）
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('#auth')
    // CommandPopover 浮层弹出（portal 到 body），展示 mock 候选（用 button 角色定位，不依赖 wrapper 选择器）
    // FILE_CANDIDATES 经 name+path 过滤 'auth' 后含：src/auth/、AuthService.ts、token.ts（path 都含 auth）
    await expect(page.getByRole('button', { name: /AuthService\.ts/ })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: /token\.ts/ })).toBeVisible()
  })

  test('E2E-CF-3: 选中文件 → 插入 # chip + #query 文本被清理', async ({ page }) => {
    await activateSession(page)
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('#token')
    // 等 token.ts 候选可见后选中（用 button 角色定位候选项，避免与 chip 文本混淆）
    const tokenBtn = page.getByRole('button', { name: /token\.ts/ })
    await expect(tokenBtn).toBeVisible({ timeout: 5_000 })
    await tokenBtn.click()
    // 浮层关闭：候选 button 消失
    await expect(page.getByRole('button', { name: /token\.ts/ })).toHaveCount(0)
    // 输入区含 # chip（mention-file span，文本含 token.ts）
    const input = page.getByRole('textbox')
    await expect(input).toContainText(/token\.ts/)
    // #query 文本被清理：输入区不应残留裸 "#token" 文本（chip 是 #token.ts）
    // chip class 为 mention-file，文本含 #token.ts；裸 #token 文本不应单独存在
    const inputText = await input.textContent()
    // 允许 chip 文本 #token.ts，但不允许 #token 后无 .ts 的裸触发文本残留
    expect(inputText).not.toMatch(/#token(?!\.ts)/)
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

  test('E2E-CF-6: 敲 #token → query 过滤到仅 token.ts（name+path 过滤验证）', async ({ page }) => {
    await activateSession(page)
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('#token')
    // #token 过滤：token.ts 命中（name 含 token）；AuthService.ts 不命中（name+path 都不含 token）
    await expect(page.getByRole('button', { name: /token\.ts/ })).toBeVisible({ timeout: 5_000 })
    // src/auth/ 的 path 不含 token，应被过滤掉
    expect(await page.getByRole('button', { name: /AuthService/ }).count()).toBe(0)
  })
})
