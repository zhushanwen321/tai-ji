/**
 * plugin-rpc-server：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - session-api-active-path.test.ts
 *   - ui-api-worker-wrapper.test.ts
 *   - plugin-api-extended.test.ts
 *   - plugin-injection-guard.test.ts
 *   - plugin-session-data-cache.test.ts
 *   - session-api-activate.test.ts
 *   - session-api-read.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/plugin-service/__tests__/plugin-rpc-server.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, readdirSync, rm, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { getSessionPluginDataPath, getSessionStoreDir } from '@taiji/shared/paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPiEngine, IProcessManager, PiCommandInfo } from '../../ports/pi-engine.js'
import { createAgentApi, registerAgentRpcHandlers } from '../api/agent-api.js'
import type { AgentHandlers } from '../api/agent-api.js'
import { createConfigApi, registerConfigRpcHandlers } from '../api/config-api.js'
import type { ConfigHandlers } from '../api/config-api.js'
import { ActiveSessionResolver, SESSION_ACTIVATE_METHODS, SESSION_NOT_ACTIVE, SESSION_READ_METHODS, SESSION_READ_NOT_WIRED, SessionEventDispatch, createSessionApi, filterEntriesToActivePath, registerSessionRpcHandlers } from '../api/session-api.js'
import type { SessionHandlers, SessionReadDeps } from '../api/session-api.js'
import { createSessionDataApi, registerSessionDataRpcHandlers } from '../api/session-data-api.js'
import type { SessionDataHandlers } from '../api/session-data-api.js'
import { registerStorageRpcHandlers, storageHandlersFrom } from '../api/storage-api.js'
import { createUiApi, registerUiRpcHandlers, resetRuntimeUiExitsForTest } from '../api/ui-api.js'
import type { UiHandlers } from '../api/ui-api.js'
import { createWorkspaceApi, registerWorkspaceRpcHandlers } from '../api/workspace-api.js'
import type { WorkspaceHandlers } from '../api/workspace-api.js'
import { ENTRY_INVALIDATION_NOTIFY_METHOD, EntryInvalidationDispatch } from '../plugin-entry-invalidation-dispatch.js'
import { PluginRpcClient } from '../plugin-rpc-client.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'
import type { WorkerPort } from '../plugin-rpc-server.js'
import { registerAllRpcMethods } from '../plugin-rpc-setup.js'
import type { RpcSetupContext } from '../plugin-rpc-setup.js'
import { PluginStorage } from '../plugin-storage.js'
import { PluginRpcErrorCodes } from '../plugin-types.js'
import type { IPluginServiceDeps, RpcResponse, SessionInfo } from '../plugin-types.js'
import { PluginUiSnapshotStore } from '../plugin-ui-snapshot-store.js'
import { SessionDataStore } from '../session-data-store.js'


// ════════════════ 来源: session-api-active-path.test.ts ════════════════
describe('session-api-active-path', () => {
  /**
   * readEntries 活跃路径过滤（消息撤回派生视图残留修复，U7）单元验收测试。
   *
   * 两块：
   * 1. filterEntriesToActivePath 纯函数（派生视图前裁剪）：有分支 fixture 被撤子树剔除 /
   *    leafId 缺失·null·悬空三态防御回退（不过滤，回归钉）/ parentId 环防环终止 /
   *    线性批（增量形态父链越批）不丢数据 / 无树信息 legacy 不过滤。
   * 2. handler 级集成（真实 PluginRpcServer.dispatch → readEntries handler）：过滤真实
   *    接入读链路 + 对外五字段派生视图契约零变更（parentId 仍不出 runtime）。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/session-api-active-path.test.ts
   */

  const TS = '2026-01-01T00:00:00.000Z'

  /** 带 tree 字段的 raw pi entry（get_entries 回包形态：id/parentId/timestamp + 域字段）。 */
  function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, parentId, timestamp: TS, ...extra }
  }

  /** 标准撤回后树：root → 被撤子树（含 task op）→ 撤回后活跃路径（label 锚 + 新消息）。 */
  function branchedTree(): { entries: Record<string, unknown>[]; leafId: string } {
    return {
      entries: [
        entry('e1', null),
        entry('e2', 'e1', { type: 'message', message: { role: 'user', content: '被撤消息' } }),
        // 被撤子树：task op custom entry + assistant 回复（撤回后面板残留的缺陷源）
        entry('e3', 'e2', { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } }),
        entry('e4', 'e3', { type: 'message', message: { role: 'assistant', content: '被撤回复' } }),
        // 撤回后活跃路径：navigateTree 回 e1 后追加的新分支
        entry('e5', 'e1', { type: 'label', label: 'taiji:revoked' }),
        entry('e6', 'e5', { type: 'message', message: { role: 'user', content: '新消息' } }),
      ],
      leafId: 'e6',
    }
  }

  describe('filterEntriesToActivePath：活跃路径裁剪（派生视图生成前）', () => {
    it('有分支 fixture：被撤子树（含 task op）剔除，活跃路径条目全保留且保持文件序', () => {
      const t = branchedTree()
      const filtered = filterEntriesToActivePath(t.entries, t.leafId)
      expect(filtered.map((e) => (e as { id: string }).id)).toEqual(['e1', 'e5', 'e6'])
    })

    it('leafId 缺失（undefined）→ 不过滤（回退现行为，回归钉）', () => {
      const t = branchedTree()
      expect(filterEntriesToActivePath(t.entries, undefined)).toEqual(t.entries)
    })

    it('leafId null → 不过滤（空 session / 回归钉）', () => {
      const t = branchedTree()
      expect(filterEntriesToActivePath(t.entries, null)).toEqual(t.entries)
    })

    it('leafId 悬空（不在条目集）→ 不过滤（防御回退：不丢数据，与 scheduler 扩展回退语义同构）', () => {
      const t = branchedTree()
      expect(filterEntriesToActivePath(t.entries, 'nope')).toEqual(t.entries)
    })

    it('parentId 环 → 防环检查终止（不死循环、不抛），回溯可达条目保留', () => {
      const entries = [
        entry('a', 'c'), // 环：a → c → b → a
        entry('b', 'a'),
        entry('c', 'b'),
        entry('d', 'a'),
      ]
      // 不挂 Timeout（死循环撑爆用例超时）即防环成立的构造性证明；环不可达的 d 被剔
      const filtered = filterEntriesToActivePath(entries, 'a')
      expect(filtered.map((e) => (e as { id: string }).id)).toEqual(['a', 'b', 'c'])
    })

    it('线性连续批（增量形态：首条 parent 在批外悬空）→ 全批保留不丢数据', () => {
      const entries = [
        entry('c1', 'cursor'), // cursor 在上次拉取范围（批外）
        entry('c2', 'c1'),
        entry('c3', 'c2'),
      ]
      expect(filterEntriesToActivePath(entries, 'c3')).toEqual(entries)
    })

    it('无树信息（全条目缺 string id）→ 不过滤（legacy 线性 fixture）', () => {
      const entries = [{ type: 'custom', customType: 'x', data: 1 }, { foo: 'bar' }]
      expect(filterEntriesToActivePath(entries, 'e1')).toEqual(entries)
    })

    it('空 entries → 原样返回', () => {
      expect(filterEntriesToActivePath([], 'e1')).toEqual([])
    })
  })

  describe('readEntries handler 集成：过滤接入读链 + 对外契约零变更', () => {
    it('被撤子树的 task op 不在回包；活跃路径 task op 仍为精确五字段派生视图（parentId 不出 runtime）', async () => {
      const t = branchedTree()
      const fakeClient = {
        exited: false,
        getEntries: async () => ({ data: { entries: t.entries, leafId: t.leafId } }),
      }
      const server = new PluginRpcServer()
      const sent: Array<{ type: string; response?: { result?: unknown } }> = []
      server.registerWorker('w1', { postMessage: (m: unknown) => sent.push(m as (typeof sent)[number]) })
      const deps: SessionHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage: async () => ({ blocked: false }),
        sessionEvents: new SessionEventDispatch(server),
        sessionRead: {
          pm: { getClient: () => fakeClient as unknown as IPiEngine },
          getSessionSummary: () => ({ sessionFile: '/sessions/s1.jsonl' }),
          entryInvalidation: new EntryInvalidationDispatch({ sessionExists: () => true }),
        },
      }
      registerSessionRpcHandlers(server, deps)
      const read = (id: number): Promise<void> =>
        server.dispatch('w1', {
          jsonrpc: '2.0',
          id,
          method: SESSION_READ_METHODS.readEntries,
          params: { pluginId: 'p1', sessionId: 's1', customType: 'pi-scheduler:task' },
        })

      // 第一轮：撤回后树——被撤子树的 task op（e3）被裁剪，其余条目非 task 域被派生视图过滤，
      // 两道收窄叠加后回包 = 空集；游标照常透出（下次 sinceEntryId 语义不变）
      await read(1)
      const result1 = (sent[0]?.response?.result ?? {}) as {
        entries: Array<Record<string, unknown>>
        leafEntryId?: string
        sessionFile?: string
      }
      expect(result1.entries).toEqual([])
      expect(result1.leafEntryId).toBe('e6')
      expect(result1.sessionFile).toBe('/sessions/s1.jsonl')

      // 第二轮：task op 落在活跃路径——派生视图契约回归（精确五字段、无 parentId）
      fakeClient.getEntries = async () => ({
        data: {
          entries: [
            entry('e1', null),
            entry('ok1', 'e1', { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } }),
          ],
          leafId: 'ok1',
        },
      })
      await read(2)
      const result2 = (sent[1]?.response?.result ?? {}) as typeof result1
      expect(result2.entries).toEqual([
        { id: 'ok1', timestamp: TS, type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } },
      ])
      expect(result2.entries[0]).not.toHaveProperty('parentId')
    })
  })
});

