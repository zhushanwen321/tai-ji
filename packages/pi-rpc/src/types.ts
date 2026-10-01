// src/types.ts
//
// pi RPC 协议的共享类型面（@zhushanwen/pi-rpc）。
//
// 本包是主 agent（runtime rpc-client）与 subagent（pi-subagent-cli）两套 pi 进程
// RPC 客户端的公共协议层（设计 docs/architecture/subagent-permanent-session-model.md
// §3.3.2）。类型自包含（零运行时依赖）。
//
// thinking 档位在本层是**宿主入口层已校验的字符串透传**：合法性由上游入口层
// （runtime launch-params resolveEffectiveThinking，词表 = shared PI_THINKING_LEVELS）
// 校验保证，本层不做白名单收窄。不可把「pi 会拒绝非法档位」当兜底依赖——pi 实装
// （0.84.4）对非法 --thinking 不报错：仅 push type:"warning" diagnostic 且不设置档位、
// 进程照常以缺省档启动（node_modules/@earendil-works/pi-coding-agent
// dist/cli/args.js:112-121；diagnostics 处理仅 type==="error" 才 exit(1)：
// dist/main.js:476-478）。

/**
 * Generic shape of a message received from pi's JSONL stdout.
 * Broader than pi's RpcResponse union — covers both RPC responses
 * (with success/error/data) and unsolicited events (with various payloads).
 */
export interface PiMessage {
  id?: string
  type: string
  payload?: Record<string, unknown>
  /** pi RPC 响应的 data 字段（如 get_state 返回 sessionFile/sessionId） */
  data?: Record<string, unknown>
  success?: boolean
  error?: string
}

export type PiEventListener = (event: PiMessage) => void

/** prompt 命令的 busy 投递语义（pi 权威裁决：steer 抢占 / followUp 入队）。 */
export type StreamingBehavior = 'steer' | 'followUp'
