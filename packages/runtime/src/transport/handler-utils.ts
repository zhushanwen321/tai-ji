/**
 * transport handler 共享工具。
 *
 * sendHandlerError 收口 git / file / extension 三个 handler 此前各自复制的 sendXError
 * 样板（D10/P0-B 错误契约）：`instanceof XError → use .code/.message else fallbackCode + toErrorMessage`。
 * 各 handler 只需声明「认领的错误类 + 兜底 code + details」，分支判断交给本工具。
 */
import type { WebSocket as WsType } from 'ws'
import type { MessageHandlerContext, ErrorDetails } from './message-context.js'
import { toErrorMessage } from '../utils/errors.js'

/**
 * 统一 message-handler 错误回复。
 *
 * @param ctx          handler 上下文（提供 sendError）
 * @param ws           目标连接
 * @param errorClass   handler 认领的领域错误类（GitError / FileError / ExtensionInstallError …）
 * @param fallbackCode error 非 errorClass 时使用的通用 code（'git_failed' / 'file_failed' / 'install_failed'）
 * @param error        被抛出的值
 * @param id           关联的请求 id（透传到 error envelope）
 * @param details      error envelope 的扩展槽：
 *   - 传静态 ErrorDetails → matched 与 fallback 两分支都用（git/file：sessionId 透传）。
 *   - 传 `(matched) => details` 函数 → 仅 matched 分支调用（取错误实例上的 hint 等），fallback 得 undefined（extension install）。
 */
export function sendHandlerError<E extends Error & { code: string }>(
  ctx: MessageHandlerContext,
  ws: WsType,
  // eslint 的 no-explicit-any 对构造器签名是 false positive：Error 子类构造器参数各异，
  // 无法用单一具体类型表达。用 `never[]`（bottom type，逆变位置）替代 any[]：
  // 任何 `new (具体参数) => E` 都可赋给 `new (...args: never[]) => E`，类型安全且不触发 lint。
  errorClass: new (...args: never[]) => E,
  fallbackCode: string,
  error: unknown,
  id: string | undefined,
  details?: ErrorDetails | ((matched: E) => ErrorDetails | undefined),
): void {
  if (error instanceof errorClass) {
    const d = typeof details === 'function' ? details(error) : details
    ctx.sendError(ws, error.code, error.message, id, d)
  } else {
    const d = typeof details === 'function' ? undefined : details
    ctx.sendError(ws, fallbackCode, toErrorMessage(error), id, d)
  }
}
