/**
 * useDrawerSplitWidth —— main/drawer 动态拆分宽度控制（feat-chat-flow-width）。
 *
 * 背景：PanelContainer 原用 reka-ui Splitter 布局，两点能力缺口（替换原因）：
 * ① 单 panel 时 Splitter 强制 flexGrow:1（computePanelFlexBoxStyle），无法实现
 *    「无 drawer 对话流限宽 3/4」；
 * ② SplitterPanel 挂载/卸载瞬时重算 layout，无过渡参与，无法做开合宽度动画。
 * 故 PanelContainer 换手写 flex 布局，本 composable 承载其宽度模型：
 *
 * - 无 drawer：main 占 MAIN_STANDALONE_PCT% 且左右 margin calc 居中（两侧各 (100%-75%)/2 留白，
 *   对话流整体在工作区视觉居中），main 层 --content-max-w:100% 解除 720px 封顶（内容占满 75%）；
 * - 有 drawer：drawer 占 drawerPct%（默认 50），main 占剩侧（模板侧 calc(100% - drawerPct% - 1px)），
 *   margin 0 贴左；--content-max-w 恒 100% 不随开合切换（内容 min(容器,容器)=容器，
 *   width/margin 全程可插值，开合动画无跳变）；
 * - 开合时双侧 width + margin transition（--duration-slow，与 DrawerPanel aside 淡入同时长）；
 * - 拖动（pointer capture 跟手，拖动期间 transition:none）/ 键盘微调调整 drawerPct，
 *   clamp [DRAWER_MIN_PCT, DRAWER_MAX_PCT]，localStorage 持久化；
 * - BrowserPane rect 同步：拖动/键盘直发 + 开合动画期间 rAF 循环逐帧派发
 *   taiji:splitter-layout（原 Splitter @layout 的替代路径；BrowserPane 侧 33ms 节流）。
 *
 * 单实例：PanelContainer 单实例挂载，本 composable 随其 setup/卸载（rAF 循环经
 * onScopeDispose 清理），无多实例注册问题。
 *
 * 同文件另载纵轴模型 useBottomDrawerHeight（display-containers §7.3 纵轴复用）：底抽屉
 * 高度（heightPct 全局单键，core bottom-drawer 域持有）+ 上沿拖拽/键盘微调 + 显示期 clamp
 * （矮窗保证主区最小可视）。纵轴不派发 taiji:splitter-layout（§7.3：唯一消费方已随
 * BrowserPane 迁浮层，纵轴派发无消费方——不造无人读的事件）。
 */
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  getBottomDrawerHeightPct,
  resolveBottomDrawerDisplayPct,
  setBottomDrawerHeightPct,
  useBottomDrawerLayout,
} from '@taiji/core/domain/bottom-drawer'

/** drawer 宽度持久化 key（与 reka-ui autoSaveId 旧数据格式不兼容，换 key 避免读到旧 layout 数组） */
const DRAWER_WIDTH_KEY = 'taiji:drawer-width'
/** drawer 宽度百分比约束（对齐原 SplitterPanel min-size=20 / max-size=60） */
const DRAWER_MIN_PCT = 20
const DRAWER_MAX_PCT = 60
const DRAWER_DEFAULT_PCT = 50
/** 键盘微调步长（%，ArrowLeft 变窄 / ArrowRight 变宽），对齐原 Splitter 键盘交互 */
const KEYBOARD_STEP_PCT = 2
/** 开合动画期间 rAF 逐帧派发的覆盖时长（--duration-slow 320ms + 缓冲） */
const ANIM_NOTIFY_MS = 400
/** 小数 → 百分比换算因子（no-magic-numbers） */
const PCT_SCALE = 100
/** standalone 留白分摊两侧（左右各半，no-magic-numbers） */
const MARGIN_SIDES = 2

/** 无 drawer 时 main 区域占比（用户预期：无 drawer 3/4，有 drawer 动画到 1/2） */
export const MAIN_STANDALONE_PCT = 75

function clampDrawerPct(v: number): number {
  return Math.min(DRAWER_MAX_PCT, Math.max(DRAWER_MIN_PCT, v))
}

/** standalone 时 main 居中的两侧 margin（(100% - 75%) / 2 = 12.5%；显式值而非 margin:auto——
 *  auto 不可插值，开合动画会横跳。物理属性 margin-left/right 而非 margin-inline：水平 LTR 下
 *  等效，且 transition-[width,margin] 简写自然覆盖（logical 属性不受 margin 简写过渡影响）；
 *  用纯百分比而非 calc()：jsdom cssstyle 对 margin 的 calc 值校验不过（width 则可），测试可断言） */
export const MAIN_STANDALONE_MARGIN = `${(PCT_SCALE - MAIN_STANDALONE_PCT) / MARGIN_SIDES}%`

