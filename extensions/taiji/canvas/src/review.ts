/**
 * 审查编排（设计 §3.1(2) 审查编排节 + §5 检查点 4 的落地裁决）。
 *
 * 链路：canvas_review(run) → marker review-request（事件留痕，agent actor）→
 * marker read（取画布全量）→ 派单个 reviewer subagent → 报告条目校验 → marker
 * review-append 写回 runtime。
 *
 * 派发载体（检查点 4 核实结论，2026-10-14）：
 * - subagent-workflow 壳不暴露编程式 workflow run 入口（runWorkflow 需壳内组装的
 *   LifecycleDeps，壳对外零导出）；pi SDK 无 subagent 派发 API；reviewer 若为持
 *   canvas 工具的子 pi，其 extension_ui_request 经引擎 ui-request-queue 落
 *   host/askUser 对话框（packages/pi-subagent-cli/src/spawn-runner.ts:15），
 *   到不了 runtime marker 通道。
 * - 落地形态 = 经 subagent-core 官方访问器 getSubagentService() 调
 *   SubagentService.executeAndAwait（Symbol.for 单例 service 槽，访问器解
 *   {current} 持有者——直读槽值是 D3-A4 实证的断链形态）：workflow agent() 管线
 *   同一 sync-await 派发原语。reviewer = schema 单发、零工具（比设计「工具面只激活
 *   canvas_read + review-append」白名单形态更强的构造保证：reviewer 没有任何改图
 *   通道）；画布数据由本扩展经父通道 marker read 取全量内联进 prompt；报告条目在本
 *   扩展侧校验后经 marker review-append 写回（runtime 按 U1 矩阵把 review-append
 *   映射 actor=review——工具面 review-append 写入路径的通道承载）。
 * - 无墙钟超时：executeAndAwait 不传超时（超时默认原则——任务级正常路径不设时限）。
 */
import { getSubagentService } from "@zhushanwen/subagent-core";
import {
  isCanvasReviewAppendParams,
  type CanvasState,
  type CanvasReviewAppendParams,
} from "@zhushanwen/extension-protocol";

import { buildReviewerPrompt, REVIEW_DIMENSIONS_GUIDE } from "./prompts/canvas-reviewer.js";

/** reviewer 派发端口（SubagentService 的结构最小面；避免对 core 类型的类型级耦合）。 */
export interface ReviewerDispatchPort { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  executeAndAwait(opts: {
    task: string;
    slug: string;
    schema?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ content?: string; parsedOutput?: unknown; error?: string }>;
}

/** record 收窄守卫（槽值 / LLM 产出等不信任来源的对象访问统一入口）。 */
function recordOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** service 槽结构守卫（槽缺位 / 形态漂移 → 结构化错误，不裸 cast）。 */
function isDispatchPort(v: unknown): v is ReviewerDispatchPort {
  return typeof recordOf(v)?.executeAndAwait === "function";
}

/**
 * 解析 reviewer 派发端口。经 subagent-core 官方访问器 getSubagentService() 读进程
 * 单例——service 槽值形状是 {current: SubagentService|null} 持有者（生产方
 * service-bootstrap.ts setSubagentService 只置 .current），直读槽值拿到的是持有者
 * 而非 service 本体（D3-A4 实证：旧实现直读 + 槽值形状守卫致 review_dispatch_
 * unavailable 断链，同会话 subagent_manage 经访问器正常）。session_start 前
 * （current=null）或扩展未加载 → 结构化错误。
 */
export function resolveReviewerDispatcher(): ReviewerDispatchPort {
  const service: unknown = getSubagentService();
  if (!isDispatchPort(service)) {
    throw new Error(
      "review_dispatch_unavailable: 审查编排需要 subagent-workflow 扩展（reviewer 经其 SubagentService 派发），" +
        "当前进程未发现可用的 SubagentService（session_start 前或扩展未加载）。" +
        "恢复动作：在 taiji 桌面宿主（subagent-workflow 为 mandatory 扩展）中发起会话后再使用 canvas_review；独立 pi 环境无审查编排。",
    );
  }
  return service;
}

/** reviewer 结构化输出契约（structured-output schema；字段与 review-append 契约对齐）。 */
export const REVIEWER_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      description: "Review findings; one entry per issue. Empty array when a dimension has no findings.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique entry id, scoped to the current round (e.g. rv-r2-1 in round 2). Reusing an id from a previous round is rejected." },
          dimension: {
            type: "string",
            enum: REVIEW_DIMENSIONS_GUIDE.map((d) => d.dim),
            description: "One of the six review dimensions.",
          },
          severity: { type: "string", enum: ["must-fix", "suggestion"] },
          targetId: { type: "string", description: "The canvas element id (node/edge/comment) this finding points at." },
          note: { type: "string", description: "One-paragraph finding: what is wrong, evidence from the canvas data, fix direction." },
          supportRating: {
            type: "string",
            enum: ["sufficient", "gap", "invalid"],
            description:
              "Support rating for trunk edges only: set when this entry targets a decompose/resolve edge and rates its support " +
              "(sufficient / gap / invalid). Omit for node targets and argue/rebut edges (R3: argument edges are not rated).",
          },
          supportGaps: {
            type: "array",
            items: { type: "string" },
            description: "Gap list; REQUIRED (at least one item) when supportRating='gap' — what support is missing on that edge.",
          },
        },
        required: ["id", "dimension", "severity", "targetId", "note"],
      },
    },
    summary: { type: "string", description: "One-paragraph overall verdict." },
  },
  required: ["entries"],
}

