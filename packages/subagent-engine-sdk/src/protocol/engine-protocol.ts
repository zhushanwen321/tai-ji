// src/protocol/engine-protocol.ts
//
// 引擎协议 v1 版本常量与协商（W1 契约根）。设计权威源：
// docs/architecture/subagent-engine-protocolization.md §3.3 + impl-plan §2.1。
// 演进宪法（本头注）+ 删改史与判据 why 的唯一入库权威 = docs/adr/decisions.md ADR-0071。
//
// 传输 = stdio NDJSON（每行一个 JSON 对象）。stdout 独占协议帧；stderr 常驻排空
// （内存环形缓冲尾 400 字符，崩溃现场由 engine_crashed 携带，宿主侧不落盘）。
//
// 版本协商：ENGINE_PROTOCOL_VERSION = 1；core 支持 >=1 <2；越界 →
// engine_protocol_mismatch（含双方版本 + 升级指引），该引擎标记不可用，
// 不影响其他引擎与宿主。
//
// 现状语义：run.params.resume 为唯一会话形态键；会话形态请求由 conversation 能力门
// 派发前预检（manifest 无 gate 位 → engine_capability_unsupported + 升级引擎包指引，
// 判据 6 先例）；事件变体增量同演进政策 ①——新变体进 union，旧宿主 runtime
// reducer default no-op 安全落空 / journal 豁免面不感知，协议版本维持 1 不 bump。
//
// ==================== 演进政策三条（协议宪法） ====================
// ① additive 面：新增可选字段/事件变体/方法/反向通道不 bump 版本，旧端对新成员忽略
//    或 no-op 安全落空；新增须过门槛——消费方 + 降级路径 + 能力位绑定三件齐才进协议，
//    无消费方不进协议（占位先行即违宪，C 型教训）。
// ② 删除面：同形键改名（A 型）默认「新增新键 + 旧键 deprecated 双读 + major 清除」；
//    机制替换/语义收窄（B 型）同批切换合法，条件 = 对端同仓 + ADR 登记；对端独立节奏
//    出现时删除一律走 major（minor 协商触发条件三条见 ADR-0071，条件不到不加协商位）。
// ③ major bump：core 支持区间平移 [1,2)→[2,3)，遗留清单届时清理。
// 历史 6 次破坏性删改的 A/B/C 型分类学与判据 why 全量收编 ADR-0071；本头注只载终态
// 纪律，不载逐次删改史。
//
// ==================== 字段归属判据 1-7（新增字段依序裁决，先到先定） ====================
// 1. 引擎不消费它，任务能否正确完成？能 → 宿主自持不上协议。
// 2. 它描述「任务是什么」（what→task）还是「在什么环境跑/怎么跑」（where/how→ctx）？
// 3. 引擎能否自行推导该环境值且推导与宿主恒等？能 → 不上协议；不能（推导分叉）→ ctx。
// 4. （绝对条款）同一语义不得 task/ctx 双写——wire 层同名键交集恒空（编译断言锁）。
// 5. （能力绑定）字段有效性依赖某能力位时，字段注释点名能力位、能力位注释回指字段
//    （先例 streamMode↔eventGranularity）。
// 6. （键三分类）advisory——忽略无语义影响，直接 additive；degradable——设计内静默
//    降级：缺省最弱档 + 判据 5 回指 + 预检豁免（先例 streamMode↔eventGranularity）；
//    behavior——忽略会静默改变任务语义：必须绑定能力位、宿主派发前预检
//    （先例 resume↔conversation gate、forkSource 注释）。判别式：「旧引擎静默忽略此键，
//    宿主会发现吗？该降级是设计内吗？」（三案例归档唯一：resume→behavior、
//    streamMode→degradable、description→advisory）。
// 7. （能力位消费点登记）每个能力位登记其消费点与 wire 载体（方法参数/通道/字段/
//    gate 判据），执行通道缺失也如实登记；未登记位 = 违宪（首个登记条目 = steer）。
//
// ==================== 新轴五触点清单（新增能力位；触发需求前不落代码） ====================
// ① SDK EngineCapabilities 加可选键 + 缺省最弱档注释；② core↔SDK 双向断言与存量必填
// 断言保持绿；③ core 两表各登各的——CONSERVATIVE_CAPABILITIES 登保守缺省值、
// CAPABILITY_ENUMS 登值域（缺一即回 undefined 透传 + gate 字面值判据放行）；值域
// 登记按轴型分道——enum 轴按字面登值域；boolean 轴走 maxTurns 先例：ENUMS 不登
// （键集锁 B 的 Exclude 集合同步扩位）+ parseCapabilities boolean 专用解析分支；
// ④ gate 判据比较最弱档字面值（能力位键集锁保证解析不产 undefined）；
// ⑤ pi-host-binding 能力位快照（第四份手写词表）同步登记。
//
// ==================== 深载荷 schema 判据 ====================
// 帧级骨架校验不变；深载荷配专属 schema 需任一：①该载荷经历过键切换/搬家事故（先例
// runSessionParamsSchema）；②载荷跨信任边界（第三方引擎独立开发）。
//
// ==================== 关联键总纲 ====================
// runId = 渲染与事件路由键（event / streamDelta / handleReady / askUser）；recordId =
// record 镜像键（childSpawned / childStateChanged）；新通道/新事件按消费方选键，
// 注释点名消费方。
//
// ==================== 存量落位 / 遗留清单 + 重审触发条件 ====================
// 存量不搬家（搬家本身是删改）——判据回判发现的错位只登记，major bump 时按清单清理：
//   - idleTimeoutMs：判据 1 明确错位（六引擎映射全部不支持，实为宿主 idle GC 参数）；
//   - scene / description：弱错位待核（宿主消费为主，逐引擎核实 pi 侧是否消费再定）；
//   - schemaEnv：待消亡——H1b 收口未完成（packages/subagent-core/src/execution/engine/
//     client/remote-engine.ts:382 仍 `ctx.schemaEnv ?? task.schemaEnv` 双源，在飞不重复
//     处理）；wire 层禁令断言现状纯 never、无豁免（键集交集为空——AgentCallOpts 已
//     单侧排除 schemaEnv），收口后仅回看断言注释（wire-field-locks.test.ts）；
//   - steer：能力位无独立 wire 执行通道（判据 7 首个登记条目，只登记不设计）。
// 重审触发条件（任一命中 → 提前清理裁决，不等 major bump）：遗留清单 >5 项，或任一
// 错位引发实际派发事故。

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
