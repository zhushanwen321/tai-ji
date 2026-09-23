// fan-out.js workflow 脚本行为契约直测（u1-fanout-template，设计 D4/D5/D9）。
//
// 测试方法（同 review-fix-loop-script.test.ts 先例）：fan-out.js 是 pi worker 模板
// 脚本——顶层执行 + 顶层 return，不可作为 ES module import。用 node -e「AsyncFunction
// 包装 + 真实子进程」跑整脚本副本：注入 fake agent / parallel / phase / log 与真实
// require（_shared/agent-refs.cjs 经 workerData.scriptPath 锚定真实加载）。探针无
// 文件系统副作用（fan-out 不落盘），读原路径即可。
//
// fake parallel 复刻 worker-script-builder.ts parallel() 的结果归一化语义
// （fulfilled 对象透传 / fulfilled 非对象→failed / rejected→failed），使「成员死亡走
// allSettled failed 分支」断言对齐真实 worker 行为，而非测试自造契约。
//
// 回归锚点（断言在违背契约的旧实现上会红）：
//   - D9 agents 数量错配 fail-fast（对照 parallel 的静默 fallback 被有意排除）
//   - D4 taskIndex 按派发序赋值（$ARGS.tasks 为权威源，成员无从错报）
//   - D4/G2 部分失败 partial 收口；全员失败 throw（run failed）
//   - D5 通知体积保序截断（truncated 标记 + taskIndex/status 恒完整）
//   - D4 aggregate 可选归约（末尾一个 agent()；归约失败不炸 run）
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "workflows");
const FANOUT_PATH = join(WORKFLOWS_DIR, "fan-out.js");
const FANOUT_SOURCE = readFileSync(FANOUT_PATH, "utf8");

const run = promisify(execFile);

interface ExecFailure extends Error {
  code?: number | string;
  stderr?: string;
}

function isExecFailure(e: unknown): e is ExecFailure {
  return e instanceof Error;
}

/** fake agent 行为表（JSON 可序列化，内联进探针）。 */
interface AgentBehavior {
  /** 每个成功成员的 summary 字符串（默认短摘要） */
  summaryOf?: string;
  /** 这些派发序下标的成员失败 */
  failIndexes?: number[];
  /** 失败形态：reject（成员死亡/崩溃）或 resolve-string（非对象结果→failed） */
  failMode?: "reject" | "resolve-string";
  /** aggregate 成员行为：ok / reject / none（不派 aggregate） */
  aggregate?: "ok" | "reject" | "none";
}

interface AgentCallRecord {
  description?: string;
  prompt?: string;
  agent?: string;
  schema?: { required?: string[]; properties?: Record<string, unknown> };
}

interface ProbeResult {
  outcome: {
    status: string;
    results: Array<{
      task?: string;
      taskIndex: number;
      status: string;
      summary?: string;
      fullReportPath?: string;
      error?: string;
    }>;
    aggregate?: unknown;
    truncated?: boolean;
    message?: string;
  };
  agentCalls: AgentCallRecord[];
  logs: string[];
}

