/**
 * Extension UI 交互 composable——bus 订阅编排 + filter 分流读取。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.ui_request
 * → core MessageBusBridge 归一为 bus 'ui-request' 事件（plugin:uiRequest + extension.ui_request
 * 双源合一）→ 本 composable 订阅 bus、写入 extensionUIStore（session 级 pending SSOT）→
 * 渲染层（Panel inline overlay）从 store 分区派生 → 用户操作 → sendExtensionUIResponse
 * 回传（带 method）→ pi Promise resolve。
 *
 * 状态归属（CW wave `session-active-ssot` T2）：pending 队列已提升到 extensionUIStore
 *（session 级 SSOT），让 deriveStatus 经 hasPendingBlockingOverlay 能查到阻塞 overlay
 *（form 键，统一表单协议）等待状态。
 * 本 composable 只负责：①订阅编排（per-panel 实例各自订阅）；②filter 分流读取
 *（store 存全量 pending，currentFormRequest 在 computed 里按 filter 取）。
 *
 * 订阅模型（slice `companion-band-mount` wave1，IF2）：
 * - bus 'ui-request' 订阅走**模块级 refCount**（项目规则 #2 防重复注册）——首个实例订阅时
 *   单次 bus.on，末个实例注销时 unsub；实例 handler 只处理富交互 overlay 请求
 *   （C4 分流：form / planReview 两类，普通 dialog 请求由 CompanionBand wave 消费
 *   bus 直连，不经 store）
 * - 事件 sessionId 缺失（无 sid 的 ui-request）→ 跳过入 store（warn，C2）
 * - 事件按**事件 sid** 写入分区（M1 竞态语义：切 session 后旧 sid 迟到事件写旧分区，不污染新分区）
 * - getPendingRequests（切回拉取）保留 RPC 路径（C3）
 *
 * filter 仅用于读取分流 + 入队第二道闸（富交互硬过滤之后）：store 存全量 pending，
 * 多个 composable 实例（Panel 入 overlay 读取、审批条入 planReview 读取——D5）各按
 * filter 读同一份 store 分区。默认 formFilter（统一表单 form 键，Panel inline 渲染面）；
 * dialog 请求（非标记类）已由 CompanionBand 消费 bus 直连（wave1 起），不再经 store。
 *
 * legacy 归一已上移 runtime（ui-presentation-protocol D7 收口，MF-1-5）：旧 askUser /
 * scheduleCreate marker 帧由 runtime event-adapter 分支直接产出 form:true 统一表单帧
 * （askUser 源含 type 推断映射），本层只消费 view-ready 帧、不再有 renderer 侧归一挂点。
 */
