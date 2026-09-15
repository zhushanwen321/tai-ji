/**
 * Workflow Extension — Trace 值对象
 *
 * 执行追踪事件流（D-10 单一来源）。纯 append-only + 单字段 update。
 *
 * 设计：
 * - trace 节点存储 + 变更逻辑收敛为值对象（外部不能直接打洞 nodes 数组）。
 * - update 只改单个 node 的 status/result/error/completedAt/sessionId（TracePatch）。
 * - callId 不存在时 update no-op（防御性，避免 race 下抛错）。
 * - 持久化（appendEntry）与事件通知（emit）不在本值对象内——它们由 engine 函数
 * 在调用 update 前后负责（值对象只管数据形状，不管 IO）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §6（字段/不变式）。
 */
import type { AgentResult, ExecutionTraceNode, TracePatch } from "./types.ts";

// ── result.content 裁剪 ────────────────────────────────────────

/**
 * trace 节点 result.content 裁剪上限（严格大于才裁）。
 *
 * export 供测试边界构造（对齐 budget.ts export 常量先例）。
 * 只裁 trace 节点侧——AgentCall.result 不裁（markDone 存全量在前，
 * worker cached replay 数据源保真）。
 */
export const TRACE_RESULT_MAX_CHARS = 8000;

/**
 * 裁剪保留的头/尾长度（各半）。
 *
 * 耦合声明：TRIM_HEAD_CHARS + TRIM_TAIL_CHARS === TRACE_RESULT_MAX_CHARS
 * （各半相等）是 doc 示例「8001 → 裁后 8000+标记 ≈ 8057」的前提
 * （rt-w1-design.json W1C2 / trimTraceResult 注释同款表述）——改 MAX 时
 * 需同步检查 head/tail 是否仍各半，及上述注释/文档示例数字。
 * 比例钉死在 trace.test.ts 断言中；变更需复查 detail-content.ts
 * 尾 5 行消费点（TUI 尾部预览依赖 tail 段）。
 */
const TRIM_HEAD_CHARS = 4000;
const TRIM_TAIL_CHARS = 4000;

/**
 * 裁剪 trace result 的 content（Trace 私有纯函数）。
 *
 * - undefined 透传；未超限原引用透传（零拷贝，不超限路径行为与无裁剪时一致）。
 * - 超限返回新对象：head + 含原始长度的标记 + tail（只裁 content，
 *   result 其他字段浅拷贝保留）。节点持裁剪副本，与传入对象脱钩。
 * - 边界附近（如 8001 字符）裁后总长 8000 + 标记长度 > 原始长度属
 *   既定语义（head/tail 固定比例下净增长有界），禁止自行缩短 head/tail。
 */
function trimTraceResult(result: AgentResult | undefined): AgentResult | undefined {
  if (result === undefined) return result;
  const { content } = result;
  if (content.length <= TRACE_RESULT_MAX_CHARS) return result;
  const trimmed =
    content.slice(0, TRIM_HEAD_CHARS) +
    `\n…[trace result truncated, original ${content.length} chars]…\n` +
    content.slice(-TRIM_TAIL_CHARS);
  return { ...result, content: trimmed };
}

/**
 * Trace 值对象（事件流，唯一来源 D-10）。
 *
 * 不变式：
 * - nodes 只增不改索引顺序（append-only）
 * - update 只改单个 node 的 status/result/error/completedAt/sessionId
 * - byIndex 与 nodes 恒一致（每个 append/remove 同步维护，无惰性重建）；
 *   Map 值与数组元素引用共享（非拷贝），nodes 仍是持久化与 TUI 投影 SSOT
 * - 不含 verifyStrategy（G-020 删除，不迁移）
 */
export class Trace {
  private readonly nodes: ExecutionTraceNode[] = [];
  /** stepIndex 倒排索引（查询加速 O(1)；值与 nodes 元素引用共享）。 */
  private readonly byIndex = new Map<number, ExecutionTraceNode>();

  /**
 * 从已有节点数组重建 Trace（用于 RunStore 反序列化重水合）。
 *
 * 防御性拷贝——传入数组不被持有，外部 mutation 不影响 Trace。
 * 不验证节点顺序/唯一性（调用方保证快照来源可信）。
 * 不做裁剪——落盘快照已是 write 路径裁剪后形态，旧版本未裁剪长
 * content 重水合保持原样（read 路径无二次信息损失）。
 * 重水合后 call.traceNode（来自快照 calls[].traceNode，
 * jsonl-run-store.ts:156 直接传入）与 Trace.nodes 副本非同引用——
 * D-10 引用共享仅 live append 路径成立。
 */
  static fromArray(nodes: readonly ExecutionTraceNode[]): Trace {
    const trace = new Trace();
    for (const node of nodes) {
      const copy = { ...node };
      trace.nodes.push(copy);
      trace.byIndex.set(copy.stepIndex, copy); // 重复 stepIndex last-wins
    }
    return trace;
  }