/** 生成 node -e 探针：AsyncFunction 复刻 worker 模板宿主形态。 */
function probeCode(argsJson: string, behaviorJson: string): string {
  return [
    "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
    "const src = require('fs').readFileSync(" + JSON.stringify(FANOUT_PATH) + ", 'utf8');",
    "const runner = new AsyncFunction('workerData', '$ARGS', 'agent', 'parallel', 'phase', 'log', 'require', src + '\\n');",
    "const workerData = { scriptPath: " + JSON.stringify(FANOUT_PATH) + " };",
    "const $ARGS = " + argsJson + ";",
    "const behavior = " + behaviorJson + ";",
    "const agentCalls = [];",
    "function fakeAgent(opts) {",
    "  agentCalls.push(opts);",
    "  const m = /^fan-out-(\\d+)$/.exec(opts.description || '');",
    "  const idx = m ? Number(m[1]) : -1;",
    "  if (idx >= 0) {",
    "    if ((behavior.failIndexes || []).indexOf(idx) >= 0) {",
    "      if (behavior.failMode === 'resolve-string') return Promise.resolve('plain error text ' + idx);",
    "      return Promise.reject(new Error('boom-' + idx));",
    "    }",
    "    return Promise.resolve({ summary: behavior.summaryOf || ('summary-' + idx), fullReportPath: '/tmp/fanout-report-' + idx + '.md' });",
    "  }",
    "  if (opts.description === 'fan-out-aggregate') {",
    "    if (behavior.aggregate === 'reject') return Promise.reject(new Error('agg-boom'));",
    "    return Promise.resolve({ conclusion: 'conclusion-text' });",
    "  }",
    "  return Promise.resolve({ summary: 'misc' });",
    "}",
    // parallel 归一化语义复刻（worker-script-builder.ts parallel() 的三分支）
    "async function fakeParallel(calls) {",
    "  const settled = await Promise.allSettled(calls.map((c) => (c && typeof c.then === 'function') ? c : fakeAgent(c)));",
    "  return settled.map((r) => {",
    "    if (r.status === 'fulfilled') {",
    "      const v = r.value;",
    "      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {",
    "        if (typeof v.error === 'string' && v.error.length > 0) return { status: 'failed', error: v.error };",
    "        return v;",
    "      }",
    "      return { status: 'failed', error: 'agent returned non-object result (type=' + typeof v + ')' };",
    "    }",
    "    const reason = r.reason;",
    "    return { status: 'failed', error: reason instanceof Error ? reason.message : String(reason) };",
    "  });",
    "}",
    "const logs = [];",
    "runner(workerData, $ARGS, fakeAgent, fakeParallel, function () {}, function (msg) { logs.push(String(msg)); }, require)",
    "  .then((outcome) => {",
    "    process.stdout.write('PROBE_RESULT:' + JSON.stringify({ outcome, agentCalls, logs }) + '\\n');",
    "  })",
    "  .catch((e) => {",
    "    process.stderr.write('PROBE_THROW:' + String((e && e.message) || e) + '\\n');",
    "    process.exit(1);",
    "  });",
  ].join("\n");
}

