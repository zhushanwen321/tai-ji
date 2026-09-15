/**
 * useToast 单测。
 *
 * 覆盖：
 * 1. remove 提前关闭 toast 时 clearTimeout（fake timers 活跃计数归零，advance 后回调不再触发）
 * 2. 不提前 remove 时自然移除（行为保持）
 * 3. 多 toast 独立计时，remove 只清对应 timer
 * 4. 停留时长分级（notify 优化）：info 4s / error、warning 8s（需行动的级别更久）
 * 5. sessionLabel/sessionId 透传（后台 session 通知的定位行数据）
 * 6. hover 暂停/恢复：pause 冻结自动移除（advance 超额仍留存）、resume 按剩余时长续走、
 *    已移除后 resume no-op、未暂停时 pause 幂等
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast } from '@/composables/useToast'

describe('useToast timer 句柄清理（Q1-8）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // useToast 是模块级单例状态：触发全部残留 timer 清空 toasts，避免跨用例污染
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('remove 提前关闭 toast 后 timer 已清：advance 后回调不再触发', () => {
    const { toasts, error, remove } = useToast()
    error('boom')
    expect(toasts.value).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1) // 自动移除 timer 已挂

    remove(toasts.value[0].id)
    expect(toasts.value).toHaveLength(0)
    // timer 已被 clearTimeout：fake timers 活跃计数归零
    expect(vi.getTimerCount()).toBe(0)

    // advance 超过最长时长：回调不再触发，无任何副作用
    vi.advanceTimersByTime(8000)
    expect(toasts.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('不提前 remove 时 info 4s 后自然移除（原行为保持）', () => {
    const { toasts, info } = useToast()
    info('hello')
    expect(toasts.value).toHaveLength(1)

    vi.advanceTimersByTime(3999)
    expect(toasts.value).toHaveLength(1) // 未到期不移除

    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0) // 到期自然移除
    expect(vi.getTimerCount()).toBe(0) // 句柄自清
  })

  it('多个 toast 独立计时，remove 只清对应 timer', () => {
    const { toasts, info, remove } = useToast()
    info('first')
    info('second')
    expect(vi.getTimerCount()).toBe(2)

    remove(toasts.value[0].id) // 提前关第一个
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('second')
    expect(vi.getTimerCount()).toBe(1) // 第二个的 timer 仍在

    vi.advanceTimersByTime(4000) // 第二个自然到期移除
    expect(toasts.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useToast 停留时长分级（notify 优化）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('error/warning 停留 8s：4s 时仍在、8s 时移除', () => {
    const { toasts, error, warning } = useToast()
    error('boom')
    warning('careful')
    expect(vi.getTimerCount()).toBe(2)

    vi.advanceTimersByTime(4000)
    expect(toasts.value).toHaveLength(2) // 未到期

    vi.advanceTimersByTime(4000)
    expect(toasts.value).toHaveLength(0) // 8s 到期
  })
})

describe('useToast session 定位透传（notify 优化）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('opts.sessionLabel/sessionId 进入 toast 条目', () => {
    const { toasts, warning } = useToast()
    warning('Goal blocked. Use /goal resume.', {
      sessionLabel: '修通知组件 · taiji',
      sessionId: 'sid-1',
    })
    expect(toasts.value[0].sessionLabel).toBe('修通知组件 · taiji')
    expect(toasts.value[0].sessionId).toBe('sid-1')
  })

  it('不带 opts 的调用 sessionLabel/sessionId 为 undefined（退化纯消息）', () => {
    const { toasts, info } = useToast()
    info('plain')
    expect(toasts.value[0].sessionLabel).toBeUndefined()
    expect(toasts.value[0].sessionId).toBeUndefined()
  })
})

describe('useToast hover 暂停/恢复（notify 优化）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('pause 后 advance 超额仍留存，resume 按剩余时长续走', () => {
    const { toasts, info, pause, resume } = useToast()
    info('hover me')
    const id = toasts.value[0].id

    vi.advanceTimersByTime(1000) // 已消耗 1s
    pause(id)
    vi.advanceTimersByTime(10_000) // 暂停期间时间流逝不生效
    expect(toasts.value).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0) // timer 已清

    resume(id) // 剩余 3s 重建
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(2999)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0)
  })

  it('未暂停时 pause no-op；已移除后 resume no-op', () => {
    const { toasts, info, pause, resume } = useToast()
    info('x')
    const id = toasts.value[0].id

    resume(id) // 未暂停：无 timer 变化
    expect(vi.getTimerCount()).toBe(1)

    pause(id)
    pause(id) // 幂等：不重复计时
    expect(vi.getTimerCount()).toBe(0)

    resume(id)
    vi.runAllTimers() // 自然移除
    expect(toasts.value).toHaveLength(0)
    resume(id) // 已移除：no-op 不复活
    expect(toasts.value).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
