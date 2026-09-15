// src/interface/tool-render.ts
//
// 对话流 tool block 渲染。renderCall（标题行）+ renderResult（背景色 block）。
//
// 关键设计（参照 nicobailon pi-subagents 渲染架构）：
//   1. 不设 renderShell（默认 default）。背景色/padding 归 Pi 的 contentBox = Box(1,1,bgFn)，
//      它按 isPartial/isError 自动切 toolPendingBg/toolSuccessBg/toolErrorBg 三态。
//      组件 render 返回的 string[] **绝不调 theme.bg**——否则双重背景混色。
//   2. 所有输出行经 truncLine（ANSI 安全，省略号前重应用 SGR，背景不断裂）。
//   3. 上下留白（Spacer(1) + Box paddingY=1）由 ToolExecutionComponent 负责，
//      组件不自己加 Spacer 做间隔。
//   4. spinner 用 seed-based 选帧（progress 字段派生），不用 setInterval/invalidate。
//      onUpdate 驱动重绘时 seed 变化 → 自动换帧。
//   5. streaming delta（text/thinking）不触发 onUpdate，仅离散边界事件触发重绘。
//   6. compact 分支返回单 Text（多行 join "\n"），expanded 返回 Container。
//      单 Text 让整块作为单个渲染单元整体失效，绕开 pi 差分引擎对「多 Text 子组件
//      + 内容平移」的 cell 残留 bug（ghosting 空行）。详见 renderSubagentResult 的
//      [HISTORICAL] 注释。

import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";

import type {
  ListResponse,
  SubagentToolResult,
} from "@zhushanwen/subagent-core";
import { displayAgentName } from "@zhushanwen/subagent-core";
import {
  extractAgentName,
  firstLineSanitized,
  formatElapsedSeconds,
  statusGlyph,
  type ThemeLike,
  truncLine,
} from "./format.ts";

// ============================================================
// 常量
// ============================================================

/** message stream 每行的缩进前缀（2 空格 + ⎿ + 空格），dim 色。 */
const STREAM_PREFIX = "  ⎿ ";

/** footer 用的纯空格缩进（与 STREAM_PREFIX 等宽 4 列，但不带 ⎿）。 */
const FOOTER_PREFIX = "    ";

/** process.stdout.columns 不可用（非 TTY 等）时的终端宽度兜底（列）。 */
const DEFAULT_TERM_WIDTH_COLUMNS = 120;

/** 终端宽度扣减（列）：Pi Box paddingX=1（左右各 1 列）+ 安全余量。 */
const TERM_WIDTH_BOX_INSET_COLUMNS = 4;

/**
 * 获取终端宽度（参照 nicobailon getTermWidth）。
 * truncLine 需要在创建 Text 之前执行——此时 Pi 的 Box.render(contentWidth) 还未调用，
 * 只能从 process.stdout 估算。
 */
function getTermWidth(): number {
  return (process.stdout.columns || DEFAULT_TERM_WIDTH_COLUMNS) - TERM_WIDTH_BOX_INSET_COLUMNS;
}

// ============================================================
// 类型（已存在的契约）
// ============================================================

/**
 * renderResult 的 context（SDK ToolRenderContext 的有意子集——只读 state/invalidate）。
 * SDK 实际传入更完整的 { args, toolCallId, cwd, executionStarted, argsComplete, isPartial,
 * expanded, showImages, isError, lastComponent, ... }，本组件结构兼容只取需要的字段。
 *
 * 注意：不使用 lastComponent。每次 renderResult 返回新 Container（参照 nicobailon）。
 */
export interface RenderContext {
  state: Record<string, never>;
  invalidate(): void;
}

// ============================================================
// renderCall —— tool 标题行
// ============================================================

/**
 * renderCall：tool 标题行（agent + model + thinking 等级，不变信息）。
 *
 *   "subagent worker · glm-5.2 · high"
 *
 * model/thinkingLevel 由调用方（subagent-tool.ts 的闭包）预解析后传入，
 * 因为 renderCall 在 execute 前调用，但 model 解析是同步的（只读配置）。
 * resolved 缺失时（hub 未就绪）降级为只显示 agent 名。
 *
 * 返回 `new Text(line, 0, 0)`——paddingX=0 paddingY=0，背景交给 contentBox。
 */
