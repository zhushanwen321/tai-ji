import { translate } from '../infra/pi/event-adapter.js';
import type { PiEvent, PiSessionEntry } from '../infra/pi/pi-protocol.js';
import { ProcessManager } from '../infra/pi/process-manager.js';
import type { IMessageBroker, ISessionService } from '../interfaces.js';
import { IProcessManager, type IPiEngine } from '../services/ports/pi-engine.js';
import { EventInterpreter } from '../services/session/event-interpreter.js';
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js';
import { SessionManagerHandler } from '../transport/session-manager-handler.js';
import type { SegmentsMetadataFile, ServerMessage } from '@taiji/shared';
import { SESSION_MANAGER_MARKER, type SessionManagerAction } from '@zhushanwen/extension-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/process-manager-exit.test.ts
// ======================================================================

// ── Mocks（与 rpc-client-bash.test.ts 同构）──────────────────────

/** ps 采样心跳计数（vi.hoisted 供 mock 工厂引用；MF-3 测试的行为观测量）。 */
const psProbeCalls = vi.hoisted(() => ({ count: 0 }))


const procExitHandlers: Array<(code: number | null) => void> = []


const fakeProc = {
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
    // RT-2#1 起 rpc-client 在源头接线 stdin 流错误（stdin.on('error')），mock 面同步补齐
    on: vi.fn(),
  },
  // 模拟真实进程：收到 SIGTERM/SIGKILL 后异步死亡（信号致死 → exit code null）。
  // 让 destroySession 的 kill() 快速收尾（不必等 2s SIGKILL 兜底超时）。
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


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: () => fakeProc,
  // findPiExecutable 的 PATH 探测（execSync('which pi')）：抛错走 fallback，不执行真实命令
  execSync: () => {
    throw new Error('execSync mocked: not found')
  },
  // MF-3 采样心跳探针：ProcessTableRing.listAllProcesses 的 ps 执行体。每次 ps 调用
  //（= 一次采样动作）计数 +1，测试以计数增长断言「环在转、有采样」这个行为范围，
  // 不窥 ring 内部定时器实现。
  execFile: (_file: unknown, _args: unknown, _opts: unknown, cb: (err: null, stdout: string) => void) => {
    psProbeCalls.count += 1
    queueMicrotask(() => cb(null, '    1     1 /sbin/launchd\n'))
  }, }
})


vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // findPiExecutable 所有探测点（dev resources / nvm / common locations）均未命中 → 走 'pi' fallback
  return { ...actual, existsSync: () => false, readdirSync: () => [] }
})


vi.mock('@taiji/shared', async (importOriginal) => {
  // U3 起 rpc-client/process-manager 链路经 infra/spawn-env 门面消费 shared 的
  // buildOutboundChildEnv；mock 需保留真实导出，仅收窄白名单前缀获得可控基座
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})


vi.mock('@taiji/shared/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared/paths')>()
  return { ...actual, getDataDir: () => '/mock/home/.taiji' }
})


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


vi.mock('../infra/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/logger.js')>()
  return { ...actual, createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // 7b17e240f：retargetSessionLog（rekey 迁 tee）的 import 面同步——no-op 即可，
  // 本测试不校验迁移行为
  migratePiSessionLogTree: () => {},
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
  // signal-forensics（process-manager 退出链 import）的落点门：测试态恒 false——
  // 无落点不采样，exit 主链的 Map 清理/回调通知不受取证影响
  isPiCrashLogEnabled: () => false,
  // 族③根因修复（W3.5）：withEphemeralPi finally 的 ephemeral 树回收——mock 面随
  // process-manager import 面同步（本测试不走该路径，no-op 即可）
  EPHEMERAL_SESSION_ID_PREFIX: 'ephemeral-',
  removeEphemeralSessionTree: () => {}, }
})


// ── Helpers ──────────────────────────────────────────────────────

/** 模拟 pi 进程异常死亡：OS 发出 exit 事件（kill -9 → code null） */
function emitProcExit(code: number | null = null): void {
  for (const h of [...procExitHandlers]) h(code)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-manager-exit', () => {
// ── Tests ────────────────────────────────────────────────────────

describe('ProcessManager onExit 死亡通知', () => {
  let pm: ProcessManager

  beforeEach(async () => {
    // R3 隔离：本测试的 hermetic 前提是 findPiExecutable 走 'pi' fallback，但该函数
    // 先读 process.env.TAIJI_AGENT_PACKAGED 判打包分支（find-pi-executable.ts:26），
    // 打包版太极的 agent 会话内执行 vitest 时该变量泄入测试进程（P1 同款机制）→
    // findPackagedPi throw。显式压平为非打包态，维持设计意图。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    procExitHandlers.length = 0
    fakeProc.kill.mockClear()
    pm = new ProcessManager('/mock/project-root')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rekey 后进程异常退出：清理两个 Map，onSessionExit 收到 rekey 后的 id（非 tempId）', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    // create 路径：tempId spawn → pi 返回真实 sessionId 后 rekey 改键
    await pm.createSession('temp-id-1', '/project')
    pm.rekey('temp-id-1', 'pi-session-id-real')
    expect(pm.hasClient('pi-session-id-real')).toBe(true)

    emitProcExit(null) // 模拟 kill -9

    // Map 清理：按当前 id（rekey 后）删除，无残留
    expect(pm.getClient('pi-session-id-real')).toBeUndefined()
    expect(pm.hasClient('pi-session-id-real')).toBe(false)
    expect(pm.getClient('temp-id-1')).toBeUndefined()
    expect(pm.size).toBe(0)

    // 死亡通知必须带真实 id——闭包捕获的 tempId 正是僵尸 session 根因
    expect(exitEvents).toEqual([{ sessionId: 'pi-session-id-real', code: null, stderr: '' }])
  })

  it('intentional destroy：destroySession 后的 exit 事件不触发 onSessionExit', async () => {
    const exitEvents: Array<{ sessionId: string; code: number | null; stderr: string }> = []
    pm.onSessionExit((sessionId, code, stderr) => exitEvents.push({ sessionId, code, stderr }))

    await pm.createSession('s1', '/project')
    expect(pm.hasClient('s1')).toBe(true)

    // destroySession：先删 Map 再 kill（kill mock 异步触发 exit，属主动清理路径）
    await pm.destroySession('s1')
    expect(pm.hasClient('s1')).toBe(false)

    // 主动 kill 的 exit（异步已触发）+ 迟到的重复 exit 均不得通知上层
    await Promise.resolve() // 排空 kill mock 的 queueMicrotask
    emitProcExit(null)
    emitProcExit(1)

    expect(exitEvents).toEqual([])
  })

  it('exit 回调逐个隔离：单 listener 抛错不阻断其余 listener（code-harden RT-4#1）', async () => {
    const received: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 上层多播：listener A 抛错（模拟收敛链异常）不得连坐 listener B 的死亡通知
      pm.onSessionExit(() => { throw new Error('listener A exploded') })
      pm.onSessionExit((sessionId) => { received.push(sessionId) })

      await pm.createSession('s1', '/project')
      emitProcExit(null)

      expect(received).toEqual(['s1'])
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exit callback failed'), expect.any(String))
    } finally {
      errorSpy.mockRestore()
    }
  })
})
// ── 信号取证环 restart 路径（MF-3）──────────────────────────────

/**
 * MF-3 回归：createSession 的取证环 start 原在 restart 分支（destroySession）之前，
 * 而 destroySession 尾部在受管 pi 清零时停环——单 session 重启路径下环被停掉后无人
 * 再 start，新进程生命周期零采样。修复后 start 移到 destroy 之后（入册后再幂等重申）：
 * 重启结束环必须恢复运行并有采样。
 *
 * 断言用 ps 采样心跳计数（行为范围：环在转的外显后果就是周期性 ps 采样），不窥 ring
 * 内部定时器。start() 的首帧采样在 createSession 解析前已同步计数，此后计数继续增长
 * 只能来自间隔定时器——「重启结束后计数仍在增长」即证明环恢复运行。
 */
