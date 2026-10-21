/* @pi-meta
name: fanout-canary
description: verify-taiji mock-http 探针用最小 fan-out（N 路并行，各返回一个 canary 摘要）
phases: ["fan-out"]
parameters:
  type: object
  properties:
    tasks: { type: array, items: { type: string }, minItems: 1 }
  required: [tasks]
*/
// 探针专用 workflow 脚本（最小可行）：只做 parallel() fan-out + 纯收集，不设 aggregate。
// 为什么成员必须回调 structured-output：workflow 模式下 structured-output 被重设计为
// 单参数合成工具（parameters 即权威 schema），成员不在终局调用它 = schema_deterministic 失败。
const tasks = $ARGS.tasks;
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('fanout-canary: tasks is required (non-empty string array)');
}
phase("fan-out");
const results = await parallel(
  tasks.map((task, i) =>
    agent({
      prompt: task,
      schema: {
        type: "object",
        properties: { summary: { type: "string", description: "结果摘要" } },
        required: ["summary"],
      },
      description: "canary-" + i,
    }),
  ),
);
return { results };
