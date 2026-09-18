// fan-out.js — N 个已知独立任务并行派发 + 全量收集（通用 subagent 编排）
//
// 模式：tasks 数组逐条派 agent()（parallel() allSettled——任一成员死亡/失败不阻断
// 其余成员、不阻断 run 收口）→ 全量收集 → 可选 aggregate（末尾追加一个 agent() 把
// 全部结果归约成一份结论）。aggregate 缺省 false = 纯收集。
//
// 与 parallel 的分工：parallel 是「多视角分析同一目标」（单一目标转译成视角 prompt）；
// fan-out 是「N 条完整自包含任务直接派发」（tasks 每个元素 = 一条可直接派发的 task
// prompt，不加转译包装）。
//
// agents 数量契约（有意与 parallel 的静默 fallback 不同）：agents 解析后 >1 条时必须
// 与 tasks 数量一一对应，否则脚本入口 fail-fast——数量错配时静默换 persona 会让失败
// 归因失真（错误信息带 Correct 示例）。
//
// 结果归因权威：results[].taskIndex 由本模板按派发序（$ARGS.tasks 下标）赋值，
// results[].task 文本同样以 $ARGS.tasks 为权威源——成员输出 schema 不含 taskIndex
// 字段，成员无从错报；「只重派失败任务」的归因不因成员输出错位而错杀。
//
// 用法：
//   workflow run fan-out --args 'tasks=["任务一","任务二"]' agents="/path/a.md"（pi 宿主语法）
//   zsw workflow --workflow fan-out --workdir <绝对路径>（zsw 宿主直参语法；per-workflow
//   参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为数组）
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE

