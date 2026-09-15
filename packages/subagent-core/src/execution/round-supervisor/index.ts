// src/execution/round-supervisor/index.ts
//
// [W4] 轮次活性监督器公共出口（SubagentService 与测试的消费面）。

export {
  classifySupervisorDomain,
  isAwakeWarrantedShape,
  type SupervisorDomain,
} from "./domain.ts";
export {
  classifyReplacement,
  type ReplacementCandidate,
  type ReplacementProbeSubject,
  type ReplacementVerdict,
} from "./notify-accounting.ts";
export {
  runReconcileSweep,
  type ReconcileSweepDeps,
  type ReconcileSweepResult,
  type SupervisedRecordState,
} from "./reconcile-sweep.ts";
export {
  ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS,
  ROUND_SUPERVISOR_WATCHDOG_ENV,
  RoundSupervisor,
  getSupervisorWatchdogMs,
  isSupervisorGiveUpDisabled,
  type GiveUpKind,
  type RoundSupervisorDeps,
  type SupervisorCandidateRecord,
  type SupervisorRecordView,
} from "./supervisor.ts";
