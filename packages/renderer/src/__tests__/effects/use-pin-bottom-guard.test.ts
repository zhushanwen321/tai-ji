/**
 * usePinBottomGuard 单测（chat-pin-bottom-fix §4.4 护栏⑦，U4-G 授权）。
 *
 * 覆盖 fake timers 可控的双采样时序与判读文案（§4.4⑦ spec 逐条）：
 * - 500ms 收敛窗口：窗口末首采，超阈值隔 200ms 复采，两次均超才 warn
 * - 首采超 / 复采收敛 → 静默（估算收敛期合法瞬态被双采样过滤）
 * - 窗口末未超 → 不安排复采
 * - 用户脱离（stickToBottom 翻 false）取消窗口 → 不发声（不对阅读静止态报警）
 * - 新 follow 重启窗口（旧窗口采样点作废）
 * - 阈值 max(2, 2×dpr) 取整（dpr=2 → 阈值 4px）
 * - isStreaming=true 判读指引文案（流式双超按真实跟随失效）
 * - scrollEl 未挂载（null）→ 采样跳过不发声
 *
 * 不可单测部分（真实 dpr / 真实布局的端到端行为）留给 dev 断言侧 V8 故障注入
 * （实施计划 U4 验收④，主 agent 在 dev app 执行）。
 *
 * mock 策略：follow 参数传完整 FollowApi stub（followIfStuck/followToBottom 为 vi.fn，
 * 只验证「包装层透传参数 + 触发窗口」，原语内部行为归 use-virtua-follow.test.ts）；
 * scrollEl 传持可变属性的普通对象 ref（guard 只读 scrollHeight/scrollTop/clientHeight），
 * 用例间直接改属性模拟收敛/未收敛。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import type { Ref } from 'vue'
import { usePinBottomGuard, type FollowApi } from '@/composables/panel/usePinBottomGuard'

/** 构造完整 FollowApi stub（guard 仅消费 stickToBottom + 透传两个 follow 原语） */
function createFollowStub(): FollowApi {
  const stickToBottom = ref(true)
  const unreadBelow = ref(false)
  return {
    stickToBottom,
    unreadBelow,
    showJumpButton: computed(() => !stickToBottom.value && unreadBelow.value),
    onScroll: vi.fn(),
    onWheel: vi.fn(),
    followIfStuck: vi.fn(),
    followToBottom: vi.fn(),
    onSessionRebuild: vi.fn(),
    notifyRoActivity: vi.fn(),
  }
}

/** 滚动容器 stub：默认 gap = 1000 - 480 - 500 = 20px（dpr=1 阈值 2px 下超阈） */
function createScrollElStub(): Ref<HTMLElement> {
  return ref({ scrollHeight: 1000, scrollTop: 480, clientHeight: 500 } as HTMLElement)
}

