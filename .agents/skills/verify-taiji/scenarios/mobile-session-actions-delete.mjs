/**
 * mobile-session-actions-delete —— 长按管理与删除确认（remote-use-mobile-v2 §8.2 场景 V3，
 * D3 验收目标 A3）。
 *
 * 真实用户路径（V3）：移动壳会话列表长按会话行 480ms → SessionActionsSheet 动作列表 →
 * 删除 → 二次确认态（文案含不可逆声明与影响范围）→ 确认删除 → 留在列表（不留在空聊天）。
 *
 * 断言面（V3 通过标准 + A9/A10/F11 逐条对应）：
 *   ① 长按 480ms 打开动作 Sheet（SessionsScreen LONG_PRESS_MS=480 计时器路径）；
 *   ② 移动 >8px 取消长按（LONG_PRESS_CANCEL_MOVE_PX=8 阈值，Sheet 不打开）；
 *   ③ 确认态文案含不可逆声明与影响范围（「不可恢复」「全部对话记录与本地草稿」）；
 *   ④ 确认前不删除（取消回动作列表后行仍在，session.list 仍在册）；
 *   ⑤ 确认删除后回列表不留在空聊天（路由保持 sessions + 行离场）；
 *   ⑥ 级联取证：localStorage lastVisitedAt 条目摘除（读侧）+ runtime session.list 不再含该 sid。
 *
 * 被删会话由 faux 装配经移动壳 NewTaskSheet 真实用户路径创建（首条消息一轮回复收尾后再驱动）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createTaskViaSheet,
  flattenSessions,
  openConnectedShell,
} from './lib/mobile-task-flow.mjs'
import { closeMobileShell, MOBILE_TOKEN_STORAGE_KEY } from './lib/mobile-shell-helper.mjs'

const REPLY_SENTINEL = 'A3-DELETE-TARGET-REPLY-9f2q'

export const meta = {
  id: 'mobile-session-actions-delete',
  priority: 'P0',
  title: '移动壳长按会话行动作 Sheet + >8px 取消长按 + 删除二次确认（不可逆声明）+ 删除级联回列表',
  covers: ['env.launch', 'env.ready', 'session.create', 'session.delete', 'mobile.session.actions'],
  requires: ['remote-access', 'mobile-dist', 'faux'],
  estimateSec: 180,
  remoteAccess: {},
  faux: {
    responses: [{ text: `会话已创建，${REPLY_SENTINEL}。`, stopReason: 'stop' }],
  },
  provable: [
    'A：长按会话行 ≥480ms 打开 SessionActionsSheet 动作列表（session-actions-list 在 portal）',
    'A：长按中移动 >8px 取消长按，Sheet 不打开（8px 阈值判定）',
    'A：删除二次确认态文案含不可逆声明与影响范围（「不可恢复」+「全部对话记录与本地草稿」+ 目标会话名）',
    'A：确认前不删除（取消回动作列表，行仍在列表）',
    'A：确认删除后留在会话列表不留在空聊天（sessions 路由保持 + 行离场）',
    'C：级联——localStorage lastVisitedAt 条目摘除（读侧断言）',
    'B：runtime session.list 不再含被删 sid（服务端会话离场）',
  ],
  notProvable: [
    '真机长按触觉反馈/按压时长手感（仿真 viewport 下以 pointer 事件序列驱动同一手势逻辑）',
    'iOS Safari 原生长按系统手势冲突（callout/selection 抑制的真机形态）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess } = ctx
  const gotchas = []
  const uncovered = []
  const info = instance.info()
  const goodToken = remoteAccess?.token
  if (!goodToken) throw new Error('ctx.remoteAccess 缺失：run.mjs 未做 remote-access 预置（meta.remoteAccess 钩子失效？）')

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-a3-delete-'))
  let shell = null

  try {
    shell = await openConnectedShell({ repo: ctx.repo, runtimePort: info.runtimePort, token: goodToken })
    const page = shell.page
    ev.step({ step: 'mobile.shell.connected', channel: 'A', exitCode: 0, stats: { handover: shell.handover.ok } })
    ev.assert('A: token 交接完成（地址栏抹除 + storage 落盘）', shell.handover.ok, {
      channel: 'A', expected: 'ok', actual: JSON.stringify(shell.handover),
    })

    // ── 装配：NewTaskSheet 真实用户路径建被删会话 ────────────────────────────
    await createTaskViaSheet(page, { cwd, firstMessage: 'A3 待删除会话的首条消息' })
    ev.step({ step: 'session.create.via-sheet', channel: 'A', exitCode: 0, stats: { cwd } })

    // sid 取证：protocol session.list 按 cwd 匹配（移动壳不直接暴露 sid）
    const listReply = await ctx.protocol.call('session.list', {}, { replyType: 'session.list' })
    const created = flattenSessions(listReply).find((s) => s.cwd === cwd)
    ev.assert('B: NewTaskSheet 建会话在 runtime 在册（session.list 按 cwd 命中）', Boolean(created?.id), {
      channel: 'B', expected: '恰一新会话', actual: created ? `sid=${created.id} label=${created.label}` : '未命中',
    })
    if (!created?.id) throw new Error('session.list 未命中新建会话（cwd 不匹配），后续断言无从驱动')
    const sid = created.id

    // 首条消息回复收尾（faux 单轮，瞬时），避免删除时回合仍在途的时序噪声
    await page
      .locator('[data-testid="mobile-message-stream"]', { hasText: REPLY_SENTINEL })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    ev.step({ step: 'chat.first-reply', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 铺垫级联断言前置：点入会话（markSessionVisited → lastVisitedAt 落盘） ──
    await page.locator('[data-testid="chat-back"]').click()
    await page.locator('[data-testid="sessions-screen"]').waitFor({ state: 'visible', timeout: 15_000 })
    const lastVisitedKey = `taiji.mobile.lastVisited.${sid}`
    await page.locator(`[data-testid="session-row-${sid}"]`).click()
    await page.locator('[data-testid="chat-screen"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('[data-testid="chat-back"]').click()
    await page.locator('[data-testid="sessions-screen"]').waitFor({ state: 'visible', timeout: 15_000 })
    const storedVisited = await page.evaluate((k) => window.localStorage.getItem(k), lastVisitedKey)
    ev.assert('C: 点入会话后 lastVisitedAt 条目落盘（级联断言前置成立）', storedVisited !== null, {
      channel: 'C', expected: `localStorage['${lastVisitedKey}'] 非空`, actual: storedVisited === null ? 'null' : `ts=${storedVisited}`,
    })
    await ev.shot(page, 'a3-list-before-longpress')

    // ── 断言②：长按中移动 >8px 取消长按（Sheet 不打开） ─────────────────────
    {
      const row = page.locator(`[data-testid="session-row-${sid}"]`)
      const box = await row.boundingBox()
      if (!box) throw new Error('会话行 boundingBox 不可得（列表未渲染？）')
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + 24, cy, { steps: 4 }) // >8px 阈值 = 滚动/滑动意图
      await page.mouse.up()
      const sheetShown = await page
        .locator('[data-testid="session-actions-list"]')
        .isVisible()
        .catch(() => false)
      ev.assert('A: 长按中移动 >8px 取消长按（Sheet 不打开）', !sheetShown, {
        channel: 'A', expected: 'session-actions-list 不出现', actual: sheetShown ? 'Sheet 被打开（阈值失效）' : 'Sheet 未打开',
      })
      ev.step({ step: 'mobile.longpress.cancel-move', channel: 'A', exitCode: sheetShown ? 1 : 0, stats: { dx: 24 } })
    }

    // ── 断言①：长按 ≥480ms 打开动作 Sheet ─────────────────────────────────
    {
      const row = page.locator(`[data-testid="session-row-${sid}"]`)
      const box = await row.boundingBox()
      if (!box) throw new Error('会话行 boundingBox 不可得（列表未渲染？）')
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.waitForTimeout(700) // 手势本体：长按时长（480ms 计时器 + 余量），非 sleep-后-断言
      await page.mouse.up()
      await page.locator('[data-testid="session-actions-list"]').waitFor({ state: 'visible', timeout: 5_000 })
      const renameVisible = await page.locator('[data-testid="session-action-rename"]').isVisible()
      const deleteVisible = await page.locator('[data-testid="session-action-delete"]').isVisible()
      ev.assert('A: 长按会话行 ≥480ms 打开 SessionActionsSheet（动作列表含重命名/删除）', renameVisible && deleteVisible, {
        channel: 'A',
        expected: 'session-actions-list 可见 ∧ rename/delete 动作在场',
        actual: `rename=${renameVisible} delete=${deleteVisible}`,
      })
      await ev.shot(page, 'a3-actions-sheet')
      ev.step({ step: 'mobile.longpress.open-sheet', channel: 'A', exitCode: 0, stats: { holdMs: 700 } })
    }

    // ── 断言③：删除二次确认态文案（不可逆声明 + 影响范围） ──────────────────
    await page.locator('[data-testid="session-action-delete"]').click()
    await page.locator('[data-testid="session-delete-confirm"]').waitFor({ state: 'visible', timeout: 5_000 })
    const descText = (await page.locator('[data-testid="session-delete-confirm"]').innerText()).trim()
    const hasIrreversible = descText.includes('不可恢复')
    const hasScope = descText.includes('全部对话记录') && descText.includes('草稿')
    const targetText = await page.locator('[data-testid="session-delete-confirm-target"]').innerText()
    ev.assert('A: 确认态文案含不可逆声明与影响范围（不可恢复 + 全部对话记录 + 草稿）', hasIrreversible && hasScope, {
      channel: 'A',
      expected: '「不可恢复」∧「全部对话记录」∧「草稿」（deleteConfirmDescription）',
      actual: `irreversible=${hasIrreversible} scope=${hasScope} 文本="${descText.replace(/\s+/g, ' ').slice(0, 120)}"`,
    })
    ev.assert('A: 确认态目标行指认被删会话（label 在场）', targetText.includes(created.label), {
      channel: 'A', expected: `含「${created.label}」`, actual: `"${targetText.trim().slice(0, 80)}"`,
    })
    await ev.shot(page, 'a3-delete-confirm')

    // ── 断言④：确认前不删除（取消回动作列表，行仍在） ──────────────────────
    await page.locator('[data-testid="session-delete-cancel"]').click()
    await page.locator('[data-testid="session-actions-list"]').waitFor({ state: 'visible', timeout: 5_000 })
    const rowStillThere = await page.locator(`[data-testid="session-row-${sid}"]`).isVisible()
    ev.assert('A: 取消确认后会话行仍在列表（确认前不删除）', rowStillThere, {
      channel: 'A', expected: `session-row-${sid} 可见`, actual: `visible=${rowStillThere}`,
    })
    const listAfterCancel = flattenSessions(await ctx.protocol.call('session.list', {}, { replyType: 'session.list' }))
    ev.assert('B: 取消确认后 runtime 侧会话仍在册', listAfterCancel.some((s) => s.id === sid), {
      channel: 'B', expected: 'session.list 含 sid', actual: `count=${listAfterCancel.length} hit=${listAfterCancel.some((s) => s.id === sid)}`,
    })

    // ── 断言⑤：确认删除 → 回列表不留在空聊天 + 行离场 ──────────────────────
    await page.locator('[data-testid="session-action-delete"]').click()
    await page.locator('[data-testid="session-delete-confirm-button"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.locator('[data-testid="session-delete-confirm-button"]').click()
    // Sheet 关闭（级联收尾 closeSheet）+ 路由保持 sessions + 行离场
    await page.locator('[data-testid="session-delete-confirm"]').waitFor({ state: 'detached', timeout: 15_000 })
    const stillOnSessions = await page.locator('[data-testid="sessions-screen"]').isVisible()
    const chatScreenGone = !(await page.locator('[data-testid="chat-screen"]').isVisible().catch(() => false))
    ev.assert('A: 删除后留在会话列表（不留在空聊天）', stillOnSessions && chatScreenGone, {
      channel: 'A',
      expected: 'sessions-screen 可见 ∧ chat-screen 不在场',
      actual: `sessions=${stillOnSessions} chatGone=${chatScreenGone}`,
    })
    await page.locator(`[data-testid="session-row-${sid}"]`).waitFor({ state: 'detached', timeout: 15_000 })
    ev.assert('A: 被删会话行从列表离场', true, {
      channel: 'A', expected: `session-row-${sid} detached`, actual: 'detached',
    })
    await ev.shot(page, 'a3-list-after-delete')
    ev.step({ step: 'mobile.delete.confirmed', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 断言⑥：级联取证（localStorage 读侧 + runtime list） ─────────────────
    const storedAfterDelete = await page.evaluate((k) => window.localStorage.getItem(k), lastVisitedKey)
    ev.assert('C: 删除级联摘除 lastVisitedAt 条目（localStorage 读侧）', storedAfterDelete === null, {
      channel: 'C',
      expected: `localStorage['${lastVisitedKey}'] = null`,
      actual: storedAfterDelete === null ? '已摘除' : `残留 ts=${storedAfterDelete}`,
    })
    const listAfterDelete = flattenSessions(await ctx.protocol.call('session.list', {}, { replyType: 'session.list' }))
    ev.assert('B: runtime session.list 不再含被删 sid', !listAfterDelete.some((s) => s.id === sid), {
      channel: 'B', expected: 'session.list 无 sid', actual: `count=${listAfterDelete.length} hit=${listAfterDelete.some((s) => s.id === sid)}`,
    })
    ev.step({
      step: 'mobile.delete.cascade',
      channel: 'C',
      exitCode: storedAfterDelete === null && !listAfterDelete.some((s) => s.id === sid) ? 0 : 1,
      stats: { sid, lastVisitedRemoved: storedAfterDelete === null, runtimeRemoved: !listAfterDelete.some((s) => s.id === sid) },
    })

    // 页面现场留证（console/pageerror 是白屏归因第一现场）
    if (shell.pageErrors.length > 0) ev.attach('page-errors', shell.pageErrors.join('\n---\n'))
    const tokenAfter = await page.evaluate((k) => window.localStorage.getItem(k), MOBILE_TOKEN_STORAGE_KEY)
    log(`done sid=${sid} tokenKept=${tokenAfter === goodToken}`)
  } finally {
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
