/**
 * RPC reject 呈现消歧的「消化标记」原语（D6，plan-mode-audit-remediation 批次 4）。
 *
 * 解决的问题：renderer 发 RPC 收到失败回执（reject）时要裁决「该不该向用户呈现」——
 * 长时操作（bash / compact）的成功 RPC ≠ 操作结束，结果经异步终态帧流回并渲染进对话流；
 * 失败时终态帧（事件流）与 reject 回执（应答通道）赛跑，帧先到则错误已被对话流呈现，
 * 再弹 toast 即双弹。此前 bash 用反向查询（getExecutingBash 业务态为空 = 已消化）、
 * compact 用正向标记（manualCompactionState 三态 Map），极性相反、各养一套生命周期——
 * 收敛为本原语：bash / compact 注册 key 接入，生命周期税合并为一份。
 *
 * 时序契约（原语正确性前提，显式化）：
 * 1. 终态帧先于 reject 回执到达（WS FIFO：runtime 同步广播先于 reply 到达消费端）；
 * 2. 终态帧处理点必调 markDigestConsumed（bash = bashResultEffect 两出口 + markBashError；
 *    compact = session.compacted handler）——「帧渲染进对话流」与「标记置位」同点成立。
 *
 * 行为语义（per key × session 单槽，重复发起覆盖上一轮）：
 * - markDigestInitiated：RPC 发出前置 false（新一次发起重置上一轮残留）；
 * - markDigestConsumed：终态帧到达置 true——仅在未决条目存在时置位（「不污染」守卫：
 *   auto-compaction 等非本原语发起路径的终态帧不置位，承接原 compact 正向标记的
 *   has 守卫既有语义——该状态已随本收敛退役，git 可追溯）；
 * - isDigestConsumed：reject catch 处判定——true = 错误已被对话流呈现 → 抑制 toast；
 *   false = 无终态可呈现（transport 级失败 / 终态帧延迟）→ toast 兜底。
 *
 * [D6 行为变更声明] bash transport 级失败（bashStart 从未广播）现状经反向查询把
 * 「执行列表为空」误读为「已消化」而静默（含误导性 warn 文案），统一后 isDigestConsumed
 * = false → toast 兜底——与 compact transport 级失败同构（该提示的不误吞）。
 *
 * send（clientUuid 归属对账）不并入本原语：其消歧子问题是「reject 归属是不是本次直发」，
 * 载荷是回滚/重入队所需数据（clientUuid + 入队原文 + inflight 配额标记），与 1 比特
 * 「消化」正交且不同质（docs/todo/renderer-reject-presentation-disambiguation.md
 * 原语拆分决策点，执行期定案：拆分——消化原语承载 bash/compact，send 保持独立）。
 *
 * 生命周期：模块级单例（与 streamSubscriptions 同模式）——clearDigest（reject catch /
 * RPC 收口 finally 单点清）+ clearDigestSession（disposeSession 编排）+ clearAllDigests
 * （resetChatModuleStateForTest 测试隔离）。
 */

export type RejectDigestKey = 'bash' | 'compact'

/**
 * key → (sid → 是否已消化)。嵌套 Map 保持 per-key 遍历/清理粒度。
 * taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记表 §4 ⑧ 补登 2026-09-30）：
 * 1 比特「消化」标记簿记非 GUI 数据本体——写方 = markDigestInitiated/markDigestConsumed
 * 单模块，清理 = clearDigest/clearDigestSession/clearAllDigests 三口（见文件头生命周期节）。
 */
const digestMarks = new Map<RejectDigestKey, Map<string, boolean>>()

function partitionOf(key: RejectDigestKey): Map<string, boolean> {
  let partition = digestMarks.get(key)
  if (!partition) {
    partition = new Map()
    digestMarks.set(key, partition)
  }
  return partition
}

/** RPC 发出前置未决标记（false = 未消化）。重复发起覆盖上一轮残留（单槽语义）。 */
export function markDigestInitiated(key: RejectDigestKey, sid: string): void {
  partitionOf(key).set(sid, false)
}

/** 终态帧到达置已消化。仅未决条目存在时置位——非发起路径的终态帧不污染判定。 */
export function markDigestConsumed(key: RejectDigestKey, sid: string): void {
  const partition = digestMarks.get(key)
  if (partition?.has(sid)) partition.set(sid, true)
}

/** reject catch 处判定：true = 终态帧已呈现错误（抑制 toast）；false = 无终态（toast 兜底）。 */
export function isDigestConsumed(key: RejectDigestKey, sid: string): boolean {
  return digestMarks.get(key)?.get(sid) === true
}

/** 单点清除（RPC 收口 finally / catch 消费后），防跨轮残留。幂等。 */
export function clearDigest(key: RejectDigestKey, sid: string): void {
  digestMarks.get(key)?.delete(sid)
}

/** session 级清除（disposeSession 编排）：该 session 全部 key 的条目一并清除。 */
export function clearDigestSession(sid: string): void {
  for (const partition of digestMarks.values()) {
    partition.delete(sid)
  }
}

/** 全量清除（仅供测试隔离，resetChatModuleStateForTest 编排）。 */
export function clearAllDigests(): void {
  digestMarks.clear()
}
