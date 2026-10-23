/**
 * Workflow Extension — Engine 共享类型（re-export 壳）
 *
 * 权威定义已下沉 shared/agent-call-types.ts（D1 反向依赖收编决策一：跨层契约类型
 * 归最低层，execution 侧直连 shared，不再反向依赖本层）。本壳只转发、不复制声明
 * （零镜像），保 orchestration 内部消费方、barrel 与外部包深导入路径
 * （@zhushanwen/subagent-core/orchestration/models/types.ts）零改动；
 * 壳存续依赖外部包深导入消费方，删除前置条件 = 先迁移外部消费方。
 */

export * from "../../shared/agent-call-types.ts";

// [D1 Class A] SLUG_MAX_LENGTH 权威在 shared/run-vocabulary.ts（同目录，无需二次
// 导出下沉）；本壳保留同款再导出行——barrel 与外部扩展（subagent-tool-schema）经
// 该行取值，壳保留则其导入路径零改动。
export { SLUG_MAX_LENGTH } from "../../shared/run-vocabulary.ts";
