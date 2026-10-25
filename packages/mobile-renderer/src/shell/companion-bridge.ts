// companion-bridge —— 移动壳 companion 区（待回答/待授权体系）的数据源与回传装配
// （remote-use-mobile D7「ask-user 提问答复 ✅」行的壳侧拉通）+ 权限审批通道（同表
// 「权限审批 ✅ 手机可批」行）+ form/planReview/dialog 三类请求通道（v2 §6.5 三通道
// Sheet 化：呈现统一走 FormSheet/PermissionSheet，本模块是数据源与回传的单一装配点）。
//
// 对话桥翻译层（WS source 适配 + dialog source/transport 工厂 + requestId 反查表）已下沉
// @taiji/ui/extension-host shell-adapters（双壳逐字节共享，含 [G1] 反查表泄漏语义文档）；
// 权限审批编排状态机（bus 订阅 + 畸形事件检查 + expired 撤窗 + transport 回传 +
// BM3/D3 语义）已下沉同包 createPermissionRequestController（双壳共享，单测在同包
// __tests__/）。本模块只做移动壳裁决：
// - dialog 通道宿主居本模块（v2 呈现出口改造：v1 queue 宿主 = CompanionBand setup，
//   MF-5 句柄回传机制随该呈现退役——模块级 effectScope 包裹创建，订阅永驻与 form 通道
//   同款，切 session 按分区隔离读口；App.vue 不再 provide DIALOG_QUEUE_HANDLE_KEY）；
// - form/planReview 类请求由 form 通道承接（C4 门排除出 dialog 通道），通道算法
//   （C4 放行面 form ∨ planReview + requestId dedup + per-session Map 分区 +
//   requests-invalidated 失效摘除 + getPendingRequests 快照对账）在
//   @taiji/ui/extension-host createFormRequestChannel 单点（桌面 useExtensionUI 同 factory）；
// - bus 模块级私有单例（桌面走 getExtensionBus 惰性单例，来源选择是壳裁决）；
// - 壳层能力回调按移动壳形态注入（remote-use A11/U14）：onPiResponseSettled 不注入
//   （空操作，对齐「移动壳无 pendingSend 链」）；notifyNotDelivered 注入错误条提示
//   （移动壳无分级 toast 组件，错误条即 toast 契约呈现通道——见 ./error-bar）；form 通道
//   另有 respond 返回 false → FormSheet 内联错误行的同源反馈；
//   onSessionError/onGlobalError 错误回调居本模块（bootstrap effects
//   注入消费，见下方「全局错误条」段），错误条状态单例居 ./error-bar（与 app-runtime
//   core toast 通道共用同一出口）；
// - 权限/对话/form 三通道均模块级装配（bus 单例私居本模块；ESM 单次求值，listener 不会
//   翻倍），App.vue 按 sheet-manager activeSheet 槽位挂 FormSheet/PermissionSheet（§6.5）；
// - 断连语义 §6.23（A 级，时间平抑类清空形态退役）：onRuntimeUnavailable 按 reason 分流
//   ——disconnect 不清分区（重连后 reconcile 对账收敛）；restart 保留分区 + 提交挂起
//   （suspendFormSubmissions，重连对账完成经 onSnapshotReconciled 恢复），封住「旧
//   runtime 对已终结 requestId 静默忽略、UI 记为已提交」的假成功窗口；
// - 请求失效呈现联动（§6.4/§7.1）：requests-invalidated / plugin:uiRequestExpired 命中
//   当前呈现请求 → 关闭活动 Sheet + 原因提示（不把已失效请求提交成成功）；
//   plugin:permissionRequestExpired 命中当前审批请求 → 仅原因提示（Sheet 收层由 App
//   pending watch 权威处理，收层与提示解耦——A7 缺陷修复，见下方过期订阅段）。
//
// 回传走 core 既有通路（不新造协议）：pi 源 extension.ui_response（sendExtensionUIResponse）、
// plugin 源 plugin.uiResponse（ws send）、审批源 plugin.approvePermissions/denyPermissions。
import { computed, effectScope, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import { InternalEventBus, MessageBusBridge } from '@taiji/core/extension-host'
import { onGlobal } from '@taiji/core/transport/api'
import type { ExtensionInteractMethod } from '@taiji/shared'
import {
  bindSessionFormActions,
  createCompanionDialogAdapters,
  createDialogRequestQueue,
  createFormRequestChannel,
  createPermissionRequestController,
  createWsPluginMessageSource,
  type FormChannelPartitions,
} from '@taiji/ui/extension-host'
import type { DialogRequest, DialogRequestQueue, PermissionTransport, PermissionRequestState } from '@taiji/ui/extension-host'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { activeSessionId, chatStore, sessionList } from './app-runtime'
import { activeSheet, closeSheet } from './sheet-manager'
import { registerOverlayPendingReader } from './sessions-runtime'
import { showErrorBar, __testing as errorBarTesting } from './error-bar'
import { summarizePendingTodos, type PendingTodoSummary } from '../features/pending-todos'
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
  /** §6.23 提交挂起态跨用例隔离：复位挂起标志（模块级单例 ref） */
  resetFormSubmitSuspensionForTest(): void {
    formSubmitSuspended.value = false
  },
  /** dialog queue 句柄（测试跨用例隔离：调用方对自用 sid 调 mobileDialogQueue.resetFor；
   * getter 惰性求值——__testing 对象字面量先于 queue 声明初始化，直引字段会 TDZ） */
  get mobileDialogQueue() {
    return mobileDialogQueue
  },
}

