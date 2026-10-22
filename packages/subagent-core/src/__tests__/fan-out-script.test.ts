// fan-out.js workflow 脚本行为契约直测（u-fanout-template 单元：成员对象化 + 通知
// 截断 + 全员失败收尾语义，各用例自述为准。原引用「设计 D4/D5/D9」为历史设计稿
// 决策编号，现行设计文档与 impl-plan 均无对应——git 可追溯）。
//
// 测试方法（同 review-fix-loop-script.test.ts 先例）：fan-out.js 是 pi worker 模板
// 脚本——顶层执行 + 顶层 return，不可作为 ES module import。用 AsyncFunction 在
// 本进程内复刻 worker 模板宿主形态（注入 fake agent / parallel / phase / log 与
// require；workerData.scriptPath 锚定契约，注入真实路径）。[单测层极端测试整治]
// 原形态为 node -e 冷 spawn 探针（每用例 ~0.3s，负载下无上界），in-process 化后
// 派发/断言语义不变、零 spawn。探针无文件系统副作用（fan-out 不落盘）。
//
// fake parallel 复刻 worker-script-builder.ts parallel() 的结果归一化语义
// （fulfilled 对象透传 / fulfilled 非对象→failed / rejected→failed），使「成员死亡走
// allSettled failed 分支」断言对齐真实 worker 行为，而非测试自造契约。
//
// 回归锚点（断言在违背契约的旧实现上会红）：
//   - tasks 对象-only 契约（成员对象元素；旧字符串形态/顶层 agents 残留 → 专属迁移文案，
//     缺 task/空白 task → 通用 Correct 形状文案，入口 fail-fast；
//     validateRunArgs/ajv 类型校验是第一道，本脚本入口纵深兜底）
//   - 成员级 agent/model/thinkingLevel 按成员传递，未指定字段不进 agent() 调用
//     （留给 run 级 $MODEL / $THINKING_LEVEL 继承）
//   - description 固定 fan-out-<i>（成员复用身份键，正则 ^fan-out-(\d+)$ 不变）
//   - D4 taskIndex 按派发序赋值（$ARGS.tasks 为权威源，成员无从错报）
//   - D4/G2 部分失败 partial 收尾 + 只重派失败 taskIndex 提示；全员失败 throw（run failed）
//   - D5 通知体积保序截断（truncated 标记 + taskIndex/status 恒完整）
//   - D4 aggregate 可选归约（末尾一个 agent()；归约失败不炸 run）
//   - @pi-meta parameters 对象-only（additionalProperties:false + task minLength + pattern ^/）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { THINKING_ORDER } from "../shared/model-ref.ts";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "workflows");
const FANOUT_PATH = join(WORKFLOWS_DIR, "fan-out.js");
const FANOUT_SOURCE = readFileSync(FANOUT_PATH, "utf8");

/** fake agent 行为表。 */
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
  model?: string;
  thinkingLevel?: string;
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

/** worker 模板宿主形态：AsyncFunction 以注入参数为自由变量执行整脚本源码（顶层 return 即 runner 应答值）。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (this: unknown, ...args: unknown[]) => Promise<unknown>;

const makeRunner = () =>
  new AsyncFunction("workerData", "$ARGS", "agent", "parallel", "phase", "log", "require", FANOUT_SOURCE + "\n");

const WORKER_DATA = { scriptPath: FANOUT_PATH };
const requireFromTest = createRequire(import.meta.url);
const noopPhase = (): void => {};

/** fake agent：行为表驱动（与原 node -e 探针内联版本逐语义对齐）。 */
function makeFakeAgent(behavior: AgentBehavior, agentCalls: AgentCallRecord[]) {
  return (opts: AgentCallRecord): Promise<unknown> => {
    agentCalls.push(opts);
    const m = /^fan-out-(\d+)$/.exec(opts.description ?? "");
    const idx = m ? Number(m[1]) : -1;
    if (idx >= 0) {
      if ((behavior.failIndexes ?? []).includes(idx)) {
        if (behavior.failMode === "resolve-string") {
          // resolve-string = 引擎失败回退形态（非对象结果 → parallel 归一化判 failed）
          return Promise.resolve("plain error text " + idx);
        }
        return Promise.reject(new Error("boom-" + idx));
      }
      return Promise.resolve({
        summary: behavior.summaryOf ?? "summary-" + idx,
        fullReportPath: "/tmp/fanout-report-" + idx + ".md",
      });
    }
    if (opts.description === "fan-out-aggregate") {
      if (behavior.aggregate === "reject") return Promise.reject(new Error("agg-boom"));
      return Promise.resolve({ conclusion: "conclusion-text" });
    }
    return Promise.resolve({ summary: "misc" });
  };
}

