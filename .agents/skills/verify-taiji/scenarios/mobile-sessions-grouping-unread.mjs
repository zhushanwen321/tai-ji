/**
 * mobile-sessions-grouping-unread —— 会话列表分组 + 未读双触发 + 点入即清（remote-use-mobile-v2
 * §8.2 场景 V2 的剧本化；A2 验收单元）。
 *
 * 真实用户路径（V2）：两个会话在桌面端推进（会话 A 用户发新指令 = 新投递；会话 B 让 agent
 * 跑完一轮 = 新终态）；手机停在列表页看分组与未读，点入会话未读即清。本剧本同一链路装配：
 * 协议客户端扮演桌面驱动（delivery.submit / message.abort / faux 响应脚本编排），移动壳停在
 * 列表页消费 `config.sessions` 广播（§6.3 客户端 diff + runtime 两写点补发广播 fallback）。
 *
 * 触发隔离设计（帧级证据，B 通道）：壳连接边的 loadSessions 快照回执会流进同一个未读 diff
 * 处理器做基线（reply type 同名 config.sessions）——基线窗口在快照处关闭。据此把基线做成
 * **快照本身 = 双 {active}**（两会话的二轮长步在开壳前发起并保持流式），再打**纯触发帧**——
 *   - A 的触发帧 = 活跃回合中的 steer 受理帧：status 恒 active、仅 lastActiveAt 推进
 *     → 点亮 = 「新投递」单条件；
 *   - B 的触发帧 = 回合中止终态帧（message.abort → persistSessionOutcome 写点，§6.3 终态族
 *     stopped 分支）：status 翻转、lastActiveAt 与基线相同 → 点亮 = 「新终态」单条件。
 * 两帧的纯形态由协议帧 diff 佐证；done 分支与 stopped 分支共用同一终态写点。
 *
 * 装配关键事实（2026-10-26 首跑实测修正）：faux 响应脚本是**每 pi 进程（每会话）各自从
 * step1 逐轮出队**，不是全局单队列——两会话的同序号轮消费同一步、时长对称。因此用
 * 「短 step1（两会话首轮，壳连接前自然收尾）+ 长 step2（A2/B2 二轮，各自喂基线）」的对称
 * 脚本，隔离全靠帧时序编排而非步内容差异。
 */
import {
  backToList,
  closeShell,
  openConnectedShell,
  openSessionByRow,
  pollFor,
  rowGroupId,
  rowHasUnread,
  sessionRow,
} from './lib/mobile-drive.mjs'

/** 流式撑窗文本（step2 长轮；TAIJI_FAUX_TPS=25 下 ≈90s 量级）。 */
function longText(marker, repeats) {
  return `${marker}第二段落内容持续追加用于撑长流式窗口观察列表分组与未读信号。`.repeat(repeats)
}

const RESPONSES = [
  { text: 'A2 首轮短回复（壳连接前收尾，不参与断言）。', stopReason: 'stop' }, // step1：两会话首轮
  { text: longText('A2 二轮', 240), stopReason: 'stop' }, // step2：A2/B2 二轮长文（喂基线 / 维持 active）
  { text: 'A 的 steer 后续收尾。', stopReason: 'stop' }, // step3：A3 steer 的连续模型调用
  { text: '尾部填充步（防队列耗尽 error 翻状态）。', stopReason: 'stop' },
]

