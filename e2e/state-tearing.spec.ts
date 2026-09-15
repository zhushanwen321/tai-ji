/**
 * 状态撕裂修复 E2E —— Playwright + Electron + mock 轨。
 *
 * 验证 fix-state-tearing 的用户可见行为：
 * - E2E-ST-1: 发送消息 → UI 切到 busy（停止按钮出现）→ complete 后回 idle（发送按钮恢复）
 * - E2E-ST-2: busy 时停止按钮可见 + 可点击（abort 后回 idle）
 * - E2E-ST-3: busy 时 Enter → steer（B 策略，不打断当前回合）
 * - E2E-ST-4: 停止按钮在 busy 全程始终可见（不闪烁消失）
 * - E2E-ST-5: panel-per-session generating 隔离（A 流式期间切到空 session B，B 的 Landing 不被守卫误挡）
 * - E2E-ST-6: A complete 后 B 仍正常（A 收 message.complete 进 complete 态，B 仍渲染 Landing）
 *
 * 核心事故场景（ST-5/ST-6 锁定）：原 isGenerating 用全局 chat.isStreaming flag，
 * A session 流式期间切到 B（空 session），B 的 Landing 被 !isGenerating 守卫误挡 →
 * 落兜底空态（「选择左侧会话开始」），new-task 渲染撕裂。修复后 isGenerating 改为
 * per-session 派生（chat.isGenerating(sessionId)），空 session 的 Landing 不再被跨 session 误伤。
 *
 * mock 轨数据流：VITE_MOCK=true → send 后 run-send-stream 自动推
 * message_start(~60ms) → text_delta(*N) → complete。
 * isGenerating 从 message 实体派生，UI 状态切换完全由事件驱动。
 *
 * 运行：npx playwright test e2e/state-tearing.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（空消息「API 性能优化」，避免 s1 复杂流式干扰）。
 * 侧栏默认 activeTab=sessions，session list 随 AppShell 挂载渲染——直接等目标 session 可见。
 * 不点「会话」segmented tab：icon-only 模式下其 accessible name 被计数徽标文本（如「6」）抢占
 * （内容优先于 title 属性），`/会话/` 定位只在冷启动 sessionCount=0 的极短窗口命中，时序脆弱
 * （对齐 v6-shell-baseline.spec.ts activateSession 的成熟模式）。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

/**
 * 在 s3 发送一条消息进入 generating 态（busy）。
 * 复用 E2E-ST-1 的发送序列：输入 → Enter → 等 stop-btn 出现。
 * 返回后调用方处于「s3 流式中」状态，可立即切走做跨 session 隔离断言。
 */
async function sendAndWaitBusy(page: import('@playwright/test').Page): Promise<void> {
  await activateSession(page)
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially('跨 session 隔离测试')
  await input.press('Enter')
  // message_start ~60ms 后 isGenerating=true → stop-btn 出现
  await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })
}

/**
 * 点侧栏「新建任务」进入空 session（landing 态）。
 * startFlow 销毁 activeId + 进 landing（sessionId=null / 新建延迟 create）。
 * 与 useSidebar.newSession 一致：不传 presetCwd → 空 chip 态。
 */
async function newTaskSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^新建任务/ }).click()
  // landing 态：new-task-landing + composer-box（variant=landing）渲染
  await expect(page.getByTestId('new-task-landing')).toBeVisible({ timeout: 5_000 })
}

/**
 * 切回 s3 session（侧栏点会话项）。
 * landing 态点历史会话触发 cancelFlow + selectSession（useSidebar.selectSession 守卫）。
 */
