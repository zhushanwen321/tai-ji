/**
 * useVirtuaFollow 单测（cw wave w1 W1TC1-W1TC9 + chat-pin-bottom-fix U1 行为用例集）。
 *
 * 覆盖（对照 docs/design/chat-pin-bottom-fix.md §4.3 D7 反例重演①-⑥ + §4.4 ⑥ 用例清单）：
 * - 既有 follow 状态机（W1TC*，U1 适配后语义）：onWheel 脱离 / onScroll 恢复分支 /
 *   followIfStuck guard（rAF 内重读）/ followToBottom(force) / showJumpButton 派生
 * - U1 R3 回归：D1 末项索引直取（itemCount 注入，scrollToIndex 收到 length-1，
 *   findItemIndex 反查已删除）+ D2 endOffset 尾部高度进滚动目标
 * - U1 D7① 复合判据四回声：程序性写入回声（offset 递增）不脱离 / clamp 回声（distance≤0）
 *   走恢复分支翻 true / 用户拖拽（递减 ∧ distance>40）脱离且后续 follow 不滚屏（guard）/
 *   force 后首个 scroll 事件只建 lastOffset 快照不判定（NaN 哨兵）
 * - U1 D7② 收敛抑制窗：窗内负补偿回声不脱离 / onWheel 恒即时脱离（不受抑制窗约束）/
 *   RO 静默 120ms 关窗 / RO 持续活跃下 1500ms 硬上限关窗 / notifyRoActivity 重置静默计时
 * - U1 静默跟随变体（followIfStuck({markUnread:false})：脱离态不标 unread、贴底态正常滚）
 *   与 onSessionRebuild（置 NaN 快照 + 开抑制窗）
 * - U3 guard 语义迁移（chat-pin-bottom-fix D5 删 useMessageStreamScroll 后）：
 *   followToBottom() 默认非 force 受 guard（旧 MS6 等价）/ followToBottom(true) 完整重置面
 *   unread+浮层清零（旧 MS4/force 语义等价）；MS1-MS3/MS5/isStreaming 守卫的去留逐条
 *   依据见迁移 describe 块注释
 *
 * INVAR-M4-2′（现行语义，取代旧 INVAR-M4-2「wheel-only + onScroll 只单向翻真」）：
 * stickToBottom=false 只由用户输入信号驱动——① onWheel deltaY<0（滚轮上滑，恒即时生效，
 * 不受收敛抑制窗约束）；② onScroll 复合判据（offset 递减 ∧ 距底 > BOTTOM_THRESHOLD，
 * 收敛抑制窗内暂停翻 false）。程序性跟随一律走 followIfStuck 的 rAF 内重读 guard，不得把
 * 用户扯回底部；followToBottom(true)（用户显式点「回到底部」）是唯一例外。
 *
 * mock 策略：不 mount 真实 virtua 组件（happy-dom 下 Virtualizer 行为不可控），用
 * createMockVlist 造满足 VirtualizerHandle 接口、可断言调用的 mock 注入 vlistRef。末项索引
 * 经 opts.itemCount 注入（如 () => 5 → 断言 scrollToIndex(4, ...)），尾部高度经 opts.endOffset
 * 注入；mock 的 findItemIndex 仅用于断言「未被调用」（D1 索引直取后反查路径已删除）。
 *
 * fake timers：rAF（advanceTimersByTimeAsync(16) flush）与收敛抑制窗计时器（120ms RO 静默 /
 * 1500ms 硬上限）都依赖 vi.useFakeTimers。happy-dom ResizeObserver 派发语义不受控 → 手动
 * 派发 stub 定稿在 _virtua-mock-helper.ts 的 ManualResizeObserverStub（本文件含其契约用例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { ref, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import { useVirtuaFollow } from '@/composables/panel/useVirtuaFollow'
// createMockVlist 共享工厂（w2 提取至此）+ ManualResizeObserverStub（U1 定稿）
import { createMockVlist, ManualResizeObserverStub } from './_virtua-mock-helper'

describe('useVirtuaFollow', () => {
  let vlistRef: Ref<VirtualizerHandle | null>
  let mock: ReturnType<typeof createMockVlist>
  let onStickChange: Mock<(stuck: boolean) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createMockVlist()
    vlistRef = ref(null)
    onStickChange = vi.fn<(stuck: boolean) => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** U1 便捷装配：造 mock + 注入 vlistRef + 创建 composable（itemCount/endOffset 可选注入） */
  function setupFollow(
    followOpts: { itemCount?: () => number; endOffset?: () => number } = {},
    mockOverrides?: Parameters<typeof createMockVlist>[0],
  ) {
    mock = createMockVlist(mockOverrides)
    vlistRef.value = mock
    return useVirtuaFollow({ vlistRef, onStickChange, ...followOpts })
  }

  describe('cw wave w1 回归（W1TC1-W1TC9，U1 适配 D1/D7 语义）', () => {
    it('W1TC1 onWheel deltaY<0 翻 stickToBottom=false', () => {
      const { stickToBottom, onWheel } = setupFollow()
      // 初始贴底
      expect(stickToBottom.value).toBe(true)

      onWheel({ deltaY: -100 } as WheelEvent)

      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenCalledWith(false)
    })

    it('W1TC2 onScroll distance≤40 → 恢复分支翻 stickToBottom=true（不受抑制窗影响）', () => {
      const { stickToBottom, onScroll } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )
      stickToBottom.value = false

      // D7① NaN 快照：首个 scroll 事件只建快照不判定
      onScroll(600)
      // onScroll(480) → distance = 1000-480-500 = 20 ≤ 40 → 恢复分支翻 true
      onScroll(480)

      expect(stickToBottom.value).toBe(true)
      expect(onStickChange).toHaveBeenCalledWith(true)
    })

    it('W1TC3 onScroll 程序性写入回声（offset 递增 + distance>40）不改 stickToBottom', () => {
      const { stickToBottom, onScroll } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )
      stickToBottom.value = false

      // 首事件：NaN → 只建快照
      onScroll(100)
      // 递增回声（程序性 follow 落点方向）：distance=350>40 但 offset 未递减 → 不动
      onScroll(150)

      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).not.toHaveBeenCalled()
    })

    it('W1TC5 followIfStuck 贴底 → scrollToIndex(itemCount-1, {align:"end", offset:0})（D1 索引直取）', async () => {
      const { stickToBottom, followIfStuck } = setupFollow({ itemCount: () => 5 })
      expect(stickToBottom.value).toBe(true)

      followIfStuck()
      // 实现用 rAF schedule，flush 后才执行
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).toHaveBeenCalledTimes(1)
      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })
      // D1：findItemIndex 反查派生已删除，任何路径不得再调用
      expect(mock.findItemIndex).not.toHaveBeenCalled()
    })

    it('W1TC6 followIfStuck stickToBottom=false 不调 scrollToIndex，但置 unreadBelow=true（markUnread 缺省 true）', async () => {
      const { stickToBottom, unreadBelow, followIfStuck } = setupFollow()
      stickToBottom.value = false
      expect(unreadBelow.value).toBe(false)

      followIfStuck()
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
      // U15 即时语义：非贴底时新内容到达 → 标记 unreadBelow，让 showJumpButton 浮层
      // （= !stickToBottom && unreadBelow）出现，用户可点「回到底部」
      expect(unreadBelow.value).toBe(true)
    })

    it('W1TC7 followIfStuck rAF 内重读 stickToBottom（INVAR-M4-2′）：调用后立即上滑→rAF 不滚', async () => {
      const { stickToBottom, onWheel, followIfStuck } = setupFollow({ itemCount: () => 5 })
      // 初始贴底
      expect(stickToBottom.value).toBe(true)

      // 调 followIfStuck（schedule rAF，rAF 回调内重读 stickToBottom）
      followIfStuck()
      // rAF 尚未触发，立即 onWheel 翻 false
      onWheel({ deltaY: -100 } as WheelEvent)
      expect(stickToBottom.value).toBe(false)

      // 触发 rAF：rAF 内重读到 false → 跳过 scrollToIndex（不把上滑用户扯回）
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
    })

    it('W1TC8 followToBottom(force=true) 无视 stickToBottom 同步滚底并翻回 true（+置 NaN 开窗）', () => {
      const { stickToBottom, followToBottom } = setupFollow({ itemCount: () => 5 })
      stickToBottom.value = false

      followToBottom(true)

      // 同步执行（不走 rAF，用户点击「回到底部」即时反馈最强）
      expect(stickToBottom.value).toBe(true)
      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })
      expect(mock.findItemIndex).not.toHaveBeenCalled()
      expect(onStickChange).toHaveBeenCalledWith(true)
    })

    describe('W1TC9 showJumpButton 派生 = !stickToBottom && unreadBelow', () => {
      it('① stickToBottom=true / unreadBelow=true → false（贴底时不显示回到底部）', () => {
        const { stickToBottom, unreadBelow, showJumpButton } = setupFollow()
        stickToBottom.value = true
        unreadBelow.value = true
        expect(showJumpButton.value).toBe(false)
      })

      it('② stickToBottom=false / unreadBelow=false → false（未贴底但无未读新内容）', () => {
        const { stickToBottom, unreadBelow, showJumpButton } = setupFollow()
        stickToBottom.value = false
        unreadBelow.value = false
        expect(showJumpButton.value).toBe(false)
      })

      it('③ stickToBottom=false / unreadBelow=true → true（未贴底且有未读新内容）', () => {
        const { stickToBottom, unreadBelow, showJumpButton } = setupFollow()
        stickToBottom.value = false
        unreadBelow.value = true
        expect(showJumpButton.value).toBe(true)
      })

      it('④ 默认（stickToBottom=true / unreadBelow=false）→ false', () => {
        const { showJumpButton } = setupFollow()
        expect(showJumpButton.value).toBe(false)
      })
    })
  })

  describe('U1 R3 回归：D1 末项索引直取 + D2 endOffset', () => {
    it('R3 回归：startMargin=44 + 末项实测 24px → scrollToIndex 收到 length-1（非 findItemIndex 反查）且 offset=endOffset()', () => {
      // 反查结果 = 3：旧 bug 下 findItemIndex(scrollSize) 按绝对坐标解释（内部减 startMargin=44），
      // 高度 <44px 的末项（通知行约 24px）被反查到倒数第二项 → 错钉（设计 §3.2 F3）。
      // D1 索引直取与 startMargin/scrollSize 坐标语义彻底解耦。
      const findItemIndex = vi.fn(() => 3)
      const { followToBottom } = setupFollow(
        { itemCount: () => 5, endOffset: () => 24 },
        { scrollSize: 1000, findItemIndex },
      )

      followToBottom(true)

      // 末项索引 = itemCount-1 = 4 直取（不吃反查结果 3）；offset = endOffset() = 24
      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 24 })
      expect(findItemIndex).not.toHaveBeenCalled()
    })

    it('边界4：itemCount ≤ 0（空列表）→ 不滚，但贴底态重置照常', () => {
      const { stickToBottom, followToBottom } = setupFollow({ itemCount: () => 0 })
      stickToBottom.value = false

      followToBottom(true)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
      expect(stickToBottom.value).toBe(true)
      expect(onStickChange).toHaveBeenCalledWith(true)
    })
  })

  describe('U1 D7① onScroll 复合判据（设计反例重演四回声）', () => {
    it('程序性写入回声（offset 递增 + distance>40）→ 不脱离', () => {
      const { stickToBottom, onScroll } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )

      // 首事件建快照（初始 NaN）：distance=400>40 也不判定
      onScroll(100)
      // 程序性 follow 落点方向 offset 递增：300>100 ∧ distance=200>40 → 第一/二合取不全命中
      onScroll(300)

      expect(stickToBottom.value).toBe(true)
      expect(onStickChange).not.toHaveBeenCalled()
    })

    it('clamp 回声（offset 递减 + distance≤0）→ 不脱离且翻 true（恢复分支）', () => {
      const { stickToBottom, onScroll } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )
      stickToBottom.value = false

      // 首事件：NaN → 只建快照（distance=-100 也只建快照）
      onScroll(600)
      // clamp 回声：内容收缩后浏览器把 offset 夹到新真实底部 → 递减 550<600，
      // distance = 1000-550-500 = -50 ≤ 0 → 恢复分支（第二合取不命中脱离分支）
      onScroll(550)

      expect(stickToBottom.value).toBe(true)
      expect(onStickChange).toHaveBeenCalledWith(true)
    })

    it('用户拖拽（offset 递减 + distance>40）→ 脱离，后续 followIfStuck 不滚屏（guard）并标 unread', async () => {
      const { stickToBottom, unreadBelow, showJumpButton, onScroll, followIfStuck } =
        setupFollow({ itemCount: () => 5 })

      // 首事件建快照
      onScroll(400)
      // 滚动条拖拽 / 键盘 PageUp·Home 的 scroll 回声：递减 200<400 ∧ distance=300>40 → 脱离
      onScroll(200)
      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenCalledWith(false)

      // 脱离后 RO 兜底网再触发 followIfStuck：rAF 内重读 guard 拦截 → 不把用户扯回
      followIfStuck()
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
      // 标 unread → 「回到底部」浮层点亮
      expect(unreadBelow.value).toBe(true)
      expect(showJumpButton.value).toBe(true)
    })

    it('force 后首个 scroll 事件只建快照不判定（NaN 消费后同型序列才脱离）', async () => {
      const { stickToBottom, onWheel, onScroll, followToBottom } = setupFollow({
        itemCount: () => 5,
      })

      onWheel({ deltaY: -100 } as WheelEvent)
      // force：翻回 true + lastOffset=NaN + 开收敛抑制窗
      followToBottom(true)
      // RO 静默 120ms 关窗——隔离 NaN 语义（抑制窗另有专项用例）
      await vi.advanceTimersByTimeAsync(120)

      // force 后首个事件：只建快照（400），递减/距底条件即使满足也不判定
      onScroll(400)
      expect(stickToBottom.value).toBe(true)

      // 快照已建（400）→ 复合判据正常判定：200<400 ∧ distance=300>40 → 脱离
      onScroll(200)
      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenLastCalledWith(false)
    })

    it('边界2：scrollSize=0（空数据回声）→ 不建快照不判定（恢复分支也不触发）', () => {
      const { stickToBottom, onScroll } = setupFollow(
        {},
        { scrollSize: 0, viewportSize: 500 },
      )
      stickToBottom.value = false

      // 重建后空列表期的 scroll 回声：早返回——不消费 NaN、不判定、不触发恢复翻 true
      onScroll(0)

      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).not.toHaveBeenCalled()
    })
  })

  describe('U1 D7② force 后收敛抑制窗', () => {
    it('窗内负补偿回声（offset 递减 + distance>40）不脱离', () => {
      const { stickToBottom, onScroll, followToBottom } = setupFollow({
        itemCount: () => 5,
      })

      followToBottom(true) // 开窗 + lastOffset=NaN
      onScroll(400) // 首事件：只建快照
      // virtua $fixScrollJump 负向补偿回声：递减 200<400 ∧ distance=300>40，但窗内 → 暂停翻 false
      onScroll(200)

      expect(stickToBottom.value).toBe(true)
      expect(onStickChange).not.toHaveBeenCalledWith(false)
    })

    it('RO 静默 120ms 关窗（不调 notifyRoActivity）→ 关窗后同型回声可脱离', async () => {
      const { stickToBottom, onScroll, followToBottom } = setupFollow({
        itemCount: () => 5,
      })

      followToBottom(true)
      onScroll(400) // 快照 = 400

      await vi.advanceTimersByTimeAsync(119)
      // t=119 窗仍开：递减 300<400 ∧ distance=200>40 → 被抑制（此刻快照已存在，非 NaN 干扰）
      onScroll(300)
      expect(stickToBottom.value).toBe(true)

      await vi.advanceTimersByTimeAsync(1) // t=120 → RO 静默计时器触发 → 关窗
      onScroll(200) // 同型回声 → 脱离
      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenCalledWith(false)
    })

    it('窗内 onWheel 恒即时脱离（不受抑制窗约束）', () => {
      const { stickToBottom, onWheel, followToBottom } = setupFollow({
        itemCount: () => 5,
      })

      followToBottom(true) // 开窗
      onWheel({ deltaY: -100 } as WheelEvent)

      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenCalledWith(false)
    })

    it('RO 持续活跃下 1500ms 硬上限关窗（静默计时被反复重置也不续窗）', async () => {
      const { stickToBottom, onScroll, followToBottom, notifyRoActivity } = setupFollow({
        itemCount: () => 5,
      })

      followToBottom(true)
      onScroll(400) // 快照 = 400

      // 每 100ms 喂一次 RO 活动：静默计时恒在 t+120 重置（永不触发），窗只能由硬上限关闭
      for (let i = 0; i < 14; i++) {
        await vi.advanceTimersByTimeAsync(100)
        notifyRoActivity()
      }
      // t=1400：硬上限（t=1500）未到 → 窗仍开
      onScroll(300)
      expect(stickToBottom.value).toBe(true)

      await vi.advanceTimersByTimeAsync(100) // t=1500 → 硬上限触发 → 关窗
      onScroll(200)
      expect(stickToBottom.value).toBe(false)
      expect(onStickChange).toHaveBeenCalledWith(false)
    })

    it('窗内 notifyRoActivity 重置静默计时：115ms 喂活动 → 再 115ms 窗仍开、再 120ms 关窗', async () => {
      const { stickToBottom, onScroll, followToBottom, notifyRoActivity } = setupFollow({
        itemCount: () => 5,
      })

      followToBottom(true)
      onScroll(400) // 快照 = 400

      await vi.advanceTimersByTimeAsync(115)
      notifyRoActivity() // 静默计时重置 → 关窗点推到 t=235

      await vi.advanceTimersByTimeAsync(115) // t=230 < 235 → 窗仍开
      onScroll(300)
      expect(stickToBottom.value).toBe(true)

      await vi.advanceTimersByTimeAsync(120) // t=350 ≥ 235 → 静默关窗
      onScroll(200)
      expect(stickToBottom.value).toBe(false)
    })
  })

  describe('U1 静默跟随变体 followIfStuck({markUnread:false})', () => {
    it('脱离态：不标 unread 且不滚屏', async () => {
      const { unreadBelow, showJumpButton, onWheel, followIfStuck } = setupFollow({
        itemCount: () => 5,
      })

      onWheel({ deltaY: -100 } as WheelEvent)
      followIfStuck({ markUnread: false })
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
      expect(unreadBelow.value).toBe(false)
      expect(showJumpButton.value).toBe(false)
    })

    it('贴底态：正常滚底（itemCount-1 索引直取）', async () => {
      const { followIfStuck } = setupFollow({ itemCount: () => 5 })

      followIfStuck({ markUnread: false })
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })
    })

    it('同帧标记型 + 静默型并发 → cancel-reschedule 后标记不丢失且不滚屏', async () => {
      const { stickToBottom, unreadBelow, onWheel, followIfStuck } = setupFollow({
        itemCount: () => 5,
      })

      onWheel({ deltaY: -100 } as WheelEvent)
      followIfStuck() // 标记型（脱离态即时置 unreadBelow + pendingMarkUnread sticky 位）
      followIfStuck({ markUnread: false }) // 静默型 cancel 旧 rAF 重排——不得丢标记
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).not.toHaveBeenCalled()
      expect(unreadBelow.value).toBe(true)
      expect(stickToBottom.value).toBe(false)
    })
  })

  describe('U1 onSessionRebuild（session 重建入口）', () => {
    it('置 NaN：重建后首个 scroll 事件只建快照不判定', async () => {
      const { stickToBottom, onScroll, onSessionRebuild } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )

      onScroll(400) // 初始 NaN → 建快照
      onSessionRebuild() // lastOffset 再置 NaN + 开窗
      // 静默关窗——隔离 NaN 语义（排除抑制窗干扰）
      await vi.advanceTimersByTimeAsync(120)

      // 重建后首个事件：只建快照（300）——递减 ∧ distance=200>40 也不判定
      onScroll(300)
      expect(stickToBottom.value).toBe(true)

      // 快照已建（300）→ 判定恢复：200<300 ∧ distance=300>40 → 脱离
      onScroll(200)
      expect(stickToBottom.value).toBe(false)
    })

    it('开抑制窗：重建后窗内负补偿回声不脱离、静默关窗后同型回声可脱离', async () => {
      const { stickToBottom, onScroll, onSessionRebuild } = setupFollow(
        {},
        { scrollSize: 1000, viewportSize: 500 },
      )

      onScroll(400) // 初始快照
      onSessionRebuild() // 开窗（Virtualizer :key 重建后的估算收敛风暴罩在窗内）

      onScroll(300) // 递减 ∧ distance>40 → NaN+窗内 → 不脱离
      expect(stickToBottom.value).toBe(true)

      await vi.advanceTimersByTimeAsync(120) // RO 静默关窗
      onScroll(200) // 同型回声 → 脱离（证明 300 事件已消费重建 NaN 建好快照）
      expect(stickToBottom.value).toBe(false)
    })
  })

  describe('U3 guard 语义迁移（自 use-message-stream-scroll.test.ts，chat-pin-bottom-fix D5）', () => {
    /**
     * D5：useMessageStreamScroll 整文件删除，其测试同步删除；仍有行为价值的 guard 语义
     * 用例以 U1 新 API 等价表达迁入本文件。旧用例逐条去留（MS1-MS6，旧文件已删）：
     * - MS4（onMounted → scrollToBottom(true)）：force 原语语义由 W1TC8 + 本组
     *   「force 完整重置面」覆盖；onMounted 接线本体已内联回 MessageStream.vue（D5②），
     *   挂载首滚属接线面，挂载级测试不断言首滚（不在本测域）。
     * - MS5（messages.length → follow）：watch 本体迁 useMessageStreamFollowTriggers（U2），
     *   follow 原语的 guard 面由 W1TC5/W1TC6/W1TC7 + D7① 拖拽用例覆盖，不重复迁移。
     * - MS6（完成滚动不带 force、尊重 guard 不扯回）：→ 本组「followToBottom() 默认非 force」
     *   用例等价迁移（新 API 下非 force 路径 = followIfStuck guard）。
     * - MS1/MS2/MS3（isSessionActive 完成滚动 watch 三态）：watch 随 D5③ 删除（完成滚动改由
     *   「trace 折叠 → spacer 变化 → 静默跟随」+ clamp 回声覆盖）——API 等价表达 =
     *   静默跟随变体（贴底滚底）+ D7① clamp 回声（脱离翻 true），既有用例已覆盖，不重复迁移。
     * - isStreaming 守卫触发语义：守卫在 U2 triggers 的末条文本长度 watch（useVirtuaFollow API
     *   无 isStreaming 概念）；其 guard 面即 followIfStuck rAF 内重读（W1TC7），不重复迁移。
     */

    it('MS6 迁移：followToBottom() 默认非 force → 受 stickToBottom guard（脱离不扯回 + 标 unread）', async () => {
      const { stickToBottom, unreadBelow, showJumpButton, onWheel, followToBottom } = setupFollow({
        itemCount: () => 5,
      })

      // 贴底态默认调用：正常滚底（证明默认路径不是 no-op，与 force 共用同一滚动原语）
      followToBottom()
      await vi.advanceTimersByTimeAsync(16)
      expect(mock.scrollToIndex).toHaveBeenCalledTimes(1)
      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })

      // 脱离态默认调用：rAF 内重读 guard 拦截 → 不把上滑用户扯回，只标 unread（MS6 语义本体：
      // 非 force 的 follow 尊重 stickToBottom，视口不动、「回到底部」浮层点亮）
      onWheel({ deltaY: -100 } as WheelEvent)
      followToBottom()
      await vi.advanceTimersByTimeAsync(16)

      expect(mock.scrollToIndex).toHaveBeenCalledTimes(1) // 未新增滚动
      expect(stickToBottom.value).toBe(false)
      expect(unreadBelow.value).toBe(true)
      expect(showJumpButton.value).toBe(true)
    })

    it('MS4/force 语义迁移：followToBottom(true) 是 guard 唯一例外——脱离/未读/浮层全重置并同步滚底', async () => {
      const { stickToBottom, unreadBelow, showJumpButton, onWheel, followIfStuck, followToBottom } =
        setupFollow({ itemCount: () => 5 })

      // 用户上滑脱离 + 新内容到达标 unread → 「回到底部」浮层亮（点击前态）
      onWheel({ deltaY: -100 } as WheelEvent)
      followIfStuck()
      expect(stickToBottom.value).toBe(false)
      expect(showJumpButton.value).toBe(true)

      // 点「回到底部」：force 是唯一例外——同步滚底（不走 rAF）+ 贴底回真 + unread/浮层清零
      followToBottom(true)
      expect(stickToBottom.value).toBe(true)
      expect(unreadBelow.value).toBe(false)
      expect(showJumpButton.value).toBe(false)
      expect(mock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end', offset: 0 })

      // 既有 followIfStuck 的 pending rAF 在 force 后触发也不改变终态（force 不取消 pending，
      // 但 stick 已回真 → 重复滚底同参数无害）；终态稳定是「回到底部」闭环的不变量
      await vi.advanceTimersByTimeAsync(16)
      expect(stickToBottom.value).toBe(true)
      expect(unreadBelow.value).toBe(false)
    })
  })

  describe('ManualResizeObserverStub（happy-dom RO 手动派发 stub，_virtua-mock-helper 定稿）', () => {
    beforeEach(() => {
      ManualResizeObserverStub.install()
    })

    afterEach(() => {
      ManualResizeObserverStub.uninstall()
    })

    it('install 替换全局 / observe 登记 / dispatch 同步回调 / unobserve·disconnect 生效', () => {
      expect(globalThis.ResizeObserver).toBe(ManualResizeObserverStub)

      const el1 = document.createElement('div')
      const el2 = document.createElement('div')
      const cb = vi.fn()
      const ro = new ManualResizeObserverStub(cb)
      expect(ManualResizeObserverStub.created()).toEqual([ro])

      ro.observe(el1)
      ro.observe(el2)
      ro.dispatch() // 缺省 entries = 已 observe 的 target 列表
      expect(cb).toHaveBeenCalledTimes(1)
      const [entries, observer] = cb.mock.calls[0] as [ResizeObserverEntry[], ResizeObserver]
      expect(entries.map((e) => e.target)).toEqual([el1, el2])
      expect(observer).toBe(ro)

      cb.mockClear()
      ro.unobserve(el1)
      ro.dispatch()
      const [entriesAfterUnobserve] = cb.mock.calls[0] as [ResizeObserverEntry[]]
      expect(entriesAfterUnobserve.map((e) => e.target)).toEqual([el2])

      cb.mockClear()
      ro.disconnect()
      ro.dispatch()
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb.mock.calls[0]?.[0]).toEqual([])

      // 显式 entries 形态（U2 tailEl 快照语义需要传自造 entries）
      cb.mockClear()
      ro.observe(el1)
      ro.dispatch([{ target: el2 }])
      const [explicitEntries] = cb.mock.calls[0] as [ResizeObserverEntry[]]
      expect(explicitEntries.map((e) => e.target)).toEqual([el2])
    })
  })
})
