/**
 * p1-queue-inline-edit —— chat-flow-consistency §4 A5（impl-plan 验收计划表 L3 行：
 * new:队列原位编辑与清除）。
 *
 * 装配：faux + TAIJI_FAUX_TPS=3（低速率拉长主回合流式窗口，供回合中排队）。
 * 路径（A/B/C 三通道）：
 *   段 1 排队——协议发主回合消息（direct）→ message_start 后回合中连发 3 条（lane=steer）
 *     → B：session.delivery 帧出现 3 条非 direct 条目（帧序 = 提交序）→
 *     A：queue-bubble + queue-item-<uuid> 三行可见、对话流仍只有主回合 1 轮。
 *   段 2 原位编辑（D6 真实用户路径）——hover 行 → 点 ✎（queue-edit-<uuid>）→
 *     A：queue-edit-banner 编辑态提示条出现 + peek 预填草稿（含原文哨兵）→
 *     全选替换输入新文 → Enter → B：同 clientUuid 条目 preview 换新（delivery.peek 全文
 *     复核）+ 帧序不变（保位）→ A：banner 消失、草稿清空、行仍在原位显示新文。
 *   段 3 清除——UI × 撤一条（queue-cancel-<uuid>，行离场）+ 协议 delivery.cancel 撤一条
 *     （回执 cancelled:true 携全文）→ 回执四值负探针：对已撤销条目 delivery.edit →
 *     {edited:false, reason:'cancelled'}；对不存在 id → reason:'not-found'。
 *   段 4 宿主不变 + 收尾——A：turn 计数仍 1、主回合哨兵在流 → waitTurnEnd 后
 *     B：history 中编辑后文本恰好出现 1 次（无重复投递）、被撤两条零出现、
 *     原第二条文本零出现（证明是替换而非补发）。
 *
 * 现行锚点事实（2026-10-24 源码核对）：
 * - QueueBubble.vue：queue-bubble / queue-item-<uuid> / queue-state-<uuid> /
 *   queue-edit-<uuid> / queue-cancel-<uuid> / queue-edit-banner / queue-edit-abandon；
 *   行动作钮 hover 揭示（opacity-0，pointer-events 未禁，hover 后可点）。
 * - 编辑锚定链 = useQueueEditAnchor.beginQueueEntryEdit（peek 预填 + 锚定登记）→
 *   发送分流 sendWithQueueEdit → delivery.edit；banner 随锚定显隐。
 * - delivery.edit 回执四值 delivered/unconfirmed/cancelled/not-found
 *   （session-delivery-registry.ts editEntry 分支表）。
 */

// ── 哨兵与文案（各哨兵互不为子串，防 history 计数串扰） ────────────────────────
const S_HOST = 'A5-HOST-1c7a'
const S_Q2 = 'A5-Q2-orig-31e9'
const S_Q3 = 'A5-Q3-orig-52b4'
const S_Q4 = 'A5-Q4-orig-93f6'
const S_EDIT = 'A5-Q2-edit-77c1'
const MSG_HOST = `${S_HOST} 主回合消息：请开始一个较长的回复。`
const MSG_Q2 = `${S_Q2} 排队第二条，将被原位编辑替换。`
const MSG_Q3 = `${S_Q3} 排队第三条，将被 UI 撤销清除。`
const MSG_Q4 = `${S_Q4} 排队第四条，将被协议撤销清除。`
const MSG_EDIT = `${S_EDIT} 替换后的排队内容（原位替换验证）。`
/** 主回合长文本：6 段 × ~72 字符 ≈ 432 token，TPS=3 下 ≈ 144s 流式窗口。 */
const LONG_TURN = Array.from(
  { length: 6 },
  (_, i) => `Seg${i + 1}: A5 host turn is still streaming to hold the queue window open. `,
).join('')

