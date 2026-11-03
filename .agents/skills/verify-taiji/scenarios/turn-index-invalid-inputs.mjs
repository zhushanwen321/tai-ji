/**
 * turn-index-invalid-inputs —— V8 空文件 / 零 turn / 非边界 cursor / 未知 cursor /
 * 主文件不可读五类隔离（impl-plan §4.2 A8）。
 *
 * 五类隔离 fixture 手工构造进实例 dataDir（agent/sessions 树 + .project.json sidecar，
 * header 形态与 pi 真实写入一致；mkdtemp 纪律 = 实例 dataDir 自建、收尾随 dispose）：
 * - ① 空文件（0 字节 + sidecar）：history 维持空页（无 header 不被扫描纳管 = 查无此
 *   会话的空页语义），不崩溃。
 * - ② 零 turn 旧文件（只有 model_change + assistant entry，无 user 边界）：走现有尾读
 *   兼容分支，不崩、空页语义、totalTurnsEstimate 为兼容分支现有计数。
 * - ③ 合法但非边界的 cursor（真实 assistant entryId）：由尾读 cursor 兼容链定位，返回
 *   该 entry 之前的窗口。
 * - ④ 未知 cursor（8 hex 形态、文件中不存在）：返回空页且 truncated=false。
 * - ⑤ 主文件不可读（chmod 000）：EACCES 显式失败语义（不伪装成空历史），恢复权限后
 *   重试成功且内容完整。
 *
 * 跑绿门：挂 u-retire-protocol commit 门（A8 核心组；cursor 兼容链与错误分级依赖
 * u-reader 编排终态）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { isBaselineCollectMode, randomEntryId, readRuntimePort, timedHistory } from './lib/turn-index-lib.mjs'
import { loadActiveProjectIds, PROD_DATA_DIR, seedSessions } from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

/** 构造一个 pi 形态的 message entry（同 lib.makeMessageEntry，多带 id 显式入参）。 */
function msgEntry(role, text, id) {
  return { type: 'message', id: id ?? randomEntryId(), timestamp: Date.now(), message: { role, content: [{ type: 'text', text }] } }
}

/** 构造最小 header（session 行；pi 真实形态 = 首行 type:session 带 id）。 */
function headerEntry(sid) {
  return { type: 'session', version: 3, id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() }
}