describe('ProcessManager 信号取证环 restart 路径（MF-3）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // 采样间隔压到 20ms：心跳在测试时窗内可观测（缺省 1.5s 太慢）。环在构造时读 env，
    // 必须先 stub 再构造 ProcessManager。
    vi.stubEnv('TAIJI_SIGNAL_WATCH_INTERVAL_MS', '20')
    psProbeCalls.count = 0
    pm = new ProcessManager('/mock/project-root')
  })

  afterEach(async () => {
    // 收尾停环：20ms 采样定时器不跨测试残留（unref 不保活事件循环，但心跳计数会串）
    await pm.destroyAll()
    vi.unstubAllEnvs()
  })

  it('单 session 重启（同 id 再 createSession）结束后环恢复采样：ps 心跳持续增长', async () => {
    // 首启：环 start 即采一帧，此后按间隔续采
    await pm.createSession('s1', '/project')
    expect(psProbeCalls.count).toBeGreaterThan(0)

    const before = psProbeCalls.count
    await vi.waitFor(() => expect(psProbeCalls.count).toBeGreaterThan(before), { interval: 1 })

    // 重启路径：同 id 再 createSession → destroySession（受管清零 → 环停）→ 再 spawn。
    // 修复前：start 已在 destroy 前消费，环停在 destroy 尾部无人再 start，此后计数冻结，
    // 本断言以超时红灯暴露「重启后零采样」的静默停摆。
    await pm.createSession('s1', '/project')

    const atRestartEnd = psProbeCalls.count
    await vi.waitFor(() => expect(psProbeCalls.count).toBeGreaterThan(atRestartEnd), { interval: 1 })
  })

  it('受管清零停环后心跳冻结；新 session 到来环再度启动（stop 后可再 start 的一般正确性）', async () => {
    await pm.createSession('a', '/project')
    await pm.destroySession('a') // 受管清零 → 环停（空闲 runtime 零开销）

    const frozen = psProbeCalls.count
    // 负向断言（环已停：无心跳）无完成信号可等——分片采样替换单点盲等，
    // 总观察窗量级不变（8×10ms），每片让出事件循环后断言一次
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 10))
      expect(psProbeCalls.count).toBe(frozen) // 环已停：无心跳
    }

    // 新 session 到来 → start 再武装
    await pm.createSession('b', '/project')
    const atStart = psProbeCalls.count
    await vi.waitFor(() => expect(psProbeCalls.count).toBeGreaterThan(atStart), { interval: 1 })
  })
})
});

// ======================================================================
// ← src/__tests__/session-history-incremental.test.ts
// ======================================================================

// spy 尾读 fallback（「不走尾读」的判定依据）
vi.mock('../services/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/session-history.js')>()
  return {
    ...actual,
    getHistoryTailFromFile: vi.fn(async () => ({ messages: [], truncated: true, loadedTurns: 0, totalTurnsEstimate: 0 })),
  }
})

const { getHistoryTailFromFile } = await import('../services/session-history.js')


// SUT 在 vi.mock 之后 import（session-service 内部引用 mocked 模块）
const { SessionService } = await import('../services/session/session-service.js')

const { HistoryRebuildCache, SessionHistoryReader, mergeIncrementalMessages } = await import('../services/session/history-rebuild-cache.js')

// Fix-1/7 回归用真实重建（不 mock rebuildHistoryFromEntries，验证孤儿回填补丢失工具输出）
const { rebuildHistoryFromEntries } = await import('../infra/pi/entry-tree-builder.js')


/**
 * 最小 PiSessionEntry（rebuildHistoryFromEntries 是直通 mock，只消费 id/parentId）。
 * parentId 默认 null——增量 delta 的首条 entry 必须显式传「上次缓存 leafId」，
 * 否则触发 Fix-2 parentId 不变量检测（丢缓存全量重建），非预期路径。
 */
function entry(id: string, parentId: string | null = null): PiSessionEntry {
  return { id, type: 'message', parentId, timestamp: '2026-08-16T00:00:00.000Z' } as unknown as PiSessionEntry
}


function msg(piEntryId: string) {
  return {
    id: `m-${piEntryId}`,
    role: 'user' as const,
    content: `content-${piEntryId}`,
    status: 'complete' as const,
    piEntryId,
    timestamp: 1,
  }
}


interface GetEntriesCall {  // oe-exempt:20261027:test:
  since?: string
}


/**
 * 构造 SessionService + 可编排的 getEntries mock。
 * getEntriesScript 按调用序出队：每项是 {data} 成功响应或 Error（reject）。
 * 每次调用记录 since 参数（断言增量路径的传递）。
 * opts.realRebuild = true 时 rebuildHistoryFromEntries 用真实实现（entry-tree-builder），
 * 供 Fix-1/7 窗口语义回归（不 mock 重建，验证孤儿回填与 compaction 并入）。
 */
function makeService(
  getEntriesScript: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>,
  opts?: { realRebuild?: boolean },
) {
  const calls: GetEntriesCall[] = []
  const client = {
    getEntries: vi.fn(async (since?: string) => {
      calls.push({ since })
      const step = getEntriesScript.shift()
      if (step instanceof Error) throw step
      if (!step) throw new Error('getEntries script exhausted')
      return step
    }),
  } as unknown as IPiEngine

  const broker = { broadcast: vi.fn((_m: ServerMessage) => {}) } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const sessionStore = {
    // 直通 mock：entry.id → Message.piEntryId（getHistory 的分支逻辑与重建实现解耦）；
    // realRebuild 时换真实 entry-tree-builder（含孤儿 toolResult 收集，Fix-1）
    rebuildHistoryFromEntries: opts?.realRebuild
      ? (entries: PiSessionEntry[]) => rebuildHistoryFromEntries(entries, null)
      : vi.fn((entries: PiSessionEntry[]) => ({
          messages: entries.map((e) => msg(e.id)),
          orphanToolResults: [],
        })),
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => null),
    persistSessionEnd: vi.fn(),
  } as never

  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => null } as never,
    sessionStore,
    { pruneStaleCache: vi.fn() } as never,
    {} as never,
  )
  // [session-cold-switch-perf u1] messageBus 记录器：后台全量重建任务无外部完成信号，
  // 完成回执 = session.historyCacheReady 帧（publishToBus → messageBus.publish），
  // 用例据此 vi.waitFor 等任务终态（消除「后台任务在途 vs 已完成」的时序竞态）。
  const busPublishes: ServerMessage[] = []
  svc.setMessageBus({
    publish: (_sid: string, m: ServerMessage) => { busPublishes.push(m) },
    // removeSessionEntry 汇聚链消费的其余 IMessageBus 方法（本用例只观测 publish，其余 no-op）
    subscribe: vi.fn(() => ({ snapshot: [], stateSnapshot: [], lastSeq: 0 })),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
    forgetSession: vi.fn(),
  } as never)
  return { svc, calls, busPublishes }
}

/**
 * 等待后台全量重建任务终态（historyCacheReady 帧到达 ≥ count 条）。
 * 后台任务 fire-and-forget，无 await 句柄；帧是它唯一的完成回执（成功/失败都发）。
 */
