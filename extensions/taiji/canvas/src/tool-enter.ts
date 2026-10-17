/**
 * canvas_enter —— 画布发现入口（设计 §3.1(2) 工具面）。
 *
 * 双形态：创建 {statement, criterias, scope} / 打开已有画布 {canvasId}（名称 → id
 * 解析不进契约，经 canvas_list 自决）。创建形态落 marker 'create'（runtime 在该
 * 通道 create 成功时一并登记 sessionId ↔ canvasId 绑定），打开形态落 marker
 * 'enter'（读全量 + 登记绑定）。
 *
 * enter 引导协议：成功的结果文本包含「后续画布操作经 tool_search 检索 canvas_edit /
 * canvas_read / canvas_review / canvas_export」指引——deferred 工具须检索激活后
 * 下一轮起可调，直接点名工具名让模型检索词精准命中。
 */
import type { ExtensionAPI, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { renderCanvasToolResult } from "./render.js";
import { canvasEnterSummary } from "./summary.js";
import { callCanvas } from "./marker-channel.js";
import { hostGateError, isTaijiGuiHost } from "./host.js";

/** enter 结果文本的工具检索引导（deferred 工具激活指引，两形态共用）。 */
export const CANVAS_ENTER_GUIDANCE =
  "画布已就绪。后续画布操作经 tool_search 检索 canvas_edit / canvas_read / canvas_review / canvas_export " +
  "激活对应工具后调用（deferred 工具：检索一次，同族 action 全解锁）；画布清单用 canvas_list。";

export const CanvasEnterParams = Type.Object({
  canvasId: Type.Optional(
    Type.String({
      description:
        "Open form: the existing canvas id to enter (from canvas_list). " +
        "Mutually exclusive with the create triple (statement/criterias/scope).",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Create form: canvas name. Omit to let the runtime derive it from statement." }),
  ),
  statement: Type.Optional(
    Type.String({
      description:
        "Create form: the root problem statement (one sentence). " +
        "REQUIRED for create (together with criterias and scope); omit all three when opening by canvasId.",
    }),
  ),
  criterias: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Create form: falsifiable success criterias for the root problem (>= 1). REQUIRED for create.",
    }),
  ),
  scope: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Create form: scope exclusions (what this planning effort will NOT cover). REQUIRED for create (may be empty).",
    }),
  ),
});

export interface EnterToolConfig { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: typeof CanvasEnterParams;
}

/** 创建/打开形态分派 + 契约 params 组装；形状非法 → 结构化错误（invalid_params + 恢复动作）。 */
export function resolveEnterRequest(params: Static<typeof CanvasEnterParams>):
  | { action: "enter"; params: { canvasId: string } }
  | { action: "create"; params: { name?: string; statement: string; criterias: string[]; scopeExclusions: string[] } }
  | { error: Error } {
  if (params.canvasId !== undefined) {
    if (
      params.statement !== undefined ||
      params.criterias !== undefined ||
      params.scope !== undefined
    ) {
      return {
        error: new Error(
          "canvas_enter 参数互斥冲突 [invalid_params] canvasId（打开形态）与 statement/criterias/scope（创建形态）不可同传。" +
            "恢复动作：打开已有画布只传 canvasId（id 经 canvas_list 查询）；新建画布只传 statement + criterias + scope。",
        ),
      };
    }
    return { action: "enter", params: { canvasId: params.canvasId } };
  }
  if (typeof params.statement !== "string" || params.statement.trim() === "") {
    return {
      error: new Error(
        "canvas_enter 缺必填参数 [invalid_params] 创建形态需要 statement + criterias + scope 三要素；打开已有画布需要 canvasId。" +
          "恢复动作：新建传 {statement, criterias, scope}；打开先 canvas_list 取 id 再传 {canvasId}。",
      ),
    };
  }
  if (!Array.isArray(params.criterias) || params.criterias.length === 0) {
    return {
      error: new Error(
        "canvas_enter 缺完成判据 [invalid_params] criterias 至少一条（可证伪的成功判据是画布收敛门禁的输入）。" +
          "恢复动作：补 1-4 条可证伪判据后重试。",
      ),
    };
  }
  if (!Array.isArray(params.scope)) {
    return {
      error: new Error(
        "canvas_enter 缺范围排除 [invalid_params] scope 必填（可为空数组，但须显式声明）。" +
          "恢复动作：补 scope 字段（本规划不覆盖的内容清单）后重试。",
      ),
    };
  }
  return {
    action: "create",
    params: {
      name: params.name,
      statement: params.statement,
      criterias: params.criterias,
      scopeExclusions: params.scope,
    },
  };
}

export function registerCanvasEnterTool(pi: ExtensionAPI, cfg: EnterToolConfig): void {
  pi.registerTool({
    name: cfg.name,
    label: cfg.label,
    // deferred（设计：画布是低频入口，不设常驻 direct；tool_search 命中即激活）。
    // promptSnippet = 工具激活后 system prompt 工具索引里的精简条目（pi 1.0.0
    // system-prompt.js 的 visibleTools 只渲染激活集 snippet，未激活时不进上下文；
    // tool-search 经 setActiveTools 激活后才进）——deferred 形态的入口可见性由
    // index.ts 组合根 before_agent_start 注入的 <available_tools> 常驻段承载。
    exposure: "deferred",
    description: cfg.description,
    promptSnippet: cfg.promptSnippet,
    parameters: cfg.parameters,
    renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
      return renderCanvasToolResult(result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params: Static<typeof CanvasEnterParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (!isTaijiGuiHost(ctx)) throw hostGateError();
      const request = resolveEnterRequest(params);
      if ("error" in request) throw request.error;
      const reply = await callCanvas(ctx, request.action, request.params);
      const text = `${JSON.stringify(reply)}\n\n${CANVAS_ENTER_GUIDANCE}`;
      return { content: [{ type: "text" as const, text }], details: { summary: canvasEnterSummary(params, reply) } };
    },
  });
}