// ── 全局错误条 + effects 错误回调（remote-use A7/U14；D5 去留表：错误条是 V5/V18
// 作答失败反馈的唯一载体）──
//
// 状态承载 = ./error-bar 模块级单例（ref 单槽——与 app-runtime core toast 通道共用的
// 单点出口，core 失败情形文案经 toast 注入直入本槽）；views/ErrorBar.vue 纯展示消费
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

/** bootstrap effects 注入点（U6 接线：`effects: { ...errorBarEffects, ... }`），签名对齐 core InboundEffects */
export const errorBarEffects = {
  onSessionError: handleSessionError,
  onGlobalError: handleGlobalError,
}

// companion 数据源/回传对（G1 反查表泄漏语义两壳同持，见 shell-adapters）
const companionDialog = createCompanionDialogAdapters(bus, {
  notifyNotDelivered: notifyDialogResponseNotDelivered,
})
export const mobileDialogRequestSource = companionDialog.source
export const mobileUiResponseTransport = companionDialog.transport
// errorBarMessage/dismissErrorBar 消费点（ErrorBar.vue）改从 ./error-bar 直接 import——
// 状态单例归属该模块，本模块不再中转 re-export

// ── dialog 通道 queue（v2 呈现出口改造：宿主自 CompanionBand setup 迁本模块）────────
//
// v1 形态：queue 在 CompanionBand setup 顶层创建（MF-5：onScopeDispose 依赖 active effect
// scope），经 DIALOG_QUEUE_HANDLE_KEY provide/inject 回传句柄供 exited 编排调 resetFor。
// v2 §6.5 三通道 Sheet 化后 CompanionBand 呈现退役，FormSheet 承接 dialog 四型渲染——
// queue 宿主随数据源归本模块：模块级 effectScope 包裹创建（scope 永不 stop = 订阅永驻，
// 与 form 通道「订阅不随视图挂载/卸载」同一形态；effectScope 同时让 queue 内部的
// onScopeDispose 有合法落点，不产生无 scope 警告）。切 session 读口隔离由 queue 内部的
// per-session Map 分区承接（sessionIdRef = app-runtime activeSessionId）。
// registerDialogQueueHandle 机制退役：句柄模块级直持，exited 编排直接调（App.vue 不再
// provide 注入键）。

/** dialog 通道 queue 单例（effectScope 包裹：queue 内部 useSessionScopedState/onScopeDispose 的合法 scope） */
const dialogChannelScope = effectScope()
export const mobileDialogQueue: DialogRequestQueue = dialogChannelScope.run(() =>
  createDialogRequestQueue(mobileUiResponseTransport, activeSessionId, mobileDialogRequestSource),
)!

// ── permissionRequest 审批通道（remote-use-mobile D7（移动壳 v1 功能集裁定）「权限审批 ✅ 手机可批」行，App 挂 PermissionRequestDialog）──
//
// 状态机本体在 @taiji/ui/extension-host createPermissionRequestController（双壳共享，
// 桌面 usePermissionRequest.ts 是同一 factory 的薄接线）；本模块只做移动壳装配：
// 模块级 controller（bus 单例私居本模块，ESM 单次求值），App.vue provide transport +
// 挂 PermissionRequestDialog，useMobilePermissionRequest 取弹窗状态。

const permissionController = createPermissionRequestController(bus)

/** 审批回传通道（permission-transport 契约的 factory 产出，App.vue provide 消费） */
export const mobilePermissionTransport: PermissionTransport = permissionController.transport

/** 取审批弹窗状态（App.vue setup 消费，PermissionSheet props 绑定；同一 reactive 单例） */
export function useMobilePermissionRequest(): PermissionRequestState {
  return permissionController.state
}

