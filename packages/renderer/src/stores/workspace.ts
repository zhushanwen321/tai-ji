/**
 * Workspace store —— 最近工作区记录（D-005/D-006）。
 *
 * 依赖方向：api/domains/workspace（stores 间禁止互相 import）。
 *
 * 数据源：runtime workspace.listRecent → RecentWorkspaceRecord[]（按 lastUsedAt 倒序）。
 * 前端不再从 session 列表派生 recentWorkspaces（W3 改接 workspaceStore）。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { RecentWorkspaceRecord } from '@taiji/shared'
import { workspace } from '@/api'

export const useWorkspaceStore = defineStore('workspace', () => {
  const records = ref<RecentWorkspaceRecord[]>([])

  /** 默认 cwd：最近活跃工作区（records[0]?.cwd，W3 取代 resolveDefaultCwd） */
  const defaultCwd = computed(() => records.value[0]?.cwd)

  /**
   * 加载最近工作区记录（initApp INV-6 时序：在 presetCwd 前调用）。
   * AC-4.5：RPC reject → records 置 [] 不抛（降级为空态，不阻断启动）。
   */
  async function load(): Promise<void> {
    try {
      records.value = await workspace.listRecent()
    } catch {
      records.value = []
    }
  }

  /**
   * 记录一次工作区使用并刷新列表（选目录后热更新）。
   *
   * selectWorkspace/openDirDialog 选中目录后调用：runtime 写入记录后回传最新 records，
   * 前端据此直接更新 records（一次往返，无需二次 load，无时序竞争）。
   * RPC reject → 静默降级（不阻断选目录流程，记录仅用于下次列表展示）。
   */
  async function record(cwd: string): Promise<void> {
    if (!cwd) return
    try {
      records.value = await workspace.record(cwd)
     
    } catch (e) {
      // 降级：record 失败时保留旧 records（stale 但有用，不清空——与 load() 清空语义不同：
      // load 是首次加载失败则无数据可显；record 是增量更新失败，旧列表仍有效）。不阻断选目录流程。
      console.warn('[workspace] record failed, keeping stale records', e)
    }
  }

  return { records, defaultCwd, load, record }
})
