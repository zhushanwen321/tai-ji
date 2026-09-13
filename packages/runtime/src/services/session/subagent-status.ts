import type { SubagentStatus } from '@xyz-agent/shared'

/**
 * 将 pi-subagent-workflow 各出口的状态字符串归一化为 SubagentStatus。
 *
 * pi 侧状态来源分散且命名不一致（v4 bg-notify 发 running/closed、listResponse 给
 * running/closed、PR #85 的 manifest 写 completed/failed、子进程崩溃重建路径推断
 * crashed），本函数统一收敛到 SubagentStatus（v4 两态 + legacy 兼容值）。
 *
 * runtime 的 event-interpreter（实时路径）与 subagent-extractor（磁盘路径）共用此函数，
 * 避免两处手写三元/switch 漂移（历史 bug：event-interpreter 的三元缺 completed/crashed 归一）。
 *
 * [2026-08-05] 自 @xyz-agent/shared 下沉（架构审计 7.1：单消费者驱动归位）——
 * 消费者仅 runtime 2 文件，shared 只保留真正跨端复用的类型/常量。
 */
export function normalizeSubagentStatus(status: string | undefined): SubagentStatus {
  if (!status) return 'running'
  switch (status) {
    case 'idle':
      // [U8 / 永久会话模型 §3.2.2] 两态新词直投：idle = 无任务在飞可续聊（entry
      // 写面 U2 起产出）。此前被当未知值落 closed 兜底——「空闲」被误读成终态。
      return 'idle'
    case 'done':
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'crashed':
      return 'crashed'
    case 'running':
    case 'pending':
    case 'active':
      return 'running'
    case 'closed':
      return 'closed'
    default:
      // 未知状态：pi 扩展可能新增了未映射的状态，warn 一次便于排查。
      // 兜底方向取终态（closed）而非 running：未知值更可能是扩展新增的终态细分，
      // 返回 running 会把已结束的 subagent 翻回「运行中」假象（UI 永久 spinner、
      // 活跃任务误判）；「无状态信息」（undefined/空串）才保持初始 running 认知。
      console.warn(`[normalizeSubagentStatus] unknown status: ${JSON.stringify(status)}, falling back to 'closed'`)
      return 'closed'
  }
}
