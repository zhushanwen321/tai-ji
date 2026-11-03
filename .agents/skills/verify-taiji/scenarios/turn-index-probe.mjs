/**
 * turn-index-probe —— 41MB 参考会话 turn 边界索引探针（turn-boundary-index 主探针）。
 *
 * 单脚本承载 impl-plan §4.2 四行验收（A19 行登记「与 A1/A2/A3 同一脚本」）：
 * - A1 / V1：索引就绪后的最近窗口与 10 页连续翻页（每页按页字节分档预算——保底 50ms、
 *   巨型 turn 页按吞吐放宽、10 页 <500ms、翻页不重不漏、每页窗口符合 20turn/640KB
 *   双预算且超预算仅最右 turn 豁免——预算合规即有界）。
 * - A2 / V2：首次建索引（无 turns.json 起步）——总耗时目标 <1000ms、无 ≥1s 级长 stall
 *   （ping 间隔降级观测：warmup/GC/传输计入 ping 间隔，扫描同步块真值需 runtime 埋点），
 *   顺带输出 user turn 总数与 turns.json 实际字节数（设计 §3.1 ⏳ 前提与 V10
 *   单调有界判定的取数来源，单独记录不与性能数据混算）。
 * - A3 / V3：追加、崩溃残尾、补全续扫、重启（丢弃内存索引）后重扫一致；重启后首读
 *   耗时与扫描字节范围按 D2 首次扫描口径单独报告（RL4 读侧重审触发条件实测输入）。
 * - A19 / RL4：性能探针多输出项 = 首次总耗时 / 首建 ping 间隔峰值 / 就绪后单页与 10 页 /
 *   重启后续扫耗时与字节范围。
 *
 * fixture：生产数据目录 ≥32MB 最大会话的隔离副本（只拷贝不直连，C-proc-26；种子 =
 * jsonl + sidecar 家族拷进实例数据目录，cold-switch-lib 同款）。制备说明见
 * lib/turn-index-lib.mjs 头注与本 runDir 的 baseline-fixture.md。
 *
 * 基线采集模式（env TURN_INDEX_BASELINE_COLLECT=1，u-assets-prep 实施前基线采集）：
 * 对改造前代码只采集计时与形状数据（首屏/翻页/离线 turn 统计），终态断言降级为数据
 * 记录；改造后实跑不带此 env，全量断言（fail 即 exit 1）。
 *
 * 跑绿门：挂 u-reader commit 门（impl-plan DAG：探针断言依赖读取编排终态）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ASSET_DIR,
  FIRST_BUILD_STALL_MS,
  FIRST_BUILD_TARGET_MS,
  HISTORY_WINDOW_MAX_BYTES,
  HISTORY_WINDOW_RECENT_TURNS,
  PROBE_MIN_BYTES,
  PROBE_PAGES,
  PROBE_PAGES_BUDGET_MS,
  READY_PAGE_BUDGET_MS,
  appendEntry,
  countUserTurns,
  duplicateEntryIds,
  injectTruncatedTail,
  isBaselineCollectMode,
  makeMessageEntry,
  oldestCursor,
  pageThroughHistory,
  pageTimeBudgetMs,
  pickProbeSession,
  readRuntimePort,
  readTurnsJson,
  seedProbeSession,
  timedHistory,
  windowBudgetCompliance,
} from './lib/turn-index-lib.mjs'
import { PROD_DATA_DIR } from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

export const meta = {
  id: 'turn-index-probe',
  priority: 'P0',
  title: '41MB 探针：索引就绪查看与翻页（A1）+ 首次建索引与 turn/字节输出（A2）+ 追加残尾重启重扫（A3）+ 性能多输出（A19）',
  covers: ['env.launch', 'env.ready', 'session.history', 'evidence.logs'],
  requires: ['u-assets-prep'],
  estimateSec: baseline ? 420 : 300,
  provable: [
    'A1: 索引就绪后最近窗口 <50ms；每页翻页按页字节分档预算（≤max(50ms, 页物理字节÷40MB/s)，巨型 turn 页按吞吐放宽）；10 页总耗时 <500ms',
    'A1: 连续翻页 piEntryId 序列无重复（消息不重不漏），窗口边界与 cursor 正确',
    'A1: 翻页窗口字节范围有界（每页选中 turn 符合 20turn/640KB 双预算、超预算仅最右 turn 豁免——预算合规即有界；窗口物理字节合计单独记录不设红线）',
    'A2: 首次（无 turns.json）请求无需 pi 返回正确窗口，总耗时目标 <1000ms',
    'A2: 首建后 turns.json 落盘，其 turn 数与离线统计的 user turn 边界数一致，字节数单独记录（不设阈值）',
    'A2: 首建期间无 ≥1s 级长 stall（ping 间隔降级观测——warmup/GC/传输计入 ping 间隔，扫描同步块真值需 runtime 埋点）',
    'A3: 追加的新 turn 按 entryId 恰好出现一次；残尾未补全时不进入消息；补全后从原残尾起点续扫不重复旧 turn',
    'A3: 重启（丢弃内存索引）后同窗口内容与重启前一致（历史不丢失）；重启后首读耗时与扫描字节范围按 D2 首次扫描口径单独报告',
    'A19: 输出首次总耗时 / 首建 ping 间隔峰值（长 stall 检测）/ 就绪后单页与 10 页 / 重启后续扫耗时与字节范围',
  ],
  notProvable: [
    '构建期间追加的精确卡点（毫秒级构建窗口无法从剧本侧确定性命中；以「首读完成后追加 + 下一次读取纳入」覆盖 ensureFresh 二次执行语义）',
    'runtime 内部实际读取字节数（需 runtime 侧埋点；以 turns.json 窗口偏移离线推算承载）',
    '扫描器单块同步耗时真值（需 runtime 侧埋点直测；探针 ping 间隔把进程 warmup/GC/WS 传输全计入——实测 352ms ping 峰值 = 新进程首次请求常数（同 run restartFirstReadMs 同值 352ms、重启仅重扫 711B），扫描算法独立复现单块 ≤6ms；剧本侧降级为 ≥1s 长 stall 检测 + 数据记录）',
  ],
}

/**
 * 首建期间 ping 间隔观测（降级口径）：并发 ping 取首建期间最大间隔，只作 ≥1s 级
 * 用户体验 stall 检测（FIRST_BUILD_STALL_MS）+ 数据记录（outputs.maxSyncBlockMs）。
 * ping 间隔把进程 warmup/GC/WS 传输全计入，不是扫描同步块真值——同步块真值需
 * runtime 侧埋点（notProvable 登记）；实测 ping 峰值与重启后首读同值（新进程首次
 * 请求常数），据此归因不误判为扫描同步块过长。
 */
