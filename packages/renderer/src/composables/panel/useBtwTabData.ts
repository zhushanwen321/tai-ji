/**
 * useBtwTabData —— composer btw 按钮的 badge 数据通道（btw-question §1.4 badge 两态基础 +
 * D7 焦点绑定六条，M3-b）。
 *
 * 职责（M3-b 面）：
 * - **per-主会话数据分区**：线列表 + per-line 未读计数经 `useSessionScopedState` 工厂
 *   （ADR-0049 Map 分区）持有——切主会话分区保留、切回恢复（D7④）；badge 归属各自主会话
 *   （D7③：切走后线照常后台运行，其分区继续累计未读）。
 * - **主动拉取，不依赖广播**（broadcast 时序竞争规则，AGENTS 架构约定）：挂载 / 切会话
 *   立即 `btw.list { mainSid }`；抽屉开合、btw tab 切换、选中线变化也重拉（新建线入册 /
 *   关线剪枝 / 新线 vid 观察挂载）。M2-a 已把 `btw.list` 登记为 state last-value 广播，
 *   线列表本体仍刻意只走拉取——与 BtwPanel 各自拉取、双通道同一 payload 各自收敛
 *   （M3-a 遗留接线点②「badge 数据自取 btw.list」）。
 * - **回收提醒消费接线（D1 renderer 半边）**：线列表 `reclaimImminent` 两路解析点
 *   （① btw.list 拉取 reply ② state 帧 typeKey 'btw' 广播）均收敛到
 *   `setBtwReclaimReminder(vid, !!imminent)`——true 置位 / false 清除，集合随广播自然翻转。
 *   广播两投递路由：live 帧 payload 无 sessionId 键（双通道同 reply 形 `{ mainSid, threads }`）
 *   → route-inbound 判无 sid 走 **global 通道**（簿记订阅 `onGlobalType('btw.list')`）；
 *   重连/切回的 stateSnapshot('btw') 回放经 replay 按订阅 sid 走 **session 通道**
 *   （useSessionEvents 实例订阅）。两路同帧形同式收敛，幂等可重入。
 * - **异步回写一律 `updateFor(capturedSid)`**（AGENTS 规则 8）：焦点切走后迟到响应只写
 *   旧分区；同分区旧响应用 loadSeq 丢弃（乱序守卫，BtwPanel 同款）。
 * - **未读计数**：per-线 watch chatStore 分区消息数增长（WS → routeInbound → chatStore
 *   的下游观察点，handler 捕获线归属 sid 后 updateFor 回写）；非视口增长 Σ 计数，视口内
 *   到达不计。**清除 = 线内容进入视口**（D8 终态表「未读」行 SSOT）：drawer 开在 btw tab
 *   且选中该线、绑定 sid = 线归属主会话 ⇒ 视口命中，进入即清。
 * - **虚拟 key 清理登记 + 消费面**（文件底部）：`mainSid → [线 vid]` 映射登记结构——
 *   登记先写后读（M3-b），消费已随 M4-a 接线：deleteSession 级联腿（useSidebar
 *   hooks.evictVirtualKeys 枚举 getBtwVirtualIdsByMain → disposeBtwLinePartitions →
 *   clearBtwVirtualKeyMapping）+ 关线腿（本文件 reconcile 出册同拍 dispose）。
 *
 * 范围外（历史登记，M3-c 已承接落地——见文件下半部「终态机簿记」与 useBtwInteraction）：
 * - badge「待处理」态 + D8 四行终态机：**已随 M3-c 落地**（模块级簿记
 *   `pendingReqIdsByVid` + 回收提醒 `reclaimReminderVids` + 导出出账/setter；
 *   `unreadByVid` 既有未读通道不动）。
 * - BtwPanel 线列表主数据仍是面板自身拉取（M3-a 形态），本 composable 不下沉面板编排。
 * - 已知计数语义：计数 = **观察窗内**分区消息数增长（历史重放若落在非视口会计入；
 *   视口内重放/到达由视口清除支收敛）——对齐 PanelContainer AC-13 未读先例的取口径。
 */
