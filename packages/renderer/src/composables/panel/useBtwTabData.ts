/**
 * useBtwTabData —— composer btw 按钮的 badge 数据通道（btw-question §1.4 badge 两态基础 +
 * D7 焦点绑定六条，M3-b）。
 *
 * 职责（M3-b 面）：
 * - **per-主会话数据分区**：线列表 + per-line 未读计数经 `useSessionScopedState` 工厂
 *   （ADR-0049 Map 分区）持有——切主会话分区保留、切回恢复（D7④）；badge 归属各自主会话
 *   （D7③：切走后线照常后台运行，其分区继续累计未读）。
 * - **主动拉取，不依赖广播**（broadcast 时序竞争规则，AGENTS 架构约定）：挂载 / 切会话
 *   立即拉取；抽屉开合、btw tab 切换、选中线变化也重新拉取（新建线入册 / 关线剪枝 /
 *   新线观察挂载）。**W4b 起线列表数据源 = `session.list { surface:'btw', mainSessionId }`**
 *   （btw 线进通用列表，设计 §3.3.1/§5-W4b——原 btw.list 聚合消息已退役，其拉取 reply
 *   与 state 广播双通道一并取消）。badge 通道与 BtwPanel 各自拉取、各自收敛。
 * - **[回收提醒已删除]** 闲置回收机制已随 ADR-0122 整体退役（runtime 侧 `reclaimImminent`
 *   恒 false），其最后一处 feed = 已退役的 btw.list 帧的 `reclaimImminent` 字段；该帧退役后
 *   renderer 半（`reclaimReminderSessionIds` 表 + `setBtwReclaimReminder` +
 *   `isBtwPending` 第三分量）在 btw-pending-bookkeeping 一并删除——死表不留。
 * - **异步回写一律 `updateFor(capturedSid)`**（AGENTS 规则 8）：焦点切走后迟到响应只写
 *   旧分区；同分区旧响应用 loadSeq 丢弃（乱序检查，BtwPanel 同款）。
 * - **未读计数 = 消息事件按线 session id 路由 + updateFor 写分区**（D3 收敛形态）：线消息帧
 *   经 `ensureStreamSubscription(sessionId)` 写入 chatStore 分区（renderer 侧线内容的唯一聚合点，
 *   MessageBus 会话订阅制下 events 层单独挂订阅收不到未订阅线的帧，badge 通道也不
 *   该重复消费 message.* 帧），本模块以**单条** scope 内 watch 观察观察集全线的分区消息
 *   数，增长 delta 按线 id 反查归属主会话后 `updateFor(归属)` 写分区；非视口增长 Σ 计数，
 *   视口内到达不计。**清除 = 线内容进入视口**（D8 终态表「未读」行 SSOT）：drawer 开在
 *   btw tab 且选中该线、绑定 sid = 线归属主会话 ⇒ 视口命中，进入即清。
 * - **虚拟 key 清理登记 + 消费方**（文件底部）：`mainSid → [线 session id]` 映射登记结构——
 *   登记先写后读（M3-b），消费已随 M4-a 接线：deleteSession 级联路径（useSidebar
 *   hooks.evictVirtualKeys 枚举 getBtwSessionIdsByMain → disposeBtwLinePartitions →
 *   clearBtwVirtualKeyMapping）+ 关线路径（本文件 reconcile 出册同拍 dispose）。
 *
 * D8 终态机簿记（badge「待处理」态 + 挂起请求生命周期三张表）在
 * `./btw-pending-bookkeeping`（纯状态域）；本文件持有
 * 其**订阅壳与 transport 半边**——`ensureBtwPendingBookkeeping`（bus 'ui-request' /
 * 'requests-invalidated' / state 帧三订阅 → 簿记入账/失效薄委托）与 `respondBtwDialog`
 * （dialog 族应答，送达才出队出账）。BtwPanel 线列表主数据仍是面板自身拉取（M3-a 形态），
 * 本 composable 不下沉面板编排。已知计数语义：计数 = **观察窗内**分区消息数增长（历史重放
 * 若落在非视口会计入；视口内重放/到达由视口清除支收敛）——对齐 PanelContainer AC-13 未读
 * 先例的取口径。
 */
