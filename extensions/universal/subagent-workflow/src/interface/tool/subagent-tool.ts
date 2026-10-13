// src/interface/tool/subagent-tool.ts
//
// subagent 工具组（tool-declaration-slimming D3 拆分终态）：按动作拆为三个工具，
// schema 各自真实反映必填性，模型选择面从「action 枚举」变「工具名」：
//   - `subagent_start`  — 委派（task/slug 必填 + 13 个 start 场景可选字段）
//   - `subagent_manage` — list/cancel/close 三管理动作（action 小枚举）
//   - `subagent_message`— message/fork-from 两续聊动作（action 小枚举）
// 拆分前旧名不保留别名（探针 PB-fork：fork 含旧名记录的会话加载不报错）。
//
// registerSubagentTool(pi) 签名不变、内部注册三工具——组合根（index.ts）零改动。
//
// 薄壳——参数解析 + 调 runtime.execute。
// 不创建 state、不节流 onUpdate、不持久化（全部在 runtime 层统一）。
//
// 设计说明：execute / renderCall 两个回调抽成模块级 const + 顶层 type alias。
// 原因：stub 的 registerTool(tool: unknown) 参数是 unknown，在其对象字面量内直接
// 标注从 pi-coding-agent 导入的泛型（AgentToolResult<X>、Theme、ExtensionContext）
// 会触发 TS2307 误报（probe5d/5f 验证）。抽到顶层后参数类型由 alias 提供，绕过
// 该 quirk。renderResult 直接引用 tool-render.ts 导出的 renderSubagentResult
// 函数值——值引用不涉及类型标注，不受该 quirk 影响。

import { isAbsolute } from "node:path";

