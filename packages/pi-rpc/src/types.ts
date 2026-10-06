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
// （1.0.0 复核）对非法 --thinking 不报错：仅 push type:"warning" diagnostic 且不设置档位、
// 进程照常以缺省档启动（node_modules/@earendil-works/pi-coding-agent
// dist/cli/args.js `--thinking` 分支 isValidThinkingLevel 未命中仅 push warning；
// diagnostics 处理仅 type==="error" 才 exit(1)：dist/main.js）。

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
  /**
   * prompt/steer/follow_up 响应的实际去向（pi 1.0.0 起 data.disposition，rpc-client
   * 出口统一解析后挂载；其余命令恒 undefined）。
   * - 'handled'：被扩展接管（斜杠命令 / input hook 返回 handled），不会产生 LLM turn；
   * - 'queued'：排队等待（steering / followUp 队列或 streaming 中的 prompt）；
   * - 'started'：已真正开始执行（会产生 LLM 流）。
   * 锚点：pi dist/core/agent-session.d.ts QueuedInputDisposition = 'handled'|'queued'、
   * PromptDisposition = QueuedInputDisposition|'started'。steer/follow_up 恒为前两值；
   * prompt 三值全可能。界面消费（等待语义修正）归 taiji 服务层设计，本包只承载解析后的值。
   */
  disposition?: PiInputDisposition
}

/**
 * pi 1.0.0 prompt/steer/follow_up 响应 data.disposition 的值域（词表 SSOT 在本包，
 * runtime pi-protocol.ts re-export）。
 */
export type PiInputDisposition = 'handled' | 'queued' | 'started'

export type PiEventListener = (event: PiMessage) => void

/** prompt 命令的 busy 投递语义（pi 权威裁决：steer 抢占 / followUp 入队）。 */
export type StreamingBehavior = 'steer' | 'followUp'
