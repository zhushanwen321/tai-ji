// src/execution/engine/engines/zcode/session-channel.ts
//
// ZcodeEngine app-server 会话层（R3）。设计权威源：
// docs/design/zcode-engine-appserver-resident.md §3.3 D4（会话生命周期：每任务自包含
// create→run→close，不做热会话复用）/ §2.4 目标数据流 ①-⑦ / §3.4 不变量 1
// （text_delta 拼接 == read 全文、终态唯一 turn.terminal 权威、收尾帧 usage 完整）
// 与 2（resolve 严格晚于全部事件回调）/ 附录 A.2（任务生命周期帧序列——协议权威，
// 本文件帧字段逐字来源）。旧实现参照：zsw 仓 84b63a0^ lib/runner-appserver.js 的
// _createTurn/_fetchFinalResponse 同等层（终态判定 / read 兜底链为真机已验证形态，
// TS 重写收窄到 D4 单任务自包含面——-32004 四步恢复序 / resume / 热会话复用整体
// out of scope，见设计 D4 连带声明）。
//
// 分层边界（与 R4 的接线面）：
//   - 本层只做「单任务会话通道」：create/subscribe/send/终态/read/close + runTurn
//     组合入口。AgentEvent 合成（text_delta→事件流、message_end.usage 映射走
//     parser.mapZcodeUsage 同源）与 abort 链（session/stop→杀链）归 R4 编排层；
//   - 连接生命周期（惰性启动/重建/dispose）归 AppServerConnection（R2）与 R4；
//   - 错误透传纪律：RPC error 应答（AppServerRpcError，含 code/message/data）原样
//     上抛不吞不包装——R5 降级链按 code（-32601/-32602 漂移类）归类（§3.3 错误规格表）。
//
// 终态判定（D4 + 不变量 1）双保险：
//   1. turn.terminal 权威：v4/telemetry/event {kind:"turn.terminal"} 到达即终态
//      （success/error 均 算终态——旧实现实证：不归类会挂到超时）；
//   2. 宽松匹配防洪堤：turn.terminal 缺失/迟到时，收尾帧（session/event
//      payload.response 非空）即终态——防协议小漂移把任务挂死到超时预算。
//   终态判定后：收尾帧数据（response/usage）仍吸收（它属终态数据不是增量回调，
//   且与 turn.terminal 常在同一 stdout 批次到达）；迟到 delta 不再触发回调
//   （不变量 2 的另一半：resolve 后不再发事件）。
//
// 连接崩溃的 turn 收割（R4 已补齐）：SessionChannel 在构造时订阅 AppServerConnection
// 的 onClose 面——进程死亡（崩溃/我方杀链）时立即 fail 全部在途 turn（错误即连接层
// 的崩溃 reason，含 stderr 尾部），不再依赖 turn 等待预算挂满才收割。
// （onClose 由连接层保证在全部在途 request reject 之后触发。）
//
// turn 等待两 timer 状态机（P0-1 根修，设计权威源
// docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D1/D2）：旧 300s 固定
// 墙钟（timer 从 send 起跳、事件不刷新，T001 实测 21% 活跃任务被误杀）替换为——
//   1. idle 主判定：本 turn 任何事件（session/event、telemetry stream.chunk/
//      turn.terminal）刷新计时；连续静默达阈值判「执行已不可推进」（活跃事件流
//      零误杀，ADR-0047 逆否面）；缺省 30min（ZCODE_TURN_IDLE_TIMEOUT_MS，
//      ⛔P-Z1 标定前先验值）；
//   2. 总上界回收兜底：从挂载起固定不刷新，兜 idle 覆盖不了的 chatty-wedge
//      （事件持续但终态永不到达）；缺省 60min（ZCODE_TURN_MAX_TIMEOUT_MS，
//      ⛔P-Z0 标定前先验值；对超上界合法极长任务是显式接受的残余误杀面）。
//   任一 fire → reject TurnTimeoutError{kind:"idle"|"ceiling", lastEventAt,
//   elapsed}（类型化，R4 引擎据此分流与合成 engine_timeout 文案）。两阈值 env
//   可调（XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS / XYZ_ZCODE_TURN_MAX_TIMEOUT_MS）、
//   ≤0 显式关闭（关闭时 warn 明示后果——规则 19 opt-out，A10① 断言依据）。
//   create 应答先于挂 timer 到达（runTurn 先 createSession 后 openTurn），不参与
//   刷新。

import { createHash } from "node:crypto";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import type { AppServerConnection } from "./connection.ts";
import {
  ZCODE_APPSERVER_TURN_CLOSE_TIMEOUT_MS,
  ZCODE_APPSERVER_TURN_READ_TIMEOUT_MS,
  ZCODE_TURN_IDLE_TIMEOUT_ENV,
  ZCODE_TURN_IDLE_TIMEOUT_MS,
  ZCODE_TURN_MAX_TIMEOUT_ENV,
  ZCODE_TURN_MAX_TIMEOUT_MS,
  isFailedTerminalStatus,
  parseZcodeTurnTimeoutEnv,
} from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";

const logger = getLogger("subagents");

/** session/subscribe 的 deliveryKind 必填值（A.2 ②——缺失则终态事件不达、会话假死，旧实测）。 */
export const SUBSCRIBE_DELIVERY_KIND = "desktop-continuous";

/** workspaceKey 取 sha256 hex 的前导字符数（旧实现实测形态 'ws-' + 16 hex 短 hash）。 */
const WORKSPACE_KEY_HASH_CHARS = 16;

/** create 应答异常时的摘要截断长度（够定位形态、不刷屏——与旧实现同值）。 */
const CREATE_REPLY_LOG_CHARS = 300;

/** 推送帧文本进日志的截断长度（诊断够用即可）。 */
const DELTA_LOG_CHARS = 120;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return toErrorMessage(err);
}

// ============================================================
// 协议形态提取（纯函数，conformance/golden 回放层可复用）
// ============================================================

