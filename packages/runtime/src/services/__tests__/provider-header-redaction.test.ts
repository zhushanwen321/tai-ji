/**
 * provider headers 出线脱敏单元（ISSUES-2 ⑨ 修复）。
 *
 * 断言口径：凭据词根键剔除（refreshToken 类不随 config.providers / model.list 帧出线）、
 * 非敏感键保留（自定义 UA 等编辑回显依赖）、剔除后空 → undefined（帧内不落 headers 字段）、
 * 输入对象不被修改（出线脱敏不得污染读到的 models.json 原始对象）。落盘链不受影响的
 * 集成断言在 provider-config-helper.test.ts（写侧 upsert 收完整 headers）。
 */
import { describe, it, expect } from 'vitest'
import { isSensitiveHeaderKey, redactSensitiveHeaders } from '../provider-header-redaction.js'

describe('provider-header-redaction: isSensitiveHeaderKey 凭据词根判定', () => {
  it('wool 插件 refreshToken 承载键命中（ISSUES-2 ⑨ 现象键）', () => {
    expect(isSensitiveHeaderKey('x-wool-refresh-token')).toBe(true)
  })

  it('常见凭据键命中（大小写不敏感 + 分隔符变体）', () => {
    for (const key of ['Authorization', 'x-api-key', 'X_Api_Key', 'apikey', 'client_secret', 'X-Client-Secret', 'db-password', 'x-access-token', 'X-Auth-Credential', 'session-cookie']) {
      expect(isSensitiveHeaderKey(key), key).toBe(true)
    }
  })

  it('非凭据键不命中（裸 auth/key 词根排除——x-authenticated-at / x-key-id 类不误伤）', () => {
    for (const key of ['User-Agent', 'x-custom-ua', 'X-Request-Id', 'x-authenticated-at', 'x-key-id', 'accept-language', 'x-rate-limit-remaining']) {
      expect(isSensitiveHeaderKey(key), key).toBe(false)
    }
  })
})

describe('provider-header-redaction: redactSensitiveHeaders 出线脱敏', () => {
  it('凭据键剔除、非敏感键保留（同一条目混合形态）', () => {
    const out = redactSensitiveHeaders({
      'x-wool-refresh-token': 'rt-secret-value',
      'User-Agent': 'taiji-gateway/1.0',
    })
    expect(out).toEqual({ 'User-Agent': 'taiji-gateway/1.0' })
  })

  it('全键命中 → undefined（帧内不落 headers 字段）', () => {
    expect(redactSensitiveHeaders({ 'x-wool-refresh-token': 'rt' })).toBeUndefined()
    expect(redactSensitiveHeaders({})).toBeUndefined()
    expect(redactSensitiveHeaders(undefined)).toBeUndefined()
  })

  it('输入对象不被修改（出线脱敏不得污染 configStore.readModels 的原始条目）', () => {
    const original = { 'x-wool-refresh-token': 'rt', 'User-Agent': 'ua' }
    const snapshot = { ...original }
    redactSensitiveHeaders(original)
    expect(original).toEqual(snapshot)
  })
})
