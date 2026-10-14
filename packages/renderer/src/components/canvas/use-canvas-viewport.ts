/**
 * useCanvasViewport —— 画布视口变换（平移缩放适配）的组件消费逻辑
 * （problem-solve-canvas §3.1(3) U7；demo v3 视口段内核平移）。
 *
 * 职责：k/tx/ty 三元视口状态 + 滚轮以指针为锚缩放 + 拖拽平移（位移阈值区分单击空白）
 * + fitView 包围盒适配。数值档位 = demo 同值（缩放 [0.28, 1.6]、适配上限 0.92）。
 * 纯视图变换，无画布领域语义；bbox 由调用方（布局 computed）注入，随布局重算自动生效。
 */
import { ref, type Ref } from 'vue'

/** 缩放档位与适配参数（demo v3 同值平移，no-magic-numbers 收敛单点）。 */
const INITIAL_SCALE = 0.9
const INITIAL_PAN_X = 40
const INITIAL_PAN_Y = 24
const K_MIN = 0.28
const K_MAX = 1.6
const WHEEL_ZOOM_FACTOR = 0.0013
const FIT_PADDING = 64
const FIT_MAX_SCALE = 0.92
const FIT_MIN_PAN_Y = 16
const ZOOM_STEP = 1.2
const PAD_MULTIPLE = 2
const MIDPOINT_DIVISOR = 2
/** 拖拽判定位移阈值（低于它视为单击空白 → 取消选中）。 */
const DRAG_MOVE_THRESHOLD = 3

export interface ViewportBBox { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  x1: number
  y1: number
  x2: number
  y2: number
}

export function useCanvasViewport(boundingBox: Ref<ViewportBBox>) {
  const viewportRef = ref<HTMLElement | null>(null)
  const k = ref(INITIAL_SCALE)
  const tx = ref(INITIAL_PAN_X)
  const ty = ref(INITIAL_PAN_Y)
  const dragging = ref(false)
  let fitApplied = false
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null

  function zoomAt(mx: number, my: number, f: number): void {
    const k2 = Math.min(K_MAX, Math.max(K_MIN, k.value * f))
    tx.value = mx - ((mx - tx.value) * k2) / k.value
    ty.value = my - ((my - ty.value) * k2) / k.value
    k.value = k2
  }

  function zoomCenter(f: number): void {
    const el = viewportRef.value
    if (!el) return
    zoomAt(el.clientWidth / MIDPOINT_DIVISOR, el.clientHeight / MIDPOINT_DIVISOR, f)
  }

  function onWheel(e: WheelEvent): void {
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR))
  }

  function onDown(e: MouseEvent): void {
    if (e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value, moved: false }
    dragging.value = true
  }

  function onMove(e: MouseEvent): void {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > DRAG_MOVE_THRESHOLD) drag.moved = true
    tx.value = drag.tx + dx
    ty.value = drag.ty + dy
  }

  function onUp(): { blankClick: boolean } {
    // 空白单击（非拖拽）取消选中——判据回传调用方（目标元素归属判定在组件层）
    const blankClick = drag !== null && !drag.moved
    drag = null
    dragging.value = false
    return { blankClick }
  }

  /** 包围盒适配（demo fitView：留白、上限 0.92、下限 0.28，内容居中）。 */
  function fitView(): void {
    const el = viewportRef.value
    if (!el) return
    const b = boundingBox.value
    const bw = Math.max(1, b.x2 - b.x1)
    const bh = Math.max(1, b.y2 - b.y1)
    const fit = Math.min(
      (el.clientWidth - FIT_PADDING * PAD_MULTIPLE) / bw,
      (el.clientHeight - FIT_PADDING * PAD_MULTIPLE) / bh,
      FIT_MAX_SCALE,
    )
    k.value = Math.max(K_MIN, fit)
    tx.value = (el.clientWidth - bw * k.value) / MIDPOINT_DIVISOR - b.x1 * k.value
    ty.value = Math.max(FIT_MIN_PAN_Y, (el.clientHeight - bh * k.value) / MIDPOINT_DIVISOR - b.y1 * k.value)
    fitApplied = true
  }

  return {
    viewportRef,
    k,
    tx,
    ty,
    dragging,
    zoomCenter,
    onWheel,
    onDown,
    onMove,
    onUp,
    fitView,
    /** 首帧 fit 是否已执行（挂载时执行一次；暴露供组件挂载钩子判定）。 */
    isFitApplied: () => fitApplied,
    markFitApplied: (): void => {
      fitApplied = true
    },
    ZOOM_STEP,
  }
}
