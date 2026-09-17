/**
 * useStreamingPin 单测 —— streaming turn 钉扎驱动逻辑（W3 共存防护 + PR#116 review M3 修复）。
 *
 * 测的是真 bug（PR#116 review M3 指出），不是凑覆盖率：
 * - M3-1 挂载时已 streaming：watch 必须 immediate 才能保证 pinnedIndexes 在消费者副作用时机前就绪
 * - M3-2 跨 session 切换 streaming→streaming：watch 源含 sessionId 才能在派生布尔值不变时重新触发
 * - M3-3 flush:post 顺序：resetSession watch（pre flush）清状态后，本 watch（post flush）重钉生效
 *
 * [cw wave w4] 删 pinStreaming 旧路径用例：w3 切到 virtua 后钉扎统一走 pinnedIndexes，
 * 不再有 pinStreaming 回调。M3 用例改为断言 pinnedIndexes（数据源本身正确即可证明钉扎正确——
 * 消费者只读 pinnedIndexes，watch 回调内已无副作用）。
 *
 * [pin-identity U1] 编辑钉扎入参从 editingTurnIdx（裸索引快照）迁移为 editingTurnKey
 * （turnStableId 身份）：
 * W2TC4-W2TC6 系列做语义等价迁移（索引快照 → 用 turnStableId 声明身份），并新增三类用例——
 * a 身份反查命中（钉回合非位置，数组重排钉扎跟随）、b 反查 miss 不钉（fail-safe）、
 * c clamp 纵深防御（旧 bug「索引残留越界」的回归证明）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-streaming-pin.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import { turnStableId } from '@taiji/core/domain/chat'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
import type { RenderItem } from '@/composables/logic/messageTurns'

// flush:post watch 在「DOM 更新后」触发；vue-test 用 nextTick 即可推进。
// happy-dom 无 rAF 依赖，fake timers 仅保持一致。
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ── 测试数据工厂 ────────────────────────────────────────────────────

/** 构造一个 turn RenderItem，isStreaming 可控 */
function turnItem(index: number, key: string, isStreaming = false): RenderItem {
  return {
    kind: 'turn',
    turn: {
      index,
      user: { id: `user-${key}`, role: 'user', content: 'q' } as never,
      assistants: [],
      isStreaming,
      hasFoldable: false,
    },
  }
}

/** 构造一个 system RenderItem（如 bash 消息，排在 streaming turn 之后） */
function systemItem(id: string): RenderItem {
  return {
    kind: 'systemNotice',
    message: { id, role: 'system', content: 'bash' } as never,
  }
}

/**
 * turn 的稳定身份（turnStableId）：UserBubble emit turnKey 的同一口径（[pin-identity D1]
 * ——编辑事件源携带的身份即 turnStableId，与 renderKey 的 `t-` 空间同源）。
 */
function turnKeyOf(item: RenderItem): string {
  if (item.kind !== 'turn') throw new Error('turnKeyOf: 仅接受 turn 项')
  return turnStableId(item.turn)
}

/**
 * 测试用驱动器：把 items（ref 可变）+ sessionId（ref 可变）喂给 useStreamingPin，
 * 返回控制句柄 + pinnedIndexes（消费者真实读取的钉拽数据源）。
 *
 * [cw wave w4] setup 不再传 pinStreaming（旧路径已删），pinnedIndexes 是唯一钉拽数据源。
 * [pin-identity U1] editing 入参改喂 editingTurnKey（身份 ref，null = 无编辑）。
 */
