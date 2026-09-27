// wl-zcode-two.js — zcode shared-service 回归验收模板（batch-zcode-shared-lifecycle.spec.ts A4/A7 配套 fixture）
//
// 两条不同名 agent()（engine 显式 "zcode"，各跑一段 bash sleep）：shared-service
// 形态下两任务应共用同一常驻 app-server 进程（懒加载单例），任务间进程不退；
// 顺序 await 保证剧本可在「r1 在飞 / r2 在飞」两个时点分别采样进程 pid 做同 pid
// 断言。不同名避开成员复用池（本模板测进程形态，不测复用）。
//
// ⚠️ lintScript 约束：含 await agent() 顶层序列，禁止 bare IIFE

/* @pi-meta
name: wl-zcode-two
description: 验收模板：zcode 引擎两条 agent() 顺序执行，验证 shared-service 单例进程跨任务恒定
when: 仅 e2e zcode 形态回归验收（batch-zcode-shared-lifecycle spec）使用
notFor: 生产编排
phases: ["zc"]
parameters:
  type: object
  properties:
    firstTask: { type: string }
    secondTask: { type: string }
  required: [firstTask, secondTask]
*/

if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("wl-zcode-two: workerData.scriptPath is missing (worker host contract)");
}

phase("zc");

const mk = (prompt, name) => agent({
  prompt,
  description: name,
  engine: "zcode",
  schema: {
    type: "object",
    properties: { summary: { type: "string", description: "结果摘要" } },
    required: ["summary"],
  },
});

const r1 = await mk($ARGS.firstTask, "zc-worker-1");
const r2 = await mk($ARGS.secondTask, "zc-worker-2");

return {
  r1Failed: Boolean(r1 && r1.error),
  r1Error: r1 ? r1.error : "no-return",
  r2Failed: Boolean(r2 && r2.error),
  r2Error: r2 ? r2.error : "no-return",
};
