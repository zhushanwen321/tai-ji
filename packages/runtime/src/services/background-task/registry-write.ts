/**
 * kill 回路的 registry 写工具（D6 分支矩阵的写侧；锁内版——调用方持
 * `<registry.json>.lock`，与 extension 写侧 / reaper 写侧互斥同一把锁）。
 *
 * 为什么只有 Locked 版：D6 分支①③要求「锁内重读 → 判活重查 → 写」在同一锁临界区
 * 内完成（防 stale 条目覆盖 poller 已写的新鲜终态——writeMerged 范式），嵌套取锁
 * 必然 ELOCKED（file-lock 契约），故写原语必须无锁化，锁编排归 kill 流程
 * （background-task-service.ts killTask）。
 *
 * orphaned 终态写复用 reaper 提炼导出的 writeOrphanedTerminalLocked（②③属主死分支，
 * 对齐 reaper 分支②③语义）；本文件只补 kill 特有的两种写：
 *  - writeKillingStateLocked：分支① killing intent 预写（仅置 state，不写 reason——
 *    契约规定 reason 仅 exited 语义，与 bash_kill 落盘同构）
 *  - writeExitedTransitionalLocked：分支③属主活的过渡终态（exited/reason natural/
 *    exitCode null——poller 若健康会 ≤2s 用真实 exitCode/tailSummary 覆盖，两写均
 *    终态、RMW 串行，覆盖无害）
 *
 * 文件原语（原子写/序列化/终态裁剪）自 ext-simplify-13 起取 protocol 子出口
 * `background-task`（跨端单一实现，与 reaper/extension 写侧字节同构），本文件保留
 * 锁内 RMW 编排；tmp 清理诊断经 onLog 注入本文件 console 适配。
 */

import {
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isTerminalBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
} from '@xyz-agent/extension-protocol'
import {
  atomicWriteRegistry,
  serializeRegistryFile,
  trimTerminalEntries,
  type RegistryFileLogFn,
} from '../../utils/protocol-background-task.js'
import { readRegistryEntries } from '../session/background-task-reaper.js'

const LOG_TAG = '[bg-task-registry-write]'

/** 原子写 tmp 清理失败的 console 适配（protocol onLog → runtime console 通道；原错误照常向上抛，不掩盖）。 */
const registryLog: RegistryFileLogFn = (level, event, detail) =>
  (level === 'warn' ? console.warn : console.debug)(`${LOG_TAG} ${event}`, detail)

/**
 * 终态 LRU 裁剪 + 原子写（对齐 reaper writeOrphanedTerminalLocked 的裁剪语义：
 * 按 endedAt ?? startedAt 升序淘汰最老终态，保 MAX_TERMINAL_REGISTRY_ENTRIES；
 * 裁剪/序列化/原子写均为 protocol 单一实现，taskId 去重防御保留在本编排层）。
 */
function writeTrimmedLocked(registryPath: string, entries: BackgroundTaskRegistryEntry[]): void {
  const merged = new Map(entries.map((e) => [e.taskId, e] as const))
  const kept = trimTerminalEntries([...merged.values()], MAX_TERMINAL_REGISTRY_ENTRIES)
  atomicWriteRegistry(registryPath, serializeRegistryFile(kept), registryLog)
}

/**
 * 分支① killing intent 预写（锁内调用）：仅置 `state: 'killing'`，不写 reason 字段
 * （契约：reason 仅 exited 语义）。条目缺失 / 已终态（poller 竞争先赢）→ false（调用方
 * 映射 already-exited，不覆盖）；fs 错误向上抛（调用方捕获 → 分支⑤ registry-write-failed）。
 */
export function writeKillingStateLocked(registryPath: string, taskId: string): boolean {
  const entries = readRegistryEntries(registryPath)
  const idx = entries.findIndex((e) => e.taskId === taskId)
  if (idx === -1 || isTerminalBackgroundTaskState(entries[idx].state)) return false
  entries[idx] = { ...entries[idx], state: 'killing' }
  writeTrimmedLocked(registryPath, entries)
  return true
}

/**
 * 分支③属主活的过渡终态写（锁内调用）：exited / reason natural / exitCode null +
 * endedAt/durationMs。条目缺失 / 已终态 → false（poller 已写权威终态，不覆盖）；
 * fs 错误向上抛（调用方捕获 → 分支⑤）。终态 +1 触发 LRU 裁剪。
 */
export function writeExitedTransitionalLocked(registryPath: string, taskId: string): boolean {
  const entries = readRegistryEntries(registryPath)
  const idx = entries.findIndex((e) => e.taskId === taskId)
  if (idx === -1 || isTerminalBackgroundTaskState(entries[idx].state)) return false
  const entry = entries[idx]
  const endedAt = Date.now()
  entries[idx] = {
    ...entry,
    state: 'exited',
    reason: 'natural',
    exitCode: null,
    endedAt,
    durationMs: endedAt - entry.startedAt,
  }
  writeTrimmedLocked(registryPath, entries)
  return true
}
