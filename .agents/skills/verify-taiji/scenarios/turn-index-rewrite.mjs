/**
 * turn-index-rewrite —— V4 同尺寸重写且保留 mtime 的失配重建（impl-plan §4.2 A4）。
 *
 * 攻击向量：旧链缓存完整消息数组、只信 stat（size + mtime）判定有效性——等长替换一个
 * 真实 user turn 的文本并恢复 mtime 后，stat 完全不变、缓存照旧返回旧消息（不重读文件）。
 * 终态索引路径每次窗口读取以实际边界 entryId 校验兜底（设计 §3.1「窗口选择与单次快照」），
 * 必须返回新文件内容、不得出现新旧拼接。
 *
 * 步骤：种子真实会话 → 读一次建索引并留改写前窗口基线 → rewriteTurnInPlaceKeepStat
 * 等长改写 + mtime 回写 → 再读同窗口：messageCount 与 piEntryId 序列与基线一致（布局
 * 未动）、恰好一条消息文本带 rewrite-probe- marker（其余逐条不变——只返回新文件内容）
 * → cursor 翻页同判据 → 第二次请求仍为新内容（重建后新索引复用）。
 *
 * 跑绿门：挂 u-reader commit 门（impl-plan DAG：断言依赖索引编排与 entryId 校验终态；
 * 基线旧代码 stat 命中返回无 marker 旧内容——该形态正是本剧本要消灭的缺陷，不在基线
 * 环境跑）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  isBaselineCollectMode,
  oldestCursor,
  readRuntimePort,
  readTurnsJson,
  rewriteTurnInPlaceKeepStat,
  seedProbeSession,
  timedHistory,
} from './lib/turn-index-lib.mjs'
import { pickLargestSession, PROD_DATA_DIR, scanSessionPool } from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

/** 采样门槛：≥1MB 真实会话（user turn 文本密度足够等长改写）；上限 32MB 控制首建成本。 */
const REWRITE_MIN_BYTES = 1_000_000
const REWRITE_MAX_BYTES = 32_000_000

/** 等长改写 marker（lib.rewriteTurnInPlaceKeepStat 注入的前缀）。 */
const REWRITE_MARKER = 'rewrite-probe-'

export const meta = {
  id: 'turn-index-rewrite',
  priority: 'P0',
  title: 'V4 同尺寸重写 + mtime 保留：entryId 校验兜住只信 stat 的旧索引——窗口只含新文件内容、无旧缓存拼接',
  covers: ['env.launch', 'env.ready', 'session.history'],
  requires: ['u-assets-prep'],
  estimateSec: 240,
  provable: [
    'V4: 建索引后同尺寸重写 + mtime 恢复，最近窗口 messageCount 与 piEntryId 序列与改写前基线一致（文件布局未动）',
    'V4: 窗口内恰好一条消息带 rewrite-probe- marker、其余消息逐条不变（只返回新文件内容，不返回旧缓存）',
    'V4: cursor 翻页窗口同判据（marker 唯一、id 序列无重复）',
    'V4: 第二次请求仍为新内容且读取耗时回到就绪量级（重建后新索引复用）',
  ],
  notProvable: [
    '重建触发的分类记录（touch/失配分类计数属 runtime 内部观测，剧本以行为结果承载——分类记录可采样性由 store 单测核对）',
    '改写 turn 在 cursor 翻页窗内的精确命中（改写目标取物理尾 1MB 内最后一个 user turn，翻页窗是否覆盖它取决于窗口深度；未覆盖时以最近窗口判据承载）',
  ],
}

/** 挑重写载体：生产池 1-32MB、体量从小到大第一个（改写窗口小、读取快）。 */
function pickRewriteSession(prodRoot) {
  const pool = scanSessionPool(prodRoot)
    .filter((s) => s.bytes >= REWRITE_MIN_BYTES && s.bytes <= REWRITE_MAX_BYTES)
    .sort((a, b) => a.bytes - b.bytes)
  return pool[0] ?? pickLargestSession(pool, { minBytes: REWRITE_MIN_BYTES })
}

