// src/__tests__/record-mode/driver-session-reader.ts
//
// [u4a][D16 ③] session-reader 读侧消费链的断言 driver（tsx 子进程载体，非测试
// 文件）。vitest 的 vite resolver 不解析跨包物理相对路径（extensions/
// universal/session-reader/...），而纯 node/tsx 解析可命中 session-reader 包自身
// 的 node_modules（@zhushanwen/pi-ext-guards / session-core）——本 driver 在子进程
// 内以真实 node 解析加载 session-reader 实装并执行断言。
//
// env：WF_PROBE_MODE（断言族）/ WF_PROBE_RECORD_PATH（record 流文件）/
// WF_PROBE_RUN_ID。断言失败 = console.error 详情 + exit 1；全过 = exit 0。
import { readFileSync } from "node:fs";

import { parseRunRecordStream } from "../../../../session-reader/src/core/workflow.ts";
import { extractRecordStreamSessionFiles } from "../../../../session-reader/src/discovery/workflows.ts";

const MODE = process.env.WF_PROBE_MODE ?? "";
const RECORD_PATH = process.env.WF_PROBE_RECORD_PATH ?? "";
const RUN_ID = process.env.WF_PROBE_RUN_ID ?? "";

if (MODE === "" || RECORD_PATH === "" || RUN_ID === "") {
  process.stderr.write("driver-session-reader: WF_PROBE_MODE / WF_PROBE_RECORD_PATH / WF_PROBE_RUN_ID required\n");
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`driver-session-reader[${MODE}]: ${message}\n`);
  process.exit(1);
}

function expectCond(cond: boolean, message: string): void {
  if (!cond) fail(message);
}

const content = readFileSync(RECORD_PATH, "utf8");

switch (MODE) {
  case "overview-interrupted": {
    // 概览链三态渲染：中断 run → status 'interrupted'（非 running、非整体挂）；
    // steps 可见（含 sessionFile）；在途 call running。
    const overview = parseRunRecordStream(content, RUN_ID, RECORD_PATH);
    expectCond(overview.runId === RUN_ID, `runId mismatch: ${overview.runId}`);
    expectCond(overview.status === "interrupted", `status expected interrupted, got ${overview.status}`);
    expectCond(overview.steps.length === 3, `steps expected 3, got ${overview.steps.length}`);
    const stepA = overview.steps.find((s) => s.index === 0);
    expectCond(stepA?.status === "done", `step0 status expected done, got ${stepA?.status}`);
    expectCond(
      stepA?.sessionFile === "/abs/sessions/a.jsonl",
      `step0 sessionFile expected, got ${String(stepA?.sessionFile)}`,
    );
    const stepC = overview.steps.find((s) => s.index === 2);
    expectCond(stepC?.status === "running", `step2 status expected running, got ${stepC?.status}`);
    break;
  }
  case "overview-resumed": {
    // 复活流的概览状态：run-resumed 是 interrupted → running 的转移证据（[D2]
    // lifecycle fold 投影），概览链消费该帧清中断标记 → 复活 run 在 session_read
    // 概览回 running（与 runtime journal-projection 的 foldRunEventCheckpoint
    // 消费同一转移帧，两链状态语义一致）。
    const withResumed = [
      ...content.split("\n").filter((l) => l.trim()),
      JSON.stringify({ type: "run-resumed", ts: 1_759_000_001_000, reason: "resume plan: replay=1 redispatch=1" }),
    ].join("\n");
    const overview = parseRunRecordStream(withResumed, RUN_ID, RECORD_PATH);
    expectCond(overview.status === "running", `resumed stream returns to running in session_read overview, got ${overview.status}`);
    break;
  }
  case "overview-corrupt-tolerant": {
    // 错误契约形态保持：坏行（截断/垃圾）跳过不抛；完全不可读（undefined）→ 活跃兜底
    const corrupted = `${JSON.stringify({ type: "run-created", ts: 1, runId: RUN_ID, workflowName: "x", argsSummary: "{}", scriptSource: "s" })}\n{"type": "agent-started", ts\n`;
    const fromCorrupted = parseRunRecordStream(corrupted, RUN_ID, RECORD_PATH);
    expectCond(fromCorrupted.status === "running", `corrupted stream should fall back to running, got ${fromCorrupted.status}`);
    const fromMissing = parseRunRecordStream(undefined, RUN_ID, RECORD_PATH);
    expectCond(fromMissing.status === "running", `missing stream should fall back to running, got ${fromMissing.status}`);
    break;
  }
  case "family-files": {
    // 执行树家族链：calls[].sessionFile 从 record 流可提取（按 taskIndex 序），
    // workflow 子节点不退空
    const files = extractRecordStreamSessionFiles(content);
    expectCond(
      JSON.stringify(files) === JSON.stringify(["/abs/sessions/a.jsonl", "/abs/sessions/b.jsonl"]),
      `family sessionFiles mismatch: ${JSON.stringify(files)}`,
    );
    break;
  }
  default:
    fail(`unknown mode: ${MODE}`);
}

process.exit(0);
