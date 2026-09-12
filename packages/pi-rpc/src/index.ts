// src/index.ts
//
// @zhushanwen/pi-rpc —— pi 进程 RPC 公共层 barrel。
//
// 消费者：runtime（主 agent rpc-client 薄壳）+ pi-subagent-cli（stdin-writer /
// spawn-args 归并）。zcode 不经过此层（app-server 是另一协议，仅语义层对齐）。
// 设计权威源：docs/design/subagent-permanent-session-model.md §3.3。

export type {
  PiMessage,
  PiEventListener,
  ThinkingLevel,
  StreamingBehavior,
} from './types.ts'
export { asThinkingLevel } from './types.ts'

export {
  appendSkillArgs,
  appendExtensionArgs,
  appendToolArgs,
  toolOptionConflict,
  buildPiMainAgentArgs,
  buildPiSubagentSpawnArgs,
  parseSpawnModelRef,
} from './spawn-args.ts'
export type {
  PiMainAgentSpawnOptions,
  PiSubagentSpawnParams,
  PiMirrorFlags,
  SpawnModelRef,
} from './spawn-args.ts'

export {
  attachLfOnlyLineReader,
  CMD_TIMEOUT_MS,
  FAST_TIMEOUT_MS,
  SLOW_TIMEOUT_MS,
  TIMED_OUT_ID_TTL_MS,
  createPendingRegistry,
  EARLY_FRAME_BUFFER_MAX,
  createEarlyFrameBuffer,
  tryWriteStdinLine,
  isBrokenPipeError,
} from './frame.ts'
export type {
  PendingRegistration,
  PendingRegistry,
  EarlyFrameBuffer,
  StdinWriteOutcome,
} from './frame.ts'

export {
  serializeCommandFrame,
  buildPromptParams,
  buildSteerParams,
  buildFollowUpParams,
  buildSwitchSessionParams,
  buildPromptCommandFrame,
  buildGetStateCommandFrame,
  buildUiResponseFrame,
  buildExtensionUiResponsePayload,
} from './commands.ts'
export type { PromptImageAttachment, UiResponseShape } from './commands.ts'

export { killPiProcess, DEFAULT_PI_KILL_GRACE_MS } from './kill-chain.ts'
export type { KillableChild } from './kill-chain.ts'

export { buildPiOutboundEnv } from './env.ts'
export type { BuildChildEnvFn, PiOutboundEnvOptions } from './env.ts'