// ════════════════ 来源: ui-api-worker-wrapper.test.ts ════════════════
describe('ui-api-worker-wrapper', () => {
  /**
   * ui-api Worker 侧包装面 + B-F2 广播缺失降级包装测试（MF-1-23）。
   *
   * 两块此前无测试的面（运行时仲裁面已有 contract 测试，但 Worker 侧包装面与装配侧
   * 降级包装没有）：
   *   1. createUiApi（Worker 侧）：updateHeaderAction 的 RPC 转发体（method/params 组装 +
   *      result 透传）。走真实 PluginRpcClient（fake port 捕获出站帧 + handleResponse 回注），
   *      不 mock client——链路即生产形态。
   *   2. plugin-rpc-setup 的 B-F2 降级包装：registerAllRpcMethods 装配的
   *      broadcastHeaderActionUpdate 在 deps.broadcastFn 缺失时返回 false + warn 丢弃——
   *      ui-api 据此不谎报成功（updateHeaderAction 回 {updated:false}）。
   */

  /** Worker 侧出站帧（RpcRequest & { type: 'rpc' }）。 */
  interface OutboundRpcFrame { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    type: string
    method: string
    id?: number
    params: Record<string, unknown>
  }

  /** 真实 PluginRpcClient + fake port：捕获出站帧，测试侧回注 response/notification。 */
  function makeWorkerClient(): { client: PluginRpcClient; sent: OutboundRpcFrame[] } {
    const sent: OutboundRpcFrame[] = []
    const client = new PluginRpcClient()
    client.attach({ postMessage: (m: unknown) => { sent.push(m as OutboundRpcFrame) } })
    return { client, sent }
  }

  /** 对指定出站请求帧回注成功响应（request 帧必有 id——运行时 guard 收窄可选类型）。 */
  function replyResult(client: PluginRpcClient, frame: OutboundRpcFrame, result: unknown): void {
    if (frame.id === undefined) throw new Error(`outbound frame missing id: ${frame.method}`)
    client.handleResponse({ jsonrpc: '2.0', id: frame.id, result })
  }

  describe('createUiApi Worker 侧包装面', () => {
    it('updateHeaderAction 转发体：headerActionId 映射 + opts 展开 + result 透传', async () => {
      const { client, sent } = makeWorkerClient()
      const api = createUiApi(client, 'plugin-a')
      const pending = api.updateHeaderAction('ha1', { sessionId: 's1', badge: '3', tooltip: 'tips' })

      expect(sent).toHaveLength(1)
      expect(sent[0].method).toBe('plugin.ui.updateHeaderAction')
      expect(sent[0].params).toEqual({
        pluginId: 'plugin-a',
        headerActionId: 'ha1',
        sessionId: 's1',
        badge: '3',
        tooltip: 'tips',
      })

      replyResult(client, sent[0], { updated: true })
      await expect(pending).resolves.toEqual({ updated: true })
    })
  })

  // ── B-F2 广播缺失降级包装（plugin-rpc-setup 装配侧）──────────────────────────

  /** dispatch 回包帧（host → worker port postMessage 形态）。 */
  interface HostReplyFrame { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    type: string
    response: { id?: number | string | null; result?: unknown; error?: { code: unknown; message: string } }
  }

  /**
   * 真实 PluginRpcServer + registerAllRpcMethods 全量装配：dispatch plugin.ui.* 请求，
   * 从 fake worker port 捕获回包。deps 按用例注入（broadcastFn 缺失 / 在场两分支）；
   * broadcastCalls 捕获在场分支的广播帧参数。
   */
  function assemble(deps: IPluginServiceDeps): {
    server: PluginRpcServer
    frames: HostReplyFrame[]
    broadcastCalls: unknown[][]
  } {
    const frames: HostReplyFrame[] = []
    const broadcastCalls: unknown[][] = []
    const port: WorkerPort = { postMessage: (m: unknown) => { frames.push(m as HostReplyFrame) } }
    const server = new PluginRpcServer()
    server.registerWorker('w1', port)
    const broadcastDeps: IPluginServiceDeps = deps.broadcastFn
      ? { ...deps, broadcastFn: (type: string, payload: unknown) => { broadcastCalls.push([type, payload]) } }
      : deps
    const ctx = {
      rpcServer: server,
      storage: new PluginStorage(),
      toolRegistry: new Map(),
      hookRegistry: new Map(),
      deps: broadcastDeps,
      handleUiRequest: vi.fn(),
      cancelUiRequest: vi.fn(),
      syncToolsToBridge: vi.fn(),
      getDescriptor: vi.fn(),
      sessionDataStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn(() => []) },
      activeSessionResolver: new ActiveSessionResolver(broadcastDeps),
      commandRegistry: new Map(),
      sessionEvents: new SessionEventDispatch(server),
      entryInvalidation: new EntryInvalidationDispatch({ sessionExists: () => true }),
      mountPoints: [],
      deliverInvokeResult: vi.fn(),
      publishViewUpdate: vi.fn(),
      // broadcastHeaderActionUpdate 出线先写快照再广播（ADR-0097）——缺此字段 handler 抛
      // TypeError 走 error 回包，result 永为 undefined
      uiSnapshotStore: new PluginUiSnapshotStore(),
    } as unknown as RpcSetupContext
    registerAllRpcMethods(ctx)
    return { server, frames, broadcastCalls }
  }

  describe('B-F2 广播缺失降级包装（registerAllRpcMethods → wireRuntimeUiExits）', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // 广播出线是模块级单例（ui-api「测试用 resetRuntimeUiExitsForTest 复位」）
      resetRuntimeUiExitsForTest()
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('broadcastFn 缺失：updateHeaderAction 回 {updated:false}（不谎报渲染端已收到）+ warn', async () => {
      const { server, frames } = assemble({})
      await server.dispatch('w1', {
        jsonrpc: '2.0',
        id: 2,
        method: 'plugin.ui.updateHeaderAction',
        params: { pluginId: 'plugin-a', headerActionId: 'ha1', sessionId: 's1', badge: '3' },
      })

      expect(frames).toHaveLength(1)
      expect(frames[0].response.result).toEqual({ updated: false })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('plugin:headerActionUpdate broadcast dropped: no broadcastFn configured'),
      )
    })

    it('对照：broadcastFn 在场 → updateHeaderAction 成功且 plugin:headerActionUpdate 帧真正发出', async () => {
      const { server, frames, broadcastCalls } = assemble({
        broadcastFn: () => {},
      })
      await server.dispatch('w1', {
        jsonrpc: '2.0',
        id: 3,
        method: 'plugin.ui.updateHeaderAction',
        params: { pluginId: 'plugin-a', headerActionId: 'ha1', sessionId: 's1', badge: '3' },
      })

      expect(frames).toHaveLength(1)
      expect(frames[0].response.result).toEqual({ updated: true })
      expect(broadcastCalls).toHaveLength(1)
      const [type, payload] = broadcastCalls[0] as [string, Record<string, unknown>]
      expect(type).toBe('plugin:headerActionUpdate')
      expect(payload).toMatchObject({ pluginId: 'plugin-a', headerActionId: 'ha1', sessionId: 's1', badge: '3' })
    })
  })
});

