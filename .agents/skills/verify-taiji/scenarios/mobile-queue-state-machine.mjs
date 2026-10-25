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
/** 段④载体回合正文（~240 字，TPS=8 ≈ 30s 流式窗口；kill 落在窗口内） */
const KILL_CARRIER = `${'断链载体的长回合正文，限速吐出以维持流式窗口，让 steer 条目在未消费时进程死亡。'.repeat(4)}QUEUE-CARRIER-END`

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

/**
 * 种子压缩阈值（launch 后、会话首建前写 <dataDir>/agent/settings.json）：pi 压缩默认
 * keepRecentTokens=20000——小验收会话全落在「保留区」，手动 compact 报
 * "Nothing to compact (session too small)"（首跑实测），持有窗口造不出来。归零后
 * 小会话即可真实走完 compacting 持有链（阈值维度注入，投递状态机零改动）。
 */
function seedCompactionWindow(dataDir) {
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  settings.compaction = { ...(settings.compaction ?? {}), keepRecentTokens: 0 }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

/**
 * pi 主进程 PID = 实例进程树内的 --mode rpc 节点（精确打击，禁 pkill 宽匹配）。
 * 定位锚 = dev-instance PID 的后代 ∩ argv 含 '--mode rpc'：主 agent pi 的 argv 不带
 * --session-dir（只有子代理模板带，首跑实测 pgrep 无命中）——进程树归属是唯一可靠锚，
 * 隔离实例内（无 subagent/workflow 派发）树内 rpc 节点恰一。
 */
function findPiPid(rootPid) {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/)
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null
    })
    .filter(Boolean)
  const childrenOf = new Map()
  for (const r of rows) {
    if (!childrenOf.has(r.ppid)) childrenOf.set(r.ppid, [])
    childrenOf.get(r.ppid).push(r)
  }
  const hits = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const c of childrenOf.get(pid) ?? []) {
      if (c.cmd.includes('--mode rpc')) hits.push(c.pid)
      queue.push(c.pid)
    }
  }
  return hits
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
      { text: KILL_CARRIER, stopReason: 'stop' }, // 段④载体回合（流式中杀 pi，永不收尾）
      { text: FILLER_REPLY, stopReason: 'stop' }, // 段⑤重试重投（若 pi 已复活则消费，否则留存）
      { text: FILLER_REPLY, stopReason: 'stop' }, // 余量
      { text: FILLER_REPLY, stopReason: 'stop' }, // 余量
    ],
    tps: TPS,
  },
  provable: [
    'A：生成中再发一条，队列条进入 in-flight 形态（mobile-queue-state-in-flight 可见）',
    'B：该条目 session.delivery 帧 lane=steer（steer 注入当前回合，非排队/直发）',
    'B：steer 提交 → 第一条流式消息 message_end 窗口内无第二个 message.message_start（首个流式回复结束前不出现并行第二个流式回复）',
    'B：session.compact 真实完成（session.compacting 帧在场 ∧ session.compacted 广播无 error；runtime 真实压缩链）',
    'A：压缩持有窗口内提交进 queued 态（排队中）且行内 × 取消钮可见',
    'A：点 × 后条目从队列条消失（delivery.cancel）',
    'A：流中 steer 条目遇 pi 断链 → failed 形态在场：「发送未确认」+ 重试钮（未送出可重试）',
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
    '压缩持有窗口的可达性依赖开局种子 compaction.keepRecentTokens=0（写 <dataDir>/agent/settings.json，会话首建 = pi 子进程 spawn 前落盘）：pi 默认 keepRecentTokens=20000 会把小验收会话全判进保留区，手动 compact 报 "Nothing to compact (session too small)"（首跑实测）——阈值维度注入，投递状态机零改动',
    '「不出现第二个流式回复」的窗口锚 = message.message_end（assistant 帧带 messageId）：message.complete 只在 run 终态广播（steer 使 run 跨 assistant 消息延续，run 内含追问回复的 message_start 属先后串行的合法形态，非并行抢流）',
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

    // 压缩阈值种子（会话首建 = pi 子进程 spawn 前落盘，spawn 读盘生效）
    seedCompactionWindow(dataDir)
    ev.step({ step: 'pi.compaction.seed', channel: 'C', exitCode: 0, stats: { keepRecentTokens: 0 } })

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

    // B：不出现第二个流式回复——窗口 = steer 提交 → 第一条流式消息 message_end（assistant
    // 帧带 messageId）。首个流式回复结束前出现新 message_start = 并行抢流（违规）；
    // 追问回复的 message_start 在 end 之后 = 先后串行合法形态。
    let firstStreamEndIdx = -1
    try {
      const endEvt = await protocol.waitFor(
        (e) => e.type === 'message.message_end' && typeof e.payload?.messageId === 'string',
        { timeoutMs: 180_000, since: sinceSubmit2, sessionId: sid },
      )
      firstStreamEndIdx = protocol.events.indexOf(endEvt)
    } catch (e) {
      ev.attach('first-stream-end-miss', waitErr(e))
    }
    const parallelStarts = firstStreamEndIdx > sinceSubmit2
      ? protocol.events.slice(sinceSubmit2, firstStreamEndIdx).filter((e) => e.type === 'message.message_start')
      : []
    ev.assert('B: 首条流式消息结束前无并行 message_start（不出现第二个流式回复）', firstStreamEndIdx > sinceSubmit2 && parallelStarts.length === 0, {
      channel: 'B',
      expected: 'message_end 到达 ∧ 窗口内 message_start 计数 = 0',
      actual: `endIdx=${firstStreamEndIdx} 并行起流=${parallelStarts.length}`,
    })
    ev.step({ step: 'mobile.queue.steer', channel: 'B', exitCode: steerEntry?.lane === 'steer' ? 0 : 1, stats: { lane: steerEntry?.lane ?? null } })

    // 等回合彻底收尾（含 steer 追问回复）→ idle
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'hidden', timeout: 180_000 })
    ev.step({ step: 'mobile.turn1.idle', channel: 'A', exitCode: 0, stats: {} })

    // ── 段②③：压缩持有窗口内提交 → queued + × 可取消 → 点 × 条目消失 ─────────
    const compactedFramePromise = protocol
      .waitFor((e) => e.type === 'session.compacted' && e.payload?.sessionId === sid, { timeoutMs: 240_000 })
      .then((f) => ({ ok: true, error: f.payload?.error }))
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
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

    // 压缩收尾（窗口关闭）+ idle：compacted 广播 payload.error 为空 = 压缩真实完成
    //（reply 先行 ok、pi 侧失败经广播 error 字段显形的形态首跑实测——"Nothing to compact"）
    const compactedResult = await compactedFramePromise
    await compactPromise
    ev.assert('B: session.compact 真实完成（compacted 广播无 error）', compactedResult.ok && !compactedResult.error, {
      channel: 'B', expected: 'session.compacted 无 error', actual: compactedResult.ok ? `error=${String(compactedResult.error ?? 'none')}` : String(compactedResult.error).slice(0, 200),
    })
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'hidden', timeout: 60_000 })

    // ── 段④：流中 steer + 杀 pi 制造 failed →「发送未确认」+ 重试钮 ────────────
    // 形态选型（四次实跑归因）：空闲直发的条目在回合开始时 marker 已落 transcript →
    // delivered，杀 pi 只产生回合出错条（chat-turn-error-bar），不产生队列 failed；
    // failed 的可达形态 = steer 条目在流中未消费即死亡（steering 文本未进 transcript →
    // in-flight 未确认 → failInFlight）。载体回合 = MSG4a 长正文（TPS 限速拉宽窗口）。
    const since4a = protocol.events.length
    await sendViaComposer(page, KILL_CARRIER)
    await page.locator('[data-testid="mobile-composer-stop"]').waitFor({ state: 'visible', timeout: 30_000 })
    ev.step({ step: 'mobile.turn4a.generating', channel: 'A', exitCode: 0, stats: {} })

    await sendViaComposer(page, MSG4)
    let steer4Frame = null
    try {
      steer4Frame = await protocol.waitFor(
        (e) => e.type === 'session.delivery' && (e.payload?.entries ?? []).some((x) => (x.preview ?? '').includes(MSG4)),
        { timeoutMs: 20_000, since: since4a, sessionId: sid },
      )
    } catch (e) {
      ev.attach('steer4-frame-miss', waitErr(e))
    }
    const steer4Entry = steer4Frame ? (steer4Frame.payload.entries ?? []).find((x) => (x.preview ?? '').includes(MSG4)) : null
    ev.assert('B: 断链前 steer 提交受理在途（session.delivery 帧含条目且未终态）', Boolean(steer4Entry) && steer4Entry.state !== 'delivered', {
      channel: 'B',
      expected: '{state: in-flight | queued}',
      actual: steer4Entry ? JSON.stringify(steer4Entry) : '未等到帧',
    })

    const piPids = findPiPid(info.pid)
    ev.assert('C: pi 进程精确定位（实例进程树内 --mode rpc 节点，恰一 PID）', piPids.length === 1, {
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
    const failedUuid = steer4Entry?.clientUuid ?? null
    const logLenBefore = readLogBytes(dataDir)
    await failedRow.locator('[data-testid="mobile-queue-retry"]').click()
    let resyncLine = await waitForRuntimeLogLine(dataDir, 'resync: ', { timeoutMs: 20_000 })
    if (!resyncLine) {
      // 归因分流：移动端点击无日志响应时，桌面协议侧直发同参 delivery.resync cross-check——
      // 协议侧有日志 = 移动端请求未达（接线缺陷）；协议侧也无日志 = runtime 侧挂死（产品缺陷）。
      ev.attach('mobile-console-tail', shell.consoleLines.slice(-30).join('\n') || '(无 console)')
      ev.attach('runtime-log-tail-before-crosscheck', readLogTail(dataDir, 30) || '(空)')
      // 内核在册性只读核对：peek 命中 = 条目仍在内核活跃集（failed 帧与内核态分歧定位）；
      // peek 未命中 = 条目已离册（unknown 路径）
      let peekReply = null
      try {
        peekReply = failedUuid
          ? await protocol.call('delivery.peek', { sessionId: sid, clientUuid: failedUuid }, { replyType: 'delivery.peek', timeoutMs: 10_000 })
          : { skipped: 'no-uuid' }
      } catch (e) {
        peekReply = { error: String(e?.message ?? e).slice(0, 160) }
      }
      let crossReply = null
      try {
        crossReply = await protocol.call('delivery.resync', { sessionId: sid, clientUuids: failedUuid ? [failedUuid] : [] }, { replyType: 'delivery.resync', timeoutMs: 15_000 })
      } catch (e) {
        crossReply = { error: String(e?.message ?? e).slice(0, 200) }
      }
      resyncLine = await waitForRuntimeLogLine(dataDir, 'resync: ', { timeoutMs: 15_000 })
      ev.attach(
        'resync-crosscheck',
        JSON.stringify(
          {
            peekReply,
            mobileRetryLogHit: Boolean(resyncLine),
            protocolReply: crossReply,
            protocolSideLogHit: Boolean(resyncLine),
            logTailAfter: readLogTail(dataDir, 15),
          },
          null,
          2,
        ).slice(0, 3_000),
      )
    }
    ev.assert('B: 重试点击后 runtime 日志出现 delivery.resync 请求侧行', Boolean(resyncLine), {
      channel: 'B',
      expected: "runtime 日志含「resync: …」行（delivery.resync 到达：retry 重投 / already in transcript / transcript read failed 任一）",
      actual: resyncLine ? resyncLine.trim().slice(0, 160) : `35s 内未出现（含协议侧 cross-check；日志字节量 ${readLogBytes(dataDir) - logLenBefore} 前后对照）`,
    })
    const failedGone = !(await pollVisible(page, '[data-testid="mobile-queue-state-failed"]', { timeoutMs: 20_000 }))
    ev.assert('A: 重试后条目离开 failed 态（mobile-queue-state-failed 消失）', failedGone, {
      channel: 'A', expected: 'failed 徽标不可见（requeue→queued 或直接 delivered）', actual: `gone=${failedGone}`,
    })
    await ev.shot(page, 'a5-after-retry')
    ev.step({ step: 'mobile.queue.retry', channel: 'B', exitCode: resyncLine && failedGone ? 0 : 1, stats: { resyncLogged: Boolean(resyncLine), failedGone } })

    if (shell.pageErrors.length > 0) ev.attach('page-errors', shell.pageErrors.join('\n---\n'))
    // 事件时间线（红跑归因第一现场：段界时序 / 投递帧 / 压缩帧）
    {
      const keyFrames = []
      for (const e of protocol.events) {
        const brief = e.type === 'message.complete'
          ? `stop=${String(e.payload?.stopReason)}`
          : e.type === 'session.occupancy'
            ? `turn=${String(e.payload?.turn)} compacting=${String(e.payload?.compacting)}`
            : e.type === 'session.delivery'
              ? `entries=${JSON.stringify(e.payload?.entries ?? []).slice(0, 220)}`
              : e.type?.startsWith('session.compact')
                ? JSON.stringify(e.payload ?? {}).slice(0, 120)
                : ''
        if (brief !== '' || e.type === 'message.message_start' || e.type === 'message.message_end' || e.type === 'session.exited' || e.type === 'message.error') {
          keyFrames.push(`${e.type}@${new Date(e.receivedAt).toISOString().slice(11, 23)} ${brief}`.trimEnd())
        }
      }
      ev.attach('event-timeline', `frames total=${protocol.events.length}\n${keyFrames.join('\n')}`.slice(0, 30_000))
    }
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

/** runtime 日志尾 N 行（归因附件用）。 */
function readLogTail(dataDir, lines = 20) {
  try {
    const dir = path.join(dataDir, 'logs')
    let text = ''
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('runtime-')) text += fs.readFileSync(path.join(dir, f), 'utf8')
    }
    return text.split('\n').filter(Boolean).slice(-lines).join('\n')
  } catch {
    return ''
  }
}