/**
 * workspacePath → 稳定短 hash（A.2 ①：workspaceKey 算法不限；取旧实现实测形态
 * 'ws-' + sha256 前 16 hex）。
 */
export function stableWorkspaceKey(workspacePath: string): string {
  return (
    "ws-" +
    createHash("sha256")
      .update(workspacePath)
      .digest("hex")
      .slice(0, WORKSPACE_KEY_HASH_CHARS)
  );
}

/**
 * 从 session/create 应答提取 sessionId。A.2 ①：权威位置 result.session.sessionId
 * （**projection.sessionId 恒 "unknown"，勿用**）；session.id / 顶层 sessionId 为
 * 历史/未来形态的宽松兜底（旧实现实测提取链）。
 */
export function extractCreatedSessionId(created: unknown): string | undefined {
  if (!isRecord(created)) return undefined;
  const session = isRecord(created.session) ? created.session : undefined;
  if (
    session !== undefined &&
    typeof session.sessionId === "string" &&
    session.sessionId !== ""
  ) {
    return session.sessionId;
  }
  if (
    session !== undefined &&
    typeof session.id === "string" &&
    session.id !== ""
  ) {
    return session.id;
  }
  if (typeof created.sessionId === "string" && created.sessionId !== "") {
    return created.sessionId;
  }
  return undefined;
}

/** 推送帧的会话归属（A.2：session/event 帧带 params.sessionId；telemetry 帧未标——
 * 无 sid 时由 lookupTurn 按唯一在途兜底归因，多在途宁丢勿错，旧实现同策略）。 */
function extractPushSessionId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (typeof params.sessionId === "string" && params.sessionId !== "")
    return params.sessionId;
  if (
    isRecord(params.session) &&
    typeof params.session.id === "string" &&
    params.session.id !== ""
  ) {
    return params.session.id;
  }
  return undefined;
}

/** read 应答消息条目的 role（实测主形态在 m.info.role，旧形态在 m.role）。 */
function messageRole(m: Record<string, unknown>): string | undefined {
  if (typeof m.role === "string") return m.role;
  if (isRecord(m.info) && typeof m.info.role === "string") return m.info.role;
  return undefined;
}

/** parts[] 中 type:'text' 部件的 text 拼接（A.2 ⑥ 主形态；无 text 部件 → undefined）。 */
function partsToText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    if (isRecord(p) && p.type === "text" && typeof p.text === "string")
      texts.push(p.text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/** content 三形态（字符串 / {text} / 块数组）的旧形态兼容提取。 */
function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string")
    return content.text;
  if (Array.isArray(content)) {
    const texts = content.map((b) => {
      if (typeof b === "string") return b;
      return isRecord(b) && typeof b.text === "string" ? b.text : "";
    });
    const joined = texts.join("");
    return joined !== "" ? joined : undefined;
  }
  return undefined;
}

/**
 * 从 session/read 应答提取最后一条 assistant 全文（A.2 ⑥：messages[].parts[] 中
 * type:'text' 的 text 拼接；role 在 m.info.role 实测主形态，m.role/m.content 旧形态
 * 兼容——旧实现已验证宽容链）。提取不到返回 undefined（调用方走收尾帧→delta 聚合）。
 */
export function extractAssistantText(readResult: unknown): string | undefined {
  if (typeof readResult === "string") return readResult;
  if (!isRecord(readResult)) return undefined;
  if (Array.isArray(readResult.messages)) {
    const last = [...readResult.messages]
      .reverse()
      .find(
        (m): m is Record<string, unknown> =>
          isRecord(m) &&
          (messageRole(m) === "assistant" || messageRole(m) === undefined)
      );
    if (last !== undefined) {
      const viaContent = contentToText(last.content);
      if (viaContent !== undefined) return viaContent;
      const viaParts = partsToText(last.parts);
      if (viaParts !== undefined) return viaParts;
    }
  }
  for (const k of ["text", "response", "content", "message"] as const) {
    if (typeof readResult[k] === "string") return readResult[k] as string;
  }
  return undefined;
}

/**
 * 从 session/read 应答提取 usage。tokens 在最后一条 assistant 消息 parts 的
 * step-finish 部件 tokens 字段——结构属 A.5 未确认项（未真机复核），宽容解析：
 * tokens 是对象即收、字段缺席不抛；顶层 usage 旧假设形态兜底。
 */
export function extractReadUsage(
  readResult: unknown
): SessionTurnUsage | undefined {
  if (!isRecord(readResult)) return undefined;
  const messages = Array.isArray(readResult.messages)
    ? readResult.messages
    : [];
  for (const m of [...messages].reverse()) {
    if (
      !isRecord(m) ||
      messageRole(m) !== "assistant" ||
      !Array.isArray(m.parts)
    )
      continue;
    const finish = [...m.parts]
      .reverse()
      .find(
        (p) => isRecord(p) && p.type === "step-finish" && isRecord(p.tokens)
      );
    if (finish !== undefined && isRecord(finish.tokens)) return finish.tokens;
  }
  return isRecord(readResult.usage) ? readResult.usage : undefined;
}

// ============================================================
// 类型（R4 引擎 run 的消费面）
// ============================================================

/** session/create 的 per-session 模型（A.2 ①：strict 对象——字符串会被 -32602 拒收）。 */
export interface SessionModelSpec {
  providerId: string;
  modelId: string;
  variant?: string;
}

/** session/create 参数（A.2 ① 键集逐字；workspaceKey 由 workspacePath 派生，不手传）。 */
export interface SessionCreateParams {
  workspacePath: string;
  /** 权限模式（如 "yolo"）——值语义不限（A.2），由调用方（R4）决定。 */
  mode: string;
  model?: SessionModelSpec;
  thoughtLevel?: string;
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

/**
 * 一轮 usage（宽容形态）：主形态收尾帧 {inputTokens, outputTokens}（A.2 ⑤ 权威）；
 * 兜底形态 read step-finish tokens {input,...}（A.5 未确认项）。字段名到 AgentUsage
 * 的映射归 R4（与 parser.mapZcodeUsage 同源），本层不做字段转换。
 */
export interface SessionTurnUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  [key: string]: unknown;
}

