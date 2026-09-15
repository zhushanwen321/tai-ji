// src/interface/bg-notify-render.ts
//
// background 完成通知的对话流渲染器。
// pi.registerMessageRenderer("subagent-bg-notify", ...) 注册。
//
// notifier.ts 设 display:true + triggerTurn:true：
//   - display:true → Pi 创建 CustomMessageComponent（customMessageBg 背景色块，
//     与 tool block 的 toolSuccessBg 视觉区分），调本 renderer 渲染内容
//   - triggerTurn:true → 唤醒父 agent 下一 turn，让 LLM 看到「X 完成」
//
// 渲染内容（紧凑单行/双行，紫色背景 + 圆角边框）：
//   ╭──────────────────────────────────────────────────╮
//   │ ✓ agent · model — background subagent finished   │
//   │   {结果首行 / Error 首行}                          │
//   ╰──────────────────────────────────────────────────╯
//
// 注意：renderer 自己施加紫色背景（customMessageBg）。Pi 的
// CustomMessageComponent 对 customRenderer 返回的组件是「裸 addChild」——
// 只有 renderer 返回 undefined（走 default 渲染）时才套 customMessageBg box。
// 故返回裸 Text 会丢失紫色背景，必须显式 Box 包裹。

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { displayAgentName } from "@zhushanwen/subagent-core";
import { deriveOutcome } from "@zhushanwen/subagent-core";
import { CLOSED_REASONS } from "@zhushanwen/subagent-core";
import type { ClosedReason, ExecutionOutcome } from "@zhushanwen/subagent-core";
import {
  firstLineSanitized,
  padToVisible,
  shortId,
  statusGlyph,
  type ThemeLike,
  truncLine,
} from "./format.ts";

/** agent 名最大显示宽度。 */
const AGENT_MAX_WIDTH = 40;
/** 完成块正文最大显示宽度。 */
const BODY_MAX_WIDTH = 80;
/** model 名最大显示宽度（避免 provider/model 路径过长撑爆 head 行）。 */
const MODEL_MAX_WIDTH = 30;
/** 边框内左右 padding（│ 后、│ 前各 1 空格）。 */
const INNER_PAD = 1;
/** 边框左右 padding 总宽（两侧 INNER_PAD）。 */
const INNER_PAD_TOTAL = 2;
/** 边框左右字符占用的列数（│ 和 │ 各 1 列）。 */
const BORDER_CHARS = 2;
/** 能画出完整边框的最小宽度（│ │ 各 1 + 至少 1 内容列）。 */
const MIN_BORDER_WIDTH = BORDER_CHARS + INNER_PAD_TOTAL + 1;

/**
 * background 完成通知的 record 形态（从 message.details 提取）。
 * notifier.ts 构造，本文件防御性解析。
 */
interface BgNotifyRecord {
  id: string;
  /** v4 B-1: closed（终态，含 cancelled）或 running（对话模式轮次完成，旧 idle）。 */
  status: "running" | "closed";
  /** L2 关闭原因子枚举（内部诊断 + outcome 兑底派生输入；经 toClosedReason 防御性收窄）。 */
  closedReason?: ClosedReason;
  /** 终态三态对外语义（U3 C-outcome）。缺失（升级前旧消息重放）时按 deriveOutcome 兑底。 */
  outcome?: ExecutionOutcome;
  agent: string;
  model?: string;
  result?: string;
  error?: string;
  /** [MF#1] worktree background 完成通知携带的 patch 文件路径。 */
  patchFile?: string;
}

/**
 * 渲染 background 完成通知。
 *
 * 契约（Pi MessageRenderer，core/extensions/types.ts:1060）：
 *   (message: CustomMessage, options: { expanded }, theme: Theme) => Component | undefined
 *
 *   display:true 时 Pi 调本方法，返回 BorderedBgBox（紫色背景 + 圆角边框）。
 *   details 异常 → 返回 undefined 走 Pi 默认渲染（兜底）。
 *
 *   details 两种形态：
 *     - 单条：BgNotifyRecord（status/agent/id/result/error）
 *     - 批量：{ batch: true, items: BgNotifyRecord[] }（notifier 合并窗口内多条完成）
 */
export function renderBgNotifyMessage(
  message: { details?: unknown },
  _options: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const t = theme as ThemeLike;

  // 批量分支：多条合并，各自渲染一行
  const batch = extractBatch(message.details);
  if (batch) {
    const lines = batch.flatMap((r) => renderRecordLines(r, t));
    return new BorderedBgBox(lines, t);
  }

  // 单条分支
  const record = extractBgNotifyRecord(message.details);
  if (!record) return undefined;
  return new BorderedBgBox(renderRecordLines(record, t), t);
}

