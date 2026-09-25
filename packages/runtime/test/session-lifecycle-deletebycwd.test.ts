/**
 * W1: SessionLifecycle.deleteByCwd 单测 — folder 维度批量删除。
 *
 * 背景：deleteByCwd 合并 active（getActiveSummaries）+ persisted（scanSessions）按 cwd 过滤去重，
 * 串行调 delete(id)，单个失败聚合到 failed，不中断循环。返回 BatchDeleteResult。
 *
 * Mock 策略：参考 session-lifecycle-w5.test.ts，构造 5 个构造依赖（svc/pm/configStore/
 * sessionStore/workspaceService），delete 用 vi.spyOn 覆盖（不走真实文件/trash 路径）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-deletebycwd.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'

// deleteByCwd 内部不调 node:fs（delete 才调 existsSync），但真实 delete 走 trash/unlink，
// 这里 spyOn delete 覆盖整段路径，node:fs 不会被触及——不需要 vi.mock。
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore, ScannedSessionMeta } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary, BatchDeleteResult } from '@taiji/shared'

/**
 * 构造 lifecycle + delete spy + 注入 mock。
 * delete spy 默认 resolve（成功）；用例可按 id 判定 reject 模拟部分失败。
 */
function makeHarness(deleteImpl?: (id: string) => Promise<void>) {
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const pm = {} as unknown as IProcessManager
  const configStore = {} as unknown as IConfigStore
  const sessionStore = {
    scanSessions: vi.fn((): ScannedSessionMeta[] => []),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法），无强转；deleteByCwd 只真实消费
  // getActiveSummaries（delete 被下方 spy 覆盖，不走其余成员），空 vi.fn 仅为满足接口面
  const svc: ILifecycleSessionOps = {
    getActiveSummaries: vi.fn((): SessionSummary[] => []),
    toSummary: vi.fn(),
    findScannedSession: vi.fn(),
    getSkillPaths: vi.fn(),
    getExtensionPaths: vi.fn(),
    getReplaceSystemPrompt: vi.fn(),
    getLaunchPresetOptions: vi.fn(),
    fetchAndBroadcastContext: vi.fn(),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
  }

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspace, registerDeps)
  // spyOn 实例方法 delete，覆盖真实文件/trash/unlink 路径，专注 deleteByCwd 聚合逻辑。
  const deleteSpy = vi.spyOn(lifecycle, 'delete').mockImplementation(
    deleteImpl ?? (async () => {}),
  )
  return { lifecycle, svc, sessionStore, deleteSpy }
}