async function waitForCacheReady(busPublishes: ServerMessage[], count: number): Promise<void> {
  await vi.waitFor(() => {
    const ready = busPublishes.filter((m) => (m as { type?: string }).type === 'session.historyCacheReady')
    expect(ready.length).toBeGreaterThanOrEqual(count)
  }, { interval: 2 })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-history-incremental', () => {
beforeEach(() => {
  vi.clearAllMocks()
})
// ── 单元：HistoryRebuildCache（D6-1 容量帽 LRU）────────────────

describe('HistoryRebuildCache', () => {
  it('超容量帽驱逐最久未访问的 session 条目（帽 8，对齐 renderer LRU 窗口）', () => {
    const cache = new HistoryRebuildCache()
    const e = () => ({ leafId: `leaf-${Math.random()}`, messages: [], truncated: false })
    for (let i = 0; i < 10; i++) cache.set(`s-${i}`, e())
    expect(cache.size).toBe(8)
    // 最久的 s-0/s-1 被驱逐，最新的 s-2..s-9 保留
    expect(cache.get('s-0')).toBeUndefined()
    expect(cache.get('s-1')).toBeUndefined()
    expect(cache.get('s-9')).toBeDefined()
  })

  it('get 刷新 LRU 位置——访问过的条目不被后续超帽驱逐', () => {
    const cache = new HistoryRebuildCache(2)
    const e = () => ({ leafId: 'l', messages: [], truncated: false })
    cache.set('a', e())
    cache.set('b', e())
    cache.get('a') // a 移到最近使用
    cache.set('c', e()) // 超帽驱逐 b（最久未访问），a 保留
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('delete 清除指定 session 条目', () => {
    const cache = new HistoryRebuildCache()
    cache.set('s', { leafId: 'l', messages: [], truncated: false })
    cache.delete('s')
    expect(cache.get('s')).toBeUndefined()
  })
})
// ── 单元：mergeIncrementalMessages（D6-3 piEntryId 去重）────────

describe('mergeIncrementalMessages', () => {
  it('同 piEntryId 跳过（不重复），新 piEntryId 追加尾部', () => {
    const cached = [msg('e1'), msg('e2')]
    const incremental = [msg('e2'), msg('e3')] // e2 已在缓存（compact/异常时序的重复兜底）
    const merged = mergeIncrementalMessages(cached, incremental)
    expect(merged.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    // 不修改入参
    expect(cached).toHaveLength(2)
    expect(incremental).toHaveLength(2)
  })

  it('无 piEntryId 的增量消息防御性追加（宁可重复不可丢消息）', () => {
    const cached = [msg('e1')]
    const noId = { id: 'm-x', role: 'user' as const, content: 'x', status: 'complete' as const, timestamp: 1 }
    const merged = mergeIncrementalMessages(cached, [noId])
    expect(merged).toHaveLength(2)
  })

  it('幂等：同批增量重复合并无副作用', () => {
    const cached = [msg('e1')]
    const inc = [msg('e2')]
    const once = mergeIncrementalMessages(cached, inc)
    const twice = mergeIncrementalMessages(once, inc)
    expect(twice.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
  })
})
// ── 集成：SessionService.getHistory 三分支（D6 + R-12 + D6-4）────

describe('SessionService.getHistory —— D6 历史增量', () => {
  it('① [态2] 首次尾读首屏+后台全量铺缓存 → 第二次缓存命中走 since 增量合并（增量条目 < 全量）', async () => {
    // 后台全量 5 条，leafId=leaf-1；第二次调用走 since 增量 2 条（<5），leafId=leaf-2。
    // e6.parentId=leaf-1 满足 Fix-2 不变量（正常 append：delta 首条 parent = 缓存 leafId）
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1'), entry('e2'), entry('e3'), entry('e4'), entry('e5')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e6', 'leaf-1'), entry('e7', 'e6')], leafId: 'leaf-2' } },
    ])

    const first = await svc.getHistory('s1')
    // [态2] 首屏 = 尾读窗口（mock 空页），不阻塞等全量；后台用在场进程全量（无 since）
    expect(first.truncated).toBe(true)
    expect(calls[0]?.since).toBeUndefined()
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1)
    await waitForCacheReady(busPublishes, 1) // 后台全量落缓存

    const second = await svc.getHistory('s1')
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
    expect(second.truncated).toBe(false)
    // 第二次缓存命中走 since=leaf-1 增量（增量窗口 2 条 < 全量 5 条）
    expect(calls[1]?.since).toBe('leaf-1')
    expect(second.messages).toHaveLength(7) // 5 缓存 + 2 增量（piEntryId 去重合并）
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // 态1 增量路径不经尾读
  })

  it('② R-12：增量空 entries 短路——直接返回缓存，不走尾读 fallback，getEntries 只调一次', async () => {
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } },
      { data: { entries: [], leafId: 'leaf-1' } }, // 空增量 = leafId 未变 = 缓存新鲜
    ])

    await svc.getHistory('s2') // [态2] 尾读首屏 + 后台全量铺缓存
    await waitForCacheReady(busPublishes, 1)
    const second = await svc.getHistory('s2') // [态1] 缓存命中 → 空增量短路
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(second.truncated).toBe(false)
    expect(calls[1]?.since).toBe('leaf-1')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // 仅首次态2尾读；R-12 短路不走尾读
  })

  it('② R-12（后台全量侧）：无缓存 + pi 返回空 entries → 后台任务发空快照成功帧，不写缓存', async () => {
    const { svc, calls, busPublishes } = makeService([{ data: { entries: [], leafId: null } }])
    const result = await svc.getHistory('s3')
    // [态2] 首屏 = 尾读窗口（mock 空页）；后台全量拉到空 entries → 权威空视图
    expect(result.truncated).toBe(true)
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1)
    await waitForCacheReady(busPublishes, 1)
    expect((busPublishes[0] as { payload?: { snapshotLeafId?: string } }).payload?.snapshotLeafId).toBe('')
    expect(calls[0]?.since).toBeUndefined() // 后台全量（无 since）
  })

  it('③ D6-4：增量 "Entry not found" → 丢缓存 → 全量重新拉取并覆盖缓存', async () => {
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('Entry not found: leaf-1'), // since 失效（防御场景：缓存跨 pi 进程存活）
      { data: { entries: [entry('e1'), entry('e2'), entry('e3')], leafId: 'leaf-3' } }, // 全量重新拉取
      { data: { entries: [entry('e4', 'leaf-3')], leafId: 'leaf-4' } }, // 验证缓存已被全量结果覆盖（新基线 leaf-3）
    ])

    await svc.getHistory('s4') // [态2] 尾读首屏 + 后台全量 → 缓存 {leaf-1, [e1]}
    await waitForCacheReady(busPublishes, 1)
    const afterFallback = await svc.getHistory('s4') // [态1] Entry not found → 丢缓存 → 分支3同步全量 → {leaf-3, [e1,e2,e3]}
    expect(afterFallback.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    expect(calls[1]?.since).toBe('leaf-1')
    expect(calls[2]?.since).toBeUndefined() // fallback 是全量（无 since）
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // fallback 是同步全量，不经尾读（仅首次态2尾读）

    // 缓存基线已更新为 leaf-3：下次走 since=leaf-3 增量
    const third = await svc.getHistory('s4')
    expect(calls[3]?.since).toBe('leaf-3')
    expect(third.messages).toHaveLength(4)
  })

  it('其他错误（非 Entry not found）→ 尾读降级，缓存不动（下次重试仍走 since）', async () => {
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('RPC command "get_entries" timed out after 60000ms'),
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 缓存未丢：仍以 leaf-1 为基线走增量
    ])

    await svc.getHistory('s5') // [态2] 尾读首屏（尾读第1次）+ 后台全量铺缓存
    await waitForCacheReady(busPublishes, 1)
    const degraded = await svc.getHistory('s5') // [态1] 增量超时 → 尾读降级（尾读第2次）
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(2)
    expect(degraded.truncated).toBe(true) // 尾读路径的截断标志（mock 尾读返回 truncated:true）
    expect(calls[1]?.since).toBe('leaf-1')

    // 缓存未被尾读结果覆盖：下次 getHistory 仍走 since 增量（基线还是 leaf-1）
    await svc.getHistory('s5')
    expect(calls[2]?.since).toBe('leaf-1')
  })

  it('⑤ lastLeafId 生命周期：removeSessionEntry（session 删除/pi 退出汇聚点）清除缓存 → 下次后台全量', async () => {
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 清除后的全量（脚本顺序：清后再 getHistory）
      { data: { entries: [], leafId: 'leaf-2' } }, // 重建后缓存命中：空增量短路（验证新基线）
    ])

    await svc.getHistory('s6') // [态2] 尾读首屏 + 后台全量 → 缓存 leaf-1
    await waitForCacheReady(busPublishes, 1)
    expect(calls[0]?.since).toBeUndefined()

    svc.removeSessionEntry('s6') // pi 进程退出/删除汇聚点 → 缓存清除

    await svc.getHistory('s6') // 无缓存 → [态2] 尾读 + 后台全量（脚本第2步）
    await waitForCacheReady(busPublishes, 2)
    expect(calls[1]?.since).toBeUndefined() // 清除后的重建走全量

    const third = await svc.getHistory('s6') // 新缓存生效：since=leaf-2 空增量短路 → 返回 [e2]
    expect(calls[2]?.since).toBe('leaf-2')
    expect(third.messages.map((m) => m.piEntryId)).toEqual(['e2'])
  })

  it('离线路径（无 RPC client）：走尾读，不读不写缓存', async () => {
    // pm.getClient 返回 undefined 的独立环境
    const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
    const pm = { onSessionExit: vi.fn(), getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const svc = new SessionService(
      pm, broker,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/test', {} as never, {} as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn() } as never, {} as never,
    )
    const result = await svc.getHistory('s-offline')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ messages: [], truncated: true, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('Fix-2：delta 首条 parentId ≠ 缓存 leafId（branch）→ 丢缓存全量重新拉取，不合出混合历史', async () => {
    // pi append-only + branch（extension navigateTree）后：since=旧 leaf 不报 "Entry not found"，
    // 但新分支首条 entry 的 parentId 是 branch 点（e0）而非旧 leaf（e2）→ 不变量检测 → 全量
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'e2' } }, // 全量，缓存 {e2, [e1,e2]}
      { data: { entries: [entry('b1', 'e0'), entry('b2', 'b1')], leafId: 'b2' } }, // 增量：head parentId=e0 ≠ e2
      { data: { entries: [entry('e1'), entry('e2'), entry('b1'), entry('b2')], leafId: 'b2' } }, // 全量重新拉取（新分支完整历史）
    ])

    await svc.getHistory('s-branch') // [态2] 尾读首屏 + 后台全量铺缓存
    await waitForCacheReady(busPublishes, 1)
    const second = await svc.getHistory('s-branch') // [态1] 不变量 violation → 丢缓存 → 同步全量

    expect(calls[1]?.since).toBe('e2') // 第二拍确实走了增量（since 传递正确）
    expect(calls[2]?.since).toBeUndefined() // 不变量 violation → 丢缓存 → 全量重新拉取
    // 返回的是全量重新拉取结果（新分支权威视图），不是「缓存老分支尾 + 新分支」的拼接
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'b1', 'b2'])
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // 仅首次态2尾读；后续全量是同步路径

    // 缓存基线已被全量结果覆盖：下次走 since=b2 增量
    // （不需要第三次脚本——空 delta 短路即证明 since=b2 传递；此处直接断言第三次调用参数）
  })

  it('Fix-5：并发 getHistory 复用同一 inflight——后台全量只触发一次，两调用结果一致', async () => {
    // 脚本只有 1 个响应：若无 inflight/单例复用，第二个并发调用会 script exhausted reject
    const { svc, calls, busPublishes } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'e2' } },
    ])

    const [a, b] = await Promise.all([svc.getHistory('s-race'), svc.getHistory('s-race')])
    expect(calls).toHaveLength(1) // 后台全量只触发一次
    expect(a).toEqual(b) // 两调用共享同一 promise（尾读首屏窗口）
    expect(a.truncated).toBe(true) // [态2] 首屏 = 尾读 mock 窗口
    await waitForCacheReady(busPublishes, 1)
    expect(calls[0]?.since).toBeUndefined() // 后台全量（无 since）
  })
})
// ── 集成：增量窗口语义（W20 review Fix-1/7，真实 rebuildHistoryFromEntries）────

