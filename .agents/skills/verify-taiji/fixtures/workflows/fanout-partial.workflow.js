/* @pi-meta
name: fanout-partial
description: verify-taiji 场景 2 用 fan-out（双成员，脚本 allSettled 吸收成员失败正常收尾）
phases: ["fan-out"]
parameters:
  type: object
  properties:
    tasks: { type: array, items: { type: string }, minItems: 1 }
  required: [tasks]
*/
// p0-workflow-partial-and-notify-edge 段 1 专用 workflow 脚本（fanout-canary 同构改形）：
// 双成员 fan-out，脚本用显式 Promise.allSettled 吸收成员失败后正常收尾。
//
// 为什么成员必须终局调用 structured-output：workflow 模式下 structured-output 被重设计为
// 单参数合成工具（parameters 即权威 schema），成员不在终局调用它 = 交付失败。
// 本剧本的失败注入机制 = 成员队列首步是「无 structured-output 调用的文本轮」——
// 抢到该步的成员以 agent.no_deliverable 失败（§3.3.1 第 0 波③ F-1 退役后的诚实失败分类），
// 另一成员拿到 structured-output 步正常交付；run 终局 outcome 由成员交付结算派生为
// partially_succeeded（§3.3.8 第五值），与脚本返回值无关。
//
// 为什么显式 allSettled 而不是 parallel()：parallel() 内部本就是 allSettled 语义
// （B1 之后 agent() 失败不再 reject，失败降级为错误内容 resolve）——这里写显式
// Promise.allSettled 是为了让「脚本吞掉成员失败正常收尾」的语义在夹具里自明，
// 不依赖 parallel 的内部归一化细节。
const tasks = $ARGS.tasks;
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
