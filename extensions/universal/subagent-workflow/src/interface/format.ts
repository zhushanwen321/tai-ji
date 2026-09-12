// src/interface/format.ts
//
// 纯格式化函数.零 Pi 依赖、零 runtime 依赖,可单测.
//
// 分隔符语义体系(tui-format.md §1,impeccable 审查裁定):
//   `·` 同级并列字段/thinking 图标;`()` 元数据分组;`›` 工具;`>` 输出;`·` thinking.
//   禁用 `│` 做 stats 分隔、`├─`/`└─` 做 eventLog 前缀.
//
// 截断/填充/换行（truncLine / padToVisible / segFillColored / wrapText）已迁
// ./tui-kit.ts（post-convergence C4 零依赖叶），本文件 re-export 维持既有导入面.

import os from "node:os";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, DisplayItem, ExecutionStatus } from "@zhushanwen/subagent-core";
import { DEFAULT_AGENT_NAME } from "@zhushanwen/subagent-core";
import type {
  DoneReason,
  ExecutionTraceNode,
  RunStatus,
  ToolCallEntry,
} from "@zhushanwen/subagent-core";
import { displayAgentName } from "@zhushanwen/subagent-core";

import { padToVisible, segFillColored, truncLine, wrapText } from "./tui-kit.ts";

// ANSI 可见宽度布局家族单定义在 ./tui-kit.ts（零依赖叶）；此处 re-export 保持
// 既有消费方（tool-render / bg-notify-render / 测试等）导入面零改动。
export { padToVisible, segFillColored, truncLine, wrapText };

/**
 * ThemeLike:TUI 语义 token 着色接口(duck-typed,兼容 Pi Theme).
 *
 * 注意:Pi Theme **没有 `dim` 方法**——"dim" 是颜色 token,走 `fg("dim", text)`.
 * 故本接口只声明 fg/bg/bold/underline,dim 文本一律 `fg("dim", ...)`.
 */
export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
  underline(text: string): string;
}

// ============================================================
// 模块级常量(复用,勿在热路径 new)
// ============================================================

/** spinner 帧序列(Braille),seed-frame 驱动,不用 setInterval. */
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// formatTokens 阈值(三段式,与 demo 一致)
/** < 此值显示原值. */
const TOKEN_PLAIN_MAX = 1000;
/** < 此值显示 "N.Nk";≥ 此值显示 "Nk"(四舍五入). */
const TOKEN_DECIMAL_K_MAX = 10000;

// formatElapsedSeconds 阈值
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;

// ============================================================
// Token / 时长格式化
// ============================================================

/**
 * 格式化 token 数(三段式,与 demo 一致).
 *
 *   < 1000  → 原值("820")
 *   < 10000 → "N.Nk"(8200 → "8.2k")
 *   ≥ 10000 → "Nk" 四舍五入(23000 → "23k")
 */
export function formatTokens(n: number): string {
  if (n < TOKEN_PLAIN_MAX) return String(n);
  if (n < TOKEN_DECIMAL_K_MAX) return `${(n / TOKEN_PLAIN_MAX).toFixed(1)}k`;
  return `${Math.round(n / TOKEN_PLAIN_MAX)}k`;
}

/**
 * 格式化整数秒时长(对话流 block + list overlay 共用).
 * 数据源 details.elapsedSeconds 已是 Math.floor 过的整数秒.
 *
 *   < 60   → "Xs"(12 → "12s")
 *   < 3600 → "Xm Ys"(72 → "1m12s")
 *   ≥ 3600 → "Xh Ym"
 */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < SECS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECS_PER_HOUR) {
    const m = Math.floor(seconds / SECS_PER_MINUTE);
    const s = seconds % SECS_PER_MINUTE;
    return `${m}m${s}s`;
  }
  const h = Math.floor(seconds / SECS_PER_HOUR);
  const m = Math.floor((seconds % SECS_PER_HOUR) / SECS_PER_MINUTE);
  return `${h}h${m}m`;
}

