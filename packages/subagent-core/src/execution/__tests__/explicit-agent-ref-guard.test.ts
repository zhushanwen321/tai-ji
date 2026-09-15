// 显式 agent ref 失败必须报错（非静默降级）——三通道对称审查修复的 agent 通道验收。
//
// 修复背景：resolveIdentity 旧实现 getAgentConfig（loadByPath 无 require）对相对
// 路径/裸名/文件缺失一律返回 undefined → agentConfig undefined → resolveModel 静默
// 回落 override→主 agent model——用户点名 agent 却拿到无 systemPrompt/无工具白名单
// 的 general-purpose 形态，零反馈。修复后显式 ref 失败抛错（require:true 语义，
// 错误含 <available_subagents> 恢复指引，对齐 workflow name not found 反馈风格）。
//
// 本文件锁住：
//   1. 裸名/相对路径 agent ref → execute 同步 reject（Invalid agent ref），无引擎
//      派发、无子 session、record 不落盘（engine.run/appendEntry 零触达）
//   2. 绝对路径但文件不存在 → reject（not found or unreadable）
//   3. 对照：不传 agent（默认 general-purpose）与合法绝对路径 ref 均不误伤
//
// [W3 改写] 原 vi.mock(inproc pi 引擎目录/session-runner)（buildSpawnArgs spy）随删件消亡
// ——「spawn 链路零触达」的结构性证据改经协议替身（engine.run 零调用）+ appendEntry
// 零触达承载；守卫位于同步裁决期、引擎派发前置的结构不变。
//
// harness 复用 start-sync-model-guard.test.ts（真实 SubagentService + tmpdir +
// 协议替身），保证守卫位于同步裁决期、引擎派发前置的结构性证据可断言。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";
import type { PiLike } from "../subagent-service.ts";
import { SubagentService } from "../subagent-service.ts";

// ── 工具（start-sync-model-guard 同款）──

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "GLM-5.3-Flash",
    name: over.name ?? "GLM 5.3 Flash",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    ...over,
  };
}

function makeRegistry(models: ModelInfo[]): ModelRegistryLike {
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: () => true,
  };
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

describe("显式 agent ref 失败报错（非静默降级 general-purpose）", () => {
  let tmpDir: string;
  let service: SubagentService;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEngines();
    fake = registerFakePiEngine();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-agent-ref-guard-"));
    const modelService = new ModelConfigService({ agentDir: tmpDir, cwd: tmpDir });
    modelService.initModel({
      modelRegistry: makeRegistry([makeModel()]),
      sessionId: "agent-ref-guard-session",
    });
    service = new SubagentService({ cwd: tmpDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "agent-ref-guard-session" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEngines();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── 拒绝路径：显式 ref 失败 → 同步 reject + 引擎派发零触达 ──

  it("裸名 agent ref（'worker'）→ execute 同步 reject（Invalid agent ref + 恢复指引）", async () => {
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: "worker" }),
    ).rejects.toThrow(/Invalid agent ref: worker.*<available_subagents>/s);

    // 引擎派发零触达 + record 未创建——非静默降级的结构性证据：
    // 旧行为（静默 undefined）会继续走 record 创建（appendEntry 被调）后派发引擎。
    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("相对路径 agent ref → 同样 reject（引用唯一形态 = 绝对路径）", async () => {
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: "./agents/worker.md" }),
    ).rejects.toThrow(/Invalid agent ref/);

    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("绝对路径但文件不存在 → reject（not found or unreadable），非静默降级", async () => {
    const missing = path.join(tmpDir, "no-such-agent.md");
    await expect(
      service.execute({ task: "probe task", slug: "ref-guard", agent: missing }),
    ).rejects.toThrow(/not found or unreadable.*<available_subagents>/s);

    expect(fake.runs.length).toBe(0);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  // ── 放行对照：两类合法语义不误伤 ──

  it("不传 agent（默认 general-purpose 语义）→ 不触发 agent ref 守卫", async () => {
    const promise = service.execute({
      task: "probe task",
      slug: "ref-default-ok",
      ctxModel: makeModel(),
    });
    // 默认语义下 identity 解析必须放行（execute 可能因 mock 环境引擎收尾而 reject，
    // 但错误不能是 agent ref 拒绝）；record 已创建（appendEntry 发生）。
    try {
      await promise;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Invalid agent ref/);
      expect((e as Error).message).not.toMatch(/not found or unreadable/);
    }
    expect(pi.appendEntry).toHaveBeenCalled();
  });

  it("显式合法绝对路径 agent .md → 守卫零误伤，identity 放行", async () => {
    const agentFile = path.join(tmpDir, "worker.md");
    fs.writeFileSync(agentFile, "You are a test worker agent.");
    const promise = service.execute({
      task: "probe task",
      slug: "ref-valid-ok",
      agent: agentFile,
      ctxModel: makeModel(),
    });
    try {
      await promise;
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Invalid agent ref/);
      expect((e as Error).message).not.toMatch(/not found or unreadable/);
    }
    expect(pi.appendEntry).toHaveBeenCalled();
  });
});
