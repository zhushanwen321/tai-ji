/**
 * useDrawerSplitWidth —— main/drawer 动态拆分宽度控制（feat-chat-flow-width）。
 *
 * 背景：PanelContainer 原用 reka-ui Splitter 布局，两点能力缺口（替换原因）：
 * ① 单 panel 时 Splitter 强制 flexGrow:1（computePanelFlexBoxStyle），无法实现
 *    「无 drawer 对话流限宽 3/4」；
 * ② SplitterPanel 挂载/卸载瞬时重算 layout，无过渡参与，无法做开合宽度动画。
 * 故 PanelContainer 换手写 flex 布局，本 composable 承载其宽度模型：
 *
 * - 无 drawer：main 卡撑满公共容器（width 100% + margin 0），卡内内容列（对话流 +
 *   composer，消费 .content-col 的 max-width: var(--content-max-w)）限宽为 panel 的
 *   CONTENT_COL_PCT%（60%）并居中——留白在卡内而非卡外（2026-10-06 用户裁决：60% 的
 *   作用对象是内容列，不是卡容器）；
 * - 内容列比例宽带绝对值下限：60% 实算低于 CONTENT_COL_MIN_PX 即改撑满（panel 被
 *   drawer 挤窄后恒撑满同因）。实测来源 = split-area 宽（ResizeObserver，与纵轴
 *   显示期 clamp 同范式）；未测得（0）时按纯比例走，观察器就绪后校正；
 * - 有 drawer：drawer 占 drawerPct%（默认 50），main 占剩侧（模板侧 calc(100% - drawerPct% - 4px)），
 *   margin 0 贴左；内容列恒撑满；
 * - 开合时双侧 width transition（margin 两态恒 0，无值可过渡）；
 * - 拖动（pointer capture 跟手，拖动期间 transition:none）/ 键盘微调调整 drawerPct，
 *   clamp [DRAWER_MIN_PCT, DRAWER_MAX_PCT]，localStorage 持久化。
 *
 * [HISTORICAL] taiji:splitter-layout 事件族已随消费方整体退役（display-containers 终态
 * 同步 2026-10-03）：唯一生产消费方 useBrowserRectSync 的监听半边已随挂载点迁浮层删除
 * （该文件 HISTORICAL 注记——浮层 fixed 定位不随抽屉移动），此后全仓零监听方，按 §7.3
 * 「不造无人读的事件」原则派发侧（notifyLayout / 开合动画 rAF 逐帧循环）一并删除，
 * 本文件只保留只读宽度模型（拖拽/键盘/持久化照旧）。
 *
 * 单实例：PanelContainer 单实例挂载，本 composable 随其 setup/卸载，无多实例注册问题。
 *
 * 同文件另载纵轴模型 useBottomDrawerHeight（display-containers §7.3 纵轴复用）：底抽屉
 * 高度（heightPct 全局单键，core bottom-drawer 域持有）+ 上沿拖拽/键盘微调 + 显示期 clamp
 * （矮窗保证主区最小可视）。纵轴从未派发 taiji:splitter-layout（§7.3：事件族已随消费方
 * 迁浮层整体退役——横轴纵轴均无消费方，不造无人读的事件）。
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
/** 小数 → 百分比换算因子（no-magic-numbers） */
const PCT_SCALE = 100

/** standalone 内容列占比（ui-signal-density D10：对话流 + composer 内容列 = panel 宽的 3/5） */
export const CONTENT_COL_PCT = 60
/** 内容列比例宽生效的绝对值下限（px）：60% 实算低于下限即改撑满——panel 被 drawer 挤窄后
 *  恒撑满同因（2026-10-06 用户裁决）。值 = 全局 --content-max-w 默认（style.css 720px，
 *  settings / landing / composer 同锚的既有内容列口径） */
export const CONTENT_COL_MIN_PX = 720

function clampDrawerPct(v: number): number {
  return Math.min(DRAWER_MAX_PCT, Math.max(DRAWER_MIN_PCT, v))
}

