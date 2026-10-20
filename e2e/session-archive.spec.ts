/**
 * session 归档行为 E2E —— mock 轨雏形（session-archive 设计 §8 V1-V10 / impl-plan u-e2e-cases）。
 *
 * 覆盖面声明：
 * - mock 轨可跑（本文件）：V1 归档交互主链（两段确认 + 行消失 + 角标）/ V2 归档列表与
 *   摘要视图渲染 / V4 恢复交互（切回会话列表 + 回场）/ V8 彻底删除两段确认 + 空态 /
 *   V5① 生成中归档钮禁用（D13 renderer 门）。数据流 = VITE_MOCK=true → mockApi.session
 *   归档四函数（archive/unarchive/purgeArchive/listArchives——内存 mockArchives 派生
 *   视图，mock 无磁盘搬移/压缩/staging 过渡）。
 * - L3-only（mock 轨不可达，D3 验收实例化按 exec-plan 验收计划 A1-A10 执行）：V3 agent
 *   session_read 引用（需真 extension 链路）/ V5② wscat 直发 RPC 生成中门（需真 runtime）/
 *   V6 恢复冲突 fail-fast / V7 崩溃自愈全中间态 / V9 后台任务在途收殓 / V10 staging 过渡态
 *   三处可见性 + V1/V4/V8 的全部磁盘断言（簿记/压缩体/旁挂/附件树/逐字节一致）。
 *   L3 磁盘 fixture 构造 = packages/runtime/src/services/archive/archive-fixture.ts
 *   （公共归档构造 helper——簿记/压缩体/旁挂/附件树/自愈中间态/引用族一键构造）。
 *
 * 触发条件（R2 登记，e2e-map 登记归 u-docs-registration）：改
 * packages/renderer/src/components/{archive,sidebar}/、useArchiveView、SessionItemActions、
 * core mock 归档域时在 dev-flow 验收阶段跑本 spec。
 *
 * UI 结构约束（坑，均经实装核实）：
 * - 行内归档钮悬停才显现（opacity-0 group-hover/item）→ 先 hover 行根（.session-item）
 *   再点 session-archive-btn（每行一个，用行容器收窄定位）。
 * - 两段确认：第一次点击进 accent 确认态（title「再次点击确认归档」），第二次才执行。
 * - 归档行悬停双钮同理（archive-row-restore-btn / archive-row-purge-btn 每行一组）。
 * - mock fixture：idle session s3「API 性能优化」（data.ts fixtureSessions）；激活 session
 *   = e2eTestSession「E2E 文件树测试」。
 * - mock 归档条目压缩信息 = rawBytes 1024 / compressedBytes 256 → 「1.0 KB → 256 B · -75%」。
 */
import { test, expect } from './fixtures/launch-app'
import type { Page } from '@playwright/test'

/** 侧栏内 session 行根容器（.session-item + 文本收窄——每行一个，归档钮在行内）。 */
function sessionRow(page: Page, label: string) {
  return page.locator('.session-item', { hasText: label })
}

/** 悬停行 + 点归档钮两段确认（第一次进确认态，第二次执行）。 */
async function archiveFromSidebar(page: Page, label: string): Promise<void> {
  const row = sessionRow(page, label)
  await row.hover()
  const btn = row.getByTestId('session-archive-btn')
  await expect(btn).toBeVisible({ timeout: 5_000 })
  // 两段确认：首次点击进 accent 确认态（title 切换），再次点击才 emit archive。
  await btn.click()
  await expect(btn).toHaveAttribute('title', '再次点击确认归档')
  await btn.click()
}

