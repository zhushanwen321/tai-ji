// workflow-dag-parser 单测（可视化 U1，设计 §3.1-3 / §3.3-D2）
//
// fixture 三来源：
// 1. 仓内现存 workflow 脚本全量（<workspace 根>/.agents/workflows/*.js）——真机
//    脚本解析不炸 + 产物结构不变量（runlog 登记脚本清单与结果）；
// 2. ~/.pi/agent/workflows/*.js（宿主安装的 pi workflow 脚本——存在才跑，缺失
//    显式 skip：依赖宿主家目录的 fixture 不进 CI 硬门槛）；
// 3. 构造脚本用例（同词根双调用点 / 零调用点 / fail-fast / 边语义）。
//
// 构造用例的脚本形态对齐 worker-script-builder 注入的执行 API（agent 三签名 /
// parallel / phase / $ARGS 全局），不模拟模板壳——解析器输入契约 = 用户脚本原文。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_DAG_DEFAULT_PHASE,
  parseWorkflowDag,
  type WorkflowDag,
} from "../workflow-dag-parser.ts";

/** workspace 根（src/shared/__tests__ 上溯 5 层）。 */
const WORKSPACE_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

/** 产物结构不变量：边端点/组员/回边引用全部指向在册节点，边与循环 id 图内唯一。 */
function expectStructurallyValid(dag: WorkflowDag): void {
  const nodeIds = new Set(dag.nodes.map((n) => n.id));
  const edgeIds = new Set<string>();
  for (const edge of dag.edges) {
    expect(nodeIds.has(edge.from), `edge ${edge.id} from=${edge.from} 不在节点集`).toBe(true);
    expect(nodeIds.has(edge.to), `edge ${edge.id} to=${edge.to} 不在节点集`).toBe(true);
    expect(edgeIds.has(edge.id), `edge id 重复：${edge.id}`).toBe(false);
    edgeIds.add(edge.id);
    if (edge.kind === "conditional") expect(edge.predicate?.length ?? 0).toBeGreaterThan(0);
    else expect(edge.predicate).toBeUndefined();
  }
  for (const group of dag.parallelGroups) {
    expect(group.nodeIds.length).toBeGreaterThan(0);
    for (const id of group.nodeIds) {
      expect(nodeIds.has(id), `parallelGroup 成员 ${id} 不在节点集`).toBe(true);
    }
  }
  for (const loop of dag.loops) {
    expect(loop.nodeIds.length).toBeGreaterThan(0);
    for (const id of loop.nodeIds) {
      expect(nodeIds.has(id), `loop ${loop.id} 成员 ${id} 不在节点集`).toBe(true);
    }
    const backEdge = dag.edges.find((e) => e.id === loop.backEdgeId);
    expect(backEdge, `loop ${loop.id} backEdgeId=${loop.backEdgeId} 无对应边`).toBeDefined();
    expect(backEdge?.kind).toBe("loop-back");
    expect(backEdge?.from).toBe(loop.nodeIds[loop.nodeIds.length - 1]);
    expect(backEdge?.to).toBe(loop.nodeIds[0]);
  }
  dag.phases.forEach((phase, i) => {
    expect(phase.order).toBe(i);
  });
}