describe('usePinBottomGuard（§4.4 护栏⑦ dev 断言）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('devicePixelRatio', 1)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function setup(overrides: Partial<Parameters<typeof usePinBottomGuard>[0]> = {}) {
    const follow = createFollowStub()
    const scrollEl = createScrollElStub()
    // effectScope 包裹：guard 内 watch/onScopeDispose 需要活跃 scope（否则 [Vue warn]
    // onScopeDispose 走 console.warn 污染断言）
    let api!: FollowApi
    effectScope().run(() => {
      api = usePinBottomGuard({ follow, scrollEl, ...overrides })
    })
    return { follow, scrollEl, api }
  }

  it('双采样均超阈值才 warn：窗口末首采静默，+200ms 复采仍超 → warn 恰一次（附 gap/dpr 上下文）', async () => {
    const { follow, api } = setup()

    api.followIfStuck()
    // follow 原语透传（包装层不丢参数）
    expect(follow.followIfStuck).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500) // 窗口末首采：gap=20 > 2 → 安排复采
    expect(warnSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200) // 复采：仍 20 > 2 → warn
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]?.[0] as string
    expect(msg).toContain('[pin-bottom-guard]')
    expect(msg).toContain('gap=20')
    expect(msg).toContain('dpr=1')
    expect(msg).toContain('docs/design/chat-pin-bottom-fix.md')
  })

  it('首采超、复采已收敛（合法瞬态）→ 静默不 warn', async () => {
    const { scrollEl, api } = setup()

    api.followIfStuck()
    await vi.advanceTimersByTimeAsync(500) // 首采超（gap=20）→ 安排复采
    scrollEl.value.scrollTop = 498 // gap = 2 ≤ 阈值：收敛
    await vi.advanceTimersByTimeAsync(200)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('窗口末 gap 未超阈值 → 不安排复采，后续无 warn', async () => {
    const { scrollEl, api } = setup()
    scrollEl.value.scrollTop = 498 // gap = 2 ≤ 2：未超

    api.followIfStuck()
    await vi.advanceTimersByTimeAsync(700)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('用户脱离取消窗口：采样点前 stickToBottom 翻 false → 不发声（不对阅读静止态报警）', async () => {
    const { follow, api } = setup()

    api.followIfStuck()
    follow.stickToBottom.value = false // wheel / 拖拽 / 键盘上滑的汇聚信号
    await vi.advanceTimersByTimeAsync(700)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('新 follow 重启窗口：旧窗口采样点作废，从最近一次 follow 重新计 500ms', async () => {
    const { api } = setup()

    api.followIfStuck()
    await vi.advanceTimersByTimeAsync(300)
    api.followToBottom(true) // 重启窗口（旧窗口本应 +200ms 后采样）
    expect(warnSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200) // 距首 follow 500ms、距新 follow 仅 200ms：未到采样点
    expect(warnSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300) // 新窗口末首采
    expect(warnSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200) // 复采仍超 → warn
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('阈值 max(2, 2×dpr)：dpr=2 时阈值 4px——gap=3 不报警，gap=5 报警且文案含阈值 4/dpr=2', async () => {
    vi.stubGlobal('devicePixelRatio', 2)

    const s1 = setup()
    s1.scrollEl.value.scrollTop = 497 // gap = 3 ≤ 4
    s1.api.followIfStuck()
    await vi.advanceTimersByTimeAsync(700)
    expect(warnSpy).not.toHaveBeenCalled()

    const s2 = setup()
    s2.scrollEl.value.scrollTop = 495 // gap = 5 > 4
    s2.api.followIfStuck()
    await vi.advanceTimersByTimeAsync(700)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]?.[0] as string
    expect(msg).toContain('阈值 4')
    expect(msg).toContain('dpr=2')
  })

  it('isStreaming=true → warn 文案按真实跟随失效判读（流式持续 gap 无合法瞬态解释）', async () => {
    const { api } = setup({ isStreaming: () => true })

    api.followIfStuck()
    await vi.advanceTimersByTimeAsync(700)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]?.[0] as string
    expect(msg).toContain('isStreaming=true')
    expect(msg).toContain('真实跟随失效')
  })

  it('scrollEl 未挂载（null）→ 采样跳过不发声', async () => {
    const { api } = setup({ scrollEl: ref(null) })

    api.followIfStuck()
    await vi.advanceTimersByTimeAsync(700)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('followToBottom 包装透传 force 参数并触发窗口（回到底部按钮 / force 内联路径同一入口）', async () => {
    const { follow, api } = setup()

    api.followToBottom(true)
    expect(follow.followToBottom).toHaveBeenCalledWith(true)

    await vi.advanceTimersByTimeAsync(700)
    expect(warnSpy).toHaveBeenCalledTimes(1) // 窗口已开：gap 超阈双采样后照常报警
  })

  it('P-no-loop 频率计数器（§4.5）：1s 内 follow >60 次 → 沿触发 warn 一次；持续超限不重复，滑出回落后再超限再报', async () => {
    const { api } = setup()
    const loopWarns = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes('follow 频率异常'))

    for (let i = 0; i < 60; i += 1) api.followToBottom(true)
    expect(loopWarns()).toHaveLength(0) // 恰 60 次：不超限

    api.followToBottom(true) // 第 61 次 → 超限沿
    expect(loopWarns()).toHaveLength(1)
    const msg = String(loopWarns()[0]?.[0])
    expect(msg).toContain('次数=61')
    expect(msg).toContain('P-no-loop')
    expect(msg).toContain('docs/design/chat-pin-bottom-fix.md')

    for (let i = 0; i < 40; i += 1) api.followToBottom(true)
    expect(loopWarns()).toHaveLength(1) // 持续超限：沿触发不重复

    vi.advanceTimersByTime(1001) // 窗口滑出：计数回落（loopActive 复位于下次调用）
    for (let i = 0; i < 61; i += 1) api.followToBottom(true)
    expect(loopWarns()).toHaveLength(2) // 回落后再超限 → 再报
  })

  it('P-no-loop 与收敛窗独立：低频 follow（≤60/s）下计数器零发声，收敛窗行为不受影响', async () => {
    const { api } = setup()

    for (let i = 0; i < 60; i += 1) api.followToBottom(true)
    await vi.advanceTimersByTimeAsync(700)
    // 频率未超限无频率 warn；但收敛窗双采样照常（gap=20 超阈 → 恰一次收敛 warn）
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('follow 频率异常'))).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('贴底态跟随未收敛')
  })
})
