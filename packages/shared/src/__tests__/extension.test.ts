import { describe, it, expect } from 'vitest'
// 注：从 barrel index（而非 @taiji/shared 自引用）导入。
// tsc 解析包路径自引用会报 TS2209（project root ambiguous），相对路径无此问题。
// mandatoryExtensions 类型断言定义在 index.ts，故必须从 index 取。
import {
  isMandatoryExtension,
  isInfrastructureExtension,
  isFeatureMandatoryExtension,
  mandatoryExtensions,
  type ExtensionTier,
} from '../index'

describe('mandatory extensions tier derivation', () => {
  // infrastructure 包（从 SSOT 取真实数据，不硬编码）
  const infraNames = mandatoryExtensions.filter(e => e.tier === 'infrastructure').map(e => e.name)
  // feature 包
  const featureNames = mandatoryExtensions.filter(e => e.tier === 'feature').map(e => e.name)

  it('SSOT 含至少 1 个 infrastructure 和多个 feature', () => {
    expect(infraNames.length).toBeGreaterThanOrEqual(1)
    expect(featureNames.length).toBeGreaterThanOrEqual(2)
  })

  it('isMandatoryExtension 对 infrastructure 包返回 true', () => {
    for (const name of infraNames) {
      expect(isMandatoryExtension(name)).toBe(true)
    }
  })

  it('isMandatoryExtension 对 feature 包返回 true', () => {
    for (const name of featureNames) {
      expect(isMandatoryExtension(name)).toBe(true)
    }
  })

  it('isMandatoryExtension 对未知包返回 false', () => {
    expect(isMandatoryExtension('not-a-real-extension')).toBe(false)
    expect(isMandatoryExtension('')).toBe(false)
  })

  it('isInfrastructureExtension 精确区分 infrastructure vs feature', () => {
    for (const name of infraNames) {
      expect(isInfrastructureExtension(name)).toBe(true)
    }
    for (const name of featureNames) {
      expect(isInfrastructureExtension(name)).toBe(false)
    }
  })

  it('isFeatureMandatoryExtension 精确区分 feature vs infrastructure', () => {
    for (const name of featureNames) {
      expect(isFeatureMandatoryExtension(name)).toBe(true)
    }
    for (const name of infraNames) {
      expect(isFeatureMandatoryExtension(name)).toBe(false)
    }
  })

  it('infrastructure 和 feature 集合不相交（同一包不会同时是两者）', () => {
    const intersection = infraNames.filter(n => featureNames.includes(n))
    expect(intersection).toEqual([])
  })

  it('未知包既非 infrastructure 也非 feature', () => {
    expect(isInfrastructureExtension('random-pkg')).toBe(false)
    expect(isFeatureMandatoryExtension('random-pkg')).toBe(false)
  })

  // M2 类型断言验证：tier 字段类型应为 'infrastructure' | 'feature'，编译期可捕获拼写错误
  it('ExtensionTier 类型约束（编译期，此处运行时验证字段值合法）', () => {
    for (const ext of mandatoryExtensions) {
      expect(['infrastructure', 'feature']).toContain(ext.tier)
    }
  })
})
