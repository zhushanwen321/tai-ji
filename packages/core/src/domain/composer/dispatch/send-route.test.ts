/**
 * resolveSendRoute 单元测试（session-occupancy u5b / D6 路由表六行逐一断言）。
 *
 * 被测对象：domain/composer/dispatch/send-route.ts —— sessionPhase → sendRoute 纯函数。
 * 验收条款（u5b）：② D6 路由表六行逐一断言（含 threshold 形态 generating+compacting → steer、
 * settling → defer、bash+idle → defer）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/send-route.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveSendRoute, IDLE_SESSION_PHASE } from './send-route'

/** 行工厂：占位维按用例覆写 */
function phase(over: Partial<{ turn: 'idle' | 'dispatching' | 'generating' | 'settling'; compacting: boolean; bash: boolean }>) {
  return { ...IDLE_SESSION_PHASE, ...over }
}

describe('resolveSendRoute —— D6 路由表六行', () => {
  it('行 1：全 idle → direct（flush 触发的解除形态）', () => {
    expect(resolveSendRoute(IDLE_SESSION_PHASE)).toBe('direct')
    expect(resolveSendRoute(phase({ turn: 'idle', compacting: false, bash: false }))).toBe('direct')
  })

  it('行 2：turn=dispatching / generating（无 compacting）→ steer（turn 活跃定义不含 settling）', () => {
    expect(resolveSendRoute(phase({ turn: 'dispatching' }))).toBe('steer')
    expect(resolveSendRoute(phase({ turn: 'generating' }))).toBe('steer')
  })

  it('行 3：turn=generating + compacting（threshold turn 内压缩）→ steer（优先级倒挂消除）', () => {
    // turn 活跃优先于 compacting 维度：压缩后 turn 继续跑，消息经 steer 在压缩完成的
    // 下一次 LLM 调用前投递（不产生 pending 气泡——steer 分档正确）。
    expect(resolveSendRoute(phase({ turn: 'generating', compacting: true }))).toBe('steer')
    expect(resolveSendRoute(phase({ turn: 'dispatching', compacting: true }))).toBe('steer')
  })

  it('行 4：turn=settling（无论是否 compacting）→ defer（settling 是收尾不是活跃 turn）', () => {
    expect(resolveSendRoute(phase({ turn: 'settling' }))).toBe('defer')
    expect(resolveSendRoute(phase({ turn: 'settling', compacting: true }))).toBe('defer')
  })

  it('行 5：turn=idle + compacting（manual / overflow / 工具触发）→ defer', () => {
    expect(resolveSendRoute(phase({ turn: 'idle', compacting: true }))).toBe('defer')
  })

  it('行 6：bash=true 且 turn=idle → defer（bash 结束解除 defer，flush 随 idle 广播自然触发）', () => {
    expect(resolveSendRoute(phase({ turn: 'idle', bash: true }))).toBe('defer')
    // 组合形态：settling + bash 同忙仍 defer（任一维度忙即 defer）
    expect(resolveSendRoute(phase({ turn: 'settling', bash: true }))).toBe('defer')
  })

  it('优先级：turn 活跃优先于 bash / compacting 维度（判定顺序 = 先 turn → 再维度）', () => {
    expect(resolveSendRoute(phase({ turn: 'generating', bash: true }))).toBe('steer')
    expect(resolveSendRoute(phase({ turn: 'dispatching', bash: true, compacting: true }))).toBe('steer')
  })

  it('未知 turn 值（防御形态）不满足活跃集 → 落维度判定', () => {
    // 类型系统外 invaders（如 runtime 未来新增枚举）：不属 {dispatching, generating} 活跃集，
    // 若 compacting/bash 均不忙则按 idle 处理（保守 direct）。
    expect(resolveSendRoute(phase({ turn: 'unknown' as 'idle' }))).toBe('direct')
  })
})
