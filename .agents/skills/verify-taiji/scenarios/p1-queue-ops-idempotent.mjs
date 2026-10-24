/**
 * p1-queue-ops-idempotent —— chat-flow-consistency §4 A11（impl-plan 验收计划表 L3 行：
 * new:队列操作幂等与断连恢复；观测手段按 round-3 attackHints 登记项定为 delivery.peek
 * 只读通道 + delivery-outbox 投递日志磁盘面）。
 *
 * 装配：faux + TAIJI_FAUX_TPS=3（低速率拉长主回合流式窗口）。
 * 路径（A/B/C 三通道）：
 *   段 1 入队——回合中连发 5 条（lane=steer）→ B：帧 5 条按提交序 → A：折叠口径
 *     （foldQueueRows：显前 3 + 「+2」）→ 点 +N 全显 5 行 → 收起回 3 + 「+2」。
 *   段 2 反复操作——✎ 编辑 E2（替换保位）→ ✎ E3 后「放弃编辑」（banner 消失、草稿
 *     保留，条目不动）→ × 清除 E4 → 协议 delivery.edit E5（edited:true）→
 *     delivery.resync 反复两次（活跃条目行为不变、终态条目入 deduped）。
 *   段 3 只读观测——delivery.peek 逐条复核内容（E2/E5 为编辑后文本、E3/E6 原文、
 *     E4 found:false）+ session.delivery 帧投影（活跃集合 = 预期集合且序不变）+
 *     A：队列区行数与 +N 计数一致、宿主对话流仍 1 轮。
 *   段 4 收尾——waitTurnEnd + history 逐哨兵计数：留存条目各恰好 1 次（无重复投递）、
 *     被撤条目 0 次；C：delivery-outbox JSONL 终态行（ack）逐 id ≤1 条 + 全文 attach。
 *
 * 现行锚点事实（2026-10-24 源码核对）：
 * - foldQueueRows（useQueueRows.ts）：非 failed 行显前 QUEUE_VISIBLE_MAX=3，溢出 =
 *   「+N」（queue-expand / queue-collapse，aria-expanded 承载开关态）。
 * - delivery.resync（registry）：queued/in-flight 活跃条目行为不变；终态（含 cancelled）
 *   入 deduped 应答；failed → requeue 重投（faux 下不可达，见 notProvable）。
 * - 投递日志磁盘面：<dataDir>/delivery-outbox/<sessionId 编码>.jsonl，行形态
 *   {"t":"record"|"ack","id":...}，终态行单调累积（无重复终态行 = 无重复投递的磁盘证据）。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 哨兵（互不为子串） ───────────────────────────────────────────────────────
const S_HOST = 'A11-HOST-h3f2'
const S_E2 = 'A11-E2-orig-8a41'
const S_E3 = 'A11-E3-orig-6c27'
const S_E4 = 'A11-E4-orig-1d9e'
const S_E5 = 'A11-E5-orig-4b8c'
const S_E6 = 'A11-E6-orig-0e5d'
const S_EDIT2 = 'A11-E2-edit-f7a3'
const S_EDIT5 = 'A11-E5-edit-b9d2'
const MSG_HOST = `${S_HOST} 主回合消息：请开始一个较长的回复。`
const MSGS = [
  `${S_E2} 排队 E2，将被原位编辑替换。`,
  `${S_E3} 排队 E3，将进入编辑态后放弃（条目不动）。`,
  `${S_E4} 排队 E4，将被清除。`,
  `${S_E5} 排队 E5，将被协议原位编辑。`,
  `${S_E6} 排队 E6，全程不动（对照项）。`,
]
const MSG_EDIT2 = `${S_EDIT2} E2 替换后的内容。`
const MSG_EDIT5 = `${S_EDIT5} E5 替换后的内容。`
/** 主回合长文本：8 段 × ~73 字符 ≈ 580 token，TPS=3 下 ≈ 190s 流式窗口。 */
const LONG_TURN = Array.from(
  { length: 8 },
  (_, i) => `Seg${i + 1}: A11 host turn keeps streaming to hold the repeated-ops window. `,
).join('')

