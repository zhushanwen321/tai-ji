// src/interface/subagent-actions.ts
//
// subagent tool 六 action 的 pi adapter 壳（sink 设计 D6② 消费收缩）。
//
// 领域内核（入参校验 / message 拒绝文案分流 / fork-from 拒绝链 / 终态映射 /
// list 投影）已下沉 core @zhushanwen/subagent-core/execution/assembly/subagent-actions-core——
// ⛔4 行为快照等值锚定见 core __tests__/subagent-actions-core.test.ts（期望值硬编码自
// 本文件迁移前实测输出，含错误文案逐字锚）。本壳按设计仅保留三类职责：
//   1. core 调用面 re-export：六 handler + 领域类型（签名不变，消费方零改动）
//   2. 参数提取：位于 subagent-tool.ts executeSubagent（action 路由 / listParam /
//      cancelParam 解包 / skillPath-cwd 路径检查），本次收缩零改动
//   3. TUI/GUI 渲染：adapter / buildGuiComponent（pi TUI 渲染族按设计留壳）
//
// content（JSON 字符串）给 LLM，details（SubagentToolResult）给 renderResult，同源同处生成。

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";

import type {
  CancelHandlerResult,
  CloseHandlerResult,
  ForkFromHandlerResult,
  ListHandlerResult,
  MessageHandlerResult,
  StartHandlerResult,
  SubagentToolResult,
} from "@zhushanwen/subagent-core";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ============================================================
// core 领域内核 re-export（pi 消费面符号与收缩前一致，经 core barrel 统一消费）
// ============================================================

export {
  cancelHandler,
  closeHandler,
  endedMessageGuard,
  forkFromHandler,
  listHandler,
  mapExternalState,
  messageHandler,
  recordToListItem,
  startHandler,
} from "@zhushanwen/subagent-core";

export type {
  CancelHandlerInput,
  CancelHandlerResult,
  CloseHandlerInput,
  CloseHandlerResult,
  ForkFromHandlerInput,
  ForkFromHandlerResult,
  ListHandlerInput,
  ListHandlerResult,
  MessageHandlerInput,
  MessageHandlerResult,
  StartHandlerInput,
  StartHandlerResult,
} from "@zhushanwen/subagent-core";

// ============================================================
// 渲染层常量 / 类型（pi TUI 渲染族，按设计留壳）
// ============================================================

/** subagentId（UUID）在 GUI header 的截断显示长度。 */
const SUBAGENT_ID_PREVIEW = 8;

/** exhaustiveness 兜底：default 分支把 action 收敛为 never，新增 action 时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/**
 * action ↔ domain 配对的承重类型（替代三处松散 `as`）。
 * 调用方必须传匹配的 {action, domain}——TS 在调用点校验，错配编译报错。
 */
type AdapterInput =
  | { action: "start"; domain: StartHandlerResult }
  | { action: "list"; domain: ListHandlerResult }
  | { action: "cancel"; domain: CancelHandlerResult }
  | { action: "message"; domain: MessageHandlerResult }
  | { action: "close"; domain: CloseHandlerResult }
  | { action: "fork-from"; domain: ForkFromHandlerResult };

// ============================================================
// adapter（领域对象 → SubagentToolResult + {content, details}）
// ============================================================