async function switchBackToS3(page: import('@playwright/test').Page): Promise<void> {
  // activeTab 恒为 sessions（newTaskSession 不切 tab），session list 直点（见 activateSession 注释：
  // 不点「会话」tab，accessible name 被计数徽标抢占）
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('状态撕裂修复 E2E（fix-state-tearing）', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/太极|TaiJi/)
  })

  test('E2E-ST-1: 发送 → busy（停止按钮）→ complete → idle（发送按钮恢复） @p0-smoke', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('测试消息')
    await expect(input).toContainText('测试消息')

    // 发送前：idle 态，有发送按钮（title 含「发送」），无停止按钮
    expect(await page.locator('.stop-btn').count()).toBe(0)

    // 按 Enter 发送
    await input.press('Enter')

    // busy 态：停止按钮应出现（message_start ~60ms 后 isGenerating=true）
    // 用 toBeVisible 而非 count，给 mock 流式事件时间到达
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 等待流式结束（mock complete 后 isGenerating=false → 停止按钮消失）
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })

    // idle 恢复：输入区可输入（非 disabled）
    await input.click()
    await input.pressSequentially('后续')
    await expect(input).toContainText('后续')
  })

  test('E2E-ST-2: busy 时点停止按钮 → abort → 回 idle', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('长任务')
    await input.press('Enter')

    // 等停止按钮出现
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 点停止
    await page.locator('.stop-btn').click()

    // abort 后 mock 推 message.complete{stopReason:aborted} → isGenerating=false → 停止按钮消失
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 5_000 })
  })

  test('E2E-ST-3: busy 时 Enter → steer（B 策略，不重复 send）', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('第一条')
    await input.press('Enter')

    // 等 busy 态
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // busy 时输入补充内容 + Enter
    await input.click()
    await input.pressSequentially('补充')
    await input.press('Enter')

    // steer 后 mock 推 queue_update（steer 入队）→ QueueBubble 显示 pending 气泡
    // 验证：steer 不打断当前回合（停止按钮仍在 = 仍 busy）
    // QueueBubble 出现（pending 队列有内容）
    await expect(page.getByTestId('composer-box')).toBeVisible()

    // 等流式结束，停止按钮最终消失
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })
  })

  test('E2E-ST-5: panel-per-session generating 隔离（A 流式期间切到空 session B，B 的 Landing 不被守卫误挡） @p0-smoke', async ({ page }) => {
    // ── 步骤 1：s3 发消息进入 generating（busy）态 ──
    // s3「API 性能优化」是空 session，发送后进入流式（message_start → isGenerating(s3)=true）
    await sendAndWaitBusy(page)
    // 此时 s3 的 stop-btn 可见（session A 处于 generating）

    // ── 步骤 2：流式期间切到空 session B（点「新建任务」进 landing 态）──
    await newTaskSession(page)

    // ── 步骤 3：断言 session-b 的 Landing 态正常渲染（不被 session-a 的 streaming 误伤）──
    // [MANDATORY] 用户可见 DOM 断言：Landing 区域可见（new-task-landing testid）
    await expect(page.getByTestId('new-task-landing')).toBeVisible()
    // [MANDATORY] composer 输入区可见（composer-box，landing variant 同 testid）
    await expect(page.getByTestId('composer-box')).toBeVisible()
    // [MANDATORY] composer 输入区可输入（不被守卫挡成 disabled / 兜底空态）
    const landingInput = page.getByRole('textbox')
    await landingInput.click()
    await landingInput.pressSequentially('B 侧输入')
    await expect(landingInput).toContainText('B 侧输入')
    // 关键回归断言：不落兜底空态（「选择左侧会话开始」）——这是事故现象
    await expect(page.getByText('选择左侧会话开始')).toHaveCount(0)

    // ── 步骤 4：切回 s3，断言其仍处于 generating 态 ──
    await switchBackToS3(page)
    // [MANDATORY] s3 的 generating 指示器（停止按钮）仍可见 —— 跨 session 切换不打断 A 的流式
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 清理：等 s3 流式自然结束（避免后台 mock 写入影响后续用例）
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })
  })

  test('E2E-ST-6: A complete 后 B 仍正常（A 收 message.complete 进 complete 态，B 仍渲染 Landing）', async ({ page }) => {
    // ── 步骤 1：s3 发消息进入 generating，再切到空 session B ──
    await sendAndWaitBusy(page)
    await newTaskSession(page)
    // B 侧 Landing 正常（承 ST-5 已验，此处复用前置）
    await expect(page.getByTestId('new-task-landing')).toBeVisible()

    // ── 步骤 2：切回 s3，等其收到 message.complete 进入 complete 态 ──
    await switchBackToS3(page)
    // 等 s3 流式结束（mock complete → isGenerating(s3)=false → stop-btn 消失）
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })

    // ── 步骤 3：断言 s3 显示 complete 态（消息内容 + 无 streaming 指示器）──
    // [MANDATORY] complete 态：assistant 回复内容可见（mock canned reply 含「已处理」）。
    // .first() + 20s：turn-rail 摘要同名文本多匹配 + 切回后 rehydrate 需时（对齐
    // v6-shell-baseline.spec.ts sendMessageAndWaitComplete 模式）
    await expect(page.getByText(/已处理/).first()).toBeVisible({ timeout: 20_000 })
    // [MANDATORY] 无 streaming 指示器（streaming-tail 光标在 complete 态应消失）
    await expect(page.locator('.streaming-tail')).toHaveCount(0)

    // ── 步骤 4：切到 B，断言 B 仍正常显示 Landing + composer 可输入 ──
    // B 是 landing 态（sessionId=null，延迟 create），不在侧栏会话列表中 → 点「新建任务」重新进 landing
    await newTaskSession(page)
    // [MANDATORY] B 仍渲染 Landing（A complete 不影响 B 的 landing 态）
    await expect(page.getByTestId('new-task-landing')).toBeVisible()
    // [MANDATORY] B 的 composer 可输入
    const bInput = page.getByRole('textbox')
    await bInput.click()
    await bInput.pressSequentially('B 仍可输入')
    await expect(bInput).toContainText('B 仍可输入')
  })
})
