/**
 * canvas store —— 问题解决画布的 renderer 只读视图缓存（problem-solve-canvas §3.1(3) U5）。
 *
 * 职责与边界：
 * - 数据 = RPC `canvas.list / canvas.get` 拉取（RPC 为 renderer 唯一数据通道——不直读
 *   `<dataDir>/canvases/` 磁盘；ADR-0097「拉是真理通道」）。store 只持状态与操作；
 *   `canvas.updated` 广播的订阅与 evType 分流、overlay 桥编排归 composables/use-canvas-sync.ts。
 * - 分区形态：`Map<canvasId, 分区>` 缓存 + 画布清单（canvas.list 投影，托盘列表数据源）。
 *   画布是**跨 session 共享资源**（设计 D4/D7），分区键是 canvasId 而非 sessionId、
 *   生命周期不随 session 删除——ADR-0049 per-session Map 分区范式（useSessionScopedState）
 *   不适用，对齐 useRollingRestartStatus「窗口级单例状态」判定：自持 reactive Map 分区，
 *   不挂 sessionCleanup 链。
 * - 拉取收敛（F-R2-1 同款思路，per-canvas rev 守卫）：广播无 seq（global 通道），同一画布
 *   连续失效会连续触发 canvas.get；在途旧 reply 晚于新请求返回时会倒拨——每次 loadCanvas
 *   递增该画布 rev，reply 返回时 rev 不匹配即整体丢弃，最终落店恒为最后一次拉取的结果
 *   （冗余拉取幂等无害）；canvas.list 同款全局 rev。
 * - overlay 解耦：本 store 不 import overlay 模块（core/domain/overlay 与 renderer
 *   workflow-viz-overlay）。自动唤起判定的边界输入经 use-canvas-sync 的桥注入读取
 *   （shouldAutoOpenCanvas 纯函数 + 关闭标记 Map），唤起动作由装配点注入的回调执行。
 * - 与 WS/RPC 无关的错误通路：拉取失败落分区 loadError / listError（不覆盖已有画布
 *   数据，重开重拉自愈），不抛出——消费方就近呈现。
 *
 * stores 间依赖方向：无（不 import 其他 store）。
 */
import { reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { CanvasListEntry, CanvasState } from '@zhushanwen/extension-protocol'
import type { OverlayContentKind } from '@taiji/shared'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'

/** overlay 开合态快照（core overlay 单例的结构化镜像；快照读取器由装配点注入）。 */
export interface CanvasOverlaySnapshot { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  isOpen: boolean
  /** 当前内容 kind（null = 无内容）。 */
  kind: OverlayContentKind | null
  /** 当前内容为 canvas 时的 canvasId（其余 null）。 */
  canvasId: string | null
}

/**
 * 自动唤起三边界判定中的 ②③（纯函数；边界①「仅创建形态触发」= use-canvas-sync 的
 * evType 分流结构性成立——非 CanvasCreated 不进本判定）：
 * - ② 用户主动关闭过该画布 overlay（per-canvas 关闭标记）→ 不再自动唤起；
 * - ③ 当前有其他 overlay 打开（workflow / browser / scheduler）→ 不抢焦点（托盘徽标
 *   提示由列表刷新承载，非本函数职责）。
 * fail-safe：overlay 快照不可得（桥未装配，如测试未注册 / 装配缺失）→ 不唤起——唤起
 * 通道缺失时绝不抢屏，数据拉取与列表更新不受影响。
 * 当前 overlay 即 canvas tab（kind='canvas'）不在「其他 overlay」之列（设计词面仅列
 * workflow / browser / scheduler 三种）：新画布唤起 = 单例换内容（openWorkflowVizOverlay
 * 开新 run 同款抢视口语义）。
 */
export function shouldAutoOpenCanvas(input: {
  closedByUser: boolean
  overlay: CanvasOverlaySnapshot | null
}): boolean {
  if (input.closedByUser) return false
  if (input.overlay === null) return false
  if (input.overlay.isOpen && input.overlay.kind !== 'canvas') return false
  return true
}

/** 单画布分区（canvas.get 拉取结果 + 就近错误）。state null = 未拉取或首拉失败。 */
interface CanvasPartition { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  state: CanvasState | null
  loadError: string | null
}

export const useCanvasStore = defineStore('canvas', () => {
  /** 画布清单（canvas.list 投影；托盘列表 / 阶段徽标派生的数据源）。 */
  const list = shallowRef<CanvasListEntry[]>([])
  /** 清单拉取失败错误（null = 通道正常；非空时托盘就近呈现，旧清单不清）。 */
  const listError = ref<string | null>(null)
  /** 分区缓存：canvasId → 全量只读视图 + 就近错误。 */
  const canvases = reactive(new Map<string, CanvasPartition>())
  /**
   * 用户主动关闭标记（per-canvas，内存态）：设计②——关闭过该画布 overlay 后该画布不再
   * 自动唤起。纯 UI 行为偏好，不进画布事件流、不持久化（同一画布不会被重复创建，重启
   * 丢失标记的实际影响 = 仅当重启后又有新画布创建才会再唤起，设计已判定可接受）。
   */
  const closedByUser = reactive(new Set<string>())

  // ── 在途守卫（控制面，非响应状态）──
  /** per-canvas 拉取版本号（loadCanvas 每次递增；reply 返回不匹配即丢弃，见文件头）。 */
  const loadRevs = new Map<string, number>()
  /** 清单拉取版本号（全局，语义同上）。 */
  let listRev = 0

  function loadRevOf(canvasId: string): number {
    return loadRevs.get(canvasId) ?? 0
  }

  function partitionOf(canvasId: string): CanvasPartition {
    let p = canvases.get(canvasId)
    if (!p) {
      p = reactive<CanvasPartition>({ state: null, loadError: null })
      canvases.set(canvasId, p)
    }
    return p
  }

  /** 画布全量只读视图（未拉取 / 拉取失败为 null；响应式——消费方 computed 内调用可跟踪）。 */
  function canvasOf(canvasId: string): CanvasState | null {
    return canvases.get(canvasId)?.state ?? null
  }

  /** 画布拉取失败错误（null = 无错误）。 */
  function loadErrorOf(canvasId: string): string | null {
    return canvases.get(canvasId)?.loadError ?? null
  }

  /**
   * 拉取画布清单（canvas.list）。启动首拉（use-canvas-sync 首个消费者订阅时）与
   * canvas.updated 失效重拉共用入口；rev 守卫同文件头。
   */
  async function listCanvases(): Promise<void> {
    const rev = ++listRev
    try {
      const reply = await command('canvas.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
      if (rev !== listRev) return
      list.value = reply.canvases
      listError.value = null
    } catch (e) {
      if (rev !== listRev) return
      listError.value = toErrorMessage(e)
      console.error('[canvas-store] canvas.list failed:', e)
    }
  }

  /**
   * 拉取单画布全量（canvas.get）：打开入口与 canvas.updated 失效重拉共用。
   * rev 守卫（见文件头）：在途窗口内出现更新的拉取/失效信号，本 reply 整体丢弃——
   * 旧快照不得倒拨新状态。失败落分区 loadError，不清既有 state（失败兜底显示）。
   */
  async function loadCanvas(canvasId: string): Promise<void> {
    if (!canvasId) return
    const rev = loadRevOf(canvasId) + 1
    loadRevs.set(canvasId, rev)
    try {
      const state = await command('canvas.get', { canvasId }, RPC_BACKSTOP_TIMEOUT_MS)
      if (loadRevOf(canvasId) !== rev) return
      const p = partitionOf(canvasId)
      p.state = state
      p.loadError = null
    } catch (e) {
      if (loadRevOf(canvasId) !== rev) return
      const msg = toErrorMessage(e)
      console.error('[canvas-store] canvas.get failed:', e)
      partitionOf(canvasId).loadError = msg
    }
  }

  /** 打用户关闭标记（不再自动唤起；幂等）。关闭编排由 use-canvas-sync 的开合态 watch 承接。 */
  function markClosedByUser(canvasId: string): void {
    if (canvasId) closedByUser.add(canvasId)
  }

  /** 该画布是否被用户主动关闭过（自动唤起边界②的判定输入）。 */
  function isClosedByUser(canvasId: string): boolean {
    return closedByUser.has(canvasId)
  }

  return {
    list,
    listError,
    canvasOf,
    loadErrorOf,
    listCanvases,
    loadCanvas,
    markClosedByUser,
    isClosedByUser,
  }
})

/** store 实例类型（消费方 / use-canvas-sync 传参用）。 */
export type CanvasStore = ReturnType<typeof useCanvasStore>