import { computed, defineComponent, onErrorCaptured, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { disposeLruEntry, isVirtualKeyOf } from '@taiji/core'
import { ensureBtwLineMembership, isKnownBtwLine, noteBtwLinesPulled } from '@/composables/panel/btw-line-membership'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentStore } from '@/stores/subagent'
import {
  getBoundSessionId,
  getDrawerControlState,
  isViewingBtwSession,
  useBtwSelection,
  useBtwViewKey,
} from '@taiji/core/domain/drawer'
import { session } from '@/api'
import type { SessionSummary } from '@taiji/shared'
import {
  convertToDialogRequest,
  createUiResponseTransport,
} from '@taiji/ui/extension-host'
import { getExtensionBus } from '@/composables/shell/useExtensionHostBridge'
import {
  __resetBtwPendingLedgerForTest,
  btwExpiredNoticeOf,
  clearBtwExpiredNotice,
  enqueueBtwDialogReq,
  findBtwDialogReq,
  invalidateBtwRequests,
  isBtwDialogRequest,
  isBtwPending,
  removeBtwDialogReq,
} from '@/composables/panel/btw-pending-bookkeeping'

/** btw 线列表条目类型 = session.list 通用查询的 SessionSummary（W4b：btw 线进通用列表，
 *  原 `BtwThreadInfo`（btw.list reply 条目）随该消息退役——线 id = pi 真实会话 id，
 *  label = `btw-<序号>` 可区分形态，§3.4.3）。 */
export type BtwThreadInfo = SessionSummary

/** per-主会话 btw badge 分区状态（useSessionScopedState 容器契约：必须 reactive） */
// @data-owner #44 —— #44 btw 线列表的 renderer badge 消费分区（session.list
// {surface:'btw', mainSessionId} 拉取喂入；权威源/唯一写入口/空值语义见登记表主表 #44 行，非第二写方）
export interface BtwTabState {
  /** 主会话名下线列表（session.list 拉取产物；badge Σ 的分母面） */
  threads: BtwThreadInfo[]
  loading: boolean
  /** 拉取失败降级留痕（badge 通道失败 = 无 badge 数据，不拖垮 composer；
   *  面板侧可见错误条归 BtwPanel 各自通道） */
  loadError: string | null
  /** 同分区加载序号：旧响应 seq 不匹配即丢弃（乱序检查，搜索 TC-2 loadSeq 同款） */
  loadSeq: number
  /** 线 session id → 未读计数（badge 两态基础的计数面；W4a 后 = pi 真实会话 id）。
   *  「待处理」态与终态机簿记在模块级（D8：drawer 关着 badge 也须准确，见文件下半部
   *  「终态机簿记」），本分区不重复存。 */
  unreadBySessionId: Record<string, number>
}

// ── 线 key 清理登记（M3-b 只建登记结构；deleteSession 级联消费方归 M4-a）────────────
// 形态对齐 workflowStore 的 registerAgentCall / getAgentCallVirtualIdsByMain /
// clearAgentCallMapping 先例（agentcall 两段式无 mainSid 前缀、LRU 前缀清理覆盖不到，
// 映射是该族虚拟 key 清理唯一通路；btw 线分区键 W4a 起 = pi 真实会话 id，清理经本映射枚举）。
// 登记来源 = 本 composable 每次线列表拉取成功后的全量 reconcile（set 替换式，
// 关线/级联移除随下一次拉取自然出册）；registry 模块级存活（不随组件卸载消失），
// 保证 deleteSession 任意时刻消费都能取到当时的全线 id。
// taste:allow-no-data-owner W24-EX-A（全局 sid 协调簿记，**已落定非草稿**——btw-question
// M3-b 行内豁免，data-source-registry §4 ⑧ 已于 M4-a 收敛批补登）：mainSid → btw 线
// session id 反查表，deleteSession 级联清理的枚举路由簿记（非 GUI 数据本体；对照
// shell-adapters requestIdSessions 先例）
const btwSessionKeysByMain = new Map<string, Set<string>>()

/**
 * [M4-a 消费方] 查询主会话名下全部 btw 线 session id（deleteSession 级联时反查，逐一
 * evict 虚拟分区 + abort）。返回后调用方负责 delete chatStore 分区。
 */
