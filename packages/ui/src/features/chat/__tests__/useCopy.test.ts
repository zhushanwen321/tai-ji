/**
 * useCopy 行为测试：复制反馈态 + 非安全上下文守卫（移动壳 LAN http 修复回归）。
 *
 * - 正常路径：writeText resolve → copied 置 key；失败（reject）静默不置反馈。
 * - 非安全上下文（LAN http，如移动壳远程访问）：navigator.clipboard 为 undefined，
 *   同步访问 .writeText 即抛 TypeError（.catch 接不住）——守卫早退必须不抛错、不置
 *   copied 反馈（回归锚：2026-10 fix-remote-control-send-msg）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useCopy } from '../composables/useCopy'

describe('useCopy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('正常路径：writeText resolve → copied 置 key', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { copied, copy } = useCopy()
    copy('hello', 'k1')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(copied.value).toBe('k1')
  })

  it('writeText reject：静默吞错（.catch），反馈态照常置位', () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { copied, copy } = useCopy()
    expect(() => copy('hello', 'k1')).not.toThrow()
    expect(copied.value).toBe('k1')
  })

  it('非安全上下文（clipboard undefined）：守卫早退不抛错、不置 copied 反馈', () => {
    // LAN http 下 navigator.clipboard 为 undefined——直调 .writeText 是同步 TypeError，
    // .catch 接不住；回归锚 = 守卫分支（早退，无 writeText 调用无反馈态）。
    vi.stubGlobal('navigator', {})
    const { copied, copy } = useCopy()
    expect(() => copy('hello', 'k1')).not.toThrow()
    expect(copied.value).toBeNull()
  })

  it('反馈清除：COPIED_FEEDBACK_MS 后 copied 归 null；连续复制重置定时', () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { copied, copy } = useCopy()
    copy('a', 'k1')
    copy('b', 'k2')
    expect(copied.value).toBe('k2')
    vi.advanceTimersByTime(2000)
    expect(copied.value).toBeNull()
  })
})
