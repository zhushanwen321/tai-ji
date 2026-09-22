/**
 * F2/F5：uninstallPlugin 四缺收口 + shutdown flush 先于停 timer。
 *
 * F2 四缺（uninstall 装配层缺口，逐缺断言）：
 *  ① stopWatching（停 fs.watch 热重载监听）
 *  ② installer.uninstall 删插件目录（external only；失败不中断内存清理）
 *  ③ sandbox 子进程 terminate（SIGTERM→SIGKILL 升级链入口；trusted 共享线程不杀）
 *  ④ activator.removeDescriptor（描述符/状态/eventMap 清理，防幽灵重激活）
 *
 * F5：shutdown 在 dispose 之前 flushAll（WriteBackCache per-write 500ms
 * debounce，dispose 清 pending debounce 不 flush，丢最后 ≤500ms 写入），并含真实落盘行为断言。
 *
 * 运行命令: npx vitest run test/plugin-uninstall-shutdown.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import type { SessionDataStore } from '../src/services/plugin-service/session-data-store.js'
import type { PluginStorage } from '../src/services/plugin-service/plugin-storage.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IPluginInstaller } from '../src/services/ports/plugin-installer.js'
import type { IMessageBroker } from '../src/interfaces.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'uninstall-plugin',
    version: '1.0.0',
    displayName: 'Uninstall Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'ACTIVE',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/plugins/uninstall-plugin/index.js',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

/** PluginService 测试视图：私有协作者注入缝（与 plugin-tool-execution.test.ts 的 internals 同模式） */
interface ServiceInternals {
  activator: PluginActivator
  host: PluginHost
  sessionDataStore: SessionDataStore
  storage: PluginStorage
  initialized: boolean
}

function internals(service: PluginService): ServiceInternals {
  return service as unknown as ServiceInternals
}

function createService(opts: {
  descriptor?: PluginDescriptor
  installer?: IPluginInstaller
  configDir?: string
} = {}) {
  const broker = createMockBroker()
  const registryMock = {
    getDescriptor: vi.fn(() => opts.descriptor ?? undefined),
    getAllDescriptors: vi.fn(() => (opts.descriptor ? [opts.descriptor] : [])),
    removeDescriptor: vi.fn(() => true),
  }
  const service = new PluginService(registryMock as unknown as PluginRegistry, broker, {
    pluginInstaller: opts.installer,
    ...(opts.configDir ? { configDir: opts.configDir } : {}),
  })
  return { service, reg: internals(service), registryMock }
}

