// fan-out.js — N 个已知独立任务并行派发 + 全量收集（通用 subagent 编排）
//
// 模式：tasks 成员对象数组逐条派 agent()（parallel() allSettled——任一成员死亡/失败
// 不阻断其余成员、不阻断 run 收尾）→ 全量收集 → 可选 aggregate（末尾追加一个 agent()
// 把全部结果归约成一份结论）。aggregate 缺省 false = 纯收集。
//
// 与 parallel 的分工：parallel 是「多视角分析同一目标」（单一目标转译成视角 prompt）；
// fan-out 是「N 条完整自包含任务直接派发」（tasks 每个成员 = 一条可直接派发的 task
// prompt + 可选成员级 agent/model/thinkingLevel，不加转译包装）。
//
// 成员级配置：成员对象的 agent（执行者 .md 绝对路径）/ model / thinkingLevel 是成员级
// 覆盖，未指定字段不进 agent() 调用——留给 run 级 $MODEL / $THINKING_LEVEL 继承
// （worker-script-builder 的 agent() 对象分支：opts 显式值优先，缺省回落 run 级）。
// description 固定 "fan-out-" + i——它是成员复用身份键（同 run 内同名在途会拒绝或
// 续写为同一身份），不承载显示语义；改值会破坏 resume 回放与成员唯一性。
//
// 结果归因权威：results[].taskIndex 由本模板按派发序（$ARGS.tasks 下标）赋值，
// results[].task 文本同样以 $ARGS.tasks 为权威源——成员输出 schema 不含 taskIndex
// 字段，成员无从错报；「只重派失败任务」的归因不因成员输出错位而错杀。
//
// 用法：
//   workflow run fan-out --args 'tasks=[{"task":"任务一","agent":"/path/a.md"},{"task":"任务二"}]'（pi 宿主语法）
//   zsw workflow --workflow fan-out --workdir <绝对路径>（zsw 宿主直参语法；per-workflow
//   参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
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
# thinkingLevel enum 与运行级白名单 THINKING_ORDER 同源（subagent-core src/shared/model-ref.ts；
# worker 模板 eval 环境无法 import TS，此处字面量须手动同步；fan-out-script.test.ts 解析本
# meta 块的 enum 值集与 THINKING_ORDER 动态对拍，漂移即红）
parameters:
  type: object
  additionalProperties: false
  properties:
    tasks:
      type: array
      minItems: 1
      maxItems: 20
      items:
        type: object
        additionalProperties: false
        required: [task]
        properties:
          task: { type: string, minLength: 1 }
          agent: { type: string, pattern: "^/" }
          model: { type: string }
          thinkingLevel: { type: string, enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }
    aggregate: { type: boolean, default: false }
  required: [tasks]
usage: |
  ## 使用说明
  - tasks 每个元素 = 一个成员对象：task 必填（完整自包含、可直接派发的任务描述），可选 agent（成员级执行者 .md 绝对路径，pattern ^/）/ model / thinkingLevel（成员级覆盖）；全部任务并行执行，结果一次性收齐
  - 成员未指定的 agent/model/thinkingLevel 留空继承 run 级默认；经 subagents 工具调用时工具层会自动把运行级 agent 填进未指定的成员
  - 任一成员失败不阻断其余成员：部分失败收尾 status=partial（失败条目带 taskIndex/error），只重派失败 taskIndex 对应的成员即可，勿全批重跑
  - aggregate=true 时末尾追加一个聚合 agent，把全部结果归约成一份结论（缺省 false 纯收集）
  - 每个成员输出 summary（数百字内，通知内联展示）+ 可选 fullReportPath（完整产物落盘路径）；结果总量超预算时按序截断并置 truncated 标记（taskIndex/status/路径恒完整）
  - 示例（pi 宿主语法）：workflow run fan-out --args 'tasks=[{"task":"统计 src 下 ts 文件数","agent":"/path/counting-agent.md"},{"task":"统计 src 下 md 文件数"}]'
  - 示例（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际以注入段 node "<绝对路径>/bin/zsw.js" 形态为准）：zsw workflow --workflow fan-out --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
