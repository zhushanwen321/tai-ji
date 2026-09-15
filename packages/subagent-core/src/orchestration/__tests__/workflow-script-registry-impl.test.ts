/**
 * workflow-script-registry-impl 测试：sink 设计 U1 导出形态。
 *
 * 覆盖：WorkflowScript 类 re-export 可用性 + loadWorkflowScriptByPath 工厂加载
 * （真实临时脚本文件）、非法引用拒绝（含 ⛔2 `..` 段收紧对工厂生效）、
 * available=false stub 语义。
 *
 * 策略对齐 config-loader.test.ts：真实临时目录 + 真实脚本文件（meta 提取走真实
 * 文件读取），只 mock findWorkspaceRoot（缓存桶 key，耦合 process.cwd 难隔离）与
 * homedir（`~/` 引用展开锚点）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => "/nonexistent-home-for-tests") };
});

vi.mock("../../shared/resource-discovery.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../shared/resource-discovery.ts")
  >();
  return {
    ...actual,
    findWorkspaceRoot: vi.fn(() => "/unused-by-default"),
  };
});

import { invalidateCache } from "../config-loader.ts";
import { loadWorkflowScriptByPath, WorkflowScript } from "../workflow-script-registry-impl.ts";
import { homedir } from "node:os";

const mockedHomedir = vi.mocked(homedir);

/** 有效 workflow 脚本内容（@pi-meta 块注释 + agent 入口，同 config-loader.test 范式；phases 须 YAML 数组）。 */
const SCRIPT_SOURCE =
  "/* @pi-meta\nname: factory-wf\ndescription: factory test\nphases: []\n*/\nagent({ prompt: \"x\" });\n";

async function writeScript(content: string, fileName = "factory-wf.js"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-registry-impl-test-"));
  const p = join(dir, fileName);
  await writeFile(p, content, "utf-8");
  return p;
}

describe("loadWorkflowScriptByPath / WorkflowScript 导出形态（U1）", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    invalidateCache();
    // 重置 `~/` 用例留下的 homedir mock 残留（mockReturnValue 跨测试持续）
    mockedHomedir.mockReturnValue("/nonexistent-home-for-tests");
    tempDirs = [];
  });

  afterEach(async () => {
    invalidateCache();
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  async function trackedWrite(content: string, fileName?: string): Promise<string> {
    const p = await writeScript(content, fileName);
    tempDirs.push(join(p, ".."));
    return p;
  }

  it("按绝对路径加载：返回 WorkflowScript 实例（meta/sourceCode 填充，available=true）", async () => {
    const p = await trackedWrite(SCRIPT_SOURCE);
    const script = await loadWorkflowScriptByPath(p);
    expect(script).toBeInstanceOf(WorkflowScript);
    expect(script!.name).toBe("factory-wf");
    expect(script!.available).toBe(true);
    expect(script!.path).toBe(p);
    expect(script!.sourceCode).toBe(SCRIPT_SOURCE);
    expect(script!.meta.description).toBe("factory test");
  });

  it("re-export 的 WorkflowScript 类与实例同源：validate/toExecutable 实体操作可用", async () => {
    const p = await trackedWrite(SCRIPT_SOURCE);
    const script = await loadWorkflowScriptByPath(p);
    expect(script).toBeInstanceOf(WorkflowScript);
    // 实体操作（validate 委托 lintScript / toExecutable 返回可执行源）经导出类实例可用
    const lint = script!.validate();
    expect(lint.valid).toBe(true);
    expect(Array.isArray(lint.findings)).toBe(true);
    expect(script!.toExecutable()).toBe(SCRIPT_SOURCE);
  });

  it("文件不可读/不存在：available=false 的 stub（非 undefined——loader never throws）", async () => {
    const p = await trackedWrite(SCRIPT_SOURCE, "gone.js");
    await rm(p);
    const script = await loadWorkflowScriptByPath(p);
    expect(script).toBeDefined();
    expect(script!.available).toBe(false);
  });

  it("非法引用返回 undefined：相对路径 / 非 .js 扩展名", async () => {
    await trackedWrite(SCRIPT_SOURCE);
    expect(await loadWorkflowScriptByPath("relative/wf.js")).toBeUndefined();
    expect(await loadWorkflowScriptByPath("/proj/wf.txt")).toBeUndefined();
  });

  it("⛔2：含 .. 段的路径引用被拒（undefined——收紧对工厂消费面生效）", async () => {
    await trackedWrite(SCRIPT_SOURCE);
    expect(await loadWorkflowScriptByPath("/x/../factory-wf.js")).toBeUndefined();
  });

  it("~/ 前缀引用：展开 homedir 后加载（barrel 消费面的合法引用形态）", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "wf-registry-impl-home-"));
    tempDirs.push(fakeHome);
    mockedHomedir.mockReturnValue(fakeHome);
    const p = join(fakeHome, "home-wf.js");
    await writeFile(p, SCRIPT_SOURCE, "utf-8");
    const script = await loadWorkflowScriptByPath("~/home-wf.js");
    expect(script).toBeInstanceOf(WorkflowScript);
    expect(script!.name).toBe("factory-wf");
    expect(script!.path).toBe(p);
  });
});