/** 窗口摘要：逐条消息 {piEntryId, text}（对照判据的稳定形态）。 */
function windowDigest(reply) {
  return (reply?.messages ?? []).map((m) => ({
    id: m?.piEntryId ?? null,
    text: typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? null),
  }))
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []
  if (baseline) {
    uncovered.push('V4 在基线旧代码上语义不可判（stat 命中返回旧内容正是被消灭的缺陷形态）——本剧本只挂 u-reader commit 门跑')
    log('baseline collect 模式：V4 不采集（无对照价值），直接返回')
    return { uncovered, gotchas }
  }

  // ── 段 0：fixture 采集 ─────────────────────────────────────────
  await instance.stop()
  const picked = pickRewriteSession(PROD_DATA_DIR)
  ev.assert('V4 载体：生产池含 1-32MB 真实会话样本', Boolean(picked), {
    channel: 'C', expected: '1-32MB 样本 1 个', actual: picked ? `${(picked.bytes / 1_000_000).toFixed(1)}MB ${picked.sessionId}` : '无',
  })
  if (!picked) throw new Error('生产池无 V4 重写载体样本')
  seedProbeSession(dataDir, PROD_DATA_DIR, picked)
  const jsonlCopy = path.join(dataDir, 'agent', 'sessions', path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), picked.sessionFile))

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'rewrite.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
  const sid = picked.sessionId

  try {
    // ── 段 1：建索引 + 改写前窗口基线 ─────────────────────────────
    const first = await timedHistory(proto, sid, {})
    if (first.reply?.error) throw new Error(`首读失败：${first.reply.error}`)
    const turns = readTurnsJson(dataDir, sid)
    ev.assert('V4 前置：首读后索引已落盘（turns.json 存在）', Boolean(turns), {
      channel: 'C', expected: 'history-index/turns.json 存在', actual: turns ? `${turns.bytes}B turns=${turns.turns}` : '缺失',
    })
    if (!turns) throw new Error('首读未落盘索引——u-reader 编排未生效或读取失败，V4 失配重建无攻击对象')
    const before = windowDigest(first.reply)
    const beforeIds = before.map((m) => m.id)
    const beforeDup = beforeIds.filter((id, i) => beforeIds.indexOf(id) !== i)
    ev.assert('V4 前置：改写前窗口基线可判（消息非空、id 无重复、无 marker）', before.length > 0 && beforeDup.length === 0 && before.every((m) => !m.text.includes(REWRITE_MARKER)), {
      channel: 'C',
      expected: '非空 + 无重复 + 无 marker',
      actual: `messages=${before.length} dup=${beforeDup.length} marker=${before.some((m) => m.text.includes(REWRITE_MARKER))}`,
    })

    // ── 段 2：同尺寸重写 + mtime 恢复 ─────────────────────────────
    const rewrite = rewriteTurnInPlaceKeepStat(jsonlCopy)
    ev.assert('V4: 等长改写命中一个真实 user turn（字节数不变）', rewrite.rewrote && rewrite.bytesBefore === rewrite.bytesAfter, {
      channel: 'C',
      expected: `rewrote=true bytes ${rewrite.bytesBefore}→${rewrite.bytesBefore}`,
      actual: `rewrote=${rewrite.rewrote} bytes ${rewrite.bytesBefore}→${rewrite.bytesAfter}`,
    })
    if (!rewrite.rewrote) throw new Error('等长改写未命中（样本尾部 1MB 无可改写 user turn）——换载体或调整采样门槛')
    const statAfter = fs.statSync(jsonlCopy)
    ev.step({ step: 'v4.rewrite-keep-stat', channel: 'C', exitCode: 0, stats: { bytes: statAfter.size, mtimeMs: Math.round(statAfter.mtimeMs) } })

    // ── 段 3：重写后读取同窗口——只返回新文件内容 ──────────────────
    const after = await timedHistory(proto, sid, {})
    if (after.reply?.error) throw new Error(`重写后读取失败：${after.reply.error}`)
    const afterDigest = windowDigest(after.reply)
    const afterIds = afterDigest.map((m) => m.id)
    const markerHits = afterDigest.filter((m) => m.text.includes(REWRITE_MARKER))
    const sameShape = afterDigest.length === before.length && JSON.stringify(afterIds) === JSON.stringify(beforeIds)
    const othersUnchanged = afterDigest.filter((m) => !m.text.includes(REWRITE_MARKER)).every((m) => {
      const old = before.find((b) => b.id === m.id)
      return old ? old.text === m.text : false
    })
    ev.step({
      step: 'v4.post-rewrite-window',
      channel: 'B',
      exitCode: sameShape && markerHits.length === 1 && othersUnchanged ? 0 : 1,
      stats: { before: before.length, after: afterDigest.length, shapeSame: sameShape, markerCount: markerHits.length, othersUnchanged },
    })
    ev.assert('V4: 重写后窗口布局与基线一致（messageCount 与 piEntryId 序列不变）', sameShape, {
      channel: 'B', expected: `${before.length} 条同序`, actual: `${afterDigest.length} 条 shapeSame=${sameShape}`,
    })
    ev.assert('V4: 窗口内恰好一条消息带 marker 且其余逐条不变（新文件内容，非旧缓存回放）', markerHits.length === 1 && othersUnchanged, {
      channel: 'B',
      expected: 'marker=1 其余不变',
      actual: `marker=${markerHits.length} othersUnchanged=${othersUnchanged}`,
    })

    // ── 段 4：cursor 翻页同判据 ───────────────────────────────────
    const cursor = oldestCursor(after.reply)
    if (cursor) {
      const paged = await timedHistory(proto, sid, { cursor })
      const pagedDigest = windowDigest(paged.reply)
      const pagedIds = pagedDigest.map((m) => m.id)
      const pagedDup = pagedIds.filter((id, i) => pagedIds.indexOf(id) !== i)
      const pagedMarker = pagedDigest.filter((m) => m.text.includes(REWRITE_MARKER))
      ev.step({
        step: 'v4.post-rewrite-paging',
        channel: 'B',
        exitCode: pagedDup.length === 0 ? 0 : 1,
        stats: { messages: pagedDigest.length, dupCount: pagedDup.length, markerCount: pagedMarker.length, truncated: paged.reply?.truncated ?? null },
      })
      ev.assert('V4: cursor 翻页无重复 entryId（不重不漏）', pagedDup.length === 0, {
        channel: 'B', expected: '重复 0 条', actual: pagedDup.length === 0 ? '无重复' : `重复 ${pagedDup.slice(0, 5).join(',')}`,
      })
      if (pagedMarker.length > 0) {
        ev.assert('V4: 翻页窗覆盖改写 turn 时同样只返回新内容（marker 唯一）', pagedMarker.length === 1, {
          channel: 'B', expected: 'marker=1', actual: `marker=${pagedMarker.length}`,
        })
      } else {
        uncovered.push('V4 翻页窗未覆盖改写 turn（改写目标在最近窗口内，翻页深度未及——拼接判据由最近窗口承载，见 notProvable）')
      }
    } else {
      uncovered.push('V4 cursor 翻页（最近窗口无翻页 cursor——单窗口样本，判据由最近窗口承载）')
    }

    // ── 段 5：第二次请求复用新索引 ────────────────────────────────
    const second = await timedHistory(proto, sid, {})
    const secondDigest = windowDigest(second.reply)
    const secondMarker = secondDigest.filter((m) => m.text.includes(REWRITE_MARKER)).length
    const turns2 = readTurnsJson(dataDir, sid)
    ev.step({
      step: 'v4.second-read',
      channel: 'B',
      exitCode: secondMarker === 1 && second.elapsedMs < 1_000 ? 0 : 1,
      stats: { messages: secondDigest.length, markerCount: secondMarker, elapsedMs: second.elapsedMs, turnsJsonBytes: turns2?.bytes ?? null },
    })
    ev.assert('V4: 第二次请求使用新索引（marker 仍在、耗时回到就绪量级 <1000ms）', secondMarker === 1 && second.elapsedMs < 1_000, {
      channel: 'B', expected: 'marker=1 且 <1000ms', actual: `marker=${secondMarker} ${second.elapsedMs}ms`,
    })
    ev.step({ step: 'v4.turns-json-size', channel: 'C', exitCode: 0, stats: { bytes: turns2?.bytes ?? null, turns: turns2?.turns ?? null, note: '重建后索引字节数记录；>5MB 重审触发线由 V2 探针输出对账，不在此判阈值' } })
  } finally {
    await proto.close().catch(() => {})
  }

  log(`turn-index-rewrite: 完成（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}
