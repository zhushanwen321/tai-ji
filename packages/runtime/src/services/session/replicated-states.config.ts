/**
 * 标量 session 状态的 ReplicatedState 配置条目（data-source-governance W7 + W8，P1.1 / P1.2）。
 *
 * 本文件 = 登记表条目的代码化（docs/architecture/data-source-registry.md）：每条配置 =
 * 快照 RPC + 合并策略（含字段空值语义）。失效触发源不进配置——由调用方（event-interpreter /
 * session-service 的事件与 RPC 响应汇聚点）调实例 markDirty()（W6 原语约定）。
 * 实例按 session 注册在 session-service（本文件纯函数，无状态）。
 *
 * W7 二条目（thinkingLevel / modelId，fetch 同源 get_state）：
 * - thinkingLevel：fetch = get_state().thinkingLevel；失效 = thinking_level_changed 事件 +
 *   setThinkingLevel RPC 成功响应（U6 回执接通后删除 30s 周期兜底轮询——D9 附录 C.4 定案：
 *   自有状态对账类变化 100% 经我方请求/事件路径，pi 侧 effective≠previous 必发事件
 *   [PS-04]，剩余覆盖仅「不受支持的外部双写者」不构成保留理由）；空值语义 = 'required'
 *   （值域不含空、永不 guard）。
 * - modelId：fetch = get_state().model（pi Model.id 是裸 modelId、provider 在 Model.provider，
 *   投影组合为 runtime 语义的 'provider/model' 字符串——与 session.modelId /
 *   switchModel 口径一致，见 rpc-types.ts RpcSessionState.model / ai types.ts Model）；
 *   失效 = switchModel RPC 成功响应（RPC 响应驱动是「事件只做失效」的补充合法形态，D7）；
 *   空值语义 = 'required'（W15 磁盘扫描占位符 '' 不是权威空值，不登记空值语义）。
 *
 * W8 二条目（usage / commands，四实例齐备）：
 * - usage：fetch = get_session_stats().contextUsage（投影对齐既有 fetchContext 口径：
 *   inputTokens = tokens、contextLimit = contextWindow、usagePercent = Math.round(percent ?? 0)）；
 *   失效 = context 相关事件 turn_end / agent_end / compaction（接线汇聚点 =
 *   session-service.applyContextUpdate——三事件路径均经 interpreter onContextUpdate 到达）；
 *   空值语义 = 无（tokens=null 是 pi compact 后无新 turn 的合法「无值」态，投影为空快照
 *   保持旧值，对齐 fetchContext 返回 null 的不更新语义，不做覆盖也不做 guard）。
 * - commands：fetch = get_commands（数组包装为 { commands } 快照，空数组 = 合法态整字段覆盖）；
 *   失效 = getCommands 的全部调用路径（W12 起激活发布路径已删，仅剩 renderer 主动 RPC 查询
 *   ——查询即失效，重拉完成后经 fetchCommandsSnapshot 挂钩刷新 session.commands last-value）；
 *   空值语义 = 无（投影自构对象 key 恒在）。
 *
 * [HISTORICAL] W7 label / W8 queue 深度两条配置已撤销（PR #185 data-governance review
 * MF1/MF2，2026-08-20）：两实例 .get() 生产零消费、markDirty 触发的防抖 get_state 拉取纯
 * 浪费 RPC。label 终态 = session_info_changed 事件直写 setLabelCache（登记表 #1 修订）；
 * queue 深度终态 = queue_update 帧内 pendingMessageCount 推送投影（与 get_state 快照同公式
 * 同源，登记表 #6 修订）。
 *
 * @module replicated-states-config
 */
import {
  ownerSnapshotMerge,
  WireSnapshotSchemaError,
  type ReplicatedStateConfig,
} from './replicated-state.js'
// type-only：PiCommandInfo 是 commands 快照的元素形态（rpc-client getCommands 返回项）
import type { PiCommandInfo } from '../ports/pi-engine.js'

/**
 * 失效防抖窗口（ms）。W7/W8 四实例共用（label / queue 实例已撤销，PR #185）。
 * 行为级验收约束「切模型后模型名 1s 内更新」：防抖 + get_state（毫秒级 RPC）须 < 1s。
 * export 供测试 import（SR6 SSOT：测试跟随源码常量，不漂移）。
 */
