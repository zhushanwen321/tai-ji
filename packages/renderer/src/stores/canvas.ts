/**
 * canvas store —— 问题解决画布的 renderer 只读视图缓存（problem-solve-canvas §3.1(3) U5；
 * session-store-layout-inversion D4 会话隔离化：per-session Map 分区，ADR-0049）。
 *
 * 职责与边界：
 * - 数据 = RPC `canvas.list / canvas.get` 拉取（RPC 为 renderer 唯一数据通道——不直读
 *   磁盘；ADR-0097「拉是真理通道」）。store 只持状态与操作；`canvas.updated` 广播的
 *   订阅与 evType 分流、overlay 桥编排归 composables/use-canvas-sync.ts。
 * - 分区形态（ADR-0049 Map 分区范式，useSessionScopedState）：画布按归属会话隔离
 *   （runtime 只返回/放行归属会话的画布），分区键 = 会话 id——本会话清单 + 本会话画布
 *   的全量视图缓存 + 会话内关闭标记。旧「画布是跨 session 共享资源、窗口级单例」的
 *   例外判定随归属唯一化反转：分区生命周期随会话（cleanup 注册进 triggerSessionCleanups
 *   统一编排，删除会话即清分区）。split 双 pane 多实例各自以自己的 sidRef 读各自分区
 *   （实例视图闭包捕获），分区表模块级单份。
 * - 拉取收敛（F-R2-1 同款思路，per-canvas rev 守卫）：广播无 seq，同一画布连续失效会
 *   连续触发 canvas.get；在途旧 reply 晚于新请求返回时会倒拨——每次拉取递增该画布 rev，
 *   reply 返回时 rev 不匹配即整体丢弃，最终落店恒为最后一次拉取的结果（冗余拉取幂等
 *   无害）；清单同款分区级 rev。rev 是纯数字控制面，随模块级 Map 生命周期（分区清理
 *   不单独清——残留无害，同 sid 重建后 rev 继续单调仍守卫正确）。
 * - 广播写入的竞态消除（M1，ADR-0049）：广播失效重拉走 refreshFor(targetSid) 写「消息
 *   所属会话」分区，不读实例 sid 实时值——切会话竞态结构性消除；已删分区按工厂口径
 *   isDeleted 前置拦截（无僵尸写回）。
 * - overlay 解耦：本模块不 import overlay 模块（core/domain/overlay 与 renderer
 *   workflow-viz-overlay）。自动唤起判定的边界输入经 use-canvas-sync 的桥注入读取
 *   （shouldAutoOpenCanvas 纯函数 + 关闭标记），唤起动作由装配点注入的回调执行。
 * - 与 WS/RPC 无关的错误通路：拉取失败落分区 loadError / listError（不覆盖已有画布
 *   数据，重开重拉自愈），不抛出——消费方就近呈现。
 */
