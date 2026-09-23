/**
 * btw-pending-bookkeeping —— btw 线 D8 终态机簿记（纯状态域：零订阅 / 零 transport / 零组件依赖）。
 *
 * 职责（一件事）：badge「待处理」态与挂起请求生命周期的单一数据源——四张模块级 reactive
 * 表（挂起请求 id 集 `pendingReqIdsByVid` / dialog 族渲染载荷 FIFO `dialogReqsByVid` /
 * 失效行内提示 `expiredNoticeByVid` / 回收提醒 `reclaimReminderVids`）+ 全部状态转移函数。
 * 模块级永驻，不依赖任何组件挂载（drawer 关着 badge 也准确）；reactive 形态供 badge/确认条
 * 在 computed/渲染内读取建立依赖。
 *
 * 依赖边界（层级约束：本模块必须保持在 useBtwTabData 之下、可被 store 层直接消费）：
 * 只 import vue / shared·core·ui 类型 + core 纯函数值（hasDanglingInteractiveRequest——
 * 零依赖纯谓词，不构成环）/ stores/extension-ui——不 import bus 订阅
 * （getExtensionBus）、dialog 转换（extension-host-dialog 的 convertToDialogRequest /
 * createUiResponseTransport）与 stores/chat。stores/btw-replay.ts（chat store 的回放装配点）
 * 直接消费本模块（markBtwStaleInteractiveFromReplay），上述任何一条依赖都会构成
 * store → composable/壳层 → stores/chat 的环。
 * 订阅壳（bus 事件 → 入账）与 transport 应答（respondBtwDialog——送达才出队出账）在
 * useBtwTabData；虚拟 key 清理登记（btwVirtualKeysByMain 族）同在 useBtwTabData
 * （其处置链需要 stores/chat/workflow/subagent）。
 *
 * 入账：bus 'ui-request'（订阅壳 = useBtwTabData.ensureBtwPendingBookkeeping）经
 * registerBtwPendingRequest + enqueueBtwDialogReq 写入（D8 请求范围 SSOT 五类——ask-user
 * 富表单/scheduler 表单/plan 审批为 form∪planReview 帧；权限审批（ctx.ui.select）与
 * confirm·input·editor 为 select/confirm/input/editor 简单 dialog 帧，同通道不单设路由；
 * notify 不注册 pending、setStatus/setWidget 不产 ui_request 帧，方法集天然排除）。
 * 出账（终态机清除支）：
 * - 应答：store 族经 useExtensionUI.respond 出队后由确认条调 noteBtwRequestResolved；
 *   dialog 族走 respondBtwDialog（useBtwTabData——送达才出队出账，未送达保持挂起可重试）；
 * - 撤回 / 失效：`invalidateBtwRequests` 单入口（多路写入合并收口）：① 事件路 = bus
 *   'requests-invalidated'（runtime 非 respond 终结单一出口，订阅壳薄委托）；② 快照修剪路 =
 *   `invalidateBtwStaleFromSnapshot`（useExtensionUI retainOnly 对账差集联动，补「runtime
 *   进程死亡后 pending 内存表清零 → 空清单不广播失效帧」的结构性缺口——重启后遗留挂起在
 *   首次对账时转为行内已失效提示）；③ 回放对账路 = `markBtwStaleInteractiveFromReplay`
 *   （stores/btw-replay 回放链联动，补快照修剪路的残余盲区：整机杀重启时本簿记与 runtime
 *   pending 同时清零、修剪差集恒空结构性不触发——以 pi 会话文件中悬空的交互请求 toolCall
 *   持久痕迹为信号源置位，只写提示不出账）。逐条出账 + 行内提示置位 + dialog 渲染载荷同步
 *   撤下。`expiredNoticeByVid` 的写方形态：置位 = ①事件路 invalidateBtwRequests + ②差集支 +
 *   ③回放路三函数；清除 = 新请求顶掉（registerBtwPendingRequest）+ 用户 dismiss
 *   （clearBtwExpiredNotice）。各写方互不清除他路产物（②首条版本保留语义见
 *   invalidateBtwRequests 注释；③同值幂等；异值 reason 可被覆盖——簿记值，展示文案固定
 *   i18n 不分支，行为等价）。
 * - 回收提醒清除支：setBtwReclaimReminder(vid, false) + 线内容增长即清（用户续问的
 *   renderer 可达信号，见 useBtwTabData syncThreadWatchers）。
 * 无超时语义：本簿记不含任何墙钟（D8——pi 源 dialog 无超时，plugin 超时撤窗契约不套用）。
 */
