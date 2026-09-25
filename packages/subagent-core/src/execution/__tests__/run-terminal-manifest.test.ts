// src/execution/__tests__/run-terminal-manifest.test.ts
//
// [P1b-2 / D5] run 级终局投影 manifest 写读单测（manifest-store.ts）。
//
// 锁四面（D5-④ manifest-write 输出 + D5 清理规则①单源锚定）：
// 1. 三形态写读闭环：成功=completed、失败=failed+errorCode、取消=cancelled。
// 2. 旧读侧兼容：旧 manifest（无 outcome 字段的存量/手写形态）读回 null 不炸；
//    ManifestRecord（record 域）带 outcome/errorCode 往返保留、旧记录缺字段
//    读回 undefined 不炸（isValidManifest 不拒可选字段）。
// 3. 损坏降级：JSON 损坏 / 形状不合法 → null（未终局语义），消费方按「无投影」。
// 4. runId 防穿越：白名单外 runId 拒绝（文件名由 runId 直接拼出的路径安全线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ManifestStore,
  readRunTerminalManifest,
  writeRunTerminalManifest,
  type ManifestRecord,
  type RunTerminalManifest,
} from "../persistence/manifest-store.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-terminal-manifest-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeManifest(overrides: Partial<RunTerminalManifest> = {}): RunTerminalManifest {
  return {
    id: "wf-1719500000000-abcd",
    workflowName: "review-fix-loop",
    outcome: "completed",
    settledAt: 1719500001000,
    ...overrides,
  };
}

// ── 1. 三形态写读闭环 ────────────────────────────────────────

describe("run 终局投影三形态写读（验收 a：manifest 侧）", () => {
  it("成功 = completed（errorCode 缺省不落键）", async () => {
    await writeRunTerminalManifest(dir, makeManifest({ outcome: "completed" }));

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toEqual({
      id: "wf-1719500000000-abcd",
      workflowName: "review-fix-loop",
      outcome: "completed",
      settledAt: 1719500001000,
    });
    expect(read).not.toHaveProperty("errorCode");
  });

  it("失败 = failed + errorCode", async () => {
    await writeRunTerminalManifest(
      dir,
      makeManifest({ outcome: "failed", errorCode: "engine_crashed" }),
    );

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toMatchObject({ outcome: "failed", errorCode: "engine_crashed" });
  });

  it("取消 = cancelled（errorCode 缺省）", async () => {
    await writeRunTerminalManifest(dir, makeManifest({ outcome: "cancelled" }));

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toMatchObject({ outcome: "cancelled" });
    expect(read).not.toHaveProperty("errorCode");
  });

  it("文件落在 <dir>/<runId>.json（与 run state / journal 同 stem 的布局锚）", async () => {
    await writeRunTerminalManifest(dir, makeManifest());
    expect(fs.existsSync(path.join(dir, "wf-1719500000000-abcd.json"))).toBe(true);
  });
});

// ── 2. 旧读侧兼容（验收 b） ──────────────────────────────────

describe("旧读侧兼容（无 outcome 字段读回 null/undefined 不炸）", () => {
  it("旧 manifest（无 outcome 字段的手写形态）→ readRunTerminalManifest 返回 null", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      JSON.stringify({ id: "wf-1719500000000-abcd", status: "closed" }),
      "utf-8",
    );

    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

  it("outcome 词表外值（漂移形态）→ null 降级，不误判已终局", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      JSON.stringify({ id: "x", workflowName: "w", outcome: "done", settledAt: 1 }),
      "utf-8",
    );

    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

  it("ManifestRecord 带 outcome/errorCode：writeManifest → readManifest 往返保留（record 域投影能力面）", async () => {
    const store = new ManifestStore(dir);
    const record: ManifestRecord = {
      id: "rec-1",
      rootSessionId: "root",
      agentName: "reviewer",
      status: "closed",
      createdAt: 1,
      outcome: "failed",
      errorCode: "engine_crashed",
    };
    await store.writeManifest(record);

    const read = await store.readManifest("rec-1");
    expect(read).toMatchObject({ id: "rec-1", outcome: "failed", errorCode: "engine_crashed" });
  });

  it("旧 ManifestRecord（无 outcome 字段）readManifest 正常返回且 outcome undefined", async () => {
    const store = new ManifestStore(dir);
    const record: ManifestRecord = {
      id: "rec-old",
      rootSessionId: "root",
      agentName: "reviewer",
      status: "closed",
      createdAt: 1,
    };
    await store.writeManifest(record);

    const read = await store.readManifest("rec-old");
    expect(read).not.toBeNull();
    expect(read?.outcome).toBeUndefined();
    expect(read?.errorCode).toBeUndefined();
  });
});

// ── 3. 损坏降级 ──────────────────────────────────────────────

describe("损坏降级（未终局语义，不炸）", () => {
  it("JSON 损坏 → null", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      "{not json",
      "utf-8",
    );

    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

  it("文件不存在（未终局/已清理）→ null", async () => {
    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });
});

// ── 4. runId 防穿越 ──────────────────────────────────────────

describe("runId 白名单（路径穿越防线）", () => {
  it("路径穿越形态 runId 写/读均拒绝", async () => {
    await expect(
      writeRunTerminalManifest(dir, makeManifest({ id: "../escape" })),
    ).rejects.toThrow(/非法 runId/);
    await expect(readRunTerminalManifest(dir, "../escape")).rejects.toThrow(/非法 runId/);
    await expect(readRunTerminalManifest(dir, ".hidden")).rejects.toThrow(/非法 runId/);
  });
});