export function renderSubagentCall(
  args: unknown,
  theme: Theme,
  _context: RenderContext,
  resolved?: { model: string; thinkingLevel?: string },
): Component {
  const t = theme as ThemeLike;
  // args 结构（拍平后）：{ action:"start", agent, task, slug, ... }（见 subagent-tool.ts schema）。
  // 13 字段直接在顶层，extractAgentName / slug / task 都从 args 顶层提取，
  // 对齐 nicobailon 的 renderCall 多行布局。agent ref 是绝对路径，显示取 basename 短名
  // （displayAgentName）；extractAgentName 原值另被 subagent-tool 的 resolveModel 消费，不动。
  const agent = displayAgentName(extractAgentName(args));
  // slug：从顶层 args 提取（必填字段），非空时在 agent 后用 · 分隔展示。
  // 断言目标含必填 slug 字段（in 守卫已确认存在），对齐 format.ts extractAgentName 先例。
  const slug = typeof args === "object" && args !== null && "slug" in args
    ? (args as { slug: unknown }).slug
    : undefined;
  const slugStr = typeof slug === "string" ? slug.trim() : "";
  const parts = slugStr
    ? [`${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", agent)}${t.fg("dim", " · ")}${t.fg("accent", slugStr)}`]
    : [`${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", agent)}`];

  // model + thinking——完整 provider/model（accent 色），thinking 保持 dim。
  // 不去 provider 前缀——provider 是模型来源的关键信息，感知「用错模型」需要完整路径。
  if (resolved) {
    parts.push(t.fg("dim", " ("));
    parts.push(t.fg("accent", resolved.model));
    if (resolved.thinkingLevel) {
      parts.push(t.fg("dim", ` · ${resolved.thinkingLevel})`));
    } else {
      parts.push(t.fg("dim", ")"));
    }
  }

  return new Text(parts.join(""), 0, 0);
}

// ============================================================
// renderResult —— 对话流背景色 block
// ============================================================

/**
 * renderResult：对话流背景色 block。
 *
 * compact（默认）返回单个 Text（多行 join "\n"），expanded 返回 Container。
 * 背景色由 Pi default shell 的 contentBox 按 isPartial/isError 自动施加，
 * 组件本身不施加背景色。
 *
 *   1. details 缺失 → fallback new Text（防御性）
 *   2. 按 action 路由到 compact / expanded / list / cancel 渲染
 *   3. compact：lines.join("\n") → new Text（绕开 ghosting，见下方 HISTORICAL）
 *   4. expanded：lines → Container { Text, Text, ... }
 */
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: RenderContext,
): Component {
  const themeLike = theme as ThemeLike;
  const details = result.details;

  // 防御性 fallback：按 action 判断 details 结构是否完整（G2-007）。
  // list/cancel 无顶层 status/agent，旧 guard（typeof details.status）会误判「execution failed」。
  // details 缺失通常是因为 execute 抛错（如 hub disposed）——此时 Pi 把 error.message 塞进
  // result.content[0].text。旧实现只显示 "no details available"，吞掉真实原因，导致 AI 盲猜。
  // 现在从 result.content 提取错误文本显示，拿不到才退回通用文案。
  if (!details || typeof details.action !== "string" || !isDetailsStructurallyComplete(details)) {
    const errorText = extractResultError(result.content);
    const fallback = errorText ?? "(subagent execution failed — no details available)";
    return new Text(themeLike.fg("warning", fallback), 0, 0);
  }

  const lines = options.expanded
    ? buildExpandedLines(details, themeLike)
    : buildCompactLines(details, themeLike);

  // [HISTORICAL] compact 分支返回单个 Text（多行 join "\n"），而非 Container{Text...}。
  // 对齐 nicobailon 的渲染结构（single Text 整块）。
  // expanded 分支仍用 Container（未来可能含 Markdown 等富组件）。
  if (!options.expanded) {
    return new Text(lines.join("\n"), 0, 0);
  }

  const container = new Container();
  for (const line of lines) {
    container.addChild(new Text(line, 0, 0));
  }
  return container;
}

// ============================================================
// 行内容生成（compact / expanded）
// ============================================================

/**
 * 压缩视图行内容生成。返回裸内容行（不含背景色/padding）。
 *
 * 布局：statusLine + 滚动区(eventLog 最近 N 条) + 底部行。
 * running 和 terminal 态行数可能不同（running 有 "Press Ctrl+O"，terminal 有 delivery），
 * 不强制行数对齐（行数随 eventLog 增长自然变化）。
 */
