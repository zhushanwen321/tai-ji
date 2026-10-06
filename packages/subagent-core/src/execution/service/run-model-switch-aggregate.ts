// src/execution/service/run-model-switch-aggregate.ts
//
// [subagent-model-switch U5] run 级全切聚合函数——设计 §7.4「全切『管现在』半场」+
// §7.1 聚合三组件定形 + §7.5「全切聚合」行的实装。调用方 = U2 宿主编排的 workflow
// run 级分流分支（契约 input 见 execution/assembly/types.ts RunModelSwitchAggregateInput；
// 实装签名 = RunModelSwitchAggregateCall，本文件）。
//
// 职责边界（§7.4）：对已受理成员 runId 全量逐个经引擎 setModel 转发——
//   - **不做宿主侧存活预判**：进程存活事实的权威在引擎侧，宿主 record 状态只是投影
//     （简洁审裁决，review-simplicity#1）；已退出成员由引擎 not-active 应答承接。
//   - **capability 预检门控先于调用**（§8 场景 7 步骤④）：成员引擎 setModel 位非
//     native → not-applicable，引擎调用与目标模型校验均不发生（zcode 成员即使目标
//     模型不可用也是 not-applicable）。
//   - **三态分派 + 失败名单**：switched（携带引擎回读生效值）/ not-active（引擎定位
//     不到活跃子进程）/ not-applicable（capability 不支持）；转发失败成员进失败名单
//     （分型值域 = SDK SET_MODEL_ERROR_CODES）。两数组是同一受理成员集合的互斥划分。
//   - **部分失败不回滚**：任一成员失败只进名单，其余成员结果正常返回，函数不因成员
//     失败抛异常（任务书目标 2；§6.1③）。
//   - **run 级覆盖意图写入不归聚合层**（D5 裁决 M1-2）：意图写入由调用方（U2 编排）
//     在本函数返回后统一执行（单一时序三步的步骤③）——聚合层只做转发与分派。
//
// 聚合层不做目标模型校验（canonical ref / 目录 / 凭据 / 档位预检）——公共校验步骤①
// 归 U2 宿主编排（§7.2），本函数只做转发与分派，model 原样透传；thinkingLevel 为
// run 级意图元数据（§6.4：热切档位由 pi 联动重设管辖，热切 wire 不携带档位——
// D5 裁决 M1-1），聚合层不消费。

import {
  SET_MODEL_ERROR_CODES,
  type SetModelErrorCode,
  type SetModelParams,
  type SetModelResult,
} from "@zhushanwen/subagent-engine-sdk";

import type {
  RunModelSwitchAggregateInput,
  RunSwitchAggregateResult,
  RunSwitchMemberFailure,
  RunSwitchMemberState,
} from "../assembly/types.ts";
import type { EnginePort } from "../engine/port.ts";

/**
 * setModel 转发窄接口：EnginePort + setModel 成员。
 *
 * [U3 接线对齐点] 协议第 10 个正向方法 setModel 的宿主侧 EnginePort 成员由 U3 接入
 * （core port.ts / SDK port-contract.ts 镜像同批）；本窄接口是 U5 以接口编程对齐的
 * 接收面——U3 接入后 EnginePort 自身即结构满足本接口（TS 结构类型），resolver 签名
 * 无需改动；本单元以 mock port 当波验收，真实转发联调挂 U3 commit 门补跑。
 */
export type SetModelCapableEnginePort = EnginePort & {
  setModel(params: SetModelParams): Promise<SetModelResult>;
};

/**
 * 成员引擎转发面：成员 runId → 该成员引擎的 setModel 通道（per-member 解析——混合
 * 引擎 run 的成员经 per-agent engine 字段路由到不同引擎，§8 场景 7）。宿主侧解析
 * 归调用方（U2 编排：成员 record 的 engine 留痕 + 窗口实例解析单点
 * resolveWorkflowWindowEnginePort(runId, engineId)），聚合函数不触 record 存储。
 * 解析失败（成员 record 缺失 / 引擎未注册 EngineNotFoundError 等）按转发失败归类
 * 进失败名单，不中断其余成员。
 */
