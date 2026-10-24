/**
 * p1-settling-steer-delivery —— 回合结束瞬间追问（settling 窗口投递路径，
 * chat-flow-consistency 验收计划表 L3 行 A2；设计 §3.3 D1「回合进行中」判定集合含 settling）。
 *
 * 装配：faux（TPS=6 拉长回合）+ 产品侧 dev-only chaos 开关
 * TAIJI_AGENT_DEV_SETTLING_DELAY_MS=2500（event-interpreter-settled-delay.ts：agent_settled
 * 延迟处理，occupancy settling→idle 转移随之延迟——时间维度延迟注入，pi 交互全真，非 mock）。
 * 该开关正是产品为「settling 窗口的正向验收场景」提供的验收基建（探针 P1 结论 S2：faux 下
 * 真实沉降链微任务级完成，外部进程抢时机追不上窗口；确定性命中需拉宽窗口）。
 *
 * 路径：
 *   段 1 长回合——B：occupancy generating 帧观察到 → 段 2 窗口捕捉——
 *   waitTurnEnd（message.complete）返回后立即 delivery.submit 追问：
 *   B：回执 lane='steer'（settling ∈ ACTIVE_TURN_PHASES，session-delivery-registry
 *   laneOf 单点判定）+ 事件流中 session.occupancy turn='settling' 帧在场 →
 *   A：队列区渲染追问条目行（排队态可见，不直进气泡）→
 *   段 3 受理与回流——B：条目 delivered + 新回合 message.complete 到达 +
 *   新回合受理先于 idle 宣告（message_start#2 早于首个 idle occupancy 帧——
 *   「不等待空闲宣告、不排长队」的时序事实）+ 末次 idle 落定 →
 *   A：追问文本回流对话流。
 *
 * 时序口径声明：窗口 = taiji occupancy 侧 settling 段（message.complete 帧到达 → 延迟的
 * idle 转移执行）。pi 侧内部沉降在 faux 下微任务级完成（探针 P1 S2），disposition 形态
 * 为 started——受理语义（开新回合）与 queued 等价（探针 P1 已实证三路径全受理）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 回合一正文（~420 字符，TPS=6 限速 ≈ 17s 流式窗口） */
const LONG_TEXT = [
  'settling 窗口验收的长回合正文。文字被 faux 逐块限速吐出，把回合拉长到十余秒，',
  '让 complete 到达后的追问窗口可观测。内容无意义，断言只看投递判定与受理时序。'.repeat(6),
  'SETTLING-STREAM-END',
].join('')

/** agent_settled 延迟量（ms）：拉宽 taiji 侧 settling 窗口到人类可打的时序（提交在
 *  complete 后毫秒级发出，窗口 2.5s 覆盖两个数量级余量）。 */
const SETTLING_DELAY_MS = '2500'

export const meta = {
  id: 'p1-settling-steer-delivery',
  priority: 'P1',
  title: 'settling 窗口追问：lane=steer 受理 + 不等空闲宣告自动开新回合 + 不丢不挂起',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.steer', 'chat.wait', 'session.history',
  ],
  requires: ['faux'],
  estimateSec: 150,
  env: {
    // 产品侧 dev-only 验收基建（event-interpreter-settled-delay）：延迟 agent_settled
    // 处理 → occupancy 保持 settling，窗口可确定性命中。真实链路全真，仅时间维度拉宽。
    TAIJI_AGENT_DEV_SETTLING_DELAY_MS: SETTLING_DELAY_MS,
  },
  faux: {
    responses: [
      // 回合一：长正文
      { text: LONG_TEXT, stopReason: 'stop' },
      // 回合二：settling 追问回流后的新回合回复
      { text: '追问已在新回合受理，SETTLING-ACK-5d81。', stopReason: 'stop' },
    ],
    tps: 6,
  },
  provable: [
    'B：长回合 occupancy generating 帧观察到（相位链起点）',
    'B：message.complete 后立即追问，回执 lane=steer（settling 纳入「回合进行中」判定集合——session-delivery-registry laneOf 经 ACTIVE_TURN_PHASES 单点生效）',
    'B：事件流中 session.occupancy turn=settling 帧在场（窗口真实性证据，非仅靠回执反推）',
    'A：追问在队列区渲染为条目行（排队态可见，未直接变对话流气泡）',
    'B：条目终态 delivered + 新回合 message.complete 到达（受理为开新回合，不丢）',
    'B：新回合 message_start 先于窗口后的首个 occupancy idle 帧（受理不等空闲宣告 = 即时性时序事实）',
    'B：末次 occupancy idle 落定（延迟注入不破坏终态收敛）',
  ],
  notProvable: [
    'pi 侧 disposition=queued/deferred 两条受理路径的逐路径形态（探针 P1 S3/S4 已实证；本剧本在协议/UI 层固化，faux 下窗口内 pi 已内部沉降、disposition 恒为 started）',
    '真 LLM 慢沉降链下的自然窗口宽度（本剧本用产品 dev 开关确定性拉宽；真实链路定性见探针 P1 边界声明）',
    '追问文本被模型采纳（faux 不读上下文）',
  ],
}

