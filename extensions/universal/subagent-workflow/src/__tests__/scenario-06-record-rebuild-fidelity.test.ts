// src/__tests__/scenario-06-record-rebuild-fidelity.test.ts
//
// 场景 6（修订设计 §4 新增，[D1]）：record 重建保真——真收编链（recoverCrashedRuns）
// 落 run-interrupted 后，直接检查盘上 record 事件流。
//
// 通过标准（原文）：agent-settled 事件含 result 全文；run-created 含 scriptSource；
// 在途调用无 settled 事件；run-interrupted 事件在场。
//
// 分层说明：单测层（fold 重建逐字段等价）在 record-mode/rebuild-fidelity.test.ts
// （u-foundation）；本文件是场景层——收编经真 recoverCrashedRuns 链（loadAll fold →
// interruptRun），并承接任务书 D16 ③ 强制连带断言：session_read workflow 概览对
// record 流 run 正常渲染（runId/状态/calls 可见），错误契约形态保持（不可读流由
// 概览函数容错承接——上层 skippedRuns 归 session-reader 侧既有用例）。概览实装的
// 加载经 tsx 子进程 probe（vite resolver 不解析跨包物理相对路径——见
// scenario-kit 尾注）。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  adoptCrashedRun,
  mkScenarioEnv,
  runSessionReaderProbe,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
} from "./record-mode/scenario-kit.ts";
import { mkCtxWith, registeredEntry } from "./record-mode/helpers.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

const RUN_ID = "wf-s6-fidelity";

const RESULT_A = {
  content: "stage-A output: 42 items",
  durationMs: 41_000,
  sessionId: "sess-a",
  sessionFile: "/abs/sessions/a.jsonl",
};

describe("场景 6：record 重建保真（真收编链 + D16 ③ 概览消费）", () => {
  it("kill → 重启收编（recoverCrashedRuns）→ 盘上流：settled 含 result 全文 / created 含 scriptSource / 在途无 settled / run-interrupted 在场", async () => {
    const env = mkScenarioEnv("06");
    try {
      // 崩溃形态（三调用 run 第 2 调用完成后）：无 interrupted 帧
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A", result: RESULT_A }, { agent: "B" }],
        inflight: [{ agent: "C" }],
        interrupted: false,
      });

      // 重启收编（真链：store.loadAll fold → interruptRun 落 run-interrupted 转移帧）
      const adopted = await adoptCrashedRun(env, RUN_ID);
      expect(adopted.recovered).toBe(1);

      // 直接检查盘上 record 事件流（场景 6 通过标准）
      const raw = readFileSync(env.recordPath(RUN_ID), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const created = lines.find((l) => l["type"] === "run-created");
      expect(created?.["scriptSource"]).toBe(THREE_CALL_SERIAL_SCRIPT);
      const settled = lines.filter((l) => l["type"] === "agent-settled");
      expect(settled).toHaveLength(2);
      expect(settled[0]?.["result"]).toEqual(RESULT_A);
      expect(settled.find((l) => l["taskIndex"] === 2)).toBeUndefined(); // 在途 C 无 settled
      expect(lines.some((l) => l["type"] === "run-interrupted")).toBe(true); // 收编帧在场

      // 收编不覆盖：收编后 loadAll 重建仍保全文（设计目标 1 断言面，场景层复述）
      const store = new JsonlRunStore({
        sessionDir: env.sessionDir,
        ctx: mkCtxWith([registeredEntry(RUN_ID, env.recordPath(RUN_ID))]) as never,
      });
      const [run] = await store.loadAll();
      expect(run!.spec.scriptSource).toBe(THREE_CALL_SERIAL_SCRIPT);
      expect(run!.state.calls.get(0)!.result).toEqual(RESULT_A);
    } finally {
      env.cleanup();
    }
  });

  it("[D16 ③] session_read workflow 概览对本场景 record 流正常渲染：runId/中断状态/calls 可见（sessionFile 可提取），错误契约形态保持", async () => {
    const env = mkScenarioEnv("06ov");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [
          { agent: "A", result: { content: "a", sessionFile: "/abs/sessions/a.jsonl" } },
          { agent: "B", result: { content: "b", sessionFile: "/abs/sessions/b.jsonl" } },
        ],
        inflight: [{ agent: "C" }],
      });

      // 概览链消费（D16 ③ 换源后：record 流直读；tsx 子进程加载 session-reader
      // 实装——断言体在 driver-session-reader.ts 的 overview-interrupted 族）
      await runSessionReaderProbe("overview-interrupted", env.recordPath(RUN_ID), RUN_ID);
      // 错误契约形态保持：坏行/不可读流的容错（上层 skippedRuns 的承接前提）
      await runSessionReaderProbe("overview-corrupt-tolerant", env.recordPath(RUN_ID), RUN_ID);
    } finally {
      env.cleanup();
    }
  });
});