import { computed, defineComponent, inject, onErrorCaptured, onScopeDispose, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { isBtwVirtualId, extractBtwPiSessionId } from '@taiji/shared'
import type { Message } from '@taiji/shared'
import { disposeLruEntry, isVirtualKeyOf } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import type { DialogRequest } from '@taiji/ui/extension-host'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentStore } from '@/stores/subagent'
import {
  getBoundSessionId,
  getDrawerControlState,
  useDrawerControl,
} from '@taiji/core/domain/drawer'
import { btw } from '@/api'
import { onGlobalType } from '@taiji/core/transport/api'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import type { ServerMessageMap } from '@taiji/shared'
import { STATUS_BAR_SOURCE_KEY, VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import {
  convertToDialogRequest,
  createUiResponseTransport,
} from '@/composables/shell/extension-host-dialog'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** btw 线列表条目（btw 具名类型走 indexed-access——shared 包出口选择性 re-export，
 *  SSOT = shared protocol.ts，BtwPanel 同款惯例）。 */
export type BtwThreadInfo = ServerMessageMap['btw.list']['threads'][number]

/** per-主会话 btw badge 分区状态（useSessionScopedState 容器契约：必须 reactive） */
export interface BtwTabState {
  /** 主会话名下线列表（btw.list 拉取产物；badge Σ 的分母面） */
  threads: BtwThreadInfo[]
  loading: boolean
  /** 拉取失败降级留痕（badge 通道失败 = 无 badge 数据，不拖垮 composer；
   *  面板侧可见错误条归 BtwPanel 各自通道） */
  loadError: string | null
  /** 同分区加载序号：旧响应 seq 不匹配即丢弃（乱序守卫，搜索 TC-2 loadSeq 同款） */
  loadSeq: number
  /** vid → 未读计数（badge 两态基础的计数面）。「待处理」态与终态机簿记在模块级
   *  （D8：drawer 关着 badge 也须准确，见文件下半部「终态机簿记」），本分区不重复存。 */
  unreadByVid: Record<string, number>
}

// ── 虚拟 key 清理登记（M3-b 只建登记结构；deleteSession 级联消费面归 M4-a）──────────
// 形态对齐 workflowStore 的 registerAgentCall / getAgentCallVirtualIdsByMain /
// clearAgentCallMapping 先例（agentcall 两段式无 mainSid 前缀、LRU 前缀清理覆盖不到，
// 映射是该族虚拟 key 清理唯一通路；btw vid 同理是 `btw:` 两段式，清理经注册表枚举）。
// 登记来源 = 本 composable 每次 btw.list 拉取成功后的全量 reconcile（set 替换式，
// 关线/级联移除随下一次拉取自然出册）；registry 模块级存活（不随组件卸载消失），
// 保证 deleteSession 任意时刻消费都能取到当时的全量 vid。
// taste:allow-no-data-owner W24-EX-A（全局 sid 协调簿记，**已落定非草稿**——btw-question
// M3-b 行内豁免，data-source-registry §4 ⑧ 已于 M4-a 收口批补登）：mainSid → btw 线 vid
// 反查表，deleteSession 级联清理的枚举路由簿记（非 GUI 数据本体；对照 extension-host-dialog
// requestIdSessions 先例）
const btwVirtualKeysByMain = new Map<string, Set<string>>()

/**
 * [M4-a 消费面] 查询主会话名下全部 btw 线 vid（deleteSession 级联时反查，逐一 evict
 * 虚拟分区 + abort）。返回后调用方负责 delete chatStore 分区。
 */
export function getBtwVirtualIdsByMain(mainSid: string): string[] {
  return [...(btwVirtualKeysByMain.get(mainSid) ?? [])]
}

/** [M4-a 消费面] deleteSession 后清映射条目（主会话已删，映射无意义） */
export function clearBtwVirtualKeyMapping(mainSid: string): void {
  btwVirtualKeysByMain.delete(mainSid)
}

/**
 * [M4-a 消费面] 线终结分区处置（D9③④「清派生键」单入口，幂等）：
 * ① 派生 subagent 键（`subagent:<owner>:*`——owner = 线 piSessionId，D9③ 键中段位约定，
 *    映射即 extract；前缀匹配与 core lru isVirtualKeyOf 同式）；
 * ② 派生 agentcall 键（两段式无 owner 命名空间，经 workflow 映射按**线 vid** 挂名枚举——
 *    D9「清理两半边」，与 m7 先例同构）+ 同点清映射；
 * ③ 两 store 的线记录分区（tray/面板读源随线终结释放）；
 * ④ 线分区本体 + 时序记录（disposeLruEntry，防 sessionLastAccessed 慢增长）。
 * 删除语义**无豁免门**（与 hooks.evictVirtualKeys 的 m7/agentcall 先例同构——线已终结，
 * 不看 streaming/查看态）；重复调用幂等（evictVirtualKey 有 has 守卫、Map.delete 幂等）。
 * **失效腿（闲置回收/进程亡）不调本函数**——线可重开，分区保留待重载链回填（D9④）。
 */
export function disposeBtwLinePartitions(vid: string): void {
  const chat = useChatStore()
  const owner = isBtwVirtualId(vid) ? extractBtwPiSessionId(vid) : vid
  for (const key of [...chat.messages.keys()]) {
    if (isVirtualKeyOf(key, owner)) {
      chat.evictVirtualKey(key)
      disposeLruEntry(key)
    }
  }
  const workflow = useWorkflowStore()
  for (const acs of workflow.getAgentCallVirtualIdsByMain(vid)) {
    chat.evictVirtualKey(acs)
    disposeLruEntry(acs)
  }
  workflow.clearAgentCallMapping(vid)
  workflow.clearSession(vid)
  useSubagentStore().clearSession(vid)
  chat.evictVirtualKey(vid)
  disposeLruEntry(vid)
}

/**
 * 拉取成功后的全量 reconcile（set 替换式：权威列表即真源，多余 vid 出册）。
 *
 * [M4-a] 出册线同拍处置分区（三路收敛的前端腿之二）：
 * - `btw.remove` 关线后本通道重拉（抽屉活动触发面③）→ 出册 vid 即时清分区+派生键
 *  （与 deleteSession 级联腿同用 disposeBtwLinePartitions 单入口，幂等不重复）；
 * - 主删级联后迟到的空列表拉取 → 不留空 set 残留（被删主的映射条目直接 delete）。
 * 失效腿不受影响：闲置回收/进程亡不改线列表（registry 保留）→ 无出册 → 分区保留（D9④）。
 */
function reconcileBtwVirtualKeys(mainSid: string, vids: string[]): void {
  const prev = btwVirtualKeysByMain.get(mainSid)
  if (prev) {
    const current = new Set(vids)
    for (const vid of prev) {
      if (!current.has(vid)) disposeBtwLinePartitions(vid)
    }
  }
  if (vids.length === 0) btwVirtualKeysByMain.delete(mainSid)
  else btwVirtualKeysByMain.set(mainSid, new Set(vids))
}

// ── D8 终态机簿记（M3-c 扩展面：badge 待处理态 + 挂起请求生命周期四行）──────────
//
// 单一数据源 = `pendingReqIdsByVid`（btw 线的 D8 类挂起请求 requestId 集合）——模块级
// 永驻 bus 订阅写入，不依赖任何组件挂载（drawer 关着 badge 也准确）；第四行「回收提醒」
// = `reclaimReminderVids`（非终态，setter 置位/清除；数据源 = 线列表 `reclaimImminent`
// 两路解析点：btw.list 拉取 reply + state 帧广播，见文件头「回收提醒消费接线」）。
//
// 入账：bus 'ui-request'（D8 请求范围 SSOT 五类——ask-user 富表单/scheduler 表单/plan
// 审批为 form∪planReview 帧；权限审批（ctx.ui.select）与 confirm·input·editor 为
// select/confirm/input/editor 简单 dialog 帧，同通道不单设路由；notify 不注册 pending、
// setStatus/setWidget 不产 ui_request 帧，方法集天然排除）。
// 出账（终态机清除支）：
// - 应答：store 族经 useExtensionUI.respond 出队后由确认条调 noteBtwRequestResolved；
//   dialog 族走 respondBtwDialog（送达才出队出账——未送达保持挂起可重试）；
// - 撤回 / 失效：`invalidateBtwRequests` 单入口（两路写入合并收口）：① 事件路 = bus
//   'requests-invalidated'（runtime 非 respond 终结单一出口）订阅薄委托；② 快照修剪路 =
//   `invalidateBtwStaleFromSnapshot`（useExtensionUI retainOnly 对账差集联动，补「runtime
//   进程死亡后 pending 内存表清零 → 空清单不广播失效帧」的结构性缺口——重启后遗留挂起在
//   首次对账时转为行内已失效提示）。逐条出账 + 行内提示置位 + dialog 渲染载荷同步撤下；
//   ③ 回放对账路 = `markBtwStaleInteractiveFromReplay`（btw-replay 回放链联动，补快照修剪
//   路的残余盲区：整机杀重启时本簿记与 runtime pending 同时清零、修剪差集恒空结构性不触发
//   ——以 pi 会话文件中悬空的交互请求 toolCall 持久痕迹为信号源置位，只写提示不出账）。
//   `expiredNoticeByVid` 的写方形态：置位 = ②差集支 + ③回放路 两函数；清除 = 新请求顶掉 +
//   用户 dismiss。各写方互不清除他路产物（②首条版本保留语义见 invalidateBtwRequests 注释；
//   ③同值幂等、不覆盖既有提示）。
// - 回收提醒清除支：setBtwReclaimReminder(vid, false) + 线内容增长即清（用户续问的
//   renderer 可达信号，见 syncThreadWatchers）。
// 无超时语义：本簿记不含任何墙钟（D8——pi 源 dialog 无超时，plugin 超时撤窗契约不套用）。

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
function isBtwDialogRequest(e: UiRequestEvent): boolean {
  const r = e.request as { form?: unknown; planReview?: unknown; method?: unknown }
  if (r.form === true || r.planReview === true) return true
  return typeof r.method === 'string' && BTW_DIALOG_METHODS.includes(r.method)
}

let bookkeepingUnsubs: Array<() => void> | null = null

/** 簿记订阅（模块级单注册永驻——首个 useBtwTabData / useBtwInteraction 调用时挂上，规则 #2 防重复） */
export function ensureBtwPendingBookkeeping(): void {
  if (bookkeepingUnsubs) return
  const bus = getExtensionBus()
  // [D1 renderer 半边] state 帧 typeKey 'btw' 的 live 广播：payload 无 sessionId 键 →
  // route-inbound 判无 sid 走 global 通道（onGlobalType 是本帧 live 面的唯一到达点）。
  // stateSnapshot('btw') 回放腿走 session 通道，由 useBtwTabData 实例经 useSessionEvents 订阅。
  const offThreadList = onGlobalType('btw.list', (msg) => {
    syncReclaimReminders(msg.payload.threads)
  })
  const offUiRequest = bus.on('ui-request', (e) => {
    const sid = e.sessionId
    if (!sid || !isBtwVirtualId(sid) || !isBtwDialogRequest(e)) return
    let ids = pendingReqIdsByVid.get(sid)
    if (!ids) {
      ids = new Set()
      pendingReqIdsByVid.set(sid, ids)
    }
    ids.add(e.request.requestId)
    expiredNoticeByVid.delete(sid) // 新请求顶掉失效提示（表单重新可达）
    const r = e.request as { form?: unknown; planReview?: unknown }
    if (r.form === true || r.planReview === true) return // store 族载荷在 extensionUIStore（本簿记只记 id）
    const list = dialogReqsByVid.get(sid) ?? []
    if (list.some((d) => d.requestId === e.request.requestId)) return // requestId dedup（双源幂等）
    dialogReqsByVid.set(sid, [...list, convertToDialogRequest(e)])
  })
  const offInvalidated = bus.on('requests-invalidated', (e) => {
    if (!e.sessionId || !isBtwVirtualId(e.sessionId)) return
    invalidateBtwRequests(e.sessionId, e.requestIds, e.reason) // 事件路薄委托（失效支单入口）
  })
  bookkeepingUnsubs = [offUiRequest, offInvalidated, offThreadList]
}

/** 快照修剪路失效 reason（簿记值——展示文案固定 i18n `btw.interaction.expiredNotice`
 *  不按 reason 分支；语义 = runtime 重启后遗留挂起经首次快照对账确认失效） */
export const BTW_EXPIRED_REASON_SNAPSHOT_PRUNED = 'snapshot-pruned'

/** 回放对账路失效 reason（簿记值，展示同上；语义 = 回放投影检出悬空交互请求 toolCall
 *  且该线无存活挂起——整机杀重启后首轮回放的确证失效信号，信号源 = pi 会话文件持久层） */
export const BTW_EXPIRED_REASON_REPLAY_DANGLING = 'replay-dangling'

/**
 * 交互请求类工具名（回放对账路的悬空判定名单，窄而准——宁漏不误）。口径 = D8 请求范围
 * 五类中「以本名工具 toolCall 持久化、且执行体阻塞等待用户应答」的子集：
 * - `ask_user`：ask-user 富提问表单（extensions/universal/ask-user/src/index.ts registerTool）
 * - `schedule`：scheduler 建单表单（extensions/universal/scheduler/src/index.ts registerTool，
 *   interaction.ts 经 uiFormInteract 阻塞等应答）
 * - `plan`：plan 模式生命周期（extensions/universal/plan/src/tool.ts registerTool，
 *   submit-review 阻塞等用户审批）
 * 刻意排除（按名不可辨识或非用户对话等待）：`schedule_control`（纯服务调用无 UI 阻塞）；
 * session-manager 六工具（SESSION_MANAGER_MARKER 机器 RPC 通道，亚秒级非用户应答）；
 * permission 审批与 confirm/input/editor 简单 dialog（挂在 bash/edit 等普通工具执行体或
 * extension 内部调用上，悬空 toolCall 名不可辨识——误标普通工具即违名单窄而准）；
 * plugin-bridge 动态插件工具（非 taiji 交互请求族）。
 */
const BTW_INTERACTIVE_REQUEST_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'schedule', 'plan'])

