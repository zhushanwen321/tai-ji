/**
 * 信号取证测试（infra/pi/signal-forensics.ts + process-table-ring.ts；2026-10-13
 * 01a132f3 外部 SIGTERM 事故的归因面）。
 *
 * 锁定：
 * - parseProcessTable：ps 行解析（pid/ppid/command 含空格原样；非数据行跳过）；
 * - guessSignalFromExitCode：128+n 约定（143→SIGTERM / 137→SIGKILL / 129→SIGHUP），
 *   非信号码（0/1/null）恒 null（不知道 ≠ 瞎猜）；
 * - ProcessTableRing：有界淘汰（超出容量丢最旧）、窗口边界（闭区间）、sample() 对
 *   listProcesses 失败吞错返回 false 且 failures 计数、start/stop 幂等、
 *   intervalMs=0 = 机制禁用（start no-op）；
 * - classifySenders：vanished（窗口在场 ∧ 新快照不在场）、suspiciousPresent 只收
 *   启发式 tier（kill-tool/pi-reference/shell，'other' 不进 present 但消失仍进
 *   vanished）、排除集（ownPid/deadPid/INIT_PID）、siblings 连坐视图、
 *   freshRows=null 降级（两桶空 + freshSnapshotAvailable=false）；
 * - captureSignalForensics：编排全链（环历史 diff + lstart 补采 + journal 事件字段 +
 *   detailPath）；新快照失败降级不抛；
 * - reportPiExitSignalForensics：logger 门控两态——未启用结构性 no-op（无落点不采样），
 *   启用时真实采集落盘（生效态同时是 mock 路径正确性的对照面：no-op 态真门控也关，
 *   无法区分死 mock）；
 * - writeForensicsDetailFile：真实写 tmp 数据目录，返回相对 detailPath。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/signal-forensics.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'

/** logger 门控可翻转（reportPiExitSignalForensics 的 no-op / 生效两态测试）。 */
const loggerGate = vi.hoisted(() => ({ enabled: false }))
// SUT（infra/pi/signal-forensics.ts）import 的 '../logger.js' 从 infra/pi/ 出发 =
// infra/logger.ts；本文件在 __tests__/ 一层，mock 必须以 '../../logger.js' 指向同一
// 模块——写浅一层会解析到不存在的 infra/pi/logger.ts，成为死 mock（门控静默失效）。
vi.mock('../../logger.js', () => ({
  isPiCrashLogEnabled: () => loggerGate.enabled,
}))

/** 生效态测试替身：reportPiExitSignalForensics 硬接线真实 listAllProcesses，经模块 mock 注入。 */
const listAllProcessesStub = vi.hoisted(() => vi.fn<() => Promise<string>>())
vi.mock('../process-table-ring.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../process-table-ring.js')>()
  return { ...actual, listAllProcesses: listAllProcessesStub }
})

import {
  buildDigest,
  captureSignalForensics,
  classifySenders,
  commandTier,
  guessSignalFromExitCode,
  reportPiExitSignalForensics,
  writeForensicsDetailFile,
  type SignalForensicsRecord,
} from '../signal-forensics.js'
import {
  ProcessTableRing,
  parseProcessTable,
  type ProcessRow,
} from '../process-table-ring.js'

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

const OWN_PID = 64_900
const DEAD_PID = 11_111
const SIBLING_PID = 22_222
const KILLER_PID = 42_424
const T0 = 1_791_856_000_000 // 固定时钟（2026-10-13 01:51:40Z 附近）

function row(pid: number, ppid: number, command: string): ProcessRow {
  return { pid, ppid, command }
}

/** 拼一帧 ps 原始输出（`ps -axo pid=,ppid=command=` 形态）。 */
function psStdout(rows: ProcessRow[]): string {
  return rows.map(r => `${r.pid} ${r.ppid} ${r.command}`).join('\n') + '\n'
}

