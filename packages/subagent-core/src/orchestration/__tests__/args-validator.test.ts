// m3: args-validator 单元测试（TC1-TC7）
//
// TC1  校验通过：review-fix-loop 真实 schema 的合法 args
// TC2  必填缺失 fail → ArgsValidationError
// TC3  类型错误 + null/空串 required fail（design-review major-1 回归）
// TC4  字符串 coerce 原地生效（m2 MAJOR-1 m3 闭环）
// TC5  无 parameters 跳过（安全退化）
// TC6  畸形 schema → ArgsValidationError；strictSchema:false 容忍自定义关键字
// TC7  无缓存：每次均校验

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArgsValidationError, validateRunArgs } from "../args-validator.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";

// [teardown 竞态修复] 本文件用例全同步——console 刷写只能落在文件结束的 teardown 窗口，
// 与 worker rpc 关闭竞态 → vitest EnvironmentTeardownError（onUserConsoleLog pending）
// → run 退出码 1。噪声两源：①被测链传递性 logger 输出（core logger mock，
// rebuild-indexes.test.ts 同款先例）；②ajv 对 format:uri 的自有 console.warn（非 core
// logger 通路，TC6b 故意容忍自定义 format）——console.warn spy 静默。本文件对两者零断言依赖。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));
vi.spyOn(console, "warn").mockImplementation(() => {});

const WORKFLOWS_DIR = join(__dirname, "../../../workflows");

function reviewFixLoopParameters(): Record<string, unknown> {
  const src = readFileSync(join(WORKFLOWS_DIR, "review-fix-loop.js"), "utf-8");
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) {
    throw new Error("review-fix-loop parameters not parsed");
  }
  return meta.parameters;
}

function fanOutParameters(): Record<string, unknown> {
  const src = readFileSync(join(WORKFLOWS_DIR, "fan-out.js"), "utf-8");
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) {
    throw new Error("fan-out parameters not parsed");
  }
  return meta.parameters;
}

function makeSpec(
  parameters: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  scriptName = "test-wf",
): RunSpec {
  return {
    scriptSource: "",
    args,
    parameters,
    scriptName,
    scriptPath: `/x/${scriptName}.js`,
  };
}

describe("validateRunArgs — 校验语义", () => {
  it("TC1: 合法 args 通过校验（review-fix-loop 真实 schema）", () => {
    const spec = makeSpec(reviewFixLoopParameters(), {
      targetType: "git-diff",
      target: "main",
      batch1: "code-reviewer",
      autoCommit: false,
    });
    expect(() => validateRunArgs(spec)).not.toThrow();
  });

  it("TC2: 必填缺失 → ArgsValidationError（含 workflow 名 + 缺失字段 + info 指引）", () => {
    const spec = makeSpec(reviewFixLoopParameters(), { batch1: "code-reviewer" });
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      const e = err as ArgsValidationError;
      expect(e.workflowName).toBe("test-wf");
      expect(e.message).toContain("Invalid args for workflow 'test-wf'");
      expect(e.message).toContain("targetType");
      expect(e.message).toContain("Read the workflow script file");
    }
  });

  it("TC3a: 不可转换类型 'yes' → ArgsValidationError", () => {
    const spec = makeSpec(reviewFixLoopParameters(), {
      targetType: "git-diff",
      target: "main",
      autoCommit: "yes",
    });
    expect(() => validateRunArgs(spec)).toThrow(ArgsValidationError);
  });

  it("TC3b: required 字段 null 视为缺失 → ArgsValidationError（design-review major-1 回归）", () => {
    const spec = makeSpec(reviewFixLoopParameters(), {
      targetType: "git-diff",
      target: null,
    });
    expect(() => validateRunArgs(spec)).toThrow(ArgsValidationError);
  });

  it("TC3c: required 字符串空串 → ArgsValidationError（与脚本 !target 语义对齐）", () => {
    const spec = makeSpec(reviewFixLoopParameters(), {
      targetType: "git-diff",
      target: "",
    });
    expect(() => validateRunArgs(spec)).toThrow(ArgsValidationError);
  });

  it("TC4: 字符串 'false'/'10' coerce 原地生效，args 引用不变（m2 MAJOR-1 m3 闭环）", () => {
    const args = { targetType: "git-diff", target: "main", autoCommit: "false", maxRounds: "10" };
    const spec = makeSpec(reviewFixLoopParameters(), args);
    expect(() => validateRunArgs(spec)).not.toThrow();
    expect(spec.args).toBe(args); // 原地 mutate，引用不变（worker 启动/崩溃重跑同一对象）
    expect(spec.args.autoCommit).toBe(false);
    expect(spec.args.maxRounds).toBe(10);
  });

  it("TC5: 无 parameters → 不校验不 throw（安全退化）", () => {
    const spec = makeSpec(undefined, { whatever: "x" });
    expect(() => validateRunArgs(spec)).not.toThrow();
  });

  it("M1 回归: nullable schema 的 null 是合法输入（null-scan 不删 nullable 键）", () => {
    const spec = makeSpec(
      { type: "object", properties: { model: { type: ["string", "null"] } }, required: ["model"] },
      { model: null },
    );
    expect(() => validateRunArgs(spec)).not.toThrow();
    expect(spec.args.model).toBeNull(); // 未被删除
  });

  it("TC6a: 真畸形 schema → ArgsValidationError「schema 无效」（不泄漏原始 throw）", () => {
    const spec = makeSpec({ type: "not-a-type" }, { a: 1 });
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      expect((err as ArgsValidationError).message).toContain("invalid parameter schema");
    }
  });

  it("TC6c: parameters 非 object（数组）→ ArgsValidationError「expected object」", () => {
    // 锚定 schema 形状检查分支：数组 parameters 在 null-scan/compile 之前 fail-fast
    const spec = makeSpec([{ target: "string" }] as unknown as Record<string, unknown>, { a: 1 });
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      expect((err as ArgsValidationError).message).toContain(
        "invalid parameter schema (expected object)",
      );
    }
  });

  it("TC6b: strictSchema:false 容忍自定义关键字与 format（design-review major-3 回归）", () => {
    const spec = makeSpec(
      { type: "object", properties: { target: { type: "string", format: "uri" } }, required: ["target"], "x-custom": true },
      { target: "https://example.com" },
    );
    expect(() => validateRunArgs(spec)).not.toThrow();
  });

  it("TC7: 无缓存——每次 validateRunArgs 均校验（compile 0.006ms 实测，缓存无价值；无缓存声明本身靠 [P-compile] 探针实证，本用例是行为冒烟）", () => {
    const params = reviewFixLoopParameters();
    const good = makeSpec(params, { targetType: "git-diff", target: "main" });
    const bad = makeSpec(params, { targetType: "git-diff" });
    // 同一 schema 对象校验 3 次：每次均正确执行（无缓存命中概念）
    expect(() => validateRunArgs(good)).not.toThrow();
    expect(() => validateRunArgs(bad)).toThrow(ArgsValidationError);
    expect(() => validateRunArgs(good)).not.toThrow();
  });
});

