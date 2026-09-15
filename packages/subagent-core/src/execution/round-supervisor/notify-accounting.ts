// src/execution/round-supervisor/notify-accounting.ts
//
// [W4] 通知对账——送决策指引前查替代的两级启发式（纯函数）。
//
// 设计权威源：docs/design/chat-domain-v1x-liveness-governance.md §3.2 D2「通知对账」
// （R3 增补、R4 钉死判定语义）。
//
// 背景：主 agent 是唯一决策者，重派不被禁止——即使合并单条通知，它仍可能在收到
// 指引前合法地重派了新任务。record 数据模型不存在重派关联字段（parentRecordId 是
// 层级语义、rootSessionId 是 session 隔离语义、task 是完整 prompt 非关联键），
// 对账判定为显式定义的两级启发式：
//  - 高置信替代：同 rootSessionId + 同 agent 名 + 同 slug（≤35 字符短标签，重派
//    同任务大概率同 slug）+ 决策指引看门狗窗内新建 → 撤销指引，改送「原任务已被
//    新任务替代」终止通知 + 对原 record 走该放弃路径（终态化 + 注销）；
//  - 低置信（仅 agent 同名）：不撤销指引，但指引内容自带豁免声明（「若你已重新
//    派发或不再需要此任务，忽略本指引；原任务将在看门狗到期后自动终止」）。
//
// 两失败方向登记（设计四要素）：
//  - 漏判（重派改写 slug/task 致高置信不命中）→ 残余双执行；重审触发 = 实测双执行
//    反馈 ≥1 例 → 升级「supersedes 显式引用」方案；
//  - 误判（无关任务撞 slug）→ 原任务被错误终态化——危害轻（原任务本已无进程驱动，
//    仅损失 resume 可能）。

/** 对账候选（重派承接任务的 record 投影面）。 */
export interface ReplacementCandidate {
  id: string;
  rootSessionId: string | undefined;
  /** agent 类型名（record.agent）。 */
  agentName: string;
  /** 人类短标签（record.slug，≤35 字符）。 */
  slug: string;
  /** 创建时刻（record.startedAt，ms）。 */
  startedAt: number;
}

/** 被接管 record 的对账基准面。 */
export interface ReplacementProbeSubject {
  id: string;
  rootSessionId: string | undefined;
  agentName: string;
  slug: string;
}

/** 对账结论（两级 + 无命中）。 */
export type ReplacementVerdict =
  | { kind: "high-confidence"; replacementId: string }
  | { kind: "low-confidence" }
  | { kind: "none" };

/**
 * 高置信判定窗口：候选的 startedAt 必须落在「决策指引看门狗窗」内（接管时刻起
 * 算——窗内新建才有「承接了同一任务」的置信；窗外的同名任务与本接管无时序关联）。
 * 窗值由调用方传（= 监督器决策看门狗窗，同源常量）。
 */
export function classifyReplacement(
  subject: ReplacementProbeSubject,
  candidates: readonly ReplacementCandidate[],
  windowMs: number,
  now: number,
): ReplacementVerdict {
  let sameAgentOnly = false;
  for (const candidate of candidates) {
    if (candidate.id === subject.id) continue;
    if (candidate.agentName !== subject.agentName) continue;
    // 时序窗（高/低置信共同的门）：窗内新建才参与对账——窗外的同名任务与本接管
    // 无时序关联（预先存在的同名任务不是替代者）。
    if (now - candidate.startedAt > windowMs) continue;
    // [契约锚] sameRoot 在生产装配下恒真——此检查是对供给侧不变量的防御性复认，
    // 不是独立生效的第四要素。生产候选源 = supervisor.deps.listCandidateRecords
    // （service-binding.ts supervisorCandidates 已按 getSessionRootId() 预过滤，
    // 循环内候选恒同 root）。约束力悄悄依赖该供给不变量：若换候选源为未按 root
    // 预过滤的全量集，sameRoot 从恒真退化为真实约束——跨 root 命中会从
    // high-confidence 降为 low-confidence（替代收口弱化：原任务改由看门狗到期才
    // 放弃），行为静默漂移。换候选源必须保「root 预过滤」或显式重审本判定语义。
    const sameRoot =
      candidate.rootSessionId !== undefined &&
      candidate.rootSessionId === subject.rootSessionId;
    const sameSlug =
      subject.slug !== "" &&
      candidate.slug === subject.slug;
    if (sameRoot && sameSlug) {
      return { kind: "high-confidence", replacementId: candidate.id };
    }
    sameAgentOnly = true;
  }
  return sameAgentOnly ? { kind: "low-confidence" } : { kind: "none" };
}