export const meta = {
  id: 'p1-queue-ops-idempotent',
  priority: 'P1',
  title: 'A11 队列反复操作后宿主表面不变：编辑/放弃编辑/清除/重发/+N 展开收起 → peek 只读观测投影一致、对话流不变、无重复投递',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.steer', 'chat.wait', 'session.history',
  ],
  requires: ['faux'],
  estimateSec: 480,
  faux: {
    tps: 3,
    responses: [
      { text: LONG_TURN, stopReason: 'stop' },
      ...Array.from({ length: 7 }, (_, i) => ({ text: `A11-ACK-${i + 1} received.`, stopReason: 'stop' })),
    ],
  },
  provable: [
    'B：回合中连发 5 条全部 lane=steer，session.delivery 帧按提交序含 5 条',
    'A：折叠口径——收起显 3 行 + 「+2」；点 +N 全显 5 行（queue-expand 消隐、queue-collapse 出现）；收起回 3 + 「+2」',
    'D6 编辑态生命周期：✎ E2 编辑提交（保位·id 不变）→ ✎ E3 放弃编辑（banner 消失、草稿保留、条目不动）',
    '清除与重发幂等：× E4 行离场；协议 delivery.edit E5 edited:true；delivery.resync 连续两次——活跃条目不入 deduped 且集合不变、终态 E4 入 deduped',
    '只读观测（delivery.peek 通道）：E2/E5 为编辑后全文、E3/E6 为原文、E4 found:false；帧投影活跃集合 = {E2,E3,E5,E6} 且序不变',
    'A：反复操作后宿主对话流不变（turn 计数仍 1、主回合哨兵在流），队列区行数与折叠计数一致',
    '收尾等价：history 中 E2 编辑后/E3/E5 编辑后/E6 各恰好 1 次、E4 与两条原文 0 次（无重复投递）；C：delivery-outbox 终态行逐 id ≤1 条',
  ],
  notProvable: [
    'failed 行重试/「重试全部」的实际重投（需 ≥2 failed 条目；faux 装配下受理失败与断连两成因均不可确定性触发）——「重发」面由 delivery.resync 对活跃/终态条目的幂等去重承载',
    '断连重连后队列区显示与断连前一致（设计 A11 行的断连变体）——WS 断开重连注入归 A4 断连自愈剧本承载，本剧本不伪造断连',
    'edit 回执 delivered / unconfirmed 两值（竞态窗口形态，同 p1-queue-inline-edit 登记口径）',
    '移动壳 QueueStrip 同步（移动壳独立按钮链）',
  ],
}

