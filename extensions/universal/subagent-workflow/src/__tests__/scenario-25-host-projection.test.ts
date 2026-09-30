// src/__tests__/scenario-25-host-projection.test.ts
//
// 场景 25（修订设计 §4，D2/D16）：中断 run 宿主投影。
//
// 两段结构（任务书 §2）：
// - 无门段（节点级默认跑）：宿主投影数据面——中断形态条目（workflow-record-entry
//   契约单源）、概览链三态渲染、执行树家族链 calls[].sessionFile 提取（D16 ③
//   强制连带断言——挂靠本文件：宿主投影族同域）。session-reader 实装经 tsx 子进程
//   probe 加载（vite resolver 不解析跨包物理相对路径——见 scenario-kit 尾注）。
// - CDP 门段（describe.skipIf(!process.env.TAIJI_E2E_HOST_PROJECTION_CDP)）：
//   真机 dev app（TAIJI_DEV_BACKGROUND=1 pnpm dev + CDP）断 GUI workflow 列表
//   文案字面量「已中断（可续跑）」（复审 F4：文案可脚本断言、色调已由
//   state-tone-lock L1 锁死）——D3 端到端验收剧本注入 env 触发。
import { describe, expect, it } from "vitest";

import { buildWorkflowRecordInterruptedEntryData } from "@zhushanwen/subagent-core";

import {
  mkScenarioEnv,
  runSessionReaderProbe,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
} from "./record-mode/scenario-kit.ts";
import { registeredEntry } from "./record-mode/helpers.ts";

const RUN_ID = "wf-s25-projection";

describe("场景 25 无门段：中断 run 宿主投影数据面", () => {
  it("中断形态条目（workflow-record-entry 契约单源）：status 字面量 'interrupted'", () => {
    const entry = buildWorkflowRecordInterruptedEntryData({
      runId: RUN_ID,
      workflowName: "proj-flow",
      errorCode: "crashed",
      interruptedAt: 1_759_000_000_000,
      callCount: 2,
      usedTokens: 0,
    });
    // D2 宿主投影②：进入 interrupted 时写中断形态条目——kind 复用 settled 条目
    // 形态，中断语义由 status 字面量 'interrupted' 承载（schema 契约单源
    // workflow-record-entry 的现行设计）
    expect(entry).toMatchObject({ kind: "settled", runId: RUN_ID, status: "interrupted" });
  });

  it("概览链三态渲染：中断 run 显示 interrupted（非 running）；复活流回 running（run-resumed 转移证据被概览链消费）", async () => {
    const env = mkScenarioEnv("25ov");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [
          { agent: "A", result: { content: "a", sessionFile: "/abs/sessions/a.jsonl" } },
          { agent: "B", result: { content: "b", sessionFile: "/abs/sessions/b.jsonl" } },
        ],
        inflight: [{ agent: "C" }],
      });
      // 中断态：概览渲染 interrupted（GUI「已中断（可续跑）」的数据面——文案消费
      // 归 renderer，词面由 state-tone-lock 锁）
      await runSessionReaderProbe("overview-interrupted", env.recordPath(RUN_ID), RUN_ID);
      // 复活流（run-resumed 落流、无终局帧）：run-resumed 是 interrupted → running
      // 的转移证据，session_read 概览链消费该帧回 running——与 runtime
      // journal-projection（foldRunEventCheckpoint 同款转移帧消费）状态语义一致。
      await runSessionReaderProbe("overview-resumed", env.recordPath(RUN_ID), RUN_ID);
    } finally {
      env.cleanup();
    }
  });

  it("[D16 ③] 执行树家族链：calls[].sessionFile 从 record 流新数据源可提取——workflow 子节点不退空", async () => {
    const env = mkScenarioEnv("25fam");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [
          { agent: "A", result: { content: "a", sessionFile: "/abs/sessions/a.jsonl" } },
          { agent: "B", result: { content: "b", sessionFile: "/abs/sessions/b.jsonl" } },
        ],
        inflight: [{ agent: "C" }],
      });

      // 家族链发现面（D16 ③ 换源后的单点提取函数）：settled 帧 result.sessionFile
      // 按 taskIndex 归位提取，非空 = workflow 子节点可跳转（不退空）
      await runSessionReaderProbe("family-files", env.recordPath(RUN_ID), RUN_ID);

      // v2 注册条目锚点 = record 流路径（新形态实体——发现链数据面）
      const entry = registeredEntry(RUN_ID, env.recordPath(RUN_ID));
      expect(entry.data).toMatchObject({
        v: 2,
        kind: "registered",
        runId: RUN_ID,
        recordPath: env.recordPath(RUN_ID),
      });
      expect((entry.data as { recordPath: string }).recordPath.endsWith(".record.jsonl")).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

// ── CDP 门段：真机 dev app 断 GUI 列表文案（D3 剧本注入 env 触发）────────────
//
// 前置（AGENTS.md 前端调试规约）：TAIJI_DEV_BACKGROUND=1 pnpm dev 起本 worktree
// 实例，node apps/electron/scripts/dev-instance.mjs --print 取 CDP 端口注入
// TAIJI_E2E_HOST_PROJECTION_CDP；窗口内已构造一个 interrupted run（剧本步骤）。
// 断言 = workflow 列表渲染「已中断（可续跑）」（非「运行中」）；resume 后复查
// 恢复 running 投影。
describe("场景 25 CDP 门段：GUI workflow 列表文案（真机 dev app）", () => {
  it.skipIf(!process.env.TAIJI_E2E_HOST_PROJECTION_CDP)("中断 run 列表显示「已中断（可续跑）」；resume 后恢复 running 投影", async () => {
    const port = Number(process.env.TAIJI_E2E_HOST_PROJECTION_CDP);
    const listRes = await fetch(`http://localhost:${port}/json/list`);
    const pages = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
    const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
    expect(page, "CDP page target not found").toBeDefined();

    const evalBodyText = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(page!.webSocketDebuggerUrl);
        const timeout = setTimeout(() => reject(new Error("CDP evaluate timeout")), 10_000);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: "document.body.innerText", returnByValue: true },
          }));
        };
        ws.onmessage = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { result?: { value?: unknown } } };
          if (msg.id === 1) {
            clearTimeout(timeout);
            ws.close();
            resolve(String(msg.result?.result?.value ?? ""));
          }
        };
        ws.onerror = () => reject(new Error("CDP websocket error"));
      });

    // 中断态文案（复审 F4：文案可脚本断言——字面量）
    const bodyOnInterrupted = await evalBodyText();
    expect(bodyOnInterrupted).toContain("已中断（可续跑）");
    expect(bodyOnInterrupted).not.toContain("运行中");

    // resume 后复查（剧本执行 resume 步骤后轮询恢复 running 投影）
    const deadline = Date.now() + 60_000;
    for (;;) {
      const body = await evalBodyText();
      if (!body.includes("已中断（可续跑）") && body.includes("运行中")) break;
      if (Date.now() > deadline) throw new Error("workflow list did not return to running within 60s");
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});
