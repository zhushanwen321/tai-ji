// 协议契约类型双向可赋值断言（W2 挂靠，impl-plan §2.1「core 侧双向可赋值断言」）。
//
// SDK 契约类型（@zhushanwen/subagent-engine-sdk，SSOT）与 core 中立类型是结构等价
// 闭包——任一侧字段漂移（字段缺失 / 可选性漂移 / 联合分支不齐）在本文件编译期报错。
// 运行时无逻辑；`const _assert: true = <expr>` 形态让断言结果进入类型检查。
//
// UiRequest / UiResponse / UiRequestHandler / UiMethod 的 core 侧出口 =
// execution/dialog-queue.ts 的 SDK 再导出（W7 已切换，SSOT = SDK ui-types）——
// 本断言的 Core* 别名现在与 Sdk* 同源，保留断言形态防未来回退为本地定义后漂移。
// [H1 U5/U6] InteractAction / InteractResult 断言对已随 chat 域 interact 面退役删除。

import { describe, expect, it } from "vitest";

import type {
  AssertMutuallyAssignable,
  AgentEvent as SdkAgentEvent,
  AgentCallOpts as SdkAgentCallOpts,
  AgentOutcome as SdkAgentOutcome,
  EngineCapabilities as SdkEngineCapabilities,
  EngineHandleData as SdkEngineHandleData,
  ProbeReport as SdkProbeReport,
  SessionView as SdkSessionView,
  UiRequest as SdkUiRequest,
  UiRequestHandler as SdkUiRequestHandler,
  UiResponse as SdkUiResponse,
  UiMethod as SdkUiMethod,
  WorktreeHandle as SdkWorktreeHandle,
} from "@zhushanwen/subagent-engine-sdk";

import type { AgentCallOpts as CoreAgentCallOpts } from "../../../../orchestration/models/types.ts";
import type {
  AgentEvent as CoreAgentEvent,
  WorktreeHandle as CoreWorktreeHandle,
} from "../../../types.ts";
import type {
  AgentOutcome as CoreAgentOutcome,
  EngineCapabilities as CoreEngineCapabilities,
  EngineHandleData as CoreEngineHandleData,
  ProbeReport as CoreProbeReport,
  SessionView as CoreSessionView,
} from "../../types.ts";
import type {
  UiMethod as CoreUiMethod,
  UiRequest as CoreUiRequest,
  UiRequestHandler as CoreUiRequestHandler,
  UiResponse as CoreUiResponse,
} from "../../../dialog-queue.ts";

// ── 引擎面契约类型（SDK SSOT ↔ core execution/engine/types.ts）──
type _CoreSdkAgentEvent = AssertMutuallyAssignable<CoreAgentEvent, SdkAgentEvent>;
type _CoreSdkAgentOutcome = AssertMutuallyAssignable<CoreAgentOutcome, SdkAgentOutcome>;
type _CoreSdkEngineCapabilities = AssertMutuallyAssignable<CoreEngineCapabilities, SdkEngineCapabilities>;
type _CoreSdkEngineHandleData = AssertMutuallyAssignable<CoreEngineHandleData, SdkEngineHandleData>;
type _CoreSdkProbeReport = AssertMutuallyAssignable<CoreProbeReport, SdkProbeReport>;
type _CoreSdkSessionView = AssertMutuallyAssignable<CoreSessionView, SdkSessionView>;
type _CoreSdkWorktreeHandle = AssertMutuallyAssignable<CoreWorktreeHandle, SdkWorktreeHandle>;

// ── Ui 请求契约三类型 + UiMethod（SDK ui-types ↔ core dialog-queue）──
type _CoreSdkUiRequest = AssertMutuallyAssignable<CoreUiRequest, SdkUiRequest>;
type _CoreSdkUiResponse = AssertMutuallyAssignable<CoreUiResponse, SdkUiResponse>;
type _CoreSdkUiRequestHandler = AssertMutuallyAssignable<CoreUiRequestHandler, SdkUiRequestHandler>;
type _CoreSdkUiMethod = AssertMutuallyAssignable<CoreUiMethod, SdkUiMethod>;

// ── AgentCallOpts：SDK 版是 core 版的引擎面子集（结构互赋——core 多出的宿主自持
//    可选字段不影响赋值方向；worktree 的 WorktreeHandle 结构副本经上行断言互证）──
type _CoreSdkAgentCallOpts = AssertMutuallyAssignable<CoreAgentCallOpts, SdkAgentCallOpts>;

const _assertions: Array<true> = [
  true as _CoreSdkAgentEvent,
  true as _CoreSdkAgentOutcome,
  true as _CoreSdkEngineCapabilities,
  true as _CoreSdkEngineHandleData,
  true as _CoreSdkProbeReport,
  true as _CoreSdkSessionView,
  true as _CoreSdkWorktreeHandle,
  true as _CoreSdkUiRequest,
  true as _CoreSdkUiResponse,
  true as _CoreSdkUiRequestHandler,
  true as _CoreSdkUiMethod,
  true as _CoreSdkAgentCallOpts,
];

describe("协议契约类型双向可赋值（编译期断言的运行时锚）", () => {
  it("全部断言成立（漂移会在 tsc --noEmit 报 never → 本文件编译失败）", () => {
    expect(_assertions).toHaveLength(12);
    expect(_assertions.every((v) => v === true)).toBe(true);
  });
});
