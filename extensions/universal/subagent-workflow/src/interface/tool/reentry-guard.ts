/**
 * reentry-guard.ts — Shared reentry guard helpers for workflow tools.
 *
 * Keeps the "check → set → try/finally release" pattern in one place
 * without wrapping execute in a higher-order function (which would
 * complicate inferred union return types).
 */

export interface ReentryGuardRef {
  isProcessing: boolean;
}

/** reentry 拒绝时的统一提示文案。 */
export const REENTRY_BUSY_MESSAGE =
  "Another workflow operation is in progress; please wait for it to complete before issuing another command.";

/**
 * 尝试获取 reentry guard。返回 true 表示获取成功（调用方必须在 finally 中调用 releaseReentryGuard）。
 * 已被占用时返回 false，调用方应返回 isError:true 的 busy 响应。
 */
export function acquireReentryGuard(guard: ReentryGuardRef): boolean {
  if (guard.isProcessing) return false;
  guard.isProcessing = true;
  return true;
}

/** 释放 reentry guard。仅在 acquire 成功后调用。 */
export function releaseReentryGuard(guard: ReentryGuardRef): void {
  guard.isProcessing = false;
}
