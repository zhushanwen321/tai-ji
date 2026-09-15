/**
 * Plugin Hot Reload — TDD tests for BG2 Task 5
 *
 * Tests fs.watch + debounce hot-reload for external plugins:
 *   - File change triggers reload (deactivate + activate)
 *   - Debounce: 300ms window coalesces multiple changes
 *   - Built-in plugins excluded from watching
 *   - Deactivate timeout (5s) → force terminate
 *   - Status change broadcast on reload
 *   - Non-JS/TS files ignored
 *   - Stop watching closes watcher + clears debounce timer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import { PluginHotReloader, type HotReloadHooks } from '../src/services/plugin-service/plugin-hot-reload.js'
import type { PluginDescriptor, PluginSource } from '../src/services/plugin-service/plugin-types.js'

// ── Hoisted mock data (available when vi.mock factory runs) ──────

const { mockWatcher, setWatchCallback, getWatchCallback, getWatchCalls } = vi.hoisted(() => {
  const mockWatcher = { close: vi.fn() }
  let watchCallback: ((eventType: string, filename: string | null) => void) | undefined
  const watchCalls: Array<{ dir: string; options: unknown }> = []

  return {
    mockWatcher,
    setWatchCallback: (cb: typeof watchCallback) => { watchCallback = cb },
    getWatchCallback: () => watchCallback,
    getWatchCalls: () => watchCalls,
  }
})

// Mock node:fs to capture watch calls and callbacks
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: vi.fn().mockImplementation((dir: string, options: unknown, ...rest: unknown[]) => {
      getWatchCalls().push({ dir, options })
      // Find callback among all arguments
      for (const arg of [options, ...rest]) {
        if (typeof arg === 'function') {
          setWatchCallback(arg as (eventType: string, filename: string | null) => void)
        }
      }
      return mockWatcher
    }),
  }
})

// ── Helpers ────────────────────────────────────────────────────

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
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
    pluginPath: '/tmp/plugins/test-plugin/index.js',
    // 默认 built-in：热重载机制测试与激活锁（IF3）正交，锁只拦 external。
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}

/** Status change callback that captures calls */
function createStatusChangeCapture() {
  const calls: Array<{ pluginId: string; oldStatus: string; newStatus: string }> = []
  return {
    callback: (payload: { pluginId: string; oldStatus: string; newStatus: string }) => {
      calls.push(payload)
    },
    calls,
  }
}

/**
 * Create mock PluginHost that auto-replies to activate/deactivate messages.
 */
