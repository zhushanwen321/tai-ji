import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

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
    engines: { 'xyz-agent': '*' },
    pluginPath: '/tmp/test-plugin',
    // 默认 built-in：正常激活路径 fixture（激活锁只锁 external，见下方锁语义 describe）。
    // 锁语义用例显式传 source: 'external'。
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}

/**
 * 创建 mock PluginHost。
 * postMessage 被调用后，在 microtask 中通过 activator.handleWorkerReply 模拟 Worker 回复。
 */
function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  let currentPluginId = 'test-plugin'

  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => {
      return Promise.resolve('worker-1')
    }),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) => {
      return Promise.resolve()
    }),
    getWorkerHandle: vi.fn((pluginId: string) => {
      currentPluginId = pluginId
      return {
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          // 模拟 Worker 回复
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: replyType,
              pluginId,
            })
          })
        }),
      }
    }),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

describe('PluginActivator', () => {
  // ── TC-4-01: registerDescriptors builds eventMap ──────────────
  it('TC-4-01: registerDescriptors builds eventMap and handles getActivePlugins', () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({
      pluginId: 'p1',
      activationEvents: ['onStartupFinished', 'onSlashCommand:hello'],
    })
    const desc2 = makeDescriptor({
      pluginId: 'p2',
      activationEvents: ['onSlashCommand:hello'],
    })

    activator.registerDescriptors([desc1, desc2])

    // 注册后，两个插件都应处于 UNLOADED 状态
    expect(activator.getState('p1')).toBe('UNLOADED')
    expect(activator.getState('p2')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── TC-4-02: handleEvent matches activationEvents ─────────────
  it('TC-4-02: handleEvent matches activationEvents', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'slash-plugin',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 匹配的事件应触发激活
    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'hello' },
      host,
    )

    // 激活流程完成（mock host 立即回复 'activated'）
    expect(activator.getState('slash-plugin')).toBe('ACTIVE')
  })

  // ── TC-4-03: activatePlugin sets state to ACTIVE ──────────────
  it('TC-4-03: activatePlugin sets state to ACTIVE', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'act-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    expect(activator.getState('act-test')).toBe('UNLOADED')

    await activator.activatePlugin('act-test', { type: 'onStartupFinished' }, host)

    expect(activator.getState('act-test')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['act-test'])
  })

  // ── TC-4-04: deactivatePlugin sets state to UNLOADED ──────────
  it('TC-4-04: deactivatePlugin sets state to UNLOADED', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'deact-test' })
    activator.registerDescriptors([desc])

    // 先激活
    const activateHost = createMockHost(activator, 'activated')
    await activator.activatePlugin('deact-test', { type: 'onStartupFinished' }, activateHost)
    expect(activator.getState('deact-test')).toBe('ACTIVE')

    // 再停用
    const deactivateHost = createMockHost(activator, 'deactivated')
    await activator.deactivatePlugin('deact-test', deactivateHost)
    expect(activator.getState('deact-test')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── 幂等：重复激活应跳过 ──────────────────────────────────────
  it('activatePlugin is idempotent (skip if already ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'idempotent-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    expect(activator.getState('idempotent-test')).toBe('ACTIVE')

    // 第二次激活应直接跳过（assignWorker 不应被再次调用）
    const assignCallsBefore = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    const assignCallsAfter = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(assignCallsAfter).toBe(assignCallsBefore)
  })

  // ── Worker 回复 error 时状态应为 UNLOADED ─────────────────────
  it('activatePlugin sets UNLOADED when worker replies error', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'error-test' })
    activator.registerDescriptors([desc])

    // 创建一个 host，其 postMessage 触发 error 回复
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'activation failed',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await activator.activatePlugin('error-test', { type: 'onStartupFinished' }, errorHost)
    expect(activator.getState('error-test')).toBe('UNLOADED')
  })

  // ── deactivatePlugin 对未激活插件是 no-op ─────────────────────
  it('deactivatePlugin is no-op for UNLOADED plugins', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'no-op-test' })])

    const host = createMockHost(activator, 'deactivated')
    expect(activator.getState('no-op-test')).toBe('UNLOADED')

    await activator.deactivatePlugin('no-op-test', host)
    expect(activator.getState('no-op-test')).toBe('UNLOADED')
  })

  // ── deactivateAll 停用所有已激活插件 ──────────────────────────
  it('deactivateAll deactivates all active plugins', async () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({ pluginId: 'all-1', activationEvents: ['onStartupFinished'] })
    const desc2 = makeDescriptor({ pluginId: 'all-2', activationEvents: ['onStartupFinished'] })
    activator.registerDescriptors([desc1, desc2])

    const host1 = createMockHost(activator, 'activated')
    const host2 = createMockHost(activator, 'activated')

    await activator.activatePlugin('all-1', { type: 'onStartupFinished' }, host1)
    await activator.activatePlugin('all-2', { type: 'onStartupFinished' }, host2)
    expect(activator.getActivePlugins().length).toBe(2)

    const deactHost = createMockHost(activator, 'deactivated')
    await activator.deactivateAll(deactHost)
    expect(activator.getActivePlugins().length).toBe(0)
    expect(activator.getState('all-1')).toBe('UNLOADED')
    expect(activator.getState('all-2')).toBe('UNLOADED')
  })

  // ── handleEvent 不匹配时不会激活 ──────────────────────────────
  it('handleEvent does not activate when event does not match', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'no-match',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'other' },
      host,
    )

    expect(activator.getState('no-match')).toBe('UNLOADED')
  })

  // ── 未知插件 activatePlugin 是 no-op ─────────────────────────
  it('activatePlugin is no-op for unknown pluginId', async () => {
    const activator = new PluginActivator()
    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('nonexistent', { type: 'onStartupFinished' }, host)
    expect(activator.getState('nonexistent')).toBe(undefined)
  })
})

