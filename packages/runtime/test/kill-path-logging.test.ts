/**
 * D5①（session-dead-structural-fixes）kill 路径全量 warn 日志测试。
 *
 * 设计：docs/design/session-dead-structural-fixes.md（已删除，git 可追溯）§3.3 D5① / §4 V6——所有 kill/destroy
 * 路径打 warn 级日志，含调用源（kill_source 结构化字段）与触发信号链（「谁发起、为什么」），
 * 使 exit 143 类进程死亡可从日志回溯到发起方（2026-09-10 事故第三条腿无 kill 日志的教训）。
 *
 * 七条路径（设计文档 K 清单无 K4）各一断言——触发路径时 logger.warn（项目 runtime 惯例
 * console.warn，经 infra/logger patch 后落盘 <dataDir>/logs 轮转）被调用且含对应 source：
 * - K1 user_force_quit：dispatcher.forceQuit（用户侧栏强制退出）
 * - K2 abort_timeout：dispatcher.abort 的 RpcTimeoutError 强杀收口
 * - K3 restore_clear：lifecycle.restoreSession 清场杀活跃旧 pi
 * - K5 delete：lifecycle.delete 删除活跃 session
 * - K6 destroy_all：process-manager.destroyAll
 * - K7 reap_orphan：reapOrphanPiProcesses 启动孤儿收殓
 * - K8 exit_converge：process-manager client 异常退出回调（非 intentional destroy）
 *
 * mock 策略：全部协作者 mock / 注入（零真实进程、零真实等待）；lifecycle 部分文件操作
 * 真实执行于 mkdtemp tmp 目录（fs-guard 白名单）。
 *
 * 运行：cd packages/runtime && npx vitest run test/kill-path-logging.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── process-manager 部分的模块级 mock（rpc-client fake + 阻断 execSync/探针 spawn）──

/** 捕获 createSession 注册的 client.onExit 回调（K8 触发入口）。 */
const exitCallbacksRegistry = vi.hoisted(() => ({
  callbacks: [] as Array<(code: number | null, stderr: string) => void>,
}))

vi.mock('../src/infra/pi/rpc-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/rpc-client.js')>()
  class FakeRpcClient {
    exited = false
    constructor(_opts: unknown) {}
    async start(): Promise<void> {}
    onExit(cb: (code: number | null, stderr: string) => void): void {
      exitCallbacksRegistry.callbacks.push(cb)
    }
    async kill(): Promise<void> {}
    async switchSession(_path: string): Promise<void> {}
  }
  // 保留 actual：测试本体 import 的 RpcTimeoutError 等符号须来自真实模块
  return { ...actual, RpcClient: FakeRpcClient }
})
vi.mock('../src/infra/pi/find-pi-executable.js', () => ({
  findPiExecutable: vi.fn(() => '/fake/path/pi'),
}))
vi.mock('../src/infra/relay/relay-env.js', () => ({
  getRelaySpawnEnv: vi.fn(async () => ({})),
}))

// ── session-lifecycle 部分的模块级 mock（sessions 目录指向 tmp，不碰真实数据目录）──

const sessionsDirMock = vi.hoisted(() => ({ value: '/mock/not-yet-initialized' }))

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getSessionsDir: () => sessionsDirMock.value }
})

// 模块 mock 声明完毕后再 import 被测对象
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import { RpcTimeoutError } from '../src/infra/pi/rpc-client.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@xyz-agent/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import { ProcessManager } from '../src/infra/pi/process-manager.js'
import { reapOrphanPiProcesses, type ReapOrphanOptions } from '../src/services/reap-orphan-pi.js'
import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import { parseSessionHeader } from '../src/infra/pi/session-file-utils.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { ScannedSession } from '../src/services/session/types.js'
import type { SessionSummary } from '@xyz-agent/shared'

type WarnSpy = ReturnType<typeof vi.spyOn>

/** 断言辅助：warn 序列中存在含指定 kill_source 的日志行，返回该行。 */
function findKillLog(spy: WarnSpy, source: string): string | undefined {
  return spy.mock.calls
    .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
    .find((line: string) => line.includes(`kill_source=${source}`))
}

// ── K1 / K2：message-dispatcher（harness 同 silent-abort-destroy.test.ts）──

function makeMockSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: true,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

