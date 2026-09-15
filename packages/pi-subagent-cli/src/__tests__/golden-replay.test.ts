// golden-replay.test.ts —— pi 引擎层 golden（基线三层②，W10）：语料 = 引擎专属
// 样本 src/__golden__/pi-golden-events.json（统一 AgentEvent 序列锚点，core conformance
// 同款断言的包内权威副本）。断言：产出不变量（流式拼接 === content、终态唯一、
// usage 完整性）+ parseSpawnLine 对实录行形态的识别回归。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSpawnLine } from "../spawn-event-adapter.ts";

interface PiGoldenFile {
  events: Array<{ type: string; delta?: string; usage?: Record<string, number> }>;
  content: string;
}

const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "__golden__", "pi-golden-events.json"), "utf8"),
) as PiGoldenFile;

describe("pi 引擎层 golden（__golden__/pi-golden-events.json）", () => {
  it("产出不变量：终态唯一 turn_end、message_end 在其前、text_delta 拼接 === content（byte 级）", () => {
    const events = golden.events;
    const nonError = events.filter((e) => e.type !== "error");
    expect(nonError[nonError.length - 1]?.type).toBe("turn_end");
    const lastTurnEnd = events.map((e) => e.type).lastIndexOf("turn_end");
    expect(events.slice(0, lastTurnEnd).some((e) => e.type === "message_end")).toBe(true);

    const joined = events.filter((e) => e.type === "text_delta").map((e) => e.delta ?? "").join("");
    expect(Buffer.from(joined, "utf8").toString("hex")).toBe(
      Buffer.from(golden.content, "utf8").toString("hex"),
    );
  });

  it("message_end.usage 出现时为完整四项有限数", () => {
    for (const ev of golden.events) {
      if (ev.type !== "message_end" || ev.usage === undefined) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        expect(Number.isFinite(ev.usage[key])).toBe(true);
      }
    }
  });

  it("parseSpawnLine 回归：实录行形态（header/事件行）识别不漂移", () => {
    const header = parseSpawnLine(
      JSON.stringify({ type: "session", id: "sess-pi-golden", timestamp: "2026-08-25T01:00:00.000Z", cwd: "/tmp" }),
    );
    expect(header?.kind).toBe("header");

    const toolLine = parseSpawnLine(
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "ls" } }),
    );
    expect(toolLine?.kind).toBe("event");

    const turnEnd = parseSpawnLine(JSON.stringify({ type: "turn_end" }));
    expect(turnEnd?.kind).toBe("event");
  });
});