describe('SessionService.getHistory —— 增量窗口语义（真实重建，不 mock rebuildHistoryFromEntries）', () => {
  /** 真实 pi message entry（type:'message'，透传 message 体）。 */
  function messageEntry(id: string, parentId: string | null, message: unknown): PiSessionEntry {
    return { type: 'message', id, parentId, timestamp: '2026-08-16T00:00:00.000Z', message } as unknown as PiSessionEntry
  }

  it('Fix-1：delta 以 toolResult 开头 → 孤儿回填到缓存 assistant 的 toolCall，输出不丢', async () => {
    // 场景：后台 session 生成中 getHistory 写缓存，leafId 切在 assistant(toolCalls) 与其
    // toolResults 之间（缓存 leafId=e2，但 t1 的 toolResult 尚未 append）→ 下次增量窗口
    // 以 toolResult(e3) 开头 → convertPiHistory 窗口局部配对失败 → 无 Fix-1 时 t1 永久无输出
    const userMsg = { role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 1 }
    const assistantToolCallMsg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
      timestamp: 2,
    }
    const toolResultMsg = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'RESULT-OUTPUT' }],
      timestamp: 3,
    }
    const assistantTextMsg = { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4 }

    const { svc, busPublishes } = makeService([
      // 全量：user(e1) + assistant(e2, toolCall t1 无输出)，leafId=e2（切点场景基线）
      { data: { entries: [messageEntry('e1', null, userMsg), messageEntry('e2', 'e1', assistantToolCallMsg)], leafId: 'e2' } },
      // 增量：toolResult(e3) 开头（head parentId=e2 满足 Fix-2 不变量）+ assistant(e4)
      { data: { entries: [messageEntry('e3', 'e2', toolResultMsg), messageEntry('e4', 'e3', assistantTextMsg)], leafId: 'e4' } },
    ], { realRebuild: true })

    await svc.getHistory('s-fix1') // [态2] 尾读首屏 + 后台全量铺缓存（真实重建）
    await waitForCacheReady(busPublishes, 1)
    const second = await svc.getHistory('s-fix1') // [态1] 增量合并 + 孤儿回填

    // 合并结果：user(e1) + assistant(e2) + assistant(e4)（toolResult 不产独立消息）
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e4'])
    // 核心断言：缓存中 assistant(e2) 的 toolCall t1 拿到了窗口孤儿回填的输出
    const assistant = second.messages.find((m) => m.piEntryId === 'e2')
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.toolCalls?.[0]?.id).toBe('t1')
    expect(assistant?.toolCalls?.[0]?.output).toBe('RESULT-OUTPUT')
  })

  it('Fix-7：delta 以 compaction entry 开头 → compaction 系统消息正常并入缓存', async () => {
    const userMsg = { role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 1 }
    const assistantTextMsg = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 }
    const compactionEntry = {
      type: 'compaction',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-08-16T00:00:01.000Z',
      summary: 'compacted-history',
      tokensBefore: 1000,
    } as unknown as PiSessionEntry

    const { svc, busPublishes } = makeService([
      { data: { entries: [messageEntry('e1', null, userMsg)], leafId: 'e1' } },
      { data: { entries: [compactionEntry, messageEntry('e3', 'e2', assistantTextMsg)], leafId: 'e3' } },
    ], { realRebuild: true })

    await svc.getHistory('s-fix7') // [态2] 尾读首屏 + 后台全量铺缓存（真实重建）
    await waitForCacheReady(busPublishes, 1)
    const second = await svc.getHistory('s-fix7') // [态1] 增量：compaction 并入

    // user + compaction 系统消息 + assistant（compaction 重建消息无 piEntryId → 防御追加）
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0]?.piEntryId).toBe('e1')
    const compactionMsg = second.messages[1]
    expect(compactionMsg?.role).toBe('system')
    expect(compactionMsg?.content).toBe('compacted-history')
    expect(compactionMsg?.compactionSummary?.tokensBefore).toBe(1000)
    expect(second.messages[2]?.piEntryId).toBe('e3')
  })
})
// ── 集成：SessionHistoryReader reclaim 驱逐（memory-leak-remediation §3.3-B8 候选 C）──

describe('SessionHistoryReader —— reclaim 驱逐', () => {
  /**
   * 直构 SessionHistoryReader（SUT = reader 编排 + 缓存实例；
   * mock 分层同 makeService：getEntries 脚本出队 + rebuildHistoryFromEntries 直通）。
   */
  function makeReader(
    script: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>,
  ) {
    const calls: GetEntriesCall[] = []
    const client = {
      getEntries: vi.fn(async (since?: string) => {
        calls.push({ since })
        const step = script.shift()
        if (step instanceof Error) throw step
        if (!step) throw new Error('getEntries script exhausted')
        return step
      }),
    } as unknown as IPiEngine
    const pm = {
      onSessionExit: vi.fn(),
      getClient: vi.fn(() => client),
    } as unknown as IProcessManager
    const sessionStore = {
      rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({
        messages: entries.map((e) => msg(e.id)),
        orphanToolResults: [],
      })),
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
    } as never
    const cache = new HistoryRebuildCache()
    const reader = new SessionHistoryReader({ pm, sessionStore }, cache)
    return { reader, cache, calls }
  }

  it('reclaim 驱逐缓存条目——重激活走全量重建并写回新缓存（后续增量命中）', async () => {
    const full = { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } }
    const { reader, cache, calls } = makeReader([full, { ...full }, { data: { entries: [], leafId: 'leaf-1' } }])

    await reader.getHistory('s-re') // [态2] 尾读首屏 + 后台全量 → 写缓存
    await vi.waitFor(() => expect(cache.size).toBe(1)) // 后台任务终态 = 缓存落定（直构无 bus，以 cache.size 为信号）

    reader.onSessionReclaimed('s-re') // reclaim 驱逐（reclaimManagedSession 经 deps 接线）
    expect(cache.size).toBe(0)
    expect(cache.get('s-re')).toBeUndefined()

    await reader.getHistory('s-re') // 重激活：无缓存 → [态2] 尾读 + 后台全量 → 写回新缓存
    await vi.waitFor(() => expect(cache.size).toBe(1))

    const third = await reader.getHistory('s-re') // 后续：新缓存生效（since 增量 + 空 delta 短路）
    expect(calls.map((c) => c.since)).toEqual([undefined, undefined, 'leaf-1'])
    expect(third.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(2) // 两次态2尾读首屏；态1增量不经尾读
  })
})
});