export type ResolveMemberEnginePort = (memberRunId: string) => SetModelCapableEnginePort;

/**
 * 聚合调用输入 = 契约输入（assembly/types.ts RunModelSwitchAggregateInput，u-foundation
 * 定形）+ 本函数运行时必需的依赖注入面（引擎转发）。
 *
 * [u-foundation 修正通道] 契约 input 未承载引擎访问面（u-foundation runlog「形状定形
 * 裁决」第 4 条预留「U5 消费时如有出入按实际联调修正并回写本条」）；本扩展类型即该
 * 修正的落地形态——契约文件不动（任务书领地禁碰），U2 接线按本类型消费。
 */
export interface RunModelSwitchAggregateCall extends RunModelSwitchAggregateInput { // oe-exempt:20261006:framework:u-foundation 契约的修正通道注入面（契约文件领地禁碰，单实现常态）
  /** per-member 引擎转发面（见 ResolveMemberEnginePort）。 */
  resolveMemberPort: ResolveMemberEnginePort;
}

/**
 * 引擎「定位不到活跃子进程」的应答错误码（→ not-active 成员态）。
 *
 * [U3 联调对齐点] u-foundation 定形的 SET_MODEL_ERROR_CODES 三型均为「引擎定位到
 * 活跃子进程之后」的失败分型（§7.4/§7.5），不含「定位不到」形态；设计 §7.3「存活
 * 检查发现进程已退出时按无活进程形态应答宿主」要求引擎侧具备该应答形态。本常量为
 * U5 预设的识别码（词表外透传面引擎_* 前缀词法），U3 实装定名后若不同名只需对齐
 * 本常量一处（分派逻辑不变）；词表扩位时随 SET_MODEL_ERROR_CODES 同批登记。
 */
export const ENGINE_RUN_NOT_ACTIVE_CODE = "engine_run_not_active";

/** summary 退化文案（§7.1：全员非 switched 时无生效值可报，不携带档位）。 */
const SUMMARY_RECORDED_ONLY = "已记录，未派发步骤生效";

/** 单成员转发结果（并发闭包的 tagged 返回——成员态或失败名单条目）。 */
type MemberOutcome =
  | { kind: "member"; state: RunSwitchMemberState }
  | { kind: "failure"; failure: RunSwitchMemberFailure };

/**
 * run 级全切聚合（契约 input 见 assembly/types.ts RunModelSwitchAggregateInput；
 * 本实装入参 = RunModelSwitchAggregateCall = 契约 input + resolveMemberPort 依赖
 * 注入面——实装签名落点即本函数，types.ts 形状 SSOT 注释指向此处）。
 *
 * 语义（设计 §7.4，逐成员独立、受理序保序；成员转发并发扇出、结果按受理序组装
 * ——§7.1.1 出站点 60s 墙钟超时的量级匹配前提「逐成员秒级收敛窗 + 并发扇出」）：
 *   1. resolveMemberPort(runId) 解析成员引擎通道；
 *   2. capabilities().setModel 非 native → not-applicable（先于引擎调用与目标模型
 *      校验，§8 场景 7 步骤④）；
 *   3. setModel 转发成功 → switched（生效值取引擎回读应答，非请求值——同族替换时
 *      ≠ 目标意图，§6.4）；
 *   4. 转发 reject：code = ENGINE_RUN_NOT_ACTIVE_CODE → not-active；其余（三型
 *      失败分型 / 词表外透传码 / 解析失败）→ 失败名单。
 * 全部成员分派完毕后组装汇总文案（run 级覆盖意图写入归 U2 编排步骤③，见文件头）。
 */
