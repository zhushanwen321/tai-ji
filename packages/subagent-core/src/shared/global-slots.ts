// src/shared/global-slots.ts
//
// [§2.6 槽键单一归属] 进程级全局槽键的**唯一声明处**（core + 壳侧托管槽）。
//
// 机制：`Symbol.for(key)` + `globalThis` 存取。为什么需要它——本仓有三种包实例化通道
// （workspace 源码 / npm dist / pi jiti 加载），模块级变量会出现「同进程两份实例互相
// 看不见」（历史事故：跨实例槽误配导致互相覆写）。因此进程级单例必须挂在
// `globalThis[Symbol.for(键)]` 上，两侧用同一个键字面量才能共享。
//
// 问题（§2.6）：键的命名空间此前散落四个前缀（`@zhushanwen/pi-subagent-workflow.`
// 8 个、`@zhushanwen/pi-subagents.` 6 个、`@zhushanwen/subagent-core.` 2 个、
// `@zhushanwen/subagent-engine-sdk.` 2 个），名字与实际归属不符（8 个「pi-subagent-
// workflow」前缀的槽实际全在 core 内），撞名无编译期报错、只会静默抢槽。
//
// 纪律（机器检查 scripts/check-global-slot-keys.mjs，约束 C-state-20）：
//   1. `Symbol.for("…")` 字面量只允许出现在本文件与 SDK 的 src/global-slots.ts；
//   2. 本文件键统一 `@zhushanwen/subagent-core.<槽名>`（SDK 侧例外见其文件头）；
//   3. 槽名在本文件内唯一。
//
// 兼容性：改键不破坏跨进程语义（槽是「每进程一份」的运行时单例，重启即空）；但 dev
// 热重载期间旧代码与新代码会各自成槽（互不可见，各持一份 registry），需整进程重启
// 收敛——与扩展双载（settings 清单 + `--extension`）的既有纪律同源（见 AGENTS.md
// 的 `-ne` 必带条目）。
export const GLOBAL_SLOT_KEYS = {
  /** host-services：宿主注入的服务集合（core/host-services.ts）。 */
  hostServices: "@zhushanwen/subagent-core.host-services",
  /** notify-ports：通知端口集合（core/notify-ports.ts）。 */
  notifyPorts: "@zhushanwen/subagent-core.notify-ports",
  /** engineRegistry：引擎注册表（execution/engine/registry.ts）。 */
  engineRegistry: "@zhushanwen/subagent-core.engineRegistry",
  /** activeWindowEngineDisposer：活动窗口引擎释放器（execution/engine/registry.ts）。 */
  activeWindowEngineDisposer: "@zhushanwen/subagent-core.activeWindowEngineDisposer",
  /** engineDiscoveryRescanOpts：引擎发现重扫配置（execution/engine/routing.ts）。 */
  engineDiscoveryRescanOpts: "@zhushanwen/subagent-core.engineDiscoveryRescanOpts",
  /** workflowWindowEngineStates：窗口×引擎状态表（execution/engine/routing.ts）。 */
  workflowWindowEngineStates: "@zhushanwen/subagent-core.workflowWindowEngineStates",
  /** workflowWindowEngineGateway：窗口×引擎网关（execution/engine/routing.ts）。 */
  workflowWindowEngineGateway: "@zhushanwen/subagent-core.workflowWindowEngineGateway",
  /** nativeSessionReaders：原生会话读取器表（execution/engine/common/session-view-service.ts）。 */
  nativeSessionReaders: "@zhushanwen/subagent-core.nativeSessionReaders",
  /** hostUiRequestEndpoint：宿主 UI 请求端点（execution/engine/host/host-ui-endpoint.ts）。 */
  hostUiRequestEndpoint: "@zhushanwen/subagent-core.hostUiRequestEndpoint",
  /** coreSpawnedChildrenMirror：core 侧子进程镜像（execution/engine/host/spawned-children.ts）。 */
  coreSpawnedChildrenMirror: "@zhushanwen/subagent-core.coreSpawnedChildrenMirror",
  /** channelHandshake：marker 通道握手态（execution/assembly/channel-registry-access.ts）。 */
  channelHandshake: "@zhushanwen/subagent-core.channelHandshake",
  /** modelService：模型服务单例（execution/assembly/model-config-service.ts）。 */
  modelService: "@zhushanwen/subagent-core.model-service",
  /** notifyLedger：通知账本（execution/notify/notify-ledger.ts）。 */
  notifyLedger: "@zhushanwen/subagent-core.notifyLedger",
  /** service：subagent 服务单例（execution/service/service-bootstrap.ts）。 */
  service: "@zhushanwen/subagent-core.service",
  /**
   * dialogQueue：人机交互串行队列（execution/ui/dialog-queue.ts 读、壳
   * `session-lifecycle.ts` 写——两端同键）。
   */
  dialogQueue: "@zhushanwen/subagent-core.dialogQueue",
  /** workflowDomainState：workflow 域状态槽（壳 `workflow-events.ts`，core 侧类型契约定）。 */
  workflowDomainState: "@zhushanwen/subagent-core.workflowDomainState",
} as const;

/** 槽键名（`GLOBAL_SLOT_KEYS` 的键集合）。 */
export type GlobalSlotName = keyof typeof GLOBAL_SLOT_KEYS;
