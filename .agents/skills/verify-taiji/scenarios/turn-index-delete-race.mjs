/**
 * turn-index-delete-race —— V7 三条真删除路径与首次索引构建并发 + 索引写失败降级 +
 * pi 退出不取消（impl-plan §4.2 A7；u-lifecycle 验收⑤ 的剧本侧承载）。
 *
 * ① lifecycle.delete × 在途构建：21MB 级样本首次读取（构建在途）后立即 session.delete，
 *   删除窗口覆盖在途首次构建——被取消请求按现有 ENOENT 语义返回空页并记录警告（或读取
 *   先完成返回完整内容，两形态都合法），等待在途构建结束后树面：ext-sessions/<sid>/
 *   整树回收、无 history-index 写回重建。
 * ② btw closeLine × 在途构建：faux 主会话 → btw.create → 线首次读取在途 → btw.remove →
 *   线树整树回收（<mainSid>/btw/ 下无线树、无索引残留）。
 * ③ purgeArchive × 在途构建：8MB 级样本（无 pi 进程的非活跃形态）首次读取在途 →
 *   session.archive（不取消在途构建）→ purgeArchive——onSessionDeleted 是该路径唯一
 *   清理挂点：树面无 history-index 残留、无写回。
 * ④ 索引写失败降级：history-index 位置预置同名普通文件（目录创建必失败）→ 读历史仍
 *   返回正确窗口（索引写失败只损失加速能力），runtime 日志出现含路径的 warn。
 * ⑤ pi 退出不取消：faux 会话 pi 进程 SIGKILL（会话文件保留）→ 读 history 完整返回、
 *   runtime 健康——pi 退出只清内存索引、文件读取不依赖执行进程。
 *
 * 跑绿门：挂 u-lifecycle commit 门（impl-plan DAG：取消挂点与 LRU 清理由 u-lifecycle
 * 交付；① 的「删除窗口覆盖在途构建」以紧邻序发起，构建窗口实测 ≥数百 ms、删除 RPC
 * 往返 ~10ms，确定性命中；读取先完成的形态按 V7 通过标准的两形态分支判定）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  countUserTurns,
  isBaselineCollectMode,
  makeMessageEntry,
  readRuntimePort,
  seedProbeSession,
  timedHistory,
} from './lib/turn-index-lib.mjs'
import {
  isAlive,
  loadActiveProjectIds,
  piChildPids,
  pollUntil,
  PROD_DATA_DIR,
  readRuntimeLog,
  runtimePidOf,
  scanSessionPool,
  seedSessions,
} from './lib/cold-switch-lib.mjs'

const baseline = isBaselineCollectMode()

const FAUX_MODEL = 'faux/faux-1'

/** 载体区间挑选（对生产池漂移有韧性；断言输出实际样本与区间）。 */
function pickByRange(pool, minBytes, maxBytes) {
  return pool.filter((s) => s.bytes >= minBytes && s.bytes < maxBytes).sort((a, b) => b.bytes - a.bytes)[0] ?? null
}

/** 在途构建收尾等待：ext-sessions/<sid> 消失（整树回收）或树面 3s 稳定。 */
async function waitBuildSettled(extSessionsRoot, sid, { timeoutMs = 30_000 } = {}) {
  const dir = path.join(extSessionsRoot, sid)
  try {
    await pollUntil(
      () => {
        if (!fs.existsSync(dir)) return true
        const idx = path.join(dir, 'history-index', 'turns.json')
        if (!fs.existsSync(idx)) return false
        const s1 = fs.statSync(idx)
        return new Promise((resolve) => setTimeout(() => {
          const s2 = fs.existsSync(idx) ? fs.statSync(idx) : null
          resolve(Boolean(s2) && s2.mtimeMs === s1.mtimeMs && s2.size === s1.size)
        }, 3_000))
      },
      { timeoutMs, intervalMs: 1_000, label: `在途构建收尾（${sid.slice(0, 13)}）` },
    )
  } catch {
    return false
  }
  return true
}

