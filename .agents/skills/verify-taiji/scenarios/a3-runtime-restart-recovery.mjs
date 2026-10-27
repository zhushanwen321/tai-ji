/**
 * a3-runtime-restart-recovery —— 验收场景 3（设计 §8）：runtime 重启（端口复用）自动恢复。
 *
 * 回溯目标 2。机制（源码核对）：SIGKILL runtime 子进程 → supervisor onRuntimeExit 判
 * 意外退出 → scheduleRestart('crash')（退避 1s/2s/4s，restart-policy.ts）→ attemptRestart
 * → start()（findAvailablePort 段内复用）+ 广播 RUNTIME_PORT 新快照（seq+1、新 runtimeId）
 * → renderer 连接控制器按目标比较断旧连新 → 连接边沿域同步重拉。
 *
 * 通过标准（设计 §8 场景 3）：
 *   连接自动迁移（日志可见实例变更迁移），会话与分组自动恢复，无需刷新；
 *   恢复过程项目分组区不闪空、不闪加载占位（保留最后已知分组，§6.7 重拉子形态）；
 *   编辑入口不闪烁置灰（§6.9）。
 *
 * 登记口径（设计内行为，非缺陷）：restarting 态 App.vue 整体切「runtime 重启中…」过渡屏
 * （AppShell 卸载）是连接级过渡——「分组区不闪」判据在 AppShell 挂载窗口内断言
 * （侧栏在场即分组恒 ≥1 且无占位），过渡屏本身不纳入分组区闪烁判定。
 */
import path from 'node:path'

import {
  PROD_DATA_DIR,
  authEcho,
  countTestId,
  pollUntil,
  readJsonFile,
  readLaunchLog,
  readSidebarGroups,
  runtimePidOf,
  seedRealisticDataDir,
  signalPid,
  supervisorSnapshot,
  waitForSidebarGroups,
} from './lib-conn-datasync.mjs'

const KILL_ROUNDS = 3

