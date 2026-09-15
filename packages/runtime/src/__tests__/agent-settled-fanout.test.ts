/**
 * fanOutSettled 单元测试（PR #189 review：从 index.ts 组合根内联提取后的可测性补齐）。
 *
 * 覆盖：
 * - 全部订阅者收到同一 sessionId（正常多播）
 * - 单订阅者抛错不阻断其余腿（sd-u5/sd-u6 异常隔离契约——bash flush / delivery 唤醒 /
 *   回流检测各自独立，事件流主链优先）
 * - 异常订阅者 warn 留痕（经 initLogger monkey-patch 落盘的观测通道）
 * - 空列表 / 无异常时静默（不 warn）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/agent-settled-fanout.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fanOutSettled } from '../services/session/agent-settled-fanout.js'

describe('fanOutSettled', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // 吞掉 warn 输出防测试刷屏；断言其调用次数与内容（异常隔离的观测面）
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('全部订阅者收到同一 sessionId', () => {
    const a = vi.fn()
    const b = vi.fn()
    const listeners = new Set([a, b])

    fanOutSettled(listeners, 'sess-1')

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('sess-1')
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith('sess-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('单订阅者抛错不阻断其余腿（异常隔离契约）', () => {
    const first = vi.fn(() => { throw new Error('delivery kernel exploded') })
    const second = vi.fn()
    const third = vi.fn()
    const listeners = new Set([first, second, third])

    // 不应向调用方抛出（interpret 批次不能因单个订阅者崩溃）
    expect(() => fanOutSettled(listeners, 'sess-1')).not.toThrow()

    // 抛错订阅者之后的腿照常收到分发
    expect(second).toHaveBeenCalledWith('sess-1')
    expect(third).toHaveBeenCalledWith('sess-1')
  })

  it('异常订阅者 warn 留痕（含错误对象，可观测）', () => {
    const boom = new Error('listener failed')
    const listeners = new Set([() => { throw boom }, () => {}])

    fanOutSettled(listeners, 'sess-1')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[runtime] agentSettled listener failed:', boom)
  })

  it('全部订阅者异常 → 每个各 warn 一次，不抛出', () => {
    const listeners = new Set([
      () => { throw new Error('a') },
      () => { throw new Error('b') },
    ])

    expect(() => fanOutSettled(listeners, 'sess-1')).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('空订阅列表 → no-op 且不 warn', () => {
    fanOutSettled(new Set(), 'sess-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
