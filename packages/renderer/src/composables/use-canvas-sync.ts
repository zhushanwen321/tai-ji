/**
 * useCanvasSync —— 画布状态的组件消费接口与 WS 订阅编排（problem-solve-canvas §3.1(3) U5）。
 *
 * 形态对齐 useRollingRestartStatus（窗口级单例 + 模块级 refCount 订阅）：画布是跨 session
 * 共享资源（设计 D4），无 per-session 分区语义——任意组件调用即共享单条物理订阅，首个
 * 消费者注册、最后一个卸载时退订（AGENTS 关键规则 2 防重复注册）。
 *
 * 四条链路：
 * 1. 首拉：首个消费者订阅即 `canvas.list` 一次（托盘列表数据源；「renderer 启动时拉一次」
 *    的落点——订阅时点 = 首个画布消费面挂载）。
 * 2. canvas.updated 消费（onGlobalType，无 sid global 通道——rollingRestart 先例）按 evType
 *    分流（广播 = 失效提示，拉为主 ADR-0097）：
 *    - 全类型：重新 `canvas.get` 该画布（store rev 守卫收敛）+ 重拉清单（托盘徽标数据源）；
 *    - CanvasCreated 额外驱动创建后自动唤起（一次性引导），三边界判定见
 *      shouldAutoOpenCanvas（①仅创建触发 = 本分流结构性成立；②关闭标记；③其他 overlay
 *      打开不抢焦点）。不唤起时数据与清单照常刷新——托盘徽标提示即由清单承载。
 * 3. 关闭打标：overlay 开合态 watch——canvas 内容的浮层被关闭（isOpen true→false）时对
 *    该画布打用户关闭标记（边界②的写入点；换内容不打标，设计只认「主动关闭」）。
 * 4. 视图透出：返回 canvas store 实例（列表 / 分区 / 拉取与标记 action 的唯一状态源）。
 *
 * overlay 解耦（任务书声明）：本模块与 store 均不 import overlay 模块（core/domain/overlay
 * 与 renderer workflow-viz-overlay）。唤起动作与开合态读取经
 * registerCanvasOverlayBridge 注入（plan-store registerPlanReviewColdSink 注入缝先例）：
 * 生产装配点 = renderer main.ts（openCanvasTab + core 开合态快照）；测试注册 mock 桥。
 * 桥未装配 = 唤起通道缺失（fail-safe 不抢屏，数据链路不受影响）。
 *
 * 必须在组件 setup 内调用（onScopeDispose 挂订阅生命周期）。
 */
import { watch, onScopeDispose, effectScope, type EffectScope } from 'vue'
import { onGlobalType } from '@taiji/core/transport/api'
import type { ServerMessageMap } from '@taiji/shared'
import {
  shouldAutoOpenCanvas,
  useCanvasStore,
  type CanvasOverlaySnapshot,
  type CanvasStore,
} from '@/stores/canvas'

/** overlay 桥（renderer 装配点注入；store/sync 与 overlay 模块的唯一解耦缝）。 */
export interface CanvasOverlayBridge { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 唤起：打开 overlay 画布 tab（生产 = workflow-viz-overlay openCanvasTab）。 */
  openCanvas: (canvasId: string) => void
  /** 开合态快照（生产 = core getOverlayControlState 的结构化镜像；须读响应式源）。 */
  snapshot: () => CanvasOverlaySnapshot
}

// 桥单槽（注入缝，非 GUI 数据——planReviewColdSink 同款形态，无 @data-owner 义务）。
let bridge: CanvasOverlayBridge | null = null

/** 注册 overlay 桥（main 装配处一次；重复注册覆盖——后注册者持当前装配）。传 null 解绑（测试复位用）。 */
export function registerCanvasOverlayBridge(next: CanvasOverlayBridge | null): void {
  bridge = next
}

/** 订阅引用计数（useRollingRestartStatus 同款：多消费者共享单条物理订阅）。 */
let refCount = 0
/** 物理退订函数（null = 当前无订阅）。 */
let unsubscribe: (() => void) | null = null
/** 订阅容器的 detached scope（watch 生命周期归 refCount 手动管理，不随首个组件卸载）。 */
let subScope: EffectScope | null = null

/** canvas.updated 单帧分流（全类型失效重拉 + CanvasCreated 唤起判定，见文件头链路 2）。 */
function handleCanvasUpdated(store: CanvasStore, payload: ServerMessageMap['canvas.updated']): void {
  if (!payload || !payload.canvasId) return
  void store.loadCanvas(payload.canvasId)
  void store.listCanvases()
  if (payload.evType !== 'CanvasCreated') return
  if (
    !shouldAutoOpenCanvas({
      closedByUser: store.isClosedByUser(payload.canvasId),
      overlay: bridge?.snapshot() ?? null,
    })
  ) {
    return
  }
  bridge?.openCanvas(payload.canvasId)
}

/** overlay 开合态 → 打标 watch 的源 key（字符串化规避快照对象引用比较；'canvas:' 前缀 = 关闭打标的识别段）。 */
function overlaySnapshotKey(): string {
  const s = bridge?.snapshot()
  if (!s || !s.isOpen) return 'closed'
  return s.kind === 'canvas' ? `canvas:${s.canvasId ?? ''}` : `other:${s.kind}`
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return
  const store = useCanvasStore()
  subScope = effectScope(true) // detached：订阅生命周期归 refCount 手动管理
  unsubscribe =
    subScope.run(() => {
      const unsubs = [
        onGlobalType('canvas.updated', (msg) => handleCanvasUpdated(store, msg.payload)),
        // 关闭打标（链路 3）：canvas 内容的浮层被关闭 → 打标记；换内容（now 非 'closed'）
        // 不打标。快照读取器内读响应式源（生产 = core reactive 单例；测试 = ref），
        // watch 依赖随读取建立。
        watch(overlaySnapshotKey, (now, prev) => {
          if (now !== 'closed' || !prev?.startsWith('canvas:')) return
          const canvasId = prev.slice('canvas:'.length)
          if (canvasId) store.markClosedByUser(canvasId)
        }),
      ]
      return () => {
        for (const u of unsubs) u()
      }
    }) ?? null
  // 首个消费者订阅即拉一次清单（链路 1；未连接时 reject 被吞，重连后由下次失效/重挂收敛）
  void store.listCanvases()
}

function releaseSubscription(): void {
  unsubscribe?.()
  unsubscribe = null
  subScope?.stop()
  subScope = null
}

/**
 * 消费画布状态（窗口级单例订阅 + 返回 canvas store）。任意组件可调用，多实例共享
 * 单条物理订阅与同一份 store 状态。
 */
export function useCanvasSync(): CanvasStore {
  refCount++
  ensureSubscribed()
  onScopeDispose(() => {
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  return useCanvasStore()
}

/** 测试钩子：复位订阅 + 桥（模块级跨用例残留防护，对齐 _resetRollingRestartStatusForTest）。 */
export function _resetCanvasSyncForTest(): void {
  refCount = 0
  releaseSubscription()
  bridge = null
}
