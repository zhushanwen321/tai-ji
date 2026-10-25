/**
 * mobile-chat-stream-interrupt —— 流式跟流 / 上滑不抢滚动 / 回到最新 / 中断通知
 * （remote-use-mobile-v2 §8.2 场景 V4 的剧本化；A4 验收单元）。
 *
 * 真实用户路径（V4）：进入生成中会话（faux + TAIJI_FAUX_TPS 拉长流式窗口，协议侧先发后
 * 进 = 「中途接入」形态）→ 贴底自动跟流 → 上滑读历史不抢滚动 → 「回到最新」浮钮回底 →
 * 点「停止」→ 流内插「已中断本轮生成」（§6.20 动作通知）。
 *
 * 判定锚（源码核对 2026-10-26）：流容器 = `mobile-message-stream`（MobileMessageStream.vue，
 * 贴底阈值 NEAR_BOTTOM_THRESHOLD_PX=80，MutationObserver 贴底跟随 + nearBottom 单谓词互斥）；
 * 回到最新浮钮 = `mobile-back-to-latest`（size-11 = 44px 触控档，!nearBottom 才渲染）；
 * 停止钮 = `mobile-composer-stop`（无内容 ∧ 回合占用，D5 内容驱动双形态）；通知文案 =
 * mobile.notices.turnAborted =「已中断本轮生成」（zh-CN.ts:175）。
 */
import {
  closeShell,
  openConnectedShell,
  openSessionByRow,
  pollFor,
  pollVisible,
  sessionRow,
  streamScrollMetrics,
} from './lib/mobile-drive.mjs'

const STREAM_TEXT = 'A4 流式观察段：文本持续追加用于贴底跟流与滚动保位断言。'.repeat(240)

const RESPONSES = [
  { text: STREAM_TEXT, stopReason: 'stop' },
  { text: 'A4 收尾步（正常路径不消费——回合以中断收尾）。', stopReason: 'stop' },
]

export const meta = {
  id: 'mobile-chat-stream-interrupt',
  priority: 'P0',
  title: '生成中会话：贴底自动跟流 + 上滑不抢滚动 + 回到最新（≥44px）+ 停止插「已中断本轮生成」（§8.2 V4）',
  covers: ['mobile.chat.stream-follow', 'mobile.chat.back-to-latest', 'mobile.chat.interrupt', 'chat.abort'],
  requires: ['faux', 'remote-access', 'mobile-dist'],
  estimateSec: 240,
  remoteAccess: {},
  faux: { tps: 12, responses: RESPONSES },
  provable: [
    'A：中途接入生成中会话后贴底自动跟流——流式增量持续（scrollHeight 增长）期间底距恒 < 80px（nearBottom 跟随）',
    'A：上滑读历史不抢滚动——scrollTop 上移后 2.5s 流式窗口内保持原位（±2px），期间 scrollHeight 继续增长（流未断）',
    'A：「回到最新」浮钮在上滑态浮出，触控目标 ≥44×44px（size-11 档）',
    'A：点击「回到最新」回到底部（底距 < 80px）且浮钮收起（nearBottom 单谓词复位）',
    'A：点「停止」后流内插入「已中断本轮生成」system 通知行（§6.20 动作通知）',
    'B：中断后回合收尾（message.complete 到达，faux 流被 abort 终止）',
  ],
  notProvable: [
    '真机触屏惯性感与 safe-area 视觉——本剧本只证仿真 viewport 下的滚动状态机与浮钮几何',
    '压缩中（compacting）形态的停止钮 title 分档——V4 判定面只有回合中止',
  ],
}

