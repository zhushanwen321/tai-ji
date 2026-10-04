/**
 * IME 组合态守卫（display-containers §6.7「isComposing 守卫统一前置——IME 组合态三键
 * 一律不动作」）。
 *
 * 两条键路的守卫信号来源不同：
 * - **keydown 键路**（Esc / Tab 焦点陷阱）：`KeyboardEvent.isComposing` 是事件自带的权威
 *   信号，编排器 keydown 首行直接读事件（不用本模块）；
 * - **IPC 键路**（⌃` / ⌘W 经主进程 before-input-event → 'shortcut' 转发）：到达 renderer 时
 *   不再携带 KeyboardEvent，无 isComposing 可读——本模块以 compositionstart/compositionend
 *   事件序维护组合态布尔（事件顺序单一事实源，非时间平抑）供该键路读取。
 *
 * 守卫语义：组合态（中文候选未上屏等）按容器键不动作——Esc 在组合态是「取消候选」的输入键
 * （防误关最外层容器），⌃`/⌘W 同口径防组合态误触容器动作。
 */
let composing = false

/** 当前是否处于 IME 组合态（IPC 键路的守卫读点；keydown 键路用 e.isComposing） */
export function isImeComposing(): boolean {
  return composing
}

/**
 * 启动组合态跟踪（window compositionstart/compositionend；幂等由调用方 refCount 保证）。
 * 返回卸载函数（复位组合态，防跨实例残留）。
 */
export function startImeCompositionTracking(): () => void {
  const onStart = (): void => {
    composing = true
  }
  const onEnd = (): void => {
    composing = false
  }
  window.addEventListener('compositionstart', onStart)
  window.addEventListener('compositionend', onEnd)
  return () => {
    window.removeEventListener('compositionstart', onStart)
    window.removeEventListener('compositionend', onEnd)
    composing = false
  }
}
