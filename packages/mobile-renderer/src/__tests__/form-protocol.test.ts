// form-protocol 纯逻辑契约测试（shell/form-protocol.ts 移动壳视图辅助薄层）。
//
// MF-1-8 收敛后形态：ui-form 线协议的编码契约 / 帧标记守卫 / 问题集与草稿收窄已迁
// @taiji/ui/extension-host（共享纯模块单点，契约测试在同包 __tests__/form-protocol.test.ts；
// 桌面 FormOverlay 与移动 MobileFormCard 消费同一导出）；本文件只锁定移动壳薄层的
// schedule 回显确认门（scheduleEchoResult / isScheduleEchoReady——委托共享
// draftToScheduleFormResult 的壳侧包装）。
import { describe, expect, it } from 'vitest'
import { draftToScheduleFormResult } from '@taiji/ui/extension-host'
import { isScheduleEchoReady, scheduleEchoResult } from '../shell/form-protocol'

describe('schedule 回显确认门（移动壳薄层，委托共享 draftToScheduleFormResult）', () => {
  const baseDraft = {
    kind: 'once' as const,
    schedule: '30 14 2 10 *',
    prompt: '跑每日备份',
    models: ['m1', 'm2'],
  }

  it('schedule 题无 initial → 回显不可构造（仅可取消）；有 initial 委托 draft 回显', () => {
    expect(isScheduleEchoReady({ type: 'schedule', question: 'q' })).toBe(false)
    expect(scheduleEchoResult({ type: 'schedule', question: 'q' })).toBeNull()
    expect(isScheduleEchoReady({ type: 'schedule', question: 'q', initial: baseDraft })).toBe(true)
    expect(scheduleEchoResult({ type: 'schedule', question: 'q', initial: baseDraft })).toEqual(
      draftToScheduleFormResult(baseDraft),
    )
  })
})