describe('W1: SessionLifecycle.deleteByCwd — folder 维度批量删除', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1TC1 串行删除 + 部分失败聚合', async () => {
    // scanSessions: s1/s2（persisted）；getActiveSummaries: s3（active，未 flush 的边界场景）
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', cwd: '/p', filePath: '/p/s1.jsonl' } as ScannedSessionMeta,
      { id: 's2', cwd: '/p', filePath: '/p/s2.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])
    // Set 插入顺序：先 active 的 s3，再 scan 的 s1/s2 → 循环顺序 s3, s1, s2
    deleteSpy.mockImplementation(async (id: string) => {
      if (id === 's2') throw new Error('EPERM')
    })

    const result: BatchDeleteResult = await lifecycle.deleteByCwd('/p')

    // 失败聚合（不中断循环）
    expect(result.cwd).toBe('/p')
    expect(result.failed).toEqual([{ sessionId: 's2', error: 'EPERM' }])
    // deleted 含 s1/s3（不依赖顺序）
    expect(result.deleted).toHaveLength(2)
    expect(result.deleted).toEqual(expect.arrayContaining(['s1', 's3']))
    expect(result.deleted).not.toContain('s2')
    // delete 被调 3 次（每个 session 一次，失败的也调）
    expect(deleteSpy).toHaveBeenCalledTimes(3)
  })

  it('W1TC2 空 folder 幂等', async () => {
    const { lifecycle, sessionStore, svc, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'x', cwd: '/other', filePath: '/other/x.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd('/empty')

    expect(result).toEqual({ cwd: '/empty', deleted: [], failed: [] })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('W1TC3 active + scanned 去重', async () => {
    // s3 同时出现在 active（getActiveSummaries）和 persisted（scanSessions）→ Set 去重为 1 个
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p', filePath: '/p/s3.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's3', cwd: '/p' } as SessionSummary,
    ])

    const result = await lifecycle.deleteByCwd('/p')

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith('s3')
    expect(result).toEqual({ cwd: '/p', deleted: ['s3'], failed: [] })
  })

  it('W11：header cwd 为死路径的 session，deleteByCwd(死路径) 命中（真实历史值匹配）', async () => {
    // W11（patchSessionCwd 迁 tmp 管线）后的扫描侧消费边界：源文件 header 永久保持
    // 死路径 cwd（pi append 不重写 header），deleteByCwd 按扫描条目的真实历史 cwd 命中——
    // 旧方案（restore 时 patch 成 home）下 deleteByCwd(死路径) 不会命中。此用例锁定
    // 「按真实历史值删除」的接受行为（plan W11 步骤 5 / 验收 4 扫描侧断言）。
    const deadCwd = '/gone/worktree-abc'
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'dead-cwd-1', cwd: deadCwd, filePath: '/gone/worktree-abc/dead-cwd-1.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd(deadCwd)

    expect(deleteSpy).toHaveBeenCalledWith('dead-cwd-1')
    expect(result.deleted).toEqual(['dead-cwd-1'])
    // deleteByCwd(home) 不再命中该 session（home 是旧方案的修补值，死路径才是真实历史值）
    deleteSpy.mockClear()
    const byHome = await lifecycle.deleteByCwd(homedir())
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(byHome.deleted).toEqual([])
  })

  it('W1TC1b 全部 reject → deleted=[] 且 failed 含全部，循环不中断', async () => {
    // setup：folder('/p') 下 2 session（s1, s2），delete spy 对两者都 mockRejectedValue
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', cwd: '/p', filePath: '/p/s1.jsonl' } as ScannedSessionMeta,
      { id: 's2', cwd: '/p', filePath: '/p/s2.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])
    deleteSpy.mockRejectedValue(new Error('EPERM'))

    const result: BatchDeleteResult = await lifecycle.deleteByCwd('/p')

    // 全失败：deleted=[]，failed 包含全部 session（continue 语义，第一个失败不阻断第二个）
    expect(result.cwd).toBe('/p')
    expect(result.deleted).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed).toEqual([
      { sessionId: 's1', error: 'EPERM' },
      { sessionId: 's2', error: 'EPERM' },
    ])
    // delete 被调 2 次（每个 session 一次，第一个失败不阻断第二个）
    expect(deleteSpy).toHaveBeenCalledTimes(2)
  })

  it('W1TC4 持久化枚举走 force 旁路 TTL——TTL 窗口内刚落盘 session 不漏删', async () => {
    // 回归防护（W26 审查修正）：deleteByCwd 是写语义彻底清理，scanSessions 必须传
    // { force: true } 绕过目录 TTL 快照——快照漏掉刚落盘 session → 漏删；快照含已删条目
    // → delete 内 findScannedSession 找不到 → Session not found → 误报 failed。
    const { lifecycle, svc, sessionStore, deleteSpy } = makeHarness()
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's-fresh', cwd: '/p', filePath: '/p/s-fresh.jsonl' } as ScannedSessionMeta,
    ])
    ;(svc.getActiveSummaries as ReturnType<typeof vi.fn>).mockReturnValue([])

    const result = await lifecycle.deleteByCwd('/p')

    // 枚举必须走 force（若回退 TTL 快照，本用例语义即破坏——漏删/误报）
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    // 刚落盘 session 被枚举并删除，无 failed 误报
    expect(deleteSpy).toHaveBeenCalledWith('s-fresh')
    expect(result).toEqual({ cwd: '/p', deleted: ['s-fresh'], failed: [] })
  })
})
