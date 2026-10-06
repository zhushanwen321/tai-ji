/**
 * useMessageStreamRail 单测（cw wave w4 / W2TC2）。
 *
 * [cw wave w4] 单一 virtua 路径：vlistRef 必填，onJump/updateActiveTurnIndex 都走 virta API。
 * 保留 W2TC2（virtua 路径）用例；W2TC1（旧路径 scrollTop 写入）/ W2TC3（null fallback）随
 * offsetOf/topOffset 删除 + vlistRef 必填化而移除（virta handle 由消费方保证挂载后注入）。
 *
 * 验证：
 * - W2TC2 传 mock vlistRef → onJump 调 vlist.scrollToIndex(renderIdx, {align:'start'})
 * - W2TC2 传 mock vlistRef → updateActiveTurnIndex 调 vlist.findItemIndex(scrollOffset)
 * - streaming perf：railTurns 引用恒等（内容未变的重算复用上次数组引用，切断
 *   expandedTurns / TurnRail props 连带失效）+ updateActiveTurnIndex O(1) 下标索引
 *   （随 railTurns 重建同步更新，行为与旧 findIndex 实现逐点等价）
 *
 * mock 策略：用 createMockVlist 造满足 VirtualizerHandle 接口的 mock，注入 vlistRef。
 * composable 内 onMounted/onScopeDispose 需 active component instance，用 host 组件包裹
 * （参考 MessageStream.wire.test.ts:261-288 的 mountRail helper）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-message-stream-rail-virtua.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref, shallowRef, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { VirtualizerHandle } from 'virtua/vue'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import type { MessageTurn, RenderItem } from '@/composables/logic/messageTurns'
import { createMockVlist } from './_virtua-mock-helper'

// ── 测试数据工厂 ────────────────────────────────────────────────────

/** 构造一个 turn RenderItem（index 可控；content 缺省 'q'，rail 投影摘要 = 'q'）。 */
function turnItem(index: number, content = 'q'): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `u${index}`, role: 'user', content } as never,
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    } as MessageTurn,
  }
}

/** 构造 3 个 turn 的 renderItems（rail 索引空间 = 3 turns，renderItems 下标 0/1/2）。 */
function makeRenderItems(): RenderItem[] {
  return [turnItem(1), turnItem(2), turnItem(3)]
}

/**
 * mount 一个 host 组件，setup 内调 useMessageStreamRail（composable 内 onMounted/onScopeDispose
 * 需 active component instance，用 host 组件包裹避免「no active effect scope」warning）。
 * 返回 rail composable 返回值 + host wrapper（unmount 触发 onScopeDispose 清理）。
 *
 * [cw wave w4] vlistRef 必填：默认注入 createMockVlist()，virtua 路径专用。
 */