function setup(opts: {
  items: RenderItem[]
  sessionId?: string
  editingTurnKey?: Ref<string | null>
}) {
  const itemsRef = ref(opts.items)
  // 用 ref（非 shallowRef）：测试通过赋值新数组替换整体（identity 变）触发响应式，
  // 模拟生产 renderItems 真 computed 重建（currentMessages 变 → renderItems 重算即新引用）。
  const sessionIdRef = ref(opts.sessionId ?? 'sess-A')
  // editingTurnKey：外部传入 ref（测试可动态改值触发 pinnedIndexes 重算）；默认不传（undefined）
  const editingTurnKeyRef = opts.editingTurnKey

  let pinnedIndexes: ReturnType<typeof useStreamingPin>['pinnedIndexes'] | undefined
  const scope = effectScope()
  scope.run(() => {
    const ret = useStreamingPin({
      items: computed(() => itemsRef.value),
      sessionId: () => sessionIdRef.value,
      editingTurnKey: editingTurnKeyRef,
    })
    pinnedIndexes = ret.pinnedIndexes
  })

  return { scope, itemsRef, sessionIdRef, editingTurnKeyRef, pinnedIndexes }
}

// ── M3-1：挂载时已 streaming → pinnedIndexes 立即含 lastTurnIdx ───────

describe('useStreamingPin · M3-1: 挂载时已 streaming（immediate）', () => {
  it('挂载时末 turn isStreaming=true → pinnedIndexes 立即含 lastTurnIdx', () => {
    // 3 个 turn，末 turn streaming；末 turn idx=2
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
      ],
    })
    // pinnedIndexes 是 computed，挂载即就绪（immediate watch 保证下游副作用时机前数据已派生）
    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('挂载时无 streaming turn → pinnedIndexes=[]（释放，不误钉）', () => {
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
      ],
    })
    expect(pinnedIndexes!.value).toEqual([])
  })

  it('挂载时末 turn streaming 且其后排 bash system item → pin 到 turn 而非 system（跳过末尾 system）', () => {
    // streaming turn 在 idx=2，bash system item 在 idx=3（共存场景）
    const { pinnedIndexes } = setup({
      items: [
        turnItem(1, 'k1', false),
        turnItem(2, 'k2', false),
        turnItem(3, 'k3', true),
        systemItem('bash-1'),
      ],
    })
    // 跳过末尾 system item，pin 到 turn idx=2
    expect(pinnedIndexes!.value).toEqual([2])
  })
})

// ── M3-2：跨 session 切换 streaming→streaming → pinnedIndexes 重新派生 ──

describe('useStreamingPin · M3-2: 跨 session 切换 streaming→streaming（追踪 sessionId）', () => {
  it('session A→B 末 turn 均 streaming → 切换后 pinnedIndexes 含新 session 的 lastTurnIdx', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', false), turnItem(2, 'k2', true)],
      sessionId: 'sess-A',
    })
    // 初始挂载：pinnedIndexes=[1]（lastTurnIdx=1）
    expect(pinnedIndexes!.value).toEqual([1])

    // 切到 session B：items 替换为新 session 的 turns，末 turn 也 streaming
    itemsRef.value = [turnItem(1, 'kB1', false), turnItem(2, 'kB2', true)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    // flush:post 在 DOM 更新后触发，再 nextTick 确保 post 回调落地
    await nextTick()

    // 关键：派生 isStreaming 布尔值未变（A→B 都是 true），但 sessionId 变 → watch 重触发 → 重钉
    expect(pinnedIndexes!.value).toEqual([1])
  })

  it('session A→B 末 turn 均 streaming 且 turn 数不同 → pin 到新 session 的 lastTurnIdx', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 新 session 有 3 个 turn，末 turn streaming → lastTurnIdx=2
    itemsRef.value = [
      turnItem(1, 'kB1', false),
      turnItem(2, 'kB2', false),
      turnItem(3, 'kB3', true),
    ]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([2])
  })
})

// ── 回归：streaming 状态变化与释放 ───────────────────────────────────