async function runProbe(args: unknown, behavior: AgentBehavior): Promise<ProbeResult> {
  const r = await run(process.execPath, ["-e", probeCode(JSON.stringify(args), JSON.stringify(behavior))], {
    timeout: 30_000,
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT:"));
  if (!line) throw new Error("probe produced no PROBE_RESULT line; stdout=" + r.stdout);
  return JSON.parse(line.slice("PROBE_RESULT:".length)) as ProbeResult;
}

async function runProbeExpectThrow(args: unknown, behavior: AgentBehavior): Promise<string> {
  const outcome = await run(process.execPath, ["-e", probeCode(JSON.stringify(args), JSON.stringify(behavior))], {
    timeout: 30_000,
  }).then(
    (): ExecFailure | null => null,
    (e: unknown): ExecFailure | null => (isExecFailure(e) ? e : null),
  );
  if (outcome === null) {
    throw new Error("expected non-zero exit, but node exited 0 with args: " + JSON.stringify(args));
  }
  return String(outcome.stderr ?? "");
}

const THREE_TASKS = ["count ts files", "count md files", "list exports"];

describe("fan-out.js 入口 fail-fast（D9 错误规格）", () => {
  it("agents 数量错配（3 tasks 配 2 agents）→ throw 且错误带 D9 字面与 Correct 示例", async () => {
    const stderr = await runProbeExpectThrow(
      { tasks: THREE_TASKS, agents: "/a/first.md,/b/second.md" },
      { aggregate: "none" },
    );
    // D9 字面：agents must have 1 entry or exactly tasks.length=3 entries, got 2
    expect(stderr).toContain("agents must have 1 entry or exactly tasks.length=3 entries, got 2");
    expect(stderr).toContain("Correct:");
    // fail-fast 发生在派发前：零 agent 调用（对照 parallel 的静默 fallback 被有意排除）
  });

  it("tasks 缺失 → throw 带 Correct 示例（直跑 workflow run 无 handler 前置校验时的兜底）", async () => {
    const stderr = await runProbeExpectThrow({ agents: "/a.md" }, { aggregate: "none" });
    expect(stderr).toContain("tasks is required");
    expect(stderr).toContain('Correct: {"tasks"');
  });

  it("tasks 元素含非字符串 → throw（模板入口校验，args-validator 后的纵深）", async () => {
    const stderr = await runProbeExpectThrow({ tasks: ["ok", 42] }, { aggregate: "none" });
    expect(stderr).toContain("non-empty string array");
    expect(stderr).toContain('Correct: {"tasks"');
  });

  it("tasks 元素为空白字符串 → throw", async () => {
    const stderr = await runProbeExpectThrow({ tasks: ["ok", "   "] }, { aggregate: "none" });
    expect(stderr).toContain("non-empty string array");
  });
});

describe("fan-out.js agents 分配（1 → 全部、N → 一一对应）", () => {
  it("1 个 agent 应用于全部成员", async () => {
    const r = await runProbe(
      { tasks: ["t0", "t1", "t2"], agents: "/x/one.md" },
      { aggregate: "none" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls).toHaveLength(3);
    for (const call of r.agentCalls) {
      expect(call.agent).toBe("/x/one.md");
    }
  });

  it("N 个 agents 与 tasks 一一对应（按派发序）", async () => {
    const r = await runProbe(
      { tasks: THREE_TASKS, agents: "/a/first.md,/b/second.md,/c/third.md" },
      { aggregate: "none" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls.map((c) => c.agent)).toEqual(["/a/first.md", "/b/second.md", "/c/third.md"]);
  });

  it("agents 缺省 → 成员不带 agent 字段（默认执行者）", async () => {
    const r = await runProbe({ tasks: ["t0", "t1"] }, { aggregate: "none" });
    expect(r.outcome.status).toBe("ok");
    for (const call of r.agentCalls) {
      expect(call.agent).toBeUndefined();
    }
  });
});

describe("fan-out.js taskIndex 派发序赋值（D4 权威源契约）", () => {
  it("results[].taskIndex 严格等于 $ARGS.tasks 下标，task 文本以 $ARGS.tasks 为权威源", async () => {
    const r = await runProbe(
      { tasks: THREE_TASKS, agents: "/x/one.md" },
      { aggregate: "none" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.results).toHaveLength(3);
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.task).toBe(THREE_TASKS[i]);
      expect(entry.status).toBe("ok");
    });
    // prompt = task 原文（无转译包装），成员收到的就是 $ARGS.tasks 元素
    expect(r.agentCalls.map((c) => c.prompt)).toEqual(THREE_TASKS);
  });

  it("成员输出 schema 不含 taskIndex（成员无从错报）——schema 只有 summary/fullReportPath", async () => {
    const r = await runProbe({ tasks: ["t0", "t1"] }, { aggregate: "none" });
    for (const call of r.agentCalls) {
      expect(call.schema?.required).toEqual(["summary"]);
      expect(Object.keys(call.schema?.properties ?? {}).sort()).toEqual(["fullReportPath", "summary"]);
    }
    // 静态守卫：agent() 派发块源码不得出现 taskIndex 字段声明
    const dispatchBlock = FANOUT_SOURCE.slice(
      FANOUT_SOURCE.indexOf("agent({"),
      FANOUT_SOURCE.indexOf("...agentFor(i)"),
    );
    expect(dispatchBlock).not.toContain("taskIndex");
  });
});

describe("fan-out.js 失败语义（D4/G2：allSettled partial 收口）", () => {
  it("部分成员失败 → status=partial，失败条目带 error，其余成员 ok 不被阻断", async () => {
    const r = await runProbe(
      { tasks: THREE_TASKS, agents: "/x/one.md" },
      { failIndexes: [1], aggregate: "none" },
    );
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("ok");
    expect(r.outcome.results[1].status).toBe("failed");
    expect(r.outcome.results[1].error).toContain("boom-1");
    expect(r.outcome.results[2].status).toBe("ok");
    // 失败条目 task/taskIndex 仍按派发序权威赋值（只重派失败任务的归因基础）
    expect(r.outcome.results[1].taskIndex).toBe(1);
    expect(r.outcome.results[1].task).toBe(THREE_TASKS[1]);
    // 三个成员都被派发（失败不阻断派发集合）
    expect(r.agentCalls).toHaveLength(3);
  });

  it("成员 resolve 非对象结果（引擎失败回退形态）→ failed 条目，不炸 run", async () => {
    const r = await runProbe(
      { tasks: ["t0", "t1"] },
      { failIndexes: [0], failMode: "resolve-string", aggregate: "none" },
    );
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("failed");
    expect(r.outcome.results[0].error).toContain("non-object result");
    expect(r.outcome.results[1].status).toBe("ok");
  });

  it("全员失败 → throw（run failed，非 error outcome 收口）", async () => {
    const stderr = await runProbeExpectThrow(
      { tasks: ["t0", "t1"], agents: "/x/one.md" },
      { failIndexes: [0, 1], aggregate: "none" },
    );
    expect(stderr).toContain("all tasks failed");
    expect(stderr).toContain("2/2");
  });
});

describe("fan-out.js 通知体积保序截断（D5：truncated 标记）", () => {
  it("results 超预算 → truncated:true，按序截断（靠前完整、靠后让出 summary），taskIndex/status/路径恒完整", async () => {
    const behavior: AgentBehavior = { summaryOf: "x".repeat(3000), aggregate: "none" };
    const r = await runProbe({ tasks: ["t0", "t1", "t2", "t3", "t4"], agents: "/x/one.md" }, behavior);
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.truncated).toBe(true);
    expect(r.outcome.results).toHaveLength(5);
    // 保序：预算内靠前条目保完整 summary，预算耗尽后条目 summary 让出
    expect(r.outcome.results[0].summary).toBe("x".repeat(3000));
    expect(r.outcome.results[2].summary).toBeUndefined();
    // 归因/恢复面恒完整：taskIndex/status/fullReportPath 每条都在
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.status).toBe("ok");
      expect(entry.fullReportPath).toBe("/tmp/fanout-report-" + i + ".md");
    });
  });

  it("总量在预算内 → 无 truncated 标记（缺省即 false 语义）", async () => {
    const r = await runProbe({ tasks: ["t0", "t1"], agents: "/x/one.md" }, { aggregate: "none" });
    expect(r.outcome.truncated).toBeUndefined();
    expect(r.outcome.results[0].summary).toBe("summary-0");
  });
});

