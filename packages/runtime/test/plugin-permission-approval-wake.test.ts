/**
 * 权限审批唤醒链路测试（批准/拒绝/挂起期清理）
 *
 * 修复前断链：PluginService.approvePermissions 只 grant 不 resolve pending，
 * 挂起在 waitForPermissionApproval 的激活（boot/handleEvent await 着）只能干等
 * 30s 超时；且等待期间 re-activate 被 ACTIVATING 幂等守卫 no-op 吞掉（实测
 * boot 后台初始化 plugins=30007.5ms）。
 *
 * 修复后契约（本文件锁定）：
 *  a. approvePermissions 唤醒挂起中的激活 → 毫秒级完成（fake timers 下不推进
 *     30s 即断言 ACTIVE），且唤醒的是同一次激活（assignWorker 恰好一次）
 *  b. revokePermissions 拒绝唤醒 → 走既有失败语义（UNLOADED、不分配 Worker）
 *  e. denyPermissions（M7 语义分界）= 拒绝本次申请：descriptor.permissions 与
 *     granted 授予集不变、不调 save、不回收已授权限；有 pending 时唤醒为拒绝；
 *     无 pending 时幂等 no-op
 *  c. 挂起期间 uninstall / toggle(false) → pending 被清理、激活作废、无复活
 *  d. 批准唤醒与停用的竞态 → 醒来的激活作废，已停用插件不复活
 *
 * 运行命令: cd packages/runtime && npx vitest run test/plugin-permission-approval-wake.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/**
 * 权限审批只对 sandbox + 非 built-in 生效（PermissionChecker.getUnapproved 对
 * trusted/built-in 直接返回空），故 fixture 用 external + sandbox——与
 * plugin-uninstall-shutdown.test.ts 的 descriptor 形态一致。
 */
function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'wake-plugin',
    version: '1.0.0',
    displayName: 'Wake Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: ['plugin.hooks.register'],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/does-not-exist/wake-plugin/index.js',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

/** PluginService 测试视图：私有协作者注入缝（plugin-uninstall-shutdown.test.ts 同模式） */
interface ServiceInternals {
  activator: PluginActivator
  host: PluginHost
}
function internals(service: PluginService): ServiceInternals {
  return service as unknown as ServiceInternals
}

/**
 * mock host：postMessage 后微任务回 activated——挂起中的激活被唤醒后能立即走完
 * assignWorker → loadPlugin → activate → ACTIVE 全程（fake timers 不推进也能完成，
 * 证明唤醒链路独立于 30s 超时 timer）。
 */
