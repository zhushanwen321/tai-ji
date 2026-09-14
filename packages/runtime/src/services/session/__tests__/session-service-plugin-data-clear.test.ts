/**
 * B5 plugin sessionData 清理的触发面测试（memory-leak-remediation §3.1 + §3.2-B5；触发面
 * 收窄 2026-09-15）。
 *
 * 锁定语义「**真删除才清**」：清理（tombstone 登记 + 分区摘除 + trash 软删除）绑定用户
 * 删除——lifecycle.delete（active / scanned 两分支）尾段经模块级 clearRemovedSessionData
 * 分发，插件数据与 session 本体一同进废纸篓（§3.1）；didDestroy 投递先行，插件 worker
 * 迟到的 set()/delete() 由 tombstone 写守卫丢弃（不复活文件）。
 *
 * 三条 session **存活**路径反例（回归锚：曾因清理无条件挂在 removeSessionEntry 汇聚点，
 * pi 崩溃 respawn / forceQuit / restore 后插件空状态、旧数据只在废纸篓）：
 * - pi 崩溃：session-service 构造器注册的 pm.onSessionExit 回调（真实调用链直调）→ 随后
 *   respawn 复活同 id，插件要继续读写原数据；
 * - forceQuit：真 MessageDispatcher.forceQuit → svc.removeSessionEntry（桥接真
 *   SessionService）→ 用户强杀后 restore 重开历史完整；
 * - restore 清场：真 SessionLifecycle 二次 restoreSession → clearExistingSessionForRestore
 *   → svc.removeSessionEntry（同桥接），同链随后 notifySessionCreated 摘碑复活——修复后
 *   插件数据完好（无 trash、无 tombstone、写通道畅通）。
 *
 * 装置：真 SessionService（session-service-checkpoint.test.ts createSetup 同款轻量桩）+
 * 真 SessionDataStore（tmp configDir，自注册进分发表）。trash port 注入式 mock（禁触真实
 * 废纸篓）；sessionStore.refreshAll/invalidateScanCache/trash spy 掉（provider 重扫与真实
 * 废纸篓不属本域断言面）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-plugin-data-clear.test.ts
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// trash port 注入式 mock（B5 port 化：SessionDataStore 构造参数注入，非模块 mock）；
// 同步移除文件模拟 trash 语义
const trashState = { calls: [] as string[] }
const mockTrashFile = async (filePath: string): Promise<void> => {
  trashState.calls.push(filePath)
  rmSync(filePath, { force: true })
}
// getPiAgentDir → tmp（removeSessionEntry 的 reapSessionBackgroundTasks fire-and-forget 腿
// 读该目录，session-service-background-task.test.ts 同款隔离）
const paths = vi.hoisted(() => ({ agentDir: '' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => paths.agentDir }
})

import { SessionService } from '../session-service.js'
import { MessageDispatcher } from '../message-dispatcher.js'
import { SessionLifecycle } from '../session-lifecycle.js'
import { SessionDataStore, isSessionDataCleared } from '../../plugin-service/session-data-store.js'
import { initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IExtensionService, IEventAdapter } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IDispatcherSessionOps, ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { ScannedSession } from '../types.js'

const CLIENT_ACTIVITY_AT = 1_700_000_500_000

let runDir: string
let store: SessionDataStore

/** plugin sessionData 持久化文件路径（SessionDataStore 内部推导同款）。 */
const dataFile = (sid: string): string => join(runDir, 'session-data', `${sid}.json`)

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-'))
  initRuntimeCheckpointStore({ dir: runDir })
  paths.agentDir = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-agent-'))
})

beforeEach(() => {
  // 每 case 独立 store（tombstone/分发表模块级共享态，sid 也唯一化由各 case 自带）
  store = new SessionDataStore(runDir, undefined, undefined, mockTrashFile)
  trashState.calls.length = 0
})

