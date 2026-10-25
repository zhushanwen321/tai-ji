/**
 * pending entries 差集核心（落盘形态语义：customType 字符串 + 抵消/去重规则）——
 * 跨端单一实现（ext-simplify-13 D3）。
 *
 * 契约两端（此前各持一份同构差集实现，对齐手段是注释）：
 *  - extension 侧：@zhushanwen/pi-base-tool-enhance 对账（原 collectUnsettledTaskIds：
 *    session_start 时对「entries 显示活跃但任务已终态」的 bt- 任务补写注销）
 *  - extension 侧：@zhushanwen/pi-pending-notifications 检查判据（原
 *    scanPendingEntries + filterActiveRegisters；其 types/currentSessionId/normalize
 *    过滤是 pending 产品语义，留在 pending 侧，不在本模块）
 *
 * 规则本体（单点）：register 首见去重 + unregister 全局抵消 + id 非法跳过，
 * id 全局唯一（时间戳+随机）是前提。unregister 全局抵消 = 注销 entry 在 entries
 * 任意位置均抵消同 id（含「register→unregister→register 同 id」复用序列——id 唯一
 * 前提下真实数据不复现，语义锁定为已注销）。
 *
 * 零 node 依赖（纯算法），进 index 桶出口。
 */

/** pending register entry 的 customType 落盘字符串（协议 SSOT）。 */
export const PENDING_REGISTER_ENTRY_TYPE = 'pending:register' as const

/** pending unregister entry 的 customType 落盘字符串（协议 SSOT）。 */
export const PENDING_UNREGISTER_ENTRY_TYPE = 'pending:unregister' as const

/** collectActivePendingIds 的可选过滤（bte 对账便利入口用前缀过滤）。 */
export interface CollectPendingIdsOptions {
  /** 只保留该前缀的 id（如 'bt-'）；缺省不过滤。 */
  idPrefix?: string
}

/** scanPendingEntries 的结果：register 原始 data 列表 + 已注销 id 集 + collect 字段映射视图。 */
export interface PendingEntriesScan {
  registerEntries: Array<{ data: Record<string, unknown> }>
  unregisteredIds: Set<string>
  /**
   * register 首见字段视图（MF-2-1 单点）：id → type（string 才收，原样透传——归一化
   * 归消费方）。首见规则 = 首条 register 胜出：同 id 重复条目不覆盖；首条无 type
   * 则该 id 恒无映射（不被后续重复条目补位——与 applyPendingDiff 的首条 data 语义
   * 同口径，工具侧旧「首条带 type 胜出」的补位行为是漂移，收敛时已废除）。
   */
  registerTypes: Map<string, string>
  /**
   * 注销条目 status 视图：id → status（写侧经 mapReasonToStatus 已映射落盘）。仅收
   * MAPPED_PENDING_STATUSES 成员（词表外/畸形不收，不虚构终态）；同 id 多条注销取
   * 末次合法值（后条非法不抹除前条合法值）。
   */
  unregisterStatuses: Map<string, MappedPendingStatus>
  /**
   * 注销条目结清视图（subagent-observability §3.3.6 债权结清新权威通道）：id →
   * 结清枚举（封闭五值 + 词表外解析缺省 unknown）。读注销 entry 的 reason 事实经
   * resolveSettlementReason 解析（不经 mapReasonToStatus 旧映射）；string reason
   * 一律解析（fail-visible 值照常入视图），非 string reason 视为畸形不入视图；
   * 同 id 多条注销取末次带 string reason 的值（后条畸形不抹除前值）。
   */
  unregisterSettlements: Map<string, ResolvedSettlementReason>
}

/**
 * 单趟扫描 entries 按 customType 分流（容错对齐 pending 侧 S-10：null/非对象
 * 元素先检查再访问字段）。register 侧 registerEntries 不校验 id（合法性判定归差集
 * 层）；unregister 仅收 string id。data 用最小结构类型 Record<string, unknown>，
 * 消费方自行窄化。字段映射视图（registerTypes / unregisterStatuses）顺路产出：
 * collect 链路的 type/outcome 映射规则单点在本次扫描（delivery-port 快照基线与
 * pending-notifications 终局回填此前各持一份同构扫描器且首见语义已分歧，MF-2-1
 * 收敛——消费方禁止本地复制映射段）。
 */
