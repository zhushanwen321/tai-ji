/**
 * log-retention-ipc 单测（crash-resilience A9② 验收调试口条款）。
 *
 * 覆盖：
 * - 调用返回统计：handler 返回 {scanned, removed}，超龄匹配前缀文件被清、固定名 stderr
 *   与 mtime 活跃文件保留（清理语义本体由 log-retention.test.ts 锚定，此处验证 IPC
 *   接线消费同一函数）
 * - 零抛错：logs 目录缺失（首次启动未建立）返回 {scanned:0, removed:0} 不抛错
 * - 注册幂等：重复调用 registerLogRetentionDebugHandler 不重复 handle（防 Electron
 *   「second handler」炸启动，对齐 renderer-log-handler 同款）
 *
 * electron mock 捕获 ipcMain.handle（对齐 renderer-log-handler.test.ts 形态）；
 * main-logger mock 掉（debug 镜像日志会往被扫目录写 main-*.log，污染 scanned 计数
 * 的确定性）。全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/log-retention-ipc.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

// main-logger mock：debug 镜像日志落盘会往被扫的 logs/ 目录写 main-<date>.log，
// 使 scanned 计数随日志写入条数漂移——stub 掉保持目录内容确定性
vi.mock('../main-logger.js', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  readMainLogMaxBytes: () => 10 * 1024 * 1024,
}))

import { registerLogRetentionDebugHandler } from '../log-retention-ipc.js'
import { DEBUG_RUN_LOG_RETENTION } from '@taiji/shared'

describe('log-retention-ipc（debug:run-log-retention）', () => {
  let tmpDir: string
  let logsDir: string
  let savedDataDir: string | undefined
  let savedKeepDays: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'log-retention-ipc-test-'))
    logsDir = join(tmpDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    savedKeepDays = process.env.TAIJI_LOG_KEEP_DAYS
    // env 注入重定向（getDataDir 动态推导）：logsDir = <dataDir>/logs
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    process.env.TAIJI_LOG_KEEP_DAYS = '1'
    registerLogRetentionDebugHandler()
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    if (savedKeepDays === undefined) delete process.env.TAIJI_LOG_KEEP_DAYS
    else process.env.TAIJI_LOG_KEEP_DAYS = savedKeepDays
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写入一个文件并把 mtime 设为 n 天前。 */
  function touch(name: string, ageDays: number): string {
    const full = join(logsDir, name)
    writeFileSync(full, `${name}-content`)
    const old = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
    utimesSync(full, old, old)
    return full
  }

  it('调用返回统计：超龄匹配前缀文件被清，固定名 stderr 与活跃文件保留', () => {
    const staleA = touch('runtime-2026-01-01.log', 10)
    const staleB = touch('pi-2026-01-01-abc.jsonl', 10)
    const fixedStderr = touch('electron-runtime-stderr.log', 10)
    const fresh = touch('main-fresh.log', 0)

    const handler = handlers.get(DEBUG_RUN_LOG_RETENTION)
    expect(handler, 'handler 应已注册到 debug:run-log-retention 通道').toBeDefined()
    const result = handler!(undefined) as { scanned: number; removed: number }

    expect(result).toEqual({ scanned: 3, removed: 2 })
    expect(existsSync(staleA)).toBe(false)
    expect(existsSync(staleB)).toBe(false)
    expect(existsSync(fixedStderr), '固定名 stderr 不误删').toBe(true)
    expect(existsSync(fresh), 'mtime 活跃文件不误删').toBe(true)
  })

  it('零抛错：logs 目录缺失（首次启动未建立）返回 {scanned:0, removed:0}', () => {
    rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

    const handler = handlers.get(DEBUG_RUN_LOG_RETENTION)!
    let result: { scanned: number; removed: number } | undefined
    expect(() => {
      result = handler(undefined) as { scanned: number; removed: number }
    }).not.toThrow()
    expect(result).toEqual({ scanned: 0, removed: 0 })
  })

  it('注册幂等：重复调用 registerLogRetentionDebugHandler 不重复 handle', () => {
    registerLogRetentionDebugHandler()
    registerLogRetentionDebugHandler()
    expect(handlers.get(DEBUG_RUN_LOG_RETENTION)).toBeDefined()
    expect([...handlers.keys()].filter((c) => c === DEBUG_RUN_LOG_RETENTION)).toHaveLength(1)
  })
})
