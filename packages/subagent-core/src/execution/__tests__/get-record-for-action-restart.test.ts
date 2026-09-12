// src/execution/__tests__/get-record-for-action-restart.test.ts
//
// [M10] getRecordForAction 跨重启磁盘重建分支测试（cold-lookup.coldLookupForAction）。
//
// 背景：内存 miss → collectRecords(1000,"all",undefined).find(status==="running") →
// createRecord({chatMode: 持久化值}) → register → 回填 sessionFile/round。
// [H1 U6] 原「无条件 chatMode: true」（v4 A-3）已改水合保留持久化 chatMode
//（D4/D5：升级置位迁 Continuation revive 格 + messageHandler gate 双写点）。
// 该分支含多个仅此处独有的决策：
//   - chatMode 水合保留（磁盘无持久化 → false；升级在 message 链 gate 化）
//   - rootSessionFilter 传 undefined 后置校验（异树仍 throw not owned）
//   - sessionFile/round 从磁盘重建结果回填（round 无磁盘持久化 → undefined）
//
// fixture 构造参照 record-store.test.ts 的 writeSessionJsonl（真实 .jsonl 文件，
// identity custom entry + assistant message；无 .alive sidecar → record-store
// sidecar 矩阵分支 4 → status="running" 跨重启可续聊态）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// [W3 改写 → H1 U6] deliverChatMessage 走协议 seam（registerFakePiEngine 替身）——
// 每轮 = 新 run + resume 锚点，续聊守卫链归 Continuation（dispatchRoundGuarded）。

