/**
 * /subagent-model 命令 handler 测试（subagent-model-switch §7.1.1，U6）。
 *
 * 覆盖（通道契约：全程不抛 + 一切结果落结果文件）：
 * - 合法 payload → service.setModel 桩 → 结果文件内容 = 应答（core SetModelReply 原样）；
 * - service.setModel 抛错 → 错误 envelope 文件且 handler 不抛；
 * - 非法 JSON（无 requestId）→ 零文件 + handler 不抛（runtime 超时路径承接）；
 * - 字段校验失败（requestId 在场）→ invalid_payload envelope；
 * - service 未就绪 → subagent_runtime_not_ready envelope；
 * - 注册形态：命令名 / TUI 模式指引（内部 RPC 通道，无 TUI 分支）。
 *
 * mock 策略：runSubagentModelRpc 依赖注入面直驱（不 mock barrel）；落盘全在 mkdtemp tmp。
 * 运行：cd extensions/universal/subagent-workflow && npx vitest run src/interface/command/__tests__/subagent-model.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { registerSubagentModelCommand, runSubagentModelRpc } from "../subagent-model.ts";
import type { SubagentModelCommandDeps } from "../subagent-model.ts";

// ── fixture ──────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-model-cmd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface StubService { // oe-exempt:20261006:test:测试专用服务桩装配单实现为常态
  setModel: ReturnType<typeof vi.fn>;
  chatActions: { getRecordForAction: ReturnType<typeof vi.fn> };
}

function stubService(): StubService {
  return {
    setModel: vi.fn(async () => ({
      scope: "chat",
      reply: { kind: "recorded", notice: "已记录，下次执行生效。" },
    })),
    chatActions: {
      getRecordForAction: vi.fn(() => ({ id: "sa-1" }) as never),
    },
  };
}

function deps(service: StubService | null): { deps: SubagentModelCommandDeps; resultsDir: string } {
  const resultsDir = join(root, "results");
  return {
    deps: {
      getService: () => service as never,
      resolveAgentDir: () => join(root, "agent"),
      // rootCwd 作为 enc 编码键——结果目录 = <agentDir>/subagents/<enc(cwd)>/model-switch
      resolveRootCwd: () => join(root, "proj"),
    },
    resultsDir,
  };
}

function rpcCtx(mode: "rpc" | "tui" = "rpc"): { ctx: ExtensionCommandContext; notifies: Array<{ msg: string; level: string }> } {
  const notifies: Array<{ msg: string; level: string }> = [];
  const ctx = {
    mode,
    ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) },
    cwd: join(root, "proj"),
  };
  return { ctx: ctx as never, notifies };
}

const VALID_ARGS = JSON.stringify({
  requestId: "req-abc",
  recordId: "sa-1",
  provider: "zai-coding-cn",
  modelId: "glm-5.3-flash",
  thinkingLevel: "high",
});

function resultFile(requestId: string): string {
  // enc 段镜像 core encodeCwd（布局单源在 path-encoding.ts，测试只按同式派生锚）。
  const enc = "--" + join(root, "proj").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
  return join(root, "agent", "subagents", enc, "model-switch", `${requestId}.json`);
}

// ── 成功路 ───────────────────────────────────────────────────

describe("/subagent-model — 成功路（payload → setModel → 结果文件）", () => {
  it("合法 payload：setModel 桩收到 target/model/thinkingLevel，结果文件 = 应答原样", async () => {
    const service = stubService();
    const { deps: d } = deps(service);
    const { ctx } = rpcCtx();

    await runSubagentModelRpc(d, VALID_ARGS, ctx);

    expect(service.chatActions.getRecordForAction).toHaveBeenCalledWith("sa-1");
    expect(service.setModel).toHaveBeenCalledWith(
      { domain: "chat", record: { id: "sa-1" } },
      { provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
      "high",
    );
    const raw = readFileSync(resultFile("req-abc"), "utf8");
    expect(JSON.parse(raw)).toEqual({ scope: "chat", reply: { kind: "recorded", notice: "已记录，下次执行生效。" } });
  });

  it("runId 目标：workflow-run 域分流（不触 getRecordForAction）", async () => {
    const service = stubService();
    const { deps: d } = deps(service);
    const { ctx } = rpcCtx();

    const args = JSON.stringify({ requestId: "req-run", runId: "wf-1", provider: "p", modelId: "m" });
    await runSubagentModelRpc(d, args, ctx);

    expect(service.chatActions.getRecordForAction).not.toHaveBeenCalled();
    expect(service.setModel).toHaveBeenCalledWith({ domain: "workflow-run", runId: "wf-1" }, { provider: "p", modelId: "m" }, undefined);
  });

  it("handler 不抛（即使 setModel 桩 resolve 失败也不向上传播）", async () => {
    const service = stubService();
    service.setModel.mockResolvedValue({ scope: "error", message: "目录无此模型（最接近的候选：X）" });
    const { deps: d } = deps(service);
    const { ctx } = rpcCtx();

    await expect(runSubagentModelRpc(d, VALID_ARGS, ctx)).resolves.toBeUndefined();
    const envelope = JSON.parse(readFileSync(resultFile("req-abc"), "utf8")) as { scope: string };
    expect(envelope.scope).toBe("error");
  });
});

// ── 失败路：envelope 且不抛 ──────────────────────────────────

describe("/subagent-model — 失败路（envelope 落盘 + 全程不抛）", () => {
  it("service.setModel 抛错：错误 envelope 文件 + handler 不抛", async () => {
    const service = stubService();
    service.setModel.mockRejectedValue(Object.assign(new Error("thinking 档位 max 在模型 X 上不可用"), { code: "thinking_level_unavailable" }));
    const { deps: d } = deps(service);
    const { ctx } = rpcCtx();

    await expect(runSubagentModelRpc(d, VALID_ARGS, ctx)).resolves.toBeUndefined();

    const envelope = JSON.parse(readFileSync(resultFile("req-abc"), "utf8")) as {
      error: { code: string; message: string; recovery: string };
    };
    expect(envelope.error.code).toBe("thinking_level_unavailable");
    expect(envelope.error.message).toContain("不可用");
    expect(envelope.error.recovery).toContain("重试切换");
  });

  it("getRecordForAction 抛错（目标不存在）：envelope + handler 不抛", async () => {
    const service = stubService();
    service.chatActions.getRecordForAction.mockImplementation(() => {
      throw new Error("record sa-ghost not found");
    });
    const { deps: d } = deps(service);
    const { ctx } = rpcCtx();

    await expect(runSubagentModelRpc(d, VALID_ARGS, ctx)).resolves.toBeUndefined();

    const envelope = JSON.parse(readFileSync(resultFile("req-abc"), "utf8")) as { error: { code: string } };
    expect(envelope.error.code).toBe("subagent_model_switch_failed");
  });

  it("非法 JSON（无 requestId）：零文件 + handler 不抛 + warning notify", async () => {
    const { deps: d } = deps(stubService());
    const { ctx, notifies } = rpcCtx();

    await expect(runSubagentModelRpc(d, "not-json{", ctx)).resolves.toBeUndefined();
    expect(existsSync(resultFile("req-abc"))).toBe(false);
    expect(notifies[0]?.level).toBe("warning");
  });

  it("字段校验失败（缺 provider）：invalid_payload envelope", async () => {
    const { deps: d } = deps(stubService());
    const { ctx } = rpcCtx();

    const args = JSON.stringify({ requestId: "req-bad", recordId: "sa-1", modelId: "m" });
    await runSubagentModelRpc(d, args, ctx);

    const envelope = JSON.parse(readFileSync(resultFile("req-bad"), "utf8")) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("invalid_payload");
    expect(envelope.error.message).toContain("provider");
  });

  it("recordId 与 runId 双给：invalid_payload envelope（wire 契约二选一）", async () => {
    const { deps: d } = deps(stubService());
    const { ctx } = rpcCtx();

    const args = JSON.stringify({ requestId: "req-both", recordId: "sa-1", runId: "wf-1", provider: "p", modelId: "m" });
    await runSubagentModelRpc(d, args, ctx);

    const envelope = JSON.parse(readFileSync(resultFile("req-both"), "utf8")) as { error: { code: string } };
    expect(envelope.error.code).toBe("invalid_payload");
  });

  it("service 未就绪（session_start 前）：subagent_runtime_not_ready envelope", async () => {
    const { deps: d } = deps(null);
    const { ctx } = rpcCtx();

    await runSubagentModelRpc(d, VALID_ARGS, ctx);

    const envelope = JSON.parse(readFileSync(resultFile("req-abc"), "utf8")) as { error: { code: string } };
    expect(envelope.error.code).toBe("subagent_runtime_not_ready");
  });
});

// ── 注册形态 ─────────────────────────────────────────────────

describe("registerSubagentModelCommand — 注册形态", () => {
  interface CapturedCommand { // oe-exempt:20261006:test:测试专用命令捕获结构单实现为常态（同 commands-resume.test.ts 先例）
    name: string;
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }

  function captureCommand(): CapturedCommand {
    const commands: CapturedCommand[] = [];
    const api = {
      registerCommand: (name: string, def: Omit<CapturedCommand, "name">) => {
        commands.push({ name, ...def });
      },
    };
    registerSubagentModelCommand(api as never);
    expect(commands).toHaveLength(1);
    return commands[0]!;
  }

  it("命令名 = subagent-model；TUI 模式 = 指引提示（内部 RPC 通道无 TUI 分支）", async () => {
    const cmd = captureCommand();
    expect(cmd.name).toBe("subagent-model");
    const { ctx, notifies } = rpcCtx("tui");
    await cmd.handler(VALID_ARGS, ctx);
    expect(notifies[0]?.level).toBe("warning");
    expect(notifies[0]?.msg).toContain("internal taiji GUI channel");
  });
});