describe('useStreamingPin · 回归：streaming 变化与释放', () => {
  it('streaming true→false（同 session）→ pinnedIndexes=[]（释放）', async () => {
    const { itemsRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 末 turn streaming 结束
    itemsRef.value = [turnItem(1, 'k1', false)]
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('session 切换 streaming→非 streaming → pinnedIndexes=[]（不残留旧 pin）', async () => {
    const { itemsRef, sessionIdRef, pinnedIndexes } = setup({
      items: [turnItem(1, 'k1', true)],
      sessionId: 'sess-A',
    })
    expect(pinnedIndexes!.value).toEqual([0])

    // 切到 session B：末 turn 非 streaming
    itemsRef.value = [turnItem(1, 'kB1', false)]
    sessionIdRef.value = 'sess-B'
    await nextTick()
    await nextTick()

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('空 items（无 turn）→ pinnedIndexes=[]，不崩', () => {
    const { pinnedIndexes } = setup({ items: [] })
    expect(pinnedIndexes!.value).toEqual([])
  })
})

// ── W2TC4-W2TC6: pinnedIndexes virtua 路径（多项钉扎输出，[pin-identity U1] 迁移为 turnKey 语义） ──

describe('useStreamingPin · W2TC4-W2TC6: pinnedIndexes virtua 路径（editingTurnKey）', () => {
  it('W2TC5: streaming lastTurnIdx=5 + editingTurnKey 指向 idx=2 turn → pinnedIndexes=[5,2]', () => {
    // 6 个 turn，末 turn（idx=5）streaming；编辑身份以 turnStableId 声明（D1：与 renderKey 同身份空间）
    const items = [
      turnItem(1, 'k0', false),
      turnItem(2, 'k1', false),
      turnItem(3, 'k2', false),
      turnItem(4, 'k3', false),
      turnItem(5, 'k4', false),
      turnItem(6, 'k5', true),
    ]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([5, 2])
  })

  it('W2TC5: 非 streaming → pinnedIndexes 只含 editing 反查项=[2]', () => {
    // 末 turn 非 streaming → streamingTurnIdx=-1；只剩 editing turnKey 指向 idx=2 的 turn
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('W2TC6: streaming turn 与 editing turnKey 指向同一 turn → 去重 [2]', () => {
    // 末 turn idx=2 streaming，editingTurnKey 也指向它 → 去重后 [2]
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', true)]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('W2TC6: 无 streaming + editingTurnKey=null → pinnedIndexes=[]', () => {
    // null 是「无编辑」语义（显式 null guard，不反查——禁走 `t-${null}` 拼接巧合）
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false)]
    const editingTurnKey = ref<string | null>(null)
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('W2TC6: 不传 editingTurnKey + 非 streaming → pinnedIndexes=[]（仅 streaming 驱动）', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false)]
    const { pinnedIndexes } = setup({ items })

    expect(pinnedIndexes!.value).toEqual([])
  })

  it('W2TC6: 不传 editingTurnKey + streaming → pinnedIndexes=[lastTurnIdx]', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', true)]
    const { pinnedIndexes } = setup({ items })

    expect(pinnedIndexes!.value).toEqual([1])
  })

  it('W2TC5: editingTurnKey 动态变化 → pinnedIndexes 响应式重算且钉扎跟随身份', async () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnKey = ref<string | null>(null)
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([])

    // 身份 → key 指向 idx=1 的 turn，反查得 [1]
    editingTurnKey.value = turnKeyOf(items[1])
    await nextTick()
    expect(pinnedIndexes!.value).toEqual([1])

    // 换身份（k2→k3）：钉扎跟随身份移动到新回合（钉回合非位置——旧索引快照实现做不到）
    editingTurnKey.value = turnKeyOf(items[2])
    await nextTick()
    expect(pinnedIndexes!.value).toEqual([2])

    // 清空身份（null）→ 不反查 → []
    editingTurnKey.value = null
    await nextTick()
    expect(pinnedIndexes!.value).toEqual([])
  })
})

// ── [pin-identity U1] 三类新语义：a 身份反查命中 / b 反查 miss 不钉 / c clamp 纵深防御 ──

describe('useStreamingPin · U1-a 身份反查命中：钉的是回合本身，数组重排钉扎跟随', () => {
  it('editingTurnKey 指向中间 turn（含末尾 system item 干扰）→ pinnedIndexes 含其当前索引', () => {
    // 4 turn + 末尾 bash system item：编辑的是 idx=2 的 turn，反查命中 2 而非被 system item 干扰
    const items = [
      turnItem(1, 'k0', false),
      turnItem(2, 'k1', false),
      turnItem(3, 'k2', false),
      turnItem(4, 'k3', false),
      systemItem('bash-1'),
    ]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([2])
  })

  it('数组前插 system item 使索引整体后移 → 钉扎跟随回合移动到新索引（G3：钉回合非位置）', async () => {
    // E-now-2 回归：旧实现持位置快照，前插项后会错钉旧位置上的另一回合
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnKey = ref(turnKeyOf(items[1]))
    const { itemsRef, pinnedIndexes } = setup({ items, editingTurnKey })
    expect(pinnedIndexes!.value).toEqual([1])

    // 编辑中后台消息入流：turn 前插入 system item，被编辑回合从 idx=1 平移到 idx=2
    itemsRef.value = [systemItem('notice-1'), items[0], items[1], items[2]]
    await nextTick()
    await nextTick()

    // 身份反查自当前 items：仍钉住被编辑的那个回合（新 idx=2），不是旧位置上的 k1
    expect(pinnedIndexes!.value).toEqual([2])
  })
})

describe('useStreamingPin · U1-b 反查 miss 不钉：身份不在场则无 editing 钉扎（fail-safe）', () => {
  it('editingTurnKey 为不在场的 key → 无 editing 项；streaming 项独立存在仍钉', () => {
    // 末 turn streaming；editingTurnKey 指向不存在的回合（如旧 session 的 turn）
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', true)]
    const editingTurnKey = ref('user-ghost-not-in-items')
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    // miss（E2）不产生 editing 钉扎；streaming turn idx=1 是独立来源，不受影响
    expect(pinnedIndexes!.value).toEqual([1])
  })

  it('editingTurnKey 不在场且无 streaming → pinnedIndexes=[]（宁可不钉不崩溃）', () => {
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false)]
    const editingTurnKey = ref('user-ghost-not-in-items')
    const { pinnedIndexes } = setup({ items, editingTurnKey })

    expect(pinnedIndexes!.value).toEqual([])
  })
})

