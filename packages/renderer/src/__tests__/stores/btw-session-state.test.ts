/**
 * btw-session-state store 单测（旁路线模型显示态，2026-10-11 缺陷修复防回归）。
 *
 * 背景契约：btw 线是 hidden 会话，sessionStore.applySnapshot 对 vid 静默丢弃——线模型态
 * 只能落本 store（切换回执真值），显示解析按「线回执 → 主会话回退」维度级合并（fork 继承
 * 事实：线 spawn inheritSessionModel，未切过维度的真值 ≡ 主会话创建线当时值）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：applyModelState 字段级合并 / 非 vid 拒写 / bindMainSid 幂等 / forget 清退
 * - 使用者（黑盒）：resolveComposerSessionState 五分支（非 btw 直查 / 无绑定 null /
 *   无回执全回退 / 部分回执维度级合并 / 主会话缺列表时回执仍可用）
 * - 观察者（形态）：解析输出形状 = composer getSessionState 契约形（{modelId, thinkingLevel?} | null）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/btw-session-state.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { btwVirtualId } from '@taiji/shared'
import {
  useBtwSessionStateStore,
  resolveComposerSessionState,
} from '@/stores/btw-session-state'

const VID = btwVirtualId('pi-line-1')
const MAIN = 'main-s1'

describe('btw-session-state store（构建者白盒）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('applyModelState 字段级合并且拒写非 vid；bindMainSid 幂等；forget 清退两表', () => {
    const s = useBtwSessionStateStore()
    s.applyModelState(VID, { modelId: 'p/a' })
    s.applyModelState(VID, { thinkingLevel: 'high' })
    expect(s.modelByVid[VID]).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })

    s.applyModelState('main-s1', { modelId: 'p/x' }) // 非 btw vid 拒写
    expect(s.modelByVid['main-s1']).toBeUndefined()

    s.bindMainSid(VID, MAIN)
    s.bindMainSid(VID, MAIN)
    expect(s.mainSidByVid[VID]).toBe(MAIN)

    s.forget(VID)
    expect(s.modelByVid[VID]).toBeUndefined()
    expect(s.mainSidByVid[VID]).toBeUndefined()
  })
})

describe('resolveComposerSessionState（使用者黑盒 + 观察者形态）', () => {
  const list = [
    { id: MAIN, modelId: 'p/main-model', thinkingLevel: 'high' },
    { id: 'other', modelId: 'p/other', thinkingLevel: 'low' },
  ]

  it('非 btw id：原样查主列表（调用方无需预分支）', () => {
    expect(resolveComposerSessionState(MAIN, list, () => undefined, () => undefined)).toEqual({
      modelId: 'p/main-model',
      thinkingLevel: 'high',
    })
  })

  it('btw 无绑定 / 绑定的主会话不在列表 / 主会话无回执且缺维 → null 或占位空串', () => {
    // 无绑定 → null（显示占位「…」，与修复前形态一致但仅限数据真缺）
    expect(resolveComposerSessionState(VID, list, () => undefined, () => undefined)).toBeNull()
    // 绑定的主会话不在列表 → null
    expect(resolveComposerSessionState(VID, list, () => undefined, () => 'gone')).toBeNull()
    // 有线回执但主会话不在列表：回执维度可用，缺维占位空串（modelId 契约形恒串）
    expect(
      resolveComposerSessionState(VID, list, () => ({ modelId: 'p/line' }), () => 'gone'),
    ).toEqual({ modelId: 'p/line', thinkingLevel: undefined })
  })

  it('无回执 → 整体回退主会话态（fork 继承事实）', () => {
    expect(resolveComposerSessionState(VID, list, () => undefined, () => MAIN)).toEqual({
      modelId: 'p/main-model',
      thinkingLevel: 'high',
    })
  })

  it('部分回执 → 维度级合并（回执维用真值，未回执维回退主会话）', () => {
    // 只回执过模型：档位回退主会话
    expect(resolveComposerSessionState(VID, list, () => ({ modelId: 'p/line' }), () => MAIN)).toEqual({
      modelId: 'p/line',
      thinkingLevel: 'high',
    })
    // 只回执过档位：模型回退主会话
    expect(resolveComposerSessionState(VID, list, () => ({ thinkingLevel: 'max' }), () => MAIN)).toEqual({
      modelId: 'p/main-model',
      thinkingLevel: 'max',
    })
  })
})