/** parallel 归一化语义复刻（worker-script-builder.ts parallel() 的三分支）。 */
async function fakeParallel(
  calls: Array<Promise<unknown> | AgentCallRecord>,
  fakeAgent: (opts: AgentCallRecord) => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const settled = await Promise.allSettled(
    calls.map((c) => (c instanceof Promise ? c : fakeAgent(c as AgentCallRecord))),
  );
  return settled.map((r) => {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        if (typeof rec.error === "string" && rec.error.length > 0) {
          return { status: "failed", error: rec.error };
        }
        return rec;
      }
      return { status: "failed", error: "agent returned non-object result (type=" + typeof v + ")" };
    }
    const reason = r.reason;
    return { status: "failed", error: reason instanceof Error ? reason.message : String(reason) };
  });
}

async function runScript(args: unknown, behavior: AgentBehavior): Promise<ProbeResult> {
  const agentCalls: AgentCallRecord[] = [];
  const logs: string[] = [];
  const fakeAgent = makeFakeAgent(behavior, agentCalls);
  const outcome = (await makeRunner()(
    WORKER_DATA,
    args,
    fakeAgent,
    (calls: Array<Promise<unknown> | AgentCallRecord>) => fakeParallel(calls, fakeAgent),
    noopPhase,
    (msg: unknown) => {
      logs.push(String(msg));
    },
    requireFromTest,
  )) as ProbeResult["outcome"];
  return { outcome, agentCalls, logs };
}