/** 恢复持久化的 drawer 宽度（非法/缺失回退默认 50） */
function loadDrawerPct(): number {
  const raw = localStorage.getItem(DRAWER_WIDTH_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampDrawerPct(n) : DRAWER_DEFAULT_PCT
}

/** 通知 BrowserPane 重算 viewport rect（BrowserPane 侧有 33ms 节流，高频派发无性能问题） */
function notifyLayout(): void {
  window.dispatchEvent(new CustomEvent('taiji:splitter-layout'))
}

/**
 * @param splitAreaEl main/drawer/handle 的共同容器（拖动换算基准 rect）
 * @param drawerOpen drawer 开合态（core drawer 域的 computed）
 */
export function useDrawerSplitWidth(splitAreaEl: Ref<HTMLElement | null>, drawerOpen: Ref<boolean>) {
  const isDragging = ref(false)
  const drawerPct = ref<number>(loadDrawerPct())

  /** main/drawer 双侧过渡类：拖动期间移除 transition 保证跟手，其余时间 width + margin 过渡 */
  const splitTransitionClass = computed(() =>
    isDragging.value
      ? ''
      : 'transition-[width,margin] duration-[var(--duration-slow)] ease-[var(--ease)]',
  )

  /**
   * main-area 动态样式（宽度模型 SSOT，模板直连）：
   * - standalone：width 75% + 左右 margin calc 居中 + --content-max-w:100%（解除全局 720px
   *   封顶，对话流/composer 内容列占满 75% 区域）；
   * - split：width calc(100% - drawerPct% - 1px) + margin 0 贴左（drawer 贴右）。
   * --content-max-w 两态恒 100% 不切换：值不变 → 无过渡跳变，内容 width:100% 永远跟随容器，
   * 开合动画期间 min(容器,容器)=容器 全程连续。
   */
  const mainAreaStyle = computed<Record<string, string>>(() => ({
    '--content-max-w': '100%',
    ...(drawerOpen.value
      ? { width: `calc(100% - ${drawerPct.value}% - 1px)`, marginLeft: '0', marginRight: '0' }
      : { width: `${MAIN_STANDALONE_PCT}%`, marginLeft: MAIN_STANDALONE_MARGIN, marginRight: MAIN_STANDALONE_MARGIN }),
  }))

  function persistDrawerPct(): void {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerPct.value))
  }

  /**
   * 开合动画期间逐帧派发 layout 事件（BrowserPane 的 WebContentsView setBounds 需要跟随
   * width 过渡逐帧同步）。rAF 循环覆盖 ANIM_NOTIFY_MS 后自停；reduced-motion 下 transition
   * 瞬时完成，多派发的事件被 BrowserPane 节流吸收，无害。
   */
  let layoutNotifyRafId: number | null = null
  watch(drawerOpen, () => {
    if (layoutNotifyRafId !== null) cancelAnimationFrame(layoutNotifyRafId)
    const start = performance.now()
    const tick = () => {
      notifyLayout()
      if (performance.now() - start < ANIM_NOTIFY_MS) {
        layoutNotifyRafId = requestAnimationFrame(tick)
      } else {
        layoutNotifyRafId = null
      }
    }
    layoutNotifyRafId = requestAnimationFrame(tick)
  })
  onScopeDispose(() => {
    if (layoutNotifyRafId !== null) cancelAnimationFrame(layoutNotifyRafId)
  })

  /**
   * handle 拖动（pointer capture：move/up 事件路由到 handle，拖出元素外仍跟手）。
   * pointerdown 不 preventDefault：保留后续 focus 行为（键盘可达性），选中防御靠 select-none。
   * jsdom 兼容：setPointerCapture/hasPointerCapture 可选调用（测试环境无 Pointer Capture API）。
   */
  function onHandlePointerDown(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    isDragging.value = true
    notifyLayout()
  }

  /** 拖动中：drawer 宽 = 容器右缘到指针的水平占比（handle 在 drawer 左缘，1px 误差可忽略） */
  function onHandlePointerMove(e: PointerEvent): void {
    const el = splitAreaEl.value
    if (!el || !isDragging.value) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) return
    drawerPct.value = clampDrawerPct(((rect.right - e.clientX) / rect.width) * PCT_SCALE)
    notifyLayout()
  }

  /** 拖动结束（pointerup/cancel）：释放 capture + 持久化宽度 */
  function onHandlePointerUp(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId)
    if (!isDragging.value) return
    isDragging.value = false
    persistDrawerPct()
  }

  /** 键盘微调（separator 可达性，对齐原 Splitter 键盘交互） */
  function onHandleKeydown(e: KeyboardEvent): void {
    let delta = 0
    if (e.key === 'ArrowLeft') delta = -KEYBOARD_STEP_PCT
    else if (e.key === 'ArrowRight') delta = KEYBOARD_STEP_PCT
    else return
    e.preventDefault()
    drawerPct.value = clampDrawerPct(drawerPct.value + delta)
    notifyLayout()
    persistDrawerPct()
  }

  return {
    drawerPct,
    isDragging,
    splitTransitionClass,
    mainAreaStyle,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onHandleKeydown,
  }
}

