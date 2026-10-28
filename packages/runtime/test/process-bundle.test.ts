import { ShellRunner } from '../src/infra/shell-runner.js';
import type { IEventAdapter } from '../src/interfaces.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import { IPiEngine, type IProcessManager } from '../src/services/ports/pi-engine.js';
import type { ISessionStore } from '../src/services/ports/session.js';
import type { SpawnFn } from '../src/services/ports/shell-runner.js';
import { reapOrphanPiProcesses, type ReapOrphanOptions } from '../src/services/reap-orphan-pi.js';
import { RespawnFate, RespawnFateEvent, RespawnOrchestrator, onRespawnFate, type RespawnDeps } from '../src/services/session/pi-respawn.js';
import { ISessionRegisterDeps, type ILifecycleSessionOps } from '../src/services/session/session-internal.js';
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js';
import type { IManagedSessionView } from '../src/services/session/types.js';
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js';
import { SessionSummary, type ServerMessage } from '@taiji/shared';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/fork-orphan-cleanup.test.ts
// ======================================================================

// node:fs: existsSync 控制 create 路径检查（fork 用 source.cwd 判断）
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))


vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: fsMock.existsSync,
  readdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  // B7: session-lifecycle 直读/写 JSONL（stripSessionEnd 已删），需 mock 这些同步 fs 操作
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(), }
})


// node:fs/promises: unlink 是本次修复的核心观察对象
const fsPromisesMock = vi.hoisted(() => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}))


vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, unlink: fsPromisesMock.unlink, }
})


// createForkedSessionFile: spy，返回固定 forkedFilePath / forkedId
const forkMock = vi.hoisted(() => ({
  forkedFilePath: '/fake/sessions/forked.jsonl',
  forkedId: 'forked-session-id',
  createForkedSessionFile: vi.fn(async () => ({
    filePath: '/fake/sessions/forked.jsonl',
    sessionId: 'forked-session-id',
  })),
}))


vi.mock('../src/services/session/session-fork.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session/session-fork.js')>()
  return { ...actual, createForkedSessionFile: forkMock.createForkedSessionFile, }
})

function makeClient(overrides: Partial<IPiEngine> = {}): IPiEngine {
  // [W2 语义变更] mock getState 的 sessionFile 跟随最近一次 switchSession 实参——真实 pi
  // 行为（switch_session 后 get_state.sessionFile 即写目标，ADR-0063 I1）；未 switch 过时
  // 保持原固定值。session-lifecycle 的 attach 断言依赖该语义（原固定假路径会被判 I1 分裂）。
  let lastSwitchTarget: string | undefined
  return {
    getState: vi.fn(async () => ({ sessionId: 'pi-x', sessionFile: lastSwitchTarget ?? '/fake/x.jsonl' })),
    switchSession: vi.fn(async (p: string) => { lastSwitchTarget = p }),
    prompt: vi.fn(async () => ({})),
    setModel: vi.fn(async () => {}),
    getCommands: vi.fn(async () => []),
    getSessionStats: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as IPiEngine
}


interface MakeOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  /** switchSession 抛错（触发第一个 catch 块） */
  switchFails?: boolean
  /** registerSession 抛错（触发第二个 catch 块；S3 迁移后经 adapterFactory 抛错注入） */
  initFails?: boolean
}


