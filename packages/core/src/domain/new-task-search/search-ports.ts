/**
 * SearchPorts —— search 编排跨域端口集（IF6，C-W3-1 细粒度端口先例）。
 *
 * 端口注入模式（对齐 w2 NewTaskFlowDeps 先例）：core 定义接口契约，壳层（renderer）
 * 把现 api/stores/composables 适配注入。core 不 import @/api / @/stores / @/composables /
 * @/i18n（D4 包级单向铁律 + TC1）。D8 平台访问（navigator.platform / localStorage）全部收编端口。
 *
 * 裁决标注：
 * - C-W3-1：细粒度端口接口（SearchDataPort/FileReadPort/FileCandidatesPort/SessionListPort/
 *   SessionSelectPort/AppCommandActionsPort）+ SearchPorts 聚合（IF6 契约）。
 * - C-W3-2：SessionSelectPort 契约在本域定义，接收点归实现域（壳适配 useSidebar().selectSession），
 *   不依赖 domain/session selectSession 就绪。
 * - C-W3-3：FileChangeWatchPort（stale cache 防护端口化）已随 fileSearchStore 缓存退役
 *   整体删除（缓存治理 U1 1-3）——缓存不存在则失效编排失去对象。
 * - C-W3-4：recents localStorage → storage 端口（KVStorage async）。
 * - C-W3-5：AppCommandActionsPort 三项 action 全注入 + isMac 平台标志注入（D8 收编）。
 */
import type { ArchiveSummary, FileNode, SessionGroup } from '@taiji/shared'
import type { KVStorage } from '../../platform/port'
import type { TranslatePort } from './ports'
import type { FileTreePort } from './ports'
import type { Section } from './types'
import type { createCommandStore } from './command-store'

/**
 * mock 搜索 fixture 端口（AC-5.2 mock 层）。
 * 壳适配 renderer api/mock search.query（VITE_MOCK=true 时走 fixture）。
 * 返回 Section[] 形态（{label, items}，与 真实进程层 groupByType 对齐 D-001）。
 */
export interface SearchDataPort {
  searchMock(query: string): Promise<Section[]>
}

/**
 * file 读取端口（AC-6.9 关键约束：直调 fileApi.read 校验，不经 useDetailPane 预览吞错层）。
 * 壳适配 renderer api/domains/file read（path, sessionId?）。
 * 返回 void：reject 即文件不可读（read 失败真冒泡，跳转编排层 catch）。
 */
export interface FileReadPort {
  read(path: string, sessionId?: string): Promise<void>
}

/**
 * composer `#` 文件候选端口（AC-4.5：缓存未命中直调，不经壳层 useFileSearch.load 吞错层）。
 * 壳适配 renderer api/domains/composer getFileCandidates。
 */
export interface FileCandidatesPort {
  getFileCandidates(sessionId: string): Promise<FileNode[]>
}

/**
 * session 列表端口（session 跳转 id 反查用——SearchItem 无 id 字段，DTO 映射时丢失）。
 * 壳适配 renderer api/domains/session list（SessionApiPort.list）。
 */
export interface SessionListPort {
  list(): Promise<SessionGroup[]>
}

/**
 * session 跳转端口（AC-6.6：switchSession reject 由编排层 catch → {ok:false}）。
 * 壳适配 renderer useSidebar().selectSession（C-W3-2 端口契约，接收点归实现域）。
 */
export interface SessionSelectPort {
  selectSession(id: string): Promise<void>
}

/**
 * 归档列表端口（归档搜索源）：壳适配 renderer api/domains/session listArchives
 * （config.archives RPC——簿记扫描派生，D9 不变量 3）。搜索打开时按需拉取（拉为主，
 * ADR-0097），不常驻。
 */
export interface ArchiveListPort {
  listArchives(): Promise<ArchiveSummary[]>
}

/**
 * 归档跳转端口（选中归档项 → 主区摘要视图）：壳适配 renderer
 * useArchiveView().openSummary（selectArchive + navigation.push({view:'archive'})，
 * 与归档列表行点击同路径）。core 不 import renderer（D4 铁律），经端口注入。
 */
export interface ArchiveJumpPort {
  openArchive(archive: ArchiveSummary): void
}

/**
 * 应用命令 actions 端口（C-W3-5 三项全注入，打破循环 import 先例）。
 * 壳适配 renderer useSidebar/useSidebar initApp 注入：
 * - newSession：useSidebar().newSession（新建任务）
 * - toggleSidebar：useSidebarStore().toggleCollapsed（原 useAppCommands 直调，收编端口）
 * - requestPresetOpen：usePresetStore().requestOpen（原 useAppCommands 直调，收编端口）
 */
export interface AppCommandActionsPort {
  newSession(): void
  toggleSidebar(): void
  requestPresetOpen(): void
}

/**
 * search 编排端口聚合（IF6 SearchPorts 契约）。
 * SearchDeps.ports 的类型别名——细粒度接口组合，消费方（useSearch/useSearchJump）按需取用。
 */
export interface SearchPorts {
  /** mock 层标志（壳适配 import.meta.env.VITE_MOCK === 'true'；AC-5.2） */
  isMock: boolean
  /** macOS 平台标志（壳适配 navigator.platform.includes('Mac')；D8 收编，C-W3-5） */
  isMac: boolean
  /** mock 搜索 fixture（isMock=true 时 query 走此源）。[tc u3/D4-②] 可选——real 构建下壳不装配
   *  （mock 模块链须可 DCE，无条件属性引用会把它拽进生产包）；isMock=true 缺失时 search.query 显式抛错 */
  searchMock?: SearchDataPort['searchMock']
  /** file 直调读取（AC-6.9 不经吞错层） */
  fileRead: FileReadPort['read']
  /** composer 文件候选（AC-4.5） */
  fileCandidates: FileCandidatesPort['getFileCandidates']
  /** session 列表（id 反查） */
  sessionList: SessionListPort['list']
  /** session 跳转（AC-6.6） */
  selectSession: SessionSelectPort['selectSession']
  /** 归档列表（归档搜索源，按需拉取） */
  archiveList: ArchiveListPort['listArchives']
  /** 归档跳转（选中归档项 → 主区摘要视图） */
  archiveJump: ArchiveJumpPort['openArchive']
  /** 域内文案（壳适配 renderer i18n.global.t） */
  t: TranslatePort['t']
}

/**
 * search 编排全部注入依赖（IF6 deps）。
 * 端口 + store 实例 + 持久化存储 + 应用命令 actions。
 * 壳（w5）组装：createCommandStore(getPlatform().storage) /
 * getPlatform().storage / useSidebar 适配 actions。
 */
export interface SearchDeps {
  ports: SearchPorts
  /** command store 实例（createCommandStore 产物；slash 命令分区 + appCommands + pendingSlash） */
  commandStore: ReturnType<typeof createCommandStore>
  /** recents 持久化存储（KVStorage；壳适配 getPlatform().storage，D8） */
  storage: KVStorage
  /** file tree 端口（file 跳转 selectFile；壳适配 fileTreeStore.selectFile，C-NT-3） */
  fileTree: FileTreePort
  /** 应用命令 actions（壳适配 useSidebar/useSidebarStore/usePresetStore，C-W3-5） */
  appCommandActions: AppCommandActionsPort
}