function makeDispatcherMocks(opts: { abortError?: Error } = {}) {
  const session = makeMockSession()
  const client = {
    abort: vi.fn(async () => {
      if (opts.abortError) throw opts.abortError
    }),
  } as unknown as IPiEngine

  const bus = {
    publish: vi.fn((_sid: string, _m: ServerMessage) => {}),
  } as unknown as IMessageBus

  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => session),
    detachSession: vi.fn(),
    persistSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    ensureActive: vi.fn(),
    getSession: vi.fn(() => undefined),
  }

  const pm = {
    getClient: vi.fn(() => client),
    destroySession: vi.fn(async () => {}),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, svc, pm }
}

describe('D5① K1/K2：message-dispatcher kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy

  beforeEach(() => {
    vi.clearAllMocks()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K1: forceQuit（用户强制退出）→ warn 含 kill_source=user_force_quit 与信号链', async () => {
    const { dispatcher } = makeDispatcherMocks()

    await dispatcher.forceQuit('s1')

    const line = findKillLog(warnSpy, 'user_force_quit')
    expect(line).toBeDefined()
    // 信号链要素：谁发起（用户经 session.forceQuit RPC）+ 收敛链
    expect(line).toContain('session s1')
    expect(line).toContain('forceQuit')
  })

  it('K2: abort RPC 超时强杀收口 → warn 含 kill_source=abort_timeout 与信号链', async () => {
    const { dispatcher } = makeDispatcherMocks({
      abortError: new RpcTimeoutError('abort', 60_000),
    })

    await dispatcher.abort('s1')

    const line = findKillLog(warnSpy, 'abort_timeout')
    expect(line).toBeDefined()
    // 信号链要素：user abort 触发 + RPC 超时兜底形态
    expect(line).toContain('abort')
  })
})

// ── K3 / K5：session-lifecycle（harness 同 session-lifecycle-attach.test.ts）──

const currentSourceFile = vi.hoisted(() => ({ value: '' }))

/** 与 attach 测试同款：target 经真实 parseSessionHeader 从 tmp 文件派生。 */
function makeLifecycleEnv() {
  const client = {
    getState: vi.fn(async () => ({ sessionId: 's-1' })),
    switchSession: vi.fn(async (_sessionPath: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn((id: string): ScannedSession | undefined => {
      const filePath = currentSourceFile.value
      const header = parseSessionHeader(filePath)
      if (!header || header.id !== id) return undefined
      return {
        id, filePath, cwd: header.cwd, name: 'target',
        lastModified: Date.now(), timestamp: header.timestamp, size: 0,
      } as ScannedSession
    }),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：restoreSession 开头查活跃 client；
    // undefined = 无 client → 不短路 → 走全流程 K3 清场（本组用例的目标路径）。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    trash: vi.fn(async () => undefined),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, pm }
}

describe('D5① K3/K5：session-lifecycle kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy
  let dir: string
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'kill-path-logging-'))
    filePath = join(dir, '2026-08-19T00-00-00-000Z_sess-kill-log.jsonl')
    currentSourceFile.value = filePath
    sessionsDirMock.value = dir
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-kill-log', timestamp: '2026-08-19T00:00:00.000Z', cwd: dir }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n') + '\n',
      'utf-8',
    )
  })

  afterEach(() => {
    warnSpy.mockRestore()
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('K3: restoreSession 清场杀活跃旧 pi → warn 含 kill_source=restore_clear 与信号链', async () => {
    const { lifecycle, pm } = makeLifecycleEnv()

    // 第一次 restore 注册 session 进 Map；第二次 restore 命中 existing → 清场杀旧 pi 分支
    await lifecycle.restoreSession('sess-kill-log')
    await lifecycle.restoreSession('sess-kill-log')

    const line = findKillLog(warnSpy, 'restore_clear')
    expect(line).toBeDefined()
    expect(line).toContain('sess-kill-log')
    // 信号链要素：清场 → 重开
    expect(line).toContain('safeDestroy')
    // 物理收口被调：旧 pi 确实被销毁
    expect(pm.destroySession).toHaveBeenCalled()
  })

  it('K5: delete 活跃 session → warn 含 kill_source=delete 与信号链', async () => {
    const { lifecycle, pm } = makeLifecycleEnv()

    // 先 restore 使 session 进 Map（active 分支才有 kill 对象）
    await lifecycle.restoreSession('sess-kill-log')
    warnSpy.mockClear()

    await lifecycle.delete('sess-kill-log')

    const line = findKillLog(warnSpy, 'delete')
    expect(line).toBeDefined()
    expect(line).toContain('sess-kill-log')
    // 物理收口被调：活跃 pi 确实被销毁
    expect(pm.destroySession).toHaveBeenCalledWith('sess-kill-log')
  })
})