export function getBtwSessionIdsByMain(mainSid: string): string[] {
  return [...(btwSessionKeysByMain.get(mainSid) ?? [])]
}

/** [M4-a 消费方] deleteSession 后清映射条目（主会话已删，映射无意义） */
export function clearBtwVirtualKeyMapping(mainSid: string): void {
  btwSessionKeysByMain.delete(mainSid)
}

/**
 * [M4-a 消费方] 线终结分区处置（D9③④「清派生键」单入口，幂等）：
 * ① 派生 subagent 键（`subagent:<owner>:*`——owner = 线 session id，D9③ 键中段位约定；
 *    W4a 后线 id 即 pi 真实会话 id，无前缀翻译层；前缀匹配与 core lru isVirtualKeyOf 同式）；
 * ② 派生 agentcall 键（两段式无 owner 命名空间，经 workflow 映射按**线 session id** 挂名
 *    枚举——D9「清理两半边」，与 m7 先例同构）+ 同点清映射；
 * ③ 两 store 的线记录分区（tray/面板读源随线终结释放）；
 * ④ 线分区本体 + 时序记录（disposeLruEntry，防 sessionLastAccessed 慢增长）。
 * 删除语义**无豁免门**（与 hooks.evictVirtualKeys 的 m7/agentcall 先例同构——线已终结，
 * 不看 streaming/查看态）；重复调用幂等（evictVirtualKey 有 has 检查、Map.delete 幂等）。
 * **失效路径（闲置回收/进程亡）不调本函数**——线可重开，分区保留待重载链回填（D9④）。
 */
export function disposeBtwLinePartitions(sessionId: string): void {
  const chat = useChatStore()
  const owner = sessionId
  for (const key of [...chat.messages.keys()]) {
    if (isVirtualKeyOf(key, owner)) {
      chat.evictVirtualKey(key)
      disposeLruEntry(key)
    }
  }
  const workflow = useWorkflowStore()
  for (const acs of workflow.getAgentCallVirtualIdsByMain(sessionId)) {
    chat.evictVirtualKey(acs)
    disposeLruEntry(acs)
  }
  workflow.clearAgentCallMapping(sessionId)
  workflow.clearSession(sessionId)
  useSubagentStore().clearSession(sessionId)
  chat.evictVirtualKey(sessionId)
  disposeLruEntry(sessionId)
}

/**
 * 拉取成功后的全量 reconcile（set 替换式：权威列表即真源，多余线出册）。
 *
 * [M4-a] 出册线同拍处置分区（三路收敛的前端路径之二）：
 * - `btw.remove` 关线后本通道重新拉取（抽屉活动触发方③）→ 出册线即时清分区+派生键
 *  （与 deleteSession 级联路径同用 disposeBtwLinePartitions 单入口，幂等不重复）；
 * - 主删级联后迟到的空列表拉取 → 不留空 set 残留（被删主的映射条目直接 delete）。
 * 失效路径不受影响：闲置回收/进程亡不改线列表（registry 保留）→ 无出册 → 分区保留（D9④）。
 */
function reconcileBtwSessionKeys(mainSid: string, sessionIds: string[]): void {
  const prev = btwSessionKeysByMain.get(mainSid)
  if (prev) {
    const current = new Set(sessionIds)
    for (const lineSessionId of prev) {
      if (!current.has(lineSessionId)) disposeBtwLinePartitions(lineSessionId)
    }
  }
  if (sessionIds.length === 0) btwSessionKeysByMain.delete(mainSid)
  else btwSessionKeysByMain.set(mainSid, new Set(sessionIds))
}

// ── D8 终态机簿记订阅壳（状态与转移函数在 ./btw-pending-bookkeeping）──────────────

let bookkeepingUnsubs: Array<() => void> | null = null

