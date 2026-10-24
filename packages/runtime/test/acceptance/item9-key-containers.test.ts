/**
 * D3 验收资产：§7 验收项 9（5 类键容器点检，可证伪形态不用裸 grep）gap 测试。
 *
 * 规格原文（设计文档 §7 表项 9）：逐个点检 5 类键容器——bus 发布键、`chatStore` 分区键、
 * 状态层分区键、LRU 键、per-vid 簿记表——**均以 piId 为键且不存在 btw 专用翻译函数**；
 * 豁免白名单 = `subagent:` / `agentcall:` 虚拟 id（§2.3 合法保留）。**增补**：renderer
 * 派生表与注册表逐条一致（现行形态 = btw-line-membership 拉取缓存与注册表一致——
 * session.surfaces 广播帧已随 W4b 收编第三步删除，D2 审查已确认此演化）。
 *
 * 行为点检方法（不用裸 grep——每类容器用真实行为驱动后断言键形态）：
 * 1. **bus 发布键**：SessionStateProjection（真实 MessageBus + publish spy）注册线 piId
 *    并驱动一次状态变更发布 → 断言 publish 调用的 sessionId 键 = piId、帧 payload
 *    sessionId = piId、全部 publish 键无 `btw:` 前缀形态；
 * 2. **状态层分区键**：registerReplicatedStates(piId) 后实例组按 piId 可取、
 *    `btw:<piId>` 形态取不到；onSessionDisposed(piId) 后同键清除（键空间对称）；
 * 3. **btw 线注册表键**（per-vid 簿记表的 runtime 同级结构 + 增补的「注册表」本体）：
 *    BtwService.rebuildFromDisk 从 tmp 存储树重建 → getLine(piId) 命中、
 *    getLine(`btw:<piId>`) 不命中；布局定位 findBtwLineFileByPiSessionId(piId) 命中；
 * 4. **LRU 键**（chat lru，@taiji/core/domain/chat）：touchLru(piId) 后按 piId 驱逐
 *    生效、按 `btw:<piId>` 驱逐 no-op（证明存的键是裸 piId 而非翻译形态）；
 * 5. **shared 导出面无 btw 专用翻译函数**：import 后断言 BTW_PREFIX / btwVirtualId /
 *    isBtwVirtualId / extractBtwPiSessionId 全部 undefined（u-w4a ③ 已整体删除，
 *    本断言防复活——比 grep 可证伪：grep 漏注释/字符串形态，import 断言漏一个即红）。
 *
 * 物理位置说明（deviations 登记依据）：`chatStore` 分区键、`per-vid` 簿记表
 * （btw-pending-bookkeeping 的 dialogReqsBySessionId / expiredNoticeBySessionId）与
 * btw-line-membership 拉取缓存物理位于 renderer 包（btw-pending-bookkeeping import
 * `@/stores/extension-ui` 渲染层别名，runtime 测试无法 import），由 A6 剧本 spawn
 * u-w4a 随批测试覆盖：chat-lru-btw.test.ts（core，chatStore 分区键 + LRU 键以真实
 * 线 session id 驱动）、use-btw-tab-data.test.ts（renderer，两张 per-vid 簿记表 +
 * btw-line-membership 拉取缓存 noteBtwLinesPulled/isKnownBtwLine 以真实线 session
 * id 驱动）。本文件覆盖 runtime 包内与可跨包导入（@taiji/core 是 runtime 已声明依赖）
 * 的全部容器 + shared 导出面。
 *
 * 数据隔离（项目测试红线）：fixture 落 `mkdtempSync(join(tmpdir(), ...))`；
 * TAIJI_AGENT_DATA_DIR 指向该 tmp，不触真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item9-key-containers.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as shared from '@taiji/shared'
import {
  touchLru,
  isVirtualKey,
  disposeLruEntry,
  _resetLruForTest,
  _lruSizeForTest,
} from '@taiji/core/domain/chat'
import type { ServerMessage } from '@taiji/shared'
import type { IProcessManager, IPiEngine } from '../../src/services/ports/pi-engine.js'
import type { IManagedSessionView } from '../../src/services/session/types.js'
import { SessionStateProjection, type SessionStateProjectionDeps } from '../../src/services/session/session-state-projection.js'
import { MessageBus } from '../../src/services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../../src/services/session/replicated-states.config.js'
import { BtwService, type BtwServiceDeps } from '../../src/services/session/btw-service.js'
import { findBtwLineFileByPiSessionId } from '../../src/infra/pi/session-file-locator.js'
import { invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../../src/infra/pi/session-file-utils.js'

// ── fixture：tmp 环境 1 主会话 + 1 btw 线（拿真实 piId）────────────────────────

/** 主会话扫描区目录名（encodeCwd 分组哈希） */
const CWD_GROUP = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * 构造一对主会话 + btw 线（pi 落盘真实形态）：
 * - 主会话文件 `<dataDir>/agent/sessions/<cwdGroup>/<mainSid>.jsonl`（header.id = mainSid）
 * - 线文件 `<dataDir>/ext-sessions/<mainSid>/btw/<linePiId>.jsonl`（header.id = linePiId
 *   = pi 落盘命名主干 = 线的唯一键）
 */
