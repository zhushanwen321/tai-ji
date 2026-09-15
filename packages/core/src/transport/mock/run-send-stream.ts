/**
 * mock 流式回复序列 —— 从 mock/index.ts 抽出（行为零改变；deps 由 index.ts 注入）。
 * 生命周期：message_start → [auto_retry] → thinking → tool_call → widget/status → text → complete，
 * 全程检查 cancelled。extension:widget/status 走 session 通道，与 streamSubscribe 独立。
 * tool_call + widget 分支序列拆在 run-send-stream-branches.ts（同本文件从 index.ts 抽出先例）；
 * 下方各生命周期阶段块同理拆为模块内 helper（取消检查点位 / sleep / emit 调用序列逐条保持）。
 */
import type { ServerMessageUnion } from "@taiji/shared";
import {
  detectBranch,
  emitReadBranch,
  emitTodoBranch,
  emitGoalBranch,
} from "./run-send-stream-branches";

/** 流式时序（ms）—— 仅用于视觉演示节奏，不影响契约。index.ts 的 TIMING 实现此接口；
 *  bashDelay 由 index.ts 的 bash 分流消费（同族 mock 节奏，统一进时序表便于 setMockTiming 注入） */
export interface Timing {
  ack: number;
  startGap: number;
  chunk: number;
  done: number;
  switchCmd: number;
  thinkingGap: number;
  toolGap: number;
  fileChangesGap: number;
  retryGap: number;
  steerDrain: number;
  /** bashStart→bashResult 间隔（loading 态可见）；timeout 分支在此之上 +1s 强调到期节奏 */
  bashDelay: number;
}

/** index.ts 注入的模块私有依赖（行为与抽离前完全一致） */
export interface SendStreamDeps {
  nextId(prefix: string): string;
  /** ServerMessageUnion（非宽 ServerMessage）：mock 帧构造点（本文件 + branches）受
   *  type↔payload 配对编译校验，缺字段即编译错（对齐 mock/index.ts 的 emit/pushSession） */
  emit(sessionId: string, msg: ServerMessageUnion): void;
  sleep(ms: number): Promise<void>;
  pushSession(sessionId: string, msg: ServerMessageUnion): void;
  isCancelled(sessionId: string): boolean;
  TIMING: Timing;
}

/** mock 固定回复前缀（不模拟失败，D7）—— 仅 runSendStream 使用 */
const CANNED_REPLY = "好的，我来处理这个请求。（mock 模拟回复）";

/** 按字符/词切分，证明逐块推送 —— 仅本文件流式阶段 helper 使用 */
function splitChunks(text: string): string[] {
  return (
    text.match(/[\u4e00-\u9fa5]|[A-Za-z]+|\s+|[^\sA-Za-z\u4e00-\u9fa5]/g) ?? [
      text,
    ]
  );
}

// ── 阶段 helper（runSendStream 生命周期切块）──────────────────────────
// 统一约定：返回 false = 已取消，调用方立即 return——取消检查点位与抽离前逐条一致。

/** FR-1：auto_retry 演示（关键词触发，让 RetryIndicator 渲染可验证）。
 *  默认不触发（不污染每条消息）；用户输入含 'retry' 时模拟一次瞬态失败→重试→恢复。 */
async function emitAutoRetryDemo(
  sessionId: string,
  text: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { emit, sleep, isCancelled, TIMING } = deps;
  if (!/retry/i.test(text)) return true;
  if (isCancelled(sessionId)) return false;
  emit(sessionId, {
    type: "message.auto_retry_start",
    payload: {
      sessionId,
      attempt: 1,
      maxAttempts: 3,
      delayMs: TIMING.retryGap,
      errorMessage: "upstream 503 (mock)",
    },
  });
  await sleep(TIMING.retryGap);
  if (isCancelled(sessionId)) return false;
  emit(sessionId, {
    type: "message.auto_retry_end",
    payload: { sessionId, success: true, attempt: 1 },
  });
  return true;
}

/** thinking 块（thinking_start → delta×N → end） */
async function emitThinking(
  sessionId: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps;
  if (isCancelled(sessionId)) return false;
  await sleep(TIMING.startGap);
  const thinkingId = nextId("th");
  emit(sessionId, {
    type: "message.thinking_start",
    payload: { sessionId, thinkingId },
  });
  for (const chunk of splitChunks("让我分析一下这个请求……")) {
    if (isCancelled(sessionId)) return false;
    await sleep(TIMING.chunk);
    emit(sessionId, {
      type: "message.thinking_delta",
      payload: { sessionId, delta: chunk },
    });
  }
  if (isCancelled(sessionId)) return false;
  emit(sessionId, { type: "message.thinking_end", payload: { sessionId } });
  return true;
}

/** tool_call 块 + extension widget 块：按用户输入 text 分支，让不同 E2E 场景各取所需序列。
 *  默认（read）：tool_call_start/update/end（card 嵌套 GUI）+ terminal widget + widgetGui × 2 + status
 *    → 覆盖 gui-components.spec.ts 的路径 A/B 验证（零回归）
 *  含 'todo'/'任务'：todo tool_call 序列（details.todos + __gui__ list-tree），不推 extension widget
 *    → 验证 todo tool 结构化渲染（list-tree）
 *  含 'goal'/'目标'：goal_control tool_call 序列（details.slug + __gui__ card）+ goal ANSI widget
 *    → 验证 goal_control tool 结构化渲染（card/stats-line） */