async function runScriptExpectThrow(args: unknown, behavior: AgentBehavior): Promise<string> {
  try {
    await runScript(args, behavior);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected script to throw, but it resolved with args: " + JSON.stringify(args));
}

const THREE_TASKS = [{ task: "count ts files" }, { task: "count md files" }, { task: "list exports" }];

describe("fan-out.js 入口 fail-fast（tasks 对象-only 契约）", () => {
  it("tasks 元素为旧字符串形态 → 专属迁移文案（旧形状早于成员对象格式；validateRunArgs/ajv 类型校验第一道同款，本脚本纵深兜底直参宿主）", async () => {
    const message = await runScriptExpectThrow({ tasks: ["t0", "t1"] }, { aggregate: "none" });
    expect(message).toContain("legacy args shape detected");
    expect(message).toContain("predates the member-object parameter format");
    expect(message).toContain("Recovery: re-dispatch a NEW run with member-object tasks");
    expect(message).toContain("Correct:");
    // fail-fast 发生在派发前：零 agent 调用
  });

  it("顶层 agents 残留键（成员对象 tasks + agents）→ 专属迁移文案（旧 CLI 混合形态的纵深兜底）", async () => {
    const message = await runScriptExpectThrow(
      { tasks: [{ task: "t0" }], agents: "/a/one.md,/b/two.md" },
      { aggregate: "none" },
    );
    expect(message).toContain('top-level "agents" key present');
    expect(message).toContain("predates the member-object parameter format");
    expect(message).toContain("Recovery: re-dispatch a NEW run with member-object tasks");
  });

  it("tasks 缺失 → throw 带 Correct 示例（直跑 workflow run 无 handler 前置校验时的兜底）", async () => {
    const message = await runScriptExpectThrow({}, { aggregate: "none" });
    expect(message).toContain("tasks is required");
    expect(message).toContain('Correct: {"tasks"');
  });

  it("tasks 空数组 → throw（minItems:1 的脚本入口纵深）", async () => {
    const message = await runScriptExpectThrow({ tasks: [] }, { aggregate: "none" });
    expect(message).toContain("tasks is required");
  });

  it("成员缺 task 字段 → throw（task 必填的脚本入口纵深）", async () => {
    const message = await runScriptExpectThrow(
      { tasks: [{ task: "ok" }, { agent: "/a/one.md" }] },
      { aggregate: "none" },
    );
    expect(message).toContain('must be objects with a non-blank "task" string');
  });

  it("member.task 为空白字符串 → throw（schema minLength 不拦空白，入口 trim 检查保留）", async () => {
    const message = await runScriptExpectThrow(
      { tasks: [{ task: "ok" }, { task: "   " }] },
      { aggregate: "none" },
    );
    expect(message).toContain('must be objects with a non-blank "task" string');
  });
});

describe("fan-out.js 成员级配置派发（成员对象 agent/model/thinkingLevel）", () => {
  it("成员级 agent 逐成员生效（各成员可不同执行者）", async () => {
    const r = await runScript(
      { tasks: [{ task: "t0", agent: "/a/one.md" }, { task: "t1", agent: "/b/two.md" }, { task: "t2", agent: "/a/one.md" }] },
      { aggregate: "none" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.agentCalls.map((c) => c.agent)).toEqual(["/a/one.md", "/b/two.md", "/a/one.md"]);
  });

  it("成员未指定 agent → 不带 agent 字段（默认执行者；未指定字段不进 agent() 调用）", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, { aggregate: "none" });
    expect(r.outcome.status).toBe("ok");
    for (const call of r.agentCalls) {
      expect(call.agent).toBeUndefined();
    }
  });

  it("成员级 model/thinkingLevel 进 agent() 调用；未指定不带字段（留给 $MODEL/$THINKING_LEVEL 继承）", async () => {
    const r = await runScript(
      {
        tasks: [
          { task: "t0", model: "prov/model-one", thinkingLevel: "high" },
          { task: "t1" },
        ],
      },
      { aggregate: "none" },
    );
    expect(r.agentCalls[0].model).toBe("prov/model-one");
    expect(r.agentCalls[0].thinkingLevel).toBe("high");
    expect(r.agentCalls[1].model).toBeUndefined();
    expect(r.agentCalls[1].thinkingLevel).toBeUndefined();
  });

  it("description 恒为 fan-out-<i>（成员复用身份键，正则 ^fan-out-(\\d+)$ 派发序对齐）", async () => {
    const r = await runScript({ tasks: THREE_TASKS }, { aggregate: "none" });
    expect(r.agentCalls.map((c) => c.description)).toEqual(["fan-out-0", "fan-out-1", "fan-out-2"]);
    // 静态锚：派发块的 description 不承载显示语义，模板源码保持 "fan-out-" + i 字面拼接
    expect(FANOUT_SOURCE).toContain('description: "fan-out-" + i,');
  });
});

describe("fan-out.js taskIndex 派发序赋值（D4 权威源契约）", () => {
  it("results[].taskIndex 严格等于 $ARGS.tasks 下标，task 文本以 member.task 为权威源", async () => {
    const r = await runScript(
      { tasks: THREE_TASKS.map((m) => ({ ...m, agent: "/x/one.md" })) },
      { aggregate: "none" },
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.results).toHaveLength(3);
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.task).toBe(THREE_TASKS[i].task);
      expect(entry.status).toBe("ok");
    });
    // prompt = member.task 原文（无转译包装），成员收到的就是 $ARGS.tasks 元素的 task 字段
    expect(r.agentCalls.map((c) => c.prompt)).toEqual(THREE_TASKS.map((m) => m.task));
  });

  it("成员输出 schema 不含 taskIndex（成员无从错报）——schema 只有 summary/fullReportPath", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, { aggregate: "none" });
    for (const call of r.agentCalls) {
      expect(call.schema?.required).toEqual(["summary"]);
      expect(Object.keys(call.schema?.properties ?? {}).sort()).toEqual(["fullReportPath", "summary"]);
    }
    // 静态检查：agent() 派发块源码不得出现 taskIndex 字段声明
    const dispatchBlock = FANOUT_SOURCE.slice(
      FANOUT_SOURCE.indexOf("agent({"),
      FANOUT_SOURCE.indexOf('...memberOverride(member, "thinkingLevel")'),
    );
    expect(dispatchBlock).not.toContain("taskIndex");
  });
});

