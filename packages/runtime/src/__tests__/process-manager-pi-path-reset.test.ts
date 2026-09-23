/**
 * ProcessManager.getPiPath 失败复位测试（code-harden 审计批次 4 Wave 1，RT-2#5）。
 *
 * 被测缺口：piPathPromise 无失败复位——探测链抛错被 pin 成进程生命周期内永久
 * rejected，同一 ProcessManager 实例后续 createSession 全部失败。修复后 catch 内
 * 置空 piPathPromise 再重抛（防御性复位）：失败仍向上传播（不吞错），但下次调用
 * 重新探测。注释口径 = 审查 D 裁决：findPiExecutable 唯一抛出点是 packaged 内置
 * 二进制缺失（确定性失败，重启前不自愈），复位不承诺恢复语义，仅防未来新增瞬态
 * 失败源被永久定罪。
 *
 * Mock 策略：与 process-manager-exit.test.ts 同构（mock child_process/fs，真实
 * RpcClient 跑在 fakeProc 上）+ 直接 mock find-pi-executable 控制抛错/成功（同
 * process-manager-pi-version.test.ts 先例）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-pi-path-reset.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProcessManager } from '../infra/pi/process-manager.js'

// ── Mocks ────────────────────────────────────────────────────────

const findPiMock = vi.hoisted(() => vi.fn((): string => '/fake-tools/pi'))
vi.mock('../infra/pi/find-pi-executable.js', () => ({ findPiExecutable: findPiMock }))

const procExitHandlers: Array<(code: number | null) => void> = []
const fakeProc = {
  exitCode: null as number | null,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'exit') procExitHandlers.push(handler as (code: number | null) => void)
    return fakeProc
  }),
  off: vi.fn(),
  removeListener: vi.fn(),
  once: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn(() => true),
    once: vi.fn(),
    on: vi.fn(), // RT-2#1 起 rpc-client 在源头接线 stdin 流错误（stdin.on('error')）
  },
  kill: vi.fn((signal?: string) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      queueMicrotask(() => {
        for (const h of [...procExitHandlers]) h(null)
      })
    }
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: () => fakeProc,
  execSync: () => {
    throw new Error('execSync mocked: not found')
  },
}))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// ── Tests ────────────────────────────────────────────────────────

describe('ProcessManager.getPiPath 失败复位（RT-2#5）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    procExitHandlers.length = 0
    fakeProc.on.mockClear()
    findPiMock.mockReset()
    findPiMock.mockReturnValue('/fake-tools/pi')
    pm = new ProcessManager('/mock/project')
  })

  afterEach(async () => {
    await pm.destroyAll()
  })

  it('探测失败后复位：下次调用重新探测（失败不被 pin 成永久 rejected）', async () => {
    // 首次探测抛错（findPiExecutable 唯一抛出点形态：packaged 内置二进制缺失）→
    // createSession rejects，错误原文向上传播（复位不吞错）
    findPiMock.mockImplementation(() => {
      throw new Error('Bundled pi binary not found')
    })
    await expect(pm.createSession('s1', '/mock/cwd', { startupDelayMs: 0 })).rejects.toThrow('Bundled pi binary not found')
    expect(findPiMock).toHaveBeenCalledTimes(1)

    // 修复前：piPathPromise 保持 rejected，第二次 createSession 直接拒绝且
    // findPiExecutable 不再被调（调用计数停在 1）。修复后：复位 → 重新探测成功
    findPiMock.mockReturnValue('/fake-tools/pi')
    const client = await pm.createSession('s1', '/mock/cwd', { startupDelayMs: 0 })
    expect(findPiMock).toHaveBeenCalledTimes(2)
    expect(client).toBeDefined()
  })

  it('成功路径语义不变：一次成功探测后永久缓存（不重复探测）', async () => {
    await pm.createSession('s1', '/mock/cwd', { startupDelayMs: 0 })
    await pm.createSession('s2', '/mock/cwd', { startupDelayMs: 0 })
    // 成功值缓存：两次 createSession 只探测一次（piPath 短路）
    expect(findPiMock).toHaveBeenCalledTimes(1)
  })
})
