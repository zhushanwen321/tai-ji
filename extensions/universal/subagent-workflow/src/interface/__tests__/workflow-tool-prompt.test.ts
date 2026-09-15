// U1: workflow tool 提示词包含内置 workflow 清单 + 交叉引用。
//
// agent（LLM）决策时唯一能看到的 tool 元信息就是 description + promptGuidelines。
// 若这些文本里不提及内置 workflow（chain/parallel/scatter-gather/map-reduce），
// LLM 无法知道有现成的编排工具可用，会倾向自己 generate 脚本或瞎猜 name。
//
// 本测试用源码断言（读 .ts 文件文本）验证提示词内容，避免 import 重 mock 链
// （tool-workflow.ts 依赖 pi-ai/typebox/pi-tui/lifecycle 等值导入）。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_WORKFLOW_SRC = readFileSync(
  join(__dirname, "../tool-workflow.ts"),
  "utf-8",
);
const TOOL_WORKFLOW_SCRIPT_SRC = readFileSync(
  join(__dirname, "../tool-workflow-script.ts"),
  "utf-8",
);

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

  it("runtime handler 错误文案含 Correct 纠正正例 + 平铺检测（m6：动态参数集）", () => {
    // 读源码文本断言 actionRun/必填校验的错误文案含 Correct 正例，
    // 让弱模型撞错后第二次能直接照抄正确形态。m6 后平铺检测数据源为动态
    // argKeysFromMeta（schema 即 SSOT）——断言新机制存在（KNOWN_ARG_KEYS 已删）。
    expect(TOOL_WORKFLOW_SRC).toContain("Correct:");
    expect(TOOL_WORKFLOW_SRC).toContain("findFlattenedArgKeys");
    expect(TOOL_WORKFLOW_SRC).toContain("argKeysFromMeta");
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