/** 簿记订阅（模块级单注册永驻——首个 useBtwTabData / useBtwInteraction 调用时挂上，规则 #2 防重复） */
export function ensureBtwPendingBookkeeping(): void {
  if (bookkeepingUnsubs) return
  const bus = getExtensionBus()
  // W4b 收编判别器 = session.list {surface:'btw'} 拉取缓存成员判别（btw 线 dialog 请求
  // 路由到面板内联确认条、不进主视图模态；登记于 docs/constraints.json C-data-28 抑制类
  // 清单；旧 isBtwVirtualId 前缀判别随 vid 退役、session.surfaces 派生表随 W4b 收编删除，
  // 设计 §5-W4b）。表外 = 非线，走主视图模态（原语义）。缓存命中同步判（抽屉拉取预热后
  // 的常态，InternalEventBus 同步派发契约不受影响）；查找落空按需补拉一次再判（拉到即
  // 入账，不猜；拉取失败 = 显式未知，当次不进簿记——失败方向 = 偶发主视图模态，可接受）。
  const judgeLine = (sid: string, onLine: () => void): void => {
    if (isKnownBtwLine(sid)) { onLine(); return }
    void ensureBtwLineMembership(sid).then((isLine) => { if (isLine) onLine() })
  }
  const offUiRequest = bus.on('ui-request', (e) => {
    const sid = e.sessionId
    if (!sid || !isBtwDialogRequest(e)) return
    judgeLine(sid, () => {
      // 新请求顶掉既有失效提示（清除支之一：表单重新可达，提示失义）
      clearBtwExpiredNotice(sid)
      const r = e.request as { form?: unknown; planReview?: unknown }
      if (r.form === true || r.planReview === true) return // store 族载荷在 extensionUIStore，不经本簿记
      enqueueBtwDialogReq(sid, convertToDialogRequest(e))
    })
  })
  const offInvalidated = bus.on('requests-invalidated', (e) => {
    if (!e.sessionId) return
    const sid = e.sessionId
    judgeLine(sid, () => invalidateBtwRequests(sid, e.requestIds, e.reason)) // 事件路薄委托（失效支单入口）
  })
  bookkeepingUnsubs = [offUiRequest, offInvalidated]
}

/** dialog 族应答（D8 提交回路契约：送达才出队 + 出账；已终结目标的应答丢弃）。
 *  出队/出账原语在 btw-pending-bookkeeping；transport（回传双通道，断连提示经壳层回调
 *  注入）是本模块职责——壳层依赖（stores/chat toast 回调）不可进簿记模块（层级约束见其
 *  文件头），故独立 transport 不注入回调（表共管语义见 shell-adapters 模块级表注释）。 */
const dialogTransport = createUiResponseTransport()
export function respondBtwDialog(
  sessionId: string,
  requestId: string,
  result: boolean | string | null,
): boolean {
  const target = findBtwDialogReq(sessionId, requestId)
  if (!target) return false // 已终结（失效已撤下）：应答丢弃，确认条随之重派生
  const delivered = target.source === 'pi'
    ? dialogTransport.sendPiResponse(target.sessionId, target.requestId, target.method, result)
    : dialogTransport.sendPluginResponse(target.requestId, result)
  if (!delivered) return false // 保持挂起（transport 已 toast），连接恢复后可重投
  removeBtwDialogReq(sessionId, requestId)
  return true
}

/** 测试钩子：退订簿记订阅 + 清空簿记表（对齐 __resetXxxForTest 模式） */
export function __resetBtwPendingBookkeepingForTest(): void {
  for (const off of bookkeepingUnsubs ?? []) off()
  bookkeepingUnsubs = null
  __resetBtwPendingLedgerForTest()
}

export interface UseBtwTabDataReturn {
  /** 当前焦点主会话的 btw badge 分区（null sid = 临时默认实例，不写 Map——工厂契约） */
  state: ComputedRef<BtwTabState>
  /** badge 聚合 = 当前主会话名下线的 Σ unread（D7「聚合 = Σ per-line 重算」口径） */
  totalUnread: ComputedRef<number>
  /** badge 待处理聚合 = 名下处于「待处理」（挂起请求 ∪ 回收提醒）的线数（D8 终态机驱动） */
  totalPending: ComputedRef<number>
  /** 主动拉取入口（挂载/切会话/抽屉活动三触发范围共用；captured 分区回写） */
  refresh: (captured: string) => Promise<void>
}

/**
 * 接线 btw badge 数据通道。**必须在组件 setup 同步调用**（watch 立即拉取与未读观察
 * watcher 均挂实例 effect scope，随组件卸载自动停，无需手动编排）。
 *
 * @param sidRef 焦点主会话 id（Composer 的 sessionId prop 包装 computed）
 */
