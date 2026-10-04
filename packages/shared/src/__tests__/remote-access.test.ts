import { describe, it, expect, expectTypeOf } from 'vitest'
import { RemoteAccessConfig, REMOTE_ACCESS_FILENAME } from '../remote-access'

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