export const meta = {
  id: 'a3-runtime-restart-recovery',
  priority: 'P0',
  title: '场景 3：runtime 重启（端口复用）自动恢复（3 轮 kill + 分组不闪）',
  covers: ['env.launch', 'env.ready', 'session.list'],
  requires: ['none'],
  estimateSec: 300,
  provable: [
    '3 轮 SIGKILL runtime 后每次自动重启（Restart succeeded on port 日志）且端口复用落回原端口',
    '实例变更迁移：每轮新 runtimeId（auth 应答 + env 双证），分组与计数自动恢复、无需页面刷新',
    '恢复过程 AppShell 挂载窗口内分组区不闪空、不闪加载占位（200ms 采样时间线）',
    '编辑入口（project-add-btn）在恢复窗口不出现禁用态',
  ],
  notProvable: [
    'restarting 过渡屏本身（连接级 AppShell 卸载，App.vue 设计内行为）不计入分组区闪烁判定',
    '命令×同步交错提交次序（重拉在途窗口毫秒级人工不可执行，由 U4 单测层确定性时序构造承载，设计 §8 场景 3 明示）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'restarting 态 App.vue v-if="connectionState !== \'connected\'" 整体切过渡屏（AppShell 卸载）——连接级设计内行为；分组区「不闪空/不闪占位」判据在 AppShell 挂载窗口内断言',
  ]

  // ── 段 0：种子真实数据 + 基线 ───────────────────────────────────
  await instance.stop()
  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR })
  const seeded = readJsonFile(path.join(dataDir, 'projects.json'))
  const expectedNames = seeded.projects.filter((p) => p.id !== 'proj-default' && p.name).map((p) => p.name).sort()
  ev.step({ step: 'seed.realistic-data', channel: 'C', exitCode: 0, stats: { boundSessions: seed.sessions.length } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  const page = await instance.page()
  const baseGroups = await waitForSidebarGroups(page, { minGroups: expectedNames.length, timeoutMs: 60_000 })
  const baseEcho = await authEcho(dataDir, ready.runtimePort)
  const baseSnapshot = await supervisorSnapshot(page)
  const baseRuntimeId = baseEcho.runtimeId
  const baseCounts = baseGroups.map((g) => `${g.name}=${g.count}`).sort().join(' ')
  ev.step({
    step: 'baseline.ready',
    channel: 'C',
    exitCode: 0,
    stats: { runtimePort: ready.runtimePort, runtimeId: baseRuntimeId, snapshotSeq: baseSnapshot?.seq ?? null, counts: baseCounts },
  })

  // ── 采样器：AppShell 挂载窗口内的分组区形态时间线 ─────────────────
  let sampling = true
  const timeline = []
  const sampler = (async () => {
    while (sampling) {
      try {
        const mounted = (await countTestId(page, 'session-list-header')) > 0
        const groups = mounted ? await readSidebarGroups(page) : []
        const placeholder = await countTestId(page, 'project-group-loading-placeholder')
        const failedBar = await countTestId(page, 'project-load-failed-bar')
        let addDisabled = null
        if (mounted) {
          const addCount = await countTestId(page, 'project-add-btn')
          if (addCount > 0) {
            addDisabled = await page.locator('[data-testid="project-add-btn"]').first().getAttribute('disabled')
          }
        }
        timeline.push({ t: Date.now(), mounted, groups: groups.length, placeholder, failedBar, addDisabled })
      } catch {
        /* CDP 瞬断（过渡屏切换）不阻断采样 */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  })()

  const rounds = []
  let currentPort = ready.runtimePort
  for (let round = 1; round <= KILL_ROUNDS; round += 1) {
    const pidBefore = runtimePidOf(dataDir)
    const portBefore = currentPort
    const killed = signalPid(pidBefore, 'SIGKILL')
    ev.step({ step: `kill.${round}`, channel: 'C', exitCode: 0, stats: { pid: pidBefore, signal: 'SIGKILL', delivered: killed } })
    log(`round ${round}: SIGKILL runtime pid=${pidBefore} port=${portBefore}`)

    // 等自动重启落定（日志信号 + 端口可连）
    const logLenBefore = readLaunchLog(dataDir).length
    const restarted = await pollUntil(
      async () => {
        const tail = readLaunchLog(dataDir).slice(logLenBefore)
        return /\[runtime\] Restart succeeded on port \d+/.test(tail) ? tail : null
      },
      { timeoutMs: 120_000, intervalMs: 500, label: `第 ${round} 轮 runtime 自动重启` },
    )
    const readyAfter = await instance.waitReady({ timeoutMs: 120_000 })
    const portAfter = readyAfter.runtimePort
    const echoAfter = await authEcho(dataDir, portAfter)
    ev.assert(`C: 第 ${round} 轮 kill 后自动重启（Restart succeeded on port ${portAfter}）`, /Restart succeeded on port \d+/.test(restarted), {
      channel: 'C',
      expected: 'Restart succeeded on port',
      actual: restarted.split('\n').filter((l) => /Restart succeeded/.test(l)).slice(-1)[0] ?? '(无)',
    })

    // 实例变更迁移：新 runtimeId（快照签发侧 + auth 应答侧双证）
    const snapAfter = await supervisorSnapshot(page)
    ev.assert(`C: 第 ${round} 轮实例标识迁移（新 runtimeId：auth 应答 === supervisor 快照，且 ≠ 基线）`, echoAfter.runtimeId !== baseRuntimeId && echoAfter.runtimeId === (snapAfter?.runtimeId ?? null), {
      channel: 'B',
      expected: `≠ ${baseRuntimeId} 且 === 快照`,
      actual: `${echoAfter.runtimeId}（快照=${snapAfter?.runtimeId ?? '(无)'}）`,
    })

    // 端口复用（落回原端口形态）
    ev.assert(`C: 第 ${round} 轮端口复用（重启后落回原端口 ${portBefore}）`, portAfter === portBefore, {
      channel: 'C',
      expected: portBefore,
      actual: portAfter,
    })

    // 分组自动恢复（无需页面刷新——同一 page 对象，全程无 reload）
    const groupsAfter = await waitForSidebarGroups(page, { minGroups: expectedNames.length, timeoutMs: 60_000 })
    const countsAfter = groupsAfter.map((g) => `${g.name}=${g.count}`).sort().join(' ')
    ev.assert(`A: 第 ${round} 轮分组与计数自动恢复（无需刷新）`, countsAfter === baseCounts, {
      channel: 'A',
      expected: baseCounts,
      actual: countsAfter,
    })
    rounds.push({ round, pid: pidBefore, portBefore, portAfter, runtimeId: echoAfter.runtimeId, counts: countsAfter })
    currentPort = portAfter
  }

  sampling = false
  await sampler

  // ── 恢复过程形态判定（时间线分析） ──────────────────────────────
  const mountedSamples = timeline.filter((s) => s.mounted)
  const placeholderSeen = timeline.some((s) => s.placeholder > 0)
  const emptyWhileMounted = mountedSamples.some((s) => s.groups === 0)
  const addDisabledSeen = timeline.some((s) => s.addDisabled !== null)
  const failedBarSeen = timeline.some((s) => s.failedBar > 0)
  ev.assert('A: 恢复全程无加载占位闪现（project-group-loading-placeholder 零出现）', !placeholderSeen, {
    channel: 'A',
    expected: '0 次',
    actual: `${timeline.filter((s) => s.placeholder > 0).length} 次（采样 ${timeline.length} 点，挂载窗口 ${mountedSamples.length} 点）`,
  })
  ev.assert('A: AppShell 挂载窗口内分组区不闪空（groups 恒 ≥1）', !emptyWhileMounted, {
    channel: 'A',
    expected: '挂载窗口 groups 恒 ≥1',
    actual: emptyWhileMounted ? '出现过 groups=0' : `挂载 ${mountedSamples.length} 点全部 ≥1`,
  })
  ev.assert('A: 恢复窗口编辑入口不闪烁置灰（project-add-btn 无 disabled 态）', !addDisabledSeen, {
    channel: 'A',
    expected: '无 disabled 采样',
    actual: addDisabledSeen ? '出现过 disabled' : '未出现',
  })
  ev.assert('A: 恢复全程无失败状态条（project-load-failed-bar 零出现）', !failedBarSeen, {
    channel: 'A',
    expected: '0 次',
    actual: `${timeline.filter((s) => s.failedBar > 0).length} 次`,
  })
  ev.attach('restart-timeline', JSON.stringify({ samples: timeline.length, mounted: mountedSamples.length, rounds }, null, 2))
  await ev.shot(page, 'a3-final-groups')

  if (uncovered.length === 0) log('a3: 全部断言通过')
  return { uncovered, gotchas }
}
