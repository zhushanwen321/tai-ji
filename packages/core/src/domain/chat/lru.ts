/**
 * W3 H3：chat store LRU 驱逐模块。
 *
 * 对应 FR-1 + D2/D6/D13 + AC-1/2/8/9。
 *
 * 核心策略：
 * - 切走 session 时触发 evictIfNeeded
 * - 保留最近 K=LRU_MAX_SESSIONS(8) 个 + streaming/pending/compacting 豁免的
 * - panel 绑定 session 由 composable 层（useSidebar.selectSession）在 evictIfNeeded 前
 *   刷新 recency 保护（lru-panel-exempt-fix），不在本模块的 isExempt 内判定——
 *   evictSessionWithVirtual 与 evictIfNeeded 共用 isExempt，若加 panel 检查会让
 *   deleteSession 流程中被删 session（必然还绑定 panel）被 exempt 拦截 → 内存泄漏
 * - 驱逐用 delete key（与 disposeSession 一致，D13）
 * - subagent:xxx 三段式虚拟 key 按主 session 前缀同步驱逐（M7 修复，AC-2）
 * - agentcall:xxx 两段式虚拟 key 经注入回调联动驱逐（B9，memory-leak-remediation §3.3-B9）：
 *   主 session 被驱逐时由装配侧回调（agentCallEvictionsOf，workflow store 映射 ∖ viewedVids
 *   豁免）返回待释放的 agentcall virtualId，本模块执行删除——豁免源钉死 panel 枚举
 *   （core/domain/drawer/control.ts getViewedVids），禁止 drawer 分区全枚举（曾开过 drawer
 *   的 session 焦点切走后分区保留，全枚举会永久过度豁免，R2 S1）。deleteSession 路径的
 *   agentcall 清理仍走 hooks.evictVirtualKeys（workflow 映射全量，无豁免——session 已删）
 * - 驱逐时同步清 hydrated 标记（AC-8：切回重新 hydrate）
 *
 * LRU 时序：用模块级 Map<sessionId, timestamp> 记录访问顺序。
 * touchLru 更新时间戳，evictIfNeeded 按时间戳排序驱逐最久未访问的。
 *
 * streaming 豁免（AC-9/SR5）：复用 store 的 isGenerating/isActive/isCompacting 判定。
 * 驱逐前 double-check streaming 状态（SR8 竞态防护）。
 */

// 相对路径直达定义处（mutations.ts）：经 '@xyz-agent/core' barrel 回引会成环
// （index re-export 本模块，本模块又 import index），ESM 序隐患
import { deleteMessages } from './mutations'

/**
 * LRU 保留阈值：最近 8 个 session（D6）。
 * 不含 streaming/pending/compacting 豁免的（isExempt 判定）。
 * panel 绑定 session 不在本阈值/豁免集内判定，由 composable 层刷新 recency 保护（见文件头注释）。
 */
export const LRU_MAX_SESSIONS = 8

/**
 * 运行时可变上限覆盖（memory-relief 压窗，crash-forensics §3.3 D4 / 偏差 #28②）。
 * null = 未压窗，按默认 LRU_MAX_SESSIONS；number = 压窗值（ relief 期间生效）。
 *
 * 并发/边界（单线程 JS 无真并发，本注记登记交错语义）：
 * - setter 幂等，重复设置同值无副作用；null 恢复默认（读面 getLruMaxSessions 单点消费，
 *   evictIfNeeded 每次调用现读——压窗后已被驱逐的 session 不回补，恢复默认只影响后续判定）；
 * - 下限钳制 ≥1：压到 0 = 全量驱逐会让「切回重进」从兜底变常态路径（违反「兜底不进正常路径」）；
 * - 非整数向下取整（防御性；调用方传整数时不产生差异）。
 */
let lruMaxOverride: number | null = null

/** 设置 LRU 运行时上限（null = 恢复默认 LRU_MAX_SESSIONS）。memory-relief 消费点用。 */
export function setLruMaxSessions(max: number | null): void {
  if (max === null) {
    lruMaxOverride = null
    return
  }
  lruMaxOverride = Math.max(1, Math.floor(max))
}

/** 读当前生效上限（默认 LRU_MAX_SESSIONS 或压窗覆盖值）。 */
export function getLruMaxSessions(): number {
  return lruMaxOverride ?? LRU_MAX_SESSIONS
}