describe('external plugin activation hard lock（§6.6 激活侧，IF3）', () => {
  // ── TC-A: external + 开关 true（sandbox 闭环已落地）→ 正常激活 ────────
  it('TC-A: external plugin + EXTERNAL_PLUGIN_ENABLED=true（翻转后）→ 正常激活 (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'ext-allowed', source: 'external' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 翻转后：external 来源不再被硬锁跳过（sandbox 子进程 + ESM loader 兜底隔离，
    // 见 plugin-security.ts [翻转记录]）。开关回退 false 时本 guard 重新生效（fail-closed）。
    await activator.activatePlugin('ext-allowed', { type: 'onStartupFinished' }, host)

    // 正常进入激活路径
    expect(activator.getState('ext-allowed')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalledTimes(1)
    expect(host.loadPlugin).toHaveBeenCalledTimes(1)
  })

  // ── TC-B: built-in 来源不受影响，正常激活 ─────────────────────
  it('TC-B: built-in plugin unaffected → normal activation path (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'builtin-ok', source: 'built-in' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('builtin-ok', { type: 'onStartupFinished' }, host)

    expect(activator.getState('builtin-ok')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalled()
    expect(host.loadPlugin).toHaveBeenCalled()
  })
})

/**
 * 沉默 host：postMessage 后 Worker 不回复（activate 超时路径用——回复型 mock 会在
 * microtask 内 resolve，永远走不到超时 timer）。
 */
