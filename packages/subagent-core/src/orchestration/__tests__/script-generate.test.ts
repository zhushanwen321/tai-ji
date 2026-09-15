// src/orchestration/__tests__/script-generate.test.ts
//
// C4-core-script-pipeline（convergence W4）单元测试：generate 校验管线下沉的
// 行为锁定。覆盖 §4.2 W4 门全部条目：
// - 五道闸逐字文案（期望串按 pi 现版 actionGenerate 源码逻辑手工构造——
//   pi 侧行为不变是 CA2 前提，文案改动必须同步两处）；
// - round-trip 失败报错含 YAML 诊断与 line/col（parseResourceMetaDetailed
//   真实调用不 mock，与 pi 测试 TC2/TC5 同原则）；
// - 合法样本落 tmp：目录参数注入生效（真实落盘断言，非 mock fs）；
// - 缺省目录 = pi 布局（相对 cwd resolve，pi 现行为不变）；
// - barrel 逐名探针（红线 9）。
// 设计权威源：docs/design/subagent-core-convergence.md §3.2 D-6。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as subagentCore from "../../index.ts";
import { parseResourceMetaDetailed } from "../../shared/meta-parser.ts";
import {
  generateWorkflowScript,
  type GenerateWorkflowScriptOptions,
  type GenerateWorkflowScriptResult,
} from "../script-generate.ts";
import { DEFAULT_WORKFLOW_SAVED_DIR, type WorkflowDirOptions } from "../workflow-files.ts";

// ============================================================
// 样本（构造逻辑对齐 pi 侧 tool-workflow-script-generate.test.ts）
// ============================================================

const PI_META_VALID = `/* @pi-meta
name: test-wf
description: valid new format
phases: [a, b]
parameters:
  type: object
  properties:
    task: { type: string }
  required: [task]
*/
const agent = require("./agent");
agent("worker", { task: $ARGS.task });
`;

const PI_META_MALFORMED = `/* @pi-meta
name: test-wf
description: bad
  broken: indent
phases: [a]
*/
const agent = require("./agent");
agent("w");
`;

const PI_META_REGEX_SINGLE_BS = `/* @pi-meta
name: test-wf
description: regex
phases: [A]
parameters:
  type: object
  patternProperties:
    "^batch\\d+$": { type: string }
*/
const agent = require("./agent");
agent("w");
`;

const LEGACY_CONST_META = `const meta = {
  name: "legacy-wf",
  description: "legacy format",
  phases: ["a"]
};
const agent = require("./agent");
agent("w");
`;

const NO_META = `const agent = require("./agent");
agent("w");
`;

const ESM_IMPORT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
import { foo } from "bar";
const agent = require("./agent");
agent("w");
`;

const ESM_EXPORT_NON_META = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const agent = require("./agent");
export const foo = 1;
agent("w");
`;

const NO_AGENT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const x = 1;
`;

const SYNTAX_ERROR = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const agent = require("./agent");
agent("w";
`;

// ============================================================
// 期望串（pi 现版 actionGenerate 文案逐字手工构造）
// ============================================================

/**
 * round-trip 报错文案模板——pi 版 tool-workflow-script.ts actionGenerate
 * 的模板逐字复制（含源码字面 `(\\d not \d)` 的历史形态：模板字符串里 `\\d`
 * 渲染 `\d`、`\d` 渲染 `d`；两处字符级一致即运行时逐字一致）。
 */
function expectedRoundtripError(detailed: {
  error: string;
  linePos?: { line: number; col: number };
}): string {
  const loc = "linePos" in detailed && detailed.linePos
    ? ` (line ${detailed.linePos.line}, col ${detailed.linePos.col})`
    : "";
  return `Generated /* @pi-meta */ YAML cannot be parsed${loc}: ${detailed.error}. Common causes: YAML indent errors, patternProperties regex must use double backslash (\\d not \d), or a stray star-slash inside the YAML body. Fix the meta block and retry.`;
}

/** 非.ok 分支的错误文案（窄化辅助：ok 分支直接 fail）。 */
function errorOf(r: GenerateWorkflowScriptResult): string {
  if (r.ok) throw new Error("expected failure result, got success");
  return r.error;
}

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "subagent-core-gen-"));
}

// ============================================================
// 五道闸（文案逐字对齐 pi 现版）
// ============================================================