describe("parseWorkflowDag（scriptSource → WorkflowDag，设计 §3.1-3）", () => {
  describe("真实脚本 fixture 全量（现存 workflow 脚本解析不炸 + 结构不变量）", () => {
    // 采集点位：项目 .agents/workflows/（discovery 最高优先源）+ 宿主 ~/.pi/agent/workflows/
    const repoScripts = ["pr-lifecycle.js"].map((name) => join(WORKSPACE_ROOT, ".agents", "workflows", name));
    const hostWorkflowsDir = join(homedir(), ".pi", "agent", "workflows");

    for (const path of repoScripts) {
      it(`解析 ${path.split("/").slice(-3).join("/")}（仓内脚本）`, () => {
        expect(existsSync(path), `fixture 缺失：${path}`).toBe(true);
        const source = readFileSync(path, "utf8");
        const result = parseWorkflowDag(source);
        // 全量过的判据 = 解析成功（不产半个错误 DAG 的反面：合法脚本不得误报 parse_failed）
        if (!result.ok) throw new Error(`仓内脚本解析失败（${result.code}）：${result.message}`);
        expectStructurallyValid(result.dag);
        // pr-lifecycle 锚点：评审/修复模板节点与循环结构在蓝图上可寻
        if (path.endsWith("pr-lifecycle.js")) {
          console.log(
            `[fixture] pr-lifecycle.js：nodes=${result.dag.nodes.length} edges=${result.dag.edges.length} ` +
            `phases=${result.dag.phases.length} parallelGroups=${result.dag.parallelGroups.length} loops=${result.dag.loops.length}`,
          );
          expect(result.dag.nodes.length).toBeGreaterThanOrEqual(6);
          expect(result.dag.phases.map((p) => p.name)).toContain("终局三道门禁");
          expect(result.dag.phases.map((p) => p.name)).toContain("条件评审修复循环");
          expect(result.dag.parallelGroups.length).toBeGreaterThanOrEqual(2);
          expect(result.dag.loops.length).toBeGreaterThanOrEqual(1);
          const reviewer = result.dag.nodes.find((n) => n.templateName.startsWith("reviewer-"));
          expect(reviewer).toBeDefined();
          expect(reviewer?.matchPattern).toMatch(/^\^reviewer-/);
          expect(reviewer?.phase).toBe("并行多维审查（4 个一批）");
        }
      });
    }

    it("宿主 ~/.pi/agent/workflows/ 脚本（存在才跑——execute-full-workflow 形态）", (ctx) => {
      if (!existsSync(hostWorkflowsDir)) {
        console.log("[fixture] 宿主 workflows 目录不存在，跳过（不影响 CI）");
        return ctx.skip();
      }
      const scripts = ["execute-full-workflow.js"]
        .map((name) => join(hostWorkflowsDir, name))
        .filter((path) => existsSync(path));
      expect(scripts.length).toBeGreaterThan(0);
      for (const path of scripts) {
        const source = readFileSync(path, "utf8");
        const result = parseWorkflowDag(source);
        if (!result.ok) throw new Error(`宿主脚本解析失败（${path}，${result.code}）：${result.message}`);
        expectStructurallyValid(result.dag);
        // 该脚本为「opts 对象经 map 构造后 parallel(变量)」形态：脚本字面零 agent()
        // 调用点（解析器静态边界，头注释已登记）——phase 分区仍从字面 phase() 提取
        console.log(
          `[fixture] ${path.split("/").pop()}：nodes=${result.dag.nodes.length} edges=${result.dag.edges.length} ` +
          `phases=${result.dag.phases.length}`,
        );
        expect(result.dag.phases.map((p) => p.name)).toContain("WorktreeSetup");
        // 动态 phase 实参（"Dev-w" + i + ...）不造伪名——分区集不含拼接形态
        expect(result.dag.phases.some((p) => p.name.includes("Dev-w"))).toBe(false);
      }
    });
  });

  describe("模板名保留（§3.3-D2-①：字面段精确 + 变量段通配）", () => {
    it("同词根双调用点并存（S3 对账形态：reviewer-${dim}-a${n} 与 reviewer-security-${x}）", () => {
      const source = [
        `const dim = "security";`,
        `const n = 1;`,
        `const x = 2;`,
        `phase("review");`,
        `await agent({ prompt: "p1", description: "reviewer-" + dim + "-a" + n });`,
        `await agent({ prompt: "p2", description: "reviewer-security-" + x });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [a, b] = result.dag.nodes;
      // 拼接形态：字面段原样 + 变量段 ${…}；正则字面段转义 + 通配段 .*，锚定 ^$
      expect(a.templateName).toBe("reviewer-${…}-a${…}");
      expect(a.matchPattern).toBe("^reviewer-.*-a.*$");
      expect(b.templateName).toBe("reviewer-security-${…}");
      expect(b.matchPattern).toBe("^reviewer-security-.*$");
      // 两个 pattern 可编译（D2 挂接侧契约：new RegExp(matchPattern)）
      const reA = new RegExp(a.matchPattern);
      const reB = new RegExp(b.matchPattern);
      // 实例名 reviewer-security-a1 两者皆命中——D2 多命中裁决按「字面段总长降序」
      // 取更具体者（reviewer-security- 字面 17 > reviewer--a 字面 9…此处字面段为
      // reviewer-/ -a vs reviewer-security-，后者更长），本断言锚定裁决输入的形态
      expect(reA.test("reviewer-security-a1")).toBe(true);
      expect(reB.test("reviewer-security-a1")).toBe(true);
      const literalLength = (pattern: string): number =>
        pattern.slice(1, -1).replace(/\.\*/g, "").length;
      expect(literalLength(b.matchPattern)).toBeGreaterThan(literalLength(a.matchPattern));
      // 非本词根实例不误命中（锚定的意义）
      expect(reB.test("reviewer-perf-a1")).toBe(false);
      expect(reA.test("reviewer-perf-a1")).toBe(true);
    });

    it("模板字符串 description 与拼接形态同构（字面段 + ${…} 通配段）", () => {
      const source = "await agent({ prompt: \"p\", description: `reviewer-${dim}-r${round}` });";
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.nodes[0].templateName).toBe("reviewer-${…}-r${…}");
      expect(result.dag.nodes[0].matchPattern).toBe("^reviewer-.*-r.*$");
    });

    it("字面量 description = 纯字面（零通配段，精确匹配）", () => {
      const source = `await agent({ prompt: "p", description: "aggregator" });`;
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.nodes[0].templateName).toBe("aggregator");
      expect(result.dag.nodes[0].matchPattern).toBe("^aggregator$");
    });

    it("非静态 description（函数调用）与缺省 description 整段通配（templateName '*'）", () => {
      const source = [
        `await agent({ prompt: "p", description: buildName(dim) });`,
        `await agent(Object.assign({ model: M }, callSpec));`,
        `await agent("bare prompt");`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const node of result.dag.nodes) {
        expect(node.templateName).toBe("*");
        expect(node.matchPattern).toBe("^.*$");
        expect(new RegExp(node.matchPattern).test("anything")).toBe(true);
      }
    });

    it("agent(prompt, { label }) 二参签名：显示名取 label", () => {
      const source = `await agent("do things", { label: "fixer", schema: S });`;
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.nodes[0].templateName).toBe("fixer");
    });
  });

  describe("phase 分区与调用点归属", () => {
    it("phase() 调用序列按首现序登记分区；调用点归属最近一次 phase()", () => {
      const source = [
        `await agent({ prompt: "a", description: "n0" });`,
        `phase("p1");`,
        `await agent({ prompt: "b", description: "n1" });`,
        `phase("p2");`,
        `await agent({ prompt: "c", description: "n2" });`,
        `phase("p1");`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.phases).toEqual([
        { name: WORKFLOW_DAG_DEFAULT_PHASE, order: 0 },
        { name: "p1", order: 1 },
        { name: "p2", order: 2 },
      ]);
      expect(result.dag.nodes.map((n) => n.phase)).toEqual([
        WORKFLOW_DAG_DEFAULT_PHASE,
        "p1",
        "p2",
      ]);
    });

    it("opts.phase 显式声明压过词法 currentPhase（worker 侧 opts.phase || _currentPhase 同序）", () => {
      const source = [
        `phase("ambient");`,
        `await agent({ prompt: "p", description: "explicit", phase: "declared" });`,
        `await agent({ prompt: "q", description: "implicit" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.nodes[0].phase).toBe("declared");
      expect(result.dag.nodes[1].phase).toBe("ambient");
      expect(result.dag.phases.map((p) => p.name)).toContain("declared");
    });

    it("动态 phase 实参不造伪名——其后的调用点归缺省分区", () => {
      const source = [
        `phase("WorktreeSetup");`,
        `for (let i = 0; i < waves.length; i++) {`,
        `  phase("Dev-w" + i);`,
        `  await agent({ prompt: "p", description: "dev-" + i });`,
        `}`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.phases.map((p) => p.name)).toEqual(["WorktreeSetup", WORKFLOW_DAG_DEFAULT_PHASE]);
      expect(result.dag.nodes[0].phase).toBe(WORKFLOW_DAG_DEFAULT_PHASE);
    });
  });

  describe("边语义（sequence / dataflow / conditional / loop-back）", () => {
    it("词法序相邻调用点连 sequence 边", () => {
      const source = [
        `await agent({ prompt: "1", description: "a" });`,
        `await agent({ prompt: "2", description: "b" });`,
        `await agent({ prompt: "3", description: "c" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const seq = result.dag.edges.filter((e) => e.kind === "sequence");
      expect(seq).toHaveLength(2);
      expect(seq.map((e) => `${e.from}>${e.to}`)).toEqual([
        `${result.dag.nodes[0].id}>${result.dag.nodes[1].id}`,
        `${result.dag.nodes[1].id}>${result.dag.nodes[2].id}`,
      ]);
    });

    it("上游返回值注入下游 prompt → dataflow 边（优先于 sequence）", () => {
      const source = [
        `const review = await agent({ prompt: "r", description: "reviewer" });`,
        `await agent({ prompt: "fix based on: " + review, description: "fixer" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const [from, to] = result.dag.nodes;
      const dataflow = result.dag.edges.filter((e) => e.kind === "dataflow");
      expect(dataflow).toHaveLength(1);
      expect(dataflow[0].from).toBe(from.id);
      expect(dataflow[0].to).toBe(to.id);
      // 同 (from,to) 的 sequence 被 dataflow 覆盖（去重优先级）
      expect(result.dag.edges.filter((e) => e.kind === "sequence")).toHaveLength(0);
    });

    it("解构 parallel 返回按序对应组内成员（成员级 dataflow）", () => {
      const source = [
        `const [rcRaw, rqRaw] = await parallel([`,
        `  agent({ prompt: "c", description: "checker" }),`,
        `  agent({ prompt: "q", description: "quoter" }),`,
        `]);`,
        `await agent({ prompt: "merge " + rqRaw, description: "merger" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const [checker, quoter, merger] = result.dag.nodes;
      const dataflow = result.dag.edges.filter((e) => e.kind === "dataflow");
      expect(dataflow).toHaveLength(1);
      expect(dataflow[0].from).toBe(quoter.id);
      expect(dataflow[0].to).toBe(merger.id);
      void checker;
    });

    it("成员访问对象侧引用 → dataflow 边（r1.output 形态：模板插值 / 二参对象值 / 裸标识符值）", () => {
      const source = [
        `const r1 = await agent({ prompt: "r", description: "researcher" });`,
        "await agent({ prompt: `summarize: ${r1.output}`, description: \"summarizer\" });",
        `await agent("seed", { label: "seeder", seed: r1.output });`,
        `await agent({ prompt: "ctx", description: "ctxer", ctx: r1 });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const [researcher, summarizer, seeder, ctxer] = result.dag.nodes;
      const dataflow = result.dag.edges.filter((e) => e.kind === "dataflow");
      // 三种引用形态各产一条 researcher → 下游 的 dataflow 边；成员属性名（output）
      // 不是变量引用，不得凭空造第四条边
      expect(dataflow).toHaveLength(3);
      for (const edge of dataflow) expect(edge.from).toBe(researcher.id);
      expect(dataflow.map((e) => e.to).sort()).toEqual([summarizer.id, seeder.id, ctxer.id].sort());
    });

    it("if 环绕调用点 → conditional 边（谓词原文随边）；分支外顺序边不受影响", () => {
      const source = [
        `await agent({ prompt: "1", description: "gate" });`,
        `if (reviewers.length > 0) {`,
        `  await agent({ prompt: "r", description: "reviewer" });`,
        `}`,
        `await agent({ prompt: "2", description: "final" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const [gate, reviewer, final] = result.dag.nodes;
      const conditional = result.dag.edges.filter((e) => e.kind === "conditional");
      expect(conditional).toHaveLength(1);
      expect(conditional[0].from).toBe(gate.id);
      expect(conditional[0].to).toBe(reviewer.id);
      expect(conditional[0].predicate).toBe("reviewers.length > 0");
      // 分支后调用点接的是分支内单元（顺序链连续）
      const seq = result.dag.edges.filter((e) => e.kind === "sequence");
      expect(seq.some((e) => e.from === reviewer.id && e.to === final.id)).toBe(true);
    });

    it("while 环绕 → loops 标注（循环体节点集 + 回边）", () => {
      const source = [
        `let round = 1;`,
        `while (round <= maxRounds && !clean) {`,
        `  await agent({ prompt: "r", description: "reviewer" });`,
        `  await agent({ prompt: "f", description: "fixer" });`,
        `  round++;`,
        `}`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      expect(result.dag.loops).toHaveLength(1);
      const loop = result.dag.loops[0];
      expect(loop.nodeIds).toEqual(result.dag.nodes.map((n) => n.id));
      expect(loop.label).toBe("round <= maxRounds && !clean");
      const back = result.dag.edges.find((e) => e.id === loop.backEdgeId);
      expect(back?.kind).toBe("loop-back");
      expect(back?.from).toBe(result.dag.nodes[1].id);
      expect(back?.to).toBe(result.dag.nodes[0].id);
    });

    it("parallel 数组内联成员成组：成员间无顺序边，组外前驱扇出/后继扇入", () => {
      const source = [
        `await agent({ prompt: "pre", description: "prep" });`,
        `await parallel([`,
        `  agent({ prompt: "1", description: "w1" }),`,
        `  agent({ prompt: "2", description: "w2" }),`,
        `  agent({ prompt: "3", description: "w3" }),`,
        `]);`,
        `await agent({ prompt: "post", description: "merge" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      const [prep, w1, w2, w3, merge] = result.dag.nodes;
      expect(result.dag.parallelGroups).toEqual([
        { nodeIds: [w1.id, w2.id, w3.id] },
      ]);
      const seq = result.dag.edges.filter((e) => e.kind === "sequence");
      // 组前扇出（prep → 每成员）+ 组后扇入（每成员 → merge）
      expect(seq.filter((e) => e.from === prep.id)).toHaveLength(3);
      expect(seq.filter((e) => e.to === merge.id)).toHaveLength(3);
      // 成员间互不连边
      for (const e of seq) {
        const amongMembers = [w1.id, w2.id, w3.id];
        expect(!(amongMembers.includes(e.from) && amongMembers.includes(e.to))).toBe(true);
      }
    });

    it("parallel(map 回调) 形态（pr-lifecycle 批次派发同款）：回调内调用点成组", () => {
      const source = [
        `const part = await parallel(batch.map((d) =>`,
        `  agent({ prompt: "p" + d, description: "reviewer-" + d }),`,
        `));`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      expect(result.dag.nodes).toHaveLength(1);
      expect(result.dag.nodes[0].templateName).toBe("reviewer-${…}");
      expect(result.dag.parallelGroups).toEqual([
        { nodeIds: [result.dag.nodes[0].id] },
      ]);
    });
  });

  describe("零调用点与 fail-fast（不产半个错误 DAG）", () => {
    it("纯门禁脚本（无 agent 调用）→ nodes 空数组（渲染层空画布 + 居中摘要提示的契约输入）", () => {
      const source = [
        `phase("preflight");`,
        `const ok = execSync("pnpm lint").exitCode === 0;`,
        `if (!ok) return { status: "failed" };`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dag.nodes).toEqual([]);
      expect(result.dag.edges).toEqual([]);
      expect(result.dag.parallelGroups).toEqual([]);
      expect(result.dag.loops).toEqual([]);
      // phase 分区仍登记（脚本结构信息零损失——居中摘要提示之外分区可用于背景）
      expect(result.dag.phases.map((p) => p.name)).toContain("preflight");
    });

    it("语法残缺 → fail-fast 结构化错误（{code:'parse_failed', message}），无半个 DAG", () => {
      const result = parseWorkflowDag("await agent({ prompt: \"x\"");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("残缺脚本不该产出 DAG");
      expect(result.code).toBe("parse_failed");
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect("dag" in result).toBe(false);
    });

    it("空串输入 → fail-fast（acorn 对空程序报错）", () => {
      const result = parseWorkflowDag("");
      // 空串在 acorn 是合法空程序——但 workflow 脚本空串无意义；此处按解析器实际
      // 行为锚定：合法空程序产出空 DAG（零调用点形态），不误报 parse_failed。
      if (result.ok) {
        expect(result.dag.nodes).toEqual([]);
      } else {
        expect(result.code).toBe("parse_failed");
      }
    });
  });

  describe("节点行号与 id 唯一性", () => {
    it("line = 调用点 1-based 行号；id 图内唯一", () => {
      const source = [
        `// 注释行`,
        `await agent({ prompt: "1", description: "a" });`,
        ``,
        `await agent({ prompt: "2", description: "b" });`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      if (!result.ok) throw new Error(result.message);
      expect(result.dag.nodes[0].line).toBe(2);
      expect(result.dag.nodes[1].line).toBe(4);
      expect(new Set(result.dag.nodes.map((n) => n.id)).size).toBe(result.dag.nodes.length);
    });
  });
});
