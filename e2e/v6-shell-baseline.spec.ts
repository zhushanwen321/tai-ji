/**
 * v6 shell baseline 回归安全网 —— v6 视觉重构（F4）前的「行为基线」。
 *
 * 目的：重构后验证三栏布局 / 侧栏折叠+session 切换 / 对话流 turn 结构是否行为保持。
 * 深度=D3 使用者视角（DOM 存在+可见+交互可触发），非状态机（vitest 集成测范围）、非视觉（S2 像素 diff 范围）。
 *
 * 数据流：复用 e2e/fixtures/launch-app.ts mock 轨（_electron.launch + 5 env 注入），
 * VITE_MOCK=true 让 renderer 自洽渲染（mockApi + useConnection mock 200ms 进 connected → App.vue 守卫放行 AppShell）。
 * session list 含 e2eTestSession（id='e2e-files'，label='E2E 文件树测试'）与 s3（'API 性能优化'）。
 *
 * 范式参考：file-tree.spec.ts（gotoFileTree 激活 session）/ gui-components.spec.ts（activateSession + sendMessageAndWaitComplete）。
 *
 * 运行：npx playwright test e2e/v6-shell-baseline.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活指定 label 的 session（等目标 session 可见 → 点 → 等 composer 渲染）。
 *
 * sidebar.activeTab 默认 'sessions'，session list 通常已随 AppShell 挂载渲染，故先直接等目标 session
 * 文本可见（避开冷启动期「会话」tab 按钮偶发不可点的时序问题）；短时未现再点「会话」tab 兑底。
 */
async function activateSession(page: import('@playwright/test').Page, label: string): Promise<void> {
  const sessionItem = page.getByText(label)
  // 默认 activeTab=sessions → session list 已渲染，直接等目标 session 可见
  try {
    await expect(sessionItem).toBeVisible({ timeout: 6_000 })
  } catch {
    // 兑底：activeTab 被持久化为非 sessions 时，点「会话」tab 切回
    await page.getByRole('button', { name: /^会话/ }).click()
    await expect(sessionItem).toBeVisible({ timeout: 10_000 })
  }
  await sessionItem.click()
  // 激活后退出 Landing 态、main panel 载入 chat workspace → composer-box 渲染
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
}

/**
 * 发送消息并等待 mock 流式完成（run-send-stream 末尾推含「已处理」的 canned reply）。
 *
 * 不依赖 stop-btn 时序（stop-btn 在 mock 快流式下闪现极短，.catch 模式会引入竞态）：
 * 直接等 assistant 回复文本出现即为完成信号。复用 gui-components.spec.ts 的发送范式，
 * 但用更鲁棒的完成判定（.first() 排除 turn-rail 摘要同名文本，20s timeout 容纳并发负载下的慢流式）。
 */
async function sendMessageAndWaitComplete(page: import('@playwright/test').Page, text: string): Promise<void> {
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially(text)
  await input.press('Enter')
  // 等 assistant 回复可见（mock canned reply 固定含「已处理」）。
  // .first()：turn-rail 摘要（summarizeAssistantForRail 取 assistant 内容前 20 字）也含「已处理」，
  // 严格模式会匹配多元素；.first() 取 DOM 序首个（消息体 <p>，turns 在 rail 之前渲染）。
  // 20s timeout：mock 流式在并发测试负载下可能较慢。
  await expect(page.getByText(/已处理/).first()).toBeVisible({ timeout: 20_000 })
}

test.describe('AppShell 三栏布局', () => {
  test('TC-SHELL-LAYOUT: 三栏容器存在可见 + drawer 可打开 @p0-smoke', async ({ page }) => {
    // 持久结构容器（base 平铺 + aside 透明融合 + main float-panel 浮起，无需 session 即渲染）
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('app-shell-aside')).toBeVisible()
    await expect(page.getByTestId('app-shell-main')).toBeVisible()

    // drawer 区域：SideDrawer v-if isOpen 条件渲染，需先激活 session 让 PanelHeader 的 drawer-toggle 渲染
    await activateSession(page, 'E2E 文件树测试')
    await page.getByTestId('drawer-toggle').click()
    await expect(page.locator('aside[aria-label="侧边抽屉"]')).toBeVisible({ timeout: 5_000 })
  })
})

test.describe('sidebar 折叠/展开 + session 切换', () => {
  test('TC-SIDEBAR-COLLAPSE: 折叠/展开 round-trip 改变侧栏可见宽度', async ({ page }) => {
    // 激活 session 让 PanelHeader 渲染（折叠态 chrome 迁入 PanelHeader，与 AppNavControls 互斥渲染共用 testid）
    await activateSession(page, 'API 性能优化')

    const aside = page.getByTestId('app-shell-aside')
    // 初始展开（flex-basis 300px → width > 200）
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeGreaterThan(200)

    // 折叠（AppNavControls 浮层按钮）
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeLessThan(50)

    // 展开恢复（折叠态 PanelHeader chrome 按钮，与上面共用 testid，互斥渲染自动定位）
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeGreaterThan(200)
  })

  test('TC-SESSION-SWITCH: 点 session 后 main panel 载入对话区 @p0-smoke', async ({ page }) => {
    // sidebar.activeTab 默认 sessions，session list 已渲染。点 session 激活 → main 从 Landing 切到 chat → composer-box 渲染
    const sessionItem = page.getByText('E2E 文件树测试')
    await expect(sessionItem).toBeVisible({ timeout: 10_000 })
    await sessionItem.click()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('message-stream turn 结构', () => {
  test('TC-MSGSTREAM-TURN: mock 一轮对话后 turn-rail + user/assistant 消息渲染 @p0-smoke', async ({ page }) => {
    await activateSession(page, 'API 性能优化')
    await sendMessageAndWaitComplete(page, 'w2-baseline')

    // turn-rail 渲染（TurnRail.vue turns.length>0 时挂载 data-testid='turn-rail'）
    await expect(page.getByTestId('turn-rail')).toBeVisible({ timeout: 5_000 })

    // turn 容器存在（Turn.vue :data-testid=`turn-${turn.index}`，正则排除 turn-rail）
    const turn = page.getByTestId(/^turn-\d+$/).first()
    await expect(turn).toBeVisible({ timeout: 5_000 })

    // user 消息块存在：发送文本在 UserBubble 渲染。用 exact 匹配——mock 回复 `已处理:"${text}"`
    // 也含用户文本（子串），exact 排除 assistant 回复只命中 user 气泡。
    await expect(turn.getByText('w2-baseline', { exact: true })).toBeVisible({ timeout: 5_000 })

    // assistant 消息块存在：mock canned reply 含「已处理」（scope 到 turn 容器同理）
    await expect(turn.getByText(/已处理/)).toBeVisible({ timeout: 5_000 })
  })
})
