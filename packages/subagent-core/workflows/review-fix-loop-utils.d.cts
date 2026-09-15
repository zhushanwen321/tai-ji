// review-fix-loop-utils.cjs 的消费面类型声明（test-only 类型基建：src/__tests__/
// review-fix-loop-utils.test.ts 顶层 import 本模块；tsc 纳入测试后需要声明锚点）。
// 与 .cjs 同名同目录的 .d.cts 会被 TS 自动关联（相对路径导入解析）。
// 仅声明测试消费的导出——未来消费新导出时在编译期报缺并在此补充。
// 参数对象字段全可选（cjs 侧对缺省字段有兜底/容忍 undefined 的拼接语义）。

/** fail 回调（测试侧实现为抛错终止，签名兼容 (msg: string) => void）。 */
export type FailFn = (msg: string) => void;

/** 评分条目（landScores/backfillFixRegression 的 scores 元素形态）。 */
export interface ScoreEntry {
  round?: number;
  targetKind?: string;
  targetName?: string;
  batch?: number;
  dimensions: Record<string, unknown>;
  total?: number | null;
  note?: string;
  [key: string]: unknown;
}

/** workflow 跨轮状态（applyCleanRoundBackfill 的 state 形态）。 */
export interface AgentState {
  issues: Record<string, IssueEntry>;
  knownRemaining: string[];
  scores: ScoreEntry[];
  fixResults?: unknown[];
  dormant?: Array<{ id: string; reason?: string; detail?: string; round?: number; revived?: boolean; [key: string]: unknown }>;
  idMap?: { round?: number; map?: Record<string, string> };
  [key: string]: unknown;
}

/** issue 记录（issues map 值形态，测试按用例裁剪字段）。 */
export interface IssueEntry {
  id?: string;
  issue_id?: string;
  title?: string;
  status?: string;
  severity?: string;
  description?: string;
  reason?: string;
  fixAttempts?: number;
  openStreak?: number;
  firstSeen?: number;
  history?: Array<{ round?: number; status?: string; [key: string]: unknown }>;
  deferredReason?: string;
  [key: string]: unknown;
}

