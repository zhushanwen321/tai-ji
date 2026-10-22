/**
 * p0-interrupt-cancel —— 中断/取消双域：主会话 abort（mock-http 低速流拉窗）+
 * 执行域 subagent cancel（覆盖矩阵 P0-9；补剧本优先级 #6）。
 *
 * 装配：mock-http（主会话与孙进程都可达——主会话 abort 与 subagent cancel 需要同实例双域，
 * faux 通道孙进程不可达，故整体走 mock-http；tps=2 拉长成员与主会话流式窗口制造取消时机）。
 * 路径：
 *   段 1 执行域——主队 step0 派发 subagent（成员低速长文本）→ getSubagents running →
 *   session.subagentAction cancel → subagentActionDone 回执 → record 收敛（非 running）→
 *   C：mock.requests 出现成员模型请求（取消前成员真的跑到 LLM）。
 *   段 2 主会话——新 session 发消息（主队长文本低速）→ 等流式帧（message.text_delta）→
 *   message.abort → waitTurnEnd stopReason='aborted' → 再发一轮成功（isGenerating 复位）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MAIN_MODEL = 'mock-1'
const SUB_MODEL = 'mock-sub-a'
const LONG_TEXT = '这是一段用于拉长流式窗口的低速文本，验证中断语义。'.repeat(10)

export const meta = {
  id: 'p0-interrupt-cancel',
  priority: 'P0',
  title: '执行域 subagent cancel + 主会话 abort（stopReason=aborted + isGenerating 复位）',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait', 'chat.abort',
    'subagent.dispatch', 'subagent.cancel',
  ],
  requires: ['mock-http'],
  parallelGroup: 'subagent',
  estimateSec: 180,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: [
        {
          text: '派一个低速子任务：',
          toolCalls: [
            {
              name: 'subagent_start',
              args: { task: 'Slowly echo your scripted response.', slug: 'cancel-probe', model: `mockllm/${SUB_MODEL}`, fork: false },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: '子任务已派发（DISPATCHED-FOR-CANCEL）。', stopReason: 'stop' },
        { text: 'parent-notified', stopReason: 'stop' },
        { text: LONG_TEXT, stopReason: 'stop' },
        { text: 'abort 后的恢复轮（ABORT-RECOVERY-OK）。', stopReason: 'stop' },
        { text: 'parent-idle-1', stopReason: 'stop' },
      ],
      [`mockllm/${SUB_MODEL}`]: [
        { text: LONG_TEXT, stopReason: 'stop' },
        { text: `${LONG_TEXT}（第二段备用）`, stopReason: 'stop' },
      ],
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
    tps: 2,
  },
  provable: [
    '执行域：running record 被 session.subagentAction(cancel) 中断（stopReason=interrupted）——回执通道缺陷见 deviations',
    'C：取消前成员真的跑到 LLM（mock.requests 含 mock-sub-a 请求）',
    '主会话：流式进行中 message.abort 后 turn 以 message.complete + stopReason=aborted 收尾',
    '主会话：abort 后 isGenerating 复位（再发一轮正常完成；具体文本不定——成员完成通知轮会插队消费主队步）',
  ],
  notProvable: [
    'workflow.abort（run 级中止）：需要 running 的 workflow run，mock-http 下成员完成过快难以稳定制造窗口（见覆盖矩阵已知空洞 #7/#9）',
    '中止时 pi 侧已生成 token 的持久化细节（pi JSONL 的 aborted entry 形态属 pi 契约，本剧本以回执 stopReason 为准）',
    '两段式取消钮的 A 通道（tray-subagent-cancel → confirm）——托盘面板锚点依附运行记录，本剧本走协议',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const uncovered = []
  const gotchas = [
    'faux 与 mock-http 双域不能同实例（createInstance 互斥）：要同实例验「主会话 abort + 执行域 cancel」必须整体走 mock-http',
    'abort 的权威收尾 = pi agent_end 携带 stopReason=aborted → message.complete{stopReason:aborted}（event-adapter：aborted 不是 stream_error）',
    '执行域取消实现 = client.prompt("/subagents cancel <id> --req=<uuid>")（扩展命令，不经 LLM），回执经请求作用域结果文件；成功路径的回执写入有缺口（docs/todo/subagent-cancel-receipt-race.md），Done 回执可能缺失但取消效果已达成',
  ]

  // ── 段 1：执行域 cancel ─────────────────────────────────────
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-interrupt' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)

  const sinceD = protocol.events.length
  await protocol.send(sid, 'dispatch a slow subagent then continue')
  const endD = await protocol.waitTurnEnd(sid, { since: sinceD, timeoutMs: 180_000 })
  ev.assert('段 1：派发轮完成', endD.ok === true, {
    channel: 'B', expected: 'message.complete', actual: `${endD.type} stop=${endD.payload?.stopReason ?? ''}`,
  })

  // 等 running record（条件轮询）
  let record = null
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
      record = (reply.subagents ?? []).find((r) => r.slug === 'cancel-probe') ?? (reply.subagents ?? [])[0] ?? null
      if (record && String(record.status) === 'running') break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  ev.step({ step: 'subagent.observe', channel: 'B', exitCode: 0, stats: { status: record?.status, id: record?.id ?? record?.subagentId } })
  const subagentId = record?.id ?? record?.subagentId
  if (!record || !subagentId) {
    ev.attach('subagents-final', JSON.stringify(record ?? null).slice(0, 1_000))
    return { uncovered: ['执行域：未捕获 running record（成员过快收敛或派发失败），cancel 段未执行'], gotchas }
  }

  // C 通道：取消前成员真的打到 mock
  const childHits = (instance.mockLlm?.requests ?? []).filter((r) => r.model === SUB_MODEL)
  ev.assert('C: 取消前成员打到 mock（requests 含 mock-sub-a）', childHits.length > 0, {
    channel: 'C',
    expected: '≥1 × mock-sub-a',
    actual: `${childHits.length} 条`,
  })

  // cancel 前等 pi 空闲：主轮完成后的通知轮（triggerTurn）仍占 pi，斜杠命令会排队，
  // 60s RPC 窗口内回执可能来不及（handler_error「回执缺失」）
  {
    const deadline = Date.now() + 90_000
    let idle = false
    while (Date.now() < deadline) {
      const occ = [...protocol.events].reverse().find((e) => e.type === 'session.occupancy' && e.payload?.sessionId === sid)
      if (occ && occ.payload?.turn === 'idle') {
        idle = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('B: cancel 前 pi 空闲（occupancy idle）', idle, {
      channel: 'B',
      expected: '通知轮跑完、occupancy 回 idle',
      actual: idle ? 'idle' : '90s 未 idle（通知轮异常）',
    })
  }

  // cancel。实测形态分型（2026-10-22）：
  // - streaming 态 cancel → handler_error「subagent action result missing（回执缺失）」稳定复现
  //   （client.prompt 对 slash 命令回 disposition=started 异步返回，runtime 立即读结果文件，
  //   pi 侧命令 handler 未及写入 → 通道竞态，疑似产品缺陷，已记 deviations）；
  // - idle 态（成员自然收敛后）cancel → 回执通道正常（补验通道可用性）。
  // 两段都断言，verdict 按实测如实降级，不改断言凑绿。
  let cancelDefect = ''
  try {
    await protocol.call(
      'session.subagentAction',
      { sessionId: sid, action: 'cancel', subagentId },
      { replyType: 'session.subagentActionDone', timeoutMs: 60_000 },
    )
    ev.step({ step: 'subagent.cancel.streaming', channel: 'B', exitCode: 0, stats: { subagentId } })
  } catch (e) {
    cancelDefect = String(e?.message ?? e).slice(0, 300)
    ev.assert('B: streaming 态 cancel（回执通道）', false, {
      channel: 'B',
      expected: 'session.subagentActionDone 回执',
      actual: cancelDefect,
    })
    ev.step({ step: 'subagent.cancel.streaming', channel: 'B', exitCode: 1, stats: { defect: 'result-missing' } })
  }

  // 等 record 离开 running（cancel 生效或成员自然收敛）
  let cancelled = null
  {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const reply = await protocol.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
      cancelled = (reply.subagents ?? []).find((r) => (r.id ?? r.subagentId) === subagentId) ?? null
      const st = String(cancelled?.status ?? '')
      if (cancelled && st !== 'running') break
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: record 最终收敛（离开 running）', cancelled && String(cancelled.status) !== 'running', {
    channel: 'B',
    expected: 'status ∈ {cancelled, error, failed, done, idle, stopped}（非 running）',
    actual: `status=${cancelled?.status} stopReason=${cancelled?.stopReason ?? ''}`,
  })
  // 取消语义的直接证据：stopReason=interrupted（被中断而非自然跑完）
  ev.assert('B: 成员 stopReason=interrupted（取消语义达成）', String(cancelled?.stopReason ?? '') === 'interrupted', {
    channel: 'B',
    expected: 'stopReason=interrupted',
    actual: `stopReason=${cancelled?.stopReason ?? '<缺>'}（elapsed=${cancelled?.elapsedSeconds ?? '?'}s turns=${cancelled?.turns ?? '?'})`,
  })
  ev.attach('cancelled-record', JSON.stringify(cancelled ?? null).slice(0, 2_000))

  // idle 态补验：回执通道本身可用（非 streaming 场景）
  if (cancelDefect && cancelled) {
    try {
      await protocol.call(
        'session.subagentAction',
        { sessionId: sid, action: 'cancel', subagentId },
        { replyType: 'session.subagentActionDone', timeoutMs: 60_000 },
      )
      ev.step({ step: 'subagent.cancel.idle', channel: 'B', exitCode: 0, stats: { note: 'idle 态回执正常——通道可用，streaming 态竞态为缺陷' } })
    } catch (e) {
      // subagent_cancel_not_found（not found or already finished）= 第一次 cancel 已生效，
      // 是取消语义达成的旁证而非通道异常
      const err = String(e?.message ?? e)
      const benign = /subagent_cancel_not_found/.test(err)
      ev.step({
        step: 'subagent.cancel.idle', channel: 'B', exitCode: benign ? 0 : 1,
        stats: { note: benign ? 'already finished = 首次 cancel 已生效（旁证）' : err.slice(0, 200) },
      })
    }
  }

  // ── 段 2：主会话 abort ─────────────────────────────────────
  const sinceA = protocol.events.length
  await protocol.send(sid, '低速长文本，发完就中止')
  // 等流式开始（B 通道流式帧；abort 时机窗口由 tps=2 保证）
  let streaming = false
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (protocol.events.slice(sinceA).some((e) => /text_delta|message_update/.test(e.type))) {
        streaming = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  ev.assert('B: 主会话流式开始（text_delta 帧）', streaming, {
    channel: 'B',
    expected: '流式帧到达（tps=2 窗口）',
    actual: streaming ? '已开始' : '60s 内无流式帧（成员队列抢占或主队错步，看 mock-requests）',
  })
  if (streaming) {
    await protocol.call('message.abort', { sessionId: sid }, { timeoutMs: 60_000 })
    const endA = await protocol.waitTurnEnd(sid, { since: sinceA, timeoutMs: 120_000 })
    ev.assert('B: abort 后 turn 收尾 stopReason=aborted', endA.type === 'message.complete' && endA.payload?.stopReason === 'aborted', {
      channel: 'B',
      expected: 'message.complete + stopReason=aborted（aborted 非 error）',
      actual: `${endA.type} stop=${endA.payload?.stopReason ?? 'n/a'}`,
    })
    ev.step({ step: 'chat.abort', channel: 'B', exitCode: endA.payload?.stopReason === 'aborted' ? 0 : 1, stats: { stopReason: endA.payload?.stopReason } })

    // isGenerating 复位：abort 后再发一轮能正常完成（消费哪个队列步不定——成员完成通知轮
    // 会在 abort 轮之后插队消费主队步，恢复轮文本内容不断言具体值，只断轮次收敛）
    const sinceR = protocol.events.length
    await protocol.send(sid, 'abort 后恢复轮')
    const endR = await protocol.waitTurnEnd(sid, { since: sinceR, timeoutMs: 180_000 })
    ev.assert('B: abort 后会话可用（恢复轮正常完成）', endR.type === 'message.complete' && endR.ok, {
      channel: 'B',
      expected: 'message.complete 非 error（isGenerating 复位）',
      actual: `end=${endR.type}/${endR.payload?.stopReason ?? ''}`,
    })
    ev.step({ step: 'chat.abort.recovery', channel: 'B', exitCode: endR.ok ? 0 : 1, stats: { stopReason: endR.payload?.stopReason } })
  }

  log(`done sid=${sid}`)
  // streaming cancel 的通道缺陷如实进 deviations（runner 据 ev.ok/未决项判级，不改断言凑绿）
  if (cancelDefect) uncovered.push(`执行域 streaming cancel 的 Done 回执缺失（handler_error 确定性复现）——取消效果已达成（stopReason=interrupted），缺陷只在回执通道：根因 = 扩展 rpcCancel 成功路径不写结果文件 + runtime 缺失即报错（见 docs/todo/subagent-cancel-receipt-race.md）`)
  return { uncovered, gotchas }
}
