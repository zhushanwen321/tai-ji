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
  const referencedBackEdgeIds = new Set(dag.loops.map((l) => l.backEdgeId));
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
  // 孤儿回边：每条 loop-back 边必被某 loop 引用——嵌套循环共享 (首,末) 节点对时
  // 两条回边同 (from,to)，若按 (from,to) 配对会让先压入的回边成孤儿（dmg-r1-11）
  for (const edge of dag.edges) {
    if (edge.kind === "loop-back") {
      expect(referencedBackEdgeIds.has(edge.id), `孤儿回边（无 loop 引用）：${edge.id}`).toBe(true);
    }
  }
  dag.phases.forEach((phase, i) => {
    expect(phase.order).toBe(i);
  });
}

/**
 * 构造用例共形装置：脚本 → 解析 → fail-fast 守卫 + 结构不变量校验，直接返回 dag。
 * 解析失败原生抛出（测试体不再重复 if(!ok) throw 样板）；成功路径 dag 已过结构校验。
 */
function parseValidatedDag(source: string): WorkflowDag {
  const result = parseWorkflowDag(source);
  if (!result.ok) throw new Error(result.message);
  expectStructurallyValid(result.dag);
  return result.dag;
}

/**
 * 拒绝形态断言三联（复合调用链/互调环/同名多候选三用例共享）：恰好 N 节点、全部落
 * 缺省分区（实现点词法收口）、调用点零投影（指定名不出现）或通配形态（全部同名）。
 */
function expectRejectedProjection(
  dag: WorkflowDag,
  nodeCount: number,
  opts: { absentTemplateName?: string; everyTemplateName?: string } = {},
): void {
  expect(dag.nodes.length).toBe(nodeCount);
  expect(dag.nodes.every((n) => n.phase === WORKFLOW_DAG_DEFAULT_PHASE)).toBe(true);
  if (opts.absentTemplateName !== undefined) {
    expect(dag.nodes.some((n) => n.templateName === opts.absentTemplateName)).toBe(false);
  }
  if (opts.everyTemplateName !== undefined) {
    expect(dag.nodes.every((n) => n.templateName === opts.everyTemplateName)).toBe(true);
  }
}