export function adapter(
  input: AdapterInput,
  ctx?: GuiContext,
): AgentToolResult<SubagentToolResult> {
  const { action } = input;
  let result: SubagentToolResult;
  if (action === "start") {
    const d = input.domain;
    // MF-3（决策 10 细则 4）：LLM content (text) 用 null 瘦身，防诱导 agent 用 read 绕过工具
    // 直接读 session 文件。真实 sessionFile 仅 details 保留（供 GUI/程序化消费）。
    // [U1] model 为 registry 全等回显（放行即全等）。
    result = { action, subagentId: d.subagentId, sessionFile: null, slug: d.slug, model: d.model, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else if (action === "cancel") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  } else if (action === "message") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, messageResponse: input.domain.response };
  } else if (action === "fork-from") {
    // MF-3 同款瘦身：sourceSessionFile 真实路径只在 forkFromResponse 内层（LLM 接续
    // 不需要拼路径，需要时 list/details 可取）；顶层 sessionFile 保持 null 一致性。
    const d = input.domain;
    result = { action, subagentId: d.subagentId, sessionFile: null, forkFromResponse: d.response };
  } else {
    // action === "close"
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, closeResponse: input.domain.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);

  // MF-3：start 的 LLM content 已瘦身（sessionFile:null），details 保留真实 sessionFile 供 GUI/程序化消费。
  // result 已是合法 SubagentToolResult（start 变体 sessionFile:null）；start 时重建一个带真实 sessionFile 的副本。
  let detailsBase: SubagentToolResult = result;
  if (action === "start") {
    const d = input.domain;
    detailsBase = { action: "start", subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, slug: d.slug, model: d.model, bgResponse: d.response };
  }

  // GUI 协议：RPC 模式下附加结构化渲染数据（union 各成员已声明 __gui__?，无需强转）
  const details: SubagentToolResult = ctx && isGuiCapable(ctx)
    ? { ...detailsBase, __gui__: guiResult(buildGuiComponent(input, result)) }
    : detailsBase;

  // [W3 修复] list action 追加 reminder text block：LLM 调 list 时提醒不要轮询。
  // reminder 作为第二个 text block（独立追加，不污染 details/JSON schema）。
  // 只有 list 触发——start 的 reminder 已在 BG_MESSAGE 里；cancel 无需。
  const reminder = action === "list"
    ? "\n\nReminder: Subagent completion is auto-notified via auto-injected message (turn-triggering on idle). Do NOT poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop." // g4-allow: 契约文案——reminder 字符串描述自动注入通道（triggerTurn 单通道，U2/D5 无 deliverAs），非实际投递调用
    : "";

  return {
    content: [{ type: "text", text }, { type: "text", text: reminder }],
    details,
  };
}

/**
 * 按 input.action 构造对应的 GuiComponent。
 * 分支判定用 discriminated key（input.action）而非独立宽类型参数——TS 自动
 * 收窄 input.domain 到对应 HandlerResult，无需 `as` 断言（与 adapter() 同款模式）。
 */
export function buildGuiComponent(
  input: AdapterInput,
  _result: SubagentToolResult,
) {
  const { action } = input;
  if (action === "start") {
    // subagent-trace 多层语义（agent名+slug+状态）用 card(stats-line) 组合表达。
    // 利用 input.domain 的身份信息，让并发 subagent 可区分。
    const d = input.domain;
    return guiComponent("card", {
      header: d.slug ? `${d.slug}` : d.subagentId.slice(0, SUBAGENT_ID_PREVIEW),
      body: [guiComponent("stats-line", {
        items: [{ value: "running", severity: "ok" }],
      })],
    });
  }
  if (action === "list") {
    const listResp = input.domain;
    return guiComponent("list-tree", {
      items: listResp.response.items.map((it) => ({
        label: it.slug ? `${it.agent} · ${it.slug} · ${it.subagentId}` : `${it.agent} · ${it.subagentId}`,
        status: mapRunStatus(it.status),
        icon: mapRunIcon(it.status),
      })),
    });
  }
  if (action === "message") {
    return guiComponent("stats-line", {
      items: [{ label: "messaged", value: input.domain.subagentId, severity: "ok" }],
    });
  }
  if (action === "fork-from") {
    return guiComponent("stats-line", {
      items: [
        { label: "forked-from", value: input.domain.sourceSessionFile },
        { label: "new subagent", value: input.domain.subagentId, severity: "ok" },
      ],
    });
  }
  if (action === "close") {
    return guiComponent("stats-line", {
      items: [{ label: "closed", value: input.domain.subagentId, severity: "warn" }],
    });
  }
  // cancel（fall-through：前四分支已 return）。
  // 穷尽检查（同 mapExternalState 的 assertNever 先例）：AdapterInput 未来新增
  // action 时，action 在此不再收窄为 "cancel"，assertNever 的 never 参数处编译
  // 报错——防止新分支静默落入 cancelled 渲染。
  if (action !== "cancel") {
    throw new Error(`buildGuiComponent: unhandled action ${assertNever(action)}`);
  }
  return guiComponent("stats-line", {
    items: [{ label: "cancelled", value: input.domain.subagentId, severity: "warn" }],
  });
}