export function scanPendingEntries(entries: readonly unknown[]): PendingEntriesScan {
  const scan: PendingEntriesScan = {
    registerEntries: [],
    unregisteredIds: new Set(),
    registerTypes: new Map(),
    unregisterStatuses: new Map(),
    unregisterSettlements: new Map(),
  }
  const seenRegisterIds = new Set<string>()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { customType?: unknown; data?: unknown }
    const data = (entry.data ?? {}) as Record<string, unknown>
    if (entry.customType === PENDING_REGISTER_ENTRY_TYPE) {
      absorbRegisterEntry(scan, data, seenRegisterIds)
    } else if (entry.customType === PENDING_UNREGISTER_ENTRY_TYPE) {
      absorbUnregisterEntry(scan, data)
    }
  }
  return scan
}

/** register 条目处置：原始 data 收集 + 首见 type 视图。首见胜出（applyPendingDiff 首条 data 同口径）：占据即锁定，后续重复不覆盖；首条无 type 则该 id 恒无映射（不补位）。字段视图跳过空串 id。 */
function absorbRegisterEntry(
  scan: PendingEntriesScan,
  data: Record<string, unknown>,
  seenRegisterIds: Set<string>,
): void {
  scan.registerEntries.push({ data })
  if (typeof data.id === 'string' && data.id !== '' && !seenRegisterIds.has(data.id)) {
    seenRegisterIds.add(data.id)
    if (typeof data.type === 'string') scan.registerTypes.set(data.id, data.type)
  }
}

/** unregister 条目处置：全局抵消集 + status 视图 + 结清视图（字段视图跳过空串 id；status 仅收词表成员不虚构终态；结清视图读 reason 事实——§3.3.6 权威通道不经 status 旧映射档，词表外 reason 解析为 unknown 照常入视图 fail-visible，非 string reason 是畸形 data 不入视图不抹除前值）。 */
function absorbUnregisterEntry(scan: PendingEntriesScan, data: Record<string, unknown>): void {
  if (typeof data.id !== 'string') return
  scan.unregisteredIds.add(data.id)
  if (data.id === '') return
  const status = data.status
  if (typeof status === 'string' && MAPPED_PENDING_STATUSES.has(status)) {
    scan.unregisterStatuses.set(data.id, status as MappedPendingStatus)
  }
  const reason = data.reason
  if (typeof reason === 'string') {
    scan.unregisterSettlements.set(data.id, resolveSettlementReason(reason))
  }
}

/** scanPendingFields 的结果：collect 链路消费的字段映射投影（首见 type + 注销 status 视图 + 注销结清视图）。 */
export interface PendingFieldsScan {
  registerTypes: Map<string, string>
  unregisterStatuses: Map<string, MappedPendingStatus>
  /** 注销结清视图（§3.3.6 权威通道，见 {@link PendingEntriesScan.unregisterSettlements}）。 */
  unregisterSettlements: Map<string, ResolvedSettlementReason>
}

/**
 * collect 终局回填的字段视图（MF-2-1 单点入口）：scanPendingEntries 产物中
 * register 首见 type + 全部注销 status 的 MAPPED 成员投影 + 注销 reason 事实的
 * 结清解析投影。消费方（delivery-port 快照基线 / pending-notifications consume 后
 * 回填）按 id 查表补 type/outcome，查无保持 undefined（诚实缺省，不虚构终态）。
 */
export function scanPendingFields(entries: readonly unknown[]): PendingFieldsScan {
  const { registerTypes, unregisterStatuses, unregisterSettlements } = scanPendingEntries(entries)
  return { registerTypes, unregisterStatuses, unregisterSettlements }
}

/**
 * 差集本体（规则单点）：register 首见去重 + unregister 全局抵消 + id 非法跳过。
 * 首见判定先于任何消费方过滤（seen.add 后即使调用方对首个 data 过滤丢弃，后续
 * 重复条目也不会顶上——与 pending 侧 filterActiveRegisters 的 seen 语义一致）。
 * 返回活跃 register 的原始 data 列表（按 entries 出现序）。
 */
