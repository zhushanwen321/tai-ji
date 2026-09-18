/**
 * composer-keydown.ts —— Composer 键盘分发（complexity-debt U02，从 Composer.vue onKeydown 拆出）。
 *
 * 定位：纯 UI 事件分派器（无自有状态，全部依赖经 deps 只读注入）。拆分为文件级 composable
 * 而非 Composer.vue 同文件局部函数的原因：Composer.vue <script setup> 实测 285 行（口径 =
 * vue_rules_checker.py 计数：script 体行数，不含 <script setup>/</script> 两个标签行；
 * 含标签 287），距上限 MAX_SCRIPT_LINES=300 余 15 行，同文件提取余量有限。目录归属对齐
 * composer-shell.ts（同目录、文件名不带 use 前缀、导出函数带 use 前缀的既有约定）。
 *
 * ADR-0049 判定：不持有 per-session 状态（无按 sessionId 分区的 ref/Map/Set；sendRoute
 * 等「当前 session 的 X」由调用方以 computed 只读注入，本文件只消费不存储），
 * 纯事件分派 → 普通 composable，无需 useSessionScopedState 工厂。
 *
 * 分发语义（键位 → 行为，u5b D6 改造——路由判定收口在 core dispatch/send，本层只按
 * sendRoute 决定 Alt+⏎ 的 followUp 保留语义）：
 *   浮层 open → 浮层内部路由（handleKeydown 真值短路 return）
 *   IME 组合中 → 放行不拦截
 *   命令动作表（composer-shortcut-actions，composer-pi-shortcuts 设计）→ 四键位
 *     shift+tab / ctrl+p / ctrl+shift+p / ctrl+x：命中任一键位（含 no-op 行）即
 *     stopPropagation + preventDefault 拦截（决策 7：阻断 window 层 open-preset-select
 *     双触发；浮层 open 时动作表自身入口守卫跳过），未命中原样放行
 *   Esc → staging.handleEsc（fork/handoff 互斥路由，内部自管 preventDefault）
 *   裸 ↑/↓ → preventDefault → moveCaretVertical 垂直移光标；at-edge 时 ↑ 历史 / ↓ 历史
 *   修饰键 + ↑/↓ → 放行原生（选区扩展/按词移动/段首段尾跳转）
 *   ⇧⏎ → 放行原生换行
 *   ⏎（preventDefault 后）：staging 活跃 → onSend；Alt+⏎ → steer 路由行 onFollowUp /
 *   其余（defer/direct）onSend；裸 ⏎ → onSend（统一分发器：steer 路由并入当前回合 /
 *   defer 入队 / direct 直发——[HISTORICAL] isActive→onSteer 与 isCompacting→onSend
 *   两套分散判定（优先级倒挂根因）已退役）
 */
import type { ComputedRef, Ref } from 'vue'
import type { SendRoute } from '@taiji/core/domain/composer'
import type { ComposerShellReturn, ShellInputInstance } from './composer-shell'

/** CommandPopover expose 的键盘路由窄契约（结构兼容 InstanceType<typeof CommandPopover>） */
interface CommandPopoverHandle {
  handleKeydown: (e: KeyboardEvent) => boolean
}

/** Composer 键盘分发依赖（全部为组件/composable 已有状态的只读引用，不新增状态） */
export interface ComposerKeydownDeps {
  /** 命令浮层 open 态（useCommandPopoverTrigger 产物；open 时键盘优先路由进浮层） */
  cmdOpen: Readonly<Ref<boolean>>
  /** CommandPopover 实例 ref（浮层内部 ↑↓/⏎/Esc 路由入口） */
  commandPopoverRef: Readonly<Ref<CommandPopoverHandle | null>>
  /** ComposerInput 实例 ref（moveCaretVertical 垂直移光标消费） */
  inputRef: Readonly<Ref<ShellInputInstance | null>>
  /** staging 聚合路由（core dispatch/staging，ADR-0057）：Esc 路由 + activeStaging 守卫 */
  staging: Pick<ComposerShellReturn['staging'], 'handleEsc' | 'activeStaging'>
  /** 当前 session 的发送路由（D6 表 direct/steer/defer；Alt+⏎ steer 行保留 followUp 语义） */
  sendRoute: ComputedRef<SendRoute>
  /**
   * 命令动作表处理器（composer-shortcut-actions，composer-pi-shortcuts U1）：四键位命中
   * （含 no-op 行）返回 true = 已 stopPropagation + preventDefault；浮层 open 时其入口守卫
   * 自行跳过（§3.4 首行），本链只按返回真值短路
   */
  shortcutActions: (e: KeyboardEvent) => boolean
  /** ↑ 到顶 → 历史上一条（core input/history） */
  handleArrowUp: () => void
  /** ↓ 到底 → 历史下一条（core input/history） */
  handleArrowDown: () => void
  /** Alt+⏎：追加 follow-up（不打断当前回合；steer 路由行语义） */
  onFollowUp: () => void
  /** 发送 / staging 提交 / steer 路由并入 / defer 入队（core dispatch/send 统一入口） */
  onSend: () => void
}

