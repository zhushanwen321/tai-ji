/**
 * Workspace E2E —— 最近工作区记录 popover（DirSelectPopover）渲染 + 空态 + 搜索过滤。
 *
 * 数据流（MOCK 轨）：VITE_MOCK=true → stores/workspace 走 @/api 门面 → mockApi.workspace，
 * listRecent 返回 3 条固定 records（project-a / project-b / another-foo）。
 * DirSelectPopover 读 workspaceStore.records（computed）即时渲染 + 搜索过滤。
 *
 * 覆盖用例（execution-plan T4.1-T4.3）：
 * - T4.1: 打开 popover 展示 mock 的 3 条 records（DOM 可见断言）
 * - T4.2: 搜索无命中 → 空态文案「暂无最近工作区」
 * - T4.3: 搜索 'foo' → 仅 another-foo 命中（project-a/b 被过滤）
 *
 * UI 结构约束（坑）：
 * - PopoverContent 经 PopoverPortal 渲染到 body（脱离 Landing 组件树）→ 用全局 getByTestId
 * - 列表项共用 testid 'workspace-item'（DirSelectPopover 给每条 record 传同一 test-id）→ 用 .count() / .filter({ hasText })
 * - 搜索框为普通 <input>（@taiji/ui Input），用 placeholder '搜索工作区' 精确定位（避开 landing composer 的 textarea）
 * - popover 有 fade/zoom 入场动画（reka-ui data-[state=open]:animate-in），点击后用 toBeVisible(timeout) 等挂载稳定
 */
import { test, expect } from './fixtures/launch-app'
import type { Page } from '@playwright/test'

/**
 * 打开 DirSelectPopover（landing 态点 directory chip），返回 popover 根 locator。
 * landing 态：无激活 session，composer 卡片渲染后 chip-directory 在 meta-row slot。
 */
async function openPopover(page: Page): Promise<void> {
  // 等 landing composer 卡片渲染（首次启动延迟 create，但 chip-directory 已在 meta-row slot）
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('chip-directory').click()
  // popover 经 PopoverPortal 挂到 body + 入场动画，等根可见
  // （动画期内 toBeVisible 会等 transform/opacity 稳定，避免 fill 误中移动中的元素）
  await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
}

test.describe('最近工作区 popover E2E（T4.1-T4.3）', () => {
  test('T4.1: 打开 popover 展示 mock 的 3 条 records', async ({ page }) => {
    await openPopover(page)
    // 列表项：PopoverListItem 共用 test-id 'workspace-item'（v-for 渲染 3 个同 testid 节点）
    const items = page.getByTestId('workspace-item')
    await expect(items).toHaveCount(3)
    // 3 条都可见：hasText 在 button 层匹配后代文本（label + cwd 路径都含同名段，均命中）
    await expect(items.filter({ hasText: 'project-a' })).toBeVisible()
    await expect(items.filter({ hasText: 'project-b' })).toBeVisible()
    await expect(items.filter({ hasText: 'another-foo' })).toBeVisible()
  })

  test('T4.2: 搜索无命中 → 空态文案「暂无最近工作区」', async ({ page }) => {
    await openPopover(page)
    // 搜索框：普通 <input>，placeholder 精确定位（避开 landing composer 的 textarea）
    const search = page.getByPlaceholder('搜索工作区')
    await expect(search).toBeVisible()
    await search.fill('zzz-no-match')
    // filtered（computed 即时，无 debounce）变空 → empty-state 出现
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 3_000 })
    // 空态文案（DirSelectPopover：暂无最近工作区 · 选择一个本地目录开始）
    await expect(page.getByTestId('empty-state')).toContainText('暂无最近工作区')
    // 列表项被清空（强化：非仅空态可见，列表确已无项）
    await expect(page.getByTestId('workspace-item')).toHaveCount(0)
  })

  test('T4.3: 搜索 foo → 仅 another-foo 命中（过滤掉 project-a/b）', async ({ page }) => {
    await openPopover(page)
    const search = page.getByPlaceholder('搜索工作区')
    await expect(search).toBeVisible()
    await search.fill('foo')
    // 过滤逻辑按 cwd 子串匹配（label 是 basename，是其 cwd 子串，单匹配 cwd 即覆盖两者）
    // 'foo' 命中 /Users/demo/another-foo；project-a/b 的 cwd 不含 foo
    const items = page.getByTestId('workspace-item')
    await expect(items).toHaveCount(1)
    await expect(items.filter({ hasText: 'another-foo' })).toBeVisible()
    // project-a / project-b 不应残留
    expect(await items.filter({ hasText: 'project-a' }).count()).toBe(0)
    expect(await items.filter({ hasText: 'project-b' }).count()).toBe(0)
  })
})