/** sync id 的段数（run-${seq}）。≤ 此值原样返回。 */
const SHORT_ID_SYNC_SEGMENTS = 2;
/** background id 取前 N 段（bg/${tag}/${seq}）。 */
const SHORT_ID_BG_SEGMENTS = 3;
/** subagent record id 的 `sa-` 前缀（前缀后接 UUID）。 */
const SA_ID_PREFIX = "sa-";
/** formatToolCall bash 分支 command 预览截断长度（字符）。 */
const BASH_PREVIEW_MAX_CHARS = 60;
/** formatToolCall default 分支 args JSON 预览截断长度（字符）。 */
const ARGS_PREVIEW_MAX_CHARS = 50;

/**
 * 从完整 record id 提取短编号用于列表展示.
 *
 * id 格式:
 *   - subagent:   `sa-<uuid>`                   (如 sa-550e8400-e29b-41d4-a716-446655440000)
 *                 → sa- 前缀 + UUID 前 3 段（sa-550e8400-e29b-41d4）
 *   - workflow:   `wf-<ts>-<rand>`               (如 wf-1719500000000-a1b2c3，3 段)
 *                 → 3 段 ≤ 2 不成立，取前 3 段 = 原样
 *   - sync:       `run-${seq}`                   (如 run-1，2 段) → 原样返回
 *   - 旧纯 UUID:  `<uuid>`                       (5 段) → 取前 3 段（向后兼容）
 */
export function shortId(id: string): string {
  // sa- 前缀的 subagent ID：保留前缀 + UUID 前 3 段（与纯 UUID 的 3 段信息量等价）
  if (id.startsWith(SA_ID_PREFIX)) {
    return SA_ID_PREFIX + id.slice(SA_ID_PREFIX.length).split("-").slice(0, SHORT_ID_BG_SEGMENTS).join("-");
  }
  const segments = id.split("-");
  if (segments.length <= SHORT_ID_SYNC_SEGMENTS) return id;
  return segments.slice(0, SHORT_ID_BG_SEGMENTS).join("-");
}

// ============================================================
// 状态图标
// ============================================================

/**
 * status → 图标 + 颜色 token.
 *
 *   running → { icon: undefined, color: "accent" }
 *     icon 留空是因为 running 的 spinner 需 seed 驱动,
 *     调用方用 detailsSeed(details) 算 seed 后调 spinnerGlyph(seed).
 *   done      → { "✓", "success" }
 *   failed    → { "✗", "error" }
 *   cancelled → { "■", "muted" }
 */
export function statusGlyph(status: ExecutionStatus): { icon: string | undefined; color: string } {
  switch (status) {
    case "running":
      return { icon: undefined, color: "accent" };
    case "closed":
      // v4 B-1: closed 统一终态（含 cancelled）。默认 ✓ success 色。
      return { icon: "✓", color: "success" };
  }
}

/**
 * 生成 spinner 字形(seed 驱动,非定时器).
 *
 * 每次 onUpdate(真实事件)→ seed 单调增长 → 换帧;
 * 静默期 seed 不变 → 冻结 → 换取滚动体验(修复 viewport 锚定 bug).
 */