import { reactive } from 'vue'
import { hasDanglingInteractiveRequest } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import type { DialogRequest } from '@taiji/ui/extension-host'
import type { Message } from '@taiji/shared'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** D8 简单 dialog 方法集（权限审批 ctx.ui.select 同通道，不单设路由） */
const BTW_DIALOG_METHODS: readonly string[] = ['confirm', 'select', 'input', 'editor']

/** btw 线挂起请求 id 集（reactive：badge/确认条在 computed/渲染内读取建立依赖） */
// taste:allow-no-data-owner W24-EX（btw-question M3-c 行内豁免，**已落定非草稿**——data-source-registry §4 ⑧ 已落定（2026-09-22））：D8 挂起请求 id 簿记（非 GUI 数据本体，对照 extension-host-dialog requestIdSessions 先例）
const pendingReqIdsByVid = reactive(new Map<string, Set<string>>())
/** dialog 族渲染载荷 FIFO（requestId dedup；确认条按 receivedAt 与 store 族合并排序） */
// taste:allow-no-data-owner W24-EX（同上，registry §4 ⑧ 已落定（2026-09-22））：dialog 族渲染载荷 FIFO（非 GUI 数据本体——GUI 呈现副本归确认条实例态）
const dialogReqsByVid = reactive(new Map<string, DialogRequest[]>())
/** 终态机失效支行内提示（vid → reason；展示文案固定 i18n，reason 仅簿记） */
// taste:allow-no-data-owner W24-EX（同上，registry §4 ⑧ 已落定（2026-09-22））：失效行内提示布尔位簿记（文案在 i18n，此处仅标记）
const expiredNoticeByVid = reactive(new Map<string, string>())
/** 终态机第四行：回收提醒（非终态） */
// taste:allow-no-data-owner W24-EX（同上，registry §4 ⑧ 已落定（2026-09-22））：回收提醒置位集合（D8 终态机第四行，非 GUI 数据本体）
const reclaimReminderVids = reactive(new Set<string>())

type UiRequestEvent = Extract<InternalEvent, { kind: 'ui-request' }>

/** D8 请求范围判定（调用方已保证 sid 是 btw vid） */
export function isBtwDialogRequest(e: UiRequestEvent): boolean {
  const r = e.request as { form?: unknown; planReview?: unknown; method?: unknown }
  if (r.form === true || r.planReview === true) return true
  return typeof r.method === 'string' && BTW_DIALOG_METHODS.includes(r.method)
}

/**
 * 挂起请求入账（订阅壳 bus 'ui-request' handler 调用）：pending 集合加 id + 新请求顶掉
 * 失效提示（表单重新可达）。store 族载荷（form/planReview）只记 id——载荷本体在
 * extensionUIStore，不进 dialog FIFO。
 */
export function registerBtwPendingRequest(vid: string, requestId: string): void {
  let ids = pendingReqIdsByVid.get(vid)
  if (!ids) {
    ids = new Set()
    pendingReqIdsByVid.set(vid, ids)
  }
  ids.add(requestId)
  expiredNoticeByVid.delete(vid)
}

/** dialog 族渲染载荷入队（requestId dedup——实时帧 + 快照双源幂等） */
export function enqueueBtwDialogReq(vid: string, req: DialogRequest): void {
  const list = dialogReqsByVid.get(vid) ?? []
  if (list.some((d) => d.requestId === req.requestId)) return
  dialogReqsByVid.set(vid, [...list, req])
}

