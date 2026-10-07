/**
 * 键盘栈序编排器（display-containers §6.7/§7.5 唯一属主）——Esc / ⌘W / ⌃` / Ctrl+F 的判定单源。
 *
 * 职责：
 * - **Esc**（window keydown **bubble**，AppShell 根 setup 首位注册）：isComposing 前置守卫
 *   → defaultPrevented 先检（先行档局部消费方已消费则不动作）→ 模态表面聚合让位（yieldsEsc
 *   成员开 ⇒ 不动作，Esc 先服务视觉最外层的模态/弹层）→ 层级序剥层（stack-order）。
 *   **禁 capture 监听**（§6.7 第 3 层）：xterm 对 Escape 走 cancel(force)=preventDefault +
 *   stopPropagation，bubble 天然让位给终端输入；capture 会在 xterm 之前抢走 Esc。
 * - **⌘W**（主进程 before-input-event → 'shortcut' type='close' 转发，useCloseShortcut 桥）：
 *   isImeComposing 守卫 → yields⌘W 聚合让位（模态族让位、弹出层族不让——R4 双键拆分）→
 *   同一层级序逐层关，全关后调 windowClose 关窗（before-input-event 已吞默认关窗行为）。
 * - **⌃`**（主进程 before-input-event 窗口级 → 'shortcut' type='toggle-bottom-drawer'）：
 *   isImeComposing 守卫 → toggleBottomDrawer()（浮层开着照常切换——§5.1 规则 3）。
 * - **Ctrl/Cmd+F**（find-in-surface）：isComposing 守卫 → defaultPrevented 先检 →
 *   useFindInSurface.openFindAtPointer()（悬停归属优先 → 回退栈序 → 全无不动作）。
 *   Esc 分支内含「查找框开着 → 先关查找框」层（临时覆盖层先于容器剥层）。
 * - **Tab 焦点陷阱**（浮层分支）：浮层开着时 Tab 首末循环（§7.3 随迁保位，W2 随 OverlayShell
 *   归位）；面板 ref 经 overlay 宿主注入（overlay-focus-trap）。**Tab 属主 = 最上层表面**
 *   （2026-10-03 用户裁决）：模态/弹层叠在浮层上时 Tab 归该模态焦点域——先行档已消费
 *   （defaultPrevented）+ 聚合让位（anyModalSurfaceYieldsEsc，与 Esc 分支同源）双检后陷阱
 *   不动作，不把焦点拉回浮层面板。
 *
 * 让位数据源 = 模态表面聚合（modal-surface-registry，u-w1-agg）：动作时刻直读，注册方
 * 无权自带旗标；注册序前提 = 本监听在 AppShell 根 setup 首位注册（FIFO 同相位先于任何
 * 弹层挂载的监听——§6.7 R4 时序前提）。
 */
import { onScopeDispose } from 'vue'
import { getOverlayControlState } from '@taiji/core/domain/overlay'
import { getBottomDrawerControlState, toggleBottomDrawer } from '@taiji/core/domain/bottom-drawer'
import { anyModalSurfaceYieldsCmdW, anyModalSurfaceYieldsEsc } from '../modal-surface-registry'
import { windowClose } from '@/lib/ipc'
import { focusComposer } from './focus-composer'
import { isImeComposing, startImeCompositionTracking } from './ime-composition'
import { trapTabIntoOverlayPanel } from './overlay-focus-trap'
import { closeTopContainer } from './stack-order'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'

/**
 * §6.7 模态共存守卫（Esc / Tab 双检同源）：先行档消费方（capture/document/元素级）已消费
 * （defaultPrevented）或聚合让位族（yieldsEsc）任一成员开着 → 不动作（先服务视觉最外层）。
 */
function modalSurfaceBlocksEvent(e: KeyboardEvent): boolean {
  return e.defaultPrevented || anyModalSurfaceYieldsEsc()
}

/**
 * 表面内查找开着 → 关查找框并消费事件（返回 true）；没开 → 返回 false 交还容器剥层。
 * FindBar 根上 keydown.stop 已消费输入框聚焦态（stopPropagation 不冒泡到 window），
 * 此处兜非聚焦态：焦点在表面其它位置时 Esc 不得穿透成「关容器」——查找框是表面上的
 * 临时覆盖层，先于容器关闭。
 */
function closeFindIfOpen(e: KeyboardEvent): boolean {
  const find = useFindInSurface()
  if (!find.isOpen.value) return false
  find.close()
  e.preventDefault()
  return true
}