import { computed, watch, onScopeDispose, type Ref } from 'vue'
import type { InternalEvent, DialogRequest } from '@taiji/core'
import type { ExtensionInteractMethod } from '@taiji/shared'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { sendExtensionUIResponse, getPendingRequests, type ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** 入队过滤谓词：返回 true 的请求才入队 */
export type UIRequestFilter = (req: ExtensionUIRequest) => boolean

/**
 * 统一表单 overlay 请求过滤器（Panel inline 渲染用）：form 键（终态判定面，D5 收敛）。
 * 全部表单族帧（新 form marker / legacy askUser / scheduleCreate marker）由 runtime
 * event-adapter marker 分支统一产出 form:true。普通 dialog 请求仍由 CompanionBand 消费
 * bus 直连（extension-host-dialog C4 对称排除，零重叠契约）。
 */
export const formFilter: UIRequestFilter = (req) => req.form === true

// ── planReview 分流（plan 模式重设计 u1-banner，设计 D5 PLAN_REVIEW_MARKER select 通道）──

/**
 * planReview 审批请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后在 extension.ui_request
 * 上附加的 `planReview: true` 标记，与 askUser 同构分流）。
 *
 * core 的 ExtensionUIRequest 契约未加员（runtime 侧路由归 u1-rpc），本地同形扩展——与
 * plan-store.ts 的 PlanReviewComment 本地同形惯例一致（renderer 不依赖 extension-protocol，
 * 最底层共享包不反向加员；字段运行时存在，经 isPlanReviewRequest 类型守卫收窄）。
 */
export interface PlanReviewUIRequest extends ExtensionUIRequest {
  planReview: true
}

/**
 * 类型守卫：是否 planReview 审批请求。select 挂起期是「审批可交互」的权威信号（D5：
 * 挂起 select 是 GUI→extension 的唯一可靠交互通道），审批条「有挂起请求」判定以此为源。
 */
export function isPlanReviewRequest(req: ExtensionUIRequest): req is PlanReviewUIRequest {
  return (req as { planReview?: unknown }).planReview === true
}

/** planReview 审批请求过滤器（审批条用；与 formFilter 互斥——一个请求只归一面） */
export const planReviewFilter: UIRequestFilter = (req) => isPlanReviewRequest(req)

// ── 模块级 refCount bus 订阅（项目规则 #2：多实例共享单次注册，防事件处理翻倍） ──
// split 双 panel 多实例各自订阅同一 bus 事件，若每实例直接 bus.on 则同一事件被 N 个
// handler 各处理一次。refCount：首个实例注册时单次 bus.on('ui-request')（dispatchAll 遍历
// 实例 handler Set），末个注销时 unsub。store.addRequest 的 requestId dedup 保证同事件
// 多实例分发幂等（T1/T10）。
type UiRequestEvent = Extract<InternalEvent, { kind: 'ui-request' }>
type BusHandler = (e: UiRequestEvent) => void

// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：扩展 UI 事件 bus handler 注册表，非 GUI 数据
const busHandlers = new Set<BusHandler>()
let busUnsub: (() => void) | null = null

function subscribeBus(handler: BusHandler): () => void {
  busHandlers.add(handler)
  if (busHandlers.size === 1) {
    const bus = getExtensionBus()
    busUnsub = bus.on('ui-request', (e) => {
      for (const h of busHandlers) h(e)
    })
  }
  return () => {
    busHandlers.delete(handler)
    if (busHandlers.size === 0 && busUnsub) {
      busUnsub()
      busUnsub = null
    }
  }
}

/** 测试钩子：清空模块级 bus 订阅残留（对齐 __resetXxxForTesting 模式）。 */
export function __resetExtensionBusSubscriptionForTesting(): void {
  if (busUnsub) {
    busUnsub()
    busUnsub = null
  }
  busHandlers.clear()
}

/** dialog 基础展示字段搬运（title/message/options/default/level/prefill）。
 *  DialogRequest 索引签名读原始 payload，值域 unknown，按 ExtensionUIRequest 契约断言收窄。 */
function pickDialogFields(
  request: DialogRequest,
): Partial<Pick<ExtensionUIRequest, 'title' | 'message' | 'options' | 'default' | 'level' | 'prefill'>> {
  return {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.message !== undefined ? { message: request.message as string } : {}),
    ...(request.options !== undefined ? { options: request.options as string[] } : {}),
    ...(request.default !== undefined ? { default: request.default as string } : {}),
    ...(request.level !== undefined ? { level: request.level as 'info' | 'warn' | 'error' } : {}),
    ...(request.prefill !== undefined ? { prefill: request.prefill as string } : {}),
  }
}

/** 统一表单扩展字段搬运（白名单漏补 = 字段静默剥离，FormOverlay 渲染拿不到问题集）；
 *  formQuestions 值域 unknown[]（isFormQuestion 守卫在消费端收窄），无需断言 */
function pickFormFields(
  request: DialogRequest,
): Partial<Pick<ExtensionUIRequest, 'form' | 'formQuestions' | 'allowCancel'>> {
  return {
    ...(request.form !== undefined ? { form: request.form as true } : {}),
    ...(request.formQuestions !== undefined ? { formQuestions: request.formQuestions as unknown[] } : {}),
    ...(request.allowCancel !== undefined ? { allowCancel: request.allowCancel as boolean } : {}),
  }
}

