/**
 * startup-a2a6 —— 启动设计验收场景 A2 + A6（u-foundation 波次段，F4/A2+A6 合并组：
 * 共享 kill -9 装配）。
 *
 * A2（设计 §4.1 场景 2，未迁移形态 = M1 时点全部现存会话形态）：kill -9 runtime →
 * supervisor 自动重启 → Restart succeeded 后 2 秒内纯读 RPC（file.tree /
 * file.search / git.status）正常返回、无「Session 不存在或无 cwd」（错误形态 =
 * error envelope code=session_not_found → RPC reject）；恢复后 UI 面板正常。
 * 机制（源码核对）：纯读走 resolveSessionContext 两级解析（内存活跃表 → 磁盘元数据
 * 带缓存，file-service.ts D5）——重启窗口内活跃表空，第二级磁盘扫描承载。
 *
 * A6（场景 6，过渡期形态）：面板正显示大会话时 kill -9 runtime → 重启后开同一会话
 * → 旧派生视图经查询路径全量重扫自愈（重启后投影内存态清零，首次查询
 * rebuildProjection → attach 全量冷读；日志证据 = [session-records] record frames
 * published trigger=getSubagents）。
 *
 * 「面板刷新中 kill」的口径（gotcha）：投影冷读实测 3.1ms（91 文件），刷新窗口
 * 亚毫秒级不可捕捉——按「面板正显示该会话（投影活跃、UI 已渲染）时 kill」宽口径
 * 装配，自愈判据不依赖 kill 时点落在刷新窗口内。
 */
import path from 'node:path'

import { createProtocol } from '../scripts/lib/protocol.mjs'
import {
  pollUntil,
  readLaunchLog,
  readRuntimePort,
  readRuntimeLog,
  runtimePidOf,
  signalPid,
} from './lib-conn-datasync.mjs'
import { seedProjects, seedRecordSession } from './lib/startup-records-fixture.mjs'

const RECORD_IDLE = 50
const RECORD_RUNNING = 5
const RECORD_TOTAL = RECORD_IDLE + RECORD_RUNNING