// ════════════════ 来源: plugin-api-extended.test.ts ════════════════
describe('plugin-api-extended', () => {
  /**
   * Extended API 测试
   *
   * 验证 6 个 API 模块的 RPC handler（主线程侧）和 Worker 侧代理：
   *
   * - session-api：plugin.sessions.list / get / getActive / sendMessage
   * - config-api：plugin.config.get / getAll / set
   * - session-data-api：plugin.sessionData.get / set / delete / keys
   * - ui-api：plugin.ui.showSelect / showConfirm / showInput / notify
   * - agent-api：plugin.agent.setModel / getModel / getThinkingLevel / setThinkingLevel / getActiveTools
   * - workspace-api：plugin.workspace.rootPath / name / findFiles
   */





  // ── Helper: mock WorkerPort ────────────────────────────────────────

  function createMockPort(): WorkerPort & { messages: unknown[] } {
    const messages: unknown[] = []
    return {
      messages,
      postMessage(msg: unknown) {
        messages.push(msg)
      },
    }
  }

  function extractLastResponse(port: ReturnType<typeof createMockPort>): any {
    if (port.messages.length === 0) return { jsonrpc: '2.0', id: 0, result: undefined }
    const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
    return last.response as any
  }

  // ── Helper: mock PluginRpcClient ───────────────────────────────────

  interface MockRpcClient { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    requestCalls: Array<{ method: string; params: Record<string, unknown> }>
    requestResults: Map<string, unknown>
    onNotificationHandlers: Map<string, (params: unknown) => void>
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>
    onNotification: (method: string, handler: (params: unknown) => void) => () => void
    notify: (method: string, params: Record<string, unknown>) => void
  }

  function createMockRpcClient(): MockRpcClient & PluginRpcClient {
    const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestResults = new Map<string, unknown>()
    const onNotificationHandlers = new Map<string, (params: unknown) => void>()

    return {
      requestCalls,
      requestResults,
      onNotificationHandlers,
      request: (method: string, params: Record<string, unknown>) => {
        requestCalls.push({ method, params })
        const result = requestResults.get(method)
        return Promise.resolve(result !== undefined ? result : undefined)
      },
      onNotification: (method: string, handler: (params: unknown) => void) => {
        onNotificationHandlers.set(method, handler)
        return () => { onNotificationHandlers.delete(method) }
      },
      notify: (_method: string, _params: Record<string, unknown>) => {
        // not needed for tests
      },
    } as unknown as MockRpcClient & PluginRpcClient
  }

  // ══════════════════════════════════════════════════════════════════════
  // Session API
  // ══════════════════════════════════════════════════════════════════════

  describe('Session API — registerSessionRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let mockSessions: SessionInfo[]

    beforeEach(() => {
      rpc = new PluginRpcServer()
      mockSessions = [
        { id: 's1', label: 'Session 1', cwd: '/tmp', status: 'active', createdAt: 100, lastActiveAt: 200 },
        { id: 's2', label: 'Session 2', cwd: '/tmp', status: 'idle', createdAt: 300, lastActiveAt: 400 },
      ]

      registerSessionRpcHandlers(rpc, {
        listSessions: () => mockSessions,
        getSession: (id: string) => mockSessions.find(s => s.id === id),
        getActiveSession: () => mockSessions.find(s => s.status === 'active'),
        sendMessage: async (_sessionId: string, _role: string, _content: string, _requireCommand?: string) => ({ blocked: false }),
        // S3-W2：session 事件注册表（本测试不触事件投递，空表即可）
        sessionEvents: new SessionEventDispatch(rpc),
      })

      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.sessions.list → returns all sessions', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.sessions.list', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.id, 1)
      assert.ok('result' in resp)
      const sessions = resp.result as SessionInfo[]
      assert.strictEqual(sessions.length, 2)
      assert.strictEqual(sessions[0].id, 's1')
      assert.strictEqual(sessions[1].id, 's2')
    })

    it('plugin.sessions.get → returns session by id', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.sessions.get', params: { sessionId: 's1' } })
      const resp = extractLastResponse(port)
      const session = resp.result as SessionInfo | undefined
      assert.ok(session)
      assert.strictEqual(session.id, 's1')
      assert.strictEqual(session.label, 'Session 1')
    })

    it('plugin.sessions.get → returns undefined for unknown id', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.sessions.get', params: { sessionId: 'nonexistent' } })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, undefined)
    })

    it('plugin.sessions.getActive → returns active session', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.sessions.getActive', params: {} })
      const resp = extractLastResponse(port)
      const session = resp.result as SessionInfo | undefined
      assert.ok(session)
      assert.strictEqual(session.id, 's1')
      assert.strictEqual(session.status, 'active')
    })

    it('plugin.sessions.getActive → undefined when no active session', async () => {
      mockSessions = [
        { id: 's2', label: 'Session 2', cwd: '/tmp', status: 'idle', createdAt: 300, lastActiveAt: 400 },
      ]
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.sessions.getActive', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, undefined)
    })

    it('plugin.sessions.sendMessage → succeeds without error', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 6, method: 'plugin.sessions.sendMessage',
        params: { sessionId: 's1', role: 'user', content: 'hello' },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.id, 6)
      assert.ok('result' in resp, 'sendMessage should succeed')
    })
  })

  describe('Session API — createSessionApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
    })

    it('list() sends plugin.sessions.list RPC', async () => {
      mockClient.requestResults.set('plugin.sessions.list', [
        { id: 's1', label: 'S1', cwd: '/tmp', status: 'active', createdAt: 100, lastActiveAt: 200 },
      ])
      const api = createSessionApi(mockClient, 'test-plugin')
      const result = await api.list()
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].id, 's1')
    })

    it('sendMessage() sends plugin.sessions.sendMessage RPC', async () => {
      const api = createSessionApi(mockClient, 'test-plugin')
      await api.sendMessage({ sessionId: 's1', role: 'user', content: 'hello' })
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.sessions.sendMessage')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).sessionId, 's1')
      assert.strictEqual((call.params as Record<string, unknown>).role, 'user')
    })

    it('onDidCreateSession registers and triggers on notification', async () => {
      const api = createSessionApi(mockClient, 'test-plugin')
      const collected: SessionInfo[] = []
      const disposable = api.onDidCreateSession((s) => { collected.push(s) })

      // 验证注册请求已发出
      const regCall = mockClient.requestCalls.find(c => c.method === 'plugin.sessions.registerCreate')
      assert.ok(regCall)
      const handlerId = (regCall.params as Record<string, unknown>).handlerId as string

      // 模拟通知
      const notifHandler = mockClient.onNotificationHandlers.get('plugin.sessions.didCreate')
      assert.ok(notifHandler)
      notifHandler({ handlerId, session: { id: 's3', label: 'S3', cwd: '/tmp', status: 'active', createdAt: 500, lastActiveAt: 500 } })

      await new Promise(resolve => setTimeout(resolve, 10))
      assert.strictEqual(collected.length, 1)
      assert.strictEqual(collected[0].id, 's3')

      disposable.dispose()
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // Config API
  // ══════════════════════════════════════════════════════════════════════

  describe('Config API — registerConfigRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    const configStore = new Map<string, unknown>()

    beforeEach(() => {
      rpc = new PluginRpcServer()
      configStore.clear()
      configStore.set('theme', 'dark')
      configStore.set('timeout', 5000)

      const deps: ConfigHandlers = {
        get: async (_pluginId: string, key: string) => configStore.get(key),
        getAll: async (_pluginId: string) => {
          const result: Record<string, unknown> = {}
          for (const [k, v] of configStore) result[k] = v
          return result
        },
        set: async (_pluginId: string, key: string, value: unknown) => {
          configStore.set(key, value)
        },
      }

      registerConfigRpcHandlers(rpc, deps)
      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.config.get → returns stored value', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.config.get', params: { pluginId: 'p', key: 'theme' } })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'dark')
    })

    it('plugin.config.get → undefined for unknown key', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.config.get', params: { pluginId: 'p', key: 'missing' } })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, undefined)
    })

    it('plugin.config.getAll → returns all config', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.config.getAll', params: { pluginId: 'p' } })
      const resp = extractLastResponse(port)
      const all = resp.result as Record<string, unknown>
      assert.strictEqual(all.theme, 'dark')
      assert.strictEqual(all.timeout, 5000)
    })

    it('plugin.config.set → stores value', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.config.set', params: { pluginId: 'p', key: 'fontSize', value: 14 } })
      const resp = extractLastResponse(port)
      assert.ok('result' in resp, 'set should succeed')
      assert.strictEqual(configStore.get('fontSize'), 14)
    })

    it('plugin.config.set → overwrites existing value', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.config.set', params: { pluginId: 'p', key: 'theme', value: 'light' } })
      assert.strictEqual(configStore.get('theme'), 'light')
    })
  })

  describe('Config API — createConfigApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
    })

    it('get() sends plugin.config.get RPC', async () => {
      mockClient.requestResults.set('plugin.config.get', 'dark')
      const api = createConfigApi(mockClient, 'test-plugin')
      const val = await api.get('theme')
      assert.strictEqual(val, 'dark')
    })

    it('getAll() sends plugin.config.getAll RPC', async () => {
      mockClient.requestResults.set('plugin.config.getAll', { theme: 'dark', timeout: 5000 })
      const api = createConfigApi(mockClient, 'test-plugin')
      const all = await api.getAll()
      assert.strictEqual(all.theme, 'dark')
      assert.strictEqual(all.timeout, 5000)
    })

    it('set() sends plugin.config.set RPC', async () => {
      const api = createConfigApi(mockClient, 'test-plugin')
      await api.set('fontSize', 14)
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.config.set')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).key, 'fontSize')
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // SessionData API
  // ══════════════════════════════════════════════════════════════════════

  describe('SessionData API — registerSessionDataRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let store: SessionDataStore

    beforeEach(() => {
      rpc = new PluginRpcServer()
      store = new SessionDataStore('')

      const deps: SessionDataHandlers = {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      }

      registerSessionDataRpcHandlers(rpc, deps)
      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.sessionData.set → updates cache', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 1, method: 'plugin.sessionData.set',
        params: { sessionId: 's1', key: 'goal-state', value: { active: true } },
      })
      const resp = extractLastResponse(port)
      assert.ok('result' in resp)

      // 验证缓存
      assert.deepStrictEqual(store.get('s1', 'goal-state'), { active: true })
    })

    it('plugin.sessionData.get → reads from cache', async () => {
      // 预先填充缓存
      store.set('s1', 'goal-state', { active: true })

      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 2, method: 'plugin.sessionData.get',
        params: { sessionId: 's1', key: 'goal-state' },
      })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, { active: true })
    })

    it('plugin.sessionData.get → undefined for missing session', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 3, method: 'plugin.sessionData.get',
        params: { sessionId: 'nonexistent', key: 'goal-state' },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, undefined)
    })

    it('plugin.sessionData.get → undefined for missing key', async () => {
      store.set('s1', 'other', 'val')

      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 4, method: 'plugin.sessionData.get',
        params: { sessionId: 's1', key: 'missing' },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, undefined)
    })

    it('plugin.sessionData.delete → removes from cache', async () => {
      store.set('s1', 'goal-state', 'data')

      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 5, method: 'plugin.sessionData.delete',
        params: { sessionId: 's1', key: 'goal-state' },
      })
      assert.strictEqual(store.get('s1', 'goal-state'), undefined)
    })

    it('plugin.sessionData.keys → returns all keys', async () => {
      store.set('s1', 'k1', 'v1')
      store.set('s1', 'k2', 'v2')

      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 6, method: 'plugin.sessionData.keys',
        params: { sessionId: 's1' },
      })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, ['k1', 'k2'])
    })

    it('plugin.sessionData.keys → empty for missing session', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 7, method: 'plugin.sessionData.keys',
        params: { sessionId: 'nonexistent' },
      })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, [])
    })
  })

  describe('SessionData API — createSessionDataApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
    })

    it('set() sends plugin.sessionData.set RPC', async () => {
      const api = createSessionDataApi(mockClient, 'test-plugin')
      await api.set('s1', 'key1', { data: 42 })
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.sessionData.set')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).sessionId, 's1')
      assert.strictEqual((call.params as Record<string, unknown>).key, 'key1')
    })

    it('keys() sends plugin.sessionData.keys RPC', async () => {
      mockClient.requestResults.set('plugin.sessionData.keys', ['k1', 'k2'])
      const api = createSessionDataApi(mockClient, 'test-plugin')
      const keys = await api.keys('s1')
      assert.deepStrictEqual(keys, ['k1', 'k2'])
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // UI API
  // ══════════════════════════════════════════════════════════════════════

  describe('UI API — registerUiRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let lastNotify: { level: string; message: string } | null = null

    beforeEach(() => {
      rpc = new PluginRpcServer()
      lastNotify = null

      const deps: UiHandlers = {
        showSelect: async () => 'option2',
        showConfirm: async () => true,
        showInput: async () => 'user input',
        notify: async (_pluginId: string, level: string, message: string) => {
          lastNotify = { level, message }
        },
      }

      registerUiRpcHandlers(rpc, deps)
      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.ui.showSelect → returns chosen option', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 1, method: 'plugin.ui.showSelect',
        params: { pluginId: 'p', title: 'Pick', options: ['a', 'b', 'c'] },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'option2')
    })

    it('plugin.ui.showConfirm → returns boolean', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 2, method: 'plugin.ui.showConfirm',
        params: { pluginId: 'p', title: 'Confirm', message: 'Sure?' },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, true)
    })

    it('plugin.ui.showInput → returns input string', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 3, method: 'plugin.ui.showInput',
        params: { pluginId: 'p', title: 'Input', defaultValue: 'default' },
      })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'user input')
    })

    it('plugin.ui.notify → calls notify handler', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 4, method: 'plugin.ui.notify',
        params: { pluginId: 'p', level: 'info', message: 'test message' },
      })
      assert.strictEqual(lastNotify?.level, 'info')
      assert.strictEqual(lastNotify?.message, 'test message')
    })
  })

  describe('UI API — createUiApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
      mockClient.requestResults.set('plugin.ui.showConfirm', true)
      mockClient.requestResults.set('plugin.ui.showSelect', 'opt1')
      mockClient.requestResults.set('plugin.ui.showInput', 'hello')
    })

    it('showConfirm() sends plugin.ui.showConfirm RPC', async () => {
      const api = createUiApi(mockClient, 'test-plugin')
      const result = await api.showConfirm('Title', 'Message?')
      assert.strictEqual(result, true)
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.ui.showConfirm')
      assert.ok(call)
    })

    it('showSelect() returns option', async () => {
      const api = createUiApi(mockClient, 'test-plugin')
      const result = await api.showSelect('Pick', ['a', 'b'])
      assert.strictEqual(result, 'opt1')
    })

    it('showInput() returns input', async () => {
      const api = createUiApi(mockClient, 'test-plugin')
      const result = await api.showInput('Input')
      assert.strictEqual(result, 'hello')
    })

    it('notify() sends plugin.ui.notify RPC', async () => {
      const api = createUiApi(mockClient, 'test-plugin')
      await api.notify('info', 'hello')
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.ui.notify')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).level, 'info')
      assert.strictEqual((call.params as Record<string, unknown>).message, 'hello')
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // Agent API
  // ══════════════════════════════════════════════════════════════════════

  describe('Agent API — registerAgentRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let currentModel: string
    let currentThinking: string
    let activeTools: string[]

    beforeEach(() => {
      rpc = new PluginRpcServer()
      currentModel = 'gpt-4'
      currentThinking = 'high'
      activeTools = ['goal_manager', 'todo']

      registerAgentRpcHandlers(rpc, {
        getModel: () => currentModel,
        setModel: (model: string) => { currentModel = model; return '' },
        getThinkingLevel: () => currentThinking,
        setThinkingLevel: (level: string) => { currentThinking = level; return '' },
        getActiveTools: () => activeTools,
      })

      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.agent.getModel → returns current model', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.agent.getModel', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'gpt-4')
    })

    it('plugin.agent.setModel → updates model', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.agent.setModel', params: { pluginId: 'p', model: 'claude-3' } })
      assert.strictEqual(currentModel, 'claude-3')
    })

    it('plugin.agent.getThinkingLevel → returns level', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.agent.getThinkingLevel', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'high')
    })

    it('plugin.agent.setThinkingLevel → updates level', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.agent.setThinkingLevel', params: { pluginId: 'p', level: 'low' } })
      assert.strictEqual(currentThinking, 'low')
    })

    it('plugin.agent.getActiveTools → returns tool list', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.agent.getActiveTools', params: {} })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, ['goal_manager', 'todo'])
    })
  })

  describe('Agent API — createAgentApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
      mockClient.requestResults.set('plugin.agent.getModel', 'gpt-4')
      mockClient.requestResults.set('plugin.agent.getThinkingLevel', 'high')
      mockClient.requestResults.set('plugin.agent.getActiveTools', ['goal_manager'])
    })

    it('getModel() sends plugin.agent.getModel RPC', async () => {
      const api = createAgentApi(mockClient, 'test-plugin')
      const model = await api.getModel()
      assert.strictEqual(model, 'gpt-4')
    })

    it('setModel() sends plugin.agent.setModel RPC', async () => {
      const api = createAgentApi(mockClient, 'test-plugin')
      await api.setModel('claude-3')
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.agent.setModel')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).model, 'claude-3')
    })

    it('getActiveTools() returns tools', async () => {
      const api = createAgentApi(mockClient, 'test-plugin')
      const tools = await api.getActiveTools()
      assert.deepStrictEqual(tools, ['goal_manager'])
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // Workspace API
  // ══════════════════════════════════════════════════════════════════════

  describe('Workspace API — registerWorkspaceRpcHandlers', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>

    beforeEach(() => {
      rpc = new PluginRpcServer()

      registerWorkspaceRpcHandlers(rpc, {
        getRootPath: () => '/test/workspace',
        getName: () => 'workspace',
        findFiles: async (pattern: string) => {
          if (pattern === '*.ts') return ['a.ts', 'b.ts']
          return []
        },
      })

      port = createMockPort()
      rpc.registerWorker('w1', port)
    })

    it('plugin.workspace.rootPath → returns root path', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.workspace.rootPath', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, '/test/workspace')
    })

    it('plugin.workspace.name → returns workspace name', async () => {
      await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.workspace.name', params: {} })
      const resp = extractLastResponse(port)
      assert.strictEqual(resp.result, 'workspace')
    })

    it('plugin.workspace.findFiles → returns matched files', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 3, method: 'plugin.workspace.findFiles',
        params: { pattern: '*.ts' },
      })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, ['a.ts', 'b.ts'])
    })

    it('plugin.workspace.findFiles → empty array for no matches', async () => {
      await rpc.dispatch('w1', {
        jsonrpc: '2.0', id: 4, method: 'plugin.workspace.findFiles',
        params: { pattern: '*.js' },
      })
      const resp = extractLastResponse(port)
      assert.deepStrictEqual(resp.result, [])
    })
  })

  describe('Workspace API — createWorkspaceApi (Worker side)', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
      mockClient.requestResults.set('plugin.workspace.rootPath', '/test/workspace')
      mockClient.requestResults.set('plugin.workspace.name', 'workspace')
    })

    it('rootPath and name are cached from RPC on creation', async () => {
      const api = createWorkspaceApi(mockClient, 'test-plugin')
      // 等待 RPC 缓存
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.strictEqual(api.rootPath, '/test/workspace')
      assert.strictEqual(api.name, 'workspace')
    })

    it('findFiles() sends plugin.workspace.findFiles RPC', async () => {
      mockClient.requestResults.set('plugin.workspace.findFiles', ['a.ts', 'b.ts'])
      const api = createWorkspaceApi(mockClient, 'test-plugin')
      const files = await api.findFiles('*.ts')
      assert.deepStrictEqual(files, ['a.ts', 'b.ts'])
      const call = mockClient.requestCalls.find(c => c.method === 'plugin.workspace.findFiles')
      assert.ok(call)
      assert.strictEqual((call.params as Record<string, unknown>).pattern, '*.ts')
    })
  })
});

