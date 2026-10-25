/**
 * mobile-queue-state-machine —— 队列全链（remote-use-mobile-v2 §8.2 场景 V5，D3 验收目标 A5；
 * §6.22 投递状态机在移动壳 QueueStrip v2 的呈现面）。
 *
 * 真实用户路径：移动壳聊天内 Composer 逐字输入发送（触屏主路径），队列条状态机流转全部在
 * mobile-queue-strip 呈现面上断言；B 通道（protocol session.delivery 帧 / 事件）与 runtime
 * 日志做请求侧互证。
 *
 * 五段断言（V5 通过标准逐条对应）：
 *   ① 生成中再发一条：队列条进入 in-flight 形态（投递中），回执 lane='steer'（steer 注入
 *      当前回合）；submit→首个 message.complete 窗口内无第二个 message_start（不出现第二个
 *      流式回复）；
 *   ② 压缩持有窗口内再发一条：session.compact（手动压缩，runtime 真实链路）置
 *      occupancy.compacting → 提交进 queued 态（排队中）；
 *   ③ queued 态显示 × 可取消：点 ×（delivery.cancel）→ 条目从队列条消失；
 *   ④ 杀 pi 连接制造 failed（in-flight 未确认 → failInFlight）：failed 形态显示「发送未确认」
 *      + 重试钮（未送出可重试）+ message.error「执行结果未确认」上报；
 *   ⑤ 点重试：delivery.resync 请求侧取证（runtime 日志 `resync: retry` 行）+ 条目离开 failed 态。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createTaskViaSheet,
  flattenSessions,
  openConnectedShell,
  pollVisible,
  sendViaComposer,
} from './lib/mobile-task-flow.mjs'
import { closeMobileShell } from './lib/mobile-shell-helper.mjs'

const TPS = 8
/** 回合一正文（~200 字，TPS=8 限速 ≈ 25s 流式窗口，覆盖段①全程） */
const LONG_TEXT = `${'队列全链验收的长回合正文，逐块限速吐出，把回合拉长到数十秒，让生成中再发一条的 steer 窗口可观测。'.repeat(4)}QUEUE-STREAM-1-END`
const FILLER_REPLY = 'QUEUE-ACK-收到，继续执行。'
const MSG2 = 'QUEUE-STEER-MSG-2-插入的追问'
const MSG3 = 'QUEUE-CANCEL-MSG-3-压缩窗口提交'
const MSG4 = 'QUEUE-FAILED-MSG-4-断链前提交'

/** 条件轮询 runtime 日志出现目标行（读侧条件等待，非 sleep 后断言）。 */
async function waitForRuntimeLogLine(dataDir, needle, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let text = ''
    try {
      const dir = path.join(dataDir, 'logs')
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('runtime-')) continue
        text += fs.readFileSync(path.join(dir, f), 'utf8')
      }
    } catch {
      /* logs 未就绪 */
    }
    const hit = text.split('\n').find((l) => l.includes(needle))
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** pi 主进程 PID（--mode rpc --session-dir 含本实例数据目录；隔离实例内应恰一）。 */
function findPiPid(dataDir) {
  const sessionsDir = path.join(dataDir, 'agent', 'sessions')
  const out = execFileSync('pgrep', ['-f', `--session-dir ${sessionsDir}`], { encoding: 'utf8' })
  const pids = out.split('\n').map((s) => s.trim()).filter(Boolean)
  return pids
}

