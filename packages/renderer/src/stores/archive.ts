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

/** 恢复高亮停留时长（§5.1 恢复样例「accent-soft 高亮渐隐」：置顶行高亮数秒后渐隐回普通行） */
const RESTORED_HIGHLIGHT_MS = 5_000

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
  /**
   * 在途恢复/彻底删除的 sessionId（null = 无操作在途）。按 sessionId 而非布尔：
   * 不同条目的归档域操作本就按 per-session 串行，互不阻塞。消费点 = 归档列表行钮
   * 禁用态（防双击）与编排入口防重入（§5.1 恢复钮 loading 语义的落地形态）。
   */
  const restoringSessionId = ref<string | null>(null)
  const purgingSessionId = ref<string | null>(null)
  /**
   * 刚恢复的 session id（§5.1 恢复样例「原项目组顶部、accent-soft 高亮渐隐」的前端
   * 高亮态）：unarchive reply 的 SessionSummary.id 消费点（D5 步骤 7「前端高亮置顶」）。
   * null = 无恢复高亮。置顶构造性成立（恢复路径重写主文件 → mtime = 恢复时刻 → 列表
   * 序 = mtime 降序组内第一），本字段只驱动行高亮渐隐。行定位按 id 匹配（不持
   * SessionSummary 引用——广播回流后列表条目实例会重建，持引用会脱锚）。
   */
  const restoredSessionId = ref<string | null>(null)
  /** 恢复高亮自动清除定时器（重复恢复时重置；store 为 pinia 单例无泄漏窗口） */
  let restoredClearTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 拉取产物落地（count 同步对账——列表即事实源，D9 不变量 3）。
   *
   * selected 重锚（D11「后台任务完成事件刷新」的摘要视图半边）：selected 持的是点击
   * 行时捕获的对象引用，压缩完成帧触发的重拉产出了新对象（staging→archived 簿记重写）
   * ——不重锚则摘要视图继续渲染旧 staging 对象，「摘要生成中」占位永不清除。按
   * sessionId 从新列表定位换代（与 restoredSessionId 的 id 匹配同族——引用脱锚的
   * 唯一防线）；条目已消失（恢复/彻底删除在远端窗口完成）置 null——主区空态占位，
   * 用户可经侧栏重新选择。
   */
  function setArchives(list: ArchiveSummary[]): void {
    archives.value = list
    archiveCount.value = list.length
    const current = selected.value
    if (current !== null) {
      selected.value = list.find((a) => a.sessionId === current.sessionId) ?? null
    }
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

  /** 登记刚恢复的 session（恢复成功编排调用；数秒后自动清除触发高亮渐隐） */
  function markRestored(sessionId: string): void {
    if (restoredClearTimer !== null) clearTimeout(restoredClearTimer)
    restoredSessionId.value = sessionId
    restoredClearTimer = setTimeout(() => {
      restoredSessionId.value = null
      restoredClearTimer = null
    }, RESTORED_HIGHLIGHT_MS)
  }

  return {
    archives,
    archiveCount,
    viewOpen,
    selected,
    loading,
    listError,
    restoredSessionId,
    restoringSessionId,
    purgingSessionId,
    setArchives,
    setCount,
    openView,
    closeView,
    selectArchive,
    markRestored,
  }
})