import { writeFinalizedState } from "../state-marker.ts";
import { registerFakePiEngine } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";
import { ModelConfigService } from "../model-config-service.ts";
import { getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";

// 身份 env 名（与 subagent-service.ts 常量一致；beforeEach/afterEach 清理防泄漏——
// 测试进程可能继承 subagent env，会污染 rootCwd 编码目录与 sessionRootId 基线）。
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

/** initSession 注入的最小 pi duck-type（同 subagent-service PiLike 形状，结构匹配即可）。 */
interface PiStub {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

function makePi(): PiStub {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写一个最小合法 session.jsonl（session header + identity entry + 1 条 assistant message）。
 *  不写任何 sidecar（.alive/.cancelled/.finalized）→ sidecar 矩阵分支 4 → running。 */
function writeSessionJsonl(
  sessionsDir: string,
  identity: {
    id: string;
    rootSessionId: string;
    parentRecordId?: string;
    depth?: number;
    chatMode?: boolean;
    worktree?: boolean;
  },
): string {
  const file = path.join(sessionsDir, `${identity.id}.jsonl`);
  const startedAt = 1_700_000_000_000;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: new Date(startedAt).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "custom",
      id: "id-1",
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: "subagent-identity",
      data: {
        id: identity.id,
        agent: "general-purpose",
        mode: "background",
        task: "restart recovery task",
        slug: "restart-test",
        startedAt,
        rootSessionId: identity.rootSessionId,
        ...(identity.parentRecordId !== undefined ? { parentRecordId: identity.parentRecordId } : {}),
        ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
        ...(identity.chatMode !== undefined ? { chatMode: identity.chatMode } : {}),
        ...(identity.worktree !== undefined ? { worktree: identity.worktree } : {}),
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first round done" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

/** 暴露私有 store 供断言 register 副作用。 */
interface ServiceInternals {
  store: RecordStore;
}

describe("[M10] getRecordForAction 跨重启磁盘重建（S3 回归场景）", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-recon-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    // 根进程身份：无 env → sessionRootId = sessionId（自己是 root）、execCtxBaseline = null
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    // maxRetries：collectRecords 触发的 fire-and-forget sessions-index 写可能与删除
    // 并发（ENOTEMPTY 竞态，全量并行跑时机器负载高会放大窗口）
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  it("内存 miss + 磁盘 running（无 .alive）→ 重建 record：chatMode 水合保留（无持久化为 false，[H1 U6]）、sessionFile 回填、register 进内存", () => {
    // identity entry 故意不带 chatMode 字段——证明重建分支只水合持久化 chatMode
    //（[H1 U6] 无条件置位已迁 Continuation revive 格 + gate；one-shot 跨重启重建
    // false 后经 message 链 gate 升级置位）
    const file = writeSessionJsonl(sessionsDir, { id: "sa-restart-1", rootSessionId: "root-session" });
    expect(store.getMutable("sa-restart-1")).toBeUndefined(); // 前置：内存确无

    const record = service.chatActions.getRecordForAction("sa-restart-1");

    // [v4 A-3 → H1 U6] 水合保留：磁盘无 chatMode → false（升级在 message 链 gate 化）
    expect(record.chatMode).toBe(false);
    // sessionFile 从磁盘重建结果回填
    expect(record.sessionFile).toBe(file);
    // round 从 found 回填：light 磁盘重建无 round（内存态字段，跨重启不恢复）→ undefined
    expect(record.round).toBeUndefined();
    // 身份字段从磁盘 identity entry 回填
    expect(record.agent).toBe("general-purpose");
    expect(record.task).toBe("restart recovery task");
    expect(record.slug).toBe("restart-test");
    expect(record.rootSessionId).toBe("root-session");
    expect(record.parentRecordId).toBeUndefined();
    expect(record.status).toBe("running");
    // register 生效：进内存，二次调用走内存命中（同一引用）
    expect(store.getMutable("sa-restart-1")).toBe(record);
    expect(service.chatActions.getRecordForAction("sa-restart-1")).toBe(record);
  });

  it("rootSessionId 校验仍生效：异树 record（other-session）→ throw not found or not owned", () => {
    // rootSessionFilter 传 undefined（扫全量磁盘），异树 record 会被 find 命中并重建，
    // 但后置校验 record.rootSessionId !== this.sessionRootId 必须拦截
    writeSessionJsonl(sessionsDir, { id: "sa-foreign", rootSessionId: "other-session" });

    expect(() => service.chatActions.getRecordForAction("sa-foreign")).toThrow(/not found or not owned/);
  });

  it("直接父校验仍生效：孙级 record（parentRecordId=sa-parent）→ 主进程 throw direct parent", () => {
    writeSessionJsonl(sessionsDir, {
      id: "sa-grand",
      rootSessionId: "root-session",
      parentRecordId: "sa-parent",
      depth: 2,
    });

    // 重建后 parentRecordId=sa-parent ≠ 主进程 baseline(undefined) → cross-layer 守卫拦截
    expect(() => service.chatActions.getRecordForAction("sa-grand")).toThrow(/direct parent/);
  });

  it(".state sidecar（closed 终态）不重建 → throw not found or not owned", () => {
    const file = writeSessionJsonl(sessionsDir, { id: "sa-fin", rootSessionId: "root-session" });
    writeFinalizedState(file); // sidecar 矩阵分支 2 → status=closed → find(status==="running") miss

    expect(() => service.chatActions.getRecordForAction("sa-fin")).toThrow(/not found or not owned/);
    expect(store.getMutable("sa-fin")).toBeUndefined(); // 未重建注册
  });

  // ============================================================
  // [review round2] 跨重启 worktree 绑定丢失防护
  // ============================================================
  // 场景：worktree:true + conversation:true 的 subagent 在父进程重启后续聊。WorktreeHandle
  // 不可序列化、重建后恒缺失，若无守卫 → 冷路径 resume 的 spawn cwd 静默回落主 repo
  //（隔离失效，正是 worktree 要防的并发写冲突场景）。
  it("[review round2] worktree record 跨重启重建 → hadWorktree 标记 + 续聊被拒（行动语言）", async () => {
    clearEngines();
    const fake = registerFakePiEngine();
    // [H1 U6] 每轮 = 新 run + resume 锚点（旧 interact 冷路径替身注入随 interact 面退役），
    // 续聊守卫链归 Continuation（dispatchRoundGuarded）。
    writeSessionJsonl(sessionsDir, {
      id: "sa-wt",
      rootSessionId: "root-session",
      worktree: true,
    });

    const record = service.chatActions.getRecordForAction("sa-wt");
    // hadWorktree 从磁盘 identity entry 的 worktree 标志恢复
    expect(record.hadWorktree).toBe(true);
    // handle 无法恢复（不可序列化）
    expect(record.worktreeHandle).toBeUndefined();

    // 冷路径续聊（无活进程）→ 续轮守卫拒绝，不 spawn 回落主 repo
    await expect(service.chatActions.deliverChatMessage(record, "resume after restart")).rejects.toThrow(
      /worktree isolation.*lost when the parent process restarted/,
    );
  });

  it("[review round2] 非 worktree record 跨重启重建 → 续聊不受 worktree 守卫拦截（向后兼容）", async () => {
    clearEngines();
    const fake = registerFakePiEngine();
    // identity entry 无 worktree 字段（旧文件）→ found.worktree undefined → hadWorktree false
    writeSessionJsonl(sessionsDir, { id: "sa-nowt", rootSessionId: "root-session" });

    const record = service.chatActions.getRecordForAction("sa-nowt");
    expect(record.hadWorktree).toBe(false);

    // 冷路径续聊不被 worktree 守卫拦截（resume 正常发起；后续 spawn 编排
    // 超出本用例关注点——runSpawn 在本文件是 no-op mock）
    await expect(service.chatActions.deliverChatMessage(record, "resume normal")).resolves.toBeUndefined();
  });
});
