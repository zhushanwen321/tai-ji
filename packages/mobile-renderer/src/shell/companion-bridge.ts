// companion-bridge —— 移动壳 companion 区（CompanionBand）的数据源与回传装配
// （remote-use-mobile D7（移动壳 v1 功能集裁定）「ask-user 提问答复 ✅」行的壳侧拉通）+
// 权限审批通道（同表「权限审批 ✅ 手机可批」行的壳侧拉通）+ form/planReview 类请求通道
// （同表 form 行恢复任务：统一表单与 plan 审批的移动壳消费面，消除「请求方无限等待」）。
//
// 对话桥翻译层（WS source 适配 + dialog source/transport 工厂 + requestId 反查表）已下沉
// @taiji/ui/extension-host shell-adapters（双壳逐字节共享，含 [G1] 反查表泄漏语义文档）；
// 权限审批编排状态机（bus 订阅 + 畸形事件守卫 + expired 撤窗 + transport 回传 +
// BM3/D3 语义）已下沉同包 createPermissionRequestController（双壳共享，单测在同包
// __tests__/）。本模块只做移动壳裁决：
// - 简单 dialog 走 CompanionBand（C4 门固定排除面之内）；form/planReview 类请求被同一 C4
//   门排除出 CompanionBand，由本模块 form 通道承接（MobileFormCard 渲染 + 作答回传），
//   通道算法（C4 放行面 form ∨ planReview + requestId dedup + per-session Map 分区 +
//   requests-invalidated 失效摘除 + getPendingRequests 快照对账）在
//   @taiji/ui/extension-host createFormRequestChannel 单点（桌面 useExtensionUI 同 factory）；
// - bus 模块级私有单例（桌面走 getExtensionBus 惰性单例，来源选择是壳裁决）；
// - 壳层能力回调按移动壳形态注入（remote-use A11/U14）：onPiResponseSettled 不注入
//   （空操作，对齐「移动壳无 pendingSend 链」）；notifyNotDelivered 注入错误条提示
//   （移动壳无分级 toast 组件，错误条即 toast 契约呈现通道——见 ./error-bar；form 通道
//   另有 respond 返回 false → App 置 MobileFormCard 内联错误行的同源反馈）；
//   onSessionError/onGlobalError 错误回调居本模块（bootstrap effects
//   注入消费，见下方「全局错误条」段），错误条状态单例居 ./error-bar（与 app-runtime
//   core toast 通道共用同一出口）；
// - 权限/对话/form 三通道均模块级装配（bus 单例私居本模块；ESM 单次求值，listener 不会
//   翻倍），App.vue provide + 挂 CompanionBand / PermissionRequestDialog / MobileFormCard。
//
// 回传走 core 既有通路（不新造协议）：pi 源 extension.ui_response（sendExtensionUIResponse）、
// plugin 源 plugin.uiResponse（ws send）、审批源 plugin.approvePermissions/denyPermissions。
import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { InternalEventBus, MessageBusBridge } from '@taiji/core/extension-host'
import type { ExtensionInteractMethod } from '@taiji/shared'
import {
  bindSessionFormActions,
  createCompanionDialogAdapters,
  createFormRequestChannel,
  createPermissionRequestController,
  createWsPluginMessageSource,
  type FormChannelPartitions,
} from '@taiji/ui/extension-host'
import type { DialogRequestQueue, PermissionTransport, PermissionRequestState } from '@taiji/ui/extension-host'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { chatStore } from './app-runtime'
import { showErrorBar, __testing as errorBarTesting } from './error-bar'
import { i18n } from '../i18n'

// vue-i18n 的 t 复杂重载收窄为 (key, params?) => string（对齐 app-runtime 同款收窄）
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

// ── bus + bridge 单例（模块级；dialog 反查表由共享 factory 单点持有，见 shell-adapters）──

