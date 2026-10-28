// @vitest-environment node
import { i18nKeyEchoModule, toastSpyMock, toastSpyModule } from '@/__tests__/helpers/i18n-toast-mock';
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub';
import { useModel } from '@/composables/features/model/useModel';
import { useApiKeyAutoEnable } from '@/composables/features/settings/useApiKeyAutoEnable';
import { useSessionLiveStateStore } from '@/stores/session-live-state';
import { provideSettingsTransport } from '@taiji/core';
import type { ProviderInfo, SessionSummary } from '@taiji/shared';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// wave3 簇 [renderer/node] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/features/use-model.test.ts
 * - __tests__/composables/use-api-key-auto-enable.test.ts
 */

// ======================================================================
// ← __tests__/composables/features/use-model.test.ts
// ======================================================================

const mocks = vi.hoisted(() => ({
  setThinkingLevel: vi.fn(),
  switchModel: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  setThinkingLevel: mocks.setThinkingLevel,
}))
vi.mock('@taiji/core/transport/api/domains/model', () => ({
  switchModel: mocks.switchModel,
  onModels: vi.fn(() => () => {}),
  listModels: vi.fn(),
}))

// 门面重定向（api index → domains，与 submit-firstmessage-pull.test.ts 同款）
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  const model = await import('@taiji/core/transport/api/domains/model')
  return { ...actual, session, model }
})

const { setThinkingLevel: setThinkingLevelMock, switchModel: switchModelMock } = mocks

/**
 * 播种状态层已有值（模拟「已观测到旧真值」的会话）。
 * [W1] 状态权威 = 状态层；列表条目不再承载 modelId/thinkingLevel。
 */
function seedLiveState(id: string, patch: { modelId?: string; thinkingLevel?: string }): void {
  useSessionLiveStateStore().applyLiveState(id, patch)
}

describe('useModel.setThinkingLevel 回执消费（U6 弃乐观写）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setThinkingLevelMock.mockReset()
    switchModelMock.mockReset()
  })

  it('请求 max 被 pi 钳制为 high → 状态层 thinkingLevel 写回执生效值 high（非请求值）', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/mimo', thinkingLevel: 'medium' })
    setThinkingLevelMock.mockResolvedValue({ sessionId: 's1', level: 'high' })

    const { setThinkingLevel } = useModel()
    await setThinkingLevel('s1', 'max')

    expect(setThinkingLevelMock).toHaveBeenCalledWith('s1', 'max')
    // 核心断言：显示值 = 回执生效值（pi get_state 读回），不是乐观写的请求值 max
    expect(liveStore.liveStateOf('s1')).toEqual({ modelId: 'p/mimo', thinkingLevel: 'high' })
  })

  it('生效值与请求值一致 → 写请求值（回执与请求同值的常态路径）', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/m', thinkingLevel: 'off' })
    setThinkingLevelMock.mockResolvedValue({ sessionId: 's1', level: 'high' })

    const { setThinkingLevel } = useModel()
    await setThinkingLevel('s1', 'high')

    expect(liveStore.liveStateOf('s1')?.thinkingLevel).toBe('high')
  })

  it('RPC 失败 → 状态层不写（显示保持旧真值，无乐观写路径）', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/m', thinkingLevel: 'low' })
    setThinkingLevelMock.mockRejectedValue(new Error('rpc failed'))

    const { setThinkingLevel } = useModel()
    await expect(setThinkingLevel('s1', 'max')).rejects.toThrow('rpc failed')

    // 失败不落显示态：保持旧值 low，绝不出现请求值 max 的假显示
    expect(liveStore.liveStateOf('s1')).toEqual({ modelId: 'p/m', thinkingLevel: 'low' })
  })

  it('[W1] 列表外的会话 id（btw 线 session id）同样写状态层——无 id 类别分支', async () => {
    const liveStore = useSessionLiveStateStore()
    setThinkingLevelMock.mockResolvedValue({ sessionId: 'pi-x', level: 'high' })

    const { setThinkingLevel } = useModel()
    await setThinkingLevel('pi-x', 'max')

    expect(liveStore.liveStateOf('pi-x')).toEqual({ thinkingLevel: 'high' })
  })
})

describe('useModel.switchModel 回执消费（U6/C-pi-13 弃乐观写）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setThinkingLevelMock.mockReset()
    switchModelMock.mockReset()
  })

  it('pi pattern 换模（reply 生效值 ≠ 请求值）→ modelId 写回执生效值，非请求值乐观写', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/old' })
    // runtime set→get_state 读回：请求 glm-5.3，pi 实际切到同族 glm-5.3-air（事故 A 形态）
    switchModelMock.mockResolvedValue({ sessionId: 's1', provider: 'p', modelId: 'glm-5.3-air' })

    const { switchModel } = useModel()
    await switchModel('s1', 'p', 'glm-5.3')

    expect(switchModelMock).toHaveBeenCalledWith('s1', 'p', 'glm-5.3')
    // 核心断言：显示值 = 回执生效值（runtime get_state 读回），不是请求值 glm-5.3
    expect(liveStore.liveStateOf('s1')?.modelId).toBe('p/glm-5.3-air')
  })

  it('生效值与请求值一致 → 写请求复合串（常态路径）', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/old' })
    switchModelMock.mockResolvedValue({ sessionId: 's1', provider: 'p', modelId: 'new' })

    const { switchModel } = useModel()
    await switchModel('s1', 'p', 'new')

    expect(liveStore.liveStateOf('s1')?.modelId).toBe('p/new')
  })

  it('RPC 失败 → 状态层不写（显示保持旧真值，无乐观写路径）', async () => {
    const liveStore = useSessionLiveStateStore()
    seedLiveState('s1', { modelId: 'p/old' })
    switchModelMock.mockRejectedValue(new Error('rpc failed'))

    const { switchModel } = useModel()
    await expect(switchModel('s1', 'p', 'new')).rejects.toThrow('rpc failed')

    expect(liveStore.liveStateOf('s1')?.modelId).toBe('p/old')
  })
})

