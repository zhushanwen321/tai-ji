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
 *
 * btw 侧（btw-question M3-c）：本模块只承载 btw 挂起的失效/修剪收口与 D7⑤ 草稿状态
 * 本体（文件尾）；drawer 内联确认条编排本体（D8 降级路径）拆在
 * panel/useBtwInteraction.ts（单向依赖：编排 → 本模块，无环）。
 */
import { computed, reactive, watch, onScopeDispose, type Ref } from 'vue'
import type { InternalEvent, DialogRequest } from '@taiji/core'
import { isBtwVirtualId } from '@taiji/shared'
import type { ExtensionInteractMethod } from '@taiji/shared'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import { notifyUiResponseNotDelivered } from '@/composables/shell/extension-host-dialog'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'
import { sendExtensionUIResponse, getPendingRequests, type ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useChatStore } from '@/stores/chat'
import { BTW_EXPIRED_REASON_SNAPSHOT_PRUNED, invalidateBtwStaleFromSnapshot } from '@/composables/panel/btw-pending-bookkeeping'

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
  btwBarDrafts.clear() // 草稿分键表随测试隔离清空（模块级跨用例残留防护）
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
    // D1 invalidated 锚点（form-hang-fix）：runtime 非 respond 终结（reclaimed / plan-aborted /
    // turn-aborted / session-destroyed 四类触发源）均无后续 turn 预期，pendingSend 等
    // message_start 必然空等——按帧 sid 收口。clearPendingSend 幂等，与 message_start /
    // respond 锚点并发竞争无副作用。
    // chatStore 此处**现取**而非 respond 侧的 setup 捕获：本订阅是模块级单例、生命周期跨
    // Panel 实例（首个使用者挂上后永驻），setup 捕获会钉死首个实例的上下文；而事件到达
    // 时点 pinia 必已 active（与上方 useExtensionUIStore() 同模式），现取安全。
    useChatStore().clearPendingSend(e.sessionId)
    // D7⑤ 终结清理（失效支）：挂起终结后对应分键草稿即删（切走切回不丢 ≠ 终结后残留）
    clearBtwBarDrafts(e.sessionId, e.requestIds)
  })
}

/** dialog level 白名单守卫（ExtensionUIRequest.level 契约面，三值）。 */
function isDialogLevel(value: unknown): value is 'info' | 'warn' | 'error' {
  return value === 'info' || value === 'warn' || value === 'error'
}

/** string[] 守卫（options 契约面）：数组且逐项 string。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** dialog 基础展示字段搬运（title/message/options/default/level/prefill）。
 *  DialogRequest 索引签名读原始 payload，值域 unknown，按 ExtensionUIRequest 契约
 *  运行时守卫收窄（isPlanReviewRequest 同范式）：畸形值（非 string / 非 string[] /
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
    // expectTurn 源元数据透传（form-submit-busy-convergence D1 段 4）：帧上仅显式 false 落键
    //（runtime event-adapter 条件落键），undefined 缺键 = 缺省桥接态——按帧原样透传进 store，
    // respond 分型据其三态判定；非 boolean 值不入帧（守卫即透传闸）。
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
  const store = useExtensionUIStore()
  // D1 分型锚点的 chatStore 取用（form-hang-fix）：setup 上下文捕获（对齐上方 extensionUIStore
  // 模式），respond 事件回调经闭包引用——不在回调内重取。
  const chatStore = useChatStore()
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
        const keepIds = new Set(pendingRequests.map((r) => r.requestId))
        const beforeIds = store.getRequestsBySession(sid).map((r) => r.requestId)
        store.retainOnly(sid, keepIds)
        // btw 修剪路失效（D8 失效支两路收口之一，与事件路同函数单入口）：runtime 重启后
        // pending 内存表清零，进程死亡切面恒空清单不广播失效帧（server invalidate 单出口）——
        // 本地挂起簿记有、权威快照无的 requestId 据本次对账差集补走失效支，遗留挂起转为
        // 行内「请求已失效」提示。快照仍含的请求不动；主会话 sid 不入（isBtwVirtualId 守卫）；
        // 触发面 = 本 retainOnly 调用点，不新增轮询。
        if (isBtwVirtualId(sid)) {
          invalidateBtwStaleFromSnapshot(sid, keepIds, BTW_EXPIRED_REASON_SNAPSHOT_PRUNED)
        }
        // D7⑤ 终结清理（快照修剪支）：被剔除的僵尸请求（重附着/回收后 runtime 已清）
        // 对应分键草稿随之删除——快照剔除 = 失效语义的同族终结点（空集幂等）
        clearBtwBarDrafts(sid, beforeIds.filter((id) => !keepIds.has(id)))
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
    // D1 分型锚点（form-hang-fix）：cancel 型（result === null——Esc / 取消按钮 / cancel()
    // 同链）送达后 pi 无后续 turn 事件预期，pendingSend 等 message_start 必然空等（假忙
    // 窗口病灶）——送达即收口。提交型（result !== null）不清：pi 起 turn，pendingSend
    // 桥接「respond 完成 → message_start 到达」窗口并由其正常清除（现状语义，不制造
    // isActive=false 空窗）。判据严格按 result 是否 null——boolean 型按提交型处理。
    if (result === null) {
      chatStore.clearPendingSend(sid)
    } else if (target.expectTurn === false) {
      // D1 段 5 + D2 严格双条件（result ≠ null ∧ expectTurn === false）：提交型但源声明
      // 无 turn 预期（命令 handler 内 select，message_start 永不来）→ 立即收尾，消除
      // 30s 假忙。判定必须 `=== false` 显式判定——truthy 简化（`!expectTurn`）会把
      // undefined（存量扩展/断链缺省）也当无 turn、误清 ask-user 桥接（D2 被否谱系）；
      // true / undefined → 隐式 else，桥接照旧（缺省安全）。
      chatStore.clearPendingSend(sid)
    }
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
// btw 内联确认条草稿分键表（D7⑤ 提交态 per-vid 隔离的模块级载体）——确认条编排本体
// （D8 降级路径：请求合并排序 / 降档表单 / 提交回路）在 panel/useBtwInteraction.ts，
// 本模块只承载草稿状态本体：终结清理入口挂在本模块失效链（invalidated 订阅）与
// 快照差集修剪（retainOnly diff）两路，故状态留此与挂起请求生命周期同文件管理。
// ─────────────────────────────────────────────────────────────────────────────

/** 确认条草稿（四组提交态）——按 `${vid}:${requestId}` 分键保存（D7⑤ per-vid/表单实例双隔离） */
export type BtwBarDraft = { sel: Record<string, string[]>; text: Record<string, string>; planComment: string; dialogSelect: string; dialogText: string }

export const emptyBtwBarDraft = (): BtwBarDraft => ({ sel: {}, text: {}, planComment: '', dialogSelect: '', dialogText: '' })

// taste:allow-no-data-owner W24-EX（btw-question M3-c 行内豁免，登记表⑧已落定（2026-09-22，阶段 3 审查 U2 修复随批）——EX-A：`btwBarDrafts` 分键草稿 Map，D7⑤ 挂起表单提交态 per-vid 隔离的持久草稿本体）：
// 确认条草稿分键表（用户输入暂存、终结即删，非 GUI 数据本体；D7⑤ 切走切回不丢的模块级载体）
export const btwBarDrafts = reactive(new Map<string, BtwBarDraft>())

/** 终结清理：应答送达 / 失效 / 快照修剪三支共用（幂等） */
export function clearBtwBarDrafts(vid: string, requestIds: readonly string[]): void { for (const rid of requestIds) btwBarDrafts.delete(`${vid}:${rid}`) }