const bus = new InternalEventBus()
const bridge = new MessageBusBridge({ source: createWsPluginMessageSource(), bus })
void bridge // 构造即 subscribe；持有引用防误判可回收（dispose 在移动壳生命周期内不发生）

/**
 * 测试后门命名空间（生产代码禁止消费，对齐桌面壳 useExtensionHostBridge.__testing 先例）：
 * permission 链测试的 bus emit 入口（生产订阅面 = 下方 dialog/permission/form 三通道）
 * 与 form 通道跨用例隔离入口。
 */
export const __testing = {
  mobileExtensionBus: bus,
  /** form 通道跨用例隔离：清空 per-session 分区（模块级 Map，防请求残留泄漏到后续用例） */
  resetFormRequestsForTest(): void {
    formRequestsBySid.clear()
  },
  /** 错误条跨用例隔离：清空单槽文本（error-bar 模块级单例 ref，防错误残留泄漏到后续用例） */
  resetErrorBarForTest(): void {
    errorBarTesting.resetErrorBarForTest()
  },
  /** exited 重置通路跨用例隔离：清空 dialog queue 句柄（模块级 let，防句柄残留跨用例串扰） */
  resetDialogQueueHandleForTest(): void {
    dialogQueueHandle = null
  },
}

// ── 全局错误条 + effects 错误回调（remote-use A7/U14；D5 去留表：错误条是 V5/V18
// 作答失败反馈的唯一载体）──
//
// 状态承载 = ./error-bar 模块级单例（ref 单槽——与 app-runtime core toast 通道共用的
// 单点出口，core 失败面文案经 toast 注入直入本槽）；views/ErrorBar.vue 纯展示消费
// （依赖方向 views → shell，与 App 消费 shell 状态同向），挂载与 effects 注入
// 在 bootstrap/App（U6 接线）。单槽覆盖式 + 手动关闭（ErrorBar 关闭钮），不加自动消失
// timer（时间平抑类逻辑红线）；onSessionError 的持久反馈在流内（markSessionError 追加
// error 消息），错误条只是瞬态置顶补充——后到错误覆盖前条不丢持久反馈。

/**
 * onSessionError（A7，对齐桌面 handleSessionError）：带 sessionId 的 error envelope 兜底——
 * markSessionError（session 级错误统一入口：追加 error assistant 消息 + finalize）进对话流，
 * 错误条置顶保证切走的 session 也可感知。
 */
function handleSessionError(sessionId: string, payload: { code?: string; message?: string }): void {
  const text = t('connection.sessionRequestFailed', { message: payload.message ?? 'Unknown error' })
  chatStore.markSessionError(sessionId, text)
  showErrorBar(text)
}

/** onGlobalError（A7）：无 sessionId 无 id 的 server-push error 直显错误条（桌面 toast 的移动形态）。 */
function handleGlobalError(message: string): void {
  showErrorBar(message)
}

/**
 * dialog 作答未送达提示（A11，注入 createCompanionDialogAdapters.notifyNotDelivered——对齐
 * 桌面 useExtensionHostBridge 注入形态）：移动壳无分级 toast 组件，呈现用内联错误行范式
 * 落错误条（对齐 form 通道 respondFailedId 的 role=alert 细行）。请求保留可重试语义由
 * shell-adapters 承接（respond 见 false 不出队，连接恢复后同 requestId 重发幂等）。
 */
function notifyDialogResponseNotDelivered(_sessionId?: string): void {
  showErrorBar(t('mobile.errorBar.responseNotDelivered'))
}

/** bootstrap effects 注入面（U6 接线：`effects: { ...errorBarEffects, ... }`），签名对齐 core InboundEffects */
export const errorBarEffects = {
  onSessionError: handleSessionError,
  onGlobalError: handleGlobalError,
}

