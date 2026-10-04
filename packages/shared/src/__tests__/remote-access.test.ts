import { describe, it, expect, expectTypeOf } from 'vitest'
import { isRemoteAccessConfigShape, RemoteAccessConfig, REMOTE_ACCESS_FILENAME } from '../remote-access'

describe('REMOTE_ACCESS_FILENAME', () => {
  it('常量值为 remote-access.json', () => {
    expect(REMOTE_ACCESS_FILENAME).toBe('remote-access.json')
  })

  it('常量类型是字面量类型（非宽化 string）', () => {
    expectTypeOf<typeof REMOTE_ACCESS_FILENAME>().toEqualTypeOf<'remote-access.json'>()
  })
})

describe('RemoteAccessConfig 类型契约', () => {
  it('字段类型精确匹配设计契约', () => {
    expectTypeOf<RemoteAccessConfig['enabled']>().toEqualTypeOf<boolean>()
    expectTypeOf<RemoteAccessConfig['token']>().toEqualTypeOf<string>()
    expectTypeOf<RemoteAccessConfig['createdAt']>().toEqualTypeOf<string>()
  })

  it('合法形态样例满足契约：token 为 64 位 hex 小写、createdAt 为 ISO 8601', () => {
    // 锚定 token 格式注释（32 字节随机 hex = 64 位小写 hex）与 createdAt
    // 注释（ISO 8601）的语义，防止字段语义漂移时无断言可依。
    const config: RemoteAccessConfig = {
      enabled: true,
      token: 'a'.repeat(64),
      createdAt: '2026-09-19T12:00:00.000Z',
    }
    expect(config.token).toMatch(/^[0-9a-f]{64}$/)
    expect(config.createdAt).toEqual(expect.stringContaining('T'))
  })
})

describe('isRemoteAccessConfigShape（无策略 shape 谓词）', () => {
  it('对象且 enabled/token 类型正确 → 放行（多余字段如 createdAt 一并放行）', () => {
    expect(isRemoteAccessConfigShape({ enabled: true, token: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' })).toBe(true)
    expect(isRemoteAccessConfigShape({ enabled: false, token: 'any-token-string' })).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['非对象（string）', '{"enabled":true}'],
    ['非对象（number）', 1],
    ['非对象（boolean）', true],
    ['数组（enabled/token 缺失）', []],
    ['缺 enabled', { token: 'a'.repeat(64) }],
    ['缺 token', { enabled: true }],
    ['enabled 非 boolean', { enabled: 'true', token: 'a'.repeat(64) }],
    ['token 非 string', { enabled: true, token: 64 }],
  ])('%s → 拒绝', (_name, value) => {
    expect(isRemoteAccessConfigShape(value)).toBe(false)
  })

  it('严格度策略不参与判定：token 非 hex / createdAt 缺失或类型不符仍放行（策略归两侧策略层）', () => {
    expect(isRemoteAccessConfigShape({ enabled: true, token: 'not-hex' })).toBe(true)
    expect(isRemoteAccessConfigShape({ enabled: true, token: 'a'.repeat(64), createdAt: 123 })).toBe(true)
  })

  it('类型收窄只到 Pick<enabled|token>（未验证的 createdAt 不在收窄结果内）', () => {
    const value: unknown = { enabled: true, token: 'a'.repeat(64) }
    if (isRemoteAccessConfigShape(value)) {
      expectTypeOf(value).toEqualTypeOf<Pick<RemoteAccessConfig, 'enabled' | 'token'>>()
      expect(value.enabled).toBe(true)
      expect(value.token).toBe('a'.repeat(64))
    }
  })
})
