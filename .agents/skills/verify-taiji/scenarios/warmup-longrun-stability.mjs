/**
 * warmup-longrun-stability —— 预热槽长跑稳定剧本（会话冷切换性能优化 dev-0.12.1-cfcbd4bd）。
 *
 * 覆盖设计 §4.1 场景 4 前半（impl-plan 断言点 A4，P2 定案载体）：
 * - 启动后放置 30 分钟（等时步长可配置缩短）→ 点击冷会话：附着成功、消息流干净
 *   （无前一会话内容串入）；
 * - 探活/补位按预期运转（放置期间槽进程存活；放置后消费再次触发补位）；
 * - 消费路径槽状态分布日志可读（命中/参数不匹配/槽空/进程死四态可判读，P4 观测点）。
 *
 * 等时步长：`COLD_SWITCH_LONGRUN_MS` 显式覆盖 > smoke 模式（COLD_SWITCH_SMOKE=1）
 * 默认 60s > 设计值 30 分钟。D3 实跑不带任何 env = 全量 30 分钟。
 *
 * smoke 降级：长跑观测（槽探活轨迹 / 四态日志 / 放置后补位）依赖 u2 交付物，实现
 * 未落地时原理上不可判 → 登记 uncovered；「附着成功 / 消息流干净」现状即真，照常执行。
 */
import {
  allSignatureTexts,
  anySignatureText,
  findWarmupPidFromLog,
  firstScreenTimeoutMs,
  flattenSessionList,
  isAlive,
  isSmokeMode,
  locateSidebarSession,
  longrunHoldMs,
  measureFirstPaint,
  pickLargestSession,
  pickSessionsWithSignatures,
  piChildPids,
  pollUntil,
  readLatestTurn,
  readRuntimeLog,
  readRuntimePort,
  readStreamText,
  runtimePidOf,
  scanSessionPool,
  seedSessions,
  warmupProbeIntervalMs,
  waitForLatestTurnVisible,
  PROD_DATA_DIR,
} from './lib/cold-switch-lib.mjs'

/** 放置后验证附着的目标会话（冷会话，未打开过）。 */
const POST_HOLD_TARGETS = 2

