import { closeLogger, createPiSessionLog, initLogger, migratePiSessionLogTree } from '../../src/infra/logger.js';
import { ProcessManager } from '../../src/infra/pi/process-manager.js';
import { findBtwLineFileByLayout, findCachedSessionFileById, findScannedSessionFileById } from '../../src/infra/pi/session-file-locator.js';
import { _resetSessionMetaCacheForTest, invalidateScanDirCache, scanJsonlFromTail } from '../../src/infra/pi/session-file-utils.js';
import { PiSessionStore } from '../../src/infra/pi/session-store.js';
import type { ISessionService, IEventAdapter } from '../../src/interfaces.js';
import type { IConfigStore } from '../../src/services/ports/config.js';
import type { IGitInfoReader } from '../../src/services/ports/git-info.js';
import type { IProcessManager, IPiEngine } from '../../src/services/ports/pi-engine.js';
import type { ISessionStore } from '../../src/services/ports/session.js';
import { type BtwLineRecord, BtwService } from '../../src/services/session/btw-service.js';
import type { ReplicatedState } from '../../src/services/session/replicated-state.js';
import type { ModelIdSnapshot, ThinkingLevelSnapshot } from '../../src/services/session/replicated-states.config.js';
import type { ILifecycleSessionOps, ISessionRegisterDeps, IScannerSessionOps } from '../../src/services/session/session-internal.js';
import { SessionLifecycle } from '../../src/services/session/session-lifecycle.js';
import { SessionListQueryService } from '../../src/services/session/session-list-query.js';
import { SessionScanner } from '../../src/services/session/session-scanner.js';
import { SessionNotFoundError, SessionStateQuery, type SessionStateColdReadTrace, type SessionStateLiveStates, type SessionStateQueryDeps } from '../../src/services/session/session-state-query.js';
import type { IManagedSessionView } from '../../src/services/session/types.js';
import type { WorkspaceService } from '../../src/services/workspace/workspace-service.js';
import { SessionMessageHandler, type SessionHandlerContext } from '../../src/transport/session-message-handler.js';
import { type SessionGroup, type SessionSummary, type SessionSurface, readLogKeepDays } from '@taiji/shared';
import { getSessionBtwDir, getSessionStoreDir } from '@taiji/shared/paths';
import { encodeCwd } from '@taiji/shared/session-store-paths';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/acceptance/item1-fork-coldread.test.ts
// ======================================================================

// ── fixture 构造（pi session JSONL 的最小真实形态；§10.1 六步序列离线等价物）────────

import type { ClientMessage } from '@taiji/shared';
/** session header 行（pi 落盘首行；trimFileEntriesToActivePath 会剥掉它） */
function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}


function entryLine(type: string, id: string, parentId: string | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id, ...(parentId !== undefined ? { parentId } : {}), ...extra })
}


/** user 消息 entry（§10.1 步骤 1：撤回的定位目标形态） */
function userMessageLine(id: string, parentId: string): string {
  return entryLine('message', id, parentId, { message: { role: 'user', content: 'hello' }, timestamp: '2026-10-24T00:00:01.000Z' })
}


/** assistant 消息 entry（携带 provider/model；撤回后随 user 消息一并离开活跃路径） */
function assistantMessageLine(id: string, parentId: string, provider: string, model: string): string {
  return entryLine('message', id, parentId, { message: { role: 'assistant', provider, model, content: 'ok' }, timestamp: '2026-10-24T00:00:02.000Z' })
}


/** model_change entry（pi 唯一显式 setModel 写点；provider/modelId 平铺在 entry 顶级） */
function modelChangeLine(id: string, parentId: string, provider: string, modelId: string): string {
  return entryLine('model_change', id, parentId, { provider, modelId, timestamp: '2026-10-24T00:00:03.000Z' })
}


/** thinking_level_change entry（档位来源） */
function thinkingLevelLine(id: string, parentId: string, thinkingLevel: string): string {
  return entryLine('thinking_level_change', id, parentId, { thinkingLevel, timestamp: '2026-10-24T00:00:04.000Z' })
}


/** label entry（§10.1 步骤 3 撤回的产物：appendLabelChange 把 taiji:revoked 标签挂成新叶，parentId = 撤回后的 leafId） */
function labelLine(id: string, parentId: string, targetId: string): string {
  return entryLine('label', id, parentId, { targetId, label: 'taiji:revoked', timestamp: '2026-10-24T00:00:05.000Z' })
}


function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}


/** 主会话扫描区目录名（encodeCwd 分组哈希；scanPiSessions 只枚举该层目录内的 *.jsonl） */
const CWD_GROUP = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'


/**
 * §10.1 六步序列的离线等价构造（主会话 + btw 线一对 fixture）。
 *
 * 主会话文件（步骤 1-5 的落点）：
 *   s1    session_info（根）
 *   mcA   model_change A          ← 步骤 1 前「主会话在模型 A」
 *   tlA   thinking_level_change high（A 侧 trunk——撤回后 user 消息连同其 assistant
 *         子节点一并离开活跃路径，A/high 的文件级记录只能落在 trunk 上）
 *   u1    user message
 *   a1    assistant（provider/model = A）
 *   mcB   model_change B          ← 步骤 2「切到 B」
 *   L     label taiji:revoked     ← 步骤 3 撤回 u1：leaf = u1.parentId = tlA，label 挂成新叶
 *   mcC   model_change C          ← 步骤 5「主会话切到 C」（fork 之后追加，不进线文件）
 *
 * 线文件（步骤 4 fork 的逐字节复制源文件全部非 header entry，只换 header）= s1..L 七条
 * （不含 mcC）。关键混合分支形态：线文件物理尾是 L，L 的 parentId 是 tlA——**活跃路径 =
 * [s1, mcA, tlA, L] 命中 A/high；被撤 B 分支（mcB，parentId=a1）在物理尾方向但不在活跃
 * 路径上**。物理尾逆读命中 mcB 得 B（错值，恰好复现本设计要消灭的「显示错值」缺陷），
 * 活跃路径逆读命中 mcA 得 A（对值）——两种读法在此 fixture 上结果不同，门因此有区分度。
 */
function seedForkFixture(dataDir: string): { mainSid: string; linePiId: string; mainFile: string; lineFile: string } {
  const mainSid = randomUUID()
  const linePiId = randomUUID()
  const mainFile = join(dataDir, 'agent', 'sessions', CWD_GROUP, `${mainSid}.jsonl`)
  // 线文件 = 存储树布局 `<dataDir>/ext-sessions/<mainSid>/btw/<fileTimestamp>_<linePiId>.jsonl`
  // （构造性不在 scanPiSessions 扫描范围，E-5）。文件名采 **pi forkFrom 实盘命名**
  // （session-manager.js forkFrom：`${fileTimestamp}_${newSessionId}.jsonl`，fileTimestamp =
  // ISO 时间戳的 `:`/`.`→`-`）——布局定位寻址必须命中该形态（D3 真机验收 A11 缺陷 1 的
  // 回归防线：旧实现只认精确名 `<linePiId>.jsonl`，重启后的线寻址结构性失败）。
  const lineFile = join(dataDir, 'ext-sessions', mainSid, 'btw', `2026-10-24T13-00-44-583Z_${linePiId}.jsonl`)

  const trunk = [
    headerLine(mainSid, '/tmp/proj'),
    entryLine('session_info', 's1', undefined),
    modelChangeLine('mcA', 's1', 'prov-a', 'model-a'),
    thinkingLevelLine('tlA', 'mcA', 'high'),
    userMessageLine('u1', 'tlA'),
    assistantMessageLine('a1', 'u1', 'prov-a', 'model-a'),
    modelChangeLine('mcB', 'a1', 'prov-b', 'model-b'),
    labelLine('L', 'tlA', 'u1'),
  ]
  writeJsonl(mainFile, [...trunk, modelChangeLine('mcC', 'L', 'prov-c', 'model-c')])
  // fork：复制全部非 header entry，只换 header（含被撤 B 分支）
  writeJsonl(lineFile, [headerLine(linePiId, '/tmp/proj'), ...trunk.slice(1)])

  return { mainSid, linePiId, mainFile, lineFile }
}