/**
 * 裸 ↑/↓（无任何修饰键）导航：preventDefault 后先垂直移光标（多行输入内移动优先），
 * 光标已在边缘（at-edge）再翻历史。返回是否已消费该事件。
 */
function createBareArrowNav(
  inputRef: Readonly<Ref<ShellInputInstance | null>>,
  handleArrowUp: () => void,
  handleArrowDown: () => void,
): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent): boolean => {
    // shift/ctrl/alt/meta + 方向键是选区扩展/按词移动/段首段尾跳转，放行原生行为（不拦截）
    const bareArrow = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
    if (!(bareArrow && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) return false
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? 'up' : 'down'
    if (inputRef.value?.moveCaretVertical(dir) === 'moved') return true
    if (dir === 'up') handleArrowUp()
    else handleArrowDown()
    return true
  }
}

/**
 * ⏎ 落地分派（已 preventDefault）：staging（fork/handoff）优先于发送路由——模式 chip
 * 在时 Enter/Alt+Enter 均提交 staging，不注入当前对话（streaming 中 fork-ask 合法——对源
 * session 只读；handoff 的 streaming 拦截在 enterHandoffMode 入口 + handleHandoffSend 兑底，
 * 此处无需区分）。Alt+⏎ 按 D6 路由行分流：steer 行（turn 活跃）保留 followUp 下一轮语义
 * （现状 isActive→onFollowUp 等价）；defer/direct 行经分发器（[u5b] 原 isCompacting→onSend
 * 特判由 defer 路由自然覆盖）。裸 ⏎ 统一 onSend（steer 路由并入当前回合 / defer 入队 /
 * direct 直发——优先级倒挂消除：turn 活跃 + compacting（行 3）按 D6 表走 steer 而非误排队）。
 */
function createEnterDispatcher(
  staging: Pick<ComposerShellReturn['staging'], 'activeStaging'>,
  sendRoute: ComputedRef<SendRoute>,
  onFollowUp: () => void,
  onSend: () => void,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    if (staging.activeStaging.value) {
      onSend()
      return
    }
    if (e.altKey) {
      if (sendRoute.value === 'steer') onFollowUp()
      else onSend()
    } else {
      onSend()
    }
  }
}

/**
 * 构建 Composer 键盘分发器（ComposerInput @keydown 绑定消费）。
 * 处理顺序：浮层路由 → IME 守卫 → 命令动作表 → staging Esc → 裸箭头导航 → Enter 分派；
 * 落空放行原生。动作表插在 IME 之后（IME 组合中的按键绝不触发动作）、staging Esc 之前
 * （动作表只判定自己的 4 键，与 Esc 无交集，无顺序耦合——composer-pi-shortcuts §3.4）。
 */
export function useComposerKeydown(deps: ComposerKeydownDeps): (e: KeyboardEvent) => void {
  const {
    cmdOpen,
    commandPopoverRef,
    inputRef,
    staging,
    sendRoute,
    shortcutActions,
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
  } = deps
  const handleBareArrowNav = createBareArrowNav(inputRef, handleArrowUp, handleArrowDown)
  const dispatchEnter = createEnterDispatcher(staging, sendRoute, onFollowUp, onSend)
  return function onKeydown(e: KeyboardEvent): void {
    if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
    if (e.isComposing) return // IME 组合中不拦截（与 useContenteditableInput 守卫一致）
    // 命令动作表（composer-pi-shortcuts）：命中四键位（含 no-op 行）即拦截短路
    if (shortcutActions(e)) return
    // Staging Esc 路由：经 staging.handleEsc → activeStaging.handleEsc（fork/handoff 互斥下不会同时活跃）
    if (staging.handleEsc(e)) return
    if (handleBareArrowNav(e)) return
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    dispatchEnter(e)
  }
}
