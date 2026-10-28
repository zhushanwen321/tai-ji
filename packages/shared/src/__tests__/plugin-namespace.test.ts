/**
 * plugin-namespace 纯函数单测（provider-plugin-access D4 / u-foundation 验收①）
 *
 * 用例口径 = 验收条款：scope 包名 / 无 scope 包名 / 非 plugin- 前缀包名 /
 * 声明值 ≠ 推导值拒绝 NAMESPACE_MISMATCH。纯函数零 IO，无数据目录接触。
 */
import { describe, expect, it } from 'vitest'
import { NAMESPACE_MISMATCH, deriveNamespace, validateNamespaceBinding } from '../plugin-namespace.js'

describe('deriveNamespace（去 npm scope、去 plugin- 前缀）', () => {
  it('scope 包名：@zhushanwen/plugin-wool-workbuddy → wool-workbuddy（D4 锚定向量）', () => {
    expect(deriveNamespace('@zhushanwen/plugin-wool-workbuddy')).toBe('wool-workbuddy')
  })

  it('无 scope 包名：plugin-foo → foo', () => {
    expect(deriveNamespace('plugin-foo')).toBe('foo')
  })

  it('非 plugin- 前缀包名：foo → foo（原样）', () => {
    expect(deriveNamespace('foo')).toBe('foo')
  })

  it('scope 包名非 plugin- 前缀：@scope/foo → foo（scope 剥离后原样）', () => {
    expect(deriveNamespace('@scope/foo')).toBe('foo')
  })

  it('重复前缀只剥一次：plugin-plugin-x → plugin-x（不猜测意图）', () => {
    expect(deriveNamespace('plugin-plugin-x')).toBe('plugin-x')
  })

  it('前缀是 plugin- 字面：plugins-x → plugins-x（不误剥）', () => {
    expect(deriveNamespace('plugins-x')).toBe('plugins-x')
  })

  it('大小写敏感：Plugin-x 不剥前缀', () => {
    expect(deriveNamespace('Plugin-x')).toBe('Plugin-x')
  })

  it('空串 → 空串（调用方按无效处置）', () => {
    expect(deriveNamespace('')).toBe('')
  })

  it('裸 scope（无 /）：@scope → 空串', () => {
    expect(deriveNamespace('@scope')).toBe('')
  })
})

describe('validateNamespaceBinding（安装期绑定校验，D4）', () => {
  it('声明值 = 推导值 → ok，namespace 返回推导值', () => {
    const result = validateNamespaceBinding('@zhushanwen/plugin-wool-workbuddy', 'wool-workbuddy')
    expect(result).toEqual({ ok: true, namespace: 'wool-workbuddy' })
  })

  it('声明值 ≠ 推导值 → NAMESPACE_MISMATCH，携带声明值与推导值（S22 锚定）', () => {
    const result = validateNamespaceBinding('@zhushanwen/plugin-wool-workbuddy', 'wool')
    expect(result).toEqual({
      ok: false,
      code: NAMESPACE_MISMATCH,
      declared: 'wool',
      derived: 'wool-workbuddy',
    })
    if (!result.ok) {
      expect(result.code).toBe('NAMESPACE_MISMATCH')
    }
  })

  it('声明值为空串 → NAMESPACE_MISMATCH（空 namespace 无法构成 providerId 前缀边界）', () => {
    const result = validateNamespaceBinding('plugin-foo', '')
    expect(result.ok).toBe(false)
  })

  it('包名推导不出有效 ns（裸 scope）→ NAMESPACE_MISMATCH（即使声明非空）', () => {
    const result = validateNamespaceBinding('@scope', 'whatever')
    expect(result.ok).toBe(false)
  })

  it('错误码字面量 NAMESPACE_MISMATCH 导出值稳定（安装拒绝与 UI 文案共用）', () => {
    expect(NAMESPACE_MISMATCH).toBe('NAMESPACE_MISMATCH')
  })
})
