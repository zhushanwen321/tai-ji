/**
 * WorktreeService 域的扁平错误工厂。
 *
 * 错误对象形状：`Error & { code: WorktreeErrorCode; detail?: unknown }`——普通 Error +
 * 附加字段（非 class 实例），测试用 toMatchObject 断言 code/detail；契约说明见
 * ports/worktree-service.ts 头注释。worktree-service.ts 与 base-ref-resolution.ts（自前者
 * 抽出的 base 解析模块，推导不出可用基线时抛 GIT_FAILED）共用此一处，错误形状不漂移。
 */
import type { WorktreeErrorCode } from '@taiji/shared'

export function worktreeError(code: WorktreeErrorCode, message: string, detail?: unknown): Error {
  return Object.assign(new Error(message), detail !== undefined ? { code, detail } : { code })
}