test.describe('session 归档行为 E2E（V1/V2/V4/V8/V5① mock 轨）', () => {
  test('V1 交互面：悬停两段确认归档 → 行消失 + 归档入口角标 +1', async ({ page }) => {
    // 起 app 后等侧栏渲染 fixture 列表。
    await expect(page.getByTestId('session-list-header')).toBeVisible({ timeout: 10_000 })
    const row = sessionRow(page, 'API 性能优化')
    await expect(row).toBeVisible()
    // 归档前角标隐藏（mock 初始 archiveCount = 0，D10：count 0 角标隐藏）。
    await expect(page.getByTestId('sidebar-archive-count-badge')).toHaveCount(0)

    await archiveFromSidebar(page, 'API 性能优化')

    // 行消失（mock archive 移除 fixtureSessions + 广播 config.sessions）。
    await expect(sessionRow(page, 'API 性能优化')).toHaveCount(0, { timeout: 5_000 })
    // 角标出现（archiveCount 随广播帧）。
    await expect(page.getByTestId('sidebar-archive-count-badge')).toBeVisible()
    await expect(page.getByTestId('sidebar-archive-count-badge')).toHaveText('1')
  })

  test('V2 交互面：归档列表行结构 + 点击进摘要视图（banner/已归档 pill/恢复钮）', async ({ page }) => {
    await expect(page.getByTestId('session-list-header')).toBeVisible({ timeout: 10_000 })
    await archiveFromSidebar(page, 'API 性能优化')
    await expect(sessionRow(page, 'API 性能优化')).toHaveCount(0, { timeout: 5_000 })

    // 打开归档列表（工具组归档钮）。
    await page.getByTestId('sidebar-archive-entry-btn').click()
    await expect(page.getByTestId('archive-list-view')).toBeVisible({ timeout: 5_000 })

    // 列表头计数（「已归档」+ 数字 1）。
    await expect(page.getByTestId('archive-list-header')).toBeVisible()
    await expect(page.getByTestId('archive-list-count')).toHaveText('1')
    // 行结构：sessionId = s3（mock fixture）；名称 + 压缩信息（mock rawBytes 1024 → 256）。
    const row = page.getByTestId('archive-row-s3')
    await expect(row).toBeVisible()
    await expect(row).toContainText('API 性能优化')
    await expect(page.getByTestId('archive-row-compression-s3')).toContainText('1.0 KB → 256 B · -75%')

    // 点击行 → 主区摘要视图（D11：banner + 已归档 pill + tab + 恢复钮）。
    await row.click()
    await expect(page.getByTestId('archive-summary-view')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('archive-summary-banner')).toBeVisible()
    await expect(page.getByTestId('archive-archived-pill')).toBeVisible()
    await expect(page.getByTestId('archive-summary-name')).toContainText('API 性能优化')
    await expect(page.getByTestId('archive-restore-button')).toBeVisible()
    // mock 归档条目带一条演示 turn（「（mock 归档演示）」user 气泡，agent 为占位——agent null）。
    await expect(page.getByTestId('archive-summary-flow')).toBeVisible()
  })

  test('V4 交互面：归档列表悬停恢复 → 侧栏切回会话列表 + session 回场', async ({ page }) => {
    await expect(page.getByTestId('session-list-header')).toBeVisible({ timeout: 10_000 })
    await archiveFromSidebar(page, 'API 性能优化')
    await expect(sessionRow(page, 'API 性能优化')).toHaveCount(0, { timeout: 5_000 })
    await page.getByTestId('sidebar-archive-entry-btn').click()
    await expect(page.getByTestId('archive-list-view')).toBeVisible({ timeout: 5_000 })

    // 悬停归档行 → 恢复钮显现（opacity-0 group-hover/row）→ 点击。
    const row = page.getByTestId('archive-row-s3')
    await row.hover()
    await row.getByTestId('archive-row-restore-btn').click({ timeout: 5_000 })

    // 恢复成功编排：侧栏切回会话列表（useArchiveView.restoreArchive closeView + 回 chat）。
    await expect(page.getByTestId('archive-list-view')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('session-list-header')).toBeVisible({ timeout: 5_000 })
    // session 回场（mock unarchive 放回 fixtureSessions + 广播）。
    await expect(sessionRow(page, 'API 性能优化')).toBeVisible({ timeout: 5_000 })
    // 角标归零隐藏。
    await expect(page.getByTestId('sidebar-archive-count-badge')).toHaveCount(0, { timeout: 5_000 })
  })

  test('V8 交互面：彻底删除两段红确认 → 条目消失 + 空态', async ({ page }) => {
    await expect(page.getByTestId('session-list-header')).toBeVisible({ timeout: 10_000 })
    await archiveFromSidebar(page, 'API 性能优化')
    await expect(sessionRow(page, 'API 性能优化')).toHaveCount(0, { timeout: 5_000 })
    await page.getByTestId('sidebar-archive-entry-btn').click()
    await expect(page.getByTestId('archive-list-view')).toBeVisible({ timeout: 5_000 })

    const row = page.getByTestId('archive-row-s3')
    await row.hover()
    const purgeBtn = row.getByTestId('archive-row-purge-btn')
    // 两段红确认：首次点击进 danger 确认态（title 切换为确认文案），再次点击执行。
    await purgeBtn.click({ timeout: 5_000 })
    await expect(purgeBtn).toHaveAttribute('title', '确认彻底删除？')
    await purgeBtn.click()

    // 条目消失 + 空态（mock purgeArchive 移除条目；唯一条目删空后触达 D10 空态）。
    await expect(page.getByTestId('archive-row-s3')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('archive-list-empty')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('archive-list-empty')).toContainText('暂无归档会话')
    await expect(page.getByTestId('archive-list-count')).toHaveText('0')
  })

  test('V5① renderer 门：生成中 session 行归档钮禁用 + title 说明', async ({ page }) => {
    // 先激活 e2eTestSession 再发送（landing 态直发会挂到 mock 新建 session，消息必须
    // 挂到目标行 session 才能驱动其行内 generating 派生）——激活范式对齐
    // v6-shell-baseline activateSession（直接点行文本等 composer 渲染）。
    const targetRow = sessionRow(page, 'E2E 文件树测试')
    await targetRow.click()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('归档门测试')
    await input.press('Enter')
    // message_start 后 isGenerating=true → stop-btn 出现（isGenerating 的可见锚点）。
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 流式中悬停该 session 行：归档钮 disabled + title「生成中不可归档」（D13 renderer
    // 拦截层；runtime archive_generating 门为 V5② L3 面）。
    const row = sessionRow(page, 'E2E 文件树测试')
    await expect(row).toBeVisible({ timeout: 5_000 })
    await row.hover()
    const btn = row.getByTestId('session-archive-btn')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('title', '生成中不可归档')
  })
})
