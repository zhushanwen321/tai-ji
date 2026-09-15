/**
 * 权限推送测试 (vitest)
 *
 * 测试 PluginActivator 在激活时检查权限：
 * - 未授权权限触发 onPermissionRequest 回调
 * - 审批通过后继续激活
 * - 审批拒绝 → 状态 UNLOADED
 * - 超时 30s → 自动拒绝
 *
 * 运行命令: pnpm --filter @taiji/runtime run test -- test/plugin-permission-push.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginDescriptor, PluginPermission } from '../src/services/plugin-service/plugin-types.js'

/** PermissionChecker 最小接口——Activator 只调用 getUnapproved */
interface PermissionCheckerLike {
  getUnapproved(pluginId: string, permissions: PluginPermission[]): PluginPermission[]
}

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'perm-plugin',
    version: '1.0.0',
    displayName: 'Perm Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/perm-plugin',
    // 默认 built-in：权限审批机制测试与激活锁（IF3）正交，锁只拦 external。
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
    assignWorker: vi.fn(() => Promise.resolve('worker-1')),
    loadPlugin: vi.fn(() => Promise.resolve()),
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

describe('Permission Push', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('should trigger onPermissionRequest when unapproved permissions exist', async () => {
    const unapprovedPerms: PluginPermission[] = ['tools.register', 'hooks.register']
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => unapprovedPerms),
    }

    const permissionRequests: Array<{ pluginId: string; permissions: PluginPermission[] }> = []

    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: (payload) => {
        permissionRequests.push(payload)
        activator.resolvePermissionApproval(payload.pluginId, true)
      },
    })

    const desc = makeDescriptor({
      pluginId: 'perm-plugin',
      permissions: ['tools.register', 'hooks.register', 'notify'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('perm-plugin', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].pluginId).toBe('perm-plugin')
    expect(permissionRequests[0].permissions).toEqual(unapprovedPerms)
    expect(activator.getState('perm-plugin')).toBe('ACTIVE')
  })

  it('should set UNLOADED when permission is rejected', async () => {
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => ['storage.access'] as PluginPermission[]),
    }

    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: (payload) => {
        activator.resolvePermissionApproval(payload.pluginId, false)
      },
    })

    const desc = makeDescriptor({
      pluginId: 'reject-plugin',
      permissions: ['storage.access'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('reject-plugin', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect(activator.getState('reject-plugin')).toBe('UNLOADED')
  })

  it('should auto-reject after timeout', async () => {
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => ['sessions.sendMessage'] as PluginPermission[]),
    }

    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: () => {
        // 不调用 resolvePermissionApproval → 模拟超时
      },
      permissionTimeoutMs: 100,
    })

    const desc = makeDescriptor({
      pluginId: 'timeout-plugin',
      permissions: ['sessions.sendMessage'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('timeout-plugin', { type: 'onStartupFinished' }, host)

    // 推进时间超过超时阈值
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(activator.getState('timeout-plugin')).toBe('UNLOADED')
  })

  it('should skip permission check when no unapproved permissions', async () => {
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => []),
    }

    let permissionRequested = false
    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: () => {
        permissionRequested = true
      },
    })

    const desc = makeDescriptor({
      pluginId: 'approved-plugin',
      permissions: ['tools.register'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('approved-plugin', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect(permissionRequested).toBe(false)
    expect(activator.getState('approved-plugin')).toBe('ACTIVE')
  })

  it('should skip permission check when plugin has no declared permissions', async () => {
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => []),
    }

    let permissionRequested = false
    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: () => {
        permissionRequested = true
      },
    })

    const desc = makeDescriptor({
      pluginId: 'no-perm-plugin',
      permissions: [],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('no-perm-plugin', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect(permissionRequested).toBe(false)
    expect(activator.getState('no-perm-plugin')).toBe('ACTIVE')
  })

  it('should skip permission check when no permissionChecker provided', async () => {
    const activator = new PluginActivator()

    const desc = makeDescriptor({
      pluginId: 'no-checker-plugin',
      permissions: ['tools.register'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('no-checker-plugin', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect(activator.getState('no-checker-plugin')).toBe('ACTIVE')
  })

  it('should not call assignWorker when permission is rejected', async () => {
    const checker: PermissionCheckerLike = {
      getUnapproved: vi.fn(() => ['storage.access'] as PluginPermission[]),
    }

    const activator = new PluginActivator({
      permissionChecker: checker,
      onPermissionRequest: (payload) => {
        activator.resolvePermissionApproval(payload.pluginId, false)
      },
    })

    const desc = makeDescriptor({
      pluginId: 'early-reject',
      permissions: ['storage.access'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')
    const promise = activator.activatePlugin('early-reject', { type: 'onStartupFinished' }, host)
    await vi.runAllTimersAsync()
    await promise

    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
