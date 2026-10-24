/**
 * p1-turn-interject-collapse —— 回合中插话排队与收起时机（chat-flow-consistency 验收
 * 计划表 L3 行 A1a；覆盖矩阵补剧本，设计 §3.3 D1 投递判定 + D2 收起时机）。
 *
 * 装配：faux + TAIJI_FAUX_TPS=6（token 级切块限速拉长回合，pi-ai faux.js
 * streamWithDeltas：3-5 字符/chunk，~500 字符正文 ≈ 20s 流式窗口）。
 *
 * 路径（设计 §5 验收 A1a 行，原 A6 负路径并入）：
 *   段 1 长回合进行中——A：turn-meta 工作中（isWorkingTurn 未收起）+ elapsed 计时增长
 *   （useTurnElapsed 秒级 tick）→ 段 2 插话——B：delivery.submit 回执 lane='steer' +
 *   session.delivery 帧条目（lane steer / state queued|in-flight）；A：队列区行可见
 *   （queue-item-<clientUuid>）且当前回合仍工作中（D2：插话不使工作回合收起）→
 *   段 3 回合结束——pi 收尾链消费 steering 消息自动开新回合：B：条目 delivered +
 *   message.complete#2（新回合 assistant）；A：插话文本回流对话流（user 气泡）、
 *   队列行离场、旧回合转已工作 → 段 4 负路径——空闲态直发：lane='direct'，无队列行。
 *
 * 不在本剧本（impl-plan A1 拆行）：收起动画与计时视觉形态（A1b，L4 人工）；
 * Alt+Enter followUp 分流（线上与 Enter 不可区分，chat.steer Gotcha 3）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 长回合正文（~500 字符；与哨兵区分，结尾带可等哨兵） */
const LONG_TEXT = [
  '长回合流式演示正文。这段文字的唯一作用是被 faux 按 3-5 字符切块、以每秒若干块的速度',
  '逐字吐出，从而把一个 assistant 回合拉长到二十秒量级，给插话与队列观察留出确定窗口。',
  '内容本身无意义，验收断言只看计时与队列形态。'.repeat(6),
  '流水继续填充段落以保证窗口长度：观测者在此期间应看到回合保持工作态、计时持续增长。',
  'TURN1-STREAM-END',
].join('')

export const meta = {
  id: 'p1-turn-interject-collapse',
  priority: 'P1',
  title: '回合中插话：lane=steer 入队可见 + 工作回合不收起计时增长 + 回合结束队列回流自动开新回合 + 空闲直发负路径',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.stream', 'chat.wait', 'chat.steer', 'session.history',
  ],
  requires: ['faux'],
  estimateSec: 180,
  faux: {
    responses: [
      // 轮 1：长正文（TPS=6 限速 ≈ 20s 流式窗口）
      { text: LONG_TEXT, stopReason: 'stop' },
      // 轮 2：插话回流后的新回合回复
      { text: '收到插话，INTERJECT-ACK-7c2f，继续处理。', stopReason: 'stop' },
      // 轮 3：负路径空闲直发的回复
      { text: '空闲直发已受理，DIRECT-ACK-31d9。', stopReason: 'stop' },
    ],
    tps: 6,
  },
  provable: [
    'A：长回合进行中 turn-meta 为工作中（工作回合未收起），elapsed 计时秒级增长',
    'B：回合中插话 delivery.submit 回执 lane=steer，session.delivery 帧出现该条目（state queued|in-flight）',
    'A：插话后队列区渲染该条目行（queue-item-<clientUuid>），当前回合仍工作中不收起（D2）',
    'B：回合结束后条目转 delivered，pi 自动续跑开新回合（message.complete 第二次到达）',
    'A：插话文本回流对话流（user 气泡出现），队列行离场，旧回合转已工作',
    'B：负路径——空闲态（occupancy idle 帧观察到）直发回执 lane=direct，不经队列',
  ],
  notProvable: [
    '收起/展开动画与计时视觉形态（impl-plan A1b，L4 人工检查；本剧本只断状态字与计时数值变化）',
    'Alt+Enter followUp 车道分流语义（delivery.submit payload 无 intent 字段，线上与 Enter 痕迹相同——chat.steer Gotcha 3）',
    '工具间隙注入形态（faux 长回合无工具调用，插话实际在回合收尾链被消费；工具间隙注入归 p1-tool-call-render 族）',
    '插话文本被模型采纳（faux 不读上下文，只能证明投递与历史落位）',
  ],
}