/**
 * 失效支单入口（两路写入合并收口，`expiredNoticeByVid` 单状态）：事件路订阅与快照修剪路
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
  if (list) {
    const next = list.filter((d) => !requestIds.includes(d.requestId))
    if (next.length > 0) dialogReqsByVid.set(vid, next)
    else dialogReqsByVid.delete(vid)
  }
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
 * 扫描回放投影 messages 中的悬空交互请求 toolCall（`BTW_INTERACTIVE_REQUEST_TOOLS` 命名 +
 * 无 toolResult 回填），检出即置行内「请求已失效」提示。
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
  let hasDangling = false
  for (const m of messages) {
    const tcs = m.toolCalls
    if (!tcs) continue
    if (tcs.some((tc) => tc.output === undefined && BTW_INTERACTIVE_REQUEST_TOOLS.has(tc.toolName))) {
      hasDangling = true
      break
    }
  }
  if (!hasDangling) return
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

/**
 * 线列表 `reclaimImminent` → 回收提醒集合收敛（两路解析点共用单一实现，防映射漂移）：
 * 对每条线 `setBtwReclaimReminder(vid, !!info.reclaimImminent)`——true 置位、false/缺省清除，
 * 广播携带全量线列表 → 集合随每次帧自然翻转。只触帧内 vid（他主会话的提醒不受影响；
 * 出册线的残留条目不进 badge 聚合——totalPending 分母 = 当前线列表）。
 */
