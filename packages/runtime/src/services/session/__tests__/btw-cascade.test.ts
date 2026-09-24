/**
 * M4-a / btw-question：deleteSession 级联支线 + 线终结三路并发收敛 + P-invisible runtime 面。
 *
 * 探针落点：
 * - **P-cascade**（删主即删线）：杀名下线进程 + 删 `btw/<encodeCwd>/<mainSid>/` 目录 +
 *   注册表清空；active / scanned（冷主）两分支同覆盖。
 * - **三路并发收敛（D9④）**：session.delete 级联 / deleteByCwd 批内连带（含 btw vid 直删）/
 *   btw.remove 关线——单入口 closeLine、枚举先于注册表移除、abort/删除幂等（重复处置不抛、
 *   批内不记 failed）；级联失败 best-effort 不阻断主删除（P2 降级隔离）。
 * - **P-invisible·侧边栏面**：SessionScanner.listAll 的 hidden 过滤拦下隐藏线条目
 *  （active 腿防线；磁盘腿靠目录隔离——session-scanner 注释已按实装修正）。
 * - **P-invisible·工作区历史面**：btw 线注册（registerSession 汇聚点）不记工作区历史。
 *
 * 装置：真 SessionService（构造期零 fs 触点，session-service-plugin-data-clear 同款）+
 * btw-harness fake BtwService + TAIJI_AGENT_DATA_DIR 全程钉 tmp（fs-guard 白名单）。
 * checkpoint 语义（重启不误 reattach）与孤儿补账在 btw-persist-reload.test.ts。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/btw-cascade.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary } from '@taiji/shared'

import { SessionService } from '../session-service.js'
import { SessionScanner } from '../session-scanner.js'
import { setBtwCascadeOps } from '../session-lifecycle.js'
import { initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { clearRemovedSessionData } from '../../plugin-service/session-data-store.js'
import { BtwService } from '../btw-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IExtensionService, IEventAdapter } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IScannerSessionOps } from '../session-internal.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IGitInfoReader } from '../../ports/git-info.js'
import type { ScannedSession } from '../types.js'
import {
  makeHarness,
  makeTmpDir,
  cleanupDir,
  useTmpDataDir,
  writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

const MAIN_SID = 'main-sid-cascade-1'
const CWD = '/Users/x/proj'
const CLIENT_ACTIVITY_AT = 1_700_600_500_000

let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let btwSvc: BtwService
let service: SessionService
let pm: { destroySession: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> }
let workspace: { record: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }

/** trash port 注入式 mock（禁触真实废纸篓；mockTrashFile 先例——rm 落 tmp 内保 existsSync 断言）。 */
function mockTrashFile(filePath: string): void {
  rmSync(filePath, { force: true, maxRetries: 5, retryDelay: 20 })
}

/** 真 SessionService 最小装置（session-service-plugin-data-clear 同款，构造期零 fs 触点）。 */
function createSetup(): void {
  const client = { lastActivityAt: CLIENT_ACTIVITY_AT, exited: false } as unknown as IPiEngine
  pm = {
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => client),
  }
  const pmStub = {
    ...pm,
    onSessionExit: vi.fn(),
    hasClient: vi.fn(() => false),
    destroyAll: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const sessionStore = new PiSessionStore()
  vi.spyOn(sessionStore, 'refreshAll').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'trash').mockImplementation(async (filePath: string) => { mockTrashFile(filePath) })
  workspace = { record: vi.fn(), list: vi.fn(() => []) }
  service = new SessionService(
    pmStub,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    sessionStore,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    workspace as unknown as WorkspaceService,
  )
}

/**
 * 分支② 形态建线（无 fork；线目录落真实 `getBtwThreadDir(CWD, MAIN_SID)` + 真实线文件，
 * 供目录删除断言）。返回 vid 与线目录。
 */