/** scheduleCreate 源键搬运（窗口内保留——FormOverlay 按挂载源键分流应答形状：draft 源 =
 *  扁平 FormResult JSON，替换式剥离会断 ScheduleForm 直挂 draft 链）；askUser 源键已随
 *  归一层上移 runtime 退役（ask-user marker 帧直接产 formQuestions），窗口末 schedule
 *  源键同批退役——formFilter 只认 form 键 */
function pickLegacyFields(
  request: DialogRequest,
): Partial<Pick<ExtensionUIRequest, 'scheduleCreate' | 'scheduleDraft'>> {
  return {
    ...(request.scheduleCreate !== undefined ? { scheduleCreate: request.scheduleCreate as boolean } : {}),
    ...(request.scheduleDraft !== undefined ? { scheduleDraft: request.scheduleDraft } : {}),
  }
}

/**
 * bus 事件 request（DialogRequest）→ ExtensionUIRequest 适配（IF3）。
 *
 * DialogRequest 是 parseUiRequest/parseExtensionUiRequest 经 ...payload 展开构造的——
 * runtime extension.ui_request 原始 payload（含 form/formQuestions/allowCancel/message/
 * options 等）保留在索引签名里（event-adapter UI_FORM_MARKER 分支 payload 标记 form:true）。
 * method 用原始 method（可能超界如 editor）?? kind 兜底（kind 已归一 select/confirm/input）。
 */
function toExtensionUIRequest(sid: string, request: DialogRequest): ExtensionUIRequest {
  return {
    sessionId: sid,
    requestId: request.requestId,
    method: (request.method as ExtensionInteractMethod | undefined) ?? request.kind,
    ...pickDialogFields(request),
    ...pickFormFields(request),
    ...pickLegacyFields(request),
    // planReview 标记透传（D5）：DialogRequest 索引签名读原始 payload，守卫后携带进 store——
    // 挂起枚举（currentPlanReviewRequests）依赖该字段识别审批请求。
    ...(request.planReview !== undefined ? { planReview: request.planReview === true } : {}),
    receivedAt: Date.now(),
  }
}

