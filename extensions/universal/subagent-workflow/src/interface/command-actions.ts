/**
 * command-actions — RPC 模式 slash command action 解析纯函数。
 *
 * taiji GUI 通过 `client.prompt("/subagents cancel <id>")` 等触发生命周期操作，
 * 不经 LLM（pi 的 _tryExecuteExtensionCommand 在 agent loop 前短路）。command handler
 * 在 RPC 模式下用这两个函数解析 action 字符串，分发到对应 service/lifecycle 调用。
 *
 * 设计为纯函数（无 ctx / service 依赖），便于独立单测，handler 只做薄分发。
 */

/** /subagents RPC action 判别联合。message/start 为 GUI 定向消息通道（设计 §3.3.3，
 *  仅 RPC 分支消费；missing-args 携带 missing 字段供 handler 输出指明缺什么的 usage）。 */
export type SubagentRpcAction =
  | { action: "cancel"; recordId: string }
  | { action: "cancel-missing-id" }
  | { action: "message"; recordId: string; text: string }
  | { action: "message-missing-args"; missing: "recordId" | "text" }
  | { action: "start"; slug: string; task: string }
  | { action: "start-missing-args"; missing: "slug" | "task" }
  | { action: "noop" };

/** /workflows RPC action 判别联合。 */
export type WorkflowRpcAction =
  | { action: "abort"; runId: string }
  | { action: "lifecycle-missing-id"; verb: "abort" }
  | { action: "lifecycle-removed"; verb: "pause" | "resume" }
  | { action: "noop" };

/**
 * 已移除的 lifecycle verb 集合（pause/resume——run 一次性生命周期化后删除，
 * 解析为 lifecycle-removed 提示，而非 unknown noop）。
 */
const REMOVED_LIFECYCLE_VERBS: ReadonlySet<"pause" | "resume"> = new Set([
  "pause",
  "resume",
]);

/** verb 是否为已移除的 lifecycle action（类型守卫，收窄到 "pause" | "resume"）。 */
function isRemovedLifecycleVerb(verb: string): verb is "pause" | "resume" {
  return REMOVED_LIFECYCLE_VERBS.has(verb as "pause" | "resume");
}

/**
 * 还原转义协议（设计 §3.3.3 / 探针 P3）：字面 `\n`（反斜杠 + n 两字符）→ 真实换行、
 * 字面 `\\`（两反斜杠）→ 单反斜杠。
 *
 * 与 runtime encodeDirectiveText（session-service.ts）互逆：composer 多行输入在
 * client.prompt 传输前把真实换行编码为字面 \n、原生反斜杠编码为 \\（命令保持单行），
 * extension 解析侧在此还原。反斜杠转义必须与换行转义在**单次遍历**里成对处理
 * （交替分支 `\\\\|\\n`，两反斜杠优先匹配）——若只处理 \n，原文里的字面反斜杠+n
 * （如路径 `C:\new`）会被误解码为换行，往返歧义。
 */
function decodeNewlineEscapes(s: string): string {
  return s.replace(/\\\\|\\n/g, (m) => (m === "\\\\" ? "\\" : "\n"));
}

/**
 * 提取首个非空白 token 与其后剩余原文。
 *
 * 与 split(/\s+/) 不同：rest 保留 token 之后的全部原文（含空格/引号/换行转义），
 * 供 message text / start task 的「剩余全量到字符串末尾」语义使用（设计 §3.3.3——
 * pi 以首个空格拆命令名后 args 为其后全文，文本内的空格/引号必须原样保留）。
 * rest 跳过 token 后的分隔空白（分隔符不属文本），但保留其后全部内容原样。
 */
function splitFirstToken(s: string): { token: string; rest: string } | null {
  const head = s.trimStart();
  if (!head) return null;
  const idx = head.search(/\s/);
  if (idx === -1) return { token: head, rest: "" };
  return { token: head.slice(0, idx), rest: head.slice(idx + 1).trimStart() };
}