/** 条件轮询 body innerHTML 直到谓词命中（禁固定 sleep）。超时返回最后内容供断言诊断。 */
async function pollBodyHtml(ui, predicate, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = ''
  while (Date.now() < deadline) {
    html = await ui.html('css=body')
    if (predicate(html)) return html
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return html
}

/** 条件轮询 turn-meta-0 的 HTML 直到变化（计时增长判据：工作态下秒级 tick 必然改写 elapsed；
 *  读 innerHTML 而非 innerText——虚拟列表可视窗口裁剪下 innerText 对裁剪元素返回空）。 */
async function pollTurnMetaChange(ui, first, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = first
  while (Date.now() < deadline) {
    try {
      html = await ui.html('testid=turn-meta-0')
    } catch {
      /* 元素瞬时未挂载：保留上次采样继续轮询 */
    }
    if (html !== first) return { changed: true, html }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { changed: false, html }
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const ui = ctx.ui
  const uncovered = []
  const gotchas = [
    '队列区行 = 非 direct 且未 delivered 条目（QueueBubble 单一数据源 session.delivery 帧）；steer 条目送达即离场，断言要抓流式窗口内',
    '协议建 session 不改变 renderer 激活态：A 断言前必须点侧栏会话行激活（css=.session-item）',
    '插话文本在队列行 preview 中也出现——「回流对话流」断言必须以队列行已离场为前置（先 expectGone 再查 body html），否则双匹配',
    'elapsed 计时 tick 依赖 document 可见（useTurnElapsed visibilitychange 停表）——TAIJI_DEV_BACKGROUND=1 的 showInactive 窗口仍算 visible，实测可观测增长',
  ]
  const INTERJECT = '插话内容-INTERJECT-91ab-请不打断当前回合'

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-turn-interject-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    // ── 段 0：建会话 + UI 激活 ──────────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'p1-turn-interject' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.assert('A: 侧栏会话行可点（激活链）', true, { channel: 'A', expected: '会话行出现', actual: '点击成功' })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：长回合进行中（工作态 + 计时增长） ─────────────
    const since1 = protocol.events.length
    const send1 = await protocol.send(sid, '开始长回合演示 TURN1-START')
    ev.step({ step: 'chat.send.turn1', channel: 'B', exitCode: 0, stats: { clientUuid: send1.clientUuid } })

    // 等回合进入工作态：turn-meta 首行渲染且状态字=工作中（assistant 已到仍生成）
    const workingHtml = await pollBodyHtml(ui, (h) => h.includes('工作中'), { timeoutMs: 40_000 })
    const workingSeen = workingHtml.includes('工作中')
    ev.assert('A: 回合进行中 turn-meta 工作中（未收起）', workingSeen, {
      channel: 'A',
      expected: 'body html 含「工作中」',
      actual: `hit=${workingSeen} len=${workingHtml.length}`,
    })
    await ev.shot(await ctx.instance.page(), 'turn1-working')

    // 计时增长：采样 turn-meta-0 HTML 并条件等待其变化（秒级 tick 必改写 elapsed）
    const metaFirst = await ui.html('testid=turn-meta-0')
    const { changed, html: metaSecond } = await pollTurnMetaChange(ui, metaFirst)
    ev.assert('A: elapsed 计时持续增长（两次采样文本变化）', changed, {
      channel: 'A',
      expected: 'turn-meta-0 内容随秒级 tick 改变',
      actual: `first="${metaFirst.slice(0, 120)}" second="${metaSecond.slice(0, 120)}"`,
    })

    // ── 段 2：回合中插话（steer 车道 + 队列可见 + 不收起） ──
    const sinceSubmit = protocol.events.length
    const interject = await protocol.send(sid, INTERJECT)
    const reply = interject.reply ?? {}
    ev.assert('B: 插话回执 lane=steer（活跃回合判定命中）', reply.lane === 'steer', {
      channel: 'B',
      expected: "lane='steer'",
      actual: `lane=${String(reply.lane)} state=${String(reply.state)}`,
    })
    ev.assert('B: 插话条目态 ∈ {queued, in-flight}（未直达）', reply.state === 'queued' || reply.state === 'in-flight', {
      channel: 'B',
      expected: 'queued | in-flight',
      actual: String(reply.state),
    })
    ev.step({
      step: 'chat.steer.submit',
      channel: 'B',
      exitCode: reply.lane === 'steer' ? 0 : 1,
      stats: { clientUuid: interject.clientUuid, lane: reply.lane, state: reply.state },
    })

    // B：session.delivery 帧出现该条目（条件等待，帧经内核派生视图广播）
    let deliveryEntry = null
    try {
      const frameEvt = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => x.clientUuid === interject.clientUuid),
        { timeoutMs: 15_000, since: sinceSubmit, sessionId: sid },
      )
      deliveryEntry = (frameEvt.payload.entries ?? []).find((x) => x.clientUuid === interject.clientUuid)
    } catch (e) {
      ev.attach('delivery-frame-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: session.delivery 帧含插话条目（lane=steer）', deliveryEntry?.lane === 'steer', {
      channel: 'B',
      expected: '{clientUuid, lane:steer, state:queued|in-flight}',
      actual: deliveryEntry ? JSON.stringify(deliveryEntry) : '未等到帧',
    })

    // A：队列区行可见（queue-item-<clientUuid>）且当前回合仍工作中
    const queueHtml = await pollBodyHtml(ui, (h) => h.includes(`queue-item-${interject.clientUuid}`), { timeoutMs: 15_000 })
    const queueRowSeen = queueHtml.includes(`queue-item-${interject.clientUuid}`)
    ev.assert('A: 队列区渲染插话条目行（排队态可见）', queueRowSeen, {
      channel: 'A',
      expected: `queue-item-${interject.clientUuid} 出现`,
      actual: `hit=${queueRowSeen}`,
    })
    const stillWorkingHtml = queueRowSeen ? queueHtml : await ui.html('css=body')
    ev.assert('A: 插话后当前回合仍工作中（D2 不收起）', stillWorkingHtml.includes('工作中') && !stillWorkingHtml.includes('已工作'), {
      channel: 'A',
      expected: '工作中 在场 / 已工作 不在场',
      actual: `working=${stillWorkingHtml.includes('工作中')} worked=${stillWorkingHtml.includes('已工作')}`,
    })
    await ev.shot(await ctx.instance.page(), 'interject-queued-working')

    // ── 段 3：回合结束 → 队列回流自动开新回合 ───────────────
    const end1 = await protocol.waitTurnEnd(sid, { since: since1, timeoutMs: 120_000 })
    ev.assert('B: 长回合正常收尾（message.complete）', end1.type === 'message.complete' && end1.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.wait.turn1', channel: 'B', exitCode: end1.ok ? 0 : 1, stats: { stopReason: end1.payload?.stopReason ?? null } })

    // 回流：插话被 pi 收尾链消费 → user entry 落 transcript → 条目 delivered → 新回合 assistant
    // 新回合 complete（faux 轮 2）
    const sinceAfter1 = protocol.events.length
    let end2 = null
    try {
      end2 = await protocol.waitTurnEnd(sid, { since: sinceAfter1, timeoutMs: 60_000 })
    } catch (e) {
      ev.attach('turn2-end-miss', String(e?.message ?? e).slice(0, 800))
    }
    ev.assert('B: 队列回流自动开新回合（第二次 message.complete）', end2?.type === 'message.complete' && end2.ok, {
      channel: 'B',
      expected: '插话消费后新 assistant 轮完成',
      actual: end2 ? `${end2.type} stop=${end2.payload?.stopReason ?? 'n/a'}` : '未等到第二次 complete',
    })

    // B：条目终态 delivered（session.delivery 帧条件等待）
    let deliveredOk = false
    try {
      const frameEvt = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => x.clientUuid === interject.clientUuid && x.state === 'delivered'),
        { timeoutMs: 15_000, sessionId: sid },
      )
      deliveredOk = Boolean(frameEvt)
    } catch (e) {
      ev.attach('delivery-delivered-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 插话条目终态 delivered（不丢）', deliveredOk, {
      channel: 'B',
      expected: "session.delivery 条目 state='delivered'",
      actual: `delivered=${deliveredOk}`,
    })

    // A：队列行离场后插话文本回流对话流（先等行离场防 preview 双匹配）
    try {
      await ui.expectGone(`testid=queue-item-${interject.clientUuid}`, { timeoutMs: 15_000 })
      ev.assert('A: 队列行离场（条目送达）', true, { channel: 'A', expected: 'queue-item 移除', actual: 'detached' })
    } catch (e) {
      ev.assert('A: 队列行离场（条目送达）', false, {
        channel: 'A', expected: 'queue-item 移除', actual: String(e?.message ?? e).slice(0, 300),
      })
    }
    const flowHtml = await pollBodyHtml(ui, (h) => h.includes('INTERJECT-91ab'), { timeoutMs: 20_000 })
    ev.assert('A: 插话文本回流对话流（user 气泡）', flowHtml.includes('INTERJECT-91ab'), {
      channel: 'A',
      expected: 'body html 含插话哨兵',
      actual: `hit=${flowHtml.includes('INTERJECT-91ab')}`,
    })
    const turnCount = (flowHtml.match(/data-testid="turn-\d+"/g) ?? []).length
    ev.assert('A: 对话流回流后回合数 ≥2（原回合 + 插话新回合）', turnCount >= 2, {
      channel: 'A',
      expected: '≥2 个 turn 容器',
      actual: `turns=${turnCount}`,
    })
    // 旧回合转已工作（完成态收起 = 派生态；此处回合均已结束）
    const doneHtml = await pollBodyHtml(ui, (h) => h.includes('已工作'), { timeoutMs: 15_000 })
    ev.assert('A: 回合完成态渲染（已工作 + 计时定格）', doneHtml.includes('已工作'), {
      channel: 'A',
      expected: '已工作 状态字出现',
      actual: `hit=${doneHtml.includes('已工作')}`,
    })
    await ev.shot(await ctx.instance.page(), 'after-backfill-done')

    // B：history 双向对账（插话以 user 消息在册 + 新回合 assistant 回复在册）
    const hist = await protocol.history(sid, { limitTurns: 10 })
    const histText = JSON.stringify(hist.messages ?? [])
    ev.assert('B: history 含插话 user 消息与新回合回复', histText.includes('INTERJECT-91ab') && histText.includes('INTERJECT-ACK-7c2f'), {
      channel: 'B',
      expected: '插话原文 + 回复哨兵均在 history',
      actual: `interject=${histText.includes('INTERJECT-91ab')} ack=${histText.includes('INTERJECT-ACK-7c2f')}`,
    })

    // ── 段 4：负路径——空闲态直发不排队（原 A6） ────────────
    let idleSeen = false
    try {
      await protocol.waitFor(
        (e) => e.type === 'session.occupancy' && e.payload?.turn === 'idle',
        { timeoutMs: 30_000, sessionId: sid },
      )
      idleSeen = true
    } catch (e) {
      ev.attach('idle-frame-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 空闲态观察到（occupancy turn=idle 帧）', idleSeen, {
      channel: 'B', expected: "session.occupancy {turn:'idle'}", actual: `idle=${idleSeen}`,
    })

    const sinceNeg = protocol.events.length
    const direct = await protocol.send(sid, '空闲直发验证 DIRECT-SEND-44e0')
    const dReply = direct.reply ?? {}
    ev.assert('B: 空闲直发回执 lane=direct（不排队）', dReply.lane === 'direct', {
      channel: 'B',
      expected: "lane='direct'",
      actual: `lane=${String(dReply.lane)} state=${String(dReply.state)}`,
    })
    // A：无队列行（direct 条目不进队列区）
    const negHtml = await ui.html('css=body')
    const queueBubbleCount = (negHtml.match(/data-testid="queue-bubble"/g) ?? []).length
    ev.assert('A: 直发不经队列区（queue-bubble 不渲染）', queueBubbleCount === 0, {
      channel: 'A',
      expected: 'queue-bubble 计数 0',
      actual: `count=${queueBubbleCount}`,
    })
    const end3 = await protocol.waitTurnEnd(sid, { since: sinceNeg, timeoutMs: 60_000 })
    ev.assert('B: 直发回合正常完成（DIRECT-ACK）', end3.type === 'message.complete' && end3.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end3.type} stop=${end3.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.send.direct', channel: 'B', exitCode: dReply.lane === 'direct' && end3.ok ? 0 : 1, stats: { lane: dReply.lane } })

    log(`done sid=${sid} interjectUuid=${interject.clientUuid}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