/** 死亡前窗口样本里的进程表（含短命发送方 + 兄弟 pi + 噪声）。 */
function preDeathRows(): ProcessRow[] {
  return [
    row(OWN_PID, 1, '/Applications/TaiJi.app/Contents/MacOS/TaiJi runtime/index.cjs --port=3210'),
    row(DEAD_PID, OWN_PID, '/Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --no-extensions'),
    row(SIBLING_PID, OWN_PID, '/Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --no-extensions'),
    row(KILLER_PID, 33_333, '/bin/zsh -c kill -TERM 11111'),
    row(55_555, 1, '/usr/sbin/mds_stores'),
  ]
}

/** 死亡即时新快照（发送方 42424 已消失；兄弟 pi 幸存；runtime 与噪声仍在）。 */
function freshRows(): ProcessRow[] {
  return preDeathRows().filter(r => r.pid !== KILLER_PID && r.pid !== DEAD_PID)
}

/** 建一个已推入死亡前样本的环（intervalMs=0 禁定时器，纯手动采样）。 */
function ringWithPreDeathSample(at: number = T0 - 1_000): ProcessTableRing {
  const ring = new ProcessTableRing({ intervalMs: 0, now: () => T0 })
  ring.push(psStdout(preDeathRows()), at)
  return ring
}