describe("validateRunArgs — fan-out 旧格式迁移指引（legacyArgsAdvisory）", () => {
  it("旧格式 tasks 字符串数组 → ajv 拒绝文案后附专属迁移指引（命名旧形状 + 迁移映射 + 重派新 run）", () => {
    const spec = makeSpec(fanOutParameters(), { tasks: ["t0", "t1"] }, "fan-out");
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      const e = err as ArgsValidationError;
      expect(e.workflowName).toBe("fan-out");
      // ajv 诊断保留在前（类型错在哪仍可查），迁移指引附在后
      expect(e.message).toContain("Invalid args for workflow 'fan-out'");
      expect(e.message).toContain("must be object");
      expect(e.message).toContain("Legacy args shape detected");
      expect(e.message).toContain('"tasks" elements are plain strings');
      expect(e.message).toContain("predates the member-object parameter format");
      expect(e.message).toContain("Recovery: re-dispatch a NEW run with member-object tasks");
      expect(e.message).toContain("Correct:");
    }
  });

  it("顶层 agents 残留键 → 同款迁移指引（旧 CLI 混合形态在 ajv 层即被命名）", () => {
    const spec = makeSpec(fanOutParameters(), { tasks: [{ task: "t0" }], agents: "/a/one.md" }, "fan-out");
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      const e = err as ArgsValidationError;
      expect(e.message).toContain('top-level "agents" key present');
      expect(e.message).toContain("predates the member-object parameter format");
      expect(e.message).toContain("Recovery: re-dispatch a NEW run with member-object tasks");
    }
  });

  it("成员对象合法 args → 通过（指引不干扰正常路径）", () => {
    const spec = makeSpec(fanOutParameters(), { tasks: [{ task: "t0" }, { task: "t1" }] }, "fan-out");
    expect(() => validateRunArgs(spec)).not.toThrow();
  });

  it("同形 args 但非 fan-out 工作流 → 仅通用 ajv 文案（登记按模板名收敛，不给第三方 workflow 发明文案）", () => {
    const spec = makeSpec(fanOutParameters(), { tasks: ["t0", "t1"] }, "other-wf");
    try {
      validateRunArgs(spec);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsValidationError);
      const e = err as ArgsValidationError;
      expect(e.message).toContain("Invalid args for workflow 'other-wf'");
      expect(e.message).not.toContain("Legacy args shape detected");
    }
  });
});