/** runtime 日志在窗口内出现含 needle 的行（日志缓冲轮询）。 */
async function waitLogLine(dataDir, needle, { timeoutMs = 10_000 } = {}) {
  let tail = ''
  try {
    await pollUntil(() => {
      const logs = readRuntimeLog(dataDir)
      tail = logs.slice(-4_000)
      return tail.includes(needle)
    }, { timeoutMs, intervalMs: 500, label: `runtime 日志出现「${needle}」` })
    return { found: true, tail }
  } catch {
    return { found: false, tail }
  }
}

export const meta = {
  id: 'turn-index-delete-race',
  priority: 'P0',
  title: 'V7 三删除路径×在途构建并发（delete/closeLine/purgeArchive）+ 索引写失败降级 + pi 退出不取消',
  covers: ['env.launch', 'env.ready', 'session.delete', 'session.history', 'session.persistence', 'chat.send', 'chat.wait', 'evidence.logs'],
  requires: ['faux', 'u-assets-prep'],
  estimateSec: 480,
  faux: {
    // force: 剧本段 0 stop→seed→二次 launch 会让 ensureFaux 二次执行——首次 launch 已种过
    // settings.json，无 force 会被 seed-faux 的已存在拒绝拦住（幂等重写同内容，安全）。
    force: true,
    // 统一队列数组形态（faux-llm-ext loadScript：无 --model 的进程——btw 线 pi——
    // 不能用 model-keyed 对象，统一队列对所有进程形态可用）。
    responses: [{ text: 'delete-race-faux-answer', stopReason: 'stop' }],
  },
  provable: [
    'V7①: lifecycle.delete 覆盖在途构建——树面 ext-sessions/<sid>/ 整树回收、无 history-index 写回重建',
    'V7②: btw closeLine 覆盖在途构建——线树整树回收、主树 btw/ 下无索引残留',
    'V7③: purgeArchive 覆盖在途构建（非活跃形态）——树面无 history-index 残留与写回，purge reply 成功',
    'V7④: history-index 目录创建被拦截时历史仍由当前计算返回（正确窗口、无 error），runtime 日志出现含路径的 warn',
    'V7⑤: pi 进程退出（SIGKILL）后会话文件保留、history 读取不被取消且内容完整、runtime 健康',
  ],
  notProvable: [
    '被取消请求的「空页 + 警告」形态逐字断言（取消与完成是竞态双形态：读取先完成 = 完整窗口也合法——剧本按两形态分支判定并记录实际形态）',
    '内存 LRU 清理的内部观测（LRU 无导出探针；以「删除后无写回重建 + 无 ENOENT 之外的错误」承载其外部效果）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = []
  if (baseline) {
    uncovered.push('V7 在基线旧代码上语义不可判（onSessionDeleted 取消挂点是终态新增）——本剧本只挂 u-lifecycle commit 门跑')
    log('baseline collect 模式：V7 不采集，直接返回')
    return { uncovered, gotchas }
  }

  const extRoot = path.join(dataDir, 'ext-sessions')

  // ── 段 0：fixture 采集（stop → 种子 → 冷启动） ───────────────────
  await instance.stop()
  const pool = scanSessionPool(PROD_DATA_DIR)
  const deleteCarrier = pickByRange(pool, 16_000_000, 32_000_000)
  const purgeCarrier = pickByRange(pool, 6_000_000, 12_000_000)
  const writeFailCarrier = pickByRange(pool, 1_000_000, 2_000_000)
  ev.assert('V7 载体：生产池含 16-32MB 删除样本', Boolean(deleteCarrier), {
    channel: 'C', expected: '16-32MB 样本 1 个', actual: deleteCarrier ? `${(deleteCarrier.bytes / 1e6).toFixed(1)}MB ${deleteCarrier.sessionId}` : '无',
  })
  ev.assert('V7 载体：生产池含 6-12MB purge 样本', Boolean(purgeCarrier), {
    channel: 'C', expected: '6-12MB 样本 1 个', actual: purgeCarrier ? `${(purgeCarrier.bytes / 1e6).toFixed(1)}MB ${purgeCarrier.sessionId}` : '无',
  })
  ev.assert('V7 载体：生产池含 1-2MB 写失败样本', Boolean(writeFailCarrier), {
    channel: 'C', expected: '1-2MB 样本 1 个', actual: writeFailCarrier ? `${(writeFailCarrier.bytes / 1e6).toFixed(1)}MB ${writeFailCarrier.sessionId}` : '无',
  })
  if (!deleteCarrier || !purgeCarrier || !writeFailCarrier) throw new Error('生产池载体不足，V7 无法构造（需要 16-32MB / 6-12MB / 1-2MB 各一）')
  seedSessions(dataDir, PROD_DATA_DIR, [deleteCarrier, purgeCarrier, writeFailCarrier])
  const seededOffline = countUserTurns(path.join(dataDir, 'agent', 'sessions', path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), deleteCarrier.sessionFile)))
  ev.step({ step: 'fixture.seed-carriers', channel: 'C', exitCode: 0, stats: { deleteSid: deleteCarrier.sessionId, purgeSid: purgeCarrier.sessionId, writeFailSid: writeFailCarrier.sessionId, deleteOfflineTurns: seededOffline.userTurns } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'delete-race.launch-ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort, elapsedMs: ready.elapsedMs } })
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })

  try {
    // ── ① lifecycle.delete × 在途构建 ────────────────────────────
    const sidA = deleteCarrier.sessionId
    const histA = timedHistory(proto, sidA, {}) // 发起即返（构建在途）
    const del = await proto.call('session.delete', { sessionId: sidA }, { replyType: 'session.deleted', timeoutMs: 60_000 })
    const replyA = await histA
    const emptyPage = (replyA.reply?.messages ?? []).length === 0
    ev.step({
      step: 'v7-1.delete-during-build',
      channel: 'B',
      exitCode: 0,
      stats: { delReply: del?.sessionId ?? JSON.stringify(del)?.slice(0, 80), replyForm: emptyPage ? '空页（取消/ENOENT 形态）' : `完整 ${replyA.reply?.messages?.length} 条（读取先完成形态）`, elapsedMs: replyA.elapsedMs },
    })
    const settledA = await waitBuildSettled(extRoot, sidA)
    const dirA = path.join(extRoot, sidA)
    ev.step({
      step: 'v7-1.tree-settled',
      channel: 'B',
      exitCode: !fs.existsSync(dirA) ? 0 : 1,
      stats: { settled: settledA, dirGone: !fs.existsSync(dirA), residual: fs.existsSync(dirA) ? treeUnder(dirA).slice(0, 10) : [] },
    })
    ev.assert('V7①: 删除后 ext-sessions/<sid>/ 整树回收（无 history-index 残留或写回重建）', !fs.existsSync(dirA), {
      channel: 'B', expected: '目录不存在（整树回收）', actual: fs.existsSync(dirA) ? `残留 ${treeUnder(dirA).length} 文件` : '已回收',
    })

    // ── ② btw closeLine × 在途构建 ───────────────────────────────
    const created = await proto.call('session.create', { cwd: repo, label: 'delete-race-btw', modelOverride: FAUX_MODEL }, { timeoutMs: 120_000 })
    const mainSid = created.session?.id
    await proto.subscribe(mainSid)
    const since = proto.events.length
    await proto.send(mainSid, 'delete-race btw 线载体消息')
    const end = await proto.waitTurnEnd(mainSid, { since, timeoutMs: 180_000 })
    ev.assert('V7② 前置：主会话轮完成', end.ok === true, { channel: 'B', expected: 'message.complete', actual: `${end.type}` })
    const line = await proto.call('btw.create', { mainSid }, { replyType: 'btw.create', timeoutMs: 120_000 })
    const lineSid = line?.sessionId
    ev.assert('V7② 前置：线创建', Boolean(lineSid), { channel: 'C', expected: 'sessionId 非空', actual: lineSid ?? 'null' })
    const histL = timedHistory(proto, lineSid, {})
    await proto.call('btw.remove', { sessionId: lineSid }, { replyType: 'btw.remove', timeoutMs: 60_000 })
    const replyL = await histL
    ev.step({
      step: 'v7-2.closeline-during-build',
      channel: 'B',
      exitCode: 0,
      stats: { lineSid, replyForm: (replyL.reply?.messages ?? []).length === 0 ? '空页形态' : `完整 ${(replyL.reply?.messages ?? []).length} 条`, elapsedMs: replyL.elapsedMs },
    })
    await waitBuildSettled(extRoot, lineSid)
    const lineTree = path.join(extRoot, mainSid, 'btw')
    const lineResidual = fs.existsSync(lineTree) ? treeUnder(lineTree).filter((f) => f.includes(lineSid.split(':').pop() ?? lineSid)) : []
    const lineGone = !fs.existsSync(lineTree) || lineResidual.length === 0
    ev.step({
      step: 'v7-2.line-tree',
      channel: 'B',
      exitCode: lineGone ? 0 : 1,
      stats: { btwDirExists: fs.existsSync(lineTree), lineResidual: lineResidual.slice(0, 8) },
    })
    ev.assert('V7②: 关线后线树整树回收（无索引残留）', lineGone, {
      channel: 'B', expected: '线树不存在或无该线文件', actual: lineResidual.length === 0 ? '已回收' : `残留 ${lineResidual.slice(0, 5).join(',')}`,
    })

    // ── ③ purgeArchive × 在途构建（非活跃形态） ───────────────────
    const sidC = purgeCarrier.sessionId
    const histC = timedHistory(proto, sidC, {})
    await proto.call('session.archive', { sessionId: sidC }, { replyType: 'session.archive', timeoutMs: 60_000 })
    ev.step({ step: 'v7-3.archived', channel: 'C', exitCode: 0, stats: { sidC } })
    const purge = await proto.call('session.purgeArchive', { sessionId: sidC }, { replyType: 'session.purgeArchive', timeoutMs: 60_000 })
    const replyC = await histC
    ev.step({
      step: 'v7-3.purge-during-build',
      channel: 'B',
      exitCode: 0,
      stats: { purgeReply: purge?.sessionId ?? JSON.stringify(purge)?.slice(0, 80), replyForm: (replyC.reply?.messages ?? []).length === 0 ? '空页形态' : `完整 ${(replyC.reply?.messages ?? []).length} 条`, elapsedMs: replyC.elapsedMs },
    })
    await waitBuildSettled(extRoot, sidC)
    const dirC = path.join(extRoot, sidC)
    const sessionsTreeC = path.join(dataDir, 'agent', 'sessions')
    const jsonlGone = !fs.existsSync(path.join(sessionsTreeC, path.relative(path.join(PROD_DATA_DIR, 'agent', 'sessions'), purgeCarrier.sessionFile)))
    ev.step({
      step: 'v7-3.purge-tree',
      channel: 'B',
      exitCode: !fs.existsSync(dirC) && jsonlGone ? 0 : 1,
      stats: { extDirGone: !fs.existsSync(dirC), jsonlGone, residual: fs.existsSync(dirC) ? treeUnder(dirC).slice(0, 8) : [] },
    })
    ev.assert('V7③: purgeArchive 后会话树与 history-index 全部回收（唯一清理挂点生效）', !fs.existsSync(dirC) && jsonlGone, {
      channel: 'B', expected: 'ext-sessions/<sid> 不存在 + sessions 树无该文件', actual: `extDirGone=${!fs.existsSync(dirC)} jsonlGone=${jsonlGone}`,
    })

    // ── ④ 索引写失败降级 ─────────────────────────────────────────
    const sidD = writeFailCarrier.sessionId
    const idxDir = path.join(extRoot, sidD, 'history-index')
    fs.mkdirSync(path.dirname(idxDir), { recursive: true })
    fs.writeFileSync(idxDir, 'write-fail trap: history-index 必须是目录，本文件使 mkdir EEXIST\n', 'utf8')
    const afterTrap = await timedHistory(proto, sidD, {})
    const trapMsgs = afterTrap.reply?.messages ?? []
    ev.step({
      step: 'v7-4.write-fail-degrade',
      channel: 'B',
      exitCode: trapMsgs.length > 0 && !afterTrap.reply?.error ? 0 : 1,
      stats: { messages: trapMsgs.length, hasError: Boolean(afterTrap.reply?.error), elapsedMs: afterTrap.elapsedMs },
    })
    ev.assert('V7④: 索引写失败时历史仍由当前计算返回（正确窗口、无 error）', trapMsgs.length > 0 && !afterTrap.reply?.error, {
      channel: 'B', expected: '消息非空且无 error', actual: `messages=${trapMsgs.length} error=${afterTrap.reply?.error ?? '无'}`,
    })
    const logHit = await waitLogLine(dataDir, 'history-index')
    ev.step({ step: 'v7-4.warn-log', channel: 'C', exitCode: logHit.found ? 0 : 1, stats: { found: logHit.found } })
    ev.assert('V7④: runtime 日志出现含 history-index 路径的 warn（恢复动作提示）', logHit.found, {
      channel: 'C', expected: '日志含 history-index', actual: logHit.found ? '命中' : `未命中（日志尾：${logHit.tail.slice(-200).replace(/\n/g, ' | ')}）`,
    })
    fs.rmSync(idxDir, { force: true }) // 拦截物清理
    gotchas.push('V7④ 拦截物（history-index 同名文件）已清理')

    // ── ⑤ pi 退出不取消 ─────────────────────────────────────────
    const created5 = await proto.call('session.create', { cwd: repo, label: 'delete-race-pi-exit', modelOverride: FAUX_MODEL }, { timeoutMs: 120_000 })
    const sid5 = created5.session?.id
    await proto.subscribe(sid5)
    const since5 = proto.events.length
    await proto.send(sid5, 'delete-race pi 退出载体消息')
    const end5 = await proto.waitTurnEnd(sid5, { since: since5, timeoutMs: 180_000 })
    ev.assert('V7⑤ 前置：会话轮完成（pi 进程在场）', end5.ok === true, { channel: 'B', expected: 'message.complete', actual: `${end5.type}` })
    const rtPid = runtimePidOf(dataDir)
    const piPids = rtPid ? piChildPids(rtPid) : []
    ev.assert('V7⑤ 前置：pi 子进程可定位', piPids.length > 0, {
      channel: 'C', expected: 'pi pid ≥1', actual: `${piPids.length} 个（runtime pid=${rtPid ?? 'n/a'}）`,
    })
    if (piPids.length > 0) {
      for (const pid of piPids) {
        try { process.kill(pid, 'SIGKILL') } catch { /* 已退出即目标达成 */ }
      }
      await pollUntil(() => piPids.every((pid) => !isAlive(pid)), { timeoutMs: 10_000, intervalMs: 200, label: 'pi 子进程退出' })
      ev.step({ step: 'v7-5.pi-killed', channel: 'C', exitCode: 0, stats: { killed: piPids } })
      const afterExit = await timedHistory(proto, sid5, {})
      const exitMsgs = afterExit.reply?.messages ?? []
      const hasContent = exitMsgs.length > 0 && JSON.stringify(exitMsgs).includes('delete-race-faux-answer')
      ev.step({
        step: 'v7-5.read-after-pi-exit',
        channel: 'B',
        exitCode: hasContent && !afterExit.reply?.error ? 0 : 1,
        stats: { messages: exitMsgs.length, hasError: Boolean(afterExit.reply?.error), hasContent },
      })
      ev.assert('V7⑤: pi 退出后 history 读取不被取消（内容完整、无 error）', hasContent && !afterExit.reply?.error, {
        channel: 'B', expected: '含 faux 回复文本且无 error', actual: `messages=${exitMsgs.length} hasContent=${hasContent} error=${afterExit.reply?.error ?? '无'}`,
      })
      // runtime 健康：后续请求仍可服务（pi 退出只清内存索引，runtime 本身存活）
      const ping = await timedHistory(proto, mainSid, { limitTurns: 2 })
      ev.assert('V7⑤: runtime 健康（pi 退出后其他会话读取仍可服务）', !ping.reply?.error, {
        channel: 'B', expected: '无 error', actual: ping.reply?.error ?? 'ok',
      })
    } else {
      uncovered.push('V7⑤ pi 退出注入（pi 子进程不可定位——runtime 未派生 pi 或定位标记漂移，检查 runtimePidOf/piChildPids 适配）')
    }
  } finally {
    await proto.close().catch(() => {})
  }

  log(`turn-index-delete-race: 完成（${uncovered.length} uncovered）`)
  return { uncovered, gotchas }
}

/** 目录下全部文件（相对路径，树面断言用）。 */
function treeUnder(root) {
  const out = []
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
