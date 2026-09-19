/**
 * plugin-entry-invalidation-dispatch.test.ts — Entry 失效信号订阅注册表单测
 * （plugin headerAction/modal 点位 AP-4「订阅注册表」，U2）
 *
 * 覆盖：
 * - 注册表（纯类）：(sessionId, customType) 双匹配命中 / 会话与类型双维隔离 /
 *   注册时校验 sessionId 存在（不存在拒绝）/ unregister 幂等 / clearForPlugin 与
 *   clearForSession 两维清理且幂等 / 重复注册同一 handlerId 幂等覆盖（先例语义）
 * - notifyEntryInvalidation（PluginService 面）：有订阅者 → rpcServer.notify 定向
 *   投递正确 (workerId, 方法名, payload)；无订阅者 → 零 notify（零开销路径）
 * - 四路清理接线：crash 路（registerWorkerCallbacks + host.onCrash 触发）与
 *   session-destroyed 路（setOnSessionDestroyed 注册的回调触发，追加式语义不挤占
 *   didDestroy）行为级；disable / uninstall 路（togglePlugin(false) /
 *   uninstallPlugin 内部调用点）源码级守卫——两路编排依赖 activator/host 全套，
 *   行为由注册表 clearForPlugin 单测覆盖，接线存在性由源码断言锁定
 * - 组合根两路注入：onRecordEntriesInvalidated 的 invalidateRecordEntries 腿保留 +
 *   pluginService.notifyEntryInvalidation 腿存在（源码级守卫，同
 *   index-composition-root-wiring.test.ts 范式）
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-entry-invalidation-dispatch.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { EntryInvalidationDispatch, ENTRY_INVALIDATION_NOTIFY_METHOD } from '../src/services/plugin-service/plugin-entry-invalidation-dispatch.js'
import type { EntryInvalidationTarget } from '../src/services/plugin-service/plugin-entry-invalidation-dispatch.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'

// ══════════════════════════════════════════════════════════════════
// 共用测试基建（contract-hardening.test.ts 同款）
// ══════════════════════════════════════════════════════════════════

function createMockPort(): WorkerPort & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg as Record<string, unknown>)
    },
  }
}

function createMockBroker(): IMessageBroker {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}

function notificationsOf(port: { messages: Array<Record<string, unknown>> }): Array<{ method: string; params: Record<string, unknown> }> {
  return port.messages
    .filter(m => m.type === 'rpc' && (m as { notification?: unknown }).notification)
    .map(m => {
      const n = (m as { notification: { method: string; params: Record<string, unknown> } }).notification
      return { method: n.method, params: n.params }
    })
}

/** 可变会话列表（模拟 listPersistedSessions 扁平 id 集） */
function makeSessionRegistry(initial: string[]): { exists: (id: string) => boolean; add(id: string): void } {
  const ids = new Set(initial)
  return { exists: id => ids.has(id), add: id => void ids.add(id) }
}

// ══════════════════════════════════════════════════════════════════
// 注册表（纯类）
// ══════════════════════════════════════════════════════════════════

