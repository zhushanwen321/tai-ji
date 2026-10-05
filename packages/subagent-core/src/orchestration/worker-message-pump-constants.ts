/**
 * worker-message-pump 的模块级常量（自 pump 本体提取——max-lines 上限治理，
 * 值与注释逐字保留，唯一消费方 = worker-message-pump.ts）。
 *
 * [HISTORICAL] 原重试矩阵常量族（MAX_WORKER_RETRIES / RETRY_BACKOFF_BASE_MS /
 * EXPONENTIAL_BACKOFF_BASE / RETRY_BACKOFF_BASE_ENV / REBUILD_FAILURE_INJECT_ENV）
 * 随重试矩阵删除（ADR-0112：失败显式上报，无自动重试/重建）。
 */

/** errorLogs 最大保留条数（防止超长 session 中日志无界增长）。 */
export const MAX_ERROR_LOGS = 500;

/** malformed agent-call 日志中 opts JSON 的预览截断长度（字符）。 */
export const MALFORMED_MSG_LOG_PREVIEW_CHARS = 200;

/**
 * [OR-8] run 到达 done 终态时残留 in-flight call 的收口文案。
 *
 * trace/call 状态枚举封闭（无 "cancelled" 态），以 failed + 本固定文案表达
 * 「run 终态前被收口」——GUI/快照侧不再出现 done run 含 running 节点的不一致。
 */
export const IN_FLIGHT_CALL_CANCELLED_MSG =
  "Cancelled: run reached terminal state while this call was in flight";

/**
 * [F1] worker 交付前退出（无终态消息）的归因文案。
 *
 * 最常见根因：execute() 返回值含 function/Symbol/循环引用等不可克隆成员 → worker 侧
 * _safePost 吞掉 DataCloneError → return 消息从未发出 → worker exit(0)。旧实现
 * handleWorkerExit 对 code===0 no-op → run 永久 running、无终态。
 */
export const WORKER_EXITED_WITHOUT_RESULT_MSG =
  "worker exited before delivering a result (return value may not be structured-cloneable)";
