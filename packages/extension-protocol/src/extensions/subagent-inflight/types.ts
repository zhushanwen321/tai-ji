/**
 * subagent 在途上报的类型定义（u7a 协议面）。
 *
 * 契约两端：
 *   - 写侧（生产）：@zhushanwen/pi-subagent-workflow 壳层（src/host/inflight-reporter.ts）
 *     监听 subagent-core 的 core→壳在途事件出口，经 select 通道 fire-and-forget 推送；
 *   - 读侧（消费）：xyz-agent runtime event-adapter 的 marker 路由分支（u7b 领地）
 *     → inflight-mirror per-session 镜像。
 *
 * 语义锚点（设计 §3.3 D5）：每帧携带该 session 的**绝对计数**（当前非 idle 句柄数，
 * 谓词 = hasLiveProcessHandle && !hasIdleTimer），非增量 delta——任何后续事件都能
 * 纠正镜像，单帧丢失不累积误差。初始上报触发时点 = extension 加载完成（session
 * 就绪），使「从未收到上报」可判别「reporter/通道结构性故障」与「在场且无在途」
 * （D5 缺席语义，2026-09-13 oe-audit 修订：原「旧版 extension 组合」立论被同
 * bundle 发布 + pi 随 runtime 退出销毁两条事实证伪，errs 兜底对象收敛为结构性故障）。
 */

/**
 * 单帧在途上报（pi 进程 → runtime，经 select 通道，title = SUBAGENT_INFLIGHT_MARKER，
 * options = [JSON.stringify(本形状)]）。
 */
export interface SubagentInFlightReport {
  /**
   * 绝对计数：该 pi 进程当前「非 idle 句柄数」（hasLiveProcessHandle && !hasIdleTimer
   * 双谓词过滤，与 notify-host.ts hasRunningBackground 同源）。非增量——消费方整帧
   * 覆盖镜像，不做加减。
   */
  inFlight: number
  /**
   * 上报所属 session（ctx.sessionManager.getSessionId()）。pi 延迟写入窗口内可能取
   * 不到（plugin-bridge getSessionId 同款防御）——缺席时消费方按无法归属丢弃整帧
   * （不镜像），不视为协议错误。
   */
  sessionId?: string
  /** 产生时点（ms epoch，pi 进程内取值）。诊断/乱序排查用，消费方不依赖其单调性。 */
  emittedAt: number
}

/**
 * select 通道的确认回包（runtime event-adapter 处理完帧后 resolve 给 pi 侧的
 * JSON 字符串）。fire-and-forget 语义下「已送达」与「超时/通道失败」在 promise 层
 * 都表现为 resolve(undefined)——必须靠显式 ack 帧区分送达与否，reporter 据此停止
 * 初始重试（有界，见 inflight-reporter）。无 ack 的运行环境（裸 pi TUI——marker
 * select 弹真框超时；经 xyz-agent runtime 恒为 rpc 模式必回 ack）由 reporter 侧
 * mode 门控不启动上报。
 */
export const INFLIGHT_REPORT_ACK = '{"ack":true}' as const

/** 运行时形状守卫（信任边界：帧内容来自 select 通道 payload，LLM/外部可控 JSON）。 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * SubagentInFlightReport 形状守卫：inFlight 非负整数、emittedAt 数字、sessionId
 * 缺席或 string。event-adapter（u7b）路由分支消费；非法帧返回 false（调用方丢弃，
 * 不抛错不镜像）。
 */
export function isSubagentInFlightReport(v: unknown): v is SubagentInFlightReport {
  if (!isRecord(v)) return false
  if (typeof v.inFlight !== 'number' || !Number.isInteger(v.inFlight) || v.inFlight < 0) return false
  if (typeof v.emittedAt !== 'number') return false
  if (v.sessionId !== undefined && typeof v.sessionId !== 'string') return false
  return true
}

/** 确认回包形状守卫（pi 侧 reporter 消费——非本字符串即未确认，折叠重试）。 */
export function isInFlightReportAck(v: unknown): v is typeof INFLIGHT_REPORT_ACK {
  return v === INFLIGHT_REPORT_ACK
}
