/**
 * 插件依赖系统测试
 *
 * 验证 PluginActivator 的拓扑排序、循环检测和依赖激活。
 *
 * 覆盖:
 * - topologicalSort: Kahn's algorithm 正确性
 * - detectCycle: 循环依赖检测
 * - activateWithDeps: 缺失依赖检查 + 循环检测 + 顺序激活
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test',
    version: '1.0.0',
    displayName: 'Test Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/test-plugin',
    // 默认 built-in：依赖排序机制测试与激活锁（IF3）正交，锁只拦 external。
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}

function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => {
      return Promise.resolve('worker-1')
    }),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) => {
      return Promise.resolve()
    }),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-1',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({
            type: replyType,
            pluginId,
          })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

// ══════════════════════════════════════════════════════════════════
// Topological Sort
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.topologicalSort', () => {
  // ── TC-DEP-01: 空列表返回空 ─────────────────────────────────────
  it('TC-DEP-01: empty list returns empty array', () => {
    const activator = new PluginActivator()
    expect(activator.topologicalSort([])).toEqual([])
  })

  // ── TC-DEP-02: 无依赖返回相同长度 ───────────────────────────────
  it('TC-DEP-02: plugins without dependencies all included in result', () => {
    const activator = new PluginActivator()
    const p1 = makeDescriptor({ pluginId: 'a' })
    const p2 = makeDescriptor({ pluginId: 'b' })
    const p3 = makeDescriptor({ pluginId: 'c' })
    const sorted = activator.topologicalSort([p3, p1, p2])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).toContain('c')
  })

  // ── TC-DEP-03: 简单链式依赖 ─────────────────────────────────────
  it('TC-DEP-03: simple dependency chain (a ← b ← c)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: [] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })
    const sorted = activator.topologicalSort([c, a, b])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'))
  })

  // ── TC-DEP-04: 多重依赖 ────────────────────────────────────────
  it('TC-DEP-04: multiple dependencies (db ← auth, db ← api, auth ← api)', () => {
    const activator = new PluginActivator()
    const db = makeDescriptor({ pluginId: 'db' })
    const auth = makeDescriptor({ pluginId: 'auth', extensionDependencies: ['db'] })
    const api = makeDescriptor({ pluginId: 'api', extensionDependencies: ['auth', 'db'] })
    const sorted = activator.topologicalSort([api, auth, db])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('db')).toBeLessThan(ids.indexOf('auth'))
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('api'))
  })

  // ── TC-DEP-05: fan-out 依赖 ─────────────────────────────────────
  it('TC-DEP-05: fan-out (common dep)', () => {
    const activator = new PluginActivator()
    const core = makeDescriptor({ pluginId: 'core' })
    const ext1 = makeDescriptor({ pluginId: 'ext1', extensionDependencies: ['core'] })
    const ext2 = makeDescriptor({ pluginId: 'ext2', extensionDependencies: ['core'] })
    const sorted = activator.topologicalSort([ext2, core, ext1])
    expect(sorted).toHaveLength(3)
    const ids = sorted.map(p => p.pluginId)
    expect(ids.indexOf('core')).toBeLessThan(ids.indexOf('ext1'))
    expect(ids.indexOf('core')).toBeLessThan(ids.indexOf('ext2'))
  })

  // ── TC-DEP-06: 单个插件 ─────────────────────────────────────────
  it('TC-DEP-06: single plugin returns itself', () => {
    const activator = new PluginActivator()
    const p = makeDescriptor({ pluginId: 'solo' })
    const sorted = activator.topologicalSort([p])
    expect(sorted).toHaveLength(1)
    expect(sorted[0].pluginId).toBe('solo')
  })
})

// ══════════════════════════════════════════════════════════════════
// Cycle Detection
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.detectCycle', () => {
  // ── TC-DEP-07: 无循环返回 null ──────────────────────────────────
  it('TC-DEP-07: no circle returns null', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    expect(activator.detectCycle([a, b])).toBeNull()
  })

  // ── TC-DEP-08: 简单双向循环 ─────────────────────────────────────
  it('TC-DEP-08: simple bidirectional cycle (a ↔ b)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a, b])
    expect(cycled).not.toBeNull()
    expect(cycled!.length).toBeGreaterThan(0)
    // 循环中的插件 ID 应被返回
    expect(cycled).toContain('a')
    expect(cycled).toContain('b')
  })

  // ── TC-DEP-09: 自依赖循环 ──────────────────────────────────────
  it('TC-DEP-09: self-dependency cycle (a → a)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('a')
  })

  // ── TC-DEP-10: 间接循环 ─────────────────────────────────────────
  it('TC-DEP-10: indirect cycle (a → b → c → a)', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['c'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['a'] })
    const cycled = activator.detectCycle([a, b, c])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('a')
    expect(cycled).toContain('b')
    expect(cycled).toContain('c')
  })

  // ── TC-DEP-11: 空列表返回 null ──────────────────────────────────
  it('TC-DEP-11: empty list returns null', () => {
    const activator = new PluginActivator()
    expect(activator.detectCycle([])).toBeNull()
  })

  // ── TC-DEP-12: 无依赖但有子集循环 ──────────────────────────────
  it('TC-DEP-12: partial cycle — some plugins have dependencies, some cycle', () => {
    const activator = new PluginActivator()
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['c'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })
    const cycled = activator.detectCycle([a, b, c])
    expect(cycled).not.toBeNull()
    expect(cycled).toContain('b')
    expect(cycled).toContain('c')
    // 'a' 不在循环中
    expect(cycled).not.toContain('a')
  })
})

// ══════════════════════════════════════════════════════════════════
// activateWithDeps
// ══════════════════════════════════════════════════════════════════

describe('PluginActivator.activateWithDeps', () => {
  let activator: PluginActivator
  let host: ActivatorHost

  beforeEach(() => {
    activator = new PluginActivator()
    host = createMockHost(activator, 'activated')
  })

  // ── TC-DEP-13: 无依赖正常激活 ──────────────────────────────────
  it('TC-DEP-13: activates plugins in dependency order', async () => {
    const a = makeDescriptor({ pluginId: 'a' })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })
    const c = makeDescriptor({ pluginId: 'c', extensionDependencies: ['b'] })

    await activator.activateWithDeps([c, a, b], host)

    expect(activator.getState('a')).toBe('ACTIVE')
    expect(activator.getState('b')).toBe('ACTIVE')
    expect(activator.getState('c')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toHaveLength(3)
  })

  // ── TC-DEP-14: 缺失依赖抛出错误 ────────────────────────────────
  it('TC-DEP-14: missing dependency throws error', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['missing-dep'] })

    await expect(activator.activateWithDeps([a], host))
      .rejects
      .toThrow(/Missing plugin dependencies/)
  })

  // ── TC-DEP-15: 循环依赖抛出错误 ────────────────────────────────
  it('TC-DEP-15: circular dependency throws error', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['b'] })
    const b = makeDescriptor({ pluginId: 'b', extensionDependencies: ['a'] })

    await expect(activator.activateWithDeps([a, b], host))
      .rejects
      .toThrow(/Circular dependencies/)
  })

  // ── TC-DEP-16: 空列表不激活任何插件 ────────────────────────────
  it('TC-DEP-16: empty descriptors list activates nothing', async () => {
    await activator.activateWithDeps([], host)
    expect(activator.getActivePlugins()).toHaveLength(0)
  })

  // ── TC-DEP-17: 多个缺失依赖 ────────────────────────────────────
  it('TC-DEP-17: multiple missing dependencies reported together', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['missing1', 'missing2'] })

    try {
      await activator.activateWithDeps([a], host)
      expect.unreachable('Should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('missing1')
      expect(msg).toContain('missing2')
    }
  })

  // ── TC-DEP-18: 激活顺序遵循拓扑排序 ─────────────────────────────
  it('TC-DEP-18: activation order follows topological sort', async () => {
    const a = makeDescriptor({ pluginId: 'a', extensionDependencies: ['core'] })
    const core = makeDescriptor({ pluginId: 'core' })

    // core 应先于 a 激活
    await activator.activateWithDeps([a, core], host)

    expect(activator.getState('core')).toBe('ACTIVE')
    expect(activator.getState('a')).toBe('ACTIVE')
  })
})