function makeLifecycle(opts: MakeOpts = {}) {
  const client = makeClient(
    opts.switchFails
      ? { switchSession: vi.fn(async () => { throw new Error('switch_session failed') }) }
      : {},
  )

  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => {}),
    getClient: vi.fn(),
    hasClient: vi.fn(),
    rekey: vi.fn(),
  } as unknown as IProcessManager

  const session: IManagedSessionView = {
    id: forkMock.forkedId, cwd: '/repo', label: 'fork', modelId: 'p/m',
    createdAt: 1, lastActiveAt: 1, tokenCount: 0, inputTokens: 0,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false }, bashRunToken: undefined,
  }

  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    // forkSession 调 getLaunchPresetOptions 解析 preset（session-lifecycle L373）。
    // 返回 undefined = 走 fallback（getExtensionPaths/getSkillPaths），不影响 fork 清理逻辑。
    getLaunchPresetOptions: vi.fn(async () => undefined),
    findScannedSession: vi.fn(() => ({
      id: 'src', filePath: '/fake/src.jsonl', cwd: tmpdir(), name: 'src',
      lastModified: 1, timestamp: '', size: 0, outcome: null,
    })),
    // FR-20: forkSession 读源 active session 的 sessionFilePath 判断 parentSession fallback。
    // 源未注册进 Map（未活跃 / 已落盘），走 source.filePath 主路径。
    toSummary: vi.fn((): SessionSummary => ({
      id: session.id, cwd: session.cwd, label: session.label, status: 'idle',
      lastActiveAt: 1,
    })),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 消费方实际用到的全部），无强转
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore

  const sessionStore = {
    refreshAll: vi.fn(),
    // W26（D9-1）：fork 成功/失败清理路径新增目录 TTL 缓存失效调用点（ISessionStore 接口新成员）
    invalidateScanCache: vi.fn(),
    // forkSession/create 调 persistPresetBinding 写 .preset.json sidecar（session-lifecycle L170/L411）。
    // fork 清理测试不验证 sidecar 内容，noop 即可。
    persistPresetBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory；initFails 语义 = adapterFactory 抛错（原 stub
  // initializeManagedSession reject 的等价注入点，触发 registerSession reject → 第二个 catch 块）。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => {
      if (opts.initFails) throw new Error('init failed')
      return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
    },
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, pm, svc }
}


// ======================================================================
// ← test/reap-orphan-pi.test.ts
// ======================================================================

const DATA_DIR = '/data/taiji'


/** spawn 清单 fixture 值（staged 形态即可，本文件只测状态机，形态覆盖在 src 版专测）。 */
const MARKER = '/data/taiji/extensions/pi-host-internals'


function orphanRow(pid: number): string {
  // ps -axo pid=,ppid=,command= 单行：ppid=1（reparent 证据）+ 判据 v2 同形 argv
  return `  ${pid}     1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --approve --extension ${MARKER}`
}


/** 清单注入替身（编排层正常路径恒有清单；缺失/坏 JSON 的 fail-safe 分支在 src 版专测）。 */
function markers(): string[] {
  return [MARKER]
}


/** signal 注入工厂：按脚本序列响应（esrch 模拟 throw ESRCH / eperm 模拟 throw EPERM）。 */
function scriptedSignal(script: Array<'ok' | 'esrch' | 'eperm'>) {
  let call = 0
  const calls: Array<{ pid: number; signal: 'SIGKILL' }> = []
  const fn = (pid: number, signal: 'SIGKILL') => {
    calls.push({ pid, signal })
    const step = script[call] ?? 'ok'
    call += 1
    if (step === 'esrch') {
      const e = new Error(`kill ESRCH ${pid}`) as NodeJS.ErrnoException
      e.code = 'ESRCH'
      throw e
    }
    if (step === 'eperm') {
      const e = new Error(`kill EPERM ${pid}`) as NodeJS.ErrnoException
      e.code = 'EPERM'
      throw e
    }
  }
  return { fn, calls }
}


function makeOptions(script: Array<'ok' | 'esrch' | 'eperm'>, stdout = orphanRow(4242)): {
  options: ReapOrphanOptions
  calls: Array<{ pid: number; signal: 'SIGKILL' }>
} {
  const signal = scriptedSignal(script)
  const options: ReapOrphanOptions = {
    dataDir: DATA_DIR,
    ownPid: 999,
    listProcesses: () => Promise.resolve(stdout),
    signal: signal.fn,
    readSpawnMarkers: markers,
    // SIGKILL 前 pid 复用复验的 ps 依赖注入：null = ps 不可用（防线缺席按现状继续）
    readProcessStartTime: () => Promise.resolve(null),
  }
  return { options, calls: signal.calls }
}