export const meta = {
  id: 'startup-a2a6-recovery',
  priority: 'P0',
  title: '启动设计 A2+A6：kill -9 恢复期纯读（未迁移形态）+ 崩溃后查询路径重扫自愈',
  covers: ['env.launch', 'env.ready', 'session.persistence', 'workspace.filetree', 'workspace.drawer'],
  requires: ['none'],
  estimateSec: 480,
  provable: [
    'A2: Restart succeeded 后 2000ms 内 file.tree / file.search / git.status 三纯读 RPC 正常返回（无 session_not_found error envelope）',
    'A2: 恢复后 UI 会话列表回来、右抽屉 git 面板正常渲染（无错误态）',
    'A6: kill 前面板 55 条 records（50 idle + 5 running）；重启后同一会话查询全量回来（55 条，50 idle + 5 running）',
    'A6: 重启后投影重扫的日志证据（[session-records] record frames published trigger=getSubagents）',
  ],
  notProvable: [
    'A2「文件搜索」的 composer $ 候选浮层 UI 入口未驱动（由 B 通道 file.search RPC + 抽屉 git 面板 A 通道共同承载「文件搜索与 git 面板正常返回」）',
    'A6「面板刷新中」的亚毫秒冷读窗口（3.1ms/91 文件实测）不可确定性捕捉，按面板正显示会话的宽口径装配',
    'kill decision 语义（SIGKILL 直杀不经 watchdog 决策链，A3 段的「无 kill decision」断言归 startup-a3a4 剧本）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const gotchas = [
    'A6「面板刷新中 kill」按宽口径装配：投影冷读 3.1ms 亚毫秒窗口不可捕捉，kill 时面板正显示该会话（投影活跃）',
    'A2 的 2s 窗口起点 = 装配日志 Restart succeeded 命中时刻（renderer 视角 connected 的协议侧等价物）',
  ]
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')
  const SID = 'sess-startup-a2a6-fixture'
  const PROJECT_ID = 'proj-startup-acc'

  // ── 段 0：停实例种子 fixture（受控未迁移形态会话 + 55 record 事件文件）──────
  await instance.stop()
  seedProjects(dataDir, [{ id: PROJECT_ID, name: 'StartupAcc' }])
  const records = []
  for (let i = 1; i <= RECORD_IDLE; i += 1) {
    records.push({ id: `sa-idle-${String(i).padStart(2, '0')}`, status: 'idle' })
  }
  for (let i = 1; i <= RECORD_RUNNING; i += 1) {
    records.push({ id: `sa-run-${String(i).padStart(2, '0')}`, status: 'running' })
  }
  const seeded = seedRecordSession(dataDir, { sessionId: SID, cwd, projectId: PROJECT_ID, records })
  ev.step({ step: 'seed.fixture-session', channel: 'C', exitCode: 0, stats: { sessionId: SID, recordFiles: records.length, recordsDir: seeded.recordsDir } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  const page = await instance.page()
  const proto = await instance.protocol()
  ev.step({ step: 'baseline.ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort } })

  // ── 段 1：基线（kill 前）——会话可见 + 首读全量 + 面板内容 ─────────────────
  const listed = await proto.call('config.sessions', {})
  ev.assert('B: fixture 会话在 config.sessions 列表', JSON.stringify(listed).includes(SID), {
    channel: 'B',
    expected: `含 ${SID}`,
    actual: JSON.stringify(listed).slice(0, 300),
  })
  const baseSubs = await proto.call('session.getSubagents', { sessionId: SID })
  const baseIdle = baseSubs.subagents?.filter((s) => s.status === 'idle').length ?? 0
  const baseRunning = baseSubs.subagents?.filter((s) => s.status === 'running').length ?? 0
  ev.assert(`A6 基线: kill 前查询返回 ${RECORD_TOTAL} 条 records（${RECORD_IDLE} idle + ${RECORD_RUNNING} running）`, baseSubs.subagents?.length === RECORD_TOTAL && baseIdle === RECORD_IDLE && baseRunning === RECORD_RUNNING, {
    channel: 'B',
    expected: `${RECORD_TOTAL} 条（idle=${RECORD_IDLE} running=${RECORD_RUNNING}）`,
    actual: `total=${baseSubs.subagents?.length ?? 0} idle=${baseIdle} running=${baseRunning}`,
  })

  // UI 激活：会话行出现 → 点击 → 抽屉 subagent 面板可打开（面板宿主口径见 A5 剧本
  // gotcha：托盘 subagent widget 只推送活跃 pi 会话进程内创建的 records，冷 fixture
  // 会话的列表观测以右抽屉 subagent tab 承载）
  await pollUntil(
    async () => {
      const count = await page.locator('.session-item').count()
      return count > 0 ? count : null
    },
    { timeoutMs: 60_000, intervalMs: 400, label: '侧栏 fixture 会话行渲染' },
  )
  await page.locator('.session-item').first().click()
  const drawerToggle = page.locator('[data-testid="drawer-toggle"]')
  await drawerToggle.waitFor({ state: 'visible', timeout: 30_000 })
  await drawerToggle.click()
  const drawerPanel = page.locator('[data-testid="drawer-panel"]')
  await drawerPanel.waitFor({ state: 'visible', timeout: 10_000 })
  const subagentTabVisible = await page.locator('[data-testid="drawer-tab-subagent"]').first().isVisible().catch(() => false)
  ev.assert('A6 基线: kill 前会话已激活、抽屉 subagent 面板 tab 在场（面板正显示该会话）', subagentTabVisible, {
    channel: 'A',
    expected: 'drawer-tab-subagent 可见',
    actual: subagentTabVisible ? '可见' : '不可见',
  })
  await ev.shot(page, 'a2a6-baseline-panel')
  const logMarkBeforeKill = readRuntimeLog(dataDir).length

  // ── 段 2：kill -9 runtime → 等自动重启 ─────────────────────────────────
  const pidBefore = runtimePidOf(dataDir)
  if (pidBefore === null) throw new Error('runtime PID 定位失败（runtime.port / lsof）')
  const launchLenBefore = readLaunchLog(dataDir).length
  signalPid(pidBefore, 'SIGKILL')
  ev.step({ step: 'kill.runtime', channel: 'C', exitCode: 0, stats: { pid: pidBefore, signal: 'SIGKILL' } })
  log(`SIGKILL runtime pid=${pidBefore}，等 supervisor 自动重启`)

  await pollUntil(
    async () => {
      const tail = readLaunchLog(dataDir).slice(launchLenBefore)
      return /Restart succeeded on port \d+/.test(tail) ? tail : null
    },
    { timeoutMs: 120_000, intervalMs: 300, label: 'runtime 自动重启（Restart succeeded）' },
  )
  const tRestart = Date.now()
  ev.step({ step: 'restart.succeeded', channel: 'C', exitCode: 0, stats: { atMs: tRestart } })

  // ── 段 3：A2——Restart succeeded 后 2s 内纯读 RPC 全部正常返回 ────────────
  try {
    const freshProto = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
    try {
      const tree = await freshProto.call('file.tree', { sessionId: SID })
      const search = await freshProto.call('file.search', { sessionId: SID })
      const gitStatus = await freshProto.call('git.status', { sessionId: SID })
      const elapsed = Date.now() - tRestart
      const readmeHit = (search.files ?? []).some((f) => String(f.path ?? '').includes('README'))
      const a2Ok = (tree.tree?.length ?? 0) > 0 && (search.files?.length ?? 0) > 0 && Array.isArray(gitStatus.files) && readmeHit
      const a2Detail = `elapsed=${elapsed}ms tree=${tree.tree?.length ?? 0} search=${search.files?.length ?? 0} gitFiles=${gitStatus.files?.length} readmeHit=${readmeHit}`
      ev.assert(`A2: Restart succeeded 后 2000ms 内纯读 RPC 正常返回（tree>0 / search 含 README / git.files 数组）`, a2Ok && elapsed <= 2000, {
        channel: 'B',
        expected: '三 RPC 成功且 elapsed ≤ 2000ms',
        actual: a2Detail,
      })
      ev.attach('a2-recovery-rpc', `tRestart→完成 ${a2Detail}\ntree 顶层: ${JSON.stringify((tree.tree ?? []).slice(0, 5))}\ngitStatus keys: ${Object.keys(gitStatus).join(',')}`)
    } finally {
      await freshProto.close().catch(() => {})
    }
  } catch (e) {
    ev.assert('A2: Restart succeeded 后 2000ms 内纯读 RPC 正常返回', false, {
      channel: 'B',
      expected: '三 RPC 成功',
      actual: `RPC 失败: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  // ── 段 4：UI 恢复——会话列表回来 + git 面板正常 ──────────────────────────
  await instance.waitReady({ timeoutMs: 120_000 })
  await pollUntil(
    async () => {
      const count = await page.locator('.session-item').count()
      return count > 0 ? count : null
    },
    { timeoutMs: 60_000, intervalMs: 500, label: '重启后侧栏会话行恢复' },
  )
  await page.locator('.session-item').first().click()
  await drawerToggle.waitFor({ state: 'visible', timeout: 30_000 })
  await drawerToggle.click()
  await page.locator('[data-testid="drawer-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
  const gitTabVisible = await page.locator('[data-testid="drawer-tab-git"]').first().isVisible().catch(() => false)
  ev.assert('A2: 恢复后右抽屉 git 面板正常渲染（drawer-panel 可见 + git tab 在场）', gitTabVisible, {
    channel: 'A',
    expected: 'drawer-tab-git 可见',
    actual: gitTabVisible ? '可见' : '不可见',
  })
  const fileErrorCount = await page.locator('[data-testid="file-error"]').count().catch(() => 0)
  ev.assert('A2: 恢复后无文件域错误态（file-error 零出现）', fileErrorCount === 0, {
    channel: 'A',
    expected: '0',
    actual: String(fileErrorCount),
  })
  await ev.shot(page, 'a2a6-recovered-git-panel')

  // ── 段 5：A6——重启后同一会话查询路径全量重扫自愈 ────────────────────────
  const protoAfter = await createProtocol({ dataDir, runtimePort: readRuntimePort(dataDir) })
  try {
    const afterSubs = await protoAfter.call('session.getSubagents', { sessionId: SID })
    const afterIdle = afterSubs.subagents?.filter((s) => s.status === 'idle').length ?? 0
    const afterRunning = afterSubs.subagents?.filter((s) => s.status === 'running').length ?? 0
    ev.assert(`A6: 重启后同一会话查询全量回来（${RECORD_TOTAL} 条 = ${RECORD_IDLE} idle + ${RECORD_RUNNING} running，与 kill 前一致）`, afterSubs.subagents?.length === RECORD_TOTAL && afterIdle === RECORD_IDLE && afterRunning === RECORD_RUNNING, {
      channel: 'B',
      expected: `total=${RECORD_TOTAL} idle=${RECORD_IDLE} running=${RECORD_RUNNING}`,
      actual: `total=${afterSubs.subagents?.length ?? 0} idle=${afterIdle} running=${afterRunning}`,
    })
    const newLog = readRuntimeLog(dataDir).slice(logMarkBeforeKill)
    const rescanEvidence = newLog.split('\n').filter((l) => l.includes('record frames published') && l.includes(SID))
    ev.assert('A6: 重扫日志证据（重启后 record frames published × sessionId）', rescanEvidence.length > 0, {
      channel: 'C',
      expected: '≥1 行 record frames published',
      actual: rescanEvidence.length > 0 ? rescanEvidence[rescanEvidence.length - 1].slice(0, 300) : '（无）',
    })
    ev.attach('a6-rescan-log', rescanEvidence.join('\n') || '（无）')

    // UI：恢复后抽屉 subagent 面板重开（用户可见面第二视角）
    await drawerToggle.waitFor({ state: 'visible', timeout: 30_000 })
    await drawerToggle.click()
    await drawerPanel.waitFor({ state: 'visible', timeout: 10_000 })
    const subagentTabAfter = await page.locator('[data-testid="drawer-tab-subagent"]').first().isVisible().catch(() => false)
    ev.assert('A6: 重启后抽屉 subagent 面板 tab 仍可用（自愈后用户可见面可达）', subagentTabAfter, {
      channel: 'A',
      expected: 'drawer-tab-subagent 可见',
      actual: subagentTabAfter ? '可见' : '不可见',
    })
    await ev.shot(page, 'a2a6-after-rescan-panel')
  } finally {
    await protoAfter.close().catch(() => {})
  }

  log('startup-a2a6: 段落完成')
  return { uncovered: [], gotchas }
}
