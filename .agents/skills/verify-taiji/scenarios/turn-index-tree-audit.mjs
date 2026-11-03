/**
 * turn-index-tree-audit —— V10 宿主侧表面不变：删除残留 / 关线残留 / N 次读取写入堆积 /
 * 归档恢复循环的树面检查（impl-plan §4.2 A10；与 A7 共用 fixture 形态、各自种子副本）。
 *
 * ① 正常删除残留：读一次使索引落盘（确认无在途构建）→ lifecycle.delete →
 *   ext-sessions/<sid>/ 整树回收（无 history-index 残留）。
 * ② 关线残留：faux 主会话 btw 线读一次（线索引落盘）→ btw.remove → 线树回收。
 * ③ N 次读取写入堆积：同一会话连续 N=10 次读取并穿插真实追加（user+assistant entry），
 *   每轮后 history-index 下恰一个 turns.json、无 turns.json.tmp 残留；磁盘 turns.json
 *   体积与 turn 数恒等于上次完整构建快照（健康追加只走内存续扫不回写——按写入点全集，
 *   磁盘不随追加增长）；实测 turn 数与字节数离线统计对账（V2 探针输出项同源），单调
 *   有界判定、不设通过阈值。
 * ④ 归档恢复循环三次：已有索引的主会话 archive → unarchive 循环，每次读取同一窗口，
 *   归档期树面不变（归档单元无 history-index）、循环后 history-index 域文件数不随循环
 *   增长、历史完整。
 *
 * 跑绿门：挂 u-lifecycle commit 门（删除挂点交付后树面断言才可达）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  appendEntry,
  countUserTurns,
  isBaselineCollectMode,
  makeMessageEntry,
  readRuntimePort,
  readTurnsJson,
  seedProbeSession,
  timedHistory,
} from './lib/turn-index-lib.mjs'
import {
  pollUntil,
  PROD_DATA_DIR,
  scanSessionPool,
  seedSessions,
} from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

const FAUX_MODEL = 'faux/faux-1'

/** V10③ 读取+追加循环轮数（设计 V10 steps：N 取 10）。 */
const APPEND_ROUNDS = 10

function pickByRange(pool, minBytes, maxBytes, skip = 0) {
  const hits = pool.filter((s) => s.bytes >= minBytes && s.bytes < maxBytes).sort((a, b) => b.bytes - a.bytes)
  return hits[skip] ?? hits[0] ?? null
}

/** 树面枚举（相对 root 的文件相对路径清单）。 */
function treeUnder(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(root, p))
    }
  }
  walk(root)
  return out.sort()
}

/** 等待无在途构建：turns.json 存在且 3s 窗口内 stat 稳定。 */
async function waitIndexSettled(idxFile, { timeoutMs = 20_000 } = {}) {
  try {
    await pollUntil(
      () => {
        if (!fs.existsSync(idxFile)) return false
        const s1 = fs.statSync(idxFile)
        return new Promise((resolve) => setTimeout(() => {
          const s2 = fs.existsSync(idxFile) ? fs.statSync(idxFile) : null
          resolve(Boolean(s2) && s2.mtimeMs === s1.mtimeMs && s2.size === s1.size)
        }, 3_000))
      },
      { timeoutMs, intervalMs: 1_000, label: '索引落盘且稳定' },
    )
    return true
  } catch {
    return false
  }
}