// ════════════════ 来源: plugin-injection-guard.test.ts ════════════════
describe('plugin-injection-guard', () => {
  /**
   * SEC-A5 插件路径注入防御测试
   *
   * 背景：sessionData 与 PluginStorage 的持久化路径此前由插件 RPC 传入的
   * sessionId / pluginId 直接 join 拼出（`${sessionId}.json`、`plugins/<pluginId>/…`），
   * API 入口 `params.sessionId as string` 零校验，`../../` 可越出数据目录
   * 读/写/删任意 .json。
   *
   * 本文件两层验证（均用真实临时目录验证文件系统副作用，不 mock fs）：
   *   1. RPC 入口层：session-data-api / storage-api 的全部方法拒绝遍历/非字符串
   *      标识符，返回 INVALID_SESSION_ID / INVALID_KEY / INVALID_PLUGIN_ID
   *      结构化错误（message 含白名单 regex 指导），且数据目录外零文件副作用。
   *   2. store 深度防御层：绕过 RPC 入口直接调 SessionDataStore / PluginStorage，
   *      path.resolve 防御同样拒绝越出数据目录的路径拼接。
   */



  /** 白名单 regex（与 validation.ts / store 层错误 message 中的字面量一致） */
  const SAFE_KEY_REGEX_LITERAL = '/^[A-Za-z0-9._-]{1,128}$/'

  /** 捕获 dispatched RPC response 的 mock Worker port */
  function createCapturingPort() {
    const sent: unknown[] = []
    return { port: { postMessage: (msg: unknown) => sent.push(msg) }, sent }
  }

  /** 建一个隔离的真实临时目录：root/config 作为数据目录（configDir），攻击目标即 root 本层 */
  function makeTempRoot(): { root: string; configDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'plugin-injection-guard-'))
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    return {
      root,
      configDir,
      cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    }
  }

  /** 构造 RPC 测试台：rpcServer + capturing port，返回 dispatch helper */
  function makeRpcHarness() {
    const rpcServer = new PluginRpcServer()
    const capturing = createCapturingPort()
    rpcServer.registerWorker('worker-1', capturing.port)
    let nextId = 1
    const dispatch = async (method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
      capturing.sent.length = 0
      await rpcServer.dispatch('worker-1', { jsonrpc: '2.0', id: nextId++, method, params })
      return (capturing.sent[0] as { response: RpcResponse }).response
    }
    return { rpcServer, dispatch }
  }

  function errorOf(resp: RpcResponse): { code?: unknown; message?: string } {
    expect(resp).toHaveProperty('error')
    return (resp as { error: { code?: unknown; message?: string } }).error
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. RPC 入口层 — sessionData
  // ══════════════════════════════════════════════════════════════════

  describe('SEC-A5 sessionData RPC entry validation', () => {
    it('SEC-A5: sessionData.set with sessionId "../../evil" returns INVALID_SESSION_ID with regex guidance and writes nothing outside the data dir', async () => {
      const { root, configDir, cleanup } = makeTempRoot()
      const store = new SessionDataStore(configDir)
      const { rpcServer, dispatch } = makeRpcHarness()
      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })

      // '../../evil' 被同域校验拒（INVALID_SESSION_ID）——深度防御层不得放行遍历载荷
      const resp = await dispatch('plugin.sessionData.set', {
        sessionId: '../../evil', key: 'k', value: 'v',
      })
      const err = errorOf(resp)
      expect(err.code).toBe('INVALID_SESSION_ID')
      expect(err.message).toContain('sessionId')
      expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)

      // 文件系统副作用：数据目录外无新文件，session 存储树根本未创建
      expect(existsSync(join(root, 'evil.json'))).toBe(false)
      expect(existsSync(getSessionStoreDir(configDir))).toBe(false)

      store.dispose()
      cleanup()
    })

    it('SEC-A5: all four sessionData RPC methods reject traversal sessionId', async () => {
      const store = new SessionDataStore('')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })

      const cases: Array<[string, Record<string, unknown>]> = [
        ['plugin.sessionData.get', { sessionId: '../..', key: 'k' }],
        ['plugin.sessionData.set', { sessionId: '../..', key: 'k', value: 'v' }],
        ['plugin.sessionData.delete', { sessionId: '../..', key: 'k' }],
        ['plugin.sessionData.keys', { sessionId: '../..' }],
      ]
      for (const [method, params] of cases) {
        const err = errorOf(await dispatch(method, params))
        expect(err.code, `${method} should reject with INVALID_SESSION_ID`).toBe('INVALID_SESSION_ID')
        expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
      }
      store.dispose()
    })

    it('SEC-A5: sessionData rejects traversal key "../../evil" with INVALID_KEY', async () => {
      const store = new SessionDataStore('')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })

      const resp = await dispatch('plugin.sessionData.set', {
        sessionId: 's1', key: '../../evil', value: 'v',
      })
      const err = errorOf(resp)
      expect(err.code).toBe('INVALID_KEY')
      expect(err.message).toContain('key')
      expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
      store.dispose()
    })

    it('SEC-A5: sessionData rejects non-string sessionId (number) with INVALID_SESSION_ID', async () => {
      const store = new SessionDataStore('')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })

      const resp = await dispatch('plugin.sessionData.keys', { sessionId: 12345 })
      const err = errorOf(resp)
      expect(err.code).toBe('INVALID_SESSION_ID')
      expect(err.message).toContain('sessionId')
      store.dispose()
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // 2. RPC 入口层 — storage（pluginId 注入）
  // ══════════════════════════════════════════════════════════════════

  describe('SEC-A5 storage RPC entry validation', () => {
    it('SEC-A5: plugin.storage.global.set with pluginId "../.." returns INVALID_PLUGIN_ID and writes nothing outside the plugins dir', async () => {
      const { root, configDir, cleanup } = makeTempRoot()
      const storage = new PluginStorage()
      storage.init(configDir, '/test/project')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

      // '../..' → <configDir>/plugins/../.. → resolve → <root>；无防御时 globalState.json 会写到 <root>/
      const resp = await dispatch('plugin.storage.global.set', {
        pluginId: '../..', key: 'k', value: 'v',
      })
      const err = errorOf(resp)
      expect(err.code).toBe('INVALID_PLUGIN_ID')
      expect(err.message).toContain('pluginId')
      expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)

      // 文件系统副作用：<root> 下无逃逸文件；plugins 目录由 init() 合法创建，
      // 但内部应无任何落盘（攻击请求未建立分区）
      expect(existsSync(join(root, 'globalState.json'))).toBe(false)
      expect(readdirSync(join(root, 'config', 'plugins'))).toEqual([])

      storage.dispose()
      cleanup()
    })

    it('SEC-A5: all eight storage RPC methods reject traversal pluginId', async () => {
      const { configDir, cleanup } = makeTempRoot()
      const storage = new PluginStorage()
      storage.init(configDir, '/test/project')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

      for (const scope of ['global', 'workspace'] as const) {
        const cases: Array<[string, Record<string, unknown>]> = [
          [`plugin.storage.${scope}.get`, { pluginId: '../../evil' }],
          [`plugin.storage.${scope}.set`, { pluginId: '../../evil', key: 'k', value: 'v' }],
          [`plugin.storage.${scope}.delete`, { pluginId: '../../evil', key: 'k' }],
          [`plugin.storage.${scope}.keys`, { pluginId: '../../evil' }],
        ]
        for (const [method, params] of cases) {
          const err = errorOf(await dispatch(method, params))
          expect(err.code, `${method} should reject with INVALID_PLUGIN_ID`).toBe('INVALID_PLUGIN_ID')
          expect(err.message).toContain(SAFE_KEY_REGEX_LITERAL)
        }
      }
      storage.dispose()
      cleanup()
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // 3. 合法标识符全通过（白名单不误伤）
  // ══════════════════════════════════════════════════════════════════

  describe('SEC-A5 legal identifiers pass end-to-end', () => {
    it('SEC-A5: legal keys containing ".", "_", "-" roundtrip through sessionData RPC', async () => {
      const { configDir, cleanup } = makeTempRoot()
      const store = new SessionDataStore(configDir)
      const { rpcServer, dispatch } = makeRpcHarness()
      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })

      const sessionId = 's-1.a_b'
      const key = 'k.2-x_y'
      const setResp = await dispatch('plugin.sessionData.set', { sessionId, key, value: 'v' })
      expect((setResp as { error?: unknown }).error).toBeUndefined()

      const getResp = await dispatch('plugin.sessionData.get', { sessionId, key })
      expect((getResp as { result?: unknown }).result).toBe('v')

      const keysResp = await dispatch('plugin.sessionData.keys', { sessionId })
      expect((keysResp as { result?: string[] }).result).toEqual([key])

      // 合法 sessionId 正常落盘（session 存储树域 4 分区文件）
      store.flushSession(sessionId)
      expect(existsSync(getSessionPluginDataPath(sessionId, configDir))).toBe(true)

      store.dispose()
      cleanup()
    })

    it('SEC-A5: legal pluginId containing ".", "_", "-" roundtrips through storage RPC (global + workspace)', async () => {
      const { configDir, cleanup } = makeTempRoot()
      const storage = new PluginStorage()
      storage.init(configDir, '/test/project')
      const { rpcServer, dispatch } = makeRpcHarness()
      registerStorageRpcHandlers(rpcServer, storageHandlersFrom(storage))

      const pluginId = 'test-plugin_1.0'
      const setResp = await dispatch('plugin.storage.global.set', { pluginId, key: 'name', value: 'hello' })
      expect((setResp as { error?: unknown }).error).toBeUndefined()

      const getResp = await dispatch('plugin.storage.global.get', { pluginId, key: 'name' })
      expect((getResp as { result?: unknown }).result).toBe('hello')

      const wsResp = await dispatch('plugin.storage.workspace.set', { pluginId, key: 'w', value: 1 })
      expect((wsResp as { error?: unknown }).error).toBeUndefined()

      storage.flushAll()
      const pluginDir = join(configDir, 'plugins', pluginId)
      expect(existsSync(join(pluginDir, 'globalState.json'))).toBe(true)
      const files = readdirSync(pluginDir)
      expect(files.some(f => f.startsWith('workspace-') && f.endsWith('.json'))).toBe(true)

      storage.dispose()
      cleanup()
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // 4. store 层 resolve 深度防御（绕过 RPC 入口直接调用）
  // ══════════════════════════════════════════════════════════════════

  describe('SEC-A5 store-layer resolve defense (bypassing entry layer)', () => {
    it('SEC-A5: SessionDataStore directly rejects traversal sessionId on get/set/keys/clearSession', async () => {
      const { root, configDir, cleanup } = makeTempRoot()
      const store = new SessionDataStore(configDir)

      // load 路径（get/keys/首次 set 都经 loadPartitionSync）：
      // resolve 防御抛 INVALID_SESSION_ID，且不被 loadPartitionSync 的 ENOENT catch 吞掉
      for (const fn of [
        () => store.get('../../evil', 'k'),
        () => store.set('../../evil', 'k', 'v'),
        () => store.keys('../../evil'),
      ]) {
        try {
          fn()
          expect.unreachable('should have thrown')
        } catch (err) {
          expect((err as { code?: unknown }).code).toBe('INVALID_SESSION_ID')
          // store 层校验域 = isPiSessionId（与 shared 推导函数族同域，比入口层窄集更严）
          expect((err as Error).message).toContain('pi session id domain')
        }
      }
      // clearSession 已 async（B5 trash 软删除）——防御拒绝转为 rejection（仍先于任何状态变更）
      await expect(store.clearSession('../../evil')).rejects.toMatchObject({ code: 'INVALID_SESSION_ID' })

      // persist 路径与 load 共用 resolveSessionFilePath；即使构造出 dirty 分区
      // （正常途径不可能——set 先被 load 拦截），flush 也无法把文件写到目录外。
      // 此处断言：所有尝试后数据目录外零文件、session-data 目录未创建。
      store.flushAll()
      expect(existsSync(join(root, 'evil.json'))).toBe(false)
      expect(existsSync(join(configDir, 'session-data'))).toBe(false)

      store.dispose()
      cleanup()
    })

    it('SEC-A5: PluginStorage directly rejects traversal pluginId on get/set', () => {
      const { root, configDir, cleanup } = makeTempRoot()
      const storage = new PluginStorage()
      storage.init(configDir, '/test/project')

      // load 路径（get 触发 lazy load；set 首次访问分区同样触发）：
      // getFilePath 的 resolve 防御抛 INVALID_PLUGIN_ID
      for (const fn of [
        () => storage.get('../../evil', 'k'),
        () => storage.set('../../evil', 'k', 'v'),
        () => storage.keys('../../evil'),
      ]) {
        try {
          fn()
          expect.unreachable('should have thrown')
        } catch (err) {
          expect((err as { code?: unknown }).code).toBe('INVALID_PLUGIN_ID')
          expect((err as Error).message).toContain(SAFE_KEY_REGEX_LITERAL)
        }
      }

      // persist 路径与 load 共用 getFilePath；尝试任何路径后无逃逸文件
      storage.flushAll()
      expect(existsSync(join(root, 'globalState.json'))).toBe(false)

      storage.dispose()
      cleanup()
    })
  })
});

// ════════════════ 来源: plugin-session-data-cache.test.ts ════════════════
describe('plugin-session-data-cache', () => {
  /**
   * SessionData Local Cache + Flush — TDD tests for BG2 Task 4 (P0-1 C6 重写)
   *
   * 经 SessionDataStore 的公共 KV API（get/set/delete/keys/flush）验证：
   *   - 容量上限（per-session，默认 10MB）
   *   - flush 语义（dirty → 持久化 → 可重载）
   *   - 定时 flush（5s interval）
   *   - clearSession 清理
   * 内部 dirty/cache/size 由 WriteBackCache 封装，测试不再直接触碰内部 Map。
   */



  const mkdtempP = promisify(mkdtemp)
  const rmP = promisify(rm)

  const MAX_TEST_SIZE = 200 // Small limit for capacity test

  /** Build a mock RPC port that captures dispatched responses */
  function createCapturingPort() {
    const sent: unknown[] = []
    return {
      port: { postMessage: (msg: unknown) => sent.push(msg) },
      sent,
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SessionData RPC Handlers — cache, capacity, keys
  // ══════════════════════════════════════════════════════════════════

  describe('SessionData RPC Handlers (Cache + Capacity)', () => {
    let rpcServer: PluginRpcServer
    let store: SessionDataStore
    let capturingPort: ReturnType<typeof createCapturingPort>
    let nextId = 1

    beforeEach(() => {
      rpcServer = new PluginRpcServer()
      store = new SessionDataStore('', MAX_TEST_SIZE)
      capturingPort = createCapturingPort()
      rpcServer.registerWorker('worker-1', capturingPort.port)
      nextId = 1

      registerSessionDataRpcHandlers(rpcServer, {
        get: (sid, key) => store.get(sid, key),
        set: (sid, key, val) => store.set(sid, key, val),
        delete: (sid, key) => store.delete(sid, key),
        keys: (sid) => store.keys(sid),
      })
    })

    /** Dispatch an RPC request and return the response */
    async function dispatch(
      method: string,
      params: Record<string, unknown>,
    ): Promise<RpcResponse> {
      capturingPort.sent.length = 0
      const id = nextId++
      await rpcServer.dispatch('worker-1', {
        jsonrpc: '2.0',
        id,
        method,
        params: { pluginId: 'test-plugin', ...params },
      })
      const msg = capturingPort.sent[0] as { response: RpcResponse }
      return msg.response
    }

    // ── TC-4-01: Cache write + read ──────────────────────────────
    it('cache write + read', async () => {
      const setResp = await dispatch('plugin.sessionData.set', {
        sessionId: 's1', key: 'k1', value: 'hello',
      })
      expect((setResp as { result?: unknown }).result).toBeUndefined()

      const getResp = await dispatch('plugin.sessionData.get', {
        sessionId: 's1', key: 'k1',
      })
      expect((getResp as { result: unknown }).result).toBe('hello')

      const missResp = await dispatch('plugin.sessionData.get', {
        sessionId: 's1', key: 'nope',
      })
      expect((missResp as { result?: unknown }).result).toBeUndefined()
    })

    // ── TC-4-03: Cache works without bridge ─────────────────────
    it('cache works without bridge (no flush needed for read)', async () => {
      await dispatch('plugin.sessionData.set', {
        sessionId: 's1', key: 'k1', value: 'v1',
      })
      expect(store.get('s1', 'k1')).toBe('v1')
    })

    // ── TC-4-04: Capacity limit ──────────────────────────────────
    it('capacity limit: over maxSize → STORAGE_FULL error', async () => {
      const okResp = await dispatch('plugin.sessionData.set', {
        sessionId: 's1', key: 'k1', value: 'a'.repeat(50),
      })
      expect((okResp as { result: unknown }).result).toBeUndefined()

      const overResp = await dispatch('plugin.sessionData.set', {
        sessionId: 's1', key: 'k2', value: 'b'.repeat(MAX_TEST_SIZE),
      })
      expect((overResp as { error?: { code: number } }).error).toBeDefined()
      expect((overResp as { error?: { code: number } }).error!.code).toBe(PluginRpcErrorCodes.STORAGE_FULL)
    })

    // ── TC-4-07: keys returns correct list ────────────────────────
    it('keys returns correct list', async () => {
      await dispatch('plugin.sessionData.set', { sessionId: 's1', key: 'k1', value: 'v1' })
      await dispatch('plugin.sessionData.set', { sessionId: 's1', key: 'k2', value: 'v2' })

      const resp = await dispatch('plugin.sessionData.keys', { sessionId: 's1' })
      const keys = (resp as { result?: string[] }).result as string[]
      expect(keys.sort()).toEqual(['k1', 'k2'])
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // SessionData Flush + Lifecycle — SessionDataStore direct
  // ══════════════════════════════════════════════════════════════════

  describe('SessionDataStore Flush + Lifecycle', () => {
    let tmpDir: string
    let store: SessionDataStore

    /** 插件 KV 分区文件路径（session 存储树域 4，与被测模块内部推导同源）。 */
    function dataPathOf(sid: string): string {
      return getSessionPluginDataPath(sid, tmpDir)
    }

    beforeEach(async () => {
      tmpDir = await mkdtempP(join(tmpdir(), 'session-data-store-test-'))
      store = new SessionDataStore(tmpDir)
    })

    afterEach(async () => {
      store.dispose()
      await rmP(tmpDir, { recursive: true, force: true })
    })

    // ── flush persists dirty data to disk ────────────────────────
    it('flush persists dirty data to disk', () => {
      store.set('s1', 'k1', 'v1')
      store.flushSession('s1')
      const filePath = dataPathOf('s1')
      expect(existsSync(filePath)).toBe(true)
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(raw).toEqual({ k1: 'v1' })
    })

    // ── flush clears dirty (idempotent re-flush) ─────────────────
    it('flush is idempotent (re-flush of clean session is no-op)', () => {
      store.set('s1', 'k1', 'v1')
      store.flushSession('s1')
      // 第二次 flush 不应报错
      expect(() => store.flushSession('s1')).not.toThrow()
    })

    // ── delete removes key ───────────────────────────────────────
    it('delete removes key from cache', () => {
      store.set('s1', 'k1', 'v1')
      store.delete('s1', 'k1')
      expect(store.get('s1', 'k1')).toBeUndefined()
    })

    // ── flushAll persists all dirty sessions ─────────────────────
    it('flushAll persists all dirty sessions', () => {
      store.set('s1', 'k1', 'v1')
      store.set('s2', 'k2', 'v2')
      store.flushAll()
      expect(existsSync(dataPathOf('s1'))).toBe(true)
      expect(existsSync(dataPathOf('s2'))).toBe(true)
    })

    // ── corrupt file quarantined (D1c parity), not silently overwritten ──
    it('corrupt partition file on load → quarantined to .corrupt-<ts> copy, set/flush rebuilds clean', () => {
      const filePath = dataPathOf('s-broken')
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, '{"broken": tr', 'utf-8') // 半截 JSON

      // lazy loadPartition：损坏 → quarantine rename + 空 Map 降级
      expect(store.get('s-broken', 'anyKey')).toBeUndefined()

      const dirEntries = readdirSync(dirname(filePath))
      expect(dirEntries).not.toContain('plugin-data.json')
      const quarantineCopy = dirEntries.find((n) => /^plugin-data\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{9}Z$/.test(n))
      expect(quarantineCopy).toBeDefined()
      expect(readFileSync(join(dirname(filePath), quarantineCopy!), 'utf-8')).toBe('{"broken": tr')

      // set + flush：原路径重建干净文件（quarantine 后 flush 走 ENOENT 放行）
      store.set('s-broken', 'fresh', 'v')
      store.flushSession('s-broken')
      expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ fresh: 'v' })
    })

    // ── persisted data reloadable via new store ──────────────────
    it('persisted data is reloadable via restoreFromDisk', () => {
      store.set('s1', 'persistent', 'val-99')
      store.flushSession('s1')
      const store2 = new SessionDataStore(tmpDir)
      store2.restoreFromDisk()
      expect(store2.get('s1', 'persistent')).toBe('val-99')
    })

    // ── clearSession removes cache + disk ────────────────────────
    it('clearSession removes cache and disk file', async () => {
      const trashCalls: string[] = []
      store = new SessionDataStore(tmpDir, undefined, undefined, async (p) => {
        trashCalls.push(p)
        rmSync(p, { force: true })
      })
      store.set('s1', 'k1', 'v1')
      store.flushSession('s1')
      expect(existsSync(dataPathOf('s1'))).toBe(true)
      // B5：clearSession 已 async（磁盘删除走 ITrash port 软删除，mock 同步移除文件）
      await store.clearSession('s1')
      expect(store.get('s1', 'k1')).toBeUndefined()
      expect(existsSync(dataPathOf('s1'))).toBe(false)
      expect(trashCalls).toEqual([dataPathOf('s1')])
    })

    // ── debounce flush 落盘 ────────────────────────────────────
    it('per-write debounce flush persists within 500ms', async () => {
      vi.useFakeTimers()
      // sid 唯一化：上一用例 clearSession 的 tombstone 是模块级共享态，复用 's1' 会被
      // B5 迟到写检查丢弃（恰是该机制的正向证明，但与本用例目标无关）
      store.set('s1-debounce', 'k1', 'v1')
      // debounce flush at 500ms
      await vi.advanceTimersByTimeAsync(600)
      expect(existsSync(dataPathOf('s1-debounce'))).toBe(true)
      vi.useRealTimers()
    })

    // ── data not flushed immediately (debounce window) ──────────
    it('data not flushed immediately after set (within debounce window)', async () => {
      vi.useFakeTimers()
      store.set('s1', 'k1', 'v1')
      await vi.advanceTimersByTimeAsync(100) // well within 500ms debounce
      expect(existsSync(dataPathOf('s1'))).toBe(false)
      vi.useRealTimers()
    })

    // ── dispose clears pending debounce without flush ───────────
    it('dispose stops debounce timer: pending write never lands', async () => {
      vi.useFakeTimers()
      store.set('s1', 'k1', 'v1')
      store.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(existsSync(dataPathOf('s1'))).toBe(false)
      vi.useRealTimers()
    })
  })
});

// ════════════════ 来源: session-api-activate.test.ts ════════════════
describe('session-api-activate', () => {
  /**
   * 会话激活订阅族单测（plugin-header-action-modal-points AP-4，u5b 六点扩表）
   *
   * 覆盖：
   * - registerActivate/unregisterActivate RPC handler → SessionEventDispatch 'activate' 表
   * - didActivate 定向投递（payload {handlerId, session}；create/destroy/activate 三表按
   *   handlerId 隔离，投递只命中 activate 表）
   * - clearForPlugin 覆盖 activateHandlers（crash/disable/uninstall 三路共用同一条清理
   *   代码路径——u5a/u2c 已把三路调用点接到 SessionEventDispatch.clearForPlugin，本单测
   *   锁「清理后不再投递」的语义）+ clearAll 同覆盖
   * - Worker 侧 createSessionApi.onDidActivateSession：注册 RPC 携带 (pluginId, handlerId)、
   *   didActivate 通知派发到 handler、dispose 发送 unregisterActivate
   *
   * 运行：cd packages/runtime && npx vitest run test/session-api-activate.test.ts
   */


  function createMockPort(): WorkerPort & { messages: unknown[] } {
    const messages: unknown[] = []
    return {
      messages,
      postMessage(msg: unknown) {
        messages.push(msg)
      },
    }
  }

  function lastResponse(port: ReturnType<typeof createMockPort>): { id?: number; result?: unknown; error?: { code?: unknown; message?: string } } {
    const last = port.messages[port.messages.length - 1] as { response: { id?: number; result?: unknown; error?: { code?: unknown; message?: string } } } | undefined
    return last?.response ?? {}
  }

  async function dispatch(
    rpc: PluginRpcServer,
    port: ReturnType<typeof createMockPort>,
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ id?: number; result?: Record<string, unknown>; error?: { code?: unknown; message?: string } }> {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id, method, params })
    return lastResponse(port) as never
  }

  const SESSION: SessionInfo = { id: 's1', label: 'L', cwd: '/tmp', status: 'active', createdAt: 0, lastActiveAt: 0 }

  describe('activate 订阅族（主线程 handler + SessionEventDispatch 六点扩表）', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let dispatchTable: SessionEventDispatch

    beforeEach(() => {
      rpc = new PluginRpcServer()
      port = createMockPort()
      rpc.registerWorker('w1', port)
      dispatchTable = new SessionEventDispatch(rpc)
      const handlers: SessionHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage: async () => ({ blocked: false }),
        sessionEvents: dispatchTable,
      }
      registerSessionRpcHandlers(rpc, handlers)
    })

    it('registerActivate → {registered:true}，didActivate 定向投递到该 handlerId', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, {
        pluginId: 'scheduler-manager', handlerId: 'session_activate_scheduler-manager_1',
      })
      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ registered: true })

      dispatchTable.didActivate(SESSION)

      const sent = port.messages.filter(m => (m as { notification?: { method: string } }).notification)
      const last = sent[sent.length - 1] as { notification: { method: string; params: { handlerId: string; session: SessionInfo } } }
      expect(last.notification.method).toBe('plugin.sessions.didActivate')
      expect(last.notification.params).toEqual({ handlerId: 'session_activate_scheduler-manager_1', session: SESSION })
      expect(dispatchTable.size).toBe(1)
    })

    it('三表按 handlerId 隔离：activate 投递不惊动 create/destroy 订阅', async () => {
      await dispatch(rpc, port, 1, 'plugin.sessions.registerCreate', { pluginId: 'p1', handlerId: 'h_create' })
      await dispatch(rpc, port, 2, 'plugin.sessions.registerDestroy', { pluginId: 'p1', handlerId: 'h_destroy' })
      await dispatch(rpc, port, 3, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h_activate' })
      expect(dispatchTable.size).toBe(3)

      port.messages.length = 0
      dispatchTable.didActivate(SESSION)

      const notified = port.messages.map(m => (m as { notification: { params: { handlerId: string } } }).notification.params.handlerId)
      expect(notified).toEqual(['h_activate'])
    })

    it('unregisterActivate → 注销后不再投递（幂等）', async () => {
      await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h1' })
      await dispatch(rpc, port, 2, SESSION_ACTIVATE_METHODS.unregister, { handlerId: 'h1' })
      expect(dispatchTable.size).toBe(0)

      port.messages.length = 0
      dispatchTable.didActivate(SESSION)
      expect(port.messages).toHaveLength(0)

      // 再注销一次（幂等）
      const resp = await dispatch(rpc, port, 3, SESSION_ACTIVATE_METHODS.unregister, { handlerId: 'h1' })
      expect(resp.result).toEqual({ unregistered: true })
    })

    it('handlerId 畸形 → INVALID_HANDLER_ID（防毒化投递目标，与 create/destroy 同检查）', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: '../poison' })
      expect(resp.error?.code).toBe('INVALID_HANDLER_ID')
      expect(dispatchTable.size).toBe(0)
    })

    it('clearForPlugin 覆盖 activate 表（crash/disable/uninstall 三路共用）：清理后不再投递，他插件不受扰', async () => {
      await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'gone', handlerId: 'h_gone' })
      await dispatch(rpc, port, 2, SESSION_ACTIVATE_METHODS.register, { pluginId: 'stay', handlerId: 'h_stay' })

      dispatchTable.clearForPlugin('gone')
      expect(dispatchTable.size).toBe(1)

      port.messages.length = 0
      dispatchTable.didActivate(SESSION)
      const notified = port.messages.map(m => (m as { notification: { params: { handlerId: string } } }).notification.params.handlerId)
      expect(notified).toEqual(['h_stay'])
    })

    it('clearAll 覆盖 activate 表（runtime 关停）', async () => {
      await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h1' })
      dispatchTable.clearAll()
      expect(dispatchTable.size).toBe(0)
      port.messages.length = 0
      dispatchTable.didActivate(SESSION)
      expect(port.messages).toHaveLength(0)
    })
  })

  // ── Worker 侧 createSessionApi.onDidActivateSession ─────────────────────────

  interface MockRpcClient {
    requestCalls: Array<{ method: string; params: Record<string, unknown> }>
    requestFailures: Map<string, unknown>
    onNotificationHandlers: Map<string, (params: unknown) => void>
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>
    onNotification: (method: string, handler: (params: unknown) => void) => () => void
    notify: (method: string, params: Record<string, unknown>) => void
  }

  function createMockRpcClient(): MockRpcClient {
    const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestFailures = new Map<string, unknown>()
    const onNotificationHandlers = new Map<string, (params: unknown) => void>()
    return {
      requestCalls,
      requestFailures,
      onNotificationHandlers,
      request: (method: string, params: Record<string, unknown>) => {
        requestCalls.push({ method, params })
        if (requestFailures.has(method)) return Promise.reject(requestFailures.get(method))
        return Promise.resolve(undefined)
      },
      onNotification: (method: string, handler: (params: unknown) => void) => {
        onNotificationHandlers.set(method, handler)
        return () => { onNotificationHandlers.delete(method) }
      },
      notify: () => {},
    } as unknown as MockRpcClient
  }

  describe('createSessionApi.onDidActivateSession（Worker 侧代理）', () => {
    it('注册 RPC 携带 (pluginId, handlerId)，didActivate 通知派发到 handler，dispose 发 unregister', async () => {
      const mockClient = createMockRpcClient()
      const api = createSessionApi(mockClient as never, 'test-plugin')
      const received: SessionInfo[] = []
      const disposable = api.onDidActivateSession(session => received.push(session))

      const call = mockClient.requestCalls.find(c => c.method === SESSION_ACTIVATE_METHODS.register)
      expect(call).toBeDefined()
      expect(call?.params.pluginId).toBe('test-plugin')
      const handlerId = call?.params.handlerId as string
      expect(handlerId).toMatch(/^session_activate_test-plugin_\d+$/)

      const notify = mockClient.onNotificationHandlers.get('plugin.sessions.didActivate')
      expect(notify).toBeDefined()
      notify?.({ handlerId, session: SESSION })
      notify?.({ handlerId: 'session_activate_other_99', session: SESSION })
      expect(received).toEqual([SESSION])

      disposable.dispose()
      const unregister = mockClient.requestCalls.find(c => c.method === SESSION_ACTIVATE_METHODS.unregister)
      expect(unregister?.params.handlerId).toBe(handlerId)
    })

    it('注册 RPC 被拒时记日志不中断（onDidCreateSession 同款处置）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const mockClient = createMockRpcClient()
        mockClient.requestFailures.set(SESSION_ACTIVATE_METHODS.register, new Error('not wired'))
        const api = createSessionApi(mockClient as never, 'test-plugin')
        const disposable = api.onDidActivateSession(() => {})
        await Promise.resolve()
        await Promise.resolve()
        expect(errSpy).toHaveBeenCalledWith('[session-api] registerActivate failed:', expect.stringContaining('not wired'))
        disposable.dispose()
      } finally {
        errSpy.mockRestore()
      }
    })
  })
});

