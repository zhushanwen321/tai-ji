/**
 * cold-switch-primary —— 会话冷切换性能优化（dev-0.12.1-cfcbd4bd）主剧本。
 *
 * 覆盖设计 §4.1 场景表三行（断言点按 impl-plan acceptancePlan 编号）：
 * - A1（场景 1）冷启动首点大会话：首屏（最近消息可见）≤500ms（尾读）；输入框可用
 *   ≈1-1.5s 内；10s 内更早历史补齐且无跳变闪烁。
 * - A2（场景 2）缓存逐出后重切：依次切 9+ 会话挤出目标 → 切回目标会话，同场景 1 标准。
 * - A6（场景 6）pi 完全不可用时数据层仍可读：① getHistory 尾读 RPC 成功（reply 含
 *   预算窗口内消息、无 error）；② 显示层按现状 switch 失败语义（不切入 + toast
 *   「切换会话失败」+ 无崩溃）；③ 恢复 pi 后再次点击切换成功。
 *
 * 数据口径：42MB 大会话样本 + 小会话逐出池全部取自生产数据目录副本
 * （~/.taiji/agent/sessions 真实绑定会话，C-proc-26 禁止非打包进程持生产树值，
 * 验收只拷贝不直连）。种子 = jsonl + sidecar 家族拷进实例数据目录。
 *
 * smoke 模式（COLD_SWITCH_SMOKE=1，D1 组装期对样本数据实跑）：现状全量恢复路径
 * 照跑（超时放宽），依赖 U1/U2/U3 交付物的目标断言（≤500ms 阈值 / 1.5s composer /
 * 10s 补齐帧 / 尾读 RPC）降级为 uncovered 登记——实现未落地时这些断言原理上不可判；
 * 结构断言（切换成功 / toast 失败语义 / 置换恢复）现状即真，照常执行。
 */
import fs from 'node:fs'

import {
  allSignatureTexts,
  anySignatureText,
  extractSessionSignatures,
  firstScreenTimeoutMs,
  firstPaintTolerant,
  flattenSessionList,
  isSmokeMode,
  locateSidebarSession,
  pickLargestSession,
  pickSmallSessions,
  pollUntil,
  readLatestTurn,
  readRuntimePort,
  readStreamText,
  restorePiBinary,
  scanSessionPool,
  seedSessions,
  swapPiBinary,
  waitForLatestTurnVisible,
  waitForToast,
  PROD_DATA_DIR,
} from './lib/cold-switch-lib.mjs'

/** A2 逐出循环会话数（设计场景 2：依次切 9+ 个会话挤出目标）。 */
const EVICTION_ROUNDS = 9

/** 首屏阈值（设计场景 1：≤500ms，尾读快路径）。 */
const FIRST_PAINT_BUDGET_MS = 500

/** 输入框可用预算（设计场景 1：≈1-1.5s 内 = 首屏 + 现场 spawn）。 */
const COMPOSER_BUDGET_MS = 1_500

/** 全量补齐窗口（设计场景 1：10s 内更早历史补齐）。 */
const FULL_HISTORY_WINDOW_MS = 10_000