// ============================================================
// 边框 + 背景组件
// ============================================================

/**
 * 紫色背景（customMessageBg）+ 圆角边框（customMessageLabel 色）的自定义组件。
 *
 * 为何不用 Box 组件：Box 只做 padding + 背景，不画 Unicode 边框字符。
 * 本组件在 render(width) 时动态画 `╭─╮ │ ╰─╯` 边框，内部行施加紫色背景。
 *
 * ANSI 安全：内容行可能含 `\x1b[0m`（来自 truncLine 截断或 chalk），
 * 它是全局重置会清除背景色（背景框内省略号后失去背景的根因）。
 * 本组件在施加背景前，把行内全局 reset 替换为只重置前景/粗体/斜体/下划线
 * 的精确 reset（不含背景 `\x1b[49m`），确保背景不断裂。
 */
class BorderedBgBox implements Component {
  private lines: string[];
  private t: ThemeLike;
  private cache: { width: number; lines: string[] } | undefined;

  constructor(lines: string[], t: ThemeLike) {
    this.lines = lines;
    this.t = t;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines;

    const t = this.t;
    const borderColor = "customMessageLabel";

    // 窄宽度退化：放不下边框时，去掉边框只保留背景内容（不撑破对齐）
    if (width < MIN_BORDER_WIDTH) {
      const innerWidth = Math.max(1, width);
      const result: string[] = [];
      for (const line of this.lines) {
        const truncated = truncLine(line, innerWidth);
        const bgSafe = sanitizeAnsiForBg(truncated);
        const padded = padToVisible(bgSafe, innerWidth);
        result.push(t.bg("customMessageBg", padded));
      }
      this.cache = { width, lines: result };
      return result;
    }

    // 正常宽度：画完整边框
    // 边框占 BORDER_CHARS 列（左右各 1 个 │），内部 padding 各 INNER_PAD 空格
    const innerWidth = width - BORDER_CHARS - INNER_PAD_TOTAL;
    const horizLen = width - BORDER_CHARS;

    const result: string[] = [];

    // 顶边框：╭─...─╮
    result.push(
      t.fg(borderColor, "╭" + "─".repeat(horizLen) + "╮"),
    );

    // 内容行：│ {bg(内容)} │
    for (const line of this.lines) {
      const truncated = truncLine(line, innerWidth);
      const bgSafe = sanitizeAnsiForBg(truncated);
      const padded = padToVisible(bgSafe, innerWidth);
      const content = t.bg("customMessageBg", " ".repeat(INNER_PAD) + padded + " ".repeat(INNER_PAD));
      result.push(t.fg(borderColor, "│") + content + t.fg(borderColor, "│"));
    }

    // 底边框：╰─...─╯
    result.push(
      t.fg(borderColor, "╰" + "─".repeat(horizLen) + "╯"),
    );

    this.cache = { width, lines: result };
    return result;
  }
}

/**
 * 把行内的全局 ANSI reset 替换为不破坏背景色的精确 reset。
 *
 * `\x1b[0m`（含 `\x1b[0;Nm` 组合形式、`\x1b[m` 省略形式）会清除背景色
 * （`\x1b[49m` 语义），在紫色背景框内导致省略号后失去背景。
 *
 * 替换为 `\x1b[39m\x1b[22m\x1b[23m\x1b[24m`——分别重置前景色、粗体、斜体、
 * 下划线。这覆盖了内容行可能用到的所有前景 SGR 类别，且不含背景 reset。
 */
