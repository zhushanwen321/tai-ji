/**
 * resolveSendRoute 单元测试（u5b D6 六行表 → u3b/D1 降级为发送位 UI 预测，六行语义不变）。
 *
 * 被测对象：domain/composer/dispatch/send-route.ts —— sessionPhase → 发送位预测形态纯函数。
 * [u3b/D1] 本表已非投递决策（lane 判定收归 runtime 内核，renderer 统一 delivery.submit），
 * 保留职责 = Composer 发送位按钮形态预测；六行预测语义与内核判定同构（同读 occupancy
 * 三维投影），'defer' 字面随 defer 队列退役改为 'queued'（内核车道语义对齐）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/send-route.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveSendRoute, IDLE_SESSION_PHASE, type SessionPhase } from './send-route'

/** 行工厂：占位维按用例覆写（Partial<SessionPhase> 与生产类型同源，turn 联合扩值时本表不再漂移） */
function phase(over: Partial<SessionPhase>) {
  return { ...IDLE_SESSION_PHASE, ...over }
}

describe('resolveSendRoute —— 发送位预测表六行（u3b/D1 UI 预测）', () => {
  it('行 1：全 idle → direct（预测「提交即直达」）', () => {
    expect(resolveSendRoute(IDLE_SESSION_PHASE)).toBe('direct')
    expect(resolveSendRoute(phase({ turn: 'idle', compacting: false, bash: false }))).toBe('direct')
  })

  it('行 2：turn=dispatching / generating（无 compacting）→ steer（turn 活跃定义不含 settling）', () => {
    expect(resolveSendRoute(phase({ turn: 'dispatching' }))).toBe('steer')
    expect(resolveSendRoute(phase({ turn: 'generating' }))).toBe('steer')
  })

  it('行 3：turn=generating + compacting（threshold turn 内压缩）→ steer（turn 活跃优先）', () => {
    expect(resolveSendRoute(phase({ turn: 'generating', compacting: true }))).toBe('steer')
    expect(resolveSendRoute(phase({ turn: 'dispatching', compacting: true }))).toBe('steer')
  })

  it('行 4：turn=settling（无论是否 compacting）→ queued（settling 是收尾不是活跃 turn）', () => {
    expect(resolveSendRoute(phase({ turn: 'settling' }))).toBe('queued')
    expect(resolveSendRoute(phase({ turn: 'settling', compacting: true }))).toBe('queued')
  })

  it('行 5：turn=idle + compacting（manual / overflow / 工具触发）→ queued', () => {
    expect(resolveSendRoute(phase({ turn: 'idle', compacting: true }))).toBe('queued')
  })

  it('行 6：bash=true 且 turn=idle → queued（bash 结束后内核解除）', () => {
    expect(resolveSendRoute(phase({ turn: 'idle', bash: true }))).toBe('queued')
    // 组合形态：settling + bash 同忙仍 queued（任一维度忙即排队预测）
    expect(resolveSendRoute(phase({ turn: 'settling', bash: true }))).toBe('queued')
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
