import type { SubagentStatus } from '@xyz-agent/shared'
import { deriveClosedDisplay } from '@xyz-agent/shared'

/**
 * 将 pi-subagent-workflow 各出口的状态字符串归一化为 SubagentStatus（[U6/D5] 契约
 * 收窄后 = `running | idle` 两态直出）+ legacy 值的展示位合成明细。
 *
 * pi 侧状态来源分散且命名不一致（v4 bg-notify 发 running/closed、listResponse 给
 * running/closed、PR #85 的 manifest 写 completed/failed、子进程崩溃重建路径推断
 * crashed、U4 前自描述 entry 的 A-lite 轮终 running+resumable 桥接形态），本函数统一
 * 收敛到两态；legacy 值（done/failed/cancelled/crashed/closed）在边界映射为
 * idle + stopReason/closedReason 展示位合成（D5「legacy 值映射」，chatMode 形态位
 * 已随 modeless 波4 字段消亡删除），renderer 永不见 legacy 值。
 *
 * runtime 的 subagent-extractor（磁盘路径：自描述 entry 投影 + legacy toolResult 配对
 * 路径）共用此函数，避免多处手写映射漂移（历史 bug：event-interpreter 的三元缺
 * completed/crashed 归一）。
 *
 * [2026-08-05] 自 @xyz-agent/shared 下沉（架构审计 7.1：单消费者驱动归位）。
 * [2026-09 U6] 返回值从裸 SubagentStatus 扩为归一明细（D5 INFO 落点：legacy 四值映射
 * 与第五归一需要 status 之外的上下文与产出，单参裸值签名承载不了）。
 */

/** 归一明细（status 之外的字段全部是「entry 自带字段缺失时的合成兜底」，消费方必须让自带字段优先） */
export interface NormalizedSubagentStatus {
  /** 归一后的占用两态 */
  status: SubagentStatus
  /**
   * legacy 值归一合成的展示停因（SubagentRecord.stopReason 下行）：done 族 →
   * 'completed' / failed|crashed → 'failed' / cancelled → 'cancelled' / closed →
   * deriveClosedDisplay 派生映射（closed→'completed' / failed→'failed' /
   * cancelled→'cancelled'，D5「deriveClosedDisplay 改 stopReason 派生」）。
   * 桥接第五归一不合成——存量 entry 自带 A-lite 展示位（completed/failed）。
   */
  derivedStopReason?: string
  /** legacy closed 归一保留的 L2 诊断位（SubagentRecord.closedReason 下行，§3.2.9 台账第 1 条另行退役） */
  derivedClosedReason?: string
}

/** 归一上下文（调用方按数据源可用性传入；legacy toolResult 路径无 resumable） */
export interface NormalizeSubagentStatusOpts {
  /**
   * 存量桥接形态上下文（自描述 entry 的 resumable 字段原值；[U5] 后新写 entry 无此
   * 字段，仅 U4 部署边界旧 entry 在场）。true 且原始 status=running → 第五归一
   * （D5 R3：不设 result≠∅ 条件——覆盖 §3.4 第 2-5 行含重建孤儿 result=∅）。
   */
  resumable?: boolean
  /** legacy closed 的 L2 原因（deriveClosedDisplay 派生 + closedReason 保留双消费） */
  closedReason?: string
  /** legacy closed 的失败证据（deriveClosedDisplay 的 gc+error → failed 分支） */
  error?: string
}

/** closed 展示语义 → stopReason 值域映射（'done'→'completed'，failed/cancelled 同名词直投） */
function closedDisplayToStopReason(display: 'done' | 'failed' | 'cancelled'): string {
  return display === 'done' ? 'completed' : display
}

/** 占用族（running/pending/active——pi 各出口命名不一致的历史堆叠，语义等价「有任务在飞」） */
const OCCUPIED_STATUSES: ReadonlySet<string> = new Set(['running', 'pending', 'active'])

/** legacy 终态查表描述：stopReason 直投值。 */
interface LegacyTerminalDescriptor {
  derivedStopReason: 'completed' | 'failed' | 'cancelled'
}

/**
 * legacy 终态值 → 归一明细查表（[U6/D5] 三族：完成 done/completed/success、
 * 失败 failed/error/crashed——crashed = 子进程崩溃重建推断同 failed 异常语义、
 * 取消 cancelled/canceled）。用 Map 不用对象字面量：'toString'/'constructor' 等
 * 原型链键必须落未知值兜底 warn，不能被原型继承成员误命中。
 */