function mountRail(opts: {
  renderItems?: RenderItem[]
  scrollEl?: HTMLElement | null
  vlistRef?: Ref<VirtualizerHandle | null>
}): {
  rail: ReturnType<typeof useMessageStreamRail>
  wrapper: ReturnType<typeof mount>
  /** 暴露 renderItems ref 供 streaming perf 用例替换数组引用（模拟 ADR-0039 不可变替换）。 */
  renderItemsRef: Ref<RenderItem[]>
} {
  const sessionId = computed(() => 's-rail-virtua-test')
  // shallowRef 对齐生产语义：MessageStream 传入的 renderItems 是 computed（产出原始数组，
  // 无深代理）；deep ref 会把读取侧 item.turn 包成 reactive 代理，引用恒等断言拿不到原始引用。
  const renderItemsRef = shallowRef<RenderItem[]>(opts.renderItems ?? makeRenderItems())
  const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
  const vlistRef = opts.vlistRef ?? ref<VirtualizerHandle | null>(createMockVlist())
  let rail!: ReturnType<typeof useMessageStreamRail>
  const Host = defineComponent({
    setup() {
      rail = useMessageStreamRail({
        sessionId,
        renderItems: renderItemsRef,
        scrollEl: scrollElRef,
        vlistRef,
      })
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
  return { rail, wrapper, renderItemsRef }
}

/** 造一个有真实 scrollTop/scrollHeight/clientHeight 的 mock scrollEl（happy-dom 下 div 即可）。 */
function makeScrollEl(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { writable: true, value: 0 })
  Object.defineProperty(el, 'scrollHeight', { writable: true, value: 600 })
  Object.defineProperty(el, 'clientHeight', { writable: true, value: 200 })
  return el
}

beforeEach(() => {
  setActivePinia(createPinia())
})

// ── W2TC2: 传 mock vlistRef → virtua 路径 ──────────────────────────

describe('useMessageStreamRail · W2TC2: 传 mock vlistRef（virtua 路径）', () => {
  it('onJump 调 vlist.scrollToIndex(renderIdx, {align:"start"})', () => {
    const scrollEl = makeScrollEl()
    const mock = createMockVlist()
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ scrollEl, vlistRef })

    rail.onJump(1) // renderItems 下标=1

    expect(mock.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
  })

  it('updateActiveTurnIndex 调 vlist.findItemIndex(v.scrollOffset)，写 activeTurnIndex', () => {
    // findItemIndex mock：返回固定 2（模拟 vlist 当前可见首项）
    const findItemIndex = vi.fn(() => 2)
    const mock = createMockVlist({ scrollOffset: 500, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ vlistRef })

    rail.updateActiveTurnIndex()

    expect(findItemIndex).toHaveBeenCalledWith(500)
    expect(rail.activeTurnIndex.value).toBe(2)
  })

  it('updateActiveTurnIndex 把 renderItems 空间下标映射回 railTurns 空间（system 穿插场景）', () => {
    // renderItems = [turn0, system, turn1, system, turn2]：railTurns = [turn0, turn1, turn2]
    // findItemIndex 返回 4（renderItems 空间，指向 turn2）→ 映射回 railTurns 空间下标 2
    // 未修复时 activeTurnIndex 会是 4（> railTurns.length=3），TurnRail 的 topPct 计算会越界。
    const renderItems: RenderItem[] = [
      turnItem(1),
      { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
      turnItem(2),
      { kind: 'systemNotice', message: { id: 's2', role: 'system', content: 'y' } as never },
      turnItem(3),
    ]
    const findItemIndex = vi.fn(() => 4)
    const mock = createMockVlist({ scrollOffset: 800, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ renderItems, vlistRef })

    rail.updateActiveTurnIndex()

    expect(findItemIndex).toHaveBeenCalledWith(800)
    // railTurns 空间下标：turn2 是 railTurns[2]，不是 renderItems[4]
    expect(rail.activeTurnIndex.value).toBe(2)
  })

  it('onJump rail idx 映射回 renderItems 下标（系统提示行穿插场景）', () => {
    // renderItems = [system, turn1, system, turn2, turn3]：railTurns=[turn1,turn2,turn3]
    // rail idx=2（turn3）→ renderItems 下标=4
    const renderItems: RenderItem[] = [
      { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
      turnItem(1),
      { kind: 'systemNotice', message: { id: 's2', role: 'system', content: 'y' } as never },
      turnItem(2),
      turnItem(3),
    ]
    const scrollEl = makeScrollEl()
    const mock = createMockVlist()
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail } = mountRail({ renderItems, scrollEl, vlistRef })

    rail.onJump(2) // rail idx 2 = turn3 → renderItems 下标 4

    expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'start' })
  })

  it('[cw wave w4] vlistRef.value=null（首帧未挂载）→ onJump/updateActiveTurnIndex 早返回 no-op', () => {
    // vlistRef 必填但 value 可能为 null（首帧未挂载 / session 切换 dispose）：composable 不抛错，no-op。
    const scrollEl = makeScrollEl()
    const vlistRef = ref<VirtualizerHandle | null>(null)
    const { rail } = mountRail({ scrollEl, vlistRef })

    expect(() => rail.onJump(1)).not.toThrow()
    expect(() => rail.updateActiveTurnIndex()).not.toThrow()
    // activeTurnIndex 保持初始 0（未调 findItemIndex）
    expect(rail.activeTurnIndex.value).toBe(0)
  })
})

// ── streaming perf：railTurns 引用恒等 + updateActiveTurnIndex O(1) 索引 ──────────

