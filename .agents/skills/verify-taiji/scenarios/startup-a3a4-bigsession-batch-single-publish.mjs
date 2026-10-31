/**
 * startup-a3a4 —— 启动设计验收场景 A3 + A4 双段剧本（F4 裁决合并：A4 验收依赖
 * A3 装置——同装配 50+ record 会话 + mock-http 通道）。
 *
 * A3 段（设计 §4.1 场景 3）：50+ subagent 记录的会话，发一条普通消息后立即开面板，
 * 200ms 内出现（骨架屏→内容——数据已缓存时直接显示内容，骨架屏形态归 A4 冷读
 * 窗口与 u-m2 SC9 消费接线）；负载期事件循环滞后遥测无一次 > 50ms（常驻
 * monitorEventLoopDelay 直方图，60s 窗口落盘一行 maxMs）；无 kill decision
 * （SIGKILL 未发生 = supervisor 无 kill decision 日志）。
 *
 * A4 段（场景 4，过渡期冷读）：第二会话（本进程未读过的 55 record fixture）进入
 * 冷读——批末一次更新：session.subagents 推送帧数 = 1（RL5 剧本内嵌断言）；
 * RPC reply 与广播帧携带 additive batchInProgress 标志（字段出口 65d2dd24d 接线）。
 * 移动壳 SubagentSheet 段（SC9 消费语义）归 u-m2 M2-5 交付后补验（本波
 * renderer/mobile-renderer 对 batchInProgress 零消费点，2026-10-31 grep 核实）。
 */
import path from 'node:path'

import { createProtocol } from '../scripts/lib/protocol.mjs'
import { pollUntil, readRuntimeLog } from './lib-conn-datasync.mjs'
import { parseTelemetryLines, seedProjects, seedRecordEvents, seedSessionFile } from './lib/startup-records-fixture.mjs'

const RECORD_TOTAL = 55
const PANEL_APPEAR_BUDGET_MS = 200

