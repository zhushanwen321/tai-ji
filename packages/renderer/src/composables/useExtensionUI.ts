/**
 * Extension UI 交互 composable——bus 订阅编排 + filter 分流读取。
 *
 * pi extension 调 ctx.ui.select/confirm/input → runtime 推 extension.dialog
 * （pi1-disposition-chat-flow D6：前端按消息类型分发）
 * → core MessageBusBridge 归一为 bus 'ui-request' 事件（plugin:uiRequest + extension.dialog
 * 双源合一）→ 本 composable 订阅 bus、写入 extensionUIStore（session 级 pending SSOT）→
 * 渲染层（Panel inline overlay）从 store 分区派生 → 用户操作 → sendExtensionUIResponse
 * 回传（method = dialogKind 同形值）→ pi Promise resolve。
 *
 * 通道算法归属（MF-1-7 双壳收敛）：C4 富交互门 / 快照对账差集剔除 / 失效摘除 / respond
 * 未送达保留-送达摘除 / 队首读口已下沉 @taiji/ui/extension-host createFormRequestChannel
 * （双壳算法单点；移动 companion-bridge 是同 factory 的 reactive Map 分区实现）。本模块
 * 只保留桌面特有裁决：
 * - pinia store 分区适配（formPartitions——factory FormChannelPartitions 的桌面实现）；
 * - 订阅模型：bus 'ui-request' 走**模块级 refCount**（项目规则 #2 防重复注册）——首个实例
 *   订阅时单次 bus.on，末个实例注销时 unsub；requests-invalidated 模块级单订阅永驻；
 * - 帧适配 toExtensionUIRequest（全字段白名单 + receivedAt 戳 + expectTurn 透传）；
 * - 桌面特有编排（经 factory 钩子注入）：planReview 镜像同步（syncPlanReviewWindow /
 *   markPlanReviewAnswered）、pendingSend 分型收口（clearPendingSend）、btw 草稿终结清理
 *   （clearBtwBarDrafts）、toast 反馈。
 *
 * 订阅模型（slice `companion-band-mount` wave1，IF2）：
 * - 事件 sessionId 缺失（无 sid 的 ui-request）→ 跳过入 store（warn，C2）
 * - 事件按**事件 sid** 写入分区（M1 竞态语义：切 session 后旧 sid 迟到事件写旧分区，不污染新分区）
 * - getPendingRequests（切回拉取）保留 RPC 路径（C3）——快照差集剔除在 factory reconcile
 *   （renderer 侧僵尸请求修剪主算法，§6.2 采用项④ v6.1：不在快照中的旧条目一律移除，
 *   空快照也执行；快照补入只入富交互帧，普通 dialog 帧不进 store 分区）
 *
 * filter 仅用于读取分流 + 入队第二道闸（富交互硬过滤之后）：store 存富交互 pending，
 * 多个 composable 实例（Panel 入 overlay 读取、审批条入 planReview 读取——D5）各按
 * filter 读同一份 store 分区。默认 formFilter（统一表单 form 键，Panel inline 渲染范围）；
 * dialog 请求（非标记类）已由 CompanionBand 消费 bus 直连（wave1 起），不再经 store。
 *
 * legacy 归一已上移 runtime（ui-presentation-protocol D7 收尾，MF-1-5）：旧 askUser /
 * scheduleCreate marker 帧由 runtime event-adapter 分支直接产出 form:true 统一表单帧
 * （askUser 源含 type 推断映射），本层只消费 view-ready 帧、不再有 renderer 侧归一挂点。
 *
 * btw 侧（btw-question M3-c）：本模块只承载 btw 挂起的失效/修剪收尾与 D7⑤ 草稿状态
 * 本体（文件尾）；drawer 内联确认条编排本体（D8 降级路径）拆在
 * panel/useBtwInteraction.ts（单向依赖：编排 → 本模块，无环）。
 */