export function spinnerGlyph(seed: number): string {
  // 防御:seed 可能是 NaN(details 字段缺失时),回退首帧
  if (!Number.isFinite(seed)) return RUNNING_FRAMES[0]!;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

// ============================================================
// eventLog 单行格式化
// ============================================================

/**
 * 压平 label 到单行(防 LLM 输出的 \r\n/\t 把单行展开成多行,破坏布局).
 * 两层防御之一(另一层在 tool-render 的 buildRenderLines).
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

// ============================================================
// 共享文本/参数提取 helper(tool-render / list-view / bg-notify-render / subagent-tool 复用)
// ============================================================

/**
 * 取文本首个非空行(多行压成首行).
 *
 * 仅做"取首行"——不 sanitize.需要压平残余 \r/\t 的调用方用 firstLineSanitized
 * (下方);list-component 直接消费本函数(标题/错误行由外层 truncLine 再压平).
 *
 *   firstLine("a\nb\nc") → "a"
 *   firstLine("\n\nb") → "b"
 *   firstLine("") → ""
 */
export function firstLine(text?: string): string {
  if (!text) return "";
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/**
 * firstLine + sanitize 组合:取首个非空行后压平残余 \r/\t.
 *
 * tool-render(content 错误回显)与 bg-notify-render(结果/错误正文)共用,
 * 取代两侧各自维护的 wrapper.tool-render 旧版走 sanitizeLabel(\t→两空格)、
 * bg-notify-render 旧版压 \r\t 为单空格——差异无测试钉住,统一取
 * sanitizeLabel 口径(与 eventLog 行处理一致).
 */
export function firstLineSanitized(text?: string): string {
  return sanitizeLabel(firstLine(text));
}

/**
 * 从 renderCall/execute 的 unknown args 安全提取 agent 名.
 * 类型守卫窄化(替代 `as { agent?: string }` 全可选断言).
 * 无 agent 字段或非空字符串时兜底 DEFAULT_AGENT_NAME(与 service 层 resolveIdentity 一致,
 * 保证 block 标题显示的名与实际加载的 agent.md 相符).
 */
export function extractAgentName(args: unknown): string {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const v = (args as { agent: unknown }).agent;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return DEFAULT_AGENT_NAME;
}

/**
 * 格式化单条 eventLog 条目(带类型图标 + 着色,不含 `⎿` 前缀——前缀由调用方加).
 *
 * 标签语义(tui-conversation.md §7):
 *   tool:    tool_start/tool_end(尾部追加 ✓/✗)
 *   ── turn ──  turn_end(仅 expanded)
 *   error:   tool label + ✗
 *
 * text_output / thinking 类型已移除——完整内容收口在 record.turns[]，
 * eventLog 只承载离散语义事件。实时 text/thinking 进度由 currentActivity 行展示。
 *
 * 预处理统一用 sanitizeLabel(换行→空格、tab→2空格).
 * 不做预截断——宽度截断全部交给外层调用点的 `truncLine(formatEventLine(...), width)`.
 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  const label = sanitizeLabel(entry.label);

  switch (entry.type) {
    case "tool_start":
      return `tool: ${label}`;

    case "tool_end": {
      const mark = entry.status === "failed"
        ? ` ${theme.fg("error", "✗")}`
        : ` ${theme.fg("success", "✓")}`;
      return `tool: ${label}${mark}`;
    }

    case "turn_end": {
      // label = turn.text 摘要（getEventLog 派生，TURN_SUMMARY_MAX=80），无 text 时为 "turn"。
      // 若丢弃 label 只显 "── turn ──"，流式 text 在 turn 结束后完全消失（currentActivity
      // 随 turn 闭合转为 undefined），用户无法回顾 subagent 说了什么。这里显示摘要保留可见性。
      const summary = sanitizeLabel(entry.label);
      if (!summary || summary === "turn") {
        return theme.fg("dim", "── turn ──");
      }
      return theme.fg("toolOutput", summary);
    }

    case "error":
      // 错误条目:标签 + label + ✗
      return `tool: ${label} ${theme.fg("error", "✗")}`;

    default:
      return label;
  }
}

// ── formatToolCall 表驱动分发（形态 2）────────────────────────
// 每个 toolName 的 case 体提为独立格式化函数，主函数留查表 + 落空语义
// （落空 = 原 default 分支逐字节一致；查表用 Map 避免原型链键误命中，
// 如 toolName === "constructor" 时普通对象下标会取到 Object.prototype）。

/** formatToolCall 单工具格式化器签名（同步——保持原 switch case 同步语义）。 */
type ToolCallFormatter = (args: Record<string, unknown>, theme: ThemeLike) => string;

/** 显示层路径缩写：~ 替换 home 前缀（仅显示层，不读取 pi 目录，TC9 合法命中）。 */
function shortenHomePath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** read/write/edit 共用的路径参数解析（file_path 优先，path 兜底，最终 "..." 兜底）。 */
function toolPathArg(args: Record<string, unknown>): string {
  return (args.file_path || args.path || "...") as string;
}

/** bash → `$ <command 预览>`。 */
function formatBashToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  const command = (args.command as string) || "...";
  const preview = command.length > BASH_PREVIEW_MAX_CHARS ? `${command.slice(0, BASH_PREVIEW_MAX_CHARS)}...` : command;
  return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
}

/** read 的 `:start-end` 行号后缀文本（offset/limit 均缺省时返回空串——外层据此跳过着色）。 */
function readLineRangeText(args: Record<string, unknown>): string {
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;
  if (offset === undefined && limit === undefined) return "";
  const startLine = offset ?? 1;
  const endLine = limit !== undefined ? startLine + limit - 1 : "";
  return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}

/** read → `read <~路径:offset-limit>`。 */
function formatReadToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  let text = theme.fg("accent", shortenHomePath(toolPathArg(args)));
  const range = readLineRangeText(args);
  if (range) text += theme.fg("warning", range);
  return theme.fg("muted", "read ") + text;
}

