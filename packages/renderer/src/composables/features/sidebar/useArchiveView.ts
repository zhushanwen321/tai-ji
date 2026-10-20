/**
 * useArchiveView —— 归档列表视图与主区摘要视图的编排（session-archive 设计 D10/D11，
 * u-renderer-entry；D5 config.archives 拉取 + 恢复/彻底删除成功路径）。
 *
 * 「api 调用只在 features 层」铁律的归档域落点：config.archives / session.unarchive /
 * session.purgeArchive 三 RPC 经此编排；session.archive（归档发起）走
 * useSidebar.archiveSession（core createUseSession 编排——cleanupSessionState 同族 +
 * wasActive 回退，D14），由 useSidebarSessionActions.onArchiveSession 承接。
 *
 * 形态 = 模块级单例函数集（subagent-composer-lane / useChat 的 tFn 先例）：消费点跨
 * Sidebar（侧栏视图切换）与 MainPanel→ArchiveMainView（主区恢复编排）两棵子树，
 * 无组件作用域依赖（store 走 pinia 单例、toast 文案走 i18n.global.t），多调用点返回
 * 等价闭包。恢复后的会话列表刷新走 runtime unarchive 步骤 7 的 broadcastSessionList
 * 广播回流（core bindSessionListBroadcast 自动 applySnapshot——owner 唯一写通道，
 * 本编排不旁路直呼 store mutation；重连对账兜底由 useSidebar.onConnected 既有链承担）。
 *
 * 恢复成功编排（D5 步骤 7 / D10）：unarchive reply 的 SessionSummary 不自动切入
 * （设计 §5.1：恢复后主区是确认形态，点击行才打开完整对话）——切回会话列表 +
 * 主区导航回 chat + reply.id 登记恢复高亮（原项目组顶部 accent-soft 渐隐——置顶由
 * 恢复路径重写主文件的 mtime 语义构造性成立）+ toast 确认。彻底删除成功：刷新归档
 * 列表；keep-all 保守分支（keptSubagentsDir 携带）出声说明残留目录（D5 步骤 7 失败
 * 显式上报）。
 */
import { onScopeDispose } from 'vue'
import type { ArchiveSummary } from '@taiji/shared'
import { session as sessionApi } from '@/api'
import * as events from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import i18n from '@/i18n'
import { useArchiveStore } from '@/stores/archive'
import { useNavigationStore } from '@/stores/navigation'
import { useToast } from '@/composables/useToast'
import { archiveErrorKey } from './archive-error-text'

/** toast/占位文案（i18n 全局实例——模块级编排无组件 setup 上下文，cast 先例同 useChat tFn）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * 拉取归档列表（config.archives；打开视图 / 归档域操作成功后对账 / 压缩完成帧触发）。
 * 失败置 listError 供归档列表重试入口（拉为主：列表 = 归档目录扫描派生，D9 不变量 3）。
 * in-flight 期间的新调用合并为完成后补拉一次（trailing）：帧到达密集时旧快照后到
 * 覆盖新快照的竞态由串行化收敛（多入口并发同样受益——openView 与恢复/删除后刷新）。
 */
let refreshInFlight: Promise<void> | null = null
let refreshPending = false
async function refreshArchives(): Promise<void> {
  if (refreshInFlight) {
    // 已有拉取在途：标记补拉，由在途任务完成后承接（不并发、不丢弃）。
    refreshPending = true
    await refreshInFlight
    return
  }
  const run = (async () => {
    try {
      do {
        refreshPending = false
        const store = useArchiveStore()
        store.loading = true
        store.listError = null
        try {
          const archives = await sessionApi.listArchives()
          store.setArchives(archives)
        } catch (e) {
          store.listError = toErrorMessage(e)
        } finally {
          store.loading = false
        }
      } while (refreshPending)
    } finally {
      refreshInFlight = null
    }
  })()
  refreshInFlight = run
  return run
}

/**
 * 打开侧栏归档列表视图（D10 入口钮：角标 count 0 隐藏，按钮恒可点）+ 拉取列表。
 */