afterEach(() => {
  store.dispose()
})

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(paths.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

interface Setup {
  service: SessionService
  /** pi 崩溃入口：构造器注册的 pm.onSessionExit 回调（真实 exit 收敛链）。 */
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
}

/** 真 SessionService 最小装置（session-service-checkpoint.test.ts 同款，构造期零 fs 触点）。 */
function createSetup(): Setup {
  const client = { lastActivityAt: CLIENT_ACTIVITY_AT, exited: false } as unknown as IPiEngine
  // 捕获构造器注册的 exit 回调（反例①的驱动入口）
  let exitCb: ((sessionId: string, code: number | null, stderr?: string) => void) | undefined
  const pm = {
    onSessionExit: vi.fn((cb: NonNullable<typeof exitCb>) => { exitCb = cb }),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  // 真删除链尾的 refreshAll（pi provider 盘上重扫）与 trash（真实废纸篓）不属本域断言面：
  // spy 掉——refreshAll/invalidateScanCache no-op 化，trash 落 tmp 内 rm（mockTrashFile 同款
  // 语义，保 existsSync 断言可判）。
  const sessionStore = new PiSessionStore()
  vi.spyOn(sessionStore, 'refreshAll').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'trash').mockImplementation(mockTrashFile)
  const service = new SessionService(
    pm as unknown as IProcessManager,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    sessionStore,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, triggerExit: (sid, code, stderr) => exitCb?.(sid, code, stderr) }
}

/** 反例②装置：真 MessageDispatcher，removeSessionEntry 等收殓面桥接真 SessionService。 */
function createDispatcher(service: SessionService): MessageDispatcher {
  const ops: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => undefined),
    detachSession: (sid) => service.detachSession(sid),
    persistSessionOutcome: (sid, outcome, reason) => service.persistSessionOutcome(sid, outcome, reason),
    getSession: (sid) => service.getSession(sid),
    removeSessionEntry: (sid) => service.removeSessionEntry(sid),
    ensureActive: vi.fn(async () => { throw new Error('forceQuit path must not call ensureActive') }),
  }
  const pm = {
    // forceQuit 入口守卫：getClient 非 null 才走强杀编排（null 会早退不触发收殓链）
    getClient: vi.fn(() => ({ lastActivityAt: CLIENT_ACTIVITY_AT, exited: false } as unknown as IPiEngine)),
    destroySession: vi.fn(async () => undefined),
  }
  return new MessageDispatcher(
    ops,
    pm as unknown as IProcessManager,
    { record: vi.fn() } as unknown as WorkspaceService,
    undefined,
  )
}

/**
 * 反例③装置：真 SessionLifecycle（kill-path-logging.test.ts K3 harness 同款），唯独
 * removeSessionEntry 桥接真 SessionService——restore 清场→removeSessionEntry 正是被测的
 * 生产接线边（其余 svc 面 mock，证明 harness 同款已green的 K3）。
 */
function createRestoreLifecycle(service: SessionService, sid: string, bodyFile: string): {
  lifecycle: SessionLifecycle
  notifyCreated: ReturnType<typeof vi.fn>
  removeEntryOnService: ReturnType<typeof vi.spyOn>
  pm: { createSession: ReturnType<typeof vi.fn>; destroySession: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> }
} {
  const restoreClient = {
    exited: false,
    lastActivityAt: CLIENT_ACTIVITY_AT,
    getState: vi.fn(async () => ({ sessionId: sid })),
    switchSession: vi.fn(async (_path: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => restoreClient),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检：undefined = 无 client → 不短路 → 二次 restore 走清场分支
    getClient: vi.fn(() => undefined),
  }
  const notifyCreated = vi.fn()
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s) => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1, modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn((id: string): ScannedSession | undefined =>
      id === sid
        ? { id, filePath: bodyFile, cwd: runDir, name: 'target', lastModified: Date.now(), timestamp: '2026-09-15T00:00:00.000Z', size: 0 } as ScannedSession
        : undefined),
    // 被测接线边：清场收殓走真 SessionService.removeSessionEntry（生产中 lifecycle.svc 即它）
    removeSessionEntry: (id: string) => service.removeSessionEntry(id),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    notifySessionCreated: notifyCreated,
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = { getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })) } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    trash: vi.fn(async () => undefined),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }
  const removeEntryOnService = vi.spyOn(service, 'removeSessionEntry')
  const lifecycle = new SessionLifecycle(
    svc,
    pm as unknown as IProcessManager,
    configStore,
    sessionStore,
    { record: vi.fn() } as unknown as WorkspaceService,
    registerDeps,
  )
  return { lifecycle, notifyCreated, removeEntryOnService, pm }
}

