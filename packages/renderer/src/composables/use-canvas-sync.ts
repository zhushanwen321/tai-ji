/**
 * useCanvasSync —— 画布状态的组件消费接口与 WS 订阅编排（problem-solve-canvas §3.1(3) U5；
 * session-store-layout-inversion D4 会话隔离化：per-session 分流 + 归属会话唤起判定）。
 *
 * 订阅形态：`canvas.updated` 是全局失效提示广播（payload 带归属 sessionId——D4），物理
 * 订阅收敛为**模块级单条**（AGENTS 规则 2 防重复注册；多实例共享），handler 内按
 * payload.sessionId 分流：失效重拉走 refreshCanvasFor(目标 sid)（updateFor 写「消息所属
 * 会话」分区，M1 竞态结构性消除），唤起判定只对「广播归属会话 = 本实例会话」的实例生效
 * （D4 裁决：只唤起归属会话前台——A 会话建画布不再抢 B 会话的屏）。
 *
 * 四条链路：
 * 1. 首拉：首个消费者订阅即 `canvas.list` 一次（本实例会话的清单；「renderer 启动时拉
 *    一次」的落点——订阅时点 = 首个画布消费面挂载）。
 * 2. canvas.updated 消费（onGlobalType 全局单条）按 evType / 会话分流（广播 = 失效提示，
 *    拉为主 ADR-0097）：
 *    - 全类型：refreshCanvasFor(payload.sessionId, canvasId) 重拉该会话画布与清单；
 *    - CanvasCreated 且 payload.sessionId = 本实例会话：驱动创建后自动唤起（一次性引导），
 *      边界判定见 shouldAutoOpenCanvas（①仅创建+归属会话触发 = 本分流结构性成立；
 *      ②关闭标记；③其他 overlay 打开不抢焦点）。不唤起时数据与清单照常刷新——托盘
 *      徽标提示即由清单承载。
 * 3. 关闭打标：overlay 开合态 watch——canvas 内容的浮层被关闭（isOpen true→false）时对
 *    该画布打用户关闭标记（markCanvasClosedByUser 落 overlay 归属会话分区；边界②的
 *    写入点；换内容不打标，设计只认「主动关闭」）。
 * 4. 视图透出：返回本实例会话的 canvas store 视图（stores/canvas.ts useCanvasStore）。
 *
 * overlay 解耦（任务书声明）：本模块与 store 均不 import overlay 模块（core/domain/overlay
 * 与 renderer workflow-viz-overlay）。唤起动作与开合态读取经
 * registerCanvasOverlayBridge 注入（plan-store registerPlanReviewColdSink 注入缝先例）：
 * 生产装配点 = renderer main.ts（openCanvasTab + core 开合态快照）；测试注册 mock 桥。
 * 桥未装配 = 唤起通道缺失（fail-safe 不抢屏，数据链路不受影响）。
 *
 * 必须在组件 setup 内调用（onScopeDispose 挂订阅生命周期）。
 */
import { watch, onScopeDispose, effectScope, type EffectScope, type Ref } from 'vue'
import { onGlobalType } from '@taiji/core/transport/api'
import type { ServerMessageMap } from '@taiji/shared'
import {
  isCanvasClosedByUser,
  markCanvasClosedByUser,
  refreshCanvasFor,
  shouldAutoOpenCanvas,
  useCanvasStore,
  type CanvasOverlaySnapshot,
  type CanvasStore,
} from '@/stores/canvas'

/** overlay 桥（renderer 装配点注入；store/sync 与 overlay 模块的唯一解耦缝）。 */
export interface CanvasOverlayBridge { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 唤起：打开 overlay 画布 tab（生产 = workflow-viz-overlay openCanvasTab）。 */
  openCanvas: (canvasId: string, sessionId: string) => void
  /** 开合态快照（生产 = core getOverlayControlState 的结构化镜像；须读响应式源）。 */
  snapshot: () => CanvasOverlaySnapshot
}

// 桥单槽（注入缝，非 GUI 数据——planReviewColdSink 同款形态，无 @data-owner 义务）。
let bridge: CanvasOverlayBridge | null = null

/** 注册 overlay 桥（main 装配处一次；重复注册覆盖——后注册者持当前装配）。传 null 解绑（测试复位用）。 */
export function registerCanvasOverlayBridge(next: CanvasOverlayBridge | null): void {
  bridge = next
}

type CanvasUpdatedListener = (instanceSid: string, payload: ServerMessageMap['canvas.updated']) => void

/** 各实例注册的唤起判定 listener（物理 handler 分发时遍历；各实例自行判定会话匹配）。
 * @data-owner #64 —— #64 画布广播的 renderer 唤起判定分发槽（控制面：实例注册表，
 * 非数据源；失效重拉写分区归 stores/canvas.ts 的 @data-owner #64 分区表）。 */
