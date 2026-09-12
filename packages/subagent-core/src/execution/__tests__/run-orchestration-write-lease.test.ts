// src/execution/__tests__/run-orchestration-write-lease.test.ts
//
// [U2b / C3] spawn 侧写权声明挂钩（D3a v8 时机①——fresh spawn 全程声明，缺口 1
// 闭合）+ one-shot 成功分支 markRoundIdle 接线（SP-5 与 chat 轮末共享轮终语义）的
// 单元级断言：
//   1. one-shot pi 轮（kickOffChatRound 回填点）：run 应答 sessionFile 回填后
//      `.alive` 存在且 pid=本进程；轮终（settleOneShotOutcome SP-5 → markRoundIdle）
//      后 marker 跨轮保留（D3a/B5）；
//   2. 非 pi 引擎死亡 adopt 形态（finalizeEngineOutcome 回填点）：sessionFile 回填
//      即声明写权，record 保持 resumable、marker 在（adopt 不终态化 → 声明不释放）；
//   3. settleOneShotOutcome 直驱：markRoundIdle 簿记（running-resumable / round+1 /
//      result / closedReason 清除）+ `.alive` 不删 + pending:unregister 发射点②
//      store 簿记⑧单轨发射（恰好一次）；
//   4. workflow 域（executeAndAwait → runAndFinalize → outcomeToAgentResult 主回填
//      点）：sessionFile 回填后 `.alive` 存在且 pid=本进程；
//   5. [U2b 修复轮/D2] adoptEngineDeath 归口（adoptResumableAfterEngineDeath 三写
//      error/result/resumable 语义等价，真实 store 链）。轮始 markRoundStarted 接线
//      的真实链用例在 conversation-continuation.test.ts 集成面（续聊派发即清
//      result/resumable + round 累加链不断）。
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
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import { _resetSettledWatchdogsForTest } from "../settled-watchdog.ts";
import { _resetCoreSpawnedChildrenMirrorForTest } from "../engine/host/spawned-children.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

interface ServiceInternals {
  store: RecordStore;
  runOrchestration: {
    settleOneShotOutcome: (record: ExecutionRecord, result: AgentResult, aborted: boolean) => Promise<void>;
    finalizeEngineOutcome: (record: ExecutionRecord, outcome: AgentOutcome) => Promise<boolean>;
  };
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

function makeService(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: PiLike & { events: { emit: ReturnType<typeof vi.fn> } };
  fake: FakePiEnginePort;
  runOrchestration: ServiceInternals["runOrchestration"];
} {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-lease-"));
  // 引擎数据目录指 tmp（journal 落盘根——runAndFinalize 的 wireEventJournal 消费；
  // 测试红线：不触真实数据目录，workflow-agent-dispatch.test.ts 同款范式）。
  process.env.XYZ_AGENT_DATA_DIR = path.join(agentDir, "engine-data");
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true },
    sessionId: "root-session",
    ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi() as PiLike & { events: { emit: ReturnType<typeof vi.fn> } };
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
  prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
});

afterEach(() => {
  _resetLifecycleState();
  _resetSettledWatchdogsForTest();
  _resetCoreSpawnedChildrenMirrorForTest();
  if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
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
      await vi.waitFor(() => expect(record?.resumable).toBe(true));
      // SP-5：成功轮保持 running-resumable（markRoundIdle 簿记）
      expect(record?.status).toBe("running");
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

  it("非 pi 引擎死亡 adopt 形态（finalizeEngineOutcome 回填点）：sessionFile 回填即声明写权，record 保持 resumable 且 marker 在", async () => {
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "adopt-session.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf-8");
      const record = createRecord("bg-adopt", {
        agent: "general-purpose",
        model: "prov/model-1",
        mode: "background",
        task: "t",
        slug: "adopt",
        startedAt: 1000,
        rootSessionId: "root-session",
        controller: new AbortController(),
      });
      h.store.register(record);

      const adopted = await h.runOrchestration.finalizeEngineOutcome(record, {
        content: "",
        engineId: "zcode",
        error: "engine crashed: process killed by signal",
        exitCode: null,
        sessionFile,
      });

      // adopt 分支：record 保持 resumable 交监督器（不终态化 → 写权声明不释放）
      expect(adopted).toBe(true);
      expect(record.error).toContain("engine crashed");
      expect(record.sessionFile).toBe(sessionFile);
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: "bg-adopt" });
    } finally {
      h.service.dispose();
      clearEngines();
      fs.rmSync(h.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("[U2b 修复轮/D2] adoptEngineDeath 归口：error/result/resumable 三写语义等价（真实 store 链）", async () => {
    const h = makeService();
    try {
      const sessionFile = path.join(h.agentDir, "adopt-writes.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf-8");
      const record = createRecord("bg-adopt-writes", {
        agent: "general-purpose",
        model: "prov/model-1",
        mode: "background",
        task: "t",
        slug: "adopt",
        startedAt: 1000,
        rootSessionId: "root-session",
        controller: new AbortController(),
      });
      // 收养前形态：上一轮 result 在盘 + 无 resumable 信号（被收养对象的典型前置）
      record.result = "previous round output";
      record.resumable = undefined;
      h.store.register(record);

      const adopted = await h.runOrchestration.finalizeEngineOutcome(record, {
        content: "",
        engineId: "zcode",
        error: "engine crashed: SIGKILL",
        exitCode: null,
        sessionFile,
      });

      expect(adopted).toBe(true);
      // 三写等价（store.adoptEngineDeath）：error 如实 + result 清（禁旧正文冒充
      // 收养后产出）+ resumable=true（GUI waiting 判据）
      expect(record.error).toBe("engine crashed: SIGKILL");
      expect(record.result).toBeUndefined();
      expect(record.resumable).toBe(true);
      // 归口不改变 adopt 分支的产品语义：保持 running（不终态化、交监督器）
      expect(record.status).toBe("running");
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
      const actives = h.store.listAllActive();
      expect(actives).toHaveLength(1);
      const rec = actives[0]!;
      expect(rec.sessionFile).toBe(sessionFile);
      expect(readAliveMarker(sessionFile)).toMatchObject({ pid: process.pid, id: rec.id });
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

      // 簿记①-⑥：保持 running + result 写入 + round+1 + closedReason 清除 + resumable
      expect(record.status).toBe("running");
      expect(record.resumable).toBe(true);
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