// ======================================================================
// ← src/__tests__/session-manager-e2e-probe.test.ts
// ======================================================================

/** pi stdout JSONL 行的边界解析形态（与 rpc-client 的行解析边界一致，窄化到本探针实际用到的子集） */
interface UiResponseWireLine {  // oe-exempt:20261027:test:
  type: string
  id: string
  value?: string
  cancelled?: boolean
}


/**
 * 模拟 pi 子进程 IO 层。stdinLines 是 runtime 回写 pi stdin 的 JSONL 行缓冲；
 * sendExtensionUiResponse 的 wire 映射与真实 rpc-client（rpc-client.ts）一致——
 * 本探针只覆盖 handler 会走到的两个分支：null → cancelled / select → value。
 */
class FakePiProcessIo {
  readonly stdinLines: string[] = []

  sendExtensionUiResponse(id: string, response: unknown, _method?: string): void {
    const payload: UiResponseWireLine = response === null
      ? { type: 'extension_ui_response', id, cancelled: true }
      : { type: 'extension_ui_response', id, value: String(response) }
    this.stdinLines.push(JSON.stringify(payload))
  }
}


function makeSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    label: 'fake-session',
    cwd: '/test/cwd',
    status: 'active',
    lastActiveAt: 1_755_000_000_000,
    // 归属校验默认材料：发起方一律 'sid-parent'，目标 s1 默认是其 managed child
    spawnSource: 'agent',
    parentAgentSessionId: 'sid-parent',
    ...overrides,
  }
}


/** fake pi client：delivery port.send 的终点（ensureActive 返回值） */
function makeFakeClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}


/** fake session 运行时视图：delivery isIdle 判定 + D7 置位副作用的落点 */
function makeFakeSessionView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    cwd: '/test/cwd',
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    lastActiveAt: 1_755_000_000_000,
    // W3：handler 的 modelId 读点从 summary 改到注册表记录（IManagedSessionView.modelId
    // 双写缓存），fake 记录带同值缓存。
    modelId: 'openai/gpt-4',
    ...overrides,
  }
}


/** SessionService 数据层 fake：管理 action 服务方法的默认返回值（形状对齐
 * ISessionService 契约；create 为裸 vi.fn() 无默认返回，由用例侧 mockReturnValue 提供） */
function makeFakeSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    create: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false, rejected: false }),
    ensureActive: vi.fn().mockResolvedValue(makeFakeClient()),
    getSession: vi.fn().mockReturnValue(makeFakeSessionView()),
    getHistory: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      truncated: false,
    }),
    getSummary: vi.fn().mockReturnValue(makeSummary()),
    listPersistedSessions: vi.fn().mockReturnValue([
      { cwd: '/test/cwd', sessions: [makeSummary({ id: 'agent-1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }), makeSummary({ id: 'user-1', spawnSource: 'user' })] },
    ]),
    abort: vi.fn().mockResolvedValue(undefined),
    // 受理成功后清旧终态 sidecar（session-manager-send-sidecar-stale）
    clearSessionOutcome: vi.fn(),
    getRpcClient: vi.fn(),
    getActiveSessionIds: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ISessionService
}


/** 构造 pi stdout 上的 extension_ui_request JSONL 行（session-manager extension 的序列化形态） */
function buildUiRequestLine(requestId: string, action: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: [JSON.stringify({ action, params })],
  })
}


/** 构造 malformed 请求行：options[0] 不是合法 JSON（U4-E3 场景） */
function buildMalformedUiRequestLine(requestId: string): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: ['invalid json'],
  })
}


interface E2ePipeline {  // oe-exempt:20261027:test:
  pi: FakePiProcessIo
  /** dispatch 单条 pi stdout JSONL 行：解析 → 真实 translate → 真实 interpret → 等 handler 完成 */
  dispatch(piStdoutLine: string): Promise<void>
  /** 前端 UI 超时注册入口（session-manager 路径不应触发——「不弹前端对话框」断言用） */
  onExtensionUIRequest: ReturnType<typeof vi.fn>
}


/**
 * 组装 e2e 链路。接线与组合根一致（server.ts 的 SessionManagerHandler 构造 +
 * handleSessionManagerRequest fire-and-forget 委托 + EventInterpreter opts 注入），
 * 只把 pi 子进程 IO 与 SessionService 换成 fake。sd-u5 起 delivery 用真实 registry
 * 装配（fake sessionService 提供 getSession/ensureActive 材料层）。
 */
function makeE2ePipeline(sessionService: ISessionService): E2ePipeline {
  const pi = new FakePiProcessIo()
  const onExtensionUIRequest = vi.fn()
  const delivery = createSessionDeliveryRegistry({
    getSession: (sid) => sessionService.getSession(sid),
    ensureActive: (sid) => sessionService.ensureActive(sid),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => null,
  })
  const handler = new SessionManagerHandler({
    sessionService,
    delivery,
    sendExtensionUiResponse: (sessionId, requestId, response, method) =>
      pi.sendExtensionUiResponse(requestId, response, method),
    broadcastSessionList: () => {},
  })
  let handling: Promise<void> = Promise.resolve()
  const interpreter = new EventInterpreter('sid-parent', {
    send: () => {},
    onExtensionUIRequest,
    onSessionManagerRequest: (requestId, sessionId, action, params) => {
      // fire-and-forget 委托（与 server.handleSessionManagerRequest 一致）；promise 暴露给测试 await
      handling = handler.handle(requestId, sessionId, action as SessionManagerAction | '__malformed__', params)
    },
  })
  return {
    pi,
    onExtensionUIRequest,
    async dispatch(piStdoutLine: string): Promise<void> {
      const event = JSON.parse(piStdoutLine) as PiEvent
      interpreter.interpret(translate(event, 'sid-parent'))
      await handling
    },
  }
}


