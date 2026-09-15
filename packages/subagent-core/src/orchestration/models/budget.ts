/**
 * Workflow Extension — Budget 值对象
 *
 * Token / cost 预算值对象（D-12）。纯数据 + 不变式守卫，无副作用。
 *
 * maxTokens===0 视为不限制（守卫，避免首个 agent 完成误判 budget_limited）。
 * （预算语义对齐 2026-08：soft-limit 常量（500 调用数预警）与 90% 阈值预警方法
 * 已删——全库无生产消费方，仅测试锁定。）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §4（字段/不变式/操作）。
 */
import type { AgentUsage } from "./types.ts";

/**
 * Budget 加权系数（token 口径）。
 *
 * usedTokens 不再是四项原始 token 简单求和，而是加权后的「等效消耗」，
 * 反映不同 token 桶的真实计费/处理开销差异：
 * - input（非缓存新增）：首次见到、需完整处理的新内容，权重 1（基准）
 * - cacheRead（命中缓存）：读取历史，开销极低，按 1/50 折算（权重 0.02）
 * - cacheWrite（首次写入缓存）：本版本不计入 budget（权重 0）
 * - output：模型自回归生成，开销最高，权重 2
 *
 * 这避免了长 session 中 cacheRead 随轮次单调累积导致 budget 被快速烧穿的失真
 * （详见讨论：cacheRead 在 N 轮里被报 N 次，去重上下文只有一份）。
 */
export const INPUT_WEIGHT = 1;
export const CACHE_READ_WEIGHT = 0.02;
export const CACHE_WRITE_WEIGHT = 0;
export const OUTPUT_WEIGHT = 2;

/**
 * Budget 值对象。
 *
 * 不变式（domain-models.md §4）：
 * - maxTokens > 0 守卫：maxTokens===0 或 undefined 视为不限制
 * - maxCost > 0 守卫：同上
 * - consume 只累加，不减；isExceeded 只读
 * - 无回调字段——所有副作用由调用方在 consume 后查询决定
 */
export class Budget {
  readonly maxTokens?: number;
  readonly maxCost?: number;
  readonly maxTimeMs?: number;
  usedTokens = 0;
  usedCost = 0;
  /** 总调用计数（持久化/诊断用；execute-agent-call 每次 dispatch 后 increment）。 */
  totalCallCount = 0;

  constructor(opts: {
    maxTokens?: number;
    maxCost?: number;
    maxTimeMs?: number;
    usedTokens?: number;
    usedCost?: number;
    totalCallCount?: number;
  } = {}) {
    this.maxTokens = opts.maxTokens;
    this.maxCost = opts.maxCost;
    this.maxTimeMs = opts.maxTimeMs;
    this.usedTokens = opts.usedTokens ?? 0;
    this.usedCost = opts.usedCost ?? 0;
    this.totalCallCount = opts.totalCallCount ?? 0;
  }

  /**
 * 累加一次 agent 调用的 usage（加权口径）。
 *
 * 四项 token 按各自权重（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT）折算后求和，
 * 而非原始 token 数直接相加。retry 间的真实消耗如实记录，避免预算被低估。
 * 详见上方权重常量的口径说明。
 */
  consume(usage: AgentUsage): void {
    // NaN 守卫——非有限值当 0 处理，防 usedTokens 变 NaN 导致 isExceeded() 永远 false（预算限制失效）
    const numOrZero = (v: number | undefined): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    this.usedTokens +=
      numOrZero(usage.input) * INPUT_WEIGHT +
      numOrZero(usage.output) * OUTPUT_WEIGHT +
      numOrZero(usage.cacheRead) * CACHE_READ_WEIGHT +
      numOrZero(usage.cacheWrite) * CACHE_WRITE_WEIGHT;
    this.usedCost += numOrZero(usage.cost);
  }

  /** 累加调用计数（每次 agent dispatch 后调用；持久化快照同步）。 */
  incrementCallCount(): void {
    this.totalCallCount += 1;
  }

  /**
 * 是否超 token / cost 预算（FR-3）。
 *
 * maxTokens===0 或 undefined 视为不限制（守卫）；
 * maxCost===0 或 undefined 视为不限制。
 * 时间预算（maxTimeMs）不由本方法判断——它是 wall-clock 约束，需参照 startedAt，
 * 由 lifecycle 层的 scheduleTimeBudget（runWorkflow 内 setTimeout）
 * 独立调度，到期 abortRun(doneReason="time_limited")。
 */
  isExceeded(): boolean {
    if (this.maxTokens !== undefined && this.maxTokens > 0 && this.usedTokens >= this.maxTokens) {
      return true;
    }
    return this.maxCost !== undefined && this.maxCost > 0 && this.usedCost >= this.maxCost;
  }

  /**
 * 剩余 token 预算。maxTokens 未设或 ≤0 时返回 undefined（视为不限制）。
 *
 * 嵌套 workflow() 调用时由 executeNestedWorkflow 消费：子 run 的 budgetTokens
 * 继承父 run 的剩余预算，实现父子预算隔离下的总量约束。
 */
  remaining(): number | undefined {
    if (this.maxTokens === undefined || this.maxTokens <= 0) return undefined;
    return Math.max(0, this.maxTokens - this.usedTokens);
  }
}