/** 帧内队列条目（core deliveryQueueEntries 同谓词：非 direct 且未 delivered）。 */
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
async function pollHistory(p, sid, predicate, { timeoutMs = 150_000, intervalMs = 2_000 } = {}) {
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
  const { protocol: p, ev, log, ui, repo, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    '折叠口径在 QueueBubble 内经 foldQueueRows 计算：收起显 3 行；点 +N 全显（overflowCount 归零 → queue-expand 消隐、queue-collapse 出现）',
    '放弃编辑（queue-edit-abandon）只解除锚定：草稿保留、条目不动——之后须手工清草稿（Meta+a+Backspace），否则后续 Enter 会把草稿当新消息发出',
    'delivery.resync 对 queued/in-flight 活跃条目是幂等 no-op（不入 deduped），只有终态条目入 deduped——「重发不产生重复」的断言锚',
    'history 注入可能是合批形态（buildBatchPayload 以 \\n\\n---\\n\\n 拼接多条为一条 user 消息）——无重复投递断言按哨兵出现次数计，不按 user 消息条数计',
    '行动作钮 hover 揭示（opacity-0）：先 ui.hover(queue-item-<uuid>) 再点子按钮',
  ]
  const framesSeen = []

  // ── 段 0：建会话 + UI 激活链 ─────────────────────────────────
  const created = await p.call('session.create', { cwd: repo, label: 'p1-queue-ops-idempotent' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  await p.subscribe(sid)
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  ev.assert('A: 侧栏会话行可点（UI 激活链）', true, {
    channel: 'A', expected: '协议建会话后侧栏出现会话行', actual: `sid=${sid}`,
  })
  ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

  // ── 段 1：主回合 + 回合中连发 5 条 + 折叠口径 ──────────────────
  const since0 = p.events.length
  const host = await p.send(sid, MSG_HOST)
  ev.assert('B: 主回合消息 direct 车道', host.reply?.lane === 'direct', {
    channel: 'B', expected: 'lane=direct', actual: JSON.stringify(host.reply ?? {}),
  })
  await p.waitFor((e) => e.type === 'message.message_start', { sessionId: sid, since: since0, timeoutMs: 60_000 })
  ev.assert('B: 主回合已开跑（message_start）', true, {
    channel: 'B', expected: 'message_start 广播', actual: '收到',
  })

  const q = []
  for (const [i, msg] of MSGS.entries()) {
    const r = await p.send(sid, msg)
    ev.assert(`B: 回合中提交 E${i + 2} 判 steer 车道`, r.reply?.lane === 'steer', {
      channel: 'B', expected: 'lane=steer', actual: JSON.stringify(r.reply ?? {}),
    })
    q.push(r)
  }
  ev.step({ step: 'queue.submit', channel: 'B', exitCode: 0, stats: { count: q.length } })

  const frameEvt = await p.waitFor(
    (e) => e.type === 'session.delivery' && queueEntriesOf(e.payload).length >= 5,
    { sessionId: sid, timeoutMs: 30_000 },
  )
  const idsAll = queueEntriesOf(frameEvt.payload).map((e) => e.clientUuid)
  ev.assert('B: 帧含 5 条队列条目且帧序 = 提交序', JSON.stringify(idsAll) === JSON.stringify(q.map((r) => r.clientUuid)), {
    channel: 'B', expected: q.map((r) => r.clientUuid).join(','), actual: idsAll.join(','),
  })
  framesSeen.push({ at: 'after-submit', entries: queueEntriesOf(frameEvt.payload) })

  const [e2, e3, e4, e5, e6] = q.map((r) => r.clientUuid)
  const rowSel = 'css=[data-testid^="queue-item-"]'
  await pollHtml(ui, (h) => h.includes('queue-bubble') && h.includes(`queue-item-${e6}`))
  await ui.expectCount(rowSel, 3, { timeoutMs: 15_000 })
  ev.assert('A: 折叠口径——收起态显 3 行（QUEUE_VISIBLE_MAX）', true, {
    channel: 'A', expected: '3 行可见', actual: '3 行可见',
  })
  const expandLabel = await ui.text('testid=queue-expand')
  ev.assert('A: 「+N」溢出计数 = +2（5 - 3）', expandLabel.trim() === '+2', {
    channel: 'A', expected: '+2', actual: expandLabel.trim(),
  })

  await ui.click('testid=queue-expand')
  await ui.expectCount(rowSel, 5, { timeoutMs: 15_000 })
  ev.assert('A: 点 +N 展开全部 5 行', true, { channel: 'A', expected: '5 行', actual: '5 行' })
  await ui.expectGone('testid=queue-expand', { timeoutMs: 10_000 })
  await ui.expectVisible('testid=queue-collapse', { timeoutMs: 10_000 })
  ev.assert('A: 展开态开关形态（expand 消隐 / collapse 出现）', true, {
    channel: 'A', expected: 'expand 消隐 + collapse 可见', actual: '符合',
  })
  await ui.screenshot('queue-expanded-5rows')

  await ui.click('testid=queue-collapse')
  await ui.expectCount(rowSel, 3, { timeoutMs: 15_000 })
  const expandLabel2 = await ui.text('testid=queue-expand')
  ev.assert('A: 收起回 3 行 + 「+2」', expandLabel2.trim() === '+2', {
    channel: 'A', expected: '3 行 + +2', actual: `3 行 + ${expandLabel2.trim()}`,
  })

  // 行操作期保持展开（被操作行不落入折叠区）
  await ui.click('testid=queue-expand')

  // ── 段 2a：✎ 编辑 E2（提交保位） ────────────────────────────
  await ui.hover(`testid=queue-item-${e2}`)
  await ui.click(`testid=queue-edit-${e2}`)
  await ui.expectVisible('testid=queue-edit-banner', { timeoutMs: 15_000 })
  const draftE2 = await pollText(ui, 'role=textbox', (t) => t.includes(S_E2))
  ev.assert('A: E2 编辑态——banner 出现 + peek 预填原文', draftE2.includes(S_E2), {
    channel: 'A', expected: `草稿含 ${S_E2}`, actual: draftE2.slice(0, 120),
  })
  await ui.click('role=textbox')
  await ui.press('Meta+a')
  await ui.press('Backspace')
  await ui.type('role=textbox', MSG_EDIT2)
  await ui.press('Enter')
  await ui.expectGone('testid=queue-edit-banner', { timeoutMs: 15_000 })
  ev.assert('A: E2 编辑提交后 banner 消失', true, { channel: 'A', expected: '消失', actual: '已消失' })
  const frameEdit2 = await p.waitFor(
    (e) => e.type === 'session.delivery' && queueEntriesOf(e.payload).some((x) => x.clientUuid === e2 && (x.preview ?? '').includes(S_EDIT2)),
    { sessionId: sid, timeoutMs: 30_000 },
  )
  framesSeen.push({ at: 'after-edit-E2', entries: queueEntriesOf(frameEdit2.payload) })
  ev.assert('B: E2 编辑后帧序不变（保位·id 不变）', JSON.stringify(queueEntriesOf(frameEdit2.payload).map((x) => x.clientUuid)) === JSON.stringify([e2, e3, e4, e5, e6]), {
    channel: 'B', expected: 'E2,E3,E4,E5,E6', actual: queueEntriesOf(frameEdit2.payload).map((x) => x.clientUuid).join(','),
  })
  ev.step({ step: 'queue.edit-E2', channel: 'B', exitCode: 0, stats: { editedId: e2 } })

  // ── 段 2b：✎ E3 → 放弃编辑（banner 消失、草稿保留、条目不动） ──
  await ui.hover(`testid=queue-item-${e3}`)
  await ui.click(`testid=queue-edit-${e3}`)
  await ui.expectVisible('testid=queue-edit-banner', { timeoutMs: 15_000 })
  const draftE3 = await pollText(ui, 'role=textbox', (t) => t.includes(S_E3))
  ev.assert('A: E3 编辑态——peek 预填原文', draftE3.includes(S_E3), {
    channel: 'A', expected: `草稿含 ${S_E3}`, actual: draftE3.slice(0, 120),
  })
  await ui.click('testid=queue-edit-abandon')
  await ui.expectGone('testid=queue-edit-banner', { timeoutMs: 15_000 })
  const draftAbandon = await ui.text('role=textbox')
  ev.assert('A: 放弃编辑——banner 消失且草稿文本保留', draftAbandon.includes(S_E3), {
    channel: 'A', expected: `草稿仍含 ${S_E3}`, actual: JSON.stringify(draftAbandon.slice(0, 120)),
  })
  await ui.expectVisible(`testid=queue-item-${e3}`, { timeoutMs: 10_000 })
  ev.assert('A: 放弃编辑——条目 E3 未离场（不入队不撤回）', true, {
    channel: 'A', expected: `queue-item-${e3} 仍在`, actual: '仍在',
  })
  // 清草稿（防后续操作误发草稿；有→空边沿顺带复核锚定解除链无副作用）
  await ui.click('role=textbox')
  await ui.press('Meta+a')
  await ui.press('Backspace')
  await pollText(ui, 'role=textbox', (t) => t.trim().length === 0)
  ev.step({ step: 'queue.abandon-edit-E3', channel: 'A', exitCode: 0, stats: {} })

  // ── 段 2c：× 清除 E4 ────────────────────────────────────────
  await ui.hover(`testid=queue-item-${e4}`)
  await ui.click(`testid=queue-cancel-${e4}`)
  await ui.expectGone(`testid=queue-item-${e4}`, { timeoutMs: 15_000 })
  ev.assert('A: × 清除 E4 行离场', true, { channel: 'A', expected: '消失', actual: '已消失' })
  const frameCancel4 = await p.waitFor(
    (e) => e.type === 'session.delivery' && !queueEntriesOf(e.payload).some((x) => x.clientUuid === e4),
    { sessionId: sid, timeoutMs: 30_000 },
  )
  framesSeen.push({ at: 'after-cancel-E4', entries: queueEntriesOf(frameCancel4.payload) })
  ev.step({ step: 'queue.cancel-E4', channel: 'B', exitCode: 0, stats: {} })

  // ── 段 2d：协议原位编辑 E5（反复操作第二编辑周期） ─────────────
  const edit5 = await p.call('delivery.edit', { sessionId: sid, clientUuid: e5, content: MSG_EDIT5 }, { timeoutMs: 60_000 })
  ev.assert('B: 协议 delivery.edit E5 回执 edited:true', edit5.edited === true, {
    channel: 'B', expected: '{edited:true}', actual: JSON.stringify(edit5),
  })
  const peek5 = await p.call('delivery.peek', { sessionId: sid, clientUuid: e5 }, { timeoutMs: 30_000 })
  ev.assert('B: E5 编辑后 peek 全文换新', peek5.found === true && String(peek5.content ?? '').includes(S_EDIT5), {
    channel: 'B', expected: `content 含 ${S_EDIT5}`, actual: JSON.stringify(peek5).slice(0, 200),
  })
  ev.step({ step: 'queue.edit-E5', channel: 'B', exitCode: edit5.edited ? 0 : 1, stats: { editedId: e5 } })

  // ── 段 2e：delivery.resync 反复两次（重发幂等） ────────────────
  const liveIds = [e2, e3, e5, e6]
  const resyncPayload = [...liveIds, e4]
  const resync1 = await p.call('delivery.resync', { sessionId: sid, clientUuids: resyncPayload }, { timeoutMs: 60_000 })
  ev.assert('B: resync #1——终态 E4 入 deduped、活跃条目不入', JSON.stringify(resync1.deduped ?? []) === JSON.stringify([e4]), {
    channel: 'B', expected: `[${e4}]`, actual: JSON.stringify(resync1.deduped ?? []),
  })
  const resync2 = await p.call('delivery.resync', { sessionId: sid, clientUuids: resyncPayload }, { timeoutMs: 60_000 })
  ev.assert('B: resync #2 幂等——应答与首次一致', JSON.stringify(resync2.deduped ?? []) === JSON.stringify([e4]), {
    channel: 'B', expected: `[${e4}]`, actual: JSON.stringify(resync2.deduped ?? []),
  })
  ev.step({ step: 'queue.resync', channel: 'B', exitCode: 0, stats: { rounds: 2, deduped: resync2.deduped ?? [] } })

  // ── 段 3：只读观测（delivery.peek 通道 + 帧投影 + UI 面） ───────
  const frameObs = await p.waitFor(
    (e) => e.type === 'session.delivery' && JSON.stringify(queueEntriesOf(e.payload).map((x) => x.clientUuid)) === JSON.stringify(liveIds),
    { sessionId: sid, timeoutMs: 30_000 },
  )
  framesSeen.push({ at: 'observation', entries: queueEntriesOf(frameObs.payload) })
  ev.assert('B: 帧投影——反复操作后活跃集合 = {E2,E3,E5,E6} 且序不变', true, {
    channel: 'B', expected: liveIds.join(','), actual: queueEntriesOf(frameObs.payload).map((x) => x.clientUuid).join(','),
  })

  const peekExpect = [
    [e2, S_EDIT2, 'E2 = 编辑后文本'],
    [e3, S_E3, 'E3 = 原文（放弃编辑未动条目）'],
    [e5, S_EDIT5, 'E5 = 协议编辑后文本'],
    [e6, S_E6, 'E6 = 对照原文'],
  ]
  for (const [uuid, sentinel, label] of peekExpect) {
    const peek = await p.call('delivery.peek', { sessionId: sid, clientUuid: uuid }, { timeoutMs: 30_000 })
    ev.assert(`B: peek 只读观测——${label}`, peek.found === true && String(peek.content ?? '').includes(sentinel), {
      channel: 'B', expected: `content 含 ${sentinel}`, actual: JSON.stringify(peek).slice(0, 200),
    })
  }
  const peek4 = await p.call('delivery.peek', { sessionId: sid, clientUuid: e4 }, { timeoutMs: 30_000 })
  ev.assert('B: peek 只读观测——E4 已离场（found:false）', peek4.found === false, {
    channel: 'B', expected: '{found:false}', actual: JSON.stringify(peek4),
  })

  await ui.expectCount(rowSel, 4, { timeoutMs: 15_000 })
  const htmlObs = await pollHtml(ui, (h) => turnCountOf(h) === 1)
  ev.assert('A: 宿主对话流不变（turn 计数仍 1、主回合哨兵在流）', turnCountOf(htmlObs) === 1 && htmlObs.includes(S_HOST), {
    channel: 'A', expected: 'turn=1 + host 哨兵', actual: `turn=${turnCountOf(htmlObs)} host=${htmlObs.includes(S_HOST)}`,
  })
  await ui.click('testid=queue-collapse')
  await ui.expectCount(rowSel, 3, { timeoutMs: 15_000 })
  const expandFinal = await ui.text('testid=queue-expand')
  ev.assert('A: 收起口径随条目数收敛（4 条 → 3 行 + 「+1」）', expandFinal.trim() === '+1', {
    channel: 'A', expected: '+1', actual: expandFinal.trim(),
  })
  await ui.screenshot('queue-after-ops')

  // ── 段 4：收尾等价（history 逐哨兵计数 + 投递日志磁盘面） ────────
  const end1 = await p.waitTurnEnd(sid, { since: since0, timeoutMs: 240_000 })
  ev.assert('B: 主回合正常收尾', end1.ok, {
    channel: 'B', expected: 'message.complete 非 error', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
  })

  const settled = [S_EDIT2, S_E3, S_EDIT5, S_E6]
  const hist = await pollHistory(
    p, sid,
    (h) => settled.every((s) => countIn(userHistoryText(h), s) >= 1),
    { timeoutMs: 150_000 },
  )
  const userText = userHistoryText(hist)
  const counts = {
    host: countIn(userText, S_HOST),
    edit2: countIn(userText, S_EDIT2),
    e3: countIn(userText, S_E3),
    e4: countIn(userText, S_E4),
    edit5: countIn(userText, S_EDIT5),
    e6: countIn(userText, S_E6),
    origE2: countIn(userText, S_E2),
    origE5: countIn(userText, S_E5),
  }
  ev.assert('B: history——留存 4 条各恰好 1 次（无重复投递、无丢失）',
    counts.edit2 === 1 && counts.e3 === 1 && counts.edit5 === 1 && counts.e6 === 1, {
      channel: 'B', expected: 'edit2=1 e3=1 edit5=1 e6=1', actual: JSON.stringify(counts),
    })
  ev.assert('B: history——被撤 E4 与两条被替换原文 0 次', counts.e4 === 0 && counts.origE2 === 0 && counts.origE5 === 0, {
    channel: 'B', expected: 'e4=0 origE2=0 origE5=0', actual: JSON.stringify(counts),
  })
  ev.assert('B: history——主回合文本恰好 1 次', counts.host === 1, {
    channel: 'B', expected: '1', actual: String(counts.host),
  })
  ev.step({ step: 'queue.settle', channel: 'B', exitCode: 0, stats: counts })
  ev.attach('delivery-frames', JSON.stringify(framesSeen, null, 2).slice(0, 16_000))

  // C：投递日志（delivery-outbox JSONL）——终态行单调累积、逐 id ≤1 条 ack。
  // 文件名 = sessionId 转义段；隔离实例单会话，目录内唯一 jsonl 即本会话日志。
  const outboxDir = path.join(dataDir, 'delivery-outbox')
  let outboxFile = null
  try {
    const files = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter((f) => f.endsWith('.jsonl')) : []
    outboxFile = files.length >= 1 ? path.join(outboxDir, files[0]) : null
  } catch {
    outboxFile = null
  }
  let ackCounts = null
  if (outboxFile && fs.existsSync(outboxFile)) {
    const lines = fs.readFileSync(outboxFile, 'utf8').split('\n').filter((l) => l.trim())
    const acks = {}
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.t === 'ack') acks[obj.id] = (acks[obj.id] ?? 0) + 1
      } catch { /* 跳过半行 */ }
    }
    ackCounts = acks
    ev.attach('delivery-outbox', lines.slice(-40).join('\n').slice(0, 12_000))
    const dupAck = Object.entries(acks).filter(([, n]) => n > 1)
    ev.assert('C: 投递日志终态行无重复（逐 id ack ≤1 条）', dupAck.length === 0, {
      channel: 'C', expected: '每 id 至多 1 条 ack', actual: `ids=${Object.keys(acks).length} dup=${dupAck.map(([id, n]) => `${id}×${n}`).join(',') || 'none'}`,
    })
  } else {
    uncovered.push('delivery-outbox 日志文件未定位到（sessionId 编码段匹配失败），C 通道终态行断言未执行')
  }
  ev.step({ step: 'evidence.outbox', channel: 'C', exitCode: ackCounts !== null ? 0 : 1, stats: { file: outboxFile ?? '', ackIds: ackCounts ? Object.keys(ackCounts).length : -1 } })

  log(`done sid=${sid} counts=${JSON.stringify(counts)} ackIds=${ackCounts ? Object.keys(ackCounts).length : 'n/a'}`)
  return { uncovered, gotchas }
}
