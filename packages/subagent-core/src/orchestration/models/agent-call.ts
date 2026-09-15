/**
 * Workflow Extension — AgentCall 实体
 *
 * 单次 agent 调用的数据 + 不变式守卫（D-12）。纯数据，无 execute 上帝方法——
 * 执行编排（重试+预算+stale 检测）在 execute-agent-call.ts 的 free function。
 *
 * - 状态机：pending → running → done（不可逆）
 * - markRunning 进入 running 并 attempts++（每次 retry 前调用）
 * - markDone(result) 进入 done 并记录结果
 * - traceNode 持有引用，但 AgentCall 不直接改其字段——trace 同步由
 * Trace.update 负责（D-10 单一来源），AgentCall 只持有引用供 executeAgentCall 读取
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §5（字段/不变式/设计决策）。
 */
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./types.ts";

/** AgentCall 生命周期状态。pending→running→done，不可逆。 */
export type AgentCallStatus = "pending" | "running" | "done";

/**
 * AgentCall 实体（在 RunState.calls Map 内）。
 *
 * 不变式：
 * - status 转换严格 pending→running→done，反向抛错
 * - done 时 result 必须已设置（markDone(result) 前置保证）
 * - attempts 反映 dispatch 次数（markRunning 累加，含首次）
 * - **无 execute 方法**（D-12：执行编排由 Engine executeAgentCall 函数承担）
 */
export class AgentCall {
  readonly id: number;
  readonly opts: AgentCallOpts;
  status: AgentCallStatus = "pending";
  attempts = 0;
  result?: AgentResult;
  /** Pi subprocess session ID（uuidv7，G-017 归此）。 */
  sessionId?: string;
  /** Session JSONL 绝对路径（finalizeCall 后从 result.sessionFile 填入，对齐 sessionId 模式）。 */
  sessionFile?: string;
  /** 与 Trace 共享的节点引用（D-10 单源）。AgentCall 不直接改其字段。 */
  readonly traceNode: ExecutionTraceNode;

  constructor(id: number, opts: AgentCallOpts, traceNode: ExecutionTraceNode) {
    this.id = id;
    this.opts = opts;
    this.traceNode = traceNode;
  }

  /**
 * 标记进入 running 状态（dispatch 前）。attempts++（含首次）。
 * @throws 若已 done（不可重启）
 */
  markRunning(): void {
    if (this.status === "done") {
      throw new Error(`AgentCall ${this.id} already done — cannot mark running`);
    }
    this.status = "running";
    this.attempts += 1;
  }

  /**
 * 标记完成（成功或失败均调用——result.error 区分）。
 * @throws 若当前非 running（pending 不能直接跳 done，必须先 markRunning）
 */
  markDone(result: AgentResult): void {
    if (this.status !== "running") {
      throw new Error(`AgentCall ${this.id} must be running to mark done (was ${this.status})`);
    }
    this.result = result;
    this.status = "done";
  }

  /** 记录 pi subprocess session ID（dispatch 成功后）。 */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** 记录 session JSONL 绝对路径（finalizeCall 后，对齐 setSessionId 模式）。 */
  setSessionFile(sessionFile: string): void {
    this.sessionFile = sessionFile;
  }
}
