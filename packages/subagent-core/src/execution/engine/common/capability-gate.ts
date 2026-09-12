// src/execution/engine/common/capability-gate.ts
//
// [D3-④ 预检 capabilities 化] 调用前预检的唯一实现（capabilities 驱动，无引擎 id
// 特判）。设计权威源（现行）：docs/design/subagent-engine-protocolization.md §3.3
// 「能力位」段（manifest 权威 + 方向判定表）+ 历史源 docs/design/subagent-dual-track-
// convergence.md §3.3 D3-④ + r3 裁定（EngineCapabilities 新增 maxTurns 能力位）+
// 错误规格（engine_capability_unsupported / engine_capability_mismatch）。
//
// 判据形态：每个引擎拦截「自己 capabilities 声明不支持的能力」——
//   - conversation → capabilities.conversation === 'unsupported'
//   - fork/forkFromSessionFile → session 分叉通道族全缺（steer 与 conversation 均
//     'unsupported'，OR 语义任一可用即放行，见下方 fork 判据说明）
//   - maxTurns → capabilities.maxTurns === false（r3 扩位）
//   - worktree（boolean true 或 WorktreeHandle）→ capabilities.sandbox === 'none'
//
// [W3 协议化能力位方向判定（设计 §3.3 能力位表）] capabilities 的同步源 = manifest
// 快照（注册期读，非握手缓存）。被 gate 四类判据涉及的能力位（conversation /
// steer+conversation / maxTurns / sandbox）**manifest 是权威契约**，双向处置：
//   - **少声明**（任务要求的能力 manifest 未声明）→ 本文件同步拒
//     engine_capability_unsupported；恢复指引 = 「修 manifest / 升级引擎包」——不写
//     「先派一次任务触发握手」（gate 读 manifest，握手不参与同步判据，那个指引是空转）；
//   - **多声明**（manifest 声明支持而引擎实际不支持）→ gate 读不到（同步面只有
//     manifest），由首个 run 的协议握手 `initialize` 发现 → engine_capability_mismatch
//     该 run 失败 + record 标 failed + **清理 run 前已建的前置副作用**（worktree：
//     executeViaEngine 在 kickOffEngineRun 前创建，经 finalizeFailed → finalizeRecord
//     Step 3b cleanupWorktreeIfBound 清理）。判定函数 = 本文件
//     assertGateCapabilitiesMatched（core 侧判据；协议客户端握手尾接线归 client/ 领地）。
//   - **非 gate 位**（personaInjection / eventGranularity / sessionRead / resume /
//     interrupt / permissionMode / schemaEnforcement）不一致（无论强弱）→ 一律 warn
//     留痕不阻断（诊断面 = EngineClient.warnOnManifestDiagnostics）。
//
// 调用点仍是两处（单点的是实现，不是调用点）：
//   - chat 域：executeViaEngine 同步段、record 创建前（engine.capabilities() 同步可得，
//     承接「全部同步拒绝发生在 record 创建前、不产生孤儿 record」不变量）；
//   - workflow 域：SAR.run 路由后、engine.run 前（同模块调用）。
//
// 行为变化声明：唯一有意行为变化 = workflow 域 zcode+worktree 由漏拦变拦截（修复
// 双轨清单 #7 的跨域缺口）；pi 的 maxTurns/fork/conversation/worktree 等既有合法
// 能力零拦截（V4⑤ 反向守护）。[W3] recovery 文案随协议化变更：恢复指引主指向
// 「修 manifest / 升级引擎包」（引擎包是能力声明的载体，换引擎不再是缺省指引——
// 协议化后不存在「内置 pi 恒可用」兜底）。

// [W3 v1.x] conversation gate 判据单源 = SDK 具名构造器（W1 交接防漂移项：core 内联
// 文案与引擎侧 assertChatConversationSupported 双份文案的漂移面消除——同一构造器
// 两侧消费，错误码/恢复指引契约单一权威）。
import { engineConversationUnsupportedError } from "@zhushanwen/subagent-engine-sdk";

import { EngineError } from "./errors.ts";
import type { EngineCapabilities } from "../types.ts";

/**
 * 预检输入的任务形状子集——ExecuteOptions（chat 域）与 AgentCallOpts（D6 合流后的
 * 单一任务形状，workflow 域 SAR 直传）共有的能力相关字段面。结构子集而非具体类型：
 * 两域的 opts 类型都能直接传入。
 */
