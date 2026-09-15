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
    const installer: IPluginInstaller = {
      install: vi.fn().mockResolvedValue({ success: true, pluginId: 'pkg', path: '/tmp' }),
      uninstall: vi.fn().mockResolvedValue(undefined),
    }
    const service = createService(installer)

    const result: InstallResult = await service.installPlugin('any-npm-pkg')

    // 翻转后契约：安装放行到 installer port（sandbox 子进程 + ESM loader 兜底隔离）
    expect(result.success).toBe(true)
    expect(installer.install).toHaveBeenCalledTimes(1)
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