export const meta = {
  id: 'cold-switch-primary',
  priority: 'P0',
  title: '冷切换主链：冷启动首点 42MB 会话（A1）+ 缓存逐出重切（A2）+ pi 不可用数据层可读（A6）',
  covers: ['env.launch', 'env.ready', 'session.list', 'session.switch', 'session.history', 'evidence.logs'],
  requires: ['u1-history-fastpath', 'u3-renderer-merge'],
  estimateSec: isSmokeMode() ? 900 : 600,
  provable: [
    'A1: 冷启动后点击 42MB 会话，首屏（最近消息可见）elapsed ≤500ms（尾读快路径）',
    'A1: 点击后 ≈1.5s 内输入框可用（composer-box 未禁用）',
    'A1: 10s 内 session.historyCacheReady 帧到达且补齐后最近消息不跳变（尾部签名一致）',
    'A2: 依次切 9 个会话逐出目标缓存后，切回 42MB 会话同场景 1 标准（≤500ms）',
    'A6②: pi 置换为必败脚本后点击会话，按现状失败语义呈现——不切入 + toast「切换会话失败」+ 无崩溃',
    'A6③: 恢复 pi 后再次点击同一会话，切换成功且首屏尾部签名匹配',
  ],
  notProvable: [
    'A6① 尾读 RPC 成功依赖 u1 交付（smoke 模式下登记 uncovered，D3 实跑断言 reply 含预算窗口内消息且无 error）',
    '首屏时长的像素级渲染质量（只断言最近消息 turn 在视口内可见 + 文本非空）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const smoke = isSmokeMode()
  const uncovered = []
  const gotchas = []

  // ── 段 0：fixture 采集（stop 空实例 → 种子 → 冷启动） ────────────────
  await instance.stop()
  ev.step({ step: 'instance.stop-for-seed', channel: 'C', exitCode: 0, stats: { dataDir } })

  const pool = scanSessionPool(PROD_DATA_DIR)
  ev.step({
    step: 'fixture.scan-pool',
    channel: 'C',
    exitCode: 0,
    stats: { poolSize: pool.length, prodRoot: PROD_DATA_DIR },
  })
  const big = pickLargestSession(pool)
  ev.assert('种子：生产池含 ≥32MB 大会话样本（设计「42MB 会话」载体）', Boolean(big), {
    channel: 'C',
    expected: '≥32MB 样本 1 个',
    actual: big ? `${(big.bytes / 1_000_000).toFixed(1)}MB ${big.sessionId}` : '无',
  })
  if (!big) throw new Error('生产池无 ≥32MB 会话样本，A1/A2 断言载体缺失')

  const exclusion = new Set([big.sessionFile])
  // 逐出池凑 9 个：≤2MB 小会话只有 7 个（生产池实况），上限放宽到 16MB 纳入中型会话
  const evictionPool = pickSmallSessions(pool, { count: EVICTION_ROUNDS, exclude: exclusion, maxBytes: 16_000_000 })
  // 逐出循环的切换等待以「本会话签名入流」为判据（防旧流未清空的假阳性），先提取签名
  const evictSignatures = new Map(evictionPool.map((s) => [s.sessionId, extractSessionSignatures(s.sessionFile)]))
  ev.assert(`种子：逐出池含 ${EVICTION_ROUNDS} 个小会话`, evictionPool.length >= EVICTION_ROUNDS, {
    channel: 'C',
    expected: `≥${EVICTION_ROUNDS} 个`,
    actual: `${evictionPool.length} 个`,
  })

  const seeded = seedSessions(dataDir, PROD_DATA_DIR, [big, ...evictionPool])
  const bigSignature = extractSessionSignatures(big.sessionFile)
  ev.step({
    step: 'fixture.seed-sessions',
    channel: 'C',
    exitCode: 0,
    stats: {
      seeded: seeded.length,
      bigBytes: big.bytes,
      evictionPoolBytes: evictionPool.map((s) => s.bytes),
      bigSignatureAny: anySignatureText(bigSignature)?.slice(0, 40) ?? null,
    },
  })
  ev.assert('种子：42MB 样本签名可提取（归属/无跳变判据载体）', Boolean(anySignatureText(bigSignature)), {
    channel: 'C',
    expected: '签名 ≥1 条',
    actual: anySignatureText(bigSignature) ? '有' : '无',
  })

  // 冷启动（重启后首点 = 场景 1 前置「重启 taiji prod → 等 runtime ready」）
  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({
    step: 'cold.launch-ready',
    channel: 'C',
    exitCode: 0,
    stats: { runtimePort: ready.runtimePort, extensions: ready.extensions, elapsedMs: ready.elapsedMs },
  })
  log(`cold ready in ${ready.elapsedMs}ms runtime=${ready.runtimePort}`)

  // stop/launch 循环后 runner 预建的协议连接已失效：按最新 runtime.port 自建（a1 同款）
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
  try {
    const list = await proto.call('session.list', {}, { replyType: 'session.list', timeoutMs: 60_000 })
    const rows = flattenSessionList(list)
    const bigRow = rows.find((r) => r.id === big.sessionId)
    ev.assert('种子：42MB 会话经 session.list 可见（runtime 扫描已纳入）', Boolean(bigRow), {
      channel: 'B',
      expected: big.sessionId,
      actual: bigRow ? `label=${bigRow.label}` : `总 ${rows.length} 行无匹配`,
    })
    if (!bigRow) throw new Error('42MB 会话未被 runtime 扫描纳管（检查 sidecar 绑定与 projects.json 归属）')
    const page = await instance.page()

    // ── 段 1：A1 冷启动首点 42MB 会话 ────────────────────────────────
    const bigRow1 = await locateSidebarSession(page, { projectId: bigRow.projectId, label: bigRow.label })
    // 42MB > 现状 read-precheck cap（32MB 不读历史）：smoke 下首屏原理上不可判，缩短上限等
    // 45s 观测稳态后降级 uncovered；D3 实跑（u1 突破 cap）用全量预算且超时 = fail
    const firstPaint = await firstPaintTolerant(page, () => bigRow1.click(), {
      timeoutMs: smoke ? 45_000 : firstScreenTimeoutMs(),
      expectTexts: allSignatureTexts(bigSignature),
    })
    if (!firstPaint.rendered) uncovered.push('A1 42MB 会话首屏渲染（现状 read-precheck cap 32MB 拒读超大历史，首屏空为现状稳态；D3 实跑 u1 交付后执行）')
    ev.step({
      step: 'a1.first-click',
      channel: 'A',
      exitCode: firstPaint.rendered ? 0 : 1,
      stats: { elapsedMs: firstPaint.elapsedMs, turnCount: firstPaint.turnCount, rendered: firstPaint.rendered, smoke, budget: FIRST_PAINT_BUDGET_MS },
    })
    ev.assert(
      smoke
        ? 'A1(smoke): 首屏在现状全量恢复路径下最终渲染（阈值断言降级 uncovered）'
        : 'A1: 冷启动首点 42MB 会话首屏 ≤500ms',
      firstPaint.elapsedMs <= (smoke ? Number.MAX_SAFE_INTEGER : FIRST_PAINT_BUDGET_MS),
      { channel: 'A', expected: `≤${FIRST_PAINT_BUDGET_MS}ms`, actual: `${firstPaint.elapsedMs}ms` },
    )
    if (smoke) uncovered.push('A1 首屏 ≤500ms 阈值断言（smoke：现状全量恢复路径下不可判，D3 实跑执行）')

    // 输入框可用 ≈1.5s 内（首屏 + 现场 spawn）
    const composerT0 = Date.now()
    let composerElapsed = null
    try {
      await pollUntil(() => page.evaluate(() => {
        const box = document.querySelector('[data-testid="composer-box"]')
        return box && box.getBoundingClientRect().height > 0 && box.getAttribute('aria-disabled') !== 'true'
      }), { timeoutMs: COMPOSER_BUDGET_MS, intervalMs: 100, label: 'composer 1.5s 预算' })
      composerElapsed = Date.now() - composerT0
    } catch {
      composerElapsed = Date.now() - composerT0
    }
    ev.assert(
      smoke
        ? 'A1(smoke): 输入框可用（预算断言降级 uncovered）'
        : 'A1: 点击后 ≈1.5s 内输入框可用',
      composerElapsed <= (smoke ? Number.MAX_SAFE_INTEGER : COMPOSER_BUDGET_MS),
      { channel: 'A', expected: `≤${COMPOSER_BUDGET_MS}ms`, actual: `${composerElapsed}ms` },
    )
    if (smoke) uncovered.push('A1 输入框 1.5s 可用断言（smoke：D3 实跑执行）')

    // 10s 内全量补齐：historyCacheReady 帧（u1 登记的协议帧）+ 最近消息不跳变
    const tailText = bigSignature.lastUser ?? bigSignature.lastAssistant ?? ''
    const beforeFull = await readLatestTurn(page)
    let cacheReadyArrived = false
    try {
      const evt = await proto.waitFor(
        (e) => e.type === 'session.historyCacheReady' && e.payload?.sessionId === big.sessionId,
        { timeoutMs: FULL_HISTORY_WINDOW_MS },
      )
      cacheReadyArrived = Boolean(evt)
    } catch {
      cacheReadyArrived = false
    }
    const afterFull = await readLatestTurn(page)
    const noJump = Boolean(afterFull?.text) && (!tailText || afterFull.text.includes(tailText.slice(0, 40)))
    ev.step({
      step: 'a1.full-history-window',
      channel: 'B',
      exitCode: smoke || cacheReadyArrived ? 0 : 1,
      stats: { cacheReadyArrived, turnCountBefore: beforeFull?.turnCount ?? 0, turnCountAfter: afterFull?.turnCount ?? 0, noJump },
    })
    ev.assert(
      smoke ? 'A1(smoke): 10s 补齐帧断言降级 uncovered' : 'A1: 10s 内 historyCacheReady 帧到达（全量补齐完成信号）',
      smoke ? true : cacheReadyArrived,
      { channel: 'B', expected: `10s 内 session.historyCacheReady（sessionId=${big.sessionId}）`, actual: cacheReadyArrived ? '已到达' : '未到达' },
    )
    if (smoke) uncovered.push('A1 10s 补齐帧 + 无跳变断言（smoke：D3 实跑执行）')
    else {
      ev.assert('A1: 全量补齐后最近消息不跳变（尾部签名仍在最后 turn 文本中）', noJump, {
        channel: 'A',
        expected: `含「${tailText.slice(0, 40)}」`,
        actual: afterFull?.text?.slice(0, 80) ?? '(无 turn)',
      })
    }

    // ── 段 2：A2 缓存逐出后重切 ─────────────────────────────────────
    const evictionRows = evictionPool
      .map((s) => rows.find((r) => r.id === s.sessionId))
      .filter(Boolean)
    ev.assert(`A2: 逐出池会话全部被 runtime 纳管（${evictionRows.length}/${EVICTION_ROUNDS}）`, evictionRows.length >= EVICTION_ROUNDS, {
      channel: 'B',
      expected: `≥${EVICTION_ROUNDS}`,
      actual: String(evictionRows.length),
    })
    let evictionOk = 0
    for (const [i, r] of evictionRows.entries()) {
      const row = await locateSidebarSession(page, { projectId: r.projectId, label: r.label })
      await row.click()
      try {
        await waitForLatestTurnVisible(page, {
          // 中型会话（≤16MB）的现状渲染窗口与签名提取窗口可能不重叠（签名永不命中），
          // smoke 下只给 8s（restore ~2s + 渲染缓冲）观测即降级，避免逐出 9 连 × 240s 空等；
          // D3 实跑（u1 尾读）用全量预算且超时 = fail
          timeoutMs: smoke ? 8_000 : firstScreenTimeoutMs(),
          expectTexts: allSignatureTexts(evictSignatures.get(r.id)),
        })
      } catch (e) {
        // smoke 下超时降级登记不中断（逐出动作可能少一次，D3 实跑不降级、超时 = fail）
        if (!(smoke && e instanceof Error && /轮询超时/.test(e.message))) throw e
        uncovered.push(`A2 逐出切换 ${r.id} 首屏渲染超时（smoke 降级登记，逐出动作可能未生效）`)
        gotchas.push(`evict-${i + 1} 首屏等待超时已跳过`)
        continue
      }
      evictionOk += 1
      ev.step({
        step: `a2.evict-${i + 1}`,
        channel: 'A',
        exitCode: 0,
        stats: { sid: r.id, label: r.label, done: `${evictionOk}/${evictionRows.length}` },
      })
    }
    // 切回目标（目标缓存已被 ≥9 次切换挤出）——同场景 1 标准
    const bigRow2 = await locateSidebarSession(page, { projectId: bigRow.projectId, label: bigRow.label })
    const repaint = await firstPaintTolerant(page, () => bigRow2.click(), {
      timeoutMs: smoke ? 45_000 : firstScreenTimeoutMs(),
      expectTexts: allSignatureTexts(bigSignature),
    })
    if (!repaint.rendered) uncovered.push('A2 逐出后切回 42MB 会话首屏渲染（同 A1：现状 cap 拒读，D3 实跑执行）')
    ev.step({
      step: 'a2.reclick-target',
      channel: 'A',
      exitCode: repaint.rendered ? 0 : 1,
      stats: { elapsedMs: repaint.elapsedMs, rendered: repaint.rendered, smoke, budget: FIRST_PAINT_BUDGET_MS },
    })
    ev.assert(
      smoke ? 'A2(smoke): 逐出后切回最终渲染（阈值断言降级 uncovered）' : 'A2: 缓存逐出后切回 42MB 会话首屏 ≤500ms',
      repaint.elapsedMs <= (smoke ? Number.MAX_SAFE_INTEGER : FIRST_PAINT_BUDGET_MS),
      { channel: 'A', expected: `≤${FIRST_PAINT_BUDGET_MS}ms`, actual: `${repaint.elapsedMs}ms` },
    )
    if (smoke) uncovered.push('A2 逐出重切 ≤500ms 断言（smoke：D3 实跑执行）')

    // ── 段 3：A6 pi 完全不可用（spawn 失败注入） ────────────────────
    // 前置：重启实例（无活 pi 进程）→ 置换 resources/pi 为必败脚本 → 冷启动
    const swap = swapPiBinary(repo)
    ev.step({
      step: 'a6.swap-pi',
      channel: 'C',
      exitCode: swap.swapped ? 0 : 1,
      stats: { swapped: swap.swapped, path: swap.path, wasSymlink: swap.wasSymlink ?? null, reason: swap.reason ?? null },
    })
    try {
      if (!swap.swapped) {
        uncovered.push('A6 全场景（resources/pi 二进制缺失，find-pi-executable 会 fallback 系统 PATH，注入前提不成立）')
      } else {
        await instance.stop()
        await instance.launch()
        const ready2 = await instance.waitReady({ timeoutMs: 180_000 })
        ev.step({
          step: 'a6.relaunch-ready',
          channel: 'C',
          exitCode: 0,
          stats: { runtimePort: ready2.runtimePort, elapsedMs: ready2.elapsedMs },
        })
        const page2 = await instance.page()
        const proto2 = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
        try {
          // ① 数据层（u1 交付行为）：pi 不可用时尾读 RPC 仍成功
          let historyOk = false
          let historyStats = null
          try {
            const h = await proto2.call('session.history', { sessionId: big.sessionId }, { replyType: 'session.history', timeoutMs: 60_000 })
            const msgs = h?.messages ?? h?.turns ?? []
            historyOk = Array.isArray(msgs) && msgs.length > 0 && !h?.error
            historyStats = { messages: Array.isArray(msgs) ? msgs.length : 'n/a', hasError: Boolean(h?.error) }
          } catch (e) {
            historyStats = { error: e instanceof Error ? e.message : String(e) }
          }
          ev.step({ step: 'a6.tailread-rpc', channel: 'B', exitCode: historyOk ? 0 : 1, stats: { smoke, ...historyStats } })
          ev.assert(
            smoke ? 'A6①(smoke): 尾读 RPC 断言降级 uncovered' : 'A6①: pi 不可用时 getHistory 尾读 RPC 成功（有消息、无 error）',
            smoke ? true : historyOk,
            { channel: 'B', expected: 'reply 含预算窗口内消息且无 error', actual: JSON.stringify(historyStats) },
          )
          if (smoke) uncovered.push('A6① pi 不可用时尾读 RPC 成功断言（smoke：D3 实跑执行）')

          // ② 显示层按现状失败语义：不切入 + toast + 无崩溃
          const list2 = await proto2.call('session.list', {}, { replyType: 'session.list', timeoutMs: 60_000 })
          const bigRowInfo = flattenSessionList(list2).find((r) => r.id === big.sessionId)
          const row2 = await locateSidebarSession(page2, { projectId: bigRowInfo.projectId, label: bigRowInfo.label })
          await row2.click()
          const toastText = await waitForToast(page2, { textPattern: /切换会话失败|Failed to switch session/, timeoutMs: 20_000 })
          ev.step({ step: 'a6.toast', channel: 'A', exitCode: 0, stats: { toast: toastText.slice(0, 120) } })
          ev.assert('A6②: 切换失败 toast 出现（sidebar.switchSessionFailed 语义）', toastText.length > 0, {
            channel: 'A',
            expected: 'toast 含「切换会话失败」',
            actual: toastText.slice(0, 120),
          })
          // 不切入：失败语义 = selectSession 链路短路，流即刻保持原状（无延迟切入窗口）
          const streamAfterFail = await readStreamText(page2)
          const tail40 = tailText.slice(0, 40)
          ev.assert('A6②: 界面未切入该会话（失败后流中无目标会话尾部内容）', !streamAfterFail.includes(tail40), {
            channel: 'A',
            expected: `流中不含「${tail40}」`,
            actual: streamAfterFail ? `流文本 ${streamAfterFail.length} 字符` : '(空流)',
          })

          // ③ 恢复 pi 后再次点击：切换成功
          const restored = restorePiBinary(repo, swap)
          ev.step({
            step: 'a6.restore-pi',
            channel: 'C',
            exitCode: restored.restored ? 0 : 1,
            stats: { restored: restored.restored, symlink: restored.symlink ?? null, bytes: restored.bytes ?? null },
          })
          ev.assert('A6: pi 二进制恢复核对（形态/字节数一致）', restored.restored, {
            channel: 'C',
            expected: '原形态恢复',
            actual: JSON.stringify({ symlink: restored.symlink ?? null, bytes: restored.bytes ?? null }),
          })
          const row3 = await locateSidebarSession(page2, { projectId: bigRowInfo.projectId, label: bigRowInfo.label })
          const recovered = await firstPaintTolerant(page2, () => row3.click(), {
            timeoutMs: smoke ? 45_000 : firstScreenTimeoutMs(),
            expectTexts: allSignatureTexts(bigSignature),
          })
          if (smoke && !recovered.rendered) uncovered.push('A6③ 恢复 pi 后切换 42MB 会话首屏渲染（smoke：现状 cap 拒读超大历史，D3 实跑执行）')
          ev.step({
            step: 'a6.reclick-after-restore',
            channel: 'A',
            exitCode: recovered.rendered ? 0 : 1,
            stats: { elapsedMs: recovered.elapsedMs, turnCount: recovered.turnCount, rendered: recovered.rendered },
          })
          ev.assert(
            smoke ? 'A6③(smoke): 恢复 pi 后切换成功断言降级 uncovered（首屏未渲染，现状 cap 拒读）' : 'A6③: 恢复 pi 后再次点击切换成功（首屏渲染）',
            smoke ? true : recovered.text.length > 0,
            {
              channel: 'A',
              expected: 'turn 渲染非空',
              actual: `rendered=${recovered.rendered} turnCount=${recovered.turnCount}`,
            },
          )
          if (smoke && !recovered.rendered) uncovered.push('A6③ pi 恢复后首屏渲染（smoke：现状 cap 拒读 42MB 历史，D3 实跑执行）')
          if (tail40) {
            const finalStream = await readStreamText(page2)
            // 现状首屏 = 头部窗口（游标在开头），尾读交付首屏 = 尾部窗口——
            // 「尾部签名入流」依赖 u1 交付语义，smoke 降级 uncovered
            const tailInStream = finalStream.includes(tail40)
            ev.assert(
              smoke
                ? 'A6③(smoke): 恢复后尾部历史入流断言降级 uncovered（现状首屏为头部窗口）'
                : 'A6③: 切换成功后历史正常（尾部签名入流）',
              smoke ? true : tailInStream,
              { channel: 'A', expected: `流中含「${tail40}」`, actual: `流文本 ${finalStream.length} 字符 tailIn=${tailInStream}` },
            )
            if (smoke) uncovered.push('A6③ pi 恢复后尾部签名入流断言（smoke：现状首屏为头部窗口，D3 实跑执行）')
          }
        } finally {
          await proto2.close().catch(() => {})
        }
      }
    } finally {
      // 置换恢复硬保证：即使中断路径也恢复（SKILL.md §1.3：恢复完成前禁起依赖真实 pi 的场景）
      if (swap.swapped && fs.existsSync(`${swap.path}.cold-switch-bak`)) {
        const r = restorePiBinary(repo, swap)
        gotchas.push(`pi 置换在异常路径恢复：restored=${r.restored}`)
      }
    }
  } finally {
    await proto.close().catch(() => {})
  }

  if (uncovered.length === 0) log('cold-switch-primary: 全部断言通过')
  else log(`cold-switch-primary: ${uncovered.length} 项 uncovered（smoke=${smoke}）`)
  return { uncovered, gotchas }
}
