/**
 * tool-shared.ts — workflow / subagents / workflow-script 三个 tool 的同粒度共享构件。
 *
 * 抽取边界（findings g11a-F1/F2/F3）：
 * - `assertNotAborted` / `optionSlugSuffix` / `renderTextResult`：三处逐字重复的
 *   入口前置与渲染片段（同粒度小函数）。
 * - `buildRunSpecFromScript` / `formatAvailableWorkflowList`：RunSpec 组装字面量与
 *   「可用脚本清单」串——RunSpec 是 core 启动契约，两份字面量漏改即静默丢字段。
 *
 * **不**把 execute 包成 HOF：reentry-guard.ts 文件头已裁决（HOF 包装会破坏 union
 * 返回类型推断），本文件只放同粒度小函数，guard 的 check → try/finally release
 * 顺序仍留在各 tool 的 execute 里显式可见。
 *
 * 层归属：Interface（依赖 Pi SDK 的 AbortSignal / Theme / Text 宿主概念，不下沉 core）。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { RunSpec, WorkflowScript } from "@zhushanwen/subagent-core";
import { renderTextFallback } from "./format.ts";

/** renderResult 回调的宽入参形态（content 可缺省，由 renderTextFallback 兜底）。 */
export interface RenderableToolResult {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * 入口 abort 前置：已被取消则 throw。
 *
 * pi 只对 execute throw 置 isError:true（返回值里的 isError 被 agent-loop 丢弃，
 * agent-loop.js:453-483）——错误一律 throw。
 */
export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted before start");
  }
}

/**
 * renderCall 的可选 slug 后缀片段：` · <slug>`（dim 分隔 + accent 值）。
 *
 * 非字符串或空白串视为未提供 → 空串（调用方直接拼接）。
 */
export function optionSlugSuffix(slug: unknown, theme: Theme): string {
  return typeof slug === "string" && slug.trim()
    ? `${theme.fg("dim", " · ")}${theme.fg("accent", String(slug))}`
    : "";
}

/** renderResult 统一形态：单 Text 元素（左上角原点），文本走 renderTextFallback。 */
export function renderTextResult(result: RenderableToolResult): Text {
  return new Text(renderTextFallback(result), 0, 0);
}

/**
 * buildRunSpecFromScript 的调用方差异项（两个 tool 的取值域不同，用参数保留）：
 * - args：subagents 由 handler 从顶层 tasks/agents/aggregate 组装；workflow 用 params.args
 * - slug：subagents 可能是 handler 生成的 `<script>-<时间短码>`；workflow 用 params.slug
 * - budgetTokens / budgetTimeMs：分别来自各 tool 的 tokens / time 字段
 */
export interface RunSpecFromScriptOptions {
  args: Record<string, unknown>;
  budgetTokens?: number | undefined;
  budgetTimeMs?: number | undefined;
  slug?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
}

/**
 * 从已解析脚本 + 归一化选项组装 RunSpec（core 启动契约的结构字面量单点）。
 *
 * 键序与两个 tool 原字面量逐字一致（parameters 从 script.meta 整对象透传——
 * chokepoint 校验用；漏拷即校验静默退化为「不校验」，m3 防过的坑）。
 */
export function buildRunSpecFromScript(
  script: WorkflowScript,
  opts: RunSpecFromScriptOptions,
): RunSpec {
  return {
    scriptSource: script.toExecutable(),
    args: opts.args,
    budgetTokens: opts.budgetTokens,
    budgetTimeMs: opts.budgetTimeMs,
    scriptName: script.name,
    slug: opts.slug,
    scriptPath: script.path,
    description: script.meta.description,
    parameters: script.meta.parameters,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
  };
}

/**
 * 「可用脚本清单」串（无可用项 → 空串，调用方自行补 `|| "  (none)"`）。
 *
 * 每项两行（name + description，缩进 location 绝对路径）——弱模型按清单里的名字
 * / 路径重试的自救主路径，两个 tool 的文案必须同源。
 */
export function formatAvailableWorkflowList(all: readonly WorkflowScript[]): string {
  return all
    .filter((wf) => wf.available)
    .map(
      (wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}\n    location: ${wf.path}`,
    )
    .join("\n");
}
