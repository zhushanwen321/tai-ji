// companion-bridge —— 移动壳 companion 区（CompanionBand）的数据源与回传装配
// （remote-use D7「ask-user 提问答复 ✅」行的壳侧拉通）+ 权限审批通道（D7「权限审批 ✅
// 手机可批」行的壳侧拉通）+ form/planReview 类请求通道（D7 form 行恢复任务：统一表单与
// plan 审批的移动壳消费面，消除「请求方无限等待」）。
//
// 对话桥翻译层（WS source 适配 + dialog source/transport 工厂 + requestId 反查表）已下沉
// @taiji/ui/extension-host shell-adapters（双壳逐字节共享，含 [G1] 反查表泄漏语义文档）；
// 权限审批编排状态机（bus 订阅 + 畸形事件守卫 + expired 撤窗 + transport 回传 +
// BM3/D3 语义）已下沉同包 createPermissionRequestController（双壳共享，单测在同包
// __tests__/）。本模块只做移动壳裁决：
// - 简单 dialog 走 CompanionBand（C4 门固定排除面之内）；form/planReview 类请求被同一 C4
//   门排除出 CompanionBand，由本模块 form 通道承接（MobileFormCard 渲染 + 作答回传），
//   消费语义与桌面 useExtensionUI 同构：C4 放行面（form ∨ planReview）+ requestId dedup +
//   per-session Map 分区 + requests-invalidated 失效摘除 + getPendingRequests 快照对账；
// - bus 模块级私有单例（桌面走 getExtensionBus 惰性单例，来源选择是壳裁决）；
// - 壳层能力回调不注入（无 pinia chat store / toast：onPiResponseSettled 空操作对齐
//   「移动壳无 pendingSend 链」，notifyNotDelivered 静默——form 通道的未送达反馈同为
//   console 降级，移动壳 v1 无 toast 组件）；
// - 权限/对话/form 三通道均模块级装配（bus 单例私居本模块；ESM 单次求值，listener 不会
//   翻倍），App.vue provide + 挂 CompanionBand / PermissionRequestDialog / MobileFormCard。
//
// 回传走 core 既有通路（不新造协议）：pi 源 extension.ui_response（sendExtensionUIResponse）、
// plugin 源 plugin.uiResponse（ws send）、审批源 plugin.approvePermissions/denyPermissions。
import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { InternalEventBus, MessageBusBridge } from '@taiji/core/extension-host'
import type { ExtensionInteractMethod } from '@taiji/shared'
import {
  createCompanionDialogAdapters,
  createPermissionRequestController,
  createWsPluginMessageSource,
} from '@taiji/ui/extension-host'
import type { PermissionTransport, PermissionRequestState } from '@taiji/ui/extension-host'
import { getPendingRequests, sendExtensionUIResponse, type ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { isPlanReviewFrame, isRichInteractionFrame } from './form-protocol'

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
}

// companion 数据源/回传对（App.vue provide 消费；G1 反查表泄漏语义两壳同持，见 shell-adapters）
const companionDialog = createCompanionDialogAdapters(bus)
export const mobileDialogRequestSource = companionDialog.source
export const mobileUiResponseTransport = companionDialog.transport

// ── permissionRequest 审批通道（D7 审批行，App 挂 PermissionRequestDialog）──
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

// ── form/planReview 类请求通道（D7 form 行恢复：统一表单 + plan 审批的移动壳消费面）──
//
// 消费语义与桌面 useExtensionUI 同构（桌面 per-panel 订阅 + pinia store SSOT；移动壳无
// pinia，模块级 reactive Map 分区承接，ADR-0049 per-session Map 范式）：
// - 订阅永驻模块级（不随视图挂载/卸载）——切 tab / 切 session 期间到达的请求照常入分区，
//   视图按 activeSessionId 派生渲染；快照对账（getPendingRequests 差集剔除）由
//   useMobileFormRequests 在 sid 变化时执行（桌面 subscribe(sid) 同式）；
// - 无 sid 的 ui-request 跳过（C2；同帧 dialog 通道已 warn，此处不重复告警）；
// - 撤窗语义与桌面 form 链同源：pi 源无超时撤窗广播，失效链
//   requests-invalidated（turn abort / session 销毁等非 respond 终结）按 requestId 摘除；
//   plugin 源 form 类帧桌面同样不消费 expired 广播（shell-adapters 反查表只在 dialog
//   投递流写入，C4 排除帧不落表 → miss noop），移动壳镜像该语义。

/** per-session form/planReview 请求分区（requestId 全局唯一，跨分区无重叠） */
const formRequestsBySid = reactive(new Map<string, ExtensionUIRequest[]>())

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
    method: ((typeof request.method === 'string' ? request.method : request.kind) ?? 'input') as ExtensionInteractMethod,
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

/** 入分区（requestId dedup：实时帧 + 快照补入双源幂等，桌面 store.addRequest T1 同式） */
function addFormRequest(sid: string, req: ExtensionUIRequest): void {
  const list = formRequestsBySid.get(sid) ?? []
  if (list.some((r) => r.requestId === req.requestId)) return
  formRequestsBySid.set(sid, [...list, req])
}

