// src/execution/__tests__/helpers/fake-engine-port.ts
//
// [W3 chat 域收口 → H1 U6 定形] SubagentService 编排层测试共享的 pi EnginePort 替身。
//
// 背景：会话形态轮经协议客户端（registry 'pi' 的 cli 形态 port——RemoteEngine）发往
// pi-subagent-cli 引擎进程；原 inproc 链路的测试替身随删件消亡。本 helper 是协议 seam
// 的替身单源：测试经 registerEngine("pi", fake) 注入，拿到 fake 实例后驱动 run，
// 断言协议交互。
//
// 消费方式（与 spawn-mock.ts 同款先例）：
//   const fake = registerFakePiEngine();
//   await service.execute({ task: "...", conversation: true });
//   fake.runs[0].settle({ content: "round text" });   // 模拟 agent_settled 应答
//
// 形态对照（[H1] chat-run 统一终态）：每轮 = 新 run + resume 锚点（ctx.resume），
// run 应答时点 = agent_settled（outcome = 本轮内容非会话终态）；[H1 U6] interact 面
// 与 recordId 键路由模拟面已随 chat 域退役删除。

import type { EnginePort, EngineRunResult, RunContext } from "../../../execution/engine/port.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import type {
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
  SessionView,
} from "../../../execution/engine/types.ts";
import { registerEngine } from "../../../execution/engine/registry.ts";

/** 一次 run 调用的捕获（task + ctx + 结算控制面）。 */
export class FakeRun {
  readonly task: AgentCallOpts;
  readonly ctx: RunContext;
  private resolve!: (r: EngineRunResult) => void;
  private reject!: (err: unknown) => void;
  readonly promise: Promise<EngineRunResult>;

  constructor(task: AgentCallOpts, ctx: RunContext) {
    this.task = task;
    this.ctx = ctx;
    this.promise = new Promise<EngineRunResult>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  /** 模拟 run 正常应答（agent_settled 口径；outcome 缺省 = 成功空轮）。 */
  settle(outcome: Partial<AgentOutcome> = {}): void {
    this.resolve({
      handle: {
        data: {
          v: 1,
          engineId: "pi",
          sessionRef: { recordId: this.ctx.taskId },
          poolKey: "shared",
          adapterVersion: "fake-engine-port",
        },
      },
      outcome: {
        content: "",
        engineId: "pi",
        ...outcome,
      },
    });
  }

  /** 模拟 run 期失败（prepare 期 reject / 引擎进程死亡）。 */
  fail(err: unknown): void {
    this.reject(err);
  }

  /** 模拟引擎反向事件通知（协议 event 通知形态）。 */
  emitEvent(event: unknown): void {
    this.ctx.onEvent?.(event as never);
  }

  /** 模拟 host/streamDelta（runId 键——run 作用域路由）。 */
  emitDelta(delta: string): void {
    this.ctx.stream?.onDelta(delta);
  }

  /** 模拟 host/handleReady（运行中句柄回填）。 */
  emitHandleReady(sessionRef: Record<string, string>, poolKey = "shared"): void {
    this.ctx.onHandleReady?.({ sessionRef, poolKey });
  }
}

export class FakePiEnginePort implements EnginePort {
  readonly id = "pi";

  /** run 调用捕获（按序）。 */
  readonly runs: FakeRun[] = [];

  capabilities(): EngineCapabilities {
    // 与 pi-subagent-cli manifest 逐位一致（gate 同步面放行 pi 全参数——V4⑤ 反向守护）。
    return {
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "native",
      personaInjection: "flag",
      eventGranularity: "stream",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "native",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: true,
    };
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true, detail: "fake" }] };
  }

  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    const captured = new FakeRun(task, ctx);
    this.runs.push(captured);
    return captured.promise;
  }

  async read(handle: EngineHandle): Promise<SessionView> {
    void handle;
    return { engineId: "pi", turns: [], source: "outcome-only" };
  }
}

/** 注册替身 pi 引擎进 registry（覆盖同 id 既有注册——测试隔离自负责清理）。 */
export function registerFakePiEngine(): FakePiEnginePort {
  const fake = new FakePiEnginePort();
  registerEngine("pi", () => fake);
  return fake;
}