import { computed, reactive, watch, onScopeDispose, type Ref } from 'vue'
import type { InternalEvent, DialogRequest } from '@taiji/core'
import type { ExtensionInteractMethod } from '@taiji/shared'
import type { PlanReviewRequest } from '@zhushanwen/extension-protocol'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { notifyUiResponseNotDelivered } from '@/composables/shell/ui-response-feedback'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import {
  createFormRequestChannel,
  bindSessionFormActions,
  isPlanReviewFrame,
  type FormChannelPartitions,
} from '@taiji/ui/extension-host'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChatStore } from '@/stores/chat'
import { usePlanStore, registerPlanReviewColdSink } from '@/stores/plan-store'

/** 入队过滤谓词：返回 true 的请求才入队 */
export type UIRequestFilter = (req: ExtensionUIRequest) => boolean

/**
 * 统一表单 overlay 请求过滤器（Panel inline 渲染用）：form 键（终态判定面，D5 收敛）。
 * 全部表单族帧（新 form marker / legacy askUser / scheduleCreate marker）由 runtime
 * event-adapter marker 分支统一产出 form:true。普通 dialog 请求仍由 CompanionBand 消费
 * bus 直连（shell-adapters C4 对称排除，零重叠契约）。
 */
export const formFilter: UIRequestFilter = (req) => req.form === true

// ── planReview 分流（plan 模式状态机显式化 D3/D4/D9，PLAN_REVIEW_MARKER select 通道）──

/**
 * planReview 审批请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后在 extension.ui_request
 * 上附加的 `planReview: true` 标记，与 form 同构分流）。
 *
 * core 的 ExtensionUIRequest 契约已随 wire SSOT 携带 planReview/permission 标记键
 *（core/transport/api/domains/extension.ts 镜像注释——随 shared/protocol.ts 对齐声明，
 * 消费方免 cast 直读）；PlanReviewUIRequest 的 `planReview: true` 是必有化收窄而非本地补键。
 * 响应回传的 `PlanReviewResponse` 与请求载荷字段**直接 import extension-protocol**
 *（D2/D3④ regime——旧「renderer 不依赖 extension-protocol」表述已过时，renderer 早已依赖它；
 * PlanReviewComment / PlanReviewResponse 本地同形副本已删除迁移，consumers.md 一④）。
 * `selfReview`（D9③）：agent 自审结论，与 canonical `PlanReviewRequest.selfReview` 同名同义，
 * 帧搬运走 pickPlanFields 白名单（热帧）/ 快照全量解包（冷补）双入店路径。
 * 本文件的 `isPlanReviewRequest` 是**帧标记检查**（入 store 的请求面），与 canonical
 * `@zhushanwen/extension-protocol` 的同名**载荷形状检查**（select options JSON 解析范围）
 * 输入域不同、互不替代。
 */
export interface PlanReviewUIRequest extends ExtensionUIRequest {
  planReview: true
  /** agent 自审结论（D9③，可选 = 旧扩展不携带的降级形态：自审行不渲染） */
  selfReview?: PlanReviewRequest['selfReview']
}

/**
 * 类型检查：是否 planReview 审批请求。select 挂起期是「审批可交互」的权威信号（D5：
 * 挂起 select 是 GUI→extension 的唯一可靠交互通道），审批条「有挂起请求」判定以此为源。
 * 谓词本体委托 @taiji/ui/extension-host isPlanReviewFrame（双壳帧守卫单点，MF-1-7）。
 */