function seedPair(dataDir: string): { mainSid: string; linePiId: string; lineFile: string } {
  const mainSid = randomUUID()
  const linePiId = randomUUID()
  const mainFile = join(dataDir, 'agent', 'sessions', CWD_GROUP, `${mainSid}.jsonl`)
  const lineFile = join(dataDir, 'ext-sessions', mainSid, 'btw', `${linePiId}.jsonl`)
  writeJsonl(mainFile, [
    headerLine(mainSid, '/tmp/proj'),
    JSON.stringify({ type: 'session_info', id: 's1' }),
    JSON.stringify({ type: 'model_change', id: 'mcA', parentId: 's1', provider: 'prov-a', modelId: 'model-a', timestamp: '2026-10-24T00:00:03.000Z' }),
  ])
  writeJsonl(lineFile, [
    headerLine(linePiId, '/tmp/proj'),
    JSON.stringify({ type: 'session_info', id: 's1' }),
    JSON.stringify({ type: 'model_change', id: 'mcA', parentId: 's1', provider: 'prov-a', modelId: 'model-a', timestamp: '2026-10-24T00:00:03.000Z' }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: 'mcA', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-24T00:00:01.000Z' }),
  ])
  return { mainSid, linePiId, lineFile }
}

/** `btw:<piId>` 翻译形态（已退役的虚拟 id；键容器回归的探针） */
function btwPrefixed(piId: string): string {
  return `btw:${piId}`
}

// ── 容器 1/2 基建：SessionStateProjection 直测环境（session-state-projection.test.ts 同款形态）──

/** 最小 IManagedSessionView stub（projection 只读 id/modelId/thinkingLevel/isGenerating） */
function makeSessionView(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/tmp',
    label: 'stub',
    modelId: 'fallback/model',
    thinkingLevel: 'low',
    createdAt: 0,
    lastActiveAt: 0,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

/** get_state / get_session_stats / get_commands 的权威响应形状（fake pi client） */
function stateResponse(model = 'prov-live/model-live'): Record<string, unknown> {
  return { thinkingLevel: 'high', model: { provider: model.split('/')[0], id: model.split('/')[1] } }
}

type PublishCall = [string, ServerMessage]

function makeProjectionEnv(sessionId: string) {
  const sessions = new Map<string, IManagedSessionView>([[sessionId, makeSessionView(sessionId)]])
  const client = {
    getState: vi.fn(async () => stateResponse()),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 100, contextWindow: 128000, percent: 25 } })),
    getCommands: vi.fn(async () => [{ name: '/cmd', description: 'd' }]),
  }
  const pm = {
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const deps: SessionStateProjectionDeps = {
    pm,
    getSession: (sid) => sessions.get(sid),
    hasSession: (sid) => sessions.has(sid),
    getMessageBus: () => bus,
    fetchContext: vi.fn(async () => null),
    persistSessionOutcome: vi.fn(),
    tryPersistProjectBinding: vi.fn(),
  }
  const projection = new SessionStateProjection(deps)
  return { projection, bus, publishSpy, client, sessions }
}

/** publishSpy.mock.calls 的窄读视图 */
function publishedCalls(publishSpy: ReturnType<typeof vi.spyOn>): PublishCall[] {
  return publishSpy.mock.calls as unknown as PublishCall[]
}