/** runTurn 的流式回调（R4 映射为 AgentEvent {type:"text_delta", delta}）。 */
export interface SessionTurnCallbacks {
  /** payload.delta 实时文本增量（A.2 ④：文本在 session/event，stream.chunk 无文本）。 */
  onTextDelta?: (delta: string) => void;
  /**
   * payload.kind === "reasoning_delta" 的推理增量（F2 口径裁决 2026-09-09：answer
   * 通道 = text_delta；reasoning 通道单独分流，不混入 text 流——session/event 推送
   * 的 kind 字段区分两通道，read 兜底的 assistant 全文也只含 text parts，两侧对齐
   * 后不变量 3a byte 级成立）。kind 缺席的旧形态按 text 处理（向后兼容）。
   */
  onThinkingDelta?: (delta: string) => void;
  /**
   * [R4] create 应答后立即回调（sessionId 已知、早于 subscribe/send/终态）。引擎
   * 编排层的 onHandleReady 回填（§3.4 不变量 3）与 abort 链的 session/stop 目标
   * 都挂在这个时点——runTurn 的 resolve 形态在终态前拿不到 sessionId。
   */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * [PR3] 非终态、非增量的 session/event 帧到达回调（tool.updated progress /
   * turn.started / hook 事件等引擎可见但宿主不可见的进展）。真机探针实证
   * （/tmp/zcode-activity-probe.log，2026-09-10）：工具执行期服务端每 ~1.0s 推一帧
   * {type:"tool.updated", payload:{kind:"progress", toolCallId, toolName, elapsedMs,
   * stdoutBytes, stdoutTail, pid}}——既非 final-frame 也非 delta，宿主刷新面只有
   * delta 回调，「仅工具执行、零正文」形态下宿主侧 30min 中段无进展守护会饿死
   * 误杀，本回调补 tool 执行期活性（引擎映射 AgentEvent {type:"activity"}——
   * 零载荷纯活性信号）。cadence ~1s，不加节流：服务端天然限频（探针实证），无放大面。
   */
  onActivity?: () => void;
}

/** turn 超时的判定形态（P0-1 D1：idle 主判定 / 总上界兜底——引擎分流与文案的判据）。 */
export type TurnTimeoutKind = "idle" | "ceiling";

/**
 * turn 等待两 timer 的类型化超时错误（P0-1 D1/D4）。引擎（R4）按 `kind` 分流：
 * 超时入口接 abort 链（stop 应答三态裁决）+ `engine_timeout` 前缀合成——不经
 * 字符串匹配。字段供 outcome 文案使用：`elapsed` 距 openTurn 挂载的总时长；
 * `lastEventAt` 最后一次事件到达时刻（整轮无任何事件时 undefined——进程假死/
 * 协议静默形态的证据）。
 */
export class TurnTimeoutError extends Error {
  readonly kind: TurnTimeoutKind;
  readonly elapsed: number;
  readonly lastEventAt: number | undefined;
  readonly thresholdMs: number;

  constructor(
    kind: TurnTimeoutKind,
    parts: {
      thresholdMs: number;
      elapsed: number;
      lastEventAt: number | undefined;
    }
  ) {
    super(
      kind === "idle"
        ? `zcode turn idle 判死：连续 ${parts.thresholdMs}ms 未观察到本 turn 任何事件` +
            "（session/event 与 v4/telemetry/event 均静默），终态未到达。" +
            (parts.lastEventAt === undefined
              ? "本轮自 send 起未观察到任何事件（进程假死/协议静默形态）。"
              : `最后事件时刻 ${new Date(parts.lastEventAt).toISOString()}。`) +
            "恢复指引：直接重跑本任务；若持续出现，检查 ZCode 桌面端模型连通性或改用 engine: pi。"
        : `zcode turn 总上界判死：${parts.thresholdMs}ms 内未观察到终态` +
            "（turn.terminal 与收尾帧均未到达；idle 判定未触发——事件流仍活跃，chatty-wedge 形态）。" +
            (parts.lastEventAt === undefined
              ? ""
              : `最后事件时刻 ${new Date(parts.lastEventAt).toISOString()}。`) +
            `恢复指引：直接重跑本任务；若本任务属合法超长任务（预期超过 ${parts.thresholdMs}ms 总上界），` +
            `重跑前设 ${ZCODE_TURN_MAX_TIMEOUT_ENV} 为更大毫秒值，或设 0 关闭总上界` +
            "（关闭后 chatty 形态不再自动回收，静默 wedged 仍由 idle 层兜底——自行权衡）。"
    );
    this.name = "TurnTimeoutError";
    this.kind = kind;
    this.elapsed = parts.elapsed;
    this.lastEventAt = parts.lastEventAt;
    this.thresholdMs = parts.thresholdMs;
  }
}

export interface SessionTurnOptions extends SessionTurnCallbacks {
  /**
   * 显式总上界（ms，P0-1 D1/D2 语义收窄：不再是从 send 起跳的固定墙钟缺省预算，
   * 而是「显式总上界」传参面——缺省走 env `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS` →
   * `ZCODE_TURN_MAX_TIMEOUT_MS`（60min 先验值）；≤0 显式关闭该 timer。工具面
   * 不暴露（D2），引擎内部传参点（D6 重试预算继承传剩余值）。
   */
  turnTimeoutMs?: number;
  /**
   * idle 主判定静默阈值（ms，P0-1 D2 内部传参点）：缺省走 env
   * `XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS` → `ZCODE_TURN_IDLE_TIMEOUT_MS`（30min
   * 先验值）；≤0 显式关闭该 timer。
   */
  idleTimeoutMs?: number;
}

/** 终态信号来源（D4：turn.terminal 权威；final-frame = 宽松判定防洪堤）。 */
export type TerminalSource = "turn.terminal" | "final-frame";