const updatedListeners = new Set<CanvasUpdatedListener>()

/** 订阅引用计数（多消费者共享单条物理订阅）。 */
let refCount = 0
/** 物理退订函数（null = 当前无订阅）。 */
let unsubscribe: (() => void) | null = null
/** 订阅容器的 detached scope（watch 生命周期归 refCount 手动管理，不随首个组件卸载）。 */
let subScope: EffectScope | null = null

/** overlay 开合态 → 打标 watch 的源 key（字符串化规避快照对象引用比较；'canvas:' 前缀 = 关闭打标的识别段）。 */
function overlaySnapshotKey(): string {
  const s = bridge?.snapshot()
  if (!s || !s.isOpen) return 'closed'
  return s.kind === 'canvas' ? `canvas:${s.canvasId ?? ''}:${s.sessionId ?? ''}` : `other:${s.kind}`
}

/**
 * canvas.updated 单帧分流（失效重拉 + 归属会话唤起判定，见文件头链路 2）。
 * 失效重拉全局一轮（写「消息所属会话」分区——幂等 RPC，多实例不放大）；唤起判定
 * 逐实例（广播归属会话 = 实例会话才进入三边界判定——D4：只唤起归属会话前台）。
 */
function handleCanvasUpdated(payload: ServerMessageMap['canvas.updated']): void {
  if (!payload || !payload.canvasId || !payload.sessionId) return
  refreshCanvasFor(payload.sessionId, payload.canvasId)
  if (payload.evType !== 'CanvasCreated') return
  for (const listener of updatedListeners) {
    listener(payload.sessionId, payload)
  }
}

/** 实例唤起判定（会话匹配 + 三边界；判定输入 = overlay 归属会话分区的关闭标记）。 */
function autoOpenListener(instanceSid: string, payload: ServerMessageMap['canvas.updated']): void {
  if (
    !shouldAutoOpenCanvas({
      closedByUser: isCanvasClosedByUser(payload.sessionId, payload.canvasId),
      overlay: bridge?.snapshot() ?? null,
    })
  ) {
    return
  }
  bridge?.openCanvas(payload.canvasId, instanceSid)
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return
  subScope = effectScope(true) // detached：订阅生命周期归 refCount 手动管理
  unsubscribe =
    subScope.run(() => {
      const unsubs = [
        onGlobalType('canvas.updated', (msg) => handleCanvasUpdated(msg.payload)),
        // 关闭打标（链路 3）：canvas 内容的浮层被关闭 → 打标记（落 overlay 归属会话分区）；
        // 换内容（now 非 'closed'）不打标。快照读取器内读响应式源（生产 = core reactive
        // 单例；测试 = ref），watch 依赖随读取建立。
        watch(overlaySnapshotKey, (now, prev) => {
          if (now !== 'closed' || !prev?.startsWith('canvas:')) return
          const rest = prev.slice('canvas:'.length)
          const sep = rest.lastIndexOf(':')
          const canvasId = sep >= 0 ? rest.slice(0, sep) : rest
          const ownerSid = sep >= 0 ? rest.slice(sep + 1) : ''
          if (canvasId) markCanvasClosedByUser(ownerSid || null, canvasId)
        }),
      ]
      return () => {
        for (const u of unsubs) u()
      }
    }) ?? null
}

function releaseSubscription(): void {
  unsubscribe?.()
  unsubscribe = null
  subScope?.stop()
  subScope = null
}

/**
 * 消费画布状态（模块级单条物理订阅 + per-session 分流；返回本实例会话的 store 视图）。
 * @param sidRef 本消费面的会话 id ref（托盘 / pane 各自持有；undefined 归一为 null）
 */
export function useCanvasSync(sidRef: Ref<string | null | undefined>): CanvasStore {
  refCount++
  ensureSubscribed()
  const listener: CanvasUpdatedListener = (instanceSid, payload) => {
    const sid = sidRef.value ?? null
    if (sid === null || sid !== instanceSid) return
    autoOpenListener(sid, payload)
  }
  updatedListeners.add(listener)
  onScopeDispose(() => {
    updatedListeners.delete(listener)
    refCount--
    if (refCount <= 0) {
      refCount = 0
      releaseSubscription()
    }
  })
  const store = useCanvasStore(sidRef)
  // 首个消费者订阅即拉一次清单（链路 1；未连接时 reject 被吞，重连后由下次失效/重挂收敛）
  void store.listCanvases()
  return store
}

/** 测试钩子：复位订阅 + 桥（模块级跨用例残留防护，对齐 _resetRollingRestartStatusForTest）。 */
export function _resetCanvasSyncForTest(): void {
  refCount = 0
  releaseSubscription()
  bridge = null
  updatedListeners.clear()
}