// ======================================================================
// ← test/pi-respawn.test.ts
// ======================================================================

type RespawnTestDeps = RespawnDeps & {
  restore: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  setActive: (id: string, on: boolean) => void
}


function createDeps(overrides: Partial<RespawnDeps> = {}): RespawnTestDeps {
  const active = new Set<string>()
  const restore = vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue(undefined)
  const publish = vi.fn<(id: string, msg: ServerMessage) => void>()
  return {
    isActive: (id: string) => active.has(id),
    restore,
    publish,
    setActive: (id: string, on: boolean) => { if (on) active.add(id); else active.delete(id) },
    ...overrides,
  } as never
}


/**
 * [D3] 把 restore 替身升级为「真实 facade 契约」形态：内核成功 = spawn+attach 完成
 * （pm 有活 client）+ facade 尾部出口回调。生产装配 deps.restore = facade 本尊，
 * 不做此接线的替身（如纯 reject / 早期 join 用例）发布链断流属预期。
 */
function wireFacadeContract(deps: RespawnTestDeps, orchestrator: RespawnOrchestrator): void {
  deps.restore.mockImplementation(async (id: string) => {
    deps.setActive(id, true)
    orchestrator.onRestoreSuccess(id)
    return undefined
  })
}


// ======================================================================
// ← test/shell-runner.test.ts
// ======================================================================

/** 10MB = 10 * 1024 * 1024（与被测实现同值；用字面量保持「实现若漂移本用例红」的检查性） */
// eslint-disable-next-line no-magic-numbers -- 10MB 帽，对齐 git-executor
const CAP_BYTES = 10 * 1024 * 1024


/** 管道典型 chunk（Node stream highWaterMark 量级） */
// eslint-disable-next-line no-magic-numbers -- 64KB 管道 chunk 量级
const CHUNK_BYTES = 64 * 1024


/** 可编程 fake child（与 node:child_process.ChildProcess 一致的最小形状契约）。 */
interface FakeChild extends EventEmitter {  // oe-exempt:20261027:test:
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill(signal?: string): void
}


function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}


/** 造注入 mock spawn 的 runner；child 数据由调用方发射。 */
function setup() {
  const child = makeFakeChild()
  const spawn = vi.fn(() => child) as unknown as SpawnFn
  const runner = new ShellRunner({ spawn })
  return { child, runner, spawn }
}