export interface SessionTurnResult {
  sessionId: string;
  /** 全文优先级：read 兜底（权威）→ 收尾帧 response → delta 聚合。 */
  response: string;
  /** usage 优先级：收尾帧（A.2 权威）→ read step-finish tokens（宽容）→ 缺席。 */
  usage?: SessionTurnUsage;
  terminal: { status: string; source: TerminalSource };
  /**
   * 权威终态 turn.terminal 的 status 记录（P0-1 D5①/S5 修复）：权威终态晚于
   * final-frame 宽松终态到达时只记录不改写已落定 `terminal`——消费层据此识破
   * 假成功（final-frame 恒 success）。无 turn.terminal 到达时缺席。
   */
  lastTerminalStatus?: string;
  /**
   * 权威终态 turn.terminal 的错误详情（⛔P-Z2 实证：真实 failed 终态的 errorCode/
   * errorMessage 只在 terminal 帧携带——read/delta 拿不到，丢即诊断信息永久丢失）。
   * 先到/迟到都记录（与 lastTerminalStatus 同型）；至少其一存在才带此字段。
   */
  lastTerminalError?: { code?: string; message?: string };
}

// ============================================================
// 会话通道
// ============================================================

/** 终态信息（turn.terminal 的 status 原样透传——错误语义由 R4 结果层处理）。 */
interface TerminalInfo {
  status: string;
  source: TerminalSource;
}

/**
 * 一个在途 turn 的全部状态（推送泵的归因目标）。settle/fail 由 openTurn 装配
 * （互斥守卫 + timer 清理 + done promise 落定），泵内只调用不感知装配细节。
 */
interface ActiveTurn {
  readonly sessionId: string;
  readonly callbacks: SessionTurnCallbacks;
  /** 终态判定是否已落定（settle/fail 任一先行即 true——后续重复终态不再受理）。 */
  settled: boolean;
  deltas: string[];
  finalText: string | undefined;
  finalUsage: SessionTurnUsage | undefined;
  terminal: TerminalInfo | undefined;
  /** 权威终态 turn.terminal 的 status 记录（先到/迟到都记——D5①）。 */
  lastTerminalStatus: string | undefined;
  /** 权威终态 turn.terminal 的错误详情（先到/迟到都记——⛔P-Z2，terminal 帧独有）。 */
  lastTerminalError: { code?: string; message?: string } | undefined;
  /** 本轮生效阈值（openTurn 解析后的值，fire 时进 TurnTimeoutError 文案）。 */
  idleMs: number;
  ceilingMs: number;
  /** 挂载时刻（elapsed 起算点）。 */
  startedAt: number;
  /** 最后一次事件到达时刻（epoch ms；整轮无事件 undefined——idle 判定的证据面）。 */
  lastEventAt: number | undefined;
  /** 两 timer 句柄（刷新=clearTimeout+重挂；settle/fail/fire 统一清理）。 */
  idleTimer: NodeJS.Timeout | undefined;
  ceilingTimer: NodeJS.Timeout | undefined;
  settle: (t: TerminalInfo) => void;
  fail: (err: Error) => void;
  /** 超时落定（openTurn 装配：互斥守卫 + 清 timer + 类型化 reject）。 */
  fireTimeout: (kind: TurnTimeoutKind) => void;
}

/** 两 timer 统一清理（settle/fail/超时 fire/runTurn finally 四路共匯）。 */
function clearTurnTimers(turn: ActiveTurn): void {
  if (turn.idleTimer !== undefined) {
    clearTimeout(turn.idleTimer);
    turn.idleTimer = undefined;
  }
  if (turn.ceilingTimer !== undefined) {
    clearTimeout(turn.ceilingTimer);
    turn.ceilingTimer = undefined;
  }
}

