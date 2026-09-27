// src/execution/__tests__/state-marker-outcome-projection.test.ts
//
// [P1b-2 / D5] `.state` 收条 sidecar 的 outcome/errorCode 终局投影单测
//（state-marker.ts 写读两侧）。
//
// 锁四面：
// 1. 三形态写读闭环：writeSettledState 携带 outcome/errorCode → readStateMarker
//    读回一致（成功=completed、失败=failed+errorCode、取消=cancelled）。
// 2. 旧读侧兼容：旧 `.state`（无 outcome 字段的存量三值形态）读回 undefined
//    不炸；outcome 词表外值 → 守卫丢弃归 undefined（不误投影）。
// 3. 向后兼容：payload 不传 outcome/errorCode 时字段不落键（存量调用方零变化）。
// 4. 非法 errorCode（非 string）→ 丢弃。
//
// [R1 修复补充] writeRunStateProjection（run 域分立原语）断言：三形态写读、
// sidecar 落盘形态、失败分支返回 false（scripts/check-record-write-surface.mjs
// 的 R1 写面守卫按域分立语义——run 域投影与 record 域 writeSettledState 分立）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _setStateMarkerSleepForTest, readStateMarker, writeRunStateProjection, writeSettledState } from "../persistence/state-marker.ts";

let dir: string;
let sessionFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-marker-outcome-"));
  sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, "{}\n", "utf-8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ── 1. 三形态写读闭环（验收 a：.state 侧） ───────────────────

describe(".state outcome 投影三形态写读", () => {
  it("成功 = completed（errorCode 不落键）", () => {
    expect(writeSettledState(sessionFile, { endedAt: 100, outcome: "completed" })).toBe(true);

    const marker = readStateMarker(sessionFile);
    expect(marker).toMatchObject({ status: "idle", endedAt: 100, outcome: "completed" });
    expect(marker).not.toHaveProperty("errorCode");
  });

  it("失败 = failed + errorCode", () => {
    expect(
      writeSettledState(sessionFile, { endedAt: 100, outcome: "failed", errorCode: "engine_crashed" }),
    ).toBe(true);

    expect(readStateMarker(sessionFile)).toMatchObject({
      status: "idle",
      outcome: "failed",
      errorCode: "engine_crashed",
    });
  });

  it("取消 = cancelled", () => {
    expect(writeSettledState(sessionFile, { endedAt: 100, outcome: "cancelled" })).toBe(true);

    expect(readStateMarker(sessionFile)).toMatchObject({ status: "idle", outcome: "cancelled" });
  });

  it("与 stopReason 正交共存（既有字段不丢）", () => {
    expect(writeSettledState(sessionFile, { stopReason: "completed", endedAt: 100, outcome: "completed" })).toBe(true);

    expect(readStateMarker(sessionFile)).toMatchObject({
      status: "idle",
      reason: "completed",
      outcome: "completed",
    });
  });
});

// ── 2. 旧读侧兼容（验收 b：旧 .state 无字段不炸） ────────────

describe("旧 .state 兼容（无 outcome 字段）", () => {
  it("存量三值形态（status/reason/endedAt）读回 outcome undefined 不炸", () => {
    fs.writeFileSync(
      `${sessionFile}.state`,
      JSON.stringify({ status: "idle", reason: "completed", endedAt: 100 }),
      "utf-8",
    );

    const marker = readStateMarker(sessionFile);
    expect(marker).toMatchObject({ status: "idle", reason: "completed", endedAt: 100 });
    expect(marker?.outcome).toBeUndefined();
    expect(marker?.errorCode).toBeUndefined();
  });

  it("outcome 词表外值 → 守卫丢弃归 undefined（不误投影）", () => {
    fs.writeFileSync(
      `${sessionFile}.state`,
      JSON.stringify({ status: "idle", endedAt: 100, outcome: "done" }),
      "utf-8",
    );

    const marker = readStateMarker(sessionFile);
    expect(marker?.status).toBe("idle");
    expect(marker?.outcome).toBeUndefined();
  });

  it("errorCode 非法值（非 string）→ 丢弃", () => {
    fs.writeFileSync(
      `${sessionFile}.state`,
      JSON.stringify({ status: "idle", outcome: "failed", errorCode: 42 }),
      "utf-8",
    );

    const marker = readStateMarker(sessionFile);
    expect(marker?.outcome).toBe("failed");
    expect(marker?.errorCode).toBeUndefined();
  });
});

// ── 3. 向后兼容（payload 缺省不落键） ────────────────────────

describe("payload 缺省（存量调用方零变化）", () => {
  it("不传 outcome/errorCode 时 .state 文件无这两个键", () => {
    expect(writeSettledState(sessionFile, { stopReason: "failed", endedAt: 100 })).toBe(true);

    const raw = JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("outcome");
    expect(raw).not.toHaveProperty("errorCode");
  });
});

// ── 4. run 域分立原语 writeRunStateProjection ────────────────
//
// [P1b-2 / R1 修复] run 域（workflow run）终局 .state 投影的独立写入原语——与
// record 域 writeSettledState 分立（scripts/check-record-write-surface.mjs R1
// 写面守卫按域分立语义；record 七名原语的 store 外直调被拦，run 域投影消费方
// = worker-message-pump 的 manifest-write 输出动作）。落盘形态与 record 域
// idle 收条同源（writeStateMarker 单源：响亮重试 + 旧名清理）。

describe("writeRunStateProjection（run 域分立原语）", () => {
  it("三形态写读闭环（completed / failed+errorCode / cancelled）", () => {
    expect(writeRunStateProjection(sessionFile, { endedAt: 100, outcome: "completed" })).toBe(true);
    expect(readStateMarker(sessionFile)).toMatchObject({ status: "idle", outcome: "completed" });

    expect(
      writeRunStateProjection(sessionFile, { endedAt: 200, outcome: "failed", errorCode: "engine_crashed" }),
    ).toBe(true);
    expect(readStateMarker(sessionFile)).toMatchObject({
      status: "idle",
      outcome: "failed",
      errorCode: "engine_crashed",
    });

    expect(writeRunStateProjection(sessionFile, { endedAt: 300, outcome: "cancelled" })).toBe(true);
    expect(readStateMarker(sessionFile)).toMatchObject({ status: "idle", outcome: "cancelled" });
  });

  it("落盘文件 = <sessionFile>.state（run state 文件 stem 的 sidecar 形态）", () => {
    expect(writeRunStateProjection(sessionFile, { endedAt: 100, outcome: "completed" })).toBe(true);

    expect(fs.existsSync(`${sessionFile}.state`)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ status: "idle", endedAt: 100, outcome: "completed" });
    expect(raw).not.toHaveProperty("stopReason");
    expect(raw).not.toHaveProperty("reason");
  });

  it("失败分支：父目录不存在 → 重试耗尽返回 false（响亮重试语义同源，sleep 替身免真实退避）", () => {
    _setStateMarkerSleepForTest(() => {});
    try {
      // sidecar = <basis>.state，basis 的父目录缺失 → writeFileSync 恒 ENOENT
      //（对齐既有 state-marker.test.ts「写路径父目录不存在」失败形态）
      const missingBasis = path.join(dir, "no-such-dir", "basis");

      expect(writeRunStateProjection(missingBasis, { endedAt: 100, outcome: "completed" })).toBe(false);
      expect(fs.existsSync(`${missingBasis}.state`)).toBe(false);
    } finally {
      _setStateMarkerSleepForTest(undefined); // 恢复实装同步等待
    }
  });
});