/** 按 requestId 出分区（失效链 / respond 送达后共用；幂等） */
function removeFormRequests(sid: string, requestIds: readonly string[]): void {
  const list = formRequestsBySid.get(sid)
  if (!list) return
  const ids = new Set(requestIds)
  const next = list.filter((r) => !ids.has(r.requestId))
  if (next.length === list.length) return
  if (next.length === 0) formRequestsBySid.delete(sid)
  else formRequestsBySid.set(sid, next)
}

// 永驻订阅（模块级单次注册）：C4 富交互放行面与桌面 useExtensionUI handler 同式
void bus.on('ui-request', (e) => {
  if (!e.sessionId) return
  if (!isRichInteractionFrame(e.request)) return
  addFormRequest(e.sessionId, toMobileFormRequest(e.sessionId, e.request))
})
void bus.on('requests-invalidated', (e) => {
  if (!e.sessionId) return
  removeFormRequests(e.sessionId, e.requestIds)
})

export type MobileFormRequests = {
  /** 队首 form 类请求（form 帧 / legacy 归一帧；桌面 currentFormRequest 同式取 first） */
  currentFormRequest: ComputedRef<ExtensionUIRequest | undefined>
  /** 队首 planReview 审批请求（桌面 PlanReviewBar 消费面的移动形态） */
  currentPlanReviewRequest: ComputedRef<PlanReviewFrameForView | undefined>
  /**
   * 作答回传（桌面 respond 同构）：result 经 sendExtensionUIResponse（method 透传），
   * 未送达（WS 非 OPEN）保留请求可重试（M1/RD-3#1），送达即出分区。请求已终结
   * （失效/已应答）→ 迟到应答丢弃 + console 留痕（无 toast 的降级提示）。
   */
  respond(requestId: string, result: boolean | string | null): boolean
  /** 取消（等价 respond(requestId, null)） */
  cancel(requestId: string): void
}

/** 视图消费的 planReview 帧窄化面（requestId + 守卫搬运的 selfReview） */
export type PlanReviewFrameForView = {
  requestId: string
  selfReview?: string
}

/**
 * form/planReview 通道的会话视图（App.vue 聊天视图编排消费）：
 * - 按 activeSessionId 派生队首请求（无 sid 恒空，分区隔离；切 session 读不同分区）；
 * - sid 变化时快照对账（差集剔除 + 补入，桌面 subscribe 快照段同式——覆盖 runtime 重启 /
 *   断连重连 / 后台 session 的请求补挂；模块级实时订阅保证不漏帧，快照是权威对账面，
 *   不在快照中的旧条目一律移除，空快照也执行）。
 */
export function useMobileFormRequests(sessionId: Ref<string | null>): MobileFormRequests {
  const currentFormRequest = computed<ExtensionUIRequest | undefined>(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    return formRequestsBySid.get(sid)?.find((r) => r.form === true)
  })

  const currentPlanReviewRequest = computed<PlanReviewFrameForView | undefined>(() => {
    const sid = sessionId.value
    if (!sid) return undefined
    const found = formRequestsBySid.get(sid)?.find(isPlanReviewFrame)
    return found ? { requestId: found.requestId, ...(found.selfReview !== undefined ? { selfReview: found.selfReview } : {}) } : undefined
  })

  // 快照对账（权威 pending 集；差集剔除调用在补入循环之外——空快照同样执行剔除）
  function reconcileSnapshot(sid: string): void {
    void getPendingRequests(sid)
      .then((pending) => {
        const keepIds = new Set(pending.filter(isRichInteractionFrame).map((r) => r.requestId))
        const existing = formRequestsBySid.get(sid) ?? []
        removeFormRequests(sid, existing.filter((r) => !keepIds.has(r.requestId)).map((r) => r.requestId))
        for (const req of pending) {
          if (!isRichInteractionFrame(req)) continue
          // 快照帧经 runtime {...r,...r.payload} 解包即 view-ready 帧（form:true 原生携带），
          // 直接入分区（dedup 幂等；receivedAt 语义移动壳无消费面，不搬运）
          addFormRequest(sid, toMobileFormRequest(sid, req))
        }
      })
      .catch((err) => {
        console.warn('[companion-bridge] failed to reconcile pending form requests:', err)
      })
  }

  watch(sessionId, (sid) => {
    if (sid) reconcileSnapshot(sid)
  }, { immediate: true })

  function respond(requestId: string, result: boolean | string | null): boolean {
    const sid = sessionId.value
    if (!sid) return false
    const target = (formRequestsBySid.get(sid) ?? []).find((r) => r.requestId === requestId)
    if (!target) {
      // 已终结 requestId 的应答丢弃并留痕（桌面 toast 提示的降级形态——移动壳无 toast）
      console.warn('[companion-bridge] form response dropped (request no longer pending):', requestId)
      return false
    }
    const delivered = sendExtensionUIResponse(sid, target.requestId, target.method, result)
    if (!delivered) {
      // 未送达：保留分区条目，连接恢复后同 requestId 重发幂等（M1/RD-3#1）
      console.warn('[companion-bridge] form response not delivered (WS closed), kept for retry:', requestId)
      return false
    }
    removeFormRequests(sid, [requestId])
    return true
  }

  function cancel(requestId: string): void {
    respond(requestId, null)
  }

  return { currentFormRequest, currentPlanReviewRequest, respond, cancel }
}
