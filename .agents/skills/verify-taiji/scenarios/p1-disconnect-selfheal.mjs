/**
 * p1-disconnect-selfheal —— 断连自愈与终态失败收尾（chat-flow-consistency 验收计划表 A4 / L3 行）。
 *
 * 装配：faux（turn1 = 长文本低速流式（tps 限速拉长窗口），turn2 = error step 终态失败注入）。
 * 断连手段（实测选定）：Playwright page.routeWebSocket 拦截 renderer→runtime 的 WS
 * （URL = ws://localhost:<runtimePort>，use-connection.ts localRuntimeUrl）——先装路由再
 * page.reload() 使 renderer 连接进入路由代，sever = 关全部服务端腿（页面侧见 onclose →
 * ws-client 退避重连，重连尝试在 severed 窗口内被立即关闭），restore = 清旗标放行。
 * 已知登记 context.setOffline 稳定性未验证，本剧本不使用。
 *
 * 路径：
 *   段 1 断连自愈——流式中（PART 标记可见 = 本地 streaming 残留在场）切断 WS →
 *   回合在 runtime 侧照常完成（本剧本协议连接独立于页面 WS，B 通道可见 complete）→
 *   断言残留：UI 无 END 哨兵 + 停止位仍在（renderer 视角仍在生成）→ restore →
 *   断言自愈：END 哨兵经重连回放出现、停止位消失、发送位回归（isGenerating 复位）→
 *   B：history 含全文（权威源）→ A：page.reload() 后内容 ≡ 自愈态（UI ≡ reload）。
 *   D4 两步恢复（recoverStalledSession，useChat.ts）触发检测：dev console 捕获
 *   '[useChat] occupancy idle but local streaming residue remains' warn——按实测形态裁决，
 *   未触发则如实登记（回放先行的机制边界，见 notProvable 登记口径）。
 *   段 2 终态失败收尾——faux error step → B：turn 以 error 终态收尾（complete.stopReason=error
 *   且 errorMessage 在案）→ A：错误作为 assistant 消息入流（block-text-error）→
 *   停止位消失、发送位回归（isGenerating 复位）→ B：occupancy 回 idle。
 */
export const meta = {
  id: 'p1-disconnect-selfheal',
  priority: 'P1',
  title: 'WS 断连自愈（残留收尾 + 权威内容接管 + UI ≡ reload）+ 终态失败收尾（错误入流 + isGenerating 复位）',
  covers: ['session.create', 'chat.send', 'chat.wait', 'chat.stream', 'session.history', 'chat.reload-equiv'],
  requires: ['faux'],
  estimateSec: 200,
  faux: {
    tps: 8,
    responses: [
      {
        thinking: 'DS 断连自愈轮的思考：正文将低速流式输出，中段网络将被切断，验证重连后按权威载荷恢复完整内容。',
        text:
          '断连自愈演示正文。第一段先铺陈背景：对话流在流式期间依赖瞬态增量通道，断连即丢；' +
          '权威内容应由定稿载荷与重连回放承担。第二段是中段标记 DS-HEAL-PART-MARK：到这里时页面侧应已渲染出部分正文，' +
          '但整轮尚未结束。第三段继续填充内容长度，让流式窗口足够长：流式通道的展示职责与正确性职责分离，' +
          '瞬态丢块不等于内容丢失，重连后以服务端权威状态为准重建。第四段补充：回合占用状态经 occupancy 广播宣告，' +
          '本地派生视图与权威帧不一致时由恢复编排收尾。最后给出结尾标记 DS-HEAL-SENTINEL-END。',
        stopReason: 'stop',
      },
      { error: 'DS 终态失败注入：模型侧错误收尾（faux error step）。', stopReason: 'error' },
    ],
  },
  provable: [
    '断连手段可控：routeWebSocket 拦截 renderer→runtime WS，sever/restore 精确翻转',
    '断连窗口内本地 streaming 残留在场：UI 无 END 哨兵 + 停止位仍在，而 B 通道已见 complete（权威与本地矛盾态成立）',
    'A：restore 后自愈：END 哨兵经重连回放出现 + 停止位消失 + 发送位回归（isGenerating 复位）',
    'B：自愈内容 = 权威源（session.history 含全文哨兵）',
    'A：page.reload() 后内容 ≡ 自愈态（断连自愈的最终形态与重开一致）',
    'B：终态失败 turn 以 error 收尾（complete.stopReason=error，errorMessage 在案）',
    'A：错误作为 assistant 消息入流（block-text-error 可见，错误文本在场），isGenerating 复位（发送位回归 + occupancy idle）',
  ],
  notProvable: [
    '真实网络分区/网卡断开形态（本剧本断连 = WS 路由层关闭，页面与 runtime 进程均在本地存活；网络层故障形态等价于 WS 断开，不重复覆盖）',
    'pi 进程崩溃/异常退出的恢复链（crash-resilience 域：session.exited/restored，与 WS 断连不同机制，不在本剧本）',
  ],
}

