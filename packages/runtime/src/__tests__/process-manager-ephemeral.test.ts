/**
 * ProcessManager.withEphemeralPi 单测（W11，数据源治理——非活跃 rename 短命 pi）。
 *
 * Mock 策略定案：**mock rpc-client 模块**（非真实 spawn、非 mock child_process）——
 * withEphemeralPi 的被测逻辑是「spawn（复用 createSession）→ switchSession 附着 →
 * fn → 销毁」的编排与失败语义，RpcClient 是注入的协作原语；真实 spawn 归 P1 gate
 * 行为级验收（改名词 <1.5s + JSONL 尾部 entry），此处隔离进程噪声锁编排契约。
 * 例外 = 族③用例（W3.5）：FakeRpcClient.start 经 rpcMock.tee 驱动**真实** logger 的
 * createPiSessionLog（复现真实 RpcClient.start 的 tee 接线，rpc-client.ts:344-345），
 * 使残留树由生产 tee 路径产出而非测试摆盘——finally 的整树回收因此是端到端断言。
 *
 * 锁定：
 * - 成功：附着 RPC 用 switchSession(sessionFile)；fn 收到 client；返回值透传；finally 销毁
 * - 附着失败（switchSession reject）：rethrow + 销毁
 * - fn 抛错：rethrow + 销毁
 * - 就绪超时（switchSession 挂起 5s）：reject 带 timeout 消息 + 销毁（fake timers）
 * - 族③（W3.5）：finally 在 destroySession 之后回收 ephemeral tee 树（非空树，
 *   开工前实证①确认的残留形态 `<root>/<ephemeralId>/logs/pi-<date>.jsonl`）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-ephemeral.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// rpc-client 模块 mock：FakeRpcClient 记录 start/kill/exit 注册，switchSession/setSessionName 为 vi.fn
const rpcMock = vi.hoisted(() => {
  const instances: Array<{
    started: boolean
    killed: boolean
    options: Record<string, unknown>
    switchSession: ReturnType<typeof vi.fn>
    setSessionName: ReturnType<typeof vi.fn>
  }> = []
  /**
   * 真实 logger 的 createPiSessionLog 挂点（族③用例经它驱动真实 tee 建树；logger 未
   * 初始化时生产实现自带 no-op，其余用例零副作用）。经对象间接引用而非工厂内静态
   * import——mock 工厂先于模块顶层语句求值，直接 import 会形成求值环。
   */
  const tee: { create: ((sessionId: string) => { write: (line: string) => void; end: () => void }) | null } = {
    create: null,
  }
  class FakeRpcClient {
    started = false
    killed = false
    exitCb: ((code: number | null, stderr: string) => void) | null = null
    constructor(public options: Record<string, unknown>) {
      instances.push(this)
    }
    async start(): Promise<void> {
      this.started = true
      // 复现真实 RpcClient.start 的 tee 接线（rpc-client.ts:344-345）：spawn 后为
      // 本 session 建 tee 树——族③用例的残留树由此产出（生产路径，非测试摆盘）
      tee.create?.(String(this.options.sessionId))
    }
    onExit(cb: (code: number | null, stderr: string) => void): void { this.exitCb = cb }
    async kill(): Promise<void> { this.killed = true }
    get exited(): boolean { return this.killed }
    switchSession = vi.fn(async (_p: string): Promise<void> => {})
    setSessionName = vi.fn(async (_n: string): Promise<unknown> => ({ success: true }))
  }
  return { FakeRpcClient, instances, tee }
})
vi.mock('../infra/pi/rpc-client.js', () => ({ RpcClient: rpcMock.FakeRpcClient }))

import { ProcessManager } from '../infra/pi/process-manager.js'
// 真实 logger（本文件不 mock）：tee 建树与 ephemeral 树回收的同模块闭环
import { closeLogger, createPiSessionLog, initLogger } from '../infra/logger.js'

const SESSION_FILE = '/data/data/agent/sessions/abc/scan-target.jsonl'

describe('ProcessManager.withEphemeralPi（W11 短命 pi 附着）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // R3 隔离：打包版太极 agent 会话内执行时 TAIJI_AGENT_PACKAGED 泄入测试进程，
    // ProcessManager/依赖链内 isPackaged() 判真改道 findPackagedPi throw（P1 同款机制）。
    // 本测试 hermetic 前提是非打包态，显式压平。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    rpcMock.instances.length = 0
    // tee 挂点指向真实 logger（族③用例经它建真实残留树；未初始化时 no-op）
    rpcMock.tee.create = createPiSessionLog
    // projectRoot 指向 tmpdir：dev 模式 resources/pi 不存在 → PATH fallback（RpcClient 已
    // mock，路径解析只影响日志，不真 spawn）
    pm = new ProcessManager(tmpdir())
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
    rpcMock.tee.create = null
    await closeLogger().catch(() => {})
  })

  it('成功：switchSession 附着目标文件 → fn 收到 client → 返回值透传 → 进程销毁', async () => {
    const result = await pm.withEphemeralPi(SESSION_FILE, async (c) => {
      await c.setSessionName('新名')
      return 42
    })

    expect(result).toBe(42)
    // 附着原语 = switchSession(sessionFile)（非 --session CLI flag，rpc-client 参数侧未扩）
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

  it('spawn 失败（createSession 抛错）→ rethrow，无进程残留', async () => {
    vi.spyOn(pm, 'createSession').mockRejectedValueOnce(new Error('Failed to start pi process'))
    await expect(pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable'))
      .rejects.toThrow('Failed to start pi process')
    expect(pm.size).toBe(0)
  })

  it('族③（W3.5）：finally 在 destroySession 之后回收 ephemeral tee 树（非空残留形态）', async () => {
    // 真实 logger：tee 建树（createPiSessionLog）与树回收（removeEphemeralSessionTree）
    // 同模块闭环；残留树由 FakeRpcClient.start 驱动的生产 tee 路径产出（开工前实证①
    // 同款形态：<root>/<ephemeralId>/logs/pi-<date>.jsonl 非空树）。
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-ephemeral-tree-'))
    initLogger(dataDir)
    try {
      let treeExistedWhenFnRan = false
      const result = await pm.withEphemeralPi(SESSION_FILE, async () => {
        // fn 在 finally 之前：此刻 tee 树已由生产 createPiSessionLog 建好
        const id = String(rpcMock.instances[0].options.sessionId)
        treeExistedWhenFnRan = existsSync(join(dataDir, 'ext-sessions', id, 'logs'))
        return 'ok'
      })
      expect(result).toBe('ok')

      // 非虚测前提：残留树确曾存在（非空树——「只删空目录」的清理会漏掉它）
      expect(treeExistedWhenFnRan).toBe(true)
      const ephemeralId = String(rpcMock.instances[0].options.sessionId)
      expect(ephemeralId.startsWith('ephemeral-')).toBe(true)
      // finally 回收：ephemeral 树不复存在，树根无 ephemeral-* 残留
      expect(existsSync(join(dataDir, 'ext-sessions', ephemeralId))).toBe(false)
      expect(readdirSync(join(dataDir, 'ext-sessions'))).toEqual([])
    } finally {
      await closeLogger()
    }
  })
})