describe('useStreamingPin · U1-c clamp 纵深防御：输出索引恒有界，旧越界 bug 不复发', () => {
  it('命中后 items 缩短（被编辑回合消失）→ 不含越界索引且不抛（原崩溃路径回归）', async () => {
    // 旧实现两步断言必崩：editingTurnIdx=2 命中后切短会话，残留索引 2 越界直喂 virtua
    // （E-now-1，打包版 0.9.12 刷屏崩溃）。新实现：身份反查 miss + clamp 双保险。
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { itemsRef, pinnedIndexes } = setup({ items, editingTurnKey })
    // 先命中得 idx=2
    expect(pinnedIndexes!.value).toEqual([2])

    // 替换为更短数组（编辑中切短会话）：被编辑回合消失，key 残留
    itemsRef.value = [turnItem(1, 'kB1', false)]
    await nextTick()
    await nextTick()

    // 不含越界索引 2、不抛：反查 miss（回合不在场）→ 无 editing 项
    expect(pinnedIndexes!.value).toEqual([])
  })

  it('命中后 items 缩短且新数组有 streaming turn → 输出只含新有界索引，无旧索引残留', async () => {
    // 同族边界：反查 miss 后 streaming 钉扎仍正常，且输出数组里不存在任何 >= items.length 的索引
    const items = [turnItem(1, 'k1', false), turnItem(2, 'k2', false), turnItem(3, 'k3', false)]
    const editingTurnKey = ref(turnKeyOf(items[2]))
    const { itemsRef, pinnedIndexes } = setup({ items, editingTurnKey })
    expect(pinnedIndexes!.value).toEqual([2])

    // 换血为单 turn streaming 的新会话
    itemsRef.value = [turnItem(1, 'kB1', true)]
    await nextTick()
    await nextTick()

    const len = itemsRef.value.length
    expect(pinnedIndexes!.value).toEqual([0])
    // clamp 输出契约：每个索引均有界（virtua 对越界无防御，data[idx] undefined 即崩）
    for (const idx of pinnedIndexes!.value) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(len)
    }
  })
})
