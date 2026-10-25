/**
 * D3 验收资产：§7 验收项 13（W5 判据切换批次行为等价）gap 测试。
 *
 * 规格原文（设计文档 §7 表项 13）：`session-lifecycle.ts` createNew 切
 * `surface === 'sidebar'` 判据后（取数来源 = 注册后记录 `lifecycle.get(id).surface`，
 * 不读 `options?.surface`——生产 create 路径永不传 surface，读 options 会使全部生产
 * create 静默停记工作区历史，§3.3.5），runtime 层直调 createNew（private、测试经内部
 * 入口直调；实参形态 `(cwd?, label?, options?)`）：
 *   ① `createNew(cwd, label, { surface: 'btw' })` 不记录工作区历史；
 *   ② `createNew(cwd, label, { surface: 'sidebar' })` 记录；
 *   ③ `createNew(cwd, label)`（不传 surface，生产主路径）仍记录（防「谓词改读 options
 *      后生产路径静默停记」的回归形态）。
 *
 * 与 u-w5a 既有覆盖的分工（本文件只补 D3 验收视角的缺口，不重复单元层断言）：
 * - `src/services/session/__tests__/session-lifecycle-surface.test.ts`（u-w5a）经公共
 *   入口 `create()`（无 clientUuid 时逐行委托 createNew）覆盖三态；本文件按规格「内部
 *   入口直调」形态**直接调 private createNew**，锁定实参形态 `(cwd?, label?, options?)`。
 * - 观测方式 = spy `workspaceService.record`（与单元层同口径）+ 回读注册后记录
 *   `lifecycle.get(id).surface`（证明判据取数来源是注册后记录而非 options）。
 * - 「两处过滤点切换后验收项 10 ①② 复跑」由 A9 剧本 spawn 既有测试文件覆盖
 *   （session-scanner-sidebar-set.test.ts / command-popover-symbols-format-age.test.ts），
 *   不在本文件重复。
 *
 * 数据隔离（项目测试红线）：cwd 全部落 `mkdtempSync(join(tmpdir(), ...))`，不触真实
 * 数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item13-w5-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary, SessionSurface } from '@taiji/shared'
import { SessionLifecycle } from '../../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../../src/services/session/session-internal.js'
import type { IEventAdapter } from '../../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../../src/services/ports/config.js'
import type { ISessionStore } from '../../src/services/ports/session.js'
import type { WorkspaceService } from '../../src/services/workspace/workspace-service.js'

/**
 * createNew 直调入口（规格：private、测试经内部入口直调）。
 *
 * CreateOptions 是 session-lifecycle.ts 模块内非导出接口，本测试只用到 surface 字段，
 * 故以结构类型声明直调签名（避免为测试扩大产品代码导出面）。
 */
type CreateNewFn = (cwd?: string, label?: string, options?: { surface?: SessionSurface }) => Promise<SessionSummary>

function directCreateNew(lifecycle: SessionLifecycle, cwd: string, label: string, options?: { surface?: SessionSurface }): Promise<SessionSummary> {
  const fn = (lifecycle as unknown as { createNew: CreateNewFn }).createNew
  return fn.call(lifecycle, cwd, label, options)
}

/** create 链路环境（全协作者 mock + 真 registerSession 编排；cwd 由调用方落 mkdtemp tmp）。 */
function makeCreateEnv() {
  let seq = 0
  const pm = {
    createSession: vi.fn(async () => {
      seq += 1
      const sid = `pi-sid-${seq}`
      return {
        exited: false,
        getState: vi.fn(async () => ({ sessionId: sid, sessionFile: '/tmp/s.jsonl' })),
        setSessionName: vi.fn(async () => ({ success: true })),
      }
    }),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: { id: string; label: string; cwd: string }): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active' as const, lastActiveAt: 1,
    })),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = { getDefaultModel: vi.fn(() => 'prov/model') } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    persistAgentBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, workspaceService, pm }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('§7 验收项 13：W5 createNew 工作区历史判据切换三态（runtime 层直调）', () => {
  it('① createNew(cwd, label, { surface: "btw" }) 不记录工作区历史', async () => {
    const { lifecycle, workspaceService } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'item13-btw-'))

    const summary = await directCreateNew(lifecycle, cwd, 'btw-line', { surface: 'btw' })

    // 注册后记录 surface = 'btw'（谓词取数来源），故判据不命中
    expect(lifecycle.get(summary.id)?.surface).toBe('btw')
    expect(workspaceService.record).not.toHaveBeenCalled()
  })

  it('② createNew(cwd, label, { surface: "sidebar" }) 记录工作区历史（参数 = 注册后记录的 cwd）', async () => {
    const { lifecycle, workspaceService } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'item13-sidebar-'))

    const summary = await directCreateNew(lifecycle, cwd, 'main-session', { surface: 'sidebar' })

    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
    expect(workspaceService.record).toHaveBeenCalledTimes(1)
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)
  })

  it('③ createNew(cwd, label)（不传 surface，生产主路径）仍记录工作区历史', async () => {
    const { lifecycle, workspaceService } = makeCreateEnv()
    const cwd = mkdtempSync(join(tmpdir(), 'item13-nosurface-'))

    // 整个 options 形参缺省 = 生产主路径（协议无 surface 入参）。若谓词误改为读
    // options?.surface，此处 options 为 undefined → 判据恒假 → 生产 create 全部静默
    // 停记工作区历史（规格标注的回归形态）。
    const summary = await directCreateNew(lifecycle, cwd, 'prod-create')

    // 注册后记录由 registerSession 缺省 'sidebar'（判据取数来源），记录必须发生
    expect(lifecycle.get(summary.id)?.surface).toBe('sidebar')
    expect(workspaceService.record).toHaveBeenCalledTimes(1)
    expect(workspaceService.record).toHaveBeenCalledWith(cwd)
  })
})