/** 发射 chunkCount 个 64KB 单行 chunk（首块 HEADMARK 前缀 / 末块 TAILMARK 后缀）到指定流。 */
function emitChunkedLines(child: FakeChild, stream: 'stdout' | 'stderr', chunkCount: number): void {
  for (let i = 0; i < chunkCount; i++) {
    let line: string
    if (i === 0) line = `HEADMARK${'a'.repeat(CHUNK_BYTES - 'HEADMARK'.length - 1)}\n`
    else if (i === chunkCount - 1) line = `${'b'.repeat(CHUNK_BYTES - 'TAILMARK'.length - 1)}TAILMARK\n`
    else line = 'x'.repeat(CHUNK_BYTES - 1) + '\n'
    child[stream].emit('data', Buffer.from(line))
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('fork-orphan-cleanup', () => {
describe('W1/L5: forkSession 失败后清理孤儿 fork 文件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.existsSync.mockReturnValue(true)
    forkMock.createForkedSessionFile.mockResolvedValue({
      filePath: forkMock.forkedFilePath,
      sessionId: forkMock.forkedId,
    })
  })

  it('switchSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ switchFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('switch_session failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('registerSession 失败 → unlink forkedFilePath（清孤儿文件）', async () => {
    const { lifecycle } = makeLifecycle({ initFails: true })
    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')

    expect(fsPromisesMock.unlink).toHaveBeenCalledWith(forkMock.forkedFilePath)
  })

  it('unlink 自身失败不掩盖原始错误（catch 块静默吞 unlink 错误）', async () => {
    // unlink reject → 应被 .catch(() => {}) 吞掉，原始 init failed 错误仍正确抛出
    fsPromisesMock.unlink.mockRejectedValueOnce(new Error('unlink boom'))
    const { lifecycle } = makeLifecycle({ initFails: true })

    await expect(
      lifecycle.forkSession('src', 'entry1', true, 'fork'),
    ).rejects.toThrow('init failed')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('reap-orphan-pi', () => {
describe('killOrphan 处置序列（单孤儿全分支，SIGKILL 直杀）', () => {
  it('SIGKILL 成功 → reaped', async () => {
    const { options, calls } = makeOptions(['ok'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(result.failed).toEqual([])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 时目标已自行退出（ESRCH）→ 幂等按已回收计', async () => {
    const { options, calls } = makeOptions(['esrch'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 失败（EPERM）→ failed（best-effort 不抛）', async () => {
    const { options, calls } = makeOptions(['eperm'])
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([4242])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })

  it('SIGKILL 前 lstart 变化（pid 已复用）→ 跳过 SIGKILL 按已回收计 + warn（防线①补强）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { options, calls } = makeOptions([])
      // lstart 读取序列：处置起点 1000 → SIGKILL 前复读 2000（变化 = 原孤儿已死、pid 复用）
      const reads = [1000, 2000]
      options.readProcessStartTime = () => Promise.resolve(reads.shift() ?? 2000)
      const result = await reapOrphanPiProcesses(options)
      expect(result.reaped).toEqual([4242])
      expect(result.failed).toEqual([])
      expect(calls).toEqual([])
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('reused between scan and SIGKILL'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('SIGKILL 前 lstart 复读失败（ps 不可用返回 null）→ 不阻断，照常 SIGKILL（防线尽力而为）', async () => {
    const { options, calls } = makeOptions(['ok'])
    options.readProcessStartTime = () => Promise.resolve(null)
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4242])
    expect(result.failed).toEqual([])
    expect(calls).toEqual([{ pid: 4242, signal: 'SIGKILL' }])
  })
})
describe('reapOrphanPiProcesses 编排层', () => {
  it('无孤儿（进程表无匹配行）→ 零处置早退', async () => {
    const { options, calls } = makeOptions([], '  1     0 /sbin/launchd\n 999 1 zsh --mode rpc\n')
    const result = await reapOrphanPiProcesses(options)
    expect(result).toEqual({ scanned: 2, reaped: [], failed: [], unsupported: false })
    expect(calls).toEqual([])
  })

  it('多孤儿逐个处置（各自独立成败汇总）', async () => {
    // 两个孤儿：4242 直杀成功；4243 SIGKILL 时已自行退出（幂等按已回收计）
    const stdout = `${orphanRow(4242)}\n${orphanRow(4243)}`
    const script = scriptedSignal(['ok', 'esrch'])
    const options: ReapOrphanOptions = {
      dataDir: DATA_DIR,
      ownPid: 999,
      listProcesses: () => Promise.resolve(stdout),
      signal: script.fn,
      readSpawnMarkers: markers,
      readProcessStartTime: () => Promise.resolve(null),
    }
    const result = await reapOrphanPiProcesses(options)
    expect(result.scanned).toBe(2)
    expect([...result.reaped].sort()).toEqual([4242, 4243])
    expect(result.failed).toEqual([])
  })

  it('ps 枚举失败（无 ps / 不可执行）→ unsupported 降级返回，不抛', async () => {
    const result = await reapOrphanPiProcesses({
      dataDir: DATA_DIR,
      ownPid: 999,
      listProcesses: () => Promise.reject(new Error('spawn ps ENOENT')),
      signal: () => { throw new Error('should not be called') },
      readSpawnMarkers: markers,
    })
    expect(result.unsupported).toBe(true)
    expect(result.reaped).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('活跃子进程（ppid=ownPid）与 argv 不同形 pi 不误杀（防线② + 判据 v2）', async () => {
    const stdout = [
      ` 4242 999 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --extension ${MARKER}`, // 本实例活跃子进程
      ` 4243   1 /usr/bin/node /pi/cli.js --mode rpc --no-extensions --extension /other/data/extensions/user-ext`, // 值不在清单（他人/用户路径）
      ` 4244   1 /usr/bin/node /pi/cli.js --mode rpc --extension ${MARKER}`, // 无 --no-extensions（AGENTS.md 实测模板形态）
      orphanRow(4245), // 唯一真孤儿
    ].join('\n')
    const { options, calls } = makeOptions(['ok', 'esrch'], stdout)
    const result = await reapOrphanPiProcesses(options)
    expect(result.reaped).toEqual([4245])
    expect(calls.every((c) => c.pid === 4245)).toBe(true)
  })

  it('Windows 平台降级 unsupported（不枚举不处置）', async () => {
    // platform 是 getter，vi.spyOn + defineProperty 双保险（vitest 4 下 spyOn get 可用）
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const listProcesses = vi.fn(() => Promise.resolve('should not be called'))
      const result = await reapOrphanPiProcesses({ dataDir: DATA_DIR, ownPid: 1, listProcesses, readSpawnMarkers: markers })
      expect(result.unsupported).toBe(true)
      expect(listProcesses).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-respawn', () => {
describe('RespawnOrchestrator（崩溃上报 + 惰性恢复 join）', () => {
  // respawn 终态命运收集（notify-once D5 信号源断言范围）：onRespawnFate 是模块级订阅
  //（组合根单消费方），beforeEach 挂 afterEach 退订——订阅残留会跨用例串扰。
  let fates: RespawnFateEvent[] = []
  let unsubFate: (() => void) | undefined
  beforeEach(() => {
    fates = []
    unsubFate = onRespawnFate((e) => { fates.push(e) })
  })
  afterEach(() => {
    unsubFate?.()
    unsubFate = undefined
  })
  /** 该 session 的 fate 事件序列（按序，含重复） */
  const fatesOf = (sessionId: string): RespawnFate[] =>
    fates.filter((e) => e.sessionId === sessionId).map((e) => e.fate)

  it('crashExit：崩溃显式上报（terminal 发声）+ 登记 crashed；恢复成功经 facade 尾部出口推恰好一条 session.restored', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    orchestrator.crashExit('s1')
    // ADR-0122：不再自动恢复——restore 不被调用
    expect(deps.restore).not.toHaveBeenCalled()
    // 崩溃发声（显式上报）
    expect(fatesOf('s1')).toEqual(['terminal'])

    // 用户手动恢复（restore 内核 = facade 契约）：成功出口发布恰好一条
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = deps.publish.mock.calls[0] as [string, ServerMessage]
    expect(sid).toBe('s1')
    expect(msg.type).toBe('session.restored')
    expect(msg.payload).toMatchObject({ sessionId: 's1', attempts: 1 })
  })

  it('crashExit 时 in-flight 恢复在跑 → 静默（recovered，session 将复活）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    // 惰性恢复在途（不 resolve）
    let resolveRestore!: () => void
    deps.restore.mockImplementation(() => new Promise<void>((r) => { resolveRestore = r }))
    const restoring = orchestrator.ensureRestored('s1')
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['recovered'])
    resolveRestore()
    await restoring
  })

  it('crashExit 对活跃 session no-op（防御位：exit 链正常已清 processes）', () => {
    const deps = createDeps()
    deps.setActive('s1', true)
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['recovered'])
    // 未登记 crashed：恢复成功不发布
    orchestrator.onRestoreSuccess('s1')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('join（ensureRestored）：并发调用等待同一 in-flight Promise，restore 内核只跑一次', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    let resolveRestore!: () => void
    deps.restore.mockImplementation(() => new Promise<void>((r) => { resolveRestore = r }))

    const p1 = orchestrator.ensureRestored('s1')
    const p2 = orchestrator.ensureRestored('s1')
    expect(deps.restore).toHaveBeenCalledTimes(1)
    resolveRestore()
    await Promise.all([p1, p2])
    expect(deps.restore).toHaveBeenCalledTimes(1)
  })

  it('join 失败传导：原恢复失败时 join 方得到同一失败，注册表清空后可重试', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    let rejectRestore!: (e: Error) => void
    deps.restore.mockImplementation(() => new Promise<void>((_, rej) => { rejectRestore = rej }))

    const p1 = orchestrator.ensureRestored('s1')
    const p2 = orchestrator.ensureRestored('s1')
    rejectRestore(new Error('restore boom'))
    await expect(p1).rejects.toThrow('restore boom')
    await expect(p2).rejects.toThrow('restore boom')

    // 注册表已清空：再次调用重新执行 restore
    deps.restore.mockResolvedValue(undefined)
    await orchestrator.ensureRestored('s1')
    expect(deps.restore).toHaveBeenCalledTimes(2)
  })

  it('无崩溃上下文的恢复：静默不发布（普通懒 spawn / startup-reattach 形态）', async () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    wireFacadeContract(deps, orchestrator)
    await orchestrator.ensureRestored('s1')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('cancel / cancelAll：核销崩溃登记，后续恢复成功不发布', () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    orchestrator.crashExit('s2')
    orchestrator.cancel('s1')
    orchestrator.cancelAll()
    orchestrator.onRestoreSuccess('s1')
    orchestrator.onRestoreSuccess('s2')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('crashExit 重复调用：重复登记幂等（Set 语义），恢复成功仍只发布一条', () => {
    const deps = createDeps()
    const orchestrator = new RespawnOrchestrator(deps)
    orchestrator.crashExit('s1')
    orchestrator.crashExit('s1')
    expect(fatesOf('s1')).toEqual(['terminal', 'terminal'])
    orchestrator.onRestoreSuccess('s1')
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('shell-runner', () => {
describe('ShellRunner G3 累积字节帽（CappedStreamAccumulator）', () => {
  it('帽内小输出原样透传：无截断标记，stdout/stderr 保留原始字符', async () => {
    const { child, runner, spawn } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    child.stdout.emit('data', Buffer.from('installing package done\n'))
    child.stderr.emit('data', Buffer.from('warn: something\n'))
    child.emit('close', 0)

    const r = await p
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('installing package done\n')
    expect(r.stderr).toBe('warn: something\n')
    expect(r.stdout).not.toContain('truncated')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stdout 超 10MB：截断保留头尾 + 标记 dropped 字节 + 结果串有界', async () => {
    const { child, runner } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    // 192 × 64KB = 12MB > 10MB 帽
    const chunkCount = 192
    emitChunkedLines(child, 'stdout', chunkCount)
    child.emit('close', 0)

    const r = await p
    // 头保留（起点上下文）+ 尾保留（末尾结论）
    expect(r.stdout.startsWith('HEADMARK')).toBe(true)
    expect(r.stdout.endsWith('TAILMARK\n')).toBe(true)
    // 截断标记在中段：dropped 字节数可观测
    const markerIdx = r.stdout.indexOf('...[shell-runner] stdout truncated: dropped ')
    expect(markerIdx).toBeGreaterThan(0)
    const droppedMatch = r.stdout.match(/dropped (\d+) bytes/)
    expect(droppedMatch).not.toBeNull()
    expect(Number(droppedMatch![1])).toBeGreaterThan(0)
    // 结果串有界：头 8MB + 尾 2MB + 单 chunk 超调松弛 + 标记 ≈ 10MB 量级，远低于未帽 12MB
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(CAP_BYTES + CHUNK_BYTES + 512)
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(8 * 1024 * 1024)
    // stderr 独立未超帽 → 无标记
    expect(r.stderr).toBe('')
  })

  it('stderr 独立同帽：截断标记 stream 标识为 stderr', async () => {
    const { child, runner } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    emitChunkedLines(child, 'stderr', 192)
    child.emit('close', 0)

    const r = await p
    expect(r.stderr).toContain('...[shell-runner] stderr truncated: dropped ')
    expect(Buffer.byteLength(r.stderr)).toBeLessThan(CAP_BYTES + CHUNK_BYTES + 512)
    // stdout 未超帽 → 原样（空）
    expect(r.stdout).toBe('')
  })

  it('onOutput 流式通道不在帽内：截断时逐行回调仍全量送达', async () => {
    const { child, runner } = setup()
    const lines: Array<{ line: string; stream: 'stdout' | 'stderr' }> = []
    const p = runner.execute({
      scriptPath: '/tmp/setup.sh',
      cwd: '/tmp',
      timeout: 60_000,
      onOutput: (line, stream) => lines.push({ line, stream }),
    })
    const chunkCount = 192
    emitChunkedLines(child, 'stdout', chunkCount)
    child.emit('close', 0)

    const r = await p
    // 结果串已截断（有标记）……
    expect(r.stdout).toContain('[shell-runner] stdout truncated')
    // ……但流式通道收到全部行（消费即释散，不受帽影响）
    expect(lines).toHaveLength(chunkCount)
    expect(lines.every((l) => l.stream === 'stdout' && l.line.length === CHUNK_BYTES - 1)).toBe(true)
  })
})
});
});

// ======================================================================
// ← rpc-client-streaming-behavior.test.ts
// ======================================================================

// ── stdin.write 捕获 ──
const writeCalls: unknown[][] = []

const fakeStdin = {
  write: vi.fn((...args: unknown[]) => {
    writeCalls.push(args)
    return true
  }),
  once: vi.fn(),
  end: vi.fn(),
  on: vi.fn(), // RT-2#1：wireProcessHandlers 现注册 stdin 'error' listener
}


// ── readline 接口 mock ──
// ── stdout emitter（D10：LF-only 读取器桥接 'data'，替代旧 readline 的 rlEmitter）──
const stdoutEmitter = new EventEmitter()


// ── Mock modules ──
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    // exit listener 捕获：kill 即死语义（微任务驱动）短路 killPiProcess grace 真实等待
    const exitListeners: Array<(...args: unknown[]) => void> = []
    const proc = {
      stdin: fakeStdin,
      stdout: stdoutEmitter,
      stderr: new EventEmitter(),
      kill: vi.fn((_signal?: NodeJS.Signals | number) => {
        queueMicrotask(() => exitListeners.splice(0).forEach((h) => h(0)))
        return true
      }),
      pid: 12345,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'exit') exitListeners.push(handler)
        return proc
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const i = exitListeners.indexOf(handler)
        if (event === 'exit' && i >= 0) exitListeners.splice(i, 1)
        return proc
      }),
    }
    return proc
  }),
}))


vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: () => '/tmp/fake-sessions',
  getPiAgentDir: () => '/tmp/fake-pi-agent',
  // spawn-markers（rpc-client start 链，recordSpawnMarkers 默认 dataDir = getConfigDir()）
  // 会真实落盘 <dataDir>/run/pi-spawn-markers.json：读 globalSetup 注入的 env（fs-guard
  // 白名单第 2 项），写进 tmp 数据目录——与生产实现（sharedGetDataDir 读同一 env）同语义
  getConfigDir: () => process.env.TAIJI_AGENT_DATA_DIR ?? '/tmp/fake-data',
}))


vi.mock('../src/infra/pi/pi-provider-store.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'test-model' }),
}))


vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))


vi.mock('../src/utils/errors.js', () => ({
  RpcTimeoutError: class extends Error {
    constructor(public commandType: string, public timeoutMs: number) {
      super(`RPC timeout: ${commandType}`)
      this.name = 'RpcTimeoutError'
    }
  },
}))

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rpc-client-streaming-behavior', () => {
// ── Tests ──
describe('RpcClient.prompt streamingBehavior 透传（U1: session-delivery）', () => {
  let RpcClient: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    vi.clearAllMocks()
    writeCalls.length = 0
    stdoutEmitter.removeAllListeners()
    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClient = mod.RpcClient
  })

  /** 从 stdin.write 调用中解析最近一条 JSON 命令 */
  function lastWrittenCommand(): Record<string, unknown> {
    expect(writeCalls.length).toBeGreaterThan(0)
    const raw = writeCalls[writeCalls.length - 1]![0] as string
    return JSON.parse(raw.trim())
  }

  /** 启动 client */
  async function startClient(): Promise<InstanceType<typeof RpcClient>> {
    const client = new RpcClient({ cwd: '/tmp', sessionId: 'test-sid' })
    await client.start()
    return client
  }

  /** 发 prompt 并返回 stdin.write 捕获的命令 JSON，同时自动发 RPC 响应 */
  async function promptAndCapture(
    client: InstanceType<typeof RpcClient>,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<Record<string, unknown>> {
    writeCalls.length = 0

    const promptPromise = client.prompt(content, images, streamingBehavior)

    const cmd = lastWrittenCommand()

    // 模拟 pi RPC 响应（D10：投给 stdout 的 LF-only 读取器 data 入口，整行 + \n）
    stdoutEmitter.emit('data', JSON.stringify({ type: 'response', id: cmd.id, success: true }) + '\n')

    await promptPromise
    return cmd
  }

  it('U1: 不带 streamingBehavior 时字段不出现（非 undefined 字符串）', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'hello')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('hello')
    expect(cmd).not.toHaveProperty('streamingBehavior')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="steer" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'steer me', undefined, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('steer me')
    expect(cmd.streamingBehavior).toBe('steer')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="followUp" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'follow up', undefined, 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('follow up')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U1: images + streamingBehavior 可独立组合', async () => {
    const client = await startClient()
    const images = [{ data: 'base64data', mimeType: 'image/png' }]
    const cmd = await promptAndCapture(client, 'with image', images, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('with image')
    expect(cmd.images).toEqual([{ type: 'image', data: 'base64data', mimeType: 'image/png' }])
    expect(cmd.streamingBehavior).toBe('steer')
  })

  it('U1: 空 images 数组不传 images 字段 + streamingBehavior 仍透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'no images', [], 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('no images')
    expect(cmd).not.toHaveProperty('images')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U2: 端口签名 arity——prompt 接受 3 个参数（content, images?, streamingBehavior?）', () => {
    // 编译期类型测试：IPiEngine.prompt 的参数数量由 TypeScript 保证，
    // 运行期断言 RpcClient.prompt 的 length（3 = content + images + streamingBehavior）。
    // 第 4/5 参（SendCommandOptions maintenance / timeoutMs 不限时档）已随 ADR-0122
    // 防御机制清查退役（空闲回收与 RPC 墙钟整体删除），arity 由 5 回落为 3。
    const client = new RpcClient({ cwd: '/tmp', sessionId: 'arity-check' })
    expect(client.prompt.length).toBe(3)
  })

  it('U2: 端口签名 arity——只传 images 不传 streamingBehavior 时，images 透传但 streamingBehavior 不出现', async () => {
    const client = await startClient()
    const images = [{ data: 'img', mimeType: 'image/jpeg' }]
    const cmd = await promptAndCapture(client, 'image only', images)

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('image only')
    expect(cmd.images).toEqual([{ type: 'image', data: 'img', mimeType: 'image/jpeg' }])
    expect(cmd).not.toHaveProperty('streamingBehavior')
  })
})
});