// ── deps fake（进程表 / btw 注册表记录）───────────────────────────────────────

/** 进程表 fake：任何 spawn 形态调用都炸（冷读零 spawn 断言的载体） */
function makeProcessTable(): IProcessManager {
  const boom = (name: string) => (): never => {
    throw new Error(`spawn risk point violated: ${name} must not be called by getState`)
  }
  return {
    getClient: () => undefined,
    hasClient: () => false,
    createSession: boom('createSession'),
    restoreSession: boom('restoreSession'),
    ensureActive: boom('ensureActive'),
    ensureProcess: boom('ensureProcess'),
    withEphemeralPi: boom('withEphemeralPi'),
    rekey: boom('rekey'),
    destroySession: boom('destroySession'),
  } as unknown as IProcessManager
}


/**
 * btw 线定位的两步（模拟生产投影注入）：注册表判别（btwRegistry Map 模拟 lifecycle
 * 记录）先行；存储树布局兜底沉到主会话两段均未命中之后（dmg-r1-3 判别顺序）。
 */
const btwRegistry = new Map<string, string>()


function makeQuery(): { query: SessionStateQuery; traces: SessionStateColdReadTrace[] } {
  const traces: SessionStateColdReadTrace[] = []
  const query = new SessionStateQuery({
    getClient: () => undefined,
    getReplicatedStates: () => undefined,
    locateMainSessionFileFromCache: () => undefined,
    locateMainSessionFileFromDisk: () => ({ filePath: undefined, scannedDirCount: 0 }),
    locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId),
    locateBtwLineFileByLayout: (sessionId) => findBtwLineFileByLayout(sessionId),
    onColdRead: (t) => traces.push(t),
  })
  return { query, traces }
}


// ── 负向对照：物理尾读（不裁剪）——§10.1 警告「不要用切回 A 代替撤回」的机械化 ──────

/**
 * 物理尾读（**不**做 activePath 裁剪）的模型提取——与生产 `extractLatestModelFromJsonl`
 * 同一 collect 语义、同一 scanJsonlFromTail 骨架，唯一差别 = 不传 `{ activePath: true }`。
 * 这就是「若门失效（退化为物理尾读）」时冷读会得到的值。
 */
function physicalTailModelOf(filePath: string): { modelId: string; thinkingLevel: string } | undefined {
  const hits: { modelId: string | null; thinkingLevel: string | null } = { modelId: null, thinkingLevel: null }
  const collect = (entry: Record<string, unknown>): boolean => {
    if (hits.modelId === null) {
      if (entry.type === 'model_change'
        && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
        hits.modelId = `${entry.provider}/${entry.modelId}`
      } else if (entry.type === 'message') {
        const msg = entry.message as { role?: string; provider?: string; model?: string } | undefined
        if (msg?.role === 'assistant' && typeof msg.provider === 'string' && typeof msg.model === 'string') {
          hits.modelId = `${msg.provider}/${msg.model}`
        }
      }
    }
    if (hits.thinkingLevel === null
      && entry.type === 'thinking_level_change'
      && typeof entry.thinkingLevel === 'string') {
      hits.thinkingLevel = entry.thinkingLevel
    }
    return hits.modelId !== null && hits.thinkingLevel !== null
  }
  scanJsonlFromTail(filePath, collect) // 无 opts = 不裁剪 = 物理尾读
  if (hits.modelId === null) return undefined
  return { modelId: hits.modelId, thinkingLevel: hits.thinkingLevel ?? 'off' }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('item1-fork-coldread', () => {
// ── 测试体 ─────────────────────────────────────────────────────────────

describe('§7 验收项 1：fork 混合分支文件冷读（§10.1 六步序列离线等价物）', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w2-item1-fork-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    btwRegistry.clear()
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    _resetSessionMetaCacheForTest()
    btwRegistry.clear()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('项1-a 打开（冷）btw 线显示创建时模型 A（读线自身会话文件，不是主会话当前值）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile) // 线已注册：注册表记录 sessionFilePath 命中
    const { query } = makeQuery()

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 冷读不产生 pi 子进程（进程表 = boom fake，任何 spawn 形态调用即抛）
    // 判别力自证：读到的不是被撤分支的 B
    expect(state.modelId).not.toBe('prov-b/model-b')
  })

  it('项1-b 重启应用后再开线仍显示 A（注册表记录缺席 + 缓存清空 + 全新查询实例）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    // 重启前：注册表记录一路
    expect((await makeQuery().query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 「重启」的离线等价物：metaCache 清空（缓存不跨进程持久）+ 目录 TTL 缓存清空 +
    // 注册表记录缺席（BtwService.rebuildFromDisk() 只重建自己的 registry，不注册进
    // lifecycle.sessions → 注册表记录一路结构性缺席，走存储树布局定位兜底）+
    // 全新 SessionStateQuery 实例（无任何内存态继承）
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    btwRegistry.clear()
    const afterRestart = makeQuery()
    const state = await afterRestart.query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 重启后定位来源 = btw 存储树布局（source 仍为 btw-registry 口径的定位成功）
    expect(afterRestart.traces).toHaveLength(1)
    expect(afterRestart.traces[0]).toMatchObject({ sessionId: fx.linePiId, found: true })
    // 布局兜底的枚举成本进埋点（dmg-r1-3）：本文件段 1/段 2 为 stub miss（无真实全扫），
    // scannedDirCount = 布局枚举的 mainSid 会话目录数（fixture 1 个主会话目录）
    expect(afterRestart.traces[0].scannedDirCount).toBe(1)
  })

  it('项1-c 主会话再切 D 后线仍显示 A（线文件不变；主会话自身反映新值作对照）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery()
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 主会话之后又换过模型（§10.1 步骤 5 之后再切 D：追加到主文件）——线文件的活跃路径不变
    appendFileSync(fx.mainFile, `${modelChangeLine('mcD', 'mcC', 'prov-d', 'model-d')}\n`)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    // 线不受主会话切换影响（读自己的文件）
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
    // 对照：主会话文件物理尾确已是 D（fixture 真的在动——线不读它）
    expect(physicalTailModelOf(fx.mainFile)?.modelId).toBe('prov-d/model-d')
  })

  it('项1-d 负向对照（防门失明）：同一文件物理尾读（不裁剪）返回 B，与活跃路径读结果不同', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery()

    // 生产冷读 = 活跃路径裁剪 → A（对值）
    const active = await query.getState(fx.linePiId)
    // 物理尾读（不裁剪）= 门失效时的值 → B（错值：命中被撤分支的 model_change）
    const physical = physicalTailModelOf(fx.lineFile)

    expect(physical).toEqual({ modelId: 'prov-b/model-b', thinkingLevel: 'high' })
    // 门的区分度：两种读法在混合分支 fixture 上结果不同（§10.1 警告的机械化——若 fixture
    // 退化为单链，两个值相同、门测不出任何东西）
    expect(physical?.modelId).not.toBe(active.modelId)
    expect(active.modelId).toBe('prov-a/model-a')
  })

  it('项1-e 结构证据：线文件是被撤 B 分支 + A 侧活跃路径的混合形态（物理尾 = 挂在 A 侧 trunk 的 label）', async () => {
    const fx = seedForkFixture(dataDir)
    // 混合分支形态的三条结构断言（§10.1「为何这步是门的判定器」）：
    const lines = readFileSync(fx.lineFile, 'utf8').trimEnd().split('\n')
    const entries = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>)
    // ① 被撤 B 分支的 model_change 在文件里（物理尾逆读会命中它 = 错值来源）
    expect(entries.some((e) => e.type === 'model_change' && e.id === 'mcB')).toBe(true)
    // ② 末条 entry 是 label（撤回后 appendLabelChange 的新叶），parentId 指向 A 侧 trunk（tlA）
    const last = entries.at(-1) as Record<string, unknown>
    expect(last).toMatchObject({ type: 'label', id: 'L', parentId: 'tlA' })
    // ③ 活跃路径回溯（L → tlA → mcA → s1）不含被撤分支任何 entry
    const byId = new Map(entries.map((e) => [e.id, e]))
    const activePath: string[] = []
    let cur: string | undefined = 'L'
    while (cur !== undefined) {
      activePath.push(cur)
      cur = byId.get(cur)?.parentId as string | undefined
    }
    expect(activePath).toEqual(['L', 'tlA', 'mcA', 's1'])
    expect(activePath).not.toContain('mcB')
    expect(activePath).not.toContain('a1')
    // 布局定位（存储树公式）与注册表记录读同一个文件（重启后两级寻址等价）
    expect(findBtwLineFileByLayout(fx.linePiId).filePath).toBe(fx.lineFile)
  })
})
});

