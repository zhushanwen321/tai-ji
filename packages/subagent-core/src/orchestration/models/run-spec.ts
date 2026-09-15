/**
 * Workflow Extension — RunSpec 值对象
 *
 * 单次 workflow run 的不可变规格（domain-models.md §2）。
 *
 * 设计：
 * - 全部字段 readonly——run 一旦创建，规格不可改（状态变化走 RunState）
 * - scriptSource 是已 strip `export const meta` 的可执行源（WorkflowScript.toExecutable）
 * - budgetTokens/budgetTimeMs 是上限（可选，未设 = 不限制）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §2。
 */

import type { Budget } from "./budget.ts";

/**
 * RunSpec——一次 workflow run 的不可变输入规格。
 *
 * 作为 RunStore 持久化的一部分（WorkflowRun.spec），崩溃恢复重水合后
 * 需要 scriptSource/args 重建 worker（G3-001）。
 */
export interface RunSpec {
 /** 已 strip export 的可执行源（WorkflowScript.toExecutable 产物）。 */
  readonly scriptSource: string;
 /**
 * 参数契约（JSON Schema draft-07，来自 script.meta.parameters 整对象透传，m3 DM2）。
 *
 * undefined = 不校验（安全退化——漏拷 parameters 退化是「不校验」非「校验错」）。
 * 由调用方（actionRun/runAndWait/executeNestedWorkflow）从 script.meta.parameters 拷贝。
 * lifecycle.runWorkflow 首行经 validateRunArgs 校验 spec.args（coerceTypes 原地规范化
 * args 对象内容，字段引用不变；worker 启动与崩溃重建共用同一对象）。
 */
  readonly parameters?: Record<string, unknown>;
  /** 调用方传入的参数（worker 内通过 $ARGS 访问）。 */
  readonly args: Record<string, unknown>;
 /**
 * Run 级 model override（Option B：经 workerData → worker global $MODEL → agent() fallback）。
 *
 * undefined = 继承主 agent 模型（零配置默认）。设置时该 run 内所有 agent() 调用默认继承
 * （除非 per-call 显式指定 model）。注意：不 merge 进 args（对称单路径注入），
 * 而是经 worker-script-builder 注入为 $MODEL worker global。
 */
  readonly model?: string;
 /**
 * Run 级 thinkingLevel override（Option B：经 workerData → worker global $THINKING_LEVEL）。
 *
 * undefined = 继承主 agent thinkingLevel。取值范围由 THINKING_ORDER SSOT 派生（含 max）。
 */
  readonly thinkingLevel?: string;
 /** Token 预算上限（未设或 0 = 不限制，见 Budget 守卫）。 */
  readonly budgetTokens?: number;
 /** 时间预算上限（ms，wall-clock，由 lifecycle.scheduleTimeBudget 调度）。 */
  readonly budgetTimeMs?: number;
 /**
 * 父 Budget 共享引用（嵌套 workflow() 时由 executeNestedWorkflow 传入）。
 *
 * 设置时 lifecycle.runWorkflow 直接复用此 Budget 实例，而非 new 一个独立 Budget——
 * 子 run 的 consume 直接反映到父 Budget，消除并行嵌套下的超支窗口（F-7 方案 B）。
 * 顶层 run 无此字段（budgetTokens 走独立 Budget 构造）。
 */
  readonly budgetRef?: Budget;
 /** 脚本名（meta.name 或文件名 stem）。 */
  readonly scriptName: string;
 /**
 * Run 级简短标签（≤20 字符），区别于 scriptName（脚本身份名）。
 * 区分同脚本的不同 run 实例（如 'migrate-users-batch1' vs 'migrate-users-batch2'）。
 * 旧持久化 run 缺失时为 undefined，渲染时回落 scriptName。
 */
  readonly slug?: string;
 /** 脚本文件绝对路径（用于诊断/日志）。 */
  readonly scriptPath: string;
 /** 人类可读描述（meta.description）。 */
  readonly description?: string;
 /**
 * 父 workflow 调用链（嵌套 workflow() 时自动填充，循环检测用）。
 *
 * 顶层 run 无此字段。子 run 的 chain = [...parentChain, parentScriptName]。
 * executeNestedWorkflow 检查目标 name 是否已在 chain 中，防止 A→B→A 死循环。
 */
  readonly parentWorkflowChain?: readonly string[];
}
