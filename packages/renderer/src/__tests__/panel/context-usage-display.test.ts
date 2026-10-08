/**
 * context-usage-display 显示纯函数测试（MF-1-2：usageBarClass 分档边界锚）。
 *
 * usageBarClass 三分支严格大于边界（>90 danger / >70 warn / 默认 accent 渐变）此前零断言，
 * 分档阈值回归无锚。阈值常量未导出（模块内私有），用例以字面量数值锁定行为边界——
 * 常量改名/调档时本测试显式红灯，防静默漂移。
 *
 * capacityBarClass（ui-optimize 决策 6 / N7 容量细条三段色阶）同形态边界锚：阈值 80/95
 * 刻意区别于浮层卡内 bar（70/90），两套阈值并存是有意差异（见模块内注释），禁止「统一」合并。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-usage-display.test.ts
 */
import { describe, it, expect } from 'vitest'
import { usageBarClass, capacityBarClass } from '@/components/panel/context-usage-display'

describe('usageBarClass 分档边界（严格大于）', () => {
  it('90（= danger 阈值）→ bg-warn（严格大于：90 仍属 70–90 warning 档，与模块头注释口径一致）', () => {
    expect(usageBarClass(90)).toBe('bg-warn')
  })

  it('91（> danger 阈值）→ bg-danger', () => {
    expect(usageBarClass(91)).toBe('bg-danger')
  })

  it('70（= warn 阈值）→ 默认渐变档（不严格大于 70）', () => {
    expect(usageBarClass(70)).toBe('bg-gradient-to-r from-accent to-accent-hover')
  })

  it('71（> warn 阈值且 ≤ danger 阈值）→ bg-warn', () => {
    expect(usageBarClass(71)).toBe('bg-warn')
  })
})

describe('capacityBarClass 细条三段边界（严格大于，阈值 80/95）', () => {
  it('80（= warn 阈值）→ bg-accent-soft 常态档（不严格大于 80）', () => {
    expect(capacityBarClass(80)).toBe('bg-accent-soft')
  })

  it('81（> warn 阈值且 ≤ danger 阈值）→ bg-warn', () => {
    expect(capacityBarClass(81)).toBe('bg-warn')
  })

  it('95（= danger 阈值）→ bg-warn（严格大于：95 仍属 80–95 档）', () => {
    expect(capacityBarClass(95)).toBe('bg-warn')
  })

  it('96（> danger 阈值）→ bg-danger', () => {
    expect(capacityBarClass(96)).toBe('bg-danger')
  })
})
