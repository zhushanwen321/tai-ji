/**
 * useGlobalShortcuts —— Sidebar 全局快捷键派发（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：window keydown 监听 → keymap 数组遍历匹配 → 派发 action。
 * 支持 commandStore.shortcutOverrides 用户自定义覆盖（设置页可重录）。
 *
 * #10.1 AC-10.1：消除硬编码 if/else，改 keymap 数组遍历匹配。
 *
 * 依赖注入说明：onNewSession / fork / handoff 方法由调用方注入——useSidebar 非单例
 * （每次调用 createSessionStore + createUseSession 新建实例 + onScopeDispose），不能在本
 * composable 内重复调用，否则产生独立 sessionStore 导致状态分裂。故 Sidebar.vue 调一次
 * useSidebar 后注入此处。useSearchModal/useSidebarStore/useCommandStore/usePresetStore
 * 均为模块级单例，内部安全调用。
 */
import { useEventListener } from '@vueuse/core'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useNavigationStore } from '@/stores/navigation'
import { usePresetStore } from '@/stores/preset'
import { useSearchModal } from '@taiji/core'
import { useSidebarStore } from '@/stores/sidebar'

/** 全局快捷键派发所需的注入方法（来自 useSidebar / session actions composable） */
export interface UseGlobalShortcutsOptions {
  /** ⌘N 新建 session（来自 session actions composable 的 onNewSession） */
  onNewSession: () => void
  /**
   * ⌘I 打开「导入会话」对话框（import-session u6）。可选：Sidebar.vue 注入
   * （open 状态由其持有），既有调用方（测试）不注入时不注册副作用之外的破坏。
   */
  onOpenImportSession?: () => void
  /** ⌘G 从末条 assistant 后台 fork（来自 useSidebar） */
  forkFromLastAssistant: () => void | Promise<void>
  /** ⌘⇧G 进 composer fork 模式（来自 useSidebar） */
  enterForkModeFromLastAssistant: () => void | Promise<void>
  /** ⌘J 从末条 assistant 打包文档到新 session（来自 useSidebar） */
  handoffFromLastAssistant: () => void | Promise<void>
  /** ⌘[ ⌘] 导航历史（来自 useNavigationStore，Sidebar.vue 注入） */
  navigation: ReturnType<typeof useNavigationStore>
  /** ⌘, 打开 Settings（AppShell provide，Sidebar.vue inject 后注入） */
  openSettings: () => void
}

interface KeymapEntry {
  /** 默认 key（无 override 时用 ⌘+key 匹配） */
  key: string
  /** commandStore.shortcutOverrides 中的 id（有 override 时走 matchOverrideKey） */
  commandId?: string
  /** 要求 shift 修饰键（⌘⇧G 进 fork 模式 vs ⌘G 后台 fork；无此字段则要求不带 shift） */
  shift?: boolean
  /** composer 聚焦时禁用（fork/handoff 条目——与 composer 输入语义冲突；其余条目不受影响） */
  guardComposerFocus?: boolean
  action: () => void
}

/**
 * 启动 Sidebar 全局快捷键派发（window keydown 监听）。
 *
 * - ⌘K toggle 搜索浮层（AC-7.1 变更项：再按关闭，原 =true 改 !searchOpen）
 * - ⌘N 新建 session（shell spec §五）
 * - ⌘I 打开「导入会话」对话框（import-session 设计 §1 In-scope 入口）
 * - ⌘B 折叠侧栏（shell spec §⌘B；v1 只做 toggle 前两态，G-033 第 3 态 DEFERRED）
 * - ⌘⇧P 打开启动预设选择 Popover
 * - ⌘G / ⌘⇧G fork
 * - ⌘J fast-handoff
 *
 * ⌘K 不注册为 appCommand（搜索结果里出现「搜索」命令是逻辑自指），始终硬编码。
 * ⌘N/⌘B/⌘⇧P 支持用户自定义覆盖（commandStore.shortcutOverrides），SystemPage 设置页可重录。
 *
 * 在 setup 顶层同步调用：useEventListener 需在活跃 effect scope 内绑定，组件卸载时自动解绑。
 */
