/**
 * startup-a5 —— 启动设计验收场景 A5（u-foundation 波次段）：推送丢失检测兜底。
 *
 * 场景（设计 §4.1 场景 5，过渡期形态）：journal 写入方已把终态事件落盘但 marker
 * 推送未达 runtime（推送丢失）→ 某 record 停留 running → 触发一次列表查询 →
 * 查询路径检测补上（状态正确），无长期停留 running 的记录。
 *
 * 注入通道（确定性编排，impl-plan A5 行「注入通道 = mock pi 置换或测试钩子」中取
 * 磁盘直写形态 = journal 写入方的落盘半边、marker 推送缺席）：
 * 1. record 事件文件追加 record-round-idle 终态行（真实写侧双介质之一）；
 * 2. 会话 jsonl mtime 推进（真实写侧「事件文件 + 会话文件」同点双写对 mtime 的效果，
 *    以 utimes 模拟——查询通道 mtime 对账由此触发投影重建，session-records.ts
 *    rebuildProjectionIfSourceChanged，2026-10-31 源码核实）。
 *
 * 检测路径（源码核对）：getSubagents 查询透传 scanSessions meta → mtime 对账不一致
 * → 旧投影 dispose + 重建（attach 全量冷读事件文件）→ 终态行被 fold → 状态正确。
 */
import path from 'node:path'

import {
  appendRecordEvent,
  seedProjects,
  seedRecordSession,
  touchSessionMtime,
} from './lib/startup-records-fixture.mjs'

const SID = 'sess-startup-a5-watch'
const WATCH_ID = 'sa-a5-watch'
const PROJECT_ID = 'proj-startup-acc'

