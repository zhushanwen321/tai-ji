/**
 * turn-index-btw-archive —— V6 btw 线独立索引与主会话归档恢复（impl-plan §4.2 A6）。
 *
 * 段 1 btw 线：主会话发一轮 faux 消息 → btw.create fork 出线（线 sessionId）→ 读线
 * history（建立线 sessionId 独立索引）→ 线翻页 → btw.remove 关线 → 重新 btw.create
 * 开新线 → 新线回放与关线前线窗口语义等价（主会话进度未变，两次 fork 快照同内容）。
 * 线索引落 <dataDir>/ext-sessions/<mainSid>/btw/ 线树内（ADR-0151 布局），主线与线
 * 互不串历史。
 *
 * 段 2 归档恢复：已有索引的主会话 → session.archive（归档资产闭集只有 attachments /
 * artifacts / image-cache，history-index 不搬移）→ 树面核对归档单元无 history-index →
 * session.unarchive → 读同一窗口 → 历史完整（与归档前逐字段等价，恢复后按 stat 与
 * entryId 校验复用或重建——两种结果都合法，不为复用率设指标）。
 *
 * 跑绿门：挂 u-retire-protocol commit 门（impl-plan A6 行非核心组；断言依赖索引编排
 * 与生命周期挂点终态）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  diffHistorySnapshots,
  oldestCursor,
  readRuntimePort,
  readTurnsJson,
  snapshotHistoryWindow,
  timedHistory,
} from './lib/turn-index-lib.mjs'

/** faux 模型 id（装配见 meta.faux；凭证无关零 token）。 */
const FAUX_MODEL = 'faux/faux-1'

export const meta = {
  id: 'turn-index-btw-archive',
  priority: 'P1',
  title: 'V6 btw 线独立索引与关线重开回放 + 主会话归档恢复历史完整',
  covers: ['env.launch', 'env.ready', 'session.create', 'session.history', 'chat.send', 'chat.wait', 'evidence.logs'],
  requires: ['faux', 'u-assets-prep'],
  estimateSec: 300,
  faux: {
    responses: {
      'faux/faux-1': [{ text: 'btw-archive-main-answer', stopReason: 'stop' }],
    },
  },
  provable: [
    'V6: btw 线 history 可读（线 sessionId 独立索引），翻页 cursor 正确',
    'V6: 线回放 = 主会话 fork 时点内容（轮次与文本），主线与线互不串',
    'V6: btw.remove 关线后重开线，新线回放与关线前线窗口语义等价（主进度未变，两次 fork 同内容）',
    'V6: session.archive 后归档单元内无 history-index（索引不随归档搬运）',
    'V6: session.unarchive 后读同一窗口与归档前逐字段等价（历史完整，复用或重建均合法）',
  ],
  notProvable: [
    '线内新发消息的索引续扫（线内 send 需线 pi 进程派发链，不在本剧本射程；线索引的增量语义由 probe A3 同机制承载）',
    '恢复后「复用 vs 重建」的内部路径区分（设计明确两种结果都合法，不为复用率设指标——剧本只断言历史完整）',
  ],
}

