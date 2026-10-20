/**
 * Archive store —— session 归档域前端状态（session-archive 设计 D10/D11，u-renderer-entry）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。RPC 编排在 features 层
 * （composables/features/sidebar/useArchiveView），本 store 只持状态。
 *
 * 数据源口径（拉为主，ADR-0097）：
 * - archives：config.archives 拉取快照（打开归档视图 / 归档域操作成功后刷新）；
 * - archiveCount：侧栏归档入口角标数据源——config.sessions 广播帧携带值即时更新
 *   （D5 协议变更点），拉取列表时按 archives.length 对账；字段缺省（旧 runtime / mock）
 *   按 0 处理（角标隐藏，D10 count 0 隐藏）。
 *
 * viewOpen 是侧栏 sessions tab 内容区的二态视图开关（会话列表 ↔ 归档列表，D10
 * 「侧栏内切换视图保持上下文」）；selected 是主区摘要视图（D11）当前呈现的归档条目。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ArchiveSummary } from '@taiji/shared'

export const useArchiveStore = defineStore('archive', () => {
  /** 归档列表快照（config.archives 拉取产物；空数组 = 无归档，与加载失败经 listError 分形） */
  const archives = ref<ArchiveSummary[]>([])
  /** 归档条目数（角标数据源；广播帧携带值 / 列表拉取对账） */
  const archiveCount = ref(0)
  /** 侧栏 sessions tab 内容区视图开关（false = 会话列表 SessionList，true = 归档列表） */
  const viewOpen = ref(false)
  /** 主区摘要视图（view:'archive'）当前呈现的归档条目；null = 无选中（占位态） */
  const selected = ref<ArchiveSummary | null>(null)
  /** 列表拉取进行中（打开视图时的加载态） */
  const loading = ref(false)
  /** 列表拉取失败原因（null = 无失败；归档列表显示重试入口） */
  const listError = ref<string | null>(null)

  /** 拉取产物落地（count 同步对账——列表即事实源，D9 不变量 3） */
  function setArchives(list: ArchiveSummary[]): void {
    archives.value = list
    archiveCount.value = list.length
  }

  /** 广播帧携带的 archiveCount 更新（字段缺省不覆盖现值——旧 runtime 无归档数据语义） */
  function setCount(count: number): void {
    archiveCount.value = count
  }

  /** 打开侧栏归档列表视图（列表拉取由 features 层编排触发） */
  function openView(): void {
    viewOpen.value = true
  }

  /** 切回侧栏会话列表（返回钮 / 恢复成功编排） */
  function closeView(): void {
    viewOpen.value = false
  }

  /** 主区摘要视图选中条目（null = 离开摘要视图时清空） */
  function selectArchive(archive: ArchiveSummary | null): void {
    selected.value = archive
  }

  return {
    archives,
    archiveCount,
    viewOpen,
    selected,
    loading,
    listError,
    setArchives,
    setCount,
    openView,
    closeView,
    selectArchive,
  }
})
