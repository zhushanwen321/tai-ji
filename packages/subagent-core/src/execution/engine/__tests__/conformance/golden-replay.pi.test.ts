// golden-replay.pi.test.ts —— pi 引擎 golden 回放层（conformance 免 LLM 默认 CI 层，
// 设计 §3.3.8 两层结构的第一层）。锚定物 = 统一 AgentEvent 序列（onEvent 出口 / journal
// 落盘形态）——pi 的完整翻译链（parseSpawnLine → handleSdkEvent）闭包在 session-runner
// 的 spawn 状态里，conformance 以「翻译产物」为契约锚点（journal/record 消费的正是它）。
//
// 覆盖：C3 不变量（流式口径）+ journal 往返保真（replayJournal === golden 序列）+
// parseSpawnLine 对实录行形态的回归（pi parser 的纯函数面）。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../assembly/types.ts";
import { JournalWriter, replayJournal } from "../../common/event-journal.ts";
import { parseSpawnLine } from "@zhushanwen/pi-subagent-cli";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

interface PiGoldenFile {
  events: AgentEvent[];
  content: string;
}

// 引擎层 golden 随引擎包（基线三层②）：pi 包 __golden__/ 为采集 SSOT（W10 前
// 副本在 conformance/__fixtures__，已上移；core 侧本测试为协议层回放消费方）。
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../pi-subagent-cli/src/__golden__", "pi-golden-events.json",
);
const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as PiGoldenFile;

describe("pi golden 回放（conformance C3/C5-journal，免 LLM）", () => {
  it("golden 事件序列满足全部产出不变量（流式口径：text_delta 拼接 === content）", () => {
    assertAgentEventInvariants(golden.events, { granularity: "stream", content: golden.content });
  });

  it("journal 往返保真：golden 序列经 JournalWriter 落盘后 replayJournal 逐事件相等", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-golden-journal-"));
    const writer = new JournalWriter({
      path: join(dir, "journal-sa-pi-golden.jsonl"),
      taskId: "sa-pi-golden",
      engineId: "pi",
    });
    try {
      for (const ev of golden.events) writer.append(ev);
      await writer.close();
      const replayed = replayJournal(writer.path);
      // 深比较（含 undefined 键缺省语义——JSON 序列化后 undefined 字段自然消失，两侧同构）
      expect(replayed).toEqual(golden.events);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
    if (toolLine?.kind === "event") expect(toolLine.event.type).toBe("tool_execution_start");

    const msgEnd = parseSpawnLine(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      }),
    );
    expect(msgEnd?.kind).toBe("event");
    if (msgEnd?.kind === "event") expect(msgEnd.event.type).toBe("message_end");

    const turnEnd = parseSpawnLine(JSON.stringify({ type: "turn_end" }));
    expect(turnEnd?.kind).toBe("event");
  });
});
