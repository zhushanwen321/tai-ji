import { describe, it, expect } from 'vitest'
import { isQuotaPreset, matchQuotaPreset, resolveQuotaPresets, QUOTA_PRESETS } from '../quota-presets'

describe('QUOTA_PRESETS', () => {
  it('有 6 个预设', () => {
    expect(QUOTA_PRESETS).toHaveLength(6)
  })

  it('每个预设都有必需字段', () => {
    for (const preset of QUOTA_PRESETS) {
      expect(preset.fetcher).toBeTruthy()
      expect(preset.label).toBeTruthy()
      // [A2-1] auth 数组化：非空数组且元素均为合法形态
      expect(Array.isArray(preset.auth)).toBe(true)
      expect(preset.auth.length).toBeGreaterThan(0)
      for (const kind of preset.auth) {
        expect(['api-key', 'oauth', 'cookie']).toContain(kind)
      }
      expect(preset.match.baseUrlPattern || preset.match.namePattern).toBeTruthy()
    }
  })
})

// presets 形参契约必填（无缺省，防「漏传静默读基线」）：编译期由 TS 强制，本组用例
// 显式传基线表，语义与必填化前的缺省回落一致。
describe('matchQuotaPreset', () => {
  it('baseUrl 匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/api' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 zhipu（不区分大小写）', () => {
    const result = matchQuotaPreset({ name: 'Zhipu' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 匹配 kimi', () => {
    const result = matchQuotaPreset({ name: 'kimi' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('kimi-coding')
  })

  it('baseUrl 匹配 minimax', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://api.minimaxi.com/v1' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('minimax')
  })

  it('name 匹配 mimo', () => {
    const result = matchQuotaPreset({ name: 'MiMo' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('mimo')
  })

  it('name 匹配 opencode', () => {
    const result = matchQuotaPreset({ name: 'opencode' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('opencode-go')
  })

  it('baseUrl 匹配 opendesign（open-design.ai 域）', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://amr-link.open-design.ai/v1' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('opendesign')
  })

  it('name 匹配 opendesign（不区分大小写）', () => {
    const result = matchQuotaPreset({ name: 'OpenDesign' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('opendesign')
  })

  it('opendesign preset 声明 cookie 认证 + requiresWorkspace（资源维度）', () => {
    const preset = QUOTA_PRESETS.find((p) => p.fetcher === 'opendesign')
    expect(preset).toBeDefined()
    expect(preset?.auth).toEqual(['cookie'])
    expect(preset?.requiresWorkspace).toBe(true)
  })

  it('无匹配返回 undefined', () => {
    const result = matchQuotaPreset({ name: 'openai' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('无参数返回 undefined', () => {
    const result = matchQuotaPreset({}, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('baseUrl 优先于 name 匹配', () => {
    // baseUrl 匹配 zhipu，name 匹配 kimi
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn', name: 'kimi' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] 负向用例：防止 namePattern 作为子串误匹配用户自建 provider
  it('name 含 zai 子串但不匹配 zhipu（lazyai）', () => {
    const result = matchQuotaPreset({ name: 'lazyai' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('name 含 zai 子串但不匹配 zhipu（mozaitest）', () => {
    const result = matchQuotaPreset({ name: 'mozaitest' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('name 含 mimo 子串但不匹配 mimo（mimosa）', () => {
    const result = matchQuotaPreset({ name: 'mimosa' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('name 含 kimi 子串但不匹配 kimi（kimito）', () => {
    const result = matchQuotaPreset({ name: 'kimito' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('name 含 minimax 子串但不匹配 minimax（minimaxified）', () => {
    const result = matchQuotaPreset({ name: 'minimaxified' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  it('name 含 opencode 子串但不匹配 opencode-go（opencodejs）', () => {
    const result = matchQuotaPreset({ name: 'opencodejs' }, QUOTA_PRESETS)
    expect(result).toBeUndefined()
  })

  // [W2] 大小写归一化：baseUrl 大写也应命中（修复后 toLowerCase 归一化）
  it('baseUrl 大写也匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'HTTPS://BIGMODEL.CN/api' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] trailing slash 应命中
  it('baseUrl 带 trailing slash 也匹配 zhipu', () => {
    const result = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  // [W2] namePattern 多关键字边界：zhipu 的 'zhipu|glm|\bzai\b' 应命中独立 'zai' token
  it('name 为独立 zai token 匹配 zhipu', () => {
    const result = matchQuotaPreset({ name: 'zai' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })

  it('name 含独立 glm token 匹配 zhipu（如 my-glm-service）', () => {
    const result = matchQuotaPreset({ name: 'my-glm-service' }, QUOTA_PRESETS)
    expect(result?.fetcher).toBe('zhipu')
  })
})

// 读取侧空态回落（dmg-r3-1）：settings-store 的 quotaPresets 初值是 `[]`（非 undefined），
// `??` 只覆盖 undefined——空数组原样穿过回落表达式会让额度类型下拉与 matchedPreset 在
// RPC 未回包 / 拉取失败 / mock 层时永久为空（C-proc-21 禁静默空值）。
describe('resolveQuotaPresets', () => {
  it('空数组（store 初值 / RPC 失败未写）→ 回落编译期基线', () => {
    expect(resolveQuotaPresets([])).toBe(QUOTA_PRESETS)
  })

  it('undefined（props 未传）→ 回落编译期基线', () => {
    expect(resolveQuotaPresets(undefined)).toBe(QUOTA_PRESETS)
  })

  it('非空合并视图 → 原样返回（不复制、不改写，远程 presets 是权威）', () => {
    const merged = [QUOTA_PRESETS[0]!]
    expect(resolveQuotaPresets(merged)).toBe(merged)
  })

  it('回落后匹配链仍可用：空态 + zhipu baseUrl 命中基线', () => {
    const preset = matchQuotaPreset({ baseUrl: 'https://bigmodel.cn/api' }, resolveQuotaPresets([]))
    expect(preset?.fetcher).toBe('zhipu')
  })
})

// QuotaPreset wire 形状守卫（remote-config presets 段元素校验）：必填字段缺失或类型漂移
// 即拒、可选字段提供即校验、未知字段放行（远程向后兼容）。
describe('isQuotaPreset', () => {
  // 最小合法形状：仅必填字段（fetcher/label/auth/match）
  const minimal = {
    fetcher: 'x',
    label: 'X',
    auth: ['api-key'],
    match: { baseUrlPattern: 'example.com' },
  }

  it('最小合法形状（仅必填字段）→ true', () => {
    expect(isQuotaPreset(minimal)).toBe(true)
  })

  it('全字段合法形状（含可选字段）→ true', () => {
    expect(
      isQuotaPreset({
        ...minimal,
        auth: ['api-key', 'oauth'],
        match: { baseUrlPattern: 'example.com', namePattern: '\\bx\\b' },
        helpUrl: 'https://example.com/help',
        helpText: '获取凭证说明',
        requiresWorkspace: true,
      }),
    ).toBe(true)
  })

  it('基线表每个预设都通过守卫（基线与守卫构造性一致）', () => {
    for (const preset of QUOTA_PRESETS) {
      expect(isQuotaPreset(preset)).toBe(true)
    }
  })

  it('非对象（null / 数组 / 基元 / undefined）→ false', () => {
    expect(isQuotaPreset(null)).toBe(false)
    expect(isQuotaPreset(undefined)).toBe(false)
    expect(isQuotaPreset(['x'])).toBe(false)
    expect(isQuotaPreset('x')).toBe(false)
    expect(isQuotaPreset(42)).toBe(false)
  })

  it('fetcher 缺失 / 非字符串 / 空串 → false', () => {
    const { fetcher: _omit, ...noFetcher } = minimal
    expect(isQuotaPreset(noFetcher)).toBe(false)
    expect(isQuotaPreset({ ...minimal, fetcher: 42 })).toBe(false)
    expect(isQuotaPreset({ ...minimal, fetcher: '' })).toBe(false)
  })

  it('label 缺失 / 非字符串 → false', () => {
    const { label: _omit, ...noLabel } = minimal
    expect(isQuotaPreset(noLabel)).toBe(false)
    expect(isQuotaPreset({ ...minimal, label: 42 })).toBe(false)
  })

  it('auth 缺失 / 非数组 / 元素非字符串 → false', () => {
    const { auth: _omit, ...noAuth } = minimal
    expect(isQuotaPreset(noAuth)).toBe(false)
    expect(isQuotaPreset({ ...minimal, auth: 'api-key' })).toBe(false)
    expect(isQuotaPreset({ ...minimal, auth: ['api-key', 42] })).toBe(false)
  })

  it('match 缺失 / 非对象 / 数组 → false', () => {
    const { match: _omit, ...noMatch } = minimal
    expect(isQuotaPreset(noMatch)).toBe(false)
    expect(isQuotaPreset({ ...minimal, match: 'example.com' })).toBe(false)
    expect(isQuotaPreset({ ...minimal, match: ['example.com'] })).toBe(false)
  })

  it('match 可选字段提供即校验：非字符串 → false', () => {
    expect(isQuotaPreset({ ...minimal, match: { baseUrlPattern: 42 } })).toBe(false)
    expect(isQuotaPreset({ ...minimal, match: { namePattern: true } })).toBe(false)
  })

  it('可选字段提供即校验：helpUrl/helpText/requiresWorkspace 类型漂移 → false', () => {
    expect(isQuotaPreset({ ...minimal, helpUrl: 42 })).toBe(false)
    expect(isQuotaPreset({ ...minimal, helpText: 42 })).toBe(false)
    expect(isQuotaPreset({ ...minimal, requiresWorkspace: 'yes' })).toBe(false)
  })

  it('未知字段放行（远程向后兼容：新形态不被旧版本整体拒用）', () => {
    expect(isQuotaPreset({ ...minimal, futureField: { nested: true } })).toBe(true)
  })
})