/** dialog 族队首读取（并发排序的 dialog 侧候选；useBtwInteraction 消费） */
export function firstBtwDialogReq(vid: string): DialogRequest | undefined {
  return dialogReqsByVid.get(vid)?.[0]
}

/** dialog 族按 id 查找（respondBtwDialog 送达判定的目标定位） */
export function findBtwDialogReq(vid: string, requestId: string): DialogRequest | undefined {
  return (dialogReqsByVid.get(vid) ?? []).find((d) => d.requestId === requestId)
}

/** 出队写回共用支：余量为 0 删键（不留空数组残留） */
function setBtwDialogReqs(vid: string, next: DialogRequest[]): void {
  if (next.length > 0) dialogReqsByVid.set(vid, next)
  else dialogReqsByVid.delete(vid)
}

/** dialog 族按 id 出队（respondBtwDialog 送达后调；幂等） */
export function removeBtwDialogReq(vid: string, requestId: string): void {
  const list = dialogReqsByVid.get(vid)
  if (!list) return
  setBtwDialogReqs(vid, list.filter((d) => d.requestId !== requestId))
}

/** 快照修剪路失效 reason（簿记值——展示文案固定 i18n `btw.interaction.expiredNotice`
 *  不按 reason 分支；语义 = runtime 重启后遗留挂起经首次快照对账确认失效） */
export const BTW_EXPIRED_REASON_SNAPSHOT_PRUNED = 'snapshot-pruned'

/** 回放对账路失效 reason（簿记值，展示同上；语义 = 回放投影检出悬空交互请求 toolCall
 *  且该线无存活挂起——整机杀重启后首轮回放的确证失效信号，信号源 = pi 会话文件持久层） */
export const BTW_EXPIRED_REASON_REPLAY_DANGLING = 'replay-dangling'

/**
 * 失效支单入口（多路写入合并收口，`expiredNoticeByVid` 单状态）：事件路订阅与快照修剪路
 * （`invalidateBtwStaleFromSnapshot`）都收口至此——逐条出账 + 行内提示置位 + dialog 渲染
 * 载荷撤下。`had` 守卫：requestIds 全部不在本簿记时零副作用（重复帧 / 剪枝差集为空均 no-op）。
 */
export function invalidateBtwRequests(
  vid: string,
  requestIds: readonly string[],
  reason: string,
): void {
  const ids = pendingReqIdsByVid.get(vid)
  if (!ids) return
  const had = requestIds.some((id) => ids.has(id))
  for (const id of requestIds) ids.delete(id)
  if (ids.size === 0) pendingReqIdsByVid.delete(vid)
  if (!had) return
  expiredNoticeByVid.set(vid, reason)
  const list = dialogReqsByVid.get(vid)
  if (list) setBtwDialogReqs(vid, list.filter((d) => !requestIds.includes(d.requestId)))
}

/**
 * 快照修剪路失效（useExtensionUI subscribe 内 retainOnly 对账点联动，失效支两路之一）：
 * 本地挂起簿记有、runtime 权威快照无的 requestId = 运行时已不认识该请求（重启后 pending
 * 内存表清零、无失效帧可广播）→ 对差集走 `invalidateBtwRequests` 失效支。快照仍含的请求
 * 不动（正例保护）；主会话 sid 由调用方 `isBtwVirtualId` 守卫不放行。触发面 = 现有
 * retainOnly 调用点（BtwPanel 确认条订阅对账），不新增轮询。
 */
export function invalidateBtwStaleFromSnapshot(
  vid: string,
  keepIds: ReadonlySet<string>,
  reason: string,
): void {
  const ids = pendingReqIdsByVid.get(vid)
  if (!ids) return
  const stale = [...ids].filter((id) => !keepIds.has(id))
  if (stale.length === 0) return
  invalidateBtwRequests(vid, stale, reason)
}

