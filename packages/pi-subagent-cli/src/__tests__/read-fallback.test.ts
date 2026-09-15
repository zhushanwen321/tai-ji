// src/__tests__/read-fallback.test.ts
//
// read 第②级降级（journal 重放 → SessionView）单元测试。覆盖验收面：
//   - journalPath 缺失 / 空串 / 文件不存在 → undefined（调用方落 ③级 outcome-only）；
//   - 裸事件行（{type:...}）与包装事件行（{event:{type:...}}）两种形态都收；
//   - 单行损坏 / 未知 type 不中断重放（append-only journal 中断写入是已知形态）；
//   - 全部行无效（events.length === 0）→ undefined；
//   - 重放投影：turns 文本聚合 / usage 聚合 / sessionId 取自 handle.sessionRef。
//
// journal 文件一律 mkdtempSync 自建自删（fs-guard 纪律：不触碰真实数据目录）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replayJournalToSessionView } from "../read-fallback.ts";
import type { EngineHandle } from "../port-types.ts";

function makeHandle(journalPath?: string, sessionId = "sess-42"): EngineHandle {
  return {
    data: {
      v: 1,
      engineId: "pi",
      sessionRef: sessionId === "" ? {} : { recordId: "rec-1", sessionId },
      adapterVersion: "1.0.0",
      ...(journalPath !== undefined ? { journalPath } : {}),
    },
  };
}

describe("replayJournalToSessionView（read 第②级：journal 重放）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-cli-test-journal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("journalPath 缺失 / 空串 → undefined（③级 outcome-only 降级判据）", () => {
    expect(replayJournalToSessionView(makeHandle(undefined), "pi")).toBeUndefined();
    expect(replayJournalToSessionView(makeHandle(""), "pi")).toBeUndefined();
  });

  it("journal 文件不存在 → undefined（不抛——降级链静默下沉）", () => {
    const missing = join(dir, "no-such-journal.jsonl");
    expect(replayJournalToSessionView(makeHandle(missing), "pi")).toBeUndefined();
  });

  it("裸事件行重放：turns 文本聚合 + usage 聚合 + sessionId 取自 handle.sessionRef", () => {
    const journalPath = join(dir, "journal.jsonl");
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ type: "text_delta", delta: "hello " }),
        JSON.stringify({ type: "text_delta", delta: "world" }),
        // message_end 先于 turn_end（pi 事件序）：usage 并入当前 turn
        JSON.stringify({
          type: "message_end",
          usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5 },
        }),
        JSON.stringify({ type: "turn_end" }),
      ].join("\n"),
    );

    const view = replayJournalToSessionView(makeHandle(journalPath), "pi");
    expect(view).toBeDefined();
    expect(view!.source).toBe("journal");
    expect(view!.engineId).toBe("pi");
    expect(view!.sessionId).toBe("sess-42");
    expect(view!.turns).toHaveLength(1);
    expect(view!.turns[0]!.text).toBe("hello world");
    expect(view!.turns[0]!.closed).toBe(true);
    expect(view!.usage).toMatchObject({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.5,
      total: 17,
    });
  });

  it("包装事件行（{event:{...}}）与裸行混收；损坏行 / 未知 type 行跳过不中断", () => {
    const journalPath = join(dir, "mixed.jsonl");
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ type: "text_delta", delta: "kept" }),
        "not-json {{{", // 单行损坏（中断写入形态）
        JSON.stringify({ type: "unknown_future_event", payload: 1 }), // 非 AgentEvent 白名单
        JSON.stringify({ event: { type: "turn_end" } }), // 包装形态
        "", // 空行
      ].join("\n"),
    );

    const view = replayJournalToSessionView(makeHandle(journalPath, "sess-mix"), "pi");
    expect(view).toBeDefined();
    expect(view!.turns).toHaveLength(1);
    expect(view!.turns[0]!.text).toBe("kept");
  });

  it("全部行无效（零有效事件）→ undefined", () => {
    const journalPath = join(dir, "garbage.jsonl");
    writeFileSync(journalPath, ["not-json", JSON.stringify({ noType: true }), ""].join("\n"));
    expect(replayJournalToSessionView(makeHandle(journalPath), "pi")).toBeUndefined();
  });
});