/** 底距阈值（与被测组件 NEAR_BOTTOM_THRESHOLD_PX 同值：距底小于它 = 用户在底部）。 */
const NEAR_BOTTOM_THRESHOLD_PX = 80

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const uncovered = []
  const gotchas = [
    '移动壳中途接入时回合计时口径是「已观察」（本端观察时刻起算）——页头计时值不用于断言（§6.21 声明性口径）',
    '贴底断言阈值取组件 NEAR_BOTTOM_THRESHOLD_PX=80 同值；delta 渲染与 observer 滚动间存在毫秒级窗口，用条件轮询不用单点采样',
  ]

  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'A4-流式中断会话' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)
  const since = protocol.events.length
  await protocol.send(sid, '开始一段很长的输出')
  ev.step({ step: 'drive.stream.start', channel: 'B', exitCode: 0, stats: { sid } })

  const opened = await openConnectedShell(ctx)
  const shell = opened.shell
  try {
    ev.assert('A: 移动壳已连接并落会话列表', opened.ok, {
      channel: 'A', expected: 'screen-sessions 可见', actual: `锚点=${opened.anchor}`,
    })
    if (!opened.ok) {
      uncovered.push('后续断言未驱动：壳未落到会话列表')
      return { uncovered, gotchas }
    }

    // 中途接入：行出现即点入（生成中会话行 = 进行中组）
    const rowReady = await pollFor(async () => (await sessionRow(shell.page, sid).count()) > 0, { timeoutMs: 30_000 })
    ev.assert('A: 生成中会话行在列表出现', rowReady === true, {
      channel: 'A', expected: `session-row-${sid}`, actual: rowReady ? '在' : '30s 未现',
    })
    if (!rowReady) {
      uncovered.push('后续断言未驱动：会话行未出现')
      return { uncovered, gotchas }
    }
    const entered = await openSessionByRow(shell.page, sid)
    ev.assert('A: 点入生成中会话落聊天页', entered === true, {
      channel: 'A', expected: 'chat-screen 可见', actual: entered ? '在' : '20s 未现',
    })
    await ev.shot(shell.page, 'a4-entered-streaming')

    // 流式在途证据：停止钮出现（无内容 ∧ 回合占用）+ 流高度增长
    const stopVisible = await pollVisible(shell.page, 'mobile-composer-stop', { timeoutMs: 20_000 })
    ev.assert('A: 生成中呈现停止钮（D5 内容驱动双形态）', stopVisible, {
      channel: 'A', expected: 'mobile-composer-stop 可见', actual: stopVisible ? '可见' : '20s 未现',
    })
    if (!stopVisible) {
      uncovered.push('流式断言未驱动：停止钮未出现（回合可能未进入生成态）')
      return { uncovered, gotchas }
    }

    // ── 断言①：贴底自动跟流（3 次采样，期间 scrollHeight 必须增长 = 流式在途）──
    const followSamples = []
    let grew = false
    for (let i = 0; i < 3; i++) {
      const m = await pollFor(async () => await streamScrollMetrics(shell.page), { timeoutMs: 10_000, intervalMs: 200 })
      followSamples.push(m)
      if (i > 0 && m && followSamples[i - 1] && m.scrollHeight > followSamples[i - 1].scrollHeight) grew = true
      await new Promise((r) => setTimeout(r, 1_500))
    }
    const allNearBottom = followSamples.length === 3 && followSamples.every((m) => m && m.bottomDistance < NEAR_BOTTOM_THRESHOLD_PX)
    ev.assert('A: 贴底自动跟流——流式期间底距恒 < 80px', allNearBottom, {
      channel: 'A',
      expected: `3 次采样 bottomDistance < ${NEAR_BOTTOM_THRESHOLD_PX}`,
      actual: followSamples.map((m) => (m ? Math.round(m.bottomDistance) : 'null')).join(' → '),
    })
    ev.assert('A: 跟流采样期间流高度增长（流式确实在途，非静态贴底）', grew, {
      channel: 'A', expected: 'scrollHeight 单调增长', actual: grew ? '已增长' : '3 次采样高度未变（流可能已停）',
    })
    await ev.shot(shell.page, 'a4-following-bottom')

    // ── 断言②：上滑读历史不抢滚动 ──
    const before = await streamScrollMetrics(shell.page)
    await shell.page
      .locator('[data-testid="mobile-message-stream"]')
      .evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollTop - 600)
      })
    await new Promise((r) => setTimeout(r, 300)) // nearBottom 翻 false + 浮钮渲染
    const scrolled = await streamScrollMetrics(shell.page)
    const backBtnBox = await shell.page
      .locator('[data-testid="mobile-back-to-latest"]')
      .boundingBox()
      .catch(() => null)
    await new Promise((r) => setTimeout(r, 2_500)) // 流式窗口：观察滚动是否被新内容抢走
    const after = await streamScrollMetrics(shell.page)
    const stayed =
      before && scrolled && after &&
      scrolled.scrollTop < before.scrollTop &&
      Math.abs(after.scrollTop - scrolled.scrollTop) <= 2
    const keptGrowing = Boolean(before && after && after.scrollHeight > before.scrollHeight)
    ev.assert('A: 上滑读历史不抢滚动——流式增量期间 scrollTop 保持原位（±2px）', stayed && keptGrowing, {
      channel: 'A',
      expected: `scrollTop 稳定且 scrollHeight 增长（上滑后=${scrolled?.scrollTop ?? 'null'}，2.5s 后=${after?.scrollTop ?? 'null'}）`,
      actual: stayed
        ? keptGrowing
          ? '滚动未被抢且流式持续'
          : `滚动未抢但流高未增长（scrollHeight ${before?.scrollHeight} → ${after?.scrollHeight}）`
        : `scrollTop 漂移：${scrolled?.scrollTop} → ${after?.scrollTop}`,
    })
    ev.assert('A: 上滑态「回到最新」浮钮浮出', Boolean(backBtnBox), {
      channel: 'A', expected: 'mobile-back-to-latest 可见', actual: backBtnBox ? '浮出' : '未浮出',
    })
    ev.assert('A: 「回到最新」触控目标 ≥44×44px（§6.9 icon-44 档）', Boolean(backBtnBox && backBtnBox.width >= 44 && backBtnBox.height >= 44), {
      channel: 'A', expected: 'width≥44 ∧ height≥44', actual: backBtnBox ? `${Math.round(backBtnBox.width)}×${Math.round(backBtnBox.height)}` : '元素不存在',
    })
    await ev.shot(shell.page, 'a4-scrolled-up')

    // ── 断言③：点击回到最新 → 回底 + 浮钮收起 ──
    await shell.page.locator('[data-testid="mobile-back-to-latest"]').click()
    const backAtBottom = await pollFor(async () => {
      const m = await streamScrollMetrics(shell.page)
      return m !== null && m.bottomDistance < NEAR_BOTTOM_THRESHOLD_PX
    }, { timeoutMs: 10_000 })
    const btnGone = await pollFor(async () => !(await isVisible(shell.page, 'mobile-back-to-latest')), { timeoutMs: 8_000 })
    ev.assert('A: 点击「回到最新」回到底部（底距 < 80px）', backAtBottom === true, {
      channel: 'A', expected: `bottomDistance < ${NEAR_BOTTOM_THRESHOLD_PX}`, actual: backAtBottom ? '已回底' : '10s 未回底',
    })
    ev.assert('A: 回底后浮钮收起（nearBottom 复位）', btnGone === true, {
      channel: 'A', expected: 'mobile-back-to-latest 移除', actual: btnGone ? '已收起' : '仍在',
    })
    await ev.shot(shell.page, 'a4-back-to-latest')

    // ── 断言④：停止 → 流内插「已中断本轮生成」+ B 通道回合收尾 ──
    await shell.page.locator('[data-testid="mobile-composer-stop"]').click()
    const noticeShown = await pollFor(async () => {
      const text = await shell.page
        .locator('[data-testid="mobile-message-stream"]')
        .innerText()
        .catch(() => '')
      return text.includes('已中断本轮生成')
    }, { timeoutMs: 30_000 })
    ev.assert('A: 中断后流内插入「已中断本轮生成」system 通知', noticeShown === true, {
      channel: 'A', expected: '流内含「已中断本轮生成」（mobile.notices.turnAborted）', actual: noticeShown ? '已插入' : '30s 未现',
    })
    await ev.shot(shell.page, 'a4-interrupted')

    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 60_000 })
    ev.assert('B: 中断后回合收尾（faux 流被 abort 终止）', end.type === 'message.complete' || end.type === 'message.error', {
      channel: 'B', expected: 'message.complete/error（stopReason=aborted 族）', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
    })
  } finally {
    if (shell.pageErrors.length > 0) ev.attach('a4-page-errors', shell.pageErrors.join('\n---\n'))
    await closeShell(shell)
    ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
  }

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}

async function isVisible(page, testid) {
  return page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .isVisible()
    .catch(() => false)
}
