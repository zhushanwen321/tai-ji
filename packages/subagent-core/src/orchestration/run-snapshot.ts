// src/orchestration/run-snapshot.ts
// [W2 剥离留档 | dwfq-f81a7c55-2] D2 词表删 ask-executing 的编译连带，属 V1 领地，主 agent 恢复补提交。

//
// workflow-state/<runId>.jsonl 快照行的格式版本常量（唯一权威定义点）。
//
// 版本值 = "wf-run-v2"：盘上存量行与各读侧守卫都锚定该字面量，第二份定义即
// 静默漂移。消费方 = runtime workflow-extractor 版本守卫（经 subagent-core
// barrel 单源 import）；快照行的形状校验与字段消费在读取方自有实现
// （extractor 本地 RunSnapshot 接口），不内聚进本模块。
//

/**
 * 快照格式版本（字符串相等比较，无大小序）。
 *
 * 版本历史：
 * - wf-run-v1：status 三态（含 paused）、meta 含 pausedAt（pi 旧格式，读路径拒绝）。
 * - wf-run-v2（当前）：status 两态（running/done）、meta 无 pausedAt。
 *
 * [P3/D6] additive 字段策略：v2 基线上的可选字段（calls[].startedAt /
 * lastProgressAt / phase、state.health / outcome / errorCode）**不 bump 版本**——
 * bump 会让 extractor 版本守卫把存量历史 run 快照整条跳过（历史 run 从 UI
 * 消失，D6 明示代价），故走「纯 additive 读」：旧读侧对新字段天然跳过（未知
 * 字段容忍），旧快照对新读侧缺字段按缺省渲染（消费侧 lastProgressAt 缺 →
 * 时长槽省略、health 缺 → unknown）。这些字段由事件 journal fold 派生（权威
 * 在事件流，不在快照写侧维护——「快照 + 事件流双写时快照必然漂移」D5）。
 * 未来真需格式重构 bump 时，须显式登记「升级后历史 run 从 UI 消失」代价与
 * 迁移方案。
 *
 * 升级格式时 bump 此常量——旧版本快照被读侧版本守卫拒绝（runtime
 * workflow-extractor warn 跳过；pi 侧对 v1 存量行静默），跳过可见性由读取方
 * 自决。
 */
export const SNAPSHOT_VERSION = "wf-run-v2" as const;
