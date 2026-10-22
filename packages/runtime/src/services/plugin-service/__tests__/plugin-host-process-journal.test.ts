/**
 * plugin-host fork 宿主 → 崩溃 journal plugin-worker crash 事件接线测试（crash-forensics-
 * and-watchdog §3.3 D1 plugin-worker crash 行，实施单元 u1d2）。
 *
 * 锁定（验收条款逐条对照）：
 * - ③ 子进程异常退出（exit code 3）→ journal crash 事件：layer=plugin-worker、结构化
 *   exitCode（schema 既有字段）、processId/pid/signal/pluginIds 扩展字段、detailDigest
 *   内嵌退出描述。
 * - ④ 防误记：exit code 0 正常退出（L-5 clean exit 分流）→ 零 journal 事件；计划内
 *   terminate（pre-mark terminated 幂等检查）→ 零 journal 事件。
 *
 * 形态：真实 writer（initCrashJournal → mkdtemp tmp → closeCrashJournal 确定性 flush
 * 后逐行 JSON.parse）+ fork 桩子进程（child_process.fork 换成同进程注入桩，测试显式
 * 驱动 exit 事件码值）。
 *
 * 层级归属（docs/todo/test-single-layer-cleanup.md 判据三档）：被测逻辑 = 宿主 exit
 * 事件分流（crash / clean exit / 计划内终止幂等）与 journal 行的字段装配，全部在
 * PluginHostProcess 实装内；「真实 fork 的子进程确实以 code 3 退出」是 OS 事实、
 * 无完成信号可等，不进默认单测轨。桩只替换进程边界，exit 事件与码值由测试确定性
 * 注入——崩溃回调同步执行，原 vi.waitFor 5s 轮询随之删除。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/plugin-host-process-journal.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCrashJournal, initCrashJournal } from '../../../infra/crash-journal.js'
import { PluginHostProcess } from '../plugin-host-process.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'

// ── fork 桩：假子进程 + exit 事件注入 seam（零真进程）────────────────
// 与 test/helpers/plugin-host-inproc-stubs.ts 的分工：该共享桩只移植三个 mock
// bootstrap（load/rpc/crash/fatal/exit0/ipc-disconnect）实际驱动的分支；本文件驱动
// 的是「任意 exit code（3）的退出事件」——journal 行的 exitCode 字段正是被测物，
// 故用本地桩显式注入码值，不改共享桩（在途文件，且分支语义不同）。
const forkSlot = vi.hoisted(() => ({ child: null as unknown }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: (): ChildProcess => {
      if (forkSlot.child) return forkSlot.child as ChildProcess
      throw new Error('fork stub: 未装入假子进程（用例须先 installFakeChild）')
    },
  }
})

/** 假 fork 子进程：只实现 PluginHostProcess 消费的成员面；exit 事件由测试显式注入。 */
class FakeForkChild extends EventEmitter {
  readonly pid = 4321
  exitCode: number | null = null
  signalCode: string | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly sent: unknown[] = []

  /** 模拟 SIGKILL 生效（terminateProcess / shutdown 的 killChildGracefully 路径）。 */
  kill(): void {
    this.emitExit(null, 'SIGKILL')
  }

  send(message: unknown): boolean {
    this.sent.push(message)
    return true
  }

  /** 注入 exit 事件（真实场景由 OS 进程退出触发；宿主分流逻辑同步执行）。 */
  emitExit(code: number | null, signal: string | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

/** 装入假子进程并返回（后续该 host 的 fork 调用拿到此实例）。 */
function installFakeChild(): FakeForkChild {
  const child = new FakeForkChild()
  forkSlot.child = child as unknown
  return child
}

let dataDir: string
const createdDirs: string[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'plugin-journal-'))
  createdDirs.push(dataDir)
})

afterEach(() => {
  forkSlot.child = null
})

afterAll(() => {
  // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除 ENOTEMPTY 瞬态重试
  // （pre-commit flake 卫生检查硬要求）
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 读 journal 活跃档全部行（不存在 = 零事件）。 */
function readJournalRecords(): Array<Record<string, unknown>> {
  const p = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

describe('plugin-host-process → 崩溃 journal plugin-worker crash 事件（D1 矩阵 plugin-worker crash 行）', () => {
  it('③ 异常退出（exit code 3）：一条 crash 事件，含 exitCode/processId/pid/pluginIds', async () => {
    initCrashJournal(dataDir)
    // fork 已桩化，bootstrap 文件不会被执行；占位路径仅用于短路 resolveAndValidateFile 链
    const host = new PluginHostProcess(new PluginRpcServer(), {
      bootstrapPathOverride: join(dataDir, 'bootstrap-not-executed.cjs'),
    })
    const child = installFakeChild()
    const crashSpy = vi.fn()
    host.setCrashCallback(crashSpy)

    const processId = await host.assignProcess('p-crashy', 'trusted')
    // 注入 exit(code 3)：crash 分流（幂等检查 + journal append + onCrash）同步执行完
    child.emitExit(3, null)
    expect(crashSpy).toHaveBeenCalledTimes(1)
    await closeCrashJournal()

    expect(processId).toBe('trusted-1')
    const records = readJournalRecords()
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.layer).toBe('plugin-worker')
    expect(rec.event).toBe('crash')
    // 退出码（schema 既有字段）——评估器可直接计数消费
    expect(rec.exitCode).toBe(3)
    // 扩展字段：宿主身份 + 插件受影响面
    expect(rec.processId).toBe('trusted-1')
    expect(typeof rec.pid).toBe('number')
    expect(rec.pluginIds).toEqual(['p-crashy'])
    // exit 路径非信号致死
    expect(rec.signal).toBeNull()
    expect(String(rec.detailDigest)).toContain('code 3')

    await host.shutdown()
  })

  it('④ 防误记：exit code 0 正常退出（clean exit 分流）→ 零 journal 事件', async () => {
    initCrashJournal(dataDir)
    const host = new PluginHostProcess(new PluginRpcServer(), {
      bootstrapPathOverride: join(dataDir, 'bootstrap-not-executed.cjs'),
    })
    const child = installFakeChild()
    const crashSpy = vi.fn()
    host.setCrashCallback(crashSpy)

    await host.assignProcess('p-clean', 'trusted')
    // 注入 exit(0)：clean exit 清理（handle 删除）同步执行完
    child.emitExit(0, null)
    expect(host.getProcessHandleById('trusted-1')).toBeUndefined()
    await closeCrashJournal()

    expect(crashSpy).not.toHaveBeenCalled()
    expect(readJournalRecords()).toEqual([])

    await host.shutdown()
  })

  it('④ 防误记：计划内 terminateProcess（pre-mark terminated 幂等检查）→ 零 journal 事件', async () => {
    initCrashJournal(dataDir)
    // 常驻子进程形态：不主动退出，等待 terminate 链的 SIGKILL（假子进程 kill → exit 事件）
    const host = new PluginHostProcess(new PluginRpcServer(), {
      bootstrapPathOverride: join(dataDir, 'bootstrap-not-executed.cjs'),
    })
    installFakeChild()
    const crashSpy = vi.fn()
    host.setCrashCallback(crashSpy)

    const processId = await host.assignProcess('p-terminated', 'trusted')
    await host.terminateProcess(processId)
    await closeCrashJournal()

    expect(crashSpy).not.toHaveBeenCalled()
    expect(readJournalRecords()).toEqual([])

    await host.shutdown()
  })
})
