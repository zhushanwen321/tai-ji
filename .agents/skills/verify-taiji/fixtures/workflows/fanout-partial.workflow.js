/* @pi-meta
name: fanout-partial
description: verify-taiji 场景 2 用 fan-out（双成员，脚本 allSettled 吸收成员失败正常收尾）
phases: ["fan-out"]
parameters:
  type: object
  properties:
    tasks: { type: array, items: { type: string }, minItems: 1 }
    models: { type: array, items: { type: string } }
  required: [tasks]
*/
// p0-workflow-partial-and-notify-edge 段 1 专用 workflow 脚本（fanout-canary 同构改形）：
// 双成员 fan-out，脚本用显式 Promise.allSettled 吸收成员失败后正常收尾。
//
// 双成员按 $ARGS.models 逐成员指定模型（AgentCallOpts.model，缺省回落引擎缺省）——
// 两个成员各走独立 model 队列（mock server 游标 per-model），结构性消除「共享游标
// 交错消费」的竞态（剧本侧要求的确定性失败注入依赖这一点）：
//   - 成功成员（mockllm/mock-sub-a）：队列 [structured-output 步, stop 收尾步]——
//     成员轮成败只产自引擎收尾边沿（pi-subagent-cli output-collector.ts collectOutcome），
//     SO 调用之后引擎还会继续请求，必须再给一个 stopReason:'stop' 步让引擎干净停
//     （engineStopReason=stop → delivered）；全是 toolUse 步的队列会让成员一直消费到
//     队列耗尽 404，收尾边沿=错误 → 成员被判 failed（parsedOutput 已产出也一样）。
//   - 失败成员（mockllm/mock-sub-b）：空队列——首请求即命中「剧本耗尽」HTTP 404
//     （真实 provider 错误形态），成员轮失败，FailureCause 分类落 provider.protocol_unsupported。
//
// run 终局 outcome 由成员交付结算派生（一 delivered + 一 failed → partially_succeeded），
// 与脚本返回值无关；显式 Promise.allSettled 是让「脚本吞掉成员失败正常收尾」的语义
// 在夹具里自明（B1 之后 agent() 失败不再 reject，allSettled 属纵深防御）。
const tasks = $ARGS.tasks;
const models = Array.isArray($ARGS.models) ? $ARGS.models : [];
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('fanout-partial: tasks is required (non-empty string array)');
}
phase("fan-out");
const settled = await Promise.allSettled(
  tasks.map((task, i) =>
    agent({
      prompt: task,
      schema: {
        type: "object",
        properties: { summary: { type: "string", description: "结果摘要" } },
        required: ["summary"],
      },
      ...(models[i] ? { model: models[i] } : {}),
      description: "partial-" + i,
    }),
  ),
);
// 返回值只承载观察摘要（截断防体积膨胀）；run 终局 outcome 的权威源是成员交付结算
// 派生（run.state.calls），不是本返回值。
return {
  settled: settled.map((r, i) => {
    if (r.status === "rejected") {
      return { taskIndex: i, status: "rejected", reason: String(r.reason).slice(0, 200) };
    }
    const v = r.value;
    const summary =
      v !== null && typeof v === "object" && typeof v.summary === "string"
        ? v.summary
        : String(v ?? "").slice(0, 200);
    return { taskIndex: i, status: "fulfilled", summary };
  }),
};