export interface TaskShapeForGate {
  conversation?: boolean;
  fork?: boolean;
  forkFromSessionFile?: string;
  worktree?: boolean | { path: string };
  maxTurns?: number;
}

/** 恢复指引公共尾段（W3 协议化口径：能力声明的修复通道 = manifest / 引擎包升级）。 */
const MANIFEST_RECOVERY_TAIL = "修 manifest capabilities / 升级引擎包（若引擎实际支持该能力）";

/**
 * 调用前预检：任务形状中的能力参数对引擎 capabilities 逐一对照，声明不支持即抛
 * EngineError(engine_capability_unsupported)——同步 throw、进程/record 创建前，文案
 * 含 capabilities 依据与恢复指引（修 manifest / 升级引擎包 / 调整任务参数）。
 *
 * fork 判据说明（借位裁定）：fork 依赖父 session 上下文继承（父会话文件作为分叉源），
 * 引擎具备该语义的能力面信号 = 会话分叉/交互通道族（steer 或 conversation 任一非
 * 'unsupported'，**OR 语义任一可用即放行**）。pi conversation='native'（chatMode idle
 * 复用）→ 放行；zcode 双 'unsupported'（argv-only spawn 单轮，无父 session 分叉通道）
 * → 拒绝。仅凭 steer 判会误拦 pi（pi 的 steer 声明 'unsupported'——RPC 有但 spawn
 * 链路未接通，与 fork 的初始上下文继承是两条轴），故取通道族任一可用即支持的分寸。
 */
export function assertTaskShapeSupported(
  engineId: string,
  caps: EngineCapabilities,
  task: TaskShapeForGate,
): void {
  if (task.conversation === true && caps.conversation === "unsupported") {
    // [W1 交接防漂移项落地] 文案/错误码/恢复指引单源 = SDK engineConversationUnsupportedError
    // （引擎侧 server.run chat gate 消费同一构造器——A6 双向负向面两侧同文案）。
    // 错误载体类型 EngineError → EngineSdkError（code/recovery/message 前缀契约不变，
    // name 变化不影响消费方——无 instanceof EngineError 判据，code 字段分流）。
    throw engineConversationUnsupportedError(engineId);
  }
  if (task.fork === true || task.forkFromSessionFile !== undefined) {
    if (caps.steer === "unsupported" && caps.conversation === "unsupported") {
      throw new EngineError(
        "engine_capability_unsupported",
        `engine '${engineId}' 不支持 fork${task.forkFromSessionFile !== undefined ? "（fork-from 同为父 session 上下文继承）" : ""}（fork 依赖父 session 上下文继承，` +
          `capabilities.steer = '${caps.steer}' / conversation = '${caps.conversation}'——引擎无父 session 分叉通道）`,
        `把所需父上下文写进 task 正文后不传 fork，或 ${MANIFEST_RECOVERY_TAIL}`,
      );
    }
  }
  if (task.maxTurns !== undefined && caps.maxTurns === false) {
    throw new EngineError(
      "engine_capability_unsupported",
      `engine '${engineId}' 不支持 maxTurns（capabilities.maxTurns = false，轮数上限依赖 turn_end 事件流，` +
        `本引擎无此语义——静默丢弃会造成「传了上限却失控」的假象）`,
      `去掉 maxTurns 参数重派，或 ${MANIFEST_RECOVERY_TAIL}`,
    );
  }
  if ((task.worktree === true || typeof task.worktree === "object") && caps.sandbox === "none") {
    throw new EngineError(
      "engine_capability_unsupported",
      `engine '${engineId}' 不支持 worktree 隔离（capabilities.sandbox = 'none'，` +
        `引擎未接文件系统隔离层）`,
      `去掉 worktree 参数（在 parent cwd 执行），或 ${MANIFEST_RECOVERY_TAIL}`,
    );
  }
}

// ============================================================
// 能力位方向判定②：manifest 多声明 → run 期握手发现（engine_capability_mismatch）
// ============================================================