function sanitizeAnsiForBg(text: string): string {
  // 匹配全局 reset：\x1b[0m / \x1b[m / \x1b[0;Nm / \x1b[0;N;Mm 等以 0 开头的 SGR
  return text.replace(/\x1b\[0*(?:;[\d;]*)*m/g, "\x1b[39m\x1b[22m\x1b[23m\x1b[24m");
}

// ============================================================
// 内容行生成
// ============================================================

/**
 * 渲染单条 record 为多行文本（纯视觉文本，不含边框/背景——由 BorderedBgBox 包裹）。
 *
 * 格式（两行）：
 *   第 1 行（标题）：✓/✗/■ glyph + agent + model + 状态描述 + shortId
 *     - done:      `✓ default — background subagent finished - bg-f6f731-10`
 *     - failed:    `✗ default — background subagent failed - bg-f6f731-10`
 *     - cancelled: `■ default — background subagent cancelled - bg-f6f731-10`
 *   第 2 行（正文）：结果首行 / Error 首行 / cancelled 无第二行
 */
function renderRecordLines(record: BgNotifyRecord, t: ThemeLike): string[] {
  const glyph = statusGlyph(record.status);
  const icon = glyph.icon ?? "•";
  const agent = truncLine(displayAgentName(record.agent), AGENT_MAX_WIDTH);
  // model 段：agent 后、状态描述前，accent 色。空则省略（向后兼容旧 record）。
  const modelPart = record.model
    ? ` ${t.fg("dim", "·")} ${t.fg("accent", truncLine(record.model, MODEL_MAX_WIDTH))}`
    : "";
  // U3 C-outcome：verb 与正文分流只读 outcome——单一权威派生（升级前旧消息重放等
  // details 缺 outcome 的存量形态经 deriveOutcome(closedReason, error) 兑底，非同构
  // 重写）。判定先于 patchFile：failed 分支不展示 patch/result（失败轮也会写
  // patchFile，历史 bug 存档见 deriveOutcome 注释）。
  const outcome = record.outcome ?? deriveOutcome(record.closedReason, record.error);
  let verb: string;
  if (outcome === "cancelled") {
    verb = "cancelled";
  } else if (outcome === "failed") {
    verb = "failed";
  } else {
    verb = "finished";
  }
  const idShort = shortId(record.id);
  const head = `${t.fg(glyph.color, icon)} ${t.bold(agent)}${modelPart}${t.fg("dim", ` — background subagent ${verb} - ${idShort}`)}`;

  switch (record.status) {
    case "closed": {
      // U3 C-outcome：cancelled 无正文；failed 显示错误；否则结果/patch（同上，分流只读 outcome）。
      if (outcome === "cancelled") {
        return [head];
      }
      if (outcome === "failed") {
        return [head, t.fg("dim", truncLine(`Error: ${firstLineSanitized(record.error ?? "")}`, BODY_MAX_WIDTH))];
      }
      if (!record.result && !record.patchFile) return [head];
      const lines: string[] = [];
      if (record.result) {
        lines.push(t.fg("dim", truncLine(firstLineSanitized(record.result), BODY_MAX_WIDTH)));
      }
      // [MF#1] 显示 patch 路径提示（与 LLM content 同源），让用户也能看到改动需 `git apply`。
      if (record.patchFile) {
        lines.push(t.fg("dim", truncLine(`patch: ${record.patchFile} (run: git apply)`, BODY_MAX_WIDTH)));
      }
      return [head, ...lines];
    }
    case "running":
    default:
      // v4 B-1: 对话模式轮次完成（旧 idle 折入 running）——仅标题行。
      return [head];
  }
}

/**
 * 从 message.details 防御性提取批量 record。
 * 形态：{ batch: true, items: BgNotifyRecord[] }。结构不全返回 undefined。
 */
function extractBatch(details: unknown): BgNotifyRecord[] | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  if (d.batch !== true || !Array.isArray(d.items)) return undefined;
  const records: BgNotifyRecord[] = [];
  for (const item of d.items) {
    const r = extractBgNotifyRecord(item);
    if (r) records.push(r);
  }
  return records.length > 0 ? records : undefined;
}

/**
 * details.closedReason 防御性收窄：任意字符串 → ClosedReason | undefined。
 * 旧数据/外部构造的非法值按缺失处理，交由 deriveOutcome 兑底（消费方不崩溃）。
 */
function toClosedReason(value: unknown): ClosedReason | undefined {
  return CLOSED_REASONS.find((reason) => reason === value);
}

/** details.outcome 防御性收窄：仅接受三态枚举值，其余按缺失处理。 */
function toOutcome(value: unknown): ExecutionOutcome | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

/**
 * 从 message.details 防御性提取 BgNotifyRecord。
 * 结构不全（缺 status / agent）返回 undefined。
 */
function extractBgNotifyRecord(details: unknown): BgNotifyRecord | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  const status = d.status;
  const agent = d.agent;
  if (
    (status !== "closed" && status !== "running") ||
    typeof agent !== "string"
  ) {
    return undefined;
  }
  return {
    id: typeof d.id === "string" ? d.id : "",
    status,
    agent,
    model: typeof d.model === "string" ? d.model : undefined,
    result: typeof d.result === "string" ? d.result : undefined,
    error: typeof d.error === "string" ? d.error : undefined,
    closedReason: toClosedReason(d.closedReason),
    outcome: toOutcome(d.outcome),
    // [MF#1] 提取 patchFile（worktree background 完成通知携带）。
    patchFile: typeof d.patchFile === "string" ? d.patchFile : undefined,
  };
}