// ── 请求失效呈现联动（§6.4/§7.1）：plugin 域两过期事件的 Sheet 关闭挂点 ────────────
// 状态机权威在 controller / dialog queue（各自出队/撤窗）；本订阅只做呈现联动——过期
// 命中「正在呈现」的请求时关闭活动 Sheet + 原因提示（不把过期请求提交成成功）。
// requestIds/requestId 匹配判定与 controller 同构（requestId 精确 → 缺失回退 pluginId）。

/** 当前呈现中的 dialog 请求（form 槽打开时 FormSheet 的 dialog 分支渲染面） */
function presentedDialogRequestId(): string | undefined {
  if (activeSheet.value !== 'form') return undefined
  return mobileDialogQueue.currentRequest.value?.requestId
}

// plugin:uiRequestExpired（plugin 源 dialog 30min 撤窗）：呈现中请求命中 → 关 Sheet + 提示。
// queue 出队由 source.onUiRequestExpired 独立消费（反查表路由），此处只管呈现。
void onGlobal((msg) => {
  if (msg.type !== 'plugin:uiRequestExpired') return
  const payload = msg.payload as { requestId?: unknown }
  const expiredId = typeof payload.requestId === 'string' ? payload.requestId : undefined
  if (expiredId === undefined) return
  if (presentedDialogRequestId() === expiredId) {
    closeSheet()
    showErrorBar(t('mobile.sheet.requestExpired'))
  }
})

// plugin:permissionRequestExpired（plugin 权限审批撤窗）：命中当前审批请求 → 原因提示。
// 呈现时序契约（A7 缺陷修复）：controller 的 expired 订阅注册在先，同一同步 emit 链内
// pending 已翻 false（requestId/pluginId 保留不清），故匹配判定**不得**以 pending 或
// activeSheet 为前置——两者都依赖「事件到达时弹窗还开着」的时序，而收层（App pending
// watch）与提示（本订阅）分属同步链与微任务两个时机，前置守卫会把提示恒吞掉。分式：
// - Sheet 收层 = App.vue watch(permission.pending) 权威处理（自带 activeSheet==='permission'
//   guard，用户正在其他 Sheet 操作时不误关）；
// - 本订阅只做原因提示（错误条单槽，route 态无关常驻）。
// 回退分支（payload 缺 requestId 的旧版广播）以 requestId 非空为「壳确曾观测到审批请求」
// 判据——state 零值（壳重启后陈旧广播）不误报。
void onGlobal((msg) => {
  if (msg.type !== 'plugin:permissionRequestExpired') return
  const payload = msg.payload as { pluginId?: unknown; requestId?: unknown }
  const s = permissionController.state
  const expiredRequestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const matches = expiredRequestId !== ''
    ? s.requestId === expiredRequestId
    : s.requestId !== '' && typeof payload.pluginId === 'string' && s.pluginId === payload.pluginId
  if (matches) {
    showErrorBar(t('mobile.sheet.requestExpired'))
  }
})

// ── form/planReview 类请求通道（remote-use-mobile D7（移动壳 v1 功能集裁定）form 行恢复：统一表单 + plan 审批的移动壳消费方）──
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
 * （exited 分通道重置）。
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
 * form 帧的公共读侧：bus ui-request 的 request（core DialogRequest，marker 键由索引签名
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

