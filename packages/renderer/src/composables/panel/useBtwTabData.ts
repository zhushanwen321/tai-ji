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
 *   但本通道是 badge 挂点（composer 侧）的唯一数据源，刻意只走拉取——与 BtwPanel 各自
 *   拉取、双通道同一 payload 各自收敛（M3-a 遗留接线点②「badge 数据自取 btw.list」）。
 * - **异步回写一律 `updateFor(capturedSid)`**（AGENTS 规则 8）：焦点切走后迟到响应只写
 *   旧分区；同分区旧响应用 loadSeq 丢弃（乱序守卫，BtwPanel 同款）。
 * - **未读计数**：per-线 watch chatStore 分区消息数增长（WS → routeInbound → chatStore
 *   的下游观察点，handler 捕获线归属 sid 后 updateFor 回写）；非视口增长 Σ 计数，视口内
 *   到达不计。**清除 = 线内容进入视口**（D8 终态表「未读」行 SSOT）：drawer 开在 btw tab
 *   且选中该线、绑定 sid = 线归属主会话 ⇒ 视口命中，进入即清。
 * - **虚拟 key 清理登记**（文件底部三函数）：`mainSid → [线 vid]` 映射登记结构——先写后读：
 *   M3-b 只建登记，deleteSession 级联消费面（evict chat 分区 + 清映射）归 M4-a。
 *
 * 范围外（扩展面，勿在本单元越界）：
 * - badge「待处理」态 + D8 四行终态机归 **M3-c**（本单元 badge 两态 = 隐藏 / 未读计数；
 *   `BtwTabState.unreadByVid` 字段位即 M3-c 同文件共改的扩展缝）。
 * - BtwPanel 线列表主数据仍是面板自身拉取（M3-a 形态），本 composable 不下沉面板编排。
 * - 已知计数语义：计数 = **观察窗内**分区消息数增长（历史重放若落在非视口会计入；
 *   视口内重放/到达由视口清除支收敛）——对齐 PanelContainer AC-13 未读先例的取口径。
 */
import { computed, onScopeDispose, reactive, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'
import {
  getBoundSessionId,
  getDrawerControlState,
  useDrawerControl,
} from '@taiji/core/domain/drawer'
import { btw } from '@/api'
import type { ServerMessageMap } from '@taiji/shared'

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
  /** vid → 未读计数（badge 两态基础的计数面）。「待处理」态与终态机归 M3-c，
   *  同文件共改时在本结构扩展，不预埋空字段。 */
  unreadByVid: Record<string, number>
}

// ── 虚拟 key 清理登记（M3-b 只建登记结构；deleteSession 级联消费面归 M4-a）──────────
// 形态对齐 workflowStore 的 registerAgentCall / getAgentCallVirtualIdsByMain /
// clearAgentCallMapping 先例（agentcall 两段式无 mainSid 前缀、LRU 前缀清理覆盖不到，
// 映射是该族虚拟 key 清理唯一通路；btw vid 同理是 `btw:` 两段式，清理经注册表枚举）。
// 登记来源 = 本 composable 每次 btw.list 拉取成功后的全量 reconcile（set 替换式，
// 关线/级联移除随下一次拉取自然出册）；registry 模块级存活（不随组件卸载消失），
// 保证 deleteSession 任意时刻消费都能取到当时的全量 vid。
// taste:allow-no-data-owner W24-EX-A（全局 sid 协调簿记，登记草稿——btw-question M3-b
// 领地外，data-source-registry §4 ⑧ 补登折入收口批）：mainSid → btw 线 vid 反查表，
// deleteSession 级联清理的枚举路由簿记（非 GUI 数据本体；对照 extension-host-dialog
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

/** 拉取成功后的全量 reconcile（set 替换式：权威列表即真源，多余 vid 出册） */
function reconcileBtwVirtualKeys(mainSid: string, vids: string[]): void {
  btwVirtualKeysByMain.set(mainSid, new Set(vids))
}

export interface UseBtwTabDataReturn {
  /** 当前焦点主会话的 btw badge 分区（null sid = 临时默认实例，不写 Map——工厂契约） */
  state: ComputedRef<BtwTabState>
  /** badge 聚合 = 当前主会话名下线的 Σ unread（D7「聚合 = Σ per-line 重算」口径） */
  totalUnread: ComputedRef<number>
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
      syncThreadWatchers(captured, threads)
      reconcileBtwVirtualKeys(
        captured,
        threads.map((th) => th.vid),
      )
    } catch (e) {
      scoped.updateFor(captured, (s) => {
        if (s.loadSeq !== seq) return
        s.loading = false
        // 降级可见留痕（STANDARDS §11 辅助面降级 + 静默丢弃必须登记）：通道失败只丢
        // badge 数据，不抛不刷屏——composer 主链路不受影响；恢复 = 下次触发面重拉
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
  //    只登记拉取触发面，不订阅广播（badge 通道以拉取为唯一数据源，见文件头）。
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

  return { state, totalUnread, refresh }
}