// ── 纵轴（display-containers §7.3：底抽屉高度，与横轴共用拖拽/键盘/持久化范式）──

/** 显示期 clamp 的主区（对话流 + composer）最小可视高度（px，§5.3「窗口太矮」失败路径。
 *  具体阈值是设计 §11-1 实施期真机校准项） */
export const MIN_MAIN_AREA_HEIGHT_PX = 240

/**
 * 底抽屉高度模型（纵轴）：
 * - 高度百分比（heightPct）归 core bottom-drawer 域：拖拽写侧 clamp 15%–70% + 全局单键
 *   持久化（setBottomDrawerHeightPct 收编），本层只做拖拽数学与显示换算；
 * - 显示期 clamp：resolveBottomDrawerDisplayPct（矮窗下保证主区 ≥ MIN_MAIN_AREA_HEIGHT_PX，
 *   **纯读侧不写回**——恢复窗口高度后回到拖拽持久值，S2 断言）；
 * - 显示高度 = pool（split 行 + 底抽屉共享容器）的百分比（CSS height 百分比直接对 pool
 *   求值，无需换算 px）。
 *
 * @param poolEl split 行与底抽屉的共同容器（clamp 换算基准 + 拖拽数学基准）
 * @param bottomOpen 底抽屉开合态（core bottom-drawer 域的 computed）
 */
export function useBottomDrawerHeight(
  poolEl: Ref<HTMLElement | null>,
  bottomOpen: Ref<boolean>,
) {
  const isBottomDragging = ref(false)
  const { heightPct } = useBottomDrawerLayout()
  /** pool 实测高度（px，仅显示期 clamp 输入；未测得 0 时 clamp 不生效、回落目标值） */
  const poolHeightPx = ref(0)

  function measure(): void {
    const el = poolEl.value
    if (el) poolHeightPx.value = el.getBoundingClientRect().height
  }

  let resizeObserver: ResizeObserver | null = null
  watch(
    poolEl,
    (el) => {
      resizeObserver?.disconnect()
      resizeObserver = null
      if (!el) return
      measure()
      resizeObserver = new ResizeObserver(measure)
      resizeObserver.observe(el)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  /** 有效显示百分比（写侧 clamp 后的高度值 × 显示期钳制；关闭态 0） */
  const bottomHeightStyle = computed(() => {
    const pct = resolveBottomDrawerDisplayPct(
      heightPct.value,
      poolHeightPx.value,
      MIN_MAIN_AREA_HEIGHT_PX,
    )
    return `${bottomOpen.value ? pct : 0}%`
  })

  /** 高度过渡（沿用现有 transition 体系加纵轴）：拖动期间移除过渡保证跟手 */
  const bottomTransitionClass = computed(() =>
    isBottomDragging.value
      ? ''
      : 'transition-[height] duration-[var(--duration-slow)] ease-[var(--ease)]',
  )

  /** 上沿手柄拖动（pointer capture：同横轴，拖出元素外仍跟手；jsdom 兼容可选调用） */
  function onBottomHandlePointerDown(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    isBottomDragging.value = true
  }

  /** 拖动中：底抽屉高 = 容器下缘到指针的垂直占比（手柄在抽屉上缘） */
  function onBottomHandlePointerMove(e: PointerEvent): void {
    const el = poolEl.value
    if (!el || !isBottomDragging.value) return
    const rect = el.getBoundingClientRect()
    if (rect.height === 0) return
    setBottomDrawerHeightPct(((rect.bottom - e.clientY) / rect.height) * PCT_SCALE)
  }

  /** 拖动结束（pointerup/cancel）：释放 capture（高度持久化由 setBottomDrawerHeightPct 写穿） */
  function onBottomHandlePointerUp(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId)
    isBottomDragging.value = false
  }

  /** 键盘微调（separator 可达性，对齐横轴 ArrowLeft/Right 交互；ArrowUp 变高） */
  function onBottomHandleKeydown(e: KeyboardEvent): void {
    let delta = 0
    if (e.key === 'ArrowUp') delta = KEYBOARD_STEP_PCT
    else if (e.key === 'ArrowDown') delta = -KEYBOARD_STEP_PCT
    else return
    e.preventDefault()
    setBottomDrawerHeightPct(getBottomDrawerHeightPct() + delta)
  }

  return {
    bottomHeightStyle,
    isBottomDragging,
    bottomTransitionClass,
    onBottomHandlePointerDown,
    onBottomHandlePointerMove,
    onBottomHandlePointerUp,
    onBottomHandleKeydown,
  }
}
