/**
 * SessionStateQuery 行为测试（会话架构四层分离 W2，设计 §3.3.2 / §3.3.3）。
 *
 * 覆盖设计 §7 验收项 1 / 6 + impl-plan §2 u-w2-getstate 的其余条目：
 * - **项 1（fork 混合分支文件冷读）**：§10.1 六步序列的**离线等价物**——临时 btw 线
 *   JSONL fixture（被撤 B 分支 + A 侧活跃路径的混合形态），不启动真 pi。断言打开线显示
 *   A、重启后仍 A、主会话再切 D 后线仍 A。
 * - **项 6（零 spawn）**：冷读不产生 pi 子进程（进程表断言）；反向 = 活会话快照未就绪时
 *   无 restore/spawn、应答字段缺省返回。
 * - 三个 spawn 风险点的实现约定（禁 ensureActive / live 分支不触发 restore /
 *   filePath 只准来自扫描两段或 BtwLineRecord.sessionFilePath）。
 * - 冷路径埋点（单次耗时 + 扫描目录数）。
 *
 * 数据隔离（项目测试红线）：全部 fixture 落 `mkdtempSync(join(tmpdir(), ...))` 自建自删；
 * `TAIJI_AGENT_DATA_DIR` 指向该 tmp（global-setup 已固定为 tmp，本文件按既有测试惯例
 * 显式覆盖并还原），不触真实数据目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { ModelIdSnapshot, ThinkingLevelSnapshot } from '../replicated-states.config.js'
import type { ReplicatedState } from '../replicated-state.js'
import {
  SessionStateQuery,
  SessionNotFoundError,
  type SessionStateColdReadTrace,
  type SessionStateLiveStates,
} from '../session-state-query.js'
import {
  findCachedSessionFileById,
  findScannedSessionFileById,
  findBtwLineFileByPiSessionId,
} from '../../../infra/pi/session-file-locator.js'
import {
  scanPiSessions,
  invalidateScanDirCache,
  _resetSessionMetaCacheForTest,
  sessionScanDirCount,
} from '../../../infra/pi/session-file-utils.js'

// ── fixture 构造（pi session JSONL 的最小真实形态）──────────────────────────

/** session header 行（pi 落盘首行；trimFileEntriesToActivePath 会剥掉它） */
function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}

type EntryOpts = {
  id: string
  parentId?: string
}

function entryLine(type: string, opts: EntryOpts, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id: opts.id, ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}), ...extra })
}

/** 用户消息 entry（revoke 的定位目标形态：type='message' 且 role='user'） */
function userMessageLine(opts: EntryOpts, text = 'hello'): string {
  return entryLine('message', opts, { message: { role: 'user', content: text }, timestamp: '2026-10-24T00:00:01.000Z' })
}

/** assistant 消息 entry（冷读的模型来源之一：message.provider + message.model） */
function assistantMessageLine(opts: EntryOpts, provider: string, model: string): string {
  return entryLine('message', opts, {
    message: { role: 'assistant', provider, model, content: 'ok' },
    timestamp: '2026-10-24T00:00:02.000Z',
  })
}

/** model_change entry（pi 唯一显式 setModel 写点；provider/modelId 平铺在 entry 顶级） */
function modelChangeLine(opts: EntryOpts, provider: string, modelId: string): string {
  return entryLine('model_change', opts, { provider, modelId, timestamp: '2026-10-24T00:00:03.000Z' })
}

/** thinking_level_change entry（冷读的档位来源） */
function thinkingLevelLine(opts: EntryOpts, thinkingLevel: string): string {
  return entryLine('thinking_level_change', opts, { thinkingLevel, timestamp: '2026-10-24T00:00:04.000Z' })
}

/** label entry（撤回后 appendLabelChange 的产物：parentId = 当前 leafId） */
function labelLine(opts: EntryOpts, targetId: string, label: string): string {
  return entryLine('label', opts, { targetId, label, timestamp: '2026-10-24T00:00:05.000Z' })
}

/** 写 JSONL 文件（父目录自建） */
function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

// ── §10.1 六步序列的离线等价物 ────────────────────────────────────────────

