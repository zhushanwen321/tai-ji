// src/protocol/engine-protocol.ts
//
// 引擎协议 v1 版本常量与协商（W1 契约根）。设计权威源：
// docs/architecture/subagent-engine-protocolization.md §3.3 + impl-plan §2.1。
//
// 传输 = stdio NDJSON（每行一个 JSON 对象）。stdout 独占协议帧；stderr 常驻排空
// （内存环形缓冲尾 400 字符，崩溃现场由 engine_crashed 携带，宿主侧不落盘）。
//
// 版本协商：ENGINE_PROTOCOL_VERSION = 1；core 支持 >=1 <2；越界 →
// engine_protocol_mismatch（含双方版本 + 升级指引），该引擎标记不可用，
// 不影响其他引擎与宿主。
//
// 演进政策三条（协议演进宪法 D11；权威源 docs/architecture/subagent-engine-protocolization.md
// §3.3「协议演进宪法」小节，本头注是其投影）：
//   ① additive 面——新增可选字段 / 事件变体 / 方法 / 通道不 bump 版本。纪律 =
//      旧端对新成员忽略或 no-op 安全落空（reducer default 分支、未知字段丢弃）。
//      同步义务：事件变体新增 = union 加成员 + AGENT_EVENT_TYPE_NAMES 词表加名
//      （contract-types.ts 双向编译期锁，schema enum 与测试断言自动派生）；字段 /
//      方法 / 通道的新增成员同步义务分别由各自契约文件的互证机制承载。
//   ② 删除面 = 同批切换——读写端同 commit 族、全程无「写新读旧」窗口 + ADR 登记。
//      单仓同步部署协议（两引擎同仓同发布）下，这是删除的唯一合法形态。
//   ③ major bump 触发——删除无法同批协调时（第三方引擎独立发布节奏出现），
//      core 支持区间平移 [1,2)→[2,3)（单点改 SUPPORTED_PROTOCOL_RANGE）。
//
// [H1 双键过渡（chat-run 统一，docs/architecture/subagent-chat-run-unification.md §3.3
// D3 + §5 U1 行）][H1 U6 已切换]：run.params.resume 曾与原 run.params.chat 载荷
// 同形并存（additive 可选，协议版本维持 1）；U1 只加键——U2-U5 过渡期 core 恒
// 构造旧 `chat` 键、pi 引擎恒读 `ctx.chat`。U6 已单批同时切换写端（core 构造
// resume）与读端（pi 改读）并删 `chat` 键，resume 现为唯一会话形态键——全程不存在
// 「写新读旧」窗口（错配 = resume 静默失效、每轮新文件、sessionFile 被覆盖）。
// 同批退役已落地：轮次相位反向通道与 interact 方法已随 U5 删除（D5——续聊轮统一
// 为新 run + resume 锚点，轮次终态由 run 应答承载）。

/** 协议版本（引擎包 manifest `taiji.subagentEngine.protocol` 与 initialize 应答同值）。 */
export const ENGINE_PROTOCOL_VERSION = 1;

/**
 * core 侧支持的协议版本区间（半开区间 [min, max)）：当前 = [1, 2)。
 * 引擎版本落在区间外 → engine_protocol_mismatch。
 */
export const SUPPORTED_PROTOCOL_RANGE = { min: 1, max: 2 } as const;

/** 版本兼容判定（core 握手判据；引擎侧对称用于拒绝过旧/过新宿主）。 */
export function isProtocolVersionCompatible(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= SUPPORTED_PROTOCOL_RANGE.min &&
    version < SUPPORTED_PROTOCOL_RANGE.max
  );
}

// ============================================================
// 量级常量（impl-plan §2.1 逐项写死，双侧同源）
// ============================================================

/** 正向数据面反向请求（帧④数据面类）未应答容忍时长：10s 未答 = 引擎故障 → 杀进程 + 在途 run 失败。 */
export const REVERSE_REQUEST_TIMEOUT_MS = 10_000;

/** initialize 握手超时（ms）：超时 → engine_handshake_timeout，该引擎不可用。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** cancel 后引擎收敛终态的窗口（ms）；超时 core 走杀链。 */
export const CANCEL_SETTLE_GRACE_MS = 3_000;

/** engine_crashed 后重建上限与指数退避序列（ms）：1s / 2s / 4s，超限标记不可用至宿主重启。 */
export const CRASH_REBUILD_MAX_ATTEMPTS = 3;
// 逐档具名（impl-plan §2.1 写死 1s/2s/4s；数组字面量元素会触发 no-magic-numbers，
// 且具名档位与 core kill-chain 的 MS_PER_SECOND 私有具名常量惯例同型）。
const CRASH_REBUILD_BACKOFF_STEP_1_MS = 1_000;
const CRASH_REBUILD_BACKOFF_STEP_2_MS = 2_000;
const CRASH_REBUILD_BACKOFF_STEP_3_MS = 4_000;
export const CRASH_REBUILD_BACKOFF_MS = [
  CRASH_REBUILD_BACKOFF_STEP_1_MS,
  CRASH_REBUILD_BACKOFF_STEP_2_MS,
  CRASH_REBUILD_BACKOFF_STEP_3_MS,
] as const;

/** stderr 内存环形缓冲保留的尾部字符数（engine_crashed 帧携带崩溃现场）。 */
export const STDERR_TAIL_CHARS = 400;

/** 事件合并开关 env 名（设计级默认关闭 = 值 "0"；A1 要求事件逐字段等价，合并不可开）。 */
export const ENGINE_EVENT_COALESCE_ENV = "TAIJI_ENGINE_EVENT_COALESCE";
export const ENGINE_EVENT_COALESCE_DEFAULT = "0";

/**
 * 反向请求超时二分（帧④注释，R9-2）：
 * - 数据面类（host/log / host/streamDelta / host/handleReady /
 *   host/childSpawned / host/childStateChanged）：10s 未答 = 引擎故障；
 * - 人机交互类（host/askUser）：不设统一超时——core 先回 {ack:true}，
 *   结果异步到达；按 ADR-0047「静默 ≠ 卡死」用无进展检测/用户取消，不据此判引擎故障。
 */
export type ReverseRequestTimeoutClass = "data-plane" | "interaction";
