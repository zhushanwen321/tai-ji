/**
 * session-model-guards 三谓词直测（MF-4-2）：`Model not found` 三型分型的两判 +
 * 激活上界 env 解析。此前仅经消费面（session-model-control）注入 mock 间接覆盖，
 * 谓词本体分支从未被测试执行——本文件直测分支矩阵：
 *
 * - isModelInRegistry：null configService fail-open / provider 缺失 / model 缺失 /
 *   命中 / listProviders 抛错 fail-open（warn 有痕）
 * - providerHasCredential：null fail-open / provider 缺失 / apiKeySet /
 *   ambient / env_var（凭据由 pi 运行时解析，taiji 侧看不到值）/ 皆非 /
 *   抛错 fail-open（warn 有痕）
 * - resolveActivateTimeoutMs：缺省默认 / 非有限值（'abc'/'NaN'/'Infinity'）回落 /
 *   数值透传 / ≤0 不限时逃生门 / 空串现状锁定（见对应用例注释）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS, TAIJI_SESSION_ACTIVATE_TIMEOUT_MS } from '@taiji/shared'
import { isModelInRegistry, providerHasCredential, resolveActivateTimeoutMs } from '../session-model-guards.js'
import type { IConfigService } from '../../../interfaces.js'

/** 被测函数消费的最小 provider 形态（ProviderInfo 的子集，避免构造无关字段）。 */
interface ProviderStub {
  id: string
  models?: Array<{ id: string }>
  apiKeySet?: boolean
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
}

/**
 * 最小 configService stub——只实装被测函数消费的 listProviders()。
 * IConfigService 是大型接口，测试只注入单一依赖面（与消费面测试的注入风格一致）。
 */
function makeConfigService(
  providers: ProviderStub[],
  listProvidersImpl?: () => ProviderStub[],
): IConfigService {
  return {
    listProviders: listProvidersImpl ?? (() => providers),
  } as unknown as IConfigService
}

/** console.warn spy 集中管理（fail-open 腿断言有痕 + 不污染测试输出）。 */
let warnSpy: ReturnType<typeof vi.spyOn> | undefined

afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
})

function stubWarn(): ReturnType<typeof vi.spyOn> {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return warnSpy
}

describe('isModelInRegistry — 注册表投影判定', () => {
  it('configService 未注入（null）→ true（fail-open，落双因文案）', () => {
    expect(isModelInRegistry(null, 'p1', 'm1')).toBe(true)
  })

  it('provider 不在 listProviders → false（真不在注册表）', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }] }])
    expect(isModelInRegistry(cs, 'p1', 'm1')).toBe(false)
  })

  it('provider 在但 model 不在 → false', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }, { id: 'm3' }] }])
    expect(isModelInRegistry(cs, 'p2', 'm9')).toBe(false)
  })

  it('provider 与 model 均命中 → true', () => {
    const cs = makeConfigService([{ id: 'p2', models: [{ id: 'm2' }, { id: 'm3' }] }])
    expect(isModelInRegistry(cs, 'p2', 'm3')).toBe(true)
  })

  it('listProviders 抛错 → catch fail-open true，且 console.warn 有痕', () => {
    const warn = stubWarn()
    const cs = makeConfigService([], () => {
      throw new Error('catalog read failed')
    })
    expect(isModelInRegistry(cs, 'p1', 'm1')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('model registry check failed (fail-open)'),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog read failed'))
  })
})

describe('providerHasCredential — 凭据齐备判定', () => {
  it('configService 未注入（null）→ true（fail-open）', () => {
    expect(providerHasCredential(null, 'p1')).toBe(true)
  })

  it('provider 缺失 → false', () => {
    const cs = makeConfigService([{ id: 'p2' }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('apiKeySet=true → true（apiKey 落盘，authMethod 无关）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: true }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 但 authMethod=ambient → true（凭据由 pi 运行时解析）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'ambient' }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 但 authMethod=env_var → true（$ENV 引用形态）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'env_var' }])
    expect(providerHasCredential(cs, 'p1')).toBe(true)
  })

  it('apiKeySet=false 且 authMethod 非上述两形态 → false（api_key 形态）', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false, authMethod: 'api_key' }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('apiKeySet=false 且 authMethod 未标注 → false', () => {
    const cs = makeConfigService([{ id: 'p1', apiKeySet: false }])
    expect(providerHasCredential(cs, 'p1')).toBe(false)
  })

  it('listProviders 抛错 → catch fail-open true，且 console.warn 有痕', () => {
    const warn = stubWarn()
    const cs = makeConfigService([], () => {
      throw new Error('auth.json unreadable')
    })
    expect(providerHasCredential(cs, 'p1')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('credential check failed (fail-open)'),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth.json unreadable'))
  })
})

describe('resolveActivateTimeoutMs — 激活上界 env 解析', () => {
  it('env 缺键（undefined）→ DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS', () => {
    expect(resolveActivateTimeoutMs({})).toBe(DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS)
    // 显式 undefined（键存在但值为 undefined，process.env 形态）同缺省
    expect(resolveActivateTimeoutMs({ [TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]: undefined }))
      .toBe(DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS)
  })

  it.each(['abc', 'NaN', 'Infinity'])('非有限值 %s → warn 回落默认', (raw) => {
    const warn = stubWarn()
    expect(resolveActivateTimeoutMs({ [TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]: raw }))
      .toBe(DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`invalid ${TAIJI_SESSION_ACTIVATE_TIMEOUT_MS} value "${raw}"`))
  })

  it('数值串透传：2500 → 2500', () => {
    expect(resolveActivateTimeoutMs({ [TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]: '2500' })).toBe(2500)
  })

  it("'0' → 0（≤0 = 不限时逃生门，与 bash RPC 的 0=不限时同口径）", () => {
    expect(resolveActivateTimeoutMs({ [TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]: '0' })).toBe(0)
  })

  it("''（空串）→ 0：Number('') === 0 走透传腿，现状锁定为不限时", () => {
    // 现状锁定用例：空串 env（如 `TAIJI_SESSION_ACTIVATE_TIMEOUT_MS= pi ...`）经
    // Number('') === 0 透传为 0=不限时，而非回落默认——与源码注释「非法值回落默认」
    // 的直觉相悖。待 business-logic 裁决空串是否应归入非法值回落；本用例只锁定
    // 现状，不改实现。
    expect(resolveActivateTimeoutMs({ [TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]: '' })).toBe(0)
  })
})
