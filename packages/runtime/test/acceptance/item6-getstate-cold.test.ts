/**
 * D3 验收资产：§7 验收项 6（getState 冷线零 spawn + 快照未就绪无 restore）gap 测试。
 *
 * 规格原文（设计文档 §7 表项 6）：`getState` 查询冷线不产生 pi 子进程（进程表断言）；
 * **反向**：对已注册活会话在其快照未就绪时调 `getState`，断言无 restore/spawn 发生、
 * 应答字段缺省返回（覆盖快照未就绪场景）。
 *
 * 与既有覆盖的分工（本文件只补 D3 验收视角的缺口，不重复单元层断言）：
 * - `src/services/session/__tests__/session-state-query.test.ts`（u-w2）项6-a/b/c/d/e 已
 *   覆盖：冷读零 spawn（boom 形态进程表）、活会话标量快照 undefined → 字段缺省、只就绪
 *   一维、client 已退出回落冷读。其进程表 mock 的 ensureActive 未定义（隐式 undefined）、
 *   ensureProcess 等 spawn 形态是 boom + spawnCalls 记录而非 vi.fn（不可做零调用计数断言），
 *   且未断言冷读定位缝的调用形态。
 * - `src/services/session/__tests__/session-state-projection-query-wiring.test.ts` 已覆盖
 *   接线层 getClient（禁 ensureActive）与埋点接 logger。
 * - `src/transport/__tests__/session-message-handler-get-state.test.ts` 已覆盖 handler
 *   透传 / 错误 envelope / 字段缺省正常 reply。
 *
 * 本文件补的缺口：
 * 1. 进程表 = 全 vi.fn mock（ensureActive / ensureProcess / getClient 及全部 spawn 形态），
 *    冷读后逐项断言零调用（spawn 风险点 1/2/3 的注入缝即断言点，调用即留痕）；
 * 2. filePath 只准来自注入的三个定位缝（风险点 3）——冷读后断言三缝的调用形态；
 * 3. 活会话快照未就绪的两种 stub 形态都锁定：标量值 undefined（应答字段缺省、且不回落
 *    冷读）与 getReplicatedStates 整体返 undefined（按设计 §3.3.3 伪码
 *    `pm.getClient(id) && projection.getReplicatedStates(id)` 回落冷读，仍不触发
 *    restore/spawn；冷读也未命中 = SESSION_NOT_FOUND 显式未知）。
 *
 * 数据隔离（项目测试红线）：fixture 落 `mkdtempSync(join(tmpdir(), ...))` +
 * TAIJI_AGENT_DATA_DIR 指向该 tmp，不触真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item6-getstate-cold.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IProcessManager, IPiEngine } from '../../src/services/ports/pi-engine.js'
import type { ModelIdSnapshot, ThinkingLevelSnapshot } from '../../src/services/session/replicated-states.config.js'
import type { ReplicatedState } from '../../src/services/session/replicated-state.js'
import {
  SessionStateQuery,
  SessionNotFoundError,
  type SessionStateQueryDeps,
  type SessionStateLiveStates,
} from '../../src/services/session/session-state-query.js'
import {
  findCachedSessionFileById,
  findScannedSessionFileById,
  findBtwLineFileByPiSessionId,
} from '../../src/infra/pi/session-file-locator.js'
import { invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../../src/infra/pi/session-file-utils.js'

// ── fixture（pi session JSONL 最小真实形态）────────────────────────────────

function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}

/** 在主会话扫描区写一个带模型/档位记录的 JSONL，返回 { sessionId, filePath }。 */
function seedMainSession(dataDir: string): { sessionId: string; filePath: string } {
  const sessionId = '77777777-7777-4777-8777-777777777777'
  const filePath = join(dataDir, 'agent', 'sessions', 'c0ffee-group', `${sessionId}.jsonl`)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, [
    headerLine(sessionId, '/tmp/proj'),
    JSON.stringify({ type: 'session_info', id: 's1' }),
    JSON.stringify({ type: 'model_change', id: 'mc1', parentId: 's1', provider: 'prov-cold', modelId: 'model-cold', timestamp: '2026-10-24T00:00:03.000Z' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', thinkingLevel: 'high', timestamp: '2026-10-24T00:00:04.000Z' }),
  ].join('\n') + '\n', 'utf8')
  return { sessionId, filePath }
}

// ── deps fake ──────────────────────────────────────────────────────────────

/** 进程表 mock：全部 vi.fn（含全部 spawn 形态），调用即留痕、零调用即可断言。 */
function makeProcessTable(opts: { liveSessionIds?: readonly string[] } = {}) {
  const live = new Set(opts.liveSessionIds ?? [])
  const getClient = vi.fn((sessionId: string) => (live.has(sessionId) ? ({ id: sessionId } as unknown as IPiEngine) : undefined))
  const ensureActive = vi.fn(() => { throw new Error('ensureActive must not be called by getState') })
  const ensureProcess = vi.fn(() => { throw new Error('ensureProcess must not be called by getState') })
  const createSession = vi.fn(() => { throw new Error('createSession must not be called by getState') })
  const restoreSession = vi.fn(() => { throw new Error('restoreSession must not be called by getState') })
  const withEphemeralPi = vi.fn(() => { throw new Error('withEphemeralPi must not be called by getState') })
  const pm = { getClient, ensureActive, ensureProcess, createSession, restoreSession, withEphemeralPi } as unknown as IProcessManager
  return { pm, getClient, ensureActive, ensureProcess, createSession, restoreSession, withEphemeralPi }
}

/** 标量实例 fake（ReplicatedState 只读窄面；undefined = 快照未就绪）。 */
function scalarStub<T>(value: T | undefined): ReplicatedState<T> {
  return { get: () => value } as unknown as ReplicatedState<T>
}

function liveStatesStub(modelId: string | undefined, thinkingLevel: string | undefined): SessionStateLiveStates {
  return {
    modelId: scalarStub<ModelIdSnapshot>(modelId === undefined ? undefined : { modelId }),
    thinkingLevel: scalarStub<ThinkingLevelSnapshot>(thinkingLevel === undefined ? undefined : { thinkingLevel }),
  }
}

/** 定位缝 spy：包装真实定位函数（证明 filePath 只来自注入缝），调用留痕。 */
function makeLocateSeams() {
  const locateMainSessionFileFromCache = vi.fn((sid: string) => findCachedSessionFileById(sid))
  const locateMainSessionFileFromDisk = vi.fn((sid: string) => findScannedSessionFileById(sid))
  const locateBtwLineFile = vi.fn((sid: string) => findBtwLineFileByPiSessionId(sid))
  return { locateMainSessionFileFromCache, locateMainSessionFileFromDisk, locateBtwLineFile }
}

function makeQuery(deps: Omit<SessionStateQueryDeps, 'locateMainSessionFileFromCache' | 'locateMainSessionFileFromDisk' | 'locateBtwLineFile'> & Partial<Pick<SessionStateQueryDeps, 'locateMainSessionFileFromCache' | 'locateMainSessionFileFromDisk' | 'locateBtwLineFile'>>): { query: SessionStateQuery; seams: ReturnType<typeof makeLocateSeams> } {
  const seams = makeLocateSeams()
  const query = new SessionStateQuery({
    ...deps,
    locateMainSessionFileFromCache: deps.locateMainSessionFileFromCache ?? seams.locateMainSessionFileFromCache,
    locateMainSessionFileFromDisk: deps.locateMainSessionFileFromDisk ?? seams.locateMainSessionFileFromDisk,
    locateBtwLineFile: deps.locateBtwLineFile ?? seams.locateBtwLineFile,
  })
  return { query, seams }
}

// ── 测试体 ────────────────────────────────────────────────────────────────

describe('§7 验收项 6：getState 冷线零 spawn + 快照未就绪无 restore', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'item6-getstate-cold-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('冷线查询：进程表全 vi.fn mock 下 ensureActive/ensureProcess/spawn 形态零调用，活跃判定只走 getClient', async () => {
    const fx = seedMainSession(dataDir)
    // 冷会话 = 进程表无该 session 的 client
    const table = makeProcessTable()
    const { query, seams } = makeQuery({ getClient: table.getClient, getReplicatedStates: () => undefined })

    const state = await query.getState(fx.sessionId)

    // 冷读正确返回文件值（证明冷线查询本身跑通，不是空转通过）
    expect(state).toEqual({
      sessionId: fx.sessionId,
      modelId: 'prov-cold/model-cold',
      thinkingLevel: 'high',
    })
    // 进程表断言：ensureActive / ensureProcess / createSession / restoreSession /
    // withEphemeralPi 全部零调用（spawn 风险点 1：活跃判定唯一合法入口 = getClient）
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.createSession).not.toHaveBeenCalled()
    expect(table.restoreSession).not.toHaveBeenCalled()
    expect(table.withEphemeralPi).not.toHaveBeenCalled()
    expect(table.getClient).toHaveBeenCalledTimes(1)
    expect(table.getClient).toHaveBeenCalledWith(fx.sessionId)
  })

  it('冷线查询：filePath 只来自注入的三个定位缝（段1缓存 miss → 段2全扫 hit，btw 成员查询先行）', async () => {
    const fx = seedMainSession(dataDir)
    // 不预热 metaCache：段 1（缓存全表遍历）miss → 段 2（force 全扫）hit
    const table = makeProcessTable()
    const { query, seams } = makeQuery({ getClient: table.getClient, getReplicatedStates: () => undefined })

    const state = await query.getState(fx.sessionId)

    expect(state.modelId).toBe('prov-cold/model-cold')
    // 风险点 3：filePath 来源收敛在注入缝上——btw 成员查询先行（主会话恒 miss），
    // 随后段 1 缓存 miss、段 2 全扫 hit；无第四个取路径的调用形态
    expect(seams.locateBtwLineFile).toHaveBeenCalledWith(fx.sessionId)
    expect(seams.locateMainSessionFileFromCache).toHaveBeenCalledWith(fx.sessionId)
    expect(seams.locateMainSessionFileFromDisk).toHaveBeenCalledWith(fx.sessionId)
    // 进程表仍零 spawn（与上一条同口径，本条聚焦定位缝）
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.restoreSession).not.toHaveBeenCalled()
  })

  it('快照未就绪（标量值 undefined）：活会话应答字段缺省、不回落冷读、无 restore/spawn', async () => {
    const fx = seedMainSession(dataDir)
    // 已注册活会话：getClient 有 client；实例快照存在但标量值未就绪（.get() = undefined）
    const table = makeProcessTable({ liveSessionIds: [fx.sessionId] })
    const getReplicatedStates = vi.fn(() => liveStatesStub(undefined, undefined))
    const { query, seams } = makeQuery({ getClient: table.getClient, getReplicatedStates })

    const state = await query.getState(fx.sessionId)

    // 应答字段缺省 = 显式未知（不编码为 0/空串、不用文件值兜底）
    expect(state).toEqual({ sessionId: fx.sessionId })
    expect(state.modelId).toBeUndefined()
    expect(state.thinkingLevel).toBeUndefined()
    // 不回落冷读（否则活会话暂无快照会被误报成文件值）
    expect(seams.locateBtwLineFile).not.toHaveBeenCalled()
    expect(seams.locateMainSessionFileFromCache).not.toHaveBeenCalled()
    expect(seams.locateMainSessionFileFromDisk).not.toHaveBeenCalled()
    // 未就绪不得触发 restore/spawn（风险点 2）
    expect(table.restoreSession).not.toHaveBeenCalled()
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.createSession).not.toHaveBeenCalled()
    expect(table.withEphemeralPi).not.toHaveBeenCalled()
    expect(getReplicatedStates).toHaveBeenCalledWith(fx.sessionId)
  })

  it('快照未就绪（getReplicatedStates 整体返 undefined）：按设计伪码回落冷读读文件值，无 restore/spawn', async () => {
    const fx = seedMainSession(dataDir)
    const table = makeProcessTable({ liveSessionIds: [fx.sessionId] })
    // 设计 §3.3.3 伪码：`pm.getClient(id) && projection.getReplicatedStates(id)`——
    // 后半为 undefined 时整体 falsy，回落冷读分支（locateFile → fromFile）
    const { query } = makeQuery({ getClient: table.getClient, getReplicatedStates: () => undefined })

    const state = await query.getState(fx.sessionId)

    expect(state).toEqual({
      sessionId: fx.sessionId,
      modelId: 'prov-cold/model-cold',
      thinkingLevel: 'high',
    })
    // 回落冷读同样不得触发 restore/spawn
    expect(table.restoreSession).not.toHaveBeenCalled()
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.createSession).not.toHaveBeenCalled()
    expect(table.withEphemeralPi).not.toHaveBeenCalled()
  })

  it('快照未就绪且冷读也未命中（无文件）：SESSION_NOT_FOUND 显式未知，仍不触发 restore/spawn', async () => {
    const liveSid = '88888888-8888-4888-8888-888888888888'
    const table = makeProcessTable({ liveSessionIds: [liveSid] })
    // 活会话 + 无实例快照 + 磁盘无文件：冷读两段与 btw 定位全部 miss
    const { query } = makeQuery({ getClient: table.getClient, getReplicatedStates: () => undefined })

    await expect(query.getState(liveSid)).rejects.toBeInstanceOf(SessionNotFoundError)
    // 冷读失败也不准 restore/spawn 兜底（不得把「查不到」升级成「拉活」）
    expect(table.restoreSession).not.toHaveBeenCalled()
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.createSession).not.toHaveBeenCalled()
    expect(table.withEphemeralPi).not.toHaveBeenCalled()
  })
})
