/**
 * 孤儿收殓 → 崩溃台账 reaped 事件接线测试（crash-forensics-and-watchdog §3.3 D1
 * reaped 行，实施单元 u1d2）。
 *
 * 锁定（验收条款逐条对照）：
 * - ① 判据命中处置成功 → 台账 reaped 事件：layer=pi、结构化 pid/ppid、detailDigest
 *   内嵌 argv 判据摘要（v2 marker 判据：argv 匹配 spawn 清单 + ppid=1 + argv 头部）。
 * - ④ 防误记：判据未命中（ppid≠1 / marker 清单外值）零事件；处置失败（SIGTERM
 *   非 ESRCH 错误）不记 reaped。
 *
 * 台账走真实 writer（initCrashJournal → mkdtemp tmp 目录 → closeCrashJournal 确定性
 * flush 后逐行 JSON.parse），顺带锁住「writer spread 序列化保留 schema 外扩展字段
 * （pid/ppid）」的行为——mock 断言不到落盘形态。收殓依赖全部 fake 注入（零真实
 * ps/信号/延时），写删目标全部 mkdtemp 自建自删（fs-guard 合规）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/reap-orphan-pi.journal.test.ts
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCrashJournal, initCrashJournal } from '../infra/crash-journal.js'
import { reapOrphanPiProcesses, ORPHAN_KILL_GRACE_MS, type PsRow, type ReapOrphanOptions } from './reap-orphan-pi.js'

const DATA_DIR = '/Users/tester/.taiji'
const OWN_PID = 100
/** spawn 清单值（判据 v2：argv --extension 值与清单精确相等；形态对齐 reap-orphan-pi.test MARKERS）。 */
const MARKER = '/Applications/TaiJi.app/Contents/Resources/extensions/pi-agent-ext'

let dataDir: string
const createdDirs: string[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reap-journal-'))
  createdDirs.push(dataDir)
})

afterAll(() => {
  // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争的
  // ENOTEMPTY 瞬态重试（pre-commit flake 卫生检查硬要求）
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** taiji spawn 的 pi 典型 argv（判据 v2 形态：--mode rpc + --no-extensions + --extension 注入段）。 */
function piCmd(extensionPath: string = MARKER): string {
  return `/opt/pi/pi --mode rpc --no-extensions --approve --extension ${extensionPath}`
}

function row(pid: number, ppid: number, command: string): PsRow {
  return { pid, ppid, command }
}

/** ESRCH 错误（signal 0 探活对已死 pid 的 errno 形态）。 */
function esrch(): NodeJS.ErrnoException {
  const e = new Error('no such process') as NodeJS.ErrnoException
  e.code = 'ESRCH'
  return e
}

function psStdout(rows: PsRow[]): string {
  return rows.map(r => `  ${r.pid}   ${r.ppid} ${r.command}`).join('\n') + '\n'
}

/** SIGTERM 即退出形态的信号注入：SIGTERM/SIGKILL no-op，探活（signal 0）报 ESRCH。 */
function signalDiesOnProbe(): ReapOrphanOptions['signal'] {
  return (_pid, signal) => {
    if (signal === 0) throw esrch()
  }
}

function makeOptions(rows: PsRow[], overrides?: Partial<ReapOrphanOptions>): ReapOrphanOptions {
  return {
    dataDir: DATA_DIR,
    ownPid: OWN_PID,
    readSpawnMarkers: () => [MARKER],
    listProcesses: () => Promise.resolve(psStdout(rows)),
    signal: signalDiesOnProbe(),
    delay: () => Promise.resolve(),
    ...overrides,
  }
}

/** 读台账活跃档全部行（不存在 = 零事件）。 */
function readJournalRecords(): Array<Record<string, unknown>> {
  const p = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

describe('reap-orphan-pi → 崩溃台账 reaped 事件（D1 矩阵 reaped 行）', () => {
  it('① 判据命中且处置成功：一条 reaped 事件，含 pid/ppid 与 argv 判据摘要', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(501, 1, piCmd()),
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([501])
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.layer).toBe('pi')
    expect(rec.event).toBe('reaped')
    // 结构化进程身份（schema 外扩展字段经 writer spread 序列化落盘）
    expect(rec.pid).toBe(501)
    expect(rec.ppid).toBe(1)
    // 判据摘要内嵌 detailDigest：v2 marker 判据说明（argv 匹配 spawn 清单 + ppid=1）
    // + argv 头部可辨识
    const digest = String(rec.detailDigest)
    expect(digest).toContain('ppid=1')
    expect(digest).toContain('spawn marker list')
    expect(digest).toContain('--mode rpc')
  })

  it('④ 防误记：判据未命中（ppid=并存实例 pid / marker 清单外值）→ 零台账事件', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(601, 40842, piCmd()), // 另一合法实例的活跃 pi（ppid=对方 runtime）
      row(602, 1, piCmd('/Users/other/other-ext')), // 其他实例清单外的 pi（argv marker 不匹配）
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([])
    expect(readJournalRecords()).toEqual([])
  })

  it('④ 防误记：混合命中 + 自有子进程（ppid=ownPid 被防线②排除）→ 仅命中者产生事件', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(701, OWN_PID, piCmd()), // 本 runtime 活跃子代（不杀）
      row(702, 1, piCmd()), // 真孤儿
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([702])
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.pid).toBe(702)
  })

  it('④ 防误记：处置失败（SIGTERM 抛非 ESRCH）→ 进 failed、不记 reaped 事件', async () => {
    initCrashJournal(dataDir)
    const boom = new Error('operation not permitted')
    const result = await reapOrphanPiProcesses(makeOptions(
      [row(801, 1, piCmd())],
      { signal: () => { throw boom } },
    ))
    await closeCrashJournal()

    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([801])
    expect(readJournalRecords()).toEqual([])
  })

  it('多孤儿逐一记事件：每 pid 一条，事件 pid 集与 reaped 结果一致', async () => {
    initCrashJournal(dataDir)
    const result = await reapOrphanPiProcesses(makeOptions([
      row(901, 1, piCmd()),
      row(902, 1, piCmd()),
    ]))
    await closeCrashJournal()

    expect(result.reaped).toEqual([901, 902])
    const records = readJournalRecords()
    expect(records.map(r => r.pid)).toEqual([901, 902])
    for (const rec of records) {
      expect(rec.event).toBe('reaped')
      expect(rec.layer).toBe('pi')
    }
  })

  it('宽限默认值不被接线改动：killGraceMs 缺省仍为 ORPHAN_KILL_GRACE_MS（接线零行为漂移哨兵）', () => {
    expect(ORPHAN_KILL_GRACE_MS).toBe(2_000)
  })
})