/** write → `write <~路径> (N lines)`。 */
function formatWriteToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  const content = (args.content || "") as string;
  const lines = content.split("\n").length;
  let text = theme.fg("muted", "write ") + theme.fg("accent", shortenHomePath(toolPathArg(args)));
  if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
  return text;
}

/** edit → `edit <~路径>`。 */
function formatEditToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  return theme.fg("muted", "edit ") + theme.fg("accent", shortenHomePath(toolPathArg(args)));
}

/** ls → `ls <~路径>`。 */
function formatLsToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  const rawPath = (args.path || ".") as string;
  return theme.fg("muted", "ls ") + theme.fg("accent", shortenHomePath(rawPath));
}

/** find → `find <pattern> in <~路径>`。 */
function formatFindToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  const pattern = (args.pattern || "*") as string;
  const rawPath = (args.path || ".") as string;
  return theme.fg("muted", "find ") + theme.fg("accent", pattern) + theme.fg("dim", ` in ${shortenHomePath(rawPath)}`);
}

/** grep → `grep /<pattern>/ in <~路径>`。 */
function formatGrepToolCall(args: Record<string, unknown>, theme: ThemeLike): string {
  const pattern = (args.pattern || "") as string;
  const rawPath = (args.path || ".") as string;
  return theme.fg("muted", "grep ") + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${shortenHomePath(rawPath)}`);
}

/** default 落空语义：`<toolName> <argsJSON 预览>`（与原 switch default 逐字节一致）。 */
function formatUnknownToolCall(toolName: string, args: Record<string, unknown>, theme: ThemeLike): string {
  const argsStr = JSON.stringify(args);
  const preview = argsStr.length > ARGS_PREVIEW_MAX_CHARS ? `${argsStr.slice(0, ARGS_PREVIEW_MAX_CHARS)}...` : argsStr;
  return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
}

/** toolName → 格式化函数查找表（Map：杜绝 Object 原型链键误命中）。 */
const TOOL_CALL_FORMATTERS: ReadonlyMap<string, ToolCallFormatter> = new Map([
  ["bash", formatBashToolCall],
  ["read", formatReadToolCall],
  ["write", formatWriteToolCall],
  ["edit", formatEditToolCall],
  ["ls", formatLsToolCall],
  ["find", formatFindToolCall],
  ["grep", formatGrepToolCall],
]);

/**
 * [STEP3] 格式化单个 toolCall 为展示行（对齐 nicobailon formatToolCall）。
 *
 * 返回不含前缀（`→ ` 由调用方加）。根据 toolName 查表提取关键参数格式化：
 *   bash → `$ <command 预览>`
 *   read → `read <~路径:offset-limit>`
 *   edit/write → `<op> <~路径>`
 *   grep/find/ls → 对应格式
 *   未命中（含 default）→ `<toolName> <argsJSON 预览>`
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ThemeLike,
): string {
  const formatter = TOOL_CALL_FORMATTERS.get(toolName);
  if (formatter) return formatter(args, theme);
  return formatUnknownToolCall(toolName, args, theme);
}

/**
 * [STEP3] 格式化单个 displayItem 为展示行（含 `→ ` 前缀）。
 *
 * toolCall：`→ <formatToolCall>` + 尾部 ✓/✗（done/failed 才加）。
 * text：assistant 正文（compact 时调用方自行截断，这里返回原文）。
 */
export function formatDisplayItem(item: DisplayItem, theme: ThemeLike): string {
  if (item.type === "text") {
    return theme.fg("toolOutput", item.text ?? "");
  }
  const name = item.name ?? "unknown";
  const args = item.args ?? {};
  const base = `${theme.fg("muted", "→ ")}${formatToolCall(name, args, theme)}`;
  if (item.status === "done") return `${base} ${theme.fg("success", "✓")}`;
  if (item.status === "failed") return `${base} ${theme.fg("error", "✗")}`;
  return base;
}

// ============================================================
// Workflow view 格式化（WorkflowsView / detail-content 专用差异段）
//
// 自 views/format.ts 并入（D7-① 双轨合并）：workflow 视图特有的 badge/phase/
// trace 行格式化在此作差异段保留。并入时收敛的同构构件——ThemeLike、
// formatElapsedSeconds（本文件版含小时分支，>1h 显示 "1h15m" 而非 "75m30s"）、
// segFillColored、padToVisible（后者已随 C4 迁 ./tui-kit.ts，经 re-export 复用）。
// ============================================================

// ── Workflow view 布局常量 ────────────────────────────────────

// views 专属布局常量（SIDEBAR_WIDTH / PROMPT_FOLD_LINES / OUTPUT_TRUNCATE_BYTES /
// BOX_BORDER_CHARS / BUDGET_TOKENS_DIVISOR / MAX_TOOL_CALLS_DISPLAY）已沉回
// ./views/view-constants.ts（就近消费方，post-convergence C4）；
// 终端兜底零件（终端行数兜底、翻页兜底步长）单定义在 ./tui-kit.ts。
// ELLIPSIS 留此：formatActivityLine / formatPhaseLine（本文件）亦消费，非 views 专属。
export const ELLIPSIS = "\u2026"; // U+2026

/** formatElapsed 的毫秒→秒换算。 */
const MS_PER_SEC = 1000;

/**
 * 可显示的状态文本集合。
 *
 * 包含 RunStatus（"running"|"done" 不直接显示，转 reason）+ DoneReason
 * （completed/failed/aborted/budget_limited/time_limited）+ ExecutionTraceNode.status
 * （含 "pending"——trace 节点的初始态）。
 *
 * 收窄自 string → 显式联合，编译器会在新增 status 时强制 switch 补齐分支。
 */
export type StatusText =
  | RunStatus
  | DoneReason
  | "pending";

// ── Workflow status helpers ──────────────────────────────────

/** status → 语义颜色 token（用于给任意文本染色，不含符号）。 */
function statusColorToken(
  status: StatusText,
): "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "completed": return "success";
    case "running": return "warning";
    case "failed": case "aborted": return "error";
    default: return "muted";
  }
}

export function statusDotStr(
  status: StatusText,
  theme: ThemeLike,
): string {
  return theme.fg(statusColorToken(status), "●");
}

/** Format a status badge with color for the header area. */
export function formatStatusBadge(
  status: StatusText,
  theme: ThemeLike,
): string {
  switch (status) {
    case "running": return theme.fg("warning", "\u25CF running");
    case "completed": return theme.fg("success", "\u2713 completed");
    case "failed": return theme.fg("error", "\u2717 failed");
    case "aborted": return theme.fg("error", "\u2717 aborted");
    case "budget_limited": return theme.fg("error", "\u26A0 budget");
    case "time_limited": return theme.fg("error", "\u26A0 timeout");
    default: return theme.fg("muted", status);
  }
}

// ── Workflow 时间 / 统计格式化 ────────────────────────────────

/**
 * Format elapsed time string from startedAt（workflow trace 风格：now 显式参数化，
 * 缺 startedAt 时 "-" 前缀兜底）。秒→字符串形态**单实现**收敛到 formatElapsedSeconds，
 * 经委托构造保证同输入同输出——不再靠注释对齐两份小时分支（post-convergence C4）。
 *
 *   < 1s    → "0s"
 *   < 60s   → "Xs"
 *   < 3600s → "XmYs" ("45m30s")
 *   ≥ 3600s → "XhYm" ("1h15m")
 */
export function formatElapsed(startedAt?: string, now: number = Date.now()): string {
  if (!startedAt) return "-";
  const secs = Math.floor((now - new Date(startedAt).getTime()) / MS_PER_SEC);
  // 钳 0：亚秒（floor=0）与时钟回拨（负值）同走 "0s"（原 `ms < MS_PER_SEC` 分支语义）
  return formatElapsedSeconds(Math.max(0, secs));
}

/**
 * Run status 行的 elapsed（[H2 A2] done 后冻结）。
 *
 * 与 formatElapsed 的差异仅在 now 基准：completedAt 有值（run 已终态）时以
 * completedAt 为基准 → elapsed 恒等于 completedAt - startedAt，不再随墙钟增长；
 * running（completedAt 缺省）沿用 Date.now() 缺省实时跳动。时钟异常
 * （completedAt < startedAt）由 formatElapsed 钳 0 兜底（"0s"）。
 */
export function formatRunStatusElapsed(
  startedAt?: string,
  completedAt?: string,
  now: number = Date.now(),
): string {
  return formatElapsed(startedAt, completedAt ? new Date(completedAt).getTime() : now);
}

/**
 * Format a live eventLog entry（live 路径 Activity 区用）。
 *
 *   tool_start → "→ {label}"
 *   tool_end   → "← {label}"（done）/ "✗ {label}"（failed）
 *   turn_end   → "∘ {label}"（turn 摘要）
 *   error      → "✗ {label}"
 *
 * 对齐上方 subagents formatEventLine 的视觉风格，但语义域是 workflow trace
 * （前缀符号不同、label 不 sanitize）——与 formatEventLine 是两个概念域的实现，
 * 同文件共存故以 Trace 前缀区分命名。
 */
export function formatTraceEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  switch (entry.type) {
    case "tool_start":
      return `→ ${entry.label}`;
    case "tool_end":
      return entry.status === "failed"
        ? theme.fg("error", `✗ ${entry.label}`)
        : `✓ ${entry.label}`;
    case "turn_end":
      return theme.fg("dim", `∘ ${entry.label}`);
    case "error":
      return theme.fg("error", `✗ ${entry.label}`);
    default:
      return entry.label;
  }
}

/** Format token + tool call statistics. */
export function formatTokenStat(
  usage?: { input: number; output: number },
  toolCalls?: ToolCallEntry[],
  elapsed?: string,
): string {
  const tokens = usage ? usage.input + usage.output : 0;
  const tools = toolCalls?.length ?? 0;
  const base = `${tokens} tok · ${tools} tool calls`;
  return elapsed ? `${base} · ${elapsed}` : base;
}

/**
 * renderResult 的文本兜底：从 result.content[0] 提取纯文本。
 * 多处 tool 的 renderResult 曾各自内联此逻辑，提取后统一调用。
 */
export function renderTextFallback(
  result: { content?: Array<{ type: string; text?: string }> },
): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** Format a single activity line: ToolName(argsPreview). */
export function formatActivityLine(entry: ToolCallEntry, maxWidth: number): string {
  // 语义阈值与开销：低于此宽度只显名称；括号占 2 字符 (name)。
  const MIN_ACTIVITY_WIDTH = 10;
  const PARENS_OVERHEAD = 2;
  if (maxWidth < MIN_ACTIVITY_WIDTH) return entry.name;
  const argsBudget = maxWidth - entry.name.length - PARENS_OVERHEAD;
  if (argsBudget <= 0) return truncateToWidth(entry.name, maxWidth);
  const truncated = entry.input.length > argsBudget
    ? entry.input.slice(0, argsBudget - 1) + ELLIPSIS
    : entry.input;
  return `${entry.name}(${truncated})`;
}

// ── Workflow phase group（filters empty phases）──────────────

export interface PhaseGroup {
  name: string;
  nodes: ExecutionTraceNode[];
  doneCount: number;
}

/** Group trace nodes by phase. Nodes without phase go to "(no phase)". */
function groupByPhase(nodes: ExecutionTraceNode[]): Map<string, ExecutionTraceNode[]> {
  const map = new Map<string, ExecutionTraceNode[]>();
  for (const node of nodes) {
    const phase = node.phase || "(default)";
    let arr = map.get(phase);
    if (!arr) {
      arr = [];
      map.set(phase, arr);
    }
    arr.push(node);
  }
  // Sort within each phase by stepIndex ascending (FR-3.2)
  for (const arr of map.values()) {
    arr.sort((a, b) => a.stepIndex - b.stepIndex);
  }
  return map;
}

/** The fallback phase name when node has no explicit phase. */
const NO_PHASE = "(default)";

/** Build phase groups. Nodes without a phase are placed in an unnamed group. */
export function buildPhaseGroups(nodes: ExecutionTraceNode[]): PhaseGroup[] {
  const map = groupByPhase(nodes);
  const result: PhaseGroup[] = [];
  for (const [name, phaseNodes] of map) {
    if (phaseNodes.length > 0) {
      result.push({
        name: name === NO_PHASE ? "" : name,
        nodes: phaseNodes,
        doneCount: phaseNodes.filter((n) => n.status === "completed").length,
      });
    }
  }
  return result;
}

// ── Workflow sidebar phase line formatter ────────────────────

export function formatPhaseLine(
  pg: PhaseGroup,
  idx: number,
  isSelected: boolean,
  theme: ThemeLike,
  maxWidth: number,
): string {
  const pointer = isSelected ? "❯ " : "  ";
  const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
  const name = pg.name || "(unnamed)";
  const label = `${idx + 1} ${name} ${pg.doneCount}/${pg.nodes.length}`;
  // pointer(2) + dot(1) + space(1)
  const PHASE_PREFIX_WIDTH = 4;
  const budget = maxWidth - PHASE_PREFIX_WIDTH;
  const truncated = visibleWidth(label) > budget
    ? truncateToWidth(label, budget - 1) + ELLIPSIS
    : label;
  return `${pointer}${dot} ${truncated}`;
}

// ── Workflow agent one-liner for overview right panel ────────

const TOKEN_K = 1000;

export function formatAgentOneLiner(node: ExecutionTraceNode, theme: ThemeLike): string {
  const dot = statusDotStr(node.status, theme);
  const elapsed = formatElapsed(
    node.startedAt,
    node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
  );
  const tok = node.result?.usage;
  const tokStr = tok
    ? `${Math.round((tok.input + tok.output) / TOKEN_K)}k tok`
    : "";
  const tcCount = node.result?.toolCalls?.length ?? 0;
  const parts = [dot, displayAgentName(node.agent), node.model];
  if (tokStr) parts.push(`${tokStr} · ${tcCount} tools`);
  parts.push(elapsed);
  return parts.join("    ");
}
