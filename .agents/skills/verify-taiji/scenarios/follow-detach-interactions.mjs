/**
 * follow-detach-interactions —— 脱离 / 胶囊 / 回贴 / 翻页 / 发送即回底交互等价
 * （stream-follow-reshape 验收项 A4 + A6 + A7 + A9）。
 *
 * 设计依据：stream-follow-reshape.md §4 场景 S3（脱离、胶囊与回贴）、S5（历史前插不跳动）、
 * S6（负面验证：数据通路不越权）、S8（发送即回底）；行为载体 = useVirtuaFollow
 * （onWheel 脱离 / onScroll distance≤40 恢复分支 / showJumpButton 距底超一屏浮现 /
 * submitSeq force 回底）。
 *
 * 前置与分档：
 * - A6 的分页控件（truncated-history-bar）出现前提 = 历史窗口截断（runtime 双预算窗口
 *   RECENT_TURNS=20 轮，truncated-window.ts / HISTORY_BUDGET）**且** renderer 已写入窗口
 *   状态（hydrate/reconcile 路径——活会话需切走再切回一次触发 refreshHistory）。剧本先发
 *   21 条短消息建历史（>20 轮），再经「切到空会话 B → 切回 A」刷新窗口。若分页控件仍
 *   不可达 → 该步记 uncovered（degraded）并在 summary 写明前置缺失，禁硬凑通过。
 * - A9 的发送走 composer 真实用户路径（contenteditable pressSequentially 逐字输入 + Enter）。
 *
 * 断言形态：只含确定性断言（几何 / testid / 协议）；「平滑动画的观感」「无跳动」等视觉
 * 形态归 L4 inspect，不在此断言。滚动几何统一用
 * distance = scrollHeight - scrollTop - clientHeight 对比 useVirtuaFollow BOTTOM_THRESHOLD(40)。
 *
 * 装配：faux + TAIJI_FAUX_TPS=20。响应脚本 23 步：21 短（历史铺垫）→ 1 长（≈6000 字符
 * ≈1500 token，流式窗口 ≈75s，承载 A4/A7 交互）→ 1 短（A9 发送轮收尾）。
 */

const BOTTOM_THRESHOLD = 40
const LABEL_A = '跟随交互-A-主会话'
const LABEL_B = '跟随交互-B-中转'

/** 长流式文本 ≈6000 字符 ≈1500 token @ TPS=20 ≈ 75s 窗口。 */
function buildLongText() {
  const para = '脱离交互验收段落：流式窗口期内执行脱离、胶囊、回贴与静止观察，文本持续追加维持增长。'
  let text = ''
  while (text.length < 6000) text += para
  return text
}

function buildFauxResponses() {
  const history = []
  for (let i = 1; i <= 21; i++) history.push({ text: `收到，历史铺垫第 ${i} 轮。`, stopReason: 'stop' })
  return [...history, { text: buildLongText(), stopReason: 'stop' }, { text: '好的，已按你的选择继续。', stopReason: 'stop' }]
}

/** 页内读取滚动几何。真实函数形态传入 evaluate——本仓 Playwright 版本对「字符串函数
 * 表达式」不自动调用（实测返回 undefined），以下三个页内度量同理。 */
const readMetrics = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.message-stream')
    if (!el) return null
    return { st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, d: el.scrollHeight - el.scrollTop - el.clientHeight }
  })

/** 页内读取「视口内最顶部可见 turn」的文本指纹与内容系坐标（contentY 与 scrollTop 无关）。 */
const readTopTurn = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.message-stream')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    for (const t of document.querySelectorAll('[data-testid^="turn-"]')) {
      const r = t.getBoundingClientRect()
      if (r.bottom > rect.top + 8 && r.top < rect.bottom) {
        return { text: (t.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60), contentY: r.top - rect.top + el.scrollTop }
      }
    }
    return null
  })

/** 按 contentY 复查某文本指纹 turn 的位置（翻页补偿断言用）。 */
const findTurnByNeedle = (page, needle) =>
  page.evaluate((n) => {
    const el = document.querySelector('.message-stream')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    for (const t of document.querySelectorAll('[data-testid^="turn-"]')) {
      const norm = (t.textContent ?? '').replace(/\s+/g, ' ')
      if (norm.includes(n)) {
        const r = t.getBoundingClientRect()
        return { contentY: r.top - rect.top + el.scrollTop, visible: r.bottom > rect.top && r.top < rect.bottom }
      }
    }
    return null
  }, needle)

