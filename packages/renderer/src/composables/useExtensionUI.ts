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
 * - getPendingRequests（切回拉取）保留 RPC 路径（C3）；其应答落 store 前执行**快照差集剔除**
 *   （renderer 侧僵尸表单修剪主算法，§6.2 采用项④ v6.1：不在快照中的旧条目一律移除，
 *   空快照也执行；帧入口超龄过滤仅作兜底）
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
import { computed, reactive, ref, watch, onScopeDispose, type Ref } from 'vue'
import type { InternalEvent, DialogRequest } from '@taiji/core'
import type { ExtensionInteractMethod } from '@taiji/shared'
import type { DialogRequest as UiDialogRequest } from '@taiji/ui/extension-host'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { notifyUiResponseNotDelivered } from '@/composables/shell/extension-host-dialog'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'
import { sendExtensionUIResponse, getPendingRequests, type ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'
import {
  ensureBtwPendingBookkeeping,
  firstBtwDialogReq,
  noteBtwRequestResolved,
  respondBtwDialog,
} from '@/composables/panel/useBtwTabData'

/** 入队过滤谓词：返回 true 的请求才入队 */
export type UIRequestFilter = (req: ExtensionUIRequest) => boolean

/**
 * 统一表单 overlay 请求过滤器（Panel inline 渲染用）：form 键（终态判定面，D5 收敛）。
 * 全部表单族帧（新 form marker / legacy askUser / scheduleCreate marker）由 runtime
 * event-adapter marker 分支统一产出 form:true。普通 dialog 请求仍由 CompanionBand 消费
 * bus 直连（extension-host-dialog C4 对称排除，零重叠契约）。
 */
export const formFilter: UIRequestFilter = (req) => req.form === true

/**
 * 帧入口兜底超龄阈值（renderer 本地常量，非主算法）。
 *
 * 主算法 = `getPendingRequests` 快照差集剔除（见 subscribe 内 retainOnly 调用点），**不依赖
 * 任何阈值**——renderer 拿不到 runtime 的 `TAIJI_RUNTIME_PI_RECLAIM_FORM_MAX_AGE_MS`（env 隔离），
 * 且快照本身就是 runtime 权威 pending 集。本常量只作 `extension_ui_request` 逐帧入口的
 * 兜底（设计 scheduler-trigger-inversion §6.2 采用项④ v6.1）：帧若携带陈旧 `receivedAt`
 *（异常积压 / 未来 runtime 在广播帧上附带入队时间），超龄即丢弃，防极端积压污染 store。
 * 量级对齐 runtime 侧上界默认 6h（人填表窗口远超 6h 已无意义）。
 */
const FRAME_STALE_MAX_AGE_HOURS = 6
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
export const FRAME_STALE_MAX_AGE_MS =
  FRAME_STALE_MAX_AGE_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

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
  if (invalidatedUnsub) {
    invalidatedUnsub()
    invalidatedUnsub = null
  }
}

// ── 挂起请求失效广播订阅（P2-2 失效链，模块级单订阅永驻）──
// runtime 在非 respond 路径终结挂起（abort turn / 退出 plan / 回收 / session 销毁）时
// 广播 extension:requestsInvalidated → core bridge 归一为 'requests-invalidated' 事件。
// 收到即按帧逐条 removeRequest：审批条/表单随之消失，消除「僵尸 ready 点击静默无效」
// 残留。store.removeRequest 按 requestId 精确移除且幂等，多实例/重复帧无副作用。
type RequestsInvalidatedEvent = Extract<InternalEvent, { kind: 'requests-invalidated' }>
let invalidatedUnsub: (() => void) | null = null

function ensureInvalidatedSubscription(): void {
  if (invalidatedUnsub) return
  const bus = getExtensionBus()
  invalidatedUnsub = bus.on('requests-invalidated', (e: RequestsInvalidatedEvent) => {
    if (!e.sessionId) return
    const store = useExtensionUIStore()
    for (const requestId of e.requestIds) {
      store.removeRequest(e.sessionId, requestId)
    }
  })
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
  // receivedAt：优先采信帧携带的数值（异常积压场景可判定超龄），缺失则由本层打戳
  //（当前 runtime 广播帧不带该键，故常态恒为 Date.now()——兜底判定的输入面）。
  const rawReceivedAt = request.receivedAt
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
    receivedAt: typeof rawReceivedAt === 'number' ? rawReceivedAt : Date.now(),
  }
}