export function isPlanReviewRequest(req: ExtensionUIRequest): req is PlanReviewUIRequest {
  return isPlanReviewFrame(req)
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

function __resetExtensionBusSubscriptionForTesting(): void {
  if (busUnsub) {
    busUnsub()
    busUnsub = null
  }
  busHandlers.clear()
  if (invalidatedUnsub) {
    invalidatedUnsub()
    invalidatedUnsub = null
  }
  btwBarDrafts.clear() // 草稿分键表随测试隔离清空（模块级跨用例残留防护）
}

/** 测试后门命名空间（生产代码禁止消费，对齐 useExtensionHostBridge.__testing 先例）：
 *  模块级 bus/失效订阅与 btw 草稿表的跨用例隔离入口。 */
export const __testing = {
  __resetExtensionBusSubscriptionForTesting,
}

// ── form/planReview 通道装配（factory 单点 + 桌面分区适配 + 桌面编排钩子）────────
// 装配模块级一次（对齐冷拉 sink 的「模块级一次注册、惰性取店」纪律）：分区适配器与钩子
// 内的 store 全部事件到达时点现取（pinia 必已 active），不捕获实例（跨用例换 pinia 安全）。

/** factory FormChannelPartitions 的桌面实现（extensionUIStore 分区；retainOnly 批量单次
 *  不可变替换——store 四件套原生能力，避免逐条 remove 的响应式重算放大） */
const formPartitions: FormChannelPartitions = {
  get: (sid) => useExtensionUIStore().getRequestsBySession(sid),
  add: (sid, req) => useExtensionUIStore().addRequest(sid, req),
  remove: (sid, requestIds) => {
    const store = useExtensionUIStore()
    for (const requestId of requestIds) store.removeRequest(sid, requestId)
  },
  retainOnly: (sid, keepIds) => useExtensionUIStore().retainOnly(sid, keepIds),
}

const formChannel = createFormRequestChannel({
  partitions: formPartitions,
  adaptFrame: toExtensionUIRequest,
  // 快照补入适配：pending 帧经 runtime {...r,...r.payload} 解包即 view-ready 帧（form:true
  // 原生携带；legacy 归一已在 runtime 侧完成），补 receivedAt 缺省戳即入 store
  adaptSnapshot: (_sid, req) => ({ ...req, receivedAt: req.receivedAt ?? Date.now() }),
  // D4 审批窗口漏斗（入店）：新 planReview pending 登记到达 → 镜像同步（内含解除已应答
  // 标记语义——挂起 = 唯一交互权威、ready 优先于抑制）
  onIngested: (sid) => syncPlanReviewWindow(sid),
  onInvalidated: (sid, requestIds, removed) => {
    // D1 invalidated 锚点（form-hang-fix）：runtime 非 respond 终结（reclaimed / plan-aborted /
    // turn-aborted / session-destroyed 四类触发源）均无后续 turn 预期，pendingSend 等
    // message_start 必然空等——按帧 sid 收口。clearPendingSend 幂等，与 message_start /
    // respond 锚点并发竞争无副作用。chatStore 现取：本订阅是模块级单例、生命周期跨
    // Panel 实例（首个使用者挂上后永驻），事件到达时点 pinia 必已 active（与
    // formPartitions.get 的现取同模式），现取安全。
    useChatStore().clearPendingSend(sid)
    // D7⑤ 终结清理（失效支）：挂起终结后对应分键草稿即删（切走切回不丢 ≠ 终结后残留）
    clearBtwBarDrafts(sid, requestIds)
    // D4 审批窗口漏斗（出店）：镜像同步 + planReview 被摘除则置「已应答待帧」标记
    syncPlanReviewWindow(sid)
    if (removed.some((r) => isPlanReviewRequest(r))) usePlanStore().markPlanReviewAnswered(sid)
  },
  // 快照对账收尾：被剔除的僵尸请求（重附着/回收后 runtime 已清）对应分键草稿随之删除
  //（快照剔除 = 失效语义的同族终结点，空集幂等）+ D4 镜像按 registry 现值收口（快照剔除
  // planReview 置镜像 false 但不置已应答标记——标记触发面只有 respond 成功 / 失效帧两路）
  onSnapshotReconciled: (sid, removedIds) => {
    clearBtwBarDrafts(sid, removedIds)
    syncPlanReviewWindow(sid)
  },
  // 已终结 requestId 的应答丢弃并提示失效（D8：迟到提交不静默，toast 可见）
  onRespondExpired: (sid) => {
    const t = i18n.global.t as (key: string) => string
    useToast().error(t('extensionUI.requestExpired'), { sessionId: sid })
  },
  // 未送达（WS 非 OPEN）→ toast 提示；分区条目已由 factory 保留（M1/RD-3#1 可重试）
  onRespondUndelivered: (sid) => notifyUiResponseNotDelivered(sid),
  onRespondDelivered: (sid, target, result) => {
    // D4 审批窗口漏斗（出店）：respond 成功 = planReview 挂起被摘除的主路径——置「已应答
    // 待帧」标记（抑制 degraded/revising 到预期后态帧）+ 镜像同步（非 planReview 请求同样
    // 同步镜像，幂等）。
    syncPlanReviewWindow(sid)
    if (isPlanReviewRequest(target)) usePlanStore().markPlanReviewAnswered(sid)
    // D1 分型锚点（form-hang-fix）：cancel 型（result === null——Esc / 取消按钮 / cancel()
    // 同链）送达后 pi 无后续 turn 事件预期，pendingSend 等 message_start 必然空等（假忙
    // 窗口病灶）——送达即收口。提交型（result !== null）不清：pi 起 turn，pendingSend
    // 桥接「respond 完成 → message_start 到达」窗口并由其正常清除（现状语义，不制造
    // isActive=false 空窗）。判据严格按 result 是否 null——boolean 型按提交型处理。
    if (result === null) {
      useChatStore().clearPendingSend(sid)
    } else if (target.expectTurn === false) {
      // D1 段 5 + D2 严格双条件（result ≠ null ∧ expectTurn === false）：提交型但源声明
      // 无 turn 预期（命令 handler 内 select，message_start 永不来）→ 立即收尾，消除
      // 30s 假忙。判定必须 `=== false` 显式判定——truthy 简化（`!expectTurn`）会把
      // undefined（存量扩展/断链缺省）也当无 turn、误清 ask-user 桥接（D2 被否谱系）；
      // true / undefined → 隐式 else，桥接照旧（缺省安全）。
      useChatStore().clearPendingSend(sid)
    }
  },
})

// ── 挂起请求失效广播订阅（P2-2 失效链，模块级单订阅永驻）──
// runtime 在非 respond 路径终结挂起（abort turn / 退出 plan / 回收 / session 销毁）时
// 广播 extension:requestsInvalidated → core bridge 归一为 'requests-invalidated' 事件。
// 收到即按帧摘除（factory invalidate：先捕获摘除前条目再摘，桌面扩展段在 onInvalidated
// 钩子）：审批条/表单随之消失，消除「僵尸 ready 点击静默无效」残留。摘除按 requestId
// 精确且幂等，多实例/重复帧无副作用。
type RequestsInvalidatedEvent = Extract<InternalEvent, { kind: 'requests-invalidated' }>
let invalidatedUnsub: (() => void) | null = null

/**
 * planReview 挂起镜像同步（D4 稳定窗输入范围，store 禁 import store 的漏斗单写）：
 * 本模块是 planReview 请求入店/出店的唯一漏斗（热帧 / 冷补 / respond / 失效 / 快照修剪），
 * 每个写入点 mutation 后按 registry 现值同步一次（幂等）——setPlanReviewPending 内含
 * 「新 pending 到达解除已应答标记」语义。
 */
function syncPlanReviewWindow(sid: string): void {
  const store = useExtensionUIStore()
  const has = store.getRequestsBySession(sid).some(isPlanReviewRequest)
  usePlanStore().setPlanReviewPending(sid, has)
}

// ── 冷读路径拉取对账 pending 再入店 sink（plan-store D4③：10s 兜底冷读路径拉取的 registry 写入缝）──
// store 禁 import store：plan-store 只广播冷读路径拉取真值，registry 落店由本 sink 完成
// （呈 ready 需可枚举 requestId，respond 定位随之可用）。模块级一次注册，惰性取店
//（事件到达时点 pinia 必已 active，同 invalidated 订阅的「现取」纪律）。
let coldSinkRegistered = false
function ensurePlanReviewColdSink(): void {
  if (coldSinkRegistered) return
  coldSinkRegistered = true
  registerPlanReviewColdSink((sid, records) => {
    const store = useExtensionUIStore()
    for (const r of records) {
      store.addRequest(sid, { ...r, receivedAt: r.receivedAt ?? Date.now() })
    }
  })
}

function ensureInvalidatedSubscription(): void {
  if (invalidatedUnsub) return
  const bus = getExtensionBus()
  invalidatedUnsub = bus.on('requests-invalidated', (e: RequestsInvalidatedEvent) => {
    if (!e.sessionId) return
    // 摘除前条目捕获 / 逐条摘除 / 桌面扩展段（pendingSend 收口 + btw 草稿清理 + planReview
    // 镜像与 answered 标记）全在 factory invalidate + onInvalidated 钩子
    formChannel.invalidate(e.sessionId, e.requestIds)
  })
}

/** dialog level 白名单检查（ExtensionUIRequest.level 契约范围，三值）。 */
function isDialogLevel(value: unknown): value is 'info' | 'warn' | 'error' {
  return value === 'info' || value === 'warn' || value === 'error'
}

/** string[] 检查（options 契约范围）：数组且逐项 string。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** dialog 基础展示字段搬运（title/message/options/default/level/prefill）。
 *  DialogRequest 索引签名读原始 payload，值域 unknown，按 ExtensionUIRequest 契约
 *  运行时检查收窄（isPlanReviewRequest 同范式）：畸形值（非 string / 非 string[] /
 *  越界 level）按无值处理落缺键降级分支，不伪造类型流入渲染层。 */
function pickDialogFields(
  request: DialogRequest,
): Partial<Pick<ExtensionUIRequest, 'title' | 'message' | 'options' | 'default' | 'level' | 'prefill'>> {
  return {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(typeof request.message === 'string' ? { message: request.message } : {}),
    ...(isStringArray(request.options) ? { options: request.options } : {}),
    ...(typeof request.default === 'string' ? { default: request.default } : {}),
    ...(isDialogLevel(request.level) ? { level: request.level } : {}),
    ...(typeof request.prefill === 'string' ? { prefill: request.prefill } : {}),
  }
}

/** 统一表单扩展字段搬运（白名单漏补 = 字段静默剥离，FormOverlay 渲染拿不到问题集）；
 *  formQuestions 值域 unknown[]（isFormQuestion 检查在消费端收窄），无需断言 */
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
 * planReview 源键搬运（白名单漏补 = 字段静默剥离——selfReview 是 D9③ 派生视图链终点，漏补即
 * 「切回 session 有自审行、实时挂起无」半残形态）：planReview 标记（挂起枚举依赖）+
 * selfReview（自审结论，非 string 值不入店）。热帧（bus→toExtensionUIRequest）走本白名单，
 * 冷补（getPendingRequests 快照全量解包）不经本函数但同样携带两键——双入店路径的
 * selfReview 存在性契约测试见 use-extension-ui-plan-review.test.ts。
 */
function pickPlanFields(
  request: DialogRequest,
): Partial<Pick<PlanReviewUIRequest, 'planReview' | 'selfReview'>> {
  return {
    ...(request.planReview === true ? { planReview: true } : {}),
    ...(typeof request.selfReview === 'string' ? { selfReview: request.selfReview } : {}),
  }
}

/**
 * bus 事件 request（DialogRequest）→ ExtensionUIRequest 适配（IF3；factory adaptFrame）。
 *
 * DialogRequest 是 parseUiRequest/parseExtensionUiRequest 经 ...payload 展开构造的——
 * runtime extension.dialog 原始 payload（含 form/formQuestions/allowCancel/message/
 * options 等）保留在索引签名里（event-adapter UI_FORM_MARKER 分支 payload 标记 form:true）。
 * dialogKind 用帧判别字段（taiji 词表，可能超界如 editor）?? kind 兜底（kind 已归一
 * select/confirm/input）。
 */
function toExtensionUIRequest(sid: string, request: DialogRequest): ExtensionUIRequest {
  // receivedAt：优先采信帧携带的数值，缺失则由本层打戳（当前 runtime 广播帧不带该键，
  // 故常态恒为 Date.now()）——合并排序消费方（useBtwInteraction 确认条最早优先）的时序基准。
  const rawReceivedAt = request.receivedAt
  return {
    sessionId: sid,
    requestId: request.requestId,
    dialogKind: (request.dialogKind as ExtensionInteractMethod | undefined) ?? request.kind,
    ...pickDialogFields(request),
    ...pickFormFields(request),
    ...pickLegacyFields(request),
    // planReview 标记 + selfReview 白名单搬运（D5/D9③）：挂起枚举（currentPlanReviewRequests）
    // 依赖 planReview 标记识别审批请求，自审行渲染依赖 selfReview（见 pickPlanFields 注释）。
    ...pickPlanFields(request),
    // expectTurn 源元数据透传（form-submit-busy-convergence D1 段 4）：帧上仅显式 false 落键
    //（runtime event-adapter 条件落键），undefined 缺键 = 缺省桥接态——按帧原样透传进 store，
    // respond 分型据其三态判定；非 boolean 值不入帧（检查即透传闸）。
    ...(typeof request.expectTurn === 'boolean' ? { expectTurn: request.expectTurn } : {}),
    receivedAt: typeof rawReceivedAt === 'number' ? rawReceivedAt : Date.now(),
  }
}

export function useExtensionUI(
  sessionId: Ref<string | null>,
  filter: UIRequestFilter = formFilter,
) {
  // pending 队列 SSOT 在 store（T2 迁移）：本 composable 只订阅事件写入 store、按 filter 读 store。
  // store.addRequest 含 requestId dedup（T1），无需手写去重。
  // P2-2 失效链订阅（模块级单例；首个使用者挂上后永驻，与 store 生命周期一致）
  ensureInvalidatedSubscription()
  // 冷读路径拉取对账 pending 再入店 sink（模块级一次；plan-store D4③ 的 registry 写入缝）
  ensurePlanReviewColdSink()

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
    // C4 分流在 factory ingest（form / planReview 两标记放行——分别渲染 FormOverlay /
    // PlanReviewBar；普通 dialog 由 CompanionBand 消费 bus，shell-adapters 侧对称排除，
    // 零重叠契约），filter 是第二道闸（实例只放各自标记——store 共享，谁放行谁入队，
    // requestId dedup 兜底双实例幂等）。
    // C2：事件 sid 缺失（无 sid 的 ui-request）跳过入队（warn）——渲染范围依赖 session 分区。
    unsubFns.push(
      subscribeBus((e) => {
        const eventSid = e.sessionId
        if (!eventSid) {
          console.warn('[useExtensionUI] ui-request 事件缺少 sessionId，跳过入队:', e.request.requestId)
          return
        }
        formChannel.ingest(eventSid, e.request, filter)
      }),
    )
    // C3 保留：拉取 runtime 缓存的 pending 请求（切换 session 后重新订阅时，runtime 会推送缓存的请求）
    // 异步执行，不阻塞订阅建立。
    //
    // 快照对账算法在 factory reconcile（差集剔除主算法，设计 §6.2 采用项④ v6.1）：
    // keepIds 只含富交互帧（快照补入过滤）；**空快照也执行剔除**（清空分区）——覆盖「pi
    // 进程被 idle reaper 回收 / 会话替换后 runtime 已清 pending，而 renderer 屏上仍留僵尸
    // 表单 → 用户直接点提交 → 丢进已回收进程 = 静默失败」主路径；本路径不依赖任何阈值
    // 常量（renderer 拿不到 runtime 的 env 配置）。
    //
    // 安全性依据：快照应答与 ui-request 广播同走一条 WS 连接、按序处理——若某帧先于本应答
    // 被 renderer 处理，则它早已进 runtime pending 缓存（快照必含它）；若帧后于本应答到达，
    // 则它不在本次差集范围内，随后照常入队。
    //
    // 显式边界（已声明接受）：**未发生任何重订阅**（不切会话、不断线重连）时屏上僵尸表单仍在
    // ——本修剪只在快照落地时生效，与「未重订阅的丢帧」同族缺口（§6.2 采用项②）。
    formChannel.reconcile(sid)
  }

  subscribe(sessionId.value)
  watch(sessionId, (sid) => subscribe(sid))

  onScopeDispose(() => {
    unsubFns.forEach(fn => fn())
    unsubFns = []
  })

  // ── 分流渲染：统一表单 overlay（form 键）走 Panel inline，其余由 CompanionBand（bus 直连）──
  // 从 store 分区派生（factory 读口 → formPartitions.get → store 分区；computed 内调用
  // 建立响应式依赖，sid 变化时重算读新分区）。
  /**
   * 队列中第一个统一表单 overlay 请求（form 键，Panel inline 渲染用）；无则 undefined。
   * form 键 = 终态判定面（D5 收敛）：全部表单族帧（form / legacy askUser /
   * scheduleCreate marker）由 runtime event-adapter 分支统一产出。消费方
   *（usePanelView/Panel）按挂载源键分流 FormOverlay 的 questions / draft props。
   */
  const currentFormRequest = computed(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    return formChannel.firstFormRequest(sid)
  })

  /**
   * 挂起 planReview 审批请求列表（D5 审批条消费方）：
   * 「有挂起请求」判定 + respond 定位都按 requestId 枚举本列表——正常时序恒单条
   * （extension 单挂起），列表形态防多请求并发时的队首假设（pi 无串行保证，对齐
   * removeRequest 的 requestId 精确语义）。切 session 读不同分区，无 sid 恒空。
   */
  const currentPlanReviewRequests = computed<PlanReviewUIRequest[]>(() => {
    const sid = sessionId.value
    if (!sid) return []
    return formChannel.planReviewRequests(sid)
  })

  /**
   * 用户回复指定请求（按 requestId 精确定位，不假设队首）——sid 守卫包装在
   * bindSessionFormActions（双壳同构装配段收敛单点，见 ui form-request-channel）。
   *
   * 回传核心流（定位 → sendExtensionUIResponse → 未送达保留 store 请求可重试——
   * M1/RD-3#1：断连期点确认＝应答丢失、弹窗消失、pi 侧 Promise 永挂；送达即出队）在
   * factory respond；呈现钩子（toast 失效提示 / 未送达 toast / planReview answered /
   * pendingSend 分型收口）在上方 formChannel 装配段。
   *
   * 返回值（D8 提交回路契约，btw-question M3-c）：true = 应答已送达并出队；false =
   * 未送达（保持挂起可重试——「重试仅限投递失败态」）或请求已终结（应答丢弃 + 提示
   * 失效，不静默）。消费方（btw 内联确认条）据此决定待处理簿记是否随应答解除。
   */
  const actions = bindSessionFormActions(formChannel, () => sessionId.value)

  return {
    currentFormRequest,
    currentPlanReviewRequests,
    respond: actions.respond,
    cancel: actions.cancel,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// btw 内联确认条草稿分键表（D7⑤ 提交态 per-line 隔离的模块级载体）——确认条编排本体
// （D8 降级路径：请求合并排序 / 降档表单 / 提交回路）在 panel/useBtwInteraction.ts，
// 本模块只承载草稿状态本体：终结清理入口挂在本模块失效链（invalidated 订阅）与
// 快照差集修剪（retainOnly diff）两路，故状态留此与挂起请求生命周期同文件管理。
// ─────────────────────────────────────────────────────────────────────────────

/** 确认条草稿（四组提交态）——按 `${sessionId}:${requestId}` 分键保存（D7⑤ per-line/表单实例双隔离） */
export type BtwBarDraft = { sel: Record<string, string[]>; text: Record<string, string>; planComment: string; dialogSelect: string; dialogText: string }

export const emptyBtwBarDraft = (): BtwBarDraft => ({ sel: {}, text: {}, planComment: '', dialogSelect: '', dialogText: '' })

// taste:allow-no-data-owner W24-EX（btw-question M3-c 行内豁免，登记表⑧已落定（2026-09-22，阶段 3 审查 U2 修复随批）——EX-A：`btwBarDrafts` 分键草稿 Map，D7⑤ 挂起表单提交态 per-line 隔离的持久草稿本体）：
// 确认条草稿分键表（用户输入暂存、终结即删，非 GUI 数据本体；D7⑤ 切走切回不丢的模块级载体）
export const btwBarDrafts = reactive(new Map<string, BtwBarDraft>())

/** 终结清理：应答送达 / 失效 / 快照修剪三支共用（幂等） */
export function clearBtwBarDrafts(sessionId: string, requestIds: readonly string[]): void { for (const rid of requestIds) btwBarDrafts.delete(`${sessionId}:${rid}`) }