export const meta = {
  id: 'turn-index-tree-audit',
  priority: 'P0',
  title: 'V10 宿主表面不变：删除/关线无索引残留、N 次读取+追加无写入堆积与 .tmp 残留、归档循环树面不增长',
  covers: ['env.launch', 'env.ready', 'session.delete', 'session.history', 'session.persistence', 'evidence.logs'],
  requires: ['faux', 'u-assets-prep'],
  estimateSec: 420,
  faux: {
    responses: {
      'faux/faux-1': [{ text: 'tree-audit-faux-answer', stopReason: 'stop' }],
    },
  },
  provable: [
    'V10①: lifecycle.delete 后 ext-sessions/<sid>/ 整树回收（history-index 无残留）',
    'V10②: btw.remove 关线后线树回收（线 sessionId 目录无索引残留）',
    'V10③: N=10 次读取+真实追加后 history-index 下恰一个 turns.json、无 .tmp 残留',
    'V10③: 磁盘 turns.json 字节与 turn 数恒等于构建快照（健康追加不回写、不随追加增长）',
    'V10④: 归档—恢复循环三次后 history-index 域文件数不增长、每次恢复后同窗口历史完整',
  ],
  notProvable: [
    'turns.json 字节量的通过阈值（V10③ 只设单调有界 + 实测值记录，>5MB 重审线由 V2 探针输出对账判定）',
    '归档期「无在途构建」前提的时钟级证明（以树面稳定轮询承载——3s 窗口 stat 不变）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = []
  if (baseline) {
    uncovered.push('V10 树面断言依赖索引落盘与整树回收终态——本剧本只挂 u-lifecycle commit 门跑')
    log('baseline collect 模式：V10 不采集，直接返回')
    return { uncovered, gotchas }
  }

  const extRoot = path.join(dataDir, 'ext-sessions')
  const archivesRoot = path.join(dataDir, 'archives')

  // ── 段 0：fixture（三个独立会话载体，区间互斥） ──────────────────
  await instance.stop()
  const pool = scanSessionPool(PROD_DATA_DIR)
  const delCarrier = pickByRange(pool, 2_000_000, 6_000_000)
  const growCarrier = pickByRange(pool, 1_000_000, 2_000_000)
  const archiveCarrier = pickByRange(pool, 500_000, 1_000_000)
  ev.assert('V10 载体：2-6MB 删除样本', Boolean(delCarrier), {
    channel: 'C', expected: '2-6MB 样本', actual: delCarrier ? `${(delCarrier.bytes / 1e6).toFixed(1)}MB` : '无',
  })
  ev.assert('V10 载体：1-2MB 增长样本', Boolean(growCarrier), {
    channel: 'C', expected: '1-2MB 样本', actual: growCarrier ? `${(growCarrier.bytes / 1e6).toFixed(1)}MB` : '无',
  })
  ev.assert('V10 载体：0.5-1MB 归档样本', Boolean(archiveCarrier), {
    channel: 'C', expected: '0.5-1MB 样本', actual: archiveCarrier ? `${(archiveCarrier.bytes / 1e6).toFixed(2)}MB` : '无',
  })
  if (!delCarrier || !growCarrier || !archiveCarrier) throw new Error('生产池载体不足（需 2-6MB / 1-2MB / 0.5-1MB 各一）')
  seedSessions(dataDir, PROD_DATA_DIR, [delCarrier, growCarrier, archiveCarrier])

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'tree-audit.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })

  try {
    // ── ① 正常删除残留 ───────────────────────────────────────────
    const sidA = delCarrier.sessionId
    await timedHistory(proto, sidA, {})
    const idxA = path.join(extRoot, sidA, 'history-index', 'turns.json')
    const settledA = await waitIndexSettled(idxA)
    ev.assert('V10① 前置：索引已落盘且无在途构建（3s stat 稳定）', settledA && fs.existsSync(idxA), {
      channel: 'C', expected: 'turns.json 存在且稳定', actual: `${settledA} exists=${fs.existsSync(idxA)}`,
    })
    await proto.call('session.delete', { sessionId: sidA }, { replyType: 'session.deleted', timeoutMs: 60_000 })
    const dirA = path.join(extRoot, sidA)
    ev.step({ step: 'v10-1.delete-tree', channel: 'B', exitCode: !fs.existsSync(dirA) ? 0 : 1, stats: { dirGone: !fs.existsSync(dirA), residual: fs.existsSync(dirA) ? treeUnder(dirA).slice(0, 8) : [] } })
    ev.assert('V10①: 删除后整树回收、无 history-index 残留', !fs.existsSync(dirA), {
      channel: 'B', expected: 'ext-sessions/<sid> 不存在', actual: fs.existsSync(dirA) ? `残留 ${treeUnder(dirA).length} 文件` : '已回收',
    })

    // ── ② 关线残留 ───────────────────────────────────────────────
    const created = await proto.call('session.create', { cwd: repo, label: 'tree-audit-btw', modelOverride: FAUX_MODEL }, { timeoutMs: 120_000 })
    const mainSid = created.session?.id
    await proto.subscribe(mainSid)
    const since = proto.events.length
    await proto.send(mainSid, 'tree-audit btw 线载体消息')
    await proto.waitTurnEnd(mainSid, { since, timeoutMs: 180_000 })
    const line = await proto.call('btw.create', { mainSid }, { replyType: 'btw.create', timeoutMs: 120_000 })
    const lineSid = line?.sessionId
    await timedHistory(proto, lineSid, {})
    const lineIdx = path.join(extRoot, lineSid, 'history-index', 'turns.json')
    const lineIdxExists = await waitIndexSettled(lineIdx)
    ev.assert('V10② 前置：线索引落盘', Boolean(lineIdxExists), {
      channel: 'C', expected: '线 history-index/turns.json 存在', actual: String(lineIdxExists),
    })
    await proto.call('btw.remove', { sessionId: lineSid }, { replyType: 'btw.remove', timeoutMs: 60_000 })
    const lineGone = !fs.existsSync(path.join(extRoot, lineSid))
    const btwTree = path.join(extRoot, mainSid, 'btw')
    const lineResidual = fs.existsSync(btwTree) ? treeUnder(btwTree) : []
    ev.step({ step: 'v10-2.line-tree', channel: 'B', exitCode: lineGone && lineResidual.length === 0 ? 0 : 1, stats: { lineDirGone: lineGone, btwResidual: lineResidual.slice(0, 8) } })
    ev.assert('V10②: 关线后线树回收（线 sessionId 目录无索引残留）', lineGone && lineResidual.length === 0, {
      channel: 'B', expected: '线树不存在', actual: lineGone ? '已回收' : `残留 ${lineResidual.slice(0, 5).join(',')}`,
    })

    // ── ③ N 次读取 + 真实追加的写入堆积 ──────────────────────────
    const sidB = growCarrier.sessionId
    const jsonlB = path.join(dataDir, 'agent', 'sessions', path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), growCarrier.sessionFile))
    await timedHistory(proto, sidB, {})
    await waitIndexSettled(path.join(extRoot, sidB, 'history-index', 'turns.json'))
    const idxDirB = path.join(extRoot, sidB, 'history-index')
    const idxFileB = path.join(idxDirB, 'turns.json')
    const baselineTurns = readTurnsJson(dataDir, sidB)
    const baselineBytes = baselineTurns?.bytes ?? 0
    const baselineTurnCount = baselineTurns?.turns ?? 0
    const offline = countUserTurns(jsonlB)
    ev.step({
      step: 'v10-3.grow-baseline',
      channel: 'C',
      exitCode: 0,
      stats: { turnsJsonBytes: baselineBytes, snapshotTurns: baselineTurnCount, offlineUserTurns: offline.userTurns, fileBytes: offline.fileBytes },
    })
    let driftRounds = 0
    let tmpResidual = 0
    for (let i = 1; i <= APPEND_ROUNDS; i++) {
      appendEntry(jsonlB, makeMessageEntry('user', `tree-audit 追加轮 ${i}（user 边界）`))
      appendEntry(jsonlB, makeMessageEntry('assistant', `tree-audit 追加轮 ${i} 回复`))
      const read = await timedHistory(proto, sidB, {})
      if (read.reply?.error) throw new Error(`增长循环第 ${i} 轮读取失败：${read.reply.error}`)
      const files = treeUnder(idxDirB)
      const turnsNow = readTurnsJson(dataDir, sidB)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      const notTurns = files.filter((f) => f !== 'turns.json' && !f.endsWith('.tmp'))
      if (tmpFiles.length > 0 || notTurns.length > 0) tmpResidual += 1
      if (turnsNow?.bytes !== baselineBytes || turnsNow?.turns !== baselineTurnCount) driftRounds += 1
      ev.step({
        step: `v10-3.round-${i}`,
        channel: 'C',
        exitCode: tmpFiles.length === 0 && notTurns.length === 0 && turnsNow?.bytes === baselineBytes ? 0 : 1,
        stats: { idxFiles: files.length, turnsJsonBytes: turnsNow?.bytes ?? null, appendedVisible: JSON.stringify(read.reply?.messages ?? []).includes(`追加轮 ${i}`) },
      })
    }
    const finalIdx = treeUnder(idxDirB)
    ev.step({
      step: 'v10-3.grow-verdict',
      channel: 'B',
      exitCode: driftRounds === 0 && tmpResidual === 0 && finalIdx.length === 1 ? 0 : 1,
      stats: { rounds: APPEND_ROUNDS, driftRounds, tmpResidual, finalFiles: finalIdx, baselineBytes, finalBytes: readTurnsJson(dataDir, sidB)?.bytes ?? null, offlineFinal: countUserTurns(jsonlB).userTurns },
    })
    ev.assert(`V10③: ${APPEND_ROUNDS} 轮读取+追加后 history-index 恰一个 turns.json、无 .tmp 残留`, finalIdx.length === 1 && tmpResidual === 0, {
      channel: 'B', expected: '恰 turns.json 且无 .tmp', actual: `files=${finalIdx.join(',')} tmpResidualRounds=${tmpResidual}`,
    })
    ev.assert('V10③: 磁盘 turns.json 恒等于构建快照（字节与 turn 数不随追加增长——健康追加不回写）', driftRounds === 0, {
      channel: 'B', expected: `bytes=${baselineBytes} turns=${baselineTurnCount} 恒定`, actual: `漂移轮数=${driftRounds}`,
    })
    ev.step({ step: 'v10-3.monotonic-record', channel: 'C', exitCode: 0, stats: { note: '单调有界记录（不设通过阈值）：构建快照 turns.json 字节', bytes: baselineBytes, snapshotTurns: baselineTurnCount, offlineFinalUserTurns: countUserTurns(jsonlB).userTurns } })

    // ── ④ 归档恢复循环三次 ───────────────────────────────────────
    const sidC = archiveCarrier.sessionId
    const first = await timedHistory(proto, sidC, {})
    await waitIndexSettled(path.join(extRoot, sidC, 'history-index', 'turns.json'))
    const firstDigest = JSON.stringify((first.reply?.messages ?? []).map((m) => m?.piEntryId))
    const idxBeforeLoops = treeUnder(path.join(extRoot, sidC, 'history-index'))
    const beforeFile = readTurnsJson(dataDir, sidC)
    let loopDiffs = 0
    for (let i = 1; i <= 3; i++) {
      await proto.call('session.archive', { sessionId: sidC }, { replyType: 'session.archive', timeoutMs: 60_000 })
      const archiveIdx = treeUnder(archivesRoot).filter((f) => f.includes('history-index'))
      const sessionsJsonlGone = !fs.existsSync(jsonlOf(dataDir, PROD_DATA_DIR, archiveCarrier.sessionFile))
      ev.step({
        step: `v10-4.archive-${i}`,
        channel: 'C',
        exitCode: archiveIdx.length === 0 ? 0 : 1,
        stats: { loop: i, historyIndexInArchive: archiveIdx, sessionsJsonlGone, archivedTreeCount: treeUnder(archivesRoot).length },
      })
      if (archiveIdx.length > 0) loopDiffs += 1
      await proto.call('session.unarchive', { sessionId: sidC }, { replyType: 'session.unarchive', timeoutMs: 60_000 })
      const reread = await timedHistory(proto, sidC, {})
      const rereadDigest = JSON.stringify((reread.reply?.messages ?? []).map((m) => m?.piEntryId))
      const idxAfterLoops = treeUnder(path.join(extRoot, sidC, 'history-index'))
      const idxNotGrowing = JSON.stringify(idxAfterLoops) === JSON.stringify(idxBeforeLoops)
      const historyComplete = rereadDigest === firstDigest
      ev.step({
        step: `v10-4.restore-${i}`,
        channel: 'B',
        exitCode: historyComplete && idxNotGrowing ? 0 : 1,
        stats: { loop: i, historyComplete, idxNotGrowing, idxFiles: idxAfterLoops.length, turnsBytes: readTurnsJson(dataDir, sidC)?.bytes ?? null },
      })
      if (!historyComplete || !idxNotGrowing) loopDiffs += 1
    }
    const turnsAfter = readTurnsJson(dataDir, sidC)
    ev.step({
      step: 'v10-4.verdict',
      channel: 'B',
      exitCode: loopDiffs === 0 ? 0 : 1,
      stats: { loopDiffs, idxFilesBefore: idxBeforeLoops.length, idxFilesAfter: treeUnder(path.join(extRoot, sidC, 'history-index')).length, bytesBefore: beforeFile?.bytes ?? null, bytesAfter: turnsAfter?.bytes ?? null },
    })
    ev.assert('V10④: 归档恢复循环三次后树面不增长、每次历史完整（归档单元无 history-index）', loopDiffs === 0, {
      channel: 'B', expected: '树面恒定 + 历史完整 ×3', actual: `异常 ${loopDiffs} 处`,
    })
  } finally {
    await proto.close().catch(() => {})
  }

  log(`turn-index-tree-audit: 完成（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}

/** 会话 jsonl 在实例树内的路径（归档循环树面核对用）。 */
function jsonlOf(dataDir, prodRoot, sessionFile) {
  return path.join(dataDir, 'agent', 'sessions', path.relative(path.join(prodRoot, 'agent', 'sessions'), sessionFile))
}
