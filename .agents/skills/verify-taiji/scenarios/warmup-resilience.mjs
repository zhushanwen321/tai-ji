/**
 * warmup-resilience —— 预热槽韧性剧本（会话冷切换性能优化 dev-0.12.1-cfcbd4bd）。
 *
 * 覆盖设计 §4.1 场景表两行（断言点按 impl-plan acceptancePlan 编号）：
 * - A3（场景 3）预热失效兜底：kill 预热进程 pid → 立即点击冷会话 → 切换仍成功
 *   （时长 = 现状）；runtime 日志含 fallback 记录；无错误界面。
 * - A7（场景 4 后半）连续冷切 5 会话消息归属无串话：依次点击 5 个从未打开过的会话
 *   （每次都是冷切），每次断言对话流含本会话独有内容、不含其他 4 个会话的内容。
 *
 * 数据口径：生产数据目录副本的真实绑定会话（C-proc-26：只拷贝不直连）。实跑连切
 * 序列含 42MB 大会话；smoke 模式（COLD_SWITCH_SMOKE=1）用小会话控制时长。
 *
 * smoke 降级：A3 的预热补位/kill/fallback 日志依赖 u2（warmup-pi-slot.ts）交付物，
 * 实现未落地时原理上不可判 → 登记 uncovered；「切换成功 / 无错误界面 / 串话隔离」
 * 现状即真，照常执行。
 */
import {
  allSignatureTexts,
  anySignatureText,
  findWarmupPidFromLog,
  firstScreenTimeoutMs,
  flattenSessionList,
  isSmokeMode,
  locateSidebarSession,
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
  waitForLatestTurnVisible,
  waitForToast,
  PROD_DATA_DIR,
} from './lib/cold-switch-lib.mjs'

/** A7 连续冷切会话数（设计场景 4：连续冷切 5 个不同会话）。 */
const ISOLATION_ROUNDS = 5