describe("generateWorkflowScript 校验闸（文案逐字对齐 pi 现版）", () => {
  it("缺 name/script → 拒（防御性文案逐字）", () => {
    expect(errorOf(generateWorkflowScript("", "x"))).toBe(
      "generate requires 'name' and 'script' parameters",
    );
    expect(errorOf(generateWorkflowScript("x", ""))).toBe(
      "generate requires 'name' and 'script' parameters",
    );
  });

  it("ESM import → 拒（文案逐字）", () => {
    const tmpRoot = makeTmpRoot();
    try {
      const r = generateWorkflowScript("esm-wf", ESM_IMPORT, { tmpDir: tmpRoot });
      expect(errorOf(r)).toBe(
        "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead.",
      );
      expect(existsSync(join(tmpRoot, "esm-wf.js"))).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("ESM export（非 meta）→ 拒（文案逐字）", () => {
    const r = generateWorkflowScript("exp-wf", ESM_EXPORT_NON_META);
    expect(errorOf(r)).toBe(
      "Script uses ESM 'export' (non-meta). Use 'const meta = {...}' at top level instead.",
    );
  });

  it("无 meta 声明 → 拒（文案逐字）", () => {
    const r = generateWorkflowScript("nometa-wf", NO_META);
    expect(errorOf(r)).toBe(
      "Script must contain a meta declaration: a /* @pi-meta */ YAML block comment (preferred) or legacy const meta = { ... }. The block has the form: a block comment starting with /* @pi-meta followed by YAML (name/description/phases/parameters?/usage?), closed by */ on its own line.",
    );
  });

  it("无 agent() 调用 → 拒（文案逐字）", () => {
    const r = generateWorkflowScript("noagent-wf", NO_AGENT);
    expect(errorOf(r)).toBe(
      "Script does not contain any agent() calls. A workflow must call agent() at least once.",
    );
  });

  it("语法错误 → 拒（前缀逐字 + V8 诊断非空）", () => {
    const r = generateWorkflowScript("synerr-wf", SYNTAX_ERROR);
    const err = errorOf(r);
    expect(err.startsWith("Syntax error in script: ")).toBe(true);
    expect(err.length > "Syntax error in script: ".length).toBe(true);
  });

  it("malformed @pi-meta YAML → round-trip 拒，报错含 line/col + 未落盘", () => {
    const tmpRoot = makeTmpRoot();
    try {
      const r = generateWorkflowScript("bad-wf", PI_META_MALFORMED, { tmpDir: tmpRoot });
      const err = errorOf(r);
      // 行列信息保留（ERR4：LLM 自纠正依赖）
      expect(err).toMatch(/ \(line \d+, col \d+\)/);
      // 期望串 = 同一 parser 实测值 + pi 源码模板手工展开 → 逐字一致
      const detailed = parseResourceMetaDetailed(PI_META_MALFORMED, "workflow");
      expect(detailed.ok).toBe(false);
      if (!detailed.ok) {
        expect(detailed.linePos).toBeDefined();
        expect(err).toBe(expectedRoundtripError(detailed));
      }
      expect(existsSync(join(tmpRoot, "bad-wf.js"))).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("patternProperties 单反斜杠正则 → round-trip 拒（LLM 高频错，含行列）", () => {
    const r = generateWorkflowScript("regex-wf", PI_META_REGEX_SINGLE_BS);
    const err = errorOf(r);
    expect(err).toMatch(/ \(line \d+, col \d+\)/);
    const detailed = parseResourceMetaDetailed(PI_META_REGEX_SINGLE_BS, "workflow");
    expect(detailed.ok).toBe(false);
    if (!detailed.ok) {
      expect(err).toBe(expectedRoundtripError(detailed));
    }
  });
});

// ============================================================
// 合法样本落 tmp（目录参数注入生效）
// ============================================================

describe("generateWorkflowScript 合法样本落 tmp", () => {
  it("注入 tmpDir：真实落盘指定目录，内容逐字节一致", () => {
    const tmpRoot = makeTmpRoot();
    try {
      const r = generateWorkflowScript("my-wf", PI_META_VALID, { tmpDir: tmpRoot });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      expect(r.path).toBe(resolve(tmpRoot, "my-wf.js"));
      expect(existsSync(r.path)).toBe(true);
      expect(readFileSync(r.path, "utf-8")).toBe(PI_META_VALID);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("legacy const meta（过渡期）→ 过闸落盘（无 @pi-meta 跳过 round-trip）", () => {
    const tmpRoot = makeTmpRoot();
    try {
      const r = generateWorkflowScript("legacy-wf", LEGACY_CONST_META, { tmpDir: tmpRoot });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      expect(existsSync(r.path)).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("缺省 tmpDir = pi 布局 <cwd>/.pi/workflows/.tmp（pi 现行为不变）", () => {
    const fakeCwd = mkdtempSync(join(tmpdir(), "subagent-core-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
    try {
      const r = generateWorkflowScript("def-wf", PI_META_VALID);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      expect(r.path).toBe(join(fakeCwd, ".pi", "workflows", ".tmp", "def-wf.js"));
      expect(existsSync(r.path)).toBe(true);
    } finally {
      cwdSpy.mockRestore();
      rmSync(fakeCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ============================================================
// barrel 逐名探针（红线 9：新增导出必须进 barrel，逐名列出）
// ============================================================

describe("barrel exports probe", () => {
  it("值导出逐名可达（typeof function）", () => {
    const valueExports = [
      "generateWorkflowScript",
      "saveWorkflow",
      "deleteWorkflow",
    ] as const;
    const barrel = subagentCore as Record<string, unknown>;
    for (const name of valueExports) {
      expect(typeof barrel[name], `barrel 缺值导出: ${name}`).toBe("function");
    }
  });

  it("缺省目录常量经 barrel 可达（值 = pi 布局）", () => {
    const barrel = subagentCore as Record<string, unknown>;
    expect(barrel["DEFAULT_WORKFLOW_TMP_DIR"]).toBe(".pi/workflows/.tmp");
    // DEFAULT_WORKFLOW_SAVED_DIR 已随 2026-09-13 barrel 收窄出公共面（仅测试消费），
    // 改深路径断言同名常量值不变（守卫强度不降）。
    expect(DEFAULT_WORKFLOW_SAVED_DIR).toBe(".pi/workflows");
  });

  it("类型导出经 barrel 可引用（typecheck 即探针）", () => {
    const genOpts: GenerateWorkflowScriptOptions = { tmpDir: "/tmp/x" };
    const dirOpts: WorkflowDirOptions = { tmpDir: "/tmp/x", savedDir: "/tmp/y" };
    let result: GenerateWorkflowScriptResult = { ok: true, path: "/p" };
    result = { ok: false, error: "e" };
    expect(genOpts.tmpDir).toBe("/tmp/x");
    expect(dirOpts.savedDir).toBe("/tmp/y");
    expect(result.ok).toBe(false);
  });
});
