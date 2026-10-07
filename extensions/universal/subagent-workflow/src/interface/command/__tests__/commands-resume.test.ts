/**
 * /workflows 命令的 resume 通道契约（workflow-run-resume-revision U3）。
 *
 * 覆盖面（TUI 模式）：/workflows resume <runId> → 执行断点续跑后 notify，不打开
 * 面板；缺 runId → Usage 提示；resumeRun 拒绝 → warning notify 透出恢复指引文案。
 *
 * RPC 模式（taiji GUI）的 resume verb 接线未随 U3 落地：解析词表在
 * command-actions.ts（领地外，resume verb 现仍解析为 lifecycle-removed），其
 * dispatch 断言由 src/__tests__/rpc-command-handling.test.ts 原样锁定——词表
 * 适配归编排层（见 commands.ts handleRpcMode 注释）。workflow tool 通道
 * （action:"resume"，含 D14 args 校验）由 tool-workflow-resume.test.ts 覆盖。
 *
 * mock 策略：resume-run 深路径 stub（对齐 tool-workflow-resume.test.ts）；命令
 * 注册层经 fake api 捕获 handler 后以 fake ctx 直接调用。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// 被 mock 的模块——import 路径与被测源文件的等值实例（对齐 tool-workflow-resume.test.ts）
import { resumeRun } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import { registerWorkflowsCommand } from "../commands.ts";

vi.mock("@zhushanwen/subagent-core/orchestration/resume-run.ts", () => ({
  resumeRun: vi.fn(),
}));

// ── fixture ──────────────────────────────────────────────────

interface CapturedCommand { // oe-exempt:20260929:test:test double shape for command capture (test infra)
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** 注册层捕获（对齐 capture-tool 形态：fake api 收集 registerCommand 入参）。 */
function captureCommand(): CapturedCommand {
  const commands: CapturedCommand[] = [];
  const api = {
    registerCommand: (name: string, def: Omit<CapturedCommand, "name">) => {
      commands.push({ name, ...def });
    },
  };
  registerWorkflowsCommand(
    api as never,
    () => new Map(),
    { runs: new Map(), store: { stateFilePath: () => "/state/x" } } as never,
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]!.name).toBe("workflows");
  return commands[0]!;
}

/** fake ctx：notify 收集 + mode 注入（TUI 分支的 theme/select 不触 resume 用例）。 */
function makeCtx(mode: "rpc" | "tui"): { ctx: ExtensionCommandContext; notifies: Array<{ msg: string; level: string }> } {
  const notifies: Array<{ msg: string; level: string }> = [];
  const ctx = {
    mode,
    ui: {
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
      theme: {},
      select: vi.fn(),
    },
  };
  return { ctx: ctx as never, notifies };
}

beforeEach(() => {
  vi.mocked(resumeRun).mockReset();
  vi.mocked(resumeRun).mockResolvedValue("wf-x");
});

// ── TUI 模式 ─────────────────────────────────────────────────

describe("/workflows TUI resume", () => {
  it("resume <runId> → resumeRun 接线 + notify（不打开面板）", async () => {
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume wf-x", ctx);
    expect(vi.mocked(resumeRun)).toHaveBeenCalledWith("wf-x", expect.anything());
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.msg).toContain("resuming");
    expect(notifies[0]!.level).toBe("info");
  });

  it("resume 缺 runId → Usage warning", async () => {
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume", ctx);
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
    expect(notifies[0]).toMatchObject({ msg: "Usage: /workflows resume <runId> [model]", level: "warning" });
  });

  it("resumeRun 拒绝 → warning notify（TUI 同款透出）", async () => {
    vi.mocked(resumeRun).mockRejectedValue(new Error("Resume rejected: lock held"));
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume wf-x", ctx);
    expect(notifies[0]!.msg).toContain("Failed to resume workflow wf-x: Resume rejected: lock held");
    expect(notifies[0]!.level).toBe("warning");
  });
});
