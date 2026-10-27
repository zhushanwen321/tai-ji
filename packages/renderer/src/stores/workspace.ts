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
  /**
   * RD-3#4：load 失败标记（最近工作区读失败 ≠ 无历史）。失败时 records 保留旧值
   * （connection-datasync-ssot §6.4 降级型显式行为改进：断连重拉失败不闪空列表），
   * 仅观测留痕——不加错误条/重试（失败呈现通道 = console.warn + loadError）。
   */
  const loadError = ref<string | null>(null)

  /** 默认 cwd：最近活跃工作区（records 中第一条未 pinned 的 cwd，W3 取代 resolveDefaultCwd）。
   *  pinned 条目不参与（用户固定目录 ≠ 最近使用，保持本 computed 既有语义不变）。 */
  const defaultCwd = computed(() => records.value.find((r) => !r.pinned)?.cwd)

  /**
   * 默认会话目录（<dataDir>/defaultSession/，runtime 动态推导下发）。
   * 空串 = 未拉取 / runtime ensure 失败（「默认会话」入口据此隐藏）。
   */
  const defaultSessionDir = ref('')

  /**
   * 拉取默认会话目录（workspace 数据域同步函数，§6.4③：随连接边沿重拉——
   * useSidebar.ts workspace 域登记 sync 内串行于 load 之后；失败降级空串不阻断同步）。
   */
  async function loadDefaultSessionDir(): Promise<void> {
    try {
      defaultSessionDir.value = await workspace.defaultSessionDir()
    } catch (e) {
      defaultSessionDir.value = ''
      console.warn('[workspace] loadDefaultSessionDir failed, hide default-session entry', e)
    }
  }

  /**
   * pin/unpin 最近工作区条目并热更新列表（DirSelectPopover 悬停动作调用）。
   * 返回是否生效（false = 超 pin 上限被拒，调用方 toast 提示；列表未变）。
   * RPC reject → 返回 false 并保留旧 records（与 record 同款 stale 降级）。
   */
  async function setPinned(cwd: string, pinned: boolean): Promise<boolean> {
    try {
      const reply = await workspace.setPinned(cwd, pinned)
      records.value = reply.records
      return !reply.degraded
    } catch (e) {
      console.warn('[workspace] setPinned failed, keeping stale records', e)
      return false
    }
  }

  /**
   * 加载最近工作区记录（workspace 数据域同步函数，§6.4③：随连接边沿重拉）。
   * 失败降级：records 保留旧值不抛（§6.4 降级型显式行为改进——断连重拉失败不闪空
   * 列表）+ console.warn 留痕 + loadError 标记，让「读失败」与「真无历史」在观测
   * 范围可分；不阻断启动。
   */
  async function load(): Promise<void> {
    try {
      records.value = await workspace.listRecent()
      loadError.value = null
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
      console.warn('[workspace] load failed, keeping previous records:', loadError.value)
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
      // 降级：record 失败时保留旧 records（stale 但有用，不清空——与 load() 同款
      // 保留旧值语义：重拉失败不清用户已见数据）。不阻断选目录流程。
      console.warn('[workspace] record failed, keeping stale records', e)
    }
  }

  return { records, loadError, defaultCwd, defaultSessionDir, load, record, loadDefaultSessionDir, setPinned }
})