const LEGACY_TERMINAL_MAP: ReadonlyMap<string, LegacyTerminalDescriptor> = new Map([
  ['done', { derivedStopReason: 'completed' }],
  ['completed', { derivedStopReason: 'completed' }],
  ['success', { derivedStopReason: 'completed' }],
  ['failed', { derivedStopReason: 'failed' }],
  ['error', { derivedStopReason: 'failed' }],
  ['crashed', { derivedStopReason: 'failed' }],
  ['cancelled', { derivedStopReason: 'cancelled' }],
  ['canceled', { derivedStopReason: 'cancelled' }],
])

export function normalizeSubagentStatus(
  rawStatus: string | undefined,
  opts: NormalizeSubagentStatusOpts = {},
): NormalizedSubagentStatus {
  if (!rawStatus) return { status: 'running' }
  if (OCCUPIED_STATUSES.has(rawStatus)) return normalizeOccupiedStatus(opts)
  // [U8 / 永久会话模型 §3.2.2] 两态新词直投：idle = 无任务在飞可续聊（entry
  // 写面 U2 起产出）。此前被当未知值落 closed 兜底——「空闲」被误读成终态。
  if (rawStatus === 'idle') return { status: 'idle' }
  const legacy = LEGACY_TERMINAL_MAP.get(rawStatus)
  if (legacy) return normalizeLegacyTerminal(legacy)
  if (rawStatus === 'closed') return normalizeClosedStatus(opts)
  return warnUnknownStatus(rawStatus)
}

/** 占用族归一。[U6/D5 第五归一] 存量桥接形态（U4 部署边界旧 entry：running + resumable=true）
 * → idle：覆盖 §3.4 迁移矩阵第 2-5 行全部桥接形态（chat 轮终 / one-shot 轮终 /
 * legacy 无模式字段轮终 / 重建孤儿 result=∅），不设 result≠∅ 条件。缺此行则单字段
 * isOccupied 会对存量桥接形态重新计入幽灵（A1/A4 回归）。展示位不在此合成——
 * 存量 entry 自带 A-lite stopReason（completed/failed），自带字段优先。 */
function normalizeOccupiedStatus(opts: NormalizeSubagentStatusOpts): NormalizedSubagentStatus {
  if (opts.resumable === true) return { status: 'idle' }
  return { status: 'running' }
}

/** legacy 终态归一（查表命中）：idle + stopReason 直投。[modeless 波4] one-shot 形态位
 *（derivedChatMode）随字段消亡删除——idle 统一绿兜底行不再依赖形态位区分。 */
function normalizeLegacyTerminal(d: LegacyTerminalDescriptor): NormalizedSubagentStatus {
  return { status: 'idle', derivedStopReason: d.derivedStopReason }
}

/** legacy closed 终态归一：idle + closedReason 保留（诊断位）+ 展示语义经
 * deriveClosedDisplay 派生映射为 stopReason（cancelled→灰 / failed→红 / done→绿，
 * 与收窄前三分行等价——A4 门）。 */
function normalizeClosedStatus(opts: NormalizeSubagentStatusOpts): NormalizedSubagentStatus {
  const display = deriveClosedDisplay({ closedReason: opts.closedReason, error: opts.error })
  return {
    status: 'idle',
    derivedStopReason: closedDisplayToStopReason(display),
    derivedClosedReason: opts.closedReason,
  }
}

/** 未知状态兜底：pi 扩展可能新增了未映射的状态，warn 一次便于排查。
 * 兜底方向取非占用（idle）而非 running：未知值更可能是扩展新增的终态细分，
 * 返回 running 会把已结束的 subagent 翻回「运行中」假象（UI 永久 spinner、
 * 活跃任务误判）；「无状态信息」（undefined/空串）才保持初始 running 认知。
 * [U6] 兜底值随契约收窄从 closed 改为 idle（closed 已不存在于两态词表）。 */
function warnUnknownStatus(rawStatus: string): NormalizedSubagentStatus {
  console.warn(`[normalizeSubagentStatus] unknown status: ${JSON.stringify(rawStatus)}, falling back to 'idle'`)
  return { status: 'idle' }
}