describe('uninstallPlugin 四缺收口（F2）', () => {
  it('F2-①: uninstall 停止该插件的 fs.watch 热重载监听', async () => {
    const installer: IPluginInstaller = {
      install: vi.fn(),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const { service, reg } = createService({ descriptor: makeDescriptor(), installer })
    const stopWatching = vi.spyOn(reg.activator, 'stopWatching')

    await service.uninstallPlugin('uninstall-plugin')

    expect(stopWatching).toHaveBeenCalledWith('uninstall-plugin')
  })

  it('F2-②: external 插件 uninstall 调 installer.uninstall(pluginId, pluginPath) 删除磁盘目录', async () => {
    const installer: IPluginInstaller = {
      install: vi.fn(),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const descriptor = makeDescriptor({ source: 'external', pluginPath: '/tmp/plugins/uninstall-plugin/index.js' })
    const { service } = createService({ descriptor, installer })

    await service.uninstallPlugin('uninstall-plugin')

    expect(installer.uninstall).toHaveBeenCalledTimes(1)
    expect(installer.uninstall).toHaveBeenCalledWith('uninstall-plugin', '/tmp/plugins/uninstall-plugin/index.js')
  })

  it('F2-②守卫: builtin 插件（source=built-in）不删磁盘（防破坏随应用分发的资源）', async () => {
    const installer: IPluginInstaller = {
      install: vi.fn(),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const descriptor = makeDescriptor({ source: 'built-in' })
    const { service, registryMock } = createService({ descriptor, installer })

    await service.uninstallPlugin('uninstall-plugin')

    expect(installer.uninstall).not.toHaveBeenCalled()
    // 内存清理仍完成（builtin 的卸载语义是移除注册）
    expect(registryMock.removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
  })

  it('F2-②容错: installer.uninstall 抛错不中断内存清理（registry/activator 拆除仍完成），收口抛错（RT-6#6）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const installer: IPluginInstaller = {
      install: vi.fn(),
      uninstall: vi.fn().mockRejectedValue(new Error('rm -rf failed: EPERM')),
    }
    const descriptor = makeDescriptor({ source: 'external' })
    const { service, registryMock, reg } = createService({ descriptor, installer })
    const removeDescriptor = vi.spyOn(reg.activator, 'removeDescriptor')

    // RT-6#6：磁盘删除失败不再「只 log 仍回成功形状」——内存清理照旧完成后抛带 code 的
    // 领域错误（否则残留目录重启后被 scan 扫回 = 卸载静默复活，用户零反馈）。
    await expect(service.uninstallPlugin('uninstall-plugin')).rejects.toThrow(
      /on-disk files could not be deleted.*rm -rf failed: EPERM/,
    )
    await service.uninstallPlugin('uninstall-plugin').catch((e: unknown) => {
      expect((e as { code?: string }).code).toBe('PLUGIN_UNINSTALL_PARTIAL')
    })

    // 磁盘删除失败仅记日志（toErrorMessage 已把 Error 归一为 message 字符串）
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('on-disk removal'),
      'rm -rf failed: EPERM',
    )
    // 内存清理不被阻断
    expect(registryMock.removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
    expect(removeDescriptor).toHaveBeenCalledWith('uninstall-plugin')
    consoleError.mockRestore()
  })

  it('F2-③: sandbox 插件 uninstall 时 terminate 其独占子进程（SIGTERM→SIGKILL 升级链入口）', async () => {
    const installer: IPluginInstaller = { install: vi.fn(), uninstall: vi.fn().mockResolvedValue(undefined) }
    const { service, reg } = createService({ descriptor: makeDescriptor(), installer })
    const terminateWorker = vi.fn().mockResolvedValue(undefined)
    // sandbox 句柄：workerId sandbox- 前缀（PluginHost.getWorkerHandle 从子进程宿主转调所得）
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'sandbox-uninstall-plugin',
      postMessage: vi.fn(),
    })
    reg.host.terminateWorker = terminateWorker

    await service.uninstallPlugin('uninstall-plugin')

    expect(terminateWorker).toHaveBeenCalledTimes(1)
    expect(terminateWorker).toHaveBeenCalledWith('sandbox-uninstall-plugin')
  })

  it('F2-③守卫: trusted 共享 Worker 不 terminate（防误杀同线程其他插件）；无句柄时 no-op', async () => {
    const installer: IPluginInstaller = { install: vi.fn(), uninstall: vi.fn().mockResolvedValue(undefined) }

    // trusted 场景
    const trusted = createService({ descriptor: makeDescriptor({ trustLevel: 'trusted' }), installer })
    const trustedTerminate = vi.fn().mockResolvedValue(undefined)
    trusted.reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'trusted-1',
      postMessage: vi.fn(),
    })
    trusted.reg.host.terminateWorker = trustedTerminate
    await trusted.service.uninstallPlugin('uninstall-plugin')
    expect(trustedTerminate).not.toHaveBeenCalled()

    // 未激活/无进程场景（getWorkerHandle undefined）：不抛
    const idle = createService({ descriptor: makeDescriptor(), installer })
    idle.reg.host.getWorkerHandle = vi.fn().mockReturnValue(undefined)
    await expect(idle.service.uninstallPlugin('uninstall-plugin')).resolves.toBeDefined()
  })

  it('F2-④: uninstall 后 activator 侧描述符/状态清空（防幽灵重激活）', async () => {
    const installer: IPluginInstaller = { install: vi.fn(), uninstall: vi.fn().mockResolvedValue(undefined) }
    const descriptor = makeDescriptor({ activationEvents: ['onStartupFinished'] })
    const { service, reg } = createService({ descriptor, installer })

    // 注册描述符（模拟 initialize 装配），卸载后状态与 eventMap 索引应一并清理
    reg.activator.registerDescriptors([descriptor])
    expect(reg.activator.getState('uninstall-plugin')).toBe('ACTIVE')

    await service.uninstallPlugin('uninstall-plugin')

    expect(reg.activator.getState('uninstall-plugin')).toBeUndefined()
    // eventMap 幽灵索引清理：onStartupFinished 触发时不再命中已卸载插件
    const activateSpy = vi.spyOn(reg.activator, 'activatePlugin')
    await reg.activator.handleEvent({ type: 'onStartupFinished' }, reg.host)
    expect(activateSpy).not.toHaveBeenCalled()
  })
})

describe('PluginService.shutdown flush 时序（F5）', () => {
  let tmpConfigDir: string

  beforeEach(async () => {
    tmpConfigDir = await mkdtemp(join(tmpdir(), 'plugin-shutdown-flush-'))
  })

  afterEach(async () => {
    await rm(tmpConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('F5-①: flushAll 在 dispose 之前完成（清 debounce 定时器前冲刷 dirty 数据）', async () => {
    const { service, reg } = createService({ configDir: tmpConfigDir })
    reg.initialized = true

    const order: string[] = []
    reg.sessionDataStore.flushAll = vi.fn(() => { order.push('sessionData.flushAll') })
    reg.sessionDataStore.dispose = vi.fn(() => { order.push('sessionData.dispose') })
    // storage 未 init（cache null 会 NPE），stub 掉——F5 断言对象是 sessionDataStore
    reg.storage.flushAll = vi.fn(() => { order.push('storage.flushAll') })

    await service.shutdown()

    expect(order).toEqual([
      'sessionData.flushAll',
      'sessionData.dispose',
      'storage.flushAll',
    ])
  })

  it('F5-②: shutdown 前 500ms debounce 窗口内的 sessionData 落盘（用户可见：文件存在且内容正确）', async () => {
    const { service, reg } = createService({ configDir: tmpConfigDir })
    reg.initialized = true
    reg.storage.flushAll = vi.fn(() => {})

    // 写入后立即 shutdown——不 flush 的话 per-write 500ms debounce 内的写入会丢
    reg.sessionDataStore.set('session-1', 'lastKey', 'lastValue')

    await service.shutdown()

    const flushed = JSON.parse(
      await readFile(join(tmpConfigDir, 'session-data', 'session-1.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(flushed['lastKey']).toBe('lastValue')
  })
})
