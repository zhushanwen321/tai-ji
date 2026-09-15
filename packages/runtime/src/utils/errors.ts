/**
 * 错误处理工具（D14 + D20 + D6）。
 *
 * - `toErrorMessage(e)`：统一 `e instanceof Error ? e.message : String(e)` 样板（D14，
 *   散落 57 处，含 `: e` 与 `: String(e)` 两种漂移）。
 * - `isEnoent(e)`：结构化 ENOENT 判定（D20，统一 `.code === 'ENOENT'` 与脆弱的
 *   `msg.includes('ENOENT')` 字符串匹配两种写法）。
 * - `isNotFound(e)`：tree handler 的「not found」嗅探（D6，统一 5 处
 *   `e.message.includes('not found')` 字符串匹配）。
 */

/**
 * 从任意 thrown 值提取可读的错误信息字符串。
 *
 * Error → `.message`；其它 → `String(value)`。替代散落的
 * `e instanceof Error ? e.message : String(e)` 样板。
 */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 判断错误是否为 ENOENT（文件/目录不存在）。
 *
 * 结构化判定 `code === 'ENOENT'`，替代脆弱的字符串包含匹配
 * `msg.includes('ENOENT')`。对非 Error 或无 code 字段的值返回 false。
 */
export function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null
    && (e as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * 判断错误是否为「not found」类（session-not-active 嗅探，D6）。
 *
 * 统一各处 `e instanceof Error && e.message.includes('not found')`
 * 字符串匹配。抛「not found」串表示 session 未激活，调用方据此降级回复。
 */
export function isNotFound(e: unknown): boolean {
  return e instanceof Error && e.message.includes('not found')
}

/**
 * 构造带 `.code` 属性的 Error（C10）。
 *
 * 统一此前两套写法：`Object.assign(new Error(msg), { code })`（rpc-client）
 * vs `(err as {}).code = code`（plugin-sandbox / session-data-store）。
 * code 可以是 string（'PERMISSION_DENIED' / RPC error code）或 number（JSON-RPC -32xxx）。
 */
export function errorWithCode(message: string, code: string | number): Error & { code: string | number } {
  const err = new Error(message) as Error & { code: string | number }
  err.code = code
  return err
}

/** session 创建/恢复/fork 时 model 未配置的错误码（前端据此引导用户去 Settings 配置） */
export const MODEL_NOT_CONFIGURED = 'MODEL_NOT_CONFIGURED'

/**
 * packaged 模式 builtin extensions staged 目录缺失（electron-build R3-S1）。
 * extension-resolver 的打包产物断链 fail-fast throw 携带此 code，供 facade
 * （session-service.getExtensionPaths）区分「不可降级」错误 rethrow 贯通 fail-fast
 * 与「可降级」意外错误维持降级，消息匹配不可靠（见 errorWithCode 用法约定）。
 */
export const BUILTIN_EXTENSIONS_MISSING = 'BUILTIN_EXTENSIONS_MISSING'

/** session 恢复时找不到磁盘 session 文件（pi 延迟写入窗口崩溃 / 文件被删） */
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'
/** session 恢复时 spawn pi / switchSession / initialize 失败 */
export const RESTORE_FAILED = 'RESTORE_FAILED'

/**
 * pi RPC 命令超时错误（D3a pi 半死自愈：超时判别收口为类型）。
 *
 * [arch] 定义在 utils（services/infra 共享中立层）：services 层（message-dispatcher）
 * 需要 instanceof 运行时值判别，若定义在 infra/pi/rpc-client 会构成 services→infra 的
 * 运行时值 import（runtime 三层规则禁止，见 runtime-layering.md）。rpc-client.ts
 * （infra）从这里 import 并 re-export，保持既有 import 路径兼容。
 */
export class RpcTimeoutError extends Error {
  constructor(
    /** 超时的 RPC 命令类型（如 'abort' / 'prompt'），诊断用 */
    public readonly commandType: string,
    /** 该命令配置的超时毫秒数，诊断用 */
    public readonly timeoutMs: number,
  ) {
    super(`RPC command "${commandType}" timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}
