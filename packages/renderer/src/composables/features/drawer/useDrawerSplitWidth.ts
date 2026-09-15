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
 */
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'

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