describe("fan-out.js aggregate 可选归约（D4）", () => {
  it("aggregate=true → 末尾追加一个聚合 agent（共 N+1 次调用），outcome.aggregate 为结论，status=ok", async () => {
    const r = await runProbe(
      { tasks: THREE_TASKS, aggregate: true },
      { aggregate: "ok" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls).toHaveLength(4); // 3 成员 + 1 聚合
    const aggCall = r.agentCalls[3];
    expect(aggCall.description).toBe("fan-out-aggregate");
    expect(r.outcome.aggregate).toBe("conclusion-text");
  });

  it("aggregate 缺省 → 纯收集，不派聚合成员，outcome 无 aggregate 字段", async () => {
    const r = await runProbe({ tasks: ["t0", "t1"] }, { aggregate: "none" });
    expect(r.agentCalls).toHaveLength(2);
    expect(r.outcome.aggregate).toBeUndefined();
  });

  it("归约成员失败 → 不炸 run：已收集 results 照常收口，status 降 partial，aggregate 携带 error", async () => {
    const r = await runProbe(
      { tasks: THREE_TASKS, aggregate: true },
      { aggregate: "reject" },
    );
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results).toHaveLength(3);
    for (const entry of r.outcome.results) {
      expect(entry.status).toBe("ok");
    }
    const agg = r.outcome.aggregate as { error?: string };
    expect(typeof agg.error).toBe("string");
    expect(agg.error).toContain("agg-boom");
  });
});

describe("fan-out.js 模块形态与参数面契约", () => {
  it("顶层 return 使其不可作为 ES module import（pi worker 脚本，非可导入模块）", async () => {
    await expect(import("../../workflows/fan-out.js" as string)).rejects.toThrow();
  });

  it("参数面无 tasksJson（D4 被否谱系：tasks 直接数组是唯一任务集入口）", () => {
    expect(FANOUT_SOURCE).not.toContain("tasksJson");
    expect(FANOUT_SOURCE).not.toContain("itemsJson");
  });
});
