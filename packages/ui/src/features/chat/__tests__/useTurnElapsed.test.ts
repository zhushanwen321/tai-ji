/**
 * useTurnElapsed 单测（整 turn 墙钟口径 + 可见性停表）。
 *
 * 口径（2026-09 用户裁决「状态行应为整个 agent-turn 的聚合」）：
 * - elapsed = 整 turn 墙钟（起点 → 最后一次产出结束）；producing 期间 now − 起点（含工具执行 /
 *   思考 / 等待），定格读 endedAt。**核心回归：单条 assistant 的 turn 不再是 1s**。
 * - generatedChars = Σ 正文 + Σ thinking（读 core 聚合值，非本地求和）。
 * - 时间模型：vi.useFakeTimers() 接管 Date.now；advanceTimersByTime 同步推进系统时间。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - 单条 assistant 定格 = endedAt − startedAt（不再是 min 1s）；endedAt 缺失回退（旧数据降级）
 * - producing 秒级 tick 增长；工具执行/等待期间 producing 保持 true → 计时连续
 * - 定格不回跳（末帧 live 值 ≤ 定格值）
 * - 聚合值（起点/终点/生成字符总量）从 core deriveTurnAggregates 读取（含 user 起点 + thinking）
 * - 可见性：失焦停 tick / 恢复补算重启 / 失焦期间 producing 开始不挂 interval / 卸载清理 /
 *   listener 生命周期与 producing 对齐（完成态实例零 document listener）
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
 */
