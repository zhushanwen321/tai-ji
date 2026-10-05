/**
 * event-push-channel W-P4 三类验收测试：
 *
 * ① 推送-补读等价性：同一事件序列下「纯推送喂入 ≡ 推送+缺口补读混合喂入 ≡
 *    纯文件冷读」——派生视图（合并快照）终态逐字段一致（对齐 apply-entry-equivalence
 *    范式：喂入源换轨后派生视图终态不变）。run / record 两域各一组。
 * ② 断连收敛：pi 进程死亡（推送通道终结）→ 重开 session → 新投影 attach() 冷读
 *    收敛到与推送喂入一致的终态（journal 是磁盘事实源，冷读 = 恢复读）。
 * ③ 终局条目补读触发（设计 §3.3 终局一致性 / D6）：终态条目（entry 通道）在场而
 *    推送丢失终局事件行 → recompute 判定「fold 落后于条目通道」→ 一次补读收敛。
 *
 * fixture 全部落 mkdtemp 临时目录（mkdtempSync 自建自删）；事件形态对齐 core 词表
 * 契约（run 9 词表 / record 六类词表 + 首行头行）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/events-projection-push-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SubagentJournalReport, SubagentJournalEvent } from '@zhushanwen/extension-protocol'
import { SessionEventProjection } from '../events-projection.js'

// ── fixture ───────────────────────────────────────────────────

type World = { dir: string; recordsDir: string; runDir: string }

function makeWorld(tag: string): World {
  const dir = mkdtempSync(join(tmpdir(), `jp-push-${tag}-`))
  const recordsDir = join(dir, 'records')
  const runDir = join(dir, 'workflow-state')
  mkdirSync(recordsDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  return { dir, recordsDir, runDir }
}

function rmWorld(world: World): void {
  rmSync(world.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/** run 域合法事件序列（写入序，seq 单调）：created → 2 ask → 1 settled → run settled。 */
function runSequence(): SubagentJournalEvent[] {
  return [
    { type: 'run-created', runId: 'wf-1', workflowName: 'flow', argsSummary: '', ts: 1000, seq: 1 },
    { type: 'agent-started', taskIndex: 0, agentName: 'w1', attempt: 1, phase: 'impl', ts: 1100, seq: 2 },
    { type: 'agent-started', taskIndex: 1, agentName: 'w2', attempt: 1, ts: 1200, seq: 3 },
    { type: 'agent-settled', taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 700, ts: 1900, seq: 4 },
    { type: 'phase-settled', phase: 'impl', ts: 1950, seq: 5 },
    { type: 'run-settled', outcome: 'done', artifactsDir: '/tmp/a', ts: 2000, seq: 6 },
  ]
}

/** record 域合法事件序列（写入序）：created → bound → round-idle → settled。 */
function recordSequence(id: string): SubagentJournalEvent[] {
  return [
    { type: 'record-created', seq: 1, ts: 1000, id, agent: 'worker', task: 'Do work', slug: 'work', origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, mode: 'background', startedAt: 1000 },
    { type: 'record-bound', seq: 2, ts: 1500, id, sessionFile: '/sub/sa-1.jsonl', epoch: 0 },
    { type: 'record-round-idle', seq: 3, ts: 2500, id, round: 1, epoch: 0, stopReason: 'completed', turns: 2, totalTokens: 500 },
    { type: 'record-settled', seq: 4, ts: 3000, id, stopReason: 'completed', endedAt: 3000, turns: 2, totalTokens: 500 },
  ]
}

const workflowRegisteredEntry = {
  type: 'custom',
  customType: 'workflow-record',
  data: {
    v: 2, kind: 'registered', runId: 'wf-1', workflowName: 'flow', scriptName: 'flow',
    slug: 'flow', startedAt: 1000, recordPath: '/tmp/ws/wf-1.record.jsonl',
  },
}

