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
// 跨工具通用纪律的收敛点（tool-declaration-slimming D1 单源化终态的注入段侧锚源）。
const SUBAGENT_LIST_INJECTOR_SRC = readFileSync(
  join(__dirname, "../../../injectors/subagent-list-injector.ts"),
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
// subagent tool 声明（tool-declaration-slimming D1 三层分工终态 + D2 锚词保留清单）
// ══════════════════════════════════════════════════════════════

/**
 * 【锚词保留清单 — subagent】（tool-declaration-slimming D2：压缩后的契约 = 逐锚词
 * grep，替代原逐字断言。每个锚词是一个弱模型回补点，删除前须确认有替代承载）：
 *
 * description 层（是什么 + 动作一览 + 边界 + 唯一正例）：
 *  A1  CRITICAL + sequential + SAME message —— 同消息多调用串行执行语义
 *  A2  Nested spawning + "Depth: N/10" —— 递归允许 + 深度上限（防错误拒绝嵌套）
 *  A3  TREE-SHAPED / SELF-CONTAINED / acceptance criteria / safety rail —— 递归判据
 *  A4  You cannot —— 能力边界（无同步结果 / 无流式输出）
 *  A5  {"action":"start","task" —— 唯一正例的平铺形态；"startParam" 必须不存在
 *  A6  "subagentId":"sa- —— id 生成格式锚（连字符，禁 sa_）
 *  A7  "agent":"/….md" —— agent ref 绝对路径形态（禁裸名示例）
 *  A8  session_read {"action":"result" —— 长结果截断取回指针（指向 defer 名单工具的
 *      交叉引用，D1 范围裁决②：保留原文，旧名改写归 U-B1）
 * promptGuidelines 层（使用纪律单点）：
 *  A9  Delegate FIRST —— 何时委派（原 description「When to delegate」段的承载点）
 *  A10 untrusted —— 注入防御（completion 即确认 + 不可信数据）
 *  A11 Anti-patterns 条含 list/cancel nested（listParam/cancelParam）不对称说明
 *  A12 `subagents` tool —— 批量入口交叉引用（同 A8 裁决保留）
 * schema 层（功能语义；required/enum/pattern/maxLength 由 structured-output
 * cross-package-contract 以真实 typebox 锁定）：
 *  A13 task/slug REQUIRED for action:'start'（action 条件必填的唯一文本锚）
 *  A14 model CASE-SENSITIVE + Resolution order（三层优先级链是功能语义）
 *  A15 idleTimeoutMs 缺省 300000 + TAIJI_SUBAGENT_IDLE_TIMEOUT_MS env 覆盖链
 *  A16 interrupt deprecated no-op（存量调用兼容语义声明）
 * 单源化负锚（D1：跨工具通用纪律只在注入段说一次）：
 *  A17 description/guidelines 零 poll/bash sleep/busy-wait；注入段含规则
 */
describe("subagent tool description — 锚词保留清单（D2 契约）", () => {
  it("体量上界：description ≤ 2400 字符（D2 目标区间 subagent 组 ≤8500 的分维护栏）", () => {
    // description 只承载「是什么 + 动作一览 + 边界 + 唯一正例」；使用纪律在
    // promptGuidelines（见 A9-A12），参数功能语义在 schema（A13-A16）。
    // 逼近上界时先砍正文冗余，不得砍锚词（A1-A8）。
    expect(DESCRIPTION.length).toBeLessThanOrEqual(2400);
  });

  it("执行语义锚（A1）+ 递归锚（A2/A3）+ 能力边界锚（A4）", () => {
    expect(DESCRIPTION).toMatch(/CRITICAL/i);
    expect(DESCRIPTION).toMatch(/sequential/);
    expect(DESCRIPTION).toMatch(/SAME message/i);
    expect(DESCRIPTION).toMatch(/Nested spawning/);
    expect(DESCRIPTION).toMatch(/Depth: N\/10/);
    const lower = DESCRIPTION.toLowerCase();
    expect(lower).toContain("tree-shaped");
    expect(lower).toContain("self-contained");
    expect(lower).toContain("acceptance criteria");
    expect(lower).toContain("safety rail");
    expect(DESCRIPTION).toMatch(/You cannot/);
    expect(DESCRIPTION.toLowerCase()).toContain("cannot");
  });

  it("正例锚（A5/A6/A7）：平铺形态唯一正例 + sa- id 格式 + agent 绝对路径，反例形态零残留", () => {
    expect(DESCRIPTION).toContain('"action":"start","task"');
    expect(DESCRIPTION).not.toContain('"startParam"');
    // subagentId 格式与 subagent-service 实际生成一致（sa-<uuid> 连字符）；
    // 弱模型照抄示例，前缀错（sa_ 下划线）会永远匹配不到真实 record。
    expect(DESCRIPTION).toContain('"subagentId":"sa-');
    expect(DESCRIPTION).not.toContain('"sa_');
    // agent ref 硬守卫拒绝裸名——示例必须教绝对路径 .md 形态（<available_subagents>
    // 注入的 <location> 形态）。
    expect(DESCRIPTION).not.toMatch(/"agent":"(?!\/)[^"]*"/);
    expect(DESCRIPTION).toMatch(/"agent":"\/[^"]*\.md"/);
  });

  it("defer 交叉引用锚（A8/A12）：session_read 截断指针与 `subagents` 批量入口引用保留原文", () => {
    // D1 范围裁决②：direct 工具文案指向 defer 名单工具的交叉引用保留原文——
    // 工具不在场时模型自然行为是经 tool_search 检索；旧名改写归 U-B1。
    // 源码文本内该指针是字符串字面量转义形态（{\"action\"...}）。
    expect(SUBAGENT_TOOL_SRC).toContain('session_read {\\\"action\\\":\\\"result\\\"');
  });

  it("promptGuidelines 承载使用纪律（A9-A12）：何时委派 / 注入防御 / nested 不对称 / 批量入口", () => {
    const guidelines = SUBAGENT_TOOL_SRC;
    expect(guidelines).toContain("Delegate FIRST");
    expect(guidelines).toContain("untrusted");
    expect(guidelines).toMatch(/list\/cancel stay nested \(listParam\/cancelParam\)/);
    expect(guidelines).toContain("`subagents` tool");
  });

  it("agent 字段通用化（防漂移）：description 不写死 agent 名，指向 <available_subagents>", () => {
    // agent 枚举随 agents/*.md 动态变化，防漏职责由每 turn 注入的 <available_subagents>
    // 列表承担；工具声明只保留通用指引。
    expect(SUBAGENT_TOOL_SRC).toContain("available_subagents");
    expect(DESCRIPTION).not.toMatch(/orchestrator|code-reviewer|context-builder|worker/);
  });

  it("schema 功能语义锚（A13-A16）", () => {
    // 拒绝条件清单不进 schema 说明（core handler 运行时错误已带恢复动作，D1）；
    // 必填性 / 优先级链 / 缺省值 / 兼容语义是 schema 侧唯一文本锚。
    const schemaSrc = readFileSync(join(__dirname, "../subagent-tool-schema.ts"), "utf-8");
    expect(schemaSrc).toContain("REQUIRED for action:'start'");
    expect(schemaSrc).toContain("CASE-SENSITIVE");
    expect(schemaSrc).toContain("Resolution order");
    expect(schemaSrc).toContain("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS");
    expect(schemaSrc).toContain("Deprecated, no effect");
  });

  it("勿等待纪律单源化（A17）：description/guidelines 零 poll 措辞，规则只在注入段说一次（D1）", () => {
    // 「结果自动通知送达、勿 bash sleep/busy-wait/poll 等待」是 subagent/subagents/
    // workflow 三工具共享的调度纪律，收敛到 <available_subagents> 注入段说一次。
    // completion 即确认的 subagent 特有语义由 A10 锚（untrusted）承接。
    expect(DESCRIPTION).not.toMatch(/bash sleep|busy-wait|bash-sleeping|polling/i);
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("busy-wait, or poll");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("SUBAGENT_DISPATCH_SHARED_RULES");
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

  it("跨工具预算/模型/勿等待纪律单源化：工具文案零残留，规则只在注入段说一次（D1）", () => {
    // tool-declaration-slimming D1 信息单源化：tokens/time「仅用户明确要求才设」、
    // model/thinkingLevel「缺省继承主 agent」与「勿 poll/bash sleep 等待」原在本工具
    // promptGuidelines 与 schema 说明重复陈述，现收敛到 <available_subagents> 注入段
    // （subagent-list-injector.ts SUBAGENT_DISPATCH_SHARED_RULES）说一次——工具声明
    // 文案零残留 + 注入段含规则。call shape 示例里的 tokens/time 字段展示保留（参数
    // 存在性由 schema 承载，何时设由注入段纪律约束）。
    const guidelines = promptGuidelinesText(TOOL_WORKFLOW_SRC);
    expect(guidelines).not.toContain("Do NOT set tokens/time unless the user explicitly requests");
    expect(TOOL_WORKFLOW_SRC).not.toContain("omit = unlimited (default)");
    expect(TOOL_WORKFLOW_SRC).not.toContain("Omit to inherit the main agent's model");
    expect(guidelines).not.toContain("bash sleep or poll status");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("busy-wait, or poll");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("explicitly requests a limit");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("inherit the main agent's model");
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