function syncReclaimReminders(threads: BtwThreadInfo[]): void {
  for (const th of threads) setBtwReclaimReminder(th.vid, th.reclaimImminent === true)
}

/** 失效行内提示读取（vid → 非空 reason；无提示 null） */
export function btwExpiredNoticeOf(vid: string): string | null {
  return expiredNoticeByVid.get(vid) ?? null
}

/** 失效提示关闭（用户知晓后清，不回灌待处理） */
export function clearBtwExpiredNotice(vid: string): void {
  expiredNoticeByVid.delete(vid)
}

/** dialog 族应答（D8 提交回路契约：送达才出队 + 出账；已终结目标的应答丢弃） */
const dialogTransport = createUiResponseTransport()
export function respondBtwDialog(
  vid: string,
  requestId: string,
  result: boolean | string | null,
): boolean {
  const list = dialogReqsByVid.get(vid) ?? []
  const target = list.find((d) => d.requestId === requestId)
  if (!target) return false // 已终结（失效已撤下）：应答丢弃，确认条随之重派生
  const delivered = target.source === 'pi'
    ? dialogTransport.sendPiResponse(target.sessionId, target.requestId, target.method, result)
    : dialogTransport.sendPluginResponse(target.requestId, result)
  if (!delivered) return false // 保持挂起（transport 已 toast），连接恢复后可重投
  const next = list.filter((d) => d.requestId !== requestId)
  if (next.length > 0) dialogReqsByVid.set(vid, next)
  else dialogReqsByVid.delete(vid)
  noteBtwRequestResolved(vid, requestId)
  return true
}

