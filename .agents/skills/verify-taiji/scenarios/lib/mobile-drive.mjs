/**
 * 移动壳剧本驱动助手（verify-taiji scenarios/lib；mobile-<name>.mjs V2/V4/V6/V7 系列共享）。
 *
 * 职责边界：只做「壳页打开 → 连接落位 → 会话行/聊天页导航 → 行级状态读取」的通用驱动，
 * 不含任何场景断言语义（分组/未读/表单/权限的判定都在各 scenario 内 ev.assert）。
 * 装配（remote-access 预置 / dist 探测 / token 交接原语）在 ./mobile-shell-helper.mjs，
 * 本模块消费它，不重复实现。
 *
 * 锚点事实（源码核对 2026-10-26）：connected 后 App 路由落 sessions（`screen-sessions`）；
 * 会话行 = `session-row-<sid>`（SessionRow.vue，未读点 = 行内 `session-row-unread`，
 * 分组容器 = 最近 `section[data-testid]` 祖先 `sessions-group-active | sessions-group-recent`）；
 * 聊天页根 = `chat-screen`，返回钮 = `chat-back`（goBackFromChat 单点回 chatFrom 域）。
 */
import { closeMobileShell, openMobileShell } from './mobile-shell-helper.mjs'

/** 条件轮询（禁盲等；判定条件每轮重算）。命中返回 true，超时返回 false。 */
export async function pollVisible(page, testid, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const visible = await page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 条件轮询任意谓词（返回谓词真值；超时返回 null）。 */
export async function pollFor(predicate, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 打开移动壳并等到「已连接 + 落会话列表」（token query 验身 → App 路由 sessions）。
 * 失败时把三态锚点命中情况返回给调用方记断言；不抛错（装配不完整是真实结果）。
 *
 * @returns {{ok:boolean, shell:object, anchor:string}} anchor = 终态锚点 testid
 */
export async function openConnectedShell(ctx, { timeoutMs = 30_000 } = {}) {
  const info = ctx.instance.info()
  const shell = await openMobileShell({ repo: ctx.repo, runtimePort: info.runtimePort, token: ctx.remoteAccess?.token })
  const anchors = ['screen-sessions', 'token-input-view', 'shell-failed-screen']
  const anchor = await pollFor(
    async () => {
      for (const id of anchors) {
        if (await isVisible(shell.page, id)) return id
      }
      return null
    },
    { timeoutMs, intervalMs: 250 },
  )
  return { ok: anchor === 'screen-sessions', shell, anchor: anchor ?? '(无锚点出现)' }
}

async function isVisible(page, testid) {
  return page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .isVisible()
    .catch(() => false)
}

/** 会话行 locator（SessionRow 根；sid 必须是真实会话 id）。 */
export function sessionRow(page, sid) {
  return page.locator(`[data-testid="session-row-${sid}"]`)
}

/** 行是否带未读点（行内 session-row-unread 后代；行不存在 = null 由调用方判）。 */
export async function rowHasUnread(page, sid) {
  const row = sessionRow(page, sid)
  if ((await row.count()) === 0) return null
  return row
    .locator('[data-testid="session-row-unread"]')
    .first()
    .isVisible()
    .catch(() => false)
}

/** 行所属分组 testid（最近 section[data-testid] 祖先：sessions-group-active / sessions-group-recent）。 */
export async function rowGroupId(page, sid) {
  return page
    .locator(`[data-testid="session-row-${sid}"]`)
    .evaluate((el) => el.closest('section[data-testid]')?.getAttribute('data-testid') ?? null)
    .catch(() => null)
}

/** 点行进入聊天（markSessionVisited 在组件内同步发生）并等聊天页根可见。 */
export async function openSessionByRow(page, sid, { timeoutMs = 20_000 } = {}) {
  await sessionRow(page, sid).click()
  return pollVisible(page, 'chat-screen', { timeoutMs })
}

/** 聊天页返回列表（popstate 单点）并等会话屏根可见。 */
export async function backToList(page, { timeoutMs = 15_000 } = {}) {
  await page.locator('[data-testid="chat-back"]').click()
  return pollVisible(page, 'screen-sessions', { timeoutMs })
}

/** 流容器滚动几何（贴底判定/滚动保位断言的读侧原语；元素缺失 = null）。 */
export async function streamScrollMetrics(page) {
  return page
    .locator('[data-testid="mobile-message-stream"]')
    .evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      bottomDistance: el.scrollHeight - el.scrollTop - el.clientHeight,
    }))
    .catch(() => null)
}

/** 收尾（转发 helper；调用方 finally 消费）。 */
export async function closeShell(shell) {
  await closeMobileShell(shell)
}
