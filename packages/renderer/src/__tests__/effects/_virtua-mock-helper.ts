/**
 * virtua mock helper（cw wave w2 / W2CO5）：createMockVlist 工厂共享文件。
 *
 * 多个 virtua 相关单测（use-virtua-follow / use-message-stream-rail-virtua）都需要构造一个
 * 满足 VirtualizerHandle 接口的 mock 对象（happy-dom 下真实 Virtualizer 行为不可控）。
 * 提取至此避免重复定义。导出 createMockVlist，签名与 w1 实现一致（向后兼容）。
 *
 * chat-pin-bottom-fix U1 追加导出 ManualResizeObserverStub（向后兼容，纯新增）：
 * happy-dom RO 手动派发 stub，供挂载级测试确定性驱动 ResizeObserver 回调。
 */
import { vi } from 'vitest'
import type { VirtualizerHandle } from 'virtua/vue'

/** 默认 mock 几何（distance = scrollSize - scrollOffset - viewportSize = 0，即默认贴底） */
const DEFAULT_SCROLL_SIZE = 1000
const DEFAULT_SCROLL_OFFSET = 500
const DEFAULT_VIEWPORT_SIZE = 500
/** findItemIndex 默认返回值（mock 5 项数据：末项 index=4，中间 index=2） */
const DEFAULT_LAST_INDEX = 4
const DEFAULT_MID_INDEX = 2

/**
 * mock 工厂（contract W1CO2）：造一个满足 VirtualizerHandle 接口的 mock 对象。
 * 默认 scrollSize/scrollOffset/viewportSize 使 distance=0（默认贴底）；其余方法为 vi.fn()，可被断言。
 */
export function createMockVlist(
  overrides?: Partial<{
    scrollSize: number
    scrollOffset: number
    viewportSize: number
    scrollToIndex: ReturnType<typeof vi.fn>
    getItemOffset: ReturnType<typeof vi.fn>
    getItemSize: ReturnType<typeof vi.fn>
    findItemIndex: ReturnType<typeof vi.fn>
  }>,
): VirtualizerHandle {
  const scrollSize = overrides?.scrollSize ?? DEFAULT_SCROLL_SIZE
  const scrollOffset = overrides?.scrollOffset ?? DEFAULT_SCROLL_OFFSET
  const viewportSize = overrides?.viewportSize ?? DEFAULT_VIEWPORT_SIZE
  return {
    scrollSize,
    scrollOffset,
    viewportSize,
    cache: {} as unknown as VirtualizerHandle['cache'],
    scrollToIndex: overrides?.scrollToIndex ?? vi.fn(),
    getItemOffset: overrides?.getItemOffset ?? vi.fn(),
    getItemSize: overrides?.getItemSize ?? vi.fn(),
    findItemIndex:
      overrides?.findItemIndex ??
      vi.fn((offset: number) => {
        // 默认：把 offset 当作末尾位置，返回一个稳定的 last index（mock 5 项数据 → last index）
        return offset >= scrollSize ? DEFAULT_LAST_INDEX : DEFAULT_MID_INDEX
      }),
    // 额外 API（VirtualizerHandle 接口要求实现）
    scrollTo: vi.fn(),
    scrollBy: vi.fn(),
  } satisfies VirtualizerHandle
}

/**
 * 手动派发 ResizeObserver stub（chat-pin-bottom-fix U1 定稿，实施计划 §6.3-1 检查点）。
 *
 * 背景（前任核实）：happy-dom 20.10.6 提供 ResizeObserver 构造器，但派发语义不受控
 * （回调时机与 entries 形态不保证）——挂载级测试需要「observe → 手动 dispatch → 同步回调」
 * 的确定性语义时用本 stub 替换全局。useVirtuaFollow 单测不直接消费 RO（收敛窗经
 * notifyRoActivity() 喂信号），本 stub 供 U2/U3 的 MessageStream 挂载级测试
 * （contentWrapEl / tailEl RO 接线）复用。
 *
 * 用法：
 *   beforeEach(() => ManualResizeObserverStub.install())
 *   afterEach(() => ManualResizeObserverStub.uninstall())
 *   const cb = vi.fn()
 *   const ro = new ManualResizeObserverStub(cb)  // install 后也可经全局 new ResizeObserver(cb)
 *   ro.observe(el)
 *   ro.dispatch()                                 // 缺省 entries = 已 observe 的 target 列表
 */
export class ManualResizeObserverStub {
  /** install 后创建的全部实例（挂载级测试可经 created() 定位组件内部创建的 observer） */
  private static createdInstances: ManualResizeObserverStub[] = []

  private callback: ResizeObserverCallback
  private observedTargets: Element[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ManualResizeObserverStub.createdInstances.push(this)
  }

  /** 用本类 stub 全局 ResizeObserver（清空实例记录；配对 uninstall 恢复） */
  static install(): void {
    vi.stubGlobal('ResizeObserver', ManualResizeObserverStub)
    ManualResizeObserverStub.createdInstances = []
  }

  /** 恢复全局 ResizeObserver（vi.unstubAllGlobals）并清空实例记录 */
  static uninstall(): void {
    vi.unstubAllGlobals()
    ManualResizeObserverStub.createdInstances = []
  }

  static created(): readonly ManualResizeObserverStub[] {
    return [...ManualResizeObserverStub.createdInstances]
  }

  observe(target: Element): void {
    if (!this.observedTargets.includes(target)) this.observedTargets.push(target)
  }

  unobserve(target: Element): void {
    this.observedTargets = this.observedTargets.filter((t) => t !== target)
  }

  disconnect(): void {
    this.observedTargets = []
  }

  /** 手动派发：同步调用回调。entries 缺省 = 已 observe 的 target 各生成一条 { target }。 */
  dispatch(entries?: Partial<ResizeObserverEntry>[]): void {
    const list = entries ?? this.observedTargets.map((target) => ({ target }))
    this.callback(list as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}