export function useExtensionUI(
  sessionId: Ref<string | null>,
  filter: UIRequestFilter = formFilter,
) {
  // pending 队列 SSOT 在 store（T2 迁移）：本 composable 只订阅事件写入 store、按 filter 读 store。
  // store.addRequest 含 requestId dedup（T1），无需手写去重。
  const store = useExtensionUIStore()
  // P2-2 失效链订阅（模块级单例；首个使用者挂上后永驻，与 store 生命周期一致）
  ensureInvalidatedSubscription()

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
        // 兜底超龄过滤（非主算法）：主算法是 getPendingRequests 快照差集剔除（见下方 .then）；
        // 此处只防「帧携带陈旧 receivedAt」的极端积压。常态帧收到即打戳（receivedAt ≈ now），
        // 判定不命中故无行为差异。
        if (Date.now() - (adapted.receivedAt ?? Date.now()) > FRAME_STALE_MAX_AGE_MS) {
          console.warn(
            '[useExtensionUI] 超龄 ui-request 帧已丢弃（兜底过滤，非快照差集主算法）:',
            adapted.requestId,
          )
          return
        }
        store.addRequest(eventSid, adapted)
      }),
    )
    // C3 保留：拉取 runtime 缓存的 pending 请求（切换 session 后重新订阅时，runtime 会推送缓存的请求）
    // 异步执行，不阻塞订阅建立
    //
    // 快照差集剔除（主算法，设计 §6.2 采用项④ v6.1）：
    // 本应答是 runtime 权威 pending 集 —— 先按快照做差集剔除（不在快照中的旧条目一律从该
    // session 分区移除），再补入快照新增条目。剔除调用在 for 循环**之外**（顶层），故空
    // 快照 pendingRequests=[] 时循环体不执行、剔除仍执行（keepIds 空集 ⇒ 清空分区）——这是
    // 覆盖「pi 进程被 idle reaper 回收 / 会话替换后 runtime 已清 pending，而 renderer 屏上仍
    // 留僵尸表单 → 用户直接点提交 → 丢进已回收进程 = 静默失败」主路径的关键；本路径不依赖
    // 任何阈值常量（renderer 拿不到 runtime 的 env 配置）。
    //
    // 安全性依据：快照应答与 ui-request 广播同走一条 WS 连接、按序处理——若某帧先于本应答
    // 被 renderer 处理，则它早已进 runtime pending 缓存（快照必含它）；若帧后于本应答到达，
    // 则它不在本次差集范围内，随后照常入队。
    //
    // 显式边界（已声明接受）：**未发生任何重订阅**（不切会话、不断线重连）时屏上僵尸表单仍在
    // ——本修剪只在快照落地时生效，与「未重订阅的丢帧」同族缺口（§6.2 采用项②）。
    getPendingRequests(sid)
      .then((pendingRequests) => {
        store.retainOnly(sid, new Set(pendingRequests.map((r) => r.requestId)))
        // 补入快照条目（已在分区者由 addRequest requestId dedup 幂等跳过）。
        // M1 竞态修复：addRequest(sid, ...) 用订阅时捕获的 sid（参数）——只写旧 sid 分区，
        // 不读 sessionId.value。即使此响应在 session 切换后到达，也只写入旧 sid 的 Map
        // 分区，不会污染新 sid。Map 分区已结构性隔离 stale 响应。
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

  /**
   * 用户回复指定请求（按 requestId 精确定位，不假设队首）。
   *
   * 未送达（sendExtensionUIResponse 返 false = WS 非 OPEN）→ 保留 store 请求不 remove
   * （M1/RD-3#1：断连期点确认＝应答丢失、弹窗消失、pi 侧 Promise 永挂）+ toast 提示；
   * FormOverlay/审批条保留展示，连接恢复后用户可再次提交重投（同 requestId 幂等——
   * runtime handler 与 pi rpc-mode 对已终结 requestId 均静默忽略重复应答）。
   *
   * 返回值（D8 提交回路契约，btw-question M3-c）：true = 应答已送达并出队；false =
   * 未送达（保持挂起可重试——「重试仅限投递失败态」）或请求已终结（应答丢弃 + 提示
   * 失效，不静默）。消费方（btw 内联确认条）据此决定待处理簿记是否随应答解除。
   */
  function respond(requestId: string, result: boolean | string | null): boolean {
    const sid = sessionId.value
    if (!sid) return false
    const target = store.getRequestsBySession(sid).find(r => r.requestId === requestId)
    if (!target) {
      // 已终结 requestId 的应答丢弃并提示失效（D8：迟到提交不静默，toast 可见）
      const t = i18n.global.t as (key: string) => string
      useToast().error(t('extensionUI.requestExpired'), { sessionId: sid })
      return false
    }
    const delivered = sendExtensionUIResponse(target.sessionId, target.requestId, target.method, result)
    if (!delivered) {
      notifyUiResponseNotDelivered(target.sessionId)
      return false
    }
    // store.removeRequest 按 requestId 精确移除（不区分 form/dialog），requestId 全局唯一，
    // 故即使本实例 filter 不同也能正确移除。
    store.removeRequest(sid, requestId)
    return true
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

// ─────────────────────────────────────────────────────────────────────────────
// M3-c 交互闭环：D8 降级路径 —— drawer 内联确认条编排（唯一形态）
//
// V4 核实③不成立（plan-store 单全局 focusedSid 焦点投影，第二 usePlanState 实例会把
// 主审批条读分区抢走 → S9b 互不抢占被破坏；修复面在领地外 plan-store/use-plan-sync）
// → 按设计 D8 降级路径：五类请求（ask-user 富表单 / scheduler 表单 / plan 审批 /
// 权限审批 / confirm·input·editor 简单 dialog）统一由 drawer 内联确认条独立轻实现
// 呈现，富表单降档（choice→选项按钮、text→单行输入、schedule→预填草稿一键确认、
// plan→两键+单行意见、editor→单行输入），**不回退主视图模态面**；降档契约登记于
// 实施计划偏差表。提交回路契约与降级态同源：走 D8 终态机表（上文簿记）；投递失败
// 可重试（仅限未送达/未终结 requestId）；已终结 requestId 的应答丢弃并提示失效。
//
// 并发：本编排只读 vid 分区（store 分区 + 模块级簿记），主视图三模态面读主 sid 分区
// ——两面同屏互不抢占、提交态按表单实例/vid 隔离（S9b）。
// ─────────────────────────────────────────────────────────────────────────────

/** 确认条当前活动请求（按 receivedAt 与 store 族/dialog 族合并排序取最早——多请求并发呈现有序） */
export interface BtwBarRequest {
  kind: 'form' | 'planReview' | 'dialog'
  requestId: string
  receivedAt: number
  /** kind==='form'：完整表单请求（formQuestions / legacy scheduleCreate·scheduleDraft 源） */
  form?: ExtensionUIRequest
  /** kind==='dialog'：简单 dialog 载荷（含权限审批 select；ui 包 DialogRequest，非 core 同名类型） */
  dialog?: UiDialogRequest
}

/** 降档表单选项（本地同形，renderer 不反向依赖 extension-protocol——PlanReviewComment 惯例） */
export interface BtwBarOption {
  label: string
  description?: string
}

/** 降档 schedule 草稿（本地同形：ScheduleDraft 的消费面字段子集） */
export interface BtwScheduleDraft {
  kind: 'once' | 'recurring'
  schedule: string
  prompt: string
  model?: string
  name?: string
  expires?: string
}

/** 降档表单问题（本地同形守卫收窄后的渲染面） */
export interface BtwBarFormQuestion {
  type: 'choice' | 'text' | 'schedule'
  header?: string
  question: string
  options?: BtwBarOption[]
  multi?: boolean
  allowOther?: boolean
  initial?: BtwScheduleDraft
}

/** schedule 草稿形状守卫（结构化收窄，禁 any；缺字段 = 不可降级确认，走取消支） */
function toScheduleDraft(v: unknown): BtwScheduleDraft | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as Record<string, unknown>
  if (d.kind !== 'once' && d.kind !== 'recurring') return null
  if (typeof d.schedule !== 'string' || typeof d.prompt !== 'string') return null
  return {
    kind: d.kind,
    schedule: d.schedule,
    prompt: d.prompt,
    ...(typeof d.model === 'string' ? { model: d.model } : {}),
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    ...(typeof d.expires === 'string' ? { expires: d.expires } : {}),
  }
}

/** formQuestions 逐项归一（非法项剔除——runtime 侧 isFormQuestion 逐项过滤同策略） */
function toBarQuestion(v: unknown): BtwBarFormQuestion | null {
  if (typeof v !== 'object' || v === null) return null
  const q = v as Record<string, unknown>
  let kind: 'choice' | 'text' | 'schedule'
  if (q.type === 'choice') kind = 'choice'
  else if (q.type === 'text') kind = 'text'
  else if (q.type === 'schedule') kind = 'schedule'
  else return null
  const header = typeof q.header === 'string' ? q.header : undefined
  const question = typeof q.question === 'string' ? q.question : ''
  if (header === undefined && question === '') return null
  const base = { type: kind, ...(header !== undefined ? { header } : {}), question }
  if (kind === 'schedule') {
    const initial = toScheduleDraft(q.initial)
    return { ...base, ...(initial !== null ? { initial } : {}) }
  }
  if (kind !== 'choice') return base
  const options: BtwBarOption[] = []
  if (Array.isArray(q.options)) {
    for (const o of q.options) {
      if (typeof o !== 'object' || o === null) continue
      const rec = o as Record<string, unknown>
      if (typeof rec.label !== 'string') continue
      options.push({
        label: rec.label,
        ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
      })
    }
  }
  return { ...base, options, multi: q.multi === true, allowOther: q.allowOther !== false }
}

/** 问题集派生（questions 源优先；legacy scheduleCreate·scheduleDraft 源包装单 schedule 问） */
function questionsOf(req: ExtensionUIRequest): BtwBarFormQuestion[] {
  const out: BtwBarFormQuestion[] = []
  if (Array.isArray(req.formQuestions)) {
    for (const q of req.formQuestions) {
      const n = toBarQuestion(q)
      if (n) out.push(n)
    }
  }
  if (out.length > 0) return out
  const draft = toScheduleDraft(
    (req as { scheduleDraft?: unknown }).scheduleDraft,
  )
  if (req.scheduleCreate === true && draft) {
    return [{ type: 'schedule', question: '', initial: draft }]
  }
  return []
}

/** answers key（与协议 askUserKey fallback 同规则：header ?? question） */
function questionKey(q: BtwBarFormQuestion): string {
  return q.header ?? q.question
}

/** schedule 降档提交体（预填草稿直接确认——FormOverlay「预填草稿视为有效」语义；once 的
 *  draft.schedule 已是折叠一次性 cron（唯一时间来源），不再二次折叠）。 */
function scheduleResultJson(d: BtwScheduleDraft): string {
  const result: Record<string, unknown> = {
    action: 'create',
    kind: d.kind,
    schedule: d.schedule,
    prompt: d.prompt,
  }
  if (d.model !== undefined) result.model = d.model
  if (d.name !== undefined) result.name = d.name
  if (d.kind === 'recurring' && d.expires !== undefined) result.expires = d.expires
  return JSON.stringify(result)
}

/**
 * 接线 drawer 内联确认条（BtwPanel setup 同步调用）。
 *
 * 数据面三通道合并：store 族（form + planReview，useExtensionUI vid 分区）∪ dialog 族
 * （模块级簿记 FIFO）——按 receivedAt 取最早呈现（并发有序），respond 后自然晋升下一条。
 */
export function useBtwInteraction(vidRef: Ref<string | null>) {
  ensureBtwPendingBookkeeping()
  const ui = useExtensionUI(vidRef, () => true)

  const active = computed<BtwBarRequest | null>(() => {
    const vid = vidRef.value
    if (!vid) return null
    const cands: BtwBarRequest[] = []
    const form = ui.currentFormRequest.value
    if (form) {
      cands.push({ kind: 'form', requestId: form.requestId, receivedAt: form.receivedAt ?? 0, form })
    }
    const plan = ui.currentPlanReviewRequests.value[0]
    if (plan) {
      cands.push({ kind: 'planReview', requestId: plan.requestId, receivedAt: plan.receivedAt ?? 0 })
    }
    const dialog = firstBtwDialogReq(vid)
    if (dialog) {
      cands.push({ kind: 'dialog', requestId: dialog.requestId, receivedAt: dialog.receivedAt, dialog })
    }
    if (cands.length === 0) return null
    return cands.reduce((best, c) => (c.receivedAt < best.receivedAt ? c : best))
  })

  // ── 表单实例态（按活动请求隔离：requestId 变更即重置——提交态 per-vid/表单实例隔离）──
  const formSel = reactive<Record<string, string[]>>({})
  const formText = reactive<Record<string, string>>({})
  const planComment = ref('')
  const dialogSelect = ref('')
  const dialogText = ref('')
  watch(
    () => active.value?.requestId ?? '',
    () => {
      for (const k of Object.keys(formSel)) delete formSel[k]
      for (const k of Object.keys(formText)) delete formText[k]
      planComment.value = ''
      dialogSelect.value = ''
      dialogText.value = ''
    },
  )

  const activeQuestions = computed<BtwBarFormQuestion[]>(() => {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return []
    return questionsOf(a.form)
  })

  function toggleSelect(key: string, label: string, multi: boolean): void {
    const cur = formSel[key] ?? []
    if (multi) {
      formSel[key] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
    } else {
      formSel[key] = [label]
    }
  }

  function isSelected(key: string, label: string): boolean {
    return (formSel[key] ?? []).includes(label)
  }

  function draftValid(d: BtwScheduleDraft | null | undefined): boolean {
    return d !== null && d !== undefined && d.prompt.trim().length > 0
  }

  /** Submit 门（降档口径）：逐题可答判定（choice=选项或 Other；text=非空；schedule=草稿可用） */
  const canSubmitForm = computed(() => {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return false
    const qs = activeQuestions.value
    if (qs.length === 0) return false
    if (a.form.scheduleCreate === true) {
      // legacy draft 源：无 questions，直接校验草稿
      return draftValid(toScheduleDraft((a.form as { scheduleDraft?: unknown }).scheduleDraft))
    }
    return qs.every((q) => {
      const key = questionKey(q)
      if (q.type === 'schedule') return draftValid(q.initial)
      if (q.type === 'text') return (formText[`${key}__other`] ?? '').trim().length > 0
      const sel = (formSel[key] ?? []).length > 0
      const other = (formText[`${key}__other`] ?? '').trim().length > 0
      if ((q.options ?? []).length === 0) return other
      return sel || other
    })
  })

  /** 主按钮文案（含 schedule 题 =「创建任务」，FormOverlay 同口径；降档复用既有 key） */
  const submitLabel = computed(() => {
    const a = active.value
    if (a?.kind !== 'form') return ''
    const hasSchedule = activeQuestions.value.some((q) => q.type === 'schedule')
    return hasSchedule ? 'schedule' : 'submit'
  })

  /** 取消键显隐（协议缺省 true；显式 false 隐藏——FormOverlay 同语义；dialog 恒显） */
  const allowCancel = computed(() => {
    const a = active.value
    if (a?.kind !== 'form') return true
    return a.form?.allowCancel !== false
  })

  /** 应答出口（三 kind 共用；送达才出账——未送达保持挂起可重试，D8 提交回路契约） */
  function respondActive(result: boolean | string | null): void {
    const a = active.value
    const vid = vidRef.value
    if (!a || !vid) return
    if (a.kind === 'dialog') {
      respondBtwDialog(vid, a.requestId, result)
      return
    }
    if (ui.respond(a.requestId, result)) noteBtwRequestResolved(vid, a.requestId)
  }

  /** 表单提交：按挂载源构造应答形状（draft 源 = 扁平 ScheduleFormResult；questions 源 = answers envelope） */
  function submitForm(): void {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return
    if (a.form.scheduleCreate === true) {
      const draft = toScheduleDraft((a.form as { scheduleDraft?: unknown }).scheduleDraft)
      if (draft) respondActive(scheduleResultJson(draft))
      return
    }
    const answers: Record<string, string> = {}
    for (const q of activeQuestions.value) {
      const key = questionKey(q)
      if (q.type === 'schedule') {
        if (!q.initial) return
        answers[key] = scheduleResultJson(q.initial)
        continue
      }
      if (q.type === 'text') {
        const t = formText[`${key}__other`] ?? ''
        if (t.trim().length > 0) answers[`${key}__other`] = t
        continue
      }
      const sel = formSel[key] ?? []
      if ((q.options ?? []).length > 0 && sel.length > 0) {
        answers[key] = q.multi === true ? JSON.stringify(sel) : sel[0]
      }
      const other = formText[`${key}__other`] ?? ''
      if (other.length > 0) answers[`${key}__other`] = other
    }
    respondActive(JSON.stringify(answers))
  }

  /** plan 审批降档回传（PlanReviewResponse 本地同形；revise 单行意见 = 降档契约登记面） */
  function submitPlan(decision: 'approve' | 'revise'): void {
    const payload =
      decision === 'approve'
        ? JSON.stringify({ decision: 'approve' })
        : JSON.stringify({ decision: 'revise', comments: [{ quote: '', comment: planComment.value.trim() }] })
    respondActive(payload)
  }

  function cancelActive(): void {
    respondActive(null)
  }

  return {
    active,
    activeQuestions,
    formSel,
    formText,
    planComment,
    dialogSelect,
    dialogText,
    questionKey,
    toggleSelect,
    isSelected,
    canSubmitForm,
    submitLabel,
    allowCancel,
    respondActive,
    submitForm,
    submitPlan,
    cancelActive,
  }
}
