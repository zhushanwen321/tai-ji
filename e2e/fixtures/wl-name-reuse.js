// wl-name-reuse.js — 成员复用验收模板（batch-window-reuse-recovery.spec.ts A8/V8 配套 fixture）
//
// 同一 run 内同名 agent()（description 同为 "solo-worker"）顺序两次调用：复用键
// name = description ?? agent（决策 4/10）——第二次调用应命中 member-reuse-pool、
// revive 既有成员 record 续写（同 record 多轮），而非新建第二个成员。
//
// ⚠️ lintScript 约束：含 await agent() 顶层序列，禁止 bare IIFE

/* @pi-meta
name: wl-name-reuse
description: 验收模板：同名 agent() 两次调用，验证成员复用池命中与 revive 续写
when: 仅 e2e 成员复用验收（batch-window-reuse-recovery spec）使用
notFor: 生产编排（同名复用是引擎语义，生产模板不需要专门验证）
phases: ["reuse"]
parameters:
  type: object
  properties:
    firstTask: { type: string }
    secondTask: { type: string }
  required: [firstTask, secondTask]
*/

if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("wl-name-reuse: workerData.scriptPath is missing (worker host contract)");
}

phase("reuse");

const mk = (prompt) => agent({
  prompt,
  description: "solo-worker",
  schema: {
    type: "object",
    properties: { summary: { type: "string", description: "结果摘要" } },
    required: ["summary"],
  },
});

const r1 = await mk($ARGS.firstTask);
const r2 = await mk($ARGS.secondTask);

return {
  r1Failed: Boolean(r1 && r1.error),
  r1Error: r1 ? r1.error : "no-return",
  r1SessionId: r1 ? r1.sessionId : undefined,
  r2Failed: Boolean(r2 && r2.error),
  r2Error: r2 ? r2.error : "no-return",
  r2SessionId: r2 ? r2.sessionId : undefined,
  r2Summary: r2 ? r2.summary : undefined,
};