export const meta = {
  id: 'mobile-queue-state-machine',
  priority: 'P0',
  title: '移动壳队列条状态机全链：生成中 steer(in-flight) → 压缩窗口 queued(× 可取消) → pi 断链 failed(可重试) → resync 重试请求侧取证',
  covers: ['env.launch', 'env.ready', 'session.create', 'chat.send', 'chat.steer', 'chat.queue-delivery', 'mobile.queue.state-machine'],
  requires: ['remote-access', 'mobile-dist', 'faux'],
  estimateSec: 300,
  remoteAccess: {},
  faux: {
    responses: [
      { text: LONG_TEXT, stopReason: 'stop' }, // 回合一：长正文（steer 窗口载体）
      { text: FILLER_REPLY, stopReason: 'stop' }, // steer 追问回复
      { text: `${'压缩摘要占位正文。'.repeat(30)}COMPACT-SUMMARY-END`, stopReason: 'stop' }, // session.compact 摘要（拉宽 compacting 窗口）
      { text: FILLER_REPLY, stopReason: 'stop' }, // 段④直接回合
      { text: FILLER_REPLY, stopReason: 'stop' }, // 段⑤重试重投（若 pi 已复活则消费，否则留存）
      { text: FILLER_REPLY, stopReason: 'stop' }, // 余量
    ],
    tps: TPS,
  },
  provable: [
    'A：生成中再发一条，队列条进入 in-flight 形态（mobile-queue-state-in-flight 可见）',
    'B：该条目 session.delivery 帧 lane=steer（steer 注入当前回合，非排队/直发）',
    'B：submit → 首个 message.complete 窗口内无第二个 message.message_start（不出现第二个流式回复）',
    'B：session.compact 触发 occupancy compacting（session.compacting 帧在场，runtime 真实压缩链）',
    'A：压缩持有窗口内提交进 queued 态（排队中）且行内 × 取消钮可见',
    'A：点 × 后条目从队列条消失（delivery.cancel）',
    'A：pi 断链后 failed 形态在场：「发送未确认」+ 重试钮（未送出可重试）',
    'B：failed 附带 message.error「执行结果未确认」上报（in-flight 未确认的显式失败终局）',
    'B：点重试后 runtime 日志出现 delivery.resync 请求侧行（resync: retry … as user-requested）',
    'A：重试后条目离开 failed 态（mobile-queue-state-failed 消失）',
  ],
  notProvable: [
    '真实网络分区/基站切换的物理断网形态（本剧本断链 = pi 进程 SIGKILL 的精确 PID 打击，runtime 侧 onSessionExit → onPiDisconnected → failInFlight 真实链路；renderer↔runtime WS 断开不产生 failed 条目——runtime 存活，条目照常终局）',
    '真机触控手势形态（仿真 viewport 下以 pointer/click 事件驱动同一交互逻辑）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess, dataDir } = ctx
  const gotchas = [
    'failed 成因选型：renderer↔runtime WS 断开（routeWebSocket）不产生 failed 条目（runtime 存活、条目照常终局）；runtime 侧 failed 的两成因 = 受理失败首败 / pi 断链未确认——本剧本用 pi 进程 SIGKILL（精确 PID，禁 pkill）走 onSessionExit → onPiDisconnected → failInFlight 真实链路',
    'faux 脚本全局逐轮出队：steer 追问 / compact 摘要 / 直发回合各自消耗 step，段②之后 step 文本统一 filler 防 off-by-N 错位（断言只看投递状态不看回复文本）',
    'steer 条目的 in-flight paint 窗口受 TPS 拉长（回合在途即 in-flight），100ms 轮询必达；若 TPS 未生效（env 断链）段①断言会如实红',
    'session.compact RPC reply（session.compacted）在压缩完成时才 resolve——「压缩窗口内」提交必须 fire-and-await：先发 call、等 session.compacting 广播帧、窗口内完成移动端操作、再 await 收尾',
  ]
  const uncovered = []
  const info = instance.info()
  const goodToken = remoteAccess?.token
  if (!goodToken) throw new Error('ctx.remoteAccess 缺失：run.mjs 未做 remote-access 预置（meta.remoteAccess 钩子失效？）')

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-a5-queue-'))
  let shell = null
  const waitErr = (e) => JSON.stringify({ message: String(e?.message ?? e), evidence: e?.evidence }, null, 2).slice(0, 2_000)

  try {
    shell = await openConnectedShell({ repo: ctx.repo, runtimePort: info.runtimePort, token: goodToken })
    const page = shell.page
    const protocol = ctx.protocol
    ev.step({ step: 'mobile.shell.connected', channel: 'A', exitCode: 0, stats: { handover: shell.handover.ok } })

    // ── 装配：NewTaskSheet 建会话（faux 首轮直发），轮询订阅接线 ───────────────
    await createTaskViaSheet(page, { cwd, firstMessage: 'A5 队列全链会话的首条消息' })
    const listReply = await protocol.call('session.list', {}, { replyType: 'session.list' })
    const created = flattenSessions(listReply).find((s) => s.cwd === cwd)
    if (!created?.id) throw new Error('session.list 未命中新建会话（cwd 不匹配）')
    const sid = created.id
    await protocol.subscribe(sid)
    ev.step({ step: 'session.create.via-sheet', channel: 'A', exitCode: 0, stats: { sid } })

    // 首轮回复收尾 + 队列 topic 接线保险（p1-settling 同款二次 subscribe）
    await page
      .locator('[data-testid="mobile-message-stream"]')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    await protocol.subscribe(sid)

    // ── 段①：生成中再发一条 → in-flight/steer + 无第二个流式回复 ─────────────
    await sendViaComposer(page, LONG_TEXT.slice(0, 20))
    // 等流式在途（停止钮 = showStop 分支在场）
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'visible', timeout: 30_000 })
    ev.step({ step: 'mobile.turn1.generating', channel: 'A', exitCode: 0, stats: {} })

    const sinceSubmit2 = protocol.events.length
    await sendViaComposer(page, MSG2)
    const inFlightSeen = await pollVisible(page, '[data-testid="mobile-queue-state-in-flight"]', { timeoutMs: 20_000 })
    await ev.shot(page, 'a5-in-flight')
    ev.assert('A: 生成中再发一条，队列条进入 in-flight 形态', inFlightSeen, {
      channel: 'A', expected: 'mobile-queue-state-in-flight 可见', actual: `seen=${inFlightSeen}`,
    })

    // B：steer 帧（lane=steer 的队列成员资格权威事实源）
    let steerEntry = null
    try {
      const frame = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => (x.preview ?? '').includes(MSG2)),
        { timeoutMs: 20_000, since: sinceSubmit2, sessionId: sid },
      )
      steerEntry = (frame.payload.entries ?? []).find((x) => (x.preview ?? '').includes(MSG2))
    } catch (e) {
      ev.attach('steer-frame-miss', waitErr(e))
    }
    ev.assert('B: 追问条目回执 lane=steer（steer 注入当前回合）', steerEntry?.lane === 'steer', {
      channel: 'B',
      expected: "lane='steer'",
      actual: steerEntry ? JSON.stringify(steerEntry) : '未等到 session.delivery 帧',
    })

    // B：submit → 首个 message.complete 窗口内无第二个 message_start（不出现第二个流式回复）
    let end1 = null
    try {
      end1 = await protocol.waitTurnEnd(sid, { since: sinceSubmit2, timeoutMs: 180_000 })
    } catch (e) {
      ev.attach('turn1-end-miss', waitErr(e))
    }
    const windowStart = sinceSubmit2
    const completeIdx = end1
      ? protocol.events.findIndex((e) => e.type === 'message.complete' && e.payload?.sessionId === sid && e.receivedAt === end1.at)
      : -1
    const secondStarts = completeIdx > windowStart
      ? protocol.events.slice(windowStart, completeIdx).filter((e) => e.type === 'message.message_start')
      : []
    ev.assert('B: 首个 complete 前 streaming 窗口内无第二个 message_start（不出现第二个流式回复）', end1?.ok === true && secondStarts.length === 0, {
      channel: 'B',
      expected: 'message.complete 到达 ∧ 窗口内 message_start 计数 = 0',
      actual: `end=${end1 ? `${end1.type}@${end1.payload?.stopReason ?? ''}` : '未等到'} 第二次起流=${secondStarts.length}`,
    })
    ev.step({ step: 'mobile.queue.steer', channel: 'B', exitCode: steerEntry?.lane === 'steer' ? 0 : 1, stats: { lane: steerEntry?.lane ?? null } })

    // 等回合彻底收尾（含 steer 追问回复）→ idle
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'hidden', timeout: 180_000 })
    ev.step({ step: 'mobile.turn1.idle', channel: 'A', exitCode: 0, stats: {} })

    // ── 段②③：压缩持有窗口内提交 → queued + × 可取消 → 点 × 条目消失 ─────────
    const compactPromise = protocol
      .call('session.compact', { sessionId: sid }, { replyType: 'session.compacted', timeoutMs: 240_000 })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
    let compactingSeen = true
    try {
      await protocol.waitFor((e) => e.type === 'session.compacting' && e.payload?.sessionId === sid, { timeoutMs: 30_000 })
    } catch (e) {
      compactingSeen = false
      ev.attach('compacting-frame-miss', waitErr(e))
    }
    ev.assert('B: session.compact 触发压缩持有窗口（session.compacting 帧在场）', compactingSeen, {
      channel: 'B', expected: "session.compacting {status:'compacting'}", actual: `seen=${compactingSeen}`,
    })

    await sendViaComposer(page, MSG3)
    const queuedSeen = await pollVisible(page, '[data-testid="mobile-queue-state-queued"]', { timeoutMs: 20_000 })
    const queuedRow = page.locator('[data-testid="mobile-queue-row"]', { hasText: MSG3 })
    const cancelVisible = queuedSeen ? await queuedRow.locator('[data-testid="mobile-queue-cancel"]').isVisible() : false
    await ev.shot(page, 'a5-queued')
    ev.assert('A: 压缩持有窗口内提交进 queued 态且 × 取消钮可见', queuedSeen && cancelVisible, {
      channel: 'A',
      expected: 'mobile-queue-state-queued 可见 ∧ 行内 mobile-queue-cancel 可见',
      actual: `queued=${queuedSeen} cancel=${cancelVisible}`,
    })

    // B：queued 条目帧（state/lane 权威面）
    let queuedEntry = null
    try {
      const frame = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => (x.preview ?? '').includes(MSG3) && x.state === 'queued'),
        { timeoutMs: 15_000, sessionId: sid },
      )
      queuedEntry = (frame.payload.entries ?? []).find((x) => (x.preview ?? '').includes(MSG3))
    } catch (e) {
      ev.attach('queued-frame-miss', waitErr(e))
    }
    ev.assert('B: queued 条目 session.delivery 帧在场（state=queued）', Boolean(queuedEntry), {
      channel: 'B', expected: '{state:queued}', actual: queuedEntry ? JSON.stringify(queuedEntry) : '未等到',
    })

    // 点 × → 条目消失（delivery.cancel；取消成功全文回输入框为 v1 承接行为，旁证 attach）
    await queuedRow.locator('[data-testid="mobile-queue-cancel"]').click()
    let rowGone = true
    try {
      await queuedRow.waitFor({ state: 'detached', timeout: 15_000 })
    } catch {
      rowGone = false
    }
    ev.assert('A: 对 queued 条目点 × 后条目从队列条消失', rowGone, {
      channel: 'A', expected: '该 mobile-queue-row detached', actual: `detached=${rowGone}`,
    })
    const composerAfterCancel = await page.locator('[data-testid="mobile-composer"] [role="textbox"]').innerText().catch(() => '')
    ev.attach('cancel-draft-restore', composerAfterCancel.includes(MSG3) ? '取消后全文回输入框（旁证成立）' : `输入框当前文本="${composerAfterCancel.trim().slice(0, 60)}"`)
    ev.step({ step: 'mobile.queue.cancel', channel: 'A', exitCode: rowGone ? 0 : 1, stats: {} })

    // 压缩收尾（窗口关闭）+ idle
    const compactResult = await compactPromise
    ev.assert('B: session.compact 收尾无错误（compacted）', compactResult.ok, {
      channel: 'B', expected: 'reply session.compacted', actual: compactResult.ok ? 'ok' : String(compactResult.error).slice(0, 200),
    })
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'hidden', timeout: 60_000 })

    // ── 段④：杀 pi 制造 failed →「发送未确认」+ 重试钮 ───────────────────────
    const sinceSubmit4 = protocol.events.length
    await sendViaComposer(page, MSG4)
    let start4 = null
    try {
      start4 = await protocol.waitFor((e) => e.type === 'message.message_start', { timeoutMs: 30_000, since: sinceSubmit4, sessionId: sid })
    } catch (e) {
      ev.attach('turn4-start-miss', waitErr(e))
    }
    ev.assert('B: 直接提交开新回合（message_start 在场，pi 在途窗口成立）', Boolean(start4), {
      channel: 'B', expected: 'message.message_start', actual: start4 ? '到达' : '未等到',
    })

    const piPids = findPiPid(dataDir)
    ev.assert('C: pi 进程精确定位（--session-dir 含本实例数据目录，恰一 PID）', piPids.length === 1, {
      channel: 'C', expected: '恰一 PID', actual: `pids=${piPids.join(',') || 'none'}`,
    })
    if (piPids.length === 1) {
      process.kill(Number(piPids[0]), 'SIGKILL')
      ev.step({ step: 'pi.sigkill', channel: 'C', exitCode: 0, stats: { pid: piPids[0] } })
    }
    let exitedSeen = true
    try {
      await protocol.waitFor((e) => e.type === 'session.exited' && e.payload?.sessionId === sid, { timeoutMs: 30_000 })
    } catch (e) {
      exitedSeen = false
      ev.attach('session-exited-miss', waitErr(e))
    }
    ev.assert('B: pi 断链 → session.exited 广播（onSessionExit 链触发）', exitedSeen, {
      channel: 'B', expected: 'session.exited 帧', actual: `seen=${exitedSeen}`,
    })

    const failedSeen = await pollVisible(page, '[data-testid="mobile-queue-state-failed"]', { timeoutMs: 20_000 })
    const failedRow = page.locator('[data-testid="mobile-queue-row"]', { hasText: MSG4 })
    const retryVisible = failedSeen ? await failedRow.locator('[data-testid="mobile-queue-retry"]').isVisible() : false
    await ev.shot(page, 'a5-failed')
    ev.assert('A: failed 形态在场：「发送未确认」+ 重试钮（未送出可重试）', failedSeen && retryVisible, {
      channel: 'A',
      expected: 'mobile-queue-state-failed 可见 ∧ 行内 mobile-queue-retry 可见',
      actual: `failed=${failedSeen} retry=${retryVisible}`,
    })
    let unconfirmedErr = null
    try {
      unconfirmedErr = await protocol.waitFor(
        (e) => e.type === 'message.error' && String(e.payload?.message ?? '').includes('执行结果未确认'),
        { timeoutMs: 15_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('unconfirmed-error-miss', waitErr(e))
    }
    ev.assert('B: failed 附带「执行结果未确认」逐条上报（message.error）', Boolean(unconfirmedErr), {
      channel: 'B', expected: "message.error 含「执行结果未确认」", actual: unconfirmedErr ? '到达' : '未等到',
    })
    ev.step({ step: 'mobile.queue.failed', channel: 'A', exitCode: failedSeen && retryVisible ? 0 : 1, stats: {} })

    // ── 段⑤：点重试 → delivery.resync 请求侧取证 + 条目离开 failed 态 ─────────
    const logLenBefore = readLogBytes(dataDir)
    await failedRow.locator('[data-testid="mobile-queue-retry"]').click()
    const resyncLine = await waitForRuntimeLogLine(dataDir, 'resync: retry', { timeoutMs: 20_000 })
    ev.assert('B: 重试点击后 runtime 日志出现 delivery.resync 请求侧行', Boolean(resyncLine), {
      channel: 'B',
      expected: "runtime 日志含「resync: retry … as user-requested」（delivery.resync 到达）",
      actual: resyncLine ? resyncLine.trim().slice(0, 160) : `20s 内未出现（日志字节量 ${readLogBytes(dataDir) - logLenBefore} 前后对照）`,
    })
    const failedGone = !(await pollVisible(page, '[data-testid="mobile-queue-state-failed"]', { timeoutMs: 20_000 }))
    ev.assert('A: 重试后条目离开 failed 态（mobile-queue-state-failed 消失）', failedGone, {
      channel: 'A', expected: 'failed 徽标不可见（requeue→queued 或直接 delivered）', actual: `gone=${failedGone}`,
    })
    await ev.shot(page, 'a5-after-retry')
    ev.step({ step: 'mobile.queue.retry', channel: 'B', exitCode: resyncLine && failedGone ? 0 : 1, stats: { resyncLogged: Boolean(resyncLine), failedGone } })

    if (shell.pageErrors.length > 0) ev.attach('page-errors', shell.pageErrors.join('\n---\n'))
    log(`done sid=${sid}`)
  } finally {
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}

function readLogBytes(dataDir) {
  try {
    const dir = path.join(dataDir, 'logs')
    let n = 0
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('runtime-')) n += fs.statSync(path.join(dir, f)).size
    }
    return n
  } catch {
    return 0
  }
}
