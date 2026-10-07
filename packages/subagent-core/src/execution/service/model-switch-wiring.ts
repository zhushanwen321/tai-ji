// src/execution/service/model-switch-wiring.ts
//
// [subagent-model-switch §7.2/§7.4] setModel 生产 deps 的三个通道实现（装配点 =
// subagent-service.setModel deps 闭包；实现独立成文件 = 壳装配段保持单行委托，
// 编排本体 model-switch.ts 只依赖注入面不持有装配实现）。
//
//   - assertRunNotTerminalForSwitch：run 非终局判定（§7.2 步骤①附加校验）——run
//     registry fold 终局唯一权威；
//   - listAcceptedMemberRunIdsForSwitch：已受理成员清单（§7.4 全切转发面）；
//   - resolveMemberEnginePortForSwitch：成员引擎转发面（U5 ResolveMemberEnginePort
//     生产实装）——与派发链同一裁决单点与窗口实例解析。

import type { RecordStore } from "../persistence/record-store.ts";
import { scanRunEvents } from "../persistence/run-event-journal.ts";
import { projectRunRegistryEvents } from "../../orchestration/run-registry.ts";
import type { EnginePort } from "../engine/port.ts";
import { resolveEngineRouteId } from "../engine/common/session-view-service.ts";
import { resolveWorkflowWindowEnginePort } from "../engine/routing.ts";
import { DEFAULT_ENGINE_ID } from "../engine/registry.ts";
import type { SetModelCapableEnginePort } from "./run-model-switch-aggregate.ts";

/**
 * run 级全切的成员清单扫描上限（collectRecordsByParentRunId 的 limit 位）。一个 run
 * 的成员数 = 已派发步骤数（脚本内 agent() 调用），量级远低于此值；取宽裕上限防极端
 * 长 run 被截断漏切——截断漏掉的成员收不到覆盖转发且不进聚合应答（静默漏切，违背
 * 全切语义）。
 */
export const MODEL_SWITCH_MEMBER_LIST_LIMIT = 500;

/**
 * workflow run 非终局检查（§7.2 步骤①附加校验——终局 fail-fast，§7.5「run 已终局」
 * 行）。终局判法 = run 事件流 fold 唯一权威（run-registry 投影——record fold 无第二
 * 判据可分叉，run-registry.ts 头注释）；phase=terminal 即拒绝，interrupted（可
 * resume）/ missing 放行。磁盘扫描 IO → async，编排层步骤① await（写入前拦截）。
 */
export async function assertRunNotTerminalForSwitch(runId: string): Promise<void> {
  const events = await scanRunEvents(runId);
  const projection = projectRunRegistryEvents(events, runId);
  if (projection.phase !== "terminal") return;
  throw new Error(
    `workflow run 已终局（${projection.state.outcome ?? "settled"}），无后续步骤可应用模型覆盖，` +
      `不可切换（runId=${runId}）`,
  );
}

/**
 * run 级已受理成员 runId 全量清单（§7.4 全切转发面）：collectRecordsByParentRunId
 * 四源合并（内存 ∪ 磁盘重建 ∪ entry ∪ manifest）——全状态不过滤，「已受理」判据 =
 * 成员 record 已创建（P9 异步窗口内的调用已有 record）；**不做宿主侧存活预判**（进程
 * 存活事实的权威在引擎侧，宿主 record 状态只是投影——已退出成员由引擎 not-active
 * 应答承接，§7.4）。rootSessionFilter 口径与 queries.collectRecordsByParentRunId
 * 一致（sessionRootId → sessionId → undefined 兜底，会话隔离红线）。
 */
export function listAcceptedMemberRunIdsForSwitch(
  store: Pick<RecordStore, "collectRecordsByParentRunId">,
  rootSessionFilter: string | undefined,
  runId: string,
): string[] {
  return store
    .collectRecordsByParentRunId(runId, MODEL_SWITCH_MEMBER_LIST_LIMIT, rootSessionFilter)
    .map((r) => r.id);
}

/**
 * 成员引擎转发面（U5 ResolveMemberEnginePort 生产实装）：成员 record 引擎留痕 →
 * 与派发链同一裁决单点（resolveEngineRouteId）+ 同一窗口实例解析——pi 成员窗口键
 * = parentRunId（与 routeWorkflowEngine 的 piEngine 注入同源，run-orchestration
 * resolveChatEnginePort 窗口感知形态）；非 pi 成员走 resolveWorkflowWindowEnginePort
 * （shared-service 引擎透传 registry）。切换命中的进程与派发进程同源。
 *
 * 三源查找（D3 缺陷五）：getMutable（内存）→ findLightById（文件扫描）→
 * findByIdManifestFallback（manifest 兜底——zcode 成员无子 session 文件不在扫描集、
 * settle 后出内存，bound 物化的 manifest 是其磁盘唯一载体；缺兜底 = 无码 plain Error
 * 误入聚合失败名单分型 readback 失败）。
 *
 * 解析失败（成员 record 三源全 miss / parentRunId 留痕缺失）throw → 聚合归失败名单，
 * 不中断其余成员（run-model-switch-aggregate 契约）。capability not-applicable 判定
 * **不在此拦**——聚合层预检先于引擎调用（§8 场景 7 步骤④），unsupported 引擎成员
 * 必须到达预检落 not-applicable（拦在这里会错位进失败名单）；仅对「native 位 +
 * setModel 方法缺席」的装配损坏 fail-fast（native 位与方法同源条件实装，该组合
 * 只能是集成 bug，归失败名单）。返回断言的安全面即本守卫：非 native 引擎的
 * setModel 永不被聚合调用（预检分支先行）。
 */
export function resolveMemberEnginePortForSwitch(
  store: Pick<RecordStore, "getMutable" | "findLightById" | "findByIdManifestFallback">,
  resolveChatEnginePort: (windowKey?: string) => EnginePort,
  memberRunId: string,
): SetModelCapableEnginePort {
  const record =
    store.getMutable(memberRunId) ??
    store.findLightById(memberRunId) ??
    store.findByIdManifestFallback(memberRunId);
  if (record === undefined) {
    throw new Error(`workflow 成员 record 不存在，无法转发模型切换（memberRunId=${memberRunId}）`);
  }
  const parentRunId = record.parentRunId;
  if (parentRunId === undefined) {
    throw new Error(
      `workflow 成员 record 缺少 parentRunId 留痕，无法解析引擎窗口（memberRunId=${memberRunId}）`,
    );
  }
  const engineId = resolveEngineRouteId(record, record.id);
  const port =
    engineId === DEFAULT_ENGINE_ID
      ? resolveChatEnginePort(parentRunId)
      : resolveWorkflowWindowEnginePort(parentRunId, engineId);
  if (port.capabilities().setModel === "native" && typeof port.setModel !== "function") {
    throw new Error(
      `engine '${engineId}' declares capabilities.setModel=native but exposes no ` +
        `setModel method (memberRunId=${memberRunId}) — integration bug, report this`,
    );
  }
  return port as SetModelCapableEnginePort;
}