/**
 * 主会话 + btw 线的一对 fixture（§10.1 步骤 1-5 的离线等价构造）。
 *
 * 主会话文件（`<dataDir>/agent/sessions/<cwdGroup>/<mainSid>.jsonl`）：
 *   s1    session_info（根）
 *   mcA   model_change A          ← 步骤 1 前「主会话在模型 A」
 *   tlA   thinking_level_change high（A 侧 trunk）
 *   u1    user message
 *   a1    assistant（provider/model = A）
 *   mcB   model_change B          ← 步骤 2「切到 B」
 *   L     label taiji:revoked     ← 步骤 3 撤回 u1：leaf = u1.parentId = tlA，label 挂成新叶
 *   mcD   model_change D          ← 步骤 5「主会话再切 D」（只在主文件，不进线文件）
 *
 * 线文件（`<dataDir>/ext-sessions/<mainSid>/btw/<linePiId>.jsonl`）= 步骤 4 fork 的
 * **逐字节复制源文件全部非 header entry**（保留 id/parentId，只换 header），故线文件 =
 * 上面 s1..L 七条（不含 mcD）。
 *
 * 关键形态（设计 §10.1「为何这步是门的判定器」）：线文件的物理尾是 L，而 L 的 parentId
 * 是 tlA——**活跃路径 = [s1, mcA, tlA, L] 命中 A/high，被撤 B 分支（mcB，parentId=a1）在
 * 物理尾方向但不在活跃路径上**。物理尾逆读会命中 mcB 得 B（错值），活跃路径逆读命中
 * mcA 得 A（对值）——两种读法在此 fixture 上结果不同，门因此有判别力。
 *
 * 为何 A 与 thinking 都要落在 trunk 上（而不是只靠 assistant entry 携带）：撤回的 pi 实装
 * 语义是 `newLeafId = targetEntry.parentId`（agent-session.js:3265-3268）+ label 挂到该
 * leaf（session-manager.js:1034-1046）——**user 消息被撤后，作为它子节点的 assistant 条目
 * 一并离开活跃路径**。若 A/high 只由 assistant / 其子树条目携带，活跃路径上再无任何模型
 * 或档位记录，冷读只能返回显式未知，「打开线显示 A」在该序列下不可满足。trunk 上的
 * `model_change A` + `thinking_level_change high` 是「主会话在模型 A、档位 high」的
 * 文件级记录，也是该断言成立的唯一支撑点。
 */
function seedForkFixture(dataDir: string): { mainSid: string; linePiId: string; mainFile: string; lineFile: string } {
  const mainSid = '11111111-1111-4111-8111-111111111111'
  const linePiId = '22222222-2222-4222-8222-222222222222'
  // W4a 键统一：线 id = pi 真实会话 id（旧 `btw:<piId>` 两段式已退役）
  const cwdGroup = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' // encodeCwd('/tmp/proj')
  const mainFile = join(dataDir, 'agent', 'sessions', cwdGroup, `${mainSid}.jsonl`)
  const lineFile = join(dataDir, 'ext-sessions', mainSid, 'btw', `${linePiId}.jsonl`)

  const trunk = [
    headerLine(mainSid, '/tmp/proj'),
    entryLine('session_info', { id: 's1' }),
    modelChangeLine({ id: 'mcA', parentId: 's1' }, 'prov-a', 'model-a'),
    thinkingLevelLine({ id: 'tlA', parentId: 'mcA' }, 'high'),
    userMessageLine({ id: 'u1', parentId: 'tlA' }),
    assistantMessageLine({ id: 'a1', parentId: 'u1' }, 'prov-a', 'model-a'),
    modelChangeLine({ id: 'mcB', parentId: 'a1' }, 'prov-b', 'model-b'),
    labelLine({ id: 'L', parentId: 'tlA' }, 'u1', 'taiji:revoked'),
  ]
  writeJsonl(mainFile, [...trunk, modelChangeLine({ id: 'mcD', parentId: 'L' }, 'prov-d', 'model-d')])
  // fork：复制全部非 header entry，只换 header
  writeJsonl(lineFile, [headerLine(linePiId, '/tmp/proj'), ...trunk.slice(1)])

  return { mainSid, linePiId, mainFile, lineFile }
}

// ── deps fake（进程表 / 实例快照）────────────────────────────────────────