/** read 回包收窄守卫（不信任通道对端格式：marker-channel 已保证 JSON，形状在此判）。 */
export function isCanvasStateReply(v: unknown): v is CanvasState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec.canvasId === "string" &&
    typeof rec.name === "string" &&
    typeof rec.root === "object" &&
    Array.isArray(rec.nodes)
  );
}

/** 本轮审查轮次：run 链路的 read 发生在 review-request 之后，review.round 已是本轮
 * 轮次（runtime 侧一轮 = 一循环：当前轮无报告写回时再发起不推进轮次——GUI 双跳的
 * 第二跳与重发都不虚增轮次；零发现轮的写回也算完成）；从未审查（read 无 review
 * 聚合）= R1。 */
export function currentReviewRound(state: CanvasState): number {
  return state.review?.round ?? 1;
}

/** 上轮处置表渲染（R2+ prompt 的收窄输入：条目 × 处置状态）。 */
export function renderResolutionTable(state: CanvasState): string | undefined {
  const entries = state.review?.entries ?? [];
  if (entries.length === 0) return undefined;
  return entries
    .map((e) => {
      const resolution = e.resolution
        ? `${e.resolution.disposition}（by ${e.resolution.by}）：${e.resolution.note}`
        : "未处置";
      return `- [${e.id}] R${e.round} ${e.dimension}/${e.severity} → ${e.targetId}：${e.note}｜处置：${resolution}`;
    })
    .join("\n");
}

/** reviewer 产出单条 → 契约条目（借契约守卫逐条校验，非法条目丢弃并计数）。
 * round 由本侧注入（契约 CanvasReviewEntryInput 逐条带 round；reviewer schema
 * 不要求模型重复输出轮次）。 */
export function collectValidEntries(
  canvasId: string,
  round: number,
  parsed: unknown,
): { entries: CanvasReviewAppendParams["entries"]; dropped: number } {
  const raw = recordOf(parsed)?.entries;
  if (!Array.isArray(raw)) return { entries: [], dropped: 1 };
  const entries: CanvasReviewAppendParams["entries"] = [];
  let dropped = 0;
  for (const item of raw) {
    const candidate = {
      canvasId,
      round,
      entries: [typeof item === "object" && item !== null ? { ...item, round } : item],
    };
    if (isCanvasReviewAppendParams(candidate)) {
      entries.push(...candidate.entries);
    } else {
      dropped += 1;
    }
  }
  return { entries, dropped };
}

/** 组装 reviewer task（六维度模板 + 画布数据 + 轮次指令）。 */
export function buildReviewerTask(state: CanvasState, round: number, scope?: string): string {
  return buildReviewerPrompt({
    canvasName: state.name,
    round,
    scope,
    canvasStateJson: JSON.stringify(state),
    resolutionTable: round > 1 ? renderResolutionTable(state) : undefined,
  });
}

export interface ReviewRunOutcome { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 写回成功的条目数。 */
  appended: number;
  /** 校验失败被丢弃的条目数。 */
  dropped: number;
  /** 轮次。 */
  round: number;
  /** reviewer 结构化 summary（缺省由 appended/dropped 拼装）。 */
  summary: string;
}

/** 派发 reviewer 并把报告条目写回（canvas_review run 的编排主体，工具层调用）。
 * appendWriteBack 由调用方注入（marker 通道依赖 ctx，不进本纯编排单元）。 */
export async function runReviewRound(input: {
  state: CanvasState;
  scope?: string;
  signal?: AbortSignal;
  dispatch: ReviewerDispatchPort;
  appendWriteBack: (params: CanvasReviewAppendParams) => Promise<void>;
}): Promise<ReviewRunOutcome> {
  const round = currentReviewRound(input.state);
  const task = buildReviewerTask(input.state, round, input.scope);
  const result = await input.dispatch.executeAndAwait({
    task,
    slug: "canvas-review",
    schema: REVIEWER_REPORT_SCHEMA,
    signal: input.signal,
  });
  if (typeof result.error === "string") {
    throw new Error(
      `review_dispatch_failed: reviewer subagent 执行失败 — ${result.error}。` +
        "恢复动作：核对引擎可用性后重发 canvas_review(run)；已记录的 review-request 事件留痕不受影响。",
    );
  }
  const { entries, dropped } = collectValidEntries(input.state.canvasId, round, result.parsedOutput ?? result.content);
  // 零发现轮也写回（空 entries 的 review-append）：写回本身就是「本轮 run 已完成」的
  // 落盘事实（runtime 侧落 review.lastRunRound），跳过会使零发现轮永不推进轮次、
  // maxRounds 预算永不消耗（max-rounds 停回保护对该形态失灵）。
  await input.appendWriteBack({ canvasId: input.state.canvasId, round, entries });
  const parsedSummary = recordOf(result.parsedOutput)?.summary;
  const summary =
    (typeof parsedSummary === "string" ? parsedSummary : "") ||
    `reviewer 完成：写回 ${entries.length} 条报告条目（丢弃 ${dropped} 条畸形）。`;
  return { appended: entries.length, dropped, round, summary };
}