/** 帧 → ExtensionUIRequest 适配（桌面 toExtensionUIRequest 的移动消费方子集：
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
  onSnapshotReconciled: () => {
    // §6.23 restart 恢复挂点：快照对账完成 = 壳分区已与 runtime 挂起表对齐——提交挂起
    // 解除（仍在的条目恢复可提交、已不存在的已被剔除）。挂起的置位在 suspendFormSubmissions
    // （bootstrap restart 分支），恢复恒经本回调（事件驱动，无定时器——时间平抑红线）。
    formSubmitSuspended.value = false
  },
  onInvalidated: (sid, _requestIds, removed) => {
    // 请求失效呈现联动（§6.4/§7.1）：当前会话的 form/planReview 请求被撤销 → 关 Sheet +
    // 原因提示。factory 回调时分区条目已摘除（remove 先于回调），「呈现中 requestId 命中
    // 失效集」不可查——按 sid 命中判定（activeSessionId 匹配 ∧ form 槽打开）：呈现面渲染
    // 即当前会话挂起请求，失效即呈现面变化；多请求挂起时非队首失效也收层（用户重开即见
    // 剩余请求，提示语义仍真——过宽面登记于此）。正常作答路径不走本回调（respond 送达
    // 摘除 ≠ invalidate），「提交成功误报失效」不可能。
    if (activeSheet.value !== 'form') return
    if (removed.length > 0 && sid === activeSessionId.value) {
      closeSheet()
      showErrorBar(t('mobile.sheet.requestInvalidated'))
    }
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

// ── §6.23 断连不清表单请求（A 级）：reason 分流 + 提交挂起（v2 改造段）────────────
//
// v1 行为（退役）：onRuntimeUnavailable 两 reason 一律 clearAllFormRequests（定时宽限式
// 整表清空——时间平抑类形态，§6.23 裁决退役）。
// v2 分流（bootstrap handleRuntimeUnavailable 消费）：
// - disconnect（网络断连，runtime 同一实例、挂起表还在）：分区保留，重连成功后 reconcile
//   对账收敛（仍在的补回、已撤销的摘除）——本模块无需动作；
// - restart（runtime 重启，新实例挂起表已清零）：分区保留（Sheet 视图不闪删）+
//   suspendFormSubmissions() 置提交挂起——重连成功后 reconcile 完成前 FormSheet 提交/取消
//   禁用，封住假成功窗口（旧 runtime 对已终结 requestId 静默忽略、UI 记为已提交、请求方
//   空等）；恢复恒经 formChannel onSnapshotReconciled（对账完成 = 事实源对齐）。
// dialog 通道 queue 两 reason 均不清（与 form 分区同语义；plugin 源 dialog 另有
// uiRequestExpired 撤窗，pi 源 dialog 无超时机制——shell-adapters [G1] 段）。

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态）：§6.23 restart 提交挂起标志
const formSubmitSuspended = ref(false)

/** restart 分支提交挂起置位（bootstrap handleRuntimeUnavailable 消费；幂等） */
export function suspendFormSubmissions(): void {
  formSubmitSuspended.value = true
}

/** 提交挂起读口（FormSheet 提交/取消按钮禁用判定；App 编排同步判定同源） */
export function useFormSubmitSuspended(): Ref<boolean> {
  return formSubmitSuspended
}

/** 提交挂起同步读口（非组件上下文判定用） */
export function isFormSubmitSuspended(): boolean {
  return formSubmitSuspended.value
}

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
// dialog 通道 queue 自 v2 起宿主居本模块（见上方 dialog queue 段），exited 编排直调
// mobileDialogQueue.resetFor——v1 的 DIALOG_QUEUE_HANDLE_KEY 句柄回传机制随 CompanionBand
// 呈现退役。

