/**
 * getCommands 的 background 任务补投触发测试（bg-task-notify-durability runtime 触发面）。
 *
 * 背景：桌面「切走会话再切回」是同进程重新挂接——pi 进程存活、不重发 session_start，
 * 扩展侧维护链在「投递失败但进程存活」场景永不触发。runtime 在 getCommands（切回后
 * renderer 主动拉取的必经查询）按 60s per-session 节流补触发 `/__taiji_bg_reconcile__`。
 *
 * 覆盖：
 * - 节流：同 session 60s 内重复 getCommands 只发一次 prompt；推进节流窗口后再次发出
 * - 跨 session 分区：A 触发后 B 首次调用仍触发（互不影响、互不挤占窗口）
 * - 命令通道断言：prompt 以 ('/__taiji_bg_reconcile__', undefined, undefined,
 *   { maintenance: true }) 调用——维护标记透传（idle 回收豁免，不刷 lastActivityAt）
 * - fire-and-forget：prompt reject 时 getCommands 正常 resolve（查询不被补投失败拖垮），
 *   失败记 console.warn
 *
 * Mock 边界：SessionService 依赖桩仿 session-service-background-task.test.ts 的
 * createSetup 最小集（构造期零 fs 触点）；client 仅桩 prompt / getCommands（本域唯二
 * 触点）。禁触真实数据目录（测试红线）：本测试零 fs 读写。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-bg-reconcile-trigger.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

import { SessionService } from '../session-service.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { IProcessManager, IPiEngine } from '../../../services/ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

const SID_A = 'sess-a'
const SID_B = 'sess-b'

interface ClientStubs {
  client: IPiEngine
  prompt: ReturnType<typeof vi.fn>
  getCommands: ReturnType<typeof vi.fn>
}

function makeClient(): ClientStubs {
  const prompt = vi.fn(async () => ({}) as never)
  const getCommands = vi.fn(async () => [] as never[])
  return { client: { prompt, getCommands } as unknown as IPiEngine, prompt, getCommands }
}

function createSetup(clients: Record<string, IPiEngine>): { service: SessionService; pm: IProcessManager } {
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn((sessionId: string) => clients[sessionId]),
    hasClient: vi.fn((sessionId: string) => sessionId in clients),
    destroyAll: vi.fn(),
  } as unknown as IProcessManager

  const service = new SessionService(
    pm,
    // broker
    { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() },
    // adapterFactory：桩（本域不附着 session）
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    // configStore / sessionStore：真实实例（构造期零 IO，同既有 session-service 测试范式）
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, pm }
}

beforeEach(() => {
  // fake timers：节流窗口判定读 Date.now()——vitest fake timers 同步接管 Date，
  // advanceTimersByTime 推进墙钟即可验证 60s 窗口（真实等待 60s 不可接受）
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('getCommands 的补投触发（bg-task-notify-durability）', () => {
  it('命令通道断言：prompt 以内部命令 + maintenance 标记调用，getCommands 返回值不受影响', async () => {
    const a = makeClient()
    const { service } = createSetup({ [SID_A]: a.client })

    const result = await service.getCommands(SID_A)

    expect(a.prompt).toHaveBeenCalledTimes(1)
    expect(a.prompt).toHaveBeenCalledWith('/__taiji_bg_reconcile__', undefined, undefined, { maintenance: true })
    expect(result).toEqual([])
    expect(a.getCommands).toHaveBeenCalledTimes(1)
  })

  it('60s 节流：同 session 窗口内重复查询只发一次；推进窗口后再次发出', async () => {
    const a = makeClient()
    const { service } = createSetup({ [SID_A]: a.client })

    await service.getCommands(SID_A)
    await service.getCommands(SID_A)
    await service.getCommands(SID_A)
    expect(a.prompt).toHaveBeenCalledTimes(1)

    // 推进 59s：仍在窗口内
    vi.advanceTimersByTime(59_000)
    await service.getCommands(SID_A)
    expect(a.prompt).toHaveBeenCalledTimes(1)

    // 推满 60s：窗口过期，重新触发
    vi.advanceTimersByTime(1_000)
    await service.getCommands(SID_A)
    expect(a.prompt).toHaveBeenCalledTimes(2)
  })

  it('跨 session 分区：A 触发后 B 首次查询仍触发（节流互不影响）', async () => {
    const a = makeClient()
    const b = makeClient()
    const { service } = createSetup({ [SID_A]: a.client, [SID_B]: b.client })

    await service.getCommands(SID_A)
    await service.getCommands(SID_A)
    await service.getCommands(SID_B)
    await service.getCommands(SID_B)

    expect(a.prompt).toHaveBeenCalledTimes(1)
    expect(b.prompt).toHaveBeenCalledTimes(1)
  })

  it('fire-and-forget：prompt reject 不拖垮 getCommands，失败记 console.warn；client 缺失静默跳过', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = makeClient()
    a.prompt.mockRejectedValueOnce(new Error('rpc closed'))
    const { service } = createSetup({ [SID_A]: a.client })

    await expect(service.getCommands(SID_A)).resolves.toEqual([])
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bg reconcile trigger failed'), expect.any(Error)))
  })

  it('client 缺失：getCommands 保持既有 not active 抛错契约，不发起补投 prompt', async () => {
    const { service } = createSetup({})

    await expect(service.getCommands(SID_A)).rejects.toThrow(`session ${SID_A} not active`)
  })
})
