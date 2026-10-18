/**
 * [M3 relay-spawn-transport u-m3-mirror] relay tee 迁移桥（临时 shim；u-m3-delete 删除本文件）。
 *
 * tee 实现已按设计 §3.4.6 迁至 `infra/subagent-control/subagent-tee.ts`（RelayTee →
 * SubagentTee，新增 degraded）。过渡期 relay-registry.ts（u-m3-delete territory，本单元
 * 不改）与既有 relay 测试经本文件继续以 `RelayTee` 别名消费同一实现——零复制、单一事实源。
 * u-m3-delete 同批更新 relay-registry 的 import（或随 registry 删除一并移除）后删除本文件。
 */
export {
  SubagentTee as RelayTee,
  TEE_MAX_CONSECUTIVE_FAILURES,
} from '../subagent-control/subagent-tee.js'
export type {
  SubagentTeeOptions as RelayTeeOptions,
  SubagentTeeStreamState as RelayTeeStreamState,
  SubagentTeePublish as RelayTeePublish,
} from '../subagent-control/subagent-tee.js'