// ======================================================================
// ← __tests__/composables/use-api-key-auto-enable.test.ts
// ======================================================================

const configMock = vi.hoisted(() => ({
  toggleProviderEnabled: vi.fn(async () => {}),
}))

const settingsStoreStub = vi.hoisted(() => ({
  setProviderEnabled: vi.fn(() => true),
  // 普通对象即可（composable 只读写 .value；vi.hoisted 先于 import 执行不能用 ref）
  defaultModel: { value: '' },
}))

// [C3] toggleProviderEnabled 经 SettingsTransport seam 桩注入（替换原 @/api 门面 mock）

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  getSettingsStore: () => settingsStoreStub,
}))

// t = key 回显 + name 拼接（toast 断言验证插值确有传入）；useToast → toastSpyMock 单例
vi.mock('@/i18n', () => i18nKeyEchoModule())
vi.mock('@/composables/useToast', () => toastSpyModule())

/** 被禁用但 apikey 凭据已就绪的 provider（自动启用的目标形态） */
const DISABLED_PROVIDER: ProviderInfo = {
  id: 'zai-coding-cn',
  name: 'Z.AI Coding CN',
  apiKeySet: true,
  status: 'connected',
  enabled: false,
  models: [],
}

let actionError = ''
let providers: ProviderInfo[]

function mountApi() {
  return useApiKeyAutoEnable({
    providers: () => providers,
    setActionError: msg => { actionError = msg },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  actionError = ''
  settingsStoreStub.defaultModel.value = ''
  settingsStoreStub.setProviderEnabled.mockReset()
  settingsStoreStub.setProviderEnabled.mockReturnValue(true)
  providers = [{ ...DISABLED_PROVIDER }]
  provideSettingsTransport(makeSettingsTransportStub(configMock))
})

describe('afterApiKeySave 判定矩阵', () => {
  it('wroteApiKey=false（只改配置不动凭据/清除 key）→ 不启用，尊重此前的禁用意图', async () => {
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', false)
    expect(configMock.toggleProviderEnabled).not.toHaveBeenCalled()
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('provider 不在列表（新建，broadcast 未回——runtime ensureProviderInWhitelist 已启用）→ 不启用', async () => {
    const api = mountApi()
    await api.afterApiKeySave('qwen-token-plan', true)
    expect(configMock.toggleProviderEnabled).not.toHaveBeenCalled()
  })

  it('已启用 → no-op（幂等，白名单空=全启用语义）', async () => {
    providers = [{ ...DISABLED_PROVIDER, enabled: true }]
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', true)
    expect(configMock.toggleProviderEnabled).not.toHaveBeenCalled()
  })

  it('未启用 + wroteApiKey → toggleProviderEnabled(id, true) + 乐观更新 + toast', async () => {
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', true)
    expect(settingsStoreStub.setProviderEnabled).toHaveBeenCalledWith('zai-coding-cn', true)
    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('zai-coding-cn', true)
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.provider.autoEnabledToast:Z.AI Coding CN')
  })

  it('自动启用失败 → 乐观更新回滚（旧值还原）+ setActionError + 不 toast', async () => {
    configMock.toggleProviderEnabled.mockRejectedValueOnce(new Error('rpc down'))
    settingsStoreStub.setProviderEnabled.mockReturnValueOnce(false) // 旧值：禁用
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', true)
    expect(settingsStoreStub.setProviderEnabled).toHaveBeenNthCalledWith(1, 'zai-coding-cn', true)
    expect(settingsStoreStub.setProviderEnabled).toHaveBeenNthCalledWith(2, 'zai-coding-cn', false)
    expect(actionError).toBe('rpc down')
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })
})

describe('onToggleEnabled 手动开关链路回归（wave4 C1 搬迁）', () => {
  it('防重入：toggling 命中时 no-op 返回 false', async () => {
    const api = mountApi()
    let release!: () => void
    configMock.toggleProviderEnabled.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const first = api.onToggleEnabled(DISABLED_PROVIDER, true)
    const second = await api.onToggleEnabled(DISABLED_PROVIDER, true) // 重入被 toggling 拦截
    expect(second).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(configMock.toggleProviderEnabled).toHaveBeenCalledTimes(1)
  })

  it('disable 成功且 defaultModel 承载该 provider → defaultModel 清空', async () => {
    settingsStoreStub.defaultModel.value = 'zai-coding-cn/glm-5.3'
    const api = mountApi()
    expect(await api.onToggleEnabled(DISABLED_PROVIDER, false)).toBe(true)
    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('zai-coding-cn', false)
    expect(settingsStoreStub.defaultModel.value).toBe('')
  })
})
