/**
 * turn-index-differential —— V5 复杂消息与撤回语义的新旧 runtime 对照（differential testing）。
 *
 * 同一真实会话文件分别对「改造前基线 runtime」与「改造后索引 runtime」各读一遍，
 * 固定最近窗口 + cursor 窗口逐字段对照（消息内容 / toolCalls / segments / endedAt /
 * 活跃路径 / truncated / loadedTurns / interrupted；impl-plan §4.2 A5 行）。
 *
 * 两种模式（env TURN_INDEX_BASELINE_COLLECT=1 切换，lib.isBaselineCollectMode）：
 * - 采集模式（u-assets-prep 在基线 commit 494436875 独立环境执行）：只跑基线腿——
 *   快照落 ~/.agents/skill-data/verify-taiji/assets/turn-index-baseline/v5-window-*.json
 *   + 载体身份登记 v5-carrier.json；改造后旧读取路径不存在，本模式不可复得。
 * - 对照模式（默认，挂 u-reader commit 门）：读同一载体跑改造后腿，与基线快照逐字段
 *   diff；除 totalTurnsEstimate（索引路径为精确 user turn 总数、基线为尾读下界，设计
 *   §3.1「cursor 未命中 turns 时」段，单独断言新 ≥ 旧）外差异必须为空——V5 通过标准
 *   「差异必须先归因，不能直接改期望放行」，diff 非空即 fail 并附两侧值。
 *
 * 载体：pickDiffCarrierSession 按内容特征（toolCalls / compaction / 撤回 label /
 * segments）打分挑 ≤8MB 真实会话；采集与对照必须命中同一文件——以 v5-carrier.json
 * 固化身份（sessionId + 相对路径 + 字节数），载体漂移（文件缺失/尺寸变化）时 fail 并
 * 指引重采，禁止静默换载体（换载体 = 对照无效）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ASSET_DIR,
  diffHistorySnapshots,
  isBaselineCollectMode,
  oldestCursor,
  pickDiffCarrierSession,
  readRuntimePort,
  seedProbeSession,
  snapshotHistoryWindow,
  timedHistory,
} from './lib/turn-index-lib.mjs'
import { PROD_DATA_DIR } from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

/** 载体身份登记文件（采集落盘、对照消费）。 */
function carrierFile() {
  return path.join(BASELINE_ASSET_DIR, 'v5-carrier.json')
}