function createSilentHost(): ActivatorHost {
  return {
    assignWorker: vi.fn(() => Promise.resolve('worker-1')),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn(() => ({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

describe('activate 超时覆盖参数（timeout-plugin-service D4：控制面 30s 保持 + activateTimeoutMs 逃生门）', () => {
  it('activateTimeoutMs 覆盖生效：注入小值后超时 → UNLOADED + warn 含 activateTimeoutMs 覆盖指引', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator({ activateTimeoutMs: 100 })
      const desc = makeDescriptor({ pluginId: 'slow-activate' })
      activator.registerDescriptors([desc])

      const host = createSilentHost()
      const pending = activator.activatePlugin('slow-activate', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(100)
      await pending

      expect(activator.getState('slow-activate')).toBe('UNLOADED')
      const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .filter((msg: string) => msg.includes('activate reply'))
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('timed out after 100ms')
      expect(warns[0]).toContain('activateTimeoutMs')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('默认 30s 回归：未传 activateTimeoutMs 时 29_999ms 仍等待、30_000ms 超时 UNLOADED', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      const desc = makeDescriptor({ pluginId: 'default-timeout' })
      activator.registerDescriptors([desc])

      const host = createSilentHost()
      const pending = activator.activatePlugin('default-timeout', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(29_999)
      expect(activator.getState('default-timeout')).toBe('ACTIVATING')

      await vi.advanceTimersByTimeAsync(1)
      await pending

      expect(activator.getState('default-timeout')).toBe('UNLOADED')
      expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .some((msg: string) => msg.includes('timed out after 30000ms'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('deactivate 超时不打 activateTimeoutMs 指引（D6 登记不动项维持静默）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      const desc = makeDescriptor({ pluginId: 'silent-deact' })
      activator.registerDescriptors([desc])

      // 先用回复型 host 激活成功，再换沉默 host 停用（deactivate 回复永不到达）
      await activator.activatePlugin('silent-deact', { type: 'onStartupFinished' }, createMockHost(activator, 'activated'))
      expect(activator.getState('silent-deact')).toBe('ACTIVE')

      const pending = activator.deactivatePlugin('silent-deact', createSilentHost())
      await vi.advanceTimersByTimeAsync(5_000)
      await pending

      // deactivate 超时（5s）后仍完成本地清理（D6 现状），且无 activate 超时类 warn
      expect(activator.getState('silent-deact')).toBe('UNLOADED')
      expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .some((msg: string) => msg.includes('activateTimeoutMs'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('超时后迟到的 activated 回复 miss noop：状态不被复活', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator({ activateTimeoutMs: 50 })
      const desc = makeDescriptor({ pluginId: 'late-reply' })
      activator.registerDescriptors([desc])

      // postMessage 后手动控制回复时机：超时到期后再补发 activated 回复
      let posted = false
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => Promise.resolve()),
        getWorkerHandle: vi.fn((pluginId: string) => ({
          workerId: 'worker-1',
          postMessage: vi.fn(() => { posted = true }),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }
      const pending = activator.activatePlugin('late-reply', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(50)
      await pending
      expect(activator.getState('late-reply')).toBe('UNLOADED')

      // 迟到的 activated 回复：pending 已删，miss noop，状态不复活
      expect(posted).toBe(true)
      activator.handleWorkerReply({ type: 'activated', pluginId: 'late-reply' })
      expect(activator.getState('late-reply')).toBe('UNLOADED')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

// ── V6② crash 连坐状态守护 ─────────────────────────────────────
// 设计 §6.5：load 超时 ≈ Worker event loop 卡死 ≈ 同宿主一切 RPC 不可响应，
// terminate + rebuild（连带同宿主其他插件重载）与 crash 路径处理完全一致。
// crash 链（plugin-host handleWorkerCrash → PluginService crash callback →
// markCrashed）把同宿主插件置 CRASHED 后，激活在飞的插件其失败终态不得把
// CRASHED 覆盖为 UNLOADED——handleWorkerRebuilt 只重载 CRASHED 态插件，
// 覆盖会让被连坐插件在 rebuild 后被跳过（Gate B V6② 实测失败形态：同宿主
// 正常插件未自动重载，手动 toggle 才恢复）。
describe('crash 连坐状态守护（V6②：markCrashed 的 CRASHED 不被激活失败终态覆盖为 UNLOADED）', () => {
  /** 一轮 microtask 清空（激活流程推进到挂起点） */
  const flushAsync = () => new Promise<void>((r) => setImmediate(r))

  it('激活在飞 loadPlugin 被拒 + markCrashed 连坐 → 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-load' })])

      let rejectLoad!: (err: Error) => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        // load 挂起：模拟死循环插件卡死 Worker 后本插件 load 未获回复
        loadPlugin: vi.fn(() => new Promise<void>((_, reject) => { rejectLoad = reject })),
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-load', { type: 'onStartupFinished' }, host)
      await flushAsync()
      expect(host.loadPlugin).toHaveBeenCalledTimes(1)

      // 同宿主 load 超时 crash 链连坐：markCrashed 先落地
      activator.markCrashed('collateral-load')
      rejectLoad(new Error('loadPlugin timeout for worker worker-1 after 10000ms'))
      await pending

      expect(activator.getState('collateral-load')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('激活在飞中 crash 清理句柄（getWorkerHandle undefined）→ 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-handle' })])

      let resolveLoad!: () => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
        // crash 链 removeIndexEntries 后句柄已清理：激活醒来时拿不到 handle
        getWorkerHandle: vi.fn(() => undefined),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-handle', { type: 'onStartupFinished' }, host)
      await flushAsync()

      // crash 连坐先落地，load 回复再唤醒挂起中的激活
      activator.markCrashed('collateral-handle')
      resolveLoad()
      await pending

      expect(activator.getState('collateral-handle')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('激活在飞中 crash 后 activate 握手收到 error 回复 → 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-handshake' })])

      let resolveLoad!: () => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
        // Worker 已被 crash 链 terminate：activate 消息无人应答（postMessage 空），
        // 握手结局由迟到 error 回复 resolve(false) 收敛（handleWorkerReply 路径）
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-handshake', { type: 'onStartupFinished' }, host)
      await flushAsync()

      activator.markCrashed('collateral-handshake')
      resolveLoad()
      await flushAsync()
      // 挂在 activate 握手上后，注入 error 回复（resolve(false) → 失败终态写点）
      activator.handleWorkerReply({ type: 'error', pluginId: 'collateral-handshake', error: 'worker terminated' })
      await pending

      expect(activator.getState('collateral-handshake')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('对照组（无 crash 连坐）：同样的 load 失败路径仍落 UNLOADED（合法语义不回退）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'plain-fail' })])

      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => Promise.reject(new Error('module not found'))),
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      await activator.activatePlugin('plain-fail', { type: 'onStartupFinished' }, host)

      expect(activator.getState('plain-fail')).toBe('UNLOADED')
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// scan→activate 全链 + error 恢复重激活（自 plugin-integration.test.ts 归并；
// TC-int-02「storage round-trip through RPC」未随迁——其 getMethod/setMethod 是
// 测试文件内定义的函数直调 storage，未经 rpcServer.dispatch，与 plugin-storage.test.ts
// TC-5-01/04 同质零增量；RPC 层真实覆盖在 plugin-injection-guard.test.ts）
// ══════════════════════════════════════════════════════════════════

describe('plugin-integration 归并：scan 发现 + 激活全链 + error 恢复', () => {
  let tmpDir: string

  beforeAll(async () => {
    const { mkdtemp, mkdir, cp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join, resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-integration-test-'))
    const pluginDir = join(tmpDir, 'resources', 'plugins', 'hello-world')
    // resources/plugins 目录由 registry 映射为 built-in（plugin-registry.ts 第三项），
    // 避免激活锁（IF3 只锁 external）跳过本集成流程的激活步骤。
    await mkdir(pluginDir, { recursive: true })
    await cp(join(FIXTURES_DIR, 'hello-world'), pluginDir, { recursive: true })
  })

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC-int-01: registry.scan 发现 → 注册 → 事件激活 → 停用全链', async () => {
    const { PluginRegistry } = await import('../src/services/plugin-service/plugin-registry.js')
    const registry = new PluginRegistry(tmpDir, tmpDir)
    const activator = new PluginActivator()
    // 全链 host 需区分 activate/deactivate 回复（createMockHost 恒回 activated，deactivate 会挂起）
    const host: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('mock-worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'mock-worker-1',
        postMessage: vi.fn((msg: unknown) => {
          const m = msg as { type: string; pluginId?: string }
          if (m.type === 'activate') {
            queueMicrotask(() => activator.handleWorkerReply({ type: 'activated', pluginId }))
          } else if (m.type === 'deactivate') {
            queueMicrotask(() => activator.handleWorkerReply({ type: 'deactivated', pluginId }))
          }
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    // 1. 扫描发现插件（descriptor 形态断言：scan 发现链唯一覆盖点）
    const descriptors = await registry.scan()
    expect(descriptors.length >= 1).toBeTruthy()
    const hw = descriptors.find(d => d.pluginId === 'hello-world')!
    expect(hw).toBeTruthy()
    expect(hw.trustLevel).toBe('trusted')
    expect(hw.activationEvents.includes('onStartupFinished')).toBeTruthy()

    // 2. 注册描述符 + 事件触发激活
    activator.registerDescriptors(descriptors)
    expect(activator.getState('hello-world')).toBe('UNLOADED')

    await activator.handleEvent({ type: 'onStartupFinished' }, host)
    expect(activator.getState('hello-world')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['hello-world'])

    // 3. slash command 触发已激活插件（幂等）
    await activator.handleEvent({ type: 'onSlashCommand', command: 'hello' }, host)
    expect(activator.getState('hello-world')).toBe('ACTIVE')

    // 4. 停用
    await activator.deactivatePlugin('hello-world', host)
    expect(activator.getState('hello-world')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  it('TC-int-03: error 恢复——激活失败 UNLOADED 后可重新激活到 ACTIVE', async () => {
    const crashActivator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'crash-plugin',
      trustLevel: 'sandbox',
      pluginPath: '/tmp/crash-plugin',
    })

    crashActivator.registerDescriptors([desc])

    // 模拟 Worker 在 activate 时回复 error
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('crash-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'crash-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'Worker crashed during activation',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await crashActivator.activatePlugin('crash-plugin', { type: 'onStartupFinished' }, errorHost)

    // 状态应该是 UNLOADED（不是 ACTIVE）——error 不产生 CRASHED 终态
    expect(crashActivator.getState('crash-plugin')).toBe('UNLOADED')
    expect(crashActivator.getActivePlugins().length).toBe(0)

    // 可以重新尝试激活（恢复）——error 后 recovery 重激活是本用例独有增量
    const recoveryHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('recovery-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'recovery-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({ type: 'activated', pluginId })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await crashActivator.activatePlugin('crash-plugin', { type: 'onStartupFinished' }, recoveryHost)
    expect(crashActivator.getState('crash-plugin')).toBe('ACTIVE')
  })
})
