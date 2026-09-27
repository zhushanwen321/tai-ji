// pi-host-run-store 回归锁：GC 读侧目录由壳注入的 agentDir 活源驱动，
// 不从进程 env/cwd/sessionFile 推测（两条推导路径均曾在 W2 D3 真机链实证
// 错位致 GC 恒空转，见被测模块头注）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPiHostRunEnumeration } from "../assembly/pi-host-run-store.ts";

/** toRunSnapshot 最小合法行（fromRunSnapshot 可重水合；字段集与 W2 验收
 * synth 剧本同源——budget 六字段缺一会被形状校验拒绝）。 */
function snapshotLine(runId: string, startedAtIso: string): string {
  return `${JSON.stringify({
    v: "wf-run-v2",
    runId,
    spec: {
      scriptSource: "// fixture\n",
      args: {},
      scriptName: "fixture",
      scriptPath: "/tmp/fixture.js",
      description: "pi-host-run-store fixture",
    },
    state: {
      status: "running",
      budget: { maxTokens: 0, maxCost: 0, maxTimeMs: 0, usedTokens: 0, usedCost: 0, totalCallCount: 0 },
      calls: [],
      trace: [],
      errorLogs: [],
    },
    meta: { startedAt: startedAtIso },
  })}\n`;
}

describe("createPiHostRunEnumeration", () => {
  let agentRoot: string;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-"));
    // pi 壳布局：<agentRoot>/sessions/<slug>/workflow-state/ + <agentRoot>/workflow-state（回退根）
    const slugADir = join(agentRoot, "sessions", "--fixture-slug-a--");
    const slugBDir = join(agentRoot, "sessions", "--fixture-slug-b--");
    const wsA = join(slugADir, "workflow-state");
    const wsB = join(slugBDir, "workflow-state");
    const wsRoot = join(agentRoot, "workflow-state");
    for (const dir of [wsA, wsB, wsRoot]) mkdirSync(dir, { recursive: true });
    const iso = new Date().toISOString();
    // same-session 目录 / cross-session 目录 / agentDir 回退根各一个 run
    writeFileSync(join(wsA, "wf-a.jsonl"), snapshotLine("wf-a", iso));
    writeFileSync(join(wsB, "wf-b.jsonl"), snapshotLine("wf-b", iso));
    writeFileSync(join(wsRoot, "wf-c.jsonl"), snapshotLine("wf-c", iso));
    // journal 附属文件（.events.jsonl）不得进快照结果
    writeFileSync(join(wsA, "wf-a.events.jsonl"), '{"type":"run-created"}\n');
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("枚举全部 session 目录 + agentDir 回退根（same/cross-session 两形态一次覆盖）", async () => {
    const store = createPiHostRunEnumeration(() => agentRoot);
    const runs = await store.loadAll();
    expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b", "wf-c"]);
    for (const run of runs) {
      expect(run.state.status).toBe("running");
      expect(run.meta.startedAt).toBeTruthy();
    }
  });

  it("journal 附属文件（.events.jsonl）不进快照枚举结果", async () => {
    const store = createPiHostRunEnumeration(() => agentRoot);
    const runs = await store.loadAll();
    expect(runs.some((r) => r.runId.includes("events"))).toBe(false);
    expect(runs).toHaveLength(3);
  });

  it("进程 env 漂移不影响枚举目录（注入活源优先于 PI_CODING_AGENT_DIR）", async () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(agentRoot, "not-the-real-agent-dir");
    try {
      const store = createPiHostRunEnumeration(() => agentRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId).sort()).toEqual(["wf-a", "wf-b", "wf-c"]);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("sessions 根不存在时仅扫 agentDir 回退根（从未落盘的空态降级不抛）", async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "pi-host-run-store-bare-"));
    try {
      const wsRoot = join(bareRoot, "workflow-state");
      mkdirSync(wsRoot, { recursive: true });
      writeFileSync(join(wsRoot, "wf-bare.jsonl"), snapshotLine("wf-bare", new Date().toISOString()));
      const store = createPiHostRunEnumeration(() => bareRoot);
      const runs = await store.loadAll();
      expect(runs.map((r) => r.runId)).toEqual(["wf-bare"]);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