export const meta = {
  id: 'warmup-longrun-stability',
  priority: 'P0',
  title: '预热进程长跑稳定（A4）：放置等时 → 附着稳定 + 消息流干净 + 探活/补位/四态日志可判读',
  covers: ['env.launch', 'env.ready', 'session.list', 'session.switch', 'evidence.logs'],
  requires: ['u1-history-fastpath', 'u2-warmup-slot', 'u3-renderer-merge'],
  estimateSec: isSmokeMode() ? 600 : 2400,
  provable: [
    'A4: 放置（默认 30 分钟，可配置缩短）后点击冷会话附着成功（首屏渲染）',
    'A4: 消息流干净——流含目标会话独有内容，无前一会话内容串入',
    'A4: 放置期间槽进程探活轨迹记录（存活性按 warmupProbeIntervalMs 采样）',
    'A4: 放置后消费再次触发补位（pi 子进程数回升）',
    'A4: 消费路径槽状态分布日志四态可判读（P4 观测点）',
  ],
  notProvable: [
    '长跑观测（探活轨迹/四态日志/补位回升）依赖 u2 交付——smoke 模式下登记 uncovered，D3 实跑执行',
    '槽进程空载内存水位（设计 §5 检查点③，属 U2 实现期记录，非本剧本断言对象）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const smoke = isSmokeMode()
  const holdMs = longrunHoldMs()
  const probeMs = warmupProbeIntervalMs()
  const uncovered = []
  const gotchas = []

  // ── 段 0：fixture → 冷启动 → 首次冷切（触发消费驱动补位） ───────────
  await instance.stop()
  ev.step({ step: 'instance.stop-for-seed', channel: 'C', exitCode: 0, stats: { dataDir, holdMs, probeMs, smoke } })

  const pool = scanSessionPool(PROD_DATA_DIR)
  const big = pickLargestSession(pool)
  const exclusion = new Set(big ? [big.sessionFile] : [])
  // 实跑 = 最大样本 + 次大候选（字节压力下的附着验证）；smoke = 小会话快切。
  // 只保留带尾部签名的会话（消息流干净断言强判据覆盖）。
  const { picked: roster, signatures } = pickSessionsWithSignatures(pool, {
    count: 1 + POST_HOLD_TARGETS,
    picker: (p) => {
      const base = p.filter((s) => !exclusion.has(s.sessionFile))
      const ordered = smoke ? base.sort((a, b) => a.bytes - b.bytes) : base.sort((a, b) => b.bytes - a.bytes)
      return big && !smoke ? [big, ...ordered] : ordered
    },
  })
  const seeded = seedSessions(dataDir, PROD_DATA_DIR, roster)
  ev.step({
    step: 'fixture.seed-sessions',
    channel: 'C',
    exitCode: 0,
    stats: {
      seeded: seeded.length,
      roster: roster.map((s) => ({ sid: s.sessionId, mb: +(s.bytes / 1_000_000).toFixed(1) })),
      holdMs,
      signatureHit: [...signatures.values()].filter((g) => g.lastUser || g.lastAssistant).length,
    },
  })
  ev.assert('种子：会话池 ≥1+2 个（首次消费 1 + 放置后冷切 2）', roster.length >= 1 + POST_HOLD_TARGETS, {
    channel: 'C',
    expected: `≥${1 + POST_HOLD_TARGETS}`,
    actual: String(roster.length),
  })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({
    step: 'launch-ready',
    channel: 'C',
    exitCode: 0,
    stats: { runtimePort: ready.runtimePort, extensions: ready.extensions, elapsedMs: ready.elapsedMs },
  })

  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
  try {
    const list = await proto.call('session.list', {}, { replyType: 'session.list', timeoutMs: 60_000 })
    const rows = flattenSessionList(list)
    const rosterRows = roster.map((s) => rows.find((r) => r.id === s.sessionId)).filter(Boolean)
    ev.assert('种子：会话池全部被 runtime 纳管', rosterRows.length === roster.length, {
      channel: 'B',
      expected: `${roster.length}`,
      actual: `${rosterRows.length}`,
    })
    const page = await instance.page()

    // 首次冷切消费（预热槽首次发火 = 首次冷切消费后的消费驱动补位，设计 §3.3-5）
    const firstRow = rosterRows[0]
    const firstLocator = await locateSidebarSession(page, { projectId: firstRow.projectId, label: firstRow.label })
    await firstLocator.click()
    await waitForLatestTurnVisible(page, { timeoutMs: firstScreenTimeoutMs() })
    ev.step({
      step: 'consume-first',
      channel: 'A',
      exitCode: 0,
      stats: { sid: firstRow.id, label: firstRow.label },
    })

    const runtimePid = runtimePidOf(dataDir)
    let slotPid = null
    if (runtimePid) {
      try {
        await pollUntil(() => piChildPids(runtimePid).length >= 2, {
          timeoutMs: 30_000,
          label: '预热补位进程出现（pi 子进程 ≥2）',
        })
        // pid 定位：日志解析优先，fallback = 最新 pi 子进程（与 warmup-resilience 同口径）
        slotPid = findWarmupPidFromLog(readRuntimeLog(dataDir))
        if (!slotPid) {
          const children = piChildPids(runtimePid)
          slotPid = children[children.length - 1]?.pid ?? null
        }
      } catch {
        /* 补位未出现（实现未落地或补位失败）：断言段按 smoke/实跑分流处置 */
      }
    }
    ev.step({
      step: 'warmup-slot-detect',
      channel: 'C',
      exitCode: slotPid ? 0 : 1,
      stats: { runtimePid, slotPid, alive: slotPid ? isAlive(slotPid) : null, smoke },
    })
    ev.assert(
      smoke ? 'A4(smoke): 槽进程定位降级 uncovered' : 'A4: 预热槽进程就位（首次消费驱动补位运转）',
      smoke ? true : Boolean(slotPid),
      { channel: 'C', expected: '槽 pid', actual: slotPid ? String(slotPid) : '未检出' },
    )
    if (smoke) uncovered.push('A4 槽进程定位与补位观测（smoke：u2 未落地，D3 实跑执行）')

    // ── 段 1：放置等时（探活采样轨迹） ──────────────────────────────
    const probes = []
    const holdStart = Date.now()
    while (Date.now() - holdStart < holdMs) {
      await new Promise((r) => setTimeout(r, Math.min(probeMs, Math.max(0, holdMs - (Date.now() - holdStart)))))
      probes.push({
        at: Date.now() - holdStart,
        slotAlive: slotPid ? isAlive(slotPid) : null,
        piChildren: runtimePid ? piChildPids(runtimePid).length : null,
      })
    }
    const aliveAllAlong = slotPid ? probes.every((p) => p.slotAlive) : null
    ev.step({
      step: 'hold-elapsed',
      channel: 'C',
      exitCode: 0,
      stats: {
        holdMs,
        probeCount: probes.length,
        probeIntervalMs: probeMs,
        aliveAllAlong,
        firstProbe: probes[0] ?? null,
        lastProbe: probes[probes.length - 1] ?? null,
      },
    })
    ev.attach('warmup-probe-trace', JSON.stringify(probes, null, 2))
    ev.assert(
      smoke ? 'A4(smoke): 放置期间探活断言降级 uncovered' : 'A4: 放置期间槽进程探活全程存活（探活按预期运转）',
      smoke ? true : Boolean(aliveAllAlong),
      {
        channel: 'C',
        expected: `每次采样 slotAlive=true（${probes.length} 次）`,
        actual: aliveAllAlong === null ? '无槽 pid 可探' : `${probes.filter((p) => p.slotAlive).length}/${probes.length} 存活`,
      },
    )
    if (smoke) uncovered.push('A4 放置期间槽探活轨迹断言（smoke：D3 实跑执行）')

    // ── 段 2：放置后附着稳定 + 消息流干净 ───────────────────────────
    let prevSid = firstRow.id
    let prevSig = signatures.get(prevSid)
    for (const [i, r] of rosterRows.slice(1, 1 + POST_HOLD_TARGETS).entries()) {
      const locator = await locateSidebarSession(page, { projectId: r.projectId, label: r.label })
      const paint = await measureFirstPaint(page, () => locator.click(), { timeoutMs: firstScreenTimeoutMs() })
      const mineSig = signatures.get(r.id)
      const mineText = anySignatureText(mineSig)
      ev.step({
        step: `post-hold-attach-${i + 1}`,
        channel: 'A',
        exitCode: paint.text.length > 0 ? 0 : 1,
        stats: { sid: r.id, elapsedMs: paint.elapsedMs, turnCount: paint.turnCount },
      })
      ev.assert(`A4[${i + 1}]: 放置后点击冷会话附着成功`, paint.text.length > 0, {
        channel: 'A',
        expected: 'turn 渲染非空',
        actual: `turnCount=${paint.turnCount}`,
      })
      // 头尾双锚兼容（现状首屏=头部窗口 / 尾读交付=尾部窗口）；前会话头尾签名都不得串入
      const streamText = await readStreamText(page)
      const mineOk = mineSig
        ? allSignatureTexts(mineSig).some((t) => streamText.includes(t.slice(0, 40)))
        : paint.text.length > 0
      const prevTexts = prevSig ? allSignatureTexts(prevSig) : []
      const leakOk = prevTexts.every((t) => !streamText.includes(t.slice(0, 40)))
      ev.assert(`A4[${i + 1}]: 消息流干净（本会话内容在场、前会话内容未串入）`, mineOk && leakOk, {
        channel: 'A',
        expected: `含本会话签名${mineText ? `「${mineText.slice(0, 30)}」` : ''} 且不含前会话签名`,
        actual: `mine=${mineOk} leak=${!leakOk}`,
      })
      // 更新「前会话」为当前（连切两轮，第二轮防第一轮目标串入）
      prevSig = signatures.get(r.id)
      prevSid = r.id
    }

    // ── 段 3：消费路径四态日志可判读 + 放置后补位回升 ────────────────
    const logText = readRuntimeLog(dataDir)
    const fourStates = ['命中', 'hit', '参数不匹配', 'mismatch', '槽空', 'empty', '进程死', 'dead']
    const warmupLines = logText.split('\n').filter((l) => /warmup/i.test(l))
    const readableStates = fourStates.filter((s) => warmupLines.some((l) => l.includes(s)))
    ev.step({
      step: 'p4-slot-state-log',
      channel: 'C',
      exitCode: readableStates.length > 0 ? 0 : 1,
      stats: { warmupLineCount: warmupLines.length, readableStates, smoke },
    })
    ev.assert(
      smoke ? 'A4(smoke): 四态日志判读降级 uncovered' : 'A4: 消费路径槽状态分布日志可判读（P4 观测点）',
      smoke ? true : readableStates.length > 0,
      {
        channel: 'C',
        expected: '命中/参数不匹配/槽空/进程死至少一态可判读',
        actual: readableStates.length > 0 ? readableStates.join(',') : `${warmupLines.length} 行 warmup 日志无可判读态`,
      },
    )
    if (smoke) uncovered.push('A4 四态日志判读断言（smoke：D3 实跑执行）')

    // 放置后消费已发生（段 2 的两次冷切）→ 补位回升：pi 子进程数 ≥2（附着目标进程 + 新槽）
    let replenished = null
    if (runtimePid) {
      try {
        await pollUntil(() => piChildPids(runtimePid).length >= 2, {
          timeoutMs: 30_000,
          label: '放置后补位回升（pi 子进程 ≥2）',
        })
        replenished = true
      } catch {
        replenished = false
      }
    }
    ev.step({
      step: 'post-hold-replenish',
      channel: 'C',
      exitCode: replenished ? 0 : 1,
      stats: { replenished, piChildren: runtimePid ? piChildPids(runtimePid).length : null, smoke },
    })
    ev.assert(
      smoke ? 'A4(smoke): 补位回升断言降级 uncovered' : 'A4: 放置后消费再次触发补位（补位按预期运转）',
      smoke ? true : Boolean(replenished),
      { channel: 'C', expected: 'pi 子进程 ≥2', actual: replenished ? '已回升' : '未回升' },
    )
    if (smoke) uncovered.push('A4 放置后补位回升断言（smoke：D3 实跑执行）')

    // 收尾稳定态：最近消息仍在视口（长跑+切换后渲染稳定）
    const finalTurn = await readLatestTurn(page)
    ev.assert('A4 收尾: 最近消息仍可见（序列终点稳定态）', Boolean(finalTurn?.inViewport), {
      channel: 'A',
      expected: '最后 turn 在视口内',
      actual: finalTurn ? `turnCount=${finalTurn.turnCount}` : '(无 turn)',
    })
  } finally {
    await proto.close().catch(() => {})
  }

  if (uncovered.length === 0) log('warmup-longrun-stability: 全部断言通过')
  else log(`warmup-longrun-stability: ${uncovered.length} 项 uncovered（smoke=${smoke} holdMs=${holdMs}）`)
  return { uncovered, gotchas }
}