// companion 数据源/回传对（App.vue provide 消费；G1 反查表泄漏语义两壳同持，见 shell-adapters）
const companionDialog = createCompanionDialogAdapters(bus, {
  notifyNotDelivered: notifyDialogResponseNotDelivered,
})
export const mobileDialogRequestSource = companionDialog.source
export const mobileUiResponseTransport = companionDialog.transport
// errorBarMessage/dismissErrorBar 消费点（ErrorBar.vue）改从 ./error-bar 直接 import——
// 状态单例归属该模块，本模块不再中转 re-export

// ── permissionRequest 审批通道（remote-use-mobile D7（移动壳 v1 功能集裁定）「权限审批 ✅ 手机可批」行，App 挂 PermissionRequestDialog）──
//
// 状态机本体在 @taiji/ui/extension-host createPermissionRequestController（双壳共享，
// 桌面 usePermissionRequest.ts 是同一 factory 的薄接线）；本模块只做移动壳装配：
// 模块级 controller（bus 单例私居本模块，ESM 单次求值），App.vue provide transport +
// 挂 PermissionRequestDialog，useMobilePermissionRequest 取弹窗状态。

const permissionController = createPermissionRequestController(bus)

/** 审批回传通道（permission-transport 契约的 factory 产出，App.vue provide 消费） */
export const mobilePermissionTransport: PermissionTransport = permissionController.transport

/** 取审批弹窗状态（App.vue setup 消费，template 绑定 Dialog props；同一 reactive 单例） */
export function useMobilePermissionRequest(): PermissionRequestState {
  return permissionController.state
}

// ── form/planReview 类请求通道（remote-use-mobile D7（移动壳 v1 功能集裁定）form 行恢复：统一表单 + plan 审批的移动壳消费面）──
//
// 通道算法（C4 富交互门 / 快照对账差集剔除 / 失效摘除 / respond 未送达保留-送达摘除 /
// 队首读口）已下沉 @taiji/ui/extension-host createFormRequestChannel（双壳单点，桌面
// useExtensionUI 是同 factory 的 pinia store 分区实现）；本模块只做移动壳装配：
// - 模块级 reactive Map 分区适配（factory FormChannelPartitions 接口的移动实现——移动壳无
//   pinia，ADR-0049 per-session Map 范式；桌面 extensionUIStore 是同接口的另一实现）；
// - 订阅永驻模块级（不随视图挂载/卸载）——切 tab / 切 session 期间到达的请求照常入分区，
//   视图按 activeSessionId 派生渲染；快照对账由 useMobileFormRequests 在 sid 变化与连接
//   恢复边沿两处触发（factory reconcile）；
// - 无 sid 的 ui-request 跳过（C2；同帧 dialog 通道已 warn，此处不重复告警）；
// - 撤窗语义：pi 源无超时撤窗广播，失效链 requests-invalidated（turn abort / session 销毁
//   等非 respond 终结）按 requestId 摘除（factory invalidate）；plugin 源 form 类帧不消费
//   expired 广播（shell-adapters 反查表只在 dialog 投递流写入，C4 排除帧不落表 → miss
//   noop）。

/**
 * per-session form/planReview 请求分区（requestId 全局唯一，跨分区无重叠）。
 * 登记表主表 #53（声明处 @data-owner #53）——runtime 双源（bus ui-request 实时帧 +
 * getPendingRequests 快照）的消费副本，写口经 formPartitions 适配器封闭于本模块，
 * 清理点 = registerSessionCleanup（删除）+ resetCompanionChannelsForExitedSession
 * （exited 分通道重置）+ clearAllFormRequests（runtime-unavailable 断连收口）。
 */
// @data-owner #53 —— 主表 #53 mobile 壳 form/planReview 挂起请求分区（消费副本）
const formRequestsBySid = reactive(new Map<string, ExtensionUIRequest[]>())

/** factory FormChannelPartitions 的移动实现（reactive Map 读写全经本适配器；add 带
 *  requestId dedup——实时帧 + 快照补入双源幂等） */