describe('B5 触发面收窄：真删除才清 plugin sessionData（§3.1 trash 绑定用户删除）', () => {
  it('真删除（lifecycle.delete active 分支）：tombstone + 文件进 trash + 迟到 set 被丢弃', async () => {
    const sid = 'sid-delete-active'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')

    // session 存续期的插件数据（模拟 plugin worker 已写入）
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    expect(existsSync(dataFile(sid))).toBe(true)

    // 用户删除（session-message-handler session.delete RPC 同链：facade.delete → lifecycle.delete）
    await service.delete(sid)

    // 清理是 void…catch 分发（异步腿），trash 到达是微任务
    await vi.waitFor(() => expect(trashState.calls).toContain(dataFile(sid)))
    expect(isSessionDataCleared(sid)).toBe(true)
    expect(existsSync(dataFile(sid))).toBe(false)
    expect(service.getSummary(sid)).toBeUndefined() // 真销毁完成（内存条目已收殓）

    // didDestroy fire-and-forget 后插件 worker 迟到的 set：被写守卫丢弃，不复活文件
    store.set(sid, 'k2', 'late-write')
    store.flushAll()
    expect(existsSync(dataFile(sid))).toBe(false)
    expect(store.keys(sid)).toEqual([])
  })

  it('真删除（lifecycle.delete scanned 分支——非活跃 session）：插件数据同样随本体进 trash', async () => {
    const sid = 'sid-delete-scanned'
    const { service } = createSetup()
    // scanned 分支：session 不在 Map，findScannedSession 命中盘上文件（spy 定向，绕开
    // 全量扫描装置——分支语义只依赖 target 存在 + 主文件 existsSync）
    const bodyFile = join(runDir, `${sid}.jsonl`)
    writeFileSync(bodyFile, JSON.stringify({ type: 'session', version: 3, id: sid }) + '\n', 'utf-8')
    vi.spyOn(service, 'findScannedSession').mockReturnValue(
      { id: sid, filePath: bodyFile, cwd: runDir, name: 'scanned', lastModified: Date.now(), timestamp: '2026-09-15T00:00:00.000Z', size: 0 } as ScannedSession,
    )
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    await service.delete(sid)

    await vi.waitFor(() => expect(trashState.calls).toContain(dataFile(sid)))
    expect(trashState.calls).toContain(bodyFile) // session 本体同trash（§3.1 一同进废纸篓）
    expect(isSessionDataCleared(sid)).toBe(true)
    expect(existsSync(dataFile(sid))).toBe(false)
  })

  it('未注册任何 store（无插件系统场景）时真删除不抛（分发空集 no-op）', async () => {
    store.dispose() // 摘除唯一注册实例
    const sid = 'sid-no-store'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    await expect(service.delete(sid)).resolves.toBeUndefined()
    expect(trashState.calls).toHaveLength(0)
  })

  it('反例①pi 崩溃（onSessionExit 收殓链）：插件数据存活——respawn 后继续写（不打 tombstone）', async () => {
    const sid = 'sid-crash-exit'
    const { service, triggerExit } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    // pi 崩溃：真实 exit 收敛链（detach → session.exited publish → removeSessionEntry →
    // respawn.schedule）。respawn timer unref，不悬挂测试进程。
    triggerExit(sid, 1, 'boom')

    expect(service.getSummary(sid)).toBeUndefined() // 内存收殓链真实走到 removeSessionEntry
    // 三不：不 trash、不摘数据、不打 tombstone
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(existsSync(dataFile(sid))).toBe(true)
    // respawn 后插件的「新写」照常（k1 保留、k2 追加——tombstone 未打，写通道畅通）
    store.set(sid, 'k2', 'v2')
    store.flushSession(sid)
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })

  it('反例②forceQuit（dispatcher 强杀收敛）：插件数据存活——restore 复活后可续读写', async () => {
    const sid = 'sid-force-quit'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    await createDispatcher(service).forceQuit(sid)

    expect(service.getSummary(sid)).toBeUndefined() // 强杀收敛链真实走到 removeSessionEntry
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(store.get(sid, 'k1')).toBe('v1')
    expect(existsSync(dataFile(sid))).toBe(true)
    // 用户随后 restore 重开（dead session 点击）：插件写不受阻
    store.set(sid, 'k2', 'v2')
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })

  it('反例③restore 清场（clearExistingSessionForRestore）：同链 notifySessionCreated 摘碑复活，插件数据完好', async () => {
    const sid = 'sid-restore-clear'
    const { service } = createSetup()
    // 真 session 文件（attachRestoreFile 的 assertPiSessionFile 校验目标，kill-path 同款格式）
    const bodyFile = join(runDir, `${sid}.jsonl`)
    writeFileSync(
      bodyFile,
      [
        JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-09-15T00:00:00.000Z', cwd: runDir }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-15T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const { lifecycle, notifyCreated, removeEntryOnService, pm } = createRestoreLifecycle(service, sid, bodyFile)

    // #1：注册进 Map（真实 registerSession 链）
    await lifecycle.restoreSession(sid)
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    expect(existsSync(dataFile(sid))).toBe(true)
    removeEntryOnService.mockClear()

    // #2：命中 existing → 清场重开（detach → safeDestroy → 真 removeSessionEntry → respawn+switch）
    await lifecycle.restoreSession(sid)

    // 清场链真实走到：旧 pi 销毁 + 真 removeSessionEntry + 同链复活收敛点（生产中此处
    // 链式摘碑——修复后 tombstone 从未打，摘碑为幂等 no-op，插件数据全程完好）
    expect(pm.destroySession).toHaveBeenCalledWith(sid)
    expect(removeEntryOnService).toHaveBeenCalledWith(sid)
    expect(notifyCreated).toHaveBeenCalled()
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(store.get(sid, 'k1')).toBe('v1')
    expect(existsSync(dataFile(sid))).toBe(true)
    store.set(sid, 'k2', 'v2')
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })
})
