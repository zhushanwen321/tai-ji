/**
 * p1-direct-send-user-bubble-probe —— 协议直发 user 气泡缺失回归哨兵
 * （专项探针，非验收剧本；原登记文档已随缺陷修复退役——缺失形态的根因修复 =
 * delivery-topic 运行时创建事件接线 + 守卫降级入流，见 effects/user-delivery.ts）。
 *
 * 复现形态：session.create → UI 激活（renderer 订阅建立）→ delivery.submit 协议直发
 * （非 composer，无乐观气泡/inflight 记账）→ 轮完成后断言 user 气泡哨兵 live 在场。
 * 缺失即复现 todo 现象（message_end(user) 回执 ① 标记未命中派生视图 → ③ 守卫静默消费）。
 * assistant 正文在场断言排除「整轮未渲染」假阴性。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'p1-direct-send-user-bubble-probe',
  priority: 'P1',
  title: '协议直发 user 气泡缺失复现探针（rpc-direct-send-user-bubble）',
  covers: ['chat.send', 'chat.stream'],
  requires: ['faux'],
  estimateSec: 60,
  faux: {
    responses: [{ text: '直发探针回执 PROBE-DIRECT-TEXT-END。', stopReason: 'stop' }],
  },
  provable: [
    'A：协议直发（delivery.submit）后 user 气泡哨兵 live 在场',
    'A：assistant 正文在场（排除整轮未渲染假阴性）',
  ],
  notProvable: ['帧序级证据（renderer 侧无帧记录器；缺失时的时序归因依赖 runtime 日志与静态推演）'],
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const ui = ctx.ui
  const page = await ctx.instance.page()
  const USER_SENTINEL = 'PROBE-DIRECT-USER-Q1'
  const TEXT_SENTINEL = 'PROBE-DIRECT-TEXT-END'
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-direct-send-probe-'))
  log(`临时会话 cwd=${cwd}`)

  try {
    const created = await protocol.call('session.create', { cwd, label: 'probe-direct-send' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // 协议直发（delivery.submit，非 composer——无乐观气泡/inflight 记账）
    const since = protocol.events.length
    const sent = await protocol.send(sid, `协议直发探针消息 ${USER_SENTINEL}`)
    ev.step({
      step: 'chat.direct-send',
      channel: 'B',
      exitCode: 0,
      stats: { clientUuid: sent.clientUuid, channel: sent.channel, state: sent.reply?.state ?? null, lane: sent.reply?.lane ?? null },
    })

    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
    ev.step({ step: 'chat.wait', channel: 'B', exitCode: end.ok ? 0 : 1, stats: { stopReason: end.payload?.stopReason ?? null } })

    // 轮询 body 等两哨兵都稳定在场（轮完成 ≠ 流式渲染完成——text 逐字渲染晚于
    // message.complete 帧到达；只等 user 哨兵会提前退出误判 assistant 缺失）
    let html = ''
    {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        html = await ui.html('css=body')
        if (html.includes(USER_SENTINEL) && html.includes(TEXT_SENTINEL) && !html.includes('stop-btn')) break
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    const present = html.includes(USER_SENTINEL)
    const assistantVisible = html.includes(TEXT_SENTINEL)
    ev.assert('A: 协议直发 user 气泡 live 在场', present, {
      channel: 'A',
      expected: `body 含 ${USER_SENTINEL}`,
      actual: `userBubble=${present} assistantText=${assistantVisible}`,
    })
    ev.assert('A: assistant 正文在场（排除整轮未渲染假阴性）', assistantVisible, {
      channel: 'A',
      expected: TEXT_SENTINEL,
      actual: `hit=${assistantVisible}`,
    })
    if (!present) {
      await ev.shot(page, 'bubble-missing')
      ev.attach('body-html-on-miss', html.slice(0, 4000))
    }
    log(`done sid=${sid} userBubble=${present}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered: [], gotchas: [] }
}
