// src/relay-env.ts
//
// subagent relay 通道 env 名与协议常量 SSOT。跨进程契约单源：core（./relay-env 子入口）与 pi 引擎 CLI
// 的副本（round1-reuse R9）自本模块 re-export 收编——边界合法（引擎 CLI → SDK、
// core → SDK 均正向）。runtime 侧消费经 core 子入口间接取本单源。
//
// 为什么独立成模块：三方消费同一份常量——extension 侧（pi-invocation 激活判定 /
// buildChildEnv 归属写入）、runtime 侧（env 注入与镜像校验）、代理脚本 relay.mjs
// （零依赖脚本不能 import workspace 包，只能内嵌镜像，镜像一致性由 conformance
// relay 变体断言锁定）。禁各处手写字符串。
//
// env 语义：SOCKET/NODE/SCRIPT 三者同时非空 = relay 激活（全有或全无，无中间态）；
// SESSION_ID/RECORD_ID 是 tee 帧归属键（缺失由代理握手前自检拒绝，退出码 13）。

export const RELAY_ENV_SOCKET = "TAIJI_SUBAGENT_RELAY_SOCKET";
export const RELAY_ENV_NODE = "TAIJI_SUBAGENT_RELAY_NODE";
export const RELAY_ENV_SCRIPT = "TAIJI_SUBAGENT_RELAY_SCRIPT";
export const RELAY_ENV_SESSION_ID = "TAIJI_SUBAGENT_RELAY_SESSION_ID";
export const RELAY_ENV_RECORD_ID = "TAIJI_SUBAGENT_RELAY_RECORD_ID";

/** relay 协议版本（握手帧 v 字段；runtime 与代理同包分发，不匹配=安装损坏）。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 代理专用退出码（extension/引擎侧表现为「子进程非零退出」→ engine_run_failed 语义）。 */
export const RELAY_EXIT_CODES = {
  /** 握手被拒：协议版本不匹配（安装损坏，重装应用）。 */
  VERSION_MISMATCH: 10,
  /** relay socket 不可达（runtime 未运行或已重启）。 */
  SOCKET_UNREACHABLE: 11,
  /** socket 中途断开（runtime 崩溃等）——代理生命线断即退。 */
  SOCKET_CLOSED: 12,
  /** 归属 env（SESSION_ID/RECORD_ID）缺失——防无归属帧污染广播。 */
  MISSING_IDENTITY: 13,
} as const;

/** 激活判定：三 env 同时非空才走 relay，任一缺失回落直连 spawn 真实引擎（TUI/独立引擎零回归）。 */
export function isRelayActive(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return Boolean(env[RELAY_ENV_SOCKET] && env[RELAY_ENV_NODE] && env[RELAY_ENV_SCRIPT]);
}

/**
 * [W8 H12] 宿主 env → relay 连接三键的转发提取（原样转发语义的单一实现）。
 *
 * 三键同时非空（isRelayActive 同判）才返回——全有或全无，无中间态；身份键
 * SESSION_ID/RECORD_ID 不在本提取面（它们是父身份归属键，引擎子进程 env 由
 * SDK buildEngineChildEnv L1 deny 剥除、引擎按 run.params.ctx 重写，不靠 env 继承）。
 *
 * 消费方：D8 createZcodeEngine 薄壳（zsw 宿主链路的 relay 透传）；宿主 env 形态
 * 与 SDK EngineRelayEnv 结构等价（字段名 socket/node/script），TS 结构类型直接赋值。
 */
export function readRelayForwardEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { socket: string; node: string; script: string } | undefined {
  const socket = env[RELAY_ENV_SOCKET];
  const node = env[RELAY_ENV_NODE];
  const script = env[RELAY_ENV_SCRIPT];
  if (!isRelayActive(env)) return undefined;
  return { socket: socket as string, node: node as string, script: script as string };
}