/** Esc 分支：模态共存守卫 → 查找框优先 → 层级序剥层。 */
function handleEscapeKeydown(e: KeyboardEvent): void {
  if (modalSurfaceBlocksEvent(e)) return
  if (closeFindIfOpen(e)) return
  if (closeTopContainer()) e.preventDefault()
}

/**
 * Tab 浮层分支：浮层开着时首末循环（§7.3 随迁保位，W2 随 OverlayShell 归位；面板 ref 经
 * overlay 宿主注入）。Tab 属主 = 最上层表面（2026-10-03 用户裁决；登记
 * docs/todo/display-containers-overlay-tab-ownership.md）：模态/弹层叠在浮层上 → Tab 归
 * 该模态焦点域，陷阱不把焦点拉回浮层面板（双检即 modalSurfaceBlocksEvent，与 Esc 同源）。
 */
function handleOverlayTabKeydown(e: KeyboardEvent): void {
  if (!getOverlayControlState().isOpen) return
  if (modalSurfaceBlocksEvent(e)) return
  trapTabIntoOverlayPanel(e)
}

/**
 * Ctrl/Cmd+F 分支：表面内查找（find-in-surface）。归属判定在 useFindInSurface.openFindAtPointer
 * （鼠标悬停优先 → 回退栈序 → 全无不动作）。mod 判定与 useGlobalShortcuts 同款
 * （metaKey||ctrlKey 双平台同触，无需平台分支）；禁 capture——同 Esc 的 xterm 红线。
 */
function handleFindShortcutKeydown(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey)) return
  if (e.defaultPrevented) return
  e.preventDefault()
  useFindInSurface().openFindAtPointer()
}

/**
 * window keydown（bubble 相位）——按键分发到 Esc / Tab 浮层 / Ctrl+F 三个分支。
 * isComposing 守卫统一前置（§6.7：IME 组合态三键一律不动作；组合态 Esc 是「取消候选」
 * 的输入键，Tab 同守卫防组合态误改焦点）。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    handleEscapeKeydown(e)
    return
  }
  if (e.key === 'Tab') {
    handleOverlayTabKeydown(e)
    return
  }
  if (e.key === 'f') handleFindShortcutKeydown(e)
}

/**
 * ⌘W（'shortcut' type='close'）：让位守卫 → 层级序逐层关 → 全关后关窗。
 * yields⌘W 成员开着 → 无动作（窗口不关、容器不动、模态不动——防带着未提交表单关整窗；
 * 弹出层族 yieldsCmdW=false 不让位，⌘W 不是死键）。
 */
export function handleCmdWShortcut(): void {
  if (isImeComposing()) return
  if (anyModalSurfaceYieldsCmdW()) return
  if (!closeTopContainer()) {
    // 全关后关窗（before-input-event 已 preventDefault 默认菜单关窗，需显式触发）
    void windowClose()
  }
}

/**
 * ⌃`（'shortcut' type='toggle-bottom-drawer'）：底抽屉开关。
 * 浮层开着照常切换（被遮罩盖住但状态变化——§5.1 规则 3，不引入「按键时灵时不灵」）。
 */
export function handleToggleBottomDrawerShortcut(): void {
  if (isImeComposing()) return
  const wasOpen = getBottomDrawerControlState().isOpen
  toggleBottomDrawer()
  if (wasOpen) focusComposer()
}

// ── 生命周期（模块级 listener refCount 保护——规则 2，多实例/HMR 不重复注册）─────────

let listenerRefCount = 0
let stopCompositionTracking: (() => void) | null = null

/**
 * 启动键盘栈序编排器：window keydown 监听 + IME 组合态跟踪。
 * **必须在 AppShell 根 setup 首位调用**（§6.7 顺序前提：FIFO 同相位下编排器先执行让位
 * 判定、reka DismissableLayer 后行 dismiss）。onScopeDispose 自动卸载。
 */
export function useKeyOrchestrator(): void {
  if (listenerRefCount === 0) {
    window.addEventListener('keydown', onWindowKeydown)
    stopCompositionTracking = startImeCompositionTracking()
  }
  listenerRefCount += 1
  onScopeDispose(() => {
    listenerRefCount -= 1
    if (listenerRefCount > 0) return
    window.removeEventListener('keydown', onWindowKeydown)
    stopCompositionTracking?.()
    stopCompositionTracking = null
  })
}

/** 仅测试用：复位 listener refCount（用例间隔离）。生产代码禁止调用。 */
export function _resetKeyOrchestratorForTest(): void {
  listenerRefCount = 0
  window.removeEventListener('keydown', onWindowKeydown)
  stopCompositionTracking?.()
  stopCompositionTracking = null
}