/**
 * manifest vs `initialize` 应答的 gate 位方向判定（设计 §3.3 能力位表「多声明」行）。
 *
 * 只判被 gate 四类判据涉及的能力位中「manifest 声明可用、引擎应答不支持」的多声明
 * 方向（少声明方向在派发前已被 assertTaskShapeSupported 同步拦，握手不会发生——gate
 * 先行的结构性结果）；命中抛 EngineError(engine_capability_mismatch)，由首个 run 的
 * 协议路径转化为该 run 失败 + record 标 failed + 清理前置副作用（契约变更⑤）。
 * 非 gate 位不一致不进本判定（无论强弱一律 warn 留痕，归 EngineClient 诊断面）。
 *
 * 各 gate 位的「manifest 可用」取值语义与 assertTaskShapeSupported 逐条对偶：
 *   conversation 应答 'unsupported' 而 manifest 非 'unsupported' → mismatch；
 *   fork 通道族应答双 'unsupported' 而 manifest 任一可用 → mismatch（OR 对偶）；
 *   maxTurns 应答 false 而 manifest true → mismatch；
 *   sandbox 应答 'none' 而 manifest 非 'none' → mismatch。
 *
 * 接线位置（领地边界声明）：本函数是 core 侧判据单源；协议客户端在首个 run 前握手
 * 后（EngineClient.initialize 应答 → RemoteEngine.run 发 run 帧前）调用——client/ 为
 * W2 已交付领地，接线归后续单元（W8/W10），不属本文件。
 */
export function assertGateCapabilitiesMatched(
  engineId: string,
  manifestCaps: EngineCapabilities,
  answeredCaps: EngineCapabilities,
): void {
  if (
    manifestCaps.conversation !== "unsupported" &&
    answeredCaps.conversation === "unsupported"
  ) {
    throw gateMismatchError(engineId, "conversation", manifestCaps.conversation, answeredCaps.conversation);
  }
  const manifestForkCapable = manifestCaps.steer !== "unsupported" || manifestCaps.conversation !== "unsupported";
  const answeredForkCapable = answeredCaps.steer !== "unsupported" || answeredCaps.conversation !== "unsupported";
  if (manifestForkCapable && !answeredForkCapable) {
    throw gateMismatchError(
      engineId,
      "fork（steer/conversation 通道族）",
      `steer=${manifestCaps.steer}/conversation=${manifestCaps.conversation}`,
      `steer=${answeredCaps.steer}/conversation=${answeredCaps.conversation}`,
    );
  }
  if (manifestCaps.maxTurns === true && answeredCaps.maxTurns === false) {
    throw gateMismatchError(engineId, "maxTurns", String(manifestCaps.maxTurns), String(answeredCaps.maxTurns));
  }
  if (manifestCaps.sandbox !== "none" && answeredCaps.sandbox === "none") {
    throw gateMismatchError(engineId, "sandbox（worktree）", manifestCaps.sandbox, answeredCaps.sandbox);
  }
}

// ============================================================
// 能力位方向判定③：SP-5 升级 gate（H1 U2 / D5 双写点共用文案单源）
// ============================================================

/**
 * [H1 U2 / D5 双写点] SP-5 升级（one-shot → chatMode）被 conversation 位拒绝时的
 * 统一错误构造（文案/错误码/恢复指引单一权威）。
 *
 * 两个写点共同消费（现场契约「改动这两处必须协同」的 gate 化落点）：
 *   - 写点①进程内热升级：subagent-actions-core messageHandler；
 *   - 写点②跨重启冷升级（D4 revive 格）：conversation-continuation（U6 已删
 *     cold-resurrect 无条件置位——语义迁入本格，磁盘重建只水合持久化 chatMode）。
 *
 * unsupported 引擎（zcode）的 one-shot 收到 message 不升级——升级后续聊行为悬空
 * （Continuation 续聊轮依赖引擎 resume 能力），guard 文案指引 fork/重派。
 */
export function engineConversationUpgradeUnsupportedError(engineId: string): EngineError {
  return new EngineError(
    "engine_capability_unsupported",
    `subagent completed as one-shot on engine '${engineId}' (capabilities.conversation = 'unsupported') — ` +
      `it cannot be upgraded to a resumable conversation, so the message is rejected.`,
    `Recovery: re-dispatch the follow-up as a new subagent (action:'start'), ` +
      `or branch from its session history with action:'fork-from', ` +
      `or pick an engine that declares the conversation capability.`,
  );
}

/** engine_capability_mismatch 的统一构造（manifest 权威 + 恢复指引 = 修 manifest / 升级引擎包）。 */
function gateMismatchError(engineId: string, cap: string, declared: string, answered: string): EngineError {
  return new EngineError(
    "engine_capability_mismatch",
    `engine '${engineId}' manifest 声明的能力位 '${cap}'（${declared}）与引擎 initialize 应答不符（${answered}）` +
      `——manifest 多声明，任务按 gate 判据放行后引擎无法兑现`,
    `修 manifest capabilities（与引擎实际能力对齐）或升级引擎包；若任务不再需要该能力，调整任务参数后重派`,
  );
}
