/**
 * plugin-host fork 宿主 → 崩溃台账 plugin-worker crash 事件接线测试（crash-forensics-
 * and-watchdog §3.3 D1 plugin-worker crash 行，实施单元 u1d2）。
 *
 * 锁定（验收条款逐条对照）：
 * - ③ 子进程异常退出（exit code 3）→ 台账 crash 事件：layer=plugin-worker、结构化
 *   exitCode（schema 既有字段）、processId/pid/signal/pluginIds 扩展字段、detailDigest
 *   内嵌退出描述。
 * - ④ 防误记：exit code 0 正常退出（L-5 clean exit 分流）→ 零台账事件；计划内
 *   terminate（pre-mark terminated 幂等守卫）→ 零台账事件。
 *
 * 形态：真实 writer（initCrashJournal → mkdtemp tmp → closeCrashJournal 确定性 flush
 * 后逐行 JSON.parse）+ 真实 fork 子进程（bootstrapPathOverride 注入 tmp .cjs，
 * trusted 形态不经 sandbox ESM loader 的 --import 前置断言）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/plugin-host-process-journal.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCrashJournal, initCrashJournal } from '../../../infra/crash-journal.js'
import { PluginHostProcess } from '../plugin-host-process.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'

let dataDir: string
const createdDirs: string[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'plugin-journal-'))
  createdDirs.push(dataDir)
})

afterAll(() => {
  // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除 ENOTEMPTY 瞬态重试
  // （pre-commit flake 卫生检查硬要求）
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 写 mock bootstrap（fork 子进程启动即按指定 code 退出）。 */
function writeBootstrap(name: string, body: string): string {
  const p = join(dataDir, name)
  writeFileSync(p, body, 'utf8')
  return p
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

describe('plugin-host-process → 崩溃台账 plugin-worker crash 事件（D1 矩阵 plugin-worker crash 行）', () => {
  it('③ 异常退出（exit code 3）：一条 crash 事件，含 exitCode/processId/pid/pluginIds', async () => {
    initCrashJournal(dataDir)
    const bootstrap = writeBootstrap('exit3.cjs', 'process.exit(3)\n')
    const host = new PluginHostProcess(new PluginRpcServer(), { bootstrapPathOverride: bootstrap })
    const crashSpy = vi.fn()
    host.setCrashCallback(crashSpy)

    const processId = await host.assignProcess('p-crashy', 'trusted')
    // crash 分流完成（幂等守卫 + 台账 append 均在 onCrash 回调前同步执行）
    await vi.waitFor(() => expect(crashSpy).toHaveBeenCalledTimes(1), { timeout: 5_000 })
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

  it('④ 防误记：exit code 0 正常退出（clean exit 分流）→ 零台账事件', async () => {
    initCrashJournal(dataDir)
    const bootstrap = writeBootstrap('exit0.cjs', 'process.exit(0)\n')
    const host = new PluginHostProcess(new PluginRpcServer(), { bootstrapPathOverride: bootstrap })
    const crashSpy = vi.fn()
    host.setCrashCallback(crashSpy)

    await host.assignProcess('p-clean', 'trusted')
    // 等 clean exit 清理完成（handle 被删除 = exit(0) 分流已走完）
    await vi.waitFor(() => expect(host.getProcessHandleById('trusted-1')).toBeUndefined(), { timeout: 5_000 })
    await closeCrashJournal()

    expect(crashSpy).not.toHaveBeenCalled()
    expect(readJournalRecords()).toEqual([])

    await host.shutdown()
  })

  it('④ 防误记：计划内 terminateProcess（pre-mark terminated 幂等守卫）→ 零台账事件', async () => {
    initCrashJournal(dataDir)
    // 长驻 bootstrap：不主动退出，等待 SIGTERM（terminate 链）
    const bootstrap = writeBootstrap('resident.cjs', 'setInterval(() => {}, 1_000)\n')
    const host = new PluginHostProcess(new PluginRpcServer(), { bootstrapPathOverride: bootstrap })
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
