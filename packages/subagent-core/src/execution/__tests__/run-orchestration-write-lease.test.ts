// src/execution/__tests__/run-orchestration-write-lease.test.ts
//
// [U2b / C3] spawn 侧写权声明挂钩（D3a v8 时机①——fresh spawn 全程声明，缺口 1
// 闭合）+ one-shot 成功分支 markRoundIdle 接线（SP-5 与 chat 轮末共享轮终语义）的
// 单元级断言：
//   1. one-shot pi 轮（kickOffChatRound 回填点）：run 应答 sessionFile 回填后
//      `.alive` 存在且 pid=本进程；轮终（settleOneShotOutcome SP-5 → markRoundIdle）
//      后 marker 跨轮保留（D3a/B5）；
//   2. 非 pi 引擎死亡（run reject → Continuation 失败分支收口 settleRoundFailed：
//      idle 可恢复 + 失败通知，无监督器 adopt 接管；旧 adopt 形态回填点
//      finalizeEngineOutcome 已删——adopt 链随 one-shot engine-run 编排退役）；
//   3. settleOneShotOutcome 直驱：markRoundIdle 簿记（idle 翻边 / round+1 /
//      result / closedReason 清除）+ `.alive` 不删 + pending:unregister 发射点②
//      store 簿记⑧单轨发射（恰好一次）；
//   4. workflow 域（executeAndAwait → runAndFinalize → outcomeToAgentResult 主回填
//      点）：sessionFile 回填后 `.alive` 存在且 pid=本进程；
//   5. [U2b 修复轮/D2] adoptEngineDeath 归口（adoptResumableAfterEngineDeath 三写
//      error/result/stopReason 语义等价，真实 store 链）。轮始 markRoundStarted 接线
//      的真实链用例在 conversation-continuation.test.ts 集成面（续聊派发即清
//      result 清除 + round 累加链不断）。
//
// 测试纪律：registerFakePiEngine 协议替身（conversation-continuation.test.ts 同源
// setup 形态，真实 timers + vi.waitFor）；sessionFile/marker 全部落 mkdtemp 自建目录；
// store 走服务内嵌真实 RecordStore（acquireWriteLease/markRoundIdle 真实实现）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentOutcome } from "../engine/types.ts";
import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { emptyRegistry } from "./helpers/model-registry-mock.ts";
import { makePi, type PiMock } from "./helpers/pi-mock.ts";
import { createRecord } from "../persistence/execution-record.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import { _resetLifecycleState } from "../lifecycle/lifecycle-manager.ts";
import {
  _resetSettledWatchdogsForTest,
  hasSettledWatchdog,
} from "../lifecycle/settled-watchdog.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { AgentResult, ExecutionRecord } from "../assembly/types.ts";

interface ServiceInternals {
  store: RecordStore;
  runOrchestration: {
    settleOneShotOutcome: (record: ExecutionRecord, result: AgentResult, aborted: boolean) => Promise<void>;
    finalizeEngineOutcome: (record: ExecutionRecord, outcome: AgentOutcome) => Promise<boolean>;
  };
}

function makeService(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fake: FakePiEnginePort;
  runOrchestration: ServiceInternals["runOrchestration"];
} {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-lease-"));
  // 引擎数据目录指 tmp（journal 落盘根——runAndFinalize 的 wireEventJournal 消费；
  // 测试红线：不触真实数据目录，workflow-agent-dispatch.test.ts 同款范式）。
  process.env.TAIJI_AGENT_DATA_DIR = path.join(agentDir, "engine-data");
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: emptyRegistry(),
    sessionId: "root-session",
    ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const { store, runOrchestration } = service as unknown as ServiceInternals;
  return { agentDir, service, store, pi, fake, runOrchestration };
}

/** 读 `.alive` marker（断言用——存在性 + pid/id 身份域）。 */
function readAliveMarker(sessionFile: string): { pid: number; id: string; startedAt: number } {
  return JSON.parse(fs.readFileSync(`${sessionFile}.alive`, "utf-8")) as {
    pid: number;
    id: string;
    startedAt: number;
  };
}

