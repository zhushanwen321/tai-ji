/**
 * btw-pending-bookkeeping —— btw 线 D8 终态机簿记（纯状态域：零订阅 / 零 transport / 零组件依赖）。
 *
 * 职责（一件事）：badge「待处理」态与挂起请求生命周期的单一数据源——三张模块级 reactive
 * 表（dialog 族渲染载荷 FIFO `dialogReqsByVid` / 失效行内提示 `expiredNoticeByVid` /
 * 回收提醒 `reclaimReminderVids`）+ 全部状态转移函数。
 * 模块级永驻，不依赖任何组件挂载（drawer 关着 badge 也准确）；reactive 形态供 badge/确认条
 * 在 computed/渲染内读取建立依赖。
 *
 * 依赖边界（层级约束：本模块必须保持在 useBtwTabData 之下、可被 store 层直接消费）：
 * 只 import vue / shared·ui 类型 + stores/extension-ui——不 import bus 订阅
 * （getExtensionBus）、dialog 转换（extension-host-dialog 的 convertToDialogRequest /
 * createUiResponseTransport）与 stores/chat，上述任何一条依赖都会构成
 * store → composable/壳层 → stores/chat 的环。
 * 订阅壳（bus 事件 → 入账）与 transport 应答（respondBtwDialog——送达才出队）在
 * useBtwTabData；虚拟 key 清理登记（btwVirtualKeysByMain 族）同在 useBtwTabData
 * （其处置链需要 stores/chat/workflow/subagent）。
 *
 * 入账：bus 'ui-request'（订阅壳 = useBtwTabData.ensureBtwPendingBookkeeping）写 dialog
 * 族渲染载荷（D8 请求范围 SSOT 五类——ask-user 富表单/scheduler 表单/plan 审批为
 * form∪planReview 帧，载荷本体在 extensionUIStore、不经本簿记；权限审批（ctx.ui.select）
 * 与 confirm·input·editor 为 select/confirm/input/editor 简单 dialog 帧，同通道不单设路由；
 * notify 不注册 pending、setStatus/setWidget 不产 ui_request 帧，方法集天然排除）；
 * 五类任一到达同时顶掉既有失效提示（表单重新可达）。
 * 出账（终态机清除支）：
 * - 应答：store 族在 extensionUIStore 出队（useExtensionUI.respond）；dialog 族走
 *   respondBtwDialog（useBtwTabData——送达才出队，未送达保持挂起可重试）；
 * - 失效：事件帧一路单入口 `invalidateBtwRequests`（bus 'requests-invalidated'——runtime
 *   非 respond 终结的单一出口，订阅壳薄委托）：逐条撤下 dialog 渲染载荷 + 行内提示置位。
 *   store 族挂起的失效出账在 extensionUIStore（useExtensionUI invalidated 订阅
 *   removeRequest），不经本簿记。失效通道只有事件帧：runtime 单独重启（renderer 存活）时
 *   其 pending 内存表清零、空清单不广播失效帧，dialog 族遗留渲染载荷无失效通道——已接受
 *   形态（遗留确认条可见但应答送达失败保持挂起不误出账，新请求顶掉 / 用户 dismiss /
 *   线重开即消失；代价四要素登记见 plan-mode-audit-remediation 设计 D-B2-3）。
 *   `expiredNoticeByVid` 的写方形态：置位 = invalidateBtwRequests 单入口；清除 = 新请求
 *   顶掉（订阅壳入账时 clearBtwExpiredNotice）+ 用户 dismiss（clearBtwExpiredNotice）。
 * - 回收提醒清除支：setBtwReclaimReminder(vid, false) + 线内容增长即清（用户续问的
 *   renderer 可达信号，见 useBtwTabData syncThreadWatchers）。
 * badge 待处理态派生公式（isBtwPending）= extensionUIStore 挂起请求非空 ∪ dialog FIFO
 * 非空 ∪ 回收提醒置位（store 族与 dialog 族挂起各有其载体，无 id 镜像第二副本）。
 * 无超时语义：本簿记不含任何墙钟（D8——pi 源 dialog 无超时，plugin 超时撤窗契约不套用）。
 */
import { reactive } from 'vue'
import type { InternalEvent } from '@taiji/core'
import type { DialogRequest } from '@taiji/ui/extension-host'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** D8 简单 dialog 方法集（权限审批 ctx.ui.select 同通道，不单设路由） */
const BTW_DIALOG_METHODS: readonly string[] = ['confirm', 'select', 'input', 'editor']

/** dialog 族渲染载荷 FIFO（requestId dedup；确认条按 receivedAt 与 store 族合并排序） */
// taste:allow-no-data-owner W24-EX（btw-question M3-c 行内豁免，registry §4 ⑧ 已落定（2026-09-22））：dialog 族渲染载荷 FIFO（非 GUI 数据本体——GUI 呈现副本归确认条实例态）
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

/** dialog 族渲染载荷入队（requestId dedup——实时帧到达时入账，订阅壳调用） */
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

/**
 * 失效支单入口（事件帧失效路唯一写入点，`expiredNoticeByVid` 单状态）：bus
 * 'requests-invalidated' 订阅壳薄委托至此——撤下 dialog 渲染载荷 + 行内提示置位。
 * `stale` 守卫：requestIds 与本线 FIFO 载荷无交集时零副作用（重复帧 / 无关线失效帧均
 * no-op，防噪声提示）。store 族挂起（form/planReview）不在本簿记——其失效出账在
 * extensionUIStore（useExtensionUI invalidated 订阅），见文件头「已接受形态」。
 */
export function invalidateBtwRequests(
  vid: string,
  requestIds: readonly string[],
  reason: string,
): void {
  const stale = new Set(requestIds)
  const list = dialogReqsByVid.get(vid)
  if (!list?.some((d) => stale.has(d.requestId))) return
  setBtwDialogReqs(vid, list.filter((d) => !stale.has(d.requestId)))
  expiredNoticeByVid.set(vid, reason)
}

/** 该 btw 线是否「待处理」（badge 待处理态派生公式三分量，D8 SSOT） */
export function isBtwPending(vid: string): boolean {
  if (reclaimReminderVids.has(vid)) return true
  // dialog 族挂起经 FIFO 分量计入（载荷即挂起事实，无第二副本）
  if ((dialogReqsByVid.get(vid)?.length ?? 0) > 0) return true
  // store 族挂起（载荷本体在 extensionUIStore；读 store 建立响应依赖）
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

/** 失效提示关闭（清除支单入口：用户 dismiss / 新请求顶掉共用；不回灌待处理） */
export function clearBtwExpiredNotice(vid: string): void {
  expiredNoticeByVid.delete(vid)
}

/** 测试隔离：清空模块级簿记表（订阅退订归 useBtwTabData 的 __resetBtwPendingBookkeepingForTest） */
export function __resetBtwPendingLedgerForTest(): void {
  dialogReqsByVid.clear()
  expiredNoticeByVid.clear()
  reclaimReminderVids.clear()
}