describe('EntryInvalidationDispatch 注册表', () => {
  let sessions: ReturnType<typeof makeSessionRegistry>
  let table: EntryInvalidationDispatch

  beforeEach(() => {
    sessions = makeSessionRegistry(['s1', 's2'])
    table = new EntryInvalidationDispatch({ sessionExists: sessions.exists })
  })

  function reg(handlerId: string, workerId: string, pluginId: string, sessionId: string, customType: string): boolean {
    const target: EntryInvalidationTarget = { workerId, pluginId, sessionId, customType }
    return table.register(handlerId, target)
  }

  it('双匹配命中：dispatch 按 (sessionId, customType) 返回投递意图（workerId + handlerId）', () => {
    expect(reg('h1', 'wA', 'pA', 's1', 'task')).toBe(true)

    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'wA', handlerId: 'h1' }])
  })

  it('会话隔离：会话 A 的事件不唤醒只在会话 B 订阅的插件', () => {
    reg('hB', 'wB', 'pB', 's2', 'task')

    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB' }])
  })

  it('类型隔离：同会话不同 customType 不互相命中', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')

    expect(table.dispatch('s1', 'other-type')).toEqual([])
  })

  it('注册校验：sessionId 不存在于当前会话列表 → 拒绝（返回 false 且不产生条目）', () => {
    expect(reg('h1', 'wA', 'pA', 'ghost', 'task')).toBe(false)
    expect(table.size).toBe(0)
    expect(table.dispatch('ghost', 'task')).toEqual([])
  })

  it('重复注册同一 handlerId 幂等覆盖：旧位置摘除、只在新位置命中', () => {
    expect(reg('h1', 'wA', 'pA', 's1', 'task')).toBe(true)
    expect(reg('h1', 'wB', 'pB', 's1', 'plan')).toBe(true) // 同 handlerId 换 customType + worker

    expect(table.dispatch('s1', 'task')).toEqual([]) // 旧位置不再命中
    expect(table.dispatch('s1', 'plan')).toEqual([{ workerId: 'wB', handlerId: 'h1' }])
    expect(table.size).toBe(1)
  })

  it('unregister 后不再命中（幂等：重复注销 no-op）', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')

    table.unregister('h1')
    expect(table.dispatch('s1', 'task')).toEqual([])

    table.unregister('h1') // 幂等
    expect(table.size).toBe(0)
  })

  it('clearForPlugin：清该插件全部订阅、其他插件保留（幂等）', () => {
    reg('hA1', 'wA', 'pA', 's1', 'task')
    reg('hA2', 'wA', 'pA', 's2', 'plan')
    reg('hB1', 'wB', 'pB', 's1', 'task')

    table.clearForPlugin('pA')
    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB1' }])

    table.clearForPlugin('pA') // 幂等
    expect(table.size).toBe(1)
  })

  it('clearForSession：清该会话全部订阅、其他会话保留（幂等）', () => {
    reg('hA1', 'wA', 'pA', 's1', 'task')
    reg('hA2', 'wA', 'pA', 's1', 'plan')
    reg('hB1', 'wB', 'pB', 's2', 'task')

    table.clearForSession('s1')
    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s1', 'plan')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'wB', handlerId: 'hB1' }])

    table.clearForSession('s1') // 幂等
    expect(table.size).toBe(1)
  })

  it('无订阅者 dispatch 返回空数组（零开销路径：不抛错、零命中）', () => {
    expect(table.dispatch('s1', 'task')).toEqual([])
  })

  it('会话销毁后重注册：clearForSession 后同 id 会话复活可重新订阅（B5 复活路径对偶）', () => {
    reg('h1', 'wA', 'pA', 's1', 'task')
    table.clearForSession('s1')

    sessions.add('s3')
    expect(reg('h1', 'wA', 'pA', 's3', 'task')).toBe(true)
    expect(table.dispatch('s3', 'task')).toEqual([{ workerId: 'wA', handlerId: 'h1' }])
  })
})

// ══════════════════════════════════════════════════════════════════
// notifyEntryInvalidation（PluginService 面，真实 rpcServer + mock Worker port）
// ══════════════════════════════════════════════════════════════════