const formPartitions: FormChannelPartitions = {
  get: (sid) => formRequestsBySid.get(sid) ?? [],
  add: (sid, req) => {
    const list = formRequestsBySid.get(sid) ?? []
    if (list.some((r) => r.requestId === req.requestId)) return
    formRequestsBySid.set(sid, [...list, req])
  },
  remove: (sid, requestIds) => {
    const list = formRequestsBySid.get(sid)
    if (!list) return
    const ids = new Set(requestIds)
    const next = list.filter((r) => !ids.has(r.requestId))
    if (next.length === list.length) return
    if (next.length === 0) formRequestsBySid.delete(sid)
    else formRequestsBySid.set(sid, next)
  },
}

/**
 * form 帧的公共读取面：bus ui-request 的 request（core DialogRequest，marker 键由索引签名
 * 承载）与 getPendingRequests 快照条目（runtime {...r,...r.payload} 解包的 ExtensionUIRequest）
 * 的结构交集——适配器两源共用，零断言转换。
 */
type FormFrameSource = {
  requestId: string
  method?: unknown
  kind?: unknown
  message?: unknown
  form?: unknown
  formQuestions?: unknown
  allowCancel?: unknown
  scheduleCreate?: unknown
  scheduleDraft?: unknown
  planReview?: unknown
  selfReview?: unknown
}

/** 帧 → ExtensionUIRequest 适配（桌面 toExtensionUIRequest 的移动消费面子集：
 *  只搬运本通道渲染/回传消费的字段，白名单外的载荷键不进分区） */
function toMobileFormRequest(sid: string, request: FormFrameSource): ExtensionUIRequest {
  return {
    sessionId: sid,
    requestId: request.requestId,
    dialogKind: ((typeof request.method === 'string' ? request.method : request.kind) ?? 'input') as ExtensionInteractMethod,
    ...(typeof request.message === 'string' ? { message: request.message } : {}),
    ...(request.form !== undefined ? { form: request.form as true } : {}),
    ...(request.formQuestions !== undefined ? { formQuestions: request.formQuestions as unknown[] } : {}),
    ...(request.allowCancel !== undefined ? { allowCancel: request.allowCancel as boolean } : {}),
    ...(request.scheduleCreate !== undefined ? { scheduleCreate: request.scheduleCreate as boolean } : {}),
    ...(request.scheduleDraft !== undefined ? { scheduleDraft: request.scheduleDraft } : {}),
    ...(request.planReview === true ? { planReview: true } : {}),
    ...(typeof request.selfReview === 'string' ? { selfReview: request.selfReview } : {}),
  }
}

// 通道装配（算法在 factory；呈现类钩子居本模块——错误条/诊断留痕是移动壳裁决）
const formChannel = createFormRequestChannel({
  partitions: formPartitions,
  // 热帧与快照帧同一适配器（FormFrameSource 是两源结构交集，见上）
  adaptFrame: toMobileFormRequest,
  adaptSnapshot: toMobileFormRequest,
  onRespondExpired: (_sid, requestId) => {
    // 已终结 requestId 的应答丢弃并留痕（诊断留痕，不占错误条单槽——单槽留给 core 失败面）
    console.warn('[companion-bridge] form response dropped (request no longer pending):', requestId)
  },
  onRespondUndelivered: (_sid, requestId) => {
    // 未送达：分区条目保留（factory 语义），连接恢复后同 requestId 重发幂等（M1/RD-3#1）
    console.warn('[companion-bridge] form response not delivered (WS closed), kept for retry:', requestId)
  },
})

// 永驻订阅（模块级单次注册）：C4 门在 factory ingest 内（form ∨ planReview 放行）
void bus.on('ui-request', (e) => {
  if (!e.sessionId) return
  formChannel.ingest(e.sessionId, e.request)
})
void bus.on('requests-invalidated', (e) => {
  if (!e.sessionId) return
  formChannel.invalidate(e.sessionId, e.requestIds)
})