/** setTimeout + unref（守卫进程退出不被 turn 预算拖住——既有 300s timer 同形态）。 */
function armTurnTimer(onFire: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(onFire, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * 单个 turn timer 阈值解析（P0-1 D2）：显式传参 > env > 缺省默认。env ≤0 与显式
 * ≤0 同为「显式关闭」语义（与 `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 先例的刻意分歧，
 * 设计 D2/r3 SG-5 登记）；env 非法 warn+回落默认。**关闭必须 warn 明示后果**——
 * 静默失去回收层 = 「以为有兜底、实际裸奔」，生效行为必须可见（A10① 断言依据）。
 */
function resolveTurnTimerMs(parts: {
  explicit: number | undefined;
  envName: string;
  fallbackMs: number;
  label: string;
  offConsequence: string;
}): number {
  let value: number;
  let source: string;
  if (parts.explicit !== undefined) {
    value = parts.explicit;
    source = "显式传参";
  } else {
    const raw = process.env[parts.envName];
    const parsed = parseZcodeTurnTimeoutEnv(raw);
    if (parsed.state === "valid") {
      value = parsed.ms;
      source = `env ${parts.envName}=${raw}`;
    } else {
      if (parsed.state === "invalid") {
        logger.warn(
          `[session-channel] ${parts.envName}="${raw}" 非法（应为毫秒数字）——回落默认 ${parts.fallbackMs}ms（${parts.label}）。设置正毫秒值覆盖，或 0 显式关闭`
        );
      }
      value = parts.fallbackMs;
      source = "默认值";
    }
  }
  if (value <= 0) {
    logger.warn(
      `[session-channel] zcode turn ${parts.label}已关闭（${source}）——${parts.offConsequence}。设正毫秒值（env ${parts.envName} 或显式传参）恢复回收层`
    );
  }
  return value;
}

/**
 * 单任务会话通道（D4）：在一条共享 AppServerConnection 上实现
 * create→subscribe→send→（事件流）→终态→read 兜底→resolve→close 的自包含生命周期。
 * 多 session 可在同一条连接上并发（sessionId 归因防串线；无 sid 的推送帧仅归因到
 * 唯一在途 turn，多在途宁丢勿错）。
 */
export class SessionChannel {
  private readonly conn: AppServerConnection;
  /** sessionId → 在途 turn（终态落定后仍保留到 runTurn 收尾——收尾帧数据吸收窗口）。 */
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly offHandlers: Array<() => void>;
  /**
   * [P0-1 U5/D7] dispose 标志：dispose 收割后 closeSession 短路——收割形态下连接
   * 可能仍 alive（close 事件迟到，finalize 未跑、child 非 null），此时发 close
   * request 会写死进程（请求挂到控制面超时）或触发惰性重建（凭空 spawn 无人使用的
   * 进程，违背 dispose 防泄漏语义）；进程随即被引擎杀链回收，会话驻留随之消亡。
   */
  private disposed = false;

  constructor(conn: AppServerConnection) {
    this.conn = conn;
    this.offHandlers = [
      conn.onNotification("session/event", (params) =>
        this.handleSessionEvent(params)
      ),
      conn.onNotification("v4/telemetry/event", (params) =>
        this.handleTelemetry(params)
      ),
      // 连接崩溃收割：进程死亡（崩溃/我方杀链）立即 fail 全部在途 turn——
      // onClose 契约保证触发时连接层在途 request 已全部 reject，此处补齐
      // 「无在途 request 的 turn」的收割（否则挂到 turn idle/总上界预算耗尽）
      conn.onClose((reason) => this.failAllTurns(`app-server ${reason}`)),
    ];
  }

  /**
   * [P0-1 U5/D7] dispose 前收割 + 退订：「退订 = 不会再有事件」在结构上蕴含「在途
   * turn 不应再等」——close 缺失/被吞没形态（onClose 收割主路径未触发）下，在途
   * turn 于退订前经既有 failAllTurns 收敛为明确失败，不再挂满自身 idle/总上界预算
   * （设计 §3.4 退化路径闭合；race 窗口在引擎 shutdownRuntimeAndDisposeChannel，
   * 量级与 awaitConnFinalized 同源 ZCODE_APPSERVER_HARVEST_GRACE_MS）。幂等：与
   * onClose 收割先到者赢（turn.fail 的 settled 守卫——已落定 turn 不改写），
   * activeTurns 已空则 no-op。不影响连接自身生命周期（R4）。
   */
  dispose(): void {
    this.disposed = true;
    this.failAllTurns(
      "zcode session channel 已 dispose：连接 close 事件未在收割窗口内到达，" +
        "在途 turn 于退订前收割为明确失败（不再挂到 turn 自身预算耗尽）。恢复指引：直接重跑本任务。",
    );
    for (const off of this.offHandlers.splice(0)) off();
  }

  /** 连接死亡收割：全部在途 turn 立即 reject（reason 即连接层崩溃错误）。 */
  private failAllTurns(reason: string): void {
    const err = new Error(reason);
    for (const turn of [...this.activeTurns.values()]) {
      turn.fail(err);
      this.activeTurns.delete(turn.sessionId);
    }
  }

  /**
   * session/create（A.2 ① 键集逐字：对面 zod strict 拒未知键，出站必须精确）。
   * persistence:"immediate" 固定携带（D4：SQLite 持久化，上游不可覆盖）；空工具
   * 清单不设键（防上游带空数组）。sessionId 从 result.session.sessionId 提取
   * （projection.sessionId 恒 "unknown" 勿用）。
   */
  async createSession(params: SessionCreateParams): Promise<string> {
    const frame: Record<string, unknown> = {
      workspace: {
        workspacePath: params.workspacePath,
        workspaceKey: stableWorkspaceKey(params.workspacePath),
      },
      mode: params.mode,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.thoughtLevel !== undefined
        ? { thoughtLevel: params.thoughtLevel }
        : {}),
      ...(params.toolAllowlist !== undefined && params.toolAllowlist.length > 0
        ? { toolAllowlist: params.toolAllowlist }
        : {}),
      ...(params.toolDenylist !== undefined && params.toolDenylist.length > 0
        ? { toolDenylist: params.toolDenylist }
        : {}),
      persistence: "immediate",
    };
    const created = await this.conn.request("session/create", frame);
    const sessionId = extractCreatedSessionId(created);
    if (sessionId === undefined) {
      throw new Error(
        `session/create 未返回 sessionId: ${JSON.stringify(created).slice(
          0,
          CREATE_REPLY_LOG_CHARS
        )}`
      );
    }
    return sessionId;
  }

  /** session/subscribe（A.2 ②：deliveryKind 必填——缺失则终态事件不达、会话假死）。 */
  async subscribe(sessionId: string): Promise<void> {
    await this.conn.request("session/subscribe", {
      sessionId,
      deliveryKind: SUBSCRIBE_DELIVERY_KIND,
    });
  }

  /** session/send（A.2 ③：字段是 content 不是 text）→ {accepted:true}。 */
  async send(sessionId: string, content: string): Promise<void> {
    const r = await this.conn.request("session/send", { sessionId, content });
    if (isRecord(r) && r.accepted === false) {
      throw new Error(
        "session/send 返回 accepted:false（投递未被接受——会话可能已失效或拒绝投递）"
      );
    }
  }

  /**
   * session/close（A.2 ⑦，D4 用后即毁——回收引擎驻留内存，SQLite 持久化保留）。
   * best-effort：失败只 warn 不抛（会话已终态，close 失败只泄漏一个驻留会话，
   * 不应炸掉已成功/已失败的任务结论）。连接已死时跳过——close 是 request 语义，
   * 对死连接发请求会触发惰性重建（凭空 spawn 一代无人使用的进程）。
   */
  async closeSession(sessionId: string): Promise<void> {
    // [P0-1 U5/D7] dispose 收割后短路（先于 alive 守卫——收割形态下 alive 可仍为
    // true，见 disposed 字段注释）
    if (this.disposed) return;
    if (!this.conn.alive) return;
    try {
      await this.conn.request(
        "session/close",
        { sessionId },
        { timeoutMs: ZCODE_APPSERVER_TURN_CLOSE_TIMEOUT_MS }
      );
    } catch (err) {
      logger.warn(
        `session/close 失败（会话 ${sessionId}，best-effort 忽略）: ${errMessage(
          err
        )}`
      );
    }
  }

  /**
   * 单任务自包含入口（§2.4 ①-⑦）：create → subscribe → send → 事件流
   * （onTextDelta）→ 终态 → read 兜底 → resolve {response, usage, sessionId}
   * → close。resolve 严格晚于全部事件回调（不变量 2）；close 走 finally——成功/
   * 失败路径都回收会话（D4）。RPC 错误（含 -32601/-32602 漂移类）原样透传（R5 消费）。
   */
  async runTurn(
    params: SessionCreateParams,
    content: string,
    opts: SessionTurnOptions = {}
  ): Promise<SessionTurnResult> {
    if (content === "")
      throw new Error("runTurn: content 必填（session/send 空投递无意义）");
    const sessionId = await this.createSession(params);
    // create 应答后立即回调（§3.4 不变量 3 的 sessionRef 时点；引擎的
    // onHandleReady 回填与 abort 链 stop 目标都从这里取 sessionId）
    opts.onSessionCreated?.(sessionId);
    const opened = this.openTurn(sessionId, opts);
    try {
      await this.subscribe(sessionId);
      try {
        await this.send(sessionId, content);
      } catch (err) {
        // send 未送达（-32010 busy / -32602 漂移 / 连接死）：turn 无从等待终态
        opened.turn.fail(err instanceof Error ? err : new Error(String(err)));
        void opened.done.catch(() => {}); // done 已无 await 方，防 dangling rejection
        throw err;
      }
      const terminal = await opened.done;
      // 终态后 read 兜底（D4：read 是全文权威来源——不变量 1 双来源之二；
      // 失败/提取不到走收尾帧→delta 聚合降级链，不抛）
      const readResult = await this.readBestEffort(sessionId);
      const readText = extractAssistantText(readResult);
      const response =
        readText ?? opened.turn.finalText ?? opened.turn.deltas.join("");
      const usage = opened.turn.finalUsage ?? extractReadUsage(readResult);
      return {
        sessionId,
        response,
        ...(usage !== undefined ? { usage } : {}),
        terminal,
        ...(opened.turn.lastTerminalStatus !== undefined
          ? { lastTerminalStatus: opened.turn.lastTerminalStatus }
          : {}),
        ...(opened.turn.lastTerminalError !== undefined
          ? { lastTerminalError: opened.turn.lastTerminalError }
          : {}),
      };
    } finally {
      opened.stopTimers();
      this.activeTurns.delete(sessionId);
      await this.closeSession(sessionId);
    }
  }

  // ============================================================
  // 内部：turn 生命周期与推送泵
  // ============================================================

  private openTurn(
    sessionId: string,
    opts: SessionTurnOptions
  ): { turn: ActiveTurn; done: Promise<TerminalInfo>; stopTimers: () => void } {
    let resolveDone!: (t: TerminalInfo) => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<TerminalInfo>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const turn: ActiveTurn = {
      sessionId,
      callbacks: {
        onTextDelta: opts.onTextDelta,
        onThinkingDelta: opts.onThinkingDelta,
        // [PR3] tool 执行期活性回调（SessionTurnCallbacks.onActivity 注释——宿主侧
        // 无进展守护的工具执行期刷新面）
        onActivity: opts.onActivity,
      },
      settled: false,
      deltas: [],
      finalText: undefined,
      finalUsage: undefined,
      terminal: undefined,
      lastTerminalStatus: undefined,
      lastTerminalError: undefined,
      idleMs: 0,
      ceilingMs: 0,
      startedAt: Date.now(),
      lastEventAt: undefined,
      idleTimer: undefined,
      ceilingTimer: undefined,
      // 装配占位：下方 timer 创建后重绑（settle/fail 需要清理两 timer）
      settle: () => {},
      fail: () => {},
      fireTimeout: () => {},
    };
    turn.idleMs = resolveTurnTimerMs({
      explicit: opts.idleTimeoutMs,
      envName: ZCODE_TURN_IDLE_TIMEOUT_ENV,
      fallbackMs: ZCODE_TURN_IDLE_TIMEOUT_MS,
      label: "idle 主判定",
      offConsequence:
        "静默 wedged（无事件）形态将无自动回收，任务可能挂到宿主进程退出",
    });
    turn.ceilingMs = resolveTurnTimerMs({
      explicit: opts.turnTimeoutMs,
      envName: ZCODE_TURN_MAX_TIMEOUT_ENV,
      fallbackMs: ZCODE_TURN_MAX_TIMEOUT_MS,
      label: "总上界",
      offConsequence:
        "chatty-wedge（有事件无终态）形态将无自动回收，仅剩 idle 静默判定兜底",
    });
    // 两 timer 状态机（P0-1 D1）：idle 事件刷新重挂、总上界固定倒数；
    // 任一 fire → 类型化 TurnTimeoutError reject（kind 供 R4 分流）。
    const fireTimeout = (kind: TurnTimeoutKind): void => {
      if (turn.settled) return;
      turn.settled = true;
      clearTurnTimers(turn);
      this.activeTurns.delete(sessionId);
      rejectDone(
        new TurnTimeoutError(kind, {
          thresholdMs: kind === "idle" ? turn.idleMs : turn.ceilingMs,
          elapsed: Date.now() - turn.startedAt,
          lastEventAt: turn.lastEventAt,
        })
      );
    };
    turn.fireTimeout = fireTimeout;
    if (turn.idleMs > 0) {
      turn.idleTimer = armTurnTimer(() => turn.fireTimeout("idle"), turn.idleMs);
    }
    if (turn.ceilingMs > 0) {
      turn.ceilingTimer = armTurnTimer(
        () => turn.fireTimeout("ceiling"),
        turn.ceilingMs
      );
    }
    turn.settle = (t: TerminalInfo): void => {
      if (turn.settled) return;
      turn.settled = true;
      turn.terminal = t;
      clearTurnTimers(turn);
      resolveDone(t);
    };
    turn.fail = (err: Error): void => {
      if (turn.settled) return;
      turn.settled = true;
      clearTurnTimers(turn);
      rejectDone(err);
    };
    this.activeTurns.set(sessionId, turn);
    return { turn, done, stopTimers: () => clearTurnTimers(turn) };
  }

  /**
   * idle 主判定的事件刷新（P0-1 D1）：本 turn 任何事件到达即重置 idle 倒数——
   * 活跃事件流零误杀的结构保证。总上界不受影响（固定倒数）。已落定 turn 无
   * timer 可刷新（只剩 lastEventAt 记账）。
   */
  private refreshIdle(turn: ActiveTurn): void {
    turn.lastEventAt = Date.now();
    if (turn.settled || turn.idleTimer === undefined) return;
    clearTimeout(turn.idleTimer);
    turn.idleTimer = armTurnTimer(() => turn.fireTimeout("idle"), turn.idleMs);
  }

  private lookupTurn(sessionId: string | undefined): ActiveTurn | undefined {
    if (sessionId !== undefined) return this.activeTurns.get(sessionId);
    // 无 sid（A.2 telemetry 帧未标会话归属）：仅敢归因到唯一未落定 turn，
    // 多在途宁丢勿错（旧实现同策略——防串线）
    const pending: ActiveTurn[] = [];
    for (const t of this.activeTurns.values()) if (!t.settled) pending.push(t);
    return pending.length === 1 ? pending[0] : undefined;
  }

  /**
   * turn.terminal 专用归因（P0-1 U1/S5 归因放宽）：在 `lookupTurn` 基础上放宽
   * 「已落定 turn 不再受理」——权威终态晚于 final-frame 宽松终态到达（runTurn
   * 收尾窗口内 turn 仍在册）时仍归因，**只记录 status 不改写落定结果**（D5①）。
   * 带 sid 精确归因（落定与否均可）；无 sid 仍守宁丢勿错：唯一未落定优先，
   * 全部落定且在册仅剩一个（单任务收尾窗口的典型形态）才归因，多在途丢弃。
   */
  private lookupTurnForTerminal(
    sessionId: string | undefined
  ): ActiveTurn | undefined {
    if (sessionId !== undefined) return this.activeTurns.get(sessionId);
    const pending: ActiveTurn[] = [];
    for (const t of this.activeTurns.values()) if (!t.settled) pending.push(t);
    if (pending.length === 1) return pending[0];
    if (pending.length === 0 && this.activeTurns.size === 1) {
      return [...this.activeTurns.values()][0];
    }
    return undefined;
  }

  private handleSessionEvent(params: unknown): void {
    const turn = this.lookupTurn(extractPushSessionId(params));
    if (turn === undefined) return;
    const payload =
      isRecord(params) && isRecord(params.payload) ? params.payload : undefined;
    if (payload === undefined) return;
    // 事件到达即刷新 idle 主判定（P0-1 D1——本 turn 的任何 session/event 都算进展）
    this.refreshIdle(turn);
    if (this.applyFinalFrame(turn, payload)) return;
    // [PR3] 非 final-frame 且非 delta 的帧 = 引擎可见但宿主不可见的进展
    //（tool.updated progress / turn.started / hook 事件）：宿主刷新面只有 delta
    // 回调，「仅工具执行、零正文」形态下宿主侧无进展守护饿死误杀——onActivity 补
    // 该缺口。已落定 turn 不发（settle 后 run 已收尾，迟到帧只是收尾窗口噪声）。
    // 不加节流：服务端 tool.updated 天然 ~1s cadence（探针实证）。v4/telemetry 路径
    //（handleTelemetry/applyStreamChunkTelemetry）不加同款——session/event 镜像帧
    // 已覆盖（同 eventId），双发无增益。
    if (!this.applyStreamDelta(turn, payload) && !turn.settled) {
      turn.callbacks.onActivity?.();
    }
  }

  /**
   * 收尾帧判定与吸收（A.2 ⑤ 两种形态：payload.response / stopReason+content 变体）。
   * 命中任一形态则落 finalText/finalUsage 并以 final-frame 宽松终态收口，返回 true。
   */
  private applyFinalFrame(
    turn: ActiveTurn,
    payload: Record<string, unknown>
  ): boolean {
    if (typeof payload.response === "string" && payload.response !== "") {
      // 收尾帧（A.2 ⑤）：全文 + usage。终态落定后到达仍吸收数据（它常与
      // turn.terminal 同批次、且是 usage 权威来源——属终态数据不是增量回调）
      turn.finalText = payload.response;
      if (isRecord(payload.usage)) turn.finalUsage = payload.usage;
      turn.settle({ status: "success", source: "final-frame" });
      return true;
    }
    if (
      payload.stopReason === "stop" &&
      typeof payload.content === "string" &&
      payload.content !== ""
    ) {
      // 收尾的 content 形态变体（旧实测与 response 同值，携带 usage）
      turn.finalText = payload.content;
      if (isRecord(payload.usage)) turn.finalUsage = payload.usage;
      turn.settle({ status: "success", source: "final-frame" });
      return true;
    }
    return false;
  }

  /** 增量 delta 分发：非空 delta 入账 + 回调；终态后迟到丢弃（不变量 2）。
   *  kind 区分两通道（F2）：reasoning_delta 只走 thinking 回调（不入 deltas 账本
   *  ——deltas 是 response 兜底聚合，推理文本不是答案正文）；text_delta / kind
   *  缺席走 text 路径。
   *  返回值（[PR3]）：帧被 delta 路径消费（thinking 或 text，回调若注册则已触发）
   *  → true；无 delta / 空 delta / 终态后迟到丢弃 → false（handleSessionEvent 据
   *  此分流 onActivity——delta 帧已是宿主可见进展，不双发活性信号）。 */
  private applyStreamDelta(
    turn: ActiveTurn,
    payload: Record<string, unknown>
  ): boolean {
    if (typeof payload.delta !== "string" || payload.delta === "") return false;
    if (turn.settled) {
      logger.warn(
        `终态后迟到的 delta 丢弃（会话 ${
          turn.sessionId
        }，不变量 2：resolve 后不再发事件）: ${payload.delta.slice(
          0,
          DELTA_LOG_CHARS
        )}`
      );
      return false;
    }
    if (payload.kind === "reasoning_delta") {
      turn.callbacks.onThinkingDelta?.(payload.delta);
      return true;
    }
    turn.deltas.push(payload.delta);
    turn.callbacks.onTextDelta?.(payload.delta);
    return true;
  }

  private handleTelemetry(params: unknown): void {
    if (!isRecord(params)) return;
    if (params.kind === "turn.terminal") {
      this.applyTerminalTelemetry(params);
      return;
    }
    if (params.kind === "stream.chunk") {
      this.applyStreamChunkTelemetry(params);
    }
  }

  /** turn.terminal 遥测的吸收（含已落定 turn 的只记录路径，见 D5①）。 */
  private applyTerminalTelemetry(params: Record<string, unknown>): void {
    // 终态权威（A.2 ⑤）：status success/error 均算终态（旧实证：不归类挂到超时）。
    // 归因放宽（P0-1 S5）：已落定 turn（final-frame 宽松终态先到）仍归因，
    // 权威 status 只记录不改写落定结果（D5①——假成功的识破依据）。
    const turn = this.lookupTurnForTerminal(extractPushSessionId(params));
    if (turn === undefined) return;
    const status =
      typeof params.status === "string" ? params.status : "unknown";
    turn.lastTerminalStatus = status;
    this.recordTerminalError(turn, params);
    if (turn.settled) {
      this.logLateTerminal(turn, status);
      return;
    }
    turn.settle({ status, source: "turn.terminal" });
  }

  /**
   * 已落定 turn 的迟到权威终态分级日志（P-Z2 后续：常态迟到降噪）。真机实证该
   * 形态的唯一可达路径是 success 终态常态迟到（final-frame 先落定 + 权威
   * turn.terminal 迟到）——即每个成功任务必经；原无条件 warn 经 SDK cli-entry
   * 的 stderr 兜底 → runtime [rpc:stderr] 全量 console.error 链路，每个成功任务
   * 产一条零异常区分度的 ERROR 级日志。按权威 status 分级（落定语义不动——
   * lastTerminalStatus/lastTerminalError 的入账在上游无条件路径完成）：
   *   - "success"：常态迟到，零日志；
   *   - "interrupted"：用户中断形态，debug（stderr 兜底对 debug no-op——对齐
   *     SDK logger CONSOLE_SINK 语义，host/log 反向请求侧仍可观测）；
   *   - 失败类（isFailedTerminalStatus，与引擎失败分流同口径）与 unknown/未识别
   *     status：保守 warn（原样 status 已写入文案）——假成功识破的防御面，理论
   *     不可达但保留，宁可误报不静默。
   */
  private logLateTerminal(turn: ActiveTurn, status: string): void {
    if (status === "success") return;
    const message = `权威终态晚于落定结果到达（会话 ${
      turn.sessionId
    }，已落定 source=${
      turn.terminal?.source
    }）：turn.terminal status="${status}" 仅记录不改写（P0-1 D5①）`;
    if (isFailedTerminalStatus(status)) {
      logger.warn(message);
      return;
    }
    if (status === "interrupted") {
      logger.debug(message);
      return;
    }
    logger.warn(message);
  }

  /** terminal 帧专属错误信息入账（⛔P-Z2 实证：真实 failed 终态的 errorCode/errorMessage
   *  只在 terminal 帧携带，read/delta 拿不到——先到/迟到都记录，消费层合成失败
   *  文案时优先采信）。二者均缺失时不挂 lastTerminalError 字段。 */
  private recordTerminalError(
    turn: ActiveTurn,
    params: Record<string, unknown>
  ): void {
    const errorCode =
      typeof params.errorCode === "string" ? params.errorCode : undefined;
    const errorMessage =
      typeof params.errorMessage === "string" ? params.errorMessage : undefined;
    if (errorCode === undefined && errorMessage === undefined) return;
    turn.lastTerminalError = {
      ...(errorCode !== undefined ? { code: errorCode } : {}),
      ...(errorMessage !== undefined ? { message: errorMessage } : {}),
    };
  }

  /** stream.chunk 遥测的吸收（无文本遥测 + 文本字段漂移兜底）。 */
  private applyStreamChunkTelemetry(params: Record<string, unknown>): void {
    // A.2 ④：stream.chunk 无文本（chunkLength 遥测）。A.5 未确认项：是否偶发
    // 携带文本字段——保留旧实现的形态漂移兜底：带文本则当 delta 收（不变量 1）
    const turn = this.lookupTurn(extractPushSessionId(params));
    if (turn === undefined || turn.settled) return;
    // 遥测到达即刷新 idle 主判定（P0-1 D1：telemetry 事件同算进展）
    this.refreshIdle(turn);
    for (const key of ["chunk", "text", "content"] as const) {
      const v = params[key];
      if (typeof v === "string" && v !== "") {
        turn.deltas.push(v);
        turn.callbacks.onTextDelta?.(v);
        return;
      }
    }
  }

  /** 终态后 read（A.2 ⑥）。失败/超时不抛——降级链由 runTurn 收口（read 只兜底不致命）。
   *  连接已死时跳过（与 closeSession 同判——对死连接发请求会凭空重建进程）。 */
  private async readBestEffort(sessionId: string): Promise<unknown> {
    if (!this.conn.alive) return undefined;
    try {
      return await this.conn.request(
        "session/read",
        { sessionId },
        {
          timeoutMs: ZCODE_APPSERVER_TURN_READ_TIMEOUT_MS,
        }
      );
    } catch (err) {
      logger.warn(
        `session/read 兜底失败（会话 ${sessionId}，降级收尾帧/delta 聚合）: ${errMessage(
          err
        )}`
      );
      return undefined;
    }
  }
}
