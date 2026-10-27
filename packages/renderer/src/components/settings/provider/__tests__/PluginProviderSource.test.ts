/**
 * PluginProviderSource 单测 —— 工厂函数与拉取链失败降级（失败路径表「warn 可见，保持现状」）。
 *
 * 组件级测试（PluginProviderFlow.test.ts / ProviderPage.test.ts 的 ProviderPage-plugin 节）覆盖正常路径接线；
 * 本文件定点覆盖 source 层的降级分支：
 * - createPluginUiEventSender / createPluginActionExecutor（D8/D7 出口工厂）：直发 +
 *   pluginId 缺省静默 + 发送失败 warn 降级
 * - 拉取链（catalog / plugins / status / authorizeView / detailView）失败 → warn 且缓存
 *   保持现状（辅助域降级不向上抛，S5「不猜测」）
 *
 * mock 策略：SettingsTransport seam 注入（[C3]，不 mock @/api）；usePluginProviderSource
 * 消费点在 effectScope 内（onScopeDispose 需要 scope）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/provider/__tests__/PluginProviderSource.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  createPluginActionExecutor,
  createPluginUiEventSender,
  usePluginProviderSource,
  _resetPluginProviderSourceForTest,
  type PluginProviderSourceReturn,
} from '../PluginProviderSource'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub'

/** 注入带 overrides 的 stub 并返回（断言用同一 vi.fn 引用） */
function stubWith(overrides: Parameters<typeof makeSettingsTransportStub>[0]) {
  const stub = makeSettingsTransportStub(overrides)
  provideSettingsTransport(stub)
  return stub
}

/** effectScope 内消费 source（onScopeDispose 挂当前 scope），返回 scope 与 source */
function consumeSource(): { source: PluginProviderSourceReturn; stop: () => void } {
  const scope = effectScope()
  let source: PluginProviderSourceReturn | undefined
  scope.run(() => {
    source = usePluginProviderSource()
  })
  return { source: source!, stop: () => scope.stop() }
}

beforeEach(() => {
  _resetPluginProviderSourceForTest()
})

describe('createPluginUiEventSender（D8 text-input 值回传出口）', () => {
  it('sendPluginUiEvent reject → warn 降级（回传失败不阻断输入）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendPluginUiEvent = vi.fn(() => Promise.reject(new Error('ws down')))
    stubWith({ sendPluginUiEvent })

    const sender = createPluginUiEventSender(() => 'wool-trae', 'provider.authorize')
    sender.send('pat', 'change', 'v1')
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('uiEvent (wool-trae/provider.authorize/pat) failed'),
        expect.any(Error),
      )
    })

    expect(sendPluginUiEvent).toHaveBeenCalledWith({
      pluginId: 'wool-trae',
      viewId: 'provider.authorize',
      componentId: 'pat',
      event: 'change',
      value: 'v1',
    })
    warn.mockRestore()
  })
})

describe('createPluginActionExecutor（D7/S7 action-bar 命令执行器）', () => {
  it('execute → executePluginCommand 直发（pluginId 取 getter 当前值）', async () => {
    const executePluginCommand = vi.fn(() => Promise.resolve())
    stubWith({ executePluginCommand })

    const executor = createPluginActionExecutor(() => 'wool-trae')
    executor.execute('plugin.cmd', { k: 'v' })
    await vi.waitFor(() => {
      expect(executePluginCommand).toHaveBeenCalledWith({ pluginId: 'wool-trae', commandId: 'plugin.cmd', args: { k: 'v' } })
    })
  })

  it('pluginId getter 为 null → 静默 return（无当前插件，零发送）', () => {
    const executePluginCommand = vi.fn(() => Promise.resolve())
    stubWith({ executePluginCommand })

    const executor = createPluginActionExecutor(() => null)
    executor.execute('plugin.cmd')
    expect(executePluginCommand).not.toHaveBeenCalled()
  })

  it('executePluginCommand reject → warn 降级（命令失败不阻断页面）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const executePluginCommand = vi.fn(() => Promise.reject(new Error('method not registered')))
    stubWith({ executePluginCommand })

    const executor = createPluginActionExecutor(() => 'wool-trae')
    executor.execute('plugin.cmd')
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('executeCommand (wool-trae/plugin.cmd) failed'),
        expect.any(Error),
      )
    })
    warn.mockRestore()
  })
})

describe('拉取链失败降级（warn 可见 + 缓存保持现状，不向上抛）', () => {
  it('refreshCatalog：listAvailable reject → warn，catalog 保持现状', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listAvailablePlugins = vi.fn(() => Promise.reject(new Error('network down')))
    stubWith({ listAvailablePlugins })
    const { source, stop } = consumeSource()
    try {
      await source.refreshCatalog()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listAvailable failed'), expect.any(Error))
      expect(source.catalog.value).toEqual([])
      expect(source.catalogLoaded.value).toBe(false)
    } finally {
      warn.mockRestore()
      stop()
    }
  })

  it('refreshPlugins：listPlugins reject → warn，运行态缓存保持现状', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const listPlugins = vi.fn(() => Promise.reject(new Error('rpc down')))
    stubWith({ listPlugins })
    const { source, stop } = consumeSource()
    try {
      await source.refreshPlugins()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin.list failed'), expect.any(Error))
      expect(source.pluginInfoOf('wool-trae')).toBeUndefined()
    } finally {
      warn.mockRestore()
      stop()
    }
  })

  it('pullStatus：invoke reject（插件崩溃/方法未注册）→ warn，凭据状态不写', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invokePlugin = vi.fn(() => Promise.reject(new Error('method not registered')))
    stubWith({ invokePlugin })
    const { source, stop } = consumeSource()
    try {
      await source.pullStatus('wool-trae', 'provider:wool-trae:main')
      expect(invokePlugin).toHaveBeenCalledWith('wool-trae', 'getStatus', { providerId: 'provider:wool-trae:main' })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('getStatus(wool-trae, provider:wool-trae:main) failed'),
        expect.any(Error),
      )
      expect(source.statusOf('provider:wool-trae:main')).toBeUndefined()
    } finally {
      warn.mockRestore()
      stop()
    }
  })

  it('pullAuthorizeView：invoke reject → warn（容器保持占位空态）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invokePlugin = vi.fn(() => Promise.reject(new Error('plugin crashed')))
    stubWith({ invokePlugin })
    const { source, stop } = consumeSource()
    try {
      await source.pullAuthorizeView('wool-trae')
      expect(invokePlugin).toHaveBeenCalledWith('wool-trae', 'getAuthorizeView', {})
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('getAuthorizeView(wool-trae) failed'),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
      stop()
    }
  })

  it('pullDetailView：invoke reject → warn（扩展区保持空态）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invokePlugin = vi.fn(() => Promise.reject(new Error('plugin crashed')))
    stubWith({ invokePlugin })
    const { source, stop } = consumeSource()
    try {
      await source.pullDetailView('wool-trae')
      expect(invokePlugin).toHaveBeenCalledWith('wool-trae', 'getDetail', {})
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('getDetail(wool-trae) failed'),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
      stop()
    }
  })
})