/* @pi-meta
name: fan-out
description: 通用编排：N 个已知独立任务并行派发并全量收集，可选把全部结果归约成一份结论
when: N 个相互独立的任务需要一次派发并行执行并收齐全部结果
notFor: 任务间有依赖顺序，或多视角分析同一目标
# phase 名带引号：checkPhaseConsistency 的声明提取只认带引号字符串（unquoted 形态
# 会误报 "called but not in meta.phases" warning——parallel.js 等既有模板受此局限）
phases: ["fan-out", "aggregate"]
parameters:
  type: object
  properties:
    tasks: { type: array, items: { type: string }, minItems: 1 }
    agents: { type: string }
    aggregate: { type: boolean, default: false }
  required: [tasks]
usage: |
  ## 使用说明
  - tasks 每个元素 = 一条完整自包含、可直接派发的任务描述；全部任务并行执行，结果一次性收齐
  - 任一成员失败不阻断其余成员：部分失败收口 status=partial（失败条目带 error），只重派失败任务即可
  - agents：逗号分隔的 agent .md 绝对路径；1 个应用于全部任务，N 个与任务一一对应；数量 >1 且不等于任务数时入口 fail-fast（与 parallel 的静默 fallback 不同，防失败归因失真）
  - aggregate=true 时末尾追加一个聚合 agent，把全部结果归约成一份结论（缺省 false 纯收集）
  - 每个成员输出 summary（数百字内，通知内联展示）+ 可选 fullReportPath（完整产物落盘路径）；结果总量超预算时按序截断并置 truncated 标记（taskIndex/status/路径恒完整）
  - 示例（pi 宿主语法）：workflow run fan-out --args 'tasks=["统计 src 下 ts 文件数","统计 src 下 md 文件数"]' agents="/path/counting-agent.md"
  - 示例（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际以注入段 node "<绝对路径>/bin/zsw.js" 形态为准）：zsw workflow --workflow fan-out --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为数组）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
const tasks = $ARGS.tasks;
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('fan-out: tasks is required (non-empty string array). Correct: {"tasks":["task one","task two"]}');
}
if (tasks.some((t) => typeof t !== "string" || t.trim() === "")) {
  throw new Error('fan-out: tasks must be a non-empty string array (got a non-string or blank element). Correct: {"tasks":["task one","task two"]}');
}

// S4 路径统一：agents 参数 = 逗号分隔的 agentRef 路径数组（_shared/agent-refs.cjs 共享解析）；
// 1 个 = 所有任务，N 个 = 与 tasks 一一对应，缺省 = 不指定 agent（默认执行者）
// worker 沙箱为 eval 模式：require 相对路径以 cwd 为基准（非脚本目录），
// 必须用 workerData.scriptPath 锚定脚本目录（parallel/review-fix-loop 同模式）；
// scriptPath 注入是 worker 契约的显式前提（D1 加固），缺席即 fail-fast，
// 不回退 cwd——消除从用户目录误加载/被植入同名 _shared/agent-refs.cjs 的代码加载面。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string") {
  throw new Error("fan-out: core_module_load_failed: workerData.scriptPath is missing; cannot locate workflows/_shared/agent-refs.cjs. " +
    "Recovery: the worker host (WorkerHost) must inject scriptPath via workerData when launching the worker " +
    "(the real path of this script; injection point: the workerData assembly in src/orchestration/worker-host.ts). " +
    "Never rely on process.cwd() coincidence.");
}
const SCRIPT_DIR = require("path").dirname(workerData.scriptPath);
const { parseAgentRefs, agentRefAt } = require(SCRIPT_DIR + "/_shared/agent-refs.cjs");
const agentRefs = parseAgentRefs($ARGS.agents);

// agents 数量 fail-fast（D9 错误规格）：与 parallel 的静默 fallback 有意不同——
// 数量错配说明模型对「每路不同执行者」的意图与任务集不对齐，静默换 persona 会让
// 失败归因失真；fail-fast 让模型对齐数量后重派
if (agentRefs.length > 1 && agentRefs.length !== tasks.length) {
  throw new Error("fan-out: agents must have 1 entry or exactly tasks.length=" + tasks.length +
    " entries, got " + agentRefs.length +
    '. Correct: agents="/a/one-reviewer.md" (one agent for all tasks) ' +
    'or agents="/a/first.md,/b/second.md,/c/third.md" (one per task, same order as tasks)');
}
const agentFor = (i) => {
  if (agentRefs.length === 1) return { agent: agentRefs[0] };
  const ref = agentRefAt(agentRefs, i);
  return ref ? { agent: ref } : {};
};

log("fan-out 开始，tasks=" + tasks.length + (agentRefs.length ? " agents=" + agentRefs.join(",") : ""));

// ── 段 1：fan-out（并行派发 + 全量收集）──────────────────────────
phase("fan-out");

// parallel() 接受 Promise 数组；agent() 返回 Promise。allSettled 语义：
// 成员死亡（SIGTERM/引擎崩溃）降级为 {status:"failed", error} 条目，不炸整批
const rawResults = await parallel(
  tasks.map((task, i) =>
    agent({
      prompt: task,
      schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "结果摘要（数百字内），通知内联展示" },
          fullReportPath: { type: "string", description: "可选：完整产物的落盘路径（报告类任务建议写入文件）" },
        },
        required: ["summary"],
      },
      description: "fan-out-" + i,
      ...agentFor(i),
    }),
  ),
);

// 收集结果：taskIndex/task 以 $ARGS.tasks（派发序）为权威源，不采信成员自报
const results = [];
let failedCount = 0;
for (let i = 0; i < rawResults.length; i++) {
  const r = rawResults[i];
  if (!r || r.status === "failed" || r.error) {
    results.push({
      task: tasks[i],
      taskIndex: i,
      status: "failed",
      error: r ? (r.error || "agent 返回 failed 状态") : "agent 无返回",
    });
    failedCount++;
  } else {
    results.push({
      task: tasks[i],
      taskIndex: i,
      status: "ok",
      summary: typeof r.summary === "string" ? r.summary : undefined,
      fullReportPath: typeof r.fullReportPath === "string" ? r.fullReportPath : undefined,
    });
  }
}
if (failedCount === tasks.length) {
  // 全部成员失败 → run failed（终态通知带 NOT task completion 指引，D9）
  throw new Error("fan-out: all tasks failed (" + failedCount + "/" + tasks.length + ")");
}
log("fan-out 收集完成：ok=" + (tasks.length - failedCount) + " failed=" + failedCount);

// ── 段 2：aggregate（可选归约 + 收口定稿）────────────────────────
phase("aggregate");

let aggregateOut;
if ($ARGS.aggregate === true) {
  // 聚合成员不指定 agent（缺省执行者，review-fix-loop aggregator 同惯例——
  // N 个一一对应时「归约者归谁」无歧义解，聚合是通用归并工作）
  try {
    const agg = await agent({
      prompt:
        "以下是 " + tasks.length + " 个并行任务的全部结果（JSON，task=任务描述，summary=该任务结果摘要，" +
        "fullReportPath=完整报告路径）。请综合全部结果归约成一份结论：关键发现、共识与分歧、后续建议。conclusion 数百字内。\n\n" +
        JSON.stringify(results),
      schema: {
        type: "object",
        properties: {
          conclusion: { type: "string", description: "全部任务结果的归约结论（数百字内）" },
        },
        required: ["conclusion"],
      },
      description: "fan-out-aggregate",
    });
    aggregateOut = agg && typeof agg.conclusion === "string" ? agg.conclusion : undefined;
    if (aggregateOut === undefined) {
      aggregateOut = { error: "aggregate agent 返回缺 conclusion 字段" };
    }
  } catch (err) {
    // 归约成员失败不炸 run（对齐成员失败语义）：已收集的 results 照常收口
    const msg = err && err.message ? err.message : String(err);
    aggregateOut = { error: msg };
    log("fan-out aggregate 失败：" + msg);
  }
}
const aggregateFailed = aggregateOut !== undefined &&
  typeof aggregateOut !== "string" &&
  typeof aggregateOut.error === "string";

// ── 通知体积：results 序列化前保序截断（D5）─────────────────────
// 壳侧 MAX_RESULT_LENGTH 机制在 helpers.ts（通知序列化预算）；模板侧只做保序截断：
// taskIndex/status/fullReportPath/error（归因与恢复面）恒完整，summary（体积大头）
// 先让出、task 文本次之；截断发生置 outcome 顶层 truncated: true
const RESULTS_BUDGET_CHARS = 8000;

/** 单条投影：keepTask=false 丢 task 文本、keepSummary=false 丢 summary；
 *  taskIndex/status/fullReportPath/error（归因与恢复面，D9）恒完整。
 *  task 用 delete 而非不写 key，保持与最小条目形态相同的 key 插入顺序。 */