/**
 * session 访问时序记录（模块级，跨 store 实例共享）。
 * key = sessionId，value = 最后访问时间戳。
 * Map 的插入顺序天然反映首次访问顺序，但 LRU 需要按最后访问排序，
 * 所以用 touchLru 维护时间戳，evictIfNeeded 按时间戳排序。
 *
 * [ADR-0049 例外] 本模块级 Map 不套 useSessionScopedState。判据：lru.ts 是纯函数模块
 * （touchLru/evictIfNeeded/evictSessionWithVirtual/disposeLruEntry 均为独立导出函数，非
 * composable，无 Vue setup 上下文、无 sidRef: Ref<string|null>）；Map 存的是时序戳
 * （number，非 reactive 业务状态）。useSessionScopedState 是 setup-scoped 工厂（要求 sidRef
 * + reactive 容器契约），本模块无法满足——强套需把纯函数改造成 composable + 破坏所有调用方
 * 签名 + reactive 容器语义错位（时序戳不是响应式状态）。与 useChat/subscription-state
 * 同属 ADR-0049「全局 sid 协调器例外类（模块级 Map 合理）」。session 销毁清理：disposeLruEntry(sid)
 * 由 disposeSession 编排调用（R5 内存泄漏修复）；测试隔离：_resetLruForTest()。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：session LRU 访问序元数据（驱逐算法内部结构，非 GUI 数据）
const sessionLastAccessed = new Map<string, number>()

/**
 * 更新 session 的访问时间戳（LRU recency）。
 * 在 getMessages/hydrate/selectSession 时调用。
 */
export function touchLru(sessionId: string): void {
  sessionLastAccessed.set(sessionId, Date.now())
}

/**
 * 判断 sessionId 是否为虚拟 key（subagent/agentcall 派生）。
 */
export function isVirtualKey(sessionId: string): boolean {
  return sessionId.startsWith('subagent:') || sessionId.startsWith('agentcall:')
}

/**
 * 判断 sessionId 是否为某主 session 的虚拟 key（前缀匹配）。
 *
 * [M7] 仅 subagent 用三段式（含 mainSid 命名空间）可按前缀匹配。
 * agentcall 保持两段式（参数是 agent call 自己 session id，无独立子 id），
 * 无法按主 session 前缀定位：deleteSession 走 workflow store 的 mainSessionId 映射
 * （D6，hooks.evictVirtualKeys），LRU 驱逐走注入回调 agentCallEvictionsOf（B9）。
 */
export function isVirtualKeyOf(virtualId: string, mainSid: string): boolean {
  return virtualId.startsWith(`subagent:${mainSid}:`)
}

/**
 * evictIfNeeded 的依赖参数（由 chat store 传入）。
 * 用函数类型而非直接引用 store，避免循环依赖 + 便于测试。
 */
export interface LruEvictDeps {
  /**
   * messages Map 的 value getter（shallowRef<Map>）。
   * [W7] 改 getter 而非快照引用——deleteMessageKey 会 messages.value = next（替换 Map），
   * 若 deps 在构造时快照引用，后续 evict 迭代用的是旧 Map，漏判新写入。
   * getter 每次调用读当前值，消除快照陈旧问题。
   */
  messagesValue: () => Map<string, unknown>
  /** hydrated Set 的 value getter（同 messagesValue 理由） */
  hydratedValue: () => Set<string>
  /** 判断 session 是否在豁免集（streaming/pending/compacting 中）。不含 panel 绑定判定——见文件头注释 */
  isExempt: (sessionId: string) => boolean
  /** 删除 messages key（不可变写，返回新 Map）。makeLruEvictDeps 构造时内联同步清 streaming flag 派生缓存（D-3）+ changeSetStatuses 前缀条目（W19 review Fix-2，同 D-3 模式） */
  deleteMessageKey: (sessionId: string) => void
  /** 删除 hydrated 标记 */
  deleteHydrated: (sessionId: string) => void
  /**
   * [B9 agentcall LRU 联动] 查询主 session 名下应联动释放的 agentcall 虚拟分区 id。
   *
   * 纯查询契约（返回待驱逐列表，豁免已由实现侧应用——renderer 装配为 workflow store 映射
   * ∖ viewedVids panel 枚举豁免集）；驱逐执行面留本模块（deleteMessageKey + 时序记录清理），
   * 与 subagent 前缀联动同构，且免装配侧自引用 chat store（stores 间 import 禁令 +
   * defineStore 装配环）。未装配时（core 单测 / 无 renderer 装配环境）默认空数组 = 不联动。
   *
   * 两驱逐路径共用（evictIfNeeded 阈值路径 + evictSessionWithVirtual 显式路径）——
   * 显式路径消费方 deleteSession 会在 hooks.evictVirtualKeys 再全量清一次（含豁免 vid），
   * 双重调用幂等（deleteMessageKey 有 has 守卫）。
   */
  agentCallEvictionsOf: (mainSid: string) => string[]
}