// ════════════════ 来源: session-api-read.test.ts ════════════════
describe('session-api-read', () => {
  /**
   * Session API 读侧（AP-4，U2）单测
   *
   * 覆盖 plugin.sessions.readEntries / getCommands / registerEntryInvalidation /
   * unregisterEntryInvalidation 的主线程 handler（customType 服务端过滤派生视图、
   * sinceEntryId 游标透传、live only 前提 SESSION_NOT_ACTIVE、订阅注册表转调与
   * 拒绝回执、纯查询直连映射收窄、装配缺口 SESSION_READ_NOT_WIRED）与 Worker 侧
   * createSessionApi 代理（readEntries/getCommands RPC 形状、onEntriesInvalidated
   * 注册 → 定向通知派发 → dispose 注销）。
   *
   * 运行命令: cd packages/runtime && npx vitest run test/session-api-read.test.ts
   */




  // ── Helper: mock WorkerPort / 响应提取（plugin-api-extended 同模式）──────────

  function createMockPort(): WorkerPort & { messages: unknown[] } {
    const messages: unknown[] = []
    return {
      messages,
      postMessage(msg: unknown) {
        messages.push(msg)
      },
    }
  }

  interface LastResponse { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    id?: number
    result?: unknown
    error?: { code?: unknown; message?: string }
  }

  function lastResponse(port: ReturnType<typeof createMockPort>): LastResponse {
    const last = port.messages[port.messages.length - 1] as { response: LastResponse } | undefined
    return last?.response ?? {}
  }

  /** dispatch 一条 RPC 并返回响应（含 error.code 断言用的 error 段） */
  async function dispatch(
    rpc: PluginRpcServer,
    port: ReturnType<typeof createMockPort>,
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<LastResponse> {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id, method, params })
    return lastResponse(port)
  }

  // ── Helper: 假 pi client + IProcessManager ──────────────────────────────────

  interface FakeClientOverrides { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    exited?: boolean
    entries?: unknown[]
    leafId?: string | null
    commands?: PiCommandInfo[]
  }

  /** 假 IPiEngine：只实现读侧消费的 getEntries/getCommands/exited（结构化最小子集） */
  function createFakeClient(overrides: FakeClientOverrides = {}): IPiEngine {
    return {
      exited: overrides.exited ?? false,
      getEntries: vi.fn(async () => ({
        data: { entries: overrides.entries ?? [], leafId: overrides.leafId ?? null },
      })),
      getCommands: vi.fn(async () => overrides.commands ?? []),
    } as unknown as IPiEngine
  }

  function createFakePm(clients: Map<string, IPiEngine>): IProcessManager {
    return {
      getClient: (sessionId: string) => clients.get(sessionId),
    } as unknown as IProcessManager
  }

  const TARGET_CUSTOM_TYPE = 'pi-scheduler:task'

  /** 一条目标域 custom entry（形状对齐 pi get_entries 产物的契约字段 + 噪声字段） */
  function customEntry(id: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      timestamp: `2026-09-19T00:00:0${id.length}Z`,
      type: 'custom',
      customType: TARGET_CUSTOM_TYPE,
      parentId: 'e-parent',
      ...extra,
      data,
    }
  }

  // ── 主线程 handler ──────────────────────────────────────────────────────────

  describe('session read API — registerSessionRpcHandlers（AP-4 读侧）', () => {
    let rpc: PluginRpcServer
    let port: ReturnType<typeof createMockPort>
    let clients: Map<string, IPiEngine>
    let fakeClient: IPiEngine
    let dispatchRegistry: EntryInvalidationDispatch
    let registeredHandlers: SessionHandlers

    beforeEach(() => {
      rpc = new PluginRpcServer()
      port = createMockPort()
      rpc.registerWorker('w1', port)
      clients = new Map()
      fakeClient = createFakeClient()
      clients.set('s1', fakeClient)
      dispatchRegistry = new EntryInvalidationDispatch({ sessionExists: (id) => id === 's1' })
      registeredHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage: async () => ({ blocked: false }),
        sessionEvents: new SessionEventDispatch(rpc),
        sessionRead: {
          pm: createFakePm(clients),
          getSessionSummary: (id: string) =>
            id === 's1' ? { sessionFile: '/data/sessions/s1.jsonl' } : undefined,
          entryInvalidation: dispatchRegistry,
        },
      }
      registerSessionRpcHandlers(rpc, registeredHandlers)
    })

    describe('plugin.sessions.readEntries', () => {
      it('按 customType 精确过滤 + 映射五字段形状（type/customType 保留、data 原样、噪声字段剥除）', async () => {
        const taskData = { op: 'toggle', taskId: 'a1b2c3d4', enabled: false }
        fakeClient = createFakeClient({
          // 线性链式树（真实 pi 全量批形态：每条 entry 挂前一条下，parent 链完整）——
          // readEntries 派生视图前有活跃路径过滤（leafId 回溯），fixture 必须让目标条目在
          // leaf 链上（e-parent 悬空的断链全量批在真实数据中不存在）
          entries: [
            { id: 'e-parent', timestamp: 't', type: 'message', data: { text: 'root' } },
            { id: 'e-msg', timestamp: 't', type: 'message', data: { text: 'hello' }, parentId: 'e-parent' },
            customEntry('e-task-1', taskData, { parentId: 'e-msg' }),
            customEntry('e-other', { op: 'x' }, { customType: 'pi-subagent:record', parentId: 'e-task-1' }),
          ],
          leafId: 'e-other',
        })
        clients.set('s1', fakeClient)

        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })

        expect(resp.error).toBeUndefined()
        const result = resp.result as { sessionFile?: string; entries: Array<Record<string, unknown>>; leafEntryId?: string }
        // 只剩目标 customType 条目（message entry 与其他域 custom entry 均被过滤）
        expect(result.entries.length).toBe(1)
        const entry = result.entries[0]
        expect(entry.id).toBe('e-task-1')
        expect(entry.type).toBe('custom')
        expect(entry.customType).toBe(TARGET_CUSTOM_TYPE)
        // data 原样透传（引用相等——域语义插件解，不改写）
        expect(entry.data).toBe(taskData)
        // 派生视图不含 pi 树结构噪声（parentId 等不出 runtime）
        expect('parentId' in entry).toBe(false)
        // 信封字段：sessionFile（折叠过滤必需）+ leafEntryId（下次 sinceEntryId）
        expect(result.sessionFile).toBe('/data/sessions/s1.jsonl')
        expect(result.leafEntryId).toBe('e-other')
      })

      it('sinceEntryId 透传给 client.getEntries（增量游标）；缺省时不传', async () => {
        await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor-9',
        })
        expect(vi.mocked(fakeClient.getEntries)).toHaveBeenCalledWith('e-cursor-9')

        await dispatch(rpc, port, 2, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })
        expect(vi.mocked(fakeClient.getEntries)).toHaveBeenLastCalledWith(undefined)
      })

      it('无 client → SESSION_NOT_ACTIVE（live only：不调 ensureActive 不 spawn 进程）', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 'missing-session', customType: TARGET_CUSTOM_TYPE,
        })
        expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
        expect(resp.error?.message).toContain('missing-session')
      })

      it('client 已 exited → SESSION_NOT_ACTIVE', async () => {
        clients.set('s1', createFakeClient({ exited: true }))
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })
        expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
      })

      it('畸形条目丢弃（非对象 / id 或 timestamp 非 string）不进派生视图', async () => {
        fakeClient = createFakeClient({
          entries: [
            'not-an-object',
            customEntry('e-ok', { op: 'x' }),
            { id: 42, timestamp: 't', type: 'custom', customType: TARGET_CUSTOM_TYPE, data: {} },
            { id: 'e-nots', type: 'custom', customType: TARGET_CUSTOM_TYPE, data: {} },
          ],
        })
        clients.set('s1', fakeClient)
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })
        const result = resp.result as { entries: Array<{ id: string }> }
        expect(result.entries.map(e => e.id)).toEqual(['e-ok'])
      })

      it('leafId 为 null（pi 无叶子）时信封省略 leafEntryId', async () => {
        fakeClient = createFakeClient({ entries: [], leafId: null })
        clients.set('s1', fakeClient)
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })
        const result = resp.result as { leafEntryId?: string }
        expect('leafEntryId' in result).toBe(false)
      })

      it('sessionId 畸形 → INVALID_SESSION_ID（窄校验先例行径）', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: '../etc', customType: TARGET_CUSTOM_TYPE,
        })
        expect(resp.error?.code).toBe('INVALID_SESSION_ID')
      })
    })

    describe('plugin.sessions.getCommands（纯查询直连）', () => {
      it('映射收窄到 {name, description, source}——sourceInfo 等宿主内部元信息不出面', async () => {
        clients.set('s1', createFakeClient({
          commands: [
            { name: 'schedule', description: '定时任务', source: 'extension', sourceInfo: { path: '/ext/scheduler.ts', source: 'extension' } },
            { name: 'compact', source: 'pi' },
          ],
        }))
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.getCommands, { sessionId: 's1' })
        expect(resp.error).toBeUndefined()
        const commands = resp.result as Array<Record<string, unknown>>
        expect(commands).toEqual([
          { name: 'schedule', description: '定时任务', source: 'extension' },
          { name: 'compact', description: undefined, source: 'pi' },
        ])
        // 关键负断言：派生视图对象上不存在 sourceInfo 键（不是 undefined 而是剥除）
        expect('sourceInfo' in commands[0]).toBe(false)
      })

      it('无 client → SESSION_NOT_ACTIVE', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.getCommands, { sessionId: 'missing-session' })
        expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
      })
    })

    describe('plugin.sessions.registerEntryInvalidation / unregisterEntryInvalidation', () => {
      it('注册成功：转调注册表（workerId 取 ctx、pluginId/sessionId/customType 入表）+ {registered:true} 回执', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
          pluginId: 'scheduler-manager',
          sessionId: 's1',
          customType: TARGET_CUSTOM_TYPE,
          handlerId: 'entry_invalidate_scheduler-manager_1',
        })
        expect(resp.error).toBeUndefined()
        expect(resp.result).toEqual({ registered: true })
        // 注册表真实收到条目：双键派发命中（u2c 注册表行为核验）
        const deliveries = dispatchRegistry.dispatch('s1', TARGET_CUSTOM_TYPE)
        expect(deliveries).toEqual([{ workerId: 'w1', handlerId: 'entry_invalidate_scheduler-manager_1' }])
      })

      it('sessionId 不在会话列表 → 注册表拒绝并映射 SESSION_NOT_ACTIVE 错误回执（防无界注册表）', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
          pluginId: 'scheduler-manager',
          sessionId: 'ghost-session',
          customType: TARGET_CUSTOM_TYPE,
          handlerId: 'entry_invalidate_scheduler-manager_2',
        })
        expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
        expect(resp.error?.message).toContain('ghost-session')
        expect(dispatchRegistry.dispatch('ghost-session', TARGET_CUSTOM_TYPE)).toEqual([])
      })

      it('handlerId 畸形 → INVALID_HANDLER_ID（不进注册表，防毒化投递目标）', async () => {
        const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
          pluginId: 'scheduler-manager',
          sessionId: 's1',
          customType: TARGET_CUSTOM_TYPE,
          handlerId: '../poison',
        })
        expect(resp.error?.code).toBe('INVALID_HANDLER_ID')
        expect(dispatchRegistry.size).toBe(0)
      })

      it('注销转调注册表（幂等，不存在的 handlerId 也回 {unregistered:true}）', async () => {
        await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
          pluginId: 'scheduler-manager', sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
          handlerId: 'entry_invalidate_scheduler-manager_3',
        })
        expect(dispatchRegistry.size).toBe(1)
        const resp = await dispatch(rpc, port, 2, SESSION_READ_METHODS.unregisterEntryInvalidation, {
          handlerId: 'entry_invalidate_scheduler-manager_3',
        })
        expect(resp.result).toEqual({ unregistered: true })
        expect(dispatchRegistry.size).toBe(0)
        // 再注销一次（幂等）
        const resp2 = await dispatch(rpc, port, 3, SESSION_READ_METHODS.unregisterEntryInvalidation, {
          handlerId: 'entry_invalidate_scheduler-manager_3',
        })
        expect(resp2.result).toEqual({ unregistered: true })
      })
    })

    describe('sessionRead 缺失（装配缺口显式报错）', () => {
      it('四个读方法各抛 SESSION_READ_NOT_WIRED，不伪装成会话状态错误', async () => {
        const bare: SessionHandlers = {
          listSessions: () => [],
          getSession: () => undefined,
          getActiveSession: () => undefined,
          sendMessage: async () => ({ blocked: false }),
          sessionEvents: new SessionEventDispatch(rpc),
        }
        const bareRpc = new PluginRpcServer()
        const barePort = createMockPort()
        bareRpc.registerWorker('w1', barePort)
        registerSessionRpcHandlers(bareRpc, bare)

        const readResp = await dispatch(bareRpc, barePort, 1, SESSION_READ_METHODS.readEntries, {
          sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        })
        expect(readResp.error?.code).toBe(SESSION_READ_NOT_WIRED)
        expect(readResp.error?.message).toContain('wiring gap')

        const commandsResp = await dispatch(bareRpc, barePort, 2, SESSION_READ_METHODS.getCommands, { sessionId: 's1' })
        expect(commandsResp.error?.code).toBe(SESSION_READ_NOT_WIRED)

        const registerResp = await dispatch(bareRpc, barePort, 3, SESSION_READ_METHODS.registerEntryInvalidation, {
          pluginId: 'p', sessionId: 's1', customType: 'x', handlerId: 'h1',
        })
        expect(registerResp.error?.code).toBe(SESSION_READ_NOT_WIRED)

        const unregisterResp = await dispatch(bareRpc, barePort, 4, SESSION_READ_METHODS.unregisterEntryInvalidation, {
          handlerId: 'h1',
        })
        expect(unregisterResp.error?.code).toBe(SESSION_READ_NOT_WIRED)
      })
    })
  })

  // ── Worker 侧 createSessionApi 代理 ─────────────────────────────────────────

  interface MockRpcClient {
    requestCalls: Array<{ method: string; params: Record<string, unknown> }>
    requestResults: Map<string, unknown>
    requestFailures: Map<string, unknown>
    onNotificationHandlers: Map<string, (params: unknown) => void>
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>
    onNotification: (method: string, handler: (params: unknown) => void) => () => void
    notify: (method: string, params: Record<string, unknown>) => void
  }

  function createMockRpcClient(): MockRpcClient & PluginRpcClient {
    const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const requestResults = new Map<string, unknown>()
    const requestFailures = new Map<string, unknown>()
    const onNotificationHandlers = new Map<string, (params: unknown) => void>()
    return {
      requestCalls,
      requestResults,
      requestFailures,
      onNotificationHandlers,
      request: (method: string, params: Record<string, unknown>) => {
        requestCalls.push({ method, params })
        if (requestFailures.has(method)) return Promise.reject(requestFailures.get(method))
        const result = requestResults.get(method)
        return Promise.resolve(result !== undefined ? result : undefined)
      },
      onNotification: (method: string, handler: (params: unknown) => void) => {
        onNotificationHandlers.set(method, handler)
        return () => { onNotificationHandlers.delete(method) }
      },
      notify: () => {},
    } as unknown as MockRpcClient & PluginRpcClient
  }

  describe('session read API — createSessionApi（Worker 侧代理）', () => {
    let mockClient: MockRpcClient & PluginRpcClient

    beforeEach(() => {
      mockClient = createMockRpcClient()
    })

    it('readEntries() 发送 plugin.sessions.readEntries RPC（sessionId/customType/sinceEntryId 形状）', async () => {
      const envelope = { sessionFile: '/data/sessions/s1.jsonl', entries: [], leafEntryId: 'e-leaf' }
      mockClient.requestResults.set(SESSION_READ_METHODS.readEntries, envelope)
      const api = createSessionApi(mockClient, 'test-plugin')
      const result = await api.readEntries('s1', { customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor' })
      expect(result).toEqual(envelope)
      const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.readEntries)
      expect(call?.params).toEqual({
        pluginId: 'test-plugin', sessionId: 's1',
        customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor',
      })
    })

    it('getCommands() 发送 plugin.sessions.getCommands RPC 并回传结果', async () => {
      mockClient.requestResults.set(SESSION_READ_METHODS.getCommands, [
        { name: 'schedule', description: 'x', source: 'extension' },
      ])
      const api = createSessionApi(mockClient, 'test-plugin')
      const result = await api.getCommands('s1')
      expect(result).toEqual([{ name: 'schedule', description: 'x', source: 'extension' }])
      const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.getCommands)
      expect(call?.params).toEqual({ pluginId: 'test-plugin', sessionId: 's1' })
    })

    it('onEntriesInvalidated：注册 RPC 携带 (pluginId, sessionId, customType, handlerId)，定向通知派发到 handler', async () => {
      const api = createSessionApi(mockClient, 'test-plugin')
      const received: Array<[string, string]> = []
      const disposable = api.onEntriesInvalidated('s1', TARGET_CUSTOM_TYPE, (sid, ct) => received.push([sid, ct]))

      const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.registerEntryInvalidation)
      expect(call).toBeDefined()
      const handlerId = call?.params.handlerId as string
      expect(call?.params.sessionId).toBe('s1')
      expect(call?.params.customType).toBe(TARGET_CUSTOM_TYPE)
      expect(call?.params.pluginId).toBe('test-plugin')

      // 主线程定向通知（ENTRY_INVALIDATION_NOTIFY_METHOD，payload {handlerId, sessionId, customType}）命中
      const notify = mockClient.onNotificationHandlers.get(ENTRY_INVALIDATION_NOTIFY_METHOD)
      expect(notify).toBeDefined()
      notify?.({ handlerId, sessionId: 's1', customType: TARGET_CUSTOM_TYPE })
      expect(received).toEqual([['s1', TARGET_CUSTOM_TYPE]])

      // 未知 handlerId 不派发（Worker 侧 dispatchHandler 命中语义）
      notify?.({ handlerId: 'entry_invalidate_other_99', sessionId: 's1', customType: TARGET_CUSTOM_TYPE })
      expect(received.length).toBe(1)

      disposable.dispose()
      const unregister = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.unregisterEntryInvalidation)
      expect(unregister?.params.handlerId).toBe(handlerId)
    })

    it('onEntriesInvalidated 注册被拒（SESSION_NOT_ACTIVE 回执）时记日志不中断', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        mockClient.requestFailures.set(SESSION_READ_METHODS.registerEntryInvalidation, new Error('not found'))
        const api = createSessionApi(mockClient, 'test-plugin')
        const disposable = api.onEntriesInvalidated('ghost', TARGET_CUSTOM_TYPE, () => {})
        // 微任务排空后 .catch 分支执行：日志留痕 + dispose 链路不受影响
        await Promise.resolve()
        await Promise.resolve()
        expect(errSpy).toHaveBeenCalledWith('[session-api] registerEntryInvalidation failed:', expect.stringContaining('not found'))
        disposable.dispose()
        const unregister = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.unregisterEntryInvalidation)
        expect(unregister).toBeDefined()
      } finally {
        errSpy.mockRestore()
      }
    })
  })
});