describe("fan-out.js 失败语义（D4/G2：allSettled partial 收尾）", () => {
  it("部分成员失败 → status=partial，失败条目带 error，其余成员 ok 不被阻断；收尾提示只重派失败 taskIndex", async () => {
    const r = await runScript(
      { tasks: THREE_TASKS.map((m) => ({ ...m, agent: "/x/one.md" })) },
      { failIndexes: [1], aggregate: "none" },
    );
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("ok");
    expect(r.outcome.results[1].status).toBe("failed");
    expect(r.outcome.results[1].error).toContain("boom-1");
    expect(r.outcome.results[2].status).toBe("ok");
    // 失败条目 task/taskIndex 仍按派发序权威赋值（只重派失败任务的归因基础）
    expect(r.outcome.results[1].taskIndex).toBe(1);
    expect(r.outcome.results[1].task).toBe(THREE_TASKS[1].task);
    // 三个成员都被派发（失败不阻断派发集合）
    expect(r.agentCalls).toHaveLength(3);
    // §3.3.5 partial 收尾文案：指向失败 taskIndex 的局部重派，不是全批重跑
    expect(r.outcome.message).toContain("taskIndex");
    expect(r.outcome.message).toContain("失败 1");
  });

  it("成员 resolve 非对象结果（引擎失败回退形态）→ failed 条目，不炸 run", async () => {
    const r = await runScript(
      { tasks: [{ task: "t0" }, { task: "t1" }] },
      { failIndexes: [0], failMode: "resolve-string", aggregate: "none" },
    );
    expect(r.outcome.status).toBe("partial");
    expect(r.outcome.results[0].status).toBe("failed");
    expect(r.outcome.results[0].error).toContain("non-object result");
    expect(r.outcome.results[1].status).toBe("ok");
  });

  it("全员失败 → throw（run failed，非 error outcome 收尾）", async () => {
    const message = await runScriptExpectThrow(
      { tasks: [{ task: "t0" }, { task: "t1" }] },
      { failIndexes: [0, 1], aggregate: "none" },
    );
    expect(message).toContain("all tasks failed");
    expect(message).toContain("2/2");
  });
});

describe("fan-out.js 通知体积保序截断（D5：truncated 标记）", () => {
  it("results 超预算 → truncated:true，按序截断（靠前完整、靠后让出 summary），taskIndex/status/路径恒完整", async () => {
    const behavior: AgentBehavior = { summaryOf: "x".repeat(3000), aggregate: "none" };
    const r = await runScript(
      { tasks: [{ task: "t0" }, { task: "t1" }, { task: "t2" }, { task: "t3" }, { task: "t4" }] },
      behavior,
    );
    expect(r.outcome.status).toBe("ok");
    expect(r.outcome.truncated).toBe(true);
    expect(r.outcome.results).toHaveLength(5);
    // 保序：预算内靠前条目保完整 summary，预算耗尽后条目 summary 让出
    expect(r.outcome.results[0].summary).toBe("x".repeat(3000));
    expect(r.outcome.results[2].summary).toBeUndefined();
    // 归因/恢复路径恒完整：taskIndex/status/fullReportPath 每条都在
    r.outcome.results.forEach((entry, i) => {
      expect(entry.taskIndex).toBe(i);
      expect(entry.status).toBe("ok");
      expect(entry.fullReportPath).toBe("/tmp/fanout-report-" + i + ".md");
    });
  });

  it("总量在预算内 → 无 truncated 标记（缺省即 false 语义）", async () => {
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, { aggregate: "none" });
    expect(r.outcome.truncated).toBeUndefined();
    expect(r.outcome.results[0].summary).toBe("summary-0");
  });
});

