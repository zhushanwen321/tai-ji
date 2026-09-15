import type { ISessionService, IConfigService } from '../../interfaces.js'

// 插件系统类型消费薄壳（D28 方向反转，2026-09-05）：
// 主域 single source of truth = packages/plugin-sdk/src/types.ts（对外发布契约）；
// Bridge* 回包形状（BridgeSyncPayload / BridgeToolExecuteResponse /
// BridgeInterceptResponse）single source of truth = @xyz-agent/extension-protocol
// （D4 单源化，runtime 与 plugin-sdk 均经协议包 re-export 消费）。本文件原内联的
// Worker/AgentAPI/Bridge/Tool 等域类型已上收，此处仅 re-export 保持既有
// `from './plugin-types.js'` 导入面不变；仅保留一个 runtime 专属内部类型
// （IPluginServiceDeps，依赖 runtime 内部 service port，不进插件作者契约面）。
// descriptor / rpc 域仍由本地子文件定义（./plugin-types/），hook 域经薄壳
// hook-types.ts 指向 SDK——三者与 SDK 同构，为最小 diff 过渡形态。
//
// 分层标注（IF2）沿承 SDK 侧定义：
// - @stable — Phase1AgentAPI 核心面 storage/notify/sessions、PermissionConstants、
//   PluginRpcErrorCodes、Disposable、SessionInfo、PluginStateStorage
// - @experimental — events 插件间事件总线（未实现，调用即抛 NOT_IMPLEMENTED）
// - @proposed — Phase2AgentAPI 扩展面 tools/hooks/config/sessionData/ui/agent/
//   workspace、ToolRegistration、HookEntry、StatusBarItemOptions 等
// - @internal — runtime 内部塑形对象（WorkerHandle、PluginContext、Bridge* 等）

// ── 主域类型：SSOT 在 plugin-sdk ────────────────────────────────────
export type {
  WorkerHandle,
  ProcessHandle,
  ActivationEventType,
  ActivationEvent,
  PluginContext,
  PluginModule,
  Phase1AgentAPI,
  SessionInfo,
  PluginStateStorage,
  HostToWorkerMessage,
  WorkerToHostMessage,
  Disposable,
  PluginPermission,
  PluginState,
  PermissionConstant,
  BridgeState,
  BridgeSyncRequest,
  BridgeSyncResponse,
  BridgeToolExecuteRequest,
  ToolExecuteHandler,
  ToolRegistration,
  ToolEntry,
  StatusBarItemOptions,
  UiDialogOptions,
  HookEntry,
  Phase2AgentAPI,
  PluginUIRequest,
} from 'xyz-agent-plugin-sdk'
export { PermissionConstants } from 'xyz-agent-plugin-sdk'

// ── Bridge* 回包形状：SSOT 在 @xyz-agent/extension-protocol ────────
// D4 单源化：唯一定义源 = @xyz-agent/extension-protocol 的 plugin-bridge 协议模块（marker.ts + types.ts），
// plugin-sdk 亦经协议包 re-export 消费（plugin-sdk 侧保持零本地定义）。
export type {
  BridgeSyncPayload,
  BridgeToolExecuteResponse,
  BridgeInterceptResponse,
} from '@xyz-agent/extension-protocol'

// ── Descriptor / Manifest 域 ───────────────────────────────────────
// 本地子文件定义（sync 时代的历史分层，未上收 SDK 通路）。
export type {
  PluginSource,
  XyzAgentManifest,
  XyzAgentPackageJson,
  PluginDescriptor,
  PluginContributes,
} from './plugin-types/descriptor-types.js'

// ── RPC 线协议域 ──────────────────────────────────────────────────
// 本地子文件定义。const 必须用 export-from 重导出。
export type {
  RpcRequest,
  RpcSuccessResponse,
  RpcErrorResponse,
  RpcResponse,
  RpcNotification,
  RpcMessage,
} from './plugin-types/rpc-protocol.js'
export { PluginRpcErrorCodes } from './plugin-types/rpc-protocol.js'
export type { PluginRpcErrorCode } from './plugin-types/rpc-protocol.js'

// ── Hook 域 ───────────────────────────────────────────────────────
// 薄壳 hook-types.ts → SDK。
export type {
  InterceptorHookType,
  ObserverHookType,
  HookType,
  InterceptorResult,
  HookContext,
  HookInterceptor,
  HookObserver,
  HookResult,
  HookBlockedResult,
  PiEventCallback,
} from './plugin-types/hook-types.js'

// ── runtime 专属内部类型（不进 SDK）───────────────────────────────

// ── PluginService 依赖注入 ──────────────────────────────────────────

/** @internal — runtime 内部：PluginService 外部依赖（依赖 runtime service port，不上收 SDK） */
export interface IPluginServiceDeps {
  sessionService?: ISessionService
  configService?: IConfigService
  modelService?: import('../../interfaces.js').IModelService
  broadcastFn?: (type: string, payload: unknown) => void
  /** xyz-agent 配置根目录（~/.xyz-agent/）。注入后 plugin 切片不再直连 infra 取路径。 */
  configDir?: string
  /**
   * 插件安装器（IPluginInstaller port）。组合根注入 infra adapter
   * （NpmPluginInstaller）。installPlugin 在缺省时返回 { success:false } 而非 spawn。
   */
  pluginInstaller?: import('../ports/plugin-installer.js').IPluginInstaller
  /**
   * 文件软删除 port（结构匹配 ITrash.trashFile）。组合根注入 infra adapter（trash）；
   * session 真删除时 session-data 清理经 trash（mac 废纸篓 / 非 mac unlink），缺省 undefined
   * 时 SessionDataStore 回退直接 unlink（B5）。
   */
  trashFile?: import('../ports/trash.js').ITrash['trashFile']
}