function createMockHost(activator: PluginActivator): PluginHost {
  return {
    assignWorker: vi.fn(() => Promise.resolve('worker-wake')),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-wake',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({ type: 'activated', pluginId })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  } as unknown as PluginHost
}

describe('权限审批唤醒链路（approve / revoke / 挂起期清理）', () => {
  let tmpDir: string
  /** 每用例独立的 descriptor（approvePermissions 会 mutate descriptor.permissions） */
  let descriptor: PluginDescriptor
  let service: PluginService
  let broker: ReturnType<typeof createMockBroker>
  let activator: PluginActivator

  beforeEach(async () => {
    vi.useFakeTimers()
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-perm-wake-'))
    // pluginPath 真实存在（approvePermissions 激活成功后 watchExternalIfActive 会
    // 对 external 插件 fs.watch dirname(pluginPath)，不存在的目录 fs.watch 会抛）
    await mkdir(join(tmpDir, 'wake-plugin'), { recursive: true })
    descriptor = makeDescriptor({
      pluginPath: join(tmpDir, 'wake-plugin', 'index.js'),
    })
    broker = createMockBroker()
    const registryMock = {
      getDescriptor: vi.fn(() => descriptor),
      getAllDescriptors: vi.fn(() => [descriptor]),
      removeDescriptor: vi.fn(() => true),
    }
    service = new PluginService(registryMock as unknown as PluginRegistry, broker, {
      configDir: tmpDir,
    })
    const reg = internals(service)
    activator = reg.activator
    reg.host = createMockHost(activator)
    activator.registerDescriptors([descriptor])
  })

  afterEach(async () => {
    // 停掉 watchExternalIfActive 可能启动的 fs.watch，再清临时目录
    activator?.stopAllWatchers()
    vi.useRealTimers()
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /**
   * 触发激活并推进微任务到「挂在权限等待」的稳定点。
   * 返回对象包裹 activation（async 函数会自动展平返回的 promise——直接
   * `return activation` 会让调用方 await 到挂起中的激活本身，形成死锁）。
   */
  async function startPendingActivation(): Promise<{ activation: Promise<void> }> {
    const activation = activator.activatePlugin(
      'wake-plugin',
      { type: 'onStartupFinished' },
      internals(service).host,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(activator.getState('wake-plugin')).toBe('ACTIVATING')
    return { activation }
  }

  // ── a. 批准唤醒：毫秒级完成，唤醒的是同一次激活 ─────────────────
  it('a: 挂起等待审批 → approvePermissions → 激活立即完成（不推进 30s 超时 timer）', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host

    // 挂起期间：未分配 Worker，权限请求已广播（前端批准入口的可见性）
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    const broadcastCalls = (broker.broadcast as ReturnType<typeof vi.fn>).mock.calls
    expect(broadcastCalls.some((c) => (c[0] as { type: string }).type === 'plugin:permissionRequest')).toBe(true)

    // 批准。fake timers 下 30s 超时从未触发——若唤醒链路断裂，这里 state 仍会是
    // ACTIVATING（修复前实测 boot 挂满 30007.5ms）
    await service.approvePermissions('wake-plugin', ['plugin.hooks.register'])

    expect(activator.getState('wake-plugin')).toBe('ACTIVE')
    // 唤醒的是已在等待的那次激活：approvePermissions 内部的 activatePlugin 重入
    // 返回同一 in-flight promise，assignWorker 不被二次调用
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    await activation
    expect(activator.getActivePlugins()).toEqual(['wake-plugin'])
  })

  // ── b. 拒绝唤醒：既有失败语义 ──────────────────────────────────
  it('b: 挂起等待审批 → revokePermissions → 激活走失败语义（UNLOADED、不分配 Worker）', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host

    await service.revokePermissions('wake-plugin')

    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    await activation
  })

  // ── e. denyPermissions：拒绝本次申请，不回收已授权限（M7 语义分界）──
  it('e: denyPermissions → descriptor.permissions 与 granted 授予集不变、不调 save（不回收已授权限）', async () => {
    const { permissionChecker: checker } = service as unknown as {
      permissionChecker: import('../src/services/plugin-service/plugin-permission.js').PluginPermissionChecker
    }
    // 先授予（模拟既有已授权限），再拒绝新申请——已授权限必须原样保留
    checker.grant('wake-plugin', ['plugin.hooks.register'])
    const saveSpy = vi.spyOn(checker, 'save').mockResolvedValue()
    const permissionsBefore = [...descriptor.permissions]

    await service.denyPermissions('wake-plugin')

    expect(descriptor.permissions).toEqual(permissionsBefore)
    const granted = (checker as unknown as { granted: Map<string, Set<string>> }).granted.get('wake-plugin')
    expect(granted?.size).toBeGreaterThan(0)
    expect(saveSpy).not.toHaveBeenCalled()
    // 无 pending：不触发激活，状态不受影响
    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
  })

  it('e2: 有 pending 等待审批时 denyPermissions → resolvePermissionApproval(false) 被调，激活走失败语义', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host
    const resolveSpy = vi.spyOn(activator, 'resolvePermissionApproval')

    await service.denyPermissions('wake-plugin')

    expect(resolveSpy).toHaveBeenCalledWith('wake-plugin', false)
    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    await activation
  })

  it('e3: 无 pending 时 denyPermissions → 幂等 no-op（状态不变、不分配 Worker、不抛）', async () => {
    const host = internals(service).host
    const resolveSpy = vi.spyOn(activator, 'resolvePermissionApproval')

    await expect(service.denyPermissions('wake-plugin')).resolves.toBeUndefined()

    expect(resolveSpy).toHaveBeenCalledWith('wake-plugin', false)
    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── c1. 挂起期间 uninstall：pending 清理 + 无幽灵状态复活 ────────
  it('c1: 挂起期间 uninstallPlugin → pending 清理、激活作废、无幽灵状态复活', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host

    await service.uninstallPlugin('wake-plugin')
    await activation

    // removeDescriptor 已删状态；被唤醒的激活经 ACTIVATING 状态检查提前 return，
    // 不再回写 setState（修复前会往已清空的 Map 里复活一条 UNLOADED 幽灵 entry）
    expect(activator.getState('wake-plugin')).toBeUndefined()
    expect(activator.getActivePlugins()).toEqual([])
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── c2. 挂起期间 disable：拒绝唤醒 + 不复活 ─────────────────────
  it('c2: 挂起期间 togglePlugin(false) → 挂起激活被拒绝唤醒、状态收敛 UNLOADED', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host

    await service.togglePlugin('wake-plugin', false)
    expect(activator.getState('wake-plugin')).toBe('UNLOADED')

    await activation
    // 醒来的激活因状态已被停用改写而作废，不复活
    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── d. 批准唤醒与停用的竞态 ────────────────────────────────────
  it('d: 批准唤醒后、激活续跑前停用 → 醒来的激活作废，已停用插件不复活', async () => {
    const { activation } = await startPendingActivation()
    const host = internals(service).host

    // 模拟 approvePermissions 的唤醒（不 await 激活完成），停用抢在激活续跑之前
    activator.resolvePermissionApproval('wake-plugin', true)
    await activator.deactivatePlugin('wake-plugin', internals(service).host)
    await activation

    expect(activator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  // ── W5 广播契约：权限命令 reply pong ack，列表刷新经 config.plugins 广播 ──
  // PluginInfo 不含权限字段（pluginId/version/displayName/description/status/
  // trustLevel/enabled）——deny/revoke 后广播内容不变，不广播；approve 触发
  // activate（status discovered→active 真实变化）才广播。
  /** 数 broker.broadcast 中 type=config.plugins 的调用次数（列表刷新广播） */
  function pluginListBroadcastCount(): number {
    const broadcastMock = broker.broadcast as ReturnType<typeof vi.fn>
    return broadcastMock.mock.calls.filter((c) => (c[0] as { type: string }).type === 'config.plugins').length
  }

  it('W5: approvePermissions → activate 完成后广播 config.plugins（恰一次）', async () => {
    ;(broker.broadcast as ReturnType<typeof vi.fn>).mockClear()

    await service.approvePermissions('wake-plugin', ['plugin.hooks.register'])

    expect(activator.getState('wake-plugin')).toBe('ACTIVE')
    expect(pluginListBroadcastCount()).toBe(1)
  })

  it('W5: denyPermissions（无 pending）→ 不广播 config.plugins', async () => {
    ;(broker.broadcast as ReturnType<typeof vi.fn>).mockClear()

    await service.denyPermissions('wake-plugin')

    expect(pluginListBroadcastCount()).toBe(0)
  })

  it('W5: revokePermissions → 不广播 config.plugins（PluginInfo 字段无变化）', async () => {
    ;(broker.broadcast as ReturnType<typeof vi.fn>).mockClear()

    await service.revokePermissions('wake-plugin')

    expect(pluginListBroadcastCount()).toBe(0)
  })

  // ── 超时兜底仍在（唤醒是加速，超时是语义不变的兜底）──────────────
  it('无人批准时仍按 permissionTimeoutMs 超时回落 UNLOADED（唤醒不破坏兜底）', async () => {
    // 重建短超时 activator（service 内置 30s，这里直测 activator 层）
    const shortActivator = new PluginActivator({
      permissionChecker: { getUnapproved: () => ['plugin.hooks.register'] },
      onPermissionRequest: () => { /* 无人批准 */ },
      permissionTimeoutMs: 100,
    })
    shortActivator.registerDescriptors([descriptor])
    const host = createMockHost(shortActivator)
    const activation = shortActivator.activatePlugin('wake-plugin', { type: 'onStartupFinished' }, host)

    await vi.advanceTimersByTimeAsync(200)
    await activation

    expect(shortActivator.getState('wake-plugin')).toBe('UNLOADED')
    expect((host.assignWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