function openArchiveView(): void {
  useArchiveStore().openView()
  void refreshArchives()
}

/** 返回侧栏会话列表（归档列表头返回钮）。 */
function closeArchiveView(): void {
  useArchiveStore().closeView()
}

/**
 * 点击归档行 → 主区呈现摘要视图（D11）：登记选中条目 + 导航到 view:'archive'。
 * 侧栏保持归档列表（主区/侧栏独立——用户可继续换条目预览）。
 */
function openSummary(archive: ArchiveSummary): void {
  useArchiveStore().selectArchive(archive)
  useNavigationStore().push({ view: 'archive' })
}

/** 主区摘要视图离开（view 切回 chat；选中条目清空防陈旧引用）。 */
function closeSummary(): void {
  useArchiveStore().selectArchive(null)
  useNavigationStore().push({ view: 'chat' })
}

/** 条目显示名（name 空串回退未命名占位，D3 合法形态）。 */
function displayName(archive: ArchiveSummary): string {
  return archive.name.length > 0 ? archive.name : t('archive.summary.unnamed')
}

/**
 * 恢复归档 session（D5 步骤 7 / D10 恢复钮）：解压回原路径原分组成功后——切回会话
 * 列表 + 主区回 chat + 归档列表刷新（该条目消失）+ 恢复高亮登记 + toast 确认。reply 的
 * SessionSummary 消费点（D5 步骤 7「前端高亮置顶」）：id 登记 restoredSessionId 驱动
 * 会话列表行 accent-soft 高亮渐隐（§5.1 恢复样例）；「原项目组顶部」构造性成立——
 * 恢复路径全量重写主文件使 mtime = 恢复时刻，列表序 = mtime 降序，无需前端重排。
 * 恢复的 session 回场会话列表由 runtime broadcastSessionList 广播回流（core
 * bindSessionListBroadcast 自动 applySnapshot——数据 owner 唯一写通道，本编排不旁路
 * 直呼 store mutation；重连对账兜底由 useSidebar.onConnected 既有链承担）。失败
 * toast 按 error envelope code 分流（§5.2 界面表现 + 恢复指引；未知码回退通用模板）。
 * 入口按 sessionId 防重入：在途期间同一行再次触发直接忽略（列表行钮同时禁用）。
 */
async function restoreArchive(archive: ArchiveSummary): Promise<void> {
  const { error: toastError, info: toastInfo } = useToast()
  const store = useArchiveStore()
  if (store.restoringSessionId === archive.sessionId) return
  store.restoringSessionId = archive.sessionId
  let restoredId: string
  try {
    restoredId = (await sessionApi.unarchive(archive.sessionId)).id
  } catch (e) {
    const key = archiveErrorKey('unarchive', e)
    toastError(t(key ?? 'archive.entry.restoreFailed', { msg: toErrorMessage(e) }))
    return
  } finally {
    store.restoringSessionId = null
  }
  store.markRestored(restoredId)
  store.closeView()
  store.selectArchive(null)
  useNavigationStore().push({ view: 'chat' })
  void refreshArchives()
  toastInfo(t('archive.entry.restoreSuccess', { name: displayName(archive) }))
}

/**
 * 彻底删除归档 session（D5 purgeArchive；归档列表悬停 danger 两段确认后）：成功刷新
 * 归档列表与角标；keep-all 保守分支（keptSubagentsDir 携带，D5 步骤 7）出声说明残留
 * 目录指引——失败显式上报，用户不以「成功 toast + 磁盘无提示残留」组合形态遭遇该分支。
 */