/**
 * 检查并执行 LRU 驱逐。
 *
 * 统计可驱逐的 session（非虚拟 key + 非豁免），如果超过 LRU_MAX_SESSIONS，
 * 按最久未访问顺序驱逐超出的部分。驱逐时：
 * 1. deleteMessageKey（清 messages）
 * 2. deleteHydrated（清 hydrated，AC-8 切回重 hydrate）
 * 3. 同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（AC-2，isVirtualKeyOf 仅匹配三段式）
 *
 * SR8 竞态防护：驱逐前对每个候选 double-check isExempt（防止驱逐决策后
 * session 变为 streaming 状态）。
 */
export function evictIfNeeded(deps: LruEvictDeps): void {
  // 每次调用现读生效上限（默认 8 或 relief 压窗覆盖值，#28②）。
  const maxSessions = getLruMaxSessions()
  // 收集可驱逐的候选（有 messages + 非 virtual + 非豁免 + 有访问记录）
  // [W7] 经 getter 读当前 messages Map（非构造时快照），防 deleteMessageKey 替换 Map 后迭代旧引用。
  const candidates: Array<{ sid: string; lastAccessed: number }> = []
  for (const sid of deps.messagesValue().keys()) {
    if (isVirtualKey(sid)) continue
    if (deps.isExempt(sid)) continue
    const lastAccessed = sessionLastAccessed.get(sid)
    if (lastAccessed === undefined) continue
    candidates.push({ sid, lastAccessed })
  }

  // 不超阈值，无需驱逐
  if (candidates.length <= maxSessions) return

  // 按访问时间升序（最久未访问在前），驱逐超出的
  candidates.sort((a, b) => a.lastAccessed - b.lastAccessed)
  const toEvict = candidates.slice(0, candidates.length - maxSessions)

  for (const { sid } of toEvict) {
    // SR8 竞态防护：驱逐前 double-check 豁免状态
    if (deps.isExempt(sid)) continue

    // 驱逐主 session
    deps.deleteMessageKey(sid)
    deps.deleteHydrated(sid)
    sessionLastAccessed.delete(sid)

    // AC-2：同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（agentcall 两段式无 mainSid 前缀，走下方 B9 回调）
    // [Q1-9] 直接迭代 Map keys（免 [...keys()] 二次拷贝）：deleteMessageKey 是不可变替换
    // （new Map + 赋 .value，旧 Map 不被 mutate），for...of 迭代器绑定取值时的 Map 对象，
    // 循环内替换 .value 不影响迭代安全，行为与快照拷贝版一致。
    for (const virtualKey of deps.messagesValue().keys()) {
      if (isVirtualKeyOf(virtualKey, sid)) {
        deps.deleteMessageKey(virtualKey)
        sessionLastAccessed.delete(virtualKey)
      }
    }

    // B9：联动释放该主 session 未查看的 agentcall 虚拟分区（豁免已在回调实现侧应用）
    evictAgentCallPartitions(deps.agentCallEvictionsOf(sid), deps)
  }
}

/**
 * 显式驱逐单个 session 及其虚拟 key（用户返回主会话 / 手动驱逐）。
 *
 * 与 evictIfNeeded 的区别：evictIfNeeded 是阈值触发，evictSessionWithVirtual
 * 是显式驱逐指定 session（不论是否超阈值）。
 */
export function evictSessionWithVirtual(sessionId: string, deps: LruEvictDeps): void {
  // SR8 竜态防护：streaming 中的不驱逐
  if (deps.isExempt(sessionId)) return

  deps.deleteMessageKey(sessionId)
  deps.deleteHydrated(sessionId)
  sessionLastAccessed.delete(sessionId)

  // AC-2：同步驱逐关联的 subagent:sid:xxx 三段式虚拟 key（agentcall 两段式无 mainSid 前缀，走下方 B9 回调）
  // [Q1-9] 同 evictIfNeeded：直接迭代 keys，deleteMessageKey 不可变替换不影响迭代安全。
  for (const virtualKey of deps.messagesValue().keys()) {
    if (isVirtualKeyOf(virtualKey, sessionId)) {
      deps.deleteMessageKey(virtualKey)
      sessionLastAccessed.delete(virtualKey)
    }
  }

  // B9：联动释放该主 session 未查看的 agentcall 虚拟分区（两路径共用，见 LruEvictDeps.agentCallEvictionsOf 注释）
  evictAgentCallPartitions(deps.agentCallEvictionsOf(sessionId), deps)
}

