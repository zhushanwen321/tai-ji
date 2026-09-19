/**
 * 进程级 SessionStatus → 展示态映射 + 「运行已完成」判据单测（U-B：子会话徽标口径改未完成数）。
 *
 * 判据口径（用户裁决）：绿点（done）= 运行已完成；`isSessionCompleted` = DISPLAY_STATUS 映射到
 * `'done'`，六态全覆盖：{idle, done} → true；{active, error, stopped, dead} → false。
 * 侧栏子会话徽标取反汇总「未完成数」，故本判据同时锁住「error / stopped / dead 计入」的语义。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/session-display-status.test.ts
 */
import { describe, it, expect } from 'vitest'
import { DISPLAY_STATUS, DOT_CLASS, isSessionCompleted } from '@/composables/logic/sessionStatus'
import type { SessionStatus } from '@taiji/shared'

describe('U-B: DISPLAY_STATUS / isSessionCompleted 判据 SSOT', () => {
  it('DISPLAY_STATUS 覆盖 SessionStatus 全部六态', () => {
    const statuses: SessionStatus[] = ['active', 'idle', 'done', 'error', 'stopped', 'dead']
    for (const s of statuses) {
      expect(DISPLAY_STATUS[s]).toBeDefined()
    }
    expect(Object.keys(DISPLAY_STATUS).sort()).toEqual([...statuses].sort())
  })

  it('isSessionCompleted：仅 {idle, done} 为「运行已完成」（绿点），其余四态均未完成', () => {
    // 绿点 ⟺ DISPLAY_STATUS → 'done' ⟺ DOT_CLASS = bg-success
    expect(isSessionCompleted('idle')).toBe(true)
    expect(isSessionCompleted('done')).toBe(true)
    expect(isSessionCompleted('active')).toBe(false)
    expect(isSessionCompleted('error')).toBe(false)
    expect(isSessionCompleted('stopped')).toBe(false)
    expect(isSessionCompleted('dead')).toBe(false)
  })

  it('判据与绿点色语言同源：completed 的 DISPLAY_STATUS 必落到 DOT_CLASS.success', () => {
    const statuses: SessionStatus[] = ['active', 'idle', 'done', 'error', 'stopped', 'dead']
    for (const s of statuses) {
      const isGreen = DOT_CLASS[DISPLAY_STATUS[s]] === 'bg-success'
      expect(isSessionCompleted(s)).toBe(isGreen)
    }
  })
})