/** 读取 runtime 回写的唯一一条 extension_ui_response 行并解析（多于一条即 fail） */
function readSingleResponse(pi: FakePiProcessIo): UiResponseWireLine {
  expect(pi.stdinLines, `expected exactly 1 response line, got: ${JSON.stringify(pi.stdinLines)}`).toHaveLength(1)
  const parsed = JSON.parse(pi.stdinLines[0]) as UiResponseWireLine
  expect(parsed.type).toBe('extension_ui_response')
  return parsed
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-manager-e2e-probe', () => {
describe('U4-E1 create e2e probe', () => {
  it('create 全链路：marker request → 真实 handler 创建 session + 直投初始 prompt + 回写 sessionId', async () => {
    const client = makeFakeClient()
    const sessionService = makeFakeSessionService({
      create: vi.fn().mockResolvedValue(makeSummary({ id: 'child-1', spawnSource: 'agent' })),
      ensureActive: vi.fn().mockResolvedValue(client),
    })
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine('req-create', 'create', {
      cwd: '/test/cwd', label: 'E2E 测试执行', prompt: 'run the suite',
    }))

    // create 以 spawnSource='agent' + parentAgentSessionId=父 session 调用（服务端注入，不信任请求侧）
    expect(sessionService.create).toHaveBeenCalledWith('/test/cwd', 'E2E 测试执行', expect.objectContaining({
      spawnSource: 'agent',
      parentAgentSessionId: 'sid-parent',
    }))
    // 初始 prompt 直投到新 session（sd-u5：delivery.sendDirect → ensureActive + prompt，不走内核队列）
    expect(sessionService.ensureActive).toHaveBeenCalledWith('child-1')
    expect(client.prompt).toHaveBeenCalledWith('run the suite', undefined, undefined)
    // 回写 select value 通道，结果 JSON 含 sessionId/status
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value as string)).toEqual(expect.objectContaining({ sessionId: 'child-1', status: 'created' }))
    // 不触发前端 UI（不经 renderer 对话框）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })
})
describe('U4-E2 manage e2e probe', () => {
  it('marker 翻译：select+SESSION_MANAGER_MARKER → session-manager-ui kind（强类型 action/params）', () => {
    const events = translate(
      JSON.parse(buildUiRequestLine('req-send', 'send', { sessionId: 's1', prompt: 'hello' })) as PiEvent,
      'sid-parent',
    )
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('send')
    expect(uiEvent.params).toEqual({ sessionId: 's1', prompt: 'hello' })
    // 不发前端广播：session-manager 请求由 handler 内部消化，extension.ui_request 广播
    // 会被前端 CompanionBand 渲染成无 options 的空壳对话框（2026-08-22 修复回归锁）
    expect(events.some((e) => e.kind === 'message')).toBe(false)
  })

  it.each([
    {
      action: 'send',
      params: { sessionId: 's1', prompt: 'hello' },
      // sd-u5：send 走 delivery.sendChecked——idle 直投受理即回，busy 入队也回 queued；
      // notify-once：probe 未带 notifyId → willNotify:false
      expected: { queued: true, willNotify: false },
    },
    {
      action: 'history',
      params: { sessionId: 's1' },
      expected: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        truncated: false,
      },
    },
    {
      action: 'status',
      params: { sessionId: 's1' },
      expected: { status: 'active', modelId: 'openai/gpt-4', undeliveredResults: 0 },
    },
    {
      action: 'list',
      params: {},
      expected: {
        sessions: [
          {
            id: 'agent-1',
            label: 'fake-session',
            cwd: '/test/cwd',
            status: 'active',
            spawnSource: 'agent',
            parentAgentSessionId: 'sid-parent',
          },
        ],
        undeliveredResults: 0,
      },
    },
    {
      action: 'abort',
      params: { sessionId: 's1' },
      expected: { success: true },
    },
  ] as const)('$action 全链路：pi stdout 行 → 真实 handler → extension_ui_response 回写 pi stdin', async ({ action, params, expected }) => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine(`req-${action}`, action, params))

    // 1. 回写唯一一条 response，value 是 action 结果 JSON（真实 handler 的 respond 序列化）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe(`req-${action}`)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value ?? 'null')).toEqual(expected)

    // 2. 路由正确：走 onSessionManagerRequest（handler 直接回写），不注册前端 UI 超时
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('history tailTurns 截断：只保留最后一个 user turn 起的消息（真实 handler 逻辑）', async () => {
    const messages = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
    ]
    const pipeline = makeE2ePipeline(makeFakeSessionService({
      getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
    }))

    await pipeline.dispatch(buildUiRequestLine('req-history-tail', 'history', { sessionId: 's1', tailTurns: 1 }))

    const resp = readSingleResponse(pipeline.pi)
    expect(JSON.parse(resp.value ?? 'null')).toEqual({
      messages: [
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ],
      truncated: true,
    })
  })
})
describe('U4-E3 malformed e2e probe', () => {
  it('options[0] 非法 JSON → translate 标记 __malformed__ → handler 回 cancelled，不走正常 switch', async () => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildMalformedUiRequestLine('req-malformed'))

    // 1. 回写 cancelled（真实 handler malformed 兜底：sendExtensionUiResponse(null, 'select')）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe('req-malformed')
    expect(resp.cancelled).toBe(true)
    expect(resp.value).toBeUndefined()

    // 2. 不触发任何 SessionService 调用（malformed 在 switch 之前兜底返回）
    expect(sessionService.sendMessage).not.toHaveBeenCalled()
    expect(sessionService.getHistory).not.toHaveBeenCalled()
    expect(sessionService.getSummary).not.toHaveBeenCalled()
    expect(sessionService.listPersistedSessions).not.toHaveBeenCalled()
    expect(sessionService.abort).not.toHaveBeenCalled()

    // 3. 不弹前端 UI（onSessionManagerRequest 直接消化，不注册前端超时）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('marker 翻译：options[0] 非法 JSON 时 action 仍为 __malformed__（不 fall-through 普通分支）', () => {
    const events = translate(JSON.parse(buildMalformedUiRequestLine('req-m')) as PiEvent, 'sid-parent')
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('__malformed__')
    expect(uiEvent.params).toEqual({})
  })

  it('marker 翻译：action 不在 SESSION_MANAGER_ACTIONS 枚举 → 折叠 __malformed__ 哨兵（枚举检查）', () => {
    // JSON 合法但 action 是非枚举值——与上一条（JSON 解析失败）不同的 malformed 输入维度
    const events = translate(JSON.parse(buildUiRequestLine('req-enum-guard', 'evil', {})) as PiEvent, 'sid-parent')
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('__malformed__')
    expect(uiEvent.params).toEqual({})
  })
})
});

// ======================================================================
// ← src/__tests__/session-history-four-state.test.ts
// ======================================================================

// [session-cold-switch-perf u1] getHistory 四态分派 + 后台全量任务单例 + 尾读 sidecar 回填。
// SUT = SessionHistoryReader 直构（mock 分层同 makeReader：getEntries 脚本出队/挂起 +
// rebuildHistoryFromEntries 直通；尾读走文件级 vi.mock 的 getHistoryTailFromFile，按用例
// mockImplementation 覆盖）。fixture 对拍用例走真实 tailReadHistory + 真实 entry 树重建
//（vi.mock 工厂 spread actual，tailReadHistory 未被覆盖）。
const fs4 = await import('node:fs')
const os4 = await import('node:os')
const path4 = await import('node:path')
const { parseJsonl: parseJsonl4 } = await import('../utils/jsonl.js')
const { tailReadHistory: tailReadHistoryReal } = await import('../services/session-history.js')
const { PiSessionStore } = await import('../infra/pi/session-store.js')
const { getAttachmentsDir: getAttachmentsDir4 } = await import('@taiji/shared/paths')
const { HISTORY_BUDGET: HISTORY_BUDGET4 } = await import('@taiji/shared')
const { applyHistoryBudgetWindow } = await import('../services/session/history-rebuild-cache.js')

/** 后台 get_entries 挂起的放行材料（resolve 值 = 脚本步）。 */
interface GetEntriesScriptStep {  // oe-exempt:20261029:test:
  data?: { entries: PiSessionEntry[]; leafId: string | null }
  error?: Error
  /** hang=true：getEntries 返回永不自行 settle 的 promise，由 releaseHanging 手动放行。 */
  hang?: true
}

/** 事件驱动启动的排队等待上限（负向断言用分片采样，正向断言用 vi.waitFor）。 */
const PUMP_WAIT_MS = 10

/**
 * 四态分派直构环境：client 在场性可切换（态 2↔态 3 演进）、getEntries 脚本可控
 *（成功/失败/挂起）、historyCacheReady 帧出口记录、btw 判别器可注入。
 */
function makeFourStateReader(config?: {
  clientPresent?: boolean
  btwFile?: string
  script?: GetEntriesScriptStep[]
}) {
  const calls: GetEntriesCall[] = []
  const hangingResolvers: Array<(step: GetEntriesScriptStep) => void> = []
  const client = {
    getEntries: vi.fn((since?: string) => {
      calls.push({ since })
      const step = config?.script?.shift()
      if (!step) return Promise.reject(new Error('getEntries script exhausted'))
      if (step.error) return Promise.reject(step.error)
      if (step.hang) {
        return new Promise<GetEntriesScriptStep>((resolve) => { hangingResolvers.push(resolve) })
      }
      return Promise.resolve(step)
    }),
  } as unknown as IPiEngine

  let clientVisible = config?.clientPresent ?? false
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (clientVisible ? client : undefined)),
  } as unknown as IProcessManager

  const sessionStore = {
    rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({
      messages: entries.map((e) => msg(e.id)),
      orphanToolResults: [],
    })),
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => null),
    persistSessionEnd: vi.fn(),
  } as never

  const publishes: Array<ServerMessage<'session.historyCacheReady'>> = []
  const cache = new HistoryRebuildCache()
  const reader = new SessionHistoryReader(
    {
      pm,
      sessionStore,
      ...(config?.btwFile !== undefined && { resolveBtwThreadFile: () => config.btwFile }),
      publishToBus: (_sid, m) => publishes.push(m as ServerMessage<'session.historyCacheReady'>),
    },
    cache,
  )
  return {
    reader,
    cache,
    calls,
    publishes,
    client,
    setClientVisible(v: boolean): void { clientVisible = v },
    releaseHanging(step: GetEntriesScriptStep): void {
      const resolve = hangingResolvers.shift()
      if (!resolve) throw new Error('no hanging getEntries to release')
      resolve(step)
    },
  }
}

