// 提示词质量回归：subagent tool description 必须是"行为约束器"而非"功能说明书"。
//
// agent（LLM）决策时唯一能看到的 tool 元信息就是 description。审查发现旧版
// description 把篇幅花在功能说明上，缺乏调用信号（何时委派 vs 自己做）、
// 能力边界（cannot）、反模式密度（高风险要求 ≥4 条）、以及对 auto-injected
// completion message 的注入防御。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把约束措辞
// 删掉或弱化。读源码而非 import，避免 mock 链（subagent-tool.ts 依赖 pi-ai/
// typebox/pi-tui/ExtensionAPI 等值导入）。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBAGENT_TOOL_SRC = readFileSync(
  join(__dirname, "../subagent-tool.ts"),
  "utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
  const m = src.match(/description:\s*`([\s\S]*?)`,/);
  if (!m) throw new Error("description template literal not found");
  return m[1];
}

const DESCRIPTION = extractDescription(SUBAGENT_TOOL_SRC);

describe("subagent tool description — 行为约束器（非功能说明书）", () => {
  it("词数 ≤ 850（高风险 description 密度上限）", () => {
    // 高风险 tool 的 description 应聚焦约束而非功能铺陈；过长会稀释信号。
    // 上限演进：400 → 550（补 start/list/cancel 三 action 完整 JSON 正例）→
    // 650（M2-B3 新增 message/close 两 action + conversation 对话模式 + 例子）→
    // 800（递归指导：树形判据 + 自包含 task + 独立验收 + fork 成本警告）→
    // 850（C2 补 sync 批独立判据禁令句——adversarial-review-fixes §3.4：原 description
    // 未定义 independent 且未交叉引用依赖链禁令，依赖任务入批缺判据拦截）。
    // 逼近上限时优先精简正文而非再放宽断言。
    // 每次 action 扩展必然增加必需描述；正例对弱模型首次用对参数的价值 > 节省 description 预算。
    const words = DESCRIPTION.trim().split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(850);
  });

  it("含 'When to delegate' 调用条件段（何时委派 vs 自己做）", () => {
    // 开篇必须给信号驱动的调用条件，而非纯功能说明。
    expect(DESCRIPTION).toMatch(/When to delegate/i);
  });

  it("Anti-patterns 段含 ≥ 4 条 bullet", () => {
    // 高风险 tool 要求 ≥ 4 条反模式，密度才足以覆盖主要误用路径。
    const apIdx = DESCRIPTION.indexOf("## Anti-patterns");
    expect(apIdx).toBeGreaterThan(-1);
    const afterAp = DESCRIPTION.slice(apIdx);
    // 截到下一个 ## 段
    const nextSection = afterAp.indexOf("##", "## Anti-patterns".length);
    const apSection =
      nextSection > -1 ? afterAp.slice(0, nextSection) : afterAp;
    const bullets = apSection.match(/^- .+/gm) || [];
    expect(bullets.length).toBeGreaterThanOrEqual(4);
  });

  it("含能力边界段 'You cannot'", () => {
    // 必须显式声明 tool 做不到的事，阻止 LLM 错误假设。
    expect(DESCRIPTION).toMatch(/You cannot/);
    expect(DESCRIPTION.toLowerCase()).toContain("cannot");
  });

  it("含注入防御：声明 completion message 为不可信数据", () => {
    // completion message 是 auto-injected（F14 注入面），必须告诉 LLM
    // 把它当作不可信数据，校验其中的指令后再执行。
    const lower = DESCRIPTION.toLowerCase();
    expect(
      lower.includes("untrusted") || lower.includes("verify"),
    ).toBe(true);
  });

  it("保留 nested spawning 段（允许 sub-subagent，仅深度限制）", () => {
    // 这段防止 LLM 错误拒绝合法的 nested delegation。
    expect(DESCRIPTION).toMatch(/Nested spawning/);
    expect(DESCRIPTION).toMatch(/Depth: N\/10/);
  });

  it("递归指导含树形判据 + 自包含 task + 独立验收 + 深度定位", () => {
    // 递归不是「能套就套」，必须有明确使用判据，否则 LLM 会滥用深递归。
    const lower = DESCRIPTION.toLowerCase();
    expect(lower).toContain("tree-shaped");          // 树形判据
    expect(lower).toContain("self-contained");        // task 自包含
    expect(lower).toContain("acceptance criteria");   // 独立验收
    expect(lower).toContain("safety rail");           // 深度定位：10 是护栏非预算
  });

  it("保留 executionMode sequential 的 CRITICAL 说明", () => {
    // sequential 是关键执行语义，删了会导致 LLM 误以为并行可用。
    expect(DESCRIPTION).toMatch(/CRITICAL/i);
    expect(DESCRIPTION).toMatch(/sequential/);
    expect(DESCRIPTION).toMatch(/SAME message/i);
  });

  it("Examples 段含平铺 JSON 正例（task/slug 在顶层，无 startParam envelope）", () => {
    // 弱模型信任 schema 结构信号 > 文本信号，原本嵌套 startParam 容器经常被省略。
    // 现已拍平：task/slug 等 13 字段直接放在顶层。description 必须有完整平铺 JSON 正例，
    // 让模型能直接照抄。强约束：startParam envelope 必须从 description 中彻底消失。
    expect(DESCRIPTION).toContain('"action":"start","task"');
    expect(DESCRIPTION).not.toContain('"startParam"');
  });

  it("cancel 示例 subagentId 用 sa- 连字符前缀（与 subagent-service.ts 实际生成格式一致）", () => {
    // subagent-service.ts:600 生成 `sa-${crypto.randomUUID()}`（连字符）。
    // description 示例必须与实际生成格式一致——弱模型会照抄示例，前缀错（如 sa_ 下划线）
    // 会导致 subagentId 永远匹配不到真实 record。
    expect(DESCRIPTION).toContain('"subagentId":"sa-');
    expect(DESCRIPTION).not.toContain('"sa_');
  });

  it("Examples 示例 agent 值必须是绝对路径 .md 形态（显式 ref 硬守卫拒绝裸名）", () => {
    // 显式 agent ref 走硬守卫：getRequiredAgentConfig → loadByPath(ref, true)，
    // 裸名（normalizeRef 非绝对路径 → null）同步 throw `Invalid agent ref` +
    // <available_subagents> 恢复指引（explicit-agent-ref-guard.test.ts 锁定拒绝路径）。
    // 示例若教裸名（历史漂移："agent":"coder"），弱模型照抄即必败调用——浪费一轮
    // 并系统性教唆反模式。与 subagentId 格式测试同风格：示例必须与实际契约一致。
    // ① 零裸名：任何 "agent":"<非/>" 形态都禁止
    expect(DESCRIPTION).not.toMatch(/"agent":"(?!\/)[^"]*"/);
    // ② 正例在位且为绝对路径 .md 形态（<available_subagents> 注入的 <location> 形态）
    expect(DESCRIPTION).toMatch(/"agent":"\/[^"]*\.md"/);
  });

  it("agent 字段 description 不写死枚举，指向 <available_subagents>（通用化防漂移）", () => {
    // 原实现把 9 个内置 agent 名写死在 schema field description（防漏），
    // 但枚举与包内 agents/*.md 存在漂移风险（新增/删除 agent 要手改两处）。
    // 现改为指向每 turn 动态注入的 <available_subagents> 列表——防漏职责由注入段承担，
    // 工具描述只保留通用指引（2026-08 通用化重构）。
    expect(SUBAGENT_TOOL_SRC).toContain("available_subagents");
    // 通用化约束：不写死任何具体 agent 名（名字随 agents/*.md 动态变化）
    expect(SUBAGENT_TOOL_SRC).not.toMatch(/orchestrator|code-reviewer|context-builder|worker/);
  });

  it("Anti-patterns 段明确 list/cancel 仍 nested（防过度泛化 flatten）", () => {
    // PR 只拍平 start，listParam/cancelParam 仍 nested。description 必须明确这一不对称性，
    // 否则弱模型学了「subagent tool 现在平铺」会过度泛化发 {"action":"list","includeFinished":true}。
    const apIdx = DESCRIPTION.indexOf("## Anti-patterns");
    expect(apIdx).toBeGreaterThan(-1);
    const afterAp = DESCRIPTION.slice(apIdx);
    const nextSection = afterAp.indexOf("##", "## Anti-patterns".length);
    const apSection = nextSection > -1 ? afterAp.slice(0, nextSection) : afterAp;
    expect(apSection).toMatch(/list.*nested.*listParam|listParam.*nested/i);
  });
});