export function useBtwTabData(sidRef: Ref<string | null>): UseBtwTabDataReturn {
  ensureBtwPendingBookkeeping() // D8 终态机簿记：首个实例挂模块级永驻订阅
  const chatStore = useChatStore()

  const scoped = useSessionScopedState<BtwTabState>(sidRef, () =>
    reactive({
      threads: [],
      loading: false,
      loadError: null,
      loadSeq: 0,
      unreadBySessionId: {},
    }),
  )
  const state = computed(() => scoped.current.value)

  /** badge 聚合：只 Σ 权威线列表内的未读（出册线的残留字段由拉取剪枝，聚合范围天然干净） */
  const totalUnread = computed(() => {
    const s = state.value
    let total = 0
    for (const th of s.threads) {
      total += s.unreadBySessionId[th.id] ?? 0
    }
    return total
  })

  /** badge 待处理聚合：Σ 名下处于「待处理」的线（D7 聚合口径，终态机驱动） */
  const totalPending = computed(() => {
    let total = 0
    for (const th of state.value.threads) {
      if (isBtwPending(th.id)) total += 1
    }
    return total
  })

  // ── 视口判定 / 未读清除（D8 终态表「未读」行：线内容进入视口即清）────────────────

  /**
   * 视口命中 = 复合谓词单一源（selection/predicates.ts，getViewedVids 的 btw 豁免同款判据）：
   * 绑定 sid = 线归属主会话 + drawer 开着 + activeTab==='btw' + 选中该线（三分量只在谓词
   * 单一源处拼装，消费侧禁止自行拼装——§7.1 迁出不变量）。
   * drawer 控制态是 per-session 分区（读绑定 sid 的分区），故绑定 sid 不等于归属 sid
   * 时构造性不命中（split/焦点切换窗口期：别的会话的 drawer 不算本线在视口）。
   */
  function isThreadInView(ownerSid: string, sessionId: string): boolean {
    if (getBoundSessionId() !== ownerSid) return false
    return isViewingBtwSession(sessionId)
  }

  function clearUnread(ownerSid: string, sessionId: string): void {
    scoped.updateFor(ownerSid, (s) => {
      if (s.unreadBySessionId[sessionId] !== undefined) delete s.unreadBySessionId[sessionId]
    })
  }

  // ── 未读信号路由（消息事件按线 session id 路由 + updateFor 写分区，D3 收敛形态）──────

  /** 观察集：线 session id → 归属主会话（实例级；refresh 成功后登记增删，无挂/停编排——出册线
   *  剪出登记后签名源收缩即停计，观察本体是下方单条 scope 内 watch，随实例自动停） */
  const lineOwners = new Map<string, string>()
  /** 登记版本号（Map 非响应式，由它承担观察集变化的响应式触发——diff 源的合法依赖） */
  const lineOwnersVersion = ref(0)

  /** refresh 成功后同步观察集（纯登记：入册 set / 本主出册 delete；切走主会话的线保留
   *  登记——后台照常累计未读，D7③） */
  function syncWatchedLines(captured: string, threads: BtwThreadInfo[]): void {
    let touched = false
    for (const th of threads) {
      if (lineOwners.get(th.id) !== captured) {
        lineOwners.set(th.id, captured)
        touched = true
      }
    }
    const alive = new Set(threads.map((th) => th.id))
    for (const [lineSessionId, owner] of lineOwners) {
      if (owner === captured && !alive.has(lineSessionId)) {
        lineOwners.delete(lineSessionId)
        touched = true
      }
    }
    if (touched) lineOwnersVersion.value++
  }

  /** 签名串解析（`sessionId\0len;sessionId\0len` → 线 id → 分区消息数；与下方源构造互逆） */
  function parseLineLens(sig: string): Map<string, number> {
    const lens = new Map<string, number>()
    if (!sig) return lens
    for (const part of sig.split(';')) {
      if (!part) continue
      const sep = part.indexOf('\u0000')
      if (sep < 0) continue // 无 sessionId\0len 结构的残段不成条目
      lens.set(part.slice(0, sep), Number(part.slice(sep + 1)))
    }
    return lens
  }

  /**
   * 未读信号源 = 观察集全线的 chatStore 分区消息数（线消息事件的 renderer 唯一聚合点，
   * 见文件头）。单条 watch（D3 收敛：消 per-线 watcher 的挂/停/差集/disposed 闸编排）：
   * 签名串值比较——prev 无该线 id = 新观察基线不计（对齐 per-线 watcher 创建时基线语义）；
   * 增长 delta 经 routeUnreadGrowth 按线 id 路由。
   * **flush: 'sync'**：diff 逐次写入即时收敛，无批处理合并窗口——跨窗口合并会让「视口
   * 内到达不计」的清除支失真（中间态被跳过即漏清）；源是轻量签名串（线数十量级），
   * 同步 diff 成本可忽略。登记版本号入源依赖：入册/出册（syncWatchedLines）即时反映
   * 到观察范围，不依赖 threads 赋值的先后顺序。
   */
  watch(
    () => {
      void lineOwnersVersion.value
      const parts: string[] = []
      for (const sessionId of lineOwners.keys()) {
        parts.push(`${sessionId}\u0000${chatStore.getMessages(sessionId).length}`)
      }
      parts.sort()
      return parts.join(';')
    },
    (curr, prev) => {
      const base = parseLineLens(prev)
      for (const [sessionId, len] of parseLineLens(curr)) {
        const was = base.get(sessionId)
        if (was === undefined || len <= was) continue
        routeUnreadGrowth(sessionId, len - was)
      }
    },
    { flush: 'sync' },
  )

  /** 单线未读增长路由（视口清除 / 非视口累计，D8 终态表口径） */
  function routeUnreadGrowth(sessionId: string, delta: number): void {
    const owner = lineOwners.get(sessionId)
    if (!owner) return // 出册线：登记已剪，无 badge 信号（对齐「观察已停不再计数」）
    if (isThreadInView(owner, sessionId)) {
      clearUnread(owner, sessionId)
      return
    }
    scoped.updateFor(owner, (s) => {
      s.unreadBySessionId[sessionId] = (s.unreadBySessionId[sessionId] ?? 0) + delta
    })
  }

  // ── 主动拉取（captured 分区回写 + loadSeq 乱序检查）────────────────────────────

  async function refresh(captured: string): Promise<void> {
    let seq = 0
    scoped.updateFor(captured, (s) => {
      s.loadSeq += 1
      seq = s.loadSeq
      s.loading = true
      s.loadError = null
    })
    try {
      // W4b：线列表 = session.list { surface:'btw', mainSessionId }（btw 进通用列表，
      // btw.list 退役）——reply 与 config.sessions 同形（SessionGroup[]），扁平化即
      // 「该主会话名下线列表」（runtime 侧组内按 createdAt 升序，最新线在末位）。
      const groups = await session.listSessions({ surface: 'btw', mainSessionId: captured })
      const threads = groups.flatMap((g) => g.sessions)
      let fresh = false
      scoped.updateFor(captured, (s) => {
        if (s.loadSeq !== seq) return // 同分区旧响应丢弃（双触发并发乱序检查）
        fresh = true
        s.loading = false
        s.threads = threads
        // 权威列表剪枝：出册线的残留未读字段一并清（badge Σ 分母面 = threads）
        for (const key of Object.keys(s.unreadBySessionId)) {
          if (!threads.some((th) => th.id === key)) delete s.unreadBySessionId[key]
        }
      })
      if (!fresh) return // 旧响应：不触碰观察范围与登记范围（新响应各自负责）
      // W4b 收编：本拉取产物喂入抑制类成员判别缓存（同一 session.list 来源，不另起 RPC；
      // merge 口径见 btw-line-membership 模块头）。抽屉打开即是一条拉取时机（设计 §5-W4b ①）。
      noteBtwLinesPulled(threads.map((th) => th.id))
      syncWatchedLines(captured, threads)
      reconcileBtwSessionKeys(
        captured,
        threads.map((th) => th.id),
      )
    } catch (e) {
      // 降级可见留痕（STANDARDS §11 辅助面降级 + 静默丢弃必须登记）：console.warn 对齐
      // btw-replay 同型失败形态（带会话 key 上下文），不抛不刷屏——composer 主链路不受
      // 影响；恢复 = 下次触发方重新拉取
      console.warn(`[useBtwTabData] session.list(surface:'btw') failed for ${captured}:`, e)
      scoped.updateFor(captured, (s) => {
        if (s.loadSeq !== seq) return
        s.loading = false
        s.loadError = e instanceof Error ? e.message : String(e)
      })
    }
  }

  // ── 触发范围 ────────────────────────────────────────────────────────────────────

  // ① 挂载 / 切会话必拉（broadcast 时序竞争规则：切换后主动拉取，不依赖广播）
  watch(
    sidRef,
    (sid) => {
      if (sid) void refresh(sid)
    },
    { immediate: true },
  )

  // ② 视口进入清除：key = 「视口三元组」（绑定 sid + 选中线，useBtwViewKey 复合谓词单一源），
  //    从非视口变视口即清。关闭 drawer / 切到别的 tab → key 归空，不清（瞥见面板不清、
  //    关面板不清——只有线内容真正进视口才清，D8「未读」行）。
  watch(
    useBtwViewKey(),
    (key) => {
      if (!key) return
      const sep = key.indexOf('\u0000')
      const sid = key.slice(0, sep)
      const sessionId = key.slice(sep + 1)
      if (!sid || !sessionId) return
      clearUnread(sid, sessionId)
    },
  )

  // ③ 抽屉活动重新拉取：新建线（面板侧 btw.create）入册 / 关线剪枝（观察集随登记同步收敛，
  //    无独立挂观察动作——新线入册即进签名源）。线列表数据只登记拉取触发方（badge 通道
  //    线列表以拉取为唯一数据源，见文件头）；回收提醒 state 帧广播的订阅独立存在
  //    （global + session 双通道，见 setup 头部）。选中线读 btw 内容域分区（§6.6① 迁出后落点）。
  const { selectedBtwSessionId } = useBtwSelection()
  watch(
    () => {
      const drawer = getDrawerControlState()
      return `${drawer.isOpen ? 1 : 0}|${drawer.activeTab}|${selectedBtwSessionId.value ?? ''}`
    },
    () => {
      const sid = sidRef.value
      if (sid) void refresh(sid)
    },
  )

  return { state, totalUnread, totalPending, refresh }
}