let prevDataDirEnv: string | undefined;

beforeEach(() => {
  prevDataDirEnv = process.env["TAIJI_AGENT_DATA_DIR"];
});

afterEach(() => {
  _resetLifecycleState();
  _resetSettledWatchdogsForTest();
  _resetCoreSpawnedChildrenMirrorForTest();
  if (prevDataDirEnv === undefined) delete process.env["TAIJI_AGENT_DATA_DIR"];
  else process.env["TAIJI_AGENT_DATA_DIR"] = prevDataDirEnv;
});

describe("spawn 侧写权声明挂钩（D3a v8 时机①——U2b/C3）", () => {
  it("one-shot pi 轮：run 应答 sessionFile 回填 → `.alive` 存在且 pid=本进程；SP-5 轮终后跨轮保留", async () => {
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "oneshot-session.jsonl");
      const handle = await h.service.execute({ task: "lease probe", slug: "lease" });
      await vi.waitFor(() => expect(h.fake.runs.length).toBe(1));
      h.fake.runs[0]!.settle({ content: "done text", sessionFile });

      const record = h.store.getMutable(handle.subagentId);
      await vi.waitFor(() => expect(record?.status).toBe("idle"));
      // SP-5：成功轮落 idle 可续聊（markRoundIdle 簿记；[two-state-convergence
      // U4/D3] 翻边后 idle 即 resumable）
      expect(record?.closedReason).toBeUndefined();
      expect(record?.result).toBe("done text");
      expect(record?.sessionFile).toBe(sessionFile);
      // [D3a 时机①] 锚点确立即声明写权（kickOffChatRound 回填点）
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: handle.subagentId });
      // [D3a/B5] 轮终跨轮保留——release 出口只有终态原语/idle-GC 归档
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
      // [UF-1] 绑定 sidecar 同步落盘（既有行为不回归）
      expect(fs.existsSync(`${sessionFile}.record-binding`)).toBe(true);
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("[modeless 波1·adopt 链退役] 引擎死亡（run reject）→ Continuation 失败分支收口：record 落 idle 可恢复 + 失败通知，无监督器 adopt 接管", async () => {
    const h = makeService();
    try {
      const adoptSpy = vi.spyOn(
        (h.service as unknown as { roundSupervisor: { adoptOnProcessDeath: (r: unknown, m: string) => void } })
          .roundSupervisor,
        "adoptOnProcessDeath",
      );
      const record = createRecord("bg-engine-death", {
        agent: "general-purpose",
        model: "prov/model-1",
        mode: "background",
        task: "t",
        slug: "engine-death",
        startedAt: 1000,
        rootSessionId: "root-session",
        controller: new AbortController(),
      });
      h.store.register(record);

      // 引擎死亡 = run reject（prepare 期/进程死亡）→ Continuation onRoundRejected →
      // settleRoundFailed（MF-6：idle 可恢复 + 失败通知）——旧 adopt 接管链（error
      // 三写 + 监督器纳管 + merged notice）随 one-shot engine-run 编排消亡。
      await h.service.chatActions.deliverChatMessage(record, "risky round");
      await vi.waitFor(() => expect(h.fake.runs.length).toBe(1));
      h.fake.runs[0]!.fail(Object.assign(new Error("engine process exited unexpectedly: signal SIGKILL"), {
        name: "EngineSdkError",
      }));

      await vi.waitFor(() => {
        expect(record.status).toBe("idle");
        expect(record.lastError).toContain("engine process exited");
      });
      expect(record.round).toBe(1);
      expect(adoptSpy).not.toHaveBeenCalled();
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("workflow 域（executeAndAwait → outcomeToAgentResult 回填点）：sessionFile 回填 → `.alive` 存在且 pid=本进程", async () => {
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "wf-session.jsonl");
      const execP = h.service.executeAndAwait({ task: "wf lease", slug: "wf" });
      await vi.waitFor(() => expect(h.fake.runs.length).toBe(1));
      h.fake.runs[0]!.settle({ content: "wf done", sessionFile });
      const result = await execP;

      // 成功应答映射（workflow 域 AgentResult.content 承载正文）
      expect(result.content).toBe("wf done");
      // [two-state-convergence U4] 轮终翻边 idle——record 经 getMutable 断言
      //（listRunningMutable 是 running 过滤视图，不再含轮终收口 record）。
      const rec = h.store.getMutable(result.sessionId ?? "");
      expect(rec).toBeDefined();
      expect(rec!.sessionFile).toBe(sessionFile);
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: rec!.id });
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("轮终 disarm 根修：one-shot 正常收敛即撤两段 watch（settleOneShotOutcome）", () => {
  it("run 应答收敛后 armed entry 清零——已收敛的槽不再被 watchdog 误 kill + 误报 failed", async () => {
    // 2026-09-14 实测误报链：one-shot settle 后 armed entry 残留 → 窗口到期 fire →
    // onOneShotSettledWatchdogTimeout 的 status!=='running' 守卫放行 → kill +
    // markRoundIdle(failed) + 失败通知（「已交付会话残留槽被看门狗当 no valid
    // protocol event 清理报 failed」×7+）。根修 = settleOneShotOutcome 收敛点补
    // disarmRoundFromProtocol（F-2 注释「轮终两段一并清」的 one-shot 落点）。
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "disarm-session.jsonl");
      const handle = await h.service.execute({ task: "disarm probe", slug: "disarm" });
      await vi.waitFor(() => expect(h.fake.runs.length).toBe(1));
      h.fake.runs[0]!.settle({ content: "done", sessionFile });

      const record = h.store.getMutable(handle.subagentId);
      await vi.waitFor(() => expect(record?.status).toBe("idle"));
      // 收敛即撤窗：mid-round/settled 两段 armed entry 不残留（否收尾段将在窗到期后
      // 对该已收敛槽 fire）
      expect(hasSettledWatchdog(handle.subagentId)).toBe(false);
      // 收敛语义本身不回归：翻边 idle（two-state 收敛）+ 结果已写
      expect(record?.status).toBe("idle");
      expect(record?.result).toBe("done");
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("settleOneShotOutcome SP-5 成功分支 → store.markRoundIdle 接线（U2b/C3）", () => {
  it("markRoundIdle 簿记 + `.alive` 不删（D3a 跨轮保留）+ pending:unregister 发射点② store 簿记⑧单轨发射恰好一次", async () => {
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "sp5-session.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf-8");
      const record = createRecord("bg-sp5", {
        agent: "general-purpose",
        model: "prov/model-1",
        mode: "background",
        task: "t",
        slug: "sp5",
        startedAt: 1000,
        rootSessionId: "root-session",
        controller: new AbortController(),
      });
      record.round = 1;
      record.sessionFile = sessionFile;
      h.store.register(record);
      // 在途轮的写权声明（模拟本轮回填点已 acquire 的形态）
      h.store.acquireWriteLease(sessionFile, record.id);

      await h.runOrchestration.settleOneShotOutcome(
        record,
        { text: "round done", turns: 1, durationMs: 100, success: true, sessionId: record.id, toolCalls: [] },
        false,
      );

      // 簿记①-⑥：翻边 idle（[two-state-convergence U4/D3]）+ result 写入 + round+1
      // + closedReason 清除
      expect(record.status).toBe("idle");
      expect(record.closedReason).toBeUndefined();
      expect(record.round).toBe(2);
      expect(record.result).toBe("round done");
      // 簿记⑦：`.alive` 保留（旧 doFinalizeRoundToIdle 删点随归口移除——B5/D3a）
      expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
      // 簿记⑧单轨：注销发射点②已收口 store 簿记⑧（SubagentService 构造点经
      // setPendingUnregister 注入 notifyHost.emitPendingUnregister），本用例期间
      // pi.events.emit 仅此一笔——调用方直发回归（双轨重复注销）会使计数 >1 而红
      expect(h.pi.events.emit).toHaveBeenCalledTimes(1);
      expect(h.pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
        id: "bg-sp5",
        reason: "running",
      });
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
