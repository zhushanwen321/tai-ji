/**
 * Search mock fixture —— 全局搜索浮层（⌘K）的预制数据。
 *
 * 数据源：移植自 SearchModal.vue 内联 MOCK/RECENTS/SUGGESTED。
 * 后端搜索（LSP / 命令注册表 / 会话库）就绪后接 real domain 替换。
 *
 * D-028 架构修复：SearchType/SearchItem 定义迁至 @/lib/search-types（领域 SSOT），
 * mock 反向 import（mock 依赖领域类型，方向正确）。
 */
// 相对路径直达定义处（new-task-search/types.ts）：经 '@taiji/core' barrel 回引会成环，ESM 序隐患
import type { SearchItem, SearchType } from '../../domain/new-task-search/types'
// re-export 保持 mock 内部消费方（mock/index.ts）无需改导入路径
export type { SearchItem, SearchType }

export const SEARCH_MOCK: Record<SearchType, SearchItem[]> = {
  command: [
    // 应用命令（commandKind='app'，走 action 执行）
    { type: 'command', title: '新建任务', sub: '创建一个新会话 · ⌘N', commandKind: 'app' },
    { type: 'command', title: '收起侧栏', sub: 'toggle sidebar · ⌘B', commandKind: 'app' },
    { type: 'command', title: '概览', sub: 'Mission Control', commandKind: 'app' },
    // slash 命令（commandKind='slash'，name 不带 / 前缀——对齐真实 pi get_commands 格式）。
    // icon 与 CommandPopover SLASH_ICON_COMPONENTS 同源。
    // E2E 前置：mock 模式需能搜到 slash 命令，否则无法验证「搜到→点击→注入 chip」链路。
    { type: 'command', title: 'commit', sub: '提交改动', icon: 'terminal', commandKind: 'slash' },
    { type: 'command', title: 'review', sub: '代码评审', icon: 'star', commandKind: 'slash' },
  ],
  file: [
    { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'auth/token.ts', sub: 'refactor-arch/src/auth' },
    { type: 'file', title: 'use-auth.ts', sub: 'refactor-arch/src/composables' },
    { type: 'file', title: 'session-store.ts', sub: 'refactor-arch/src/stores' },
    { type: 'file', title: 'Sidebar.vue', sub: 'refactor-arch/src/components/sidebar' },
  ],
  symbol: [
    { type: 'symbol', title: 'authenticate()', sub: 'auth/session.ts:42' },
    { type: 'symbol', title: 'AuthToken', sub: 'auth/token.ts:8' },
    { type: 'symbol', title: 'SessionStore', sub: 'session-store.ts:12' },
    { type: 'symbol', title: 'useAuth()', sub: 'use-auth.ts:4' },
  ],
  session: [
    { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main · 14:32' },
    { type: 'session', title: '搜索浮层设计', sub: 'refactor-arch · feat-search' },
    { type: 'session', title: 'Workspace 双 Panel', sub: 'agent-skeleton · main' },
    { type: 'session', title: 'git 工作流打磨', sub: 'feat-gitflow · dev' },
  ],
}

export const SEARCH_RECENTS: SearchItem[] = [
  { type: 'file', title: 'auth/session.ts', sub: 'refactor-arch/src/auth' },
  { type: 'session', title: 'Auth 重构 · token 轮转', sub: 'refactor-arch · main' },
  { type: 'command', title: '收起侧栏', sub: 'toggle sidebar · ⌘B' },
]

export const SEARCH_SUGGESTED_COUNT = 3