export const meta = {
  id: 'warmup-resilience',
  priority: 'P0',
  title: '预热失效兜底（A3）+ 连续冷切 5 会话无串话（A7）',
  covers: ['env.launch', 'env.ready', 'session.list', 'session.switch', 'evidence.logs'],
  requires: ['u1-history-fastpath', 'u2-warmup-slot', 'u3-renderer-merge'],
  estimateSec: isSmokeMode() ? 900 : 900,
  provable: [
    'A3: kill 预热进程后立即点击冷会话，切换仍成功（首屏渲染）',
    'A3: runtime 日志含预热槽 fallback 记录（消费路径四态之一「进程死」可判读）',
    'A3: 切换无错误界面（无「切换会话失败」toast）',
    'A7: 连续冷切 5 个会话，每次对话流含本会话独有尾部内容且不含其他 4 个会话的内容',
  ],
  notProvable: [
    'A3 预热补位观测与 fallback 日志依赖 u2 交付（smoke 模式下登记 uncovered，D3 实跑执行）',
    '预热进程 pid 的精确归属（实跑按日志解析优先、进程树最新子进程兜底——日志格式冻结后应收紧）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const smoke = isSmokeMode()
  const uncovered = []
  const gotchas = []

  // ── 段 0：fixture（连切序列 5 会话 + 预热触发会话 1 个） → 冷启动 ──
  await instance.stop()
  ev.step({ step: 'instance.stop-for-seed', channel: 'C', exitCode: 0, stats: { dataDir } })

  const pool = scanSessionPool(PROD_DATA_DIR)
  const big = pickLargestSession(pool)
  const exclusion = new Set(big ? [big.sessionFile] : [])
  // 实跑连切序列 = 最大样本 + 次大候选（字节压力下的归属隔离）；smoke = 小会话快切。
  // 只保留带尾部签名的会话（串话断言强判据覆盖）。
  const { picked: isolationRoster, signatures } = pickSessionsWithSignatures(pool, {
    count: ISOLATION_ROUNDS + 1,
    picker: (p) => {
      const base = p.filter((s) => !exclusion.has(s.sessionFile))
      const ordered = smoke ? base.sort((a, b) => a.bytes - b.bytes) : base.sort((a, b) => b.bytes - a.bytes)
      return big && !smoke ? [big, ...ordered] : ordered
    },
  })

  ev.assert(`种子：连切序列 ≥${ISOLATION_ROUNDS} 个会话（带签名判据）`, isolationRoster.length >= ISOLATION_ROUNDS, {
    channel: 'C',
    expected: `≥${ISOLATION_ROUNDS}`,
    actual: `${isolationRoster.length} 个（smoke=${smoke}，字节 ${(isolationRoster.reduce((n, s) => n + s.bytes, 0) / 1_000_000).toFixed(1)}MB）`,
  })

  const seeded = seedSessions(dataDir, PROD_DATA_DIR, isolationRoster)
  ev.step({
    step: 'fixture.seed-sessions',
    channel: 'C',
    exitCode: 0,
    stats: {
      seeded: seeded.length,
      roster: isolationRoster.map((s) => ({ sid: s.sessionId, mb: +(s.bytes / 1_000_000).toFixed(1) })),
      signatureHit: [...signatures.values()].filter((g) => g.lastUser || g.lastAssistant).length,
    },
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
    const rosterRows = isolationRoster.map((s) => rows.find((r) => r.id === s.sessionId)).filter(Boolean)
    ev.assert('种子：连切序列全部被 runtime 纳管', rosterRows.length >= ISOLATION_ROUNDS, {
      channel: 'B',
      expected: `≥${ISOLATION_ROUNDS}`,
      actual: `${rosterRows.length}/${isolationRoster.length}`,
    })
    const page = await instance.page()

    // ── 段 1：A3 预热失效兜底 ───────────────────────────────────────
    // 步骤 1：点击首个会话 W（消费槽 + 触发消费驱动补位）
    const warmRow = rosterRows[0]
    const warmLocator = await locateSidebarSession(page, { projectId: warmRow.projectId, label: warmRow.label })
    await warmLocator.click()
    await waitForLatestTurnVisible(page, { timeoutMs: firstScreenTimeoutMs() })
    ev.step({
      step: 'a3.consume-first',
      channel: 'A',
      exitCode: 0,
      stats: { sid: warmRow.id, label: warmRow.label },
    })

    // 步骤 2：等预热补位进程出现（runtime 的 pi 子进程数 ≥2：W 进程 + 预热进程）
    const runtimePid = runtimePidOf(dataDir)
    let warmupPid = null
    let warmupDetected = false
    if (runtimePid) {
      try {
        await pollUntil(() => piChildPids(runtimePid).length >= 2, {
          timeoutMs: 30_000,
          label: '预热补位进程出现（pi 子进程 ≥2）',
        })
        warmupDetected = true
      } catch {
        warmupDetected = false
      }
      // pid 定位：日志解析优先，fallback = 最新 pi 子进程（补位 spawn 晚于 W 进程）
      warmupPid = findWarmupPidFromLog(readRuntimeLog(dataDir))
      if (!warmupPid && warmupDetected) {
        const children = piChildPids(runtimePid)
        warmupPid = children[children.length - 1]?.pid ?? null
      }
    }
    ev.step({
      step: 'a3.warmup-slot-detect',
      channel: 'C',
      exitCode: warmupPid ? 0 : 1,
      stats: { runtimePid, warmupDetected, warmupPid, smoke },
    })
    ev.assert(
      smoke ? 'A3(smoke): 预热补位观测降级 uncovered' : 'A3: 预热补位进程可定位（消费驱动补位运转）',
      smoke ? true : Boolean(warmupPid),
      { channel: 'C', expected: '预热槽 pid', actual: warmupPid ? String(warmupPid) : '未检出（补位未运转或日志无 pid）' },
    )
    if (smoke) uncovered.push('A3 预热补位观测（smoke：u2 未落地，D3 实跑执行）')

    // 步骤 3：kill 预热进程 → 立即点击冷会话 X
    const coldRow = rosterRows[1]
    let killed = false
    if (warmupPid) {
      try {
        process.kill(warmupPid, 'SIGKILL')
        killed = true
      } catch (e) {
        gotchas.push(`预热 pid kill 失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    ev.step({ step: 'a3.kill-warmup', channel: 'C', exitCode: killed ? 0 : 1, stats: { warmupPid, killed } })

    const coldLocator = await locateSidebarSession(page, { projectId: coldRow.projectId, label: coldRow.label })
    const fallbackSwitch = await measureFirstPaint(page, () => coldLocator.click(), { timeoutMs: firstScreenTimeoutMs() })
    ev.step({
      step: 'a3.fallback-switch',
      channel: 'A',
      exitCode: 0,
      stats: { elapsedMs: fallbackSwitch.elapsedMs, sid: coldRow.id, turnCount: fallbackSwitch.turnCount },
    })
    ev.assert('A3: kill 预热进程后点击冷会话，切换仍成功（首屏渲染）', fallbackSwitch.text.length > 0, {
      channel: 'A',
      expected: 'turn 渲染非空',
      actual: `turnCount=${fallbackSwitch.turnCount}`,
    })

    // runtime 日志含 fallback 记录（消费路径四态「进程死」→ 兜底转移）
    const runtimeLogText = readRuntimeLog(dataDir)
    const fallbackLine = runtimeLogText
      .split('\n')
      .find((l) => /warmup/i.test(l) && /fallback|进程死|dead|不匹配|mismatch|槽空|empty/i.test(l))
    ev.step({
      step: 'a3.fallback-log',
      channel: 'C',
      exitCode: fallbackLine ? 0 : 1,
      stats: { hit: Boolean(fallbackLine), line: fallbackLine?.slice(0, 200) ?? null, smoke },
    })
    ev.assert(
      smoke ? 'A3(smoke): fallback 日志断言降级 uncovered' : 'A3: runtime 日志含预热槽 fallback 记录',
      smoke ? true : Boolean(fallbackLine),
      { channel: 'C', expected: 'warmup 消费路径四态记录（进程死→fallback）', actual: fallbackLine?.slice(0, 200) ?? '无匹配行' },
    )
    if (smoke) uncovered.push('A3 fallback 日志断言（smoke：u2 未落地，D3 实跑执行）')

    // 无错误界面：切换路径无「切换会话失败」toast
    let errorToastAbsent = true
    try {
      await waitForToast(page, { textPattern: /切换会话失败|Failed to switch session/, timeoutMs: 3_000 })
      errorToastAbsent = false
    } catch {
      errorToastAbsent = true
    }
    ev.assert('A3: 无错误界面（无切换失败 toast）', errorToastAbsent, {
      channel: 'A',
      expected: '无失败 toast',
      actual: errorToastAbsent ? '无' : '出现失败 toast',
    })

    // ── 段 2：A7 连续冷切 5 会话无串话 ──────────────────────────────
    // 序列从 rosterRows[1] 起（rosterRows[0] 已在 A3 打开——A7 要求每个会话都是冷切，
    // 取未打开过的 5 个；roster 种了 ISOLATION_ROUNDS+1 个保证余量）
    const isolationRows = rosterRows.slice(1, 1 + ISOLATION_ROUNDS)
    ev.assert(`A7: 未打开过的冷切序列 ≥${ISOLATION_ROUNDS} 个`, isolationRows.length >= ISOLATION_ROUNDS, {
      channel: 'B',
      expected: `≥${ISOLATION_ROUNDS}`,
      actual: String(isolationRows.length),
    })

    const foreignSignatures = new Map() // sid -> 判据文本（其他会话的签名，断言缺席用）
    for (const r of isolationRows) {
      const sig = signatures.get(r.id)
      foreignSignatures.set(r.id, sig?.lastUser ?? sig?.lastAssistant ?? null)
    }

    for (const [i, r] of isolationRows.entries()) {
      const locator = await locateSidebarSession(page, { projectId: r.projectId, label: r.label })
      const paint = await measureFirstPaint(page, () => locator.click(), { timeoutMs: firstScreenTimeoutMs() })
      const mineSig = foreignSignatures.get(r.id)
      const mine = anySignatureText(mineSig)
      // 头尾双锚兼容：现状首屏=头部窗口（头部签名命中），尾读交付=尾部窗口（尾部签名命中）
      const mineTexts = mineSig ? allSignatureTexts(mineSig) : []
      const mineHit = mineTexts.length > 0 ? mineTexts.some((t) => paint.text.includes(t.slice(0, 40))) : paint.text.length > 0
      ev.step({
        step: `a7.cold-switch-${i + 1}`,
        channel: 'A',
        exitCode: mineHit ? 0 : 1,
        stats: { sid: r.id, elapsedMs: paint.elapsedMs, turnCount: paint.turnCount, mineHit },
      })
      ev.assert(`A7[${i + 1}]: 切入 ${r.id} 后流含本会话独有内容（归属正确）`, mineHit, {
        channel: 'A',
        expected: mine ? `含「${mine.slice(0, 40)}」（头/尾任一）` : 'turn 非空',
        actual: paint.text.slice(0, 80) || '(空)',
      })

      // 无串话：其余 4 个会话的头尾签名都不在当前流中
      const streamText = await readStreamText(page)
      const leaks = []
      for (const [otherSid, sig] of foreignSignatures) {
        if (otherSid === r.id || !sig) continue
        if (allSignatureTexts(sig).some((t) => streamText.includes(t.slice(0, 40)))) leaks.push(otherSid)
      }
      ev.assert(`A7[${i + 1}]: 消息归属无串话（其余会话内容未出现）`, leaks.length === 0, {
        channel: 'A',
        expected: '0 个他方签名',
        actual: leaks.length === 0 ? '0 个' : `泄漏自 ${leaks.join(',')}`,
      })
    }

    // 收尾结构断言：最后会话的最近消息仍可见（序列终点稳定态）
    const finalTurn = await readLatestTurn(page)
    ev.assert('A7 收尾: 序列终点最近消息可见', Boolean(finalTurn?.inViewport), {
      channel: 'A',
      expected: '最后 turn 在视口内',
      actual: finalTurn ? `turnCount=${finalTurn.turnCount} inViewport=${finalTurn.inViewport}` : '(无 turn)',
    })
  } finally {
    await proto.close().catch(() => {})
  }

  if (uncovered.length === 0) log('warmup-resilience: 全部断言通过')
  else log(`warmup-resilience: ${uncovered.length} 项 uncovered（smoke=${smoke}）`)
  return { uncovered, gotchas }
}
