/**
 * useTurnElapsed 单测（整 turn 墙钟口径 + 可见性停表）。
 *
 * 口径（2026-09 用户裁决「状态行应为整个 agent-turn 的聚合」）：
 * - elapsed = 整 turn 墙钟（起点 → 最后一次产出结束）；turn 进行中 now − 起点（含工具执行 /
 *   思考 / 等待），定格读 endedAt。**核心回归：单条 assistant 的 turn 不再是 1s**。
 * - generatedTokens = 本 turn 已上报的真实 usage.outputTokens 之和（不估算：缺 usage 的流式段
 *   计 0，收口后跳到完整值）。
 * - 时间模型：vi.useFakeTimers() 接管 Date.now；advanceTimersByTime 同步推进系统时间。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - 单条 assistant 定格 = endedAt − startedAt（不再是 min 1s）；endedAt 缺失回退（旧数据降级）
 * - turn 进行中秒级 tick 增长；工具执行/等待期间计时连续
 * - 定格不回跳（末帧 live 值 ≤ 定格值）
 * - 聚合值（起点/终点/token 总量）从 core deriveTurnAggregates 读取（含 user 起点 + usage 优先）
 * - 可见性：失焦停 tick / 恢复补算重启 / 失焦期间开始不计时 / 卸载清理 /
 *   listener 生命周期与进行中态对齐（完成态实例零 document listener）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/useTurnElapsed.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { Message } from '@taiji/shared'
import { deriveTurnAggregates, type MessageTurn, type TurnAggregates } from '@taiji/core/domain/chat'
import { useTurnElapsed } from '../composables/useTurnElapsed'

/** 测试起点系统时间（任意固定值） */
const T0 = 1_000_000

function makeAssistant(timestamp: number, content = 'text', overrides: Partial<Message> = {}): Message {
  return { id: `a-${timestamp}`, role: 'assistant', content, status: 'streaming', timestamp, ...overrides }
}

/** 最小合法 MessageTurn（聚合派生只读 user / assistants 两个字段） */
function makeTurn(userTs: number | null, assistants: Message[]): MessageTurn {
  return {
    index: 1,
    user: userTs === null ? null : { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'q' }], status: 'complete', timestamp: userTs },
    assistants,
    isStreaming: assistants.some((a) => a.status === 'streaming'),
    hasFoldable: false,
  }
}

/** mock document.hidden / visibilityState（happy-dom 下 spyOn getter 生效） */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * mount 宿主组件驱动 useTurnElapsed（onUnmounted/watch 需组件实例）。
 * @param getAggregates 聚合事实 getter（测试直接给 TurnAggregates 或经 deriveTurnAggregates）
 * @param running 本 turn 是否进行中（驱动秒级 tick 与 isLive）
 */
