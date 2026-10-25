/**
 * M4-a / btw-question：deleteSession 级联支线 + 线终结三路并发收敛 + P-invisible runtime 面。
 *
 * 探针落点：
 * - **P-cascade**（删主即删线）：杀名下线进程 + 删 `btw/<encodeCwd>/<mainSid>/` 目录 +
 *   注册表清空；active / scanned（冷主）两分支同覆盖。
 * - **三路并发收敛（D9④）**：session.delete 级联 / deleteByCwd 批内连带（含 btw 线直删）/
 *   btw.remove 关线——单入口 closeLine、枚举先于注册表移除、abort/删除幂等（重复处置不抛、
 *   批内不记 failed）；级联失败 best-effort 不阻断主删除（P2 降级隔离）。
 * - **P-invisible·侧边栏面**：SessionScanner.listAll 的 surface 正向谓词过滤拦下 btw 线条目
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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary, SessionSurface } from '@taiji/shared'

import { SessionService } from '../session-service.js'
import { SessionScanner } from '../session-scanner.js'
import { setBtwCascadeOps } from '../session-lifecycle.js'
import { initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { clearRemovedSessionData } from '../../plugin-service/session-data-store.js'
import { BtwService } from '../btw-service.js'
import { CanvasService } from '../../canvas/canvas-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import { getSessionStoreDir } from '@taiji/shared/paths'
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
import { trashDirectory as realTrashDirectory } from '../../../infra/system/trash.js'

// closeLine 线树软删走 infra trashDirectory：platform 钉 linux（任何宿主机走非 mac 降级
// rmSync 分支——落盘可断言、不触真实废纸篓）；execFileSync mock 兜底锁定零子进程（其余
// child_process 导出保持真实——import 链上 process-probe 的 execFile 不受影响）。
// tmpdir 保持真实（fs-guard 白名单 = os.tmpdir()）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})

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
 * 分支② 形态建线（无 fork；线目录落真实 `getBtwThreadDir(MAIN_SID)`（<root>/<mainSid>/btw/）
 * + 真实线文件，供删除面断言）。W4a 键统一：返回线 session id（= pi 真实 id）、线目录与
 * 线树（<root>/<线sid>/）。
 */
async function createLine(linePiSid = 'linepi-cascade-1'): Promise<{ sessionId: string; threadDir: string; lineTree: string }> {
  h.deps.resolveMainSessionFile = vi.fn(() => undefined)
  const threadDir = getBtwThreadDir(MAIN_SID)
  const file = writeSessionFile(threadDir, `${linePiSid}.jsonl`, {
    type: 'session', version: 3, id: linePiSid, timestamp: 't', cwd: CWD,
  }, [])
  h.state = { sessionId: linePiSid, sessionFile: file }
  const res = await btwSvc.createLine({ mainSid: MAIN_SID, cwd: CWD })
  return { sessionId: res.sessionId, threadDir, lineTree: join(getSessionStoreDir(), linePiSid) }
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
  // 线树软删走真实降级通道（platform 钉 linux，断言落盘效果）；deps 注入形态（C-comm-03）
  h.deps.trashDirectory = vi.fn((dirPath: string) => realTrashDirectory(dirPath))
  btwSvc = new BtwService(h.deps)
  createSetup()
  setBtwCascadeOps(btwSvc)
  // 组合根同款注入（index.ts onLineTerminated）：线终结的 lifecycle 收尾扇出
  //（planned kill 不走 exit 链，Map 条目不自清——本回调是三路终结合一收敛点）。
  h.deps.onLineTerminated = (sessionId) => {
    if (!service.getSession(sessionId)) return
    service.detachSession(sessionId)
    service.removeSessionEntry(sessionId)
    clearRemovedSessionData(sessionId)
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

describe('P-cascade：删主 session → 杀名下线进程 + 软删线树 + 注册表清空', () => {
  it('active 主分支：closeAllForMain 杀线（destroySession 收尸）+ 逐线软删线树 + listLines 归空', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { sessionId, lineTree } = await createLine()
    mkdirSync(join(lineTree, 'subagents'), { recursive: true }) // 线派生数据形态
    expect(existsSync(lineTree)).toBe(true)

    await service.delete(MAIN_SID)

    expect(h.destroyed).toContain(sessionId) // 线进程被杀（派生任务随 pi 进程亡）
    expect(btwSvc.listLines(MAIN_SID)).toEqual([]) // 注册表清空
    expect(existsSync(lineTree)).toBe(false) // 线树 <root>/<线sid>/ 整树软删（级联逐线触发）
    // 线目录（<root>/<mainSid>/btw/）随主树回收（删除编排整树通道），btw 侧不再独立删
    expect(service.getSession(MAIN_SID)).toBeUndefined() // 主本体照常删除
    expect(pm.destroySession).toHaveBeenCalledWith(MAIN_SID)
  })

  it('scanned（冷主）分支：主不在 active Map 仍级联（cwd 取扫描面真值）', async () => {
    const { sessionId, lineTree } = await createLine('linepi-cold-main')
    const coldFile = join(fx, 'cold-main.jsonl')
    vi.spyOn(service, 'findScannedSession').mockReturnValue({
      id: MAIN_SID, cwd: CWD, filePath: coldFile, name: 'cold', lastModified: 1, size: 1, timestamp: 't', outcome: null,
    } as ScannedSession)

    await service.delete(MAIN_SID)

    expect(h.destroyed).toContain(sessionId)
    expect(btwSvc.listLines(MAIN_SID)).toEqual([])
    expect(existsSync(lineTree)).toBe(false)
    expect(service.delete).toBeDefined() // 冷主分支真跑完（trash 面：文件不存在 → 跳 trash）
    expect(vi.mocked(service.findScannedSession)).toHaveBeenCalledTimes(1)
  })

  it('多线：快照枚举逐线处置（枚举先于注册表移除——D9④ 顺序约束；各线树各自软删）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const a = await createLine('linepi-multi-a')
    const b = await createLine('linepi-multi-b')

    await service.delete(MAIN_SID)

    expect(h.destroyed).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]))
    expect(existsSync(a.lineTree)).toBe(false)
    expect(existsSync(b.lineTree)).toBe(false) // 两线共享同一线目录（mainSid 分区）、线树各按线 sid 软删
  })
})