async function createLine(linePiSid = 'linepi-cascade-1'): Promise<{ vid: string; threadDir: string }> {
  h.deps.resolveMainSessionFile = vi.fn(() => undefined)
  const threadDir = getBtwThreadDir(CWD, MAIN_SID)
  const file = writeSessionFile(threadDir, `${linePiSid}.jsonl`, {
    type: 'session', version: 3, id: linePiSid, timestamp: 't', cwd: CWD,
  }, [])
  h.state = { sessionId: linePiSid, sessionFile: file }
  const res = await btwSvc.createLine({ mainSid: MAIN_SID, cwd: CWD })
  return { vid: res.vid, threadDir }
}

let cpDir: string

beforeAll(() => {
  // checkpoint store 是模块单例（??= 一次 init）——显式指到本文件稳定 tmp 目录，
  // 防惰性初始化落到 per-test dataDir（afterEach 即删）后写失败。
  cpDir = mkdtempSync(join(tmpdir(), 'btw-cascade-checkpoint-'))
  initRuntimeCheckpointStore({ dir: cpDir })
})
afterAll(() => {
  rmSync(cpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
beforeEach(() => {
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  h = makeHarness()
  btwSvc = new BtwService(h.deps)
  createSetup()
  setBtwCascadeOps(btwSvc)
  // 组合根同款注入（index.ts onLineTerminated）：线终结的 lifecycle 收尾扇出
  //（planned kill 不走 exit 链，Map 条目不自清——本回调是三路终结合一收敛点）。
  h.deps.onLineTerminated = (vid) => {
    if (!service.getSession(vid)) return
    service.detachSession(vid)
    service.removeSessionEntry(vid)
    clearRemovedSessionData(vid)
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setBtwCascadeOps(null)
  btwSvc.dispose()
  cleanupDir(fx)
  restoreDataDir()
  vi.restoreAllMocks()
})

describe('P-cascade：删主 session → 杀名下线进程 + 删线目录 + 注册表清空', () => {
  it('active 主分支：closeAllForMain 杀线（destroySession 收尸）+ 整目录删除 + listLines 归空', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { vid, threadDir } = await createLine()
    expect(existsSync(threadDir)).toBe(true)

    await service.delete(MAIN_SID)

    expect(h.destroyed).toContain(vid) // 线进程被杀（派生任务随 pi 进程亡）
    expect(btwSvc.listLines(MAIN_SID)).toEqual([]) // 注册表清空
    expect(existsSync(threadDir)).toBe(false) // btw/<enc>/<mainSid>/ 目录消失
    expect(service.getSession(MAIN_SID)).toBeUndefined() // 主本体照常删除
    expect(pm.destroySession).toHaveBeenCalledWith(MAIN_SID)
  })

  it('scanned（冷主）分支：主不在 active Map 仍级联（cwd 取扫描面真值）', async () => {
    const { vid, threadDir } = await createLine('linepi-cold-main')
    const coldFile = join(fx, 'cold-main.jsonl')
    vi.spyOn(service, 'findScannedSession').mockReturnValue({
      id: MAIN_SID, cwd: CWD, filePath: coldFile, name: 'cold', lastModified: 1, size: 1, timestamp: 't', outcome: null,
    } as ScannedSession)

    await service.delete(MAIN_SID)

    expect(h.destroyed).toContain(vid)
    expect(btwSvc.listLines(MAIN_SID)).toEqual([])
    expect(existsSync(threadDir)).toBe(false)
    expect(service.delete).toBeDefined() // 冷主分支真跑完（trash 面：文件不存在 → 跳 trash）
    expect(vi.mocked(service.findScannedSession)).toHaveBeenCalledTimes(1)
  })

  it('多线：快照枚举逐线处置（枚举先于注册表移除——D9④ 顺序约束）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const a = await createLine('linepi-multi-a')
    const b = await createLine('linepi-multi-b')

    await service.delete(MAIN_SID)

    expect(h.destroyed).toEqual(expect.arrayContaining([a.vid, b.vid]))
    expect(existsSync(a.threadDir)).toBe(false)
    expect(existsSync(b.threadDir)).toBe(false) // 两线共享同一线目录（cwd+mainSid 推导）
  })
})

describe('三路并发收敛（D9④）：单入口 closeLine + 幂等', () => {
  it('deleteByCwd 批内连带：主级联 + 活跃线 vid 直删同批完成，failed 为空', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { vid, threadDir } = await createLine('linepi-batch-1')
    // 线在 runtime 是一等注册会话（BtwService 经真实 registerSession 汇入）——批内直删面
    await service.initializeManagedSession(vid, {} as IPiEngine, CWD, 'line', undefined, true)

    const result = await service.deleteByCwd(CWD)

    expect(result.failed).toEqual([])
    expect(result.deleted).toEqual(expect.arrayContaining([MAIN_SID, vid]))
    expect(btwSvc.listLines(MAIN_SID)).toEqual([])
    expect(existsSync(threadDir)).toBe(false)
    expect(h.destroyed).toContain(vid)
  })

  it('批内重复处置幂等：主删级联已关线后，批内后续 delete(vid) 不抛不记 failed；二次批零动作', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { vid } = await createLine('linepi-idem-1')
    await service.initializeManagedSession(vid, {} as IPiEngine, CWD, 'line', undefined, true)
    // 显式顺序：主在前（Set 插入序）→ 级联先行 → 随后 delete(vid) 必落「线已不在」
    const first = await service.deleteByCwd(CWD)
    expect(first.failed).toEqual([])

    // 直删已关线（三路任一先到都幂等）
    await expect(service.delete(vid)).resolves.toBeUndefined()
    // 第二批：全部已删，空批零动作
    const second = await service.deleteByCwd(CWD)
    expect(second.deleted).toEqual([])
    expect(second.failed).toEqual([])
  })

  it('btw.remove 先关线 → 主删级联照常（closeAllForMain 对空注册表幂等 + 目录兜底删）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { vid, threadDir } = await createLine('linepi-remove-then-cascade')

    const closed = await btwSvc.closeLine(vid, { deleteSessionFile: true }) // btw.remove 原语
    expect(closed).toBe(true)
    expect(await btwSvc.closeLine(vid)).toBe(false) // 二次关线返 false（幂等信号，handler 映射 line_not_found）

    await service.delete(MAIN_SID) // 级联对空注册表零动作，目录 cwd 推导仍删
    expect(existsSync(threadDir)).toBe(false)
    expect(pm.destroySession).toHaveBeenCalledWith(MAIN_SID)
  })

  it('级联失败 best-effort：closeAllForMain 拒绝不阻断主删除（P2 降级隔离 + warn 留痕）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    setBtwCascadeOps({
      closeLine: vi.fn(async () => true),
      closeAllForMain: vi.fn(async () => { throw new Error('cascade boom') }),
    })

    await expect(service.delete(MAIN_SID)).resolves.toBeUndefined()
    expect(service.getSession(MAIN_SID)).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[session-lifecycle] btw cascade failed'),
      expect.anything(),
    )
  })
})

describe('P-invisible：线不出侧边栏 / 不记工作区历史（runtime 面）', () => {
  it('侧边栏面：SessionScanner 列举过滤 hidden（active 腿防线；磁盘腿靠目录隔离）', () => {
    const summary = (id: string, hidden?: boolean): SessionSummary => ({
      id, label: id, cwd: fx, status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0, hidden,
    })
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => [summary('visible-main'), summary('btw:line-invis', true)],
      getActiveFilePaths: () => new Set<string>(),
    }
    const scanner = new SessionScanner(
      svc,
      { scanSessions: () => [] } as unknown as ISessionStore,
      { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as unknown as IGitInfoReader,
    )
    const ids = scanner.listPersistedSessions().flatMap(g => g.sessions.map(s => s.id))
    expect(ids).toContain('visible-main')
    expect(ids).not.toContain('btw:line-invis')
  })

  it('工作区历史面：btw 线经 registerSession 汇聚点注册不记工作区历史（record 零调用）', async () => {
    await service.initializeManagedSession('btw:line-workspace-1', {} as IPiEngine, CWD, 'line', undefined, true)
    expect(workspace.record).not.toHaveBeenCalled()
  })
})
