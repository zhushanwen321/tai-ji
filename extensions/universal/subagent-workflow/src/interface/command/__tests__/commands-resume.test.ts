/**
 * /workflows 命令的 resume 通道契约（workflow-run-resume-revision U3 + F1-26 后续项）。
 *
 * 覆盖面（TUI 模式）：/workflows resume <runId> [model] → 执行断点续跑后 notify，
 * 不打开面板；缺 runId → Usage 提示（含可选 [model]）；resumeRun 拒绝 → warning
 * notify 透出恢复指引文案；显式 model 的 handler 透传（第三参 { model } / 无 model
 * 不落键）与目录预检拒单（与 tool 通道同款 D8 语义）。
 *
 * RPC 模式（taiji GUI）的 resume verb 接线与 model 透传由
 * src/__tests__/rpc-command-handling.test.ts 覆盖；workflow tool 通道
 * （action:"resume"，含 D14 args 校验）由 tool-workflow-resume.test.ts 覆盖。
 *
 * mock 策略：resume-run 深路径 stub（对齐 tool-workflow-resume.test.ts）；命令
 * 注册层经 fake api 捕获 handler 后以 fake ctx 直接调用。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// 被 mock 的模块——import 路径与被测源文件的等值实例（对齐 tool-workflow-resume.test.ts）
import { resumeRun } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";
import { setModelConfigService, GLOBAL_SLOT_KEYS } from "@zhushanwen/subagent-core";

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

/** 重置进程级 ModelConfigService 单例槽（model catalog 预检用例的注入/清理，
 *  Symbol 直写——key 与生产 getModelServiceSlot 的 MODEL_SERVICE_SLOT_KEY 一致）。 */
function resetModelServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for(GLOBAL_SLOT_KEYS.modelService)) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

/** 注入目录为 entries 的最小 ModelConfigService fake（duck-typed getAvailable）。 */
function injectModelServiceWith(entries: Array<{ provider: string; id: string }>): void {
  setModelConfigService({
    getModelRegistry: () => ({ getAvailable: () => entries }),
  } as never);
}

beforeEach(() => {
  vi.mocked(resumeRun).mockReset();
  vi.mocked(resumeRun).mockResolvedValue("wf-x");
  resetModelServiceSlot();
});

// ── TUI 模式 ─────────────────────────────────────────────────

describe("/workflows TUI resume", () => {
  it("resume <runId> → resumeRun 接线 + notify（不打开面板）", async () => {
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume wf-x", ctx);
    expect(vi.mocked(resumeRun)).toHaveBeenCalledWith("wf-x", expect.anything());
    // 无 model 不落键：调用恰为 (runId, deps) 两参（spread 条件反写不会静默通过）
    expect(vi.mocked(resumeRun).mock.calls[0]).toHaveLength(2);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.msg).toContain("resuming");
    expect(notifies[0]!.level).toBe("info");
  });

  it("resume <runId> <model> → resumeRun 第三参 { model } 透传 + notify 带模型", async () => {
    injectModelServiceWith([{ provider: "p2", id: "m2" }]);
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume wf-x p2/m2:high", ctx);
    expect(vi.mocked(resumeRun)).toHaveBeenCalledWith("wf-x", expect.anything(), {
      model: "p2/m2:high",
    });
    expect(notifies[0]!.msg).toContain("resuming with model p2/m2:high");
    expect(notifies[0]!.level).toBe("info");
  });

  it("resume 显式 model 目录查无 → 同步拒单 warning（tool 通道同款 D8 语义，不落覆盖记账）", async () => {
    injectModelServiceWith([{ provider: "p1", id: "m1" }]);
    const cmd = captureCommand();
    const { ctx, notifies } = makeCtx("tui");
    await cmd.handler("resume wf-x pX/nope", ctx);
    // 目录查无在 resumeRun 之前拒绝——不产生假成功 notify
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.msg).toContain("Failed to resume workflow wf-x:");
    expect(notifies[0]!.msg).toContain("pX/nope");
    expect(notifies[0]!.level).toBe("warning");
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