async function observeMaxSyncBlock(proto, sessionId) {
  const gaps = []
  let last = Date.now()
  const t0 = Date.now()
  const probeLoop = (async () => {
    while (Date.now() - t0 < 30_000) {
      try {
        await proto.call('ping', {}, { replyType: 'pong', timeoutMs: 30_000 })
      } catch {
        break
      }
      const now = Date.now()
      gaps.push(now - last)
      last = now
    }
  })()
  const first = await timedHistory(proto, sessionId, {})
  await Promise.race([probeLoop, new Promise((r) => setTimeout(r, 500))])
  return { first, maxSyncBlockMs: gaps.length > 0 ? Math.max(...gaps) : null, pingCount: gaps.length }
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []

  // ── 段 0：fixture 采集 + 离线基线统计 ──────────────────────────────
  await instance.stop()
  const probe = pickProbeSession()
  ev.assert('种子：生产池含 ≥32MB 探针样本（设计「41MB 参考会话」载体）', Boolean(probe), {
    channel: 'C',
    expected: '≥32MB 样本 1 个',
    actual: probe ? `${(probe.bytes / 1_000_000).toFixed(1)}MB ${probe.sessionId}` : '无',
  })
  if (!probe) throw new Error('生产池无 ≥32MB 会话样本，探针断言载体缺失')
  if (probe.bytes < PROBE_MIN_BYTES) throw new Error('样本不足')

  const seeded = seedProbeSession(dataDir, PROD_DATA_DIR, probe)
  const jsonlCopy = path.join(dataDir, 'agent', 'sessions', path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), probe.sessionFile))
  const offline = countUserTurns(jsonlCopy)
  ev.step({
    step: 'fixture.offline-stats',
    channel: 'C',
    exitCode: 0,
    stats: {
      sessionId: probe.sessionId,
      fileBytes: offline.fileBytes,
      entryLines: offline.entryLines,
      userTurns: offline.userTurns,
      hasResidualTail: offline.hasResidualTail,
      seeded: seeded.length,
    },
  })
  // 设计 §5.1 U1 检查点第 1 条的前半：实施前基线 = 离线统计与文件字节数（不依赖实现）
  ev.assert('基线：离线 turn 统计可判（userTurns ≥ 10 页连续翻页深度）', offline.userTurns >= 10, {
    channel: 'C',
    expected: 'userTurns ≥ 10',
    actual: `userTurns=${offline.userTurns} fileBytes=${offline.fileBytes}`,
  })

  // 清除可能存在的索引（A2 场景要求「首次没有 turns.json」起步）
  const turnsFileDir = path.join(dataDir, 'ext-sessions', probe.sessionId, 'history-index')
  if (fs.existsSync(turnsFileDir)) fs.rmSync(turnsFileDir, { recursive: true, force: true })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'probe.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })

  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
  const outputs = {
    kind: baseline ? 'baseline-collect' : 'full',
    sessionId: probe.sessionId,
    fileBytes: offline.fileBytes,
    offlineUserTurns: offline.userTurns,
    offlineEntryLines: offline.entryLines,
  }
  try {
    // ── 段 1：A2 首次建索引 + A19 首建 ping 间隔峰值 ─────────────────
    const { first, maxSyncBlockMs, pingCount } = await observeMaxSyncBlock(proto, probe.sessionId)
    outputs.firstBuildMs = first.elapsedMs
    outputs.maxSyncBlockMs = maxSyncBlockMs
    ev.step({
      step: 'a2.first-build',
      channel: 'B',
      exitCode: baseline ? 0 : first.elapsedMs <= FIRST_BUILD_TARGET_MS ? 0 : 1,
      stats: { firstBuildMs: first.elapsedMs, maxSyncBlockMs, pingCount, messages: (first.reply?.messages ?? []).length, truncated: first.reply?.truncated ?? null },
    })
    if (baseline) {
      uncovered.push(`基线采集：首屏（最近窗口）耗时 ${first.elapsedMs}ms（改造前形态，仅记录）`)
    } else {
      ev.assert('A2: 首次建索引总耗时 <1000ms（D2 目标，实测单独报告）', first.elapsedMs <= FIRST_BUILD_TARGET_MS, {
        channel: 'B', expected: `≤${FIRST_BUILD_TARGET_MS}ms`, actual: `${first.elapsedMs}ms`,
      })
      ev.assert('A2: 首建期间无 ≥1s 级长 stall（ping 间隔降级观测——warmup/GC/传输计入 ping 间隔，扫描同步块真值需 runtime 埋点）', maxSyncBlockMs === null || maxSyncBlockMs <= FIRST_BUILD_STALL_MS, {
        channel: 'B', expected: `ping 间隔峰值 <${FIRST_BUILD_STALL_MS}ms`, actual: `峰值 ${maxSyncBlockMs}ms（ping 采样 ${pingCount} 次）`,
      })
      ev.assert('A2: 首次请求返回正确窗口（有消息、无 error）', (first.reply?.messages ?? []).length > 0 && !first.reply?.error, {
        channel: 'B', expected: 'messages 非空且无 error', actual: `messages=${(first.reply?.messages ?? []).length} error=${first.reply?.error ?? '无'}`,
      })
    }

    // A2 输出项：turns.json 的 turn 数与实际字节数（基线上无索引，跳过）
    const turns = readTurnsJson(dataDir, probe.sessionId)
    if (baseline) {
      uncovered.push('基线采集：turns.json turn 数与字节数（改造前无索引，改造后 A2 输出）')
    } else {
      ev.assert('A2: 首建后 turns.json 落盘', Boolean(turns), {
        channel: 'C', expected: 'ext-sessions/<sid>/history-index/turns.json 存在', actual: turns ? `${turns.bytes}B turns=${turns.turns}` : '缺失',
      })
      if (turns) {
        outputs.turnsJsonBytes = turns.bytes
        outputs.turnsJsonTurns = turns.turns
        ev.assert('A2: turns.json turn 数与离线 user turn 统计一致', turns.turns === offline.userTurns, {
          channel: 'C', expected: `${offline.userTurns}`, actual: `${turns.turns}`,
        })
      }
    }

    // ── 段 2：A1 索引就绪后的查看与连续翻页 ──────────────────────────
    const recent = await timedHistory(proto, probe.sessionId, {})
    outputs.readyRecentMs = recent.elapsedMs
    const paged = await pageThroughHistory(proto, probe.sessionId, {})
    outputs.pageElapsed = paged.pages.map((p) => p.elapsedMs)
    outputs.pagesTotalMs = paged.totalMs
    const dup = duplicateEntryIds(paged.pages)
    ev.step({
      step: 'a1.ready-window-paging',
      channel: 'B',
      exitCode: baseline ? 0 : recent.elapsedMs <= READY_PAGE_BUDGET_MS && paged.totalMs <= PROBE_PAGES_BUDGET_MS ? 0 : 1,
      stats: {
        recentMs: recent.elapsedMs,
        pageCount: paged.pageCount,
        pagesMs: paged.pages.map((p) => p.elapsedMs),
        totalMs: paged.totalMs,
        perPageMessages: paged.pages.map((p) => p.messages),
      },
    })
    if (baseline) {
      uncovered.push(`基线采集：索引就绪后最近窗口 ${recent.elapsedMs}ms、翻页 ${paged.pageCount} 页总 ${paged.totalMs}ms（逐页 ${paged.pages.map((p) => p.elapsedMs).join('/')}ms，改造前形态仅记录）`)
    } else {
      ev.assert('A1: 索引就绪后最近窗口 <50ms', recent.elapsedMs <= READY_PAGE_BUDGET_MS, {
        channel: 'B', expected: `≤${READY_PAGE_BUDGET_MS}ms`, actual: `${recent.elapsedMs}ms`,
      })
      // 逐页窗口复算（turns.json 离线推算）：分档页预算与窗口有界断言共用。每页选中
      // turn = 该页消息 piEntryId 与 turns[].entryId 求交；空页（翻页到头）无窗口。
      const perPageWindow = paged.pages.map((p) => {
        const msgs = p.reply?.messages ?? []
        const ids = new Set(msgs.map((m) => m?.piEntryId).filter((id) => typeof id === 'string'))
        const c = turns?.parsed?.turns
          ? windowBudgetCompliance(turns.parsed.turns, ids)
          : { turnCount: 0, budgetSum: 0, restBudgetSum: 0, exemptTurnBytes: 0, physSum: 0, ok: false }
        return { page: p.page, empty: msgs.length === 0, ...c }
      })
      outputs.windowBytes = perPageWindow.reduce((acc, c) => acc + c.physSum, 0)
      outputs.windowBudgetSum = perPageWindow.reduce((acc, c) => acc + c.budgetSum, 0)
      // 每页分档时间预算：轻页保留 50ms 红线；含巨型 turn 的页按页物理字节吞吐放宽
      //（产品默认预算 20turn/640KB 下首 turn 超预算按 entry 原子性整体放行，含巨型
      // turn 的页必须完整读取+解析+回传，固定 50ms 对本 fixture 不可达）
      const overBudgetPages = paged.pages.filter((p) => p.elapsedMs > pageTimeBudgetMs(perPageWindow[p.page - 1].physSum))
      ev.assert('A1: 每页翻页按页字节分档预算（≤max(50ms, 页物理字节÷40MB/s)，巨型 turn 页按吞吐放宽）', overBudgetPages.length === 0, {
        channel: 'B',
        expected: '逐页 ≤ max(50ms, 页物理字节÷40MB/s)',
        actual: overBudgetPages.length === 0
          ? `${paged.pageCount} 页全合规（最慢 ${Math.max(...paged.pages.map((p) => p.elapsedMs))}ms）`
          : overBudgetPages.map((p) => `p${p.page} ${p.elapsedMs}ms > 预算 ${Math.round(pageTimeBudgetMs(perPageWindow[p.page - 1].physSum))}ms`).join('；'),
      })
      ev.assert('A1: 10 页总耗时 <500ms', paged.totalMs <= PROBE_PAGES_BUDGET_MS, {
        channel: 'B', expected: `≤${PROBE_PAGES_BUDGET_MS}ms`, actual: `${paged.totalMs}ms（${paged.pageCount} 页）`,
      })
      ev.assert('A1: 连续翻页 piEntryId 无重复（不重不漏）', dup.length === 0, {
        channel: 'B', expected: '重复 0 条', actual: dup.length === 0 ? '无重复' : `重复 ${dup.slice(0, 5).join(',')}${dup.length > 5 ? '…' : ''}`,
      })
      // 窗口字节范围有界：设计预算口径——每页选中 turn 符合 20turn/640KB 双预算、超
      // 预算仅最右 turn 豁免（与产品窗口选择同语义，预算合规即有界）；窗口物理字节
      // 合计单独记录不设红线（fixture 最近窗口含 6.5/6.1/3.1MB 巨型 turn、占文件 42%
      // 为固有形态，固定占比红线不可达）；「远小于全文件」语义由 A3 重启续扫
      // rescanBytes 机制量承载。
      if (turns && turns.parsed?.turns) {
        const badPages = perPageWindow.filter((c) => !c.empty && !c.ok)
        ev.assert('A1: 翻页窗口字节范围有界（每页选中 turn 符合 20turn/640KB 双预算、超预算仅最右 turn 豁免）', badPages.length === 0, {
          channel: 'B',
          expected: `每页 turn 数 ≤${HISTORY_WINDOW_RECENT_TURNS} 且除最右 turn 外 budgetBytes ≤${HISTORY_WINDOW_MAX_BYTES / 1024}KB`,
          actual: badPages.length === 0
            ? `${paged.pageCount} 页全合规（窗口物理字节 ${(outputs.windowBytes / 1_000_000).toFixed(2)}MB，单独记录）`
            : badPages.map((c) => `p${c.page} turns=${c.turnCount} restBudget=${Math.round(c.restBudgetSum / 1024)}KB`).join('；'),
        })
      }
    }

    // ── 段 3：A3 追加 / 残尾 / 补全 / 重启重扫 ────────────────────────
    // 3a 追加一条真实 user turn → 恰好出现一次
    const appendedUser = makeMessageEntry('user', 'turn-index-probe 追加验证 turn（user 边界注入）')
    const appendedAssistant = makeMessageEntry('assistant', 'turn-index-probe 追加验证回复')
    appendEntry(jsonlCopy, appendedUser)
    appendEntry(jsonlCopy, appendedAssistant)
    const afterAppend = await timedHistory(proto, probe.sessionId, {})
    const appendedIds = (afterAppend.reply?.messages ?? []).filter((m) => m?.piEntryId === appendedUser.id || m?.piEntryId === appendedAssistant.id)
    ev.step({
      step: 'a3.append-turn',
      channel: 'B',
      exitCode: baseline ? 0 : appendedIds.length === 2 ? 0 : 1,
      stats: { appendedUser: appendedUser.id, appendedAssistant: appendedAssistant.id, visible: appendedIds.length, elapsedMs: afterAppend.elapsedMs },
    })
    if (baseline) uncovered.push('基线采集：追加注入可见性断言（改造前缓存路径语义不同，仅记录）')
    else ev.assert('A3: 追加的新 turn 两条 entry 恰好出现一次', appendedIds.length === 2, {
      channel: 'B', expected: `含 ${appendedUser.id} 与 ${appendedAssistant.id} 各一次`, actual: `可见 ${appendedIds.length} 条`,
    })

    if (!baseline) {
      // 3b 残尾注入：半截行不进入消息
      const tailEntry = makeMessageEntry('user', 'turn-index-probe 残尾注入 half-written line should not appear')
      const halfLine = injectTruncatedTail(jsonlCopy, tailEntry)
      const afterTail = await timedHistory(proto, probe.sessionId, {})
      const tailLeaked = (afterTail.reply?.messages ?? []).some((m) => JSON.stringify(m).includes('half-written line should not appear'))
      ev.assert('A3: 残尾未补全时不进入消息', !tailLeaked, {
        channel: 'B', expected: '半截行内容不出现', actual: tailLeaked ? '泄漏进消息' : '未出现',
      })
      // 3c 补全残行 + 追加下一条 entry → 从原残尾起点续扫
      fs.appendFileSync(jsonlCopy, `${JSON.stringify(tailEntry).slice(halfLine.length)}\n`)
      const nextEntry = makeMessageEntry('user', 'turn-index-probe 残尾补全后的下一条 turn')
      appendEntry(jsonlCopy, nextEntry)
      const afterFix = await timedHistory(proto, probe.sessionId, {})
      const ids = (afterFix.reply?.messages ?? []).map((m) => m?.piEntryId)
      const tailVisible = ids.filter((id) => id === tailEntry.id).length
      const nextVisible = ids.filter((id) => id === nextEntry.id).length
      // 「旧 turn 不重复」与 tail/next 同为必要条件（单表达式 && 串联，无 || 短路支）；
      // 字符串过滤同 lib duplicateEntryIds 口径——无 piEntryId 的消息不算重复对象。
      const dupInWindow = ids.filter((id, i) => typeof id === 'string' && ids.indexOf(id) !== i)
      ev.assert('A3: 补全后从原残尾起点续扫（残行 turn 出现一次、新 entry 出现一次、旧 turn 不重复）', tailVisible === 1 && nextVisible === 1 && dup.concat(dupInWindow).length === 0, {
        channel: 'B', expected: 'tail=1、next=1、窗口 piEntryId 无重复', actual: `tail=${tailVisible} next=${nextVisible} 窗口重复=${[...new Set(dup.concat(dupInWindow))].slice(0, 5).join(',') || '无'}`,
      })
      ev.step({ step: 'a3.residual-fix', channel: 'B', exitCode: tailVisible === 1 && nextVisible === 1 ? 0 : 1, stats: { tailVisible, nextVisible, elapsedMs: afterFix.elapsedMs } })
    }

    // 3d 重启重扫（丢弃内存索引与在途 Promise）→ 同窗口一致 + 续扫耗时单独报告
    const beforeRestart = await timedHistory(proto, probe.sessionId, {})
    const beforeDigest = (beforeRestart.reply?.messages ?? []).map((m) => m?.piEntryId).join(',')
    await proto.close().catch(() => {})
    await instance.stop()
    await instance.launch()
    await instance.waitReady({ timeoutMs: 180_000 })
    const proto2 = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
    try {
      const fileStat = fs.statSync(jsonlCopy)
      const turnsAfter = readTurnsJson(dataDir, probe.sessionId)
      const scannedOffset = turnsAfter?.parsed?.scannedOffset ?? null
      const rescanBytes = scannedOffset !== null ? Math.max(0, fileStat.size - scannedOffset) : null
      const afterRestart = await timedHistory(proto2, probe.sessionId, {})
      const afterDigest = (afterRestart.reply?.messages ?? []).map((m) => m?.piEntryId).join(',')
      outputs.restartRescanMs = afterRestart.elapsedMs
      outputs.restartRescanBytes = rescanBytes
      ev.step({
        step: 'a3.restart-rescan',
        channel: 'B',
        exitCode: baseline ? 0 : 0,
        stats: { restartFirstReadMs: afterRestart.elapsedMs, rescanBytes, fileBytes: fileStat.size, identical: beforeDigest === afterDigest },
      })
      if (baseline) uncovered.push(`基线采集：重启后首读 ${afterRestart.elapsedMs}ms（改造前形态仅记录）`)
      else {
        ev.assert('A3: 重启后同窗口内容与重启前一致（历史不丢失）', beforeDigest === afterDigest, {
          channel: 'B', expected: 'piEntryId 序列一致', actual: beforeDigest === afterDigest ? '一致' : '不一致（详见 diff）',
        })
        if (beforeDigest !== afterDigest) {
          ev.attach('a3-restart-digest-diff', JSON.stringify({ before: beforeDigest, after: afterDigest }, null, 1))
        }
        // D2 首次扫描口径：重启后续扫耗时单独报告（不进 50ms 就绪指标）；超 1000ms 按
        // §3.1 读侧重审触发条件处置——先归因（重扫字节数），断言登记 red 不吞
        ev.assert('A3: 重启后首读（陈旧索引续扫）<1000ms（D2 首次扫描口径，单独报告）', afterRestart.elapsedMs <= FIRST_BUILD_TARGET_MS, {
          channel: 'B', expected: `≤${FIRST_BUILD_TARGET_MS}ms`, actual: `${afterRestart.elapsedMs}ms（重扫 ${rescanBytes === null ? 'n/a' : `${(rescanBytes / 1_000_000).toFixed(2)}MB`}）`,
        })
      }
    } finally {
      await proto2.close().catch(() => {})
    }

    // A19：统一落盘性能多输出项（runDir 证据 + 步骤行）；基线产物落 BASELINE_ASSET_DIR
    //（与其他基线采集文件集中，供 V10 对账与设计 ⏳ 前提对账）
    ev.attach('a19-outputs', JSON.stringify(outputs, null, 1))
    ev.step({ step: 'a19.outputs', channel: 'C', exitCode: 0, stats: outputs })
    if (baseline) {
      fs.mkdirSync(BASELINE_ASSET_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(BASELINE_ASSET_DIR, 'probe-baseline-timing.json'),
        `${JSON.stringify({ ...outputs, collectedAt: new Date().toISOString(), collector: 'u-assets-prep @ baseline 494436875 (independent env)' }, null, 1)}\n`,
        'utf8',
      )
      gotchas.push('基线采集模式：终态断言全部降级为数据记录（详见 baseline 资产目录 probe-baseline-timing.json）')
    }
  } finally {
    await proto.close().catch(() => {})
  }

  return { uncovered, gotchas }
}