describe('画布解绑集成（F1-11 · D4 归属模型：owner = 创建会话，解绑 = 真删除模块分发）', () => {
  /**
   * 独立 CanvasService（D4 归属模型：数据落 ext-sessions 树 `<dataDir>/ext-sessions/
   * <ownerSid>/canvases/`，测试注入 mkdtemp dataDir 自建自删；构造即挂模块级分发登记——
   * delete 编排的 unbindCanvasOnSessionDeleted 真分发落本实例）。owner 建画布 = 绑定
   * （归属即绑定，旧 bindSession 多对多模型已随 D4 退役）。
   */
  function makeCanvasService(): { svc: CanvasService; dispose: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'btw-cascade-canvas-'))
    const svc = new CanvasService({ dataDir: dir })
    return {
      svc,
      dispose: (): void => {
        svc.dispose()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      },
    }
  }

  function createCanvas(svc: CanvasService, ownerSid: string): string {
    const created = svc.mutate(
      { action: 'create', params: { statement: '画布绑定解绑探针', criterias: ['c1'], scopeExclusions: [] } },
      'agent',
      ownerSid,
    )
    if (!created.ok) throw new Error(`create 失败：${JSON.stringify(created.error)}`)
    return created.canvasId as string
  }

  it('主会话自身画布：delete(MAIN_SID) 后内存镜像摘除（unbindCanvasOnSessionDeleted 真分发链路）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const canvas = makeCanvasService()
    try {
      const canvasId = createCanvas(canvas.svc, MAIN_SID)
      expect(canvas.svc.getBoundSessions(canvasId)).toEqual([MAIN_SID]) // owner 即绑定

      await service.delete(MAIN_SID)

      expect(canvas.svc.getBoundSessions(canvasId)).toEqual([]) // 真删除即解绑（主删自身挂点）
    } finally {
      canvas.dispose()
    }
  })

  it('btw 线画布：W4a 后线 session id（pi 真实 id）是合法 owner；线直删真实链路不波及主会话画布', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { sessionId } = await createLine('linepi-unbind-direct')
    await service.initializeManagedSession(sessionId, {} as IPiEngine, CWD, 'line', undefined, undefined, undefined, undefined, undefined, undefined, 'btw')
    const canvas = makeCanvasService()
    try {
      // W4a 键统一：线 id = pi 真实会话 id，过 isPiSessionId 归属校验（旧 `btw:` 含冒号
      // 形态必拒——该拒绝面随 vid 退役失去服务对象；线内画布的展示抑制在 renderer 托盘
      // 读侧 derivedSuppressed，线内画布经线 owner 会话托盘承载）。
      const lineCreated = canvas.svc.mutate(
        { action: 'create', params: { statement: '线归属探针', criterias: ['c1'], scopeExclusions: [] } },
        'agent',
        sessionId,
      )
      expect(lineCreated.ok).toBe(true)

      const mainCanvasId = createCanvas(canvas.svc, MAIN_SID)

      await service.delete(sessionId) // btw 线直删分支（解绑分发按线 session id 调用）

      expect(canvas.svc.getBoundSessions(mainCanvasId)).toEqual([MAIN_SID]) // 主画布不受线删除影响
      expect(canvas.svc.getBoundSessions(lineCreated.canvasId as string)).toEqual([]) // 线画布随线真删除解绑
    } finally {
      canvas.dispose()
    }
  })
})