export const meta = {
  id: 'p1-queue-inline-edit',
  priority: 'P1',
  title: 'A5 队列区原位编辑与清除：回合中连发入队 → ✎ 原位替换（保位·id 不变）→ × 清除离场 → 宿主对话流不变',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.steer', 'chat.wait', 'session.history',
  ],
  requires: ['faux'],
  estimateSec: 360,
  faux: {
    tps: 3,
    responses: [
      { text: LONG_TURN, stopReason: 'stop' },
      { text: 'A5-ACK-1 received.', stopReason: 'stop' },
      { text: 'A5-ACK-2 received.', stopReason: 'stop' },
      { text: 'A5-ACK-3 received.', stopReason: 'stop' },
      { text: 'A5-ACK-4 received.', stopReason: 'stop' },
    ],
  },
  provable: [
    '回合中连发 3 条全部 lane=steer（B：delivery.submit 回执），session.delivery 帧非 direct 条目按提交序排列',
    'A：queue-bubble 可见，3 条 queue-item-<uuid> 行渲染，对话流仍只有主回合 1 轮',
    'D6 编辑链（真实用户路径）：✎ → queue-edit-banner 出现 + peek 预填草稿 → 替换文本 Enter → banner 消失、草稿清空',
    'B：编辑后同 clientUuid 条目 preview/全文换新（delivery.peek 复核）且帧序不变（保位·id 不变）',
    '清除双路：UI × 行离场；协议 delivery.cancel 回执 cancelled:true 携全文',
    'edit 回执负探针：已撤销条目 reason=cancelled、不存在 id reason=not-found',
    '收尾等价：history 中编辑后文本恰好 1 次、两条被撤文本 0 次、原第二条文本 0 次（替换而非补发，无重复投递）',
  ],
  notProvable: [
    'edit 回执四值中的 delivered / unconfirmed：分别需要「改草稿期间条目被注入」竞态窗口与「出站批内挂起跌落」形态，faux 装配下不可确定性触发（本剧本覆盖 edited:true + cancelled + not-found 三形态）',
    '× 清除后输入框草稿形态：实测撤销会把全文回填草稿（useQueueRows onCancelEntry → restoreDraft），与设计 §4 A5「草稿不变」行文有出入——如实 attach 留档并登记 productSuspicions，不作断言',
    '移动壳 QueueStrip 的 ✎/× 同步（移动壳独立按钮链，桌面剧本不可达）',
  ],
}

