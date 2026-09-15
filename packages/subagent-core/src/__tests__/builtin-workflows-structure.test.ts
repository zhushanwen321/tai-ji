// U2 + E1: 内置 workflow 脚本 null guard 覆盖 + 文件结构一致性
//
// U2: agent() 失败时 resolve 成空字符串/undefined（设计行为），脚本直接访问
// 返回值属性会 TypeError。验证 4 个内置脚本的 agent() 返回值属性访问均含
// null guard（?. 或 ??），不遗留裸 .property 访问。
//
// E1: workflows/ 目录含 4 个 .js 文件，每个 meta.name 与文件名 stem 一致。

import { readdirSync,readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseResourceMeta } from "../shared/meta-parser.ts";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "../../workflows");

const SCRIPTS = ["chain.js", "parallel.js", "scatter-gather.js", "map-reduce.js", "review-fix-loop.js"] as const;

function readScript(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), "utf-8");
}

/** 提取 meta.name 值（经 IF1 parseResourceMeta，m2 收敛）。 */
function extractMetaName(src: string): string | null {
  const meta = parseResourceMeta(src, "workflow");
  return meta && meta.kind === "workflow" ? meta.name : null;
}

describe("E1: 内置 workflow 文件结构一致性", () => {
  it("workflows/ 目录含 5 个 .js 文件", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js"));
    expect(files.sort()).toEqual([...SCRIPTS].sort());
  });

  it.each(SCRIPTS)("meta.name 与文件名 stem 一致：%s", (filename) => {
    const src = readScript(filename);
    const metaName = extractMetaName(src);
    const stem = filename.replace(/\.js$/, "");
    expect(metaName).toBe(stem);
  });
});

describe("U2: 内置脚本 agent() 返回值属性访问含 null guard", () => {
  // 策略：检查脚本中 ?. 和 ?? 的出现次数 >= agent() 调用次数（每个 agent() 返回值
  // 至少有一处属性访问需 guard）。更精确地：脚本不应有裸的 `变量.属性` 访问
  // agent() 返回值——但区分 agent() 返回值和局部对象属性访问需要 AST 分析，
  // 这里用启发式：验证含 agent() 结果属性访问的脚本都含 ?. 模式（null guard 已存在）。
  //
  // 注意：parallel.js 的 aggregate 段为纯代码 concat（无 LLM 聚合 agent()），
  // 其 parallel() 多结果由 W4 的 r.status === "failed" / typeof / Array.isArray 守卫，
  // 不再用 ?.，故不纳入此 ?. 启发式检查。
  // map-reduce 的 reduce、scatter-gather 的 gather 恢复为 LLM agent() 调用，
  // 故 map-reduce.js 重新纳入此检查。

  // 仍含 agent() 返回值属性访问、需 ?. guard 的脚本：chain（analysis/plan/final）、
  // scatter-gather（split 的 subtasks、gather 的 mergedResult/completeness）、
  // map-reduce（reduce 的 reduced/stats）、review-fix-loop（aggRaw?.length 等）。
  const GUARD_SCRIPTS = ["chain.js", "scatter-gather.js", "map-reduce.js", "review-fix-loop.js"] as const;

  it.each(GUARD_SCRIPTS)("%s 含 optional chaining（?.）null guard 模式", (filename) => {
    const src = readScript(filename);
    // chain.js 至少有 6 处 ?. guard；scatter-gather.js 至少有 split/gather 多处；
    // map-reduce.js 至少有 reduce 的 reduced/stats 多处
    expect(src).toContain("?.");
  });

  it("chain.js 的 analysis/plan/final 属性访问均含 null guard", () => {
    const src = readScript("chain.js");
    // analysis 的 insights/keyPoints
    expect(src).toContain("analysis?.insights");
    expect(src).toContain("analysis?.keyPoints");
    // plan 的 plan/actions
    expect(src).toContain("plan?.plan");
    expect(src).toContain("plan?.actions");
    // final 的 summary/recommendation
    expect(src).toContain("final?.summary");
    expect(src).toContain("final?.recommendation");
  });

  it("scatter-gather.js 的 split/gathered 属性访问含 null guard", () => {
    const src = readScript("scatter-gather.js");
    // split 的 subtasks
    expect(src).toContain("split?.subtasks");
    // gather（gatheredResult）的 mergedResult / completeness
    expect(src).toContain("gatheredResult?.mergedResult");
    expect(src).toContain("gatheredResult?.completeness");
  });

  it("map-reduce.js 的 reduced 属性访问含 null guard", () => {
    const src = readScript("map-reduce.js");
    // reduce（reducedResult）的 reduced / stats
    expect(src).toContain("reducedResult?.reduced");
    expect(src).toContain("reducedResult?.stats");
  });

  it.each(SCRIPTS)("%s 不含裸 analysis.insights/plan.plan 等无 guard 访问", (filename) => {
    const src = readScript(filename);
    // 检查不存在 "变量.属性" 形式的裸访问（不含 ?. 的）
    // 排除 schema 对象定义里的 properties.xxx 和 JSON.stringify 等合法用法
    // 只检查 agent() 返回值变量名后的裸属性访问
    const agentVars = ["analysis", "plan", "final", "split", "gatheredResult", "reducedResult"];
    for (const v of agentVars) {
      // 匹配 `变量.属性`（非 `变量?.属性`），但排除变量声明和赋值左侧
      const bareAccess = new RegExp(`[^?\\w.]${v}\\.[a-zA-Z]`);
      // 排除 schema properties 定义中的合法用法（如 properties: { insights: ... }）
      // 这里只关注 prompt 拼接和 outcome 构造中的裸访问
      const lines = src.split("\n");
      for (const line of lines) {
        // 跳过 schema 定义行（含 type: / properties: / description:）
        if (/^\s*(type|properties|description|required|items):/.test(line)) continue;
        // 跳过 const 声明行（如 `const plan = await agent(...)`）
        if (/^\s*const\s+\w+\s*=/.test(line) && line.includes("agent(")) continue;
        if (bareAccess.test(line)) {
          // 检查这个裸访问是否真的在属性读取位置（而非变量定义）
          const match = line.match(bareAccess);
          if (match && !line.includes(`?.`)) {
            // 确认是 agent() 返回值的属性访问（同一行有拼接/赋值上下文）
            // 如果行里同时有 ?. 版本，说明是 guard 后的，不算裸访问
            expect(line).toMatch(new RegExp(`${v}\\?\\.`));
          }
        }
      }
    }
  });
});