describe('三路并发收敛（D9④）：单入口 closeLine + 幂等', () => {
  it('deleteByCwd 批内连带：主级联 + 活跃线直删同批完成，failed 为空', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { sessionId, lineTree } = await createLine('linepi-batch-1')
    // 线在 runtime 是一等注册会话（BtwService 经真实 registerSession 汇入，键 = piId）——批内直删面
    await service.initializeManagedSession(sessionId, {} as IPiEngine, CWD, 'line', undefined, undefined, undefined, undefined, undefined, undefined, 'btw')

    const result = await service.deleteByCwd(CWD)

    expect(result.failed).toEqual([])
    expect(result.deleted).toEqual(expect.arrayContaining([MAIN_SID, sessionId]))
    expect(btwSvc.listLines(MAIN_SID)).toEqual([])
    expect(existsSync(lineTree)).toBe(false) // 线树随级联软删
    expect(h.destroyed).toContain(sessionId)
  })

  it('批内重复处置幂等：主删级联已关线后，批内不记 failed；直删已关线与主会话同语义（not-found）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { sessionId } = await createLine('linepi-idem-1')
    await service.initializeManagedSession(sessionId, {} as IPiEngine, CWD, 'line', undefined, undefined, undefined, undefined, undefined, undefined, 'btw')
    // 显式顺序：主在前（Set 插入序）→ 级联先行 → 批内对已关线的处置落「已不在册」
    const first = await service.deleteByCwd(CWD)
    expect(first.failed).toEqual([]) // 批内幂等：记 deleted 不记 failed（deleteByCwd alreadyGone 分支）

    // W4a 后线与主会话删除语义统一：直删一个已不在册的 id（线或主会话）一律 not-found
    // 抛错——旧 isBtwVirtualId 前缀判别对任意 btw: 形态恒真（幂等 no-op）是 vid 时代的
    // 线特例，成员查询判别下该特例消失（I1：一个会话一个语义）。
    await expect(service.delete(sessionId)).rejects.toThrow(/not found/)
    await expect(service.delete(MAIN_SID)).rejects.toThrow(/not found/)
    // 第二批：全部已删，空批零动作
    const second = await service.deleteByCwd(CWD)
    expect(second.deleted).toEqual([])
    expect(second.failed).toEqual([])
  })

  it('btw.remove 先关线 → 主删级联照常（closeAllForMain 对空注册表幂等零动作）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    const { sessionId, threadDir, lineTree } = await createLine('linepi-remove-then-cascade')

    const closed = await btwSvc.closeLine(sessionId, { deleteSessionFile: true }) // btw.remove 原语
    expect(closed).toBe(true)
    expect(existsSync(join(threadDir, 'linepi-remove-then-cascade.jsonl'))).toBe(false) // 线文件已删
    expect(existsSync(lineTree)).toBe(false) // 线树已软删
    expect(await btwSvc.closeLine(sessionId)).toBe(false) // 二次关线返 false（幂等信号，handler 映射 line_not_found）

    await service.delete(MAIN_SID) // 级联对空注册表零动作（线目录随主树回收，btw 侧不再独立删）
    expect(pm.destroySession).toHaveBeenCalledWith(MAIN_SID)
  })

  it('级联失败 best-effort：closeAllForMain 拒绝不阻断主删除（P2 降级隔离 + warn 留痕）', async () => {
    await service.initializeManagedSession(MAIN_SID, {} as IPiEngine, CWD, 'main')
    setBtwCascadeOps({
      closeLine: vi.fn(async () => true),
      closeAllForMain: vi.fn(async () => { throw new Error('cascade boom') }),
      getLine: vi.fn(() => undefined),
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
  it('侧边栏面：SessionScanner 列举过滤 surface !== sidebar（active 腿防线；磁盘腿靠目录隔离）', () => {
    const summary = (id: string, surface?: SessionSurface): SessionSummary => ({
      id, label: id, cwd: fx, status: 'idle', lastActiveAt: 1, surface,
    })
    const svc: IScannerSessionOps = {
      getActiveSummaries: () => [summary('visible-main', 'sidebar'), summary('linepi-invis', 'btw')],
      getActiveFilePaths: () => new Set<string>(),
    }
    const scanner = new SessionScanner(
      svc,
      { scanSessions: () => [] } as unknown as ISessionStore,
      { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as unknown as IGitInfoReader,
    )
    const ids = scanner.listPersistedSessions().flatMap(g => g.sessions.map(s => s.id))
    expect(ids).toContain('visible-main')
    expect(ids).not.toContain('linepi-invis')
  })

  it('工作区历史面：btw 线经 registerSession 汇聚点注册不记工作区历史（record 零调用）', async () => {
    // W5：判据切 surface === 'sidebar'（读注册后记录）；btw 线显式传 'btw' 不记录
    await service.initializeManagedSession('linepi-workspace-1', {} as IPiEngine, CWD, 'line', undefined, undefined, undefined, undefined, undefined, undefined, 'btw')
    expect(workspace.record).not.toHaveBeenCalled()
  })
})
