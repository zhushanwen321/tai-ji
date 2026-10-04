// wl-seq-two.js — 窗口生命周期验收模板（batch-window-reuse-recovery.spec.ts A6/V6 配套 fixture）
//
// 顺序两次 agent()：第一条在飞期被外部 kill 薄壳进程（剧本注入）→ 收 engine_crashed
// 合成 error outcome（既有路径）；第二条应 respawn 新薄壳继续完成（设计 D7 保留语义：
// 崩溃不放大为整个 run 失败）。失败以 AgentResult{error} resolve 不 throw（worker
// postAgentResult 形态），模板防御式双收（try/catch 兜 throw 形态）。
//
// ⚠️ lintScript 约束：含 await agent() 顶层序列，禁止 bare IIFE

/* @pi-meta
name: wl-seq-two
description: 验收模板：顺序两条 agent()，第一条可被外部 kill 注入打崩，第二条验证薄壳 respawn 自愈
when: 仅 e2e 窗口生命周期验收（batch-window-reuse-recovery spec）使用
notFor: 生产编排（生产顺序依赖用 chain）
phases: ["seq"]
parameters:
  type: object
  properties:
    firstTask: { type: string }
    secondTask: { type: string }
  required: [firstTask, secondTask]
*/

if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("wl-seq-two: workerData.scriptPath is missing (worker host contract)");
}

phase("seq");

// 两条不同名（seq-worker-1/2）：同名会命中成员复用池 revive 通道（决策 10），
// 污染本模板要测的引擎崩溃 respawn 场景（A6）——不同名 = 各建成员，纯崩溃自愈链。
const mk = (prompt, name) => agent({
  prompt,
  description: name,
  schema: {
    type: "object",
    properties: { summary: { type: "string", description: "结果摘要" } },
    required: ["summary"],
  },
});

let r1 = null;
let r1Throw = undefined;
try {
  r1 = await mk($ARGS.firstTask, "seq-worker-1");
} catch (e) {
  r1Throw = String((e && e.message) || e);
}

let r2 = null;
let r2Throw = undefined;
try {
  r2 = await mk($ARGS.secondTask, "seq-worker-2");
} catch (e) {
  r2Throw = String((e && e.message) || e);
}

return {
  r1Failed: Boolean(r1Throw) || Boolean(r1 && r1.error),
  r1Error: r1Throw ?? (r1 ? r1.error : "no-return"),
  r2Failed: Boolean(r2Throw) || Boolean(r2 && r2.error),
  r2Error: r2Throw ?? (r2 ? r2.error : "no-return"),
  r2Summary: r2 ? r2.summary : undefined,
};