/** form 通道具名清理（直调 Map.delete，幂等；不触注册表广播） */
function clearFormRequestsForSession(sid: string): void {
  formRequestsBySid.delete(sid)
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
 * form 具名清理。
 */
export function resetCompanionChannelsForExitedSession(sid: string): void {
  mobileDialogQueue.resetFor(sid)
  clearFormRequestsForSession(sid)
}

export type MobileFormRequests = {
  /** 队首 form 类请求（form 帧 / legacy 归一帧；factory firstFormRequest 读口派生） */
  currentFormRequest: ComputedRef<ExtensionUIRequest | undefined>
  /** 队首 planReview 审批请求（桌面 PlanReviewBar 消费方的移动形态） */
  currentPlanReviewRequest: ComputedRef<PlanReviewFrameForView | undefined>
  /**
   * 作答回传（factory respond 核心流）：result 经 sendExtensionUIResponse（method 透传），
   * 未送达（WS 非 OPEN）保留请求可重试（M1/RD-3#1），送达即出分区。请求已终结
   * （失效/已应答）→ 迟到应答丢弃 + console 留痕（诊断留痕，不占错误条单槽）。返回值 =
   * 是否送达，App 编排消费（false → FormSheet 内联错误行，回传失败不静默）。
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

/** 视图消费的 planReview 帧窄化面（requestId + 检查搬运的 selfReview） */
export type PlanReviewFrameForView = {
  requestId: string
  selfReview?: string
}

/** dialog 通道的呈现读口（FormSheet dialog 分支渲染 + App 自动打开 watch 消费） */
export type MobileDialogRequests = {
  /** 当前活跃会话的队首 dialog 请求（queue 内部按 activeSessionId 分区派生；undefined = 无；
   * Readonly<Ref> = queue 接口声明的读口形状） */
  currentDialogRequest: Readonly<Ref<DialogRequest | undefined>>
  /** 作答回传（queue.respond：pi 源 sendPiResponse 带 method 透传 / plugin 源 sendPluginResponse；返回 = 是否送达） */
  respond(requestId: string, result: boolean | string | null): boolean
  /** 取消（等价 respond(requestId, null)） */
  cancel(requestId: string): void
}

/**
 * dialog 通道呈现读口（queue 单例薄包装；分区隔离在 queue 内部，切 session 自动换分区）。
 */
export function useMobileDialogRequests(): MobileDialogRequests {
  return {
    currentDialogRequest: mobileDialogQueue.currentRequest,
    respond: (requestId, result) => {
      mobileDialogQueue.respond(requestId, result)
      // queue.respond 返回 void（送达与否体现在请求是否出队）；送达判定经呈现面收敛——
      // 已出队 = 送达（未送达保留语义在 queue 内部）。
      return !mobileDialogQueue.hasRequest((r) => r.requestId === requestId)
    },
    cancel: (requestId) => mobileDialogQueue.cancel(requestId),
  }
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
  // App 编排消费（false → FormSheet 内联错误行，回传失败不静默）；reconcileNow =
  // 连接恢复边沿的对账入口（App.vue watch(isConnected) 消费，sid 为空跳过）。
  const actions = bindSessionFormActions(formChannel, () => sessionId.value)

  return { currentFormRequest, currentPlanReviewRequest, respond: actions.respond, cancel: actions.cancel, reconcileNow: actions.reconcile }
}

// ── §6.18 待办聚合读口段（「需要你处理」区 + BottomNav 计数角标的共同数据源）────────
//
// 聚合范围（§6.18 收窄口径）：全部会话的可归属待办（form/planReview/dialog，按分区键归属）
// + 全局（无归属）待办（permission——V-6 两问不成立 → protocol sessionId 恒不填，审批请求
// 恒无归属 = 一等分支）。三源读口就地聚合，ActivityScreen 与 BottomNav 消费同一 computed
//（单数据源，「导航计数与聚合区计数一致」构造性成立，不留第二套计数逻辑）。
// 分类谓词与呈现读口同源：form === true / planReview === true（isPlanReviewFrame 同式），
// legacy 帧不进计数——与 v2 FormSheet 呈现口径一致（无可达作答面的条目不进待办）。

/** form/planReview 分区全表计数快照（reactive Map 迭代建立响应式依赖；分区清空时键摘除） */
export const mobileFormPendingCounts = computed<ReadonlyMap<string, { form: number; planReview: number }>>(() => {
  const out = new Map<string, { form: number; planReview: number }>()
  for (const [sid, requests] of formRequestsBySid) {
    let form = 0
    let planReview = 0
    for (const r of requests) {
      if (r.planReview === true) planReview++
      else if (r.form === true) form++
    }
    if (form > 0 || planReview > 0) out.set(sid, { form, planReview })
  }
  return out
})

/** dialog 跨分区计数（ui queue pendingCountBySession 读口透传——currentRequest/pendingCount
 *  只读活跃分区，本读口是聚合对 dialog 的唯一跨分区通路） */
export const mobileDialogPendingCounts: Readonly<Ref<ReadonlyMap<string, number>>> =
  mobileDialogQueue.pendingCountBySession

/**
 * 待办聚合快照（§6.18 聚合半唯一实现点，分组/排序/计数在 features/pending-todos 纯函数）：
 * ActivityScreen「需要你处理」区渲染与 BottomNav 计数角标的共同入口。
 */
export function usePendingTodoSummary(): ComputedRef<PendingTodoSummary> {
  return computed(() =>
    summarizePendingTodos({
      formCounts: mobileFormPendingCounts.value,
      dialogCounts: mobileDialogQueue.pendingCountBySession.value,
      permissionPending: permissionController.state.pending,
      sessionOrder: sessionList.value.map((s) => s.id),
    }),
  )
}

// hasBlockingOverlay 输入接线（§6.19；u-sessions 立的注册口，本模块是分区数据宿主）——
// 「该会话待回答请求非空（form/planReview/dialog）」喂入 deriveSessionStatus，waiting 态在
// 移动侧达完整（D9② 消除的最后一行接线）。响应式成立前提：消费方（SessionsScreen 分组
// computed）求值期间调用 reader，reactive Map get 与计数 ref 读各自建立依赖。
// u-chat 移交项同批消账：本接线是 u-sessions runlog 决策 2 点名的待接线行。
registerOverlayPendingReader((sid) => {
  const requests = formRequestsBySid.get(sid) ?? []
  if (requests.some((r) => r.form === true || r.planReview === true)) return true
  return (mobileDialogQueue.pendingCountBySession.value.get(sid) ?? 0) > 0
})