const subagentRegisteredEntry = {
  type: 'custom',
  customType: 'subagent-record',
  data: {
    v: 2, kind: 'registered', id: 'sa-1', agent: 'worker', task: 'Do work', slug: 'work',
    origin: 'workflow', parentRunId: 'wf-1', stepIndex: 0, rootSessionId: 's1', depth: 0, startedAt: 1000,
  },
}

const subagentSettledEntry = {
  type: 'custom',
  customType: 'subagent-record',
  data: {
    v: 2, kind: 'settled', id: 'sa-1', status: 'idle', stopReason: 'completed', endedAt: 3000,
    turns: 2, totalTokens: 500,
  },
}

function report(domain: 'run' | 'record', fileKey: string, events: readonly SubagentJournalEvent[]): SubagentJournalReport {
  return { domain, fileKey, events: [...events], sessionId: 's1', emittedAt: 42 }
}

function makeProjection(world: World, onChange: () => void = () => {}): SessionEventProjection {
  return new SessionEventProjection({
    sessionId: 's1',
    recordsDir: world.recordsDir,
    runJournalDir: world.runDir,
    onProjectionChange: onChange,
  })
}

// ── ① 推送-补读等价性 ─────────────────────────────────────────

describe('推送-补读等价性（喂入源换轨，派生视图终态不变）', () => {
  it('run 域：纯推送 ≡ 推送+缺口补读混合 ≡ 纯文件冷读（合并快照逐字段一致）', () => {
    const events = runSequence()
    const worldPure = makeWorld('run-pure')
    // b. 推送+缺口补读混合：丢帧 1-3（seq 缺口可见）→ 帧 4 的报告触发从字节偏移补读
    const worldGap = makeWorld('run-gap')
    // c. 纯文件冷读（恢复路径）：attach() 从 0 全量读
    const worldCold = makeWorld('run-cold')
    try {
      // a. 纯推送：先落盘（写侧纪律 = 先写后推），再逐帧推送
      writeFileSync(join(worldPure.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const projection = makeProjection(worldPure)
      projection.applyEntryBatch([workflowRegisteredEntry])
      for (const event of events) {
        expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
      }
      const pure = projection.workflows.get('wf-1')
      projection.dispose()

      writeFileSync(join(worldGap.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const gapProjection = makeProjection(worldGap)
      gapProjection.applyEntryBatch([workflowRegisteredEntry])
      // 冷读 1 条（帧 1 推送成功并推进偏移）后通道断：帧 2-5 丢失
      expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[0]!]))).toBe(true)
      // 通道恢复：帧 5（seq 5 > 水位 1+1）触发缺口补读——从偏移读到文件尾，覆盖 2-5
      expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[4]!]))).toBe(true)
      // 帧 6 照常推送（seq 连续性已由补读恢复）
      expect(gapProjection.applyJournalReport(report('run', 'wf-1', [events[5]!]))).toBe(true)
      const gapMixed = gapProjection.workflows.get('wf-1')
      gapProjection.dispose()

      writeFileSync(join(worldCold.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const coldProjection = makeProjection(worldCold)
      coldProjection.applyEntryBatch([workflowRegisteredEntry])
      coldProjection.attach()
      const cold = coldProjection.workflows.get('wf-1')
      coldProjection.dispose()

      expect(pure).not.toBeNull()
      expect(gapMixed).toEqual(pure)
      expect(cold).toEqual(pure)
      // 终态语义锚：事件 fold 定 run 终局与步骤状态（等价性比较的具体锚点）
      expect(pure).toMatchObject({ runId: 'wf-1', status: 'done', outcome: 'done' })
    } finally {
      rmWorld(worldPure)
      rmWorld(worldGap)
      rmWorld(worldCold)
    }
  })

  it('record 域：纯推送 ≡ 推送+缺口补读混合 ≡ 纯文件冷读（合并快照逐字段一致）', () => {
    const events = recordSequence('sa-1')
    const worldPure = makeWorld('rec-pure')
    const worldGap = makeWorld('rec-gap')
    const worldCold = makeWorld('rec-cold')
    try {
      writeFileSync(join(worldPure.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        ...events.map((e) => JSON.stringify(e)),
      ].join('\n') + '\n')
      const projection = makeProjection(worldPure)
      projection.applyEntryBatch([subagentRegisteredEntry])
      for (const event of events) {
        expect(projection.applyJournalReport(report('record', 'sa-1', [event]))).toBe(true)
      }
      const pure = projection.subagents.get('sa-1')
      projection.dispose()

      // 混合：帧 2-3 丢失 → 帧 4 报告（seq 4 > 水位 1+1）触发补读覆盖 2-4
      writeFileSync(join(worldGap.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        ...events.map((e) => JSON.stringify(e)),
      ].join('\n') + '\n')
      const gapProjection = makeProjection(worldGap)
      gapProjection.applyEntryBatch([subagentRegisteredEntry])
      expect(gapProjection.applyJournalReport(report('record', 'sa-1', [events[0]!]))).toBe(true)
      expect(gapProjection.applyJournalReport(report('record', 'sa-1', [events[3]!]))).toBe(true)
      const gapMixed = gapProjection.subagents.get('sa-1')
      gapProjection.dispose()

      writeFileSync(join(worldCold.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        ...events.map((e) => JSON.stringify(e)),
      ].join('\n') + '\n')
      const coldProjection = makeProjection(worldCold)
      coldProjection.applyEntryBatch([subagentRegisteredEntry])
      coldProjection.attach()
      const cold = coldProjection.subagents.get('sa-1')
      coldProjection.dispose()

      expect(pure).not.toBeNull()
      expect(gapMixed).toEqual(pure)
      expect(cold).toEqual(pure)
      expect(pure).toMatchObject({ subagentId: 'sa-1', status: 'idle', stopReason: 'completed' })
    } finally {
      rmWorld(worldPure)
      rmWorld(worldGap)
      rmWorld(worldCold)
    }
  })
})

