// golden-replay.zcode.test.ts —— zcode 引擎 golden 回放层（conformance 免 LLM 默认
// CI 层）。语料 = app-server NDJSON 帧序列（附录 A.2 任务生命周期帧序；采集 SSOT
// = @zhushanwen/zcode-subagent-cli src/__golden__/zcode-golden-appserver.json）——双副本 diff
// 校验（fixture 与 golden-sample.ts 内嵌副本一致，防漂移：更新样本必须同步两处，
// 探针的干跑校验消费内嵌副本，两处不一致 = 探针在测旧契约）+ 帧形态不变量断言
// （A8「golden 帧序列语料 diff 通过」的本仓段）。
//
// 2026-09 重构（共享宿主 HOME）：CLI spawn 链删除后 spawn stdout 语料（单 JSON
// 样本及其 fixture）随 spawn 回归一并删除，本层仅保留 app-server 帧序列语料
// （常驻通道唯一生产形态）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// 基线三层②（W10）：引擎层 golden 随引擎包——内嵌副本经 zcode 包公共导出面
// 消费，fixture SSOT = zcode 包 src/__golden__/（core 不再深路径 import 内建副本）。
import { ZCODE_APPSERVER_GOLDEN } from "@zhushanwen/zcode-subagent-cli";

// conformance 目录（engine/__tests__/conformance）→ 引擎包 __golden__ 的相对定位
const appserverFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../zcode-subagent-cli/src/__golden__", "zcode-golden-appserver.json",
);

interface AppServerGoldenFile {
  _meta: Record<string, unknown>;
  frames: { createResponse: string; pushStream: string[]; terminal: string[]; readResponse: string };
}
const appserverFixture = JSON.parse(readFileSync(appserverFixturePath, "utf8")) as AppServerGoldenFile;

describe("zcode app-server golden 回放（conformance C3 帧形态，免 LLM/免二进制）", () => {
  it("双副本 diff：golden-sample.ts 内嵌副本 === fixture frames（防漂移，A8 本仓段）", () => {
    expect(ZCODE_APPSERVER_GOLDEN.createResponse).toBe(appserverFixture.frames.createResponse);
    expect(ZCODE_APPSERVER_GOLDEN.pushStream).toEqual(appserverFixture.frames.pushStream);
    expect(ZCODE_APPSERVER_GOLDEN.terminal).toEqual(appserverFixture.frames.terminal);
    expect(ZCODE_APPSERVER_GOLDEN.readResponse).toBe(appserverFixture.frames.readResponse);
  });

  it("create 应答形状：权威 sessionId 在 session.sessionId（projection.sessionId 恒 unknown 勿用）", () => {
    const create = JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse) as {
      session: { sessionId: string };
      projection: { sessionId: string };
    };
    expect(create.session.sessionId).toMatch(/^sess_/);
    expect(create.projection.sessionId).toBe("unknown");
  });

  it("推送流帧形态：stream.chunk 无文本（文本在 session/event delta）——文本三源恒等（A8 不变量 1）", () => {
    const pushes = ZCODE_APPSERVER_GOLDEN.pushStream.map((l) => JSON.parse(l) as {
      method: string;
      params?: { kind?: string; payload?: { delta?: string } };
    });
    const chunks = pushes.filter((f) => f.params?.kind === "stream.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.params?.payload?.delta).toBeUndefined();

    const deltaJoined = pushes
      .filter((f) => f.method === "session/event" && typeof f.params?.payload?.delta === "string")
      .map((f) => f.params?.payload?.delta)
      .join("");
    const terminal = ZCODE_APPSERVER_GOLDEN.terminal.map((l) => JSON.parse(l) as {
      params?: { kind?: string; payload?: { response?: string; usage?: { inputTokens: number; outputTokens: number } } };
    });
    const closing = terminal.find((f) => f.params?.payload?.response !== undefined);
    expect(closing?.params?.payload?.response).toBe(deltaJoined);

    const read = JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse) as {
      messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
    };
    const readText = (read.messages.at(-1)?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(readText).toBe(deltaJoined); // text_delta 拼接 == 收尾帧 == read 全文
  });

  it("终态权威帧：turn.terminal 存在且先于收尾帧；usage 与 read step-finish tokens 同源（漂移对照锚点）", () => {
    const terminal = ZCODE_APPSERVER_GOLDEN.terminal.map((l) => JSON.parse(l) as {
      params?: { kind?: string; status?: string; payload?: { usage?: { inputTokens: number; outputTokens: number } } };
    });
    const terminalFrameIdx = terminal.findIndex((f) => f.params?.kind === "turn.terminal");
    const closingFrameIdx = terminal.findIndex((f) => f.params?.payload?.usage !== undefined);
    expect(terminalFrameIdx).toBeGreaterThanOrEqual(0);
    expect(terminal[terminalFrameIdx]?.params?.status).toBe("success");
    expect(terminalFrameIdx).toBeLessThan(closingFrameIdx);

    // usage 跨源对照锚点：收尾帧 usage == read 应答 step-finish tokens（同一轮真实
    // 计费面，两源必须一致；旧 spawn golden 对照随语料删除）
    const read = JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse) as {
      messages: Array<{ info: { role: string }; parts: Array<{ type: string; tokens?: { input: number; output: number } }> }>;
    };
    const stepFinish = (read.messages.at(-1)?.parts ?? []).find((p) => p.type === "step-finish");
    expect(terminal[closingFrameIdx]?.params?.payload?.usage).toEqual({
      inputTokens: stepFinish?.tokens?.input,
      outputTokens: stepFinish?.tokens?.output,
    });
  });
});
