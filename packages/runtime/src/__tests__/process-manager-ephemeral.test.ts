/**
 * ProcessManager.withEphemeralPi 单测（W11，数据源治理——非活跃 rename 短命 pi）。
 *
 * Mock 策略定案：**mock rpc-client 模块**（非真实 spawn、非 mock child_process）——
 * withEphemeralPi 的被测逻辑是「spawn（复用 createSession）→ switchSession 附着 →
 * fn → 销毁」的编排与失败语义，RpcClient 是注入的协作原语；真实 spawn 归 P1 gate
 * 行为级验收（改名词 <1.5s + JSONL 尾部 entry），此处隔离进程噪声锁编排契约。
 *
 * 锁定：
 * - 成功：附着 RPC 用 switchSession(sessionFile)；fn 收到 client；返回值透传；finally 销毁
 * - 附着失败（switchSession reject）：rethrow + 销毁
 * - fn 抛错：rethrow + 销毁
 * - 就绪超时（switchSession 挂起 5s）：reject 带 timeout 消息 + 销毁（fake timers）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-ephemeral.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

// rpc-client 模块 mock：FakeRpcClient 记录 start/kill/exit 注册，switchSession/setSessionName 为 vi.fn
const rpcMock = vi.hoisted(() => {
  const instances: Array<{
    started: boolean
    killed: boolean
    options: Record<string, unknown>
    switchSession: ReturnType<typeof vi.fn>
    setSessionName: ReturnType<typeof vi.fn>
  }> = []
  class FakeRpcClient {
    started = false
    killed = false
    exitCb: ((code: number | null, stderr: string) => void) | null = null
    constructor(public options: Record<string, unknown>) {
      instances.push(this)
    }
    async start(): Promise<void> { this.started = true }
    onExit(cb: (code: number | null, stderr: string) => void): void { this.exitCb = cb }
    async kill(): Promise<void> { this.killed = true }
    get exited(): boolean { return this.killed }
    switchSession = vi.fn(async (_p: string): Promise<void> => {})
    setSessionName = vi.fn(async (_n: string): Promise<unknown> => ({ success: true }))
  }
  return { FakeRpcClient, instances }
})
vi.mock('../infra/pi/rpc-client.js', () => ({ RpcClient: rpcMock.FakeRpcClient }))

import { ProcessManager } from '../infra/pi/process-manager.js'

const SESSION_FILE = '/data/data/agent/sessions/abc/scan-target.jsonl'

describe('ProcessManager.withEphemeralPi（W11 短命 pi 附着）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // R3 隔离：打包版太极 agent 会话内执行时 TAIJI_AGENT_PACKAGED 泄入测试进程，
    // ProcessManager/依赖链内 isPackaged() 判真改道 findPackagedPi throw（P1 同款机制）。
    // 本测试 hermetic 前提是非打包态，显式压平。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    rpcMock.instances.length = 0
    // projectRoot 指向 tmpdir：dev 模式 resources/pi 不存在 → PATH fallback（RpcClient 已
    // mock，路径解析只影响日志，不真 spawn）
    pm = new ProcessManager(tmpdir())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('成功：switchSession 附着目标文件 → fn 收到 client → 返回值透传 → 进程销毁', async () => {
    const result = await pm.withEphemeralPi(SESSION_FILE, async (c) => {
      await c.setSessionName('新名')
      return 42
    })

    expect(result).toBe(42)
    // 附着原语 = switchSession(sessionFile)（非 --session CLI flag，rpc-client 参数面未扩）
    const client = rpcMock.instances[0]
    expect(client).toBeDefined()
    expect(client.switchSession).toHaveBeenCalledTimes(1)
    expect(client.switchSession).toHaveBeenCalledWith(SESSION_FILE)
    expect(client.setSessionName).toHaveBeenCalledWith('新名')
    // 用后即毁：进程被 kill，且不残留在 process map
    expect(client.killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('附着失败（switchSession reject，如文件不存在 pi 报错）→ rethrow + 进程销毁', async () => {
    const origCreate = pm.createSession.bind(pm)
    vi.spyOn(pm, 'createSession').mockImplementation(async (id, cwd, opts) => {
      const c = await origCreate(id, cwd, opts)
      ;(c as unknown as { switchSession: ReturnType<typeof vi.fn> }).switchSession
        = vi.fn(async () => { throw new Error('switch_session failed: file not found') })
      return c
    })

    await expect(pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable'))
      .rejects.toThrow('switch_session failed')

    // fn 未执行（rejects 已证不可达）；进程仍被销毁
    expect(rpcMock.instances[0].killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('fn 抛错 → rethrow + 进程销毁（失败路径不泄漏）', async () => {
    await expect(pm.withEphemeralPi(SESSION_FILE, async () => {
      throw new Error('RPC command "set_session_name" failed')
    })).rejects.toThrow('set_session_name')

    expect(rpcMock.instances[0].killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('就绪超时：switchSession 挂起超过 5s → reject 带 timeout 消息 + 进程销毁（fake timers）', async () => {
    vi.useFakeTimers()
    const origCreate = pm.createSession.bind(pm)
    vi.spyOn(pm, 'createSession').mockImplementation(async (id, cwd, opts) => {
      const c = await origCreate(id, cwd, opts)
      ;(c as unknown as { switchSession: ReturnType<typeof vi.fn> }).switchSession
        = vi.fn(() => new Promise<void>(() => {}))
      return c
    })

    const pending = pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable')
    const assertion = expect(pending).rejects.toThrow('Ephemeral pi attach timed out after 5000ms')
    // 推进 5s 触发就绪超时
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion

    expect(rpcMock.instances[0].killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('spawn 失败（createSession 抛错）→ rethrow，无进程残留', async () => {
    vi.spyOn(pm, 'createSession').mockRejectedValueOnce(new Error('Failed to start pi process'))
    await expect(pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable'))
      .rejects.toThrow('Failed to start pi process')
    expect(pm.size).toBe(0)
  })
})