/**
 * 回放对账路失效（失效支三路之三，btw-replay 回放链在定格投影落地时同步调用）：
 * 经 core 纯谓词 `hasDanglingInteractiveRequest`（core `domain/chat/btw-dangling-requests.ts`
 * 投影层 SSOT——名单/不变量/层界见其文件头）扫描回放投影，检出即置行内「请求已失效」提示。
 *
 * 信号源 = pi 会话文件持久层（悬空 toolCall 是执行体被杀时留下的持久痕迹），不依赖任何
 * 内存簿记跨进程存活——补快照修剪路（②）的结构性盲区：整机杀重启时本簿记与 runtime
 * pending 同时清零、修剪差集恒空。悬空判定读投影不变量：回放投影中已闭合 toolCall 恒有
 * `output: string`（fillHostToolCall 无条件回填，空串也算闭合），悬空者保持
 * `output === undefined`（V8 已接受面「悬空调用定格 completed 无产出」的同一形态）。
 *
 * 存活挂起守卫（防误报）：该线仍有存活挂起请求（簿记 / store 族任一非空）= 悬空 toolCall
 * 只是「尚未闭合」而非「已失效」——典型如 agent 经 ask_user 提问后用户才首次打开线、或
 * LRU 驱逐后重开时请求仍在等待应答，此时提示失效会与可用表单同屏矛盾，跳过置位。
 * 只写提示不出账：目标场景（重启后首轮回放）簿记恒空无可出账；有簿记的场景已被守卫短路
 * 或由快照修剪路按 requestId 精确出账，本路不做簿记写。
 *
 * 幂等：`expiredNoticeByVid` Map.set 同值幂等，重复回放（驱逐重开）不重复弹；既有提示
 * 不被本路清除（用户 dismiss / 新请求顶掉是仅有的清除支）。
 */
export function markBtwStaleInteractiveFromReplay(vid: string, messages: readonly Message[]): void {
  if (!hasDanglingInteractiveRequest(messages)) return
  if (pendingReqIdsByVid.get(vid)?.size) return
  if (useExtensionUIStore().getRequestsBySession(vid).length > 0) return
  expiredNoticeByVid.set(vid, BTW_EXPIRED_REASON_REPLAY_DANGLING)
}

/** 应答送达后的出账（确认条在 respond 成功支调用；未送达不调——保持挂起可重试） */
export function noteBtwRequestResolved(vid: string, requestId: string): void {
  const ids = pendingReqIdsByVid.get(vid)
  if (!ids) return
  ids.delete(requestId)
  if (ids.size === 0) pendingReqIdsByVid.delete(vid)
}

/** 该 btw 线是否「待处理」（badge 待处理态 = 挂起请求 ∪ 回收提醒，D8 SSOT） */
export function isBtwPending(vid: string): boolean {
  if (reclaimReminderVids.has(vid)) return true
  if (pendingReqIdsByVid.get(vid)?.size) return true
  // store 族兜底（簿记订阅挂上前已入 store 的 form/planReview；读 store 建立响应依赖）
  return useExtensionUIStore().getRequestsBySession(vid).length > 0
}

/** 终态机第四行：回收提醒置位/清除（消费方 = 线列表 reclaimImminent 两路解析点） */
export function setBtwReclaimReminder(vid: string, on: boolean): void {
  if (on) reclaimReminderVids.add(vid)
  else reclaimReminderVids.delete(vid)
}

/** 失效行内提示读取（vid → 非空 reason；无提示 null） */
export function btwExpiredNoticeOf(vid: string): string | null {
  return expiredNoticeByVid.get(vid) ?? null
}

/** 失效提示关闭（用户知晓后清，不回灌待处理） */
export function clearBtwExpiredNotice(vid: string): void {
  expiredNoticeByVid.delete(vid)
}

/** 测试隔离：清空模块级簿记表（订阅退订归 useBtwTabData 的 __resetBtwPendingBookkeepingForTest） */
export function __resetBtwPendingLedgerForTest(): void {
  pendingReqIdsByVid.clear()
  dialogReqsByVid.clear()
  expiredNoticeByVid.clear()
  reclaimReminderVids.clear()
}