export function useExtensionUI(
  sessionId: Ref<string | null>,
  filter: UIRequestFilter = formFilter,
) {
  // pending 队列 SSOT 在 store（T2 迁移）：本 composable 只订阅事件写入 store、按 filter 读 store。
  // store.addRequest 含 requestId dedup（T1），无需手写去重。
  const store = useExtensionUIStore()

  let unsubFns: Array<() => void> = []

  function subscribe(sid: string | null): void {
    // 切换 session 先退订旧订阅
    if (unsubFns.length > 0) {
      unsubFns.forEach(fn => fn())
      unsubFns = []
    }
    if (!sid) return
    // bus 订阅（IF2）：ui-request 事件按**事件 sid** 入 store 分区（M1 竞态语义——
    // 切 session 后旧 sid 迟到事件写旧分区，不污染新分区；事件自带归属，无需捕获订阅时 sid）。
    // C4 分流：富交互硬过滤先行（form / planReview 两标记请求入 store 分区——分别渲染
    // FormOverlay / PlanReviewBar；普通 dialog 由 CompanionBand 消费 bus，
    // extension-host-dialog 侧对称排除，零重叠契约），filter 是第二道闸（实例只放各自
    // 标记——store 共享，谁放行谁入队，requestId dedup 兜底双实例幂等）。
    // C2：事件 sid 缺失（无 sid 的 ui-request）跳过入队（warn）——渲染面依赖 session 分区。
    unsubFns.push(
      subscribeBus((e) => {
        const eventSid = e.sessionId
        if (!eventSid) {
          console.warn('[useExtensionUI] ui-request 事件缺少 sessionId，跳过入队:', e.request.requestId)
          return
        }
        // C4 分流（form / planReview 两标记放行）：runtime event-adapter 的 marker 分支
        //（form / ask-user / schedule-create）已统一产出 form:true 帧——legacy 归一上移
        // runtime（原 D7 双挂点收口），本层只消费 view-ready 帧
        const raw = e.request
        const isPlanReview = raw.planReview === true
        if (raw.form !== true && !isPlanReview) return // C4：富交互标记放行
        const adapted = toExtensionUIRequest(eventSid, raw)
        if (filter && !filter(adapted)) return // filter 第二道闸
        store.addRequest(eventSid, adapted)
      }),
    )
    // C3 保留：拉取 runtime 缓存的 pending 请求（切换 session 后重新订阅时，runtime 会推送缓存的请求）
    // 异步执行，不阻塞订阅建立
    getPendingRequests(sid)
      .then((pendingRequests) => {
        // 全量写入 store（不入库时 filter）。M1 竞态修复：addRequest(sid, ...) 用订阅时捕获的
        // sid（参数）——只写旧 sid 分区，不读 sessionId.value。即使此响应在 session 切换后到达，
        // 也只写入旧 sid 的 Map 分区，不会污染新 sid。Map 分区已结构性隔离 stale 响应。
        for (const req of pendingRequests) {
          // pending 帧经 runtime {...r,...r.payload} 解包——payload 即 marker 分支产出的
          // view-ready 帧（form:true 原生携带，legacy 归一已在 runtime 侧完成），直接入
          // store；该路径不经 toExtensionUIRequest（切回 session / respawn 恢复路径）
          store.addRequest(sid, { ...req, receivedAt: req.receivedAt ?? Date.now() })
        }
      })
      .catch((err) => {
        console.warn('[useExtensionUI] Failed to get pending requests:', err)
      })
  }

  subscribe(sessionId.value)
  watch(sessionId, (sid) => subscribe(sid))

  onScopeDispose(() => {
    unsubFns.forEach(fn => fn())
    unsubFns = []
  })

  // ── 分流渲染：统一表单 overlay（form 键）走 Panel inline，其余由 CompanionBand（bus 直连）──
  // 从 store 分区派生：store 存全量 pending，computed 内按 form 谓词取 + filter 过滤。
  // 读 sessionId.value 建立响应式依赖，sid 变化时重算读新分区。
  /**
   * 队列中第一个统一表单 overlay 请求（form 键，Panel inline 渲染用）；无则 undefined。
   * form 键 = 终态判定面（D5 收敛）：全部表单族帧（form / legacy askUser /
   * scheduleCreate marker）由 runtime event-adapter 分支统一产出。消费方
   *（usePanelView/Panel）按挂载源键分流 FormOverlay 的 questions / draft props。
   */
  const currentFormRequest = computed(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    const records = store.recordsOf(sid).value
    return (filter ? records.filter(filter) : records).find(
      (r) => r.form === true,
    )
  })

  /**
   * 挂起 planReview 审批请求列表（D5 审批条消费面）：
   * 「有挂起请求」判定 + respond 定位都按 requestId 枚举本列表——正常时序恒单条
   * （extension 单挂起），列表形态防多请求并发时的队首假设（pi 无串行保证，对齐
   * removeRequest 的 requestId 精确语义）。切 session 读不同分区，无 sid 恒空。
   */
  const currentPlanReviewRequests = computed<PlanReviewUIRequest[]>(() => {
    const sid = sessionId.value
    if (!sid) return []
    return store.recordsOf(sid).value.filter(isPlanReviewRequest)
  })

  /** 用户回复指定请求（按 requestId 精确定位，不假设队首） */
  function respond(requestId: string, result: boolean | string | null): void {
    const sid = sessionId.value
    if (!sid) return
    const target = store.getRequestsBySession(sid).find(r => r.requestId === requestId)
    if (!target) return
    sendExtensionUIResponse(target.sessionId, target.requestId, target.method, result)
    // store.removeRequest 按 requestId 精确移除（不区分 form/dialog），requestId 全局唯一，
    // 故即使本实例 filter 不同也能正确移除。
    store.removeRequest(sid, requestId)
  }

  /** 用户取消（等价 respond(requestId, null)） */
  function cancel(requestId: string): void {
    respond(requestId, null)
  }

  return {
    currentFormRequest,
    currentPlanReviewRequests,
    respond,
    cancel,
  }
}