/** 恢复持久化的 drawer 宽度（非法/缺失回退默认 50） */
function loadDrawerPct(): number {
  const raw = localStorage.getItem(DRAWER_WIDTH_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampDrawerPct(n) : DRAWER_DEFAULT_PCT
}

/**
 * @param splitAreaEl main/drawer/handle 的共同容器（拖动换算基准 rect）
 * @param drawerOpen drawer 开合态（core drawer 域的 computed）
 */
export function useDrawerSplitWidth(splitAreaEl: Ref<HTMLElement | null>, drawerOpen: Ref<boolean>) {
  const isDragging = ref(false)
  const drawerPct = ref<number>(loadDrawerPct())

  /** main/drawer 双侧过渡类：拖动期间移除 transition 保证跟手，其余时间 width 过渡 */
  const splitTransitionClass = computed(() =>
    isDragging.value
      ? ''
      : 'transition-[width] duration-[var(--duration-slow)] ease-[var(--ease)]',
  )

  /** split-area 实测宽度（px）：内容列 60%↔撑满 的派生输入。未测得（0，观察器就绪前/
   *  jsdom 无回调）时按纯比例走，ResizeObserver 首次回调后校正——范式同纵轴
   *  useBottomDrawerHeight 的显示期 clamp（实测驱动派生，非时间推测） */
  const splitAreaWidthPx = ref(0)

  function measureSplitArea(): void {
    const el = splitAreaEl.value
    if (el) splitAreaWidthPx.value = el.getBoundingClientRect().width
  }

  let splitAreaObserver: ResizeObserver | null = null
  watch(
    splitAreaEl,
    (el) => {
      splitAreaObserver?.disconnect()
      splitAreaObserver = null
      if (!el) return
      measureSplitArea()
      splitAreaObserver = new ResizeObserver(measureSplitArea)
      splitAreaObserver.observe(el)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    splitAreaObserver?.disconnect()
    splitAreaObserver = null
  })

  /** 内容列宽度令牌（--content-max-w 派生单处）：split 态恒撑满（panel 被挤窄后不再按
   *  比例收，D10 下限语义）；standalone = 60%，实测 60% 值低于绝对下限时改撑满 */
  const contentColMaxW = computed<string>(() => {
    if (drawerOpen.value) return '100%'
    const w = splitAreaWidthPx.value
    if (w > 0 && (w * CONTENT_COL_PCT) / PCT_SCALE < CONTENT_COL_MIN_PX) return '100%'
    return `${CONTENT_COL_PCT}%`
  })

  /**
   * main-area 动态样式（宽度模型 SSOT，模板直连）：
   * - standalone：width 100% 撑满公共容器 + margin 0；--content-max-w 派生内容列宽
   *   （60% 或下限触发后的 100%），对话流/composer 内容列经 .content-col 消费居中；
   * - split：width calc(100% - drawerPct% - 4px) + margin 0 贴左（4px = 卡缝宽 a，
   *   与窗口边距 p-1 同值；handle 即缝本体；drawer 卡占 drawerPct%）。
   */
  const mainAreaStyle = computed<Record<string, string>>(() => ({
    '--content-max-w': contentColMaxW.value,
    width: drawerOpen.value ? `calc(100% - ${drawerPct.value}% - 4px)` : '100%',
    marginLeft: '0',
    marginRight: '0',
  }))

  function persistDrawerPct(): void {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerPct.value))
  }

  /**
   * handle 拖动（pointer capture：move/up 事件路由到 handle，拖出元素外仍跟手）。
   * pointerdown 不 preventDefault：保留后续 focus 行为（键盘可达性），选中防御靠 select-none。
   * jsdom 兼容：setPointerCapture/hasPointerCapture 可选调用（测试环境无 Pointer Capture API）。
   */
  function onHandlePointerDown(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    isDragging.value = true
  }

  /** 拖动中：drawer 宽 = 容器右缘到指针的水平占比（handle 在 drawer 左缘，缝宽误差可忽略） */
  function onHandlePointerMove(e: PointerEvent): void {
    const el = splitAreaEl.value
    if (!el || !isDragging.value) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) return
    drawerPct.value = clampDrawerPct(((rect.right - e.clientX) / rect.width) * PCT_SCALE)
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
