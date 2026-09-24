/**
 * bg-notify 边界聚合投影（D5，对话流系统通知渲染升级）——隐藏完成通知本体 → 展示数字。
 *
 * 独立成模块的理由（变化轴）：本文件是「通知载荷 → 计数/成败/耗时」的解析聚合面，与
 * message-turns.ts 的「消息序列 → turn 分组」是两个变化轴（前者随载荷形态/判据演进，
 * 后者随分组规则演进）；且 message-turns.ts 已触及 eslint max-lines 门禁（500 计数行），
 * 聚合逻辑内联会把该文件推过线。消费面唯一（message-turns 规则 2 分支），派生结果存
 * TurnGroup.notifySummary / MessageTurn.notifySummary，渲染层零解析零回扫。
 *
 * 数据链：Message.details → 防御解析（@taiji/shared 单点 SSOT）→ 去重 + 判据 + 耗时聚合
 * （本文件）→ NotifySummary → Turn.vue 渲染。
 */
import {
  deriveClosedDisplay,
  parseBgNotifyDetails,
  parseWorkflowResultNotify,
} from '@taiji/shared'
import type { BgNotifyRecord, Message } from '@taiji/shared'
// notify 通道 customType 词表单源（extension-protocol，与壳写点同源）
import { WORKFLOW_RESULT_CUSTOM_TYPE } from '@zhushanwen/extension-protocol'

/** bg-notify 单条记录的成败三态（D5 判据输出）：成功 / 失败 / 中性（取消、判据不可得）。 */
export type NotifyOutcome = 'success' | 'failed' | 'neutral'

/**
 * bg-notify 边界行聚合投影（D5）：分组层从隐藏完成通知本体派生的全部展示数字。
 * 「N 个后台任务完成 · M 失败 ●●● · 26m03s」的四类信息一一对应本结构字段。
 */
export interface NotifySummary {
  /** 去重后 record 数（single→1 / batch→items.length / workflow-result→1） */
  count: number
  /** 去重后判失败数 */
  failedCount: number
  /** 去重后非成功非失败数（cancelled / 消息级 parse null / workflow neutral） */
  neutralCount: number
  /** 去重后逐 record 判定（序 = record 首见序）——状态点列按此序逐点渲染 */
  outcomes: NotifyOutcome[]
  /** 去重后实际含 endedAt 值记录（含 endedAt >= startedAt 守卫）的 max(endedAt) − min(startedAt)；
   *  无含值记录时不写入（= 不显耗时）。workflow 无时间字段不计入。 */
  durationMs?: number
}

/** 聚合中间记录：bg-notify 单条/批成员与 workflow-result 归一形态（去重 + 判据 + 耗时共用） */
interface NotifyRecordEntry {
  /** 去重键：BgNotifyRecord.id（轮终 key `id:round` 的 id 部）/ workflow details.runId */
  key: string
  /** 轮次排序键（round ?? -1；归档/提示类无 round 让位于轮终；workflow 无轮次概念恒 -1） */
  round: number
  outcome: NotifyOutcome
  /** 耗时聚合输入（workflow 无时间字段 → 缺席，不计入） */
  startedAt?: number
  endedAt?: number
}

/** 隐藏通知消息的展开结果：record 列表 + 消息级解析失败计数 */
interface NotifyExtraction {
  records: NotifyRecordEntry[]
  /** 消息级 parse null（details 缺失/畸形：旧 session / 第三方写入）——不产出 record、
   *  不计入 count，只增 neutralCount（D5）。 */
  unparsed: number
}

/** bg-notify 单条判据两段式（D5）：① status 分派（legacy 五值联集）② running/closed 走
 *  shared deriveClosedDisplay 复用（与侧边栏投影同一函数——cancelled 中性 / gc+error 失败 /
 *  其余含 parent-* 级联关闭成功，勿回退成「error 有值即 failed」）。 */
function judgeBgNotifyRecord(record: BgNotifyRecord): NotifyOutcome {
  switch (record.status) {
    case 'done':
      return 'success'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'neutral'
    case 'running':
    case 'closed': {
      const display = deriveClosedDisplay({
        closedReason: record.closedReason,
        error: record.error,
      })
      if (display === 'done') return 'success'
      return display === 'failed' ? 'failed' : 'neutral'
    }
    default:
      // 防御枚举漂移：解析只放行五值联集，未来新增 status 值落中性（不冒充成功）
      return 'neutral'
  }
}

