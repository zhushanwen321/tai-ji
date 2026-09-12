// src/execution/subprocess-agent-runner.ts
//
// [H2 W4] SAR 壳归位（设计 subagent-workflow-record-unification.md §5 W4）：
// run() 掏空为纯转调 SubagentService.executeWorkflowAgent——编排权（路由/预检/
// journal/守护/spawned-children/池）彻底归 service 单点（W2 executeWorkflowAgent
// 八步迁移承接），本类不再自持任何编排。历史形态（Wave 4 委托重写 → P4 路由 →
// M3 no-progress 守护落点）随本次掏空退役，行为守护由 workflow-agent-dispatch
// 测试族（service 落点）承接。
//
// 保留壳的原因（设计 v3 定形）：唯一装配点 session-lifecycle.ts（D-008 per-session
// SAR 构造）与 index.ts 的 model_select → updateCtxModel 刷新链零改动——掏空只删
// run() 内部编排，构造签名与公共面不变。
//
// ctxModel dep 保留在构造签名（装配点兼容），但 run() 不再消费——model 解析归
// service resolveIdentity（W2 迁移清单⑧：ctxModel 孪生守卫放弃迁移，不双轨）。

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { SubagentStream } from "./stream-sink.ts";
import type { SubagentService } from "./subagent-service.ts";

/**
 * SAR 直调（无 workflow run 上下文）时的 parentRunId 占位——record 仍带
 * origin:"workflow" 进 store，但不隶属任何 run（views 按真实 runId 查询
 * collectRecordsByParentRunId 天然不中；治理通道 `subagents action:'list'
 * includeWorkflow:true` 仍可查）。
 *
 * 生产链路 pump 恒经 workflowAgentDispatch 注入（闭包携带真实 run.runId），
 * 本占位仅在 SAR.run 被直接调用的场景出现（生产不可达；测试直调）。
 */
export const SAR_UNATTACHED_PARENT_RUN_ID = "sar-unattached";

/** SAR 构造参数（签名冻结——session-lifecycle.ts 装配点零改动）。 */
export interface SubprocessAgentRunnerDeps {
  subagentService: SubagentService;
  /** 兼容保留：run() 不消费（model 解析归 service resolveIdentity）。 */
  ctxModel?: ModelInfo;
}

/**
 * AgentRunner port 实现——纯转调 SubagentService.executeWorkflowAgent。
 *
 * 层归属：execution。implements orchestration 层 port。
 *
 * 契约：
 *   - opts 形状不变（AgentCallOpts，含 resolveAgentOpts 填的 skillPath/schemaEnv）
 *   - result 形状不变（AgentResult——executeWorkflowAgent 返回类型即 orchestration
 *     AgentResult，零映射）
 *   - 路由失败/预检命中/嵌套超限经 service 同步抛错（§3.4 同步抛错回脚本 + D3
 *     路由先于 record 创建的构造性推论：不产生孤儿 record）——传播形态与
 *     workflowAgentDispatch 注入路径一致（dispatch 闭包同样不吞错），pump 侧
 *     dispatchCall catch 兜底回发。
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private ctxModel: ModelInfo | undefined;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
  }

  /**
   * 刷新主 agent model 缓存（model_select 事件时由 extension index.ts 调用）。
   *
   * [H2 W4] run() 不再消费 ctxModel（model 解析归 service resolveIdentity），
   * 本方法保留仅为装配链兼容（index.ts 调用不炸）；字段更新不再影响执行路径。
   */
  updateCtxModel(model: ModelInfo | undefined): void {
    this.ctxModel = model;
  }

  /** 纯转调 service 统一编排入口（形参原样透传；parentRunId 用直调占位）。 */
  async run(
    opts: AgentCallOpts,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    return this.subagentService.executeWorkflowAgent(
      opts,
      SAR_UNATTACHED_PARENT_RUN_ID,
      signal,
      onEvent,
      stream,
    );
  }
}

// [H2 W2 迁移步⑥] mergeRunSignals/MergedRunSignalHandle 公共 helper 权威落点在
// engine/common/run-signals.ts；此处 re-export 保持既有 import 路径（no-progress
// killall 测试等消费面零改动）。
export { mergeRunSignals, type MergedRunSignalHandle } from "./engine/common/run-signals.ts";