/** 收集 bus publish 的某类型消息 */
function messagesOf(calls: PublishCall[], type: string): Array<{ payload: Record<string, unknown> }> {
  return calls.map(([, m]) => m).filter((m) => m.type === type).map((m) => m as { payload: Record<string, unknown> })
}

// ── 容器 3 基建：BtwService deps fake（rebuildFromDisk 不使用任何 spawn 面）────────

function makeBtwServiceDeps(): BtwServiceDeps {
  return {
    processes: {
      createSession: vi.fn(async () => ({}) as IPiEngine),
      destroySession: vi.fn(async () => {}),
      rekey: vi.fn(),
      getClient: vi.fn(() => undefined),
    },
    buildLineSpawnOptions: vi.fn(async () => ({})),
    registerSession: vi.fn(async () => ({})),
    resolveMainSessionFile: vi.fn(() => undefined),
    trashDirectory: vi.fn(async () => {}),
    resolvePiCommand: () => 'pi-not-used',
  }
}

// ── 测试体 ─────────────────────────────────────────────────────────────

describe('§7 验收项 9：5 类键容器点检（均以 piId 为键，无 btw: 前缀形态）', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w4a-item9-keys-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    _resetLruForTest()
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    _resetSessionMetaCacheForTest()
    _resetLruForTest()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    vi.restoreAllMocks()
  })

  // ── 容器 1：bus 发布键 ──

  it('容器1 bus 发布键：状态变更发布帧的 sessionId 键 = 线 piId（无 btw: 前缀形态）', async () => {
    vi.useFakeTimers()
    try {
      const fx = seedPair(dataDir)
      const env = makeProjectionEnv(fx.linePiId)

      // 注册（播种）→ 快照 fetch 落定 → setTimeout 0 发布 state_changed
      env.projection.registerReplicatedStates(fx.linePiId)
      await vi.advanceTimersByTimeAsync(0)

      const calls = publishedCalls(env.publishSpy)
      expect(calls.length).toBeGreaterThan(0)
      // 全部 publish 调用的键（第一参）= 裸 piId；无任何 btw: 前缀形态
      const keys = calls.map(([key]) => key)
      expect(new Set(keys)).toEqual(new Set([fx.linePiId]))
      expect(keys.some((k) => k.startsWith('btw:'))).toBe(false)

      // session.state_changed 帧：键与 payload.sessionId 双落 piId
      const stateChanged = messagesOf(calls, 'session.state_changed')
      expect(stateChanged).toHaveLength(1)
      expect(stateChanged[0].payload).toMatchObject({ sessionId: fx.linePiId, modelId: 'prov-live/model-live' })

      // 再驱动一次状态变更（markDirty → 防抖 refetch → 发布）：键仍 = piId
      env.client.getState.mockImplementation(async () => stateResponse('prov-next/model-next'))
      env.projection.getReplicatedStates(fx.linePiId)!.modelId.markDirty()
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 100)
      const after = messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')
      expect(after.length).toBeGreaterThan(1)
      expect(after.at(-1)!.payload).toMatchObject({ sessionId: fx.linePiId, modelId: 'prov-next/model-next' })
      expect(publishedCalls(env.publishSpy).every(([key]) => key === fx.linePiId)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── 容器 2：状态层分区键（ReplicatedStates 实例组）──

  it('容器2 状态层分区键：实例组按 piId 可取、btw:<piId> 形态取不到；销毁同键清除', async () => {
    vi.useFakeTimers()
    try {
      const fx = seedPair(dataDir)
      const env = makeProjectionEnv(fx.linePiId)

      env.projection.registerReplicatedStates(fx.linePiId)
      await vi.advanceTimersByTimeAsync(0)

      // 实例组（四实例：modelId / thinkingLevel / usage / commands）以裸 piId 为键
      const states = env.projection.getReplicatedStates(fx.linePiId)
      expect(states).toBeDefined()
      expect(states!.modelId.get()).toMatchObject({ modelId: 'prov-live/model-live' })
      // 翻译形态（btw:<piId>）取不到——键空间无第二套 id
      expect(env.projection.getReplicatedStates(btwPrefixed(fx.linePiId))).toBeUndefined()

      // 销毁按同一键清除（注册/销毁键空间对称）
      env.projection.onSessionDisposed(fx.linePiId)
      expect(env.projection.getReplicatedStates(fx.linePiId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── 容器 3：btw 线注册表键（per-vid 簿记表的 runtime 同级结构 + 增补的注册表本体）──

  it('容器3 btw 线注册表键：rebuildFromDisk 以线 header.id（piId）为键，btw:<piId> 不命中', () => {
    const fx = seedPair(dataDir)
    const svc = new BtwService(makeBtwServiceDeps())
    try {
      const rebuilt = svc.rebuildFromDisk()
      expect(rebuilt.map((r) => r.piSessionId)).toEqual([fx.linePiId])
      // 成员查询：裸 piId 命中（surface 复原为 'btw'）
      const rec = svc.getLine(fx.linePiId)
      expect(rec).toMatchObject({ piSessionId: fx.linePiId, mainSid: fx.mainSid, surface: 'btw' })
      // 翻译形态不命中（旧 btw:<piId> 两段式已退役）
      expect(svc.getLine(btwPrefixed(fx.linePiId))).toBeUndefined()
      // 归属过滤按 mainSid（注册表即 D4 关联投影）
      expect(svc.listLines(fx.mainSid).map((r) => r.piSessionId)).toEqual([fx.linePiId])
      expect(svc.listLines(randomUUID())).toEqual([])
      // 存储树布局定位（冷读兜底）同键命中同一文件
      expect(findBtwLineFileByPiSessionId(fx.linePiId)).toBe(fx.lineFile)
      expect(findBtwLineFileByPiSessionId(btwPrefixed(fx.linePiId))).toBeUndefined()
    } finally {
      svc.dispose()
    }
  })

  // ── 容器 4：chat LRU 键 ──

  it('容器4 LRU 键：touchLru(piId) 后按 piId 驱逐生效、按 btw:<piId> 驱逐 no-op', () => {
    const fx = seedPair(dataDir)
    touchLru(fx.linePiId)
    expect(_lruSizeForTest()).toBe(1)
    // 翻译形态驱逐 no-op——证明 LRU 存的键是裸 piId，不是 btw:<piId>
    disposeLruEntry(btwPrefixed(fx.linePiId))
    expect(_lruSizeForTest()).toBe(1)
    // 裸 piId 驱逐生效
    disposeLruEntry(fx.linePiId)
    expect(_lruSizeForTest()).toBe(0)
    // 豁免白名单（§2.3）：subagent:/agentcall: 是合法虚拟键；btw: 不在白名单
    expect(isVirtualKey('subagent:main:sub')).toBe(true)
    expect(isVirtualKey('agentcall:abc')).toBe(true)
    expect(isVirtualKey(fx.linePiId)).toBe(false)
    expect(isVirtualKey(btwPrefixed(fx.linePiId))).toBe(false)
  })

  // ── 导出面：shared 无 btw 专用翻译函数 ──

  it('导出面：shared 不存在 btw 专用翻译函数（BTW_PREFIX/btwVirtualId/isBtwVirtualId/extractBtwPiSessionId 均 undefined）', () => {
    const anyShared = shared as Record<string, unknown>
    for (const name of ['BTW_PREFIX', 'btwVirtualId', 'isBtwVirtualId', 'extractBtwPiSessionId']) {
      expect(anyShared[name], `shared.${name} must not exist (u-w4a ③ 已整体删除)`).toBeUndefined()
    }
    // 对照组：豁免白名单两族工厂在 shared 导出面存在（§2.3 合法保留）
    expect(typeof anyShared.subagentVirtualId).toBe('function')
    expect(typeof anyShared.isSubagentVirtualId).toBe('function')
    expect(typeof anyShared.agentCallVirtualId).toBe('function')
    expect(typeof anyShared.isAgentCallVirtualId).toBe('function')
  })
})

// 说明：chatStore 分区键（core domain/chat store 的 messages Map）与 per-vid 簿记表
// （renderer btw-pending-bookkeeping 两张表）+ btw-line-membership 拉取缓存与注册表
// 一致的逐条点检，物理位于 renderer/core 包，由 A6 剧本 spawn u-w4a 随批测试执行
// （chat-lru-btw.test.ts / use-btw-tab-data.test.ts / btw-panel.test.ts）——分工依据
// 见文件头「物理位置说明」。
