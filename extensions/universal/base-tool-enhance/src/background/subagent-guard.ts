/**
 * subagent 进程识别（D14 降级判据）。
 *
 * 判据收敛于 ext-guards isSubagentProcess（`XYZ_AGENT_SUBAGENT === "1"`——引擎
 * spawn 链恒注入的统一标记，ext-simplify-17 D4 重锚定）。命中 = 当前 pi 进程是
 * 引擎链上的真 subagent → 本扩展降级：background:true 被忽略走前台同步语义。
 *
 * [HISTORICAL] 旧判据查 PI_SUBAGENT_* 身份键两枚（任一存在即命中）——引擎协议化
 * 后该键族无写入方，判据失效态（降级实际从未生效），20260914 真机探针双断言证实
 * 后随 D4 重锚。现行事实与口径详见 ext-guards isSubagentProcess JSDoc、设计
 * docs/architecture/ext-simplify-17-shared-extraction.md §3.1 D4、探针报告
 * .tmp/dev-flow/ext-simplify-17-d4-probe.md。
 *
 * 为什么降级：子 agent 内后台化会破坏 workflow 结构化输出契约（预算耗尽时测试未
 * 回）；且子进程死后其 registry 目录永远不会再有 session 启动，孤儿无人 reap。
 */
export { isSubagentProcess } from "@zhushanwen/pi-ext-guards";