export async function runModelSwitchAggregate(
  call: RunModelSwitchAggregateCall,
): Promise<RunSwitchAggregateResult> {
  const members: RunSwitchMemberState[] = [];
  const failures: RunSwitchMemberFailure[] = [];

  // 并发扇出（[F1-12] 串行 → 并发）：成员间无顺序依赖（逐成员独立，§7.4），串行
  // 转发使成员时延线性累加（N 成员总时延 = N × 单成员收敛窗）；每成员闭包内完整
  // try/catch，promise 理论不 reject——allSettled 防御性接住意外 reject（归失败
  // 名单，不静默丢成员——三组件恒保留语义）。
  const outcomes = await Promise.allSettled(
    call.memberRunIds.map(async (memberRunId): Promise<MemberOutcome> => {
      try {
        const port = call.resolveMemberPort(memberRunId);
        // capability 预检门控先于引擎调用与目标模型校验（§8 场景 7 步骤④）。
        if (port.capabilities().setModel !== "native") {
          return { kind: "member", state: { runId: memberRunId, state: "not-applicable" } };
        }
        const result = await port.setModel({
          runId: memberRunId,
          model: call.model,
        });
        return {
          kind: "member",
          state: {
            runId: memberRunId,
            state: "switched",
            effectiveModel: result.effectiveModel,
            effectiveThinkingLevel: result.effectiveThinkingLevel,
          },
        };
      } catch (err) {
        const code = errorCodeOf(err);
        if (code === ENGINE_RUN_NOT_ACTIVE_CODE) {
          // 引擎定位不到活跃子进程（已退出成员——含任务已完成 / 中断 / 竞态退出），
          // 覆盖走记账路径、重派时生效（§7.4 not-active；§7.5「子进程已退出」行）。
          return { kind: "member", state: { runId: memberRunId, state: "not-active" } };
        }
        return { kind: "failure", failure: { runId: memberRunId, reason: failureReasonOf(code) } };
      }
    }),
  );

  // 按受理序组装（allSettled 产物序 = 输入序，保序不受并发影响）。
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") {
      if (outcome.value.kind === "member") members.push(outcome.value.state);
      else failures.push(outcome.value.failure);
    } else {
      // 理论不可达（成员闭包全 catch）；防御性归失败名单，回读失败分型兜底。
      failures.push({ runId: call.memberRunIds[index] ?? "(unknown)", reason: failureReasonOf(undefined) });
    }
  }

  // run 级覆盖意图写入归 U2 编排步骤③（聚合返回后统一执行——本函数不持回调）。
  const switchedCount = members.filter((m) => m.state === "switched").length;
  const summary =
    switchedCount > 0
      ? `已切换 ${switchedCount}/${call.memberRunIds.length} 个成员；未派发步骤沿用目标模型`
      : SUMMARY_RECORDED_ONLY;

  return { members, failures, summary };
}

/** 错误对象的结构化 code 提取（EngineSdkError 恒带 code；普通 Error 无码返回 undefined）。 */
function errorCodeOf(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** 词表成员守卫（运行时收窄，无断言）。 */
function isSetModelErrorCode(code: string): code is SetModelErrorCode {
  return (SET_MODEL_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * 失败名单 reason 归类：三型直取；词表外透传码（engine_crashed 等 engine_* 面）原样
 * 上报——失败名单是转发失败成员的唯一诚实归属组件（not-active 会虚构存活事实、
 * 中断聚合违反「部分失败不回滚」）；类型面值域随 SDK 词表扩位收敛
 * （RunSwitchMemberFailure.reason 契约注释「词表扩位时同步跟随」），前端消费方对
 * 未知码按原文兜底显示。无码错误（非协议形态的意外 reject）按回读失败分型兜底——
 * 生效值未知是其共同事实，恢复指引「重试切换」对未知原因同样安全幂等（覆盖替换
 * 幂等，§5.2 回读失败行）。
 */
function failureReasonOf(code: string | undefined): SetModelErrorCode {
  if (code !== undefined && isSetModelErrorCode(code)) return code;
  return (code ?? "engine_state_readback_failed") as SetModelErrorCode;
}