describe("fan-out.js aggregate 可选归约（D4）", () => {
  it("aggregate=true → 末尾追加一个聚合 agent（共 N+1 次调用），outcome.aggregate 为结论，status=ok", async () => {
    const r = await runScript(
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
    const r = await runScript({ tasks: [{ task: "t0" }, { task: "t1" }] }, { aggregate: "none" });
    expect(r.agentCalls).toHaveLength(2);
    expect(r.outcome.aggregate).toBeUndefined();
  });

  it("归约成员失败 → 不炸 run：已收集 results 照常收尾，status 降 partial，aggregate 携带 error", async () => {
    const r = await runScript(
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

describe("fan-out.js 模块形态与参数侧契约", () => {
  it("顶层 return 使其不可作为 ES module import（pi worker 脚本，非可导入模块）", async () => {
    await expect(import("../../workflows/fan-out.js" as string)).rejects.toThrow();
  });

  it("参数范围无 tasksJson（D4 不采用其余方案的理由：tasks 直接数组是唯一任务集入口）", () => {
    expect(FANOUT_SOURCE).not.toContain("tasksJson");
    expect(FANOUT_SOURCE).not.toContain("itemsJson");
  });

  it("@pi-meta tasks schema 对象-only：顶层与 items 均 additionalProperties:false + task minLength + agent pattern ^/ + maxItems（验收②）", () => {
    const metaStart = FANOUT_SOURCE.indexOf("/* @pi-meta");
    const metaEnd = FANOUT_SOURCE.indexOf("*/", metaStart);
    const metaBlock = FANOUT_SOURCE.slice(metaStart, metaEnd);
    expect(metaBlock).toContain("additionalProperties: false");
    // 顶层 additionalProperties:false（设计 §3.4 参数契约）——旧 CLI 混合形态（对象 tasks
    // + 顶层 agents 残留）在 validateRunArgs 层即拒绝，不静默放行（仅 items 层有
    // additionalProperties 时顶层未知键穿透）
    expect(metaBlock).toMatch(/parameters:\n  type: object\n  additionalProperties: false/);
    expect(metaBlock).toContain("minLength: 1");
    expect(metaBlock).toContain('pattern: "^/"');
    expect(metaBlock).toContain("maxItems: 20");
    expect(metaBlock).toContain("required: [task]");
    // thinkingLevel enum 与运行级 THINKING_ORDER 动态对拍（fan-out.js 是 worker eval 模板
    // 无法 import TS，字面量手动同步；THINKING_ORDER 增删档位时本断言变红提示同步）
    const enumLine = metaBlock.match(/thinkingLevel: \{ type: string, enum: \[([^\]]+)\]/);
    expect(enumLine).not.toBeNull();
    const enumValues = (enumLine?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""));
    expect(enumValues).toEqual([...THINKING_ORDER]);
  });

  it("@pi-meta 无 agents 参数（随成员对象化退役）；模板级 aggregate 参数保留（验收④）", () => {
    const metaStart = FANOUT_SOURCE.indexOf("/* @pi-meta");
    const metaEnd = FANOUT_SOURCE.indexOf("*/", metaStart);
    const metaBlock = FANOUT_SOURCE.slice(metaStart, metaEnd);
    expect(metaBlock).not.toMatch(/^\s*agents:/m);
    expect(metaBlock).toContain("aggregate: { type: boolean, default: false }");
    // parseAgentRefs / agents 数量 fail-fast 旧逻辑整体退役
    expect(FANOUT_SOURCE).not.toContain("parseAgentRefs");
    expect(FANOUT_SOURCE).not.toContain("agentRefs");
    expect(FANOUT_SOURCE).not.toContain("agentFor");
  });
});
