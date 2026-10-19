// src/__tests__/session-context-resolver.test.ts
//
// 覆盖 resolveSessionContext 全部 5 种输入组合 + ForkDepthExceededError 边界。
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { resolveSessionContext } from "../assembly/session-context-resolver.ts";
import { ForkDepthExceededError } from "../assembly/types.ts";

const AGENT_DIR = "/home/user/.pi/agent";
const ROOT_SID = "root-sid-resolver";
const MAIN_CWD = "/home/user/project";
const SESSION_FILE = "session-abc.jsonl";

function expectedSessionDir(rootSessionId: string): string {
  // [session-store-layout-inversion D2/D3] 新布局：<root>/<rootSessionId>/subagents/sessions/
  // 分区键 = rootSessionId（cwd 不再参与）；dataDir 与生产同源（env getDataDir 兜底，
  // vitest global-setup 注入 tmp）。
  return getSubagentSessionDir(rootSessionId);
}

describe("resolveSessionContext", () => {
  // ── 边界 1: fork=false, worktree=false ──
  it("fork=false, worktree=false → shouldFork=false, effectiveCwd=mainCwd", () => {
    const result = resolveSessionContext({
      fork: false,
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 2: fork=true, worktree=false ──
  it("fork=true, worktree=false → shouldFork=true, forkSource=mainSessionFile", () => {
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 3: fork=false, worktree=true ──
  it("fork=false, worktreePath 提供 → effectiveCwd=worktreePath", () => {
    const worktreePath = "/tmp/pi-sub-run-42";
    const result = resolveSessionContext({
      fork: false,
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
      worktreePath,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(worktreePath);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 4: fork=true, worktree=true ──
  it("fork=true, worktreePath 提供 → shouldFork=true + effectiveCwd=worktreePath", () => {
    const worktreePath = "/tmp/pi-sub-bg-7-abc";
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      rootSessionId: ROOT_SID,
      worktreePath,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(worktreePath);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 5: fork=true + parentForkDepth>=10 → 抛错 ──
  it("fork=true + parentForkDepth=10 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        mainSessionFile: SESSION_FILE,
        parentForkDepth: 10,
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  it("fork=true + parentForkDepth=15 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        parentForkDepth: 15,
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  // ── depth=9 不抛 ──
  it("fork=true + parentForkDepth=9 → does NOT throw", () => {
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      parentForkDepth: 9,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(true);
  });

  // ── sessionDir 只按 rootSessionId 分区（effectiveCwd / worktreePath 不影响）──
  it("sessionDir keyed by rootSessionId only, unaffected by worktreePath overriding effectiveCwd", () => {
    const mainCwd = "/Users/alice/code/my-app";
    const result = resolveSessionContext({
      fork: false,
      mainCwd,
      rootSessionId: ROOT_SID,
      worktreePath: "/tmp/pi-sub-run-1",
    });
    // effectiveCwd 是 worktree checkout，但 sessionDir 与 cwd 无关——只按 rootSessionId
    // 树内分区（旧「mainCwd 编码段」语义随 session-store-layout-inversion 消亡）
    expect(result.effectiveCwd).not.toBe(mainCwd);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── [MF#5] fork=true 但主 session 文件不可用 → 抛错（不静默降级）──
  it("fork=true + mainSessionFile 缺失 → throws（不静默降级到 from-scratch）", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        // mainSessionFile 故意不传
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(/main session file is unavailable/);
  });

  // ── 默认值：fork/worktree 未传 → undefined → false ──
  it("fork/worktree omitted → shouldFork=false", () => {
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
  });

  // ── cwd 覆盖 mainCwd（worktree=false 时）──
  it("explicit cwd overrides mainCwd when worktree=false", () => {
    const customCwd = "/tmp/custom-cwd";
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      cwd: customCwd,
      rootSessionId: ROOT_SID,
    });
    expect(result.effectiveCwd).toBe(customCwd);
    // sessionDir 仍用 mainCwd
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });
});