/** dialog 族队首读取（并发排序的 dialog 侧候选；useBtwInteraction 消费） */
export function firstBtwDialogReq(vid: string): DialogRequest | undefined {
  return dialogReqsByVid.get(vid)?.[0]
}

/** 测试钩子：清空模块级簿记与订阅（对齐 __resetXxxForTest 模式） */
export function __resetBtwPendingBookkeepingForTest(): void {
  for (const off of bookkeepingUnsubs ?? []) off()
  bookkeepingUnsubs = null
  pendingReqIdsByVid.clear()
  dialogReqsByVid.clear()
  expiredNoticeByVid.clear()
  reclaimReminderVids.clear()
}

export interface UseBtwTabDataReturn {
  /** 当前焦点主会话的 btw badge 分区（null sid = 临时默认实例，不写 Map——工厂契约） */
  state: ComputedRef<BtwTabState>
  /** badge 聚合 = 当前主会话名下线的 Σ unread（D7「聚合 = Σ per-line 重算」口径） */
  totalUnread: ComputedRef<number>
  /** badge 待处理聚合 = 名下处于「待处理」（挂起请求 ∪ 回收提醒）的线数（D8 终态机驱动） */
  totalPending: ComputedRef<number>
  /** 主动拉取入口（挂载/切会话/抽屉活动三触发面共用；captured 分区回写） */
  refresh: (captured: string) => Promise<void>
}

