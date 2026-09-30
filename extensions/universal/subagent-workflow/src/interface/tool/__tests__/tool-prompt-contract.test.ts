/**
 * tool 提示词 / schema 契约合一（2026-09-27 测试审计组 6：三源并一文件）。
 *
 * 断言对象分两类：
 * 1. 源码文本断言（读 .ts 文本非 import——避免 pi-ai/typebox/pi-tui 等值导入的
 *    重 mock 链）：
 *    - subagent tool description 行为约束器契约（原 subagent-tool-prompt.test.ts）。
 *      agent（LLM）决策时唯一能看到的 tool 元信息就是 description；本组断言锁
 *      调用信号（何时委派）、能力边界（cannot）、反模式密度、注入防御等约束措辞，
 *      防后续重构把约束删掉或弱化。
 *    - workflow tool promptGuidelines 契约（原 workflow-tool-prompt.test.ts）。
 *      若 promptGuidelines 不提及内置 workflow 与交叉引用，LLM 无法知道有现成
 *      编排工具可用，会倾向自己 generate 脚本或瞎猜 name。
 *    - runtime handler 错误文案 Correct 正例：subagent 侧锚 core 源码（D6② 下沉
 *      后文案权威源在 core subagent-actions-core）；workflow 侧原 grep 条已删，
 *      行为版在 tool-workflow.test.ts 平铺检测 throw 条。
 * 2. schema 数据断言（JSON 往返剥离 typebox 类型包装，只看数据形态）：
 *    collect / conversation 退役契约（原 subagent-schema-collect.test.ts）。
 *    required 断言条已删——本包 vitest 把 typebox alias 到 mocks/typebox.ts
 *    （丢 options），required 恒缺省致断言提前 return 零执行；真实 typebox 下的
 *    required/enum/pattern 锁由 structured-output cross-package-contract.test.ts
 *    承担。
 *
 * 框架：vitest（禁 node:test）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { SubagentParams } from "../subagent-tool-schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 源码文本源（读源码而非 import，避免 mock 链）──

const SUBAGENT_TOOL_SRC = readFileSync(join(__dirname, "../subagent-tool.ts"), "utf-8");
const TOOL_WORKFLOW_SRC = readFileSync(join(__dirname, "../tool-workflow.ts"), "utf-8");
const TOOL_WORKFLOW_SCRIPT_SRC = readFileSync(
  join(__dirname, "../tool-workflow-script.ts"),
  "utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
  const m = src.match(/description:\s*`([\s\S]*?)`,/);
  if (!m) throw new Error("description template literal not found");
  return m[1];
}

const DESCRIPTION = extractDescription(SUBAGENT_TOOL_SRC);

/** 截取 promptGuidelines 数组文本——防 KNOWN_ARG_KEYS 等注释/代码中的裸词污染断言。
 * 数到数组闭合（跳过字符串字面量内的括号，exec-review F9：'],' 序列静默截断）。 */