function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') =>
      Promise.resolve('worker-1'),
    ),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) =>
      Promise.resolve(),
    ),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-1',
      postMessage: vi.fn((msg: unknown) => {
        const m = msg as { type: string; pluginId?: string }
        if (m.type === 'activate' || m.type === 'deactivate') {
          queueMicrotask(() => {
            activator.handleWorkerReply({
              // 回复类型必须与消息类型对应：真实 plugin-bootstrap 对 activate 回
              // activated、对 deactivate 回 deactivated（plugin-bootstrap.ts 的
              // post 调用）。旧 mock 对 deactivate 也回固定的 activated，单键匹配
              // 时代被掩盖；pendingReplies 复合键（D6）按 (pluginId, replyType)
              // 精确匹配后，deactivate 会永远等不到 deactivated 而假超时。
              // replyType 参数保留为 activate 回复的注入位（本文件全部用例传默认值）。
              type: m.type === 'activate' ? replyType : 'deactivated',
              pluginId: m.pluginId ?? pluginId,
            } as { type: 'activated' | 'deactivated'; pluginId: string })
          })
        }
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

// ══════════════════════════════════════════════════════════════════
// Plugin Hot Reload Tests
// ══════════════════════════════════════════════════════════════════

describe('Plugin Hot Reload (fs.watch + Debounce)', () => {
  let activator: PluginActivator

  beforeEach(() => {
    vi.useFakeTimers()
    activator = new PluginActivator()
    mockWatcher.close.mockReset()
    getWatchCalls().length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── TC-5-01: File change triggers reload ─────────────────────
  it('file change triggers reload', async () => {
    const desc = makeDescriptor({ pluginId: 'ext-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    // Activate plugin first
    await activator.activatePlugin('ext-plugin', { type: 'onStartupFinished' }, host)
    expect(activator.getState('ext-plugin')).toBe('ACTIVE')

    // Start watching
    activator.watchAndReload(
      'ext-plugin',
      desc.pluginPath,
      'external',
      host,
      statusCapture.callback,
    )

    // Simulate file change
    const callback = getWatchCallback()
    expect(callback).toBeDefined()
    callback!('change', 'index.js')

    // Advance debounce (300ms)
    await vi.advanceTimersByTimeAsync(300)

    // Verify reload happened (deactivate + activate)
    expect(activator.getState('ext-plugin')).toBe('ACTIVE')

    // Status change should have been broadcast
    expect(statusCapture.calls.length).toBe(1)
    expect(statusCapture.calls[0].pluginId).toBe('ext-plugin')
    expect(statusCapture.calls[0].oldStatus).toBe('active')
    expect(statusCapture.calls[0].newStatus).toBe('active')
  })

  // ── TC-5-02: Debounce coalesces rapid changes ────────────────
  it('debounce: two rapid changes → only one reload', async () => {
    const desc = makeDescriptor({ pluginId: 'debounce-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    await activator.activatePlugin('debounce-plugin', { type: 'onStartupFinished' }, host)

    activator.watchAndReload(
      'debounce-plugin',
      desc.pluginPath,
      'external',
      host,
      statusCapture.callback,
    )

    const callback = getWatchCallback()!

    // Two rapid changes 50ms apart
    callback('change', 'a.js')
    await vi.advanceTimersByTimeAsync(50)
    callback('change', 'b.js')

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(300)

    // Only one status change broadcast
    expect(statusCapture.calls.length).toBe(1)
  })

  // ── TC-5-03: Built-in exclusion ──────────────────────────────
  it('built-in plugins are excluded from watching', () => {
    const desc = makeDescriptor({
      pluginId: 'built-in-plugin',
      source: 'built-in',
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator)
    const statusCapture = createStatusChangeCapture()

    activator.watchAndReload(
      'built-in-plugin',
      desc.pluginPath,
      'built-in' as PluginSource,
      host,
      statusCapture.callback,
    )

    // No watcher should be created
    expect(getWatchCalls().length).toBe(0)
  })

  // ── TC-5-04: Non-JS/TS files ignored ─────────────────────────
  it('non-JS/TS files are ignored', async () => {
    const desc = makeDescriptor({ pluginId: 'ignore-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    await activator.activatePlugin('ignore-plugin', { type: 'onStartupFinished' }, host)

    activator.watchAndReload(
      'ignore-plugin',
      desc.pluginPath,
      'external',
      host,
      statusCapture.callback,
    )

    const callback = getWatchCallback()!

    // Change .json file → should be ignored
    callback('change', 'package.json')
    await vi.advanceTimersByTimeAsync(500)

    expect(statusCapture.calls.length).toBe(0)

    // Change .js file → should trigger
    callback('change', 'index.js')
    await vi.advanceTimersByTimeAsync(500)

    expect(statusCapture.calls.length).toBe(1)
  })

  // ── TC-5-05: Stop watching ───────────────────────────────────
  it('stopWatching closes watcher and clears debounce timer', async () => {
    const desc = makeDescriptor({ pluginId: 'stop-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    await activator.activatePlugin('stop-plugin', { type: 'onStartupFinished' }, host)

    activator.watchAndReload(
      'stop-plugin',
      desc.pluginPath,
      'external',
      host,
      statusCapture.callback,
    )

    const callback = getWatchCallback()!

    // Trigger a change (starts debounce timer)
    callback('change', 'index.js')

    // Stop watching before debounce fires
    activator.stopWatching('stop-plugin')

    // Watcher should be closed
    expect(mockWatcher.close).toHaveBeenCalled()

    // Advance past debounce — should NOT trigger reload
    await vi.advanceTimersByTimeAsync(500)
    expect(statusCapture.calls.length).toBe(0)
  })

  // ── TC-5-06: Don't double-watch ──────────────────────────────
  it('watchAndReload does not create duplicate watchers', () => {
    const desc = makeDescriptor({ pluginId: 'dup-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator)
    const statusCapture = createStatusChangeCapture()

    // First call creates watcher
    activator.watchAndReload('dup-plugin', desc.pluginPath, 'external', host, statusCapture.callback)
    expect(getWatchCalls().length).toBe(1)

    // Second call should be no-op
    activator.watchAndReload('dup-plugin', desc.pluginPath, 'external', host, statusCapture.callback)
    expect(getWatchCalls().length).toBe(1)
  })

  // ── TC-5-07: stopAllWatchers ──────────────────────────────────
  it('stopAllWatchers closes all watchers', async () => {
    const desc1 = makeDescriptor({ pluginId: 'p1' })
    const desc2 = makeDescriptor({ pluginId: 'p2' })
    activator.registerDescriptors([desc1, desc2])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    await activator.activatePlugin('p1', { type: 'onStartupFinished' }, host)
    await activator.activatePlugin('p2', { type: 'onStartupFinished' }, host)

    activator.watchAndReload('p1', desc1.pluginPath, 'external', host, statusCapture.callback)
    activator.watchAndReload('p2', desc2.pluginPath, 'external', host, statusCapture.callback)

    activator.stopAllWatchers()

    // Both watchers should be closed (2 calls total: p1 + p2)
    expect(mockWatcher.close).toHaveBeenCalledTimes(2)
  })

  // ── TC-5-08: Reload inactive plugin is no-op ─────────────────
  it('performReload skips inactive plugins', async () => {
    const desc = makeDescriptor({ pluginId: 'inactive-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    // Don't activate the plugin
    await activator.performReload('inactive-plugin', host, statusCapture.callback)

    // No status change
    expect(statusCapture.calls.length).toBe(0)
  })

  // ── TC-5-09: .ts files trigger reload ─────────────────────────
  it('.ts file changes trigger reload', async () => {
    const desc = makeDescriptor({ pluginId: 'ts-plugin' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const statusCapture = createStatusChangeCapture()

    await activator.activatePlugin('ts-plugin', { type: 'onStartupFinished' }, host)

    activator.watchAndReload(
      'ts-plugin',
      desc.pluginPath,
      'external',
      host,
      statusCapture.callback,
    )

    const callback = getWatchCallback()!
    callback('change', 'module.ts')
    await vi.advanceTimersByTimeAsync(300)

    expect(statusCapture.calls.length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════
// U7/D5: performReload deactivate race timer 句柄清理
// 直接实例化 PluginHotReloader（不经 PluginActivator），隔离 hooks 内
// 全部 timer，使 vi.getTimerCount() 成为「race timer 是否残留」的精确判据：
// deactivate 胜出后 5s timer 应被 clearTimeout（修复前残留 1 个，到期空 reject）。
// ══════════════════════════════════════════════════════════════════

describe('PluginHotReloader deactivate race timer cleanup (U7/D5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeHooks(overrides: Partial<HotReloadHooks> = {}): HotReloadHooks {
    return {
      deactivate: vi.fn((_pluginId: string) => Promise.resolve()),
      activate: vi.fn((_pluginId: string) => Promise.resolve()),
      forceTerminate: vi.fn((_pluginId: string) => Promise.resolve()),
      disposeContext: vi.fn((_pluginId: string) => undefined),
      setState: vi.fn((_pluginId: string, _state: 'UNLOADED') => undefined),
      getState: vi.fn((_pluginId: string) => 'ACTIVE'),
      ...overrides,
    }
  }

  it('deactivate win clears the race timer (no 5s idle timer left)', async () => {
    const reloader = new PluginHotReloader()
    const hooks = makeHooks()
    const onStatusChange = vi.fn()

    expect(vi.getTimerCount()).toBe(0)

    // deactivate 立即完成（胜出）
    await reloader.performReload('p-win', hooks, onStatusChange)

    // 修复断言：胜出路径 clearTimeout，无残留 5s race timer（修复前此处为 1）
    expect(vi.getTimerCount()).toBe(0)
    expect(hooks.forceTerminate).not.toHaveBeenCalled()
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(onStatusChange).toHaveBeenCalledWith({
      pluginId: 'p-win',
      oldStatus: 'active',
      newStatus: 'active',
    })

    // 快进过原 timer 触发点：无空转触发、无新增 timer
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deactivate timeout still force-terminates and cleans up (regression)', async () => {
    const reloader = new PluginHotReloader()
    // deactivate 永不 settle → 5s race timer 胜出走强杀清理（既有行为不变）
    const hooks = makeHooks({
      deactivate: vi.fn((_pluginId: string) => new Promise<void>(() => undefined)),
    })
    const onStatusChange = vi.fn()

    const reloading = reloader.performReload('p-stuck', hooks, onStatusChange)
    await vi.advanceTimersByTimeAsync(5_000)
    await reloading

    expect(hooks.forceTerminate).toHaveBeenCalledWith('p-stuck')
    expect(hooks.disposeContext).toHaveBeenCalledWith('p-stuck')
    expect(hooks.setState).toHaveBeenCalledWith('p-stuck', 'UNLOADED')
  })
})