describe('useMessageStreamRail · streaming perf（railTurns 引用恒等 + O(1) 下标索引）', () => {
  it('renderItems 替换数组引用但 turn 成员未变 → railTurns 复用上次数组引用（下游 props 不变即不重渲）', () => {
    // 模拟 streaming：每条 delta 经 commitMessages 替换 renderItems 数组引用（ADR-0039），
    // 历史 turn 对象逐引用复用（toRenderItemsIncremental D-4）→ 内容未变的重算必须
    // 返回同一引用，否则 TurnRail turns prop / expandedTurns 依赖被连带失效。
    const base = makeRenderItems()
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
    const first = rail.railTurns.value

    renderItemsRef.value = [...base]

    expect(rail.railTurns.value).toBe(first)
    wrapper.unmount()
  })

  it('turn 引用变化且 rail 投影摘要变化 → railTurns 产出新数组且未变成员引用逐项保留', () => {
    // 行为不变反面：末位 turn 的 rail 可见内容变化（user 正文变 → 摘要变）必须照常产出
    // 新数组（不能过度缓存吞掉真实变更）；此处同时换 index 与 content 保证新旧引用与
    // 投影签名都不同。
    const base = makeRenderItems()
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
    const first = rail.railTurns.value
    const rebuiltLast = turnItem(4, 'changed question') // 模拟末位 turn 重建且内容真实变化

    renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
    const second = rail.railTurns.value

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).toBe(rebuiltLast.turn)
    wrapper.unmount()
  })

  it('仅末位 turn 引用不同且 rail 投影摘要未变 → railTurns 复用旧数组引用（投影恒等放宽）', () => {
    // streaming perf：末位 turn 每 delta 帧新引用（ADR-0039 不可变替换），但 rail 显示的
    // 摘要（userSummary/agentSummary/failed/iconClass）未变 → TurnRail render 输出不变，
    // 旧数组引用复用让 TurnRail props 不变 → 常驻面板零 vnode diff。
    const base = makeRenderItems()
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
    const first = rail.railTurns.value
    const rebuiltLast = turnItem(4) // content 同为 'q' → rail 投影摘要相同

    renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]

    expect(rail.railTurns.value).toBe(first)
    wrapper.unmount()
  })

  it('投影恒等复用后 onJump 末位 rail 下标仍跳到当前最新 turn（结构定位兜底）', () => {
    // 旧数组末位持旧引用，按引用 findIndex 必 miss → 兜底「第 idx 个 turn 项」定位，
    // 仍指向 renderItems 中当前末位 turn（重建后的新引用），跳转语义不变。
    const base = makeRenderItems()
    const findItemIndex = vi.fn(() => 0)
    const mock = createMockVlist({ findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base, vlistRef })
    rail.railTurns.value // 触发首次求值
    const rebuiltLast = turnItem(4) // 摘要相同 → 放宽复用

    renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
    rail.onJump(2) // rail 末位下标

    expect(mock.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })
    wrapper.unmount()
  })

  it('投影恒等复用后 updateActiveTurnIndex 对末位新引用仍定位末位下标（补映射不退化）', () => {
    // 放宽帧返回旧数组时同步补末位下标映射：滚动反查到末位新引用时 O(1) 命中，
    // activeTurnIndex 保持末位（2），不退化 findIndex/-1。
    const base = makeRenderItems()
    const findItemIndex = vi.fn(() => 2) // 视口反查指向 renderItems[2] = 末位 turn
    const mock = createMockVlist({ scrollOffset: 800, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base, vlistRef })
    rail.railTurns.value
    const rebuiltLast = turnItem(4)

    renderItemsRef.value = [base[0]!, base[1]!, rebuiltLast]
    rail.updateActiveTurnIndex()

    expect(rail.activeTurnIndex.value).toBe(2)
    wrapper.unmount()
  })

  it('railTurns 引用恒等连带 expandedTurns 不重算（非空 Set 引用稳定）——依赖链切断的可观测证据', () => {
    // 必须先展开出非空 Set：空态返回 EMPTY_SET 模块单例，重算与否引用恒同，断言会恒真。
    // 非空分支每次重算 new Set()：若 railTurns 引用恒等失效导致 expandedTurns 重算，
    // 这里会拿到新 Set 引用而失败。
    const base = makeRenderItems()
    const { rail, renderItemsRef, wrapper } = mountRail({ renderItems: base })
    rail.onToggle(0)
    const expanded = rail.expandedTurns.value
    expect(expanded.size).toBe(1)

    renderItemsRef.value = [...base]

    expect(rail.expandedTurns.value).toBe(expanded)
    wrapper.unmount()
  })

  it('O(1) 索引随 railTurns 重建同步更新：同一 turn 引用移动下标后仍定位新下标（守卫索引过期回归）', () => {
    // 陈旧索引会把复用引用的 turn 定位到旧下标（indicator 高亮错位）——数组引用一变索引必须重建。
    const moved = turnItem(2)
    const findItemIndex = vi.fn(() => 1) // renderItems[1] = moved → rail 下标 1
    const mock = createMockVlist({ scrollOffset: 400, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail, renderItemsRef, wrapper } = mountRail({
      renderItems: [turnItem(1), moved],
      vlistRef,
    })

    rail.updateActiveTurnIndex()
    expect(rail.activeTurnIndex.value).toBe(1)

    // 重排：moved 复用同引用但 rail 下标 1 → 0
    findItemIndex.mockImplementation(() => 0)
    renderItemsRef.value = [moved, turnItem(9)]
    rail.updateActiveTurnIndex()
    // 若索引未随重建，get(moved) 命中旧值 1，此处失败
    expect(rail.activeTurnIndex.value).toBe(0)
    wrapper.unmount()
  })

  it('updateActiveTurnIndex：可见首项为 system 项 → 保持上次 activeTurnIndex（映射分支行为不变）', () => {
    const renderItems: RenderItem[] = [
      turnItem(1),
      { kind: 'systemNotice', message: { id: 's1', role: 'system', content: 'x' } as never },
    ]
    const findItemIndex = vi.fn(() => 1)
    const mock = createMockVlist({ scrollOffset: 100, findItemIndex })
    const vlistRef = ref<VirtualizerHandle | null>(mock)
    const { rail, wrapper } = mountRail({ renderItems, vlistRef })

    rail.updateActiveTurnIndex() // renderItems[1] 是 system 项 → 不写 activeTurnIndex

    expect(rail.activeTurnIndex.value).toBe(0)
    wrapper.unmount()
  })
})
