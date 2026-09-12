// src/index.ts
//
// @zhushanwen/pi-subagent-cli 主 barrel（W7，impl-plan §2.7）。
// 协议服务器 + 引擎适配器 + 迁移的引擎侧原语（spawn 链 / stdin-writer /
// ui-request-queue 等）。不变量：本包禁止 import @zhushanwen/subagent-core
// （W9 check-engine-package-boundary 守卫目标）。

export { EngineProtocolServer, createDefaultPiEngine } from "./server.ts";
export { PiEngine, type PiEngineDeps } from "./pi-engine.ts";
export { PI_ADAPTER_VERSION, PI_ENGINE_ID, PI_POOL_KEY } from "./constants.ts";

// ── 迁移的引擎侧原语（core engines/pi 同名件的包内权威） ──
export {
  buildSpawnArgs,
  applySchemaEnvToChildEnv,
  buildEnvBlock,
  mapAssistantMessageDelta,
  parseSpawnModelRef,
  type SpawnModelRef,
  type ThinkingLevel,
} from "./spawn-args.ts";
export { getPiInvocation, type PiInvocation } from "./pi-invocation.ts";
export {
  respond,
  sendPromptCommand,
  sendGetStateCommand,
  recordEpipeFailure,
  clearEpipeFailure,
  resetAllEpipeFailures,
  EPIPE_FAILURE_THRESHOLD,
} from "./stdin-writer.ts";
export { parseChannel, type ParsedChannel } from "./ui-channels.ts";
export { createUiRequestQueue, type UiRequestQueueDeps } from "./ui-request-queue.ts";
export { parseSpawnLine, deriveSessionFilePath, findSessionFileByHeaderId } from "./spawn-event-adapter.ts";
export { mirrorMainProcessFlags, type MirrorFlags } from "./argv-mirror.ts";
export { createTurnLimiter, WRAP_UP_HINT } from "./turn-limiter.ts";
export {
  performGetStateHandshake,
  requestGetStateOnce,
  type GetStateResult,
} from "./get-state-handshake.ts";
export {
  runSpawnOnce,
  killAllActiveChildren,
  getActiveChild,
  type SpawnRunParams,
  type SpawnRunCallbacks,
  type SpawnRunResult,
} from "./spawn-runner.ts";
export {
  classifyFailureKind,
  collectOutcome,
  extractParsedOutput,
  neutralizeStalePatterns,
  describeMissingParsedOutput,
  isStaleContextErrorMsg,
  isDeterministicSchemaFailureMsg,
  STALE_CONTEXT_PATTERNS,
  DETERMINISTIC_SCHEMA_FAILURE_PREFIX,
} from "./output-collector.ts";
export { replayJournalToSessionView } from "./read-fallback.ts";