// ── M3-c 面板侧表面编排（BtwPanel setup 调用）：失效提示 + 错误边界 ──

/**
 * 接线 drawer 面板的交互表面（BtwPanel setup 同步调用）：
 * - 失效行内提示读取/关闭（终态机失效支——事件帧失效一路的提示半边，badge 清 + 撤下
 *   同源于 invalidateBtwRequests 单入口）；
 * - 运行期错误边界：onErrorCaptured 绑定调用方组件实例（BtwPanel），Guard 子组件为全部
 *   风险渲染提供子实例——异常收尾为行内错误条 + 重试（key 重挂），不外溢主面板（P2 隔离）。
 * - [状态区退役 2026-10-15 用户裁决] 原「第四面状态区」（setStatus/setWidget per-session
 *   源读线分区渲染）整体移除——btw 线状态区恒空，扩展状态不进旁路线面板。
 */
export function useBtwPanelSurface(sessionIdRef: Ref<string | null>) {
  /** 失效行内提示（终态机失效支；关闭经导出 setter，不回灌待处理） */
  const expiredNotice = computed(() =>
    sessionIdRef.value ? btwExpiredNoticeOf(sessionIdRef.value) : null,
  )
  function dismissExpired(): void {
    if (sessionIdRef.value) clearBtwExpiredNotice(sessionIdRef.value)
  }

  // ── [状态区退役 2026-10-15 用户裁决] 原「第四面状态区」（setStatus/setWidget per-session
  //    源渲染）已整体移除——btw 状态区恒空，STATUS_BAR/VIEW_HOST 源不再被 btw 面板消费。

  // ── 运行期错误边界（P2 降级隔离：btw 交互异常不外溢主面板，单线失败 = 行内错误+可重试）──
  // ec 链从出错实例的 parent 起走（Vue handleError）：Guard 子树（确认条/失效提示，
  // 全部风险渲染均在 Guard slot 内求值）出错 → 本组件 ec 收尾，return false 阻止向 Panel/
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
    interactionError,
    interactionKey,
    retryInteraction,
    BtwInteractionGuard,
  }
}
