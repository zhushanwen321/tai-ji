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
 *   段 3 回合结束——pi 在同一 run 内消费 steering 消息自动开新回合（2026-10-24 实测：
 *   message_start#2 先于 run 级 complete 到达，一个 run 只发一次 complete）：B：条目
 *   delivered + 第二个 assistant message_start；A：插话文本回流对话流（user 气泡）、
 *   队列行离场、旧回合转已工作 → 段 4 负路径——空闲态直发：lane='direct'，无队列行。
 *
 * 不在本剧本（impl-plan A1 拆行）：收起动画与计时视觉形态（A1b，L4 人工）；
 * Alt+Enter followUp 分流（线上与 Enter 不可区分，chat.steer Gotcha 3）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 长回合正文（~750 字符；faux 3-5 字符/chunk、TPS=6 限速 → ≈30s 流式窗口，
 *  覆盖段 1/段 2 全部中途态断言的轮询预算） */
const LONG_TEXT = [
  '长回合流式演示正文。这段文字的唯一作用是被 faux 按 3-5 字符切块、以每秒若干块的速度',
  '逐字吐出，从而把一个 assistant 回合拉长到半分钟量级，给插话与队列观察留出确定窗口。',
  '内容本身无意义，验收断言只看计时与队列形态。'.repeat(16),
  '流水继续填充段落以保证窗口长度：观测者在此期间应看到回合保持工作态、计时持续增长、',
  '队列区出现插话条目行，而当前回合不因插话提前收起。'.repeat(6),
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
    'B：回合结束后条目转 delivered，pi 自动续跑开新回合（第二个 assistant message_start——同一 run 内回流，一个 run 一次 complete，2026-10-24 实测校准）',
    'A：插话文本回流对话流（user 气泡出现），队列行离场，旧回合转已工作',
    'B：负路径——空闲态（occupancy idle 帧观察到）直发回执 lane=direct，不经队列',
  ],
  notProvable: [
    '收起/展开动画与计时视觉形态（impl-plan A1b，L4 人工检查；本剧本只断状态字与计时数值变化）',
    'Alt+Enter followUp 投递路径分流语义（delivery.submit payload 无 intent 字段，线上与 Enter 痕迹相同——chat.steer Gotcha 3）',
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

/** 协议等待失败的完整证据（ProtocolError 的 evidence 含 recentFrames 摘要，只 attach
 *  message 会丢——区分「慢」与「死」的关键信息）。 */
function waitErrorDetail(e) {
  return JSON.stringify(
    { message: String(e?.message ?? e), hint: e?.hint, evidence: e?.evidence },
    null,
    2,
  ).slice(0, 4_000)
}

/** 事件时间线附件（type@时刻 + 关键载荷摘要）——失败归因与「有没有第二个回合」判定的
 *  直接证据；逐帧 dump 会超长，摘要按 type 分桶计数 + 端到端关键帧逐条列。 */
function attachTimeline(ev, protocol, sid, name) {
  const byType = new Map()
  const keyFrames = []
  for (const e of protocol.events) {
    const t = e.type
    byType.set(t, (byType.get(t) ?? 0) + 1)
    if (
      t === 'message.complete' || t === 'message.error' || t === 'message.message_start'
      || (t === 'session.occupancy') || t === 'session.exited' || t === 'session.deliveryHandled'
    ) {
      const brief =
        t === 'message.complete'
          ? `stop=${String(e.payload?.stopReason)} retry=${String(e.payload?.willRetry)}`
          : t === 'session.occupancy'
            ? `turn=${String(e.payload?.turn)}`
            : t === 'message.message_start'
              ? `mid=${String(e.payload?.messageId)}`
              : ''
      keyFrames.push(`${t}@${new Date(e.receivedAt).toISOString().slice(11, 23)} ${brief} sid=${e.payload?.sessionId === sid ? 'match' : String(e.payload?.sessionId ?? '-')}`)
    }
    if (t === 'session.delivery') {
      keyFrames.push(
        `session.delivery@${new Date(e.receivedAt).toISOString().slice(11, 23)} entries=${JSON.stringify(e.payload?.entries ?? [])}`,
      )
    }
  }
  ev.attach(
    name,
    `frames total=${protocol.events.length}\nbyType: ${JSON.stringify(Object.fromEntries(byType))}\n\nkey frames:\n${keyFrames.join('\n')}`.slice(0, 30_000),
  )
}

/** 条件轮询首回合 turn-meta 的 HTML 直到变化（计时增长判据：工作态下秒级 tick 必然改写
 *  elapsed；读 innerHTML 而非 innerText——虚拟列表可视窗口裁剪下 innerText 对裁剪元素返回空。
 *  turn 索引 1-based（message-turns.ts index: i + 1），首回合 = turn-meta-1）。 */
async function pollTurnMetaChange(ui, first, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let html = first
  while (Date.now() < deadline) {
    try {
      html = await ui.html('testid=turn-meta-1')
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
    'session.delivery topic 接线时序坑（2026-10-24 实测）：topic 唯一装配点 = session.subscribe，且以非创建性 getDelivery 解析句柄——建会即订阅的会话在首次 submit 前无内核运行时，onChange 永不挂、整会话零 session.delivery 帧；首次 submit 后补一次 subscribe 重跑 sync 即接线（等价「切走再切回」用户路径）。产品侧 wiring 瑕疵已报 productSuspicions',
    'steer 消费形态（2026-10-24 实测）：pi 在同一 run 内消费 steering 消息——第二个 assistant message_start 先于 run 级 message.complete 到达；一个 run 只发一次 complete，「等第二次 complete」断言必假失败',
    'turn 索引 1-based（message-turns.ts index: i + 1）：首回合是 turn-1/turn-meta-1，不是 turn-0',
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

    // session.delivery topic 接线前置：topic 唯一装配点 = session.subscribe，且以非创建性
    // getDelivery 解析句柄（session-delivery-topic.ts resolveHandle）——本会话建会即订阅
    //（无投递运行时 → sync 早退、onChange 未挂）；首次 submit 已创建内核运行时，这里补一次
    // subscribe 重跑 sync 完成接线（此后 onChange → session.delivery 帧对全部订阅者广播）。
    // 该缺口是产品侧 wiring 瑕疵（详见 report productSuspicions），此处按「切走再切回」的
    // 等价用户路径走通主链。
    await protocol.subscribe(sid)
    ev.step({ step: 'protocol.resubscribe', channel: 'B', exitCode: 0, stats: { purpose: 'delivery-topic wiring' } })

    // 等回合进入工作态：turn-meta 首行渲染且状态字=工作中（assistant 已到仍生成）
    const workingHtml = await pollBodyHtml(ui, (h) => h.includes('>工作中<'), { timeoutMs: 40_000 })
    const workingSeen = workingHtml.includes('工作中')
    ev.assert('A: 回合进行中 turn-meta 工作中（未收起）', workingSeen, {
      channel: 'A',
      expected: 'body html 含渲染标签 >工作中<（dev 模板注释含「已工作」字样，裸 substring 会误报）',
      actual: `hit=${workingSeen} len=${workingHtml.length}`,
    })
    await ev.shot(await ctx.instance.page(), 'turn1-working')

    // 计时增长：采样首回合 turn-meta（索引 1-based）HTML 并条件等待其变化（秒级 tick 必改写 elapsed）
    const metaFirst = await ui.html('testid=turn-meta-1')
    const { changed, html: metaSecond } = await pollTurnMetaChange(ui, metaFirst)
    ev.assert('A: elapsed 计时持续增长（两次采样文本变化）', changed, {
      channel: 'A',
      expected: 'turn-meta-1 内容随秒级 tick 改变',
      actual: `first="${metaFirst.slice(0, 120)}" second="${metaSecond.slice(0, 120)}"`,
    })

    // ── 段 2：回合中插话（steer 投递路径 + 队列可见 + 不收起） ──
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
      ev.attach('delivery-frame-miss', waitErrorDetail(e))
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
    // 状态字断言锚定「渲染标签形态」（>工作中<）：dev 模式 DOM 保留组件模板注释，
    // TurnMeta 注释正文提及「已工作」，裸 substring 判定恒误报（2026-10-24 实测）
    const stillWorkingHtml = queueRowSeen ? queueHtml : await ui.html('css=body')
    const swWorking = stillWorkingHtml.includes('>工作中<')
    const swWorked = stillWorkingHtml.includes('>已工作<')
    ev.assert('A: 插话后当前回合仍工作中（D2 不收起）', swWorking && !swWorked, {
      channel: 'A',
      expected: '>工作中< 在场 / >已工作< 不在场',
      actual: `working=${swWorking} worked=${swWorked}`,
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

    // 回流形态（2026-10-24 实测校准）：插话被 pi 在同一 run 内消费（message_start#2 先于
    // run 级 message.complete 到达——一个 run 只发一次 complete，不按 LLM 调用拆分）。
    // 「自动开新回合」的 B 信号 = 第二个 assistant message_start（承载插话 user 消息后的
    // 新 assistant 轮）+ 条目 delivered + history 落位，而非第二次 complete。
    let startCount = 0
    let secondStart = null
    try {
      // 自 turn1 发送起数第二个 message_start（第一个 = 长回合同轮起点）
      for (const e of protocol.events) {
        if (e.type === 'message.message_start' && e.payload?.sessionId === sid) startCount += 1
      }
      if (startCount >= 2) {
        secondStart = protocol.events.filter((e) => e.type === 'message.message_start' && e.payload?.sessionId === sid)[1] ?? null
      } else {
        secondStart = await protocol.waitFor(
          (e) => {
            const n = protocol.events.filter((x) => x.type === 'message.message_start' && x.payload?.sessionId === sid).length
            return e.type === 'message.message_start' && n >= 2
          },
          { timeoutMs: 30_000, since: protocol.events.length, sessionId: sid },
        )
      }
    } catch (e) {
      ev.attach('turn2-start-miss', waitErrorDetail(e))
    }
    ev.assert('B: 队列回流自动开新回合（第二个 assistant message_start）', Boolean(secondStart), {
      channel: 'B',
      expected: '插话消费后新 assistant 轮启动（无需再发消息触发）',
      actual: secondStart ? `at=${new Date(secondStart.receivedAt).toISOString()}` : '未等到第二个 message_start',
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
      ev.attach('delivery-delivered-miss', waitErrorDetail(e))
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
    const doneHtml = await pollBodyHtml(ui, (h) => h.includes('>已工作<'), { timeoutMs: 15_000 })
    ev.assert('A: 回合完成态渲染（已工作 + 计时定格）', doneHtml.includes('>已工作<'), {
      channel: 'A',
      expected: '>已工作< 渲染标签出现',
      actual: `hit=${doneHtml.includes('>已工作<')}`,
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
    // 事件时间线（在负路径改变事件流前落盘：插话消费/二次回合/帧全貌的归因证据）
    attachTimeline(ev, protocol, sid, 'event-timeline-before-negative')
    let idleSeen = false
    try {
      await protocol.waitFor(
        (e) => e.type === 'session.occupancy' && e.payload?.turn === 'idle',
        { timeoutMs: 30_000, sessionId: sid },
      )
      idleSeen = true
    } catch (e) {
      ev.attach('idle-frame-miss', waitErrorDetail(e))
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
