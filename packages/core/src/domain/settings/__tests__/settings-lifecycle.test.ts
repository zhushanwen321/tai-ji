/**
 * settings-lifecycle 迁移测试（W2 核心测试 1）。
 *
 * 覆盖：init 幂等守卫（两次 init 只注册一次订阅）；11 条订阅全部注册且 handler 写 store
 * （fake transport 捕获订阅 + 手动触发 handler 验证 store 更新）；system 初始化从 storage
 * 读并 setSystem 持久化；refreshProviders 成功/失败分支；dispose 清订阅 + 守卫复位；
 * transport 未注入 fail-fast。
 */
import type { ProviderId } from '@taiji/shared'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { providePlatform, __resetPlatformForTesting } from '../../../platform/port'
import {
  provideSettingsTransport,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
} from '../transport'
import { __resetSettingsStoreForTesting, getSettingsStore } from '../settings-store'
import { useSettings } from '../settings-lifecycle'
import { InMemoryStorage } from './helpers/in-memory-storage'
import { SYSTEM_KEY } from '../system-storage'
import type { ProviderInfo, SkillInfo, AgentInfo, ExtensionInfo } from '@taiji/shared'
import { SCOPED_MODEL_CORE_TOKEN } from './impl-token'

/**
 * fake transport：记录 on* 订阅注册（handler 存表，测试手动触发）。
 * on* 返回取消函数（记录被调）。
 */
function makeRecordingTransport() {
  const handlers: Record<string, (arg0: unknown, arg1?: unknown) => void> = {}
  const unsubs: Array<() => void> = []
  // register 返回 vi.fn：外层可断言订阅注册次数；调用时存 handler + 返回 unsub spy
  const register = (name: string) => vi.fn((h: (a: unknown, b?: unknown) => void) => {
    handlers[name] = h
    const unsub = vi.fn(() => {})
    unsubs.push(unsub)
    return unsub
  })
  const transport: SettingsTransport = {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    setProvider: vi.fn(async () => {}),
    setScopedModels: vi.fn(async () => [] as string[]),
    discoverModels: vi.fn(async () => ({ success: true })),
    setSkillDirs: vi.fn(async () => {}),
    setAgentDirs: vi.fn(async () => {}),
    setExtensionDirs: vi.fn(async () => {}),
    onProviders: register('providers'),
    onModels: register('models'),
    onSkills: register('skills'),
    onAgents: register('agents'),
    onExtensions: register('extensions'),
    onSkillDirs: register('skillDirs'),
    onAgentDirs: register('agentDirs'),
    onExtensionDirs: register('extensionDirs'),
    onDefaults: register('defaults'),
    onSystemPrompt: register('systemPrompt'),
    onTerminalConfig: register('terminalConfig'),
  }
  return { transport, handlers, unsubs }
}

function provideBase() {
  const storage = new InMemoryStorage()
  providePlatform({ kind: 'mock', storage, webSocket: { create: () => ({}) as never } })
  return storage
}

beforeEach(() => {
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  __resetPlatformForTesting()
  useSettings().resetSettingsInit()
})

describe('init 幂等守卫', () => {
  it('两次 init 只注册一次订阅（11 条 on* 各调一次）', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    await init()
    expect(transport.onProviders).toHaveBeenCalledTimes(1)
    expect(transport.onModels).toHaveBeenCalledTimes(1)
    expect(transport.onSkills).toHaveBeenCalledTimes(1)
    expect(transport.onAgents).toHaveBeenCalledTimes(1)
    expect(transport.onExtensions).toHaveBeenCalledTimes(1)
    expect(transport.onSkillDirs).toHaveBeenCalledTimes(1)
    expect(transport.onAgentDirs).toHaveBeenCalledTimes(1)
    expect(transport.onExtensionDirs).toHaveBeenCalledTimes(1)
    expect(transport.onDefaults).toHaveBeenCalledTimes(1)
    expect(transport.onSystemPrompt).toHaveBeenCalledTimes(1)
    expect(transport.onTerminalConfig).toHaveBeenCalledTimes(1)
  })

  it('dispose 后守卫复位，可重新 init 注册', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init, dispose } = useSettings()
    await init()
    dispose()
    await init()
    expect(transport.onProviders).toHaveBeenCalledTimes(2)
  })
})

