/**
 * useFindInSurface —— 表面内查找的单例 composable（find-in-surface 第一期）。
 *
 * **模块级单例，不走 per-session Map 分区**（与 ADR-0049 范式的刻意偏离，设计留档 §3）：
 * 搜索状态跟表面实例走而不跟 session 走——表面关闭/切换时由调用方 close() 清空，
 * 状态生命周期 = 表面挂载期，无需 session 维度分区。
 *
 * 表面归属（Ctrl+F 触发时刻判定，用户裁决「鼠标悬停优先」）：
 * ① 指针坐标 elementFromPoint 命中 [data-find-surface] → 开该表面；
 * ② 未命中 → 回退固定栈序 overlay > bottom-drawer > right-drawer（与 key-orchestrator
 *    stack-order 同一层级序），取第一个当前渲染在文档中的；
 * ③ 全无 → 不动作。栈序回退而非不动作的原因：指针常悬在对话流（第二期范围）或缝上，
 *    此时用户意图明确是「搜最上层开着的东西」。
 *
 * 搜索即时执行无防抖（时间平抑红线）：输入即搜，查找框打开期间 query 是唯一事实源，
 * 高亮是搜索结果的纯投影，无任何时间窗补偿。
 */
import { ref } from 'vue'
import { locateInDom } from './dom-locator'
import { clearHits, paintHits } from './highlight-painter'

// 模块级瞬态搜索状态（登记 docs/architecture/data-source-registry.md #59：表面内查找
// 瞬态搜索状态——单例声明刻意不走 per-session 分区，生命周期 = 表面挂载期）
// @data-owner #59
const query = ref('')
// @data-owner #59
const hitCount = ref(0)
// @data-owner #59
const activeIndex = ref(-1)
// @data-owner #59
const isOpen = ref(false)
// @data-owner #59
const surfaceKind = ref('')
/** Ctrl+F 触发计数：FindBar watch 它聚焦输入框——同 kind 重复 Ctrl+F（find 已开着）时
 *  isOpen/surfaceKind 都不变，watch 不触发，靠该计数把「重新聚焦输入框」的意图送达
 *  @data-owner #59 */
const focusTick = ref(0)

/** 最近一次 search() 的快照（paintHits 是一次性绘制，导航时按此重画；DOM 变化后
 *  失效 range 由 painter 的 isConnected 防御跳过）
 *  @data-owner #59 */
let currentRanges: Range[] = []

/** 回退栈序（与 key-orchestrator stack-order 层级序同源：浮层 → 底抽屉 → 右抽屉） */
const FALLBACK_SURFACE_ORDER = ['overlay', 'bottom-drawer', 'right-drawer'] as const

// ── 指针坐标跟踪（悬停归属判定的数据源）────────────────────────────────────
// 模块级两变量 + 一个常驻 listener：pointermove 只写坐标零分配；监听随模块加载装一次，
// 不随组件生命周期装卸（卸了再装会丢窗口边缘场景的最后坐标，而成本只是一个空转 handler）。
let lastPointerX = -1
let lastPointerY = -1
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e: PointerEvent) => {
    lastPointerX = e.clientX
    lastPointerY = e.clientY
  })
}

/** 指针悬停点所属表面 kind；指针无坐标（从未移动过）或不在任何可搜表面内 → null */
function surfaceKindAtPointer(): string | null {
  if (lastPointerX < 0 || lastPointerY < 0) return null
  const el = document.elementFromPoint(lastPointerX, lastPointerY)
  return el?.closest('[data-find-surface]')?.getAttribute('data-find-surface') ?? null
}

export function useFindInSurface() {
  /** 打开查找框（聚焦输入由 FindBar 组件 watch isOpen 自己做）。同 kind 重复 Ctrl+F 保留现场。 */
  function open(kind: string): void {
    if (isOpen.value && surfaceKind.value === kind) return
    // 换表面 = 换搜索根，旧 query 的命中不再适用，现场清空重开
    isOpen.value = true
    surfaceKind.value = kind
    query.value = ''
    hitCount.value = 0
    activeIndex.value = -1
    currentRanges = []
    clearHits()
  }

  /** 关闭并清空（query/命中/高亮全清——搜索状态不持久化，关表面即清）。幂等。 */
  function close(): void {
    if (!isOpen.value && query.value === '' && surfaceKind.value === '') return
    isOpen.value = false
    query.value = ''
    hitCount.value = 0
    activeIndex.value = -1
    surfaceKind.value = ''
    currentRanges = []
    clearHits()
  }

  /**
   * 执行搜索：按当前 surfaceKind 惰性查 DOM 根（第一期不缓存根元素——表面随 v-if 挂卸，
   * 缓存反而要管失效）跑定位器 + 绘制。根元素不在文档（表面已关）→ 清结果不报错。
   */
  function search(): void {
    currentRanges = []
    hitCount.value = 0
    activeIndex.value = -1
    const kind = surfaceKind.value
    if (!kind || !isOpen.value) return
    const root = document.querySelector<HTMLElement>(`[data-find-surface="${kind}"]`)
    if (!root) {
      clearHits()
      return
    }
    currentRanges = locateInDom(root, query.value)
    hitCount.value = currentRanges.length
    if (currentRanges.length > 0) activeIndex.value = 0
    paintHits(currentRanges, activeIndex.value)
    scrollToActive()
  }

  /** 导航共用：翻 activeIndex → 重画快照 → 滚到可见。命中数 0 时 no-op。 */
  function step(delta: number): void {
    if (hitCount.value === 0) return
    activeIndex.value = (activeIndex.value + delta + hitCount.value) % hitCount.value
    paintHits(currentRanges, activeIndex.value)
    scrollToActive()
  }

  function next(): void {
    step(1)
  }

  function prev(): void {
    step(-1)
  }

  /**
   * Ctrl+F 入口（orchestrator 调用）：悬停归属优先，未命中走回退栈序，全无不动作。
   * 归属判定读的是真实 DOM（elementFromPoint + 属性查询），无中间状态可漂移。
   */
  function openFindAtPointer(): void {
    const hovered = surfaceKindAtPointer()
    if (hovered) {
      open(hovered)
    } else {
      for (const kind of FALLBACK_SURFACE_ORDER) {
        if (document.querySelector(`[data-find-surface="${kind}"]`)) {
          open(kind)
          break
        }
      }
    }
    // 无可搜表面开着 → 不动作（focusTick 不增——FindBar 不存在，增了也无人消费）
    if (isOpen.value) focusTick.value += 1
  }

  return {
    query,
    hitCount,
    activeIndex,
    isOpen,
    surfaceKind,
    focusTick,
    open,
    close,
    search,
    next,
    prev,
    openFindAtPointer,
  }
}

/**
 * 活动命中滚入视野：Highlight API 只着色不滚动，导航不滚等于不可用（这是「导航」
 * 语义的一部分，非额外功能）。block:'nearest' 最小滚动，不打断用户浏览位置。
 * 滚动目标取命中文本的父元素——Range 自身无 scrollIntoView，且父元素通常即命中
 * 所在的行/块，nearest 滚动幅度与滚动 range 矩形等价。
 */
function scrollToActive(): void {
  const range = currentRanges[activeIndex.value]
  if (!range || !range.startContainer.isConnected) return
  const el = range.startContainer.parentElement
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest' })
  }
}