async function purgeArchiveEntry(archive: ArchiveSummary): Promise<void> {
  const { error: toastError, info: toastInfo, warning: toastWarning } = useToast()
  const store = useArchiveStore()
  if (store.purgingSessionId === archive.sessionId) return
  store.purgingSessionId = archive.sessionId
  let keptSubagentsDir: string | undefined
  try {
    const reply = await sessionApi.purgeArchive(archive.sessionId)
    keptSubagentsDir = reply.keptSubagentsDir
  } catch (e) {
    const key = archiveErrorKey('purge', e)
    toastError(t(key ?? 'archive.entry.purgeFailed', { msg: toErrorMessage(e) }))
    return
  } finally {
    store.purgingSessionId = null
  }
  // 主区正在呈现该条目时同步离开（列表行消失，摘要视图不留悬空引用）
  if (store.selected?.sessionId === archive.sessionId) {
    store.selectArchive(null)
    useNavigationStore().push({ view: 'chat' })
  }
  void refreshArchives()
  if (keptSubagentsDir) {
    toastWarning(t('archive.entry.purgeKeptSubagents', { name: displayName(archive), dir: keptSubagentsDir }))
  } else {
    toastInfo(t('archive.entry.purgeSuccess', { name: displayName(archive) }))
  }
}

/**
 * 归档域编排函数集（多调用点等价闭包——store 走 pinia 单例，无实例态）。
 * 消费点：Sidebar（侧栏视图切换 + 事件接线）、ArchiveMainView（主区恢复编排）。
 */
export function useArchiveView() {
  return {
    refreshArchives,
    openArchiveView,
    closeArchiveView,
    openSummary,
    closeSummary,
    restoreArchive,
    purgeArchiveEntry,
  }
}

/**
 * archiveCount 角标的广播订阅（config.sessions 帧携带值，D5 协议变更点）：
 * 模块级 refCount + onScopeDispose 订阅——范式对齐 core use-session.ts 的
 * bindSessionListBroadcast（同帧既有消费者）：首个实例注册、末个实例卸载退订，
 * 多实例共享同一监听；组件 setup 顶层同步绑定（订阅只是 handler 注册表写操作，
 * 不依赖 mounted 时序）。裸订阅配逐实例退订会在多实例挂载下提前删掉共享监听
 * （onGlobalType 底层 Set 对同一 handler 引用去重，首个实例退订即全删）。字段
 * 缺省（旧 runtime / mock 无归档数据）不覆盖现值；冷启动首帧前角标读初始 0 隐藏，
 * Sidebar 挂载时的 openArchiveView 首拉对账兜底。与 useSidebar 的 onConfigSessions
 * （core 列表应用通道，同款 refCount 防重复）职责正交：本订阅只读 archiveCount
 * 字段 + 承载压缩完成的顺带刷新（见 handleConfigSessionsFrame）。
 *
 * 压缩完成刷新（D11「后台任务完成事件刷新」/ §5.1「后台压缩完成后自动刷新」的
 * renderer 消费点）：runtime 压缩任务终态写入后广播 config.sessions 帧（帧内容不含
 * 归档列表数据——archiveCount 两态同计不变），本订阅收帧时归档视图（viewOpen）或
 * 摘要视图（selected）打开则顺带 refreshArchives 重拉 config.archives，「压缩中」
 * 标注与「摘要生成中」占位随之刷新。推管即时拉管正确（ADR-0097）：帧丢失或视图
 * 关闭时按既有拉取路径收敛，无轮询无补偿。
 */
let archiveCountSubCount = 0
let archiveCountUnsub: (() => void) | null = null

export function useArchiveCountBroadcast(): void {
  archiveCountSubCount += 1
  if (archiveCountSubCount === 1) {
    archiveCountUnsub = events.onGlobalType('config.sessions', handleConfigSessionsFrame)
  }
  onScopeDispose(() => {
    archiveCountSubCount = Math.max(0, archiveCountSubCount - 1)
    if (archiveCountSubCount === 0 && archiveCountUnsub) {
      archiveCountUnsub()
      archiveCountUnsub = null
    }
  })
}

/** 收帧处理（提取为模块函数供测试直调）：角标更新 + 视图打开时的归档列表顺带刷新。 */
function handleConfigSessionsFrame(msg: { payload: { archiveCount?: unknown } }): void {
  const count = msg.payload.archiveCount
  if (typeof count === 'number') useArchiveStore().setCount(count)
  const store = useArchiveStore()
  if (store.viewOpen || store.selected !== null) void refreshArchives()
}
