// src/types.ts
//
// pi RPC 协议的共享类型面（@zhushanwen/pi-rpc）。
//
// 本包是主 agent（runtime rpc-client）与 subagent（pi-subagent-cli）两套 pi 进程
// RPC 客户端的公共协议层（设计 docs/architecture/subagent-permanent-session-model.md
// §3.3.2）。类型自包含（零运行时依赖）。
//
// thinking 档位在本层是**宿主已校验的字符串透传**：合法性权威 = 宿主（入口层词表）
// 与 pi（收到非法档位即报错）。本层不做白名单收窄——历史形态把非法档位静默换成
// undefined，等于把「显式指定了档位」变成「没指定」。

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