function mountElapsed(
  getAggregates: () => TurnAggregates,
  running: Ref<boolean>,
  sessionActive?: Ref<boolean>,
) {
  const exposed = {} as {
    elapsed: Ref<string>
    isLive: Ref<boolean>
    generatedTokens: Ref<number>
  }
  const collapses: number[] = []
  const Host = defineComponent({
    setup() {
      const result = useTurnElapsed(
        getAggregates,
        () => running.value,
        sessionActive ? () => sessionActive.value : undefined,
        () => collapses.push(1),
      )
      Object.assign(exposed, result)
      return () => null
    },
  })
  const wrapper = mount(Host)
  return { wrapper, exposed, collapses }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  setHidden(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ═════════════════════════════════════════════════════════════
// 整 turn 墙钟口径（核心修复：状态行 = 整个 agent-turn 聚合）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 整 turn 墙钟', () => {
  it('单条 assistant 定格 = endedAt − startedAt（回归：旧实现两条时间戳同源 → 恒显 1s）', () => {
    const start = T0
    const end = T0 + 6_800
    const aggregates: TurnAggregates = { startedAt: start, endedAt: end, generatedTokens: 322 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('7s')
    wrapper.unmount()
  })

  it('endedAt 缺失（旧历史帧）→ 回退聚合终点（= 修复前行为，不崩不虚高）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: T0, generatedTokens: 10 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('进行中每秒 tick 增长（now − 起点）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: 0, generatedTokens: 5 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s') // 挂载即 now − 起点 = 0 → min 1s
    vi.advanceTimersByTime(4_000)
    expect(exposed.elapsed.value).toBe('4s')
    wrapper.unmount()
  })

  it('工具执行 / 等待用户输入期间计时连续（含工具与等待的墙钟）', () => {
    // turn 进行中（工作 turn）→ tick 持续，期间无任何文本 delta，elapsed 仍持续增长
    const assistants = [makeAssistant(T0, '先读文件')]
    const turn = makeTurn(T0 - 200, assistants)
    const aggregates = () => deriveTurnAggregates(turn)
    const { wrapper, exposed } = mountElapsed(aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s')
    vi.advanceTimersByTime(40_000) // 40s 工具执行
    expect(exposed.elapsed.value).toBe('40s') // 计时未被工具期截断
    wrapper.unmount()
  })

  it('定格不回跳：endedAt 落定瞬间定格值 = 末帧 live 值（不再退化成 1s）', async () => {
    const assistants = ref<Message[]>([makeAssistant(T0, 'abc')])
    const turn = () => makeTurn(null, assistants.value)
    const running = ref(true)
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(turn()), running)
    vi.advanceTimersByTime(12_000)
    expect(exposed.elapsed.value).toBe('12s')

    // 收口：写入产出结束时刻（墙钟 12.4s 处）→ running false → 定格
    assistants.value = [{ ...assistants.value[0], status: 'complete', endedAt: T0 + 12_400 }]
    running.value = false
    await nextTick()
    expect(exposed.elapsed.value).toBe('12s') // 定格值 = 真实墙钟（旧实现此处回跳成 1s）
    wrapper.unmount()
  })

  it('生成 token 总量 = Σ usage.outputTokens（跨 assistant 段），随聚合值反应式更新', () => {
    const assistants = ref<Message[]>([
      makeAssistant(T0, 'abc', { usage: { inputTokens: 10, outputTokens: 120 } }),
      makeAssistant(T0 + 1000, 'de', { usage: { inputTokens: 5, outputTokens: 41 } }),
    ])
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn(null, assistants.value)), ref(true))
    expect(exposed.generatedTokens.value).toBe(161)

    assistants.value = [assistants.value[0], { ...assistants.value[1], usage: { inputTokens: 5, outputTokens: 60 } }]
    expect(exposed.generatedTokens.value).toBe(180)
    wrapper.unmount()
  })

  it('无 usage 的段（live 流式中）计入 0 → 数字只反映已上报真值，收口后跳完整值', () => {
    const first = makeAssistant(T0, 'ab', { usage: { inputTokens: 10, outputTokens: 122 } })
    const streaming = makeAssistant(T0 + 1, '正在写')
    const assistants = ref<Message[]>([first, streaming])
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn(null, assistants.value)), ref(true))
    expect(exposed.generatedTokens.value).toBe(122) // 当前段未上报 → 不估算

    assistants.value = [first, { ...streaming, usage: { inputTokens: 3, outputTokens: 39 } }]
    expect(exposed.generatedTokens.value).toBe(161) // 收口 → 完整值
    wrapper.unmount()
  })

  it('起点取 user 消息时间戳（整 turn 从用户发送算起，不从首条 assistant 算起）', () => {
    const userTs = T0
    const assistants = [makeAssistant(T0 + 3_000, 'abc', { status: 'complete', endedAt: T0 + 9_000 })]
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn(userTs, assistants)), ref(false))
    expect(exposed.elapsed.value).toBe('9s')
    wrapper.unmount()
  })

  it('空 turn（无 user / 无 assistant）→ 0s / 0 tokens / startedAt 0', () => {
    const aggregates: TurnAggregates = { startedAt: 0, endedAt: 0, generatedTokens: 0 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('0s')
    expect(exposed.generatedTokens.value).toBe(0)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 可见性停表（Q1-7）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 可见性停表（Q1-7）', () => {
  it('可见 + 进行中：每秒 tick 正常推进 elapsed（基线回归）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    vi.advanceTimersByTime(3_000)
    expect(exposed.elapsed.value).toBe('3s')
    wrapper.unmount()
  })

  it('失焦停止每秒 tick：hidden 后推进 10s，elapsed 不更新（interval 回调不触发）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    // tick 已停：Date.now 已推进 10s，但 elapsed 仍为定格值
    expect(Date.now()).toBe(T0 + 10_000)
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('失焦期间开始计时（running true）：不挂 interval（hidden 下 startElapsedTimer 只立即算一次）', async () => {
    const running = ref(false)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedTokens: 0 }), running)
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    running.value = true
    await nextTick() // watch flush:pre → startElapsedTimer（hidden 分支不挂 interval）

    vi.advanceTimersByTime(10_000)
    // 无 tick：elapsed 停在 hidden 进入时的值
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('恢复可见：elapsed 立即以 Date.now() 差值补算失焦期间耗时，并重启每秒 tick', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s') // 失焦期间未更新

    setHidden(false)
    fireVisibilityChange()
    // 补算：now-start = 10s（Date.now 差值覆盖失焦期间）
    expect(exposed.elapsed.value).toBe('10s')

    // tick 已重启：继续每秒推进
    vi.advanceTimersByTime(2_000)
    expect(exposed.elapsed.value).toBe('12s')
    wrapper.unmount()
  })

  it('失焦期间 turn 收口定格：恢复可见不误重启 tick（running 已 false）', async () => {
    const running = ref(true)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 5_000, generatedTokens: 0 }), running)

    setHidden(true)
    fireVisibilityChange()

    running.value = false
    await nextTick()
    const frozen = exposed.elapsed.value

    setHidden(false)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    expect(exposed.elapsed.value).toBe(frozen)
    wrapper.unmount()
  })

  it('卸载：移除 visibilitychange listener + 清 interval（无泄漏）', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s')
    expect(() => fireVisibilityChange()).not.toThrow()
  })

  it('完成态实例零 listener：未开始计时不挂 visibilitychange（W05 review，N 实例不叠 N listener）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 3_000, generatedTokens: 0 }), ref(false))
    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    wrapper.unmount()
  })

  it('listener 生命周期与进行中态对齐：开始计时挂载、收口定格摘除、二次周期不叠加', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const addedCount = () => addSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length
    const removedCount = () => removeSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length

    const running = ref(false)
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedTokens: 0 }), running)
    expect(addedCount()).toBe(0) // 初始完成态：零 listener

    running.value = true
    await nextTick()
    expect(addedCount()).toBe(1)

    running.value = false
    await nextTick()
    expect(removedCount()).toBe(1)

    running.value = true
    await nextTick()
    running.value = false
    await nextTick()
    expect(addedCount()).toBe(2)
    expect(removedCount()).toBe(2)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 完成收起回调（isSessionActive 驱动，非 turn 进行中态驱动）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 完成收起回调', () => {
  it('isSessionActive true→false 触发 onComplete（ask-user 期间会话仍活跃 → 不收起）', async () => {
    const running = ref(true)
    const sessionActive = ref(true)
    const { wrapper, collapses } = mountElapsed(
      () => ({ startedAt: T0, endedAt: 0, generatedTokens: 0 }),
      running,
      sessionActive,
    )

    // 会话仍活跃（工具阻塞 / ask-user 等待）→ 不收起
    running.value = false
    await nextTick()
    expect(collapses).toHaveLength(0)

    // 对话真正结束 → 收起一次
    sessionActive.value = false
    await nextTick()
    expect(collapses).toHaveLength(1)
    wrapper.unmount()
  })
})
