/**
 * settings-store 迁移测试（w1 F11 补建）。
 *
 * 覆盖：setSystem 状态合并 + IF3 持久化 + 失败回滚；storage/transport 未注入 fail-fast；
 * setSkillDirs/setAgentDirs/setExtensionDirs 经 IF1 transport 转发；四个乐观 toggle
 * （旧值返回 + state 更新 + 找不到默认返回）；getSettingsStore 惰性单例。
 */
import type { ModelInfo,  ProviderId } from '@taiji/shared'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  provideSettingsTransport,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '../transport'
import { providePlatform, __resetPlatformForTesting } from '../../../platform/port'
import {
  createSettingsStore,
  getSettingsStore,
  __resetSettingsStoreForTesting,
} from '../settings-store'
import { InMemoryStorage } from './helpers/in-memory-storage'
import type { ProviderInfo, ExtensionInfo } from '@taiji/shared'

function makeFakeTransport(): SettingsTransport {
  return {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => [] as ModelInfo[]),
    setScopedModels: vi.fn(async (_models: string[]): Promise<string[]> => []),
    setProvider: vi.fn(async () => {}),
    discoverModels: vi.fn(async () => ({ success: true })),
    setSkillDirs: vi.fn(async () => {}),
    setAgentDirs: vi.fn(async () => {}),
    setExtensionDirs: vi.fn(async () => {}),
    onProviders: vi.fn(() => () => {}),
    onModels: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
  }
}

beforeEach(() => {
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  __resetPlatformForTesting()
})

describe('settings-store setSystem（状态合并 + IF3 持久化 + 失败回滚）', () => {
  it('合并状态 + storage 落盘（SYSTEM_KEY）', async () => {
    const storage = new InMemoryStorage()
    providePlatform({ kind: 'mock', storage, webSocket: { create: () => ({}) as never } })
    const store = createSettingsStore()
    await store.setSystem({ theme: 'light' })
    expect(store.system.value.theme).toBe('light')
    expect(store.system.value.locale).toBe('zh-CN') // 其余字段保留
    const raw = storage.peek('taiji:system-settings')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).theme).toBe('light')
  })

  it('持久化失败 → 还原快照 + throw', async () => {
    const storage = new InMemoryStorage()
    providePlatform({ kind: 'mock', storage, webSocket: { create: () => ({}) as never } })
    const store = createSettingsStore()
    await store.setSystem({ theme: 'dark' }) // 基线（先成功，mock 在基线后生效）
    vi.spyOn(storage, 'set').mockImplementationOnce(async () => {
      throw new Error('disk full')
    })
    await expect(store.setSystem({ theme: 'light' })).rejects.toThrow('disk full')
    expect(store.system.value.theme).toBe('dark') // 回滚到快照
  })
})

describe('settings-store fail-fast', () => {
  it('storage 未注入（未 providePlatform）→ setSystem throw 含 getPlatform', async () => {
    const store = createSettingsStore()
    await expect(store.setSystem({ theme: 'light' })).rejects.toThrow('getPlatform')
  })

  it('transport 未注入 → setSkillDirs throw 含 getSettingsTransport', async () => {
    const storage = new InMemoryStorage()
    providePlatform({ kind: 'mock', storage, webSocket: { create: () => ({}) as never } })
    const store = createSettingsStore()
    await expect(store.setSkillDirs([{ path: '/a', enabled: true, scope: 'global' }])).rejects.toThrow('getSettingsTransport')
  })
})

describe('settings-store 路径配置经 IF1 transport 转发', () => {
  it('setSkillDirs/setAgentDirs/setExtensionDirs 调用对应 transport 方法', async () => {
    const storage = new InMemoryStorage()
    providePlatform({ kind: 'mock', storage, webSocket: { create: () => ({}) as never } })
    const transport = makeFakeTransport()
    provideSettingsTransport(transport)
    const store = createSettingsStore()
    await store.setSkillDirs([{ path: '/skills', enabled: true, scope: 'global' }])
    await store.setAgentDirs([{ path: '/agents', enabled: true, scope: 'global' }])
    await store.setExtensionDirs([{ path: '/ext', enabled: true, scope: 'global' }])
    expect(transport.setSkillDirs).toHaveBeenCalledWith([{ path: '/skills', enabled: true, scope: 'global' }])
    expect(transport.setAgentDirs).toHaveBeenCalledWith([{ path: '/agents', enabled: true, scope: 'global' }])
    expect(transport.setExtensionDirs).toHaveBeenCalledWith([{ path: '/ext', enabled: true, scope: 'global' }])
  })
})

describe('settings-store 乐观 toggle', () => {
  function seedProvider(): ProviderInfo {
    return {
      id: 'p1' as ProviderId,
      name: 'P1',
      apiKeySet: true,
      status: 'connected',
      models: [
        { id: 'm1', name: 'M1', enabled: true },
        { id: 'm2', name: 'M2' },
      ],
      enabled: true,
    }
  }

  it('setProviderEnabled：返回旧值 + state 更新', () => {
    const store = createSettingsStore()
    store.providers.value = [seedProvider()]
    const old = store.setProviderEnabled('p1', false)
    expect(old).toBe(true)
    expect(store.providers.value[0].enabled).toBe(false)
  })

  it('setProviderEnabled：找不到返回 false', () => {
    const store = createSettingsStore()
    expect(store.setProviderEnabled('nope', false)).toBe(false)
  })

  it('setModelEnabled：返回旧值 + 更新目标 model', () => {
    const store = createSettingsStore()
    store.providers.value = [seedProvider()]
    const old = store.setModelEnabled('p1', 'm2', false)
    expect(old).toBe(true) // m2 无 enabled → 默认 true
    expect(store.providers.value[0].models[1].enabled).toBe(false)
    // m1 未动
    expect(store.providers.value[0].models[0].enabled).toBe(true)
  })

  it('setModelEnabled：找不到返回 true（默认启用）', () => {
    const store = createSettingsStore()
    expect(store.setModelEnabled('p1', 'nope', false)).toBe(true)
    expect(store.setModelEnabled('nope', 'm1', false)).toBe(true)
  })

  it('setExtensionEnabled：返回旧值 + 更新', () => {
    const store = createSettingsStore()
    store.extensions.value = [{ name: 'e1', version: '1.0.0' } as ExtensionInfo]
    const old = store.setExtensionEnabled('e1', false)
    expect(old).toBe(true)
    expect(store.extensions.value[0].enabled).toBe(false)
  })

  it('setExtensionEnabled：找不到返回 false', () => {
    const store = createSettingsStore()
    expect(store.setExtensionEnabled('nope', false)).toBe(false)
  })

  it('setExtensionAutoUpgrade：返回旧值 + 更新；找不到返回 false', () => {
    const store = createSettingsStore()
    store.extensions.value = [{ name: 'e1', version: '1.0.0', autoUpgrade: true } as ExtensionInfo]
    const old = store.setExtensionAutoUpgrade('e1', false)
    expect(old).toBe(true)
    expect(store.extensions.value[0].autoUpgrade).toBe(false)
    expect(store.setExtensionAutoUpgrade('nope', true)).toBe(false)
  })
})

describe('getSettingsStore 惰性单例', () => {
  it('两次调用返回同一实例；reset 后新实例', () => {
    const a = getSettingsStore()
    const b = getSettingsStore()
    expect(a).toBe(b)
    __resetSettingsStoreForTesting()
    const c = getSettingsStore()
    expect(c).not.toBe(a)
  })
})