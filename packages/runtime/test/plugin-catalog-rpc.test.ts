/**
 * plugin.listAvailable / plugin.catalog RPC 往返单测（provider-plugin-access U5+F3，
 * 验收⑤：core domain 方法 → runtime 注册 → 返回清单条目）：
 *
 * - runtime 注册段（PluginService 真实装配）：清单 service 端口（registry descriptors
 *   → 本地已装版本）+ 清单条目组装（remote-config 层 mock 注入 fixture 清单）→
 *   listAvailablePlugins 返回可安装视图（installed 比对 / updateAvailable）；
 *   getPluginCatalog 返回原始条目。
 * - 无缓存且拉取失败（fail-safe 链尾）：available=false → reply 空清单（S15②，UI
 *   整页报错语义的 runtime 侧形态）。
 * - core domain 方法（invokePlugin / listAvailablePlugins / getPluginCatalog 的
 *   WS 帧面）与 mock 域同步由 message-handler 帧测试 + G4 类型锚定（tsc 编译期）
 *   承载；本文件覆盖 runtime 段往返。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-catalog-rpc.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// remote-config 层 mock（清单 fail-safe 链的网络/缓存细节不在本单测范围——service 层
// 语义由 plugin-catalog.test.ts 覆盖，本文件只验 RPC 通路装配与 reply 组装）。
const refreshRemoteConfigMock = vi.fn()
const loadRemoteConfigMock = vi.fn()

vi.mock('../src/services/remote-config/remote-config-fetch.js', () => ({
  refreshRemoteConfig: (...args: unknown[]) => refreshRemoteConfigMock(...args),
  loadRemoteConfig: (...args: unknown[]) => loadRemoteConfigMock(...args),
}))

import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { PluginCatalogEntry } from '@taiji/shared'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

const CATALOG_ENTRY: PluginCatalogEntry = {
  packageName: '@acme/plugin-wool-workbuddy',
  pluginId: 'wool-workbuddy',
  displayName: 'WorkBuddy',
  pluginVersion: '1.1.0',
  family: {
    id: 'wool-workbuddy',
    displayName: 'WorkBuddy',
    vendor: '腾讯',
    credentialSource: 'oauth',
    modelCount: 17,
  },
}

/** 已装描述符（版本唯一事实 = descriptor.version，D11） */
const DESCRIPTORS: PluginDescriptor[] = [
  { pluginId: 'wool-workbuddy', pluginPath: '/tmp/plugins/wool-workbuddy', version: '1.0.0' } as PluginDescriptor,
]

function wiredService() {
  const registry = {
    getDescriptor: (pluginId: string) => DESCRIPTORS.find((d) => d.pluginId === pluginId),
    getAllDescriptors: () => DESCRIPTORS,
  }
  return new PluginService(registry as never, createMockBroker(), {})
}

describe('plugin.listAvailable RPC 通路（U5+F3）', () => {
  beforeEach(() => {
    refreshRemoteConfigMock.mockReset()
    loadRemoteConfigMock.mockReset()
  })

  it('清单条目 ⊕ 本地已装版本 → 可安装视图（installed / installedVersion / updateAvailable）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: { version: 1, plugins: [CATALOG_ENTRY] },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    expect(reply.plugins).toHaveLength(1)
    const entry = reply.plugins[0]
    expect(entry.installed).toBe(true)
    expect(entry.installedVersion).toBe('1.0.0')
    // 清单 1.1.0 > 已装 1.0.0 → 更新提示（S26 数据源）
    expect(entry.updateAvailable).toBe(true)
    expect(entry.displayName).toBe('WorkBuddy')
    expect(entry.family?.modelCount).toBe(17)
  })

  it('未安装条目 → installed=false（无 installedVersion / updateAvailable 字段）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: {
        version: 1,
        plugins: [{ ...CATALOG_ENTRY, pluginId: 'wool-trae', packageName: '@acme/plugin-wool-trae', pluginVersion: '2.0.0' }],
      },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    expect(reply.plugins[0]).toEqual({
      packageName: '@acme/plugin-wool-trae',
      pluginId: 'wool-trae',
      displayName: 'WorkBuddy',
      pluginVersion: '2.0.0',
      family: CATALOG_ENTRY.family,
      installed: false,
    })
  })

  it('fail-safe 链尾（无缓存且拉取失败）→ 空清单（available=false 语义的 runtime 形态，S15②）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({ data: undefined, refreshed: false, reason: 'network' })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    expect(reply.plugins).toEqual([])
  })
})

describe('plugin.catalog RPC 通路（U5+F3）', () => {
  beforeEach(() => {
    refreshRemoteConfigMock.mockReset()
    loadRemoteConfigMock.mockReset()
  })

  it('返回清单原始目录条目（含家族元数据，无安装状态比对）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: { version: 1, plugins: [CATALOG_ENTRY] },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.getPluginCatalog()

    expect(reply.entries).toEqual([CATALOG_ENTRY])
  })
})