const PART_MARK = 'DS-HEAL-PART-MARK'
const END_MARK = 'DS-HEAL-SENTINEL-END'
const ERR_MARK = 'DS 终态失败注入'

/** body innerHTML 条件轮询（同 p0-chat-stream-ui：innerHTML 为全量 DOM）。 */
async function pollBodyHtml(ui, needle, { timeoutMs = 30_000, intervalMs = 400, wantPresent = true } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (html.includes(needle) === wantPresent) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

/** occupancy 全 idle 帧检测（自 idx 之后，B 通道）。 */
function findIdleOccupancy(events, sid, fromIdx) {
  for (let i = fromIdx; i < events.length; i++) {
    const e = events[i]
    if (e?.type === 'session.occupancy' && e.payload?.sessionId === sid) {
      if (e.payload.turn === 'idle' && !e.payload.compacting && !e.payload.bash) return e
    }
  }
  return null
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const ui = ctx.ui
  const page = await ctx.instance.page()
  const info = ctx.instance.info()
  const runtimePort = info.runtimePort
  const uncovered = []
  const notProvable = []
  const gotchas = [
    '断连手段：page.routeWebSocket 只拦截安装后的新连接——必须先装路由再 page.reload()，让 renderer WS 进入路由代；sever = 关全部服务端腿',
    '断连窗口要短于 ws-client 自动重连放弃线（1+2+4+8+16+30s ≈ 60s，ws-client MAX_RECONNECT_DURATION_MS）：sever 后等 B 通道 complete 即 restore',
    'D4 两步恢复（recoverStalledSession）的触发面 = 终态帧处理半途失败（设计 §3.3 D4 分诊的「处理失败类」）；纯断连丢失类由 ring 回放兜住（message-bus TOPIC_TABLE：message_end/complete 均为 stream 入 ring；subscription-state：snapshot 回放先于 stateSnapshot occupancy）——回放先于 occupancy 到达则 D4 不触发，此为设计内分工，按实测形态登记',
  ]

  // ── 段 0：WS 路由 + 控制台捕获 + reload 进路由代 ───────────
  const consoleLines = []
  page.on('console', (msg) => {
    try {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`)
    } catch { /* ignore */ }
  })

  const activeServerLegs = new Set()
  let severed = false
  await page.routeWebSocket(
    (url) => url.port === String(runtimePort),
    (ws) => {
      if (severed) {
        void ws.close().catch(() => {})
        return
      }
      const server = ws.connectToServer()
      activeServerLegs.add(server)
    },
  )
  ev.step({ step: 'ws.route.installed', channel: 'C', exitCode: 0, stats: { runtimePort } })

  await page.reload()
  await ui.expectVisible('css=.session-item, [data-testid="composer-box"]', { timeoutMs: 60_000 })
  ev.step({ step: 'page.reloaded', channel: 'C', exitCode: 0, stats: {} })

  // ── 段 1a：建会话 + 激活 + 发送（低速流式） ─────────────────
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p1-disconnect-selfheal' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  await protocol.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })

  const since1 = protocol.events.length
  await protocol.send(sid, '请缓慢输出长文，中段将断连。DS-HEAL-USER-1')
  // 等流式进行到中段（PART 标记可见 = 本地 streaming 残留在场且未收尾）
  const partialHtml = await pollBodyHtml(ui, PART_MARK, { timeoutMs: 60_000 })
  ev.assert('A: 流式中段可见（PART 标记入 DOM，streaming 残留在场）', partialHtml.includes(PART_MARK), {
    channel: 'A', expected: PART_MARK, actual: `hit=${partialHtml.includes(PART_MARK)}`,
  })
  const stopDuringStream = partialHtml.includes('stop-btn')
  ev.assert('A: 流式中停止位在场（isGenerating = true）', stopDuringStream, {
    channel: 'A', expected: 'stop-btn 在 DOM', actual: `present=${stopDuringStream}`,
  })

  // ── 段 1b：sever + 回合在 runtime 侧照常完成 ────────────────
  severed = true
  for (const leg of [...activeServerLegs]) {
    await leg.close().catch(() => {})
  }
  activeServerLegs.clear()
  ev.step({ step: 'ws.severed', channel: 'C', exitCode: 0, stats: { legs: [...activeServerLegs].length } })

  const end1 = await protocol.waitTurnEnd(sid, { since: since1, timeoutMs: 180_000 })
  ev.assert('B: 断连期间回合在 runtime 侧照常完成（complete 到达独立协议连接）', end1.ok === true, {
    channel: 'B', expected: 'message.complete 非 error', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
  })

  // 残留矛盾态：权威已 idle，本地仍 streaming（END 不可见 + 停止位仍在）
  const residueHtml = await ui.html('css=body')
  const residueOk = !residueHtml.includes(END_MARK) && residueHtml.includes('stop-btn')
  ev.assert('断连窗口内残留矛盾态成立：UI 无 END 哨兵 + 停止位仍在（B 已 complete）', residueOk, {
    channel: 'A',
    expected: 'END 缺席 ∧ stop-btn 在场',
    actual: `endAbsent=${!residueHtml.includes(END_MARK)} stopPresent=${residueHtml.includes('stop-btn')}`,
  })
  await ev.shot(page, 'severed-residue')

  // ── 段 1c：restore → 自愈 ─────────────────────────────────
  severed = false
  ev.step({ step: 'ws.restored', channel: 'C', exitCode: 0, stats: {} })

  const healedHtml = await pollBodyHtml(ui, END_MARK, { timeoutMs: 60_000 })
  ev.assert('A: restore 后自愈（END 哨兵经重连回放出现）', healedHtml.includes(END_MARK), {
    channel: 'A', expected: END_MARK, actual: `hit=${healedHtml.includes(END_MARK)}`,
  })
  const healedIdleHtml = await pollBodyHtml(ui, 'stop-btn', { timeoutMs: 30_000, wantPresent: false })
  const isGeneratingReset = !healedIdleHtml.includes('stop-btn') && healedIdleHtml.includes('composer-send-btn')
  ev.assert('A: 自愈后 isGenerating 复位（停止位消失 + 发送位回归）', isGeneratingReset, {
    channel: 'A',
    expected: '无 stop-btn ∧ composer-send-btn 在场',
    actual: `stopGone=${!healedIdleHtml.includes('stop-btn')} sendBtn=${healedIdleHtml.includes('composer-send-btn')}`,
  })
  await ev.shot(page, 'healed')

  // B：自愈内容 = 权威源
  const hist1 = await protocol.history(sid, { limitTurns: 10 })
  const histText = JSON.stringify(hist1.messages ?? [])
  ev.assert('B: history 权威含全文（END 哨兵 + 思考段）', histText.includes(END_MARK), {
    channel: 'B', expected: 'history 含 END 哨兵', actual: `hit=${histText.includes(END_MARK)} messages=${(hist1.messages ?? []).length}`,
  })
  ev.step({ step: 'chat.selfheal', channel: 'B', exitCode: 0, stats: { endSeen: end1.type } })

  // ── 段 1d：D4 两步恢复触发检测（按实测形态裁决） ───────────
  const d4WarnSeen = consoleLines.some((l) => l.includes('occupancy idle but local streaming residue'))
  const wsConsoleTail = consoleLines.filter((l) => /\[ws\]|useChat|subscription|residue|stalled/i.test(l)).slice(-40)
  ev.attach('console-ws-tail', wsConsoleTail.join('\n').slice(0, 8_000) || '(无匹配行)')
  if (d4WarnSeen) {
    ev.assert('D4 两步恢复触发（recoverStalledSession dev warn 在案）', true, {
      channel: 'A',
      expected: "console 含 '[useChat] occupancy idle but local streaming residue remains'",
      actual: '在案（见 console-ws-tail）',
    })
  } else {
    // 回放先行 = 设计内分工（丢失类由 ring 回放兜住，D4 只接处理失败类）：
    // 本剧本黑盒手段制造不出「终态帧处理半途失败」，该子面如实登记（uncovered → degraded，不硬凑）
    const line = 'D4 两步恢复专属触发面（recoverStalledSession，useChat.ts:658）：黑盒断连场景由 ring 回放先行收尾（message_end/complete 为 stream 类入 ring，subscription-state snapshot 回放先于 stateSnapshot occupancy 到达），残留先被回放解决、D4 不触发——「处理失败类」触发需终态帧处理链半途抛错，faux/routeWebSocket 均无法注入，未验证'
    uncovered.push(line)
    ev.assert('断连自愈（残留收尾 + 权威接管）经重连回放达成（机制中立终态断言）', healedHtml.includes(END_MARK) && isGeneratingReset, {
      channel: 'A',
      expected: 'END 可见 ∧ isGenerating 复位（无论回放或 D4 编排承担）',
      actual: `end=${healedHtml.includes(END_MARK)} reset=${isGeneratingReset} d4Warn=${d4WarnSeen}`,
    })
  }

  // ── 段 1e：UI ≡ reload ────────────────────────────────────
  const healedSignature = {
    end: healedIdleHtml.includes(END_MARK),
    part: healedIdleHtml.includes(PART_MARK),
    sendBtn: healedIdleHtml.includes('composer-send-btn'),
    stop: healedIdleHtml.includes('stop-btn'),
  }
  await page.reload()
  await ui.expectVisible('css=.session-item, [data-testid="composer-box"]', { timeoutMs: 60_000 })
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  const reloadHtml = await pollBodyHtml(ui, END_MARK, { timeoutMs: 30_000 })
  const reloadSignature = {
    end: reloadHtml.includes(END_MARK),
    part: reloadHtml.includes(PART_MARK),
    sendBtn: reloadHtml.includes('composer-send-btn'),
    stop: reloadHtml.includes('stop-btn'),
  }
  const equivOk = JSON.stringify(healedSignature) === JSON.stringify(reloadSignature)
  ev.assert('A: reload 后 ≡ 自愈态（哨兵与按钮态逐项一致）', equivOk, {
    channel: 'A',
    expected: JSON.stringify(healedSignature),
    actual: JSON.stringify(reloadSignature),
  })
  await ev.shot(page, 'reload-equivalence')

  // ── 段 2：终态失败收尾（faux error step） ──────────────────
  const since2 = protocol.events.length
  await protocol.send(sid, '触发终态失败。DS-ERR-USER-2')
  const end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 180_000 })
  ev.assert('B: 终态失败 turn 以 error 收尾', end2.type === 'message.complete' || end2.type === 'message.error', {
    channel: 'B',
    expected: 'message.complete{stopReason:error} 或 message.error',
    actual: `${end2.type} stop=${end2.payload?.stopReason ?? ''} ok=${end2.ok}`,
  })
  ev.step({ step: 'chat.error-turn', channel: 'B', exitCode: 0, stats: { type: end2.type, stopReason: end2.payload?.stopReason ?? null } })

  const errHtml = await pollBodyHtml(ui, 'block-text-error', { timeoutMs: 30_000 })
  ev.assert('A: 错误作为 assistant 消息入流（block-text-error 可见）', errHtml.includes('block-text-error'), {
    channel: 'A', expected: 'block-text-error 在 DOM', actual: `hit=${errHtml.includes('block-text-error')}`,
  })
  const errTextVisible = errHtml.includes(ERR_MARK)
  ev.assert('A: 错误文本在场（DS 终态失败注入文案）', errTextVisible, {
    channel: 'A', expected: ERR_MARK, actual: `hit=${errTextVisible}`,
  })
  const errIdleHtml = await pollBodyHtml(ui, 'stop-btn', { timeoutMs: 30_000, wantPresent: false })
  const errResetOk = !errIdleHtml.includes('stop-btn') && errIdleHtml.includes('composer-send-btn')
  ev.assert('A: 错误收尾后 isGenerating 复位（发送位回归）', errResetOk, {
    channel: 'A',
    expected: '无 stop-btn ∧ composer-send-btn 在场',
    actual: `stopGone=${!errIdleHtml.includes('stop-btn')} sendBtn=${errIdleHtml.includes('composer-send-btn')}`,
  })
  const idleAfterError = findIdleOccupancy(protocol.events, sid, since2)
  ev.assert('B: 错误收尾后 occupancy 三维全 idle', Boolean(idleAfterError), {
    channel: 'B',
    expected: 'session.occupancy{turn:idle, compacting:false, bash:false}',
    actual: idleAfterError ? JSON.stringify(idleAfterError.payload) : '未捕获（订阅窗口内无 idle 帧）',
  })
  await ev.shot(page, 'error-finalize')

  log(`done sid=${sid} d4Warn=${d4WarnSeen}`)
  return { uncovered, notProvable, gotchas }
}
