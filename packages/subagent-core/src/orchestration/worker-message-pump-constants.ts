/**
 * worker-message-pump 的模块级常量（自 pump 本体提取——max-lines 上限治理，
 * 值与注释逐字保留，唯一消费方 = worker-message-pump.ts）。
 */

/**
 * 单类错误最大重试次数。
 *
 * 注意：workerErrorCount 和 scriptErrorCount 是两个独立计数器，各自上限 MAX_WORKER_RETRIES。
 * 最坏情况（先连续 worker error 3 次 + 再连续 script error 3 次）= 6 次 rebuild。
 * 这是有意设计——两类错误的根因不同（worker 崩溃 vs 脚本逻辑），合并计数会导致
 * 不同根因的失败被过早判 failed。scheduleRebuild 的 retryIndex 取 max(两计数)。
 */
export const MAX_WORKER_RETRIES = 3;

/** 指数退避基数（ms）。 */
export const RETRY_BACKOFF_BASE_MS = 1000;
export const EXPONENTIAL_BACKOFF_BASE = 2;

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
 * [P-SD/S-D] 测试钩子 env（设计 §7.3 P-SD）：设为正整数 N 时 rebuildRuntime
 * 第 N 次及以后的每次调用抛错，供 S-D「worker 崩溃后重建失败」验收注入。
 * 安全约束：仅显式设置时激活 + 激活即 warn 留痕（见 resolveRebuildFailureInjectionThreshold）。
 */
export const REBUILD_FAILURE_INJECT_ENV = "TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE";

/**
 * [测试通道] 退避基数覆盖 env：设为正整数时覆盖 RETRY_BACKOFF_BASE_MS（生产默认
 * 1000ms 逐字不变），供 e2e 压缩真实指数退避等待（1+2+4s → ms 级）。仅显式设置时
 * 激活 + warn 留痕（安全约束对齐 REBUILD_FAILURE_INJECT_ENV 先例）。backoffDelay
 * 调用时读取（非模块顶层）——退避只在错误恢复路径（scheduleRebuild）消费，生产
 * 热路径零影响，且测试无需在模块加载前设 env。
 */
export const RETRY_BACKOFF_BASE_ENV = "TAIJI_SUBAGENT_TEST_RETRY_BACKOFF_BASE_MS";

/**
 * [F1] worker 交付前退出（无终态消息）的归因文案。
 *
 * 最常见根因：execute() 返回值含 function/Symbol/循环引用等不可克隆成员 → worker 侧
 * _safePost 吞掉 DataCloneError → return 消息从未发出 → worker exit(0)。旧实现
 * handleWorkerExit 对 code===0 no-op → run 永久 running、无终态。
 */
export const WORKER_EXITED_WITHOUT_RESULT_MSG =
  "worker exited before delivering a result (return value may not be structured-cloneable)";
