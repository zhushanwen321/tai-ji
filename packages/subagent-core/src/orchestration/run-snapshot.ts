// src/orchestration/run-snapshot.ts
//
// workflow-state/<runId>.jsonl 快照行的格式版本常量（唯一权威定义点）。
//
// 版本值 = "wf-run-v2"：盘上存量行与各读侧守卫都锚定该字面量，第二份定义即
// 静默漂移。消费方 = runtime workflow-extractor 的版本守卫（经 subagent-core
// barrel 单源 import）——[D1] record 单源存储收敛后快照写入面已删（新 run 唯一
// 持久件 = record 事件流 <runId>.record.jsonl），本常量仅服务历史 run 存量快照行
// 的 v1 冻结兼容读判定（[D16②]：W17~W1 期间创建的历史 run，不再新增事件、不可
// resume，跟随裁决点 7 清理消亡）；快照行的形状校验与字段消费在读取方自有实现
// （extractor 本地 RunSnapshot 接口），不内聚进本模块。快照格式不再演化（无
// 写入方即无 bump 场景）。
//

/**
 * 快照格式版本（字符串相等比较，无大小序）。
 *
 * 版本历史：
 * - wf-run-v1：status 三态（含 paused）、meta 含 pausedAt（pi 旧格式，读路径拒绝）。
 * - wf-run-v2（当前）：status 两态（running/done）、meta 无 pausedAt。
 *
 * additive 字段策略（历史快照行的读侧兼容口径）：v2 基线上的可选字段
 * （calls[].startedAt / lastProgressAt / phase、state.health / outcome /
 * errorCode）不 bump 版本——bump 会让 extractor 版本守卫把存量历史 run 快照整条
 * 跳过（历史 run 从 UI 消失），故走「纯 additive 读」：旧读侧对新字段天然跳过
 * （未知字段容忍），旧快照对新读侧缺字段按缺省渲染（消费侧 lastProgressAt 缺 →
 * 时长槽省略、health 缺 → unknown）。这些字段在快照写侧存续期由事件 journal
 * fold 派生（权威在事件流——「快照 + 事件流双写时快照必然漂移」D5 是快照写入面
 * 删除的裁决依据；写入面删除后该推导关系仅作为历史快照行的字段语义说明）。
 */
export const SNAPSHOT_VERSION = "wf-run-v2" as const;