describe('PluginService.notifyEntryInvalidation 定向投递', () => {
  let tmpDir: string
  let service: PluginService
  let table: EntryInvalidationDispatch
  let portA: ReturnType<typeof createMockPort>
  let portB: ReturnType<typeof createMockPort>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'entry-inval-'))
    const registryMock = {
      getDescriptor: vi.fn(() => ({ pluginId: 'pA', pluginPath: '/tmp/pA' })),
      getAllDescriptors: () => [],
    }
    // 会话存在性谓词走真实注入面（listPersistedSessions 扁平 id 集）——s1/s2 可注册
    const sessionServiceMock = {
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    service = new PluginService(registryMock as never, createMockBroker(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    portA = createMockPort()
    portB = createMockPort()
    rpcServer.registerWorker('wA', portA)
    rpcServer.registerWorker('wB', portB)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('有订阅者：notify 以正确 (workerId, 方法名, payload) 定向投递到订阅 Worker', () => {
    table.register('h1', { workerId: 'wA', pluginId: 'pA', sessionId: 's1', customType: 'task' })

    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(1)
    expect(notificationsOf(portA)[0]!.method).toBe(ENTRY_INVALIDATION_NOTIFY_METHOD)
    expect(notificationsOf(portA)[0]!.method).toBe('plugin.sessions.entriesInvalidated')
    expect(notificationsOf(portA)[0]!.params).toEqual({ handlerId: 'h1', sessionId: 's1', customType: 'task' })
    expect(notificationsOf(portB)).toHaveLength(0) // 非订阅 Worker 不收（定向，非广播）
  })

  it('无订阅者：零 notify 调用（零开销路径）', () => {
    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(0)
    expect(notificationsOf(portB)).toHaveLength(0)
  })

  it('同 (sessionId, customType) 多订阅者全部命中；事件维度错配不投递', () => {
    table.register('h1', { workerId: 'wA', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('h2', { workerId: 'wB', pluginId: 'pB', sessionId: 's1', customType: 'task' })

    service.notifyEntryInvalidation('s1', 'task')

    expect(notificationsOf(portA)).toHaveLength(1)
    expect(notificationsOf(portB)).toHaveLength(1)

    service.notifyEntryInvalidation('s1', 'other-type')
    expect(notificationsOf(portA)).toHaveLength(1) // 不增长
    expect(notificationsOf(portB)).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════════════
// 四路清理接线（crash / session-destroyed 行为级；disable / uninstall 源码级）
// ══════════════════════════════════════════════════════════════════

describe('Entry 失效订阅四路清理接线', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'entry-inval-wire-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('crash 路：Worker 崩溃回调触发后，崩溃插件的订阅被清、其他插件订阅保留', () => {
    const registryMock = {
      getDescriptor: vi.fn(() => undefined),
      getAllDescriptors: () => [],
    }
    const sessionServiceMock = {
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    const service = new PluginService(registryMock as never, createMockBroker(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    table.register('hA', { workerId: 'w1', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('hB', { workerId: 'w2', pluginId: 'pB', sessionId: 's1', customType: 'task' })

    ;(service as unknown as { registerWorkerCallbacks(): void }).registerWorkerCallbacks()
    const host = (service as unknown as { host: { onCrash?: (workerId: string, pluginIds: string[], error: unknown) => void } }).host
    expect(host.onCrash).toBeTypeOf('function')
    host.onCrash!('w1', ['pA'], new Error('worker died'))

    expect(table.dispatch('s1', 'task')).toEqual([{ workerId: 'w2', handlerId: 'hB' }])
  })

  it('session-destroyed 路：销毁回调触发后该会话订阅被清，且 didDestroy 投递并存（追加式不挤占）', () => {
    const setOnSessionDestroyed = vi.fn()
    const sessionServiceMock = {
      setSendMessageHook: vi.fn(),
      setOnSessionCreated: vi.fn(),
      setOnSessionDestroyed,
      listPersistedSessions: () => [{ sessions: [{ id: 's1' }, { id: 's2' }] }],
    }
    const registryMock = {
      getDescriptor: vi.fn(() => undefined),
      getAllDescriptors: () => [],
    }
    const service = new PluginService(registryMock as never, createMockBroker(), {
      configDir: tmpDir,
      sessionService: sessionServiceMock as never,
    })
    const table = (service as unknown as { entryInvalidationDispatch: EntryInvalidationDispatch }).entryInvalidationDispatch
    table.register('h1', { workerId: 'w1', pluginId: 'pA', sessionId: 's1', customType: 'task' })
    table.register('h2', { workerId: 'w2', pluginId: 'pB', sessionId: 's2', customType: 'task' })

    ;(service as unknown as { registerSendMessageHook(): void }).registerSendMessageHook()
    expect(setOnSessionDestroyed).toHaveBeenCalledTimes(1)
    const destroyedHandler = setOnSessionDestroyed.mock.calls[0]![0] as (summary: { id: string }) => void
    destroyedHandler({ id: 's1' })

    expect(table.dispatch('s1', 'task')).toEqual([])
    expect(table.dispatch('s2', 'task')).toEqual([{ workerId: 'w2', handlerId: 'h2' }])
  })

  it('disable / uninstall 路：togglePlugin(false) 与 uninstallPlugin 各接一处 clearForPlugin（源码级守卫）', () => {
    const source = readFileSync(new URL('../src/services/plugin-service/plugin-service.ts', import.meta.url), 'utf8')

    // crash / disable / uninstall 三路各恰好一处接线（crash 路另有行为级用例交叉验证）
    expect(source.match(/this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)/g)).toHaveLength(3)
    // disable 路：togglePlugin(false) 分支内（紧随 sessionEventDispatch 清理、await syncToolsToBridge 之前）
    expect(source).toMatch(/this\.sessionEventDispatch\.clearForPlugin\(pluginId\)\n\s+this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)\n\s+await this\.syncToolsToBridge\(\)/)
    // uninstall 路：uninstallPlugin 体内（紧随 sessionEventDispatch 清理、status bar 清理之前）
    expect(source).toMatch(/this\.sessionEventDispatch\.clearForPlugin\(pluginId\)\n\s+this\.entryInvalidationDispatch\.clearForPlugin\(pluginId\)\n\n\s+\/\/ 清理 status bar items/)
    // session-destroyed 路：与 didDestroy 同址（追加式回调体内）
    expect(source).toMatch(/didDestroy\(sessionInfoFromSummary\(summary\)\)\n\s+[\s\S]*?clearForSession\(summary\.id\)/)
  })
})

// ══════════════════════════════════════════════════════════════════
// 组合根两路注入（源码级守卫，index-composition-root-wiring 同范式）
// ══════════════════════════════════════════════════════════════════

describe('组合根 onRecordEntriesInvalidated 两路注入', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('session 腿保留：invalidateRecordEntries 仍在注入体内（record 三族行为不受扰）', () => {
    expect(source).toContain('sessionService.invalidateRecordEntries(sid, customType)')
  })

  it('plugin 腿接入：notifyEntryInvalidation 在同一回调体内（两路都收到回调）', () => {
    expect(source).toMatch(/onRecordEntriesInvalidated: \(sid, customType\) => \{\s+sessionService\.invalidateRecordEntries\(sid, customType\)\s+[\s\S]*?pluginService\.notifyEntryInvalidation\(sid, customType\)/s)
  })
})
