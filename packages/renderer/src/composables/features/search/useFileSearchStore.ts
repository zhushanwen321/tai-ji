/**
 * useFileSearchStore —— file search store 壳单例（new-task-search 域，D7 双轨收口）。
 *
 * [归位] core createFileSearchStore 的模块级缓存壳适配（与 features/command/useCommandStore
 * 同构）。SearchModal（useSearchModalDeps → core search 域编排）与 CommandPopover
 * （useFileSearch 壳编排；原并列的 useSearch.ts 已随域迁移删除，2026-09-11）必须共享同一实例
 * ——否则 per-session 文件候选缓存分桶，两浮层各自重复递归且失效不同步（D7「同一数据源」目标）。
 *
 * 消费方契约：core 实例的 ref 需显式 .value（无 pinia 解包）；get/set/invalidate
 * 为普通方法，调用形态与原 pinia 版一致。
 */
import { createFileSearchStore } from '@taiji/core'

let instance: ReturnType<typeof createFileSearchStore> | null = null

export function useFileSearchStore(): ReturnType<typeof createFileSearchStore> {
  if (!instance) instance = createFileSearchStore()
  return instance
}

/** 仅测试用：重置单例（跨用例隔离，对齐 __resetCommandStoreForTesting 先例）。 */
export function __resetFileSearchStoreForTesting(): void {
  instance = null
}