/**
 * 接线 btw badge 数据通道。**必须在组件 setup 同步调用**（watch 立即拉取与 onScopeDispose
 * 依赖实例上下文；per-线消息 watch 在拉取 resolve 后创建（无组件实例），由本函数的
 * onScopeDispose 统一停——disposed 闸防「卸载后在途拉取补建 watch」泄漏）。
 *
 * @param sidRef 焦点主会话 id（Composer 的 sessionId prop 包装 computed）
 */
export function useBtwTabData(sidRef: Ref<string | null>): UseBtwTabDataReturn {
  ensureBtwPendingBookkeeping() // D8 终态机簿记：首个实例挂模块级永驻订阅
  // 回收提醒 state 帧 session 通道腿（stateSnapshot('btw') 重连/切回回放）：live 帧走
  // global 通道（簿记订阅），回放帧走本通道——同帧形同式收敛到回收提醒集合。
  // 订阅/重订/卸载生命周期归 useSessionEvents（规则 2 防重复：本实例单条底层订阅 + type 路由）。
  const onSessionMessage = useSessionEvents(sidRef)
  onSessionMessage('btw.list', (msg) => {
    syncReclaimReminders(msg.payload.threads)
  })
  const chatStore = useChatStore()

  const scoped = useSessionScopedState<BtwTabState>(sidRef, () =>
    reactive({
      threads: [],
      loading: false,
      loadError: null,
      loadSeq: 0,
      unreadByVid: {},
    }),
  )
  const state = computed(() => scoped.current.value)

  /** badge 聚合：只 Σ 权威线列表内的未读（出册线的残留字段由拉取剪枝，聚合面天然干净） */
  const totalUnread = computed(() => {
    const s = state.value
    let total = 0
    for (const th of s.threads) {
      total += s.unreadByVid[th.vid] ?? 0
    }
    return total
  })

  /** badge 待处理聚合：Σ 名下处于「待处理」的线（D7 聚合口径，终态机驱动） */
  const totalPending = computed(() => {
    let total = 0
    for (const th of state.value.threads) {
      if (isBtwPending(th.vid)) total += 1
    }
    return total
  })

  /** scope dispose 闸：onScopeDispose 后在途拉取不得再补建 per-线 watch（防泄漏） */
  let disposed = false

  // ── 视口判定 / 未读清除（D8 终态表「未读」行：线内容进入视口即清）────────────────

  /**
   * 视口命中 = 三分量同源（getViewedVids 的 btw 豁免同款判据）：
   * 绑定 sid = 线归属主会话 + drawer 开着 + activeTab==='btw' + 选中该线。
   * drawer 控制态是 per-session 分区（读绑定 sid 的分区），故绑定 sid 不等于归属 sid
   * 时构造性不命中（split/焦点切换窗口期：别的会话的 drawer 不算本线在视口）。
   */
  function isThreadInView(ownerSid: string, vid: string): boolean {
    if (getBoundSessionId() !== ownerSid) return false
    const drawer = getDrawerControlState()
    return drawer.isOpen && drawer.activeTab === 'btw' && drawer.selectedBtwVid === vid
  }

  function clearUnread(ownerSid: string, vid: string): void {
    scoped.updateFor(ownerSid, (s) => {
      if (s.unreadByVid[vid] !== undefined) delete s.unreadByVid[vid]
    })
  }

  // ── per-线未读观察（线归属 sid 在拉取时捕获；handler 回写恒 updateFor(captured)）──

  /** vid → { 归属 sid, stop }（实例级；线出册 / scope dispose 时停） */
  const threadWatchers = new Map<string, { sid: string; stop: () => void }>()

  function syncThreadWatchers(captured: string, threads: BtwThreadInfo[]): void {
    if (disposed) return
    // 出册线：停观察（关线/级联移除后其分区不再产生 badge 信号）
    const alive = new Set(threads.map((th) => th.vid))
    for (const [vid, entry] of threadWatchers) {
      if (entry.sid === captured && !alive.has(vid)) {
        entry.stop()
        threadWatchers.delete(vid)
      }
    }
    for (const th of threads) {
      if (threadWatchers.has(th.vid)) continue
      const owner = captured
      const vid = th.vid
      // 消息数增长（WS 下游观察点）：视口内到达 → 清（不计）；非视口 → Σ 计数。
      // watch 创建于拉取 resolve 之后（无组件实例上下文）→ 不自动随 scope 停，
      // 由 onScopeDispose 遍历 threadWatchers 统一 stop。
      const stop = watch(
        () => chatStore.getMessages(vid).length,
        (len, prev) => {
          if (len <= prev) return
          // 回收提醒清除支（D8 第四行）：线内容增长 = 用户续问/活动已发生，提醒即清
          if (reclaimReminderVids.has(vid)) reclaimReminderVids.delete(vid)
          if (isThreadInView(owner, vid)) {
            clearUnread(owner, vid)
            return
          }
          scoped.updateFor(owner, (s) => {
            s.unreadByVid[vid] = (s.unreadByVid[vid] ?? 0) + (len - prev)
          })
        },
      )
      threadWatchers.set(vid, { sid: owner, stop })
    }
  }

  // ── 主动拉取（captured 分区回写 + loadSeq 乱序守卫）────────────────────────────

  async function refresh(captured: string): Promise<void> {
    let seq = 0
    scoped.updateFor(captured, (s) => {
      s.loadSeq += 1
      seq = s.loadSeq
      s.loading = true
      s.loadError = null
    })
    try {
      const threads = await btw.list(captured)
      let fresh = false
      scoped.updateFor(captured, (s) => {
        if (s.loadSeq !== seq) return // 同分区旧响应丢弃（双触发并发乱序守卫）
        fresh = true
        s.loading = false
        s.threads = threads
        // 权威列表剪枝：出册线的残留未读字段一并清（badge Σ 分母面 = threads）
        for (const key of Object.keys(s.unreadByVid)) {
          if (!threads.some((th) => th.vid === key)) delete s.unreadByVid[key]
        }
      })
      if (!fresh) return // 旧响应：不触碰观察面与登记面（新响应各自负责）
      syncReclaimReminders(threads)
      syncThreadWatchers(captured, threads)
      reconcileBtwVirtualKeys(
        captured,
        threads.map((th) => th.vid),
      )
    } catch (e) {
      // 降级可见留痕（STANDARDS §11 辅助面降级 + 静默丢弃必须登记）：console.warn 对齐
      // btw-replay 同型失败形态（带会话 key 上下文），不抛不刷屏——composer 主链路不受
      // 影响；恢复 = 下次触发面重拉
      console.warn(`[useBtwTabData] btw.list failed for ${captured}:`, e)
      scoped.updateFor(captured, (s) => {
        if (s.loadSeq !== seq) return
        s.loading = false
        s.loadError = e instanceof Error ? e.message : String(e)
      })
    }
  }

  // ── 触发面 ────────────────────────────────────────────────────────────────────

  // ① 挂载 / 切会话必拉（broadcast 时序竞争规则：切换后主动拉取，不依赖广播）
  watch(
    sidRef,
    (sid) => {
      if (sid) void refresh(sid)
    },
    { immediate: true },
  )

  const { isOpen, activeTab, selectedBtwVid } = useDrawerControl()

  // ② 视口进入清除：key = 「视口三元组」（绑定 sid + 选中线），从非视口变视口即清。
  //    关闭 drawer / 切到别的 tab → key 归空，不清（瞥见面板不清、关面板不清——只有
  //    线内容真正进视口才清，D8「未读」行）。
  watch(
    () => {
      if (!isOpen.value || activeTab.value !== 'btw') return ''
      return `${getBoundSessionId() ?? ''}\u0000${selectedBtwVid.value ?? ''}`
    },
    (key) => {
      if (!key) return
      const sep = key.indexOf('\u0000')
      const sid = key.slice(0, sep)
      const vid = key.slice(sep + 1)
      if (!sid || !vid) return
      clearUnread(sid, vid)
    },
  )

  // ③ 抽屉活动重拉：新建线（面板侧 btw.create）入册 / 关线剪枝 / 新选中线挂观察。
  //    线列表数据只登记拉取触发面（badge 通道线列表以拉取为唯一数据源，见文件头）；
  //    回收提醒 state 帧广播的订阅独立存在（global + session 双通道，见 setup 头部）。
  watch(
    () => {
      const drawer = getDrawerControlState()
      return `${drawer.isOpen ? 1 : 0}|${drawer.activeTab}|${drawer.selectedBtwVid ?? ''}`
    },
    () => {
      const sid = sidRef.value
      if (sid) void refresh(sid)
    },
  )

  onScopeDispose(() => {
    disposed = true
    for (const entry of threadWatchers.values()) entry.stop()
    threadWatchers.clear()
  })

  return { state, totalUnread, totalPending, refresh }
}