/**
 * [B9] 执行 agentcall 虚拟分区联动驱逐（两驱逐路径共用内联段）。
 *
 * vid 列表来自注入回调（装配侧已应用 viewedVids 豁免），本函数只做机械删除：
 * deleteMessageKey（清 messages 分区 + streaming flag / changeSetStatuses 派生缓存）+
 * sessionLastAccessed 时序记录清理（与 subagent 前缀联动同构——虚拟 key 可能经
 * hydrate/touchLru 写入时序记录，驱逐后残留会让 Map 慢增长）。
 */
function evictAgentCallPartitions(vids: string[], deps: LruEvictDeps): void {
  for (const vid of vids) {
    deps.deleteMessageKey(vid)
    sessionLastAccessed.delete(vid)
  }
}

/**
 * 测试辅助：重置 LRU 时序记录 + 可变上限覆盖（压窗值跨用例残留会让阈值类用例互相污染）。
 */
export function _resetLruForTest(): void {
  sessionLastAccessed.clear()
  setLruMaxSessions(null)
}

/** 测试辅助：读时序记录条数（断言驱逐路径不残留虚拟 key 时序记录用）。生产代码禁止调用。 */
export function _lruSizeForTest(): number {
  return sessionLastAccessed.size
}

/**
 * 清理指定 session 的 LRU 时序记录（disposeSession 调用，R5 内存泄漏修复）。
 */
export function disposeLruEntry(sessionId: string): void {
  sessionLastAccessed.delete(sessionId)
}

/**
 * 构造 LRU 驱逐依赖（W3 H3）。
 * evictIfNeeded / evictSessionWithVirtual 共用此 deps 构造器。
 * 从 chat.ts 移入以控制文件行数。
 *
 * [B9] agentCallEvictionsOf 可选注入（默认空数组 = 不联动）：renderer 装配点
 * （stores/chat.ts → composables/features/chat/agentcall-lru-linkage.ts）注入
 * workflow store 映射 ∖ viewedVids 的组合查询；core 单测 / 无装配环境保持旧行为。
 */
export function makeLruEvictDeps(
  messages: { value: Map<string, unknown> },
  hydrated: { value: Set<string> },
  isExempt: (sid: string) => boolean,
  deleteStreamingFlag: (sid: string) => void,
  deleteChangeSetStatuses: (sid: string) => void,
  agentCallEvictionsOf: (mainSid: string) => string[] = () => [],
): LruEvictDeps {
  return {
    // [W7] getter 而非快照——deleteMessageKey/deleteHydrated 会替换 .value，
    // getter 保证 deps 消费方始终读到当前 Map/Set（消除快照陈旧引用 bug）。
    messagesValue: () => messages.value,
    hydratedValue: () => hydrated.value,
    isExempt,
    // W14: 走 deleteMessages 不可变写入口（与 commitMessages 对称），收敛所有 messages
    // 写入到 chat-mutations，不再散落 new Map + delete + 赋值。
    // has 检查保留——避免无该 session 时也构造新 Map 触发无谓响应式。
    // W11 D-3: 删 key 时同步清 streaming flag 派生缓存（内联在此处而非各驱逐点，
    // 使 evictIfNeeded/evictSessionWithVirtual 的主 key 与虚拟 key 联动驱逐全路径覆盖）。
    // flag 清理不受 has 守卫门控：keyless sid（messages 分区已不存在，但 flag 曾被
    // isGenerating 查询创建）同样清理——Map.delete 幂等无代价，防 flag 残留慢泄漏。
    // W19 review Fix-2: 同点内联清 changeSetStatuses 前缀条目（同 D-3 模式——驱逐路径
    // 全覆盖：evictIfNeeded/evictSessionWithVirtual 主 key + subagent 虚拟 key 联动 +
    // evictVirtualKey 单虚拟 key）。此前仅 disposeSession 清理，LRU 驱逐不清 → map 泄漏，
    // 且 W19 后 ready 帧扫描语义首次依赖其生命周期（驱逐重进后历史 messageId 与残留
    // status key 异源）。清理在 has 守卫外（幂等前缀删除，无条目时零代价）。
    deleteMessageKey: (sid) => {
      if (messages.value.has(sid)) {
        deleteMessages(messages, sid)
      }
      deleteStreamingFlag(sid)
      deleteChangeSetStatuses(sid)
    },
    deleteHydrated: (sid) => {
      if (hydrated.value.has(sid)) {
        const next = new Set(hydrated.value)
        next.delete(sid)
        hydrated.value = next
      }
    },
    agentCallEvictionsOf,
  }
}