export function applyPendingDiff(scan: PendingEntriesScan): Array<{ data: Record<string, unknown> }> {
  const active: Array<{ data: Record<string, unknown> }> = []
  const seen = new Set<string>()
  for (const { data } of scan.registerEntries) {
    if (typeof data.id !== 'string' || scan.unregisteredIds.has(data.id) || seen.has(data.id)) continue
    seen.add(data.id)
    active.push({ data })
  }
  return active
}

/**
 * 上层差集组合（bte 对账便利入口）：scan + diff + 可选前缀过滤 → 活跃 id 集。
 * 前缀过滤是差集之后的独立层（先抵消/去重，再按 id 字符串过滤）。
 */
export function collectActivePendingIds(entries: unknown[], opts?: CollectPendingIdsOptions): Set<string> {
  const active = applyPendingDiff(scanPendingEntries(entries))
  const prefix = opts?.idPrefix
  const ids = new Set<string>()
  for (const { data } of active) {
    const id = data.id
    if (typeof id !== 'string') continue
    if (prefix !== undefined && !id.startsWith(prefix)) continue
    ids.add(id)
  }
  return ids
}

/**
 * 将 pending:unregister 的 reason 映射为 entry 的 status 字段（落盘契约组成部分、
 * 权威单点）——pending-notifications index.ts 委托此处（仅做 PendingStatus 类型
 * 收窄包装），bte pending-reconcile 写侧同引，两侧映射不再可能漂移（ext-simplify-17
 * D10：bte 原以 status === reason 的 identity 假设落盘，映射表演化时会静默漂移）。
 *
 * [U5 / 永久会话模型 §3.2.5 通知词表对齐] subagent-core 新 stopReason 展示值经注销
 * reason 通道到达（interrupted/interrupted-by-restart/interrupted-by-parent → aborted、
 * reopened → completed）——防新词落 default 被记为 completed 的误标（cancelled 同族
 * 事故先例：新枚举值漏映射静默落兜底）。
 *
 * [notify-once D3 族映射] session-manager watch 应答的 4 个新 reason 同族接入：
 * stopped→aborted（用户 UI 掐断含债权轮）、exited/deleted/orphaned→cancelled
 * （终局死亡/删除/orphan 吸收态）。
 *
 * [subagent-observability §3.3.6/§3.3.11④] 本通道保留为**历史 reason 解析兼容通道**
 * （解析词表纪律：旧值保留解析）；债权结清的新权威通道 = resolveSettlementReason
 * （下方 SettlementReason 封闭五值），双通道以新写入方为权威。缺省方向废除
 * fail-open：词表外 reason → unknown（不再产假成功）。
 *
 * 返回值 MappedPendingStatus（本文件封闭字面量联合）：PendingStatus 枚举留在
 * pending-notifications（本包不引 extension 侧类型），本联合是其终态子集+解析缺省
 * unknown——消费方免 as 收窄直接赋值。
 */
/**
 * mapReasonToStatus 的封闭返回值域：pending-notifications PendingStatus 的终态子集
 * （不含初始态 active）+ 解析缺省 unknown。protocol 不引 extension 侧类型（分层裁决
 * 不变），以自有字面量联合锁定值域，switch 分支编译期受限。
 *
 * [subagent-observability §3.3.6/§3.3.11④ fail-open 废除] 第七成员 unknown = 词表外
 * reason 的解析缺省（fail-visible——解析词表纪律的缺省方向与旧 fail-open=completed
 * 相反：不可判读时如实标注，不产假成功）。
 */
export type MappedPendingStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'time_limited'
  | 'aborted'
  | 'unknown'

/** reason→status 映射表（mapReasonToStatus 唯一数据源）：键集 = 全部已知 reason
 *  词表。新 reason 漏登记落 default 兜底 unknown（fail-visible——fail-open=completed
 *  方向整体废除，§3.3.11④）。
 *
 *  [subagent-observability §3.3.6 三组词表外字面量显式映射（走查补）] 此前直落
 *  default=completed 的三组生产字面量显式登记：
 *  - `running`（markRoundIdle 轮终注销恒发字面量——轮结束事实明确、成败未载的
 *    历史簿记）→ completed（历史口径显式化；新写入方按轮终事实产 completed/failed，
 *    字面量随 u3 判定链接线退役）；
 *  - `closed`（doFinalize 编排性收尾）→ cancelled；
 *  - reconcile-sweep 直通族（closedReason 值直通）：parent-shutdown/parent-fork/
 *    parent-new/disconnected → aborted（宿主侧打断族——与 interrupted 族同口径；
 *    disconnected 死因不可考、现行兜底展示即 interrupted-by-restart 族）、
 *    user-close/cancelled → cancelled（用户主动关闭/取消）、gc → unknown（通用
 *    终态无专属语义——诚实缺省，不产假成功）。 */
