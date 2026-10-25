/**
 * 移动壳验收共享用户路径（V3/V5/V8 系列剧本共用；建立在 mobile-shell-helper 装配原语
 * 之上，只做「已装配实例上的用户操作序列」复用，不含任何实例装配语义——装配归
 * mobile-shell-helper + run.mjs meta.remoteAccess/meta.faux 钩子）：
 * - openConnectedShell：打开壳 + 等 token 交接完成 + 等会话屏可达（connected 路由转移完成）；
 * - createTaskViaSheet：NewTaskSheet 真实用户路径建会话（手输兜底形态，§6.12 降级链）；
 * - sendViaComposer：移动 Composer 真实输入路径发送一条消息（contenteditable 逐字输入）。
 *
 * 驱动纪律（docs/testing + SKILL.md §3）：testid 优先；contenteditable 用 pressSequentially
 * （fill 不触发 input 逻辑）；Sheet 族 portal 到 body 全局查；条件等待禁固定 sleep。
 */
import { openMobileShell, waitForTokenHandover } from './mobile-shell-helper.mjs'

/**
 * 打开移动壳并等到「已连接、会话屏可达」。
 * @returns openMobileShell 句柄（browser/context/page/consoleLines/pageErrors/url）+ handover 结果
 */
export async function openConnectedShell({ repo, runtimePort, token, timeoutMs = 30_000 }) {
  const shell = await openMobileShell({ repo, runtimePort, token })
  const handover = await waitForTokenHandover(shell.page, token, { timeoutMs: 20_000 })
  await shell.page
    .locator('[data-testid="sessions-screen"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
  return { ...shell, handover }
}

/**
 * NewTaskSheet 建会话（手输兜底形态；chip 模式先点「手动输入」逃生口再手输）。
 * 成功判据 = chat-screen 可达（App.onTaskCreated → navigateRoute('chat')）。
 */
export async function createTaskViaSheet(page, { cwd, firstMessage, timeoutMs = 30_000 }) {
  await page.locator('[data-testid="sessions-new-task"]').click()
  await page.locator('[data-testid="new-task-sheet"]').waitFor({ state: 'visible', timeout: timeoutMs })
  const manualSwitch = page.locator('[data-testid="new-task-manual-switch"]')
  if (await manualSwitch.isVisible().catch(() => false)) {
    await manualSwitch.click()
  }
  await page.locator('[data-testid="new-task-cwd"]').fill(cwd)
  await page.locator('[data-testid="new-task-message"]').fill(firstMessage)
  await page.locator('[data-testid="new-task-submit"]').click()
  await page.locator('[data-testid="chat-screen"]').waitFor({ state: 'visible', timeout: timeoutMs })
}

/**
 * 移动 Composer 发送一条消息（真实触屏主路径：逐字输入 + 点发送钮）。
 * contenteditable 必须逐字输入（fill 不触发 input 逻辑——桌面域同款坑）。
 */
export async function sendViaComposer(page, text, { timeoutMs = 15_000 } = {}) {
  const box = page.locator('[data-testid="mobile-composer"] [role="textbox"]')
  await box.click({ timeout: timeoutMs })
  await box.pressSequentially(text, { timeout: timeoutMs })
  await page.locator('[data-testid="mobile-composer-send"]').click({ timeout: timeoutMs })
}

/**
 * 条件轮询页面试探一个定位器（返回可见事实，不抛错——由调用方记断言）。
 * 用于「transient paint 窗口可能短于轮询粒度」的队列条形态捕捉（p1-settling 同款口径）。
 */
export async function pollVisible(page, selector, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let seen = false
  while (Date.now() < deadline) {
    seen = await page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false)
    if (seen) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return seen
}

/**
 * protocol session.list 回复展平成 SessionSummary[]（groups[].sessions 单层展开）。
 */
export function flattenSessions(reply) {
  return (reply?.groups ?? []).flatMap((g) => g.sessions ?? [])
}