function promptGuidelinesText(src: string): string {
  const start = src.indexOf("promptGuidelines: [");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

// ── schema 数据源（原 subagent-schema-collect.test.ts）──

/** 运行时守卫（不用裸类型断言：extensions taste/no-unsafe-cast 规范）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** schema 的可检视图：经 JSON 往返剥离 typebox 类型包装，只看数据形态。 */
function schemaData(): Record<string, unknown> {
  const raw: unknown = JSON.parse(JSON.stringify(SubagentParams));
  if (!isRecord(raw)) throw new Error("SubagentParams is not an object schema");
  return raw;
}

function properties(): Record<string, unknown> {
  const props = schemaData().properties;
  if (!isRecord(props)) throw new Error("SubagentParams has no properties");
  return props;
}

// ══════════════════════════════════════════════════════════════
// subagent tool description（原 subagent-tool-prompt.test.ts）
// ══════════════════════════════════════════════════════════════

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
    // 通用化约束：不写死任何具体 agent 名（名字随 agents/*.md 动态变化）。
    // 断言目标收窄到 DESCRIPTION 串（原打 SUBAGENT_TOOL_SRC 全文——文件任意位置
    // 出现 worker 等词即误红，如 import 路径 / 注释 / 标识符）。
    expect(DESCRIPTION).not.toMatch(/orchestrator|code-reviewer|context-builder|worker/);
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

// ══════════════════════════════════════════════════════════════
// workflow tool promptGuidelines（原 workflow-tool-prompt.test.ts）
// ══════════════════════════════════════════════════════════════

describe("U1: workflow tool prompt mentions built-in workflows", () => {
  it("TC4a: promptGuidelines 不含具体内置 args 枚举（m4 瘦身——参数知识在 read location）", () => {
    // m4：BUILT-IN 枚举删除，发现职责转移给 <available_workflows> 注入段 + read location。
    // 截取 promptGuidelines 段断言（"batch1..batchN" 等在 KNOWN_ARG_KEYS 注释中出现）。
    const guidelines = promptGuidelinesText(TOOL_WORKFLOW_SRC);
    expect(guidelines).not.toContain("chain (sequential");
    expect(guidelines).not.toContain("args: task");
    expect(guidelines).not.toContain("batch1..batchN");
    expect(guidelines).not.toContain("chain/parallel/scatter-gather/map-reduce");
  });

  it("TC4b: promptGuidelines 引导 read location 获取参数细节（info 已砍，ADR-0003 D5）", () => {
    const guidelines = promptGuidelinesText(TOOL_WORKFLOW_SRC);
    expect(guidelines).toContain("read the <location>");
    expect(guidelines).toContain("script file");
    // info action 已砍，引导语不再含 workflow info
    expect(guidelines).not.toContain("workflow info");
  });

  it("tool-workflow.ts promptGuidelines 含 workflow-script list 交叉引用", () => {
    // LLM 需要知道"先 list 再 run"的发现路径——两个 tool 之间必须有交叉引用。
    // 文本可能跨字符串拼接行，分别断言两个关键词都存在。
    expect(TOOL_WORKFLOW_SRC).toContain("workflow-script");
    expect(TOOL_WORKFLOW_SRC).toMatch(/action.*list/i);
  });

  it("tool-workflow.ts promptGuidelines 含 run action 的正例", () => {
    // 给出 run 调用的 JSON 示例，LLM 才知道参数格式（action/name/args 嵌套）。
    expect(TOOL_WORKFLOW_SRC).toContain('{"action":"run","name":"');
  });

  it("promptGuidelines 含 JSON 调用正例（run/status/lifecycle）", () => {
    // 弱模型信任 schema 结构信号 > 文本信号，容易把 args 子字段平铺到顶层。
    // promptGuidelines 必须有完整 JSON 调用正例，让模型能直接照抄 {"action":"run",...} 嵌套结构。
    expect(TOOL_WORKFLOW_SRC).toContain('{"action":"run"');
    expect(TOOL_WORKFLOW_SRC).toContain("Call shapes (JSON)");
  });

  it("promptGuidelines 含参数结构反例（args 平铺到顶层）", () => {
    // 显式说明 args 子字段不能平铺到顶层，必须嵌在 args 里。
    expect(TOOL_WORKFLOW_SRC).toContain("args");
    expect(TOOL_WORKFLOW_SRC).toContain("Anti-patterns");
    expect(TOOL_WORKFLOW_SRC).toContain("top level");
  });

  it("KNOWN_ARG_KEYS 退役守卫（参数知识源 = schema 动态集 argKeysFromMeta，静态枚举不得复活）", () => {
    // 原「runtime handler 错误文案含 Correct 正例 + 平铺检测」grep 条已删：
    // 行为版（Correct 文案 / findFlattenedArgKeys / argKeysFromMeta 真实触发）
    // 在 tool-workflow.test.ts 平铺检测 throw 条与 TC3i 接线条锁定。
    // 退役负向守卫保留：KNOWN_ARG_KEYS 曾是静态已知键枚举，m6 后数据源为动态
    // argKeysFromMeta（schema 即 SSOT）——静态枚举不得复活。
    expect(TOOL_WORKFLOW_SRC).not.toMatch(/const\s+KNOWN_ARG_KEYS/);
  });

  it("tool-workflow-script.ts list action 的 promptGuidelines 含 workflow run 交叉引用", () => {
    // 反向交叉引用：list 的指引里要提到用 workflow tool 的 run action 启动脚本。
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toMatch(/workflow.*tool.*run|run.*workflow.*tool/i);
  });

  it("tool-workflow.ts promptGuidelines 强化 anti-generate（直接 run，不要 generate）", () => {
    // session 证据：弱模型看到 workflow list 后倾向 workflow-script generate 而非直接 run。
    // 提示词必须显式禁止对内置编排使用 generate。
    expect(TOOL_WORKFLOW_SRC).toContain("NEVER use workflow-script action:generate");
  });

  it("tool-workflow-script.ts promptGuidelines 强化 anti-generate（CRITICAL ANTI-PATTERN）", () => {
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toContain("CRITICAL ANTI-PATTERN");
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toContain("NEVER generate");
  });

  it("promptGuidelines + parameter description 标注 budget 默认不限制（B/C：除非用户要求否则别设）", () => {
    // budget 是 run 级参数，运行时 maxTokens===undefined → 不限制（budget.ts isExceeded 守卫）。
    // 但 call shape 示例展示了 tokens/time 字段，LLM 会误以为每次都该填。
    // promptGuidelines 必须明确 "Do NOT set ... unless user explicitly requests",
    // parameter description 同步标 "omit = unlimited"，双重约束压过示例的反引导。
    const guidelines = promptGuidelinesText(TOOL_WORKFLOW_SRC);
    expect(guidelines).toContain("Do NOT set tokens/time unless the user explicitly requests");
    expect(TOOL_WORKFLOW_SRC).toContain("omit = unlimited (default)");
  });
});

// ══════════════════════════════════════════════════════════════
// subagent start schema 退役契约（原 subagent-schema-collect.test.ts）
// ══════════════════════════════════════════════════════════════

describe("subagent start schema: collect param retired (批量入口 = subagents tool)", () => {
  it("collect 字段已删（schema 层不可再自报：批量编排唯一入口是 `subagents` tool）", () => {
    expect(Object.keys(properties())).not.toContain("collect");
    // 数据面全量断言（描述文本里的 collect 措辞随之删除）：序列化后零残留。
    expect(JSON.stringify(schemaData())).not.toContain("collect");
  });

  it("sits flattened at top level beside task/slug/engine (拍平契约不变)", () => {
    const props = Object.keys(properties());
    for (const sibling of ["task", "slug", "engine"]) {
      expect(props).toContain(sibling);
    }
  });

  it("conversation param is deleted (modeless 波5：模式消亡，schema 层不可再自报)", () => {
    expect(Object.keys(properties())).not.toContain("conversation");
  });
});
