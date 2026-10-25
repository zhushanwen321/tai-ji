import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import {
  EXTERNAL_PLUGIN_ENABLED,
  EXTERNAL_PLUGIN_DISABLED,
  EXTERNAL_PLUGIN_DISABLED_MESSAGE,
} from '../src/services/plugin-service/plugin-security.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IPluginInstaller, InstallResult } from '../src/services/ports/plugin-installer.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as IMessageBroker
}

function createService(installer: IPluginInstaller): PluginService {
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  return new PluginService(registry, createMockBroker(), { pluginInstaller: installer })
}

describe('external plugin install hard lock（§6.6 排期硬锁）', () => {
  it('TC-1: EXTERNAL_PLUGIN_ENABLED=true（sandbox 闭环已落地）时 installPlugin 放行到 installer', async () => {
    // U4 两段式：直通 installPlugin = prepareInstall → commitInstall（+ 激活终态判定）
    const installer: IPluginInstaller = {
      prepareInstall: vi.fn().mockResolvedValue({
        success: true,
        prepared: {
          dirName: 'scope__pkg',
          packageName: '@scope/pkg',
          version: '1.0.0',
          stagingPath: '/tmp/.staging/scope__pkg',
          capabilities: [],
          readPaths: [],
          permissions: [],
        },
      }),
      commitInstall: vi.fn().mockResolvedValue({ success: true, pluginId: 'scope__pkg', path: '/tmp' }),
      rollbackInstall: vi.fn().mockResolvedValue(undefined),
      discardReplaced: vi.fn().mockResolvedValue(undefined),
      sweepStaging: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const service = createService(installer)
    // 激活链 mock：activatePlugin 对无 descriptor 插件 no-op resolve；getState 恒 ACTIVE；
    // registry 空（/tmp/fake-project 不存在）→ descriptor mock 供提交段存在性检查
    vi.spyOn(service.activator, 'activatePlugin').mockResolvedValue(undefined)
    vi.spyOn(service.activator, 'getState').mockReturnValue('ACTIVE')
    vi.spyOn(service.registry, 'getDescriptor').mockReturnValue({
      pluginId: 'scope__pkg',
      version: '1.0.0',
      displayName: 'scope__pkg',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'sandbox',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { taiji: '*' },
      pluginPath: '/tmp/scope__pkg/index.js',
      source: 'external',
      extensionDependencies: [],
    })

    const result: InstallResult = await service.installPlugin('any-npm-pkg')

    // 翻转后契约：安装放行到 installer port（sandbox 子进程 + ESM loader 兜底隔离）
    expect(result.success).toBe(true)
    expect(installer.prepareInstall).toHaveBeenCalledTimes(1)
    expect(installer.commitInstall).toHaveBeenCalledTimes(1)
    // 硬锁文案常量仍导出（开关回退 false 时复用）
    expect(EXTERNAL_PLUGIN_DISABLED).toBe('EXTERNAL_PLUGIN_DISABLED')
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain(EXTERNAL_PLUGIN_DISABLED)
  })

  it('TC-2: 常量契约 —— EXTERNAL_PLUGIN_ENABLED 已翻转 true（sandbox 真隔离闭环）、错误码与文案常量导出', () => {
    // 翻转记录见 plugin-security.ts [翻转记录]：fork 子进程 + ESM loader 注入 + env 边界判定
    // + postbuild 产物校验四环齐备，external 安装放行。任一环节回退须同步翻回 false。
    expect(EXTERNAL_PLUGIN_ENABLED).toBe(true)
    expect(EXTERNAL_PLUGIN_DISABLED).toBe('EXTERNAL_PLUGIN_DISABLED')
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain(EXTERNAL_PLUGIN_DISABLED)
    expect(EXTERNAL_PLUGIN_DISABLED_MESSAGE).toContain('sandbox isolation')
  })
})