  /**
 * Append a trace node（append-only，不改已有节点）。
 *
 * 入口裁剪：超长 result.content 先 mutate 入参节点的 result 字段，
 * 再 push 原节点引用（禁止 push 副本——保持 AgentCall.traceNode 与
 * Trace.nodes 共享同一引用的 D-10 不变式）。
 */
  append(node: ExecutionTraceNode): void {
    node.result = trimTraceResult(node.result);
    this.nodes.push(node);
    this.byIndex.set(node.stepIndex, node);
  }

  /**
 * Update a trace node by stepIndex (callId) with a partial patch.
 *
 * 只改 patch 中提供的字段（status/result/error/completedAt/sessionId）。
 * stepIndex 不存在时 no-op（防御性——agent 完成/失败回调可能晚于 run 终止到达）。
 */
  update(stepIndex: number, patch: TracePatch): void {
    const node = this.findByStepIndex(stepIndex);
    if (!node) return; // no-op: 不存在不抛错（D-10 防御性）

    if (patch.status !== undefined) node.status = patch.status;
    // 入口裁剪：节点持裁剪副本，与 patch.result 脱钩为两个对象
    // （call.result 保留全量——replay 数据源保真）。patch.result 未提供不动。
    if (patch.result !== undefined) node.result = trimTraceResult(patch.result);
    if (patch.error !== undefined) node.error = patch.error;
    if (patch.completedAt !== undefined) node.completedAt = patch.completedAt;
    if (patch.sessionId !== undefined) node.sessionId = patch.sessionId;
    if (patch.sessionFile !== undefined) node.sessionFile = patch.sessionFile;
  }

  /**
 * 查找指定 stepIndex 的节点（byIndex O(1)，trace 中 stepIndex 应唯一）。
 *
 * 语义差异声明（旧线性扫 first-match → Map last-wins）：仅在破坏
 * stepIndex 唯一性的违规使用下可见，两组场景——
 * 1. 重复 append 同 stepIndex 且未 remove：返回最后一个节点（last-wins；
 *    旧线性扫 first-match 会返回第一个）。
 * 2. 重复 append 后 removeByStepIndex：remove 的 findIndex 命中首个旧节点
 *    splice，而 byIndex.delete 把整个 stepIndex 键删掉——nodes 残留第二个
 *    节点成为孤儿（find/update 不可达，length/toArray 仍可见）。
 * 合法路径无差异：唯一性由 discard 先 remove 再 append 保证（W1TC12 锚定）。
 */
  private findByStepIndex(stepIndex: number): ExecutionTraceNode | undefined {
    return this.byIndex.get(stepIndex);
  }

  /** 按节点引用删除（仅用于测试或 run 重建场景；正常运行不调用）。 */
  find(stepIndex: number): ExecutionTraceNode | undefined {
    return this.findByStepIndex(stepIndex);
  }

  /**
 * 按 stepIndex 移除节点（崩溃重建清理在飞 call 用）。
 *
 * 正常运行不调用（append-only 不变式）。仅 worker-message-pump 的 discardInFlightCalls
 * （rebuildRuntime 内，F2）清理被旧 runtime abort 的在飞 call 时用——移除其 trace
 * 节点，让重跑重发 agent-call 时 append 全新节点走全新执行路径（避免 stale
 * "running" 节点残留 + trace.update 命中旧节点导致新节点 orphan）。
 * stepIndex 不存在时 no-op（防御性）。
 */
  removeByStepIndex(stepIndex: number): void {
    // 先 findIndex 判存在再删，避免 byIndex 与 nodes 漂移
    const idx = this.nodes.findIndex((n) => n.stepIndex === stepIndex);
    if (idx === -1) return;
    this.nodes.splice(idx, 1);
    this.byIndex.delete(stepIndex);
  }

  /**
 * readonly 视图——返回内部 nodes 数组引用（仅类型级 readonly，运行时无
 * 防御）。消费方禁止结构化 mutate（push/splice/重排/覆盖元素）：byIndex
 * 引入后外部结构化 mutate 会使 nodes 与倒排索引 desync。字段级变更走 update()。
 */
  toArray(): readonly ExecutionTraceNode[] {
    return this.nodes;
  }

  /** 当前节点数。 */
  get length(): number {
    return this.nodes.length;
  }
}
