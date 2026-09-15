/**
 * useApiKeyAutoEnable composable 单测（apikey 配置完成即自动启用）。
 *
 * 覆盖：
 * - afterApiKeySave 判定矩阵：wroteApiKey=false（只改配置不动凭据）不启用；provider
 *   不在列表（新建，runtime ensure 已管）不启用；已启用不启用（幂等）；未启用 +
 *   wroteApiKey → config.toggleProviderEnabled(id, true) + toast
 * - 自动启用失败路径：RPC reject → 乐观更新回滚（setProviderEnabled 二次调用还原旧值）
 *   + setActionError 上报 + 不 toast
 * - onToggleEnabled 手动开关链路回归（wave4 C1 搬迁）：防重入（toggling 命中 no-op）；
 *   disable 且 defaultModel 承载该 provider → defaultModel 清空
 *
 * mock 策略：vi.mock('@/api')（toggleProviderEnabled）+ partial mock '@taiji/core'
 * （getSettingsStore → stub）+ '@/i18n'（t 返回 key 本身）+ '@/composables/useToast'。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-api-key-auto-enable.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProviderInfo } from '@taiji/shared'

const configMock = vi.hoisted(() => ({
  toggleProviderEnabled: vi.fn(async () => {}),
}))

const settingsStoreStub = vi.hoisted(() => ({
  setProviderEnabled: vi.fn(() => true),
  // 普通对象即可（composable 只读写 .value；vi.hoisted 先于 import 执行不能用 ref）
  defaultModel: { value: '' },
}))

const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  getSettingsStore: () => settingsStoreStub,
}))

vi.mock('@/i18n', () => ({
  // t 返回 key；带 params 时拼接 name，让 toast 断言能验证插值确有传入
  default: { global: { t: (key: string, params?: Record<string, unknown>) =>
    params?.name ? `${key}:${String(params.name)}` : key } },
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

import { useApiKeyAutoEnable } from '@/composables/features/settings/useApiKeyAutoEnable'

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
})

describe('afterApiKeySave 判定矩阵', () => {
  it('wroteApiKey=false（只改配置不动凭据/清除 key）→ 不启用，尊重此前的禁用意图', async () => {
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', false)
    expect(configMock.toggleProviderEnabled).not.toHaveBeenCalled()
    expect(toastMock.info).not.toHaveBeenCalled()
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
    expect(toastMock.info).toHaveBeenCalledWith('settings.provider.autoEnabledToast:Z.AI Coding CN')
  })

  it('自动启用失败 → 乐观更新回滚（旧值还原）+ setActionError + 不 toast', async () => {
    configMock.toggleProviderEnabled.mockRejectedValueOnce(new Error('rpc down'))
    settingsStoreStub.setProviderEnabled.mockReturnValueOnce(false) // 旧值：禁用
    const api = mountApi()
    await api.afterApiKeySave('zai-coding-cn', true)
    expect(settingsStoreStub.setProviderEnabled).toHaveBeenNthCalledWith(1, 'zai-coding-cn', true)
    expect(settingsStoreStub.setProviderEnabled).toHaveBeenNthCalledWith(2, 'zai-coding-cn', false)
    expect(actionError).toBe('rpc down')
    expect(toastMock.info).not.toHaveBeenCalled()
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
