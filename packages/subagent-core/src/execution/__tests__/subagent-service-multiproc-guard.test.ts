// src/execution/__tests__/subagent-service-multiproc-guard.test.ts
//
// [u-svc / T5] 多进程共享文件守卫（subagent-service 侧两项）：
//   - T5①/PS-8：子进程 initSession 跳过 recoverOrphanRecords（env PI_SUBAGENT_SELF_RECORD_ID
//     判子进程身份）——恢复机制假设「单扫描者」，env 贯穿让每个子进程都成了扫描者，
//     兄弟记录 marker 缺失/超软超时被无关进程盖终态 sidecar；
//   - T5③/PS-7b：running 候选冷查补 findForeignLiveInstance 探针守卫——异进程活实例在册
//     时拒绝 resurrect + resume spawn（防双写者窗口）。
//
// mock 形态沿用 subagent-service-message-close.test.ts；alive-store mock（findForeignLiveInstance
// 换 spy 控制探针命中）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { foreignLiveSpy } = vi.hoisted(() => ({
  foreignLiveSpy: vi.fn<() => { pid: number; id: string; startedAt: number } | undefined>(),
}));
vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
  removeAliveMarker: vi.fn(),
  readAliveMarker: vi.fn(() => undefined),
  isProcessAlive: vi.fn(() => false),
  findForeignLiveInstance: foreignLiveSpy,
}));

import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import { ResurrectDeniedError } from "../types.ts";
import type { PiLike } from "../subagent-service.ts";

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "svc-multiproc-"));
}

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

function setup(): { agentDir: string; service: SubagentService; store: RecordStore } {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi: makePi(), sessionId: "root-session" });
  const store = (service as unknown as { store: RecordStore }).store;
  return { agentDir, service, store };
}

describe("T5① child process skips orphan recovery scan", () => {
  let agentDir: string;

  /** 构造 service 并在其 store 上挂 spy 后再 initSession（spy 必须先于触发点）。 */
  const makeServiceWithRecoverySpies = (): {
    service: SubagentService;
    recover: ReturnType<typeof vi.spyOn>;
    entryOnly: ReturnType<typeof vi.spyOn>;
  } => {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const svc = new SubagentService({ cwd: agentDir, modelService });
    const store = (svc as unknown as { store: RecordStore }).store;
    const recover = vi.spyOn(store, "recoverOrphanRecords").mockImplementation(() => {});
    const entryOnly = vi.spyOn(store, "recoverEntryOnlyOrphans").mockImplementation(() => {});
    return { service: svc, recover, entryOnly };
  };

  beforeEach(() => {
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "");
    agentDir = makeTmpAgentDir();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("root process (no self-record env) runs the orphan recovery scan", () => {
    const { service: root, recover, entryOnly } = makeServiceWithRecoverySpies();
    root.initSession({ pi: makePi(), sessionId: "root-session-2" });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(entryOnly).toHaveBeenCalledTimes(1);
  });

  it("child process (PI_SUBAGENT_SELF_RECORD_ID set) skips the scan entirely", () => {
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "sa-child-self");
    const { service: child, recover, entryOnly } = makeServiceWithRecoverySpies();
    child.initSession({ pi: makePi(), sessionId: "child-session" });
    expect(recover).not.toHaveBeenCalled();
    expect(entryOnly).not.toHaveBeenCalled();
  });
});

describe("T5③ cold-lookup running candidate foreign-instance guard", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    // 身份 env 剥离：initSession 会把 PI_SUBAGENT_ROOT_SESSION_ID 读作 sessionRootId 基线
    //（env 优先于入参 sessionId）——宿主进程（xyz-agent 子 agent 环境）泄漏的身份 env
    // 会让「root-session」桩记录归属校验恒不匹配 → 冷查用例误红（与 collect-coordinator-
    // service.test.ts 同款剥离纪律）。
    for (const k of [
      "PI_SUBAGENT_ROOT_SESSION_ID",
      "PI_SUBAGENT_SELF_RECORD_ID",
      "PI_SUBAGENT_DEPTH",
      "PI_SUBAGENT_ROOT_CWD",
      "PI_SUBAGENT_FORK_DEPTH",
    ] as const) {
      delete process.env[k];
    }
    foreignLiveSpy.mockReset();
    foreignLiveSpy.mockReturnValue(undefined);
    ({ agentDir, service, store } = setup());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const stubColdCandidate = (record: {
    id: string;
    status: "running";
    sessionFile: string;
    rootSessionId: string;
    parentRecordId?: string;
  }): void => {
    vi.spyOn(store, "findLightById").mockReturnValue(undefined);
    vi.spyOn(store, "collectRecords").mockReturnValue([record] as never);
  };

  it("denies resurrection with ResurrectDeniedError when a foreign live instance holds the session", () => {
    stubColdCandidate({
      id: "sa-foreign",
      status: "running",
      sessionFile: "/tmp/fake-session.jsonl",
      rootSessionId: "root-session",
    });
    foreignLiveSpy.mockReturnValue({ pid: 4242, id: "sa-foreign", startedAt: Date.now() });

    expect(() => service["getRecordForAction"]("sa-foreign")).toThrow(ResurrectDeniedError);
    try {
      service["getRecordForAction"]("sa-foreign");
    } catch (err) {
      expect((err as Error).message).toContain("4242");
      expect((err as Error).message).toContain("double-write");
      expect((err as Error).message).toContain("Recovery");
    }
    expect(foreignLiveSpy).toHaveBeenCalledWith("/tmp/fake-session.jsonl");
  });

  it("allows cold lookup when no foreign live instance (marker dead/stale)", () => {
    stubColdCandidate({
      id: "sa-cold",
      status: "running",
      sessionFile: "/tmp/fake-session-2.jsonl",
      rootSessionId: "root-session",
    });
    const found = service["getRecordForAction"]("sa-cold");
    expect(found.id).toBe("sa-cold");
  });
});