function mountElapsed(
  getAggregates: () => TurnAggregates,
  producing: Ref<boolean>,
  sessionActive?: Ref<boolean>,
) {
  const exposed = {} as {
    elapsed: Ref<string>
    elapsedSecs: Ref<number>
    isLive: Ref<boolean>
    generatedChars: Ref<number>
  }
  const collapses: number[] = []
  const Host = defineComponent({
    setup() {
      const result = useTurnElapsed(
        getAggregates,
        () => producing.value,
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
    const aggregates: TurnAggregates = { startedAt: start, endedAt: end, generatedChars: 322 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('7s')
    expect(exposed.elapsedSecs.value).toBe(7)
    wrapper.unmount()
  })

  it('endedAt 缺失（旧历史帧）→ 回退聚合终点（= 修复前行为，不崩不虚高）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: T0, generatedChars: 10 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('producing 中每秒 tick 增长（now − 起点）', () => {
    const aggregates: TurnAggregates = { startedAt: T0, endedAt: 0, generatedChars: 5 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s') // 挂载即 now − 起点 = 0 → min 1s
    vi.advanceTimersByTime(4_000)
    expect(exposed.elapsed.value).toBe('4s')
    wrapper.unmount()
  })

  it('工具执行 / 等待用户输入期间 producing 保持 true → 计时连续（含工具时间的墙钟）', () => {
    // 末位 assistant 仍 streaming（live 下工具执行期保持 streaming）→ producing true，
    // 期间无任何文本 delta，elapsed 仍持续增长
    const assistants = [makeAssistant(T0, '先读文件')]
    const turn = makeTurn(T0 - 200, assistants)
    const aggregates = () => deriveTurnAggregates(turn)
    const { wrapper, exposed } = mountElapsed(aggregates, ref(true))
    expect(exposed.elapsed.value).toBe('1s')
    vi.advanceTimersByTime(40_000) // 40s 工具执行
    expect(exposed.elapsed.value).toBe('40s') // 计时未被工具期截断
    wrapper.unmount()
  })

  it('定格不回跳：endedAt 落定瞬间定格值 ≥ 末帧 live 值（不再退化成 1s）', async () => {
    const assistants = ref<Message[]>([makeAssistant(T0, 'abc')])
    const turn = () => makeTurn(null, assistants.value)
    const producing = ref(true)
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(turn()), producing)
    vi.advanceTimersByTime(12_000)
    expect(exposed.elapsed.value).toBe('12s')

    // 收口：写入产出结束时刻（墙钟 12.4s 处）→ producing false → 定格
    assistants.value = [{ ...assistants.value[0], status: 'complete', endedAt: T0 + 12_400 }]
    producing.value = false
    await nextTick()
    expect(exposed.elapsed.value).toBe('12s') // 定格值 = 真实墙钟（旧实现此处回跳成 1s）
    expect(exposed.elapsedSecs.value).toBe(12)
    wrapper.unmount()
  })

  it('生成字符总量 = Σ 正文 + Σ thinking（跨 assistant 段），随聚合值反应式更新', () => {
    const assistants = ref<Message[]>([
      makeAssistant(T0, 'abc', { thinking: [{ id: 'th1', content: '想了一', collapsed: true }] }),
      makeAssistant(T0 + 1000, 'de', { thinking: [{ id: 'th2', content: '想二', collapsed: true }] }),
    ])
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn(null, assistants.value)), ref(true))
    // 正文 3 + 2 = 5；思考 3（想了一）+ 2（想二）= 5 → 10
    expect(exposed.generatedChars.value).toBe(10)

    assistants.value = [
      assistants.value[0],
      { ...assistants.value[1], content: 'def', thinking: [{ id: 'th2', content: '想二想', collapsed: true }] },
    ]
    // 正文 3 + 3 = 6；思考 3 + 3 = 6 → 12
    expect(exposed.generatedChars.value).toBe(12)
    wrapper.unmount()
  })

  it('起点取 user 消息时间戳（整 turn 从用户发送算起，不从首条 assistant 算起）', () => {
    const userTs = T0
    const assistants = [makeAssistant(T0 + 3_000, 'abc', { status: 'complete', endedAt: T0 + 9_000 })]
    const { wrapper, exposed } = mountElapsed(() => deriveTurnAggregates(makeTurn(userTs, assistants)), ref(false))
    expect(exposed.elapsed.value).toBe('9s')
    wrapper.unmount()
  })

  it('空 turn（无 user / 无 assistant）→ 0s / 0 字符 / startedAt 0', () => {
    const aggregates: TurnAggregates = { startedAt: 0, endedAt: 0, generatedChars: 0 }
    const { wrapper, exposed } = mountElapsed(() => aggregates, ref(false))
    expect(exposed.elapsed.value).toBe('0s')
    expect(exposed.elapsedSecs.value).toBe(0)
    expect(exposed.generatedChars.value).toBe(0)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 可见性停表（Q1-7）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 可见性停表（Q1-7）', () => {
  it('可见 + producing：每秒 tick 正常推进 elapsed（基线回归）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedChars: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    vi.advanceTimersByTime(3_000)
    expect(exposed.elapsed.value).toBe('3s')
    expect(exposed.elapsedSecs.value).toBe(3)
    wrapper.unmount()
  })

  it('失焦停止每秒 tick：hidden 后推进 10s，elapsed 不更新（interval 回调不触发）', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedChars: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    fireVisibilityChange()
    vi.advanceTimersByTime(10_000)

    // tick 已停：Date.now 已推进 10s，但 elapsed 仍为定格值
    expect(Date.now()).toBe(T0 + 10_000)
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('失焦期间 producing 开始：不挂 interval（hidden 下 startElapsedTimer 只立即算一次）', async () => {
    const producing = ref(false)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedChars: 0 }), producing)
    expect(exposed.elapsed.value).toBe('1s')

    setHidden(true)
    producing.value = true
    await nextTick() // watch flush:pre → startElapsedTimer（hidden 分支不挂 interval）

    vi.advanceTimersByTime(10_000)
    // 无 tick：elapsed 停在 hidden 进入时的值
    expect(exposed.elapsed.value).toBe('1s')
    wrapper.unmount()
  })

  it('恢复可见：elapsed 立即以 Date.now() 差值补算失焦期间耗时，并重启每秒 tick', () => {
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedChars: 0 }), ref(true))

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

  it('失焦期间产出结束定格：恢复可见不误重启 tick（producing 已 false）', async () => {
    const producing = ref(true)
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 5_000, generatedChars: 0 }), producing)

    setHidden(true)
    fireVisibilityChange()

    producing.value = false
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
    const { wrapper, exposed } = mountElapsed(() => ({ startedAt: T0, endedAt: 0, generatedChars: 0 }), ref(true))
    expect(exposed.elapsed.value).toBe('1s')

    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    vi.advanceTimersByTime(10_000)
    expect(exposed.elapsed.value).toBe('1s')
    expect(() => fireVisibilityChange()).not.toThrow()
  })

  it('完成态实例零 listener：未开始计时不挂 visibilitychange（W05 review，N 实例不叠 N listener）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0 + 3_000, generatedChars: 0 }), ref(false))
    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    wrapper.unmount()
  })

  it('listener 生命周期与 producing 对齐：开始计时挂载、完成定格摘除、二次周期不叠加', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const addedCount = () => addSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length
    const removedCount = () => removeSpy.mock.calls.filter(([t]) => t === 'visibilitychange').length

    const producing = ref(false)
    const { wrapper } = mountElapsed(() => ({ startedAt: T0, endedAt: T0, generatedChars: 0 }), producing)
    expect(addedCount()).toBe(0) // 初始完成态：零 listener

    producing.value = true
    await nextTick()
    expect(addedCount()).toBe(1)

    producing.value = false
    await nextTick()
    expect(removedCount()).toBe(1)

    producing.value = true
    await nextTick()
    producing.value = false
    await nextTick()
    expect(addedCount()).toBe(2)
    expect(removedCount()).toBe(2)
    wrapper.unmount()
  })
})

// ═════════════════════════════════════════════════════════════
// 完成收起回调（isSessionActive 驱动，非 producing 驱动）
// ═════════════════════════════════════════════════════════════
describe('useTurnElapsed 完成收起回调', () => {
  it('isSessionActive true→false 触发 onComplete（ask-user 期间 producing false 但会话仍活跃 → 不收起）', async () => {
    const producing = ref(true)
    const sessionActive = ref(true)
    const { wrapper, collapses } = mountElapsed(
      () => ({ startedAt: T0, endedAt: 0, generatedChars: 0 }),
      producing,
      sessionActive,
    )

    // producing false（工具阻塞 / ask-user 等待）但会话仍活跃 → 不收起
    producing.value = false
    await nextTick()
    expect(collapses).toHaveLength(0)

    // 对话真正结束 → 收起一次
    sessionActive.value = false
    await nextTick()
    expect(collapses).toHaveLength(1)
    wrapper.unmount()
  })
})