describe('11 条订阅注册 + handler 写 store', () => {
  it('触发各订阅 handler → store 对应 state 更新', async () => {
    provideBase()
    const { transport, handlers } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    const store = getSettingsStore()

    const p: ProviderInfo = { id: 'p1' as ProviderId, name: 'P1', apiKeySet: false, status: 'connected', models: [] }
    handlers.providers([p], ['openai/gpt-4o', 'deepseek/v3'])
    expect(store.providers.value).toEqual([p])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'deepseek/v3'])

    handlers.models([{ id: 'm1', name: 'M1', providerId: 'p1', providerName: 'P1' }])
    expect(store.models.value).toHaveLength(1)

    const s: SkillInfo = { id: 's1', name: 'S1', version: '1.0.0' } as unknown as SkillInfo
    handlers.skills([s])
    expect(store.skills.value).toEqual([s])

    const a: AgentInfo = { id: 'a1', name: 'A1', version: '1.0.0' } as unknown as AgentInfo
    handlers.agents([a])
    expect(store.agents.value).toEqual([a])

    const e: ExtensionInfo = { name: 'e1', version: '1.0.0' } as ExtensionInfo
    handlers.extensions([e])
    expect(store.extensions.value).toEqual([e])

    handlers.skillDirs([{ path: '/d', enabled: true }])
    expect(store.skillDirs.value).toHaveLength(1)

    handlers.agentDirs([{ path: '/d2', enabled: false }])
    expect(store.agentDirs.value).toHaveLength(1)

    handlers.extensionDirs([{ path: '/d3', enabled: true }])
    expect(store.extensionDirs.value).toHaveLength(1)

    handlers.defaults('p1/m1')
    expect(store.defaultModel.value).toBe('p1/m1')

    handlers.systemPrompt({ version: 1, replace: { enabled: true, prompt: 'x' }, append: { enabled: false, prompt: '' } }, false)
    expect(store.systemPromptConfig.value?.config.replace.prompt).toBe('x')
    expect(store.systemPromptConfig.value?.corrupted).toBe(false)

    handlers.terminalConfig({ shell: '/bin/zsh', shellArgs: [], fontSize: 14, fontFamily: 'mono', scrollback: 1000, cursorStyle: 'block' }, false)
    expect(store.terminalConfig.value?.config.shell).toBe('/bin/zsh')
  })
})

describe('system 初始化（IF3）', () => {
  it('从 storage 读 system → store.setSystem 合并 + 持久化', async () => {
    const storage = provideBase()
    storage.set(SYSTEM_KEY, JSON.stringify({ theme: 'light', locale: 'en-US' }))
    const { transport } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    const store = getSettingsStore()
    expect(store.system.value.theme).toBe('light')
    expect(store.system.value.locale).toBe('en-US')
    // setSystem 内部经 IF3 updateSystem 写回（幂等持久化）
    const raw = storage.peek(SYSTEM_KEY)
    expect(JSON.parse(raw!).theme).toBe('light')
  })

  it('storage 无数据 → DEFAULT_SYSTEM', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    const store = getSettingsStore()
    expect(store.system.value.theme).toBe('dark')
    expect(store.system.value.locale).toBe('zh-CN')
  })
})