async function emitToolBranch(
  sessionId: string,
  text: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps;
  if (isCancelled(sessionId)) return false;
  await sleep(TIMING.toolGap);
  const branch = detectBranch(text);
  if (branch === "todo") {
    await emitTodoBranch(sessionId, {
      nextId,
      emit,
      sleep,
      isCancelled,
      TIMING,
    });
  } else if (branch === "goal") {
    await emitGoalBranch(sessionId, {
      nextId,
      emit,
      sleep,
      pushSession,
      isCancelled,
      TIMING,
    });
  } else {
    await emitReadBranch(sessionId, {
      nextId,
      emit,
      sleep,
      pushSession,
      isCancelled,
      TIMING,
    });
  }
  return true;
}

/** 文本流式（text_delta×N，reply 按字符/词分块逐块推送） */
async function emitTextStream(
  sessionId: string,
  reply: string,
  messageId: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { emit, sleep, isCancelled, TIMING } = deps;
  for (const chunk of splitChunks(reply)) {
    if (isCancelled(sessionId)) return false;
    await sleep(TIMING.chunk);
    emit(sessionId, {
      type: "message.text_delta",
      id: messageId,
      payload: { sessionId, messageId, delta: chunk },
    });
  }
  return true;
}

/** file_changes（accumulating → ready），证明 ChangeSetCard/FileView 渲染。
 *  ADR-0024 D5 重构：baseline diff，isFullSet 恒 true（每次 diff 都是全量结果，全集替换不增量合并）。
 *  任务4：ready 帧加 unmerged 样本，让 FileView U 标注在 mock 下可验。 */
async function emitFileChanges(
  sessionId: string,
  messageId: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { emit, sleep, isCancelled, TIMING } = deps;
  if (isCancelled(sessionId)) return false;
  await sleep(TIMING.fileChangesGap);
  emit(sessionId, {
    type: "message.file_changes",
    payload: {
      sessionId,
      messageId,
      fileChanges: [
        {
          filePath: "src/mock-feature.ts",
          status: "modified",
          addLines: 10,
          delLines: 2,
        },
      ],
      changeSetStatus: "accumulating",
      isFullSet: true,
    },
  });
  await sleep(TIMING.fileChangesGap);
  if (isCancelled(sessionId)) return false;
  emit(sessionId, {
    type: "message.file_changes",
    payload: {
      sessionId,
      messageId,
      fileChanges: [
        {
          filePath: "src/mock-feature.ts",
          status: "modified",
          addLines: 10,
          delLines: 2,
        },
        { filePath: "src/new-file.ts", status: "added", addLines: 24 },
        {
          filePath: "src/merge-conflict.ts",
          status: "unmerged",
          addLines: 5,
          delLines: 3,
        },
      ],
      changeSetStatus: "ready",
      isFullSet: true,
    },
  });
  return true;
}

/** Extension UI 交互请求（extension.ui_request）：pi extension 调 ctx.ui.select/confirm/input 时，
 *  runtime 经 event-adapter 翻译后推此帧。useExtensionUI composable 经 events.on(sessionId) 订阅，
 *  mock 走 pushSession(dispatchSession) 同构透传，让 dialog 在 mock 下可验证。
 *  仅关键词触发（不污染所有消息，避免 modal 弹窗挡住后续 E2E 交互——如 ST-1 的 complete 后输入）。
 *  用 'ui-select' 哨兵词 + '部署' 中文，避免 /select/i 匹配自然语言中含 "select" 的普通输入。 */
async function emitUiRequest(
  sessionId: string,
  text: string,
  deps: SendStreamDeps
): Promise<boolean> {
  const { nextId, sleep, pushSession, isCancelled, TIMING } = deps;
  if (!/ui[-_ ]?select|部署/i.test(text)) return true;
  if (isCancelled(sessionId)) return false;
  await sleep(TIMING.done);
  pushSession(sessionId, {
    type: "extension.ui_request",
    id: nextId("uir"),
    payload: {
      sessionId,
      requestId: `mock-ui-${Date.now()}`,
      method: "select",
      title: "Mock: 选择部署目标",
      message: "选择部署环境",
      options: ["生产环境", "预发环境", "测试环境"],
    },
  });
  return true;
}

export async function runSendStream(
  sessionId: string,
  text: string,
  deps: SendStreamDeps
): Promise<void> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps;
  const messageId = nextId("m");
  const reply = `已处理："${text}"。\n${CANNED_REPLY}`;

  emit(sessionId, {
    type: "message.message_start",
    id: messageId,
    payload: { sessionId, messageId },
  });

  // 阶段序（各块实现见上方阶段 helper，返回 false = 已取消立即 return）：
  // [auto_retry] → thinking → tool_call 分支 → 文本流式 → file_changes → [ui_request] → complete
  if (!(await emitAutoRetryDemo(sessionId, text, deps))) return;
  if (!(await emitThinking(sessionId, deps))) return;
  if (!(await emitToolBranch(sessionId, text, deps))) return;
  if (!(await emitTextStream(sessionId, reply, messageId, deps))) return;
  if (!(await emitFileChanges(sessionId, messageId, deps))) return;
  if (!(await emitUiRequest(sessionId, text, deps))) return;

  // complete（含 usage，证明 W05-A usage 回填）
  if (isCancelled(sessionId)) return;
  await sleep(TIMING.done);
  emit(sessionId, {
    type: "message.complete",
    id: messageId,
    payload: {
      sessionId,
      messageId,
      stopReason: "complete",
      usage: { inputTokens: 1280, outputTokens: 642, totalTokens: 1922 },
    },
  });
}