const REASON_STATUS_MAP: Readonly<Record<string, MappedPendingStatus>> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
  time_limited: 'time_limited',
  budget_limited: 'failed',
  aborted: 'aborted',
  interrupted: 'aborted',
  'interrupted-by-restart': 'aborted',
  'interrupted-by-parent': 'aborted',
  reopened: 'completed',
  stopped: 'aborted',
  exited: 'cancelled',
  deleted: 'cancelled',
  orphaned: 'cancelled',
  // ── [subagent-observability §3.3.6] 三组词表外字面量显式映射（原直落 default）──
  running: 'completed',
  closed: 'cancelled',
  'parent-shutdown': 'aborted',
  'parent-fork': 'aborted',
  'parent-new': 'aborted',
  'user-close': 'cancelled',
  disconnected: 'aborted',
  gc: 'unknown',
}

export function mapReasonToStatus(reason: string): MappedPendingStatus {
  // 未知 reason → unknown（fail-visible：[subagent-observability §3.3.11④] 旧
  // fail-open=completed 缺省废除——不可判读时如实标注，不产假成功）。
  return REASON_STATUS_MAP[reason] ?? 'unknown'
}

/**
 * REASON_STATUS_MAP 键集（历史 reason 词表，派生自映射表本身）。消费方：双通道
 * 键集对拍测试（与 SETTLEMENT_REASON_KEYS 的包含关系断言，键集漂移静态防线）。
 * string 元素类型：对任意落盘/事件 reason 做成员判定，窄化前的原始值。
 */
export const MAPPED_REASON_KEYS: ReadonlySet<string> = new Set(Object.keys(REASON_STATUS_MAP))

/**
 * MappedPendingStatus 的值集（MF-1-5 词表单源）：由 REASON_STATUS_MAP 派生——映射表
 * 演化（新增 reason / 改映射目标）时值集构造性跟随，无第二份手工词表可漂移。消费方
 * （delivery-port / pending-notifications 读取侧）按成员资格判定落盘 status 合法性时
 * import 本常量，禁止本地复制六值 Set（曾两包各持一份本地拷贝注释自认「同步维护」）。
 * Set 成员与 MappedPendingStatus 联合的相等性由 pending-entries.test.ts 断言锁定。
 * string 元素类型是消费面要求（对任意落盘 status 做成员判定，窄化前的原始值）。
 *
 * [subagent-observability §3.3.11④] 值集含解析缺省 unknown（fail-visible）——词表外
 * 落盘 status 由成员判定放行进入字段视图（不再静默丢弃），消费方按「不可判读」呈现。
 */
export const MAPPED_PENDING_STATUSES: ReadonlySet<string> = new Set(Object.values(REASON_STATUS_MAP))

// ============================================================
// [subagent-observability §3.3.6] SettlementReason 结清枚举（债权结清新权威通道）
// ============================================================

/**
 * 债权结清词表（封闭五值；值域语义与 subagent-core run-vocabulary ALL_SETTLEMENT_REASONS
 * 同源——「债权」= pending-notifications 的 collect 挂起债，结清 = 该债以何种事实形态
 * 兑现或消灭）：
 *   completed — 轮正常收尾兑现；
 *   failed    — 轮失败结清（含预算/超时轮失败）；
 *   cancelled — 轮中止、run 取消、编排性收尾打断（interrupted 族宿主侧打断）；
 *   lost      — 失联清点（宿主重启代际 + pid 探活事实，§3.3.4 合并清点产物）；
 *   no_result — 无果：退出无 settle 无结果、清理扫描无事实可依、或轮被扩展接管
 *               （细因经轮收条 promptDisposition 披露；与 lost 的边界 = 有无
 *               「宿主重启」事实）。
 *
 * 依赖方向：core → 本包（权威写侧产值在 core run-vocabulary；本包按协议单点纪律
 * 自持同值字面量，双包字面量一致性由各自枚举完整性测试 + core 侧对账测试锁定）。
 */
