/**
 * useSearchModalDeps —— SearchDeps 壳组装（new-task-search 域 w5）。
 *
 * ui 包 SearchModal（w4 迁入）经 props.deps 消费 search 编排依赖（SearchDeps）。
 * 本 composable 把 renderer 真实现适配组装：
 * - ports 7 项：isMock（VITE_MOCK）/ isMac（navigator.platform，D8 收编）/ searchMock
 *   （mockApi.search.query）/ fileRead（@/api 门面 file.read，mock/real 构建期切换；AC-6.9 不经吞错层）/
 *   fileCandidates（api/domains/composer.getFileCandidates）/ sessionList（api/domains/session.list）/
 *   selectSession（壳传入 useSidebar().selectSession，C-W3-2）/ watchFileChanges
 *   （useFileChangeInvalidation.watchFileChangesForInvalidation，C-W3-3）/ t（i18n）
 * - commandStore：壳单例 useCommandStore()（core createCommandStore 实例，须在
 *   providePlatform 之后——AppShell 时序保证）
 * - fileSearchStore：壳单例 useFileSearchStore()（core createFileSearchStore 实例，
 *   D7 收口后与 CommandPopover 侧 useFileSearch/useSearch 共享同一缓存）
 * - storage：getPlatform().storage（recents 持久化，C-W3-4）
 * - fileTree：fileTreeStore.selectFile + useFileTree().loadTree（FileTreePort）
 * - appCommandActions：newSession/goOverview（壳传入）+ toggleSidebar（useSidebarStore）
 *   + requestPresetOpen（usePresetStore）（C-W3-5）
 *
 * 参数注入（与 useAppCommands 的 actions 注入破环同模式）：selectSession/newSession/
 * goOverview 是 useSidebar 实例方法（Sidebar 已实例化），由调用方传入避免重复实例化。
 */
import { ref } from 'vue'
import { getPlatform } from '@taiji/core'
import type { SearchDeps } from '@taiji/core'
import * as composerApi from '@taiji/core/transport/api/domains/composer'
import * as sessionApi from '@taiji/core/transport/api/domains/session'
import * as mockApi from '@taiji/core/transport/mock'
// SM-E2E-6：fileRead 必须经 @/api 门面（isMock 切换 mockApi.file / realFile）——直引 core real 域
// 会绕过 mock 切换，mock 轨 file.read RPC 无 handler 挂 65s backstop，confirm 永不完成
import { file } from '@/api'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useFileSearchStore } from '@/composables/features/search/useFileSearchStore'
import { useFileTree } from '@/composables/features/file-tree/useFileTree'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSidebarStore } from '@/stores/sidebar'
import { usePresetStore } from '@/stores/preset'
import { watchFileChangesForInvalidation } from '@/composables/features/file-tree/useFileChangeInvalidation'
import i18n from '@/i18n'

export interface SearchModalShellDeps {
  selectSession: (id: string) => Promise<void>
  newSession: () => void
  goOverview: () => void
}

export function useSearchModalDeps(shell: SearchModalShellDeps): SearchDeps {
  const commandStore = useCommandStore()
  const fileSearchStore = useFileSearchStore()
  const sidebarStore = useSidebarStore()
  const presetStore = usePresetStore()
  const fileTreeStore = useFileTreeStore()

  // [tc-transport-consolidation D4-②] isMock 构建期常量：searchMock 引用点整体条件化——
  // 生产构建（VITE_MOCK 非 true）下 mockApi.search 属性引用随死分支 DCE，mock 模块链
  // 摇除（A7 探针门）；mock 构建下注入 core mock fixture（SearchPorts.searchMock 可选）。
  const isMock = import.meta.env.VITE_MOCK === 'true'

  return {
    ports: {
      isMock,
      isMac: navigator.platform.includes('Mac'),
      searchMock: isMock ? mockApi.search.query : undefined,
      fileRead: (path, sessionId) => file.read(path, sessionId).then(() => {}),
      fileCandidates: composerApi.getFileCandidates,
      sessionList: sessionApi.list,
      // C-W3-2：SessionSelectPort 接收点归实现域（useSidebar().selectSession）
      selectSession: shell.selectSession,
      // C-W3-3：FileChangeWatchPort 替代 chatStore.messages watch（stale cache 防护；
      // W19/D-9 后 helper 内部为 ready 帧驱动——ready 清单到达时回调）
      watchFileChanges: (sid, cb) =>
        watchFileChangesForInvalidation(ref(sid), (s) => cb(s)),
      t: i18n.global.t,
    },
    commandStore,
    fileSearchStore,
    storage: getPlatform().storage,
    fileTree: {
      loadTree: (sid) => useFileTree().loadTree(sid),
      selectFile: (path) => fileTreeStore.selectFile(path),
    },
    appCommandActions: {
      newSession: shell.newSession,
      goOverview: shell.goOverview,
      toggleSidebar: () => sidebarStore.toggleCollapsed(),
      requestPresetOpen: () => presetStore.requestOpen(),
    },
  }
}