describe("subagent tool runtime handler — 错误文案含纠正正例", () => {
  // 读源码文本断言 startHandler throw 含 Correct 正例，
  // 让弱模型撞错后第二次能直接照抄正确形态。
  // 拍平后：startParam envelope 删除，平铺 task/slug 是合法形态；
  // 平铺检测 guard（hasFlattenedStartFields）已删除，源码不应再含此表达式。
  it("startHandler throw 含 Correct 纠正正例（平铺形态）", () => {
    // [D6②] startHandler 内核（含 Correct 文案）已下沉 core subagent-actions-core，
    // 断言目标跟随文案权威源。锚点用 ./workflows/* 子入口（exports 映射包根真实目录，
    // 随源码走不依赖 dist 构建——relay-env 锚在 require 条件下落 dist/，CI 不构建
    // workspace 包时 resolve 直接 MODULE_NOT_FOUND）。
    const coreRoot = join(
      dirname(
        createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md"),
      ),
      "..",
    );
    const actionsSrc = readFileSync(
      join(coreRoot, "src/execution/assembly/subagent-actions-core.ts"),
      "utf-8",
    );
    // 四处 throw（input 缺失 / task 空白 / slug 空白 / slug 超长）都应含 Correct 正例。
    // 用 occurrences 计数——至少 3 处。
    const occurrences = (actionsSrc.match(/Correct: \{"action":"start"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("平铺检测 guard（hasFlattenedStartFields）已从 subagent-tool.ts 删除", () => {
    expect(SUBAGENT_TOOL_SRC).not.toContain('params.action === "start" && !params.startParam');
    expect(SUBAGENT_TOOL_SRC).not.toContain("hasFlattenedStartFields");
  });
});