// ======================================================================
// ← test/acceptance/item6-getstate-cold.test.ts
// ======================================================================

// ── fixture（pi session JSONL 最小真实形态）────────────────────────────────

function headerLine_m2(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}


/** 在主会话扫描区写一个带模型/档位记录的 JSONL，返回 { sessionId, filePath }。 */
function seedMainSession(dataDir: string): { sessionId: string; filePath: string } {
  const sessionId = '77777777-7777-4777-8777-777777777777'
  const filePath = join(dataDir, 'agent', 'sessions', 'c0ffee-group', `${sessionId}.jsonl`)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, [
    headerLine_m2(sessionId, '/tmp/proj'),
    JSON.stringify({ type: 'session_info', id: 's1' }),
    JSON.stringify({ type: 'model_change', id: 'mc1', parentId: 's1', provider: 'prov-cold', modelId: 'model-cold', timestamp: '2026-10-24T00:00:03.000Z' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', thinkingLevel: 'high', timestamp: '2026-10-24T00:00:04.000Z' }),
  ].join('\n') + '\n', 'utf8')
  return { sessionId, filePath }
}


// ── deps fake ──────────────────────────────────────────────────────────────

/** 进程表 mock：全部 vi.fn（含全部 spawn 形态），调用即留痕、零调用即可断言。 */
function makeProcessTable_m2(opts: { liveSessionIds?: readonly string[] } = {}) {
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
  const locateBtwLineFile = vi.fn((sid: string) => undefined) // 注册表判别（本验收无 btw 线 fixture）
  const locateBtwLineFileByLayout = vi.fn((sid: string) => findBtwLineFileByLayout(sid))
  return { locateMainSessionFileFromCache, locateMainSessionFileFromDisk, locateBtwLineFile, locateBtwLineFileByLayout }
}


function makeQuery_m2(deps: Omit<SessionStateQueryDeps, 'locateMainSessionFileFromCache' | 'locateMainSessionFileFromDisk' | 'locateBtwLineFile' | 'locateBtwLineFileByLayout'> & Partial<Pick<SessionStateQueryDeps, 'locateMainSessionFileFromCache' | 'locateMainSessionFileFromDisk' | 'locateBtwLineFile' | 'locateBtwLineFileByLayout'>>): { query: SessionStateQuery; seams: ReturnType<typeof makeLocateSeams> } {
  const seams = makeLocateSeams()
  const query = new SessionStateQuery({
    ...deps,
    locateMainSessionFileFromCache: deps.locateMainSessionFileFromCache ?? seams.locateMainSessionFileFromCache,
    locateMainSessionFileFromDisk: deps.locateMainSessionFileFromDisk ?? seams.locateMainSessionFileFromDisk,
    locateBtwLineFile: deps.locateBtwLineFile ?? seams.locateBtwLineFile,
    locateBtwLineFileByLayout: deps.locateBtwLineFileByLayout ?? seams.locateBtwLineFileByLayout,
  })
  return { query, seams }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('item6-getstate-cold', () => {
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
    const table = makeProcessTable_m2()
    const { query, seams } = makeQuery_m2({ getClient: table.getClient, getReplicatedStates: () => undefined })

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

  it('冷线查询：filePath 只来自注入的四个定位缝（注册表判别 → 段1缓存 miss → 段2全扫 hit，布局兜底不调）', async () => {
    const fx = seedMainSession(dataDir)
    // 不预热 metaCache：段 1（缓存全表遍历）miss → 段 2（force 全扫）hit
    const table = makeProcessTable_m2()
    const { query, seams } = makeQuery_m2({ getClient: table.getClient, getReplicatedStates: () => undefined })

    const state = await query.getState(fx.sessionId)

    expect(state.modelId).toBe('prov-cold/model-cold')
    // 风险点 3：filePath 来源收敛在注入缝上——注册表判别先行（主会话恒 miss），
    // 随后段 1 缓存 miss、段 2 全扫 hit；段 2 已命中，btw 布局兜底（存储树枚举）
    // 不再调用（dmg-r1-3 判别顺序：布局兜底沉到两段均未命中之后）；无第五个取路径的
    // 调用形态
    expect(seams.locateBtwLineFile).toHaveBeenCalledWith(fx.sessionId)
    expect(seams.locateMainSessionFileFromCache).toHaveBeenCalledWith(fx.sessionId)
    expect(seams.locateMainSessionFileFromDisk).toHaveBeenCalledWith(fx.sessionId)
    expect(seams.locateBtwLineFileByLayout).not.toHaveBeenCalled()
    // 进程表仍零 spawn（与上一条同口径，本条聚焦定位缝）
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.restoreSession).not.toHaveBeenCalled()
  })

  it('快照未就绪（标量值 undefined）：活会话应答字段缺省、不回落冷读、无 restore/spawn', async () => {
    const fx = seedMainSession(dataDir)
    // 已注册活会话：getClient 有 client；实例快照存在但标量值未就绪（.get() = undefined）
    const table = makeProcessTable_m2({ liveSessionIds: [fx.sessionId] })
    const getReplicatedStates = vi.fn(() => liveStatesStub(undefined, undefined))
    const { query, seams } = makeQuery_m2({ getClient: table.getClient, getReplicatedStates })

    const state = await query.getState(fx.sessionId)

    // 应答字段缺省 = 显式未知（不编码为 0/空串、不用文件值兜底）
    expect(state).toEqual({ sessionId: fx.sessionId })
    expect(state.modelId).toBeUndefined()
    expect(state.thinkingLevel).toBeUndefined()
    // 不回落冷读（否则活会话暂无快照会被误报成文件值）
    expect(seams.locateBtwLineFile).not.toHaveBeenCalled()
    expect(seams.locateBtwLineFileByLayout).not.toHaveBeenCalled()
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
    const table = makeProcessTable_m2({ liveSessionIds: [fx.sessionId] })
    // 设计 §3.3.3 伪码：`pm.getClient(id) && projection.getReplicatedStates(id)`——
    // 后半为 undefined 时整体 falsy，回落冷读分支（locateFile → fromFile）
    const { query } = makeQuery_m2({ getClient: table.getClient, getReplicatedStates: () => undefined })

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
    const table = makeProcessTable_m2({ liveSessionIds: [liveSid] })
    // 活会话 + 无实例快照 + 磁盘无文件：冷读两段与 btw 定位全部 miss
    const { query } = makeQuery_m2({ getClient: table.getClient, getReplicatedStates: () => undefined })

    await expect(query.getState(liveSid)).rejects.toBeInstanceOf(SessionNotFoundError)
    // 冷读失败也不准 restore/spawn 兜底（不得把「查不到」升级成「拉活」）
    expect(table.restoreSession).not.toHaveBeenCalled()
    expect(table.ensureActive).not.toHaveBeenCalled()
    expect(table.ensureProcess).not.toHaveBeenCalled()
    expect(table.createSession).not.toHaveBeenCalled()
    expect(table.withEphemeralPi).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← test/acceptance/item11-host-invariants.test.ts
// ======================================================================

// ── rpc-client 模块 mock（hoisted；FakeRpcClient 复现真实 tee 接线） ──────────
// 工厂内禁直接 import logger（mock 工厂先于模块顶层语句求值，直接 import 形成求值环）——
// 真实 logger 的三个挂点（createPiSessionLog / migratePiSessionLogTree / storeRoot）
// 经 rpcMock.state 间接注入（process-manager-ephemeral.test.ts 同款模式）。
const rpcMock = vi.hoisted(() => {
  const state = {
    /** 每次 spawn 的记录（tee 树点检 + 竞态注入标记 + 族归类）。 */
    spawns: [] as Array<{ key: string; cwd: string; teeTreeExisted: boolean; siblingInjected: boolean; family: 'main-temp' | 'btw-create' | 'btw-attach' | 'ephemeral' }>,
    /** rekey 迁移对（retargetSessionLog 实参）。 */
    retargets: [] as Array<{ from: string; to: string }>,
    /** switchSession 调用（ephemeral mid-flight 点检）。 */
    switchCalls: [] as Array<{ key: string; path: string; teeExistedAtSwitch: boolean }>,
    /** setSessionName 调用（rename 两分支的 RPC 证据）。 */
    setNameCalls: [] as Array<{ key: string; name: string }>,
    /** btw spawn 的 get_state 剧本（测试在每次 btw 操作前压栈）。 */
    btwStateQueue: [] as Array<{ sessionId: string; sessionFile: string }>,
    /** main create 的 get_state 生成器（模拟 pi 首 flush 写会话文件 + 回读真实 id）。 */
    mainGetState: null as null | ((key: string, cwd: string) => { sessionId: string; sessionFile: string }),
    /** ephemeral 附着的 get_state header 读取器。 */
    readHeaderId: null as null | ((file: string) => string | null),
    /** 挂点：真实 logger.createPiSessionLog。 */
    teeCreate: null as null | ((sessionId: string) => { write: (line: string) => void; end: () => void }),
    /** 挂点：真实 logger.migratePiSessionLogTree。 */
    migrate: null as null | ((from: string, to: string) => void),
    /** 存储树根（tee 树点检用）。 */
    storeRoot: '',
  }
  class FakeRpcClient {
    started = false
    killed = false
    exitCb: ((code: number | null, stderr: string) => void) | null = null
    private piSessionLog: { write: (line: string) => void; end: () => void } | null = null
    private currentSessionFile: string | undefined
    /** get_state 幂等缓存（pi 语义：同一附着会话的 get_state 结果稳定）。 */
    private stateOverride: Record<string, unknown> | undefined
    constructor(public options: Record<string, unknown>) {}
    async start(): Promise<void> {
      this.started = true
      const sid = String(this.options.sessionId)
      // 复现真实 RpcClient.start 的 tee 接线（rpc-client.ts:344-355）：spawn 后为
      // 本 session 建 tee 树 + 写 _spawn_boundary 边界行——四族残留树的产生源。
      if (rpcMock.state.teeCreate) {
        this.piSessionLog = rpcMock.state.teeCreate(sid)
        this.piSessionLog.write(
          JSON.stringify({ type: '_spawn_boundary', ts: new Date().toISOString(), runtimePid: process.pid, sessionId: sid }) + '\n',
        )
      }
      // tee 树点检：logs 目录由 sessionLogFileOrNull 同步 mkdir（确定性；jsonl 文件
      // 经 WriteStream 异步开流，不作为点检对象）。
      rpcMock.state.spawns.push({
        key: sid,
        cwd: String(this.options.cwd ?? ''),
        teeTreeExisted: existsSync(join(rpcMock.state.storeRoot, sid, 'logs')),
        siblingInjected: false,
        family: sid.startsWith('btw-create-') ? 'btw-create'
          : sid.startsWith('btw-attach-') ? 'btw-attach'
            : sid.startsWith('ephemeral-') ? 'ephemeral' : 'main-temp',
      })
    }
    onExit(cb: (code: number | null, stderr: string) => void): void { this.exitCb = cb }
    async kill(): Promise<void> { this.killed = true }
    get exited(): boolean { return this.killed }
    async switchSession(path: string): Promise<void> {
      this.currentSessionFile = path
      // 附着目标切换后 get_state 随之改变（真实 pi 语义）——清幂等缓存
      this.stateOverride = undefined
      const sid = String(this.options.sessionId)
      rpcMock.state.switchCalls.push({
        key: sid,
        path,
        teeExistedAtSwitch: existsSync(join(rpcMock.state.storeRoot, sid, 'logs')),
      })
    }
    async setSessionName(name: string): Promise<unknown> {
      rpcMock.state.setNameCalls.push({ key: String(this.options.sessionId), name })
      return { success: true }
    }
    async getState(): Promise<Record<string, unknown>> {
      // 同一客户端实例的 get_state 幂等（pi 语义；ensureProcess 一次附着会调两次：
      // assertPiSessionFile 一次 + 状态核对一次）
      if (this.stateOverride) return this.stateOverride
      const sid = String(this.options.sessionId)
      let state: Record<string, unknown>
      if (sid.startsWith('ephemeral-')) {
        // 短命 pi：附着目标文件（switchSession 已设）；sessionFile 必须与之一致
        // （assertPiSessionFile 逐字比对）。
        const file = this.currentSessionFile
        const id = file ? rpcMock.state.readHeaderId?.(file) ?? null : null
        state = { sessionId: id ?? 'ephemeral-unknown', sessionFile: file }
      } else if (sid.startsWith('btw-create-') || sid.startsWith('btw-attach-')) {
        const scripted = rpcMock.state.btwStateQueue.shift()
        if (!scripted) throw new Error(`fake rpc: no scripted btw state for spawn ${sid}`)
        this.currentSessionFile = scripted.sessionFile
        state = { sessionId: scripted.sessionId, sessionFile: scripted.sessionFile }
      } else {
        // main create：现场生成 pi 真实 id + 写会话文件（模拟 pi 首 flush）
        const gen = rpcMock.state.mainGetState
        if (!gen) throw new Error('fake rpc: mainGetState generator not wired')
        const r = gen(sid, String(this.options.cwd ?? ''))
        this.currentSessionFile = r.sessionFile
        state = { sessionId: r.sessionId, sessionFile: r.sessionFile }
      }
      this.stateOverride = state
      return state
    }
    retargetSessionLog(newSessionId: string): void {
      // 镜像真实 rpc-client.ts:254 retargetSessionLog：end 旧 writer → 真实
      // migratePiSessionLogTree 迁移 → reopen → _retarget_boundary 行。
      const from = String(this.options.sessionId)
      if (!this.piSessionLog || from === newSessionId) return
      this.piSessionLog.end()
      rpcMock.state.retargets.push({ from, to: newSessionId })
      rpcMock.state.migrate?.(from, newSessionId)
      this.options.sessionId = newSessionId
      if (rpcMock.state.teeCreate) {
        this.piSessionLog = rpcMock.state.teeCreate(newSessionId)
        this.piSessionLog.write(
          JSON.stringify({ type: '_retarget_boundary', ts: new Date().toISOString(), from: 'temp-id-tree (migrated)' }) + '\n',
        )
      }
    }
  }
  return { FakeRpcClient, state }
})


vi.mock('../../src/infra/pi/rpc-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infra/pi/rpc-client.js')>()
  return { ...actual, RpcClient: rpcMock.FakeRpcClient }
})


const MS_PER_DAY = 86_400_000

const OLD_DAYS = 30


let dataDir = ''

let cwdDir = ''

let restoreDataDir: (() => void) | undefined


function sessionHeaderLine(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`
}


/** 读 jsonl 首行 header 的 id（供 ephemeral get_state 与 btw 文件点检用）。 */
function readHeaderId(file: string): string | null {
  try {
    const first = readFileSync(file, 'utf-8').split('\n', 1)[0]
    if (!first) return null
    const entry = JSON.parse(first) as { type?: unknown; id?: unknown }
    if (entry?.type !== 'session') return null
    return typeof entry.id === 'string' ? entry.id : null
  } catch {
    return null
  }
}


/** agent/sessions 下全部 jsonl 的 header id 集合（pi 原生会话列表口径）。 */
function collectPiSessionHeaderIds(): string[] {
  const sessionsDir = join(dataDir, 'agent', 'sessions')
  const ids: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return ids
  }
  for (const entry of entries) {
    const p = join(sessionsDir, entry)
    let files: string[] = []
    try {
      if (statSync(p).isDirectory()) files = readdirSync(p).filter(f => f.endsWith('.jsonl'))
      else if (entry.endsWith('.jsonl')) files = [entry]
    } catch {
      continue
    }
    for (const f of files) {
      const id = readHeaderId(join(p, f))
      if (id) ids.push(id)
    }
  }
  return ids
}


/** ext-sessions 一级目录名集合（根不存在 = 空集）。 */
function topLevelNames(): string[] {
  try {
    return readdirSync(getSessionStoreDir()).sort()
  } catch {
    return []
  }
}


/**
 * W3.5 安全条件失败分支的显式保留形态判据（设计项 11 末段）：兄弟域存在且 logs/
 * 已迁空（logs/ 不存在或为空）。该形态不计入新增残留。
 */
function isExplicitRetainForm(name: string): boolean {
  const dir = join(getSessionStoreDir(), name)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  if (entries.filter(e => e !== 'logs').length === 0) return false
  try {
    return readdirSync(join(dir, 'logs')).length === 0
  } catch {
    return true // logs/ 已 rmdir（迁移成功后父目录保留分支的实际形态）
  }
}


/** mtime 主语（与 W5 清扫三条件③ 同口径，不新造第二套规则）：logs/*.jsonl 最新 mtime，无 jsonl 取目录自身。 */
function mtimeSubjectMs(name: string): number | null {
  const dir = join(getSessionStoreDir(), name)
  const logsDir = join(dir, 'logs')
  let latest: number | null = null
  try {
    for (const f of readdirSync(logsDir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const ms = statSync(join(logsDir, f)).mtimeMs
        if (latest === null || ms > latest) latest = ms
      } catch {
        // stat 失败的文件不计入主语
      }
    }
  } catch {
    // 无 logs/ 目录 → 取目录自身 mtime
  }
  if (latest !== null) return latest
  try {
    return statSync(dir).mtimeMs
  } catch {
    return null
  }
}


/** btw spawn 剧本压栈（测试在每次建线/reattach 前调用；线会话文件由本函数落盘 = 模拟 pi 首 flush）。 */
function scriptBtwLine(mainSid: string): { sessionId: string; sessionFile: string } {
  const sessionId = randomUUID()
  const sessionFile = join(getSessionBtwDir(mainSid), `${Date.now()}_${sessionId}.jsonl`)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, sessionHeaderLine(sessionId, cwdDir))
  const entry = { sessionId, sessionFile }
  rpcMock.state.btwStateQueue.push(entry)
  return entry
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('item11-host-invariants', () => {
describe('§7 验收项 11：宿主不变量（四族集合形态）', () => {
  beforeEach(() => {
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '') // hermetic 前提：非打包态（P1 同款机制）
    const prev = process.env.TAIJI_AGENT_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), 'a7-item11-data-'))
    cwdDir = mkdtempSync(join(tmpdir(), 'a7-item11-cwd-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    restoreDataDir = () => {
      if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
      else process.env.TAIJI_AGENT_DATA_DIR = prev
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(cwdDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
    initLogger(dataDir)
    rpcMock.state.storeRoot = getSessionStoreDir()
    rpcMock.state.teeCreate = createPiSessionLog
    rpcMock.state.migrate = migratePiSessionLogTree
    rpcMock.state.readHeaderId = readHeaderId
    // main create 的 get_state：现场生成 pi 真实 id + 写会话文件（模拟 pi 首 flush）
    const mainIds: string[] = []
    let injectSiblingNext = false
    rpcMock.state.mainGetState = (key: string, cwd: string) => {
      const sessionId = randomUUID()
      const groupDir = join(dataDir, 'agent', 'sessions', encodeCwd(cwd))
      mkdirSync(groupDir, { recursive: true })
      const sessionFile = join(groupDir, `${Date.now()}_${sessionId}.jsonl`)
      writeFileSync(sessionFile, sessionHeaderLine(sessionId, cwd))
      // W3.5 迁移窗口竞态注入（探针场景）：rekey 前 tempId 树出现兄弟域 → 迁移走
      // 「保留父目录 + warn」分支（设计项 11 的显式保留形态）。
      if (injectSiblingNext) {
        injectSiblingNext = false
        mkdirSync(join(rpcMock.state.storeRoot, key, 'subagents'), { recursive: true })
        const rec = rpcMock.state.spawns.find(s => s.key === key)
        if (rec) rec.siblingInjected = true
      }
      mainIds.push(sessionId)
      return { sessionId, sessionFile }
    }
    // 注入开关经模块槽暴露给测试体（vi.mock hoist 后本闭包仍持有同一 state 对象）
    ;(rpcMock.state as unknown as { __armSiblingInjection: () => void }).__armSiblingInjection = () => { injectSiblingNext = true }
    ;(rpcMock.state as unknown as { __mainIds: string[] }).__mainIds = mainIds
  })

  afterEach(async () => {
    rpcMock.state.spawns.length = 0
    rpcMock.state.retargets.length = 0
    rpcMock.state.switchCalls.length = 0
    rpcMock.state.setNameCalls.length = 0
    rpcMock.state.btwStateQueue.length = 0
    rpcMock.state.mainGetState = null
    rpcMock.state.readHeaderId = null
    rpcMock.state.teeCreate = null
    rpcMock.state.migrate = null
    rpcMock.state.storeRoot = ''
    await closeLogger().catch(() => {})
    restoreDataDir?.()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('ops → 重启 → 新增 \\ 活跃会话id 为空；四族逐个点名 + 附加两条 + 非虚测点检', async () => {
    // ── 栈装配（真 lifecycle + 真 BtwService + 真 ProcessManager + 真 scanner/store） ──
    let lifecycle: SessionLifecycle
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const configStore = { getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })) } as unknown as IConfigStore
    const store = new PiSessionStore()
    const registerDeps: ISessionRegisterDeps = {
      adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
      getMessageBus: () => null,
      broadcastGlobal: () => {},
    }
    const svc = {
      toSummary: (s: IManagedSessionView): SessionSummary => ({
        id: s.id, label: s.label, cwd: s.cwd, status: 'idle',
        lastActiveAt: s.lastActiveAt, sessionFile: s.sessionFilePath, surface: s.surface,
      }),
      // 与生产同构：force 旁路 TTL 的磁盘扫描查找（session-service.ts:1410 同款）
      findScannedSession: (sessionId: string) => store.scanSessions({ force: true }).find(s => s.id === sessionId),
      getSkillPaths: () => [],
      getExtensionPaths: async () => [],
      getReplaceSystemPrompt: () => undefined,
      getLaunchPresetOptions: async () => undefined,
      fetchAndBroadcastContext: async () => {},
      removeSessionEntry: vi.fn(),
      notifySessionCreated: vi.fn(),
      getActiveSummaries: (): SessionSummary[] => [...lifecycle.values()].map(s => ({
        id: s.id, label: s.label, cwd: s.cwd, status: 'idle',
        lastActiveAt: s.lastActiveAt, sessionFile: s.sessionFilePath, surface: s.surface,
      })),
      // scanner 窄接口去重用：活跃会话占用的 session 文件路径集合
      getActiveFilePaths: (): Set<string> => {
        const paths = new Set<string>()
        for (const s of lifecycle.values()) if (s.sessionFilePath) paths.add(s.sessionFilePath)
        return paths
      },
    }
    const gitInfoReader: IGitInfoReader = { readGitInfo: () => undefined, pruneStaleCache: () => {} }
    const pm = new ProcessManager(tmpdir())

    const wireBtw = (targetLifecycle: SessionLifecycle): BtwService => new BtwService({
      processes: pm,
      buildLineSpawnOptions: async () => ({}),
      // btw 直注册链（组合根 adapter 同款：surface 显传 'btw'）
      registerSession: (id, client, cwd, label, sessionFilePath, surface) =>
        targetLifecycle.registerSession(id, client as IPiEngine, cwd, label, sessionFilePath, undefined, undefined, undefined, undefined, undefined, surface),
      // 源不可用 → 分支② 无 fork 新建（btw-lifecycle.test.ts createNoForkLine 同款）
      resolveMainSessionFile: () => undefined,
      // 端口成功分支同效用 fake（树整树移除；端口废纸篓通道不是本项的被检对象）
      trashDirectory: async (dirPath: string) => { rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) },
      resolvePiCommand: () => 'pi-not-used-in-fake',
      forkSession: vi.fn(async () => { throw new Error('forkSession not used (no-fork branch)') }),
      // M4-a 线终结扇出（index.ts:1441 同款：detach → removeEntry；插件 sessionData 清理不涉磁盘树）
      onLineTerminated: (sessionId: string) => {
        if (!targetLifecycle.has(sessionId)) return
        targetLifecycle.detachSession(sessionId)
        targetLifecycle.removeEntry(sessionId)
      },
    })

    lifecycle = new SessionLifecycle(svc, pm, configStore, store, workspace, registerDeps)
    const btwService = wireBtw(lifecycle)

    // ── 操作前集合（ext-sessions 一级目录名） ──
    const before = topLevelNames()
    expect(before).toEqual([]) // 首启形态：存储树尚未建

    // 预置一个冷会话（从未在本进程注册的持久化会话）供非活跃 rename 附着
    const coldSid = randomUUID()
    const coldGroupDir = join(dataDir, 'agent', 'sessions', encodeCwd(cwdDir))
    mkdirSync(coldGroupDir, { recursive: true })
    const coldFile = join(coldGroupDir, `${Date.now()}_${coldSid}.jsonl`)
    writeFileSync(coldFile, sessionHeaderLine(coldSid, cwdDir))

    // ── 操作序列 ──
    // ① 主会话 create ×2（main1 带 W3.5 迁移窗口竞态注入 → tempId 父目录显式保留；
    //    main2 正常 → tempId 树整树回收，族④覆盖）
    ;(rpcMock.state as unknown as { __armSiblingInjection: () => void }).__armSiblingInjection()
    const main1 = await lifecycle.create(cwdDir, 'main-1')
    const main2 = await lifecycle.create(cwdDir, 'main-2')
    // 显式保留形态 aged 化：区分判据的负载场景（新鲜树本就被 mtime 豁免源覆盖，
    // aged 后只有显式保留规则能排除它——隔离出规则的净贡献）
    const retainTempId = rpcMock.state.spawns.find(s => s.siblingInjected)?.key
    expect(retainTempId).toBeDefined()
    utimesSync(join(getSessionStoreDir(), retainTempId as string), new Date(Date.now() - OLD_DAYS * MS_PER_DAY), new Date(Date.now() - OLD_DAYS * MS_PER_DAY))

    // ② rename ×1（活跃分支：pm.getClient → setSessionName）
    await lifecycle.renameSession(main1.id, 'renamed-main-1')

    // ③ btw 建线 ×2（btw-create-* tempKey → rekey 迁移回收，族①覆盖）
    const line1 = scriptBtwLine(main1.id)
    const line2 = scriptBtwLine(main1.id)
    const created1 = await btwService.createLine({ mainSid: main1.id, cwd: cwdDir })
    const created2 = await btwService.createLine({ mainSid: main1.id, cwd: cwdDir })
    expect(created1.sessionId).toBe(line1.sessionId)
    expect(created2.sessionId).toBe(line2.sessionId)

    // ④ reattach ×1（btw-attach-* tempKey → rekey 迁移回收，族②覆盖）
    btwService.getLine(line1.sessionId)!.client = undefined // 进程引用摘除 → 重附着入口
    // 重附着的 get_state 剧本 = 线自身 id + 线文件（reattach 必须落回原会话）
    rpcMock.state.btwStateQueue.push({ sessionId: line1.sessionId, sessionFile: line1.sessionFile })
    await btwService.ensureProcess(line1.sessionId)

    // ⑤ 关线 ×1（删 1 条：进程销毁 + 线文件删 + 线树软删）
    await btwService.closeLine(line2.sessionId, { deleteSessionFile: true })

    // ⑥ 非活跃 rename ×1（withEphemeralPi → ephemeral-* 非空树 → finally 回收，族③覆盖）
    await lifecycle.renameSession(coldSid, 'renamed-cold')

    // flush 屏障：closeLogger 等全部 pi tee 写流落定后重新初始化——迁移后的 tee
    // 文件存在性断言因此是确定性的（非异步竞态）。
    await closeLogger()
    initLogger(dataDir)

    // ── 重启 = 新 lifecycle + 新 scanner + force 扫 + btw rebuild ──
    const lifecycle2 = new SessionLifecycle(svc, pm, configStore, store, workspace, registerDeps)
    lifecycle = lifecycle2 // svc.getActiveSummaries 改读重启后实例（内存集为空 = 设计 contemplated 形态）
    const scanner = new SessionScanner(svc, store, gitInfoReader)
    const btwService2 = wireBtw(lifecycle2)
    const rebuilt = btwService2.rebuildFromDisk()
    const scanned = store.scanSessions({ force: true })

    // ── 复检集合 ──
    const after = topLevelNames()
    const newDirs = after.filter(n => !before.includes(n))

    // 活跃会话 id 三源并集（设计项 11 权威源与取值时点）
    const scanIds = new Set(scanned.map(s => s.id))
    const memIds = new Set(lifecycle2.keys())
    const keepMs = readLogKeepDays() * MS_PER_DAY
    const freshMtimeIds = new Set(after.filter(n => {
      const ms = mtimeSubjectMs(n)
      return ms !== null && Date.now() - ms < keepMs
    }))
    const activeIds = new Set([...scanIds, ...memIds, ...freshMtimeIds])

    // 核心断言：新增 \ 活跃会话 id 为空（显式保留形态按设计排除）
    const residual = newDirs.filter(n => !activeIds.has(n) && !isExplicitRetainForm(n))
    expect(residual).toEqual([])

    // 四族逐个点名（E-21）
    expect(after.filter(n => n.startsWith('btw-create-'))).toEqual([]) // 族①
    expect(after.filter(n => n.startsWith('btw-attach-'))).toEqual([]) // 族②
    expect(after.filter(n => n.startsWith('ephemeral-'))).toEqual([]) // 族③
    const emptyDirs = after.filter(n => {
      try { return readdirSync(join(getSessionStoreDir(), n)).length === 0 } catch { return false }
    })
    expect(emptyDirs).toEqual([]) // 族④：v4-UUID 空目录（主会话 tempId 残留）；空目录也是残留

    // 显式保留形态：确曾在新增集、确不被三源覆盖、确由区分判据排除（规则净贡献隔离）
    expect(newDirs).toContain(retainTempId as string)
    expect(activeIds.has(retainTempId as string)).toBe(false)
    expect(isExplicitRetainForm(retainTempId as string)).toBe(true)

    // 附加两条：piAgentDir/sessions 无 btw 文件；pi 原生会话列表无异常条目
    const lineIds = new Set([line1.sessionId, line2.sessionId])
    const piHeaderIds = collectPiSessionHeaderIds()
    expect(piHeaderIds.filter(id => lineIds.has(id))).toEqual([])
    expect(new Set(scanned.map(s => s.id))).toEqual(new Set([main1.id, main2.id, coldSid]))
    for (const s of scanned) {
      expect(s.id).toBeTruthy()
      expect(s.filePath).toBeTruthy()
      expect(/^(btw-create-|btw-attach-|ephemeral-)/.test(s.id)).toBe(false)
    }

    // 非虚测点检 1：全部 spawn 的 tee 树确曾存在（四族产生源都真实跑过）
    expect(rpcMock.state.spawns.length).toBe(6) // main ×2 + btw-create ×2 + btw-attach ×1 + ephemeral ×1
    expect(rpcMock.state.spawns.every(s => s.teeTreeExisted)).toBe(true)
    expect(rpcMock.state.spawns.filter(s => s.family === 'main-temp').length).toBe(2)
    expect(rpcMock.state.spawns.filter(s => s.family === 'btw-create').length).toBe(2)
    expect(rpcMock.state.spawns.filter(s => s.family === 'btw-attach').length).toBe(1)
    expect(rpcMock.state.spawns.filter(s => s.family === 'ephemeral').length).toBe(1)

    // 非虚测点检 2：每个临时键树都已回收（竞态注入的那个按设计保留 + 保留形态判据成立）
    for (const sp of rpcMock.state.spawns) {
      const exists = existsSync(join(getSessionStoreDir(), sp.key))
      if (sp.siblingInjected) {
        expect(exists).toBe(true)
        expect(isExplicitRetainForm(sp.key)).toBe(true)
      } else {
        expect(exists).toBe(false)
      }
    }

    // 非虚测点检 3：rekey 迁移对（from 树消失 + to 树带 logs 存在）；保留分支的迁移对
    // 与已关线（to 树随 closeLine 整树软删，属合法消失）除外
    const injectedKeys = new Set(rpcMock.state.spawns.filter(s => s.siblingInjected).map(s => s.key))
    const deletedLineIds = new Set([line2.sessionId])
    expect(rpcMock.state.retargets.length).toBe(5) // main1 + main2 + line1 create + line2 create + line1 attach
    for (const r of rpcMock.state.retargets) {
      if (injectedKeys.has(r.from)) continue
      expect(existsSync(join(getSessionStoreDir(), r.from))).toBe(false)
      if (deletedLineIds.has(r.to)) continue // 关线的 to 树已随 closeLine 消失（下方专项断言）
      expect(existsSync(join(getSessionStoreDir(), r.to, 'logs'))).toBe(true)
    }

    // 非虚测点检 4：ephemeral 树在 switchSession 时刻（fn 之前）仍存在——族③残留形态非虚测
    const ephemeralSwitch = rpcMock.state.switchCalls.find(c => c.key.startsWith('ephemeral-'))
    expect(ephemeralSwitch).toBeDefined()
    expect(ephemeralSwitch?.teeExistedAtSwitch).toBe(true)
    expect(ephemeralSwitch?.path).toBe(coldFile)

    // 非虚测点检 5：活跃会话树（main ×2 + line1）逐个仍在；被删 line2 的树已随关线消失
    for (const id of [main1.id, main2.id, line1.sessionId]) {
      expect(existsSync(join(getSessionStoreDir(), id, 'logs'))).toBe(true)
    }
    expect(existsSync(join(getSessionStoreDir(), line2.sessionId))).toBe(false)
    expect(existsSync(line2.sessionFile)).toBe(false) // 关线删了线会话文件

    // rename 两分支的 RPC 证据（活跃分支走 pm client；非活跃分支走 ephemeral client）
    expect(rpcMock.state.setNameCalls).toEqual(expect.arrayContaining([
      { key: main1.id, name: 'renamed-main-1' },
      { key: expect.stringMatching(/^ephemeral-/) as unknown as string, name: 'renamed-cold' },
    ]))

    // 重启后 btw 重建：line1 一条（line2 文件已删），surface 三写路径之 rebuildFromDisk 生效
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].piSessionId).toBe(line1.sessionId)
    expect(rebuilt[0].surface).toBe('btw')
    expect(rebuilt[0].mainSid).toBe(main1.id)

    // 重启后 scanner 列表口径：活跃（内存空）+ 持久化（磁盘）合并后侧栏集合 = 三个主/冷会话
    const groups = scanner.listPersistedSessions()
    const sidebarIds = groups.flatMap(g => g.sessions.map(s => s.id)).sort()
    expect(sidebarIds).toEqual([coldSid, main1.id, main2.id].sort())
  })

  it('首 flush 窗口豁免：未注册、无 jsonl 的新空目录不算新增残留（mtime 保留期源兜底）', () => {
    // 设计项 11：「首 flush 窗口内的空目录按 mtime 保留期豁免」——兜住「刚 create 未首
    // flush 的主会话（无 jsonl）被当残留」的误判方向。本用例隔离该兜底方向。
    const before = topLevelNames()
    const freshSid = randomUUID()
    mkdirSync(join(getSessionStoreDir(), freshSid), { recursive: true }) // 空目录、mtime 新、未注册、无 jsonl
    const after = topLevelNames()
    const newDirs = after.filter(n => !before.includes(n))
    expect(newDirs).toEqual([freshSid])

    const keepMs = readLogKeepDays() * MS_PER_DAY
    const freshMtimeIds = new Set(after.filter(n => {
      const ms = mtimeSubjectMs(n)
      return ms !== null && Date.now() - ms < keepMs
    }))
    // 三源并集里它只可能被 mtime 保留期源覆盖（scan 无其文件、lifecycle 内存无其条目）
    expect(freshMtimeIds.has(freshSid)).toBe(true)
    const residual = newDirs.filter(n => !freshMtimeIds.has(n) && !isExplicitRetainForm(n))
    expect(residual).toEqual([])
  })
})
});

// ======================================================================
// ← test/acceptance/item12-session-list.test.ts
// ======================================================================

// ── fixture（真实 piId 形态：UUID v4；W4a 键统一后线 id = pi 真实会话 id）──────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i


/** btw 线注册表记录（BtwLineRecord 的验收视图：只列本测试消费字段） */
function lineRecord(piSessionId: string, mainSid: string, createdAt: number, cwd = '/repo/a'): BtwLineRecord {
  return {
    piSessionId,
    mainSid,
    cwd,
    label: 'basename-cwd',
    threadDir: `/root/${mainSid}/btw`,
    sessionFilePath: `/root/${mainSid}/btw/${piSessionId}.jsonl`,
    snapshotKind: 'forked',
    surface: 'btw',
    createdAt,
    pendingInteraction: false,
    contractRounds: 1,
  }
}


/** 侧栏分组（scanner.listPersistedSessions 产物形态：cwd 分组 + 组内 lastActiveAt 降序） */
function sidebarSummary(id: string, cwd: string, lastActiveAt: number): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt, surface: 'sidebar' }
}


/** SessionGroup[] → 扁平 id 清单（保序） */
function ids(groups: SessionGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}


// ── ④ 两口径偏差机器比对（告警形态）───────────────────────────────────────────

/**
 * 两口径偏差机器比对（§3.3.1「不切」分支的退役条件执行形态）：
 * 侧栏广播口径（config.sessions 过滤后 = scanner.listPersistedSessions 分组）与
 * session.list {surface:'sidebar'} 查询口径逐条比对。返回偏差描述清单；空 = 两口径一致。
 *
 * 比对三层（任一层的偏差都报——组序 / 组内序 / 条目对象逐字段）：
 * 1. 扁平 id 序列（保序）不同；
 * 2. 分组 cwd 序列不同；
 * 3. 扁平条目对象深等不同（逐字段，含 label/status/lastActiveAt/surface）。
 */
function twoCaliberDeviation(broadcastGroups: SessionGroup[], listGroups: SessionGroup[]): string[] {
  const deviations: string[] = []
  const broadcastIds = ids(broadcastGroups)
  const listIds = ids(listGroups)
  if (broadcastIds.length !== listIds.length || broadcastIds.some((id, i) => id !== listIds[i])) {
    deviations.push(`id-sequence differs: broadcast=[${broadcastIds.join(',')}] list=[${listIds.join(',')}]`)
  }
  const broadcastCwds = broadcastGroups.map((g) => g.cwd)
  const listCwds = listGroups.map((g) => g.cwd)
  if (broadcastCwds.length !== listCwds.length || broadcastCwds.some((c, i) => c !== listCwds[i])) {
    deviations.push(`cwd-sequence differs: broadcast=[${broadcastCwds.join(',')}] list=[${listCwds.join(',')}]`)
  }
  const broadcastFlat = broadcastGroups.flatMap((g) => g.sessions)
  const listFlat = listGroups.flatMap((g) => g.sessions)
  if (JSON.stringify(broadcastFlat) !== JSON.stringify(listFlat)) {
    deviations.push('entry objects differ (deep)')
  }
  return deviations
}


// ── ③ transport 接线 mock（对齐 session-message-handler-get-state.test.ts 形态）────

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


function mockContext(sessionService: unknown): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService: sessionService as ISessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('item12-session-list', () => {
// ── 测试体 ─────────────────────────────────────────────────────────────

describe('§7 验收项 12①：session.list {surface:"btw", mainSessionId}（含负例，id 为 piId）', () => {
  const mainA = randomUUID()
  const mainB = randomUUID()
  const lineA1 = randomUUID()
  const lineA2 = randomUUID()
  const lineB1 = randomUUID()
  const lines = [
    lineRecord(lineA1, mainA, 10),
    lineRecord(lineA2, mainA, 20),
    lineRecord(lineB1, mainB, 15),
  ]

  function makeService(): SessionListQueryService {
    return new SessionListQueryService({
      listSidebarGroups: () => [],
      listBtwLines: () => lines,
      isLineGenerating: () => false,
    })
  }

  it('只返回 X 名下的 2 条线，id 为 pi 真实会话 id（UUID 形态、无 btw: 前缀）', () => {
    const groups = makeService().list({ surface: 'btw', mainSessionId: mainA })
    expect(ids(groups)).toEqual([lineA1, lineA2])
    const entries = groups.flatMap((g) => g.sessions)
    // id 形态 = piId（防「键切换回退成虚拟 id」的回归）
    for (const s of entries) {
      expect(s.id).toMatch(UUID_RE)
      expect(s.id.startsWith('btw:')).toBe(false)
      expect(s.surface).toBe('btw')
    }
    expect(entries.map((s) => s.label)).toEqual(['btw-1', 'btw-2'])
  })

  it('负例：传 B 主会话 id 不得返回 A 名下的线（过滤参数写反仍全绿的兜底）', () => {
    const groups = makeService().list({ surface: 'btw', mainSessionId: mainB })
    expect(ids(groups)).toEqual([lineB1])
    expect(ids(groups)).not.toContain(lineA1)
    expect(ids(groups)).not.toContain(lineA2)
  })

  it('负例：未知 mainSessionId → 空结果（不回落全量）', () => {
    expect(makeService().list({ surface: 'btw', mainSessionId: randomUUID() })).toEqual([])
  })

  it('拉取供数机制存在（⑤ L3 机制面）：{surface:"btw"} 的 id 集合 = 注册表线全集（create/remove 同拍收敛）', () => {
    const registry = [lineRecord(lineA1, mainA, 10), lineRecord(lineA2, mainA, 20), lineRecord(lineB1, mainB, 15)]
    const svc = new SessionListQueryService({
      listSidebarGroups: () => [],
      listBtwLines: () => registry,
      isLineGenerating: () => false,
    })
    // 渲染侧抑制类判别（btw-line-membership）唯一读本查询的拉取缓存——其数据 = 注册表事实
    const pulled = new Set(ids(svc.list({ surface: 'btw' })))
    expect(pulled).toEqual(new Set(registry.map((l) => l.piSessionId)))
    // 关线出册同拍收敛（注册表移除 → 查询不再返回）
    registry.splice(registry.findIndex((l) => l.piSessionId === lineB1), 1)
    expect(new Set(ids(svc.list({ surface: 'btw' })))).toEqual(new Set([lineA1, lineA2]))
  })
})
describe('§7 验收项 12②：{surface:"sidebar"} 与侧栏口径（config.sessions 广播同源）逐条一致', () => {
  const SIDEBAR_GROUPS: SessionGroup[] = [
    { cwd: '/repo/a', sessions: [sidebarSummary(randomUUID(), '/repo/a', 300), sidebarSummary(randomUUID(), '/repo/a', 100)] },
    { cwd: '/repo/b', sessions: [sidebarSummary(randomUUID(), '/repo/b', 200)] },
  ]

  /**
   * 侧栏口径来源（建模 scanner.listPersistedSessions——config.sessions 广播与 session.list
   * 查询两侧的同一 owner；message-broker.ts:261 buildSessionListMsg 广播的 groups 即本来源
   * 的直出产物，未经 surface 过滤与分组重组）。
   */
  const sidebarCaliberSource = (): SessionGroup[] => SIDEBAR_GROUPS.map((g) => ({ cwd: g.cwd, sessions: [...g.sessions] }))

  function makeService(): SessionListQueryService {
    return new SessionListQueryService({
      // 侧栏口径 = scanner.listPersistedSessions（与 config.sessions 广播同源同 owner）
      listSidebarGroups: sidebarCaliberSource,
      listBtwLines: () => [lineRecord(randomUUID(), randomUUID(), 10)],
      isLineGenerating: () => false,
    })
  }

  it('组序/组内序/条目对象与侧栏分组原样一致（同一 owner 派生不允许两个口径）', () => {
    const viaList = makeService().list({ surface: 'sidebar' })
    const viaSidebar = makeService().list({ surface: 'sidebar' })
    expect(viaList).toEqual(SIDEBAR_GROUPS) // 深等（组序 + 组内序 + 条目对象逐字段）
    expect(viaList).toEqual(viaSidebar)
    // 侧栏口径不含任何 btw 线条目（即使注册表有线）
    expect(viaList.flatMap((g) => g.sessions).some((s) => s.surface === 'btw')).toBe(false)
    expect(ids(viaList).some((id) => id.startsWith('btw:'))).toBe(false)
  })

  it('机器比对（④ 告警形态）：真实服务两口径偏差为空', () => {
    const svc = makeService()
    // 广播口径 = owner 直出（message-broker.ts:261 buildSessionListMsg 的 groups 同源：
    // sessionService.listPersistedSessions 产物）——不是查询口径的自调用
    const broadcast = sidebarCaliberSource()
    // 查询口径 = session.list {surface:'sidebar'} 经 SessionListQueryService 的派生结果
    const list = svc.list({ surface: 'sidebar' })
    expect(twoCaliberDeviation(broadcast, list)).toEqual([])
  })

  it('机器比对有区分度（防门失明）：注入偏差可检测（组序颠倒 / 条目缺失 / 字段漂移）', () => {
    const groups = makeService().list({ surface: 'sidebar' })
    // ① 组序颠倒（查询侧分组顺序漂移）
    expect(twoCaliberDeviation(groups, [...groups].reverse())).not.toEqual([])
    // ② 条目缺失（广播口径整批消失——验收项 10 同族：单向负面断言对空集合 vacuously 通过）
    const [g0] = groups
    expect(twoCaliberDeviation(groups, [{ cwd: g0.cwd, sessions: g0.sessions.slice(1) }])).not.toEqual([])
    // ③ 字段漂移（同 id 同序但 lastActiveAt 不同——「逐条一致」必须逐字段）
    const mutated: SessionGroup[] = groups.map((g) => ({
      cwd: g.cwd,
      sessions: g.sessions.map((s, i) => (i === 0 ? { ...s, lastActiveAt: s.lastActiveAt + 1 } : s)),
    }))
    expect(twoCaliberDeviation(groups, mutated)).not.toEqual([])
  })
})
describe('§7 验收项 12③：§10.2 两态断言（结论 = 不切）——查询入口存活即退役条件未执行', () => {
  const groups: SessionGroup[] = [{ cwd: '/repo/a', sessions: [sidebarSummary(randomUUID(), '/repo/a', 1)] }]
  const listSessions = vi.fn((_query: { surface?: SessionSurface; mainSessionId?: string }) => groups)

  it('transport 接线：session.list 经 handler reply {groups}（查询入口在场，未被 W5 退役）', async () => {
    const ctx = mockContext({ listSessions })
    const handler = new SessionMessageHandler(ctx)
    expect(handler.handles).toContain('session.list')

    await handler.handleSessionMessage(msg('session.list', { surface: 'sidebar' }), mockWs())

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith({ surface: 'sidebar' })
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.list', { groups })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('过滤参数原样透传（surface + mainSessionId；缺省字段不作为 undefined 键传入）', async () => {
    const ctx = mockContext({ listSessions })
    const handler = new SessionMessageHandler(ctx)
    const mainSid = randomUUID()

    await handler.handleSessionMessage(msg('session.list', { surface: 'btw', mainSessionId: mainSid }), mockWs())
    expect(listSessions).toHaveBeenLastCalledWith({ surface: 'btw', mainSessionId: mainSid })

    await handler.handleSessionMessage(msg('session.list', {}), mockWs())
    expect(listSessions).toHaveBeenLastCalledWith({})
  })

  it('防御分支：listSessions 未组装（测试最小 mock 形态）→ session_list_unsupported 显式报错', async () => {
    const ctx = mockContext({}) // 无 listSessions 成员
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.list', { surface: 'btw' }), mockWs())

    expect(ctx.sendError).toHaveBeenCalledWith(expect.anything(), 'session_list_unsupported', 'session list query not available', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← test/acceptance/item13-w5-behavior.test.ts
// ======================================================================

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('item13-w5-behavior', () => {
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
});