// ── ② 断连收敛 ────────────────────────────────────────────────

describe('断连收敛（pi 进程死亡 → 重开 session → 冷读收敛）', () => {
  it('推送喂入中断后丢失的增量，由重开投影的 attach() 冷读收敛到同一终态', () => {
    const events = runSequence()
    const world = makeWorld('reconnect')
    try {
      // 活体期：推送喂入前 3 帧，pi 进程死亡（后 3 帧已落盘但推送丢失——写侧缓冲即弃）
      writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const liveProjection = makeProjection(world)
      liveProjection.applyEntryBatch([workflowRegisteredEntry])
      for (const event of events.slice(0, 3)) {
        expect(liveProjection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
      }
      const liveAtDeath = liveProjection.workflows.get('wf-1')
      expect(liveAtDeath).toMatchObject({ status: 'running' }) // 中断窗口：步骤 1 在飞
      liveProjection.dispose()

      // 重开 session：新投影冷读（既有进程退出链 → 恢复横幅 → 派生视图重建）
      const reopened = makeProjection(world)
      reopened.applyEntryBatch([workflowRegisteredEntry])
      reopened.attach()
      const recovered = reopened.workflows.get('wf-1')
      reopened.dispose()

      // 收敛终态 = 纯冷读终态（journal 是事实源；推送丢失面被恢复读覆盖）
      const cold = makeProjection(world)
      cold.applyEntryBatch([workflowRegisteredEntry])
      cold.attach()
      const coldState = cold.workflows.get('wf-1')
      cold.dispose()
      expect(recovered).toEqual(coldState)
      expect(recovered).toMatchObject({ status: 'done', outcome: 'done' })
    } finally {
      rmWorld(world)
    }
  })
})

// ── ③ 终局条目补读触发 ────────────────────────────────────────

describe('终局条目补读触发（D6：entry 通道晚于 fold → 一次补读收敛）', () => {
  it('run 域：run-settled 推送丢失且无后续事件 → 终态条目到达触发补读，run 投影翻 done', () => {
    const events = runSequence()
    const world = makeWorld('final-run')
    try {
      // 磁盘有完整序列（终局事件已落盘），但推送只送达前 3 帧——run-settled 推送
      // 失败且该文件再无新事件（seq 缺口不会被后续推送暴露的场景）
      writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const projection = makeProjection(world)
      projection.applyEntryBatch([workflowRegisteredEntry])
      for (const event of events.slice(0, 3)) {
        expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
      }
      expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'running' })

      // 终态条目经 entry 通道到达（settledAt=2000 晚于 fold 末事件 ts=1200）→
      // recompute 判定「fold 落后于条目通道」→ 一次补读 → fold 收敛 done
      projection.applyEntryBatch([workflowRegisteredEntry, {
        type: 'custom',
        customType: 'workflow-record',
        data: {
          v: 2, kind: 'settled', runId: 'wf-1', status: 'done', reason: 'completed',
          outcome: 'done', settledAt: 2000, callCount: 2, usedTokens: 800,
        },
      }])
      expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })

      // 同一条目时点只触发一次（attempted 水位——重复 entry 批不引发重复读放大：
      // 幂等性以终态不变表达）
      projection.applyEntryBatch([workflowRegisteredEntry])
      expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })
      projection.dispose()
    } finally {
      rmWorld(world)
    }
  })

  it('record 域：record-settled 推送丢失 → 终态条目到达触发补读，subagent 投影翻 idle', () => {
    const events = recordSequence('sa-1')
    const world = makeWorld('final-record')
    try {
      writeFileSync(join(world.recordsDir, 'sa-1.events'), [
        JSON.stringify({ type: 'record-events', id: 'sa-1' }),
        ...events.map((e) => JSON.stringify(e)),
      ].join('\n') + '\n')
      const projection = makeProjection(world)
      projection.applyEntryBatch([subagentRegisteredEntry])
      for (const event of events.slice(0, 2)) {
        expect(projection.applyJournalReport(report('record', 'sa-1', [event]))).toBe(true)
      }
      expect(projection.subagents.get('sa-1')).toMatchObject({ status: 'running' })

      // 终态条目到达（endedAt=3000 晚于 fold 末事件 ts=1500）→ 补读 → idle
      projection.applyEntryBatch([subagentRegisteredEntry, subagentSettledEntry])
      expect(projection.subagents.get('sa-1')).toMatchObject({ status: 'idle', stopReason: 'completed' })
      projection.dispose()
    } finally {
      rmWorld(world)
    }
  })

  it('终局事件行已在 fold（推送正常收敛）时条目到达不触发补读（判据收敛态短路）', () => {
    const events = runSequence()
    const world = makeWorld('final-converged')
    try {
      writeFileSync(join(world.runDir, 'wf-1.record.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const projection = makeProjection(world)
      projection.applyEntryBatch([workflowRegisteredEntry])
      for (const event of events) {
        expect(projection.applyJournalReport(report('run', 'wf-1', [event]))).toBe(true)
      }
      expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done' })

      // 条目晚到（正常时序）：runSettled 已 fold → 判据短路，无补读（终态不变）
      projection.applyEntryBatch([workflowRegisteredEntry, {
        type: 'custom',
        customType: 'workflow-record',
        data: {
          v: 2, kind: 'settled', runId: 'wf-1', status: 'done', reason: 'completed',
          outcome: 'done', settledAt: 2000, callCount: 2, usedTokens: 800,
        },
      }])
      expect(projection.workflows.get('wf-1')).toMatchObject({ status: 'done', outcome: 'done' })
      projection.dispose()
    } finally {
      rmWorld(world)
    }
  })
})