/** 把 entries 写成实例树内的隔离会话文件（+ sidecar），返回 {sid, file}。 */
function writeFixtureSession(dataDir, projectId, entries, { empty = false } = {}) {
  const sid = entries[0]?.id ?? `fixture-${Date.now().toString(36)}`
  const dir = path.join(dataDir, 'agent', 'sessions', 'turn-index-fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  fs.writeFileSync(file, empty ? '' : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(`${file}.project.json`, JSON.stringify({ projectId }), 'utf8')
  return { sid, file }
}

export const meta = {
  id: 'turn-index-invalid-inputs',
  priority: 'P0',
  title: 'V8 五类隔离输入：空文件 / 零 turn / 非边界 cursor / 未知 cursor / 主文件不可读',
  covers: ['env.launch', 'env.ready', 'session.history', 'session.persistence'],
  requires: ['u-assets-prep'],
  estimateSec: 240,
  provable: [
    'V8①: 空文件（0 字节 + sidecar）history 维持空页语义，不崩溃',
    'V8②: 零 turn 旧文件（无 user 边界）走兼容分支，不崩、空页语义',
    'V8③: 合法非边界 cursor（真实 assistant entryId）由兼容链定位，返回其前窗口',
    'V8④: 未知 cursor 返回空页且 truncated=false',
    'V8⑤: 主文件不可读（chmod 000）显式失败（不伪装成空历史），恢复权限后重试成功',
  ],
  notProvable: [
    'EACCES 在 renderer 层的「失败行 + 重试入口」呈现（DOM 断言归 V9 双壳场景；本剧本在数据层断言失败语义上抛）',
    '空文件「不被扫描纳管」与「纳管后读空页」两种 runtime 内部路径的区分（对外语义同为空页）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []
  if (baseline) {
    uncovered.push('V8 对基线旧代码兼容分支行为大体成立，但 index 兼容分支（零 turn 索引落盘）不存在——本剧本挂 u-retire-protocol 门在改造后跑')
    log('baseline collect 模式：V8 不采集，直接返回')
    return { uncovered, gotchas }
  }

  // ── 段 0：fixture 构造（stop 期写盘，launch 后读） ───────────────
  await instance.stop()
  seedSessions(dataDir, PROD_DATA_DIR, []) // 拷贝生产 projects.json（sidecar projectId 归属判据）
  const projectId = [...loadActiveProjectIds(PROD_DATA_DIR)][0]
  ev.assert('V8 前置：活跃 projectId 可取得（sidecar 归属判据载体）', Boolean(projectId), {
    channel: 'C', expected: 'projectId 1 个', actual: projectId ?? '无',
  })
  if (!projectId) throw new Error('生产 projects.json 无活跃项目——sidecar 归属判据无载体')

  const empty = writeFixtureSession(dataDir, projectId, [{ id: `0${randomEntryId()}`.slice(0, 32) }], { empty: true })
  const zeroTurn = writeFixtureSession(dataDir, projectId, [
    headerEntry(crypto.randomUUID()),
    { type: 'model_change', id: randomEntryId(), parentId: null, timestamp: new Date().toISOString(), provider: 'faux', modelId: 'faux' },
    msgEntry('assistant', 'invalid-inputs 零 turn 文件的孤立 assistant entry（无 user 边界）'),
  ])
  const multi = writeFixtureSession(dataDir, projectId, [
    headerEntry(crypto.randomUUID()),
    msgEntry('user', 'invalid-inputs 第一轮用户消息（turn 1 边界）', 'u0001aa'),
    msgEntry('assistant', 'invalid-inputs 第一轮助手回复', 'a0001bb'),
    msgEntry('user', 'invalid-inputs 第二轮用户消息（turn 2 边界）', 'u0002cc'),
    msgEntry('assistant', 'invalid-inputs 第二轮助手回复', 'a0002dd'),
  ])
  const unreadable = writeFixtureSession(dataDir, projectId, [
    headerEntry(crypto.randomUUID()),
    msgEntry('user', 'invalid-inputs 不可读载体第一轮', 'u9001aa'),
    msgEntry('assistant', 'invalid-inputs 不可读载体回复', 'a9001bb'),
    msgEntry('user', 'invalid-inputs 不可读载体第二轮', 'u9002cc'),
    msgEntry('assistant', 'invalid-inputs 不可读载体第二轮回复', 'a9002dd'),
  ])
  ev.step({
    step: 'fixture.build-isolated',
    channel: 'C',
    exitCode: 0,
    stats: { empty: empty.sid, zeroTurn: zeroTurn.sid, multi: multi.sid, unreadable: unreadable.sid },
  })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'invalid.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })

  try {
    // ── ① 空文件 ─────────────────────────────────────────────────
    const r1 = await timedHistory(proto, empty.sid, {})
    const m1 = r1.reply?.messages ?? []
    ev.step({ step: 'v8-1.empty-file', channel: 'B', exitCode: m1.length === 0 ? 0 : 1, stats: { messages: m1.length, truncated: r1.reply?.truncated ?? null, hasError: Boolean(r1.reply?.error) } })
    ev.assert('V8①: 空文件维持空页（不崩、无消息）', m1.length === 0 && !r1.reply?.error, {
      channel: 'B', expected: '空页无 error', actual: `messages=${m1.length} error=${r1.reply?.error ?? '无'}`,
    })

    // ── ② 零 turn 旧文件 ─────────────────────────────────────────
    const r2 = await timedHistory(proto, zeroTurn.sid, {})
    const m2 = r2.reply?.messages ?? []
    ev.step({ step: 'v8-2.zero-turn', channel: 'B', exitCode: !r2.reply?.error ? 0 : 1, stats: { messages: m2.length, truncated: r2.reply?.truncated ?? null, totalEstimate: r2.reply?.totalTurnsEstimate ?? null } })
    ev.assert('V8②: 零 turn 旧文件走兼容分支（不崩、无 user turn 消息）', !r2.reply?.error && m2.every((msg) => msg?.role !== 'user'), {
      channel: 'B', expected: '无 error、无 user 边界消息', actual: `messages=${m2.length} error=${r2.reply?.error ?? '无'}`,
    })

    // ── ③ 非边界 cursor（真实 assistant entryId） ─────────────────
    const r3base = await timedHistory(proto, multi.sid, {})
    const m3 = r3base.reply?.messages ?? []
    const assistantMsg = m3.find((msg) => msg?.role === 'assistant' && typeof msg?.piEntryId === 'string')
    ev.assert('V8③ 前置：多 turn 会话窗口含 assistant 消息（非边界 cursor 载体）', Boolean(assistantMsg), {
      channel: 'B', expected: 'assistant 消息 ≥1', actual: `窗口 ${m3.length} 条`,
    })
    if (assistantMsg) {
      const r3 = await timedHistory(proto, multi.sid, { cursor: assistantMsg.piEntryId })
      const m3p = r3.reply?.messages ?? []
      const leaked = m3p.some((msg) => msg?.piEntryId === assistantMsg.piEntryId)
      const hasTurn1 = JSON.stringify(m3p).includes('第一轮用户消息')
      ev.step({
        step: 'v8-3.non-boundary-cursor',
        channel: 'B',
        exitCode: !r3.reply?.error && !leaked && hasTurn1 ? 0 : 1,
        stats: { cursor: assistantMsg.piEntryId, messages: m3p.length, cursorLeaked: leaked, hasTurn1, truncated: r3.reply?.truncated ?? null },
      })
      ev.assert('V8③: 非边界 cursor 由兼容链定位（返回其前窗口、排除 cursor 自身）', !r3.reply?.error && !leaked && hasTurn1, {
        channel: 'B', expected: '含 turn 1、不含 cursor 自身', actual: `messages=${m3p.length} leaked=${leaked} hasTurn1=${hasTurn1}`,
      })
    }

    // ── ④ 未知 cursor ────────────────────────────────────────────
    const r4 = await timedHistory(proto, multi.sid, { cursor: 'zzzz9999' })
    const m4 = r4.reply?.messages ?? []
    ev.step({ step: 'v8-4.unknown-cursor', channel: 'B', exitCode: m4.length === 0 && r4.reply?.truncated === false ? 0 : 1, stats: { messages: m4.length, truncated: r4.reply?.truncated ?? null } })
    ev.assert('V8④: 未知 cursor 返回空页且 truncated=false', m4.length === 0 && r4.reply?.truncated === false, {
      channel: 'B', expected: '空页 + truncated=false', actual: `messages=${m4.length} truncated=${r4.reply?.truncated ?? 'null'}`,
    })

    // ── ⑤ 主文件不可读 → 恢复重试 ────────────────────────────────
    fs.chmodSync(unreadable.file, 0o000)
    const r5 = await timedHistory(proto, unreadable.sid, {})
    const m5 = r5.reply?.messages ?? []
    const failedLoudly = Boolean(r5.reply?.error) || (m5.length === 0 && r5.reply?.truncated !== false)
    ev.step({
      step: 'v8-5.unreadable',
      channel: 'B',
      exitCode: failedLoudly ? 0 : 1,
      stats: { messages: m5.length, error: r5.reply?.error ?? null, truncated: r5.reply?.truncated ?? null },
    })
    ev.assert('V8⑤: 主文件不可读显式失败（不伪装成空历史）', failedLoudly, {
      channel: 'B',
      expected: 'error 或非「truncated=false 空页」形态',
      actual: `messages=${m5.length} error=${r5.reply?.error ?? '无'} truncated=${r5.reply?.truncated ?? 'null'}`,
    })
    fs.chmodSync(unreadable.file, 0o644) // 恢复权限（界面现有重试入口的数据层等价 = 重发请求）
    const r5b = await timedHistory(proto, unreadable.sid, {})
    const m5b = r5b.reply?.messages ?? []
    const restored = m5b.length > 0 && !r5b.reply?.error && JSON.stringify(m5b).includes('不可读载体第一轮')
    ev.step({ step: 'v8-5.retry-after-restore', channel: 'B', exitCode: restored ? 0 : 1, stats: { messages: m5b.length, hasContent: restored } })
    ev.assert('V8⑤: 恢复权限后重试成功（历史完整）', restored, {
      channel: 'B', expected: '消息非空且含载体文本', actual: `messages=${m5b.length} hasContent=${restored}`,
    })
  } finally {
    await proto.close().catch(() => {})
  }

  log(`turn-index-invalid-inputs: 完成（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}