export const meta = {
  id: 'startup-a5-pushloss',
  priority: 'P1',
  title: '启动设计 A5：推送丢失后列表查询补全（查询路径检测兜底）',
  covers: ['subagent.list', 'session.persistence'],
  requires: ['none'],
  estimateSec: 300,
  provable: [
    '推送丢失形态成立：注入前查询返回 watch record status=running（终态事件已在盘、投影未消费）',
    '触发一次列表查询后 watch record status=idle 且 stopReason=stop（检测补上，与注入行一致）',
    '查询后全列表无 running 停留记录（idle × 4）',
    'UI 面板同屏复核：subagent 托盘 widget 面板显示 watch record（slug 在场）',
  ],
  notProvable: [
    '「无长期停留 running」的时间维度（长期性）——单次剧本验证补全语义（查询后状态正确即蕴含不长期停留），长期停留看守由补全后状态正确承载',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir, repo } = ctx
  const gotchas = [
    '注入形态 = 磁盘直写（journal 写入方落盘半边 + marker 推送缺席），未置换 mock pi——落盘与推送两半边在真实链路同点发生，磁盘直写等价覆盖「推送丢失」窗口',
  ]
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')

  // ── 段 0：种子（1 running + 3 idle）+ launch ────────────────────────────
  await instance.stop()
  seedProjects(dataDir, [{ id: PROJECT_ID, name: 'StartupAcc' }])
  const seeded = seedRecordSession(dataDir, {
    sessionId: SID,
    cwd,
    projectId: PROJECT_ID,
    records: [
      { id: WATCH_ID, status: 'running', task: 'a5 推送丢失观察位' },
      { id: 'sa-a5-idle-1', status: 'idle' },
      { id: 'sa-a5-idle-2', status: 'idle' },
      { id: 'sa-a5-idle-3', status: 'idle' },
    ],
  })
  ev.step({ step: 'seed.watch-session', channel: 'C', exitCode: 0, stats: { sessionId: SID, recordsDir: seeded.recordsDir } })

  await instance.launch()
  await instance.waitReady({ timeoutMs: 180_000 })
  const page = await instance.page()
  const proto = await instance.protocol()

  // ── 段 1：推送丢失形态确认（查询 1——终态未落，watch 停留 running）──────
  const first = await proto.call('session.getSubagents', { sessionId: SID })
  const watchBefore = first.subagents?.find((s) => s.subagentId === WATCH_ID)
  ev.assert('推送丢失形态: 注入前查询 watch record status=running（投影只消费到 round-started）', watchBefore?.status === 'running', {
    channel: 'B',
    expected: 'running',
    actual: `${watchBefore?.status ?? '(未找到)'}（total=${first.subagents?.length ?? 0}）`,
  })

  // ── 段 2：注入——终态行落盘（推送缺席）+ 会话文件 mtime 推进 ─────────────
  const mtimeBefore = (await import('node:fs')).statSync(seeded.sessionFile).mtimeMs
  const injected = appendRecordEvent(dataDir, SID, WATCH_ID, {
    type: 'record-round-idle',
    round: 1,
    stopReason: 'stop',
  })
  const mtimeAfter = touchSessionMtime(seeded.sessionFile)
  ev.step({
    step: 'inject.push-loss',
    channel: 'C',
    exitCode: 0,
    stats: { eventFile: injected.file, seq: injected.line.seq, stopReason: injected.line.stopReason, mtimeBefore, mtimeAfter },
  })
  ev.attach('a5-injected-line', `${injected.file}\n${JSON.stringify(injected.line)}`)

  // ── 段 3：触发一次列表查询 → 检测补全 ────────────────────────────────────
  const second = await proto.call('session.getSubagents', { sessionId: SID })
  const watchAfter = second.subagents?.find((s) => s.subagentId === WATCH_ID)
  const runningAfter = second.subagents?.filter((s) => s.status === 'running').length ?? -1
  ev.assert('兜底: 查询后 watch record status=idle（检测补上）', watchAfter?.status === 'idle', {
    channel: 'B',
    expected: 'idle',
    actual: String(watchAfter?.status ?? '(未找到)'),
  })
  ev.assert('兜底: 查询后 stopReason=stop（与注入行一致）', watchAfter?.stopReason === 'stop', {
    channel: 'B',
    expected: 'stop',
    actual: String(watchAfter?.stopReason ?? '—'),
  })
  ev.assert('兜底: 查询后全列表无 running 停留记录（idle × 4）', runningAfter === 0 && second.subagents?.length === 4, {
    channel: 'B',
    expected: 'running=0 / total=4',
    actual: `running=${runningAfter} / total=${second.subagents?.length ?? 0}`,
  })

  // ── 段 4：UI 同屏复核（用户可见面）──────────────────────────────────────
  // subagent 面板现行宿主 = 托盘协议 widget 区（pi-subagent-workflow 扩展注册，
  // viewId='subagent'——docs/testing/02 的 tray-builtin-button[data-kind=subagent]
  // 形态已随容器扩展点统一 §6.6/U9+U10 迁移退役；面板行 = agent · slug 文本）
  await page.locator('.session-item').first().waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('.session-item').first().click()
  const subagentWidgetBtn = page.locator('[data-testid="tray-widget-button"][data-widget-key="subagent"]')
  await subagentWidgetBtn.waitFor({ state: 'visible', timeout: 30_000 })
  await subagentWidgetBtn.click()
  await page.locator('[data-testid="tray-widget-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
  const panelText = await page.locator('[data-testid="tray-widget-panel"]').first().innerText()
  ev.assert(
    'A 通道复核: 补全后面板显示 watch record（slug 在场，非运行态消失面）',
    panelText.includes('fixture-sa-a5-watch'),
    {
      channel: 'A',
      expected: "面板文本含 'fixture-sa-a5-watch'",
      actual: `面板文本头 200 字: ${JSON.stringify(panelText.slice(0, 200))}`,
    },
  )
  await ev.shot(page, 'a5-after-detect')

  log('startup-a5: 段落完成')
  return { uncovered: [], gotchas }
}