// ── session.exited 分通道重置编排（remote-use U6 / D5 exited 分区清理段 + 「exited 清理与
//    拦截解绑」段）──
//
// exited 的壳扩展清理 = 两通道具名重置（M8 防御：死会话残留 dialog/form 请求不重弹、
// 作答不再发给新进程后石沉大海，V18），语义对齐桌面 extensionUIStore.clearSession 的
// exited 具名清理形态。**禁走 triggerSessionCleanups**（销毁语义）：它把 sid 记入
// deletedSids 迟到写拦截，崩溃恢复窗口内该会话的新 dialog 请求会被 updateFor 首行静默
// 丢弃（发起方无限等待，G3 失效）——exited ≠ 删除，清理与拦截必须解绑。删除路径
// （U12）才走销毁语义注册表。
//
// dialog 通道载体 = CompanionBand setup 内创建的组件私有 queue 实例（MF-5：queue 须在
// 组件 setup 顶层创建），bootstrap 的 effects 回调无现成通道拿实例——经
// DIALOG_QUEUE_HANDLE_KEY provide/inject 登记回调回传（App.vue provide，ui 定义 key），
// 本模块持句柄、exited 编排经下方出口调 resetFor。

/** dialog 通道 queue 句柄（CompanionBand mount 后经登记回调写入） */
let dialogQueueHandle: DialogRequestQueue | null = null

/** queue 句柄登记入口（App.vue provide DIALOG_QUEUE_HANDLE_KEY 消费；重复登记覆盖——
 * CompanionBand 移动壳单实例挂载，正常时序仅一次） */
export function registerDialogQueueHandle(queue: DialogRequestQueue): void {
  dialogQueueHandle = queue
}

/** form 通道具名清理（直调 Map.delete，幂等；不触注册表广播） */
function clearFormRequestsForSession(sid: string): void {
  formRequestsBySid.delete(sid)
}

/**
 * form/planReview 分区全局清空（bootstrap onRuntimeUnavailable 断连收口消费）：对齐桌面
 * useMessageEffects.handleRuntimeUnavailable 的 extensionUI clearAllPending——runtime 崩溃
 * / 重启用尽后 runtime pending 内存表已清零，移动壳分区若保留条目，屏上僵尸 form 卡在
 * WS 重连窗口内提交即假成功（旧 runtime 对已终结 requestId 静默忽略，请求方空等）。
 * reactive Map 整表替换，派生视图（currentFormRequest 等）自动清空。dialog 通道 queue
 * 两壳一致不清（dialog 另有确认条重试形态，对齐桌面 clearAllPending 只清 extensionUI
 * 分区的范围），本出口不扩范围。
 */
export function clearAllFormRequests(): void {
  formRequestsBySid.clear()
}

// [remote-use U12] form 分区删除路径注册（销毁语义）：session 永久删除时经删除编排
// （deleteSession → core triggerSessionCleanups）清分区——已删会话的残留请求不再可作答
// （M8 防御）。与 exited 分通道重置（resetCompanionChannelsForExitedSession，重置语义）
// 是两份独立清单，语义分界见设计 D5「exited 清理与拦截解绑」段：exited 不走本注册
// （deletedSids 迟到写拦截会吞恢复期新请求）；新增请求类 per-session 通道须两处各登记一条
// （exited 分通道重置 + 本注册表），D9② 白名单登记该扩展义务。
registerSessionCleanup(clearFormRequestsForSession)

/**
 * exited 分通道重置出口（bootstrap onSessionExited 壳扩展段消费）：dialog resetFor +
 * form 具名清理。句柄未登记（exited 早于 CompanionBand 挂载）跳过 dialog 通道——exited
 * 只达已订阅连接、订阅建立必晚于挂载，实际不达（设计 U6 resetFor 句柄通路段）。
 */
