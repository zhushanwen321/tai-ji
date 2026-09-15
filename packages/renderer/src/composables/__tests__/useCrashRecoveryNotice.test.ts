/**
 * useCrashRecoveryNotice 单元测试（crash-resilience §3.1 T2 / §4 A3）。
 *
 * 覆盖一次性语义三要素：
 * - query 带 recoveredFrom=crash → visible=true + reason 透传 + query 被剥离
 *   （history.replaceState 同文档改写，手动刷新不重现）
 * - query 无标志 → 零副作用（visible=false）
 * - 消费幂等：首次调用后再次调用不重复消费（模块级 consumed 守卫）
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/__tests__/useCrashRecoveryNotice.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCrashRecoveryNotice,
  _resetCrashRecoveryNoticeForTest,
} from '../useCrashRecoveryNotice'

/** 置 URL query（happy-dom 的 history.replaceState） */
function setQuery(qs: string): void {
  window.history.replaceState(null, '', qs ? `/?${qs}` : '/')
}

describe('useCrashRecoveryNotice 崩溃恢复一次性标志消费（T2）', () => {
  beforeEach(() => {
    _resetCrashRecoveryNoticeForTest()
    setQuery('')
  })

  it('标志存在：visible=true + reason 透传 + query 被剥离（一次性：刷新不重现）', () => {
    setQuery('windowId=w1&recoveredFrom=crash&crashReason=oom')
    const { visible, reason } = useCrashRecoveryNotice()
    expect(visible.value).toBe(true)
    expect(reason.value).toBe('oom')
    // query 已剥离：recoveredFrom/crashReason 不在，其余 query 保留（windowId 不受影响）
    const after = new URLSearchParams(window.location.search)
    expect(after.get('recoveredFrom')).toBeNull()
    expect(after.get('crashReason')).toBeNull()
    expect(after.get('windowId')).toBe('w1')
    expect(window.location.search).not.toContain('recoveredFrom')
  })

  it('reason 缺省时 fallback unknown（main 侧 reason ?? unknown 同构）', () => {
    setQuery('recoveredFrom=crash')
    const { visible, reason } = useCrashRecoveryNotice()
    expect(visible.value).toBe(true)
    expect(reason.value).toBe('unknown')
  })

  it('标志不存在：零副作用（visible=false，URL 不动）', () => {
    setQuery('windowId=w1')
    const { visible, reason } = useCrashRecoveryNotice()
    expect(visible.value).toBe(false)
    expect(reason.value).toBe('')
    expect(window.location.search).toBe('?windowId=w1')
  })

  it('标志值非 crash：不触发（防未来其他 recoveredFrom 值误报）', () => {
    setQuery('recoveredFrom=other')
    const { visible } = useCrashRecoveryNotice()
    expect(visible.value).toBe(false)
  })

  it('消费幂等：复位 visible 后重复调用不重新消费（URL 已清，可见态不再被 query 复活）', () => {
    setQuery('recoveredFrom=crash&crashReason=killed')
    const first = useCrashRecoveryNotice()
    expect(first.visible.value).toBe(true)
    first.dismiss()
    expect(first.visible.value).toBe(false)
    // 二次调用（模拟同窗口其他消费点）：consumed 守卫生效，不复现 visible
    const second = useCrashRecoveryNotice()
    expect(second.visible.value).toBe(false)
  })

  it('dismiss：visible 置 false（用户主动关闭出口）', () => {
    setQuery('recoveredFrom=crash&crashReason=oom')
    const { visible, dismiss } = useCrashRecoveryNotice()
    expect(visible.value).toBe(true)
    dismiss()
    expect(visible.value).toBe(false)
  })
})