describe('refreshProviders 分支', () => {
  it('成功：listProviders 结果写 store.providers', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: 'p1' as ProviderId, name: 'P1', apiKeySet: false, status: 'connected', models: [] }],
    })
    provideSettingsTransport(transport)
    const { refreshProviders } = useSettings()
    await refreshProviders()
    const store = getSettingsStore()
    expect(store.providers.value).toHaveLength(1)
    expect(store.providers.value[0].id).toBe('p1')
  })

  it('D7: reply 含 scopedModels → store.scopedModels 同步填充', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: 'p1', name: 'P1', apiKeySet: false, status: 'connected', models: [] }],
      scopedModels: ['openai/gpt-4o', 'deepseek/v3'],
    })
    provideSettingsTransport(transport)
    const { refreshProviders } = useSettings()
    await refreshProviders()
    const store = getSettingsStore()
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'deepseek/v3'])
  })

  it('D7: reply 不含 scopedModels（undefined）→ store 已有值不被覆盖', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listProviders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: 'p1', name: 'P1', apiKeySet: false, status: 'connected', models: [] }],
    })
    provideSettingsTransport(transport)
    const store = getSettingsStore()
    store.scopedModels.value = ['openai/gpt-4o']
    const { refreshProviders } = useSettings()
    await refreshProviders()
    // undefined 不覆盖（对齐 onProviders handler 的守卫语义），由广播通道兜底推回
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })

  it('失败：不抛错（console.warn 兜底）', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listProviders as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'))
    provideSettingsTransport(transport)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { refreshProviders } = useSettings()
    await expect(refreshProviders()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('refreshModels 分支', () => {
  it('成功：listModels 结果写 store.models', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'm1', name: 'M1', providerId: 'p1', providerName: 'P1' },
    ])
    provideSettingsTransport(transport)
    const { refreshModels } = useSettings()
    await refreshModels()
    const store = getSettingsStore()
    expect(store.models.value).toHaveLength(1)
    expect(store.models.value[0].id).toBe('m1')
  })

  it('失败：不抛错（console.warn 兜底）', async () => {
    provideBase()
    const { transport } = makeRecordingTransport()
    ;(transport.listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'))
    provideSettingsTransport(transport)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { refreshModels } = useSettings()
    await expect(refreshModels()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('dispose 清理', () => {
  it('dispose 调用全部取消函数', async () => {
    provideBase()
    const { transport, unsubs } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init, dispose } = useSettings()
    await init()
    expect(unsubs.length).toBe(11)
    dispose()
    unsubs.forEach((u) => expect(u).toHaveBeenCalled())
  })
})

describe('transport 未注入 fail-fast', () => {
  it('init 前未 provideSettingsTransport → throw 含 getSettingsTransport', async () => {
    provideBase()
    const { init } = useSettings()
    await expect(init()).rejects.toThrow('getSettingsTransport')
  })
})

describe('A4: onProviders 推送 scopedModels 时 store 更新', () => {
  it('A4: impl-token 存在（红阶段区分力守卫）', () => {
    expect(SCOPED_MODEL_CORE_TOKEN).toBe('scoped-model-core-v1')
  })

  it('A4: onProviders handler 含 scopedModels → store.scopedModels 更新', async () => {
    provideBase()
    const { transport, handlers } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    const store = getSettingsStore()
    expect(store.scopedModels.value).toEqual([])

    // 触发 onProviders handler 带 scopedModels → store 更新
    const p: ProviderInfo = { id: 'openai' as ProviderId, name: 'OpenAI', apiKeySet: true, status: 'connected', models: [] }
    handlers.providers([p], ['openai/gpt-4o', 'openai/gpt-4o-mini'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])

    // 不含 scopedModels（undefined）时 store 保持原值
    handlers.providers([p])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini'])
  })

  it('A4: onProviders handler scopedModels=undefined 不覆盖已有值', async () => {
    provideBase()
    const { transport, handlers } = makeRecordingTransport()
    provideSettingsTransport(transport)
    const { init } = useSettings()
    await init()
    const store = getSettingsStore()

    // 先推一次带 scopedModels
    handlers.providers([], ['openai/gpt-4o'])
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])

    // 再推一次不带 scopedModels（undefined）→ 不覆盖
    handlers.providers([], undefined)
    expect(store.scopedModels.value).toEqual(['openai/gpt-4o'])
  })
})