export const SCALAR_STATE_DEBOUNCE_MS = 300

/** usagePercent 上限（对齐 session-service.computeUsage 的 MAX_PERCENT 口径，clamp 防越界）。 */
const MAX_USAGE_PERCENT = 100

/** 快照失败退避序列（canonical，W6 接口契约锁定值）。 */
// eslint-disable-next-line no-magic-numbers -- canonical 退避序列 1s/5s/15s（W6 契约锁定，非可调魔数）
const SCALAR_STATE_BACKOFF_SCHEDULE: readonly number[] = [1000, 5000, 15000]

/** get_state 字段投影的共享形态（每实例快照是其中单字段子集）。 */
interface SessionScalarFields {
  thinkingLevel?: string
  modelId?: string
}

/** thinkingLevel 实例快照形态。 */
export interface ThinkingLevelSnapshot {
  thinkingLevel?: string
}

/** modelId 实例快照形态（'provider/model' 形态字符串）。 */
export interface ModelIdSnapshot {
  modelId?: string
}

/** get_state wire 投影：提取标量字段，非 string 值退化为「key 缺失」（与 JSON wire 序列化
 * 丢 undefined key 同构），交由 fieldsNullSemantics 归一判定语义——投影层不做语义决策。
 *
 * state 非对象 = 协议异常（rpc-client 归一后仍可能 undefined）→ 抛 WireSnapshotSchemaError，
 * 按快照失败处理（退避重试 + 保留旧值）。
 */
function projectSessionScalars(state: unknown): SessionScalarFields {
  if (typeof state !== 'object' || state === null) {
    throw new WireSnapshotSchemaError(
      `get_state returned ${state === null ? 'null' : typeof state} instead of an object state`,
    )
  }
  const record = state as Record<string, unknown>
  const fields: SessionScalarFields = {}
  if (typeof record.thinkingLevel === 'string') fields.thinkingLevel = record.thinkingLevel
  const model = record.model
  if (typeof model === 'object' && model !== null) {
    const m = model as Record<string, unknown>
    // pi Model.id 是裸 modelId（如 'mimo-v2.5-pro'，provider 在 Model.provider）；runtime
    // session.modelId 语义是 'provider/model' 组合（switchModel / toSummary 口径）——此处组合。
    if (typeof m.provider === 'string' && m.provider !== '' && typeof m.id === 'string' && m.id !== '') {
      fields.modelId = `${m.provider}/${m.id}`
    }
  }
  return fields
}

/** get_state 窄访问器（session-service 注入：复用 rpc-client getState）。 */
export type FetchStateFn = () => Promise<Record<string, unknown> | undefined>

/** thinkingLevel 配置条目（登记表代码化；30s 周期兜底已随 U6 回执接通删除，见文件头）。 */
export function createThinkingLevelStateConfig(
  fetchState: FetchStateFn,
): ReplicatedStateConfig<ThinkingLevelSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // 丢 key 后 'required' 归一抛协议异常 → 快照失败退避（key 缺失 ≠ 字段不动）
      return fields.thinkingLevel === undefined ? {} : { thinkingLevel: fields.thinkingLevel }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { thinkingLevel: 'required' },
  }
}