/** 进程表 fake：任何 spawn 形态调用都炸（零 spawn 断言的载体） */
function makeProcessTable(liveSessionIds: readonly string[] = []): IProcessManager & { spawnCalls: string[]; getClient: ReturnType<typeof vi.fn> } {
  const spawnCalls: string[] = []
  const live = new Set(liveSessionIds)
  const boom = (name: string) => (): never => {
    spawnCalls.push(name)
    throw new Error(`spawn risk point violated: ${name} must not be called by getState`)
  }
  return {
    spawnCalls,
    getClient: vi.fn((sessionId: string) => (live.has(sessionId) ? ({ id: sessionId } as unknown as IPiEngine) : undefined)),
    hasClient: (sessionId: string) => live.has(sessionId),
    createSession: boom('createSession'),
    restoreSession: boom('restoreSession'),
    ensureProcess: boom('ensureProcess'),
    withEphemeralPi: boom('withEphemeralPi'),
    rekey: boom('rekey'),
    destroySession: boom('destroySession'),
  } as unknown as IProcessManager & { spawnCalls: string[]; getClient: ReturnType<typeof vi.fn> }
}

/** 标量实例 fake（ReplicatedState 的只读窄面） */
function scalarStub<T>(value: T | undefined): ReplicatedState<T> {
  return { get: () => value } as unknown as ReplicatedState<T>
}

function liveStatesStub(modelId: string | undefined, thinkingLevel: string | undefined): SessionStateLiveStates {
  return {
    modelId: scalarStub<ModelIdSnapshot>(modelId === undefined ? undefined : { modelId }),
    thinkingLevel: scalarStub<ThinkingLevelSnapshot>(thinkingLevel === undefined ? undefined : { thinkingLevel }),
  }
}

/** 查询服务 deps 组装（默认 = 冷路径：无 client、无实例快照） */
function makeQuery(opts: {
  pm?: IProcessManager
  live?: SessionStateLiveStates | undefined
  now?: () => number
} = {}) {
  const traces: SessionStateColdReadTrace[] = []
  const query = new SessionStateQuery({
    getClient: (sid) => opts.pm?.getClient(sid),
    getReplicatedStates: () => opts.live,
    locateMainSessionFileFromCache: (sid) => findCachedSessionFileById(sid),
    locateMainSessionFileFromDisk: (sid) => findScannedSessionFileById(sid),
    locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId) ?? findBtwLineFileByPiSessionId(sessionId),
    onColdRead: (t) => traces.push(t),
    now: opts.now,
  })
  return { query, traces }
}

/**
 * btw 线文件定位（模拟生产投影注入的两级：注册表记录的 sessionFilePath 优先，
 * 未命中走存储树布局定位）。测试经本 Map 模拟「线已注册」的一路。
 */
const btwRegistry = new Map<string, string>()

// ── 测试体 ─────────────────────────────────────────────────────────────

