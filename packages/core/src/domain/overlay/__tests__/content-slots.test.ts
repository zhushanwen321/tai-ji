/**
 * overlay 域 content-slots 派生视图单测（容器扩展点统一 §6.8/§7.3 浮层行，U7）。
 *
 * 用例口径 = 文件头注契约：workflow 壳标签条三段派生（browser 专属壳排除；workflow→runs
 * 「切标签不改内容 kind」不对称映射）、段元数据自注册表转换器产出（壳不自持字面量）、
 * workflow 段 openableWithoutData 显式 false（§6.15 既有「运行」禁用规则的数据驱动形态）、
 * Host 承载 kind 集（插件内容不进集——声明侧非派生输入）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/overlay/__tests__/content-slots.test.ts
 */
import { describe, it, expect } from 'vitest'

import { deriveOverlayTabSegments, deriveOverlayHostedKinds } from '../content-slots'

describe('deriveOverlayTabSegments（workflow 壳标签条三段）', () => {
  it('段集 = runs/scheduler/canvas 三段，序 = OVERLAY_REGISTRY 序去 browser（专属壳排除）', () => {
    expect(deriveOverlayTabSegments().map((s) => s.value)).toEqual(['runs', 'scheduler', 'canvas'])
    expect(deriveOverlayTabSegments().map((s) => s.kind)).toEqual(['workflow', 'scheduler', 'canvas'])
  })

  it('段元数据自注册表派生（labelKey/icon 透传；workflow→runs 不对称映射不动元数据）', () => {
    const [runs, scheduler, canvas] = deriveOverlayTabSegments()
    expect(runs).toMatchObject({
      kind: 'workflow',
      labelKey: 'panel.workflowViz.overlayTitle',
      icon: 'workflow',
      openableWithoutData: false,
    })
    expect(scheduler).toMatchObject({
      kind: 'scheduler',
      labelKey: 'panel.workflowViz.overlayTabScheduler',
      icon: 'clock',
      openableWithoutData: true,
    })
    expect(canvas).toMatchObject({
      kind: 'canvas',
      labelKey: 'panel.workflowViz.overlayTabCanvas',
      icon: 'network',
      openableWithoutData: true,
    })
  })

  it('派生纯函数：重复调用产出等值段集（注册表与转换器均纯数据）', () => {
    expect(deriveOverlayTabSegments()).toEqual(deriveOverlayTabSegments())
  })
})

describe('deriveOverlayHostedKinds（Host「是否打开」判定派生源）', () => {
  it('承载集 = workflow 壳三类（browser 专属壳不在集）', () => {
    const kinds = deriveOverlayHostedKinds()
    expect(kinds.has('workflow')).toBe(true)
    expect(kinds.has('scheduler')).toBe(true)
    expect(kinds.has('canvas')).toBe(true)
    expect(kinds.has('browser')).toBe(false)
    expect(kinds.size).toBe(3)
  })
})