export declare function parseBatches(args: Record<string, unknown>, fail: FailFn): string[][];
export declare function resolveBatchNames(
  rawBatchNames: string[] | undefined,
  batches: string[][],
  fail: FailFn,
): string[];
export declare function buildReviewInstruction(targetType: string, target: string): string;
export declare function lockReviewBase(
  targetType: string,
  target: string,
  run?: (cmd: string) => string,
): { base: string; hash: string };
export declare function buildScopedRecheckPrompt(args: {
  header?: string;
  round?: number;
  max?: number;
  roundDir?: string;
  reportFile?: string;
  modifiedFiles?: string[];
  affectedFiles?: string[];
  aggPath?: string;
  fixResult?: Record<string, unknown> | null;
  aggRound?: number;
  fixRound?: number;
  reviewPrompt?: string;
  reviewInstruction?: string;
}): string;
export declare function wrapUntrusted(content: string, tag: string): string;
export declare function buildFixPrompt(args: {
  header?: string;
  reportContent?: string;
  fixPrompt?: string;
  commitInstr?: string;
  caution?: string[];
  guidance?: Array<{ id?: string; guidance?: string; [key: string]: unknown }>;
}): string;
export declare function buildAggregatorPrompt(args: {
  header?: string;
  round?: number;
  max?: number;
  roundDir?: string;
  reviewResults?: unknown;
  prevFixResult?: unknown;
  prevTitles?: unknown;
}): string;
export declare function resolveReviewReportPath(
  parsed: { report_content?: string; report_file?: string; [key: string]: unknown },
  roundDir: string,
  reportName: string,
): { reportFile?: string; reportContent: string; [key: string]: unknown };
export declare function normalizeFixResult(raw: unknown): {
  fixed_count: number;
  fixes: Array<{ issue_id: string; description?: string; [key: string]: unknown }>;
  deferred: Array<{ issue_id: string; reason?: string; severity?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export declare function normIssueId(s: string | null | undefined): string;
export declare function findIssueKey(
  issues: Record<string, unknown> | null | undefined,
  issueId: string,
): string | undefined;
export declare function hasOpenResidue(issues: Record<string, unknown> | undefined): boolean;
export declare function normTitle(s: string | undefined): string;
export declare function matchByTitle(
  title: string,
  issues: Record<string, unknown>,
  dormant: unknown,
): { kind: string; id?: string; [key: string]: unknown };
export declare function nextFreeId(existingIds: string[]): string;
export declare function resolveIssueIdentity(
  entry: { id?: string; title?: string; [key: string]: unknown },
  ctx: { issues: Record<string, unknown>; dormant: unknown[] },
): { kind: string; id: string; [key: string]: unknown };
export declare function translateId(
  idMap: Record<string, string> | null | undefined,
  id: string,
  issues: Record<string, unknown>,
): string;
export declare function translateReconSets(
  reconSeen: Set<unknown>,
  reconEscalate: Set<unknown>,
  reconFixed: Set<unknown>,
  idMap: Record<string, string>,
  issues: Record<string, unknown>,
): { seen: Set<string>; escalate: Set<string>; fixed: Set<string> };
export declare function validateFixResult(
  result: unknown,
  mustFixIds?: string[],
  trackedIssues?: Record<string, unknown>,
  idMap?: Record<string, string>,
): Array<Record<string, unknown>>;
export declare function reconcileIssues(
  prevIssues: Record<string, unknown>,
  opts: {
    seenIds: Set<string> | string[];
    escalateIds?: Set<string> | string[];
    fixedIds?: Set<string> | string[];
    round: number;
    stuckThreshold: number;
  },
): { issues: Record<string, IssueEntry>; stuck: boolean; knownRemaining: string[]; [key: string]: unknown };
export declare function normalizeReviewResult(raw: unknown): {
  report_file?: string;
  report_content?: string;
  [key: string]: unknown;
};
export declare function checkConvergence(opts: {
  prevStreak?: number;
  newFindings?: number;
  newFindingsCritical?: number;
  convergeNewIssues?: number;
  convergeRounds?: number;
}): { converged: boolean; streak: number; [key: string]: unknown };
export declare function findNeedsRedesign(
  issues: Record<string, unknown>,
  maxFixAttempts: number,
): Array<{ issue_id: string; [key: string]: unknown }>;
export declare function parseResult(raw: unknown): Record<string, unknown>;
export declare function normalizeAggregatorResult(raw: unknown): {
  must_fix: number;
  suggestion: number;
  must_fix_ids: Array<{ id?: string; issue_id?: string; severity?: string; [key: string]: unknown }>;
  scores?: ScoreEntry[];
  [key: string]: unknown;
};
export declare function parseAggregatedMd(content: string): {
  must_fix: number;
  suggestion: number;
  [key: string]: unknown;
};
export declare function resolveRunRoot(opts: {
  runId?: string;
  cwd?: string;
  homeDir?: string;
  tmpDir?: string;
  exec?: (cmd: string) => string;
  mkdir?: (p: string) => void;
}): { root: string; slug: string; degraded: boolean; [key: string]: unknown };
export declare function computeOrigin(
  entry: { [key: string]: unknown },
  opts: { lastModifiedFiles?: string[]; fixImpactFiles?: string[] },
): { origin: string; evidence?: unknown; [key: string]: unknown };
export declare function recordDormant(
  dormant: unknown[],
  entries: unknown[],
  round: number,
  excludeIds?: unknown[] | Set<unknown>,
): Array<{ id: string; [key: string]: unknown }>;
export declare function filterActiveIds(
  entries: Array<{ id?: string; adjudication?: string; [key: string]: unknown }>,
): string[];
export declare function filterDormantFromRecon(
  reconSeen: Set<string>,
  reconEscalate: Set<string>,
  dormant: Array<{ id?: string; [key: string]: unknown }>,
): { seen: Set<string>; escalate: Set<string> };
export declare function landScores(
  existingScores?: ScoreEntry[] | null,
  rawScores?: Array<Record<string, unknown> | null> | null,
  batchIndex?: number,
): { scores: ScoreEntry[]; landed: number; malformed: number };
export declare function countMissingFields(entries: unknown[]): {
  active: number;
  missingGuidance: number;
  missingEvidence: number;
};
export declare function backfillFixRegression(opts: {
  scores?: ScoreEntry[];
  fixResult?: Record<string, unknown> | null;
  issues?: Record<string, unknown>;
  round?: number;
  batch?: number;
  cleanRound?: boolean;
  mode?: string;
}): ScoreEntry[];
export declare function applyCleanRoundBackfill(
  state: Omit<AgentState, "issues"> & { issues: Record<string, unknown> | Record<string, IssueEntry> },
  opts: {
    reconSeen: Set<string> | string[];
    reconEscalate: Set<string> | string[];
    reconFixed?: Set<string> | string[];
    round: number;
    stuckThreshold: number;
    batch?: number;
  },
): { state: AgentState; stuck: boolean; [key: string]: unknown };
export declare function resolveAggregatorModel(raw: string | undefined, fallback: string | string | undefined): string;
export declare function resolveAgentDefs(batchNames: string[]): Array<Record<string, unknown>>;
export declare function recordAgentClean(
  state: { agentStatus: Record<string, unknown>; fixCount?: number },
  agentName: string,
  batchIndex: number,
): void;
export declare function recordAgentDirty(
  state: { agentStatus: Record<string, unknown>; fixCount?: number },
  agentName: string,
  mustFix: number,
  batchIndex: number,
): void;
export declare function shouldSkipAgent(status: unknown, fixCount: number, batchIndex: number): boolean;
export declare function updateStuckState(
  prevMustFix: number,
  stuckCount: number,
  mustFix: number,
  stuckThreshold: number,
): { prevMustFix: number; stuckCount: number; [key: string]: unknown };
export declare function resolveBatchTerminated(
  batchClean: boolean,
  terminated: string | undefined,
): string | undefined;

export declare const TARGET_TYPES: string[];
export declare const VALID_ARG_KEYS: Set<string>;
export declare const ROUND_CONTEXT_MARKER: string;
export declare function buildR1ReviewPrompt(args: {
  header?: string;
  roundDir?: string;
  reportFile?: string;
  prevBatchesHint?: string;
  reviewPrompt?: string;
  reviewInstruction?: string;
}): string;
export declare function buildR2ReviewPrompt(args: {
  header?: string;
  round?: number;
  max?: number;
  roundDir?: string;
  reportFile?: string;
  aggPath?: string;
  fixResult?: Record<string, unknown> | null;
  aggRound?: number;
  fixRound?: number;
  knownRemaining?: string[];
  dormant?: unknown[];
  openIssues?: unknown[];
  reviewPrompt?: string;
  reviewInstruction?: string;
}): string;
