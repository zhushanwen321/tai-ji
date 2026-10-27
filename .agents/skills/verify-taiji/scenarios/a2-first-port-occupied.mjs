/**
 * a2-first-port-occupied —— 验收场景 2（设计 §8）：首端口被占直达正确端口。
 *
 * 回溯目标 1。机制（源码核对）：findAvailablePort 从实例端口段首起跳，占用者一律
 * 跳过不清杀（port-discoverer.ts:235），mainLogger 记 `[port-cleanup] port X occupied
 * by non-owned process, skipping`；旧「备用端口猜连」链已删（§6.2）——被占时不重试
 * 段首，直接落在段内下一槽位，renderer 经快照直达该端口。
 *
 * 通过标准（设计 §8 场景 2）：
 *   supervisor 选段内下一端口、连接直达、分组正确；无对段首端口的重试日志。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  PROD_DATA_DIR,
  asyncRuntimePortRange,
  authEcho,
  occupyPort,
  pollUntil,
  portOwners,
  readJsonFile,
  readLaunchLog,
  readMainLog,
  readRendererConsole,
  readRuntimePort,
  seedRealisticDataDir,
  waitForSidebarGroups,
} from './lib-conn-datasync.mjs'

export const meta = {
  id: 'a2-first-port-occupied',
  priority: 'P0',
  title: '场景 2：首端口被占直达正确端口（段内跳过 + 无重试）',
  covers: ['env.launch', 'env.ready', 'env.isolation'],
  requires: ['none'],
  estimateSec: 240,
  provable: [
    '段首端口被无关进程占用时，runtime 落在段内下一槽位（Starting/Ready on port 日志 + runtime.port 实证）',
    'renderer 连接直达该端口（分组正确呈现，无重连 churn：renderer-console 无退避重连告警）',
    '无对段首端口的重试日志（[port-cleanup] skip 一行 + 无二次 Starting on 段首）',
  ],
  notProvable: [
    '打包版 offset=0 段（3210 起）：dev 实例段按 worktree/实例名 hash 派生，剧本按派生段验证同机制',
    '占用者恰好是本实例残留 runtime 的形态（reclaimOwnStaleRuntime 身份门收割路径，由 apps/electron 单测覆盖）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = []

  // ── 段 0：种子真实数据（与场景 1 同口径） + 记录空载基线端口 ──────
  await instance.stop()
  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR })
  const seeded = readJsonFile(path.join(dataDir, 'projects.json'))
  const expectedNames = seeded.projects.filter((p) => p.id !== 'proj-default' && p.name).map((p) => p.name).sort()
  ev.step({ step: 'seed.realistic-data', channel: 'C', exitCode: 0, stats: { boundSessions: seed.sessions.length } })

  // 基线轮（无占用）：确认段首端口可用时 runtime 就落在段首
  await instance.launch()
  const baseReady = await instance.waitReady({ timeoutMs: 180_000 })
  const range = await asyncRuntimePortRange(repo, instance.info().instanceName)
  const basePort = baseReady.runtimePort
  ev.assert('基线：无占用时 runtime 落在端口段首', basePort === range.start, {
    channel: 'C',
    expected: range.start,
    actual: basePort,
  })
  ev.attach('port-range', JSON.stringify({ ...range, instanceName: instance.info().instanceName, basePort }, null, 2))
  await instance.stop()

  // ── 段 1：无关进程预占段首端口 → 冷启动 ─────────────────────────
  // 停实例后清除上一轮 runtime 的端口登记残留（runtime.port / runtime-instance.json）：
  // 单实例守卫按这两个文件的端口探活（single-instance-guard.ts collectCandidates），
  // 残留端口 = 段首 = 预占目标时，守卫会把无关占用进程误判为「同数据目录活 runtime」
  // 而拒绝启动。清除后即真实冷启动形态（无在途 runtime 登记）。
  for (const f of ['runtime.port', 'runtime-instance.json']) {
    try {
      fs.rmSync(path.join(dataDir, f), { force: true })
    } catch {
      /* 不存在即无需清除 */
    }
  }
  const occupier = occupyPort(range.start)
  const occupied = await pollUntil(async () => portOwners(range.start).includes(occupier.pid), { timeoutMs: 10_000, label: '预占端口生效' })
  ev.step({ step: 'port.occupied', channel: 'C', exitCode: 0, stats: { port: range.start, occupierPid: occupier.pid, owners: occupied } })

  try {
    const launchLogLenBefore = readLaunchLog(dataDir).length
    await instance.launch()
    // 真就绪判据（防 stale 三元组蒙混：旧 runtime.port 值 + 占用者 TCP accept + 旧扩展日志）：
    // ① launch log 出现本次 Starting on port P；② runtime.port 文件刷新为 P；
    // ③ authEcho 在 P 上完成真 WS 握手（占用者只 accept 不握手，天然判别器）。
    const readyInfo = await pollUntil(
      async () => {
        const tail = readLaunchLog(dataDir).slice(launchLogLenBefore)
        const m = tail.match(/\[runtime\] Starting on port (\d+)/)
        if (!m) return null
        const port = Number(m[1])
        if (readRuntimePort(dataDir) !== port) return null
        try {
          const echo = await authEcho(dataDir, port, { timeoutMs: 5_000 })
          return { port, runtimeId: echo.runtimeId }
        } catch {
          return null
        }
      },
      { timeoutMs: 180_000, intervalMs: 500, label: '新 runtime 真就绪（Starting + 端口文件 + 真握手）' },
    )
    ev.step({ step: 'instance.ready', channel: 'C', exitCode: 0, stats: { runtimePort: readyInfo.port, runtimeId: readyInfo.runtimeId } })

    // ① 落在段内下一槽位
    ev.assert('A2①: 段首被占 → runtime 落在段内下一槽位', readyInfo.port === range.start + 1, {
      channel: 'C',
      expected: range.start + 1,
      actual: readyInfo.port,
    })

    // ② 连接直达：分组正确 + renderer 无重连 churn
    const page = await instance.page()
    const groups = await waitForSidebarGroups(page, { minGroups: expectedNames.length, timeoutMs: 60_000 })
    const names = groups.map((g) => g.name).sort()
    ev.assert('A2②: 连接直达新端口（侧栏分组正确呈现）', JSON.stringify(names) === JSON.stringify(expectedNames), {
      channel: 'A',
      expected: expectedNames.join(','),
      actual: names.join(','),
    })
    const rendererConsole = readRendererConsole(dataDir)
    const reconnectWarns = rendererConsole.split('\n').filter((l) => /reconnect|退避|backoff/i.test(l))
    ev.assert('A2②: renderer 无重连 churn（无退避重连告警）', reconnectWarns.length === 0, {
      channel: 'C',
      expected: '0 行',
      actual: reconnectWarns.slice(0, 3).join(' | ') || '0 行',
    })

    // ③ 无对段首端口的重试日志
    const launchLog = readLaunchLog(dataDir)
    const mainLog = readMainLog(dataDir)
    const newLaunchLines = launchLog.slice(launchLogLenBefore).split('\n')
    const startingLines = newLaunchLines.filter((l) => /\[runtime\] Starting on port/.test(l))
    ev.assert('A2③: 本轮仅一次 spawn，直接 Starting on 段内下一槽位', startingLines.length === 1 && startingLines[0].includes(`port ${range.start + 1}`), {
      channel: 'C',
      expected: `1 行且含 port ${range.start + 1}`,
      actual: startingLines.join(' | ') || '(无)',
    })
    const startingOnOccupied = newLaunchLines.filter((l) => /\[runtime\] Starting on port/.test(l) && l.includes(`port ${range.start} `))
    ev.assert('A2③: 无对段首端口的重试 spawn', startingOnOccupied.length === 0, {
      channel: 'C',
      expected: '0 行',
      actual: startingOnOccupied.join(' | ') || '0 行',
    })
    const skipLines = mainLog.split('\n').filter((l) => l.includes(`port ${range.start} occupied by non-owned process, skipping`))
    ev.assert('A2③: mainLogger 记段首占用跳过（identity gate）', skipLines.length >= 1, {
      channel: 'C',
      expected: `≥1 行 port ${range.start} … skipping`,
      actual: `${skipLines.length} 行`,
    })
    if (skipLines.length > 0) ev.attach('port-cleanup-skip', skipLines.slice(-2).join('\n'))
    await ev.shot(page, 'a2-groups')
    log(`a2: runtime on ${readyInfo.port}（段 ${range.start}-${range.end}，段首被占 ${range.start}）`)
  } finally {
    occupier.release()
    ev.step({ step: 'port.occupier-released', channel: 'C', exitCode: 0, stats: { port: range.start, pid: occupier.pid } })
  }

  if (uncovered.length === 0) log('a2: 全部断言通过')
  return { uncovered, gotchas }
}