/**
 * 解析 /subagents RPC 命令字符串。
 *
 * 支持格式：
 * - `cancel <id>` → { action: "cancel", recordId }
 * - `cancel`（无 id）→ { action: "cancel-missing-id" }
 * - `message <recordId> <text...>` → { action: "message", recordId, text }
 *   text 为第二 token 后的剩余全量（含空格/引号原样；字面 \n 还原为换行、字面 \\ 还原为
 *   反斜杠——composer 定向消息经此协议编码，与 runtime encodeDirectiveText 互逆，设计 §3.3.3）
 * - `message`（缺 recordId 或 text 为空白）→ { action: "message-missing-args", missing }
 * - `start <slug> <task...>` → { action: "start", slug, task }（task 同 text 转义协议）
 * - `start`（缺 slug 或 task 为空白）→ { action: "start-missing-args", missing }
 * - 其他（空 / 未知 action / 无参）→ { action: "noop" }
 *
 * missing-args 携带 missing 字段（缺哪个参数），handler 据此输出可操作的 usage
 * 错误（全局规则：错误信息指向恢复动作）。noop 表示 GUI 端无对应程序化操作（GUI
 * 已在 CommandPopover 屏蔽 /subagents 入口，此分支仅兜底手动 prompt）。
 */
export function parseSubagentRpcCommand(argsStr: string): SubagentRpcAction {
  const first = splitFirstToken(argsStr);
  if (!first) return { action: "noop" };

  const { token: verb, rest } = first;
  if (verb === "cancel") {
    const idToken = splitFirstToken(rest);
    if (!idToken) return { action: "cancel-missing-id" };
    return { action: "cancel", recordId: idToken.token };
  }
  if (verb === "message" || verb === "start") {
    // message 与 start 共用解析骨架，仅结果字段名不同（recordId/text vs slug/task）
    const isMessage = verb === "message";
    // 第二 token：message→recordId / start→slug；其后剩余全量（还原换行转义）为 text/task
    const second = splitFirstToken(rest);
    if (!second) {
      return isMessage
        ? { action: "message-missing-args", missing: "recordId" }
        : { action: "start-missing-args", missing: "slug" };
    }
    // 先还原再判空：纯字面 \n 还原后是真实换行（whitespace），应在解析层拦截为缺参
    const payload = decodeNewlineEscapes(second.rest);
    if (!payload.trim()) {
      return isMessage
        ? { action: "message-missing-args", missing: "text" }
        : { action: "start-missing-args", missing: "task" };
    }
    return isMessage
      ? { action: "message", recordId: second.token, text: payload }
      : { action: "start", slug: second.token, task: payload };
  }
  return { action: "noop" };
}

/**
 * 解析 /workflows RPC 命令字符串。
 *
 * 支持格式：
 * - `abort <runId>` → { action: "abort", runId }
 * - `abort`（无 runId）→ { action: "lifecycle-missing-id", verb: "abort" }
 * - `pause|resume ...`（已移除的 lifecycle verb，带或不带 runId 均同）→
 *   { action: "lifecycle-removed", verb }——removed verb 优先于 missing-id 判定
 *  （提示语义优先：用户应得知能力已删除并获 abort 指引，而非被引导补 runId）
 * - 其他（空 / 未知 action / 无参）→ { action: "noop" }
 */
export function parseWorkflowRpcCommand(argsStr: string): WorkflowRpcAction {
  const args = argsStr.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { action: "noop" };

  const [verb, runId] = args;
  if (isRemovedLifecycleVerb(verb)) {
    return { action: "lifecycle-removed", verb };
  }
  // abort 是 lifecycle verb 单成员（pause/resume 已移除，见上），直判即可，无需集合机件
  if (verb === "abort") {
    if (!runId) return { action: "lifecycle-missing-id", verb: "abort" };
    return { action: "abort", runId };
  }
  return { action: "noop" };
}
