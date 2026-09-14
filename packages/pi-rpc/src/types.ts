// src/types.ts
//
// pi RPC 协议的共享类型面（@zhushanwen/pi-rpc）。
//
// 本包是主 agent（runtime rpc-client）与 subagent（pi-subagent-cli）两套 pi 进程
// RPC 客户端的公共协议层（设计 docs/architecture/subagent-permanent-session-model.md
// §3.3.2）。类型自包含（零运行时依赖）：ThinkingLevel 字面量联合与
// @xyz-agent/shared / subagent-engine-sdk 侧同形（TS 结构化类型下互通），避免
// 公共包背上宿主依赖（zcode 不经过此层——app-server 是另一协议）。

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

/**
 * pi CLI 认可的 thinking level 白名单（runtime shared/model-ref 与 pi-subagent-cli
 * spawn-args 两侧字面量面的单源；结构同形，两侧各自类型别名互通）。
 * 七值与 pi-ai ModelThinkingLevel 对齐（含 'xhigh'，ext-simplify-17 D5 P1-a：
 * 白名单曾缺 xhigh 致 `:xhigh` 后缀经 asThinkingLevel 静默降级 undefined）。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** prompt 命令的 busy 投递语义（pi 权威裁决：steer 抢占 / followUp 入队）。 */
export type StreamingBehavior = 'steer' | 'followUp'

const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 运行时收窄守卫：字符串 → ThinkingLevel 白名单（非法值 undefined，不 throw——
 * 协议 ctx 的 thinkingLevel 是跨进程字符串，坏值降级缺省优于崩帧）。
 */
export function asThinkingLevel(v: unknown): ThinkingLevel | undefined {
  return typeof v === 'string' && THINKING_LEVELS.includes(v) ? (v as ThinkingLevel) : undefined
}
