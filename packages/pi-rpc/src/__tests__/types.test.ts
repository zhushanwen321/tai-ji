// src/__tests__/types.test.ts
//
// asThinkingLevel 白名单钉值（ext-simplify-17 D5 配套 P1-a）。
//
// 七值与 pi-ai 上游 ModelThinkingLevel（"off" | ThinkingLevel，ThinkingLevel =
// "minimal" | "low" | "medium" | "high" | "xhigh" | "max"）逐成员锚定——白名单
// 曾缺 'xhigh'，导致 `model:xhigh` 后缀经 asThinkingLevel 收窄时静默降级
// undefined（spawn-runner thinkingLevel 消失，pi 侧回缺省档）。

import { describe, expect, it } from 'vitest'

import { asThinkingLevel } from '../types.ts'

describe('asThinkingLevel（thinking level 白名单收窄）', () => {
  // 七值钉值：pi-ai ModelThinkingLevel 联合成员全集，顺序同上游 types.d.ts。
  it.each([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const)('合法值 %s → 原值返回', (level) => {
    expect(asThinkingLevel(level)).toBe(level)
  })

  it('xhigh 接受（修复前白名单缺位 → undefined）', () => {
    expect(asThinkingLevel('xhigh')).toBe('xhigh')
  })

  it('非法值 → undefined（不 throw）', () => {
    expect(asThinkingLevel('ultra')).toBeUndefined()
    expect(asThinkingLevel('HIGH')).toBeUndefined()
    expect(asThinkingLevel('')).toBeUndefined()
    expect(asThinkingLevel(undefined)).toBeUndefined()
    expect(asThinkingLevel(3)).toBeUndefined()
    expect(asThinkingLevel(null)).toBeUndefined()
    expect(asThinkingLevel({ level: 'high' })).toBeUndefined()
  })
})