describe('SessionHistoryReader —— getHistory 四态分派与后台全量任务（session-cold-switch-perf u1）', () => {
  const defaultTail = async () => ({ messages: [], truncated: true, loadedTurns: 0, totalTurnsEstimate: 0 })

  beforeEach(() => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(defaultTail)
    vi.mocked(getHistoryTailFromFile).mockClear() // 共享文件级 mock：清前段用例的调用计数
  })
  afterEach(() => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(defaultTail)
  })

  // ── 态 1：缓存命中 → 现状快路径 ──

  it('态1 缓存命中走现状增量快路径：空增量短路返回，不触发尾读、不启动后台任务、不发帧', async () => {
    const h = makeFourStateReader({ clientPresent: true, script: [{ data: { entries: [], leafId: 'leaf-1' } }] })
    h.cache.set('s4-state1', { leafId: 'leaf-1', messages: [msg('e1')], truncated: false })

    const result = await h.reader.getHistory('s4-state1')

    expect(result.messages.map((m) => m.piEntryId)).toEqual(['e1'])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.since).toBe('leaf-1') // 现状 since 增量
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
    expect(h.publishes).toHaveLength(0)
  })

  // ── 态 2：缓存 miss + 进程在场 → 尾读首屏 + 后台全量 ──

  it('态2 缓存miss+进程在场：尾读首屏立即返回，后台用在场进程全量重建写缓存并发 historyCacheReady 帧', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => ({
      messages: [msg('tail-1')], truncated: true, loadedTurns: 2, totalTurnsEstimate: 9,
    }))
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-2' } }],
    })

    const first = await h.reader.getHistory('s4-state2')

    // 首屏 = 尾读窗口（不被全量重建阻塞）
    expect(first.messages.map((m) => m.piEntryId)).toEqual(['tail-1'])
    expect(first.truncated).toBe(true)
    // 后台任务已用在场进程触发（无 since 全量）
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.since).toBeUndefined()
    // 后台完成：写缓存 + 发帧（快照基准 = 重建快照末条 entry id）
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1))
    expect(h.cache.get('s4-state2')?.leafId).toBe('leaf-2')
    expect(h.publishes[0]).toMatchObject({
      type: 'session.historyCacheReady',
      payload: { sessionId: 's4-state2', snapshotLeafId: 'leaf-2' },
    })
  })

  // ── 态 3：缓存 miss + 进程不在 → 尾读 + 待启动登记 + 事件驱动启动 ──

  it('态3 缓存miss+进程不在：尾读首屏返回+登记待启动（分派自身不spawn不消费槽），switch侧激活事件驱动启动', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => ({
      messages: [msg('tail-2')], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1,
    }))
    const h = makeFourStateReader({
      clientPresent: false, // 冷启动首点态
      script: [{ data: { entries: [entry('e1')], leafId: 'leaf-1' } }],
    })

    const first = await h.reader.getHistory('s4-state3')
    expect(first.messages.map((m) => m.piEntryId)).toEqual(['tail-2'])
    expect(h.calls).toHaveLength(0) // getHistory 分派自身不启动任务（无进程不 spawn）

    // switch 侧进程获取完成（client 注册）→ onSessionActivated 挂点 → startPendingRebuild
    h.setClientVisible(true)
    h.reader.startPendingRebuild('s4-state3')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    expect(h.calls[0]?.since).toBeUndefined() // 全量重建
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1))
    expect(h.cache.get('s4-state3')?.leafId).toBe('leaf-1')
  })

  it('态3 btw 线排除登记：死线回放尾读返回即止（无 switch 侧完成时点），startPendingRebuild no-op', async () => {
    const h = makeFourStateReader({ clientPresent: false, btwFile: '/tmp/nonexistent-btw-line.jsonl' })

    const first = await h.reader.getHistory('s4-btw-line')
    expect(first.messages).toEqual([]) // 线文件缺失 → warn 空页（现状离线 btw 分支语义）

    // 线被继续（进程在场）后 startPendingRebuild：无登记 → no-op（btw 线从不登记）
    h.setClientVisible(true)
    h.reader.startPendingRebuild('s4-btw-line')
    // 负向断言无完成信号可等——分片采样替代盲等（8×10ms 先例）
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, PUMP_WAIT_MS))
      expect(h.calls).toHaveLength(0)
      expect(h.publishes).toHaveLength(0)
    }
  })

  // ── 态 4：尾读 IO 失败 ──

  it('态4 尾读IO失败+进程在场：挂后台任务等全量返回（promise 恒有终态，不无限等待）', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => { throw new Error('EIO: tail read failed') })
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ hang: true, data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-x' } }],
    })

    const pending = h.reader.getHistory('s4-state4')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1)) // 后台任务已启动
    h.releaseHanging({ data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-x' } })

    const result = await pending // 挂靠返回全量窗口（= 现状等待语义）
    expect(result.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(h.cache.get('s4-state4')?.leafId).toBe('leaf-x')
  })

  it('态4 后台全量失败 → 按现状失败语义 reject（不无限等待），失败帧带 error', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => { throw new Error('EIO') })
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ error: new Error('get_entries failed') }],
    })

    await expect(h.reader.getHistory('s4-state4f')).rejects.toThrow(/background rebuild failed/)
    expect(h.publishes).toHaveLength(1)
    expect(h.publishes[0]?.payload.error).toBeDefined() // 失败帧（renderer 收失败帧不重拉）
  })

  it('态4 尾读IO失败+进程不在：按现状失败语义返回（登记待启动但无完成时点，不等待）', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => { throw new Error('EACCES: offline tail read') })
    const h = makeFourStateReader({ clientPresent: false })

    await expect(h.reader.getHistory('s4-state4o')).rejects.toThrow('EACCES')
    expect(h.calls).toHaveLength(0) // 不等待（任务未启动）
  })

  // ── 后台任务单例（验收③）──

  it('验收③ 同 sessionId 重复派单挂同一在途任务：不触发第二次全量重建，帧只发一条', async () => {
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ hang: true, data: { entries: [entry('e1')], leafId: 'leaf-1' } }],
    })

    await h.reader.getHistory('s4-single') // 首派单：尾读返回，任务在途（挂起）
    expect(h.calls).toHaveLength(1)

    const second = await h.reader.getHistory('s4-single') // 二次派单：缓存仍无 → 复用在途任务
    expect(h.calls).toHaveLength(1) // 关键断言：无第二次 getEntries（单例）
    h.releaseHanging({ data: { entries: [entry('e1')], leafId: 'leaf-1' } })

    await vi.waitFor(() => expect(h.publishes).toHaveLength(1)) // 单例 → 恰一条帧
    expect(h.cache.get('s4-single')?.leafId).toBe('leaf-1')
  })

  // ── 游标翻页挂靠（设计：态 2 叠加点）──

  it('游标翻页与在途后台任务并发：挂同一 promise 复用，不重复触发全量重建', async () => {
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ hang: true, data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-2' } }],
    })

    await h.reader.getHistory('s4-cursor') // 任务在途（挂起）
    const pagePromise = h.reader.getHistory('s4-cursor', { cursor: 'e2' }) // 翻页挂靠在途任务
    h.releaseHanging({ data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-2' } })

    const page = await pagePromise
    expect(h.calls).toHaveLength(1) // 复用，无第二次 getEntries
    expect(page.messages.map((m) => m.piEntryId)).toEqual(['e1']) // 锚点（e2）之前的窗口
  })

  // ── snapshotLeafId 版本对账（验收④）──

  it('验收④ 过期快照不覆盖：任务在途期间缓存被活跃链写入（更新基线），完成时保留现缓存、帧照发', async () => {
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ hang: true, data: { entries: [entry('stale-1')], leafId: 'leaf-stale' } }],
    })

    await h.reader.getHistory('s4-stale') // 任务在途
    // 模拟任务在途期间活跃链写入缓存（leafId 非 null = 带增量校验的新鲜基线）
    h.cache.set('s4-stale', { leafId: 'leaf-live', messages: [msg('live-1')], truncated: false })

    h.releaseHanging({ data: { entries: [entry('stale-1')], leafId: 'leaf-stale' } })
    await vi.waitFor(() => expect(h.publishes).toHaveLength(1))

    expect(h.cache.get('s4-stale')?.leafId).toBe('leaf-live') // 过期快照不覆盖
    expect(h.publishes[0]?.payload.snapshotLeafId).toBe('leaf-stale') // 帧照发（renderer 按 snapshotLeafId 对账）
  })

  // ── 会话删除丢弃在途结果（验收⑤）──

  it('验收⑤ 会话删除后在途任务结果丢弃：不写缓存、不发帧、挂靠方按失败语义收敛（有终态）', async () => {
    vi.mocked(getHistoryTailFromFile).mockImplementation(async () => { throw new Error('EIO') })
    const h = makeFourStateReader({
      clientPresent: true,
      script: [{ hang: true, data: { entries: [entry('e1')], leafId: 'leaf-1' } }],
    })

    const pending = h.reader.getHistory('s4-disposed') // 态 4 挂靠等待
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))

    h.reader.onSessionDisposed('s4-disposed') // 删除挂点（removeSessionEntry 汇聚链直调）
    h.releaseHanging({ data: { entries: [entry('e1')], leafId: 'leaf-1' } })

    await expect(pending).rejects.toThrow(/disposed/) // 挂靠方失败语义（不无限等待）
    // 负向断言无完成信号可等——分片采样（不写缓存、不发帧）
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, PUMP_WAIT_MS))
      expect(h.cache.get('s4-disposed')).toBeUndefined()
      expect(h.publishes).toHaveLength(0)
    }
  })

  // ── session-service 挂点接线（态 3 事件驱动的组合根形态）──

  it('session-service 集成：notifySessionActivated 驱动待启动任务（onSessionActivated 挂点接线）', async () => {
    let clientVisible = false
    const client = {
      getEntries: vi.fn(async () => ({ data: { entries: [entry('e1')], leafId: 'leaf-1' } })),
    } as unknown as IPiEngine
    const pm = { onSessionExit: vi.fn(), getClient: vi.fn(() => (clientVisible ? client : undefined)) } as unknown as IProcessManager
    const svc = new SessionService(
      pm, { broadcast: vi.fn() } as unknown as IMessageBroker,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/test', {} as never, {} as never,
      {
        scanSessions: vi.fn(() => []),
        extractSessionOutcome: vi.fn(() => null),
        persistSessionEnd: vi.fn(),
        // 后台任务启动后走真实重建链（rebuildHistoryFromEntries 直通，同 makeService 形态）
        rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({ messages: entries.map((e) => msg(e.id)), orphanToolResults: [] })),
      } as never,
      { pruneStaleCache: vi.fn() } as never, {} as never,
    )

    const first = await svc.getHistory('s4-svc-hook') // 态 3：尾读 + 登记
    expect(first.truncated).toBe(true)
    expect(client.getEntries).not.toHaveBeenCalled()

    clientVisible = true
    svc.notifySessionActivated({ id: 's4-svc-hook' } as never) // switch 成功分支的激活通知
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledTimes(1))
  })

  // ── 验收② fixture 对拍：尾读（含 sidecar 回填）与全量切片逐条一致 ──

  it('验收② fixture 对拍：尾读（含 segments sidecar 回填）与全量切片逐条一致，图片/技能 badge 不丢', async () => {
    const dir = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'taiji-u1-fixture-'))
    const sessionId = 'fixture-session-01'
    // dataDir 显式注入（第二参）：@taiji/shared/paths 被 vi.mock 固定到 /mock/home，
  // 缺省推导会落 fs-guard 白名单外——对拍 fixture 的 sidecar 与 session 文件同放 mkdtemp tmp 目录
  const sidecarPath = path4.join(getAttachmentsDir4(sessionId, dir), 'segments.json')
    try {
      // ── 组装 fixture：user(+image sidecar) → assistant → user(+skill sidecar) → assistant(toolCall) → toolResult ──
      const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
      const assistantMsg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 })
      const mkEntry = (id: string, parentId: string | null, message: unknown) =>
        ({ type: 'message', id, parentId, timestamp: '2026-10-29T00:00:00.000Z', message }) as unknown as PiSessionEntry
      const mkCustom = (id: string, parentId: string | null, clientUuid: string, userEntryId: string) =>
        ({ type: 'custom', id, parentId, timestamp: '2026-10-29T00:00:01.000Z', customType: 'taiji.client-msg-id', data: { clientUuid, userEntryId } }) as unknown as PiSessionEntry

      // parentId 链 = 线性 append 链（pi 真实树形：每条 entry 的 parent = 前一条，
      // custom entry 嵌在链中间）——活跃路径单链回溯（computeActivePathEntries）才能
      // 保住 custom entry（clientUuid 映射源）；分叉形态会被裁剪滤掉致回填失效。
      const entries: PiSessionEntry[] = [
        mkEntry('e1', null, userMsg('hello with image')),
        mkCustom('c1', 'e1', 'u-fix-1', 'e1'),
        mkEntry('e2', 'c1', assistantMsg('reply one')),
        mkEntry('e3', 'e2', userMsg('second with skill')),
        mkCustom('c2', 'e3', 'u-fix-2', 'e3'),
        mkEntry('e4', 'c2', { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 3 }),
        mkEntry('e5', 'e4', { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'OUT' }], timestamp: 4 }),
      ]
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, version: 1 }), // session header（尾读链剥除）
        ...entries.map((e) => JSON.stringify(e)),
      ]
      const filePath = path4.join(dir, `${sessionId}.jsonl`)
      fs4.writeFileSync(filePath, lines.join('\n') + '\n')

      const segments = {
        version: 1,
        entries: [
          { clientUuid: 'u-fix-1', segments: [{ type: 'text', text: 'hello ' }, { type: 'image', id: 'img-1', path: '/tmp/shot.png', fileName: 'shot.png', displayName: '截图.png' }], timestamp: 1 },
          { clientUuid: 'u-fix-2', segments: [{ type: 'text', text: 'second ' }, { type: 'skill', name: 'review' }], timestamp: 2 },
        ],
      }
      fs4.mkdirSync(getAttachmentsDir4(sessionId, dir), { recursive: true })
      fs4.writeFileSync(sidecarPath, JSON.stringify(segments))
      const metadata = JSON.parse(fs4.readFileSync(sidecarPath, 'utf-8')) as SegmentsMetadataFile

      // ── 全量切片基准：真实 entry 树重建 + 预算切窗（与活跃 getHistory 全量路径同链）──
      const fileEntries = parseJsonl4(fs4.readFileSync(filePath, 'utf-8'), {}).filter(
        (e) => typeof e === 'object' && e !== null,
      ) as PiSessionEntry[]
      const scoped = fileEntries.filter((e) => (e as { type?: unknown }).type !== 'session')
      const full = rebuildHistoryFromEntries(scoped, metadata)
      const fullWindow = applyHistoryBudgetWindow(full.messages)

      // ── 尾读：真实 tailReadHistory + sidecar 回填 ──
      const tail = await tailReadHistoryReal(
        filePath, new PiSessionStore(), HISTORY_BUDGET4.RECENT_TURNS, undefined, { segmentsMetadata: metadata },
      )

      // 逐条一致（含 segments 回填后的结构化 content）
      expect(tail.messages).toEqual(fullWindow.messages)
      // 回填生效的正面断言（防「双方同错」的空等价）：图片/技能 badge 从 sidecar 还原
      const user1 = tail.messages.find((m) => m.piEntryId === 'e1')
      expect(user1?.content).toEqual(segments.entries[0]?.segments)
      const user2 = tail.messages.find((m) => m.piEntryId === 'e3')
      expect(user2?.content).toEqual(segments.entries[1]?.segments)
    } finally {
      fs4.rmSync(dir, { recursive: true, force: true })
      fs4.rmSync(sidecarPath, { force: true })
    }
  })
});
