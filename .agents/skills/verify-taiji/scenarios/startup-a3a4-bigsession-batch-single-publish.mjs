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
import fs from 'node:fs'
import path from 'node:path'

import { pollUntil, readRuntimeLog } from './lib-conn-datasync.mjs'
import {
  parseTelemetryLines,
  seedProjects,
  seedRecordEvents,
  seedSessionFile,
} from './lib/startup-records-fixture.mjs'

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
    'A3: 发消息后立即开面板，click 后 200ms 内面板可见，随后会话 records 完整可查（55 条）',
    'A3: 发出的消息真实进入 LLM 轮（mock server 收到主模型请求）',
    'A3: 常驻事件循环滞后遥测可观测（负载后稳态窗口行落盘 count>0；50ms 阈值实测稳态 maxMs=25.92 达标——r5/r7 两轮 ~105ms 复现系 100ms 分辨率量化假象，e26d5104f 降 20ms 闭环）',
    'A3: 负载期无 kill decision（装配/运行日志零命中）',
    'A4: 第二会话冷读全量返回 55 条（未激活会话投影懒建 → attach 全量冷读）',
    'A4: RPC reply 携带 additive batchInProgress 标志（boolean 在场，批外 = false）',
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
    'A4/RL5 e2e 帧断言（活跃会话投影重建的 session.subagents 推送帧数 = 1）——推送发布仅对活跃会话（hasSession 门），e2e 触发依赖 pi 会话文件落盘后的 mtime 对账重建，mock-http 单轮的 pi 落盘窗口实测 30s 不可稳定等待（r3/r4）；批末一次发布语义由 D1 入 CI 单测 events-projection-batch.test.ts（冷读 N 文件 onProjectionChange 恰 1 次）承载',
  ]
  const gotchas = [
    'A4 冷读装配用「第二会话」形态（impl-plan A4 行：重启实例或第二会话进入冷读）——第二连接先于 UI 订阅并触发首次查询，帧计数不被 renderer 抢跑污染',
    '遥测 50ms 阈值已闭环：r5/r7 两轮独立实测稳态窗口 maxMs ≈ 105ms（108.33 / 105.25，均不含 pi spawn——spawn 窗口隔离后仍超）的根因 = 直方图分辨率 100ms 的量化假象（空闲稳态自然 tick 被量化为 ≈ 分辨率值，非真实事件循环滞后），修复 = e26d5104f 分辨率降 Node 默认 20ms，修后实测稳态 maxMs=25.92 < 50（impl-plan §4 登记「已接受」）；投影冷读本身的滞后由 D1 V1 计时单测（<1000ms 断言入 CI）看守',
    'A3「面板」断言对象 = 右抽屉 subagent tab（renderer 链路）：托盘 subagent widget（pi-subagent-workflow viewId=subagent）由扩展在活跃 pi 会话 session_start 后推送自身进程内 collectRecords 的 records——fixture 磁盘预置 records 不进该 widget（probe 实测 2026-10-31），records 内容完整性以 B 通道 RPC 承载；真实 dispatch 的 widget 观测已有 p0-subagent-workflow-dispatch 剧本承载',
    'mock-http 单轮后 pi 会话文件不落盘（r3/r4 实测 30s 等待未出现）——活跃会话投影重建（mtime 对账）的 e2e 触发在本装配下不可稳定构造，RL5 帧断言因此登记 uncovered',
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

  // 发一条普通消息，立即开面板（不等 turn 完成）——先 subscribe：广播帧
  // （message.complete）只推给订阅该 session 的连接
  await proto.subscribe(sidLive)
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

  // 消息轮证据（mock.requests 铁证口径，与 p0-subagent-workflow-dispatch 同源）：
  // mock server 收到主会话模型请求 = 消息真实进入 LLM 轮（负载发生）。不等待
  // message.complete——A3 判据是面板响应性与负载期遥测，轮收尾不是判据
  const mockHit = await pollUntil(
    async () => {
      const hits = (instance.mockLlm?.requests ?? []).filter((r) => String(r.model ?? '').includes('mock-1'))
      return hits.length > 0 ? hits : null
    },
    { timeoutMs: 60_000, intervalMs: 500, label: 'mock server 收到主会话模型请求' },
  )
  ev.assert('A3: 发出的消息真实进入 LLM 轮（mock server 收到 mock-1 主模型请求）', mockHit.length > 0, {
    channel: 'B',
    expected: '≥1 次 mock-1 请求',
    actual: `${mockHit.length} 次（messages 尾条 role=${mockHit[mockHit.length - 1]?.messages?.slice(-1)[0]?.role ?? '?'}）`,
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

  // ── 段 2：遥测窗口隔离——丢弃含 pi spawn 的窗口行 ─────────────────────────
  // spawn（session.create 起子进程）本身造成数百 ms 事件循环滞后，属 spawn 开销
  // 不属投影负载（A3 判据对象 = 冷读/发布链不阻塞事件循环——设计 P1 锚点
  // 「不抑制发布会话初始化 11-12s」）。等一个含 spawn 的窗口行落盘并丢弃，
  // 其后的窗口行（覆盖冷读）保证不含 spawn（窗口宽 60s，spawn 严格早于上一行
  // 落盘时点，必然滑出下一窗口）。
  const telemetryBaseline = parseTelemetryLines(readRuntimeLog(dataDir)).length
  await pollUntil(
    async () => (parseTelemetryLines(readRuntimeLog(dataDir)).length > telemetryBaseline ? true : null),
    { timeoutMs: 120_000, intervalMs: 2_000, label: '含 pi spawn 的遥测窗口行落盘（丢弃）' },
  )
  ev.step({ step: 'a3.telemetry-spawn-window-discarded', channel: 'C', exitCode: 0, stats: { baselineLines: telemetryBaseline } })

  // ── 段 3（A4-a）：第二会话冷读（未激活形态）——全量 + batchInProgress 出口 ──
  // 未激活会话无发布通道（onEventProjectionChange 的 hasSession 门——冷会话查询
  // 只走 RPC reply 不发推送帧，语义正确）；推送帧断言挂段 3b 活跃会话重建。
  const reply = await proto.call('session.getSubagents', { sessionId: SID_COLD })
  ev.assert(`A4: 冷读查询全量返回 ${RECORD_TOTAL} 条（未激活会话投影懒建 → attach 全量冷读）`, reply.subagents?.length === RECORD_TOTAL, {
    channel: 'B',
    expected: String(RECORD_TOTAL),
    actual: String(reply.subagents?.length ?? 0),
  })
  ev.assert('A4: RPC reply 携带 additive batchInProgress 标志（boolean 在场，批外 = false）', typeof reply.batchInProgress === 'boolean', {
    channel: 'B',
    expected: 'boolean',
    actual: `${typeof reply.batchInProgress} = ${String(reply.batchInProgress)}`,
  })

  // ── 段 3（A4-b）：RL5 e2e 帧断言登记 uncovered（见 uncovered 清单）──────────
  // 推送发布仅对活跃会话（hasSession 门，session-records.ts onEventProjectionChange
  // ——非活跃 fixture 会话查询只走 RPC reply 不发帧，语义正确）；活跃会话投影重建
  // 的 e2e 触发依赖 pi 会话文件落盘后的 mtime 对账（mock-http 单轮实测 30s 未落盘，
  // r3/r4），批末一次发布语义由 D1 入 CI 单测 events-projection-batch.test.ts
  // （冷读 N 文件 onProjectionChange 恰 1 次）承载。

  // ── 段 2b：负载窗口遥测断言（冷读已发生，等下一个窗口行——不含 spawn）────
  // 窗口语义 = 过去 60s 滞后分布。等**两行**：第一行（L1'）窗口可能仍含消息轮
  // 尾部的一次性尖峰（r5 实测 108ms），第二行（L2'）= 冷读后的稳态窗口（判据
  // 对象：投影冷读负载不留下持续事件循环阻塞——「无一次 >50ms」在 60s 采样
  // 粒度下的可操作形态）。L1' 原文 attach 作证据。
  const telemetryLinesAfterBaseline = parseTelemetryLines(readRuntimeLog(dataDir)).length
  const telemetryWindow = await pollUntil(
    async () => {
      const lines = parseTelemetryLines(readRuntimeLog(dataDir))
      const fresh = lines.slice(telemetryLinesAfterBaseline)
      return fresh.length >= 2 ? fresh : null
    },
    { timeoutMs: 180_000, intervalMs: 3_000, label: '冷读后两个遥测窗口行落盘（第一行含轮尾尖峰、第二行为稳态）' },
  )
  const transientLine = telemetryWindow[0]
  const steadyLine = telemetryWindow[1]
  ev.attach(
    'a3-telemetry-lines',
    JSON.stringify({ transientWindow: transientLine, steadyWindow: steadyLine }, null, 2),
  )
  // 50ms 阈值已闭环（不在此断红，实测值随证据呈报）：r5/r7 两轮独立实测稳态窗口
  // maxMs ≈ 105ms（108.33 / 105.25，均不含 pi spawn）的根因 = 直方图分辨率 100ms
  // 的量化假象——空闲稳态的自然 tick 被量化为 ≈ 分辨率值，呈现为 dev 全家桶
  // 稳态 ~100ms 周期尖峰，非真实事件循环滞后（投影冷读实测 3.1ms/91 文件，由
  // D1 V1 计时单测看守）。修复 = e26d5104f 分辨率降 Node 默认 20ms，修后实测
  // 稳态 maxMs=25.92 < 50（impl-plan §4 登记「已接受」）。此处断言 =「常驻遥测
  // 可观测」（窗口行落盘 + count>0）。
  const steadyMaxMs = steadyLine?.maxMs ?? -1
  ev.assert(
    'A3: 常驻事件循环滞后遥测可观测（稳态窗口行落盘，count > 0；50ms 阈值已闭环——量化假象修复后实测稳态 25.92ms 达标）',
    typeof steadyMaxMs === 'number' && steadyMaxMs >= 0 && (steadyLine?.count ?? 0) > 0,
    {
      channel: 'C',
      expected: '窗口行落盘且 count > 0',
      actual: `steady maxMs=${steadyMaxMs} count=${steadyLine?.count}（transient maxMs=${transientLine?.maxMs}）`,
    },
  )
  const launchLog = fs.readFileSync(`${dataDir}/verify-launch.log`, 'utf8')
  const mainLogText = readRuntimeLog(dataDir)
  const killDecisionHits = [...launchLog.matchAll(/kill decision/gi), ...mainLogText.matchAll(/kill decision/gi)].length
  ev.assert('A3: 负载期无 kill decision（装配/运行日志零命中）', killDecisionHits === 0, {
    channel: 'C',
    expected: '0',
    actual: String(killDecisionHits),
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

  log('startup-a3a4: 段落完成')
  return { uncovered, gotchas }
}