/** 隐藏通知消息 → record 列表（D5 record 口径）：subagent-bg-notify single→1 /
 *  batch→items.length；workflow-result→1（去重键 details.runId）。message 级 parse null
 *  → 零 record + unparsed 1。 */
function extractNotifyRecords(msg: Message): NotifyExtraction {
  if (msg.customType === WORKFLOW_RESULT_CUSTOM_TYPE) {
    const notify = parseWorkflowResultNotify(msg.details)
    if (!notify) return { records: [], unparsed: 1 }
    return {
      records: [
        {
          key: notify.runId,
          round: -1,
          outcome: notify.outcome === 'completed' ? 'success' : notify.outcome,
        },
      ],
      unparsed: 0,
    }
  }
  const details = parseBgNotifyDetails(msg.details)
  if (!details) return { records: [], unparsed: 1 }
  // batch 形态经 U9 在投递层展平归单层；此处只展开一层（存量嵌套载荷的成员会被
  // parseSingleRecord 逐条拒绝，属 U9 前历史数据，解析侧零改动——D5 已登记）
  const items = 'batch' in details ? details.items : [details]
  return {
    records: items.map((record) => ({
      key: record.id,
      round: record.round ?? -1,
      outcome: judgeBgNotifyRecord(record),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    })),
    unparsed: 0,
  }
}

/** record 去重（D5）：同 id 取 round 最大者（round ?? -1 排序：归档/提示类让位于轮终；
 *  全部无 round 时取首条）。Map 保序——去重后序 = record 首见序（状态点列按此序渲染）。 */
function dedupeNotifyRecords(entries: NotifyRecordEntry[]): NotifyRecordEntry[] {
  const byKey = new Map<string, NotifyRecordEntry>()
  for (const entry of entries) {
    const prev = byKey.get(entry.key)
    if (prev === undefined || entry.round > prev.round) byKey.set(entry.key, entry)
  }
  return [...byKey.values()]
}

/** 耗时聚合（D5）：去重后实际含 endedAt 值记录（endedAt >= startedAt 守卫，排除时钟回拨
 *  的负贡献）的 max(endedAt) − min(startedAt)——聚合集合 = 含值记录本身，混合组耗时只由
 *  这些记录贡献；无含值记录 → undefined（不显耗时）。 */
function aggregateNotifyDuration(records: NotifyRecordEntry[]): number | undefined {
  let maxEnd = Number.NEGATIVE_INFINITY
  let minStart = Number.POSITIVE_INFINITY
  let hasValue = false
  for (const r of records) {
    if (r.startedAt === undefined || r.endedAt === undefined || r.endedAt < r.startedAt) continue
    hasValue = true
    if (r.endedAt > maxEnd) maxEnd = r.endedAt
    if (r.startedAt < minStart) minStart = r.startedAt
  }
  return hasValue ? maxEnd - minStart : undefined
}

/** bg-notify 边界聚合归一本函数（D5）：message-turns 两个 MessageTurn 构造点共用
 *  （reuseOrRebuildTurn 重建分支 / 全量版 toRenderItems）——无空白组返回 undefined。 */
export function deriveNotifySummary(hiddenNotifies: Message[]): NotifySummary | undefined {
  if (hiddenNotifies.length === 0) return undefined
  const entries: NotifyRecordEntry[] = []
  let neutralCount = 0
  for (const msg of hiddenNotifies) {
    const { records, unparsed } = extractNotifyRecords(msg)
    entries.push(...records)
    neutralCount += unparsed
  }
  const records = dedupeNotifyRecords(entries)
  let failedCount = 0
  for (const record of records) {
    if (record.outcome === 'failed') failedCount += 1
    else if (record.outcome === 'neutral') neutralCount += 1
  }
  const summary: NotifySummary = {
    count: records.length,
    failedCount,
    neutralCount,
    outcomes: records.map((record) => record.outcome),
  }
  const durationMs = aggregateNotifyDuration(records)
  if (durationMs !== undefined) summary.durationMs = durationMs
  return summary
}