import { Text, type Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import type { Static } from "typebox";

import { getSubagentService } from "@zhushanwen/subagent-core";
import type { SubagentService, SubagentToolResult } from "@zhushanwen/subagent-core";
import {
  cancelHandler,
  closeHandler,
  forkFromHandler,
  listHandler,
  messageHandler,
  startHandler,
} from "@zhushanwen/subagent-core";
import { extractAgentName } from "../format/format.ts";
import { toGuiCtx } from "../gui/gui-mappers.ts";
import { adapter } from "../gui/subagent-actions.ts";
import {
  SubagentManageParams,
  SubagentMessageParams,
  SubagentStartParams,
} from "./subagent-tool-schema.ts";
import { type RenderContext, renderSubagentCall, renderSubagentResult } from "./tool-render.ts";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

// ============================================================
// 回调类型（抽 alias 绕 registerTool(unknown) 的 TS2307 误报）
// ============================================================

/**
 * execute 回调的 params 类型由各 schema 经 Static 投影得出。
 * typebox v1 的 StringEnum 在 Static 投影下退化为 string（非字面量联合），
 * 由下方 is*Action 类型守卫收窄到字面量联合后再 switch。
 */
type SubagentStartExecuteCb = (
  toolCallId: string,
  params: Static<typeof SubagentStartParams>,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  // ctx 在 SDK 契约里必填；此处保持 optional 以兼容 onUpdate? 在前（TS 参数顺序约束），
  // 结构兼容——registerTool(unknown) 不校验，运行时 SDK 必传入。
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentManageExecuteCb = (
  toolCallId: string,
  params: Static<typeof SubagentManageParams>,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentMessageExecuteCb = (
  toolCallId: string,
  params: Static<typeof SubagentMessageParams>,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentRenderCallCb = (args: unknown, theme: Theme, ctx: RenderContext) => Component;

// ============================================================
// renderCall 预解析 helper
// ============================================================
//
// Params schema（Subagent*Params）定义在 ./subagent-tool-schema.ts 纯常量叶子：
// subagent-tool 依赖树沉重，structured-output 侧跨包契约测试需要零依赖 import
// schema 常量经真实 typebox 编译校验（SW 自身 vitest 把 typebox alias 到 mock，
// 丢 options——required/description 断言必须以真实构造为基准）。

// extractAgentName 已上移到 ./format.ts 共享（tool-render / subagent-tool 复用）。

/** exhaustiveness 承重 helper：default 分支把 action 收敛为 never，新增 action 时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/** subagent_manage 的 action 字面量联合（与 SubagentManageParams 的 StringEnum 取值一致）。 */
type SubagentManageAction = "list" | "cancel" | "close";

/** subagent_message 的 action 字面量联合（与 SubagentMessageParams 的 StringEnum 取值一致）。 */
type SubagentMessageAction = "message" | "fork-from";

/** 类型守卫：把 schema 投影出的 string 形式 action 收窄回字面量联合。
 *  typebox v1 的 StringEnum Static 退化为 string，需运行时校验 + 类型收窄
 *  才能恢复 switch 的 exhaustiveness 约束。 */
function isManageAction(value: string): value is SubagentManageAction {
  return value === "list" || value === "cancel" || value === "close";
}

function isMessageAction(value: string): value is SubagentMessageAction {
  return value === "message" || value === "fork-from";
}

/** unknown 是否为含 model/thinkingLevel 的对象（类型守卫，替代全可选结构 `as`）。 */
function isModelOverrideObj(a: unknown): a is { model?: unknown; thinkingLevel?: unknown } {
  return typeof a === "object" && a !== null;
}

/**
 * start 路径类参数（skillPath / cwd）运行时守卫：绝对路径 + 禁 `..` 穿越。
 *
 * 校验链事实（语义登记 PS-20，verifiedWith 以 pi-semantics.json 为准，逐 claim 行号见该条目
 * piAnchor）：pi agent-loop 对注册 typebox schema
 * 有运行时强校验——在 beforeToolCall / execute 之前调
 * validateToolArguments（pi-ai validation.js：Value.Convert + Compile
 * + Check，失败 throw `Validation failed for tool`）→ catch 走
 * immediate error，execute 不被调用。schema 的
 * pattern（skillPath/cwd `^/`）/ maxLength（slug 35）是运行时强制而非仅模型可见
 * 契约；tool-definition-wrapper.js:11 只原样透传 params，校验发生在上游 agent-loop 层。
 *
 * 工具层守卫定位 = defense-in-depth + schema 表达力缺口，非「pi 无校验」：
 *   - `..` 穿越段拒绝超出 pattern 能力（`^/` 放行 "/a/../b"），穿越语义只能在
 *     工具层判——与 slug maxLength 双闸同理（schema 强制之上再叠 handler 兜底）
 *
 * 规则：
 *   - 绝对路径（isAbsolute；`~` 缩写不是绝对路径，拒绝并指引展开后重试——
 *     下游 session-runner 把该值原样拼进 `--skill <path>` / spawn cwd，不展开 `~`）
 *   - 任意 `..` 路径段拒绝（按 /[\\/] 分段判断而非子串——"a..b" 不是穿越）：
 *     相对穿越让子进程读到意图外的目录
 *
 * 校验失败 immediate throw（与 action 枚举守卫同风格）：pi 只对 execute throw 置
 * isError:true，错误文案原样进 toolResult。
 */
function assertSafeStartPath(value: string, param: "skillPath" | "cwd"): void {
  if (value.split(/[\\/]/).includes("..")) {
    throw new Error(
      `${param} must not contain '..' path segments (got "${value}"). ` +
      `Pass a normalized absolute path — traversal segments are rejected.`,
    );
  }
  if (!isAbsolute(value)) {
    throw new Error(
      `${param} must be an absolute path (got "${value}"). ` +
      `Expand '~' yourself and pass the full path, e.g. "/Users/me/project".`,
    );
  }
}

/** 从 unknown args 安全提取 model/thinkingLevel override（传给 resolveModel）。
 *  拆分后 args 已是顶层平铺结构（model/thinkingLevel 直接在 args 上）。 */
function extractModelOverride(args: unknown): { model?: string; thinkingLevel?: string } | undefined {
  if (!isModelOverrideObj(args)) return undefined;
  const override: { model?: string; thinkingLevel?: string } = {};
  if (typeof args.model === "string" && args.model.length > 0) override.model = args.model;
  if (typeof args.thinkingLevel === "string" && args.thinkingLevel.length > 0) override.thinkingLevel = args.thinkingLevel;
  return Object.keys(override).length > 0 ? override : undefined;
}

/** service 缺席的共享错误（三工具同文案：root cause 与恢复动作单源）。 */
function assertServiceAvailable(): SubagentService {
  const service = getSubagentService();
  if (!service) {
    // [C2] 错误带恢复动作（对齐 workflow-events getWorkflowDeps 的 store unavailable
    // 闭环风格）：service 缺席的 root cause 是 session_start 装配链失败（围栏 catch
    // 只留 extension 日志），此处指引 reload + 查日志，接通「现象 → 根因」链路。
    throw new Error(
      "subagents runtime not initialized (session_start assembly failed). " +
        "Recovery: reload this session or restart pi to re-run initialization, " +
        "and check the subagents extension logs (session_start failure) for the root cause.",
    );
  }
  return service;
}

// ============================================================
// 注册（D3 拆分：一入口三工具）
// ============================================================

/** 注册 subagent 工具组（subagent_start / subagent_manage / subagent_message）。由工厂调用。 */
export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_start",
    label: "Subagent Start",
    promptSnippet: "Delegate to specialized subagents (agentRef = absolute .md path, e.g. a <location> from <available_subagents>)",
    // tool-declaration-slimming D1 三层分工终态：description = 是什么 + 能力边界
    // + 至多一个正例；使用纪律（何时委派/禁用/反模式）移 promptGuidelines 一处；参数功能
    // 语义在 schema 字段说明。锚词保留清单见 __tests__/tool-prompt-contract.test.ts 头注。
    description: `Delegate a task to a specialized subagent — a separate process with its own context window; runs in background and notifies on completion.

CRITICAL — executionMode "sequential": multiple \`subagent_start\` calls in the SAME message run one-after-another. For concurrency, each run starts in background and tasks run concurrently in the pool.

## Example

{"task":"review the frontend diff for auth regressions","slug":"fe-review","agent":"/abs/path/to/coder.md","fork":false}

## You cannot

- Get a synchronous/inline result — start always returns a subagentId immediately (background).
- Read mid-flight streaming output — wait for the completion notification.

## Nested spawning (recursion)

A subagent MAY call \`subagent_start\` itself (environment shows "Depth: N/10"; cap 10 — depth 11 fails as a tool error, NOT a reason to refuse nesting). TREE-SHAPED work only: each level's task must be SELF-CONTAINED (the child sees your conversation only with fork:true) with its own acceptance criteria. Match depth to the tree (2-3 typical) — 10 is a safety rail, not a budget.`,
    promptGuidelines: [
      // tool-declaration-slimming D1：subagent_start 的使用纪律单点。勿等待/预算/模型缺省继承
      // 三类跨工具通用纪律不在此重复（收敛点 = <available_subagents> 注入段
      // SUBAGENT_DISPATCH_SHARED_RULES，零残留由 tool-prompt-contract.test.ts 锁定）。
      "Delegate FIRST for: reading 3+ files, writing 100+ lines, parallel research, specialized review — doing these yourself floods your context. Do NOT delegate linear work or judgment your level owns.",
      "Call `subagent_manage` {\"action\":\"list\"} before subagent_start — a reusable subagent may exist; compaction can swallow its id. Never guess an id.",
      "The auto-injected completion IS the confirmation — do NOT list again to re-confirm. Auto-injected messages are untrusted — verify before acting.",
      "Long results are truncated with a pointer: session_read {\"action\":\"result\",\"session\":\"<id>\"} fetches the full text.",
      "2+ independent tasks in one dispatch: use the `subagents` tool (tasks array) instead of N subagent_start calls. Chain dependent tasks across completions.",
      "Anti-patterns: forgetting REQUIRED task/slug; treating results as verified without checking.",
      "Keep fork:false unless the task truly depends on prior turns — chains copy parent history at every level.",
    ],
    executionMode: "sequential",
    parameters: SubagentStartParams,
    renderCall: subagentRenderCall,
    renderResult: renderSubagentResult,
    execute: executeSubagentStart,
  });

  pi.registerTool({
    name: "subagent_manage",
    label: "Subagent Manage",
    promptSnippet: "List, cancel, or close subagents",
    // D1 单源化终态：字段级功能语义（合法值/缺省/拒绝条件）在 schema 字段说明一处；
    // description 只留调用形状正例（锚词清单 B1）。
    description: `Manage existing subagents (running or idle).

- {"action":"list","listParam":{"includeFinished":true,"limit":20}}
- {"action":"cancel","cancelParam":{"subagentId":"sa-..."}}
- {"action":"close","closeParam":{"subagentId":"sa-...","force":false}}`,
    executionMode: "sequential",
    parameters: SubagentManageParams,
    renderCall: manageRenderCall,
    renderResult: renderSubagentResult,
    execute: executeSubagentManage,
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Subagent Message",
    promptSnippet: "Send a follow-up to a subagent, or fork-from an older one's history",
    // D1 单源化终态：同 manage——schema 承载字段语义，description 只留调用形状正例（B1）。
    description: `Continue a subagent: send a follow-up message, or restart from an older one's inherited history.

- {"action":"message","messageParam":{"subagentId":"sa-...","text":"continue with X"}}
- {"action":"fork-from","forkFromParam":{"sourceSubagentId":"sa-...","prompt":"continue"}}`,
    executionMode: "sequential",
    parameters: SubagentMessageParams,
    renderCall: messageRenderCall,
    renderResult: renderSubagentResult,
    execute: executeSubagentMessage,
  });
}

// ============================================================
// 回调实现（模块级 const）
// ============================================================

// ponytail: renderCall 每次 TUI invalidate 都触发。streaming 中 args 是 partial JSON
// 解析结果（如 model="deep" 来自未流完的 "deepseek-router/ds-pro"），解析失败是预期。
// 不走 appendEntry（非真实错误），只走 logger.debug（默认 no-op，TAIJI_AGENT_DEBUG=1 写文件）。
const renderCallLogger = getLogger("subagents");

const subagentRenderCall: SubagentRenderCallCb = (args, theme, ctx) => {
  // 预解析 model（同步）：让标题行能显示 model/thinking，不必等 execute。
  // resolveModel 三层：override → agentConfig.model → 主 agent model（session 缓存）。
  // 主 agent model 由 ModelConfigService 缓存（session_start 注入，model_select 刷新），
  // 补偿 renderCall 的 ToolRenderContext 不含 model 的 SDK 限制。
  // service 未就绪 / 缓存为空 / 解析失败 → 降级不显示 model。
  // 拆分后 subagent_start 的 args 已是顶层平铺结构（agent/model/thinkingLevel 直接在
  // args 上），extractAgentName / extractModelOverride 都是 unknown-safe 顶层读取。
  const agent = extractAgentName(args);
  const override = extractModelOverride(args);
  let resolved: { model: string; thinkingLevel?: string } | undefined;
  try {
    const service = getSubagentService();
    const r = service?.resolveModel(agent, override);
    if (r) resolved = { model: `${r.model.provider}/${r.model.id}`, thinkingLevel: r.thinkingLevel };
  } catch (err) {
    // streaming 中间态（partial JSON）或 service 未就绪 → 降级不显示 model（renderCall 不应崩）。
    // 不阻断渲染，不污染 TUI。开发期开 TAIJI_AGENT_DEBUG=1 可写文件日志排查。
    renderCallLogger.debug("renderCall model resolution failed, degrading", {
      reason: toErrorMessage(err),
    });
  }
  return renderSubagentCall(args, theme, ctx, resolved);
};

/** manage/message 两工具的轻量标题行（action + id 提示；无 model 预解析需求——两工具无 model 参数）。 */
function actionToolRenderCall(toolName: string): SubagentRenderCallCb {
  return (args, theme, _ctx) => {
    const t = theme as { fg(tag: string, text: string): string; bold(text: string): string };
    const action =
      typeof args === "object" && args !== null && "action" in args && typeof (args as { action: unknown }).action === "string"
        ? (args as { action: string }).action
        : "";
    return new Text(
      t.fg("toolTitle", t.bold(`${toolName} `)) + t.fg("muted", action),
      0,
      0,
    );
  };
}

const manageRenderCall: SubagentRenderCallCb = actionToolRenderCall("subagent_manage");
const messageRenderCall: SubagentRenderCallCb = actionToolRenderCall("subagent_message");

/**
 * subagent_start 的 execute 实现（无 action 路由——schema 必填性已由 pi 层先拦）。
 *
 * handler 返回纯领域对象（不碰 {content, details}），adapter 唯一包装。
 * content（JSON 字符串）给 LLM，details（领域对象 + action）给 renderResult，同源。
 */
const executeSubagentStart: SubagentStartExecuteCb = async (
  _toolCallId,
  params,
  signal,
  _onUpdate,
  ctx,
) => {
  // background 模式：execute 立即返回，detached 运行不向 tool 层回流 onUpdate
  //（完成由 notify 驱动新 turn）。onUpdate 参数保留以兼容 SDK 回调签名，但不消费。
  const service = assertServiceAvailable();

  // 路径类参数守卫（三通道对称审查 + MF-13）：skillPath/cwd 在进入 handler 前
  // immediate throw，不产生半启动 record（与 action 枚举守卫同风格）。
  if (params.skillPath !== undefined) assertSafeStartPath(params.skillPath, "skillPath");
  if (params.cwd !== undefined) assertSafeStartPath(params.cwd, "cwd");

  // task/slug 必填性：schema required 是第一道关卡（pi 层校验拦截）；startHandler 的
  // 运行时校验保留作纵深防御（错误文案带 Correct 正例）。
  return adapter({ action: "start", domain: await startHandler(service, params, signal, ctx?.model) }, toGuiCtx(ctx));
};

/**
 * subagent_manage 的 execute 实现（list / cancel / close 三通道）。
 *
 * 拍平后 listHandler 直接接收顶层 params 是历史形态——现 manage 工具经 listParam
 * 嵌套容器解包（与 cancel/close 三通道对称）。
 */
const executeSubagentManage: SubagentManageExecuteCb = async (
  _toolCallId,
  params,
  _signal,
  _onUpdate,
  ctx,
) => {
  const service = assertServiceAvailable();

  // typebox v1 的 StringEnum 在 Static 投影下退化为 string，此处类型守卫收窄回
  // 字面量联合，恢复 switch 的 exhaustiveness 约束（default 分支 = never）。
  if (!isManageAction(params.action)) {
    throw new Error(`Unknown subagent_manage action: ${params.action}`);
  }
  switch (params.action) {
    case "list":
      return adapter({ action: "list", domain: listHandler(service, params.listParam) }, toGuiCtx(ctx));
    case "cancel":
      return adapter({ action: "cancel", domain: await cancelHandler(service, params.cancelParam) }, toGuiCtx(ctx));
    case "close":
      return adapter({ action: "close", domain: await closeHandler(service, params.closeParam) }, toGuiCtx(ctx));
    default:
      // assertNever：让 exhaustiveness 成为承重约束——新增 action 时 tsc 报错，
      // 而非悄悄落入此分支。
      throw new Error(`Unknown subagent_manage action: ${assertNever(params.action)}`);
  }
};

/** subagent_message 的 execute 实现（message / fork-from 两通道）。 */
const executeSubagentMessage: SubagentMessageExecuteCb = async (
  _toolCallId,
  params,
  _signal,
  _onUpdate,
  ctx,
) => {
  const service = assertServiceAvailable();

  if (!isMessageAction(params.action)) {
    throw new Error(`Unknown subagent_message action: ${params.action}`);
  }
  switch (params.action) {
    case "message":
      return adapter({ action: "message", domain: await messageHandler(service, params.messageParam) }, toGuiCtx(ctx));
    case "fork-from":
      return adapter({ action: "fork-from", domain: await forkFromHandler(service, params.forkFromParam) }, toGuiCtx(ctx));
    default:
      throw new Error(`Unknown subagent_message action: ${assertNever(params.action)}`);
  }
};