function projectEntry(r, keepTask, keepSummary) {
  const entry = { task: r.task, taskIndex: r.taskIndex, status: r.status };
  if (keepSummary && typeof r.summary === "string") entry.summary = r.summary;
  if (typeof r.fullReportPath === "string") entry.fullReportPath = r.fullReportPath;
  if (r.error !== undefined) entry.error = r.error;
  if (!keepTask) delete entry.task;
  return entry;
}

// 保序降级阶梯：预算耗尽时先丢 summary（体积大头），仍超再让出 task 文本
const FIT_LADDER = [[true, true], [true, false], [false, false]];

function fitResultsInBudget(items) {
  if (JSON.stringify(items).length <= RESULTS_BUDGET_CHARS) {
    return { results: items, truncated: false };
  }
  const fitted = [];
  let used = 2; // "[]" 边界
  for (const r of items) {
    let entry;
    for (const [keepTask, keepSummary] of FIT_LADDER) {
      entry = projectEntry(r, keepTask, keepSummary);
      if (used + JSON.stringify(entry).length + 1 <= RESULTS_BUDGET_CHARS) break;
    }
    used += JSON.stringify(entry).length + 1;
    fitted.push(entry);
  }
  return { results: fitted, truncated: true };
}

const fitted = fitResultsInBudget(results);

const outcome = {
  status: failedCount > 0 || aggregateFailed ? "partial" : "ok",
  results: fitted.results,
};
if (aggregateOut !== undefined) {
  outcome.aggregate = aggregateOut;
}
if (fitted.truncated) {
  outcome.truncated = true;
}
outcome.message = "fan-out 完成：" + tasks.length + " 任务（失败 " + failedCount + "）" +
  (aggregateOut !== undefined ? " → 已归约" : "");

return outcome;