// W4: parallel() 降级返回值 {status:'failed'} 兼容 + 结果字段守卫 + spread 消除
describe("W4: parallel() failed-status 兼容 + 结果字段守卫 + spread 消除", () => {
  // W1 后 worker parallel() 可能返回 {status:'failed', error:'...'}，脚本 for 循环
  // 必须识别此对象并标记失败（不能误判为成功）。验证三个含 parallel() 的脚本。
  const PARALLEL_SCRIPTS = ["parallel.js", "scatter-gather.js", "map-reduce.js"] as const;

  it.each(PARALLEL_SCRIPTS)("%s 含 r.status === \"failed\" 失败识别（W1 兼容）", (filename) => {
    const src = readScript(filename);
    // 三个脚本都应有 `r.status === "failed"` 检查（识别 W1 的降级对象）
    expect(src).toContain('r.status === "failed"');
  });

  it("parallel.js perPerspective 不再用 spread 透传 agent 字段（spread 消除）", () => {
    const src = readScript("parallel.js");
    // W4 后显式取 score/findings，不再 ...r
    expect(src).not.toContain("...r");
    // 显式字段守卫存在
    expect(src).toContain("typeof r.score === \"number\"");
    expect(src).toContain("Array.isArray(r.findings)");
  });

  it("scatter-gather.js r.result 字段守卫存在", () => {
    const src = readScript("scatter-gather.js");
    expect(src).toContain("typeof r.result === \"string\"");
    expect(src).toContain("\"(无结果)\"");
  });

  it("map-reduce.js r.mapped 字段守卫存在", () => {
    const src = readScript("map-reduce.js");
    expect(src).toContain("typeof r.mapped === \"string\"");
    expect(src).toContain("\"(无结果)\"");
  });

  it("parallel.js perspectives 元素类型校验存在", () => {
    const src = readScript("parallel.js");
    expect(src).toContain("perspectives.some");
    expect(src).toContain("typeof p !== \"string\"");
  });

  it("scatter-gather.js subtasks 元素结构校验存在", () => {
    const src = readScript("scatter-gather.js");
    expect(src).toContain("subtasks.some");
    expect(src).toContain("typeof s.name !== \"string\"");
  });

  it("chain.js task 类型校验拒绝非字符串与空白", () => {
    const src = readScript("chain.js");
    expect(src).toContain("typeof task !== \"string\"");
    expect(src).toContain("task.trim() === \"\"");
  });
});