export function useGlobalShortcuts(options: UseGlobalShortcutsOptions): void {
  const { onNewSession, onOpenImportSession = () => {}, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant, navigation, openSettings } = options
  const searchModal = useSearchModal()
  const sidebar = useSidebarStore()
  const commandStore = useCommandStore()

  const keymap: KeymapEntry[] = [
    { key: 'k', action: () => { searchModal.toggle() } },
    { key: 'n', commandId: 'new-session', action: () => { void onNewSession() } },
    // ⌘I 打开「导入会话」对话框（import-session 设计 §1 In-scope 入口；对话框 open 状态
    // 由 Sidebar.vue 持有，经 onOpenImportSession 注入回调派发）。硬编码快捷键、不挂
    // commandId——useAppCommands 未注册 import-session 命令，shortcutOverrides 不适用
    //（同 ⌘G/⌘J/⌘[ 家族）。
    { key: 'i', action: () => { onOpenImportSession() } },
    { key: 'b', commandId: 'toggle-sidebar', action: () => { sidebar.toggleCollapsed() } },
    // FR-16：⌘⇧P 打开启动预设选择 Popover（与 useAppCommands 注册的 open-preset-select 同源）。
    // commandId 让 shortcutOverrides 生效（设置页可重录）；shift 守卫确保仅 ⌘⇧P 触发，避免 ⌘P 误命中。
    // 默认无 override 时走 fallback：mod + 'p' + shift；fallback 的默认 shortcut 在 useAppCommands 声明为 'shift+p'。
    { key: 'p', shift: true, commandId: 'open-preset-select', action: () => { usePresetStore().requestOpen() } },
    // FR-16 fork 快捷键：⌘G 从末条 assistant 后台 fork（留在原线）；⌘⇧G 进 composer fork 模式。
    // shift 守卫（keydown handler 内）区分同 key 的 shift/非 shift 项，避免 ⌘G 误命中 ⌘⇧G。
    // 每条 entry 形如 { key: 'g'…}：'g' 后 shift 字段决定修饰要求。
    { key: 'g', guardComposerFocus: true, action: () => { void forkFromLastAssistant() } },
    { key: 'g', shift: true, guardComposerFocus: true, action: () => { void enterForkModeFromLastAssistant() } },
    // fast-handoff 快捷键：⌘J 从末条 assistant 打包文档到新 session（完成后跳转新 session）。
    // 用 ⌘J 而非 ⌘H：macOS 系统保留 ⌘H 为「Hide Application」，OS 先拦截 renderer 拦不住。
    { key: 'j', guardComposerFocus: true, action: () => { void handoffFromLastAssistant() } },
    // ⌘[ / ⌘] 导航历史（shell spec §八.5 G3-003，从 AppShell 归位收尾 9）。
    // canBack/canForward 为 false 时静默不触发（AppShell 原语义保留）；不挂 commandId（导航系统键）。
    { key: '[', action: () => { if (navigation.canBack) navigation.back() } },
    { key: ']', action: () => { if (navigation.canForward) navigation.forward() } },
    // ⌘, 打开 Settings（settings/spec.md §1，从 AppShell 归位收尾 9）。
    { key: ',', action: () => { openSettings() } },
  ]
  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    const overrides = commandStore.shortcutOverrides.value
    const hit = keymap.find((m) => {
      // composer 聚焦时仅禁用 fork/handoff 条目（guardComposerFocus，避免与 composer 输入冲突）；
      // ⌘K/⌘N/⌘B/⌘⇧P/⌘[/⌘]/⌘, 在 composer 聚焦时保持可用。
      // 检测：activeElement 落在 composer-box（contenteditable 输入区）内。
      if (m.guardComposerFocus && isComposerFocused()) return false
      // 有 override → 解析组合键格式（'mod+n' / 'shift+j' / 'j'）
      if (m.commandId && overrides[m.commandId]) {
        return matchOverrideKey(e, overrides[m.commandId])
      }
      // 默认：⌘/Ctrl + key，shift 守卫区分同 key 的 shift/非 shift 项
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return false
      if (e.key.toLowerCase() !== m.key) return false
      // shift 项要求 e.shiftKey；非 shift 项要求 !e.shiftKey（否则 ⌘G 和 ⌘⇧G 都命中 ⌘G）
      return m.shift ? e.shiftKey : !e.shiftKey
    })
    if (hit) {
      e.preventDefault()
      // stopImmediatePropagation：避免多 Sidebar 实例（测试 mount 未 unmount 堆积 / HMR 残留）
      // 各自注册的 window keydown 监听器对同一事件重复派发。首个命中的实例处理后阻止后续实例，
      // 保证一次按键只触发一次 action（与生产单实例行为一致）。
      e.stopImmediatePropagation()
      hit.action()
    }
  })
}

/**
 * composer 是否聚焦（全局快捷键守卫用）：activeElement 落在 composer-box 内即为聚焦。
 * composer-box 是 contenteditable 输入区（ComposerInput 根元素带 composer-box class + data-testid），
 * 用户在其中键入时 activeElement 是它或其后代；此时 ⌘G/⌘⇧G 不应触发 fork（与输入语义冲突）。
 */
function isComposerFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  return !!el.closest('.composer-box, [data-testid="composer-box"]')
}

/** 匹配自定义快捷键格式（'mod+n' / 'shift+j' / 'j' / 'alt+x' 等） */
function matchOverrideKey(e: KeyboardEvent, override: string): boolean {
  const parts = override.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needMod = parts.includes('mod')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  if (needMod && !(e.metaKey || e.ctrlKey)) return false
  if (needShift && !e.shiftKey) return false
  if (needAlt && !e.altKey) return false
  return e.key.toLowerCase() === key
}