export const meta = {
  id: 'mobile-sessions-grouping-unread',
  priority: 'P0',
  title: '移动列表分组（进行中/最近）+ 未读双触发（新投递/新终态）+ 点入即清（§8.2 V2）',
  covers: ['mobile.sessions.grouping', 'mobile.sessions.unread', 'session.list'],
  requires: ['faux', 'remote-access', 'mobile-dist'],
  estimateSec: 240,
  remoteAccess: {},
  faux: { tps: 25, responses: RESPONSES },
  provable: [
    'A：列表双组呈现——流式中会话 A 在「进行中」组、回合终态会话 B 在「最近」组（§6.19 双源谓词的未订阅半）',
    'A：会话 A 出现未读点，触发帧 = 仅 lastActiveAt 推进（status 恒 active 的 steer 受理帧）=「新投递」单条件',
    'A：会话 B 出现未读点，触发帧 = status active→终态 翻转（lastActiveAt 与基线相同的回合终态帧）=「新终态」单条件',
    'B：协议侧 config.sessions 帧对佐证两类触发帧纯形态（A 帧 lastActiveAt 单调推进 status 不变；B 帧终态翻转 lastActiveAt 不变）',
    'A：点入会话 A 返回后 A 未读清、B 未读保留；点入 B 返回后 B 未读清（markSessionVisited 点入即清）',
    'C：两次点入后 localStorage 落 taiji.mobile.lastVisited.<sid> 条目（§6.3 持久对照源写侧）',
  ],
  notProvable: [
    '真机推送时机（移动壳 Safari 后台/锁屏恢复）——本剧本只证壳页在线时的广播消费与 diff',
    'B 的终态分支取 stopped（message.abort，同终态写点）；done 分支（自然收尾）的广播帧形态由本剧本帧证据同构覆盖、未单独断言',
    '会话行内相对时间的字面正确性（「X 分钟前」的钟差）——非 V2 判定面',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const uncovered = []
  const gotchas = [
    'faux 响应脚本是每 pi 进程（每会话）各自从 step1 出队，不是全局单队列——多会话剧本不能靠「步序差」制造会话间差异，只能靠帧时序编排（首跑实测修正）',
    '移动壳未读 diff 的首帧语义是「只建基线不点亮」（§6.3 保守语义）——触发帧之前必须各喂一帧暖场，否则触发帧被吞、未读恒不亮',
    'B 的终态用 message.abort（stopped 分支）：steer 会让回合续命进下一 step，「自然收尾且早于 A」与共享步时长冲突；stopped 与 done 共用 persistSessionOutcome 终态写点',
  ]

  // ── 桌面驱动半（壳连接前）：两会话首轮用短 step1，壳连接前自然收尾 ──────────
  const createdA = await protocol.call('session.create', { cwd: ctx.repo, label: 'A2-A-新投递会话' }, { timeoutMs: 120_000 })
  const sidA = createdA.session?.id
  const createdB = await protocol.call('session.create', { cwd: ctx.repo, label: 'A2-B-新终态会话' }, { timeoutMs: 120_000 })
  const sidB = createdB.session?.id
  if (!sidA || !sidB) throw new Error(`session.create 未返回 sessionId：A=${sidA} B=${sidB}`)
  await protocol.subscribe(sidA)
  await protocol.subscribe(sidB)
  ev.step({ step: 'session.create', channel: 'C', exitCode: 0, stats: { sidA, sidB } })
  // delivery.submit 回执即受理事实（lastActiveAt 写点受理同步发生）。时序设计（三次实跑
  // 修正的确定性版）：壳连接边的 loadSessions 快照回执会流进同一个未读 diff 处理器做基线
  // （reply type 同名 config.sessions）——「首帧只建基线」的窗口在快照处关闭，连接后任何
  // 受理帧都会点亮。因此把基线做成**快照本身 = 双 {active}**：首轮短步在壳连接前收尾，
  // 二轮长步（step2）也在开壳前发起并保持流式，快照抓到双 active；随后 A 用 steer 纯帧
  // （status 不变仅 lastActiveAt 推进）点亮、B 用 abort 终态纯帧（status 翻转）点亮。
  await protocol.send(sidA, 'A 会话：先跑一小轮')
  await protocol.send(sidB, 'B 会话：先跑一小轮')
  // since 必须取发送前捕获的游标：waitTurnEnd 默认 since = 调用时刻队列长度，另一会话的
  // complete 若已在自己等待期间入队会被游标跳过（跑 3 实测 60s 超时假死）
  const sinceTurn1 = protocol.events.length
  const endA1 = await protocol.waitTurnEnd(sidA, { since: sinceTurn1, timeoutMs: 60_000 })
  const endB1 = await protocol.waitTurnEnd(sidB, { since: sinceTurn1, timeoutMs: 60_000 })
  ev.step({ step: 'drive.turn1.settled', channel: 'B', exitCode: endA1.ok && endB1.ok ? 0 : 1, stats: { A: endA1.type, B: endB1.type } })
  // 二轮长步（A2/B2 各自消费 step2）：受理帧与首轮终态帧全部落在壳连接之前
  await protocol.send(sidA, 'A 会话：跑一个长任务')
  await protocol.send(sidB, 'B 会话：跑一个长任务')
  await new Promise((r) => setTimeout(r, 1_500)) // 受理帧先行落定，壳快照必然抓到双 active

  // ── 移动壳半：开壳落列表（两会话行经列表快照呈现）─────────────────────────
  const opened = await openConnectedShell(ctx)
  const shell = opened.shell
  try {
    ev.assert('A: 移动壳已连接并落会话列表', opened.ok, {
      channel: 'A', expected: 'screen-sessions 可见', actual: `锚点=${opened.anchor}`,
    })
    if (!opened.ok) {
      uncovered.push('后续断言未驱动：壳未落到会话列表（锚点见 stats）')
      return { uncovered, gotchas }
    }
    await ev.shot(shell.page, 'a2-shell-list-initial')

    const rowsReady = await pollFor(async () => {
      return (await sessionRow(shell.page, sidA).count()) > 0 && (await sessionRow(shell.page, sidB).count()) > 0
    }, { timeoutMs: 30_000 })
    ev.assert('A: 两会话行在列表呈现（壳消费 config.sessions / 列表快照）', rowsReady === true, {
      channel: 'A', expected: `session-row-${sidA} 与 session-row-${sidB} 均存在`, actual: rowsReady ? '两行均在' : '30s 内未齐',
    })
    if (!rowsReady) {
      uncovered.push('分组/未读断言未驱动：会话行未出现')
      return { uncovered, gotchas }
    }

    // ── 快照基线核对：双会话均未亮（基线 = 连接快照 {active}，触发帧未到）──
    const aLitBefore = await rowHasUnread(shell.page, sidA)
    const bLitBefore = await rowHasUnread(shell.page, sidB)
    ev.assert('A: 快照基线后两会话均未亮（基线不点亮的保守语义前提）', aLitBefore === false && bLitBefore === false, {
      channel: 'A', expected: 'A/B 行均无未读点（触发帧未到）', actual: `A=${String(aLitBefore)} B=${String(bLitBefore)}`,
    })

    // ── 触发帧 1（A = 新投递）：活跃回合中的 steer，受理帧应「仅 lastActiveAt 推进」──
    const baselineA = framesFor(protocol, sidA).at(-1) ?? null
    const framesABefore = framesFor(protocol, sidA).length
    await protocol.send(sidA, 'A 触发 steer（新投递写点）')
    await pollFor(() => framesFor(protocol, sidA).length > framesABefore, { timeoutMs: 30_000 }) // 先等触发帧到协议侧再捕获
    const aLit = await pollFor(async () => (await rowHasUnread(shell.page, sidA)) === true, { timeoutMs: 30_000 })
    const triggerA = framesFor(protocol, sidA).at(-1) ?? null
    const aPureDelivery = Boolean(
      baselineA && triggerA && triggerA.summary.status === 'active' && triggerA.summary.lastActiveAt > baselineA.summary.lastActiveAt,
    )
    await ev.shot(shell.page, 'a2-unread-a-lit')
    ev.assert('A: 会话 A 未读点亮（新投递触发）', aLit === true, {
      channel: 'A', expected: 'session-row-unread 出现于 A 行', actual: aLit ? '未读点可见' : '30s 内未亮',
    })
    ev.assert('B: A 触发帧形态 = 仅 lastActiveAt 推进（status 恒 active，新投递写点）', aPureDelivery, {
      channel: 'B',
      expected: `trigger.status=active ∧ lastActiveAt > baseline（baseline=${describeFrame(baselineA)}）`,
      actual: describeFrame(triggerA),
    })

    // ── 触发帧 2（B = 新终态）：abort 终态帧翻转点亮（B2 二轮已在开壳前发起并保持流式，
    // 快照基线 = {active}）──
    const baselineB = framesFor(protocol, sidB).at(-1) ?? null
    const framesBBefore = framesFor(protocol, sidB).length
    const sinceB = protocol.events.length
    await protocol.call('message.abort', { sessionId: sidB })
    const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 60_000 })
    await pollFor(() => framesFor(protocol, sidB).length > framesBBefore, { timeoutMs: 15_000 }) // 等终态帧到协议侧再捕获
    const bLit = await pollFor(async () => (await rowHasUnread(shell.page, sidB)) === true, { timeoutMs: 30_000 })
    const triggerB = framesFor(protocol, sidB).at(-1) ?? null
    const bPureTerminal = Boolean(
      baselineB && triggerB && baselineB.summary.status === 'active' && triggerB.summary.status !== 'active' && triggerB.summary.lastActiveAt === baselineB.summary.lastActiveAt,
    )
    await ev.shot(shell.page, 'a2-unread-b-lit')
    ev.assert('B: 会话 B 回合中止收尾（终态广播前提）', endB.type === 'message.complete' || endB.type === 'message.error', {
      channel: 'B', expected: 'message.complete（stopReason=aborted 族）', actual: `${endB.type} stop=${endB.payload?.stopReason ?? ''}`,
    })
    ev.assert('A: 会话 B 未读点亮（新终态触发）', bLit === true, {
      channel: 'A', expected: 'session-row-unread 出现于 B 行', actual: bLit ? '未读点可见' : '30s 内未亮',
    })
    ev.assert('B: B 触发帧形态 = status 翻转且 lastActiveAt 不变（终态写点，非新投递）', bPureTerminal, {
      channel: 'B',
      expected: `baseline.status=active ∧ trigger.status≠active ∧ lastActiveAt 相同（baseline=${describeFrame(baselineB)}）`,
      actual: describeFrame(triggerB),
    })

    // ── 分组断言：A 在「进行中」组、B 在「最近」组 ──
    const groupA = await rowGroupId(shell.page, sidA)
    const groupB = await rowGroupId(shell.page, sidB)
    await ev.shot(shell.page, 'a2-grouping')
    ev.assert('A: 分组正确——A（流式中）落「进行中」组', groupA === 'sessions-group-active', {
      channel: 'A', expected: 'sessions-group-active', actual: groupA ?? '行不存在',
    })
    ev.assert('A: 分组正确——B（已终态）落「最近」组', groupB === 'sessions-group-recent', {
      channel: 'A', expected: 'sessions-group-recent', actual: groupB ?? '行不存在',
    })

    // ── 点入即清：A 清、B 保留；再 B 清 ──
    const enteredA = await openSessionByRow(shell.page, sidA)
    ev.step({ step: 'drive.enter-A', channel: 'A', exitCode: enteredA ? 0 : 1, stats: { sid: sidA } })
    const backA = enteredA ? await backToList(shell.page) : false
    const aUnreadAfterVisit = backA ? await rowHasUnread(shell.page, sidA) : null
    const bUnreadKept = backA ? await rowHasUnread(shell.page, sidB) : null
    await ev.shot(shell.page, 'a2-after-visit-a')
    ev.assert('A: 点入 A 返回后 A 未读清（markSessionVisited）', aUnreadAfterVisit === false, {
      channel: 'A', expected: 'A 行无未读点', actual: aUnreadAfterVisit === null ? '返回列表失败' : aUnreadAfterVisit ? '未读点仍在' : '已清',
    })
    ev.assert('A: B 未读不受 A 点入影响（按会话隔离）', bUnreadKept === true, {
      channel: 'A', expected: 'B 行未读点保留', actual: bUnreadKept === null ? '返回列表失败' : bUnreadKept ? '保留' : '被误清',
    })

    const enteredB = await openSessionByRow(shell.page, sidB)
    const backB = enteredB ? await backToList(shell.page) : false
    const bUnreadAfterVisit = backB ? await rowHasUnread(shell.page, sidB) : null
    await ev.shot(shell.page, 'a2-after-visit-b')
    ev.assert('A: 点入 B 返回后 B 未读清', bUnreadAfterVisit === false, {
      channel: 'A', expected: 'B 行无未读点', actual: bUnreadAfterVisit === null ? '返回列表失败' : bUnreadAfterVisit ? '未读点仍在' : '已清',
    })

    // C 通道：lastVisitedAt 持久条目（点入即清的落盘对照源写侧）
    const visitedKeys = await shell.page
      .evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('taiji.mobile.lastVisited.')))
      .catch(() => [])
    ev.assert('C: localStorage 落两会话 lastVisitedAt 条目（taiji.mobile.lastVisited.<sid>）', visitedKeys.includes(`taiji.mobile.lastVisited.${sidA}`) && visitedKeys.includes(`taiji.mobile.lastVisited.${sidB}`), {
      channel: 'C',
      expected: `含 ${sidA} 与 ${sidB} 两键`,
      actual: `keys=${visitedKeys.length}`,
    })

    // 证据：两会话的完整帧序列（触发帧形态复核面）
    ev.attach('a2-session-frames', JSON.stringify({
      sidA: framesFor(protocol, sidA).map(describeFrame),
      sidB: framesFor(protocol, sidB).map(describeFrame),
    }, null, 2))
  } finally {
    if (shell.pageErrors.length > 0) ev.attach('a2-page-errors', shell.pageErrors.join('\n---\n'))
    await closeShell(shell)
    ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
  }

  log(`done A=${sidA} B=${sidB}`)
  return { uncovered, gotchas }
}

/** 协议侧收到的该会话 config.sessions 摘要帧（order 保留；「桌面推进」的 B 通道事实读侧）。 */
function framesFor(protocol, sid) {
  const out = []
  for (const evt of protocol.events) {
    if (evt.type !== 'config.sessions') continue
    const flat = (evt.payload?.groups ?? []).flatMap((g) => g.sessions ?? [])
    const hit = flat.find((s) => s.id === sid)
    if (hit) out.push({ receivedAt: evt.receivedAt, summary: { status: hit.status, lastActiveAt: hit.lastActiveAt } })
  }
  return out
}

function describeFrame(frame) {
  if (!frame) return '(无帧)'
  return `status=${frame.summary.status} lastActiveAt=${frame.summary.lastActiveAt} @${frame.receivedAt}`
}