const tasks = $ARGS.tasks;
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('fan-out: tasks is required (non-empty array of member objects). Correct: {"tasks":[{"task":"task one"},{"task":"task two"}]}');
}
// 旧格式迁移指引（成员对象化之前：tasks 字符串数组 / 顶层 agents 键）——与 scriptPath
// 旧格式专属文案同构：命名旧形状、给迁移映射（agents 逗号串 → 逐成员 agent）与恢复
// 动作（按旧 tasks 内容重派成员对象新 run）。纵深兜底覆盖绕过 validateRunArgs/ajv 的
// 直参宿主形态（zsw 直参等）；pi 宿主标准路径在 ajv 层已被拒并拿到同款迁移文案
// （args-validator legacyArgsAdvisory），两处文案同构。
const legacyStringTasks = tasks.some((t) => typeof t === "string");
const legacyAgentsKey = $ARGS.agents !== undefined;
if (legacyStringTasks || legacyAgentsKey) {
  throw new Error(
    "fan-out: legacy args shape detected (" +
      [
        ...(legacyStringTasks ? ['tasks elements are plain strings'] : []),
        ...(legacyAgentsKey ? ['top-level "agents" key present'] : []),
      ].join("; ") +
      ") — this shape predates the member-object parameter format and is no longer accepted. " +
      "Migration: one member object per task (task required; agent/model/thinkingLevel optional per-member overrides; " +
      'a legacy agents="/a.md,/b.md" maps to agent on each member in the same order). ' +
      "Recovery: re-dispatch a NEW run with member-object tasks. " +
      'Correct: {"tasks":[{"task":"task one","agent":"/a/one.md"},{"task":"task two"}]}',
  );
}
// 成员对象校验（validateRunArgs/ajv 类型校验之后的纵深）：task 必填且非空白——schema
// minLength 不拦空白字符串，入口 trim 检查补上；其余成员字段按 ajv 已校验类型采信
if (tasks.some((m) => m === null || typeof m !== "object" || typeof m.task !== "string" || m.task.trim() === "")) {
  throw new Error('fan-out: tasks elements must be objects with a non-blank "task" string. ' +
    'Correct: {"tasks":[{"task":"task one","agent":"/a/one.md","model":"provider/model","thinkingLevel":"high"}]}');
}

// scriptPath 锚定检查（worker 宿主契约的显式前提，D1 加固）：workerData.scriptPath 是
// 本脚本真实路径的唯一定位点，也是 resume 重建的锚——缺席或为空串即 fail-fast
// （空串 = record 流为 scriptPath 载荷落地前的旧格式，resume 重建无锚可恢复），
// 不回退 cwd——消除从用户目录误加载代码的路径侧。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string" || workerData.scriptPath === "") {
  if (workerData && typeof workerData.scriptPath === "string") {
    throw new Error("fan-out: core_module_load_failed: workerData.scriptPath is an empty string (record stream predates the scriptPath field); resume rebuild has no anchor for this run. " +
      "Recovery: re-run the workflow (runs recorded before the field existed cannot be resumed).");
  }
  throw new Error("fan-out: core_module_load_failed: workerData.scriptPath is missing. " +
    "Recovery: the worker host (WorkerHost) must inject scriptPath via workerData when launching the worker " +
    "(the real path of this script; injection point: the workerData assembly in src/orchestration/worker-host.ts). " +
    "Never rely on process.cwd() coincidence.");
}

// 成员级覆盖展开：字段存在且为非空字符串才进 agent() 调用，未指定字段不写 key——
// 留给 run 级 $MODEL / $THINKING_LEVEL 继承（worker-script-builder agent() 对象分支：
// opts 显式值优先，缺省回落 run 级）
const memberOverride = (member, key) => {
  const v = member[key];
  return typeof v === "string" && v !== "" ? { [key]: v } : {};
};

log("fan-out 开始，tasks=" + tasks.length);

// ── 段 1：fan-out（并行派发 + 全量收集）──────────────────────────
phase("fan-out");

// parallel() 接受 Promise 数组；agent() 返回 Promise。allSettled 语义：
// 成员死亡（SIGTERM/引擎崩溃）降级为 {status:"failed", error} 条目，不炸整批
const rawResults = await parallel(
  tasks.map((member, i) =>
    agent({
      prompt: member.task,
      schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "结果摘要（数百字内），通知内联展示" },
          fullReportPath: { type: "string", description: "可选：完整产物的落盘路径（报告类任务建议写入文件）" },
        },
        required: ["summary"],
      },
      description: "fan-out-" + i,
      ...memberOverride(member, "agent"),
      ...memberOverride(member, "model"),
      ...memberOverride(member, "thinkingLevel"),
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
      task: tasks[i].task,
      taskIndex: i,
      status: "failed",
      error: r ? (r.error || "agent 返回 failed 状态") : "agent 无返回",
    });
    failedCount++;
  } else {
    results.push({
      task: tasks[i].task,
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

// ── 段 2：aggregate（可选归约 + 收尾定稿）────────────────────────
phase("aggregate");

let aggregateOut;
if ($ARGS.aggregate === true) {
  // 聚合成员不指定 agent（缺省执行者，review-fix-loop aggregator 同惯例——
  // 「归约者归谁」无歧义解，聚合是通用归并工作）
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
    // 归约成员失败不炸 run（对齐成员失败语义）：已收集的 results 照常收尾
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
// taskIndex/status/fullReportPath/error（归因与恢复侧）恒完整，summary（体积大头）
// 先让出、task 文本次之；截断发生置 outcome 顶层 truncated: true
const RESULTS_BUDGET_CHARS = 8000;

/** 单条映射：keepTask=false 丢 task 文本、keepSummary=false 丢 summary；
 *  taskIndex/status/fullReportPath/error（归因与恢复侧，D9）恒完整。
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
// partial 收尾提示只重派失败 taskIndex 对应的成员（§3.3.5 一次恢复查询 + 局部重派纪律）
outcome.message = "fan-out 完成：" + tasks.length + " 任务（失败 " + failedCount + "）" +
  (failedCount > 0 ? "；只重派失败 taskIndex 对应的成员，勿全批重跑" : "") +
  (aggregateOut !== undefined ? " → 已归约" : "");

return outcome;
