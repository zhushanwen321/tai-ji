/**
 * RpcClient sendRaw / sendExtensionUiResponse 送达契约单测（code-harden M1 环 2 / RT-2#8）。
 *
 * 锁定：
 * - sendRaw 返回 boolean（true = 已写进 pi stdin；false = 未送达），false 两径：
 *   进程不在（未 start / 已退出）与 stdin.write 同步抛错——两径都必须留 error 日志
 *   （经 logger.patchConsole tee 落 runtime 日志，可感知），不允许静默丢弃
 * - sendExtensionUiResponse 透传 sendRaw 返回值（应答承载用户决策，调用方据此终结
 *   请求 + 上行错误——extension-message-handler 环 1 消费）
 *
 * 策略：与 rpc-client-activity.test.ts 同构——mock node:child_process + fake stdin，
 * 写失败用 mockImplementationOnce 抛错注入。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/infra/pi/rpc-client-sendraw-delivery.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../../../infra/pi/rpc-client.js'

const stdinWrites: string[] = []
let stdoutDataHandler: ((chunk: Buffer | string) => void) | null = null

const fakeProc = {
  on: vi.fn(() => fakeProc),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn((event: string, handler: (chunk: Buffer | string) => void) => {
      if (event === 'data') stdoutDataHandler = handler
      return fakeProc.stdout
    }),
    off: vi.fn(),
    removeListener: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn((chunk: string) => {
      stdinWrites.push(chunk)
      return true
    }),
    on: vi.fn(),
    once: vi.fn(),
  },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))

vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@taiji/shared/paths', () => ({ getDataDir: () => '/mock/home/.taiji' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../../../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

const BASE_TIME = 1_700_000_000_000
const STARTUP_WINDOW_MS = 500

async function startClient(): Promise<RpcClient> {
  const { RpcClient: RpcClientCtor } = await import('../../../infra/pi/rpc-client.js')
  const client = new RpcClientCtor({ cwd: '/project' })
  vi.setSystemTime(BASE_TIME)
  const startPromise = client.start()
  await vi.advanceTimersByTimeAsync(STARTUP_WINDOW_MS)
  await startPromise
  return client
}

describe('RpcClient sendRaw 送达契约（M1 环 2 / RT-2#8）', () => {
  let client: RpcClient
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    stdinWrites.length = 0
    stdoutDataHandler = null
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME - 10_000)
    client = await startClient()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    vi.useRealTimers()
  })

  it('写成功 → 返 true 且行落 stdin', () => {
    const ok = client.sendRaw(JSON.stringify({ type: 'extension_ui_response', id: 'ui_1', value: 'y' }) + '\n')
    expect(ok).toBe(true)
    expect(stdinWrites).toHaveLength(1)
    expect(JSON.parse(stdinWrites[0]!)).toMatchObject({ type: 'extension_ui_response', id: 'ui_1' })
  })

  it('stdin.write 同步抛错 → 返 false + error 日志留痕（可感知，不静默）', () => {
    fakeProc.stdin.write.mockImplementationOnce(() => {
      throw new Error('write EPIPE')
    })
    const ok = client.sendRaw(JSON.stringify({ type: 'extension_ui_response', id: 'ui_2' }) + '\n')
    expect(ok).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[rpc] sendRaw write failed:', expect.any(Error))
    expect(stdinWrites).toHaveLength(0) // 未送达
  })

  it('进程未运行 → 返 false + error 日志留痕', async () => {
    const { RpcClient: RpcClientCtor } = await import('../../../infra/pi/rpc-client.js')
    const unstarted = new RpcClientCtor({ cwd: '/project' })
    const ok = unstarted.sendRaw('{}\n')
    expect(ok).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[rpc] sendRaw failed: pi process is not running')
  })

  it('sendExtensionUiResponse 透传送达结果：失败 false / 成功 true 且 wire 形状正确', () => {
    // 失败腿：写抛错 → false（extension-message-handler 环 1 据此 sendError 终结）
    fakeProc.stdin.write.mockImplementationOnce(() => {
      throw new Error('write after destroy')
    })
    expect(client.sendExtensionUiResponse('ui_3', true, 'confirm')).toBe(false)

    // 成功腿：confirm → {id, confirmed:true}（null > confirm > value 判别）
    expect(client.sendExtensionUiResponse('ui_4', true, 'confirm')).toBe(true)
    const last = stdinWrites[stdinWrites.length - 1]!
    expect(JSON.parse(last)).toEqual({ type: 'extension_ui_response', id: 'ui_4', confirmed: true })
  })
})