/** 树面枚举（相对 dataDir 的文件清单，判残留/搬运用）。 */
function treeFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(root, p))
    }
  }
  walk(root)
  return out.sort()
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = []
  const faux = meta.faux

  // 实例重启保证 faux 装配（runner 预建实例可能已 launch：faux 响应由 instance 构造参数
  // 承载，重启不必要——直接复用现成实例与协议）
  const proto = await instance.protocol()
  try {
    // ── 段 0：主会话建一轮内容 ────────────────────────────────────
    const created = await proto.call('session.create', { cwd: repo, label: 'btw-archive-main', modelOverride: FAUX_MODEL }, { timeoutMs: 120_000 })
    const mainSid = created.session?.id
    ev.assert('V6 前置：主会话创建', Boolean(mainSid), { channel: 'C', expected: 'session.id 非空', actual: mainSid ?? 'null' })
    if (!mainSid) throw new Error('主会话创建失败')
    await proto.subscribe(mainSid)
    const since = proto.events.length
    await proto.send(mainSid, 'btw-archive 主会话基线消息')
    const end = await proto.waitTurnEnd(mainSid, { since, timeoutMs: 180_000 })
    ev.assert('V6 前置：主会话轮完成（fork 快照载体）', end.ok === true, {
      channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
    })

    // ── 段 1：btw 线独立索引 ─────────────────────────────────────
    const line1 = await proto.call('btw.create', { mainSid }, { replyType: 'btw.create', timeoutMs: 120_000 })
    const lineSid = line1?.sessionId
    ev.assert('V6: btw 线创建（线 sessionId 返回）', Boolean(lineSid), {
      channel: 'C', expected: 'sessionId 非空', actual: lineSid ?? JSON.stringify(line1)?.slice(0, 120),
    })
    if (!lineSid) throw new Error('btw.create 未返回线 sessionId')

    const lineRecent = await timedHistory(proto, lineSid, {})
    if (lineRecent.reply?.error) throw new Error(`线 history 读取失败：${lineRecent.reply.error}`)
    const lineSnap = snapshotHistoryWindow(lineRecent.reply)
    ev.step({
      step: 'v6.line-history',
      channel: 'B',
      exitCode: lineSnap.messageCount > 0 ? 0 : 1,
      stats: { lineSid, messages: lineSnap.messageCount, truncated: lineSnap.truncated, totalEstimate: lineSnap.totalTurnsEstimate },
    })
    ev.assert('V6: 线 history 含 fork 快照内容（主会话基线文本在场）', JSON.stringify(lineSnap).includes('btw-archive-main-answer'), {
      channel: 'B', expected: '含主会话 fork 内容', actual: `messages=${lineSnap.messageCount}`,
    })

    const lineCursor = oldestCursor(lineRecent.reply)
    if (lineCursor) {
      const linePaged = await timedHistory(proto, lineSid, { cursor: lineCursor })
      const linePagedSnap = snapshotHistoryWindow(linePaged.reply)
      const ids = (linePaged.reply?.messages ?? []).map((m) => m?.piEntryId).filter(Boolean)
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
      ev.assert('V6: 线翻页 cursor 正确（无重复 entryId）', dup.length === 0, {
        channel: 'B', expected: '重复 0 条', actual: dup.length === 0 ? '无重复' : `重复 ${dup.slice(0, 5).join(',')}`,
      })
    } else {
      uncovered.push('V6 线翻页（线窗口无翻页 cursor——fork 快照单窗口，判据由最近窗口承载）')
    }

    // 主线不串：线窗口的内容不因主线后续读取漂移（同一份 fork 快照两次读一致）
    const lineAgain = snapshotHistoryWindow((await timedHistory(proto, lineSid, {})).reply)
    const lineStable = diffHistorySnapshots(lineSnap, lineAgain)
    ev.assert('V6: 线索引复读稳定（两次读窗口等价——线不串主、主不串线的前提形态）', lineStable.length === 0, {
      channel: 'B', expected: '等价', actual: lineStable.length === 0 ? '等价' : lineStable.slice(0, 3).join('；'),
    })

    // ── 段 2：关线 → 重开回放一致 ────────────────────────────────
    await proto.call('btw.remove', { sessionId: lineSid }, { replyType: 'btw.remove', timeoutMs: 120_000 })
    ev.step({ step: 'v6.line-removed', channel: 'C', exitCode: 0, stats: { lineSid } })
    const line2 = await proto.call('btw.create', { mainSid }, { replyType: 'btw.create', timeoutMs: 120_000 })
    const lineSid2 = line2?.sessionId
    ev.assert('V6: 重开线（新线 sessionId）', Boolean(lineSid2) && lineSid2 !== lineSid, {
      channel: 'C', expected: '新 sessionId ≠ 旧', actual: `${lineSid2}（旧 ${lineSid}）`,
    })
    const line2Snap = snapshotHistoryWindow((await timedHistory(proto, lineSid2, {})).reply)
    // 两次 fork 之间主会话无新增内容 → 回放语义等价（用稳定字段对照：消息数与文本）
    const replayEq = line2Snap.messageCount === lineSnap.messageCount
      && JSON.stringify(line2Snap.messages.map((m) => m.contentDigest)) === JSON.stringify(lineSnap.messages.map((m) => m.contentDigest))
    ev.step({
      step: 'v6.line-replay',
      channel: 'B',
      exitCode: replayEq ? 0 : 1,
      stats: { line1Messages: lineSnap.messageCount, line2Messages: line2Snap.messageCount },
    })
    ev.assert('V6: 重开线回放与关线前线窗口语义等价（主进度未变，两次 fork 同内容）', replayEq, {
      channel: 'B',
      expected: `${lineSnap.messageCount} 条同文本序列`,
      actual: `重开线 ${line2Snap.messageCount} 条`,
    })

    // ── 段 3：主会话建索引 → 归档 → 恢复 ─────────────────────────
    const mainRecent = await timedHistory(proto, mainSid, {})
    if (mainRecent.reply?.error) throw new Error(`主会话 history 读取失败：${mainRecent.reply.error}`)
    const mainSnap = snapshotHistoryWindow(mainRecent.reply)
    const mainIndex = readTurnsJson(dataDir, mainSid)
    ev.step({
      step: 'v6.main-index',
      channel: 'C',
      exitCode: 0,
      stats: { messages: mainSnap.messageCount, indexBytes: mainIndex?.bytes ?? null, turns: mainIndex?.turns ?? null },
    })

    await proto.call('session.archive', { sessionId: mainSid }, { replyType: 'session.archive', timeoutMs: 120_000 })
    // 归档搬移资产闭集 = attachments/artifacts/image-cache：归档单元内不得出现 history-index
    const archivesRoot = path.join(dataDir, 'archives')
    const archivedTree = treeFiles(archivesRoot).filter((f) => f.includes('history-index'))
    ev.step({ step: 'v6.archived-tree', channel: 'C', exitCode: 0, stats: { archiveFiles: treeFiles(archivesRoot).length, historyIndexInArchive: archivedTree } })
    ev.assert('V6: 归档单元内无 history-index（索引不随归档搬运）', archivedTree.length === 0, {
      channel: 'C', expected: 'history-index 出现 0 次', actual: archivedTree.length === 0 ? '无' : archivedTree.join(','),
    })

    const unarchived = await proto.call('session.unarchive', { sessionId: mainSid }, { replyType: 'session.unarchive', timeoutMs: 120_000 })
    ev.assert('V6: unarchive 成功（返回恢复后 SessionSummary）', Boolean(unarchived?.session), {
      channel: 'C', expected: 'session 非空', actual: unarchived?.session ? `id=${unarchived.session?.id ?? 'n/a'}` : JSON.stringify(unarchived)?.slice(0, 120),
    })
    const afterRestore = snapshotHistoryWindow((await timedHistory(proto, mainSid, {})).reply)
    const restoreDiffs = diffHistorySnapshots(mainSnap, afterRestore)
    ev.step({
      step: 'v6.restore-history',
      channel: 'B',
      exitCode: restoreDiffs.length === 0 ? 0 : 1,
      stats: { before: mainSnap.messageCount, after: afterRestore.messageCount, diffCount: restoreDiffs.length },
    })
    ev.assert('V6: 恢复后同窗口与归档前逐字段等价（历史完整）', restoreDiffs.length === 0, {
      channel: 'B', expected: '等价', actual: restoreDiffs.length === 0 ? '等价' : restoreDiffs.slice(0, 5).join('；'),
    })
    if (restoreDiffs.length > 0) ev.attach('v6-restore-full-diff', JSON.stringify(restoreDiffs, null, 1))
  } finally {
    // 协议由 runner 持有（instance.protocol()），不在此 close
  }

  log(`turn-index-btw-archive: 完成（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}
