// src/execution/round-supervisor/domain.ts
//
// [W4] 轮次活性监督器——域分类与 record 级判据谓词（单一权威源）。
//
// 设计权威源：docs/design/chat-domain-v1x-liveness-governance.md §3.2 D2 前置 1
// （轮次域分类）+ 前置 2（record 去向单一裁决表）+ 三态判定表。
//
// [modeless 波1·判据去模式] 判定域 = 全部 running record（保守多管不漏）：轮终
// idle（有 result）豁免、在途 run / 活进程「该等」——原 chatMode 豁免分支随字段
// 消亡删除（旧豁免域 = 轮终 idle 机制 + settled-watchdog 两段守护管辖；modeless 下
// one-shot 与 chat 形态合流，判据按「万物可续」统一）。豁免域仅剩「轮终 idle 有
// result」（hasResult 子句）。
//
// 判据状态源钉死为 record 级（R3 核正）：pi 引擎 poolKey 恒 'shared' 单进程、
// ensureConnected 被动重建会重填「镜像整体置死」——镜像不能作持续判据；run 终态
// failed 即「驱动死亡」的证据，不随引擎进程重建翻转。镜像置死仅作死亡事件的
// 触发信号（supervisor 的死亡事件纳管入口），不作持续判据。
//
// 纳管模型（R3 显式化）：死亡事件纳管（run failed / 引擎 exited 事件把 record 纳入
// 监督域），**重建不解管**（引擎进程重建不解除已纳管 record 的监督，监督器按
// record 级状态持续判定直至终态或放弃）。本文件的谓词全部只读 record 级状态，
// 不读引擎镜像——结构性保证「重建不解管」（模拟引擎重建后监督器仍按 record 级判）。

import type { ExecutionRecord } from "../assembly/types.ts";

/** 监督器域分类（判定域先收窄，再谈三态）。 */
export type SupervisorDomain =
  /** run 域 record（[modeless 波1] 全 record——chatMode 豁免域随字段消亡删除，
   *  判据按「万物可续」统一保守多管）。监督域主体。 */
  | "run"
  /**
   * [H2 W2] workflow 脚本 agent() record（origin="workflow"）——adopt 链豁免域：
   * 引擎死亡即 run 失败即 record 终态化（service 分诊两处豁免），无脚本可回的
   * resumable 等待无意义（adopt 链「唤醒→guidance→2h 看门狗→giveUp」全程死路，
   * 还制造 2h 挂账）。豁免只覆盖 adopt 接管入口（adoptOnProcessDeath / boot 分区
   * 重认领）——运行期记账（noteRunStarted/noteRunEnded）与 reconcile-sweep 对账
   * 对 workflow record 照旧。
   */
  | "workflow";

/**
 * 域分类。record.origin === "workflow" → workflow（adopt 链豁免域，[H2 W2]）；
 * 否则 → run 域（[modeless 波1] conversation 豁免域随 chatMode 消亡删除）。
 * （workflow run 不在 RecordStore，其注册对账按 type=workflow
 * 保守跳过，见 reconcile-sweep.ts。）
 */
export function classifySupervisorDomain(
  record: Pick<ExecutionRecord, "origin">,
): SupervisorDomain {
  if (record.origin === "workflow") return "workflow";
  return "run";
}

/**
 * 三态判定「该唤醒」的 record 级判据（[modeless 波1·判据去模式] chatMode 子句
 * 删除后的单一全子集谓词：**`running && !hasResult && !hasInFlightRun &&
 * !hasLiveProcess`**——统一管全部 running record，保守多管不漏；豁免域仅
 * 「轮终 idle 有 result」。W4 死亡纳管态（running + 无产出 + 无在飞 run + 无活
 * 进程）识别不依赖形态枚举。
 *
 * 入参解耦说明：谓词只消费 record 级状态与三个布尔（已有产出 / 在途 run / 活进程
 * 句柄），由调用方（supervisor）供给——「有在途 run」来自 supervisor 的在途记账
 *（subagent-service 报告），「有进程驱动」来自生命周期镜像谓词，「已有产出」来自
 * 视图投影 hasResult。本函数不读镜像/引擎状态，结构性满足「镜像置死只作触发信号
 * 不作持续判据」。
 */
export function isAwakeWarrantedShape(
  record: { status: string },
  hasResult: boolean,
  hasInFlightRun: boolean,
  hasLiveProcess: boolean,
): boolean {
  if (record.status !== "running") return false; // 终态 = 已收口
  // 已有完成产出（轮终 idle 挂账归 idle-gc）→ 不唤醒；该等（有驱动）→
  // 不干预；无驱动的 running + 无产出 = W4 死亡纳管态 → 唤醒。
  if (hasResult) return false;
  return !hasInFlightRun && !hasLiveProcess;
}