/** 条目计数（帧内非 direct 且未 delivered = 队列区可见行口径，core deliveryQueueEntries 同谓词）。 */
function queueEntriesOf(framePayload) {
  return (framePayload?.entries ?? []).filter((e) => e.lane !== 'direct' && e.state !== 'delivered')
}
function countIn(text, needle) {
  let n = 0
  let i = 0
  for (;;) {
    const j = text.indexOf(needle, i)
    if (j === -1) return n
    n += 1
    i = j + needle.length
  }
}
function userHistoryText(hist) {
  return (hist?.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => JSON.stringify(m.content ?? ''))
    .join('\n')
}
function turnCountOf(html) {
  return (html.match(/data-testid="turn-\d+"/g) ?? []).length
}
/** 条件轮询 body innerHTML 直到谓词命中；超时返回最后内容（断言按实际判定）。 */
async function pollHtml(ui, predicate, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  for (;;) {
    html = await ui.html('css=body')
    if (predicate(html)) return html
    if (Date.now() >= deadline) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
/** 条件轮询 locator 文本。 */
async function pollText(ui, sel, predicate, { timeoutMs = 20_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  for (;;) {
    try {
      text = await ui.text(sel)
    } catch {
      text = ''
    }
    if (predicate(text)) return text
    if (Date.now() >= deadline) return text
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
/** 条件轮询 session.history（撤回/注入落盘异步）。 */
async function pollHistory(p, sid, predicate, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let hist = null
  for (;;) {
    hist = await p.history(sid, { limitTurns: 20 })
    if (predicate(hist)) return hist
    if (Date.now() >= deadline) return hist
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function run(ctx) {
  const { protocol: p, ev, log, ui, instance, repo } = ctx
  const uncovered = []
  const gotchas = [
    '回合中窗口必须 TAIJI_FAUX_TPS 拉长：不设 TPS 回复瞬时到达，submit 回 lane=direct 直接失败',
    'steer 条目送达 = pi message_end(user) 标记命中：回合结束注入时才 delivered，回合中一直留队列区（in-flight/queued）',
    '行动作钮 hover 揭示（opacity-0）：先 ui.hover(queue-item-<uuid>) 再点 queue-edit/queue-cancel 更稳',
    '编辑替换用 Meta+a（macOS Cmd+A）全选 + Backspace 清空再逐字输入：fill 不触发 contenteditable input 逻辑',
    '× 撤销会把全文回填草稿（useQueueRows.ts onCancelEntry → restoreDraft）——断言「宿主对话流不变」只看 turn 计数，不看全页 HTML 哨兵（草稿会带出被撤文本）',
  ]
  const framesSeen = []

  // ── 段 0：建会话 + UI 激活链 ─────────────────────────────────
  const created = await p.call('session.create', { cwd: repo, label: 'p1-queue-inline-edit' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  await p.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  ev.assert('A: 侧栏会话行可点（UI 激活链）', true, {
    channel: 'A', expected: '协议建会话后侧栏出现会话行', actual: `sid=${sid}`,
  })
  ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

  // ── 段 1：主回合 + 回合中连发 3 条入队 ────────────────────────
  const since0 = p.events.length
  const host = await p.send(sid, MSG_HOST)
  ev.assert('B: 主回合消息 direct 车道（idle 会话）', host.reply?.lane === 'direct', {
    channel: 'B', expected: 'lane=direct', actual: JSON.stringify(host.reply ?? {}),
  })
  // [产品缺口 workaround，2026-10-24 探针实证] session.delivery topic 接线唯一入口 =
  // session.subscribe（session-delivery-topic.ts sync：内核运行时已存在才挂 onChange）；
  // 首订阅（本剧本与 renderer 激活时序同款）早于首次 submit（内核尚不存在）→ 之后内核
  // 变更永不发帧（协议侧与 renderer 队列区双盲，探针 PHASE1 实测 0 帧 + queue-bubble 不
  // 渲染）。首次 submit 已建内核，这里二次 subscribe 触发接线（= renderer 切回会话/重连
  // 的真实通路，非 mock）——此后 bus.publish 对全部订阅者可见，renderer 队列区同源恢复
  // （探针 PHASE2 实测）。缺口登记 productSuspicions，主 agent 裁决。
  await p.subscribe(sid)
  await p.waitFor((e) => e.type === 'message.message_start', { sessionId: sid, since: since0, timeoutMs: 60_000 })
  ev.assert('B: 主回合已开跑（message.message_start）', true, {
    channel: 'B', expected: 'message_start 广播', actual: '收到',
  })

  const q = []
  for (const [tag, msg] of [['Q2', MSG_Q2], ['Q3', MSG_Q3], ['Q4', MSG_Q4]]) {
    const r = await p.send(sid, msg)
    ev.assert(`B: 回合中提交 ${tag} 判 steer 车道`, r.reply?.lane === 'steer', {
      channel: 'B', expected: 'lane=steer', actual: JSON.stringify(r.reply ?? {}),
    })
    q.push(r)
  }
  ev.step({ step: 'queue.submit', channel: 'B', exitCode: 0, stats: { count: q.length, lanes: q.map((r) => r.reply?.lane) } })

  const frameEvt = await p.waitFor(
    (e) => e.type === 'session.delivery' && queueEntriesOf(e.payload).length >= 3,
    { sessionId: sid, timeoutMs: 30_000 },
  )
  const entryIds = queueEntriesOf(frameEvt.payload).map((e) => e.clientUuid)
  ev.assert('B: session.delivery 帧含 3 条队列条目且帧序 = 提交序', JSON.stringify(entryIds) === JSON.stringify(q.map((r) => r.clientUuid)), {
    channel: 'B', expected: q.map((r) => r.clientUuid).join(','), actual: entryIds.join(','),
  })
  framesSeen.push({ at: 'after-submit', entries: queueEntriesOf(frameEvt.payload) })

  // ── A：队列区渲染 + 宿主仍 1 轮 ──────────────────────────────
  const [e2, e3, e4] = q.map((r) => r.clientUuid)
  const html1 = await pollHtml(ui, (h) => h.includes('queue-bubble') && h.includes(`queue-item-${e2}`) && h.includes(`queue-item-${e4}`))
  ev.assert('A: 队列区可见（queue-bubble + 3 行 queue-item-<uuid>）',
    html1.includes('queue-bubble') && html1.includes(`queue-item-${e2}`) && html1.includes(`queue-item-${e3}`) && html1.includes(`queue-item-${e4}`), {
      channel: 'A', expected: 'queue-bubble 与 3 行', actual: `bubble=${html1.includes('queue-bubble')} rows=${[e2, e3, e4].map((id) => html1.includes(`queue-item-${id}`) ? 1 : 0).join('')}`,
    })
  ev.assert('A: 宿主对话流不变（仍只有主回合 1 轮）', turnCountOf(html1) === 1, {
    channel: 'A', expected: 'turn 计数 1', actual: String(turnCountOf(html1)),
  })
  ev.assert('A: 主回合用户哨兵在对话流', html1.includes(S_HOST), {
    channel: 'A', expected: S_HOST, actual: `hit=${html1.includes(S_HOST)}`,
  })
  await ui.screenshot('queue-3rows')

  // ── 段 2：D6 原位编辑（真实用户路径：✎ → 预填 → 替换 → Enter） ──
  await ui.hover(`testid=queue-item-${e2}`)
  await ui.click(`testid=queue-edit-${e2}`)
  await ui.expectVisible('testid=queue-edit-banner', { timeoutMs: 15_000 })
  ev.assert('A: 编辑态提示条出现（queue-edit-banner，锚定在册）', true, {
    channel: 'A', expected: 'banner 可见', actual: '可见',
  })
  const draft1 = await pollText(ui, 'role=textbox', (t) => t.includes(S_Q2))
  ev.assert('A: peek 预填草稿（含被编辑条目原文）', draft1.includes(S_Q2), {
    channel: 'A', expected: `草稿含 ${S_Q2}`, actual: draft1.slice(0, 120),
  })

  // 全选后直接键入（不按 Backspace）：选区替换在首个字符输入时完成，草稿不经「空」边沿。
  // 若先删空再输入，会触发 useQueueEditAnchor「清空草稿解除锚定」watch（Q4 路径 2）→
  // 锚定被清 → Enter 走普通新消息降级（产品行为正确，驱动不得造出该形态）。
  await ui.click('role=textbox')
  await ui.press('Meta+a')
  await (await instance.page()).keyboard.type(MSG_EDIT)
  await ui.press('Enter')

  await ui.expectGone('testid=queue-edit-banner', { timeoutMs: 15_000 })
  ev.assert('A: 提交编辑后提示条消失（锚定解除）', true, {
    channel: 'A', expected: 'banner 消失', actual: '已消失',
  })
  const draft2 = await pollText(ui, 'role=textbox', (t) => t.trim().length === 0, { timeoutMs: 15_000 })
  ev.assert('A: 提交编辑后输入框清空', draft2.trim().length === 0, {
    channel: 'A', expected: '空草稿', actual: `len=${draft2.trim().length}`,
  })

  const frameEdit = await p.waitFor(
    (e) => e.type === 'session.delivery' && queueEntriesOf(e.payload).some((x) => x.clientUuid === e2 && (x.preview ?? '').includes(S_EDIT)),
    { sessionId: sid, timeoutMs: 30_000 },
  )
  const editIds = queueEntriesOf(frameEdit.payload).map((x) => x.clientUuid)
  ev.assert('B: 编辑后同 id 条目 preview 换新且帧序不变（保位·id 不变）', JSON.stringify(editIds) === JSON.stringify([e2, e3, e4]), {
    channel: 'B', expected: [e2, e3, e4].join(','), actual: editIds.join(','),
  })
  framesSeen.push({ at: 'after-edit', entries: queueEntriesOf(frameEdit.payload) })
  ev.step({ step: 'queue.edit', channel: 'B', exitCode: 0, stats: { editedId: e2, order: editIds } })

  const peek2 = await p.call('delivery.peek', { sessionId: sid, clientUuid: e2 }, { timeoutMs: 30_000 })
  ev.assert('B: delivery.peek 复核编辑后全文（替换语义：含新哨兵、不含原哨兵）', peek2.found === true && String(peek2.content ?? '').includes(S_EDIT) && !String(peek2.content ?? '').includes(S_Q2), {
    channel: 'B', expected: `content 含 ${S_EDIT} 且不含 ${S_Q2}`, actual: JSON.stringify(peek2).slice(0, 200),
  })
  const html2 = await pollHtml(ui, (h) => h.includes(`queue-item-${e2}`) && h.includes(S_EDIT))
  ev.assert('A: 队列行原位显示编辑后文本', html2.includes(`queue-item-${e2}`) && html2.includes(S_EDIT) && !html2.includes(S_Q2), {
    channel: 'A', expected: `行在位 + 含 ${S_EDIT} + 不含 ${S_Q2}`, actual: `row=${html2.includes(`queue-item-${e2}`)} edit=${html2.includes(S_EDIT)} orig=${html2.includes(S_Q2)}`,
  })
  await ui.screenshot('queue-edited-row')

  // ── 段 3：清除（UI × 一条 + 协议 delivery.cancel 一条 + 回执负探针） ──
  await ui.hover(`testid=queue-item-${e3}`)
  await ui.click(`testid=queue-cancel-${e3}`)
  await ui.expectGone(`testid=queue-item-${e3}`, { timeoutMs: 15_000 })
  ev.assert('A: UI × 清除后该行离场', true, {
    channel: 'A', expected: `queue-item-${e3} 消失`, actual: '已消失',
  })
  const draft3 = await ui.text('role=textbox')
  ev.attach('draft-after-ui-cancel', `UI × 撤销 ${S_Q3} 后的输入框草稿：${JSON.stringify(draft3)}`)

  const cancel4 = await p.call('delivery.cancel', { sessionId: sid, clientUuid: e4 }, { timeoutMs: 30_000 })
  ev.assert('B: 协议 delivery.cancel 回执 cancelled:true 携全文', cancel4.cancelled === true && String(cancel4.content ?? '').includes(S_Q4), {
    channel: 'B', expected: '{cancelled:true, content 含原文本}', actual: JSON.stringify(cancel4).slice(0, 200),
  })
  await ui.expectGone(`testid=queue-item-${e4}`, { timeoutMs: 15_000 })
  ev.step({ step: 'queue.cancel', channel: 'B', exitCode: cancel4.cancelled ? 0 : 1, stats: { cancelledUi: 'Q3', cancelledProto: 'Q4' } })

  // 回执四值负探针（终态短路分支，无副作用）
  const negCancelled = await p.call('delivery.edit', { sessionId: sid, clientUuid: e3, content: 'A5-NEG-PROBE' }, { timeoutMs: 30_000 })
  ev.assert('B: edit 回执负探针——已撤销条目 reason=cancelled', negCancelled.edited === false && negCancelled.reason === 'cancelled', {
    channel: 'B', expected: '{edited:false, reason:"cancelled"}', actual: JSON.stringify(negCancelled),
  })
  const negNotFound = await p.call('delivery.edit', { sessionId: sid, clientUuid: 'a5-bogus-uuid-not-registered', content: 'A5-NEG-PROBE' }, { timeoutMs: 30_000 })
  ev.assert('B: edit 回执负探针——不存在条目 reason=not-found', negNotFound.edited === false && negNotFound.reason === 'not-found', {
    channel: 'B', expected: '{edited:false, reason:"not-found"}', actual: JSON.stringify(negNotFound),
  })

  const frameAfterCancel = await p.waitFor(
    (e) => e.type === 'session.delivery' && queueEntriesOf(e.payload).length === 1 && queueEntriesOf(e.payload)[0]?.clientUuid === e2,
    { sessionId: sid, timeoutMs: 30_000 },
  )
  framesSeen.push({ at: 'after-cancel', entries: queueEntriesOf(frameAfterCancel.payload) })
  ev.assert('B: 清除后队列只剩被编辑条目', true, {
    channel: 'B', expected: `[${e2}]`, actual: queueEntriesOf(frameAfterCancel.payload).map((x) => x.clientUuid).join(','),
  })

  // ── 段 4：宿主表面不变 + 收尾等价 ────────────────────────────
  const html3 = await pollHtml(ui, (h) => turnCountOf(h) === 1)
  ev.assert('A: 队列反复操作后宿主对话流不变（turn 计数仍 1）', turnCountOf(html3) === 1 && html3.includes(S_HOST), {
    channel: 'A', expected: 'turn=1 且主回合哨兵在流', actual: `turn=${turnCountOf(html3)} host=${html3.includes(S_HOST)}`,
  })
  await ui.screenshot('queue-after-cancels')

  const end1 = await p.waitTurnEnd(sid, { since: since0, timeoutMs: 200_000 })
  ev.assert('B: 主回合正常收尾', end1.ok, {
    channel: 'B', expected: 'message.complete 非 error', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
  })

  // 注入收尾：编辑后条目被注入为主回合后的新 user 消息（faux ACK 轮）；被撤两条不出现。
  const hist = await pollHistory(p, sid, (h) => countIn(userHistoryText(h), S_EDIT) >= 1, { timeoutMs: 120_000 })
  const userText = userHistoryText(hist)
  const counts = {
    [S_EDIT]: countIn(userText, S_EDIT),
    [S_HOST]: countIn(userText, S_HOST),
    [S_Q2]: countIn(userText, S_Q2),
    [S_Q3]: countIn(userText, S_Q3),
    [S_Q4]: countIn(userText, S_Q4),
  }
  ev.assert('B: history 注入等价——编辑后文本恰好 1 次（无重复投递）', counts[S_EDIT] === 1, {
    channel: 'B', expected: '1', actual: String(counts[S_EDIT]),
  })
  ev.assert('B: history——主回合文本恰好 1 次', counts[S_HOST] === 1, {
    channel: 'B', expected: '1', actual: String(counts[S_HOST]),
  })
  ev.assert('B: history——原第二条文本 0 次（替换而非补发）', counts[S_Q2] === 0, {
    channel: 'B', expected: '0', actual: String(counts[S_Q2]),
  })
  ev.assert('B: history——被撤两条 0 次（未投递）', counts[S_Q3] === 0 && counts[S_Q4] === 0, {
    channel: 'B', expected: '0/0', actual: `${counts[S_Q3]}/${counts[S_Q4]}`,
  })
  ev.step({ step: 'queue.settle', channel: 'B', exitCode: 0, stats: counts })
  ev.attach('delivery-frames', JSON.stringify(framesSeen, null, 2).slice(0, 12_000))
  await ui.screenshot('queue-settled')

  log(`done sid=${sid} historyCounts=${JSON.stringify(counts)}`)
  return { uncovered, gotchas }
}