export function resetCompanionChannelsForExitedSession(sid: string): void {
  dialogQueueHandle?.resetFor(sid)
  clearFormRequestsForSession(sid)
}

export type MobileFormRequests = {
  /** 队首 form 类请求（form 帧 / legacy 归一帧；factory firstFormRequest 读口派生） */
  currentFormRequest: ComputedRef<ExtensionUIRequest | undefined>
  /** 队首 planReview 审批请求（桌面 PlanReviewBar 消费面的移动形态） */
  currentPlanReviewRequest: ComputedRef<PlanReviewFrameForView | undefined>
  /**
   * 作答回传（factory respond 核心流）：result 经 sendExtensionUIResponse（method 透传），
   * 未送达（WS 非 OPEN）保留请求可重试（M1/RD-3#1），送达即出分区。请求已终结
   * （失效/已应答）→ 迟到应答丢弃 + console 留痕（诊断留痕，不占错误条单槽）。返回值 =
   * 是否送达，App 编排消费（false → MobileFormCard 内联错误行，回传失败不静默）。
   */
  respond(requestId: string, result: boolean | string | null): boolean
  /** 取消（等价 respond(requestId, null)） */
  cancel(requestId: string): void
  /**
   * 快照对账立即执行（App.vue watch(isConnected) connected 边沿消费）：静默重连保持
   * 视图挂载、sessionId 不变，断连期间到达的 form/planReview 请求经此补挂、已终结的
   * 经此剔除；sid 为空跳过（无会话分区可对账）。
   */
  reconcileNow(): void
}

/** 视图消费的 planReview 帧窄化面（requestId + 守卫搬运的 selfReview） */
export type PlanReviewFrameForView = {
  requestId: string
  selfReview?: string
}

/**
 * form/planReview 通道的会话视图（App.vue 聊天视图编排消费）：
 * - 按 activeSessionId 派生队首请求（无 sid 恒空，分区隔离；切 session 读不同分区）；
 * - 快照对账（factory reconcile：差集剔除 + 富交互帧补入，空快照也剔除）两处触发：
 *   sid 变化（本模块 watch）+ 连接恢复边沿（App.vue watch(isConnected) connected 边沿调
 *   reconcileNow——静默重连保持视图挂载、sid 不变，断连期间到达的请求经此补挂 / 已终结
 *   的经此剔除）；模块级实时订阅保证不漏帧，快照是权威对账面。
 */
export function useMobileFormRequests(sessionId: Ref<string | null>): MobileFormRequests {
  const currentFormRequest = computed<ExtensionUIRequest | undefined>(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    return formChannel.firstFormRequest(sid)
  })

  const currentPlanReviewRequest = computed<PlanReviewFrameForView | undefined>(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    const found = formChannel.planReviewRequests(sid)[0]
    return found ? { requestId: found.requestId, ...(found.selfReview !== undefined ? { selfReview: found.selfReview } : {}) } : undefined
  })

  watch(sessionId, (sid) => {
    if (sid) formChannel.reconcile(sid)
  }, { immediate: true })

  // 回传/取消/对账的 sid 守卫包装收敛 bindSessionFormActions（双壳同构装配段单点，见 ui
  // form-request-channel）：回传核心流（定位 / 未送达保留 / 送达摘除）与呈现钩子（已终结
  // 留痕 / 未送达留痕）在 factory + 上方 formChannel 装配段。respond 返回值 = 是否送达，
  // App 编排消费（false → MobileFormCard 内联错误行，回传失败不静默）；reconcileNow =
  // 连接恢复边沿的对账入口（App.vue watch(isConnected) 消费，sid 为空跳过）。
  const actions = bindSessionFormActions(formChannel, () => sessionId.value)

  return { currentFormRequest, currentPlanReviewRequest, respond: actions.respond, cancel: actions.cancel, reconcileNow: actions.reconcile }
}