export const meta = {
  id: 'follow-detach-interactions',
  priority: 'P0',
  title: '脱离/胶囊/回贴（A4）+ 翻页不跳（A6）+ 静止不被扯回（A7）+ 发送即回底（A9）',
  covers: ['chat.send', 'chat.stream', 'chat.wait', 'session.create'],
  requires: ['faux'],
  estimateSec: 300,
  faux: {
    responses: buildFauxResponses(),
    tps: 20,
  },
  provable: [
    'A4 前半：流式中滚轮上滑脱离（内容增长视口不跟随）→ 距底超一屏「回到最新」胶囊浮现 → 点胶囊回底并恢复跟随',
    'A4 后半：再次脱离 → 滚轮滚回距底 ≤40px → onScroll 恢复分支自动恢复贴底、胶囊消失',
    'A6：脱离态点「加载更早」翻页，已视内容 contentY 位移 ≤40px（virtua :shift 保位）',
    'A7：再次流式中脱离后静止 ≥3 秒，视口不被扯回底部（distance 全程 >40 且 scrollTop 不向底推进）',
    'A9：脱离态 composer 逐字输入发送 → 视口回底（distance ≤40）、刚发送消息可见、胶囊消失',
  ],
  notProvable: [
    '胶囊点击的「平滑」动画观感（smooth 参数存在性归单测；视觉观感归 L4 inspect）',
    'A6 分页控件不可达时（前置缺失）如实降级——「加载更早」可达性依赖 runtime 截断窗口 + hydrate 刷新两个前置',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance, repo } = ctx
  const uncovered = []
  const gotchas = [
    'A6 前置双条件：历史 >20 轮（HISTORY_BUDGET.RECENT_TURNS）+ renderer 窗口状态经 hydrate 刷新（活会话必须切走再切回，reconcileHistory 才写 historyWindows）',
    '「回到最新」胶囊无 testid：断言锚点 = button[title="回到最新"]（panel.message.scrollToBottom，zh-CN 默认 locale）',
    '触顶自动续载阈值 64px 且要求已脱离——点「加载更早」时 Playwright scrollIntoView 到顶可能抢先触发同一 handleLoadMore（防重入 guard 单一），按 triggeredBy 如实记录',
    '滚轮注入前必须 hover 对话流中心（page.mouse.wheel 派发到当前鼠标位置下的可滚动容器）',
  ]

  const ui = ctx.ui
  const page = await instance.page()
  const metrics = () => readMetrics(page)
  /** 滚轮注入前把鼠标移回对话流中心（点击胶囊/输入后鼠标位置会漂移）。 */
  const hoverStream = async () => {
    await page.locator('.message-stream').first().hover()
  }

  {
    // ── 建主会话 A + UI 激活链 ────────────────────────────────────────────
    const created = await protocol.call('session.create', { cwd: repo, label: LABEL_A }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 历史铺垫：21 轮短消息（A6 截断窗口前置：>20 轮）────────────────────
    for (let i = 1; i <= 21; i++) {
      const s = protocol.events.length
      await protocol.send(sid, `历史铺垫第 ${i} 轮`)
      const end = await protocol.waitTurnEnd(sid, { since: s, timeoutMs: 60_000 })
      if (!end.ok) throw new Error(`历史铺垫第 ${i} 轮未正常收尾：${end.type} ${end.payload?.stopReason ?? ''}`)
    }
    ev.step({ step: 'history.seed', channel: 'B', exitCode: 0, stats: { rounds: 21 } })

    // ── 长流式回合（承载 A4 / A7）─────────────────────────────────────────
    const since = protocol.events.length
    await protocol.send(sid, '请开始长输出')
    await ui.expectVisible('css=.stop-btn', { timeoutMs: 30_000 })
    ev.step({ step: 'chat.send', channel: 'B', exitCode: 0, stats: { sid, streaming: true } })

    // ══ A4 前半：滚轮脱离 → 胶囊浮现 → 点胶囊回底恢复跟随 ══
    await hoverStream()
    await page.mouse.wheel(0, -600)
    const det0 = await metrics()
    await new Promise((r) => setTimeout(r, 1200))
    const det1 = await metrics()
    ev.assert('A4 前半: 脱离后视口不跟随（内容增长而 scrollTop 不动）', Boolean(det0 && det1 && det1.sh - det0.sh >= 80 && Math.abs(det1.st - det0.st) <= 5 && det1.d > BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: 'scrollHeight 增长 ≥80px 且 |ΔscrollTop| ≤5px 且 distance >40',
      actual: det0 && det1 ? `Δsh=${det1.sh - det0.sh} Δst=${(det1.st - det0.st).toFixed(1)} d=${det1.d.toFixed(0)}` : 'metrics null',
    })
    ev.step({ step: 'a4.detach', channel: 'A', exitCode: 0, stats: { det0, det1 } })

    await ui.expectVisible('css=button[title="回到最新"]', { timeoutMs: 30_000 })
    ev.assert('A4 前半: 距底超一屏后「回到最新」胶囊浮现', true, {
      channel: 'A',
      expected: 'showJumpButton（距底 > 视口高）→ 胶囊可见',
      actual: 'button[title="回到最新"] 可见',
    })
    ev.step({ step: 'a4.pill.visible', channel: 'A', exitCode: 0, stats: {} })

    await ui.click('css=button[title="回到最新"]', { timeoutMs: 10_000 })
    // 回底 + 恢复跟随：轮询 distance ≤40，随后 2s 内持续贴底（流式仍在增长）
    let backBottom = null
    for (let i = 0; i < 20; i++) {
      backBottom = await metrics()
      if (backBottom && backBottom.d <= BOTTOM_THRESHOLD) break
      await new Promise((r) => setTimeout(r, 250))
    }
    ev.assert('A4 前半: 点胶囊后回底（distance ≤40）', Boolean(backBottom && backBottom.d <= BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: 'distance ≤ 40',
      actual: backBottom ? `d=${backBottom.d.toFixed(1)}` : 'metrics null',
    })
    let followRestored = true
    for (let i = 0; i < 8; i++) {
      const m = await metrics()
      if (!m || m.d > BOTTOM_THRESHOLD) followRestored = false
      await new Promise((r) => setTimeout(r, 250))
    }
    ev.assert('A4 前半: 回底后恢复跟随（2s 内流式内容持续贴底）', followRestored, {
      channel: 'A',
      expected: '恢复后 distance 持续 ≤40（流式增长期）',
      actual: followRestored ? '8 次采样全部 ≤40' : '出现越阈采样',
    })
    await ui.expectGone('css=button[title="回到最新"]', { timeoutMs: 5_000 })
    ev.step({ step: 'a4.pill.click', channel: 'A', exitCode: followRestored ? 0 : 1, stats: { backBottom, followRestored } })

    // ══ A4 后半：再脱离 → 手动滚回 ≤40px → 自动恢复贴底 ══
    await hoverStream()
    await page.mouse.wheel(0, -500)
    await new Promise((r) => setTimeout(r, 1000))
    const det2 = await metrics()
    ev.assert('A4 后半: 再次脱离成立（distance >40）', Boolean(det2 && det2.d > BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: 'distance > 40',
      actual: det2 ? `d=${det2.d.toFixed(1)}` : 'metrics null',
    })
    let manualBack = null
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 700)
      await new Promise((r) => setTimeout(r, 150))
      manualBack = await metrics()
      if (manualBack && manualBack.d <= BOTTOM_THRESHOLD) break
    }
    ev.assert('A4 后半: 手动滚回距底 ≤40px', Boolean(manualBack && manualBack.d <= BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: '滚轮下行至 distance ≤ 40（onScroll 恢复分支触发窗）',
      actual: manualBack ? `d=${manualBack.d.toFixed(1)}` : 'metrics null',
    })
    let autoRestored = true
    for (let i = 0; i < 6; i++) {
      const m = await metrics()
      if (!m || m.d > BOTTOM_THRESHOLD) autoRestored = false
      await new Promise((r) => setTimeout(r, 250))
    }
    await ui.expectGone('css=button[title="回到最新"]', { timeoutMs: 4_000 })
    ev.assert('A4 后半: 自动恢复贴底（恢复分支）且胶囊消失（距底 < 一屏）', autoRestored, {
      channel: 'A',
      expected: 'onScroll distance ≤40 → stickToBottom 翻 true，后续流式持续贴底；胶囊消失',
      actual: autoRestored ? '1.5s 采样全部 ≤40 且胶囊已消失' : '恢复后出现越阈采样',
    })
    ev.step({ step: 'a4.manual.back', channel: 'A', exitCode: autoRestored ? 0 : 1, stats: { manualBack, autoRestored } })

    // ══ A7：再次脱离后静止 ≥3 秒不被扯回（S6 负面验证）══
    await hoverStream()
    await page.mouse.wheel(0, -800)
    await new Promise((r) => setTimeout(r, 800))
    const staticSeries = []
    for (let i = 0; i < 14; i++) {
      staticSeries.push(await metrics())
      await new Promise((r) => setTimeout(r, 250))
    }
    const staticValid = staticSeries.filter(Boolean)
    const allDetached = staticValid.length > 0 && staticValid.every((m) => m.d > BOTTOM_THRESHOLD)
    let noYank = true
    for (let i = 1; i < staticValid.length; i++) {
      if (staticValid[i].st > staticValid[i - 1].st + 10) noYank = false // 向底方向的突进 = 被扯回
    }
    ev.assert('A7: 脱离态静止 ≥3 秒视口不被扯回底部', allDetached && noYank, {
      channel: 'A',
      expected: `14 次采样（3.5s）distance 全程 >40 且 scrollTop 无向底突进（>10px）`,
      actual: `detached=${staticValid.filter((m) => m.d > BOTTOM_THRESHOLD).length}/${staticValid.length}，yank=${!noYank}（st 序列首尾 ${staticValid[0]?.st.toFixed(0)}→${staticValid[staticValid.length - 1]?.st.toFixed(0)}）`,
    })
    ev.step({ step: 'a7.static.guard', channel: 'A', exitCode: allDetached && noYank ? 0 : 1, stats: { allDetached, noYank } })

    // 长回合收尾（A4/A7 的宿主回合）
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
    ev.assert('B: 长流式回合正常收尾', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })

    // ══ A6：脱离态点「加载更早」，已视内容不跳（S5）══
    // 前置 1：切到空会话 B 再切回 A —— 活会话窗口状态只在 hydrate/reconcile 路径写入
    let barReachable = false
    try {
      await protocol.call('session.create', { cwd: repo, label: LABEL_B }, { timeoutMs: 120_000 })
      const rowB = page.locator('.session-item').filter({ hasText: LABEL_B }).first()
      await rowB.waitFor({ state: 'visible', timeout: 15_000 })
      await rowB.click()
      const rowA = page.locator('.session-item').filter({ hasText: LABEL_A }).first()
      await rowA.waitFor({ state: 'visible', timeout: 15_000 })
      await rowA.click()
      // 切回 A：refreshHistory → reconcileHistory 写窗口状态；>20 轮 → 截断条出现
      await ui.expectVisible('testid=truncated-history-bar', { timeoutMs: 15_000 })
      barReachable = true
      ev.assert('A6: 截断窗口前置成立（>20 轮 + 切回刷新后截断条可见）', true, {
        channel: 'A',
        expected: 'truncated-history-bar 可见（truncated=true）',
        actual: '可见',
      })
    } catch (e) {
      uncovered.push(`A6 前置缺失：分页控件不可达（建中转会话/切回刷新/截断条出现任一失败：${String(e?.message ?? e).slice(0, 160)}）——该步降级，不硬凑通过`)
      ev.step({ step: 'a6.precondition', channel: 'A', exitCode: 1, stats: { error: String(e?.message ?? e).slice(0, 160) } })
    }
    ev.step({ step: 'a6.precondition', channel: 'A', exitCode: barReachable ? 0 : 1, stats: { barReachable } })

    if (barReachable) {
      // 脱离 + 上滑两屏，取视口顶可见 turn 做锚（contentY 与滚动位置无关）
      await hoverStream()
      await page.mouse.wheel(0, -600)
      await page.mouse.wheel(0, -600)
      await new Promise((r) => setTimeout(r, 400))
      const anchor = await readTopTurn(page)
      const before = await metrics()
      ev.assert('A6: 翻页锚点成立（脱离态视口顶有可见 turn）', Boolean(anchor && before && before.d > BOTTOM_THRESHOLD), {
        channel: 'A',
        expected: '脱离态且视口顶存在可见 turn',
        actual: anchor ? `text=${anchor.text.slice(0, 24)} contentY=${anchor.contentY.toFixed(0)} d=${before?.d.toFixed(0)}` : '未找到可见 turn',
      })
      let triggeredBy = 'click'
      try {
        await ui.click('testid=load-more-history', { timeoutMs: 6_000 })
      } catch {
        // 触顶自动续载可能抢先触发（scrollIntoView 到顶 + 已脱离）：同一 handleLoadMore 通路
        triggeredBy = 'auto-at-top（scrollIntoView 触顶 + 已脱离，防重入 guard 单一）'
        log('load-more 点击被自动续载抢先（按钮已 loading/detached），按同一通路继续')
      }
      // 等翻页完成：截断条收敛消失（22 轮 < 2 页 → 翻完后 truncated=false）且 scrollHeight 增长
      const after = await (async () => {
        try {
          await page.locator('[data-testid="truncated-history-bar"]').first().waitFor({ state: 'detached', timeout: 15_000 })
        } catch { /* 条仍在：靠 sh 增量判定 */ }
        await new Promise((r) => setTimeout(r, 600))
        return metrics()
      })()
      const shGrew = Boolean(before && after && after.sh - before.sh >= 100)
      ev.assert('A6: 翻页真实发生（前置内容插入，scrollHeight 增长 ≥100px）', shGrew, {
        channel: 'A',
        expected: 'ΔscrollHeight ≥ 100px（更早 turn 前插）',
        actual: before && after ? `Δsh=${after.sh - before.sh} triggeredBy=${triggeredBy}` : 'metrics null',
      })
      const anchorAfter = anchor ? await findTurnByNeedle(page, anchor.text) : null
      const delta = anchor && anchorAfter ? Math.abs(anchorAfter.contentY - anchor.contentY) : null
      ev.assert('A6: 已视内容不跳（锚 turn contentY 位移 ≤40px，virtua :shift 保位）', delta !== null && delta <= 40, {
        channel: 'A',
        expected: '|ΔcontentY| ≤ 40px',
        actual: delta === null ? '锚 turn 翻页后未找到' : `Δ=${delta.toFixed(1)}px（${anchor.contentY.toFixed(0)} → ${anchorAfter.contentY.toFixed(0)}）`,
      })
      ev.step({ step: 'a6.loadmore', channel: 'A', exitCode: shGrew && delta !== null && delta <= 40 ? 0 : 1, stats: { triggeredBy, shGrew, anchorDelta: delta } })
    }

    // ══ A9：脱离态 composer 逐字输入发送 → 即回底（S8）══
    // 发送前状态核对：仍脱离且距底超一屏（胶囊在场才有「消失」可断言）
    await hoverStream()
    const preSend = await metrics()
    const pillBeforeSend = await page.locator('css=button[title="回到最新"]').count().catch(() => 0)
    ev.assert('A9 前置: 发送前处于脱离态（distance > 40）', Boolean(preSend && preSend.d > BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: '脱离态发送才构成「发送即回底」的判距',
      actual: preSend ? `d=${preSend.d.toFixed(0)} pillBeforeSend=${pillBeforeSend}` : 'metrics null',
    })
    const sendText = `发送即回底验收-${Date.now().toString(36)}`
    await ui.type('role=textbox', sendText, { timeoutMs: 10_000 })
    await ui.press('Enter')
    ev.step({ step: 'a9.send', channel: 'A', exitCode: 0, stats: { sendText, pillBeforeSend, preSendD: preSend?.d ?? null } })

    let sendBack = null
    for (let i = 0; i < 12; i++) {
      sendBack = await metrics()
      if (sendBack && sendBack.d <= BOTTOM_THRESHOLD) break
      await new Promise((r) => setTimeout(r, 250))
    }
    ev.assert('A9: 发送后视口立即回底（distance ≤40）', Boolean(sendBack && sendBack.d <= BOTTOM_THRESHOLD), {
      channel: 'A',
      expected: 'submitSeq 递增 → followToBottomForce → distance ≤ 40（3s 内）',
      actual: sendBack ? `d=${sendBack.d.toFixed(1)}` : 'metrics null',
    })
    // 刚发送的消息可见（A 通道：user 气泡文本入流；虚拟列表用全量 HTML 查询）
    let sentVisible = false
    {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const html = await ui.html('css=body')
        if (html.includes(sendText)) {
          sentVisible = true
          break
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    ev.assert('A9: 刚发送的消息在对话流可见', sentVisible, {
      channel: 'A',
      expected: 'user 气泡含发送原文',
      actual: sentVisible ? 'body HTML 命中发送原文' : '10s 未命中',
    })
    await ui.expectGone('css=button[title="回到最新"]', { timeoutMs: 5_000 })
    ev.assert('A9: 脱离态残留清零（胶囊消失）', true, {
      channel: 'A',
      expected: 'force 回底清零距底快照 → 胶囊消失',
      actual: '胶囊不可见',
    })
    ev.step({ step: 'a9.assert', channel: 'A', exitCode: sendBack && sendBack.d <= BOTTOM_THRESHOLD && sentVisible ? 0 : 1, stats: { sendBack, sentVisible } })

    // A9 轮收尾（faux 末步短响应），清态后交付 runner dispose
    const sinceA9 = protocol.events.length
    const endA9 = await protocol.waitTurnEnd(sid, { since: sinceA9, timeoutMs: 60_000 })
    ev.step({ step: 'a9.turn.end', channel: 'B', exitCode: endA9.ok ? 0 : 1, stats: { type: endA9.type, stopReason: endA9.payload?.stopReason ?? null } })

    await ev.shot(await instance.page(), 'detach-interactions-done')
    log(`done sid=${sid} barReachable=${barReachable}`)
  }
  return { uncovered, gotchas }
}