import { computed, reactive, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { CanvasListEntry, CanvasState } from '@zhushanwen/extension-protocol'
import type { OverlayContentKind } from '@taiji/shared'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { registerSessionCleanup, useSessionScopedState } from '@/composables/useSessionScopedState'

/** overlay 开合态快照（core overlay 单例的结构化镜像；快照读取器由装配点注入）。 */
export interface CanvasOverlaySnapshot { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  isOpen: boolean
  /** 当前内容 kind（null = 无内容）。 */
  kind: OverlayContentKind | null
  /** 当前内容为 canvas 时的 canvasId（其余 null）。 */
  canvasId: string | null
  /** 当前内容为 canvas 时的归属会话 id（其余 null；core CanvasOverlayPayload.sessionId 镜像）。 */
  sessionId: string | null
}

/**
 * 自动唤起四边界判定中的 ②③④（纯函数；边界①「仅创建触发 + 仅归属会话」=
 * use-canvas-sync 的 evType/会话分流结构性成立——非 CanvasCreated 或非本会话广播不进
 * 本判定）：
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

/** per-session 分区（ADR-0049：会话 id → 本会话画布视图缓存）。 */
interface CanvasSessionPartition { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 画布清单（canvas.list 投影；托盘列表 / 阶段徽标派生的数据源）。 */
  list: CanvasListEntry[]
  /** 清单拉取失败错误（null = 通道正常；非空时托盘就近呈现，旧清单不清）。 */
  listError: string | null
  /** 分区缓存：canvasId → 全量只读视图 + 就近错误。 */
  canvases: Map<string, CanvasPartition>
  /**
   * 用户主动关闭标记（per-canvas，内存态）：设计②——关闭过该画布 overlay 后该画布不再
   * 自动唤起。纯 UI 行为偏好，不进画布事件流、不持久化（同一画布不会被重复创建，重启
   * 丢失标记的实际影响 = 仅当重启后又有新画布创建才会再唤起，设计已判定可接受）。
   */
  closedByUser: Set<string>
}

function createPartition(): CanvasSessionPartition {
  return reactive({
    list: [] as CanvasListEntry[],
    listError: null as string | null,
    canvases: new Map<string, CanvasPartition>(),
    closedByUser: new Set<string>(),
  })
}

// ── 模块级状态根（分区表单份；分区 cleanup 自动注册进 session 销毁编排）──

// @data-owner #64 —— #64 问题解决画布的 renderer per-session 只读缓存（分区表：会话 id →
// 本会话画布清单 + 全量视图；D4 隔离后分区键 = 归属会话，cleanup 挂 triggerSessionCleanups）
const canvasScoped = useSessionScopedState<CanvasSessionPartition>(ref<string | null>(null), createPartition)

/**
 * 分区表响应式锚：工厂的 partitions/deletedSids 是非响应式 Map，cleanup（会话删除编排）
 * 后各实例 computed 需要失效信号才能重算——登记一个只 bump 本地 epoch 的 session cleanup，
 * 与工厂自身的分区删除 cleanup 同批被 triggerSessionCleanups 触发（注册表 Set 遍历）。
 * 读路径读 epoch 建立依赖；updateFor 对已删分区的 no-op 拦截（工厂 deletedSids）负责
 * 让重算结果为空。
 */
// @data-owner #64 —— #64 分区表的响应式失效锚（控制面：会话删除 cleanup 的 bump 信号，
// 非第二数据源；读路径经 readPartition/writablePartition 归一）
const partitionEpoch = ref(0)
registerSessionCleanup((): void => {
  partitionEpoch.value += 1
})

/** 读分区（不建已删分区；分区不存在返回 null——调用方按无数据处理）。 */
function readPartition(sid: string | null): CanvasSessionPartition | null {
  void partitionEpoch.value
  if (!sid) return null
  let p: CanvasSessionPartition | null = null
  canvasScoped.updateFor(sid, (partition) => { p = partition })
  return p
}

/** 写分区前的已删拦截（工厂口径：已删未重建的 sid 不写——会话已删除，拉取/打标无意义）。 */
function writablePartition(sid: string): CanvasSessionPartition | null {
  void partitionEpoch.value
  if (canvasScoped.isDeleted(sid)) return null
  let p: CanvasSessionPartition | null = null
  canvasScoped.updateFor(sid, (partition) => { p = partition })
  return p
}

// ── 在途守卫（控制面，非响应状态；rev 随模块级 Map 生命周期——残留无害且同 sid
//    重建后 rev 继续单调仍守卫正确）──
// @data-owner #64 —— #64 拉取收敛的 rev 控制面（在途旧 reply 倒拨守卫，per-session ×
// per-canvas 版本号；非数据源，与登记条目 #64 的合并口径（rev 防倒拨）同机制）
const loadRevsBySid = new Map<string, Map<string, number>>()
// @data-owner #64 —— #64 清单拉取的 rev 控制面（同上，清单维度）
const listRevBySid = new Map<string, number>()

async function fetchList(sid: string): Promise<void> {
  const rev = (listRevBySid.get(sid) ?? 0) + 1
  listRevBySid.set(sid, rev)
  try {
    const reply = await command('canvas.list', { sessionId: sid }, RPC_BACKSTOP_TIMEOUT_MS)
    if ((listRevBySid.get(sid) ?? 0) !== rev) return
    const p = writablePartition(sid)
    if (!p) return
    p.list = reply.canvases
    p.listError = null
  } catch (e) {
    if ((listRevBySid.get(sid) ?? 0) !== rev) return
    console.error('[canvas-store] canvas.list failed:', e)
    const p = writablePartition(sid)
    if (!p) return
    p.listError = toErrorMessage(e)
  }
}

async function fetchCanvas(sid: string, canvasId: string): Promise<void> {
  const revs = loadRevsBySid.get(sid) ?? new Map<string, number>()
  loadRevsBySid.set(sid, revs)
  const rev = (revs.get(canvasId) ?? 0) + 1
  revs.set(canvasId, rev)
  try {
    const state = await command('canvas.get', { canvasId, sessionId: sid }, RPC_BACKSTOP_TIMEOUT_MS)
    if ((revs.get(canvasId) ?? 0) !== rev) return
    const p = writablePartition(sid)
    if (!p) return
    p.canvases.set(canvasId, reactive<CanvasPartition>({ state, loadError: null }))
  } catch (e) {
    if ((revs.get(canvasId) ?? 0) !== rev) return
    const msg = toErrorMessage(e)
    console.error('[canvas-store] canvas.get failed:', e)
    const p = writablePartition(sid)
    if (!p) return
    const existing = p.canvases.get(canvasId)
    if (existing) {
      existing.loadError = msg
    } else {
      p.canvases.set(canvasId, reactive<CanvasPartition>({ state: null, loadError: msg }))
    }
  }
}

/** 实例视图（useCanvasStore 返回值；闭包捕获实例 sidRef 的读投影）。 */
export interface CanvasStore { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 画布清单（canvas.list 投影；托盘列表 / 阶段徽标派生的数据源）。 */
  list: ComputedRef<CanvasListEntry[]>
  /** 清单拉取失败错误（null = 无错误）。 */
  listError: ComputedRef<string | null>
  /** 画布全量只读视图（未拉取 / 拉取失败为 null；响应式——消费方 computed 内调用可跟踪）。 */
  canvasOf: (canvasId: string) => CanvasState | null
  /** 画布拉取失败错误（null = 无错误）。 */
  loadErrorOf: (canvasId: string) => string | null
  /**
   * 拉取画布清单（canvas.list，按本实例会话过滤）。启动首拉（use-canvas-sync 首个
   * 消费者订阅时）与手动重拉共用入口；rev 守卫见文件头。
   */
  listCanvases: () => Promise<void>
  /**
   * 拉取单画布全量（canvas.get）：打开入口与手动重拉共用。
   * rev 守卫（见文件头）：在途窗口内出现更新的拉取/失效信号，本 reply 整体丢弃——
   * 旧快照不得倒拨新状态。失败落分区 loadError，不清既有 state（失败兜底显示）。
   */
  loadCanvas: (canvasId: string) => Promise<void>
  /** 该画布是否被用户主动关闭过（自动唤起边界②的判定输入；本实例分区）。 */
  isClosedByUser: (canvasId: string) => boolean
}

/**
 * 广播失效重拉（updateFor 目标分区写）：重拉 targetSid 会话的清单，canvasId 非空时
 * 连带重拉该画布。写「消息所属会话」分区（M1 竞态消除），已删分区拦截。导出供
 * use-canvas-sync 的广播分流消费（生产唯一调用点）。
 */
export function refreshCanvasFor(targetSid: string, canvasId: string | null): void {
  if (canvasId) void fetchCanvas(targetSid, canvasId)
  void fetchList(targetSid)
}

/**
 * 打用户关闭标记到指定会话分区（该画布不再自动唤起；幂等；targetSid = overlay 归属
 * 会话——关闭动作精确落画布 owner 分区，与唤起判定同分区对上）。导出供 use-canvas-sync
 * 的关闭打标 watch 消费。
 */
export function markCanvasClosedByUser(targetSid: string | null, canvasId: string): void {
  if (!targetSid || !canvasId) return
  const p = writablePartition(targetSid)
  if (!p) return
  p.closedByUser.add(canvasId)
}

/** 关闭标记查询（指定分区；唤起判定的边界②输入——查 owner 分区而非实例分区）。 */
export function isCanvasClosedByUser(targetSid: string | null, canvasId: string): boolean {
  return readPartition(targetSid)?.closedByUser.has(canvasId) ?? false
}

/**
 * 消费画布状态（per-session 分区读投影；实例以传入 sidRef 为焦点）。多实例（split 双
 * pane / 托盘 / overlay）各传各自 sidRef，互不串分区。订阅生命周期（广播分流 / 唤起 /
 * 打标）归 use-canvas-sync 的 useCanvasSync。
 */
export function useCanvasStore(sidRef: Ref<string | null | undefined>): CanvasStore {
  const normalizedSid = computed(() => sidRef.value ?? null)

  const list = computed<CanvasListEntry[]>(() => readPartition(normalizedSid.value)?.list ?? [])
  const listError = computed<string | null>(() => readPartition(normalizedSid.value)?.listError ?? null)

  function canvasOf(canvasId: string): CanvasState | null {
    return readPartition(normalizedSid.value)?.canvases.get(canvasId)?.state ?? null
  }

  function loadErrorOf(canvasId: string): string | null {
    return readPartition(normalizedSid.value)?.canvases.get(canvasId)?.loadError ?? null
  }

  async function listCanvases(): Promise<void> {
    const sid = normalizedSid.value
    if (!sid) return
    await fetchList(sid)
  }

  async function loadCanvas(canvasId: string): Promise<void> {
    if (!canvasId) return
    const sid = normalizedSid.value
    if (!sid) return
    await fetchCanvas(sid, canvasId)
  }

  function isClosedByUser(canvasId: string): boolean {
    return readPartition(normalizedSid.value)?.closedByUser.has(canvasId) ?? false
  }

  return {
    list,
    listError,
    canvasOf,
    loadErrorOf,
    listCanvases,
    loadCanvas,
    isClosedByUser,
  }
}

/**
 * 测试钩子：清空全部分区、rev 控制面（用例隔离；订阅/桥复位归 _resetCanvasSyncForTest）。
 * 生产代码禁止调用。
 */
export function _resetCanvasStoreForTest(): void {
  canvasScoped._clearAllForTest()
  loadRevsBySid.clear()
  listRevBySid.clear()
}
