/**
 * journal-report-router — journal 事件推送的 runtime 侧路由单例（event-push-channel）。
 *
 * 设计权威源：.tmp/tech-design/event-push-channel.md §3.2/§3.3。pi 进程内
 * subagent-workflow 壳层经既有 select 通道推送 journal 事件报告（title =
 * SUBAGENT_JOURNAL_MARKER，单帧覆盖一个文件），event-adapter marker 路由分支
 * 解析后经本路由送达该 session 的事件派生视图（SessionEventProjection 推送喂入
 * 入口——recordTailer/runTailer watch 族退役后的实时路径唯一喂入源）。
 *
 * 形态先例 = inflight-mirror（module 级单例，event-adapter 写、services 域消费）：
 * 路由不依赖载荷自报 sessionId（连接归属——adapter 以帧所在 pi 连接的 sessionId
 * 路由），消费方 = SessionRecords（构造期注册 sink，applyJournalReport 委托到
 * per-session 投影）。
 *
 * 无 sink（SessionRecords 未注册 / 测试窄环境）→ applyReport 返回 false：adapter
 * 不回 ack（写侧按 D5 首败 warn + 缓冲丢弃），事件不丢——派生视图创建时 attach()
 * 全量冷读从磁盘收敛。
 */

import type { SubagentJournalReport } from '@zhushanwen/extension-protocol'

export interface JournalReportSink { // oe-exempt:20261003:framework:消费方注册的 sink 端口契约（SessionRecords 实现，路由与派生视图解耦的依赖倒置缝）
  /**
   * 报告送达：按 sessionId 路由到该会话的事件派生视图。同步应用（fold + 缺口补读
   * 均为同步文件读）——返回 true = 已应用（adapter 据此回 ack，生效回执语义 D7）；
   * false = 无消费方/投影未就绪（不 ack，写侧按失败折叠）。
   */
  applyJournalReport(sessionId: string, report: SubagentJournalReport): boolean
}

let sink: JournalReportSink | null = null

/** 消费方注册（SessionRecords 构造期调用；传 null 注销——测试 teardown 面）。 */
export function setJournalReportSink(next: JournalReportSink | null): void {
  sink = next
}

/**
 * 报告路由：marker 帧到达后由 event-adapter 调用。返回 true = 已送达消费方并同步
 * 应用（adapter 回 ack）；false = 无消费方（adapter 不 ack，帧仍按已消费处理——
 * marker 帧恒不进翻译/广播）。
 */
export function routeJournalReport(sessionId: string, report: SubagentJournalReport): boolean {
  if (sink === null) return false
  return sink.applyJournalReport(sessionId, report)
}