// ── M3-c 面板侧表面编排（BtwPanel setup 调用）：失效提示 + 第四面状态区 + 错误边界 ──

/**
 * 接线 drawer 面板的交互表面（BtwPanel setup 同步调用）：
 * - 失效行内提示读取/关闭（终态机失效支，badge 清 + 撤下 + 提示两路合并收口的提示半边）；
 * - 第四面状态区（setStatus/setWidget 的 per-session 源读 vid 分区；inject 缺失静默空态；
 *   toolbar/tab-bar 无 session 帧不在路由面——V4⑤ 结论）；
 * - 运行期错误边界：onErrorCaptured 绑定调用方组件实例（BtwPanel），Guard 子组件为全部
 *   风险渲染提供子实例——异常收口为行内错误条 + 重试（key 重挂），不外溢主面板（P2 隔离）。
 */
export function useBtwPanelSurface(vidRef: Ref<string | null>) {
/** 失效行内提示（终态机失效支；关闭经导出 setter，不回灌待处理） */
  const expiredNotice = computed(() =>
    vidRef.value ? btwExpiredNoticeOf(vidRef.value) : null,
  )
  function dismissExpired(): void {
    if (vidRef.value) clearBtwExpiredNotice(vidRef.value)
  }

  // ── 第四面状态区（非模态 extension GUI 的 drawer 归属；inject 缺失静默空态）──
  const statusBarSource = inject(STATUS_BAR_SOURCE_KEY, null)
  const viewHostSource = inject(VIEW_HOST_SOURCE_KEY, null)
  const statusEntries = computed(() => {
    const vid = vidRef.value
    if (!vid || !statusBarSource) return []
    return statusBarSource.getItems('per-session', vid)
  })
  /** setWidget 文本行（widget lines；结构化 widgetGui 组件不在本状态区降级渲染——偏差登记） */
  const widgetLines = computed<string[]>(() => {
    const vid = vidRef.value
    if (!vid || !viewHostSource) return []
    const out: string[] = []
    for (const viewId of viewHostSource.getViewIds(vid)) {
      const entry = viewHostSource.getView(vid, viewId)
      if (!entry) continue
      for (const comp of entry.guiTree) {
        if (comp.type === 'ansi-text' && 'lines' in comp.props && Array.isArray(comp.props.lines)) {
          for (const line of comp.props.lines) {
            if (typeof line === 'string') out.push(line)
          }
        }
      }
    }
    return out
  })
  const STATUS_DOT_CLASS: Record<string, string> = {
    ok: 'bg-success',
    warn: 'bg-warn',
    danger: 'bg-danger',
    neutral: 'bg-neutral-faint',
    'plugin-src': 'bg-accent',
  }
  function statusDotClass(status: string): string {
    return STATUS_DOT_CLASS[status] ?? 'bg-neutral-faint'
  }

  // ── 运行期错误边界（P2 降级隔离：btw 交互异常不外溢主面板，单线失败 = 行内错误+可重试）──
  // ec 链从出错实例的 parent 起走（Vue handleError）：Guard 子树（确认条/状态区/失效提示，
  // 全部风险渲染均在 Guard slot 内求值）出错 → 本组件 ec 收口，return false 阻止向 Panel/
  // App 冒泡；MessageStream/Composer 不在 Guard 内，其错误行为与改造前一致。
  const interactionError = ref(false)
  const interactionKey = ref(0)
  onErrorCaptured((err) => {
    console.error('[BtwPanel] btw interaction error contained:', err)
    interactionError.value = true
    return false
  })
  function retryInteraction(): void {
    interactionError.value = false
    interactionKey.value += 1
  }

  /** 交互子树渲染哨兵（同文件内联子组件：为 ec 提供子实例，自身不渲染额外 DOM） */
  const BtwInteractionGuard = defineComponent({
    name: 'BtwInteractionGuard',
    setup(_, { slots }) {
      return () => (slots.default ? slots.default() : null)
    },
  })

  return {
    expiredNotice,
    dismissExpired,
    statusEntries,
    widgetLines,
    statusDotClass,
    interactionError,
    interactionKey,
    retryInteraction,
    BtwInteractionGuard,
  }
}