/** 条件轮询 body innerHTML 直到谓词命中（禁固定 sleep）。 */
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

/** 事件流中按条件找帧（已在队列中的历史帧，非等待）。 */
function findEvent(protocol, predicate, { since = 0 } = {}) {
  for (let i = protocol.events.length - 1; i >= since; i--) {
    const e = protocol.events[i]
    if (predicate(e)) return e
  }
  return null
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const ui = ctx.ui
  const uncovered = []
  const gotchas = [
    '窗口确定性来源 = 产品 dev 开关 TAIJI_AGENT_DEV_SETTLING_DELAY_MS（延迟 agent_settled 处理）；不设开关时 faux 沉降链微任务级完成，外部进程抢时机基本落在 idle 后（探针 P1 S2 实测）',
    'TAIJI_AGENT_DEV_SETTLING_DELAY_MS 经 TAIJI_ 前缀 env 白名单透传 main→runtime（shared/constants.ts ENV_WHITELIST_PREFIXES），无需额外接线',
    '延迟窗口副作用：新回合已 generating 时首个（陈旧的）idle 帧可能随后到达——时序断言只比 message_start#2 与首个 idle 帧先后，终态断言等末次 idle',
    '追问文本在队列行 preview 中也出现——回流断言以队列行离场为前置（先 expectGone 再查 body html），防双匹配',
  ]
  const FOLLOWUP = '回合结束瞬间追问-SETTLING-FOLLOWUP-2a4c'

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-settling-steer-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    // ── 段 0：建会话 + UI 激活 ──────────────────────────────
    const created = await protocol.call('session.create', { cwd, label: 'p1-settling-steer' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.assert('A: 侧栏会话行可点（激活链）', true, { channel: 'A', expected: '会话行出现', actual: '点击成功' })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 段 1：长回合（occupancy generating 观察） ───────────
    const since1 = protocol.events.length
    await protocol.send(sid, '开始长回合 SETTLING-START')
    let generatingSeen = false
    try {
      await protocol.waitFor(
        (e) => e.type === 'session.occupancy' && e.payload?.turn === 'generating',
        { timeoutMs: 60_000, since: since1, sessionId: sid },
      )
      generatingSeen = true
    } catch (e) {
      ev.attach('generating-frame-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 长回合 occupancy generating 帧观察到', generatingSeen, {
      channel: 'B', expected: "session.occupancy {turn:'generating'}", actual: `seen=${generatingSeen}`,
    })

    // ── 段 2：捕捉窗口——complete 后立即追问 ────────────────
    const end1 = await protocol.waitTurnEnd(sid, { since: since1, timeoutMs: 120_000 })
    ev.assert('B: 长回合正常收尾（message.complete）', end1.type === 'message.complete' && end1.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end1.type} stop=${end1.payload?.stopReason ?? 'n/a'}`,
    })
    const completeAt = end1.at

    // 立即追问（waitTurnEnd 返回即发——窗口 = complete 帧到达 → 延迟 idle 执行，2.5s 余量）
    const followup = await protocol.send(sid, FOLLOWUP)
    const fReply = followup.reply ?? {}
    const submitAt = Date.now()
    ev.assert('B: settling 窗口追问回执 lane=steer', fReply.lane === 'steer', {
      channel: 'B',
      expected: "lane='steer'（settling ∈ ACTIVE_TURN_PHASES）",
      actual: `lane=${String(fReply.lane)} state=${String(fReply.state)} complete→submit=${submitAt - completeAt}ms`,
    })
    ev.assert('B: 追问条目态 ∈ {queued, in-flight}（非 direct 直达）', fReply.state === 'queued' || fReply.state === 'in-flight', {
      channel: 'B',
      expected: 'queued | in-flight',
      actual: String(fReply.state),
    })
    ev.step({
      step: 'chat.steer.settling-submit',
      channel: 'B',
      exitCode: fReply.lane === 'steer' ? 0 : 1,
      stats: { clientUuid: followup.clientUuid, lane: fReply.lane, state: fReply.state, sinceCompleteMs: submitAt - completeAt },
    })

    // B：settling 相位帧在场（窗口真实性——turn_end 在 agent_end 前已广播 settling）
    const settleFrame = findEvent(protocol, (e) => e.type === 'session.occupancy' && e.payload?.turn === 'settling')
    ev.assert('B: 事件流含 session.occupancy turn=settling 帧（窗口在场）', Boolean(settleFrame), {
      channel: 'B',
      expected: 'settling 帧先于追问回执',
      actual: settleFrame ? `at=${new Date(settleFrame.receivedAt).toISOString()} turn=${String(settleFrame.payload?.turn)}` : '未找到 settling 帧',
    })

    // A：追问进队列区（排队态可见，未直接变对话流气泡）
    const queueHtml = await pollBodyHtml(ui, (h) => h.includes(`queue-item-${followup.clientUuid}`), { timeoutMs: 10_000 })
    const queueRowSeen = queueHtml.includes(`queue-item-${followup.clientUuid}`)
    ev.assert('A: 追问在队列区渲染条目行（不直进气泡）', queueRowSeen, {
      channel: 'A',
      expected: `queue-item-${followup.clientUuid} 出现`,
      actual: `hit=${queueRowSeen}`,
    })
    await ev.shot(await ctx.instance.page(), 'settling-queued')

    // ── 段 3：受理与回流（不等空闲宣告） ────────────────────
    // 新回合 message_start：受理即开新回合的直接证据
    let start2 = null
    try {
      start2 = await protocol.waitFor(
        (e) => e.type === 'message.message_start',
        { timeoutMs: 30_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('turn2-start-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 追问受理即开新回合（message_start#2 到达）', Boolean(start2), {
      channel: 'B',
      expected: 'message.message_start（新 assistant）',
      actual: start2 ? `at=${new Date(start2.receivedAt).toISOString()} submit→start=${start2.receivedAt - submitAt}ms` : '未等到',
    })

    // 首个 idle 帧（= 被延迟的 settling→idle 转移）：受理必须先于它（不等空闲宣告）
    let idle1 = null
    try {
      idle1 = await protocol.waitFor(
        (e) => e.type === 'session.occupancy' && e.payload?.turn === 'idle',
        { timeoutMs: 30_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('idle-frame-miss', String(e?.message ?? e).slice(0, 500))
    }
    const acceptanceBeforeIdle = Boolean(start2 && idle1 && start2.receivedAt < idle1.receivedAt)
    ev.assert('B: 新回合受理先于空闲宣告（message_start#2 < 首个 idle 帧）', acceptanceBeforeIdle, {
      channel: 'B',
      expected: '受理不等 idle（即时性时序事实）',
      actual: `start2=${start2?.receivedAt ?? 'n/a'} idle=${idle1?.receivedAt ?? 'n/a'} before=${acceptanceBeforeIdle}`,
    })
    ev.attach(
      'settling-timeline',
      [
        `message.complete#1 at=${new Date(completeAt).toISOString()}`,
        `delivery.submit sent at=${new Date(submitAt).toISOString()} (+${submitAt - completeAt}ms)`,
        `reply lane=${String(fReply.lane)} state=${String(fReply.state)}`,
        `message_start#2 at=${start2 ? new Date(start2.receivedAt).toISOString() : 'n/a'} (+${start2 ? start2.receivedAt - submitAt : 'n/a'}ms)`,
        `first idle frame at=${idle1 ? new Date(idle1.receivedAt).toISOString() : 'n/a'} (delay=${SETTLING_DELAY_MS}ms)`,
      ].join('\n'),
    )

    // 新回合完成（faux 轮 2）
    const sinceAfterStart2 = protocol.events.length
    let end2 = null
    try {
      end2 = await protocol.waitTurnEnd(sid, { since: Math.max(0, sinceAfterStart2 - 1), timeoutMs: 60_000 })
    } catch (e) {
      ev.attach('turn2-end-miss', String(e?.message ?? e).slice(0, 800))
    }
    ev.assert('B: 新回合 message.complete 到达（受理闭环，不丢）', end2?.type === 'message.complete' && end2.ok, {
      channel: 'B',
      expected: '第二次 message.complete 非 error',
      actual: end2 ? `${end2.type} stop=${end2.payload?.stopReason ?? 'n/a'}` : '未等到',
    })

    // B：条目终态 delivered
    let deliveredOk = false
    try {
      const frameEvt = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => x.clientUuid === followup.clientUuid && x.state === 'delivered'),
        { timeoutMs: 15_000, sessionId: sid },
      )
      deliveredOk = Boolean(frameEvt)
    } catch (e) {
      ev.attach('delivery-delivered-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 追问条目终态 delivered', deliveredOk, {
      channel: 'B', expected: "state='delivered'", actual: `delivered=${deliveredOk}`,
    })

    // 末次 idle 落定：complete#2 之后的 idle 帧（回合二自身的延迟沉降）
    let finalIdle = null
    try {
      finalIdle = await protocol.waitFor(
        (e) => e.type === 'session.occupancy' && e.payload?.turn === 'idle' && e.receivedAt > (end2?.at ?? Date.now()),
        { timeoutMs: 30_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('final-idle-miss', String(e?.message ?? e).slice(0, 500))
    }
    ev.assert('B: 末次 occupancy idle 落定（延迟注入不破坏终态收敛）', Boolean(finalIdle), {
      channel: 'B', expected: 'complete#2 后 idle 帧', actual: finalIdle ? `at=${new Date(finalIdle.receivedAt).toISOString()}` : '未等到',
    })
    ev.step({ step: 'chat.wait.turn2', channel: 'B', exitCode: end2?.ok && finalIdle ? 0 : 1, stats: { idle: Boolean(finalIdle) } })

    // A：队列行离场后追问文本回流对话流
    try {
      await ui.expectGone(`testid=queue-item-${followup.clientUuid}`, { timeoutMs: 15_000 })
      ev.assert('A: 队列行离场（条目送达）', true, { channel: 'A', expected: 'queue-item 移除', actual: 'detached' })
    } catch (e) {
      ev.assert('A: 队列行离场（条目送达）', false, {
        channel: 'A', expected: 'queue-item 移除', actual: String(e?.message ?? e).slice(0, 300),
      })
    }
    const flowHtml = await pollBodyHtml(ui, (h) => h.includes('SETTLING-FOLLOWUP-2a4c'), { timeoutMs: 20_000 })
    ev.assert('A: 追问文本回流对话流（user 气泡）', flowHtml.includes('SETTLING-FOLLOWUP-2a4c'), {
      channel: 'A',
      expected: 'body html 含追问哨兵',
      actual: `hit=${flowHtml.includes('SETTLING-FOLLOWUP-2a4c')}`,
    })
    await ev.shot(await ctx.instance.page(), 'settling-backfilled')

    // B：history 对账（追问 user 消息 + 新回合回复）
    const hist = await protocol.history(sid, { limitTurns: 10 })
    const histText = JSON.stringify(hist.messages ?? [])
    ev.assert('B: history 含追问 user 消息与新回合回复', histText.includes('SETTLING-FOLLOWUP-2a4c') && histText.includes('SETTLING-ACK-5d81'), {
      channel: 'B',
      expected: '追问原文 + 回复哨兵均在 history',
      actual: `followup=${histText.includes('SETTLING-FOLLOWUP-2a4c')} ack=${histText.includes('SETTLING-ACK-5d81')}`,
    })

    log(`done sid=${sid} followupUuid=${followup.clientUuid} lane=${String(fReply.lane)}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
