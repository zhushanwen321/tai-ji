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
 * session 无活跃 pi 进程时的状态变更类 RPC 错误码（code-harden RT-4#4）。
 *
 * 触发面：switchModel / setThinkingLevel 落在回收或崩溃窗口（session 条目还在、pi 进程
 * 已不在进程表）。语义 = fail-fast 拒绝而非降级假成功：transport server.ts 的全局 catch
 * 透传 `.code` + `details.sessionId`（L4 增强，与 MODEL_NOT_CONFIGURED 同通路），前端展示
 * 错误消息，用户重开 session 后重试。恢复动作内嵌在错误消息（「重开后可重试」）。
 */
export const SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE'

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
 * 会话激活失败（无码错误的统一包装）。
 *
 * model-switch-live-provider-sync U2：停止态/回收态 session 的模型切换与档位设置先走
 * `ensureActive`（拉起或 join 引擎）——激活阶段抛出的**无码**错误统一包此码；
 * 既有语义码（SESSION_NOT_FOUND / MODEL_NOT_CONFIGURED / RESTORE_FAILED /
 * BUILTIN_EXTENSIONS_MISSING）一律**原样透传**（设计 §3.4 优先级规则：避免把「未配模型」
 * 「打包产物断链」误报成「会话无法恢复」）。
 */
export const SESSION_ACTIVATE_FAILED = 'SESSION_ACTIVATE_FAILED'

/**
 * 会话激活超时（RPC 边界上界，`TAIJI_SESSION_ACTIVATE_TIMEOUT_MS`，默认 15s）。
 *
 * 超时只终止 RPC 等待（前端 toast 指引重试），**不取消后台恢复**——join 语义保留。
 * 触发条件与恢复动作见设计 §3.4 错误规格表「激活超时」行 / §3.6「激活的等待上界」行。
 */
export const SESSION_ACTIVATE_TIMEOUT = 'SESSION_ACTIVATE_TIMEOUT'

/**
 * pi 报 `Model not found` 且模型**不在** taiji 注册表（配置已被删/改名）。
 * 用户面：「该模型已不存在，请重新选择」。
 */
export const MODEL_NOT_FOUND = 'MODEL_NOT_FOUND'

/**
 * pi 报 `Model not found`、模型**在**注册表内，但 provider **无凭据**。
 * 用户面：「该 provider 未配置凭据，请到设置填写 API Key」。
 * 不重载既有 MODEL_NOT_CONFIGURED——后者含义是「session 未配默认模型」（引导去设置选默认模型）。
 */
export const PROVIDER_CREDENTIAL_MISSING = 'PROVIDER_CREDENTIAL_MISSING'

/**
 * pi 报 `Model not found`、模型在注册表、凭据齐备——即运行中进程的模型快照尚未同步（新配置刚写入、
 * 等待 provider-live-sync 扩展刷新）**或**配置里含使 pi 拒载的坏内容（两因不机器可分）。
 *
 * 用户面 = **双因文案**：「若刚改过配置，请稍等两秒重试；若持续失败，请到设置页检查 provider 配置」
 * （设计 D11：不做 taiji 侧模型配置合法性判定，pi 自身 `getError()` 全文落运行日志作为机器证据）。
 */
export const ENGINE_MODEL_MISSING = 'ENGINE_MODEL_MISSING'

/**
 * pi `set_model` RPC 的「模型未找到」错误文本前缀（pi 0.84.4 实装唯一可用判据）。
 *
 * 权威源：`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:371`
 * `return error(id, "set_model", `Model not found: ${provider}/${modelId}`)`；RpcClient 对
 * `success:false` 帧 `reject(new Error(res.error))`（`infra/pi/rpc-client.ts:624`）——即错误
 * **无 code 字段**，只能按文本前缀分类（分类结果再经 taiji 注册表/凭据两判，见 U2）。
 * pi 版本升级后此文本变更即分类失守，受 C-proc-08 探针守卫（docs/pi-semantics.json PS-xx）。
 */
export const PI_MODEL_NOT_FOUND_PREFIX = 'Model not found:'

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