export const meta = {
  id: 'startup-a3a4-bigsession',
  priority: 'P0',
  title: '启动设计 A3+A4：大会话面板响应性双段 + 冷读批末一次（RL5）+ 滞后遥测 ≤50ms',
  covers: ['subagent.dispatch', 'subagent.list', 'env.ready'],
  requires: ['mock-http'],
  estimateSec: 480,
  llm: {
    responses: {
      'mockllm/mock-1': [{ text: 'startup-a3a4 ack', stopReason: 'stop' }],
    },
  },
  provable: [
    'A3: 发消息后立即开托盘 subagent 面板，click 后 200ms 内面板可见，随后 55 条 records 完整显示',
    'A3: 负载窗口的事件循环滞后遥测行 maxMs ≤ 50（常驻直方图 60s 窗口）',
    'A3: 负载期无 kill decision（main 日志零 kill decision 行）',
    'A4: 第二会话冷读 session.subagents 推送帧数 = 1（RL5 批末一次）',
    'A4: RPC reply 与广播帧均携带 additive batchInProgress 标志（boolean 在场）',
  ],
  notProvable: [
    'A4 骨架屏窗口的视觉形态（冷读 3.1ms/91 文件实测，亚可见窗口不可稳定捕捉；UI 骨架屏消费（SC9）归 u-m2 M2-5）',
    'A3 骨架屏→内容的过渡帧（数据已缓存时面板直接显示内容，过渡帧不出现）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const uncovered = [
    'A4 移动壳 SubagentSheet 批进行中开 → 骨架屏 → 批末推送后重拉整表（SC9 消费语义）——UI 壳消费 batchInProgress 归 u-m2 M2-5 交付（renderer/mobile-renderer 零消费点，2026-10-31 grep 核实），本波以协议字段出口承载半边',
  ]
  const gotchas = [
    'A4 冷读装配用「第二会话」形态（impl-plan A4 行：重启实例或第二会话进入冷读）——第二连接先于 UI 订阅并触发首次查询，帧计数不被 renderer 抢跑污染',
    '遥测断言等负载开始后的下一个 60s 窗口行（EMIT_INTERVAL_MS=60s，落盘低频采样连续）',
    'A3「面板」断言对象 = 右抽屉 subagent tab（renderer 链路）：托盘 subagent widget（pi-subagent-workflow viewId=subagent）由扩展在活跃 pi 会话 session_start 后推送自身进程内 collectRecords 的 records——fixture 磁盘预置 records 不进该 widget（probe 实测 2026-10-31），records 内容完整性以 B 通道 RPC 承载；真实 dispatch 的 widget 观测已有 p0-subagent-workflow-dispatch 剧本承载',
  ]
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')
  const SID_COLD = 'sess-startup-a4-cold'
  const PROJECT_ID = 'proj-startup-acc'

  // ── 段 0：种子（会话 B = 55 record 未读冷读目标）+ launch ────────────────
  await instance.stop()
  seedProjects(dataDir, [{ id: PROJECT_ID, name: 'StartupAcc' }])
  seedSessionFile(dataDir, { sessionId: SID_COLD, cwd, projectId: PROJECT_ID })
  const coldRecords = []
  for (let i = 1; i <= RECORD_TOTAL; i += 1) {
    coldRecords.push({ id: `sa-cold-${String(i).padStart(2, '0')}`, status: 'idle' })
  }
  const seededCold = seedRecordEvents(dataDir, SID_COLD, coldRecords)
  ev.step({ step: 'seed.cold-session', channel: 'C', exitCode: 0, stats: { sessionId: SID_COLD, recordFiles: RECORD_TOTAL, recordsDir: seededCold.recordsDir } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  const page = await instance.page()
  const proto = await instance.protocol()
  ev.step({ step: 'env.ready', channel: 'C', exitCode: 0, stats: { runtimePort: ready.runtimePort } })
  const telemetryBaseline = parseTelemetryLines(readRuntimeLog(dataDir)).length
  const loadStartAt = Date.now()

  // ── 段 1（A3）：活跃大会话——建会话 + 预置 records + 发消息 + 立即开面板 ──
  const created = await proto.call('session.create', { cwd, label: 'startup-a3a4-live' }, { timeoutMs: 120_000 })
  const sidLive = created.session?.id
  if (!sidLive) throw new Error(`session.create 未返回 session.id: ${JSON.stringify(created).slice(0, 300)}`)
  const liveRecords = []
  for (let i = 1; i <= RECORD_TOTAL; i += 1) {
    liveRecords.push({ id: `sa-live-${String(i).padStart(2, '0')}`, status: 'idle' })
  }
  seedRecordEvents(dataDir, sidLive, liveRecords)
  ev.step({ step: 'a3.live-session', channel: 'B', exitCode: 0, stats: { sessionId: sidLive, presetRecords: RECORD_TOTAL } })

  // UI 激活：会话行（新建会话 LRU 置顶）→ 点行激活。A3 的「面板」= 右抽屉 subagent
  // tab（renderer 链路；托盘 subagent widget 只推送扩展进程内创建的 records——
  // fixture 磁盘 records 不进 widget，见 gotchas；records 数据完整性走 B 通道）
  await pollUntil(
    async () => {
      const count = await page.locator('.session-item').count()
      return count > 0 ? count : null
    },
    { timeoutMs: 60_000, intervalMs: 400, label: '侧栏会话行渲染' },
  )
  await page.locator('.session-item').first().click()
  const drawerToggle = page.locator('[data-testid="drawer-toggle"]')
  await drawerToggle.waitFor({ state: 'visible', timeout: 60_000 })
  const drawerPanel = page.locator('[data-testid="drawer-panel"]')

  // 发一条普通消息，立即开面板（不等 turn 完成）
  await proto.send(sidLive, 'startup-a3a4 面板响应性验证')
  await drawerToggle.click()
  const tClickDone = Date.now()
  const appearMs = await pollUntil(
    async () => {
      const visible = await drawerPanel.isVisible().catch(() => false)
      return visible ? Date.now() : null
    },
    { timeoutMs: PANEL_APPEAR_BUDGET_MS, intervalMs: 20, label: `subagent 面板 ${PANEL_APPEAR_BUDGET_MS}ms 内可见` },
  ).then(
    (v) => v - tClickDone,
    () => -1,
  )
  ev.assert(`A3: 发消息后立即开面板，click 后 ${PANEL_APPEAR_BUDGET_MS}ms 内面板可见`, appearMs >= 0 && appearMs <= PANEL_APPEAR_BUDGET_MS, {
    channel: 'A',
    expected: `≤ ${PANEL_APPEAR_BUDGET_MS}ms`,
    actual: appearMs >= 0 ? `${appearMs}ms` : '超时未出现',
  })

  // turn 收尾（mock 单轮）+ 面板内容完整（B 通道）
  const turnEnd = await proto.waitTurnEnd(sidLive, { timeoutMs: 120_000 })
  ev.assert('A3: 消息轮正常完成（message.complete）', turnEnd.ok, {
    channel: 'B',
    expected: 'message.complete',
    actual: `${turnEnd.type} stopReason=${turnEnd.payload?.stopReason ?? '—'}`,
  })
  const liveQuery = await proto.call('session.getSubagents', { sessionId: sidLive })
  ev.assert(
    `A3: 大会话 records 完整（活跃会话查询 ${RECORD_TOTAL} 条）`,
    liveQuery.subagents?.length === RECORD_TOTAL,
    {
      channel: 'B',
      expected: String(RECORD_TOTAL),
      actual: String(liveQuery.subagents?.length ?? 0),
    },
  )
  const subagentTabLive = await page.locator('[data-testid="drawer-tab-subagent"]').first().isVisible().catch(() => false)
  ev.assert('A3: 抽屉 subagent 面板 tab 在场（面板内容可达）', subagentTabLive, {
    channel: 'A',
    expected: 'drawer-tab-subagent 可见',
    actual: subagentTabLive ? '可见' : '不可见',
  })
  await ev.shot(page, 'a3a4-panel-content')

  // ── 段 2（A3）：负载期事件循环滞后遥测 ≤ 50ms + 无 kill decision ─────────
  const telemetryLine = await pollUntil(
    async () => {
      const lines = parseTelemetryLines(readRuntimeLog(dataDir))
      const fresh = lines.slice(telemetryBaseline)
      return fresh.length > 0 ? fresh : null
    },
    { timeoutMs: 120_000, intervalMs: 2_000, label: '负载后事件循环滞后遥测窗口行落盘' },
  )
  const windowMax = Math.max(...telemetryLine.map((t) => t.maxMs ?? 0))
  ev.assert('A3: 负载窗口事件循环滞后无一次 > 50ms（遥测行 maxMs ≤ 50，含负载期窗口）', windowMax <= 50, {
    channel: 'C',
    expected: 'maxMs ≤ 50',
    actual: `maxMs=${windowMax}（${telemetryLine.length} 个窗口行，loadStart=${new Date(loadStartAt).toISOString()}）`,
  })
  ev.attach('a3-telemetry-lines', JSON.stringify(telemetryLine, null, 2))
  const launchLog = (await import('node:fs')).readFileSync(`${dataDir}/verify-launch.log`, 'utf8')
  const mainLogText = readRuntimeLog(dataDir)
  const killDecisionHits = [...launchLog.matchAll(/kill decision/gi), ...mainLogText.matchAll(/kill decision/gi)].length
  ev.assert('A3: 负载期无 kill decision（装配/运行日志零命中）', killDecisionHits === 0, {
    channel: 'C',
    expected: '0',
    actual: String(killDecisionHits),
  })

  // ── 段 3（A4）：第二会话冷读——批末一次（推送帧数 = 1，RL5）+ 标志出口 ────
  const protoB = await createProtocol({ dataDir, runtimePort: ready.runtimePort })
  try {
    await protoB.subscribe(SID_COLD)
    const idx0 = protoB.events.length
    const reply = await protoB.call('session.getSubagents', { sessionId: SID_COLD })
    await new Promise((r) => setTimeout(r, 600))
    const pushFrames = protoB.events
      .slice(idx0)
      .filter((e) => e.type === 'session.subagents' && e.payload?.sessionId === SID_COLD)
    ev.assert(`A4: 冷读期 session.subagents 推送帧数 = 1（RL5 批末一次；共 ${RECORD_TOTAL} record 文件冷读）`, pushFrames.length === 1, {
      channel: 'B',
      expected: '1 帧',
      actual: `${pushFrames.length} 帧（${pushFrames.map((f) => `batchInProgress=${String(f.payload?.batchInProgress)}`).join(', ') || '无帧'}）`,
    })
    ev.assert(`A4: 冷读查询全量返回 ${RECORD_TOTAL} 条`, reply.subagents?.length === RECORD_TOTAL, {
      channel: 'B',
      expected: String(RECORD_TOTAL),
      actual: String(reply.subagents?.length ?? 0),
    })
    ev.assert('A4: RPC reply 携带 additive batchInProgress 标志（boolean 在场，批外 = false）', typeof reply.batchInProgress === 'boolean', {
      channel: 'B',
      expected: 'boolean',
      actual: `${typeof reply.batchInProgress} = ${String(reply.batchInProgress)}`,
    })
    const frameFlag = pushFrames[0]?.payload?.batchInProgress
    ev.assert('A4: 广播帧（批末快照）携带 additive batchInProgress 标志', pushFrames.length === 1 && frameFlag !== undefined, {
      channel: 'B',
      expected: '字段在场',
      actual: `batchInProgress=${String(frameFlag)}`,
    })

    // UI：切到冷读会话（fixture 会话行 = 非 live 会话的那行）→ 抽屉面板可用
    const coldRow = page.locator('.session-item').filter({ hasNotText: 'startup-a3a4-live' }).first()
    await coldRow.click()
    await drawerToggle.waitFor({ state: 'visible', timeout: 30_000 })
    await drawerToggle.click()
    await drawerPanel.waitFor({ state: 'visible', timeout: 10_000 })
    const subagentTabCold = await page.locator('[data-testid="drawer-tab-subagent"]').first().isVisible().catch(() => false)
    ev.assert('A4: 桌面壳冷读会话抽屉 subagent 面板 tab 在场（冷读后用户可见面可达）', subagentTabCold, {
      channel: 'A',
      expected: 'drawer-tab-subagent 可见',
      actual: subagentTabCold ? '可见' : '不可见',
    })
    await ev.shot(page, 'a3a4-cold-panel')
  } finally {
    await protoB.close().catch(() => {})
  }

  log('startup-a3a4: 段落完成')
  return { uncovered, gotchas }
}