/** modelId 配置条目（登记表代码化）。 */
export function createModelIdStateConfig(fetchState: FetchStateFn): ReplicatedStateConfig<ModelIdSnapshot> {
  return {
    fetchSnapshot: async () => {
      const fields = projectSessionScalars(await fetchState())
      // 丢 key 后 'required' 归一抛协议异常 → 快照失败退避（model 缺失 = 协议异常，禁当字段不动）
      return fields.modelId === undefined ? {} : { modelId: fields.modelId }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: { modelId: 'required' },
  }
}

// ── W8 二条目：usage / commands ─────────────────────────────────────────────

/**
 * usage 实例快照形态（get_session_stats().contextUsage 三字段投影，对齐 fetchContext 口径）。
 * 字段 optional 是 wire 归一前形态（同 W7 标量条目）：tokens=null（compact 后无新 turn）时
 * 投影为空快照 {}（无字段 = 合法「无值」态，merge 保持旧值）。
 */
export interface UsageSnapshot {
  inputTokens?: number
  contextLimit?: number
  usagePercent?: number
}

/** commands 实例快照形态（get_commands 数组的包装对象——merge 契约要求对象形态）。 */
export interface CommandsSnapshot {
  commands: PiCommandInfo[]
}

/** get_session_stats 窄访问器（session-service 注入：复用 rpc-client getSessionStats）。 */
export type FetchSessionStatsFn = () => Promise<Record<string, unknown> | undefined>

/** get_commands 窄访问器（session-service 注入：复用 rpc-client getCommands）。 */
export type FetchCommandsFn = () => Promise<unknown>

/**
 * usage 配置条目（登记表代码化，W8 验收锁定）。
 *
 * tokens=null（pi compact 后无新 turn）是合法「无值」态：投影为空快照 {}，ownerSnapshotMerge
 * 的 spread 语义保持旧值——与既有 fetchContext「返回 null 不更新」口径等价（退避重拉无意义，
 * 值要等下一次 turn 产生新 assistant usage 才有）。空值语义登记 = 无（验收锁定）。
 *
 * [HISTORICAL] W10 曾配套 recomputeUsageWithWindow（switchModel/applyContextUpdate 即时广播
 * 的「快照 tokens × resolver 新窗口」本地重算口径）；W12 起两个即时广播退役为快照挂钩发布
 * （percent 直接读 pi 权威快照投影，与本地重算同公式同值），该函数无调用方已删除。
 */
export function createUsageStateConfig(
  fetchSessionStats: FetchSessionStatsFn,
): ReplicatedStateConfig<UsageSnapshot> {
  return {
    fetchSnapshot: async () => {
      const stats = await fetchSessionStats()
      if (typeof stats !== 'object' || stats === null) {
        throw new WireSnapshotSchemaError(
          `get_session_stats returned ${stats === null ? 'null' : typeof stats} instead of an object stats`,
        )
      }
      const cu = (stats as Record<string, unknown>).contextUsage
      if (typeof cu !== 'object' || cu === null) {
        // pi RpcSessionStats.contextUsage 恒在（rpc-mode getSessionStats），缺失 = 协议异常
        throw new WireSnapshotSchemaError(
          `get_session_stats.contextUsage missing or non-object: ${cu === null ? 'null' : typeof cu}`,
        )
      }
      const record = cu as Record<string, unknown>
      const tokens = record.tokens
      if (typeof tokens !== 'number') return {} // tokens=null = compact 后合法无值态，保持旧值
      const contextWindow = record.contextWindow
      // 投影口径对齐既有 fetchContext：contextWindow=number、percent ?? 0 后取整
      const percent = typeof record.percent === 'number' ? record.percent : 0
      return {
        inputTokens: tokens,
        contextLimit: typeof contextWindow === 'number' ? contextWindow : 0,
        usagePercent: Math.min(Math.round(percent), MAX_USAGE_PERCENT),
      }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: {},
  }
}

/**
 * commands 配置条目（登记表代码化，W8 验收锁定）。
 *
 * pi get_commands 返回数组；merge 契约要求对象形态，包装为 { commands }。空数组是合法态
 * （扩展全部禁用 / 未注册命令），ownerSnapshotMerge 整字段覆盖（自有属性 spread）——命令集
 * 清空也覆盖旧值，禁止把「空」当「字段不动」。
 */
export function createCommandsStateConfig(fetchCommands: FetchCommandsFn): ReplicatedStateConfig<CommandsSnapshot> {
  return {
    fetchSnapshot: async () => {
      const result = await fetchCommands()
      if (!Array.isArray(result)) {
        throw new WireSnapshotSchemaError(
          `get_commands returned ${result === null ? 'null' : typeof result} instead of an array`,
        )
      }
      return { commands: result as PiCommandInfo[] }
    },
    debounceMs: SCALAR_STATE_DEBOUNCE_MS,
    backoffSchedule: SCALAR_STATE_BACKOFF_SCHEDULE,
    merge: ownerSnapshotMerge,
    fieldsNullSemantics: {},
  }
}