function makeJournal(): CrashJournalWriter & { append: ReturnType<typeof vi.fn> } {
  return { append: vi.fn() } as unknown as CrashJournalWriter & { append: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  loggerGate.enabled = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// 解析与信号推测
// ─────────────────────────────────────────────────────────────────────────────

describe('parseProcessTable', () => {
  it('解析 pid/ppid/command（command 含空格原样保留）', () => {
    const rows = parseProcessTable(psStdout(preDeathRows()))
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual(row(OWN_PID, 1, '/Applications/TaiJi.app/Contents/MacOS/TaiJi runtime/index.cjs --port=3210'))
  })

  it('非数据行（空行/表头/非数字）跳过', () => {
    const rows = parseProcessTable('  PID PPID COMMAND\n\nnot-a-row\n  12 34 /bin/sh\n')
    expect(rows).toEqual([row(12, 34, '/bin/sh')])
  })
})

describe('guessSignalFromExitCode', () => {
  it('128+n 约定映射（macOS 信号编号）', () => {
    expect(guessSignalFromExitCode(143)).toBe('SIGTERM')
    expect(guessSignalFromExitCode(137)).toBe('SIGKILL')
    expect(guessSignalFromExitCode(129)).toBe('SIGHUP')
    expect(guessSignalFromExitCode(130)).toBe('SIGINT')
  })

  it('非信号约定码恒 null（0/1/null/未知码）', () => {
    expect(guessSignalFromExitCode(0)).toBeNull()
    expect(guessSignalFromExitCode(1)).toBeNull()
    expect(guessSignalFromExitCode(null)).toBeNull()
    expect(guessSignalFromExitCode(undefined)).toBeNull()
    expect(guessSignalFromExitCode(200)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 进程表环
// ─────────────────────────────────────────────────────────────────────────────

describe('ProcessTableRing', () => {
  it('容量有界：超出淘汰最旧', () => {
    const ring = new ProcessTableRing({ intervalMs: 0, capacity: 3 })
    for (let i = 1; i <= 5; i++) ring.push(psStdout([row(i, 1, `cmd-${i}`)]), T0 + i)
    expect(ring.size).toBe(3)
    // 仅剩最后 3 帧（pid 3/4/5）；最早 2 帧被淘汰
    const window = ring.samplesInWindow(T0, T0 + 10)
    expect(window.map(s => [...s.rows.keys()])).toEqual([[3], [4], [5]])
    expect(ring.samplesInWindow(T0, T0 + 2)).toHaveLength(0)
  })

  it('窗口闭区间边界（fromAt/toAt 含端点）', () => {
    const ring = new ProcessTableRing({ intervalMs: 0, capacity: 10 })
    ring.push(psStdout([row(1, 1, 'a')]), T0)
    ring.push(psStdout([row(2, 1, 'b')]), T0 + 1_000)
    ring.push(psStdout([row(3, 1, 'c')]), T0 + 2_000)
    const window = ring.samplesInWindow(T0, T0 + 1_000)
    expect(window).toHaveLength(2)
    expect([...window[1].rows.keys()]).toEqual([2])
  })

  it('sample() 对 listProcesses 失败吞错返回 false 并累计 failures；成功清零', async () => {
    let fail = true
    const ring = new ProcessTableRing({
      intervalMs: 0,
      listProcesses: async () => {
        if (fail) throw new Error('ps unavailable')
        return psStdout([row(1, 1, 'ok')])
      },
    })
    expect(await ring.sample()).toBe(false)
    expect(await ring.sample()).toBe(false)
    expect(ring.failures).toBe(2)
    fail = false
    expect(await ring.sample()).toBe(true)
    expect(ring.failures).toBe(0)
    expect(ring.size).toBe(1)
  })

  it('start/stop 幂等；intervalMs=0 时 start 为 no-op（机制禁用）', () => {
    const ring = new ProcessTableRing({ intervalMs: 0 })
    ring.start()
    expect(ring.running).toBe(false)
    ring.stop() // 幂等不抛
    expect(ring.running).toBe(false)

    const live = new ProcessTableRing({ intervalMs: 60_000, listProcesses: async () => psStdout([]) })
    live.start()
    expect(live.running).toBe(true)
    live.start() // 重复 start 不叠加定时器
    expect(live.running).toBe(true)
    live.stop()
    expect(live.running).toBe(false)
  })

  it('stop 后样本保留（死亡转储仍可消费历史）', () => {
    const ring = ringWithPreDeathSample()
    ring.stop()
    expect(ring.size).toBe(1)
    expect(ring.samplesInWindow(T0 - 30_000, T0)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 候选发送方分类
// ─────────────────────────────────────────────────────────────────────────────

describe('commandTier', () => {
  it('kill 族工具优先于 shell 分层', () => {
    expect(commandTier('/bin/zsh -c kill -TERM 111')).toBe('kill-tool')
    expect(commandTier('pkill -f pi-darwin-arm64')).toBe('kill-tool')
    expect(commandTier('killall TaiJi')).toBe('kill-tool')
  })

  it('pi 引用 / 交互 shell / 其他', () => {
    expect(commandTier('node /opt/supervise-pi.js --mode rpc')).toBe('pi-reference')
    expect(commandTier('/usr/bin/zsh')).toBe('shell')
    expect(commandTier('/bin/bash -c echo hi')).toBe('shell')
    expect(commandTier('/usr/sbin/mds_stores')).toBe('other')
  })

  it('禁子串误命中（skill/keeper 等不含词边界 kill）', () => {
    expect(commandTier('node skill-server.js')).toBe('other')
    expect(commandTier('/usr/libexec/gatekeeperd')).toBe('other')
  })
})

describe('classifySenders', () => {
  it('vanished = 窗口在场 ∧ 新快照不在场（短命发送方指纹）', () => {
    const result = classifySenders({
      ring: ringWithPreDeathSample(),
      freshRows: freshRows(),
      deathAt: T0,
      ownPid: OWN_PID,
      deadPid: DEAD_PID,
      managedPids: [SIBLING_PID],
    })
    expect(result.freshSnapshotAvailable).toBe(true)
    expect(result.vanished.map(c => c.pid)).toEqual([KILLER_PID])
    const killer = result.vanished[0]
    expect(killer.tier).toBe('kill-tool')
    expect(killer.vanished).toBe(true)
    expect(killer.ppid).toBe(33_333)
    // 常驻噪声（mds_stores，tier=other 且仍存活）不进 present 桶
    expect(result.suspiciousPresent.map(c => c.pid)).toEqual([])
    // 连坐视图：兄弟 pi 幸存
    expect(result.siblings).toEqual([{ pid: SIBLING_PID, aliveAtDeath: true }])
  })

  it('suspiciousPresent 只收启发式命中的存活进程', () => {
    const rows = freshRows().concat([
      row(66_666, 1, '/usr/bin/zsh'), // 常驻 shell：仍存活 + shell tier → present
      row(77_777, 1, '/usr/sbin/mds_stores'), // 存活 + other → 不进
    ])
    const result = classifySenders({
      ring: ringWithPreDeathSample(),
      freshRows: rows,
      deathAt: T0,
      ownPid: OWN_PID,
      deadPid: DEAD_PID,
      managedPids: [SIBLING_PID],
    })
    expect(result.suspiciousPresent.map(c => c.pid)).toEqual([66_666])
  })

  it('排除集：runtime 自身 / 死亡 pi 自身 / INIT_PID 不进候选', () => {
    const result = classifySenders({
      ring: ringWithPreDeathSample(),
      freshRows: [], // 全新快照全空 → 窗口内所有进程都「消失」
      deathAt: T0,
      ownPid: OWN_PID,
      deadPid: DEAD_PID,
    })
    const pids = result.vanished.map(c => c.pid)
    expect(pids).not.toContain(OWN_PID)
    expect(pids).not.toContain(DEAD_PID)
    expect(pids).not.toContain(1)
    // 幸存 pi（无 managedPids 传入时不在排除集）与噪声按 tier 排序：shell/kill 族在前
    expect(result.vanished.map(c => c.tier)).toEqual(['kill-tool', 'pi-reference', 'other'])
  })

  it('freshRows=null 降级：两桶空 + freshSnapshotAvailable=false，不抛', () => {
    const result = classifySenders({
      ring: ringWithPreDeathSample(),
      freshRows: null,
      deathAt: T0,
      ownPid: OWN_PID,
      deadPid: DEAD_PID,
      managedPids: [SIBLING_PID],
    })
    expect(result.freshSnapshotAvailable).toBe(false)
    expect(result.vanished).toEqual([])
    expect(result.suspiciousPresent).toEqual([])
    expect(result.siblings).toEqual([{ pid: SIBLING_PID, aliveAtDeath: false }])
    expect(result.samplesInWindow).toBe(1)
  })

  it('窗口外样本不计入（早于 windowFromAt 的进程被忽略）', () => {
    const ring = new ProcessTableRing({ intervalMs: 0, now: () => T0 })
    ring.push(psStdout([row(88_888, 1, '/bin/zsh')]), T0 - 60_000) // 窗口（30s）外
    ring.push(psStdout([row(99_999, 1, '/bin/zsh')]), T0 - 1_000) // 窗口内
    const result = classifySenders({
      ring,
      freshRows: [],
      deathAt: T0,
      ownPid: OWN_PID,
      windowMs: 30_000,
    })
    const pids = result.vanished.map(c => c.pid)
    expect(pids).toContain(99_999)
    expect(pids).not.toContain(88_888)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 编排：captureSignalForensics
// ─────────────────────────────────────────────────────────────────────────────

describe('captureSignalForensics', () => {
  it('全链：vanished 归因 + lstart 补采 + journal 事件字段 + detailPath', async () => {
    const journal = makeJournal()
    const detailPath = 'logs/signal-forensics-2026-10-13-sess-1.jsonl'
    const writeDetailFile = vi.fn(() => detailPath)
    const readProcessStartTime = vi.fn(async (pid: number) => (pid === KILLER_PID ? T0 - 2_000 : null))

    const result = await captureSignalForensics(
      {
        sessionId: 'sess-1',
        deadPid: DEAD_PID,
        exitCode: 143,
        uptimeMs: 137_110,
        managedPids: [SIBLING_PID],
      },
      {
        ring: ringWithPreDeathSample(),
        ownPid: OWN_PID,
        listProcesses: async () => psStdout(freshRows()),
        readProcessStartTime,
        journal,
        writeDetailFile,
        now: () => T0,
      },
    )

    // 记录面
    expect(result.record.signalGuess).toBe('SIGTERM')
    expect(result.record.exitCode).toBe(143)
    expect(result.record.uptimeMs).toBe(137_110)
    expect(result.record.vanishedSenders.map(c => c.pid)).toEqual([KILLER_PID])
    // lstart 补采命中头部候选：启动时刻（T0-2s）贴近死亡时刻 = 强信号
    expect(readProcessStartTime).toHaveBeenCalledWith(KILLER_PID)
    expect(result.record.vanishedSenders[0].startedAt).toBe(T0 - 2_000)
    expect(result.record.siblingPis).toEqual([{ pid: SIBLING_PID, aliveAtDeath: true }])
    expect(result.record.note).toContain('vanished candidates')

    // 落盘断言
    expect(result.detailPath).toBe(detailPath)
    expect(writeDetailFile).toHaveBeenCalledTimes(1)
    expect(result.journalAppended).toBe(true)
    const event = journal.append.mock.calls[0][0] as CrashJournalEvent
    expect(event.layer).toBe('pi')
    expect(event.event).toBe('signal-forensics')
    expect(event.sessionId).toBe('sess-1')
    expect(event.pid).toBe(DEAD_PID)
    expect(event.ppid).toBe(OWN_PID)
    expect(event.exitCode).toBe(143)
    expect(event.uptimeSec).toBe(137) // 137110ms → 137s（round）
    expect(event.detailPath).toBe(detailPath)
    expect(event.detailDigest).toContain('SIGTERM')
    expect((event.detailDigest ?? '').length).toBeLessThanOrEqual(2_000)
  })

  it('新快照失败降级：freshSnapshotAvailable=false，两桶空，仍落盘不抛', async () => {
    const journal = makeJournal()
    const result = await captureSignalForensics(
      { sessionId: 'sess-2', deadPid: DEAD_PID, exitCode: 143 },
      {
        ring: ringWithPreDeathSample(),
        ownPid: OWN_PID,
        listProcesses: async () => { throw new Error('ps unavailable') },
        journal,
        writeDetailFile: () => null,
        now: () => T0,
      },
    )
    expect(result.record.freshSnapshotAvailable).toBe(false)
    expect(result.record.vanishedSenders).toEqual([])
    expect(result.record.note).toContain('unavailable')
    expect(result.detailPath).toBeNull()
    expect(result.journalAppended).toBe(true)
    const event = journal.append.mock.calls[0][0] as CrashJournalEvent
    expect(event.detailPath).toBeNull()
    expect(event.detailDigest).toContain('unavailable')
  })

  it('不注入 journal / writeDetailFile 时不落盘也不抛', async () => {
    const result = await captureSignalForensics(
      { sessionId: 'sess-3', deadPid: null, exitCode: null },
      {
        ring: new ProcessTableRing({ intervalMs: 0, now: () => T0 }),
        ownPid: OWN_PID,
        listProcesses: async () => psStdout(freshRows()),
        now: () => T0,
      },
    )
    expect(result.journalAppended).toBe(false)
    expect(result.detailPath).toBeNull()
    // deadPid=null / exitCode=null 形态（client 未暴露 pid）：signalGuess null 不瞎猜
    expect(result.record.deadPid).toBeNull()
    expect(result.record.signalGuess).toBeNull()
  })
})

describe('buildDigest', () => {
  it('≤2KB 且含关键归因字段', () => {
    const record: SignalForensicsRecord = {
      ts: new Date(T0).toISOString(),
      sessionId: 'sess-1',
      deadPid: DEAD_PID,
      exitCode: 143,
      signalGuess: 'SIGTERM',
      uptimeMs: 137_110,
      runtimePid: OWN_PID,
      windowMs: 30_000,
      samplesInWindow: 20,
      freshSnapshotAvailable: true,
      vanishedSenders: [{
        pid: KILLER_PID, ppid: 33_333, command: '/bin/zsh -c kill -TERM 11111',
        firstSeenAt: T0 - 5_000, lastSeenAt: T0 - 1_000, vanished: true,
        tier: 'kill-tool', startedAt: T0 - 2_000,
      }],
      suspiciousPresent: [],
      siblingPis: [{ pid: SIBLING_PID, aliveAtDeath: true }],
      note: 'vanished candidates existed within the pre-death window',
    }
    const digest = buildDigest(record)
    expect(digest.length).toBeLessThanOrEqual(2_000)
    const parsed = JSON.parse(digest) as Record<string, unknown>
    expect(parsed.signalGuess).toBe('SIGTERM')
    expect(parsed.vanishedCount).toBe(1)
    expect(parsed.topVanished).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 生产入口与 detail 文件
// ─────────────────────────────────────────────────────────────────────────────

describe('reportPiExitSignalForensics', () => {
  it('logger 未启用时结构性 no-op（无落点不采样，不写任何文件）', async () => {
    loggerGate.enabled = false
    const dataDir = mkdtempSync(join(tmpdir(), 'sigf-gate-'))
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      reportPiExitSignalForensics({
        sessionId: 'sess-gate',
        deadPid: DEAD_PID,
        exitCode: 143,
        ring: ringWithPreDeathSample(),
      })
      await new Promise(r => setTimeout(r, 50))
      // no-op = 连 logs 目录都不创建（writeForensicsDetailFile 的 mkdir 未被触达）
      expect(existsSync(join(dataDir, 'logs'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('logger 启用时真实采集落盘（gate 生效态，对照面证明 mock 真实拦截）', async () => {
    loggerGate.enabled = true
    listAllProcessesStub.mockResolvedValue(psStdout(freshRows()))
    // report 入口不注入 now：归因窗口相对真实时钟计算，环样本须压在真实 deathAt 窗口内
    const deathAt = Date.now()
    const ring = new ProcessTableRing({ intervalMs: 0, now: () => deathAt })
    ring.push(psStdout(preDeathRows()), deathAt - 1_000)
    const dataDir = mkdtempSync(join(tmpdir(), 'sigf-enabled-'))
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      reportPiExitSignalForensics({
        sessionId: 'sess-enabled',
        deadPid: DEAD_PID,
        exitCode: 143,
        ring,
      })
      await vi.waitFor(() => {
        expect(readdirSync(join(dataDir, 'logs')).some(f => f.startsWith('signal-forensics-'))).toBe(true)
      })
      const fileName = readdirSync(join(dataDir, 'logs')).find(f => f.startsWith('signal-forensics-'))
      expect(fileName).toBeDefined()
      expect(fileName).toContain('sess-enabled')
      const written = JSON.parse(readFileSync(join(dataDir, 'logs', fileName!), 'utf8').trim()) as SignalForensicsRecord
      expect(written.sessionId).toBe('sess-enabled')
      expect(written.signalGuess).toBe('SIGTERM')
      // 环 diff 真实执行：死亡前窗口在场的发送方在替身快照中缺席 → vanished
      expect(written.vanishedSenders.map(c => c.pid)).toContain(KILLER_PID)
    } finally {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('writeForensicsDetailFile', () => {
  it('真实写 tmp 数据目录并返回相对 detailPath（append JSONL）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sigf-detail-'))
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      const record: SignalForensicsRecord = {
        ts: '2026-10-13T01:51:49.501Z',
        sessionId: 'sess-detail',
        deadPid: DEAD_PID,
        exitCode: 143,
        signalGuess: 'SIGTERM',
        uptimeMs: 137_110,
        runtimePid: OWN_PID,
        windowMs: 30_000,
        samplesInWindow: 20,
        freshSnapshotAvailable: true,
        vanishedSenders: [],
        suspiciousPresent: [],
        siblingPis: [],
        note: 'no vanished processes in the pre-death window',
      }
      const detailPath = writeForensicsDetailFile(record)
      expect(detailPath).toBe('logs/signal-forensics-2026-10-13-sess-detail.jsonl')
      const written = JSON.parse(readFileSync(join(dataDir, detailPath!), 'utf8').trim()) as SignalForensicsRecord
      expect(written.sessionId).toBe('sess-detail')
      expect(written.signalGuess).toBe('SIGTERM')

      // append 语义：第二次死亡追加一行不覆盖
      writeForensicsDetailFile(record)
      const lines = readFileSync(join(dataDir, detailPath!), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
    } finally {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('sessionId 含非法字符时文件名安全化', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sigf-safe-'))
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    try {
      const detailPath = writeForensicsDetailFile({
        ts: '2026-10-13T01:51:49.501Z',
        sessionId: '../../etc/passwd',
        deadPid: null, exitCode: null, signalGuess: null, uptimeMs: null,
        runtimePid: OWN_PID, windowMs: 30_000, samplesInWindow: 0,
        freshSnapshotAvailable: false, vanishedSenders: [], suspiciousPresent: [],
        siblingPis: [], note: 'x',
      })
      expect(detailPath).toBe('logs/signal-forensics-2026-10-13-etcpasswd.jsonl')
    } finally {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