function buildCompactLines(d: SubagentToolResult, theme: ThemeLike): string[] {
  const width = getTermWidth();

  // ── list 分支：表格（每行一个 item 摘要）──
  if (d.action === "list" && d.listResponse) {
    return renderListCompact(d.listResponse, theme, width);
  }
  // ── cancel 分支：确认行 ──
  if (d.action === "cancel" && d.cancelResponse) {
    return [truncLine(
      `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
      width,
    )];
  }
  // ── fork-from 分支：接续确认行（[v8.5 B]）──
  if (d.action === "fork-from" && d.forkFromResponse) {
    const src = shortSessionLabel(d.forkFromResponse.sourceSessionFile);
    return [truncLine(
      `${theme.fg("accent", "⑂")} ${theme.fg("dim", "forked-from ")}${theme.fg("accent", src)}` +
      ` ${theme.fg("dim", "→ new: ")}${theme.fg("accent", d.subagentId ?? "?")}`,
      width,
    )];
  }
  // ── start 分支：background ──
  if ("bgResponse" in d) {
    return [truncLine(
      `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`
      + ` ${theme.fg("dim", "· detached")}`,
      width,
    )];
  }
  return [truncLine(theme.fg("warning", "(subagent: no response)"), width)];
}

/**
 * 展开视图行内容生成。完整 eventLog + 交付物。
 */
function buildExpandedLines(d: SubagentToolResult, theme: ThemeLike): string[] {
  const width = getTermWidth();

  if (d.action === "list" && d.listResponse) {
    return renderListExpanded(d.listResponse, theme, width);
  }
  if (d.action === "cancel" && d.cancelResponse) {
    return [truncLine(
      `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
      width,
    )];
  }
  if (d.action === "fork-from" && d.forkFromResponse) {
    // expanded 与 compact 同形（一次性 block 无细节可展开），另附源文件完整路径行。
    return [
      truncLine(
        `${theme.fg("accent", "⑂")} ${theme.fg("dim", "forked-from ")}${theme.fg("accent", d.forkFromResponse.sourceSessionFile)}` +
        ` ${theme.fg("dim", "→ new: ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      ),
    ];
  }

  const lines: string[] = [];
  // bg 占位 expanded 与 compact 同（一次性 block 无细节可展开）
  if ("bgResponse" in d) {
    lines.push(truncLine(
      `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`
      + ` ${theme.fg("dim", "· detached")}`,
      width,
    ));
    return lines;
  }
  return [truncLine(theme.fg("warning", "(subagent: no response)"), width)];
}

// ============================================================
// 私有 helper（模块内）
// ============================================================

/** 按 action 检查 details 内层分组是否存在（G2-007 guard）。 */
function isDetailsStructurallyComplete(d: SubagentToolResult): boolean {
  switch (d.action) {
    case "start":
      return "bgResponse" in d;
    case "list":
      return "listResponse" in d;
    case "cancel":
      return "cancelResponse" in d;
    case "fork-from":
      // [v8.5 B] 新 action 直接纳入 guard：缺内层分组才 fallback。
      // message/close 维持历史现状（不落此 switch 显式分支，走 extractResultError
      // 回显 content 首行）不变，避免触碰现有渲染回归面——review MF-13 曾引入
      // message/close 显式分支后回退：无对应渲染分支却判「结构完整」会改走
      // generic 无响应渲染，属静默行为变更。
      return "forkFromResponse" in d;
    default:
      return false;
  }
}

/** fork-from 渲染用的源文件短标签（basename；失败时原样返回——渲染不应抛错）。 */
function shortSessionLabel(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx >= 0 ? file.slice(idx + 1) : file;
}

/**
 * 从 tool result 的 content 里提取错误文本。
 *
 * execute 抛错（如 hub disposed / task 缺失）时，subagents handler 不 catch，
 * Pi 框架会把 error.message 塞进 result.content[0].text。renderResult 的 fallback
 * 分支用它把真实原因显示出来，避免只显「no details available」让 AI 盲猜。
 * content 可能多行，只取首行（共享 firstLineSanitized 裁断 + sanitize）。
 */
function extractResultError(content: AgentToolResult<SubagentToolResult>["content"]): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const text = getStringText(item);
    if (text) return firstLineSanitized(text);
  }
  return undefined;
}

/** 若 item 是带非空 .text 的对象则返回 text，否则 undefined。 */
function getStringText(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const val = (item as Record<string, unknown>).text;
  return typeof val === "string" && val.trim().length > 0 ? val : undefined;
}

// ============================================================
// list 渲染 helper（action:"list" 分支）
// ============================================================

/** list compact：标题行 + 每行一个 item 摘要（glyph + agent + slug + mode + status + duration）。 */
function renderListCompact(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  if (resp.items.length === 0) {
    return [truncLine(theme.fg("dim", `No subagents (running: ${resp.running})`), width)];
  }
  const lines: string[] = [
    truncLine(theme.fg("dim", `Subagents (running: ${resp.running}/${resp.items.length})`), width),
  ];
  for (const it of resp.items) {
    const glyph = statusGlyph(it.status);
    const icon = glyph.icon ?? "●";
    const mode = "bg";
    // slug 非空时在 agent 后展示（· 分隔），空串时省略。
    const slugPart = it.slug ? `${theme.fg("dim", " · ")}${theme.fg("accent", it.slug)}` : "";
    const line = `${theme.fg(glyph.color, icon)} ${theme.fg("accent", it.agent)}${slugPart}`
      + ` ${theme.fg("dim", `· ${mode} · ${it.status} · ${formatElapsedSeconds(it.duration)}`)}`;
    lines.push(truncLine(`${STREAM_PREFIX}${line}`, width));
  }
  return lines;
}

/** list expanded：compact 基础上每 item 追加 sessionFile 路径行。 */
function renderListExpanded(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  const lines = renderListCompact(resp, theme, width);
  for (const it of resp.items) {
    if (it.sessionFile) {
      lines.push(truncLine(`${theme.fg("dim", `${FOOTER_PREFIX}session: `)}${it.sessionFile}`, width));
    }
  }
  return lines;
}