export const SETTLEMENT_REASONS = [
  'completed',
  'failed',
  'cancelled',
  'lost',
  'no_result',
] as const

/** 债权结清词表（封闭五值；值域语义见 {@link SETTLEMENT_REASONS}）。 */
export type SettlementReason = (typeof SETTLEMENT_REASONS)[number]

/**
 * 结清解析产出类型：词表外 reason 解析缺省 `unknown`（fail-visible——不可判读时
 * 如实标注，不产假成功；缺省方向与旧 fail-open=completed 相反）。
 */
export type ResolvedSettlementReason = SettlementReason | 'unknown'

/**
 * 历史/现行 reason → 结清枚举解析表（resolveSettlementReason 唯一数据源）。
 * 解析规则（§3.3.6 解析词表纪律）：
 *   - 同名直通：completed/failed/cancelled；
 *   - expired → no_result（过期 = 扫描无事实可依的无果形态）；
 *   - time_limited / budget_limited → failed（轮失败结清含预算/超时轮失败）；
 *   - aborted / interrupted 三态 / stopped → cancelled（中止族）；
 *   - exited/deleted/orphaned → cancelled（终局死亡/删除/orphan 吸收）；
 *   - reopened → completed（锚失效重开不改变既有结清）；
 *   - [§3.3.6 三组词表外字面量] running → no_result（轮终注销簿记——原因字面量
 *     本身不载成败事实，无事实可依归无果）；closed → cancelled（doFinalize 编排性
 *     收尾）；reconcile-sweep 直通族（closedReason 值）：宿主侧打断族
 *     parent-shutdown/parent-fork/parent-new 与用户关闭族 user-close → cancelled、
 *     disconnected/gc → no_result（死因不可考/通用终态无事实可依）；
 *   - lost/no_result 同名直通（新写入方产物原样解析）。
 * 词表外 reason → unknown（fail-visible）。
 */
const SETTLEMENT_REASON_MAP: Readonly<Record<string, ResolvedSettlementReason>> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  lost: 'lost',
  no_result: 'no_result',
  expired: 'no_result',
  time_limited: 'failed',
  budget_limited: 'failed',
  aborted: 'cancelled',
  interrupted: 'cancelled',
  'interrupted-by-restart': 'cancelled',
  'interrupted-by-parent': 'cancelled',
  stopped: 'cancelled',
  exited: 'cancelled',
  deleted: 'cancelled',
  orphaned: 'cancelled',
  reopened: 'completed',
  running: 'no_result',
  closed: 'cancelled',
  'parent-shutdown': 'cancelled',
  'parent-fork': 'cancelled',
  'parent-new': 'cancelled',
  'user-close': 'cancelled',
  disconnected: 'no_result',
  gc: 'no_result',
}

/**
 * pending 注销 reason → 债权结清枚举解析（新权威通道；双通道以新写入方为权威——
 * 新写入方直接产 SettlementReason 字面量，本函数服务历史 reason 与防御性解析）。
 * mapReasonToStatus（六值+unknown 历史通道）保留并行，两表键集一致性由测试锁定。
 */
export function resolveSettlementReason(reason: string): ResolvedSettlementReason {
  return SETTLEMENT_REASON_MAP[reason] ?? 'unknown'
}

/**
 * SETTLEMENT_REASON_MAP 键集（结清解析词表，派生自映射表本身）。消费方：双通道
 * 键集对拍测试——键集关系 = 本键集 ⊇ MAPPED_REASON_KEYS（历史 reason 保留解析）
 * 且 = MAPPED_REASON_KEYS ∪ 结清五值同名键（lost/no_result 新增、其余直通），
 * 任一侧登记表增删键而另一侧未同批跟随时对拍断言变红。
 */
export const SETTLEMENT_REASON_KEYS: ReadonlySet<string> = new Set(Object.keys(SETTLEMENT_REASON_MAP))