export const meta = {
  id: 'turn-index-differential',
  priority: 'P0',
  title: 'V5 新旧 runtime 对照：工具/segments/compaction/撤回会话的窗口语义逐字段等价（基线采集 + 改造后对照）',
  covers: ['env.launch', 'env.ready', 'session.history', 'evidence.logs'],
  requires: ['u-assets-prep'],
  estimateSec: baseline ? 240 : 300,
  provable: [
    'V5: 固定最近窗口——新旧 runtime 的 messageCount / truncated / loadedTurns / interrupted 与逐消息字段（role/piEntryId/toolCalls/segments/endedAt/interrupted/isError/contentDigest）逐项相等',
    'V5: cursor 窗口（第二页）同口径逐项相等',
    'V5: totalTurnsEstimate 语义升级有界——索引精确值 ≥ 基线尾读下界（设计内差异，单独归因）',
    'V5: 重开应用（重启 runtime）后同窗口再读与重启前一致（历史不因重启漂移）',
  ],
  notProvable: [
    '被撤分支「不显示」的渲染层形态（快照口径 = reply.messages 已是活跃路径视图；撤回 label entry 的转换细节归 entry-tree-builder 单测）',
    '基线缺失时对照不可判（对照模式读不到 v5-window-*.json 即 fail 指引先跑采集模式，不静默跳过）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []

  // ── 段 0：载体定位（采集 = 挑选 + 登记；对照 = 读登记定位同一文件） ──
  await instance.stop()
  let carrier = null
  if (baseline) {
    carrier = pickDiffCarrierSession()
    ev.assert(
      'V5 载体：生产池含 ≥2 类特征（toolCalls/compaction/撤回 label/segments）的 ≤8MB 会话',
      Boolean(carrier),
      { channel: 'C', expected: 'score ≥2 的 ≤8MB 样本 1 个', actual: carrier ? `${carrier.session.sessionId} score=${carrier.score} features=${JSON.stringify(carrier.features)}` : '无' },
    )
    if (!carrier) throw new Error('生产池无 V5 对照载体（≤8MB 且含 ≥2 类特征），采集不可执行')
    fs.mkdirSync(BASELINE_ASSET_DIR, { recursive: true })
    fs.writeFileSync(
      carrierFile(),
      `${JSON.stringify({ sessionId: carrier.session.sessionId, rel: path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), carrier.session.sessionFile), bytes: carrier.session.bytes, features: carrier.features }, null, 1)}\n`,
      'utf8',
    )
  } else {
    if (!fs.existsSync(carrierFile())) {
      throw new Error(`V5 基线快照缺失（${carrierFile()}）——先在基线环境以 TURN_INDEX_BASELINE_COLLECT=1 跑本剧本采集，再跑对照`)
    }
    const registered = JSON.parse(fs.readFileSync(carrierFile(), 'utf8'))
    const prodFile = path.join(PROD_DATA_DIR, 'agent', 'sessions', registered.rel)
    if (!fs.existsSync(prodFile)) {
      throw new Error(`V5 载体文件已不存在（${registered.rel}）——生产池漂移，重新采集基线（TURN_INDEX_BASELINE_COLLECT=1）后再对照`)
    }
    const bytes = fs.statSync(prodFile).size
    if (bytes !== registered.bytes) {
      throw new Error(`V5 载体已变化（${registered.rel}：登记 ${registered.bytes}B 现 ${bytes}B）——对照前提失效，重新采集基线后再对照`)
    }
    carrier = { session: { sessionId: registered.sessionId, sessionFile: prodFile, bytes, sidecars: [] }, features: registered.features, score: Object.values(registered.features).filter(Boolean).length }
    ev.assert('V5 载体：登记身份与当前生产文件一致（sessionId/路径/字节三对账）', true, {
      channel: 'C', expected: `${registered.rel} @ ${registered.bytes}B`, actual: `${registered.sessionId} @ ${bytes}B`,
    })
  }

  const seeded = seedProbeSession(dataDir, PROD_DATA_DIR, carrier.session)
  ev.step({ step: 'fixture.seed-carrier', channel: 'C', exitCode: 0, stats: { seeded: seeded.length, bytes: carrier.session.bytes, sessionId: carrier.session.sessionId } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'differential.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })

  const sid = carrier.session.sessionId
  try {
    // ── 段 1：固定最近窗口快照 ─────────────────────────────────────
    const recent = await timedHistory(proto, sid, {})
    const recentSnap = snapshotHistoryWindow(recent.reply)
    ev.step({
      step: 'v5.recent-window',
      channel: 'B',
      exitCode: recent.reply?.error ? 1 : 0,
      stats: { messages: recentSnap.messageCount, truncated: recentSnap.truncated, loadedTurns: recentSnap.loadedTurns, totalEstimate: recentSnap.totalTurnsEstimate, elapsedMs: recent.elapsedMs },
    })
    if (recent.reply?.error) throw new Error(`载体最近窗口读取失败：${recent.reply.error}`)

    // ── 段 2：cursor 窗口快照（cursor = 最近窗口最旧消息 entryId） ──
    const cursor = oldestCursor(recent.reply)
    ev.assert('V5: 最近窗口含可翻页 cursor（oldest piEntryId 非空）', Boolean(cursor), {
      channel: 'B', expected: 'piEntryId 非空', actual: cursor ?? 'null',
    })
    let cursorSnap = null
    if (cursor) {
      const paged = await timedHistory(proto, sid, { cursor })
      cursorSnap = snapshotHistoryWindow(paged.reply)
      ev.step({
        step: 'v5.cursor-window',
        channel: 'B',
        exitCode: paged.reply?.error ? 1 : 0,
        stats: { cursor, messages: cursorSnap.messageCount, truncated: cursorSnap.truncated, elapsedMs: paged.elapsedMs },
      })
      if (paged.reply?.error) throw new Error(`载体 cursor 窗口读取失败：${paged.reply.error}`)
    }

    if (baseline) {
      // ── 采集模式：基线腿落盘（改造后旧路径不可复得） ─────────────
      const payload = { capturedAt: new Date().toISOString(), sessionId: sid, fileBytes: carrier.session.bytes, recent: recentSnap, cursor: cursorSnap }
      for (const [kind, snap] of [['recent', recentSnap], ['cursor', cursorSnap]]) {
        if (!snap) continue
        fs.writeFileSync(
          path.join(BASELINE_ASSET_DIR, `v5-window-${kind}.json`),
          `${JSON.stringify({ ...payload, kind, snapshot: snap }, null, 1)}\n`,
          'utf8',
        )
      }
      ev.step({ step: 'v5.baseline-captured', channel: 'C', exitCode: 0, stats: { recentMessages: recentSnap.messageCount, cursorMessages: cursorSnap?.messageCount ?? null, outDir: BASELINE_ASSET_DIR } })
      uncovered.push(`基线采集：V5 基线腿已落盘（recent=${recentSnap.messageCount} 条 / cursor=${cursorSnap?.messageCount ?? 'n/a'} 条）；对照腿挂 u-reader commit 门在改造后环境执行`)
      gotchas.push('采集模式只产出数据，不做新旧等价断言（旧 runtime 单腿无对照对象）')
    } else {
      // ── 对照模式：读基线快照逐字段 diff ──────────────────────────
      for (const [kind, current] of [['recent', recentSnap], ['cursor', cursorSnap]]) {
        const baseFile = path.join(BASELINE_ASSET_DIR, `v5-window-${kind}.json`)
        if (!fs.existsSync(baseFile)) {
          throw new Error(`基线快照缺失（${baseFile}）——V5 对照前提失效，先采集后对照`)
        }
        const record = JSON.parse(fs.readFileSync(baseFile, 'utf8'))
        const baseSnap = record.snapshot
        const diffs = diffHistorySnapshots(baseSnap, current)
        ev.step({
          step: `v5.diff-${kind}`,
          channel: 'B',
          exitCode: diffs.length === 0 ? 0 : 1,
          stats: { baseMessages: baseSnap.messageCount, currentMessages: current.messageCount, diffCount: diffs.length, diffs: diffs.slice(0, 10) },
        })
        ev.assert(`V5: ${kind} 窗口新旧 runtime 逐字段等价（差异 0 条；totalTurnsEstimate 语义升级单独归因）`, diffs.length === 0, {
          channel: 'B',
          expected: '差异 0 条（先归因不改期望）',
          actual: diffs.length === 0 ? '等价' : diffs.slice(0, 5).join('；'),
        })
        if (diffs.length > 0) ev.attach(`v5-${kind}-full-diff`, JSON.stringify(diffs, null, 1))
      }
      // totalTurnsEstimate 语义升级有界：索引精确值 ≥ 尾读下界
      const baseRecent = JSON.parse(fs.readFileSync(path.join(BASELINE_ASSET_DIR, 'v5-window-recent.json'), 'utf8')).snapshot
      ev.assert('V5: totalTurnsEstimate 语义升级有界（索引精确值 ≥ 基线尾读下界）', recentSnap.totalTurnsEstimate >= (baseRecent.totalTurnsEstimate ?? 0), {
        channel: 'B', expected: `≥ ${baseRecent.totalTurnsEstimate ?? 0}`, actual: String(recentSnap.totalTurnsEstimate ?? 'null'),
      })

      // ── 段 3：重开应用再读一次（V5 步骤尾部） ────────────────────
      await proto.close().catch(() => {})
      await instance.stop()
      await instance.launch()
      await instance.waitReady({ timeoutMs: 180_000 })
      const proto2 = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
      try {
        const afterRestart = snapshotHistoryWindow((await timedHistory(proto2, sid, {})).reply)
        const diffs = diffHistorySnapshots(recentSnap, afterRestart)
        ev.step({
          step: 'v5.restart-consistency',
          channel: 'B',
          exitCode: diffs.length === 0 ? 0 : 1,
          stats: { messages: afterRestart.messageCount, diffCount: diffs.length },
        })
        ev.assert('V5: 重开应用后同窗口再读与重启前一致', diffs.length === 0, {
          channel: 'B', expected: '重启前后等价', actual: diffs.length === 0 ? '等价' : diffs.slice(0, 5).join('；'),
        })
        if (diffs.length > 0) ev.attach('v5-restart-full-diff', JSON.stringify(diffs, null, 1))
      } finally {
        await proto2.close().catch(() => {})
      }
    }
  } finally {
    await proto.close().catch(() => {})
  }

  log(`turn-index-differential: ${baseline ? '基线采集完成' : '对照完成'}（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}
