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
 *
 * view 转发键清单（display-containers §7.4 [MANDATORY]，renderer 半边，F1-17 补齐）：
 * 本装配点同时承担三件事——
 * ① 上报：启动初始化（含 renderer 重载/崩溃恢复后启动的同一入口）经 browserSetForwardKeys
 *   全量重报（keymap+shortcutOverrides 派生的 mod 前缀清单）；settings 重录（overrides
 *   变化）经 browserUpdateForwardKeys 注册/注销增量（注销旧 accelerator + 注册新）。
 * ② 派发：订阅 onBrowserForwardKey，主进程命中清单转发回的 accelerator 按同一 keymap
 *   派发动作——页面聚焦态宿主 window keydown 收不到输入，此通道是 app 快捷键族在
 *   WebContentsView 焦点下恒生效的唯一通路（容器键 ⌃`/⌘W 走 onShortcut 通道，不在此）。
 * ③ 判定同源：入清单约束/匹配语义与主进程 gateway/forward-keys.ts 配对契约同判定
 *   （渲染侧不可跨层 import 主进程模块，此处为镜像实现，键矩阵测试两侧对账）。
 *   guardComposerFocus 不用于转发派发：转发事件蕴含焦点在 WebContentsView，宿主 composer
 *   必然不在输入态（守卫针对的冲突场景不存在）。
 */
import { onScopeDispose, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useNavigationStore } from '@/stores/navigation'
import { usePresetStore } from '@/stores/preset'
import { useSearchModal } from '@taiji/core'
import { useSidebarStore } from '@/stores/sidebar'
import { browserSetForwardKeys, browserUpdateForwardKeys, onBrowserForwardKey } from '@/lib/ipc'

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

/** 键盘事件判定所需子集（KeyboardEvent 与转发测试桩共用形状） */
export interface ShortcutInput { // oe-exempt:20261003:framework:类型契约先行——键盘编排契约层，键矩阵测试即消费面
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
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
      return matchKeymapEntry(e, m, overrides)
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

  // ── view 转发键清单（§7.4 renderer 半边）──────────────────────────────
  // ① 启动初始化全量重报（renderer 重载/崩溃恢复后启动重跑本装配点 = 同一入口重报）。
  const forwardList = deriveForwardAccelerators(keymap, commandStore.shortcutOverrides.value)
  void browserSetForwardKeys(forwardList)
  // ② settings 重录（overrides 运行时可变）→ 注册/注销增量重报（注销旧 accelerator + 注册新；
  //    主进程 registry 幂等可乱序补报，丢失面由下次全量重报收敛——AGENTS 拉推分工的 push 臂）。
  let prevForwardList = forwardList
  const stopOverridesWatch = watch(
    () => deriveForwardAccelerators(keymap, commandStore.shortcutOverrides.value),
    (next) => {
      const remove = prevForwardList.filter((k) => !next.includes(k))
      const add = next.filter((k) => !prevForwardList.includes(k))
      prevForwardList = next
      if (add.length > 0 || remove.length > 0) void browserUpdateForwardKeys({ add, remove })
    },
  )
  // ③ 转发派发：主进程命中清单键 preventDefault 后经 'shortcut:forward' 转回，按同一 keymap
  //    派发（无 guardComposerFocus——转发事件蕴含焦点在 WebContentsView，composer 非输入态）。
  const unsubscribeForward = onBrowserForwardKey(({ accelerator }) => {
    const overrides = commandStore.shortcutOverrides.value
    const hit = keymap.find((m) => forwardedAcceleratorHits(accelerator, m, overrides))
    if (hit) hit.action()
  })
  onScopeDispose(() => {
    stopOverridesWatch()
    unsubscribeForward()
  })
}

/**
 * 单条 keymap entry 匹配（window keydown 路径，§7.4 配对契约 renderer 侧判定源）：
 * 有 override → matchOverrideKey（'mod+n' / 'shift+j' / 'j' / 'alt+x' 格式）；
 * 无 override → 默认 ⌘/Ctrl + key，shift 严格双分（shift 项要求 e.shiftKey、非 shift 项
 * 要求 !e.shiftKey——⌘G 与 ⌘⇧G 是不同键）。导出供键矩阵测试对账（配对契约判定源）。
 */
export function matchKeymapEntry(e: ShortcutInput, m: Pick<KeymapEntry, 'key' | 'shift' | 'commandId'>, overrides: Record<string, string>): boolean {
  if (m.commandId && overrides[m.commandId]) {
    return matchOverrideKey(e, overrides[m.commandId])
  }
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return false
  if (e.key.toLowerCase() !== m.key) return false
  return m.shift ? !!e.shiftKey : !e.shiftKey
}

/** 修饰符 token（不是键，入清单判定用——与主进程 MODIFIER_TOKENS 同词表） */
const FORWARD_MODIFIER_TOKENS = new Set(['mod', 'shift', 'alt', 'ctrl', 'control', 'meta', 'command', 'cmd', 'option'])

/**
 * 入清单约束（§7.4 [MANDATORY]）：仅 mod 前缀组合（mod=meta||ctrl，可带 shift）；
 * 裸键 / shift-only / alt 组合 / Esc / 畸形格式一律不入。与主进程 gateway/forward-keys.ts
 * parseForwardAccelerator 同判定（镜像实现，键矩阵测试两侧对账——F1-18 已知不对称在
 * matchOverrideKey 侧，不在本判定：入清单两侧均严格拒绝）。
 */
export function isForwardableAccelerator(accelerator: string): boolean {
  if (typeof accelerator !== 'string') return false
  const parts = accelerator
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const key = parts.pop()
  if (key === undefined || parts.length === 0) return false // 裸键不入清单
  if (key === 'escape') return false // Esc 不入清单（页面所有权，§6.7 第 4 层）
  if (FORWARD_MODIFIER_TOKENS.has(key)) return false
  if (!parts.includes('mod')) return false // shift-only / alt-only / 无前缀不入
  if (parts.includes('alt')) return false
  if (parts.some((m) => m !== 'mod' && m !== 'shift')) return false
  return true
}

/** 单条 entry 的生效 accelerator（override 优先；无 override 用默认 mod 组合，shift 项带 shift） */
export function effectiveAcceleratorOf(m: KeymapEntry, overrides: Record<string, string>): string {
  if (m.commandId && overrides[m.commandId]) return overrides[m.commandId].trim().toLowerCase()
  return m.shift ? `mod+shift+${m.key}` : `mod+${m.key}`
}

/**
 * 由 keymap + overrides 派生转发键清单（mod 前缀组合，去重保序）：不可转发项（裸键/
 * shift-only/alt/Esc override）不入清单——该类 override 在页面聚焦态不生效，§7.4 登记为已知边界。
 */
export function deriveForwardAccelerators(keymap: KeymapEntry[], overrides: Record<string, string>): string[] {
  const out: string[] = []
  for (const m of keymap) {
    const acc = effectiveAcceleratorOf(m, overrides)
    if (!isForwardableAccelerator(acc)) continue
    if (!out.includes(acc)) out.push(acc)
  }
  return out
}

/** 转发回的 accelerator 是否命中该 entry（归一化字符串等值——两侧清单同源派生） */
function forwardedAcceleratorHits(accelerator: string, m: KeymapEntry, overrides: Record<string, string>): boolean {
  return effectiveAcceleratorOf(m, overrides) === accelerator.trim().toLowerCase()
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

/** 匹配自定义快捷键格式（'mod+n' / 'shift+j' / 'j' / 'alt+x' 等）。
 *  已知不对称（F1-18 登记为已知边界）：对未声明修饰键不拒绝——'mod+n' override 在 ⌥⌘N 下
 *  也命中；主进程转发侧严格拒绝 alt，严格侧只会少转发不会误转发。 */
function matchOverrideKey(e: ShortcutInput, override: string): boolean {
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
