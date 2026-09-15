// [H3/R6] SubagentService 域常量 SSOT（零依赖叶子文件）。
//
// 落点决策（impl-plan §2 R6 允许 service-bootstrap.ts 或独立常量文件，实施取独立
// 文件）：常量消费方含四个聚合 + 壳，若并入 service-bootstrap.ts 会制造
// 「聚合 → bootstrap → 壳（SubagentService 值边）→ 聚合」三节点模块环（运行时虽
// 延迟求值安全，但违背依赖方向清晰性）；常量域（数据叶子）与 bootstrap 域（类型
// 声明 + 装配工厂）变化轴正交，独立成零 import 叶子文件后守卫方向规则无需特判。
//
// 归一来源（两笔偏差债 R6 兑现）：
//   - D-R4-4：PRIORITY_BACKGROUND / MS_PER_SECOND / SECONDS_PER_MINUTE 原在
//     run-orchestration.ts 与 workflow-dispatch.ts 各自重复声明（R4 预授权零 import
//     约束下的值语义纯量），本单元归一。
//   - D-R3-2：ENV_SELF_RECORD_ID 原声明在 session-baselines.ts，record-access.ts
//     的单向 import 登记为 R5 守卫台账合法边①，本单元归位后该边删除。

/** background 优先级（保留 priority 排序机制，单一值）。 */
export const PRIORITY_BACKGROUND = 1000;

/** 时间换算常数（settled watchdog 分钟数展示用；与 session-runner 同名常量同语义）。 */
export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;

/** 子进程自身 record id 的跨进程身份贯穿 env 名（父进程 spawn 子进程时注入，子进程
 *  initSession / recoverOrphansIfRootProcess 读取）。env 族机制全貌与兄弟常量
 *  （ENV_ROOT_SESSION_ID / ENV_DEPTH / ENV_ROOT_CWD，消费主体在聚合内）见
 *  session-baselines.ts。 */
export const ENV_SELF_RECORD_ID = "PI_SUBAGENT_SELF_RECORD_ID";