/** 投影形态断言（[templateName, phase] 双锚用例共享）：节点二元组序比对。 */
function expectNodeNamePhases(dag: WorkflowDag, pairs: Array<[string, string]>): void {
  expect(dag.nodes.map((n) => [n.templateName, n.phase])).toEqual(pairs);
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
          // helper 投影锚点：askAgent 调用点的 callSpec.description 模板可寻且落对分区（pr-lifecycle 的 aggregator 经 askAgent 派发）
          const aggregator = result.dag.nodes.find((n) => n.templateName.startsWith("aggregator-"));
          expect(aggregator?.phase).toBe("聚合去重与修复分组");
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

    it("for(;;) 裸轮询形态（test/left/right 全缺席）→ 固定标签回退，不产原生异常", () => {
      const source = [
        `for (;;) {`,
        `  await agent({ prompt: "poll", description: "poller" });`,
        `  if (done) break;`,
        `}`,
      ].join("\n");
      const result = parseWorkflowDag(source);
      // 守卫前：visitLoop 对 undefined 取 sourceSlice → TypeError 以原生 throw 逃出
      // 结构化错误边界，被挂接侧误归类为可重试通道错误；守卫后 for(;;) 是合法脚本，
      // 按「合法脚本不得误报 parse_failed」契约正常解析（标签回退固定串 "loop"）
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expectStructurallyValid(result.dag);
      expect(result.dag.nodes.map((n) => n.templateName)).toEqual(["poller"]);
      expect(result.dag.loops).toHaveLength(1);
      expect(result.dag.loops[0].label).toBe("loop");
      expect(result.dag.loops[0].nodeIds).toEqual([result.dag.nodes[0].id]);
    });

    it("嵌套循环共享 (首,末) 节点对 → 两 loop 各持独立回边（backEdgeId 不因同键覆盖共享）", () => {
      const dag = parseValidatedDag([
        `while (retry < limit) {`,
        `  for (const item of items) {`,
        `    await agent({ prompt: "p", description: "worker" });`,
        `  }`,
        `}`,
      ].join("\n"));
      // ctx.loops 登记序：内层先出（外层 visitLoop 等内层闭合后才登记）
      expect(dag.loops).toHaveLength(2);
      const [inner, outer] = dag.loops;
      expect(inner.label).toBe("const item … items");
      expect(outer.label).toBe("retry < limit");
      // 外层循环体只含内层循环 → 两循环 bodyNodes 相同（共享 (首,末) 节点对）
      expect(inner.nodeIds).toEqual(dag.nodes.map((n) => n.id));
      expect(outer.nodeIds).toEqual(inner.nodeIds);
      // 回边归属：各 loop 持有本 loop 自有回边，from/to === 本 loop 末/首节点
      expect(inner.backEdgeId).not.toBe(outer.backEdgeId);
      for (const loop of [inner, outer]) {
        const back = dag.edges.find((e) => e.id === loop.backEdgeId);
        expect(back, `loop ${loop.id} backEdgeId=${loop.backEdgeId} 无对应边`).toBeDefined();
        expect(back?.kind).toBe("loop-back");
        expect(back?.from).toBe(loop.nodeIds[loop.nodeIds.length - 1]);
        expect(back?.to).toBe(loop.nodeIds[0]);
      }
      expect(dag.edges.filter((e) => e.kind === "loop-back")).toHaveLength(2);
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

  describe("helper 投影（恰含 1 个 agent() 调用的具名函数 → 调用点虚拟节点）", () => {
    it("wfAgent 形态：调用点投影（模板取第一实参、phase 取词法位置），体内实现点不产节点", () => {
      const dag = parseValidatedDag([
        `function wfAgent(name, persona) {`,
        `  return {`,
        `    ask: async (typeKey, instructions) => {`,
        `      const raw = await agent({ prompt: instructions, description: name });`,
        `      return raw;`,
        `    },`,
        `  };`,
        `}`,
        `phase("审查");`,
        "const a = wfAgent(`审查员-${1}`, P);",
        `await wfAgent("规划", P);`,
      ].join("\n"));
      // 实现点不再落缺省分区（「唯一节点落 default + 全部实例未匹配」假象消除）
      expect(dag.nodes.some((n) => n.phase === WORKFLOW_DAG_DEFAULT_PHASE)).toBe(false);
      expect(dag.nodes.map((n) => n.templateName)).toEqual(["审查员-${…}", "规划"]);
      expect(dag.nodes[0]?.matchPattern).toBe("^审查员-.*$");
      expect(dag.nodes[1]?.matchPattern).toBe("^规划$");
      expect(dag.nodes.every((n) => n.phase === "审查")).toBe(true);
    });

    it("askAgent 形态：第一实参对象字面量优先取 description 属性表达式（模板段保留）", () => {
      const dag = parseValidatedDag([
        `async function askAgent(callSpec, roleLabel) {`,
        `  const raw = await agent(Object.assign({ returnMeta: true }, callSpec));`,
        `  return raw;`,
        `}`,
        `phase("门禁");`,
        `await askAgent({ prompt: "p", description: "agg-" + n + "-r" + round }, "聚合");`,
      ].join("\n"));
      expect(dag.nodes.length).toBe(1);
      expect(dag.nodes[0]?.templateName).toBe("agg-${…}-r${…}");
      expect(dag.nodes[0]?.matchPattern).toBe("^agg-.*-r.*$");
      expect(dag.nodes[0]?.phase).toBe("门禁");
    });

    it("phase 上下文函数边界作用域化：具名函数体内的 phase() 不外泄（planner 绑定错分区修复）", () => {
      const dag = parseValidatedDag([
        `function wfAgent(name, persona) {`,
        `  return { ask: async (_t, q) => (await agent({ prompt: q, description: name })) };`,
        `}`,
        `phase("首轮");`,
        `async function retireClosure(round) {`,
        `  phase("退役");`,
        `  const r = wfAgent("伴生产物判定", P);`,
        `  await r.ask("V", "q");`,
        `}`,
        `const plannerAgent = wfAgent("框架对照规划", P);`,
        `phase("次轮");`,
        `await wfAgent("复审", P);`,
      ].join("\n"));
      // retire → 退役（体内自身 phase）；planner → 首轮（声明后恢复外层，不被体内 phase 污染）；复审 → 次轮
      expectNodeNamePhases(dag, [
        ["伴生产物判定", "退役"],
        ["框架对照规划", "首轮"],
        ["复审", "次轮"],
      ]);
    });

    it("多 agent() 调用 helper 不投影（实现点保持词法收口，调用点不产节点）", () => {
      const dag = parseValidatedDag([
        `async function two(name) {`,
        `  await agent({ prompt: "1", description: name });`,
        `  await agent({ prompt: "2", description: name + "2" });`,
        `}`,
        `phase("P");`,
        `await two("x");`,
      ].join("\n"));
      expect(dag.nodes.length).toBe(2);
      expect(dag.nodes.map((n) => n.templateName)).toEqual(["*", "${…}2"]);
      // two 声明词法位置在 phase("P") 之前 → 实现点归缺省分区（登记边界）
      expect(dag.nodes.every((n) => n.phase === WORKFLOW_DAG_DEFAULT_PHASE)).toBe(true);
    });

    it("匿名回调（map/parallel 成员）内的调用点不是 helper——批量回调语义不变", () => {
      const dag = parseValidatedDag([
        `phase("P");`,
        "const rs = await parallel(names.map((n) => agent({ prompt: \"p\", description: `r-${n}` })));",
      ].join("\n"));
      expect(dag.nodes.length).toBe(1);
      expect(dag.nodes[0]?.templateName).toBe("r-${…}");
      expect(dag.parallelGroups.length).toBe(1);
    });

    it("复合调用链真形态（caller 自带 agent 调用且调用另一候选，span 更小）：命运结算拒 caller，无幻影投影", () => {
      const dag = parseValidatedDag([
        `function grade(n) {`,
        `  const p = String(n);`,
        `  return agent({ prompt: p, description: n });`,
        `}`,
        "function fast(n) { const x = grade(n); return agent({ prompt: x, description: n }); }",
        `phase("评审");`,
        `await fast("a");`,
      ].join("\n"));
      // fast（自带 agent 调用 + 调用候选 grade，span 最小先评估）依赖 grade 录取 → 拒；
      // grade 录取且实现点抑制。判别断言：无 fast("a") 调用点的幻影投影节点（旧代码
      // 在此产 ["a","评审"]；命运循环下两节点均为缺省分区通配——fast 体内自身派发点
      // 词法收口 + 体内 grade 派发点投影）
      expectRejectedProjection(dag, 2, { absentTemplateName: "a" });
    });

    it("候选互调环：命运循环停滞残留全拒（实现点词法收口，调用点零投影）", () => {
      const dag = parseValidatedDag([
        "function a(n) { const x = b(n); return agent({ prompt: x, description: n }); }",
        "function b(n) { const y = a(n); return agent({ prompt: y, description: n }); }",
        `phase("P");`,
        `await a("q");`,
      ].join("\n"));
      // a/b 互调（各含自身 agent 调用，均为合格候选）→ 互为未结算依赖 → 停滞 → 全拒；
      // 实现点词法收口（2 节点，phase("P") 前 → 缺省分区）；a("q") 调用点不产节点
      expectRejectedProjection(dag, 2, { absentTemplateName: "q" });
    });

    it("同名多候选声明：全部不投影（实现点保持词法收口）", () => {
      const dag = parseValidatedDag([
        `function h(n) { return agent({ prompt: "p", description: n }); }`,
        `async function h(name) { return await agent({ prompt: "q", description: name }); }`,
        `phase("P");`,
        `await h("x");`,
      ].join("\n"));
      // 两个 h 声明均不录取 → 实现点按词法收口（两节点，均在 phase("P") 之前）；h("x") 调用点不产节点
      expectRejectedProjection(dag, 2, { everyTemplateName: "*" });
    });

    it("helper 套 helper：内层投影、外层让位（外层体内对内层的调用仍投影，外层调用点不产节点）", () => {
      const dag = parseValidatedDag([
        `function inner(n) {`,
        `  return agent({ prompt: "p", description: n });`,
        `}`,
        `function outer(n) {`,
        `  return inner(n + "-x");`,
        `}`,
        `phase("P");`,
        `await outer("a");`,
      ].join("\n"));
      // outer 子树含已录取 inner → 让位；其体内 inner(n + "-x") 投影（n 非静态段通配），phase 取声明词法位置（缺省分区）
      expect(dag.nodes.length).toBe(1);
      expect(dag.nodes[0]?.templateName).toBe("${…}-x");
      expect(dag.nodes[0]?.phase).toBe(WORKFLOW_DAG_DEFAULT_PHASE);
    });

    it("parallel 实参内 helper 调用成组（成员投影）+ 解构绑定 dataflow", () => {
      const dag = parseValidatedDag([
        `function mk(n) {`,
        `  return agent({ prompt: "p", description: n });`,
        `}`,
        `phase("P");`,
        `const [a, b] = await parallel([mk("x"), mk("y")]);`,
        `await agent({ prompt: a.note, description: "down-" + b.id });`,
      ].join("\n"));
      expect(dag.parallelGroups.length).toBe(1);
      expect(dag.parallelGroups[0]?.nodeIds.length).toBe(2);
      expect(dag.nodes.map((n) => n.templateName)).toEqual(["x", "y", "down-${…}"]);
      expect(dag.edges.some((e) => e.kind === "dataflow")).toBe(true);
    });

    it("const 箭头 helper（zcAgent 形态）投影；零参 helper 不投影（实现点词法收口）", () => {
      const dag = parseValidatedDag([
        `const mk = async (name, persona) => {`,
        `  return await agent({ prompt: persona, description: name });`,
        `};`,
        `function zero() {`,
        `  return agent({ prompt: "p", description: "fixed" });`,
        `}`,
        `phase("P");`,
        `await mk("z", PERSONA);`,
        `await zero();`,
      ].join("\n"));
      // zero 不投影：实现点在声明遍历时即按词法收口（序在前）；mk 投影在调用点（序在后）
      expectNodeNamePhases(dag, [
        ["fixed", WORKFLOW_DAG_DEFAULT_PHASE],
        ["z", "P"],
      ]);
    });
  });
});