describe('SessionStateQuery.getState', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w2-getstate-'))
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

  // ── §7 验收项 1：fork 混合分支文件冷读 ──

  it('项1-a 打开冷线显示创建时模型 A（活跃路径逆读，非物理尾 B）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const pm = makeProcessTable()
    const { query } = makeQuery({ pm })

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 判别力自证：物理尾逆序第一条模型记录是 mcB（被撤分支）——本用例读到的不是它
    expect(state.modelId).not.toBe('prov-b/model-b')
    // 零 spawn（进程表断言）
    expect(pm.spawnCalls).toEqual([])
  })

  it('项1-b 重启后（注册表无记录 + 缓存清空 + 全新查询实例）再开线仍显示 A', async () => {
    const fx = seedForkFixture(dataDir)
    // 不填 btwRegistry = 重启后的线：BtwService.rebuildFromDisk() 只重建自己的 registry，
    // 不注册进 lifecycle.sessions，故注册表记录一路结构性缺席，走存储树布局定位。
    const first = makeQuery({ pm: makeProcessTable() })
    expect((await first.query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 「重启」的离线等价物：metaCache 清空（缓存不跨进程持久）+ 目录 TTL 缓存清空 +
    // 全新 SessionStateQuery 实例（无任何内存态继承）
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    const afterRestart = makeQuery({ pm: makeProcessTable() })
    const state = await afterRestart.query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
  })

  it('项1-c 主会话再切 D 后线仍显示 A（线读自己的文件，不是主会话当前值）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery({ pm: makeProcessTable() })
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 主会话之后又换过模型（追加到主文件）——线文件的活跃路径不变
    appendFileSync(fx.mainFile, `${modelChangeLine({ id: 'mcE', parentId: 'mcD' }, 'prov-e', 'model-e')}\n`)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    // 主会话自身冷读反映最新值（对照：证明 fixture 真的在动）
    const mainState = await query.getState(fx.mainSid)
    expect(mainState.modelId).toBe('prov-e/model-e')
    // 线不受影响
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
  })

  it('项1-d 门有判别力：fixture 的物理尾方向带 B 记录、末条是挂在 A 侧的 label', async () => {
    const fx = seedForkFixture(dataDir)
    const tail = readFileSync(fx.lineFile, 'utf8')
    // 被撤分支的 model_change B 在文件里（物理尾逆读会命中它 = 错值）
    expect(tail).toContain('model-b')
    // 末条 entry 是 label（父 = tlA，A 侧 trunk）——混合分支形态的结构证据
    const lastLine = tail.trimEnd().split('\n').at(-1) as string
    expect(JSON.parse(lastLine)).toMatchObject({ type: 'label', parentId: 'tlA' })
  })

  // ── §7 验收项 6：零 spawn ──

  it('项6-a 冷读不产生 pi 子进程（进程表断言：spawn 形态调用零次）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const pm = makeProcessTable()

    const { query } = makeQuery({ pm })
    const state = await query.getState(fx.linePiId)

    expect(state.modelId).toBe('prov-a/model-a')
    // 进程表：createSession / restoreSession / ensureProcess / withEphemeralPi / rekey 全部零调用
    expect(pm.spawnCalls).toEqual([])
    // 活跃判定走的是 getClient（风险点 1 的唯一合法入口），不是 ensureActive
    expect(pm.getClient).toHaveBeenCalledWith(fx.linePiId)
  })

  it('项6-b 活会话快照未就绪：无 restore/spawn + 应答字段缺省返回', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    // 活会话（有 client）但两实例快照都未就绪（.get() = undefined）
    const { query } = makeQuery({ pm, live: liveStatesStub(undefined, undefined) })

    const state = await query.getState(liveSid)

    // 字段缺省 = 未就绪（显式未知），不编码为 0/空串、不回退猜测
    expect(state).toEqual({ sessionId: liveSid })
    expect(state.modelId).toBeUndefined()
    expect(state.thinkingLevel).toBeUndefined()
    // 未就绪不得触发 restore（进程表断言）
    expect(pm.spawnCalls).toEqual([])
    // 未就绪不得回落到冷读（否则会把「活会话暂无快照」误报成文件值）
    expect(pm.getClient).toHaveBeenCalledWith(liveSid)
  })

  it('项6-c 活会话快照就绪：读实例快照，与 state_changed 同一数据源', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-live/model-live', 'medium') })

    const state = await query.getState(liveSid)

    expect(state).toEqual({ sessionId: liveSid, modelId: 'prov-live/model-live', thinkingLevel: 'medium' })
    expect(pm.spawnCalls).toEqual([])
  })

  it('项6-d 活会话只就绪一个维度：另一维缺省（字段级，不打包兜底）', async () => {
    const liveSid = '33333333-3333-4333-8333-333333333333'
    const pm = makeProcessTable([liveSid])
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-live/model-live', undefined) })
    const state = await query.getState(liveSid)
    expect(state).toEqual({ sessionId: liveSid, modelId: 'prov-live/model-live' })
  })

  it('项6-e 已注册但进程已退出（getClient undefined）：回落冷读文件，不 restore', async () => {
    const fx = seedForkFixture(dataDir)
    const pm = makeProcessTable() // liveSids 空 = 进程已退出
    // 实例快照仍在（registered 过），但 client 没了 → 必须走冷读
    const { query } = makeQuery({ pm, live: liveStatesStub('prov-stale/model-stale', 'low') })

    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(pm.spawnCalls).toEqual([])
  })

  // ── 会话不存在 / 主会话冷读分叉 ──

  it('会话不存在：两段扫描 + btw 注册表都未命中 → SESSION_NOT_FOUND 结构化错误', async () => {
    const { query } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(SessionNotFoundError)
    await expect(query.getState('55555555-5555-4555-8555-555555555555')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('主会话冷读：段 1 缓存未命中 → 段 2 全扫命中', async () => {
    const fx = seedForkFixture(dataDir)
    // 预填 sessionMetaCache 后清空，确保段 1 miss（段 2 才被走到）
    expect(scanPiSessions({ force: true }).length).toBe(1)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ sessionId: fx.mainSid, source: 'disk-scan', found: true })
    // 扫描目录数 = 该轮枚举的 cwd 分组目录数（fixture 只有 1 个 cwd 分组）
    expect(traces[0].scannedDirCount).toBe(1)
    expect(sessionScanDirCount.last).toBe(1)
  })

  it('主会话冷读：段 1 缓存命中 → 不发生磁盘扫描（埋点 source=meta-cache、目录数 0）', async () => {
    const fx = seedForkFixture(dataDir)
    // 段 1 前置：先跑一次全扫把 meta 填进 sessionMetaCache
    expect(scanPiSessions({ force: true }).length).toBe(1)
    expect(findCachedSessionFileById(fx.mainSid)).toBe(fx.mainFile)

    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(fx.mainSid)

    expect(state).toEqual({ sessionId: fx.mainSid, modelId: 'prov-d/model-d', thinkingLevel: 'high' })
    expect(traces[0]).toMatchObject({ source: 'meta-cache', scannedDirCount: 0, found: true })
  })

  it('文件在但无模型记录：显式未知（字段缺省），不猜、不报错', async () => {
    const sid = '66666666-6666-4666-8666-666666666666'
    const cwdGroup = 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    writeJsonl(join(dataDir, 'agent', 'sessions', cwdGroup, `${sid}.jsonl`), [
      headerLine(sid, '/tmp/proj'),
      entryLine('session_info', { id: 's1' }),
    ])
    invalidateScanDirCache()

    const { query } = makeQuery({ pm: makeProcessTable() })
    const state = await query.getState(sid)

    expect(state).toEqual({ sessionId: sid })
    expect(state.modelId).toBeUndefined()
  })

  // ── 冷路径埋点 ──

  it('埋点：单次耗时 + 扫描目录数 + 定位来源三字段齐录', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    let clock = 1000
    const { query, traces } = makeQuery({ pm: makeProcessTable(), now: () => (clock += 7) })

    await query.getState(fx.linePiId)

    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ sessionId: fx.linePiId, source: 'btw-registry', scannedDirCount: 0, found: true })
    // 耗时 = 注入时钟的增量（确定性，不依赖真实挂钟）
    expect(traces[0].durationMs).toBe(7)
  })

  it('埋点：未命中也留痕（found=false，供「SESSION_NOT_FOUND 频度」归因）', async () => {
    const { query, traces } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(traces).toEqual([expect.objectContaining({ source: 'disk-scan', found: false, scannedDirCount: 0 })])
  })

  it('埋点回调缺省时不抛（生产未注入 logger 的形态）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const query = new SessionStateQuery({
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: (sid) => findCachedSessionFileById(sid),
      locateMainSessionFileFromDisk: (sid) => findScannedSessionFileById(sid),
      locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId) ?? findBtwLineFileByPiSessionId(sessionId),
    })
    await expect(query.getState(fx.linePiId)).resolves.toMatchObject({ modelId: 'prov-a/model-a' })
  })

  // ── btw 线定位的两级（注册表记录 / 存储树布局）──

  it('btw 线：注册表记录命中（lifecycle.get(sessionId).sessionFilePath）即用，不碰布局定位', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery({ pm: makeProcessTable() })

    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
    // 布局定位读的是同一个文件，故此处不断言「未调用」；断言语义由下一条的对照覆盖
    expect(findBtwLineFileByPiSessionId(fx.linePiId)).toBe(fx.lineFile)
  })

  it('btw 线：注册表无记录（重启后 rebuildFromDisk 不注册进 lifecycle）→ 存储树布局定位兜底', async () => {
    const fx = seedForkFixture(dataDir)
    // 不填 btwRegistry = 重启后的线（BtwService.registry 有、lifecycle.sessions 无）
    const { query } = makeQuery({ pm: makeProcessTable() })

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
  })

  it('btw 线：两级都未命中（线文件不在磁盘）→ SESSION_NOT_FOUND，不猜路径', async () => {
    const { query } = makeQuery({ pm: makeProcessTable() })
    await expect(query.getState('55555555-5555-4555-8555-555555555555')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
