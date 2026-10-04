// src/global-slots.ts
//
// [§2.6 槽键单一归属 · SDK 侧] 本包进程级全局槽键的**唯一声明处**。
//
// 机制与纪律同 core 的 `src/shared/global-slots.ts`（Symbol.for + globalThis，供
// workspace 源码 / npm dist / pi jiti 三种实例化通道共享进程级单例）。
//
// 命名空间例外：本包**不能** import `@zhushanwen/subagent-core`（不变量：SDK 是契约根，
// 见 index.ts 头注与 .githooks/check-engine-sdk-boundary.mjs），因此 SDK 自有槽保留
// `@zhushanwen/subagent-engine-sdk.` 前缀，不复用 core 的 `@zhushanwen/subagent-core.`
// 统一前缀——两个前缀构成全集，机器检查 scripts/check-global-slot-keys.mjs 同时约束
// 两文件（字面量只允许出现在两处 + 前缀/唯一性校验）。
export const ENGINE_SDK_SLOT_KEYS = {
  /** dataDir 缺省告警一次性标记（data-dir.ts）。 */
  dataDirWarned: "@zhushanwen/subagent-engine-sdk.data-dir-warned",
  /** logger sink 进程级单例（logger.ts）。 */
  loggerSink: "@zhushanwen/subagent-engine-sdk.logger-sink",
} as const;