// ── K6 / K8：process-manager（rpc-client 模块已文件级 mock）──

describe('D5① K6/K8：process-manager kill 日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy
  let pm: ProcessManager

  beforeEach(() => {
    vi.clearAllMocks()
    exitCallbacksRegistry.callbacks.length = 0
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pm = new ProcessManager('/fake-project-root')
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K6: destroyAll 批量销毁 → warn 含 kill_source=destroy_all 与会话清单', async () => {
    // cwd 仅被存入 ManagedProcess（fake rpc-client 不 spawn），无存在性要求
    await pm.createSession('sess-a', '/tmp/kill-path-logging-fake-cwd')
    await pm.createSession('sess-b', '/tmp/kill-path-logging-fake-cwd')

    await pm.destroyAll()

    const line = findKillLog(warnSpy, 'destroy_all')
    expect(line).toBeDefined()
    // 信号链要素：批量扇出 + 会话清单可追溯
    expect(line).toContain('sess-a')
    expect(line).toContain('sess-b')
    expect(pm.size).toBe(0)
  })

  it('K6 空表：无进程时 destroyAll 不打 kill 日志（零 kill 零日志）', async () => {
    await pm.destroyAll()
    expect(findKillLog(warnSpy, 'destroy_all')).toBeUndefined()
  })

  it('K8: client 异常退出回调（非 intentional destroy）→ warn 含 kill_source=exit_converge', async () => {
    await pm.createSession('sess-crash', '/tmp/kill-path-logging-fake-cwd')
    expect(exitCallbacksRegistry.callbacks.length).toBe(1)

    // 模拟 pi 进程自发退出（crash / 外部 kill，exit 143 形态）
    exitCallbacksRegistry.callbacks[0]!(143, 'terminated')

    const line = findKillLog(warnSpy, 'exit_converge')
    expect(line).toBeDefined()
    expect(line).toContain('sess-crash')
    expect(line).toContain('143')
  })
})

// ── K7：reap-orphan-pi（全依赖注入，零真实进程/等待）──

const REAP_SESSIONS_DIR = '/data/sessions-kill-log-test'
// 判据 v2（四条合取）的清单值 fixture：孤儿 argv 的 --extension 值须 ∈ 注入清单
const MARKER = '/data/staged-pi-spawn-marker'

function orphanRow(pid: number): string {
  // ps 单行：ppid=1（reparent 证据）+ 判据 v2 同形 argv（rpc + no-extensions + 清单值 --extension）
  return `  ${pid}     1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --approve --extension ${MARKER}`
}

describe('D5① K7：reap-orphan-pi 收殓日志（kill_source 结构化字段）', () => {
  let warnSpy: WarnSpy

  beforeEach(() => {
    vi.clearAllMocks()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('K7: 启动孤儿收殓命中孤儿 → warn 含 kill_source=reap_orphan 与信号链', async () => {
    const signalCalls: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' | 0 }> = []
    const options: ReapOrphanOptions = {
      dataDir: REAP_SESSIONS_DIR,
      ownPid: 999,
      killGraceMs: 50,
      listProcesses: () => Promise.resolve(orphanRow(4242)),
      readSpawnMarkers: () => [MARKER],
      signal: (pid, signal) => {
        signalCalls.push({ pid, signal })
        // SIGTERM(ok) → 探活 signal 0 抛 ESRCH（已死）→ 收殓完成
        if (signal === 0) {
          const e = new Error('kill ESRCH') as NodeJS.ErrnoException
          e.code = 'ESRCH'
          throw e
        }
      },
      delay: () => Promise.resolve(),
    }

    const result = await reapOrphanPiProcesses(options)

    expect(result.reaped).toEqual([4242])
    const line = findKillLog(warnSpy, 'reap_orphan')
    expect(line).toBeDefined()
    // 信号链要素：孤儿判定 + SIGTERM → 宽限 → SIGKILL 序列
    expect(line).toContain('SIGTERM')
    expect(signalCalls[0]).toEqual({ pid: 4242, signal: 'SIGTERM' })
  })

  it('K7 无孤儿：零收殓不打 kill 日志', async () => {
    const options: ReapOrphanOptions = {
      dataDir: REAP_SESSIONS_DIR,
      ownPid: 999,
      listProcesses: () => Promise.resolve(''),
      readSpawnMarkers: () => [MARKER],
      signal: () => {},
      delay: () => Promise.resolve(),
    }
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(findKillLog(warnSpy, 'reap_orphan')).toBeUndefined()
  })
})
