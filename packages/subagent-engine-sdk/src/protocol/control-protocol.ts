// src/protocol/control-protocol.ts
//
// [M3] subagent control 通道协议契约单源：帧 kind 词表 + 协议版本 + engine_closed
// reason 值域（设计 relay-spawn-transport §3.3 D8/D9、§3.4.3 帧表）。与 engine-protocol.ts
// （引擎 NDJSON 协议）正交——control 协议是引擎帧的信封运输层：engine_frame.line
// 载荷是不透明字符串，本层不理解引擎协议语义。
//
// 消费方（本单元只立契约，实现在后续单元）：u-m3-control（runtime control server，
// 帧构造/解析/比较）与 u-m3-rt-transport（RuntimeControlClient/RuntimeEngineTransport，
// hello/engine_open/frame 双向）。两侧禁手写字面量，一律 import 本单源。
//
// 帧形状契约（单行 JSON，`v` = SUBAGENT_CONTROL_PROTOCOL_VERSION；字段逐 kind 见设计
// §3.4.3 帧表，payload 接口随消费单元落地——kind/version/reason 值域以本模块为单源）：
//
// | 方向 | kind             | 要点                                                     |
// |------|------------------|----------------------------------------------------------|
// | C→R  | hello            | 连接建立；只带 v/hostPid/hostKind，不带 root session      |
// | R→C  | hello_ok         | 认证成功；带 runtimePid/protocolVersion                   |
// | R→C  | hello_reject     | 连接级失败（version）；带 reason/message/recovery/supported |
// | C→R  | engine_open      | 打开引擎通道；带 launch/rootSessionId/parentRecordId?/depth? |
// | R→C  | engine_opened    | 引擎已 spawn；带 channelId/pid                            |
// | R→C  | engine_open_failed | spawn/归属失败；带 code/message/recovery（含 session/channel_limit） |
// | 双向 | engine_frame     | 引擎协议帧信封；带 channelId/line（不透明字符串载荷）      |
// | C→R  | engine_close     | 关闭通道（先发引擎 dispose 帧，再发本帧）；只影响该 channel |
// | R→C  | engine_closed    | 引擎退出/被杀；带 code/signal/reason/stderrTail?          |
// | R→C  | error            | 通道级错误（帧过大/背压溢出等）；channelId 可缺省（连接级） |

/** control 协议版本（帧 v 字段；runtime 与 extension 同包分发，未知 v → hello_reject {reason:"version"}，D9 版本矩阵）。 */
export const SUBAGENT_CONTROL_PROTOCOL_VERSION = 1;

/**
 * 帧 kind 判别值词表（10 成员）。as const 值即字面量类型——类型位置同样可用。
 * 方向语义见文件头帧表：hello/engine_open/engine_frame/engine_close 为 C→R，
 * hello_ok/hello_reject/engine_opened/engine_open_failed/engine_closed/error 为 R→C，
 * engine_frame 双向。
 */
export const SUBAGENT_CONTROL_FRAME_KINDS = {
  hello: "hello",
  helloOk: "hello_ok",
  helloReject: "hello_reject",
  engineOpen: "engine_open",
  engineOpened: "engine_opened",
  engineOpenFailed: "engine_open_failed",
  engineFrame: "engine_frame",
  engineClose: "engine_close",
  engineClosed: "engine_closed",
  error: "error",
} as const;

export type SubagentControlFrameKind =
  (typeof SUBAGENT_CONTROL_FRAME_KINDS)[keyof typeof SUBAGENT_CONTROL_FRAME_KINDS];

/** unknown → control 帧 kind 收窄（外部输入携带 kind 时的运行时 guard）。 */
export function isSubagentControlFrameKind(
  value: unknown,
): value is SubagentControlFrameKind {
  return (
    typeof value === "string" &&
    (Object.values(SUBAGENT_CONTROL_FRAME_KINDS) as string[]).includes(value)
  );
}

/**
 * engine_closed 帧 reason 值域（引擎通道终局归因，D8/D10）：
 * - engine_exit：引擎进程自行退出（code 承载退出码）；
 * - engine_signal：被信号终止（signal 承载信号名）；
 * - killed_by_control：runtime 主动杀组（engine_close 有界等待超时 / 背压溢出 /
 *   连接关闭 fan-out 等控制面裁决）；
 * - open_timeout：engine_open 超时被 runtime 中止杀组（迟到 engine_opened 丢弃）。
 * 意外退出（engine_exit/engine_signal）→ runtime 无条件 killEngineGroup（D7）；
 * runtime transport 把 reason 映射进 onExit info（stderrTail 同帧携带）。
 */
export const SUBAGENT_CONTROL_CLOSED_REASONS = {
  engineExit: "engine_exit",
  engineSignal: "engine_signal",
  killedByControl: "killed_by_control",
  openTimeout: "open_timeout",
} as const;

export type SubagentControlClosedReason =
  (typeof SUBAGENT_CONTROL_CLOSED_REASONS)[keyof typeof SUBAGENT_CONTROL_CLOSED_REASONS];

/** unknown → engine_closed reason 收窄（外部输入携带 reason 时的运行时 guard）。 */
export function isSubagentControlClosedReason(
  value: unknown,
): value is SubagentControlClosedReason {
  return (
    typeof value === "string" &&
    (Object.values(SUBAGENT_CONTROL_CLOSED_REASONS) as string[]).includes(value)
  );
}
